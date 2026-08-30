// Binary STL: one body with every region concatenated, or one file per
// region zipped together. 84 header bytes plus 50 per triangle, little
// endian, facet normals computed from the winding (zero for a degenerate
// triangle), attribute byte count 0.

import type { EngineResult, ExportFile, RegionMesh } from "../types";
import { ATTRIBUTION, orderedRegions, placeInBuildSpace, placeMerged, resolveOptions, type ExportOptions } from "./common";
import { zipEntries, type ZipEntry } from "./zip";

export const MIME_STL = "model/stl";
export const MIME_ZIP = "application/zip";
export const STL_HEADER_BYTES = 80;
export const STL_TRIANGLE_BYTES = 50;

export function stlHeaderText(title: string): string {
  // ASCII only (the copyright sign would be two bytes) and never starting
  // with "solid", which some readers take as the ASCII flavour.
  const text = `FrameCraft 3.0.0 | (c) OpenStreetMap contributors | ${title}`.replace(/[^\x20-\x7E]/g, "?");
  return text.length > STL_HEADER_BYTES ? text.slice(0, STL_HEADER_BYTES) : text;
}

export function stlBinary(positions: ArrayLike<number>, indices: ArrayLike<number>, header: string): Uint8Array {
  const triangles = Math.floor(indices.length / 3);
  const bytes = new Uint8Array(STL_HEADER_BYTES + 4 + triangles * STL_TRIANGLE_BYTES);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < Math.min(header.length, STL_HEADER_BYTES); i += 1) {
    bytes[i] = header.charCodeAt(i) & 0x7f;
  }
  view.setUint32(STL_HEADER_BYTES, triangles, true);
  let offset = STL_HEADER_BYTES + 4;
  const vertexCount = Math.floor(positions.length / 3);
  for (let t = 0; t < triangles; t += 1) {
    const a = indices[t * 3];
    const b = indices[t * 3 + 1];
    const c = indices[t * 3 + 2];
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) {
      throw new Error(`triangle ${t} references a vertex beyond ${vertexCount}`);
    }
    const ax = positions[a * 3];
    const ay = positions[a * 3 + 1];
    const az = positions[a * 3 + 2];
    const bx = positions[b * 3];
    const by = positions[b * 3 + 1];
    const bz = positions[b * 3 + 2];
    const cx = positions[c * 3];
    const cy = positions[c * 3 + 1];
    const cz = positions[c * 3 + 2];
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      nx /= len;
      ny /= len;
      nz /= len;
    } else {
      nx = 0;
      ny = 0;
      nz = 0;
    }
    view.setFloat32(offset, nx, true);
    view.setFloat32(offset + 4, ny, true);
    view.setFloat32(offset + 8, nz, true);
    view.setFloat32(offset + 12, ax, true);
    view.setFloat32(offset + 16, ay, true);
    view.setFloat32(offset + 20, az, true);
    view.setFloat32(offset + 24, bx, true);
    view.setFloat32(offset + 28, by, true);
    view.setFloat32(offset + 32, bz, true);
    view.setFloat32(offset + 36, cx, true);
    view.setFloat32(offset + 40, cy, true);
    view.setFloat32(offset + 44, cz, true);
    view.setUint16(offset + 48, 0, true);
    offset += STL_TRIANGLE_BYTES;
  }
  return bytes;
}

/** One binary STL of every region, placed in build space. */
export function exportStl(result: EngineResult, options: ExportOptions = {}): ExportFile {
  const resolved = resolveOptions(result, options);
  const placed = placeInBuildSpace(orderedRegions(result.regions));
  // The boolean union, not a concatenation: an STL has no notion of parts, so
  // a concatenated partition would read as one shell per region.
  const merged = placeMerged(result, placed);
  return {
    name: `${resolved.stem}.stl`,
    mime: MIME_STL,
    bytes: stlBinary(merged.positions, merged.indices, stlHeaderText(resolved.title)),
  };
}

export const CREDITS_TEXT =
  `${ATTRIBUTION}, ODbL; produced work by FrameCraft\n\n` +
  "Map data in this model comes from OpenStreetMap and is licensed under the\n" +
  "Open Database License 1.0 (https://opendatacommons.org/licenses/odbl/).\n" +
  "The printed model is a Produced Work under that licence; keep this notice\n" +
  'with the files and credit "' +
  ATTRIBUTION +
  '" wherever the model or a\n' +
  "photograph of it is published.\n";

export function regionStlName(stem: string, region: RegionMesh, index: number): string {
  return `${stem}-${String(index + 1).padStart(2, "0")}-${region.region}-slot${region.slot}.stl`;
}

/** A zip with one binary STL per region (same placement as the single body) plus CREDITS.txt. */
export function exportStlPartsZip(result: EngineResult, options: ExportOptions = {}): ExportFile {
  const resolved = resolveOptions(result, options);
  const placed = placeInBuildSpace(orderedRegions(result.regions));
  const entries: ZipEntry[] = placed.regions.map((region, index) => ({
    name: regionStlName(resolved.stem, region, index),
    data: stlBinary(region.positions, region.indices, stlHeaderText(`${resolved.title} ${region.region}`)),
    method: "deflate" as const,
  }));
  entries.push({ name: "CREDITS.txt", data: CREDITS_TEXT, method: "deflate" });
  return {
    name: `${resolved.stem}-parts.zip`,
    mime: MIME_ZIP,
    bytes: zipEntries(entries, { mtime: resolved.created }),
  };
}
