/**
 * The frame: 04 stage 2.2's 6 mm border lip, and everything `frame_style` does
 * to it (v3 phase 5).
 *
 * The lip is still what it always was - a ring standing on the base top, 6 mm
 * wide and 2 mm tall, with the two rules that predate this phase:
 *
 * * the lip sits ON the base top, so the frame region and the base region touch
 *   over the 6 mm band and share no volume at all;
 * * with `frame` off there is no lip, which is what every edge ornament and
 *   every edge engraving is refused against (`transform.frame_text_available`).
 *
 * What phase 5 adds is the CROSS-SECTION and the neighbourhood:
 *
 * 1. **Profiles.** The section swept around the rectangle is built as a stack
 *    of rings at graduated inset, one `CrossSection` per slab. Offsetting a
 *    ring is what mitres the profile at the corners for free, and it is the
 *    only construction that works for a rounded corner as well as a square one
 *    (a tapered extrusion scales about the origin, which moves the INNER edge
 *    of a ring as much as the outer one). `plain` takes the pre-phase-5 path
 *    unchanged - one extrusion of one ring - so a default bake is byte for byte
 *    what it was.
 * 2. **Corners.** `square` is the sharp rectangle it always was.  `mitred` and
 *    `rounded` come from the JOIN TYPE of an offset by `corner_radius_mm`:
 *    Clipper2's `Square` join cuts the corner off at 45 degrees, which is what
 *    a mitred frame corner looks like, and `Round` radiuses it.
 * 3. **Shadow gap** - a recessed channel between the lip and the city, carved
 *    from the base top, refused when it would breach the base floor.
 * 4. **Matting** - a raised band in its own region between the lip and the
 *    city, which the city crop gives way to (`context.makeContext` shrinks the
 *    crop by `transform.frame_content_inset_mm`).
 * 5. **A separate frame part** - the lip stops being welded to the plate and
 *    becomes its own body, registered by a snap ridge or by magnet pockets.
 * 6. **Face texture** - grooves or dimples in the lip's top face, cleared
 *    around every glyph run the lettering layout placed there.
 *
 * Nothing here throws: a feature that will not fit is refused with a finding
 * carrying the measured numbers, exactly as a refused engraving is.
 */

import * as T from "../../transform";
import type { PreviewArea } from "../../preview";
import { northArrowArea, placeArea, scaleBarAreas } from "../../previewText";
import type { BakeContext } from "./context";
import {
  CIRCLE_SEGMENTS,
  CUTTER_OVERSHOOT_MM,
  MAX_POCKET_FRACTION,
  PART_OVERLAP_MM,
  addFinding,
  finding,
} from "./context";
import type { Contour, CrossSection, Manifold } from "./manifold";
import {
  circleContour,
  extrudeSection,
  intersectSection,
  rectContour,
  sectionOf,
  subtractSection,
  unionSections,
  batchedUnion,
} from "./manifold";

// ---------------------------------------------------------------------------
// The rulings (DECISIONS [V3-P5-F1] .. [V3-P5-F5])
// ---------------------------------------------------------------------------

/** Slabs a curved or sloped profile is approximated with (`[V3-P5-F1]`). */
export const PROFILE_SLABS = 8;

/** Chamfer height as a fraction of the lip height (the brief's 30 per cent). */
export const CHAMFER_FRACTION = 0.3;

/** Stepped profile: the outer tier's height, as a fraction of the lip's. */
export const STEP_HEIGHT_FRACTION = 0.6;

/** Stepped profile: the outer tier's width, as a fraction of the frame's. */
export const STEP_WIDTH_FRACTION = 0.5;

/** Ogee: how far the outer edge travels inward, as a fraction of the width. */
export const OGEE_RUN_FRACTION = 0.4;

/** Floating profile: how much of the inner edge is lifted off the plate, mm. */
export const FLOATING_UNDERCUT_W_MM = 1.0;
export const FLOATING_UNDERCUT_H_MM = 0.4;

/** Snap mount: the ridge on the base perimeter, mm (the brief's 0.8 mm). */
export const SNAP_RIDGE_W_MM = 0.8;
export const SNAP_RIDGE_H_MM = 0.8;

/** Most texture elements (grooves, dimples) one face may carry. */
export const TEXTURE_MAX_ELEMENTS = 2000;

/** Clearance kept between a texture groove and a glyph run, mm. */
export const TEXTURE_TEXT_MARGIN_MM = 1.0;

/** Dimple diameter as a fraction of the `dots` pattern pitch. */
export const DOT_DIAMETER_FRACTION = 0.5;

/** Segments per dimple: a shallow round pit needs no more than a dodecagon. */
export const DOT_SEGMENTS = 12;

// ---------------------------------------------------------------------------
// The resolved style
// ---------------------------------------------------------------------------

export type FrameProfile =
  | "plain"
  | "chamfer"
  | "stepped"
  | "bevel_in"
  | "bullnose"
  | "ogee"
  | "floating";

export type FrameCorner = "square" | "mitred" | "rounded";

export type TexturePattern = "none" | "brush" | "knurl" | "hatch" | "dots";

export interface ShadowGapStyle {
  widthMm: number;
  depthMm: number;
}

export interface MattingStyle {
  widthMm: number;
  proudMm: number;
}

export interface SeparateStyle {
  mount: "snap" | "magnet";
  toleranceMm: number;
}

export interface TextureStyle {
  pattern: TexturePattern;
  scaleMm: number;
  depthMm: number;
}

export interface FrameStyle {
  profile: FrameProfile;
  corner: FrameCorner;
  cornerRadiusMm: number;
  lipDepthMm: number;
  /** The recessed channel, from `shadow_gap` or forced on by `floating`. */
  shadowGap: ShadowGapStyle | null;
  matting: MattingStyle | null;
  separate: SeparateStyle | null;
  texture: TextureStyle;
}

/**
 * `frame_style` with every default resolved, and the two implications the
 * contract leaves to the engine:
 *
 * * a `floating` frame carries a recessed band whether or not `shadow_gap` is
 *   on - that band IS what makes it read as floating - so the profile turns the
 *   gap on with `transform.FLOATING_GAP_MM`/`FLOATING_GAP_DEPTH_MM` when the
 *   user has not asked for one of their own (`[V3-P5-F2]`);
 * * with `frame` off there is no lip, so there is no styling either.
 */
export function frameStyle(params: BakeContext["params"]): FrameStyle {
  const style = params.frame_style;
  const profile = (style?.profile ?? "plain") as FrameProfile;
  const gap =
    style?.shadow_gap?.enabled === true
      ? {
          widthMm: style.shadow_gap.width_mm ?? 1.0,
          depthMm: style.shadow_gap.depth_mm ?? 0.8,
        }
      : profile === "floating"
        ? { widthMm: T.FLOATING_GAP_MM, depthMm: T.FLOATING_GAP_DEPTH_MM }
        : null;
  return {
    profile,
    corner: (style?.corner ?? "square") as FrameCorner,
    cornerRadiusMm: style?.corner_radius_mm ?? 3.0,
    lipDepthMm: style?.lip_depth_mm ?? 0.4,
    shadowGap: gap,
    matting:
      style?.matting?.enabled === true
        ? { widthMm: style.matting.width_mm ?? 6.0, proudMm: style.matting.proud_mm ?? 0.4 }
        : null,
    separate:
      style?.separate?.enabled === true
        ? {
            mount: (style.separate.mount ?? "snap") as "snap" | "magnet",
            toleranceMm: style.separate.tolerance_mm ?? 0.2,
          }
        : null,
    texture: {
      pattern: (style?.texture?.pattern ?? "none") as TexturePattern,
      scaleMm: style?.texture?.scale_mm ?? 1.0,
      depthMm: style?.texture?.depth_mm ?? 0.2,
    },
  };
}

/** True when this bake emits the frame as a body of its own. */
export function frameIsSeparate(ctx: BakeContext): boolean {
  return Boolean(ctx.params.frame) && frameStyle(ctx.params).separate !== null;
}

// ---------------------------------------------------------------------------
// Plan shapes
// ---------------------------------------------------------------------------

/**
 * A square of half-extent `halfMm` with this bake's corner style, print mm.
 *
 * `square` is a plain rectangle - the same four points the pre-phase-5 frame
 * was built from, so a default bake's ring is bit for bit the ring it was.
 * The other two are an offset of the inset rectangle: Clipper2's `Square` join
 * cuts the corner at 45 degrees (a mitre), `Round` radiuses it.
 */
export function cornerSquareSection(
  ctx: BakeContext,
  halfMm: number,
  radiusMm: number,
  corner: FrameCorner,
): CrossSection | null {
  if (!(halfMm > 0)) return null;
  const radius = Math.max(0, Math.min(radiusMm, halfMm * 0.5));
  if (corner === "square" || radius <= 0) {
    return sectionOf(ctx.wasm, ctx.arena, [rectContour(-halfMm, -halfMm, halfMm, halfMm)]);
  }
  const core = sectionOf(ctx.wasm, ctx.arena, [
    rectContour(-(halfMm - radius), -(halfMm - radius), halfMm - radius, halfMm - radius),
  ]);
  if (core === null) return null;
  const grown = core.offset(
    radius,
    corner === "rounded" ? "Round" : "Square",
    2,
    CIRCLE_SEGMENTS,
  );
  ctx.arena.drop(core);
  if (grown.isEmpty()) {
    grown.delete();
    return null;
  }
  return ctx.arena.keep(grown);
}

/**
 * One ring of the swept profile.
 *
 * `outerDeltaMm` moves the outer edge inward, `innerDeltaMm` moves the inner
 * edge outward (widening the opening). Both are the slab's own inset; the
 * corner radius travels with the edge, shrinking on the outside and growing on
 * the inside, which is what keeps a rounded corner concentric all the way up.
 */
export function frameRingAt(
  ctx: BakeContext,
  outerDeltaMm: number,
  innerDeltaMm: number,
): CrossSection | null {
  const frame = T.frame_geometry_mm(ctx.params);
  const style = frameStyle(ctx.params);
  const outerHalf = frame.outer_half_mm - outerDeltaMm;
  const innerHalf = frame.inner_half_mm + innerDeltaMm;
  if (!(outerHalf > innerHalf)) return null;
  if (style.corner === "square") {
    // The pre-phase-5 construction, verbatim: one section, the outer square
    // counter-clockwise and the inner one clockwise.
    const hole = rectContour(-innerHalf, -innerHalf, innerHalf, innerHalf);
    hole.reverse();
    return sectionOf(ctx.wasm, ctx.arena, [
      rectContour(-outerHalf, -outerHalf, outerHalf, outerHalf),
      hole,
    ]);
  }
  const outer = cornerSquareSection(
    ctx,
    outerHalf,
    Math.max(0, style.cornerRadiusMm - outerDeltaMm),
    style.corner,
  );
  if (outer === null) return null;
  const inner = cornerSquareSection(
    ctx,
    innerHalf,
    style.cornerRadiusMm + innerDeltaMm,
    style.corner,
  );
  if (inner === null) return outer;
  const ring = subtractSection(ctx.arena, outer, inner);
  ctx.arena.drop(outer);
  ctx.arena.drop(inner);
  return ring;
}

/** The lip's footprint at the base top: the outer square minus the inner one. */
export function frameRingSection(ctx: BakeContext): CrossSection | null {
  const frame = T.frame_geometry_mm(ctx.params);
  if (!frame.enabled) return null;
  if (!(frame.outer_half_mm > frame.inner_half_mm)) return null;
  return frameRingAt(ctx, 0, 0);
}

// ---------------------------------------------------------------------------
// The profile
// ---------------------------------------------------------------------------

/** One slab of the swept profile: a ring between two Z planes. */
export interface ProfileSlab {
  z0Mm: number;
  z1Mm: number;
  outerDeltaMm: number;
  innerDeltaMm: number;
}

/**
 * The slab stack for this profile, bottom first.
 *
 * `bottomMm` is where the solid starts (inside the plate for a welded frame,
 * on the base top plus its clearance for a separate one) and `baseTopMm` is
 * where the VISIBLE lip starts, which is what every profile measures from: a
 * chamfer 30 per cent down the lip must not move when the plate gets thicker.
 */
export function profileSlabs(
  ctx: BakeContext,
  bottomMm: number,
  baseTopMm: number,
  topMm: number,
): ProfileSlab[] {
  const style = frameStyle(ctx.params);
  const height = topMm - baseTopMm;
  const width = T.FRAME_WIDTH_MM;
  const plain: ProfileSlab[] = [
    { z0Mm: bottomMm, z1Mm: topMm, outerDeltaMm: 0, innerDeltaMm: 0 },
  ];
  if (height <= 0) return plain;

  const ramp = (
    bandBottomMm: number,
    bandTopMm: number,
    slabs: number,
    outer: (t: number) => number,
    inner: (t: number) => number,
  ): ProfileSlab[] => {
    const out: ProfileSlab[] = [];
    if (bandBottomMm > bottomMm) {
      out.push({ z0Mm: bottomMm, z1Mm: bandBottomMm, outerDeltaMm: 0, innerDeltaMm: 0 });
    }
    const step = (bandTopMm - bandBottomMm) / slabs;
    for (let i = 0; i < slabs; i += 1) {
      // The slab is inset by the profile at its TOP, so the stack is inscribed
      // inside the true surface and never proud of it.
      const t = (i + 1) / slabs;
      out.push({
        z0Mm: bandBottomMm + i * step,
        z1Mm: bandBottomMm + (i + 1) * step,
        outerDeltaMm: outer(t),
        innerDeltaMm: inner(t),
      });
    }
    return out;
  };

  switch (style.profile) {
    case "plain":
      return plain;
    case "chamfer": {
      const c = CHAMFER_FRACTION * height;
      return ramp(topMm - c, topMm, PROFILE_SLABS, (t) => t * c, () => 0);
    }
    case "stepped": {
      const stepZ = baseTopMm + STEP_HEIGHT_FRACTION * height;
      return [
        { z0Mm: bottomMm, z1Mm: stepZ, outerDeltaMm: 0, innerDeltaMm: 0 },
        {
          z0Mm: stepZ,
          z1Mm: topMm,
          outerDeltaMm: STEP_WIDTH_FRACTION * width,
          innerDeltaMm: 0,
        },
      ];
    }
    case "bevel_in": {
      const run = Math.min(height, width * 0.6);
      return ramp(baseTopMm, topMm, PROFILE_SLABS, () => 0, (t) => t * run);
    }
    case "bullnose": {
      const r = Math.min(height, width / 2);
      return ramp(
        topMm - r,
        topMm,
        PROFILE_SLABS,
        (t) => r - Math.sqrt(Math.max(0, r * r - (t * r) * (t * r))),
        () => 0,
      );
    }
    case "ogee": {
      const run = OGEE_RUN_FRACTION * width;
      return ramp(
        baseTopMm,
        topMm,
        PROFILE_SLABS,
        (t) => run * (0.5 - 0.5 * Math.cos(Math.PI * t)),
        () => 0,
      );
    }
    case "floating": {
      const lift = Math.min(FLOATING_UNDERCUT_H_MM, height / 2);
      return [
        {
          z0Mm: bottomMm,
          z1Mm: baseTopMm + lift,
          outerDeltaMm: 0,
          innerDeltaMm: FLOATING_UNDERCUT_W_MM,
        },
        { z0Mm: baseTopMm + lift, z1Mm: topMm, outerDeltaMm: 0, innerDeltaMm: 0 },
      ];
    }
  }
}

/** Z the frame solid starts at: inside the plate, or clear of it when separate. */
export function frameBottomMm(ctx: BakeContext): number {
  const frame = T.frame_geometry_mm(ctx.params);
  const style = frameStyle(ctx.params);
  if (style.separate !== null) {
    // A real gap, not a shared face: two bodies that touch on a coincident
    // plane fuse in the union, and then "separate" would mean nothing in a
    // single-object export (`[V3-P5-F4]`).
    return frame.bottom_mm + style.separate.toleranceMm;
  }
  // Down into the plate by `PART_OVERLAP_MM` rather than resting exactly on
  // its top face: the lip is a separate colour part, and two parts that meet
  // on a coincident face leave the slicer to arbitrate the seam and the
  // boolean to leave slivers there (`extrude.frame_lip_part` does the same).
  // The extra is inside the plate, so the welded solid is unchanged.
  return frame.bottom_mm - PART_OVERLAP_MM;
}

/** The lip solid, or null when the frame is off. */
export function buildFrameLip(ctx: BakeContext): Manifold | null {
  const frame = T.frame_geometry_mm(ctx.params);
  if (!frame.enabled) return null;
  const style = frameStyle(ctx.params);
  const bottom = frameBottomMm(ctx);
  if (style.profile === "plain" && style.corner === "square") {
    // The pre-phase-5 path, untouched: one ring, one extrusion.
    const ring = frameRingSection(ctx);
    if (ring === null) return null;
    const solid = extrudeSection(ctx.wasm, ctx.arena, ring, bottom, frame.top_mm);
    ctx.arena.drop(ring);
    return solid;
  }
  const slabs = profileSlabs(ctx, bottom, frame.bottom_mm, frame.top_mm);
  const pieces: Manifold[] = [];
  for (const slab of slabs) {
    if (!(slab.z1Mm > slab.z0Mm)) continue;
    const ring = frameRingAt(ctx, slab.outerDeltaMm, slab.innerDeltaMm);
    if (ring === null) continue;
    const solid = extrudeSection(ctx.wasm, ctx.arena, ring, slab.z0Mm, slab.z1Mm);
    ctx.arena.drop(ring);
    if (solid !== null) pieces.push(solid);
  }
  return batchedUnion(ctx.wasm, ctx.arena, pieces);
}

/**
 * The lip's flat TOP face in plan: the topmost slab's ring.
 *
 * Everything that lands on the lip - text, ornaments, texture - is clipped to
 * this, so a chamfered or stepped profile carries its ink on the material that
 * is actually there rather than over the void the profile cut away.
 */
export function frameTopFaceSection(ctx: BakeContext): CrossSection | null {
  const frame = T.frame_geometry_mm(ctx.params);
  if (!frame.enabled) return null;
  const slabs = profileSlabs(ctx, frameBottomMm(ctx), frame.bottom_mm, frame.top_mm);
  const top = slabs[slabs.length - 1];
  if (top === undefined) return frameRingSection(ctx);
  return frameRingAt(ctx, top.outerDeltaMm, top.innerDeltaMm);
}

/** Width of the flat top face, mm: what a line of text has to fit inside. */
export function topFaceWidthMm(ctx: BakeContext): number {
  const frame = T.frame_geometry_mm(ctx.params);
  const slabs = profileSlabs(ctx, frameBottomMm(ctx), frame.bottom_mm, frame.top_mm);
  const top = slabs[slabs.length - 1];
  if (top === undefined) return frame.width_mm;
  return Math.max(0, frame.width_mm - top.outerDeltaMm - top.innerDeltaMm);
}

/**
 * Where ink may land on the lip: the top face inset by the text margin.
 *
 * `lettering.lip_keep_region`, verbatim, with the profile's own top face in
 * place of the full 6 mm band. The layout still sizes text to the full band
 * (`transform.edge_band_mm` knows nothing about profiles), so a profile that
 * eats into the band is REPORTED - see {@link reportNarrowTextBand} - and the
 * clip is what stops the ink hanging over the chamfer.
 */
export function lipKeepSection(ctx: BakeContext): CrossSection | null {
  const face = frameTopFaceSection(ctx);
  if (face === null) return null;
  const margin = T.lip_text_margin_mm(ctx.params);
  const inset = face.offset(-margin, "Miter", 2, 0);
  ctx.arena.drop(face);
  if (inset.isEmpty()) {
    inset.delete();
    return null;
  }
  return ctx.arena.keep(inset);
}

/** Z of the lip's top face, mm. Everything on the frame is measured from it. */
export function lipTopMm(ctx: BakeContext): number {
  return T.frame_geometry_mm(ctx.params).top_mm;
}

/**
 * Say so when the profile leaves less flat top than the layout laid text on.
 *
 * The shared layout fits text to the full 6 mm band because that is what the
 * preview draws and what the reference implementation cuts; a stepped or
 * bullnose profile leaves less. The ink is clipped to what is there, so the
 * model is still sound - but a clipped letter is exactly the kind of thing a
 * user must be told about rather than discover on the plate.
 */
export function reportNarrowTextBand(ctx: BakeContext, hasEdgeText: boolean): void {
  if (!hasEdgeText) return;
  const face = topFaceWidthMm(ctx);
  if (face >= T.FRAME_WIDTH_MM - 1e-9) return;
  const band = T.edge_band_mm(ctx.params);
  const keep = face - 2 * T.lip_text_margin_mm(ctx.params);
  if (keep >= band - 1e-9) return;
  const style = frameStyle(ctx.params);
  addFinding(
    ctx,
    finding(
      "frame-text-band-narrowed",
      "warning",
      "The frame profile narrows the band text sits in",
      `The ${style.profile} profile leaves ${face.toFixed(2)} mm of flat top face, so ink has ` +
        `${keep.toFixed(2)} mm to sit in against the ${band.toFixed(2)} mm the layout used. ` +
        "Anything wider than that is clipped to the face. Use the plain profile, or a " +
        "smaller size for the lines on the frame.",
      "frame",
    ),
  );
}

// ---------------------------------------------------------------------------
// Shadow gap, matting
// ---------------------------------------------------------------------------

/** A band between two half-extents, with this bake's corner style. */
function bandSection(
  ctx: BakeContext,
  outerHalfMm: number,
  innerHalfMm: number,
): CrossSection | null {
  if (!(outerHalfMm > innerHalfMm) || !(innerHalfMm > 0)) return null;
  const style = frameStyle(ctx.params);
  const frame = T.frame_geometry_mm(ctx.params);
  // The radius follows the edge in from the frame opening, so the channel and
  // the matting stay concentric with a rounded frame.
  const outerR = style.cornerRadiusMm + (frame.inner_half_mm - outerHalfMm);
  const innerR = style.cornerRadiusMm + (frame.inner_half_mm - innerHalfMm);
  const outer = cornerSquareSection(ctx, outerHalfMm, Math.max(0, outerR), style.corner);
  if (outer === null) return null;
  const inner = cornerSquareSection(ctx, innerHalfMm, Math.max(0, innerR), style.corner);
  if (inner === null) return outer;
  const band = subtractSection(ctx.arena, outer, inner);
  ctx.arena.drop(outer);
  ctx.arena.drop(inner);
  return band;
}

/** Half-extent of the inner edge of the shadow-gap channel, mm. */
export function shadowGapInnerHalfMm(ctx: BakeContext): number {
  const frame = T.frame_geometry_mm(ctx.params);
  const gap = frameStyle(ctx.params).shadowGap;
  return gap === null ? frame.inner_half_mm : frame.inner_half_mm - gap.widthMm;
}

/**
 * The recessed channel between the lip and the city, as a cutter.
 *
 * Refused - with the numbers - when it would eat past the base floor the whole
 * pipeline shares (`context.MAX_POCKET_FRACTION`, the same guard a surface
 * region's placement is clamped by): a channel deeper than half the plate
 * leaves less than a floor under it, and a channel through the plate is a slot.
 */
export function buildShadowGap(ctx: BakeContext): Manifold | null {
  const style = frameStyle(ctx.params);
  const gap = style.shadowGap;
  if (gap === null || !ctx.params.frame) return null;
  const floorMm = ctx.baseTopMm * (1 - MAX_POCKET_FRACTION);
  if (ctx.baseTopMm - gap.depthMm < floorMm - 1e-9) {
    addFinding(
      ctx,
      finding(
        "frame-feature-refused",
        "warning",
        "The shadow gap was not cut",
        `A ${gap.depthMm.toFixed(2)} mm channel would leave ` +
          `${(ctx.baseTopMm - gap.depthMm).toFixed(2)} mm of plate under it, against a ` +
          `${floorMm.toFixed(2)} mm floor for a ${ctx.baseTopMm.toFixed(2)} mm base. Use a ` +
          "thicker base, or a shallower gap.",
        "base",
      ),
    );
    return null;
  }
  const frame = T.frame_geometry_mm(ctx.params);
  const band = bandSection(ctx, frame.inner_half_mm, shadowGapInnerHalfMm(ctx));
  if (band === null) return null;
  const cutter = extrudeSection(
    ctx.wasm,
    ctx.arena,
    band,
    ctx.baseTopMm - gap.depthMm,
    ctx.baseTopMm + CUTTER_OVERSHOOT_MM,
  );
  ctx.arena.drop(band);
  return cutter;
}

/**
 * The matting band, a region of its own.
 *
 * It stands `proud_mm` above the base top between the channel (or the lip) and
 * the city, and reaches `PART_OVERLAP_MM` into the plate below it so the two
 * bodies interpenetrate at the seam like every other pair.
 */
export function buildMatting(ctx: BakeContext): Manifold | null {
  const style = frameStyle(ctx.params);
  const matting = style.matting;
  if (matting === null || !ctx.params.frame) return null;
  const outerHalf = shadowGapInnerHalfMm(ctx);
  const innerHalf = outerHalf - matting.widthMm;
  const band = bandSection(ctx, outerHalf, innerHalf);
  if (band === null) {
    addFinding(
      ctx,
      finding(
        "frame-feature-refused",
        "warning",
        "The matting was not built",
        `A ${matting.widthMm.toFixed(1)} mm border leaves no city inside it on a ` +
          `${ctx.params.plate_mm} mm plate. Use a narrower border, or a bigger plate.`,
        "matting",
      ),
    );
    return null;
  }
  const solid = extrudeSection(
    ctx.wasm,
    ctx.arena,
    band,
    ctx.baseTopMm - PART_OVERLAP_MM,
    ctx.baseTopMm + Math.max(matting.proudMm, PART_OVERLAP_MM),
  );
  ctx.arena.drop(band);
  return solid;
}

// ---------------------------------------------------------------------------
// The separate frame part
// ---------------------------------------------------------------------------

export interface FrameMating {
  /** Material added to the BASE (the snap ridge). */
  baseAdd: Manifold[];
  /** Cutters for the base (magnet pockets). */
  baseCut: Manifold[];
  /** Cutters for the FRAME (the snap groove, magnet pockets). */
  frameCut: Manifold[];
}

/** Centres of the magnet pockets that register a separate frame, plate mm. */
export function frameMagnetCentresMm(ctx: BakeContext): Array<[number, number]> {
  const frame = T.frame_geometry_mm(ctx.params);
  const mid = (frame.outer_half_mm + frame.inner_half_mm) / 2;
  const perSide = Math.max(1, Math.round(ctx.params.hanger_magnet?.count ?? 2));
  const span = 2 * frame.inner_half_mm;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < perSide; i += 1) {
    // Evenly spaced along the clear run of each side, never in a corner.
    const u = -span / 2 + (span * (i + 1)) / (perSide + 1);
    out.push([u, mid], [u, -mid], [mid, u], [-mid, u]);
  }
  return out;
}

/**
 * The mating features between a separate frame and the plate.
 *
 * `snap`: a continuous ridge on the base perimeter, under the middle of the
 * frame band, and the matching groove in the frame underside, grown by the
 * tolerance on every flank and at the tip.
 *
 * `magnet`: paired pockets, `hanger_magnet.count` per SIDE (`[V3-P5-F4]`),
 * each half the magnet's thickness deep so one magnet spans the joint - which
 * is the only way a 2 mm magnet fits between a 2 mm lip and a 3 mm plate with
 * a millimetre of roof left in each.
 */
export function buildFrameMating(ctx: BakeContext): FrameMating {
  const out: FrameMating = { baseAdd: [], baseCut: [], frameCut: [] };
  const style = frameStyle(ctx.params);
  const separate = style.separate;
  if (separate === null || !ctx.params.frame) return out;
  const frame = T.frame_geometry_mm(ctx.params);
  const tol = separate.toleranceMm;
  const frameBottom = frameBottomMm(ctx);

  if (separate.mount === "snap") {
    const mid = (frame.outer_half_mm + frame.inner_half_mm) / 2;
    const ridge = bandSection(ctx, mid + SNAP_RIDGE_W_MM / 2, mid - SNAP_RIDGE_W_MM / 2);
    if (ridge !== null) {
      const solid = extrudeSection(
        ctx.wasm,
        ctx.arena,
        ridge,
        ctx.baseTopMm - PART_OVERLAP_MM,
        ctx.baseTopMm + SNAP_RIDGE_H_MM,
      );
      ctx.arena.drop(ridge);
      if (solid !== null) out.baseAdd.push(solid);
    }
    const groove = bandSection(
      ctx,
      mid + SNAP_RIDGE_W_MM / 2 + tol,
      mid - SNAP_RIDGE_W_MM / 2 - tol,
    );
    if (groove !== null) {
      const cutter = extrudeSection(
        ctx.wasm,
        ctx.arena,
        groove,
        frameBottom - CUTTER_OVERSHOOT_MM,
        ctx.baseTopMm + SNAP_RIDGE_H_MM + tol,
      );
      ctx.arena.drop(groove);
      if (cutter !== null) out.frameCut.push(cutter);
    }
    return out;
  }

  // --- magnets ---------------------------------------------------------
  const magnet = ctx.params.hanger_magnet;
  const diameter = magnet?.diameter_mm ?? 6.0;
  const thickness = magnet?.thickness_mm ?? 2.0;
  const half = thickness / 2;
  const lipHeight = frame.top_mm - frame.bottom_mm;
  const baseRoom = ctx.baseTopMm - T.deepest_recess_mm(ctx.params);
  const frameOk = half + T.HANGER_MIN_ROOF_MM <= lipHeight + 1e-9;
  const baseOk = half + T.HANGER_MIN_ROOF_MM <= baseRoom + 1e-9;
  // A pocket wider than the band it is cut in takes both walls of the frame
  // with it. Measured on a 6 mm magnet in a 6 mm frame: the pocket broke
  // through the lip's inner and outer faces and left 0.11 mm slivers between
  // the pockets and the edge, which the reference validator failed on. The
  // limit is the band minus a full minimum wall on each side, and a magnet
  // over it is REFUSED rather than quietly shrunk: a pocket that no longer
  // fits the user's magnet is not a fix (`[V3-P5-F4]`).
  const widest = T.FRAME_WIDTH_MM - 2 * T.min_wall_mm(ctx.params) - tol;
  if (diameter > widest + 1e-9) {
    addFinding(
      ctx,
      finding(
        "frame-feature-refused",
        "warning",
        "The magnet mount was not cut",
        `A ${diameter.toFixed(1)} mm magnet does not fit a ${T.FRAME_WIDTH_MM.toFixed(0)} mm ` +
          `frame: with ${T.min_wall_mm(ctx.params).toFixed(2)} mm of wall each side and ` +
          `${tol.toFixed(2)} mm of clearance the pocket may be ${Math.max(0, widest).toFixed(2)} mm ` +
          "across at most. Use a smaller magnet, or the snap mount.",
        "frame",
      ),
    );
    return out;
  }
  if (!frameOk || !baseOk) {
    addFinding(
      ctx,
      finding(
        "frame-feature-refused",
        "warning",
        "The magnet mount was not cut",
        `Half of a ${thickness.toFixed(1)} mm magnet needs ${(half + T.HANGER_MIN_ROOF_MM).toFixed(2)} mm ` +
          `of material with its roof; the lip has ${lipHeight.toFixed(2)} mm and the plate ` +
          `${baseRoom.toFixed(2)} mm clear. Use a thinner magnet, or a thicker base.`,
        "frame",
      ),
    );
    return out;
  }
  const contours: Contour[] = frameMagnetCentresMm(ctx).map(([x, y]) =>
    circleContour(x, y, (diameter + tol) / 2, CIRCLE_SEGMENTS),
  );
  const pockets = sectionOf(ctx.wasm, ctx.arena, contours);
  if (pockets === null) return out;
  const inBase = extrudeSection(
    ctx.wasm,
    ctx.arena,
    pockets,
    ctx.baseTopMm - half,
    ctx.baseTopMm + CUTTER_OVERSHOOT_MM,
  );
  if (inBase !== null) out.baseCut.push(inBase);
  const inFrame = extrudeSection(
    ctx.wasm,
    ctx.arena,
    pockets,
    frameBottom - CUTTER_OVERSHOOT_MM,
    frameBottom + half,
  );
  if (inFrame !== null) out.frameCut.push(inFrame);
  ctx.arena.drop(pockets);
  return out;
}

// ---------------------------------------------------------------------------
// Face texture
// ---------------------------------------------------------------------------

/**
 * The plan boxes the lettering layout has already claimed on the lip.
 *
 * Texture gives way to text: the grooves are cleared for
 * {@link TEXTURE_TEXT_MARGIN_MM} around every glyph run, the north arrow and
 * the scale bar, so a groove never runs through a letter. The boxes come from
 * the SHARED layout (`transform.lettering_layout`), which is the same source
 * `solid/lettering.ts` cuts from, so the two cannot disagree about where the
 * ink is (`[V3-P5-F5]`).
 */
export function letteringKeepOut(
  ctx: BakeContext,
  layout: T.LetteringLayout,
  marginMm: number,
): Contour[] {
  const out: Contour[] = [];
  const boxAt = (
    placement: T.Placement,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): void => {
    const theta = (placement.rotation_deg * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const sx = placement.mirror_x ? -1 : 1;
    const corners: Array<[number, number]> = [
      [x0 - marginMm, y0 - marginMm],
      [x1 + marginMm, y0 - marginMm],
      [x1 + marginMm, y1 + marginMm],
      [x0 - marginMm, y1 + marginMm],
    ];
    const ring = corners.map(([x, y]): [number, number] => {
      const lx = x * sx;
      return [
        cos * lx - sin * y + placement.anchor_x,
        sin * lx + cos * y + placement.anchor_y,
      ];
    });
    // Mirroring reverses the winding; the fill rule wants it positive.
    if (placement.mirror_x) ring.reverse();
    out.push(ring);
  };

  for (const entry of layout.engravings) {
    if (entry.fit.refused || entry.fit.text.trim() === "") continue;
    const fit = entry.fit;
    boxAt(
      entry.placement,
      -fit.dilation_mm,
      fit.ink_bottom_mm - fit.dilation_mm,
      fit.width_mm - fit.dilation_mm,
      fit.ink_top_mm + fit.dilation_mm,
    );
  }
  const arrow = layout.north_arrow;
  if (arrow.enabled) {
    const area = northArrowArea(arrow.size_mm);
    boundsOf([placeArea(area, arrow.placement)], marginMm, out);
  }
  const bar = layout.scale_bar;
  if (bar.enabled && bar.bar_mm > 0) {
    const areas = scaleBarAreas(bar).map((area) => placeArea(area, bar.placement));
    boundsOf(areas, marginMm, out);
    if (bar.label_fit !== null && !bar.label_fit.refused) {
      const fit = bar.label_fit;
      const dx = bar.bar_mm + T.ORNAMENT_GAP_MM + fit.dilation_mm;
      const dy = -(fit.ink_top_mm + fit.ink_bottom_mm) / 2;
      boxAt(
        bar.placement,
        dx - fit.dilation_mm,
        dy + fit.ink_bottom_mm - fit.dilation_mm,
        dx + fit.width_mm - fit.dilation_mm,
        dy + fit.ink_top_mm + fit.dilation_mm,
      );
    }
  }
  return out;
}

/** The axis-aligned box of `areas`, grown by `marginMm`, appended to `out`. */
function boundsOf(areas: readonly PreviewArea[], marginMm: number, out: Contour[]): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const area of areas) {
    for (let i = 0; i + 1 < area.outer.length; i += 2) {
      minX = Math.min(minX, area.outer[i]);
      maxX = Math.max(maxX, area.outer[i]);
      minY = Math.min(minY, area.outer[i + 1]);
      maxY = Math.max(maxY, area.outer[i + 1]);
    }
  }
  if (!Number.isFinite(minX)) return;
  out.push(
    rectContour(minX - marginMm, minY - marginMm, maxX + marginMm, maxY + marginMm),
  );
}

/** One rectangle of a groove, as a contour, rotated by `angleDeg` about origin. */
function grooveContour(
  cx: number,
  cy: number,
  lengthMm: number,
  widthMm: number,
  angleDeg: number,
): Contour {
  const theta = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const hx = lengthMm / 2;
  const hy = widthMm / 2;
  return ([
    [-hx, -hy],
    [hx, -hy],
    [hx, hy],
    [-hx, hy],
  ] as Array<[number, number]>).map(([x, y]): [number, number] => [
    cx + cos * x - sin * y,
    cy + sin * x + cos * y,
  ]);
}

/**
 * The texture cutter for the lip's top face, or null.
 *
 * Every pattern is a set of grooves one nozzle wide (`min_detail_mm`, the
 * narrowest thing this nozzle can lay) or a grid of dimples, `scale_mm` apart
 * and `depth_mm` deep, clipped to the flat top face and cleared around the
 * lettering. Beyond {@link TEXTURE_MAX_ELEMENTS} elements the pattern is
 * dropped with a finding rather than spending a minute of boolean time on
 * something a printer cannot resolve.
 *
 * Each DIRECTION is built and clipped to the face on its own before the two are
 * unioned (`[V3-P5-F5]`). Parallel grooves never cross, so one direction is a
 * union of disjoint rectangles, which Clipper2 does in linear time; the crossed
 * pattern is then formed from two sets that have already been cut down to the
 * 6 mm band. Building all of them at once instead asks the kernel to resolve
 * every crossing over the whole plate - 318 x 318 of them at a 0.8 mm pitch,
 * which is what took the WASM heap out of bounds.
 */
export function buildFrameTexture(
  ctx: BakeContext,
  layout: T.LetteringLayout,
): Manifold | null {
  const style = frameStyle(ctx.params);
  const pattern = style.texture.pattern;
  if (pattern === "none" || !ctx.params.frame) return null;
  const face = frameTopFaceSection(ctx);
  if (face === null) return null;

  const frame = T.frame_geometry_mm(ctx.params);
  const outer = frame.outer_half_mm;
  // Never finer than two nozzles: a groove one nozzle wide at a one nozzle
  // pitch is not a texture, it is a missing top face.
  const pitch = Math.max(style.texture.scaleMm, 2 * T.min_detail_mm(ctx.params));
  const grooveW = T.min_detail_mm(ctx.params);
  const span = 2 * outer;
  const diagonal = span * Math.SQRT2;

  /** Contours for one set of parallel grooves at `angleDeg`. */
  const rails = (angleDeg: number): Contour[] => {
    const out: Contour[] = [];
    const count = Math.floor(diagonal / pitch);
    const theta = (angleDeg * Math.PI) / 180;
    for (let i = 0; i <= count; i += 1) {
      const offset = -diagonal / 2 + i * pitch;
      // Step perpendicular to the groove direction.
      out.push(
        grooveContour(
          -Math.sin(theta) * offset,
          Math.cos(theta) * offset,
          diagonal,
          grooveW,
          angleDeg,
        ),
      );
    }
    return out;
  };

  // One entry per direction: its grooves, and the part of the face they own
  // (all of it, except for `brush`, where each rail is mitred at 45 degrees
  // into its own quarter, exactly as a real frame is cut).
  const directions: Array<{ contours: Contour[]; mask: CrossSection | null }> = [];
  let elements = 0;
  if (pattern === "brush") {
    const masks = brushMitres(ctx, outer);
    directions.push({ contours: rails(0), mask: masks.horizontal });
    directions.push({ contours: rails(90), mask: masks.vertical });
  } else if (pattern === "knurl") {
    directions.push({ contours: rails(45), mask: null });
    directions.push({ contours: rails(-45), mask: null });
  } else if (pattern === "hatch") {
    directions.push({ contours: rails(45), mask: null });
  } else {
    const count = Math.floor(span / pitch);
    const r = (DOT_DIAMETER_FRACTION * pitch) / 2;
    // The grid is laid over the whole plate so the dots line up with the plate
    // centre whatever the frame width, but only the ones that can land ON the
    // band are built: a full-plate grid at a fine pitch is thousands of circles
    // the clip would throw away, which is thousands of operations spent on
    // nothing (measured: 8281 built against 1000 that survive).
    const keepFrom = frame.inner_half_mm - pitch;
    const dots: Contour[] = [];
    for (let i = 0; i <= count; i += 1) {
      for (let j = 0; j <= count; j += 1) {
        const x = -outer + i * pitch;
        const y = -outer + j * pitch;
        if (Math.max(Math.abs(x), Math.abs(y)) < keepFrom) continue;
        dots.push(circleContour(x, y, r, DOT_SEGMENTS));
      }
    }
    directions.push({ contours: dots, mask: null });
  }
  for (const direction of directions) elements += direction.contours.length;

  if (elements > TEXTURE_MAX_ELEMENTS) {
    for (const direction of directions) {
      if (direction.mask !== null) ctx.arena.drop(direction.mask);
    }
    ctx.arena.drop(face);
    addFinding(
      ctx,
      finding(
        "frame-feature-refused",
        "warning",
        "The frame texture was not cut",
        `A ${style.texture.scaleMm.toFixed(2)} mm pitch needs ${elements} elements on this ` +
          `plate, against a ${TEXTURE_MAX_ELEMENTS} cap. Use a coarser pitch.`,
        "frame",
      ),
    );
    return null;
  }

  const clipped: CrossSection[] = [];
  for (const direction of directions) {
    const raw = sectionOf(ctx.wasm, ctx.arena, direction.contours);
    const mask = direction.mask === null ? face : direction.mask;
    if (raw !== null) {
      const keep = intersectSection(ctx.arena, raw, mask);
      ctx.arena.drop(raw);
      if (keep !== null) clipped.push(keep);
    }
    if (direction.mask !== null) ctx.arena.drop(direction.mask);
  }
  ctx.arena.drop(face);
  const joined = unionSections(ctx.wasm, ctx.arena, clipped);
  for (const piece of clipped) {
    if (piece !== joined) ctx.arena.drop(piece);
  }
  if (joined === null) return null;

  // Texture gives way to text.
  let section: CrossSection | null = joined;
  const boxes = letteringKeepOut(ctx, layout, TEXTURE_TEXT_MARGIN_MM);
  if (boxes.length > 0) {
    const ink = sectionOf(ctx.wasm, ctx.arena, boxes);
    if (ink !== null) {
      section = subtractSection(ctx.arena, joined, ink);
      ctx.arena.drop(ink);
      if (section !== joined) ctx.arena.drop(joined);
    }
  }
  if (section === null) return null;
  const top = lipTopMm(ctx);
  const cutter = extrudeSection(
    ctx.wasm,
    ctx.arena,
    section,
    top - style.texture.depthMm,
    top + CUTTER_OVERSHOOT_MM,
  );
  ctx.arena.drop(section);
  return cutter;
}

/**
 * The two mitred halves of the face, for the `brush` pattern.
 *
 * The horizontal grooves belong to the north and south rails, the vertical ones
 * to the east and west, and the boundary between them is the diagonal of the
 * square - which is the mitre a real frame is cut on. Each mask is already
 * intersected with the face, so a rail's grooves are clipped once.
 */
function brushMitres(
  ctx: BakeContext,
  outerMm: number,
): { horizontal: CrossSection | null; vertical: CrossSection | null } {
  const o = outerMm;
  const face = frameTopFaceSection(ctx);
  const quarters = (contours: Contour[]): CrossSection | null => {
    const wedge = sectionOf(ctx.wasm, ctx.arena, contours);
    if (wedge === null || face === null) return null;
    const keep = intersectSection(ctx.arena, wedge, face);
    ctx.arena.drop(wedge);
    return keep;
  };
  const horizontal = quarters([
    [
      [-o, o],
      [o, o],
      [0, 0],
    ],
    [
      [-o, -o],
      [0, 0],
      [o, -o],
    ],
  ]);
  const vertical = quarters([
    [
      [o, o],
      [o, -o],
      [0, 0],
    ],
    [
      [-o, o],
      [0, 0],
      [-o, -o],
    ],
  ]);
  if (face !== null) ctx.arena.drop(face);
  return { horizontal, vertical };
}

/**
 * Report the frame styling this engine does not build.
 *
 * Phase 5 builds all of it, so this is now only ever about a value the schema
 * grew after the engine did. Kept as the one place a "you asked for X and did
 * not get it" sentence is worded.
 */
export function reportUnbuiltFrameStyle(ctx: BakeContext): void {
  const style = ctx.params.frame_style;
  if (style === undefined) return;
  if (!ctx.params.frame) {
    const asked =
      (style.profile ?? "plain") !== "plain" ||
      style.shadow_gap?.enabled === true ||
      style.matting?.enabled === true ||
      style.separate?.enabled === true ||
      (style.texture?.pattern ?? "none") !== "none";
    if (!asked) return;
    addFinding(
      ctx,
      finding(
        "frame-style-unbuilt",
        "warning",
        "Frame styling needs the frame",
        "The frame is switched off, so there is no lip to profile, no inner edge to " +
          "shadow and nothing to texture. Switch the frame on, or clear the styling.",
        "frame",
      ),
    );
  }
}
