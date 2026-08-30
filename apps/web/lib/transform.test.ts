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

import { DEFAULT_PRINT_PARAMS, PARAM_RANGES } from "./contracts";
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
  /** v2: the user picked this id (mode-independent). */
  picked: boolean;
  /** v2: ... and the mode grants it its true relative height. */
  is_hero: boolean;
  height_scale_for: number;
  top_mm_for: number;
}

interface ExpectedAdvisor {
  report: {
    buildings_total: number;
    widened: number;
    dropped: number;
    widened_fraction: number;
    dropped_fraction: number;
    trees_total: number;
    trees_dropped_fraction: number;
    areas_total: number;
    areas_dropped_fraction: number;
    min_wall_ground_m: number;
    score: number;
    band: string;
  };
  recommend_radius_m: number | null;
  recommend_plate_mm: number | null;
  recommendation: string | null;
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
  radius_override: number | null;
  advisor: ExpectedAdvisor;
  scale_mm_per_m: number;
  usable_span_mm: number;
  thresholds_mm: { min_wall: number; min_gap: number; min_detail: number };
  thresholds_ground_m: { min_wall: number; min_gap: number; min_detail: number };
  base_top_mm: number;
  terrain_z_scale: number;
  tree_min_radius_mm: number;
  max_height_mm: number;
  predicted_top_mm: number;
  model_too_tall: boolean;
  hero: {
    ids: string[];
    mode: string;
    true_height: boolean;
    own_color: boolean;
    height_ids: string[];
  };
  color_mode: string;
  parts_mode: boolean;
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
    expect(expected.cases).toHaveLength(7);
    // The scene is 900 m of Chicago; the fifth case asks the advisor about a
    // 2 400 m crop of it, which is a parameter, not a property of the scene.
    // Cases 6 and 7 are the advisor's two remaining sentence shapes -- the
    // plate-only remedy and "no radius or plate in range fixes it" -- which
    // this side used to pin nowhere at all (v2-03 audit, finding 12).
    expect(T.radius_m_from_bounds(scene.bounds)).toBeCloseTo(900, 9);
    expect(scene.buildings.length).toBeGreaterThanOrEqual(20);
    expect(scene.roads.length).toBeGreaterThanOrEqual(5);
    expect(scene.trees.length).toBeGreaterThanOrEqual(5);
    // The cases must genuinely differ or parity proves nothing. Case 4 shares
    // case 1's plate and frame ON PURPOSE -- the hero rule is the only thing that
    // moves in it -- and cases 6 and 7 share plate 100 with a 1.2 mm nozzle and
    // differ only in the radius, so five distinct scales over seven is correct.
    expect(new Set(expected.cases.map((c) => c.scale_mm_per_m)).size).toBe(5);
    // ... and the two bake-side rules mirrored here must actually fire in the
    // fixture, or this file could mirror a constant `false`.
    expect(expected.cases.map((c) => c.model_too_tall)).toEqual([
      false,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    // The advisor's three remedy shapes are all present, so the mirror's
    // formatting of each is pinned by this fixture and not by prose.
    const sentences = expected.cases
      .map((c) => c.advisor.recommendation)
      .filter((r): r is string => r !== null);
    expect(sentences.some((r) => / m, or plate \d+\.$/.test(r))).toBe(true);
    expect(sentences.some((r) => /Try plate \d+\.$/.test(r))).toBe(true);
    expect(sentences.some((r) => r.includes("No radius or plate in range"))).toBe(true);
    // The hero rule must fire in exactly one case, and raise a real height there.
    const heroCases = expected.cases.filter((c) => c.hero.ids.length > 0);
    expect(heroCases).toHaveLength(1);
    expect(heroCases[0].buildings.filter((b) => b.is_hero)).toHaveLength(2);
    expect(
      heroCases[0].buildings.some((b) => b.is_hero && b.top_mm_for > b.top_mm),
    ).toBe(true);
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
  // The radius is an ARGUMENT everywhere in this module, so a case may name one
  // the scene was not cropped at; the advisor cases do exactly that, and only
  // those carry a `radius_override`. Every other case DERIVES it here with this
  // side's own `radius_m_from_bounds` -- reading the pinned number in both cases
  // made the `radius_m` assertion below compare a value against itself and left
  // that function unexercised on this side (v2-06 audit, finding 9).
  const radius_m = expectedCase.radius_override ?? T.radius_m_from_bounds(scene.bounds);
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
    expect(radius_m).toBeGreaterThan(0);
    // An override IS an input, so for those cases the line above compares the
    // fixture to itself -- which is only acceptable while the override really
    // is a radius the scene was not cropped at. Assert that, so the branch
    // cannot go degenerate and re-void the check (v2-06 audit, finding 9).
    if (expectedCase.radius_override !== null) {
      expect(expectedCase.radius_override).not.toBeCloseTo(
        T.radius_m_from_bounds(scene.bounds),
        6,
      );
    }
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

  it("agrees on the print-millimetre thresholds, 04's multiples of the nozzle", () => {
    mmEq(T.min_wall_mm(params), expectedCase.thresholds_mm.min_wall, "min_wall_mm");
    mmEq(T.min_gap_mm(params), expectedCase.thresholds_mm.min_gap, "min_gap_mm");
    mmEq(T.min_detail_mm(params), expectedCase.thresholds_mm.min_detail, "min_detail_mm");
    // 04: two perimeters, and never the one-nozzle detail floor.
    expect(T.min_wall_mm(params)).toBeCloseTo(2 * params.nozzle_mm, 12);
    expect(T.min_wall_mm(params)).toBeCloseTo(2 * T.min_detail_mm(params), 12);
    // ... and the ground threshold is exactly that divided by the scale.
    // Spelled out rather than as `T.min_wall_mm(params) / scale`: since
    // `thresholds_ground_m` IS that expression, comparing to it cannot fail for
    // any multiplier (v2 Task 0 audit, finding 2 -- DECISIONS [V2-P1-fix]).
    groundEq(thresholds.min_wall, (2 * params.nozzle_mm) / scale, "min_wall over scale");
    groundEq(thresholds.min_gap, (1.5 * params.nozzle_mm) / scale, "min_gap over scale");
    groundEq(
      thresholds.min_detail,
      (1.0 * params.nozzle_mm) / scale,
      "min_detail over scale",
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

  it("agrees on which buildings are heroes and how tall they print", () => {
    expect(T.hero_ids(params)).toEqual(expectedCase.hero.ids);
    expect(T.hero_mode(params)).toBe(expectedCase.hero.mode);
    expect(T.hero_true_height(params)).toBe(expectedCase.hero.true_height);
    expect(T.hero_own_color(params)).toBe(expectedCase.hero.own_color);
    expect([...T.hero_height_ids(params)].sort()).toEqual(expectedCase.hero.height_ids);
    expect(T.color_mode(params)).toBe(expectedCase.color_mode);
    expect(T.parts_mode(params)).toBe(expectedCase.parts_mode);
    scene.buildings.forEach((building, i) => {
      const want = expectedCase.buildings[i];
      expect(T.is_hero_id(building.id, params)).toBe(want.picked);
      const isHero = T.building_is_hero(building, params);
      expect(isHero).toBe(want.is_hero);
      expect(T.building_height_scale_for(building, params, isHero)).toBeCloseTo(
        want.height_scale_for,
        9,
      );
      mmEq(
        T.building_top_mm_for(building, params, scale, isHero),
        want.top_mm_for,
        `${want.id}.top_mm_for`,
      );
      // is_hero=false IS the v1 function, in both implementations.
      mmEq(
        T.building_top_mm_for(building, params, scale, false),
        T.building_top_mm(building, params, scale),
        `${want.id}.top_mm_for(false)`,
      );
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

  it("agrees with the detail advisor, count for count and word for word", () => {
    const want = expectedCase.advisor;
    const report = T.detail_report(scene, params, radius_m);
    expect(report.buildings_total).toBe(want.report.buildings_total);
    expect(report.widened).toBe(want.report.widened);
    expect(report.dropped).toBe(want.report.dropped);
    expect(report.trees_total).toBe(want.report.trees_total);
    expect(report.areas_total).toBe(want.report.areas_total);
    expect(report.score).toBe(want.report.score);
    expect(report.band).toBe(want.report.band);
    expect(report.widened_fraction).toBeCloseTo(want.report.widened_fraction, 9);
    expect(report.dropped_fraction).toBeCloseTo(want.report.dropped_fraction, 9);
    expect(report.trees_dropped_fraction).toBeCloseTo(
      want.report.trees_dropped_fraction,
      9,
    );
    expect(report.areas_dropped_fraction).toBeCloseTo(
      want.report.areas_dropped_fraction,
      9,
    );
    groundEq(report.min_wall_ground_m, want.report.min_wall_ground_m, "min_wall_ground_m");
    expect(T.recommend_radius_m(scene, params, radius_m)).toBe(want.recommend_radius_m);
    expect(T.recommend_plate_mm(scene, params, radius_m)).toBe(want.recommend_plate_mm);
    // The sentence is compared VERBATIM: it is user-facing text that the HUD and
    // the bake's warnings both show, so a rounding difference is a bug.
    expect(T.detail_recommendation(scene, params, radius_m)).toBe(want.recommendation);
  });
});

describe("the detail advisor (mirrors test_transform.py)", () => {
  it("gets worse as the radius grows and better as the plate does", () => {
    const p = expected.cases[0].params;
    const scores = [500, 900, 1800, 3000].map(
      (r) => T.detail_report(scene, p, r).score,
    );
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scores[0]).toBeGreaterThan(scores[scores.length - 1]);
    const wide = { ...p, plate_mm: 256 };
    expect(T.detail_report(scene, wide, 2400).score).toBeGreaterThan(
      T.detail_report(scene, p, 2400).score,
    );
  });

  it("solves for the largest radius that meets the target", () => {
    const p = expected.cases[0].params;
    const answer = T.recommend_radius_m(scene, p, 2400);
    expect(answer).not.toBeNull();
    const radius = answer as number;
    expect(radius % T.RADIUS_GRID_M).toBe(0);
    expect(radius).toBeGreaterThanOrEqual(T.RADIUS_MIN_M);
    expect(radius).toBeLessThan(2400);
    // one grid step wider already fails, i.e. it really is the largest
    const at = (r: number): number => {
      const th = T.thresholds_ground_m(p, T.scale_mm_per_m(p, r));
      let widened = 0;
      for (const b of scene.buildings) {
        const [area, , , dilation] = T.building_footprint_metrics(b.ring, b.holes, th);
        if (!T.building_dropped(area, dilation, th) && dilation > 0) widened += 1;
      }
      return widened / scene.buildings.length;
    };
    expect(at(radius)).toBeLessThan(T.MAX_WIDENED_FRACTION);
    expect(at(radius + T.RADIUS_GRID_M)).toBeGreaterThanOrEqual(T.MAX_WIDENED_FRACTION);
  });

  it("says nothing at all about a healthy scene", () => {
    const p = expected.cases[0].params;
    expect(T.detail_recommendation(scene, p, 900)).toBeNull();
    expect(T.detail_report(scene, p, 900).band).toBe("good");
  });

  it("scores 100 for a scene with nothing in it", () => {
    const empty = { buildings: [], trees: [], water: [], green: [] };
    const p = expected.cases[0].params;
    const report = T.detail_report(empty, p, 900);
    expect(report.score).toBe(100);
    expect(report.band).toBe("good");
    expect(T.detail_recommendation(empty, p, 900)).toBeNull();
    expect(T.recommend_radius_m(empty, p, 900)).toBeNull();
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

  it("keeps min_wall at two nozzles across the whole legal range", () => {
    // The legal range from the FROZEN contract, swept at 0.01 mm.
    expect(PARAM_RANGES.nozzle_mm.min).toBe(0.1);
    expect(PARAM_RANGES.nozzle_mm.max).toBe(1.2);
    expect(PARAM_RANGES.nozzle_mm.default).toBe(0.4);
    expect(DEFAULT_PRINT_PARAMS.nozzle_mm).toBe(0.4);
    for (let n = 10; n <= 120; n += 1) {
      const nozzle_mm = n / 100;
      const params = p({ nozzle_mm });
      expect(T.min_wall_mm(params)).toBeCloseTo(2 * nozzle_mm, 12);
      expect(T.min_gap_mm(params)).toBeCloseTo(1.5 * nozzle_mm, 12);
      expect(T.min_detail_mm(params)).toBeCloseTo(1 * nozzle_mm, 12);
      // The wall is twice the detail floor at every nozzle, never equal to it:
      // `1 * nozzle` is the silent look-alike this whole test exists for.
      expect(T.min_wall_mm(params)).toBeCloseTo(2 * T.min_detail_mm(params), 12);
      const scale = T.scale_mm_per_m(params, 1980);
      const th = T.thresholds_ground_m(params, scale);
      expect(th.min_wall).toBeCloseTo(T.min_wall_mm(params) / scale, 9);
      expect(th.min_gap).toBeCloseTo(T.min_gap_mm(params) / scale, 9);
      expect(th.min_detail).toBeCloseTo(T.min_detail_mm(params) / scale, 9);
    }
    // 04's own worked numbers at the default nozzle.
    expect(T.min_wall_mm(p())).toBeCloseTo(0.8, 12);
    expect(T.min_gap_mm(p())).toBeCloseTo(0.6, 12);
    expect(T.min_detail_mm(p())).toBeCloseTo(0.4, 12);
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

  it("defaults every hero accessor to v1 behaviour", () => {
    const stock = p();
    expect(T.hero_ids(stock)).toEqual([]);
    expect(T.hero_mode(stock)).toBe("true_height");
    expect(T.hero_true_height(stock)).toBe(true);
    expect(T.hero_own_color(stock)).toBe(false);
    expect(T.hero_height_ids(stock).size).toBe(0);
    expect(T.is_hero_id("w1", stock)).toBe(false);
    expect(T.building_is_hero({ id: "w1", height_m: 100, is_tall: true }, stock)).toBe(
      false,
    );
    expect(T.color_mode(stock)).toBe("single");
    expect(T.parts_mode(stock)).toBe(false);
  });

  it("splits hero height from hero colour by mode", () => {
    const ids = ["w1", "w2"];
    const table: Array<[PrintParams["hero_mode"], boolean, boolean]> = [
      ["true_height", true, false],
      ["own_color", false, true],
      ["both", true, true],
    ];
    for (const [hero_mode, height, colour] of table) {
      const params = p({ hero_building_ids: ids, hero_mode });
      expect(T.hero_true_height(params)).toBe(height);
      expect(T.hero_own_color(params)).toBe(colour);
      // is_hero_id is mode-independent: "did the user pick it?", which is what
      // the bake's Stage 1 block-merge exemption keys off.
      expect(T.is_hero_id("w1", params)).toBe(true);
      expect(T.is_hero_id("w9", params)).toBe(false);
      expect(T.hero_height_ids(params).size).toBe(height ? 2 : 0);
      expect(T.building_is_hero({ id: "w1", height_m: 10, is_tall: false }, params)).toBe(
        height,
      );
      // A carrier with no id (a merged block) is never a hero.
      expect(T.building_is_hero({ height_m: 10, is_tall: false }, params)).toBe(false);
    }
  });

  it("never prints a hero below its true height but still grows it", () => {
    const scale = 0.1;
    const tall = { id: "hero", height_m: 200, is_tall: true };
    const halved = p({ small_scale: 0.5, large_scale: 0.5, hero_building_ids: ["hero"] });
    expect(T.building_height_scale(tall, halved)).toBe(0.5);
    expect(T.hero_height_scale(tall, halved)).toBe(1.0);
    expect(T.building_height_scale_for(tall, halved, true)).toBe(1.0);
    expect(T.building_height_scale_for(tall, halved, false)).toBe(0.5);
    const doubled = p({ small_scale: 1.5, large_scale: 2.0, hero_building_ids: ["hero"] });
    expect(T.hero_height_scale(tall, doubled)).toBe(2.0);
    expect(T.hero_height_scale({ ...tall, is_tall: false }, doubled)).toBe(1.5);

    expect(T.building_top_mm_for(tall, halved, scale, false)).toBeCloseTo(13.0, 9);
    expect(T.building_top_mm_for(tall, halved, scale, true)).toBeCloseTo(23.0, 9);
    expect(T.building_top_mm(tall, halved, scale)).toBe(
      T.building_top_mm_for(tall, halved, scale, false),
    );
    // the 0.6 mm clamp still applies to a hero
    expect(
      T.building_top_mm_for({ id: "hero", height_m: 2, is_tall: false }, halved, scale, true),
    ).toBeCloseTo(3.6, 9);
  });

  it("counts a hero at its hero height in the 60 mm guard", () => {
    const scene = {
      buildings: [
        { id: "w1", height_m: 10, is_tall: false },
        { id: "tower", height_m: 600, is_tall: true },
      ],
      trees: [],
    };
    const halved = p({ frame: false, small_scale: 0.5, large_scale: 0.5 });
    expect(T.predicted_top_mm(scene, halved, 900)).toBeCloseTo(33.0, 9);
    expect(T.model_too_tall(scene, halved, 900)).toBe(false);

    const hero = p({
      frame: false,
      small_scale: 0.5,
      large_scale: 0.5,
      hero_building_ids: ["tower"],
    });
    expect(T.predicted_top_mm(scene, hero, 900)).toBeCloseTo(63.0, 9);
    expect(T.model_too_tall(scene, hero, 900)).toBe(true);

    // own_color raises no height, so it refuses nothing either.
    const colourOnly = p({
      frame: false,
      small_scale: 0.5,
      large_scale: 0.5,
      hero_building_ids: ["tower"],
      hero_mode: "own_color",
    });
    expect(T.predicted_top_mm(scene, colourOnly, 900)).toBeCloseTo(33.0, 9);
    expect(T.model_too_tall(scene, colourOnly, 900)).toBe(false);
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
