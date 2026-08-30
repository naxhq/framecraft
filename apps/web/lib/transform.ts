/**
 * Shared print-transform math for FrameCraft -- TypeScript mirror.
 *
 * This file is a function-for-function mirror of
 * `services/bake/app/geom/transform.py`. Same names (snake_case on purpose, so
 * a reviewer can diff the two files side by side), same constants, same
 * formulas, same edge cases. `apps/web/lib/transform.test.ts` and
 * `services/bake/tests/test_transform.py` both assert against
 * `fixtures/parity-expected.json`, so the two implementations cannot drift by
 * more than 0.01 mm without a red test.
 *
 * Nothing in the editor -- not the preview, not the panel, not the warnings --
 * may recompute a scale, a threshold or a printed height on its own. Import it
 * from here.
 *
 * Units: `*_mm` returns PRINT millimetres, `*_m` / `*_ground_m` returns GROUND
 * metres, and `scale` is always millimetres of print per metre of ground.
 */

import type { Bounds, Building, PrintParams, Road, Tree } from "./contracts";

// ---------------------------------------------------------------------------
// Constants, all from 04_PRINTABILITY_SPEC.md.
// ---------------------------------------------------------------------------

/** Stage 2.2 border lip width, mm. Enters the scale formula when frame is on. */
export const FRAME_WIDTH_MM = 6.0;
/** Stage 2.2 border lip rise above the base top, mm. */
export const FRAME_LIP_MM = 2.0;
/** Stage 2.1 bottom outer edge chamfer (45 deg), mm. Bake only. */
export const CHAMFER_MM = 0.6;
/** Stage 2.3 deliberate building/base overlap so the union is unambiguous, mm. */
export const BUILDING_OVERLAP_MM = 0.2;
/** Stage 2.3 clamp on printed building height, mm. */
export const MIN_BUILDING_HEIGHT_MM = 0.6;
/** Stage 1 water recess below the base top, mm. */
export const WATER_RECESS_MM = 0.5;
/** Stage 1 green raise above the base top, mm. */
export const GREEN_RAISE_MM = 0.3;
/** Stage 1 road emboss height above the base top, mm. */
export const EMBOSS_MM = 0.4;
/** Stage 1 upper bound on engrave depth, mm (the other bound is base/3). */
export const ENGRAVE_MAX_MM = 0.6;
/** Known-trap list: inset the crop square before the final clip, mm. */
export const CROP_INSET_MM = 0.05;
/** Stage 1 trees: minimum printed site radius, mm. */
export const TREE_MIN_RADIUS_MM = 0.5;
/** Stage 1 trees: cone height as a multiple of the site radius. */
export const TREE_HEIGHT_FACTOR = 3.0;
/** Stage 1 trees: hard cap, keeping the largest. */
export const TREE_CAP = 2000;
/**
 * Stage 1 trees: "model as an 8-sided cone". The side count is part of the
 * PRINTED size of a tree (an 8-gon of circumradius r is only 2 r cos(pi/8) wide
 * across its flats), so `tree_min_radius_mm` needs it.
 */
export const TREE_SIDES = 8;
/**
 * Stage 4 "Bounding box": Z must stay under this many millimetres. The bake
 * refuses a model at or above it before it builds anything (its
 * `ModelTooTallError`), so the editor disables Bake on the same number.
 */
export const MAX_HEIGHT_MM = 60.0;
/** 02: is_tall is height_m >= 40 and is computed once in the SceneGraph. */
export const TALL_BUILDING_M = 40.0;

/** Threshold multipliers on the nozzle diameter (04, "Derived thresholds"). */
export const MIN_WALL_NOZZLES = 2.0;
export const MIN_GAP_NOZZLES = 1.5;
export const MIN_DETAIL_NOZZLES = 1.0;

// ---------------------------------------------------------------------------
// Structural types
// ---------------------------------------------------------------------------

export type ParamsLike = PrintParams;
export type BuildingLike = Pick<Building, "height_m" | "is_tall">;
export type RoadLike = Pick<Road, "width_m">;
export type TreeLike = Pick<Tree, "radius_m">;
export type BoundsLike = Bounds;

/**
 * Structural view of a SceneGraph for the height guard only. `bounds` is
 * deliberately absent: `predicted_top_mm` takes the ground radius as an
 * argument so a caller that already resolved it does not resolve it twice.
 */
export interface SceneLike {
  buildings: ReadonlyArray<BuildingLike>;
  trees: ReadonlyArray<TreeLike>;
}

/** A ring following the frozen convention: first vertex NOT repeated as last. */
export type RingLike = ReadonlyArray<ReadonlyArray<number>>;

/** Minimum-feature thresholds expressed in GROUND metres. */
export interface Thresholds {
  min_wall: number;
  min_gap: number;
  min_detail: number;
}

/** An axis-aligned square region of the plate, in print millimetres. */
export interface Extents {
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
  size: number;
}

/** The border lip, in print millimetres. `enabled` mirrors params.frame. */
export interface FrameGeometry {
  enabled: boolean;
  width_mm: number;
  outer_half_mm: number;
  inner_half_mm: number;
  bottom_mm: number;
  top_mm: number;
}

/** `[area_m2, perimeter_m, char_width_m, dilation_m]`. */
export type FootprintMetrics = [number, number, number, number];

// ---------------------------------------------------------------------------
// Scale and thresholds
// ---------------------------------------------------------------------------

/** Plate width available to the model, mm: `plate - (2*6 if frame else 0)`. */
export function usable_span_mm(params: ParamsLike): number {
  return params.plate_mm - (params.frame ? 2.0 * FRAME_WIDTH_MM : 0.0);
}

/**
 * Print millimetres per ground metre.
 *
 * 04 writes `scale = usable / (span_m * 1000)` as a dimensionless mm/mm ratio;
 * this returns the same quantity times 1000 because every downstream formula
 * in 04 immediately multiplies by 1000 again. 1.8 km on a 180 mm plate with
 * the frame off is 1:10000, i.e. 0.1 mm/m.
 */
export function scale_mm_per_m(params: ParamsLike, radius_m: number): number {
  const span_m = 2.0 * radius_m;
  if (!(span_m > 0.0)) {
    throw new Error("radius_m must be positive");
  }
  return usable_span_mm(params) / span_m;
}

/**
 * Ground radius implied by a SceneGraph's bounds, in metres.
 *
 * The preview scales by the radius the *scene* was built with, not by whatever
 * the radius slider currently reads, or a stale scene renders at the wrong size.
 */
export function radius_m_from_bounds(bounds: BoundsLike): number {
  const width = bounds.max_x - bounds.min_x;
  const height = bounds.max_y - bounds.min_y;
  return Math.max(width, height) / 2.0;
}

/** Minimum wall / gap / detail sizes converted to GROUND metres. */
export function thresholds_ground_m(params: ParamsLike, scale: number): Thresholds {
  if (!(scale > 0.0)) {
    throw new Error("scale must be positive");
  }
  const nozzle = params.nozzle_mm;
  return {
    min_wall: (MIN_WALL_NOZZLES * nozzle) / scale,
    min_gap: (MIN_GAP_NOZZLES * nozzle) / scale,
    min_detail: (MIN_DETAIL_NOZZLES * nozzle) / scale,
  };
}

/**
 * Vertical scale applied to terrain elevation.
 *
 * Terrain from DEM is out of scope for the MVP (01) and the heightmap is flat,
 * so this is 1.0 for every input. `terrain_exaggeration` is accepted and
 * carried through both implementations identically so the parameter, the code
 * path and the parity test all exist the day the DEM fetcher is switched on.
 */
export function terrain_z_scale(params: ParamsLike): number {
  void params.terrain_exaggeration;
  return 1.0;
}

/** Print height of a terrain sample, mm above the base top. Always 0 in MVP. */
export function terrain_z_mm(
  elevation_m: number,
  params: ParamsLike,
  scale: number,
): number {
  return elevation_m * scale * terrain_z_scale(params);
}

// ---------------------------------------------------------------------------
// Base plate and frame
// ---------------------------------------------------------------------------

/** Z of the top face of the base slab, mm. The slab starts at z = 0. */
export function base_top_mm(params: ParamsLike): number {
  return params.base_thickness_mm;
}

/** Outer extents of the printed plate, centred on the origin. */
export function plate_extents_mm(params: ParamsLike): Extents {
  const half = params.plate_mm / 2.0;
  return { min_x: -half, min_y: -half, max_x: half, max_y: half, size: params.plate_mm };
}

/**
 * Region the city geometry may occupy, inset by CROP_INSET_MM: the `usable`
 * square minus 04's 0.05 mm inset, which keeps a footprint landing exactly on
 * the crop edge from producing a zero-thickness wall.
 */
export function content_extents_mm(params: ParamsLike): Extents {
  const half = usable_span_mm(params) / 2.0 - CROP_INSET_MM;
  return { min_x: -half, min_y: -half, max_x: half, max_y: half, size: 2.0 * half };
}

/** The border lip. `enabled` is false when the frame toggle is off. */
export function frame_geometry_mm(params: ParamsLike): FrameGeometry {
  const outer_half = params.plate_mm / 2.0;
  const top = base_top_mm(params);
  return {
    enabled: Boolean(params.frame),
    width_mm: FRAME_WIDTH_MM,
    outer_half_mm: outer_half,
    inner_half_mm: outer_half - FRAME_WIDTH_MM,
    bottom_mm: top,
    top_mm: top + FRAME_LIP_MM,
  };
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

/** The height multiplier for this building. `is_tall` comes from the SceneGraph. */
export function building_height_scale(
  building: BuildingLike,
  params: ParamsLike,
): number {
  return building.is_tall ? params.large_scale : params.small_scale;
}

/** Z of the roof, mm. 04 stage 2.3, including the 0.6 mm clamp. */
export function building_top_mm(
  building: BuildingLike,
  params: ParamsLike,
  scale: number,
): number {
  const raw = building.height_m * scale * building_height_scale(building, params);
  return base_top_mm(params) + Math.max(MIN_BUILDING_HEIGHT_MM, raw);
}

/**
 * Z the bake extrudes buildings FROM, mm: `base_top - 0.2`.
 *
 * The 0.2 mm overlap makes the union with the base slab unambiguous. The
 * preview draws buildings from `base_top_mm` instead -- there is no union to
 * disambiguate and the overlap would be hidden inside the slab anyway.
 */
export function building_bottom_mm(params: ParamsLike): number {
  return base_top_mm(params) - BUILDING_OVERLAP_MM;
}

/** Absolute shoelace area of an implicitly-closed ring, m^2. */
export function ring_area_m2(ring: RingLike): number {
  const n = ring.length;
  if (n < 3) return 0.0;
  let total = 0.0;
  for (let i = 0; i < n; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    total += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(total) / 2.0;
}

/** Perimeter of an implicitly-closed ring, m. */
export function ring_perimeter_m(ring: RingLike): number {
  const n = ring.length;
  if (n < 2) return 0.0;
  let total = 0.0;
  for (let i = 0; i < n; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total;
}

/** Hydraulic diameter `4 * area / perimeter` (04 stage 1, buildings 1). */
export function building_char_width_m(area_m2: number, perimeter_m: number): number {
  if (!(perimeter_m > 0.0)) return 0.0;
  return (4.0 * area_m2) / perimeter_m;
}

/** Buffer distance that brings a thin footprint up to the min wall, never < 0. */
export function building_dilation_m(
  char_width_m: number,
  thresholds: Thresholds,
): number {
  return Math.max(0.0, (thresholds.min_wall - char_width_m) / 2.0);
}

/**
 * 04 stage 1, buildings 3: drop anything still smaller than `min_detail^2`.
 *
 * The exact post-dilation area needs a real 2D buffer, which neither side runs
 * here; both approximate it as a square of the same area grown by `2 * d`.
 */
export function building_dropped(
  area_m2: number,
  dilation_m: number,
  thresholds: Thresholds,
): boolean {
  const side = Math.sqrt(area_m2) + 2.0 * dilation_m;
  return side * side < thresholds.min_detail * thresholds.min_detail;
}

// ---------------------------------------------------------------------------
// Roads
// ---------------------------------------------------------------------------

/**
 * Printed road width in GROUND metres, after the min-feature clamp. 04 stage 1
 * roads 1 buffers by `max(width_m, min_wall_ground)/2`; the road-scale slider
 * multiplies the OSM width *before* that clamp (01).
 */
export function road_width_ground_m(
  road: RoadLike,
  params: ParamsLike,
  thresholds: Thresholds,
): number {
  return Math.max(road.width_m * params.road_scale, thresholds.min_wall);
}

/**
 * Road surface Z relative to the base top, mm.
 * engrave -> `-min(0.6, base/3)`, emboss -> `+0.4`, off -> `null`.
 */
export function road_z_mm(params: ParamsLike): number | null {
  const mode = params.road_mode;
  if (mode === "off") return null;
  if (mode === "emboss") return EMBOSS_MM;
  if (mode === "engrave") {
    return -Math.min(ENGRAVE_MAX_MM, params.base_thickness_mm / 3.0);
  }
  throw new Error(`unknown road_mode: ${String(mode)}`);
}

// ---------------------------------------------------------------------------
// Water and green
// ---------------------------------------------------------------------------

/** Water Z relative to the base top, mm, or null when the toggle is off. */
export function water_z_mm(params: ParamsLike): number | null {
  if (!params.water) return null;
  return -WATER_RECESS_MM;
}

/** Green Z relative to the base top, mm. PrintParams has no green toggle. */
export function green_z_mm(params: ParamsLike): number {
  void params;
  return GREEN_RAISE_MM;
}

/** 04 stage 1: water/green under `min_detail_ground ** 2` in area is dropped. */
export function area_dropped(area_m2: number, thresholds: Thresholds): boolean {
  return area_m2 < thresholds.min_detail * thresholds.min_detail;
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

/** Printed site radius of a tree, mm. */
export function tree_radius_mm(tree: TreeLike, scale: number): number {
  return tree.radius_m * scale;
}

/**
 * 04 stage 1, trees: only emit when the scaled radius reaches 0.5 mm.
 *
 * The "does not intersect a building or road footprint" half of 04's rule is a
 * 2D predicate the bake evaluates with shapely; the preview does not run it,
 * which is one of the documented preview approximations.
 */
export function tree_visible(tree: TreeLike, scale: number): boolean {
  return tree_radius_mm(tree, scale) >= TREE_MIN_RADIUS_MM;
}

/**
 * Smallest printed site radius an 8-gon cone may have, mm.
 *
 * 04 caps the tree radius at 0.5 mm printed and says nothing about the nozzle,
 * but an 8-gon of circumradius `r` is only `2 * r * cos(pi/8)` wide across its
 * flats, so at the 0.5 mm floor a tree's *base* is 0.92 mm -- under one extruded
 * bead for every nozzle from 0.5 mm up. The floor is therefore raised to
 * whatever puts a full minimum wall across the base of the cone; at the default
 * 0.4 mm nozzle that is 0.433 mm, so 04's 0.5 mm still binds and nothing
 * changes.
 *
 * The preview applies it so it never draws a tree the bake drops.
 */
export function tree_min_radius_mm(params: ParamsLike): number {
  const by_nozzle =
    (MIN_WALL_NOZZLES * params.nozzle_mm) / (2.0 * Math.cos(Math.PI / TREE_SIDES));
  return Math.max(TREE_MIN_RADIUS_MM, by_nozzle);
}

/**
 * `tree_visible` plus the nozzle-aware floor: the predicate the bake and the
 * preview both filter on. `tree_visible` keeps its two-argument signature (it is
 * 04's literal rule and the parity fixture pins it); this one adds the printer.
 */
export function tree_visible_for(
  tree: TreeLike,
  params: ParamsLike,
  scale: number,
): boolean {
  return tree_radius_mm(tree, scale) >= tree_min_radius_mm(params);
}

/** Cone height, 3x the printed radius. */
export function tree_height_mm(tree: TreeLike, scale: number): number {
  return TREE_HEIGHT_FACTOR * tree_radius_mm(tree, scale);
}

/**
 * Indices of the trees that actually get emitted: visible only, capped at
 * TREE_CAP keeping the largest radius, ties broken on the original index so
 * both implementations agree exactly. Returned in ascending index order.
 */
export function select_tree_indices(
  trees: ReadonlyArray<TreeLike>,
  scale: number,
): number[] {
  const visible: number[] = [];
  for (let i = 0; i < trees.length; i += 1) {
    if (tree_visible(trees[i], scale)) visible.push(i);
  }
  visible.sort((a, b) => {
    const d = trees[b].radius_m - trees[a].radius_m;
    return d !== 0 ? d : a - b;
  });
  return visible.slice(0, TREE_CAP).sort((a, b) => a - b);
}

/**
 * `select_tree_indices` with the nozzle-aware floor applied. Same ordering
 * rules, so at the default nozzle (floor 0.433 mm, where 04's 0.5 mm still
 * binds) it returns exactly the same indices.
 */
export function select_tree_indices_for(
  trees: ReadonlyArray<TreeLike>,
  params: ParamsLike,
  scale: number,
): number[] {
  const visible: number[] = [];
  for (let i = 0; i < trees.length; i += 1) {
    if (tree_visible_for(trees[i], params, scale)) visible.push(i);
  }
  visible.sort((a, b) => {
    const d = trees[b].radius_m - trees[a].radius_m;
    return d !== 0 ? d : a - b;
  });
  return visible.slice(0, TREE_CAP).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Convenience aggregates used by both sides
// ---------------------------------------------------------------------------

/**
 * `[area_m2, perimeter_m, char_width_m, dilation_m]` for one footprint. Holes
 * subtract from the area and add to the perimeter, which is what the hydraulic
 * diameter of a multiply-connected footprint means.
 */
export function building_footprint_metrics(
  ring: RingLike,
  holes: ReadonlyArray<RingLike>,
  thresholds: Thresholds,
): FootprintMetrics {
  let area = ring_area_m2(ring);
  let perimeter = ring_perimeter_m(ring);
  for (const hole of holes) {
    area -= ring_area_m2(hole);
    perimeter += ring_perimeter_m(hole);
  }
  area = Math.max(0.0, area);
  const char_width = building_char_width_m(area, perimeter);
  return [area, perimeter, char_width, building_dilation_m(char_width, thresholds)];
}

// ---------------------------------------------------------------------------
// Whole-model height (04 stage 4, "Bounding box")
// ---------------------------------------------------------------------------

/**
 * Highest Z the finished model can reach, mm, without building it.
 *
 * Every term is one of the functions above, i.e. exactly what the preview draws
 * with, so this number is the height the user is looking at. It is an UPPER
 * bound on the baked height: stage 1 can lower a tower (a merged block takes the
 * area-weighted 80th percentile of the heights it swallowed) and can drop a
 * footprint entirely, but nothing in the pipeline makes a solid taller.
 *
 * Trees are counted with `tree_visible` rather than `tree_visible_for` on
 * purpose: the nozzle-aware floor only ever drops trees, so ignoring it keeps
 * the bound an upper bound, and the bake's own guard reads the same number.
 */
export function predicted_top_mm(
  scene: SceneLike,
  params: ParamsLike,
  radius_m: number,
): number {
  const scale = scale_mm_per_m(params, radius_m);
  const base_top = base_top_mm(params);
  let top = base_top;
  const frame = frame_geometry_mm(params);
  if (frame.enabled) top = Math.max(top, frame.top_mm);
  for (const building of scene.buildings) {
    top = Math.max(top, building_top_mm(building, params, scale));
  }
  if (params.trees) {
    for (const tree of scene.trees) {
      if (tree_visible(tree, scale)) {
        top = Math.max(top, base_top + tree_height_mm(tree, scale));
      }
    }
  }
  return top;
}

/** True when the bake will refuse this model on 04's 60 mm Z ceiling. */
export function model_too_tall(
  scene: SceneLike,
  params: ParamsLike,
  radius_m: number,
): boolean {
  return predicted_top_mm(scene, params, radius_m) >= MAX_HEIGHT_MM;
}
