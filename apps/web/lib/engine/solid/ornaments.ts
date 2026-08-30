/**
 * Ornaments: the north arrow, the scale bar, the underside mark and the two
 * hangers.
 *
 * Same contract as `lettering.ts`: the shared layout math decides everything,
 * this module cuts it, and a refusal is a finding plus a resolved line rather
 * than an exception. The minima are the reference implementation's own
 * (`transform.hanger_min_base_mm`, `underside_mark_min_base_mm`): a pocket cut
 * from below needs a millimetre of roof over it, and everything cut from above
 * eats into the same base thickness, so the two are checked together.
 */

import { loadedGlyphFace } from "../../fontGlyphs";
import type { PreviewArea } from "../../preview";
import {
  glyphAreas,
  keyholeArea,
  magnetAreas,
  northArrowArea,
  placeArea,
  scaleBarAreas,
} from "../../previewText";
import * as T from "../../transform";
import type { ResolvedLine } from "../types";
import { placementFor, type SurfaceName } from "./areas";
import { CUTTER_OVERSHOOT_MM, addFinding, finding, type BakeContext } from "./context";
import { lipKeepSection, lipTopMm } from "./frame";
import type { Manifold } from "./manifold";
import { contoursFromAreas, repairText, STROKE_FAIL_FACTOR } from "./lettering";
import { extrudeSection, sectionOf } from "./manifold";

export interface OrnamentGeometry {
  /** Cutters for the frame lip. */
  frameCut: Manifold[];
  /** Cutters for the base, from below. */
  baseCut: Manifold[];
}

/** How far below the base top the deepest surface region reaches, print mm. */
function deepestRecessMm(ctx: BakeContext): number {
  let depth = 0;
  const layers: SurfaceName[] = ["water", "rail", "roads", "parks"];
  for (const layer of layers) {
    depth = Math.max(depth, ctx.baseTopMm - placementFor(ctx, layer).bottomMm);
  }
  return depth;
}

/** The thinnest base a pocket of `depthMm` cut from below can live in. */
function neededBaseMm(ctx: BakeContext, depthMm: number): number {
  return depthMm + T.HANGER_MIN_ROOF_MM + deepestRecessMm(ctx);
}

function line(
  id: string,
  text: string,
  surface: string,
  status: "cuts" | "skipped",
  depthMm: number,
  sizeMm?: number,
  reason?: string,
): ResolvedLine {
  const out: ResolvedLine = { id, text, surface, mode: "engrave", status, depthMm };
  if (sizeMm !== undefined) out.sizeMm = sizeMm;
  if (reason !== undefined) out.reason = reason;
  return out;
}

/**
 * Every ornament this parameter set asks for, as solids.
 *
 * `layout` is the one `lettering.buildLettering` already computed, so the arrow
 * and the bar are never laid out twice and can never disagree.
 */
export function buildOrnaments(
  ctx: BakeContext,
  layout: T.LetteringLayout,
): OrnamentGeometry {
  const { wasm, arena, params } = ctx;
  const out: OrnamentGeometry = { frameCut: [], baseCut: [] };
  const keep = lipKeepSection(ctx);
  const lipTop = lipTopMm(ctx);
  const target = T.text_stroke_target_mm(params, "engrave");

  const engraveLip = (areas: PreviewArea[], what: string, sizeMm: number): boolean => {
    const repaired = repairText(ctx, areas, 0, target, keep);
    if (repaired === null) return false;
    if (repaired.strokeMm < STROKE_FAIL_FACTOR * target) {
      addFinding(
        ctx,
        finding(
          "text-too-small",
          "warning",
          `The ${what} was not cut`,
          `Its narrowest stroke measures ${repaired.strokeMm.toFixed(2)} mm against a ` +
            `${target.toFixed(2)} mm target for a ${params.nozzle_mm} mm nozzle.`,
          "frame",
        ),
      );
      ctx.resolvedText.push(
        line(what, what, "Frame lip", "skipped", T.ENGRAVE_MAX_MM, sizeMm, "the stroke is too narrow to cut"),
      );
      arena.drop(repaired.section);
      return false;
    }
    const solid = extrudeSection(
      wasm,
      arena,
      repaired.section,
      lipTop - T.ENGRAVE_MAX_MM,
      lipTop + CUTTER_OVERSHOOT_MM,
    );
    arena.drop(repaired.section);
    if (solid === null) return false;
    out.frameCut.push(solid);
    ctx.resolvedText.push(line(what, what, "Frame lip", "cuts", T.ENGRAVE_MAX_MM, sizeMm));
    return true;
  };

  // --- north arrow -----------------------------------------------------
  const arrow = layout.north_arrow;
  if (arrow.enabled) {
    engraveLip(
      [placeArea(northArrowArea(arrow.size_mm), arrow.placement)],
      "north arrow",
      arrow.size_mm,
    );
  }

  // --- scale bar -------------------------------------------------------
  const bar = layout.scale_bar;
  if (bar.enabled && bar.bar_mm > 0) {
    const areas: PreviewArea[] = scaleBarAreas(bar).map((area) =>
      placeArea(area, bar.placement),
    );
    if (bar.label_fit !== null && !bar.label_fit.refused) {
      const asset = loadedGlyphFace(bar.label_fit.face);
      if (asset !== null) {
        const dx = bar.bar_mm + T.ORNAMENT_GAP_MM + bar.label_fit.dilation_mm;
        const dy = -(bar.label_fit.ink_top_mm + bar.label_fit.ink_bottom_mm) / 2;
        for (const glyph of glyphAreas(asset, bar.label_fit.text, bar.label_fit.size_mm, 0)) {
          areas.push(placeArea(shift(glyph, dx, dy), bar.placement));
        }
      }
    }
    engraveLip(areas, `scale bar (${bar.label})`, bar.thickness_mm);
  }

  // --- underside mark --------------------------------------------------
  const mark = layout.underside_mark;
  if (mark.enabled && mark.fit !== null) {
    const needed = neededBaseMm(ctx, mark.depth_mm);
    if (mark.fit.refused) {
      ctx.resolvedText.push(
        line("underside-mark", mark.fit.text, "Underside", "skipped", mark.depth_mm, mark.fit.size_mm, mark.fit.reason),
      );
    } else if (needed > params.base_thickness_mm + 1e-9) {
      const reason = `the underside mark needs a base of at least ${needed.toFixed(2)} mm`;
      ctx.resolvedText.push(
        line("underside-mark", mark.fit.text, "Underside", "skipped", mark.depth_mm, mark.fit.size_mm, reason),
      );
      addFinding(
        ctx,
        finding("hanger-refused", "warning", "The underside mark was not cut", reason, "base"),
      );
    } else {
      const asset = loadedGlyphFace(mark.fit.face);
      const areas =
        asset === null
          ? []
          : glyphAreas(asset, mark.fit.text, mark.fit.size_mm, 0).map((area) =>
              placeArea(area, mark.placement),
            );
      const repaired =
        areas.length === 0 ? null : repairText(ctx, areas, mark.fit.dilation_mm, target, null);
      if (repaired !== null && repaired.lostCounters === 0) {
        const solid = extrudeSection(
          wasm,
          arena,
          repaired.section,
          -CUTTER_OVERSHOOT_MM,
          mark.depth_mm,
        );
        if (solid !== null) out.baseCut.push(solid);
        ctx.resolvedText.push(
          line("underside-mark", mark.fit.text, "Underside", "cuts", mark.depth_mm, mark.fit.size_mm),
        );
      } else {
        ctx.resolvedText.push(
          line(
            "underside-mark",
            mark.fit.text,
            "Underside",
            "skipped",
            mark.depth_mm,
            mark.fit.size_mm,
            "widening it to a full minimum wall closed a counter",
          ),
        );
      }
      if (repaired !== null) arena.drop(repaired.section);
    }
  }

  // --- hangers ---------------------------------------------------------
  const hanger = params.hanger ?? "none";
  if (hanger === "keyhole" || hanger === "magnets") {
    const depth = T.underside_pocket_depth_mm(params, hanger);
    const needed = neededBaseMm(ctx, depth);
    if (needed > params.base_thickness_mm + 1e-9) {
      addFinding(
        ctx,
        finding(
          "hanger-refused",
          "warning",
          `The ${hanger} hanger was not cut`,
          `A ${depth.toFixed(2)} mm pocket needs a base of at least ${needed.toFixed(2)} mm; ` +
            `this one is ${params.base_thickness_mm.toFixed(2)} mm.`,
          "base",
        ),
      );
    } else {
      const areas = hanger === "keyhole" ? [keyholeArea(params)] : magnetAreas(params);
      const section = sectionOf(wasm, arena, contoursFromAreas(areas));
      const solid = extrudeSection(wasm, arena, section, -CUTTER_OVERSHOOT_MM, depth);
      if (section !== null) arena.drop(section);
      if (solid !== null) out.baseCut.push(solid);
    }
  } else if (hanger === "cleat" || hanger === "easel") {
    addFinding(
      ctx,
      finding(
        "hanger-refused",
        "warning",
        `The ${hanger} mount was not built`,
        `This engine cuts the keyhole and magnet hangers. The ${hanger} mount is built ` +
          "by the frame and mount work and is not in this bake.",
        "base",
      ),
    );
  }

  if (keep !== null) arena.drop(keep);
  return out;
}

/** Move a flat area by (dx, dy), in its own local frame. */
function shift(area: PreviewArea, dx: number, dy: number): PreviewArea {
  const move = (contour: number[]): number[] => {
    const out = new Array<number>(contour.length);
    for (let i = 0; i < contour.length; i += 2) {
      out[i] = contour[i] + dx;
      out[i + 1] = contour[i + 1] + dy;
    }
    return out;
  };
  return { outer: move(area.outer), holes: area.holes.map(move) };
}
