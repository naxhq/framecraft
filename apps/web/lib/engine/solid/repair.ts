/**
 * Stage 1 of `04_PRINTABILITY_SPEC.md`, in 2D, through `CrossSection.offset`.
 *
 * This is the port of `services/bake/app/geom/thicken.py`. The reference works
 * in ground metres on shapely; this works in PRINT MILLIMETRES on Clipper2,
 * because that is the only 2D engine the browser has and it is the same engine
 * the extrusion consumes (DECISIONS `[V3-P2-E2]`). The conversion is exact: the
 * map scale is a single positive factor, so `min_wall_ground * scale` and
 * `min_wall_mm` are the same length and every threshold moves with it.
 *
 * 04's rules, in 04's order:
 *
 * 1. characteristic width `4A/P`, dilate anything under a minimum wall, and
 *    then widen anything the formula cleared that a full wall still does not
 *    fit inside (a strip's `4A/P` is twice its width, so the formula alone
 *    leaves strips under the minimum);
 * 2. drop anything still under `min_detail^2` in area, or with no room for a
 *    full minimum wall anywhere in it;
 * 3. close the layer at `min_gap / 2` so unprintable slivers between
 *    neighbours fuse, then take the area-weighted 80th percentile height per
 *    merged block and stack anything over 1.5x it on top;
 * 4. repair per APPENDAGE, not per region: closing the layer creates wings
 *    (two footprints fusing across a sliver leave the sliver as a limb), and a
 *    0.5 mm wing on a 40 mm block passes every whole-region test there is. A
 *    building's wing is widened, a raised surface layer's wing is cut off.
 *
 * What is NOT ported: the maximum inscribed circle (Clipper2 has no such query,
 * so every width here is an erosion or an opening) and the print-grid snap
 * (Clipper2's own integer grid does that job). `measure.ts` checks the finished
 * result with the same morphological opening, so the repair and the gate cannot
 * drift.
 */

import type { Point, Road } from "../../contracts";
import * as T from "../../transform";
import type { BakeContext } from "./context";
import { CIRCLE_SEGMENTS, LAYER_SEPARATION_MM, SIMPLIFY_EPS_MM } from "./context";
import type { Contour, CrossSection } from "./manifold";
import {
  MITRE,
  circleContour,
  closeSection,
  contoursFromRings,
  intersectSection,
  offsetSection,
  rectContour,
  sectionOf,
  signedArea2,
  cleanSection,
  subtractSection,
  unionSections,
} from "./manifold";
import {
  OPENING_KEEP_FRACTION,
  REPAIR_OPENING_SEGMENTS,
  openingWidthMm,
} from "./measure";

/**
 * Erosion probe factor for isolating an APPENDAGE
 * (`thicken.MIN_WALL_PROBE_FACTOR`): what an opening at `0.45 * min_wall`
 * cannot reach is narrower than `0.9 * min_wall`, which is what the gate fails
 * on.
 */
export const MIN_WALL_PROBE_FACTOR = 0.45;

/**
 * Erosion probe factor for keeping a REGION.
 *
 * Half a wall, so a region survives only if a disc of a FULL minimum wall fits
 * inside it somewhere. The reference implementation repairs to the full wall
 * and only fails at 0.9 of one for the same reason it gives in
 * `thicken.MIN_WALL_REPAIR_FACTOR`: the repair works on outlines and the gate
 * works on slices of a boolean result, so the same wall is measured twice
 * through two different pipelines. Repairing to 0.9 leaves regions measuring
 * 0.72 mm against a 0.72 mm threshold; repairing to 1.0 leaves none and costs
 * nothing measurable.
 */
export const MIN_WALL_KEEP_FACTOR = 0.5;

/** How many tenth-of-a-wall dilations `widenToMinWall` tries before giving up. */
export const MIN_WALL_WIDEN_ROUNDS = 6;

/** 04 stage 1, buildings 5: the block height is this area-weighted percentile. */
export const BLOCK_HEIGHT_PERCENTILE = 0.8;

/** 04 stage 1, buildings 5: a contributor over this multiple keeps its own solid. */
export const STACK_HEIGHT_FACTOR = 1.5;

/**
 * Mitre limit for the opening that isolates thin appendages
 * (`thicken.RESIDUE_MITRE_LIMIT`). A high limit keeps a sharp convex corner
 * where it was, so only genuinely narrow limbs show up as residue instead of
 * every acute corner of every OSM footprint.
 */
export const RESIDUE_MITRE_LIMIT = 10.0;

/**
 * Tolerance on the opening boundary, as a fraction of a wall
 * (`thicken.RESIDUE_EDGE_TOLERANCE`). An offset curve does not reproduce a long
 * straight edge to the last bit, so `component - opening` comes back with a
 * hairline running the length of the boundary whose AREA is that of a real wing
 * and whose width is that of nothing at all. Growing the opening by this much
 * first removes it exactly, while a real wing loses a fraction of a per cent.
 */
export const RESIDUE_EDGE_TOLERANCE = 0.02;

/**
 * Noise floor for a residue part, as a fraction of `min_detail^2`
 * (`thicken.RESIDUE_AREA_RATIO`). It exists only to throw away what the opening
 * leaves at a corner; a real wing is orders of magnitude bigger.
 */
export const RESIDUE_AREA_RATIO = 0.25;

/**
 * Repair-and-remeasure rounds for the appendage passes.
 *
 * Repairing a wing exposes a second one where it met the body - widening fills
 * a notch, cutting opens one - so one pass is never enough
 * (`thicken.APPENDAGE_ROUNDS`, which is four). Three clears the Chicago plate,
 * and the loop exits as soon as a round finds nothing, so a component that is
 * already clean pays for one probe and no more.
 */
export const APPENDAGE_ROUNDS = 3;

/** A height carrier, duck-typing `transform.BuildingLike`. */
export interface HeightSpec {
  height_m: number;
  is_tall: boolean;
  is_hero: boolean;
}

/** One extrudable footprint in print millimetres. */
export interface BuildingSolid {
  section: CrossSection;
  height: HeightSpec;
  /** The block this solid stands on, or null when it rises from the plate. */
  standsOn: HeightSpec | null;
  /** SceneGraph id when this solid IS a hero the user picked. */
  heroId: string | null;
  /** Footprints this solid swallowed (1 for an unmerged block). */
  members: number;
}

export interface RepairedBuildings {
  solids: BuildingSolid[];
  /** Union of every block footprint: what the base is socketed with. */
  footprint: CrossSection | null;
  /** Footprints widened to reach a full minimum wall. */
  dilated: number;
  /** Footprints that disappeared into a shared block. */
  merged: number;
  /** Footprints dropped under the minimum printable size. */
  dropped: number;
  /** Buildings whose height came from `height_source === "default"`. */
  heightFallbacks: number;
  heroUnknown: string[];
  heroBuried: string[];
  heroDropped: string[];
}

/**
 * A layer that already owns its ground, and whether to leave a gap round it.
 *
 * `separate` holds the two layers `LAYER_SEPARATION_MM` apart so they never
 * share a vertical face. That is right when the blocker still HAS material at
 * the height where the gap appears - a building wall, a flush park - because
 * then the strip of base left in the gap is attached to it and prints as part
 * of it. It is wrong between two RECESSES: there the strip is a free-standing
 * wall between two voids, 0.02 mm wide, which is the narrowest thing on the
 * plate (measured at z = 2.90 mm on Chicago before this distinction existed).
 * Two recesses therefore abut, and the handful of boolean slivers that costs is
 * cleaned on the way out (`solid/mesh.ts`).
 */
export interface Blocker {
  section: CrossSection | null;
  separate: boolean;
}

export interface RepairedLayer {
  section: CrossSection | null;
  dropped: number;
}

// ---------------------------------------------------------------------------
// Small geometry helpers
// ---------------------------------------------------------------------------

/** Area-weighted centroid of a contour, mm. */
function contourCentroid(contour: Contour): [number, number] {
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < contour.length; i += 1) {
    const a = contour[i];
    const b = contour[(i + 1) % contour.length];
    const cross = a[0] * b[1] - b[0] * a[1];
    twiceArea += cross;
    cx += (a[0] + b[0]) * cross;
    cy += (a[1] + b[1]) * cross;
  }
  if (Math.abs(twiceArea) < 1e-12) {
    return [contour[0][0], contour[0][1]];
  }
  return [cx / (3 * twiceArea), cy / (3 * twiceArea)];
}

/** Even-odd point-in-region test over every ring of a component. */
function pointInContours(x: number, y: number, contours: readonly Contour[]): boolean {
  let inside = false;
  for (const ring of contours) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

interface Bounds2 {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boundsOfContours(contours: readonly Contour[]): Bounds2 {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of contours) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * The area-weighted percentile 04 stage 1 asks for, and the index that supplied
 * it so the caller can inherit `is_tall` instead of recomputing it.
 *
 * Definition, verbatim from `thicken._weighted_percentile`: the smallest value
 * whose cumulative weight reaches `q` of the total, ties broken on the original
 * index so both implementations agree exactly.
 */
export function weightedPercentile(
  values: readonly number[],
  weights: readonly number[],
  q: number,
): [number, number] {
  const order = values
    .map((_v, i) => i)
    .sort((a, b) => (values[a] === values[b] ? a - b : values[a] - values[b]));
  let total = 0;
  for (const w of weights) total += w;
  if (!(total > 0)) {
    const last = order[order.length - 1];
    return [values[last], last];
  }
  const target = q * total;
  let running = 0;
  for (const i of order) {
    running += weights[i];
    if (running >= target - 1e-12) return [values[i], i];
  }
  const last = order[order.length - 1];
  return [values[last], last];
}

// ---------------------------------------------------------------------------
// Layer plumbing shared by buildings, roads, water, parks and rail
// ---------------------------------------------------------------------------

/** The square every additive layer is clipped to, as a section. */
export function cropSection(ctx: BakeContext, halfMm: number): CrossSection {
  const section = sectionOf(ctx.wasm, ctx.arena, [
    rectContour(-halfMm, -halfMm, halfMm, halfMm),
  ]);
  if (section === null) throw new Error("the crop square is empty");
  return section;
}

// ---------------------------------------------------------------------------
// Appendages
//
// "Does eroding this region leave anything?" answers a question about the
// REGION: a 0.5 mm wing hanging off a 40 mm block passes it, because the block
// survives. The opening RESIDUE is that wing on its own, so it can be measured
// and repaired on its own, which is the whole reason 04's dilation rule is
// applied per appendage and not per footprint (`thicken._residue`).
// ---------------------------------------------------------------------------

/** Perimeter of one contour, mm. */
function contourPerimeter(contour: Contour): number {
  let total = 0;
  for (let i = 0; i < contour.length; i += 1) {
    const a = contour[i];
    const b = contour[(i + 1) % contour.length];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
}

/**
 * 04 stage 1, buildings 1: the hydraulic diameter `4A/P` of a section.
 *
 * 04 names this measure by formula and calls it "cheap and good enough", which
 * it is for a whole footprint: a blobby shape's `4A/P` is close to its real
 * width. It is NOT good enough for an appendage, and that is not a subtlety -
 * for a `w` by `L` strip with `L >> w` it converges on `2w`, so it reports a
 * 0.4 mm wing as 0.8 mm wide and the widening pass leaves it exactly as it
 * found it. It is kept as the cheap pre-filter in front of the real
 * measurement below.
 */
export function hydraulicWidthMm(section: CrossSection): number {
  const area = section.area();
  if (!(area > 0)) return 0;
  let perimeter = 0;
  for (const ring of section.toPolygons()) perimeter += contourPerimeter(ring as Contour);
  if (!(perimeter > 0)) return 0;
  return (4 * area) / perimeter;
}

/**
 * The real width of an appendage, by morphological opening, print mm.
 *
 * The same measurement `measure.ts` applies to a finished slice and the same
 * one the Stage 4 gate reports, so the repair and the gate cannot disagree
 * about what "0.8 mm wide" means. It is only ever run on residue parts, which
 * are small, and only when the cheap `4A/P` pre-filter says the part might be
 * thin - `4A/P` never UNDER-reports a strip, so a part it clears is genuinely
 * wide enough.
 */
export function appendageWidthMm(section: CrossSection, minWall: number): number {
  return openingWidthMm(section, 1.5 * minWall, {
    keepFraction: OPENING_KEEP_FRACTION,
    resolutionMm: minWall / 40,
    segments: REPAIR_OPENING_SEGMENTS,
  });
}

/**
 * The parts of `component` an opening at `radius` cannot reach.
 *
 * `null` means the whole component is narrower than `2 * radius` everywhere, so
 * there is no body to hang appendages off.
 *
 * Exported because the Stage 4 gate needs the same appendages the repair does:
 * `measure.narrowestWidthMm` mirrors `thicken.narrowest_width`, which is the
 * region's own inscribed width LOWERED by every appendage's, and the two must
 * find the same wings or the repair and the gate disagree about what a wall is.
 * The caller owns what comes back and must drop it.
 */
export function residueParts(
  ctx: BakeContext,
  component: CrossSection,
  radius: number,
  areaFloor: number,
): CrossSection[] | null {
  const { arena } = ctx;
  const eroded = offsetSection(arena, component, -radius, MITRE, 0, RESIDUE_MITRE_LIMIT);
  if (eroded === null) return null;
  const opened = offsetSection(arena, eroded, radius, MITRE, 0, RESIDUE_MITRE_LIMIT);
  arena.drop(eroded);
  if (opened === null) return null;
  const tolerated = offsetSection(
    arena,
    opened,
    RESIDUE_EDGE_TOLERANCE * ctx.thresholdsMm.minWall,
    MITRE,
  );
  arena.drop(opened);
  if (tolerated === null) return [];
  const residue = subtractSection(arena, component, tolerated);
  arena.drop(tolerated);
  if (residue === null || residue === component) return [];
  const parts = arena.keepAll(residue.decompose());
  arena.drop(residue);
  const kept: CrossSection[] = [];
  for (const part of parts) {
    if (part.area() >= areaFloor) kept.push(part);
    else arena.drop(part);
  }
  return kept;
}

/**
 * 04's dilation rule applied to the APPENDAGE instead of the footprint.
 *
 * Each wing narrower than a minimum wall is grown by `(min_wall - w) / 2` -
 * 04 stage 1, buildings 2, with `w` measured on the wing - and unioned back, so
 * the wing itself comes up to a full wall instead of printing as one fragile
 * perimeter or being dropped by the slicer. Closing the building layer CREATES
 * such wings (two footprints fusing across a sliver leave the sliver as a
 * limb), which is why this runs after the close and not before it.
 */
export function widenThinParts(
  ctx: BakeContext,
  component: CrossSection,
  rounds: number = APPENDAGE_ROUNDS,
  targetMm?: number,
  keep: CrossSection | null = null,
): CrossSection {
  const { arena, wasm } = ctx;
  const { minDetail } = ctx.thresholdsMm;
  const minWall = targetMm ?? ctx.thresholdsMm.minWall;
  if (!(minWall > 0)) return component;
  const areaFloor = RESIDUE_AREA_RATIO * minDetail * minDetail;
  let current = component;
  for (let round = 0; round < rounds; round += 1) {
    const parts = residueParts(ctx, current, MIN_WALL_PROBE_FACTOR * minWall, areaFloor);
    if (parts === null || parts.length === 0) break;
    const grown: CrossSection[] = [];
    for (const part of parts) {
      if (hydraulicWidthMm(part) >= 2 * minWall) {
        arena.drop(part);
        continue;
      }
      const width = appendageWidthMm(part, minWall);
      if (width >= minWall) {
        arena.drop(part);
        continue;
      }
      const fatter = offsetSection(arena, part, (minWall - width) / 2);
      arena.drop(part);
      if (fatter !== null) grown.push(fatter);
    }
    if (grown.length === 0) break;
    let merged = unionSections(wasm, arena, [current, ...grown]);
    for (const part of grown) arena.drop(part);
    if (merged === null || merged === current) break;
    // A wing grown at the edge of the region it lives in must stay inside it:
    // a building wing widened through the crop square lands in the frame band,
    // and a letter's terminal widened through the lip's rim lands on the base.
    // Clipping HERE rather than after the last round is what lets the next
    // round finish the job inwards, which is the direction that was available
    // all along.
    if (keep !== null) {
      const inside = intersectSection(arena, merged, keep);
      if (inside !== merged) arena.drop(merged);
      if (inside === null) break;
      merged = inside;
    }
    if (current !== component) arena.drop(current);
    current = merged;
  }
  return current;
}

/**
 * The same measurement, used the other way round: CUT the thin appendages off.
 *
 * A raised layer's thin limb is a wall no nozzle can lay down, and unlike a
 * building there is nothing to gain by fattening a 0.3 mm spur of parkland into
 * a 0.8 mm one - it was never a real feature, it is what the union of a hundred
 * OSM polygons leaves at their edges (`thicken.strip_thin_parts`).
 */
export function stripThinParts(
  ctx: BakeContext,
  component: CrossSection,
  rounds: number = APPENDAGE_ROUNDS,
): CrossSection | null {
  const { arena, wasm } = ctx;
  const { minWall, minDetail } = ctx.thresholdsMm;
  if (!(minWall > 0)) return component;
  const areaFloor = RESIDUE_AREA_RATIO * minDetail * minDetail;
  let current: CrossSection = component;
  for (let round = 0; round < rounds; round += 1) {
    const parts = residueParts(ctx, current, MIN_WALL_PROBE_FACTOR * minWall, areaFloor);
    if (parts === null) {
      if (current !== component) arena.drop(current);
      return null;
    }
    const thin = parts.filter(
      (part) =>
        hydraulicWidthMm(part) < 2 * minWall && appendageWidthMm(part, minWall) < minWall,
    );
    for (const part of parts) {
      if (!thin.includes(part)) arena.drop(part);
    }
    if (thin.length === 0) break;
    const cutter = unionSections(wasm, arena, thin);
    const trimmed = cutter === null ? current : subtractSection(arena, current, cutter);
    for (const part of thin) arena.drop(part);
    if (trimmed === null) {
      if (current !== component) arena.drop(current);
      return null;
    }
    if (trimmed === current) break;
    if (current !== component) arena.drop(current);
    current = trimmed;
  }
  return current;
}

/**
 * A layer's components after the closing pair, with the unprintable removed.
 *
 * Three rules, all 04's: an area under `min_detail^2` goes, a component that
 * vanishes under the erosion probe goes (it is narrower than 0.9 of a minimum
 * wall everywhere, which the gate fails on), and a component that survives but
 * carries a wing thinner than a wall has that wing repaired - widened for
 * buildings, cut off for a raised surface layer.
 */
function keepPrintable(
  ctx: BakeContext,
  components: readonly CrossSection[],
  mode: "strip" | "widen" | "keep",
  keep: CrossSection | null = null,
): { kept: CrossSection[]; dropped: number } {
  const { minDetail } = ctx.thresholdsMm;
  const areaFloor = minDetail * minDetail;
  const kept: CrossSection[] = [];
  let dropped = 0;
  for (const component of components) {
    if (component.area() < areaFloor || !survivesMinWall(ctx, component)) {
      ctx.arena.drop(component);
      dropped += 1;
      continue;
    }
    if (mode === "keep") {
      kept.push(component);
      continue;
    }
    const repaired =
      mode === "widen"
        ? widenThinParts(ctx, component, APPENDAGE_ROUNDS, undefined, keep)
        : stripThinParts(ctx, component);
    // Both passes can leave less than they were given - the strip by design,
    // the widen because its growth is clipped back inside the region it lives
    // in - so what comes out is judged again by the rule that let it in.
    if (repaired === null || !survivesMinWall(ctx, repaired)) {
      if (repaired !== null && repaired !== component) ctx.arena.drop(repaired);
      ctx.arena.drop(component);
      dropped += 1;
      continue;
    }
    if (repaired !== component) ctx.arena.drop(component);
    kept.push(repaired);
  }
  return { kept, dropped };
}

/**
 * Is a full minimum wall wide disc anywhere inside this section?
 *
 * The reference implementation asks GEOS for the maximum inscribed circle;
 * Clipper2 has no such query, so the same question is asked as an erosion:
 * a region survives `offset(-min_wall / 2)` exactly when a disc of `min_wall`
 * fits inside it. The polygonal join makes the erosion very slightly generous,
 * which is the safe direction - it widens a region that was exactly on the
 * limit rather than shipping one that was just under it.
 */
export function survivesMinWall(
  ctx: BakeContext,
  section: CrossSection,
  minWallMm?: number,
): boolean {
  const minWall = minWallMm ?? ctx.thresholdsMm.minWall;
  if (!(minWall > 0)) return true;
  const eroded = offsetSection(ctx.arena, section, -MIN_WALL_KEEP_FACTOR * minWall);
  if (eroded === null) return false;
  ctx.arena.drop(eroded);
  return true;
}

/**
 * Grow a footprint until a full minimum wall fits inside it.
 *
 * 04 stage 1 widens a thin footprint by `(min_wall - w) / 2` with `w` the
 * hydraulic diameter, and for a long strip that diameter is TWICE the true
 * width, so the formula leaves the strip `min_wall - t` wide: under the real
 * minimum. Rather than delete the building - a long narrow block is a real
 * building, and 04's whole point here is to widen, not to discard - the
 * dilation is repeated in tenths of a wall until the probe comes back
 * non-empty (`thicken.widen_to_min_wall`). Null when it never does.
 */
export function widenToMinWall(
  ctx: BakeContext,
  section: CrossSection,
  rounds: number = MIN_WALL_WIDEN_ROUNDS,
): CrossSection | null {
  if (survivesMinWall(ctx, section)) return section;
  const step = ctx.thresholdsMm.minWall * 0.1;
  for (let i = 1; i <= rounds; i += 1) {
    const grown = offsetSection(ctx.arena, section, step * i);
    if (grown === null) continue;
    if (survivesMinWall(ctx, grown)) return grown;
    ctx.arena.drop(grown);
  }
  return null;
}

/**
 * Close, clip, subtract and clean one flat layer.
 *
 * 04 says "buffer-clean the same way" for water and green; the reference closes
 * at `min_wall / 2` rather than 04's `min_gap / 2` because a RECESSED layer
 * prints as its complement, and two ponds less than a wall apart leave a ridge
 * of base metal no nozzle can lay down (`thicken.repair_areas`, DECISIONS [P3]).
 * The same argument covers roads, so the same number is used here.
 */
export function repairFlatLayer(
  ctx: BakeContext,
  contours: readonly Contour[],
  options: {
    clipHalfMm: number;
    subtract?: readonly Blocker[];
    thinMode?: "strip" | "keep";
    closeMm?: number;
  },
): RepairedLayer {
  const { arena, wasm } = ctx;
  const raw = sectionOf(wasm, arena, contours);
  if (raw === null) return { section: null, dropped: 0 };

  const closeMm = options.closeMm ?? ctx.thresholdsMm.minWall / 2;
  let section = closeSection(arena, raw, closeMm);
  if (section !== raw) arena.drop(raw);
  if (section === null) return { section: null, dropped: 0 };

  for (const blocker of options.subtract ?? []) {
    const other = blocker.section;
    if (other === null) continue;
    // Held `LAYER_SEPARATION_MM` apart, the reference implementation's own
    // number and its own reason: two layers that ABUT share a vertical face
    // once they are extruded, and every boolean across a coincident face
    // leaves zero-area slivers. Measured on the Chicago plate, carving the
    // base with abutting cutters left 721 triangles under 1e-9 mm2 (602 of
    // them from the buildings/roads boundary alone); holding the layers apart
    // leaves 33. What the gap costs is a 0.02 mm rind of base between two
    // pockets, which is a colour edge and not a wall wherever the layer beside
    // it reaches the base top (a building fills the space above its rind; a
    // flush park is level with it). See DECISIONS `[V3-P2-E2]`.
    const held = blocker.separate
      ? offsetSection(arena, other, LAYER_SEPARATION_MM)
      : other;
    const cut: CrossSection | null =
      held === null ? section : subtractSection(arena, section, held);
    if (held !== null && held !== other) arena.drop(held);
    if (section !== cut) arena.drop(section);
    section = cut;
    if (section === null) return { section: null, dropped: 0 };
  }

  const clip = cropSection(ctx, options.clipHalfMm);
  const clipped = intersectSection(arena, section, clip);
  arena.drop(clip);
  if (clipped !== section) arena.drop(section);
  if (clipped === null) return { section: null, dropped: 0 };

  const simplified = clipped.simplify(SIMPLIFY_EPS_MM);
  arena.keep(simplified);
  arena.drop(clipped);

  const components = arena.keepAll(simplified.decompose());
  arena.drop(simplified);
  const { kept, dropped } = keepPrintable(ctx, components, options.thinMode ?? "strip");
  const merged = unionSections(wasm, arena, kept);
  for (const component of kept) {
    if (component !== merged) arena.drop(component);
  }
  if (merged === null) return { section: null, dropped };
  const clean = cleanSection(arena, merged);
  if (clean !== merged) arena.drop(merged);
  return { section: clean, dropped };
}

// ---------------------------------------------------------------------------
// Roads and rail: centreline -> ribbon
// ---------------------------------------------------------------------------

/**
 * A polyline buffered to `widthMm`, as contours: one rectangle per segment and
 * one n-gon per interior vertex.
 *
 * Flat caps and round joins, which is what 04 stage 1 (roads 1) asks for. The
 * reference reaches shapely's `buffer(cap_style="flat", join_style="round")`;
 * Clipper2's offset in this binding takes closed paths only, so the ribbon is
 * assembled from primitives and the union happens in the `CrossSection`
 * constructor, which unions everything it is handed in one pass.
 */
export function ribbonContours(
  path: readonly Point[],
  widthMm: number,
  scale: number,
  segments: number = CIRCLE_SEGMENTS,
): Contour[] {
  const half = widthMm / 2;
  if (!(half > 0)) return [];
  const points: Array<[number, number]> = [];
  for (const p of path) {
    const x = p[0] * scale;
    const y = p[1] * scale;
    const last = points[points.length - 1];
    if (last !== undefined && Math.abs(last[0] - x) < 1e-9 && Math.abs(last[1] - y) < 1e-9) {
      continue;
    }
    points.push([x, y]);
  }
  if (points.length < 2) return [];

  const out: Contour[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length = Math.hypot(dx, dy);
    if (length < 1e-12) continue;
    const nx = (dy / length) * half;
    const ny = (-dx / length) * half;
    // Counter-clockwise for a left-hand normal of (nx, ny) built from the
    // right-hand normal, which is what keeps FillRule.Positive happy.
    out.push([
      [x0 - nx, y0 - ny],
      [x1 - nx, y1 - ny],
      [x1 + nx, y1 + ny],
      [x0 + nx, y0 + ny],
    ]);
  }
  for (let i = 1; i + 1 < points.length; i += 1) {
    out.push(circleContour(points[i][0], points[i][1], half, segments));
  }
  for (const contour of out) {
    if (signedArea2(contour) < 0) contour.reverse();
  }
  return out;
}

/** Every road centreline as ribbon contours, at the clamped printed width. */
export function roadContours(
  ctx: BakeContext,
  roads: readonly Road[],
): Contour[] {
  const out: Contour[] = [];
  for (const road of roads) {
    if (road.path.length < 2) continue;
    const groundM = T.road_width_ground_m(road, ctx.params, ctx.thresholdsGroundM);
    out.push(...ribbonContours(road.path, groundM * ctx.scale, ctx.scale));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

interface Footprint {
  section: CrossSection;
  areaMm2: number;
  centroid: [number, number];
  bounds: Bounds2;
  height: HeightSpec;
  sourceId: string;
}

/**
 * 04 stage 1, buildings, steps 1 to 5.
 *
 * Heroes are exempt from step 5 exactly the way 04 already exempts a footprint
 * over 1.5x the block height: a hero's height never enters its block's
 * percentile and it keeps its own solid stacked on that block. It is exempt
 * from nothing else - the dilation, the drop and the crop all apply.
 */
export function repairBuildings(
  ctx: BakeContext,
  heroIds: readonly string[],
): RepairedBuildings {
  const { arena, wasm, params, scale } = ctx;
  const result: RepairedBuildings = {
    solids: [],
    footprint: null,
    dilated: 0,
    merged: 0,
    dropped: 0,
    heightFallbacks: 0,
    heroUnknown: [],
    heroBuried: [],
    heroDropped: [],
  };
  const buildings = ctx.scene.buildings;
  if (buildings.length === 0) return result;

  const known = new Set(buildings.map((b) => String(b.id)));
  result.heroUnknown = heroIds.filter((id) => !known.has(id));
  const heroSet = new Set(heroIds.filter((id) => known.has(id)));
  const heroTrueHeight = T.hero_true_height(params);

  // --- steps 1 to 3, per footprint --------------------------------------
  const footprints: Footprint[] = [];
  for (const building of buildings) {
    if (building.height_source === "default") result.heightFallbacks += 1;
    const contours = contoursFromRings(building.ring, building.holes, scale);
    if (contours.length === 0) continue;
    const [areaM2, , , dilationM] = T.building_footprint_metrics(
      building.ring,
      building.holes,
      ctx.thresholdsGroundM,
    );
    if (T.building_dropped(areaM2, dilationM, ctx.thresholdsGroundM)) {
      result.dropped += 1;
      continue;
    }
    const raw = sectionOf(wasm, arena, contours);
    if (raw === null) {
      result.dropped += 1;
      continue;
    }
    let section = raw;
    if (dilationM > 0) {
      result.dilated += 1;
      const grown = offsetSection(arena, raw, dilationM * scale);
      if (grown === null) {
        arena.drop(raw);
        result.dropped += 1;
        continue;
      }
      section = grown;
      arena.drop(raw);
    }
    // 04's formula said no, the probe says yes: a long strip's hydraulic
    // diameter is twice its width, so a footprint the formula cleared can still
    // be under a full wall everywhere.
    const thick = widenToMinWall(ctx, section);
    if (thick === null) {
      arena.drop(section);
      result.dropped += 1;
      continue;
    }
    if (thick !== section) {
      if (dilationM <= 0) result.dilated += 1;
      arena.drop(section);
      section = thick;
    }
    const id = String(building.id);
    footprints.push({
      section,
      areaMm2: section.area(),
      centroid: contourCentroid(contours[0]),
      bounds: boundsOfContours([contours[0]]),
      height: {
        height_m: building.height_m,
        is_tall: building.is_tall,
        is_hero: heroSet.has(id) && heroTrueHeight,
      },
      sourceId: id,
    });
  }
  if (footprints.length === 0) return result;

  // --- step 4: close the layer so unprintable slivers fuse ---------------
  // The footprint sections stay alive past this point (a stacked tower is
  // extruded from its own footprint, not from the block), so the union is only
  // freed when it is a solid of its own - which it is not when there was
  // exactly one footprint and `unionSections` handed that one straight back.
  const ownFootprint = new Set(footprints.map((f) => f.section));
  const layer = unionSections(
    wasm,
    arena,
    footprints.map((f) => f.section),
  );
  if (layer === null) return result;
  const closed = closeSection(arena, layer, ctx.thresholdsMm.minGap / 2);
  if (closed !== layer && !ownFootprint.has(layer)) arena.drop(layer);
  if (closed === null) return result;
  const clip = cropSection(ctx, ctx.cropHalfMm);
  const cropped = intersectSection(arena, closed, clip);
  arena.drop(clip);
  if (cropped !== closed) arena.drop(closed);
  if (cropped === null) return result;
  const simplified = cropped.simplify(SIMPLIFY_EPS_MM);
  arena.keep(simplified);
  arena.drop(cropped);

  const rawComponents = arena.keepAll(simplified.decompose());
  arena.drop(simplified);
  // The widening pass ADDS material, and a component sitting on the crop edge
  // can have a wing grown straight through it into the 6 mm frame band - 12.7
  // mm3 of buildings inside the frame region before the crop was handed to the
  // pass, which is a partition failure, not a rounding one.
  const cropAgain = cropSection(ctx, ctx.cropHalfMm);
  const { kept: components, dropped } = keepPrintable(
    ctx,
    rawComponents,
    "widen",
    cropAgain,
  );
  arena.drop(cropAgain);
  result.dropped += dropped;
  if (components.length === 0) return result;

  // --- step 5: one block per component, at the weighted percentile -------
  const polygons = components.map((c) => c.toPolygons() as Contour[]);
  const bounds = polygons.map(boundsOfContours);
  const index = new GridIndex(bounds);
  const members: number[][] = components.map(() => []);
  for (let i = 0; i < footprints.length; i += 1) {
    const foot = footprints[i];
    const hit = index.find(foot.centroid[0], foot.centroid[1], polygons, foot.bounds);
    if (hit >= 0) members[hit].push(i);
  }

  const solids: BuildingSolid[] = [];
  for (let c = 0; c < components.length; c += 1) {
    const owned = members[c];
    if (owned.length === 0) {
      // A closing artefact with no contributor. Keeping it at the smallest
      // printable height beats leaving a hole in the middle of a block.
      solids.push({
        section: components[c],
        height: { height_m: 0, is_tall: false, is_hero: false },
        standsOn: null,
        heroId: null,
        members: 0,
      });
      continue;
    }
    if (owned.length > 1) result.merged += owned.length - 1;
    const pool = owned.filter((i) => !heroSet.has(footprints[i].sourceId));
    const contributing = pool.length > 0 ? pool : owned;
    const [blockHeight, winner] = weightedPercentile(
      contributing.map((i) => footprints[i].height.height_m),
      contributing.map((i) => footprints[i].areaMm2),
      BLOCK_HEIGHT_PERCENTILE,
    );
    // When every contributor is the same hero, the block simply IS that hero.
    let blockHero: string | null = null;
    if (pool.length === 0) {
      const owners = new Set(owned.map((i) => footprints[i].sourceId));
      if (owners.size === 1) blockHero = [...owners][0];
    }
    const block: HeightSpec = {
      height_m: blockHeight,
      is_tall: footprints[contributing[winner]].height.is_tall,
      is_hero: blockHero !== null && heroTrueHeight,
    };
    solids.push({
      section: components[c],
      height: block,
      standsOn: null,
      heroId: blockHero,
      members: owned.length,
    });

    const blockTop = T.building_top_mm_for(block, params, scale, block.is_hero);
    // A stacked footprint is clipped to the block it STANDS ON, then widened
    // like any other solid: the intersection can shave a tower down to a
    // sliver, and a sliver 25 mm up in the air is the thinnest wall on the
    // plate.
    //
    // It is clipped to its own block and not to the union of every block: a
    // tower whose footprint spills over the boundary into a shorter neighbour
    // would otherwise be extruded from its own block's roof over ground that
    // ends metres lower, and that overhang comes back as a body floating in mid
    // air (measured: two of them, 85 mm3 and 112 mm3, on the Chicago plate
    // before this changed).
    const stackOn = (section: CrossSection): CrossSection | null => {
      const seated = intersectSection(arena, section, components[c]);
      if (seated === null) return null;
      const widened = widenThinParts(ctx, seated);
      if (widened !== seated) arena.drop(seated);
      // Never wider than the block it stands on: the widening can push a
      // terminal past the roof it is standing on.
      const trimmed = intersectSection(arena, widened, components[c]);
      if (trimmed !== widened) arena.drop(widened);
      if (trimmed === null) return null;
      // And judged by the same rule as every other solid. A tower is clipped
      // twice (to the crop, then to its own block) and either cut can leave a
      // strip too narrow to print: the reference validator found exactly one on
      // this plate, 0.57 mm wide and 9.6 mm long, sitting on the crop edge.
      // What fails here is not dropped from the model - the footprint is still
      // part of the block below - it just stops being a solid of its own.
      if (!survivesMinWall(ctx, trimmed)) {
        arena.drop(trimmed);
        return null;
      }
      return trimmed;
    };
    for (const i of owned) {
      const foot = footprints[i];
      const heroId = heroSet.has(foot.sourceId) ? foot.sourceId : null;
      if (heroId !== null && heroId !== blockHero) {
        // 04's 1.5x rule does not apply to a hero: any hero taller than its
        // block keeps its own solid. One that is not is reported, not faked.
        const top = T.building_top_mm_for(foot.height, params, scale, foot.height.is_hero);
        if (top > blockTop) {
          const seated = stackOn(foot.section);
          if (seated !== null) {
            solids.push({
              section: seated,
              height: foot.height,
              standsOn: block,
              heroId,
              members: 1,
            });
          } else if (!result.heroBuried.includes(heroId)) {
            result.heroBuried.push(heroId);
          }
        } else if (!result.heroBuried.includes(heroId)) {
          result.heroBuried.push(heroId);
        }
        continue;
      }
      if (blockHeight > 0 && foot.height.height_m > STACK_HEIGHT_FACTOR * blockHeight) {
        const seated = stackOn(foot.section);
        if (seated !== null) {
          solids.push({
            section: seated,
            height: foot.height,
            standsOn: block,
            heroId: null,
            members: 1,
          });
        }
      }
    }
  }

  // Vertex-clean every footprint before anything is extruded from it. A
  // near-duplicate vertex on an outline is invisible in 2D and extrudes into a
  // pair of zero-area side triangles; 41 of the Chicago plate's buildings
  // carried one before this pass.
  const finished: BuildingSolid[] = [];
  for (const solid of solids) {
    const clean = cleanSection(arena, solid.section);
    if (clean === solid.section) finished.push(solid);
    else finished.push({ ...solid, section: clean });
  }
  const blockSections = finished.filter((s) => s.standsOn === null).map((s) => s.section);
  const blockUnion = unionSections(wasm, arena, blockSections);

  // Free the footprints that neither became a block nor were stacked.
  const used = new Set(finished.map((s) => s.section));
  for (const foot of footprints) {
    if (!used.has(foot.section)) arena.drop(foot.section);
  }
  for (const component of components) {
    if (!used.has(component)) arena.drop(component);
  }

  const survived = new Set(
    finished.filter((s) => s.heroId !== null).map((s) => String(s.heroId)),
  );
  result.heroDropped = [...heroSet].filter(
    (id) => !survived.has(id) && !result.heroBuried.includes(id),
  );
  result.solids = finished;
  result.footprint = blockUnion;
  return result;
}

/**
 * A uniform grid over component bounding boxes.
 *
 * 994 footprints against ~900 components is a million box tests done naively,
 * which is slow enough to notice in a 15 second budget. The grid turns it into
 * a handful of candidates each.
 */
class GridIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly cell: number;
  private readonly originX: number;
  private readonly originY: number;
  private readonly columns: number;

  constructor(private readonly boxes: readonly Bounds2[]) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const box of boxes) {
      minX = Math.min(minX, box.minX);
      minY = Math.min(minY, box.minY);
      maxX = Math.max(maxX, box.maxX);
      maxY = Math.max(maxY, box.maxY);
    }
    const span = Math.max(maxX - minX, maxY - minY, 1e-6);
    const divisions = Math.max(1, Math.min(128, Math.ceil(Math.sqrt(boxes.length))));
    this.cell = span / divisions;
    this.originX = minX;
    this.originY = minY;
    this.columns = divisions + 2;
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i];
      for (let cy = this.row(box.minY); cy <= this.row(box.maxY); cy += 1) {
        for (let cx = this.column(box.minX); cx <= this.column(box.maxX); cx += 1) {
          const key = cy * this.columns + cx;
          const bucket = this.cells.get(key);
          if (bucket === undefined) this.cells.set(key, [i]);
          else bucket.push(i);
        }
      }
    }
  }

  private column(x: number): number {
    return Math.max(0, Math.min(this.columns - 1, Math.floor((x - this.originX) / this.cell)));
  }

  private row(y: number): number {
    return Math.max(0, Math.floor((y - this.originY) / this.cell));
  }

  /**
   * The component containing `(x, y)`, or the one whose box overlaps `fallback`
   * most when the point missed every one of them (the closing pair can round a
   * corner away from a footprint's own centroid).
   */
  find(
    x: number,
    y: number,
    polygons: readonly Contour[][],
    fallback: Bounds2,
  ): number {
    const bucket = this.cells.get(this.row(y) * this.columns + this.column(x)) ?? [];
    for (const i of bucket) {
      const box = this.boxes[i];
      if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) continue;
      if (pointInContours(x, y, polygons[i])) return i;
    }
    let best = -1;
    let bestArea = 0;
    for (let i = 0; i < this.boxes.length; i += 1) {
      const box = this.boxes[i];
      const w = Math.min(box.maxX, fallback.maxX) - Math.max(box.minX, fallback.minX);
      const h = Math.min(box.maxY, fallback.maxY) - Math.max(box.minY, fallback.minY);
      if (w <= 0 || h <= 0) continue;
      const area = w * h;
      if (area > bestArea) {
        bestArea = area;
        best = i;
      }
    }
    return best;
  }
}

/** Rings of a SceneGraph area feature as contours in print millimetres. */
export function areaContours(
  features: readonly { ring: Point[]; holes: Point[][] }[],
  scale: number,
): Contour[] {
  const out: Contour[] = [];
  for (const feature of features) {
    out.push(...contoursFromRings(feature.ring, feature.holes, scale));
  }
  return out;
}
