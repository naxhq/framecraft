/**
 * Local metric frame: WGS84 -> UTM -> centered ENU, plus rotation and crop.
 * Mirrors `services/bake/app/geom/project.py`: everything here is meters in a
 * local ENU frame with the requested center at (0,0), x east, y north. Web
 * Mercator is never used. See `tmerc.ts` for the projection math and its
 * validation against `pyproj`.
 */
import { area, boxRing, clipConvex, type Point, type Ring } from "./geometry";
import { utmForward, utmInverse, utmZoneFor, type UtmZone } from "./tmerc";

export class LocalFrame {
  readonly lat: number;
  readonly lon: number;
  readonly rotationDeg: number;
  readonly zone: UtmZone;
  private readonly x0: number;
  private readonly y0: number;
  private readonly cos: number;
  private readonly sin: number;

  constructor(lat: number, lon: number, rotationDeg = 0.0) {
    this.lat = lat;
    this.lon = lon;
    this.rotationDeg = ((rotationDeg % 360) + 360) % 360;
    this.zone = utmZoneFor(lat, lon);
    const [x0, y0] = utmForward(lat, lon, this.zone);
    this.x0 = x0;
    this.y0 = y0;
    const theta = (this.rotationDeg * Math.PI) / 180;
    this.cos = Math.cos(theta);
    this.sin = Math.sin(theta);
  }

  get epsg(): number {
    return this.zone.epsg;
  }

  /** Project WGS84 (lon, lat) pairs to local meters, applying the center offset and rotation. */
  toLocal(lonLat: Point[]): Point[] {
    return lonLat.map(([lon, lat]) => this.pointToLocal(lon, lat));
  }

  pointToLocal(lon: number, lat: number): Point {
    const [x, y] = utmForward(lat, lon, this.zone);
    let dx = x - this.x0;
    let dy = y - this.y0;
    if (this.rotationDeg !== 0) {
      const xr = dx * this.cos - dy * this.sin;
      const yr = dx * this.sin + dy * this.cos;
      dx = xr;
      dy = yr;
    }
    return [dx, dy];
  }

  /** Inverse of `toLocal`; used only to compute the Overpass bbox, never past the SceneGraph boundary. */
  toWgs84(xy: Point[]): Point[] {
    return xy.map(([x, y]) => this.pointToWgs84(x, y));
  }

  pointToWgs84(x: number, y: number): Point {
    let ux = x;
    let uy = y;
    if (this.rotationDeg !== 0) {
      ux = x * this.cos + y * this.sin;
      uy = -x * this.sin + y * this.cos;
    }
    const [lat, lon] = utmInverse(ux + this.x0, uy + this.y0, this.zone);
    return [lon, lat];
  }
}

/** The axis-aligned crop square of side `2 * radiusM` centered on (0,0), as a CCW ring. */
export function cropSquare(radiusM: number): Ring {
  const r = radiusM;
  return boxRing(-r, -r, r, r);
}

/** Intersect a polygon ring with the crop square; drops pieces under `minAreaM2`. See geometry.ts's clipConvex caveat. */
export function clipPolygonToSquare(ring: Ring, square: Ring, minAreaM2 = 1.0): Ring[] {
  const clipped = clipConvex(ring, square);
  if (clipped.length < 3) return [];
  return area(clipped) >= minAreaM2 ? [clipped] : [];
}

/** Intersect an open polyline with the crop square (Cohen-Sutherland-free: the square's 4 half-planes, sequentially). */
export function clipLineToSquare(line: Point[], radiusM: number, minLengthM = 1.0): Point[][] {
  let segments: Point[][] = [line];
  const planes: [number, (p: Point) => number][] = [
    [radiusM, (p) => p[0] + radiusM], // x >= -r
    [radiusM, (p) => radiusM - p[0]], // x <= r
    [radiusM, (p) => p[1] + radiusM], // y >= -r
    [radiusM, (p) => radiusM - p[1]], // y <= r
  ];
  for (const [, inside] of planes) {
    const next: Point[][] = [];
    for (const seg of segments) next.push(...clipPolylineHalfPlane(seg, inside));
    segments = next;
  }
  return segments
    .filter((s) => s.length >= 2)
    .filter((s) => polylineLength(s) >= minLengthM);
}

function polylineLength(pts: Point[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    len += Math.hypot(dx, dy);
  }
  return len;
}

function clipPolylineHalfPlane(pts: Point[], inside: (p: Point) => number): Point[][] {
  const out: Point[][] = [];
  let current: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const pIn = inside(p) >= -1e-9;
    if (i > 0) {
      const prev = pts[i - 1];
      const prevIn = inside(prev) >= -1e-9;
      if (prevIn !== pIn) {
        const t = inside(prev) / (inside(prev) - inside(p));
        const ix = prev[0] + t * (p[0] - prev[0]);
        const iy = prev[1] + t * (p[1] - prev[1]);
        current.push([ix, iy]);
        if (!pIn) {
          out.push(current);
          current = [];
        }
      }
    }
    if (pIn) current.push(p);
  }
  if (current.length >= 2) out.push(current);
  return out;
}

/** Containment test for point features (trees), matching `project.py:in_square`. */
export function inSquare(x: number, y: number, radiusM: number): boolean {
  return -radiusM <= x && x <= radiusM && -radiusM <= y && y <= radiusM;
}
