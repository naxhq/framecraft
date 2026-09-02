/**
 * The engine worker's message protocol, and the two job handlers
 * (`runIngestJob`, `runBuildJob`) that actually do the work.
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
import type { PerfTiming } from "../perf";
import { hasIndexedDb, IndexedDbOverpassCache, MemoryOverpassCache, type OverpassCache, type OverpassFetchError } from "./osm/overpass";
import { buildScene } from "./osm/scene";
import type { EngineSceneGraph } from "./osm/types";
import { buildModel } from "./engine";
import type { EngineInput, EngineResult } from "./types";

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * `EngineInput` as sent over the wire, unchanged.
 *
 * Phase 3: `EngineInput.terrain` is now a `TerrainGrid` (plain numbers plus a
 * `Float32Array`), not a `TerrainSampler` -- a sampler carries a method and
 * could never cross a structured-clone boundary, but a grid clones (and can be
 * transferred) exactly like the `RegionMesh` buffers `runOneBuild` already
 * transfers back. `buildModel()` itself builds the sampler from the grid
 * (`engine.ts:samplerFromGrid`), so nothing on this side of the boundary ever
 * touches a function value.
 */
export type BuildWireInput = EngineInput;

/**
 * Perf mode is a PAGE decision (`?perf=1` / `localStorage`), and a worker can
 * read neither, so the flag rides on every job message and `worker.ts` sets
 * its own realm from it before the handler runs (`lib/perf.ts`). Absent or
 * false means the worker records nothing at all.
 */
export interface PerfJobFlag {
  perf?: boolean;
}

/**
 * Timings recorded inside the worker while this job ran, drained by
 * `worker.ts` onto the result message and merged into the page's report by
 * `client.ts`. Additive and optional: a message without it is exactly the
 * message this protocol carried before perf mode existed.
 */
export interface PerfTimingsField {
  timings?: PerfTiming[];
}

export interface IngestJobMessage extends PerfJobFlag {
  kind: "ingest";
  id: number;
  request: SceneRequest;
  params?: PrintParams;
}

export interface BuildJobMessage extends PerfJobFlag {
  kind: "build";
  id: number;
  input: BuildWireInput;
}

export interface CancelMessage {
  kind: "cancel";
  id: number;
  jobKind: "ingest" | "build";
}

export type WorkerRequest = IngestJobMessage | BuildJobMessage | CancelMessage;

export interface IngestProgressMessage {
  kind: "ingest-progress";
  id: number;
  message: string;
}

export interface IngestDoneMessage extends PerfTimingsField {
  kind: "ingest-done";
  id: number;
  ok: true;
  scene: EngineSceneGraph;
  fromCache: boolean;
}

export interface IngestFailedMessage extends PerfTimingsField {
  kind: "ingest-done";
  id: number;
  ok: false;
  error: OverpassFetchError;
}

export interface BuildProgressMessage {
  kind: "build-progress";
  id: number;
  message: string;
}

export interface BuildDoneMessage extends PerfTimingsField {
  kind: "build-done";
  id: number;
  result: EngineResult;
}

export interface BuildErrorMessage extends PerfTimingsField {
  kind: "build-error";
  id: number;
  message: string;
}

export type WorkerResponse =
  | IngestProgressMessage
  | IngestDoneMessage
  | IngestFailedMessage
  | BuildProgressMessage
  | BuildDoneMessage
  | BuildErrorMessage;

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

/**
 * Handle a `{kind:"cancel"}` message.
 *
 * An ingest's fetch is aborted. A build that is already RUNNING cannot be
 * preempted mid-flight (see `runBuildJob`'s docstring) and the client-side
 * supersede is what protects the caller there; but a build still sitting in
 * `queuedBuild` has not started, and starting it after its own promise was
 * rejected would spend a full Chicago-scale build on a result that is dropped
 * by id on arrival. So a cancel for the queued id drops it (v3-02 finding 7).
 */
export function cancelJob(msg: CancelMessage): void {
  if (msg.jobKind === "build") {
    if (queuedBuild !== null && queuedBuild.msg.id === msg.id) queuedBuild = null;
    return;
  }
  ingestControllers.get(msg.id)?.abort();
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

let buildRunning = false;
let queuedBuild: { msg: BuildJobMessage; post: Post } | null = null;

/**
 * Run one engine build and post the result, single-flight.
 *
 * `buildModel()` awaits WASM setup and then runs synchronous manifold3d calls with
 * no yield points in between, so once it is under way the worker thread is
 * fully busy until it returns -- a `cancel` message for a build job cannot
 * preempt it (see `protocol.ts`'s module docstring and `client.ts`'s
 * `EngineClient.buildModel`, which drops a superseded result on arrival instead).
 *
 * A `build` message that arrives while one is already running does NOT queue
 * behind it for its own full run: it overwrites `queuedBuild`, so a burst of N
 * requests made while the worker is busy (a slider settling, then a rotation
 * commit, then another) costs at most one MORE full build after the one
 * already under way, not N of them run back to back. Every dropped
 * intermediate id would only ever have had its `build-done`/`build-error`
 * silently discarded anyway -- `client.ts`'s supersede already rejected its
 * promise the moment a newer request replaced it -- so running it to
 * completion first would just be worker time nothing is waiting for.
 * Measured on the full Chicago fixture, this is the difference between an
 * un-preemptible build queue that visibly falls further behind with every
 * slider/rotation change and one that catches up to the latest request after
 * a bounded, single extra build. DECISIONS.md [V3-P2-E4].
 *
 * `buildModel()` itself never throws for a printability problem (those are
 * `findings`/`resolvedText`); a caught error here is a genuine bug in the
 * input, exactly the cases `buildModel()`'s own docstring says it throws for.
 */
export async function runBuildJob(msg: BuildJobMessage, post: Post): Promise<void> {
  if (buildRunning) {
    queuedBuild = { msg, post };
    return;
  }
  buildRunning = true;
  try {
    await runOneBuild(msg, post);
  } finally {
    buildRunning = false;
    const next = queuedBuild;
    queuedBuild = null;
    if (next !== null) void runBuildJob(next.msg, next.post);
  }
}

async function runOneBuild(msg: BuildJobMessage, post: Post): Promise<void> {
  post({ kind: "build-progress", id: msg.id, message: "Building..." });
  try {
    const result = await buildModel(msg.input);
    const transfer: Transferable[] = [];
    for (const region of result.regions) {
      transfer.push(region.positions.buffer, region.indices.buffer);
    }
    post({ kind: "build-done", id: msg.id, result }, transfer);
  } catch (error) {
    post({ kind: "build-error", id: msg.id, message: error instanceof Error ? error.message : String(error) });
  }
}

/** Test-only: drop the module-level single-flight build state between tests. */
export function resetBuildQueueForTest(): void {
  buildRunning = false;
  queuedBuild = null;
}
