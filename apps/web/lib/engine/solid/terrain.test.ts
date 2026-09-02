/**
 * Phase 3 geometry: the drape, the recess, bridges, rail, trees and the height
 * exaggeration, each on the smallest scene that can show it.
 *
 * Every height here is measured by PROBING the finished model with a thin
 * column (`fixture.surfaceHeightAt`) rather than by reading a bounding box,
 * because every claim phase 3 makes is local: "the water is half a millimetre
 * below the surface" is false of a bounding box the moment the surface stops
 * being a plane.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams } from "../../contracts";
import * as T from "../../transform";
import { buildModel } from "../engine";
import type { EngineResult, RegionName } from "../types";
import {
  area,
  building,
  rampGrid,
  road,
  scene,
  solidFromMesh,
  square,
  surfaceHeightAt,
} from "./fixture";
import { loadManifold, outstandingWasmObjects, type ManifoldToplevel } from "./manifold";
import { DRAPE_SIMPLIFY_MM, LOW_RELIEF_MM } from "./drape";
import { PLATE_STEP_MM, biggerPlateMm } from "./validate";

/** At radius 200 m on a 180 mm plate with the frame on, 0.42 mm per ground metre. */
const RADIUS_M = 200;
const SCALE = 168 / (2 * RADIUS_M);

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await loadManifold();
});

function regionOf(result: EngineResult, name: RegionName) {
  return result.regions.find((region) => region.region === name);
}

/** Probe the welded model at a plan point, in millimetres. */
function heightAt(result: EngineResult, xMm: number, yMm: number): number | null {
  const solid = solidFromMesh(wasm, result.merged);
  try {
    return surfaceHeightAt(wasm, solid, xMm, yMm);
  } finally {
    solid.delete();
  }
}

/** Probe one region's own solid at a plan point. */
function regionHeightAt(
  result: EngineResult,
  region: RegionName,
  xMm: number,
  yMm: number,
): number | null {
  const mesh = regionOf(result, region);
  if (mesh === undefined) return null;
  const solid = solidFromMesh(wasm, mesh);
  try {
    return surfaceHeightAt(wasm, solid, xMm, yMm);
  } finally {
    solid.delete();
  }
}

/** A ground-metre X as print millimetres. */
const mm = (groundM: number): number => groundM * SCALE;

// ---------------------------------------------------------------------------
// The drape
// ---------------------------------------------------------------------------

describe("the drape", () => {
  it("puts the model on the hillside and leaves the underside flat", async () => {
    const parts = {
      radiusM: RADIUS_M,
      buildings: [building("w1", square(-120, 0, 40), 30)],
      water: [area(square(80, 0, 60))],
      green: [area(square(0, 90, 60))],
      roads: [road("r1", [[-180, -90], [180, -90]], 20)],
    };
    const flat = await buildModel({ scene: scene(parts), params: defaultPrintParams() });
    const hilly = await buildModel({
      scene: scene(parts),
      params: defaultPrintParams(),
      terrain: rampGrid(RADIUS_M, 20),
    });

    // A west-to-east ramp: the surface rises monotonically across the plate.
    const west = heightAt(hilly, mm(-150), mm(40));
    const middle = heightAt(hilly, mm(0), mm(40));
    const east = heightAt(hilly, mm(150), mm(40));
    expect(west).not.toBeNull();
    expect(middle!).toBeGreaterThan(west!);
    expect(east!).toBeGreaterThan(middle!);
    // ... and the flat build does not.
    expect(heightAt(flat, mm(-150), mm(40))).toBeCloseTo(
      heightAt(flat, mm(150), mm(40))!,
      6,
    );

    // Nothing came apart, nothing left the plate, and the bed is still flat.
    expect(hilly.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(hilly.merged.bodies).toBe(1);
    expect(hilly.merged.bbox.min[2]).toBeCloseTo(0, 6);
    expect(hilly.merged.bbox.max[0]).toBeCloseTo(flat.merged.bbox.max[0], 6);
    expect(hilly.merged.bbox.max[1]).toBeCloseTo(flat.merged.bbox.max[1], 6);
    // Every region is still a valid solid.
    for (const region of hilly.regions) {
      expect(region.volumeMm3, region.region).toBeGreaterThan(0);
    }
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);

  it("keeps water a true recess below the LOCAL surface, not the base top", async () => {
    const parts = {
      radiusM: RADIUS_M,
      water: [area(square(60, 0, 80))],
    };
    const params = defaultPrintParams();
    const hilly = await buildModel({
      scene: scene(parts),
      params,
      terrain: rampGrid(RADIUS_M, 20),
    });

    const recess = params.regions?.water?.proud_mm ?? -0.5;
    // Two probes at the same EASTING - the ramp runs west to east, so the two
    // stand on the same contour - one in the pond and one on bare base north of
    // it. The step between them is the recess, wherever on the hillside the
    // pair happens to sit. (Probing east of the pond instead would measure the
    // hill's own rise, which is the mistake this comment exists to prevent.)
    const inWater = heightAt(hilly, mm(60), mm(0))!;
    const onBase = heightAt(hilly, mm(60), mm(80))!;
    expect(inWater).toBeCloseTo(onBase + recess, 1);
    expect(inWater).toBeLessThan(onBase);

    // The floor of that recess IS the water region: what the eye reads as the
    // darker water is the water part's own top face, not a hole in the base.
    // To the drape's own simplification tolerance and no tighter: the region
    // and the assembly are simplified separately after warping, and
    // `DRAPE_SIMPLIFY_MM` is exactly the licence each of them has to move a
    // vertex (measured here at half a nanometre).
    expect(
      Math.abs(regionHeightAt(hilly, "water", mm(60), mm(0))! - inWater),
    ).toBeLessThanOrEqual(2 * DRAPE_SIMPLIFY_MM);

    // And the pond follows the hill rather than staying level: on a ramp its
    // west end is lower than its east end by the relief across its own width.
    const westEnd = heightAt(hilly, mm(30), mm(0))!;
    const eastEnd = heightAt(hilly, mm(90), mm(0))!;
    expect(eastEnd).toBeGreaterThan(westEnd + 0.5);
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);

  it("seats a building on the LOWEST ground under it so nothing floats", async () => {
    // A 120 m footprint on a 20 m ramp: 12 m of fall across the building.
    const parts = {
      radiusM: RADIUS_M,
      buildings: [building("w1", square(0, 0, 120), 30)],
    };
    const params = defaultPrintParams();
    const hilly = await buildModel({
      scene: scene(parts),
      params,
      terrain: rampGrid(RADIUS_M, 20),
    });

    const roof = regionOf(hilly, "buildings")!;
    // A translated building, not a draped one: its roof is a plane.
    const westRoof = regionHeightAt(hilly, "buildings", mm(-50), mm(0))!;
    const eastRoof = regionHeightAt(hilly, "buildings", mm(50), mm(0))!;
    expect(westRoof).toBeCloseTo(eastRoof, 3);
    // It really did move: the roof is above where a flat build would put it.
    const flatTop = T.building_top_mm_for(
      { height_m: 30, is_tall: false },
      params,
      SCALE,
      false,
    );
    expect(roof.bbox.max[2]).toBeGreaterThan(flatTop);
    // ... and it is buried in the hill on its high side rather than floating on
    // its low one: one body, welded to the plate, no islands.
    expect(roof.bodies).toBe(1);
    expect(hilly.merged.bodies).toBe(1);
    expect(hilly.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);

  it("says so when the relief is too small to see", async () => {
    const quiet = await buildModel({
      scene: scene({ radiusM: RADIUS_M }),
      params: defaultPrintParams(),
      // 1 m of relief at 0.42 mm/m is 0.42 mm, half a visible step.
      terrain: rampGrid(RADIUS_M, 1),
    });
    const low = quiet.findings.find((f) => f.id === "terrain-low-relief");
    expect(low).toBeDefined();
    expect(low?.severity).toBe("info");
    expect(quiet.stats.terrainReliefMm).toBeLessThan(LOW_RELIEF_MM);

    const loud = await buildModel({
      scene: scene({ radiusM: RADIUS_M }),
      params: defaultPrintParams(),
      terrain: rampGrid(RADIUS_M, 20),
    });
    expect(loud.findings.find((f) => f.id === "terrain-low-relief")).toBeUndefined();
    expect(loud.stats.terrainReliefMm).toBeGreaterThan(LOW_RELIEF_MM);
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);

  it("applies terrain_exaggeration exactly once", async () => {
    const single = await buildModel({
      scene: scene({ radiusM: RADIUS_M }),
      params: defaultPrintParams(),
      terrain: rampGrid(RADIUS_M, 20),
    });
    const doubled = await buildModel({
      scene: scene({ radiusM: RADIUS_M }),
      params: { ...defaultPrintParams(), terrain_exaggeration: 2 },
      terrain: rampGrid(RADIUS_M, 20),
    });
    // Twice the exaggeration is twice the relief, to the millimetre: if any
    // other module multiplied by it as well this would be four times.
    expect(doubled.stats.terrainReliefMm!).toBeCloseTo(
      2 * single.stats.terrainReliefMm!,
      6,
    );
    expect(single.stats.terrainReliefMm!).toBeCloseTo(20 * SCALE, 6);
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Rail and bridges
// ---------------------------------------------------------------------------

describe("the rail region", () => {
  it("appears from the scene's rail layer at its own width and offset", async () => {
    const withRail = await buildModel({
      scene: scene({
        radiusM: RADIUS_M,
        rail: [{ id: "rail1", path: [[-180, 60], [180, 60]], width_m: 6 }],
      }),
      params: defaultPrintParams(),
    });
    const rail = regionOf(withRail, "rail");
    expect(rail).toBeDefined();
    expect(rail!.volumeMm3).toBeGreaterThan(0);
    // The contract's default rail placement stands 0.3 mm proud, so the track
    // is ABOVE the base top and reads as a raised line, not a groove.
    const params = withRail.params;
    const proud = params.regions?.rail?.proud_mm ?? 0.3;
    expect(rail!.bbox.max[2]).toBeCloseTo(T.base_top_mm(params) + proud, 3);
    // It also takes the rail slot and colour, not the roads one.
    expect(rail!.slot).toBe(params.colour?.region_slots?.rail ?? 4);
    expect(rail!.colorHex).toBe(params.colour?.region_colors?.rail ?? "#6B6B6B");

    // And a scene with no rail layer at all still has no rail region.
    const without = await buildModel({
      scene: scene({ radiusM: RADIUS_M }),
      params: defaultPrintParams(),
    });
    expect(regionOf(without, "rail")).toBeUndefined();
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);

  it("uses params.regions.rail.width_m when the way carries none", async () => {
    const narrow = await buildModel({
      scene: scene({
        radiusM: RADIUS_M,
        rail: [{ id: "rail1", path: [[-180, 60], [180, 60]], width_m: 6 }],
      }),
      params: defaultPrintParams(),
    });
    const wide = await buildModel({
      scene: scene({
        radiusM: RADIUS_M,
        rail: [{ id: "rail1", path: [[-180, 60], [180, 60]], width_m: 20 }],
      }),
      params: defaultPrintParams(),
    });
    expect(regionOf(wide, "rail")!.volumeMm3).toBeGreaterThan(
      regionOf(narrow, "rail")!.volumeMm3 * 1.5,
    );
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);
});

describe("bridges", () => {
  const crossing = {
    radiusM: RADIUS_M,
    water: [area(square(0, 0, 120))],
    roads: [road("r1", [[-180, 0], [180, 0]], 20, { bridge: true })],
  };

  it("lifts a bridge above the water and leaves the water underneath", async () => {
    const params = defaultPrintParams();
    const result = await buildModel({ scene: scene(crossing), params });
    const clearance = params.bridges?.clearance_mm ?? 1.0;

    // Over the middle of the river the model's top is the deck, a clearance
    // above the base top - not the water's recessed surface.
    const overWater = heightAt(result, 0, 0)!;
    expect(overWater).toBeGreaterThan(T.base_top_mm(params) + clearance);

    // The river still has its own surface under the deck: the water region is
    // there, it is recessed, and the bridge did not eat it.
    const water = regionOf(result, "water");
    expect(water).toBeDefined();
    const recess = params.regions?.water?.proud_mm ?? -0.5;
    expect(water!.bbox.max[2]).toBeCloseTo(T.base_top_mm(params) + recess, 3);
    // Water beside the deck (same river, clear of the roadway) reads as water.
    const besideDeck = heightAt(result, 0, mm(40))!;
    expect(besideDeck).toBeCloseTo(T.base_top_mm(params) + recess, 1);

    // The deck belongs to the roads region and prints in its filament.
    const roads = regionOf(result, "roads");
    expect(roads).toBeDefined();
    expect(roads!.bbox.max[2]).toBeGreaterThan(T.base_top_mm(params) + clearance);
    expect(result.stats.bridges).toBe(1);

    // Abutments hold it up, so the whole thing is one piece.
    expect(result.merged.bodies).toBe(1);
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);

  it("lays the same segment at grade when bridges are off", async () => {
    const params: PrintParams = {
      ...defaultPrintParams(),
      bridges: { enabled: false, clearance_mm: 1.0, abutments: true },
    };
    const result = await buildModel({ scene: scene(crossing), params });
    expect(result.stats.bridges).toBeUndefined();
    // No deck: over the river the top of the model is the water surface, and
    // the road gave way to the water exactly as the precedence order says.
    const overWater = heightAt(result, 0, 0)!;
    expect(overWater).toBeLessThan(T.base_top_mm(params) + 0.5);
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);

  it("treats a positive OSM layer as a bridge, and follows the terrain", async () => {
    const params = defaultPrintParams();
    const hilly = await buildModel({
      scene: scene({
        radiusM: RADIUS_M,
        roads: [road("r1", [[-180, 0], [180, 0]], 20, { layer: 1 })],
      }),
      params,
      terrain: rampGrid(RADIUS_M, 20),
    });
    expect(hilly.stats.bridges).toBe(1);
    // The deck rises with the ground it crosses instead of staying level.
    const west = heightAt(hilly, mm(-120), 0)!;
    const east = heightAt(hilly, mm(120), 0)!;
    expect(east).toBeGreaterThan(west + 1);
    expect(hilly.merged.bodies).toBe(1);
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);

  it("warns rather than silently shipping loose decks with abutments off", async () => {
    const params: PrintParams = {
      ...defaultPrintParams(),
      bridges: { enabled: true, clearance_mm: 1.0, abutments: false },
    };
    const result = await buildModel({ scene: scene(crossing), params });
    const warned = result.findings.find((f) => f.id === "bridge-unsupported");
    expect(warned).toBeDefined();
    expect(warned?.severity).toBe("warning");
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

describe("trees", () => {
  it("builds a marker for every tree that clears the printed floor", async () => {
    // 0.42 mm/m, so a 4 m site is 1.68 mm printed: comfortably over the floor.
    const trees = [
      { x: -60, y: -60, radius_m: 4 },
      { x: 0, y: -60, radius_m: 4 },
      { x: 60, y: -60, radius_m: 4 },
    ];
    const result = await buildModel({
      scene: scene({ radiusM: RADIUS_M, trees }),
      params: defaultPrintParams(),
    });
    expect(result.stats.trees).toBe(3);
    expect(result.stats.treesDropped).toBe(0);
    expect(result.findings.find((f) => f.id === "trees-too-small")).toBeUndefined();

    const parks = regionOf(result, "parks");
    expect(parks).toBeDefined();
    expect(parks!.bodies).toBe(3);
    // A cone three times its own radius tall, standing on the surface.
    const params = result.params;
    const height = T.tree_height_mm({ radius_m: 4 }, SCALE);
    expect(parks!.bbox.max[2]).toBeCloseTo(T.base_top_mm(params) + height, 2);
    // ... and it prints in the parkland filament, with no region of its own.
    expect(parks!.slot).toBe(params.colour?.region_slots?.parks ?? 4);
    expect(result.merged.bodies).toBe(1);
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);

  it("drops the ones under the floor with one summary finding", async () => {
    // 0.5 m sites are 0.21 mm printed, under the 0.5 mm floor.
    const trees = Array.from({ length: 7 }, (_unused, i) => ({
      x: -90 + i * 30,
      y: -60,
      radius_m: 0.5,
    }));
    const result = await buildModel({
      scene: scene({ radiusM: RADIUS_M, trees }),
      params: defaultPrintParams(),
    });
    expect(result.stats.trees).toBe(0);
    expect(result.stats.treesDropped).toBe(7);
    const finding = result.findings.find((f) => f.id === "trees-too-small");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("info");
    expect(finding?.detail).toContain("0.50 mm");
    expect(finding?.title).toContain("7 of 7");
    expect(regionOf(result, "parks")).toBeUndefined();
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);

  it("leaves out a tree standing on a building and rides the hillside", async () => {
    const parts = {
      radiusM: RADIUS_M,
      buildings: [building("w1", square(0, 0, 60), 30)],
      trees: [
        { x: 0, y: 0, radius_m: 4 },
        { x: 120, y: 0, radius_m: 4 },
      ],
    };
    const flat = await buildModel({ scene: scene(parts), params: defaultPrintParams() });
    expect(flat.stats.trees).toBe(1);
    expect(flat.findings.find((f) => f.id === "trees-blocked")).toBeDefined();

    const hilly = await buildModel({
      scene: scene(parts),
      params: defaultPrintParams(),
      terrain: rampGrid(RADIUS_M, 20),
    });
    // The surviving tree is east of centre, where the ramp is high, so its top
    // is above where the flat build put it.
    expect(regionOf(hilly, "parks")!.bbox.max[2]).toBeGreaterThan(
      regionOf(flat, "parks")!.bbox.max[2],
    );
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);

  it("honours params.trees", async () => {
    const trees = [{ x: 0, y: -60, radius_m: 4 }];
    const off = await buildModel({
      scene: scene({ radiusM: RADIUS_M, trees }),
      params: { ...defaultPrintParams(), trees: false },
    });
    expect(off.stats.trees).toBeUndefined();
    expect(regionOf(off, "parks")).toBeUndefined();
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Height exaggeration
// ---------------------------------------------------------------------------

describe("height exaggeration", () => {
  const parts = {
    radiusM: RADIUS_M,
    buildings: [building("short", square(-90, 0, 40), 6), building("tall", square(90, 0, 40), 200)],
  };

  it("changes nothing at the defaults", async () => {
    const plain = await buildModel({ scene: scene(parts), params: defaultPrintParams() });
    const explicit = await buildModel({
      scene: scene(parts),
      params: {
        ...defaultPrintParams(),
        height_exaggeration: { multiplier: 1.0, curve: 0.0 },
      },
    });
    expect(explicit.merged.volumeMm3).toBeCloseTo(plain.merged.volumeMm3, 9);
    expect(explicit.merged.bbox.max[2]).toBe(plain.merged.bbox.max[2]);
  }, 120_000);

  it("raises every building by the multiplier, through the shared math", async () => {
    const params: PrintParams = {
      ...defaultPrintParams(),
      height_exaggeration: { multiplier: 2.0, curve: 0.0 },
    };
    const result = await buildModel({ scene: scene(parts), params });
    const shortTop = regionHeightAt(result, "buildings", mm(-90), 0)!;
    expect(shortTop).toBeCloseTo(
      T.building_top_mm_exaggerated({ height_m: 6, is_tall: false }, params, SCALE, false),
      2,
    );
  }, 120_000);

  it("gives short buildings proportionally more with a curve", async () => {
    const linear: PrintParams = {
      ...defaultPrintParams(),
      height_exaggeration: { multiplier: 2.0, curve: 0.0 },
    };
    const curved: PrintParams = {
      ...defaultPrintParams(),
      height_exaggeration: { multiplier: 2.0, curve: 1.0 },
    };
    const a = await buildModel({ scene: scene(parts), params: linear });
    const b = await buildModel({ scene: scene(parts), params: curved });
    const shortA = regionHeightAt(a, "buildings", mm(-90), 0)!;
    const shortB = regionHeightAt(b, "buildings", mm(-90), 0)!;
    const tallA = regionHeightAt(a, "buildings", mm(90), 0)!;
    const tallB = regionHeightAt(b, "buildings", mm(90), 0)!;
    expect(shortB).toBeGreaterThan(shortA);
    expect(tallB).toBeLessThan(tallA);
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// v3-02 audit regressions
// ---------------------------------------------------------------------------

describe("findings that used to vanish (v3-02 audit)", () => {
  it("reports a hero id that is not in the scene", async () => {
    // MAJOR 2. This used to be pushed to `ctx.warnings`, which `EngineResult`
    // has no field for, so a share link carrying hero ids from another city
    // produced a model with no hero and no explanation anywhere.
    const result = await buildModel({
      scene: scene({
        radiusM: RADIUS_M,
        buildings: [building("w1", square(0, 0, 60), 30)],
      }),
      params: { ...defaultPrintParams(), hero_building_ids: ["nonexistent-hero-id"] },
    });
    const unknown = result.findings.find((f) => f.id === "hero-unknown");
    expect(unknown).toBeDefined();
    expect(unknown?.severity).toBe("warning");
    expect(unknown?.detail).toContain("nonexistent-hero-id");
    expect(unknown?.region).toBe("hero_building");
    // A real id raises nothing.
    const clean = await buildModel({
      scene: scene({
        radiusM: RADIUS_M,
        buildings: [building("w1", square(0, 0, 60), 30)],
      }),
      params: { ...defaultPrintParams(), hero_building_ids: ["w1"] },
    });
    expect(clean.findings.find((f) => f.id === "hero-unknown")).toBeUndefined();
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);

  it("reports a recess too deep for the base instead of dropping the region", async () => {
    // MAJOR 3. `proud_mm: -2.0` is the schema minimum and on the contract's own
    // 3 mm base it reaches past the deepest legal pocket floor. The region used
    // to disappear from the output with `findings: []`.
    const parts = { radiusM: RADIUS_M, water: [area(square(0, 0, 120))] };
    const params: PrintParams = {
      ...defaultPrintParams(),
      regions: {
        ...defaultPrintParams().regions,
        water: { depth_mm: 1.0, proud_mm: -2.0 },
      },
    };
    const deep = await buildModel({ scene: scene(parts), params });
    const water = regionOf(deep, "water");
    expect(water).toBeDefined();
    expect(water!.volumeMm3).toBeGreaterThan(0);
    const clamped = deep.findings.find((f) => f.id === "region-placement-clamped");
    expect(clamped).toBeDefined();
    expect(clamped?.severity).toBe("warning");
    expect(clamped?.region).toBe("water");
    // Both numbers are in the message: what was asked for and what was built.
    expect(clamped?.detail).toContain("1.00 mm of depth");
    expect(clamped?.detail).toContain("-2.00 mm");
    expect(clamped?.fix?.safe).toBe(true);
    // It was built as deep as the base allows: the floor is half the base.
    expect(water!.bbox.max[2]).toBeLessThan(T.base_top_mm(params) / 2 + 0.5);

    // The half-way case from the audit: a 1.0 mm depth clamped to a slab.
    const middling = await buildModel({
      scene: scene(parts),
      params: {
        ...params,
        regions: {
          ...defaultPrintParams().regions,
          water: { depth_mm: 1.0, proud_mm: -1.5 },
        },
      },
    });
    expect(regionOf(middling, "water")).toBeDefined();
    expect(
      middling.findings.find((f) => f.id === "region-placement-clamped"),
    ).toBeDefined();

    // ... and the defaults never trip it.
    const plain = await buildModel({ scene: scene(parts), params: defaultPrintParams() });
    expect(plain.findings.find((f) => f.id === "region-placement-clamped")).toBeUndefined();
    expect(outstandingWasmObjects()).toBe(0);
  }, 180_000);

  it("offers a bigger plate for a thin wall, never a smaller nozzle", () => {
    // MINOR 9. The old patch halved `nozzle_mm`, which changes nothing physical
    // and only relaxes the threshold the check compares against. Asserted on
    // the fix helper itself rather than on a build, because the repair is good
    // enough that manufacturing a thin wall to order is unreliable, and a
    // conditional assertion inside an `if (finding !== undefined)` would pass
    // vacuously the day the finding stopped firing.
    const thin = scene({
      radiusM: 900,
      buildings: [
        building("w1", square(0, 0, 12), 30),
        building("w2", square(200, 0, 12), 30),
        building("w3", square(-200, 120, 12), 30),
      ],
    });
    const small: PrintParams = { ...defaultPrintParams(), nozzle_mm: 1.2, plate_mm: 100 };
    const bigger = biggerPlateMm(thin, small, 900);
    expect(bigger).not.toBeNull();
    expect(bigger!).toBeGreaterThan(small.plate_mm);
    expect(bigger!).toBeLessThanOrEqual(T.PLATE_MAX_MM);
    // At the top of the plate range there is no plate left to offer, so the
    // finding carries prose instead of a button rather than a useless patch.
    expect(
      biggerPlateMm(thin, { ...small, plate_mm: T.PLATE_MAX_MM }, 900),
    ).toBeNull();
    // And a scene with nothing in it still answers, through the fallback step.
    expect(biggerPlateMm(scene({ radiusM: 900 }), small, 900)).toBe(
      small.plate_mm + PLATE_STEP_MM,
    );
  });
});
