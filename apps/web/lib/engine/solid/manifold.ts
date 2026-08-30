/**
 * The one place the browser engine talks to `manifold-3d`.
 *
 * Three jobs, and nothing else:
 *
 * 1. **One WASM instance.** `loadManifold()` memoises the module promise, so a
 *    vitest run, a Web Worker and a hot-reloaded page each initialise the
 *    kernel exactly once. `setup()` is called before the classes are handed
 *    out, because the emscripten module hands back unbound constructors until
 *    it has run.
 * 2. **Contours in, contours out.** SceneGraph rings arrive in ground metres
 *    with the frozen winding convention (exterior CCW, holes CW, first vertex
 *    not repeated); `CrossSection` wants print millimetres and
 *    `FillRule.Positive`. The conversion happens here, once, and the winding is
 *    re-checked rather than trusted (04's trap list: the opposite winding
 *    produces inside-out solids that pass a naive volume check).
 * 3. **Ownership.** Every `Manifold` and `CrossSection` is a handle into WASM
 *    memory that the garbage collector cannot see. An engine that forgets a
 *    `delete()` leaks until the tab dies, so nothing here is created outside an
 *    `Arena`: `arena.keep(x)` registers a handle, `arena.dispose()` frees
 *    everything still registered, and `outstandingWasmObjects()` is what the
 *    leak test asserts on.
 */

import ManifoldModule from "manifold-3d";
import type {
  CrossSection,
  FillRule,
  JoinType,
  Manifold,
  ManifoldToplevel,
  Vec2,
} from "manifold-3d";

import type { Point } from "../../contracts";
import type { Bbox3, RegionMesh, RegionName } from "../types";
import { cleanMesh } from "./mesh";

export type { CrossSection, Manifold, ManifoldToplevel, Vec2 };

/** A closed contour in print millimetres. Rings are not closed by repetition. */
export type Contour = Vec2[];

/** The fill rule every CrossSection in this engine is built with. */
export const FILL_RULE: FillRule = "Positive";

/** Join type for every offset that stands in for a shapely mitre buffer. */
export const MITRE: JoinType = "Miter";
/** Join type for the openings that measure a width (a true morphological one). */
export const ROUND: JoinType = "Round";
/** Clipper2's minimum, and the value `thicken.py` passes shapely. */
export const MITRE_LIMIT = 2.0;

let modulePromise: Promise<ManifoldToplevel> | null = null;

/**
 * True in `uv run`/`tsx`/vitest's Node process (the reference CLI, the bake
 * fixtures, every existing unit test): `manifold-3d`'s emscripten glue reads
 * the `.wasm` straight off disk there via `node:fs`, relative to its own
 * `import.meta.url` inside `node_modules`, which already works and must stay
 * untouched.
 */
function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && process.versions?.node !== undefined;
}

/**
 * Where `scripts/copy-manifold-wasm.mjs` (run from `predev`/`prebuild`, same
 * pattern as `scripts/copy-maplibre-worker.mjs`) copies `manifold.wasm`.
 */
export const MANIFOLD_WASM_PUBLIC_PATH = "/manifold/manifold.wasm";

/**
 * The initialised WASM module. Safe to call from anywhere and any number of
 * times; the first call does the work and every later one waits on it.
 *
 * Outside Node (a Web Worker or a plain browser tab) `manifold-3d` locates its
 * `.wasm` with `new URL("manifold.wasm", import.meta.url)`. Next's bundler
 * rewrites `import.meta.url` for a worker chunk to the chunk's own URL under
 * `/_next/static/...`, which does not serve `manifold.wasm` next to it -- the
 * exact class of bug `copy-maplibre-worker.mjs`'s own docstring describes for
 * the MapLibre worker. `Module.locateFile` is emscripten's own escape hatch
 * for this, so it is pointed at the copied, root-relative public path instead
 * of trusting the bundler-rewritten URL.
 */
export async function loadManifold(): Promise<ManifoldToplevel> {
  if (modulePromise === null) {
    // `manifold-3d`'s own `.d.ts` declares `locateFile: () => string`, one
    // parameter narrower than what it actually calls the function with
    // (`Module["locateFile"](path, scriptDirectory)`); the optional parameter
    // here keeps this assignable to that declared type while still reading
    // the real `path` emscripten passes at runtime (TS types are erased, so
    // the declared arity is compile-time only).
    const modulePromiseSource = isNodeRuntime()
      ? ManifoldModule()
      : ManifoldModule({
          locateFile: (path?: string): string =>
            `${MANIFOLD_WASM_PUBLIC_PATH.replace(/[^/]*$/, "")}${path ?? "manifold.wasm"}`,
        });
    modulePromise = modulePromiseSource.then((wasm) => {
      wasm.setup();
      return wasm;
    });
  }
  return modulePromise;
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/** Anything with a WASM handle behind it. */
export interface Deletable {
  delete(): void;
}

let outstanding = 0;

/**
 * How many WASM handles this module is still holding.
 *
 * Zero after a finished bake. It is a module-level count rather than a per
 * arena one on purpose: a handle parked in an arena that itself was dropped on
 * the floor is exactly the leak this number exists to catch.
 */
export function outstandingWasmObjects(): number {
  return outstanding;
}

/**
 * A scope for WASM handles.
 *
 * The rule the whole engine follows: a function that CREATES a handle either
 * registers it with the arena it was given, or deletes it before returning.
 * Nothing else is allowed, so `dispose()` in a `finally` is always enough.
 */
export class Arena {
  private readonly live = new Set<Deletable>();

  /** Register a handle and hand it straight back, for use inline. */
  keep<T extends Deletable>(value: T): T {
    if (!this.live.has(value)) {
      this.live.add(value);
      outstanding += 1;
    }
    return value;
  }

  /** Register every non-null handle in `values`. */
  keepAll<T extends Deletable>(values: readonly (T | null)[]): T[] {
    const out: T[] = [];
    for (const value of values) {
      if (value !== null) out.push(this.keep(value));
    }
    return out;
  }

  /** Free one handle now. A handle this arena never held is still freed. */
  drop(value: Deletable | null | undefined): void {
    if (value === null || value === undefined) return;
    if (this.live.delete(value)) outstanding -= 1;
    value.delete();
  }

  /** Free every handle in `values` now. */
  dropAll(values: Iterable<Deletable | null | undefined>): void {
    for (const value of values) this.drop(value);
  }

  /** Stop tracking a handle without freeing it (the caller takes ownership). */
  release<T extends Deletable>(value: T): T {
    if (this.live.delete(value)) outstanding -= 1;
    return value;
  }

  /** Free everything still registered. Idempotent. */
  dispose(): void {
    for (const value of this.live) {
      outstanding -= 1;
      value.delete();
    }
    this.live.clear();
  }

  /** Handles this arena is currently holding. Diagnostics and tests. */
  get size(): number {
    return this.live.size;
  }
}

// ---------------------------------------------------------------------------
// Rings -> contours
// ---------------------------------------------------------------------------

/** Twice the signed area of an implicitly-closed ring; positive is CCW. */
export function signedArea2(ring: ArrayLike<Point> | readonly Vec2[]): number {
  const n = ring.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    total += a[0] * b[1] - b[0] * a[1];
  }
  return total;
}

/** The ring as a contour in mm, wound `ccw`, with any repeated last vertex dropped. */
export function contourFromRing(
  ring: readonly Point[],
  scale: number,
  ccw: boolean,
): Contour | null {
  const n = ring.length;
  if (n < 3) return null;
  const last = ring[n - 1];
  const first = ring[0];
  const closed =
    Math.abs(last[0] - first[0]) < 1e-12 && Math.abs(last[1] - first[1]) < 1e-12;
  const count = closed ? n - 1 : n;
  if (count < 3) return null;
  const out: Contour = new Array<Vec2>(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = [ring[i][0] * scale, ring[i][1] * scale];
  }
  const wound = signedArea2(out) > 0;
  if (wound !== ccw) out.reverse();
  return out;
}

/**
 * One SceneGraph footprint as manifold contours in print millimetres.
 *
 * Holes come back clockwise, which is what `FillRule.Positive` reads as a hole.
 * A hole that touches or crosses its own exterior is left alone here: the
 * closing pair in `repair.ts` resolves it in 2D, where shapely's `make_valid`
 * does the same job in the reference implementation.
 */
export function contoursFromRings(
  ring: readonly Point[],
  holes: readonly (readonly Point[])[],
  scale: number,
): Contour[] {
  const outer = contourFromRing(ring, scale, true);
  if (outer === null) return [];
  const out: Contour[] = [outer];
  for (const hole of holes) {
    const inner = contourFromRing(hole, scale, false);
    if (inner !== null) out.push(inner);
  }
  return out;
}

/** A flat `[x0,y0,x1,y1,...]` contour (what `lib/previewText.ts` emits) in mm. */
export function contourFromFlat(flat: readonly number[], ccw: boolean): Contour | null {
  if (flat.length < 6) return null;
  const out: Contour = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  if (out.length < 3) return null;
  const wound = signedArea2(out) > 0;
  if (wound !== ccw) out.reverse();
  return out;
}

/** An axis-aligned rectangle contour, counter-clockwise. */
export function rectContour(x0: number, y0: number, x1: number, y1: number): Contour {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** A regular n-gon contour, counter-clockwise, circumradius `r`. */
export function circleContour(
  cx: number,
  cy: number,
  r: number,
  segments: number,
): Contour {
  const out: Contour = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    out.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CrossSection helpers
// ---------------------------------------------------------------------------

/**
 * A CrossSection over `contours`, or null when the result is empty.
 *
 * The constructor unions everything it is handed, so a whole layer of
 * overlapping footprints becomes one clean section in a single call rather than
 * N sequential booleans.
 */
export function sectionOf(
  wasm: ManifoldToplevel,
  arena: Arena,
  contours: readonly Contour[],
): CrossSection | null {
  if (contours.length === 0) return null;
  const section = new wasm.CrossSection(contours as Vec2[][], FILL_RULE);
  if (section.isEmpty()) {
    section.delete();
    return null;
  }
  return arena.keep(section);
}

/** `section.offset(delta, ...)`, tracked, returning null when it empties out. */
export function offsetSection(
  arena: Arena,
  section: CrossSection,
  delta: number,
  joinType: JoinType = MITRE,
  circularSegments = 0,
  miterLimit: number = MITRE_LIMIT,
): CrossSection | null {
  if (delta === 0) return section;
  const out = section.offset(delta, joinType, miterLimit, circularSegments);
  if (out.isEmpty()) {
    out.delete();
    return null;
  }
  return arena.keep(out);
}

/**
 * 04 stage 1, buildings 4: `union.buffer(g).buffer(-g)`.
 *
 * Mitre joins, so a convex corner comes back where it started instead of being
 * rounded off by the pair, and so the closed layer does not carry arc vertices
 * into the boolean engine.
 */
export function closeSection(
  arena: Arena,
  section: CrossSection,
  gap: number,
): CrossSection | null {
  if (gap <= 0) return section;
  const grown = offsetSection(arena, section, gap);
  if (grown === null) return null;
  const shrunk = offsetSection(arena, grown, -gap);
  if (grown !== section) arena.drop(grown);
  return shrunk;
}

/**
 * Vertex-clean a section just before it is extruded, print mm.
 *
 * A boolean chain in Clipper2 leaves near-duplicate and collinear vertices on
 * an outline. They are invisible in 2D and they are not invisible in 3D: a pair
 * of vertices a nanometre apart extrudes into two zero-area side triangles, and
 * 04 stage 4 requires ZERO faces under 1e-9 mm^2. On the Chicago plate this one
 * pass takes the buildings region from 41 such triangles to 0 and the parks
 * region from 50 to 0.
 *
 * 1e-4 mm is a ten-thousandth of a millimetre: four orders of magnitude below
 * the print grid, and below the tolerance of every measurement in the pipeline.
 */
export const EXTRUDE_SIMPLIFY_MM = 1e-4;

/**
 * Radius of the deburring opening applied with it, print mm.
 *
 * A pinch point - an outline that touches itself, which a chain of 2D booleans
 * leaves behind - extrudes into a pair of triangles of exactly zero area
 * joining two coincident-but-distinct vertices. They cannot be welded away
 * afterwards (the two vertices belong to two different sheets of the surface
 * and merging them makes the mesh non-manifold), and they cannot be split away
 * either. They can be prevented: an opening at ten nanometres separates the
 * neck before it is ever extruded. Measured on the Chicago parks region, this
 * takes the extruded solid from 26 faces under 1e-9 mm^2 to none, and moves the
 * layer's area by less than a thousandth of a square millimetre in 1549.
 *
 * The reference implementation does the same thing at a thousand times this
 * radius (`thicken.DEBURR_GRID_CELLS`, two 0.01 mm print-grid cells).
 */
export const DEBURR_MM = 1e-5;

/**
 * Deburr and vertex-clean a section just before it is extruded.
 *
 * Both halves earn their place: the opening removes pinch points (see
 * `DEBURR_MM`) and the simplify removes the near-duplicate and collinear
 * vertices a boolean chain leaves on an outline, each of which is invisible in
 * 2D and extrudes into a zero-area side triangle.
 */
export function cleanSection(
  arena: Arena,
  section: CrossSection,
  epsilonMm: number = EXTRUDE_SIMPLIFY_MM,
  deburrMm: number = DEBURR_MM,
): CrossSection {
  let current = section;
  if (deburrMm > 0) {
    const eroded = offsetSection(arena, current, -deburrMm, MITRE);
    const opened = eroded === null ? null : offsetSection(arena, eroded, deburrMm, MITRE);
    if (eroded !== null && eroded !== current) arena.drop(eroded);
    // An opening can only remove material, so a layer that vanishes under a ten
    // nanometre probe was not printable in the first place; keeping the input
    // is the safe answer and the min-wall rules drop it later anyway.
    if (opened !== null) current = opened;
  }
  const out = current.simplify(epsilonMm);
  if (out.isEmpty()) {
    out.delete();
    return current;
  }
  if (current !== section) arena.drop(current);
  return arena.keep(out);
}

/** Boolean difference in 2D, tracked; null when nothing survives. */
export function subtractSection(
  arena: Arena,
  section: CrossSection,
  cutter: CrossSection | null,
): CrossSection | null {
  if (cutter === null) return section;
  const out = section.subtract(cutter);
  if (out.isEmpty()) {
    out.delete();
    return null;
  }
  return arena.keep(out);
}

/** Boolean intersection in 2D, tracked; null when nothing survives. */
export function intersectSection(
  arena: Arena,
  section: CrossSection,
  clip: CrossSection,
): CrossSection | null {
  const out = section.intersect(clip);
  if (out.isEmpty()) {
    out.delete();
    return null;
  }
  return arena.keep(out);
}

/** Batch union of 2D sections, tracked; null when the input is all empty. */
export function unionSections(
  wasm: ManifoldToplevel,
  arena: Arena,
  sections: readonly (CrossSection | null)[],
): CrossSection | null {
  const live = sections.filter((s): s is CrossSection => s !== null && !s.isEmpty());
  if (live.length === 0) return null;
  if (live.length === 1) return live[0];
  const out = wasm.CrossSection.union(live);
  if (out.isEmpty()) {
    out.delete();
    return null;
  }
  return arena.keep(out);
}

// ---------------------------------------------------------------------------
// Extrusion and 3D booleans
// ---------------------------------------------------------------------------

/**
 * Grid every extrusion plane is snapped to, mm. A negative power of two on
 * purpose: see {@link snapZ}.
 */
export const Z_GRID_MM = 1 / 4096;

/**
 * Snap a Z plane to `Z_GRID_MM`, so two solids that are supposed to meet on it
 * actually do.
 *
 * An extrusion is built from 0 to `height` and then translated by `z0`, so its
 * top face lands at `z0 + (z1 - z0)`. That is NOT `z1`: in binary floating
 * point the round trip can miss by one unit in the last place, and a
 * 1e-15 mm gap between a tower and the roof it stands on is a gap - manifold
 * reports the union as two bodies, and it did, twice, on the Chicago plate
 * (85 mm3 and 112 mm3 of tower floating in mid air).
 *
 * On a grid of 2^-12 mm every plane under 64 mm needs 18 bits of mantissa, so
 * the difference and the sum are both exact in float32 and in double alike, and
 * `z0 + (z1 - z0) === z1` holds. The cost is that a plane can move by up to
 * 122 nanometres, four orders of magnitude below a layer height.
 */
export function snapZ(z: number): number {
  return Math.round(z / Z_GRID_MM) * Z_GRID_MM;
}

/**
 * Extrude a section between two Z planes. Null for an empty section or a
 * non-positive height, so a caller never has to guard both.
 */
export function extrudeSection(
  wasm: ManifoldToplevel,
  arena: Arena,
  section: CrossSection | null,
  zBottomMm: number,
  zTopMm: number,
): Manifold | null {
  if (section === null || section.isEmpty()) return null;
  const bottom = snapZ(zBottomMm);
  const height = snapZ(zTopMm) - bottom;
  if (!(height > 0)) return null;
  const solid = wasm.Manifold.extrude(section, height);
  const placed = bottom === 0 ? solid : solid.translate([0, 0, bottom]);
  if (placed !== solid) solid.delete();
  return arena.keep(placed);
}

/** 04 stage 2.5: "batch into groups of roughly 200", then pairwise in a tree. */
export const UNION_BATCH = 200;

/**
 * Union many solids without ever building a single accumulator.
 *
 * 04 stage 2.5 is explicit that the sequential form is quadratic in practice
 * and is "the difference between a 20 second bake and a 20 minute one". The
 * input list is deduplicated by identity first, because 04's trap list forbids
 * unioning a solid with itself.
 */
export function batchedUnion(
  wasm: ManifoldToplevel,
  arena: Arena,
  solids: readonly (Manifold | null)[],
  batch: number = UNION_BATCH,
): Manifold | null {
  const seen = new Set<Manifold>();
  const live: Manifold[] = [];
  for (const solid of solids) {
    if (solid === null || seen.has(solid) || solid.isEmpty()) continue;
    seen.add(solid);
    live.push(solid);
  }
  if (live.length === 0) return null;
  if (live.length === 1) return live[0];

  let level: Manifold[] = [];
  for (let i = 0; i < live.length; i += batch) {
    level.push(arena.keep(wasm.Manifold.union(live.slice(i, i + batch))));
  }
  while (level.length > 1) {
    const next: Manifold[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(arena.keep(wasm.Manifold.union([level[i], level[i + 1]])));
        arena.drop(level[i]);
        arena.drop(level[i + 1]);
      } else {
        next.push(level[i]);
      }
    }
    level = next;
  }
  return level[0];
}

/** Batch difference, tracked; `solid` itself when there is nothing to cut. */
export function subtractSolids(
  wasm: ManifoldToplevel,
  arena: Arena,
  solid: Manifold,
  cutters: readonly (Manifold | null)[],
): Manifold {
  const live = cutters.filter((c): c is Manifold => c !== null && !c.isEmpty());
  if (live.length === 0) return solid;
  return arena.keep(wasm.Manifold.difference([solid, ...live]));
}

/**
 * A body smaller than this (mm^3) is boolean debris, not a printable speck.
 *
 * The reference pipeline uses the same number (`assemble.MIN_BODY_VOLUME_MM3`).
 * 0.01 mm^3 is a 0.215 mm cube: under one extruded bead in every direction at
 * every legal nozzle. The smallest LEGAL building block is bigger than that by
 * an order of magnitude (`min_detail^2 * 0.6 mm` = 0.096 mm^3 at a 0.4 nozzle),
 * which is why the debris floor cannot be raised to 1 mm^3 without deleting
 * real buildings (see DECISIONS `[V3-P2-E2]`).
 */
export const DEBRIS_MM3 = 0.01;

/**
 * Debris floor for a MEASUREMENT union, mm^3 (`assemble.UNION_DEBRIS_MM3`).
 *
 * Unioning regions that meet on genuine coincident faces leaves a handful of
 * exactly-zero-volume shells at the seams. They have to go before the bodies
 * are counted or a perfectly connected model reads as a hundred pieces
 * (measured: 119 of them, total volume under 1e-9 mm^3, on the Chicago plate).
 * What must NOT go with them is a real island, so the floor is a nanolitre and
 * not the printable-speck floor above.
 */
export const UNION_DEBRIS_MM3 = 1e-9;

/**
 * Bodies in a solid, split by whether they are big enough to print.
 *
 * One decomposition, no re-union: counting is all the connectivity check needs,
 * and rebuilding the solid to count it costs more than the count (1.5 s of a
 * Chicago bake).
 */
export function countBodies(
  solid: Manifold,
  minVolume: number = DEBRIS_MM3,
): { real: number; debris: number; debrisVolume: number; smallestMm3: number } {
  const bodies = solid.decompose();
  let real = 0;
  let debris = 0;
  let debrisVolume = 0;
  let smallest = Infinity;
  for (const body of bodies) {
    const volume = body.volume();
    smallest = Math.min(smallest, volume);
    if (volume < minVolume) {
      debris += 1;
      debrisVolume += volume;
    } else {
      real += 1;
    }
    body.delete();
  }
  return {
    real,
    debris,
    debrisVolume,
    smallestMm3: Number.isFinite(smallest) ? smallest : 0,
  };
}

/** Drop zero-volume boolean debris left floating beside a region's real bodies. */
export function pruneDebris(
  wasm: ManifoldToplevel,
  arena: Arena,
  solid: Manifold,
  minVolume: number = DEBRIS_MM3,
): { solid: Manifold; dropped: number } {
  const bodies = arena.keepAll(solid.decompose());
  if (bodies.length <= 1) {
    arena.dropAll(bodies);
    return { solid, dropped: 0 };
  }
  const kept = bodies.filter((body) => body.volume() >= minVolume);
  if (kept.length === 0 || kept.length === bodies.length) {
    arena.dropAll(bodies);
    return { solid, dropped: 0 };
  }
  const merged = arena.keep(wasm.Manifold.union(kept));
  const dropped = bodies.length - kept.length;
  arena.dropAll(bodies);
  return { solid: merged, dropped };
}

// ---------------------------------------------------------------------------
// Manifold -> RegionMesh
// ---------------------------------------------------------------------------

/** Bounding box of a solid in the engine frame. */
export function bboxOf(solid: Manifold): Bbox3 {
  const box = solid.boundingBox();
  return { min: [...box.min], max: [...box.max] };
}

/** Connected bodies in a solid. Frees the decomposition it had to build. */
export function bodyCount(solid: Manifold): number {
  const bodies = solid.decompose();
  const count = bodies.length;
  for (const body of bodies) body.delete();
  return count;
}

/**
 * One finished region as the transferable record the rest of v3 consumes.
 *
 * `getMesh()` hands back interleaved vertex properties; with `numProp === 3`
 * they are exactly the xyz triples `RegionMesh.positions` is defined as. Both
 * arrays are COPIED out: the result outlives the arena that owns the solid, and
 * it is meant to be transferred from a Web Worker, neither of which is safe for
 * an array that may be a view into WASM memory. A mesh carrying extra
 * properties (nothing in this engine makes one) is de-interleaved instead of
 * being silently mis-read.
 */
export function toRegionMesh(
  solid: Manifold,
  region: RegionName,
  slot: number,
  colorHex: string,
  bodies?: number,
): RegionMesh {
  const mesh = solid.getMesh();
  const clean = cleanMesh({
    positions: doublePositions(solid, mesh.vertProperties, mesh.numProp),
    indices: new Uint32Array(mesh.triVerts),
  });
  return {
    region,
    positions: clean.mesh.positions,
    indices: clean.mesh.indices,
    volumeMm3: solid.volume(),
    bbox: bboxOf(solid),
    bodies: bodies ?? bodyCount(solid),
    slot,
    colorHex,
  };
}

/**
 * The solid's vertices in DOUBLE precision, in `getMesh()`'s own order.
 *
 * `getMesh()` hands back a `Float32Array`, which is the only mesh the JS
 * binding exposes, and float32 is not good enough to ship: one step at a 90 mm
 * coordinate is 7.6 nanometres, which is enough to collapse a triangle that
 * manifold3d built cleanly (measured: 1088 faces under 1e-9 mm^2 in the float32
 * rendering of a base region that has 721 in double, and a 6.5 mm^3 phantom
 * overlap between regions that share a face exactly).
 *
 * manifold3d keeps its vertices in double internally and `warpBatch` hands that
 * array to a callback, so a warp that changes nothing is a read-out. The
 * ordering is `getMesh()`'s: verified equal, index for index, to the float32
 * array it returns (they agree to 4.5e-7, which is exactly float32 rounding).
 * The guard below is the belt to that braces - if the two ever stop lining up,
 * the float32 positions are widened instead and nothing is silently misread.
 */
export function doublePositions(
  solid: Manifold,
  float32: Float32Array,
  stride: number,
): Float64Array {
  const count = float32.length / stride;
  const widened = new Float64Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    widened[i * 3] = float32[i * stride];
    widened[i * 3 + 1] = float32[i * stride + 1];
    widened[i * 3 + 2] = float32[i * stride + 2];
  }
  if (stride !== 3) return widened;

  const capture: { exact: Float64Array | null } = { exact: null };
  const echo = solid.warpBatch((verts) => {
    capture.exact = Float64Array.from(verts);
  });
  echo.delete();
  const found = capture.exact;
  if (found === null || found.length !== widened.length) return widened;
  for (let i = 0; i < widened.length; i += 1) {
    // One float32 ulp at 1024 mm, far above the 7.6e-6 mm the model can show.
    if (Math.abs(found[i] - widened[i]) > 1e-3) return widened;
  }
  return found;
}
