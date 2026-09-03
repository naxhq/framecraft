/**
 * Measuring the finished solid: minimum wall, bounds, triangles.
 *
 * The minimum wall is measured by MORPHOLOGICAL OPENING, not by a distance
 * field and not by the hydraulic diameter the repair uses to decide a
 * dilation. An opening at radius `w / 2` erases every part of a region narrower
 * than `w`; if what it erases is under one per cent of the area, nothing of
 * consequence in that slice is thinner than `w`. Binary searching the largest
 * such `w` is therefore a direct answer to "how thick is this thing", which is
 * what 04 stage 4's `min_wall` row asks and what the reference implementation
 * measures with GEOS' maximum inscribed circle.
 *
 * The units are print millimetres throughout, and the measurement runs on the
 * assembled model, so what is reported is the narrowest wall the printer will
 * actually be asked to lay down.
 */

import { perfSpan } from "../../perf";
import * as T from "../../transform";
import type { BuildContext } from "./context";
import {
  MIN_WALL_KEEP_FACTOR,
  MIN_WALL_PROBE_FACTOR,
  RESIDUE_AREA_RATIO,
  hydraulicWidthMm,
  residueParts,
} from "./repair";
import type { CrossSection, Manifold } from "./manifold";
import { Arena, ROUND } from "./manifold";
import type { RegionMesh } from "../types";

/** Fraction of a slice's area an opening may remove and still count as "fits". */
export const OPENING_KEEP_FRACTION = 0.99;

/** Resolution of the binary search, print mm. One fortieth of a 0.4 nozzle. */
export const OPENING_RESOLUTION_MM = 0.01;

/**
 * Segments per full circle in the opening's round joins.
 *
 * 64 for a REPORTED measurement and 16 for the repair's internal one. The
 * difference is not cosmetic: a 16-gon disc is 2 % narrower across its flats
 * than the circle it stands for, and 2 % of a 0.8 mm wall is exactly the gap
 * between "0.795 mm, fails" and "0.801 mm, passes". A coarse probe inside the
 * repair only ever widens a wing slightly more than it had to, which is the
 * harmless direction; a coarse probe in the gate reports a number that is
 * wrong.
 */
export const OPENING_SEGMENTS = 64;
export const REPAIR_OPENING_SEGMENTS = 16;

/**
 * Ceiling of the whole-slice opening search, as a multiple of the minimum wall.
 */
export const OPENING_BRACKET = 1.5;

/**
 * Vertex simplification applied to a slice before it is measured, print mm.
 *
 * A slice through the assembled Chicago model carries ~40 000 vertices, most of
 * them collinear pairs left by the union of two coplanar road ribbons. Removing
 * them costs one pass and takes the measurement from 13 s to under 3 s; a
 * 2 micrometre boundary move cannot change a reading whose resolution is
 * 10 micrometres.
 */
export const SLICE_SIMPLIFY_MM = 0.002;

/**
 * The look-ahead of the "is this a wall or a lip?" test, as a fraction of the
 * nozzle (`checks.WALL_PERSIST_PER_NOZZLE`).
 *
 * 0.625 nozzles is the classic 0.25 mm layer at a 0.4 mm nozzle. A region that
 * does not survive one printed layer upward is not a wall: it is the top of a
 * ridge, a roof, or the tip of a cone, and measuring its width says nothing
 * about what the printer has to do. Without this test the narrowest thing in
 * the Chicago model reads as 0.010 mm - a 0.1 mm tall ridge of base between two
 * grooves, which prints as a bump on a solid surface, and which the reference
 * validator does not measure either.
 */
export const WALL_PERSIST_PER_NOZZLE = 0.625;

/** Fraction of a region that must survive the look-ahead to count as a wall. */
export const WALL_PERSIST_RATIO = 0.7;

export interface OpeningOptions {
  keepFraction?: number;
  resolutionMm?: number;
  segments?: number;
}

/**
 * The largest `w` for which opening `section` by `w` keeps at least
 * `keepFraction` of its area, in print millimetres.
 *
 * Returns 0 when even the smallest probe removes more than the tolerance, which
 * means the section is essentially all thin.
 */
export function openingWidthMm(
  section: CrossSection,
  maxMm: number,
  options: OpeningOptions = {},
): number {
  const resolutionMm = options.resolutionMm ?? OPENING_RESOLUTION_MM;
  const area = section.area();
  if (!(area > 0)) return 0;
  const survives = (width: number): boolean =>
    survivesOpening(section, width, area, options);
  if (!survives(resolutionMm)) return 0;
  let lo = resolutionMm;
  let hi = maxMm;
  if (survives(hi)) return hi;
  while (hi - lo > resolutionMm) {
    const mid = (lo + hi) / 2;
    if (survives(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * The width of the widest disc that fits inside `section`, print mm.
 *
 * This is the reference validator's own measure (`thicken.inscribed_width`,
 * twice GEOS' maximum inscribed circle) expressed as an erosion, which is what
 * Clipper2 can answer: a disc of `w` fits exactly when `offset(-w / 2)` leaves
 * something behind. It is the right question for a REGION - "is there anywhere
 * in this island the nozzle can lay a bead" - and the area-ratio opening above
 * is the right question for a whole slice. Using the area rule on a single
 * region bottoms out at zero the moment the region has a thin tail worth more
 * than a per cent of its area, which says nothing about the region's width.
 */
export function inscribedWidthMm(
  section: CrossSection,
  maxMm: number,
  resolutionMm: number = OPENING_RESOLUTION_MM,
): number {
  const fits = (width: number): boolean => {
    if (width <= 0) return true;
    const eroded = section.offset(-width / 2, ROUND, 2, OPENING_SEGMENTS);
    const alive = !eroded.isEmpty();
    eroded.delete();
    return alive;
  };
  if (!fits(resolutionMm)) return 0;
  let lo = resolutionMm;
  let hi = maxMm;
  if (fits(hi)) return hi;
  while (hi - lo > resolutionMm) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * The narrowest printable width anywhere in a slice region, print mm.
 *
 * `thicken.narrowest_width`, which is what the reference validator reports: the
 * region's OWN inscribed width, lowered by the inscribed width of every
 * appendage the `0.45 * min_wall` opening leaves behind.
 *
 * The difference from {@link inscribedWidthMm} alone is the whole reason the
 * engine's gate and the reference validator disagreed on a draped model. The
 * widest disc that fits somewhere in a region says nothing about a 0.14 mm wing
 * hanging off it, and a FLAT build never has one - Stage 1 strips or widens every
 * thin appendage in 2D, so by the time a slice is taken there are none left. A
 * DRAPED build has them everywhere: the repair works on the flat footprint, and a
 * horizontal cut through a hillside is an oblique cut through that footprint, so
 * it produces wings the 2D repair never saw (`[V3-P3-G16]`).
 *
 * The cheap `4A/P` pre-filter goes in front of the residue machinery for the
 * same reason `widenThinParts` uses it: a region with no thin limb has a
 * hydraulic diameter well over a wall, and asking Clipper for its appendages
 * costs four offsets that will find nothing.
 *
 * It is NOT what `thicken.narrowest_width` does, and it is a known gap
 * (`[V3-P7-fix]`). `4A/P` never UNDER-reports a long strip, which is what makes
 * it safe on a WING; it says nothing about a fat region that happens to carry
 * one, and a merged Chicago block measures 4A/P = 6.4 mm while carrying a
 * 0.17 mm one. Removing it was measured: it takes the default build from 6 s to
 * over 16 s against a 15 s budget, and it turns three draped fixtures from
 * clean into `wall-too-thin` at 0.158 mm - findings that may well be real, and
 * that nobody has judged. Both belong to the same piece of work as
 * `measureMinWall`'s own flat blind spot, not to this fix.
 */
export function narrowestWidthMm(
  ctx: BuildContext,
  section: CrossSection,
  maxMm: number,
): number {
  const minWall = ctx.thresholdsMm.minWall;
  let width = inscribedWidthMm(section, maxMm);
  if (!(minWall > 0) || width <= OPENING_RESOLUTION_MM) return width;
  if (hydraulicWidthMm(section) >= 2 * minWall) return width;
  const minDetail = ctx.thresholdsMm.minDetail;
  const parts = residueParts(
    ctx,
    section,
    MIN_WALL_PROBE_FACTOR * minWall,
    RESIDUE_AREA_RATIO * minDetail * minDetail,
  );
  if (parts === null) return width;
  for (const part of parts) {
    width = Math.min(width, inscribedWidthMm(part, maxMm));
    ctx.arena.drop(part);
  }
  return width;
}

/**
 * Does opening `section` by `width` keep enough of its area?
 *
 * Exposed on its own because the answer is worth having without the search
 * around it: measuring N slices only needs the SMALLEST width, so a slice that
 * survives the best width found so far cannot be the narrowest and is skipped
 * after this one question instead of being searched from scratch. On the
 * Chicago plate that is the difference between ~200 offsets and ~40.
 */
export function survivesOpening(
  section: CrossSection,
  width: number,
  area: number = section.area(),
  options: OpeningOptions = {},
): boolean {
  if (width <= 0) return true;
  if (!(area > 0)) return false;
  const keepFraction = options.keepFraction ?? OPENING_KEEP_FRACTION;
  const segments = options.segments ?? OPENING_SEGMENTS;
  const arena = new Arena();
  try {
    const radius = width / 2;
    const eroded = arena.keep(section.offset(-radius, ROUND, 2, segments));
    if (eroded.isEmpty()) return false;
    const opened = arena.keep(eroded.offset(radius, ROUND, 2, segments));
    return opened.area() >= keepFraction * area;
  } finally {
    arena.dispose();
  }
}

/**
 * Z heights the min-wall probe samples, print mm.
 *
 * Every band where the model changes character gets a slice: the middle of the
 * base, the floor and the mouth of the deepest recess, just under and just over
 * the base top, the frame lip, and four evenly spaced heights through the
 * buildings. A wall that is thin only between two of these is thin over a
 * vanishing height and is not what the check is for.
 */
/**
 * A Z range this measurement must not judge: `[low, high]`, print mm.
 *
 * There is one kind of them, and `solid/attribution.ts` produces it: the band
 * the UNDERSIDE POCKETS occupy. See {@link measureMinWall}.
 */
export type SkipBand = readonly [number, number];

/**
 * A plan region the probe must not judge inside one Z band (v3.1 Task 12).
 *
 * A surface label's strokes and the ridges between its letters are text, and
 * text is judged by the lettering rules (`solid/lettering.ts:repairText`, and
 * the reference validator's `labels` row), not as free-standing walls: a
 * 0.5 mm ridge of roof between two engraved letters is surface texture on a
 * solid block. Unlike a `SkipBand`, which drops the whole slice height, a
 * mask removes only the label's own ink rectangle from the slice, so every
 * other wall at that height is still measured (the same masking the reference
 * validator applies from the sidecar's `label_bands`).
 */
export interface SliceMask {
  zMm: readonly [number, number];
  /** The rectangle to remove, a live section in the caller's arena. */
  section: CrossSection;
}

/** The masks active at `z`, or an empty list. */
function masksAt(z: number, masks: readonly SliceMask[]): SliceMask[] {
  return masks.filter((mask) => z >= mask.zMm[0] && z <= mask.zMm[1]);
}

/** True when `z` falls inside one of the skipped bands. */
function skipped(z: number, bands: readonly SkipBand[]): boolean {
  return bands.some(([low, high]) => z >= low && z <= high);
}

export function sliceHeights(
  ctx: BuildContext,
  topMm: number,
  skipBands: readonly SkipBand[] = [],
): number[] {
  const baseTop = ctx.baseTopMm;
  const eps = 0.05;
  // The bottom-most sample moves ABOVE the deepest underside pocket rather than
  // being dropped: the plate under the marks still has to be measured, and just
  // over their floor is where it is thinnest.
  const floorTop = skipBands.reduce((high, band) => Math.max(high, band[1]), 0);
  const out = new Set<number>([
    floorTop + eps,
    baseTop / 2,
    baseTop - eps,
    baseTop + eps,
  ]);
  const params = ctx.params;
  const regions = params.regions;
  for (const spec of [regions?.roads, regions?.water, regions?.parks, regions?.rail]) {
    if (spec === undefined) continue;
    const proud = spec.proud_mm ?? 0;
    const depth = spec.depth_mm ?? 0;
    out.add(Math.max(eps, baseTop + proud - depth / 2));
    if (proud < 0) out.add(Math.max(eps, baseTop + proud / 2));
  }
  if (params.frame) {
    out.add(baseTop + 1.0);
  }
  const span = topMm - baseTop;
  if (span > 0.5) {
    for (const t of [0.15, 0.35, 0.6, 0.85]) {
      out.add(baseTop + span * t);
    }
  }
  return [...out]
    .filter((z) => z > 0 && z < topMm && !skipped(z, skipBands))
    .sort((a, b) => a - b);
}

/**
 * Extra Z samples the DRAPED model needs, print mm. Empty for a flat build.
 *
 * Every height above is a feature PLANE of the flat model: the mouth of a
 * groove, the floor of a recess, just under the base top. Draping smears each
 * of those planes over a band `reliefMm` tall, because the surface it belongs to
 * now sits at a different height at every point of the plate. A fixed set of
 * heights therefore samples each feature at one arbitrary point of its own
 * range and misses the rest, which is exactly the gap the reference validator
 * found and this measurement did not: the engine read 0.8 mm (saturated) on a
 * 60 m-relief Chicago while the validator read 0.146 mm.
 *
 * So each flat height is walked across its own relief band. The count is capped
 * because every slice is an erosion of a 40 000-vertex section, and the bands
 * are shared: `MAX_DRAPED_SLICES` total, spread evenly over the union of the
 * bands rather than per feature.
 *
 * This runs ONLY when a drape is active, so no flat build samples a single extra
 * height and the committed golden's numbers cannot move (`[V3-P3-G16]`).
 */
export function drapedSliceHeights(
  ctx: BuildContext,
  flat: readonly number[],
  reliefMm: number,
  topMm: number,
): number[] {
  if (!(reliefMm > 0) || flat.length === 0) return [];
  const lowest = Math.min(...flat);
  const highest = Math.min(topMm, Math.max(...flat) + reliefMm);
  if (!(highest > lowest)) return [];
  // A pitch fine enough to catch a feature that only presents thin over part of
  // its band, floored so a huge relief does not ask for a thousand slices.
  const wanted = Math.min(
    MAX_DRAPED_SLICES,
    Math.max(flat.length, Math.ceil((highest - lowest) / DRAPED_SLICE_PITCH_MM)),
  );
  const step = (highest - lowest) / wanted;
  const out: number[] = [];
  for (let i = 0; i <= wanted; i += 1) {
    const z = lowest + i * step;
    if (z > 0 && z < topMm) out.push(z);
  }
  return out;
}

/**
 * Target pitch of the draped Z sweep, print mm.
 *
 * A quarter of the shallowest recess the contract allows (`depth_mm` floors at
 * 0.2 mm), so no groove can pass between two samples unseen.
 */
export const DRAPED_SLICE_PITCH_MM = 0.05;

/**
 * Ceiling on the draped sweep's slice count.
 *
 * Each slice costs an erosion of the whole assembled section, so this is a time
 * budget, not a resolution choice: 96 slices of the Chicago plate is about six
 * seconds, which is a price worth paying on a build the user asked to put a
 * hillside under and never paid on one they did not.
 */
export const MAX_DRAPED_SLICES = 32;

export interface MinWallReport {
  measuredMm: number | null;
  /** Z of the slice that produced the narrowest measurement. */
  atZMm: number | null;
  slices: number;
  /**
   * How many connected slice regions came out under the minimum wall.
   *
   * The narrowest number alone cannot tell "one sliver at the crop edge" from
   * "every groove on the plate", and those want different advice. Counted the
   * way the reference validator counts it: once per thin region per slice.
   */
  thinRegions: number;
}

/**
 * The narrowest wall in the assembled model, print mm.
 *
 * `null` when the solid has no area at any sampled height, which only happens
 * for an empty scene.
 */
export function measureMinWall(
  ctx: BuildContext,
  solid: Manifold,
  skipBands: readonly SkipBand[] = [],
  masks: readonly SliceMask[] = [],
): MinWallReport {
  const bbox = solid.boundingBox();
  const flat = sliceHeights(ctx, bbox.max[2], skipBands);
  /** The printed relief, or null for a flat build. Every terrain branch reads it. */
  const draped =
    ctx.terrain === null
      ? null
      : T.terrain_z_mm(ctx.terrain.rangeM, ctx.params, ctx.scale);
  // A draped model needs the sweep as well as the planes: see
  // `drapedSliceHeights`. `ctx.terrain` is null for every flat build, so this is
  // exactly `flat` there and no committed number can move.
  const heights =
    draped === null
      ? flat
      : [
          ...new Set([...flat, ...drapedSliceHeights(ctx, flat, draped, bbox.max[2])]),
        ].sort((a, b) => a - b);
  let narrowest: number | null = null;
  let atZ: number | null = null;
  let sampled = 0;
  let thinRegions = 0;
  // Probed at HALF a wall, so "not thin" means a disc of a full minimum wall
  // fits - the same factor the repair keeps a region on
  // (`repair.MIN_WALL_KEEP_FACTOR`), so the gate and the repair cannot disagree
  // about which regions are worth measuring.
  const probe = MIN_WALL_KEEP_FACTOR * ctx.thresholdsMm.minWall;
  const persist = WALL_PERSIST_PER_NOZZLE * ctx.params.nozzle_mm;
  for (const z of heights) {
    // A pocket cut into the BOTTOM face is not a wall, and the ridges and
    // counters it leaves are not free-standing: the plate above them is solid,
    // so they persist upward perfectly and would be measured as walls they are
    // not. The reference validator excludes the same band for the same reason
    // (`app/validate/checks.py::_min_wall_probe`, `skip_bands`) and hands it to
    // its purpose-built `base_floor` row, which asks the question that actually
    // matters there: is there still a millimetre of plate over the pocket?
    // Here that question is `attribution.deepMarkDepthMm`'s own clamp, which
    // refuses to cut deeper than the plate can carry (`[V3-P7-A8]`).
    if (skipped(z, skipBands)) continue;
    const section = perfSpan("measure.slice", () => solid.slice(z));
    const active = masksAt(z, masks);
    // A label's ink rectangle is taken out of the slice before it is judged
    // (`SliceMask`); the rest of the slice at this height is measured as ever.
    const masked =
      active.length === 0 ? section : ctx.wasm.CrossSection.difference([section, ...active.map((mask) => mask.section)]);
    const lean = perfSpan("measure.simplify", () => masked.simplify(SLICE_SIMPLIFY_MM));
    if (masked !== section) masked.delete();
    const above = perfSpan("measure.slice", () => solid.slice(z + persist));
    const components: CrossSection[] = [];
    try {
      const area = lean.area();
      if (lean.isEmpty() || area <= 0) continue;
      sampled += 1;
      // PER CONNECTED REGION, not per slice. A whole-slice opening answers
      // "how thick is this slice", and one narrow island among the 1200
      // regions of a Chicago slice is under a per cent of its area, so a
      // 99 % rule cannot see it - the reference validator measures each
      // region's inscribed circle and does (`checks.min_wall`). The cheap
      // form of the same question is one erosion per region: what survives
      // `offset(-0.45 * min_wall)` is at least 0.9 of a wall wide somewhere,
      // and only what does not is worth searching.
      components.push(...perfSpan("measure.decompose", () => lean.decompose()));
      for (const piece of components) {
        // On a FLAT build only a region that VANISHES under the erosion probe is
        // measured, and this is a known blind spot rather than a claim
        // (`[V3-P7-fix]`). The old comment argued that Stage 1 removes every
        // thin appendage in 2D so a region holding a full disc holds it
        // everywhere; the frame-off Chicago plate disproved it - one merged
        // block held a 3.37 mm disc and carried a 0.17 mm wing, and the gate
        // saturated at 0.80 mm while the reference validator failed the file at
        // 0.1667 mm. That wing is now removed at source (`repair.residueParts`
        // finds it, so `widenThinParts` widens it), but the gate would still not
        // SEE the next one. Measuring every persisting region by the
        // appendage-aware rule is what the reference validator does and what
        // this should do; it was measured at 13.4 s against the 15 s budget on
        // the default Chicago build (5.3 s today), and the cost is the residue
        // probe itself, four offsets per region per slice, not the width search
        // behind it. Closing it needs a cheaper appendage probe, and that is a
        // piece of work of its own rather than a line here.
        //
        // A DRAPED build is cut obliquely through those same footprints and grows
        // wings the 2D repair never saw, so every persisting region is measured
        // there, and measured by the appendage-aware rule (`[V3-P3-G16]`).
        //
        // This probe runs BEFORE the persistence test below, and the order is
        // load-bearing for the wall clock rather than for the answer - both are
        // `continue` filters, so the set they pass through is the same either
        // way (`[V3-P7-fix2-1]`). The erosion offsets one REGION, which is small
        // and costs 0.04 ms; the persistence test intersects that region with
        // the whole unsimplified slice one layer up, which on the Chicago plate
        // is tens of thousands of vertices and costs 4.2 ms whatever the region
        // is. Measured at plate 200 (1930 regions over 15 slices): erosion first
        // spends 85 ms and hands the intersect almost nothing, persistence first
        // spends 8162 ms on 1930 intersects. Do not swap them.
        if (draped === null) {
          const thin = perfSpan("measure.erode", () => {
            const eroded = piece.offset(-probe, ROUND, 2, OPENING_SEGMENTS);
            const empty = eroded.isEmpty();
            eroded.delete();
            return empty;
          });
          if (!thin) continue;
        }
        // A wall, or the top of a ridge? Only what survives one printed layer
        // upward is judged (`WALL_PERSIST_PER_NOZZLE`).
        if (!above.isEmpty()) {
          const survives = perfSpan("measure.persist", () => {
            const kept = piece.intersect(above);
            const enough = kept.area() >= WALL_PERSIST_RATIO * piece.area();
            kept.delete();
            return enough;
          });
          if (!survives) continue;
        }
        const width = perfSpan("measure.width", () =>
          draped === null
            ? inscribedWidthMm(piece, ctx.thresholdsMm.minWall)
            : narrowestWidthMm(ctx, piece, ctx.thresholdsMm.minWall),
        );
        if (width < ctx.thresholdsMm.minWall) thinRegions += 1;
        if (narrowest === null || width < narrowest) {
          narrowest = width;
          atZ = z;
        }
      }
      // Nothing thin in this slice: every region in it holds a disc of a full
      // minimum wall. The measurement SATURATES there rather than searching
      // upward - the only question it exists to answer is whether the model
      // clears the nozzle, and every extra millimetre of range costs another
      // erosion of a 40 000-vertex slice.
      if (narrowest === null) {
        narrowest = ctx.thresholdsMm.minWall;
        atZ = z;
      }
    } finally {
      for (const piece of components) piece.delete();
      section.delete();
      lean.delete();
      above.delete();
    }
  }
  return { measuredMm: narrowest, atZMm: atZ, slices: sampled, thinRegions };
}

/** Total triangles across every region. */
export function triangleCount(regions: readonly RegionMesh[]): number {
  let total = 0;
  for (const region of regions) total += region.indices.length / 3;
  return total;
}

/** Axis-aligned bounds over every region, or null when there are none. */
export function regionBounds(
  regions: readonly RegionMesh[],
): { min: [number, number, number]; max: [number, number, number] } | null {
  if (regions.length === 0) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const region of regions) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], region.bbox.min[axis]);
      max[axis] = Math.max(max[axis], region.bbox.max[axis]);
    }
  }
  return { min, max };
}
