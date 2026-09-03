/**
 * The typed, cancellation-aware wrapper around the engine worker.
 *
 * `PipelineClient` is the main-thread handle on the pipeline (design section
 * 4): `run(input)` returns a `RunHandle` with observable stage progress,
 * progressive region meshes and a `done` promise; `exportFiles(request)` runs
 * the remaining uncached stages and hands back the files. `EngineClient` is
 * the surface `store/editor.ts` has used since v3 (`ingest`, `buildModel`,
 * cancel semantics), implemented over `PipelineClient` so the store does not
 * change in this wave; the next wave drives `PipelineClient` directly.
 *
 * Two transports share one protocol (`lib/engine/protocol.ts`):
 *
 *  - `WorkerTransport`, a real `Worker`: what the browser uses;
 *  - `InlineTransport`, one `PipelineSession` on the calling thread: what
 *    every environment without `Worker` uses (vitest, SSR, `next build`'s
 *    prerender pass, a browser that refused worker creation).
 *
 * ONE worker since v3.1: ingest and build are runs of the same pipeline over
 * the same cache (the scene a run normalised is what the build reads), so a
 * second worker would only hold a copy. Single flight stays: a new `run` (or
 * an export) while one is in flight rejects the previous handle's `done` with
 * `EngineClientError("cancelled", ...)` here and sets the worker's abort flag;
 * the worker stops at its next stage boundary, keeps every output it
 * completed, and starts the newest request. Callers treat that rejection as
 * "a newer request took over", not as a failure to report.
 */

import { installWasmBasePathFetchShim } from "../basePath";
import type { PrintParams, SceneGraph, SceneRequest } from "../contracts";
import { perfEnabled, perfMergeTimings, perfRecord, perfSpan } from "../perf";
import type { OverpassFetchError } from "./osm/overpass";
import type { EngineSceneGraph } from "./osm/types";
import { hashString, type ExportOut, type ExportRequest, type RunMode, type StageEvent, type TerrainGridInput } from "./pipeline";
import { PipelineSession, allocateJobId, type RunSource, type WorkerRequest, type WorkerResponse } from "./protocol";
import type { EngineInput, EngineResult, RegionMesh } from "./types";

export type IngestOutcome =
  | { ok: true; scene: EngineSceneGraph; fromCache: boolean }
  | { ok: false; error: OverpassFetchError };

export interface IngestOptions {
  onProgress?: (message: string) => void;
}

export interface BuildOptions {
  onProgress?: (message: string) => void;
}

export type EngineClientErrorCode = "cancelled" | "disposed" | "transport";

export class EngineClientError extends Error {
  readonly code: EngineClientErrorCode;
  constructor(code: EngineClientErrorCode, message: string) {
    super(message);
    this.name = "EngineClientError";
    this.code = code;
  }
}

/** A stage failure reported by the worker: the stage that threw and its message. */
export class PipelineStageError extends Error {
  readonly stage: string;
  readonly detail: unknown;
  constructor(stage: string, message: string, detail?: unknown) {
    super(message);
    this.name = "PipelineStageError";
    this.stage = stage;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** What the clients need from either transport. */
export interface Transport {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  onMessage(handler: (message: WorkerResponse) => void): void;
  /** A transport-level failure (worker threw, worker crashed), never a job failure, which arrives as an `error` event. */
  onError(handler: (error: Error) => void): void;
  terminate(): void;
}

/** The subset of the DOM `Worker` interface this file needs, so a test can hand in a fake without importing `lib.dom`'s `Worker` type. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

class WorkerTransport implements Transport {
  constructor(private readonly worker: WorkerLike) {}

  postMessage(message: WorkerRequest, transfer?: Transferable[]): void {
    this.worker.postMessage(message, transfer ?? []);
  }

  onMessage(handler: (message: WorkerResponse) => void): void {
    this.worker.onmessage = (event) => handler(event.data);
  }

  onError(handler: (error: Error) => void): void {
    this.worker.onerror = (event) => {
      handler(new Error(event.message || "the engine worker failed"));
    };
  }

  terminate(): void {
    this.worker.terminate();
  }
}

/**
 * Runs one `PipelineSession` directly on the calling thread, in the exact
 * message shapes a real worker would exchange, so the clients' own logic (job
 * ids, supersede, event routing) is identical either way and only the
 * transport differs.
 */
export class InlineTransport implements Transport {
  private handler: ((message: WorkerResponse) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  readonly session: PipelineSession;

  constructor(session: PipelineSession = new PipelineSession()) {
    this.session = session;
  }

  onMessage(handler: (message: WorkerResponse) => void): void {
    this.handler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  postMessage(message: WorkerRequest): void {
    try {
      this.session.handle(message, (response) => {
        this.handler?.(response);
      });
    } catch (error) {
      this.errorHandler?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  terminate(): void {
    this.session.dispose();
  }
}

function createDefaultTransport(): Transport {
  if (typeof Worker === "undefined") {
    // The engine will run on THIS thread, so this scope's fetch needs the
    // sub-path WASM shim the worker installs for itself (no-op at the root).
    installWasmBasePathFetchShim();
    return new InlineTransport();
  }
  try {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    return new WorkerTransport(worker);
  } catch {
    // Worker creation itself can throw (e.g. a restrictive CSP, or a test
    // environment that stubs `Worker` as a constructor that always fails):
    // fail soft into the same fallback the "no Worker at all" branch uses.
    installWasmBasePathFetchShim();
    return new InlineTransport();
  }
}

// ---------------------------------------------------------------------------
// Observables
// ---------------------------------------------------------------------------

export type Listener<T> = (value: T) => void;

/** The smallest observable that does the job: subscribe, get an unsubscribe back. */
export interface Observable<T> {
  subscribe(listener: Listener<T>): () => void;
}

class Subject<T> implements Observable<T> {
  private readonly listeners = new Set<Listener<T>>();

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  next(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
}

// ---------------------------------------------------------------------------
// PipelineClient
// ---------------------------------------------------------------------------

export type ProgressEvent =
  | { kind: "plan"; total: number; stages: string[] }
  | StageEvent
  | { kind: "phase"; phase: StageEvent["phase"]; elapsedMs: number };

export interface RegionsEvent {
  regions: RegionMesh[];
  removed: string[];
}

export interface SceneEvent {
  scene: EngineSceneGraph;
  hash: string;
  fromCache: boolean;
}

export interface RunInput {
  source: RunSource;
  params: PrintParams;
  terrain?: TerrainGridInput | null;
  /** A caller-resolved hero list; omit to let the worker resolve `hero_auto`. */
  heroIds?: string[] | null;
  /** ISO date for `{date}` and the marks; defaults to today. */
  date?: string;
  rotationDeg?: number;
  /** Defaults to `full`. */
  mode?: RunMode;
  /** `region -> hash` the caller already holds; those regions are not re-sent. */
  known?: Record<string, string>;
  knownSceneHash?: string | null;
}

export interface RunDone {
  /** Null for a `scene` or `preview` run. Regions carry NO positions: they were streamed on `regions`. */
  result: EngineResult | null;
  regionHashes: Record<string, string>;
  scene: SceneEvent | null;
  elapsedMs: number;
}

export interface RunHandle {
  readonly id: number;
  readonly progress: Observable<ProgressEvent>;
  readonly regions: Observable<RegionsEvent>;
  readonly scene: Observable<SceneEvent>;
  /** Rejects with `EngineClientError("cancelled")` when superseded or cancelled, `PipelineStageError` when a stage failed. */
  readonly done: Promise<RunDone>;
  cancel(): void;
}

interface PendingRun {
  id: number;
  progress: Subject<ProgressEvent>;
  regions: Subject<RegionsEvent>;
  scene: Subject<SceneEvent>;
  lastScene: SceneEvent | null;
  resolve: (value: RunDone) => void;
  reject: (error: unknown) => void;
}

interface PendingExport {
  id: number;
  resolve: (value: ExportOut) => void;
  reject: (error: unknown) => void;
}

export class PipelineClient {
  private readonly transport: Transport;
  private pendingRun: PendingRun | null = null;
  private pendingExport: PendingExport | null = null;
  private disposed = false;

  constructor(transport: Transport = createDefaultTransport()) {
    this.transport = transport;
    this.transport.onMessage((message) => this.handleMessage(message));
    this.transport.onError((error) => this.handleTransportError(error));
  }

  /** Start a run. A run (or export) already in flight is superseded: its promise rejects `cancelled` and the worker stops it at the next stage boundary. */
  run(input: RunInput): RunHandle {
    if (this.disposed) {
      const error = new EngineClientError("disposed", "the engine client was disposed");
      const rejected = Promise.reject(error);
      rejected.catch(() => undefined);
      const empty = new Subject<never>();
      return { id: -1, progress: empty, regions: empty, scene: empty, done: rejected, cancel: () => undefined };
    }
    this.supersede();
    const id = allocateJobId();
    const progress = new Subject<ProgressEvent>();
    const regions = new Subject<RegionsEvent>();
    const scene = new Subject<SceneEvent>();
    const done = new Promise<RunDone>((resolve, reject) => {
      this.pendingRun = { id, progress, regions, scene, lastScene: null, resolve, reject };
    });
    // A rejection nobody awaits (a superseded run whose caller only watches
    // regions) must not surface as an unhandled rejection.
    done.catch(() => undefined);
    this.transport.postMessage({
      kind: "run",
      id,
      source: input.source,
      params: input.params,
      terrain: input.terrain ?? null,
      heroIds: input.heroIds ?? null,
      date: input.date ?? new Date().toISOString().slice(0, 10),
      rotationDeg: input.rotationDeg ?? 0,
      mode: input.mode ?? "full",
      known: input.known ?? {},
      knownSceneHash: input.knownSceneHash ?? null,
      ...(perfEnabled() ? { perf: true } : {}),
    });
    return {
      id,
      progress,
      regions,
      scene,
      done,
      cancel: () => this.cancel(id),
    };
  }

  /** Export the last run's model: the remaining uncached stages and the writer, in the worker. Files arrive transferred. */
  exportFiles(request: ExportRequest): Promise<ExportOut> {
    if (this.disposed) return Promise.reject(new EngineClientError("disposed", "the engine client was disposed"));
    this.supersede();
    const id = allocateJobId();
    const pending = new Promise<ExportOut>((resolve, reject) => {
      this.pendingExport = { id, resolve, reject };
    });
    this.transport.postMessage({ kind: "export", id, request, ...(perfEnabled() ? { perf: true } : {}) });
    return pending;
  }

  /** Stop the job with this id at its next stage boundary. Its promise rejects `cancelled`; completed stages stay cached. */
  cancel(id: number): void {
    if (this.pendingRun !== null && this.pendingRun.id === id) {
      const run = this.pendingRun;
      this.pendingRun = null;
      this.transport.postMessage({ kind: "cancel", id });
      run.reject(new EngineClientError("cancelled", "the run was cancelled"));
      return;
    }
    if (this.pendingExport !== null && this.pendingExport.id === id) {
      const job = this.pendingExport;
      this.pendingExport = null;
      this.transport.postMessage({ kind: "cancel", id });
      job.reject(new EngineClientError("cancelled", "the export was cancelled"));
    }
  }

  /** Tear the client down: terminate the worker (dispose the session on the inline transport) and reject every job still in flight. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new EngineClientError("disposed", "the engine client was disposed");
    // Cancel before terminating: `terminate()` disposes the inline session,
    // and on a real worker the terminate that follows makes these moot.
    if (this.pendingRun !== null) {
      this.transport.postMessage({ kind: "cancel", id: this.pendingRun.id });
      this.pendingRun.reject(error);
      this.pendingRun = null;
    }
    if (this.pendingExport !== null) {
      this.transport.postMessage({ kind: "cancel", id: this.pendingExport.id });
      this.pendingExport.reject(error);
      this.pendingExport = null;
    }
    this.transport.terminate();
  }

  private supersede(): void {
    if (this.pendingRun !== null) {
      const run = this.pendingRun;
      this.pendingRun = null;
      // The worker supersedes on its own when the next message arrives; the
      // explicit cancel keeps the inline session's queue tidy either way.
      this.transport.postMessage({ kind: "cancel", id: run.id });
      run.reject(new EngineClientError("cancelled", "a newer request superseded this run"));
    }
    if (this.pendingExport !== null) {
      const job = this.pendingExport;
      this.pendingExport = null;
      this.transport.postMessage({ kind: "cancel", id: job.id });
      job.reject(new EngineClientError("cancelled", "a newer request superseded this export"));
    }
  }

  /**
   * Fold the worker's own marks into the page's perf report, and measure the
   * hop itself.
   *
   * `engine.post` is stamped by `worker.ts` immediately before `postMessage`;
   * its `epochMs` is the worker's `performance.timeOrigin` plus its own clock,
   * so the difference to this realm's epoch clock IS the structured-clone and
   * transfer cost of the message. The two realms' epoch clocks agree in
   * Chromium; where they do not (a negative hop) the row is dropped rather
   * than reported as a plausible-looking zero (v3-00 audit finding 6).
   */
  private absorbTimings(message: WorkerResponse): void {
    if (!perfEnabled()) return;
    const timings = message.timings;
    if (timings === undefined || timings.length === 0) return;
    const receivedEpochMs = performance.timeOrigin + performance.now();
    const posted = timings.find((timing) => timing.name === "engine.post");
    perfMergeTimings(timings);
    if (posted !== undefined) {
      const durationMs = receivedEpochMs - posted.epochMs;
      if (durationMs >= 0) perfRecord("engine.transfer", performance.now() - durationMs, durationMs);
    }
  }

  private handleMessage(message: WorkerResponse): void {
    this.absorbTimings(message);
    const run = this.pendingRun !== null && this.pendingRun.id === message.id ? this.pendingRun : null;
    const exporting = this.pendingExport !== null && this.pendingExport.id === message.id ? this.pendingExport : null;
    // A message for a job that was superseded, cancelled or unknown: dropped.
    if (run === null && exporting === null) return;
    switch (message.kind) {
      case "plan":
        run?.progress.next({ kind: "plan", total: message.total, stages: message.stages });
        return;
      case "stage":
        run?.progress.next(message);
        return;
      case "phase":
        run?.progress.next({ kind: "phase", phase: message.phase, elapsedMs: message.elapsedMs });
        return;
      case "scene-ready": {
        if (run === null) return;
        const event: SceneEvent = { scene: message.scene, hash: message.hash, fromCache: message.fromCache };
        run.lastScene = event;
        run.scene.next(event);
        return;
      }
      case "region-ready":
        run?.regions.next({ regions: message.regions, removed: message.removed });
        return;
      case "done":
        if (run === null) return;
        this.pendingRun = null;
        run.resolve({ result: message.result, regionHashes: message.regionHashes, scene: run.lastScene, elapsedMs: message.elapsedMs });
        return;
      case "files":
        if (exporting === null) return;
        this.pendingExport = null;
        exporting.resolve(message.output);
        return;
      case "error": {
        const error = new PipelineStageError(message.stage, message.message, message.detail);
        if (run !== null) {
          this.pendingRun = null;
          run.reject(error);
        }
        if (exporting !== null) {
          this.pendingExport = null;
          exporting.reject(error);
        }
        return;
      }
      case "cancelled": {
        const error = new EngineClientError("cancelled", `the job was cancelled at ${message.atStage}`);
        if (run !== null) {
          this.pendingRun = null;
          run.reject(error);
        }
        if (exporting !== null) {
          this.pendingExport = null;
          exporting.reject(error);
        }
        return;
      }
      default: {
        const never: never = message;
        throw new Error(`engine client: unknown response ${JSON.stringify(never)}`);
      }
    }
  }

  private handleTransportError(error: Error): void {
    const wrapped = new EngineClientError("transport", error.message);
    if (this.pendingRun !== null) {
      this.pendingRun.reject(wrapped);
      this.pendingRun = null;
    }
    if (this.pendingExport !== null) {
      this.pendingExport.reject(wrapped);
      this.pendingExport = null;
    }
  }
}

// ---------------------------------------------------------------------------
// EngineClient: the store's surface this wave
// ---------------------------------------------------------------------------

export interface EngineClientTransports {
  transport?: Transport;
}

/** The message a stage event reads as, for the `onProgress` callbacks the store still passes. */
function describeStage(event: StageEvent): string {
  return `${event.state === "cached" ? "Reusing" : "Building"} ${event.stage} (${event.index + 1}/${event.total})`;
}

export class EngineClient {
  readonly pipeline: PipelineClient;
  private lastScene: { scene: EngineSceneGraph; hash: string } | null = null;
  /**
   * The ingest in flight, if any. A build requested while it runs WAITS for it
   * rather than superseding it: the store fires debounced builds on its own
   * clock (a scene-ready moment, a slider) and assumes, from the two-worker
   * days, that a build can never take an ingest down. The build that follows
   * a successful ingest is scheduled by the store anyway; one that follows a
   * failed ingest still runs, on the scene the store still holds.
   */
  private inflightIngest: Promise<void> | null = null;
  private disposed = false;

  constructor(transports: EngineClientTransports = {}) {
    this.pipeline = new PipelineClient(transports.transport ?? createDefaultTransport());
  }

  /**
   * `SceneRequest` -> `EngineSceneGraph`: a `scene`-mode run (fetch and
   * normalise). Fails soft: an Overpass problem resolves `{ok:false,error}`;
   * only a superseded or disposed call rejects. The scene stays in the worker's
   * cache, so the build that follows sends a key instead of 1.2 MB of scene.
   */
  ingest(request: SceneRequest, params?: PrintParams, options: IngestOptions = {}): Promise<IngestOutcome> {
    if (this.disposed) return Promise.reject(new EngineClientError("disposed", "the engine client was disposed"));
    return perfSpan("engine.ingest.client", async (): Promise<IngestOutcome> => {
      const handle = this.pipeline.run({
        source: { kind: "request", request },
        params: params ?? ({} as PrintParams),
        mode: "scene",
        knownSceneHash: this.lastScene?.hash ?? null,
      });
      if (options.onProgress) {
        options.onProgress("Fetching from OpenStreetMap...");
        handle.progress.subscribe((event) => {
          if (event.kind === "stage" && event.state === "start") options.onProgress?.(describeStage(event));
        });
      }
      let scene: { scene: EngineSceneGraph; hash: string; fromCache: boolean } | null = null;
      handle.scene.subscribe((event) => {
        scene = event;
      });
      const settled = handle.done.then(
        () => undefined,
        () => undefined,
      );
      this.inflightIngest = settled;
      void settled.then(() => {
        if (this.inflightIngest === settled) this.inflightIngest = null;
      });
      try {
        const done = await handle.done;
        const got = scene ?? done.scene ?? (this.lastScene === null ? null : { ...this.lastScene, fromCache: true });
        if (got === null) throw new Error("the ingest finished without a scene");
        this.lastScene = { scene: got.scene, hash: got.hash };
        return { ok: true, scene: got.scene, fromCache: got.fromCache };
      } catch (error) {
        if (error instanceof PipelineStageError) {
          const detail = error.detail as { overpass?: OverpassFetchError } | undefined;
          if (detail?.overpass !== undefined) return { ok: false, error: detail.overpass };
          throw error;
        }
        throw error;
      }
    });
  }

  /**
   * `EngineInput` -> `EngineResult`: a `full` run. The scene the last ingest
   * returned is sent as a key; any other scene object is sent whole with a
   * content hash, so a warm worker still recognises it.
   */
  buildModel(input: EngineInput, options: BuildOptions = {}): Promise<EngineResult> {
    if (this.disposed) return Promise.reject(new EngineClientError("disposed", "the engine client was disposed"));
    // With no ingest in flight the run is posted synchronously, as it always
    // was; behind an ingest, builds start in order once it settles, and the
    // second supersedes the first at once.
    const gate = this.inflightIngest;
    if (gate === null) return perfSpan("engine.build.client", () => this.runBuild(input, options, false));
    return perfSpan("engine.build.client", () =>
      gate.then(() => {
        if (this.disposed) throw new EngineClientError("disposed", "the engine client was disposed");
        return this.runBuild(input, options, false);
      }),
    );
  }

  private async runBuild(input: EngineInput, options: BuildOptions, resend: boolean): Promise<EngineResult> {
    const cached = !resend && this.lastScene !== null && this.lastScene.scene === (input.scene as EngineSceneGraph);
    const source: RunSource = cached
      ? { kind: "cached", key: this.lastScene?.hash ?? "" }
      : { kind: "scene", scene: input.scene, key: sceneKeyOf(input.scene) };
    const handle = this.pipeline.run({
      source,
      params: input.params,
      terrain: input.terrain === undefined || input.terrain === null ? null : { grid: input.terrain, gate: "always" },
      heroIds: input.heroIds ?? null,
      date: input.date,
      rotationDeg: input.rotationDeg ?? 0,
      mode: "full",
      known: {},
    });
    if (options.onProgress) {
      options.onProgress("Building...");
      handle.progress.subscribe((event) => {
        if (event.kind === "stage" && event.state === "start") options.onProgress?.(describeStage(event));
      });
    }
    const meshes = new Map<string, RegionMesh>();
    handle.regions.subscribe((event) => {
      for (const region of event.regions) meshes.set(region.region, region);
      for (const region of event.removed) meshes.delete(region);
    });
    let done: RunDone;
    try {
      done = await handle.done;
    } catch (error) {
      const detail = error instanceof PipelineStageError ? (error.detail as { sceneNotCached?: boolean } | undefined) : undefined;
      if (cached && detail?.sceneNotCached === true) return this.runBuild(input, options, true);
      if (error instanceof PipelineStageError) throw new Error(error.message);
      throw error;
    }
    if (done.result === null) throw new Error("the build finished without a result");
    // The regions were streamed with their positions; the `done` result carries
    // them stripped. Put the two back together into the EngineResult the store
    // has always received.
    const regions = done.result.regions.map((region) => {
      const streamed = meshes.get(region.region);
      return streamed === undefined ? region : { ...region, positions: streamed.positions, indices: streamed.indices };
    });
    return { ...done.result, regions };
  }

  /** Tear the client down: terminate the worker and reject every job still in flight. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pipeline.dispose();
  }
}

/** A content key for a scene object sent whole, so a warm worker recognises the same scene again. */
export function sceneKeyOf(scene: SceneGraph): string {
  return hashString(JSON.stringify(scene));
}

export function createEngineClient(): EngineClient {
  return new EngineClient();
}

export function createPipelineClient(): PipelineClient {
  return new PipelineClient();
}

/** Exposed for tests that want to construct a client over a fake `Worker` without a real worker thread. */
export function createWorkerTransportForTest(worker: WorkerLike): Transport {
  return new WorkerTransport(worker);
}
