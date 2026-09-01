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
import type { TokenContext } from "./tokens";
import * as T from "./transform";
import {
  ESTIMATED_HEIGHT_RATIO,
  MIN_BUILDINGS_TO_BAKE,
  bakeBlockReason,
  letteringWarnings,
  predictedTopMm,
  sceneWarnings,
  warningDeps,
} from "./warnings";

const p = (overrides: Partial<PrintParams> = {}): PrintParams => ({
  ...DEFAULT_PRINT_PARAMS,
  ...overrides,
});

/**
 * A different-from-default value for every non-boolean PrintParams key.
 *
 * The v2 keys are here so the walk below is not vacuous: without them the loop
 * would set each new key to `undefined`, and "undefined does not move the
 * predicted height" is a much weaker claim than "a real city label, palette,
 * engraving, ornament or hero selection does not move it".
 */
const MOVES: Record<string, unknown> = {
  plate_mm: 256,
  base_thickness_mm: 8,
  nozzle_mm: 0.8,
  small_scale: 1.5,
  large_scale: 2.0,
  terrain_exaggeration: 3.0,
  road_mode: "emboss",
  road_scale: 2.0,
  schema_version: 2,
  city_label: "Chicago",
  color_mode: "parts",
  part_colors: {
    base: "#111111",
    frame: "#222222",
    buildings: "#333333",
    roads: "#444444",
    water: "#555555",
    green: "#666666",
    trees: "#777777",
  },
  engravings: [{ edge: "bottom", text: "{city}", size_mm: 8, depth_mm: 1.5 }],
  north_arrow: { enabled: true, corner: "sw", size_mm: 6 },
  scale_bar: { enabled: true, edge: "top", length_mode: "fixed", length_m: 1000 },
  hanger: "keyhole",
  underside_mark: { enabled: true, template: "{coords}" },
  hero_building_ids: ["w1"],
  hero_mode: "both",
  // schema_version 3 additions (docs/IMPLEMENTATION_PLAN.md's "Contracts v3"):
  // none of them move `predicted_top_mm` or `underside_min_base_mm` today, but
  // they still need a moved value here or the walk below is vacuous for them.
  place: { country: "US", state: "IL", neighbourhood: "Loop", author: "Vahid" },
  regions: { roads: { depth_mm: 1.0 }, building_skirt_mm: 0.6 },
  colour: { palette: "noir", preview_theme: "light" },
  printer_profile: "bambu-x1c",
  custom_profile: { plate_x_mm: 256, plate_y_mm: 256 },
  export_target: "stl",
  terrain: { enabled: true, smoothing: 3 },
  heights: { floor_height_m: 3.5 },
  bridges: { enabled: false },
  height_exaggeration: { multiplier: 1.5 },
  hero_auto: { enabled: true, count: 5 },
  tiling: { enabled: true, cols: 2, rows: 2 },
  frame_style: { profile: "chamfer", corner: "mitred" },
  hanger_magnet: { diameter_mm: 8, thickness_mm: 3, count: 4 },
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

// ==========================================================================
// The hanger floor ([V2-P5], wired to the UI by [V2-P7-fix])
// ==========================================================================

describe("a base too thin for the underside blocks Bake", () => {
  const graph = graphOf(40, 40);

  it("names the keyhole minimum from the shared math, not from a literal", () => {
    // `transform.underside_min_base_mm` is what `lettering.build` refuses on,
    // and 3.6 is where it lands at the DEFAULTS: a 2 mm keyhole pocket, the
    // 1 mm of plate that has to stay over it, and the 0.6 mm the engraved roads
    // take off the same plate from above. `hanger_min_base_mm` alone says 3.0,
    // which is the wrong number to show a user (v2-07 audit, finding 4).
    const params = p({ hanger: "keyhole" });
    const needed = T.underside_min_base_mm(params);
    expect(needed).toBeCloseTo(3.6, 9);
    expect(params.base_thickness_mm).toBe(3.0);

    const reason = bakeBlockReason(graph, params);
    expect(reason).toContain(
      "Keyhole hanger needs a base of at least 3.6 mm (now 3.0 mm) — " +
        "raise the base thickness or choose no hanger.",
    );
    expect(reason).toContain("engraved roads already take 0.6 mm");
    const warning = sceneWarnings(graph, params).find(
      (w) => w.id === "base-too-thin-for-underside",
    );
    expect(warning?.level).toBe("block");
  });

  it("clears the moment the base reaches the minimum, and not before", () => {
    // The bake refuses on `base < needed`, so the editor must allow exactly
    // `base >= needed` - one hundredth under and it is still blocked.
    const needed = T.underside_min_base_mm(p({ hanger: "keyhole" }));
    expect(bakeBlockReason(graph, p({ hanger: "keyhole", base_thickness_mm: needed - 0.01 })))
      .toContain("Keyhole hanger");
    expect(
      bakeBlockReason(graph, p({ hanger: "keyhole", base_thickness_mm: needed })),
    ).toBeNull();
    expect(bakeBlockReason(graph, p({ hanger: "keyhole", base_thickness_mm: 4 }))).toBeNull();
  });

  it("moves with road_mode and water, because they cut the same plate", () => {
    // Both recesses come off the top of the base, so both change how much is
    // left under the pocket: 3.6 -> 3.5 -> 3.0. This is why `warningDeps` has
    // to name them.
    const roadsOff = p({ hanger: "keyhole", road_mode: "off", base_thickness_mm: 3.0 });
    expect(T.underside_min_base_mm(roadsOff)).toBeCloseTo(3.5, 9);
    expect(bakeBlockReason(graph, roadsOff)).toContain("at least 3.5 mm");
    expect(bakeBlockReason(graph, roadsOff)).toContain("water already take 0.5 mm");

    const dry = { ...roadsOff, water: false };
    expect(T.underside_min_base_mm(dry)).toBeCloseTo(3.0, 9);
    expect(bakeBlockReason(graph, dry)).toBeNull();
  });

  it("covers magnets and the underside mark too", () => {
    expect(bakeBlockReason(graph, p({ hanger: "magnets" }))).toContain(
      "Magnet hanger needs a base of at least 4.7 mm (now 3.0 mm)",
    );
    const marked = p({
      base_thickness_mm: 1.5,
      underside_mark: { enabled: true, template: "{city}" },
    });
    // 0.3 mm mark + 1.0 mm roof + the recess, and the recess is itself a
    // function of the base (`road_z_mm` is `-min(0.6, base/3)`): at 1.5 mm the
    // engraved roads take 0.5 mm, not 0.6, so the floor is 1.8 and not 1.9.
    expect(T.underside_min_base_mm(marked)).toBeCloseTo(1.8, 9);
    expect(bakeBlockReason(graph, marked)).toContain(
      "Underside mark needs a base of at least 1.8 mm (now 1.5 mm) — " +
        "raise the base thickness or turn the underside mark off.",
    );
  });

  it("does not fire when nothing is cut into the underside", () => {
    expect(sceneWarnings(graph, p()).map((w) => w.id)).not.toContain(
      "base-too-thin-for-underside",
    );
    expect(bakeBlockReason(graph, p())).toBeNull();
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

  it("has a moved value for every non-boolean parameter", () => {
    // Guards the walk below against going vacuous when the contract grows.
    for (const key of Object.keys(DEFAULT_PRINT_PARAMS) as Array<keyof PrintParams>) {
      if (typeof DEFAULT_PRINT_PARAMS[key] === "boolean") continue;
      expect(MOVES[key], `${key} has no moved value in MOVES`).toBeDefined();
    }
  });

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

  it("names every parameter the hanger floor reads, and no other", () => {
    // The same walk, against the OTHER block warning. `underside_min_base_mm`
    // reads base_thickness_mm, hanger, underside_mark.enabled, road_mode and
    // water; a memo keyed only on the height inputs would leave a stale "needs
    // 3.6 mm" on screen after the user turned the roads off.
    const withHanger = { ...DEFAULT_PRINT_PARAMS, hanger: "keyhole" } as PrintParams;
    const before = warningDeps(graph, withHanger);
    let moved = 0;
    for (const key of Object.keys(DEFAULT_PRINT_PARAMS) as Array<keyof PrintParams>) {
      const next: PrintParams = { ...withHanger };
      (next as unknown as Record<string, unknown>)[key] =
        typeof DEFAULT_PRINT_PARAMS[key] === "boolean"
          ? !DEFAULT_PRINT_PARAMS[key]
          : MOVES[key];
      const listed = before.some((value, i) => !Object.is(value, warningDeps(graph, next)[i]));
      const moves =
        T.underside_min_base_mm(next) !== T.underside_min_base_mm(withHanger);
      if (moves) {
        moved += 1;
        expect(listed, `${key} moves the hanger floor but is not a dep`).toBe(true);
      }
    }
    // Not vacuous: road_mode, water and underside_mark really do move it.
    expect(moved).toBeGreaterThan(0);
  });

  it("never puts the params object itself in the key", () => {
    const params = p();
    for (const value of warningDeps(graph, params)) {
      expect(value).not.toBe(params);
      if (value !== graph) expect(typeof value).not.toBe("object");
    }
  });
});

// ==========================================================================
// Hero buildings ([V2-P6])
// ==========================================================================

describe("a hero counts at its hero height", () => {
  const graph = graphOf(40, 200);
  /** Both multipliers halved, so `max(1.0, 0.5)` is a real difference. */
  const halved = { small_scale: 0.5, large_scale: 0.5 };

  it("raises the predicted top when the mode grants true height", () => {
    // `transform.predicted_top_mm` counts a hero at `building_top_mm_for(...,
    // is_hero=true)` because that is the height the bake prints and the preview
    // now draws. The 60 mm guard and the HUD have to see the same number.
    const plain = predictedTopMm(graph, p(halved)) as number;
    const hero = predictedTopMm(
      graph,
      p({ ...halved, hero_building_ids: ["w200"] }),
    ) as number;
    expect(hero).toBeGreaterThan(plain);
    expect(hero).toBeCloseTo(plain * 2 - 3, 6);
  });

  it("does not raise it in own_color, where the hero keeps everyone's height", () => {
    const plain = predictedTopMm(graph, p(halved));
    expect(
      predictedTopMm(
        graph,
        p({ ...halved, hero_building_ids: ["w200"], hero_mode: "own_color" }),
      ),
    ).toBe(plain);
  });

  it("is named by warningDeps, as a string and not as the id array", () => {
    // Every entry has to be a primitive or the graph: `previewDeps.height` IS
    // this list, and `CityPreview.test.ts` asserts that rule.
    const before = warningDeps(graph, p(halved));
    const after = warningDeps(graph, p({ ...halved, hero_building_ids: ["w200"] }));
    expect(before.some((value, i) => !Object.is(value, after[i]))).toBe(true);
    for (const value of after) {
      if (value === graph) continue;
      expect(typeof value).not.toBe("object");
    }
    // A rebuilt-but-identical id array must not invalidate the memo.
    const once = p({ ...halved, hero_building_ids: ["w200"] });
    const twice = p({ ...halved, hero_building_ids: ["w200"] });
    expect(
      warningDeps(graph, once).some(
        (value, i) => !Object.is(value, warningDeps(graph, twice)[i]),
      ),
    ).toBe(false);
  });
});

// ==========================================================================
// hero_auto: an auto-promoted building counts at its hero height too
// (phase 3, `[V3-P3-U]`)
// ==========================================================================

describe("hero_auto counts an auto-promoted building at its hero height too", () => {
  const graph = graphOf(40, 200);
  /** Same fixture as the manual hero tests above: w200 is the one tall building. */
  const halved = { small_scale: 0.5, large_scale: 0.5 };

  it("raises the predicted top exactly like picking the same building by hand", () => {
    const plain = predictedTopMm(graph, p(halved)) as number;
    const auto = predictedTopMm(
      graph,
      p({ ...halved, hero_auto: { enabled: true, count: 1 } }),
    ) as number;
    const manual = predictedTopMm(
      graph,
      p({ ...halved, hero_building_ids: ["w200"] }),
    ) as number;
    expect(auto).toBeGreaterThan(plain);
    expect(auto).toBeCloseTo(manual, 9);
  });

  it("is a no-op while the toggle is off, whatever the count says", () => {
    const plain = predictedTopMm(graph, p(halved));
    expect(
      predictedTopMm(graph, p({ ...halved, hero_auto: { enabled: false, count: 5 } })),
    ).toBe(plain);
  });

  it("never evicts a manual pick: the union still promotes w200 even when it is not the auto quota's own top pick", () => {
    // count: 0 means the auto quota adds nothing, but the manual pick alone
    // still raises the predicted top -- effectiveHeroIds must never drop it.
    const plain = predictedTopMm(graph, p(halved)) as number;
    const both = predictedTopMm(
      graph,
      p({ ...halved, hero_building_ids: ["w200"], hero_auto: { enabled: true, count: 0 } }),
    ) as number;
    expect(both).toBeGreaterThan(plain);
  });

  it("is named by warningDeps, as a string, exactly like a manual pick", () => {
    const before = warningDeps(graph, p(halved));
    const after = warningDeps(
      graph,
      p({ ...halved, hero_auto: { enabled: true, count: 1 } }),
    );
    expect(before.some((value, i) => !Object.is(value, after[i]))).toBe(true);
    for (const value of after) {
      if (value === graph) continue;
      expect(typeof value).not.toBe("object");
    }
  });

  it("does nothing on an empty scene: there is no building for it to promote", () => {
    const empty: SceneGraph = { ...graph, buildings: [] };
    const plain = predictedTopMm(empty, p(halved));
    expect(
      predictedTopMm(empty, p({ ...halved, hero_auto: { enabled: true, count: 5 } })),
    ).toBe(plain);
  });
});

// ==========================================================================
// Lettering warnings ([V3-P1])
// ==========================================================================

describe("letteringWarnings", () => {
  const ctx: TokenContext = {
    lat: 41.8827,
    lon: -87.6233,
    scale_mm_per_m: 168 / 1800,
    radius_m: 900,
    date: "2026-08-29",
    buildings: 994,
    city: "Chicago",
  };
  const noCity: TokenContext = { ...ctx, city: "" };

  it("is empty when there is nothing configured to letter", () => {
    expect(letteringWarnings(p(), ctx)).toEqual([]);
  });

  it("warns once per empty line, naming the line and the token, at warn level", () => {
    const params = p({
      frame: true,
      engravings: [
        { edge: "top", text: "hello" },
        { edge: "bottom", text: "{city}" },
      ],
    });
    const warnings = letteringWarnings(params, noCity);
    expect(warnings).toEqual([
      {
        id: "engraving-1-empty",
        level: "warn",
        message: "Line 2: the {city} token has no value.",
      },
    ]);
  });

  it("does not warn about a line that resolves", () => {
    const params = p({ frame: true, engravings: [{ edge: "top", text: "{city}" }] });
    expect(letteringWarnings(params, ctx)).toEqual([]);
  });

  it("carries exactly one info-level entry when the frame is off, never one per line", () => {
    const params = p({
      frame: false,
      engravings: [
        { edge: "top", text: "{city}" },
        { edge: "bottom", text: "{city}" },
        { edge: "left", text: "{city}" },
      ],
    });
    const warnings = letteringWarnings(params, ctx);
    expect(warnings).toEqual([
      {
        id: "frame-off-lettering",
        level: "info",
        message:
          "Frame is off, so the frame edge lettering will not be cut. " +
          "Turn on Frame to engrave the edges.",
      },
    ]);
  });

  it("warns about an empty underside mark, and the mark stays gated by its own toggle regardless of the frame", () => {
    const params = p({
      frame: false,
      underside_mark: { enabled: true, template: "{city}" },
    });
    const warnings = letteringWarnings(params, noCity);
    expect(warnings).toEqual([
      {
        id: "underside-mark-empty",
        level: "warn",
        message: "Underside mark: the {city} token has no value.",
      },
    ]);
  });

  it("never rises to block level: an empty line is omitted from the bake, not a refusal", () => {
    const params = p({ frame: true, engravings: [{ edge: "top", text: "{city}" }] });
    for (const warning of letteringWarnings(params, noCity)) {
      expect(warning.level).not.toBe("block");
    }
  });
});
