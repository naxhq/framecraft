/**
 * Warning and Bake-gating rules.
 *
 * The load-bearing one is the 60 mm ceiling: `services/bake/app/bake.py` refuses
 * a model whose predicted top reaches `checks.MAX_HEIGHT_MM` before it builds
 * anything, so the editor must reach the same verdict from the same shared math
 * (`lib/transform.ts` <-> `app/geom/transform.py`, pinned by
 * `fixtures/parity-expected.json`). An editor that offers a bake the server
 * bounces is the preview/bake divergence 01 calls the worst failure mode.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_PRINT_PARAMS } from "./contracts";
import type { Building, PrintParams, SceneGraph } from "./contracts";
import * as T from "./transform";
import {
  ESTIMATED_HEIGHT_RATIO,
  MIN_BUILDINGS_TO_BAKE,
  bakeBlockReason,
  predictedTopMm,
  sceneWarnings,
  warningDeps,
} from "./warnings";

const p = (overrides: Partial<PrintParams> = {}): PrintParams => ({
  ...DEFAULT_PRINT_PARAMS,
  ...overrides,
});

/** A different-from-default value for every non-boolean PrintParams key. */
const MOVES: Record<string, number | string> = {
  plate_mm: 256,
  base_thickness_mm: 8,
  nozzle_mm: 0.8,
  small_scale: 1.5,
  large_scale: 2.0,
  terrain_exaggeration: 3.0,
  road_mode: "emboss",
  road_scale: 2.0,
};

const building = (height_m: number): Building => ({
  id: `w${height_m}`,
  ring: [
    [0, 0],
    [30, 0],
    [30, 30],
    [0, 30],
  ] as Array<[number, number]>,
  holes: [],
  height_m,
  height_source: "tag",
  min_height_m: 0,
  is_tall: height_m >= T.TALL_BUILDING_M,
});

/** A scene with `count` buildings, the first of them `tallest_m` metres tall. */
function graphOf(count: number, tallest_m: number, ratio = 0.5): SceneGraph {
  const buildings = [
    building(tallest_m),
    ...Array.from({ length: Math.max(0, count - 1) }, () => building(12)),
  ];
  return {
    bounds: { min_x: -900, min_y: -900, max_x: 900, max_y: 900 },
    center: { lat: 41.8827, lon: -87.6233 },
    buildings,
    roads: [],
    water: [],
    green: [],
    trees: [],
    stats: {
      building_count: buildings.length,
      coverage: buildings.length >= MIN_BUILDINGS_TO_BAKE ? "good" : "empty",
      height_tag_ratio: ratio,
    },
  };
}

describe("predictedTopMm", () => {
  it("is exactly the transform's prediction for the scene's own radius", () => {
    const graph = graphOf(40, 200);
    const params = p();
    expect(predictedTopMm(graph, params)).toBe(
      T.predicted_top_mm(graph, params, T.radius_m_from_bounds(graph.bounds)),
    );
  });

  it("is null without a scene and never divides by a zero radius", () => {
    expect(predictedTopMm(null, p())).toBeNull();
    const degenerate = graphOf(40, 100);
    degenerate.bounds = { min_x: 0, min_y: 0, max_x: 0, max_y: 0 };
    expect(predictedTopMm(degenerate, p())).toBeNull();
  });

  it("follows the height sliders, the plate and the frame", () => {
    const graph = graphOf(40, 200);
    const base = predictedTopMm(graph, p()) as number;
    expect(predictedTopMm(graph, p({ large_scale: 2.0 }))).toBeCloseTo(
      3 + (base - 3) * 2,
      9,
    );
    // A smaller plate is a smaller scale, hence a shorter model.
    expect(predictedTopMm(graph, p({ plate_mm: 100 }))).toBeLessThan(base);
    expect(predictedTopMm(graph, p({ frame: false }))).toBeGreaterThan(base);
    expect(predictedTopMm(graph, p({ base_thickness_mm: 8 }))).toBeCloseTo(base + 5, 9);
  });
});

describe("the 60 mm ceiling", () => {
  /** 200 m at 1:10714 (180 mm plate, frame on) is 18.7 mm + 3 mm of base. */
  const graph = graphOf(40, 200);

  it("blocks Bake with the height, the limit and what to do about it", () => {
    // 220 m doubled on a 256 mm frameless plate is 62.6 mm over a 3 mm base:
    // exactly the "slide large_scale to 2.0 on a tall city" case the bake
    // refuses in under a millisecond (DECISIONS [P3-fix]).
    const skyline = graphOf(40, 220);
    const tall = p({ large_scale: 2.0, frame: false, plate_mm: 256 });
    const top = predictedTopMm(skyline, tall) as number;
    expect(top).toBeGreaterThanOrEqual(T.MAX_HEIGHT_MM);

    const reason = bakeBlockReason(skyline, tall);
    expect(reason).toBe(
      `Model would be ${top.toFixed(1)} mm tall (limit 60 mm) — ` +
        "lower the building scales or the plate size",
    );
    const warning = sceneWarnings(skyline, tall).find((w) => w.id === "model-too-tall");
    expect(warning?.level).toBe("block");
  });

  it("allows Bake right up to the limit and blocks at it", () => {
    // The bake refuses on `>=`, so the editor must too, exactly.
    const graph60 = graphOf(40, 200);
    const params = p({ frame: false });
    const scale = T.scale_mm_per_m(params, 900);
    const justUnder = (T.MAX_HEIGHT_MM - 3 - 1e-6) / scale;
    graph60.buildings[0] = building(justUnder);
    expect(bakeBlockReason(graph60, params)).toBeNull();
    graph60.buildings[0] = building((T.MAX_HEIGHT_MM - 3) / scale);
    expect(predictedTopMm(graph60, params)).toBeCloseTo(T.MAX_HEIGHT_MM, 9);
    expect(bakeBlockReason(graph60, params)).toContain("Model would be");
  });

  it("does not fire on a scene that fits", () => {
    expect(bakeBlockReason(graph, p())).toBeNull();
    expect(sceneWarnings(graph, p()).map((w) => w.id)).not.toContain("model-too-tall");
  });
});

describe("coverage and estimated heights still gate the bake", () => {
  it("blocks a scene under 20 buildings before it mentions the height", () => {
    const sparse = graphOf(5, 400);
    const reason = bakeBlockReason(sparse, p({ large_scale: 2.0 }));
    expect(reason).toContain("enlarge the radius");
  });

  it("warns about estimated heights without blocking", () => {
    const guessed = graphOf(40, 100, ESTIMATED_HEIGHT_RATIO - 0.01);
    const warnings = sceneWarnings(guessed, p());
    const estimated = warnings.find((w) => w.id === "estimated-heights");
    expect(estimated?.level).toBe("warn");
    expect(bakeBlockReason(guessed, p())).toBeNull();
  });

  it("says to generate first when there is no scene", () => {
    expect(bakeBlockReason(null, p())).toBe("Generate a scene first.");
    expect(sceneWarnings(null, p())).toEqual([]);
  });
});

describe("warningDeps", () => {
  const graph = graphOf(40, 200);

  it("names every parameter the prediction actually reads, and no other", () => {
    const before = warningDeps(graph, p());
    for (const key of Object.keys(DEFAULT_PRINT_PARAMS) as Array<keyof PrintParams>) {
      const moved: PrintParams = { ...DEFAULT_PRINT_PARAMS };
      (moved as unknown as Record<string, unknown>)[key] =
        typeof DEFAULT_PRINT_PARAMS[key] === "boolean"
          ? !DEFAULT_PRINT_PARAMS[key]
          : MOVES[key];
      const after = warningDeps(graph, moved);
      const listed = before.some((value, i) => !Object.is(value, after[i]));
      const moves = predictedTopMm(graph, moved) !== predictedTopMm(graph, p());
      if (moves) {
        expect(listed, `${key} moves the prediction but is not a dep`).toBe(true);
      }
      if (!listed) {
        expect(moves, `${key} is not a dep but moves the prediction`).toBe(false);
      }
    }
  });

  it("never puts the params object itself in the key", () => {
    const params = p();
    for (const value of warningDeps(graph, params)) {
      expect(value).not.toBe(params);
      if (value !== graph) expect(typeof value).not.toBe("object");
    }
  });
});
