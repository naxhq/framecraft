/**
 * The base plate: 04 stage 2.1, plus the hook terrain will hang from.
 *
 * The plate is the crop square extruded from z = 0 to `base_thickness_mm` with
 * the bottom outer edge chamfered 0.6 mm at 45 degrees, which is what kills
 * elephant foot. The chamfer is a tapered extrusion of the inset square
 * (`scaleTop` grows it back to full size over exactly the distance it rises,
 * which is what makes the angle 45 degrees); the plate is centred on the
 * origin, so the uniform scale about the origin is exact.
 *
 * The plate is built FLAT whether or not this build has terrain. Draping is a
 * vertical shear applied to the finished solids (`solid/drape.ts`), and a shear
 * is a bijection of space, so `warp(plate - cutters) == warp(plate) -
 * warp(cutters)`: carving flat and draping afterwards gives exactly the model
 * that carving a draped plate with draped cutters would, for a fraction of the
 * work and with the seam geometry provably untouched. Nothing in this file
 * needs to know whether the build is hilly.
 */

import * as T from "../../transform";
import type { BuildContext } from "./context";
import { CUTTER_OVERSHOOT_MM } from "./context";
import type { Manifold } from "./manifold";
import {
  batchedUnion,
  extrudeSection,
  rectContour,
  sectionOf,
  snapZ,
  subtractSolids,
} from "./manifold";

/** The uncarved plate. */
export function buildPlate(ctx: BuildContext): Manifold {
  const { wasm, arena } = ctx;
  const half = ctx.plateHalfMm;
  const thickness = ctx.baseTopMm;
  const chamfer = snapZ(Math.min(T.CHAMFER_MM, thickness / 2, half / 2));

  const upperSection = sectionOf(wasm, arena, [rectContour(-half, -half, half, half)]);
  if (upperSection === null) throw new Error("the plate square is empty");
  const upper = extrudeSection(ctx.wasm, arena, upperSection, chamfer, thickness);
  arena.drop(upperSection);
  if (upper === null) throw new Error("the base plate came back empty");

  if (chamfer <= 0) return upper;

  const grow = half / (half - chamfer);
  const lowerSection = sectionOf(wasm, arena, [
    rectContour(-(half - chamfer), -(half - chamfer), half - chamfer, half - chamfer),
  ]);
  if (lowerSection === null) return upper;
  const lower = arena.keep(
    wasm.Manifold.extrude(lowerSection, chamfer, 0, 0, [grow, grow]),
  );
  arena.drop(lowerSection);
  const plate = batchedUnion(wasm, arena, [lower, upper]);
  if (plate === null) throw new Error("the base plate came back empty");
  arena.drop(lower);
  arena.drop(upper);
  return plate;
}

/**
 * The plate with every region's pocket taken out of it.
 *
 * Each cutter is the region's own pocket - its repaired footprint grown by
 * `POCKET_GROW_MM` - reaching `CUTTER_OVERSHOOT_MM` above the base top so it
 * also removes anything raised standing on the same patch, and reaching down to
 * the region's placement floor.
 *
 * The pockets tile the plate exactly: what INTERPENETRATES is the region SOLID,
 * which is grown past its own pocket by `PART_OVERLAP_MM` (a hundred times as
 * much) and extruded from below the pocket floor, so it is seated in material
 * the base still has (`context.PART_OVERLAP_MM`, DECISIONS `[V3-P2-E2]`).
 */
export function carveBase(
  ctx: BuildContext,
  plate: Manifold,
  cutters: readonly (Manifold | null)[],
): Manifold {
  return subtractSolids(ctx.wasm, ctx.arena, plate, cutters);
}

/** Z a cutter reaches up to, mm. */
export function cutterTopMm(ctx: BuildContext): number {
  return ctx.baseTopMm + CUTTER_OVERSHOOT_MM;
}
