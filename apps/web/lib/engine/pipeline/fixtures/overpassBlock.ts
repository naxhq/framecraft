/**
 * The smallest Overpass-shaped response that exercises every `heights.*` leaf.
 *
 * `heights.*` is read by `normalise` and by nothing else, so a probe for one of
 * those leaves has to enter the pipeline at `fetch`: a finished `SceneGraph`
 * already carries the heights the rules decided. The committed tiny-loop
 * fixture tags a height on every building, which is exactly what makes it
 * useless here.
 *
 * Eight buildings, none of them carrying a `height` tag, EACH ON ITS OWN 46 m
 * square at a known plan position: one with nothing at all (so
 * `heights.unknown_default_m` decides it), one with three storeys (so
 * `heights.floor_height_m` does), and one for each of the six
 * `heights.type_defaults` keys. The positions are the point: a matrix probe
 * reads the roof height over ONE square, so a probe for `retail` cannot be
 * satisfied by a change that moved `industrial`. Plus a road, a pond and a park,
 * so the surface layers exist in this scene too.
 *
 * Not a test file: `matrix.probes.ts` imports it.
 */

import type { SceneRequest } from "../../../contracts";

/** Centre of the fixture, and the request the `fetch` stage is keyed by. */
export const OSM_FIXTURE_REQUEST: SceneRequest = {
  lat: 41.8827,
  lon: -87.6233,
  radius_m: 300.0,
  rotation_deg: 0.0,
  preset_id: "matrix-osm",
};

/** Metres per degree at the fixture's latitude, good to a few parts in 10^4. */
const M_PER_DEG_LAT = 111132.0;
const M_PER_DEG_LON = 82870.0;

interface LatLon {
  lat: number;
  lon: number;
}

function point(eastM: number, northM: number): LatLon {
  return {
    lat: OSM_FIXTURE_REQUEST.lat + northM / M_PER_DEG_LAT,
    lon: OSM_FIXTURE_REQUEST.lon + eastM / M_PER_DEG_LON,
  };
}

/** A closed square ring `sizeM` across, centred on `(eastM, northM)`. */
function ring(eastM: number, northM: number, sizeM: number): LatLon[] {
  const h = sizeM / 2;
  return [
    point(eastM - h, northM - h),
    point(eastM + h, northM - h),
    point(eastM + h, northM + h),
    point(eastM - h, northM + h),
    point(eastM - h, northM - h),
  ];
}

interface OverpassWay {
  type: "way";
  id: number;
  tags: Record<string, string>;
  geometry: LatLon[];
}

/** Plan centre of one fixture building, scene metres east and north of the pin. */
export interface Footprint {
  eastM: number;
  northM: number;
  /** The `heights.*` leaf whose default decides this building's height. */
  decidedBy: string;
  /** That leaf's value in a default `PrintParams`, metres. */
  defaultM: number;
}

export const OSM_BUILDING_SIZE_M = 46;

/**
 * Every fixture building by name, with the leaf that decides its height and
 * that leaf's default. The eight squares are at least 120 m apart, so a plan
 * window around one of them contains no part of another.
 */
export const OSM_FOOTPRINTS: Readonly<Record<string, Footprint>> = {
  unknown: { eastM: -200, northM: 120, decidedBy: "heights.unknown_default_m", defaultM: 8 },
  levels: { eastM: -80, northM: 120, decidedBy: "heights.floor_height_m", defaultM: 3 },
  house: { eastM: 40, northM: 120, decidedBy: "heights.type_defaults.house", defaultM: 6 },
  apartments: { eastM: 160, northM: 120, decidedBy: "heights.type_defaults.apartments", defaultM: 15 },
  commercial: { eastM: -200, northM: -20, decidedBy: "heights.type_defaults.commercial", defaultM: 12 },
  retail: { eastM: -80, northM: -20, decidedBy: "heights.type_defaults.retail", defaultM: 6 },
  industrial: { eastM: 40, northM: -20, decidedBy: "heights.type_defaults.industrial", defaultM: 8 },
  garage: { eastM: 160, northM: -20, decidedBy: "heights.type_defaults.garage", defaultM: 3 },
};

/** How many storeys the `levels` building carries, so a probe can predict its roof. */
export const OSM_LEVELS = 3;

function building(name: keyof typeof OSM_FOOTPRINTS, id: number, tags: Record<string, string>): OverpassWay {
  const spot = OSM_FOOTPRINTS[name];
  return { type: "way", id, tags, geometry: ring(spot.eastM, spot.northM, OSM_BUILDING_SIZE_M) };
}

const WAYS: OverpassWay[] = [
  // No height, no levels, no recognised type: `heights.unknown_default_m`.
  building("unknown", 101, { building: "yes" }),
  // Three storeys and no height: `heights.floor_height_m`.
  building("levels", 102, { building: "yes", "building:levels": String(OSM_LEVELS) }),
  building("house", 103, { building: "house" }),
  building("apartments", 104, { building: "apartments" }),
  building("commercial", 105, { building: "commercial" }),
  building("retail", 106, { building: "retail" }),
  building("industrial", 107, { building: "industrial" }),
  building("garage", 108, { building: "garage" }),
  {
    type: "way",
    id: 201,
    tags: { highway: "residential" },
    geometry: [point(-280, 50), point(280, 50)],
  },
  { type: "way", id: 301, tags: { natural: "water" }, geometry: ring(-150, -180, 120) },
  { type: "way", id: 401, tags: { leisure: "park" }, geometry: ring(120, -180, 140) },
];

/** The `out geom` response the fetch stage's injected `fetchImpl` returns. */
export function overpassFixture(): { elements: OverpassWay[] } {
  return { elements: WAYS.map((way) => ({ ...way, tags: { ...way.tags }, geometry: [...way.geometry] })) };
}

/** A `fetch` implementation that answers every Overpass call with the fixture. */
export function overpassFetchImpl(): typeof fetch {
  return (async () => ({ ok: true, status: 200, json: async () => overpassFixture() })) as unknown as typeof fetch;
}
