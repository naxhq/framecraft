/**
 * The typed, cancellation-aware wrapper around the engine workers.
 *
 * `EngineClient` is the ONLY thing the app talks to for ingest (`buildScene`)
 * and bake (`bake()`): `store/editor.ts` never imports `worker.ts` or
 * `protocol.ts` directly. Two KINDS of transport share one protocol
 * (`lib/engine/protocol.ts`):
 *
 *  - `WorkerTransport`, a real `Worker` -- what the browser uses;
 *  - `InlineTransport`, which runs the very same job handlers on the calling
 *    thread -- what every environment without `Worker` uses (vitest, SSR,
 *    `next build`'s prerender pass, a browser that refused worker creation).
 *
 * INGEST AND BAKE EACH GET THEIR OWN TRANSPORT INSTANCE (`ingestTransport`/
 * `bakeTransport`), never one shared between them. `bake()` runs manifold3d
 * WASM calls with no yield points once it is under way (`protocol.ts`'s own
 * docstring), so a worker running one is fully busy -- unresponsive to any
 * OTHER message posted to that same worker -- until it returns. Sharing one
 * worker between ingest and bake therefore meant a click that should be
 * instant (a radius fix from the detail advisor, a pin move) could sit queued
 * behind a still-running, full-Chicago-scale bake for however long that bake
 * takes: measured exceeding 16 s in a real browser, entirely on the worker
 * message queue, before the ingest fetch even started. Two workers means the
 * OS genuinely runs them on separate threads, so a bake in progress on the
 * bake worker cannot delay a message posted to the ingest worker by even one
 * tick. `worker.ts`/`protocol.ts` needed no change: both already dispatch by
 * message kind, so a worker dedicated to one kind just never receives the
 * other.
 *
 * Cancellation of superseded jobs: calling `ingest()` (or `bake()`) again
 * while a previous call of the SAME kind is still in flight rejects the
 * PREVIOUS call's promise with `EngineClientError("cancelled", ...)` and
 * tells that job's transport to cancel it (meaningful for `ingest`'s network
 * fetch; a no-op for `bake`, which cannot be preempted mid-flight -- see
 * `protocol.ts`). Callers should treat that rejection as "a newer request
 * took over", not as a failure to report.
 */

import type { PrintParams, SceneRequest } from "../contracts";
import type { OverpassFetchError } from "./osm/overpass";
import type { EngineSceneGraph } from "./osm/types";
import { allocateJobId, cancelJob, runBakeJob, runIngestJob } from "./protocol";
import type { BakeWireInput, WorkerRequest, WorkerResponse } from "./protocol";
import type { EngineResult } from "./types";

export type IngestOutcome =
  | { ok: true; scene: EngineSceneGraph; fromCache: boolean }
  | { ok: false; error: OverpassFetchError };

export interface IngestOptions {
  onProgress?: (message: string) => void;
}

export interface BakeOptions {
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
  /** A transport-level failure (worker threw, worker crashed) -- never a bake/ingest failure, which arrives as a normal response message. */
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
      case "bake":
        // runBakeJob never rejects (it posts a bake-error message instead);
        // the catch here is only a safety net for a genuinely unexpected throw.
        runBakeJob(message, post).catch((error: unknown) => {
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
  if (typeof Worker === "undefined") return new InlineTransport();
  try {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    return new WorkerTransport(worker);
  } catch {
    // Worker creation itself can throw (e.g. a restrictive CSP, or a test
    // environment that stubs `Worker` as a constructor that always fails):
    // fail soft into the same fallback the "no Worker at all" branch uses.
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
  bake?: Transport;
}

export class EngineClient {
  private readonly ingestTransport: Transport;
  private readonly bakeTransport: Transport;
  private readonly pendingIngest = new Map<number, PendingJob<IngestOutcome>>();
  private readonly pendingBake = new Map<number, PendingJob<EngineResult>>();
  private readonly progress = new Map<number, (message: string) => void>();
  private currentIngestId: number | null = null;
  private currentBakeId: number | null = null;
  private disposed = false;

  constructor(transports: EngineClientTransports = {}) {
    this.ingestTransport = transports.ingest ?? createDefaultTransport();
    this.bakeTransport = transports.bake ?? createDefaultTransport();
    this.ingestTransport.onMessage((message) => this.handleMessage(message));
    this.ingestTransport.onError((error) => this.handleTransportError(error, "ingest"));
    this.bakeTransport.onMessage((message) => this.handleMessage(message));
    this.bakeTransport.onError((error) => this.handleTransportError(error, "bake"));
  }

  /** `SceneRequest` -> `EngineSceneGraph`, off the main thread on its OWN worker, fails soft (network problems resolve `{ok:false,error}`; only a superseded/disposed call rejects). Never waits on a bake, running or queued. */
  ingest(request: SceneRequest, params?: PrintParams, options: IngestOptions = {}): Promise<IngestOutcome> {
    if (this.disposed) return Promise.reject(new EngineClientError("disposed", "the engine client was disposed"));
    this.supersedeIngest();
    const id = allocateJobId();
    this.currentIngestId = id;
    if (options.onProgress) this.progress.set(id, options.onProgress);
    return new Promise<IngestOutcome>((resolve, reject) => {
      this.pendingIngest.set(id, { id, resolve, reject });
      this.ingestTransport.postMessage({ kind: "ingest", id, request, params });
    });
  }

  /** `EngineInput` (terrain included, phase 3) -> `EngineResult`, off the main thread on its OWN worker. */
  bake(input: BakeWireInput, options: BakeOptions = {}): Promise<EngineResult> {
    if (this.disposed) return Promise.reject(new EngineClientError("disposed", "the engine client was disposed"));
    this.supersedeBake();
    const id = allocateJobId();
    this.currentBakeId = id;
    if (options.onProgress) this.progress.set(id, options.onProgress);
    return new Promise<EngineResult>((resolve, reject) => {
      this.pendingBake.set(id, { id, resolve, reject });
      this.bakeTransport.postMessage({ kind: "bake", id, input });
    });
  }

  /** Tear the client down: terminate both workers (a no-op for the inline transport) and reject every job still in flight. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new EngineClientError("disposed", "the engine client was disposed");
    // Cancel before terminating: `terminate()` is a no-op on the inline
    // transport, where a queued bake would otherwise run to completion for a
    // client that no longer exists (v3-02 finding 7). On a real worker the
    // terminate that follows makes these messages moot, and harmless.
    for (const job of this.pendingIngest.values()) this.ingestTransport.postMessage({ kind: "cancel", id: job.id, jobKind: "ingest" });
    for (const job of this.pendingBake.values()) this.bakeTransport.postMessage({ kind: "cancel", id: job.id, jobKind: "bake" });
    for (const job of this.pendingIngest.values()) job.reject(error);
    for (const job of this.pendingBake.values()) job.reject(error);
    this.pendingIngest.clear();
    this.pendingBake.clear();
    this.progress.clear();
    this.ingestTransport.terminate();
    this.bakeTransport.terminate();
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

  private supersedeBake(): void {
    const previousId = this.currentBakeId;
    if (previousId === null) return;
    const job = this.pendingBake.get(previousId);
    if (!job) return;
    this.pendingBake.delete(previousId);
    this.progress.delete(previousId);
    // A bake cannot be preempted mid-flight (protocol.ts); this still tells
    // the transport, so the worker-side map stays tidy, but what actually
    // protects the caller is dropping the pending promise right here.
    this.bakeTransport.postMessage({ kind: "cancel", id: previousId, jobKind: "bake" });
    job.reject(new EngineClientError("cancelled", "a newer bake request superseded this one"));
  }

  private handleMessage(message: WorkerResponse): void {
    switch (message.kind) {
      case "ingest-progress":
      case "bake-progress":
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
      case "bake-done": {
        const job = this.pendingBake.get(message.id);
        if (!job) return;
        this.pendingBake.delete(message.id);
        this.progress.delete(message.id);
        if (this.currentBakeId === message.id) this.currentBakeId = null;
        job.resolve(message.result);
        return;
      }
      case "bake-error": {
        const job = this.pendingBake.get(message.id);
        if (!job) return;
        this.pendingBake.delete(message.id);
        this.progress.delete(message.id);
        if (this.currentBakeId === message.id) this.currentBakeId = null;
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
   * belongs to: the ingest worker crashing does not have to mean a bake in
   * flight on the completely separate bake worker is dead too, and vice
   * versa.
   */
  private handleTransportError(error: Error, scope: "ingest" | "bake"): void {
    const wrapped = new EngineClientError("transport", error.message);
    if (scope === "ingest") {
      for (const job of this.pendingIngest.values()) {
        job.reject(wrapped);
        this.progress.delete(job.id);
      }
      this.pendingIngest.clear();
      this.currentIngestId = null;
    } else {
      for (const job of this.pendingBake.values()) {
        job.reject(wrapped);
        this.progress.delete(job.id);
      }
      this.pendingBake.clear();
      this.currentBakeId = null;
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
