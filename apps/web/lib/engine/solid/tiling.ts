/**
 * Splitting a model too big for the bed into tiles that mate.
 *
 * The cut is by vertical planes through the whole model: `cols` columns west to
 * east and `rows` rows south to north, every region and the welded solid cut on
 * the same planes, so the tiles of one region and the tiles of another agree
 * about where the seams are. Each interior seam gets registration features so
 * the printed tiles locate against each other instead of being glued by eye.
 *
 * Three properties the tests pin, and the geometry is arranged to give:
 *
 * 1. **The union of the tiles is the model, minus the joint clearance.** A male
 *    key is the SAME solid the neighbour's socket was cut from, grown by
 *    `tolerance_mm`. So the only material anywhere in the model that no tile
 *    carries is the tolerance shell around each key, and `tolerance_mm = 0`
 *    reproduces the model exactly.
 * 2. **The mating faces are `tolerance_mm` apart, everywhere.** The socket is a
 *    2D offset of the key's own section by the tolerance, and both are prisms in
 *    Z, so the clearance is the offset distance on every flank and at the tip,
 *    and `Manifold.minGap` measures it back out (`tiling.test.ts`).
 * 3. **Every joint is prismatic in Z.** The tiles therefore mate by being
 *    lowered onto each other, which is the only assembly direction available to
 *    a plate that lies flat: a dovetail cut in plan locks the two against being
 *    pulled apart in either direction along the bed, which is what a wall-hung
 *    plate is loaded in, and nothing has to slide through the model to
 *    assemble it.
 *
 * The male key always belongs to the LOWER-indexed tile of a seam (the west
 * side of a vertical cut, the south side of a horizontal one), so every tile
 * except the corners carries both kinds and none of them is all sockets.
 *
 * `[V3-P4-E4]` in DECISIONS carries the dimensions and the count rule.
 */

import type { PrintParams } from "../../contracts";
import { loadedGlyphFace } from "../../fontGlyphs";
import type { PreviewArea } from "../../preview";
import { glyphAreas, placeArea } from "../../previewText";
import * as T from "../../transform";
import type { Bbox3, RegionMesh, RegionName, TileResult } from "../types";
import { CUTTER_OVERSHOOT_MM, addFinding, finding, type BakeContext } from "./context";
import { contoursFromAreas, deepestRecessMm, repairText } from "./lettering";
import type { Contour, CrossSection, Manifold } from "./manifold";
import {
  MITRE,
  ROUND,
  batchedUnion,
  cleanSection,
  extrudeSection,
  intersectSection,
  rectContour,
  sectionOf,
  subtractSection,
  subtractSolids,
  toRegionMesh,
  unionSections,
} from "./manifold";
import { OPENING_SEGMENTS, sliceHeights } from "./measure";
import { undersideSkipBands } from "./attribution";
import { MIN_WALL_PROBE_FACTOR, RESIDUE_AREA_RATIO, residueParts } from "./repair";

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/** Width of a dovetail key where it crosses the cut line, mm. */
export const DOVETAIL_NECK_MM = 6;
/** How much wider each flank gets by the far end, mm. */
export const DOVETAIL_FLARE_MM = 1.5;
/** How far a dovetail key reaches into the neighbouring tile, mm. */
export const DOVETAIL_DEPTH_MM = 5;

/** Diameter of a registration pin, mm, before it is clamped to the base. */
export const PIN_DIAMETER_MM = 4;
/** How far a pin reaches into the neighbouring tile, mm. */
export const PIN_LENGTH_MM = 3;
/** Material left above and below a pin inside the base slab, mm. */
export const PIN_ROOF_MM = 0.6;
/** Segments per full circle in a pin. */
export const PIN_SEGMENTS = 24;

/**
 * How far a key reaches BACK into its own tile, mm.
 *
 * Nothing structural: it makes the union of the key and the tile transversal
 * instead of a pair of coincident faces at the cut plane, which is the same
 * reason every seam in this engine overlaps (`context.PART_OVERLAP_MM`).
 */
export const JOINT_BACK_MM = 0.5;

/**
 * Keys per metre of seam, and the floor and ceiling on the count.
 *
 * The density is what the brief specifies for pins (two per edge metre) and the
 * dovetail is given three times that, because a dovetail key is smaller than a
 * pin socket is deep and a plate seam wants more than one lock. At the sizes
 * this product prints - a seam is 90 to 170 mm - the density never binds and
 * the FLOOR does: two keys per seam, which is the smallest number that stops
 * the tiles rotating about a single key (`[V3-P4-E4]`).
 */
export const DOVETAILS_PER_METRE = 6;
export const PINS_PER_METRE = 2;
export const MIN_KEYS_PER_SEAM = 2;
export const MAX_KEYS_PER_SEAM = 8;

/** Clear seam left between two neighbouring keys, mm. */
export const KEY_CLEARANCE_MM = 2;

/**
 * Smallest fraction of its nominal size a key may be shrunk to for a short
 * seam. Below this the seam gets no registration at all and says so.
 */
export const MIN_KEY_SCALE = 0.3;

/**
 * How far a cut plane may be moved to find a clean line, mm.
 *
 * A cut through a city is not a cut through a block of material: it passes
 * through grooves, kerbs and walls, and where it lands a hair from one of them
 * it leaves a rind of base thinner than the nozzle can lay. Measured on the
 * Chicago plate, the nominal centre line landed 0.33 mm east of a street
 * groove's wall and the reference validator failed the tile on it.
 *
 * The remedy is the one a person with a saw would use: move the cut a couple of
 * millimetres to where it misses everything. Three millimetres is 3 % of a
 * 90 mm tile - too little to unbalance the grid, and more than the width of the
 * features it has to clear (`[V3-P4-E6]`).
 */
export const SNAP_WINDOW_MM = 3;

/** Step of the snap search, mm. A tenth of the print grid. */
export const SNAP_STEP_MM = 0.01;

/**
 * How far from a cut a new thin feature can possibly be, mm.
 *
 * Everything the tiling adds to a tile's boundary - the cut plane, a key's
 * flanks, a socket's walls - lies inside this distance of a cut line, so it is
 * the only band that has to be searched for material the cut made too thin.
 * Searching a band rather than the whole slice is what makes the search cost
 * ten milliseconds a slice instead of a second.
 */
export const SLIVER_BAND_MM = DOVETAIL_DEPTH_MM + JOINT_BACK_MM + 4;

/**
 * How much of a slice's thin material has to be found before the tile is cut
 * again, mm2. A hundredth of a square millimetre is a 0.1 mm square: below
 * anything a printer or the reference validator can see.
 */
export const SLIVER_MIN_AREA_MM2 = 0.01;

/**
 * How far the sliver cutter is grown past the material it removes, mm.
 *
 * Comfortably above the boolean's own tolerance and below the print grid, so no
 * face of the cutter can land ON a face of the model. It costs a seventh of a
 * millimetre of extra material at the seam and it is the difference between a
 * clean subtraction and a shredded one (see {@link thinPart}).
 */
export const SLIVER_GROW_MM = 0.15;

/**
 * How many times the sliver removal looks again at what it has just cut.
 *
 * Removing a fin retreats a boundary, and a retreated boundary can leave the
 * next thing along too thin. Three passes is what the Chicago plate needs to
 * converge to zero thin regions under the reference validator; a fourth finds
 * nothing and costs one more sweep of the bands.
 */
export const SLIVER_PASSES = 3;

/** Size of the tile index mark, mm, and the face it is cut in. */
export const INDEX_MARK_SIZE_MM = T.UNDERSIDE_MARK_SIZE_MM;
export const INDEX_MARK_FACE = T.UNDERSIDE_MARK_FACE;
export const INDEX_MARK_DEPTH_MM = T.UNDERSIDE_MARK_DEPTH_MM;

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

export interface TileGridSpec {
  cols: number;
  rows: number;
  joint: "dovetail" | "pin";
  toleranceMm: number;
  indexMark: boolean;
}

/** The tiling this parameter set asks for, or null when it asks for none. */
export function tileGridSpec(params: PrintParams): TileGridSpec | null {
  const tiling = params.tiling;
  if (tiling?.enabled !== true) return null;
  const cols = Math.max(1, Math.round(tiling.cols ?? 1));
  const rows = Math.max(1, Math.round(tiling.rows ?? 1));
  if (cols * rows <= 1) return null;
  return {
    cols,
    rows,
    joint: tiling.joint === "pin" ? "pin" : "dovetail",
    toleranceMm: tiling.tolerance_mm ?? 0.15,
    indexMark: tiling.index_mark !== false,
  };
}

/**
 * The grid reference of a tile: column letter from the west, row number from
 * the NORTH, both one-based, so "A1" is the top-left tile as the model is seen
 * from above and a reader can find it on the plate without a legend.
 */
export function tileLabel(col: number, row: number, rows: number): string {
  const letter = String.fromCharCode(65 + (col % 26));
  return `${letter}${rows - row}`;
}

/** How many keys a seam of this length gets. */
export function keyCount(lengthMm: number, perMetre: number): number {
  const wanted = Math.round((perMetre * lengthMm) / 1000);
  return Math.min(MAX_KEYS_PER_SEAM, Math.max(MIN_KEYS_PER_SEAM, wanted));
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** One finished region solid, as `engine.ts` hands it over. */
export interface TileSource {
  region: RegionName;
  solid: Manifold;
  slot: number;
  colorHex: string;
}

interface Seam {
  /** 0 for a cut plane of constant x, 1 for one of constant y. */
  axis: 0 | 1;
  /** Where the plane is, mm. */
  planeMm: number;
  /** Grid index of the tile that carries the MALE keys. */
  male: [number, number];
  /** Grid index of the tile that carries the sockets. */
  female: [number, number];
  /** The key solid, or null when the seam was too short to key. */
  key: Manifold | null;
  /** The socket cutter: the key grown by the tolerance. */
  socket: Manifold | null;
  /**
   * The same two shapes in PLAN, kept because the sliver search works in 2D and
   * has to know what the joint adds to and takes from a tile's cross-section.
   * Null for a pin joint, whose key is not a prism in Z.
   */
  keySection: CrossSection | null;
  socketSection: CrossSection | null;
}

/** One horizontal slice of the finished model, clipped to one cut line's band. */
interface BandSlice {
  z: number;
  axis: 0 | 1;
  at: number;
  section: CrossSection;
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/**
 * Cut the model into tiles.
 *
 * Returns an empty list when this parameter set asks for no tiling, so the
 * caller can call it unconditionally. Never throws: a seam too short to key, a
 * label that will not fit and a tile that came out empty are all findings.
 */
export function buildTiles(
  ctx: BakeContext,
  sources: readonly TileSource[],
  merged: Manifold | null,
): TileResult[] {
  const spec = tileGridSpec(ctx.params);
  if (spec === null || sources.length === 0) return [];

  const bounds = unionBounds(sources, merged);
  if (bounds === null) return [];
  const width = bounds.max[0] - bounds.min[0];
  const depth = bounds.max[1] - bounds.min[1];
  if (!(width > 0) || !(depth > 0)) return [];

  const xEdges = edgesOf(bounds.min[0], width, spec.cols);
  const yEdges = edgesOf(bounds.min[1], depth, spec.rows);
  const zLo = bounds.min[2] - 1;
  const zHi = bounds.max[2] + 1;

  // Move each interior cut to the cleanest line near it, so a seam does not
  // shave a groove wall down to a rind (see `SNAP_WINDOW_MM`). The outer edges
  // are the model's own boundary and are never moved.
  const minWall = ctx.thresholdsMm.minWall;
  const interiorX = xEdges.slice(1, -1);
  const interiorY = yEdges.slice(1, -1);
  const probeReach = SNAP_WINDOW_MM + Math.max(minWall, DOVETAIL_DEPTH_MM + minWall);
  const probes =
    merged === null
      ? { xs: [], ys: [] }
      : probeCoordinates(
          ctx,
          merged,
          [...interiorX, ...interiorX.map((x) => x + DOVETAIL_DEPTH_MM)],
          [...interiorY, ...interiorY.map((y) => y + DOVETAIL_DEPTH_MM)],
          probeReach,
        );
  for (let i = 1; i < xEdges.length - 1; i += 1) {
    xEdges[i] = snapCut(xEdges[i], probes.xs, SNAP_WINDOW_MM, minWall);
  }
  for (let i = 1; i < yEdges.length - 1; i += 1) {
    yEdges[i] = snapCut(yEdges[i], probes.ys, SNAP_WINDOW_MM, minWall);
  }

  const seams = buildSeams(ctx, spec, xEdges, yEdges, zLo, zHi, probes, minWall);

  // The model sliced ONCE per height and clipped to each cut line's band. Every
  // tile's sliver search then runs entirely in 2D on these sections: a tile's
  // own cross-section is this band clipped to its side of the cuts, plus the
  // keys it carries, minus the sockets cut into it, all of which are plan
  // shapes. Doing it in 3D instead - slicing each finished tile - measured
  // 56 seconds on the Chicago plate against three (`[V3-P4-E7]`).
  const bands = merged === null ? [] : bandSlices(ctx, merged, seams);

  const out: TileResult[] = [];
  for (let row = 0; row < spec.rows; row += 1) {
    for (let col = 0; col < spec.cols; col += 1) {
      const tile = buildTile(ctx, spec, sources, merged, seams, bands, zLo, zHi, {
        col,
        row,
        x0: xEdges[col],
        x1: xEdges[col + 1],
        y0: yEdges[row],
        y1: yEdges[row + 1],
      });
      if (tile !== null) out.push(tile);
    }
  }
  if (out.length < spec.cols * spec.rows) {
    addFinding(
      ctx,
      finding(
        "tile-empty",
        "warning",
        `${spec.cols * spec.rows - out.length} tile(s) came out empty`,
        "The model does not reach into every square of the grid, so those tiles have " +
          "nothing to print. Fewer columns or rows would divide it more evenly.",
      ),
    );
  }
  return out;
}

/** Edge coordinates of a `count`-way split of `[start, start + span]`. */
function edgesOf(start: number, span: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= count; i += 1) out.push(start + (span * i) / count);
  return out;
}

/**
 * Every plan coordinate the model has a boundary at, near the interior cut
 * lines, in millimetres.
 *
 * Taken from horizontal slices of the finished solid at the same feature
 * heights the minimum-wall gate samples (`measure.sliceHeights`), because those
 * are the heights at which the model changes character: the floor and the mouth
 * of every recess, either side of the base top, the frame lip, and four heights
 * through the buildings. A wall that exists at none of them is a wall the gate
 * does not measure either.
 *
 * Only coordinates inside a search window are kept, so this is a few hundred
 * numbers out of the ~40 000 vertices a Chicago slice carries.
 */
function probeCoordinates(
  ctx: BakeContext,
  solid: Manifold,
  interiorX: readonly number[],
  interiorY: readonly number[],
  reach: number,
): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  if (interiorX.length === 0 && interiorY.length === 0) return { xs, ys };
  const near = (value: number, lines: readonly number[]): boolean =>
    lines.some((line) => Math.abs(value - line) <= reach);
  const top = solid.boundingBox().max[2];
  for (const z of sliverHeights(ctx, top)) {
    const section = solid.slice(z);
    try {
      if (section.isEmpty()) continue;
      for (const ring of section.toPolygons()) {
        for (const point of ring) {
          if (near(point[0], interiorX)) xs.push(point[0]);
          if (near(point[1], interiorY)) ys.push(point[1]);
        }
      }
    } finally {
      section.delete();
    }
  }
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  return { xs, ys };
}

/**
 * The cleanest cut coordinate within `windowMm` of `nominal`.
 *
 * "Cleanest" is the largest distance to the nearest boundary the model has
 * there: cut that far from every wall and the thinnest thing the cut can leave
 * behind is that distance wide. The best position in a continuous window is
 * always either an end of the window or the midpoint of a gap between two
 * consecutive boundaries, so those are the only candidates worth scoring.
 *
 * Among candidates that clear a full minimum wall, the one CLOSEST to the
 * nominal line wins, so the tiles stay as even as the model allows; when none
 * of them do, the best available wins and the seam is as clean as this model
 * can be cut.
 */
export function snapCut(
  nominal: number,
  coords: readonly number[],
  windowMm: number,
  minWallMm: number,
): number {
  const lo = nominal - windowMm;
  const hi = nominal + windowMm;
  const distance = (at: number): number => {
    let best = Infinity;
    for (const coord of coords) {
      const gap = Math.abs(coord - at);
      if (gap < best) best = gap;
      if (coord > at && gap > best) break;
    }
    return best;
  };
  const candidates: number[] = [nominal, lo, hi];
  for (let i = 0; i + 1 < coords.length; i += 1) {
    const mid = (coords[i] + coords[i + 1]) / 2;
    if (mid > lo && mid < hi) candidates.push(mid);
  }
  let best = nominal;
  let bestScore = -Infinity;
  for (const raw of candidates) {
    const at = Math.round(Math.min(hi, Math.max(lo, raw)) / SNAP_STEP_MM) * SNAP_STEP_MM;
    const score = distance(at);
    const clears = score >= minWallMm;
    const bestClears = bestScore >= minWallMm;
    if (clears && bestClears) {
      if (Math.abs(at - nominal) < Math.abs(best - nominal)) {
        best = at;
        bestScore = score;
      }
      continue;
    }
    if (score > bestScore) {
      best = at;
      bestScore = score;
    }
  }
  return best;
}

function unionBounds(sources: readonly TileSource[], merged: Manifold | null): Bbox3 | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const solids = merged === null ? sources.map((s) => s.solid) : [...sources.map((s) => s.solid), merged];
  for (const solid of solids) {
    if (solid.isEmpty()) continue;
    const box = solid.boundingBox();
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], box.min[axis]);
      max[axis] = Math.max(max[axis], box.max[axis]);
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

// ---------------------------------------------------------------------------
// Seams and keys
// ---------------------------------------------------------------------------

function buildSeams(
  ctx: BakeContext,
  spec: TileGridSpec,
  xEdges: readonly number[],
  yEdges: readonly number[],
  zLo: number,
  zHi: number,
  probes: { xs: number[]; ys: number[] },
  minWallMm: number,
): Seam[] {
  const out: Seam[] = [];
  let unkeyed = 0;
  // A key's TIP is a cut face too, and it lands `depth` past the seam wherever
  // the seam ended up, so it gets the same treatment: the depth is nudged until
  // the tip clears every wall by a full minimum wall as well.
  const depthFor = (plane: number, coords: readonly number[]): number =>
    snapCut(plane + DOVETAIL_DEPTH_MM, coords, SNAP_WINDOW_MM, minWallMm) - plane;
  for (let col = 0; col + 1 < spec.cols; col += 1) {
    const plane = xEdges[col + 1];
    const depth = depthFor(plane, probes.xs);
    for (let row = 0; row < spec.rows; row += 1) {
      const seam = makeSeam(ctx, spec, 0, plane, yEdges[row], yEdges[row + 1], zLo, zHi, [col, row], [col + 1, row], depth);
      if (seam.key === null) unkeyed += 1;
      out.push(seam);
    }
  }
  for (let row = 0; row + 1 < spec.rows; row += 1) {
    const plane = yEdges[row + 1];
    const depth = depthFor(plane, probes.ys);
    for (let col = 0; col < spec.cols; col += 1) {
      const seam = makeSeam(ctx, spec, 1, plane, xEdges[col], xEdges[col + 1], zLo, zHi, [col, row], [col, row + 1], depth);
      if (seam.key === null) unkeyed += 1;
      out.push(seam);
    }
  }
  if (unkeyed > 0) {
    addFinding(
      ctx,
      finding(
        "tile-joint-refused",
        "warning",
        `${unkeyed} tile seam(s) got no registration features`,
        "The seam is too short to hold a key of a printable size, so those tiles butt " +
          "together flat and have to be aligned by hand. Fewer, larger tiles would keep " +
          "the joints.",
      ),
    );
  }
  return out;
}

function makeSeam(
  ctx: BakeContext,
  spec: TileGridSpec,
  axis: 0 | 1,
  planeMm: number,
  fromMm: number,
  toMm: number,
  zLo: number,
  zHi: number,
  male: [number, number],
  female: [number, number],
  depthMm: number,
): Seam {
  const length = toMm - fromMm;
  const built =
    spec.joint === "pin"
      ? pinKeys(ctx, axis, planeMm, fromMm, toMm, length, spec.toleranceMm, depthMm)
      : dovetailKeys(ctx, axis, planeMm, fromMm, toMm, length, spec.toleranceMm, zLo, zHi, depthMm);
  return {
    axis,
    planeMm,
    male,
    female,
    key: built.key,
    socket: built.socket,
    keySection: built.keySection,
    socketSection: built.socketSection,
  };
}

interface KeyPair {
  key: Manifold | null;
  socket: Manifold | null;
  /** The same shapes in plan, for the 2D sliver search. Null for a pin joint. */
  keySection: CrossSection | null;
  socketSection: CrossSection | null;
}

/** A seam with no registration features at all. */
const EMPTY_KEYS: KeyPair = { key: null, socket: null, keySection: null, socketSection: null };

/** Centres of `n` keys spread evenly along `[from, to]`. */
function keyCentres(fromMm: number, toMm: number, n: number): number[] {
  const step = (toMm - fromMm) / n;
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push(fromMm + step * (i + 0.5));
  return out;
}

/**
 * Trapezoidal keys in plan, extruded through the whole model.
 *
 * The section is built once per key and the socket is the SAME section offset
 * outward by the tolerance, which is what makes the clearance exact on every
 * flank and at the tip. A negative tolerance offsets inward, so the socket comes
 * out smaller than the key and the two interfere by exactly that much: that is
 * the interference-fit case the test measures.
 */
function dovetailKeys(
  ctx: BakeContext,
  axis: 0 | 1,
  planeMm: number,
  fromMm: number,
  toMm: number,
  lengthMm: number,
  toleranceMm: number,
  zLo: number,
  zHi: number,
  depthMm: number,
): KeyPair {
  const n = keyCount(lengthMm, DOVETAILS_PER_METRE);
  const nominal = DOVETAIL_NECK_MM + 2 * DOVETAIL_FLARE_MM;
  const available = lengthMm / n - KEY_CLEARANCE_MM;
  const scale = Math.min(1, available / nominal);
  if (!(scale >= MIN_KEY_SCALE)) return EMPTY_KEYS;

  const neck = DOVETAIL_NECK_MM * scale;
  const flare = DOVETAIL_FLARE_MM * scale;
  const depth = depthMm * scale;
  const contours: Contour[] = keyCentres(fromMm, toMm, n).map((centre) =>
    dovetailContour(axis, planeMm, centre, neck, flare, depth),
  );
  const section = sectionOf(ctx.wasm, ctx.arena, contours);
  if (section === null) return EMPTY_KEYS;
  const grown = growSection(ctx, section, toleranceMm);
  return {
    key: extrudeSection(ctx.wasm, ctx.arena, section, zLo, zHi),
    socket: extrudeSection(ctx.wasm, ctx.arena, grown, zLo, zHi),
    keySection: section,
    socketSection: grown,
  };
}

/** `section` offset by `deltaMm`; the section itself when the delta is zero. */
function growSection(
  ctx: BakeContext,
  section: CrossSection,
  deltaMm: number,
): CrossSection | null {
  if (deltaMm === 0) return section;
  const out = section.offset(deltaMm, MITRE, 2, 0);
  if (out.isEmpty()) {
    out.delete();
    return null;
  }
  return ctx.arena.keep(out);
}

/**
 * One dovetail in plan, counter-clockwise.
 *
 * Constant width from `back` to the cut line, then flaring to the far end, so
 * the narrow point is exactly on the seam and the key cannot be pulled out
 * along the cut normal.
 */
export function dovetailContour(
  axis: 0 | 1,
  planeMm: number,
  centreMm: number,
  neckMm: number,
  flareMm: number,
  depthMm: number,
): Contour {
  const back = planeMm - JOINT_BACK_MM;
  const tip = planeMm + depthMm;
  const half = neckMm / 2;
  const wide = half + flareMm;
  if (axis === 0) {
    return [
      [back, centreMm - half],
      [planeMm, centreMm - half],
      [tip, centreMm - wide],
      [tip, centreMm + wide],
      [planeMm, centreMm + half],
      [back, centreMm + half],
    ];
  }
  return [
    [centreMm + half, back],
    [centreMm + half, planeMm],
    [centreMm + wide, tip],
    [centreMm - wide, tip],
    [centreMm - half, planeMm],
    [centreMm - half, back],
  ];
}

/**
 * Cylindrical pins along the cut normal, with sockets to match.
 *
 * The pin lies INSIDE the base slab, at its mid-height, with
 * {@link PIN_ROOF_MM} of material above and below: a 4 mm pin does not fit in a
 * 3 mm base, and a pin that broke out through the top or the bottom face would
 * be a hole in the model rather than a joint. The socket is a longer, fatter
 * cylinder on the same axis, so the clearance is the tolerance around the shaft
 * and at the bottom of the hole alike.
 */
function pinKeys(
  ctx: BakeContext,
  axis: 0 | 1,
  planeMm: number,
  fromMm: number,
  toMm: number,
  lengthMm: number,
  toleranceMm: number,
  depthMm: number,
): KeyPair {
  const baseTop = ctx.baseTopMm;
  const maxRadius = (baseTop - 2 * PIN_ROOF_MM) / 2;
  const radius = Math.min(PIN_DIAMETER_MM / 2, maxRadius);
  if (!(radius >= ctx.thresholdsMm.minWall / 2)) return EMPTY_KEYS;
  const n = keyCount(lengthMm, PINS_PER_METRE);
  if (!(lengthMm / n >= 4 * radius)) return EMPTY_KEYS;

  // The pin is as long as the joint depth allows, capped at its own nominal
  // length: a snapped depth moves the tip to a clean line for the same reason a
  // dovetail's does.
  const length = JOINT_BACK_MM + Math.min(PIN_LENGTH_MM, Math.max(2 * radius, depthMm));
  const centreZ = baseTop / 2;
  const keys: Manifold[] = [];
  const sockets: Manifold[] = [];
  for (const centre of keyCentres(fromMm, toMm, n)) {
    keys.push(pinSolid(ctx, axis, planeMm, centre, centreZ, radius, length, 0));
    const socketRadius = radius + toleranceMm;
    if (socketRadius > 0) {
      sockets.push(pinSolid(ctx, axis, planeMm, centre, centreZ, socketRadius, length, toleranceMm));
    }
  }
  return {
    key: batchedUnion(ctx.wasm, ctx.arena, keys),
    socket: batchedUnion(ctx.wasm, ctx.arena, sockets),
    keySection: null,
    socketSection: null,
  };
}

/**
 * One pin: a cylinder whose axis is the cut normal, its near end
 * {@link JOINT_BACK_MM} inside its own tile and its far end `PIN_LENGTH_MM +
 * extraMm` past the seam.
 */
function pinSolid(
  ctx: BakeContext,
  axis: 0 | 1,
  planeMm: number,
  centreMm: number,
  centreZMm: number,
  radiusMm: number,
  lengthMm: number,
  extraMm: number,
): Manifold {
  const { wasm, arena } = ctx;
  const total = lengthMm + extraMm;
  const raw = wasm.Manifold.cylinder(total, radiusMm, radiusMm, PIN_SEGMENTS, false);
  // `cylinder` stands on the origin along +z; turn its axis onto the cut normal
  // and slide its near end to `plane - JOINT_BACK_MM`.
  const turned = axis === 0 ? raw.rotate([0, 90, 0]) : raw.rotate([-90, 0, 0]);
  raw.delete();
  const start = planeMm - JOINT_BACK_MM;
  const placed =
    axis === 0
      ? turned.translate([start, centreMm, centreZMm])
      : turned.translate([centreMm, start, centreZMm]);
  turned.delete();
  return arena.keep(placed);
}

// ---------------------------------------------------------------------------
// One tile
// ---------------------------------------------------------------------------

interface TileBox {
  col: number;
  row: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function buildTile(
  ctx: BakeContext,
  spec: TileGridSpec,
  sources: readonly TileSource[],
  merged: Manifold | null,
  seams: readonly Seam[],
  bands: readonly BandSlice[],
  zLo: number,
  zHi: number,
  box: TileBox,
): TileResult | null {
  const { arena } = ctx;
  const mine = (index: [number, number]): boolean => index[0] === box.col && index[1] === box.row;
  const males = seams.filter((seam) => mine(seam.male) && seam.key !== null);
  const sockets = seams.filter((seam) => mine(seam.female) && seam.socket !== null);

  const label = tileLabel(box.col, box.row, spec.rows);
  const indexCut = spec.indexMark ? indexCutter(ctx, label, box) : null;
  // Measured on the WELDED model, because "is this wall thin" is a question
  // about the assembled tile and not about one of its colour parts: the base
  // beside a groove is a wall, the groove's own filling is not. Every region
  // and the merged solid are then cut by the SAME set, so the parts and the
  // single object cannot disagree about where the tile ends.
  const slivers = sliverCutter(ctx, bands, males, sockets, box, zLo, zHi);
  if (slivers !== null) {
    reportSlivers(ctx, label, slivers.volume());
  }

  const regions: RegionMesh[] = [];
  let bbox: Bbox3 | null = null;
  for (const source of sources) {
    const solid = tileSolid(ctx, source.solid, box, males, sockets, indexCut, slivers);
    if (solid === null) continue;
    // `collapseNeedles`: a tile is a trim by up to four planes, a union with
    // its keys and three subtractions deep, and each of those can leave a
    // needle the whole-mesh weld ladder cannot reach (`mesh.NEEDLE_COLLAPSE_MM`,
    // `[V3-P7-A9]`). An untiled bake never needs it and never asks for it.
    const mesh = toRegionMesh(solid, source.region, source.slot, source.colorHex, undefined, {
      collapseNeedles: true,
    });
    regions.push(mesh);
    bbox = mergeBbox(bbox, mesh.bbox);
    arena.drop(solid);
  }
  if (regions.length === 0 || bbox === null) return null;

  const tile: TileResult = { index: [box.col, box.row], label, regions, bbox };
  if (merged !== null) {
    const solid = tileSolid(ctx, merged, box, males, sockets, indexCut, slivers);
    if (solid !== null) {
      tile.merged = toRegionMesh(
        solid,
        "base",
        regions[0].slot,
        regions[0].colorHex,
        undefined,
        { collapseNeedles: true },
      );
      arena.drop(solid);
    }
  }
  return tile;
}

/**
 * Say how much material the seams cost, once, with the number in it.
 *
 * A user who compares the tiles with the whole model will see the difference at
 * the joints, and it is better to say so than to let them find it: the model is
 * not quite the same object once it has been cut, and this is exactly how much
 * not quite.
 */
function reportSlivers(ctx: BakeContext, label: string, volumeMm3: number): void {
  if (!(volumeMm3 > 0)) return;
  const seen = ctx.findings.find((f) => f.id === "tile-seam-trimmed");
  const total = (seen?.detail.match(/([\d.]+) mm3 in total/)?.[1] ?? "0") as string;
  const running = Number(total) + volumeMm3;
  const detail =
    `A cut through a city at this scale always passes close to something: where it left ` +
    `material under ${ctx.thresholdsMm.minWall.toFixed(2)} mm - a rind of plate beside a ` +
    `street groove, the edge of a building the seam clipped - that material was removed ` +
    `rather than shipped as a fin the nozzle cannot lay. ${running.toFixed(2)} mm3 in total, ` +
    `most recently on tile ${label}.`;
  if (seen === undefined) {
    addFinding(ctx, finding("tile-seam-trimmed", "info", "The seams were trimmed to printable walls", detail));
    return;
  }
  seen.detail = detail;
}

/**
 * The model sliced at the heights that matter, clipped to each cut line's band.
 *
 * Computed once for the whole grid: the sections are shared by both tiles of
 * every seam and by both sliver passes.
 */
function bandSlices(ctx: BakeContext, merged: Manifold, seams: readonly Seam[]): BandSlice[] {
  const { arena } = ctx;
  const lines = new Map<string, { axis: 0 | 1; at: number }>();
  for (const seam of seams) lines.set(`${seam.axis}:${seam.planeMm}`, { axis: seam.axis, at: seam.planeMm });
  if (lines.size === 0) return [];
  const box = merged.boundingBox();
  const reach = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1]) + 10;
  const out: BandSlice[] = [];
  for (const z of sliverHeights(ctx, box.max[2])) {
    const section = merged.slice(z);
    try {
      if (section.isEmpty()) continue;
      for (const line of lines.values()) {
        const band = clipToBand(ctx, section, line, SLIVER_BAND_MM, reach);
        if (band === null) continue;
        out.push({ z, axis: line.axis, at: line.at, section: arena.keep(band) });
      }
    } finally {
      section.delete();
    }
  }
  return out;
}

/**
 * Heights the sliver search samples, print mm.
 *
 * Fewer than the minimum-wall gate's own list, and deliberately: everything
 * above the base is a vertical extrusion of its own footprint, so ONE height
 * just above the base top sees every building's plan shape, and one more
 * catches anything that only exists higher up (a deck, a canopy). The rest of
 * the list is the base slab, where the recesses are, because that is where a
 * cut can leave a rind of plate between a groove and the seam.
 */
export function sliverHeights(ctx: BakeContext, topMm: number): number[] {
  const baseTop = ctx.baseTopMm;
  const span = Math.max(0, topMm - baseTop);
  const eps = 0.05;
  const regions = ctx.params.regions;
  // The underside pockets are excluded here for a HARDER reason than they are
  // in `measure.measureMinWall`: a sliver found at one height is cut out of the
  // whole model, at every height (see `sliverCutter`'s own note on cumulative
  // passes). A letter counter on the floor of the attribution mark reads as a
  // 0.4 mm island in a slice taken inside that pocket, and taking it out would
  // punch a hole clean through the tile. It is not a sliver: it is the
  // underside of a plate 2.5 mm thick there (`[V3-P7-A8]`).
  // EVERY mark band, not just the underside one: the frame inner-wall mark
  // notches the lip, and a notch's neighbouring ridge read as a sliver at
  // z = base top + 1 mm would be cut out of the whole model.
  const skipBands = ctx.markBands.length > 0 ? ctx.markBands : undersideSkipBands(ctx);
  const wanted = [
    ...sliceHeights(ctx, topMm, skipBands),
    // Just above the base top, where every building's own plan shape is, and
    // one more inside the towers for anything that starts higher up.
    baseTop + eps,
    baseTop + span * 0.3,
    // Just ABOVE the top of every raised layer and of the frame lip. These are
    // the heights where the model's CONNECTIVITY changes: a thin fin of tower
    // that a proud rail bed joins to its neighbours at 3.05 mm stands alone at
    // 3.35 mm, and only alone does it read as the sliver it is.
    ...[regions?.roads, regions?.water, regions?.parks, regions?.rail].map(
      (spec) => baseTop + (spec?.proud_mm ?? 0) + eps,
    ),
    ...(ctx.params.frame ? [baseTop + T.FRAME_LIP_MM + eps] : []),
  ];
  return [...new Set(wanted)]
    .filter(
      (z) =>
        z > 0 && z < topMm && !skipBands.some(([low, high]) => z >= low && z <= high),
    )
    .sort((a, b) => a - b);
}

/**
 * Material this tile's cuts left too thin to print, as a solid to subtract.
 *
 * The measurement is 04's own minimum-wall rule, applied in 2D: what a
 * morphological opening at the minimum wall does not cover is, by definition,
 * material no disc of a full wall fits inside. Removing it leaves the opening,
 * which is a union of such discs and therefore a full wall thick everywhere.
 *
 * It is a real and unavoidable part of tiling, not a defect being papered over.
 * A cut through a city of towers at 1:10 000 passes within a fraction of a
 * millimetre of SOMETHING wherever it is put: measured on the Chicago plate,
 * the best line anywhere within 3 mm of the centre still shaved 2.4 mm2 of
 * material into fins under the nozzle width, and the nominal line shaved 25.
 * Moving the cut (see `snapCut`) reduces it; only removing what is left
 * eliminates it (`[V3-P4-E7]`).
 *
 * Every step is a plan operation on a small band section: the tile's own
 * cross-section is the band clipped to its side of each cut, plus the keys it
 * carries, minus the sockets cut into it. The result is a prism through the
 * whole model, because everything above the base is a vertical extrusion of its
 * own footprint: a tower thin at one height is thin at all of them, and a plan
 * point that carries a thin thing carries nothing else.
 */
function sliverCutter(
  ctx: BakeContext,
  bands: readonly BandSlice[],
  males: readonly Seam[],
  sockets: readonly Seam[],
  box: TileBox,
  zLo: number,
  zHi: number,
): Manifold | null {
  const { wasm, arena } = ctx;
  const minWall = ctx.thresholdsMm.minWall;
  if (!(minWall > 0) || bands.length === 0) return null;
  const mySeams = [...males, ...sockets];
  if (mySeams.length === 0) return null;
  const reach = Math.max(box.x1 - box.x0, box.y1 - box.y0) + 4 * SLIVER_BAND_MM;
  // Every band this tile is cut by, sectioned once. They are NOT re-derived
  // between passes: what changes between passes is the cutter, and it is
  // subtracted from the same sections.
  const locals: Array<{ band: BandSlice; section: CrossSection }> = [];
  for (const band of bands) {
    if (!mySeams.some((seam) => seam.axis === band.axis && seam.planeMm === band.at)) continue;
    const section = tileBandSection(ctx, band, males, sockets, box);
    if (section !== null) locals.push({ band, section });
  }

  // The passes are CUMULATIVE across bands, and they have to be. The cutter is
  // one prism through the whole model, so a shape found at one height is
  // removed at every height, and the material it leaves behind at ANOTHER
  // height is where the next thin edge appears. A pass that only re-checked
  // its own height's findings left two 0.2 mm nubs on the Chicago tiles that
  // the reference validator then failed the file on.
  const found: CrossSection[] = [];
  let cutSoFar: CrossSection | null = null;
  for (let pass = 0; pass < SLIVER_PASSES; pass += 1) {
    const fresh: CrossSection[] = [];
    for (const { band, section } of locals) {
      const current = cutSoFar === null ? section : subtractSection(arena, section, cutSoFar);
      if (current === null) continue;
      const thin = thinPart(ctx, current, minWall);
      if (current !== section) arena.drop(current);
      if (thin === null) continue;
      // The band's own two edges are not model boundaries, so material that
      // reads thin only because the band clipped it is not thin at all.
      const inner = clipToBand(ctx, thin, band, SLIVER_BAND_MM - minWall, reach);
      arena.drop(thin);
      if (inner === null) continue;
      if (inner.area() < SLIVER_MIN_AREA_MM2) {
        arena.drop(inner);
        continue;
      }
      fresh.push(inner);
    }
    if (fresh.length === 0) break;
    found.push(...fresh);
    if (pass + 1 >= SLIVER_PASSES) break;
    const merged2d = unionSections(wasm, arena, cutSoFar === null ? fresh : [cutSoFar, ...fresh]);
    if (merged2d === null) break;
    cutSoFar = merged2d;
  }
  for (const { section } of locals) arena.drop(section);
  if (found.length === 0) return null;
  const all = unionSections(wasm, arena, found);
  // Deburred and vertex-cleaned before it is extruded, for the reason
  // `manifold.cleanSection` exists: a chain of 2D booleans leaves pinch points
  // and near-duplicate vertices on an outline, each of which extrudes into a
  // zero-area side triangle and then propagates into the subtraction.
  const lean = all === null ? null : cleanSection(arena, all);
  const cutter = lean === null ? null : extrudeSection(wasm, arena, lean, zLo, zHi);
  for (const part of found) {
    if (part !== all && part !== lean) arena.drop(part);
  }
  if (all !== null && all !== lean) arena.drop(all);
  if (lean !== null) arena.drop(lean);
  return cutter;
}

/**
 * One tile's own cross-section inside a band, in plan.
 *
 * Exactly what `tileSolid` builds in 3D, expressed on a slice: the model
 * clipped to the tile's four edges, plus the male keys this tile carries (the
 * key material is the model's own, so it is the band intersected with the key's
 * plan shape), minus the sockets cut into it. Null when the tile has nothing in
 * this band.
 *
 * A pin joint has no plan shape - its key is a cylinder lying on its side - and
 * contributes nothing here. That is the honest answer rather than an
 * approximation: a pin lies buried in the base slab and takes material from
 * nowhere near a wall, so it creates no slivers to find.
 */
function tileBandSection(
  ctx: BakeContext,
  band: BandSlice,
  males: readonly Seam[],
  sockets: readonly Seam[],
  box: TileBox,
): CrossSection | null {
  const { arena } = ctx;
  const rect = rectContour(box.x0, box.y0, box.x1, box.y1);
  const clip = sectionOf(ctx.wasm, arena, [rect]);
  if (clip === null) return null;
  let local = intersectSection(arena, band.section, clip);
  arena.drop(clip);
  if (local === null) return null;

  for (const seam of males) {
    if (seam.keySection === null) continue;
    const part = intersectSection(arena, band.section, seam.keySection);
    if (part === null) continue;
    const joined = unionSections(ctx.wasm, arena, [local, part]);
    if (part !== joined) arena.drop(part);
    if (joined !== null && joined !== local) {
      arena.drop(local);
      local = joined;
    }
  }
  for (const seam of sockets) {
    if (seam.socketSection === null) continue;
    const carved = subtractSection(arena, local, seam.socketSection);
    if (carved !== local) arena.drop(local);
    if (carved === null) return null;
    local = carved;
  }
  return local;
}

/** `section` clipped to a strip of half-width `halfMm` about a cut line. */
function clipToBand(
  ctx: BakeContext,
  section: CrossSection,
  plane: { axis: 0 | 1; at: number },
  halfMm: number,
  reachMm: number,
): CrossSection | null {
  if (!(halfMm > 0)) return null;
  const lo = plane.at - halfMm;
  const hi = plane.at + halfMm;
  const rect =
    plane.axis === 0
      ? rectContour(lo, -reachMm, hi, reachMm)
      : rectContour(-reachMm, lo, reachMm, hi);
  const clip = sectionOf(ctx.wasm, ctx.arena, [rect]);
  if (clip === null) return null;
  const out = intersectSection(ctx.arena, section, clip);
  ctx.arena.drop(clip);
  return out;
}

/**
 * The material in a band that the minimum-wall rule would fail, or null.
 *
 * This asks EXACTLY the question the reference validator asks and no more,
 * which took three wrong answers to arrive at. The rule is `checks.min_wall`:
 * a region fails when no disc of a full minimum wall fits inside it, lowered by
 * the width of every APPENDAGE an opening leaves hanging off it
 * (`measure.narrowestWidthMm`, DECISIONS `[V3-P3-G16]`). So the appendages come
 * from `repair.residueParts` - the same function the Stage 1 repair widens
 * wings with, so the removal and the repair cannot disagree about what a wing
 * is - and each one is kept only if a full wall really does not fit in it.
 *
 * What it must NOT do, and what the two earlier versions did:
 *
 * * `section - opening(section)` marks every CORNER of every building in the
 *   band, because a disc cannot reach into a right angle. That is not a thin
 *   wall, it is the shape of a building, and shaving them off removed 2 000 mm3
 *   of the Chicago plate and left razor edges measuring 0.004 mm behind.
 * * An opening built from POLYGONAL discs does not reproduce a straight edge, so
 *   the same difference also carries a hairline fringe along every edge in the
 *   band - tens of thousands of strips a few nanometres wide, 57 000 degenerate
 *   faces once they had been subtracted. `residueParts` offsets with MITRE
 *   joins, which are exact on straight edges, and applies an area floor of
 *   `0.25 * min_detail^2` on top.
 */
function thinPart(
  ctx: BakeContext,
  section: CrossSection,
  minWallMm: number,
): CrossSection | null {
  const { arena } = ctx;
  const minDetail = ctx.thresholdsMm.minDetail;
  const areaFloor = RESIDUE_AREA_RATIO * minDetail * minDetail;
  const components = arena.keepAll(section.decompose());
  const thin: CrossSection[] = [];
  for (const component of components) {
    if (component.area() < SLIVER_MIN_AREA_MM2) {
      arena.drop(component);
      continue;
    }
    // A whole island the cut left behind: no disc of a full wall fits anywhere
    // in it, so all of it goes. This is the case the appendage rule below
    // CANNOT see - a fin sheared off a tower is its own region in the slice,
    // and at 0.027 mm2 it is under the residue noise floor the repair uses.
    if (holdsNoDisc(component, minWallMm)) {
      thin.push(component);
      continue;
    }
    // Otherwise the island itself is printable and only its wings are not:
    // the base slab of a whole tile measures 0.118 mm by the validator's rule
    // because of one rind of plate along the seam, and removing the slab would
    // be an absurd answer to that. `residueParts` is the same function the
    // Stage 1 repair widens wings with, so the two cannot disagree about what
    // a wing is.
    const parts = residueParts(ctx, component, MIN_WALL_PROBE_FACTOR * minWallMm, areaFloor);
    arena.drop(component);
    if (parts === null) continue;
    for (const part of parts) {
      if (holdsNoDisc(part, minWallMm)) thin.push(part);
      else arena.drop(part);
    }
  }
  if (thin.length === 0) return null;
  const all = unionSections(ctx.wasm, arena, thin);
  for (const part of thin) {
    if (part !== all) arena.drop(part);
  }
  if (all === null) return null;
  // GROWN, and deliberately not clipped back to the section. Clipping it would
  // put the cutter's wall exactly on the model's wall wherever the sliver
  // reached the surface, and a boolean across a coincident face is what leaves
  // zero-area triangles - 2 523 of them, measured, when this line did clip.
  // Grown past the model's own surface instead, every face of the cutter
  // crosses it transversally: outward into the void where the sliver's edge was
  // the tile's own cut face, inward into solid material where it bordered the
  // part that is thick enough to keep. MITRE, not ROUND: a round join puts an
  // arc of vertices on every corner of every blob, and this cutter is
  // subtracted from a mesh that already has 100 000 triangles.
  const grown = all.offset(SLIVER_GROW_MM, MITRE, 2, 0);
  arena.drop(all);
  if (grown.isEmpty() || grown.area() < SLIVER_MIN_AREA_MM2) {
    grown.delete();
    return null;
  }
  return arena.keep(grown);
}

/**
 * True when no disc of `minWallMm` fits anywhere inside `section`.
 *
 * The exact predicate behind `measure.inscribedWidthMm(section) < minWall`, in
 * one erosion instead of a binary search: a disc of diameter w fits exactly
 * when eroding by `w / 2` leaves something behind. 64 segments, because a
 * coarse polygon disc is measurably narrower across its flats than the circle
 * it stands for and this decides whether material is removed.
 */
function holdsNoDisc(section: CrossSection, minWallMm: number): boolean {
  const eroded = section.offset(-minWallMm / 2, ROUND, 2, OPENING_SEGMENTS);
  const empty = eroded.isEmpty();
  eroded.delete();
  return empty;
}

/**
 * One solid, cut to a tile and given its half of every joint.
 *
 * The clip is two half-space trims per axis rather than an intersection with a
 * box: `trimByPlane` is the kernel's own specialisation for exactly this and it
 * does not have to build the box or intersect against its four irrelevant
 * faces. Only INTERIOR edges are trimmed, so an edge tile is not cut at all on
 * the sides where it is already the boundary of the model.
 */
function tileSolid(
  ctx: BakeContext,
  source: Manifold,
  box: TileBox,
  males: readonly Seam[],
  sockets: readonly Seam[],
  indexCut: Manifold | null,
  slivers: Manifold | null,
): Manifold | null {
  const { wasm, arena } = ctx;
  const bounds = source.boundingBox();
  let clipped: Manifold = source;
  const trims: Array<[[number, number, number], number]> = [];
  if (box.x0 > bounds.min[0]) trims.push([[1, 0, 0], box.x0]);
  if (box.x1 < bounds.max[0]) trims.push([[-1, 0, 0], -box.x1]);
  if (box.y0 > bounds.min[1]) trims.push([[0, 1, 0], box.y0]);
  if (box.y1 < bounds.max[1]) trims.push([[0, -1, 0], -box.y1]);
  for (const [normal, offset] of trims) {
    const next = arena.keep(clipped.trimByPlane(normal, offset));
    if (clipped !== source) arena.drop(clipped);
    clipped = next;
    if (clipped.isEmpty()) {
      arena.drop(clipped);
      return null;
    }
  }
  if (clipped === source) {
    // A one-tile grid, or a solid that lies entirely inside this tile: it still
    // has to be a solid this function owns, because the caller frees it.
    clipped = arena.keep(source.translate([0, 0, 0]));
  }

  const keys: Manifold[] = [];
  for (const seam of males) {
    const key = maleKey(ctx, source, seam);
    if (key !== null) keys.push(key);
  }
  const joined = keys.length === 0 ? clipped : (batchedUnion(wasm, arena, [clipped, ...keys]) ?? clipped);
  if (joined !== clipped) arena.drop(clipped);
  for (const key of keys) arena.drop(key);

  const cutters: Manifold[] = sockets.map((seam) => seam.socket as Manifold);
  if (indexCut !== null) cutters.push(indexCut);
  if (slivers !== null) cutters.push(slivers);
  const carved = subtractSolids(wasm, arena, joined, cutters);
  if (carved !== joined) arena.drop(joined);
  if (carved.isEmpty()) {
    arena.drop(carved);
    return null;
  }
  return carved;
}

/**
 * The part of `source` that fills one seam's key, kept only where it is joined
 * to the tile that carries it.
 *
 * The second half matters: the key straddles the cut plane, so intersecting it
 * with a region can pick up material that lies entirely on the NEIGHBOUR's
 * side - a building that happens to stand under the key without reaching the
 * seam. Adding that to this tile would ship a loose lump of tower floating in
 * mid air, so a body whose bounding box never reaches back across the plane is
 * dropped.
 */
function maleKey(ctx: BakeContext, source: Manifold, seam: Seam): Manifold | null {
  const { wasm, arena } = ctx;
  if (seam.key === null) return null;
  const hit = arena.keep(wasm.Manifold.intersection([source, seam.key]));
  if (hit.isEmpty()) {
    arena.drop(hit);
    return null;
  }
  const bodies = arena.keepAll(hit.decompose());
  if (bodies.length <= 1) {
    arena.dropAll(bodies);
    const box = hit.boundingBox();
    if (box.min[seam.axis] >= seam.planeMm - 1e-9) {
      arena.drop(hit);
      return null;
    }
    return hit;
  }
  const attached = bodies.filter((body) => body.boundingBox().min[seam.axis] < seam.planeMm - 1e-9);
  const kept = attached.length === bodies.length ? hit : batchedUnion(wasm, arena, attached);
  arena.dropAll(bodies.filter((body) => body !== kept));
  if (kept !== hit) arena.drop(hit);
  return kept;
}

function mergeBbox(into: Bbox3 | null, add: Bbox3): Bbox3 {
  if (into === null) return { min: [...add.min], max: [...add.max] };
  for (let axis = 0; axis < 3; axis += 1) {
    into.min[axis] = Math.min(into.min[axis], add.min[axis]);
    into.max[axis] = Math.max(into.max[axis], add.max[axis]);
  }
  return into;
}

// ---------------------------------------------------------------------------
// The index mark
// ---------------------------------------------------------------------------

/**
 * "B2" cut into the underside of one tile, mirrored so it reads from below.
 *
 * The same machinery every other piece of text on this model goes through:
 * `transform.fit_text` sizes it, `previewText.glyphAreas` draws the glyphs from
 * the committed font assets, and `lettering.repairText` widens it to a full
 * minimum wall and refuses it if the result would not survive the nozzle. The
 * depth is the underside mark's own, floored by what the base can carry over
 * the deepest recess in it.
 */
function indexCutter(ctx: BakeContext, label: string, box: TileBox): Manifold | null {
  const asset = loadedGlyphFace(INDEX_MARK_FACE);
  if (asset === null) return null;
  const spanMm = Math.min(box.x1 - box.x0, box.y1 - box.y0);
  const depth = Math.min(
    INDEX_MARK_DEPTH_MM,
    ctx.params.base_thickness_mm - T.HANGER_MIN_ROOF_MM - deepestRecessMm(ctx),
  );
  if (!(depth > 0)) {
    addFinding(
      ctx,
      finding(
        "tile-index-refused",
        "info",
        "The tile index marks were not cut",
        `A ${INDEX_MARK_DEPTH_MM} mm pocket needs more base than this model has under its ` +
          "deepest recess. The tiles are unlabelled; the plate layout in the project file " +
          "still says which is which.",
      ),
    );
    return null;
  }
  const size = Math.min(INDEX_MARK_SIZE_MM, spanMm / 8);
  const fit = T.fit_text(
    INDEX_MARK_FACE,
    label,
    size,
    Math.max(size, spanMm / 2),
    size * 2,
    ctx.params,
    "tile index",
    "engrave",
  );
  if (fit.refused || fit.text.trim() === "") return null;

  const centreX = (box.x0 + box.x1) / 2;
  const centreY = (box.y0 + box.y1) / 2;
  const areas: PreviewArea[] = glyphAreas(asset, fit.text, fit.size_mm, 0).map((area) =>
    placeArea(area, {
      // Mirrored, so the pen runs right to left and the block ends at the anchor.
      anchor_x: centreX + fit.width_mm / 2 - fit.dilation_mm,
      anchor_y: centreY - (fit.ink_top_mm + fit.ink_bottom_mm) / 2,
      rotation_deg: 0,
      mirror_x: true,
    }),
  );
  const target = T.text_stroke_target_mm(ctx.params, "engrave");
  const repaired = repairText(ctx, areas, fit.dilation_mm, target, null);
  if (repaired === null) return null;
  if (repaired.starvedParts > 0) {
    ctx.arena.drop(repaired.section);
    addFinding(
      ctx,
      finding(
        "tile-index-refused",
        "info",
        "The tile index marks were not cut",
        `At ${fit.size_mm.toFixed(1)} mm the label strokes come out under ` +
          `${target.toFixed(2)} mm, which a ${ctx.params.nozzle_mm} mm nozzle would miss.`,
      ),
    );
    return null;
  }
  const cutter = extrudeSection(ctx.wasm, ctx.arena, repaired.section, -CUTTER_OVERSHOOT_MM, depth);
  ctx.arena.drop(repaired.section);
  return cutter;
}

/** Contours for one label, exposed so a test can measure what was cut. */
export function indexContours(
  asset: Parameters<typeof glyphAreas>[0],
  label: string,
  sizeMm: number,
): Contour[] {
  return contoursFromAreas(glyphAreas(asset, label, sizeMm, 0));
}
