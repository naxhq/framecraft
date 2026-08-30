/**
 * The frame: 04 stage 2.2's 6 mm border lip rising 2 mm above the base top.
 *
 * Only the plain profile is built here. `frame_style.profile` and its
 * companions (shadow gap, matting, separate frame part, face textures) are the
 * frame phase's work; this module carries the geometry every profile starts
 * from and the two rules that already exist:
 *
 * * the lip sits ON the base top, so the frame region and the base region touch
 *   over the 6 mm band and share no volume at all;
 * * with `frame` off there is no lip, which is what every edge ornament and
 *   every edge engraving is refused against (`transform.frame_text_available`).
 */

import * as T from "../../transform";
import type { BakeContext } from "./context";
import { PART_OVERLAP_MM, addFinding, finding } from "./context";
import type { CrossSection, Manifold } from "./manifold";
import { extrudeSection, rectContour, sectionOf } from "./manifold";

/** The lip's footprint: the outer square minus the inner one. */
export function frameRingSection(ctx: BakeContext): CrossSection | null {
  const frame = T.frame_geometry_mm(ctx.params);
  if (!frame.enabled) return null;
  const outer = frame.outer_half_mm;
  const inner = frame.inner_half_mm;
  if (!(outer > inner)) return null;
  // Positive fill: the outer square counter-clockwise, the inner one clockwise.
  const hole = rectContour(-inner, -inner, inner, inner);
  hole.reverse();
  return sectionOf(ctx.wasm, ctx.arena, [rectContour(-outer, -outer, outer, outer), hole]);
}

/** The lip solid, or null when the frame is off. */
export function buildFrameLip(ctx: BakeContext): Manifold | null {
  const frame = T.frame_geometry_mm(ctx.params);
  if (!frame.enabled) return null;
  const ring = frameRingSection(ctx);
  if (ring === null) return null;
  // Down into the plate by `PART_OVERLAP_MM` rather than resting exactly on
  // its top face: the lip is a separate colour part, and two parts that meet
  // on a coincident face leave the slicer to arbitrate the seam and the
  // boolean to leave slivers there (`extrude.frame_lip_part` does the same).
  // The extra is inside the plate, so the welded solid is unchanged.
  const solid = extrudeSection(
    ctx.wasm,
    ctx.arena,
    ring,
    frame.bottom_mm - PART_OVERLAP_MM,
    frame.top_mm,
  );
  ctx.arena.drop(ring);
  return solid;
}

/**
 * Where ink may land on the lip: the band inset by the text margin.
 *
 * `lettering.lip_keep_region`, verbatim. Everything placed on the lip is
 * clipped to this ring, which is what guarantees the rim between the ink and
 * each edge of the lip is exactly the margin and never a hairline. The layout
 * already sizes text to fit inside it; the clip exists because the dilation can
 * grow a terminal after the size was chosen.
 */
export function lipKeepSection(ctx: BakeContext): CrossSection | null {
  const ring = frameRingSection(ctx);
  if (ring === null) return null;
  const margin = T.lip_text_margin_mm(ctx.params);
  const inset = ring.offset(-margin, "Miter", 2, 0);
  ctx.arena.drop(ring);
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
 * Report the frame profiles this engine does not build yet.
 *
 * A profile the user selected and did not get is a visible difference between
 * the panel and the plate, so it is said out loud rather than ignored.
 */
export function reportUnbuiltFrameStyle(ctx: BakeContext): void {
  const style = ctx.params.frame_style;
  if (style === undefined) return;
  const asked: string[] = [];
  if ((style.profile ?? "plain") !== "plain") asked.push(`the ${style.profile} profile`);
  if ((style.corner ?? "square") !== "square") asked.push(`${style.corner} corners`);
  if (style.shadow_gap?.enabled) asked.push("the shadow gap");
  if (style.matting?.enabled) asked.push("matting");
  if (style.separate?.enabled) asked.push("a separate frame part");
  if ((style.texture?.pattern ?? "none") !== "none") asked.push("a face texture");
  if (asked.length === 0) return;
  addFinding(
    ctx,
    finding(
      "frame-style-unbuilt",
      "warning",
      "Frame styling was not applied",
      `This bake built the plain 6 mm lip. ${asked.join(", ")} ` +
        `${asked.length === 1 ? "is" : "are"} not built by the engine yet.`,
      "frame",
    ),
  );
}
