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

export interface PrintParams {
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

export const DEFAULT_PRINT_PARAMS: PrintParams = {
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
};

export const PARAM_RANGES = {
  plate_mm: { min: 100, max: 256, default: 180 },
  base_thickness_mm: { min: 2, max: 8, default: 3.0 },
  nozzle_mm: { min: 0.1, max: 1.2, default: 0.4 },
  small_scale: { min: 0.5, max: 1.5, default: 1.0 },
  large_scale: { min: 0.5, max: 2.0, default: 1.0 },
  terrain_exaggeration: { min: 0.0, max: 3.0, default: 1.0 },
  road_scale: { min: 0.5, max: 2.0, default: 1.0 },
} as const;
