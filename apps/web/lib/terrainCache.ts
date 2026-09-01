/**
 * The TERRAIN group's fetch cache: pure data, so the key derivation and the
 * eviction policy are unit-testable without a store or a network.
 *
 * Keyed by pin + radius + rotation + exaggeration + smoothing, per the phase 3
 * brief. Exaggeration and smoothing are included even though the raw DEM
 * sample only depends on the pin/radius/rotation of the crop, because
 * `lib/engine/terrain/tiles.ts`'s `fetchTerrainGrid` takes the whole
 * `PrintParams` and may fold smoothing (a blur over the fetched heightfield)
 * and/or exaggeration into the grid it returns; keying on both is the only
 * choice that cannot go stale if it does.
 */

import type { PrintParams } from "./contracts";
import type { TerrainGrid } from "./engine/types";

export interface TerrainCacheLocation {
  lat: number;
  lon: number;
  radius_m: number;
  rotation_deg: number;
}

/** ~1 m precision: finer than this pin never needs a fresh DEM fetch. */
const COORD_DECIMALS = 5;

export function terrainCacheKey(
  location: TerrainCacheLocation,
  params: Pick<PrintParams, "terrain_exaggeration" | "terrain">,
): string {
  const lat = location.lat.toFixed(COORD_DECIMALS);
  const lon = location.lon.toFixed(COORD_DECIMALS);
  const exaggeration = params.terrain_exaggeration ?? 1.0;
  const smoothing = params.terrain?.smoothing ?? 1;
  return [lat, lon, location.radius_m, location.rotation_deg, exaggeration, smoothing].join("|");
}

/** How many distinct terrain grids are kept before the oldest is evicted. */
export const TERRAIN_CACHE_LIMIT = 32;

/** A small in-memory, insertion-ordered cache. Never persisted: a fresh page load re-fetches. */
export class TerrainCache {
  private readonly map = new Map<string, TerrainGrid>();

  get(key: string): TerrainGrid | undefined {
    return this.map.get(key);
  }

  set(key: string, grid: TerrainGrid): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= TERRAIN_CACHE_LIMIT) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, grid);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

/** The one cache for this page's lifetime; `store/editor.ts` is the only reader/writer. */
export const terrainCache = new TerrainCache();
