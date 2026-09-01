/**
 * `runOneBake` (via `runBakeJob`) must hand `msg.input` to `bake()` verbatim,
 * including `terrain` -- phase 3's `EngineInput.terrain` is a
 * structured-clone-friendly `TerrainGrid`, not a `TerrainSampler`, so unlike
 * the pre-phase-3 code there is no longer a reason to null it out on the way
 * in. Mocks `./engine` so this is a fast plumbing check, not a real bake:
 * `synthetic.test.ts`'s "the terrain hook" describe block is what actually
 * exercises a terrain grid through the real solid pipeline.
 */
import { describe, expect, it, vi } from "vitest";

import { defaultPrintParams } from "../contracts";
import type { TerrainGrid } from "./types";

const bakeMock = vi.fn(async (input?: unknown) => {
  void input;
  return {
    regions: [],
    merged: {
      region: "base" as const,
      positions: new Float64Array(),
      indices: new Uint32Array(),
      volumeMm3: 0,
      bbox: {
        min: [0, 0, 0] as [number, number, number],
        max: [0, 0, 0] as [number, number, number],
      },
      bodies: 1,
      slot: 1,
      colorHex: "#000000",
    },
    stats: {
      scaleDenominator: 1,
      minWallMm: 0,
      measuredMinWallMm: null,
      buildings: 0,
      buildingsMerged: 0,
      buildingsDilated: 0,
      heightFallbacks: 0,
      triangles: 0,
      widthMm: 0,
      depthMm: 0,
      heightMm: 0,
      elapsedMs: 0,
    },
    findings: [],
    resolvedText: [],
    params: defaultPrintParams(),
  };
});

vi.mock("./engine", () => ({ bake: (input: unknown) => bakeMock(input) }));

describe("runOneBake: terrain passes through to bake() unmodified", () => {
  it("does not null out a TerrainGrid on the way in", async () => {
    const { runBakeJob, resetBakeQueueForTest } = await import("./protocol");
    resetBakeQueueForTest();
    const grid: TerrainGrid = {
      originEastM: -100,
      originNorthM: -100,
      cellM: 10,
      cols: 3,
      rows: 3,
      elevations: new Float32Array(9),
      rangeM: 5,
      source: "test",
    };
    const posted: unknown[] = [];
    await runBakeJob(
      {
        kind: "bake",
        id: 1,
        input: {
          scene: {
            bounds: { min_x: -100, min_y: -100, max_x: 100, max_y: 100 },
            center: { lat: 0, lon: 0 },
            buildings: [],
            roads: [],
            water: [],
            green: [],
            trees: [],
            stats: { building_count: 0, coverage: "empty", height_tag_ratio: 0 },
          },
          params: defaultPrintParams(),
          terrain: grid,
        },
      },
      (message) => posted.push(message),
    );
    expect(bakeMock).toHaveBeenCalledTimes(1);
    expect(bakeMock.mock.calls[0][0]).toMatchObject({ terrain: grid });
  });

  it("bakes fine with no terrain at all (terrain stays undefined, never forced to null)", async () => {
    const { runBakeJob, resetBakeQueueForTest } = await import("./protocol");
    resetBakeQueueForTest();
    bakeMock.mockClear();
    await runBakeJob(
      {
        kind: "bake",
        id: 2,
        input: {
          scene: {
            bounds: { min_x: -100, min_y: -100, max_x: 100, max_y: 100 },
            center: { lat: 0, lon: 0 },
            buildings: [],
            roads: [],
            water: [],
            green: [],
            trees: [],
            stats: { building_count: 0, coverage: "empty", height_tag_ratio: 0 },
          },
          params: defaultPrintParams(),
        },
      },
      () => undefined,
    );
    expect((bakeMock.mock.calls[0][0] as { terrain?: unknown }).terrain).toBeUndefined();
  });
});
