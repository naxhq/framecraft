// STEP AP214 faceted B-rep (DECISIONS [V3-A6]): every triangle becomes a
// planar ADVANCED_FACE bounded by an EDGE_LOOP of ORIENTED_EDGEs over shared
// EDGE_CURVEs on LINEs between shared VERTEX_POINTs; one CLOSED_SHELL and
// MANIFOLD_SOLID_BREP per region, each under its own PRODUCT so a CAD tool
// lists "buildings", "water" and so on. Vertices are welded per region by
// exact coordinate so the shell is topologically closed; edges are shared
// between the two faces that use them.
//
// A mesh model has no analytic surfaces, so this is the honest STEP for it,
// and it is large: about ten entities per triangle. Above `triangleWarnLimit`
// (50 000 by default) the export still happens but carries a note.
//
// Coordinates are written at `VERTEX_DECIMALS` (twelve places), the same grid
// the 3MF writes and the reference validator judges clean. They were written
// at six, and at six the writer lost exactly the faces the float32 STL loses
// at plate 256 (v3-07 geometry audit finding 8): a needle whose vertices are
// 1e-5 mm apart is real geometry at twelve places and one point at six. The
// vertex weld is keyed by the WRITTEN text rather than the double, so the shell
// is closed on the grid the reader sees, and a face that measures under 04's
// 1e-9 mm^2 once its corners are on that grid is left out and counted
// (`StepExportFile.gridLostTriangles`), never written as a sliver the reader
// has to guess at.

import type { EngineResult, ExportFile, RegionMesh } from "../types";
import { DEGENERATE_AREA_MM2 } from "../solid/mesh";
import {
  APPLICATION,
  ATTRIBUTION,
  VERTEX_DECIMALS,
  isoTimestamp,
  isSingleObject,
  orderedRegions,
  placeInBuildSpace,
  placeMerged,
  resolveOptions,
  provenanceLines,
  sourceLine,
  triangleCount,
  type ExportOptions,
} from "./common";
import { fmtNum } from "./xml";

export const MIME_STEP = "model/step";
export const STEP_TRIANGLE_WARN_LIMIT = 50_000;

export interface StepOptions extends ExportOptions {
  /** Triangle count above which a size note is returned; defaults to 50 000. */
  triangleWarnLimit?: number;
}

export interface StepExportFile extends ExportFile {
  notes: string[];
  entities: number;
  /** Degenerate (zero-area) triangles left out of the shells. */
  skippedTriangles: number;
  /**
   * Triangles that measure at least 04's 1e-9 mm^2 in the double mesh and
   * under it once their corners are on the written grid. Left out of the
   * shells like the zero-area ones, and said out loud in `notes`.
   */
  gridLostTriangles: number;
}

/**
 * A STEP real: fixed point, always with a decimal point, at the same twelve
 * places the 3MF writes (`common.VERTEX_DECIMALS`).
 */
export function fmtStep(value: number): string {
  const text = fmtNum(value, VERTEX_DECIMALS);
  return text.indexOf(".") >= 0 ? text : `${text}.`;
}

/** A STEP string literal body: quotes doubled, backslashes doubled, non-ASCII as \X2\ runs. */
export function stepString(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "'") out += "''";
    else if (ch === "\\") out += "\\\\";
    else if (code >= 0x20 && code < 0x7f) out += ch;
    else if (code <= 0xffff) out += `\\X2\\${code.toString(16).toUpperCase().padStart(4, "0")}\\X0\\`;
    else out += `\\X4\\${code.toString(16).toUpperCase().padStart(8, "0")}\\X0\\`;
  }
  return `'${out}'`;
}

class StepWriter {
  private next = 1;
  readonly lines: string[] = [];

  add(body: string): number {
    const id = this.next;
    this.next += 1;
    this.lines.push(`#${id}=${body};`);
    return id;
  }

  get count(): number {
    return this.next - 1;
  }
}

interface RegionShell {
  shellId: number;
  skipped: number;
  gridLost: number;
}

function writeShell(w: StepWriter, region: RegionMesh): RegionShell {
  const source = region.positions;
  const vertexCount = Math.floor(source.length / 3);
  // Every coordinate as the reader will get it back: the geometry below (the
  // weld, the plane normals, the degenerate test) is computed on the WRITTEN
  // grid, so what the file says about itself is what it holds.
  const p = new Float64Array(source.length);
  const text: string[] = new Array(source.length);
  for (let i = 0; i < source.length; i += 1) {
    text[i] = fmtStep(source[i]);
    p[i] = Number(text[i]);
  }
  // Weld by written coordinate so a shared corner is one VERTEX_POINT.
  const weld = new Int32Array(vertexCount);
  const pointIds: number[] = [];
  const vertexIds: number[] = [];
  const byKey = new Map<string, number>();
  for (let i = 0; i < vertexCount; i += 1) {
    const key = `${text[i * 3]},${text[i * 3 + 1]},${text[i * 3 + 2]}`;
    let welded = byKey.get(key);
    if (welded === undefined) {
      welded = pointIds.length;
      byKey.set(key, welded);
      const cp = w.add(`CARTESIAN_POINT('',(${text[i * 3]},${text[i * 3 + 1]},${text[i * 3 + 2]}))`);
      pointIds.push(cp);
      vertexIds.push(w.add(`VERTEX_POINT('',#${cp})`));
    }
    weld[i] = welded;
  }

  const edgeIds = new Map<string, number>();
  const edgeFor = (a: number, b: number): { id: number; forward: boolean } => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo}_${hi}`;
    let id = edgeIds.get(key);
    if (id === undefined) {
      const dx = p[hi * 3] - p[lo * 3];
      const dy = p[hi * 3 + 1] - p[lo * 3 + 1];
      const dz = p[hi * 3 + 2] - p[lo * 3 + 2];
      const len = Math.hypot(dx, dy, dz) || 1;
      const dir = w.add(`DIRECTION('',(${fmtStep(dx / len)},${fmtStep(dy / len)},${fmtStep(dz / len)}))`);
      const vec = w.add(`VECTOR('',#${dir},1.)`);
      const line = w.add(`LINE('',#${pointIds[lo]},#${vec})`);
      id = w.add(`EDGE_CURVE('',#${vertexIds[lo]},#${vertexIds[hi]},#${line},.T.)`);
      edgeIds.set(key, id);
    }
    return { id, forward: a === lo };
  };

  const faceIds: number[] = [];
  let skipped = 0;
  let gridLost = 0;
  const idx = region.indices;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const ia = idx[t];
    const ib = idx[t + 1];
    const ic = idx[t + 2];
    if (ia >= vertexCount || ib >= vertexCount || ic >= vertexCount) {
      throw new Error(`${region.region}: triangle ${t / 3} references a vertex beyond ${vertexCount}`);
    }
    const a = weld[ia];
    const b = weld[ib];
    const c = weld[ic];
    if (a === b || b === c || a === c) {
      skipped += 1;
      continue;
    }
    const ux = p[ib * 3] - p[ia * 3];
    const uy = p[ib * 3 + 1] - p[ia * 3 + 1];
    const uz = p[ib * 3 + 2] - p[ia * 3 + 2];
    const vx = p[ic * 3] - p[ia * 3];
    const vy = p[ic * 3 + 1] - p[ia * 3 + 1];
    const vz = p[ic * 3 + 2] - p[ia * 3 + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const nlen = Math.hypot(nx, ny, nz);
    const ulen = Math.hypot(ux, uy, uz);
    if (nlen === 0 || ulen === 0) {
      skipped += 1;
      continue;
    }
    // Under 04's threshold on the written grid. A face that was under it in
    // the double mesh too is a plain skip; one the grid alone collapsed is
    // counted apart, because that is the file's own loss and the note says so.
    if (nlen / 2 < DEGENERATE_AREA_MM2) {
      if (doubleArea(source, ia, ib, ic) < DEGENERATE_AREA_MM2) skipped += 1;
      else gridLost += 1;
      continue;
    }
    const normal = w.add(`DIRECTION('',(${fmtStep(nx / nlen)},${fmtStep(ny / nlen)},${fmtStep(nz / nlen)}))`);
    const ref = w.add(`DIRECTION('',(${fmtStep(ux / ulen)},${fmtStep(uy / ulen)},${fmtStep(uz / ulen)}))`);
    const axis = w.add(`AXIS2_PLACEMENT_3D('',#${pointIds[a]},#${normal},#${ref})`);
    const plane = w.add(`PLANE('',#${axis})`);
    const oriented: number[] = [];
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const edge = edgeFor(from, to);
      oriented.push(w.add(`ORIENTED_EDGE('',*,*,#${edge.id},${edge.forward ? ".T." : ".F."})`));
    }
    const loop = w.add(`EDGE_LOOP('',(${oriented.map((id) => `#${id}`).join(",")}))`);
    const bound = w.add(`FACE_OUTER_BOUND('',#${loop},.T.)`);
    faceIds.push(w.add(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`));
  }
  if (faceIds.length === 0) {
    throw new Error(`${region.region}: no non-degenerate triangles to build a shell from`);
  }
  const shellId = w.add(`CLOSED_SHELL('',(${faceIds.map((id) => `#${id}`).join(",")}))`);
  return { shellId, skipped, gridLost };
}

/** Triangle area from the double-precision positions, mm^2. */
function doubleArea(p: ArrayLike<number>, ia: number, ib: number, ic: number): number {
  const ux = p[ib * 3] - p[ia * 3];
  const uy = p[ib * 3 + 1] - p[ia * 3 + 1];
  const uz = p[ib * 3 + 2] - p[ia * 3 + 2];
  const vx = p[ic * 3] - p[ia * 3];
  const vy = p[ic * 3 + 1] - p[ia * 3 + 1];
  const vz = p[ic * 3 + 2] - p[ia * 3 + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

export interface StepDocument {
  text: string;
  entities: number;
  skippedTriangles: number;
  gridLostTriangles: number;
}

export function stepDocument(regions: readonly RegionMesh[], meta: { fileName: string; title: string; author: string; created: Date; sourceLine: string; provenance?: readonly string[] }): StepDocument {
  if (regions.length === 0) {
    throw new Error("a STEP export needs at least one region with triangles");
  }
  const w = new StepWriter();
  const appCtx = w.add("APPLICATION_CONTEXT('automotive design')");
  w.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appCtx})`);
  const productCtx = w.add(`PRODUCT_CONTEXT('',#${appCtx},'mechanical')`);
  const definitionCtx = w.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appCtx},'design')`);
  const lengthUnit = w.add("( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )");
  const angleUnit = w.add("( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )");
  const solidAngleUnit = w.add("( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )");
  const uncertainty = w.add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),#${lengthUnit},'distance_accuracy_value','')`);
  const geomCtx = w.add(
    `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertainty})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lengthUnit},#${angleUnit},#${solidAngleUnit})) REPRESENTATION_CONTEXT('','') )`,
  );
  const origin = w.add("CARTESIAN_POINT('',(0.,0.,0.))");
  const dirZ = w.add("DIRECTION('',(0.,0.,1.))");
  const dirX = w.add("DIRECTION('',(1.,0.,0.))");
  const worldAxis = w.add(`AXIS2_PLACEMENT_3D('',#${origin},#${dirZ},#${dirX})`);

  let skipped = 0;
  let gridLost = 0;
  regions.forEach((region) => {
    const name = stepString(region.region);
    const product = w.add(`PRODUCT(${name},${name},${stepString(`FrameCraft region ${region.region}, colour ${region.colorHex}`)},(#${productCtx}))`);
    w.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part','',(#${product}))`);
    const formation = w.add(`PRODUCT_DEFINITION_FORMATION('','',#${product})`);
    const definition = w.add(`PRODUCT_DEFINITION('design','',#${formation},#${definitionCtx})`);
    const shape = w.add(`PRODUCT_DEFINITION_SHAPE('','',#${definition})`);
    const shell = writeShell(w, region);
    skipped += shell.skipped;
    gridLost += shell.gridLost;
    const brep = w.add(`MANIFOLD_SOLID_BREP(${name},#${shell.shellId})`);
    const representation = w.add(`ADVANCED_BREP_SHAPE_REPRESENTATION(${name},(#${worldAxis},#${brep}),#${geomCtx})`);
    w.add(`SHAPE_DEFINITION_REPRESENTATION(#${shape},#${representation})`);
  });

  const header =
    "ISO-10303-21;\nHEADER;\n" +
    `FILE_DESCRIPTION((${stepString(`${meta.title}: FrameCraft framed miniature city, faceted B-rep`)},${stepString(`${ATTRIBUTION}, ODbL 1.0`)}${meta.sourceLine ? `,${stepString(meta.sourceLine)}` : ""}${(meta.provenance ?? []).map((line) => `,${stepString(line)}`).join("")}),'2;1');\n` +
    `FILE_NAME(${stepString(meta.fileName)},${stepString(isoTimestamp(meta.created))},(${stepString(meta.author)}),(${stepString("FrameCraft")}),${stepString(APPLICATION)},${stepString(APPLICATION)},'');\n` +
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n";
  const text = header + w.lines.join("\n") + "\nENDSEC;\nEND-ISO-10303-21;\n";
  return { text, entities: w.count, skippedTriangles: skipped, gridLostTriangles: gridLost };
}

export function exportStep(result: EngineResult, options: StepOptions = {}): StepExportFile {
  const resolved = resolveOptions(result, options);
  const limit = options.triangleWarnLimit ?? STEP_TRIANGLE_WARN_LIMIT;
  const placed = placeInBuildSpace(orderedRegions(result.regions));
  const fileName = `${resolved.stem}.step`;
  const author = (result.params.place?.author ?? "").trim() || resolved.designer;
  // One shell in single-colour mode: the boolean union, not the partition
  // (`common.placeMerged`). In parts mode every region keeps its own shell,
  // which is what a CAD reader needs to give them different materials.
  const shells = isSingleObject(result, options) ? [placeMerged(result, placed)] : placed.regions;
  const doc = stepDocument(shells, {
    fileName,
    title: resolved.title,
    author,
    created: resolved.created,
    sourceLine: sourceLine(resolved.source),
    // The provenance block every format carries, one descriptive string each
    // (`common.provenanceEntries`, `[V3-P7-A10]`).
    provenance: provenanceLines(result, resolved),
  });
  const notes: string[] = [];
  const triangles = triangleCount(shells);
  if (triangles > limit) {
    notes.push(
      `STEP is a faceted B-rep: ${triangles.toLocaleString("en-US")} triangles became ${doc.entities.toLocaleString("en-US")} entities (${(doc.text.length / 1_048_576).toFixed(1)} MB). Above ${limit.toLocaleString("en-US")} triangles most CAD tools open it slowly; the 3MF or STL carries the same geometry.`,
    );
  }
  if (doc.skippedTriangles > 0) {
    notes.push(`${doc.skippedTriangles} zero-area triangle(s) were left out of the STEP shells.`);
  }
  if (doc.gridLostTriangles > 0) {
    notes.push(
      `The STEP file cannot carry every face of this model: ${doc.gridLostTriangles} face(s) measure under ` +
        `1e-9 mm2 once the coordinates are on the ${VERTEX_DECIMALS}-decimal grid the file writes, and were left ` +
        "out of the shells. A smaller plate is what removes the faces at source.",
    );
  }
  return {
    name: fileName,
    mime: MIME_STEP,
    bytes: new TextEncoder().encode(doc.text),
    notes,
    entities: doc.entities,
    skippedTriangles: doc.skippedTriangles,
    gridLostTriangles: doc.gridLostTriangles,
  };
}

export interface StepCheck {
  hasHeader: boolean;
  hasTerminator: boolean;
  entities: number;
  references: number;
  /** Entity ids that are referenced but never defined. */
  unresolved: number[];
  /** Entity ids defined more than once. */
  duplicates: number[];
}

/** Structural check: balanced `#N=` definitions and `#N` references, header and terminator present. */
export function stepCheck(text: string): StepCheck {
  const defined = new Set<number>();
  const duplicates: number[] = [];
  const referenced = new Set<number>();
  const dataStart = text.indexOf("DATA;");
  const body = dataStart >= 0 ? text.slice(dataStart + 5) : "";
  const entityRe = /^#(\d+)=(.*);$/gm;
  let match: RegExpExecArray | null;
  let references = 0;
  while ((match = entityRe.exec(body)) !== null) {
    const id = Number(match[1]);
    if (defined.has(id)) duplicates.push(id);
    defined.add(id);
    const refRe = /#(\d+)/g;
    let ref: RegExpExecArray | null;
    while ((ref = refRe.exec(match[2])) !== null) {
      referenced.add(Number(ref[1]));
      references += 1;
    }
  }
  const unresolved = [...referenced].filter((id) => !defined.has(id)).sort((a, b) => a - b);
  return {
    hasHeader: text.startsWith("ISO-10303-21;") && text.indexOf("FILE_SCHEMA") > 0,
    hasTerminator: text.trimEnd().endsWith("END-ISO-10303-21;"),
    entities: defined.size,
    references,
    unresolved,
    duplicates,
  };
}
