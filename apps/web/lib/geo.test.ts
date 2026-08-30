/**
 * Geodesy tests for the map picker: the circle, the crop square and the radius
 * snapping the drag handle relies on.
 */

import { describe, expect, it } from "vitest";

import {
  RADIUS_MAX_M,
  RADIUS_MIN_M,
  bearingDeg,
  circleRing,
  cropSquareRing,
  destination,
  distanceM,
  offsetEnu,
  radiusHandlePosition,
  snapRadius,
} from "./geo";

const CHICAGO = { lat: 41.8827, lon: -87.6233 };

describe("snapRadius", () => {
  it("snaps to 10 m and clamps to 250..3000 m", () => {
    expect(snapRadius(903)).toBe(900);
    expect(snapRadius(906)).toBe(910);
    expect(snapRadius(-5)).toBe(RADIUS_MIN_M);
    expect(snapRadius(1e6)).toBe(RADIUS_MAX_M);
    expect(snapRadius(250)).toBe(250);
    expect(snapRadius(3000)).toBe(3000);
  });
});

describe("destination / distance", () => {
  it("round-trips a 900 m offset to within a centimetre", () => {
    const east = destination(CHICAGO, 90, 900);
    expect(distanceM(CHICAGO, east)).toBeCloseTo(900, 2);
    expect(bearingDeg(CHICAGO, east)).toBeCloseTo(90, 3);
  });

  it("maps ENU offsets onto the right compass directions", () => {
    const north = offsetEnu(CHICAGO, 0, 500);
    expect(north.lat).toBeGreaterThan(CHICAGO.lat);
    expect(distanceM(CHICAGO, north)).toBeCloseTo(500, 2);

    const northEast = offsetEnu(CHICAGO, 500, 500);
    expect(bearingDeg(CHICAGO, northEast)).toBeCloseTo(45, 2);
    expect(distanceM(CHICAGO, northEast)).toBeCloseTo(Math.hypot(500, 500), 2);

    expect(offsetEnu(CHICAGO, 0, 0)).toEqual(CHICAGO);
  });
});

describe("circleRing", () => {
  it("is closed and every vertex sits on the radius", () => {
    const ring = circleRing(CHICAGO, 1500, 32);
    expect(ring).toHaveLength(33);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    for (const [lon, lat] of ring) {
      expect(distanceM(CHICAGO, { lat, lon })).toBeCloseTo(1500, 1);
    }
  });
});

describe("cropSquareRing", () => {
  it("is a closed square whose corners are radius*sqrt(2) from the pin", () => {
    const ring = cropSquareRing(CHICAGO, 900, 0);
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    for (const [lon, lat] of ring.slice(0, 4)) {
      expect(distanceM(CHICAGO, { lat, lon })).toBeCloseTo(900 * Math.SQRT2, 0);
    }
  });

  it("rotates clockwise in the ENU frame", () => {
    const unrotated = cropSquareRing(CHICAGO, 900, 0);
    const rotated = cropSquareRing(CHICAGO, 900, 45);
    // At 0 deg the first corner is the south-west one (bearing 225).
    expect(bearingDeg(CHICAGO, { lat: unrotated[0][1], lon: unrotated[0][0] })).toBeCloseTo(
      225,
      1,
    );
    // The server rotates the geometry +45 deg CCW and clips the axis-aligned
    // square, so the printed patch is the square turned 45 deg CW: the SW
    // corner swings to due west (bearing 270), not to due south.
    expect(bearingDeg(CHICAGO, { lat: rotated[0][1], lon: rotated[0][0] })).toBeCloseTo(
      270,
      1,
    );
  });

  it("lands on (+-r, +-r) after the rotation project.py applies", () => {
    // The load-bearing parity check: take each drawn corner back to an ENU
    // offset, apply the server's `to_local` rotation (xr = x cos - y sin,
    // yr = x sin + y cos) and it must be a corner of the axis-aligned crop
    // square. 29 deg is the New York preset, where a CCW overlay would sit at
    // 1.378 * radius instead.
    for (const rotationDeg of [0, 17, 29, 45, 90, 233, 359]) {
      const ring = cropSquareRing(CHICAGO, 900, rotationDeg);
      const theta = (rotationDeg * Math.PI) / 180;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      for (const [lon, lat] of ring.slice(0, 4)) {
        const distance = distanceM(CHICAGO, { lat, lon });
        const bearing = (bearingDeg(CHICAGO, { lat, lon }) * Math.PI) / 180;
        const east = distance * Math.sin(bearing);
        const north = distance * Math.cos(bearing);
        expect(Math.abs(east * cos - north * sin)).toBeCloseTo(900, 2);
        expect(Math.abs(east * sin + north * cos)).toBeCloseTo(900, 2);
      }
    }
  });

  it("comes back to itself after a full turn", () => {
    const a = cropSquareRing(CHICAGO, 900, 0);
    const b = cropSquareRing(CHICAGO, 900, 360);
    a.forEach(([lon, lat], i) => {
      expect(b[i][0]).toBeCloseTo(lon, 9);
      expect(b[i][1]).toBeCloseTo(lat, 9);
    });
  });
});

describe("radiusHandlePosition", () => {
  it("sits due east on the circle so it never fights the crop square", () => {
    const handle = radiusHandlePosition(CHICAGO, 750);
    expect(distanceM(CHICAGO, handle)).toBeCloseTo(750, 2);
    expect(bearingDeg(CHICAGO, handle)).toBeCloseTo(90, 3);
    // Dragging it outward and snapping is exactly how the picker reads a radius.
    const dragged = destination(CHICAGO, 90, 1237);
    expect(snapRadius(distanceM(CHICAGO, dragged))).toBe(1240);
  });
});
