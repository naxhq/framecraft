/** Throwaway measurement probe for Task 10. Deleted before hand-off. */
import { readFileSync } from "node:fs";

import { sceneFromOverpass, type OverpassResponse } from "../lib/engine/osm/normalize";
import type { SceneRequest } from "../lib/contracts";

const ROOT = "D:/VahidVibeProject/CityDesign3D";
const RAW = JSON.parse(
  readFileSync(`${ROOT}/tests/fixtures/overpass-chicago-loop.json`, "utf-8"),
) as OverpassResponse;
const REQUEST: SceneRequest = {
  lat: 41.8827,
  lon: -87.6233,
  radius_m: 900.0,
  rotation_deg: 0.0,
  preset_id: "chicago-loop",
};

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf-8");

const scene = sceneFromOverpass(RAW, REQUEST);
console.log("buildings", scene.buildings.length);
console.log("roads", scene.roads.length);
console.log("water", scene.water.length);
console.log("green", scene.green.length);
console.log("rail", scene.rail.length);
console.log("trees", scene.trees.length);
console.log("scene bytes (before)", bytes(scene));
console.log(
  "  buildings bytes",
  bytes(scene.buildings),
  "roads",
  bytes(scene.roads),
  "water",
  bytes(scene.water),
  "green",
  bytes(scene.green),
);

// What the ingest already carries, but does not emit: the OSM name per building.
let named = 0;
let nameBytes = 0;
let longest = 0;
for (const b of scene.buildings) {
  const name = (b as { name?: string }).name;
  if (typeof name !== "string" || name.length === 0) continue;
  named += 1;
  nameBytes += Buffer.byteLength(name, "utf-8");
  longest = Math.max(longest, Buffer.byteLength(name, "utf-8"));
}
console.log("named buildings", named, "name bytes", nameBytes, "longest", longest);

// Every element that would carry a name/kind/osm_id, straight off the raw tags.
const tally = { building: 0, road: 0, water: 0, green: 0 };
const tallyNamed = { building: 0, road: 0, water: 0, green: 0 };
const tallyNameBytes = { building: 0, road: 0, water: 0, green: 0 };
for (const e of RAW.elements) {
  const tags = (e.tags ?? {}) as Record<string, unknown>;
  let layer: keyof typeof tally | null = null;
  if (tags["building"] && !["no", "false"].includes(String(tags["building"]).toLowerCase())) {
    layer = "building";
  } else if (typeof tags["highway"] === "string") layer = "road";
  else if (tags["natural"] === "water" || tags["waterway"] === "riverbank") layer = "water";
  else if (typeof tags["landuse"] === "string" || typeof tags["leisure"] === "string") layer = "green";
  if (layer === null) continue;
  tally[layer] += 1;
  const name = tags["name"];
  if (typeof name === "string" && name.length > 0) {
    tallyNamed[layer] += 1;
    tallyNameBytes[layer] += Buffer.byteLength(name, "utf-8");
  }
}
console.log("raw elements per layer", tally);
console.log("raw named per layer", tallyNamed);
console.log("raw name bytes per layer", tallyNameBytes);
