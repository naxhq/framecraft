/**
 * Test helpers shared by the engine's own suites.
 *
 * Kept out of the `.test.ts` files so both of them read the Chicago fixture the
 * same way, and so a helper that reconstructs a region from its exported mesh
 * lives next to the code that exported it: the reconstruction IS a test - a
 * `RegionMesh` that manifold3d refuses to re-import is not a watertight solid,
 * whatever the solid it came from claimed.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AreaFeature, Building, Point, Road, SceneGraph } from "../../contracts";
import type { Manifold, ManifoldToplevel } from "./manifold";
import type { RegionMesh } from "../types";

const here = dirname(fileURLToPath(import.meta.url));

/** The committed Chicago Loop SceneGraph: the Python `/scene` output, 994 buildings. */
export function chicagoScene(): SceneGraph {
  const path = resolve(here, "../../../../../fixtures/chicago-scene.json");
  return JSON.parse(readFileSync(path, "utf8")) as SceneGraph;
}

/** The v1 golden bake's single-mode volume, mm^3, from `fixtures/v1-golden/`. */
export const PYTHON_REFERENCE_VOLUME_MM3 = 167624.12441295458;

/** Re-import an exported region. Throws if the mesh is not a valid solid. */
export function solidFromMesh(wasm: ManifoldToplevel, mesh: RegionMesh): Manifold {
  const imported = new wasm.Mesh({
    numProp: 3,
    // `Mesh` is float32 by binding; the engine keeps doubles.
    vertProperties: new Float32Array(mesh.positions),
    triVerts: mesh.indices,
  });
  return wasm.Manifold.ofMesh(imported);
}

/** Volume shared by two regions, mm^3. Regions must partition, so this is 0. */
export function overlapMm3(wasm: ManifoldToplevel, a: Manifold, b: Manifold): number {
  const shared = wasm.Manifold.intersection([a, b]);
  const volume = shared.volume();
  shared.delete();
  return volume;
}

// ---------------------------------------------------------------------------
// Synthetic scenes
// ---------------------------------------------------------------------------

/** A square ring of side `size` metres centred on `(cx, cy)`, counter-clockwise. */
export function square(cx: number, cy: number, size: number): Point[] {
  const h = size / 2;
  return [
    [cx - h, cy - h],
    [cx + h, cy - h],
    [cx + h, cy + h],
    [cx - h, cy + h],
  ];
}

/** The same square wound clockwise, which is the convention for a hole. */
export function squareHole(cx: number, cy: number, size: number): Point[] {
  return [...square(cx, cy, size)].reverse();
}

export interface SceneParts {
  buildings?: Building[];
  roads?: Road[];
  water?: AreaFeature[];
  green?: AreaFeature[];
  radiusM?: number;
}

/** A minimal SceneGraph around the given layers. */
export function scene(parts: SceneParts = {}): SceneGraph {
  const radius = parts.radiusM ?? 200;
  const buildings = parts.buildings ?? [];
  return {
    bounds: { min_x: -radius, min_y: -radius, max_x: radius, max_y: radius },
    center: { lat: 41.8827, lon: -87.6233 },
    buildings,
    roads: parts.roads ?? [],
    water: parts.water ?? [],
    green: parts.green ?? [],
    trees: [],
    stats: {
      building_count: buildings.length,
      coverage: buildings.length >= 20 ? "good" : "sparse",
      height_tag_ratio: 1,
    },
  };
}

/** One building, with sane defaults for everything the test does not care about. */
export function building(
  id: string,
  ring: Point[],
  heightM = 30,
  holes: Point[][] = [],
): Building {
  return {
    id,
    ring,
    holes,
    height_m: heightM,
    height_source: "tag",
    min_height_m: 0,
    is_tall: heightM >= 40,
  };
}
