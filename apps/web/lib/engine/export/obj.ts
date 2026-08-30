// Wavefront OBJ with one `o`/`g` group per region and a companion MTL whose
// `Kd` is the region colour. Vertex indices are global and 1-based; the
// header comments carry the same metadata as the 3MF.

import type { EngineResult, ExportFile, RegionMesh } from "../types";
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
  ];

  const obj: string[] = [commentBlock(header), `mtllib ${mtlName}\n`];
  let vertexBase = 0;
  // In single-colour mode the file describes ONE object, so it carries the
  // boolean union rather than the partition: a reader handed six touching
  // shells imports six objects (`common.placeMerged`).
  const groups: RegionMesh[] = isSingleObject(result)
    ? [{ ...placeMerged(result, placed), region: "base" }]
    : placed.regions;
  for (const region of groups) {
    obj.push(`o ${region.region}\ng ${region.region}\nusemtl ${region.region}\n`);
    const p = region.positions;
    for (let i = 0; i + 2 < p.length; i += 3) {
      obj.push(
        `v ${fmtNum(p[i], VERTEX_DECIMALS)} ${fmtNum(p[i + 1], VERTEX_DECIMALS)} ` +
          `${fmtNum(p[i + 2], VERTEX_DECIMALS)}\n`,
      );
    }
    const idx = region.indices;
    const count = Math.floor(p.length / 3);
    for (let i = 0; i + 2 < idx.length; i += 3) {
      if (idx[i] >= count || idx[i + 1] >= count || idx[i + 2] >= count) {
        throw new Error(`${region.region}: triangle ${i / 3} references a vertex beyond ${count}`);
      }
      obj.push(`f ${vertexBase + idx[i] + 1} ${vertexBase + idx[i + 1] + 1} ${vertexBase + idx[i + 2] + 1}\n`);
    }
    vertexBase += count;
  }

  const mtl: string[] = [commentBlock(header.slice(0, 5))];
  const seen = new Set<string>();
  for (const region of groups) {
    if (seen.has(region.region)) continue;
    seen.add(region.region);
    const [r, g, b] = colorToUnit(region.colorHex);
    mtl.push(
      `newmtl ${region.region}\nKd ${fmtNum(r, 4)} ${fmtNum(g, 4)} ${fmtNum(b, 4)}\nKa 0 0 0\nKs 0 0 0\nd 1\nillum 1\n`,
    );
  }

  return [
    { name: `${resolved.stem}.obj`, mime: MIME_OBJ, bytes: new TextEncoder().encode(obj.join("")) },
    { name: mtlName, mime: MIME_MTL, bytes: new TextEncoder().encode(mtl.join("")) },
  ];
}
