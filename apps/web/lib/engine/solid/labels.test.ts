/**
 * Surface labels on a small plate (v3.1 Task 12).
 *
 * Every number here is measured off a real build of the synthetic block
 * scene: a roof label takes volume out of the building it names (or adds it,
 * embossed), a ground label out of the park, a road name follows a bend and is
 * set straight on a hairpin, and every refusal is a `ResolvedLine` with a
 * reason and a finding, never a throw. The strict-claims build at the end is
 * what keeps the `labels` stage's declared reads honest.
 */

import { describe, expect, it } from "vitest";

import { defaultPrintParams, type Label, type Point, type PrintParams, type SceneGraph } from "../../contracts";
import { buildModel } from "../engine";
import type { EngineResult, RegionName } from "../types";
import { area, building, road, scene, square } from "./fixture";
import { outstandingWasmObjects } from "./manifold";

const RADIUS_M = 200;

/** A quarter circle of radius `r` metres, turning left from east to north. */
function bend(cx: number, cy: number, r: number): Point[] {
  const out: Point[] = [];
  for (let deg = 0; deg <= 90; deg += 6) {
    const t = (deg * Math.PI) / 180;
    out.push([cx + r * Math.sin(t), cy + r * (1 - Math.cos(t))]);
  }
  return out;
}

/** A hairpin: out 60 m, across 6 m, back 60 m. */
const HAIRPIN: Point[] = [
  [-160, 120],
  [-100, 120],
  [-100, 126],
  [-160, 126],
];

function labelScene(): SceneGraph {
  return scene({
    radiusM: RADIUS_M,
    buildings: [
      { ...building("b-hall", square(-60, 40, 60), 24), name: "City Hall" },
      { ...building("b-tall", square(60, 60, 50), 80), name: "Tower" },
      building("b-shed", square(120, -40, 14), 6),
    ],
    roads: [
      { ...road("r-main", [[-190, -10], [190, -10]], 16), name: "Main Street" },
      { ...road("r-bend", bend(20, -150, 120), 20), name: "Bend Road" },
      { ...road("r-pin", HAIRPIN, 12), name: "Hairpin" },
    ],
    water: [{ ...area(square(-130, -110, 60)), osm_id: "r-pond", name: "Pond" }],
    green: [{ ...area(square(130, 110, 90)), osm_id: "w-park", name: "Park" }],
  });
}

const SCENE = labelScene();

function regionOf(result: EngineResult, name: RegionName) {
  return result.regions.find((region) => region.region === name);
}

/** True when two vertex buffers are the same points in the same order. */
function sameVertices(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (Math.abs(a[i] - b[i]) > 1e-9) return false;
  return true;
}

/** The labels' own lines: `resolvedText` also carries the mandatory attribution marks. */
function labelLines(result: EngineResult) {
  return result.resolvedText.filter((line) => line.id.startsWith("label-"));
}

async function buildWith(params: PrintParams, strict = false): Promise<EngineResult> {
  return buildModel({ scene: SCENE, params, date: "2026-09-03" }, strict ? { strictClaims: true } : {});
}

function withLabels(labels: Label[], more: Partial<PrintParams> = {}): PrintParams {
  return { ...defaultPrintParams(), ...more, labels };
}

const ROOF: Label = { target_osm_id: "b-hall", layer: "building", surface: "building_top" };

describe("roof labels", () => {
  it("engraves the building's name into its roof, inside the roof, and reports the band", async () => {
    const plain = await buildWith(withLabels([]));
    const cut = await buildWith(withLabels([{ ...ROOF, size_mm: 5 }]));
    const line = cut.resolvedText.find((entry) => entry.id === "label-0");
    expect(line?.status).toBe("cuts");
    expect(line?.text).toBe("City Hall");
    expect(line?.surface).toBe("Roof of City Hall");
    expect(line?.mode).toBe("engrave");
    expect(regionOf(cut, "buildings")!.volumeMm3).toBeLessThan(regionOf(plain, "buildings")!.volumeMm3);
    // Nothing else moved: the base, the roads and the park are byte-for-byte the plain build's.
    for (const name of ["base", "roads", "parks", "water"] as const) {
      expect(regionOf(cut, name)!.volumeMm3, name).toBeCloseTo(regionOf(plain, name)!.volumeMm3, 6);
    }
    expect(cut.labelBands).toHaveLength(1);
    const band = cut.labelBands![0];
    expect(band.id).toBe("label-0");
    expect(band.mode).toBe("engrave");
    expect(band.region).toBe("buildings");
    // The band is the default 0.4 mm under the roof, and the roof is 24 m at
    // 0.42 mm/m above a 3 mm base.
    const roofZ = 3 + 24 * (180 - 12) / (2 * RADIUS_M * 1);
    expect(band.faceZMm).toBeCloseTo(roofZ, 3);
    expect(band.zMm[1] - band.zMm[0]).toBeCloseTo(0.4, 6);
    // The ink rectangle sits over the hall's footprint, a wall inside its edge.
    const scale = (180 - 12) / (2 * RADIUS_M);
    for (const [x, y] of band.rect) {
      expect(Math.abs(x - -60 * scale)).toBeLessThan(30 * scale - 0.8 + 0.4 + 1e-6);
      expect(Math.abs(y - 40 * scale)).toBeLessThan(30 * scale - 0.8 + 0.4 + 1e-6);
    }
    expect(cut.findings.some((f) => f.id === "label-not-cut")).toBe(false);
    expect(outstandingWasmObjects()).toBe(0);
  }, 90_000);

  it("stands an embossed name proud of the roof, in the building's own region", async () => {
    const plain = await buildWith(withLabels([]));
    const raised = await buildWith(withLabels([{ ...ROOF, mode: "emboss", size_mm: 5, depth_mm: 0.6 }]));
    const buildings = regionOf(raised, "buildings")!;
    expect(raised.resolvedText[0]?.status).toBe("cuts");
    expect(buildings.volumeMm3).toBeGreaterThan(regionOf(plain, "buildings")!.volumeMm3);
    const band = raised.labelBands![0];
    expect(band.zMm[0]).toBeCloseTo(band.faceZMm, 6);
    expect(band.zMm[1]).toBeCloseTo(band.faceZMm + 0.6, 6);
    // The tallest thing in the buildings region is still the tower, so the
    // emboss shows as material inside the band rather than a new maximum.
    const hall = regionOf(raised, "buildings")!;
    let inBand = 0;
    for (let i = 0; i < hall.positions.length; i += 3) {
      const z = hall.positions[i + 2];
      if (z > band.faceZMm + 1e-6 && z <= band.zMm[1] + 1e-6) inBand += 1;
    }
    expect(inBand).toBeGreaterThan(0);
  }, 90_000);

  it("labels a picked hero's roof in the hero region", async () => {
    const result = await buildWith(withLabels([{ ...ROOF, target_osm_id: "b-tall" }], { hero_building_ids: ["b-tall"] }));
    expect(result.resolvedText[0]?.status).toBe("cuts");
    expect(result.labelBands![0].region).toBe("hero_building");
    const hero = regionOf(result, "hero_building")!;
    const plain = await buildWith(withLabels([], { hero_building_ids: ["b-tall"] }));
    expect(hero.volumeMm3).toBeLessThan(regionOf(plain, "hero_building")!.volumeMm3);
  }, 90_000);

  it("uses the label's own text over the name, and the anchor puts it where u, v say", async () => {
    const left = await buildWith(withLabels([{ ...ROOF, text: "WEST", u: 0.2, v: 0.5, size_mm: 3 }]));
    const right = await buildWith(withLabels([{ ...ROOF, text: "WEST", u: 0.8, v: 0.5, size_mm: 3 }]));
    expect(left.resolvedText[0]?.text).toBe("WEST");
    const centre = (rect: Array<[number, number]>): number => rect.reduce((sum, p) => sum + p[0], 0) / rect.length;
    // The hall is a square, so the long side is whichever way the hull came
    // out; the two anchors are 0.6 of it apart along that side.
    const dx = centre(right.labelBands![0].rect) - centre(left.labelBands![0].rect);
    const dy =
      right.labelBands![0].rect.reduce((sum, p) => sum + p[1], 0) / 4 - left.labelBands![0].rect.reduce((sum, p) => sum + p[1], 0) / 4;
    const scale = (180 - 12) / (2 * RADIUS_M);
    expect(Math.hypot(dx, dy)).toBeCloseTo(0.6 * 60 * scale, 3);
  }, 90_000);
});

describe("ground labels", () => {
  it("engraves the park's name into the park, and the base under a deep groove", async () => {
    const plain = await buildWith(withLabels([]));
    const shallow = await buildWith(withLabels([{ target_osm_id: "w-park", layer: "green", surface: "ground", size_mm: 5 }]));
    expect(shallow.resolvedText[0]?.status).toBe("cuts");
    expect(shallow.resolvedText[0]?.surface).toBe("Green, Park");
    expect(regionOf(shallow, "parks")!.volumeMm3).toBeLessThan(regionOf(plain, "parks")!.volumeMm3);
    // The default park is 0.4 mm thick and flush, so a 0.4 mm groove stops at
    // the pocket floor and the base keeps its volume...
    expect(regionOf(shallow, "base")!.volumeMm3).toBeCloseTo(regionOf(plain, "base")!.volumeMm3, 4);
    // ...and a 0.8 mm groove reaches 0.4 mm into the plate.
    const deep = await buildWith(withLabels([{ target_osm_id: "w-park", layer: "green", surface: "ground", size_mm: 5, depth_mm: 0.8 }]));
    expect(regionOf(deep, "base")!.volumeMm3).toBeLessThan(regionOf(plain, "base")!.volumeMm3);
    expect(deep.labelBands![0].region).toBe("parks");
    expect(deep.labelBands![0].faceZMm).toBeCloseTo(3.0, 6);
  }, 120_000);

  it("labels the water and a straight street on their own surfaces", async () => {
    const plain = await buildWith(withLabels([]));
    const result = await buildWith(
      withLabels([
        { target_osm_id: "r-pond", layer: "water", surface: "ground", size_mm: 4 },
        { target_osm_id: "r-main", layer: "road", surface: "ground", size_mm: 4 },
      ]),
    );
    expect(labelLines(result).map((line) => [line.id, line.status, line.text])).toEqual([
      ["label-0", "cuts", "Pond"],
      ["label-1", "cuts", "Main Street"],
    ]);
    expect(regionOf(result, "water")!.volumeMm3).toBeLessThan(regionOf(plain, "water")!.volumeMm3);
    expect(regionOf(result, "roads")!.volumeMm3).toBeLessThan(regionOf(plain, "roads")!.volumeMm3);
    // The water's top is recessed 0.5 mm, the road's 0.2 mm: the bands say so.
    expect(result.labelBands![0].faceZMm).toBeCloseTo(2.5, 6);
    expect(result.labelBands![1].faceZMm).toBeCloseTo(2.8, 6);
  }, 120_000);

  it("follows a bend, glyph by glyph, and is set straight on a hairpin with the reason stated", async () => {
    const straight = await buildWith(withLabels([{ target_osm_id: "r-bend", layer: "road", surface: "ground", size_mm: 4, follow: false }]));
    const curved = await buildWith(withLabels([{ target_osm_id: "r-bend", layer: "road", surface: "ground", size_mm: 4, follow: true }]));
    expect(straight.resolvedText[0]?.status).toBe("cuts");
    expect(curved.resolvedText[0]?.status).toBe("cuts");
    expect(curved.findings.some((f) => f.id === "label-adjusted" && /set straight/.test(f.title))).toBe(false);
    // A followed label's ink polygon is the hull of its glyph boxes, not a rectangle.
    expect(curved.labelBands![0].rect.length).toBeGreaterThan(4);
    expect(straight.labelBands![0].rect.length).toBe(4);
    // The two remove nearly the same volume; what differs is WHERE. The roads
    // mesh carries different vertices once the glyphs sit on their chords.
    expect(sameVertices(regionOf(curved, "roads")!.positions, regionOf(straight, "roads")!.positions)).toBe(false);

    const pinned = await buildWith(withLabels([{ target_osm_id: "r-pin", layer: "road", surface: "ground", size_mm: 4, text: "PIN", follow: true }]));
    const adjusted = pinned.findings.find((f) => f.id === "label-adjusted" && /set straight/.test(f.title));
    expect(adjusted?.detail).toMatch(/turns \d+ degrees between two letters|only .* mm|tighter than/);
  }, 150_000);
});

describe("fit and refusal", () => {
  it("shrinks a name that does not fit its roof, and says by how much", async () => {
    const result = await buildWith(withLabels([{ ...ROOF, target_osm_id: "b-tall", text: "LONG NAME", size_mm: 8 }]));
    const line = result.resolvedText[0];
    expect(line?.status).toBe("cuts");
    expect(line?.sizeMm).toBeLessThan(8);
    const note = result.findings.find((f) => f.id === "label-adjusted");
    expect(note?.severity).toBe("info");
    expect(note?.detail).toMatch(/Reduced from 8.00 mm to \d\.\d\d mm to fit inside the roof of Tower/);
  }, 90_000);

  it("refuses a name that does not fit even at the smallest legal size, rather than overhanging", async () => {
    const result = await buildWith(withLabels([{ ...ROOF, target_osm_id: "b-shed", text: "THE SHED AT THE BOTTOM OF THE GARDEN" }]));
    const line = result.resolvedText[0];
    expect(line?.status).toBe("skipped");
    expect(line?.reason).toMatch(/does not fit inside the roof of b-shed .* even at 1.50 mm/);
    const finding = result.findings.find((f) => f.id === "label-not-cut");
    expect(finding?.severity).toBe("warning");
    expect(finding?.fix).toBeUndefined();
    // Nothing was cut: the shed keeps its full volume.
    const plain = await buildWith(withLabels([]));
    expect(regionOf(result, "buildings")!.volumeMm3).toBeCloseTo(regionOf(plain, "buildings")!.volumeMm3, 6);
  }, 90_000);

  it("refuses a thin glyph the dilation would close, naming the size that works, with a one-click resize", async () => {
    // Serif at 1.5 mm: the hairlines are widened to a nozzle and the counters close.
    const result = await buildWith(withLabels([{ ...ROOF, text: "Boe", font: "serif", size_mm: 1.5 }]));
    const line = result.resolvedText[0];
    expect(line?.status).toBe("skipped");
    expect(line?.reason).toMatch(/closing a counter|closed \d counter/);
    const finding = result.findings.find((f) => f.id === "label-not-cut");
    expect(finding?.fix?.label).toMatch(/Set this label to \d\.\d\d mm/);
    const patch = finding?.fix?.patch as { labels: Label[] };
    expect(patch.labels[0].size_mm).toBeGreaterThan(1.5);
    // ...and at that size it cuts.
    const grown = await buildWith(withLabels(patch.labels));
    expect(grown.resolvedText[0]?.status).toBe("cuts");
  }, 120_000);

  it("skips a label whose target is not in the scene, and one with no name and no text", async () => {
    const result = await buildWith(
      withLabels([
        { target_osm_id: "w-elsewhere", layer: "building", surface: "building_top" },
        { target_osm_id: "b-shed", layer: "building", surface: "building_top" },
        { target_osm_id: "r-main", layer: "road", surface: "building_top" },
      ]),
    );
    expect(labelLines(result).map((line) => line.status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(result.resolvedText[0]?.reason).toMatch(/not in this scene/);
    expect(result.resolvedText[1]?.reason).toMatch(/no OpenStreetMap name/);
    expect(result.resolvedText[2]?.reason).toMatch(/only a building has a roof/);
    expect(result.findings.filter((f) => f.id === "label-not-cut")).toHaveLength(3);
    expect(result.labelBands).toEqual([]);
  }, 90_000);

  it("never trips the structural wall gate on its own ridges, and passes the export gate", async () => {
    const result = await buildWith(
      withLabels([
        { ...ROOF, size_mm: 4 },
        { target_osm_id: "w-park", layer: "green", surface: "ground", size_mm: 4 },
        // An emboss is two nozzles wide, so a lowercase name closes at 4 mm;
        // uppercase at 5 mm is what the frame's own emboss test uses.
        { target_osm_id: "r-main", layer: "road", surface: "ground", size_mm: 5, text: "MAIN", mode: "emboss" },
      ]),
    );
    expect(labelLines(result).map((line) => line.status)).toEqual(["cuts", "cuts", "cuts"]);
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(result.stats.measuredMinWallMm).not.toBeNull();
    expect(result.stats.measuredMinWallMm!).toBeGreaterThanOrEqual(0.9 * result.stats.minWallMm);
  }, 120_000);
});

describe("the labels stage's claims", () => {
  it("reads nothing it did not declare, with every kind of label on the plate", async () => {
    const result = await buildWith(
      withLabels(
        [
          { ...ROOF, text: "HALL", size_mm: 6, mode: "emboss", font: "mono" },
          { target_osm_id: "w-park", layer: "green", surface: "ground", size_mm: 4, rotation_deg: 30 },
          { target_osm_id: "r-bend", layer: "road", surface: "ground", size_mm: 4, follow: true, v: 0.4 },
          { target_osm_id: "r-pond", layer: "water", surface: "ground", size_mm: 4, depth_mm: 0.6 },
        ],
        { hero_building_ids: ["b-tall"] },
      ),
      true,
    );
    expect(labelLines(result).map((line) => line.status)).toEqual(["cuts", "cuts", "cuts", "cuts"]);
  }, 150_000);
});
