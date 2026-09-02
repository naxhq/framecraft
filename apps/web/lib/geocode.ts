/**
 * Nominatim geocoding: a pin position -> a place name (reverse), and a typed
 * query -> a short list of places (forward, [V3-P6]).
 *
 * OSM only, per `CLAUDE.md`'s hard rule (no Google/Apple/Bing sources) and the
 * same attribution regime the map tiles already carry. Every path here fails
 * SOFT: a network error, a non-2xx response, a malformed body or a 5 second
 * timeout all resolve to `null`, never a thrown error, so a flaky or offline
 * geocode can only ever leave the Place name field (or the search dropdown)
 * unfilled -- it can never break the editor (DECISIONS [V3-P1]).
 *
 * Pieces, in order:
 *  1. `fetchReverseGeocode` / `fetchForwardGeocode` -- one HTTP request each,
 *     fail-soft.
 *  2. `readCache` / `writeCache` (30 days) and `readSearchCache` /
 *     `writeSearchCache` (7 days, [V3-P6]) -- separate localStorage stores,
 *     since a place-name lookup and a free-text search answer different
 *     questions and go stale on different schedules.
 *  3. `scheduleReverseGeocode` / `scheduleForwardGeocode` -- their own
 *     debounces ("the pin stopped moving" at 600 ms, "the user stopped
 *     typing" at 400 ms) in front of ONE SHARED module-level queue
 *     (`enqueueGeocodeRequest`) that never lets two REQUESTS (a cache hit
 *     skips the queue entirely) start under a second apart across BOTH kinds
 *     of lookup, per Nominatim's usage policy -- a search box and a dragged
 *     pin firing at once still shares one 1 rps budget, not one each.
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
// debounce + a 1 request/second queue, SHARED across reverse and forward
// ---------------------------------------------------------------------------

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let queueTail: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

/**
 * Enqueue one network request behind whatever else is already queued, never
 * starting it under `GEOCODE_MIN_INTERVAL_MS` after the previous one -- the
 * one place both `scheduleReverseGeocode` and `scheduleForwardGeocode` touch
 * the shared 1 rps budget, so the two kinds of lookup can never together
 * exceed it. `isCancelled` is read right before the request actually starts
 * (not when it was queued), so a caller that has moved on by the time its
 * turn comes up costs nothing but the wait.
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
// forward geocoding: a typed query -> a short list of places ([V3-P6])
// ---------------------------------------------------------------------------

export const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
export const GEOCODE_SEARCH_DEBOUNCE_MS = 400;
export const GEOCODE_SEARCH_LIMIT = 6;
export const GEOCODE_SEARCH_CACHE_KEY = "framecraft.geocode.search.v1";
export const GEOCODE_SEARCH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SearchResult {
  label: string;
  lat: number;
  lon: number;
  /** Nominatim's `type`, e.g. "city", "suburb", "building". */
  type: string | null;
  /** Nominatim's `addresstype`, preferred over `type` when present. */
  addresstype: string | null;
}

/**
 * The radius a search result implies, by what kind of place it is (the
 * brief's own table): a city or town is 1500 m, a suburb or neighbourhood is
 * 900 m, a single building or amenity is 400 m, and anything else -- a road, a
 * natural feature, a result Nominatim did not classify -- defaults to 900 m,
 * the same as a neighbourhood: neither the widest nor the narrowest guess.
 */
export function radiusForResultType(result: Pick<SearchResult, "type" | "addresstype">): number {
  const kind = (result.addresstype ?? result.type ?? "").toLowerCase();
  if (kind === "city" || kind === "town") return 1500;
  if (kind === "suburb" || kind === "neighbourhood" || kind === "quarter") return 900;
  if (kind === "building" || kind === "amenity" || kind === "house") return 400;
  return 900;
}

function normaliseQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * A search result's `label` (Nominatim's `display_name`) is a full address --
 * "Chicago, Cook County, Illinois, United States". The Place name field (and
 * every `{city}` token it feeds) wants the short leading part.
 */
export function placeNameFromLabel(label: string): string {
  const first = label.split(",")[0]?.trim();
  return first && first.length > 0 ? first : label;
}

interface SearchCacheEntry {
  results: SearchResult[];
  storedAt: number;
}

type SearchCacheStore = Record<string, SearchCacheEntry>;

function readSearchStore(): SearchCacheStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(GEOCODE_SEARCH_CACHE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as SearchCacheStore)
      : {};
  } catch {
    return {};
  }
}

function writeSearchStore(store: SearchCacheStore): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(GEOCODE_SEARCH_CACHE_KEY, JSON.stringify(store));
  } catch {
    // The in-memory result still reaches the caller for this session.
  }
}

/** A cached result list for a normalised query, or null when there is none or it is stale. */
export function readSearchCache(
  query: string,
  now: number = Date.now(),
): SearchResult[] | null {
  const entry = readSearchStore()[normaliseQuery(query)];
  if (!entry) return null;
  if (now - entry.storedAt > GEOCODE_SEARCH_CACHE_TTL_MS) return null;
  return entry.results;
}

/** Cache a result list for a normalised query. An empty ("no results") list caches too. */
export function writeSearchCache(
  query: string,
  results: SearchResult[],
  now: number = Date.now(),
): void {
  const store = readSearchStore();
  store[normaliseQuery(query)] = { results, storedAt: now };
  writeSearchStore(store);
}

function num(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Nominatim's search array -> the fields FrameCraft's dropdown needs. */
export function extractSearchResults(data: unknown): SearchResult[] {
  if (!Array.isArray(data)) return [];
  const out: SearchResult[] = [];
  for (const raw of data) {
    if (raw === null || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const label = str(record.display_name);
    const lat = num(record.lat);
    const lon = num(record.lon);
    if (label === null || lat === null || lon === null) continue;
    out.push({
      label,
      lat,
      lon,
      type: str(record.type),
      addresstype: str(record.addresstype),
    });
  }
  return out;
}

/**
 * One forward-geocode request, fail-soft: any error, a non-2xx response, an
 * unparsable body or exceeding `GEOCODE_TIMEOUT_MS` all resolve to `null` --
 * told apart from "no results" (`[]`), so the search dropdown can say which
 * happened.
 */
export async function fetchForwardGeocode(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchResult[] | null> {
  const trimmed = query.trim();
  if (trimmed === "") return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const url =
      `${NOMINATIM_SEARCH_URL}?format=jsonv2&q=${encodeURIComponent(trimmed)}` +
      `&limit=${GEOCODE_SEARCH_LIMIT}&addressdetails=0`;
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { "User-Agent": GEOCODE_USER_AGENT },
    });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    return extractSearchResults(data);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Cache-then-network, same discipline as `resolveReverseGeocode`. */
export async function resolveForwardGeocode(
  query: string,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<SearchResult[] | null> {
  const cached = readSearchCache(query, now);
  if (cached !== null) return cached;
  const results = await fetchForwardGeocode(query, fetchImpl);
  if (results !== null) writeSearchCache(query, results, now);
  return results;
}

let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounce 400 ms after the user stops typing, then search `query`.
 *
 * `onResult` gets `null` for a failed/rate-limited lookup (a "could not
 * search right now" row) and `[]` for a lookup that genuinely found nothing
 * (a "nothing found" row) -- the search box tells the two apart. An empty or
 * whitespace-only query answers `[]` immediately, without a debounce, a cache
 * lookup or a queue slot: there is nothing to search for. Returns a canceller
 * for unmount / the next keystroke.
 */
export function scheduleForwardGeocode(
  query: string,
  onResult: (results: SearchResult[] | null, query: string) => void,
  options: { debounceMs?: number; fetchImpl?: typeof fetch } = {},
): () => void {
  const debounceMs = options.debounceMs ?? GEOCODE_SEARCH_DEBOUNCE_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  let cancelled = false;

  if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer);

  if (query.trim() === "") {
    searchDebounceTimer = null;
    onResult([], query);
    return () => {
      cancelled = true;
    };
  }

  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    const cached = readSearchCache(query);
    if (cached !== null) {
      if (!cancelled) onResult(cached, query);
      return;
    }
    enqueueGeocodeRequest(
      () => cancelled,
      async () => {
        const results = await resolveForwardGeocode(query, fetchImpl);
        if (!cancelled) onResult(results, query);
      },
    );
  }, debounceMs);

  return () => {
    cancelled = true;
    if (searchDebounceTimer !== null) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
  };
}

/** Test-only: drop any pending debounce/queue state between test files. */
export function resetGeocodeSchedulerForTests(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = null;
  if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = null;
  queueTail = Promise.resolve();
  lastRequestAt = 0;
}
