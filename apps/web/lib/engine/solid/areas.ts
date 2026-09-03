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

import { perfSpan } from "../../perf";
import type { BuildContext, Placement } from "./context";
import {
  PART_OVERLAP_MM,
  POCKET_GROW_MM,
  SIMPLIFY_EPS_MM,
  addFinding,
  placementOf,
} from "./context";
import { cutterTopMm } from "./base";
import type { Contour, CrossSection, Manifold } from "./manifold";
import {
  extrudeSection,
  intersectSection,
  offsetSection,
  subtractSection,
  unionSections,
} from "./manifold";
import {
  areaContours,
  repairFlatLayer,
  cropSection,
  survivesMinWall,
  thinParts,
  type Blocker,
} from "./repair";
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
export function placementFor(ctx: BuildContext, region: SurfaceName): Placement {
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
function layerContours(ctx: BuildContext, region: SurfaceName): Contour[] {
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
 * Say so when the plate could not hold the placement the parameters asked for.
 *
 * The schema allows `proud_mm` down to -2.0, and on the contract's own minimum
 * 3 mm base that is deeper than a pocket may legally go: before this the
 * extrusion came back empty, the region was dropped with a bare `continue`, and
 * a user who asked for deep water got a model with no water in it and nothing
 * anywhere saying why (v3-02 audit, MAJOR 3). The region is now built as deep
 * as the plate allows and the difference is reported with both numbers and a
 * safe one-click fix back to a depth this base can hold.
 */
function reportClampedPlacement(
  ctx: BuildContext,
  region: SurfaceName,
  placement: Placement,
): void {
  if (!placement.clamped) return;
  addFinding(ctx, {
    id: "region-placement-clamped",
    severity: "warning",
    title: `The ${region} region does not fit this base`,
    detail:
      `It was asked for ${placement.depthMm.toFixed(2)} mm of depth at ` +
      `${placement.proudMm.toFixed(2)} mm from the surface, which reaches past the ` +
      `deepest pocket a ${ctx.baseTopMm.toFixed(1)} mm base can carry. It was built ` +
      `${placement.builtDepthMm.toFixed(2)} mm thick at ` +
      `${placement.builtProudMm.toFixed(2)} mm instead. Use a thicker base, or a ` +
      "shallower offset.",
    region,
    fix: {
      label: `Raise ${region} to a depth this base can hold`,
      safe: true,
      patch: {
        regions: {
          [region]: {
            proud_mm: Number((placement.builtProudMm).toFixed(3)),
            depth_mm: Number(placement.builtDepthMm.toFixed(3)),
          },
        },
      },
    },
  });
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
  ctx: BuildContext,
  region: SurfaceName,
  blockers: readonly Blocker[],
): RepairedSurface | null {
  const contours = layerContours(ctx, region);
  if (contours.length === 0) return null;
  const placement = placementFor(ctx, region);
  reportClampedPlacement(ctx, region, placement);
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
export function grownPocket(ctx: BuildContext, section: CrossSection): CrossSection {
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
export function fittedSolid(ctx: BuildContext, section: CrossSection): CrossSection {
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
export function solidBottomMm(ctx: BuildContext, placement: Placement): number {
  return Math.max(ctx.baseTopMm * 0.1, placement.bottomMm - PART_OVERLAP_MM);
}

/**
 * How far a bridged ridge is grown before it is handed to a recess, in units of
 * `SIMPLIFY_EPS_MM` (`thicken.RIDGE_BRIDGE_CELLS`, whose grid cell this is the
 * engine's analogue of - `context.recessClipHalfMm` already mirrors the same
 * four cells on the other side of the same rule).
 */
export const RIDGE_BRIDGE_CELLS = 4;

/** Rounds of {@link mergeRecessRidges} (`thicken.merge_recess_ridges` passes). */
export const RIDGE_MERGE_PASSES = 4;

/**
 * Swallow the unprintable ridges left BETWEEN the recessed layers
 * (`thicken.merge_recess_ridges`, which this engine had never ported).
 *
 * Each recessed layer is closed against itself, but what prints on the base top
 * is the layers' COMPLEMENT, and two grooves - or a groove and the plate's own
 * side wall - can leave an island or a wedge of base metal no nozzle can lay
 * down. Every island is judged by the erosion probe the Stage 4 gate uses and
 * every island that survives is judged again per appendage, because a city
 * block is fat in the middle and can still taper to a 0.2 mm wedge where two
 * grooves converge. What fails is grown by {@link RIDGE_BRIDGE_CELLS} cells and
 * unioned into `sink`, which BRIDGES the two recesses across it rather than
 * merely absorbing it: an island between two cutters can be a hairline of
 * literally zero area, and unioning that changes nothing.
 *
 * The bridge is NEVER put back through the layer's own minimum-feature drops.
 * They would discard it for being small - which is exactly what leaves the
 * ridge standing. What a sub-minimum cutter polygon prints as is a dimple no
 * nozzle reaches, i.e. solid base; what dropping it prints as is a fin.
 *
 * **Frame-off only, and that is a scoping decision rather than a geometric one**
 * (`[V3-P7-fix]`). The reference runs this unconditionally. The frame-ON Chicago
 * plate carries the same ridges - 38 islands that hold no full wall and 13 thin
 * wedges at plate 180 - and merging them moves the committed default golden,
 * which the brief for this fix rules out. With the frame off there is nothing to
 * hide them: the crop edge IS the outer wall, and the reference validator fails
 * the plate over them. The frame-on case is written up for the team lead.
 */
export function mergeRecessRidges(
  ctx: BuildContext,
  layers: readonly RepairedSurface[],
  buildingFootprint: CrossSection | null,
): void {
  if (ctx.params.frame) return;
  const recessed = layers.filter((l) => l.placement.topMm < ctx.baseTopMm);
  if (recessed.length === 0) return;
  // The sink is the last recessed layer in precedence order - roads at the
  // contract defaults, which is the reference's own choice: the road network is
  // what every base island is bounded by, so a bridge lands in the layer that
  // already touches both sides of it.
  const sink = recessed[recessed.length - 1];
  mergeInto(ctx, sink, recessed, buildingFootprint);
  for (const layer of recessed) {
    if (layer !== sink) mergeInto(ctx, layer, [layer], buildingFootprint);
  }
}

/** One `merge_recess_ridges` call: bridge `recesses`' bad complement into `sink`. */
function mergeInto(
  ctx: BuildContext,
  sink: RepairedSurface,
  recesses: readonly RepairedSurface[],
  buildingFootprint: CrossSection | null,
): void {
  const { arena, wasm } = ctx;
  // The complement is measured over the whole PLATE, not over the crop square:
  // a groove close to the crop edge leaves a nub hanging off the band outside
  // it, and clipping the complement at the crop turns that nub into part of a
  // fat island that nothing is wrong with. The bridge itself is still clipped
  // to where a recess is allowed to reach.
  const field = cropSection(ctx, ctx.plateHalfMm);
  const clip = cropSection(ctx, ctx.recessClipHalfMm);
  try {
    for (let pass = 0; pass < RIDGE_MERGE_PASSES; pass += 1) {
      // The POCKETS, not the footprints: the base is carved with the footprint
      // grown by `POCKET_GROW_MM`, and those two micrometres are the whole
      // difference on the Chicago plate. Where a groove runs along a block's
      // edge the growth pinches the base to a hairline and leaves a 0.30 mm
      // lobe hanging off it - invisible to a probe of the raw section, and
      // exactly what the reference validator measures, because a pocket is what
      // the plate is actually built with (`[V3-P7-fix]`).
      const pockets = recesses.map((l) => grownPocket(ctx, l.section));
      const sections = recesses.map((l) => l.section);
      const recess = unionSections(wasm, arena, pockets);
      const complement = recess === null ? null : subtractSection(arena, field, recess);
      // `unionSections` and `grownPocket` both hand a single input straight
      // back, and that input can be a layer's own live footprint: only what
      // this pass allocated may be dropped.
      if (recess !== null && !pockets.includes(recess) && !sections.includes(recess)) {
        arena.drop(recess);
      }
      for (const pocket of pockets) {
        if (!sections.includes(pocket)) arena.drop(pocket);
      }
      if (complement === null || complement === field) return;
      const islands = arena.keepAll(complement.decompose());
      arena.drop(complement);
      const bad: CrossSection[] = [];
      for (const island of islands) {
        if (!survivesMinWall(ctx, island)) {
          // A WHOLE island is absorbed only when nothing stands on it. A recess
          // cutter reaches from its own floor up past the base top and a
          // building only reaches `building_skirt_mm` down into the plate, so
          // absorbing the island a block stands on carves the ground out from
          // under it: measured on frame-off Chicago at plate 256, that took
          // `bodies` from 1 to 2, a block floating 0.3 mm over the groove
          // floor. Such an island is not a thin wall in the printed object
          // either - the block sitting on it is what the slice measures. A
          // WEDGE is different and is always taken: it is a fraction of a
          // square millimetre off the edge of a block that keeps all its other
          // ground (`[V3-P7-fix]`).
          if (!carriesBuilding(ctx, island, buildingFootprint)) {
            bad.push(island);
            continue;
          }
          arena.drop(island);
          continue;
        }
        const wedges = thinParts(ctx, island);
        if (wedges !== null) bad.push(...wedges);
        arena.drop(island);
      }
      if (bad.length === 0) return;
      const merged = bridgeInto(ctx, sink, bad, clip);
      for (const part of bad) arena.drop(part);
      if (!merged) return;
    }
  } finally {
    arena.drop(field);
    arena.drop(clip);
  }
}

/** Does a building stand on this island? */
function carriesBuilding(
  ctx: BuildContext,
  island: CrossSection,
  buildingFootprint: CrossSection | null,
): boolean {
  if (buildingFootprint === null) return false;
  const shared = intersectSection(ctx.arena, island, buildingFootprint);
  if (shared === null) return false;
  ctx.arena.drop(shared);
  return true;
}

/** Grow `bad`, clip it to `clip`, and union it into `sink`. True when it took. */
function bridgeInto(
  ctx: BuildContext,
  sink: RepairedSurface,
  bad: readonly CrossSection[],
  clip: CrossSection,
): boolean {
  const { arena, wasm } = ctx;
  const lump = unionSections(wasm, arena, bad);
  if (lump === null) return false;
  const grown = offsetSection(arena, lump, RIDGE_BRIDGE_CELLS * SIMPLIFY_EPS_MM);
  if (lump !== grown && !bad.includes(lump)) arena.drop(lump);
  if (grown === null) return false;
  const inside = intersectSection(arena, grown, clip);
  if (grown !== inside && !bad.includes(grown)) arena.drop(grown);
  if (inside === null) return false;
  const next = unionSections(wasm, arena, [sink.section, inside]);
  arena.drop(inside);
  if (next === null || next === sink.section) return false;
  replaceSinkSection(ctx, sink, next);
  return true;
}

/** Adopt `next` as the sink's footprint, and rebuild the solid clipped to it. */
function replaceSinkSection(
  ctx: BuildContext,
  sink: RepairedSurface,
  next: CrossSection,
): void {
  const { arena } = ctx;
  sink.section = next;
  // The SOLID is the same footprint clipped to the printed plate; a recess is
  // clipped outside it, so this cannot be skipped.
  const plate = cropSection(ctx, ctx.plateHalfMm);
  const clipped = intersectSection(arena, next, plate);
  arena.drop(plate);
  if (clipped !== null) sink.solidSection = clipped;
  // The pre-merge sections are NOT freed here. In the staged pipeline they are
  // another stage's cached output (the layer's repaired footprint is what the
  // layers after it were blocked by, and stays so), and that owner frees them
  // when it is replaced; a temporary is freed by its stage arena instead.
}

/** Every surface region, in precedence order, each giving way to the last. */
export function buildSurfaceRegions(
  ctx: BuildContext,
  buildingFootprint: CrossSection | null,
): SurfaceRegion[] {
  // Pass one: the repaired footprints. The layers tile the plate - nothing is
  // held apart - which is what makes the partition exact and leaves no rind of
  // base between two grooves.
  const repaired: RepairedSurface[] = [];
  const blockers: Blocker[] = [{ section: buildingFootprint, separate: false }];
  for (const region of SURFACE_ORDER) {
    // One perf row per layer (`solid.water`, `solid.rail`, `solid.roads`,
    // `solid.parks`), so a slow preview names the layer that cost it rather
    // than one lump called "surfaces". No-op with perf mode off.
    const built = perfSpan(`solid.${region}`, () => buildSurfaceRegion(ctx, region, blockers));
    if (built === null) continue;
    repaired.push(built);
    blockers.push({ section: built.section, separate: false });
  }

  // Pass one and a half: hand the unprintable base ridges to the recess that
  // can swallow them, before anything is extruded from these footprints.
  mergeRecessRidges(ctx, repaired, buildingFootprint);

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
