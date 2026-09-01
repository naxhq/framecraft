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
import monoMetrics from "./fonts/mono.metrics.json";
import sansMetrics from "./fonts/sans.metrics.json";
import serifMetrics from "./fonts/serif.metrics.json";
import * as TOK from "./tokens";

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

/**
 * A hero building is never printed SHORTER than its true relative height, but it
 * still grows with everyone else: its multiplier is `max(1.0, the multiplier its
 * class would get)`. The floor is 1.0 because 1.0 is "true relative height" --
 * the height the SceneGraph measured, scaled by nothing.
 */
export const HERO_MIN_HEIGHT_SCALE = 1.0;
/** `hero_mode` values that give a hero its true height. */
export const HERO_TRUE_HEIGHT_MODES = ["true_height", "both"] as const;
/** `hero_mode` values that give a hero its own colour (i.e. its own 3MF part). */
export const HERO_OWN_COLOR_MODES = ["own_color", "both"] as const;
/** `color_mode` value that makes the bake write one 3MF object per layer. */
export const COLOR_MODE_PARTS = "parts";

// ---------------------------------------------------------------------------
// Structural types
// ---------------------------------------------------------------------------

export type ParamsLike = PrintParams;
/**
 * `id` is OPTIONAL, and only the hero predicates read it: a carrier that has no
 * id (a merged block on the bake side, a two-field literal in a test) is still a
 * perfectly good BuildingLike, exactly as in `transform.py`.
 */
export type BuildingLike = Pick<Building, "height_m" | "is_tall"> & {
  readonly id?: string;
};
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

/**
 * 04's `min_wall_mm = 2 * nozzle`: two perimeters, in PRINT mm.
 *
 * This is the number the bake's Stage 1 repair widens to, the number Stage 4
 * fails under nine tenths of, and the number the preview HUD divides by the
 * scale to say "widened to the X m minimum wall". It exists as a function
 * because `2 * nozzle` written out by hand in four places is four chances to
 * drop the two -- and dropping it is invisible, because `1 * nozzle` is exactly
 * `min_detail_mm`, a real threshold that looks entirely plausible in a HUD
 * string (DECISIONS [V2-P1]).
 */
export function min_wall_mm(params: ParamsLike): number {
  return MIN_WALL_NOZZLES * params.nozzle_mm;
}

/** 04's `min_gap_mm = 1.5 * nozzle`, in PRINT mm. Below this, gaps close up. */
export function min_gap_mm(params: ParamsLike): number {
  return MIN_GAP_NOZZLES * params.nozzle_mm;
}

/** 04's `min_detail_mm = 1.0 * nozzle`, in PRINT mm. Below this, drop it. */
export function min_detail_mm(params: ParamsLike): number {
  return MIN_DETAIL_NOZZLES * params.nozzle_mm;
}

/** Minimum wall / gap / detail sizes converted to GROUND metres. */
export function thresholds_ground_m(params: ParamsLike, scale: number): Thresholds {
  if (!(scale > 0.0)) {
    throw new Error("scale must be positive");
  }
  return {
    min_wall: min_wall_mm(params) / scale,
    min_gap: min_gap_mm(params) / scale,
    min_detail: min_detail_mm(params) / scale,
  };
}

/**
 * Vertical scale applied to terrain elevation.
 *
 * `params.terrain_exaggeration` (v1 field, range [0, 3], default 1.0), and
 * nothing else. This is THE ONE PLACE the exaggeration is applied
 * (`[V3-P3-G1]`): the DEM grid `lib/engine/terrain/tiles.ts` fetches stays in
 * raw metres above the tile minimum, so moving the slider re-bakes without
 * re-fetching a single tile, and no other module may multiply by it again.
 *
 * Before v3 this returned 1.0 for every input because the MVP heightmap was
 * flat. The DEM fetcher is now real, so the parameter is live. The default is
 * 1.0, so every committed parity value is unchanged.
 */
export function terrain_z_scale(params: ParamsLike): number {
  return params.terrain_exaggeration;
}

/**
 * Print height of a terrain sample, mm above the base top.
 *
 * `elevation_m` is metres above the grid minimum, so this is 0 at the lowest
 * point of the crop and the base slab keeps its full thickness there.
 */
export function terrain_z_mm(
  elevation_m: number,
  params: ParamsLike,
  scale: number,
): number {
  return elevation_m * scale * terrain_z_scale(params);
}

// ---------------------------------------------------------------------------
// Height exaggeration (PrintParams v3 `height_exaggeration`)
//
// A separate knob from `small_scale` / `large_scale`: those two multiply a
// building's height by its CLASS (tall or not), which is a step function at
// 40 m and cannot make a two-storey street readable without turning a tower
// into a spike. This one is continuous in the height itself.
// ---------------------------------------------------------------------------

/**
 * Reference height the exaggeration curve pivots about, ground metres. A
 * building of exactly this height is multiplied by `multiplier` whatever the
 * curve is, so the curve redistributes emphasis without changing the overall
 * size of the model. 50 m is about fifteen storeys: above the street wall of
 * every city this targets and well below its towers.
 */
export const HEIGHT_EXAGGERATION_REF_M = 50.0;

/**
 * How hard `curve = 1` compresses. The exponent is `1 - curve * this`, so the
 * strongest curve is a 0.4 power law: a 400 m tower gains 2.9x less than a 5 m
 * shopfront does. Bounded below 1 on purpose - at 1.0 the exponent would reach
 * 0 and every building would print at exactly the reference height.
 */
export const HEIGHT_EXAGGERATION_CURVE_STRENGTH = 0.6;

/**
 * A real building height in metres, exaggerated for printing.
 *
 * `curve = 0` is the plain linear `h * multiplier`, computed as exactly that
 * expression so a default-constructed PrintParams cannot move a single bit of
 * existing geometry. `curve` in (0, 1] compresses the tall end:
 *
 *     h' = multiplier * h_ref * (h / h_ref) ** (1 - curve * 0.6)
 *
 * which is continuous and strictly increasing in `h` for every legal `curve`,
 * exact at `h = h_ref` for every curve, and gives short buildings
 * proportionally more than tall ones (the relative gain is
 * `multiplier * (h / h_ref) ** (-0.6 * curve)`, above the multiplier below the
 * reference height and below it above).
 */
export function exaggerated_height(
  h_m: number,
  multiplier: number,
  curve: number,
  h_ref: number = HEIGHT_EXAGGERATION_REF_M,
): number {
  if (h_m <= 0.0) return 0.0;
  if (curve <= 0.0 || h_ref <= 0.0) return h_m * multiplier;
  const exponent = 1.0 - curve * HEIGHT_EXAGGERATION_CURVE_STRENGTH;
  return multiplier * h_ref * Math.pow(h_m / h_ref, exponent);
}

/**
 * The inverse of {@link exaggerated_height}.
 *
 * Given a height as the model SHOWS it (metres of unexaggerated building that
 * would print to the same roof), return the real-world height that produced
 * it, so the UI can write "at these settings a 25 m block reads as a 40 m one"
 * from measured numbers rather than from a second formula (`[V3-P3-G5]`).
 * `real_world_equivalent_m(exaggerated_height(h, m, c), m, c) === h` to within
 * floating point for every legal `m` and `c`.
 */
export function real_world_equivalent_m(
  h_m: number,
  multiplier: number,
  curve: number,
  h_ref: number = HEIGHT_EXAGGERATION_REF_M,
): number {
  if (h_m <= 0.0 || multiplier <= 0.0) return 0.0;
  if (curve <= 0.0 || h_ref <= 0.0) return h_m / multiplier;
  const exponent = 1.0 - curve * HEIGHT_EXAGGERATION_CURVE_STRENGTH;
  return h_ref * Math.pow(h_m / (multiplier * h_ref), 1.0 / exponent);
}

/** `params.height_exaggeration.multiplier`, defaulting to 1.0. */
export function height_exaggeration_multiplier(params: ParamsLike): number {
  return params.height_exaggeration?.multiplier ?? 1.0;
}

/** `params.height_exaggeration.curve`, defaulting to 0.0 (linear). */
export function height_exaggeration_curve(params: ParamsLike): number {
  return params.height_exaggeration?.curve ?? 0.0;
}

/**
 * {@link exaggerated_height} with the parameters read off `params`.
 *
 * Short-circuits to the input at the v1/v2 defaults (1.0, 0.0) so nothing
 * downstream can drift by a rounding step while the feature is off.
 */
export function exaggerated_height_for(h_m: number, params: ParamsLike): number {
  const multiplier = height_exaggeration_multiplier(params);
  const curve = height_exaggeration_curve(params);
  if (multiplier === 1.0 && curve <= 0.0) return h_m;
  return exaggerated_height(h_m, multiplier, curve);
}

/**
 * camelCase aliases for the two helpers the UI calls directly.
 *
 * Every name in this file is snake_case so a reviewer can diff it against
 * `transform.py` line by line, and that convention is not worth breaking for
 * two functions. These aliases exist because the phase 3 brief names them in
 * camelCase and a React component reads better with them (`[V3-P3-G5]`); they
 * are the same function object, not a second implementation.
 */
export const exaggeratedHeight = exaggerated_height;
export const realWorldEquivalentM = real_world_equivalent_m;

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

/**
 * Z of the roof, mm. 04 stage 2.3, including the 0.6 mm clamp.
 *
 * Hero-free by construction: `building_top_mm_for` with `is_hero=false` is this
 * exact expression, and every v1 caller keeps calling this one.
 */
export function building_top_mm(
  building: BuildingLike,
  params: ParamsLike,
  scale: number,
): number {
  return building_top_mm_for(building, params, scale, false);
}

// ---------------------------------------------------------------------------
// Hero buildings (PrintParams v2)
//
// All three params are optional on the wire, so every accessor reads through the
// v1 default: a v1 PrintParams must behave exactly as it did before hero
// buildings existed. Nothing below changes a single number while
// `hero_building_ids` is empty, which is the default.
// ---------------------------------------------------------------------------

/** The building ids the user picked, in the order they picked them. */
export function hero_ids(params: ParamsLike): string[] {
  return (params.hero_building_ids ?? []).map((id) => String(id));
}

/**
 * `true_height` | `own_color` | `both` (the v1-equivalent default is
 * `true_height`, which is a no-op while no hero is picked).
 */
export function hero_mode(params: ParamsLike): string {
  return params.hero_mode ?? "true_height";
}

/** True when the mode grants heroes their true relative height. */
export function hero_true_height(params: ParamsLike): boolean {
  return (HERO_TRUE_HEIGHT_MODES as readonly string[]).includes(hero_mode(params));
}

/** True when the mode gives each hero its own colour, i.e. its own 3MF part. */
export function hero_own_color(params: ParamsLike): boolean {
  return (HERO_OWN_COLOR_MODES as readonly string[]).includes(hero_mode(params));
}

/**
 * Ids whose PRINTED HEIGHT is the hero height. Empty unless the mode grants it,
 * so `own_color` alone changes no height. Hoisted out of the loops below because
 * a scene can hold thousands of buildings and this set holds at most twelve.
 */
export function hero_height_ids(params: ParamsLike): Set<string> {
  if (!hero_true_height(params)) return new Set<string>();
  return new Set(hero_ids(params));
}

/** True when this SceneGraph building id is one the user picked (any mode). */
export function is_hero_id(
  building_id: string | null | undefined,
  params: ParamsLike,
): boolean {
  if (building_id === null || building_id === undefined) return false;
  return hero_ids(params).includes(String(building_id));
}

/** True when this building prints at its hero height. */
export function building_is_hero(
  building: BuildingLike,
  params: ParamsLike,
): boolean {
  if (building.id === undefined || building.id === null) return false;
  return hero_height_ids(params).has(String(building.id));
}

/**
 * A hero's height multiplier: `max(1.0, the multiplier of its class)`. Never
 * reduced below its true relative height, and still grows with everyone else
 * when the user raises the slider.
 */
export function hero_height_scale(
  building: BuildingLike,
  params: ParamsLike,
): number {
  return Math.max(HERO_MIN_HEIGHT_SCALE, building_height_scale(building, params));
}

/** `building_height_scale`, or the hero rule when `is_hero`. */
export function building_height_scale_for(
  building: BuildingLike,
  params: ParamsLike,
  is_hero: boolean,
): number {
  if (is_hero) return hero_height_scale(building, params);
  return building_height_scale(building, params);
}

/**
 * `building_top_mm` with the hero multiplier when `is_hero`. `building_top_mm`
 * is this function at `is_hero=false`; the two are one expression, so the parity
 * fixture's existing `top_mm` values cannot move.
 */
export function building_top_mm_for(
  building: BuildingLike,
  params: ParamsLike,
  scale: number,
  is_hero: boolean,
): number {
  const raw =
    building.height_m * scale * building_height_scale_for(building, params, is_hero);
  return base_top_mm(params) + Math.max(MIN_BUILDING_HEIGHT_MM, raw);
}

/**
 * {@link building_top_mm_for} with `height_exaggeration` applied first.
 *
 * The exaggeration is applied to the GROUND height, before the print scale and
 * before the 0.6 mm clamp, because it is a statement about the city and not
 * about the printer: a 3 m hut must still be raised to something the nozzle
 * can lay down after being exaggerated, not before (`[V3-P3-G5]`). At the
 * defaults (multiplier 1.0, curve 0.0) `exaggerated_height_for` returns its
 * input unchanged, so this IS `building_top_mm_for`.
 */
export function building_top_mm_exaggerated(
  building: BuildingLike,
  params: ParamsLike,
  scale: number,
  is_hero: boolean,
): number {
  const height = exaggerated_height_for(building.height_m, params);
  const raw = height * scale * building_height_scale_for(building, params, is_hero);
  return base_top_mm(params) + Math.max(MIN_BUILDING_HEIGHT_MM, raw);
}

/** `single` | `parts`. The v1 default is `single`. */
export function color_mode(params: ParamsLike): string {
  return params.color_mode ?? "single";
}

/** True when the bake writes one 3MF object per layer. */
export function parts_mode(params: ParamsLike): boolean {
  return color_mode(params) === COLOR_MODE_PARTS;
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
  const by_nozzle = min_wall_mm(params) / (2.0 * Math.cos(Math.PI / TREE_SIDES));
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
 *
 * A hero building is counted at its HERO height (never below its true relative
 * height), because that is the height the bake will print and the height the
 * preview draws; a hero can only ever raise this number, so it stays an upper
 * bound.
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
  const heroes = hero_height_ids(params);
  for (const building of scene.buildings) {
    const is_hero = heroes.size > 0 && heroes.has(String(building.id ?? ""));
    top = Math.max(top, building_top_mm_for(building, params, scale, is_hero));
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

// ===========================================================================
// Frame lettering and ornaments (PrintParams v2)
//
// Mirror of the same section in `services/bake/app/geom/transform.py`. Every
// length here is PRINT MILLIMETRES: a letter cut into the frame lip is a
// printed object and the map scale does not touch its size. The only place the
// map enters is the scale bar's LABEL.
//
// This is the layout the BAKE cuts from. The preview must draw text and
// ornaments from these numbers, never from its own: a string the editor shows
// on the bottom edge at 4.28 mm is cut on the bottom edge at 4.28 mm.
// ===========================================================================

/**
 * Clearance kept between the text's ink and the two long edges of the 6 mm lip
 * band, mm. It stops a descender from cutting a notch into the inner wall of
 * the lip and leaves a rim of at least one nozzle between ink and edge.
 */
export const LIP_TEXT_MARGIN_MM = 0.5;
/** Length reserved at both ends of every edge (the 6 mm corner square + 1 mm). */
export const LIP_CORNER_RESERVE_MM = 7.0;
/** The contract's `engravings[].size_mm` bounds, repeated for the auto-fit. */
export const TEXT_MIN_SIZE_MM = 1.5;
export const TEXT_MAX_SIZE_MM = 8.0;
/** Auto-fitted sizes are floored onto this grid so the two sides cannot differ. */
export const TEXT_FIT_GRID_MM = 0.01;
/** Gap between the scale bar and anything sharing its edge, mm. */
export const ORNAMENT_GAP_MM = 2.0;

/**
 * What a stroke of text is widened to, in nozzles, per mode.
 *
 * An EMBOSSED stroke is material standing on the lip, so it gets 04's own
 * minimum wall -- two perimeters -- like every other solid in the model.
 *
 * An ENGRAVED stroke is a VOID cut into the lip, and a void is not a wall: what
 * has to be laid down is the material AROUND it. One nozzle is what makes a
 * groove appear at all (04's own `min_detail`), and it is the right target for
 * the same reason 04's road layer is not stripped of its thin parts.
 *
 * The cost of the two-nozzle alternative was MEASURED over 12 (face, string)
 * pairs at every size a 6 mm lip can hold. It is not a higher refusal rate
 * (strict 11/72 against shipped 12/76); it is LETTER SEPARATION. A 0.8 mm
 * groove eats 0.8 mm out of an inter-letter gap of about half a millimetre, and
 * for the 4 pairs of the 12 whose ink height caps the auto-fit under ~4.9 mm --
 * "Chicago" in all three faces among them -- the whole word becomes one trench
 * at every size the lip permits. See DECISIONS [V2-P5-fix].
 */
export const ENGRAVE_STROKE_NOZZLES = MIN_DETAIL_NOZZLES;
export const EMBOSS_STROKE_NOZZLES = MIN_WALL_NOZZLES;

/** Scale bar: the printed length window the 1-2-5 search aims for, mm. */
export const SCALE_BAR_MIN_MM = 15.0;
export const SCALE_BAR_MAX_MM = 40.0;
export const SCALE_BAR_LABEL_SIZE_MM = 6.0;
export const SCALE_BAR_FACE = "sans";
export const SCALE_BAR_TICK_FACTOR = 3.0;

/** North arrow: the arrowhead's width and notch, as fractions of its length. */
export const NORTH_ARROW_WIDTH_RATIO = 0.6;
export const NORTH_ARROW_NOTCH_RATIO = 0.3;

/** Underside mark. */
export const UNDERSIDE_MARK_DEPTH_MM = 0.3;
export const UNDERSIDE_MARK_SIZE_MM = 6.0;
export const UNDERSIDE_MARK_FACE = "mono";
export const UNDERSIDE_MARK_MARGIN_MM = 2.0;

/** Material that must remain above ANY underside pocket, mm. */
export const HANGER_MIN_ROOF_MM = 1.0;

/** Keyhole hanger: 8 mm round entry, 4 mm slot toward the top edge, 2 mm deep. */
export const KEYHOLE_HOLE_D_MM = 8.0;
export const KEYHOLE_SLOT_W_MM = 4.0;
export const KEYHOLE_SLOT_LEN_MM = 6.0;
export const KEYHOLE_DEPTH_MM = 2.0;
export const KEYHOLE_EDGE_MARGIN_MM = 6.0;

/** Magnet hanger: four 6.1 x 3.1 mm pockets, inset from each edge. */
export const MAGNET_D_MM = 6.1;
export const MAGNET_DEPTH_MM = 3.1;
export const MAGNET_INSET_MM = 12.0;

/**
 * French cleat mount (v3, `hanger: "cleat"`), print mm.
 *
 * A slot across the upper third of the underside whose south wall rises at 45
 * degrees, so the wall-side wedge hooks under it and so the slot itself prints
 * with no support: every layer of the sloping wall overhangs the one below it
 * by exactly one layer height. `CLEAT_SLOT_DEPTH_MM` is what
 * {@link hanger_min_base_mm} charges the base for.
 */
export const CLEAT_SLOT_DEPTH_MM = 2.5;
export const CLEAT_SLOT_W_MM = 10.0;
/** Fraction of the plate half-height the slot's centre sits at (the upper third). */
export const CLEAT_SLOT_Y_FRACTION = 0.5;
/**
 * Fraction of the plate width the slot spans: all of it.
 *
 * The slot is UNDERCUT - that is what makes it a cleat - so a wedge printed
 * inside it can only leave sideways. A slot that stopped short of both edges
 * would trap its own wedge for ever (`[V3-P5-F6]`).
 */
export const CLEAT_SLOT_SPAN_FRACTION = 1.0;
/** Screw clearance holes through the wall-side wedge, mm. */
export const CLEAT_SCREW_D_MM = 3.5;

/**
 * Easel foot (v3, `hanger: "easel"`), print mm.
 *
 * A flat leg that lives in a shallow well in the underside and plugs into a
 * socket at the north end of that well to prop the plate up on a desk. The
 * well is the deeper of the two pockets, so it is what the base is charged for.
 */
export const EASEL_WELL_DEPTH_MM = 2.5;
export const EASEL_LEG_T_MM = 2.0;
export const EASEL_LEG_LEN_FRACTION = 0.45;
export const EASEL_LEG_W_MM = 14.0;
export const EASEL_TENON_W_MM = 6.0;
export const EASEL_TENON_LEN_MM = 4.0;

/**
 * Clearance between a printed-in-place part and the pocket it prints in, mm.
 *
 * The cleat wedge and the easel leg are separate BODIES printed inside their
 * own pocket in the underside (`solid/hangers.ts`), so the model still sits at
 * z = 0 and still fits the plate. One layer of air on every face is what stops
 * the two fusing.
 */
export const LOOSE_PART_CLEARANCE_MM = 0.2;

// ---------------------------------------------------------------------------
// Frame styling (v3 `frame_style`)
// ---------------------------------------------------------------------------

/**
 * How much of the city square the frame styling takes, print mm.
 *
 * A shadow gap is a channel between the lip's inner edge and the city, and
 * matting is a raised band in the same place, so both push the crop inward: the
 * city must not run under either of them. TS only, deliberately - the reference
 * service does not build v3 frame styling, and `content_extents_mm` itself is
 * untouched so the TS/Python parity fixture keeps meaning what it meant
 * (DECISIONS `[V3-P5-F2]`).
 */
export function frame_content_inset_mm(params: ParamsLike): number {
  if (!params.frame) return 0.0;
  const style = params.frame_style;
  if (style === undefined) return 0.0;
  let inset = 0.0;
  if (style.shadow_gap?.enabled === true) inset += style.shadow_gap.width_mm ?? 1.0;
  else if ((style.profile ?? "plain") === "floating") inset += FLOATING_GAP_MM;
  if (style.matting?.enabled === true) inset += style.matting.width_mm ?? 6.0;
  return inset;
}

/** Width of the recessed band a `floating` frame reads across, mm. */
export const FLOATING_GAP_MM = 2.0;
/** Depth of that band when no shadow gap gives one, mm. */
export const FLOATING_GAP_DEPTH_MM = 1.0;

/**
 * Which edges read which way for a viewer facing the hung frame: top and bottom
 * upright, the left edge bottom-to-top, the right edge top-to-bottom.
 */
export const EDGE_ROTATION_DEG: Record<string, number> = {
  top: 0.0,
  bottom: 0.0,
  left: 90.0,
  right: -90.0,
};

/**
 * The contract's own defaults for the optional members of one `Engraving`.
 * Every one of them is optional on the wire (a share link may send only `edge`
 * and `text`), while the Python model fills them in from the same schema, so the
 * mirror has to apply them explicitly or the two sides would lay out different
 * text. `tests/test_lettering.py` asserts each equals the schema's `default`.
 */
export const ENGRAVING_DEFAULT_ALIGN = "center";
export const ENGRAVING_DEFAULT_MODE = "engrave";
export const ENGRAVING_DEFAULT_SIZE_MM = 4.0;
export const ENGRAVING_DEFAULT_DEPTH_MM = 0.4;
export const ENGRAVING_DEFAULT_FACE = "sans";

/** One glyph's row in a generated metrics table, in FONT UNITS. */
export interface GlyphMetric {
  adv: number;
  stem: number;
  counter: number | null;
  top: number;
  bot: number;
  /** Ink extents across the advance; `text_gap_em` measures between them. */
  left: number;
  right: number;
}

/** A generated `<face>.metrics.json`, byte-identical to the bake's copy. */
export interface FaceMetrics {
  face: string;
  file: string;
  units_per_em: number;
  ascender: number;
  descender: number;
  cap_height: number;
  x_height: number;
  glyphs: Record<string, GlyphMetric>;
}

const FONT_METRICS: Record<string, FaceMetrics> = {
  sans: sansMetrics as unknown as FaceMetrics,
  serif: serifMetrics as unknown as FaceMetrics,
  mono: monoMetrics as unknown as FaceMetrics,
};

/** The generated metrics table for one face. */
export function font_metrics(face: string): FaceMetrics {
  const table = FONT_METRICS[face];
  if (table === undefined) throw new Error(`unknown font face: ${face}`);
  return table;
}

function glyph_of(face: string, ch: string): GlyphMetric | undefined {
  return font_metrics(face).glyphs[String(ch.codePointAt(0) ?? -1)];
}

/** One string measured and auto-fitted for one place on the frame, print mm. */
export interface TextFit {
  face: string;
  text: string;
  dropped: string;
  requested_mm: number;
  size_mm: number;
  width_mm: number;
  ink_top_mm: number;
  ink_bottom_mm: number;
  dilation_mm: number;
  stroke_mm: number;
  min_size_mm: number;
  gap_size_mm: number;
  refused: boolean;
  reason: string;
  warnings: string[];
}

/** Where a piece of geometry goes on the plate, print mm. */
export interface Placement {
  anchor_x: number;
  anchor_y: number;
  rotation_deg: number;
  mirror_x: boolean;
}

export interface EngravingLayout {
  index: number;
  edge: string;
  align: string;
  mode: string;
  depth_mm: number;
  placement: Placement;
  fit: TextFit;
}

export interface NorthArrowLayout {
  enabled: boolean;
  corner: string;
  size_mm: number;
  placement: Placement;
}

export interface ScaleBarLayout {
  enabled: boolean;
  edge: string;
  length_m: number;
  label: string;
  bar_mm: number;
  thickness_mm: number;
  tick_mm: number;
  span_mm: number;
  placement: Placement;
  label_fit: TextFit | null;
  warnings: string[];
}

export interface UndersideMarkLayout {
  enabled: boolean;
  depth_mm: number;
  placement: Placement;
  fit: TextFit | null;
}

export interface LetteringLayout {
  engravings: EngravingLayout[];
  north_arrow: NorthArrowLayout;
  scale_bar: ScaleBarLayout;
  underside_mark: UndersideMarkLayout;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Text measurement
// ---------------------------------------------------------------------------

/** True when the shared metrics table can lay this character out. */
export function supported_codepoint(face: string, ch: string): boolean {
  return glyph_of(face, ch) !== undefined;
}

/**
 * `[the layable text, the characters dropped]`.
 *
 * An unsupported character is DROPPED, never replaced by the font's `.notdef`
 * box: a hollow rectangle engraved into a frame says "this software is broken".
 * The set is the shared metrics table, not the font's own coverage, so both
 * sides drop exactly the same characters.
 */
export function filter_text(face: string, text: string): [string, string] {
  let kept = "";
  let dropped = "";
  for (const ch of text) {
    if (supported_codepoint(face, ch)) kept += ch;
    else dropped += ch;
  }
  return [kept, dropped];
}

/** Sum of the advance widths of `text`, in em. No kerning (see transform.py). */
export function text_advance_em(face: string, text: string): number {
  const upem = font_metrics(face).units_per_em;
  let total = 0.0;
  for (const ch of text) {
    const g = glyph_of(face, ch);
    if (g !== undefined) total += g.adv;
  }
  return total / upem;
}

/** `[highest, lowest]` ink of `text` relative to the baseline, in em. */
export function text_ink_em(face: string, text: string): [number, number] {
  const upem = font_metrics(face).units_per_em;
  let top = 0.0;
  let bottom = 0.0;
  for (const ch of text) {
    const g = glyph_of(face, ch);
    if (g === undefined) continue;
    if (g.top > top) top = g.top;
    if (g.bot < bottom) bottom = g.bot;
  }
  return [top / upem, bottom / upem];
}

/** The NARROWEST dominant stroke among the characters of `text`, in em. */
export function text_stem_em(face: string, text: string): number {
  const upem = font_metrics(face).units_per_em;
  let stem = 0.0;
  for (const ch of text) {
    const g = glyph_of(face, ch);
    if (g === undefined) continue;
    if (g.stem <= 0.0) continue;
    if (stem === 0.0 || g.stem < stem) stem = g.stem;
  }
  return stem / upem;
}

/**
 * The NARROWEST gap between two adjacent letters of `text`, in em: from one
 * glyph's right ink edge across the advance to the next glyph's left one, which
 * is the ridge of lip that survives between two engraved letters. Infinity for
 * a string of fewer than two inked glyphs -- there is no gap to lose.
 */
export function text_gap_em(face: string, text: string): number {
  const upem = font_metrics(face).units_per_em;
  let gap: number | null = null;
  let previous: GlyphMetric | undefined;
  for (const ch of text) {
    const g = glyph_of(face, ch);
    if (g === undefined) continue;
    if (previous !== undefined) {
      const value = previous.adv - previous.right + g.left;
      if (gap === null || value < gap) gap = value;
    }
    previous = g;
  }
  if (gap === null) return Infinity;
  return Math.max(0.0, gap) / upem;
}

/** What a stroke of text is widened to, mm. See the two constants above. */
export function text_stroke_target_mm(params: ParamsLike, mode = "engrave"): number {
  const nozzles = mode === "emboss" ? EMBOSS_STROKE_NOZZLES : ENGRAVE_STROKE_NOZZLES;
  return nozzles * params.nozzle_mm;
}

/** 04 stage 1, buildings 2, applied to a glyph: `(target - w) / 2`. */
export function text_dilation_mm(
  face: string,
  text: string,
  size_mm: number,
  params: ParamsLike,
  mode = "engrave",
): number {
  const stem_mm = text_stem_em(face, text) * size_mm;
  if (stem_mm <= 0.0) return 0.0;
  return Math.max(0.0, (text_stroke_target_mm(params, mode) - stem_mm) / 2.0);
}

/** The printed width of the thinnest stroke AFTER the Stage 1 dilation. */
export function text_stroke_mm(
  face: string,
  text: string,
  size_mm: number,
  params: ParamsLike,
  mode = "engrave",
): number {
  const stem_mm = text_stem_em(face, text) * size_mm;
  if (stem_mm <= 0.0) return 0.0;
  return stem_mm + 2.0 * text_dilation_mm(face, text, size_mm, params, mode);
}

/** Printed width of the inked block, including the Stage 1 dilation. */
export function text_width_mm(
  face: string,
  text: string,
  size_mm: number,
  params: ParamsLike,
  mode = "engrave",
): number {
  return (
    text_advance_em(face, text) * size_mm +
    2.0 * text_dilation_mm(face, text, size_mm, params, mode)
  );
}

/** Printed height of the inked block, including the Stage 1 dilation. */
export function text_height_mm(
  face: string,
  text: string,
  size_mm: number,
  params: ParamsLike,
  mode = "engrave",
): number {
  const [top, bottom] = text_ink_em(face, text);
  return (
    (top - bottom) * size_mm + 2.0 * text_dilation_mm(face, text, size_mm, params, mode)
  );
}

/**
 * Largest `size_mm` whose inked extent still fits `available_mm`.
 *
 * The extent is `extent_em * size + 2 * dilation(size)` and the dilation is
 * itself a falling function of the size, so the relation is piecewise linear
 * with a kink where the strokes stop needing widening. Both branches are solved
 * in closed form, so the two implementations cannot disagree by an iteration.
 */
export function size_for_extent_mm(
  available_mm: number,
  extent_em: number,
  stem_em: number,
  params: ParamsLike,
  mode = "engrave",
): number {
  if (extent_em <= 0.0) return TEXT_MAX_SIZE_MM;
  const wall = text_stroke_target_mm(params, mode);
  const plain = available_mm / extent_em;
  if (stem_em <= 0.0 || plain * stem_em >= wall) return plain;
  if (extent_em <= stem_em) return plain;
  return (available_mm - wall) / (extent_em - stem_em);
}

/** Round DOWN onto the fit grid. Identical in both languages for value > 0. */
export function floor_to_grid(value: number, grid: number = TEXT_FIT_GRID_MM): number {
  if (grid <= 0.0) return value;
  return Math.floor(value / grid) * grid;
}

export function ceil_to_grid(value: number, grid: number = TEXT_FIT_GRID_MM): number {
  if (grid <= 0.0) return value;
  return Math.ceil(value / grid) * grid;
}

/**
 * The smallest printed size at which this string can be cut at all.
 *
 * Below it, bringing the thinnest stroke up to a full minimum wall would close
 * a counter -- the hole in an `o`, an `a`, an `e`, an `8`, a `B` -- and an `o`
 * with no hole is not an `o`. Per glyph either condition suffices: the stroke is
 * already a full wall wide, or the counter survives the dilation at least one
 * nozzle wide. Both are linear in the size, so this is a maximum of minima of
 * closed forms rather than a bisection.
 */
function size_for_ridge(
  ridge_em: number,
  stem_em: number,
  target_mm: number,
  detail_mm: number,
): number {
  if (ridge_em <= 0.0 || stem_em <= 0.0) return 0.0;
  const by_shrink = (target_mm + detail_mm) / (ridge_em + stem_em);
  const by_native = Math.max(target_mm / stem_em, detail_mm / ridge_em);
  return Math.min(by_shrink, by_native);
}

export function text_min_size_mm(
  face: string,
  text: string,
  params: ParamsLike,
  mode = "engrave",
): number {
  const target = text_stroke_target_mm(params, mode);
  const detail = min_detail_mm(params);
  const upem = font_metrics(face).units_per_em;
  // Every counter is measured against the STRING's stem, not the glyph's own:
  // the dilation is one distance for the whole string.
  const stem_em = text_stem_em(face, text);
  let needed = 0.0;
  for (const ch of text) {
    const g = glyph_of(face, ch);
    if (g === undefined || g.counter === null) continue;
    const value = size_for_ridge(g.counter / upem, stem_em, target, detail);
    if (value > needed) needed = value;
  }
  return ceil_to_grid(needed);
}

/**
 * The smallest size at which adjacent letters keep a nozzle between them.
 *
 * A WARNING, not a refusal: the space between two letters is a wedge, so the
 * pair touches over a fraction of a millimetre and stays legible, and the bake's
 * ridge merge hands that sub-nozzle tip to the groove. The number comes from the
 * ink extents, i.e. from the closest approach of the two letters, and treats the
 * whole gap as if it were that narrow.
 */
export function text_gap_size_mm(
  face: string,
  text: string,
  params: ParamsLike,
  mode = "engrave",
): number {
  return ceil_to_grid(
    size_for_ridge(
      text_gap_em(face, text),
      text_stem_em(face, text),
      text_stroke_target_mm(params, mode),
      min_detail_mm(params),
    ),
  );
}

/** Format a number the way Python's `f"{x:g}"` does for the values we pass. */
function g_format(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/** Format a number with exactly two decimals, ties away from zero. */
function f2(value: number): string {
  return TOK.fixed(value, 2);
}

/**
 * Auto-fit one string into a length and a band, and judge its printability.
 *
 * Never clips: a string that overruns its edge is made SMALLER (and the fitted
 * size is named in a warning), and one that cannot be made small enough, or that
 * would lose its counters at the size that fits, is REFUSED with a message
 * naming the size that would work.
 */
export function fit_text(
  face: string,
  text: string,
  requested_mm: number,
  available_mm: number,
  band_mm: number,
  params: ParamsLike,
  what = "engraving",
  mode = "engrave",
): TextFit {
  const warnings: string[] = [];
  const [layable, dropped] = filter_text(face, text);
  if (dropped.length > 0) {
    warnings.push(
      `${dropped.length} character(s) not in the ${face} metrics were dropped from ` +
        `the ${what}: ${dropped}`,
    );
  }
  const requested = Math.min(Math.max(requested_mm, TEXT_MIN_SIZE_MM), TEXT_MAX_SIZE_MM);
  if (layable.trim() === "") {
    return {
      face,
      text: layable,
      dropped,
      requested_mm: requested,
      size_mm: requested,
      width_mm: 0.0,
      ink_top_mm: 0.0,
      ink_bottom_mm: 0.0,
      dilation_mm: 0.0,
      stroke_mm: 0.0,
      min_size_mm: 0.0,
      gap_size_mm: 0.0,
      refused: true,
      reason: `the ${what} is empty`,
      warnings,
    };
  }

  const stem_em = text_stem_em(face, layable);
  const advance_em = text_advance_em(face, layable);
  const [top_em, bottom_em] = text_ink_em(face, layable);
  const by_length = size_for_extent_mm(available_mm, advance_em, stem_em, params, mode);
  const by_band = size_for_extent_mm(band_mm, top_em - bottom_em, stem_em, params, mode);
  let fitted = floor_to_grid(Math.min(requested, by_length, by_band));
  const min_size = text_min_size_mm(face, layable, params, mode);
  const gap_size = text_gap_size_mm(face, layable, params, mode);

  let refused = false;
  let reason = "";
  if (fitted < TEXT_MIN_SIZE_MM) {
    refused = true;
    const limit = by_length <= by_band ? "edge" : "6 mm lip band";
    reason =
      `the ${what} does not fit the ${limit} even at the smallest legal ` +
      `${g_format(TEXT_MIN_SIZE_MM)} mm: it would need ` +
      `${f2(Math.max(0.0, floor_to_grid(Math.min(by_length, by_band))))} mm`;
    fitted = TEXT_MIN_SIZE_MM;
  } else if (fitted < requested) {
    warnings.push(
      `the ${what} was reduced from ${g_format(requested)} mm to ${f2(fitted)} mm to fit ` +
        (by_length <= by_band ? "the edge" : "the 6 mm lip band"),
    );
  }

  if (!refused && fitted < min_size) {
    refused = true;
    reason =
      `at ${f2(fitted)} mm a ${g_format(params.nozzle_mm)} mm nozzle cannot cut this ` +
      `${what} without closing a counter; it needs ${f2(min_size)} mm`;
    if (min_size > TEXT_MAX_SIZE_MM) {
      reason += `, which is over the ${g_format(TEXT_MAX_SIZE_MM)} mm maximum`;
    } else if (min_size > Math.min(by_length, by_band)) {
      reason += ", which does not fit this edge: shorten the text or widen the plate";
    }
  }

  if (!refused && fitted < gap_size) {
    warnings.push(
      `at ${f2(fitted)} mm the letters of this ${what} come within a nozzle of ` +
        `each other and will touch where they are closest; ${f2(gap_size)} mm ` +
        `would keep them apart`,
    );
  }

  return {
    face,
    text: layable,
    dropped,
    requested_mm: requested,
    size_mm: fitted,
    width_mm: text_width_mm(face, layable, fitted, params, mode),
    ink_top_mm: top_em * fitted,
    ink_bottom_mm: bottom_em * fitted,
    dilation_mm: text_dilation_mm(face, layable, fitted, params, mode),
    stroke_mm: text_stroke_mm(face, layable, fitted, params, mode),
    min_size_mm: min_size,
    gap_size_mm: gap_size,
    refused,
    reason,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// The frame edges
// ---------------------------------------------------------------------------

/**
 * True when the frame lip exists to carry edge text and ornaments. Edge
 * engravings, the north arrow and the scale bar all live on the 6 mm lip; with
 * `frame` off they are skipped. The underside mark and the hanger do not need it.
 */
export function frame_text_available(params: ParamsLike): boolean {
  return Boolean(params.frame);
}

/** Unit vector along the reading direction of one edge. */
export function edge_axis(edge: string): [number, number] {
  if (edge === "top" || edge === "bottom") return [1.0, 0.0];
  if (edge === "left") return [0.0, 1.0];
  if (edge === "right") return [0.0, -1.0];
  throw new Error(`unknown edge: ${edge}`);
}

/**
 * Unit vector of the text's UP direction on one edge: `R(rotation) * (0, 1)`.
 * +y on the top and bottom edges, -x on the left, +x on the right, i.e. the
 * letters on the side edges stand with their feet toward the picture.
 */
export function edge_up(edge: string): [number, number] {
  const theta = (EDGE_ROTATION_DEG[edge] * Math.PI) / 180.0;
  return [-Math.sin(theta), Math.cos(theta)];
}

/** Centre point of one edge's lip band, in plate mm. */
export function edge_band_center_mm(
  params: ParamsLike,
  edge: string,
): [number, number] {
  const offset = params.plate_mm / 2.0 - FRAME_WIDTH_MM / 2.0;
  if (edge === "top") return [0.0, offset];
  if (edge === "bottom") return [0.0, -offset];
  if (edge === "left") return [-offset, 0.0];
  if (edge === "right") return [offset, 0.0];
  throw new Error(`unknown edge: ${edge}`);
}

/** Length of one edge that text may occupy: the plate minus both corners. */
export function edge_usable_mm(params: ParamsLike): number {
  return Math.max(0.0, params.plate_mm - 2.0 * LIP_CORNER_RESERVE_MM);
}

/** Clearance between the ink and each long edge of the lip band, mm. */
export function lip_text_margin_mm(params: ParamsLike): number {
  return Math.max(LIP_TEXT_MARGIN_MM, min_detail_mm(params));
}

/** Height of the band the ink must stay inside, mm. */
export function edge_band_mm(params: ParamsLike): number {
  return FRAME_WIDTH_MM - 2.0 * lip_text_margin_mm(params);
}

/** Anchor and rotation for one fitted string on one edge. */
/**
 * Largest arrow the lip can hold, in mm. The glyph is TURNED by the scene
 * rotation, so the bound is its circumradius -- the base corner at
 * `(0.3, -0.5) * size`, further from the centre than the tip is -- and not its
 * length. Rotation-independent on purpose: an ornament that changed size when
 * the user rotated the map would be worse than one 0.7 mm shorter than asked.
 * Without any of this the arrow was simply clipped: a 6 mm arrow, the
 * contract's own maximum, lost the last 0.5 mm of its point at rotation 0
 * (v2-03 audit, finding 9).
 */
export function north_arrow_max_size_mm(params: ParamsLike): number {
  const reach = Math.hypot(NORTH_ARROW_WIDTH_RATIO / 2.0, 0.5);
  return Math.max(0.0, edge_band_mm(params) / (2.0 * reach));
}

export function edge_placement(
  params: ParamsLike,
  edge: string,
  align: string,
  fit: TextFit,
  span_lo: number,
  span_hi: number,
): Placement {
  const width = fit.width_mm;
  let block_lo: number;
  if (align === "start") block_lo = span_lo;
  else if (align === "end") block_lo = span_hi - width;
  else block_lo = (span_lo + span_hi) / 2.0 - width / 2.0;
  const u = block_lo + fit.dilation_mm;
  const v = -(fit.ink_top_mm + fit.ink_bottom_mm) / 2.0;
  const [cx, cy] = edge_band_center_mm(params, edge);
  const [ax, ay] = edge_axis(edge);
  const [ux, uy] = edge_up(edge);
  return {
    anchor_x: cx + u * ax + v * ux,
    anchor_y: cy + u * ay + v * uy,
    rotation_deg: EDGE_ROTATION_DEG[edge],
    mirror_x: false,
  };
}

// ---------------------------------------------------------------------------
// The scale bar
// ---------------------------------------------------------------------------

export const SCALE_BAR_MANTISSAS = [1.0, 2.0, 5.0];
export const SCALE_BAR_DECADES = [-1, 0, 1, 2, 3, 4, 5, 6, 7];

/** Every 1-2-5 round number of ground metres, ascending. */
export function scale_bar_candidates(): number[] {
  const out: number[] = [];
  for (const decade of SCALE_BAR_DECADES) {
    for (const mantissa of SCALE_BAR_MANTISSAS) {
      out.push(mantissa * Math.pow(10.0, decade));
    }
  }
  return out;
}

/**
 * The longest 1-2-5 round distance whose printed bar lands in [15, 40] mm. The
 * series steps by at most 2.5x while the window spans 2.67x, so one always fits.
 */
export function scale_bar_auto_length_m(scale_mm_per_m: number): number {
  if (!(scale_mm_per_m > 0.0)) return 0.0;
  let best = 0.0;
  for (const length_m of scale_bar_candidates()) {
    const printed = length_m * scale_mm_per_m;
    if (printed >= SCALE_BAR_MIN_MM && printed <= SCALE_BAR_MAX_MM && length_m > best) {
      best = length_m;
    }
  }
  if (best > 0.0) return best;
  const distance = (length_m: number): number => {
    const printed = length_m * scale_mm_per_m;
    if (printed < SCALE_BAR_MIN_MM) return SCALE_BAR_MIN_MM - printed;
    return printed - SCALE_BAR_MAX_MM;
  };
  let chosen = 0.0;
  let chosen_d = Infinity;
  for (const length_m of scale_bar_candidates()) {
    const d = distance(length_m);
    if (d < chosen_d || (d === chosen_d && length_m > chosen)) {
      chosen = length_m;
      chosen_d = d;
    }
  }
  return chosen;
}

/** `500 m` / `2 km` / `2.5 km`, through the shared token number helpers. */
export function scale_bar_label(length_m: number): string {
  if (length_m >= 1000.0) {
    const km = length_m / 1000.0;
    if (Math.abs(km - TOK.round_half_up(km)) < 1e-9) return `${TOK.round_half_up(km)} km`;
    return `${TOK.fixed(km, 1)} km`;
  }
  if (Math.abs(length_m - TOK.round_half_up(length_m)) < 1e-9) {
    return `${TOK.round_half_up(length_m)} m`;
  }
  return `${TOK.fixed(length_m, 1)} m`;
}

/** Stroke thickness of the bar itself, mm: never under a minimum wall. */
export function scale_bar_thickness_mm(params: ParamsLike): number {
  return Math.max(min_wall_mm(params), 0.8);
}

// ---------------------------------------------------------------------------
// The underside: mark, keyhole, magnets
// ---------------------------------------------------------------------------

/**
 * Thinnest base plate that can carry this hanger, mm. A keyhole is 2 mm deep and
 * a magnet pocket 3.1 mm; both must leave `HANGER_MIN_ROOF_MM` of solid plate
 * above them or the pocket is a hole through the picture. The bake refuses such
 * a plate, and the editor predicts the refusal from this function.
 */
export function hanger_min_base_mm(hanger: string): number {
  if (hanger === "keyhole") return KEYHOLE_DEPTH_MM + HANGER_MIN_ROOF_MM;
  if (hanger === "magnets") return MAGNET_DEPTH_MM + HANGER_MIN_ROOF_MM;
  // v3: both mounts are pockets cut from below like the two above, so both are
  // charged the same way - their own depth plus a roof (`[V3-P5-F6]`).
  if (hanger === "cleat") return CLEAT_SLOT_DEPTH_MM + HANGER_MIN_ROOF_MM;
  if (hanger === "easel") return EASEL_WELL_DEPTH_MM + HANGER_MIN_ROOF_MM;
  return 0.0;
}

/** Thinnest base plate that can carry the 0.3 mm underside mark, mm. */
export function underside_mark_min_base_mm(): number {
  return UNDERSIDE_MARK_DEPTH_MM + HANGER_MIN_ROOF_MM;
}

/** How far the deepest TOP-side recess reaches below the base top, mm. */
export function deepest_recess_mm(params: ParamsLike): number {
  let depth = 0.0;
  const water = water_z_mm(params);
  if (water !== null) depth = Math.max(depth, -water);
  const road = road_z_mm(params);
  if (road !== null && road < 0.0) depth = Math.max(depth, -road);
  return depth;
}

/**
 * Thinnest base this parameter set can print with, mm: the hanger and the mark
 * are cut from below, the water and the engraved roads from above, and the
 * material between them has to hold.
 *
 * `lib/warnings.ts` (`undersideBlockMessage`) is the caller: this is the number
 * `app/geom/lettering.py` refuses on, so it is the number the editor has to
 * block on, the same arrangement `predicted_top_mm` has for the 60 mm ceiling.
 */
export function underside_min_base_mm(params: ParamsLike): number {
  let needed = 0.0;
  const hanger = params.hanger ?? "none";
  if (hanger !== "none") needed = Math.max(needed, hanger_min_base_mm(hanger));
  if (params.underside_mark?.enabled) {
    needed = Math.max(needed, underside_mark_min_base_mm());
  }
  if (needed <= 0.0) return 0.0;
  return needed + deepest_recess_mm(params);
}

/** Centre of the keyhole's round entry, in plate mm (top centre). */
export function keyhole_center_mm(params: ParamsLike): [number, number] {
  // Measured back from the plate's top edge: the margin, the rounded end of the
  // slot (which is what the screw shank rests in), then the slot itself.
  return [
    0.0,
    params.plate_mm / 2.0 -
      KEYHOLE_EDGE_MARGIN_MM -
      KEYHOLE_SLOT_W_MM / 2.0 -
      KEYHOLE_SLOT_LEN_MM,
  ];
}

/** Centres of the four magnet pockets, in plate mm. */
export function magnet_centers_mm(params: ParamsLike): Array<[number, number]> {
  const offset = params.plate_mm / 2.0 - MAGNET_INSET_MM;
  return [
    [-offset, -offset],
    [offset, -offset],
    [-offset, offset],
    [offset, offset],
  ];
}

/** Depth of one underside pocket below z = 0, mm. */
export function underside_pocket_depth_mm(params: ParamsLike, kind: string): number {
  void params;
  if (kind === "mark") return UNDERSIDE_MARK_DEPTH_MM;
  if (kind === "keyhole") return KEYHOLE_DEPTH_MM;
  if (kind === "magnets") return MAGNET_DEPTH_MM;
  if (kind === "cleat") return CLEAT_SLOT_DEPTH_MM;
  if (kind === "easel") return EASEL_WELL_DEPTH_MM;
  throw new Error(`unknown underside pocket: ${kind}`);
}

/** Which underside pockets this parameter set asks for, deepest last. */
export function underside_pockets(params: ParamsLike): string[] {
  const out: string[] = [];
  if (params.underside_mark?.enabled) out.push("mark");
  const hanger = params.hanger ?? "none";
  if (hanger === "keyhole" || hanger === "magnets") out.push(hanger);
  // v3: the cleat slot and the easel well are underside pockets too, so the
  // underside band and every check built on it see them (`[V3-P5-F6]`).
  if (hanger === "cleat" || hanger === "easel") out.push(hanger);
  return out;
}

/** The Z band the underside pockets occupy, or null when there are none. */
export function underside_band_mm(params: ParamsLike): [number, number] | null {
  const depths = underside_pockets(params).map((kind) =>
    underside_pocket_depth_mm(params, kind),
  );
  if (depths.length === 0) return null;
  return [0.0, Math.max(...depths)];
}

/** Width the underside mark may occupy, mm: clear of the chamfer and the magnets. */
export function underside_mark_available_mm(params: ParamsLike): number {
  const half = params.plate_mm / 2.0;
  let limit = half - CHAMFER_MM - UNDERSIDE_MARK_MARGIN_MM;
  if ((params.hanger ?? "none") === "magnets") {
    limit = Math.min(
      limit,
      half - MAGNET_INSET_MM - MAGNET_D_MM / 2.0 - UNDERSIDE_MARK_MARGIN_MM,
    );
  }
  return Math.max(0.0, 2.0 * limit);
}

// ---------------------------------------------------------------------------
// The whole layout
// ---------------------------------------------------------------------------

/**
 * Where every piece of text and every ornament goes, and whether it prints.
 *
 * THE layout: the bake cuts from it and the preview draws from it. Token
 * expansion happens here too (through the shared `tokens` pair), so both sides
 * also agree on the text itself. `rotation_deg` is the SceneRequest's rotation:
 * the model is turned counter-clockwise by it, so the north arrow is turned back
 * by the same amount and points at true north in the printed object.
 */
export function lettering_layout(
  params: ParamsLike,
  ctx: TOK.TokenContext,
  rotation_deg = 0.0,
): LetteringLayout {
  const warnings: string[] = [];
  const have_frame = frame_text_available(params);
  const usable = edge_usable_mm(params);
  const band = edge_band_mm(params);

  const bar = scale_bar_layout(params, ctx, have_frame);
  if (bar.warnings.length > 0) warnings.push(...bar.warnings);
  const taken: Record<string, number> = {};
  if (bar.enabled) taken[bar.edge] = bar.span_mm + ORNAMENT_GAP_MM;

  const engravings: EngravingLayout[] = [];
  const list = params.engravings ?? [];
  for (let index = 0; index < list.length; index += 1) {
    const engraving = list[index];
    const edge = engraving.edge;
    const text = TOK.expand_tokens(engraving.text, ctx);
    const face = engraving.font ?? ENGRAVING_DEFAULT_FACE;
    const align = engraving.align ?? ENGRAVING_DEFAULT_ALIGN;
    const offset = taken[edge] ?? 0.0;
    const span_lo = -usable / 2.0 + offset;
    const span_hi = usable / 2.0;
    const fit = fit_text(
      face,
      text,
      engraving.size_mm ?? ENGRAVING_DEFAULT_SIZE_MM,
      Math.max(0.0, span_hi - span_lo),
      band,
      params,
      `${edge} engraving`,
      engraving.mode ?? ENGRAVING_DEFAULT_MODE,
    );
    // There is no lip to carry it, so it is REFUSED, not merely warned about.
    // Saying "skipped" in a warning while handing back `refused: false` is what
    // shipped an embossed engraving as a pair of letters floating 1.8 mm above a
    // frameless plate, with every validator passing (v2-03 audit, finding 2).
    const placed_fit: TextFit = have_frame
      ? fit
      : {
          ...fit,
          refused: true,
          reason:
            'the frame is off, so there is no lip to engrave: turn the frame on to print edge text',
          warnings: [],
        };
    engravings.push({
      index,
      edge,
      align,
      mode: engraving.mode ?? ENGRAVING_DEFAULT_MODE,
      depth_mm: engraving.depth_mm ?? ENGRAVING_DEFAULT_DEPTH_MM,
      placement: edge_placement(params, edge, align, placed_fit, span_lo, span_hi),
      fit: placed_fit,
    });
    warnings.push(...placed_fit.warnings);
    if (placed_fit.refused && have_frame) {
      // With the frame off, the one summary line below names every piece that
      // went with it - the user turned one switch and gets told once.
      warnings.push(`engraving ${index + 1} (${edge}) was not cut: ${placed_fit.reason}`);
    }
  }

  const arrow = north_arrow_layout(params, rotation_deg, have_frame);
  if (arrow.enabled) {
    const asked = params.north_arrow?.size_mm ?? 0.0;
    if (arrow.size_mm < asked - 1e-9) {
      warnings.push(
        `the north arrow was reduced from ${g_format(asked)} mm to ${g_format(arrow.size_mm)} mm ` +
          `to fit the ${g_format(FRAME_WIDTH_MM)} mm lip band`,
      );
    }
  }
  const mark = underside_mark_layout(params, ctx);
  if (mark.fit !== null) {
    warnings.push(...mark.fit.warnings);
    if (mark.fit.refused) {
      warnings.push(`the underside mark was not cut: ${mark.fit.reason}`);
    }
  }

  if (!have_frame) {
    const skipped: string[] = [];
    if (engravings.length > 0) skipped.push(`${engravings.length} edge engraving(s)`);
    if (params.north_arrow?.enabled) skipped.push("the north arrow");
    if (params.scale_bar?.enabled) skipped.push("the scale bar");
    if (skipped.length > 0) {
      warnings.push(
        "the frame is off, so there is no lip to carry " +
          skipped.join(", ") +
          "; turn the frame on to print them",
      );
    }
  }

  return {
    engravings,
    north_arrow: arrow,
    scale_bar: bar,
    underside_mark: mark,
    warnings,
  };
}

export function north_arrow_layout(
  params: ParamsLike,
  rotation_deg: number,
  have_frame: boolean,
): NorthArrowLayout {
  const arrow = params.north_arrow;
  const enabled = Boolean(arrow?.enabled) && have_frame;
  const corner = arrow?.corner ?? "ne";
  const size = Math.min(arrow?.size_mm ?? 4.0, north_arrow_max_size_mm(params));
  const offset = params.plate_mm / 2.0 - FRAME_WIDTH_MM / 2.0;
  const sx = corner === "nw" || corner === "sw" ? -1.0 : 1.0;
  const sy = corner === "se" || corner === "sw" ? -1.0 : 1.0;
  return {
    enabled,
    corner,
    size_mm: size,
    placement: {
      anchor_x: sx * offset,
      anchor_y: sy * offset,
      // `project.LocalFrame.to_local` rotates the ground COUNTER-CLOCKWISE by
      // +rotation_deg, so true north lands on the +y axis turned CCW by +rot and
      // an arrow drawn pointing +y must be turned by +rotation_deg. Turning it
      // the other way put it on ground bearing 2*rot (v2-03 audit, finding 1).
      rotation_deg: rotation_deg,
      mirror_x: false,
    },
  };
}

export function scale_bar_layout(
  params: ParamsLike,
  ctx: TOK.TokenContext,
  have_frame: boolean,
): ScaleBarLayout {
  const spec = params.scale_bar;
  const enabled = Boolean(spec?.enabled) && have_frame;
  const edge = spec?.edge ?? "bottom";
  const mode = spec?.length_mode ?? "auto";
  const scale = ctx.scale_mm_per_m;
  const warnings: string[] = [];

  const auto_length = scale_bar_auto_length_m(scale);
  let length_m = auto_length;
  if (mode === "fixed") {
    const requested = spec?.length_m ?? 0.0;
    const printed = requested * scale;
    if (printed > SCALE_BAR_MAX_MM || printed < SCALE_BAR_MIN_MM) {
      if (enabled) {
        warnings.push(
          `the scale bar's fixed ${TOK.round_half_up(requested)} m would print ` +
            `${TOK.fixed(printed, 1)} mm, outside the ${g_format(SCALE_BAR_MIN_MM)}-` +
            `${g_format(SCALE_BAR_MAX_MM)} mm window; using ` +
            `${TOK.round_half_up(auto_length)} m instead`,
        );
      }
    } else {
      length_m = requested;
    }
  }

  const bar_mm = length_m * scale;
  const thickness = scale_bar_thickness_mm(params);
  const tick = SCALE_BAR_TICK_FACTOR * thickness;
  const label = scale_bar_label(length_m);
  const label_fit = enabled
    ? fit_text(
        SCALE_BAR_FACE,
        label,
        SCALE_BAR_LABEL_SIZE_MM,
        Math.max(0.0, edge_usable_mm(params) - bar_mm - ORNAMENT_GAP_MM),
        edge_band_mm(params),
        params,
        "scale bar label",
      )
    : null;
  const label_width = label_fit === null || label_fit.refused ? 0.0 : label_fit.width_mm;
  const span = bar_mm + (label_width > 0.0 ? ORNAMENT_GAP_MM + label_width : 0.0);
  if (label_fit !== null && label_fit.refused) {
    warnings.push(`the scale bar prints without its label: ${label_fit.reason}`);
  }

  const [cx, cy] = edge_band_center_mm(params, edge);
  const [ax, ay] = edge_axis(edge);
  const u = -edge_usable_mm(params) / 2.0;
  return {
    enabled,
    edge,
    length_m,
    label,
    bar_mm,
    thickness_mm: thickness,
    tick_mm: tick,
    span_mm: span,
    placement: {
      anchor_x: cx + u * ax,
      anchor_y: cy + u * ay,
      rotation_deg: EDGE_ROTATION_DEG[edge],
      mirror_x: false,
    },
    label_fit,
    warnings,
  };
}

export function underside_mark_layout(
  params: ParamsLike,
  ctx: TOK.TokenContext,
): UndersideMarkLayout {
  const spec = params.underside_mark;
  if (!spec?.enabled) {
    return {
      enabled: false,
      depth_mm: UNDERSIDE_MARK_DEPTH_MM,
      placement: { anchor_x: 0.0, anchor_y: 0.0, rotation_deg: 0.0, mirror_x: true },
      fit: null,
    };
  }
  const text = TOK.expand_tokens(spec.template ?? "", ctx);
  const fit = fit_text(
    UNDERSIDE_MARK_FACE,
    text,
    UNDERSIDE_MARK_SIZE_MM,
    underside_mark_available_mm(params),
    UNDERSIDE_MARK_SIZE_MM * 2.0,
    params,
    "underside mark",
  );
  return {
    enabled: true,
    depth_mm: UNDERSIDE_MARK_DEPTH_MM,
    // The pen origin is on the RIGHT of the block: the mirror reflects the
    // layout about the anchor (`x -> -x + anchor`), so a block laid out from 0
    // to W spans `[anchor - W, anchor]`, and `+W/2` is what centres it.
    placement: {
      anchor_x: fit.width_mm / 2.0 - fit.dilation_mm,
      anchor_y: -(fit.ink_top_mm + fit.ink_bottom_mm) / 2.0,
      rotation_deg: 0.0,
      mirror_x: true,
    },
    fit,
  };
}

/** Decimal places every number in the shared layout dump is rounded to. */
export const LAYOUT_JSON_PLACES = 6;

/**
 * Round for the shared JSON dump, ties away from zero, in both languages.
 * Python's `round` is banker's rounding and `Math.round` is not, so the dump
 * both test suites compare goes through the shared `round_half_up` instead.
 */
export function round_places(value: number, places = LAYOUT_JSON_PLACES): number {
  const factor = Math.pow(10.0, places);
  const scaled = value * factor;
  return (TOK.round_half_up(Math.abs(scaled)) / factor) * (scaled < 0 ? -1.0 : 1.0);
}

function placement_json(placement: Placement): Record<string, unknown> {
  return {
    anchor_x: round_places(placement.anchor_x),
    anchor_y: round_places(placement.anchor_y),
    rotation_deg: round_places(placement.rotation_deg),
    mirror_x: placement.mirror_x,
  };
}

function fit_json(fit: TextFit | null): Record<string, unknown> | null {
  if (fit === null) return null;
  return {
    face: fit.face,
    text: fit.text,
    dropped: fit.dropped,
    requested_mm: round_places(fit.requested_mm),
    size_mm: round_places(fit.size_mm),
    width_mm: round_places(fit.width_mm),
    ink_top_mm: round_places(fit.ink_top_mm),
    ink_bottom_mm: round_places(fit.ink_bottom_mm),
    dilation_mm: round_places(fit.dilation_mm),
    stroke_mm: round_places(fit.stroke_mm),
    min_size_mm: round_places(fit.min_size_mm),
    gap_size_mm: round_places(fit.gap_size_mm),
    refused: fit.refused,
    reason: fit.reason,
    warnings: [...fit.warnings],
  };
}

/**
 * The layout as plain JSON: the shape `fixtures/lettering-expected.json` holds
 * and both test suites compare, so the dump is shared code rather than two
 * hand-written serialisers that can drift apart.
 */
export function lettering_layout_json(
  params: ParamsLike,
  ctx: TOK.TokenContext,
  rotation_deg = 0.0,
): Record<string, unknown> {
  const layout = lettering_layout(params, ctx, rotation_deg);
  return {
    engravings: layout.engravings.map((e) => ({
      index: e.index,
      edge: e.edge,
      align: e.align,
      mode: e.mode,
      depth_mm: round_places(e.depth_mm),
      placement: placement_json(e.placement),
      fit: fit_json(e.fit),
    })),
    north_arrow: {
      enabled: layout.north_arrow.enabled,
      corner: layout.north_arrow.corner,
      size_mm: round_places(layout.north_arrow.size_mm),
      placement: placement_json(layout.north_arrow.placement),
    },
    scale_bar: {
      enabled: layout.scale_bar.enabled,
      edge: layout.scale_bar.edge,
      length_m: round_places(layout.scale_bar.length_m),
      label: layout.scale_bar.label,
      bar_mm: round_places(layout.scale_bar.bar_mm),
      thickness_mm: round_places(layout.scale_bar.thickness_mm),
      tick_mm: round_places(layout.scale_bar.tick_mm),
      span_mm: round_places(layout.scale_bar.span_mm),
      placement: placement_json(layout.scale_bar.placement),
      label_fit: fit_json(layout.scale_bar.label_fit),
      warnings: [...layout.scale_bar.warnings],
    },
    underside_mark: {
      enabled: layout.underside_mark.enabled,
      depth_mm: round_places(layout.underside_mark.depth_mm),
      placement: placement_json(layout.underside_mark.placement),
      fit: fit_json(layout.underside_mark.fit),
    },
    warnings: [...layout.warnings],
  };
}

// ===========================================================================
// Detail advisor (PrintParams v2)
//
// One honest sentence about what this radius and this plate are doing to the
// city, computed from the SAME predicates the preview already approximates the
// bake with, so the advice cannot contradict the picture on the canvas.
// ===========================================================================

/**
 * Score penalties, in points per unit of fraction, clamped into 0..100.
 *
 * A building the repair had to DROP costs a full point per per cent -- a city
 * that loses every building scores 0 -- and one it had to WIDEN costs 0.6, since
 * a widened building is still there and still in the right place. Trees and
 * areas are worth a twentieth of a point each. The weights do not sum to 100 on
 * purpose: they are penalties per fraction, not shares of a budget, and each
 * fraction is independently 0..1, so 100 % widened alone is 60 points off --
 * landing AT 40, which is `poor`, the case the band exists to name. Measured on
 * the committed Chicago fixture: plate 100 at 3 000 m widens 95 % and scores 34;
 * the shipped default preset widens 37 % and scores 70, which is `fair`.
 */
export const SCORE_WEIGHT_DROPPED = 100.0;
export const SCORE_WEIGHT_WIDENED = 60.0;
export const SCORE_WEIGHT_TREES = 5.0;
export const SCORE_WEIGHT_AREAS = 5.0;

/** Band edges: 75+ looks like the map, 45-74 has lost its small buildings. */
export const SCORE_BAND_GOOD = 75;
export const SCORE_BAND_FAIR = 45;

/** The advisor's target: at most this fraction of the buildings widened. */
export const MAX_WIDENED_FRACTION = 0.25;
export const RADIUS_GRID_M = 10.0;
export const RADIUS_MIN_M = 250.0;
export const PLATE_GRID_MM = 2.0;
export const PLATE_MIN_MM = 100.0;
export const PLATE_MAX_MM = 256.0;

export interface DetailReport {
  buildings_total: number;
  widened: number;
  dropped: number;
  widened_fraction: number;
  dropped_fraction: number;
  trees_total: number;
  trees_dropped_fraction: number;
  areas_total: number;
  areas_dropped_fraction: number;
  min_wall_ground_m: number;
  score: number;
  band: string;
}

/** What the advisor reads off a SceneGraph. */
export interface AdvisorSceneLike {
  buildings: ReadonlyArray<{ ring: RingLike; holes: ReadonlyArray<RingLike> }>;
  trees: ReadonlyArray<TreeLike>;
  water: ReadonlyArray<{ ring: RingLike }>;
  green: ReadonlyArray<{ ring: RingLike }>;
}

/**
 * `[area_m2, char_width_m]` per building, computed once: neither depends on any
 * PrintParams, so the searches below can sweep hundreds of candidates over a
 * 3 000-building scene without re-walking a single ring.
 */
function char_widths(scene: AdvisorSceneLike): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const b of scene.buildings) {
    let area = ring_area_m2(b.ring);
    let perimeter = ring_perimeter_m(b.ring);
    for (const hole of b.holes ?? []) {
      area -= ring_area_m2(hole);
      perimeter += ring_perimeter_m(hole);
    }
    area = Math.max(0.0, area);
    out.push([area, building_char_width_m(area, perimeter)]);
  }
  return out;
}

function building_counts(
  footprints: ReadonlyArray<[number, number]>,
  thresholds: Thresholds,
): [number, number] {
  let widened = 0;
  let dropped = 0;
  for (const [area, char_width] of footprints) {
    const dilation = building_dilation_m(char_width, thresholds);
    if (building_dropped(area, dilation, thresholds)) dropped += 1;
    else if (dilation > 0.0) widened += 1;
  }
  return [widened, dropped];
}

/**
 * How much of this city survives the minimum-feature repair, 0-100.
 *
 * Every count comes from the shared predicates the preview already draws with,
 * so the advisor agrees with the canvas by construction. The bake's Stage 1 does
 * better than this -- it merges blocks rather than dropping them -- so the report
 * is an upper bound on the damage, which is the right side to err on.
 */
export function detail_report(
  scene: AdvisorSceneLike,
  params: ParamsLike,
  radius_m: number,
): DetailReport {
  const scale = scale_mm_per_m(params, radius_m);
  const thresholds = thresholds_ground_m(params, scale);
  const footprints = char_widths(scene);
  const [widened, dropped] = building_counts(footprints, thresholds);
  const total = footprints.length;

  const trees = scene.trees ?? [];
  const trees_total = trees.length;
  const trees_kept =
    trees_total > 0 && params.trees ? select_tree_indices_for(trees, params, scale).length : 0;
  const trees_dropped = trees_total - trees_kept;

  const areas = [...(scene.water ?? []), ...(scene.green ?? [])];
  const areas_total = areas.length;
  let areas_dropped = 0;
  for (const a of areas) {
    if (area_dropped(ring_area_m2(a.ring), thresholds)) areas_dropped += 1;
  }

  const fraction = (part: number, whole: number): number =>
    whole <= 0 ? 0.0 : part / whole;
  const widened_fraction = fraction(widened, total);
  const dropped_fraction = fraction(dropped, total);
  const trees_fraction = fraction(trees_dropped, trees_total);
  const areas_fraction = fraction(areas_dropped, areas_total);
  const penalty =
    SCORE_WEIGHT_DROPPED * dropped_fraction +
    SCORE_WEIGHT_WIDENED * widened_fraction +
    SCORE_WEIGHT_TREES * trees_fraction +
    SCORE_WEIGHT_AREAS * areas_fraction;
  const score = Math.max(0, Math.min(100, TOK.round_half_up(100.0 - penalty)));
  const band = score >= SCORE_BAND_GOOD ? "good" : score >= SCORE_BAND_FAIR ? "fair" : "poor";
  return {
    buildings_total: total,
    widened,
    dropped,
    widened_fraction,
    dropped_fraction,
    trees_total,
    trees_dropped_fraction: trees_fraction,
    areas_total,
    areas_dropped_fraction: areas_fraction,
    min_wall_ground_m: thresholds.min_wall,
    score,
    band,
  };
}

function widened_fraction_at(
  footprints: ReadonlyArray<[number, number]>,
  params: ParamsLike,
  radius_m: number,
): number {
  if (footprints.length === 0) return 0.0;
  const thresholds = thresholds_ground_m(params, scale_mm_per_m(params, radius_m));
  const [widened] = building_counts(footprints, thresholds);
  return widened / footprints.length;
}

/**
 * The largest radius that keeps the widened fraction under the target, searched
 * on a deterministic 10 m grid from the current radius down to the contract's
 * 250 m floor. Solved, not looked up: the answer moves with the plate, the
 * nozzle and the city. Null when even 250 m is too coarse.
 */
export function recommend_radius_m(
  scene: AdvisorSceneLike,
  params: ParamsLike,
  radius_m: number,
  max_widened_fraction: number = MAX_WIDENED_FRACTION,
): number | null {
  const footprints = char_widths(scene);
  if (footprints.length === 0) return null;
  let current = floor_to_grid(radius_m, RADIUS_GRID_M);
  if (current < RADIUS_MIN_M) current = RADIUS_MIN_M;
  const steps = Math.round((current - RADIUS_MIN_M) / RADIUS_GRID_M);
  for (let i = 0; i <= steps; i += 1) {
    const candidate = current - i * RADIUS_GRID_M;
    if (widened_fraction_at(footprints, params, candidate) < max_widened_fraction) {
      return candidate;
    }
  }
  return null;
}

/**
 * The smallest plate that keeps the widened fraction under the target at the
 * CURRENT radius -- the other half of the advice, "keep the crop, print it
 * bigger". Null when even 256 mm is not enough.
 */
export function recommend_plate_mm(
  scene: AdvisorSceneLike,
  params: ParamsLike,
  radius_m: number,
  max_widened_fraction: number = MAX_WIDENED_FRACTION,
): number | null {
  const footprints = char_widths(scene);
  if (footprints.length === 0) return null;
  const steps = Math.round((PLATE_MAX_MM - PLATE_MIN_MM) / PLATE_GRID_MM);
  for (let i = 0; i <= steps; i += 1) {
    const candidate = PLATE_MIN_MM + i * PLATE_GRID_MM;
    const view: ParamsLike = { ...params, plate_mm: candidate };
    if (widened_fraction_at(footprints, view, radius_m) < max_widened_fraction) {
      return candidate;
    }
  }
  return null;
}

/**
 * One sentence naming the damage and the two ways out, or null when healthy:
 * `Radius 2400 m at plate 180 widens 65%. Try 540 m.` -- reproduced on the
 * committed Chicago fixture, replacing an invented example whose "drops N
 * buildings" clause is unreachable from any SceneGraph (v2-03 audit, finding
 * 11). The clause is still built below: the rule that would fire it is 04's.
 */
export function detail_recommendation(
  scene: AdvisorSceneLike,
  params: ParamsLike,
  radius_m: number,
  max_widened_fraction: number = MAX_WIDENED_FRACTION,
): string | null {
  const report = detail_report(scene, params, radius_m);
  const healthy =
    report.dropped === 0 && report.widened_fraction < max_widened_fraction;
  if (healthy || report.buildings_total === 0) return null;

  const radius_text = TOK.round_half_up(radius_m);
  const plate_text = TOK.round_half_up(params.plate_mm);
  const percent = TOK.round_half_up(100.0 * report.widened_fraction);
  let head: string;
  if (report.dropped > 0 && percent > 0) {
    head =
      `Radius ${radius_text} m at plate ${plate_text} drops ` +
      `${TOK.group_thousands(report.dropped)} buildings and widens ${percent}%.`;
  } else if (report.dropped > 0) {
    head =
      `Radius ${radius_text} m at plate ${plate_text} drops ` +
      `${TOK.group_thousands(report.dropped)} buildings.`;
  } else {
    head = `Radius ${radius_text} m at plate ${plate_text} widens ${percent}%.`;
  }

  let better_radius = recommend_radius_m(scene, params, radius_m, max_widened_fraction);
  if (better_radius !== null && better_radius >= radius_m) better_radius = null;
  let better_plate = recommend_plate_mm(scene, params, radius_m, max_widened_fraction);
  // Only ever offer a remedy that is a CHANGE in the helpful direction.
  if (better_plate !== null && better_plate <= params.plate_mm) better_plate = null;

  if (better_radius !== null && better_plate !== null) {
    return (
      head +
      ` Try ${TOK.round_half_up(better_radius)} m, or plate ` +
      `${TOK.round_half_up(better_plate)}.`
    );
  }
  if (better_radius !== null) return head + ` Try ${TOK.round_half_up(better_radius)} m.`;
  if (better_plate !== null) return head + ` Try plate ${TOK.round_half_up(better_plate)}.`;
  return head + " No radius or plate in range fixes it: raise the nozzle detail instead.";
}
