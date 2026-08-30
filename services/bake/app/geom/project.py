"""Local metric frame: WGS84 -> UTM -> centered ENU, plus rotation and crop.

This module is the boundary where degrees stop existing. Everything it returns
is meters in a local ENU frame with the requested center at (0, 0), x east,
y north (03 "Projection and crop"). Web Mercator is never used for geometry.

Conventions
-----------
* UTM zone is derived from the *center* of the request; the whole scene uses
  that one zone even if the crop straddles a zone boundary, so the frame stays
  a single rigid metric frame.
* ``rotation_deg`` is applied as a mathematically positive (counter-clockwise)
  rotation of the geometry about the origin.  Equivalently: the compass bearing
  ``rotation_deg`` (degrees clockwise from true north) ends up pointing at +y
  in the model.  That is why the New York preset is 29 deg: Manhattan's avenue
  grid runs ~29 deg east of north, so bearing 29 -> "up" squares the grid to
  the plate.
* Rotation is a rigid transform, so it is applied to the raw coordinate arrays
  right after projection (one vectorized numpy pass) rather than per geometry.
  Distance-based hygiene (simplify tolerance, centroid dedupe) is rotation
  invariant, so "rotate then crop" per 03 is preserved exactly.
"""
from __future__ import annotations

import math
from typing import Iterable, Sequence

import numpy as np
from pyproj import Transformer
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Polygon, box
from shapely.geometry.base import BaseGeometry

__all__ = [
    "LocalFrame",
    "utm_epsg",
    "utm_zone",
    "crop_square",
    "clip_polygon",
    "clip_line",
    "in_square",
]


def utm_zone(lon: float) -> int:
    """UTM zone number (1..60) for a longitude in degrees."""
    return int(math.floor((lon + 180.0) / 6.0)) % 60 + 1


def utm_epsg(lat: float, lon: float) -> int:
    """EPSG code of the WGS84 / UTM zone containing (lat, lon).

    326xx on the northern hemisphere, 327xx on the southern one.
    """
    zone = utm_zone(lon)
    return (32600 if lat >= 0.0 else 32700) + zone


class LocalFrame:
    """WGS84 <-> local metric ENU frame centered on (lat, lon), rotated by
    ``rotation_deg`` counter-clockwise about the origin."""

    def __init__(self, lat: float, lon: float, rotation_deg: float = 0.0) -> None:
        self.lat = float(lat)
        self.lon = float(lon)
        self.rotation_deg = float(rotation_deg) % 360.0
        self.epsg = utm_epsg(self.lat, self.lon)
        self._fwd = Transformer.from_crs("EPSG:4326", f"EPSG:{self.epsg}", always_xy=True)
        self._inv = Transformer.from_crs(f"EPSG:{self.epsg}", "EPSG:4326", always_xy=True)
        self.x0, self.y0 = self._fwd.transform(self.lon, self.lat)
        theta = math.radians(self.rotation_deg)
        self._cos = math.cos(theta)
        self._sin = math.sin(theta)

    # -- forward ---------------------------------------------------------
    def to_local(self, lons: Sequence[float], lats: Sequence[float]) -> np.ndarray:
        """Project degree arrays to an (n, 2) float array of local meters.

        Applies the UTM projection, the center offset and the rotation in one
        vectorized pass.
        """
        lon_a = np.asarray(lons, dtype=float)
        lat_a = np.asarray(lats, dtype=float)
        if lon_a.size == 0:
            return np.zeros((0, 2), dtype=float)
        x, y = self._fwd.transform(lon_a, lat_a)
        x = np.asarray(x, dtype=float) - self.x0
        y = np.asarray(y, dtype=float) - self.y0
        if self.rotation_deg != 0.0:
            xr = x * self._cos - y * self._sin
            yr = x * self._sin + y * self._cos
            x, y = xr, yr
        return np.column_stack((x, y))

    def point_to_local(self, lon: float, lat: float) -> tuple[float, float]:
        arr = self.to_local([lon], [lat])
        return float(arr[0, 0]), float(arr[0, 1])

    # -- inverse ---------------------------------------------------------
    def to_wgs84(self, xy: Iterable[Sequence[float]]) -> np.ndarray:
        """Inverse of :meth:`to_local`; returns an (n, 2) array of (lon, lat).

        Used only to compute the Overpass bounding box, never on the SceneGraph
        path: no lat/lon may cross the SceneGraph boundary.
        """
        pts = np.asarray(list(xy), dtype=float).reshape(-1, 2)
        if pts.size == 0:
            return np.zeros((0, 2), dtype=float)
        x, y = pts[:, 0], pts[:, 1]
        if self.rotation_deg != 0.0:
            xu = x * self._cos + y * self._sin
            yu = -x * self._sin + y * self._cos
            x, y = xu, yu
        lon, lat = self._inv.transform(x + self.x0, y + self.y0)
        return np.column_stack((np.asarray(lon, dtype=float), np.asarray(lat, dtype=float)))


def crop_square(radius_m: float) -> Polygon:
    """The axis-aligned crop square of side ``2 * radius_m`` centered on (0,0)."""
    r = float(radius_m)
    return box(-r, -r, r, r)


def _polygonal_parts(geom: BaseGeometry) -> list[Polygon]:
    if geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return [p for p in geom.geoms if not p.is_empty]
    parts: list[Polygon] = []
    for sub in getattr(geom, "geoms", []):
        parts.extend(_polygonal_parts(sub))
    return parts


def clip_polygon(geom: BaseGeometry, square: Polygon, min_area_m2: float = 1.0) -> list[Polygon]:
    """Intersect a polygon with the crop square.

    A half building at the edge becomes a clean cut face (03), and a result
    that falls apart into several pieces is returned as several polygons so the
    caller can emit them as separate SceneGraph entries.
    """
    if geom.is_empty:
        return []
    clipped = geom.intersection(square)
    return [p for p in _polygonal_parts(clipped) if p.area >= min_area_m2]


def clip_line(geom: BaseGeometry, square: Polygon, min_length_m: float = 1.0) -> list[LineString]:
    """Intersect a linestring with the crop square, splitting MultiLineStrings."""
    if geom.is_empty:
        return []
    clipped = geom.intersection(square)
    out: list[LineString] = []
    stack: list[BaseGeometry] = [clipped]
    while stack:
        g = stack.pop()
        if g.is_empty:
            continue
        if isinstance(g, LineString):
            if g.length >= min_length_m and len(g.coords) >= 2:
                out.append(g)
        elif isinstance(g, MultiLineString):
            stack.extend(g.geoms)
        else:
            stack.extend(getattr(g, "geoms", []))
    return out


def in_square(x: float, y: float, radius_m: float) -> bool:
    """Containment test used for point features (trees)."""
    r = float(radius_m)
    return -r <= x <= r and -r <= y <= r
