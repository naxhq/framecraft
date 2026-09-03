/**
 * Frame lettering and ornaments -> flat contours, in PRINT MILLIMETRES.
 *
 * This is the SHARED lettering shape layer. The engine's own `solid/lettering`,
 * `solid/frame`, `solid/ornaments`, `solid/attribution` and `solid/tiling` all
 * extrude the contours `glyphAreas`, `placeArea`, `northArrowArea` and
 * `scaleBarAreas` produce here, so the letterforms the editor counts are the
 * letterforms the model carries.
 *
 * Since v3.1 nothing in the viewport DRAWS these: the engine cuts the real
 * pockets and the preview shows those. What the editor still needs from
 * `buildPreviewText` is what the shared layout has to SAY about a text before
 * a run finishes -- how many rings it produces (the viewport publishes the
 * count), which faces it needs, and every refusal, auto-fit and dropped
 * character it reports -- because those answers must be on screen the moment
 * the user types, not seconds later.
 *
 * Rules:
 *
 * 1. **No layout maths of its own.** Every size, anchor, rotation, refusal and
 *    warning comes from `transform.lettering_layout`, the mirror of
 *    `app/geom/transform.py`. This module turns those numbers into *shapes*
 *    -- glyph outlines, an arrowhead, a bar, a keyhole -- and nothing else. A
 *    string the editor shows on the bottom edge at 4.28 mm is cut on the bottom
 *    edge at 4.28 mm, or the editor is lying.
 * 2. **No booleans.** The keyhole is built as ONE analytic outline (two arcs and
 *    two tangents) rather than as a union of a circle, a box and a circle, and
 *    the text is never clipped to the lip band -- the auto-fit already
 *    guarantees it fits.
 * 3. **No three.js.** Output is plain `PreviewArea` records, so this is
 *    importable from the worker and `previewText.test.ts` can check it in node.
 */

import type { PrintParams, SceneGraph } from "./contracts";
import type { EngineBuilding } from "./engine/osm/types";
import { loadedGlyphFace, type GlyphFace, type GlyphPart } from "./fontGlyphs";
import { heroTokenInfo } from "./heroes";
import type { PreviewArea } from "./preview";
import type { TokenContext } from "./tokens";
import * as T from "./transform";

/** How a piece of lettering reads on the model. */
export type TextTone = "engraved" | "embossed" | "pocket";

/** Which face of the plate a piece is drawn on. */
export type TextFace = "top" | "bottom";

/** One drawable piece: a string, an ornament, or a pocket footprint. */
export interface PreviewTextPiece {
  /** Stable per piece, so React keys and test ids are meaningful. */
  id: string;
  tone: TextTone;
  face: TextFace;
  areas: PreviewArea[];
}

export interface PreviewTextModel {
  pieces: PreviewTextPiece[];
  /**
   * Faces the layout names whose outlines have not been fetched yet. The caller
   * loads them and rebuilds; nothing is drawn from a face that is not in memory
   * (drawing it at the wrong metrics would be worse than drawing nothing).
   */
  missingFaces: string[];
  /**
   * The shared math's own messages: auto-fitted sizes, dropped characters,
   * refusals, and the "the frame is off" line. Informational, verbatim -- these
   * are the strings the build reports for the same parameters.
   */
  notices: string[];
  /** Rings actually drawn. The HUD publishes it so an e2e can see the text. */
  shapeCount: number;
}

const EMPTY_MODEL: PreviewTextModel = {
  pieces: [],
  missingFaces: [],
  notices: [],
  shapeCount: 0,
};

// ---------------------------------------------------------------------------
// Rings
// ---------------------------------------------------------------------------

type Ring = ReadonlyArray<ReadonlyArray<number>>;

/** Twice the signed area of an implicitly-closed ring; > 0 is counter-clockwise. */
function signedArea2(ring: Ring): number {
  let total = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    total += a[0] * b[1] - b[0] * a[1];
  }
  return total;
}

/** The same ring, wound counter-clockwise. */
function toCcw(ring: Ring): number[][] {
  const points = ring.map((p) => [p[0], p[1]]);
  return signedArea2(points) < 0 ? points.reverse() : points;
}

/**
 * How far a mitre may run past the offset distance before it is cut back.
 *
 * A spur or a very sharp serif has an interior angle near zero, where the exact
 * mitre length goes to infinity; clamping it is what stops a 0.15 mm dilation
 * from growing a two-millimetre spike out of the corner of a `w`.
 */
export const MITRE_LIMIT = 3.0;

/**
 * Offset one counter-clockwise ring by `distance` (positive = outward).
 *
 * The cheap client-side stand-in for 04 stage 1's glyph dilation, in the same
 * spirit as `preview.buildBuildings`'s footprint dilation: each vertex moves
 * along the bisector of its two edge normals, with a mitre limit. It is not a
 * true polygon offset -- a deep enough concavity self-intersects -- so the
 * result is checked and the original ring is kept when the offset turned the
 * ring inside out. That is the right failure mode for a preview: a slightly
 * thin letter, never a knot.
 */
export function offsetRing(ring: Ring, distance: number): number[][] {
  const points = ring.map((p) => [p[0], p[1]]);
  if (distance === 0 || points.length < 3) return points;

  const count = points.length;
  const out: number[][] = [];
  for (let i = 0; i < count; i += 1) {
    const previous = points[(i - 1 + count) % count];
    const current = points[i];
    const next = points[(i + 1) % count];

    // Outward normal of a CCW ring is to the RIGHT of the travel direction.
    const inNormal = rightNormal(previous, current);
    const outNormal = rightNormal(current, next);
    if (inNormal === null || outNormal === null) {
      out.push([current[0], current[1]]);
      continue;
    }
    let bx = inNormal[0] + outNormal[0];
    let by = inNormal[1] + outNormal[1];
    const length = Math.hypot(bx, by);
    if (length < 1e-9) {
      // A 180 degree reversal: no bisector exists, so keep the vertex.
      out.push([current[0], current[1]]);
      continue;
    }
    bx /= length;
    by /= length;
    // 1 / cos(half the turn) is the exact mitre length for this bisector.
    const cosHalf = bx * inNormal[0] + by * inNormal[1];
    const scale = Math.min(MITRE_LIMIT, cosHalf > 1e-6 ? 1 / cosHalf : MITRE_LIMIT);
    out.push([current[0] + bx * distance * scale, current[1] + by * distance * scale]);
  }

  // The guard.
  //
  // A ring pushed further than its own inradius does NOT come back wound the
  // other way -- every vertex crosses to the far side and the traversal keeps
  // its rotational direction -- so a winding test alone passes a knot. What
  // does catch it is the area moving the wrong way: growing a ring can only
  // enlarge it and shrinking one can only shrink it, and a shrink that came
  // back bigger has folded through itself.
  const before = signedArea2(points);
  const after = signedArea2(out);
  if (after === 0 || Math.sign(after) !== Math.sign(before)) return points;
  if (distance > 0 && Math.abs(after) <= Math.abs(before)) return points;
  if (distance < 0 && Math.abs(after) >= Math.abs(before)) return points;
  return out;
}

function rightNormal(a: number[], b: number[]): [number, number] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-12) return null;
  return [dy / length, -dx / length];
}

/** Flatten a ring to the `[x0,y0,x1,y1,...]` contour `PreviewArea` carries. */
function flatten(ring: Ring): number[] {
  const out: number[] = [];
  for (const point of ring) out.push(point[0], point[1]);
  return out;
}

// ---------------------------------------------------------------------------
// Placement: mirror, rotate, translate -- `lettering.place()`, verbatim
// ---------------------------------------------------------------------------

/**
 * The build's `place()`: mirror in the LOCAL frame first, then rotate CCW by
 * `rotation_deg`, then translate to the anchor. Mirroring first is what makes
 * the underside mark read correctly once the plate is turned over.
 */
export function placeArea(area: PreviewArea, placement: T.Placement): PreviewArea {
  const theta = (placement.rotation_deg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const sx = placement.mirror_x ? -1 : 1;
  const apply = (contour: number[]): number[] => {
    const out = new Array<number>(contour.length);
    for (let i = 0; i < contour.length; i += 2) {
      const x = contour[i] * sx;
      const y = contour[i + 1];
      out[i] = cos * x - sin * y + placement.anchor_x;
      out[i + 1] = sin * x + cos * y + placement.anchor_y;
    }
    return out;
  };
  return { outer: apply(area.outer), holes: area.holes.map(apply) };
}

function placeAll(
  areas: ReadonlyArray<PreviewArea>,
  placement: T.Placement,
): PreviewArea[] {
  return areas.map((area) => placeArea(area, placement));
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

function partToArea(
  part: GlyphPart,
  factor: number,
  dx: number,
  dilation_mm: number,
): PreviewArea {
  const scaleRing = (ring: Ring): number[][] =>
    ring.map((p) => [p[0] * factor + dx, p[1] * factor]);
  const shell = offsetRing(toCcw(scaleRing(part.shell)), dilation_mm);
  const holes = part.holes.map((hole) =>
    offsetRing(toCcw(scaleRing(hole)), -dilation_mm),
  );
  return { outer: flatten(shell), holes: holes.map(flatten) };
}

/**
 * One string as flat areas in its LOCAL frame: laid out along +x from the
 * origin, baseline on y = 0 -- `lettering.text_polygons_mm`, in the browser.
 *
 * The advance widths come from `transform.font_metrics` (the same table the fit
 * was computed from) and never from the outline asset, so a glyph whose ink is
 * wider than its advance still advances by exactly what the build advanced by.
 */
export function glyphAreas(
  asset: GlyphFace,
  text: string,
  size_mm: number,
  dilation_mm = 0,
): PreviewArea[] {
  const metrics = T.font_metrics(asset.face);
  const factor = size_mm / asset.units_per_em;
  const out: PreviewArea[] = [];
  let pen = 0;
  for (const ch of text) {
    const code = String(ch.codePointAt(0) ?? -1);
    const glyph = asset.glyphs[code];
    const advance = metrics.glyphs[code]?.adv ?? 0;
    if (glyph !== undefined) {
      for (const part of glyph) {
        if (part.shell.length < 3) continue;
        out.push(partToArea(part, factor, pen * factor, dilation_mm));
      }
    }
    pen += advance;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ornaments
// ---------------------------------------------------------------------------

/**
 * The north arrow in its local frame: +y is north, centred on the origin.
 * `lettering.north_arrow_polygon`, the same four points.
 */
export function northArrowArea(size_mm: number): PreviewArea {
  const halfW = (T.NORTH_ARROW_WIDTH_RATIO * size_mm) / 2;
  const halfL = size_mm / 2;
  const notch = -halfL + T.NORTH_ARROW_NOTCH_RATIO * size_mm;
  return {
    outer: flatten(
      toCcw([
        [0, halfL],
        [halfW, -halfL],
        [0, notch],
        [-halfW, -halfL],
      ]),
    ),
    holes: [],
  };
}

function box(x0: number, y0: number, x1: number, y1: number): PreviewArea {
  return {
    outer: flatten([
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ]),
    holes: [],
  };
}

/**
 * The bar and its two end ticks, in the bar's local frame -- `lettering
 * .scale_bar_rules`: +x along the edge from the bar's left end, the origin on
 * the band's centre line.
 */
export function scaleBarAreas(layout: T.ScaleBarLayout): PreviewArea[] {
  const halfT = layout.thickness_mm / 2;
  const halfTick = layout.tick_mm / 2;
  const out = [box(0, -halfT, layout.bar_mm, halfT)];
  for (const x of [0, layout.bar_mm]) {
    out.push(box(x - halfT, -halfTick, x + halfT, halfTick));
  }
  return out;
}

/** Segments per full circle, matching the build's `buffer(quad_segs=16)`. */
export const CIRCLE_SEGMENTS = 64;

function circle(cx: number, cy: number, r: number): PreviewArea {
  const ring: number[][] = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i += 1) {
    const angle = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    ring.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
  }
  return { outer: flatten(ring), holes: [] };
}

/**
 * The keyhole hanger's footprint, in plate mm, as ONE closed outline.
 *
 * The build unions a circle, a box and a second circle; the browser never runs a
 * boolean, so the same shape is walked analytically instead: the long arc round
 * the bottom of the 8 mm entry, up the right side of the slot, over the slot's
 * rounded end, and down the left side. Exact up to the polygonal arcs -- the
 * slot is narrower than the entry, so the two sides really are vertical lines
 * between the two arcs, and the only departure from the true union is one
 * chord's sagitta of a 64-gon (0.005 mm on the entry).
 *
 * The angle is `acos`, not `asin`. The slot's straight sides are the vertical
 * lines `x = cx +/- half`, and a vertical line meets the entry circle where
 * `cos(angle) = half / radius` -- 60 degrees for a 4 mm slot in an 8 mm entry,
 * not 30. With `asin` the arc terminated at `(cx + 3.464, cy + 2)`, which is
 * not on the slot's side at all, and the segment to the cap was a slanted
 * chord: 0.93 mm of radial error against the build's union, by two orders of
 * magnitude the largest preview-vs-build error in the phase (audit v2-06
 * finding 2).
 */
export function keyholeArea(params: PrintParams): PreviewArea {
  const [cx, cy] = T.keyhole_center_mm(params);
  const radius = T.KEYHOLE_HOLE_D_MM / 2;
  const half = T.KEYHOLE_SLOT_W_MM / 2;
  const top = cy + T.KEYHOLE_SLOT_LEN_MM;
  // Where the slot's straight sides meet the entry circle.
  const theta = Math.acos(Math.min(1, half / radius));
  const ring: number[][] = [];

  // The entry, the long way round: from 180 - theta CCW past the bottom to theta.
  const from = Math.PI - theta;
  const to = 2 * Math.PI + theta;
  // `ceil`, not `round`: the arc spans 300 degrees, which is not a whole number
  // of 64-gon steps, and rounding DOWN would make each chord longer than the
  // 64-gon's and push the sagitta past the tolerance the tests are written
  // against. Rounding up can only make the arc finer than the circles the rest
  // of this module draws.
  const steps = Math.max(8, Math.ceil((CIRCLE_SEGMENTS * (to - from)) / (Math.PI * 2)));
  for (let i = 0; i <= steps; i += 1) {
    const angle = from + ((to - from) * i) / steps;
    ring.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
  }
  // Up the right side and over the slot's rounded end, 0 -> 180 degrees.
  const capSteps = Math.max(6, CIRCLE_SEGMENTS / 2);
  for (let i = 0; i <= capSteps; i += 1) {
    const angle = (Math.PI * i) / capSteps;
    ring.push([cx + Math.cos(angle) * half, top + Math.sin(angle) * half]);
  }
  return { outer: flatten(toCcw(ring)), holes: [] };
}

/** The four magnet pockets, in plate mm. */
export function magnetAreas(params: PrintParams): PreviewArea[] {
  return T.magnet_centers_mm(params).map(([x, y]) =>
    circle(x, y, T.MAGNET_D_MM / 2),
  );
}

// ---------------------------------------------------------------------------
// The token context the layout expands strings with
// ---------------------------------------------------------------------------

/**
 * What `{city}`, `{scale}`, `{coords}` and the rest read for THIS scene.
 *
 * `date` is an argument, never `new Date()` here: the token table is a mirrored
 * pair and a function of the clock could not be pinned by a fixture
 * (DECISIONS [V2-P2]).
 */
export function textTokenContext(
  graph: SceneGraph | null,
  params: PrintParams,
  date: string,
): TokenContext {
  const radius_m = graph ? T.radius_m_from_bounds(graph.bounds) : 0;
  // `graph.buildings` is structurally an `EngineBuilding[]` at runtime (the
  // engine's `EngineSceneGraph` is a superset of the frozen `SceneGraph`
  // contract this store field is typed as) -- see `lib/engine/osm/types.ts`.
  const hero = heroTokenInfo(graph ? (graph.buildings as EngineBuilding[]) : undefined, params);
  return {
    lat: graph ? graph.center.lat : 0,
    lon: graph ? graph.center.lon : 0,
    scale_mm_per_m: graph && radius_m > 0 ? T.scale_mm_per_m(params, radius_m) : 0,
    radius_m,
    date,
    buildings: graph ? graph.stats.building_count : 0,
    city: params.city_label ?? "",
    country: params.place?.country ?? "",
    state: params.place?.state ?? "",
    neighbourhood: params.place?.neighbourhood ?? "",
    author: params.place?.author ?? "",
    hero_count: hero.count,
    hero_name: hero.name ?? undefined,
  };
}

/**
 * The memo key for everything below: the exact parameters that move a LAYOUT,
 * as one string.
 *
 * A string rather than the nested objects themselves, for the reason
 * `CityPreview.previewDeps` exists at all: `store.setParam` rebuilds `params`
 * by spread on every write, and a dependency has to be identity-stable across
 * writes that did not touch it. Strings compare by value, so a height slider
 * produces the same key and the text is not rebuilt -- which is the guarantee
 * `CityPreview.test.ts` asserts.
 */
export function textParamsKey(params: PrintParams): string {
  return JSON.stringify([
    params.plate_mm,
    params.frame,
    params.nozzle_mm,
    params.city_label ?? "",
    params.place ?? null,
    (params.hero_building_ids ?? []).join(","),
    params.hero_auto ?? null,
    params.engravings ?? [],
    params.north_arrow ?? null,
    params.scale_bar ?? null,
    params.underside_mark ?? null,
    params.hanger ?? "none",
  ]);
}

/** Which glyph faces a given parameter set will ask for. */
export function facesNeeded(params: PrintParams): string[] {
  const out = new Set<string>();
  if (params.frame) {
    for (const engraving of params.engravings ?? []) {
      out.add(engraving.font ?? T.ENGRAVING_DEFAULT_FACE);
    }
    if (params.scale_bar?.enabled) out.add(T.SCALE_BAR_FACE);
  }
  if (params.underside_mark?.enabled) out.add(T.UNDERSIDE_MARK_FACE);
  return [...out];
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

/** Look one glyph asset up; the default reads the module cache. */
export type FaceLookup = (face: string) => GlyphFace | null;

/**
 * Every piece of text and every ornament, as flat areas on the plate.
 *
 * `rotation_deg` is the SceneRequest's rotation: the model is turned CCW by it,
 * so the north arrow is turned back by the same amount and keeps pointing at
 * true north, exactly as `transform.north_arrow_layout` computes it.
 */
export function buildPreviewText(
  params: PrintParams,
  ctx: TokenContext,
  rotation_deg = 0,
  lookup: FaceLookup = loadedGlyphFace,
): PreviewTextModel {
  const layout = T.lettering_layout(params, ctx, rotation_deg);
  const frame_available = T.frame_text_available(params);
  const pieces: PreviewTextPiece[] = [];
  const missing = new Set<string>();

  const textPiece = (
    id: string,
    fit: T.TextFit,
    placement: T.Placement,
    tone: TextTone,
    face: TextFace,
    localOffset: [number, number] = [0, 0],
  ): void => {
    if (fit.refused || fit.text.trim() === "") return;
    const asset = lookup(fit.face);
    if (asset === null) {
      missing.add(fit.face);
      return;
    }
    let areas = glyphAreas(asset, fit.text, fit.size_mm, fit.dilation_mm);
    if (localOffset[0] !== 0 || localOffset[1] !== 0) {
      areas = areas.map((area) => shift(area, localOffset[0], localOffset[1]));
    }
    const placed = placeAll(areas, placement);
    if (placed.length > 0) pieces.push({ id, tone, face, areas: placed });
  };

  // Edge engravings live on the lip, so the frame toggle gates them exactly as
  // it gates the arrow and the bar (`transform.north_arrow_layout` and
  // `scale_bar_layout` take `have_frame`; the engraving loop does not, because
  // the layout still has to MEASURE them to warn about them). With no frame
  // there is nothing at `lip_top` for the build's cutter to cut, which is what
  // its "the frame is off ... turn the frame on to print them" warning says --
  // so drawing the letters here would float them 2 mm above an empty plate.
  if (frame_available) {
    for (const engraving of layout.engravings) {
      textPiece(
        `engraving-${engraving.index}`,
        engraving.fit,
        engraving.placement,
        engraving.mode === "emboss" ? "embossed" : "engraved",
        "top",
      );
    }
  }

  if (layout.north_arrow.enabled) {
    pieces.push({
      id: "north-arrow",
      tone: "engraved",
      face: "top",
      areas: placeAll(
        [northArrowArea(layout.north_arrow.size_mm)],
        layout.north_arrow.placement,
      ),
    });
  }

  const bar = layout.scale_bar;
  if (bar.enabled) {
    pieces.push({
      id: "scale-bar",
      tone: "engraved",
      face: "top",
      areas: placeAll(scaleBarAreas(bar), bar.placement),
    });
    if (bar.label_fit !== null) {
      // `lettering.scale_bar_label_glyphs`: the label follows the bar by one
      // ornament gap, and its own dilation shifts the pen the same way an
      // engraving's does.
      textPiece(
        "scale-bar-label",
        bar.label_fit,
        bar.placement,
        "engraved",
        "top",
        [
          bar.bar_mm + T.ORNAMENT_GAP_MM + bar.label_fit.dilation_mm,
          -(bar.label_fit.ink_top_mm + bar.label_fit.ink_bottom_mm) / 2,
        ],
      );
    }
  }

  const mark = layout.underside_mark;
  if (mark.enabled && mark.fit !== null) {
    textPiece("underside-mark", mark.fit, mark.placement, "engraved", "bottom");
  }

  const hanger = params.hanger ?? "none";
  if (hanger === "keyhole") {
    pieces.push({
      id: "keyhole",
      tone: "pocket",
      face: "bottom",
      areas: [keyholeArea(params)],
    });
  } else if (hanger === "magnets") {
    pieces.push({
      id: "magnets",
      tone: "pocket",
      face: "bottom",
      areas: magnetAreas(params),
    });
  }

  // The empty case is a shared constant so a scene with nothing written on it
  // hands the same object back every time and no memo below it re-runs. The
  // `missing` guard is load-bearing: a face that has not been fetched yet
  // produces no pieces and often no warning either, and short-circuiting there
  // would drop the very list the caller loads from.
  if (pieces.length === 0 && layout.warnings.length === 0 && missing.size === 0) {
    return EMPTY_MODEL;
  }

  let shapeCount = 0;
  for (const piece of pieces) shapeCount += piece.areas.length;
  return {
    pieces,
    missingFaces: [...missing],
    notices: layout.warnings,
    shapeCount,
  };
}

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

// ---------------------------------------------------------------------------
// Where each piece is drawn
// ---------------------------------------------------------------------------
