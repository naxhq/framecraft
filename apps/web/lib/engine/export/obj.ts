// Wavefront OBJ with one `o`/`g` group per region and a companion MTL whose
// `Kd` is the region colour. Vertex indices are global and 1-based; the
// header comments carry the same metadata as the 3MF.
//
// v3 phase 5: OBJ is the ONE export target that can carry a colour per body,
// so it is the one place `colour.tint` becomes a file rather than a preview.
// With a tint on, each buildings-family region is split into its connected
// bodies, every body takes the tint of the building nearest it, and the shades
// are bucketed to at most `MAX_TINT_MATERIALS` materials
// (`solid/tint.ts`, `[V3-P5-F8]`). Nothing else about the format changes, and
// with the tint off the bytes are exactly what they were.

import { bandIndexOf, type BuildingTint, type EngineResult, type ExportFile, type RegionMesh } from "../types";
import { bucketTints, MAX_TINT_MATERIALS } from "../solid/tint";
import {
  APPLICATION,
  ATTRIBUTION,
  colorToUnit,
  isoTimestamp,
  VERTEX_DECIMALS,
  isSingleObject,
  orderedRegions,
  placeInBuildSpace,
  placeMerged,
  provenanceLines,
  resolveOptions,
  sourceLine,
  type ExportOptions,
} from "./common";
import { fmtNum } from "./xml";

export const MIME_OBJ = "model/obj";
export const MIME_MTL = "model/mtl";

function commentBlock(lines: string[]): string {
  return lines.map((line) => `# ${line}`).join("\n") + "\n";
}

/** One `o`/`g`/`usemtl` block: a mesh, a name and the colour of its material. */
interface ObjGroup {
  name: string;
  material: string;
  colorHex: string;
  positions: Float64Array;
  indices: Uint32Array;
}

export function exportObj(result: EngineResult, options: ExportOptions = {}): ExportFile[] {
  const resolved = resolveOptions(result, options);
  const placed = placeInBuildSpace(orderedRegions(result.regions));
  const mtlName = `${resolved.stem}.mtl`;
  const header = [
    APPLICATION,
    `Title: ${resolved.title}`,
    `Designer: ${resolved.designer}`,
    `Created: ${isoTimestamp(resolved.created)}`,
    `${ATTRIBUTION}, ODbL 1.0`,
    `Scale 1:${result.stats.scaleDenominator}`,
    ...(resolved.source ? [`Source: ${sourceLine(resolved.source)}`] : []),
    "Units: millimetres, z up",
    // The provenance block every format carries, verbatim
    // (`common.provenanceEntries`, `[V3-P7-A10]`). It repeats two lines above
    // it on purpose: the block is looked for as a block.
    ...provenanceLines(result, resolved),
  ];

  const obj: string[] = [commentBlock(header), `mtllib ${mtlName}\n`];
  let vertexBase = 0;
  // In single-colour mode the file describes ONE object, so it carries the
  // boolean union rather than the partition: a reader handed six touching
  // shells imports six objects (`common.placeMerged`).
  const meshes: RegionMesh[] = isSingleObject(result)
    ? [{ ...placeMerged(result, placed), region: "base" }]
    : placed.regions;
  const groups: ObjGroup[] = isSingleObject(result)
    ? meshes.map(plainGroup)
    : withTints(meshes, result, placed.offset);

  for (const group of groups) {
    obj.push(`o ${group.name}\ng ${group.name}\nusemtl ${group.material}\n`);
    const p = group.positions;
    for (let i = 0; i + 2 < p.length; i += 3) {
      obj.push(
        `v ${fmtNum(p[i], VERTEX_DECIMALS)} ${fmtNum(p[i + 1], VERTEX_DECIMALS)} ` +
          `${fmtNum(p[i + 2], VERTEX_DECIMALS)}\n`,
      );
    }
    const idx = group.indices;
    const count = Math.floor(p.length / 3);
    for (let i = 0; i + 2 < idx.length; i += 3) {
      if (idx[i] >= count || idx[i + 1] >= count || idx[i + 2] >= count) {
        throw new Error(`${group.name}: triangle ${i / 3} references a vertex beyond ${count}`);
      }
      obj.push(`f ${vertexBase + idx[i] + 1} ${vertexBase + idx[i + 1] + 1} ${vertexBase + idx[i + 2] + 1}\n`);
    }
    vertexBase += count;
  }

  const mtl: string[] = [commentBlock(header.slice(0, 5))];
  const seen = new Set<string>();
  for (const group of groups) {
    if (seen.has(group.material)) continue;
    seen.add(group.material);
    const [r, g, b] = colorToUnit(group.colorHex);
    mtl.push(
      `newmtl ${group.material}\nKd ${fmtNum(r, 4)} ${fmtNum(g, 4)} ${fmtNum(b, 4)}\nKa 0 0 0\nKs 0 0 0\nd 1\nillum 1\n`,
    );
  }

  return [
    { name: `${resolved.stem}.obj`, mime: MIME_OBJ, bytes: new TextEncoder().encode(obj.join("")) },
    { name: mtlName, mime: MIME_MTL, bytes: new TextEncoder().encode(mtl.join("")) },
  ];
}

/** One region, one group, one material named after it: the pre-tint shape. */
function plainGroup(mesh: RegionMesh): ObjGroup {
  return {
    name: mesh.region,
    material: mesh.region,
    colorHex: mesh.colorHex,
    positions: mesh.positions,
    indices: mesh.indices,
  };
}

/**
 * The groups for a parts-mode file, with the buildings split by tint.
 *
 * `offset` is what `placeInBuildSpace` moved every vertex by, so a tint's plan
 * centroid (which is in ENGINE space) can be compared with a body's.
 */
function withTints(
  meshes: readonly RegionMesh[],
  result: EngineResult,
  offset: readonly number[],
): ObjGroup[] {
  const tints = result.buildingTints ?? [];
  if (tints.length === 0) return meshes.map(plainGroup);
  const buckets = bucketTints(tints, MAX_TINT_MATERIALS);
  const materials = new Map<string, string>();
  const out: ObjGroup[] = [];
  for (const mesh of meshes) {
    if (bandIndexOf(mesh.region) === null) {
      out.push(plainGroup(mesh));
      continue;
    }
    const bodies = splitBodies(mesh);
    if (bodies.length <= 1) {
      out.push(plainGroup(mesh));
      continue;
    }
    // One group per BODY, so a reader that imports objects gets one building
    // each, and one material per distinct bucketed shade.
    bodies.forEach((body, index) => {
      const hex = buckets.get(nearestTint(body.centroid, tints, offset)) ?? mesh.colorHex;
      let material = materials.get(hex);
      if (material === undefined) {
        material = `${mesh.region}_tint_${materials.size + 1}`;
        materials.set(hex, material);
      }
      out.push({
        name: `${mesh.region}_${index + 1}`,
        material,
        colorHex: hex,
        positions: body.positions,
        indices: body.indices,
      });
    });
  }
  return out;
}

/** The tint whose centroid is nearest this body, as its unbucketed hex. */
function nearestTint(
  centroid: [number, number],
  tints: readonly BuildingTint[],
  offset: readonly number[],
): string {
  let best = tints[0].colorHex;
  let bestDistance = Infinity;
  for (const tint of tints) {
    const dx = tint.centroidMm[0] + (offset[0] ?? 0) - centroid[0];
    const dy = tint.centroidMm[1] + (offset[1] ?? 0) - centroid[1];
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = tint.colorHex;
    }
  }
  return best;
}

interface MeshBody {
  positions: Float64Array;
  indices: Uint32Array;
  centroid: [number, number];
}

/**
 * A mesh's connected bodies, by shared vertex index.
 *
 * Union-find over the triangle list: two vertices are in the same body when a
 * triangle names both. The engine's meshes are indexed (manifold3d welds
 * coincident vertices), so index adjacency IS geometric connectivity and no
 * position comparison is needed.
 */
function splitBodies(mesh: RegionMesh): MeshBody[] {
  const vertexCount = Math.floor(mesh.positions.length / 3);
  if (vertexCount === 0) return [];
  const parent = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) parent[i] = i;
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    let walk = x;
    while (parent[walk] !== walk) {
      const next = parent[walk];
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const idx = mesh.indices;
  for (let i = 0; i + 2 < idx.length; i += 3) {
    union(idx[i], idx[i + 1]);
    union(idx[i + 1], idx[i + 2]);
  }

  const order = new Map<number, number>();
  const triangles: number[][] = [];
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const root = find(idx[i]);
    let slot = order.get(root);
    if (slot === undefined) {
      slot = triangles.length;
      order.set(root, slot);
      triangles.push([]);
    }
    triangles[slot].push(i);
  }

  return triangles.map((list) => {
    const remap = new Map<number, number>();
    const positions: number[] = [];
    const indices: number[] = [];
    let sumX = 0;
    let sumY = 0;
    for (const start of list) {
      for (let k = 0; k < 3; k += 1) {
        const vertex = idx[start + k];
        let mapped = remap.get(vertex);
        if (mapped === undefined) {
          mapped = positions.length / 3;
          remap.set(vertex, mapped);
          positions.push(
            mesh.positions[vertex * 3],
            mesh.positions[vertex * 3 + 1],
            mesh.positions[vertex * 3 + 2],
          );
          sumX += mesh.positions[vertex * 3];
          sumY += mesh.positions[vertex * 3 + 1];
        }
        indices.push(mapped);
      }
    }
    const vertices = positions.length / 3;
    return {
      positions: Float64Array.from(positions),
      indices: Uint32Array.from(indices),
      centroid: [sumX / vertices, sumY / vertices] as [number, number],
    };
  });
}
