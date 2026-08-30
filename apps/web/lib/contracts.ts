// GENERATED FROM packages/contracts/schema — DO NOT EDIT.
//
// Regenerate with `make contracts` (runs packages/contracts/gen_py.py and
// packages/contracts/gen_ts.py). Hand edits here will be overwritten.

// ---- from scene_request.json ----------------------

export interface SceneRequest {
  lat: number;
  lon: number;
  radius_m: number;
  rotation_deg: number;
  preset_id?: string | null;
}

// ---- from scene_graph.json ------------------------

export interface Bounds {
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
}

export interface Center {
  lat: number;
  lon: number;
}

export type Point = [number, number];

export type Ring = Point[];

export interface Building {
  id: string;
  ring: Ring;
  holes: Ring[];
  height_m: number;
  height_source: "tag" | "levels" | "default";
  min_height_m: number;
  is_tall: boolean;
}

export interface Road {
  id: string;
  path: Point[];
  width_m: number;
  class: "motorway" | "primary" | "secondary" | "residential" | "service" | "path";
}

export interface AreaFeature {
  ring: Ring;
  holes: Ring[];
}

export interface Tree {
  x: number;
  y: number;
  radius_m: number;
}

export interface Stats {
  building_count: number;
  coverage: "good" | "sparse" | "empty";
  height_tag_ratio: number;
}

export interface SceneGraph {
  bounds: Bounds;
  center: Center;
  buildings: Building[];
  roads: Road[];
  water: AreaFeature[];
  green: AreaFeature[];
  trees: Tree[];
  stats: Stats;
}

// ---- from print_params.json -----------------------

export interface PartColors {
  base: string;
  frame: string;
  buildings: string;
  roads: string;
  water: string;
  green: string;
  trees: string;
}

export interface Engraving {
  edge: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  text: string;
  mode?: "engrave" | "emboss";
  size_mm?: number;
  depth_mm?: number;
  font?: "sans" | "serif" | "mono";
}

export interface NorthArrow {
  enabled?: boolean;
  corner?: "ne" | "nw" | "se" | "sw";
  size_mm?: number;
}

export interface ScaleBar {
  enabled?: boolean;
  edge?: "top" | "bottom" | "left" | "right";
  length_mode?: "auto" | "fixed";
  length_m?: number;
}

export interface UndersideMark {
  enabled?: boolean;
  template?: string;
}

export interface PrintParams {
  schema_version?: 2;
  plate_mm: number;
  base_thickness_mm: number;
  nozzle_mm: number;
  small_scale: number;
  large_scale: number;
  terrain_exaggeration: number;
  road_mode: "engrave" | "emboss" | "off";
  road_scale: number;
  trees: boolean;
  water: boolean;
  frame: boolean;
  city_label?: string;
  color_mode?: "single" | "parts";
  part_colors?: PartColors;
  engravings?: Engraving[];
  north_arrow?: NorthArrow;
  scale_bar?: ScaleBar;
  hanger?: "none" | "keyhole" | "magnets";
  underside_mark?: UndersideMark;
  hero_building_ids?: string[];
  hero_mode?: "true_height" | "own_color" | "both";
}

// ---- from bake_result.json ------------------------

export interface BakeFiles {
  "3mf": string;
  stl: string;
}

export interface BakeStats {
  triangles: number;
  volume_mm3: number;
  bbox_mm: [number, number, number];
  est_grams: number;
  is_manifold: boolean;
  min_wall_mm: number;
}

export interface BakeResult {
  job_id: string;
  status: "queued" | "running" | "done" | "failed";
  files?: BakeFiles | null;
  stats?: BakeStats | null;
  warnings: string[];
  progress?: number | null;
  error?: string | null;
}

// ---- derived constants --------------------

/**
 * Freeze `value` and everything reachable from it, then return it.
 *
 * Makes DEFAULT_PRINT_PARAMS immutable all the way down, so a caller that takes
 * a shallow copy and then writes to a nested object gets a TypeError (ES modules
 * are strict mode) instead of silently corrupting the shared default. Call
 * `defaultPrintParams()` for a copy that may be edited.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value as Record<string, unknown>)) {
      deepFreeze(inner);
    }
    Object.freeze(value);
  }
  return value;
}

export const DEFAULT_PRINT_PARAMS: PrintParams = deepFreeze<PrintParams>({
  schema_version: 2,
  plate_mm: 180,
  base_thickness_mm: 3.0,
  nozzle_mm: 0.4,
  small_scale: 1.0,
  large_scale: 1.0,
  terrain_exaggeration: 1.0,
  road_mode: "engrave",
  road_scale: 1.0,
  trees: true,
  water: true,
  frame: true,
  city_label: "",
  color_mode: "single",
  part_colors: {
    base: "#D8D3C6",
    frame: "#3A3A3A",
    buildings: "#D8D3C6",
    roads: "#3A3A3A",
    water: "#2F7FC1",
    green: "#5A9E4B",
    trees: "#5A9E4B",
  },
  engravings: [],
  north_arrow: {
    enabled: false,
    corner: "ne",
    size_mm: 4.0,
  },
  scale_bar: {
    enabled: false,
    edge: "bottom",
    length_mode: "auto",
    length_m: 500,
  },
  hanger: "none",
  underside_mark: {
    enabled: false,
    template: "{city} {scale} {date}",
  },
  hero_building_ids: [],
  hero_mode: "true_height",
});

/**
 * A fresh, fully mutable deep copy of DEFAULT_PRINT_PARAMS.
 *
 * Use this - never `{ ...DEFAULT_PRINT_PARAMS }` - wherever the copy will be
 * edited, so no two pieces of state share a nested object with each other or
 * with the frozen constant. Mirrors `PrintParams()` in Python, whose nested
 * defaults are per-instance for the same reason.
 */
export function defaultPrintParams(): PrintParams {
  return structuredClone(DEFAULT_PRINT_PARAMS);
}

export const PARAM_RANGES = {
  plate_mm: { min: 100, max: 256, default: 180 },
  base_thickness_mm: { min: 2, max: 8, default: 3.0 },
  nozzle_mm: { min: 0.1, max: 1.2, default: 0.4 },
  small_scale: { min: 0.5, max: 1.5, default: 1.0 },
  large_scale: { min: 0.5, max: 2.0, default: 1.0 },
  terrain_exaggeration: { min: 0.0, max: 3.0, default: 1.0 },
  road_scale: { min: 0.5, max: 2.0, default: 1.0 },
  engravings: {
    size_mm: { min: 1.5, max: 8.0, default: 4.0 },
    depth_mm: { min: 0.2, max: 1.5, default: 0.4 },
  },
  north_arrow: {
    size_mm: { min: 2.0, max: 6.0, default: 4.0 },
  },
  scale_bar: {
    length_m: { min: 10, max: 5000, default: 500 },
  },
} as const;

/**
 * Every item-count and string-length cap the contract declares, so a UI
 * enforcing one never re-types the number at its call site (the drift
 * PARAM_RANGES exists to prevent, for the bounds PARAM_RANGES has no room
 * for: it carries only fragments with both a minimum and a maximum).
 */
export const PARAM_LIMITS = {
  city_label: { max_length: 64 },
  engravings: {
    max_items: 8,
    text: { max_length: 64 },
  },
  underside_mark: {
    template: { max_length: 64 },
  },
  hero_building_ids: { max_items: 12 },
} as const;
