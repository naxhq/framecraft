/**
 * Overpass client: query text, mirror failover, retry/backoff, and a
 * pluggable cache (IndexedDB in the browser/worker, in-memory for tests).
 * Mirrors `services/bake/app/ingest/overpass.py`'s query text and bbox math
 * exactly (`buildQuery` is pinned by sha1 against the Python builder's
 * output for the Chicago Loop preset -- see `overpass.test.ts`); the retry
 * policy is the brief's, not 03's (03 only specifies the query and a
 * two-endpoint mirror; the three-mirror list, 60 s per-attempt timeout and
 * 500 ms/1 s/2 s backoff are new for the browser engine, DECISIONS.md
 * [V3-P2-E1]).
 */
import { LocalFrame } from "./project";
import { sha1Hex } from "./sha1";

export const QUERY_TEMPLATE = `[out:json][timeout:180];
(
  way["building"]({bbox});
  relation["building"]({bbox});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|service|pedestrian|footway)$"]({bbox});
  way["natural"="water"]({bbox});
  relation["natural"="water"]({bbox});
  way["waterway"="riverbank"]({bbox});
  way["landuse"~"^(grass|forest|meadow|recreation_ground)$"]({bbox});
  way["leisure"~"^(park|garden|pitch)$"]({bbox});
  node["natural"="tree"]({bbox});
);
out geom;
`;

/** 03: "add 15% margin so the rotation crop is not starved". */
export const BBOX_MARGIN = 1.15;

export interface OverpassRequest {
  lat: number;
  lon: number;
  radius_m: number;
  rotation_deg: number;
}

/** Overpass bbox `[south, west, north, east]` covering the rotated crop plus its margin. Mirrors `overpass.py:bbox_for`. */
export function bboxFor(request: OverpassRequest): [number, number, number, number] {
  const frame = new LocalFrame(request.lat, request.lon, request.rotation_deg);
  const half = request.radius_m * BBOX_MARGIN;
  const steps = 16;
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = -half + (2 * half * i) / steps;
    ring.push([t, -half], [t, half], [-half, t], [half, t]);
  }
  const lonLat = frame.toWgs84(ring);
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const [lon, lat] of lonLat) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  const round7 = (v: number) => Math.round(v * 1e7) / 1e7;
  return [round7(south), round7(west), round7(north), round7(east)];
}

/** The exact 03 Overpass QL text for this request. Byte-identical to `overpass.py:build_query`. */
export function buildQuery(request: OverpassRequest): string {
  const [south, west, north, east] = bboxFor(request);
  const bbox = `${south.toFixed(7)},${west.toFixed(7)},${north.toFixed(7)},${east.toFixed(7)}`;
  return QUERY_TEMPLATE.replace("{bbox}", bbox).replaceAll("{bbox}", bbox);
}

export function querySha1(query: string): string {
  return sha1Hex(query);
}

// ---------------------------------------------------------------------------
// mirrors, cache, fetch
// ---------------------------------------------------------------------------

export const DEFAULT_MIRRORS: readonly string[] = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

export const USER_AGENT = "FrameCraft/0.1 (OSM-to-3D-print; browser engine)";
const ATTEMPT_TIMEOUT_MS = 60_000;
const BACKOFF_MS = [500, 1000, 2000];
const RETRY_STATUSES = new Set([429, 503, 504]);

/**
 * Statuses that are a verdict on the QUERY, not on the mirror.
 *
 * Every mirror runs the same Overpass API against the same schema, so a
 * malformed query (400) or one it will not process (422) comes back the same
 * from all three; retrying it or failing over only multiplies one rejection
 * into four. Everything else - a WAF's 403, a 500 or a 502 from an overloaded
 * mirror, a network error, a timeout - says something about THIS endpoint, so
 * the next attempt goes to the next mirror (v3-02 audit finding 6).
 */
const QUERY_FAULT_STATUSES = new Set([400, 422]);
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_DB_NAME = "framecraft.overpass.v1";
const CACHE_STORE = "responses";

export interface OverpassCache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

/** In-memory cache: the default for tests and any environment without IndexedDB. */
export class MemoryOverpassCache implements OverpassCache {
  private store = new Map<string, { value: unknown; expiresAt: number }>();
  async get(key: string): Promise<unknown | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/** IndexedDB-backed cache keyed by query sha1, 7 day TTL. Requires a global `indexedDB` (browser/worker only). */
export class IndexedDbOverpassCache implements OverpassCache {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(CACHE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(CACHE_STORE)) {
          request.result.createObjectStore(CACHE_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    return this.dbPromise;
  }

  async get(key: string): Promise<unknown | undefined> {
    try {
      const db = await this.openDb();
      return await new Promise<unknown | undefined>((resolve) => {
        const tx = db.transaction(CACHE_STORE, "readonly");
        const req = tx.objectStore(CACHE_STORE).get(key);
        req.onsuccess = () => {
          const entry = req.result as CacheEntry | undefined;
          if (!entry || Date.now() > entry.expiresAt) {
            resolve(undefined);
            return;
          }
          resolve(entry.value);
        };
        req.onerror = () => resolve(undefined); // fail soft
      });
    } catch {
      return undefined; // fail soft: no IndexedDB, or it errored
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    try {
      const db = await this.openDb();
      const entry: CacheEntry = { value, expiresAt: Date.now() + CACHE_TTL_MS };
      await new Promise<void>((resolve) => {
        const tx = db.transaction(CACHE_STORE, "readwrite");
        tx.objectStore(CACHE_STORE).put(entry, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve(); // fail soft
      });
    } catch {
      // fail soft: caching is an optimization, never load-bearing
    }
  }
}

/** True in a browser/worker context that actually has a global `indexedDB`. */
export function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

export type OverpassErrorKind = "network" | "rate-limited" | "timeout" | "bad-response";

export interface OverpassFetchError {
  kind: OverpassErrorKind;
  mirrorsTried: string[];
  message: string;
}

export type OverpassFetchResult =
  | { ok: true; data: { elements: unknown[]; remark?: string }; fromCache: boolean }
  | { ok: false; error: OverpassFetchError };

export interface FetchOverpassOptions {
  /** Ordered mirror list; defaults to `DEFAULT_MIRRORS`. Exposed for the Settings UI override. */
  mirrors?: readonly string[];
  cache?: OverpassCache;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to `setTimeout`-based real delay. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * External cancellation (FrameCraft v3 E4: a superseded engine-client ingest
   * job). Checked before every attempt and every backoff wait, and tied into
   * the in-flight attempt's own `AbortController` via `AbortSignal.any` where
   * available, so a stale request stops burning a mirror instead of finishing
   * unread. Purely an optimisation: the caller drops a superseded result
   * either way, so no new `OverpassErrorKind` is needed for it.
   */
  signal?: AbortSignal;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function remarkOf(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const remark = (data as { remark?: unknown }).remark;
  if (typeof remark !== "string" || !remark.trim()) return null;
  return remark;
}

function isFatalRemark(data: unknown): string | null {
  const remark = remarkOf(data);
  if (remark === null) return null;
  const lowered = remark.toLowerCase();
  if (lowered.includes("runtime error") || lowered.includes("out of memory")) return remark;
  const elements = (data as { elements?: unknown }).elements;
  if (Array.isArray(elements) && elements.length === 0) return remark;
  return null;
}

/**
 * Fetch (or serve from cache) the Overpass response for `request`. Fails
 * soft: every failure path resolves to `{ ok: false, error }`, never a raw
 * thrown fetch/network error.
 */
export async function fetchOverpass(
  request: OverpassRequest,
  options: FetchOverpassOptions = {},
): Promise<OverpassFetchResult> {
  const mirrors = options.mirrors && options.mirrors.length > 0 ? options.mirrors : DEFAULT_MIRRORS;
  const cache = options.cache ?? new MemoryOverpassCache();
  const fetchImpl = options.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
  const sleep = options.sleep ?? defaultSleep;

  const query = buildQuery(request);
  const cacheKey = querySha1(query);

  const cached = await cache.get(cacheKey);
  if (cached && typeof cached === "object" && Array.isArray((cached as { elements?: unknown }).elements)) {
    return { ok: true, data: cached as { elements: unknown[]; remark?: string }, fromCache: true };
  }

  if (!fetchImpl) {
    return { ok: false, error: { kind: "network", mirrorsTried: [], message: "no fetch implementation available" } };
  }

  const mirrorsTried: string[] = [];
  let mirrorIndex = 0;
  let lastError: OverpassFetchError = {
    kind: "network",
    mirrorsTried: [],
    message: "no attempt made",
  };

  for (let attempt = 0; attempt < BACKOFF_MS.length + 1; attempt++) {
    if (options.signal?.aborted) {
      return { ok: false, error: { kind: "network", mirrorsTried, message: "cancelled" } };
    }
    const endpoint = mirrors[Math.min(mirrorIndex, mirrors.length - 1)];
    if (!mirrorsTried.includes(endpoint)) mirrorsTried.push(endpoint);

    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const timeoutId = controller ? setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS) : undefined;
    const attemptSignal =
      controller && options.signal && typeof AbortSignal !== "undefined" && "any" in AbortSignal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller?.signal;
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        body: query,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: attemptSignal,
      });
      if (timeoutId !== undefined) clearTimeout(timeoutId);

      if (response.status === 200) {
        let data: unknown;
        try {
          data = await response.json();
        } catch {
          lastError = { kind: "bad-response", mirrorsTried: [...mirrorsTried], message: `${endpoint} returned a non-JSON body` };
          if (mirrorIndex < mirrors.length - 1) mirrorIndex++;
          if (attempt < BACKOFF_MS.length) await sleep(BACKOFF_MS[attempt]);
          continue;
        }
        if (!data || typeof data !== "object" || !Array.isArray((data as { elements?: unknown }).elements)) {
          lastError = { kind: "bad-response", mirrorsTried: [...mirrorsTried], message: `${endpoint} returned no elements array` };
          if (mirrorIndex < mirrors.length - 1) mirrorIndex++;
          if (attempt < BACKOFF_MS.length) await sleep(BACKOFF_MS[attempt]);
          continue;
        }
        const fatal = isFatalRemark(data);
        if (fatal !== null) {
          lastError = { kind: "bad-response", mirrorsTried: [...mirrorsTried], message: `${endpoint} answered with a server-side failure: ${fatal}` };
          if (mirrorIndex < mirrors.length - 1) mirrorIndex++;
          if (attempt < BACKOFF_MS.length) await sleep(BACKOFF_MS[attempt]);
          continue;
        }
        const typed = data as { elements: unknown[]; remark?: string };
        await cache.set(cacheKey, typed);
        return { ok: true, data: typed, fromCache: false };
      }

      if (RETRY_STATUSES.has(response.status)) {
        lastError = {
          kind: response.status === 429 ? "rate-limited" : "network",
          mirrorsTried: [...mirrorsTried],
          message: `HTTP ${response.status} from ${endpoint}`,
        };
        if (mirrorIndex < mirrors.length - 1) mirrorIndex++;
      } else {
        lastError = { kind: "bad-response", mirrorsTried: [...mirrorsTried], message: `HTTP ${response.status} from ${endpoint}` };
        if (QUERY_FAULT_STATUSES.has(response.status)) {
          // The query is what is wrong; no mirror and no wait will fix it.
          return { ok: false, error: lastError };
        }
        if (mirrorIndex < mirrors.length - 1) mirrorIndex++;
      }
    } catch (err) {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      const aborted = err instanceof Error && err.name === "AbortError";
      lastError = {
        kind: aborted ? "timeout" : "network",
        mirrorsTried: [...mirrorsTried],
        message: aborted ? `${endpoint} timed out after ${ATTEMPT_TIMEOUT_MS}ms` : `${endpoint} network error: ${String(err)}`,
      };
      if (mirrorIndex < mirrors.length - 1) mirrorIndex++;
    }

    if (attempt < BACKOFF_MS.length) await sleep(BACKOFF_MS[attempt]);
  }

  return { ok: false, error: lastError };
}
