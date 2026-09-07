/**
 * Frame lettering: engrave, emboss and inlay.
 *
 * Every size, anchor, rotation and refusal comes from
 * `transform.lettering_layout`, the shared function the preview draws from and
 * the reference build cuts from. This module turns those numbers into solids and
 * decides nothing about where anything goes. The glyph outlines are the
 * committed assets in `lib/fonts/*.glyphs.json`, read through
 * `lib/previewText.ts`'s `glyphAreas`, so the letterforms the editor draws and
 * the letterforms the engine cuts are the same points.
 *
 * Three differences from `services/bake/app/geom/lettering.py`, all recorded in
 * DECISIONS `[V3-P2-E2]`:
 *
 * * the dilation is a real Clipper2 offset with ROUND joins (the reference uses
 *   shapely for the same reason: a mitre offset puts a spike on every vertex of
 *   a curve and turns a smooth counter into a jagged one);
 * * `inlay` is a v3 mode the reference does not have: it cuts the same pocket
 *   an engraving would and fills it with a solid in the `lettering` region, so
 *   the letters print in their own filament;
 * * `edge: "underside"` is a v3 value `transform.edge_axis` does not accept, so
 *   underside lines are laid out here with the underside mark's own placement
 *   rule (mirrored, so they read when the plate is turned over) instead of
 *   being pushed through the frame-edge path.
 */

import type { Engraving, PrintParams } from "../../contracts";
import { loadGlyphFace, loadedGlyphFace, type GlyphFace } from "../../fontGlyphs";
import { perfSpan } from "../../perf";
import type { PreviewArea } from "../../preview";
import { glyphAreas, placeArea } from "../../previewText";
import type { TokenContext } from "../../tokens";
import { expand_tokens } from "../../tokens";
import * as T from "../../transform";
import type { AuditFinding, ResolvedLine } from "../types";
import { RIDGE_BRIDGE_CELLS, RIDGE_MERGE_PASSES, placementFor, type SurfaceName } from "./areas";
import {
  CUTTER_OVERSHOOT_MM,
  PART_OVERLAP_MM,
  SIMPLIFY_EPS_MM,
  addFinding,
  finding,
  withEngravings,
  type BuildContext,
} from "./context";
import { lipKeepSection, lipTopMm } from "./frame";
import type { Contour, CrossSection, Manifold } from "./manifold";
import {
  MITRE,
  ROUND,
  contourFromFlat,
  extrudeSection,
  intersectSection,
  offsetSection,
  sectionOf,
  subtractSection,
  unionSections,
} from "./manifold";
import { inscribedWidthMm, openingWidthMm } from "./measure";
import {
  APPENDAGE_ROUNDS,
  MIN_WALL_PROBE_FACTOR,
  residueParts,
  survivesMinWall,
  widenThinParts,
} from "./repair";

/** Segments per full circle in a glyph dilation. */
export const GLYPH_JOIN_SEGMENTS = 16;

/** Fraction of the stroke target the finished groove must still measure. */
export const STROKE_FAIL_FACTOR = 0.9;

/**
 * Fraction of a text piece's area the opening must still cover for a width to
 * count as "the stroke".
 *
 * Half, and not the 99 % the structural min-wall probe uses, because a letter
 * is not a wall: every glyph has tapering terminals and a join or two that are
 * narrower than its stem, and a 99 % rule measures those instead of the stroke
 * the nozzle has to lay. It is the same 0.5 the generated metrics were built
 * with (`gen_font_assets.py`'s `stem_area_ratio`), so this measurement of a
 * finished groove and `transform.text_stroke_mm`'s prediction from the metrics
 * agree: 0.426 mm against 0.427 mm for "Chicago" at 5 mm in Inter.
 */
export const STROKE_AREA_RATIO = 0.5;

/** Line pitch for stacked underside lines, as a multiple of the fitted size. */
export const UNDERSIDE_LINE_PITCH = 1.6;

export interface LetteringGeometry {
  /** Cutters for the frame lip: engraved text only. */
  frameCut: Manifold[];
  /**
   * Pockets an inlay fills, on the lip and on the underside.
   *
   * Kept apart from the plain cutters because the single-object model does not
   * want them: an inlay is flush with the surface, so a pocket cut and then
   * filled by its own solid is the surface it started as. The REGIONS need both
   * (the frame keeps the hole, the lettering region keeps the plug); the merged
   * solid needs neither.
   */
  inlayCut: Manifold[];
  /** Solids that join the frame region: embossed text. */
  frameAdd: Manifold[];
  /** Cutters for the base, from below: underside text and inlay pockets. */
  baseCut: Manifold[];
  /** Solids of the `lettering` region: the inlays. */
  inlay: Manifold[];
  /** The layout the ornaments are cut from, so it is computed once. */
  layout: T.LetteringLayout;
}

/** Faces a parameter set will ask for, including the underside lines. */
export function facesFor(params: PrintParams): string[] {
  const out = new Set<string>();
  for (const engraving of params.engravings ?? []) {
    if (engraving.edge === "underside" || params.frame) {
      out.add(engraving.font ?? T.ENGRAVING_DEFAULT_FACE);
    }
  }
  if (params.frame && params.scale_bar?.enabled) out.add(T.SCALE_BAR_FACE);
  // The mandatory attribution is cut on EVERY build (`solid/attribution.ts`), in
  // the underside mark's own face, so that face is always needed -- with the
  // switch off as much as with it on (`[V3-P7-A2]`).
  out.add(T.UNDERSIDE_MARK_FACE);
  // The tile index marks (`solid/tiling.ts`) are cut in the underside mark's
  // own face, and they are cut long after `loadFaces` has run.
  if (params.tiling?.enabled === true && params.tiling.index_mark !== false) {
    out.add(T.UNDERSIDE_MARK_FACE);
  }
  return [...out];
}

/** Load every face a parameter set needs, once. */
export async function loadFaces(params: PrintParams): Promise<void> {
  await Promise.all(facesFor(params).map((face) => loadGlyphFace(face)));
}

// ---------------------------------------------------------------------------
// Glyphs -> sections
// ---------------------------------------------------------------------------

/** A placed `PreviewArea` list as manifold contours. */
export function contoursFromAreas(areas: readonly PreviewArea[]): Contour[] {
  const out: Contour[] = [];
  for (const area of areas) {
    const outer = contourFromFlat(area.outer, true);
    if (outer === null) continue;
    out.push(outer);
    for (const hole of area.holes) {
      const inner = contourFromFlat(hole, false);
      if (inner !== null) out.push(inner);
    }
  }
  return out;
}

/** Counters (clockwise contours) in a section. */
export function holeCount(section: CrossSection): number {
  let holes = 0;
  for (const ring of section.toPolygons()) {
    let twice = 0;
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      twice += a[0] * b[1] - b[0] * a[1];
    }
    if (twice < 0) holes += 1;
  }
  return holes;
}

export interface RepairedText {
  section: CrossSection;
  /** Counters the dilation closed. Any at all refuses the piece. */
  lostCounters: number;
  /** Dominant stroke width of the finished shape, print mm. */
  strokeMm: number;
  /** A part of the piece that is under the target everywhere, if there is one. */
  starvedParts: number;
}

/**
 * 04 stage 1 applied to a piece of text, in print millimetres.
 *
 * Dilate to a full minimum wall (the layout already computed by how much),
 * clip to where ink is allowed, then MEASURE what came out: a groove narrower
 * than 0.9 of its target is what the Stage 4 lettering rule fails on, so it is
 * refused here rather than shipped.
 */
export function repairText(
  ctx: BuildContext,
  areas: readonly PreviewArea[],
  dilationMm: number,
  targetMm: number,
  keep: CrossSection | null,
): RepairedText | null {
  const raw = perfSpan("repair.section", () => sectionOf(ctx.wasm, ctx.arena, contoursFromAreas(areas)));
  if (raw === null) return null;
  const before = holeCount(raw);

  let section = raw;
  if (dilationMm > 0) {
    const grown = perfSpan("repair.dilate", () => raw.offset(dilationMm, ROUND, 2, GLYPH_JOIN_SEGMENTS));
    if (grown.isEmpty()) {
      grown.delete();
      ctx.arena.drop(raw);
      return null;
    }
    section = ctx.arena.keep(grown);
    ctx.arena.drop(raw);
  }

  if (keep !== null) {
    const clipped = perfSpan("repair.clip", () => intersectSection(ctx.arena, section, keep));
    if (section !== clipped) ctx.arena.drop(section);
    if (clipped === null) return null;
    section = clipped;
  }

  // 04 stage 1 applied to the letterform: a terminal narrower than the target
  // is brought up to it, exactly as a building's wing is. The target is the
  // TEXT's (one nozzle for a groove, two for an emboss), not the structural
  // minimum wall, or every engraving would come out as a fat smear.
  const widened = perfSpan("repair.widen", () => widenThinParts(ctx, section, undefined, targetMm, keep));
  if (widened !== section) {
    ctx.arena.drop(section);
    section = widened;
  }

  const strokeMm = perfSpan("repair.stroke", () =>
    openingWidthMm(section, 3 * targetMm, {
      keepFraction: STROKE_AREA_RATIO,
      resolutionMm: targetMm / 20,
      segments: GLYPH_JOIN_SEGMENTS,
    }),
  );
  // A piece of the text that is under the target EVERYWHERE cannot be saved by
  // a stroke measurement that half the glyph passes: it is a letter the nozzle
  // would miss entirely. This is the reference implementation's own erosion
  // probe (`thicken.MIN_WALL_PROBE_FACTOR`), applied per connected piece.
  const starved = perfSpan("repair.starve", () => {
    let count = 0;
    const pieces = ctx.arena.keepAll(section.decompose());
    for (const piece of pieces) {
      const eroded = piece.offset(-MIN_WALL_PROBE_FACTOR * targetMm, ROUND, 2, GLYPH_JOIN_SEGMENTS);
      if (eroded.isEmpty()) count += 1;
      eroded.delete();
    }
    ctx.arena.dropAll(pieces);
    return count;
  });

  return {
    section,
    lostCounters: Math.max(0, before - holeCount(section)),
    strokeMm,
    starvedParts: starved,
  };
}

/**
 * The rectangle of lip an edge's text may occupy, plate mm: the reference's
 * `_band_domain`, the lip's full width along the edge, centred on the flat
 * face. It is what the reference measures embossed gaps in and merges them
 * over, so both are done in it here. The caller owns what comes back.
 */
function bandDomainSection(ctx: BuildContext, edge: string): CrossSection | null {
  const { wasm, arena, params } = ctx;
  const [cx, cy] = T.edge_band_center_mm(params, edge);
  const halfLen = params.plate_mm / 2;
  const halfBand = T.FRAME_WIDTH_MM / 2;
  const along = edge === "top" || edge === "bottom";
  const hx = along ? halfLen : halfBand;
  const hy = along ? halfBand : halfLen;
  const rect: Contour = [
    [cx - hx, cy - hy],
    [cx + hx, cy - hy],
    [cx + hx, cy + hy],
    [cx - hx, cy + hy],
  ];
  return sectionOf(wasm, arena, [rect]);
}

/** One stretch of a void under a nozzle, as the gate reads it. */
interface GapStretch {
  /** The stretch itself, live in the caller's arena. The caller drops it. */
  part: CrossSection;
  /** Its inscribed width, print mm: the gap. */
  widthMm: number;
  /** How far it runs, print mm, with the reference's reach at each mouth (see below). */
  lengthMm: number;
}

/**
 * The stretches of `voids` under one nozzle: the residue of opening the void
 * by a DISC of the one-nozzle probe radius (`0.45 x min_detail`, the radius
 * the Stage 4 `lettering` row erodes by), kept above `text_area_floor`.
 *
 * Two rules, for two callers:
 *
 * `"merge"` is the reference's `lettering.gap_stretches`: every part of the
 * disc's residue above the floor, its inscribed width as the gap and area
 * over width as the length. A disc of 16 segments is the same operation in
 * Clipper2 and GEOS, which is what lets `mergeEmbossGaps` fill the stretches
 * `merge_emboss_gaps` fills and hold them to the same fusion rule.
 *
 * `"gate"` is the mirror of the validator's own reading, which opens the void
 * with GEOS's MITRED buffer, and where this mirror has to differ from that
 * recipe to reach its answers. Clipper2's mitred dilation of the eroded void
 * spikes back into a wedge-shaped slit and cuts its residue into fragments of
 * 0.08 mm2 where GEOS reads one part of 0.21 (a sans date embossed at
 * 4.80 mm), so the same recipe here would build what the validator fails. The
 * disc reads the whole sub-nozzle stretch: 0.29 mm2 for that slit, but also
 * 0.20 mm2 for a 0.30 mm wide, 0.7 mm long gap between two mono digits that
 * GEOS's mitred opening covers entirely and the validator then reads at
 * 0.49 mm on the mesh. GEOS's mitre reaches about one probe radius further
 * into each mouth of a slit than the disc does, so one radius per end is taken
 * off the stretch before it is held to the area floor. Measured on the three
 * faces of that date: sans read at 0.24 mm (the validator: 0.21 on the mesh),
 * mono and serif clean, as the reference reads them. The decision is what the
 * mirror promises; the second decimal of the width is Clipper2's against
 * GEOS's.
 *
 * The caller owns every `part` that comes back.
 */
function gapStretches(ctx: BuildContext, voids: CrossSection, rule: "merge" | "gate"): GapStretch[] {
  const { arena, params } = ctx;
  const minDetail = T.min_detail_mm(params);
  // The text repair's own area floor (`text_area_floor`): a lens under one
  // nozzle squared is a corner artefact of the opening, not a gap.
  const areaFloor = minDetail * minDetail;
  const radius = MIN_WALL_PROBE_FACTOR * minDetail;
  const eroded = voids.offset(-radius, ROUND, 2, GLYPH_JOIN_SEGMENTS);
  if (eroded.isEmpty()) {
    eroded.delete();
    return [];
  }
  arena.keep(eroded);
  const opened = arena.keep(eroded.offset(radius, ROUND, 2, GLYPH_JOIN_SEGMENTS));
  arena.drop(eroded);
  const residue = subtractSection(arena, voids, opened);
  arena.drop(opened);
  if (residue === null || residue === voids) return [];
  const parts = arena.keepAll(residue.decompose());
  arena.drop(residue);
  const out: GapStretch[] = [];
  for (const part of parts) {
    const area = part.area();
    if (area >= areaFloor) {
      const width = inscribedWidthMm(part, minDetail, minDetail * GAP_WIDTH_TOLERANCE);
      // A part is a stretch of slit `area / width` long. Under the gate rule
      // one probe radius at each mouth is taken off before it is held to the
      // floor (see above); under the merge rule the whole stretch counts.
      const stretchMm = width > 0 ? area / width : 0;
      const lengthMm = rule === "gate" ? Math.max(0, stretchMm - 2 * radius) : stretchMm;
      if (width > 0 && width < minDetail && width * lengthMm >= areaFloor) {
        out.push({ part, widthMm: width, lengthMm });
        continue;
      }
    }
    arena.drop(part);
  }
  return out;
}

/**
 * The narrowest void between raised pieces on an edge's band, print mm, or
 * null when the band holds no void narrow enough to measure.
 *
 * Stage 4's own reading of an embossed band (`check_lettering` in the
 * reference validator: the band less the material, every part measured at the
 * one-nozzle floor), taken here on the section before it is extruded. Engraved
 * text never needs it: `mergeRecessRidges` hands a sub-nozzle ridge to the
 * groove before anything is measured. Embossed text gets the mirror image,
 * {@link mergeEmbossGaps}, before it reaches this; what this measures is
 * whatever that merge could not close, so `buildLettering` still refuses a
 * slit the gate would fail before the gate does (`[V3.1-P2-5]`).
 *
 * The whole void's own inscribed width is the band's, so what decides is the
 * opening residue, the parts of the void narrower than `0.9 x min_detail`,
 * each measured by its inscribed width: `thicken.narrowest_width` at that
 * floor. Measured 0.208 mm on a sans date embossed at the 4.80 mm the default
 * face allows, which is the number the validator read off the mesh.
 */
export function narrowestEmbossGapMm(ctx: BuildContext, section: CrossSection, edge: string): number | null {
  const { arena } = ctx;
  const domain = bandDomainSection(ctx, edge);
  if (domain === null) return null;
  const voids = subtractSection(arena, domain, section);
  arena.drop(domain);
  if (voids === null || voids === domain) return null;
  let narrowest: number | null = null;
  for (const stretch of gapStretches(ctx, voids, "gate")) {
    narrowest = narrowest === null ? stretch.widthMm : Math.min(narrowest, stretch.widthMm);
    arena.drop(stretch.part);
  }
  arena.drop(voids);
  return narrowest;
}

/** Resolution of the gap's inscribed-width search as a fraction of a nozzle: `thicken.MIC_TOLERANCE_RATIO`. */
const GAP_WIDTH_TOLERANCE = 0.01;

/**
 * The longest join two embossed letters may be given, as a fraction of the
 * fitted size, before the pair is one shape rather than two letters that touch
 * (`lettering.EMBOSS_JOIN_MAX_EM`, whose docstring carries the derivation: a
 * wedge - a bowl against anything - is under a nozzle only near its closest
 * point and joins over at most about 0.4 em; a slot - two straight stems - is
 * under a nozzle along the whole height the stems share, an x-height and up,
 * and prints as one clean bar). Held against `lengthMm` of the stretch that is
 * filled, which is exact for a slot and reads a wedge short, the safe way.
 */
export const EMBOSS_JOIN_MAX_EM = 0.4;

export interface EmbossMerge {
  /** The line with its sub-nozzle gaps filled and the joins widened. The input when nothing was. */
  section: CrossSection;
  /** Every gap filled, as one section, or null when none was. The caller drops it. */
  bridge: CrossSection | null;
  /** Letter pairs joined: connected raised pieces before less after. */
  joined: number;
  /** Stretches of void filled, counters' tails included. */
  gapsClosed: number;
  /** The longest stretch BETWEEN letters that was filled, mm; 0 when none. */
  longestJoinMm: number;
  /** The narrowest gap that stretch had, mm. */
  narrowestJoinGapMm: number;
  /** The narrowest gap between letters before anything was filled, mm, or null. */
  gapBeforeMm: number | null;
}

/**
 * The complement-ridge rule, applied to embossed text (the reference's
 * `lettering.merge_emboss_gaps`).
 *
 * What prints between two raised letters is a void on the lip's top face, and
 * a void under one nozzle is one the printer cannot leave: the outer perimeter
 * of each letter is a full nozzle wide, so two letters 0.2 mm apart have
 * perimeters that overlap and fuse on the bed anyway, lumpily. Handing the
 * slicer the fused outline prints the same join cleanly, exactly as
 * `mergeRecessRidges` hands a groove the ridge no nozzle could have laid down
 * beside it. The stretches filled are the ones {@link gapStretches} reads,
 * which are the ones the Stage 4 `lettering` row fails, so this closes exactly
 * that set and not one more: joining two letters the gate would have passed
 * buys no printability and costs legibility.
 *
 * An ENCLOSED void, a counter, is never filled whole - whether a counter is
 * wide enough is the counter rule's question, asked before this - only its
 * sub-nozzle tails are, which rounds the apex of an `A` by under a nozzle.
 * Every filled stretch is then a neck of material narrower than the emboss
 * target, which the gate measures as an `embossed stroke`, so the joins are
 * widened to a full wall ({@link widenJoins}). Up to `RIDGE_MERGE_PASSES`
 * rounds, because a bridge can leave a new sub-nozzle notch at its own end.
 *
 * The caller keeps ownership of `section`; `result.section` is new when
 * anything changed and must be dropped by the caller, as must `bridge`.
 */
export function mergeEmbossGaps(
  ctx: BuildContext,
  section: CrossSection,
  edge: string,
  keep: CrossSection | null,
  targetMm: number,
): EmbossMerge {
  const { wasm, arena, params } = ctx;
  const none: EmbossMerge = {
    section,
    bridge: null,
    joined: 0,
    gapsClosed: 0,
    longestJoinMm: 0,
    narrowestJoinGapMm: 0,
    gapBeforeMm: null,
  };
  const domain = bandDomainSection(ctx, edge);
  if (domain === null) return none;
  const minDetail = T.min_detail_mm(params);
  const areaFloor = minDetail * minDetail;
  const bounds = domain.bounds();
  const eps = 1e-6;
  const enclosedIn = (part: CrossSection): boolean => {
    const b = part.bounds();
    return (
      b.min[0] > bounds.min[0] + eps &&
      b.min[1] > bounds.min[1] + eps &&
      b.max[0] < bounds.max[0] - eps &&
      b.max[1] < bounds.max[1] - eps
    );
  };
  const countPieces = (of: CrossSection): number => {
    const pieces = of.decompose();
    const count = pieces.length;
    for (const piece of pieces) piece.delete();
    return count;
  };

  const piecesBefore = countPieces(section);
  let current = section;
  const bridges: CrossSection[] = [];
  let gapsClosed = 0;
  let longestJoin = 0;
  let narrowestJoinGap = 0;
  let gapBefore: number | null = null;
  for (let pass = 0; pass < RIDGE_MERGE_PASSES; pass += 1) {
    const voids = subtractSection(arena, domain, current);
    if (voids === null || voids === domain) break;
    const bad: CrossSection[] = [];
    for (const component of arena.keepAll(voids.decompose())) {
      if (component.area() < areaFloor) {
        arena.drop(component); // the gate skips it too: a lens, not a gap
        continue;
      }
      const enclosed = enclosedIn(component);
      if (enclosed && !survivesMinWall(ctx, component, minDetail)) {
        arena.drop(component); // a whole counter under a nozzle is the counter rule's
        continue;
      }
      for (const stretch of gapStretches(ctx, component, "merge")) {
        bad.push(stretch.part);
        if (enclosed) continue; // a counter's tail rounds a corner; it joins nothing
        if (pass === 0) {
          gapBefore = gapBefore === null ? stretch.widthMm : Math.min(gapBefore, stretch.widthMm);
        }
        if (stretch.lengthMm > longestJoin) {
          longestJoin = stretch.lengthMm;
          narrowestJoinGap = stretch.widthMm;
        }
      }
      arena.drop(component);
    }
    arena.drop(voids);
    if (bad.length === 0) break;
    gapsClosed += bad.length;
    // Bridged rather than merely unioned, for `mergeRecessRidges`' reason: a
    // void between two dilated letters can be a hairline of nearly zero area.
    const together = unionSections(wasm, arena, bad);
    const grownBridge = together === null ? null : offsetSection(arena, together, RIDGE_BRIDGE_CELLS * SIMPLIFY_EPS_MM, MITRE);
    for (const part of bad) {
      if (part !== together && part !== grownBridge) arena.drop(part);
    }
    if (grownBridge !== together) arena.drop(together);
    const bridge = grownBridge === null ? null : intersectSection(arena, grownBridge, domain);
    if (bridge !== grownBridge) arena.drop(grownBridge);
    if (bridge === null) break;
    bridges.push(bridge);
    const merged = unionSections(wasm, arena, [current, bridge]);
    if (merged === null || merged === current) break;
    if (current !== section) arena.drop(current);
    current = merged;
  }
  arena.drop(domain);
  if (bridges.length === 0) {
    if (current !== section) arena.drop(current);
    return none;
  }
  const bridge = unionSections(wasm, arena, bridges);
  for (const one of bridges) {
    if (one !== bridge) arena.drop(one);
  }
  const widened = widenJoins(ctx, current, bridge, targetMm, keep);
  if (widened !== current && current !== section) arena.drop(current);
  current = widened;
  if (keep !== null) {
    const inside = intersectSection(arena, current, keep);
    if (inside !== null && inside !== current) {
      if (current !== section) arena.drop(current);
      current = inside;
    }
  }
  return {
    section: current,
    bridge,
    joined: Math.max(0, piecesBefore - countPieces(current)),
    gapsClosed,
    longestJoinMm: longestJoin,
    narrowestJoinGapMm: narrowestJoinGap,
    gapBeforeMm: gapBefore,
  };
}

/**
 * 04's appendage rule, applied to the joins the emboss merge made
 * (`lettering.widen_joins`).
 *
 * Only a thin part that TOUCHES `bridge` is grown. `widenThinParts` would
 * re-widen every neck of the line at the two-nozzle emboss target and move
 * strokes the merge never touched; a string's shape is not this repair's to
 * change beyond the gaps it closed. The caller keeps ownership of `section`
 * and of `bridge`; what comes back is new when anything grew.
 */
export function widenJoins(
  ctx: BuildContext,
  section: CrossSection,
  bridge: CrossSection | null,
  targetMm: number,
  keep: CrossSection | null,
): CrossSection {
  const { arena, wasm } = ctx;
  if (bridge === null || !(targetMm > 0)) return section;
  const minDetail = T.min_detail_mm(ctx.params);
  const areaFloor = minDetail * minDetail;
  let current = section;
  for (let round = 0; round < APPENDAGE_ROUNDS; round += 1) {
    const parts = residueParts(ctx, current, MIN_WALL_PROBE_FACTOR * targetMm, areaFloor);
    if (parts === null || parts.length === 0) break;
    const grown: CrossSection[] = [];
    for (const part of parts) {
      const touch = intersectSection(arena, part, bridge);
      if (touch === null) {
        arena.drop(part);
        continue;
      }
      if (touch !== part) arena.drop(touch);
      const width = inscribedWidthMm(part, targetMm);
      if (width >= targetMm) {
        arena.drop(part);
        continue;
      }
      const fatter = offsetSection(arena, part, (targetMm - width) / 2);
      arena.drop(part);
      if (fatter !== null) grown.push(fatter);
    }
    if (grown.length === 0) break;
    let merged = unionSections(wasm, arena, [current, ...grown]);
    for (const part of grown) {
      if (part !== merged) arena.drop(part);
    }
    if (merged === null || merged === current) break;
    if (keep !== null) {
      const inside = intersectSection(arena, merged, keep);
      if (inside !== merged) arena.drop(merged);
      if (inside === null) break;
      merged = inside;
    }
    if (current !== section) arena.drop(current);
    current = merged;
  }
  return current;
}

/**
 * The narrowest join left under the gate's stroke floor after
 * {@link widenJoins}, mm, or null when every join reached it.
 *
 * The reference measures the finished line with `thicken.narrowest_width` at
 * the emboss target, which lowers the stroke by every appendage's width; the
 * only appendages a merge can add are its joins, so only those are asked.
 */
export function thinJoinMm(
  ctx: BuildContext,
  section: CrossSection,
  bridge: CrossSection,
  targetMm: number,
): number | null {
  const { arena } = ctx;
  const minDetail = T.min_detail_mm(ctx.params);
  const parts = residueParts(ctx, section, MIN_WALL_PROBE_FACTOR * targetMm, minDetail * minDetail);
  if (parts === null) return null;
  let thin: number | null = null;
  for (const part of parts) {
    const touch = intersectSection(arena, part, bridge);
    if (touch !== null) {
      if (touch !== part) arena.drop(touch);
      const width = inscribedWidthMm(part, targetMm);
      if (width < STROKE_FAIL_FACTOR * targetMm) thin = thin === null ? width : Math.min(thin, width);
    }
    arena.drop(part);
  }
  return thin;
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

interface Piece {
  id: string;
  surface: string;
  mode: "engrave" | "emboss" | "inlay";
  areas: PreviewArea[];
  fit: T.TextFit;
  depthMm: number;
  face: "top" | "bottom";
  /** The lip edge the piece stands on (`top`, `bottom`, `left`, `right`), null on the underside. */
  edge: string | null;
  /** Index in `params.engravings`, so a refusal can offer to resize THAT line. */
  sourceIndex: number;
  /** Would this line be laid out at all at `sizeMm`? See `tooSmallFinding`. */
  verifySize: (sizeMm: number) => boolean;
}

/** An engraving with the index it has in `params.engravings`. */
interface SourcedEngraving {
  engraving: Engraving;
  index: number;
}

/**
 * Split the engravings into the ones on the lip and the ones underneath,
 * keeping the index each one has in the parameter array.
 *
 * The index is what lets a "this line was not cut" finding carry a one-click
 * fix that resizes the line the user actually wrote, rather than a sentence
 * telling them to go and find it.
 */
function splitEngravings(params: PrintParams): {
  edges: SourcedEngraving[];
  underside: SourcedEngraving[];
} {
  const edges: SourcedEngraving[] = [];
  const underside: SourcedEngraving[] = [];
  (params.engravings ?? []).forEach((engraving, index) => {
    if (engraving.edge === "underside") underside.push({ engraving, index });
    else edges.push({ engraving, index });
  });
  return { edges, underside };
}

/**
 * The size this line would have to be cut at, mm, or null when growing it is
 * not the remedy.
 *
 * `TextFit.min_size_mm` is the shared layout's own measurement: the smallest
 * size at which this face's thinnest stroke in this string still clears the
 * nozzle. Rounded UP to the size grid, because rounding down would land back on
 * the refusal; capped at the schema's maximum, and null when the line is
 * already at or past it, in which case a smaller nozzle or a different face is
 * the only answer and neither is a PrintParams patch.
 */
function workingSizeMm(fit: T.TextFit): number | null {
  if (!(fit.min_size_mm > 0)) return null;
  const wanted = Math.ceil(fit.min_size_mm / T.TEXT_FIT_GRID_MM) * T.TEXT_FIT_GRID_MM;
  const capped = Number(Math.min(T.TEXT_MAX_SIZE_MM, wanted).toFixed(2));
  if (!(capped > fit.size_mm + T.TEXT_FIT_GRID_MM)) return null;
  return capped;
}

/**
 * "This line was not cut", with the measured size it would need.
 *
 * The fix is only offered when growing the line to that size WOULD cut it, and
 * `verify` is what answers that: it re-runs the same shared layout (or the same
 * `fit_text`) that refused the line, at the candidate size, and reports whether
 * the refusal goes away. Guessing instead would be worse than saying nothing -
 * a line that "does not fit the edge even at the smallest legal 1.5 mm" also
 * reports a `min_size_mm`, and a button that made it BIGGER would fail in
 * exactly the same way with a longer error.
 *
 * It is never SAFE: a bigger engraving is a design change the user can see.
 */
function tooSmallFinding(
  params: PrintParams,
  title: string,
  reason: string,
  fit: T.TextFit,
  sourceIndex: number,
  verify: (sizeMm: number) => boolean,
): AuditFinding {
  const base = skipFinding(title, reason);
  const all = params.engravings ?? [];
  const size = workingSizeMm(fit);
  if (size === null || sourceIndex < 0 || sourceIndex >= all.length) return base;
  if (!verify(size)) return base;
  return {
    ...base,
    detail: `${reason}. At ${size.toFixed(2)} mm it would cut.`,
    fix: {
      label: `Set this line to ${size.toFixed(2)} mm`,
      safe: false,
      patch: {
        engravings: all.map((engraving, index) =>
          index === sourceIndex ? { ...engraving, size_mm: size } : engraving,
        ),
      },
    },
  };
}

/** Would this edge line cut at `sizeMm`? Asked of the layout that refused it. */
function edgeCutsAt(
  params: PrintParams,
  edges: readonly SourcedEngraving[],
  tokens: TokenContext,
  rotationDeg: number,
  entryIndex: number,
  sizeMm: number,
): boolean {
  const resized = edges.map((item, index) =>
    index === entryIndex ? { ...item.engraving, size_mm: sizeMm } : item.engraving,
  );
  const layout = T.lettering_layout(withEngravings(params, resized), tokens, rotationDeg);
  const entry = layout.engravings.find((item) => item.index === entryIndex);
  return entry !== undefined && !entry.fit.refused;
}

/**
 * How far below the base top the deepest surface region reaches, print mm.
 *
 * Exported for `solid/tiling.ts`, which cuts its own pocket into the same
 * underside and has to leave the same roof over the same recesses.
 */
export function deepestRecessMm(ctx: BuildContext): number {
  let depth = 0;
  const layers: SurfaceName[] = ["water", "rail", "roads", "parks"];
  for (const layer of layers) {
    const placement = placementFor(ctx, layer);
    depth = Math.max(depth, ctx.baseTopMm - placement.bottomMm);
  }
  return depth;
}

/** Thinnest base that can carry a pocket of `depthMm` cut from underneath. */
function undersideFloorOk(ctx: BuildContext, depthMm: number): boolean {
  return (
    depthMm + T.HANGER_MIN_ROOF_MM + deepestRecessMm(ctx) <= ctx.params.base_thickness_mm + 1e-9
  );
}

function resolved(
  id: string,
  fit: T.TextFit,
  surface: string,
  mode: "engrave" | "emboss" | "inlay",
  status: "cuts" | "skipped",
  depthMm: number,
  reason?: string,
  joined = 0,
): ResolvedLine {
  const line: ResolvedLine = {
    id,
    text: fit.text,
    surface,
    mode,
    status,
    depthMm,
    sizeMm: fit.size_mm,
  };
  if (reason !== undefined) line.reason = reason;
  if (joined > 0) line.joined = joined;
  return line;
}

function skipFinding(title: string, detail: string): AuditFinding {
  return finding("text-too-small", "warning", title, detail, "lettering");
}

const EDGE_LABEL: Record<string, string> = {
  top: "Frame, top edge",
  bottom: "Frame, bottom edge",
  left: "Frame, left edge",
  right: "Frame, right edge",
  underside: "Underside",
};

/**
 * Lay the underside lines out in a column, mirrored so they read from below.
 *
 * The pen origin is on the RIGHT of a mirrored block (`x -> -x + anchor`), so a
 * block laid out from 0 to W spans `[anchor - W, anchor]` and `+W/2` centres
 * it, exactly as `transform.underside_mark_layout` does it.
 */
function undersideColumn(
  ctx: BuildContext,
  fits: readonly T.TextFit[],
  reservedMm: number,
): T.Placement[] {
  const pitches = fits.map((fit) => UNDERSIDE_LINE_PITCH * fit.size_mm);
  let total = 0;
  for (const pitch of pitches) total += pitch;
  let cursor = reservedMm > 0 ? -reservedMm / 2 : total / 2;
  const out: T.Placement[] = [];
  for (let i = 0; i < fits.length; i += 1) {
    const centre = cursor - pitches[i] / 2;
    cursor -= pitches[i];
    out.push({
      anchor_x: fits[i].width_mm / 2 - fits[i].dilation_mm,
      anchor_y: centre - (fits[i].ink_top_mm + fits[i].ink_bottom_mm) / 2,
      rotation_deg: 0,
      mirror_x: true,
    });
  }
  void ctx;
  return out;
}

/**
 * Every engraving, as solids.
 *
 * Refusals never throw: each one becomes a `ResolvedLine` with status
 * `"skipped"` carrying the reason, plus an `AuditFinding` the Issues badge can
 * show. A caller that asked for six lines always gets six resolved lines back.
 */
/**
 * Surface what the shared layout adjusted, as findings.
 *
 * `transform.lettering_layout` returns human-readable strings for every
 * adjustment it made on the caller's behalf: a size auto-fitted down to fit its
 * edge, a scale bar rounded to a round number of metres. They used to be pushed
 * to `ctx.warnings`, which `EngineResult` has no field for, so nothing that
 * reads a build ever saw them (v3-02 audit, MAJOR 2). They are informational -
 * the line was still cut, and cut correctly - so they are one `info` finding
 * carrying the layout's own wording rather than the engine's paraphrase of it.
 */
function reportLayoutWarnings(ctx: BuildContext, warnings: readonly string[]): void {
  if (warnings.length === 0) return;
  addFinding(
    ctx,
    finding(
      "lettering-adjusted",
      "info",
      warnings.length === 1
        ? "One engraving was adjusted to fit"
        : `${warnings.length} engravings were adjusted to fit`,
      warnings.join(" "),
      "lettering",
    ),
  );
}

/**
 * @param reservedUndersideMm how much of the underside the MANDATORY
 * attribution block takes (`solid/attribution.ts`'s `undersideReserveMm`). The
 * user's own `edge: "underside"` lines are stacked below it, so the two can
 * never be laid out on top of each other (`[V3-P7-A2]`).
 */
export function buildLettering(
  ctx: BuildContext,
  tokens: TokenContext,
  rotationDeg = 0,
  reservedUndersideMm = 0,
): LetteringGeometry {
  const { params } = ctx;
  const { edges, underside } = splitEngravings(params);
  // The shared layout only knows the four frame edges, so it is given exactly
  // those; the underside lines are laid out below with the mark's own rule.
  // An override view rather than a spread copy: a copy reads every leaf of
  // the params, which the pipeline's strict-claims check would count as a
  // dependency of the lettering on all of them (`pipeline/claims.ts`).
  const edgeParams = withEngravings(params, edges.map((item) => item.engraving));
  const layout = perfSpan("lettering.layout", () => T.lettering_layout(edgeParams, tokens, rotationDeg));
  reportLayoutWarnings(ctx, layout.warnings);

  const out: LetteringGeometry = {
    frameCut: [],
    inlayCut: [],
    frameAdd: [],
    baseCut: [],
    inlay: [],
    layout,
  };

  const keep = lipKeepSection(ctx);
  const lipTop = lipTopMm(ctx);
  const pieces: Piece[] = [];

  for (const entry of layout.engravings) {
    const item = edges[entry.index];
    const source = item?.engraving;
    const sourceIndex = item?.index ?? -1;
    const face = source?.font ?? T.ENGRAVING_DEFAULT_FACE;
    const mode = (entry.mode as "engrave" | "emboss" | "inlay") ?? "engrave";
    const surface = EDGE_LABEL[entry.edge] ?? entry.edge;
    const id = `engraving-${entry.index}`;
    if (entry.fit.refused || entry.fit.text.trim() === "") {
      ctx.resolvedText.push(
        resolved(id, entry.fit, surface, mode, "skipped", entry.depth_mm, entry.fit.reason),
      );
      addFinding(
        ctx,
        tooSmallFinding(
          params,
          `"${entry.fit.text || source?.text || ""}" was not cut`,
          entry.fit.reason,
          entry.fit,
          sourceIndex,
          (sizeMm) => edgeCutsAt(edgeParams, edges, tokens, rotationDeg, entry.index, sizeMm),
        ),
      );
      continue;
    }
    const asset = loadedGlyphFace(face);
    if (asset === null) {
      ctx.resolvedText.push(
        resolved(id, entry.fit, surface, mode, "skipped", entry.depth_mm, `the ${face} font is not loaded`),
      );
      continue;
    }
    pieces.push({
      id,
      surface,
      mode,
      areas: perfSpan("lettering.glyphs", () => placedGlyphs(asset, entry.fit, entry.placement)),
      fit: entry.fit,
      depthMm: entry.depth_mm,
      face: "top",
      edge: entry.edge,
      sourceIndex,
      verifySize: (sizeMm) => edgeCutsAt(edgeParams, edges, tokens, rotationDeg, entry.index, sizeMm),
    });
  }

  // --- the underside lines ---------------------------------------------
  const undersideFits: T.TextFit[] = [];
  for (const { engraving } of underside) {
    const face = engraving.font ?? T.ENGRAVING_DEFAULT_FACE;
    const text = expand_tokens(engraving.text, tokens);
    undersideFits.push(
      T.fit_text(
        face,
        text,
        engraving.size_mm ?? T.ENGRAVING_DEFAULT_SIZE_MM,
        T.underside_mark_available_mm(params),
        (engraving.size_mm ?? T.ENGRAVING_DEFAULT_SIZE_MM) * 2,
        params,
        "underside engraving",
        engraving.mode ?? "engrave",
      ),
    );
  }
  // The attribution block, not the v2 underside mark: that mark no longer
  // exists on its own, and what the user's lines have to clear is the whole
  // mandatory block (`[V3-P7-A2]`).
  const placements = undersideColumn(ctx, undersideFits, reservedUndersideMm);
  for (let i = 0; i < underside.length; i += 1) {
    const { engraving, index: sourceIndex } = underside[i];
    const fit = undersideFits[i];
    const mode = (engraving.mode ?? "engrave") as "engrave" | "emboss" | "inlay";
    const depth = engraving.depth_mm ?? T.ENGRAVING_DEFAULT_DEPTH_MM;
    const id = `underside-${i}`;
    const surface = EDGE_LABEL.underside;
    let reason: string | null = null;
    if (fit.refused || fit.text.trim() === "") reason = fit.reason;
    else if (mode === "emboss") {
      reason = "an embossed line on the underside would stop the plate sitting flat";
    } else if (!undersideFloorOk(ctx, depth)) {
      reason =
        `a ${depth.toFixed(2)} mm pocket needs a base of at least ` +
        `${(depth + T.HANGER_MIN_ROOF_MM + deepestRecessMm(ctx)).toFixed(2)} mm`;
    }
    if (reason !== null) {
      ctx.resolvedText.push(resolved(id, fit, surface, mode, "skipped", depth, reason));
      addFinding(
        ctx,
        fit.refused
          ? tooSmallFinding(
              params,
              `"${fit.text}" was not cut on the underside`,
              reason,
              fit,
              sourceIndex,
              (sizeMm) =>
                !T.fit_text(
                  fit.face,
                  fit.text,
                  sizeMm,
                  T.underside_mark_available_mm(params),
                  sizeMm * 2,
                  params,
                  "underside engraving",
                  mode,
                ).refused,
            )
          : // An embossed underside line and a pocket the base cannot carry are
            // not size problems, and no size cures them.
            skipFinding(`"${fit.text}" was not cut on the underside`, reason),
      );
      continue;
    }
    const asset = loadedGlyphFace(fit.face);
    if (asset === null) {
      ctx.resolvedText.push(
        resolved(id, fit, surface, mode, "skipped", depth, `the ${fit.face} font is not loaded`),
      );
      continue;
    }
    pieces.push({
      id,
      surface,
      mode,
      areas: placedGlyphs(asset, fit, placements[i]),
      fit,
      depthMm: depth,
      face: "bottom",
      edge: null,
      sourceIndex,
      verifySize: (sizeMm) =>
        !T.fit_text(
          fit.face,
          fit.text,
          sizeMm,
          T.underside_mark_available_mm(params),
          sizeMm * 2,
          params,
          "underside engraving",
          mode,
        ).refused,
    });
  }

  // --- repair, measure and cut -----------------------------------------
  for (const piece of pieces) {
    const target = T.text_stroke_target_mm(params, piece.mode === "emboss" ? "emboss" : "engrave");
    const repaired = perfSpan("lettering.repair", () =>
      repairText(ctx, piece.areas, piece.fit.dilation_mm, target, piece.face === "top" ? keep : null),
    );
    if (repaired === null) {
      ctx.resolvedText.push(
        resolved(piece.id, piece.fit, piece.surface, piece.mode, "skipped", piece.depthMm, "the glyphs came back empty"),
      );
      continue;
    }
    if (repaired.lostCounters > 0) {
      const reason =
        `widening it to a full minimum wall closed ${repaired.lostCounters} counter(s); ` +
        `it needs about ${piece.fit.min_size_mm.toFixed(2)} mm`;
      ctx.resolvedText.push(
        resolved(piece.id, piece.fit, piece.surface, piece.mode, "skipped", piece.depthMm, reason),
      );
      addFinding(
        ctx,
        tooSmallFinding(
          params,
          `"${piece.fit.text}" was not cut`,
          reason,
          piece.fit,
          piece.sourceIndex,
          piece.verifySize,
        ),
      );
      ctx.arena.drop(repaired.section);
      continue;
    }
    if (repaired.strokeMm < STROKE_FAIL_FACTOR * target || repaired.starvedParts > 0) {
      const reason =
        repaired.starvedParts > 0
          ? `${repaired.starvedParts} piece(s) of it are under ${target.toFixed(2)} mm wide ` +
            `everywhere, so a ${params.nozzle_mm} mm nozzle would miss them`
          : `its stroke measures ${repaired.strokeMm.toFixed(2)} mm against a ` +
            `${target.toFixed(2)} mm target for a ${params.nozzle_mm} mm nozzle`;
      ctx.resolvedText.push(
        resolved(piece.id, piece.fit, piece.surface, piece.mode, "skipped", piece.depthMm, reason),
      );
      addFinding(
        ctx,
        tooSmallFinding(
          params,
          `"${piece.fit.text}" was not cut`,
          reason,
          piece.fit,
          piece.sourceIndex,
          piece.verifySize,
        ),
      );
      ctx.arena.drop(repaired.section);
      continue;
    }
    let joined = 0;
    if (piece.mode === "emboss" && piece.edge !== null) {
      // Stage 4 fails a void under one nozzle between two raised letters. The
      // mirror image of the engraved ridge merge closes it ([V3.1-P2-5]): the
      // sub-nozzle voids between the letters are filled and the joins widened
      // to a wall, so the layout's "will touch where they are closest" is what
      // the geometry does rather than what the validator then fails. What the
      // merge cannot make printable, or would make one shape of, is refused
      // here, measured the way the gate measures it, before it is built.
      const edge = piece.edge;
      const gapFail = STROKE_FAIL_FACTOR * T.min_detail_mm(params);
      const merged = perfSpan("lettering.gap", () => mergeEmbossGaps(ctx, repaired.section, edge, keep, target));
      if (merged.section !== repaired.section) {
        ctx.arena.drop(repaired.section);
        repaired.section = merged.section;
      }
      const refuse = (reason: string): void => {
        ctx.resolvedText.push(
          resolved(piece.id, piece.fit, piece.surface, piece.mode, "skipped", piece.depthMm, reason),
        );
        addFinding(
          ctx,
          tooSmallFinding(
            params,
            `"${piece.fit.text}" was not cut`,
            reason,
            piece.fit,
            piece.sourceIndex,
            piece.verifySize,
          ),
        );
        ctx.arena.drop(merged.bridge);
        ctx.arena.drop(repaired.section);
      };
      if (merged.longestJoinMm > EMBOSS_JOIN_MAX_EM * piece.fit.size_mm) {
        // A slot, not a wedge: the pair would print as one clean bar, which is
        // not the text that was asked for.
        refuse(
          `at ${piece.fit.size_mm.toFixed(2)} mm two of its raised letters run within ` +
            `${merged.narrowestJoinGapMm.toFixed(2)} mm of each other along ` +
            `${merged.longestJoinMm.toFixed(2)} mm of their height, under the ${gapFail.toFixed(2)} mm a ` +
            `${params.nozzle_mm} mm nozzle can leave between them, and would print as one shape ` +
            `rather than as two letters that touch; ${piece.fit.gap_size_mm.toFixed(2)} mm would keep them apart`,
        );
        continue;
      }
      if (merged.bridge !== null) {
        const thin = perfSpan("lettering.gap", () => thinJoinMm(ctx, repaired.section, merged.bridge as CrossSection, target));
        if (thin !== null) {
          refuse(
            `a join between two of its raised letters measures ${thin.toFixed(2)} mm against a ` +
              `${target.toFixed(2)} mm target for a ${params.nozzle_mm} mm nozzle`,
          );
          continue;
        }
      }
      const gapMm = perfSpan("lettering.gap", () => narrowestEmbossGapMm(ctx, repaired.section, edge));
      if (gapMm !== null && gapMm < gapFail) {
        refuse(
          `two of its raised letters come within ${gapMm.toFixed(2)} mm of each other even after ` +
            `joining the pairs a nozzle cannot part, under the ${gapFail.toFixed(2)} mm a ` +
            `${params.nozzle_mm} mm nozzle can leave between them; ` +
            `${piece.fit.gap_size_mm.toFixed(2)} mm would keep them apart`,
        );
        continue;
      }
      ctx.arena.drop(merged.bridge);
      joined = merged.joined;
      if (joined > 0) {
        // A join is user-visible where a merged ridge is not, so it is said,
        // with the gap that forced it and the size that would not have. An
        // `info`, like the layout's own adjustments: the line was cut.
        const gapBefore = merged.gapBeforeMm ?? 0;
        addFinding(
          ctx,
          finding(
            "lettering-adjusted",
            "info",
            `"${piece.fit.text}" had ${joined} pair(s) of letters joined`,
            `${joined} pair(s) of its raised letters came within ${gapBefore.toFixed(2)} mm of each other, ` +
              `under the ${gapFail.toFixed(2)} mm a ${params.nozzle_mm} mm nozzle can leave between them, ` +
              `and were joined where they touch; ${piece.fit.gap_size_mm.toFixed(2)} mm would keep them apart.`,
            "lettering",
          ),
        );
      }
    }

    const cut = perfSpan("lettering.extrude", () => emitPiece(ctx, piece, repaired.section, lipTop));
    if (!cut) {
      ctx.resolvedText.push(
        resolved(piece.id, piece.fit, piece.surface, piece.mode, "skipped", piece.depthMm, "the extrusion came back empty"),
      );
      ctx.arena.drop(repaired.section);
      continue;
    }
    for (const solid of cut.frameCut) out.frameCut.push(solid);
    for (const solid of cut.inlayCut) out.inlayCut.push(solid);
    for (const solid of cut.frameAdd) out.frameAdd.push(solid);
    for (const solid of cut.baseCut) out.baseCut.push(solid);
    for (const solid of cut.inlay) out.inlay.push(solid);
    ctx.resolvedText.push(
      resolved(piece.id, piece.fit, piece.surface, piece.mode, "cuts", piece.depthMm, undefined, joined),
    );
    ctx.arena.drop(repaired.section);
  }

  if (keep !== null) ctx.arena.drop(keep);
  return out;
}

/** One string's glyphs, at the fitted size, placed on the plate. */
function placedGlyphs(
  asset: GlyphFace,
  fit: T.TextFit,
  placement: T.Placement,
): PreviewArea[] {
  // Dilation 0 here: the preview's vertex-bisector offset is a stand-in for a
  // real one, and this pipeline has a real one (`repairText`).
  const areas = glyphAreas(asset, fit.text, fit.size_mm, 0);
  return areas.map((area) => placeArea(area, placement));
}

interface EmittedPiece {
  frameCut: Manifold[];
  inlayCut: Manifold[];
  frameAdd: Manifold[];
  baseCut: Manifold[];
  inlay: Manifold[];
}

/**
 * One repaired piece as solids.
 *
 * Engraved: a cutter from the depth up past the surface. Embossed: a solid
 * standing on the surface, overlapping it by 04's own 0.2 mm so the union with
 * the frame is unambiguous. Inlay: the engraved cutter AND a solid filling the
 * pocket exactly, in the `lettering` region.
 */
function emitPiece(
  ctx: BuildContext,
  piece: Piece,
  section: CrossSection,
  lipTop: number,
): EmittedPiece | null {
  const { wasm, arena } = ctx;
  const out: EmittedPiece = {
    frameCut: [],
    inlayCut: [],
    frameAdd: [],
    baseCut: [],
    inlay: [],
  };
  if (piece.face === "bottom") {
    const cutter = extrudeSection(wasm, arena, section, -CUTTER_OVERSHOOT_MM, piece.depthMm);
    if (cutter === null) return null;
    out.baseCut.push(cutter);
    if (piece.mode === "inlay") {
      out.inlayCut.push(cutter);
      // Up into the plate by `PART_OVERLAP_MM`, for the same reason.
      const fill = extrudeSection(
        wasm,
        arena,
        section,
        0,
        piece.depthMm + PART_OVERLAP_MM,
      );
      if (fill !== null) out.inlay.push(fill);
    }
    return out;
  }
  if (piece.mode === "emboss") {
    const solid = extrudeSection(
      wasm,
      arena,
      section,
      lipTop - T.BUILDING_OVERLAP_MM,
      lipTop + piece.depthMm,
    );
    if (solid === null) return null;
    out.frameAdd.push(solid);
    return out;
  }
  const cutter = extrudeSection(
    wasm,
    arena,
    section,
    lipTop - piece.depthMm,
    lipTop + CUTTER_OVERSHOOT_MM,
  );
  if (cutter === null) return null;
  out.frameCut.push(cutter);
  if (piece.mode === "inlay") {
    out.inlayCut.push(cutter);
    // Down into the lip by `PART_OVERLAP_MM`: the inlay is its own colour part
    // and must interpenetrate the frame rather than share its pocket floor
    // (`context.PART_OVERLAP_MM`). The extra is inside the lip, which is
    // 2 mm tall against a 1.5 mm maximum engraving depth.
    const fill = extrudeSection(
      wasm,
      arena,
      section,
      lipTop - piece.depthMm - PART_OVERLAP_MM,
      lipTop,
    );
    if (fill !== null) out.inlay.push(fill);
  }
  return out;
}
