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
 * Terrain is a sampler, not a switch. With no sampler the plate is flat and
 * every vertex is where 04 puts it. With one, the top block is refined to a
 * grid and its top surface is displaced through `transform.terrain_z_mm`, the
 * same shared function the preview will read. Draping the buildings, roads and
 * water onto that surface is phase 3's work, so a bake that supplies a sampler
 * gets an explicit finding saying so rather than a quietly wrong model.
 */

import * as T from "../../transform";
import type { BakeContext } from "./context";
import { CUTTER_OVERSHOOT_MM, addFinding, finding } from "./context";
import type { CrossSection, Manifold } from "./manifold";
import {
  batchedUnion,
  extrudeSection,
  rectContour,
  sectionOf,
  unionSections,
  snapZ,
  subtractSolids,
} from "./manifold";

/** Edge length the terrain grid refines the plate top to, print mm. */
export const TERRAIN_CELL_MM = 3.0;

/** The uncarved plate. */
export function buildPlate(ctx: BakeContext): Manifold {
  const { wasm, arena } = ctx;
  const half = ctx.plateHalfMm;
  const thickness = ctx.baseTopMm;
  const chamfer = snapZ(Math.min(T.CHAMFER_MM, thickness / 2, half / 2));

  const upperSection = sectionOf(wasm, arena, [rectContour(-half, -half, half, half)]);
  if (upperSection === null) throw new Error("the plate square is empty");
  let upper = extrudeSection(ctx.wasm, arena, upperSection, chamfer, thickness);
  arena.drop(upperSection);
  if (upper === null) throw new Error("the base plate came back empty");

  if (ctx.terrain !== null) upper = warpToTerrain(ctx, upper, thickness);
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
 * Displace the plate's top surface by the sampled elevation.
 *
 * `refineToLength` puts a vertex grid on every face; only the vertices sitting
 * on the top plane are moved, so the side walls stretch with the surface and
 * the underside stays flat on the bed.
 */
function warpToTerrain(ctx: BakeContext, plate: Manifold, topMm: number): Manifold {
  const sampler = ctx.terrain;
  if (sampler === null) return plate;
  const refined = ctx.arena.keep(plate.refineToLength(TERRAIN_CELL_MM));
  ctx.arena.drop(plate);
  const scale = ctx.scale;
  const params = ctx.params;
  const warped = ctx.arena.keep(
    refined.warp((vertex) => {
      if (vertex[2] < topMm - 1e-6) return;
      const elevation = sampler.sampleM(vertex[0] / scale, vertex[1] / scale);
      vertex[2] += T.terrain_z_mm(elevation, params, scale);
    }),
  );
  ctx.arena.drop(refined);
  addFinding(
    ctx,
    finding(
      "terrain-not-draped",
      "info",
      "Terrain is on the base only",
      "The plate follows the elevation sampler, but buildings, roads and water are " +
        "still placed on the flat base top. Draping those layers arrives with the " +
        "terrain phase.",
      "base",
    ),
  );
  return warped;
}

/**
 * The plate with every region's pocket taken out of it.
 *
 * Each cutter is the SAME prism the region solid was extruded from, reaching
 * `CUTTER_OVERSHOOT_MM` above the base top so it also removes anything raised
 * standing on the same patch. The two therefore partition the volume exactly:
 * no overlap for a slicer to arbitrate, and no gap for a groove to leak
 * through.
 */
export function carveBase(
  ctx: BakeContext,
  plate: Manifold,
  cutters: readonly (Manifold | null)[],
): Manifold {
  return subtractSolids(ctx.wasm, ctx.arena, plate, cutters);
}

/**
 * How far one Z band of a banded cutter reaches into the next, mm.
 *
 * 04's own building/base overlap, for 04's own reason: "a deliberate overlap,
 * so the union is unambiguous".
 */
export const BAND_OVERLAP_MM = T.BUILDING_OVERLAP_MM;

/** One layer's pocket: where it is, and how far down it goes. */
export interface Pocket {
  section: CrossSection | null;
  /** Z of the pocket's floor, mm. */
  bottomMm: number;
}

/**
 * Turn a set of ABUTTING pockets into cutters that share no vertical face.
 *
 * This is the whole answer to the sliver problem, and it is worth stating
 * plainly. The surface layers tile the plate: roads stop exactly where a
 * building starts, parks stop exactly where a road starts. Extrude each one on
 * its own and every one of those shared boundaries becomes two coincident
 * vertical faces, and every boolean across a coincident face leaves zero-area
 * triangles behind - 721 of them in the Chicago base, 602 from the
 * buildings/roads boundary alone.
 *
 * Holding the layers apart instead (the reference implementation's
 * `LAYER_SEPARATION_MM`) trades those slivers for a 0.02 mm rind of base
 * between the two pockets, which is fine next to a building (the wall fills the
 * space above it) and is a free-standing 0.02 mm wall between two grooves.
 * Neither is acceptable.
 *
 * So the boundary is removed in 2D instead, where it costs nothing: the
 * cutters are cut into Z BANDS, and each band's footprint is the UNION of
 * every layer that reaches that deep. Clipper2 merges two abutting polygons
 * into one with no internal edge, so the boundary between them simply does not
 * exist by the time anything is extruded. Bands meet each other on horizontal
 * planes, which a boolean handles cleanly (it is the same contact a tower makes
 * with the block it stands on). The carve is identical - a point is cut from
 * the floor of whichever layer covers it - because the layers are disjoint.
 */
export function bandedCutters(
  ctx: BakeContext,
  pockets: readonly Pocket[],
  topMm: number = cutterTopMm(ctx),
): Manifold[] {
  const live = pockets.filter(
    (p): p is { section: CrossSection; bottomMm: number } => p.section !== null,
  );
  if (live.length === 0) return [];
  const levels = [...new Set(live.map((p) => p.bottomMm))].sort((a, b) => a - b);
  const out: Manifold[] = [];
  for (let i = 0; i < levels.length; i += 1) {
    const z0 = levels[i];
    // Each band reaches PAST the next one's floor so the two interpenetrate
    // instead of meeting on a coincident horizontal face. It removes nothing
    // extra: the band above covers a superset of this footprint over exactly
    // that stretch, so the union of the cutters is unchanged (measured: the
    // same base volume to the last decimal, and 4 972 zero-area faces became
    // none).
    const z1 = i + 1 < levels.length ? Math.min(topMm, levels[i + 1] + BAND_OVERLAP_MM) : topMm;
    if (!(z1 > z0)) continue;
    const covering = live.filter((p) => p.bottomMm <= z0).map((p) => p.section);
    const merged = unionSections(ctx.wasm, ctx.arena, covering);
    if (merged === null) continue;
    const solid = extrudeSection(ctx.wasm, ctx.arena, merged, z0, z1);
    if (merged !== covering[0]) ctx.arena.drop(merged);
    if (solid !== null) out.push(solid);
  }
  return out;
}

/** Z a cutter reaches up to, mm. */
export function cutterTopMm(ctx: BakeContext): number {
  return ctx.baseTopMm + CUTTER_OVERSHOOT_MM;
}
