/**
 * `PipelineSession`'s single flight: latest request wins, a superseded job
 * stops at its next stage boundary and keeps what it completed (DECISIONS
 * [V3.1-P1-1], rulings 7 and 10).
 *
 * This file is the one place that drives the session with more than one job
 * at a time and reads the raw messages it posts, which is the only way to see
 * the coalescing: which ids post anything at all, where a job was cancelled,
 * and which stages the successor served from the cache.
 */
import { describe, expect, it, vi } from "vitest";

import { defaultPrintParams } from "../contracts";
import { blockScene } from "./pipeline/testScenes";
import { PipelineSession, type Post, type RunJobMessage, type WorkerResponse } from "./protocol";

function job(id: number, text = "{city}"): RunJobMessage {
  const params = defaultPrintParams();
  params.engravings = [{ edge: "top", text, mode: "engrave", size_mm: 4 }];
  return {
    kind: "run",
    id,
    source: { kind: "scene", scene: blockScene(), key: "block" },
    params,
    terrain: null,
    heroIds: null,
    date: "2026-09-02",
    rotationDeg: 0,
    mode: "full",
    known: {},
    knownSceneHash: null,
  };
}

function kindsFor(posted: readonly WorkerResponse[], id: number): string[] {
  return posted.filter((m) => m.id === id).map((m) => m.kind);
}

function stageStates(posted: readonly WorkerResponse[], id: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of posted) {
    if (m.id === id && m.kind === "stage" && m.state !== "start") out.push([m.stage, m.state]);
  }
  return out;
}

/** Wait until job `id` has reported `stage` as done, so a superseding request lands mid-job rather than before it began. */
async function progressed(posted: readonly WorkerResponse[], id: number, stage: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(posted.some((m) => m.id === id && m.kind === "stage" && m.stage === stage && m.state === "done")).toBe(true);
    },
    { timeout: 60_000, interval: 5 },
  );
}

async function settled(posted: readonly WorkerResponse[], id: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(posted.some((m) => m.id === id && (m.kind === "done" || m.kind === "cancelled" || m.kind === "error"))).toBe(true);
    },
    { timeout: 60_000, interval: 20 },
  );
}

describe("PipelineSession: single flight, latest wins, stage-boundary cancellation", () => {
  it("three runs fired together: the first stops at a stage boundary, the second never starts, the third reuses what the first finished", async () => {
    const session = new PipelineSession();
    const posted: WorkerResponse[] = [];
    const post: Post = (message) => {
      posted.push(message);
    };
    try {
      session.handle(job(1), post);
      // Let job 1 get some way in (the buildings repaired) before the burst
      // arrives, so there is something for job 3 to reuse.
      await progressed(posted, 1, "repair-buildings");
      session.handle(job(2), post);
      session.handle(job(3), post);
      await settled(posted, 3);

      // Job 1 was under way when 2 arrived: it stopped at the next boundary.
      expect(kindsFor(posted, 1)).toContain("cancelled");
      expect(kindsFor(posted, 1)).not.toContain("done");
      // Job 2 was overwritten in the single queued slot before it started.
      expect(kindsFor(posted, 2)).toEqual([]);
      // Job 3 ran to completion.
      expect(kindsFor(posted, 3)).toContain("done");
      const cancelledAt = posted.find((m) => m.id === 1 && m.kind === "cancelled");
      expect(cancelledAt?.kind === "cancelled" ? cancelledAt.atStage : null).not.toBeNull();
      // Every stage job 1 completed before stopping was served to job 3 from
      // the cache, in the same order, and nothing job 1 did not finish was.
      const finished = stageStates(posted, 1).filter(([, state]) => state === "done" || state === "cached").map(([stage]) => stage);
      const reused = stageStates(posted, 3).filter(([, state]) => state === "cached").map(([stage]) => stage);
      expect(finished.length).toBeGreaterThan(0);
      expect(reused).toEqual(finished);
      // The result reached the page with the regions streamed and stripped.
      const done = posted.find((m) => m.id === 3 && m.kind === "done");
      expect(done?.kind === "done" && done.result?.regions.every((r) => r.positions.length === 0)).toBe(true);
      expect(posted.some((m) => m.id === 3 && m.kind === "region-ready")).toBe(true);
    } finally {
      session.dispose();
    }
  }, 120_000);

  it("a queued job cancelled before it starts never posts; cancelling the running one stops it at the next boundary and keeps its outputs", async () => {
    const session = new PipelineSession();
    const posted: WorkerResponse[] = [];
    const post: Post = (message) => {
      posted.push(message);
    };
    try {
      session.handle(job(1), post);
      await progressed(posted, 1, "repair-buildings");
      session.handle(job(2), post); // queued behind job 1, which is now aborting
      session.handle({ kind: "cancel", id: 2 }, post);
      await settled(posted, 1);
      expect(kindsFor(posted, 1)).toContain("cancelled");
      expect(kindsFor(posted, 2)).toEqual([]);
      const completedByOne = stageStates(posted, 1).filter(([, state]) => state === "done").map(([stage]) => stage);
      expect(completedByOne.length).toBeGreaterThan(0);

      // A fresh identical request afterwards: every stage job 1 completed is
      // served cached, the rest run, and it finishes.
      session.handle(job(3), post);
      await settled(posted, 3);
      expect(kindsFor(posted, 3)).toContain("done");
      const cachedForThree = stageStates(posted, 3).filter(([, state]) => state === "cached").map(([stage]) => stage);
      for (const stage of completedByOne) expect(cachedForThree).toContain(stage);
    } finally {
      session.dispose();
    }
  }, 120_000);

  it("runs requested one after another all complete; the second identical run is served entirely from the cache", async () => {
    const session = new PipelineSession();
    const posted: WorkerResponse[] = [];
    const post: Post = (message) => {
      posted.push(message);
    };
    try {
      session.handle(job(1), post);
      await settled(posted, 1);
      session.handle(job(2), post);
      await settled(posted, 2);
      session.handle(job(3, "{coords}"), post);
      await settled(posted, 3);
      expect(kindsFor(posted, 1)).toContain("done");
      expect(kindsFor(posted, 2)).toContain("done");
      expect(kindsFor(posted, 3)).toContain("done");
      // Identical params: nothing ran, nothing was re-sent.
      const second = stageStates(posted, 2);
      expect(second.every(([stage, state]) => state === "cached" || (stage === "fetch" && state === "skipped"))).toBe(true);
      expect(posted.some((m) => m.id === 2 && m.kind === "region-ready")).toBe(true); // `known` was empty, so the regions were posted again
      // A text change: lettering re-ran, the buildings did not.
      const third = new Map(stageStates(posted, 3));
      expect(third.get("lettering")).toBe("done");
      expect(third.get("buildings")).toBe("cached");
      expect(third.get("repair-buildings")).toBe("cached");
    } finally {
      session.dispose();
    }
  }, 120_000);
});
