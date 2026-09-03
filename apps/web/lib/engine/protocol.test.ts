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
import { perfDrainTimings, perfReset, setPerfEnabled } from "../perf";
import type { FinishOut } from "./pipeline/stage";
import { blockScene } from "./pipeline/testScenes";
import { PipelineSession, perfStampedPost, type Post, type RunJobMessage, type WorkerResponse } from "./protocol";

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

describe("PipelineSession: exports (audit finding 3)", () => {
  it("an export requested while a run is in flight waits for it: the run's done is posted, then the files, and the export posts no regions and no merged mesh", async () => {
    const session = new PipelineSession();
    const posted: Array<{ message: WorkerResponse; transfer: Transferable[] }> = [];
    const post: Post = (message, transfer) => {
      posted.push({ message, transfer: transfer ?? [] });
    };
    try {
      session.handle(job(1), post);
      // `posted` grows as the session posts; poll the live array, not a copy.
      await vi.waitFor(
        () => {
          expect(posted.some((p) => p.message.id === 1 && p.message.kind === "stage" && p.message.stage === "repair-buildings" && p.message.state === "done")).toBe(true);
        },
        { timeout: 60_000, interval: 5 },
      );
      session.handle({ kind: "export", id: 2, request: { target: "stl", stem: "block", createdIso: "2026-09-02T00:00:00Z" } }, post);
      await vi.waitFor(
        () => {
          expect(posted.some((p) => p.message.id === 2 && (p.message.kind === "files" || p.message.kind === "error" || p.message.kind === "cancelled"))).toBe(true);
        },
        { timeout: 60_000, interval: 20 },
      );
      const messages = posted.map((p) => p.message);
      // The run finished on its own terms.
      expect(kindsFor(messages, 1)).toContain("done");
      expect(kindsFor(messages, 1)).not.toContain("cancelled");
      const runDone = messages.findIndex((m) => m.id === 1 && m.kind === "done");
      const filesAt = messages.findIndex((m) => m.id === 2 && m.kind === "files");
      expect(filesAt).toBeGreaterThan(runDone);
      // The export posted files only: no regions, a done with no result.
      expect(kindsFor(messages, 2)).not.toContain("region-ready");
      const exportDone = messages.find((m) => m.id === 2 && m.kind === "done");
      expect(exportDone?.kind === "done" ? exportDone.result : "missing").toBeNull();
      // The file bytes went out transferred, and the cache still holds its own copy.
      const files = posted.find((p) => p.message.id === 2 && p.message.kind === "files");
      expect(files).toBeDefined();
      const output = files?.message.kind === "files" ? files.message.output : null;
      expect(output?.files.map((file) => file.name)).toEqual(["block.stl"]);
      for (const file of output?.files ?? []) expect(files?.transfer).toContain(file.bytes.buffer);
      expect(session.cache.get("export")?.output).toBeDefined();
    } finally {
      session.dispose();
    }
  }, 120_000);

  it("an export before any model was built is refused, and an ingest alone does not count as a model", async () => {
    const session = new PipelineSession();
    const posted: WorkerResponse[] = [];
    try {
      session.handle({ ...job(1), mode: "scene" }, (message) => {
        posted.push(message);
      });
      await settled(posted, 1);
      session.handle({ kind: "export", id: 2, request: { target: "stl", createdIso: "2026-09-02T00:00:00Z" } }, (message) => {
        posted.push(message);
      });
      await settled(posted, 2);
      const error = posted.find((m) => m.id === 2 && m.kind === "error");
      expect(error?.kind === "error" ? error.message : "").toContain("nothing to export");
    } finally {
      session.dispose();
    }
  }, 60_000);
});

describe("perf mode: a run's own engine.build row is on the message that ends it", () => {
  it("done carries this run's engine.build timing, for the first run of a session and for the last", async () => {
    setPerfEnabled(true);
    perfReset();
    const session = new PipelineSession();
    const posted: WorkerResponse[] = [];
    const post = perfStampedPost((message) => {
      posted.push(message);
    });
    try {
      session.handle({ ...job(1), perf: true }, post);
      await settled(posted, 1);
      const first = posted.find((m) => m.id === 1 && m.kind === "done");
      const firstBuild = first?.timings?.filter((timing) => timing.name === "engine.build") ?? [];
      expect(firstBuild, "the first run's done names its own engine.build").toHaveLength(1);
      expect(firstBuild[0]?.durationMs ?? 0).toBeGreaterThan(0);
      // Nothing of the run is left behind for the next message to carry.
      expect(perfDrainTimings().map((timing) => timing.name)).not.toContain("engine.build");

      session.handle({ ...job(2, "{coords}"), perf: true }, post);
      await settled(posted, 2);
      const last = posted.find((m) => m.id === 2 && m.kind === "done");
      const lastBuild = last?.timings?.filter((timing) => timing.name === "engine.build") ?? [];
      expect(lastBuild, "the last run's done names its own engine.build").toHaveLength(1);
      expect(lastBuild[0]?.durationMs ?? 0).toBeGreaterThan(0);
      // The stage spans ride with it, nested under the build.
      expect(last?.timings?.some((timing) => timing.name === "lettering" && timing.parent === "engine.build")).toBe(true);
      expect(last?.timings?.some((timing) => timing.name === "engine.post")).toBe(true);
      // Only the terminal message carries timings.
      for (const message of posted) if (message.kind !== "done") expect(message.timings).toBeUndefined();
    } finally {
      session.dispose();
      setPerfEnabled(false);
      perfReset();
    }
  }, 60_000);
});

describe("region-ready carries the building identity", () => {
  it("the buildings region's triangleOwner buffer is in the transfer list beside its positions and indices, and the cache keeps its own copy", async () => {
    const session = new PipelineSession();
    const posted: Array<{ message: WorkerResponse; transfer: Transferable[] }> = [];
    try {
      session.handle(job(1), (message, transfer) => {
        posted.push({ message, transfer: transfer ?? [] });
      });
      await vi.waitFor(
        () => {
          expect(posted.some((p) => p.message.id === 1 && p.message.kind === "done")).toBe(true);
        },
        { timeout: 60_000, interval: 20 },
      );
      const batch = posted.find((p) => p.message.kind === "region-ready" && p.message.regions.some((region) => region.region === "buildings"));
      expect(batch).toBeDefined();
      const region = batch?.message.kind === "region-ready" ? batch.message.regions.find((mesh) => mesh.region === "buildings") : undefined;
      expect(region?.owners).toEqual(["b-court", "b-low", "b-tall"]);
      expect(region?.triangleOwner?.length).toBe((region?.indices.length ?? 0) / 3);
      expect(batch?.transfer).toContain(region?.positions.buffer);
      expect(batch?.transfer).toContain(region?.triangleOwner?.buffer);
      const cached = session.cache.get<FinishOut>("finish-buildings")?.output;
      expect(cached?.mesh.triangleOwner).not.toBe(region?.triangleOwner);
      expect(cached?.mesh.triangleOwner).toEqual(region?.triangleOwner);
    } finally {
      session.dispose();
    }
  }, 60_000);
});
