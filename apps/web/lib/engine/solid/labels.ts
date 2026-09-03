/**
 * Surface labels: a name engraved into, or raised off, a building's roof or
 * the ground surface a road, a water body or a green area prints as (v3.1
 * Task 12, Tier A).
 *
 * Where a label goes is not decided here: `lib/labelAnchor.ts` turns the
 * anchor (`u`, `v`, a rotation in the target's own frame) into a pose in print
 * millimetres, and the viewport gizmo drags the same numbers. What this module
 * decides is everything a printer cares about:
 *
 *  - **which face carries it.** A roof is the top of the repaired building
 *    solid under the anchor (the highest one, so a tower stacked on a block is
 *    labelled on the tower); the ground is the top of the target's own surface
 *    region at the depth `regions.*` asked for.
 *  - **that it fits.** The ink box must lie inside the face eroded by one
 *    minimum wall, so a groove never leaves a sliver of roof between itself
 *    and the edge. A label that does not fit at the size asked is shrunk on
 *    the size grid until it does, and says so; one that does not fit at the
 *    smallest legal size is refused rather than overhung.
 *  - **that it prints.** Every glyph goes through `lettering.repairText`, the
 *    frame lettering's own Stage 1 repair: dilated to the stroke target,
 *    clipped to the face, widened where a terminal is thin, measured, and
 *    refused when the dilation closed a counter or the stroke still measures
 *    under the target. Nothing here is a second implementation of that.
 *  - **following a street.** With `follow` on, a road label is set glyph by
 *    glyph along the centreline (`labelAnchor.followPlan`), and falls back to
 *    a straight line where the curvature test fails, with the reason reported.
 *
 * The solids come out sorted by the region they belong to; the registry's
 * consumers (`base`, the surface regions, the building bands, `assembly`)
 * apply them with `applyLabels`. Refusals never throw: each label is a
 * `ResolvedLine` and, when refused, an `AuditFinding` naming the size that
 * would work.
 */

import type { Label, PrintParams } from "../../contracts";
import { PARAM_RANGES } from "../../contracts";
import { loadedGlyphFace, type GlyphFace } from "../../fontGlyphs";
import {
  LABEL_CAP,
  anchorToPlan,
  boxCorners,
  findLabelTarget,
  followPlan,
  frameOf,
  labelBox,
  labelText,
  placementFor,
  type LabelBox,
  type LabelFrame,
  type LabelTarget,
  type PlanPose,
} from "../../labelAnchor";
import type { PreviewArea } from "../../preview";
import { convexHull } from "../../preview";
import { glyphAreas, placeArea } from "../../previewText";
import * as T from "../../transform";
import type { AuditFinding, LabelBand, RegionName, ResolvedLine } from "../types";
import type { SurfaceRegion } from "./areas";
import { buildingSpanMm } from "./buildings";
import {
  CUTTER_OVERSHOOT_MM,
  PART_OVERLAP_MM,
  addFinding,
  finding,
  type BuildContext,
} from "./context";
import type { Drape } from "./drape";
import { drapeLiftMm, drapeSurfaceMm } from "./drape";
import { STROKE_FAIL_FACTOR, repairText } from "./lettering";
import type { Arena, Contour, CrossSection, Manifold, ManifoldToplevel } from "./manifold";
import {
  MITRE,
  batchedUnion,
  extrudeSection,
  intersectSection,
  offsetSection,
  sectionOf,
  subtractSolids,
} from "./manifold";
import { areaContours, ribbonContours, type BuildingSolid, type RepairedBuildings } from "./repair";
import type { SliceMask } from "./measure";

/** A road's ground width as the roads layer printed it, so a label's ribbon is the ribbon that exists. */
export { roadRibbonWidthMm } from "../../labelAnchor";

/**
 * How far inside its face a label's ink must stay, in minimum walls.
 *
 * One: the material between a groove and the roof edge is a wall, and a wall
 * under 04's minimum is exactly what the structural gate fails. An emboss gets
 * the same margin so a letter never stands on the edge of a roof.
 */
export const FIT_MARGIN_WALLS = 1.0;

/** Area a box may lose to its face and still count as fitting, mm2: float noise, not a tolerance. */
const FIT_AREA_EPS_MM2 = 1e-6;

/** Bisection steps of the shrink-to-fit search on the size grid. */
const FIT_SEARCH_STEPS = 12;

export interface LabelPiece {
  index: number;
  /** `label-<index>`, the `ResolvedLine.id`. */
  id: string;
  layer: Label["layer"];
  /** The region the solids belong to: a building region for a roof, the layer's surface region for the ground. */
  region: RegionName;
  /** Roof pieces: true when the labelled building is a picked hero, so the piece belongs to `hero_building`. */
  hero: boolean;
  mode: "engrave" | "emboss";
  /** Z of the face in the finished model (a roof after the drape's lift, the ground plus its warp). */
  faceZMm: number;
  /** A roof's top BEFORE the drape lifted it: the number a gradient band's `topRangeMm` holds. */
  roofTopMm: number;
  /** The cutter, from below the face to past it, for an engrave; null for an emboss. */
  cut: Manifold | null;
  /** The raised letters, overlapping the face by `PART_OVERLAP_MM`, for an emboss; null for an engrave. */
  add: Manifold | null;
  band: LabelBand;
  /** The ink polygon as a section, for the minimum-wall mask (`measure.SliceMask`). */
  mask: CrossSection;
}

export interface LabelGeometry {
  pieces: LabelPiece[];
  /** `pieces[].band`, in label order: what the sidecar and the gizmo read. */
  bands: LabelBand[];
}

// ---------------------------------------------------------------------------
// Small geometry
// ---------------------------------------------------------------------------

/** Even-odd containment of a point in a section's rings. */
function sectionContains(section: CrossSection, x: number, y: number): boolean {
  let inside = false;
  for (const ring of section.toPolygons()) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** A counter-clockwise contour from points, whichever way they were given. */
function ccwContour(points: readonly (readonly number[])[]): Contour {
  const contour: Contour = points.map((p) => [p[0], p[1]]);
  let twice = 0;
  for (let i = 0; i < contour.length; i += 1) {
    const a = contour[i];
    const b = contour[(i + 1) % contour.length];
    twice += a[0] * b[1] - b[0] * a[1];
  }
  if (twice < 0) contour.reverse();
  return contour;
}

/** True when `polygon` lies inside `keep` (its area survives the intersection). */
function fitsInside(ctx: BuildContext, keep: CrossSection, polygon: Contour): boolean {
  const { wasm, arena } = ctx;
  const probe = sectionOf(wasm, arena, [polygon]);
  if (probe === null) return false;
  const inside = intersectSection(arena, probe, keep);
  const fits = inside !== null && inside.area() >= probe.area() - FIT_AREA_EPS_MM2;
  if (inside !== null && inside !== probe) arena.drop(inside);
  arena.drop(probe);
  return fits;
}

// ---------------------------------------------------------------------------
// Faces
// ---------------------------------------------------------------------------

interface Face {
  /** The section the ink must stay inside: the face eroded by the fit margin. */
  keep: CrossSection;
  /**
   * Z the solids are cut at, engine mm. A roof is already where the building
   * was TRANSLATED to by the drape; a ground face is the flat surface, because
   * the ground solids are cut flat and warped afterwards (`base`, `assembly`).
   */
  zMm: number;
  /** What the drape adds to `zMm` in the finished model, for the band the validator reads. */
  liftMm: number;
  /** A roof's top before the drape lifted it: what a gradient band's `topRangeMm` is measured in. */
  roofTopMm: number;
  region: RegionName;
  hero: boolean;
  /** A word for the surface in a refusal: "the roof of X", "the road surface of X". */
  noun: string;
}

/** The lift a building solid received from the drape (`buildings.ts`'s own rule). */
function liftOf(repaired: RepairedBuildings, solid: BuildingSolid, drape: Drape | null): number {
  if (drape === null) return 0;
  if (solid.standsOn === null) return drapeLiftMm(drape, solid.section);
  const block = repaired.solids.find((candidate) => candidate.height === solid.standsOn);
  return drapeLiftMm(drape, (block ?? solid).section);
}

/** The building solid under a plan point: the highest one, so a stacked tower wins over its block. */
function roofUnder(
  ctx: BuildContext,
  repaired: RepairedBuildings,
  drape: Drape | null,
  x: number,
  y: number,
): { solid: BuildingSolid; topMm: number; flatTopMm: number } | null {
  let best: { solid: BuildingSolid; topMm: number; flatTopMm: number } | null = null;
  for (const solid of repaired.solids) {
    if (!sectionContains(solid.section, x, y)) continue;
    const flatTop = buildingSpanMm(ctx, solid)[1];
    const top = flatTop + liftOf(repaired, solid, drape);
    if (best === null || top > best.topMm) best = { solid, topMm: top, flatTopMm: flatTop };
  }
  return best;
}

function roofFace(
  ctx: BuildContext,
  repaired: RepairedBuildings,
  drape: Drape | null,
  target: LabelTarget,
  pose: PlanPose,
  marginMm: number,
): Face | { refused: string } {
  const roof = roofUnder(ctx, repaired, drape, pose.x, pose.y);
  if (roof === null) {
    return { refused: `the anchor is not over a printed roof of ${target.name ?? target.osmId} (the building may have been dropped by the minimum-feature repair)` };
  }
  const keep = offsetSection(ctx.arena, roof.solid.section, -marginMm, MITRE);
  if (keep === null) {
    return { refused: `the roof of ${target.name ?? target.osmId} is narrower than two minimum walls, so no text can keep a wall's clearance from its edge` };
  }
  return {
    keep,
    zMm: roof.topMm,
    liftMm: 0,
    roofTopMm: roof.flatTopMm,
    region: roof.solid.heroId !== null ? "hero_building" : "buildings",
    hero: roof.solid.heroId !== null,
    noun: `the roof of ${target.name ?? target.osmId}`,
  };
}

const GROUND_REGION: Record<Exclude<Label["layer"], "building">, RegionName> = {
  road: "roads",
  water: "water",
  green: "parks",
};

const GROUND_NOUN: Record<Exclude<Label["layer"], "building">, string> = {
  road: "the road surface of",
  water: "the water of",
  green: "the green of",
};

function groundFace(
  ctx: BuildContext,
  surfaces: readonly SurfaceRegion[],
  drape: Drape | null,
  target: LabelTarget,
  frame: LabelFrame,
  pose: PlanPose,
  marginMm: number,
): Face | { refused: string } {
  if (target.layer === "building") return { refused: "a building has no ground surface" };
  const region = GROUND_REGION[target.layer];
  const surface = surfaces.find((candidate) => candidate.region === region);
  const name = target.name ?? target.osmId;
  if (surface === undefined) {
    return { refused: `the ${target.layer === "green" ? "parks" : target.layer === "road" ? "roads" : "water"} layer is not built, so ${name} has no printed surface to label` };
  }
  const { wasm, arena, scale } = ctx;
  const own =
    frame.kind === "path" && target.path !== null
      ? sectionOf(wasm, arena, ribbonContours(target.path, frame.width, scale))
      : target.ring === null
        ? null
        : sectionOf(wasm, arena, areaContours([{ ring: target.ring, holes: target.holes }], scale));
  if (own === null) return { refused: `${name} has no printable outline` };
  const built = intersectSection(arena, own, surface.section);
  if (built !== own) arena.drop(own);
  if (built === null) return { refused: `nothing of ${name} survived the surface repair (it may lie under a building or another layer)` };
  const keep = offsetSection(arena, built, -marginMm, MITRE);
  arena.drop(built);
  if (keep === null) {
    return { refused: `${name} prints narrower than two minimum walls, so no text can keep a wall's clearance from its edge` };
  }
  return {
    keep,
    zMm: surface.placement.topMm,
    liftMm: drape === null ? 0 : drapeSurfaceMm(drape, pose.x, pose.y),
    roofTopMm: surface.placement.topMm,
    region,
    hero: false,
    noun: `${GROUND_NOUN[target.layer]} ${name}`,
  };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface Laid {
  sizeMm: number;
  box: LabelBox;
  areas: PreviewArea[];
  /** The ink polygon, counter-clockwise: a rectangle, or the hull of the glyph boxes when following. */
  ink: Contour;
  followed: boolean;
  followReason: string | null;
}

function glyphAdvances(asset: GlyphFace, text: string, sizeMm: number): number[] {
  const metrics = T.font_metrics(asset.face);
  const out: number[] = [];
  for (const ch of text) {
    const code = String(ch.codePointAt(0) ?? -1);
    out.push(((metrics.glyphs[code]?.adv ?? 0) / asset.units_per_em) * sizeMm);
  }
  return out;
}

/**
 * The glyph areas and the ink polygon of `text` at `sizeMm`, straight or
 * following the road, in print millimetres.
 */
function layOut(
  asset: GlyphFace,
  text: string,
  sizeMm: number,
  params: PrintParams,
  mode: string,
  frame: LabelFrame,
  label: Label,
  pose: PlanPose,
): Laid {
  const face = asset.face;
  const box = labelBox(face, text, sizeMm, params, mode);
  const straight = (): Laid => {
    const areas = glyphAreas(asset, text, sizeMm, 0).map((area) => placeArea(area, placementFor(pose, box)));
    return { sizeMm, box, areas, ink: ccwContour(boxCorners(pose, box)), followed: false, followReason: null };
  };
  if (frame.kind !== "path" || label.follow !== true) return straight();
  const advances = glyphAdvances(asset, text, sizeMm);
  const plan = followPlan(
    frame,
    (label.u ?? PARAM_RANGES.labels.u.default) * frame.length,
    advances,
    sizeMm,
    label.v ?? PARAM_RANGES.labels.v.default,
    label.rotation_deg ?? PARAM_RANGES.labels.rotation_deg.default,
    (box.inkTopMm + box.inkBottomMm) / 2,
  );
  if (!plan.followed) return { ...straight(), followReason: plan.reason };
  const areas: PreviewArea[] = [];
  const points: Array<[number, number]> = [];
  const chars = [...text];
  const [top, bottom] = T.text_ink_em(face, text);
  chars.forEach((ch, i) => {
    const slot = plan.glyphs[i];
    const placement: T.Placement = { anchor_x: slot.pose.x, anchor_y: slot.pose.y, rotation_deg: slot.pose.angleDeg, mirror_x: false };
    for (const area of glyphAreas(asset, ch, sizeMm, 0)) areas.push(placeArea(area, placement));
    // This glyph's own box, in the ink frame every glyph of the string shares.
    const theta = (slot.pose.angleDeg * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const x0 = -box.dilationMm;
    const x1 = advances[i] + box.dilationMm;
    const y0 = bottom * sizeMm - box.dilationMm;
    const y1 = top * sizeMm + box.dilationMm;
    for (const [ax, ay] of [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ]) {
      points.push([slot.pose.x + ax * cos - ay * sin, slot.pose.y + ax * sin + ay * cos]);
    }
  });
  return { sizeMm, box, areas, ink: ccwContour(convexHull(points)), followed: true, followReason: null };
}

/**
 * The largest size on the grid, at or under `requestedMm`, whose ink polygon
 * fits inside `keep`; null when even the smallest legal size does not.
 */
function fitSize(
  ctx: BuildContext,
  keep: CrossSection,
  requestedMm: number,
  layAt: (sizeMm: number) => Laid,
): { laid: Laid; shrunk: boolean } | null {
  const at = layAt(requestedMm);
  if (fitsInside(ctx, keep, at.ink)) return { laid: at, shrunk: false };
  const floor = layAt(T.TEXT_MIN_SIZE_MM);
  if (!fitsInside(ctx, keep, floor.ink)) return null;
  let low = T.TEXT_MIN_SIZE_MM;
  let high = requestedMm;
  let best = floor;
  for (let step = 0; step < FIT_SEARCH_STEPS && high - low > T.TEXT_FIT_GRID_MM; step += 1) {
    const mid = T.floor_to_grid((low + high) / 2);
    if (mid <= low) break;
    const laid = layAt(mid);
    if (fitsInside(ctx, keep, laid.ink)) {
      best = laid;
      low = mid;
    } else {
      high = mid;
    }
  }
  return { laid: best, shrunk: true };
}

// ---------------------------------------------------------------------------
// Findings and resolved lines
// ---------------------------------------------------------------------------

function resolvedLine(
  id: string,
  text: string,
  surface: string,
  mode: "engrave" | "emboss",
  status: "cuts" | "skipped",
  depthMm: number,
  sizeMm: number,
  reason?: string,
): ResolvedLine {
  const line: ResolvedLine = { id, text, surface, mode, status, depthMm, sizeMm };
  if (reason !== undefined) line.reason = reason;
  return line;
}

/** A label refusal, with a one-click resize when `sizeMm` is a size that would cut. */
function refusal(
  params: PrintParams,
  index: number,
  text: string,
  reason: string,
  region: RegionName | undefined,
  sizeMm: number | null,
): AuditFinding {
  const base = finding("label-not-cut", "warning", `Label "${text}" was not cut`, reason, region);
  const all = params.labels ?? [];
  if (sizeMm === null || index < 0 || index >= all.length) return base;
  return {
    ...base,
    detail: `${reason}. At ${sizeMm.toFixed(2)} mm it would cut.`,
    fix: {
      label: `Set this label to ${sizeMm.toFixed(2)} mm`,
      safe: false,
      patch: { labels: all.map((label, i) => (i === index ? { ...label, size_mm: sizeMm } : label)) },
    },
  };
}

/** The grid size the shared layout says would clear the nozzle, or null when growing is not the remedy. */
function workingSizeMm(minSizeMm: number, sizeMm: number): number | null {
  if (!(minSizeMm > 0)) return null;
  const wanted = Math.ceil(minSizeMm / T.TEXT_FIT_GRID_MM) * T.TEXT_FIT_GRID_MM;
  const capped = Number(Math.min(T.TEXT_MAX_SIZE_MM, wanted).toFixed(2));
  return capped > sizeMm + T.TEXT_FIT_GRID_MM ? capped : null;
}

function surfaceLabel(target: LabelTarget | null, label: Label): string {
  const name = target?.name ?? label.target_osm_id;
  if (label.layer === "building") return `Roof of ${name}`;
  if (label.layer === "road") return `Road, ${name}`;
  if (label.layer === "water") return `Water, ${name}`;
  return `Green, ${name}`;
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

/**
 * Every label in `params.labels`, as solids.
 *
 * `repaired` and `surfaces` are the `repair-buildings` and `surface-parks`
 * outputs: the faces the labels sit on. `drape` lifts a roof onto the terrain
 * exactly as `buildBuildings` lifts the building.
 */
export function buildLabels(
  ctx: BuildContext,
  repaired: RepairedBuildings,
  surfaces: readonly SurfaceRegion[],
  drape: Drape | null,
): LabelGeometry {
  const { params, scene, scale, wasm, arena } = ctx;
  const out: LabelGeometry = { pieces: [], bands: [] };
  const labels = params.labels ?? [];
  if (labels.length > LABEL_CAP) {
    addFinding(
      ctx,
      finding(
        "labels-over-cap",
        "warning",
        `${labels.length - LABEL_CAP} label(s) beyond the ${LABEL_CAP} cap were not cut`,
        `The contract allows ${LABEL_CAP} labels; the first ${LABEL_CAP} were cut and the rest ignored.`,
      ),
    );
  }
  const marginMm = FIT_MARGIN_WALLS * ctx.thresholdsMm.minWall;

  labels.slice(0, LABEL_CAP).forEach((label, index) => {
    const id = `label-${index}`;
    const mode: "engrave" | "emboss" = label.mode === "emboss" ? "emboss" : "engrave";
    const depth = label.depth_mm ?? PARAM_RANGES.labels.depth_mm.default;
    const requested = Math.min(T.TEXT_MAX_SIZE_MM, Math.max(T.TEXT_MIN_SIZE_MM, label.size_mm ?? PARAM_RANGES.labels.size_mm.default));
    const face = label.font ?? "sans";
    const target = findLabelTarget(scene, label);
    const surface = surfaceLabel(target, label);
    const text = labelText(label, target);
    const skip = (reason: string, region?: RegionName, sizeMm: number | null = null): void => {
      ctx.resolvedText.push(resolvedLine(id, text, surface, mode, "skipped", depth, requested, reason));
      addFinding(ctx, refusal(params, index, text || label.target_osm_id, reason, region, sizeMm));
    };

    if (target === null) {
      skip(`${label.target_osm_id} is not in this scene (a smaller crop, or a different place)`);
      return;
    }
    if (text === "") {
      skip(`${target.osmId} has no OpenStreetMap name and the label has no text of its own`);
      return;
    }
    const frame = frameOf(target, params, scale);
    if (frame === null) {
      skip(`${target.name ?? target.osmId} has no outline to anchor to`);
      return;
    }
    const asset = loadedGlyphFace(face);
    if (asset === null) {
      skip(`the ${face} font is not loaded`);
      return;
    }
    const pose = anchorToPlan(
      frame,
      label.u ?? PARAM_RANGES.labels.u.default,
      label.v ?? PARAM_RANGES.labels.v.default,
      label.rotation_deg ?? PARAM_RANGES.labels.rotation_deg.default,
    );
    // Tier A: a building is labelled on its roof and everything else on the
    // ground it prints as, and a label that asks for the other surface is
    // refused rather than silently moved.
    const faceOrRefusal =
      label.layer === "building"
        ? label.surface === "building_top"
          ? roofFace(ctx, repaired, drape, target, pose, marginMm)
          : { refused: "a building is labelled on its roof, not on the ground: set the surface to building_top" }
        : label.surface === "ground"
          ? groundFace(ctx, surfaces, drape, target, frame, pose, marginMm)
          : { refused: "only a building has a roof to label: set the surface to ground" };
    if ("refused" in faceOrRefusal) {
      skip(faceOrRefusal.refused);
      return;
    }
    const carrier = faceOrRefusal;

    // The shared layout's own verdict on the string: the dilation it needs,
    // the size under which a counter closes. A huge extent, because the fit
    // against the FACE is decided below, in two dimensions, by the kernel.
    const fit = T.fit_text(face, text, requested, 1e6, 1e6, params, `label on ${carrier.noun}`, mode);
    if (fit.refused || fit.text.trim() === "") {
      skip(fit.reason, carrier.region, workingSizeMm(fit.min_size_mm, requested));
      return;
    }
    const layAt = (sizeMm: number): Laid => layOut(asset, fit.text, sizeMm, params, mode, frame, label, pose);
    const fitted = fitSize(ctx, carrier.keep, fit.size_mm, layAt);
    if (fitted === null) {
      skip(`"${fit.text}" does not fit inside ${carrier.noun} with a wall's clearance even at ${T.TEXT_MIN_SIZE_MM.toFixed(2)} mm: shorten the text or move it`, carrier.region);
      arena.drop(carrier.keep);
      return;
    }
    const laid = fitted.laid;
    if (laid.sizeMm < fit.min_size_mm) {
      skip(
        `at ${laid.sizeMm.toFixed(2)} mm, the largest that fits inside ${carrier.noun}, a ${params.nozzle_mm} mm nozzle ` +
          `cannot cut "${fit.text}" without closing a counter; it needs ${fit.min_size_mm.toFixed(2)} mm`,
        carrier.region,
      );
      arena.drop(carrier.keep);
      return;
    }
    if (fitted.shrunk) {
      addFinding(
        ctx,
        finding(
          "label-adjusted",
          "info",
          `Label "${fit.text}" was shrunk to fit`,
          `Reduced from ${fit.size_mm.toFixed(2)} mm to ${laid.sizeMm.toFixed(2)} mm to fit inside ${carrier.noun} with a wall's clearance.`,
          carrier.region,
        ),
      );
    }
    if (laid.followReason !== null) {
      addFinding(
        ctx,
        finding(
          "label-adjusted",
          "info",
          `Label "${fit.text}" was set straight`,
          `It could not follow the street: ${laid.followReason}.`,
          carrier.region,
        ),
      );
    }

    // 04 stage 1 on the letterform, exactly as the frame lettering does it.
    const target_mm = T.text_stroke_target_mm(params, mode);
    const dilation = T.text_dilation_mm(face, fit.text, laid.sizeMm, params, mode);
    const repairedText = repairText(ctx, laid.areas, dilation, target_mm, carrier.keep);
    arena.drop(carrier.keep);
    if (repairedText === null) {
      skip("the glyphs came back empty", carrier.region);
      return;
    }
    if (repairedText.lostCounters > 0) {
      const reason = `widening it to a full minimum wall closed ${repairedText.lostCounters} counter(s); it needs about ${fit.min_size_mm.toFixed(2)} mm`;
      skip(reason, carrier.region, workingSizeMm(fit.min_size_mm, laid.sizeMm));
      arena.drop(repairedText.section);
      return;
    }
    if (repairedText.strokeMm < STROKE_FAIL_FACTOR * target_mm || repairedText.starvedParts > 0) {
      const reason =
        repairedText.starvedParts > 0
          ? `${repairedText.starvedParts} piece(s) of it are under ${target_mm.toFixed(2)} mm wide everywhere, so a ${params.nozzle_mm} mm nozzle would miss them`
          : `its stroke measures ${repairedText.strokeMm.toFixed(2)} mm against a ${target_mm.toFixed(2)} mm target for a ${params.nozzle_mm} mm nozzle`;
      skip(reason, carrier.region, workingSizeMm(fit.min_size_mm, laid.sizeMm));
      arena.drop(repairedText.section);
      return;
    }

    const solid =
      mode === "engrave"
        ? extrudeSection(wasm, arena, repairedText.section, carrier.zMm - depth, carrier.zMm + CUTTER_OVERSHOOT_MM)
        : extrudeSection(wasm, arena, repairedText.section, carrier.zMm - PART_OVERLAP_MM, carrier.zMm + depth);
    arena.drop(repairedText.section);
    if (solid === null) {
      skip("the extrusion came back empty", carrier.region);
      return;
    }
    // The ink polygon grown by one nozzle: what the validator masks and judges.
    const inkSection = sectionOf(wasm, arena, [laid.ink]);
    const mask = inkSection === null ? null : offsetSection(arena, inkSection, params.nozzle_mm, MITRE);
    if (inkSection !== null && mask !== inkSection) arena.drop(inkSection);
    if (mask === null) {
      skip("the ink outline came back empty", carrier.region);
      arena.drop(solid);
      return;
    }
    const rect = mask.toPolygons()[0]?.map((p) => [p[0], p[1]] as [number, number]) ?? laid.ink.map((p) => [p[0], p[1]] as [number, number]);
    const faceZ = carrier.zMm + carrier.liftMm;
    const band: LabelBand = {
      id,
      index,
      mode,
      zMm: mode === "engrave" ? [faceZ - depth, faceZ] : [faceZ, faceZ + depth],
      faceZMm: faceZ,
      rect,
      region: carrier.region,
    };
    out.pieces.push({
      index,
      id,
      layer: label.layer,
      region: carrier.region,
      hero: carrier.hero,
      mode,
      faceZMm: faceZ,
      roofTopMm: carrier.roofTopMm,
      cut: mode === "engrave" ? solid : null,
      add: mode === "emboss" ? solid : null,
      band,
      mask,
    });
    out.bands.push(band);
    ctx.resolvedText.push(resolvedLine(id, fit.text, surface, mode, "cuts", depth, laid.sizeMm));
  });

  return out;
}

// ---------------------------------------------------------------------------
// Applying the pieces
// ---------------------------------------------------------------------------

/** Cut and raise `pieces` on `solid`: the cutters subtracted, the letters unioned. `solid` itself when there are none. */
export function applyLabels(
  wasm: ManifoldToplevel,
  arena: Arena,
  solid: Manifold | null,
  pieces: readonly LabelPiece[],
): Manifold | null {
  if (solid === null || pieces.length === 0) return solid;
  const cuts = pieces.map((piece) => piece.cut).filter((cut): cut is Manifold => cut !== null);
  const adds = pieces.map((piece) => piece.add).filter((add): add is Manifold => add !== null);
  let current = solid;
  if (adds.length > 0) current = batchedUnion(wasm, arena, [current, ...adds]) ?? current;
  if (cuts.length > 0) current = subtractSolids(wasm, arena, current, cuts);
  return current;
}

/** The roof pieces that belong to one building region: the hero region, or the band whose roof range holds the face. */
export function roofPiecesFor(
  geometry: LabelGeometry,
  region: RegionName,
  topRangeMm: [number, number] | null,
): LabelPiece[] {
  return geometry.pieces.filter((piece) => {
    if (piece.layer !== "building") return false;
    if (region === "hero_building") return piece.hero;
    if (piece.hero) return false;
    if (topRangeMm === null) return true;
    return piece.roofTopMm >= topRangeMm[0] - 1e-6 && piece.roofTopMm <= topRangeMm[1] + 1e-6;
  });
}

/** The ground embosses: letters standing on a surface region, which the assembly unions before it drapes. */
export function groundAdditions(geometry: LabelGeometry): Manifold[] {
  return geometry.pieces
    .filter((piece) => piece.layer !== "building")
    .map((piece) => piece.add)
    .filter((add): add is Manifold => add !== null);
}

/** The ground pieces of one surface region. */
export function groundPiecesFor(geometry: LabelGeometry, region: RegionName): LabelPiece[] {
  return geometry.pieces.filter((piece) => piece.layer !== "building" && piece.region === region);
}

/** Every cutter that reaches into the base: the ground engraves (a roof groove never touches the plate). */
export function baseCutters(geometry: LabelGeometry): Manifold[] {
  return groundPiecesFor(geometry, "roads")
    .concat(groundPiecesFor(geometry, "water"), groundPiecesFor(geometry, "parks"))
    .map((piece) => piece.cut)
    .filter((cut): cut is Manifold => cut !== null);
}

/** The minimum-wall masks: one per cut label, its ink polygon inside its own band. */
export function labelMasks(geometry: LabelGeometry): SliceMask[] {
  return geometry.pieces.map((piece) => ({ zMm: piece.band.zMm, section: piece.mask }));
}

/** Faces the labels need loaded, for `fonts`. */
export function labelFaces(params: PrintParams): string[] {
  const out = new Set<string>();
  for (const label of params.labels ?? []) out.add(label.font ?? T.ENGRAVING_DEFAULT_FACE);
  return [...out];
}
