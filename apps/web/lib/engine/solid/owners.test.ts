/**
 * Per-triangle building identity (`solid/owners.ts`): every triangle of a
 * buildings, band or hero region names the building it came from, the union
 * loses no id, and the attribution is a pure function of the shipped mesh.
 */
import { describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams, type SceneGraph } from "../../contracts";
import { BUDGET_FACTOR } from "../../testBudget";
import { StageCache, runPipeline, type PipelineJob } from "../pipeline/index";
import type { FinishOut } from "../pipeline/stage";
import { NO_OWNER, type RegionMesh } from "../types";
import type { BuiltBuildings } from "./buildings";
import { chicagoScene } from "./fixture";
import { Arena, batchedUnion, extrudeSection, loadManifold, rectContour, toRegionMesh } from "./manifold";
import { attributeTriangleOwners } from "./owners";

/**
 * A second `attributeTriangleOwners` pass over the shipped Chicago buildings
 * mesh has to cost this, LOCAL, at `VITEST_BUDGET_FACTOR=1`: it is an O(n)
 * walk of 19 378 triangles and the bound exists so it cannot quietly become a
 * search. Scaled with the rest of the suite's wall-clock rows for consistency,
 * not because it was failing -- it reads 10.7 to 10.8 ms here and 26.5 to
 * 35.1 ms on a runner, comfortably inside 100 either way. It is worth knowing
 * that this is the one row whose runner ratio (2.5x to 3.3x) sits ABOVE the
 * declared factor, and that this says nothing about the hardware: at a 10 ms
 * magnitude the reading is timer granularity and JIT warmup, which is also why
 * two runner samples of the same work differ by 32 %. A budget this far from
 * its readings is the right shape for a measurement that noisy.
 */
const OWNERS_BUDGET_MS = 100 * BUDGET_FACTOR;

function job(scene: SceneGraph, params: PrintParams, key: string): PipelineJob {
  return {
    source: { kind: "scene", scene, key },
    params,
    terrain: null,
    heroIds: null,
    date: "2026-09-02",
    rotationDeg: 0,
    mode: "full",
    exportRequest: null,
    known: {},
    knownSceneHash: null,
  };
}

/** Owner coverage of one mesh: every triangle owned, every owner used, indices in range. */
function coverage(mesh: RegionMesh): { owned: number; used: Set<number> } {
  const owners = mesh.owners ?? [];
  const triangleOwner = mesh.triangleOwner ?? new Uint32Array(0);
  expect(triangleOwner.length, `${mesh.region}: one owner per triangle`).toBe(mesh.indices.length / 3);
  const used = new Set<number>();
  let owned = 0;
  for (const owner of triangleOwner) {
    if (owner === NO_OWNER) continue;
    expect(owner).toBeLessThan(owners.length);
    used.add(owner);
    owned += 1;
  }
  expect([...owners].sort(), `${mesh.region}: owners sorted`).toEqual(owners);
  expect(new Set(owners).size, `${mesh.region}: owners unique`).toBe(owners.length);
  return { owned, used };
}

function tallestId(scene: SceneGraph): string {
  let best = scene.buildings[0];
  for (const building of scene.buildings) if (building.height_m > best.height_m) best = building;
  return best.id;
}

describe("per-triangle building identity", () => {
  it("Chicago at the defaults: every triangle of the buildings region maps to exactly one building, and the union kept every id", async () => {
    const cache = new StageCache();
    try {
      const outcome = await runPipeline(job(chicagoScene(), defaultPrintParams(), "chicago"), cache, () => undefined);
      expect(outcome.status).toBe("done");
      const region = outcome.result?.regions.find((mesh) => mesh.region === "buildings");
      expect(region).toBeDefined();
      if (region === undefined) return;
      const { owned, used } = coverage(region);
      const triangles = region.indices.length / 3;
      expect(triangles).toBeGreaterThan(1000);
      expect(owned, "100 % coverage").toBe(triangles);
      // The owners are exactly the buildings the stage built (no hero at the
      // defaults), and every one of them is on the mesh: the union lost none.
      const built = cache.get<BuiltBuildings>("buildings")?.output;
      const expected = [...new Set(Object.values(built?.ownerIds ?? {}))].sort();
      expect(region.owners).toEqual(expected);
      expect(used.size).toBe(expected.length);
      expect(expected.length).toBe(built?.count);
      // A region that carries no buildings carries no identity.
      const base = outcome.result?.regions.find((mesh) => mesh.region === "base");
      expect(base?.triangleOwner).toBeUndefined();
      expect(base?.owners).toBeUndefined();

      // The attribution is a pure function of the solid and the shipped mesh:
      // a second pass is identical, and it stays inside the finish budget.
      const finish = cache.get<FinishOut>("finish-buildings")?.output;
      expect(finish).toBeDefined();
      if (finish === undefined || finish === null || built === undefined) return;
      const startedMs = performance.now();
      const again = attributeTriangleOwners(finish.solid, finish.mesh, built.ownerIds);
      const elapsedMs = performance.now() - startedMs;
      console.info(
        `[owners] chicago buildings: ${triangles} triangles, ${expected.length} buildings, ` +
          `${elapsedMs.toFixed(1)} ms (budget ${OWNERS_BUDGET_MS} ms at factor ${BUDGET_FACTOR})`,
      );
      expect(again.unmatched).toBe(0);
      expect(again.owners).toEqual(region.owners);
      expect(again.triangleOwner).toEqual(region.triangleOwner);
      expect(elapsedMs).toBeLessThan(OWNERS_BUDGET_MS);
    } finally {
      cache.dispose();
    }
  }, 120_000);

  it("a hero owns every triangle of hero_building and none of buildings; a gradient partitions the owners across the bands", async () => {
    const cache = new StageCache();
    try {
      const scene = chicagoScene();
      const hero = tallestId(scene);
      const params: PrintParams = {
        ...defaultPrintParams(),
        hero_building_ids: [hero],
        colour: { ...defaultPrintParams().colour, gradient: { enabled: true, slots: [2, 3, 4] } },
      };
      const outcome = await runPipeline(job(scene, params, "chicago"), cache, () => undefined);
      expect(outcome.status).toBe("done");
      const regions = outcome.result?.regions ?? [];
      const heroMesh = regions.find((mesh) => mesh.region === "hero_building");
      expect(heroMesh).toBeDefined();
      if (heroMesh === undefined) return;
      expect(heroMesh.owners).toEqual([hero]);
      expect(coverage(heroMesh).owned).toBe(heroMesh.indices.length / 3);
      expect(heroMesh.triangleOwner?.every((owner) => owner === 0)).toBe(true);

      const bands = regions.filter((mesh) => mesh.region === "buildings" || mesh.region.startsWith("buildings_band_"));
      expect(bands.map((mesh) => mesh.region)).toEqual(["buildings", "buildings_band_2", "buildings_band_3"]);
      const all = new Set<string>();
      for (const band of bands) {
        const { owned, used } = coverage(band);
        expect(owned, band.region).toBe(band.indices.length / 3);
        expect(used.size, `${band.region}: every owner is on its band`).toBe(band.owners?.length ?? 0);
        for (const id of band.owners ?? []) {
          expect(all.has(id), `${id} is on one band only`).toBe(false);
          all.add(id);
        }
      }
      expect(all.has(hero)).toBe(false);
      const built = cache.get<BuiltBuildings>("buildings")?.output;
      const everyone = new Set(Object.values(built?.ownerIds ?? {}));
      everyone.delete(hero);
      expect([...all].sort()).toEqual([...everyone].sort());
    } finally {
      cache.dispose();
    }
  }, 120_000);

  it("attributes by geometry: two extrusions unioned into one region, each triangle to the block it is on, and a triangle on no block to nobody", async () => {
    const wasm = await loadManifold();
    const arena = new Arena();
    try {
      const left = extrudeSection(wasm, arena, new wasm.CrossSection([rectContour(0, 0, 10, 10)], "Positive"), 1, 6);
      const right = extrudeSection(wasm, arena, new wasm.CrossSection([rectContour(20, 0, 30, 10)], "Positive"), 0, 4);
      expect(left).not.toBeNull();
      expect(right).not.toBeNull();
      if (left === null || right === null) return;
      const ownerIds: Record<number, string> = {};
      for (const [solid, id] of [
        [left, "way/left"],
        [right, "way/right"],
      ] as const) {
        const own = solid.originalID();
        for (const original of own >= 0 ? [own] : Array.from(solid.getMesh().runOriginalID)) ownerIds[original] = id;
      }
      const union = batchedUnion(wasm, arena, [left, right]);
      expect(union).not.toBeNull();
      if (union === null) return;
      const mesh = toRegionMesh(union, "buildings", 2, "#ffffff");
      const attribution = attributeTriangleOwners(union, mesh, ownerIds);
      expect(attribution.owners).toEqual(["way/left", "way/right"]);
      expect(attribution.unmatched).toBe(0);
      for (let t = 0; t < mesh.indices.length / 3; t += 1) {
        const x = mesh.positions[mesh.indices[t * 3] * 3];
        expect(attribution.triangleOwner[t], `triangle ${t} at x=${x}`).toBe(x <= 10 ? 0 : 1);
      }
      // A triangle nowhere near either block: NO_OWNER, never a guess.
      const foreign = {
        positions: new Float64Array([...mesh.positions, 100, 100, 100, 101, 100, 100, 100, 101, 100]),
        indices: new Uint32Array([...mesh.indices, mesh.positions.length / 3, mesh.positions.length / 3 + 1, mesh.positions.length / 3 + 2]),
      };
      const stray = attributeTriangleOwners(union, foreign, ownerIds);
      expect(stray.unmatched).toBe(1);
      expect(stray.triangleOwner[stray.triangleOwner.length - 1]).toBe(NO_OWNER);
      // A triangle split off a face (a corner of the left roof) still belongs to the left block.
      const roof = {
        positions: new Float64Array([0, 0, 6, 1, 0, 6, 0, 1, 6]),
        indices: new Uint32Array([0, 1, 2]),
      };
      const piece = attributeTriangleOwners(union, roof, ownerIds);
      expect(piece.unmatched).toBe(0);
      expect(piece.owners[piece.triangleOwner[0]]).toBe("way/left");
    } finally {
      arena.dispose();
    }
  }, 30_000);
});
