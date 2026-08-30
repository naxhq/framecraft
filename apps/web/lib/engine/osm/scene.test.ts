import { describe, expect, it, vi } from "vitest";
import type { SceneRequest } from "../../contracts";
import type { OverpassResponse } from "./normalize";
import { MemoryOverpassCache } from "./overpass";
import { buildScene, sceneFromOverpass } from "./scene";

const REQUEST: SceneRequest = { lat: 41.8827, lon: -87.6233, radius_m: 900.0, rotation_deg: 0.0, preset_id: "chicago-loop" };

const MINIMAL_RAW: OverpassResponse = {
  elements: [
    {
      type: "way",
      id: 1,
      tags: { building: "yes" },
      geometry: [
        { lat: 41.883, lon: -87.6234 },
        { lat: 41.883, lon: -87.6232 },
        { lat: 41.8832, lon: -87.6232 },
        { lat: 41.8832, lon: -87.6234 },
        { lat: 41.883, lon: -87.6234 },
      ],
    },
  ],
};

describe("sceneFromOverpass (pure)", () => {
  it("produces a SceneGraph-shaped object with the request's bounds/center", () => {
    const scene = sceneFromOverpass(MINIMAL_RAW, REQUEST);
    expect(scene.bounds).toEqual({ min_x: -900, min_y: -900, max_x: 900, max_y: 900 });
    expect(scene.center).toEqual({ lat: 41.8827, lon: -87.6233 });
    expect(scene.buildings).toHaveLength(1);
  });

  it("is deterministic (same input, same output) and never touches the network", () => {
    const a = sceneFromOverpass(MINIMAL_RAW, REQUEST);
    const b = sceneFromOverpass(MINIMAL_RAW, REQUEST);
    expect(a).toEqual(b);
  });

  it("a v3 heights override changes height inference deterministically", () => {
    const scene = sceneFromOverpass(MINIMAL_RAW, REQUEST, {
      schema_version: 3,
      plate_mm: 180,
      base_thickness_mm: 3,
      nozzle_mm: 0.4,
      small_scale: 1,
      large_scale: 1,
      terrain_exaggeration: 1,
      road_mode: "engrave",
      road_scale: 1,
      trees: true,
      water: true,
      frame: true,
      heights: { unknown_default_m: 50 },
    });
    expect(scene.buildings[0].height_m).toBeGreaterThan(40);
  });
});

describe("buildScene (network, fail soft)", () => {
  it("fetches, caches, and normalises in one call", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(MINIMAL_RAW), { status: 200 }));
    const result = await buildScene(REQUEST, undefined, { fetchImpl, cache: new MemoryOverpassCache(), sleep: async () => {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scene.buildings).toHaveLength(1);
      expect(result.fromCache).toBe(false);
    }
  });

  it("fails soft with a typed error on total network failure, never throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network down");
    });
    const result = await buildScene(REQUEST, undefined, { fetchImpl, cache: new MemoryOverpassCache(), sleep: async () => {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("network");
  });
});
