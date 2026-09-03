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
  name?: string;
  osm_id?: string;
  kind?: string;
}

export interface Road {
  id: string;
  path: Point[];
  width_m: number;
  class: "motorway" | "primary" | "secondary" | "residential" | "service" | "path";
  name?: string;
  osm_id?: string;
  kind?: string;
}

export interface AreaFeature {
  ring: Ring;
  holes: Ring[];
  name?: string;
  osm_id?: string;
  kind?: string;
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
  edge: "top" | "bottom" | "left" | "right" | "underside";
  align?: "start" | "center" | "end";
  text: string;
  mode?: "engrave" | "emboss" | "inlay";
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

export interface Place {
  country?: string;
  state?: string;
  neighbourhood?: string;
  author?: string;
}

export interface RoadRegion {
  depth_mm?: number;
  proud_mm?: number;
}

export interface WaterRegion {
  depth_mm?: number;
  proud_mm?: number;
}

export interface ParkRegion {
  depth_mm?: number;
  proud_mm?: number;
}

export interface RailRegion {
  depth_mm?: number;
  proud_mm?: number;
  width_m?: number;
}

export interface Regions {
  roads?: RoadRegion;
  water?: WaterRegion;
  parks?: ParkRegion;
  rail?: RailRegion;
  building_skirt_mm?: number;
}

export interface RegionSlots {
  base?: number;
  frame?: number;
  matting?: number;
  buildings?: number;
  hero_building?: number;
  roads?: number;
  water?: number;
  parks?: number;
  rail?: number;
  lettering?: number;
  attribution?: number;
}

export interface RegionColors {
  base?: string;
  frame?: string;
  matting?: string;
  buildings?: string;
  hero_building?: string;
  roads?: string;
  water?: string;
  parks?: string;
  rail?: string;
  lettering?: string;
  attribution?: string;
}

export interface Tint {
  enabled?: boolean;
  hue_range_deg?: number;
  lightness_range?: number;
  seed?: number;
}

export interface Gradient {
  enabled?: boolean;
  slots?: number[];
}

export interface Colour {
  region_slots?: RegionSlots;
  region_colors?: RegionColors;
  palette?: string;
  tint?: Tint;
  gradient?: Gradient;
  preview_theme?: "dark" | "light";
}

export interface CustomProfile {
  plate_x_mm?: number;
  plate_y_mm?: number;
  max_height_mm?: number;
  nozzle_mm?: number;
  slots?: number;
  change_gcode?: string;
}

export interface Terrain {
  enabled?: boolean;
  smoothing?: number;
}

export interface TypeDefaults {
  house?: number;
  apartments?: number;
  commercial?: number;
  retail?: number;
  industrial?: number;
  garage?: number;
}

export interface Heights {
  floor_height_m?: number;
  unknown_default_m?: number;
  type_defaults?: TypeDefaults;
}

export interface Bridges {
  enabled?: boolean;
  clearance_mm?: number;
  abutments?: boolean;
}

export interface HeightExaggeration {
  multiplier?: number;
  curve?: number;
}

export interface HeroAuto {
  enabled?: boolean;
  count?: number;
}

export interface Tiling {
  enabled?: boolean;
  cols?: number;
  rows?: number;
  joint?: "dovetail" | "pin";
  tolerance_mm?: number;
  index_mark?: boolean;
}

export interface ShadowGap {
  enabled?: boolean;
  width_mm?: number;
  depth_mm?: number;
}

export interface Matting {
  enabled?: boolean;
  width_mm?: number;
  proud_mm?: number;
}

export interface Separate {
  enabled?: boolean;
  mount?: "snap" | "magnet";
  tolerance_mm?: number;
}

export interface Texture {
  pattern?: "none" | "brush" | "knurl" | "hatch" | "dots";
  scale_mm?: number;
  depth_mm?: number;
}

export interface FrameStyle {
  profile?: "plain" | "chamfer" | "stepped" | "bevel_in" | "bullnose" | "ogee" | "floating";
  corner?: "square" | "mitred" | "rounded";
  corner_radius_mm?: number;
  lip_depth_mm?: number;
  shadow_gap?: ShadowGap;
  matting?: Matting;
  separate?: Separate;
  texture?: Texture;
}

export interface HangerMagnet {
  diameter_mm?: number;
  thickness_mm?: number;
  count?: number;
}

export interface ObjectOverride {
  osm_id: string;
  layer: "building" | "road" | "water" | "green";
  hidden?: boolean;
  height_scale?: number;
  hero?: "inherit" | "on" | "off";
  tint?: string;
  slot?: number;
  color?: string;
  road_mode?: "inherit" | "engrave" | "emboss" | "off";
  width_scale?: number;
  raise_mm?: number;
}

export interface Label {
  target_osm_id: string;
  layer: "building" | "road" | "water" | "green";
  surface: "building_top" | "ground";
  u?: number;
  v?: number;
  rotation_deg?: number;
  size_mm?: number;
  mode?: "engrave" | "emboss";
  depth_mm?: number;
  font?: "sans" | "serif" | "mono";
  text?: string;
  follow?: boolean;
}

export interface PrintParams {
  schema_version?: 2 | 3 | 4;
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
  hanger?: "none" | "keyhole" | "magnets" | "cleat" | "easel";
  underside_mark?: UndersideMark;
  hero_building_ids?: string[];
  hero_mode?: "true_height" | "own_color" | "both";
  place?: Place;
  regions?: Regions;
  colour?: Colour;
  printer_profile?: "custom" | "bambu-h2s" | "bambu-p1s" | "bambu-x1c" | "bambu-a1" | "bambu-a1-mini" | "prusa-mk4" | "prusa-mini" | "ender-3";
  custom_profile?: CustomProfile;
  export_target?: "bambu-3mf" | "generic-3mf" | "stl" | "stl-parts-zip" | "obj" | "step" | "color-change-3mf";
  terrain?: Terrain;
  heights?: Heights;
  bridges?: Bridges;
  height_exaggeration?: HeightExaggeration;
  hero_auto?: HeroAuto;
  tiling?: Tiling;
  frame_style?: FrameStyle;
  hanger_magnet?: HangerMagnet;
  object_overrides?: ObjectOverride[];
  labels?: Label[];
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
  schema_version: 4,
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
  place: {
    country: "",
    state: "",
    neighbourhood: "",
    author: "",
  },
  regions: {
    roads: {
      depth_mm: 0.6,
      proud_mm: -0.2,
    },
    water: {
      depth_mm: 1.0,
      proud_mm: -0.5,
    },
    parks: {
      depth_mm: 0.4,
      proud_mm: 0.0,
    },
    rail: {
      depth_mm: 0.4,
      proud_mm: 0.3,
      width_m: 6.0,
    },
    building_skirt_mm: 0.3,
  },
  colour: {
    region_slots: {
      base: 1,
      frame: 1,
      matting: 1,
      buildings: 2,
      hero_building: 4,
      roads: 4,
      water: 3,
      parks: 4,
      rail: 4,
      lettering: 4,
      attribution: 1,
    },
    region_colors: {
      base: "#D8D3C6",
      frame: "#3A3A3A",
      matting: "#EDE9E0",
      buildings: "#D8D3C6",
      hero_building: "#E3A72F",
      roads: "#3A3A3A",
      water: "#2F7FC1",
      parks: "#5A9E4B",
      rail: "#6B6B6B",
      lettering: "#E3A72F",
      attribution: "#D8D3C6",
    },
    palette: "default",
    tint: {
      enabled: false,
      hue_range_deg: 12,
      lightness_range: 0.12,
      seed: 1,
    },
    gradient: {
      enabled: false,
      slots: [2, 3],
    },
    preview_theme: "dark",
  },
  printer_profile: "custom",
  custom_profile: {
    plate_x_mm: 256,
    plate_y_mm: 256,
    max_height_mm: 60,
    nozzle_mm: 0.4,
    slots: 4,
    change_gcode: "M600",
  },
  export_target: "bambu-3mf",
  terrain: {
    enabled: false,
    smoothing: 1,
  },
  heights: {
    floor_height_m: 3.0,
    unknown_default_m: 8.0,
    type_defaults: {
      house: 6,
      apartments: 15,
      commercial: 12,
      retail: 6,
      industrial: 8,
      garage: 3,
    },
  },
  bridges: {
    enabled: true,
    clearance_mm: 1.0,
    abutments: true,
  },
  height_exaggeration: {
    multiplier: 1.0,
    curve: 0.0,
  },
  hero_auto: {
    enabled: false,
    count: 3,
  },
  tiling: {
    enabled: false,
    cols: 1,
    rows: 1,
    joint: "dovetail",
    tolerance_mm: 0.15,
    index_mark: true,
  },
  frame_style: {
    profile: "plain",
    corner: "square",
    corner_radius_mm: 3,
    lip_depth_mm: 0.4,
    shadow_gap: {
      enabled: false,
      width_mm: 1.0,
      depth_mm: 0.8,
    },
    matting: {
      enabled: false,
      width_mm: 6,
      proud_mm: 0.4,
    },
    separate: {
      enabled: false,
      mount: "snap",
      tolerance_mm: 0.2,
    },
    texture: {
      pattern: "none",
      scale_mm: 1.0,
      depth_mm: 0.2,
    },
  },
  hanger_magnet: {
    diameter_mm: 6,
    thickness_mm: 2,
    count: 2,
  },
  object_overrides: [],
  labels: [],
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
  regions: {
    roads: {
      depth_mm: { min: 0.2, max: 3.0, default: 0.6 },
      proud_mm: { min: -2.0, max: 2.0, default: -0.2 },
    },
    water: {
      depth_mm: { min: 0.2, max: 3.0, default: 1.0 },
      proud_mm: { min: -2.0, max: 2.0, default: -0.5 },
    },
    parks: {
      depth_mm: { min: 0.2, max: 3.0, default: 0.4 },
      proud_mm: { min: -2.0, max: 2.0, default: 0.0 },
    },
    rail: {
      depth_mm: { min: 0.2, max: 3.0, default: 0.4 },
      proud_mm: { min: -2.0, max: 2.0, default: 0.3 },
      width_m: { min: 2, max: 20, default: 6.0 },
    },
    building_skirt_mm: { min: 0, max: 1, default: 0.3 },
  },
  colour: {
    region_slots: {
      base: { min: 1, max: 16, default: 1 },
      frame: { min: 1, max: 16, default: 1 },
      matting: { min: 1, max: 16, default: 1 },
      buildings: { min: 1, max: 16, default: 2 },
      hero_building: { min: 1, max: 16, default: 4 },
      roads: { min: 1, max: 16, default: 4 },
      water: { min: 1, max: 16, default: 3 },
      parks: { min: 1, max: 16, default: 4 },
      rail: { min: 1, max: 16, default: 4 },
      lettering: { min: 1, max: 16, default: 4 },
      attribution: { min: 1, max: 16, default: 1 },
    },
    tint: {
      hue_range_deg: { min: 0, max: 60, default: 12 },
      lightness_range: { min: 0, max: 0.5, default: 0.12 },
    },
  },
  custom_profile: {
    plate_x_mm: { min: 100, max: 400, default: 256 },
    plate_y_mm: { min: 100, max: 400, default: 256 },
    max_height_mm: { min: 20, max: 500, default: 60 },
    nozzle_mm: { min: 0.2, max: 1.0, default: 0.4 },
    slots: { min: 1, max: 16, default: 4 },
  },
  terrain: {
    smoothing: { min: 0, max: 5, default: 1 },
  },
  heights: {
    floor_height_m: { min: 2, max: 5, default: 3.0 },
    unknown_default_m: { min: 2, max: 60, default: 8.0 },
  },
  bridges: {
    clearance_mm: { min: 0, max: 5, default: 1.0 },
  },
  height_exaggeration: {
    multiplier: { min: 0.25, max: 4, default: 1.0 },
    curve: { min: 0, max: 1, default: 0.0 },
  },
  hero_auto: {
    count: { min: 1, max: 12, default: 3 },
  },
  tiling: {
    cols: { min: 1, max: 6, default: 1 },
    rows: { min: 1, max: 6, default: 1 },
    tolerance_mm: { min: 0, max: 1, default: 0.15 },
  },
  frame_style: {
    corner_radius_mm: { min: 0, max: 20, default: 3 },
    lip_depth_mm: { min: 0, max: 3, default: 0.4 },
    shadow_gap: {
      width_mm: { min: 0.4, max: 5, default: 1.0 },
      depth_mm: { min: 0.2, max: 5, default: 0.8 },
    },
    matting: {
      width_mm: { min: 1, max: 30, default: 6 },
      proud_mm: { min: 0, max: 3, default: 0.4 },
    },
    separate: {
      tolerance_mm: { min: 0, max: 1, default: 0.2 },
    },
    texture: {
      scale_mm: { min: 0.3, max: 5, default: 1.0 },
      depth_mm: { min: 0.05, max: 1, default: 0.2 },
    },
  },
  hanger_magnet: {
    diameter_mm: { min: 3, max: 20, default: 6 },
    thickness_mm: { min: 1, max: 10, default: 2 },
    count: { min: 1, max: 8, default: 2 },
  },
  object_overrides: {
    height_scale: { min: 0.1, max: 4.0, default: 1.0 },
    slot: { min: 0, max: 16, default: 0 },
    width_scale: { min: 0.25, max: 4.0, default: 1.0 },
    raise_mm: { min: -2.0, max: 2.0, default: 0.0 },
  },
  labels: {
    u: { min: 0, max: 1, default: 0.5 },
    v: { min: 0, max: 1, default: 0.5 },
    rotation_deg: { min: -180, max: 180, default: 0 },
    size_mm: { min: 1.5, max: 8.0, default: 4.0 },
    depth_mm: { min: 0.2, max: 1.5, default: 0.4 },
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
  place: {
    country: { max_length: 64 },
    state: { max_length: 64 },
    neighbourhood: { max_length: 64 },
    author: { max_length: 64 },
  },
  colour: {
    palette: { max_length: 32 },
    gradient: {
      slots: { max_items: 16 },
    },
  },
  object_overrides: {
    max_items: 24,
    osm_id: { max_length: 32 },
  },
  labels: {
    max_items: 12,
    target_osm_id: { max_length: 32 },
    text: { max_length: 64 },
  },
} as const;

/**
 * Every leaf of PrintParams as a dotted path, in schema order: nested objects
 * expanded (`frame_style.shadow_gap.width_mm`), arrays of objects as
 * `engravings[].text`, arrays of scalars as one leaf (`hero_building_ids`).
 * The pipeline stage registry declares which of these each stage reads and
 * `lib/engine/pipeline/graph.test.ts` checks every one is claimed, so a schema
 * addition without a stage claim fails CI (DECISIONS [V3.1-P1-4]).
 */
export const PRINT_PARAM_LEAF_PATHS = [
  "schema_version",
  "plate_mm",
  "base_thickness_mm",
  "nozzle_mm",
  "small_scale",
  "large_scale",
  "terrain_exaggeration",
  "road_mode",
  "road_scale",
  "trees",
  "water",
  "frame",
  "city_label",
  "color_mode",
  "part_colors.base",
  "part_colors.frame",
  "part_colors.buildings",
  "part_colors.roads",
  "part_colors.water",
  "part_colors.green",
  "part_colors.trees",
  "engravings[].edge",
  "engravings[].align",
  "engravings[].text",
  "engravings[].mode",
  "engravings[].size_mm",
  "engravings[].depth_mm",
  "engravings[].font",
  "north_arrow.enabled",
  "north_arrow.corner",
  "north_arrow.size_mm",
  "scale_bar.enabled",
  "scale_bar.edge",
  "scale_bar.length_mode",
  "scale_bar.length_m",
  "hanger",
  "underside_mark.enabled",
  "underside_mark.template",
  "hero_building_ids",
  "hero_mode",
  "place.country",
  "place.state",
  "place.neighbourhood",
  "place.author",
  "regions.roads.depth_mm",
  "regions.roads.proud_mm",
  "regions.water.depth_mm",
  "regions.water.proud_mm",
  "regions.parks.depth_mm",
  "regions.parks.proud_mm",
  "regions.rail.depth_mm",
  "regions.rail.proud_mm",
  "regions.rail.width_m",
  "regions.building_skirt_mm",
  "colour.region_slots.base",
  "colour.region_slots.frame",
  "colour.region_slots.matting",
  "colour.region_slots.buildings",
  "colour.region_slots.hero_building",
  "colour.region_slots.roads",
  "colour.region_slots.water",
  "colour.region_slots.parks",
  "colour.region_slots.rail",
  "colour.region_slots.lettering",
  "colour.region_slots.attribution",
  "colour.region_colors.base",
  "colour.region_colors.frame",
  "colour.region_colors.matting",
  "colour.region_colors.buildings",
  "colour.region_colors.hero_building",
  "colour.region_colors.roads",
  "colour.region_colors.water",
  "colour.region_colors.parks",
  "colour.region_colors.rail",
  "colour.region_colors.lettering",
  "colour.region_colors.attribution",
  "colour.palette",
  "colour.tint.enabled",
  "colour.tint.hue_range_deg",
  "colour.tint.lightness_range",
  "colour.tint.seed",
  "colour.gradient.enabled",
  "colour.gradient.slots",
  "colour.preview_theme",
  "printer_profile",
  "custom_profile.plate_x_mm",
  "custom_profile.plate_y_mm",
  "custom_profile.max_height_mm",
  "custom_profile.nozzle_mm",
  "custom_profile.slots",
  "custom_profile.change_gcode",
  "export_target",
  "terrain.enabled",
  "terrain.smoothing",
  "heights.floor_height_m",
  "heights.unknown_default_m",
  "heights.type_defaults.house",
  "heights.type_defaults.apartments",
  "heights.type_defaults.commercial",
  "heights.type_defaults.retail",
  "heights.type_defaults.industrial",
  "heights.type_defaults.garage",
  "bridges.enabled",
  "bridges.clearance_mm",
  "bridges.abutments",
  "height_exaggeration.multiplier",
  "height_exaggeration.curve",
  "hero_auto.enabled",
  "hero_auto.count",
  "tiling.enabled",
  "tiling.cols",
  "tiling.rows",
  "tiling.joint",
  "tiling.tolerance_mm",
  "tiling.index_mark",
  "frame_style.profile",
  "frame_style.corner",
  "frame_style.corner_radius_mm",
  "frame_style.lip_depth_mm",
  "frame_style.shadow_gap.enabled",
  "frame_style.shadow_gap.width_mm",
  "frame_style.shadow_gap.depth_mm",
  "frame_style.matting.enabled",
  "frame_style.matting.width_mm",
  "frame_style.matting.proud_mm",
  "frame_style.separate.enabled",
  "frame_style.separate.mount",
  "frame_style.separate.tolerance_mm",
  "frame_style.texture.pattern",
  "frame_style.texture.scale_mm",
  "frame_style.texture.depth_mm",
  "hanger_magnet.diameter_mm",
  "hanger_magnet.thickness_mm",
  "hanger_magnet.count",
  "object_overrides[].osm_id",
  "object_overrides[].layer",
  "object_overrides[].hidden",
  "object_overrides[].height_scale",
  "object_overrides[].hero",
  "object_overrides[].tint",
  "object_overrides[].slot",
  "object_overrides[].color",
  "object_overrides[].road_mode",
  "object_overrides[].width_scale",
  "object_overrides[].raise_mm",
  "labels[].target_osm_id",
  "labels[].layer",
  "labels[].surface",
  "labels[].u",
  "labels[].v",
  "labels[].rotation_deg",
  "labels[].size_mm",
  "labels[].mode",
  "labels[].depth_mm",
  "labels[].font",
  "labels[].text",
  "labels[].follow",
] as const;

export type PrintParamPath = (typeof PRINT_PARAM_LEAF_PATHS)[number];
