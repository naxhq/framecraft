// Shared engine interfaces for the browser bake pipeline (FrameCraft v3).
// Producers: lib/engine/osm/* (SceneGraph), lib/engine/solid/* (RegionMesh[]).
// Consumers: lib/engine/export/* (files), components/scene/* (preview).
// Extend additively; do not rename members, three builders depend on them.

import type { PrintParams, SceneGraph } from "../contracts";

/**
 * The regions the CONTRACT can colour: one `colour.region_slots` /
 * `region_colors` key each, plus `easel`, which borrows `base`.
 *
 * This list is what a colour panel lists before the first bake. It is NOT the
 * full set of names a `RegionMesh` can carry: see {@link DERIVED_REGION_NAMES}.
 */
export const COLOURABLE_REGION_NAMES = [
  "base",
  "frame",
  "matting",
  "buildings",
  "hero_building",
  "roads",
  "water",
  "parks",
  "rail",
  "lettering",
  "attribution",
  "easel",
] as const;

/**
 * Regions the BAKE derives, which exist only when a feature is switched on
 * (v3 phase 5, DECISIONS `[V3-P5-F7]`).
 *
 * * `cleat` - the wall-side wedge of a French cleat mount (`hanger: "cleat"`),
 *   a separate printable part. It borrows `base`'s slot and colour, exactly as
 *   `easel` does.
 * * `buildings_band_N` - band N of a height gradient
 *   (`colour.gradient.enabled`). Band 1 keeps the name `buildings`, so the
 *   names start at 2. Each band takes `colour.gradient.slots[N-1]` and a colour
 *   interpolated between the buildings colour and the hero colour.
 *
 * A consumer that renders region names should treat an unknown name as
 * "borrows the colour it was given": every one of these carries a resolved
 * `slot` and `colorHex` on its `RegionMesh` like any other region.
 */
export const DERIVED_REGION_NAMES = [
  "cleat",
  "buildings_band_2",
  "buildings_band_3",
  "buildings_band_4",
  "buildings_band_5",
  "buildings_band_6",
  "buildings_band_7",
  "buildings_band_8",
] as const;

export const REGION_NAMES = [
  ...COLOURABLE_REGION_NAMES,
  ...DERIVED_REGION_NAMES,
] as const;

export type ColourableRegionName = (typeof COLOURABLE_REGION_NAMES)[number];
export type DerivedRegionName = (typeof DERIVED_REGION_NAMES)[number];
export type RegionName = (typeof REGION_NAMES)[number];

/** Most gradient bands the buildings can be split into (`[V3-P5-F7]`). */
export const GRADIENT_MAX_BANDS = 8;

/** Region name for gradient band `index` (1-based); band 1 is `buildings`. */
export function bandRegionName(index: number): RegionName {
  if (index <= 1) return "buildings";
  const name = `buildings_band_${index}`;
  return (DERIVED_REGION_NAMES as readonly string[]).includes(name)
    ? (name as RegionName)
    : "buildings";
}

/** The 1-based gradient band a region name carries, or null. */
export function bandIndexOf(region: RegionName): number | null {
  if (region === "buildings") return 1;
  const match = /^buildings_band_(\d+)$/.exec(region);
  return match === null ? null : Number(match[1]);
}

/** Axis-aligned bounds in engine millimetres. */
export interface Bbox3 {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * One watertight, non-welded solid per colourable region.
 * Engine frame: millimetres, x east, y north, z up, base underside at z = 0,
 * plate centre at (0, 0). Triangles are counter-clockwise seen from outside.
 */
export interface RegionMesh {
  region: RegionName;
  /**
   * xyz triples, length = 3 * vertex count, in DOUBLE precision.
   *
   * Double and not float32: manifold3d works in double, one float32 step at a
   * 90 mm coordinate is 7.6 nanometres, and that is enough to collapse a
   * triangle the kernel built cleanly. A consumer that needs float32 (a GPU
   * buffer) makes its own copy; a consumer that writes a file must not.
   */
  positions: Float64Array;
  /** vertex indices, length = 3 * triangle count. */
  indices: Uint32Array;
  volumeMm3: number;
  bbox: Bbox3;
  /** Connected bodies inside this region (1 for base, many for buildings). */
  bodies: number;
  /** Filament slot 1..16 from params.colour.region_slots. */
  slot: number;
  /** Colour from params.colour.region_colors, "#RRGGBB". */
  colorHex: string;
}

export type Severity = "info" | "warning" | "error";

/** A printability or content finding, rendered by the Issues badge. */
export interface AuditFinding {
  /** Stable id, kebab-case, for example "wall-too-thin". */
  id: string;
  severity: Severity;
  title: string;
  /** Plain-language explanation with the measured numbers. */
  detail: string;
  region?: RegionName;
  /** One-click fix: a partial PrintParams patch. `safe` fixes may be applied by "Auto-fix all safe issues". */
  fix?: { label: string; safe: boolean; patch: Record<string, unknown> };
}

/** A text feature after token expansion, reported so nothing is a surprise after baking. */
export interface ResolvedLine {
  id: string;
  text: string;
  /** Human-readable target, for example "Frame, top edge". */
  surface: string;
  mode: "engrave" | "emboss" | "inlay";
  status: "cuts" | "skipped";
  reason?: string;
  depthMm?: number;
  sizeMm?: number;
}

export interface EngineStats {
  scaleDenominator: number;
  minWallMm: number;
  measuredMinWallMm: number | null;
  buildings: number;
  buildingsMerged: number;
  buildingsDilated: number;
  heightFallbacks: number;
  triangles: number;
  widthMm: number;
  depthMm: number;
  heightMm: number;
  elapsedMs: number;
  /**
   * v3 phase 3, all optional so every existing consumer stays valid.
   *
   * `terrainReliefMm` is the printed height of the hillside after
   * `terrain_exaggeration`, absent when the bake is flat. The three counts are
   * absent when the scene has nothing of that kind in it.
   */
  terrainReliefMm?: number;
  /** Tree markers actually built. */
  trees?: number;
  /** Trees the printed-size floor removed. */
  treesDropped?: number;
  /** Elevated road and rail segments built as decks. */
  bridges?: number;
  /**
   * v3 phase 4. Tiles the model was split into, absent when tiling is off.
   * `tileCols * tileRows`, repeated so a consumer does not have to multiply.
   */
  tiles?: number;
  tileCols?: number;
  tileRows?: number;
  /**
   * v3 phase 5. Height-gradient bands the buildings were split into, absent
   * when `colour.gradient` is off (one band is not a gradient).
   */
  gradientBands?: number;
}

export interface TileResult {
  /** [column, row], zero-based. Column 0 is the west edge, row 0 the north one. */
  index: [number, number];
  /** Grid reference, column letter then row number, one-based: "A1", "B2". */
  label: string;
  regions: RegionMesh[];
  bbox: Bbox3;
  /**
   * This tile's regions welded into one solid, the per-tile twin of
   * {@link EngineResult.merged}. Absent only when the tile came out empty.
   * Single-object formats (STL, single-mode 3MF) write this; the volume of a
   * tile is read from here and never from the sum of `regions`.
   */
  merged?: RegionMesh;
}

/**
 * A leaf value one applied fix wrote.
 *
 * `path` is dotted into PrintParams (`colour.region_slots.roads`), so a UI can
 * show what moved without diffing two parameter objects.
 */
export interface FixChange {
  path: string;
  before: unknown;
  after: unknown;
  /** The finding whose fix wrote it. */
  findingId: string;
  /** One line for the UI: "Plate 256 mm becomes 180 mm". */
  label: string;
}

/** What `applyFix` / `applySafeFixes` hand back: new params plus what moved. */
export interface FixApplication {
  params: PrintParams;
  changes: FixChange[];
  /** Finding ids whose fix was applied, in the order they were applied. */
  applied: string[];
  /** Finding ids that carried no applicable fix, with the reason. */
  skipped: Array<{ id: string; reason: string }>;
}

/** Filament for one slot. Every number is an estimate (see `EstimateResult`). */
export interface SlotEstimate {
  slot: number;
  colorHex: string;
  /** Regions printed in this slot, in REGION_NAMES order. */
  regions: RegionName[];
  /** Geometric volume of the model in this slot, mm3. */
  volumeMm3: number;
  /** Volume a slicer would actually extrude for it, mm3 (see the assumptions). */
  filamentVolumeMm3: number;
  grams: number;
  metres: number;
}

/** The constants the estimate was computed with, so the UI can name them. */
export interface EstimateAssumptions {
  densityGCm3: number;
  filamentDiameterMm: number;
  layerHeightMm: number;
  /** Extruded volume as a fraction of the model's own volume. */
  materialFraction: number;
  flowMm3PerS: number;
  overheadSPerLayer: number;
  travelAreaRateMm2PerS: number;
}

/**
 * Filament and time, estimated. Not a slicer result and never presented as one:
 * `isEstimate` is always true and `caveat` is the sentence that says so.
 */
export interface EstimateResult {
  isEstimate: true;
  slots: SlotEstimate[];
  /** Geometric volume of the whole model, mm3 (from `merged`, never the sum of regions). */
  volumeMm3: number;
  filamentVolumeMm3: number;
  grams: number;
  metres: number;
  layers: number;
  layerHeightMm: number;
  seconds: number;
  /** "5 h 12 min", for a label. */
  duration: string;
  assumptions: EstimateAssumptions;
  caveat: string;
}

/**
 * Structured-clone-friendly terrain heightfield in scene metres (ENU).
 * The engine builds its sampler from this; the UI fetches DEM tiles into it.
 * Grid row r, column c covers (originEastM + c*cellM, originNorthM + r*cellM);
 * elevations are metres above the tile minimum, length = cols * rows.
 */
export interface TerrainGrid {
  originEastM: number;
  originNorthM: number;
  cellM: number;
  cols: number;
  rows: number;
  elevations: Float32Array;
  /** max - min elevation across the grid, metres. */
  rangeM: number;
  /** Data source label for attribution and the hint UI. */
  source: string;
}

/** Terrain sampler in scene metres (ENU); returns elevation in metres above the tile minimum. */
export interface TerrainSampler {
  sampleM(xEastM: number, yNorthM: number): number;
  rangeM: number;
}

export interface EngineInput {
  scene: SceneGraph;
  /** Fully token-resolved params (see lib/bake.ts resolveParamsForBake). */
  params: PrintParams;
  terrain?: TerrainGrid | null;
  /** Building ids promoted to heroes (manual plus auto). */
  heroIds?: string[];
  /**
   * The SceneRequest's rotation, degrees counter-clockwise. The model is turned
   * by it, so the north arrow is turned back by the same amount and keeps
   * pointing at true north. Defaults to 0.
   */
  rotationDeg?: number;
  /** ISO date the `{date}` token expands to. Defaults to today. */
  date?: string;
  /**
   * @deprecated IGNORED since v3 phase 7 (DECISIONS `[V3-P7-A1]`).
   *
   * It was going to be "the attribution strings the UI hands the engine", which
   * is the one thing this field must never be: a caller that can SUPPLY the
   * attribution is a caller that can supply an empty one, and the whole point
   * of the marks is that nothing outside `solid/attribution.ts` decides what
   * they say. The engine composes them from its own constants, the params and
   * the bake date, and reads nothing from here.
   *
   * Kept, rather than removed, so every existing caller still typechecks; it is
   * accepted and discarded. It will be deleted in a later phase.
   */
  attribution?: { underside: string; frameWall: string; microtext: string };
}

/**
 * One building's tint, when `colour.tint.enabled` (v3 phase 5).
 *
 * Data only: the PRINT path ignores it entirely, because a tint is a shade of
 * one filament and a printer has no way to lay it down. It exists for the
 * preview and for `export/obj.ts`, which turns it into per-building materials.
 * `centroidMm` is the building solid's plan centroid in the engine frame, which
 * is how a consumer matches a tint to a body of the `buildings` mesh without
 * the engine having to emit one mesh per building.
 */
export interface BuildingTint {
  /** SceneGraph building id, or `block-<n>` for a merged block with no single owner. */
  id: string;
  colorHex: string;
  centroidMm: [number, number];
}

/**
 * One height-gradient band, when `colour.gradient.enabled` (v3 phase 5).
 *
 * The bands are EQUAL COUNT, not equal height: `topRangeMm` is what the band
 * actually covers, measured from the buildings this scene has. A preview that
 * wants to colour a building the way the bake will can either read the band
 * REGIONS (which carry the geometry) or match a height against these ranges.
 */
export interface BuildingBandSummary {
  region: RegionName;
  slot: number;
  colorHex: string;
  /** Printed roof heights in this band, mm: [lowest, highest]. */
  topRangeMm: [number, number];
  /** Building solids in this band. */
  buildings: number;
}

export interface EngineResult {
  regions: RegionMesh[];
  /**
   * Every region welded into one solid: what single-object formats write.
   *
   * `regions` are separate watertight BODIES that interpenetrate at their seams
   * by 0.2 mm (`solid/context.ts` `PART_OVERLAP_MM`, DECISIONS `[V3-P2-E2]`),
   * so concatenating their triangles produces a mesh with interior walls and
   * one body per region, which a slicer reads as a pile of shells rather than a
   * model. This is the real boolean solid: one body when the frame is on, with
   * the buildings welded to the plate through their skirt.
   *
   * It is also the ONLY volume a total, a filament estimate or a price may come
   * from. Summing `RegionMesh.volumeMm3` double-counts every seam: +5.18 % on
   * the Chicago plate.
   */
  merged: RegionMesh;
  stats: EngineStats;
  findings: AuditFinding[];
  resolvedText: ResolvedLine[];
  tiles?: TileResult[];
  /**
   * Per-building tints, present only when `colour.tint.enabled` (phase 5).
   * Absent, not empty, when the switch is off, so an existing consumer sees
   * exactly what it saw before.
   */
  buildingTints?: BuildingTint[];
  /**
   * The height-gradient bands, present only when the gradient is on and split
   * more than one way. Absent otherwise, so nothing existing changes.
   */
  buildingBands?: BuildingBandSummary[];
  /** Echo of the params the meshes were built from. */
  params: PrintParams;
  /**
   * Z bands the mandatory attribution marks occupy, `[low, high]` mm (v3 phase
   * 7). Never empty for a real bake: every model carries the marks.
   *
   * Written into the export sidecar as `attribution_bands` and read back by the
   * reference validator, which excludes them from its STRUCTURAL minimum-wall
   * probe and judges them by its own `attribution` row: the marks are
   * deliberately finer than the nozzle, because they are provenance rather than
   * a printed feature (`solid/attribution.ts`, DECISIONS `[V3-P7-A8]`).
   */
  attributionBands?: Array<[number, number]>;
}

/** Exporters take an EngineResult and return file bytes; they never touch manifold. */
export interface ExportFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}
