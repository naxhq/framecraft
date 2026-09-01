/**
 * `runBakeJob`'s single-flight coalescing (DECISIONS.md [V3-P2-E4]).
 *
 * `runIngestJob`/`cancelJob`/the Overpass cache are covered by
 * `osm/overpass.test.ts` and `osm/scene.test.ts`; the worker/client wiring
 * around this module is covered by `client.test.ts`. This file is the one
 * place that actually calls `bake()` through `runBakeJob` more than once
 * concurrently, which is the only way to exercise the queue.
 */
import { describe, expect, it, vi } from "vitest";

import { defaultPrintParams } from "../contracts";
import { building, scene, square } from "./solid/fixture";
import { cancelJob, resetBakeQueueForTest, runBakeJob, type BakeJobMessage, type Post } from "./protocol";
import type { WorkerResponse } from "./protocol";

function job(id: number): BakeJobMessage {
  return {
    kind: "bake",
    id,
    input: {
      scene: scene({ radiusM: 200, buildings: [building("w1", square(0, 0, 40), 30)] }),
      params: defaultPrintParams(),
      date: "2026-08-30",
    },
  };
}

describe("runBakeJob: single-flight, latest-wins", () => {
  it("a bake requested while one is already running is coalesced, not queued in full: the id in between never posts anything", async () => {
    resetBakeQueueForTest();
    const posted: WorkerResponse[] = [];
    const post: Post = (message) => posted.push(message);

    // All three fire before any of them has a chance to await anything, the
    // same way three debounced `EngineClient.bake()` calls arriving while the
    // worker is still busy with an earlier one would.
    const first = runBakeJob(job(1), post);
    const second = runBakeJob(job(2), post);
    const third = runBakeJob(job(3), post);

    await first; // job 1 ran to completion: it was already in flight.
    await second; // job 2 only ever got queued, so this resolves immediately.
    // job 3 is chained from job 1's `finally`, fire-and-forget: wait for it
    // to actually post its own result rather than for `third`'s own promise,
    // which already resolved the instant job 3 was recorded as queued.
    await third;
    await vi.waitFor(
      () => {
        expect(posted.some((m) => m.kind === "bake-done" && m.id === 3)).toBe(true);
      },
      { timeout: 20_000 },
    );

    const ids = posted.map((m) => m.id);
    expect(ids).toContain(1);
    expect(ids).toContain(3);
    // Job 2 was superseded before the worker ever started it: no
    // `bake-progress`, no `bake-done`, no `bake-error` for it, ever -- the
    // whole point of coalescing is that running it would have been wasted
    // worker time nothing was waiting for.
    expect(ids).not.toContain(2);

    const kindsFor = (id: number) => posted.filter((m) => m.id === id).map((m) => m.kind);
    expect(kindsFor(1)).toEqual(["bake-progress", "bake-done"]);
    expect(kindsFor(3)).toEqual(["bake-progress", "bake-done"]);
  });

  it("a bake cancelled while it is still queued never starts, and cancelling the running one does not stop it", async () => {
    resetBakeQueueForTest();
    const posted: WorkerResponse[] = [];
    const post: Post = (message) => posted.push(message);

    const first = runBakeJob(job(1), post);
    const second = runBakeJob(job(2), post); // queued behind job 1

    // The client rejected job 2's promise (an unmount, or a dispose on the
    // inline transport where terminate() is a no-op) and posted a cancel. Job
    // 2 has not started, so it must never start (v3-02 finding 7).
    cancelJob({ kind: "cancel", id: 2, jobKind: "bake" });
    // Job 1 is already inside the kernel and cannot be preempted: cancelling
    // it stays the documented no-op it has always been.
    cancelJob({ kind: "cancel", id: 1, jobKind: "bake" });

    await first;
    await second;

    // `runBakeJob` posts `bake-progress` synchronously before its first await,
    // so if job 2 had been started from job 1's `finally` it would already be
    // here.
    expect(posted.map((m) => m.id)).not.toContain(2);
    expect(posted.filter((m) => m.kind === "bake-done").map((m) => m.id)).toEqual([1]);
  });

  it("bakes requested one after another, each awaited, all run: coalescing never drops a request nothing superseded it", async () => {
    resetBakeQueueForTest();
    const posted: WorkerResponse[] = [];
    const post: Post = (message) => posted.push(message);

    await runBakeJob(job(1), post);
    await runBakeJob(job(2), post);
    await runBakeJob(job(3), post);

    const ids = posted.filter((m) => m.kind === "bake-done").map((m) => m.id);
    expect(ids).toEqual([1, 2, 3]);
  });
});
