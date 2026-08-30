import { describe, expect, it } from "vitest";
import { cropSquare, inSquare, LocalFrame } from "./project";
import { utmZoneFor } from "./tmerc";

// Reference values computed directly from `services/bake/app/geom/project.py`
// (pyproj's ellipsoidal UTM transform) via `uv run python`, not guessed.
// tmerc.ts implements the same Krüger n-series PROJ's `etmerc` engine uses;
// see tmerc.ts's module doc.

describe("utmZoneFor", () => {
  it("matches project.py:utm_epsg", () => {
    expect(utmZoneFor(41.8827, -87.6233).epsg).toBe(32616); // Chicago, zone 16 north
    expect(utmZoneFor(35.6896, 139.7006).epsg).toBe(32654); // Tokyo, zone 54 north
    expect(utmZoneFor(-33.8688, 151.2093).epsg).toBe(32756); // Sydney, zone 56 south
  });
});

describe("LocalFrame", () => {
  it("puts the center at the origin", () => {
    const frame = new LocalFrame(41.8827, -87.6233, 0.0);
    const [x, y] = frame.pointToLocal(-87.6233, 41.8827);
    expect(Math.abs(x)).toBeLessThan(1e-6);
    expect(Math.abs(y)).toBeLessThan(1e-6);
  });

  it("matches pyproj's forward projection at rotation 0 (Chicago), within 1 mm", () => {
    const frame = new LocalFrame(41.8827, -87.6233, 0.0);
    const cases: [number, number, number, number][] = [
      [-87.6233, 41.8837, 0.8063938159029931, 111.02731445990503],
      [-87.63, 41.885, -554.024956764828, 259.42206150572747],
      [-87.615, 41.879, 685.707879260357, -415.76916497480124],
    ];
    for (const [lon, lat, ex, ey] of cases) {
      const [x, y] = frame.pointToLocal(lon, lat);
      expect(x).toBeCloseTo(ex, 3);
      expect(y).toBeCloseTo(ey, 3);
    }
  });

  it("matches pyproj's forward projection at rotation 29 (New York preset), within 1 mm", () => {
    const frame = new LocalFrame(40.7549, -73.984, 29.0);
    const cases: [number, number, number, number][] = [
      [-73.984, 40.7559, -54.941502766385526, 96.46616398557477],
      [-73.99, 40.757, -555.5111360503995, -48.07597437164014],
    ];
    for (const [lon, lat, ex, ey] of cases) {
      const [x, y] = frame.pointToLocal(lon, lat);
      expect(x).toBeCloseTo(ex, 3);
      expect(y).toBeCloseTo(ey, 3);
    }
  });

  it("rotation_deg is the compass bearing that ends up pointing +y", () => {
    // A point 500 m away at bearing 29 deg, expressed in the unrotated frame,
    // then read back through the rotated frame: should land near (0, 500).
    const plain = new LocalFrame(40.7549, -73.984, 0.0);
    const turned = new LocalFrame(40.7549, -73.984, 29.0);
    const bearing = (29.0 * Math.PI) / 180;
    const east = 500.0 * Math.sin(bearing);
    const north = 500.0 * Math.cos(bearing);
    const [lon, lat] = plain.pointToWgs84(east, north);
    const [x, y] = turned.pointToLocal(lon, lat);
    expect(Math.abs(x)).toBeLessThan(0.5);
    expect(Math.abs(y - 500.0)).toBeLessThan(0.5);
  });

  it("inverts (pointToWgs84) to match pyproj, within 1e-6 deg", () => {
    const frame = new LocalFrame(41.8827, -87.6233, 0.0);
    let [lon, lat] = frame.pointToWgs84(100.0, 200.0);
    expect(lon).toBeCloseTo(-87.62211228315923, 6);
    expect(lat).toBeCloseTo(41.88450779871425, 6);
    [lon, lat] = frame.pointToWgs84(-300.5, 450.25);
    expect(lon).toBeCloseTo(-87.62696123882249, 6);
    expect(lat).toBeCloseTo(41.886735377052005, 6);
  });
});

describe("cropSquare / inSquare", () => {
  it("is a CCW square of side 2*radius centered on the origin", () => {
    const ring = cropSquare(900);
    expect(ring).toHaveLength(4);
    for (const [x, y] of ring) {
      expect(Math.abs(x)).toBe(900);
      expect(Math.abs(y)).toBe(900);
    }
  });

  it("matches project.py:in_square containment", () => {
    expect(inSquare(0, 0, 900)).toBe(true);
    expect(inSquare(900, 900, 900)).toBe(true);
    expect(inSquare(900.001, 0, 900)).toBe(false);
    expect(inSquare(0, -900.001, 900)).toBe(false);
  });
});
