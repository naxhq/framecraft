/**
 * The heightfield itself: decode, resample, smooth, normalise, sample.
 *
 * `tiles.ts` owns the network and the tile mosaic; this file owns every number
 * that comes out of it. Splitting them that way is what lets the whole grid
 * pipeline be tested without a fetch of any kind: `gridFromSampler` takes a
 * plain `(lon, lat) => metres` function, so a test can hand it an analytic
 * hill and assert on the grid it produces.
 *
 * Units, and they never change: `TerrainGrid.elevations` is METRES ABOVE THE
 * GRID MINIMUM, in scene ENU metres, with NO exaggeration applied. The
 * exaggeration is `transform.terrain_z_scale`, applied once, at the moment an
 * elevation becomes print millimetres (`[V3-P3-G1]`); keeping it out of the
 * grid is what lets the slider move without re-fetching a single tile.
 */

import type { PrintParams } from "../../contracts";
import type { TerrainGrid, TerrainSampler } from "../types";

/** Terrarium tiles are 256 x 256. */
export const TILE_SIZE = 256;

/**
 * Mapzen Terrarium decoding, from the format's own definition:
 *
 *     elevation = (R * 256 + G + B / 256) - 32768
 *
 * in metres. The blue channel is a 1/256 m fraction, so a decoded tile is
 * accurate to about four millimetres, far below anything a 1:10000 model can
 * show.
 */
export function terrariumElevationM(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Decode a whole RGBA tile into a `TILE_SIZE^2` elevation grid, metres. */
export function decodeTerrariumTile(rgba: Uint8Array, size = TILE_SIZE): Float32Array {
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i += 1) {
    const at = i * 4;
    out[i] = terrariumElevationM(rgba[at], rgba[at + 1], rgba[at + 2]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grid construction
// ---------------------------------------------------------------------------

/**
 * Largest grid this engine will build, samples per side.
 *
 * 257 x 257 is 66 049 samples: a quarter of a megabyte as float32, and finer
 * than `TERRAIN_CELL_MM` refines any solid to at every plate size the contract
 * allows, so a finer grid could not change a single printed vertex. It also
 * bounds the work: the drape evaluates the sampler once per refined vertex,
 * not once per grid cell, so the grid's only cost is the resample.
 */
export const MAX_GRID_SAMPLES = 257;

/** Smallest grid worth building; below this bilinear interpolation is a plane. */
export const MIN_GRID_SAMPLES = 8;

/**
 * Samples per side for a crop of `2 * radiusM` at a data resolution of
 * `cellM` metres, clamped to the two bounds above.
 */
export function gridSamplesFor(radiusM: number, cellM: number): number {
  if (!(radiusM > 0) || !(cellM > 0)) return MIN_GRID_SAMPLES;
  const wanted = Math.ceil((2 * radiusM) / cellM) + 1;
  return Math.max(MIN_GRID_SAMPLES, Math.min(MAX_GRID_SAMPLES, wanted));
}

/**
 * Build a `TerrainGrid` over the crop square by sampling `elevationAt`.
 *
 * The grid is axis-aligned in SCENE metres - the frame the SceneGraph and
 * every solid already live in - and `toLonLat` is what turns a scene point
 * back into a geographic one, so the rotation lives in exactly one place (the
 * `LocalFrame` the caller built) and this function never sees an angle.
 *
 * Elevations come back normalised to metres above the grid minimum, which is
 * what puts the lowest point of the crop flush with the base top and keeps the
 * base slab at full thickness under it.
 */
export function gridFromSampler(
  radiusM: number,
  samples: number,
  toLonLat: (eastM: number, northM: number) => readonly [number, number],
  elevationAt: (lon: number, lat: number) => number,
  source: string,
): TerrainGrid | null {
  if (!(radiusM > 0) || samples < 2) return null;
  const cellM = (2 * radiusM) / (samples - 1);
  const elevations = new Float32Array(samples * samples);
  let min = Infinity;
  let max = -Infinity;
  for (let r = 0; r < samples; r += 1) {
    const north = -radiusM + r * cellM;
    for (let c = 0; c < samples; c += 1) {
      const east = -radiusM + c * cellM;
      const [lon, lat] = toLonLat(east, north);
      const elevation = elevationAt(lon, lat);
      if (!Number.isFinite(elevation)) return null;
      const at = r * samples + c;
      elevations[at] = elevation;
      // Read the value BACK out: the array is float32, and tracking the double
      // that went in would leave a minimum the array does not contain, so the
      // normalisation below would miss zero by a float32 step (measured:
      // 2.3e-5 m). The base slab's thickness under the lowest point of the crop
      // depends on that being exactly zero.
      const stored = elevations[at];
      if (stored < min) min = stored;
      if (stored > max) max = stored;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  for (let i = 0; i < elevations.length; i += 1) elevations[i] -= min;
  return {
    originEastM: -radiusM,
    originNorthM: -radiusM,
    cellM,
    cols: samples,
    rows: samples,
    elevations,
    rangeM: max - min,
    source,
  };
}

/**
 * `params.terrain.smoothing` box-blur passes over the grid, in place on a copy.
 *
 * A 3 x 3 box blur, repeated: three passes of a box approximate a Gaussian
 * closely enough that nothing downstream can tell, and each pass is two
 * separable sweeps, so five passes over the largest grid is under a
 * millisecond. Edges clamp rather than wrap, so the crop boundary keeps its own
 * elevation instead of borrowing the far side's.
 *
 * The result is re-normalised: blurring a valley floor lifts it, and the base
 * slab has to stay at full thickness under the lowest point of the model.
 */
export function smoothGrid(grid: TerrainGrid, passes: number): TerrainGrid {
  const rounds = Math.max(0, Math.min(5, Math.round(passes)));
  if (rounds === 0) return grid;
  const { cols, rows } = grid;
  const current = Float32Array.from(grid.elevations);
  let scratch = new Float32Array(current.length);
  for (let pass = 0; pass < rounds; pass += 1) {
    // Horizontal, then vertical: a separable 1 x 3 / 3 x 1 pair is the same
    // kernel as the 3 x 3 box and costs a third of the reads.
    for (let r = 0; r < rows; r += 1) {
      const row = r * cols;
      for (let c = 0; c < cols; c += 1) {
        const left = current[row + Math.max(0, c - 1)];
        const middle = current[row + c];
        const right = current[row + Math.min(cols - 1, c + 1)];
        scratch[row + c] = (left + middle + right) / 3;
      }
    }
    for (let c = 0; c < cols; c += 1) {
      for (let r = 0; r < rows; r += 1) {
        const up = scratch[Math.max(0, r - 1) * cols + c];
        const middle = scratch[r * cols + c];
        const down = scratch[Math.min(rows - 1, r + 1) * cols + c];
        current[r * cols + c] = (up + middle + down) / 3;
      }
    }
    scratch = new Float32Array(current.length);
  }

  let min = Infinity;
  let max = -Infinity;
  for (const value of current) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min)) return grid;
  for (let i = 0; i < current.length; i += 1) current[i] -= min;
  return { ...grid, elevations: current, rangeM: max - min };
}

/** `params.terrain.smoothing`, defaulting to the contract's 1. */
export function smoothingPasses(params: PrintParams): number {
  return params.terrain?.smoothing ?? 1;
}

/** True when `params.terrain.enabled` asks for a heightfield at all. */
export function terrainEnabled(params: PrintParams): boolean {
  return params.terrain?.enabled === true;
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/**
 * The bilinear sampler over a grid, in scene metres.
 *
 * Outside the grid it clamps to the edge value rather than falling to zero: a
 * vertex a hair past the crop square (a road ribbon's cap, a widened wing) must
 * land on the same surface as the one beside it, and a fall to zero there would
 * be a cliff at the boundary rather than a continuation of the hillside.
 *
 * `engine.ts` holds the identical function for the solids it builds; this one
 * exists so the terrain module can be tested, and so the preview can share it.
 * They are asserted equal in `terrain/heightfield.test.ts`.
 */
export function samplerFromGrid(grid: TerrainGrid | null | undefined): TerrainSampler | null {
  if (!grid) return null;
  const { originEastM, originNorthM, cellM, cols, rows, elevations } = grid;
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  const at = (c: number, r: number): number =>
    elevations[clamp(r, 0, rows - 1) * cols + clamp(c, 0, cols - 1)];
  return {
    rangeM: grid.rangeM,
    sampleM(x: number, y: number): number {
      const gx = (x - originEastM) / cellM;
      const gy = (y - originNorthM) / cellM;
      const c0 = Math.floor(gx);
      const r0 = Math.floor(gy);
      const fx = clamp(gx - c0, 0, 1);
      const fy = clamp(gy - r0, 0, 1);
      const v00 = at(c0, r0);
      const v10 = at(c0 + 1, r0);
      const v01 = at(c0, r0 + 1);
      const v11 = at(c0 + 1, r0 + 1);
      return (
        v00 * (1 - fx) * (1 - fy) +
        v10 * fx * (1 - fy) +
        v01 * (1 - fx) * fy +
        v11 * fx * fy
      );
    },
  };
}
