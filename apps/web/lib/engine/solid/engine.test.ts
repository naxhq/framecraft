/**
 * The Chicago golden: one real bake, every claim the engine makes about it.
 *
 * The bake is expensive (a few seconds of WASM booleans), so it is run ONCE in
 * a `beforeAll` and every assertion reads the same result. A test that needs a
 * different parameter set says so and pays for its own bake.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams } from "../../contracts";
import { bake } from "../engine";
import type { EngineResult } from "../types";
import {
  PYTHON_REFERENCE_VOLUME_MM3,
  chicagoScene,
  overlapMm3,
  solidFromMesh,
} from "./fixture";
import { loadManifold, outstandingWasmObjects } from "./manifold";
import { degenerateFaces, openEdges } from "./mesh";
import { VERTEX_DECIMALS } from "../export/common";
import * as T from "../../transform";

/** The bake has to finish inside this, in Node, on a developer machine. */
const TIME_BUDGET_MS = 15_000;

/** How far the sum of the region volumes may sit from the Python reference. */
const VOLUME_TOLERANCE = 0.05;

const scene = chicagoScene();

/** A mesh with its coordinates rounded the way `generic3mf` writes them. */
function asWritten(mesh: { positions: Float64Array; indices: Uint32Array }) {
  const positions = new Float64Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i += 1) {
    positions[i] = Number(mesh.positions[i].toFixed(VERTEX_DECIMALS));
  }
  return { positions, indices: mesh.indices };
}

function totalVolume(result: EngineResult): number {
  let total = 0;
  for (const region of result.regions) total += region.volumeMm3;
  return total;
}

describe("chicago bake at the default parameters", () => {
  let result: EngineResult;
  let elapsedMs = 0;
  let leaked = 0;

  beforeAll(async () => {
    const started = Date.now();
    result = await bake({ scene, params: defaultPrintParams(), date: "2026-08-30" });
    elapsedMs = Date.now() - started;
    leaked = outstandingWasmObjects();
  }, 120_000);

  it("emits one solid per non-empty region", () => {
    const names = result.regions.map((region) => region.region);
    expect(names).toContain("base");
    expect(names).toContain("frame");
    expect(names).toContain("buildings");
    expect(names).toContain("roads");
    // The Chicago Loop fixture carries 42 water features and 711 green ones.
    expect(names).toContain("water");
    expect(names).toContain("parks");
    // Nothing in the fixture makes these, so they must not be emitted empty.
    expect(names).not.toContain("hero_building");
    expect(names).not.toContain("lettering");
    expect(new Set(names).size).toBe(names.length);
  });

  it("hands back meshes manifold3d will take back", async () => {
    const wasm = await loadManifold();
    for (const region of result.regions) {
      const solid = solidFromMesh(wasm, region);
      try {
        expect(solid.status(), region.region).toBe("NoError");
        expect(solid.volume()).toBeGreaterThan(0);
        // `RegionMesh.positions` is a Float32Array by contract, so the exported
        // mesh is a float32 rendering of a solid manifold3d built in double:
        // one float32 step at a 90 mm coordinate is 7.6 nm, and over 46 000
        // triangles of base that adds up to a few parts in 100 000 of volume.
        expect(Math.abs(solid.volume() - region.volumeMm3)).toBeLessThan(
          Math.max(1e-3, region.volumeMm3 * 1e-4),
        );
      } finally {
        solid.delete();
      }
    }
  }, 120_000);

  it("keeps every building the repair did not merge or drop", () => {
    const emitted = result.stats.buildings;
    const merged = result.stats.buildingsMerged;
    const input = scene.buildings.length;
    console.info(`[chicago] ${input} footprints -> ${emitted} solids, ${merged} merged`);
    expect(merged).toBeGreaterThan(0);
    expect(emitted).toBeGreaterThan(0);
    expect(emitted).toBeLessThan(input);
    // `emitted` counts SOLIDS and `merged` counts footprints swallowed by a
    // neighbour, so the two together are the input give or take two small
    // corrections: 04 stage 1 step 5 preserves a tower over 1.5x its block
    // height as an EXTRA solid standing on that block (up), and Stage 1 drops
    // what is under the minimum printable size (down). Both are small.
    const accounted = emitted + merged;
    expect(accounted).toBeGreaterThan(input * 0.95);
    expect(accounted).toBeLessThan(input * 1.05);
    expect(result.stats.buildingsDilated).toBeGreaterThan(0);
    expect(result.stats.heightFallbacks).toBeGreaterThan(0);
  });

  it("comes within 5 per cent of the reference bake's volume", () => {
    // The WELDED solid, not the sum of the regions. The regions are separate
    // bodies that interpenetrate at their seams by `PART_OVERLAP_MM`, so their
    // volumes double-count that overlap by construction; `merged` is the
    // object the printer makes and is what a total or an estimate must come
    // from (DECISIONS `[V3-P2-E2]`).
    const measured = result.merged.volumeMm3;
    const difference = (measured - PYTHON_REFERENCE_VOLUME_MM3) / PYTHON_REFERENCE_VOLUME_MM3;
    console.info(
      `[chicago] welded ${measured.toFixed(2)} mm3 vs reference ` +
        `${PYTHON_REFERENCE_VOLUME_MM3.toFixed(2)} mm3 (${(difference * 100).toFixed(2)} %)`,
    );
    const sum = totalVolume(result);
    console.info(
      `[chicago] regions as built ${sum.toFixed(2)} mm3 ` +
        `(+${(((sum - measured) / measured) * 100).toFixed(2)} % of seam overlap)`,
    );
    for (const region of result.regions) {
      console.info(
        `[chicago]   ${region.region}: ${region.volumeMm3.toFixed(2)} mm3, ` +
          `${region.bodies} bodies, ${region.indices.length / 3} triangles, ` +
          `slot ${region.slot} ${region.colorHex}`,
      );
    }
    expect(Math.abs(difference)).toBeLessThan(VOLUME_TOLERANCE);
  });

  it("measures a minimum wall the nozzle can print", () => {
    const required = T.min_wall_mm(result.params);
    console.info(
      `[chicago] min wall ${String(result.stats.measuredMinWallMm)} mm against ${required} mm`,
    );
    for (const item of result.findings) {
      console.info(`[chicago] finding ${item.id} (${item.severity}): ${item.detail}`);
    }
    expect(result.stats.measuredMinWallMm).not.toBeNull();
    expect(result.stats.measuredMinWallMm as number).toBeGreaterThanOrEqual(required);
    expect(result.stats.minWallMm).toBe(required);
  });

  it("fits the plate and sits on the bed", () => {
    expect(result.stats.widthMm).toBeLessThanOrEqual(result.params.plate_mm + 0.01);
    expect(result.stats.depthMm).toBeLessThanOrEqual(result.params.plate_mm + 0.01);
    expect(result.stats.heightMm).toBeLessThan(T.MAX_HEIGHT_MM);
    for (const region of result.regions) {
      expect(region.bbox.min[2]).toBeGreaterThanOrEqual(-0.001);
    }
    const base = result.regions.find((region) => region.region === "base");
    expect(base?.bbox.min[2]).toBeCloseTo(0, 6);
    expect(base?.bodies).toBe(1);
  });

  it("interpenetrates at every seam and unions back to the welded solid", async () => {
    // The regions are separate watertight BODIES that overlap where they meet,
    // not a flush partition: a surface region reaches `PART_OVERLAP_MM` into
    // the base below and around it, the lip reaches that far down into the
    // plate, and a building reaches the skirt down through the base top. That
    // is the reference implementation's own arrangement (`extrude
    // .PART_OVERLAP_MM`) and the reason its colour parts survive being unioned:
    // coincident faces are what a boolean and a slicer both mishandle.
    //
    // The invariant that replaces "no two regions overlap" is stronger and is
    // what the parts export actually needs: the UNION of the regions is
    // exactly the welded solid.
    const wasm = await loadManifold();
    let unionVolume = 0;
    let unionBodies = 0;
    const overlaps: Array<[string, number]> = [];
    await bake(
      { scene, params: defaultPrintParams(), date: "2026-08-30" },
      {
        onSolids: (regions) => {
          for (let i = 0; i < regions.length; i += 1) {
            for (let j = i + 1; j < regions.length; j += 1) {
              overlaps.push([
                `${regions[i].mesh.region} vs ${regions[j].mesh.region}`,
                overlapMm3(wasm, regions[i].solid, regions[j].solid),
              ]);
            }
          }
          const welded = wasm.Manifold.union(regions.map((r) => r.solid));
          unionVolume = welded.volume();
          const bodies = welded.decompose();
          unionBodies = bodies.length;
          for (const body of bodies) body.delete();
          welded.delete();
        },
      },
    );
    console.info(
      `[chicago] union of regions ${unionVolume.toFixed(2)} mm3 in ${unionBodies} body(ies)`,
    );
    expect(unionBodies).toBe(1);
    expect(Math.abs(unionVolume - result.merged.volumeMm3) / result.merged.volumeMm3).toBeLessThan(
      1e-3,
    );

    // Every seam that exists is an overlap, and every overlap is one seam's
    // worth: nothing shares a volume that 0.2 mm at a shared boundary cannot
    // account for. The frame is the one that can be checked in closed form -
    // it is a plain ring lowered into a flat plate.
    const frame = overlaps.find(([pair]) => pair === "base vs frame");
    const ring = result.params.plate_mm ** 2 - (result.params.plate_mm - 2 * 6) ** 2;
    expect(frame?.[1] ?? 0).toBeCloseTo(ring * 0.2, 0);
    for (const [pair, shared] of overlaps) {
      if (shared > 1e-6) console.info(`[chicago] ${pair}: ${shared.toFixed(2)} mm3`);
    }
  }, 120_000);

  it("exports meshes with no degenerate face and no open edge", () => {
    // The reference validator's own last two rows, reproduced on the arrays the
    // exporters write: zero triangles under 1e-9 mm2 (04 stage 4), and every
    // directed edge with exactly one twin (closed AND consistently wound).
    // The repair that gets us here works to 1e-7 mm2, two decades of margin,
    // because writing a vertex as a decimal string moves it and moving a
    // vertex moves the area of the faces that use it (`solid/mesh.ts`).
    for (const region of [...result.regions, result.merged]) {
      expect(degenerateFaces(region), `${region.region} degenerate`).toBe(0);
      expect(openEdges(region), `${region.region} open edges`).toBe(0);
      expect(region.positions).toBeInstanceOf(Float64Array);
      // And still none once the coordinates are written the way the 3MF
      // writes them. That is the property that matters: rounding a vertex onto
      // a decimal grid moves it, and moving a vertex moves the area of every
      // face that uses it, which is how a mesh that was clean in memory grows
      // a degenerate face on the way into a file.
      expect(degenerateFaces(asWritten(region)), `${region.region} written`).toBe(0);
    }
  });

  it("welds the regions into one solid for the single-object formats", () => {
    const merged = result.merged;
    expect(merged.bodies).toBe(1);
    expect(merged.volumeMm3).toBeGreaterThan(0);
    // Lighter than the partition it came from: the interior walls between the
    // regions are not in it.
    expect(merged.indices.length).toBeLessThan(
      result.regions.reduce((n, r) => n + r.indices.length, 0),
    );
    // And smaller, by exactly the seam overlap the regions carry twice.
    const sum = totalVolume(result);
    expect(sum).toBeGreaterThan(merged.volumeMm3);
    expect((sum - merged.volumeMm3) / merged.volumeMm3).toBeLessThan(0.08);
  });

  it("reports no printability findings for the default plate", () => {
    const errors = result.findings.filter((finding) => finding.severity === "error");
    expect(errors.map((finding) => `${finding.id}: ${finding.detail}`)).toEqual([]);
  });

  it("stays under the triangle budget", () => {
    expect(result.stats.triangles).toBeGreaterThan(0);
    expect(result.stats.triangles).toBeLessThan(2_000_000);
  });

  it("gives every region a filament slot and a colour", () => {
    for (const region of result.regions) {
      expect(region.slot).toBeGreaterThanOrEqual(1);
      expect(region.slot).toBeLessThanOrEqual(16);
      expect(region.colorHex).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
    const base = result.regions.find((region) => region.region === "base");
    const roads = result.regions.find((region) => region.region === "roads");
    expect(base?.colorHex).toBe("#D8D3C6");
    expect(roads?.slot).toBe(4);
  });

  it("leaks no WASM handles", () => {
    expect(leaked).toBe(0);
    expect(outstandingWasmObjects()).toBe(0);
  });

  it("finishes inside the time budget", () => {
    console.info(`[chicago] bake ${elapsedMs} ms (engine ${result.stats.elapsedMs.toFixed(0)} ms)`);
    expect(elapsedMs).toBeLessThan(TIME_BUDGET_MS);
  });
});

describe("chicago with a hero building", () => {
  it("splits the picked building into its own region", async () => {
    const params: PrintParams = {
      ...defaultPrintParams(),
      // w64388609 is the Willis Tower footprint, the tallest in the fixture.
      hero_building_ids: ["w64388609"],
      hero_mode: "both",
    };
    const result = await bake({ scene, params, date: "2026-08-30" });
    const hero = result.regions.find((region) => region.region === "hero_building");
    expect(hero).toBeDefined();
    expect(hero?.volumeMm3).toBeGreaterThan(0);
    expect(hero?.colorHex).toBe("#E3A72F");
    const buildings = result.regions.find((region) => region.region === "buildings");
    expect(buildings).toBeDefined();
    // The hero reaches higher than anything left in the buildings region.
    expect(hero?.bbox.max[2]).toBeGreaterThan(buildings?.bbox.max[2] ?? Infinity);
    expect(outstandingWasmObjects()).toBe(0);
  }, 120_000);

  it("prints a hero in the buildings filament unless the mode grants it one", async () => {
    const params: PrintParams = {
      ...defaultPrintParams(),
      hero_building_ids: ["w64388609"],
      hero_mode: "true_height",
    };
    const result = await bake({ scene, params, date: "2026-08-30" });
    const hero = result.regions.find((region) => region.region === "hero_building");
    const buildings = result.regions.find((region) => region.region === "buildings");
    expect(hero).toBeDefined();
    expect(hero?.slot).toBe(buildings?.slot);
    expect(hero?.colorHex).toBe(buildings?.colorHex);
  }, 120_000);
});

describe("chicago with lettering", () => {
  it("cuts a line on the top edge and says why it skipped another", async () => {
    const params: PrintParams = {
      ...defaultPrintParams(),
      engravings: [
        { edge: "top", text: "Chicago", mode: "engrave", size_mm: 5, font: "sans" },
        // Nothing in this string is in the shared metrics table, so every
        // character is dropped and the line resolves empty.
        { edge: "bottom", text: "日本語", mode: "engrave", size_mm: 5 },
      ],
    };
    const plain = await bake({ scene, params: defaultPrintParams(), date: "2026-08-30" });
    const lettered = await bake({ scene, params, date: "2026-08-30" });

    const cut = lettered.resolvedText.find((line) => line.id === "engraving-0");
    expect(cut?.status).toBe("cuts");
    expect(cut?.text).toBe("Chicago");
    expect(cut?.surface).toBe("Frame, top edge");
    expect(cut?.sizeMm).toBeGreaterThan(0);

    const skipped = lettered.resolvedText.find((line) => line.id === "engraving-1");
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.reason).toBeTruthy();
    expect(lettered.findings.some((finding) => finding.id === "text-too-small")).toBe(true);

    // The strokes are real geometry: the frame lost volume and gained triangles.
    const before = plain.regions.find((region) => region.region === "frame");
    const after = lettered.regions.find((region) => region.region === "frame");
    expect(after).toBeDefined();
    expect(after!.volumeMm3).toBeLessThan(before!.volumeMm3);
    expect(after!.indices.length).toBeGreaterThan(before!.indices.length);
    expect(outstandingWasmObjects()).toBe(0);
  }, 180_000);
});
