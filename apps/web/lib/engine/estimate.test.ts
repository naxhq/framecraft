/**
 * Filament and time estimates.
 *
 * The arithmetic is checked against numbers worked out by hand; the Chicago
 * default is checked against the window the phase brief asks for, and that
 * assertion is the calibration: if a constant in `estimate.ts` moves far enough
 * to take a real bake out of a plausible print time, this fails.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams } from "../contracts";
import { bake } from "./engine";
import { chicagoScene } from "./solid/fixture";
import {
  ESTIMATE_CAVEAT,
  FILAMENT_DIAMETER_MM,
  LAYER_HEIGHT_MM,
  MATERIAL_FRACTION,
  PLA_DENSITY_G_CM3,
  estimate,
  filamentAreaMm2,
  formatDuration,
  gramsFor,
  metresFor,
} from "./estimate";
import type { EngineResult, RegionMesh } from "./types";

function mesh(overrides: Partial<RegionMesh> = {}): RegionMesh {
  return {
    region: "base",
    positions: new Float64Array(0),
    indices: new Uint32Array(0),
    volumeMm3: 1000,
    bbox: { min: [0, 0, 0], max: [100, 100, 10] },
    bodies: 1,
    slot: 1,
    colorHex: "#D8D3C6",
    ...overrides,
  };
}

function result(regions: RegionMesh[], merged: RegionMesh): Pick<EngineResult, "regions" | "merged" | "stats"> {
  return {
    regions,
    merged,
    stats: {
      scaleDenominator: 10000,
      minWallMm: 0.8,
      measuredMinWallMm: 0.9,
      buildings: 10,
      buildingsMerged: 0,
      buildingsDilated: 0,
      heightFallbacks: 0,
      triangles: 100,
      widthMm: 100,
      depthMm: 100,
      heightMm: 10,
      elapsedMs: 1,
    },
  };
}

describe("the arithmetic", () => {
  it("converts volume to grams and metres", () => {
    // A cubic centimetre of PLA is 1.24 g.
    expect(gramsFor(1000)).toBeCloseTo(PLA_DENSITY_G_CM3, 9);
    // 1.75 mm filament is 2.405 mm2 in section, so a metre of it is 2405 mm3.
    expect(filamentAreaMm2()).toBeCloseTo(Math.PI * (FILAMENT_DIAMETER_MM / 2) ** 2, 9);
    expect(metresFor(filamentAreaMm2() * 1000)).toBeCloseTo(1, 9);
  });

  it("writes a duration a person would say out loud", () => {
    expect(formatDuration(0)).toBe("under a minute");
    expect(formatDuration(20)).toBe("under a minute");
    expect(formatDuration(48 * 60)).toBe("48 min");
    expect(formatDuration(2 * 3600)).toBe("2 h");
    expect(formatDuration(5 * 3600 + 12 * 60)).toBe("5 h 12 min");
  });
});

describe("estimating a model", () => {
  it("takes the total volume from the welded solid, never the sum of the regions", () => {
    // Regions overlap at their seams, so they sum to more than the model has.
    const regions = [mesh({ volumeMm3: 700 }), mesh({ region: "roads", slot: 4, volumeMm3: 400 })];
    const merged = mesh({ volumeMm3: 1000 });
    const out = estimate(result(regions, merged), defaultPrintParams());
    expect(out.volumeMm3).toBe(1000);
    // And the per-slot figures are scaled to add up to it, not to 1100.
    const perSlot = out.slots.reduce((sum, slot) => sum + slot.volumeMm3, 0);
    expect(perSlot).toBeCloseTo(1000, 6);
    expect(out.slots.map((slot) => slot.slot)).toEqual([1, 4]);
    expect(out.slots[0].volumeMm3 / out.slots[1].volumeMm3).toBeCloseTo(700 / 400, 6);
  });

  it("groups regions by slot and keeps them in region order", () => {
    const regions = [
      mesh({ region: "roads", slot: 4, volumeMm3: 100 }),
      mesh({ region: "buildings", slot: 2, volumeMm3: 200 }),
      mesh({ region: "parks", slot: 4, volumeMm3: 50 }),
    ];
    const out = estimate(result(regions, mesh({ volumeMm3: 350 })), defaultPrintParams());
    const slot4 = out.slots.find((slot) => slot.slot === 4);
    // REGION_NAMES order, not the order the regions arrived in.
    expect(slot4?.regions).toEqual(["roads", "parks"]);
    expect(out.slots.map((slot) => slot.slot)).toEqual([2, 4]);
  });

  it("labels itself an estimate and carries the constants it used", () => {
    const out = estimate(result([mesh()], mesh()), defaultPrintParams());
    expect(out.isEstimate).toBe(true);
    expect(out.caveat).toBe(ESTIMATE_CAVEAT);
    expect(out.assumptions.densityGCm3).toBe(PLA_DENSITY_G_CM3);
    expect(out.assumptions.layerHeightMm).toBe(LAYER_HEIGHT_MM);
    expect(out.assumptions.materialFraction).toBe(MATERIAL_FRACTION);
  });

  it("counts layers from the model's own height", () => {
    const merged = mesh({ volumeMm3: 1000, bbox: { min: [0, 0, 0], max: [100, 100, 10] } });
    const out = estimate(result([mesh()], merged), defaultPrintParams());
    expect(out.layers).toBe(50);
    expect(out.seconds).toBeGreaterThan(0);
  });

  it("hands back zeroes for a model with nothing in it", () => {
    const empty = mesh({ volumeMm3: 0, bbox: { min: [0, 0, 0], max: [0, 0, 0] } });
    const out = estimate(result([], empty), defaultPrintParams());
    expect(out.volumeMm3).toBe(0);
    expect(out.grams).toBe(0);
    expect(out.layers).toBe(0);
    expect(out.seconds).toBe(0);
    expect(out.duration).toBe("under a minute");
    expect(out.slots).toEqual([]);
  });

  it("scales with the settings a caller overrides", () => {
    const out = estimate(result([mesh()], mesh()), defaultPrintParams(), {
      materialFraction: 1,
      flowMm3PerS: 1,
      overheadSPerLayer: 0,
      travelAreaRateMm2PerS: 1e12,
    });
    expect(out.filamentVolumeMm3).toBe(1000);
    expect(out.seconds).toBeCloseTo(1000, 3);
  });
});

describe("the default Chicago plate", () => {
  let out: ReturnType<typeof estimate>;

  beforeAll(async () => {
    const params: PrintParams = defaultPrintParams();
    const baked = await bake({ scene: chicagoScene(), params, date: "2026-09-01" });
    out = estimate(baked, params);
    console.info(
      `[chicago estimate] ${out.volumeMm3.toFixed(0)} mm3, ${out.grams.toFixed(1)} g, ` +
        `${out.metres.toFixed(1)} m, ${out.layers} layers, ${out.duration}`,
    );
    for (const slot of out.slots) {
      console.info(`[chicago estimate]   slot ${slot.slot}: ${slot.grams.toFixed(1)} g (${slot.regions.join(", ")})`);
    }
  }, 120_000);

  it("lands in a plausible print time", () => {
    expect(out.seconds / 3600).toBeGreaterThan(3);
    expect(out.seconds / 3600).toBeLessThan(6);
  });

  it("puts a sane amount of filament on a spool", () => {
    // A kilogram spool holds about 330 m of 1.75 mm PLA.
    expect(out.grams).toBeGreaterThan(50);
    expect(out.grams).toBeLessThan(400);
    expect(out.metres).toBeGreaterThan(15);
    expect(out.metres).toBeLessThan(140);
  });

  it("splits the filament across the slots the colours ask for", () => {
    expect(out.slots.length).toBeGreaterThan(1);
    const total = out.slots.reduce((sum, slot) => sum + slot.grams, 0);
    expect(total).toBeCloseTo(out.grams, 3);
    // The base and the buildings are the bulk of it.
    const biggest = [...out.slots].sort((a, b) => b.grams - a.grams)[0];
    expect(biggest.grams / out.grams).toBeGreaterThan(0.3);
  });
});
