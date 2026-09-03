/**
 * Photon (komoot) type-ahead search: a partial query -> a short list of places,
 * fast enough to run on every keystroke ([V3-P9]).
 *
 * Photon is an OSM-only geocoder built for exactly this: it indexes
 * OpenStreetMap and answers prefix queries, which Nominatim explicitly asks
 * clients NOT to use it for. So the split is by job, not by preference:
 *
 *   - Photon answers the type-ahead, at up to one request per 250 ms debounce.
 *   - Nominatim (`lib/geocode.ts`) keeps the ONE reverse lookup that names the
 *     place after a pin lands, through its own shared 1 request/second queue.
 *
 * Both are attributed in the search popover and the app footer, and both read
 * OpenStreetMap data, so `CLAUDE.md`'s "OSM only" hard rule holds either way.
 *
 * Politeness, since this is somebody else's public endpoint:
 *
 *  - Nothing is sent under `PHOTON_MIN_QUERY_CHARS` characters.
 *  - Nothing is sent while a debounce is still running.
 *  - Nothing is sent for a query already in the LRU cache (50 entries, 10
 *     minutes), and the cache answers synchronously so a backspace costs
 *     nothing at all.
 *  - Every superseded request is ABORTED, not merely ignored: a fast typist
 *     should cost the server one answered request, not eight abandoned ones.
 *  - A 429 stops all traffic for at least `PHOTON_RATE_LIMIT_COOLDOWN_MS`
 *     (longer when `Retry-After` asks for longer), with no retry inside it.
 *  - A 5xx is retried exactly once, after `PHOTON_RETRY_DELAY_MS`.
 *
 * A `User-Agent` is deliberately NOT forged here. Browsers refuse to let
 * `fetch` set it (`lib/geocode.ts` documents the same finding), and sending a
 * fake one through some other header would identify this client dishonestly.
 * The request carries the page's own `Referer`, which is what a browser client
 * can actually offer.
 */

import { radiusForResultType } from "./geocode";

export const PHOTON_SEARCH_URL = "https://photon.komoot.io/api/";
export const PHOTON_LIMIT = 8;
export const PHOTON_LANG = "en";
export const PHOTON_MIN_QUERY_CHARS = 3;
export const PHOTON_DEBOUNCE_MS = 250;
export const PHOTON_TIMEOUT_MS = 5000;
export const PHOTON_RETRY_DELAY_MS = 2000;
export const PHOTON_RATE_LIMIT_COOLDOWN_MS = 30_000;
export const PHOTON_CACHE_CAP = 50;
export const PHOTON_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * What kind of place a result is, normalised out of Photon's own
 * `osm_key`/`osm_value`/`type` triple so the radius table and the row's type
 * hint both read one field.
 *
 * The names are chosen to feed `radiusForResultType` unchanged: it is the
 * table `[V3-P6]` froze (city/town 1500 m, suburb/neighbourhood/quarter 900 m,
 * building/amenity/house 400 m, everything else 900 m), and "everything else"
 * is what `road`, `locality`, `region` and `place` deliberately land on.
 */
export type PlaceKind =
  | "city"
  | "town"
  | "suburb"
  | "neighbourhood"
  | "building"
  | "house"
  | "amenity"
  | "road"
  | "locality"
  | "region"
  | "place";

/** The short badge shown on a result row, one per kind. */
export const PLACE_KIND_LABEL: Record<PlaceKind, string> = {
  city: "City",
  town: "Town",
  suburb: "Suburb",
  neighbourhood: "Neighbourhood",
  building: "Building",
  house: "Building",
  amenity: "Place",
  road: "Road",
  locality: "Locality",
  region: "Region",
  place: "Place",
};

export interface PhotonPlace {
  /** Stable within one result list: OSM type + id, or the coordinates when Photon sent neither. */
  id: string;
  /** The primary line: the name, or a house number and street when there is no name. */
  name: string;
  /** The secondary line: street, city, region, country, as far as Photon supplied them. */
  context: string;
  lat: number;
  lon: number;
  kind: PlaceKind;
  /**
   * The administrative fields the store's `params.place` tokens read, carried
   * so a pick can fill them from the SAME answer that named the result rather
   * than blanking them and waiting on a reverse lookup that may never arrive.
   */
  state: string | null;
  country: string | null;
  neighbourhood: string | null;
}

/** Where the pin currently sits, so Photon ranks nearby answers first. */
export interface SearchBias {
  lat: number;
  lon: number;
}

export type PhotonOutcome =
  | { status: "ok"; places: PhotonPlace[] }
  | { status: "rate-limited"; retryAfterMs: number }
  | { status: "unavailable" }
  | { status: "aborted" };

// ---------------------------------------------------------------------------
// request URL
// ---------------------------------------------------------------------------

/**
 * Photon biases by proximity when given `lat`/`lon`, which is what makes
 * "main st" mean the one three blocks away rather than the one in another
 * country. The bias is rounded to `BIAS_DECIMALS` before it reaches the URL
 * AND before it reaches the cache key, so nudging the pin by a metre does not
 * silently invalidate every cached query.
 */
const BIAS_DECIMALS = 1;

function biasKey(bias: SearchBias | null | undefined): string {
  if (!bias || !Number.isFinite(bias.lat) || !Number.isFinite(bias.lon)) return "none";
  return `${bias.lat.toFixed(BIAS_DECIMALS)},${bias.lon.toFixed(BIAS_DECIMALS)}`;
}

export function photonSearchUrl(query: string, bias?: SearchBias | null): string {
  const parameters = new URLSearchParams({
    q: query,
    limit: String(PHOTON_LIMIT),
    lang: PHOTON_LANG,
  });
  if (bias && Number.isFinite(bias.lat) && Number.isFinite(bias.lon)) {
    parameters.set("lat", bias.lat.toFixed(BIAS_DECIMALS));
    parameters.set("lon", bias.lon.toFixed(BIAS_DECIMALS));
  }
  return `${PHOTON_SEARCH_URL}?${parameters.toString()}`;
}

// ---------------------------------------------------------------------------
// response -> PhotonPlace[]
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function num(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Photon's `osm_key`/`osm_value`/`type` -> one `PlaceKind`.
 *
 * `osm_key`/`osm_value` are the raw OSM tag and are checked first because they
 * are the specific answer ("highway=residential" is a road however Photon
 * classified the feature); `type` is Photon's own coarse bucket and fills in
 * when the tag says nothing useful.
 */
export function photonPlaceKind(properties: Record<string, unknown>): PlaceKind {
  const key = (str(properties.osm_key) ?? "").toLowerCase();
  const value = (str(properties.osm_value) ?? "").toLowerCase();
  const type = (str(properties.type) ?? "").toLowerCase();

  if (key === "highway") return "road";
  if (key === "building") return "building";
  if (key === "amenity" || key === "shop" || key === "tourism" || key === "leisure") {
    return "amenity";
  }
  if (key === "place") {
    if (value === "city") return "city";
    if (value === "town") return "town";
    if (value === "borough" || value === "suburb") return "suburb";
    if (value === "neighbourhood" || value === "quarter") return "neighbourhood";
    if (value === "house" || value === "houses") return "house";
    if (value === "village" || value === "hamlet" || value === "locality") return "locality";
    if (value === "county" || value === "state" || value === "region" || value === "country") {
      return "region";
    }
  }
  if (key === "boundary" || key === "landuse") {
    if (value === "administrative") return "region";
  }

  if (type === "street") return "road";
  if (type === "house") return "house";
  if (type === "city") return "city";
  if (type === "district") return "suburb";
  if (type === "locality") return "locality";
  if (type === "county" || type === "state" || type === "country") return "region";

  return "place";
}

/**
 * The primary line. Photon labels most features with `name`, but a
 * house-number result has no name at all -- its identity is the number and the
 * street, so that is what gets shown rather than an empty row.
 */
function primaryName(properties: Record<string, unknown>): string | null {
  const name = str(properties.name);
  if (name !== null) return name;
  const street = str(properties.street);
  const housenumber = str(properties.housenumber);
  if (street !== null) return housenumber !== null ? `${housenumber} ${street}` : street;
  return str(properties.city) ?? str(properties.state) ?? str(properties.country);
}

/**
 * The secondary line: the administrative trail from smallest to largest, with
 * anything already visible in the primary line dropped so a row never reads
 * "Chicago / Chicago, Illinois, United States".
 */
function contextLine(properties: Record<string, unknown>, name: string): string {
  const parts = [
    str(properties.street),
    str(properties.district),
    str(properties.city),
    str(properties.county),
    str(properties.state),
    str(properties.country),
  ];
  const seen = new Set<string>([name.toLowerCase()]);
  const kept: string[] = [];
  for (const part of parts) {
    if (part === null) continue;
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(part);
  }
  return kept.join(", ");
}

function featureId(properties: Record<string, unknown>, lat: number, lon: number): string {
  const osmType = str(properties.osm_type);
  const osmId = num(properties.osm_id);
  if (osmType !== null && osmId !== null) return `${osmType}${osmId}`;
  return `${lat},${lon}`;
}

/**
 * Photon's GeoJSON FeatureCollection -> the rows the dropdown needs.
 *
 * Fails soft on every axis: a body that is not a FeatureCollection reads as an
 * empty list, and a single feature missing a name or a coordinate is dropped
 * rather than shown as a blank row that moves the pin to NaN. Note the
 * coordinate order: GeoJSON is [lon, lat], the opposite of everything else in
 * this codebase.
 */
export function extractPhotonPlaces(data: unknown): PhotonPlace[] {
  if (data === null || typeof data !== "object") return [];
  const features = (data as Record<string, unknown>).features;
  if (!Array.isArray(features)) return [];

  const out: PhotonPlace[] = [];
  const seen = new Set<string>();

  for (const raw of features) {
    if (raw === null || typeof raw !== "object") continue;
    const feature = raw as Record<string, unknown>;

    const geometry = feature.geometry;
    if (geometry === null || typeof geometry !== "object") continue;
    const coordinates = (geometry as Record<string, unknown>).coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    const lon = num(coordinates[0]);
    const lat = num(coordinates[1]);
    if (lat === null || lon === null) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;

    const propertiesValue = feature.properties;
    const properties =
      propertiesValue !== null && typeof propertiesValue === "object"
        ? (propertiesValue as Record<string, unknown>)
        : {};

    const name = primaryName(properties);
    if (name === null) continue;

    const id = featureId(properties, lat, lon);
    if (seen.has(id)) continue;
    seen.add(id);

    out.push({
      id,
      name,
      context: contextLine(properties, name),
      lat,
      lon,
      kind: photonPlaceKind(properties),
      state: str(properties.state),
      country: str(properties.country),
      // Photon calls a sub-city area a `district`; Nominatim calls the same
      // thing a neighbourhood, which is the name the store's field carries.
      neighbourhood: str(properties.district),
    });
  }

  return out;
}

/** The radius a picked place implies, through `[V3-P6]`'s frozen table. */
export function radiusForPlace(place: Pick<PhotonPlace, "kind">): number {
  return radiusForResultType({ type: place.kind, addresstype: null });
}

// ---------------------------------------------------------------------------
// LRU cache: 50 queries, 10 minutes
// ---------------------------------------------------------------------------

interface CacheEntry {
  places: PhotonPlace[];
  storedAt: number;
}

/**
 * In memory, not localStorage: a 10 minute time to live is shorter than most
 * sessions, so persisting it would only ever serve entries this tab already
 * has. `Map` preserves insertion order, which is the whole LRU implementation:
 * a read re-inserts, and an overflowing write evicts `keys().next()`.
 */
const cache = new Map<string, CacheEntry>();

export function normalisePhotonQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function cacheKey(query: string, bias: SearchBias | null | undefined): string {
  return `${normalisePhotonQuery(query)}@${biasKey(bias)}`;
}

export function readPhotonCache(
  query: string,
  bias?: SearchBias | null,
  now: number = Date.now(),
): PhotonPlace[] | null {
  const key = cacheKey(query, bias);
  const entry = cache.get(key);
  if (entry === undefined) return null;
  if (now - entry.storedAt > PHOTON_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.places;
}

export function writePhotonCache(
  query: string,
  places: PhotonPlace[],
  bias?: SearchBias | null,
  now: number = Date.now(),
): void {
  const key = cacheKey(query, bias);
  cache.delete(key);
  cache.set(key, { places, storedAt: now });
  while (cache.size > PHOTON_CACHE_CAP) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}

/** How many entries the cache is holding; the LRU eviction test reads this. */
export function photonCacheSize(): number {
  return cache.size;
}

// ---------------------------------------------------------------------------
// one request, with the 429 and 5xx policy
// ---------------------------------------------------------------------------

let rateLimitedUntil = 0;

/** When the 429 cooldown expires, as an epoch millisecond value (0 when clear). */
export function photonRateLimitedUntil(): number {
  return rateLimitedUntil;
}

/**
 * `Retry-After` in milliseconds. The header is either a delay in seconds or an
 * HTTP date; both spellings are read, and anything else falls back to the
 * fixed cooldown rather than to zero, since a header we cannot parse is not
 * permission to retry immediately.
 */
export function retryAfterMs(header: string | null, now: number = Date.now()): number {
  if (header === null) return PHOTON_RATE_LIMIT_COOLDOWN_MS;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return PHOTON_RATE_LIMIT_COOLDOWN_MS;
}

type Attempt =
  | { kind: "ok"; data: unknown }
  | { kind: "rate-limited"; retryAfterMs: number }
  | { kind: "server-error" }
  | { kind: "failed" }
  | { kind: "aborted" };

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  // Already superseded: there is nothing to wait for, so do not spend the
  // retry delay before the caller can find that out.
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });
}

async function attempt(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  now: () => number,
): Promise<Attempt> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, PHOTON_TIMEOUT_MS);
  const onExternalAbort = (): void => controller.abort();
  signal?.addEventListener("abort", onExternalAbort);

  try {
    if (signal?.aborted === true) return { kind: "aborted" };
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (response.status === 429) {
      return {
        kind: "rate-limited",
        retryAfterMs: retryAfterMs(response.headers?.get?.("Retry-After") ?? null, now()),
      };
    }
    if (response.status >= 500) return { kind: "server-error" };
    if (!response.ok) return { kind: "failed" };
    const data: unknown = await response.json();
    return { kind: "ok", data };
  } catch {
    // A timeout is a failure the user must be told about; a supersede is not.
    if (timedOut) return { kind: "failed" };
    if (signal?.aborted === true) return { kind: "aborted" };
    return { kind: "failed" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

export interface PhotonRequestOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  bias?: SearchBias | null;
  now?: () => number;
}

/**
 * One Photon lookup, including the retry and cooldown policy. Never throws.
 *
 * The cooldown is checked BEFORE the request, so a 429 stops the next request
 * from being made at all rather than being discovered again a keystroke later.
 * A 5xx gets exactly one retry after `PHOTON_RETRY_DELAY_MS`; a 429 gets none
 * inside the cooldown, which is at least `PHOTON_RATE_LIMIT_COOLDOWN_MS` and
 * longer when `Retry-After` asks for longer.
 */
export async function fetchPhotonSearch(
  query: string,
  options: PhotonRequestOptions = {},
): Promise<PhotonOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const trimmed = query.trim();
  if (trimmed.length < PHOTON_MIN_QUERY_CHARS) return { status: "ok", places: [] };

  const at = now();
  if (at < rateLimitedUntil) {
    return { status: "rate-limited", retryAfterMs: rateLimitedUntil - at };
  }

  const url = photonSearchUrl(trimmed, options.bias);
  let result = await attempt(url, fetchImpl, options.signal, now);

  if (result.kind === "server-error") {
    await delay(PHOTON_RETRY_DELAY_MS, options.signal);
    if (options.signal?.aborted === true) return { status: "aborted" };
    result = await attempt(url, fetchImpl, options.signal, now);
  }

  if (result.kind === "rate-limited") {
    rateLimitedUntil = now() + Math.max(PHOTON_RATE_LIMIT_COOLDOWN_MS, result.retryAfterMs);
    return { status: "rate-limited", retryAfterMs: rateLimitedUntil - now() };
  }
  if (result.kind === "aborted") return { status: "aborted" };
  if (result.kind === "ok") return { status: "ok", places: extractPhotonPlaces(result.data) };
  return { status: "unavailable" };
}

// ---------------------------------------------------------------------------
// debounce + abort-the-previous scheduler
// ---------------------------------------------------------------------------

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: AbortController | null = null;

export interface PhotonScheduleOptions extends PhotonRequestOptions {
  debounceMs?: number;
}

/**
 * Debounce `PHOTON_DEBOUNCE_MS` after the last keystroke, then search.
 *
 * Calling this again supersedes the previous call completely: the pending
 * debounce is cleared AND any request already in flight is aborted, which is
 * the difference between "the answer is ignored" and "the bytes are never
 * sent". A query under `PHOTON_MIN_QUERY_CHARS` characters schedules nothing
 * and calls nothing back -- the box shows its own hint instead. A cache hit
 * answers SYNCHRONOUSLY, before the debounce, since there is nothing to wait
 * for.
 *
 * `onOutcome` never receives `aborted`: a superseded request has no news.
 * Returns a canceller for unmount.
 */
export function schedulePhotonSearch(
  query: string,
  onOutcome: (outcome: PhotonOutcome, forQuery: string) => void,
  options: PhotonScheduleOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? PHOTON_DEBOUNCE_MS;
  const now = options.now ?? Date.now;
  let cancelled = false;

  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (inFlight !== null) {
    inFlight.abort();
    inFlight = null;
  }

  const trimmed = query.trim();
  if (trimmed.length < PHOTON_MIN_QUERY_CHARS) {
    return () => {
      cancelled = true;
    };
  }

  const cached = readPhotonCache(trimmed, options.bias, now());
  if (cached !== null) {
    onOutcome({ status: "ok", places: cached }, query);
    return () => {
      cancelled = true;
    };
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const controller = new AbortController();
    inFlight = controller;
    void fetchPhotonSearch(trimmed, { ...options, signal: controller.signal }).then((outcome) => {
      if (inFlight === controller) inFlight = null;
      if (cancelled || outcome.status === "aborted") return;
      if (outcome.status === "ok") writePhotonCache(trimmed, outcome.places, options.bias, now());
      onOutcome(outcome, query);
    });
  }, debounceMs);

  return () => {
    cancelled = true;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (inFlight !== null) {
      inFlight.abort();
      inFlight = null;
    }
  };
}

/** Test-only: drop the cache, the cooldown and any pending debounce or request. */
export function resetPhotonForTests(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = null;
  if (inFlight !== null) inFlight.abort();
  inFlight = null;
  cache.clear();
  rateLimitedUntil = 0;
}
