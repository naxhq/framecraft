// Shared engine interfaces for the browser bake pipeline (FrameCraft v3).
// Producers: lib/engine/osm/* (SceneGraph), lib/engine/solid/* (RegionMesh[]).
// Consumers: lib/engine/export/* (files), components/scene/* (preview).
// Extend additively; do not rename members, three builders depend on them.

import type { PrintParams, SceneGraph } from "../contracts";

export const REGION_NAMES = [
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

export type RegionName = (typeof REGION_NAMES)[number];

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
}

export interface TileResult {
  /** [column, row], zero-based. */
  index: [number, number];
  label: string;
  regions: RegionMesh[];
  bbox: Bbox3;
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
  /** Attribution strings that must be cut (phase 7); the engine never lets the UI remove them. */
  attribution?: { underside: string; frameWall: string; microtext: string };
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
  /** Echo of the params the meshes were built from. */
  params: PrintParams;
}

/** Exporters take an EngineResult and return file bytes; they never touch manifold. */
export interface ExportFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}
