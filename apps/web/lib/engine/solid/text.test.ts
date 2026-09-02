/**
 * Lettering and ornaments on a small plate.
 *
 * The Chicago suite proves the engraving path works on a real model; these
 * prove the three rules around it that a busy scene would hide: the frame is
 * what carries edge text, an inlay is its own region, and an ornament that does
 * not fit is refused with a reason instead of being cut badly.
 */

import { describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams } from "../../contracts";
import { bake } from "../engine";
import type { EngineResult, RegionName } from "../types";
import { scene } from "./fixture";
import { outstandingWasmObjects } from "./manifold";

const RADIUS_M = 200;
const EMPTY = scene({ radiusM: RADIUS_M });

function regionOf(result: EngineResult, name: RegionName) {
  return result.regions.find((region) => region.region === name);
}

async function bakeWith(params: PrintParams): Promise<EngineResult> {
  return bake({ scene: EMPTY, params, date: "2026-08-30" });
}

describe("edge engravings", () => {
  it("cuts a groove into the lip and leaves the base alone", async () => {
    const plain = await bakeWith(defaultPrintParams());
    const cut = await bakeWith({
      ...defaultPrintParams(),
      engravings: [{ edge: "top", text: "FRAMECRAFT", mode: "engrave", size_mm: 4 }],
    });
    const line = cut.resolvedText.find((entry) => entry.id === "engraving-0");
    expect(line?.status).toBe("cuts");
    expect(line?.mode).toBe("engrave");
    expect(line?.depthMm).toBe(0.4);
    expect(regionOf(cut, "frame")!.volumeMm3).toBeLessThan(
      regionOf(plain, "frame")!.volumeMm3,
    );
    expect(regionOf(cut, "base")!.volumeMm3).toBeCloseTo(
      regionOf(plain, "base")!.volumeMm3,
      6,
    );
    expect(outstandingWasmObjects()).toBe(0);
  }, 60_000);

  it("stands an embossed line proud of the lip", async () => {
    const plain = await bakeWith(defaultPrintParams());
    const raised = await bakeWith({
      ...defaultPrintParams(),
      engravings: [// 4 mm is refused by the shared layout: an embossed stroke is two
        // nozzles wide, and widening this face to that at 4 mm closes a
        // counter. The layout says 4.74 mm would work, and the 6 mm lip band
        // has room for it.
        { edge: "bottom", text: "FRAMECRAFT", mode: "emboss", size_mm: 5 }],
    });
    const frame = regionOf(raised, "frame")!;
    expect(raised.resolvedText[0]?.status).toBe("cuts");
    expect(frame.volumeMm3).toBeGreaterThan(regionOf(plain, "frame")!.volumeMm3);
    expect(frame.bbox.max[2]).toBeGreaterThan(regionOf(plain, "frame")!.bbox.max[2]);
    expect(frame.bodies).toBe(1);
  }, 60_000);

  it("refuses edge text when there is no lip to carry it", async () => {
    const result = await bakeWith({
      ...defaultPrintParams(),
      frame: false,
      engravings: [{ edge: "top", text: "FRAMECRAFT", mode: "engrave", size_mm: 4 }],
    });
    expect(regionOf(result, "frame")).toBeUndefined();
    const line = result.resolvedText.find((entry) => entry.id === "engraving-0");
    expect(line?.status).toBe("skipped");
    expect(line?.reason).toContain("frame is off");
    expect(result.findings.some((f) => f.id === "text-too-small")).toBe(true);
  }, 60_000);
});

describe("inlay mode", () => {
  it("emits the letters as their own region and pockets the frame to hold them", async () => {
    const plain = await bakeWith(defaultPrintParams());
    const inlaid = await bakeWith({
      ...defaultPrintParams(),
      engravings: [
        { edge: "top", text: "FRAMECRAFT", mode: "inlay", size_mm: 4, depth_mm: 0.6 },
      ],
    });
    const lettering = regionOf(inlaid, "lettering");
    expect(lettering).toBeDefined();
    expect(lettering!.volumeMm3).toBeGreaterThan(0);
    expect(lettering!.colorHex).toBe("#E3A72F");
    expect(lettering!.slot).toBe(4);

    // The frame lost exactly the pocket, and the inlay fills it plus the
    // 0.2 mm it reaches deeper into the lip - the same interpenetration every
    // other region carries at its seam (`context.PART_OVERLAP_MM`), so the
    // slicer is never handed two parts meeting on a coincident face.
    const lost = regionOf(plain, "frame")!.volumeMm3 - regionOf(inlaid, "frame")!.volumeMm3;
    expect(lost).toBeGreaterThan(0);
    expect(lettering!.volumeMm3).toBeGreaterThan(lost);
    // The extra is the glyph area times the overlap: the pocket is 0.6 deep,
    // so the plug is 0.8 and the ratio is exact.
    expect(lettering!.volumeMm3 / lost).toBeCloseTo(0.8 / 0.6, 2);

    // It sits in the lip, flush with the top face.
    const lipTop = regionOf(plain, "frame")!.bbox.max[2];
    expect(lettering!.bbox.max[2]).toBeCloseTo(lipTop, 3);
    expect(lettering!.bbox.min[2]).toBeCloseTo(lipTop - 0.8, 2);
    expect(outstandingWasmObjects()).toBe(0);
  }, 60_000);
});

describe("ornaments", () => {
  it("cuts the north arrow into the lip", async () => {
    const plain = await bakeWith(defaultPrintParams());
    const marked = await bakeWith({
      ...defaultPrintParams(),
      north_arrow: { enabled: true, corner: "ne", size_mm: 4 },
    });
    expect(marked.resolvedText.find((entry) => entry.id === "north arrow")?.status).toBe(
      "cuts",
    );
    expect(regionOf(marked, "frame")!.volumeMm3).toBeLessThan(
      regionOf(plain, "frame")!.volumeMm3,
    );
  }, 60_000);

  it("cuts the scale bar and its label", async () => {
    const plain = await bakeWith(defaultPrintParams());
    const barred = await bakeWith({
      ...defaultPrintParams(),
      scale_bar: { enabled: true, edge: "bottom", length_mode: "auto", length_m: 500 },
    });
    const entry = barred.resolvedText.find((line) => line.id.startsWith("scale bar"));
    expect(entry?.status).toBe("cuts");
    // The label names a round number of ground metres for THIS scale.
    expect(entry?.id).toMatch(/scale bar \(/);
    expect(regionOf(barred, "frame")!.volumeMm3).toBeLessThan(
      regionOf(plain, "frame")!.volumeMm3,
    );
    expect(outstandingWasmObjects()).toBe(0);
  }, 60_000);

  it("refuses an ornament when the frame is off", async () => {
    const result = await bakeWith({
      ...defaultPrintParams(),
      frame: false,
      north_arrow: { enabled: true, corner: "ne", size_mm: 4 },
      scale_bar: { enabled: true, edge: "bottom", length_mode: "auto", length_m: 500 },
    });
    // Nothing the PARAMETERS asked for is cut. The mandatory attribution marks
    // are not parameters: they are cut on every bake, with a second underside
    // mark standing in for the frame-wall one when there is no frame
    // (v3 phase 7, `solid/attribution.ts`), so they are excluded here and
    // checked on their own in `attribution.test.ts`.
    const requested = result.resolvedText.filter((line) => !line.id.startsWith("attribution-"));
    expect(requested.filter((line) => line.status === "cuts")).toEqual([]);
    expect(result.resolvedText.filter((line) => line.id.startsWith("attribution-")).length)
      .toBeGreaterThan(0);
    expect(regionOf(result, "frame")).toBeUndefined();
  }, 60_000);
});
