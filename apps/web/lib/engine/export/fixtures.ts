// Synthetic RegionMesh builders for the export tests: axis-aligned boxes and
// an L-shaped prism, each a closed, outward-wound triangle mesh in the engine
// frame (millimetres, z up). Kept beside the exporters, not in a test file,
// so the CLI smoke test and the Bambu round trip can reuse them.

import { DEFAULT_PRINT_PARAMS, defaultPrintParams, type PrintParams } from "../../contracts";
import type { Bbox3, EngineResult, RegionMesh, RegionName } from "../types";

export interface BoxSpec {
  region: RegionName;
  slot: number;
  colorHex: string;
  /** Minimum corner [x, y, z] in mm. */
  min: [number, number, number];
  /** Extent [dx, dy, dz] in mm. */
  size: [number, number, number];
}

function finish(region: RegionName, slot: number, colorHex: string, positions: number[], indices: number[], volumeMm3: number, bodies = 1): RegionMesh {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  }
  const bbox: Bbox3 = { min, max };
  return {
    region,
    positions: new Float64Array(positions),
    indices: new Uint32Array(indices),
    volumeMm3,
    bbox,
    bodies,
    slot,
    colorHex,
  };
}

/** A closed box: 8 vertices, 12 triangles, counter-clockwise from outside. */
export function boxRegion(spec: BoxSpec): RegionMesh {
  const [x0, y0, z0] = spec.min;
  const [x1, y1, z1] = [x0 + spec.size[0], y0 + spec.size[1], z0 + spec.size[2]];
  const positions = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const indices = [
    0, 2, 1, 0, 3, 2, // bottom (z0), normal -z
    4, 5, 6, 4, 6, 7, // top (z1), normal +z
    0, 1, 5, 0, 5, 4, // front (y0), normal -y
    1, 2, 6, 1, 6, 5, // right (x1), normal +x
    2, 3, 7, 2, 7, 6, // back (y1), normal +y
    3, 0, 4, 3, 4, 7, // left (x0), normal -x
  ];
  return finish(spec.region, spec.slot, spec.colorHex, positions, indices, spec.size[0] * spec.size[1] * spec.size[2]);
}

/**
 * An L-shaped prism (the footprint of a box with one quadrant removed):
 * 12 vertices, 20 triangles, closed and outward-wound. `size` is the full
 * box extent; the removed quadrant is the +x/+y corner at half width and depth.
 */
export function lShapeRegion(spec: BoxSpec): RegionMesh {
  const [x0, y0, z0] = spec.min;
  const [w, d, h] = spec.size;
  const xm = x0 + w / 2;
  const ym = y0 + d / 2;
  const x1 = x0 + w;
  const y1 = y0 + d;
  const z1 = z0 + h;
  // Footprint, counter-clockwise: (x0,y0) (x1,y0) (x1,ym) (xm,ym) (xm,y1) (x0,y1)
  const ring = [
    [x0, y0],
    [x1, y0],
    [x1, ym],
    [xm, ym],
    [xm, y1],
    [x0, y1],
  ];
  const positions: number[] = [];
  for (const [x, y] of ring) positions.push(x, y, z0);
  for (const [x, y] of ring) positions.push(x, y, z1);
  const indices: number[] = [];
  // Concave hexagon split into two convex quads: (0,1,2,3) and (0,3,4,5).
  const capTriangles = [
    [0, 1, 2],
    [0, 2, 3],
    [0, 3, 4],
    [0, 4, 5],
  ];
  for (const [a, b, c] of capTriangles) {
    indices.push(a, c, b); // bottom, facing -z
    indices.push(a + 6, b + 6, c + 6); // top, facing +z
  }
  for (let i = 0; i < 6; i += 1) {
    const j = (i + 1) % 6;
    // side quad i -> j, bottom to top, outward for a CCW footprint
    indices.push(i, j, j + 6);
    indices.push(i, j + 6, i + 6);
  }
  const volume = (w * d - (w / 2) * (d / 2)) * h;
  return finish(spec.region, spec.slot, spec.colorHex, positions, indices, volume);
}

/** A framed-city stand-in: base slab, frame lip, two building blocks, a water pocket, lettering. */
export function sampleRegions(): RegionMesh[] {
  return [
    boxRegion({ region: "base", slot: 1, colorHex: "#D8D3C6", min: [-90, -90, 0], size: [180, 180, 3] }),
    lShapeRegion({ region: "frame", slot: 1, colorHex: "#3A3A3A", min: [-90, -90, 3], size: [12, 12, 2] }),
    boxRegion({ region: "buildings", slot: 2, colorHex: "#D8D3C6", min: [-20, -20, 3], size: [15, 15, 30] }),
    boxRegion({ region: "hero_building", slot: 4, colorHex: "#E3A72F", min: [10, 10, 3], size: [12, 12, 45] }),
    boxRegion({ region: "water", slot: 3, colorHex: "#2F7FC1", min: [30, -60, 2], size: [40, 25, 1] }),
    boxRegion({ region: "lettering", slot: 4, colorHex: "#E3A72F", min: [-60, -88, 4.6], size: [60, 6, 0.4] }),
  ];
}

/**
 * A stand-in for the boolean union in a hand-built fixture: the regions
 * concatenated. A test that needs the REAL union (one body, no interior walls)
 * bakes a scene; these fixtures are for checking file structure.
 */
function concatenated(regions: RegionMesh[]): RegionMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  let volume = 0;
  let base = 0;
  for (const region of regions) {
    for (const value of region.positions) positions.push(value);
    for (const index of region.indices) indices.push(index + base);
    base += region.positions.length / 3;
    volume += region.volumeMm3;
  }
  return finish("base", 1, "#D8D3C6", positions, indices, volume, regions.length);
}

export function makeResult(regions: RegionMesh[], params: PrintParams = defaultPrintParams()): EngineResult {
  let triangles = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const region of regions) {
    triangles += region.indices.length / 3;
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k], region.bbox.min[k]);
      max[k] = Math.max(max[k], region.bbox.max[k]);
    }
  }
  return {
    regions,
    // The fixtures are hand-built partitions, so the "merged" mesh a single
    // object format writes is stood in for by the first region. A test that
    // cares about the real union bakes one.
    merged: concatenated(regions),
    params,
    findings: [],
    resolvedText: [],
    stats: {
      scaleDenominator: 10000,
      minWallMm: 0.8,
      measuredMinWallMm: 0.8,
      buildings: regions.filter((r) => r.region === "buildings" || r.region === "hero_building").length,
      buildingsMerged: 0,
      buildingsDilated: 0,
      heightFallbacks: 0,
      triangles,
      widthMm: max[0] - min[0],
      depthMm: max[1] - min[1],
      heightMm: max[2] - min[2],
      elapsedMs: 0,
    },
  };
}

export const FIXED_DATE = new Date(Date.UTC(2026, 7, 30, 12, 0, 0));

export function sampleResult(overrides: Partial<PrintParams> = {}): EngineResult {
  const params: PrintParams = { ...defaultPrintParams(), ...overrides };
  return makeResult(sampleRegions(), params);
}

export { DEFAULT_PRINT_PARAMS };
