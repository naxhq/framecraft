/**
 * Picking-footprint unit tests.
 *
 * These run against `fixtures/parity-scene.json` -- the same SceneGraph the
 * TS/Python parity test uses -- so a footprint that drifts from the engine's
 * own shows up as a failure here rather than as a click that picks the wrong
 * building.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DEFAULT_PRINT_PARAMS } from "./contracts";
import type { PrintParams, SceneGraph } from "./contracts";
import { BUDGET_FACTOR } from "./testBudget";
import {
  buildBuildings,
  buildingInstanceMatrices,
  convexHull,
  dilatedNotice,
  minAreaRect,
  treeFloorNoticeMetres,
} from "./preview";
import * as T from "./transform";

const scene: SceneGraph = JSON.parse(
  readFileSync(new URL("../../../fixtures/parity-scene.json", import.meta.url), "utf-8"),
) as SceneGraph;

const p = (overrides: Partial<PrintParams> = {}): PrintParams => ({
  ...DEFAULT_PRINT_PARAMS,
  ...overrides,
});

/**
 * 02's slider budget: one 30 fps frame to rewrite 5 000 instance matrices,
 * LOCAL at `VITEST_BUDGET_FACTOR=1`. Scaled like the rest of the suite's
 * wall-clock rows (`lib/testBudget.ts`) so a slow box cannot fail it for being
 * slow, though it has never been close on either machine -- see the reading it
 * now prints.
 */
const MATRIX_BUDGET_MS = 33 * BUDGET_FACTOR;

describe("minAreaRect", () => {
  it("recovers an axis-aligned rectangle exactly", () => {
    const rect = minAreaRect([
      [0, 0],
      [40, 0],
      [40, 10],
      [0, 10],
    ]);
    expect(rect.cx).toBeCloseTo(20, 9);
    expect(rect.cy).toBeCloseTo(5, 9);
    const dims = [rect.width, rect.depth].sort((a, b) => a - b);
    expect(dims[0]).toBeCloseTo(10, 9);
    expect(dims[1]).toBeCloseTo(40, 9);
  });

  it("recovers a rotated rectangle instead of its fat AABB", () => {
    const theta = Math.PI / 6;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const corners: Array<[number, number]> = [
      [-20, -5],
      [20, -5],
      [20, 5],
      [-20, 5],
    ];
    const rotated = corners.map(([x, y]): [number, number] => [
      x * cos - y * sin + 100,
      x * sin + y * cos - 50,
    ]);
    const rect = minAreaRect(rotated);
    expect(rect.cx).toBeCloseTo(100, 6);
    expect(rect.cy).toBeCloseTo(-50, 6);
    const dims = [rect.width, rect.depth].sort((a, b) => a - b);
    expect(dims[0]).toBeCloseTo(10, 6);
    expect(dims[1]).toBeCloseTo(40, 6);
    // The axis-aligned box of the same points would be much bigger.
    expect(rect.width * rect.depth).toBeLessThan(0.9 * 44.6 * 28.6);
  });

  it("survives degenerate input", () => {
    expect(minAreaRect([]).width).toBe(0);
    expect(convexHull([[0, 0]])).toHaveLength(1);
    const collinear = minAreaRect([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
    expect(collinear.width * collinear.depth).toBeCloseTo(0, 9);
  });
});

describe("buildBuildings", () => {
  it("keeps every fixture building and centres them in print space", () => {
    const params = p();
    const { buildings, droppedCount } = buildBuildings(scene, params);
    expect(buildings).toHaveLength(scene.buildings.length);
    expect(droppedCount).toBe(0);

    const scale = T.scale_mm_per_m(params, T.radius_m_from_bounds(scene.bounds));
    const half = T.content_extents_mm(params).size / 2;
    for (const b of buildings) {
      expect(Math.abs(b.cx_mm)).toBeLessThanOrEqual(half + 1);
      expect(Math.abs(b.cy_mm)).toBeLessThanOrEqual(half + 1);
      expect(b.width_mm).toBeGreaterThan(0);
      expect(b.depth_mm).toBeGreaterThan(0);
    }
    // A 90 x 120 m fixture block at 0.09333 mm/m is 8.4 x 11.2 mm.
    const first = buildings.find((b) => b.id === "w1000");
    expect(first).toBeDefined();
    const dims = [first!.width_mm, first!.depth_mm].sort((a, b) => a - b);
    expect(dims[0]).toBeCloseTo(90 * scale, 6);
    expect(dims[1]).toBeCloseTo(120 * scale, 6);
  });

  it("dilates thin footprints up to the minimum wall, like the build does", () => {
    const params = p();
    const scale = T.scale_mm_per_m(params, T.radius_m_from_bounds(scene.bounds));
    const thresholds = T.thresholds_ground_m(params, scale);
    const { buildings, dilatedCount } = buildBuildings(scene, params);

    // w2000 is the 3 x 80 m sliver in the parity fixture.
    const sliver = buildings.find((b) => b.id === "w2000");
    expect(sliver).toBeDefined();
    expect(sliver!.dilated).toBe(true);
    expect(dilatedCount).toBeGreaterThan(0);
    const narrow = Math.min(sliver!.width_mm, sliver!.depth_mm);
    // Undilated it would be 3 m wide; the min wall is ~8.57 m here.
    expect(narrow).toBeGreaterThanOrEqual(thresholds.min_wall * scale - 1e-9);
    expect(narrow).toBeGreaterThan(3 * scale);
  });

  it("shrinks with the frame on, because the frame eats 12 mm of plate", () => {
    const withFrame = buildBuildings(scene, p({ frame: true })).buildings;
    const without = buildBuildings(scene, p({ frame: false })).buildings;
    expect(withFrame[0].width_mm).toBeLessThan(without[0].width_mm);
    expect(withFrame[0].width_mm / without[0].width_mm).toBeCloseTo(168 / 180, 6);
  });

  it("does not depend on the height sliders", () => {
    const a = buildBuildings(scene, p({ small_scale: 0.5, large_scale: 0.5 })).buildings;
    const b = buildBuildings(scene, p({ small_scale: 1.5, large_scale: 2.0 })).buildings;
    expect(a.map((x) => [x.cx_mm, x.cy_mm, x.width_mm, x.depth_mm])).toEqual(
      b.map((x) => [x.cx_mm, x.cy_mm, x.width_mm, x.depth_mm]),
    );
  });
});

describe("buildingInstanceMatrices", () => {
  it("puts every box on the base top with the transform's height", () => {
    const params = p();
    const scale = T.scale_mm_per_m(params, T.radius_m_from_bounds(scene.bounds));
    const { buildings } = buildBuildings(scene, params);
    const matrices = buildingInstanceMatrices(buildings, params, scale);
    expect(matrices).toHaveLength(buildings.length * 16);

    const base = T.base_top_mm(params);
    buildings.forEach((b, i) => {
      const o = i * 16;
      const height = matrices[o + 10];
      const expectedTop = T.building_top_mm(b, params, scale);
      expect(base + height).toBeCloseTo(expectedTop, 4);
      // Boxes are centred, so the instance sits at half height above the base.
      expect(matrices[o + 14]).toBeCloseTo(base + height / 2, 4);
      expect(matrices[o + 12]).toBeCloseTo(b.cx_mm, 4);
      expect(matrices[o + 13]).toBeCloseTo(b.cy_mm, 4);
      expect(matrices[o + 15]).toBe(1);
      // Rotation columns keep the footprint dimensions.
      expect(Math.hypot(matrices[o + 0], matrices[o + 1])).toBeCloseTo(b.width_mm, 4);
      expect(Math.hypot(matrices[o + 4], matrices[o + 5])).toBeCloseTo(b.depth_mm, 4);
    });
  });

  it("applies small_scale and large_scale to the right buildings", () => {
    const params = p({ small_scale: 0.5, large_scale: 2.0 });
    const scale = T.scale_mm_per_m(params, T.radius_m_from_bounds(scene.bounds));
    const { buildings } = buildBuildings(scene, params);
    const matrices = buildingInstanceMatrices(buildings, params, scale);
    const tall = buildings.findIndex((b) => b.is_tall && b.height_m > 100);
    // > 20 m so the 0.6 mm clamp does not bind and the multiplier is visible.
    const short = buildings.findIndex((b) => !b.is_tall && b.height_m > 20);
    expect(tall).toBeGreaterThanOrEqual(0);
    expect(short).toBeGreaterThanOrEqual(0);
    expect(matrices[tall * 16 + 10]).toBeCloseTo(
      buildings[tall].height_m * scale * 2.0,
      4,
    );
    expect(matrices[short * 16 + 10]).toBeCloseTo(
      buildings[short].height_m * scale * 0.5,
      4,
    );
  });

  it("honours the 0.6 mm minimum printed height", () => {
    const params = p({ plate_mm: 100, small_scale: 0.5 });
    const { buildings } = buildBuildings(scene, params);
    const scale = T.scale_mm_per_m(params, T.radius_m_from_bounds(scene.bounds));
    const matrices = buildingInstanceMatrices(buildings, params, scale);
    for (let i = 0; i < buildings.length; i += 1) {
      expect(matrices[i * 16 + 10]).toBeGreaterThanOrEqual(T.MIN_BUILDING_HEIGHT_MM - 1e-9);
    }
  });

  it("reuses a caller-supplied buffer so a slider does not allocate", () => {
    const params = p();
    const scale = T.scale_mm_per_m(params, T.radius_m_from_bounds(scene.bounds));
    const { buildings } = buildBuildings(scene, params);
    const buffer = new Float32Array(buildings.length * 16);
    const out = buildingInstanceMatrices(buildings, params, scale, buffer);
    expect(out).toBe(buffer);
  });
});

describe("treeFloorNoticeMetres, the HUD's dropped-tree line", () => {
  it("reports the ground radius under which a fat nozzle drops trees", () => {
    // The tree cones are the engine's now, but the NOTICE is still the
    // editor's: at a fat nozzle whole avenues vanish from the model, and the
    // number has to be on screen the moment the nozzle moves.
    const stock = p();
    const scale = T.scale_mm_per_m(stock, T.radius_m_from_bounds(scene.bounds));
    expect(treeFloorNoticeMetres(stock, scale)).toBeNull();
    const fat = p({ nozzle_mm: 0.8 });
    const fatScale = T.scale_mm_per_m(fat, T.radius_m_from_bounds(scene.bounds));
    expect(treeFloorNoticeMetres(fat, fatScale)).toBeCloseTo(
      T.tree_min_radius_mm(fat) / fatScale,
      9,
    );
  });
});

describe("the pick proxies' slider budget", () => {
  it("stays inside the slider budget for a 5000-building scene", () => {
    const many: SceneGraph = {
      ...scene,
      buildings: Array.from({ length: 5000 }, (_, i) => ({
        ...scene.buildings[i % scene.buildings.length],
        id: `synthetic-${i}`,
      })),
    };
    const params = p();
    const scale = T.scale_mm_per_m(params, T.radius_m_from_bounds(many.bounds));
    const { buildings } = buildBuildings(many, params);
    expect(buildings.length).toBe(5000);

    // The slider path is matrices only; 02's budget is 33 ms per re-render
    // (`MATRIX_BUDGET_MS`, one frame at 30 fps, LOCAL at factor 1). Still
    // load-bearing with the proxies invisible: a hero pick raycasts against
    // these boxes, so they have to follow the height sliders.
    const buffer = new Float32Array(buildings.length * 16);
    const started = performance.now();
    for (let i = 0; i < 5; i += 1) {
      buildingInstanceMatrices(buildings, params, scale, buffer);
    }
    const perUpdate = (performance.now() - started) / 5;
    console.info(
      `[instance matrices] ${buildings.length} buildings, ${perUpdate.toFixed(2)} ms per update ` +
        `(budget ${MATRIX_BUDGET_MS} ms at factor ${BUDGET_FACTOR})`,
    );
    expect(perUpdate).toBeLessThan(MATRIX_BUDGET_MS);
  });
});

describe("dilatedNotice, the HUD's minimum-wall line", () => {
  interface ParityCase {
    name: string;
    params: PrintParams;
    scale_mm_per_m: number;
    thresholds_mm: { min_wall: number; min_gap: number; min_detail: number };
  }
  const parity = JSON.parse(
    readFileSync(
      new URL("../../../fixtures/parity-expected.json", import.meta.url),
      "utf-8",
    ),
  ) as { cases: ParityCase[] };

  it("prints min_wall_mm / scale for every parity parameter set", () => {
    // The fixture grows as the shared math does (a fourth, hero-bearing case
    // arrived with [V2-P3]), so this pins a floor and then asserts that EVERY
    // case in the file was walked -- which is stricter than the fixed count it
    // replaces, because a new case can no longer be added without being checked.
    expect(parity.cases.length).toBeGreaterThanOrEqual(3);
    let checked = 0;
    for (const parityCase of parity.cases) {
      checked += 1;
      const params = parityCase.params;
      const scale = T.scale_mm_per_m(params, T.radius_m_from_bounds(scene.bounds));
      const thresholds = T.thresholds_ground_m(params, scale);
      const metres = T.min_wall_mm(params) / scale;
      expect(metres).toBeCloseTo((2 * params.nozzle_mm) / scale, 9);
      expect(dilatedNotice(7, params, scale)).toBe(
        `7 widened to the ${metres.toFixed(1)} m minimum wall`,
      );
      // ... and never the one-nozzle detail floor, which is exactly half of it
      // and reads just as plausibly in the HUD.
      expect(dilatedNotice(7, params, scale)).not.toBe(
        `7 widened to the ${thresholds.min_detail.toFixed(1)} m minimum wall`,
      );
    }
    expect(checked).toBe(parity.cases.length);
  });

  it("reads 18.9 m at a 0.4 mm nozzle and 9.4 m at 0.2 mm on the 1:23,571 build", () => {
    // The reported build: 180 mm plate, frame on, radius 1980 m.
    const params = p({ plate_mm: 180, frame: true, nozzle_mm: 0.4 });
    const scale = T.scale_mm_per_m(params, 1980);
    expect(Math.round(1000 / scale)).toBe(23571);

    expect(dilatedNotice(3353, params, scale)).toBe(
      "3353 widened to the 18.9 m minimum wall",
    );
    // The trap: min_detail at a 0.4 mm nozzle is ALSO 9.4 m at this scale, so
    // the HUD string alone cannot distinguish a halved nozzle from a dropped
    // factor of two. Both readings are pinned (DECISIONS [V2-P1]).
    const thresholds = T.thresholds_ground_m(params, scale);
    expect(thresholds.min_detail.toFixed(1)).toBe("9.4");

    const halved = p({ plate_mm: 180, frame: true, nozzle_mm: 0.2 });
    expect(dilatedNotice(3353, halved, T.scale_mm_per_m(halved, 1980))).toBe(
      "3353 widened to the 9.4 m minimum wall",
    );
    expect(T.min_wall_mm(halved)).toBeCloseTo(0.4, 12); // the "Min wall 0.40 mm"
  });

  it("reads 8.6 m on the Chicago default, 4.3 m at half the nozzle", () => {
    // The shipped default the preset lands on: 180 mm plate, frame on, 900 m
    // radius -> usable 168 mm over 1800 m = 0.09333 mm/m (1:10,714). A second
    // scale keeps the notice from being pinned at one ratio only.
    const params = p({ plate_mm: 180, frame: true, nozzle_mm: 0.4 });
    const scale = T.scale_mm_per_m(params, 900);
    expect(dilatedNotice(370, params, scale)).toBe(
      "370 widened to the 8.6 m minimum wall",
    );

    const halved = p({ plate_mm: 180, frame: true, nozzle_mm: 0.2 });
    expect(dilatedNotice(208, halved, T.scale_mm_per_m(halved, 900))).toBe(
      "208 widened to the 4.3 m minimum wall",
    );
    // The one-nozzle look-alike at the default nozzle is the same 4.3 m, so a
    // HUD reading `min_detail` would print the halved-nozzle string here too.
    expect(T.thresholds_ground_m(params, scale).min_detail.toFixed(1)).toBe("4.3");
  });
});
