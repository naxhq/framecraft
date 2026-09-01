/**
 * Mapzen Terrarium elevation tiles: the DEM behind `params.terrain`.
 *
 * `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`
 * is keyless, CORS-open and public domain, and its licence names SRTM, NED,
 * NRCAN and the other national datasets that make it up. It is not OSM, and
 * CLAUDE.md's "OSM only" rule is about MAP data (buildings, roads, tiles under
 * the picker) - elevation has no OSM source at all, so this is an addition to
 * the attribution list, not a substitution (`[V3-P3-G2]`). Callers must credit
 * it; `TerrainGrid.source` carries the string.
 *
 * Everything in this module fails SOFT. A DEM that does not answer is a model
 * without a hill in it, never a bake that does not happen, so
 * `fetchTerrainGrid` returns `null` for a refused fetch, a 404, a truncated
 * body, a PNG this decoder does not read, or a scene with no radius. The only
 * thing it does not swallow is a caller bug (a negative radius is still null,
 * not an exception, because the UI passes user input straight in).
 */

import type { PrintParams } from "../../contracts";
import { LocalFrame } from "../osm/project";
import type { TerrainGrid } from "../types";
import {
  MAX_GRID_SAMPLES,
  TILE_SIZE,
  decodeTerrariumTile,
  gridFromSampler,
  gridSamplesFor,
  smoothGrid,
  smoothingPasses,
  terrainEnabled,
} from "./heightfield";
import { decodePng } from "./png";

/** Where the tiles come from. Public domain, keyless, CORS-open. */
export const TERRARIUM_URL_TEMPLATE =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

/** The credit line the export and the UI have to carry for this data. */
export const TERRARIUM_SOURCE =
  "Elevation: Mapzen Terrarium tiles (AWS Open Data), public domain";

/** Zoom levels this fetcher will consider, in order. */
export const MIN_ZOOM = 12;
export const MAX_ZOOM = 14;

/**
 * The coarsest ground sample the drape is allowed to work from, metres.
 *
 * 30 m is one SRTM post, which is the real resolution of the underlying data
 * over most of the world; asking for finer than the source has only resamples
 * the same numbers. It is an upper bound, not a target: a small crop gets a
 * finer zoom through `TARGET_SAMPLES_ACROSS` below.
 */
export const TARGET_SAMPLE_M = 30;

/**
 * Samples the fetcher tries to put across the crop before it settles for
 * `TARGET_SAMPLE_M`.
 *
 * A 250 m radius at 30 m per sample is seventeen samples across the whole
 * plate, which prints as facets rather than as terrain. Asking for 64 pushes a
 * small crop up to z14 (7 m per sample at mid latitude) where the data
 * genuinely has more to give.
 */
export const TARGET_SAMPLES_ACROSS = 64;

/** Metres per Web Mercator pixel at zoom `z` and latitude `lat`. */
export function metresPerPixel(zoom: number, lat: number): number {
  const equator = 156543.03392804097; // 2 * pi * 6378137 / 256
  return (equator * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/**
 * The zoom to fetch: the coarsest one in [12, 14] whose pixels are at least as
 * fine as the crop asks for, so a big city is not 400 tiles and a small one is
 * still smooth.
 */
export function zoomFor(radiusM: number, lat: number): number {
  const wanted = Math.min(TARGET_SAMPLE_M, (2 * radiusM) / TARGET_SAMPLES_ACROSS);
  for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom += 1) {
    if (metresPerPixel(zoom, lat) <= wanted) return zoom;
  }
  return MAX_ZOOM;
}

/** Web Mercator tile column for a longitude, as a float. */
export function tileXFor(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * 2 ** zoom;
}

/** Web Mercator tile row for a latitude, as a float. Clamped to the projection. */
export function tileYFor(lat: number, zoom: number): number {
  const clamped = Math.max(-85.0511287798, Math.min(85.0511287798, lat));
  const phi = (clamped * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2;
  return y * 2 ** zoom;
}

/** The URL for one tile. */
export function tileUrl(zoom: number, x: number, y: number): string {
  return TERRARIUM_URL_TEMPLATE.replace("{z}", String(zoom))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}

/**
 * Most tiles one grid may pull.
 *
 * A guard, not a policy: at the zooms above, a legal radius needs at most a
 * handful, and a number in the hundreds means the zoom rule has a bug or a
 * caller passed a radius in the wrong unit. Better a flat model than a
 * thousand requests.
 */
export const MAX_TILES = 36;

/** One decoded tile, keyed by its own coordinates. */
interface Tile {
  x: number;
  y: number;
  elevations: Float32Array;
}

/**
 * Decode a PNG body to RGBA.
 *
 * The browser has a hardware decoder behind `createImageBitmap`; Node has
 * neither it nor a canvas, and every engine test, the bake CLI and
 * `make validate` run in Node. `png.ts` is the fallback, and it is the path the
 * tests exercise, so the Node path is the one that is actually pinned.
 */
async function decodeToRgba(
  bytes: Uint8Array,
): Promise<{ width: number; height: number; data: Uint8Array }> {
  const hasBitmap =
    typeof createImageBitmap === "function" && typeof OffscreenCanvas === "function";
  if (hasBitmap) {
    const blob = new Blob([bytes.slice() as unknown as BlobPart], { type: "image/png" });
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("no 2d context for the elevation tile");
      context.drawImage(bitmap, 0, 0);
      const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
      return {
        width: bitmap.width,
        height: bitmap.height,
        data: new Uint8Array(image.data.buffer.slice(0)),
      };
    } finally {
      bitmap.close();
    }
  }
  return decodePng(bytes);
}

export interface TerrainRequest {
  lat: number;
  lon: number;
  radiusM: number;
  rotationDeg: number;
}

export interface TerrainOptions {
  fetch?: typeof fetch;
}

/**
 * Fetch the DEM for one scene and resample it into the engine's grid.
 *
 * `null` means "no terrain", for every reason there is: the parameter is off,
 * the radius is not a radius, the network refused, a tile came back as
 * something this decoder does not read, or the crop needs more tiles than
 * `MAX_TILES`. The caller draws and bakes a flat plate and says nothing, which
 * is the behaviour the whole pipeline had before terrain existed.
 *
 * What comes back is in SCENE metres (rotation already applied through
 * `LocalFrame`) and in raw metres above the crop's own minimum. The
 * exaggeration is applied later and exactly once, in
 * `transform.terrain_z_scale` (`[V3-P3-G1]`).
 */
export async function fetchTerrainGrid(
  request: TerrainRequest,
  params: PrintParams,
  opts: TerrainOptions = {},
): Promise<TerrainGrid | null> {
  if (!terrainEnabled(params)) return null;
  const { lat, lon, radiusM, rotationDeg } = request;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (!Number.isFinite(radiusM) || radiusM <= 0) return null;

  const doFetch = opts.fetch ?? (typeof fetch === "function" ? fetch : undefined);
  if (doFetch === undefined) return null;

  try {
    const frame = new LocalFrame(lat, lon, rotationDeg);
    const zoom = zoomFor(radiusM, lat);
    const cellM = metresPerPixel(zoom, lat);
    const samples = gridSamplesFor(radiusM, cellM);

    // Which tiles the crop touches. The crop is rotated, so its corners in
    // geographic space are not the corners of a lat/lon box: every corner of
    // the SCENE square is projected and the box is taken around all four.
    const corners: Array<readonly [number, number]> = [];
    for (const east of [-radiusM, radiusM]) {
      for (const north of [-radiusM, radiusM]) {
        corners.push(frame.pointToWgs84(east, north) as readonly [number, number]);
      }
    }
    let minTileX = Infinity;
    let maxTileX = -Infinity;
    let minTileY = Infinity;
    let maxTileY = -Infinity;
    for (const [cornerLon, cornerLat] of corners) {
      const tx = tileXFor(cornerLon, zoom);
      const ty = tileYFor(cornerLat, zoom);
      minTileX = Math.min(minTileX, Math.floor(tx));
      maxTileX = Math.max(maxTileX, Math.floor(tx));
      minTileY = Math.min(minTileY, Math.floor(ty));
      maxTileY = Math.max(maxTileY, Math.floor(ty));
    }
    const span = 2 ** zoom;
    const wanted: Array<[number, number]> = [];
    for (let ty = minTileY; ty <= maxTileY; ty += 1) {
      if (ty < 0 || ty >= span) continue;
      for (let tx = minTileX; tx <= maxTileX; tx += 1) {
        wanted.push([((tx % span) + span) % span, ty]);
      }
    }
    if (wanted.length === 0 || wanted.length > MAX_TILES) return null;

    const loaded = await Promise.all(
      wanted.map(async ([tx, ty]) => {
        const response = await doFetch(tileUrl(zoom, tx, ty));
        if (!response.ok) throw new Error(`elevation tile ${zoom}/${tx}/${ty} ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const image = await decodeToRgba(bytes);
        if (image.width !== TILE_SIZE || image.height !== TILE_SIZE) {
          throw new Error(`elevation tile ${zoom}/${tx}/${ty} is ${image.width}x${image.height}`);
        }
        return { x: tx, y: ty, elevations: decodeTerrariumTile(image.data, TILE_SIZE) };
      }),
    );

    const mosaic = new Map<string, Tile>();
    for (const tile of loaded) mosaic.set(`${tile.x}/${tile.y}`, tile);

    /**
     * Bilinear over the mosaic, in tile-pixel space, clamped at the mosaic's
     * own edge. A pixel that falls in a tile the fetch never asked for reuses
     * the nearest one it did, which only happens outside the crop.
     */
    const elevationAt = (sampleLon: number, sampleLat: number): number => {
      const px = tileXFor(sampleLon, zoom) * TILE_SIZE - 0.5;
      const py = tileYFor(sampleLat, zoom) * TILE_SIZE - 0.5;
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const fx = px - x0;
      const fy = py - y0;
      const read = (x: number, y: number): number => {
        const tx = ((Math.floor(x / TILE_SIZE) % span) + span) % span;
        const ty = Math.floor(y / TILE_SIZE);
        const tile =
          mosaic.get(`${tx}/${ty}`) ??
          mosaic.get(
            `${Math.min(Math.max(tx, minTileX), maxTileX)}/${Math.min(Math.max(ty, minTileY), maxTileY)}`,
          );
        if (tile === undefined) return NaN;
        const ix = Math.min(TILE_SIZE - 1, Math.max(0, x - tile.x * TILE_SIZE));
        const iy = Math.min(TILE_SIZE - 1, Math.max(0, y - tile.y * TILE_SIZE));
        return tile.elevations[iy * TILE_SIZE + ix];
      };
      const v00 = read(x0, y0);
      const v10 = read(x0 + 1, y0);
      const v01 = read(x0, y0 + 1);
      const v11 = read(x0 + 1, y0 + 1);
      return (
        v00 * (1 - fx) * (1 - fy) +
        v10 * fx * (1 - fy) +
        v01 * (1 - fx) * fy +
        v11 * fx * fy
      );
    };

    const raw = gridFromSampler(
      radiusM,
      Math.min(samples, MAX_GRID_SAMPLES),
      (east, north) => frame.pointToWgs84(east, north) as readonly [number, number],
      elevationAt,
      TERRARIUM_SOURCE,
    );
    if (raw === null) return null;
    return smoothGrid(raw, smoothingPasses(params));
  } catch {
    // Every failure is the same failure: no terrain, flat plate, no exception
    // out of a fetcher the UI calls on every parameter change.
    return null;
  }
}
