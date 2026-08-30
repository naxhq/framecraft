/**
 * The six MVP preset cities (01 "Preset cities for the MVP"), ported from
 * `services/bake/app/ingest/presets.py` so the browser engine no longer needs
 * `GET /presets`. Ids, centers, radius and rotation are frozen by
 * DECISIONS.md [P1]; `cityName` matches `lib/presets.ts`'s
 * `PRESET_CITY_NAMES` (imported, not duplicated, so the two cannot drift).
 */
import type { SceneRequest } from "../../contracts";
import { PRESET_CITY_NAMES } from "../../presets";

export const PRESET_RADIUS_M = 900.0;

export interface EnginePreset {
  id: string;
  label: string;
  cityName: string;
  lat: number;
  lon: number;
  radiusM: number;
  rotationDeg: number;
}

export const ENGINE_PRESETS: readonly EnginePreset[] = [
  { id: "chicago-loop", label: "Chicago — Loop", cityName: PRESET_CITY_NAMES["chicago-loop"], lat: 41.8827, lon: -87.6233, radiusM: PRESET_RADIUS_M, rotationDeg: 0.0 },
  { id: "new-york-midtown", label: "New York — Midtown", cityName: PRESET_CITY_NAMES["new-york-midtown"], lat: 40.7549, lon: -73.9840, radiusM: PRESET_RADIUS_M, rotationDeg: 29.0 },
  { id: "paris-eiffel", label: "Paris — Tour Eiffel", cityName: PRESET_CITY_NAMES["paris-eiffel"], lat: 48.8584, lon: 2.2945, radiusM: PRESET_RADIUS_M, rotationDeg: 0.0 },
  { id: "tokyo-shinjuku", label: "Tokyo — Shinjuku", cityName: PRESET_CITY_NAMES["tokyo-shinjuku"], lat: 35.6896, lon: 139.7006, radiusM: PRESET_RADIUS_M, rotationDeg: 0.0 },
  { id: "london-city", label: "London — City", cityName: PRESET_CITY_NAMES["london-city"], lat: 51.5155, lon: -0.0922, radiusM: PRESET_RADIUS_M, rotationDeg: 0.0 },
  { id: "san-francisco-fidi", label: "San Francisco — Financial District", cityName: PRESET_CITY_NAMES["san-francisco-fidi"], lat: 37.7946, lon: -122.3999, radiusM: PRESET_RADIUS_M, rotationDeg: 0.0 },
];

export const ENGINE_PRESETS_BY_ID: Readonly<Record<string, EnginePreset>> = Object.fromEntries(
  ENGINE_PRESETS.map((p) => [p.id, p]),
);

export function presetRequest(preset: EnginePreset): SceneRequest {
  return {
    lat: preset.lat,
    lon: preset.lon,
    radius_m: preset.radiusM,
    rotation_deg: preset.rotationDeg,
    preset_id: preset.id,
  };
}

/** The six preset `SceneRequest`s, the engine-side equivalent of `GET /presets`. */
export function presetRequests(): SceneRequest[] {
  return ENGINE_PRESETS.map(presetRequest);
}

export function getEnginePreset(presetId: string): EnginePreset | null {
  return ENGINE_PRESETS_BY_ID[presetId] ?? null;
}
