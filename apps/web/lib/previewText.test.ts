/**
 * The preview's lettering geometry.
 *
 * `lib/lettering.test.ts` pins the LAYOUT half of the shared contract (what
 * size, on which edge, refused or not) against `fixtures/lettering-expected
 * .json`. This file pins the other half: that the shapes actually drawn come
 * from that layout and stay where it put them.
 *
 * The load-bearing claim is the last suite: over every case in the committed
 * fixture, every vertex the preview draws lands on the 6 mm frame lip, inside
 * the usable length of its own edge, and nothing at all is drawn for a piece
 * the build refuses. A preview that shows text the build will not cut, or shows
 * it hanging off the frame, is exactly the preview/build divergence 01 calls the
 * worst failure mode.
 */

import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { defaultPrintParams } from "./contracts";
import type { PrintParams, SceneGraph } from "./contracts";
import monoGlyphs from "./fonts/mono.glyphs.json";
import sansGlyphs from "./fonts/sans.glyphs.json";
import serifGlyphs from "./fonts/serif.glyphs.json";
import { primeGlyphFace, resetGlyphFaces, type GlyphFace } from "./fontGlyphs";
import type { PreviewArea } from "./preview";
import {
  buildPreviewText,
  facesNeeded,
  glyphAreas,
  keyholeArea,
  magnetAreas,
  northArrowArea,
  offsetRing,
  placeArea,
  textParamsKey,
  textTokenContext,
  type PreviewTextModel,
} from "./previewText";
import type { TokenContext } from "./tokens";
import * as T from "./transform";

const ASSETS: Record<string, GlyphFace> = {
  sans: sansGlyphs as unknown as GlyphFace,
  serif: serifGlyphs as unknown as GlyphFace,
  mono: monoGlyphs as unknown as GlyphFace,
};

beforeAll(() => {
  resetGlyphFaces();
  for (const [face, asset] of Object.entries(ASSETS)) primeGlyphFace(face, asset);
});

const CTX: TokenContext = {
  lat: 41.8827,
  lon: -87.6233,
  scale_mm_per_m: 0.0933,
  radius_m: 900,
  date: "2026-08-30",
  buildings: 994,
  city: "Chicago",
};

function bounds(areas: ReadonlyArray<PreviewArea>): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const area of areas) {
    for (const contour of [area.outer, ...area.holes]) {
      for (let i = 0; i < contour.length; i += 2) {
        minX = Math.min(minX, contour[i]);
        maxX = Math.max(maxX, contour[i]);
        minY = Math.min(minY, contour[i + 1]);
        maxY = Math.max(maxY, contour[i + 1]);
      }
    }
  }
  return { minX, maxX, minY, maxY };
}

function ringPoints(contour: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < contour.length; i += 2) out.push([contour[i], contour[i + 1]]);
  return out;
}

function area2(contour: number[]): number {
  const points = ringPoints(contour);
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    total += a[0] * b[1] - b[0] * a[1];
  }
  return total / 2;
}

// ==========================================================================
// Glyph outlines
// ==========================================================================

describe("glyphAreas", () => {
  it("gives a counter its hole, in every face", () => {
    // A representative-point test gets `o` wrong and produces an empty glyph;
    // the generated asset marks counters as holes and this is what carries
    // that through to the earcut (docs/handoff/v2-03-lettering.md §2).
    for (const face of ["sans", "serif", "mono"]) {
      const [glyph] = glyphAreas(ASSETS[face], "o", 6);
      expect(glyph, face).toBeDefined();
      expect(glyph.holes.length, `${face} 'o' has no counter`).toBe(1);
      // The hole really is inside the shell.
      const shell = bounds([{ outer: glyph.outer, holes: [] }]);
      const hole = bounds([{ outer: glyph.holes[0], holes: [] }]);
      expect(hole.minX).toBeGreaterThan(shell.minX);
      expect(hole.maxX).toBeLessThan(shell.maxX);
    }
  });

  it("advances the pen by the shared metrics table, not by the ink", () => {
    // The metrics are what `fit_text` measured with; laying out by the outline's
    // own width instead would drift a whole side bearing per character.
    const size = 6;
    const metrics = T.font_metrics("sans");
    const advance = (metrics.glyphs[String("H".codePointAt(0))].adv * size) /
      metrics.units_per_em;
    const one = bounds(glyphAreas(ASSETS.sans, "H", size));
    const two = bounds(glyphAreas(ASSETS.sans, "HH", size));
    expect(two.maxX - one.maxX).toBeCloseTo(advance, 6);
    expect(T.text_advance_em("sans", "HH") * size).toBeCloseTo(2 * advance, 6);
  });

  it("scales by size / units_per_em and sits on the baseline", () => {
    const metrics = T.font_metrics("sans");
    const [top] = T.text_ink_em("sans", "H");
    const drawn = bounds(glyphAreas(ASSETS.sans, "H", 8));
    expect(drawn.maxY).toBeCloseTo(top * 8, 6);
    expect(drawn.minY).toBeCloseTo(0, 6);
    expect(metrics.units_per_em).toBe(ASSETS.sans.units_per_em);
  });

  it("draws nothing for a space, but still advances past it", () => {
    expect(glyphAreas(ASSETS.sans, " ", 6)).toEqual([]);
    const spaced = bounds(glyphAreas(ASSETS.sans, " H", 6));
    const bare = bounds(glyphAreas(ASSETS.sans, "H", 6));
    expect(spaced.minX).toBeGreaterThan(bare.minX);
  });

  it("widens the ink by the fit's dilation, and shrinks the counter", () => {
    const plain = glyphAreas(ASSETS.sans, "o", 6, 0)[0];
    const fat = glyphAreas(ASSETS.sans, "o", 6, 0.2)[0];
    const plainShell = bounds([{ outer: plain.outer, holes: [] }]);
    const fatShell = bounds([{ outer: fat.outer, holes: [] }]);
    expect(fatShell.maxX - fatShell.minX).toBeGreaterThan(
      plainShell.maxX - plainShell.minX,
    );
    // The counter closes UP as the stroke fattens -- that is what
    // `text_min_size_mm` exists to refuse before it closes entirely.
    const plainHole = bounds([{ outer: plain.holes[0], holes: [] }]);
    const fatHole = bounds([{ outer: fat.holes[0], holes: [] }]);
    expect(fatHole.maxX - fatHole.minX).toBeLessThan(plainHole.maxX - plainHole.minX);
  });
});

describe("offsetRing", () => {
  const square = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];

  it("grows a counter-clockwise ring by exactly the distance on every side", () => {
    const grown = offsetRing(square, 1);
    expect(grown).toEqual([
      [-1, -1],
      [11, -1],
      [11, 11],
      [-1, 11],
    ]);
  });

  it("shrinks it with a negative distance, and is a no-op at zero", () => {
    expect(offsetRing(square, -1)).toEqual([
      [1, 1],
      [9, 1],
      [9, 9],
      [1, 9],
    ]);
    expect(offsetRing(square, 0)).toEqual(square);
  });

  it("keeps the ring rather than turning it inside out", () => {
    // A cheap mitre offset is not a true polygon offset: past the inradius it
    // self-intersects. The guard is what stops a 0.2 mm dilation from knotting
    // a tight counter; a slightly thin letter is the right failure mode for a
    // preview.
    expect(offsetRing(square, -20)).toEqual(square);
  });

  it("clamps the mitre on a spur instead of growing a spike", () => {
    const spur = [
      [0, 0],
      [20, 0.4],
      [0, 0.8],
    ];
    const grown = offsetRing(spur, 0.2);
    const reach = Math.max(...grown.map((p) => p[0]));
    // The exact mitre at that tip is ~10 mm past the point; the limit caps the
    // whole displacement at 3 x the offset distance.
    expect(reach).toBeLessThan(20 + 3 * 0.2 + 1e-9);
    expect(reach).toBeGreaterThan(20);
  });
});

// ==========================================================================
// Placement
// ==========================================================================

describe("placeArea", () => {
  const unit: PreviewArea = { outer: [1, 0, 1, 2, 0, 2], holes: [] };

  it("is `lettering.place`: mirror, then rotate, then translate", () => {
    // The build's affine matrix is [cos*sx, -sin, sin*sx, cos, ax, ay]; the
    // mirror is applied in the LOCAL frame, which is what makes the underside
    // mark read once the plate is turned over.
    const placement: T.Placement = {
      anchor_x: 5,
      anchor_y: -3,
      rotation_deg: 90,
      mirror_x: true,
    };
    const placed = placeArea(unit, placement);
    const theta = Math.PI / 2;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    for (let i = 0; i < unit.outer.length; i += 2) {
      const x = -unit.outer[i];
      const y = unit.outer[i + 1];
      expect(placed.outer[i]).toBeCloseTo(cos * x - sin * y + 5, 9);
      expect(placed.outer[i + 1]).toBeCloseTo(sin * x + cos * y - 3, 9);
    }
  });

  it("moves the holes with the shell", () => {
    const withHole: PreviewArea = { outer: [0, 0, 4, 0, 4, 4], holes: [[1, 1, 2, 1, 2, 2]] };
    const placed = placeArea(withHole, {
      anchor_x: 10,
      anchor_y: 10,
      rotation_deg: 0,
      mirror_x: false,
    });
    expect(placed.holes[0]).toEqual([11, 11, 12, 11, 12, 12]);
  });
});

// ==========================================================================
// Ornaments and pockets
// ==========================================================================

describe("ornaments", () => {
  it("draws the north arrow as the build's four-point head", () => {
    const arrow = northArrowArea(4);
    expect(ringPoints(arrow.outer)).toHaveLength(4);
    const box = bounds([arrow]);
    expect(box.maxY - box.minY).toBeCloseTo(4, 9);
    expect(box.maxX - box.minX).toBeCloseTo(T.NORTH_ARROW_WIDTH_RATIO * 4, 9);
    // Concave, and wound the way the earcut wants it.
    expect(area2(arrow.outer)).toBeGreaterThan(0);
  });

  /**
   * Signed distance to the keyhole's TRUE region: the union of the 8 mm entry
   * disc, the slot box and the slot's 4 mm round end -- which is exactly what
   * `lettering.keyhole_polygon` unions on the build side.
   *
   * The minimum of the three signed distances is the union's own signed
   * distance outside the shape and a (correctly signed) under-estimate inside
   * it, which is all a boundary test needs: every point of a correct outline
   * sits at |sdf| = 0.
   */
  function keyholeSdf(params: PrintParams, x: number, y: number): number {
    const [cx, cy] = T.keyhole_center_mm(params);
    const half = T.KEYHOLE_SLOT_W_MM / 2;
    const top = cy + T.KEYHOLE_SLOT_LEN_MM;
    const disc = Math.hypot(x - cx, y - cy) - T.KEYHOLE_HOLE_D_MM / 2;
    const cap = Math.hypot(x - cx, y - top) - half;
    // Signed distance to the axis-aligned slot box, [cx-half, cx+half] x [cy, top].
    const dx = Math.abs(x - cx) - half;
    const dy = Math.abs(y - (cy + top) / 2) - (top - cy) / 2;
    const box =
      Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
    return Math.min(disc, cap, box);
  }

  it("draws the keyhole outline ON the union the build cuts", () => {
    // The bounding-box assertions below are set by the circle's cardinal points
    // and the cap, and NONE of them moves when the arc is terminated at the
    // wrong angle -- which is how a 0.93 mm funnel-shaped shoulder shipped
    // (audit v2-06 finding 2). This walks the whole outline instead, edges
    // included, against the analytic union.
    const params = defaultPrintParams();
    const ring = ringPoints(keyholeArea(params).outer);
    let worst = 0;
    let worstAt: [number, number] = [0, 0];
    const SAMPLES_PER_EDGE = 16;
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      for (let s = 0; s <= SAMPLES_PER_EDGE; s += 1) {
        const t = s / SAMPLES_PER_EDGE;
        const x = a[0] + (b[0] - a[0]) * t;
        const y = a[1] + (b[1] - a[1]) * t;
        const error = Math.abs(keyholeSdf(params, x, y));
        if (error > worst) {
          worst = error;
          worstAt = [x, y];
        }
      }
    }
    // A 64-gon on a 4 mm radius has a sagitta of 0.005 mm; the cap's 32-gon on
    // 2 mm has 0.0024. 0.01 mm is one hundredth of the project's print
    // tolerance and comfortably below both, so it is a real bound and not a
    // number chosen to pass: `asin` measured 0.9279 mm here.
    expect(
      worst,
      `worst radial error ${worst.toFixed(4)} mm at (${worstAt[0].toFixed(3)}, ${worstAt[1].toFixed(3)})`,
    ).toBeLessThan(0.01);
  });

  it("meets the entry circle where the slot's own sides are, at 60 degrees", () => {
    // The claim the outline rests on, stated directly: a vertical line at
    // x = cx + half crosses the entry circle where cos(angle) = half / radius.
    const params = defaultPrintParams();
    const [cx, cy] = T.keyhole_center_mm(params);
    const half = T.KEYHOLE_SLOT_W_MM / 2;
    const radius = T.KEYHOLE_HOLE_D_MM / 2;
    const theta = Math.acos(half / radius);
    expect((theta * 180) / Math.PI).toBeCloseTo(60, 9);
    // The junction point is on BOTH the circle and the slot's side.
    const jx = cx + Math.cos(theta) * radius;
    const jy = cy + Math.sin(theta) * radius;
    expect(jx).toBeCloseTo(cx + half, 9);
    expect(Math.hypot(jx - cx, jy - cy)).toBeCloseTo(radius, 9);
    // ...and it is a vertex of the drawn outline.
    const ring = ringPoints(keyholeArea(params).outer);
    const nearest = Math.min(...ring.map((p) => Math.hypot(p[0] - jx, p[1] - jy)));
    expect(nearest).toBeLessThan(1e-9);
  });

  it("draws the keyhole as one closed outline, not a union", () => {
    // The build unions a circle, a box and a circle; the browser never runs a
    // boolean, so the same shape is walked analytically. The claim is that the
    // result covers exactly the union's extents.
    const params = defaultPrintParams();
    const [cx, cy] = T.keyhole_center_mm(params);
    const hole = keyholeArea(params);
    expect(hole.holes).toEqual([]);
    const box = bounds([hole]);
    // The arcs are a 64-gon, like the build's `buffer(quad_segs=16)`, so an
    // extent lands within one chord's sagitta of the true circle -- 4 mm x
    // (1 - cos(pi/64)) = 0.005 mm. Asserting equality would be asserting that
    // the sample grid happens to hit the cardinal angles.
    const sagitta = (T.KEYHOLE_HOLE_D_MM / 2) * (1 - Math.cos(Math.PI / 64));
    expect(Math.abs(box.minX - (cx - T.KEYHOLE_HOLE_D_MM / 2))).toBeLessThan(sagitta);
    expect(Math.abs(box.maxX - (cx + T.KEYHOLE_HOLE_D_MM / 2))).toBeLessThan(sagitta);
    expect(Math.abs(box.minY - (cy - T.KEYHOLE_HOLE_D_MM / 2))).toBeLessThan(sagitta);
    expect(
      Math.abs(box.maxY - (cy + T.KEYHOLE_SLOT_LEN_MM + T.KEYHOLE_SLOT_W_MM / 2)),
    ).toBeLessThan(sagitta);
    // ...and it is a single simple ring with positive area.
    expect(area2(hole.outer)).toBeGreaterThan(0);
  });

  it("draws the four magnet pockets where the shared math puts them", () => {
    const params: PrintParams = { ...defaultPrintParams(), hanger: "magnets" };
    const pockets = magnetAreas(params);
    expect(pockets).toHaveLength(4);
    const centres = T.magnet_centers_mm(params);
    pockets.forEach((pocket, index) => {
      const box = bounds([pocket]);
      expect((box.minX + box.maxX) / 2).toBeCloseTo(centres[index][0], 6);
      expect((box.minY + box.maxY) / 2).toBeCloseTo(centres[index][1], 6);
      expect(box.maxX - box.minX).toBeCloseTo(T.MAGNET_D_MM, 1);
    });
  });
});

// ==========================================================================
// The whole model
// ==========================================================================

function withText(overrides: Partial<PrintParams> = {}): PrintParams {
  return { ...defaultPrintParams(), ...overrides };
}

describe("buildPreviewText", () => {
  it("draws nothing at all for the contract defaults", () => {
    const model = buildPreviewText(defaultPrintParams(), CTX);
    expect(model.pieces).toEqual([]);
    expect(model.shapeCount).toBe(0);
    expect(model.notices).toEqual([]);
  });

  it("draws one engraving, on the lip's top face, tinted by its mode", () => {
    // 6 mm, not the contract's 3 mm default: at a 0.4 mm nozzle the shared
    // math refuses "CHICAGO" under 3.09 mm because the counter of the `A` would
    // close, and this test is about the drawing, not about the refusal (which
    // has its own case below).
    const engraved = buildPreviewText(
      withText({ engravings: [{ edge: "bottom", text: "CHICAGO", size_mm: 6 }] }),
      CTX,
    );
    expect(engraved.pieces).toHaveLength(1);
    expect(engraved.pieces[0].id).toBe("engraving-0");
    expect(engraved.pieces[0].face).toBe("top");
    expect(engraved.pieces[0].tone).toBe("engraved");
    expect(engraved.shapeCount).toBe(7);

    const embossed = buildPreviewText(
      withText({
        engravings: [{ edge: "bottom", text: "CHICAGO", size_mm: 6, mode: "emboss" }],
      }),
      CTX,
    );
    expect(embossed.pieces[0].tone).toBe("embossed");
  });

  it("expands the tokens through the shared table before drawing", () => {
    // Two glyphs for "41" only if `{lat}`-style expansion happened; the raw
    // template would draw five.
    const model = buildPreviewText(
      withText({
        city_label: "Oslo",
        engravings: [{ edge: "top", text: "{city}", size_mm: 6 }],
      }),
      { ...CTX, city: "Oslo" },
    );
    // Four glyphs, because `{city}` became `Oslo`; the raw six-character
    // template would have drawn six.
    expect(model.shapeCount).toBe(4);
  });

  it("draws nothing for a refused engraving, and says why", () => {
    // A serif line long enough to be squeezed under the 1.5 mm floor: the build
    // will not cut it, so the preview must not show it.
    const params = withText({
      plate_mm: 100,
      nozzle_mm: 1.2,
      engravings: [
        { edge: "top", text: "a very long line of serif lettering", font: "serif" },
      ],
    });
    const layout = T.lettering_layout(params, CTX, 0);
    expect(layout.engravings[0].fit.refused).toBe(true);

    const model = buildPreviewText(params, CTX);
    expect(model.pieces).toEqual([]);
    expect(model.shapeCount).toBe(0);
    expect(model.notices.some((line) => line.includes("was not cut"))).toBe(true);
  });

  it("passes the shared math's auto-fit warning through verbatim", () => {
    const params = withText({
      engravings: [{ edge: "top", text: "A LONG LINE OF LETTERING", size_mm: 8 }],
    });
    const layout = T.lettering_layout(params, CTX, 0);
    const model = buildPreviewText(params, CTX);
    expect(model.notices).toEqual(layout.warnings);
    expect(model.notices.some((line) => line.includes("was reduced from"))).toBe(true);
  });

  it("draws the ornaments the layout enables, and only those", () => {
    const model = buildPreviewText(
      withText({
        north_arrow: { enabled: true, corner: "ne", size_mm: 4 },
        scale_bar: { enabled: true, edge: "bottom", length_mode: "auto", length_m: 500 },
      }),
      CTX,
    );
    const ids = model.pieces.map((piece) => piece.id).sort();
    expect(ids).toEqual(["north-arrow", "scale-bar", "scale-bar-label"]);
  });

  it("skips every lip ornament with the frame off, and says so once", () => {
    const lettering = {
      // 6 mm and not the 3 mm default, so the engraving is one the shared math
      // would happily fit: without it this case would pass because the text was
      // REFUSED, and would say nothing about the frame at all.
      engravings: [{ edge: "top" as const, text: "CHICAGO", size_mm: 6 }],
      north_arrow: { enabled: true },
      scale_bar: { enabled: true },
    };
    expect(
      buildPreviewText(withText(lettering), CTX).pieces.filter(
        (piece) => piece.face === "top",
      ).length,
    ).toBeGreaterThan(0);

    const model = buildPreviewText(withText({ frame: false, ...lettering }), CTX);
    // Nothing on the lip, because there is no lip: the build's cutter would sit
    // 2 mm above an empty plate and cut air, which is what its own "turn the
    // frame on to print them" warning is about.
    expect(model.pieces.filter((piece) => piece.face === "top")).toEqual([]);
    expect(model.notices.some((line) => line.includes("the frame is off"))).toBe(true);
  });

  it("keeps the underside features, which do not need a lip", () => {
    const model = buildPreviewText(
      withText({
        frame: false,
        hanger: "keyhole",
        underside_mark: { enabled: true, template: "AB" },
      }),
      CTX,
    );
    expect(model.pieces.map((piece) => piece.id).sort()).toEqual([
      "keyhole",
      "underside-mark",
    ]);
  });

  it("puts the underside mark on the bottom face, mirrored", () => {
    const model = buildPreviewText(
      withText({ underside_mark: { enabled: true, template: "AB" } }),
      CTX,
    );
    const mark = model.pieces.find((piece) => piece.id === "underside-mark");
    expect(mark?.face).toBe("bottom");
    // Mirrored: the FIRST character of the string ends up at the larger x, so
    // the mark reads correctly once the plate is turned over.
    const first = bounds([mark!.areas[0]]);
    const last = bounds([mark!.areas[mark!.areas.length - 1]]);
    expect(first.minX).toBeGreaterThan(last.minX);
    // ...and it is centred on the plate. Not to the micron: the anchor centres
    // the ADVANCE block, and the ink inside it is offset by the first and last
    // side bearings, which differ.
    const whole = bounds(mark!.areas);
    expect(Math.abs((whole.minX + whole.maxX) / 2)).toBeLessThan(0.5);
  });

  it("draws the hanger pockets on the bottom face", () => {
    const keyhole = buildPreviewText(withText({ hanger: "keyhole" }), CTX);
    expect(keyhole.pieces.map((piece) => [piece.id, piece.face, piece.tone])).toEqual([
      ["keyhole", "bottom", "pocket"],
    ]);
    const magnets = buildPreviewText(withText({ hanger: "magnets" }), CTX);
    expect(magnets.pieces[0].areas).toHaveLength(4);
  });

  it("reports a face it has not been given, and draws nothing from it", () => {
    resetGlyphFaces();
    try {
      const model = buildPreviewText(
        withText({
          engravings: [{ edge: "top", text: "CHICAGO", size_mm: 6, font: "serif" }],
        }),
        CTX,
      );
      expect(model.missingFaces).toEqual(["serif"]);
      expect(model.pieces).toEqual([]);
    } finally {
      for (const [face, asset] of Object.entries(ASSETS)) primeGlyphFace(face, asset);
    }
  });
});

describe("textParamsKey and facesNeeded", () => {
  it("is unmoved by every parameter that cannot change a layout", () => {
    const base = defaultPrintParams();
    const key = textParamsKey(base);
    for (const [field, value] of [
      ["base_thickness_mm", 8],
      ["small_scale", 1.5],
      ["large_scale", 2.0],
      ["terrain_exaggeration", 3.0],
      ["road_mode", "emboss"],
      ["road_scale", 2.0],
      ["trees", false],
      ["water", false],
      ["color_mode", "parts"],
      ["hero_mode", "both"],
    ] as Array<[keyof PrintParams, unknown]>) {
      expect(textParamsKey({ ...base, [field]: value } as PrintParams), field).toBe(key);
    }
  });

  it("moves for every parameter that can", () => {
    const base = defaultPrintParams();
    const key = textParamsKey(base);
    for (const [field, value] of [
      ["plate_mm", 256],
      ["frame", false],
      ["nozzle_mm", 0.8],
      ["city_label", "Chicago"],
      // {hero} counts them, {country}/{state}/{neighbourhood}/{author} read
      // `place` (DECISIONS [V3-P1]).
      ["hero_building_ids", ["w1"]],
      ["hero_auto", { enabled: true, count: 5 }],
      ["place", { country: "US" }],
      ["engravings", [{ edge: "top", text: "X" }]],
      ["north_arrow", { enabled: true }],
      ["scale_bar", { enabled: true }],
      ["underside_mark", { enabled: true }],
      ["hanger", "keyhole"],
    ] as Array<[keyof PrintParams, unknown]>) {
      expect(
        textParamsKey({ ...base, [field]: value } as PrintParams),
        field,
      ).not.toBe(key);
    }
  });

  it("asks only for the faces a layout will actually use", () => {
    expect(facesNeeded(defaultPrintParams())).toEqual([]);
    expect(
      facesNeeded(
        withText({
          engravings: [
            { edge: "top", text: "A", font: "serif" },
            { edge: "bottom", text: "B" },
          ],
          scale_bar: { enabled: true },
          underside_mark: { enabled: true },
        }),
      ).sort(),
    ).toEqual(["mono", "sans", "serif"]);
    // The frame carries the lip ornaments, so with it off only the underside
    // mark's face is worth 280 KB of download.
    expect(
      facesNeeded(
        withText({
          frame: false,
          engravings: [{ edge: "top", text: "A", font: "serif" }],
          underside_mark: { enabled: true },
        }),
      ),
    ).toEqual(["mono"]);
  });
});

// ==========================================================================
// Against the committed layout fixture
// ==========================================================================

interface LetteringCase {
  name: string;
  params: PrintParams;
  ctx: TokenContext;
  rotation_deg: number;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/lettering-expected.json", import.meta.url),
    "utf8",
  ),
) as { cases: LetteringCase[] };

describe("every case of fixtures/lettering-expected.json", () => {
  it("has cases to walk", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(10);
  });

  it("draws every engraving inside its own 6 mm lip band", () => {
    let checked = 0;
    let skipped = 0;
    for (const item of fixture.cases) {
      const layout = T.lettering_layout(item.params, item.ctx, item.rotation_deg);
      const model = buildPreviewText(item.params, item.ctx, item.rotation_deg);
      for (const engraving of layout.engravings) {
        const piece = model.pieces.find(
          (candidate) => candidate.id === `engraving-${engraving.index}`,
        );
        // With the frame off there is no lip, so nothing on it is drawn at all
        // -- the fixture carries a case for exactly that.
        if (!item.params.frame) {
          expect(piece, `${item.name}: a lip engraving was drawn with no lip`).toBeUndefined();
          skipped += 1;
          continue;
        }
        if (engraving.fit.refused || engraving.fit.text.trim() === "") {
          expect(piece, `${item.name}: a refused engraving was drawn`).toBeUndefined();
          continue;
        }
        expect(piece, `${item.name}: engraving ${engraving.index} was not drawn`).toBeDefined();
        const [cx, cy] = T.edge_band_center_mm(item.params, engraving.edge);
        const [ax, ay] = T.edge_axis(engraving.edge);
        const [ux, uy] = T.edge_up(engraving.edge);
        const halfBand = T.FRAME_WIDTH_MM / 2;
        const halfEdge = T.edge_usable_mm(item.params) / 2;
        for (const area of piece!.areas) {
          for (const contour of [area.outer, ...area.holes]) {
            for (let i = 0; i < contour.length; i += 2) {
              const dx = contour[i] - cx;
              const dy = contour[i + 1] - cy;
              const across = dx * ux + dy * uy;
              const along = dx * ax + dy * ay;
              expect(
                Math.abs(across),
                `${item.name}: ink ${across.toFixed(3)} mm off the band centre`,
              ).toBeLessThanOrEqual(halfBand);
              expect(
                Math.abs(along),
                `${item.name}: ink ${along.toFixed(3)} mm along a ${(2 * halfEdge).toFixed(0)} mm edge`,
              ).toBeLessThanOrEqual(halfEdge + 0.01);
            }
          }
        }
        checked += 1;
      }
    }
    // Not vacuous: the fixture really does carry engravings on real edges, and
    // at least one case with the frame off.
    expect(checked).toBeGreaterThanOrEqual(4);
    expect(skipped).toBeGreaterThan(0);
  });

  it("draws exactly the pieces the shared layout enables", () => {
    let ornaments = 0;
    for (const item of fixture.cases) {
      const layout = T.lettering_layout(item.params, item.ctx, item.rotation_deg);
      const model: PreviewTextModel = buildPreviewText(
        item.params,
        item.ctx,
        item.rotation_deg,
      );
      const ids = new Set(model.pieces.map((piece) => piece.id));
      expect(ids.has("north-arrow"), item.name).toBe(layout.north_arrow.enabled);
      expect(ids.has("scale-bar"), item.name).toBe(layout.scale_bar.enabled);
      expect(ids.has("keyhole"), item.name).toBe(item.params.hanger === "keyhole");
      expect(ids.has("magnets"), item.name).toBe(item.params.hanger === "magnets");
      if (layout.north_arrow.enabled) ornaments += 1;
      if (layout.scale_bar.enabled) ornaments += 1;
    }
    expect(ornaments).toBeGreaterThan(0);
  });

  it("never reports a face it was not given", () => {
    for (const item of fixture.cases) {
      const model = buildPreviewText(item.params, item.ctx, item.rotation_deg);
      expect(model.missingFaces, item.name).toEqual([]);
    }
  });
});

describe("textTokenContext", () => {
  it("reads the scene, never the clock", () => {
    const graph = {
      bounds: { min_x: -900, min_y: -900, max_x: 900, max_y: 900 },
      center: { lat: 1.5, lon: -2.5 },
      buildings: [],
      roads: [],
      water: [],
      green: [],
      trees: [],
      stats: { building_count: 42, coverage: "good" as const, height_tag_ratio: 0.5 },
    };
    const params = withText({ city_label: "Chicago" });
    const ctx = textTokenContext(graph, params, "2026-08-30");
    expect(ctx).toEqual({
      lat: 1.5,
      lon: -2.5,
      scale_mm_per_m: T.scale_mm_per_m(params, 900),
      radius_m: 900,
      date: "2026-08-30",
      buildings: 42,
      city: "Chicago",
      country: "",
      state: "",
      neighbourhood: "",
      author: "",
      hero_count: 0,
    });
  });

  it("survives having no scene at all", () => {
    const ctx = textTokenContext(null, defaultPrintParams(), "2026-08-30");
    expect(ctx.scale_mm_per_m).toBe(0);
    expect(ctx.radius_m).toBe(0);
  });

  it("reads place and the hero count off params, for {country}/{state}/{neighbourhood}/{author}/{hero}", () => {
    const params = withText({
      place: { country: "United States", state: "Illinois", neighbourhood: "The Loop", author: "Vahid Alizadeh" },
      hero_building_ids: ["w1", "w2", "w3"],
    });
    const ctx = textTokenContext(null, params, "2026-08-30");
    expect(ctx.country).toBe("United States");
    expect(ctx.state).toBe("Illinois");
    expect(ctx.neighbourhood).toBe("The Loop");
    expect(ctx.author).toBe("Vahid Alizadeh");
    expect(ctx.hero_count).toBe(3);
  });

  it("{hero} resolves to the top hero's OSM name when the scene has one", () => {
    // Not typed as `SceneGraph` directly: the buildings below carry `name`,
    // which is `EngineBuilding`'s addition (`lib/engine/osm/types.ts`), not
    // the frozen contract's own `Building`, and `textTokenContext` accepts a
    // plain `SceneGraph` since that additive field is read through a
    // structural cast at the call site, exactly as `lib/previewText.ts`
    // itself does off `state.scene.graph`.
    const graph = {
      bounds: { min_x: -900, min_y: -900, max_x: 900, max_y: 900 },
      center: { lat: 41.8827, lon: -87.6233 },
      buildings: [
        {
          id: "tall",
          ring: [[-5, -5], [5, -5], [5, 5], [-5, 5]],
          holes: [],
          height_m: 300,
          height_source: "tag" as const,
          min_height_m: 0,
          is_tall: true,
          name: "Willis Tower",
        },
        {
          id: "short",
          ring: [[-5, -5], [5, -5], [5, 5], [-5, 5]],
          holes: [],
          height_m: 10,
          height_source: "tag" as const,
          min_height_m: 0,
          is_tall: false,
        },
      ],
      roads: [],
      water: [],
      green: [],
      trees: [],
      stats: { building_count: 2, coverage: "good" as const, height_tag_ratio: 1.0 },
    };
    const params = withText({ hero_building_ids: [], hero_auto: { enabled: true, count: 1 } });
    const ctx = textTokenContext(graph as unknown as SceneGraph, params, "2026-08-30");
    expect(ctx.hero_name).toBe("Willis Tower");
    expect(ctx.hero_count).toBe(1);
  });
});
