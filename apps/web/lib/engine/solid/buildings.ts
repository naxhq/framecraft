/**
 * Buildings: 04 stage 2.3, split into the `buildings` and `hero_building`
 * regions.
 *
 * Two things differ from the reference implementation, both forced by regions
 * being separate solids rather than one welded union:
 *
 * * **The skirt replaces the overlap.** 04 extrudes a footprint from
 *   `base_top - 0.2` so the union with the plate is unambiguous. Here the
 *   buildings are their own solid, so instead of interpenetrating the plate
 *   they sit in a socket cut into it: the buildings reach
 *   `params.regions.building_skirt_mm` below the base top and the base is
 *   carved by the SAME prism. The two touch over the socket's floor and walls
 *   and share no volume, which is what a multi-material slicer needs, and the
 *   printed object is identical to the welded one.
 * * **A stack starts exactly on its block.** 04 starts a preserved tower
 *   0.2 mm inside the block below it; two regions may not overlap, so a hero
 *   tower starts on its block's roof plane instead.
 *
 * On a hillside a building is TRANSLATED, not draped: it keeps a flat roof and
 * plumb walls and is lifted by the LOWEST terrain under its own footprint, so
 * it is buried in the slope on its high side rather than floating over the low
 * one (`solid/drape.ts`, `[V3-P3-G3]`).
 */

import * as T from "../../transform";
import type { BakeContext } from "./context";
import type { Drape } from "./drape";
import { drapeLiftMm } from "./drape";
import type { BuildingSolid, RepairedBuildings } from "./repair";
import type { Manifold } from "./manifold";
import { batchedUnion, extrudeSection } from "./manifold";

export interface BuiltBuildings {
  /** Every non-hero building, as one solid with many bodies. */
  buildings: Manifold | null;
  /** Every hero the user picked that produced a solid of its own. */
  hero: Manifold | null;
  /**
   * Cutters the base needs on the buildings' account: none.
   *
   * A building is not seated in a socket, it INTERPENETRATES the plate: it
   * rises from `base_top - regions.building_skirt_mm` and the base keeps its
   * full thickness underneath (`context.PART_OVERLAP_MM`, and 04 stage 2.3's
   * own overlap before that). Kept as an empty list rather than removed so the
   * carve site reads the same whatever a future region needs.
   */
  socket: Manifold[];
  /** Solids emitted (blocks plus preserved towers). */
  count: number;
}

/** How far buildings reach into the base, mm, clamped to something printable. */
export function skirtMm(ctx: BakeContext): number {
  const asked = ctx.params.regions?.building_skirt_mm ?? T.BUILDING_OVERLAP_MM;
  return Math.max(0, Math.min(asked, ctx.baseTopMm / 2));
}

/**
 * Z one repaired footprint is extruded between, mm.
 *
 * Through `building_top_mm_exaggerated`, so `height_exaggeration` reaches the
 * printed roof and nothing else: it is applied to the GROUND height, before the
 * print scale and before the 0.6 mm clamp, and at the defaults that function IS
 * `building_top_mm_for` (`[V3-P3-G5]`). A stacked tower reads its block's top
 * through the same function, so the two still meet exactly.
 */
export function buildingSpanMm(
  ctx: BakeContext,
  solid: BuildingSolid,
): [number, number] {
  const { params, scale } = ctx;
  const top = T.building_top_mm_exaggerated(
    solid.height,
    params,
    scale,
    solid.height.is_hero,
  );
  if (solid.standsOn === null) {
    return [ctx.baseTopMm - skirtMm(ctx), top];
  }
  const blockTop = T.building_top_mm_exaggerated(
    solid.standsOn,
    params,
    scale,
    solid.standsOn.is_hero,
  );
  return [blockTop, top];
}

/**
 * Extrude every repaired footprint and sort it into its region.
 *
 * A picked hero always lands in `hero_building`, whatever `hero_mode` says: the
 * regions ARE the colour partition, so a hero left inside `buildings` could
 * never be given a filament of its own. What `hero_mode` decides is the height
 * (`true_height` / `both` raise it) and the colour (`own_color` / `both` give
 * the region its own slot); with the mode set to plain `true_height` the hero
 * region is emitted with the buildings region's slot and colour, so it prints
 * in the same filament it would have if it had never been split out. See
 * DECISIONS `[V3-P2-E2]`.
 */
export function buildBuildings(
  ctx: BakeContext,
  repaired: RepairedBuildings,
  drape: Drape | null = null,
): BuiltBuildings {
  const { wasm, arena } = ctx;
  const plain: Manifold[] = [];
  const heroes: Manifold[] = [];
  // A stacked tower has to rise from the roof of the block it stands on, and
  // that block was lifted by ITS OWN lowest ground, which is at or below the
  // tower's. Looking the lift up by the block rather than re-measuring it under
  // the tower is what keeps the two touching on a slope.
  const liftByBlock = new Map<BuildingSolid["height"], number>();
  for (const solid of repaired.solids) {
    const [z0, z1] = buildingSpanMm(ctx, solid);
    // The exact repaired footprint: a building's interpenetration with the
    // plate is vertical (the skirt), so it needs no lateral growth, and
    // growing it would print every block wider than the repair drew it.
    const piece = extrudeSection(wasm, arena, solid.section, z0, z1);
    if (piece === null) continue;
    let placed = piece;
    if (drape !== null) {
      const lift =
        solid.standsOn === null
          ? drapeLiftMm(drape, solid.section)
          : (liftByBlock.get(solid.standsOn) ?? drapeLiftMm(drape, solid.section));
      if (solid.standsOn === null) liftByBlock.set(solid.height, lift);
      if (lift !== 0) {
        placed = arena.keep(piece.translate([0, 0, lift]));
        arena.drop(piece);
      }
    }
    if (solid.heroId !== null) heroes.push(placed);
    else plain.push(placed);
  }

  const buildings = batchedUnion(wasm, arena, plain);
  const hero = batchedUnion(wasm, arena, heroes);
  return { buildings, hero, socket: [], count: plain.length + heroes.length };
}
