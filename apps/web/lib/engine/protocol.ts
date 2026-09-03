/**
 * The engine worker's message protocol, and `PipelineSession`, the handler
 * that actually does the work.
 *
 * Pulled out of `worker.ts` so the exact same code runs inside the real
 * `Worker` AND inside `client.ts`'s in-page fallback (no Worker support:
 * vitest, SSR, an environment that blocked worker creation): one
 * implementation, two transports, so the two can never drift apart. Nothing
 * here touches `self`/`postMessage`/DOM: the session takes a plain `post`
 * callback, and `worker.ts` is the only file that binds it to the real worker
 * global scope.
 *
 * Since v3.1 there is ONE worker and one job kind: a pipeline run
 * (`lib/engine/pipeline`). Ingest is a run in `scene` mode, a build is a run in
 * `full` mode, an export is an `export` job over the same cache. Single flight:
 * a request that arrives while a job runs sets the running job's abort flag,
 * which the runner honours at its next stage boundary (a manifold call in
 * progress cannot be interrupted); the job replies `cancelled`, keeps every
 * output it completed, and the newest request starts. A burst of requests
 * costs at most one stage of the job under way (design rulings 7 and 10).
 */

import type { PrintParams, SceneGraph, SceneRequest } from "../contracts";
import { perfDrainTimings, perfEnabled, perfMark, type PerfTiming } from "../perf";
import { hasIndexedDb, IndexedDbOverpassCache, MemoryOverpassCache, type OverpassCache } from "./osm/overpass";
import {
  StageCache,
  runPipeline,
  type ExportRequest,
  type OverpassOptions,
  type PipelineEvent,
  type PipelineJob,
  type RunMode,
  type TerrainGridInput,
} from "./pipeline";

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Perf mode is a PAGE decision (`?perf=1` / `localStorage`), and a worker can
 * read neither, so the flag rides on a job message ONLY when it is on and
 * `worker.ts` sets its own realm from it before the handler runs
 * (`lib/perf.ts`). Absent means the worker records nothing at all, and the
 * wire with perf off is byte-identical to a wire that never had the flag.
 */
export interface PerfJobFlag {
  perf?: true;
}

/**
 * Timings recorded inside the worker while this job ran, drained by
 * `worker.ts` onto the job's terminal message and merged into the page's
 * report by `client.ts`. Present only in perf mode.
 */
export interface PerfTimingsField {
  timings?: PerfTiming[];
}

/** Where a run's scene comes from. */
export type RunSource =
  | { kind: "request"; request: SceneRequest }
  | { kind: "scene"; scene: SceneGraph; key: string }
  /** The scene the worker already holds under this `normalise` hash; nothing crosses the wire. */
  | { kind: "cached"; key: string };

export interface RunJobMessage extends PerfJobFlag {
  kind: "run";
  id: number;
  source: RunSource;
  params: PrintParams;
  terrain: TerrainGridInput | null;
  heroIds: string[] | null;
  date: string;
  rotationDeg: number;
  mode: RunMode;
  /** `region -> hash` the page already holds; those are not re-sent. */
  known: Record<string, string>;
  knownSceneHash: string | null;
  /** The merged mesh and tiling hashes the page holds; `done` strips what is unchanged. Optional: an older client sends neither. */
  knownMergedHash?: string | null;
  knownTilesHash?: string | null;
}

/** Export the last run's model: the remaining uncached stages plus the writer. */
export interface ExportJobMessage extends PerfJobFlag {
  kind: "export";
  id: number;
  request: ExportRequest;
}

export interface CancelMessage {
  kind: "cancel";
  id: number;
}

export type WorkerRequest = RunJobMessage | ExportJobMessage | CancelMessage;

/** Every pipeline event, stamped with the job id; the terminal ones may carry the worker's perf timings. */
export type WorkerResponse = { id: number } & PipelineEvent & PerfTimingsField;

/** The message kinds that end a job; `worker.ts` drains the perf buffer onto them. */
export function isTerminalResponse(response: WorkerResponse): boolean {
  return response.kind === "done" || response.kind === "files" || response.kind === "error" || response.kind === "cancelled";
}

/**
 * Perf mode's stamp on a terminal response (`lib/perf.ts`): `engine.post` is
 * marked immediately before the message goes out, which is what lets
 * `client.ts` measure the structured-clone hop itself, and this realm's
 * timings ride on `timings`, so a worker's marks reach the page instead of
 * dying with its buffer. `worker.ts` posts through this; a test can wrap an
 * in-page session in it to see exactly what a worker would send. With perf
 * off this is one boolean read and the message goes out untouched.
 */
export function perfStampedPost(post: Post): Post {
  return (message, transfer) => {
    if (perfEnabled() && isTerminalResponse(message)) {
      perfMark("engine.post");
      message.timings = perfDrainTimings();
    }
    post(message, transfer);
  };
}

/** What a handler posts a response through. `transfer` is honoured by the real worker's `postMessage` and ignored by the in-page fallback (nothing to transfer across a realm boundary that never existed). */
export type Post = (response: WorkerResponse, transfer?: Transferable[]) => void;

// ---------------------------------------------------------------------------
// Job ids
// ---------------------------------------------------------------------------

/**
 * A process-wide counter, not one per client/transport instance: two clients
 * that both fall back to the in-page transport share a realm, and per-instance
 * counters starting at 0 could let one client's `cancel` reach another's job.
 */
let jobCounter = 0;

export function allocateJobId(): number {
  jobCounter += 1;
  return jobCounter;
}

// ---------------------------------------------------------------------------
// Overpass cache
// ---------------------------------------------------------------------------

let cache: OverpassCache | null = null;

/** One Overpass cache per realm (worker or main-thread fallback), created lazily so `hasIndexedDb()` is only consulted once actually needed. */
export function overpassCache(): OverpassCache {
  if (cache === null) cache = hasIndexedDb() ? new IndexedDbOverpassCache() : new MemoryOverpassCache();
  return cache;
}

/** Every live session in this realm, so a test reset can reach their stage caches too. */
const sessions = new Set<PipelineSession>();

/**
 * Drop the module-level Overpass cache AND every live session's cached
 * `fetch` and `normalise` stages. Test-only: both caches are deliberately
 * realistic (a real 7-day TTL and a one-generation stage cache, shared across
 * every job in this realm, exactly like a browser tab's would be), which means
 * two tests in the SAME file that query the same location can otherwise see
 * one serve the other's cached response instead of exercising a mocked
 * `fetch`.
 */
export function resetOverpassCacheForTest(): void {
  cache = null;
  for (const session of sessions) {
    session.cache.drop("normalise");
    session.cache.drop("fetch");
  }
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

interface ActiveJob {
  id: number;
  kind: "run" | "export";
  controller: AbortController;
}

interface QueuedJob {
  msg: RunJobMessage | ExportJobMessage;
  post: Post;
}

/** The inputs of the last run, which an `export` job reuses. */
interface LastRun {
  source: PipelineJob["source"];
  params: PrintParams;
  terrain: TerrainGridInput | null;
  heroIds: string[] | null;
  date: string;
  rotationDeg: number;
}

export interface PipelineSessionOptions {
  overpass?: OverpassOptions;
}

/**
 * One cache, one job at a time, latest request wins.
 *
 * Lives for the worker's lifetime (or the page's, on the inline transport).
 * The cache holds the latest output of every stage as live WASM handles; the
 * session never grows past one generation of it (`pipeline/cache.ts`).
 */
export class PipelineSession {
  readonly cache = new StageCache();
  private current: ActiveJob | null = null;
  private queued: QueuedJob | null = null;
  private last: LastRun | null = null;
  private readonly options: PipelineSessionOptions;

  constructor(options: PipelineSessionOptions = {}) {
    this.options = options;
    sessions.add(this);
  }

  /** True while a job is running. */
  get busy(): boolean {
    return this.current !== null;
  }

  handle(msg: WorkerRequest, post: Post): void {
    switch (msg.kind) {
      case "cancel":
        if (this.queued !== null && this.queued.msg.id === msg.id) this.queued = null;
        if (this.current !== null && this.current.id === msg.id) this.current.controller.abort();
        return;
      case "run":
      case "export":
        this.enqueue({ msg, post });
        return;
      default: {
        const never: never = msg;
        throw new Error(`engine session: unknown message ${JSON.stringify(never)}`);
      }
    }
  }

  /** Free every cached handle. The worker never calls this; tests and `dispose()` on the inline transport do. */
  dispose(): void {
    this.current?.controller.abort();
    this.queued = null;
    this.cache.dispose();
    sessions.delete(this);
  }

  private enqueue(job: QueuedJob): void {
    if (this.current !== null) {
      // An export waits for the run in flight: it needs that run's model, and
      // the page needs that run's `done`. Anything else supersedes at the next
      // stage boundary: the running job stops there, replies `cancelled`, and
      // the newest request starts. An intermediate request that never started
      // posts nothing at all.
      this.queued = job;
      if (!(job.msg.kind === "export" && this.current.kind === "run")) this.current.controller.abort();
      return;
    }
    this.start(job);
  }

  private start(job: QueuedJob): void {
    const controller = new AbortController();
    this.current = { id: job.msg.id, kind: job.msg.kind, controller };
    void this.runOne(job.msg, job.post, controller.signal).finally(() => {
      this.current = null;
      const next = this.queued;
      this.queued = null;
      if (next !== null) this.start(next);
    });
  }

  private async runOne(msg: RunJobMessage | ExportJobMessage, post: Post, signal: AbortSignal): Promise<void> {
    const emit = (event: PipelineEvent, transfer?: Transferable[]): void => {
      post({ id: msg.id, ...event }, transfer);
    };
    let job: PipelineJob;
    try {
      job = this.jobFor(msg);
    } catch (error) {
      emit({ kind: "error", stage: "export", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    try {
      await runPipeline(job, this.cache, emit, {
        signal,
        overpass: { cache: overpassCache(), ...this.options.overpass },
        stripRegionMeshes: true,
      });
    } catch (error) {
      // The runner reports stage failures as `error` events itself; this is
      // the safety net for a throw outside any stage (WASM failed to load).
      emit({ kind: "error", stage: "fetch", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private jobFor(msg: RunJobMessage | ExportJobMessage): PipelineJob {
    if (msg.kind === "run") {
      const source: PipelineJob["source"] = msg.source;
      // Only a run that built a model can be exported; an ingest (`scene`
      // mode) may carry no params at all.
      if (msg.mode === "preview" || msg.mode === "full") {
        this.last = {
          source,
          params: msg.params,
          terrain: msg.terrain,
          heroIds: msg.heroIds,
          date: msg.date,
          rotationDeg: msg.rotationDeg,
        };
      }
      return {
        source,
        params: msg.params,
        terrain: msg.terrain,
        heroIds: msg.heroIds,
        date: msg.date,
        rotationDeg: msg.rotationDeg,
        mode: msg.mode,
        exportRequest: null,
        known: msg.known,
        knownSceneHash: msg.knownSceneHash,
        knownMergedHash: msg.knownMergedHash ?? null,
        knownTilesHash: msg.knownTilesHash ?? null,
      };
    }
    if (this.last === null) throw new Error("nothing to export: no model has been run in this session (an ingest alone does not build one)");
    // The last run's own inputs: the export is that model's remaining stages.
    return {
      source: this.last.source,
      params: this.last.params,
      terrain: this.last.terrain,
      heroIds: this.last.heroIds,
      date: this.last.date,
      rotationDeg: this.last.rotationDeg,
      mode: "export",
      exportRequest: msg.request,
      // An export re-sends nothing the page already holds: it posts the files.
      known: {},
      knownSceneHash: null,
    };
  }
}
