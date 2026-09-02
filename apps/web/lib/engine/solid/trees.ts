/**
 * Trees: 04 stage 1's last layer, and the one the v3 engine used to ignore.
 *
 * A tree is a marker, not a model: an eight-sided trunk with an eight-sided
 * cone on top, standing on the local surface, joined to the `parks` region so
 * it prints in the parkland filament and needs no slot of its own.
 *
 * Which trees survive is NOT a rule this file invents. It is
 * `transform.select_tree_indices_for`, the same shared predicate the reference
 * build and the preview already filter on, so a tree the preview draws is a tree
 * the model has. That predicate is 04's 0.5 mm printed-radius floor raised to
 * whatever puts a full minimum wall across the flats of an eight-gon, and it is
 * capped at `TREE_CAP` keeping the largest.
 *
 * What this file adds is the second half of 04's rule, "does not intersect a
 * building or road footprint", which the browser engine can now answer because
 * the footprints exist by the time trees are built. It is answered for the
 * tree's CENTRE rather than for its whole disc ([V3-P3-G6]): the reference asks
 * shapely for a real intersection, Clipper2 has no per-point query and 5 762
 * of them would be 5 762 boolean operations, and the difference is a canopy
 * that overhangs a kerb by a fraction of a millimetre - which prints as a tree
 * beside a road, exactly what it is.
 */

import * as T from "../../transform";
import type { BuildContext } from "./context";
import { PART_OVERLAP_MM, addFinding, finding } from "./context";
import type { Drape } from "./drape";
import { drapeSurfaceMm } from "./drape";
import type { Contour, CrossSection, Manifold } from "./manifold";
import { batchedUnion } from "./manifold";

/** Trunk radius as a fraction of the site radius, before the printable floor. */
export const TRUNK_RADIUS_FRACTION = 0.45;

/** Trunk height as a fraction of the whole tree. The rest is canopy. */
export const TRUNK_HEIGHT_FRACTION = 0.25;

/**
 * Above this fraction of the site radius a trunk is not a trunk.
 *
 * The printable floor (a full minimum wall across the flats of an eight-gon) can
 * push the trunk out to nearly the canopy's own radius at small scales, and a
 * cylinder that wide with a stub of cone on it reads as a bollard. Past this
 * ratio the tree falls back to the plain eight-sided cone `extrude.tree_cone`
 * builds in the reference implementation, which is the shape 04 actually
 * specifies ([V3-P3-G6]).
 */
export const TRUNK_MAX_RATIO = 0.7;

/** How far a tree reaches into the surface it stands on, print mm. */
export const TREE_SKIRT_MM = 0.6;

export interface BuiltTrees {
  /** Every surviving tree as one solid with many bodies, or null. */
  solid: Manifold | null;
  kept: number;
  /** Trees the size floor removed. */
  dropped: number;
  /** Trees removed because they stood on a building, road, rail or water. */
  blocked: number;
}

/**
 * Smallest printable trunk radius, print mm: a full minimum wall across the
 * flats of the eight-gon, the same argument `transform.tree_min_radius_mm`
 * makes for the cone's own base.
 */
export function minTrunkRadiusMm(ctx: BuildContext): number {
  return ctx.thresholdsMm.minWall / (2 * Math.cos(Math.PI / T.TREE_SIDES));
}

/**
 * Build every surviving tree, as one solid.
 *
 * `blockers` are the repaired footprints that already own their ground: the
 * buildings and every surface layer. A tree centred inside one of them is
 * dropped rather than left standing on a roof or in a river.
 */
export function buildTrees(
  ctx: BuildContext,
  blockers: readonly (CrossSection | null)[],
  drape: Drape | null,
): BuiltTrees {
  const empty: BuiltTrees = { solid: null, kept: 0, dropped: 0, blocked: 0 };
  const trees = ctx.scene.trees;
  if (!ctx.params.trees || trees.length === 0) return empty;

  const chosen = T.select_tree_indices_for(trees, ctx.params, ctx.scale);
  const dropped = trees.length - chosen.length;
  if (chosen.length === 0) {
    reportDropped(ctx, dropped, trees.length);
    return { ...empty, dropped };
  }

  const index = new EdgeIndex(blockers);
  const { wasm, arena, scale } = ctx;
  // A deeper skirt than a building's, and for a reason a flat build never sees:
  // a tree is placed rigidly, at the terrain height under its own centre, while
  // the surface it stands on is a warped mesh whose triangles interpolate the
  // same field. The two agree to the chord error of that mesh, so the tree has
  // to reach far enough into it to survive one. It is buried either way, so the
  // extra depth costs nothing.
  const skirt = Math.min(ctx.baseTopMm / 3, Math.max(PART_OVERLAP_MM, TREE_SKIRT_MM));
  const bottom = ctx.baseTopMm - skirt;
  const trunkFloor = minTrunkRadiusMm(ctx);
  const solids: Manifold[] = [];
  let blocked = 0;

  for (const i of chosen) {
    const tree = trees[i];
    const x = tree.x * scale;
    const y = tree.y * scale;
    const radius = T.tree_radius_mm(tree, scale);
    const height = T.tree_height_mm(tree, scale);
    if (!(radius > 0) || !(height > 0)) continue;
    // The WHOLE canopy has to be inside the crop square. Clipping it instead
    // would leave a crescent, and a crescent of a 1 mm cone is not a printable
    // feature; a tree half in the frame band is not one either.
    if (Math.abs(x) + radius > ctx.cropHalfMm || Math.abs(y) + radius > ctx.cropHalfMm) {
      blocked += 1;
      continue;
    }
    if (index.contains(x, y)) {
      blocked += 1;
      continue;
    }
    const lift = drapeSurfaceMm(drape, x, y);
    for (const piece of treePieces(ctx, radius, height, trunkFloor, skirt)) {
      const placed = arena.keep(piece.translate([x, y, bottom + lift]));
      piece.delete();
      solids.push(placed);
    }
  }

  reportDropped(ctx, dropped, trees.length);
  if (blocked > 0) {
    addFinding(
      ctx,
      finding(
        "trees-blocked",
        "info",
        `${blocked} tree(s) stood on something else`,
        "They fell inside a building, road, rail or water footprint, which already owns " +
          "that ground, so they were left out rather than printed on a roof or in a river.",
        "parks",
      ),
    );
  }
  const merged = batchedUnion(wasm, arena, solids);
  return {
    solid: merged,
    kept: chosen.length - blocked,
    dropped,
    blocked,
  };
}

/**
 * The primitives one tree is made of, at the origin, rising from z = 0.
 *
 * Trunk plus canopy when the trunk is genuinely narrower than the canopy; the
 * plain cone of `extrude.tree_cone` when the printable floor has fattened the
 * trunk past {@link TRUNK_MAX_RATIO}. Both reach `height` and both are
 * `TREE_SIDES`-sided, so the shared size predicates keep meaning what they say.
 *
 * **The canopy is TRUNCATED, not pointed** ([V3-P3-G6]). 04 says "an 8-sided
 * cone" and the reference implementation builds one with `radiusHigh = 0`,
 * which comes to a needle: every slice near the tip is narrower than the last,
 * and the Stage 4 minimum-wall gate reads the plate at 0.02 mm and fails it as
 * an error. That is not the gate being fussy, it is the gate being right - the
 * top two layers of a pointed cone at this scale are under one extruded bead
 * and print as a blob or as nothing. Stopping the taper at the same printable
 * floor the cone's own BASE has to clear leaves a flat top exactly one minimum
 * wall across, which is the smallest top face that prints as itself.
 *
 * The caller owns the handles: they are created outside the arena and are
 * either registered by the caller or deleted by it.
 */
function treePieces(
  ctx: BuildContext,
  radius: number,
  height: number,
  trunkFloorMm: number,
  skirtMm: number,
): Manifold[] {
  const { Manifold: M } = ctx.wasm;
  // The buried skirt is extra: `height` is what stands above the surface, which
  // is what `transform.tree_height_mm` promises and what the preview draws.
  const total = height + skirtMm;
  const tip = Math.min(trunkFloorMm, radius);
  const trunkRadius = Math.max(TRUNK_RADIUS_FRACTION * radius, trunkFloorMm);
  if (trunkRadius >= TRUNK_MAX_RATIO * radius) {
    return [M.cylinder(total, radius, tip, T.TREE_SIDES, false)];
  }
  const trunkTop = skirtMm + TRUNK_HEIGHT_FRACTION * height;
  const trunk = M.cylinder(trunkTop, trunkRadius, trunkRadius, T.TREE_SIDES, false);
  const canopy = M.cylinder(total - trunkTop, radius, tip, T.TREE_SIDES, false);
  const raised = canopy.translate([0, 0, trunkTop]);
  canopy.delete();
  return [trunk, raised];
}

/** One info finding for the whole layer, with the count, as the brief asks. */
function reportDropped(ctx: BuildContext, dropped: number, total: number): void {
  if (dropped <= 0) return;
  const floor = T.tree_min_radius_mm(ctx.params);
  addFinding(
    ctx,
    finding(
      "trees-too-small",
      "info",
      `${dropped} of ${total} trees are too small to print`,
      `A tree needs a printed site radius of ${floor.toFixed(2)} mm at this nozzle and ` +
        `these are under it at 1:${Math.round(1000 / ctx.scale)}. Use a bigger plate or a ` +
        "smaller radius to bring them back.",
      "parks",
    ),
  );
}

// ---------------------------------------------------------------------------
// Point-in-layer
// ---------------------------------------------------------------------------

/**
 * Even-odd containment over a whole layer, indexed by horizontal band.
 *
 * The naive test is a ray cast against every edge of every ring, and the road
 * layer alone is tens of thousands of edges wound into a handful of components
 * whose bounding boxes each cover most of the plate, so bounding-box culling
 * does nothing at all here. Bucketing the EDGES by the Y band they span, and
 * casting the ray only against the band the query point is in, turns the same
 * test into a few hundred segment comparisons per tree.
 */
class EdgeIndex {
  private static readonly BANDS = 256;
  private readonly bands: number[][] = [];
  private readonly x0: number[] = [];
  private readonly y0: number[] = [];
  private readonly x1: number[] = [];
  private readonly y1: number[] = [];
  private minY = Infinity;
  private maxY = -Infinity;
  private readonly empty: boolean;

  constructor(sections: readonly (CrossSection | null)[]) {
    const rings: Contour[] = [];
    for (const section of sections) {
      if (section === null || section.isEmpty()) continue;
      for (const ring of section.toPolygons()) rings.push(ring as Contour);
    }
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        this.x0.push(ring[j][0]);
        this.y0.push(ring[j][1]);
        this.x1.push(ring[i][0]);
        this.y1.push(ring[i][1]);
        this.minY = Math.min(this.minY, ring[j][1], ring[i][1]);
        this.maxY = Math.max(this.maxY, ring[j][1], ring[i][1]);
      }
    }
    this.empty = this.x0.length === 0 || !Number.isFinite(this.minY);
    if (this.empty) return;
    for (let b = 0; b < EdgeIndex.BANDS; b += 1) this.bands.push([]);
    for (let e = 0; e < this.x0.length; e += 1) {
      const lo = this.band(Math.min(this.y0[e], this.y1[e]));
      const hi = this.band(Math.max(this.y0[e], this.y1[e]));
      for (let b = lo; b <= hi; b += 1) this.bands[b].push(e);
    }
  }

  private band(y: number): number {
    const span = this.maxY - this.minY;
    if (!(span > 0)) return 0;
    const at = Math.floor(((y - this.minY) / span) * (EdgeIndex.BANDS - 1));
    return Math.max(0, Math.min(EdgeIndex.BANDS - 1, at));
  }

  /** True when `(x, y)` is inside the layer (even-odd, holes flip it). */
  contains(x: number, y: number): boolean {
    if (this.empty || y < this.minY || y > this.maxY) return false;
    let inside = false;
    for (const e of this.bands[this.band(y)]) {
      const yi = this.y1[e];
      const yj = this.y0[e];
      if (yi > y === yj > y) continue;
      const xi = this.x1[e];
      const xj = this.x0[e];
      if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
}
