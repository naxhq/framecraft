/**
 * The detail advisor's presentation layer and its two real actions.
 *
 * `lib/transform.test.ts` pins the SCORE against `fixtures/parity-expected.json`
 * (it is mirrored in `app/geom/transform.py`). This file pins what the viewport
 * does with it: that the chip says the band in words as well as in a colour,
 * that a button is only offered when the shared math's own sentence offers that
 * remedy, that "Use N m" goes down exactly the path a radius slider release
 * goes down, and that the memo key names every parameter the report reads.
 */

import { describe, expect, it, vi } from "vitest";

import {
  advisorDeps,
  applyAdvisorAction,
  detailAdvice,
  showsRecommendation,
} from "./advisor";
import { DEFAULT_PRINT_PARAMS, defaultPrintParams } from "./contracts";
import type { AreaFeature, Building, PrintParams, SceneGraph } from "./contracts";
import * as T from "./transform";

/** A square footprint `side` metres on a side, at `x` metres east. */
function building(id: string, side: number, x = 0): Building {
  return {
    id,
    ring: [
      [x, 0],
      [x + side, 0],
      [x + side, side],
      [x, side],
    ] as Array<[number, number]>,
    holes: [],
    height_m: 20,
    height_source: "tag",
    min_height_m: 0,
    is_tall: false,
  };
}

function patch(side: number): AreaFeature {
  return {
    ring: [
      [0, 0],
      [side, 0],
      [side, side],
      [0, side],
    ] as Array<[number, number]>,
    holes: [],
  };
}

function graphOf(sides: number[], radius = 900): SceneGraph {
  return {
    bounds: { min_x: -radius, min_y: -radius, max_x: radius, max_y: radius },
    center: { lat: 41.8827, lon: -87.6233 },
    buildings: sides.map((side, index) => building(`w${index}`, side, index * 60)),
    roads: [],
    water: [patch(400)],
    green: [patch(2)],
    // Big enough to print at the default plate, so turning trees off really
    // moves `trees_dropped_fraction` -- without them the `trees` dependency
    // would be asserted against a scene that has none.
    trees: [
      { x: 0, y: 0, radius_m: 8 },
      { x: 30, y: 30, radius_m: 8 },
    ],
    stats: { building_count: sides.length, coverage: "good", height_tag_ratio: 0.5 },
  };
}

/** Big footprints: nothing needs widening, so the band is `good`. */
const HEALTHY = graphOf([60, 70, 80, 90]);
/**
 * Ordinary 12 m footprints. At a 3000 m radius on a 100 mm plate the minimum
 * wall is 54 m of ground and every one of them is widened; a tighter crop fixes
 * it, so this is the scene the advisor has something useful to say about.
 */
const DAMAGED = graphOf([12, 12, 12, 12, 12, 12], 3000);
/**
 * One-metre footprints: under the minimum wall at EVERY radius and plate the
 * contract allows, so no remedy exists and none may be offered.
 */
const HOPELESS = graphOf([1, 1, 1, 1, 1, 1]);

const params = (overrides: Partial<PrintParams> = {}): PrintParams => ({
  ...defaultPrintParams(),
  ...overrides,
});

describe("detailAdvice", () => {
  it("is null without a scene, or without a measurable radius", () => {
    expect(detailAdvice(null, params(), 900)).toBeNull();
    expect(detailAdvice(HEALTHY, params(), null)).toBeNull();
    expect(detailAdvice(HEALTHY, params(), 0)).toBeNull();
  });

  it("reports exactly the shared report's score and band", () => {
    const report = T.detail_report(HEALTHY, params(), 900);
    const advice = detailAdvice(HEALTHY, params(), 900);
    expect(advice?.chip.score).toBe(report.score);
    expect(advice?.chip.band).toBe(report.band);
    expect(advice?.report).toEqual(report);
  });

  it("says the band in words, not only in a colour", () => {
    // WCAG 1.4.1: colour may not be the only way information is conveyed. The
    // word is in the value the strip renders, not in a tooltip.
    const good = detailAdvice(HEALTHY, params(), 900);
    expect(good?.chip.band).toBe("good");
    expect(good?.chip.value).toContain("good");
    expect(good?.chip.tone).toBe("positive");

    const poor = detailAdvice(DAMAGED, params({ plate_mm: 100 }), 3000);
    expect(poor?.chip.value).toContain(poor?.chip.band as string);
    expect(poor?.chip.ariaLabel).toContain("out of 100");
  });

  it("maps each band onto one of the editor's own state tokens", () => {
    const seen = new Map<string, string>();
    for (const [scene, view, radius] of [
      [HEALTHY, params(), 900],
      [DAMAGED, params(), 900],
      [DAMAGED, params({ plate_mm: 100 }), 3000],
    ] as Array<[SceneGraph, PrintParams, number]>) {
      const advice = detailAdvice(scene, view, radius);
      if (advice) seen.set(advice.chip.band, advice.chip.tone);
    }
    // Not vacuous: these three cases really do reach more than one band.
    expect(seen.size).toBeGreaterThan(1);
    for (const [band, tone] of seen) {
      expect(["positive", "warn", "danger"], band).toContain(tone);
    }
  });

  it("says nothing at all when the city survives intact", () => {
    const advice = detailAdvice(HEALTHY, params(), 900);
    expect(advice?.sentence).toBeNull();
    expect(advice?.actions).toEqual([]);
    expect(showsRecommendation(advice?.chip.band as string)).toBe(false);
  });

  it("carries the shared math's sentence verbatim when there is damage", () => {
    const view = params({ plate_mm: 100 });
    const advice = detailAdvice(DAMAGED, view, 3000);
    expect(advice?.sentence).toBe(T.detail_recommendation(DAMAGED, view, 3000));
    expect(advice?.sentence).toContain("Radius 3000 m at plate 100");
    expect(showsRecommendation(advice?.chip.band as string)).toBe(true);
  });

  it("offers only the remedies the sentence itself names", () => {
    const view = params({ plate_mm: 100 });
    const advice = detailAdvice(DAMAGED, view, 3000);
    const sentence = advice?.sentence ?? "";
    for (const action of advice?.actions ?? []) {
      // Every button's number appears in the sentence it sits under: a button
      // offering something the sentence did not is a second opinion.
      expect(sentence, action.label).toContain(String(action.value));
      if (action.kind === "radius") expect(action.value).toBeLessThan(3000);
      if (action.kind === "plate") expect(action.value).toBeGreaterThan(100);
    }
    expect(advice?.actions.length).toBeGreaterThan(0);
  });

  it("never offers a change in the unhelpful direction", () => {
    // Already on the biggest plate and the tightest crop the contract allows,
    // and still losing every footprint: "use a bigger plate" and "use a smaller
    // radius" are not advice. The sentence says so instead.
    const view = params({ plate_mm: T.PLATE_MAX_MM });
    const advice = detailAdvice(HOPELESS, view, T.RADIUS_MIN_M);
    expect(advice?.sentence, "the case is meant to be a damaged one").not.toBeNull();
    expect(advice?.sentence).toContain("No radius or plate in range fixes it");
    expect(advice?.actions).toEqual([]);
  });

  it("labels the buttons in the interface's voice, and names what they do", () => {
    const advice = detailAdvice(DAMAGED, params({ plate_mm: 100 }), 3000);
    for (const action of advice?.actions ?? []) {
      expect(action.label).toMatch(/^Use /);
      // The visible label is short; the accessible name says what changes.
      expect(action.ariaLabel.length).toBeGreaterThan(action.label.length);
      expect(action.ariaLabel).toContain(String(action.value));
    }
  });
});

describe("applyAdvisorAction", () => {
  it("takes a radius down the same path a slider release takes", () => {
    // `setRadius` marks the scene stale and retires a finished bake; `generate`
    // is the one POST /scene. Both, in that order, or the editor would either
    // fetch the old radius or not fetch at all.
    const calls: string[] = [];
    applyAdvisorAction(
      { kind: "radius", value: 540, label: "Use 540 m", ariaLabel: "" },
      {
        setRadius: (metres) => calls.push(`setRadius:${metres}`),
        generate: () => calls.push("generate"),
        setParam: (key, value) => calls.push(`setParam:${key}:${value}`),
      },
    );
    expect(calls).toEqual(["setRadius:540", "generate"]);
  });

  it("writes a plate as a plain parameter, and never fetches", () => {
    const generate = vi.fn();
    const calls: string[] = [];
    applyAdvisorAction(
      { kind: "plate", value: 256, label: "Use plate 256", ariaLabel: "" },
      {
        setRadius: () => calls.push("setRadius"),
        generate,
        setParam: (key, value) => calls.push(`setParam:${key}:${value}`),
      },
    );
    expect(calls).toEqual(["setParam:plate_mm:256"]);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("advisorDeps", () => {
  /** A different-from-default value for every non-boolean PrintParams key. */
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
    engravings: [{ edge: "bottom", text: "{city}" }],
    north_arrow: { enabled: true },
    scale_bar: { enabled: true },
    hanger: "keyhole",
    underside_mark: { enabled: true },
    hero_building_ids: ["w0"],
    hero_mode: "both",
  };

  it("has a moved value for every non-boolean parameter", () => {
    for (const key of Object.keys(DEFAULT_PRINT_PARAMS) as Array<keyof PrintParams>) {
      if (typeof DEFAULT_PRINT_PARAMS[key] === "boolean") continue;
      expect(MOVES[key], `${key} has no moved value in MOVES`).toBeDefined();
    }
  });

  it("names every parameter that moves the report", () => {
    const base = defaultPrintParams();
    const before = advisorDeps(DAMAGED, base, 900);
    const reference = T.detail_report(DAMAGED, base, 900);
    for (const key of Object.keys(DEFAULT_PRINT_PARAMS) as Array<keyof PrintParams>) {
      const moved: PrintParams = { ...base };
      (moved as unknown as Record<string, unknown>)[key] =
        typeof DEFAULT_PRINT_PARAMS[key] === "boolean"
          ? !DEFAULT_PRINT_PARAMS[key]
          : MOVES[key];
      const listed = advisorDeps(DAMAGED, moved, 900).some(
        (value, index) => !Object.is(value, before[index]),
      );
      const moves =
        JSON.stringify(T.detail_report(DAMAGED, moved, 900)) !==
        JSON.stringify(reference);
      if (moves) expect(listed, `${key} moves the report but is not a dep`).toBe(true);
    }
  });

  it("names nothing the report cannot read", () => {
    // The other direction, and the one the audit caught missing: `road_scale`
    // and `params.water` were listed although `detail_report` never mentions
    // roads and walks `scene.water` unconditionally, so every road-width tick
    // re-ran a whole-scene walk for a byte-identical answer.
    const base = defaultPrintParams();
    const probes: Array<[SceneGraph, PrintParams, number]> = [
      [DAMAGED, base, 3000],
      [DAMAGED, params({ plate_mm: 100 }), 3000],
      [HEALTHY, base, 900],
      [HOPELESS, base, 900],
    ];
    const moves = (key: keyof PrintParams, value: unknown): boolean =>
      probes.some(([scene, view, radius]) => {
        const moved: PrintParams = { ...view };
        (moved as unknown as Record<string, unknown>)[key] = value;
        return (
          JSON.stringify(T.detail_report(scene, moved, radius)) !==
          JSON.stringify(T.detail_report(scene, view, radius))
        );
      });

    // Every PrintParams field named by the key, and the two arguments beside
    // them, must be able to change the answer on at least one real scene.
    const listed = advisorDeps(DAMAGED, base, 900);
    expect(listed).toHaveLength(6);
    for (const [key, value] of [
      ["plate_mm", 100],
      ["frame", false],
      ["nozzle_mm", 1.2],
      ["trees", false],
    ] as Array<[keyof PrintParams, unknown]>) {
      expect(moves(key, value), `${key} is a dep that cannot move the report`).toBe(
        true,
      );
    }
    // ...and the two that were removed still cannot, which is why they went.
    expect(moves("road_scale", 2.0)).toBe(false);
    expect(moves("water", false)).toBe(false);
    for (const key of ["road_scale", "water"] as const) {
      const after = advisorDeps(DAMAGED, { ...base, [key]: key === "water" ? false : 2 }, 900);
      expect(
        listed.some((value, i) => !Object.is(value, after[i])),
        `${key} is still in advisorDeps`,
      ).toBe(false);
    }
  });

  it("is not moved by a height slider", () => {
    const base = defaultPrintParams();
    const before = advisorDeps(DAMAGED, base, 900);
    for (const key of ["small_scale", "large_scale", "base_thickness_mm"] as const) {
      const after = advisorDeps(DAMAGED, { ...base, [key]: 1.5 }, 900);
      expect(before.some((value, i) => !Object.is(value, after[i])), key).toBe(false);
    }
  });

  it("names only primitives and the graph", () => {
    const base = defaultPrintParams();
    for (const value of advisorDeps(DAMAGED, base, 900)) {
      if (value === DAMAGED) continue;
      expect(value === null || typeof value !== "object").toBe(true);
      expect(value).not.toBe(base);
    }
  });

  it("follows the radius, which is the thing the advice is about", () => {
    const base = defaultPrintParams();
    expect(
      advisorDeps(DAMAGED, base, 900).some(
        (value, i) => !Object.is(value, advisorDeps(DAMAGED, base, 1500)[i]),
      ),
    ).toBe(true);
  });
});
