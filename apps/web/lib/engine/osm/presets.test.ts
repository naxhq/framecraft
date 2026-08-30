import { describe, expect, it } from "vitest";
import { PRESET_CITY_NAMES } from "../../presets";
import { ENGINE_PRESETS, getEnginePreset, presetRequests, PRESET_RADIUS_M } from "./presets";

// Ported from services/bake/tests/test_ingest.py's
// test_six_presets_have_the_specified_centers.
const EXPECTED = [
  ["chicago-loop", 41.8827, -87.6233, 0.0],
  ["new-york-midtown", 40.7549, -73.984, 29.0],
  ["paris-eiffel", 48.8584, 2.2945, 0.0],
  ["tokyo-shinjuku", 35.6896, 139.7006, 0.0],
  ["london-city", 51.5155, -0.0922, 0.0],
  ["san-francisco-fidi", 37.7946, -122.3999, 0.0],
] as const;

describe("ENGINE_PRESETS", () => {
  it("matches the six frozen preset centers and rotations", () => {
    expect(ENGINE_PRESETS.map((p) => [p.id, p.lat, p.lon, p.rotationDeg])).toEqual(
      EXPECTED.map(([id, lat, lon, rot]) => [id, lat, lon, rot]),
    );
  });

  it("uses the frozen 900 m radius for every preset", () => {
    expect(PRESET_RADIUS_M).toBe(900.0);
    for (const p of ENGINE_PRESETS) expect(p.radiusM).toBe(900.0);
  });

  it("cityName matches lib/presets.ts's PRESET_CITY_NAMES exactly (single source, not duplicated)", () => {
    for (const p of ENGINE_PRESETS) {
      expect(p.cityName).toBe(PRESET_CITY_NAMES[p.id]);
    }
  });

  it("presetRequests() returns six SceneRequest-shaped objects with preset_id set", () => {
    const requests = presetRequests();
    expect(requests).toHaveLength(6);
    for (const r of requests) {
      expect(typeof r.lat).toBe("number");
      expect(typeof r.lon).toBe("number");
      expect(r.radius_m).toBe(900.0);
      expect(r.preset_id).not.toBeNull();
    }
  });

  it("getEnginePreset resolves a known id and returns null for an unknown one", () => {
    expect(getEnginePreset("chicago-loop")?.lat).toBe(41.8827);
    expect(getEnginePreset("nowhere")).toBeNull();
  });
});
