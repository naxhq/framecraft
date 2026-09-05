/**
 * Bridges: the road and rail segments that do not touch the ground.
 *
 * A segment tagged `bridge=yes`, or carrying an OSM `layer` above zero, is
 * lifted out of its grade layer entirely and rebuilt as a slab standing
 * `params.bridges.clearance_mm` above the LOCAL surface, with a short abutment
 * at each end joining it back to grade. Three things follow from that, and each
 * of them is the reason a bridge cannot just be a road with a different
 * `proud_mm`:
 *
 * * **It must not carve a pocket.** A bridge is entirely above the base top, so
 *   it has no recess and takes nothing out of the plate. The surface-region
 *   machinery in `areas.ts` always carves one, which is why bridges are built
 *   here instead of as a fifth `SURFACE_ORDER` entry.
 * * **It must not give way to water.** The grade layers are built in precedence
 *   order and water wins every crossing, which is exactly right for a ford and
 *   exactly wrong for a bridge: the river has to keep its own recessed surface
 *   UNDER the deck. Bridge footprints therefore never enter the blocker chain
 *   and are never subtracted from anything but the buildings.
 * * **It must still be one piece.** A deck 1 mm in the air is a floating island
 *   unless something holds it up, so `params.bridges.abutments` builds a column
 *   under each end, down through the base top. With abutments turned off the
 *   decks really are loose and the engine says so rather than shipping a model
 *   that falls apart on the plate.
 *
 * The deck joins the region its segments came from - a road bridge prints in
 * the roads filament, a rail bridge in the rail one - so bridges add no new
 * colour and no new slot. See `[V3-P3-G4]`.
 */

import type { Point } from "../../contracts";
import * as T from "../../transform";
import type { BuildContext } from "./context";
import {
  MAX_POCKET_FRACTION,
  PART_OVERLAP_MM,
  POCKET_GROW_MM,
  addFinding,
  finding,
} from "./context";
import type { Drape } from "./drape";
import { drapeSolid } from "./drape";
import type { Contour, CrossSection, Manifold } from "./manifold";
import {
  batchedUnion,
  EXTRUDE_SIMPLIFY_MM,
  cleanSection,
  offsetSection,
  extrudeSection,
  intersectSection,
  sectionOf,
  unionSections,
} from "./manifold";
import {
  APPENDAGE_ROUNDS,
  cropSection,
  repairFlatLayer,
  ribbonContours,
  survivesMinWall,
  widenThinParts,
} from "./repair";
import { bridgeRoadWays, bridgeRailWays, railWidthGroundM } from "./roads";
import { baseOsmIdOfRoad, hiddenOverrideIds, widthScaleOverrides } from "./overrides";
import type { RegionName } from "../types";
import { perfSpan } from "../../perf";

/** A centreline that is going to be built in the air. */
export interface BridgeWay {
  path: Point[];
  /** Printed ribbon width, mm. */
  widthMm: number;
}

/** One finished bridge layer, ready to join its region. */
export interface BridgeRegion {
  region: RegionName;
  solid: Manifold;
  /** Segments that produced it, for the stats and the findings. */
  ways: number;
}

/** `params.bridges.enabled`, defaulting to the contract's `true`. */
export function bridgesEnabled(ctx: BuildContext): boolean {
  return ctx.params.bridges?.enabled ?? true;
}

/** `params.bridges.clearance_mm`, defaulting to the contract's 1.0. */
export function clearanceMm(ctx: BuildContext): number {
  return ctx.params.bridges?.clearance_mm ?? 1.0;
}

/** `params.bridges.abutments`, defaulting to the contract's `true`. */
export function abutmentsWanted(ctx: BuildContext): boolean {
  return ctx.params.bridges?.abutments ?? true;
}

/**
 * Narrowest a deck may be, as a multiple of the minimum wall.
 *
 * A grade road is a GROOVE: what the minimum-wall gate measures around it is
 * the base between two grooves, not the road, so a road ribbon at exactly a
 * minimum wall is fine. A deck is the opposite - it is the wall, standing in
 * the air, and it is measured as one. At exactly `min_wall` the ribbon's round
 * joins are a 16-gon whose flats are 2 percent narrower than its diameter, and
 * the Chicago Loop's 780 elevated ways measured 0.794 mm against a 0.800 mm
 * threshold: a fail by two hundredths, on every bridge on the plate.
 *
 * A quarter over the minimum clears it with room for the join geometry, and it
 * is the right direction physically: a deck is an unsupported span and a groove
 * is not (`[V3-P3-G13]`).
 */
export const DECK_MIN_WIDTH_FACTOR = 1.25;

/**
 * How much wider than its deck an abutment footing is.
 *
 * Enough that the footing's side walls cross the deck's outline transversally
 * instead of lying on it: a coincident face is what leaves zero-area triangles,
 * and this is the same argument `POCKET_GROW_MM` makes at a thousandth of the
 * scale. A fifth is far above any rounding and reads as a footing.
 */
export const ABUTMENT_FLARE = 1.0;

/**
 * Thickness of a deck slab, print mm.
 *
 * The region's own `depth_mm` reads as a thickness once the layer is in the
 * air rather than sunk into the plate, floored at 04's own smallest printed
 * height: a 0.2 mm deck is three layers of unsupported bridge and it would sag
 * between its abutments whatever the slicer did.
 */
export function deckThicknessMm(ctx: BuildContext, region: "roads" | "rail"): number {
  const depth = ctx.params.regions?.[region]?.depth_mm ?? (region === "roads" ? 0.6 : 0.4);
  return Math.max(depth, T.MIN_BUILDING_HEIGHT_MM);
}

/**
 * Z an abutment column reaches down to, mm.
 *
 * Deep enough that a column landing on an engraved road still reaches solid
 * base, and - this is the part that had to be measured - strictly BELOW the
 * bottom face of every surface region's own solid, by a clear seam overlap.
 *
 * The obvious `base_top - 1 mm` is 2.0 mm on the contract's 3 mm base, and
 * `areas.solidBottomMm` puts the grade roads' underside at exactly 2.0 mm too:
 * two different formulas landing on the same plane. An abutment sits on a road
 * approach by definition, so the two caps were coplanar over the whole footing,
 * and a boolean across a coincident face leaves zero-area triangles - the last
 * one on the Chicago plate, and the reason `degenerate_faces` still read 1
 * after everything else was fixed.
 *
 * The deepest a region's solid can start is the deepest legal pocket floor less
 * the seam overlap, so going two overlaps below that floor clears every one of
 * them at every legal base thickness (`[V3-P3-G13]`).
 */
export function abutmentFootMm(ctx: BuildContext): number {
  const pocketFloor = ctx.baseTopMm * (1 - MAX_POCKET_FRACTION);
  return Math.max(ctx.baseTopMm * 0.1, pocketFloor - 2 * PART_OVERLAP_MM);
}

/** Ribbon contours for one set of bridge ways, print mm. */
function bridgeContours(ways: readonly BridgeWay[], scale: number): Contour[] {
  const out: Contour[] = [];
  for (const way of ways) {
    if (way.path.length < 2) continue;
    out.push(...ribbonContours(way.path, way.widthMm, scale));
  }
  return out;
}

/**
 * A square at every free end of every bridge way, as one section.
 *
 * The ends are where a bridge meets the ground; the middle is what it is
 * spanning.
 *
 * This is only the WHERE. The shape the column is actually extruded from is the
 * deck's own footprint inside this square, grown by `PART_OVERLAP_MM`
 * ({@link buildBridges}), and getting there took three tries on the Chicago
 * Loop's 780 elevated ways, each failing for the same underlying reason:
 *
 * * a DISC of the ribbon's half width has flats narrower than its diameter, and
 *   its intersection with the ribbon is a lens tapering to nothing at both
 *   ends: 0.393 mm columns;
 * * a SQUARE clipped back to the deck footprint shares its side walls with the
 *   deck's own outline wherever the way runs straight, and a boolean across a
 *   coincident face leaves zero-area triangles: 720 of them in the roads
 *   region;
 * * a square FLARED to {@link ABUTMENT_FLARE} of the deck width and not clipped
 *   leaves its walls 0.1 mm from the deck's own at a junction, which is
 *   near-tangency rather than coincidence and generates the same slivers: 167.
 *
 * Growing the deck's own shape by the seam overlap is what finally works, and
 * it is the same trick `areas.fittedSolid` plays for every other region: the
 * footing is then uniformly 0.2 mm proud of the deck, so the deck's vertical
 * wall is strictly INSIDE the footing over the range they share and there is no
 * intersection curve to leave slivers on (`[V3-P3-G13]`).
 */
function abutmentContours(ways: readonly BridgeWay[], scale: number): Contour[] {
  const out: Contour[] = [];
  for (const way of ways) {
    if (way.path.length < 2) continue;
    const half = (way.widthMm * ABUTMENT_FLARE) / 2;
    if (!(half > 0)) continue;
    // A DIAMOND: a square turned 45 degrees. Its edges therefore run at 45 and
    // 135 degrees and can never be parallel to a street on a north-south grid,
    // which is what Chicago's Loop is and what left the last slivers here.
    const reach = half * Math.SQRT2 * ABUTMENT_FLARE;
    for (const end of [way.path[0], way.path[way.path.length - 1]]) {
      const x = end[0] * scale;
      const y = end[1] * scale;
      out.push([
        [x + reach, y],
        [x, y + reach],
        [x - reach, y],
        [x, y - reach],
      ]);
    }
  }
  return out;
}

/**
 * Build every bridge in the scene, one solid per region.
 *
 * `buildingFootprint` is the only thing a bridge gives way to: a deck cannot
 * run through a tower. Everything else - water, parks, the grade roads - is
 * underneath it and stays exactly as it was.
 */
export function buildBridges(
  ctx: BuildContext,
  buildingFootprint: CrossSection | null,
  drape: Drape | null,
): BridgeRegion[] {
  if (!bridgesEnabled(ctx)) return [];
  const out: BridgeRegion[] = [];
  const sets: Array<{ region: "roads" | "rail"; ways: BridgeWay[] }> = [
    { region: "roads", ways: roadBridgeWays(ctx) },
    { region: "rail", ways: railBridgeWays(ctx) },
  ];

  let built = 0;
  let loose = 0;
  for (const { region, ways } of sets) {
    if (ways.length === 0) continue;
    const contours = bridgeContours(ways, ctx.scale);
    if (contours.length === 0) continue;
    // The buildings are held PART_OVERLAP_MM clear rather than cut flush.
    // A deck is the one layer that is raised AND shares a Z range with the
    // towers it passes, so the two constructions the rest of the engine can
    // choose between are both wrong here: cutting flush leaves coincident
    // vertical faces (460 degenerate faces in the validator's union), and
    // cutting flush then growing back by the seam overlap - what every recessed
    // region does - leaves the grown lip hanging in the air wherever the
    // building is shorter than the deck, which measures 0.205 mm and fails the
    // minimum wall. Standing 0.2 mm off the building gives neither
    // (`[V3-P3-G13]`).
    const clearOfBuildings =
      buildingFootprint === null
        ? null
        : offsetSection(ctx.arena, buildingFootprint, PART_OVERLAP_MM);
    const repaired = repairFlatLayer(ctx, contours, {
      clipHalfMm: ctx.cropHalfMm,
      subtract: [{ section: clearOfBuildings, separate: false }],
      thinMode: "strip",
    });
    if (clearOfBuildings !== null && clearOfBuildings !== buildingFootprint) {
      ctx.arena.drop(clearOfBuildings);
    }
    if (repaired.section === null) continue;

    const deck = deckThicknessMm(ctx, region);
    const bottom = ctx.baseTopMm + clearanceMm(ctx);
    const pieces: Manifold[] = [];
    const slab = extrudeSection(ctx.wasm, ctx.arena, repaired.section, bottom, bottom + deck);
    if (slab === null) continue;
    pieces.push(slab);

    const grounded = abutmentsWanted(ctx);
    if (grounded) {
      const raw = sectionOf(ctx.wasm, ctx.arena, abutmentContours(ways, ctx.scale));
      const crop = cropSection(ctx, ctx.cropHalfMm);
      const squares = raw === null ? null : intersectSection(ctx.arena, raw, crop);
      ctx.arena.drop(crop);
      // Never wider than the deck it holds up, and never inside a building.
      // Built WITHOUT `repairFlatLayer`: its `keepPrintable` pass judges each
      // square on its own, and a square exactly one ribbon wide does not
      // survive an erosion by half a minimum wall, so every abutment on the
      // plate was being dropped before it was ever clipped. Clipping to the
      // deck instead inherits the deck's width, which already clears the gate.
      // The footing is the SQUARE ITSELF, clipped to the crop and to nothing
      // else. Every richer shape tried here was tangent to something and every
      // tangency cost boolean slivers on the Chicago Loop's 780 elevated ways:
      // a disc gave 0.393 mm lenses, a square clipped back to the deck shared
      // the deck's own walls (720 degenerate faces), a flared square left them
      // 0.1 mm apart (167), and taking the deck's shape and growing it put the
      // footing's wall back on the buildings the deck had been cut against
      // (80 faces and eleven zero-volume shells in the clearance band).
      //
      // A plain square of the deck's NOMINAL width sits 0.2 mm inside the grown
      // deck's wall - the same clearance as every other seam in the engine -
      // and its own walls cross a building's transversally, so there is nothing
      // for a boolean to resolve tangentially anywhere (`[V3-P3-G13]`).
      const seated = squares === null ? null : printableAbutments(ctx, squares);
      if (seated !== null) {
        const foot = abutmentFootMm(ctx);
        const column = extrudeSection(
          ctx.wasm,
          ctx.arena,
          seated,
          foot,
          bottom + PART_OVERLAP_MM,
        );
        if (column !== null) pieces.push(column);
      }
    }

    const merged = batchedUnion(ctx.wasm, ctx.arena, pieces);
    if (merged === null) continue;
    // Every deck that is still in the air after the abutments went in is
    // DROPPED, not shipped. A body that does not reach below the base top has
    // nothing holding it up: it is an island the validator would fail the whole
    // model on, and a segment missing from a viaduct is a smaller lie than a
    // slab floating a millimetre over the river. Eleven of the Chicago Loop's
    // 780 ways end inside a building footprint or on ground another layer
    // already owns, which is why this is a real case and not a guard
    // (`[V3-P3-G14]`).
    const standing = grounded ? groundedOnly(ctx, merged) : { solid: merged, dropped: 0 };
    if (standing.solid === null) {
      loose += ways.length;
      continue;
    }
    loose += grounded ? standing.dropped : ways.length;
    // Draped like every other region: the deck is above the vertical ramp, so
    // the warp is a pure translation there and the slab keeps its thickness and
    // its clearance over the ground it crosses.
    const placed = drapeSolid(ctx, drape, standing.solid);
    if (placed === null) continue;
    built += ways.length;
    out.push({ region, solid: placed, ways: ways.length });
  }

  if (loose > 0) {
    addFinding(
      ctx,
      finding(
        "bridge-unsupported",
        "warning",
        abutmentsWanted(ctx)
          ? `${loose} bridge deck(s) had nothing to stand on`
          : `${loose} bridge deck(s) have nothing holding them up`,
        abutmentsWanted(ctx)
          ? "Their ends fall inside a building or on ground another layer already owns, so " +
            "there was nowhere to put an abutment. They were left out rather than printed " +
            "floating over the surface."
          : "Abutments are switched off, so these decks print as loose pieces floating " +
            `${clearanceMm(ctx).toFixed(2)} mm above the surface. Turn abutments back on, ` +
            "or turn bridges off to lay these segments at grade.",
      ),
    );
  }
  if (built === 0 && out.length === 0) return out;
  return out;
}

/**
 * The abutment footprints that are worth printing, cleaned before extrusion.
 *
 * Cutting the building layer out of a footing can leave a sliver at a corner:
 * the Chicago Loop measured 0.053 mm at abutment height before this pass, which
 * is a hundredth of a wall, prints as nothing at all, and fails the whole
 * model's Stage 4 gate. Each connected piece is therefore judged on its own by
 * the same rule every other solid is - a full minimum wall must fit inside it -
 * and the survivors have their own thin limbs widened.
 *
 * `cleanSection` at the end is not optional: it is the deburr and vertex-clean
 * pass every other section gets before it is extruded (`manifold.cleanSection`),
 * and a boolean chain leaves exactly the near-duplicate vertices that extrude
 * into zero-area side triangles.
 *
 * An abutment lost here is not silently lost: {@link groundedOnly} then finds
 * the deck it would have held up and drops that too, with a count.
 */
function printableAbutments(ctx: BuildContext, seated: CrossSection): CrossSection | null {
  const parts = ctx.arena.keepAll(seated.decompose());
  const kept: CrossSection[] = [];
  for (const part of parts) {
    if (!survivesMinWall(ctx, part)) {
      ctx.arena.drop(part);
      continue;
    }
    const widened = widenThinParts(ctx, part, APPENDAGE_ROUNDS);
    if (widened !== part) ctx.arena.drop(part);
    kept.push(widened);
  }
  if (kept.length === 0) return null;
  const merged = unionSections(ctx.wasm, ctx.arena, kept);
  for (const part of kept) {
    if (part !== merged) ctx.arena.drop(part);
  }
  if (merged === null) return null;
  // Deburred at `POCKET_GROW_MM` rather than at `cleanSection`'s own ten
  // nanometres. A footing is the union of up to 1 560 overlapping squares
  // clipped to a road network and then grown, which is about as many chances
  // to touch itself as a section in this engine ever gets: at ten nanometres
  // one pinch point survived on the Chicago Loop and extruded into the single
  // zero-area triangle the reference validator still reported. Two micrometres
  // is the same radius the base pockets are grown by, and it costs the footing
  // a five-hundredth of a layer height of width.
  const clean = cleanSection(ctx.arena, merged, EXTRUDE_SIMPLIFY_MM, POCKET_GROW_MM);
  if (clean !== merged) ctx.arena.drop(merged);
  return clean;
}

/**
 * Keep only the bodies that reach into the base, and count what went.
 *
 * "Reaches into the base" is exactly "has an abutment": a deck slab starts at
 * `base_top + clearance` and an abutment column starts below `base_top`, so a
 * body whose lowest point is at or above the base top is standing on nothing.
 * One `decompose` and a bounding box each, which is the cheapest connectivity
 * question that can be asked and the only one that has to be asked here.
 */
function groundedOnly(
  ctx: BuildContext,
  solid: Manifold,
): { solid: Manifold | null; dropped: number } {
  const bodies = perfSpan("bridges.decompose", () => ctx.arena.keepAll(solid.decompose()));
  if (bodies.length <= 1) {
    const only = bodies[0];
    const grounded = only === undefined || only.boundingBox().min[2] < ctx.baseTopMm;
    ctx.arena.dropAll(bodies);
    return grounded ? { solid, dropped: 0 } : { solid: null, dropped: 1 };
  }
  const kept = bodies.filter((body) => body.boundingBox().min[2] < ctx.baseTopMm);
  const dropped = bodies.length - kept.length;
  if (dropped === 0) {
    ctx.arena.dropAll(bodies);
    return { solid, dropped: 0 };
  }
  const merged = kept.length === 0 ? null : perfSpan("bridges.reunion", () => batchedUnion(ctx.wasm, ctx.arena, kept));
  const out = merged === null ? null : ctx.arena.keep(merged);
  ctx.arena.dropAll(bodies.filter((body) => body !== out));
  return { solid: out, dropped };
}

/** Narrowest a deck may print, mm. See {@link DECK_MIN_WIDTH_FACTOR}. */
export function deckMinWidthMm(ctx: BuildContext): number {
  return DECK_MIN_WIDTH_FACTOR * ctx.thresholdsMm.minWall;
}

/**
 * Road ways this build will build in the air, at their grade printed width.
 *
 * A road an `object_overrides` row hid (or switched off) is not built here
 * either: "leave it out of the model" means out of the deck as well as out of
 * the ground layer. A `width_scale` override reaches the deck through the same
 * ground width the flat ribbon uses, so a widened bridge road stays as wide in
 * the air as it is where it comes back down.
 */
export function roadBridgeWays(ctx: BuildContext): BridgeWay[] {
  if (ctx.params.road_mode === "off") return [];
  const floor = deckMinWidthMm(ctx);
  const hidden = hiddenOverrideIds(ctx.params, "road");
  const widthScales = widthScaleOverrides(ctx.params);
  const out: BridgeWay[] = [];
  for (const road of bridgeRoadWays(ctx.scene)) {
    const id = baseOsmIdOfRoad(road);
    if (hidden.has(id)) continue;
    const scale = widthScales.get(id) ?? 1;
    const groundM = T.road_width_ground_m(
      scale === 1 ? road : { width_m: road.width_m * scale },
      ctx.params,
      ctx.thresholdsGroundM,
    );
    out.push({ path: road.path, widthMm: Math.max(groundM * ctx.scale, floor) });
  }
  return out;
}

/** Rail ways this build will build in the air, at their grade printed width. */
export function railBridgeWays(ctx: BuildContext): BridgeWay[] {
  const floor = deckMinWidthMm(ctx);
  const out: BridgeWay[] = [];
  for (const way of bridgeRailWays(ctx.scene)) {
    out.push({
      path: way.path,
      widthMm: Math.max(railWidthGroundM(ctx) * ctx.scale, floor),
    });
  }
  return out;
}
