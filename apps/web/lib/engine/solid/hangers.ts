/**
 * The two mounts that need a part of their own: the French cleat and the easel.
 *
 * The keyhole and the magnet hanger are pockets and nothing else, so they stay
 * in `solid/ornaments.ts` beside the underside mark. These two are different:
 * each is a pocket in the underside PLUS a separate printable piece that goes
 * into it, and that piece has to be somewhere.
 *
 * Where it is, is the ruling this module rests on (`[V3-P5-F6]`): **the piece
 * is emitted inside its own pocket, with one clearance on every face**
 * (`transform.LOOSE_PART_CLEARANCE_MM`). Every other placement is worse. Beside
 * the plate it puts the model over the plate bounds and fails Stage 4's
 * bounding-box row; in its assembled position it hangs below z = 0 and drags
 * the whole model off the bed; anywhere on top of the plate it lands on the
 * city. Printed in its pocket it is a print-in-place part: it comes out of the
 * printer inside the plate and is pushed out afterwards, the model still sits
 * at zero, and the file still fits the plate it says it fits.
 *
 * The cleat slot is UNDERCUT, at exactly 45 degrees, which is what makes it a
 * cleat and what makes it printable: every layer overhangs the one below by one
 * layer height. It runs edge to edge, because a wedge printed inside an
 * undercut slot can only leave sideways.
 */

import * as T from "../../transform";
import type { RegionName } from "../types";
import {
  CIRCLE_SEGMENTS,
  CUTTER_OVERSHOOT_MM,
  addFinding,
  finding,
  type BakeContext,
} from "./context";
import type { Contour, Manifold } from "./manifold";
import {
  batchedUnion,
  circleContour,
  extrudeSection,
  rectContour,
  sectionOf,
  subtractSolids,
} from "./manifold";

/** Slabs the 45 degree undercut and the leaning socket are stepped with. */
export const HANGER_SLABS = 8;

/** How far the easel leans the plate back, degrees from the underside normal. */
export const EASEL_LEAN_DEG = 20;

export interface HangerPart {
  region: RegionName;
  solid: Manifold;
}

export interface HangerGeometry {
  /** Cutters for the base, from below. */
  baseCut: Manifold[];
  /** Separate printable pieces, each its own region and its own body. */
  parts: HangerPart[];
}

/** A rectangle as a section, print mm. */
function rectSection(
  ctx: BakeContext,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  if (!(x1 > x0) || !(y1 > y0)) return null;
  return sectionOf(ctx.wasm, ctx.arena, [rectContour(x0, y0, x1, y1)]);
}

/** Extrude a rectangle between two Z planes, tracked. */
function box(
  ctx: BakeContext,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  z0: number,
  z1: number,
): Manifold | null {
  const section = rectSection(ctx, x0, y0, x1, y1);
  if (section === null) return null;
  const solid = extrudeSection(ctx.wasm, ctx.arena, section, z0, z1);
  ctx.arena.drop(section);
  return solid;
}

/** How far below the base top the deepest surface region reaches, print mm. */
function deepestRecessMm(ctx: BakeContext): number {
  return T.deepest_recess_mm(ctx.params);
}

/** Can the plate carry a pocket this deep cut from underneath? */
function undersideFits(ctx: BakeContext, depthMm: number): boolean {
  return (
    depthMm + T.HANGER_MIN_ROOF_MM + deepestRecessMm(ctx) <=
    ctx.params.base_thickness_mm + 1e-9
  );
}

function refuse(ctx: BakeContext, kind: string, depthMm: number): void {
  const needed = depthMm + T.HANGER_MIN_ROOF_MM + deepestRecessMm(ctx);
  addFinding(
    ctx,
    finding(
      "hanger-refused",
      "warning",
      `The ${kind} mount was not cut`,
      `A ${depthMm.toFixed(2)} mm pocket needs a base of at least ${needed.toFixed(2)} mm; ` +
        `this one is ${ctx.params.base_thickness_mm.toFixed(2)} mm.`,
      "base",
    ),
  );
}

// ---------------------------------------------------------------------------
// The French cleat
// ---------------------------------------------------------------------------

/** The slot's north wall and its opening, in plate mm. */
export function cleatSlotBounds(ctx: BakeContext): {
  y0: number;
  y1: number;
  halfSpan: number;
  depthMm: number;
} {
  const half = ctx.params.plate_mm / 2;
  const centre = T.CLEAT_SLOT_Y_FRACTION * half;
  return {
    y0: centre - T.CLEAT_SLOT_W_MM / 2,
    y1: centre + T.CLEAT_SLOT_W_MM / 2,
    halfSpan: (T.CLEAT_SLOT_SPAN_FRACTION * ctx.params.plate_mm) / 2,
    depthMm: T.CLEAT_SLOT_DEPTH_MM,
  };
}

/**
 * The cleat: an undercut slot in the underside and the wedge that hooks it.
 *
 * The cavity is narrowest at the underside and widens southward as it goes in,
 * by exactly its own depth: a 45 degree overhang, which prints without support
 * and which is the surface the wall-side wedge bears on. Lowering the plate
 * onto a wedge screwed to the wall slides the two 45 faces together.
 */
function buildCleat(ctx: BakeContext, out: HangerGeometry): void {
  const { y0, y1, halfSpan, depthMm } = cleatSlotBounds(ctx);
  if (!undersideFits(ctx, depthMm)) {
    refuse(ctx, "cleat", depthMm);
    return;
  }
  const clearance = T.LOOSE_PART_CLEARANCE_MM;
  const step = depthMm / HANGER_SLABS;

  const cutters: Manifold[] = [];
  const wedge: Manifold[] = [];
  for (let i = 0; i < HANGER_SLABS; i += 1) {
    const z0 = i * step;
    const z1 = (i + 1) * step;
    // The cavity's south edge at this slab: back by however deep the slab is.
    const south = y0 + depthMm - z1;
    const slot = box(
      ctx,
      -halfSpan,
      south,
      halfSpan,
      y1,
      i === 0 ? -CUTTER_OVERSHOOT_MM : z0,
      z1,
    );
    if (slot !== null) cutters.push(slot);
    // The wedge is the same staircase, one clearance inside the cavity on every
    // face - INCLUDING in Z. Its steps are lifted by the clearance so a step of
    // the wedge never lands on the coplanar step of the cavity: measured, that
    // coplanar strip (0.11 mm wide, the full length of the slot) welded the
    // wedge to the plate and the whole model came out as one body
    // (`[V3-P5-F6]`).
    //
    // The wedge does NOT float above the bed: it starts at z = 0, because the
    // slot opens downward onto the build plate and a part hanging 0.2 mm over
    // it would print in mid air. Its underside is coplanar with the plate's,
    // and laterally a clearance away from it, which shares no edge.
    const wz0 = i === 0 ? 0 : z0 + clearance;
    const wz1 = Math.min(z1 + clearance, depthMm - clearance);
    if (wz1 > wz0) {
      const piece = box(
        ctx,
        -halfSpan + clearance,
        south + clearance,
        halfSpan - clearance,
        y1 - clearance,
        wz0,
        wz1,
      );
      if (piece !== null) wedge.push(piece);
    }
  }
  for (const cutter of cutters) out.baseCut.push(cutter);

  const solid = batchedUnion(ctx.wasm, ctx.arena, wedge);
  if (solid === null) return;
  // Two screw clearance holes, on the flat part of the wedge so a countersunk
  // head sits below the 45 face.
  const holes: Contour[] = [-halfSpan / 2, halfSpan / 2].map((x) =>
    circleContour(x, y1 - T.CLEAT_SLOT_W_MM / 3, T.CLEAT_SCREW_D_MM / 2, CIRCLE_SEGMENTS),
  );
  const holeSection = sectionOf(ctx.wasm, ctx.arena, holes);
  const drill = extrudeSection(
    ctx.wasm,
    ctx.arena,
    holeSection,
    -CUTTER_OVERSHOOT_MM,
    depthMm + CUTTER_OVERSHOOT_MM,
  );
  if (holeSection !== null) ctx.arena.drop(holeSection);
  const drilled = drill === null ? solid : subtractSolids(ctx.wasm, ctx.arena, solid, [drill]);
  out.parts.push({ region: "cleat", solid: drilled });
  addFinding(
    ctx,
    finding(
      "loose-part-in-place",
      "info",
      "The cleat wedge prints inside its own slot",
      `The wall-side wedge is a separate body sitting in the slot with ` +
        `${clearance.toFixed(2)} mm of clearance on every face. Slide it out sideways after ` +
        "printing; the slot runs edge to edge so it can leave.",
      "cleat",
    ),
  );
}

// ---------------------------------------------------------------------------
// The easel
// ---------------------------------------------------------------------------

/** Plan of the easel well and its socket, in plate mm. */
export function easelPlan(ctx: BakeContext): {
  legHalfLen: number;
  legHalfWidth: number;
  centreY: number;
  wellDepthMm: number;
} {
  const half = ctx.params.plate_mm / 2;
  return {
    legHalfLen: (T.EASEL_LEG_LEN_FRACTION * ctx.params.plate_mm) / 2,
    legHalfWidth: T.EASEL_LEG_W_MM / 2,
    centreY: -0.45 * half,
    wellDepthMm: T.EASEL_WELL_DEPTH_MM,
  };
}

/**
 * The easel: a flat leg stored in a well in the underside, and the leaning
 * socket its tenon plugs into.
 *
 * The socket is cut at {@link EASEL_LEAN_DEG} from the underside normal, which
 * is what makes the leg PROP the plate instead of standing square under it.
 * That lean is an overhang of 20 degrees from vertical - well inside what
 * prints unsupported - and it is stepped over {@link HANGER_SLABS} slabs like
 * the cleat's undercut.
 */
function buildEasel(ctx: BakeContext, out: HangerGeometry): void {
  const plan = easelPlan(ctx);
  if (!undersideFits(ctx, plan.wellDepthMm)) {
    refuse(ctx, "easel", plan.wellDepthMm);
    return;
  }
  const clearance = T.LOOSE_PART_CLEARANCE_MM;
  const { legHalfLen, legHalfWidth, centreY, wellDepthMm } = plan;
  const legT = T.EASEL_LEG_T_MM;

  // --- the well, and the leg lying in it -------------------------------
  const well = box(
    ctx,
    -legHalfLen - clearance,
    centreY - legHalfWidth - clearance,
    legHalfLen + clearance,
    centreY + legHalfWidth + clearance + T.EASEL_TENON_LEN_MM + clearance,
    -CUTTER_OVERSHOOT_MM,
    wellDepthMm,
  );
  if (well !== null) out.baseCut.push(well);

  const legPieces: Manifold[] = [];
  // On the bed, not floating above it: the well opens downward onto the build
  // plate, so the leg's first layer is laid on the plate like any other part's
  // and the roof of the well bridges over it (`[V3-P5-F6]`).
  const leg = box(
    ctx,
    -legHalfLen,
    centreY - legHalfWidth,
    legHalfLen,
    centreY + legHalfWidth,
    0,
    legT,
  );
  if (leg !== null) legPieces.push(leg);
  // The tenon: the same flat stock, narrower, sticking north out of the leg.
  const tenon = box(
    ctx,
    -T.EASEL_TENON_W_MM / 2,
    centreY + legHalfWidth,
    T.EASEL_TENON_W_MM / 2,
    centreY + legHalfWidth + T.EASEL_TENON_LEN_MM,
    0,
    legT,
  );
  if (tenon !== null) legPieces.push(tenon);

  // --- the leaning socket ----------------------------------------------
  // North of the well, and offset a little further north with depth, so a leg
  // pressed into it stands back from the plate rather than square to it.
  const socketY = centreY + legHalfWidth + T.EASEL_TENON_LEN_MM + 2 * clearance + 3.0;
  const lean = Math.tan((EASEL_LEAN_DEG * Math.PI) / 180);
  const step = wellDepthMm / HANGER_SLABS;
  const socketW = T.EASEL_TENON_W_MM + 2 * clearance;
  const socketT = legT + 2 * clearance;
  for (let i = 0; i < HANGER_SLABS; i += 1) {
    const z0 = i * step;
    const z1 = (i + 1) * step;
    const shift = lean * z1;
    const slab = box(
      ctx,
      -socketW / 2,
      socketY + shift,
      socketW / 2,
      socketY + shift + socketT,
      i === 0 ? -CUTTER_OVERSHOOT_MM : z0,
      z1,
    );
    if (slab !== null) out.baseCut.push(slab);
  }

  const solid = batchedUnion(ctx.wasm, ctx.arena, legPieces);
  if (solid === null) return;
  out.parts.push({ region: "easel", solid });
  addFinding(
    ctx,
    finding(
      "loose-part-in-place",
      "info",
      "The easel leg prints inside its own well",
      `The leg is a separate body lying in a ${wellDepthMm.toFixed(1)} mm well in the ` +
        `underside with ${clearance.toFixed(2)} mm of clearance around it. Lift it out and press its ` +
        `tenon into the socket beside the well to stand the plate at ${EASEL_LEAN_DEG} degrees.`,
      "easel",
    ),
  );
}

/**
 * Every mount that needs a part of its own.
 *
 * `keyhole` and `magnets` are not here: they are pockets and nothing else, and
 * `solid/ornaments.ts` cuts them beside the underside mark.
 */
export function buildHangers(ctx: BakeContext): HangerGeometry {
  const out: HangerGeometry = { baseCut: [], parts: [] };
  const hanger = ctx.params.hanger ?? "none";
  if (hanger === "cleat") buildCleat(ctx, out);
  else if (hanger === "easel") buildEasel(ctx, out);
  return out;
}
