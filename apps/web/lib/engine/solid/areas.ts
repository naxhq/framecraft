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
  LAYER_SEPARATION_MM,
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
  printableSection,
  survivesMinWall,
  thinParts,
  type Blocker,
} from "./repair";
import { overrideRoadContours, railLayerContours, roadLayerContours } from "./roads";
import {
  baseOsmIdOfArea,
  hiddenOverrideIds,
  overrideGroups,
  type OverrideGroup,
  type OverrideLayer,
} from "./overrides";
import type { RegionName } from "../types";

/**
 * One layer after the Stage 1 repair, before anything is extruded.
 *
 * `region` is a `RegionName` rather than a `SurfaceName` because an override
 * group's own layer (`override_N`, v3.1 Task 11) is repaired, merged, extruded
 * and carved by exactly this machinery; the four names a `SurfaceName` can take
 * are all region names too.
 */
export interface RepairedSurface {
  region: RegionName;
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

/** The depth and offset the contract asks for, before any clamp. */
function placementSpec(ctx: BuildContext, region: SurfaceName): [number, number] {
  const spec = ctx.params.regions?.[region];
  const fallback: Record<SurfaceName, [number, number]> = {
    water: [1.0, -0.5],
    rail: [0.4, 0.3],
    roads: [0.6, -0.2],
    parks: [0.4, 0.0],
  };
  const [depth, proud] = fallback[region];
  return [spec?.depth_mm ?? depth, spec?.proud_mm ?? proud];
}

/** The contract's per-region placement, with the v1 defaults as the fallback. */
export function placementFor(ctx: BuildContext, region: SurfaceName): Placement {
  const [depth, proud] = placementSpec(ctx, region);
  return placementOf(ctx, depth, proud);
}

/**
 * How far the surface a road override may be moved when the layer itself sits
 * flush, mm.
 *
 * `regions.roads.proud_mm` can legally be 0, and a per-road "engrave" that
 * mirrored a zero offset would engrave nothing. The contract's own default
 * magnitude is the honest stand-in: it is what "engraved roads" means on a
 * default plate.
 */
export const OVERRIDE_FLUSH_PROUD_MM = 0.2;

/**
 * Where one override group's own layer sits, relative to the base top.
 *
 * It MIRRORS the layer it came out of rather than inventing numbers: the depth
 * is the layer's, and only the offset moves.
 *
 * * a road switched to `engrave` takes `-|roads.proud_mm|`, to `emboss` takes
 *   `+|roads.proud_mm|`, so a user who deepened the road recess and then
 *   embossed one street gets that street standing as proud as the others are
 *   sunk;
 * * a water or green polygon takes its layer's offset plus `raise_mm`, so the
 *   number in the inspector reads as "this much further up (or down) than the
 *   rest of the water";
 * * everything else keeps its layer's placement exactly, which is the case of
 *   a group that only asked for a colour.
 *
 * Null for a building group: buildings are extruded from the plate to their own
 * roof and have no surface placement at all.
 */
export function overridePlacement(ctx: BuildContext, group: OverrideGroup): Placement | null {
  if (group.surface === null) return null;
  const [depth, layerProud] = placementSpec(ctx, group.surface);
  if (group.layer === "road" && group.roadMode !== "inherit") {
    const magnitude = Math.abs(layerProud) < 1e-9 ? OVERRIDE_FLUSH_PROUD_MM : Math.abs(layerProud);
    return placementOf(ctx, depth, group.roadMode === "emboss" ? magnitude : -magnitude);
  }
  return placementOf(ctx, depth, layerProud + group.raiseMm);
}

/**
 * The polygons of one area layer that stay in it.
 *
 * Two kinds of `object_overrides` row take a polygon out (v3.1 Task 11): one
 * that hides it, and one that gives it a filament or a raise of its own and
 * moves it into an `override_N` region. Both are applied HERE, before the
 * repair, so the layer closes over the ground rather than keeping a hole.
 *
 * A dissolved polygon with no `osm_id` at all names no OSM element and can
 * never be the target of an override, so it is always kept.
 */
function visibleAreas(
  ctx: BuildContext,
  features: readonly { ring: import("../../contracts").Point[]; holes: import("../../contracts").Point[][]; osm_id?: string }[],
  layer: OverrideLayer,
): typeof features {
  const hidden = hiddenOverrideIds(ctx.params, layer);
  const grouped = overrideGroups(ctx.params).byId;
  if (hidden.size === 0 && grouped.size === 0) return features;
  return features.filter((feature) => {
    const id = baseOsmIdOfArea(feature);
    if (id === null) return true;
    if (hidden.has(id)) return false;
    return grouped.get(id)?.layer !== layer;
  });
}

/** Contours for one layer, print mm. */
function layerContours(ctx: BuildContext, region: SurfaceName): Contour[] {
  switch (region) {
    case "water":
      return ctx.params.water ? areaContours(visibleAreas(ctx, ctx.scene.water, "water"), ctx.scale) : [];
    case "rail":
      return railLayerContours(ctx);
    case "roads":
      return roadLayerContours(ctx);
    case "parks":
      return areaContours(visibleAreas(ctx, ctx.scene.green, "green"), ctx.scale);
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
 * The polygons one override group takes out of an area layer, print mm.
 *
 * The group's own ids, in the group's layer, minus anything hidden: an object
 * cannot be both given a filament and taken out of the model, and "hidden"
 * wins, because it is the stronger statement.
 */
function overrideAreaContours(ctx: BuildContext, group: OverrideGroup): Contour[] {
  if (group.layer !== "water" && group.layer !== "green") return [];
  if (group.layer === "water" && !ctx.params.water) return [];
  const source = group.layer === "water" ? ctx.scene.water : ctx.scene.green;
  const hidden = hiddenOverrideIds(ctx.params, group.layer);
  const wanted = new Set(group.ids);
  const features = source.filter((feature) => {
    const id = baseOsmIdOfArea(feature);
    return id !== null && wanted.has(id) && !hidden.has(id);
  });
  return areaContours(features, ctx.scale);
}

/**
 * One override group's layer, repaired exactly as a surface layer is (v3.1
 * Task 11).
 *
 * It IS a surface layer: the same repair, the same clip rules, the same
 * `RepairedSurface` record, so the ridge merge, the base carve, the assembly and
 * the region phase all treat it like water or roads and need no special case.
 * What differs is only where its contours come from and where it sits.
 *
 * Null when the group has no geometry on this plate - a group whose only road
 * is a bridge deck, or whose object the crop no longer reaches - which is what
 * lets `surface-overrides` report the groups that could not be built.
 */
export function buildOverrideSurface(
  ctx: BuildContext,
  group: OverrideGroup,
  blockers: readonly Blocker[],
): RepairedSurface | null {
  const placement = overridePlacement(ctx, group);
  if (placement === null) return null;
  const contours =
    group.layer === "road" ? overrideRoadContours(ctx, group) : overrideAreaContours(ctx, group);
  if (contours.length === 0) return null;
  const recessed = placement.topMm < ctx.baseTopMm;
  const clipHalfMm = recessed ? ctx.recessClipHalfMm : ctx.cropHalfMm;
  const repaired = repairFlatLayer(ctx, contours, {
    clipHalfMm,
    subtract: blockers,
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
  return {
    region: group.region,
    section: repaired.section,
    solidSection,
    placement,
    dropped: repaired.dropped,
  };
}

/**
 * Every override group's layer, in group order, each blocked by the buildings
 * and by the groups before it.
 *
 * They come FIRST, before water: an object the user singled out owns its ground
 * against every ordinary layer, which is what makes "this street is gold" mean
 * the whole street rather than the parts no park claimed.
 */
export function buildOverrideSurfaces(
  ctx: BuildContext,
  groups: readonly OverrideGroup[],
  buildingFootprint: CrossSection | null,
): { surfaces: RepairedSurface[]; unbuilt: OverrideGroup[] } {
  const surfaces: RepairedSurface[] = [];
  const unbuilt: OverrideGroup[] = [];
  const blockers: Blocker[] = [{ section: buildingFootprint, separate: false }];
  for (const group of groups) {
    if (group.surface === null) continue;
    const built = perfSpan(`solid.${group.region}`, () => buildOverrideSurface(ctx, group, blockers));
    if (built === null) {
      unbuilt.push(group);
      continue;
    }
    surfaces.push(built);
    blockers.push({ section: built.section, separate: false });
  }
  return { surfaces, unbuilt };
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
export function fittedSolid(
  ctx: BuildContext,
  section: CrossSection,
  /**
   * Footprints of the layers whose floor is LOWER than this one's. The seam
   * overlap is taken back out of the solid wherever it would reach over one
   * of them: a rim of road standing 0.2 mm into a river pocket is a ledge
   * 0.3 mm proud of the water along the bank, and at the flat end of a
   * ribbon that stops at a building corner it is a 0.2 mm spur the reference
   * validator fails as a wall (London, `min_wall` 0.206 mm). The reference
   * truncates every inlay by the deeper recesses' cutters for the same reason
   * (`assemble.py`, "never stand proud of the model"). The overlap with the
   * BASE, and with layers no deeper than this one, is kept: that is the seam.
   */
  deeper: readonly CrossSection[] = [],
): CrossSection {
  const grown = offsetSection(ctx.arena, section, PART_OVERLAP_MM);
  if (grown === null || grown === section) return section;
  // Never past the printed edge, whatever the crop allowed.
  const plate = cropSection(ctx, ctx.plateHalfMm);
  const clipped = intersectSection(ctx.arena, grown, plate);
  ctx.arena.drop(plate);
  if (clipped !== grown) ctx.arena.drop(grown);
  if (clipped === null) return section;
  if (deeper.length === 0) return clipped;
  const below = unionSections(ctx.wasm, ctx.arena, deeper);
  if (below === null) return clipped;
  // Held `LAYER_SEPARATION_MM` clear of the deeper footprint, not cut flush:
  // the base's pocket for that layer is the footprint grown by two
  // micrometres, and a solid cut on the footprint itself puts a wall two
  // micrometres from the pocket's, which on the shared top plane at the base
  // top is a needle the reference validator's own union of the parts
  // retriangulates into a 6e-11 mm^2 face (Paris, `degenerate_faces` 1, at a
  // park's edge along a road groove). Twenty micrometres is the engine's own
  // seam distance everywhere else (`[V3-P2-E2]`).
  const held = offsetSection(ctx.arena, below, LAYER_SEPARATION_MM) ?? below;
  if (!deeper.includes(below) && held !== below) ctx.arena.drop(below);
  const trimmed = subtractSection(ctx.arena, clipped, held);
  if (!deeper.includes(held)) ctx.arena.drop(held);
  if (trimmed === null) return section;
  if (trimmed !== clipped) ctx.arena.drop(clipped);
  return trimmed;
}

/**
 * The footprints of the RECESSED layers in `layers` whose floor is lower than
 * `layer`'s, for a `layer` that is itself recessed; empty otherwise.
 *
 * The reference's rule is about inlays: an inlay is truncated where a deeper
 * recess cuts under it. A RAISED layer keeps its whole rim - a rail ribbon
 * standing 0.3 mm proud is the same ribbon whether it crosses a groove or
 * not, which `matrix.probes.ts` pins (`regions.rail.proud_mm`, the volume
 * must not move), and a flush layer's rim over a pocket is the seam overlap
 * every region has.
 */
export function deeperLayers(ctx: BuildContext, layer: RepairedSurface, layers: readonly RepairedSurface[]): CrossSection[] {
  if (!(layer.placement.topMm < ctx.baseTopMm)) return [];
  return layers
    .filter((other) => other !== layer && other.placement.topMm < layer.placement.topMm && other.placement.topMm < ctx.baseTopMm)
    .map((other) => other.section);
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
 * Frame on and off alike, as the reference runs it. It was gated to the
 * frame-off plate for v3.0.0 (`[V3-P7-fix]`, a scoping decision: merging the
 * frame-on Chicago plate's 38 islands and 13 wedges moved the default golden
 * days before the tag, and that plate passed every validator row as it was).
 * The first frame-on builds of the other presets did not: Tokyo fails the
 * reference validator's `min_wall` row at 0.168 mm and London at 0.206 mm,
 * each on a wedge of base between the flat end of a road groove and the wall
 * of the building it stops short of, exactly the complement this merge exists
 * to hand to the groove (v3.1 preset matrix, 2026-09-03). The frame hides a
 * rind at the crop edge; it hides nothing in the middle of the plate.
 */
export function mergeRecessRidges(
  ctx: BuildContext,
  layers: readonly RepairedSurface[],
  buildingFootprint: CrossSection | null,
): void {
  const recessed = layers.filter((l) => l.placement.topMm < ctx.baseTopMm);
  if (recessed.length === 0) return;
  const before = layers.map((l) => l.section);
  // The sink is the last recessed layer in precedence order - roads at the
  // contract defaults, which is the reference's own choice: the road network is
  // what every base island is bounded by, so a bridge lands in the layer that
  // already touches both sides of it.
  const sink = recessed[recessed.length - 1];
  perfSpan("ridges.merge", () => mergeInto(ctx, sink, recessed, buildingFootprint));
  for (const layer of recessed) {
    if (layer !== sink) perfSpan("ridges.merge", () => mergeInto(ctx, layer, [layer], buildingFootprint));
  }
  // A layer that grew here was a BLOCKER of every layer after it in precedence
  // order, and those were cut by the footprint it had before. What it swallowed
  // has to come out of them too, or the bridge is a hole in the base with the
  // later layer's material still standing in it: London's river pocket grew by
  // the 0.2 mm tip of a road ribbon that ends at a building corner, and the
  // ribbon (cut by the old river) kept the tip as a fin 0.3 mm proud of the
  // water. The reference cuts green with the MERGED road union for the same
  // reason (`thicken.repair_scene`, `road_union = roads.union` after the merge).
  for (let i = 0; i < layers.length; i += 1) {
    const grown = layers[i];
    if (grown.section === before[i]) continue;
    for (let j = i + 1; j < layers.length; j += 1) {
      const later = layers[j];
      const cutSection = subtractSection(ctx.arena, later.section, grown.section);
      const cutSolid =
        later.solidSection === later.section
          ? cutSection
          : subtractSection(ctx.arena, later.solidSection, grown.section);
      // A layer the growth swallowed whole keeps its footprint: it is inside
      // the grown pocket and prints nothing the pocket does not already own.
      if (cutSection === null || cutSolid === null) continue;
      later.section = cutSection;
      later.solidSection = cutSolid;
      perfSpan("ridges.recut", () => recutPrintable(ctx, later));
    }
  }
}

/**
 * Put a layer the ridge merge has just re-cut back through its own
 * minimum-feature rules, when it prints as MATERIAL.
 *
 * The cut is exact - the later layer loses precisely what the grown recess
 * took - and exact is the problem: where a bridge crosses a park at an angle
 * it leaves a sliver of park outside the road, far under anything the layer's
 * repair would have kept, and the 0.2 mm seam rim (`fittedSolid`) turns that
 * sliver into a fin standing in the pocket. Tokyo, measured 2026-09-05: a
 * 0.1 mm sliver at build (171.25, 26.79) printed 0.204 mm wide and 0.45 mm
 * long from z 2.4 to 3.0, the reference validator's `min_wall` failing it at
 * both recess-band probes; with the merge on and this cut off the site is
 * clean, and the whole plate reads exactly the two regions written up in
 * FAILURES.md. The reference has no such fragment because it re-repairs green
 * against the MERGED road union, drops and all (`thicken.repair_scene`).
 *
 * A RECESSED later layer is left as cut. Its fragment prints as a dimple in
 * the base with the layer's own solid welded into it, not as a wall, and
 * dropping it would open a nub of base beside the grown recess after the
 * merge has run and can no longer judge it. A layer nothing survives of keeps
 * the cut footprint, which is what it had before this function existed.
 */
function recutPrintable(ctx: BuildContext, layer: RepairedSurface): void {
  if (layer.placement.topMm < ctx.baseTopMm) return;
  const printable = printableSection(ctx, layer.section, "strip");
  if (printable.section === null) return;
  layer.dropped += printable.dropped;
  if (printable.section === layer.section) return;
  const solid =
    layer.solidSection === layer.section
      ? printable.section
      : (intersectSection(ctx.arena, printable.section, layer.solidSection) ?? printable.section);
  layer.section = printable.section;
  layer.solidSection = solid;
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
  // Islands an earlier pass of THIS call judged and left standing, by their
  // exact polygon. A bridge changes the complement only where it lands, so the
  // next pass decomposes mostly the same islands again, and every one of them
  // was costing the erosion probe and the appendage search a second time
  // (measured: the second pass of the Chicago sink merge, which bridges
  // nothing, was 40 of the merge's 100 ms of judging). An island that comes
  // back vertex for vertex identical gets the verdict it already has; one the
  // bridge touched is a different polygon and is judged afresh.
  const cleared = new Map<string, Float64Array>();
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
      const recess = perfSpan("ridges.complement", () => unionSections(wasm, arena, pockets));
      const complement = recess === null ? null : perfSpan("ridges.complement", () => subtractSection(arena, field, recess));
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
      const islands = perfSpan("ridges.islands", () => arena.keepAll(complement.decompose()));
      arena.drop(complement);
      const bad: CrossSection[] = [];
      perfSpan("ridges.judge", () => {
        for (const island of islands) {
          const shape = islandShape(island);
          if (sameShape(cleared.get(shape.key), shape.coords)) {
            arena.drop(island);
            continue;
          }
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
            cleared.set(shape.key, shape.coords);
            arena.drop(island);
            continue;
          }
          const wedges = thinParts(ctx, island);
          if (wedges !== null && wedges.length > 0) bad.push(...wedges);
          else cleared.set(shape.key, shape.coords);
          arena.drop(island);
        }
      });
      if (bad.length === 0) return;
      const merged = perfSpan("ridges.bridge", () => bridgeInto(ctx, sink, bad, clip));
      for (const part of bad) arena.drop(part);
      if (!merged) return;
    }
  } finally {
    arena.drop(field);
    arena.drop(clip);
  }
}

/**
 * An island's polygon as a comparable value: every ring rotated to start at
 * its lexicographically smallest vertex, the rings sorted, the coordinates
 * flattened, plus a hash of the whole as the map key. The hash only finds the
 * candidate; {@link sameShape} compares every coordinate, so two islands are
 * only ever treated as one when they are the same polygon.
 */
function islandShape(island: CrossSection): { key: string; coords: Float64Array } {
  const rings = island.toPolygons().map((ring) => {
    let start = 0;
    for (let i = 1; i < ring.length; i += 1) {
      const [x, y] = ring[i];
      const [bx, by] = ring[start];
      if (x < bx || (x === bx && y < by)) start = i;
    }
    const flat = new Float64Array(ring.length * 2);
    for (let i = 0; i < ring.length; i += 1) {
      const [x, y] = ring[(start + i) % ring.length];
      flat[i * 2] = x;
      flat[i * 2 + 1] = y;
    }
    return flat;
  });
  rings.sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  });
  let total = 1 + rings.length;
  for (const ring of rings) total += ring.length;
  const coords = new Float64Array(total);
  coords[0] = rings.length;
  let at = 1;
  for (const ring of rings) {
    coords[at] = ring.length;
    at += 1;
  }
  for (const ring of rings) {
    coords.set(ring, at);
    at += ring.length;
  }
  // FNV-1a over the 32-bit halves, twice with different seeds.
  const words = new Uint32Array(coords.buffer);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < words.length; i += 1) {
    h1 = Math.imul(h1 ^ words[i], 0x01000193);
    h2 = Math.imul(h2 ^ words[i], 0x9e3779b1);
  }
  return { key: `${h1 >>> 0}:${h2 >>> 0}:${coords.length}`, coords };
}

/** Same polygon, coordinate for coordinate. */
function sameShape(known: Float64Array | undefined, coords: Float64Array): boolean {
  if (known === undefined || known.length !== coords.length) return false;
  for (let i = 0; i < known.length; i += 1) {
    if (known[i] !== coords[i]) return false;
  }
  return true;
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
    const pocket = perfSpan("surface.pocket", () => grownPocket(ctx, layer.section));
    const fitted = perfSpan("surface.fit", () => fittedSolid(ctx, layer.solidSection, deeperLayers(ctx, layer, repaired)));
    const solid = perfSpan("surface.extrude", () =>
      extrudeSection(ctx.wasm, ctx.arena, fitted, solidBottomMm(ctx, layer.placement), layer.placement.topMm),
    );
    const cutter = perfSpan("surface.extrude", () =>
      extrudeSection(ctx.wasm, ctx.arena, pocket, layer.placement.bottomMm, cutterTopMm(ctx)),
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
