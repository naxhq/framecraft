/**
 * Nominatim reverse geocoding: a pin position -> a place name.
 *
 * OSM only, per `CLAUDE.md`'s hard rule (no Google/Apple/Bing sources) and the
 * same attribution regime the map tiles already carry. Every path here fails
 * SOFT: a network error, a non-2xx response, a malformed body or a 5 second
 * timeout all resolve to `null`, never a thrown error, so a flaky or offline
 * geocode can only ever leave the Place name field unfilled -- it can never
 * break the editor (DECISIONS [V3-P1]).
 *
 * Three pieces, in order:
 *  1. `fetchReverseGeocode` -- one HTTP request, fail-soft.
 *  2. `readCache` / `writeCache` -- a 30 day localStorage cache keyed by
 *     lat/lon rounded to 3 decimals (~111 m at the equator), so dragging the
 *     pin back onto a spot already resolved this session costs nothing.
 *  3. `scheduleReverseGeocode` -- a 600 ms debounce ("the pin stopped moving")
 *     in front of a module-level queue that never lets two REQUESTS (a cache
 *     hit skips the queue entirely) start under a second apart, per
 *     Nominatim's usage policy.
 */

export interface GeocodeResult {
  city: string | null;
  state: string | null;
  country: string | null;
  neighbourhood: string | null;
}

export const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";

/**
 * Identifies FrameCraft to Nominatim per its usage policy. Browsers routinely
 * refuse to let `fetch` override the User-Agent header (Chrome and Firefox
 * both silently drop it) -- the request still goes out under the page's own
 * Referer either way, so this is attempted but never relied on, and no
 * `email=` query parameter is appended (the policy's OTHER accepted way to
 * identify a client): the browser's own default `Accept-Language` is left
 * alone rather than paired with a personal address in a URL a proxy or a log
 * might keep.
 */
export const GEOCODE_USER_AGENT = "FrameCraft/3.0 (https://github.com/naxhq/framecraft)";

export const GEOCODE_DEBOUNCE_MS = 600;
export const GEOCODE_MIN_INTERVAL_MS = 1000;
export const GEOCODE_TIMEOUT_MS = 5000;
export const GEOCODE_CACHE_KEY = "framecraft.geocode.v1";
export const GEOCODE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** ~111 m at the equator: finer than any radius this model is a picture of. */
export const GEOCODE_KEY_DECIMALS = 3;

/** The cache key for a lat/lon pair, rounded to `GEOCODE_KEY_DECIMALS`. */
export function geocodeCacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(GEOCODE_KEY_DECIMALS)},${lon.toFixed(GEOCODE_KEY_DECIMALS)}`;
}

interface CacheEntry {
  result: GeocodeResult;
  storedAt: number;
}

type CacheStore = Record<string, CacheEntry>;

function readStore(): CacheStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(GEOCODE_CACHE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as CacheStore)
      : {};
  } catch {
    // Private mode, disabled storage, or a value that is not JSON.
    return {};
  }
}

function writeStore(store: CacheStore): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(store));
  } catch {
    // The in-memory result still reaches the caller for this session.
  }
}

/** A cached result for `(lat, lon)`, or null when there is none or it is stale. */
export function readCache(
  lat: number,
  lon: number,
  now: number = Date.now(),
): GeocodeResult | null {
  const entry = readStore()[geocodeCacheKey(lat, lon)];
  if (!entry) return null;
  if (now - entry.storedAt > GEOCODE_CACHE_TTL_MS) return null;
  return entry.result;
}

/** Cache a result for `(lat, lon)`, evicting nothing: a 30 day TTL is enough. */
export function writeCache(
  lat: number,
  lon: number,
  result: GeocodeResult,
  now: number = Date.now(),
): void {
  const store = readStore();
  store[geocodeCacheKey(lat, lon)] = { result, storedAt: now };
  writeStore(store);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Nominatim's `address` object -> the four fields FrameCraft's tokens need.
 *
 * `city` falls back through town/village/municipality/county (a small town
 * has no `city` tag at all); `neighbourhood` falls back through
 * suburb/quarter, per the brief's exact fallback order.
 */
export function extractGeocodeResult(data: unknown): GeocodeResult {
  const record = data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const addressValue = record.address;
  const address =
    addressValue !== null && typeof addressValue === "object"
      ? (addressValue as Record<string, unknown>)
      : {};
  return {
    city:
      str(address.city) ??
      str(address.town) ??
      str(address.village) ??
      str(address.municipality) ??
      str(address.county),
    state: str(address.state),
    country: str(address.country),
    neighbourhood: str(address.neighbourhood) ?? str(address.suburb) ?? str(address.quarter),
  };
}

/**
 * One reverse-geocode request, fail-soft: any error, a non-2xx response, an
 * unparsable body or exceeding `GEOCODE_TIMEOUT_MS` all resolve to `null`.
 *
 * `fetchImpl` is a parameter (not the bare global) so tests never touch the
 * network -- they pass a mock and assert against it.
 */
export async function fetchReverseGeocode(
  lat: number,
  lon: number,
  fetchImpl: typeof fetch = fetch,
): Promise<GeocodeResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const url =
      `${NOMINATIM_REVERSE_URL}?format=jsonv2&lat=${encodeURIComponent(String(lat))}` +
      `&lon=${encodeURIComponent(String(lon))}&zoom=14`;
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { "User-Agent": GEOCODE_USER_AGENT },
    });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    return extractGeocodeResult(data);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Cache-then-network: a fresh cache hit never touches `fetchImpl`. */
export async function resolveReverseGeocode(
  lat: number,
  lon: number,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<GeocodeResult | null> {
  const cached = readCache(lat, lon, now);
  if (cached !== null) return cached;
  const result = await fetchReverseGeocode(lat, lon, fetchImpl);
  if (result !== null) writeCache(lat, lon, result, now);
  return result;
}

// ---------------------------------------------------------------------------
// debounce + a 1 request/second queue
// ---------------------------------------------------------------------------

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let queueTail: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

/**
 * Debounce 600 ms after the pin stops moving, then resolve `(lat, lon)`.
 *
 * A cache hit answers immediately once the debounce elapses, without
 * consuming the request queue's budget. An actual network request always
 * waits its turn behind whatever else is queued, so two requests never start
 * under `GEOCODE_MIN_INTERVAL_MS` apart, per Nominatim's usage policy.
 *
 * Calling this again (a pin still moving) supersedes whatever debounce was
 * pending; the SceneRequest/coordinates a result belongs to are handed back
 * to `onResult` so a caller can discard a result for a pin that has since
 * moved on to somewhere else. Returns a canceller for unmount.
 */
export function scheduleReverseGeocode(
  lat: number,
  lon: number,
  onResult: (result: GeocodeResult | null, lat: number, lon: number) => void,
  options: { debounceMs?: number; fetchImpl?: typeof fetch } = {},
): () => void {
  const debounceMs = options.debounceMs ?? GEOCODE_DEBOUNCE_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  let cancelled = false;

  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const cached = readCache(lat, lon);
    if (cached !== null) {
      if (!cancelled) onResult(cached, lat, lon);
      return;
    }
    queueTail = queueTail.then(async () => {
      if (cancelled) return;
      const wait = Math.max(0, GEOCODE_MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (cancelled) return;
      lastRequestAt = Date.now();
      const result = await resolveReverseGeocode(lat, lon, fetchImpl);
      if (!cancelled) onResult(result, lat, lon);
    });
  }, debounceMs);

  return () => {
    cancelled = true;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };
}

/** Test-only: drop any pending debounce/queue state between test files. */
export function resetGeocodeSchedulerForTests(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = null;
  queueTail = Promise.resolve();
  lastRequestAt = 0;
}
