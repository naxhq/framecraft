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
 * to a printer. Measured on the phase 5 chamfer + rounded-corner bake: one
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
  let count = 0;
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    if (
      triangleAreaMm2(mesh.positions, mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]) <
      threshold
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * Directed edges that do not have exactly one twin.
 *
 * Zero means the mesh is closed AND consistently wound, which is what the 3MF
 * and STL readers, the slicers and 04's `watertight` row all need.
 */
export function openEdges(mesh: Mesh): number {
  const seen = new Map<number, number>();
  const key = (a: number, b: number): number => a * 4294967296 + b;
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    const t = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    for (let k = 0; k < 3; k += 1) {
      const e = key(t[k], t[(k + 1) % 3]);
      seen.set(e, (seen.get(e) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const [edge, count] of seen) {
    const a = Math.floor(edge / 4294967296);
    const b = edge - a * 4294967296;
    if ((seen.get(key(b, a)) ?? 0) !== count || count !== 1) bad += 1;
  }
  return bad;
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
 * Merge coincident vertices, drop the triangles that collapse.
 *
 * The key is the coordinate triple rounded onto the weld grid, looked up once.
 * There is no search of neighbouring cells because there is nothing to find:
 * the duplicates a coincident-face boolean leaves are bitwise identical (a
 * measured example on the Chicago parks region has an edge of length exactly
 * zero), and a pair that merely came within a nanometre of each other by two
 * different routes is not one this file may merge on its own authority.
 */
function weld(mesh: Mesh, epsilon: number): { mesh: Mesh; welded: number } {
  const p = mesh.positions;
  const count = p.length / 3;
  const cellSize = Math.max(epsilon, Number.MIN_VALUE);
  const buckets = new Map<string, number[]>();
  const remap = new Uint32Array(count);
  const keep: number[] = [];
  for (let v = 0; v < count; v += 1) {
    const x = p[v * 3];
    const y = p[v * 3 + 1];
    const z = p[v * 3 + 2];
    const cx = Math.floor(x / cellSize);
    const cy = Math.floor(y / cellSize);
    const cz = Math.floor(z / cellSize);
    // The 27 cells around this one, because a pair 1e-7 mm apart can still
    // straddle a 1e-6 mm cell boundary - which is exactly what a single-cell
    // lookup misses, and the pair it misses is the one worth merging.
    let hit = -1;
    for (let dx = -1; dx <= 1 && hit < 0; dx += 1) {
      for (let dy = -1; dy <= 1 && hit < 0; dy += 1) {
        for (let dz = -1; dz <= 1 && hit < 0; dz += 1) {
          const bucket = buckets.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (bucket === undefined) continue;
          for (const candidate of bucket) {
            const o = keep[candidate] * 3;
            if (
              Math.abs(p[o] - x) <= epsilon &&
              Math.abs(p[o + 1] - y) <= epsilon &&
              Math.abs(p[o + 2] - z) <= epsilon
            ) {
              hit = candidate;
              break;
            }
          }
        }
      }
    }
    if (hit >= 0) {
      remap[v] = hit;
      continue;
    }
    remap[v] = keep.length;
    const home = `${cx},${cy},${cz}`;
    const bucket = buckets.get(home);
    if (bucket === undefined) buckets.set(home, [keep.length]);
    else bucket.push(keep.length);
    keep.push(v);
  }
  if (keep.length === count) return { mesh, welded: 0 };

  const positions = new Float64Array(keep.length * 3);
  for (let i = 0; i < keep.length; i += 1) {
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
    welded: count - keep.length,
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
function splitNeedles(mesh: Mesh, threshold: number): { mesh: Mesh; split: number } {
  const tri: number[] = Array.from(mesh.indices);
  const alive: boolean[] = new Array(tri.length / 3).fill(true);
  const key = (a: number, b: number): string => `${a},${b}`;
  const owner = new Map<string, number>();
  const index = (t: number): void => {
    for (let k = 0; k < 3; k += 1) {
      owner.set(key(tri[t * 3 + k], tri[t * 3 + ((k + 1) % 3)]), t);
    }
  };
  for (let t = 0; t < alive.length; t += 1) index(t);

  let split = 0;
  // `alive.length` grows inside the loop; a triangle appended here is left for
  // the next PASS (the caller re-enters after checking the result), so a chain
  // of T-junctions resolves one link at a time and every link is verified
  // before the next is attempted.
  const limit = alive.length;
  for (let t = 0; t < limit; t += 1) {
    if (!alive[t]) continue;
    const a = tri[t * 3];
    const b = tri[t * 3 + 1];
    const c = tri[t * 3 + 2];
    if (triangleAreaMm2(mesh.positions, a, b, c) >= threshold) continue;

    // The middle vertex is the one opposite the longest edge.
    const lengths = [
      edgeLength(mesh.positions, a, b),
      edgeLength(mesh.positions, b, c),
      edgeLength(mesh.positions, c, a),
    ];
    const longest = lengths.indexOf(Math.max(...lengths));
    const v0 = [b, c, a][longest];
    const v2 = [a, b, c][longest];
    const v1 = [c, a, b][longest];
    // The needle holds `v2 -> v0`; the neighbour holds its twin `v0 -> v2`.
    const neighbour = owner.get(key(v0, v2));
    if (neighbour === undefined || neighbour === t || !alive[neighbour]) continue;
    // A neighbour that is ITSELF degenerate is left alone: splitting one sliver
    // with another is how a repair invents a hole (measured: four open edges on
    // the Chicago parks region). The next pass reaches it once its own
    // neighbour has been resolved.
    const n = neighbour * 3;
    if (
      triangleAreaMm2(mesh.positions, tri[n], tri[n + 1], tri[n + 2]) < threshold
    ) {
      continue;
    }
    let x = -1;
    for (let k = 0; k < 3; k += 1) {
      if (tri[n + k] === v0 && tri[n + ((k + 1) % 3)] === v2) x = tri[n + ((k + 2) % 3)];
    }
    if (x < 0 || x === v1) continue;

    alive[t] = false;
    alive[neighbour] = false;
    for (const face of [
      [v0, v1, x],
      [v1, v2, x],
    ]) {
      tri.push(face[0], face[1], face[2]);
      alive.push(true);
      index(alive.length - 1);
    }
    split += 1;
  }

  const out: number[] = [];
  for (let t = 0; t < alive.length; t += 1) {
    if (!alive[t]) continue;
    out.push(tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2]);
  }
  return { mesh: { positions: mesh.positions, indices: Uint32Array.from(out) }, split };
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
  options: { epsilonMm?: number; threshold?: number } = {},
): { mesh: Mesh; report: MeshReport } {
  const epsilon = options.epsilonMm ?? WELD_EPSILON_MM;
  const threshold = options.threshold ?? REPAIR_AREA_MM2;
  const before = meshVolumeMm3(input);
  const beforeDegenerate = degenerateFaces(input, threshold);
  const beforeOpen = openEdges(input);

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
    Math.abs(meshVolumeMm3(candidate) - before) <= Math.max(1e-6, Math.abs(before) * 1e-9);

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
  for (const rung of ladder) {
    let candidate = input;
    let candidateDegenerate = beforeDegenerate;
    let candidateOpen = beforeOpen;
    let candidateWelded = 0;
    let candidateSplit = 0;

    const first = weld(input, rung);
    if (first.welded > 0) {
      const open = openEdges(first.mesh);
      const degenerate = degenerateFaces(first.mesh, threshold);
      if (acceptable(first.mesh, open, degenerate)) {
        candidate = first.mesh;
        candidateDegenerate = degenerate;
        candidateOpen = open;
        candidateWelded = first.welded;
      }
    }

    // Every pass is a transaction: a pass that leaves the mesh no better, or
    // leaves a hole in it, is thrown away and the last good mesh is kept.
    for (let pass = 0; pass < REPAIR_ROUNDS && candidateDegenerate > 0; pass += 1) {
      const attempt = splitNeedles(candidate, threshold);
      if (attempt.split === 0) break;
      const open = openEdges(attempt.mesh);
      const degenerate = degenerateFaces(attempt.mesh, threshold);
      if (degenerate >= candidateDegenerate || !acceptable(attempt.mesh, open, degenerate)) {
        break;
      }
      candidate = attempt.mesh;
      candidateDegenerate = degenerate;
      candidateOpen = open;
      candidateSplit += attempt.split;
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
