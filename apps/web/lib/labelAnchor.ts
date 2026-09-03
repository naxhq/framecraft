/**
 * Surface labels: the anchor model, in one place (Task 12).
 *
 * A label is not stored where it sits on the plate. It is stored where it
 * sits on its TARGET: a fraction `u` along the target's principal axis, a
 * fraction `v` across it, and a reading angle measured from that axis. The
 * target is a building, a road, a water body or a green area, named by its
 * base OSM element id. Everything that turns those numbers into millimetres
 * on the plate is here, so the engine stage that cuts the glyphs
 * (`engine/solid/labels.ts`) and the viewport gizmo that drags them
 * (`components/scene/LabelGizmo.tsx`) cannot disagree about where a label is.
 *
 * Two kinds of frame, one interface:
 *
 *  - a POLYGON target (a building footprint, a water or green ring) uses its
 *    minimum-area oriented rectangle (`preview.minAreaRect`): `u` runs along
 *    the rectangle's long side, `v` across it, rotation 0 reads along the long
 *    side. Rotating the footprint rotates the frame with it, which is what
 *    makes `u`, `v` and the rotation survive a SceneRequest rotation.
 *  - a ROAD target uses its centreline: `u` is a fraction of the arc length,
 *    `v` a fraction across the printed ribbon (0.5 on the centreline), rotation
 *    0 reads along the local tangent. `follow` sets each glyph on the path
 *    (`followPlan`), with a stated curvature test and a straight fallback.
 *
 * Pure: no manifold, no three.js, no store. Units are whatever the frame was
 * built in; `frameOf` builds one in print millimetres from a scene in metres.
 */

import type { AreaFeature, Building, Label, Point, PrintParams, Road, SceneGraph } from "./contracts";
import { PARAM_LIMITS, PARAM_RANGES } from "./contracts";
import { sourceOsmId } from "./objectInfo";
import { minAreaRect } from "./preview";
import * as T from "./transform";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** `print_params.json` -> `labels.maxItems`, from the GENERATED contract. */
export const LABEL_CAP: number = PARAM_LIMITS.labels.max_items;

/** `labels[].text.maxLength`, likewise. */
export const LABEL_TEXT_MAX: number = PARAM_LIMITS.labels.text.max_length;

/** A rotation this close to a multiple of 90 degrees snaps onto it. */
export const SNAP_ANGLE_DEG = 7.5;

/** An anchor this close to the target's centre (0.5) snaps onto it. */
export const SNAP_ANCHOR = 0.04;

/** Arrow key nudge, mm, plain and with Shift. */
export const NUDGE_MM = 0.5;
export const NUDGE_LARGE_MM = 2.0;

/** Bracket key rotation, degrees, plain and with Shift. */
export const ROTATE_STEP_DEG = 5;
export const ROTATE_STEP_LARGE_DEG = 15;

/** Plus and minus key resize, mm of cap height, plain and with Shift. */
export const SCALE_STEP_MM = 0.25;
export const SCALE_STEP_LARGE_MM = 1.0;

/**
 * The curvature test for `follow` (documented in docs/handoff/v3-12-labels.md).
 *
 * Each glyph sits on the chord of its own advance. Between two neighbouring
 * chords the reading direction may turn at most {@link FOLLOW_MAX_TURN_DEG};
 * over the whole label it may turn at most {@link FOLLOW_MAX_TOTAL_TURN_DEG}
 * (so a name never wraps back on itself); and at every join the radius of
 * curvature implied by the turn, `advance / turn`, must be at least the cap
 * height, which is the condition for the inside edge of the glyph box to keep
 * positive length (a box of height h turned by t loses `h * t` of its advance
 * on the inside). Fail any of the three and the label is set straight.
 */
export const FOLLOW_MAX_TURN_DEG = 30;
export const FOLLOW_MAX_TOTAL_TURN_DEG = 120;

/** Two scene points closer than this, metres, are the same vertex. */
const CHAIN_EPS_M = 1e-6;

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export type LabelLayer = Label["layer"];

export interface LabelTarget {
  layer: LabelLayer;
  /** The base OSM element id the label names. */
  osmId: string;
  /** The OSM name, or null when the object carries none. */
  name: string | null;
  /** Polygon targets: the outer ring, scene metres. Null for a road. */
  ring: Point[] | null;
  /** Polygon targets: the holes, scene metres. Empty for a road. */
  holes: Point[][];
  /** Road targets: the centreline, chained across the crop's parts, scene metres. */
  path: Point[] | null;
  /** Road targets: the road the width and class are read from. */
  road: Road | null;
}

function buildingByOsmId(scene: SceneGraph, osmId: string): Building | null {
  for (const building of scene.buildings) {
    if (sourceOsmId(building) === osmId) return building;
  }
  return null;
}

function areaByOsmId(features: readonly AreaFeature[], osmId: string): AreaFeature | null {
  for (const feature of features) {
    if (feature.osm_id === osmId) return feature;
  }
  return null;
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a[0] - b[0]) < CHAIN_EPS_M && Math.abs(a[1] - b[1]) < CHAIN_EPS_M;
}

function pathLength(path: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  return total;
}

/**
 * The parts of one OSM way, joined end to end.
 *
 * A crop can split a way into several SceneGraph roads (`w12-1`, `w12-2`), and
 * a label wants the whole street. Starting from the longest part, a part whose
 * first point is the chain's last point (or the other way round, or reversed)
 * is appended; a part that meets nothing is left out, so a way the crop cut
 * into two separate pieces labels its longest piece.
 */
export function chainRoadParts(parts: readonly Road[]): Point[] {
  if (parts.length === 0) return [];
  const remaining = [...parts].sort((a, b) => pathLength(b.path) - pathLength(a.path));
  const first = remaining.shift();
  if (first === undefined) return [];
  let chain: Point[] = [...first.path];
  let progressed = true;
  while (progressed && remaining.length > 0) {
    progressed = false;
    for (let i = 0; i < remaining.length; i += 1) {
      const part = remaining[i].path;
      if (part.length < 2) {
        remaining.splice(i, 1);
        progressed = true;
        break;
      }
      const head = chain[0];
      const tail = chain[chain.length - 1];
      if (samePoint(tail, part[0])) chain = [...chain, ...part.slice(1)];
      else if (samePoint(tail, part[part.length - 1])) chain = [...chain, ...[...part].reverse().slice(1)];
      else if (samePoint(head, part[part.length - 1])) chain = [...part.slice(0, -1), ...chain];
      else if (samePoint(head, part[0])) chain = [...[...part].reverse().slice(0, -1), ...chain];
      else continue;
      remaining.splice(i, 1);
      progressed = true;
      break;
    }
  }
  return chain;
}

/** The object a label names, or null when the scene does not carry it. */
export function findLabelTarget(
  scene: SceneGraph,
  label: Pick<Label, "target_osm_id" | "layer">,
): LabelTarget | null {
  const osmId = label.target_osm_id;
  switch (label.layer) {
    case "building": {
      const building = buildingByOsmId(scene, osmId);
      if (building === null) return null;
      return { layer: "building", osmId, name: building.name ?? null, ring: building.ring, holes: building.holes, path: null, road: null };
    }
    case "road": {
      const parts = scene.roads.filter((road) => sourceOsmId(road) === osmId && road.path.length >= 2);
      if (parts.length === 0) return null;
      const widest = parts.reduce((best, road) => (road.width_m > best.width_m ? road : best), parts[0]);
      const named = parts.find((road) => road.name !== undefined && road.name !== "");
      return { layer: "road", osmId, name: named?.name ?? null, ring: null, holes: [], path: chainRoadParts(parts), road: widest };
    }
    case "water":
    case "green": {
      const feature = areaByOsmId(label.layer === "water" ? scene.water : scene.green, osmId);
      if (feature === null) return null;
      return { layer: label.layer, osmId, name: feature.name ?? null, ring: feature.ring, holes: feature.holes, path: null, road: null };
    }
    default: {
      const never: never = label.layer;
      throw new Error(`unknown label layer ${String(never)}`);
    }
  }
}

/** What a label says: its own text, else the target's OSM name, trimmed. */
export function labelText(label: Pick<Label, "text">, target: Pick<LabelTarget, "name"> | null): string {
  const own = (label.text ?? "").trim();
  if (own !== "") return own.slice(0, LABEL_TEXT_MAX);
  return (target?.name ?? "").trim().slice(0, LABEL_TEXT_MAX);
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export interface PolygonFrame {
  kind: "polygon";
  cx: number;
  cy: number;
  /** Direction of the long side, degrees counter-clockwise from +x. */
  angleDeg: number;
  /** Extent along the long side. */
  width: number;
  /** Extent across it. */
  depth: number;
}

export interface PathFrame {
  kind: "path";
  points: Point[];
  /** Arc length at each vertex, `cumulative[0] === 0`. */
  cumulative: number[];
  length: number;
  /** The printed ribbon's full width. */
  width: number;
}

export type LabelFrame = PolygonFrame | PathFrame;

/** The oriented-rectangle frame of a ring, in the ring's own units. */
export function polygonFrame(ring: readonly Point[]): PolygonFrame {
  const rect = minAreaRect(ring);
  // The long side is the reading axis whatever way the rectangle came out.
  if (rect.depth > rect.width) {
    return { kind: "polygon", cx: rect.cx, cy: rect.cy, angleDeg: normaliseDeg(rect.angle + 90), width: rect.depth, depth: rect.width };
  }
  return { kind: "polygon", cx: rect.cx, cy: rect.cy, angleDeg: normaliseDeg(rect.angle), width: rect.width, depth: rect.depth };
}

/** The centreline frame of a path, in the path's own units. */
export function pathFrame(path: readonly Point[], width: number): PathFrame {
  const points: Point[] = [];
  for (const point of path) {
    const last = points[points.length - 1];
    if (last !== undefined && Math.abs(last[0] - point[0]) < 1e-9 && Math.abs(last[1] - point[1]) < 1e-9) continue;
    points.push([point[0], point[1]]);
  }
  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulative.push(cumulative[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  return { kind: "path", points, cumulative, length: cumulative[cumulative.length - 1] ?? 0, width };
}

/** The printed ribbon width of a road target, mm: the engine's own clamp. */
export function roadRibbonWidthMm(road: Road, params: PrintParams, scale: number): number {
  return T.road_width_ground_m(road, params, T.thresholds_ground_m(params, scale)) * scale;
}

/** A target's frame in PRINT millimetres, `scale` being `transform.scale_mm_per_m`. */
export function frameOf(target: LabelTarget, params: PrintParams, scale: number): LabelFrame | null {
  if (target.path !== null && target.road !== null) {
    if (target.path.length < 2) return null;
    const frame = pathFrame(
      target.path.map((p) => [p[0] * scale, p[1] * scale] as Point),
      roadRibbonWidthMm(target.road, params, scale),
    );
    return frame.length > 0 ? frame : null;
  }
  if (target.ring !== null && target.ring.length >= 3) {
    return polygonFrame(target.ring.map((p) => [p[0] * scale, p[1] * scale] as Point));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Anchor <-> plan
// ---------------------------------------------------------------------------

export interface PlanPose {
  x: number;
  y: number;
  /** The absolute reading direction, degrees counter-clockwise from +x. */
  angleDeg: number;
}

/** `angle` folded into (-180, 180]. */
export function normaliseDeg(angle: number): number {
  let out = angle % 360;
  if (out > 180) out -= 360;
  if (out <= -180) out += 360;
  return out;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Point and tangent at arc length `s` along a path frame (clamped to its ends). */
export function pointAt(frame: PathFrame, s: number): PlanPose {
  const { points, cumulative } = frame;
  if (points.length === 1) return { x: points[0][0], y: points[0][1], angleDeg: 0 };
  const at = Math.min(frame.length, Math.max(0, s));
  let i = 0;
  while (i + 1 < cumulative.length - 1 && cumulative[i + 1] <= at) i += 1;
  const [x0, y0] = points[i];
  const [x1, y1] = points[i + 1];
  const run = cumulative[i + 1] - cumulative[i];
  const t = run > 0 ? (at - cumulative[i]) / run : 0;
  return {
    x: x0 + (x1 - x0) * t,
    y: y0 + (y1 - y0) * t,
    angleDeg: (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI,
  };
}

/** The principal axis at anchor `u`: the long side of a polygon, the tangent of a path. */
export function frameAxisDeg(frame: LabelFrame, u: number): number {
  if (frame.kind === "polygon") return frame.angleDeg;
  return pointAt(frame, clamp01(u) * frame.length).angleDeg;
}

/** Where a label's centre lands, and which way it reads. */
export function anchorToPlan(frame: LabelFrame, u: number, v: number, rotationDeg: number): PlanPose {
  const uu = clamp01(u);
  const vv = clamp01(v);
  if (frame.kind === "polygon") {
    const theta = (frame.angleDeg * Math.PI) / 180;
    const along = (uu - 0.5) * frame.width;
    const across = (vv - 0.5) * frame.depth;
    return {
      x: frame.cx + along * Math.cos(theta) - across * Math.sin(theta),
      y: frame.cy + along * Math.sin(theta) + across * Math.cos(theta),
      angleDeg: normaliseDeg(frame.angleDeg + rotationDeg),
    };
  }
  const on = pointAt(frame, uu * frame.length);
  const theta = (on.angleDeg * Math.PI) / 180;
  const across = (vv - 0.5) * frame.width;
  return {
    x: on.x - across * Math.sin(theta),
    y: on.y + across * Math.cos(theta),
    angleDeg: normaliseDeg(on.angleDeg + rotationDeg),
  };
}

/** The anchor a plan point corresponds to, clamped into the frame. The inverse of `anchorToPlan`. */
export function planToAnchor(frame: LabelFrame, x: number, y: number): { u: number; v: number } {
  if (frame.kind === "polygon") {
    const theta = (frame.angleDeg * Math.PI) / 180;
    const dx = x - frame.cx;
    const dy = y - frame.cy;
    const along = dx * Math.cos(theta) + dy * Math.sin(theta);
    const across = -dx * Math.sin(theta) + dy * Math.cos(theta);
    return {
      u: clamp01(frame.width > 0 ? 0.5 + along / frame.width : 0.5),
      v: clamp01(frame.depth > 0 ? 0.5 + across / frame.depth : 0.5),
    };
  }
  // Nearest point on the polyline, and the signed offset across it.
  let bestDistance = Infinity;
  let bestS = 0;
  let bestAcross = 0;
  const { points, cumulative } = frame;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const ex = x1 - x0;
    const ey = y1 - y0;
    const run = ex * ex + ey * ey;
    const t = run > 0 ? Math.min(1, Math.max(0, ((x - x0) * ex + (y - y0) * ey) / run)) : 0;
    const px = x0 + ex * t;
    const py = y0 + ey * t;
    const distance = Math.hypot(x - px, y - py);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestS = cumulative[i] + Math.sqrt(run) * t;
      const length = Math.sqrt(run);
      // Left-hand normal of the segment: positive `across` is to the left.
      bestAcross = length > 0 ? (-(ey / length) * (x - px) + (ex / length) * (y - py)) : 0;
    }
  }
  return {
    u: clamp01(frame.length > 0 ? bestS / frame.length : 0.5),
    v: clamp01(frame.width > 0 ? 0.5 + bestAcross / frame.width : 0.5),
  };
}

/** A rotation within `SNAP_ANGLE_DEG` of a right angle lands on it. */
export function snapRotation(rotationDeg: number): number {
  const folded = normaliseDeg(rotationDeg);
  const nearest = Math.round(folded / 90) * 90;
  return Math.abs(folded - nearest) <= SNAP_ANGLE_DEG ? normaliseDeg(nearest) : folded;
}

/** An anchor within `SNAP_ANCHOR` of the target's centre lands on it, per axis. */
export function snapAnchor(u: number, v: number): { u: number; v: number } {
  return {
    u: Math.abs(u - 0.5) <= SNAP_ANCHOR ? 0.5 : clamp01(u),
    v: Math.abs(v - 0.5) <= SNAP_ANCHOR ? 0.5 : clamp01(v),
  };
}

/**
 * Move a label by `dx`, `dy` in its OWN reading frame (right and up as the
 * text reads), the arrow keys' meaning, and hand back the new anchor.
 */
export function nudgeAnchor(
  frame: LabelFrame,
  label: Pick<Label, "u" | "v" | "rotation_deg">,
  dx: number,
  dy: number,
): { u: number; v: number } {
  const u = label.u ?? PARAM_RANGES.labels.u.default;
  const v = label.v ?? PARAM_RANGES.labels.v.default;
  const pose = anchorToPlan(frame, u, v, label.rotation_deg ?? PARAM_RANGES.labels.rotation_deg.default);
  const theta = (pose.angleDeg * Math.PI) / 180;
  return planToAnchor(
    frame,
    pose.x + dx * Math.cos(theta) - dy * Math.sin(theta),
    pose.y + dx * Math.sin(theta) + dy * Math.cos(theta),
  );
}

// ---------------------------------------------------------------------------
// The label's own box
// ---------------------------------------------------------------------------

export interface LabelBox {
  /** Ink width including the Stage 1 dilation, mm. */
  widthMm: number;
  /** Ink height including the dilation, mm. */
  heightMm: number;
  inkTopMm: number;
  inkBottomMm: number;
  dilationMm: number;
}

/** The ink box of `text` at `sizeMm`, from the shared metrics table. */
export function labelBox(face: string, text: string, sizeMm: number, params: PrintParams, mode: string): LabelBox {
  const [top, bottom] = T.text_ink_em(face, text);
  const dilation = T.text_dilation_mm(face, text, sizeMm, params, mode);
  return {
    widthMm: T.text_width_mm(face, text, sizeMm, params, mode),
    heightMm: T.text_height_mm(face, text, sizeMm, params, mode),
    inkTopMm: top * sizeMm,
    inkBottomMm: bottom * sizeMm,
    dilationMm: dilation,
  };
}

/**
 * The placement (`transform.Placement`) that centres a text's ink box on a
 * pose: the pen origin is at the box's left, on the baseline, so it is moved
 * back by half the width and by the ink's vertical middle.
 */
export function placementFor(pose: PlanPose, box: LabelBox): T.Placement {
  const theta = (pose.angleDeg * Math.PI) / 180;
  const backX = box.widthMm / 2 - box.dilationMm;
  const backY = (box.inkTopMm + box.inkBottomMm) / 2;
  return {
    anchor_x: pose.x - backX * Math.cos(theta) + backY * Math.sin(theta),
    anchor_y: pose.y - backX * Math.sin(theta) - backY * Math.cos(theta),
    rotation_deg: pose.angleDeg,
    mirror_x: false,
  };
}

/** The four corners of the ink box around a pose, counter-clockwise. */
export function boxCorners(pose: PlanPose, box: LabelBox, marginMm = 0): Point[] {
  const theta = (pose.angleDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const hw = box.widthMm / 2 + marginMm;
  const hh = box.heightMm / 2 + marginMm;
  const corner = (ax: number, ay: number): Point => [pose.x + ax * cos - ay * sin, pose.y + ax * sin + ay * cos];
  return [corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)];
}

// ---------------------------------------------------------------------------
// Following a centreline
// ---------------------------------------------------------------------------

export interface GlyphSlot {
  /** The pen origin of this glyph and its own reading direction. */
  pose: PlanPose;
  /** Arc length at the glyph's centre. */
  centreS: number;
}

export interface FollowPlan {
  /** True when every glyph was set on the path; false means the straight fallback applies. */
  followed: boolean;
  /** Why the path was refused, when it was. */
  reason: string | null;
  glyphs: GlyphSlot[];
  maxTurnDeg: number;
  totalTurnDeg: number;
  /** The tightest radius of curvature met, mm, or null with one glyph. */
  minRadius: number | null;
  /** True when the path was walked backwards so the text reads upright. */
  reversed: boolean;
}

function reversedFrame(frame: PathFrame): PathFrame {
  return pathFrame([...frame.points].reverse(), frame.width);
}

/**
 * Set glyphs of the given advances along a path, centred on arc length
 * `centreS`, across the ribbon at `v`, rotated by `rotationDeg` from the
 * tangent, with a baseline offset `baselineMm` below the ribbon centre (the
 * ink's own vertical middle, so the text sits centred as the straight case
 * does).
 *
 * The path is walked in the direction that keeps the text upright: when the
 * tangent at the centre points into the left half-plane the path is reversed
 * first, as a map label is. See `FOLLOW_MAX_TURN_DEG` for the curvature test.
 */
export function followPlan(
  frameIn: PathFrame,
  centreS: number,
  advances: readonly number[],
  sizeMm: number,
  v: number,
  rotationDeg: number,
  baselineMm: number,
): FollowPlan {
  const empty: FollowPlan = { followed: false, reason: null, glyphs: [], maxTurnDeg: 0, totalTurnDeg: 0, minRadius: null, reversed: false };
  if (advances.length === 0) return { ...empty, reason: "there is no text to set" };
  let frame = frameIn;
  let centre = Math.min(frame.length, Math.max(0, centreS));
  const upright = Math.cos(((pointAt(frame, centre).angleDeg + rotationDeg) * Math.PI) / 180) >= 0;
  let reversed = false;
  if (!upright) {
    frame = reversedFrame(frame);
    centre = frame.length - centre;
    reversed = true;
  }
  let total = 0;
  for (const advance of advances) total += advance;
  const start = centre - total / 2;
  if (start < 0 || start + total > frame.length + 1e-9) {
    return { ...empty, reversed, reason: `the text is ${total.toFixed(1)} mm long and the street only ${frame.length.toFixed(1)} mm` };
  }
  const across = (Math.min(1, Math.max(0, v)) - 0.5) * frame.width - baselineMm;
  const glyphs: GlyphSlot[] = [];
  const chordAngles: number[] = [];
  let pen = start;
  for (const advance of advances) {
    const a = pointAt(frame, pen);
    const b = pointAt(frame, pen + advance);
    const chord = advance > 0 && (a.x !== b.x || a.y !== b.y) ? (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI : a.angleDeg;
    const angle = normaliseDeg(chord + rotationDeg);
    const mid = pointAt(frame, pen + advance / 2);
    const theta = (angle * Math.PI) / 180;
    // The pen origin: half an advance back along the reading direction from the
    // arc midpoint, then across the ribbon.
    const x = mid.x - (advance / 2) * Math.cos(theta) - across * Math.sin(theta);
    const y = mid.y - (advance / 2) * Math.sin(theta) + across * Math.cos(theta);
    glyphs.push({ pose: { x, y, angleDeg: angle }, centreS: pen + advance / 2 });
    chordAngles.push(chord);
    pen += advance;
  }
  let maxTurn = 0;
  let totalTurn = 0;
  let minRadius: number | null = null;
  for (let i = 0; i + 1 < chordAngles.length; i += 1) {
    const turn = Math.abs(normaliseDeg(chordAngles[i + 1] - chordAngles[i]));
    maxTurn = Math.max(maxTurn, turn);
    totalTurn += turn;
    if (turn > 1e-9) {
      const radius = ((advances[i] + advances[i + 1]) / 2) / ((turn * Math.PI) / 180);
      minRadius = minRadius === null ? radius : Math.min(minRadius, radius);
    }
  }
  let reason: string | null = null;
  if (maxTurn > FOLLOW_MAX_TURN_DEG) {
    reason = `the street turns ${maxTurn.toFixed(0)} degrees between two letters, over the ${FOLLOW_MAX_TURN_DEG} degree limit`;
  } else if (totalTurn > FOLLOW_MAX_TOTAL_TURN_DEG) {
    reason = `the street turns ${totalTurn.toFixed(0)} degrees under the name, over the ${FOLLOW_MAX_TOTAL_TURN_DEG} degree limit`;
  } else if (minRadius !== null && minRadius < sizeMm) {
    reason = `the bend under the name has a ${minRadius.toFixed(1)} mm radius, tighter than the ${sizeMm.toFixed(2)} mm cap height`;
  }
  return { followed: reason === null, reason, glyphs, maxTurnDeg: maxTurn, totalTurnDeg: totalTurn, minRadius, reversed };
}

// ---------------------------------------------------------------------------
// Params helpers
// ---------------------------------------------------------------------------

/** A new label on `target`, at the contract's defaults. */
export function newLabel(target: Pick<LabelTarget, "layer" | "osmId">): Label {
  return {
    target_osm_id: target.osmId,
    layer: target.layer,
    surface: target.layer === "building" ? "building_top" : "ground",
    u: PARAM_RANGES.labels.u.default,
    v: PARAM_RANGES.labels.v.default,
    rotation_deg: PARAM_RANGES.labels.rotation_deg.default,
    size_mm: PARAM_RANGES.labels.size_mm.default,
    mode: "engrave",
    depth_mm: PARAM_RANGES.labels.depth_mm.default,
    font: "sans",
    text: "",
    follow: false,
  };
}

/** The sentence the editor shows when the cap refuses another label. */
export function labelCapMessage(cap: number = LABEL_CAP): string {
  return `That is the limit: ${cap} labels. Remove one to place another.`;
}

/** "3 of 12 labels", for the count the editor shows before the cap is reached. */
export function labelCountText(count: number, cap: number = LABEL_CAP): string {
  return `${count} of ${cap} ${cap === 1 ? "label" : "labels"}`;
}

// ---------------------------------------------------------------------------
// Params-level edits
//
// What the store's label actions write and what the `labels` stage resolves
// for the gizmo, in one place: the viewport may not read a parameter, so every
// "where is this label" and "put it here" question is answered HERE, on the
// scene and the params the store holds, and the canvas only ever sees the
// resolved pose and the finished band.
// ---------------------------------------------------------------------------

/** The print scale a scene builds at: the engine's own (`solid/context.ts:makeContext`). */
export function labelScale(scene: Pick<SceneGraph, "bounds">, params: PrintParams): number {
  return T.scale_mm_per_m(params, T.radius_m_from_bounds(scene.bounds));
}

/** The frame a label is anchored in, print mm, or null when the scene does not carry its target. */
export function labelFrame(
  scene: SceneGraph,
  params: PrintParams,
  label: Pick<Label, "target_osm_id" | "layer">,
  scale: number = labelScale(scene, params),
): LabelFrame | null {
  const target = findLabelTarget(scene, label);
  return target === null ? null : frameOf(target, params, scale);
}

/** Where a label's centre sits and which way it reads, print mm; null when it has no target. */
export function labelPose(
  scene: SceneGraph,
  params: PrintParams,
  label: Label,
  scale: number = labelScale(scene, params),
): PlanPose | null {
  const frame = labelFrame(scene, params, label, scale);
  if (frame === null) return null;
  return anchorToPlan(
    frame,
    label.u ?? PARAM_RANGES.labels.u.default,
    label.v ?? PARAM_RANGES.labels.v.default,
    label.rotation_deg ?? PARAM_RANGES.labels.rotation_deg.default,
  );
}

/** Decimal places an anchor fraction and a rotation are stored to: 0.01 % of a target, a tenth of a degree. */
const ANCHOR_DECIMALS = 4;
const ROTATION_DECIMALS = 1;

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  // `+ 0` folds a `-0` into `0`, which is what JSON and a share link carry.
  return Math.round(value * factor) / factor + 0;
}

function clampTo(value: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, value));
}

/** The members a placed label may change; the target and the surface are its identity. */
export type LabelPatch = Partial<Omit<Label, "target_osm_id" | "layer" | "surface">>;

export type LabelWrite =
  | { ok: true; labels: Label[]; index: number }
  | { ok: false; reason: "capped" | "missing" };

/**
 * `params.labels` with a new label on `target`: at the plan point `at` when
 * one is given (the click that placed it), else at the target's centre.
 * Refused at the cap rather than silently dropped -- the twelfth is the last.
 */
export function addedLabel(
  scene: SceneGraph,
  params: PrintParams,
  target: Pick<LabelTarget, "layer" | "osmId">,
  at?: { xMm: number; yMm: number },
): LabelWrite {
  const labels = params.labels ?? [];
  if (labels.length >= LABEL_CAP) return { ok: false, reason: "capped" };
  const label = newLabel(target);
  if (at !== undefined) {
    const frame = labelFrame(scene, params, label);
    if (frame !== null) {
      const raw = planToAnchor(frame, at.xMm, at.yMm);
      const anchor = snapAnchor(raw.u, raw.v);
      label.u = roundTo(anchor.u, ANCHOR_DECIMALS);
      label.v = roundTo(anchor.v, ANCHOR_DECIMALS);
    }
  }
  return { ok: true, labels: [...labels, label], index: labels.length };
}

function labelAt(params: PrintParams, index: number): Label | null {
  const labels = params.labels ?? [];
  return index >= 0 && index < labels.length ? labels[index] : null;
}

function replaced(params: PrintParams, index: number, label: Label): Label[] {
  return (params.labels ?? []).map((row, i) => (i === index ? label : row));
}

/** `params.labels` with label `index` moved so its centre lands on the plan point, snapped to the target's centre when close. */
export function movedLabel(
  scene: SceneGraph,
  params: PrintParams,
  index: number,
  xMm: number,
  yMm: number,
): LabelWrite {
  const label = labelAt(params, index);
  if (label === null) return { ok: false, reason: "missing" };
  const frame = labelFrame(scene, params, label);
  if (frame === null) return { ok: false, reason: "missing" };
  const raw = planToAnchor(frame, xMm, yMm);
  const anchor = snapAnchor(raw.u, raw.v);
  return {
    ok: true,
    index,
    labels: replaced(params, index, {
      ...label,
      u: roundTo(anchor.u, ANCHOR_DECIMALS),
      v: roundTo(anchor.v, ANCHOR_DECIMALS),
    }),
  };
}

/**
 * `params.labels` with label `index` reading in the ABSOLUTE plan direction
 * `angleDeg` (what a rotation handle dragged around the centre measures),
 * stored relative to the target's own axis and snapped onto a right angle
 * when close.
 */
export function rotatedLabel(
  scene: SceneGraph,
  params: PrintParams,
  index: number,
  angleDeg: number,
): LabelWrite {
  const label = labelAt(params, index);
  if (label === null) return { ok: false, reason: "missing" };
  const frame = labelFrame(scene, params, label);
  if (frame === null) return { ok: false, reason: "missing" };
  const axis = frameAxisDeg(frame, label.u ?? PARAM_RANGES.labels.u.default);
  const rotation = snapRotation(angleDeg - axis);
  return {
    ok: true,
    index,
    labels: replaced(params, index, {
      ...label,
      rotation_deg: roundTo(clampTo(rotation, PARAM_RANGES.labels.rotation_deg), ROTATION_DECIMALS),
    }),
  };
}

/** `params.labels` with label `index` nudged by `dx`, `dy` mm in its own reading frame (the arrow keys). */
export function nudgedLabel(
  scene: SceneGraph,
  params: PrintParams,
  index: number,
  dxMm: number,
  dyMm: number,
): LabelWrite {
  const label = labelAt(params, index);
  if (label === null) return { ok: false, reason: "missing" };
  const frame = labelFrame(scene, params, label);
  if (frame === null) return { ok: false, reason: "missing" };
  const anchor = nudgeAnchor(frame, label, dxMm, dyMm);
  return {
    ok: true,
    index,
    labels: replaced(params, index, {
      ...label,
      u: roundTo(anchor.u, ANCHOR_DECIMALS),
      v: roundTo(anchor.v, ANCHOR_DECIMALS),
    }),
  };
}

/**
 * `params.labels` with `patch` applied to label `index`: every number clamped
 * into its contract range, the text cut at its cap, so a control can hand in
 * what the user typed and still write a legal row.
 */
export function patchedLabel(params: PrintParams, index: number, patch: LabelPatch): LabelWrite {
  const label = labelAt(params, index);
  if (label === null) return { ok: false, reason: "missing" };
  const next: Label = { ...label, ...patch };
  if (patch.u !== undefined) next.u = roundTo(clampTo(patch.u, PARAM_RANGES.labels.u), ANCHOR_DECIMALS);
  if (patch.v !== undefined) next.v = roundTo(clampTo(patch.v, PARAM_RANGES.labels.v), ANCHOR_DECIMALS);
  if (patch.rotation_deg !== undefined) {
    next.rotation_deg = roundTo(
      clampTo(normaliseDeg(patch.rotation_deg), PARAM_RANGES.labels.rotation_deg),
      ROTATION_DECIMALS,
    );
  }
  if (patch.size_mm !== undefined) next.size_mm = roundTo(clampTo(patch.size_mm, PARAM_RANGES.labels.size_mm), 2);
  if (patch.depth_mm !== undefined) next.depth_mm = roundTo(clampTo(patch.depth_mm, PARAM_RANGES.labels.depth_mm), 2);
  if (patch.text !== undefined) next.text = patch.text.slice(0, LABEL_TEXT_MAX);
  return { ok: true, index, labels: replaced(params, index, next) };
}

/** `params.labels` without label `index`. */
export function removedLabel(params: PrintParams, index: number): Label[] {
  return (params.labels ?? []).filter((_, i) => i !== index);
}

/** What a list calls a label: its text, else its target's name, else the id it names. */
export function labelDisplayText(label: Label, scene: SceneGraph | null): string {
  const target = scene === null ? null : findLabelTarget(scene, label);
  const text = labelText(label, target);
  return text !== "" ? text : label.target_osm_id;
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

/** What a key does to the selected label. Shared by the gizmo's handle and the panel's row, so the two cannot drift. */
export type LabelKeyAction =
  | { kind: "nudge"; dxMm: number; dyMm: number }
  | { kind: "turn"; deltaDeg: number }
  | { kind: "resize"; deltaMm: number }
  | { kind: "remove" }
  | { kind: "deselect" };

/**
 * The key map: arrows nudge in the label's own reading frame (Shift for the
 * large step), `[` and `]` turn, `+` and `-` resize, Delete or Backspace
 * remove, Escape deselects. Null for any other key, so a control can let it
 * through to whatever else listens.
 */
export function labelKeyAction(event: { key: string; shiftKey: boolean }): LabelKeyAction | null {
  const nudge = event.shiftKey ? NUDGE_LARGE_MM : NUDGE_MM;
  const turn = event.shiftKey ? ROTATE_STEP_LARGE_DEG : ROTATE_STEP_DEG;
  const resize = event.shiftKey ? SCALE_STEP_LARGE_MM : SCALE_STEP_MM;
  switch (event.key) {
    case "ArrowRight":
      return { kind: "nudge", dxMm: nudge, dyMm: 0 };
    case "ArrowLeft":
      return { kind: "nudge", dxMm: -nudge, dyMm: 0 };
    case "ArrowUp":
      return { kind: "nudge", dxMm: 0, dyMm: nudge };
    case "ArrowDown":
      return { kind: "nudge", dxMm: 0, dyMm: -nudge };
    case "]":
    case "}":
      return { kind: "turn", deltaDeg: -turn };
    case "[":
    case "{":
      return { kind: "turn", deltaDeg: turn };
    case "+":
    case "=":
      return { kind: "resize", deltaMm: resize };
    case "-":
    case "_":
      return { kind: "resize", deltaMm: -resize };
    case "Delete":
    case "Backspace":
      return { kind: "remove" };
    case "Escape":
      return { kind: "deselect" };
    default:
      return null;
  }
}

/** "roof", "street", "water", "green": the surface a label of this layer prints on, for a list row. */
export function labelSurfaceWord(layer: LabelLayer): string {
  switch (layer) {
    case "building":
      return "roof";
    case "road":
      return "street";
    case "water":
      return "water";
    case "green":
      return "green";
    default: {
      const never: never = layer;
      throw new Error(`unknown label layer ${String(never)}`);
    }
  }
}
