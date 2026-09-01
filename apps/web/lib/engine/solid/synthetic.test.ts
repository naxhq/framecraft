/**
 * Small scenes, one property each.
 *
 * Every case here is a rule from `04_PRINTABILITY_SPEC.md` that the Chicago
 * golden exercises a thousand times over and can therefore never point at: a
 * single square, a gap under the minimum, a hole, a ring that crosses itself,
 * and nothing at all. They are cheap enough to run on every commit.
 */

import { describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams } from "../../contracts";
import { bake } from "../engine";
import type { EngineResult, RegionName } from "../types";
import { building, hillGrid, scene, solidFromMesh, square, squareHole } from "./fixture";
import { loadManifold, outstandingWasmObjects } from "./manifold";
import * as T from "../../transform";

/** At radius 200 m on a 180 mm plate the scale is 0.42 mm per ground metre. */
const RADIUS_M = 200;

function regionOf(result: EngineResult, name: RegionName) {
  return result.regions.find((region) => region.region === name);
}

async function genusOf(result: EngineResult, name: RegionName): Promise<number> {
  const wasm = await loadManifold();
  const region = regionOf(result, name);
  if (region === undefined) throw new Error(`no ${name} region`);
  const solid = solidFromMesh(wasm, region);
  try {
    return solid.genus();
  } finally {
    solid.delete();
  }
}

describe("a single square building", () => {
  it("prints as one body on a base that fits it", async () => {
    const result = await bake({
      scene: scene({
        radiusM: RADIUS_M,
        buildings: [building("w1", square(0, 0, 40), 30)],
      }),
      params: defaultPrintParams(),
      date: "2026-08-30",
    });

    const buildings = regionOf(result, "buildings");
    expect(buildings).toBeDefined();
    expect(buildings?.bodies).toBe(1);
    expect(result.stats.buildings).toBe(1);
    expect(result.stats.buildingsMerged).toBe(0);
    expect(result.stats.buildingsDilated).toBe(0);

    // 40 m at 0.42 mm/m is 16.8 mm square, from the skirt to the printed roof.
    const scale = T.scale_mm_per_m(result.params, RADIUS_M);
    const top = T.building_top_mm_for(
      { height_m: 30, is_tall: false },
      result.params,
      scale,
      false,
    );
    expect(buildings?.bbox.max[2]).toBeCloseTo(top, 3);
    const skirt = result.params.regions?.building_skirt_mm ?? 0.3;
    expect(buildings?.bbox.min[2]).toBeCloseTo(T.base_top_mm(result.params) - skirt, 2);
    expect(buildings?.bbox.max[0] ?? 0).toBeCloseTo(40 * scale * 0.5, 2);

    // The base is socketed by exactly that footprint, so the two touch and
    // never overlap, and the whole model is one connected piece.
    const base = regionOf(result, "base");
    expect(base?.bodies).toBe(1);
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(outstandingWasmObjects()).toBe(0);
  }, 60_000);
});

describe("two buildings separated by a sub-minimum gap", () => {
  it("merges them into one block and keeps the taller height", async () => {
    // The gap is 1 m, and at this scale the minimum printable gap is 1.43 m.
    const merged = await bake({
      scene: scene({
        radiusM: RADIUS_M,
        buildings: [
          building("w1", square(-20.5, 0, 40), 20),
          building("w2", square(20.5, 0, 40), 60),
        ],
      }),
      params: defaultPrintParams(),
      date: "2026-08-30",
    });
    expect(regionOf(merged, "buildings")?.bodies).toBe(1);
    expect(merged.stats.buildingsMerged).toBe(1);

    // 04 stage 1 step 5: the block takes the area-weighted 80th percentile of
    // the heights it swallowed, and a contributor over 1.5x that keeps its own
    // solid stacked on top. Two equal footprints at 20 m and 60 m give a block
    // of 60 m (the 80th percentile of an equal-weight pair is the taller one),
    // so nothing is stacked and the block is exactly 60 m tall.
    const scale = T.scale_mm_per_m(merged.params, RADIUS_M);
    const expected = T.building_top_mm_for(
      { height_m: 60, is_tall: true },
      merged.params,
      scale,
      false,
    );
    expect(regionOf(merged, "buildings")?.bbox.max[2]).toBeCloseTo(expected, 3);

    // The same pair 10 m apart stays two blocks.
    const apart = await bake({
      scene: scene({
        radiusM: RADIUS_M,
        buildings: [
          building("w1", square(-25, 0, 40), 20),
          building("w2", square(25, 0, 40), 60),
        ],
      }),
      params: defaultPrintParams(),
      date: "2026-08-30",
    });
    expect(regionOf(apart, "buildings")?.bodies).toBe(2);
    expect(apart.stats.buildingsMerged).toBe(0);
    expect(outstandingWasmObjects()).toBe(0);
  }, 60_000);
});

describe("a building with a hole", () => {
  it("keeps the hole through the solid", async () => {
    const result = await bake({
      scene: scene({
        radiusM: RADIUS_M,
        buildings: [building("w1", square(0, 0, 60), 30, [squareHole(0, 0, 20)])],
      }),
      params: defaultPrintParams(),
      date: "2026-08-30",
    });
    const buildings = regionOf(result, "buildings");
    expect(buildings?.bodies).toBe(1);
    // One handle: a courtyard block is a torus, not a box.
    expect(await genusOf(result, "buildings")).toBe(1);

    // And the base is socketed by the ring, not by the whole square: the
    // courtyard floor is still base.
    const scale = T.scale_mm_per_m(result.params, RADIUS_M);
    const skirt = result.params.regions?.building_skirt_mm ?? 0.3;
    const ringArea = (60 * 60 - 20 * 20) * scale * scale;
    const height =
      T.building_top_mm_for({ height_m: 30, is_tall: false }, result.params, scale, false) -
      (T.base_top_mm(result.params) - skirt);
    // Within a fifth of a per cent: the footprint a region is extruded from is
    // grown by `POCKET_GROW_MM` so it fills the pocket carved for it exactly
    // (`areas.fittedSolid`), which adds two micrometres all the way round.
    expect(buildings?.volumeMm3 ?? 0).toBeGreaterThan(ringArea * height);
    expect((buildings?.volumeMm3 ?? 0) / (ringArea * height)).toBeLessThan(1.002);
    expect(outstandingWasmObjects()).toBe(0);
  }, 60_000);
});

describe("a self-intersecting ring", () => {
  it("bakes the positively wound part instead of failing", async () => {
    // A bowtie: the diagonal crossing makes this ring invalid for any naive
    // extruder. 04's trap list is explicit that the fix is a validity repair,
    // never `buffer(0)`; here the `Positive` fill rule does the same job.
    const result = await bake({
      scene: scene({
        radiusM: RADIUS_M,
        buildings: [
          building(
            "w1",
            [
              [-30, -30],
              [30, 30],
              [30, -30],
              [-30, 30],
            ],
            30,
          ),
        ],
      }),
      params: defaultPrintParams(),
      date: "2026-08-30",
    });
    const buildings = regionOf(result, "buildings");
    expect(buildings).toBeDefined();
    expect(buildings?.volumeMm3 ?? 0).toBeGreaterThan(0);
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    const wasm = await loadManifold();
    const solid = solidFromMesh(wasm, buildings!);
    try {
      expect(solid.status()).toBe("NoError");
    } finally {
      solid.delete();
    }
    expect(outstandingWasmObjects()).toBe(0);
  }, 60_000);
});

describe("an empty scene", () => {
  it("bakes the plate and the frame and says nothing is wrong", async () => {
    const result = await bake({
      scene: scene({ radiusM: RADIUS_M }),
      params: defaultPrintParams(),
      date: "2026-08-30",
    });
    expect(result.regions.map((region) => region.region)).toEqual(["base", "frame"]);
    const base = regionOf(result, "base");
    const frame = regionOf(result, "frame");
    expect(base?.bodies).toBe(1);
    expect(frame?.bodies).toBe(1);
    // A 180 mm plate 3 mm thick, less the 0.6 mm chamfer round its bottom edge.
    expect(base?.volumeMm3 ?? 0).toBeGreaterThan(96_000);
    expect(base?.volumeMm3 ?? 0).toBeLessThan(97_200);
    // The 6 mm lip, 2 mm proud - plus the 0.2 mm it reaches DOWN into the
    // plate, because the lip is its own colour part and must interpenetrate
    // the base rather than rest on a coincident face
    // (`context.PART_OVERLAP_MM`). (180^2 - 168^2) * 2.2.
    const ring = 180 * 180 - 168 * 168;
    expect(frame?.volumeMm3 ?? 0).toBeCloseTo(ring * 2.2, 0);
    expect(frame?.bbox.min[2] ?? 0).toBeCloseTo(3 - 0.2, 3);
    expect(result.stats.buildings).toBe(0);
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(outstandingWasmObjects()).toBe(0);
  }, 60_000);
});

describe("surface regions", () => {
  it("sinks water, floats nothing, and gives way in precedence order", async () => {
    const result = await bake({
      scene: scene({
        radiusM: RADIUS_M,
        water: [{ ring: square(0, 0, 120), holes: [] }],
        green: [{ ring: square(0, 0, 160), holes: [] }],
        roads: [
          {
            id: "r1",
            path: [
              [-150, 0],
              [150, 0],
            ],
            width_m: 20,
            class: "primary",
          },
        ],
      }),
      params: defaultPrintParams(),
      date: "2026-08-30",
    });
    const baseTop = T.base_top_mm(result.params);
    const water = regionOf(result, "water");
    const roads = regionOf(result, "roads");
    const parks = regionOf(result, "parks");
    expect(water).toBeDefined();
    expect(roads).toBeDefined();
    expect(parks).toBeDefined();
    // Defaults: water top 0.5 below the surface, roads 0.2 below, parks flush.
    expect(water?.bbox.max[2] ?? 0).toBeCloseTo(baseTop - 0.5, 2);
    expect(roads?.bbox.max[2] ?? 0).toBeCloseTo(baseTop - 0.2, 2);
    expect(parks?.bbox.max[2] ?? 0).toBeCloseTo(baseTop, 2);
    // Water wins the ground it shares with the road, and the park gives way to
    // both: its area is the difference, not the whole 160 m square.
    const scale = T.scale_mm_per_m(result.params, RADIUS_M);
    const parkArea = (parks?.volumeMm3 ?? 0) / 0.4;
    expect(parkArea).toBeLessThan(160 * 160 * scale * scale);
    expect(parkArea).toBeGreaterThan(0);
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(outstandingWasmObjects()).toBe(0);
  }, 60_000);

  it("says so when road_mode and the region placement disagree", async () => {
    const params: PrintParams = { ...defaultPrintParams(), road_mode: "emboss" };
    const result = await bake({
      scene: scene({
        radiusM: RADIUS_M,
        roads: [
          {
            id: "r1",
            path: [
              [-150, 0],
              [150, 0],
            ],
            width_m: 20,
            class: "primary",
          },
        ],
      }),
      params,
      date: "2026-08-30",
    });
    const conflict = result.findings.find((f) => f.id === "road-placement-conflict");
    expect(conflict).toBeDefined();
    expect(conflict?.fix?.safe).toBe(true);
  }, 60_000);
});

describe("hangers and underside text", () => {
  it("refuses a keyhole that would break through a thin base", async () => {
    const params: PrintParams = {
      ...defaultPrintParams(),
      base_thickness_mm: 2,
      hanger: "keyhole",
    };
    const result = await bake({
      scene: scene({ radiusM: RADIUS_M }),
      params,
      date: "2026-08-30",
    });
    const refusal = result.findings.find((f) => f.id === "hanger-refused");
    expect(refusal).toBeDefined();
    expect(refusal?.detail).toContain("mm");
    // Refused, not cut: the base is untouched.
    const base = regionOf(result, "base");
    expect(base?.bodies).toBe(1);
    expect(outstandingWasmObjects()).toBe(0);
  }, 60_000);

  it("cuts a keyhole when the base can carry it", async () => {
    const thin = await bake({
      scene: scene({ radiusM: RADIUS_M }),
      params: { ...defaultPrintParams(), base_thickness_mm: 6 },
      date: "2026-08-30",
    });
    const hung = await bake({
      scene: scene({ radiusM: RADIUS_M }),
      params: { ...defaultPrintParams(), base_thickness_mm: 6, hanger: "keyhole" },
      date: "2026-08-30",
    });
    expect(hung.findings.find((f) => f.id === "hanger-refused")).toBeUndefined();
    const before = regionOf(thin, "base")?.volumeMm3 ?? 0;
    const after = regionOf(hung, "base")?.volumeMm3 ?? 0;
    expect(after).toBeLessThan(before);
    // An 8 mm entry 2 mm deep is about 100 mm3 with its slot.
    expect(before - after).toBeGreaterThan(50);
    expect(outstandingWasmObjects()).toBe(0);
  }, 60_000);

  it("refuses a mount it does not build instead of ignoring it", async () => {
    const result = await bake({
      scene: scene({ radiusM: RADIUS_M }),
      params: { ...defaultPrintParams(), hanger: "cleat" },
      date: "2026-08-30",
    });
    const refusal = result.findings.find((f) => f.id === "hanger-refused");
    expect(refusal).toBeDefined();
    expect(refusal?.title).toContain("cleat");
  }, 60_000);

  it("engraves a line on the underside, mirrored, without a frame edge", async () => {
    const params: PrintParams = {
      ...defaultPrintParams(),
      base_thickness_mm: 4,
      engravings: [
        { edge: "underside", text: "FrameCraft", mode: "engrave", size_mm: 6, font: "mono" },
      ],
    };
    const plain = await bake({
      scene: scene({ radiusM: RADIUS_M }),
      params: { ...defaultPrintParams(), base_thickness_mm: 4 },
      date: "2026-08-30",
    });
    const marked = await bake({
      scene: scene({ radiusM: RADIUS_M }),
      params,
      date: "2026-08-30",
    });
    const line = marked.resolvedText.find((entry) => entry.id === "underside-0");
    expect(line?.status).toBe("cuts");
    expect(line?.surface).toBe("Underside");
    expect(regionOf(marked, "base")!.volumeMm3).toBeLessThan(
      regionOf(plain, "base")!.volumeMm3,
    );
    expect(outstandingWasmObjects()).toBe(0);
  }, 60_000);
});

describe("the terrain hook", () => {
  it("lifts the plate top, keeps the underside flat and stays one body", async () => {
    const sampler = hillGrid(RADIUS_M);
    const flat = await bake({
      scene: scene({ radiusM: RADIUS_M }),
      params: defaultPrintParams(),
      date: "2026-08-30",
    });
    const hilly = await bake({
      scene: scene({ radiusM: RADIUS_M }),
      params: defaultPrintParams(),
      terrain: sampler,
      date: "2026-08-30",
    });
    expect(regionOf(hilly, "base")!.volumeMm3).toBeGreaterThan(
      regionOf(flat, "base")!.volumeMm3,
    );
    expect(regionOf(hilly, "base")!.bbox.max[2]).toBeGreaterThan(
      regionOf(flat, "base")!.bbox.max[2],
    );
    // The finding this used to raise said the layers were NOT draped. They are
    // now, so it is gone; what is left is the plain fact that nothing errored.
    expect(hilly.findings.find((f) => f.id === "terrain-not-draped")).toBeUndefined();
    expect(hilly.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(regionOf(hilly, "base")!.bodies).toBe(1);
    // Still sits on the bed: the drape's vertical ramp is zero at the chamfer,
    // so the underside cannot move whatever the hillside does.
    expect(regionOf(hilly, "base")!.bbox.min[2]).toBeCloseTo(0, 6);
    // And the plate is still exactly the plate in X and Y: the plan taper takes
    // the displacement to zero before it reaches the crop edge.
    expect(regionOf(hilly, "base")!.bbox.max[0]).toBeCloseTo(
      regionOf(flat, "base")!.bbox.max[0],
      6,
    );
    expect(hilly.stats.terrainReliefMm).toBeGreaterThan(0);
    expect(flat.stats.terrainReliefMm).toBeUndefined();
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);
});
