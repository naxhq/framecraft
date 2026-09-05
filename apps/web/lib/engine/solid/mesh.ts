/**
 * Mesh-level repair, in double precision, on the way out of manifold3d.
 *
 * 04 stage 4's last row is "zero faces with area under 1e-9 mm^2", and no
 * boolean kernel meets it on its own: the reference implementation reaches it
 * with `assemble.finalize`, which prunes debris, simplifies, and then WELDS
 * vertices and re-imports the result through manifold3d. The JS binding cannot
 * do that last step - `Manifold.ofMesh` takes a `Float32Array`, so any
 * round trip through it quantises a model built in double to 7.6 nanometres at
 * a 90 mm coordinate, which is itself enough to collapse a triangle. So the
 * repair happens HERE, on the mesh data, and is verified here rather than by
 * handing it back to the kernel.
 *
 * Two defects, two repairs, both exact:
 *
 * * a **cap** is a triangle with two coincident vertices. Welding them merges
 *   the two indices and the triangle disappears. Nothing moves: the vertices
 *   were the same point.
 * * a **needle** is a triangle whose three vertices are collinear - a
 *   T-junction, where a boolean put a vertex partway along an edge that its
 *   neighbour still spans in one piece. The repair is to split the neighbour at
 *   that vertex and drop the needle. Nothing moves there either: the new edge
 *   runs through a point that was already on it.
 *
 * Everything is checked afterwards (closed, consistently wound, same volume,
 * no degenerate face left) and the original mesh is kept if any check fails,
 * because a mesh that is merely ugly beats one that is broken.
 */

import { perfSpan } from "../../perf";

/** 04 stage 4: a face under this area (mm^2) is degenerate. */
export const DEGENERATE_AREA_MM2 = 1e-9;

/**
 * Area (mm^2) the repair works to, two orders of magnitude above the gate's.
 *
 * The margin is not caution, it is arithmetic: a 3MF writes each coordinate as
 * a decimal string, and rounding a vertex onto that grid moves it, which moves
 * the area of the triangles that use it. A face measuring 4e-9 mm^2 in memory
 * can land under 1e-9 in the file - which is exactly what happened, once, on
 * the Chicago plate (36 faces sit between 1e-9 and 1e-8 before this margin,
 * and the reference validator found one of them below the line after the
 * write). Repairing to 1e-7 leaves the file with nothing within two decades of
 * the threshold.
 */
export const REPAIR_AREA_MM2 = 1e-7;

/**
 * Vertices this close (mm) are the same vertex.
 *
 * A nanometre, which is the first rung of the reference implementation's own
 * weld ladder (`assemble.WELD_DIGITS` starts at six decimals). It is an eighth
 * of the float32 spacing at a 90 mm coordinate and four orders of magnitude
 * under the print grid, so nothing real is merged - only the near-duplicates a
 * coincident-face boolean leaves, which on the Chicago parks region sit about
 * 1e-7 mm apart and are not caught by an exact match.
 */
export const WELD_EPSILON_MM = 1e-6;

/**
 * The weld ladder, mm: each rung is tried from the ORIGINAL mesh, coarsest
 * last, and the first that clears every degenerate face wins.
 *
 * The reference implementation welds on a ladder too (`assemble.WELD_DIGITS`,
 * "starts at six decimals"), and for the same reason: a boolean between two
 * arc-approximated outlines can leave a triangle whose three vertices are tens
 * of nanometres apart, which is real geometry to a 1 nm weld and nothing at all
 * to a printer. Measured on the phase 5 chamfer + rounded-corner build: one
 * triangle of 1.3e-10 mm^2 whose longest edge is 3.8e-5 mm, at the frame's
 * rounded inner corner, which 1e-6 cannot touch and 1e-4 removes exactly
 * (`[V3-P5-F1]`).
 *
 * The coarsest rung is 0.1 micrometres: a hundredth of the 3MF's own written
 * precision and four orders of magnitude under the print grid, so nothing a
 * printer or a file can tell apart is merged. Every rung is still subject to
 * the same acceptance test - closed, oriented, same volume - so a weld that
 * would open a hole is thrown away whatever its epsilon.
 */
export const WELD_LADDER_MM = [WELD_EPSILON_MM, 1e-5, 1e-4];

/** How many split-and-remeasure rounds the needle repair runs. */
export const REPAIR_ROUNDS = 4;

/**
 * How many float32 steps the pinch separation may take before it gives up.
 *
 * One step is enough for every case measured (a pinch is two vertices on ONE
 * float32 grid point, and one step leaves it); the doubling exists only so a
 * group of three or more coincident vertices cannot loop.
 */
export const PINCH_STEPS = 8;

/**
 * Longest edge a needle's LOCAL collapse may close, mm.
 *
 * The last resort, and the narrowest tool in this file: it welds the two ends
 * of one degenerate triangle's shortest edge and touches nothing else in the
 * mesh. The whole-mesh weld above cannot always do that job, because it is
 * all-or-nothing at its epsilon - the rung coarse enough to close a 1.4e-5 mm
 * needle in a tile of the Chicago plate also merges pairs a boolean meant to
 * keep apart somewhere else on that tile, the mesh comes back open, and the
 * acceptance test correctly throws the whole rung away. `splitNeedles` cannot
 * do it either when the needle's long edge is met by TWO triangles on the far
 * side, because then no single neighbour holds the twin to split.
 *
 * The same 0.1 micrometre as the ladder's coarsest rung, and subject to the
 * same acceptance test plus one of its own: closed, oriented, the same volume
 * to a nanolitre, and no more connected bodies than the mesh came in with (a
 * pinch is all three of the first and still two objects where there was one).
 *
 * OPT IN, and off by default (`cleanMesh`'s `collapseNeedles` option). The
 * ladder above clears every degenerate face an untiled build produces on its
 * own, at a coarser rung than this repair would let it reach, and a mesh that
 * is already clean must not be touched by a repair it does not need: with this
 * on for everything, the Chicago plate's merged mesh stopped one rung early on
 * a mesh that welded to one body only at the NEXT rung. `solid/tiling.ts` turns
 * it on, because a tile is five booleans deep and does produce needles the
 * whole-mesh weld cannot reach (`[V3-P7-A9]`).
 */
export const NEEDLE_COLLAPSE_MM = 1e-4;

export interface Mesh {
  positions: Float64Array;
  indices: Uint32Array;
}

export interface MeshReport {
  /** Vertices merged into a neighbour. */
  welded: number;
  /** Needles resolved by splitting the triangle across their long edge. */
  split: number;
  /** Triangles under `DEGENERATE_AREA_MM2` left in the result. */
  degenerate: number;
  /** Directed edges without exactly one twin. Zero for a closed, oriented mesh. */
  openEdges: number;
  /** Signed volume change from the repair, mm^3. */
  volumeDeltaMm3: number;
  /** True when the repair was accepted; false when the input was kept as it was. */
  applied: boolean;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export function triangleAreaMm2(
  p: ArrayLike<number>,
  ia: number,
  ib: number,
  ic: number,
): number {
  const a = ia * 3;
  const b = ib * 3;
  const c = ic * 3;
  const ux = p[b] - p[a];
  const uy = p[b + 1] - p[a + 1];
  const uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a];
  const vy = p[c + 1] - p[a + 1];
  const vz = p[c + 2] - p[a + 2];
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return 0.5 * Math.hypot(cx, cy, cz);
}

/** Triangles under 04's degenerate-face threshold. */
export function degenerateFaces(mesh: Mesh, threshold = DEGENERATE_AREA_MM2): number {
  return countDegenerate(mesh, threshold, doubleArea(mesh));
}

/**
 * The same coordinates a binary STL will carry: every one through `Math.fround`.
 *
 * A binary STL stores float32, so the file is not the mesh, it is the mesh on a
 * grid whose step is 1.2e-7 of the coordinate: 7.6e-6 mm at 90 mm and 1.5e-5 mm
 * at 180 mm. That grid is what the validator measures, because it reads the
 * file, and it is the only grid on which "is this face degenerate?" has the
 * same answer as the one 04 stage 4 gives the shipped artifact.
 */
export function float32Positions(p: ArrayLike<number>): Float64Array {
  const out = new Float64Array(p.length);
  for (let i = 0; i < p.length; i += 1) out[i] = Math.fround(p[i]);
  return out;
}

/** Triangles under `threshold` once the mesh is quantised to float32. */
export function float32DegenerateFaces(mesh: Mesh, threshold = DEGENERATE_AREA_MM2): number {
  const quantised = float32Positions(mesh.positions);
  return countDegenerate(mesh, threshold, (a, b, c) => triangleAreaMm2(quantised, a, b, c));
}

/**
 * Distinct vertices that share one float32 grid point.
 *
 * A binary STL has no vertex index, so a reader recovers the topology by
 * welding identical coordinates - `services/bake/app/cli.py`'s
 * `_index_stl_triangle_soup` does it bitwise on the float32 rows the file
 * stores. Two vertices the mesh keeps apart and the file cannot are therefore a
 * defect of the FILE: their merge hands an edge to four faces, and `manifold`,
 * `watertight` and `self_intersection` all fail on a model the 3MF of the same
 * mesh passes. Counted as the number of vertices that would be lost.
 */
export function float32Collisions(mesh: Mesh): number {
  const quantised = float32Positions(mesh.positions);
  const seen = new Set<string>();
  let lost = 0;
  for (let v = 0; v + 2 < quantised.length; v += 3) {
    const key = `${quantised[v]},${quantised[v + 1]},${quantised[v + 2]}`;
    if (seen.has(key)) lost += 1;
    else seen.add(key);
  }
  return lost;
}

/** Area of one triangle as a given measure sees it. */
type AreaOf = (ia: number, ib: number, ic: number) => number;

function doubleArea(mesh: Mesh): AreaOf {
  const p = mesh.positions;
  return (a, b, c) => triangleAreaMm2(p, a, b, c);
}

/**
 * The area a FILE will report for a face: the smaller of what the mesh measures
 * in double and what it measures once quantised to float32.
 *
 * Both writers are covered by one number. A 3MF writes decimal text at
 * {@link VERTEX_DECIMALS} places, so its faces keep their double area; a binary
 * STL writes float32, and a triangle whose three vertices are collinear to
 * within a float32 step has no area at all in it. Taking the minimum means a
 * repair that clears this measure clears the row in either file.
 */
function exportArea(mesh: Mesh): AreaOf {
  const p = mesh.positions;
  const quantised = float32Positions(p);
  return (a, b, c) => Math.min(triangleAreaMm2(p, a, b, c), triangleAreaMm2(quantised, a, b, c));
}

function countDegenerate(mesh: Mesh, threshold: number, area: AreaOf): number {
  let count = 0;
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    if (area(mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]) < threshold) count += 1;
  }
  return count;
}

/**
 * A directed edge `a -> b` as one double. Exact while `a < 2^21`, which is
 * the same bound `openEdges` has always keyed edges under; no mesh in this
 * engine is within an order of magnitude of it.
 */
function edgeKey(a: number, b: number): number {
  return a * 4294967296 + b;
}

/**
 * How many times each directed edge occurs, in flat typed arrays.
 *
 * An open-addressing table rather than a `Map`: `openEdges` runs on every
 * candidate the repair ladder produces, and on the 94 000-triangle merged
 * Chicago solid a `Map` keyed the same way cost 84 ms a call against under
 * 10 ms here. Same keys, same counts; only the container changed.
 */
class EdgeCounts {
  private keys: Float64Array;
  private counts: Int32Array;
  private mask: number;
  /** Distinct keys inserted, a key whose count fell back to zero included: what the load factor is measured on. */
  private held = 0;

  constructor(expected: number) {
    let capacity = 16;
    while (capacity < expected * 2) capacity *= 2;
    this.keys = new Float64Array(capacity).fill(-1);
    this.counts = new Int32Array(capacity);
    this.mask = capacity - 1;
  }

  /** An independent copy: the repair ladder mutates one per rung and the input's own table has to stay pristine. */
  clone(): EdgeCounts {
    const out = new EdgeCounts(0);
    out.keys = this.keys.slice();
    out.counts = this.counts.slice();
    out.mask = this.mask;
    out.held = this.held;
    return out;
  }

  /** Twice the capacity, the live keys re-hashed; a key whose count is zero is left behind. */
  private grow(): void {
    const keys = this.keys;
    const counts = this.counts;
    this.keys = new Float64Array(keys.length * 2).fill(-1);
    this.counts = new Int32Array(keys.length * 2);
    this.mask = this.keys.length - 1;
    this.held = 0;
    for (let i = 0; i < keys.length; i += 1) {
      if (keys[i] === -1 || counts[i] === 0) continue;
      const a = Math.floor(keys[i] / 4294967296);
      const j = this.slot(a, keys[i] - a * 4294967296);
      this.keys[j] = keys[i];
      this.counts[j] = counts[i];
      this.held += 1;
    }
  }

  private slot(a: number, b: number): number {
    let h = Math.imul(a, 0x9e3779b1) ^ Math.imul(b ^ 0x5bd1e995, 0x85ebca77);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    const key = edgeKey(a, b);
    let i = h & this.mask;
    for (;;) {
      const held = this.keys[i];
      if (held === key || held === -1) return i;
      i = (i + 1) & this.mask;
    }
  }

  add(a: number, b: number): void {
    const i = this.slot(a, b);
    if (this.keys[i] === -1) {
      this.keys[i] = edgeKey(a, b);
      this.counts[i] = 1;
      this.held += 1;
      if (this.held * 2 > this.keys.length) this.grow();
      return;
    }
    this.counts[i] += 1;
  }

  /** Take one occurrence of a directed edge back out. The key stays in the table at zero. */
  remove(a: number, b: number): void {
    const i = this.slot(a, b);
    if (this.keys[i] === -1 || this.counts[i] === 0) throw new Error(`EdgeCounts.remove: ${a} -> ${b} is not held`);
    this.counts[i] -= 1;
  }

  count(a: number, b: number): number {
    const i = this.slot(a, b);
    return this.keys[i] === -1 ? 0 : this.counts[i];
  }

  /**
   * How many of the two directions of the undirected edge `{a, b}` are open
   * right now: a direction that occurs at all, and not exactly once with
   * exactly one twin. {@link openEdgeCount} is this summed over every edge.
   */
  openness(a: number, b: number): number {
    const ab = this.count(a, b);
    const ba = this.count(b, a);
    let bad = 0;
    if (ab > 0 && (ab !== ba || ab !== 1)) bad += 1;
    if (ba > 0 && (ba !== ab || ba !== 1)) bad += 1;
    return bad;
  }

  /** Every distinct edge held with a non-zero count, as `(a, b, count)`. */
  forEach(visit: (a: number, b: number, count: number) => void): void {
    for (let i = 0; i < this.keys.length; i += 1) {
      const key = this.keys[i];
      if (key === -1 || this.counts[i] === 0) continue;
      const a = Math.floor(key / 4294967296);
      visit(a, key - a * 4294967296, this.counts[i]);
    }
  }
}

/**
 * Directed edges that do not have exactly one twin.
 *
 * Zero means the mesh is closed AND consistently wound, which is what the 3MF
 * and STL readers, the slicers and 04's `watertight` row all need.
 */
export function openEdges(mesh: Mesh): number {
  return openEdgeCount(edgeTable(mesh.indices));
}

/** Every directed edge of a triangle list, counted. */
function edgeTable(indices: ArrayLike<number>): EdgeCounts {
  const seen = new EdgeCounts(indices.length);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    seen.add(a, b);
    seen.add(b, c);
    seen.add(c, a);
  }
  return seen;
}

/** {@link openEdges}, read off a table that counts the mesh's edges. */
function openEdgeCount(seen: EdgeCounts): number {
  let bad = 0;
  seen.forEach((a, b, count) => {
    if (seen.count(b, a) !== count || count !== 1) bad += 1;
  });
  return bad;
}

/** One triangle a repair took out of (`-1`) or put into (`+1`) a mesh, in the order it happened. */
interface TriangleEvent {
  sign: 1 | -1;
  a: number;
  b: number;
  c: number;
}

/**
 * Move a table from one mesh to the mesh the events make of it, and return
 * how far the open-edge count moved.
 *
 * Exact, not estimated: an edge no event touches keeps both of its counts, so
 * only the touched edges can change their openness and only those are
 * measured, before and after. The events are applied in order, so a triangle
 * one pass added and then retired is counted in and out again. This is what
 * lets the repair ladder verify a split of a few hundred needles without
 * re-walking the 170 000 triangles of the merged plate for each pass (the
 * full recount, `mesh.clean.check`, was 200 ms of that mesh's repair).
 */
function applyEvents(table: EdgeCounts, events: readonly TriangleEvent[]): number {
  const touched = new Map<number, [number, number]>();
  const touch = (u: number, v: number): void => {
    const lo = u < v ? u : v;
    const hi = u < v ? v : u;
    touched.set(edgeKey(lo, hi), [lo, hi]);
  };
  for (const e of events) {
    touch(e.a, e.b);
    touch(e.b, e.c);
    touch(e.c, e.a);
  }
  let before = 0;
  for (const [u, v] of touched.values()) before += table.openness(u, v);
  for (const e of events) {
    if (e.sign > 0) {
      table.add(e.a, e.b);
      table.add(e.b, e.c);
      table.add(e.c, e.a);
    } else {
      table.remove(e.a, e.b);
      table.remove(e.b, e.c);
      table.remove(e.c, e.a);
    }
  }
  let after = 0;
  for (const [u, v] of touched.values()) after += table.openness(u, v);
  return after - before;
}

/** Undo {@link applyEvents}: the same events inverted, in reverse order. */
function revertEvents(table: EdgeCounts, events: readonly TriangleEvent[]): void {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.sign > 0) {
      table.remove(e.a, e.b);
      table.remove(e.b, e.c);
      table.remove(e.c, e.a);
    } else {
      table.add(e.a, e.b);
      table.add(e.b, e.c);
      table.add(e.c, e.a);
    }
  }
}

/** Signed volume of a closed triangle mesh, mm^3 (the divergence theorem). */
export function meshVolumeMm3(mesh: Mesh): number {
  const p = mesh.positions;
  let total = 0;
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    const a = mesh.indices[i] * 3;
    const b = mesh.indices[i + 1] * 3;
    const c = mesh.indices[i + 2] * 3;
    total +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return total / 6;
}

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

/**
 * Every pair of vertices within `epsilon` of each other on every axis, as a
 * CSR list: `partners[start[v] .. start[v + 1])` are the vertices BELOW `v`
 * that `v` may be welded onto.
 *
 * Found by one sort along x and a sweep, which is exact - the per-axis test is
 * the same `<= epsilon` the weld applies - and is a few milliseconds on a mesh
 * where the old 27-cell string-keyed scan spent hundreds: nearly every vertex
 * of a boolean result has no neighbour at all, and a sweep pays for those only
 * when the next vertex along x is already too far away. Built once per
 * `cleanMesh` at the ladder's coarsest rung, because a pair within a finer
 * rung is within the coarse one too, and each rung filters it by its own
 * epsilon.
 */
interface VertexPairs {
  epsilon: number;
  start: Int32Array;
  partners: Int32Array;
}

function vertexPairs(p: Float64Array, count: number, epsilon: number): VertexPairs {
  const px = new Float64Array(count);
  for (let v = 0; v < count; v += 1) px[v] = p[v * 3];
  const order = new Uint32Array(count);
  for (let v = 0; v < count; v += 1) order[v] = v;
  order.sort((a, b) => px[a] - px[b]);

  const lows: number[] = [];
  const highs: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = order[i];
    const ax = px[a];
    const ay = p[a * 3 + 1];
    const az = p[a * 3 + 2];
    for (let j = i + 1; j < count; j += 1) {
      const b = order[j];
      if (px[b] - ax > epsilon) break;
      if (Math.abs(p[b * 3 + 1] - ay) > epsilon || Math.abs(p[b * 3 + 2] - az) > epsilon) continue;
      if (a < b) {
        lows.push(a);
        highs.push(b);
      } else {
        lows.push(b);
        highs.push(a);
      }
    }
  }
  const start = new Int32Array(count + 1);
  for (const high of highs) start[high + 1] += 1;
  for (let v = 0; v < count; v += 1) start[v + 1] += start[v];
  const fill = Int32Array.from(start.subarray(0, count));
  const partners = new Int32Array(lows.length);
  for (let i = 0; i < lows.length; i += 1) {
    partners[fill[highs[i]]] = lows[i];
    fill[highs[i]] += 1;
  }
  return { epsilon, start, partners };
}

/**
 * Merge coincident vertices, drop the triangles that collapse.
 *
 * Vertices are visited in index order and each is either kept or merged onto a
 * vertex already kept that lies within `epsilon` of it on every axis. When
 * more than one kept vertex qualifies, the winner is the one the original
 * 27-cell grid scan would have met first: the cells around the vertex's own
 * (`floor(coordinate / epsilon)`) were walked in dx, dy, dz order and each
 * cell's bucket in insertion order, so the choice is the smallest
 * (cell rank, kept index) pair. That order is reproduced here from the pair
 * list instead of being rediscovered with a hash lookup per cell, and the
 * result is the same mesh to the last index.
 *
 * Only bitwise or near-bitwise duplicates are ever merged - the ones a
 * coincident-face boolean leaves (a measured example on the Chicago parks
 * region has an edge of length exactly zero); a pair that merely came within a
 * nanometre of each other by two different routes is not one this file may
 * merge on its own authority.
 */
function weld(mesh: Mesh, epsilon: number, pairs: VertexPairs): { mesh: Mesh; welded: number } {
  if (pairs.epsilon < epsilon) throw new Error("weld: the pair list was built at a finer epsilon than the weld asks for");
  const p = mesh.positions;
  const count = p.length / 3;
  const cellSize = Math.max(epsilon, Number.MIN_VALUE);
  const remap = new Uint32Array(count);
  const kept = new Uint8Array(count);
  const keep = new Uint32Array(count);
  let keepCount = 0;
  for (let v = 0; v < count; v += 1) {
    const x = p[v * 3];
    const y = p[v * 3 + 1];
    const z = p[v * 3 + 2];
    let hit = -1;
    let hitRank = Infinity;
    const end = pairs.start[v + 1];
    if (pairs.start[v] < end) {
      const cx = Math.floor(x / cellSize);
      const cy = Math.floor(y / cellSize);
      const cz = Math.floor(z / cellSize);
      for (let i = pairs.start[v]; i < end; i += 1) {
        const u = pairs.partners[i];
        if (kept[u] === 0) continue;
        const o = u * 3;
        if (Math.abs(p[o] - x) > epsilon || Math.abs(p[o + 1] - y) > epsilon || Math.abs(p[o + 2] - z) > epsilon) continue;
        // The cell a candidate sits in relative to this vertex's, in the scan
        // order of the grid walk. With a zero epsilon every candidate is an
        // exact duplicate, in the home cell.
        const rank =
          epsilon > 0
            ? (Math.floor(p[o] / cellSize) - cx + 1) * 9 + (Math.floor(p[o + 1] / cellSize) - cy + 1) * 3 + (Math.floor(p[o + 2] / cellSize) - cz + 1)
            : 13;
        const index = remap[u];
        if (rank < hitRank || (rank === hitRank && index < hit)) {
          hit = index;
          hitRank = rank;
        }
      }
    }
    if (hit >= 0) {
      remap[v] = hit;
      continue;
    }
    remap[v] = keepCount;
    kept[v] = 1;
    keep[keepCount] = v;
    keepCount += 1;
  }
  if (keepCount === count) return { mesh, welded: 0 };

  const positions = new Float64Array(keepCount * 3);
  for (let i = 0; i < keepCount; i += 1) {
    positions[i * 3] = p[keep[i] * 3];
    positions[i * 3 + 1] = p[keep[i] * 3 + 1];
    positions[i * 3 + 2] = p[keep[i] * 3 + 2];
  }
  const tris: number[] = [];
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    const a = remap[mesh.indices[i]];
    const b = remap[mesh.indices[i + 1]];
    const c = remap[mesh.indices[i + 2]];
    if (a === b || b === c || c === a) continue;
    tris.push(a, b, c);
  }
  return {
    mesh: { positions, indices: Uint32Array.from(tris) },
    welded: count - keepCount,
  };
}

/**
 * Close the shortest edge of every degenerate triangle, and nothing else.
 *
 * One pass, union-find so a chain of needles collapses onto one representative,
 * and no vertex moves: the survivor keeps its own position and the triangles
 * that referenced its partner reference it instead. A triangle left with a
 * repeated index is dropped, exactly as `weld` drops one, which is what leaves
 * the mesh closed: the needle's two long edges are twins of each other once its
 * short edge is gone.
 *
 * See {@link NEEDLE_COLLAPSE_MM} for why this exists beside `weld`.
 */
function collapseNeedles(
  mesh: Mesh,
  threshold: number,
  maxEdgeMm: number,
  area: AreaOf,
): { mesh: Mesh; collapsed: number } {
  const { positions: p, indices } = mesh;
  const parent = new Int32Array(p.length / 3);
  for (let v = 0; v < parent.length; v += 1) parent[v] = v;
  const find = (v: number): number => {
    let root = v;
    while (parent[root] !== root) root = parent[root];
    let walk = v;
    while (parent[walk] !== root) {
      const next = parent[walk];
      parent[walk] = root;
      walk = next;
    }
    return root;
  };

  let collapsed = 0;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    if (area(a, b, c) >= threshold) continue;
    const edges: Array<[number, number]> = [
      [a, b],
      [b, c],
      [c, a],
    ];
    let bestPair: [number, number] | null = null;
    let bestLength = Infinity;
    for (const [u, v] of edges) {
      const length = edgeLength(p, u, v);
      if (length < bestLength) {
        bestLength = length;
        bestPair = [u, v];
      }
    }
    if (bestPair === null || !(bestLength <= maxEdgeMm)) continue;
    const ra = find(bestPair[0]);
    const rb = find(bestPair[1]);
    if (ra === rb) continue;
    // The lower index survives, so the remap is stable whatever order the
    // triangles come in.
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
    collapsed += 1;
  }
  if (collapsed === 0) return { mesh, collapsed: 0 };

  const out: number[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = find(indices[i]);
    const b = find(indices[i + 1]);
    const c = find(indices[i + 2]);
    if (a === b || b === c || c === a) continue;
    out.push(a, b, c);
  }
  return {
    mesh: { positions: p, indices: Uint32Array.from(out) },
    collapsed,
  };
}

/**
 * Resolve T-junctions: split the neighbour across a needle's long edge.
 *
 * The needle `(v0, v1, v2)` whose longest edge is `v2 -> v0` has `v1` sitting
 * on that edge. Its neighbour holds the twin `v0 -> v2` and is some triangle
 * `(v0, v2, x)`; replacing it with `(v0, v1, x)` and `(v1, v2, x)` and dropping
 * the needle leaves every other edge paired exactly as it was, and moves no
 * vertex at all.
 */
function splitNeedles(
  mesh: Mesh,
  threshold: number,
  area: AreaOf,
): { mesh: Mesh; split: number; events: TriangleEvent[] } {
  const tri: number[] = Array.from(mesh.indices);
  // Every triangle retired or created, in order: what the caller's edge table
  // is moved by instead of being rebuilt (`applyEvents`).
  const events: TriangleEvent[] = [];
  const alive: boolean[] = new Array(tri.length / 3).fill(true);
  const limit = alive.length;

  // The needles, and the one directed edge each will ask about: the twin of
  // its longest edge. Only those edges are indexed. The owner of an edge is
  // the LAST triangle that carries it, exactly as a full index of every edge
  // would have answered, and a lookup is only ever made for a needle's twin,
  // so indexing the rest of the mesh's 3T edges (with a string key each) was
  // work that could never change an answer: 137 ms a pass on the merged
  // Chicago solid, now a few.
  const needles: number[] = [];
  const twinOf = new Map<number, number>();
  const wanted = new Set<number>();
  for (let t = 0; t < limit; t += 1) {
    const a = tri[t * 3];
    const b = tri[t * 3 + 1];
    const c = tri[t * 3 + 2];
    if (area(a, b, c) >= threshold) continue;
    // The middle vertex is the one opposite the longest edge.
    const lengths = [
      edgeLength(mesh.positions, a, b),
      edgeLength(mesh.positions, b, c),
      edgeLength(mesh.positions, c, a),
    ];
    const longest = lengths.indexOf(Math.max(...lengths));
    const v0 = [b, c, a][longest];
    const v2 = [a, b, c][longest];
    // The needle holds `v2 -> v0`; the neighbour holds its twin `v0 -> v2`.
    const twin = edgeKey(v0, v2);
    needles.push(t);
    twinOf.set(t, twin);
    wanted.add(twin);
  }
  if (needles.length === 0) return { mesh, split: 0, events };

  const owner = new Map<number, number>();
  const index = (t: number): void => {
    for (let k = 0; k < 3; k += 1) {
      const key = edgeKey(tri[t * 3 + k], tri[t * 3 + ((k + 1) % 3)]);
      if (wanted.has(key)) owner.set(key, t);
    }
  };
  for (let t = 0; t < limit; t += 1) index(t);

  let split = 0;
  // `alive.length` grows inside the loop; a triangle appended here is left for
  // the next PASS (the caller re-enters after checking the result), so a chain
  // of T-junctions resolves one link at a time and every link is verified
  // before the next is attempted.
  for (const t of needles) {
    if (!alive[t]) continue;
    const a = tri[t * 3];
    const b = tri[t * 3 + 1];
    const c = tri[t * 3 + 2];
    const lengths = [
      edgeLength(mesh.positions, a, b),
      edgeLength(mesh.positions, b, c),
      edgeLength(mesh.positions, c, a),
    ];
    const longest = lengths.indexOf(Math.max(...lengths));
    const v0 = [b, c, a][longest];
    const v2 = [a, b, c][longest];
    const v1 = [c, a, b][longest];
    const neighbour = owner.get(twinOf.get(t) ?? edgeKey(v0, v2));
    if (neighbour === undefined || neighbour === t || !alive[neighbour]) continue;
    // A neighbour that is ITSELF degenerate is left alone: splitting one sliver
    // with another is how a repair invents a hole (measured: four open edges on
    // the Chicago parks region). The next pass reaches it once its own
    // neighbour has been resolved.
    const n = neighbour * 3;
    if (area(tri[n], tri[n + 1], tri[n + 2]) < threshold) continue;
    let x = -1;
    for (let k = 0; k < 3; k += 1) {
      if (tri[n + k] === v0 && tri[n + ((k + 1) % 3)] === v2) x = tri[n + ((k + 2) % 3)];
    }
    if (x < 0 || x === v1) continue;

    alive[t] = false;
    alive[neighbour] = false;
    events.push({ sign: -1, a, b, c }, { sign: -1, a: tri[n], b: tri[n + 1], c: tri[n + 2] });
    for (const face of [
      [v0, v1, x],
      [v1, v2, x],
    ]) {
      tri.push(face[0], face[1], face[2]);
      alive.push(true);
      index(alive.length - 1);
      events.push({ sign: 1, a: face[0], b: face[1], c: face[2] });
    }
    split += 1;
  }

  const out: number[] = [];
  for (let t = 0; t < alive.length; t += 1) {
    if (!alive[t]) continue;
    out.push(tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2]);
  }
  return { mesh: { positions: mesh.positions, indices: Uint32Array.from(out) }, split, events };
}

/**
 * Connected surface components of a mesh: triangles joined across shared EDGES.
 *
 * The number a slicer reports as "objects", and the number `trimesh.body_count`
 * (which the reference validator's `bodies` row reads) computes. Shared VERTEX
 * adjacency is NOT the same question and is the wrong one here: two shells that
 * meet at a single point are one vertex-connected set and two objects, and that
 * pinch is exactly what {@link NEEDLE_COLLAPSE_MM} can create - merging two
 * vertices a tenth of a micrometre apart that belong to two different sheets of
 * the surface leaves a mesh that is still closed, still oriented and still the
 * same volume, and is simply three objects where there was one. Measured: the
 * default Chicago plate left the exporter as three bodies before this check was
 * here, while the solid it came from was one.
 */
/**
 * The same mesh with its vertices sorted by coordinate and its triangles
 * rotated to start at their lowest vertex and sorted, so two meshes of the
 * same geometry are the same bytes.
 *
 * manifold3d orders the triangles it hands back by the original ids of the
 * meshes they came from, and those ids are allocated in construction order. Two
 * builds of the same geometry through different histories (a warm incremental
 * run and a cold full run, v3.1) therefore agree on every coordinate and every
 * triangle but not on their order. This pass removes the history: an export
 * of a given parameter set is one sequence of bytes however it was reached,
 * which is what lets a region hash stand for its mesh. Ties between vertices
 * at exactly the same coordinates keep their incoming order.
 */
export function canonicalMesh(mesh: Mesh): Mesh {
  const p = mesh.positions;
  const vertexCount = Math.floor(p.length / 3);
  const order = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) order[i] = i;
  order.sort((a, b) => {
    const ax = a * 3;
    const bx = b * 3;
    if (p[ax] !== p[bx]) return p[ax] < p[bx] ? -1 : 1;
    if (p[ax + 1] !== p[bx + 1]) return p[ax + 1] < p[bx + 1] ? -1 : 1;
    if (p[ax + 2] !== p[bx + 2]) return p[ax + 2] < p[bx + 2] ? -1 : 1;
    return a - b;
  });
  const rank = new Uint32Array(vertexCount);
  const positions = new Float64Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i += 1) {
    const from = order[i];
    rank[from] = i;
    positions[i * 3] = p[from * 3];
    positions[i * 3 + 1] = p[from * 3 + 1];
    positions[i * 3 + 2] = p[from * 3 + 2];
  }
  const source = mesh.indices;
  const triangleCount = Math.floor(source.length / 3);
  const rotated = new Uint32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t += 1) {
    let a = rank[source[t * 3]];
    let b = rank[source[t * 3 + 1]];
    let c = rank[source[t * 3 + 2]];
    // Rotate, never reflect: the winding is the outward normal.
    if (b < a && b <= c) {
      const first = a;
      a = b;
      b = c;
      c = first;
    } else if (c < a && c < b) {
      const first = a;
      const second = b;
      a = c;
      b = first;
      c = second;
    }
    rotated[t * 3] = a;
    rotated[t * 3 + 1] = b;
    rotated[t * 3 + 2] = c;
  }
  const triangleOrder = new Uint32Array(triangleCount);
  for (let t = 0; t < triangleCount; t += 1) triangleOrder[t] = t;
  triangleOrder.sort((s, t) => {
    const sx = s * 3;
    const tx = t * 3;
    if (rotated[sx] !== rotated[tx]) return rotated[sx] - rotated[tx];
    if (rotated[sx + 1] !== rotated[tx + 1]) return rotated[sx + 1] - rotated[tx + 1];
    if (rotated[sx + 2] !== rotated[tx + 2]) return rotated[sx + 2] - rotated[tx + 2];
    return s - t;
  });
  const indices = new Uint32Array(triangleCount * 3);
  for (let k = 0; k < triangleCount; k += 1) {
    const from = triangleOrder[k] * 3;
    indices[k * 3] = rotated[from];
    indices[k * 3 + 1] = rotated[from + 1];
    indices[k * 3 + 2] = rotated[from + 2];
  }
  return { positions, indices };
}

export function componentCount(mesh: Mesh): number {
  const faces = Math.floor(mesh.indices.length / 3);
  if (faces === 0) return 0;
  const parent = new Int32Array(faces);
  for (let f = 0; f < faces; f += 1) parent[f] = f;
  const find = (f: number): number => {
    let root = f;
    while (parent[root] !== root) root = parent[root];
    let walk = f;
    while (parent[walk] !== root) {
      const next = parent[walk];
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  // Faces per undirected edge, then a union across the edges that have exactly
  // TWO. That last restriction is the whole point: an edge shared by three or
  // more faces is not a surface join, it is a non-manifold seam, and it is
  // where a pinch shows up. `trimesh.body_count` - which is what the reference
  // validator's `bodies` row reads - builds its face adjacency the same way,
  // so this function answers the question that row will ask.
  //
  // The edge index is an open-addressing table on the numeric edge key, like
  // `openEdges`': keyed by string it cost 100 ms a call on the merged Chicago
  // plate, and the sliver sweep asks twice per mesh.
  const first = new EdgeFaces(faces * 3);
  for (let f = 0; f < faces; f += 1) {
    const a = mesh.indices[f * 3];
    const b = mesh.indices[f * 3 + 1];
    const c = mesh.indices[f * 3 + 2];
    first.add(a, b, f);
    first.add(b, c, f);
    first.add(c, a, f);
  }
  first.forEachPair((fa, fb) => {
    const ra = find(fa);
    const rb = find(fb);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  });
  const roots = new Set<number>();
  for (let f = 0; f < faces; f += 1) roots.add(find(f));
  return roots.size;
}

/**
 * The faces on each UNDIRECTED edge: how many, and the first two. Only an
 * edge carrying exactly two faces joins them (see `componentCount`), so two is
 * all that is ever read back.
 */
class EdgeFaces {
  private readonly keys: Float64Array;
  private readonly counts: Int32Array;
  private readonly faceA: Int32Array;
  private readonly faceB: Int32Array;
  private readonly mask: number;

  constructor(expected: number) {
    let capacity = 16;
    while (capacity < expected * 2) capacity *= 2;
    this.keys = new Float64Array(capacity).fill(-1);
    this.counts = new Int32Array(capacity);
    this.faceA = new Int32Array(capacity);
    this.faceB = new Int32Array(capacity);
    this.mask = capacity - 1;
  }

  add(u: number, v: number, face: number): void {
    const a = u < v ? u : v;
    const b = u < v ? v : u;
    let h = Math.imul(a, 0x9e3779b1) ^ Math.imul(b ^ 0x5bd1e995, 0x85ebca77);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    const key = edgeKey(a, b);
    let i = h & this.mask;
    for (;;) {
      const held = this.keys[i];
      if (held === key || held === -1) break;
      i = (i + 1) & this.mask;
    }
    if (this.keys[i] === -1) {
      this.keys[i] = key;
      this.counts[i] = 1;
      this.faceA[i] = face;
      return;
    }
    if (this.counts[i] === 1) this.faceB[i] = face;
    this.counts[i] += 1;
  }

  /** Every edge with exactly two faces, in table order. */
  forEachPair(visit: (faceA: number, faceB: number) => void): void {
    for (let i = 0; i < this.keys.length; i += 1) {
      if (this.keys[i] === -1 || this.counts[i] !== 2) continue;
      visit(this.faceA[i], this.faceB[i]);
    }
  }
}

function edgeLength(p: ArrayLike<number>, ia: number, ib: number): number {
  const a = ia * 3;
  const b = ib * 3;
  return Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
}

/**
 * Weld, then resolve T-junctions, then check.
 *
 * The result is only returned when it is strictly better and still valid: no
 * degenerate face, closed and oriented, and the same volume to a nanolitre. Any
 * other outcome hands back the input untouched, with `applied: false`, so the
 * caller ships the mesh the kernel produced rather than one this file broke.
 */
export function cleanMesh(
  input: Mesh,
  options: {
    epsilonMm?: number;
    threshold?: number;
    collapseNeedles?: boolean;
    /**
     * Judge every face by {@link exportArea} - the smaller of its double and
     * its float32 area - instead of by its double area alone.
     *
     * OFF by default, and off for the engine, because the float32 grid does not
     * exist until the mesh is in the frame the FILE is written in: the exporter
     * translates the model into build space (`export/common.placeInBuildSpace`),
     * which moves a coordinate from 0.033 mm to 90 mm and its grid step from
     * 4e-9 mm to 7.6e-6 mm. Asked in the engine frame the question has a
     * different answer, so it is asked by the STL writer, on the placed mesh
     * (`export/stl.ts`, {@link hardenForFloat32}).
     */
    float32?: boolean;
    /**
     * Run the whole-mesh weld at all. Default true; `hardenForFloat32` passes
     * false when its float32 scan found no colliding vertex.
     *
     * The weld was the expensive rung of this repair (a 27-cell neighbourhood
     * scan over every vertex, 1.0 s on a 46 962-vertex plate, before the pair
     * sweep in `vertexPairs` replaced the scan) and it is the only one that
     * can be skipped on evidence. Its whole effect is to merge
     * vertices within `epsilonMm` of each other, and on a placed model a pair
     * that close shares a float32 grid point (a nanometre against a 7.6e-6 mm
     * step at 90 mm), so a scan that finds no collision has proved there is
     * nothing for it to merge that the FILE can see. What is left is the
     * needle, and `splitNeedles` resolves that without moving a vertex.
     */
    weld?: boolean;
  } = {},
): { mesh: Mesh; report: MeshReport } {
  const epsilon = options.epsilonMm ?? WELD_EPSILON_MM;
  const threshold = options.threshold ?? REPAIR_AREA_MM2;
  const measure = options.float32 === true ? exportArea : doubleArea;
  const before = meshVolumeMm3(input);
  const inputArea = measure(input);
  const beforeDegenerate = countDegenerate(input, threshold, inputArea);
  // The input's edge table is kept: every rung of the ladder starts from the
  // input, and a split pass moves a copy of it by its own few triangles
  // (`applyEvents`) rather than recounting the whole mesh.
  const checkedInput = perfSpan("mesh.clean.check", () => {
    const table = edgeTable(input.indices);
    return { table, open: openEdgeCount(table) };
  });
  const inputTable = checkedInput.table;
  const beforeOpen = checkedInput.open;
  // Only ever needed by the needle collapse below, and only when there is
  // something to repair, so it is computed behind the early return.
  let beforeBodiesCache: number | null = null;
  const beforeBodiesOf = (): number => {
    if (beforeBodiesCache === null) beforeBodiesCache = componentCount(input);
    return beforeBodiesCache;
  };

  if (beforeDegenerate === 0) {
    return {
      mesh: input,
      report: {
        welded: 0,
        split: 0,
        degenerate: 0,
        openEdges: beforeOpen,
        volumeDeltaMm3: 0,
        applied: true,
      },
    };
  }

  // Both repairs are volume-preserving by construction - a welded pair was one
  // point, and a split runs the new edge through a point already on it - so the
  // only difference in the measured volume is the order the divergence sum is
  // accumulated in. The tolerance is that noise (a relative 1e-9 on a sum of
  // 100 000 terms), which on a 172 000 mm^3 model is a cube 0.06 mm on a side.
  const acceptable = (candidate: Mesh, open: number, degenerate: number): boolean =>
    degenerate <= beforeDegenerate &&
    open <= beforeOpen &&
    Math.abs(meshVolumeMm3(candidate) - before) <= volumeNoiseMm3(before);

  let best = input;
  let bestDegenerate = beforeDegenerate;
  let bestOpen = beforeOpen;
  let welded = 0;
  let split = 0;

  // A caller that names an epsilon gets exactly that one; otherwise the ladder,
  // stopping at the first rung that clears every degenerate face. Each rung
  // starts from the INPUT, so a coarse weld is never applied on top of a fine
  // one and the accepted mesh is always one weld away from what the kernel
  // produced.
  const ladder = options.epsilonMm === undefined ? WELD_LADDER_MM : [epsilon];
  // The candidate pairs for every rung at once: a pair within a fine rung is
  // within the coarsest one, and each rung filters the list by its own
  // epsilon (`vertexPairs`).
  const pairs =
    options.weld === false
      ? null
      : perfSpan("mesh.clean.pairs", () => vertexPairs(input.positions, Math.floor(input.positions.length / 3), Math.max(...ladder)));
  for (const rung of ladder) {
    let candidate = input;
    let candidateArea = inputArea;
    let candidateDegenerate = beforeDegenerate;
    let candidateOpen = beforeOpen;
    let candidateWelded = 0;
    let candidateSplit = 0;

    // The table that counts `candidate`'s edges. The input's own is shared
    // between the rungs and copied before a split pass moves it.
    let candidateTable = inputTable;
    let ownsTable = false;

    const first = pairs === null ? { mesh: input, welded: 0 } : perfSpan("mesh.clean.weld", () => weld(input, rung, pairs));
    if (first.welded > 0) {
      // A weld rewrites the position array, so the measure has to be rebuilt on
      // it; the two repairs below keep the positions they were given and reuse
      // this one. It rewrites the triangles too, so the check is a full count.
      const weldedArea = measure(first.mesh);
      const checked = perfSpan("mesh.clean.check", () => {
        const table = edgeTable(first.mesh.indices);
        return { table, open: openEdgeCount(table) };
      });
      const degenerate = countDegenerate(first.mesh, threshold, weldedArea);
      if (acceptable(first.mesh, checked.open, degenerate)) {
        candidate = first.mesh;
        candidateArea = weldedArea;
        candidateDegenerate = degenerate;
        candidateOpen = checked.open;
        candidateWelded = first.welded;
        candidateTable = checked.table;
        ownsTable = true;
      }
    }

    // Every pass is a transaction: a pass that leaves the mesh no better, or
    // leaves a hole in it, is thrown away and the last good mesh is kept. A
    // split touches a few triangles of a large mesh, so its check is the
    // exact movement of the open-edge count over those triangles' edges.
    for (let pass = 0; pass < REPAIR_ROUNDS && candidateDegenerate > 0; pass += 1) {
      const attempt = perfSpan("mesh.clean.split", () => splitNeedles(candidate, threshold, candidateArea));
      if (attempt.split === 0) break;
      if (!ownsTable) {
        candidateTable = candidateTable.clone();
        ownsTable = true;
      }
      const table = candidateTable;
      const open = perfSpan("mesh.clean.check", () => candidateOpen + applyEvents(table, attempt.events));
      const degenerate = countDegenerate(attempt.mesh, threshold, candidateArea);
      if (degenerate >= candidateDegenerate || !acceptable(attempt.mesh, open, degenerate)) {
        revertEvents(table, attempt.events);
        break;
      }
      candidate = attempt.mesh;
      candidateDegenerate = degenerate;
      candidateOpen = open;
      candidateSplit += attempt.split;
    }

    // The local collapse, last: it is the narrowest repair here and the only
    // one that can close a needle the whole-mesh weld had to give up on.
    if (options.collapseNeedles === true && candidateDegenerate > 0) {
      const attempt = collapseNeedles(candidate, threshold, NEEDLE_COLLAPSE_MM, candidateArea);
      if (attempt.collapsed > 0) {
        const open = openEdges(attempt.mesh);
        const degenerate = countDegenerate(attempt.mesh, threshold, candidateArea);
        // The extra guard this repair needs and the other two do not: see
        // `componentCount`. A pinch is closed, oriented and volume-preserving,
        // and it is still three objects where there was one.
        const bodies = componentCount(attempt.mesh);
        if (
          degenerate < candidateDegenerate &&
          bodies <= beforeBodiesOf() &&
          acceptable(attempt.mesh, open, degenerate)
        ) {
          candidate = attempt.mesh;
          candidateDegenerate = degenerate;
          candidateOpen = open;
          candidateWelded += attempt.collapsed;
        }
      }
    }

    if (candidateDegenerate < bestDegenerate) {
      best = candidate;
      bestDegenerate = candidateDegenerate;
      bestOpen = candidateOpen;
      welded = candidateWelded;
      split = candidateSplit;
    }
    if (bestDegenerate === 0) break;
  }

  return {
    mesh: best,
    report: {
      welded,
      split,
      degenerate: bestDegenerate,
      openEdges: bestOpen,
      volumeDeltaMm3: best === input ? 0 : meshVolumeMm3(best) - before,
      applied: bestDegenerate < beforeDegenerate,
    },
  };
}

// ---------------------------------------------------------------------------
// What a binary STL can carry
// ---------------------------------------------------------------------------

/**
 * The volume difference a repair may show without having moved material, mm^3.
 *
 * `cleanMesh`'s own bound, in one place so the pinch separation beside it is
 * held to the same floor: the accumulation noise of a divergence sum over
 * 100 000 terms, a relative 1e-9, which on a 172 000 mm^3 model is a cube
 * 0.06 mm on a side.
 */
export function volumeNoiseMm3(volumeMm3: number): number {
  return Math.max(1e-6, Math.abs(volumeMm3) * 1e-9);
}

const EMPTY_PINCH_REPORT: PinchReport = {
  groups: 0,
  moved: 0,
  unresolved: 0,
  rejected: 0,
  maxShiftMm: 0,
  volumeDeltaMm3: 0,
};

/** One float32 step away from zero at `value`, mm. */
export function float32StepMm(value: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  const here = view.getFloat32(0);
  view.setUint32(0, view.getUint32(0) + 1);
  const next = view.getFloat32(0);
  const step = Math.abs(next - here);
  return Number.isFinite(step) && step > 0 ? step : Number.MIN_VALUE;
}

/**
 * The float32 grid step at a mesh's own scale, mm.
 *
 * One step at the largest coordinate the mesh holds, so the separation is the
 * same size wherever it lands rather than vanishing to a denormal at a vertex
 * that happens to sit on z = 0 - which is every vertex of a placed model's
 * underside. 1.5e-5 mm on a 180 mm plate.
 */
function gridStepMm(p: ArrayLike<number>): number {
  let largest = 1;
  for (let i = 0; i < p.length; i += 1) {
    const size = Math.abs(p[i]);
    if (size > largest) largest = size;
  }
  return float32StepMm(largest);
}

export interface PinchReport {
  /** Float32 grid points that carried more than one vertex before the repair. */
  groups: number;
  /** Vertices moved off a shared grid point, in the result that was kept. */
  moved: number;
  /** Vertices that could not be given a grid point of their own. */
  unresolved: number;
  /** Vertices whose move the acceptance test threw away, leaving the pinch. */
  rejected: number;
  /** Largest distance any vertex was moved, mm. */
  maxShiftMm: number;
  /** Signed volume change of the accepted move, mm^3. Zero when it was rolled back. */
  volumeDeltaMm3: number;
}

/**
 * Give every vertex a float32 grid point of its own.
 *
 * The defect this closes is not a repairable property of the MESH: two vertices
 * at one point, joined to a common neighbour, are how manifold3d represents two
 * sheets of a surface that touch along an edge - two building corners meeting
 * exactly, which the Paris, Tokyo and London plates each carry one or two of.
 * The 3MF is indexed and carries it faithfully; a binary STL is a triangle soup,
 * the reader recovers the topology by welding identical coordinates, and the
 * weld hands that edge to four faces. Welding the pair in the mesh instead does
 * not help - it is the same non-manifold edge, made explicit, and manifold3d
 * refuses to re-import it. The reference implementation's own ladder does not
 * reach it either, and not because it gives up: `assemble.float32_defect_count`
 * scores `len(unique(vertices)) - len(unique(quantised))`, so a pair that is
 * already one row of `unique(vertices)` contributes nothing and `finalize`
 * stops with `_is_clean` answering true (traced on Paris, where the ladder
 * clears 9 rounding collisions and 19 float32 degenerate faces and leaves
 * exactly this one pair).
 *
 * So the file is made to say what the mesh says, to the finest the format has:
 * the second vertex of a colliding pair is moved by ONE float32 step at the
 * model's own scale ({@link gridStepMm}, 1.5e-5 mm on a 180 mm plate), into its
 * own material - against its area-weighted vertex normal, along that vector's
 * dominant axis. That is four orders of magnitude under the print grid and the
 * smallest move the file can express at all: a smaller one rounds straight back
 * onto the point it came from.
 *
 * The positions are returned as a new array; the mesh's own are not touched.
 *
 * TRANSACTIONAL, like every other repair in this file: the move is kept only
 * when it did what it is for and cost no more than it possibly can.
 *
 * * no face that the file can measure becomes degenerate that was not already;
 * * the volume moves by no more than one step across the faces the moved
 *   vertices carry (`Σ shift * incident area`, which is the exact worst case
 *   for a translation), or by `cleanMesh`'s own noise bound, whichever is
 *   larger. The pure relative bound is the wrong test on its own here: this
 *   repair MOVES a vertex on purpose, so the cost scales with the incident
 *   area and not with the model's volume, and on a 10 mm cube it would reject
 *   a legitimate 1.5e-5 mm step (4.1e-3 mm3 against a 3e-6 mm3 tolerance)
 *   while accepting the same step on a plate. Both bounds are reported.
 * * the topology is untouched by construction and is asserted, not recomputed:
 *   `openEdges` and `componentCount` read the INDEX array, and this function
 *   returns the caller's own indices unchanged (`mesh.test.ts` pins both on a
 *   three-cube pinch, as does `services/bake/tests/test_bake.py`).
 *
 * A rejected move is rolled back whole and counted in `rejected`, which leaves
 * the collision in the file and is what `hardenForFloat32` reports on.
 */
export function separateFloat32Pinches(mesh: Mesh): { positions: Float64Array; report: PinchReport } {
  const p = mesh.positions;
  const count = Math.floor(p.length / 3);
  const quantised = float32Positions(p);
  const home = new Map<string, number[]>();
  const keyAt = (source: ArrayLike<number>, v: number): string =>
    `${Math.fround(source[v * 3])},${Math.fround(source[v * 3 + 1])},${Math.fround(source[v * 3 + 2])}`;
  for (let v = 0; v < count; v += 1) {
    const key = `${quantised[v * 3]},${quantised[v * 3 + 1]},${quantised[v * 3 + 2]}`;
    const bucket = home.get(key);
    if (bucket === undefined) home.set(key, [v]);
    else bucket.push(v);
  }
  const groups: number[][] = [];
  for (const bucket of home.values()) {
    if (bucket.length > 1) groups.push(bucket);
  }
  if (groups.length === 0) {
    return { positions: p, report: EMPTY_PINCH_REPORT };
  }

  // Area-weighted vertex normals, from the cross products the winding gives,
  // and the plain incident area beside them for the acceptance bound.
  const normals = new Float64Array(count * 3);
  const incident = new Float64Array(count);
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    const a = mesh.indices[i] * 3;
    const b = mesh.indices[i + 1] * 3;
    const c = mesh.indices[i + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const area = 0.5 * Math.hypot(nx, ny, nz);
    for (const corner of [a, b, c]) {
      normals[corner] += nx;
      normals[corner + 1] += ny;
      normals[corner + 2] += nz;
      incident[corner / 3] += area;
    }
  }

  const grid = gridStepMm(p);
  const moved = new Float64Array(p);
  let movedCount = 0;
  let unresolved = 0;
  let maxShiftMm = 0;
  /** Exact worst case the accepted moves can cost in volume, mm^3. */
  let budgetMm3 = 0;
  for (const bucket of groups) {
    // The first vertex keeps the grid point; the rest look for their own.
    for (let member = 1; member < bucket.length; member += 1) {
      const v = bucket[member];
      // Into the material: against the outward normal, on the axis that vector
      // leans on hardest, so the step retreats from the contact rather than
      // sliding along it.
      let axis = 0;
      for (let k = 1; k < 3; k += 1) {
        if (Math.abs(normals[v * 3 + k]) > Math.abs(normals[v * 3 + axis])) axis = k;
      }
      const inward = -normals[v * 3 + axis];
      const direction = inward >= 0 ? 1 : -1;
      const origin = moved[v * 3 + axis];
      let step = Math.max(float32StepMm(origin), grid);
      let placed = false;
      for (let tries = 0; tries < PINCH_STEPS; tries += 1) {
        moved[v * 3 + axis] = origin + direction * step;
        const key = keyAt(moved, v);
        if (!home.has(key)) {
          home.set(key, [v]);
          placed = true;
          const shift = Math.abs(moved[v * 3 + axis] - origin);
          maxShiftMm = Math.max(maxShiftMm, shift);
          budgetMm3 += shift * incident[v];
          movedCount += 1;
          break;
        }
        step *= 2;
      }
      if (!placed) {
        moved[v * 3 + axis] = origin;
        unresolved += 1;
      }
    }
  }
  if (movedCount === 0) {
    return { positions: p, report: { ...EMPTY_PINCH_REPORT, groups: groups.length, unresolved } };
  }

  // The transaction. `moved` shares this mesh's indices, so the only things a
  // translation can break are the two it is measured on.
  const candidate: Mesh = { positions: moved, indices: mesh.indices };
  const before = meshVolumeMm3(mesh);
  const delta = meshVolumeMm3(candidate) - before;
  const allowance = Math.max(volumeNoiseMm3(before), budgetMm3);
  const degenerateBefore = float32DegenerateFaces(mesh);
  const accepted =
    Math.abs(delta) <= allowance && float32DegenerateFaces(candidate) <= degenerateBefore;
  if (!accepted) {
    return {
      positions: p,
      report: {
        groups: groups.length,
        moved: 0,
        unresolved,
        rejected: movedCount,
        maxShiftMm: 0,
        volumeDeltaMm3: 0,
      },
    };
  }
  return {
    positions: moved,
    report: {
      groups: groups.length,
      moved: movedCount,
      unresolved,
      rejected: 0,
      maxShiftMm,
      volumeDeltaMm3: delta,
    },
  };
}

export interface HardenReport {
  mesh: MeshReport;
  pinches: PinchReport;
  /** Faces under 04's threshold in the float32 rendering, after the repair. */
  degenerate: number;
  /** Vertices a float32 reader would still lose, after the repair. */
  collisions: number;
  /**
   * Faces under 04's threshold before any repair ran, measured the same way
   * {@link HardenReport.degenerate} is so the two can be subtracted. The PROBE
   * that decides whether to repair at all counts at {@link REPAIR_AREA_MM2}
   * instead, two decades higher, because a face at 4e-9 in memory can land
   * under 1e-9 in the file.
   */
  degenerateBefore: number;
  /** Colliding vertices the probe found before any repair ran. */
  collisionsBefore: number;
  /** True when the probe found nothing and no repair was run at all. */
  probedClean: boolean;
}

const CLEAN_MESH_REPORT: MeshReport = {
  welded: 0,
  split: 0,
  degenerate: 0,
  openEdges: 0,
  volumeDeltaMm3: 0,
  applied: true,
};

/**
 * A mesh a binary STL can carry: nothing degenerate and nothing coincident,
 * measured on the float32 grid the file writes.
 *
 * Two repairs, in the only order that works. First {@link cleanMesh} with
 * `float32: true`, which sees the needles the double measure cannot - on the
 * Chicago plate exactly one, three vertices of a vertical edge whose x and y
 * agree to 1.8e-6 mm, which is real geometry in double (6.2e-7 mm^2) and
 * nothing at all on a grid whose step there is 7.6e-6 mm. Then
 * {@link separateFloat32Pinches}, for the coincidences no repair can remove.
 *
 * Called on the PLACED mesh, in build space, because that is the frame the file
 * is written in and the grid is a property of the coordinate.
 */
export function hardenForFloat32(input: Mesh): { mesh: Mesh; report: HardenReport } {
  // PROBE FIRST. Two full-mesh passes, 5 ms and 25 ms on a 46 962-vertex plate
  // against the 1.0 s the weld costs, and on most meshes they find nothing: a
  // tile, a member of the parts zip, five of the six presets. A mesh the format
  // can already carry is handed straight back and no repair runs on it.
  const candidates = float32DegenerateFaces(input, REPAIR_AREA_MM2);
  const collisionsBefore = float32Collisions(input);
  if (candidates === 0 && collisionsBefore === 0) {
    return {
      mesh: input,
      report: {
        mesh: CLEAN_MESH_REPORT,
        pinches: EMPTY_PINCH_REPORT,
        degenerate: 0,
        collisions: 0,
        degenerateBefore: 0,
        collisionsBefore: 0,
        probedClean: true,
      },
    };
  }

  // One rung, not the ladder. The coarsest rung merges vertices up to 6.5
  // float32 steps apart at a 180 mm coordinate, and the weld path has no body
  // guard (only `collapseNeedles` does), so a weld that pinched one body into
  // two would pass `acceptable` and be invisible in an STL until the reader
  // welds the file back. The finest rung is the one the reference implementation
  // starts on and the only one this writer needs; it also bounds what a plate
  // the repair cannot fix costs.
  const degenerateBefore = float32DegenerateFaces(input);
  const cleaned = cleanMesh(input, {
    float32: true,
    epsilonMm: WELD_EPSILON_MM,
    weld: collisionsBefore > 0,
  });
  const separated =
    collisionsBefore > 0
      ? separateFloat32Pinches(cleaned.mesh)
      : { positions: cleaned.mesh.positions, report: EMPTY_PINCH_REPORT };
  const mesh: Mesh =
    separated.positions === cleaned.mesh.positions
      ? cleaned.mesh
      : { positions: separated.positions, indices: cleaned.mesh.indices };
  return {
    mesh,
    report: {
      mesh: cleaned.report,
      pinches: separated.report,
      degenerate: float32DegenerateFaces(mesh),
      collisions: float32Collisions(mesh),
      degenerateBefore,
      collisionsBefore,
      probedClean: false,
    },
  };
}
