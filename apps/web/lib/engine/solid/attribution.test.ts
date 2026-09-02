/**
 * The mandatory attribution marks: they are always there, and they say what
 * this program says they say.
 *
 * Two halves. The pure half (composition, wrapping, depth clamping, band
 * arithmetic) needs nothing but the shared metrics and runs in microseconds.
 * The baked half runs three real bakes - default, `underside_mark` off, frame
 * off - and measures the geometry each one produced, because "the resolved line
 * says it cut" is exactly the claim a regression would keep telling the truth
 * about while cutting nothing.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams } from "../../contracts";
import { primeGlyphFace, resetGlyphFaces } from "../../fontGlyphs";
import monoGlyphs from "../../fonts/mono.glyphs.json";
import * as T from "../../transform";
import { bake } from "../engine";
import type { EngineResult, RegionMesh } from "../types";
import {
  ATTRIBUTION_FACE,
  BAND_MARGIN_MM,
  DEEP_MARK_DEPTH_MM,
  DEEP_MARK_MIN_DEPTH_MM,
  DEEP_MARK_MIN_SPAN_FRACTION,
  MICROTEXT_CAP_MM,
  MICROTEXT_DEPTH_MM,
  MODEL_DATA_LICENCE,
  OSM_CREDIT,
  PRODUCT_NAME,
  WALL_MARK_DEPTH_MM,
  WALL_MARK_MIN_HEIGHT_MM,
  layoutBlock,
  mandatoryText,
  osmCredit,
  placeBlock,
  wallNormal,
  wrapText,
} from "./attribution";
import { building, scene, square } from "./fixture";
import { outstandingWasmObjects } from "./manifold";

const DATE = "2026-09-01";
const RADIUS_M = 200;

/** One small block on a plate: enough model to carry a frame and a base. */
function smallScene() {
  return scene({ radiusM: RADIUS_M, buildings: [building("w1", square(0, 0, 40), 30)] });
}

function regionOf(result: EngineResult, name: RegionMesh["region"]): RegionMesh | undefined {
  return result.regions.find((region) => region.region === name);
}

function lineOf(result: EngineResult, id: string) {
  return result.resolvedText.find((line) => line.id === id);
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

describe("the mandatory text", () => {
  beforeAll(() => {
    resetGlyphFaces();
    primeGlyphFace("mono", monoGlyphs as never);
  });

  it("names the product, the OSM contributors and the date, in that order", () => {
    const text = mandatoryText(DATE);
    expect(text.startsWith(PRODUCT_NAME)).toBe(true);
    expect(text).toContain(OSM_CREDIT);
    expect(text.endsWith(DATE)).toBe(true);
  });

  it("uses the real copyright sign, because the mono face has one", () => {
    expect(T.supported_codepoint(ATTRIBUTION_FACE, "©")).toBe(true);
    expect(osmCredit(ATTRIBUTION_FACE)).toBe(OSM_CREDIT);
    expect(osmCredit(ATTRIBUTION_FACE).startsWith("©")).toBe(true);
  });

  it("falls back to (c) for a face whose metrics have no U+00A9", () => {
    expect(osmCredit("a-face-that-does-not-exist")).toBe("(c) OpenStreetMap contributors");
  });

  it("survives the metrics filter unchanged: nothing is silently dropped", () => {
    const text = mandatoryText(DATE);
    expect(T.filter_text(ATTRIBUTION_FACE, text)).toEqual([text, ""]);
  });

  it("is the licence line every exporter writes", () => {
    expect(MODEL_DATA_LICENCE).toContain("OpenStreetMap contributors");
    expect(MODEL_DATA_LICENCE).toContain("ODbL 1.0");
  });
});

describe("layout", () => {
  it("wraps to words and never breaks one", () => {
    const lines = wrapText(ATTRIBUTION_FACE, mandatoryText(DATE), 4, 60);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(T.text_advance_em(ATTRIBUTION_FACE, line) * 4).toBeLessThanOrEqual(60);
    }
    expect(lines.join(" ")).toBe(mandatoryText(DATE));
  });

  it("prefers one line that spans the plate over two that do not", () => {
    const block = layoutBlock(ATTRIBUTION_FACE, mandatoryText(DATE), 174.8, 174.8);
    expect(block.lines).toHaveLength(1);
    expect(block.widthMm).toBeGreaterThan(DEEP_MARK_MIN_SPAN_FRACTION * 180);
  });

  it("wraps rather than shrink below legibility on a narrow plate", () => {
    // A 100 mm plate: one line would be 3.16 mm, so it stays one line; at half
    // that width the text has to wrap instead of shrinking to nothing.
    const narrow = layoutBlock(ATTRIBUTION_FACE, mandatoryText(DATE), 47, 174.8);
    expect(narrow.lines.length).toBeGreaterThan(1);
    expect(narrow.lines[0].sizeMm).toBeGreaterThanOrEqual(T.TEXT_MIN_SIZE_MM);
  });

  it("caps a block at the size it is given, so the user's line never shouts", () => {
    const block = layoutBlock(ATTRIBUTION_FACE, "Chicago", 174.8, 174.8, 3);
    expect(block.lines[0].sizeMm).toBeLessThanOrEqual(3);
  });

  it("returns an empty block for empty text and never throws on a zero plate", () => {
    expect(layoutBlock(ATTRIBUTION_FACE, "", 174.8, 174.8).lines).toEqual([]);
    expect(layoutBlock(ATTRIBUTION_FACE, "x", 0, 0).lines).toEqual([]);
  });

  it("centres a block on the point it is placed at, mirrored so it reads from below", () => {
    const block = layoutBlock(ATTRIBUTION_FACE, mandatoryText(DATE), 174.8, 174.8);
    const [placement] = placeBlock(block, 0, 0);
    expect(placement.mirror_x).toBe(true);
    // The pen origin is on the RIGHT of a mirrored block, so a line laid out
    // from 0 to W spans [anchor - W, anchor] and W / 2 centres it.
    expect(placement.anchor_x).toBeCloseTo(block.widthMm / 2, 9);
  });

  it("turns a block by 90 degrees about the point it is placed at", () => {
    const block = layoutBlock(ATTRIBUTION_FACE, "FrameCraft", 100, 100);
    const [flat] = placeBlock(block, 0, 0, 0);
    const [turned] = placeBlock(block, 0, 0, 90);
    expect(turned.rotation_deg).toBe(90);
    // (x, y) -> (-y, x).
    expect(turned.anchor_x).toBeCloseTo(-flat.anchor_y, 9);
    expect(turned.anchor_y).toBeCloseTo(flat.anchor_x, 9);
  });
});

describe("wall normals", () => {
  it("name the four walls of the frame opening and the plate's own edge", () => {
    // `[nx, ny]` points AWAY from the material, so the south inner wall of the
    // opening faces north and the plate's south side face faces south.
    const round = (v: readonly number[]): number[] => v.map((n) => Math.round(n) + 0);
    expect(round(wallNormal(0))).toEqual([0, 1]);
    expect(round(wallNormal(90))).toEqual([-1, 0]);
    expect(round(wallNormal(180))).toEqual([0, -1]);
    expect(round(wallNormal(-90))).toEqual([1, 0]);
  });
});

// ---------------------------------------------------------------------------
// The bakes
// ---------------------------------------------------------------------------

describe("every bake carries the marks", () => {
  let plain: EngineResult;
  let silenced: EngineResult;
  let frameless: EngineResult;

  beforeAll(async () => {
    plain = await bake({ scene: smallScene(), params: defaultPrintParams(), date: DATE });
    silenced = await bake({
      scene: smallScene(),
      params: { ...defaultPrintParams(), underside_mark: { enabled: false, template: "{city}" } },
      date: DATE,
    });
    frameless = await bake({
      scene: smallScene(),
      params: { ...defaultPrintParams(), frame: false },
      date: DATE,
    });
  }, 120_000);

  it("cuts the underside mark, the frame-wall mark and the microtext by default", () => {
    for (const id of ["attribution-underside", "attribution-frame-wall", "attribution-microtext"]) {
      const line = lineOf(plain, id);
      expect(line, id).toBeDefined();
      expect(line?.status, id).toBe("cuts");
      expect(line?.text, id).toContain(PRODUCT_NAME);
      expect(line?.text, id).toContain("OpenStreetMap");
      expect(line?.text, id).toContain(DATE);
    }
  });

  it("labels each surface so the Resolved panel can list them", () => {
    expect(lineOf(plain, "attribution-underside")?.surface).toBe(
      "Base underside, mandatory attribution",
    );
    expect(lineOf(plain, "attribution-frame-wall")?.surface).toBe("Frame inner wall");
    expect(lineOf(plain, "attribution-microtext")?.surface).toBe("Base edge, microtext");
  });

  it("cuts them all with `underside_mark` switched OFF: the switch is the user's line only", () => {
    for (const id of ["attribution-underside", "attribution-frame-wall", "attribution-microtext"]) {
      expect(lineOf(silenced, id)?.status, id).toBe("cuts");
    }
    // The user's own line is what the switch silences, and only that.
    expect(lineOf(silenced, "underside-mark")).toBeUndefined();
  });

  it("APPENDS the user's template under the mandatory text, never instead of it", async () => {
    const marked = await bake({
      scene: smallScene(),
      params: {
        ...defaultPrintParams(),
        city_label: "Chicago",
        underside_mark: { enabled: true, template: "{city} {date}" },
      },
      date: DATE,
    });
    const mandatory = lineOf(marked, "attribution-underside");
    const mine = lineOf(marked, "underside-mark");
    expect(mandatory?.status).toBe("cuts");
    expect(mandatory?.text).toContain("OpenStreetMap");
    expect(mine?.status).toBe("cuts");
    expect(mine?.text).toBe(`Chicago ${DATE}`);
    // Two blocks, so the plate lost more material than with the mandatory one
    // alone, and they do not sit on top of each other.
    expect(regionOf(marked, "base")!.volumeMm3).toBeLessThan(
      regionOf(plain, "base")!.volumeMm3,
    );
    expect(outstandingWasmObjects()).toBe(0);
  }, 60_000);

  it("spans at least 60 per cent of the plate's shorter side", () => {
    const size = lineOf(plain, "attribution-underside")!.sizeMm!;
    const width = T.text_advance_em(ATTRIBUTION_FACE, mandatoryText(DATE)) * size;
    expect(width).toBeGreaterThanOrEqual(DEEP_MARK_MIN_SPAN_FRACTION * 180);
    expect(plain.findings.some((f) => f.id === "attribution-span-short")).toBe(false);
  });

  it("clamps the depth to what the plate can carry, and says so", () => {
    // A 3 mm plate with the default 1.5 mm water recess leaves 0.5 mm under a
    // full millimetre of roof, so the 0.6 mm mark is cut at 0.5 mm.
    const depth = lineOf(plain, "attribution-underside")!.depthMm!;
    expect(depth).toBeLessThan(DEEP_MARK_DEPTH_MM);
    expect(depth).toBeGreaterThanOrEqual(DEEP_MARK_MIN_DEPTH_MM);
    const shallow = plain.findings.find((f) => f.id === "attribution-mark-shallow");
    expect(shallow?.severity).toBe("info");
    expect(shallow?.detail).toContain(depth.toFixed(2));
  });

  it("cuts the full 0.6 mm when the plate is thick enough", async () => {
    const thick = await bake({
      scene: smallScene(),
      params: { ...defaultPrintParams(), base_thickness_mm: 5 },
      date: DATE,
    });
    expect(lineOf(thick, "attribution-underside")?.depthMm).toBe(DEEP_MARK_DEPTH_MM);
    expect(thick.findings.some((f) => f.id === "attribution-mark-shallow")).toBe(false);
    expect(outstandingWasmObjects()).toBe(0);
  }, 60_000);

  it("never breaches the base floor: the plate still sits at zero and holds together", () => {
    const base = regionOf(plain, "base")!;
    expect(base.bbox.min[2]).toBeCloseTo(0, 6);
    expect(base.bodies).toBe(1);
    expect(plain.merged.bodies).toBe(1);
    expect(plain.findings.some((f) => f.severity === "error")).toBe(false);
  });

  it("engraves the frame's inner wall, on every wall of the opening", async () => {
    const frame = regionOf(plain, "frame")!;
    const geometry = T.frame_geometry_mm(plain.params);
    const ring =
      (plain.params.plate_mm ** 2 - (plain.params.plate_mm - 2 * T.FRAME_WIDTH_MM) ** 2) *
      (frame.bbox.max[2] - frame.bbox.min[2]);
    // The mark is the only thing that takes material out of a plain lip.
    expect(ring - frame.volumeMm3).toBeGreaterThan(1);
    expect(lineOf(plain, "attribution-frame-wall")?.depthMm).toBe(WALL_MARK_DEPTH_MM);
    // Fitted to the wall: the default lip is exactly the 2 mm minimum.
    expect(geometry.top_mm - geometry.bottom_mm).toBeCloseTo(WALL_MARK_MIN_HEIGHT_MM, 6);
    const size = lineOf(plain, "attribution-frame-wall")!.sizeMm!;
    expect(size).toBeGreaterThan(1);
    expect(size).toBeLessThan(WALL_MARK_MIN_HEIGHT_MM);
  });

  it("says so when a mark is finer than the nozzle, and cuts it anyway", () => {
    const wall = plain.findings.find((f) => f.id === "attribution-wall-mark-fine");
    const micro = plain.findings.find((f) => f.id === "attribution-microtext-fine");
    expect(wall?.severity).toBe("info");
    expect(micro?.severity).toBe("info");
    expect(micro?.detail).toContain("may not resolve");
    expect(lineOf(plain, "attribution-frame-wall")?.status).toBe("cuts");
    expect(lineOf(plain, "attribution-microtext")?.status).toBe("cuts");
  });

  it("puts the microtext on the plate's outer side face, at 1.2 mm and 0.2 mm deep", () => {
    const line = lineOf(plain, "attribution-microtext")!;
    expect(line.sizeMm).toBe(MICROTEXT_CAP_MM);
    expect(line.depthMm).toBe(MICROTEXT_DEPTH_MM);
    // Cropping it off changes the outer dimensions, so it has to BE on the
    // outer face: the model still measures a full plate across.
    expect(plain.merged.bbox.max[0] - plain.merged.bbox.min[0]).toBeCloseTo(180, 3);
    expect(plain.merged.bbox.min[1]).toBeCloseTo(-90, 3);
  });

  it("cuts a SECOND underside mark when there is no frame wall to engrave", () => {
    expect(lineOf(frameless, "attribution-frame-wall")?.status).toBe("skipped");
    expect(lineOf(frameless, "attribution-frame-wall")?.reason).toContain("no frame");
    const second = lineOf(frameless, "attribution-underside-2");
    expect(second?.status).toBe("cuts");
    expect(second?.text).toContain("OpenStreetMap");
    expect(second?.surface).toBe("Base underside, second mandatory attribution");
    // Two marks, not one moved: the first is still there and still mandatory.
    expect(lineOf(frameless, "attribution-underside")?.status).toBe("cuts");
    expect(regionOf(frameless, "frame")).toBeUndefined();
    expect(frameless.merged.bodies).toBe(1);
    expect(frameless.findings.some((f) => f.severity === "error")).toBe(false);
  });

  it("declares the Z bands it engraved, for the validator to judge", () => {
    const bands = plain.attributionBands ?? [];
    expect(bands.length).toBe(3);
    for (const [low, high] of bands) {
      expect(high).toBeGreaterThan(low);
      // Nothing wider than one line of text plus its slack.
      expect(high - low).toBeLessThanOrEqual(2.5);
      expect(low).toBeGreaterThanOrEqual(0);
      expect(high).toBeLessThanOrEqual(plain.merged.bbox.max[2]);
    }
    // The underside band, the lip band and the plate's side face, in that order.
    expect(bands[0][0]).toBe(0);
    expect(bands[0][1]).toBeCloseTo(lineOf(plain, "attribution-underside")!.depthMm!, 6);
    expect(bands[1][0]).toBeGreaterThanOrEqual(T.base_top_mm(plain.params));
    expect(bands[2][1]).toBeLessThanOrEqual(T.base_top_mm(plain.params) + BAND_MARGIN_MM);
    // With no frame there is no wall band, so two.
    expect((frameless.attributionBands ?? []).length).toBe(2);
  });

  it("leaks no WASM handles", () => {
    expect(outstandingWasmObjects()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The file metadata
// ---------------------------------------------------------------------------

describe("the provenance block", () => {
  it("is in every exporter's output, parsed back out of the bytes", async () => {
    const params: PrintParams = {
      ...defaultPrintParams(),
      city_label: "Chicago",
      place: { country: "", state: "", neighbourhood: "", author: "V. Alizadeh" },
    };
    const result = await bake({ scene: smallScene(), params, date: DATE });
    const created = new Date("2026-09-01T09:00:00Z");
    const source = { lat: 41.8827, lon: -87.6233, radius_m: 200 };

    const { exportGeneric3mf } = await import("../export/generic3mf");
    const { exportBambu3mf } = await import("../export/bambu3mf");
    const { exportObj } = await import("../export/obj");
    const { exportStep } = await import("../export/step");
    const { unzipText } = await import("../export/zip");

    // The licence line is checked without its copyright SIGN: STEP Part 21 is
    // a 7-bit format and escapes U+00A9 as `\X2 A9\X0\`, so the sign is
    // there but not as one character. The 3MF and OBJ checks below see the
    // whole string, and the ASCII tail is enough to tell the licence line from
    // the shorter attribution one.
    const licenceTail = "OpenStreetMap contributors, ODbL 1.0";
    const wanted = [
      "V. Alizadeh",
      licenceTail,
      "FrameCraft 3.0.0",
      "lat=41.8827 lon=-87.6233 radius_m=200",
      "2026-09-01T09:00:00Z",
    ];

    const generic = unzipText(
      exportGeneric3mf(result, { created, source }).bytes,
      "3D/3dmodel.model",
    );
    const bambu = unzipText(exportBambu3mf(result, { created, source }).bytes, "3D/3dmodel.model");
    const obj = new TextDecoder().decode(exportObj(result, { created, source })[0].bytes);
    const step = new TextDecoder().decode(exportStep(result, { created, source }).bytes);

    for (const [label, text] of [
      ["generic 3mf", generic],
      ["bambu 3mf", bambu],
      ["obj", obj],
      ["step", step],
    ] as const) {
      for (const value of wanted) {
        expect(text, `${label} is missing ${value}`).toContain(value);
      }
    }
    for (const text of [generic, bambu, obj]) {
      expect(text).toContain(MODEL_DATA_LICENCE);
    }
    // The 3MF writers carry it as named metadata, once each: the core spec
    // requires metadata names to be unique inside one element.
    for (const key of ["author", "license", "generator", "source", "generated"]) {
      expect(generic.split(`name="framecraft:${key}"`), key).toHaveLength(2);
      expect(bambu.split(`name="framecraft:${key}"`), key).toHaveLength(2);
    }
    expect(outstandingWasmObjects()).toBe(0);
  }, 60_000);

  it("is in the sidecar, saying the same thing the files say", async () => {
    const { buildSidecarJson } = await import("../export/common");
    const result = await bake({
      scene: smallScene(),
      params: {
        ...defaultPrintParams(),
        place: { country: "", state: "", neighbourhood: "", author: "V. Alizadeh" },
      },
      date: DATE,
    });
    const sidecar = buildSidecarJson({
      result,
      target: "generic-3mf",
      source: { lat: 41.8827, lon: -87.6233, radius_m: 200 },
      files: [],
      notes: [],
      scene: smallScene(),
      elapsedS: 1,
      created: new Date("2026-09-01T09:00:00Z"),
      printerProfileId: "custom",
    });
    expect(sidecar.provenance).toEqual({
      author: "V. Alizadeh",
      license: MODEL_DATA_LICENCE,
      generator: "FrameCraft 3.0.0",
      source: "lat=41.8827 lon=-87.6233 radius_m=200",
      generated: "2026-09-01T09:00:00Z",
    });
    expect(sidecar.attribution_bands).toEqual(result.attributionBands);
    expect(outstandingWasmObjects()).toBe(0);
  }, 60_000);

  it("is blank-safe: no author is an empty entry, not a missing one", async () => {
    const { exportGeneric3mf } = await import("../export/generic3mf");
    const { unzipText } = await import("../export/zip");
    const result = await bake({ scene: smallScene(), params: defaultPrintParams(), date: DATE });
    const model = unzipText(
      exportGeneric3mf(result, { created: new Date("2026-09-01T09:00:00Z") }).bytes,
      "3D/3dmodel.model",
    );
    expect(model).toContain('<metadata name="framecraft:author"></metadata>');
    expect(model).toContain(MODEL_DATA_LICENCE);
    expect(outstandingWasmObjects()).toBe(0);
  }, 60_000);
});
