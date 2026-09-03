// Shared pieces of the export writers: options, region ordering, build-space
// placement, mesh merging, colours and the metadata every format carries.
// Everything here is pure; nothing imports manifold.

import type { PrintParams, SceneGraph } from "../../contracts";
import { resolveProfile } from "../../printers";
import { REGION_NAMES, type Bbox3, type EngineResult, type RegionMesh, type RegionName } from "../types";

/**
 * Fractional digits every vertex coordinate is written with.
 *
 * Twelve, which is what the reference implementation's 3MF writer uses
 * (`app/export/mf3.py`, `%.12f`). Six is not enough: it quantises a coordinate
 * to a micrometre, and two faces a boolean made exactly coincident then land on
 * different micrometre grid points, which is how a partition of six regions
 * reads back as seven bodies.
 */
export const VERTEX_DECIMALS = 12;

export const ATTRIBUTION = "© OpenStreetMap contributors";
export const LICENSE_LINE = "OpenStreetMap data is licensed under the ODbL 1.0.";
export const APPLICATION = "FrameCraft 3.0.0";
export const GENERATOR_NAME = "FrameCraft";
export const GENERATOR_VERSION = "3.0.0";

/**
 * The one licence sentence every format carries verbatim (v3 phase 7).
 *
 * One string, in one place, because it is a licence notice and a licence notice
 * that says a slightly different thing in each of four files is not a notice,
 * it is four claims. `LICENSE_LINE` above is the longer prose form the 3MF's
 * reserved `LicenseTerms` field already carried and keeps carrying.
 */
export const MODEL_DATA_LICENCE = "Model data © OpenStreetMap contributors, ODbL 1.0";

/** `place.author`, trimmed; "" when the user never set one. */
export function authorOf(result: EngineResult): string {
  return (result.params.place?.author ?? "").trim();
}

export interface SourceLocation {
  lat: number;
  lon: number;
  radius_m?: number;
  rotation_deg?: number;
  preset_id?: string | null;
}

export interface ExportOptions {
  /** Model title; defaults to "FrameCraft" plus the city label when one is set. */
  title?: string;
  /** Defaults to "FrameCraft". */
  designer?: string;
  /** Creation timestamp; defaults to the moment of the call. Pass a fixed value for a reproducible file. */
  created?: Date;
  /** WGS84 location the scene was cut from, written into the metadata. */
  source?: SourceLocation;
  /** File stem without extension; defaults to "framecraft". */
  stem?: string;
  /**
   * `PrintParams.color_mode`, resolved by the caller. The pipeline's export
   * stage reads it through its claim and passes it here so the decision is on
   * record; a writer called directly falls back to `result.params.color_mode`.
   */
  colorMode?: "single" | "parts";
  /**
   * `PrintParams.colour.palette` (v3.1): written into every 3MF's metadata as
   * `framecraft:palette` and into the sidecar, so the preset the colours came
   * from is a fact of the file rather than a UI-only setting.
   */
  palette?: string | null;
}

export interface ResolvedExportOptions {
  title: string;
  designer: string;
  created: Date;
  source: SourceLocation | null;
  stem: string;
  palette: string | null;
}

export function resolveOptions(result: EngineResult, options: ExportOptions): ResolvedExportOptions {
  const label = (result.params.city_label ?? "").trim();
  return {
    title: options.title ?? (label !== "" ? `FrameCraft ${label}` : "FrameCraft"),
    // The person who made it, when they said who they are: that is what a 3MF
    // reader shows and what a STEP header's author field means. Blank-safe -
    // an unset `place.author` leaves the generator's own name, which is what
    // every file said before v3 phase 7.
    designer: options.designer ?? (authorOf(result) || GENERATOR_NAME),
    created: options.created ?? new Date(),
    source: options.source ?? null,
    stem: sanitizeStem(options.stem ?? "framecraft"),
    palette: options.palette === undefined ? (result.params.colour?.palette ?? null) : options.palette,
  };
}

/** The `framecraft:palette` metadata entry, when the params name a palette. */
export function paletteEntries(resolved: ResolvedExportOptions): Array<[string, string]> {
  return resolved.palette === null || resolved.palette === "" ? [] : [["framecraft:palette", resolved.palette]];
}

export function sanitizeStem(stem: string): string {
  const cleaned = stem.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "framecraft" : cleaned;
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isoTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const REGION_INDEX = new Map<RegionName, number>(REGION_NAMES.map((name, index) => [name, index]));

/** Regions in REGION_NAMES order (stable for equal names), empty meshes dropped. */
export function orderedRegions(regions: readonly RegionMesh[]): RegionMesh[] {
  return regions
    .filter((region) => region.indices.length >= 3 && region.positions.length >= 9)
    .map((region, index) => ({ region, index }))
    .sort((a, b) => {
      const ra = REGION_INDEX.get(a.region.region) ?? REGION_NAMES.length;
      const rb = REGION_INDEX.get(b.region.region) ?? REGION_NAMES.length;
      return ra - rb || a.index - b.index;
    })
    .map((entry) => entry.region);
}

export function triangleCount(regions: readonly RegionMesh[]): number {
  let total = 0;
  for (const region of regions) total += Math.floor(region.indices.length / 3);
  return total;
}

export function vertexCount(regions: readonly RegionMesh[]): number {
  let total = 0;
  for (const region of regions) total += Math.floor(region.positions.length / 3);
  return total;
}

/** Bounds of the vertices actually present (not the region's declared bbox). */
export function measuredBounds(regions: readonly RegionMesh[]): Bbox3 {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const region of regions) {
    const p = region.positions;
    for (let i = 0; i + 2 < p.length; i += 3) {
      for (let k = 0; k < 3; k += 1) {
        const v = p[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }
  if (!Number.isFinite(min[0])) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  return { min, max };
}

export interface Placement {
  /** Translation applied to every vertex, in mm. */
  offset: [number, number, number];
  regions: RegionMesh[];
  /** Bounds after the translation. */
  bounds: Bbox3;
}

/**
 * Translate the model into 3MF build space: the minimum x and y at 0 and the
 * base underside at z = 0. The engine frame keeps the plate centred on (0, 0),
 * which a slicer would happily accept but which reads as "half off the bed"
 * in a bare 3MF viewer.
 */
export function placeInBuildSpace(regions: readonly RegionMesh[]): Placement {
  const bounds = measuredBounds(regions);
  const offset: [number, number, number] = [-bounds.min[0], -bounds.min[1], -bounds.min[2]];
  const placed = regions.map((region) => translateRegion(region, offset));
  return {
    offset,
    regions: placed,
    bounds: {
      min: [0, 0, 0],
      max: [bounds.max[0] + offset[0], bounds.max[1] + offset[1], bounds.max[2] + offset[2]],
    },
  };
}

export function translateRegion(region: RegionMesh, offset: readonly [number, number, number]): RegionMesh {
  if (offset[0] === 0 && offset[1] === 0 && offset[2] === 0) {
    return region;
  }
  const src = region.positions;
  const positions = new Float64Array(src.length);
  for (let i = 0; i + 2 < src.length; i += 3) {
    positions[i] = src[i] + offset[0];
    positions[i + 1] = src[i + 1] + offset[1];
    positions[i + 2] = src[i + 2] + offset[2];
  }
  return {
    ...region,
    positions,
    bbox: {
      min: [region.bbox.min[0] + offset[0], region.bbox.min[1] + offset[1], region.bbox.min[2] + offset[2]],
      max: [region.bbox.max[0] + offset[0], region.bbox.max[1] + offset[1], region.bbox.max[2] + offset[2]],
    },
  };
}

/**
 * The one-solid mesh a single-object format writes, in build space.
 *
 * `EngineResult.regions` is a PARTITION: the pieces touch on shared faces and
 * never overlap, so concatenating their triangles gives a mesh with interior
 * walls and one body per region - which a slicer reads as a pile of shells.
 * `EngineResult.merged` is the real boolean union, and it is translated by the
 * SAME offset the regions got so the two modes describe the same object in the
 * same place.
 */
export function placeMerged(result: EngineResult, placement: Placement): RegionMesh {
  return translateRegion(result.merged, placement.offset);
}

/** True when this parameter set wants one object rather than one per region. */
export function isSingleObject(result: EngineResult, options: Pick<ExportOptions, "colorMode"> = {}): boolean {
  return (options.colorMode ?? result.params.color_mode ?? "single") === "single";
}

export interface MergedMesh {
  positions: Float64Array;
  indices: Uint32Array;
}

/** Every region concatenated into one index buffer (no welding, no boolean). */
export function mergeRegions(regions: readonly RegionMesh[]): MergedMesh {
  const positions = new Float64Array(regions.reduce((n, r) => n + r.positions.length, 0));
  const indices = new Uint32Array(regions.reduce((n, r) => n + r.indices.length, 0));
  let pOffset = 0;
  let iOffset = 0;
  for (const region of regions) {
    positions.set(region.positions, pOffset);
    const base = pOffset / 3;
    const src = region.indices;
    for (let i = 0; i < src.length; i += 1) {
      indices[iOffset + i] = src[i] + base;
    }
    pOffset += region.positions.length;
    iOffset += src.length;
  }
  return { positions, indices };
}

const COLOR_RE = /^#([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$/;

/** "#rrggbb" or "#rrggbbaa" -> "#RRGGBBAA" (3MF displaycolor). */
export function colorRgba(value: string): string {
  const match = COLOR_RE.exec(value.trim());
  if (!match) {
    throw new Error(`not a #RRGGBB colour: ${JSON.stringify(value)}`);
  }
  return `#${match[1]}${match[2] ?? "FF"}`.toUpperCase();
}

/** "#rrggbb[aa]" -> "#RRGGBB" (Bambu filament_colour, OBJ Kd source). */
export function colorRgb(value: string): string {
  const match = COLOR_RE.exec(value.trim());
  if (!match) {
    throw new Error(`not a #RRGGBB colour: ${JSON.stringify(value)}`);
  }
  return `#${match[1]}`.toUpperCase();
}

export function colorToUnit(value: string): [number, number, number] {
  const rgb = colorRgb(value).slice(1);
  return [parseInt(rgb.slice(0, 2), 16) / 255, parseInt(rgb.slice(2, 4), 16) / 255, parseInt(rgb.slice(4, 6), 16) / 255];
}

export function sourceLine(source: SourceLocation | null): string {
  if (!source) return "";
  const parts = [`lat=${source.lat}`, `lon=${source.lon}`];
  if (source.radius_m !== undefined) parts.push(`radius_m=${source.radius_m}`);
  if (source.rotation_deg !== undefined) parts.push(`rotation_deg=${source.rotation_deg}`);
  if (source.preset_id !== undefined && source.preset_id !== null) parts.push(`preset_id=${source.preset_id}`);
  return parts.join(" ");
}

export function paramsLine(params: PrintParams): string {
  return JSON.stringify(params);
}

/**
 * The provenance block every exporter writes, as `[key, value]` pairs.
 *
 * Five facts, in one order, in every format (v3 phase 7, `[V3-P7-A10]`): who
 * made it, what licence the map data is under, what made it, where on the Earth
 * it is, and when it was generated. The 3MF writers turn it into `<metadata>`,
 * OBJ into header comments, STEP into its `FILE_DESCRIPTION`, and the sidecar
 * carries the same pairs as an object - so a file separated from this program
 * still says where it came from even if every engraved mark has been sanded
 * off. `author` is written even when it is empty: a uniform block is one a
 * reader can look for, and an absent key is indistinguishable from a stripped
 * one.
 */
export function provenanceEntries(
  result: EngineResult,
  resolved: ResolvedExportOptions,
): Array<[string, string]> {
  const source = resolved.source;
  const entries: Array<[string, string]> = [
    ["author", authorOf(result)],
    ["license", MODEL_DATA_LICENCE],
    ["generator", APPLICATION],
    ["source", sourceLine(source)],
    ["generated", isoTimestamp(resolved.created)],
  ];
  return entries;
}

/** The same block as `Key: value` lines, for a comment header. */
export function provenanceLines(
  result: EngineResult,
  resolved: ResolvedExportOptions,
): string[] {
  return provenanceEntries(result, resolved).map(
    ([key, value]) => `${key.charAt(0).toUpperCase()}${key.slice(1)}: ${value}`,
  );
}

/** The same block as a sidecar object. */
export function provenanceJson(
  result: EngineResult,
  resolved: ResolvedExportOptions,
): Record<string, string> {
  return Object.fromEntries(provenanceEntries(result, resolved));
}

/** The Description every format carries: attribution, location, then the parameters. */
export function description(result: EngineResult, resolved: ResolvedExportOptions): string {
  const location = sourceLine(resolved.source);
  return (
    `${ATTRIBUTION}, ODbL. Produced work by FrameCraft.` +
    (location ? ` Location: ${location}.` : "") +
    ` PrintParams: ${paramsLine(result.params)}.`
  );
}

/** Slot -> colour, from the first region (in REGION_NAMES order) on that slot. */
export function slotColors(regions: readonly RegionMesh[], slotCount: number): string[] {
  const bySlot = new Map<number, string>();
  for (const region of orderedRegions(regions)) {
    if (!bySlot.has(region.slot)) bySlot.set(region.slot, colorRgb(region.colorHex));
  }
  const maxSlot = Math.max(slotCount, ...regions.map((r) => r.slot), 1);
  const out: string[] = [];
  for (let slot = 1; slot <= maxSlot; slot += 1) {
    out.push(bySlot.get(slot) ?? FALLBACK_SLOT_COLORS[(slot - 1) % FALLBACK_SLOT_COLORS.length]);
  }
  return out;
}

/** Bambu Studio's own default filament colours, used for a slot no region names. */
export const FALLBACK_SLOT_COLORS = ["#FFFFFF", "#00AE42", "#0086D6", "#F5A623", "#D8D3C6", "#3A3A3A", "#2F7FC1", "#5A9E4B"];

// ---------------------------------------------------------------------------
// Sidecar JSON
// ---------------------------------------------------------------------------

/**
 * Shape `make validate FILE=...` reads (`services/bake/app/cli.py`'s own
 * sidecar, which the reference Python implementation writes): one function so
 * `scripts/export-cli.ts` (the gate's CLI path) and the browser's own Export ->
 * download flow (`lib/exportFlow.ts`) can never drift into two different sidecar
 * shapes for the same `EngineResult`.
 */
export interface SidecarInput {
  result: EngineResult;
  /** Location the scene was cut from, for the provenance block. */
  source?: SourceLocation | null;
  /** `PrintParams.export_target` this sidecar describes. */
  target: string;
  files: ReadonlyArray<{ name: string; bytes: Uint8Array }>;
  /** Remarks from `exportForTarget` (STEP size, colour-change plan). */
  notes: readonly string[];
  scene: SceneGraph;
  /** Wall-clock seconds for the whole call (engine + export), not just the engine's own `stats.elapsedMs`. */
  elapsedS: number;
  created: Date;
  printerProfileId: string;
  /** `colour.palette`, `colour.preview_theme` and `schema_version` as the export stage read them (v3.1); each is also inside `print_params`. */
  palette?: string | null;
  previewTheme?: string | null;
  schemaVersion?: number;
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(dot + 1);
}

export function buildSidecarJson(input: SidecarInput): Record<string, unknown> {
  const { result, target, files, notes, scene, elapsedS, created, printerProfileId } = input;
  return {
    attribution: ATTRIBUTION,
    license: "ODbL 1.0",
    generator: "FrameCraft web engine",
    created_at: isoTimestamp(created),
    // The same five facts every exported FILE carries, so a sidecar read on its
    // own says exactly what the model beside it says (`[V3-P7-A10]`).
    provenance: provenanceJson(result, {
      title: "",
      designer: authorOf(result) || GENERATOR_NAME,
      created,
      source: input.source ?? null,
      stem: "",
      palette: input.palette === undefined ? (result.params.colour?.palette ?? null) : input.palette,
    }),
    scene_request: null,
    print_params: result.params,
    bake_result: {
      status: "done",
      progress: 1,
      warnings: [
        ...result.findings.filter((f) => f.severity !== "info").map((f) => `${f.title}: ${f.detail}`),
        ...notes,
      ],
      error: null,
      files: Object.fromEntries(files.map((f) => [fileExtension(f.name) || f.name, f.name])),
      stats: {
        triangles: result.stats.triangles,
        width_mm: result.stats.widthMm,
        depth_mm: result.stats.depthMm,
        height_mm: result.stats.heightMm,
        scale_denominator: result.stats.scaleDenominator,
        min_wall_mm: result.stats.minWallMm,
        measured_min_wall_mm: result.stats.measuredMinWallMm,
        buildings: result.stats.buildings,
        regions: result.regions.map((r) => ({
          region: r.region,
          slot: r.slot,
          color: r.colorHex,
          triangles: r.indices.length / 3,
          bodies: r.bodies,
          volume_mm3: r.volumeMm3,
        })),
      },
    },
    scene_stats: scene.stats,
    validation: null,
    timings_s: { engine: result.stats.elapsedMs / 1000, total: elapsedS },
    export_target: target,
    printer_profile: printerProfileId,
    // v3.1: the three fields the export stage reads for the file itself, at the
    // top level so a reader (the matrix test, `make validate`) finds them
    // without walking `print_params`.
    schema_version: input.schemaVersion ?? result.params.schema_version ?? null,
    colour_palette: input.palette === undefined ? (result.params.colour?.palette ?? null) : input.palette,
    preview_theme: input.previewTheme === undefined ? (result.params.colour?.preview_theme ?? null) : input.previewTheme,
    /**
     * The Z ceiling this build was made against, mm.
     *
     * The reference validator's bounding-box row reads it (`app/cli.py`
     * `_max_height_from_sidecar`) so a 90 mm model made for a 250 mm machine
     * is judged against that machine rather than against 04's reference 60,
     * and so the number the validator prints is the number the editor showed
     * (DECISIONS `[V3-P4-E9]`).
     */
    max_height_mm: resolveProfile(result.params).maxHeightMm,
    resolved_text: result.resolvedText,
    findings: result.findings,
    /**
     * The Z bands the mandatory attribution marks occupy, mm.
     *
     * Read by `services/bake/app/cli.py` exactly the way `max_height_mm` is
     * (`[V3-P4-E9]`, now `[V3-P7-A8]`): the reference validator's structural
     * `min_wall` row skips them and its `attribution` row judges them instead.
     * The marks are engraved at 1.2 to 1.8 mm cap height because that is what a
     * plate edge and a 2 mm frame wall hold, which puts their strokes and the
     * ridges between them under one nozzle by construction; they are provenance,
     * not a printed feature, and a file with no such field is judged exactly as
     * it always was.
     */
    attribution_bands: result.attributionBands ?? [],
  };
}
