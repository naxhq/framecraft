import { describe, expect, it } from "vitest";

import { defaultPrintParams } from "./contracts";
import type { TerrainGrid } from "./engine/types";
import { TERRAIN_CACHE_LIMIT, TerrainCache, terrainCacheKey } from "./terrainCache";

function grid(rangeM: number): TerrainGrid {
  return {
    originEastM: 0,
    originNorthM: 0,
    cellM: 10,
    cols: 2,
    rows: 2,
    elevations: new Float32Array([0, 0, 0, 0]),
    rangeM,
    source: "test",
  };
}

describe("terrainCacheKey", () => {
  it("is identical for the same pin, radius, rotation, exaggeration and smoothing", () => {
    const location = { lat: 41.8827, lon: -87.6233, radius_m: 900, rotation_deg: 0 };
    const params = defaultPrintParams();
    expect(terrainCacheKey(location, params)).toBe(terrainCacheKey(location, params));
  });

  it("changes when the pin moves", () => {
    const params = defaultPrintParams();
    const a = terrainCacheKey({ lat: 41.8827, lon: -87.6233, radius_m: 900, rotation_deg: 0 }, params);
    const b = terrainCacheKey({ lat: 41.9, lon: -87.6233, radius_m: 900, rotation_deg: 0 }, params);
    expect(a).not.toBe(b);
  });

  it("changes with radius and rotation", () => {
    const params = defaultPrintParams();
    const base = { lat: 41.8827, lon: -87.6233, radius_m: 900, rotation_deg: 0 };
    expect(terrainCacheKey(base, params)).not.toBe(
      terrainCacheKey({ ...base, radius_m: 1200 }, params),
    );
    expect(terrainCacheKey(base, params)).not.toBe(
      terrainCacheKey({ ...base, rotation_deg: 45 }, params),
    );
  });

  it("changes with exaggeration and smoothing", () => {
    const location = { lat: 41.8827, lon: -87.6233, radius_m: 900, rotation_deg: 0 };
    const a = defaultPrintParams();
    const b = defaultPrintParams();
    b.terrain_exaggeration = 2.0;
    expect(terrainCacheKey(location, a)).not.toBe(terrainCacheKey(location, b));

    const c = defaultPrintParams();
    c.terrain = { ...c.terrain, smoothing: 4 };
    expect(terrainCacheKey(location, a)).not.toBe(terrainCacheKey(location, c));
  });

  it("is insensitive to sub-metre pin jitter", () => {
    const params = defaultPrintParams();
    const a = terrainCacheKey({ lat: 41.882700001, lon: -87.6233, radius_m: 900, rotation_deg: 0 }, params);
    const b = terrainCacheKey({ lat: 41.882700002, lon: -87.6233, radius_m: 900, rotation_deg: 0 }, params);
    expect(a).toBe(b);
  });
});

describe("TerrainCache", () => {
  it("round-trips a grid by key", () => {
    const cache = new TerrainCache();
    cache.set("k1", grid(10));
    expect(cache.get("k1")?.rangeM).toBe(10);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("re-inserting a key does not grow the cache", () => {
    const cache = new TerrainCache();
    cache.set("k1", grid(1));
    cache.set("k1", grid(2));
    expect(cache.size).toBe(1);
    expect(cache.get("k1")?.rangeM).toBe(2);
  });

  it("evicts the oldest entry once the limit is reached", () => {
    const cache = new TerrainCache();
    for (let i = 0; i < TERRAIN_CACHE_LIMIT; i += 1) cache.set(`k${i}`, grid(i));
    expect(cache.size).toBe(TERRAIN_CACHE_LIMIT);
    cache.set("new", grid(999));
    expect(cache.size).toBe(TERRAIN_CACHE_LIMIT);
    expect(cache.get("k0")).toBeUndefined();
    expect(cache.get("new")?.rangeM).toBe(999);
  });

  it("clears everything", () => {
    const cache = new TerrainCache();
    cache.set("k1", grid(1));
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
