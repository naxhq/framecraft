/**
 * `runBuildJob`'s single-flight coalescing (DECISIONS.md [V3-P2-E4]).
 *
 * `runIngestJob`/`cancelJob`/the Overpass cache are covered by
 * `osm/overpass.test.ts` and `osm/scene.test.ts`; the worker/client wiring
 * around this module is covered by `client.test.ts`. This file is the one
 * place that actually calls `buildModel()` through `runBuildJob` more than once
 * concurrently, which is the only way to exercise the queue.
 */
import { describe, expect, it, vi } from "vitest";

import { defaultPrintParams } from "../contracts";
import { building, scene, square } from "./solid/fixture";
import { cancelJob, resetBuildQueueForTest, runBuildJob, type BuildJobMessage, type Post } from "./protocol";
import type { WorkerResponse } from "./protocol";

function job(id: number): BuildJobMessage {
  return {
    kind: "build",
    id,
    input: {
      scene: scene({ radiusM: 200, buildings: [building("w1", square(0, 0, 40), 30)] }),
      params: defaultPrintParams(),
      date: "2026-08-30",
    },
  };
}

describe("runBuildJob: single-flight, latest-wins", () => {
  it("a build requested while one is already running is coalesced, not queued in full: the id in between never posts anything", async () => {
    resetBuildQueueForTest();
    const posted: WorkerResponse[] = [];
    const post: Post = (message) => posted.push(message);

    // All three fire before any of them has a chance to await anything, the
    // same way three debounced `EngineClient.buildModel()` calls arriving while the
    // worker is still busy with an earlier one would.
    const first = runBuildJob(job(1), post);
    const second = runBuildJob(job(2), post);
    const third = runBuildJob(job(3), post);

    await first; // job 1 ran to completion: it was already in flight.
    await second; // job 2 only ever got queued, so this resolves immediately.
    // job 3 is chained from job 1's `finally`, fire-and-forget: wait for it
    // to actually post its own result rather than for `third`'s own promise,
    // which already resolved the instant job 3 was recorded as queued.
    await third;
    await vi.waitFor(
      () => {
        expect(posted.some((m) => m.kind === "build-done" && m.id === 3)).toBe(true);
      },
      { timeout: 20_000 },
    );

    const ids = posted.map((m) => m.id);
    expect(ids).toContain(1);
    expect(ids).toContain(3);
    // Job 2 was superseded before the worker ever started it: no
    // `build-progress`, no `build-done`, no `build-error` for it, ever -- the
    // whole point of coalescing is that running it would have been wasted
    // worker time nothing was waiting for.
    expect(ids).not.toContain(2);

    const kindsFor = (id: number) => posted.filter((m) => m.id === id).map((m) => m.kind);
    expect(kindsFor(1)).toEqual(["build-progress", "build-done"]);
    expect(kindsFor(3)).toEqual(["build-progress", "build-done"]);
  });

  it("a build cancelled while it is still queued never starts, and cancelling the running one does not stop it", async () => {
    resetBuildQueueForTest();
    const posted: WorkerResponse[] = [];
    const post: Post = (message) => posted.push(message);

    const first = runBuildJob(job(1), post);
    const second = runBuildJob(job(2), post); // queued behind job 1

    // The client rejected job 2's promise (an unmount, or a dispose on the
    // inline transport where terminate() is a no-op) and posted a cancel. Job
    // 2 has not started, so it must never start (v3-02 finding 7).
    cancelJob({ kind: "cancel", id: 2, jobKind: "build" });
    // Job 1 is already inside the kernel and cannot be preempted: cancelling
    // it stays the documented no-op it has always been.
    cancelJob({ kind: "cancel", id: 1, jobKind: "build" });

    await first;
    await second;

    // `runBuildJob` posts `build-progress` synchronously before its first await,
    // so if job 2 had been started from job 1's `finally` it would already be
    // here.
    expect(posted.map((m) => m.id)).not.toContain(2);
    expect(posted.filter((m) => m.kind === "build-done").map((m) => m.id)).toEqual([1]);
  });

  it("builds requested one after another, each awaited, all run: coalescing never drops a request nothing superseded it", async () => {
    resetBuildQueueForTest();
    const posted: WorkerResponse[] = [];
    const post: Post = (message) => posted.push(message);

    await runBuildJob(job(1), post);
    await runBuildJob(job(2), post);
    await runBuildJob(job(3), post);

    const ids = posted.filter((m) => m.kind === "build-done").map((m) => m.id);
    expect(ids).toEqual([1, 2, 3]);
  });
});
