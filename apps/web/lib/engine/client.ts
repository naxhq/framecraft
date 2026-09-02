/**
 * The typed, cancellation-aware wrapper around the engine workers.
 *
 * `EngineClient` is the ONLY thing the app talks to for ingest (`buildScene`)
 * and build (`buildModel()`): `store/editor.ts` never imports `worker.ts` or
 * `protocol.ts` directly. Two KINDS of transport share one protocol
 * (`lib/engine/protocol.ts`):
 *
 *  - `WorkerTransport`, a real `Worker` -- what the browser uses;
 *  - `InlineTransport`, which runs the very same job handlers on the calling
 *    thread -- what every environment without `Worker` uses (vitest, SSR,
 *    `next build`'s prerender pass, a browser that refused worker creation).
 *
 * INGEST AND BUILD EACH GET THEIR OWN TRANSPORT INSTANCE (`ingestTransport`/
 * `buildTransport`), never one shared between them. `buildModel()` runs manifold3d
 * WASM calls with no yield points once it is under way (`protocol.ts`'s own
 * docstring), so a worker running one is fully busy -- unresponsive to any
 * OTHER message posted to that same worker -- until it returns. Sharing one
 * worker between ingest and build therefore meant a click that should be
 * instant (a radius fix from the detail advisor, a pin move) could sit queued
 * behind a still-running, full-Chicago-scale build for however long that build
 * takes: measured exceeding 16 s in a real browser, entirely on the worker
 * message queue, before the ingest fetch even started. Two workers means the
 * OS genuinely runs them on separate threads, so a build in progress on the
 * build worker cannot delay a message posted to the ingest worker by even one
 * tick. `worker.ts`/`protocol.ts` needed no change: both already dispatch by
 * message kind, so a worker dedicated to one kind just never receives the
 * other.
 *
 * Cancellation of superseded jobs: calling `ingest()` (or `buildModel()`) again
 * while a previous call of the SAME kind is still in flight rejects the
 * PREVIOUS call's promise with `EngineClientError("cancelled", ...)` and
 * tells that job's transport to cancel it (meaningful for `ingest`'s network
 * fetch; a no-op for `build`, which cannot be preempted mid-flight -- see
 * `protocol.ts`). Callers should treat that rejection as "a newer request
 * took over", not as a failure to report.
 */

import { installWasmBasePathFetchShim } from "../basePath";
import type { PrintParams, SceneRequest } from "../contracts";
import { perfEnabled, perfMergeTimings, perfRecord, perfSpan } from "../perf";
import type { OverpassFetchError } from "./osm/overpass";
import type { EngineSceneGraph } from "./osm/types";
import { allocateJobId, cancelJob, runBuildJob, runIngestJob } from "./protocol";
import type { BuildWireInput, WorkerRequest, WorkerResponse } from "./protocol";
import type { EngineResult } from "./types";

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

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** What `EngineClient` needs from either transport. */
interface Transport {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  onMessage(handler: (message: WorkerResponse) => void): void;
  /** A transport-level failure (worker threw, worker crashed) -- never a build/ingest failure, which arrives as a normal response message. */
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
 * Runs `protocol.ts`'s job handlers directly on the calling thread, in the
 * exact message shapes a real worker would exchange -- so `EngineClient`'s
 * own logic (job ids, supersede, progress routing) is identical either way
 * and only the transport differs.
 */
class InlineTransport implements Transport {
  private handler: ((message: WorkerResponse) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;

  onMessage(handler: (message: WorkerResponse) => void): void {
    this.handler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  postMessage(message: WorkerRequest): void {
    const post = (response: WorkerResponse): void => {
      this.handler?.(response);
    };
    switch (message.kind) {
      case "cancel":
        cancelJob(message);
        return;
      case "ingest":
        runIngestJob(message, post).catch((error: unknown) => {
          this.errorHandler?.(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      case "build":
        // runBuildJob never rejects (it posts a build-error message instead);
        // the catch here is only a safety net for a genuinely unexpected throw.
        runBuildJob(message, post).catch((error: unknown) => {
          this.errorHandler?.(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      default: {
        const never: never = message;
        throw new Error(`engine client (inline transport): unknown message ${JSON.stringify(never)}`);
      }
    }
  }

  terminate(): void {
    // Nothing to tear down: no worker thread, no open handles.
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
// Client
// ---------------------------------------------------------------------------

interface PendingJob<T> {
  id: number;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/** The two transports `EngineClient` needs -- one per job kind, never shared. */
export interface EngineClientTransports {
  ingest?: Transport;
  build?: Transport;
}

export class EngineClient {
  private readonly ingestTransport: Transport;
  private readonly buildTransport: Transport;
  private readonly pendingIngest = new Map<number, PendingJob<IngestOutcome>>();
  private readonly pendingBuild = new Map<number, PendingJob<EngineResult>>();
  private readonly progress = new Map<number, (message: string) => void>();
  private currentIngestId: number | null = null;
  private currentBuildId: number | null = null;
  private disposed = false;

  constructor(transports: EngineClientTransports = {}) {
    this.ingestTransport = transports.ingest ?? createDefaultTransport();
    this.buildTransport = transports.build ?? createDefaultTransport();
    this.ingestTransport.onMessage((message) => this.handleMessage(message));
    this.ingestTransport.onError((error) => this.handleTransportError(error, "ingest"));
    this.buildTransport.onMessage((message) => this.handleMessage(message));
    this.buildTransport.onError((error) => this.handleTransportError(error, "build"));
  }

  /** `SceneRequest` -> `EngineSceneGraph`, off the main thread on its OWN worker, fails soft (network problems resolve `{ok:false,error}`; only a superseded/disposed call rejects). Never waits on a build, running or queued. */
  ingest(request: SceneRequest, params?: PrintParams, options: IngestOptions = {}): Promise<IngestOutcome> {
    if (this.disposed) return Promise.reject(new EngineClientError("disposed", "the engine client was disposed"));
    this.supersedeIngest();
    const id = allocateJobId();
    this.currentIngestId = id;
    if (options.onProgress) this.progress.set(id, options.onProgress);
    // The span covers the whole round trip as the CALLER experiences it: post,
    // worker work, structured clone back. `engine.ingest` inside the worker is
    // the same job without the two hops. Perf off: `perfSpan` is a boolean read.
    return perfSpan(
      "engine.ingest.client",
      () =>
        new Promise<IngestOutcome>((resolve, reject) => {
          this.pendingIngest.set(id, { id, resolve, reject });
          this.ingestTransport.postMessage({ kind: "ingest", id, request, params, perf: perfEnabled() });
        }),
    );
  }

  /** `EngineInput` (terrain included, phase 3) -> `EngineResult`, off the main thread on its OWN worker. */
  buildModel(input: BuildWireInput, options: BuildOptions = {}): Promise<EngineResult> {
    if (this.disposed) return Promise.reject(new EngineClientError("disposed", "the engine client was disposed"));
    this.supersedeBuild();
    const id = allocateJobId();
    this.currentBuildId = id;
    if (options.onProgress) this.progress.set(id, options.onProgress);
    return perfSpan(
      "engine.build.client",
      () =>
        new Promise<EngineResult>((resolve, reject) => {
          this.pendingBuild.set(id, { id, resolve, reject });
          this.buildTransport.postMessage({ kind: "build", id, input, perf: perfEnabled() });
        }),
    );
  }

  /** Tear the client down: terminate both workers (a no-op for the inline transport) and reject every job still in flight. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new EngineClientError("disposed", "the engine client was disposed");
    // Cancel before terminating: `terminate()` is a no-op on the inline
    // transport, where a queued build would otherwise run to completion for a
    // client that no longer exists (v3-02 finding 7). On a real worker the
    // terminate that follows makes these messages moot, and harmless.
    for (const job of this.pendingIngest.values()) this.ingestTransport.postMessage({ kind: "cancel", id: job.id, jobKind: "ingest" });
    for (const job of this.pendingBuild.values()) this.buildTransport.postMessage({ kind: "cancel", id: job.id, jobKind: "build" });
    for (const job of this.pendingIngest.values()) job.reject(error);
    for (const job of this.pendingBuild.values()) job.reject(error);
    this.pendingIngest.clear();
    this.pendingBuild.clear();
    this.progress.clear();
    this.ingestTransport.terminate();
    this.buildTransport.terminate();
  }

  private supersedeIngest(): void {
    const previousId = this.currentIngestId;
    if (previousId === null) return;
    const job = this.pendingIngest.get(previousId);
    if (!job) return;
    this.pendingIngest.delete(previousId);
    this.progress.delete(previousId);
    this.ingestTransport.postMessage({ kind: "cancel", id: previousId, jobKind: "ingest" });
    job.reject(new EngineClientError("cancelled", "a newer ingest request superseded this one"));
  }

  private supersedeBuild(): void {
    const previousId = this.currentBuildId;
    if (previousId === null) return;
    const job = this.pendingBuild.get(previousId);
    if (!job) return;
    this.pendingBuild.delete(previousId);
    this.progress.delete(previousId);
    // A build cannot be preempted mid-flight (protocol.ts); this still tells
    // the transport, so the worker-side map stays tidy, but what actually
    // protects the caller is dropping the pending promise right here.
    this.buildTransport.postMessage({ kind: "cancel", id: previousId, jobKind: "build" });
    job.reject(new EngineClientError("cancelled", "a newer build request superseded this one"));
  }

  /**
   * Fold a worker's own marks into the page's perf report, and measure the
   * hop itself.
   *
   * `engine.post` is stamped by `worker.ts` immediately before `postMessage`,
   * so the difference between its `epochMs` and the moment this handler runs
   * IS the structured-clone/transfer cost of the result -- which for a build is
   * a pile of `Float64Array` region buffers and the one number no in-worker
   * measurement can see. `perfMergeTimings` rebases the rest onto the page
   * clock (a worker's time origin is its own creation, not the document's).
   */
  private absorbTimings(message: WorkerResponse): void {
    if (!perfEnabled()) return;
    const timings = "timings" in message ? message.timings : undefined;
    if (timings === undefined || timings.length === 0) return;
    const receivedEpochMs = performance.timeOrigin + performance.now();
    const posted = timings.find((timing) => timing.name === "engine.post");
    perfMergeTimings(timings);
    if (posted !== undefined) {
      const durationMs = Math.max(0, receivedEpochMs - posted.epochMs);
      perfRecord("engine.transfer", performance.now() - durationMs, durationMs);
    }
  }

  private handleMessage(message: WorkerResponse): void {
    this.absorbTimings(message);
    switch (message.kind) {
      case "ingest-progress":
      case "build-progress":
        this.progress.get(message.id)?.(message.message);
        return;
      case "ingest-done": {
        const job = this.pendingIngest.get(message.id);
        if (!job) return; // superseded or unknown: drop
        this.pendingIngest.delete(message.id);
        this.progress.delete(message.id);
        if (this.currentIngestId === message.id) this.currentIngestId = null;
        job.resolve(
          message.ok
            ? { ok: true, scene: message.scene, fromCache: message.fromCache }
            : { ok: false, error: message.error },
        );
        return;
      }
      case "build-done": {
        const job = this.pendingBuild.get(message.id);
        if (!job) return;
        this.pendingBuild.delete(message.id);
        this.progress.delete(message.id);
        if (this.currentBuildId === message.id) this.currentBuildId = null;
        job.resolve(message.result);
        return;
      }
      case "build-error": {
        const job = this.pendingBuild.get(message.id);
        if (!job) return;
        this.pendingBuild.delete(message.id);
        this.progress.delete(message.id);
        if (this.currentBuildId === message.id) this.currentBuildId = null;
        job.reject(new Error(message.message));
        return;
      }
      default: {
        const never: never = message;
        throw new Error(`engine client: unknown response ${JSON.stringify(never)}`);
      }
    }
  }

  /**
   * A transport-level failure now only rejects the jobs of the SCOPE it
   * belongs to: the ingest worker crashing does not have to mean a build in
   * flight on the completely separate build worker is dead too, and vice
   * versa.
   */
  private handleTransportError(error: Error, scope: "ingest" | "build"): void {
    const wrapped = new EngineClientError("transport", error.message);
    if (scope === "ingest") {
      for (const job of this.pendingIngest.values()) {
        job.reject(wrapped);
        this.progress.delete(job.id);
      }
      this.pendingIngest.clear();
      this.currentIngestId = null;
    } else {
      for (const job of this.pendingBuild.values()) {
        job.reject(wrapped);
        this.progress.delete(job.id);
      }
      this.pendingBuild.clear();
      this.currentBuildId = null;
    }
  }
}

export function createEngineClient(): EngineClient {
  return new EngineClient();
}

/** Exposed for tests that want to construct an `EngineClient` over a fake `Worker` without a real worker thread. */
export function createWorkerTransportForTest(worker: WorkerLike): Transport {
  return new WorkerTransport(worker);
}
