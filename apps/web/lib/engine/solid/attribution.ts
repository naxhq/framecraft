/**
 * The marks every FrameCraft model carries, whatever the user asked for.
 *
 * Three of them, and none is optional:
 *
 * 1. **The deep underside mark.** Recessed text on the base underside, as deep
 *    as the plate can safely carry (0.6 mm, clamped by the same floor guard
 *    every underside pocket is clamped by) and sized to span most of the plate.
 *    Sanding it out takes material off the whole underside, not off a corner.
 * 2. **The frame inner-wall mark.** The same text engraved horizontally into
 *    the vertical wall the frame opening makes, where a sanding block cannot
 *    reach without destroying the frame profile. With no frame there is no such
 *    wall, so a SECOND underside mark is cut instead, in another part of the
 *    plate and turned 90 degrees.
 * 3. **The microtext.** One 1.2 mm line on the OUTER side face of the base.
 *    Cropping it off means cutting the plate back, which changes the model's
 *    outer dimensions.
 *
 * Four rules this module exists to enforce, all of them recorded in DECISIONS
 * `[V3-P7-A1]` .. `[V3-P7-A9]`:
 *
 * * **The engine composes the strings.** `EngineInput.attribution` is ignored
 *   (`[V3-P7-A1]`): a UI that could supply the attribution text is a UI that
 *   could supply an empty one. The mandatory text is built here from constants,
 *   the params and the build date.
 * * **`underside_mark.enabled: false` turns off the USER's line only.** Their
 *   `template` is APPENDED to the mandatory text, never substituted for it.
 * * **Nothing here is ever refused for being small.** The lettering pipeline
 *   refuses a line a nozzle cannot resolve, which is right for a line the user
 *   chose and wrong for provenance: a groove too fine to print is still a
 *   groove in the mesh and still says where the model came from. Marks that
 *   land under the printable floor are CUT and reported with an `info` finding
 *   that says so (`[V3-P7-A6]`).
 * * **Honesty about what this achieves** is in `LICENSE_AND_ATTRIBUTION.md`:
 *   engraved plastic can be removed by anyone determined, and a mesh can be
 *   edited. The goal is to make casual removal impractical and provenance
 *   provable, not to make removal impossible.
 */

import type { PrintParams } from "../../contracts";
import { loadedGlyphFace, type GlyphFace } from "../../fontGlyphs";
import type { PreviewArea } from "../../preview";
import { glyphAreas, placeArea } from "../../previewText";
import * as T from "../../transform";
import type { AuditFinding, ResolvedLine } from "../types";
import { CUTTER_OVERSHOOT_MM, addFinding, finding, type BuildContext } from "./context";
import { contoursFromAreas, deepestRecessMm, holeCount } from "./lettering";
import {
  frameBottomMm,
  frameRingSection,
  frameStyle,
  profileSlabs,
  type FrameCorner,
} from "./frame";
import type { CrossSection, Manifold } from "./manifold";
import { ROUND, cleanSection, extrudeSection, sectionOf } from "./manifold";

// ---------------------------------------------------------------------------
// The text
// ---------------------------------------------------------------------------

/** The face every mandatory mark is cut in: the underside mark's own. */
export const ATTRIBUTION_FACE = T.UNDERSIDE_MARK_FACE;

/** The product name. Present on every mark, first. */
export const PRODUCT_NAME = "FrameCraft";

/** The OSM credit, with the real sign. */
export const OSM_CREDIT = "© OpenStreetMap contributors";

/** The same credit for a face whose metrics have no U+00A9. */
export const OSM_CREDIT_ASCII = "(c) OpenStreetMap contributors";

/** The ODbL line every exporter writes into its file metadata. */
export const MODEL_DATA_LICENCE = "Model data © OpenStreetMap contributors, ODbL 1.0";

/**
 * The credit as this face can actually lay it out.
 *
 * `transform.filter_text` DROPS a character the shared metrics table has no
 * entry for, so a face without the copyright sign would silently engrave
 * "OpenStreetMap contributors" with a missing glyph in front of it. All three
 * committed faces carry U+00A9; this is the check that keeps the fallback
 * honest if one ever does not.
 */
export function osmCredit(face: string = ATTRIBUTION_FACE): string {
  // A face with no metrics table at all is treated like a face with no sign in
  // it: the ASCII credit is always layable, and an attribution that throws is
  // an attribution that does not get cut.
  try {
    return T.supported_codepoint(face, "©") ? OSM_CREDIT : OSM_CREDIT_ASCII;
  } catch {
    return OSM_CREDIT_ASCII;
  }
}

/**
 * The text every mark carries: the product, the OSM credit, the date.
 *
 * `date` is the build's own generation date (`EngineInput.date`, defaulting to
 * today), the same string the `{date}` token expands to, so a mark and an
 * engraving made in the same build never disagree about when it was made.
 */
export function mandatoryText(date: string, face: string = ATTRIBUTION_FACE): string {
  return `${PRODUCT_NAME} ${osmCredit(face)} ${date}`;
}

/**
 * The user's own underside line, expanded, or "" when there is none.
 *
 * `underside_mark.enabled: false` silences THIS and nothing else.
 */
export function userMarkText(params: PrintParams, expand: (text: string) => string): string {
  const mark = params.underside_mark;
  if (mark?.enabled !== true) return "";
  return expand(mark.template ?? "").trim();
}

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

/** How deep the underside mark is cut when the plate can carry it, mm. */
export const DEEP_MARK_DEPTH_MM = 0.6;

/** The shallowest the underside mark is ever cut, mm (`[V3-P7-A3]`). */
export const DEEP_MARK_MIN_DEPTH_MM = 0.4;

/**
 * Plate that must remain over the mark when the ordinary roof will not fit, mm.
 *
 * `HANGER_MIN_ROOF_MM` (1.0) is what every underside POCKET is charged, and it
 * is what this mark asks for first. It cannot be a hard floor here, because the
 * mark is not optional: on a 3 mm plate with the default water recess the
 * ordinary roof leaves 0.5 mm of depth, and on the contract's thinnest plate it
 * would leave none at all. Three layers at the commonest layer height is the
 * absolute floor, and the mark is cut to `DEEP_MARK_MIN_DEPTH_MM` against it.
 */
export const DEEP_MARK_MIN_ROOF_MM = 0.6;

/** Fraction of the plate's shorter side the mark must span (`[V3-P7-A4]`). */
export const DEEP_MARK_MIN_SPAN_FRACTION = 0.6;

/** Line pitch of a stacked mark, as a multiple of its cap height. */
export const MARK_LINE_PITCH = 1.6;

/**
 * Cap height under which the mandatory text is wrapped instead of shrunk, mm.
 *
 * One line spanning the plate is a better mark than two lines spanning two
 * thirds of it, so a single line is preferred while it stays comfortably
 * legible; below this the text is wrapped to words and the lines are grown.
 */
export const MARK_ONE_LINE_MIN_MM = 3.0;

/** Exposed frame inner wall under which that wall segment is skipped, mm. */
export const WALL_MARK_MIN_HEIGHT_MM = 2.0;

/** How deep the frame inner-wall mark is cut into the wall, mm. */
export const WALL_MARK_DEPTH_MM = 0.4;

/** Wall left clear above and below the inner-wall mark, mm. */
export const WALL_MARK_EDGE_MM = 0.15;

/** Wall left clear at each end of an inner-wall segment, mm. */
export const WALL_MARK_END_MM = 1.5;

/** Cap height of the microtext on the base's outer side face, mm. */
export const MICROTEXT_CAP_MM = 1.2;

/** How deep the microtext is cut into the outer side face, mm. */
export const MICROTEXT_DEPTH_MM = 0.2;

/** Clear plate left at each end of the microtext line, mm. */
export const MICROTEXT_END_MM = 3.0;

/** Slack added to each end of a declared mark band, mm. */
export const BAND_MARGIN_MM = 0.05;

/** Cap height of the second underside mark (frame off), mm. */
export const SECOND_MARK_CAP_MM = 4.0;

/** Clear plate between the two underside marks, mm. */
export const SECOND_MARK_GAP_MM = 2.0;

// ---------------------------------------------------------------------------
// Layout: word wrapping and block placement
// ---------------------------------------------------------------------------

/** One laid-out line of a mark. */
export interface MarkLine {
  text: string;
  sizeMm: number;
  /** Advance width at `sizeMm`, mm. */
  widthMm: number;
  inkTopMm: number;
  inkBottomMm: number;
}

/** A stack of lines, as one block. */
export interface MarkBlock {
  lines: MarkLine[];
  /** Widest line, mm. */
  widthMm: number;
  /** `lines.length * MARK_LINE_PITCH * size`, mm. */
  heightMm: number;
}

function measure(face: string, text: string, sizeMm: number): MarkLine {
  const [layable] = T.filter_text(face, text);
  const [topEm, bottomEm] = T.text_ink_em(face, layable);
  return {
    text: layable,
    sizeMm,
    widthMm: T.text_advance_em(face, layable) * sizeMm,
    inkTopMm: topEm * sizeMm,
    inkBottomMm: bottomEm * sizeMm,
  };
}

/**
 * Break `text` into lines no wider than `availableMm` at `sizeMm`.
 *
 * Greedy, on spaces, and never breaks a word: a word too wide for the line is
 * given a line of its own and overflows it, which the caller prevents by
 * choosing `sizeMm` from the longest word in the first place.
 */
export function wrapText(
  face: string,
  text: string,
  sizeMm: number,
  availableMm: number,
): string[] {
  const words = text.split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return [];
  const out: string[] = [];
  let line = words[0];
  for (let i = 1; i < words.length; i += 1) {
    const candidate = `${line} ${words[i]}`;
    if (T.text_advance_em(face, candidate) * sizeMm <= availableMm) line = candidate;
    else {
      out.push(line);
      line = words[i];
    }
  }
  out.push(line);
  return out;
}

/** Advance of the longest single word, em. */
function longestWordEm(face: string, text: string): number {
  let widest = 0;
  for (const word of text.split(/\s+/)) {
    if (word === "") continue;
    widest = Math.max(widest, T.text_advance_em(face, word));
  }
  return widest;
}

/**
 * Lay one piece of text out as a block that fills `availableMm` of width.
 *
 * Never refuses and never returns an empty block for non-empty text: the cap
 * height is clamped to the contract's own window and the text is wrapped rather
 * than shrunk below {@link MARK_ONE_LINE_MIN_MM} while wrapping still helps.
 * `capMm` caps the cap height (the user's appended line never grows past the
 * mandatory text above it).
 */
export function layoutBlock(
  face: string,
  text: string,
  availableMm: number,
  availableHeightMm: number,
  capMm: number = T.TEXT_MAX_SIZE_MM,
): MarkBlock {
  const trimmed = text.trim();
  if (trimmed === "" || !(availableMm > 0)) {
    return { lines: [], widthMm: 0, heightMm: 0 };
  }
  const ceiling = Math.min(capMm, T.TEXT_MAX_SIZE_MM);
  const wholeEm = Math.max(1e-9, T.text_advance_em(face, trimmed));
  const oneLine = Math.min(ceiling, availableMm / wholeEm);
  let size: number;
  let lines: string[];
  if (oneLine >= Math.min(MARK_ONE_LINE_MIN_MM, ceiling)) {
    size = oneLine;
    lines = [trimmed];
  } else {
    const wordEm = Math.max(1e-9, longestWordEm(face, trimmed));
    size = Math.min(ceiling, availableMm / wordEm);
    lines = wrapText(face, trimmed, size, availableMm);
  }
  // The block must also fit the plate the other way. Shrinking makes the wrap
  // coarser, so re-wrap after each shrink; three rounds converge on every
  // string the contract's 100-256 mm plate window can produce.
  for (let round = 0; round < 3; round += 1) {
    const height = lines.length * MARK_LINE_PITCH * size;
    if (height <= availableHeightMm || !(availableHeightMm > 0)) break;
    size = Math.max(T.TEXT_MIN_SIZE_MM, size * (availableHeightMm / height) * 0.98);
    lines = wrapText(face, trimmed, size, availableMm);
  }
  const measured = lines.map((line) => measure(face, line, size));
  return {
    lines: measured,
    widthMm: measured.reduce((widest, line) => Math.max(widest, line.widthMm), 0),
    heightMm: measured.length * MARK_LINE_PITCH * size,
  };
}

/**
 * Where each line of a block goes on the plate underside, mirrored.
 *
 * The same rule `transform.underside_mark_layout` uses and `lettering.ts`'s
 * `undersideColumn` repeats: the pen origin is on the RIGHT of a mirrored
 * block, so a line laid out from 0 to W spans `[anchor - W, anchor]` and `W/2`
 * centres it. `centreXMm`/`centreYMm` place the whole block; `rotationDeg`
 * turns it about that centre.
 */
export function placeBlock(
  block: MarkBlock,
  centreXMm: number,
  centreYMm: number,
  rotationDeg = 0,
): T.Placement[] {
  const theta = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const out: T.Placement[] = [];
  let cursor = block.heightMm / 2;
  for (const line of block.lines) {
    const pitch = MARK_LINE_PITCH * line.sizeMm;
    const rowY = cursor - pitch / 2;
    cursor -= pitch;
    // The unrotated anchor, exactly the underside mark's own.
    const ax = line.widthMm / 2;
    const ay = rowY - (line.inkTopMm + line.inkBottomMm) / 2;
    out.push({
      anchor_x: cos * ax - sin * ay + centreXMm,
      anchor_y: sin * ax + cos * ay + centreYMm,
      rotation_deg: rotationDeg,
      mirror_x: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * The glyphs of one placed block as a single 2D section.
 *
 * Dilated by `dilationMm` ONLY when that does not close a counter: a mark cut
 * at 1.4 mm cap height needs 3.8 mm to survive a full nozzle-width dilation,
 * and widening it anyway turns every letter into a filled lozenge. A groove
 * that will not resolve at this nozzle is still a groove; an unreadable blob is
 * not a mark at all (`[V3-P7-A6]`).
 */
function blockSection(
  ctx: BuildContext,
  asset: GlyphFace,
  block: MarkBlock,
  placements: readonly T.Placement[],
  dilationMm: number,
): CrossSection | null {
  const areas: PreviewArea[] = [];
  block.lines.forEach((line, index) => {
    const placement = placements[index];
    if (placement === undefined) return;
    for (const area of glyphAreas(asset, line.text, line.sizeMm, 0)) {
      areas.push(placeArea(area, placement));
    }
  });
  const dense = sectionOf(ctx.wasm, ctx.arena, contoursFromAreas(areas));
  if (dense === null) return null;
  const raw = leanSection(ctx, dense);
  if (!(dilationMm > 0)) return raw;
  const before = holeCount(raw);
  const grown = raw.offset(dilationMm, ROUND, 2, 16);
  if (grown.isEmpty()) {
    grown.delete();
    return raw;
  }
  const kept = ctx.arena.keep(grown);
  if (holeCount(kept) < before) {
    ctx.arena.drop(kept);
    return raw;
  }
  ctx.arena.drop(raw);
  return kept;
}

/**
 * A glyph section flattened back to the tolerance the assets were drawn at.
 *
 * `lib/fonts/*.glyphs.json` is flattened to a 0.02 mm chord error at the
 * contract's LARGEST legal engraving size (8 mm), so a curve cut at 1.2 mm
 * carries six times the vertices its own chord error needs - and every one of
 * them becomes four triangles in the extrusion and then propagates through the
 * subtraction. Simplifying back to the asset's own 0.02 mm before extruding
 * takes 41 000 triangles off a default Chicago build and moves no point further
 * than the flattening already had (`[V3-P7-A7]`).
 */
function leanSection(ctx: BuildContext, section: CrossSection): CrossSection {
  const asset = loadedGlyphFace(ATTRIBUTION_FACE);
  const epsMm = asset?.flatten_tolerance_mm ?? 0;
  if (!(epsMm > 0)) return section;
  // `cleanSection` and not a bare `simplify`: the deburring opening is what
  // separates the pinch points a glyph outline carries where two curves meet
  // almost tangentially, and a pinch point extrudes into a zero-area side
  // triangle that no mesh repair downstream can remove (`manifold.DEBURR_MM`).
  // One of them survived into a Chicago tile before this call was here.
  return cleanSection(ctx.arena, section, epsMm);
}

/** The dilation this block would need to reach a printable stroke, mm. */
function dilationFor(ctx: BuildContext, block: MarkBlock): number {
  if (block.lines.length === 0) return 0;
  let widest = 0;
  for (const line of block.lines) {
    widest = Math.max(
      widest,
      T.text_dilation_mm(ATTRIBUTION_FACE, line.text, line.sizeMm, ctx.params, "engrave"),
    );
  }
  return widest;
}

/** True when this block's strokes are under what the nozzle can resolve. */
function underNozzle(ctx: BuildContext, block: MarkBlock): boolean {
  const target = T.text_stroke_target_mm(ctx.params, "engrave");
  for (const line of block.lines) {
    if (T.text_stem_em(ATTRIBUTION_FACE, line.text) * line.sizeMm < target) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Vertical walls
// ---------------------------------------------------------------------------

/**
 * One vertical face a mark can be engraved into.
 *
 * `normal` points AWAY from the material (out of the wall, toward whoever is
 * looking at it) and is one of the four axis directions. `signedOffsetMm` is
 * the signed distance from the origin to the wall plane along that normal, so
 * a frame opening (whose walls face inward) is negative and a plate side face
 * (whose walls face outward) is positive.
 */
export interface WallFace {
  label: string;
  /** Degrees, the Z part of the `rotate([90, 0, spinDeg])` that stands the text up. */
  spinDeg: number;
  signedOffsetMm: number;
  /** Along-wall span the text may use, mm. */
  spanMm: number;
  /** Z of the bottom and the top of the exposed wall, mm. */
  z0Mm: number;
  z1Mm: number;
}

/** `[nx, ny]` of the wall a `spinDeg` names. */
export function wallNormal(spinDeg: number): [number, number] {
  const theta = (spinDeg * Math.PI) / 180;
  // `rotate([90, 0, spin])` sends the local +z (the cutter's depth) to
  // `(sin, -cos)`, and the depth runs INTO the material, so the outward normal
  // is its negative.
  return [-Math.sin(theta), Math.cos(theta)];
}

/**
 * The four walls of the frame opening, or `[]` when there is no frame.
 *
 * The exposed wall is the topmost run of profile slabs that share the topmost
 * slab's inner inset, clipped to the material ABOVE the base top: a bevelled or
 * undercut profile has no vertical inner wall to speak of and reports a short
 * one, which the caller turns into a second underside mark instead
 * (`[V3-P7-A5]`).
 */
export function frameInnerWalls(ctx: BuildContext): WallFace[] {
  const frame = T.frame_geometry_mm(ctx.params);
  if (!frame.enabled) return [];
  const style = frameStyle(ctx.params);
  const slabs = profileSlabs(ctx, frameBottomMm(ctx), frame.bottom_mm, frame.top_mm);
  const top = slabs[slabs.length - 1];
  if (top === undefined) return [];
  let bottomMm = top.z0Mm;
  for (let i = slabs.length - 2; i >= 0; i -= 1) {
    if (Math.abs(slabs[i].innerDeltaMm - top.innerDeltaMm) > 1e-9) break;
    bottomMm = slabs[i].z0Mm;
  }
  const z0 = Math.max(bottomMm, frame.bottom_mm);
  const z1 = frame.top_mm;
  const innerHalf = frame.inner_half_mm + top.innerDeltaMm;
  const span = 2 * innerHalf - 2 * (cornerSetbackMm(style.corner, style.cornerRadiusMm) + WALL_MARK_END_MM);
  const sides: Array<[string, number]> = [
    ["south", 0],
    ["east", 90],
    ["north", 180],
    ["west", -90],
  ];
  return sides.map(([label, spinDeg]) => ({
    label,
    spinDeg,
    signedOffsetMm: -innerHalf,
    spanMm: span,
    z0Mm: z0,
    z1Mm: z1,
  }));
}

/** How far a corner style eats into the straight run of each wall, mm. */
function cornerSetbackMm(corner: FrameCorner, radiusMm: number): number {
  return corner === "square" ? 0 : Math.max(0, radiusMm);
}

/** The south outer side face of the base plate: where the microtext goes. */
export function baseOuterFace(ctx: BuildContext): WallFace {
  const half = ctx.plateHalfMm;
  const chamfer = Math.min(T.CHAMFER_MM, ctx.baseTopMm / 2, half / 2);
  return {
    label: "south",
    // The face at y = -half faces -y, so the cutter's depth runs +y: spin 180.
    spinDeg: 180,
    signedOffsetMm: half,
    spanMm: 2 * half - 2 * (chamfer + MICROTEXT_END_MM),
    z0Mm: chamfer,
    z1Mm: ctx.baseTopMm,
  };
}

/**
 * A block of text as a horizontal cutter standing on one vertical wall.
 *
 * The section is laid out in a local (u, v) plane and extruded along local +z,
 * then `rotate([90, 0, spin])` stands it up: local u becomes the along-wall
 * axis, local v becomes world Z and the extrusion becomes the depth into the
 * wall. Every wall's text is laid out MIRRORED, because a mirrored block seen
 * from the side the wall faces reads left to right - the same reason the
 * underside mark is mirrored.
 */
function wallCutter(
  ctx: BuildContext,
  section: CrossSection,
  wall: WallFace,
  depthMm: number,
  zBaseMm: number,
): Manifold | null {
  const { wasm, arena } = ctx;
  const solid = extrudeSection(wasm, arena, section, 0, depthMm + CUTTER_OVERSHOOT_MM);
  if (solid === null) return null;
  const [nx, ny] = wallNormal(wall.spinDeg);
  const reach = wall.signedOffsetMm + CUTTER_OVERSHOOT_MM;
  const stood = arena.keep(solid.rotate([90, 0, wall.spinDeg]));
  arena.drop(solid);
  const placed = arena.keep(stood.translate([reach * nx, reach * ny, zBaseMm]));
  arena.drop(stood);
  return placed;
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

export interface AttributionGeometry {
  /** Cutters into the base, from below and from the side. */
  baseCut: Manifold[];
  /** Cutters into the frame lip's inner wall. */
  frameCut: Manifold[];
  /**
   * The Z bands the marks occupy, `[low, high]` in engine millimetres.
   *
   * Declared, carried in the export sidecar and read back by the reference
   * validator (`services/bake/app/cli.py`, the `max_height_mm` pattern), which
   * excludes them from its STRUCTURAL minimum-wall probe and judges them by the
   * attribution row instead. See `[V3-P7-A8]` and the note on
   * `measure.measureMinWall`: a 0.11 mm ridge between two strokes of a 1.8 mm
   * engraving in the face of a 6 mm frame band is not a wall the nozzle has to
   * lay, it is surface texture on a block, and the marks are deliberately
   * finer than the nozzle because they are provenance.
   */
  bands: Array<[number, number]>;
}

/**
 * Everything the underside carries, laid out but not yet cut.
 *
 * One function, because the pieces constrain each other: the second mark takes
 * a strip along the west edge, the first block gives way to it in width AND
 * moves north to clear it in length, and `lettering.ts` has to be told how much
 * of the middle is spoken for before it lays the user's own underside lines
 * out. Pure: it touches no WASM handle and can be called for the reservation
 * alone.
 */
export interface UndersideLayout {
  mandatory: MarkBlock;
  /** The user's appended `underside_mark.template`, or an empty block. */
  user: MarkBlock;
  /** The second mandatory mark, present only when there is no frame wall. */
  second: MarkBlock | null;
  mandatoryCentreYMm: number;
  userCentreYMm: number;
  secondCentreMm: [number, number];
  /** `mandatory.heightMm + user.heightMm`: what the user's own lines clear. */
  reserveMm: number;
}

export function undersideLayout(
  ctx: BuildContext,
  date: string,
  expand: (text: string) => string,
  needsSecond: boolean,
): UndersideLayout {
  const { params } = ctx;
  const availableAll = T.underside_mark_available_mm(params);
  const half = availableAll / 2;
  const text = mandatoryText(date, ATTRIBUTION_FACE);
  // The strip the second mark reserves along the west edge: its widest possible
  // line pitch, so the two blocks are separated whatever the second mark's own
  // fit turns out to be.
  const strip = needsSecond ? MARK_LINE_PITCH * SECOND_MARK_CAP_MM + SECOND_MARK_GAP_MM : 0;
  // TWICE the strip: narrowing a CENTRED block by s moves its west edge east by
  // s / 2, and it is the west edge that has to clear the strip.
  const available = Math.max(0, availableAll - 2 * strip);
  const mandatory = layoutBlock(ATTRIBUTION_FACE, text, available, availableAll);
  const capMm = mandatory.lines[0]?.sizeMm ?? T.TEXT_MAX_SIZE_MM;
  const user = layoutBlock(
    ATTRIBUTION_FACE,
    userMarkText(params, expand),
    available,
    availableAll,
    capMm,
  );
  const reserveMm = mandatory.heightMm + user.heightMm;

  // With a frame wall to engrave the block is centred, exactly where the v2
  // underside mark was. Without one it moves to the north edge and the second
  // mark takes the west edge and the south.
  const top = needsSecond ? half : reserveMm / 2;
  const mandatoryCentreYMm = top - mandatory.heightMm / 2;
  const userCentreYMm = top - mandatory.heightMm - user.heightMm / 2;

  let second: MarkBlock | null = null;
  let secondCentreMm: [number, number] = [0, 0];
  if (needsSecond) {
    const lengthMm = Math.max(0, availableAll - reserveMm - SECOND_MARK_GAP_MM);
    second = layoutBlockToBand(
      text,
      lengthMm,
      MARK_LINE_PITCH * SECOND_MARK_CAP_MM,
      SECOND_MARK_CAP_MM,
    );
    secondCentreMm = [-(half - second.heightMm / 2), -half + second.widthMm / 2];
  }
  return {
    mandatory,
    user,
    second,
    mandatoryCentreYMm,
    userCentreYMm,
    secondCentreMm,
    reserveMm,
  };
}

/**
 * How much of the underside the mandatory marks take, mm.
 *
 * `lettering.ts` reserves it before laying the user's own `edge: "underside"`
 * engravings out, so a user line and the attribution can never land on top of
 * each other.
 */
export function undersideReserveMm(
  ctx: BuildContext,
  date: string,
  expand: (text: string) => string,
): number {
  return undersideLayout(ctx, date, expand, !hasEngravableWall(ctx)).reserveMm;
}

/**
 * Fit one line into a band `bandMm` tall, never refusing.
 *
 * `transform.fit_text` is the shared layout's own fit and it REFUSES below
 * 1.5 mm, which is right for a line the user asked for and wrong here: a 2 mm
 * frame wall wants about 1.4 mm and the mark is not optional, so the size is
 * taken straight from the band and the width (`[V3-P7-A6]`).
 */
function layoutBlockToBand(
  text: string,
  availableMm: number,
  bandMm: number,
  capMm: number = T.TEXT_MAX_SIZE_MM,
): MarkBlock {
  const [layable] = T.filter_text(ATTRIBUTION_FACE, text);
  if (layable.trim() === "" || !(availableMm > 0) || !(bandMm > 0)) {
    return { lines: [], widthMm: 0, heightMm: 0 };
  }
  const [topEm, bottomEm] = T.text_ink_em(ATTRIBUTION_FACE, layable);
  const inkEm = Math.max(1e-9, topEm - bottomEm);
  const advanceEm = Math.max(1e-9, T.text_advance_em(ATTRIBUTION_FACE, layable));
  const size = Math.min(capMm, T.TEXT_MAX_SIZE_MM, bandMm / inkEm, availableMm / advanceEm);
  if (!(size > 0)) return { lines: [], widthMm: 0, heightMm: 0 };
  const line = measure(ATTRIBUTION_FACE, layable, size);
  return { lines: [line], widthMm: line.widthMm, heightMm: MARK_LINE_PITCH * size };
}

/** Depth of the underside mark on this plate, and whether it was clamped. */
export function deepMarkDepthMm(ctx: BuildContext): { depthMm: number; clamped: boolean } {
  const budget = ctx.params.base_thickness_mm - deepestRecessMm(ctx);
  const roomy = budget - T.HANGER_MIN_ROOF_MM;
  if (roomy >= DEEP_MARK_DEPTH_MM) return { depthMm: DEEP_MARK_DEPTH_MM, clamped: false };
  if (roomy >= DEEP_MARK_MIN_DEPTH_MM) {
    return { depthMm: Number(roomy.toFixed(4)), clamped: true };
  }
  const tight = Math.min(DEEP_MARK_MIN_DEPTH_MM, budget - DEEP_MARK_MIN_ROOF_MM);
  return { depthMm: Number(Math.max(0, tight).toFixed(4)), clamped: true };
}

/**
 * The Z band the underside pockets occupy, for the min-wall probe to skip.
 *
 * The mandatory mark is cut on every build, so this is never empty, which is
 * exactly why it exists: a letter counter on the floor of a 0.5 mm pocket is an
 * island in a horizontal slice taken inside that pocket, and it persists upward
 * (the plate above it is solid), so the ordinary "is this a wall?" test calls it
 * a 0.44 mm wall. It is not a wall; it is the underside of a plate that is
 * 2.5 mm thick there. The reference validator excludes the same band for the
 * same stated reason (`[V3-P7-A8]`).
 */
export function undersideSkipBands(ctx: BuildContext): Array<[number, number]> {
  const pockets = T.underside_band_mm(ctx.params);
  const deepest = Math.max(deepMarkDepthMm(ctx).depthMm, pockets === null ? 0 : pockets[1]);
  return deepest > 0 ? [[0, deepest]] : [];
}

/** The frame walls tall enough to carry a mark. Empty with no frame. */
export function engravableWalls(ctx: BuildContext): WallFace[] {
  return frameInnerWalls(ctx).filter(
    (wall) => wall.z1Mm - wall.z0Mm >= WALL_MARK_MIN_HEIGHT_MM - 1e-9,
  );
}

/** True when this build has a frame wall the mark can go on. */
export function hasEngravableWall(ctx: BuildContext): boolean {
  return engravableWalls(ctx).length > 0;
}

function resolvedLine(
  id: string,
  text: string,
  surface: string,
  status: "cuts" | "skipped",
  depthMm: number,
  sizeMm: number,
  reason?: string,
): ResolvedLine {
  const line: ResolvedLine = { id, text, surface, mode: "engrave", status, depthMm, sizeMm };
  if (reason !== undefined) line.reason = reason;
  return line;
}

function info(
  id: string,
  title: string,
  detail: string,
  region: AuditFinding["region"],
): AuditFinding {
  return finding(id, "info", title, detail, region);
}

/** The wording both "this mark is finer than the nozzle" findings share. */
function fineStrokeDetail(ctx: BuildContext, what: string, sizeMm: number): string {
  return (
    `${what} is cut at ${sizeMm.toFixed(2)} mm, so its strokes are under the ` +
    `${T.text_stroke_target_mm(ctx.params, "engrave").toFixed(2)} mm a ` +
    `${ctx.params.nozzle_mm} mm nozzle lays down. It is provenance rather than a feature, ` +
    "so it is cut either way and it is in the file metadata as well; on this nozzle it " +
    "may not resolve on the print."
  );
}

/**
 * Every mandatory mark, as cutters.
 *
 * `expand` is the caller's token expander (`tokens.expand_tokens` bound to this
 * build's context), used ONLY for the user's appended line; nothing in the
 * mandatory text is tokenised.
 */
export function buildAttribution(
  ctx: BuildContext,
  date: string,
  expand: (text: string) => string,
): AttributionGeometry {
  const out: AttributionGeometry = { baseCut: [], frameCut: [], bands: [] };
  const asset = loadedGlyphFace(ATTRIBUTION_FACE);
  if (asset === null) {
    ctx.resolvedText.push(
      resolvedLine(
        "attribution-underside",
        mandatoryText(date),
        "Base underside, mandatory attribution",
        "skipped",
        DEEP_MARK_DEPTH_MM,
        0,
        `the ${ATTRIBUTION_FACE} font is not loaded`,
      ),
    );
    addFinding(
      ctx,
      finding(
        "attribution-not-cut",
        "error",
        "The attribution marks were not cut",
        `The ${ATTRIBUTION_FACE} glyph asset was not loaded before the build, so the ` +
          "mandatory attribution could not be engraved. This is a bug: report it rather " +
          "than sharing the file.",
        "base",
      ),
    );
    return out;
  }

  const walls = engravableWalls(ctx);
  const layout = undersideLayout(ctx, date, expand, walls.length === 0);
  for (const band of undersideSkipBands(ctx)) pushBand(ctx, out, band);
  cutUnderside(ctx, asset, layout, out);
  if (walls.length > 0) {
    cutFrameWall(ctx, asset, date, walls, out);
  } else {
    reportNoWall(ctx, date);
    cutSecondUnderside(ctx, asset, layout, out);
  }
  cutMicrotext(ctx, asset, date, out);
  return out;
}

/** The deep mark on the underside: mandatory text, then the user's line. */
function cutUnderside(
  ctx: BuildContext,
  asset: GlyphFace,
  layout: UndersideLayout,
  out: AttributionGeometry,
): void {
  const { mandatory, user } = layout;
  const { depthMm, clamped } = deepMarkDepthMm(ctx);
  cutBlock(ctx, asset, mandatory, 0, layout.mandatoryCentreYMm, 0, depthMm, out);
  ctx.resolvedText.push(
    resolvedLine(
      "attribution-underside",
      mandatory.lines.map((line) => line.text).join(" "),
      "Base underside, mandatory attribution",
      "cuts",
      depthMm,
      mandatory.lines[0]?.sizeMm ?? 0,
    ),
  );
  if (clamped) {
    addFinding(
      ctx,
      info(
        "attribution-mark-shallow",
        "The underside attribution is shallower than 0.6 mm",
        `A ${ctx.params.base_thickness_mm.toFixed(2)} mm plate with a ` +
          `${deepestRecessMm(ctx).toFixed(2)} mm recess above it cannot carry a 0.60 mm ` +
          `pocket and keep a millimetre of plate over it, so the mark is ` +
          `${depthMm.toFixed(2)} mm deep. A thicker base cuts it deeper.`,
        "base",
      ),
    );
  }
  // The plate is square, so its shorter side is its only side.
  const wanted = DEEP_MARK_MIN_SPAN_FRACTION * ctx.params.plate_mm;
  if (mandatory.widthMm < wanted) {
    addFinding(
      ctx,
      info(
        "attribution-span-short",
        "The underside attribution spans less of the plate than usual",
        `It measures ${mandatory.widthMm.toFixed(1)} mm against ${wanted.toFixed(1)} mm, ` +
          `which is ${Math.round(DEEP_MARK_MIN_SPAN_FRACTION * 100)} per cent of the plate. ` +
          "Sanding it out still takes material off most of the underside.",
        "base",
      ),
    );
  }

  // The user's own line, appended UNDER the mandatory text. Its resolved line
  // keeps the id `underside-mark` the rest of the engine already reads.
  if (user.lines.length === 0) return;
  cutBlock(ctx, asset, user, 0, layout.userCentreYMm, 0, depthMm, out);
  ctx.resolvedText.push(
    resolvedLine(
      "underside-mark",
      user.lines.map((line) => line.text).join(" "),
      "Base underside, your own line",
      "cuts",
      depthMm,
      user.lines[0]?.sizeMm ?? 0,
    ),
  );
}

/** One placed block as a pocket cut into the plate from below. */
function cutBlock(
  ctx: BuildContext,
  asset: GlyphFace,
  block: MarkBlock,
  centreXMm: number,
  centreYMm: number,
  rotationDeg: number,
  depthMm: number,
  out: AttributionGeometry,
): void {
  if (block.lines.length === 0) return;
  const placements = placeBlock(block, centreXMm, centreYMm, rotationDeg);
  const section = blockSection(ctx, asset, block, placements, dilationFor(ctx, block));
  if (section === null) return;
  const cutter = extrudeSection(ctx.wasm, ctx.arena, section, -CUTTER_OVERSHOOT_MM, depthMm);
  ctx.arena.drop(section);
  if (cutter !== null) out.baseCut.push(cutter);
}

/**
 * The mark engraved into the frame opening's vertical walls.
 *
 * EVERY qualifying wall gets a copy. The point of this mark is that a sanding
 * block cannot reach it, and four copies inside the opening cannot be taken out
 * without recutting the whole frame profile (`[V3-P7-A5]`).
 */
function cutFrameWall(
  ctx: BuildContext,
  asset: GlyphFace,
  date: string,
  walls: readonly WallFace[],
  out: AttributionGeometry,
): void {
  const wall = walls[0];
  const bandMm = Math.max(0, wall.z1Mm - wall.z0Mm - 2 * WALL_MARK_EDGE_MM);
  const block = layoutBlockToBand(mandatoryText(date, ATTRIBUTION_FACE), wall.spanMm, bandMm);
  if (block.lines.length === 0) return;
  const line = block.lines[0];
  // `placeBlock` centres the block's INK on the local origin and the local
  // origin becomes `zBase` once the cutter is stood up, so the mark sits in the
  // middle of the exposed band.
  const placements = placeBlock(block, 0, 0);
  const section = blockSection(ctx, asset, block, placements, 0);
  if (section === null) return;
  pushBand(ctx, out, inkBandMm(wall, line));
  // The cutter overshoots INTO the frame opening so its near face is never
  // coincident with the wall it is cutting - and the opening is exactly where
  // the city is, cropped flush to that same wall. Clipped to the lip's own
  // footprint it can only ever remove frame (`[V3-P7-A5]`); without the clip it
  // engraves the attribution into any building standing against the frame.
  const keep = framePrism(ctx);
  let cut = 0;
  for (const face of walls) {
    const raw = wallCutter(ctx, section, face, WALL_MARK_DEPTH_MM, (face.z0Mm + face.z1Mm) / 2);
    if (raw === null) continue;
    const cutter = keep === null ? raw : ctx.arena.keep(raw.intersect(keep));
    if (cutter !== raw) ctx.arena.drop(raw);
    if (cutter.isEmpty()) {
      ctx.arena.drop(cutter);
      continue;
    }
    out.frameCut.push(cutter);
    cut += 1;
  }
  if (keep !== null) ctx.arena.drop(keep);
  ctx.arena.drop(section);
  if (cut === 0) return;
  ctx.resolvedText.push(
    resolvedLine(
      "attribution-frame-wall",
      line.text,
      "Frame inner wall",
      "cuts",
      WALL_MARK_DEPTH_MM,
      line.sizeMm,
    ),
  );
  if (underNozzle(ctx, block)) {
    addFinding(
      ctx,
      info(
        "attribution-wall-mark-fine",
        "The frame inner-wall attribution is finer than this nozzle",
        `The wall is ${(wall.z1Mm - wall.z0Mm).toFixed(2)} mm tall, so ` +
          fineStrokeDetail(ctx, "the mark on it", line.sizeMm),
        "frame",
      ),
    );
  }
}

/**
 * The Z band one wall mark's INK occupies, `[low, high]` mm.
 *
 * The ink, not the wall: skipping the whole 2 mm lip would take the frame's own
 * minimum-wall coverage with it, and the only thing that has to be excluded is
 * the height where the strokes are.
 */
function pushBand(
  ctx: BuildContext,
  out: AttributionGeometry,
  band: [number, number],
): void {
  out.bands.push(band);
  ctx.markBands.push(band);
}

function inkBandMm(wall: WallFace, line: MarkLine): [number, number] {
  const centre = (wall.z0Mm + wall.z1Mm) / 2;
  const half = (line.inkTopMm - line.inkBottomMm) / 2 + BAND_MARGIN_MM;
  return [Math.max(0, centre - half), centre + half];
}

/** The frame lip's own volume, as a solid to clip a wall cutter to. */
function framePrism(ctx: BuildContext): Manifold | null {
  const frame = T.frame_geometry_mm(ctx.params);
  if (!frame.enabled) return null;
  const ring = frameRingSection(ctx);
  if (ring === null) return null;
  const solid = extrudeSection(
    ctx.wasm,
    ctx.arena,
    ring,
    frameBottomMm(ctx),
    frame.top_mm,
  );
  ctx.arena.drop(ring);
  return solid;
}

/** Say, in the Issues list, why there is a second underside mark. */
function reportNoWall(ctx: BuildContext, date: string): void {
  if (!ctx.params.frame) {
    ctx.resolvedText.push(
      resolvedLine(
        "attribution-frame-wall",
        mandatoryText(date),
        "Frame inner wall",
        "skipped",
        WALL_MARK_DEPTH_MM,
        0,
        "there is no frame, so a second underside mark was cut instead",
      ),
    );
    return;
  }
  const walls = frameInnerWalls(ctx);
  const height = walls.length === 0 ? 0 : walls[0].z1Mm - walls[0].z0Mm;
  ctx.resolvedText.push(
    resolvedLine(
      "attribution-frame-wall",
      mandatoryText(date),
      "Frame inner wall",
      "skipped",
      WALL_MARK_DEPTH_MM,
      0,
      `this frame profile leaves ${height.toFixed(2)} mm of vertical inner wall against ` +
        `the ${WALL_MARK_MIN_HEIGHT_MM.toFixed(1)} mm a mark needs`,
    ),
  );
  addFinding(
    ctx,
    info(
      "attribution-frame-wall-unavailable",
      "The frame profile has no wall to engrave",
      `Its vertical inner wall measures ${height.toFixed(2)} mm, under the ` +
        `${WALL_MARK_MIN_HEIGHT_MM.toFixed(1)} mm the attribution mark needs, so a second ` +
        "underside mark was cut instead.",
      "frame",
    ),
  );
}

/** The second underside mark, cut when there is no frame wall to engrave. */
function cutSecondUnderside(
  ctx: BuildContext,
  asset: GlyphFace,
  layout: UndersideLayout,
  out: AttributionGeometry,
): void {
  const block = layout.second;
  if (block === null || block.lines.length === 0) return;
  const { depthMm } = deepMarkDepthMm(ctx);
  // Turned 90 degrees and pushed into the far corner from the first mark, which
  // took the north edge (`[V3-P7-A5]`).
  cutBlock(
    ctx,
    asset,
    block,
    layout.secondCentreMm[0],
    layout.secondCentreMm[1],
    90,
    depthMm,
    out,
  );
  ctx.resolvedText.push(
    resolvedLine(
      "attribution-underside-2",
      block.lines[0].text,
      "Base underside, second mandatory attribution",
      "cuts",
      depthMm,
      block.lines[0].sizeMm,
    ),
  );
}

/** The 1.2 mm line on the base's outer side face. */
function cutMicrotext(
  ctx: BuildContext,
  asset: GlyphFace,
  date: string,
  out: AttributionGeometry,
): void {
  const wall = baseOuterFace(ctx);
  const text = mandatoryText(date, ATTRIBUTION_FACE);
  const [layable] = T.filter_text(ATTRIBUTION_FACE, text);
  const wanted = measure(ATTRIBUTION_FACE, layable, MICROTEXT_CAP_MM);
  const bandMm = wall.z1Mm - wall.z0Mm;
  const fits =
    wanted.widthMm <= wall.spanMm && wanted.inkTopMm - wanted.inkBottomMm <= bandMm;
  // A plate too small for a 1.2 mm line along its own edge still has to carry
  // the mark, so it is scaled down to what the edge holds.
  const block = fits
    ? {
        lines: [wanted],
        widthMm: wanted.widthMm,
        heightMm: MARK_LINE_PITCH * wanted.sizeMm,
      }
    : layoutBlockToBand(text, wall.spanMm, bandMm, MICROTEXT_CAP_MM);
  if (block.lines.length === 0) return;
  const line = block.lines[0];
  const placements = placeBlock(block, 0, 0);
  const section = blockSection(ctx, asset, block, placements, 0);
  if (section === null) return;
  pushBand(ctx, out, inkBandMm(wall, line));
  const cutter = wallCutter(
    ctx,
    section,
    wall,
    MICROTEXT_DEPTH_MM,
    (wall.z0Mm + wall.z1Mm) / 2,
  );
  ctx.arena.drop(section);
  if (cutter !== null) out.baseCut.push(cutter);
  ctx.resolvedText.push(
    resolvedLine(
      "attribution-microtext",
      line.text,
      "Base edge, microtext",
      "cuts",
      MICROTEXT_DEPTH_MM,
      line.sizeMm,
    ),
  );
  if (underNozzle(ctx, block)) {
    addFinding(
      ctx,
      info(
        "attribution-microtext-fine",
        "The edge microtext is finer than this nozzle",
        `${fineStrokeDetail(ctx, "The microtext on the plate edge", line.sizeMm)} Cropping ` +
          "it off would change the plate's outer dimensions, which is the point of it.",
        "base",
      ),
    );
  }
}
