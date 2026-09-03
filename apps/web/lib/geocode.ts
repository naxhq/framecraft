/**
 * Nominatim REVERSE geocoding: a pin position -> a place name.
 *
 * Since [V3-P9] this is the only thing Nominatim is asked for. The forward
 * type-ahead moved to Photon (`lib/photon.ts`), which is built for prefix
 * queries; Nominatim's usage policy asks clients not to use it that way, and
 * one deliberate lookup after the pin lands is what it is actually for. Both
 * providers read OpenStreetMap, so `CLAUDE.md`'s "OSM only" hard rule holds
 * for both, and both are attributed in the search popover and the app footer.
 *
 * Every path here fails SOFT: a network error, a non-2xx response, a malformed
 * body or a 5 second timeout all resolve to `null`, never a thrown error, so a
 * flaky or offline geocode can only ever leave the Place name field unfilled
 * -- it can never break the editor (DECISIONS [V3-P1]).
 *
 * Pieces, in order:
 *  1. `fetchReverseGeocode` -- one HTTP request, fail-soft.
 *  2. `readCache` / `writeCache` -- a 30 day localStorage store keyed on the
 *     rounded coordinates.
 *  3. `scheduleReverseGeocode` -- a 600 ms "the pin stopped moving" debounce
 *     in front of a module-level queue (`enqueueGeocodeRequest`) that never
 *     lets two REQUESTS (a cache hit skips the queue entirely) start under a
 *     second apart, per Nominatim's usage policy.
 *  4. `radiusForResultType` -- `[V3-P6]`'s frozen kind-to-radius table, read
 *     by `lib/photon.ts` so a Photon pick and a Nominatim answer size the crop
 *     by exactly the same rule.
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
// debounce + a 1 request/second queue in front of every Nominatim request
// ---------------------------------------------------------------------------

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let queueTail: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

/**
 * Enqueue one network request behind whatever else is already queued, never
 * starting it under `GEOCODE_MIN_INTERVAL_MS` after the previous one -- the
 * one place Nominatim's 1 rps budget is spent, so a pin dragged across the map
 * cannot outrun the policy however fast it settles. Photon's type-ahead does
 * NOT pass through here: it is a different server with a different policy, and
 * queueing a keystroke behind a reverse lookup would make the box feel broken.
 * `isCancelled` is read right before the request actually starts (not when it
 * was queued), so a caller that has moved on by the time its turn comes up
 * costs nothing but the wait.
 */
function enqueueGeocodeRequest(isCancelled: () => boolean, run: () => Promise<void>): void {
  queueTail = queueTail.then(async () => {
    if (isCancelled()) return;
    const wait = Math.max(0, GEOCODE_MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (isCancelled()) return;
    lastRequestAt = Date.now();
    await run();
  });
}

let suppressedPin: string | null = null;

/**
 * Tell the next reverse lookup for exactly these coordinates not to run
 * ([V3-P9-fix]).
 *
 * A pin dropped by picking a NAMED search result is already named, and by a
 * source that knew which building the user meant. The pin move still triggers
 * the shell's reverse lookup, which a moment later would replace "Willis
 * Tower" with "Chicago" and no user action would explain it. So the pick arms
 * this first, and the lookup it caused is skipped.
 *
 * One shot, and cleared by the NEXT scheduled lookup whatever its coordinates,
 * so a pin later dragged somewhere else is always resolved normally. Coordinate
 * entry and "use my location" deliberately do NOT arm it: those name nothing,
 * and the reverse lookup is the only thing that can name them.
 */
export function suppressNextReverseGeocode(lat: number, lon: number): void {
  suppressedPin = geocodeCacheKey(lat, lon);
}

/** Test-only view of the armed suppression. */
export function suppressedReverseGeocodePin(): string | null {
  return suppressedPin;
}

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

  // Read and disarm together: whoever schedules next owns the decision, so an
  // armed suppression can never outlive the one pin move it was armed for.
  const suppressed = suppressedPin;
  suppressedPin = null;
  if (suppressed !== null && suppressed === geocodeCacheKey(lat, lon)) {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    return () => {
      cancelled = true;
    };
  }

  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const cached = readCache(lat, lon);
    if (cached !== null) {
      if (!cancelled) onResult(cached, lat, lon);
      return;
    }
    enqueueGeocodeRequest(
      () => cancelled,
      async () => {
        const result = await resolveReverseGeocode(lat, lon, fetchImpl);
        if (!cancelled) onResult(result, lat, lon);
      },
    );
  }, debounceMs);

  return () => {
    cancelled = true;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };
}

// ---------------------------------------------------------------------------
// the radius a picked place implies ([V3-P6], read by lib/photon.ts)
// ---------------------------------------------------------------------------

/**
 * Just enough of a search result to size the crop around it: whatever the
 * provider calls the kind of place this is.
 *
 * `addresstype` is Nominatim's own field name and stays in the shape because
 * the table below is the one `[V3-P6]` froze; `lib/photon.ts` normalises
 * Photon's `osm_key`/`osm_value`/`type` triple into `type` and passes null for
 * the other, so ONE table decides the radius whoever answered the query.
 */
export interface PlaceTypeHint {
  type: string | null;
  addresstype: string | null;
}

/**
 * The radius a search result implies, by what kind of place it is (the
 * brief's own table): a city or town is 1500 m, a suburb or neighbourhood is
 * 900 m, a single building or amenity is 400 m, and anything else -- a road, a
 * natural feature, a result the geocoder did not classify -- defaults to 900 m,
 * the same as a neighbourhood: neither the widest nor the narrowest guess.
 */
export function radiusForResultType(result: PlaceTypeHint): number {
  const kind = (result.addresstype ?? result.type ?? "").toLowerCase();
  if (kind === "city" || kind === "town") return 1500;
  if (kind === "suburb" || kind === "neighbourhood" || kind === "quarter") return 900;
  if (kind === "building" || kind === "amenity" || kind === "house") return 400;
  return 900;
}

/** Test-only: drop any pending debounce/queue state between test files. */
export function resetGeocodeSchedulerForTests(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = null;
  queueTail = Promise.resolve();
  lastRequestAt = 0;
  suppressedPin = null;
}
