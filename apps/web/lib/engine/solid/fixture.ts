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

import type { AreaFeature, Building, Point, Road, SceneGraph, Tree } from "../../contracts";
import type { Manifold, ManifoldToplevel } from "./manifold";
import type { RegionMesh, TerrainGrid } from "../types";

const here = dirname(fileURLToPath(import.meta.url));

/** The committed Chicago Loop SceneGraph: the Python `/scene` output, 994 buildings. */
export function chicagoScene(): SceneGraph {
  const path = resolve(here, "../../../../../fixtures/chicago-scene.json");
  return JSON.parse(readFileSync(path, "utf8")) as SceneGraph;
}

/** The v1 golden build's single-mode volume, mm^3, from `fixtures/v1-golden/`. */
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

/**
 * Height of the printed surface at one plan point, mm, by probing the solid.
 *
 * A 0.4 mm column is intersected with the model and the top of what comes back
 * is read off. It is the only honest way to ask "how high is the model HERE"
 * once the model has terrain in it: a bounding box answers for the whole
 * region, and the question a recess, a deck or a hillside raises is always
 * local. Returns null where the model has no material at all.
 */
export function surfaceHeightAt(
  wasm: ManifoldToplevel,
  solid: Manifold,
  xMm: number,
  yMm: number,
  probeMm = 0.4,
): number | null {
  const half = probeMm / 2;
  const column = wasm.Manifold.cube([probeMm, probeMm, 400], false).translate([
    xMm - half,
    yMm - half,
    -200,
  ]);
  const hit = wasm.Manifold.intersection([solid, column]);
  column.delete();
  try {
    if (hit.isEmpty() || hit.volume() <= 0) return null;
    return hit.boundingBox().max[2];
  } finally {
    hit.delete();
  }
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

/** A rail centreline, matching the additive `rail` layer of `osm/types.ts`. */
export interface RailPart {
  id: string;
  path: Point[];
  width_m: number;
  bridge?: boolean;
  layer?: number;
}

export interface SceneParts {
  buildings?: Building[];
  roads?: Road[];
  water?: AreaFeature[];
  green?: AreaFeature[];
  /** v3: the additive rail layer, and the trees the engine now builds. */
  rail?: RailPart[];
  trees?: Tree[];
  radiusM?: number;
}

/** A minimal SceneGraph around the given layers. */
export function scene(parts: SceneParts = {}): SceneGraph {
  const radius = parts.radiusM ?? 200;
  const buildings = parts.buildings ?? [];
  const graph: SceneGraph & { rail?: RailPart[] } = {
    bounds: { min_x: -radius, min_y: -radius, max_x: radius, max_y: radius },
    center: { lat: 41.8827, lon: -87.6233 },
    buildings,
    roads: parts.roads ?? [],
    water: parts.water ?? [],
    green: parts.green ?? [],
    trees: parts.trees ?? [],
    stats: {
      building_count: buildings.length,
      coverage: buildings.length >= 20 ? "good" : "sparse",
      height_tag_ratio: 1,
    },
  };
  // `rail` is a TS-only additive key (`osm/types.ts`); only set it when a test
  // asks for one, so every existing scene is byte-identical to what it was.
  if (parts.rail !== undefined) graph.rail = parts.rail;
  return graph;
}

/**
 * A smooth synthetic heightfield over the crop, normalised to metres above its
 * own minimum exactly as `fetchTerrainGrid` returns one.
 *
 * `reliefM` is the peak-to-trough range, so a test can name the relief it wants
 * and read the printed answer back out of `stats.terrainReliefMm`.
 */
export function hillGrid(radiusM: number, reliefM = 20, cellM = 10): TerrainGrid {
  const cols = Math.floor((2 * radiusM) / cellM) + 2;
  const rows = cols;
  const elevations = new Float32Array(cols * rows);
  let min = Infinity;
  let max = -Infinity;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = -radiusM + c * cellM;
      const y = -radiusM + r * cellM;
      const value = (reliefM / 2) * Math.sin(x / 80) * Math.cos(y / 80);
      elevations[r * cols + c] = value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  for (let i = 0; i < elevations.length; i += 1) elevations[i] -= min;
  return {
    originEastM: -radiusM,
    originNorthM: -radiusM,
    cellM,
    cols,
    rows,
    elevations,
    rangeM: max - min,
    source: "test",
  };
}

/** A plane tilted `riseM` metres from the west edge to the east one. */
export function rampGrid(radiusM: number, riseM = 20, cellM = 10): TerrainGrid {
  const cols = Math.floor((2 * radiusM) / cellM) + 2;
  const rows = cols;
  const elevations = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      elevations[r * cols + c] = (riseM * c) / (cols - 1);
    }
  }
  return {
    originEastM: -radiusM,
    originNorthM: -radiusM,
    cellM,
    cols,
    rows,
    elevations,
    rangeM: riseM,
    source: "test",
  };
}

/** A road, plus the additive `bridge` / `layer` fields of `osm/types.ts`. */
export type RoadPart = Road & { bridge?: boolean; layer?: number };

/** One road centreline, with the additive elevation tags a test may want. */
export function road(
  id: string,
  path: Point[],
  widthM = 12,
  extra: { bridge?: boolean; layer?: number; class?: Road["class"] } = {},
): RoadPart {
  const out: RoadPart = {
    id,
    path,
    width_m: widthM,
    class: extra.class ?? "secondary",
  };
  if (extra.bridge !== undefined) out.bridge = extra.bridge;
  if (extra.layer !== undefined) out.layer = extra.layer;
  return out;
}

/** One area feature (water or green) from a ring. */
export function area(ring: Point[], holes: Point[][] = []): AreaFeature {
  return { ring, holes };
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
