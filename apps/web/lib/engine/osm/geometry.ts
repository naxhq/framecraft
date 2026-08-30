/**
 * Minimal 2D polygon toolkit for `normalize.ts`, dependency-free (manifold-3d
 * is reserved for the solid engine; pulling its WASM into the ingest path
 * would blow the ingest performance budget and complicate a "pure" scene
 * builder with an async init). Mirrors the parts of shapely/GEOS that
 * `services/bake/app/ingest/normalize.py` and `app/geom/project.py` use:
 * orientation, simplification, snap-to-grid, ring assembly from line
 * segments, convex-window clipping and a best-effort polygon union.
 *
 * Deviations from GEOS, recorded here rather than only in DECISIONS.md
 * because they explain *why* the functions are shaped the way they are:
 *
 * - `clipConvex` (Sutherland-Hodgman) is exact for a convex clip window
 *   (always true here: the crop square). For a subject whose true
 *   intersection with the window is topologically disconnected (a re-entrant
 *   shape straddling the boundary twice) it returns one ring with a
 *   zero-width bridge between the pieces instead of two separate rings; the
 *   enclosed AREA is still exact (the bridge contributes zero shoelace area),
 *   only the rare multi-piece crop case renders as one merged outline
 *   instead of two SceneGraph entries. [V3-P2-E1]
 * - `unionPair` (Greiner-Hormann) handles two simple, hole-free rings. It is
 *   used for 03 step 7 (genuinely overlapping footprints) and for the
 *   water/green dissolve; on any degeneracy (a vertex of one ring landing
 *   exactly on an edge of the other, or a run of collinear overlapping
 *   edges -- both real for adjacent OSM footprints digitized along a shared
 *   wall) the crossing search cannot form a clean traversal, so it falls
 *   back to the larger-area input ring, exactly Python's own last-resort
 *   fallback in `_safe_union` (`geometry.test.ts` exercises both the clean
 *   and the degenerate path directly). [V3-P2-E1]
 * - `intersectionArea` is exact when at least one side is convex
 *   (Sutherland-Hodgman clips the other side by it, the common case: the
 *   crop square and most footprints). Otherwise it derives the area from
 *   `unionPair`'s Greiner-Hormann result via inclusion-exclusion
 *   (`area(a) + area(b) - area(a∪b)`), and only when that too degenerates
 *   does it fall back to zero -- measured against a naive bounding-box
 *   overlap estimate on the real Chicago fixture, that estimate badly
 *   over-merged adjacent non-overlapping footprints (up to 165 spurious
 *   merges out of 1341 candidates vs Python's real 88); zero is the
 *   conservative direction for a merge decision. Used only to decide
 *   *whether* two footprints should merge (03 step 7) or two water/green
 *   pieces should dissolve together, never to produce emitted geometry.
 */

export type Point = readonly [number, number];
export type Ring = Point[];

export interface Bbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const EPS = 1e-9;

export function bboxOfRing(ring: Ring): Bbox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function bboxOverlap(a: Bbox, b: Bbox): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

export function bboxOverlapArea(a: Bbox, b: Bbox): number {
  const w = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const h = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  return w * h;
}

/** Signed shoelace area: positive for CCW, negative for CW. Ring need not repeat its first point. */
export function signedArea(ring: Ring): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export function area(ring: Ring): number {
  return Math.abs(signedArea(ring));
}

/** Polygon area net of holes, matching shapely `Polygon(exterior, holes).area`. */
export function netArea(exterior: Ring, holes: Ring[]): number {
  let a = area(exterior);
  for (const h of holes) a -= area(h);
  return Math.max(a, 0);
}

/** Area of the exterior alone, ignoring holes (03 step 6's "outline" comparison). */
export function exteriorArea(exterior: Ring): number {
  return area(exterior);
}

/** Polygon centroid (area-weighted), matching shapely `.centroid` for a simple ring. */
export function centroid(ring: Ring): Point {
  let cx = 0;
  let cy = 0;
  let a = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < EPS) {
    // Degenerate (zero-area) ring: fall back to the vertex average.
    let sx = 0;
    let sy = 0;
    for (const [x, y] of ring) {
      sx += x;
      sy += y;
    }
    return [sx / n, sy / n];
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/**
 * Polygon centroid net of holes (composite-area formula), matching shapely
 * `Polygon(exterior, holes).centroid`. Holes are assumed to lie inside the
 * exterior, which every hole this engine attaches has already been tested
 * for (`pointInRing` at attach time).
 */
export function centroidWithHoles(exterior: Ring, holes: Ring[]): Point {
  const [ex, ey] = centroid(exterior);
  const eA = area(exterior);
  let sx = ex * eA;
  let sy = ey * eA;
  let netA = eA;
  for (const h of holes) {
    const hA = area(h);
    const [hx, hy] = centroid(h);
    sx -= hx * hA;
    sy -= hy * hA;
    netA -= hA;
  }
  if (netA <= EPS) return [ex, ey];
  return [sx / netA, sy / netA];
}

/** Ensure a ring winds CCW (sign > 0) or CW (sign < 0), like shapely's `orient`. */
export function orientRing(ring: Ring, ccw: boolean): Ring {
  const s = signedArea(ring);
  const isCcw = s > 0;
  if (isCcw === ccw) return ring;
  return [...ring].reverse();
}

function dist2(p: Point, a: Point, b: Point): number {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < EPS) {
    const ddx = px - ax;
    const ddy = py - ay;
    return ddx * ddx + ddy * ddy;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ddx = px - cx;
  const ddy = py - cy;
  return ddx * ddx + ddy * ddy;
}

/** Douglas-Peucker over an open point sequence (not assumed closed). */
export function simplifyPath(points: Point[], toleranceM: number): Point[] {
  if (points.length < 3) return points;
  const tol2 = toleranceM * toleranceM;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    if (end <= start + 1) continue;
    let maxD = -1;
    let maxI = -1;
    for (let i = start + 1; i < end; i++) {
      const d = dist2(points[i], points[start], points[end]);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > tol2) {
      keep[maxI] = 1;
      stack.push([start, maxI], [maxI, end]);
    }
  }
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * Douglas-Peucker over a closed ring (03's `simplify(0.25, preserve_topology=True)`
 * on a LinearRing). Splits at the two points farthest apart so the closure
 * seam is not itself simplified away, simplifies each half, then rejoins.
 * Matches plain (non-topology-preserving) Douglas-Peucker; for the typical
 * simple, non-self-intersecting building/road footprint GEOS's
 * topology-preserving variant produces the same result because there is no
 * topology to preserve against. [V3-P2-E1]
 */
// Above this many vertices, the exact O(n^2) farthest-pair scan below is
// replaced by an O(n) approximate one (extreme points on the bbox). A
// `natural=water` relation can carry an entire lake's shoreline (the Chicago
// fixture's Lake Michigan ring has 47k vertices) even though only a sliver
// falls near the crop; the exact scan alone cost ~1.5 s on that one ring.
// Buildings and roads never approach this size, so building-area parity
// (pinned to 1e-6 m) is unaffected. [V3-P2-E1]
const EXACT_FARTHEST_PAIR_LIMIT = 500;

function farthestPairExact(ring: Ring): [number, number] {
  let iMax = 0;
  let jMax = 1;
  let best = -1;
  for (let i = 0; i < ring.length; i++) {
    for (let j = i + 1; j < ring.length; j++) {
      const dx = ring[i][0] - ring[j][0];
      const dy = ring[i][1] - ring[j][1];
      const d = dx * dx + dy * dy;
      if (d > best) {
        best = d;
        iMax = i;
        jMax = j;
      }
    }
  }
  return [iMax, jMax];
}

/** O(n) approximation: farthest pair among the four bbox-extreme points. */
function farthestPairApprox(ring: Ring): [number, number] {
  let iMinX = 0;
  let iMaxX = 0;
  let iMinY = 0;
  let iMaxY = 0;
  for (let i = 1; i < ring.length; i++) {
    if (ring[i][0] < ring[iMinX][0]) iMinX = i;
    if (ring[i][0] > ring[iMaxX][0]) iMaxX = i;
    if (ring[i][1] < ring[iMinY][1]) iMinY = i;
    if (ring[i][1] > ring[iMaxY][1]) iMaxY = i;
  }
  const candidates = [...new Set([iMinX, iMaxX, iMinY, iMaxY])];
  let best = -1;
  let iMax = candidates[0];
  let jMax = candidates[Math.min(1, candidates.length - 1)];
  for (let a = 0; a < candidates.length; a++) {
    for (let b = a + 1; b < candidates.length; b++) {
      const i = candidates[a];
      const j = candidates[b];
      const dx = ring[i][0] - ring[j][0];
      const dy = ring[i][1] - ring[j][1];
      const d = dx * dx + dy * dy;
      if (d > best) {
        best = d;
        iMax = Math.min(i, j);
        jMax = Math.max(i, j);
      }
    }
  }
  return [iMax, jMax];
}

export function simplifyRing(ring: Ring, toleranceM: number): Ring {
  if (ring.length < 4) return ring;
  const [iMax, jMax] =
    ring.length > EXACT_FARTHEST_PAIR_LIMIT ? farthestPairApprox(ring) : farthestPairExact(ring);
  const first = ring.slice(iMax, jMax + 1);
  const second = [...ring.slice(jMax), ...ring.slice(0, iMax + 1)];
  const s1 = simplifyPath(first, toleranceM);
  const s2 = simplifyPath(second, toleranceM);
  // s1 ends where s2 starts and s2 ends where s1 starts; drop the duplicate joins.
  const out = [...s1.slice(0, -1), ...s2.slice(0, -1)];
  return out.length >= 3 ? out : ring;
}

/** Round to the 1 mm emission grid and drop consecutive duplicate points. */
export function snapRing(ring: Ring, gridM = 0.001): Ring {
  const out: Point[] = [];
  for (const [x, y] of ring) {
    const rx = Math.round(x / gridM) * gridM;
    const ry = Math.round(y / gridM) * gridM;
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - rx) > EPS || Math.abs(last[1] - ry) > EPS) {
      out.push([rx, ry]);
    }
  }
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.abs(first[0] - last[0]) <= EPS && Math.abs(first[1] - last[1]) <= EPS) {
      out.pop();
    } else {
      break;
    }
  }
  return out;
}

/** Round to millimeters for emission; keeps consecutive duplicates collapsed but does not close/unclose. */
export function roundPoints(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const [x, y] of points) {
    const p: Point = [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

function isConvex(ring: Ring): boolean {
  const n = ring.length;
  if (n < 4) return true;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % n];
    const [cx, cy] = ring[(i + 2) % n];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < EPS) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * Sutherland-Hodgman clip of `subject` by the convex ring `clip`. Exact for
 * any simple subject and a convex clip window; see the module doc for the
 * multi-piece caveat.
 */
export function clipConvex(subject: Ring, clip: Ring): Ring {
  let output: Ring = subject;
  const n = clip.length;
  for (let i = 0; i < n && output.length; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % n];
    const input = output;
    output = [];
    const edgeCross = (p: Point): number => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    for (let k = 0; k < input.length; k++) {
      const cur = input[k];
      const prev = input[(k - 1 + input.length) % input.length];
      const curIn = edgeCross(cur) >= -EPS;
      const prevIn = edgeCross(prev) >= -EPS;
      if (curIn) {
        if (!prevIn) output.push(intersectSegLine(prev, cur, a, b));
        output.push(cur);
      } else if (prevIn) {
        output.push(intersectSegLine(prev, cur, a, b));
      }
    }
  }
  return output;
}

/**
 * Intersection of segment p1->p2 with the infinite line through a,b.
 * `t` solves `(p1 + t*dP - a) x dA = 0` for the parameter along p1->p2:
 * `t = [(a-p1) x dA] / [dP x dA]` (2D cross `u x v = u.x*v.y - u.y*v.x`).
 */
function intersectSegLine(p1: Point, p2: Point, a: Point, b: Point): Point {
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dax = bx - ax;
  const day = by - ay;
  const dpx = x2 - x1;
  const dpy = y2 - y1;
  const denom = dpx * day - dpy * dax;
  if (Math.abs(denom) < 1e-15) return p2;
  const t = ((ax - x1) * day - (ay - y1) * dax) / denom;
  return [x1 + t * dpx, y1 + t * dpy];
}

/** Axis-aligned box as a CCW ring, for use as a `clipConvex` window. */
export function boxRing(minX: number, minY: number, maxX: number, maxY: number): Ring {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}

/**
 * Area of `a ∩ b` for two simple rings. Exact when at least one is convex
 * (the common case for the crop square and for most footprints, via
 * Sutherland-Hodgman). Otherwise falls back to the inclusion-exclusion
 * identity `area(a∩b) = area(a) + area(b) - area(a∪b)` using the same
 * Greiner-Hormann union walk `unionPair` uses, which is exact whenever it
 * succeeds; only when THAT also degenerates does this fall back to zero (a
 * bounding-box-overlap estimate was tried first and measured to badly
 * over-merge adjacent, non-overlapping footprints -- see
 * DECISIONS.md [V3-P2-E1] for the measured counts). Used only for the 03
 * step 7 merge decision, never to produce emitted geometry.
 */
export function intersectionArea(a: Ring, b: Ring): number {
  const boxA = bboxOfRing(a);
  const boxB = bboxOfRing(b);
  if (!bboxOverlap(boxA, boxB)) return 0;
  if (isConvex(a)) return area(clipConvex(b, a));
  if (isConvex(b)) return area(clipConvex(a, b));
  try {
    const merged = greinerHormannUnion(a, b);
    if (merged && merged.length >= 3) {
      const unionArea = area(merged);
      if (unionArea >= Math.max(area(a), area(b)) - EPS) {
        const est = area(a) + area(b) - unionArea;
        return est > 0 ? est : 0;
      }
    }
  } catch {
    // fall through to zero
  }
  return 0;
}

/**
 * Best-effort union of two simple, hole-free rings via Sutherland-Hodgman
 * style boundary walking when one side is convex (exact); falls back to the
 * larger-area ring, matching `_safe_union`'s ultimate fallback, whenever the
 * inputs are not simply "one convex, one arbitrary" or the walk degenerates.
 */
export function unionPair(a: Ring, b: Ring): Ring {
  try {
    const merged = greinerHormannUnion(a, b);
    if (merged && merged.length >= 3 && area(merged) >= Math.max(area(a), area(b)) - EPS) {
      return merged;
    }
  } catch {
    // fall through to the heuristic below
  }
  return area(a) >= area(b) ? a : b;
}

/** Reduce many rings that may pairwise overlap into unioned groups, largest-first. */
export function unionMany(rings: Ring[]): Ring {
  if (rings.length === 0) return [];
  let acc = rings[0];
  for (let i = 1; i < rings.length; i++) acc = unionPair(acc, rings[i]);
  return acc;
}

// ---------------------------------------------------------------------------
// Greiner-Hormann polygon union (simple rings, no holes)
// ---------------------------------------------------------------------------

interface GhVertex {
  p: Point;
  intersect: boolean;
  entry: boolean;
  neighbor: number; // index into the other polygon's vertex array, for intersections
  alpha: number; // parametric position along its own edge, for sorting
  next: number;
  prev: number;
  visited: boolean;
}

export function pointInRing(p: Point, ring: Ring): boolean {
  const [px, py] = p;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function buildGhList(ring: Ring): GhVertex[] {
  return ring.map((p, i, arr) => ({
    p,
    intersect: false,
    entry: false,
    neighbor: -1,
    alpha: 0,
    next: (i + 1) % arr.length,
    prev: (i - 1 + arr.length) % arr.length,
    visited: false,
  }));
}

/** Greiner-Hormann union; returns null if the boundary walk cannot close (degenerate input). */
function greinerHormannUnion(subject: Ring, clip: Ring): Ring | null {
  if (subject.length < 3 || clip.length < 3) return null;
  const s = buildGhList(subject);
  const c = buildGhList(clip);

  // 1. Find every proper intersection between an S edge and a C edge, insert
  //    into both lists in edge-parametric order.
  type Ins = { alpha: number; p: Point };
  const sInserts: Ins[][] = subject.map(() => []);
  const cInserts: Ins[][] = clip.map(() => []);

  for (let i = 0; i < subject.length; i++) {
    const a1 = subject[i];
    const a2 = subject[(i + 1) % subject.length];
    for (let j = 0; j < clip.length; j++) {
      const b1 = clip[j];
      const b2 = clip[(j + 1) % clip.length];
      const hit = segmentIntersection(a1, a2, b1, b2);
      if (hit) {
        sInserts[i].push({ alpha: hit.ta, p: hit.p });
        cInserts[j].push({ alpha: hit.tb, p: hit.p });
      }
    }
  }
  const anyIntersections = sInserts.some((l) => l.length > 0);
  if (!anyIntersections) {
    // No boundary crossings: either disjoint (union is not a single ring --
    // caller keeps both separately) or one fully contains the other.
    if (pointInRing(subject[0], clip)) return clip;
    if (pointInRing(clip[0], subject)) return subject;
    return null;
  }

  const sList: GhVertex[] = [];
  const sOrigIndex: number[] = [];
  for (let i = 0; i < s.length; i++) {
    sList.push(s[i]);
    sOrigIndex.push(i);
    const ins = [...sInserts[i]].sort((a, b) => a.alpha - b.alpha);
    for (const it of ins) {
      sList.push({
        p: it.p,
        intersect: true,
        entry: false,
        neighbor: -1,
        alpha: it.alpha,
        next: -1,
        prev: -1,
        visited: false,
      });
      sOrigIndex.push(-1);
    }
  }
  const cList: GhVertex[] = [];
  const cOrigIndex: number[] = [];
  for (let i = 0; i < c.length; i++) {
    cList.push(c[i]);
    cOrigIndex.push(i);
    const ins = [...cInserts[i]].sort((a, b) => a.alpha - b.alpha);
    for (const it of ins) {
      cList.push({
        p: it.p,
        intersect: true,
        entry: false,
        neighbor: -1,
        alpha: it.alpha,
        next: -1,
        prev: -1,
        visited: false,
      });
      cOrigIndex.push(-1);
    }
  }
  relink(sList);
  relink(cList);

  // 2. Cross-link intersection vertices between the two lists by matching
  //    coordinates (each intersection point appears once in each list).
  const cIntersectIdx = new Map<string, number>();
  for (let i = 0; i < cList.length; i++) {
    if (cList[i].intersect) cIntersectIdx.set(keyOf(cList[i].p), i);
  }
  for (let i = 0; i < sList.length; i++) {
    if (!sList[i].intersect) continue;
    const j = cIntersectIdx.get(keyOf(sList[i].p));
    if (j === undefined) return null; // numerical mismatch; bail to fallback
    sList[i].neighbor = j;
    cList[j].neighbor = i;
  }

  // 3. Entry/exit marking: a vertex is "entry" into the union walk if the
  //    midpoint just after it (in S) is OUTSIDE the other polygon (for
  //    union we walk along the outside).
  markEntryExit(sList, clip);
  markEntryExit(cList, subject);

  // 4. Walk: start at an unvisited S intersection, follow the "outside"
  //    direction, hop lists at every intersection, until back at the start.
  const out: Point[] = [];
  let guard = 0;
  const maxSteps = (sList.length + cList.length) * 4 + 16;
  const startIdx = sList.findIndex((v) => v.intersect && !v.visited);
  if (startIdx === -1) return null;
  let cur = sList;
  let idx = startIdx;
  const startKey = keyOf(sList[startIdx].p);
  do {
    const v = cur[idx];
    if (v.visited && out.length > 0) break;
    v.visited = true;
    out.push(v.p);
    if (v.intersect) {
      const forward = v.entry;
      idx = forward ? v.next : v.prev;
      if (cur[v.neighbor] !== undefined) {
        // hop to the other list at the linked vertex
        const otherList = cur === sList ? cList : sList;
        const otherIdx = v.neighbor;
        cur = otherList;
        idx = cur[otherIdx].entry ? cur[otherIdx].next : cur[otherIdx].prev;
        cur[otherIdx].visited = true;
      }
    } else {
      idx = v.next;
    }
    guard++;
  } while (guard < maxSteps && keyOf(cur[idx]?.p ?? [NaN, NaN]) !== startKey);

  if (out.length < 3) return null;
  return dedupeClosed(out);
}

function relink(list: GhVertex[]): void {
  const n = list.length;
  for (let i = 0; i < n; i++) {
    list[i].next = (i + 1) % n;
    list[i].prev = (i - 1 + n) % n;
  }
}

function keyOf(p: Point): string {
  return `${Math.round(p[0] * 1e6)}:${Math.round(p[1] * 1e6)}`;
}

function dedupeClosed(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > EPS || Math.abs(last[1] - p[1]) > EPS) out.push(p);
  }
  while (out.length > 1) {
    const f = out[0];
    const l = out[out.length - 1];
    if (Math.abs(f[0] - l[0]) <= EPS && Math.abs(f[1] - l[1]) <= EPS) out.pop();
    else break;
  }
  return out;
}

function markEntryExit(list: GhVertex[], other: Ring): void {
  // A run of consecutive non-intersection vertices shares one inside/outside
  // status (they cannot cross the other polygon's boundary); mark every
  // intersection by the status of the run that follows it.
  const n = list.length;
  for (let i = 0; i < n; i++) {
    if (!list[i].intersect) continue;
    const nextOrig = list[list[i].next];
    const sample: Point = nextOrig.intersect
      ? midpoint(list[i].p, nextOrig.p)
      : midpoint(list[i].p, nextOrig.p);
    const outside = !pointInRing(sample, other);
    list[i].entry = outside; // union: enter the walk when heading outside the other polygon
  }
}

function midpoint(a: Point, b: Point): Point {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function segmentIntersection(
  p1: Point,
  p2: Point,
  p3: Point,
  p4: Point,
): { p: Point; ta: number; tb: number } | null {
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const [x3, y3] = p3;
  const [x4, y4] = p4;
  const d1x = x2 - x1;
  const d1y = y2 - y1;
  const d2x = x4 - x3;
  const d2y = y4 - y3;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return null; // parallel or collinear: treated as non-crossing
  const t = ((x3 - x1) * d2y - (y3 - y1) * d2x) / denom;
  const u = ((x3 - x1) * d1y - (y3 - y1) * d1x) / denom;
  if (t <= EPS || t >= 1 - EPS || u <= EPS || u >= 1 - EPS) return null; // ignore endpoint touches
  return { p: [x1 + t * d1x, y1 + t * d1y], ta: t, tb: u };
}

// ---------------------------------------------------------------------------
// ring assembly from line segments (multipolygon relation members)
// ---------------------------------------------------------------------------

/** Chain open line segments sharing endpoints into closed rings (03 step 2 at the relation level). */
export function assembleRings(segments: Point[][]): Ring[] {
  type Edge = { pts: Point[]; used: boolean };
  const edges: Edge[] = segments.filter((s) => s.length >= 2).map((pts) => ({ pts, used: false }));
  const keyAt = (p: Point) => `${Math.round(p[0] * 1000)}:${Math.round(p[1] * 1000)}`;
  const byEndpoint = new Map<string, number[]>();
  edges.forEach((e, i) => {
    for (const p of [e.pts[0], e.pts[e.pts.length - 1]]) {
      const k = keyAt(p);
      const list = byEndpoint.get(k) ?? [];
      list.push(i);
      byEndpoint.set(k, list);
    }
  });

  const rings: Ring[] = [];
  for (let startIdx = 0; startIdx < edges.length; startIdx++) {
    if (edges[startIdx].used) continue;
    edges[startIdx].used = true;
    let chain: Point[] = [...edges[startIdx].pts];
    let guard = 0;
    while (guard < edges.length + 1) {
      guard++;
      const tail = chain[chain.length - 1];
      const k = keyAt(tail);
      const candidates = (byEndpoint.get(k) ?? []).filter((i) => !edges[i].used);
      if (candidates.length === 0) break;
      const next = edges[candidates[0]];
      next.used = true;
      const nk0 = keyAt(next.pts[0]);
      if (nk0 === k) {
        chain = [...chain, ...next.pts.slice(1)];
      } else {
        chain = [...chain, ...[...next.pts].reverse().slice(1)];
      }
      if (keyAt(chain[chain.length - 1]) === keyAt(chain[0]) && chain.length > 2) break;
    }
    if (chain.length >= 4 && keyAt(chain[0]) === keyAt(chain[chain.length - 1])) {
      const ring = chain.slice(0, -1);
      if (area(ring) > 0) rings.push(ring);
    }
  }
  return rings;
}
