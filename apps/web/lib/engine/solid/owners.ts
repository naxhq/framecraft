/**
 * Per-triangle building identity for the buildings, band and hero regions.
 *
 * manifold3d tracks every input mesh through its booleans: each building is
 * extruded as its own original (`Manifold.extrude` hands out a fresh
 * `originalID`), and the union that makes a region keeps one triangle run per
 * original (`MeshGL.runOriginalID` / `runIndex`). The `buildings` stage
 * records which building each original id belongs to
 * (`BuiltBuildings.ownerIds`), and this module carries that identity onto the
 * `RegionMesh` a finish stage ships: one owner index per triangle, indexing a
 * sorted list of building ids.
 *
 * The kernel's runs describe the mesh `getMesh()` returns, and that is NOT the
 * mesh the region ships: `toRegionMesh` welds and splits degenerate faces
 * (`mesh.cleanMesh`, which can add or drop triangles) and rewrites the whole
 * mesh into history-free order (`mesh.canonicalMesh`). Neither repair moves a
 * vertex by more than the coarsest weld rung (1e-4 mm), and neither moves a
 * triangle off the face it came from, so the owner of a shipped triangle is
 * found by GEOMETRY rather than by index bookkeeping: its centroid is looked up
 * among the raw centroids (an exact hit for every untouched triangle, a hit
 * within tolerance for a welded one), and a triangle no raw centroid accounts
 * for (a piece of a split face) is attributed to the raw triangle its centroid
 * lies on, among the raw triangles that share one of its corners. Robust to
 * any repair the mesh module makes now or later; costs one hash pass over the
 * raw triangles (Chicago's 19 000-triangle buildings region: about 10 ms).
 */

import { NO_OWNER, type RegionMesh } from "../types";
import type { Manifold } from "./manifold";

export interface OwnerAttribution {
  /** One entry per triangle of the shipped mesh: an index into `owners`, or `NO_OWNER`. */
  triangleOwner: Uint32Array;
  /** Building ids, sorted, unique: what `triangleOwner` indexes. */
  owners: string[];
  /** Shipped triangles no raw triangle could be found for (each is `NO_OWNER`). */
  unmatched: number;
}

/**
 * Two points closer than this are one: an order of magnitude above the
 * coarsest weld rung (`mesh.WELD_LADDER_MM`, 1e-4 mm) and the float32 the
 * kernel renders positions in (6e-6 mm at 100 mm), three below the smallest
 * printable feature (a 0.4 mm nozzle).
 */
export const OWNER_MATCH_TOLERANCE_MM = 1e-3;
/** Grid for the point lookups: two tolerances, so a match is in the same cell or a neighbour. */
const CELL_MM = 2 * OWNER_MATCH_TOLERANCE_MM;
/**
 * A split piece's centroid lies ON its parent face; this is the slack for the
 * weld that may have moved the parent's corners plus the float32 rendering.
 * Far below the distance between two faces of different buildings that
 * survived the union (a shared wall is interior and gone).
 */
const ON_FACE_TOLERANCE_MM = 1e-2;

/**
 * The owner of every triangle of `mesh`, which must be the `RegionMesh` built
 * from `solid` (by `toRegionMesh`); `ownerIds` maps a manifold original id to a
 * building id (`BuiltBuildings.ownerIds`).
 */
export function attributeTriangleOwners(
  solid: Manifold,
  mesh: Pick<RegionMesh, "positions" | "indices">,
  ownerIds: Readonly<Record<number, string>>,
): OwnerAttribution {
  const shipped = Math.floor(mesh.indices.length / 3);
  const raw = solid.getMesh();
  const rawTriangles = Math.floor(raw.triVerts.length / 3);
  if (shipped === 0 || rawTriangles === 0) {
    return { triangleOwner: new Uint32Array(shipped).fill(NO_OWNER), owners: [], unmatched: shipped };
  }
  // The kernel's float32 rendering, widened: exact enough for a lookup whose
  // tolerance is two orders of magnitude above float32's step.
  const rawVertices = Math.floor(raw.vertProperties.length / raw.numProp);
  const rawPositions = new Float64Array(rawVertices * 3);
  for (let v = 0; v < rawVertices; v += 1) {
    rawPositions[v * 3] = raw.vertProperties[v * raw.numProp];
    rawPositions[v * 3 + 1] = raw.vertProperties[v * raw.numProp + 1];
    rawPositions[v * 3 + 2] = raw.vertProperties[v * raw.numProp + 2];
  }

  // Owner per raw triangle, from the kernel's runs.
  const runs = raw.runOriginalID.length;
  const present = new Set<string>();
  for (let run = 0; run < runs; run += 1) {
    const id = ownerIds[raw.runOriginalID[run]];
    if (id !== undefined) present.add(id);
  }
  const owners = [...present].sort();
  const indexOf = new Map<string, number>(owners.map((id, index) => [id, index]));
  const rawOwner = new Uint32Array(rawTriangles).fill(NO_OWNER);
  for (let run = 0; run < runs; run += 1) {
    const index = indexOf.get(ownerIds[raw.runOriginalID[run]] ?? "");
    if (index === undefined) continue;
    const from = raw.runIndex[run] / 3;
    const to = run + 1 < raw.runIndex.length ? raw.runIndex[run + 1] / 3 : rawTriangles;
    rawOwner.fill(index, from, to);
  }

  // Raw centroids, hashed on the grid.
  const rawCentroid = new Float64Array(rawTriangles * 3);
  const byCentroid = new PointIndex();
  for (let t = 0; t < rawTriangles; t += 1) {
    centroidInto(rawPositions, raw.triVerts, t, rawCentroid, t);
    byCentroid.add(rawCentroid[t * 3], rawCentroid[t * 3 + 1], rawCentroid[t * 3 + 2], t);
  }

  // The on-face fallback for a piece of a split face: the raw triangles that
  // share one of its corners, built only if a shipped triangle needs it.
  let byVertex: PointIndex | null = null;
  let incident: { offsets: Uint32Array; triangles: Uint32Array } | null = null;
  const onFace = (cx: number, cy: number, cz: number, corners: readonly number[]): number => {
    if (byVertex === null || incident === null) {
      byVertex = new PointIndex();
      for (let v = 0; v < rawVertices; v += 1) byVertex.add(rawPositions[v * 3], rawPositions[v * 3 + 1], rawPositions[v * 3 + 2], v);
      incident = incidence(raw.triVerts, rawVertices, rawTriangles);
    }
    let bestIndex = -1;
    let bestD2 = ON_FACE_TOLERANCE_MM * ON_FACE_TOLERANCE_MM;
    const seen = new Set<number>();
    for (const corner of corners) {
      for (const v of byVertex.near(mesh.positions[corner * 3], mesh.positions[corner * 3 + 1], mesh.positions[corner * 3 + 2], rawPositions, OWNER_MATCH_TOLERANCE_MM)) {
        for (let k = incident.offsets[v]; k < incident.offsets[v + 1]; k += 1) {
          const t = incident.triangles[k];
          if (seen.has(t)) continue;
          seen.add(t);
          const d2 = pointTriangleDistance2(cx, cy, cz, rawPositions, raw.triVerts, t);
          if (d2 < bestD2 || (d2 === bestD2 && bestIndex !== -1 && t < bestIndex)) {
            bestD2 = d2;
            bestIndex = t;
          }
        }
      }
    }
    return bestIndex;
  };

  const triangleOwner = new Uint32Array(shipped);
  const centroid = new Float64Array(3);
  let unmatched = 0;
  for (let t = 0; t < shipped; t += 1) {
    centroidInto(mesh.positions, mesh.indices, t, centroid, 0);
    let rawIndex = byCentroid.nearest(centroid[0], centroid[1], centroid[2], rawCentroid, OWNER_MATCH_TOLERANCE_MM);
    if (rawIndex === -1) rawIndex = onFace(centroid[0], centroid[1], centroid[2], [mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]]);
    if (rawIndex === -1 || rawOwner[rawIndex] === NO_OWNER) {
      triangleOwner[t] = NO_OWNER;
      unmatched += 1;
    } else {
      triangleOwner[t] = rawOwner[rawIndex];
    }
  }
  return { triangleOwner, owners, unmatched };
}

/**
 * Points on a grid of `CELL_MM` cells, keyed by cell: the same cell or one of
 * its 26 neighbours holds every point within a tolerance of half a cell.
 */
class PointIndex {
  private readonly cells = new Map<number, number[]>();

  add(x: number, y: number, z: number, index: number): void {
    const key = cellKey(Math.floor(x / CELL_MM), Math.floor(y / CELL_MM), Math.floor(z / CELL_MM));
    const list = this.cells.get(key);
    if (list === undefined) this.cells.set(key, [index]);
    else list.push(index);
  }

  /** The nearest indexed point within `tolerance` of (x, y, z), lowest index on a tie, or -1. */
  nearest(x: number, y: number, z: number, points: Float64Array, tolerance: number): number {
    const ix = Math.floor(x / CELL_MM);
    const iy = Math.floor(y / CELL_MM);
    const iz = Math.floor(z / CELL_MM);
    const tolerance2 = tolerance * tolerance;
    let best = -1;
    let bestD2 = Infinity;
    const scan = (key: number): void => {
      const list = this.cells.get(key);
      if (list === undefined) return;
      for (const index of list) {
        const dx = points[index * 3] - x;
        const dy = points[index * 3 + 1] - y;
        const dz = points[index * 3 + 2] - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= tolerance2 && (d2 < bestD2 || (d2 === bestD2 && index < best))) {
          bestD2 = d2;
          best = index;
        }
      }
    };
    // The point's own cell first: an untouched triangle is an exact hit there,
    // and only a welded one (rare) pays for the neighbourhood.
    scan(cellKey(ix, iy, iz));
    if (best !== -1) return best;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          if (dx !== 0 || dy !== 0 || dz !== 0) scan(cellKey(ix + dx, iy + dy, iz + dz));
        }
      }
    }
    return best;
  }

  /** Every indexed point within `tolerance` of (x, y, z). */
  near(x: number, y: number, z: number, points: Float64Array, tolerance: number): number[] {
    const ix = Math.floor(x / CELL_MM);
    const iy = Math.floor(y / CELL_MM);
    const iz = Math.floor(z / CELL_MM);
    const tolerance2 = tolerance * tolerance;
    const out: number[] = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const list = this.cells.get(cellKey(ix + dx, iy + dy, iz + dz));
          if (list === undefined) continue;
          for (const index of list) {
            const ex = points[index * 3] - x;
            const ey = points[index * 3 + 1] - y;
            const ez = points[index * 3 + 2] - z;
            if (ex * ex + ey * ey + ez * ez <= tolerance2) out.push(index);
          }
        }
      }
    }
    return out;
  }
}

/** Triangles incident to each vertex, CSR style: those of vertex v are `triangles[offsets[v] .. offsets[v + 1])`. */
function incidence(indices: Uint32Array, vertices: number, triangles: number): { offsets: Uint32Array; triangles: Uint32Array } {
  const offsets = new Uint32Array(vertices + 1);
  for (let k = 0; k < triangles * 3; k += 1) offsets[indices[k] + 1] += 1;
  for (let v = 0; v < vertices; v += 1) offsets[v + 1] += offsets[v];
  const fill = offsets.slice(0, vertices);
  const out = new Uint32Array(triangles * 3);
  for (let k = 0; k < triangles * 3; k += 1) {
    const v = indices[k];
    out[fill[v]] = Math.floor(k / 3);
    fill[v] += 1;
  }
  return { offsets, triangles: out };
}

function centroidInto(positions: Float64Array, indices: Uint32Array, triangle: number, out: Float64Array, at: number): void {
  const a = indices[triangle * 3] * 3;
  const b = indices[triangle * 3 + 1] * 3;
  const c = indices[triangle * 3 + 2] * 3;
  out[at * 3] = (positions[a] + positions[b] + positions[c]) / 3;
  out[at * 3 + 1] = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3;
  out[at * 3 + 2] = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
}

function cellKey(ix: number, iy: number, iz: number): number {
  // Three large odd multipliers, mixed: distinct cells rarely collide, and a
  // collision only costs a distance check that fails.
  return (Math.imul(ix, 0x9e3779b1) ^ Math.imul(iy, 0x85ebca77) ^ Math.imul(iz, 0xc2b2ae3d)) >>> 0;
}

/** Squared distance from a point to triangle `t` (closest point on the triangle, Ericson 5.1.5). */
function pointTriangleDistance2(px: number, py: number, pz: number, positions: Float64Array, indices: Uint32Array, t: number): number {
  const ia = indices[t * 3] * 3;
  const ib = indices[t * 3 + 1] * 3;
  const ic = indices[t * 3 + 2] * 3;
  const ax = positions[ia];
  const ay = positions[ia + 1];
  const az = positions[ia + 2];
  const abx = positions[ib] - ax;
  const aby = positions[ib + 1] - ay;
  const abz = positions[ib + 2] - az;
  const acx = positions[ic] - ax;
  const acy = positions[ic + 1] - ay;
  const acz = positions[ic + 2] - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - positions[ib];
  const bpy = py - positions[ib + 1];
  const bpz = pz - positions[ib + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return distance2(px, py, pz, ax + v * abx, ay + v * aby, az + v * abz);
  }
  const cpx = px - positions[ic];
  const cpy = py - positions[ic + 1];
  const cpz = pz - positions[ic + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return distance2(px, py, pz, ax + w * acx, ay + w * acy, az + w * acz);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return distance2(
      px,
      py,
      pz,
      positions[ib] + w * (positions[ic] - positions[ib]),
      positions[ib + 1] + w * (positions[ic + 1] - positions[ib + 1]),
      positions[ib + 2] + w * (positions[ic + 2] - positions[ib + 2]),
    );
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return distance2(px, py, pz, ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

function distance2(px: number, py: number, pz: number, qx: number, qy: number, qz: number): number {
  const dx = px - qx;
  const dy = py - qy;
  const dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}
