/**
 * Spherical geodesy for the MapLibre picker.
 *
 * The 3D pipeline never sees lat/lon (02: "Never pass lat/lon past this
 * boundary"), so this module exists purely to draw the pin, the radius circle
 * and the rotated crop square on the 2D map, and to turn a dragged handle back
 * into a radius in metres.
 */

/** WGS84 mean radius, metres. Good to ~0.3% for the ranges we draw. */
export const EARTH_RADIUS_M = 6371008.8;

/** 01: the radius handle is limited to 250..3000 m and snaps to 10 m. */
export const RADIUS_MIN_M = 250;
export const RADIUS_MAX_M = 3000;
export const RADIUS_STEP_M = 10;

export interface LatLon {
  lat: number;
  lon: number;
}

/** A GeoJSON [lon, lat] position, the order MapLibre expects. */
export type LonLat = [number, number];

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/** Clamp a raw radius to the legal range and snap it to the 10 m step. */
export function snapRadius(metres: number): number {
  const snapped = Math.round(metres / RADIUS_STEP_M) * RADIUS_STEP_M;
  return Math.min(RADIUS_MAX_M, Math.max(RADIUS_MIN_M, snapped));
}

/** Great-circle distance between two points, metres. */
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Move `distanceM` metres from `origin` along a compass bearing (deg from N). */
export function destination(
  origin: LatLon,
  bearingDeg: number,
  distanceMetres: number,
): LatLon {
  const delta = distanceMetres / EARTH_RADIUS_M;
  const theta = toRad(bearingDeg);
  const lat1 = toRad(origin.lat);
  const lon1 = toRad(origin.lon);
  const sinLat2 =
    Math.sin(lat1) * Math.cos(delta) + Math.cos(lat1) * Math.sin(delta) * Math.cos(theta);
  const lat2 = Math.asin(Math.min(1, Math.max(-1, sinLat2)));
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(lat1),
      Math.cos(delta) - Math.sin(lat1) * sinLat2,
    );
  return { lat: toDeg(lat2), lon: ((toDeg(lon2) + 540) % 360) - 180 };
}

/**
 * Offset a point by a local ENU vector, metres. `east`/`north` match the
 * SceneGraph frame (x east, y north), which is what makes the crop square
 * drawn here the same square the server crops.
 */
export function offsetEnu(origin: LatLon, east: number, north: number): LatLon {
  const distance = Math.hypot(east, north);
  if (distance === 0) return { ...origin };
  const bearing = toDeg(Math.atan2(east, north));
  return destination(origin, bearing, distance);
}

/** Bearing from `origin` to `target`, degrees clockwise from north. */
export function bearingDeg(origin: LatLon, target: LatLon): number {
  const lat1 = toRad(origin.lat);
  const lat2 = toRad(target.lat);
  const dLon = toRad(target.lon - origin.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** A closed ring of [lon, lat] positions approximating a circle of `radiusM`. */
export function circleRing(center: LatLon, radiusM: number, steps = 96): LonLat[] {
  const ring: LonLat[] = [];
  for (let i = 0; i < steps; i += 1) {
    const p = destination(center, (i * 360) / steps, radiusM);
    ring.push([p.lon, p.lat]);
  }
  ring.push(ring[0]);
  return ring;
}

/**
 * The crop square the build will actually print, as a closed [lon, lat] ring.
 *
 * `rotation_deg` rotates the crop before it is squared (01). The server
 * (`app/geom/project.py`, `LocalFrame.to_local`) rotates the *geometry*
 * counter-clockwise by `+rotation_deg` and then clips it to the axis-aligned
 * square of side `2 * radius`. The patch of world that survives is therefore
 * that square mapped back through the inverse rotation, i.e. rotated
 * **clockwise** by `rotation_deg` in the ENU frame (x east, y north) -- which
 * is what DECISIONS [P2] means by "the picker overlay must draw the crop
 * square rotated CW by the same angle". Drawing it CCW instead only agrees
 * with the printed region at multiples of 45 deg.
 */
export function cropSquareRing(
  center: LatLon,
  radiusM: number,
  rotationDeg: number,
): LonLat[] {
  const theta = toRad(rotationDeg);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const corners: Array<[number, number]> = [
    [-radiusM, -radiusM],
    [radiusM, -radiusM],
    [radiusM, radiusM],
    [-radiusM, radiusM],
  ];
  const ring: LonLat[] = corners.map(([x, y]) => {
    // Inverse of the server's rotation: R(-theta) applied to the model-frame
    // corner gives the ENU offset that lands on it after R(+theta).
    const east = x * cos + y * sin;
    const north = -x * sin + y * cos;
    const p = offsetEnu(center, east, north);
    return [p.lon, p.lat];
  });
  ring.push(ring[0]);
  return ring;
}

/**
 * Where the draggable radius handle sits: due east of the pin, on the circle.
 * East is chosen because it stays put as `rotation_deg` changes, so the handle
 * never fights the crop square for the pointer.
 */
export function radiusHandlePosition(center: LatLon, radiusM: number): LatLon {
  return destination(center, 90, radiusM);
}

/** A GeoJSON Polygon Feature wrapping one closed ring. */
export function polygonFeature(ring: LonLat[]): GeoJSON.Feature<GeoJSON.Polygon> {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}
