// Binary STL: one body with every region concatenated, or one file per
// region zipped together. 84 header bytes plus 50 per triangle, little
// endian, facet normals computed from the winding (zero for a degenerate
// triangle), attribute byte count 0.

import { hardenForFloat32, type HardenReport, type Mesh } from "../solid/mesh";
import type { AuditFinding, EngineResult, ExportFile, RegionMesh } from "../types";
import { APPLICATION, ATTRIBUTION, orderedRegions, placeInBuildSpace, placeMerged, resolveOptions, type ExportOptions } from "./common";
import { zipEntries, type ZipEntry } from "./zip";

export const MIME_STL = "model/stl";
export const MIME_ZIP = "application/zip";
export const STL_HEADER_BYTES = 80;
export const STL_TRIANGLE_BYTES = 50;

export function stlHeaderText(title: string): string {
  // ASCII only (the copyright sign would be two bytes) and never starting
  // with "solid", which some readers take as the ASCII flavour. The version
  // comes from `common.APPLICATION` rather than being typed again here: this
  // header repeated the literal "FrameCraft 3.0.0" and was the second place a
  // release bump had to remember to visit.
  const text = `${APPLICATION} | (c) OpenStreetMap contributors | ${title}`.replace(/[^\x20-\x7E]/g, "?");
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

/**
 * The mesh this format can carry, in the frame it is written in.
 *
 * A binary STL is float32 and has no vertex index, so its topology is whatever
 * its coordinates say once a reader welds the identical ones (which is exactly
 * what `services/bake/app/cli.py` does before judging the file). Two things
 * survive the double-precision mesh and not the file: a triangle whose vertices
 * are collinear to within a float32 step, which measures zero area and fails
 * `degenerate_faces`, and two distinct vertices on one grid point, whose weld
 * hands an edge to four faces and fails `manifold`, `watertight` and
 * `self_intersection`. `mesh.hardenForFloat32` removes the first and separates
 * the second.
 *
 * It runs HERE, on the placed mesh, and not in the engine, because the grid is
 * a property of the coordinate and `placeInBuildSpace` moves every coordinate:
 * the Chicago needle sits at x = -0.033 mm in the engine frame, where the grid
 * step is 4e-9 mm and nothing collapses, and at x = 89.967 mm in build space,
 * where it is 7.6e-6 mm and the triangle vanishes. The 3MF of the same mesh is
 * untouched and stays byte for byte what it was: it writes decimal text at
 * twelve places, where that triangle measures 6.184e-7 mm^2 and passes.
 */
function forStl(mesh: Mesh): { mesh: Mesh; report: HardenReport } {
  return hardenForFloat32(mesh);
}

/** An STL, plus what the format could not carry. `findings` is empty for a clean write. */
export interface StlExportFile extends ExportFile {
  findings: AuditFinding[];
}

export const FLOAT32_FINDING_ID = "float32-degenerate";

/**
 * What the file lost, said out loud.
 *
 * 04 stage 4 says "on failure, do not silently ship", and the repair above is
 * BEST EFFORT: `cleanMesh` hands back the input untouched whenever no rung
 * strictly improves the count, which is exactly what the largest legal plate
 * does (`plate_mm` 256, `contracts.PARAM_RANGES`: 12 faces the float32 file
 * cannot carry and 6 the double mesh already fails on, a known limitation
 * recorded in `DECISIONS.md [V3-P7-A11]` and `[V3-P7-fix-6]`). Before this the
 * writer threw the report away and the file went out with no word anywhere.
 *
 * A WARNING and not an error, and deliberately not a gate row: the reference
 * validator already fails these files on `degenerate_faces`, so the engine's
 * job here is to say so before the user finds out from `make validate`, not to
 * judge them twice. `export/gate.ts`'s `STAGE_4_FINDING_IDS` is untouched.
 */
export function float32Findings(report: HardenReport, target: string): AuditFinding[] {
  const left = report.degenerate;
  const lost = report.collisions;
  const stuck = report.pinches.unresolved + report.pinches.rejected;
  if (left === 0 && lost === 0 && stuck === 0) return [];
  const parts: string[] = [];
  if (left > 0) {
    const cleared = report.degenerateBefore - left;
    parts.push(
      `${left} face(s) measure under 1e-9 mm2 once the coordinates are on the float32 grid a ` +
        `binary STL writes` +
        (cleared > 0
          ? ` (${report.degenerateBefore} before the repair, which cleared ${cleared})`
          : ", and the repair could not clear any of them"),
    );
  }
  if (lost > 0) {
    parts.push(
      `${lost} vertex/vertices share a grid point with another, so a reader that welds the ` +
        "coordinates back into an index will hand an edge to more than two faces",
    );
  }
  if (stuck > 0) {
    parts.push(
      `${report.pinches.rejected} separation(s) were rolled back by the acceptance test and ` +
        `${report.pinches.unresolved} found no free grid point`,
    );
  }
  return [
    {
      id: FLOAT32_FINDING_ID,
      severity: "warning",
      title: `The ${target} file cannot carry every face of this model`,
      detail:
        `${parts.join("; ")}. The reference validator will fail this file on its ` +
        "degenerate_faces row. The 3MF and OBJ writers keep decimal text and are not affected; " +
        "a smaller plate is what removes the faces at source.",
    },
  ];
}

/** One binary STL of every region, placed in build space. */
export function exportStl(result: EngineResult, options: ExportOptions = {}): StlExportFile {
  const resolved = resolveOptions(result, options);
  const placed = placeInBuildSpace(orderedRegions(result.regions));
  // The boolean union, not a concatenation: an STL has no notion of parts, so
  // a concatenated partition would read as one shell per region.
  const merged = placeMerged(result, placed);
  const written = forStl({ positions: merged.positions, indices: merged.indices });
  return {
    name: `${resolved.stem}.stl`,
    mime: MIME_STL,
    bytes: stlBinary(written.mesh.positions, written.mesh.indices, stlHeaderText(resolved.title)),
    findings: float32Findings(written.report, "STL"),
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
export function exportStlPartsZip(result: EngineResult, options: ExportOptions = {}): StlExportFile {
  const resolved = resolveOptions(result, options);
  const placed = placeInBuildSpace(orderedRegions(result.regions));
  const findings: AuditFinding[] = [];
  const entries: ZipEntry[] = placed.regions.map((region, index) => {
    // Every member is a binary STL in its own right and is read back the same
    // way, so each one is hardened exactly as the single body above is.
    const written = forStl({ positions: region.positions, indices: region.indices });
    // One finding for the zip, naming the first member that lost something:
    // six copies of the same sentence is noise, not information.
    if (findings.length === 0) findings.push(...float32Findings(written.report, `STL part ${region.region}`));
    return {
      name: regionStlName(resolved.stem, region, index),
      data: stlBinary(written.mesh.positions, written.mesh.indices, stlHeaderText(`${resolved.title} ${region.region}`)),
      method: "deflate" as const,
    };
  });
  entries.push({ name: "CREDITS.txt", data: CREDITS_TEXT, method: "deflate" });
  return {
    name: `${resolved.stem}-parts.zip`,
    mime: MIME_ZIP,
    bytes: zipEntries(entries, { mtime: resolved.created }),
    findings,
  };
}
