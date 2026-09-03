/**
 * A run's `terrain` reaches the `terrain` stage as the grid it was posted
 * with: phase 3's `EngineInput.terrain` is a structured-clone-friendly
 * `TerrainGrid`, and the session hands it to the pipeline verbatim. A real
 * (small) build through the real session, not a mock: the assertion is on the
 * printed relief the grid produces, which is the only proof the grid arrived.
 */
import { describe, expect, it, vi } from "vitest";

import { defaultPrintParams } from "../contracts";
import { terrainScene } from "./pipeline/testScenes";
import { PipelineSession, type RunJobMessage, type WorkerResponse } from "./protocol";

async function runToDone(msg: RunJobMessage): Promise<WorkerResponse & { kind: "done" }> {
  const session = new PipelineSession();
  const posted: WorkerResponse[] = [];
  try {
    session.handle(msg, (message) => {
      posted.push(message);
    });
    await vi.waitFor(
      () => {
        expect(posted.some((m) => m.kind === "done" || m.kind === "error")).toBe(true);
      },
      { timeout: 60_000, interval: 20 },
    );
    const done = posted.find((m) => m.kind === "done");
    const error = posted.find((m) => m.kind === "error");
    if (done === undefined || done.kind !== "done") throw new Error(`the run failed: ${JSON.stringify(error)}`);
    return done;
  } finally {
    session.dispose();
  }
}

describe("PipelineSession: the terrain grid passes through to the terrain stage unmodified", () => {
  const { scene, grid } = terrainScene();

  it("a posted grid drapes the model: the result reports the relief the grid carries", async () => {
    const done = await runToDone({
      kind: "run",
      id: 1,
      source: { kind: "scene", scene, key: "terrain" },
      params: defaultPrintParams(),
      terrain: { grid, gate: "always" },
      heroIds: null,
      date: "2026-09-02",
      rotationDeg: 0,
      mode: "full",
      known: {},
      knownSceneHash: null,
    });
    expect(done.result?.stats.terrainReliefMm).toBeDefined();
    expect(done.result?.stats.terrainReliefMm ?? 0).toBeGreaterThan(0);
  }, 90_000);

  it("no grid means a flat build (terrain stays null, never forced to a grid)", async () => {
    const done = await runToDone({
      kind: "run",
      id: 2,
      source: { kind: "scene", scene, key: "terrain" },
      params: defaultPrintParams(),
      terrain: null,
      heroIds: null,
      date: "2026-09-02",
      rotationDeg: 0,
      mode: "full",
      known: {},
      knownSceneHash: null,
    });
    expect(done.result?.stats.terrainReliefMm).toBeUndefined();
  }, 90_000);

  it("with `gate: \"param\"` the grid is used only when params.terrain.enabled says so", async () => {
    const off = await runToDone({
      kind: "run",
      id: 3,
      source: { kind: "scene", scene, key: "terrain" },
      params: defaultPrintParams(),
      terrain: { grid, gate: "param" },
      heroIds: null,
      date: "2026-09-02",
      rotationDeg: 0,
      mode: "full",
      known: {},
      knownSceneHash: null,
    });
    expect(off.result?.stats.terrainReliefMm).toBeUndefined();
    const on = await runToDone({
      kind: "run",
      id: 4,
      source: { kind: "scene", scene, key: "terrain" },
      params: { ...defaultPrintParams(), terrain: { enabled: true, smoothing: 1 } },
      terrain: { grid, gate: "param" },
      heroIds: null,
      date: "2026-09-02",
      rotationDeg: 0,
      mode: "full",
      known: {},
      knownSceneHash: null,
    });
    expect(on.result?.stats.terrainReliefMm ?? 0).toBeGreaterThan(0);
  }, 120_000);
});
