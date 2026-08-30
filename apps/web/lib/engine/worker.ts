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

import { cancelJob, runBakeJob, runIngestJob, type Post, type WorkerRequest, type WorkerResponse } from "./protocol";

interface WorkerSelf {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}

const ctx = self as unknown as WorkerSelf;

const post: Post = (message, transfer) => {
  ctx.postMessage(message, transfer);
};

ctx.onmessage = (event) => {
  const msg = event.data;
  switch (msg.kind) {
    case "cancel":
      cancelJob(msg);
      return;
    case "ingest":
      void runIngestJob(msg, post);
      return;
    case "bake":
      void runBakeJob(msg, post);
      return;
    default: {
      const never: never = msg;
      throw new Error(`engine worker: unknown message ${JSON.stringify(never)}`);
    }
  }
};
