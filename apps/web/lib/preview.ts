/**
 * SceneGraph + PrintParams -> preview geometry, in PRINT MILLIMETRES.
 *
 * Rules this module exists to enforce:
 *
 * 1. **No maths of its own.** Every scale, threshold, height and z offset comes
 *    from `lib/transform.ts`, which is the mirror of the build's
 *    `app/geom/transform.py`. The only geometry this file computes on its own
 *    is *shape* (oriented bounding rectangles, ribbon triangles) -- never a
 *    printed dimension.
 * 2. **No booleans.** 02: the browser never runs CSG. The build's stage-1
 *    minimum-feature repair is approximated with a cheap per-footprint 2D
 *    dilation (see `buildBuildings`), which is why the UI carries the
 *    "preview is approximate" note.
 * 3. **No three.js.** Output is plain numbers and typed arrays so it can be
 *    unit-tested in node and so a slider change can rewrite one instance
 *    buffer without touching anything else. `components/scene/*` turns this
 *    into three objects.
 *
 * Coordinate frame: x east, y north, z up -- the same frame as the SceneGraph
 * and the build. `components/scene/CityPreview.tsx` rotates the whole group once
 * to satisfy three.js's Y-up convention.
 */

import type { AreaFeature, PrintParams, SceneGraph } from "./contracts";
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

/** A triangulated flat ribbon: interleaved xyz, z always 0 (the mesh sets z). */
export interface PreviewRibbons {
  positions: Float32Array;
  triangleCount: number;
}

/** A polygon with holes, in mm, ready for `new THREE.Shape()`. */
export interface PreviewArea {
  /** Flat [x0,y0,x1,y1,...] outer contour, mm. */
  outer: number[];
  /** Flat contours for the holes, mm. */
  holes: number[][];
}

export interface PreviewTree {
  x_mm: number;
  y_mm: number;
  radius_mm: number;
  height_mm: number;
}

export interface PreviewModel {
  /** mm of print per metre of ground, from `transform.scale_mm_per_m`. */
  scale: number;
  /** Ground radius the scene was actually built with. */
  radius_m: number;
  thresholds: T.Thresholds;
  base_top_mm: number;
  plate: T.Extents;
  content: T.Extents;
  frame: T.FrameGeometry;
  buildings: PreviewBuilding[];
  /** Footprints the build's stage-1 repair would widen. */
  dilatedCount: number;
  /** Footprints the build would drop as sub-detail. */
  droppedCount: number;
  roads: PreviewRibbons | null;
  road_z_mm: number | null;
  water: PreviewArea[];
  water_z_mm: number | null;
  green: PreviewArea[];
  green_z_mm: number;
  trees: PreviewTree[];
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

// ---------------------------------------------------------------------------
// Roads
// ---------------------------------------------------------------------------

/** Segments used to approximate the round join at each interior vertex. */
const JOIN_SEGMENTS = 6;

/**
 * Flat ribbon triangles for every road, in mm, merged into ONE buffer.
 *
 * 04 stage 1 buffers each centreline by `road_width_ground / 2` with flat caps
 * and round joins; this emits the quad per segment plus a small fan at each
 * interior vertex for the join. Roads are not subtracted from buildings (that
 * is a boolean) -- another documented preview approximation.
 *
 * Returns null when `road_mode` is "off", which is also what
 * `transform.road_z_mm` reports.
 */
export function buildRoads(scene: SceneGraph, params: PrintParams): PreviewRibbons | null {
  if (T.road_z_mm(params) === null) return null;
  const radius_m = T.radius_m_from_bounds(scene.bounds);
  const scale = T.scale_mm_per_m(params, radius_m);
  const thresholds = T.thresholds_ground_m(params, scale);

  const tris: number[] = [];
  const pushTri = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
  ): void => {
    tris.push(ax, ay, 0, bx, by, 0, cx, cy, 0);
  };

  for (const road of scene.roads) {
    const path = road.path;
    if (path.length < 2) continue;
    const half = (T.road_width_ground_m(road, params, thresholds) * scale) / 2;

    for (let i = 0; i < path.length - 1; i += 1) {
      const ax = path[i][0] * scale;
      const ay = path[i][1] * scale;
      const bx = path[i + 1][0] * scale;
      const by = path[i + 1][1] * scale;
      const dx = bx - ax;
      const dy = by - ay;
      const length = Math.hypot(dx, dy);
      if (length < 1e-9) continue;
      const nx = (-dy / length) * half;
      const ny = (dx / length) * half;
      // Counter-clockwise in XY, so computeVertexNormals() points the ribbon
      // up (+z) like every other surface in the print frame.
      pushTri(ax + nx, ay + ny, ax - nx, ay - ny, bx - nx, by - ny);
      pushTri(ax + nx, ay + ny, bx - nx, by - ny, bx + nx, by + ny);
    }

    for (let i = 1; i < path.length - 1; i += 1) {
      const cx = path[i][0] * scale;
      const cy = path[i][1] * scale;
      for (let s = 0; s < JOIN_SEGMENTS; s += 1) {
        const a0 = (s / JOIN_SEGMENTS) * Math.PI * 2;
        const a1 = ((s + 1) / JOIN_SEGMENTS) * Math.PI * 2;
        pushTri(
          cx,
          cy,
          cx + Math.cos(a0) * half,
          cy + Math.sin(a0) * half,
          cx + Math.cos(a1) * half,
          cy + Math.sin(a1) * half,
        );
      }
    }
  }

  if (tris.length === 0) return null;
  return { positions: new Float32Array(tris), triangleCount: tris.length / 9 };
}

// ---------------------------------------------------------------------------
// Water and green
// ---------------------------------------------------------------------------

function toContour(ring: ReadonlyArray<ReadonlyArray<number>>, scale: number): number[] {
  const flat: number[] = [];
  for (const p of ring) {
    flat.push(p[0] * scale, p[1] * scale);
  }
  return flat;
}

/**
 * Water/green contours in mm, with the sub-detail ones dropped exactly the way
 * 04 stage 1 drops them. Holes are kept so the ShapeGeometry earcut can cut
 * islands out of a lake.
 */
export function buildAreas(
  features: ReadonlyArray<AreaFeature>,
  params: PrintParams,
  scale: number,
  thresholds: T.Thresholds,
): PreviewArea[] {
  void params;
  const out: PreviewArea[] = [];
  for (const feature of features) {
    if (feature.ring.length < 3) continue;
    if (T.area_dropped(T.ring_area_m2(feature.ring), thresholds)) continue;
    out.push({
      outer: toContour(feature.ring, scale),
      holes: feature.holes
        .filter((hole) => hole.length >= 3)
        .map((hole) => toContour(hole, scale)),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

/**
 * Visible trees only, capped and ordered exactly as the build orders them.
 *
 * The filter is `select_tree_indices_for`, i.e. 04's 0.5 mm rule AND the
 * nozzle-aware floor the build applies in stage 1 (`transform.tree_min_radius_mm`
 * -- an 8-gon cone of circumradius r is only `2 r cos(pi/8)` wide at its base).
 * At the default 0.4 mm nozzle the floor is 0.433 mm and 04's 0.5 mm still
 * binds, so nothing changes; from 0.5 mm up the preview drops exactly the trees
 * the build drops. The other half of 04's tree rule ("does not intersect a
 * building or road footprint") is a boolean the browser never runs, so the
 * preview can still show a tree the build removes -- never the reverse.
 */
export function buildTrees(scene: SceneGraph, params: PrintParams): PreviewTree[] {
  if (!params.trees) return [];
  const radius_m = T.radius_m_from_bounds(scene.bounds);
  const scale = T.scale_mm_per_m(params, radius_m);
  return T.select_tree_indices_for(scene.trees, params, scale).map((index) => {
    const tree = scene.trees[index];
    return {
      x_mm: tree.x * scale,
      y_mm: tree.y * scale,
      radius_mm: T.tree_radius_mm(tree, scale),
      height_mm: T.tree_height_mm(tree, scale),
    };
  });
}

/**
 * Per-instance matrices for the tree cones. The unit cone is 1 mm tall and
 * 1 mm in radius, centred on the origin with its axis along +z, so the matrix
 * is `translate(x, y, base_top + h/2) * scale(r, r, h)`.
 */
export function treeInstanceMatrices(
  trees: ReadonlyArray<PreviewTree>,
  baseTopMm: number,
  into?: Float32Array,
): Float32Array {
  const out =
    into && into.length >= trees.length * 16 ? into : new Float32Array(trees.length * 16);
  for (let i = 0; i < trees.length; i += 1) {
    const t = trees[i];
    const o = i * 16;
    out.fill(0, o, o + 16);
    out[o + 0] = t.radius_mm;
    out[o + 5] = t.radius_mm;
    out[o + 10] = t.height_mm;
    out[o + 12] = t.x_mm;
    out[o + 13] = t.y_mm;
    out[o + 14] = baseTopMm + t.height_mm / 2;
    out[o + 15] = 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Whole model
// ---------------------------------------------------------------------------

/**
 * Build everything at once. The React components call the individual builders
 * with their own memo keys so a slider only rebuilds what it touched; this is
 * the convenience entry point used by tests and by anything that wants the
 * complete picture.
 */
export function buildPreview(scene: SceneGraph, params: PrintParams): PreviewModel {
  const radius_m = T.radius_m_from_bounds(scene.bounds);
  const scale = T.scale_mm_per_m(params, radius_m);
  const thresholds = T.thresholds_ground_m(params, scale);
  const { buildings, dilatedCount, droppedCount } = buildBuildings(scene, params);
  const waterZ = T.water_z_mm(params);

  return {
    scale,
    radius_m,
    thresholds,
    base_top_mm: T.base_top_mm(params),
    plate: T.plate_extents_mm(params),
    content: T.content_extents_mm(params),
    frame: T.frame_geometry_mm(params),
    buildings,
    dilatedCount,
    droppedCount,
    roads: buildRoads(scene, params),
    road_z_mm: T.road_z_mm(params),
    water: waterZ === null ? [] : buildAreas(scene.water, params, scale, thresholds),
    water_z_mm: waterZ,
    green: buildAreas(scene.green, params, scale, thresholds),
    green_z_mm: T.green_z_mm(params),
    trees: buildTrees(scene, params),
  };
}

/**
 * The "the preview is approximate" line, using the real threshold rather than
 * a hard-coded number. 04 stage 1 step 4 closes the building layer with
 * `min_gap_ground / 2`, so anything closer than `min_gap_ground` merges.
 */
export function mergeNoticeMetres(thresholds: T.Thresholds): number {
  return thresholds.min_gap;
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
