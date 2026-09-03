// Scratch: count degenerate faces in the buildings union under construction variants.
//   npx vite-node scripts/_degen-variants.ts -- <overpass.json> <params.json> <lat> <lon> <rotation>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultPrintParams, type PrintParams } from "../lib/contracts";
import { sceneFromOverpass } from "../lib/engine/osm/scene";
import { makeContext, PART_OVERLAP_MM, LAYER_SEPARATION_MM } from "../lib/engine/solid/context";
import { Arena, loadManifold, doublePositions, batchedUnion, extrudeSection, offsetSection, intersectSection, cleanSection } from "../lib/engine/solid/manifold";
import { repairBuildings, type BuildingSolid } from "../lib/engine/solid/repair";
import { buildingSpanMm, skirtMm } from "../lib/engine/solid/buildings";
import { cleanMesh, degenerateFaces } from "../lib/engine/solid/mesh";
import * as T from "../lib/transform";

async function main(): Promise<void> {
  const [overpass, paramsPath, lat, lon, rotation] = process.argv.slice(2).filter((a) => a !== "--");
  const params: PrintParams = { ...defaultPrintParams(), ...JSON.parse(readFileSync(resolve(paramsPath), "utf8")) };
  const raw = JSON.parse(readFileSync(resolve(overpass), "utf8"));
  const scene = sceneFromOverpass(raw, { lat: Number(lat), lon: Number(lon), radius_m: 900, rotation_deg: Number(rotation) }, params);
  const wasm = await loadManifold();
  const arena = new Arena();
  const ctx = makeContext({ wasm, arena, scene, params });
  const repaired = repairBuildings(ctx, []);
  const blocks = repaired.solids.filter((s) => s.standsOn === null);
  const blockOf = (s: BuildingSolid) => blocks.find((b) => b.height === s.standsOn) ?? null;
  const variants: Array<{ name: string; overlap: number; inset: number }> = [
    { name: "as-is", overlap: 0, inset: 0 },
    { name: "interpenetrate 0.2", overlap: PART_OVERLAP_MM, inset: 0 },
    { name: "inset 0.02", overlap: 0, inset: LAYER_SEPARATION_MM },
    { name: "inset 0.02 + interpenetrate", overlap: PART_OVERLAP_MM, inset: LAYER_SEPARATION_MM },
  ];
  for (const v of variants) {
    const pieces = [];
    let stacked = 0;
    for (const s of repaired.solids) {
      let [z0, z1] = buildingSpanMm(ctx, s);
      let section = s.section;
      if (s.standsOn !== null) {
        stacked += 1;
        z0 -= v.overlap;
        if (v.inset > 0) {
          const block = blockOf(s);
          if (block !== null) {
            const shrunk = offsetSection(arena, block.section, -v.inset);
            const clipped = shrunk === null ? null : intersectSection(arena, s.section, shrunk);
            if (clipped === null) continue;
            section = cleanSection(arena, clipped);
          }
        }
      }
      const piece = extrudeSection(wasm, arena, section, z0, z1);
      if (piece !== null) pieces.push(piece);
    }
    const solid = batchedUnion(wasm, arena, pieces);
    if (solid === null) throw new Error("empty");
    const mesh = solid.getMesh();
    const positions = doublePositions(solid, mesh.vertProperties, mesh.numProp);
    const indices = new Uint32Array(mesh.triVerts);
    const before = degenerateFaces({ positions, indices });
    const t0 = performance.now();
    const cleaned = cleanMesh({ positions, indices });
    const after = degenerateFaces(cleaned.mesh);
    console.log(`${v.name}: stacked ${stacked}, tris ${indices.length / 3}, degenerate before ${before} after ${after} (clean ${(performance.now() - t0).toFixed(0)} ms, volume ${solid.volume().toFixed(2)})`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
