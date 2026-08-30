/**
 * The four surface regions: water, rail, roads, parks.
 *
 * Each one is a real solid with real thickness, not a texture on the base. It
 * spans `[base_top + proud - depth, base_top + proud]` and the base is carved
 * by the same footprint from the solid's underside up past the base top, so:
 *
 * * nothing is coplanar with the base's own top face unless the user asks for
 *   it with `proud_mm = 0`, so nothing z-fights in the preview;
 * * the region and the base partition the volume exactly, with no overlap for a
 *   slicer to arbitrate;
 * * a negative `proud_mm` leaves a groove of exactly that depth, and a positive
 *   one stands exactly that proud.
 *
 * Precedence where two layers cover the same ground is water, then rail, then
 * roads, then parks, with the buildings above all four (04 stage 1 subtracts
 * the building layer from every surface layer, for the same reason: a road must
 * not tunnel through a building). Each layer is differenced against everything
 * that already claimed the ground, with NO separation between them: these are
 * regions that are supposed to meet, and a gap between two pockets is a rind of
 * base standing between them (DECISIONS `[V3-P2-E2]`).
 */

import type { BakeContext, Placement } from "./context";
import { PART_OVERLAP_MM, POCKET_GROW_MM, placementOf } from "./context";
import { cutterTopMm } from "./base";
import type { Contour, CrossSection, Manifold } from "./manifold";
import { extrudeSection, intersectSection, offsetSection } from "./manifold";
import { areaContours, repairFlatLayer, cropSection, type Blocker } from "./repair";
import { railLayerContours, roadLayerContours } from "./roads";
import type { RegionName } from "../types";

/** One layer after the Stage 1 repair, before anything is extruded. */
export interface RepairedSurface {
  region: SurfaceName;
  /** The repaired footprint: what the pocket and the neighbours are built from. */
  section: CrossSection;
  /** The same, clipped to the plate: what the printed solid is built from. */
  solidSection: CrossSection;
  placement: Placement;
  dropped: number;
}

export interface SurfaceRegion {
  region: RegionName;
  /** The printed solid. */
  solid: Manifold;
  /** The prism that carves the base. */
  cutter: Manifold;
  /** The repaired footprint, kept so later layers can give way to it. */
  section: CrossSection;
  /** The footprint the base was carved with: the section plus its collar. */
  pocket: CrossSection;
  placement: Placement;
  dropped: number;
}

/** 04 stage 1: the four layers in precedence order, highest claim first. */
export const SURFACE_ORDER = ["water", "rail", "roads", "parks"] as const;

export type SurfaceName = (typeof SURFACE_ORDER)[number];

/** The contract's per-region placement, with the v1 defaults as the fallback. */
export function placementFor(ctx: BakeContext, region: SurfaceName): Placement {
  const spec = ctx.params.regions?.[region];
  const fallback: Record<SurfaceName, [number, number]> = {
    water: [1.0, -0.5],
    rail: [0.4, 0.3],
    roads: [0.6, -0.2],
    parks: [0.4, 0.0],
  };
  const [depth, proud] = fallback[region];
  return placementOf(ctx, spec?.depth_mm ?? depth, spec?.proud_mm ?? proud);
}

/** Contours for one layer, print mm. */
function layerContours(ctx: BakeContext, region: SurfaceName): Contour[] {
  switch (region) {
    case "water":
      return ctx.params.water ? areaContours(ctx.scene.water, ctx.scale) : [];
    case "rail":
      return railLayerContours(ctx);
    case "roads":
      return roadLayerContours(ctx);
    case "parks":
      return areaContours(ctx.scene.green, ctx.scale);
  }
}

/**
 * Build one surface region.
 *
 * `blockers` are the footprints that already own their ground. The layer is
 * clipped to the recess square when it is recessed (a groove that stopped
 * 0.05 mm short of the plate edge would leave a rind of base no nozzle can lay
 * down, `thicken.recess_clip_square`) and to the crop square when it stands
 * proud, and the SOLID is additionally clipped to the plate outline so nothing
 * ever reaches past the printed edge.
 */
export function buildSurfaceRegion(
  ctx: BakeContext,
  region: SurfaceName,
  blockers: readonly Blocker[],
): RepairedSurface | null {
  const contours = layerContours(ctx, region);
  if (contours.length === 0) return null;
  const placement = placementFor(ctx, region);
  const recessed = placement.topMm < ctx.baseTopMm;
  const clipHalfMm = recessed ? ctx.recessClipHalfMm : ctx.cropHalfMm;

  const repaired = repairFlatLayer(ctx, contours, {
    clipHalfMm,
    subtract: blockers,
    // A recess prints as its complement, so its own thin limbs are grooves, not
    // walls, and stripping them would erase the very detail being cut
    // (`thicken.repair_roads` makes the same distinction on `road_mode`).
    thinMode: recessed ? "keep" : "strip",
  });
  if (repaired.section === null) return null;

  let solidSection = repaired.section;
  if (clipHalfMm > ctx.plateHalfMm) {
    const plate = cropSection(ctx, ctx.plateHalfMm);
    const clipped = intersectSection(ctx.arena, repaired.section, plate);
    ctx.arena.drop(plate);
    if (clipped === null) return null;
    solidSection = clipped;
  }
  return { region, section: repaired.section, solidSection, placement, dropped: repaired.dropped };
}

/**
 * The footprint the base is CARVED with: the layer, grown by `POCKET_GROW_MM`.
 *
 * The layers tile the plate, so extruding two neighbours as they are gives two
 * coincident vertical faces, and a boolean across a coincident face leaves
 * zero-area triangles - 721 of them in the Chicago base, 602 from the
 * buildings/roads boundary alone. Growing every pocket by twelve micrometres
 * makes neighbouring pockets OVERLAP instead, so every surface the kernel has
 * to intersect is transversal.
 *
 * The cost is a twelve micrometre gap between a region's wall and the base
 * around it: a twentieth of a layer height, under the tolerance of any printer
 * this targets, and filled by the first perimeter the slicer lays. The region
 * still sits on the pocket's FLOOR, which is what welds it to the plate.
 *
 * A collar - growing the pocket only where it meets a neighbour, so the fit is
 * exact everywhere else - was tried and is worse: the collar is a hairline
 * polygon carrying the neighbour's whole boundary, and extruding it took the
 * plate from 0 zero-area faces to 10 467.
 */
export function grownPocket(ctx: BakeContext, section: CrossSection): CrossSection {
  return offsetSection(ctx.arena, section, POCKET_GROW_MM) ?? section;
}

/**
 * The footprint a region SOLID is extruded from: the layer grown by
 * `PART_OVERLAP_MM`, clipped to the plate.
 *
 * A region is a separate body that INTERPENETRATES the ones beside it, not a
 * flush tile (`context.PART_OVERLAP_MM`). Growing the footprint is what makes
 * the seam with the neighbouring region transversal; extruding from
 * `bottom - PART_OVERLAP_MM` is what makes the seam with the base below it
 * transversal. Both extras lie inside material the merged solid already has,
 * so the union of the regions is still exactly that solid.
 */
export function fittedSolid(ctx: BakeContext, section: CrossSection): CrossSection {
  const grown = offsetSection(ctx.arena, section, PART_OVERLAP_MM);
  if (grown === null || grown === section) return section;
  // Never past the printed edge, whatever the crop allowed.
  const plate = cropSection(ctx, ctx.plateHalfMm);
  const clipped = intersectSection(ctx.arena, grown, plate);
  ctx.arena.drop(plate);
  if (clipped !== grown) ctx.arena.drop(grown);
  return clipped ?? section;
}

/** Z a region solid starts at: `PART_OVERLAP_MM` into the base, never below it. */
export function solidBottomMm(ctx: BakeContext, placement: Placement): number {
  return Math.max(ctx.baseTopMm * 0.1, placement.bottomMm - PART_OVERLAP_MM);
}

/** Every surface region, in precedence order, each giving way to the last. */
export function buildSurfaceRegions(
  ctx: BakeContext,
  buildingFootprint: CrossSection | null,
): SurfaceRegion[] {
  // Pass one: the repaired footprints. The layers tile the plate - nothing is
  // held apart - which is what makes the partition exact and leaves no rind of
  // base between two grooves.
  const repaired: RepairedSurface[] = [];
  const blockers: Blocker[] = [{ section: buildingFootprint, separate: false }];
  for (const region of SURFACE_ORDER) {
    const built = buildSurfaceRegion(ctx, region, blockers);
    if (built === null) continue;
    repaired.push(built);
    blockers.push({ section: built.section, separate: false });
  }

  // Pass two: the solids, and the pockets that carve the base for them.
  const out: SurfaceRegion[] = [];
  for (let i = 0; i < repaired.length; i += 1) {
    const layer = repaired[i];
    const pocket = grownPocket(ctx, layer.section);
    const fitted = fittedSolid(ctx, layer.solidSection);
    const solid = extrudeSection(
      ctx.wasm,
      ctx.arena,
      fitted,
      solidBottomMm(ctx, layer.placement),
      layer.placement.topMm,
    );
    const cutter = extrudeSection(
      ctx.wasm,
      ctx.arena,
      pocket,
      layer.placement.bottomMm,
      cutterTopMm(ctx),
    );
    if (solid === null || cutter === null) continue;
    out.push({
      region: layer.region,
      solid,
      cutter,
      section: layer.section,
      pocket,
      placement: layer.placement,
      dropped: layer.dropped,
    });
  }
  return out;
}
