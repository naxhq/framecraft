// Scratch: slice the bridge solids of a preset at a height and dump the polygons near a point.
//   npx vite-node scripts/_dump-bridges.ts -- <overpass.json> <params.json> <lat> <lon> <rotation> <z> <x> <y>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultPrintParams, type PrintParams } from "../lib/contracts";
import { sceneFromOverpass } from "../lib/engine/osm/scene";
import { makeContext } from "../lib/engine/solid/context";
import { Arena, loadManifold } from "../lib/engine/solid/manifold";
import { repairBuildings } from "../lib/engine/solid/repair";
import { buildBridges } from "../lib/engine/solid/bridges";

async function main(): Promise<void> {
  const [overpass, paramsPath, lat, lon, rotation, zs, xs, ys] = process.argv.slice(2).filter((a) => a !== "--");
  const params: PrintParams = { ...defaultPrintParams(), ...JSON.parse(readFileSync(resolve(paramsPath), "utf8")) };
  const raw = JSON.parse(readFileSync(resolve(overpass), "utf8"));
  const scene = sceneFromOverpass(raw, { lat: Number(lat), lon: Number(lon), radius_m: 900, rotation_deg: Number(rotation) }, params);
  const wasm = await loadManifold();
  const arena = new Arena();
  const ctx = makeContext({ wasm, arena, scene, params });
  const repaired = repairBuildings(ctx, []);
  const bridges = buildBridges(ctx, repaired.footprint, null);
  const z = Number(zs), x = Number(xs), y = Number(ys);
  for (const bridge of bridges) {
    const section = bridge.solid.slice(z);
    for (const ring of section.toPolygons()) {
      const near = ring.some(([px, py]) => Math.hypot(px - x, py - y) < 1.5);
      if (near) console.log(`${bridge.region} ring at z=${z}: ${JSON.stringify(ring.map(([px, py]) => [Number(px.toFixed(4)), Number(py.toFixed(4))]))}`);
    }
    section.delete();
  }
  console.log(`bridges: ${bridges.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
