/**
 * Phase 5: frame profiles, corners, shadow gap, matting, the separate frame,
 * face texture, the two mount parts, height bands and tints.
 *
 * Every case is a small synthetic scene, for the reason `synthetic.test.ts`
 * gives: the Chicago plate exercises each of these once and can never point at
 * which one moved. The Chicago bake itself is checked end to end by the CLI
 * runs recorded in `docs/handoff/v3-05-frame.md`.
 *
 * The load-bearing property in most of these is a VOLUME or a BODY COUNT
 * measured on the finished solid, not a call count: a profile that returned the
 * right slab list and built the wrong solid would pass a mock and fail a
 * printer.
 */

import { describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams } from "../../contracts";
import { textTokenContext } from "../../previewText";
import * as T from "../../transform";
import { tintedColor } from "../../tint";
import { bake } from "../engine";
import type { EngineResult, RegionName } from "../types";
import { bandIndexOf, bandRegionName, GRADIENT_MAX_BANDS } from "../types";
import { building, scene, solidFromMesh, square } from "./fixture";
import {
  CHAMFER_FRACTION,
  PROFILE_SLABS,
  SNAP_RIDGE_H_MM,
  TEXTURE_MAX_ELEMENTS,
  frameStyle,
  profileSlabs,
} from "./frame";
import { loadManifold, outstandingWasmObjects } from "./manifold";
import { makeContext } from "./context";
import { Arena } from "./manifold";
import { buildFrameLip, frameTopFaceSection, topFaceWidthMm } from "./frame";
import { bucketTints } from "./tint";
import type { BuildingTint } from "../types";

const RADIUS_M = 200;

/** One 40 m block in the middle: enough for a plate, a frame and a city. */
function smallScene() {
  return scene({ radiusM: RADIUS_M, buildings: [building("w1", square(0, 0, 40), 30)] });
}

/** A scene with buildings at four heights, for the gradient bands. */
function towerScene() {
  return scene({
    radiusM: RADIUS_M,
    buildings: [
      building("a", square(-60, -60, 30), 10),
      building("b", square(60, -60, 30), 20),
      building("c", square(-60, 60, 30), 40),
      building("d", square(60, 60, 30), 80),
    ],
  });
}

function params(patch: Partial<PrintParams> = {}): PrintParams {
  return { ...defaultPrintParams(), ...patch };
}

function regionOf(result: EngineResult, name: RegionName) {
  return result.regions.find((region) => region.region === name);
}

/** Bake, and fail loudly if a WASM handle leaked. */
async function bakeScene(
  input: Parameters<typeof bake>[0],
): Promise<EngineResult> {
  await loadManifold();
  const before = outstandingWasmObjects();
  const result = await bake({ date: "2026-09-01", ...input });
  expect(outstandingWasmObjects()).toBe(before);
  return result;
}

/** A context with no scene work done, for the plan-geometry helpers. */
async function planContext(print: PrintParams) {
  const wasm = await loadManifold();
  const arena = new Arena();
  const ctx = makeContext({ wasm, arena, scene: smallScene(), params: print });
  return { ctx, arena };
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

describe("frame profiles", () => {
  it("leaves the plain profile exactly one slab, from inside the plate", async () => {
    const print = params();
    const { ctx, arena } = await planContext(print);
    try {
      const frame = T.frame_geometry_mm(print);
      const slabs = profileSlabs(ctx, frame.bottom_mm - 0.2, frame.bottom_mm, frame.top_mm);
      expect(slabs).toHaveLength(1);
      expect(slabs[0].outerDeltaMm).toBe(0);
      expect(slabs[0].innerDeltaMm).toBe(0);
      expect(topFaceWidthMm(ctx)).toBeCloseTo(T.FRAME_WIDTH_MM, 9);
    } finally {
      arena.dispose();
    }
  });

  it("cuts the chamfer 30 per cent down the lip, over the stated slab count", async () => {
    const print = params({ frame_style: { profile: "chamfer" } });
    const { ctx, arena } = await planContext(print);
    try {
      const frame = T.frame_geometry_mm(print);
      const height = frame.top_mm - frame.bottom_mm;
      const slabs = profileSlabs(ctx, frame.bottom_mm - 0.2, frame.bottom_mm, frame.top_mm);
      // One straight slab up to the chamfer, then the ramp.
      expect(slabs).toHaveLength(PROFILE_SLABS + 1);
      const chamfer = CHAMFER_FRACTION * height;
      expect(slabs[0].z1Mm).toBeCloseTo(frame.top_mm - chamfer, 9);
      // A 45 degree face: the inset at the top equals the height risen.
      const top = slabs[slabs.length - 1];
      expect(top.outerDeltaMm).toBeCloseTo(chamfer, 9);
      expect(topFaceWidthMm(ctx)).toBeCloseTo(T.FRAME_WIDTH_MM - chamfer, 9);
    } finally {
      arena.dispose();
    }
  });

  it.each([
    ["chamfer"],
    ["stepped"],
    ["bevel_in"],
    ["bullnose"],
    ["ogee"],
    ["floating"],
  ] as const)("builds %s as a solid smaller than the plain lip", async (profile) => {
    const plainCtx = await planContext(params());
    let plainVolume = 0;
    try {
      const lip = buildFrameLip(plainCtx.ctx);
      expect(lip).not.toBeNull();
      plainVolume = lip?.volume() ?? 0;
    } finally {
      plainCtx.arena.dispose();
    }

    const shaped = await planContext(params({ frame_style: { profile } }));
    try {
      const lip = buildFrameLip(shaped.ctx);
      expect(lip).not.toBeNull();
      const volume = lip?.volume() ?? 0;
      expect(volume).toBeGreaterThan(0);
      // Every profile REMOVES material from the plain lip; none adds any.
      expect(volume).toBeLessThan(plainVolume);
      expect(volume).toBeGreaterThan(plainVolume * 0.5);
      expect(frameTopFaceSection(shaped.ctx)).not.toBeNull();
    } finally {
      shaped.arena.dispose();
    }
  });

  it("bakes a chamfered, round-cornered frame into one watertight body", async () => {
    const result = await bakeScene({
      scene: smallScene(),
      params: params({
        frame_style: { profile: "chamfer", corner: "rounded", corner_radius_mm: 4 },
      }),
    });
    const frame = regionOf(result, "frame");
    expect(frame).toBeDefined();
    expect(frame?.bodies).toBe(1);
    expect(result.merged.bodies).toBe(1);
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
  });
});

describe("frame corners", () => {
  /** Area of the top face inside a 1 mm probe at the plate's outer corner. */
  async function cornerAreaMm2(
    corner: "square" | "mitred" | "rounded",
  ): Promise<{ corner: number; ring: number; vertices: number }> {
    const { ctx, arena } = await planContext(
      params({ frame_style: { corner, corner_radius_mm: 4 } }),
    );
    try {
      const face = frameTopFaceSection(ctx);
      expect(face).not.toBeNull();
      const probe = new ctx.wasm.CrossSection(
        [
          [
            [88.5, 88.5],
            [90, 88.5],
            [90, 90],
            [88.5, 90],
          ],
        ],
        "Positive",
      );
      const hit = face!.intersect(probe);
      const out = {
        corner: hit.area(),
        ring: face!.area(),
        vertices: face!.toPolygons().reduce((n, ring) => n + ring.length, 0),
      };
      hit.delete();
      probe.delete();
      return out;
    } finally {
      arena.dispose();
    }
  }

  it("keeps the square corner sharp and cuts the other two back", async () => {
    const sharp = await cornerAreaMm2("square");
    const mitred = await cornerAreaMm2("mitred");
    const rounded = await cornerAreaMm2("rounded");

    // The BAND keeps its area whatever the corner: what a rounded outer corner
    // takes off the outside, the matching inner corner gives back inside, so
    // the frame stays 6 mm wide the whole way round. The corner itself is what
    // moves, and that is what is measured.
    const ring = 180 * 180 - 168 * 168;
    expect(sharp.ring).toBeCloseTo(ring, 6);
    expect(mitred.ring).toBeCloseTo(ring, 0);
    expect(rounded.ring).toBeCloseTo(ring, 0);

    expect(sharp.corner).toBeCloseTo(1.5 * 1.5, 6);
    expect(mitred.corner).toBeLessThan(sharp.corner * 0.6);
    expect(rounded.corner).toBeLessThan(mitred.corner);
    expect(rounded.corner).toBeGreaterThan(0);

    // A sharp ring is eight points; a mitre adds one cut per corner; an arc
    // adds many.
    expect(sharp.vertices).toBe(8);
    expect(mitred.vertices).toBeGreaterThan(sharp.vertices);
    expect(rounded.vertices).toBeGreaterThan(mitred.vertices);
  });
});

// ---------------------------------------------------------------------------
// Shadow gap and matting
// ---------------------------------------------------------------------------

describe("the shadow gap", () => {
  it("shrinks the city crop by its own width", async () => {
    const plain = await planContext(params());
    const withGap = await planContext(
      params({ frame_style: { shadow_gap: { enabled: true, width_mm: 1.5, depth_mm: 0.8 } } }),
    );
    try {
      expect(withGap.ctx.cropHalfMm).toBeCloseTo(plain.ctx.cropHalfMm - 1.5, 9);
      expect(withGap.ctx.recessClipHalfMm).toBeCloseTo(plain.ctx.recessClipHalfMm - 1.5, 9);
    } finally {
      plain.arena.dispose();
      withGap.arena.dispose();
    }
  });

  it("cuts a channel that leaves the plate whole", async () => {
    const result = await bakeScene({
      scene: smallScene(),
      params: params({
        frame_style: { shadow_gap: { enabled: true, width_mm: 1.5, depth_mm: 0.8 } },
      }),
    });
    const base = regionOf(result, "base");
    expect(base?.bodies).toBe(1);
    expect(result.merged.bodies).toBe(1);
    // The channel is real: the plate lost material to it.
    const plain = await bakeScene({ scene: smallScene(), params: params() });
    expect(result.merged.volumeMm3).toBeLessThan(plain.merged.volumeMm3);
  });

  it("refuses a channel that would breach the base floor, with the numbers", async () => {
    const result = await bakeScene({
      scene: smallScene(),
      params: params({
        base_thickness_mm: 3,
        frame_style: { shadow_gap: { enabled: true, width_mm: 1.0, depth_mm: 2.5 } },
      }),
    });
    const refusal = result.findings.find((f) => f.id === "frame-feature-refused");
    expect(refusal?.title).toBe("The shadow gap was not cut");
    expect(refusal?.detail).toContain("2.50 mm");
    expect(refusal?.detail).toContain("1.50 mm floor");
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
  });
});

describe("matting", () => {
  it("emits its own region between the frame and the city", async () => {
    const result = await bakeScene({
      scene: smallScene(),
      params: params({
        color_mode: "parts",
        frame_style: { matting: { enabled: true, width_mm: 6, proud_mm: 0.4 } },
      }),
    });
    const matting = regionOf(result, "matting");
    expect(matting).toBeDefined();
    expect(matting?.bodies).toBe(1);
    expect(matting?.volumeMm3).toBeGreaterThan(0);
    // Its top is proud of the base top, its underside inside the plate.
    const baseTop = T.base_top_mm(result.params);
    expect(matting?.bbox.max[2]).toBeCloseTo(baseTop + 0.4, 2);
    expect(matting?.bbox.min[2]).toBeLessThan(baseTop);
    // And the city gave way to it: the crop is 6 mm tighter.
    const plain = await planContext(params());
    const matted = await planContext(
      params({ frame_style: { matting: { enabled: true, width_mm: 6, proud_mm: 0.4 } } }),
    );
    try {
      expect(matted.ctx.cropHalfMm).toBeCloseTo(plain.ctx.cropHalfMm - 6, 9);
    } finally {
      plain.arena.dispose();
      matted.arena.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// The separate frame
// ---------------------------------------------------------------------------

describe("a separate frame part", () => {
  it("comes out as its own body, registered by a snap ridge", async () => {
    const result = await bakeScene({
      scene: smallScene(),
      params: params({
        frame_style: { separate: { enabled: true, mount: "snap", tolerance_mm: 0.2 } },
      }),
    });
    // TWO bodies, deliberately: the plate and the frame.
    expect(result.merged.bodies).toBe(2);
    const frame = regionOf(result, "frame");
    expect(frame?.bodies).toBe(1);
    // The frame is lifted clear of the plate by the mount tolerance.
    expect(frame?.bbox.min[2]).toBeCloseTo(T.base_top_mm(result.params) + 0.2, 3);
    // The ridge stands on the plate, under the frame.
    const base = regionOf(result, "base");
    expect(base?.bbox.max[2]).toBeCloseTo(
      T.base_top_mm(result.params) + SNAP_RIDGE_H_MM,
      3,
    );
    // And the deliberate second body is NOT reported as a floating island.
    expect(result.findings.filter((f) => f.id === "floating-island")).toEqual([]);
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("refuses a magnet wider than the frame band", async () => {
    const result = await bakeScene({
      scene: smallScene(),
      params: params({
        frame_style: { separate: { enabled: true, mount: "magnet", tolerance_mm: 0.2 } },
        hanger_magnet: { diameter_mm: 6, thickness_mm: 2, count: 2 },
      }),
    });
    const refusal = result.findings.find((f) => f.id === "frame-feature-refused");
    expect(refusal?.title).toBe("The magnet mount was not cut");
    expect(refusal?.detail).toContain("6.0 mm magnet");
  });

  it("cuts paired magnet pockets that fit, half the magnet in each part", async () => {
    const result = await bakeScene({
      scene: smallScene(),
      params: params({
        base_thickness_mm: 4,
        frame_style: { separate: { enabled: true, mount: "magnet", tolerance_mm: 0.2 } },
        hanger_magnet: { diameter_mm: 4, thickness_mm: 2, count: 2 },
      }),
    });
    expect(result.findings.filter((f) => f.id === "frame-feature-refused")).toEqual([]);
    expect(result.merged.bodies).toBe(2);
    // The pockets are real: the frame lost material to them, and so did the
    // plate, against the same bake with the mount switched off.
    const off = await bakeScene({
      scene: smallScene(),
      params: params({ base_thickness_mm: 4 }),
    });
    expect(regionOf(result, "frame")!.volumeMm3).toBeLessThan(
      regionOf(off, "frame")!.volumeMm3,
    );
    expect(regionOf(result, "base")!.volumeMm3).toBeLessThan(
      regionOf(off, "base")!.volumeMm3,
    );
  });
});

// ---------------------------------------------------------------------------
// Face texture
// ---------------------------------------------------------------------------

describe("frame texture", () => {
  it.each([["brush"], ["knurl"], ["hatch"], ["dots"]] as const)(
    "cuts %s into the top face and nowhere else",
    async (pattern) => {
      const print = params({
        frame_style: { texture: { pattern, scale_mm: 2.0, depth_mm: 0.25 } },
      });
      const result = await bakeScene({ scene: smallScene(), params: print });
      const plain = await bakeScene({ scene: smallScene(), params: params() });
      const frame = regionOf(result, "frame");
      const plainFrame = regionOf(plain, "frame");
      expect(frame).toBeDefined();
      // Material was removed, and only from the frame.
      expect(frame!.volumeMm3).toBeLessThan(plainFrame!.volumeMm3);
      expect(regionOf(result, "base")!.volumeMm3).toBeCloseTo(
        regionOf(plain, "base")!.volumeMm3,
        6,
      );
      // The grooves are `depth_mm` deep: the lip's top is where it was.
      expect(frame!.bbox.max[2]).toBeCloseTo(plainFrame!.bbox.max[2], 6);
      expect(result.merged.bodies).toBe(1);
      expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    },
  );

  it("drops a pattern past the element cap, with the count", async () => {
    // A 0.3 mm pitch is finer than two nozzles, so it is clamped to 0.8 mm -
    // and a 0.8 mm dot grid over a 180 mm frame is 6 500 dimples, well past
    // the cap.
    const result = await bakeScene({
      scene: smallScene(),
      params: params({
        frame_style: { texture: { pattern: "dots", scale_mm: 0.3, depth_mm: 0.2 } },
      }),
    });
    const refusal = result.findings.find(
      (f) => f.id === "frame-feature-refused" && f.title === "The frame texture was not cut",
    );
    expect(refusal).toBeDefined();
    expect(refusal?.detail).toContain(String(TEXTURE_MAX_ELEMENTS));
    // Refused, so the frame is the plain one.
    const plain = await bakeScene({ scene: smallScene(), params: params() });
    expect(regionOf(result, "frame")!.volumeMm3).toBeCloseTo(
      regionOf(plain, "frame")!.volumeMm3,
      6,
    );
  });

  it("clears the texture around an engraving instead of cutting through it", async () => {
    const engraved: PrintParams = params({
      engravings: [{ text: "CHICAGO", edge: "top", size_mm: 4, mode: "engrave" }],
      frame_style: { texture: { pattern: "hatch", scale_mm: 2.0, depth_mm: 0.25 } },
    });
    const result = await bakeScene({ scene: smallScene(), params: engraved });
    const noTexture = await bakeScene({
      scene: smallScene(),
      params: params({
        engravings: [{ text: "CHICAGO", edge: "top", size_mm: 4, mode: "engrave" }],
      }),
    });
    const line = result.resolvedText.find((l) => l.id === "engraving-0");
    expect(line?.status).toBe("cuts");

    // The ink is untouched: probing the frame solid inside the letters' box
    // finds the same material with and without the texture.
    const wasm = await loadManifold();
    const withTexture = solidFromMesh(wasm, regionOf(result, "frame")!);
    const without = solidFromMesh(wasm, regionOf(noTexture, "frame")!);
    try {
      const layout = T.lettering_layout(
        engraved,
        textTokenContext(smallScene(), engraved, "2026-09-01"),
        0,
      );
      const entry = layout.engravings[0];
      const { placement, fit } = entry;
      // The INK box itself, which the keep-out grows by a further millimetre:
      // inside it the texture must have cut nothing at all.
      const width = fit.width_mm;
      const height = fit.ink_top_mm - fit.ink_bottom_mm + 2 * fit.dilation_mm;
      const box = wasm.Manifold.cube([width, height, 4], true).translate([
        placement.anchor_x - fit.dilation_mm + width / 2,
        placement.anchor_y + (fit.ink_top_mm + fit.ink_bottom_mm) / 2,
        T.frame_geometry_mm(engraved).top_mm,
      ]);
      const a = wasm.Manifold.intersection([withTexture, box]);
      const b = wasm.Manifold.intersection([without, box]);
      try {
        // Same material over the glyph run, to a thousandth of a cubic mm.
        expect(a.volume()).toBeCloseTo(b.volume(), 3);
      } finally {
        a.delete();
        b.delete();
        box.delete();
      }
    } finally {
      withTexture.delete();
      without.delete();
    }
  });
});

// ---------------------------------------------------------------------------
// Mount parts
// ---------------------------------------------------------------------------

describe("the cleat and the easel", () => {
  it("charges the base for its pocket, in both mirrors of the maths", () => {
    expect(T.hanger_min_base_mm("cleat")).toBe(
      T.CLEAT_SLOT_DEPTH_MM + T.HANGER_MIN_ROOF_MM,
    );
    expect(T.hanger_min_base_mm("easel")).toBe(
      T.EASEL_WELL_DEPTH_MM + T.HANGER_MIN_ROOF_MM,
    );
    expect(T.underside_pockets(params({ hanger: "cleat" }))).toEqual(["cleat"]);
    expect(T.underside_pockets(params({ hanger: "easel" }))).toEqual(["easel"]);
    // The composite the editor blocks on: pocket + roof + the deepest recess.
    expect(T.underside_min_base_mm(params({ hanger: "cleat" }))).toBeCloseTo(4.1, 9);
  });

  it.each([
    ["cleat", "cleat"],
    ["easel", "easel"],
  ] as const)("emits %s as a loose part inside its own pocket", async (hanger, region) => {
    const result = await bakeScene({
      scene: smallScene(),
      params: params({ hanger, base_thickness_mm: 5 }),
    });
    const part = regionOf(result, region);
    expect(part).toBeDefined();
    expect(part?.bodies).toBe(1);
    expect(part?.volumeMm3).toBeGreaterThan(100);
    // On the bed, and inside the plate: it prints in place.
    expect(part?.bbox.min[2]).toBeCloseTo(0, 6);
    expect(part?.bbox.max[2]).toBeLessThan(5);
    expect(Math.abs(part!.bbox.min[0])).toBeLessThanOrEqual(90);
    expect(Math.abs(part!.bbox.max[0])).toBeLessThanOrEqual(90);
    // Two bodies, and the second one is expected, so it is not an island.
    expect(result.merged.bodies).toBe(2);
    expect(result.findings.filter((f) => f.id === "floating-island")).toEqual([]);
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(result.findings.some((f) => f.id === "loose-part-in-place")).toBe(true);
  });

  it("refuses both on a base too thin to carry the pocket", async () => {
    for (const hanger of ["cleat", "easel"] as const) {
      const result = await bakeScene({
        scene: smallScene(),
        params: params({ hanger, base_thickness_mm: 3 }),
      });
      const refusal = result.findings.find((f) => f.id === "hanger-refused");
      expect(refusal?.title).toBe(`The ${hanger} mount was not cut`);
      expect(refusal?.detail).toContain("2.50 mm pocket");
      expect(regionOf(result, hanger)).toBeUndefined();
      expect(result.merged.bodies).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Height bands and tints
// ---------------------------------------------------------------------------

describe("the height gradient", () => {
  it("splits the buildings into equal-count bands, tallest last", async () => {
    const result = await bakeScene({
      scene: towerScene(),
      params: params({
        color_mode: "parts",
        colour: {
          ...defaultPrintParams().colour,
          gradient: { enabled: true, slots: [2, 3] },
        },
      }),
    });
    expect(result.stats.gradientBands).toBe(2);
    const bands = result.buildingBands ?? [];
    expect(bands.map((b) => b.region)).toEqual(["buildings", "buildings_band_2"]);
    // Equal count: four buildings, two bands.
    expect(bands.map((b) => b.buildings)).toEqual([2, 2]);
    // And the bands are ordered by height, low first.
    expect(bands[0].topRangeMm[1]).toBeLessThanOrEqual(bands[1].topRangeMm[0]);
    // Slots come from `colour.gradient.slots`, in order.
    expect(bands.map((b) => b.slot)).toEqual([2, 3]);
    expect(regionOf(result, "buildings_band_2")?.slot).toBe(3);
    // The split changes no geometry: the same model, in two regions.
    const plain = await bakeScene({ scene: towerScene(), params: params({ color_mode: "parts" }) });
    expect(result.merged.volumeMm3).toBeCloseTo(plain.merged.volumeMm3, 6);
    expect(result.stats.triangles).toBe(plain.stats.triangles);
  });

  it("caps the band count and says so", async () => {
    const slots = Array.from({ length: GRADIENT_MAX_BANDS + 2 }, (_, i) => (i % 16) + 1);
    const result = await bakeScene({
      scene: towerScene(),
      params: params({
        color_mode: "parts",
        colour: { ...defaultPrintParams().colour, gradient: { enabled: true, slots } },
      }),
    });
    const capped = result.findings.find((f) => f.id === "gradient-bands-capped");
    expect(capped?.detail).toContain(String(GRADIENT_MAX_BANDS));
    // Four buildings cannot make more than four bands either.
    expect(result.stats.gradientBands).toBe(4);
  });

  it("names bands the way the UI reads them back", () => {
    expect(bandRegionName(1)).toBe("buildings");
    expect(bandRegionName(2)).toBe("buildings_band_2");
    expect(bandIndexOf("buildings")).toBe(1);
    expect(bandIndexOf("buildings_band_8")).toBe(8);
    expect(bandIndexOf("base")).toBeNull();
    expect(bandRegionName(GRADIENT_MAX_BANDS + 1)).toBe("buildings");
  });
});

describe("per-building tints", () => {
  it("are absent by default and deterministic when on", async () => {
    const off = await bakeScene({ scene: towerScene(), params: params() });
    expect(off.buildingTints).toBeUndefined();

    const print = params({
      colour: {
        ...defaultPrintParams().colour,
        tint: { enabled: true, hue_range_deg: 12, lightness_range: 0.12, seed: 7 },
      },
    });
    const on = await bakeScene({ scene: towerScene(), params: print });
    const tints = on.buildingTints ?? [];
    expect(tints).toHaveLength(4);
    expect(new Set(tints.map((t) => t.id))).toEqual(new Set(["a", "b", "c", "d"]));
    // The same colour the PREVIEW paints, from the same function.
    for (const tint of tints) {
      expect(tint.colorHex).toBe(
        tintedColor(tint.id, "#D8D3C6", print.colour?.tint),
      );
    }
    // Deterministic across bakes.
    const again = await bakeScene({ scene: towerScene(), params: print });
    expect(again.buildingTints).toEqual(tints);
    // And the print path ignores them: same geometry, same slots.
    expect(again.merged.volumeMm3).toBeCloseTo(off.merged.volumeMm3, 6);
    expect(regionOf(again, "buildings")?.colorHex).toBe(
      regionOf(off, "buildings")?.colorHex,
    );
  });

  it("buckets a wide tint set down to the material budget", () => {
    const tints: BuildingTint[] = Array.from({ length: 400 }, (_, i) => ({
      id: `b${i}`,
      colorHex: tintedColor(`b${i}`, "#D8D3C6", {
        enabled: true,
        hue_range_deg: 20,
        lightness_range: 0.3,
        seed: 1,
      }),
      centroidMm: [i, 0] as [number, number],
    }));
    const buckets = bucketTints(tints, 32);
    expect(new Set(buckets.values()).size).toBeLessThanOrEqual(32);
    expect(new Set(buckets.values()).size).toBeGreaterThan(8);
    // Every tint is mapped, and to a colour that was in the set.
    for (const tint of tints) {
      expect(buckets.get(tint.colorHex)).toBeDefined();
      expect(tints.some((t) => t.colorHex === buckets.get(tint.colorHex))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The default is untouched
// ---------------------------------------------------------------------------

describe("the default bake", () => {
  it("is what it was: one body, one region set, plain 6 mm lip", async () => {
    const result = await bakeScene({ scene: smallScene(), params: params() });
    expect(result.merged.bodies).toBe(1);
    expect(result.buildingTints).toBeUndefined();
    expect(result.buildingBands).toBeUndefined();
    expect(result.stats.gradientBands).toBeUndefined();
    expect(result.regions.map((r) => r.region)).toEqual(["base", "frame", "buildings"]);
    const frame = regionOf(result, "frame")!;
    const geometry = T.frame_geometry_mm(result.params);
    expect(frame.bbox.max[2]).toBeCloseTo(geometry.top_mm, 6);
    // The extrusion planes are on the engine's own 1/4096 mm Z grid
    // (`manifold.snapZ`), so the underside reads 2.80005, not 2.8.
    expect(frame.bbox.min[2]).toBeCloseTo(geometry.bottom_mm - 0.2, 3);
    // The plain lip's volume is the ring times its height, to the Z grid: the
    // 2.2 mm of extrusion lands on 2.19995, which is 0.2 mm3 of 9 187.
    const ring = (180 * 180 - 168 * 168) * (frame.bbox.max[2] - frame.bbox.min[2]);
    expect(frame.volumeMm3).toBeCloseTo(ring, 6);
    expect(frame.volumeMm3).toBeCloseTo(4176 * 2.2, 0);
    expect(frameStyle(result.params).profile).toBe("plain");
  });
});
