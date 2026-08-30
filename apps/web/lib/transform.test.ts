/**
 * TS <-> Python parity for the shared print-transform math.
 *
 * Loads `fixtures/parity-scene.json` (the SceneGraph both sides read) and
 * `fixtures/parity-expected.json` (dumped by
 * `services/bake/tests/test_transform.py`), recomputes every value with
 * `lib/transform.ts`, and asserts agreement within 0.01 mm of print.
 *
 * Ground-metre quantities are compared *after* conversion to print mm
 * (`diff * scale`), because 0.01 mm is a print tolerance: at the 180 mm
 * default that makes the ground tolerance about 0.1 m, and at the small-plate
 * case about 0.2 m. Booleans and counts must match exactly.
 *
 * If this test fails, one of the two implementations changed without the
 * other. Fix the code, not the tolerance.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { PrintParams, SceneGraph } from "./contracts";
import * as T from "./transform";

const MM_TOLERANCE = 0.01;

interface ExpectedBuilding {
  id: string;
  area_m2: number;
  perimeter_m: number;
  char_width_m: number;
  dilation_m: number;
  dropped: boolean;
  height_scale: number;
  top_mm: number;
  bottom_mm: number;
}

interface ExpectedRoad {
  id: string;
  width_ground_m: number;
  z_mm: number | null;
}

interface ExpectedTree {
  index: number;
  visible: boolean;
  /** `visible` plus the nozzle-aware floor -- what the preview draws. */
  visible_for: boolean;
  selected: boolean;
  selected_for: boolean;
  radius_mm: number;
  height_mm: number;
}

interface ExpectedCase {
  name: string;
  params: PrintParams;
  radius_m: number;
  scale_mm_per_m: number;
  usable_span_mm: number;
  thresholds_ground_m: { min_wall: number; min_gap: number; min_detail: number };
  base_top_mm: number;
  terrain_z_scale: number;
  tree_min_radius_mm: number;
  max_height_mm: number;
  predicted_top_mm: number;
  model_too_tall: boolean;
  plate_extents_mm: T.Extents;
  content_extents_mm: T.Extents;
  frame_mm: T.FrameGeometry;
  areas: {
    water_z_mm: number | null;
    green_z_mm: number;
    water_dropped: boolean[];
    green_dropped: boolean[];
  };
  buildings: ExpectedBuilding[];
  roads: ExpectedRoad[];
  trees: ExpectedTree[];
}

interface Expected {
  scene: string;
  cases: ExpectedCase[];
}

function loadJson<T>(relative: string): T {
  const url = new URL(`../../../fixtures/${relative}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf-8")) as T;
}

const scene = loadJson<SceneGraph>("parity-scene.json");
const expected = loadJson<Expected>("parity-expected.json");

describe("fixtures", () => {
  it("point at the same scene and are non-trivial", () => {
    expect(expected.scene).toBe("fixtures/parity-scene.json");
    expect(expected.cases).toHaveLength(3);
    expect(scene.buildings.length).toBeGreaterThanOrEqual(20);
    expect(scene.roads.length).toBeGreaterThanOrEqual(5);
    expect(scene.trees.length).toBeGreaterThanOrEqual(5);
    // The three cases must genuinely differ or parity proves nothing.
    expect(new Set(expected.cases.map((c) => c.scale_mm_per_m)).size).toBe(3);
    // ... and the two bake-side rules mirrored here must actually fire in the
    // fixture, or this file could mirror a constant `false`.
    expect(expected.cases.map((c) => c.model_too_tall)).toEqual([false, true, false]);
    expect(expected.cases.some((c) => c.tree_min_radius_mm > T.TREE_MIN_RADIUS_MM)).toBe(
      true,
    );
    expect(
      expected.cases.some((c) => c.trees.some((t) => t.visible && !t.visible_for)),
    ).toBe(true);
  });
});

describe.each(expected.cases)("parity case $name", (expectedCase) => {
  const params = expectedCase.params;
  const radius_m = T.radius_m_from_bounds(scene.bounds);
  const scale = T.scale_mm_per_m(params, radius_m);
  const thresholds = T.thresholds_ground_m(params, scale);

  /** Assert two print-millimetre values agree within 0.01 mm. */
  const mmEq = (actual: number, want: number, what: string): void => {
    expect(Math.abs(actual - want), `${what}: ${actual} vs ${want} (mm)`).toBeLessThanOrEqual(
      MM_TOLERANCE,
    );
  };

  /** Assert two ground-metre values agree within 0.01 mm of print. */
  const groundEq = (actual: number, want: number, what: string): void => {
    expect(
      Math.abs(actual - want) * scale,
      `${what}: ${actual} vs ${want} (ground m, ${scale} mm/m)`,
    ).toBeLessThanOrEqual(MM_TOLERANCE);
  };

  it("agrees on radius, scale and usable span", () => {
    groundEq(radius_m, expectedCase.radius_m, "radius_m");
    // scale is mm per m; compare the printed size of a 1 km span instead of
    // the raw ratio, which is what the 0.01 mm tolerance actually means.
    mmEq(scale * 1000, expectedCase.scale_mm_per_m * 1000, "scale over 1 km");
    mmEq(T.usable_span_mm(params), expectedCase.usable_span_mm, "usable_span_mm");
  });

  it("agrees on the minimum-feature thresholds", () => {
    groundEq(thresholds.min_wall, expectedCase.thresholds_ground_m.min_wall, "min_wall");
    groundEq(thresholds.min_gap, expectedCase.thresholds_ground_m.min_gap, "min_gap");
    groundEq(
      thresholds.min_detail,
      expectedCase.thresholds_ground_m.min_detail,
      "min_detail",
    );
  });

  it("agrees on base, plate, content and frame geometry", () => {
    mmEq(T.base_top_mm(params), expectedCase.base_top_mm, "base_top_mm");
    expect(T.terrain_z_scale(params)).toBe(expectedCase.terrain_z_scale);
    expect(T.terrain_z_mm(0, params, scale)).toBe(0);

    const plate = T.plate_extents_mm(params);
    const content = T.content_extents_mm(params);
    for (const key of ["min_x", "min_y", "max_x", "max_y", "size"] as const) {
      mmEq(plate[key], expectedCase.plate_extents_mm[key], `plate.${key}`);
      mmEq(content[key], expectedCase.content_extents_mm[key], `content.${key}`);
    }

    const frame = T.frame_geometry_mm(params);
    expect(frame.enabled).toBe(expectedCase.frame_mm.enabled);
    for (const key of [
      "width_mm",
      "outer_half_mm",
      "inner_half_mm",
      "bottom_mm",
      "top_mm",
    ] as const) {
      mmEq(frame[key], expectedCase.frame_mm[key], `frame.${key}`);
    }
  });

  it("agrees on every building footprint metric and printed height", () => {
    expect(scene.buildings).toHaveLength(expectedCase.buildings.length);
    scene.buildings.forEach((building, i) => {
      const want = expectedCase.buildings[i];
      expect(building.id).toBe(want.id);
      const [area, perimeter, charWidth, dilation] = T.building_footprint_metrics(
        building.ring,
        building.holes,
        thresholds,
      );
      // Area is m^2; compare relatively, everything else is a length.
      expect(Math.abs(area - want.area_m2)).toBeLessThanOrEqual(
        1e-6 * Math.max(1, want.area_m2),
      );
      groundEq(perimeter, want.perimeter_m, `${want.id}.perimeter_m`);
      groundEq(charWidth, want.char_width_m, `${want.id}.char_width_m`);
      groundEq(dilation, want.dilation_m, `${want.id}.dilation_m`);
      expect(T.building_dropped(area, dilation, thresholds)).toBe(want.dropped);
      expect(T.building_height_scale(building, params)).toBeCloseTo(want.height_scale, 9);
      mmEq(T.building_top_mm(building, params, scale), want.top_mm, `${want.id}.top_mm`);
      mmEq(T.building_bottom_mm(params), want.bottom_mm, `${want.id}.bottom_mm`);
    });
  });

  it("agrees on road widths and the road z offset", () => {
    expect(scene.roads).toHaveLength(expectedCase.roads.length);
    const z = T.road_z_mm(params);
    scene.roads.forEach((road, i) => {
      const want = expectedCase.roads[i];
      expect(road.id).toBe(want.id);
      groundEq(
        T.road_width_ground_m(road, params, thresholds),
        want.width_ground_m,
        `${want.id}.width_ground_m`,
      );
      if (want.z_mm === null) {
        expect(z).toBeNull();
      } else {
        expect(z).not.toBeNull();
        mmEq(z as number, want.z_mm, `${want.id}.z_mm`);
      }
    });
  });

  it("agrees on the water and green offsets and drop decisions", () => {
    const water = T.water_z_mm(params);
    if (expectedCase.areas.water_z_mm === null) {
      expect(water).toBeNull();
    } else {
      expect(water).not.toBeNull();
      mmEq(water as number, expectedCase.areas.water_z_mm, "water_z_mm");
    }
    mmEq(T.green_z_mm(params), expectedCase.areas.green_z_mm, "green_z_mm");

    expect(
      scene.water.map((w) => T.area_dropped(T.ring_area_m2(w.ring), thresholds)),
    ).toEqual(expectedCase.areas.water_dropped);
    expect(
      scene.green.map((g) => T.area_dropped(T.ring_area_m2(g.ring), thresholds)),
    ).toEqual(expectedCase.areas.green_dropped);
  });

  it("agrees on tree visibility, selection and cone size", () => {
    expect(scene.trees).toHaveLength(expectedCase.trees.length);
    const selected = new Set(T.select_tree_indices(scene.trees, scale));
    const selectedFor = new Set(T.select_tree_indices_for(scene.trees, params, scale));
    scene.trees.forEach((tree, i) => {
      const want = expectedCase.trees[i];
      expect(want.index).toBe(i);
      expect(T.tree_visible(tree, scale)).toBe(want.visible);
      expect(T.tree_visible_for(tree, params, scale)).toBe(want.visible_for);
      expect(selected.has(i)).toBe(want.selected);
      expect(selectedFor.has(i)).toBe(want.selected_for);
      mmEq(T.tree_radius_mm(tree, scale), want.radius_mm, `tree${i}.radius_mm`);
      mmEq(T.tree_height_mm(tree, scale), want.height_mm, `tree${i}.height_mm`);
    });
  });

  it("agrees on the nozzle-aware tree radius floor", () => {
    mmEq(
      T.tree_min_radius_mm(params),
      expectedCase.tree_min_radius_mm,
      "tree_min_radius_mm",
    );
  });

  it("agrees on the predicted model top and the 60 mm guard", () => {
    expect(T.MAX_HEIGHT_MM).toBe(expectedCase.max_height_mm);
    mmEq(
      T.predicted_top_mm(scene, params, radius_m),
      expectedCase.predicted_top_mm,
      "predicted_top_mm",
    );
    expect(T.model_too_tall(scene, params, radius_m)).toBe(expectedCase.model_too_tall);
  });
});

describe("transform unit behaviour (mirrors test_transform.py)", () => {
  const base: PrintParams = {
    plate_mm: 180,
    base_thickness_mm: 3.0,
    nozzle_mm: 0.4,
    small_scale: 1.0,
    large_scale: 1.0,
    terrain_exaggeration: 1.0,
    road_mode: "engrave",
    road_scale: 1.0,
    trees: true,
    water: true,
    frame: true,
  };
  const p = (o: Partial<PrintParams> = {}): PrintParams => ({ ...base, ...o });

  it("reproduces 04's worked example", () => {
    const noFrame = p({ frame: false });
    const scale = T.scale_mm_per_m(noFrame, 900);
    expect(scale).toBeCloseTo(0.1, 12);
    expect(scale / 1000).toBeCloseTo(1 / 10000, 15);
    const th = T.thresholds_ground_m(noFrame, scale);
    expect(th.min_wall).toBeCloseTo(8.0, 9);
    expect(th.min_gap).toBeCloseTo(6.0, 9);
    expect(th.min_detail).toBeCloseTo(4.0, 9);
  });

  it("clamps printed building height at 0.6 mm", () => {
    const small = p({ plate_mm: 100, small_scale: 0.5 });
    const scale = T.scale_mm_per_m(small, 3000);
    expect(T.building_top_mm({ height_m: 2, is_tall: false }, small, scale)).toBeCloseTo(
      3.6,
      9,
    );
  });

  it("engraves at 0.6 mm across the whole legal base range", () => {
    expect(T.road_z_mm(p({ base_thickness_mm: 2 }))).toBeCloseTo(-0.6, 9);
    expect(T.road_z_mm(p({ base_thickness_mm: 8 }))).toBeCloseTo(-0.6, 9);
    expect(T.road_z_mm(p({ road_mode: "emboss" }))).toBeCloseTo(0.4, 9);
    expect(T.road_z_mm(p({ road_mode: "off" }))).toBeNull();
  });

  it("treats rings as implicitly closed regardless of winding", () => {
    const square = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(T.ring_area_m2(square)).toBeCloseTo(100, 9);
    expect(T.ring_area_m2([...square].reverse())).toBeCloseTo(100, 9);
    expect(T.ring_perimeter_m(square)).toBeCloseTo(40, 9);
    expect(T.ring_area_m2([[0, 0], [1, 1]])).toBe(0);
  });

  it("caps trees at 2000, keeping the largest", () => {
    const scale = 0.1;
    const trees = [
      ...Array.from({ length: 3 }, () => ({ radius_m: 4.0 })),
      ...Array.from({ length: T.TREE_CAP + 10 }, () => ({ radius_m: 20.0 })),
    ];
    const picked = T.select_tree_indices(trees, scale);
    expect(picked).toHaveLength(T.TREE_CAP);
    expect(picked.every((i) => i >= 3)).toBe(true);
    expect([...picked].sort((a, b) => a - b)).toEqual(picked);
  });

  it("rejects a zero radius", () => {
    expect(() => T.scale_mm_per_m(p(), 0)).toThrow();
  });

  it("raises the tree radius floor only for a nozzle over 0.46 mm", () => {
    expect(T.tree_min_radius_mm(p())).toBeCloseTo(T.TREE_MIN_RADIUS_MM, 12);
    for (const nozzle_mm of [0.1, 0.2, 0.4]) {
      expect(T.tree_min_radius_mm(p({ nozzle_mm }))).toBe(T.TREE_MIN_RADIUS_MM);
    }
    for (const nozzle_mm of [0.5, 0.6, 0.8, 1.2]) {
      const floor = T.tree_min_radius_mm(p({ nozzle_mm }));
      expect(floor).toBeGreaterThan(T.TREE_MIN_RADIUS_MM);
      // an 8-gon of circumradius r is 2 r cos(pi/8) across its flats
      const acrossFlats = 2 * floor * Math.cos(Math.PI / T.TREE_SIDES);
      expect(acrossFlats).toBeCloseTo(T.MIN_WALL_NOZZLES * nozzle_mm, 9);
    }
  });

  it("filters trees on the floor without changing tree_visible", () => {
    const fat = p({ frame: false, nozzle_mm: 0.8 }); // floor 0.866 mm
    const scale = T.scale_mm_per_m(fat, 900); // 0.1 mm/m
    const small = { radius_m: 6.0 };
    const big = { radius_m: 9.0 };
    expect(T.tree_visible(small, scale)).toBe(true);
    expect(T.tree_visible_for(small, fat, scale)).toBe(false);
    expect(T.tree_visible_for(big, fat, scale)).toBe(true);
    const trees = [small, big, { radius_m: 1.0 }];
    expect(T.select_tree_indices(trees, scale)).toEqual([0, 1]);
    expect(T.select_tree_indices_for(trees, fat, scale)).toEqual([1]);
    const stock = p({ frame: false });
    expect(T.select_tree_indices_for(trees, stock, scale)).toEqual(
      T.select_tree_indices(trees, scale),
    );
  });

  it("predicts the model top from the buildings, the frame and the trees", () => {
    const noFrame = p({ frame: false });
    const scale = T.scale_mm_per_m(noFrame, 900); // 0.1 mm/m
    const empty = { buildings: [], trees: [] };
    expect(T.predicted_top_mm(empty, noFrame, 900)).toBeCloseTo(3.0, 9);
    expect(T.predicted_top_mm(empty, p(), 900)).toBeCloseTo(3.0 + T.FRAME_LIP_MM, 9);

    const tall = {
      buildings: [
        { height_m: 10, is_tall: false },
        { height_m: 400, is_tall: true },
      ],
      trees: [],
    };
    expect(T.predicted_top_mm(tall, noFrame, 900)).toBeCloseTo(43.0, 9);
    expect(T.model_too_tall(tall, noFrame, 900)).toBe(false);
    const doubled = p({ frame: false, large_scale: 2.0 });
    expect(T.predicted_top_mm(tall, doubled, 900)).toBeCloseTo(83.0, 9);
    expect(T.model_too_tall(tall, doubled, 900)).toBe(true);

    const treed = { buildings: [], trees: [{ radius_m: 20 }] };
    expect(T.predicted_top_mm(treed, noFrame, 900)).toBeCloseTo(
      3.0 + T.tree_height_mm({ radius_m: 20 }, scale),
      9,
    );
    expect(T.predicted_top_mm(treed, p({ frame: false, trees: false }), 900)).toBe(3.0);
  });
});
