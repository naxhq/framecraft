/**
 * SceneGraph + PrintParams -> per-building FOOTPRINTS, in PRINT MILLIMETRES.
 *
 * Since v3.1 the viewport draws the pipeline's own solids and nothing else, and
 * since the v3-06 audit's finding C2 it PICKS them too: the buildings mesh
 * carries `triangleOwner`/`owners`, so the invisible box per building that used
 * to stand in for per-building identity is gone. What these footprints feed now
 * is the HUD -- the building count, the keyboard cursor's tallest-first order,
 * the minimum-feature repair width the object popover reports, and the
 * adjustments drawer's dilated and dropped counts. Nothing derived here is
 * drawn or raycast. `buildingInstanceMatrices` is what the deleted layer used
 * and has no caller left; it is kept with its tests rather than removed here,
 * because this module is not this task's to reshape.
 *
 * `PreviewArea` stays because it is the flat-contour shape `lib/previewText.ts`
 * emits and the engine's own lettering, frame and tiling code consumes.
 *
 * Rules this module still enforces:
 *
 * 1. **No maths of its own.** Every scale, threshold and height comes from
 *    `lib/transform.ts`, the mirror of `app/geom/transform.py`. The only
 *    geometry computed here is *shape* (oriented bounding rectangles), never a
 *    printed dimension -- a pick box has to sit where the printed building
 *    sits or a click lands on the wrong one.
 * 2. **No three.js.** Output is plain numbers and typed arrays so it can be
 *    unit-tested in node and so a slider can rewrite one instance buffer
 *    without touching anything else.
 *
 * Coordinate frame: x east, y north, z up -- the same frame as the SceneGraph
 * and the engine. `components/scene/PreviewScene.tsx` rotates the whole group
 * once to satisfy three.js's Y-up convention.
 */

import type { PrintParams, SceneGraph } from "./contracts";
import * as T from "./transform";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/** One building, ready to become an InstancedMesh instance. */
export interface PreviewBuilding {
  id: string;
  /** Centre of the oriented bounding rectangle, mm. */
  cx_mm: number;
  cy_mm: number;
  /** Rectangle orientation, radians CCW about +z. */
  angle_rad: number;
  /** Rectangle size after the preview dilation, mm. */
  width_mm: number;
  depth_mm: number;
  /** Straight from the SceneGraph; the height sliders read these. */
  height_m: number;
  is_tall: boolean;
  /** How much the footprint had to grow to reach the min wall, ground metres. */
  dilation_m: number;
  dilated: boolean;
}

/** A polygon with holes, in mm, ready for `new THREE.Shape()`. */
export interface PreviewArea {
  /** Flat [x0,y0,x1,y1,...] outer contour, mm. */
  outer: number[];
  /** Flat contours for the holes, mm. */
  holes: number[][];
}

// ---------------------------------------------------------------------------
// Oriented bounding rectangle (minimum-area, via rotating calipers on the hull)
// ---------------------------------------------------------------------------

export interface OrientedRect {
  cx: number;
  cy: number;
  angle: number;
  width: number;
  depth: number;
}

type Pt = readonly number[];

/** Andrew's monotone chain convex hull. Returns CCW, no repeated last point. */
export function convexHull(points: ReadonlyArray<Pt>): Pt[] {
  if (points.length < 3) return points.slice();
  const sorted = points
    .slice()
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  const cross = (o: Pt, a: Pt, b: Pt): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Pt[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  return hull.length >= 3 ? hull : sorted;
}

/**
 * Minimum-area oriented bounding rectangle of a ring.
 *
 * The optimal rectangle is flush with a hull edge, so this tries every hull
 * edge direction and keeps the smallest area. That is what makes a diagonal
 * city block render as a diagonal box instead of a fat axis-aligned one.
 */
export function minAreaRect(points: ReadonlyArray<Pt>): OrientedRect {
  const hull = convexHull(points);
  if (hull.length === 0) {
    return { cx: 0, cy: 0, angle: 0, width: 0, depth: 0 };
  }
  if (hull.length < 3) {
    const xs = hull.map((p) => p[0]);
    const ys = hull.map((p) => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      angle: 0,
      width: maxX - minX,
      depth: maxY - minY,
    };
  }

  let best: OrientedRect | null = null;
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const edgeX = b[0] - a[0];
    const edgeY = b[1] - a[1];
    const length = Math.hypot(edgeX, edgeY);
    if (length < 1e-12) continue;
    const ux = edgeX / length;
    const uy = edgeY / length;

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uy;
      const v = -p[0] * uy + p[1] * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const width = maxU - minU;
    const depth = maxV - minV;
    const area = width * depth;
    if (best === null || area < best.width * best.depth - 1e-12) {
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = {
        cx: cu * ux - cv * uy,
        cy: cu * uy + cv * ux,
        angle: Math.atan2(uy, ux),
        width,
        depth,
      };
    }
  }
  return best ?? { cx: 0, cy: 0, angle: 0, width: 0, depth: 0 };
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

/**
 * Oriented boxes for every building that survives stage 1, in mm.
 *
 * Depends only on the scene and the params that move the *scale* and the
 * *thresholds* (`plate_mm`, `frame`, `nozzle_mm`). The height sliders do not
 * appear here on purpose: moving them must rewrite instance matrices only, not
 * redo the hull maths (02's slider budget is 33 ms).
 *
 * The dilation is the cheap client-side stand-in for 04 stage 1 steps 2-4: a
 * footprint whose hydraulic diameter is under the minimum wall is grown by
 * `2 * d` on both axes and then floored at the minimum wall itself, which is
 * roughly what `buffer(d)` followed by the `min_gap` closing does to a thin
 * shape. The preview cannot merge neighbours (that needs a boolean), so the UI
 * says so.
 */
export function buildBuildings(
  scene: SceneGraph,
  params: PrintParams,
): { buildings: PreviewBuilding[]; dilatedCount: number; droppedCount: number } {
  const radius_m = T.radius_m_from_bounds(scene.bounds);
  const scale = T.scale_mm_per_m(params, radius_m);
  const thresholds = T.thresholds_ground_m(params, scale);

  const buildings: PreviewBuilding[] = [];
  let dilatedCount = 0;
  let droppedCount = 0;

  for (const building of scene.buildings) {
    if (building.ring.length < 3) {
      droppedCount += 1;
      continue;
    }
    const [area, , , dilation] = T.building_footprint_metrics(
      building.ring,
      building.holes,
      thresholds,
    );
    if (T.building_dropped(area, dilation, thresholds)) {
      droppedCount += 1;
      continue;
    }
    const rect = minAreaRect(building.ring);
    let width = rect.width;
    let depth = rect.depth;
    if (dilation > 0) {
      dilatedCount += 1;
      width = Math.max(width + 2 * dilation, thresholds.min_wall);
      depth = Math.max(depth + 2 * dilation, thresholds.min_wall);
    }
    buildings.push({
      id: building.id,
      cx_mm: rect.cx * scale,
      cy_mm: rect.cy * scale,
      angle_rad: rect.angle,
      width_mm: width * scale,
      depth_mm: depth * scale,
      height_m: building.height_m,
      is_tall: building.is_tall,
      dilation_m: dilation,
      dilated: dilation > 0,
    });
  }
  return { buildings, dilatedCount, droppedCount };
}

/**
 * Per-instance matrices for the building InstancedMesh, column-major, 16
 * floats each, ready to be dropped straight into `instanceMatrix.array`.
 *
 * This is the ONLY thing a height slider recomputes. It is pure arithmetic --
 * no hulls, no allocations beyond the buffer -- so 5000 buildings cost well
 * under a frame.
 *
 * The box geometry is a unit cube centred on the origin, so the matrix is
 * `translate(cx, cy, mid_z) * rotateZ(angle) * scale(width, depth, height)`.
 * Buildings are drawn from the base top, not from `building_bottom_mm`: the
 * build's 0.2 mm overlap only exists to make its union unambiguous and would be
 * invisible inside the slab here.
 *
 * **Heroes are drawn at their hero height.** `building_top_mm_for(..., is_hero)`
 * is the shared function the build extrudes with, and the ids come from
 * `transform.hero_height_ids`, which is empty unless `hero_mode` actually grants
 * true height -- so `own_color` alone moves nothing. Until this call went
 * through the hero-aware form, a picked hero was coloured but not raised, and
 * that was the one place the preview knowingly disagreed with the build
 * (`docs/handoff/v2-04-ui.md` §11).
 */
export function buildingInstanceMatrices(
  buildings: ReadonlyArray<PreviewBuilding>,
  params: PrintParams,
  scale: number,
  into?: Float32Array,
): Float32Array {
  const out =
    into && into.length >= buildings.length * 16
      ? into
      : new Float32Array(buildings.length * 16);
  const base = T.base_top_mm(params);
  // Hoisted: a scene holds thousands of buildings and this set holds at most
  // twelve, so the membership test must not rebuild it per instance.
  const heroes = T.hero_height_ids(params);
  for (let i = 0; i < buildings.length; i += 1) {
    const b = buildings[i];
    const top = T.building_top_mm_for(
      b,
      params,
      scale,
      heroes.size > 0 && heroes.has(b.id),
    );
    const height = top - base;
    const c = Math.cos(b.angle_rad);
    const s = Math.sin(b.angle_rad);
    const o = i * 16;
    out[o + 0] = c * b.width_mm;
    out[o + 1] = s * b.width_mm;
    out[o + 2] = 0;
    out[o + 3] = 0;
    out[o + 4] = -s * b.depth_mm;
    out[o + 5] = c * b.depth_mm;
    out[o + 6] = 0;
    out[o + 7] = 0;
    out[o + 8] = 0;
    out[o + 9] = 0;
    out[o + 10] = height;
    out[o + 11] = 0;
    out[o + 12] = b.cx_mm;
    out[o + 13] = b.cy_mm;
    out[o + 14] = base + height / 2;
    out[o + 15] = 1;
  }
  return out;
}

/**
 * The HUD clause for footprints Stage 1 widened, e.g.
 * `"3353 widened to the 18.9 m minimum wall"`.
 *
 * The metres are `min_wall_ground = min_wall_mm(params) / scale`, i.e. TWO
 * nozzles of print divided by the scale -- the same wall the build repairs to
 * and the Stage 4 gate measures. It lives here, next to its test, because the
 * look-alike is silent: `min_detail` is one nozzle, exactly half of this, and
 * at any scale it reads as a perfectly plausible "minimum wall" in the HUD
 * (DECISIONS [V2-P1]).
 *
 * It takes `params` and the scale rather than a `Thresholds` record ON PURPOSE
 * (DECISIONS [V2-P1-fix]): a caller holding a `Thresholds` can hand over the
 * wrong field of it -- `min_detail` type-checks and reads plausibly -- so the
 * threshold selection would sit in the untested component instead of here.
 * With this signature the wall is derived from the shared helper and there is
 * no wrong argument to pass.
 */
export function dilatedNotice(
  count: number,
  params: PrintParams,
  scale: number,
): string {
  const metres = T.min_wall_mm(params) / scale;
  return `${count} widened to the ${metres.toFixed(1)} m minimum wall`;
}

/**
 * The GROUND radius under which a tree is dropped, in metres, or null when the
 * nozzle is small enough that 04's plain 0.5 mm rule is the only one that binds.
 * Non-null is worth saying out loud: at a fat nozzle whole avenues of trees
 * vanish from both the preview and the print.
 */
export function treeFloorNoticeMetres(
  params: PrintParams,
  scale: number,
): number | null {
  const floor_mm = T.tree_min_radius_mm(params);
  if (floor_mm <= T.TREE_MIN_RADIUS_MM) return null;
  return floor_mm / scale;
}
