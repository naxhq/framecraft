/**
 * The drape: how a flat model becomes a model on a hillside.
 *
 * ONE displacement field does the whole job, and that is the entire design.
 * Every solid the engine builds is warped by the same map
 *
 *     (x, y, z) -> (x, y, z + weight(z) * displacement(x, y))
 *
 * which is a vertical shear. Three properties follow, and all three are load
 * bearing:
 *
 * 1. **It cannot self-intersect.** Its Jacobian is unit-determinant and its
 *    z-derivative is `1 + weight'(z) * displacement`, and the grid is
 *    normalised to metres ABOVE its minimum so `displacement >= 0` always.
 *    Every solid that went in watertight comes out watertight.
 * 2. **It commutes with the booleans.** A bijection of space maps a union to a
 *    union and a difference to a difference, so a region and the pocket it sits
 *    in stay exactly as they were: the 0.2 mm interpenetration at every seam,
 *    the partition, the weld, all survive draping without being re-derived.
 * 3. **It preserves heights.** `weight(z)` is 1 above the ramp, which ends
 *    inside the base slab, so everything a user can see - a building's storey
 *    count, a road's 0.6 mm groove, the frame lip's 2 mm rise - is translated,
 *    not stretched. Only the base slab's own interior is sheared, and its
 *    underside (weight 0) stays dead flat on the bed.
 *
 * Two things are deliberately NOT warped:
 *
 * * **Buildings and trees** are rigidly TRANSLATED, by the LOWEST displacement
 *   under their own footprint, so a tower on a slope keeps a flat roof and a
 *   plumb wall and is buried in the hill rather than floating over it. That is
 *   the brief's rule and it is also the printable one: a sheared tower is an
 *   overhang. See {@link drapeLiftMm}.
 * * **The frame** never moves, because the displacement is tapered to zero in
 *   plan before it reaches the crop edge ({@link DRAPE_EDGE_MM}). A picture
 *   frame with a wavy top edge is not a picture frame, and the taper also keeps
 *   the plate rim, the 45 degree chamfer and the X/Y bounding box exactly where
 *   they were with no terrain at all.
 */

import * as T from "../../transform";
import type { BuildContext } from "./context";
import type { Contour, CrossSection, Manifold } from "./manifold";
import { snapZ } from "./manifold";

/**
 * Edge length the drape refines a solid to before warping it, print mm.
 *
 * The displacement is evaluated per VERTEX and interpolated linearly across
 * each triangle, so this is the resolution of the printed hillside. 3 mm on a
 * 180 mm plate is sixty facets across, under half a millimetre of chord error
 * for any relief the 60 mm height ceiling allows, and it is the number
 * `base.ts` already refined the plate top to before the layers were draped.
 */
export const TERRAIN_CELL_MM = 3.0;

/**
 * Narrowest plan taper at the crop edge, print mm.
 *
 * The terrain rises out of a flat rim rather than off a cliff, because the
 * frame is not draped: a picture frame with a wavy top edge is not a picture
 * frame, and the taper is also what keeps the plate rim and the 45 degree
 * chamfer exactly where a flat build puts them.
 *
 * The taper is the STEEPEST thing on the plate, and steepness is what a
 * per-vertex warp cannot represent: the chord error of a smoothstep of
 * amplitude `A` over a width `L`, sampled every `h`, is about
 * `0.75 * A * h^2 / L^2`. At `L = h` that error is most of `A`, which on the
 * Chicago plate meant the drape of a groove and the drape of the plate under it
 * disagreed by millimetres and left fragments of hillside floating in the air.
 * {@link taperWidthMm} therefore scales `L` with the relief; this is only its
 * floor, two frame widths, for a plate whose relief is small enough not to need
 * more.
 */
export const DRAPE_EDGE_MM = 12.0;

/**
 * Taper width for a given relief, print mm.
 *
 * `4 * relief` bounds the taper's slope at 0.375 and its chord error at
 * `0.42 / relief` mm, which is under a tenth of a millimetre for every relief
 * over 4 mm and is bounded by the {@link DRAPE_EDGE_MM} floor below that. It is
 * capped at 60 % of the crop half-width so a mountain never turns the whole
 * plate into a dome; past that cap the error grows again, and the model is a
 * hillside so steep that the height ceiling is the binding constraint anyway.
 */
export function taperWidthMm(reliefMm: number, cropHalfMm: number): number {
  const wanted = Math.max(DRAPE_EDGE_MM, 4 * reliefMm);
  return Math.min(wanted, Math.max(1, 0.6 * cropHalfMm));
}

/**
 * Scaled relief below which terrain is not worth printing, mm.
 *
 * Two layers at the coarsest common layer height. Under this the hillside is
 * inside the tolerance of the printer and the model looks flat however good
 * the DEM was, so the engine says so rather than letting the user wonder why
 * the switch did nothing.
 */
export const LOW_RELIEF_MM = 0.8;

/**
 * Tolerance the drape simplifies a warped solid to, print mm.
 *
 * A nanometre: a thousandth of the smallest deliberate feature in the engine
 * (`context.POCKET_GROW_MM`, two micrometres) and four orders of magnitude
 * below the print grid, so nothing a printer or a validator can measure moves.
 * See {@link drapeSolid} for what it is removing and why the refinement creates
 * it in the first place.
 */
export const DRAPE_SIMPLIFY_MM = 1e-6;

/** The displacement field, resolved once per build. */
export interface Drape {
  /** Vertical displacement of the terrain surface at a plan point, print mm. */
  atMm(xMm: number, yMm: number): number;
  /** How much of it applies at height `z`: 0 under the chamfer, 1 above the ramp. */
  weightAt(zMm: number): number;
  /** The largest displacement anywhere on the plate, print mm. */
  reliefMm: number;
  /** Z above which the displacement is applied in full, mm. */
  rampTopMm: number;
  /** Z below which none of it is applied, mm. */
  rampBottomMm: number;
}

/**
 * Resolve the displacement field, or `null` when this build is flat.
 *
 * `reliefMm` is the sampler's own range put through
 * `transform.terrain_z_mm`, which is where - and the only place where -
 * `terrain_exaggeration` is applied (`[V3-P3-G1]`).
 */
export function makeDrape(ctx: BuildContext): Drape | null {
  const sampler = ctx.terrain;
  if (sampler === null) return null;
  const { params, scale } = ctx;
  const relief = T.terrain_z_mm(sampler.rangeM, params, scale);
  if (!Number.isFinite(relief) || relief <= 0) return null;

  // The plan taper: full displacement inside the crop square less the margin,
  // nothing at the crop edge, smoothstep between (C1 continuous, so the
  // hillside meets the rim without a crease a slicer would print as a ridge).
  const outer = ctx.cropHalfMm;
  const inner = Math.max(0, outer - taperWidthMm(relief, outer));

  // The vertical ramp. It starts above the chamfer so the 45 degree edge that
  // kills elephant foot keeps its angle, and it ends below everything a user
  // can see, so nothing above the base slab is ever stretched.
  const chamfer = snapZ(
    Math.min(T.CHAMFER_MM, ctx.baseTopMm / 2, ctx.plateHalfMm / 2),
  );
  const rampBottom = chamfer;
  const rampTop = Math.max(chamfer + 0.2, ctx.baseTopMm * 0.35);
  const rampSpan = rampTop - rampBottom;

  return {
    reliefMm: relief,
    rampBottomMm: rampBottom,
    rampTopMm: rampTop,
    atMm(x: number, y: number): number {
      const reach = Math.max(Math.abs(x), Math.abs(y));
      if (reach >= outer) return 0;
      const raw = T.terrain_z_mm(sampler.sampleM(x / scale, y / scale), params, scale);
      if (reach <= inner || outer <= inner) return raw;
      const t = (outer - reach) / (outer - inner);
      return raw * t * t * (3 - 2 * t);
    },
    weightAt(z: number): number {
      if (z <= rampBottom) return 0;
      if (z >= rampTop || rampSpan <= 0) return 1;
      return (z - rampBottom) / rampSpan;
    },
  };
}

/**
 * Refine a solid to {@link TERRAIN_CELL_MM} and warp it onto the surface.
 *
 * `warpBatch` hands the whole double-precision vertex array to one callback,
 * which is the difference between one crossing into WASM and one per vertex on
 * a solid that may carry a hundred thousand of them.
 *
 * The refinement comes first and is not optional: warping the 12 triangles of
 * an un-refined slab would move its four top corners and leave the surface
 * between them a plane.
 */
export function drapeSolid(
  ctx: BuildContext,
  drape: Drape | null,
  solid: Manifold | null,
  cellMm: number = TERRAIN_CELL_MM,
): Manifold | null {
  if (drape === null || solid === null || solid.isEmpty()) return solid;
  const { arena } = ctx;
  const refined = arena.keep(solid.refineToLength(cellMm));
  arena.drop(solid);
  const warped = arena.keep(
    refined.warpBatch((verts: Float64Array, count: number) => {
      for (let i = 0; i < count; i += 1) {
        const at = i * 3;
        const z = verts[at + 2];
        const weight = drape.weightAt(z);
        if (weight === 0) continue;
        verts[at + 2] = z + weight * drape.atMm(verts[at], verts[at + 1]);
      }
    }),
  );
  arena.drop(refined);

  // `refineToLength` splits every edge of an already-intricate mesh, and where
  // an existing edge was already shorter than the print grid the split leaves a
  // sliver the warp then flattens further: five faces under 1e-9 mm2 in the
  // welded Chicago assembly, which is a Stage 4 failure even though every
  // REGION came out clean. `simplify` removes exactly those - it keeps a subset
  // of the existing vertices and moves no surface by more than its tolerance -
  // at a nanometre, which is a thousandth of the smallest deliberate feature in
  // the engine (`POCKET_GROW_MM`, two micrometres) and four orders below the
  // print grid (`[V3-P3-G15]`).
  const clean = arena.keep(warped.simplify(DRAPE_SIMPLIFY_MM));
  if (clean.isEmpty() || clean.status() !== "NoError") {
    arena.drop(clean);
    return warped;
  }
  arena.drop(warped);
  return clean;
}

/**
 * The lift a rigid solid gets: the LOWEST displacement under its footprint.
 *
 * "Lowest so nothing floats" is not a preference, it is the weld: a building
 * placed at the mean of the ground under it hangs in the air over the low
 * corner of its own plot, and a hanging body is a `floating-island` error. At
 * the lowest point the building is buried up to `dz_max - dz_min` into the
 * hillside on its high side and still reaches `building_skirt_mm` into the base
 * everywhere, so the union is unambiguous at every point of the footprint.
 *
 * The minimum is taken over the outline's own vertices AND over a lattice at
 * the drape resolution across its interior, because a footprint bigger than one
 * terrain cell can dip in the middle - a courtyard block around a hollow is the
 * ordinary case, not a contrived one. Points outside the outline are rejected,
 * so a C-shaped footprint never inherits the valley it wraps around.
 */
export function drapeLiftMm(
  drape: Drape | null,
  section: CrossSection,
  cellMm: number = TERRAIN_CELL_MM,
): number {
  if (drape === null) return 0;
  const polygons = section.toPolygons() as Contour[];
  if (polygons.length === 0) return 0;
  let lowest = Infinity;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of polygons) {
    for (const [x, y] of ring) {
      lowest = Math.min(lowest, drape.atMm(x, y));
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(lowest)) return 0;
  const step = Math.max(cellMm, 1e-3);
  for (let y = minY + step; y < maxY; y += step) {
    for (let x = minX + step; x < maxX; x += step) {
      if (!pointInPolygons(x, y, polygons)) continue;
      lowest = Math.min(lowest, drape.atMm(x, y));
    }
  }
  return lowest;
}

/** Even-odd containment over every ring of a section. Holes flip it, as they should. */
function pointInPolygons(x: number, y: number, polygons: readonly Contour[]): boolean {
  let inside = false;
  for (const ring of polygons) {
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

/** Displacement at one plan point with the full weight, print mm. Trees and probes. */
export function drapeSurfaceMm(drape: Drape | null, xMm: number, yMm: number): number {
  return drape === null ? 0 : drape.atMm(xMm, yMm);
}
