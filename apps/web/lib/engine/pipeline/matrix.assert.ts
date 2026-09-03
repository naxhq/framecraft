/**
 * Readers for the V3-1 settings matrix: what a probe may look at on an
 * `EngineResult` (the preview side) and inside the bytes the export stage
 * wrote (the file side).
 *
 * Nothing here compares whole snapshots. Every reader answers one question a
 * probe can name ("how many triangles does the frame region carry", "what
 * extruder did the file give the water part", "what does project_settings.config
 * say the nozzle is"), because a matrix probe that can only say "the bytes
 * moved" is not evidence that the field did anything.
 *
 * Not a test file: `matrix.test.ts` imports it.
 */

import { MODEL_SETTINGS_PART, OBJECT_MODEL_PART, PROJECT_SETTINGS_PART } from "../export/bambu3mf";
import { CUSTOM_GCODE_PART } from "../export/colorchange";
import { MODEL_PART } from "../export/generic3mf";
import { STL_HEADER_BYTES, STL_TRIANGLE_BYTES } from "../export/stl";
import { findAll, parseXml, type XmlElement } from "../export/xmlParse";
import { unzipAll, unzipText } from "../export/zip";
import type {
  AuditFinding,
  Bbox3,
  EngineResult,
  ExportFile,
  RecessBand,
  RegionMesh,
  RegionName,
  ResolvedLine,
} from "../types";

// ---------------------------------------------------------------------------
// What a probe compares
// ---------------------------------------------------------------------------

/** One side of a probe: the result the pipeline built and the files it wrote. */
export interface Snapshot {
  result: EngineResult;
  files: ExportFile[];
  sidecar: Record<string, unknown>;
  /** The target the export stage resolved, echoed so a probe can name it. */
  target: string;
  notes: string[];
}

// ---------------------------------------------------------------------------
// The preview side: readers over EngineResult
// ---------------------------------------------------------------------------

export function regionOf(result: EngineResult, name: RegionName): RegionMesh | undefined {
  return result.regions.find((region) => region.region === name);
}

export function mustRegion(result: EngineResult, name: RegionName): RegionMesh {
  const found = regionOf(result, name);
  if (found === undefined) {
    throw new Error(`the result carries no ${name} region (it has ${result.regions.map((r) => r.region).join(", ")})`);
  }
  return found;
}

export function regionNames(result: EngineResult): RegionName[] {
  return result.regions.map((region) => region.region);
}

export function triangleCount(mesh: RegionMesh): number {
  return mesh.indices.length / 3;
}

/** `[x, y, z]` extent of a bounding box, millimetres. */
export function span(bbox: Bbox3): [number, number, number] {
  return [bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]];
}

export function findingOf(result: EngineResult, id: string): AuditFinding | undefined {
  return result.findings.find((finding) => finding.id === id);
}

export function resolvedLine(result: EngineResult, id: string): ResolvedLine | undefined {
  return result.resolvedText.find((line) => line.id === id);
}

export function recessBandsOf(result: EngineResult, region: RegionName, kind: RecessBand["kind"]): RecessBand[] {
  return (result.recessBands ?? []).filter((band) => band.region === region && band.kind === kind);
}

/** Where in plan a reader may look, so a probe can name one edge of the frame. */
export interface PlanWindow {
  /** Vertices with a smaller x are ignored. */
  xMin?: number;
  xMax?: number;
  yMin?: number;
  yMax?: number;
}

function inWindow(x: number, y: number, window: PlanWindow | undefined): boolean {
  if (window === undefined) return true;
  if (window.xMin !== undefined && x < window.xMin) return false;
  if (window.xMax !== undefined && x > window.xMax) return false;
  if (window.yMin !== undefined && y < window.yMin) return false;
  if (window.yMax !== undefined && y > window.yMax) return false;
  return true;
}

/** Plan extent `[minX, maxX, minY, maxY]` of the vertices at height `z`, or null. */
export function extentAtZ(positions: ArrayLike<number>, z: number, tol = 1e-6, window?: PlanWindow): [number, number, number, number] | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let seen = 0;
  for (let i = 0; i < positions.length; i += 3) {
    if (Math.abs(positions[i + 2] - z) > tol) continue;
    if (!inWindow(positions[i], positions[i + 1], window)) continue;
    seen += 1;
    minX = Math.min(minX, positions[i]);
    maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]);
    maxY = Math.max(maxY, positions[i + 1]);
  }
  return seen === 0 ? null : [minX, maxX, minY, maxY];
}

/**
 * The highest z the mesh reaches over one plan rectangle.
 *
 * What the `heights.*` probes use: the Overpass fixture puts each building type
 * on its own 46 m square, so the roof over THAT square is the height the rule
 * for THAT type produced, and the roof over another square is the control.
 */
export function maxZOverFootprint(positions: ArrayLike<number>, x0: number, x1: number, y0: number, y1: number): number | null {
  let top: number | null = null;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    const z = positions[i + 2];
    if (top === null || z > top) top = z;
  }
  return top;
}

/**
 * The largest `x + y` any vertex reaches: how far the outer corner of a
 * rectangular ring stands out along its diagonal. A corner fillet of radius `r`
 * pulls it back by exactly `r * (2 - sqrt(2))`, which is what makes it the one
 * number a corner-radius probe can name.
 */
export function maxXPlusY(positions: ArrayLike<number>): number {
  let best = -Infinity;
  for (let i = 0; i < positions.length; i += 3) best = Math.max(best, positions[i] + positions[i + 1]);
  return best;
}

/** Vertices of `region` whose Z is within `tol` of `z`. */
export function verticesAtZ(mesh: RegionMesh, z: number, tol = 1e-6): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    if (Math.abs(mesh.positions[i + 2] - z) <= tol) out.push([mesh.positions[i], mesh.positions[i + 1]]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The file side: the Bambu project the default target writes
// ---------------------------------------------------------------------------

/** The one `.3mf` a probe's default export produced. */
export function onlyFile(files: readonly ExportFile[], suffix: string): ExportFile {
  const matched = files.filter((file) => file.name.endsWith(suffix));
  if (matched.length !== 1) {
    throw new Error(`expected exactly one ${suffix} file, got ${files.map((f) => f.name).join(", ") || "none"}`);
  }
  return matched[0];
}

export function fileNames(files: readonly ExportFile[]): string[] {
  return files.map((file) => file.name);
}

/** Every part name inside a zip, in write order. */
export function zipNames(bytes: Uint8Array): string[] {
  return [...unzipAll(bytes).keys()];
}

/**
 * One region as the written 3MF carries it: its mesh, its extruder, its bounds
 * and the volume its own triangles enclose.
 *
 * `volumeMm3` is computed from the FILE's triangle soup by the divergence sum,
 * never copied off the `EngineResult`: a probe that changes the shape of a
 * pocket without changing the triangle count (a wider magnet, a deeper
 * engraving) has nothing else in the file to point at.
 */
export interface FilePart {
  id: string;
  region: string;
  extruder: number;
  vertices: number;
  triangles: number;
  bbox: Bbox3;
  volumeMm3: number;
  positions: Float64Array;
  indices: Uint32Array;
}

interface ParsedMesh {
  positions: Float64Array;
  indices: Uint32Array;
}

function meshOfObject(object: XmlElement): ParsedMesh {
  const vertices = findAll(object, "vertex");
  const triangles = findAll(object, "triangle");
  const positions = new Float64Array(vertices.length * 3);
  vertices.forEach((vertex, index) => {
    positions[index * 3] = Number(vertex.attributes.x);
    positions[index * 3 + 1] = Number(vertex.attributes.y);
    positions[index * 3 + 2] = Number(vertex.attributes.z);
  });
  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach((triangle, index) => {
    indices[index * 3] = Number(triangle.attributes.v1);
    indices[index * 3 + 1] = Number(triangle.attributes.v2);
    indices[index * 3 + 2] = Number(triangle.attributes.v3);
  });
  return { positions, indices };
}

function bboxOfMesh(mesh: ParsedMesh): Bbox3 {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], mesh.positions[i + axis]);
      max[axis] = Math.max(max[axis], mesh.positions[i + axis]);
    }
  }
  return { min, max };
}

/** Volume a closed triangle soup encloses, mm3, by the signed tetrahedron sum. */
export function meshVolume(positions: ArrayLike<number>, indices: ArrayLike<number>): number {
  let sum = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const ax = positions[a];
    const ay = positions[a + 1];
    const az = positions[a + 2];
    const bx = positions[b];
    const by = positions[b + 1];
    const bz = positions[b + 2];
    const cx = positions[c];
    const cy = positions[c + 1];
    const cz = positions[c + 2];
    sum += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return sum / 6;
}

/** Plan extent `[minX, maxX, minY, maxY]` of a written part's vertices at height `z`. */
export function partExtentAtZ(part: FilePart, z: number, tol = 1e-6, window?: PlanWindow): [number, number, number, number] | null {
  return extentAtZ(part.positions, z, tol, window);
}

/**
 * `region -> FilePart` read out of the Bambu project's own two documents: the
 * sub-model (`3D/Objects/object_1.model`) carries the meshes, and
 * `Metadata/model_settings.config` names each part and its extruder. Nothing
 * comes from the `EngineResult`, so a probe that reads this is reading the file.
 */
export function bambuParts(files: readonly ExportFile[]): Map<string, FilePart> {
  return bambuPartsOf(onlyFile(files, ".3mf").bytes);
}

/**
 * The same table from raw 3MF bytes, which is how a TILE is read: a tiled build
 * writes a zip of per-tile 3MFs, so the tile's own project comes out of
 * `zipEntry` and goes straight in here.
 */
export function bambuPartsOf(bytes: Uint8Array): Map<string, FilePart> {
  const settings = parseXml(unzipText(bytes, MODEL_SETTINGS_PART));
  const objects = parseXml(unzipText(bytes, OBJECT_MODEL_PART));
  const meshes = new Map<string, XmlElement>();
  for (const object of findAll(objects, "object")) meshes.set(object.attributes.id, object);
  const out = new Map<string, FilePart>();
  for (const part of findAll(settings, "part")) {
    const meta = new Map(findAll(part, "metadata").map((entry) => [entry.attributes.key, entry.attributes.value]));
    const id = part.attributes.id;
    const object = meshes.get(id);
    if (object === undefined) throw new Error(`model_settings names part ${id} but the sub-model has no such object`);
    const mesh = meshOfObject(object);
    out.set(meta.get("name") ?? id, {
      id,
      region: meta.get("name") ?? id,
      extruder: Number(meta.get("extruder") ?? "0"),
      vertices: mesh.positions.length / 3,
      triangles: mesh.indices.length / 3,
      bbox: bboxOfMesh(mesh),
      volumeMm3: meshVolume(mesh.positions, mesh.indices),
      positions: mesh.positions,
      indices: mesh.indices,
    });
  }
  return out;
}

export function mustPart(files: readonly ExportFile[], region: string): FilePart {
  const parts = bambuParts(files);
  const found = parts.get(region);
  if (found === undefined) {
    throw new Error(`the written 3MF has no ${region} part (it has ${[...parts.keys()].join(", ")})`);
  }
  return found;
}

/** `project_settings.config`, the block Bambu Studio reads its machine from. */
export function bambuProject(files: readonly ExportFile[]): Record<string, string | string[]> {
  const bytes = onlyFile(files, ".3mf").bytes;
  return JSON.parse(unzipText(bytes, PROJECT_SETTINGS_PART)) as Record<string, string | string[]>;
}

/** `<metadata name=...>` of the Bambu project's main model document. */
export function bambuMetadata(files: readonly ExportFile[]): Map<string, string> {
  const bytes = onlyFile(files, ".3mf").bytes;
  const main = parseXml(unzipText(bytes, MODEL_PART));
  return new Map(findAll(main, "metadata").map((entry) => [entry.attributes.name, entry.text]));
}

/** The `<item>` build placements of the main model: one per plate. */
export function bambuBuildItems(files: readonly ExportFile[]): Array<Record<string, string>> {
  const bytes = onlyFile(files, ".3mf").bytes;
  const main = parseXml(unzipText(bytes, MODEL_PART));
  return findAll(main, "item").map((item) => item.attributes);
}

/** `custom_gcode_per_layer.xml` rows: `[top_z, colour, extruder, gcode]` per change. */
export function colorChangeLayers(files: readonly ExportFile[]): Array<{ topZ: string; color: string; extruder: string; gcode: string }> {
  const bytes = onlyFile(files, ".3mf").bytes;
  const gcode = parseXml(unzipText(bytes, CUSTOM_GCODE_PART));
  return findAll(gcode, "layer").map((layer) => ({
    topZ: layer.attributes.top_z,
    color: layer.attributes.color,
    extruder: layer.attributes.extruder,
    gcode: layer.attributes.gcode ?? "",
  }));
}

// ---------------------------------------------------------------------------
// The other targets
// ---------------------------------------------------------------------------

/** Object ids of a generic 3MF, and the `<base>` colours of its `<basematerials>`. */
export function generic3mf(files: readonly ExportFile[]): {
  objects: string[];
  materials: Array<{ name: string; color: string }>;
  metadata: Map<string, string>;
  vertices: number;
  triangles: number;
} {
  const bytes = onlyFile(files, ".3mf").bytes;
  const model = parseXml(unzipText(bytes, MODEL_PART));
  return {
    objects: findAll(model, "object").map((object) => object.attributes.id),
    materials: findAll(model, "base").map((base) => ({ name: base.attributes.name, color: base.attributes.displaycolor })),
    metadata: new Map(findAll(model, "metadata").map((entry) => [entry.attributes.name, entry.text])),
    vertices: findAll(model, "vertex").length,
    triangles: findAll(model, "triangle").length,
  };
}

/** Triangle count of a binary STL, read from its own header. */
export function stlTriangles(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(STL_HEADER_BYTES, true);
}

/** Bounding box of a binary STL, read from its facets. */
export function stlBbox(bytes: Uint8Array): Bbox3 {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const triangles = stlTriangles(bytes);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < triangles; t += 1) {
    const offset = STL_HEADER_BYTES + 4 + t * STL_TRIANGLE_BYTES + 12;
    for (let v = 0; v < 3; v += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = view.getFloat32(offset + v * 12 + axis * 4, true);
        min[axis] = Math.min(min[axis], value);
        max[axis] = Math.max(max[axis], value);
      }
    }
  }
  return { min, max };
}

/** `o <name>` groups of an OBJ file, in write order. */
export function objGroups(files: readonly ExportFile[]): string[] {
  const obj = onlyFile(files, ".obj");
  return new TextDecoder()
    .decode(obj.bytes)
    .split("\n")
    .filter((line) => line.startsWith("o "))
    .map((line) => line.slice(2).trim());
}

/** `newmtl` names of the MTL file beside an OBJ. */
export function mtlNames(files: readonly ExportFile[]): string[] {
  const mtl = onlyFile(files, ".mtl");
  return new TextDecoder()
    .decode(mtl.bytes)
    .split("\n")
    .filter((line) => line.startsWith("newmtl "))
    .map((line) => line.slice(7).trim());
}

/** `MANIFOLD_SOLID_BREP` entity count of a STEP file: one per exported shell. */
export function stepShells(files: readonly ExportFile[]): number {
  const step = onlyFile(files, ".step");
  return new TextDecoder().decode(step.bytes).split("MANIFOLD_SOLID_BREP").length - 1;
}

/** Raw bytes of one entry of a zip, for a target that nests files. */
export function zipEntry(bytes: Uint8Array, name: string): Uint8Array {
  const entry = unzipAll(bytes).get(name);
  if (entry === undefined) throw new Error(`the zip has no ${name} (it has ${[...unzipAll(bytes).keys()].join(", ")})`);
  return entry;
}

// ---------------------------------------------------------------------------
// The sidecar
// ---------------------------------------------------------------------------

function walk(value: unknown, path: readonly string[]): unknown {
  let cursor: unknown = value;
  for (const step of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[step];
  }
  return cursor;
}

/** One dotted path out of the sidecar, as a number; throws when it is not one. */
export function sidecarNumber(sidecar: Record<string, unknown>, path: string): number {
  const value = walk(sidecar, path.split("."));
  if (typeof value !== "number") throw new Error(`sidecar ${path} is ${JSON.stringify(value)}, not a number`);
  return value;
}

export function sidecarString(sidecar: Record<string, unknown>, path: string): string {
  const value = walk(sidecar, path.split("."));
  if (typeof value !== "string") throw new Error(`sidecar ${path} is ${JSON.stringify(value)}, not a string`);
  return value;
}

export function sidecarValue(sidecar: Record<string, unknown>, path: string): unknown {
  return walk(sidecar, path.split("."));
}

export interface SidecarRegionRow {
  region: string;
  slot: number;
  color: string;
  triangles: number;
  bodies: number;
  volume_mm3: number;
}

/** The per-region table `make validate` reads out of the sidecar. */
export function sidecarRegions(sidecar: Record<string, unknown>): Map<string, SidecarRegionRow> {
  const rows = walk(sidecar, ["bake_result", "stats", "regions"]);
  if (!Array.isArray(rows)) throw new Error("the sidecar carries no bake_result.stats.regions array");
  return new Map((rows as SidecarRegionRow[]).map((row) => [row.region, row]));
}

export function sidecarWarnings(sidecar: Record<string, unknown>): string[] {
  const warnings = walk(sidecar, ["bake_result", "warnings"]);
  return Array.isArray(warnings) ? (warnings as string[]) : [];
}
