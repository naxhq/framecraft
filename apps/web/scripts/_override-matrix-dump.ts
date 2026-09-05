/**
 * Scratch: what each `object_overrides[]` leaf actually moves, so the matrix
 * probes assert measured numbers rather than guessed ones.
 *
 * `npx vite-node scripts/_override-matrix-dump.ts [case-name]`
 */

import type { ObjectOverride, PrintParams } from "../lib/contracts";
import { bambuParts, bambuProject, mtlNames, objGroups, sidecarRegions, type Snapshot } from "../lib/engine/pipeline/matrix.assert";
import { MatrixGroup, type MatrixScene } from "../lib/engine/pipeline/matrix.run";

function describe(tag: string, snapshot: Snapshot): void {
  const regions = snapshot.result.regions
    .map(
      (r) =>
        `${r.region}[slot ${r.slot} ${r.colorHex} vol ${r.volumeMm3.toFixed(4)} tris ${r.indices.length / 3} z ${r.bbox.min[2].toFixed(4)}..${r.bbox.max[2].toFixed(4)} x ${r.bbox.min[0].toFixed(4)}..${r.bbox.max[0].toFixed(4)} y ${r.bbox.min[1].toFixed(4)}..${r.bbox.max[1].toFixed(4)} bodies ${r.bodies}]`,
    )
    .join("\n    ");
  console.log(`  ${tag}\n    ${regions}`);
  const tints = snapshot.result.buildingTints ?? [];
  console.log(`    tints: ${tints.length} ${tints.map((t) => `${t.id}=${t.colorHex}`).join(",")}`);
  const stats = snapshot.result.stats;
  const total = snapshot.result.regions.reduce((sum, r) => sum + r.volumeMm3, 0);
  console.log(
    `    stats: vol ${total.toFixed(4)} tris ${stats.triangles} trees ${stats.trees ?? "-"} overrides ${stats.overrides ?? "-"}/${stats.overridesUnresolved ?? "-"}/${stats.overridesUnplaced ?? "-"}`,
  );
  try {
    const parts = [...bambuParts(snapshot.files).values()]
      .map((p) => `${p.region}[ex ${p.extruder} vol ${p.volumeMm3.toFixed(4)} tris ${p.triangles} z ${p.bbox.min[2].toFixed(4)}..${p.bbox.max[2].toFixed(4)} y ${p.bbox.min[1].toFixed(4)}..${p.bbox.max[1].toFixed(4)}]`)
      .join("\n      ");
    console.log(`    parts:\n      ${parts}`);
    console.log(`    filament_colour: ${JSON.stringify(bambuProject(snapshot.files).filament_colour)}`);
  } catch (error) {
    console.log(`    parts: ${(error as Error).message}`);
  }
  try {
    const kd = new TextDecoder()
      .decode(snapshot.files.filter((f) => f.name.endsWith(".mtl"))[0].bytes)
      .split("\n")
      .filter((line) => line.startsWith("Kd "));
    console.log(`    mtl: ${mtlNames(snapshot.files).join(",")} kd ${kd.join(" | ")} groups ${objGroups(snapshot.files).join(",")}`);
  } catch {
    // Not an OBJ build.
  }
  const sidecar = [...sidecarRegions(snapshot.sidecar).values()].map((r) => `${r.region}[slot ${r.slot} ${r.color} bodies ${r.bodies}]`);
  console.log(`    sidecar: ${sidecar.join(" ")}`);
  console.log(`    files: ${snapshot.files.map((f) => f.name).join(" ")}`);
}

interface Case {
  name: string;
  scene: MatrixScene;
  base: Partial<PrintParams>;
  path: string;
  value: unknown;
}

const rows = (...list: ObjectOverride[]): Partial<PrintParams> => ({ object_overrides: list });

const BUILDING: ObjectOverride = { osm_id: "b-tall", layer: "building" };
const ROAD: ObjectOverride = { osm_id: "r-main", layer: "road" };

const CASES: Case[] = [
  { name: "hidden", scene: "override", base: rows(BUILDING), path: "object_overrides[].hidden", value: true },
  { name: "height_scale", scene: "override", base: rows(BUILDING), path: "object_overrides[].height_scale", value: 0.5 },
  { name: "hero", scene: "override", base: rows(BUILDING), path: "object_overrides[].hero", value: "on" },
  { name: "slot", scene: "override", base: rows(BUILDING), path: "object_overrides[].slot", value: 3 },
  {
    name: "color",
    scene: "override",
    base: { ...rows({ ...BUILDING, slot: 3 }), colour: { region_slots: { water: 2 } } },
    path: "object_overrides[].color",
    value: "#B00020",
  },
  { name: "color-plain", scene: "override", base: rows({ ...BUILDING, slot: 3 }), path: "object_overrides[].color", value: "#B00020" },
  {
    name: "tint",
    scene: "override",
    base: { ...rows(BUILDING), export_target: "obj", color_mode: "parts" },
    path: "object_overrides[].tint",
    value: "#B08D57",
  },
  { name: "osm_id", scene: "override", base: rows({ ...BUILDING, hidden: true }), path: "object_overrides[].osm_id", value: "b-low" },
  { name: "layer", scene: "override", base: rows({ ...BUILDING, hidden: true }), path: "object_overrides[].layer", value: "road" },
  { name: "layer-road", scene: "override", base: rows({ ...ROAD, hidden: true }), path: "object_overrides[].layer", value: "building" },
  { name: "road_mode", scene: "override", base: rows(ROAD), path: "object_overrides[].road_mode", value: "emboss" },
  { name: "width_scale", scene: "override", base: rows(ROAD), path: "object_overrides[].width_scale", value: 2 },
  { name: "raise_green", scene: "override", base: rows({ osm_id: "w-park", layer: "green" }), path: "object_overrides[].raise_mm", value: 1 },
  { name: "raise_water", scene: "override", base: rows({ osm_id: "w-pond", layer: "water" }), path: "object_overrides[].raise_mm", value: 1 },
];

async function main(): Promise<void> {
  const only = process.argv[2];
  for (const entry of CASES) {
    if (only !== undefined && entry.name !== only) continue;
    console.log(`\n=== ${entry.name}: ${entry.path} = ${JSON.stringify(entry.value)} base ${JSON.stringify(entry.base)}`);
    let group: MatrixGroup | null = null;
    try {
      group = await MatrixGroup.open(entry.scene, entry.base);
      describe("before", group.before);
      const after = await group.run(entry.path, entry.value);
      describe("after ", after);
    } catch (error) {
      console.log(`  FAILED: ${(error as Error).message}`);
    } finally {
      group?.dispose();
    }
  }
}

void main();
