/**
 * The engine Web Worker: the real off-main-thread half of `lib/engine/
 * protocol.ts`'s job handlers. `client.ts` is the only thing that constructs
 * this (`new Worker(new URL("./worker.ts", import.meta.url), {type:
 * "module"})`); nothing else imports it.
 *
 * Deliberately thin: every byte of actual logic (ingest, bake, cancellation)
 * lives in `protocol.ts` so the in-page fallback transport runs identically.
 * This file's only job is wiring `self.onmessage`/`self.postMessage` to it.
 *
 * No `lib: ["webworker"]` in `tsconfig.json` (it would collide with the
 * `dom` lib the rest of the app needs for `window`/`document`), so `self` is
 * cast through a minimal local interface rather than relying on the
 * ambient `WorkerGlobalScope` type. The cast is a compile-time-only
 * narrowing: at runtime `self` really is the worker's global scope.
 */

import { installWasmBasePathFetchShim } from "../basePath";
import { perfDrainTimings, perfEnabled, perfMark, setPerfEnabled } from "../perf";
import { cancelJob, runBakeJob, runIngestJob, type Post, type WorkerRequest, type WorkerResponse } from "./protocol";

// Under a sub-path deployment (NEXT_PUBLIC_BASE_PATH set) the manifold WASM
// fetch needs its prefix; installed before any job can run. No-op otherwise.
installWasmBasePathFetchShim();

interface WorkerSelf {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}

const ctx = self as unknown as WorkerSelf;

/**
 * Perf mode (`lib/perf.ts`): a worker cannot read `?perf=1` or `localStorage`,
 * so the page's flag arrives on the job message and the terminal response
 * carries this realm's marks back on `timings`. `engine.post` is stamped
 * immediately before `postMessage`, which is what lets `client.ts` measure the
 * structured-clone hop itself. With perf off, both branches below are one
 * boolean read and the wire is byte-identical to what it was before.
 */
const post: Post = (message, transfer) => {
  if (
    perfEnabled() &&
    (message.kind === "ingest-done" || message.kind === "bake-done" || message.kind === "bake-error")
  ) {
    perfMark("engine.post");
    message.timings = perfDrainTimings();
  }
  ctx.postMessage(message, transfer);
};

ctx.onmessage = (event) => {
  const msg = event.data;
  switch (msg.kind) {
    case "cancel":
      cancelJob(msg);
      return;
    case "ingest":
      setPerfEnabled(msg.perf === true);
      void runIngestJob(msg, post);
      return;
    case "bake":
      setPerfEnabled(msg.perf === true);
      void runBakeJob(msg, post);
      return;
    default: {
      const never: never = msg;
      throw new Error(`engine worker: unknown message ${JSON.stringify(never)}`);
    }
  }
};
