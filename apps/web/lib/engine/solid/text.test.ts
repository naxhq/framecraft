/**
 * Lettering and ornaments on a small plate.
 *
 * The Chicago suite proves the engraving path works on a real model; these
 * prove the three rules around it that a busy scene would hide: the frame is
 * what carries edge text, an inlay is its own region, and an ornament that does
 * not fit is refused with a reason instead of being cut badly.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams } from "../../contracts";
import { buildModel } from "../engine";
import type { EngineResult, RegionName } from "../types";
import { scene } from "./fixture";
import { outstandingWasmObjects } from "./manifold";

const RADIUS_M = 200;
const EMPTY = scene({ radiusM: RADIUS_M });

function regionOf(result: EngineResult, name: RegionName) {
  return result.regions.find((region) => region.region === name);
}

async function buildWith(params: PrintParams): Promise<EngineResult> {
  return buildModel({ scene: EMPTY, params, date: "2026-08-30" });
}

describe("edge engravings", () => {
  it("cuts a groove into the lip and leaves the base alone", async () => {
    const plain = await buildWith(defaultPrintParams());
    const cut = await buildWith({
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
    const plain = await buildWith(defaultPrintParams());
    const raised = await buildWith({
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

  it("joins an embossed pair a nozzle cannot part, and says so", async () => {
    // [V3.1-P2-5], the larger half: the layout only WARNS that adjacent
    // letters will touch, and for engraved text the ridge merge makes that
    // true. Embossed text now gets the mirror image: the slit between two
    // raised letters (0.208 mm on this string at the 4.80 mm the 5 mm face
    // allows, which the reference validator fails at the one-nozzle floor) is
    // filled and the join widened to a wall, so the line is BUILT and the
    // user is told which pairs were joined and how close they came.
    const plain = await buildWith(defaultPrintParams());
    const sans = await buildWith({
      ...defaultPrintParams(),
      engravings: [{ edge: "right", text: "2026-09-06", mode: "emboss", size_mm: 8 }],
    });
    const line = sans.resolvedText.find((entry) => entry.id === "engraving-0");
    expect(line?.status).toBe("cuts");
    expect(line?.joined).toBeGreaterThanOrEqual(1);
    const note = sans.findings.find((f) => f.id === "lettering-adjusted" && f.title.includes("joined"));
    expect(note?.severity).toBe("info");
    expect(note?.title).toBe(`"2026-09-06" had ${line?.joined} pair(s) of letters joined`);
    const gap = Number(/came within (\d+\.\d\d) mm/.exec(note?.detail ?? "")?.[1]);
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(0.36);
    expect(note?.detail).toContain("0.36 mm");
    expect(note?.detail).toContain("6.01 mm would keep them apart");
    expect(sans.findings.some((f) => f.id === "text-too-small")).toBe(false);
    const frame = regionOf(sans, "frame")!;
    expect(frame.volumeMm3).toBeGreaterThan(regionOf(plain, "frame")!.volumeMm3);
    expect(frame.bodies).toBe(1);
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);

  it("refuses an embossed pair that would fuse into one shape, naming the run", async () => {
    // Two straight stems are under a nozzle along the whole height they
    // share, and filling that prints one clean bar where the user typed two
    // letters. `EMBOSS_JOIN_MAX_EM` draws the line at 0.4 em; the refusal
    // names the gap, how far it runs and the size that keeps the pair apart.
    const sans = await buildWith({
      ...defaultPrintParams(),
      engravings: [{ edge: "right", text: "Illinois", mode: "emboss", size_mm: 8 }],
    });
    const line = sans.resolvedText.find((entry) => entry.id === "engraving-0");
    expect(line?.status).toBe("skipped");
    expect(line?.reason).toContain("would print as one shape rather than as two letters that touch");
    const run = Number(/along (\d+\.\d\d) mm of their height/.exec(line?.reason ?? "")?.[1]);
    expect(run).toBeGreaterThan(0.4 * (line?.sizeMm ?? 0));
    const gap = Number(/run within (\d+\.\d\d) mm/.exec(line?.reason ?? "")?.[1]);
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(0.36);
    expect(line?.reason).toContain("0.36 mm");
    expect(sans.findings.some((f) => f.id === "text-too-small")).toBe(true);
    // The same string in mono keeps a nozzle between its stems and is built
    // with nothing joined: the rule is about the measured slot, not the mode.
    const mono = await buildWith({
      ...defaultPrintParams(),
      engravings: [{ edge: "right", text: "Illinois", mode: "emboss", size_mm: 8, font: "mono" }],
    });
    const monoLine = mono.resolvedText.find((entry) => entry.id === "engraving-0");
    expect(monoLine?.status).toBe("cuts");
    expect(monoLine?.joined).toBeUndefined();
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);

  it("refuses edge text when there is no lip to carry it", async () => {
    const result = await buildWith({
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

/**
 * The emboss gap merge's decisions, pinned against the reference implementation
 * (`fixtures/emboss-gaps-expected.json`, generated by
 * `services/bake/tests/test_lettering.py`): built or refused, the pairs
 * joined, and whether the refusal was the fusion rule. The geometry of a join
 * is each library's own (Clipper2's disc against GEOS's); the decision is what
 * the mirror promises.
 */
const embossGaps = JSON.parse(
  readFileSync(new URL("../../../../../fixtures/emboss-gaps-expected.json", import.meta.url), "utf8"),
) as {
  cases: {
    name: string;
    engravings: PrintParams["engravings"];
    expect: { built: boolean; joined: number; fused: boolean };
  }[];
  /**
   * Lines the two engines are KNOWN to count differently, pinned rather than
   * left out (the `matrix.probes.ts:KNOWN_DEFECTS` idiom): each side is held
   * to ITS number, so a change on either side is a red test, and a row whose
   * two numbers have become equal is stale and belongs in `cases`.
   */
  divergences: {
    name: string;
    engravings: PrintParams["engravings"];
    reason: string;
    expect: { built: boolean; fused: boolean; reference_joined: number; engine_joined: number };
  }[];
};

describe("emboss gap parity with the reference", () => {
  it("pins every outcome the mirror could get wrong, counting only the agreeing lines", () => {
    const byName = Object.fromEntries(embossGaps.cases.map((c) => [c.name, c.expect]));
    expect(embossGaps.cases.length).toBeGreaterThanOrEqual(11);
    expect(Object.values(byName).filter((e) => e.built && e.joined >= 1).length).toBeGreaterThanOrEqual(3);
    expect(Object.values(byName).filter((e) => e.fused).length).toBeGreaterThanOrEqual(2);
    expect(Object.values(byName).filter((e) => e.built && e.joined === 0).length).toBeGreaterThanOrEqual(2);
    for (const row of embossGaps.divergences) {
      expect(row.expect.reference_joined, row.name).not.toBe(row.expect.engine_joined);
      expect(row.reason.length, row.name).toBeGreaterThan(0);
    }
  });

  it.each(embossGaps.cases)("decides $name as the reference does", async (testCase) => {
    const result = await buildWith({ ...defaultPrintParams(), engravings: testCase.engravings });
    const line = result.resolvedText.find((entry) => entry.id === "engraving-0");
    expect(line?.status).toBe(testCase.expect.built ? "cuts" : "skipped");
    expect(line?.joined ?? 0).toBe(testCase.expect.joined);
    expect(/one shape rather than as two letters/.test(line?.reason ?? "")).toBe(testCase.expect.fused);
    expect(outstandingWasmObjects()).toBe(0);
  }, 60_000);

  it.each(embossGaps.divergences)("counts $name as the engine is known to, not as the reference does", async (row) => {
    const result = await buildWith({ ...defaultPrintParams(), engravings: row.engravings });
    const line = result.resolvedText.find((entry) => entry.id === "engraving-0");
    const head = `KNOWN DIVERGENCE (docs/handoff/FAILURES.md): ${row.reason}`;
    expect(line?.status, head).toBe(row.expect.built ? "cuts" : "skipped");
    expect(/one shape rather than as two letters/.test(line?.reason ?? ""), head).toBe(row.expect.fused);
    expect(line?.joined ?? 0, head).toBe(row.expect.engine_joined);
    // Agreement here is not a pass: the row is stale and belongs in `cases`.
    expect(line?.joined ?? 0, `${row.name}: the engines agree now; move it to EMBOSS_GAP_CASES`).not.toBe(
      row.expect.reference_joined,
    );
    expect(outstandingWasmObjects()).toBe(0);
  }, 60_000);
});

describe("inlay mode", () => {
  it("emits the letters as their own region and pockets the frame to hold them", async () => {
    const plain = await buildWith(defaultPrintParams());
    const inlaid = await buildWith({
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
    const plain = await buildWith(defaultPrintParams());
    const marked = await buildWith({
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
    const plain = await buildWith(defaultPrintParams());
    const barred = await buildWith({
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
    const result = await buildWith({
      ...defaultPrintParams(),
      frame: false,
      north_arrow: { enabled: true, corner: "ne", size_mm: 4 },
      scale_bar: { enabled: true, edge: "bottom", length_mode: "auto", length_m: 500 },
    });
    // Nothing the PARAMETERS asked for is cut. The mandatory attribution marks
    // are not parameters: they are cut on every build, with a second underside
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
