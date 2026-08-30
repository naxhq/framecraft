/**
 * The engine worker's message protocol, and the two job handlers
 * (`runIngestJob`, `runBakeJob`) that actually do the work.
 *
 * Pulled out of `worker.ts` so the exact same code runs inside the real
 * `Worker` AND inside `client.ts`'s in-page fallback (no Worker support:
 * vitest, a very old browser, or an environment that blocked worker
 * creation) -- one implementation, two transports, so the two can never
 * drift apart. Nothing here touches `self`/`postMessage`/DOM: every handler
 * takes a plain `post` callback instead, and `worker.ts` is the only file
 * that binds it to the real worker global scope.
 */

import type { PrintParams, SceneRequest } from "../contracts";
import { hasIndexedDb, IndexedDbOverpassCache, MemoryOverpassCache, type OverpassCache, type OverpassFetchError } from "./osm/overpass";
import { buildScene } from "./osm/scene";
import type { EngineSceneGraph } from "./osm/types";
import { bake } from "./engine";
import type { EngineInput, EngineResult } from "./types";

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** `EngineInput` minus `terrain`: a `TerrainSampler` carries a method and cannot cross a structured-clone boundary. Terrain is not wired into the UI yet (phase 3); the worker always bakes with `terrain: null`. */
export type BakeWireInput = Omit<EngineInput, "terrain">;

export interface IngestJobMessage {
  kind: "ingest";
  id: number;
  request: SceneRequest;
  params?: PrintParams;
}

export interface BakeJobMessage {
  kind: "bake";
  id: number;
  input: BakeWireInput;
}

export interface CancelMessage {
  kind: "cancel";
  id: number;
  jobKind: "ingest" | "bake";
}

export type WorkerRequest = IngestJobMessage | BakeJobMessage | CancelMessage;

export interface IngestProgressMessage {
  kind: "ingest-progress";
  id: number;
  message: string;
}

export interface IngestDoneMessage {
  kind: "ingest-done";
  id: number;
  ok: true;
  scene: EngineSceneGraph;
  fromCache: boolean;
}

export interface IngestFailedMessage {
  kind: "ingest-done";
  id: number;
  ok: false;
  error: OverpassFetchError;
}

export interface BakeProgressMessage {
  kind: "bake-progress";
  id: number;
  message: string;
}

export interface BakeDoneMessage {
  kind: "bake-done";
  id: number;
  result: EngineResult;
}

export interface BakeErrorMessage {
  kind: "bake-error";
  id: number;
  message: string;
}

export type WorkerResponse =
  | IngestProgressMessage
  | IngestDoneMessage
  | IngestFailedMessage
  | BakeProgressMessage
  | BakeDoneMessage
  | BakeErrorMessage;

/** What a handler posts a response through. `transfer` is honoured by the real worker's `postMessage` and ignored by the in-page fallback (nothing to transfer across a realm boundary that never existed). */
export type Post = (response: WorkerResponse, transfer?: Transferable[]) => void;

// ---------------------------------------------------------------------------
// Job ids
// ---------------------------------------------------------------------------

/**
 * A process-wide counter, not one per `EngineClient`/transport instance.
 * Two `EngineClient`s that both fall back to the in-page transport share this
 * module's `ingestControllers` map (same JS realm); per-instance counters
 * starting at 0 could collide there and let one client's `cancel` reach
 * another client's job. A single global sequence cannot.
 */
let jobCounter = 0;

export function allocateJobId(): number {
  jobCounter += 1;
  return jobCounter;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

let cache: OverpassCache | null = null;

/** One Overpass cache per realm (worker or main-thread fallback), created lazily so `hasIndexedDb()` is only consulted once actually needed. */
function overpassCache(): OverpassCache {
  if (cache === null) cache = hasIndexedDb() ? new IndexedDbOverpassCache() : new MemoryOverpassCache();
  return cache;
}

/**
 * Drop the module-level Overpass cache. Test-only: this cache is deliberately
 * realistic (a real 7-day TTL, shared across every `ingest` job in this
 * realm, exactly like a browser tab's would be), which means two tests in the
 * SAME file that query the same location can otherwise see one serve the
 * other's cached response instead of exercising a mocked `fetch`.
 */
export function resetOverpassCacheForTest(): void {
  cache = null;
}

const ingestControllers = new Map<number, AbortController>();

export async function runIngestJob(msg: IngestJobMessage, post: Post): Promise<void> {
  const controller = new AbortController();
  ingestControllers.set(msg.id, controller);
  post({ kind: "ingest-progress", id: msg.id, message: "Fetching from OpenStreetMap..." });
  try {
    const result = await buildScene(msg.request, msg.params, {
      cache: overpassCache(),
      signal: controller.signal,
    });
    // Superseded while the fetch was in flight: the client has already
    // dropped this job's pending promise, so posting would be silently
    // discarded there anyway. Not posting saves the structured-clone cost of
    // a scene graph nobody is waiting for.
    if (controller.signal.aborted) return;
    if (result.ok) {
      post({ kind: "ingest-done", id: msg.id, ok: true, scene: result.scene, fromCache: result.fromCache });
    } else {
      post({ kind: "ingest-done", id: msg.id, ok: false, error: result.error });
    }
  } finally {
    ingestControllers.delete(msg.id);
  }
}

/** Handle a `{kind:"cancel"}` message: abort the ingest fetch if it is still running. A `bake` job cannot be preempted mid-flight (see `runBakeJob`'s docstring), so a bake cancel is a documented no-op here; the client-side supersede is what actually protects the caller. */
export function cancelJob(msg: CancelMessage): void {
  if (msg.jobKind !== "ingest") return;
  ingestControllers.get(msg.id)?.abort();
}

// ---------------------------------------------------------------------------
// Bake
// ---------------------------------------------------------------------------

let bakeRunning = false;
let queuedBake: { msg: BakeJobMessage; post: Post } | null = null;

/**
 * Run one engine bake and post the result, single-flight.
 *
 * `bake()` awaits WASM setup and then runs synchronous manifold3d calls with
 * no yield points in between, so once it is under way the worker thread is
 * fully busy until it returns -- a `cancel` message for a bake job cannot
 * preempt it (see `protocol.ts`'s module docstring and `client.ts`'s
 * `EngineClient.bake`, which drops a superseded result on arrival instead).
 *
 * A `bake` message that arrives while one is already running does NOT queue
 * behind it for its own full run: it overwrites `queuedBake`, so a burst of N
 * requests made while the worker is busy (a slider settling, then a rotation
 * commit, then another) costs at most one MORE full bake after the one
 * already under way, not N of them run back to back. Every dropped
 * intermediate id would only ever have had its `bake-done`/`bake-error`
 * silently discarded anyway -- `client.ts`'s supersede already rejected its
 * promise the moment a newer request replaced it -- so running it to
 * completion first would just be worker time nothing is waiting for.
 * Measured on the full Chicago fixture, this is the difference between an
 * un-preemptible bake queue that visibly falls further behind with every
 * slider/rotation change and one that catches up to the latest request after
 * a bounded, single extra bake. DECISIONS.md [V3-P2-E4].
 *
 * `bake()` itself never throws for a printability problem (those are
 * `findings`/`resolvedText`); a caught error here is a genuine bug in the
 * input, exactly the cases `bake()`'s own docstring says it throws for.
 */
export async function runBakeJob(msg: BakeJobMessage, post: Post): Promise<void> {
  if (bakeRunning) {
    queuedBake = { msg, post };
    return;
  }
  bakeRunning = true;
  try {
    await runOneBake(msg, post);
  } finally {
    bakeRunning = false;
    const next = queuedBake;
    queuedBake = null;
    if (next !== null) void runBakeJob(next.msg, next.post);
  }
}

async function runOneBake(msg: BakeJobMessage, post: Post): Promise<void> {
  post({ kind: "bake-progress", id: msg.id, message: "Baking..." });
  try {
    const result = await bake({ ...msg.input, terrain: null });
    const transfer: Transferable[] = [];
    for (const region of result.regions) {
      transfer.push(region.positions.buffer, region.indices.buffer);
    }
    post({ kind: "bake-done", id: msg.id, result }, transfer);
  } catch (error) {
    post({ kind: "bake-error", id: msg.id, message: error instanceof Error ? error.message : String(error) });
  }
}

/** Test-only: drop the module-level single-flight bake state between tests. */
export function resetBakeQueueForTest(): void {
  bakeRunning = false;
  queuedBake = null;
}
