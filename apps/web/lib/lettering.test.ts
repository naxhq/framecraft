/**
 * TS <-> Python parity for the frame lettering and ornament LAYOUT.
 *
 * `fixtures/lettering-expected.json` is dumped by
 * `services/bake/tests/test_lettering.py` from `app/geom/transform.py`; this
 * file recomputes every case with `lib/transform.ts` and asserts agreement.
 * Numbers are compared within 0.01 mm (the project's print tolerance, CLAUDE.md)
 * and everything else -- faces, refusals, reasons, warning strings, the scale
 * bar's chosen round number and its label -- has to match exactly, because a
 * preview that draws text at a different size, on a different edge, or that
 * shows text the bake refuses, is the failure this fixture exists to prevent.
 *
 * If this test fails, one of the two implementations changed without the other.
 * Fix the code, not the tolerance.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PARAM_RANGES } from "./contracts";
import type { PrintParams } from "./contracts";
import type { TokenContext } from "./tokens";
import * as T from "./transform";

const MM_TOLERANCE = 0.01;

interface LetteringCase {
  name: string;
  params: PrintParams;
  ctx: TokenContext;
  rotation_deg: number;
  layout: Record<string, unknown>;
}

const expected = JSON.parse(
  readFileSync(new URL("../../../fixtures/lettering-expected.json", import.meta.url), "utf8"),
) as { cases: LetteringCase[] };

/** Deep-compare a layout dump: numbers within 0.01 mm, everything else exact. */
function agrees(actual: unknown, want: unknown, path: string): void {
  if (typeof want === "number") {
    expect(typeof actual, `${path}: expected a number`).toBe("number");
    expect(
      Math.abs((actual as number) - want),
      `${path}: ${String(actual)} vs ${want}`,
    ).toBeLessThanOrEqual(MM_TOLERANCE);
    return;
  }
  if (Array.isArray(want)) {
    expect(Array.isArray(actual), `${path}: expected an array`).toBe(true);
    const got = actual as unknown[];
    expect(got.length, `${path}.length`).toBe(want.length);
    want.forEach((item, i) => agrees(got[i], item, `${path}[${i}]`));
    return;
  }
  if (want !== null && typeof want === "object") {
    expect(actual !== null && typeof actual === "object", `${path}: expected an object`).toBe(
      true,
    );
    const got = actual as Record<string, unknown>;
    const wantObj = want as Record<string, unknown>;
    expect(Object.keys(got).sort(), `${path}: keys`).toEqual(Object.keys(wantObj).sort());
    for (const key of Object.keys(wantObj)) {
      agrees(got[key], wantObj[key], `${path}.${key}`);
    }
    return;
  }
  expect(actual, path).toEqual(want);
}

describe("the lettering fixture", () => {
  it("covers every branch the mirror could get wrong", () => {
    const names = expected.cases.map((c) => c.name);
    expect(names.length).toBeGreaterThanOrEqual(13);
    for (const needed of [
      "every-edge",
      "aligns-on-one-edge",
      "auto-fit-shrinks",
      "refused-counters",
      "north-arrow-ne-rotated",
      "north-arrow-nw-rotated",
      "north-arrow-sw-rotated",
      "scale-bar-auto-chicago",
      "scale-bar-auto-wide",
      "scale-bar-fixed-clamped",
      "underside-and-hanger",
      "frame-off-skips-the-lip",
      "fat-nozzle-refuses-everything",
    ]) {
      expect(names, `missing case ${needed}`).toContain(needed);
    }
    // ... and the cases really differ: one refusal, one shrink, one mirror.
    const byName = Object.fromEntries(expected.cases.map((c) => [c.name, c]));
    const refused = byName["refused-counters"].layout as {
      engravings: Array<{ fit: { refused: boolean } }>;
    };
    expect(refused.engravings[0].fit.refused).toBe(true);
    expect(refused.engravings[1].fit.refused).toBe(false);
    const mark = byName["underside-and-hanger"].layout as {
      underside_mark: { placement: { mirror_x: boolean } };
    };
    expect(mark.underside_mark.placement.mirror_x).toBe(true);
  });
});

describe.each(expected.cases)("lettering parity: $name", (testCase) => {
  it("lays the text out exactly where the bake cuts it", () => {
    const fresh = T.lettering_layout_json(
      testCase.params,
      testCase.ctx,
      testCase.rotation_deg,
    );
    agrees(fresh, testCase.layout, testCase.name);
  });
});

describe("lettering unit behaviour (mirrors test_lettering.py)", () => {
  const p = (overrides: Partial<PrintParams> = {}): PrintParams =>
    ({
      ...(JSON.parse(
        readFileSync(
          new URL("../../../fixtures/print-params-default.json", import.meta.url),
          "utf8",
        ),
      ) as PrintParams),
      ...overrides,
    }) as PrintParams;

  it("applies the CONTRACT'S engraving defaults, not its own", () => {
    // Every member of an Engraving is optional on the wire, so transform.ts
    // fills them in by hand.  They have to be the generated contract's numbers:
    // the size default moved from 3.0 to 4.0 because 3.0 refused six of eight
    // real strings in the default face (v2-03 audit, finding 4), and a mirror
    // left behind would seed the preview at a size the bake will not cut.
    expect(T.ENGRAVING_DEFAULT_SIZE_MM).toBe(PARAM_RANGES.engravings.size_mm.default);
    expect(T.ENGRAVING_DEFAULT_DEPTH_MM).toBe(PARAM_RANGES.engravings.depth_mm.default);
    expect(T.ENGRAVING_DEFAULT_SIZE_MM).toBeGreaterThanOrEqual(
      PARAM_RANGES.engravings.size_mm.min,
    );
    expect(T.ENGRAVING_DEFAULT_SIZE_MM).toBeLessThanOrEqual(
      PARAM_RANGES.engravings.size_mm.max,
    );
  });

  it("reads every edge the way a viewer facing the wall does", () => {
    expect(T.EDGE_ROTATION_DEG.top).toBe(0);
    expect(T.EDGE_ROTATION_DEG.bottom).toBe(0);
    expect(T.EDGE_ROTATION_DEG.left).toBe(90);
    expect(T.EDGE_ROTATION_DEG.right).toBe(-90);
    // The up vector is R(rotation) * (0, 1) on every edge.
    for (const [edge, want] of [
      ["top", [0, 1]],
      ["bottom", [0, 1]],
      ["left", [-1, 0]],
      ["right", [1, 0]],
    ] as Array<[string, [number, number]]>) {
      const [ux, uy] = T.edge_up(edge);
      expect(ux).toBeCloseTo(want[0], 12);
      expect(uy).toBeCloseTo(want[1], 12);
    }
  });

  it("turns the north arrow WITH the scene's own rotation", () => {
    // `project.LocalFrame.to_local` rotates the ground COUNTER-CLOCKWISE by
    // +rotation_deg, so north lands at bearing -rotation and an arrow drawn on
    // +y has to be turned by +rotation to meet it.  This test used to pin -29,
    // which put the preview's arrow 58 deg out and due south at rotation 90
    // (v2-03 audit, finding 1); the bake's own test now derives the answer from
    // the projection instead of from the formula under test.
    for (const rotation of [0, 29, 90, 180, 271]) {
      const layout = T.north_arrow_layout(
        p({ north_arrow: { enabled: true, corner: "ne", size_mm: 4 } }),
        rotation,
        true,
      );
      expect(layout.placement.rotation_deg).toBe(rotation);
      expect(layout.placement.anchor_x).toBeGreaterThan(0);
      expect(layout.placement.anchor_y).toBeGreaterThan(0);
    }
  });

  it("refuses every edge engraving when the frame is off, and says so once", () => {
    const params = p({
      frame: false,
      engravings: [
        { edge: "top", text: "AB", size_mm: 6, mode: "engrave", depth_mm: 0.6, align: "center", font: "sans" },
        { edge: "bottom", text: "CD", size_mm: 6, mode: "emboss", depth_mm: 0.6, align: "center", font: "sans" },
      ],
      north_arrow: { enabled: true, corner: "ne", size_mm: 4 },
    });
    const layout = T.lettering_layout(params, expected.cases[0].ctx, 0);
    expect(layout.engravings.map((e) => e.fit.refused)).toEqual([true, true]);
    for (const e of layout.engravings) {
      expect(e.fit.reason).toContain("no lip");
    }
    expect(layout.north_arrow.enabled).toBe(false);
    // one switch, one warning: the per-engraving lines are folded into it
    expect(layout.warnings.filter((w) => w.includes("the frame is off"))).toHaveLength(1);
  });

  it("picks the longest 1-2-5 bar that fits the printed window", () => {
    expect(T.scale_bar_auto_length_m(168 / 1800)).toBe(200);
    expect(T.scale_bar_auto_length_m(168 / 3960)).toBe(500);
    expect(T.scale_bar_auto_length_m(0.02)).toBe(2000);
    expect(T.scale_bar_label(200)).toBe("200 m");
    expect(T.scale_bar_label(2000)).toBe("2 km");
    expect(T.scale_bar_label(2500)).toBe("2.5 km");
    for (const radius of [250, 900, 1980, 3000]) {
      for (const plate of [100, 180, 256]) {
        const scale = T.scale_mm_per_m(p({ plate_mm: plate }), radius);
        const printed = T.scale_bar_auto_length_m(scale) * scale;
        expect(printed).toBeGreaterThanOrEqual(T.SCALE_BAR_MIN_MM);
        expect(printed).toBeLessThanOrEqual(T.SCALE_BAR_MAX_MM);
      }
    }
  });

  it("predicts the bake's refusal of a base too thin for its pockets", () => {
    expect(T.hanger_min_base_mm("none")).toBe(0);
    expect(T.hanger_min_base_mm("keyhole")).toBe(T.KEYHOLE_DEPTH_MM + T.HANGER_MIN_ROOF_MM);
    expect(T.hanger_min_base_mm("magnets")).toBe(T.MAGNET_DEPTH_MM + T.HANGER_MIN_ROOF_MM);
    expect(T.underside_mark_min_base_mm()).toBe(
      T.UNDERSIDE_MARK_DEPTH_MM + T.HANGER_MIN_ROOF_MM,
    );
    // The composite adds what a recess has already taken off the top.
    const keyhole = p({ hanger: "keyhole" });
    expect(T.deepest_recess_mm(keyhole)).toBeCloseTo(0.6, 12);
    expect(T.underside_min_base_mm(keyhole)).toBeCloseTo(3.6, 12);
    const dry = p({ hanger: "keyhole", water: false, road_mode: "off" });
    expect(T.underside_min_base_mm(dry)).toBeCloseTo(3.0, 12);
    expect(T.underside_min_base_mm(p())).toBe(0);
  });

  it("knows when the lip is not there to carry anything", () => {
    expect(T.frame_text_available(p())).toBe(true);
    expect(T.frame_text_available(p({ frame: false }))).toBe(false);
  });

  it("targets one nozzle for a groove and two for raised material", () => {
    const params = p();
    expect(T.text_stroke_target_mm(params, "engrave")).toBe(T.min_detail_mm(params));
    expect(T.text_stroke_target_mm(params, "emboss")).toBe(T.min_wall_mm(params));
  });

  it("drops characters the shared metrics cannot lay out", () => {
    const [kept, dropped] = T.filter_text("sans", "Tokyo 東京");
    expect(kept).toBe("Tokyo ");
    expect(dropped).toBe("東京");
  });
});
