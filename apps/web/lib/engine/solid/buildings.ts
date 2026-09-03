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
import type { BuildingTint, RegionName } from "../types";
import { GRADIENT_MAX_BANDS, bandRegionName } from "../types";
import type { BuildContext } from "./context";
import { addFinding, finding, regionColor } from "./context";
import type { Drape } from "./drape";
import { drapeLiftMm } from "./drape";
import type { BuildingSolid, RepairedBuildings } from "./repair";
import type { Manifold } from "./manifold";
import { batchedUnion, extrudeSection } from "./manifold";
import { buildingTints } from "./tint";

/** One band of the height gradient, or the whole buildings region. */
export interface BuildingBand {
  region: RegionName;
  solid: Manifold;
  /** Printed roof heights this band covers, mm (inclusive of both ends). */
  topRangeMm: [number, number];
  count: number;
}

export interface BuiltBuildings {
  /**
   * Every non-hero building, as one solid with many bodies.
   *
   * With a height gradient on this is BAND 1 and the rest are in {@link bands};
   * with it off it is all of them and `bands` has this one entry. A caller that
   * wants every building solid should read `bands`.
   */
  buildings: Manifold | null;
  /** The buildings region, split by height when `colour.gradient.enabled`. */
  bands: BuildingBand[];
  /** Per-building tints when `colour.tint.enabled`, else an empty list. */
  tints: BuildingTint[];
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
  /**
   * manifold3d original id of every building solid built here (each is its
   * own extrusion, so its own original) to the building it is: the SceneGraph
   * id the user can pick, `block-<n>` for a merged block with no single owner.
   * The finish stages read the ids back off the region's triangle runs
   * (`solid/owners.ts`).
   */
  ownerIds: Record<number, string>;
}

/** How far buildings reach into the base, mm, clamped to something printable. */
export function skirtMm(ctx: BuildContext): number {
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
  ctx: BuildContext,
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
  ctx: BuildContext,
  repaired: RepairedBuildings,
  drape: Drape | null = null,
): BuiltBuildings {
  const { wasm, arena } = ctx;
  const plain: Array<{ solid: Manifold; topMm: number; source: BuildingSolid }> = [];
  const heroes: Manifold[] = [];
  const ownerIds: Record<number, string> = {};
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
    // The kernel's identity for this building: the extrusion's own original
    // id (a translated piece is a product whose one run names it).
    const own = placed.originalID();
    const originals = own >= 0 ? [own] : Array.from(placed.getMesh().runOriginalID);
    for (const originalId of originals) ownerIds[originalId] = solid.heroId ?? solid.id;
    if (solid.heroId !== null) heroes.push(placed);
    else plain.push({ solid: placed, topMm: z1, source: solid });
  }

  const bands = splitIntoBands(ctx, plain);
  const hero = batchedUnion(wasm, arena, heroes);
  return {
    buildings: bands[0]?.solid ?? null,
    bands,
    tints: buildingTints(
      ctx.params,
      regionColor(ctx.params, "buildings"),
      plain.map((item) => ({ id: item.source.id, centroidMm: item.source.centroidMm })),
    ),
    hero,
    socket: [],
    count: plain.length + heroes.length,
    ownerIds,
  };
}

/**
 * The buildings region, split into one band per `colour.gradient.slots` entry.
 *
 * EQUAL COUNT, not equal height: the band boundaries come from the building
 * height DISTRIBUTION, so each band holds the same number of buildings and
 * every band is populated. Equal-height bands on a real city put nine tenths of
 * the plate in the bottom band and one tower in the top one, which is a
 * gradient nobody can see (`[V3-P5-F7]`).
 *
 * Band 1 keeps the region name `buildings`, so a single-band gradient and no
 * gradient at all produce exactly the same regions.
 */
function splitIntoBands(
  ctx: BuildContext,
  plain: ReadonlyArray<{ solid: Manifold; topMm: number }>,
): BuildingBand[] {
  const { wasm, arena, params } = ctx;
  const whole = (): BuildingBand[] => {
    const solid = batchedUnion(wasm, arena, plain.map((item) => item.solid));
    if (solid === null) return [];
    const tops = plain.map((item) => item.topMm);
    return [
      {
        region: "buildings",
        solid,
        topRangeMm: [Math.min(...tops), Math.max(...tops)],
        count: plain.length,
      },
    ];
  };
  if (plain.length === 0) return [];
  const gradient = params.colour?.gradient;
  if (gradient?.enabled !== true) return whole();
  const asked = Math.max(1, (gradient.slots ?? []).length);
  const bands = Math.min(asked, GRADIENT_MAX_BANDS, plain.length);
  if (asked > GRADIENT_MAX_BANDS) {
    addFinding(
      ctx,
      finding(
        "gradient-bands-capped",
        "warning",
        `The height gradient was built with ${GRADIENT_MAX_BANDS} bands, not ${asked}`,
        `A band is a filament slot and a region of its own; ${GRADIENT_MAX_BANDS} is the cap ` +
          "this engine emits. The extra slots were ignored.",
        "buildings",
      ),
    );
  }
  if (bands <= 1) return whole();

  const order = plain
    .map((item, index) => index)
    .sort((a, b) =>
      plain[a].topMm === plain[b].topMm ? a - b : plain[a].topMm - plain[b].topMm,
    );
  const out: BuildingBand[] = [];
  for (let band = 0; band < bands; band += 1) {
    const from = Math.floor((band * order.length) / bands);
    const to = Math.floor(((band + 1) * order.length) / bands);
    const members = order.slice(from, to);
    if (members.length === 0) continue;
    const solid = batchedUnion(
      wasm,
      arena,
      members.map((index) => plain[index].solid),
    );
    if (solid === null) continue;
    const tops = members.map((index) => plain[index].topMm);
    out.push({
      region: bandRegionName(band + 1),
      solid,
      topRangeMm: [Math.min(...tops), Math.max(...tops)],
      count: members.length,
    });
  }
  return out;
}
