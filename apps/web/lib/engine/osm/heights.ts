/**
 * Tag parsing, height inference and road width/class (03 "Height inference",
 * "Road widths"). Direct port of `services/bake/app/ingest/normalize.py`'s
 * same-named functions; every constant, order of rules and rounding matches.
 *
 * v3 additions (contracts v3 `heights` group, `PARAM_RANGES.heights`):
 * `resolveHeightV3` takes the same four rules but reads the floor height,
 * per-type defaults and unknown-building default from `PrintParams.heights`
 * instead of the fixed 03 constants, so a v3 caller can retune them; a
 * default-constructed `PrintParams` (`heights.floor_height_m = 3.0`,
 * `unknown_default_m = 8.0`, the six `type_defaults`) reproduces the v1/v2
 * numbers for every OSM `building=*` value 03 names, and anything outside
 * that six-entry set (skyscraper, church, hospital, garages, shed, ...)
 * falls back to the same 03 `TYPE_DEFAULT_HEIGHT_M` table `resolveHeight`
 * uses, so a v3 heights override never regresses a v1 scene. [V3-P2-E1]
 */
import type { Heights } from "../../contracts";
import { sha1UnitInterval } from "./sha1";

export const LEVEL_HEIGHT_M = 3.2;
export const DEFAULT_HEIGHT_M = 8.0;
export const MIN_HEIGHT_M = 2.0;
export const MAX_HEIGHT_M = 600.0;
export const TALL_HEIGHT_M = 40.0;
const JITTER = 0.06;

export const TYPE_DEFAULT_HEIGHT_M: Record<string, number> = {
  skyscraper: 120.0,
  church: 25.0,
  cathedral: 25.0,
  hospital: 30.0,
  apartments: 18.0,
  commercial: 12.0,
  retail: 12.0,
  industrial: 10.0,
  house: 7.0,
  detached: 7.0,
  garage: 3.0,
  garages: 3.0,
  shed: 3.0,
};

export const HIGHWAY_WIDTH_M: Record<string, number> = {
  motorway: 24.0,
  trunk: 20.0,
  primary: 16.0,
  secondary: 12.0,
  tertiary: 10.0,
  residential: 8.0,
  unclassified: 8.0,
  service: 5.0,
  pedestrian: 6.0,
  footway: 3.0,
};

export const HIGHWAY_CLASS: Record<string, string> = {
  motorway: "motorway",
  trunk: "motorway",
  primary: "primary",
  secondary: "secondary",
  tertiary: "secondary",
  residential: "residential",
  unclassified: "residential",
  service: "service",
  pedestrian: "path",
  footway: "path",
};

const LANE_WIDTH_M = 3.5;
export const MIN_ROAD_WIDTH_M = 0.5;
export const MAX_ROAD_WIDTH_M = 60.0;

export const GREEN_LANDUSE = new Set(["grass", "forest", "meadow", "recreation_ground"]);
export const GREEN_LEISURE = new Set(["park", "garden", "pitch"]);

export const COVERAGE_GOOD_COUNT = 150;
export const COVERAGE_GOOD_AREA_FRACTION = 0.04;
export const COVERAGE_EMPTY_COUNT = 20;

const FEET_INCHES_RE = /^\s*(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*(?:"|''))?\s*$/;
const NUM_UNIT_RE = /^\s*([-+]?\d+(?:[.,]\d+)?)\s*(m|meter|meters|metre|metres|ft|feet|foot|cm|km|mm)?\s*$/i;
const UNIT_TO_M: Record<string, number> = {
  "": 1.0,
  m: 1.0,
  meter: 1.0,
  meters: 1.0,
  metre: 1.0,
  metres: 1.0,
  ft: 0.3048,
  feet: 0.3048,
  foot: 0.3048,
  cm: 0.01,
  km: 1000.0,
  mm: 0.001,
};

function positiveFinite(value: number): number | null {
  return Number.isFinite(value) && value > 0.0 ? value : null;
}

/** Parse an OSM length tag into meters. Mirrors `normalize.py:parse_length_m`. */
export function parseLengthM(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return positiveFinite(value);
  let text = String(value).trim();
  if (!text) return null;
  if (text.includes(";")) text = text.split(";", 1)[0].trim();

  const feetInches = FEET_INCHES_RE.exec(text);
  if (feetInches) {
    const feet = parseFloat(feetInches[1]);
    const inches = feetInches[2] ? parseFloat(feetInches[2]) : 0.0;
    return positiveFinite(feet * 0.3048 + inches * 0.0254);
  }

  const numUnit = NUM_UNIT_RE.exec(text);
  if (numUnit) {
    const number = parseFloat(numUnit[1].replace(",", "."));
    const unit = (numUnit[2] ?? "").toLowerCase();
    return positiveFinite(number * UNIT_TO_M[unit]);
  }
  return null;
}

// Matches Python's `float(text)` grammar (JS `parseFloat` is lenient about
// trailing garbage -- "2 storeys" parses as 2 in JS but raises in Python --
// so every string is validated against this pattern before parseFloat runs).
const PY_FLOAT_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** Parse `building:levels` / `building:min_level` into a float count. Mirrors `normalize.py:parse_levels`. */
export function parseLevels(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let text = String(value).trim();
  if (!text) return null;
  if (text.includes(";")) text = text.split(";", 1)[0].trim();
  text = text.replace(",", ".");
  if (!PY_FLOAT_RE.test(text)) return null;
  const number = parseFloat(text);
  return Number.isFinite(number) ? number : null;
}

/** Deterministic +/-6% multiplier seeded by the OSM id. Mirrors `normalize.py:jitter_factor`. */
export function jitterFactor(osmId: string): number {
  const unit = sha1UnitInterval(osmId);
  return 1.0 + (unit * 2.0 - 1.0) * JITTER;
}

export interface Tags {
  [key: string]: unknown;
}

export interface HeightResult {
  heightM: number;
  heightSource: "tag" | "levels" | "default";
  minHeightM: number;
}

/** 03 height inference, in order. Mirrors `normalize.py:resolve_height`. */
export function resolveHeight(tags: Tags, osmId: string): HeightResult {
  return resolveHeightWith(tags, osmId, {
    floorHeightM: LEVEL_HEIGHT_M,
    unknownDefaultM: DEFAULT_HEIGHT_M,
    typeDefaults: TYPE_DEFAULT_HEIGHT_M,
  });
}

export interface HeightRules {
  floorHeightM: number;
  unknownDefaultM: number;
  typeDefaults: Record<string, number>;
}

/**
 * v3: same four rules, tunable floor height / per-type defaults / unknown
 * default (contracts `PrintParams.heights`). `resolveHeight` is
 * `resolveHeightWith` at the frozen 03 constants, so both stay in sync by
 * construction.
 */
export function resolveHeightWith(tags: Tags, osmId: string, rules: HeightRules): HeightResult {
  let height: number | null = null;
  let source: "tag" | "levels" | "default" = "default";

  for (const key of ["height", "building:height"]) {
    const parsed = parseLengthM(tags[key]);
    if (parsed !== null) {
      height = parsed;
      source = "tag";
      break;
    }
  }

  if (height === null) {
    const levels = parseLevels(tags["building:levels"]);
    if (levels !== null && levels > 0) {
      height = levels * rules.floorHeightM;
      const roof = parseLengthM(tags["roof:height"]);
      if (roof !== null) height += roof;
      source = "levels";
    }
  }

  if (height === null) {
    const buildingType = String(tags["building"] ?? "").toLowerCase();
    const fallback = rules.typeDefaults[buildingType] ?? TYPE_DEFAULT_HEIGHT_M[buildingType] ?? rules.unknownDefaultM;
    height = fallback * jitterFactor(osmId);
    source = "default";
  }

  height = Math.min(Math.max(height, MIN_HEIGHT_M), MAX_HEIGHT_M);

  let minHeight = 0.0;
  const minLevel = parseLevels(tags["building:min_level"]);
  if (minLevel !== null && minLevel > 0) minHeight = minLevel * rules.floorHeightM;
  const explicit = parseLengthM(tags["min_height"]);
  if (explicit !== null) minHeight = explicit;
  if (!(0.0 < minHeight && minHeight < height)) minHeight = 0.0;

  return { heightM: height, heightSource: source, minHeightM: minHeight };
}

/** Build `HeightRules` from `PrintParams.heights` (contracts v3), defaulting to the frozen 03 constants. */
export function heightRulesFrom(heights: Heights | undefined): HeightRules {
  const typeDefaults: Record<string, number> = { ...TYPE_DEFAULT_HEIGHT_M };
  const td = heights?.type_defaults;
  if (td) {
    if (td.house !== undefined) typeDefaults.house = td.house;
    if (td.apartments !== undefined) typeDefaults.apartments = td.apartments;
    if (td.commercial !== undefined) typeDefaults.commercial = td.commercial;
    if (td.retail !== undefined) typeDefaults.retail = td.retail;
    if (td.industrial !== undefined) typeDefaults.industrial = td.industrial;
    if (td.garage !== undefined) {
      typeDefaults.garage = td.garage;
      typeDefaults.garages = td.garage;
      typeDefaults.shed = td.garage;
    }
  }
  return {
    floorHeightM: heights?.floor_height_m ?? LEVEL_HEIGHT_M,
    unknownDefaultM: heights?.unknown_default_m ?? DEFAULT_HEIGHT_M,
    typeDefaults,
  };
}

/** 03 road width: the `width` tag wins, else `lanes * 3.5`, else the table. Mirrors `normalize.py:road_width_m`. */
export function roadWidthM(tags: Tags, highway: string): number {
  let width = parseLengthM(tags["width"]);
  if (width === null) {
    const lanes = parseLevels(tags["lanes"]);
    if (lanes !== null && lanes > 0) width = lanes * LANE_WIDTH_M;
  }
  if (width === null || !Number.isFinite(width)) {
    width = HIGHWAY_WIDTH_M[highway] ?? HIGHWAY_WIDTH_M["residential"];
  }
  return Math.min(Math.max(width, MIN_ROAD_WIDTH_M), MAX_ROAD_WIDTH_M);
}

export function roadClass(highway: string): string {
  return HIGHWAY_CLASS[highway] ?? "residential";
}

/** 03 coverage classification. Mirrors `normalize.py:classify_coverage`. */
export function classifyCoverage(
  buildingCount: number,
  footprintAreaM2: number,
  cropAreaM2: number,
): "good" | "sparse" | "empty" {
  if (buildingCount < COVERAGE_EMPTY_COUNT) return "empty";
  if (buildingCount >= COVERAGE_GOOD_COUNT && cropAreaM2 > 0) {
    if (footprintAreaM2 >= COVERAGE_GOOD_AREA_FRACTION * cropAreaM2) return "good";
  }
  return "sparse";
}
