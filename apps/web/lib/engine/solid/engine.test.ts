/**
 * The Chicago golden: one real build, every claim the engine makes about it.
 *
 * The build is expensive (a few seconds of WASM booleans), so it is run ONCE in
 * a `beforeAll` and every assertion reads the same result. A test that needs a
 * different parameter set says so and pays for its own build.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams } from "../../contracts";
import { buildModel } from "../engine";
import { sceneFromOverpass } from "../osm/scene";
import type { EngineResult } from "../types";
import {
  PYTHON_REFERENCE_VOLUME_MM3,
  chicagoScene,
  overlapMm3,
  rampGrid,
  solidFromMesh,
} from "./fixture";
import { loadManifold, outstandingWasmObjects } from "./manifold";
import { degenerateFaces, openEdges } from "./mesh";
import { VERTEX_DECIMALS } from "../export/common";
import * as T from "../../transform";

/** The build has to finish inside this, in Node, on a developer machine. */
// The 13.7 to 13.9 s that briefly justified doubling this was not host noise:
// it was `measure.measureMinWall` paying the persistence intersect for every
// region of every slice, and raising the budget hid the defect that the e2e
// preview then stalled on. Fixed at source (`[V3-P7-fix2-1]`), the same build is
// back under 7 s, so the committed 15 s stands as written.
const TIME_BUDGET_MS = 15_000;

/**
 * The same budget for a DRAPED build, in Node, on a developer machine.
 *
 * Draping refines the plate, the four surface layers and their grooves to
 * `TERRAIN_CELL_MM` before warping them, which is real work on top of the flat
 * build rather than instead of it. Phase 3's own target is 6 s for the flat
 * Chicago default; this is the hilly one and it gets the flat budget.
 */
const TERRAIN_TIME_BUDGET_MS = 15_000;

/** How far the sum of the region volumes may sit from the Python reference. */
const VOLUME_TOLERANCE = 0.05;

const here = dirname(fileURLToPath(import.meta.url));
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

describe("chicago build at the default parameters", () => {
  let result: EngineResult;
  let elapsedMs = 0;
  let leaked = 0;

  beforeAll(async () => {
    const started = Date.now();
    result = await buildModel({ scene, params: defaultPrintParams(), date: "2026-08-30" });
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

  it("comes within 5 per cent of the reference build's volume", () => {
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
    await buildModel(
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
    console.info(`[chicago] build ${elapsedMs} ms (engine ${result.stats.elapsedMs.toFixed(0)} ms)`);
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
    const result = await buildModel({ scene, params, date: "2026-08-30" });
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
    const result = await buildModel({ scene, params, date: "2026-08-30" });
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
    const plain = await buildModel({ scene, params: defaultPrintParams(), date: "2026-08-30" });
    const lettered = await buildModel({ scene, params, date: "2026-08-30" });

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

describe("chicago trees", () => {
  it("drops all 5762 at plate 180 and prints them at plate 256", async () => {
    // The Chicago Loop fixture carries 5 762 tree sites, every one of them
    // 4.0 m across. At plate 180 the scale is 0.0933 mm/m, so a site prints at
    // 0.373 mm against 04's 0.5 mm floor and none survive; at plate 256 it is
    // 0.1356 mm/m and every one clears the floor, so `TREE_CAP` binds instead.
    const small = await buildModel({ scene, params: defaultPrintParams(), date: "2026-08-30" });
    expect(scene.trees).toHaveLength(5762);
    expect(small.stats.trees ?? 0).toBe(0);
    expect(small.stats.treesDropped).toBe(5762);
    const dropped = small.findings.find((f) => f.id === "trees-too-small");
    expect(dropped?.severity).toBe("info");
    expect(dropped?.title).toContain("5762 of 5762");
    // No trees means the parks region is exactly what it was without them.
    expect(small.regions.find((r) => r.region === "parks")).toBeDefined();

    const params: PrintParams = { ...defaultPrintParams(), plate_mm: 256 };
    const big = await buildModel({ scene, params, date: "2026-08-30" });
    expect(big.stats.trees ?? 0).toBeGreaterThan(0);
    // The cap keeps the largest `TREE_CAP` of them; the rest of the 5 762 are
    // reported as dropped, and some of the survivors then fall inside a
    // building, road or water footprint and are reported as blocked.
    expect(big.stats.trees!).toBeLessThanOrEqual(T.TREE_CAP);
    expect(big.stats.trees! + big.stats.treesDropped!).toBe(5762);
    const parks = big.regions.find((r) => r.region === "parks");
    expect(parks).toBeDefined();
    // Every marker is a separate body until the union with the base welds it.
    expect(parks!.bodies).toBeGreaterThan(100);
    expect(big.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(big.merged.bodies).toBe(1);

    console.info(
      `[trees] plate 180: kept ${small.stats.trees ?? 0}, dropped ${small.stats.treesDropped}; ` +
        `plate 256: kept ${big.stats.trees}, dropped ${big.stats.treesDropped}, ` +
        `${big.stats.elapsedMs.toFixed(0)} ms`,
    );
    expect(outstandingWasmObjects()).toBe(0);
  }, 300_000);
});

describe("chicago on a hillside", () => {
  it("drapes every layer, stays printable and stays inside the time budget", async () => {
    // 60 m of relief over the 1.8 km crop: the real range across the Loop is
    // about 12 m, so this is five times the worst case the preset can produce.
    const radiusM = T.radius_m_from_bounds(scene.bounds);
    const grid = rampGrid(radiusM, 60, 30);
    const started = Date.now();
    const hilly = await buildModel({
      scene,
      params: defaultPrintParams(),
      terrain: grid,
      date: "2026-08-30",
    });
    const elapsed = Date.now() - started;

    const flat = await buildModel({ scene, params: defaultPrintParams(), date: "2026-08-30" });
    // The drape is a vertical shear, so it adds material and nothing else: the
    // plate is exactly as wide and exactly as flat underneath as it was.
    expect(hilly.merged.bbox.max[0]).toBeCloseTo(flat.merged.bbox.max[0], 6);
    expect(hilly.merged.bbox.max[1]).toBeCloseTo(flat.merged.bbox.max[1], 6);
    expect(hilly.merged.bbox.min[2]).toBeCloseTo(0, 6);
    expect(hilly.merged.bbox.max[2]).toBeGreaterThan(flat.merged.bbox.max[2]);
    expect(hilly.merged.volumeMm3).toBeGreaterThan(flat.merged.volumeMm3);
    // Still one connected object with every region a valid solid.
    expect(hilly.merged.bodies).toBe(1);

    // ... and the engine is HONEST about what 60 m of relief costs. A level
    // slice through a hillside cuts every groove and ridge at an angle, so some
    // read narrower in plan than they are built, and the reference validator
    // fails the file on it. The engine used to miss that entirely (it reported
    // 0.8 mm, saturated) and now reports it with a count and a remedy that
    // actually applies (`[V3-P3-G16]`). The finding is the REQUIRED behaviour
    // here, not an accepted failure: a draped build that reported nothing would
    // be the bug.
    const thin = hilly.findings.find((f) => f.id === "wall-too-thin");
    expect(thin).toBeDefined();
    expect(thin!.detail).toContain("Terrain is on");
    expect(thin!.detail).toContain("places are under it");
    expect(thin!.fix?.safe).toBe(true);
    expect((thin!.fix?.patch as { terrain_exaggeration?: number }).terrain_exaggeration)
      .toBeLessThan(hilly.params.terrain_exaggeration);
    // Nothing else is wrong with it.
    expect(hilly.findings.filter((f) => f.severity === "error").map((f) => f.id)).toEqual([
      "wall-too-thin",
    ]);
    // The FLAT build of the same scene reports none of it, which is what makes
    // the sweep terrain-only.
    expect(flat.findings.find((f) => f.id === "wall-too-thin")).toBeUndefined();
    // Every draped region is still a solid manifold3d will take back, with no
    // degenerate face and no open edge: the same three checks the reference
    // validator runs on the written file, applied to the mesh that would be
    // written. A warp that had folded a triangle would fail all three.
    const wasm = await loadManifold();
    for (const region of hilly.regions) {
      expect(region.volumeMm3, region.region).toBeGreaterThan(0);
      const solid = solidFromMesh(wasm, region);
      try {
        expect(solid.status(), region.region).toBe("NoError");
        expect(degenerateFaces(region), region.region).toBe(0);
        expect(openEdges(region), region.region).toBe(0);
      } finally {
        solid.delete();
      }
    }
    expect(hilly.stats.terrainReliefMm).toBeCloseTo(
      T.terrain_z_mm(grid.rangeM, hilly.params, T.scale_mm_per_m(hilly.params, radiusM)),
      6,
    );
    expect(hilly.stats.triangles).toBeLessThan(2_000_000);
    expect(outstandingWasmObjects()).toBe(0);

    console.info(
      `[terrain] chicago draped in ${elapsed} ms, ${hilly.stats.triangles} triangles ` +
        `(flat ${flat.stats.triangles}), relief ${hilly.stats.terrainReliefMm?.toFixed(2)} mm, ` +
        `height ${hilly.stats.heightMm.toFixed(2)} mm`,
    );
    expect(elapsed).toBeLessThan(TERRAIN_TIME_BUDGET_MS);
  }, 600_000);
});

describe("chicago as the app ingests it", () => {
  it("builds the elevated network into one clean, connected model", async () => {
    // The committed `fixtures/chicago-scene.json` comes from the Python
    // service, which carries no `bridge`/`layer` tags and no rail layer, so it
    // exercises none of phase 3's elevated geometry. The app builds the scene
    // its OWN ingest builds, and that one has 780 elevated ways in the Loop:
    // every bridge defect this phase fixed was invisible on the committed
    // fixture and obvious on this one (`[V3-P3-G13]`).
    const raw = JSON.parse(
      readFileSync(resolve(here, "../../../../../tests/fixtures/overpass-chicago-loop.json"), "utf8"),
    ) as Parameters<typeof sceneFromOverpass>[0];
    const params = defaultPrintParams();
    const ingested = sceneFromOverpass(
      raw,
      { lat: 41.8827, lon: -87.6233, radius_m: 900, rotation_deg: 0 },
      params,
    );
    const result = await buildModel({ scene: ingested, params, date: "2026-08-30" });

    expect(result.stats.bridges ?? 0).toBeGreaterThan(500);
    // One connected object, and every region a solid with no degenerate face
    // and no open edge: the three checks the reference validator failed on
    // before the deck was held clear of the buildings, the footing was turned
    // 45 degrees off the street grid and its foot was moved off the grade
    // roads' own underside.
    expect(result.merged.bodies).toBe(1);
    expect(degenerateFaces(result.merged)).toBe(0);
    expect(openEdges(result.merged)).toBe(0);
    for (const region of result.regions) {
      expect(degenerateFaces(region), region.region).toBe(0);
      expect(openEdges(region), region.region).toBe(0);
      expect(region.volumeMm3, region.region).toBeGreaterThan(0);
    }
    // A deck that could not be grounded is DROPPED and counted, never shipped
    // floating: at most a handful of the 780, and reported when there are any.
    const loose = result.findings.find((f) => f.id === "bridge-unsupported");
    if (loose !== undefined) {
      expect(loose.severity).toBe("warning");
      expect(loose.detail).toContain("left out");
    }
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(outstandingWasmObjects()).toBe(0);
    console.info(
      `[ingest] ${result.stats.bridges} elevated ways, ${result.stats.triangles} triangles, ` +
        `${result.merged.bodies} body, ${loose === undefined ? 0 : 1} unsupported finding`,
    );
  }, 300_000);
});
