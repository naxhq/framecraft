"""Raw Overpass JSON -> SceneGraph (03 "Height inference", "Road widths",
"Geometry hygiene", "Projection and crop", "Coverage classification").

Pipeline, in order:

1.  Classify every Overpass element into building / road / water / green / tree
    and register its coordinates in one pool.
2.  Project the whole pool WGS84 -> local UTM -> centered ENU meters and rotate
    it by ``rotation_deg`` in a single vectorized pass (``geom/project.py``).
    Projection has to happen before hygiene because every hygiene tolerance in
    03 is metric (0.25 m simplify, 0.5 m centroid dedupe); rotation is rigid so
    doing it in the same pass is equivalent to rotating afterwards, and the
    03 order "rotate, then clip to the axis-aligned square" is preserved.
3.  Hygiene, the seven steps of 03, in order.
4.  Crop to the axis-aligned square of side ``2 * radius_m``.
5.  Emit the frozen SceneGraph contract: meters, local ENU, center at (0,0),
    rings without the repeated closing vertex, exterior CCW and holes CW.
"""
from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

import numpy as np
from shapely import STRtree, make_valid, set_precision
from shapely.errors import GEOSException
from shapely.geometry import LineString, MultiPolygon, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.geometry.polygon import orient
from shapely.ops import linemerge, polygonize, unary_union

from app.contracts import (
    AreaFeature,
    Bounds,
    Building,
    Center,
    Road,
    SceneGraph,
    SceneRequest,
    Stats,
    Tree,
)
from app.geom.project import LocalFrame, clip_line, clip_polygon, crop_square, in_square

__all__ = [
    "build_scene",
    "parse_length_m",
    "parse_levels",
    "jitter_factor",
    "resolve_height",
    "road_width_m",
    "road_class",
    "classify_coverage",
    "LEVEL_HEIGHT_M",
    "DEFAULT_HEIGHT_M",
    "TYPE_DEFAULT_HEIGHT_M",
    "HIGHWAY_WIDTH_M",
    "HIGHWAY_CLASS",
    "MIN_HEIGHT_M",
    "MAX_HEIGHT_M",
    "TALL_HEIGHT_M",
    "MIN_ROAD_WIDTH_M",
    "MAX_ROAD_WIDTH_M",
]

# ---------------------------------------------------------------------------
# constants from 03
# ---------------------------------------------------------------------------

LEVEL_HEIGHT_M = 3.2
DEFAULT_HEIGHT_M = 8.0
MIN_HEIGHT_M = 2.0
MAX_HEIGHT_M = 600.0
TALL_HEIGHT_M = 40.0
JITTER = 0.06

TYPE_DEFAULT_HEIGHT_M: dict[str, float] = {
    "skyscraper": 120.0,
    "church": 25.0,
    "cathedral": 25.0,
    "hospital": 30.0,
    "apartments": 18.0,
    "commercial": 12.0,
    "retail": 12.0,
    "industrial": 10.0,
    "house": 7.0,
    "detached": 7.0,
    "garage": 3.0,
    "garages": 3.0,
    "shed": 3.0,
}

HIGHWAY_WIDTH_M: dict[str, float] = {
    "motorway": 24.0,
    "trunk": 20.0,
    "primary": 16.0,
    "secondary": 12.0,
    "tertiary": 10.0,
    "residential": 8.0,
    "unclassified": 8.0,
    "service": 5.0,
    "pedestrian": 6.0,
    "footway": 3.0,
}

#: DECISIONS.md [P1]: the SceneGraph enum is smaller than the OSM tag list.
HIGHWAY_CLASS: dict[str, str] = {
    "motorway": "motorway",
    "trunk": "motorway",
    "primary": "primary",
    "secondary": "secondary",
    "tertiary": "secondary",
    "residential": "residential",
    "unclassified": "residential",
    "service": "service",
    "pedestrian": "path",
    "footway": "path",
}

LANE_WIDTH_M = 3.5
#: Physical clamp on the road width that reaches the SceneGraph: narrower than
#: a footpath or wider than a 17-lane motorway is a tagging error, and an
#: unclamped ``lanes``/``width`` tag can otherwise reach the wire as ``inf``.
MIN_ROAD_WIDTH_M = 0.5
MAX_ROAD_WIDTH_M = 60.0

GREEN_LANDUSE = frozenset({"grass", "forest", "meadow", "recreation_ground"})
GREEN_LEISURE = frozenset({"park", "garden", "pitch"})

SIMPLIFY_TOLERANCE_M = 0.25
#: SceneGraph coordinates are emitted rounded to 1 mm.  Geometry is snap-rounded
#: onto that same grid *before* it is validated (GEOS ``set_precision`` is
#: topology repairing), so a hole that touches its own exterior after the
#: rounding cannot turn into a ring self-intersection that costs the building
#: its courtyards - or the building itself.
EMIT_GRID_M = 0.001
DEDUPE_CENTROID_M = 0.5
DEDUPE_AREA_RATIO = 0.05
#: A polygon smaller than this is print-scale noise (< 0.05 mm^2 on a 180 mm
#: plate at 900 m radius) and is dropped after hygiene and after the crop.
MIN_FEATURE_AREA_M2 = 1.0
MIN_ROAD_LENGTH_M = 1.0
#: Two footprints are "overlapping" only if their interiors share real area;
#: buildings that merely share a wall (a Paris block) keep their own heights.
OVERLAP_MIN_AREA_M2 = 0.25
OVERLAP_MIN_RATIO = 0.02

DEFAULT_TREE_RADIUS_M = 4.0
MIN_TREE_RADIUS_M = 0.5
MAX_TREE_RADIUS_M = 20.0

COVERAGE_GOOD_COUNT = 150
COVERAGE_GOOD_AREA_FRACTION = 0.04
COVERAGE_EMPTY_COUNT = 20


# ---------------------------------------------------------------------------
# tag parsing
# ---------------------------------------------------------------------------

_FEET_INCHES_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*(?:\"|''))?\s*$")
_NUM_UNIT_RE = re.compile(
    r"^\s*([-+]?\d+(?:[.,]\d+)?)\s*"
    r"(m|meter|meters|metre|metres|ft|feet|foot|cm|km|mm)?\s*$",
    re.IGNORECASE,
)
_UNIT_TO_M = {
    None: 1.0,
    "": 1.0,
    "m": 1.0,
    "meter": 1.0,
    "meters": 1.0,
    "metre": 1.0,
    "metres": 1.0,
    "ft": 0.3048,
    "feet": 0.3048,
    "foot": 0.3048,
    "cm": 0.01,
    "km": 1000.0,
    "mm": 0.001,
}


def _positive_finite(value: float) -> float | None:
    """A tag value only counts if it is a real, positive, finite number.

    ``lanes=1e308`` or a 400-digit ``width`` would otherwise reach the frozen
    SceneGraph as ``inf`` (which FastAPI serialises as ``null`` and json.dumps
    writes as non-standard ``Infinity``).
    """
    return value if math.isfinite(value) and value > 0.0 else None


def parse_length_m(value: Any) -> float | None:
    """Parse an OSM length tag into meters.

    Accepts ``12.5``, ``12.5 m``, ``12,5 m``, ``41'``, ``41'6"``, ``135 ft``.
    Returns ``None`` for anything unparseable, non-positive or non-finite.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return _positive_finite(float(value))
    text = str(value).strip()
    if not text:
        return None
    if ";" in text:  # multi-valued tag: take the first entry
        text = text.split(";", 1)[0].strip()

    m = _FEET_INCHES_RE.match(text)
    if m:
        feet = float(m.group(1))
        inches = float(m.group(2)) if m.group(2) else 0.0
        return _positive_finite(feet * 0.3048 + inches * 0.0254)

    m = _NUM_UNIT_RE.match(text)
    if m:
        number = float(m.group(1).replace(",", "."))
        unit = (m.group(2) or "").lower()
        return _positive_finite(number * _UNIT_TO_M[unit])
    return None


def parse_levels(value: Any) -> float | None:
    """Parse ``building:levels`` / ``building:min_level`` into a float count.

    Non-finite results (``inf``, ``nan``, ``1e308`` scaled by a level height)
    are rejected outright; every caller multiplies the result by a length.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = float(value)
        return number if math.isfinite(number) else None
    text = str(value).strip()
    if not text:
        return None
    if ";" in text:
        text = text.split(";", 1)[0].strip()
    text = text.replace(",", ".")
    try:
        number = float(text)
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def jitter_factor(osm_id: str) -> float:
    """Deterministic +/-6% multiplier seeded by the OSM id (03 rules 4 and 5)."""
    digest = hashlib.sha1(str(osm_id).encode("utf-8")).digest()
    unit = int.from_bytes(digest[:8], "big") / float(1 << 64)  # [0, 1)
    return 1.0 + (unit * 2.0 - 1.0) * JITTER


def resolve_height(tags: dict[str, Any], osm_id: str) -> tuple[float, str, float]:
    """03 height inference, in order. Returns (height_m, height_source, min_height_m).

    ``height_source`` is the contract enum: rule 1 -> ``"tag"``, rule 2 ->
    ``"levels"``, rules 4 and 5 -> ``"default"``.  Rule 3 (``building:min_level``)
    only sets ``min_height_m`` and never decides the source.
    """
    height: float | None = None
    source = "default"

    # 1. height tag, meters, units stripped.
    for key in ("height", "building:height"):
        parsed = parse_length_m(tags.get(key))
        if parsed is not None:
            height = parsed
            source = "tag"
            break

    # 2. building:levels * 3.2, plus roof:height when present.
    if height is None:
        levels = parse_levels(tags.get("building:levels"))
        if levels is not None and levels > 0:
            height = levels * LEVEL_HEIGHT_M
            roof = parse_length_m(tags.get("roof:height"))
            if roof is not None:
                height += roof
            source = "levels"

    # 4. type defaults, 5. global fallback; both jittered by osm id.
    if height is None:
        default = TYPE_DEFAULT_HEIGHT_M.get(str(tags.get("building", "")).lower())
        if default is None:
            default = DEFAULT_HEIGHT_M
        height = default * jitter_factor(osm_id)
        source = "default"

    height = min(max(float(height), MIN_HEIGHT_M), MAX_HEIGHT_M)

    # 3. building:min_level (or an explicit min_height) lifts the solid.
    min_height = 0.0
    min_level = parse_levels(tags.get("building:min_level"))
    if min_level is not None and min_level > 0:
        min_height = min_level * LEVEL_HEIGHT_M
    explicit = parse_length_m(tags.get("min_height"))
    if explicit is not None:
        min_height = explicit
    if not (0.0 < min_height < height):
        min_height = 0.0

    return height, source, min_height


def road_width_m(tags: dict[str, Any], highway: str) -> float:
    """03 road width: the ``width`` tag wins, else ``lanes * 3.5``, else the table.

    The result is clamped to a physical range, like the height and tree-radius
    rules: one mistyped ``width``/``lanes`` tag must not put an absurd (or
    non-finite) number on the frozen SceneGraph wire.
    """
    width = parse_length_m(tags.get("width"))
    if width is None:
        lanes = parse_levels(tags.get("lanes"))
        if lanes is not None and lanes > 0:
            width = lanes * LANE_WIDTH_M
    if width is None or not math.isfinite(width):
        width = HIGHWAY_WIDTH_M.get(highway, HIGHWAY_WIDTH_M["residential"])
    return min(max(width, MIN_ROAD_WIDTH_M), MAX_ROAD_WIDTH_M)


def road_class(highway: str) -> str:
    return HIGHWAY_CLASS.get(highway, "residential")


def classify_coverage(building_count: int, footprint_area_m2: float, crop_area_m2: float) -> str:
    """03 coverage classification.

    ``good`` needs both the count and the 4% footprint share; a dense-count but
    thin-footprint crop (a park with 200 sheds) falls back to ``sparse``.
    """
    if building_count < COVERAGE_EMPTY_COUNT:
        return "empty"
    if building_count >= COVERAGE_GOOD_COUNT and crop_area_m2 > 0:
        if footprint_area_m2 >= COVERAGE_GOOD_AREA_FRACTION * crop_area_m2:
            return "good"
    return "sparse"


# ---------------------------------------------------------------------------
# element classification + coordinate pool
# ---------------------------------------------------------------------------


def _osm_id(element: dict[str, Any]) -> str:
    prefix = {"way": "w", "relation": "r", "node": "n"}.get(element.get("type", ""), "x")
    return f"{prefix}{element.get('id')}"


def _tags(element: dict[str, Any]) -> dict[str, Any]:
    tags = element.get("tags")
    return tags if isinstance(tags, dict) else {}


def _layer_of(element: dict[str, Any], tags: dict[str, Any]) -> str | None:
    kind = element.get("type")
    if kind == "node":
        return "tree" if tags.get("natural") == "tree" else None
    building = tags.get("building")
    if building and str(building).lower() not in {"no", "false"}:
        return "building"
    if kind == "way":
        highway = tags.get("highway")
        if highway in HIGHWAY_WIDTH_M:
            return "road"
    if tags.get("natural") == "water" or tags.get("waterway") == "riverbank":
        return "water"
    if tags.get("landuse") in GREEN_LANDUSE or tags.get("leisure") in GREEN_LEISURE:
        return "green"
    return None


def _building_relation_outer_ways(elements: Iterable[Any]) -> set[int]:
    """Way ids that are the outer ring of a building multipolygon relation.

    03 step 6 anticipates that "multipolygon relations and their member ways
    often both appear".  Old-style OSM tagging repeats ``building=*`` on the
    outer way, and that way has no inner rings - so if it survives as its own
    footprint the courtyard gets printed solid (step 6 only catches the pair
    while the courtyard is under 5% of the outline, and step 7 unions the rest
    right back together).  The relation is authoritative, so its outer members
    are dropped as standalone buildings.

    Only members that actually carry geometry are registered: a relation whose
    rings Overpass did not return is not authoritative for anything.
    """
    refs: set[int] = set()
    for element in elements:
        if not isinstance(element, dict) or element.get("type") != "relation":
            continue
        tags = _tags(element)
        if _layer_of(element, tags) != "building":
            continue
        for member in element.get("members") or []:
            if not isinstance(member, dict) or member.get("type") != "way":
                continue
            if str(member.get("role") or "") not in {"outer", ""}:
                continue
            geometry = member.get("geometry")
            if not isinstance(geometry, list) or len(geometry) < 2:
                continue
            ref = member.get("ref")
            if isinstance(ref, int) and not isinstance(ref, bool):
                refs.add(ref)
    return refs


class _CoordPool:
    """Collects every lon/lat in the response so the projection is one call."""

    def __init__(self) -> None:
        self._lon: list[float] = []
        self._lat: list[float] = []
        self._spans: list[tuple[int, int]] = []
        self._xy: np.ndarray | None = None

    def add(self, geometry: Sequence[dict[str, Any]] | None, minimum: int = 2) -> int | None:
        if not geometry:
            return None
        start = len(self._lon)
        count = 0
        for node in geometry:
            if not node:
                continue  # Overpass emits null for nodes outside the bbox
            lon = node.get("lon")
            lat = node.get("lat")
            if lon is None or lat is None:
                continue
            self._lon.append(float(lon))
            self._lat.append(float(lat))
            count += 1
        if count < minimum:
            del self._lon[start:]
            del self._lat[start:]
            return None
        self._spans.append((start, start + count))
        return len(self._spans) - 1

    def add_point(self, lon: Any, lat: Any) -> int | None:
        if lon is None or lat is None:
            return None
        start = len(self._lon)
        self._lon.append(float(lon))
        self._lat.append(float(lat))
        self._spans.append((start, start + 1))
        return len(self._spans) - 1

    def project(self, frame: LocalFrame) -> None:
        self._xy = frame.to_local(self._lon, self._lat)

    def coords(self, span: int) -> np.ndarray:
        assert self._xy is not None, "project() must run before coords()"
        start, end = self._spans[span]
        return self._xy[start:end]

    def __len__(self) -> int:
        return len(self._lon)


@dataclass
class _PolyElement:
    osm_id: str
    tags: dict[str, Any]
    outer: list[int] = field(default_factory=list)
    inner: list[int] = field(default_factory=list)


@dataclass
class _LineElement:
    osm_id: str
    tags: dict[str, Any]
    span: int


@dataclass
class _PointElement:
    osm_id: str
    tags: dict[str, Any]
    span: int


@dataclass
class _Footprint:
    osm_id: str
    geom: BaseGeometry
    height_m: float
    height_source: str
    min_height_m: float


# ---------------------------------------------------------------------------
# hygiene (03, seven steps, in order)
# ---------------------------------------------------------------------------


def _polygonal_parts(geom: BaseGeometry | None) -> list[Polygon]:
    """Step 3's filter: keep Polygon and MultiPolygon parts, drop lines/points."""
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom] if geom.area > 0 else []
    if isinstance(geom, MultiPolygon):
        return [p for p in geom.geoms if not p.is_empty and p.area > 0]
    parts: list[Polygon] = []
    for sub in getattr(geom, "geoms", []):
        parts.extend(_polygonal_parts(sub))
    return parts


def _orient_all(geom: BaseGeometry) -> BaseGeometry:
    """Step 4: exterior counter-clockwise, holes clockwise."""
    if isinstance(geom, Polygon):
        return orient(geom, sign=1.0)
    if isinstance(geom, MultiPolygon):
        return MultiPolygon([orient(p, sign=1.0) for p in geom.geoms])
    return geom


def _ring_polygon(coords: np.ndarray) -> Polygon | None:
    """Steps 1 and 2 for a single ring: drop < 4 nodes or zero area, close it."""
    if coords.shape[0] < 4:  # 03 step 1
        return None
    poly = Polygon(coords)  # shapely closes an unclosed ring (03 step 2)
    if poly.area <= 0:
        return None
    return poly


def _safe_union(geoms: Sequence[BaseGeometry]) -> BaseGeometry | None:
    """``unary_union`` that survives the dirtiest OSM input.

    Real Overpass data contains self-touching and side-location-conflict rings
    that make GEOS throw; retry once on the make_valid'd parts, then give up on
    the union and keep the largest part rather than dropping the feature.
    """
    parts = [g for g in geoms if g is not None and not g.is_empty]
    if not parts:
        return None
    if len(parts) == 1:
        return parts[0]
    try:
        return unary_union(parts)
    except GEOSException:
        fixed: list[Polygon] = []
        for geom in parts:
            fixed.extend(_polygonal_parts(make_valid(geom)))
        if not fixed:
            return None
        try:
            return unary_union(fixed)
        except GEOSException:  # pragma: no cover - GEOS gave up entirely
            return max(fixed, key=lambda g: g.area)


def _snap_to_grid(geom: BaseGeometry) -> BaseGeometry:
    """Snap-round onto the 1 mm emission grid (GEOS keeps the result valid).

    Doing this *before* validity is judged is what keeps a courtyard whose
    inner ring was drafted onto (or within a nanometre of) the outer edge: the
    epsilon-wide sliver ``difference`` leaves behind is collapsed by GEOS with
    the topology repaired, instead of surviving ``simplify`` and then turning
    into a ring self-intersection when the emitter rounds to millimetres.
    """
    try:
        snapped = set_precision(geom, EMIT_GRID_M)
    except GEOSException:  # pragma: no cover - GEOS robustness fallback
        return geom
    return geom if snapped is None or snapped.is_empty else snapped


def _clean(geom: BaseGeometry | None) -> BaseGeometry | None:
    """Steps 3, 4, 5: make_valid -> polygonal parts -> winding -> simplify.

    Ends on the 1 mm emission grid so every later step (dedupe, union, crop,
    emit) sees exactly the geometry that will be written out.
    """
    if geom is None or geom.is_empty:
        return None
    valid = geom if geom.is_valid else make_valid(geom)
    parts = _polygonal_parts(valid)
    if not parts:
        return None
    merged = parts[0] if len(parts) == 1 else _safe_union(parts)
    if merged is None:
        return None
    merged = _orient_all(merged)
    merged = merged.simplify(SIMPLIFY_TOLERANCE_M, preserve_topology=True)
    merged = _snap_to_grid(merged)
    parts = _polygonal_parts(merged)
    if not parts:
        return None
    merged = parts[0] if len(parts) == 1 else MultiPolygon(parts)
    return _orient_all(merged)


def _rings_from_lines(rings: list[np.ndarray]) -> list[Polygon]:
    """Assemble multipolygon member ways into closed rings."""
    lines = [LineString(c) for c in rings if c.shape[0] >= 2]
    if not lines:
        return []
    merged = linemerge(lines)
    pieces = [merged] if isinstance(merged, LineString) else list(getattr(merged, "geoms", []))
    closed: list[Polygon] = []
    for piece in pieces:
        coords = list(piece.coords)
        if len(coords) < 3:
            continue
        if coords[0] != coords[-1]:  # 03 step 2, at the relation level
            coords.append(coords[0])
        if len(coords) < 4:
            continue
        poly = Polygon(coords)
        if poly.area <= 0:
            continue
        # A member ring can be self-touching; fix it here or the relation-level
        # union throws a side-location conflict.
        closed.extend(_polygonal_parts(poly if poly.is_valid else make_valid(poly)))
    if closed:
        return closed
    return [p for p in (polygonize(lines)) if p.area > 0]


def _element_geometry(pool: _CoordPool, element: _PolyElement) -> BaseGeometry | None:
    """Build one (multi)polygon from a way, or from a relation's member rings."""
    if not element.inner and len(element.outer) == 1:
        poly = _ring_polygon(pool.coords(element.outer[0]))
        return _clean(poly)

    outers = _rings_from_lines([pool.coords(s) for s in element.outer])
    geom = _safe_union(outers)
    if geom is None:
        return None
    inners = _rings_from_lines([pool.coords(s) for s in element.inner])
    holes = _safe_union(inners)
    if holes is not None:
        try:
            geom = geom.difference(holes)
        except GEOSException:  # pragma: no cover - GEOS robustness fallback
            geom = make_valid(geom).difference(make_valid(holes))
    return _clean(geom)


class _UnionFind:
    def __init__(self, n: int) -> None:
        self._parent = list(range(n))

    def find(self, i: int) -> int:
        while self._parent[i] != i:
            self._parent[i] = self._parent[self._parent[i]]
            i = self._parent[i]
        return i

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self._parent[max(ra, rb)] = min(ra, rb)

    def groups(self) -> dict[int, list[int]]:
        out: dict[int, list[int]] = {}
        for i in range(len(self._parent)):
            out.setdefault(self.find(i), []).append(i)
        return out


def _merge_group(
    items: list[_Footprint],
    idx: Sequence[int],
    geom: BaseGeometry,
    keeper: int | None = None,
) -> _Footprint:
    """Representative of a merged group: max height wins (03 step 7).

    ``keeper`` names the member whose geometry ``geom`` is, so the emitted id
    always belongs to the emitted footprint; without it the id comes from the
    largest-area member, which is what the union of step 7 is closest to.
    """
    best = max(idx, key=lambda i: (items[i].height_m, items[i].geom.area))
    if keeper is None:
        keeper = max(idx, key=lambda i: items[i].geom.area)
    return _Footprint(
        osm_id=items[keeper].osm_id,
        geom=geom,
        height_m=items[best].height_m,
        height_source=items[best].height_source,
        min_height_m=min(items[i].min_height_m for i in idx),
    )


def _exterior_area(geom: BaseGeometry) -> float:
    """Area of a footprint ignoring its holes.

    Step 6 compares outlines, not net areas: a multipolygon relation and its
    outer member way describe the *same* building even though only the relation
    knows about the courtyard.
    """
    if isinstance(geom, Polygon) and geom.interiors:
        return Polygon(geom.exterior).area
    return geom.area


def _dedupe(items: list[_Footprint]) -> list[_Footprint]:
    """Step 6: centroids within 0.5 m and areas within 5% are the same building."""
    if len(items) < 2:
        return items
    centroids = [it.geom.centroid for it in items]
    areas = [it.geom.area for it in items]
    outlines = [_exterior_area(it.geom) for it in items]
    holes = [len(it.geom.interiors) if isinstance(it.geom, Polygon) else 0 for it in items]
    tree = STRtree(centroids)
    pairs = tree.query(centroids, predicate="dwithin", distance=DEDUPE_CENTROID_M)
    uf = _UnionFind(len(items))
    for a, b in zip(pairs[0], pairs[1]):
        i, j = int(a), int(b)
        if i >= j:
            continue
        big = max(outlines[i], outlines[j])
        if big <= 0:
            continue
        if abs(outlines[i] - outlines[j]) <= DEDUPE_AREA_RATIO * big:
            uf.union(i, j)
    out: list[_Footprint] = []
    for _root, idx in sorted(uf.groups().items()):
        if len(idx) == 1:
            out.append(items[idx[0]])
        else:
            # Keep the member that knows about the courtyards; among equals the
            # largest outline wins, as before.
            keeper = max(idx, key=lambda i: (holes[i], areas[i]))
            out.append(_merge_group(items, idx, items[keeper].geom, keeper))
    return out


def _union_overlapping(items: list[_Footprint]) -> list[_Footprint]:
    """Step 7: union footprints whose interiors genuinely overlap, keep max height.

    Buildings that only share a wall are left alone: merging a whole Paris block
    into one prism at the tallest member's height would flatten the skyline, and
    04's assemble step unions them anyway.
    """
    if len(items) < 2:
        return items
    geoms = [it.geom for it in items]
    areas = [g.area for g in geoms]
    tree = STRtree(geoms)
    candidates: set[tuple[int, int]] = set()
    for predicate in ("overlaps", "covers"):
        pairs = tree.query(geoms, predicate=predicate)
        for a, b in zip(pairs[0], pairs[1]):
            i, j = int(a), int(b)
            if i < j:
                candidates.add((i, j))
            elif j < i:
                candidates.add((j, i))
    uf = _UnionFind(len(items))
    for i, j in sorted(candidates):
        smaller = min(areas[i], areas[j])
        if smaller <= 0:
            continue
        try:
            shared = geoms[i].intersection(geoms[j]).area
        except GEOSException:  # pragma: no cover - GEOS robustness fallback
            continue
        if shared >= max(OVERLAP_MIN_AREA_M2, OVERLAP_MIN_RATIO * smaller):
            uf.union(i, j)
    out: list[_Footprint] = []
    for _root, idx in sorted(uf.groups().items()):
        if len(idx) == 1:
            out.append(items[idx[0]])
            continue
        merged = _clean(_safe_union([geoms[i] for i in idx]))
        if merged is None:
            out.append(items[max(idx, key=lambda i: areas[i])])
            continue
        out.append(_merge_group(items, idx, merged))
    return out


# ---------------------------------------------------------------------------
# emission
# ---------------------------------------------------------------------------


def _round_points(coords: Iterable[Sequence[float]]) -> list[tuple[float, float]]:
    """Round to mm and drop consecutive duplicate vertices."""
    out: list[tuple[float, float]] = []
    for point in coords:
        p = (round(float(point[0]), 3), round(float(point[1]), 3))
        if not out or out[-1] != p:
            out.append(p)
    return out


def _round_ring(coords: Iterable[Sequence[float]]) -> list[tuple[float, float]]:
    """As :func:`_round_points`, then drop the repeated closing vertex.

    DECISIONS.md [P1]: SceneGraph rings do not repeat the first vertex.
    """
    out = _round_points(coords)
    while len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out


_Rings = tuple[list[tuple[float, float]], list[list[tuple[float, float]]]]


def _rounded_rings(poly: Polygon) -> _Rings | None:
    """Round one polygon's rings to mm; ``None`` if that breaks its validity."""
    ring = _round_ring(poly.exterior.coords)
    if len(ring) < 3:
        return None
    holes: list[list[tuple[float, float]]] = []
    for interior in poly.interiors:
        hole = _round_ring(interior.coords)
        if len(hole) >= 3 and Polygon(hole).area >= MIN_FEATURE_AREA_M2:
            holes.append(hole)
    return (ring, holes) if Polygon(ring, holes).is_valid else None


def _rings_of(poly: Polygon) -> _Rings | None:
    """Contract form of a polygon: CCW exterior, CW holes, no closing vertex."""
    poly = orient(poly, sign=1.0)
    rounded = _rounded_rings(poly)
    if rounded is not None:
        return rounded

    # The mm rounding collapsed something into a self-intersection: repair it
    # with make_valid and emit the largest polygonal part, holes included,
    # rather than throwing the courtyards (or the whole part) away.
    ring = _round_ring(poly.exterior.coords)
    holes = [_round_ring(i.coords) for i in poly.interiors]
    try:
        repaired = _polygonal_parts(make_valid(Polygon(ring, [h for h in holes if len(h) >= 3])))
    except (GEOSException, ValueError):  # pragma: no cover - GEOS gave up
        repaired = []
    for part in sorted(repaired, key=lambda g: g.area, reverse=True):
        if part.area < MIN_FEATURE_AREA_M2:
            break
        rounded = _rounded_rings(orient(part, sign=1.0))
        if rounded is not None:
            return rounded

    # Last resort: keep the outline without its holes, or drop the part.
    if len(ring) >= 3 and Polygon(ring).is_valid:
        return ring, []
    return None


def _cropped_parts(geom: BaseGeometry, square: Polygon) -> list[Polygon]:
    """Clip to the crop square, then snap back onto the 1 mm emission grid.

    The intersection introduces fresh off-grid vertices along the cut edge, so
    without this the emitter would again be rounding geometry whose validity
    was judged at full precision.
    """
    out: list[Polygon] = []
    for part in clip_polygon(geom, square, MIN_FEATURE_AREA_M2):
        for piece in _polygonal_parts(_snap_to_grid(part)):
            if piece.area >= MIN_FEATURE_AREA_M2:
                out.append(piece)
    return out


class _UniqueIds:
    """Keeps emitted ids unique when one OSM way yields several cropped parts."""

    def __init__(self) -> None:
        self._seen: set[str] = set()

    def take(self, base: str) -> str:
        if base not in self._seen:
            self._seen.add(base)
            return base
        n = 1
        while f"{base}-{n}" in self._seen:
            n += 1
        candidate = f"{base}-{n}"
        self._seen.add(candidate)
        return candidate


# ---------------------------------------------------------------------------
# main entry point
# ---------------------------------------------------------------------------


def build_scene(raw: dict[str, Any], request: SceneRequest) -> SceneGraph:
    """Turn one raw Overpass response into a SceneGraph for ``request``."""
    frame = LocalFrame(request.lat, request.lon, request.rotation_deg)
    radius = float(request.radius_m)
    square = crop_square(radius)

    pool = _CoordPool()
    polys: dict[str, list[_PolyElement]] = {"building": [], "water": [], "green": []}
    lines: list[_LineElement] = []
    points: list[_PointElement] = []

    elements = raw.get("elements", [])
    outer_ways = _building_relation_outer_ways(elements)

    # -- 1. classify + collect -------------------------------------------
    for element in elements:
        if not isinstance(element, dict):
            continue
        tags = _tags(element)
        layer = _layer_of(element, tags)
        if layer is None:
            continue
        kind = element.get("type")
        if layer == "building" and kind == "way" and element.get("id") in outer_ways:
            continue  # the relation carries this outline, holes included
        osm_id = _osm_id(element)

        if layer == "tree":
            span = pool.add_point(element.get("lon"), element.get("lat"))
            if span is not None:
                points.append(_PointElement(osm_id, tags, span))
            continue

        if layer == "road":
            span = pool.add(element.get("geometry"), minimum=2)
            if span is not None:
                lines.append(_LineElement(osm_id, tags, span))
            continue

        entry = _PolyElement(osm_id, tags)
        if kind == "way":
            span = pool.add(element.get("geometry"), minimum=2)
            if span is None:
                continue
            entry.outer.append(span)
        elif kind == "relation":
            for member in element.get("members") or []:
                if not isinstance(member, dict) or member.get("type") != "way":
                    continue
                span = pool.add(member.get("geometry"), minimum=2)
                if span is None:
                    continue
                if member.get("role") == "inner":
                    entry.inner.append(span)
                else:
                    entry.outer.append(span)
            if not entry.outer:
                continue
        else:
            continue
        polys[layer].append(entry)

    # -- 2. project + rotate, one pass -----------------------------------
    pool.project(frame)

    # -- 3. hygiene ------------------------------------------------------
    footprints: list[_Footprint] = []
    for element in polys["building"]:
        geom = _element_geometry(pool, element)
        if geom is None:
            continue
        height, source, min_height = resolve_height(element.tags, element.osm_id)
        for part in _polygonal_parts(geom):
            if part.area < MIN_FEATURE_AREA_M2:
                continue
            footprints.append(_Footprint(element.osm_id, part, height, source, min_height))

    footprints = _dedupe(footprints)  # step 6
    footprints = _union_overlapping(footprints)  # step 7

    area_geoms: dict[str, list[Polygon]] = {}
    for layer in ("water", "green"):
        cleaned: list[Polygon] = []
        for element in polys[layer]:
            geom = _element_geometry(pool, element)
            if geom is None:
                continue
            cleaned.extend(p for p in _polygonal_parts(geom) if p.area >= MIN_FEATURE_AREA_M2)
        if len(cleaned) > 1:
            # Relations and their member ways both appear in the response, so
            # dissolve the layer instead of printing coincident slabs twice.
            dissolved = _clean(_safe_union(cleaned))
            cleaned = _polygonal_parts(dissolved) if dissolved is not None else cleaned
        area_geoms[layer] = cleaned

    # -- 4. crop, 5. emit ------------------------------------------------
    buildings: list[Building] = []
    building_ids = _UniqueIds()
    footprint_area = 0.0
    for item in footprints:
        for part in _cropped_parts(item.geom, square):
            rings = _rings_of(part)
            if rings is None:
                continue
            ring, holes = rings
            footprint_area += part.area
            height = round(item.height_m, 3)
            min_height = round(item.min_height_m, 3)
            if min_height >= height:  # rounding must never invert the solid
                min_height = 0.0
            buildings.append(
                Building(
                    id=building_ids.take(item.osm_id),
                    ring=ring,
                    holes=holes,
                    height_m=height,
                    height_source=item.height_source,
                    min_height_m=min_height,
                    is_tall=height >= TALL_HEIGHT_M,
                )
            )

    roads: list[Road] = []
    road_ids = _UniqueIds()
    for element in lines:
        coords = pool.coords(element.span)
        if coords.shape[0] < 2:
            continue
        line = LineString(coords).simplify(SIMPLIFY_TOLERANCE_M, preserve_topology=False)
        highway = str(element.tags.get("highway"))
        width = round(road_width_m(element.tags, highway), 3)
        if width <= 0:
            continue
        klass = road_class(highway)
        for part in clip_line(line, square, MIN_ROAD_LENGTH_M):
            path = _round_points(part.coords)
            if len(path) < 2:
                continue
            roads.append(
                Road(
                    id=road_ids.take(element.osm_id),
                    path=path,
                    width_m=width,
                    **{"class": klass},
                )
            )

    areas: dict[str, list[AreaFeature]] = {"water": [], "green": []}
    for layer in ("water", "green"):
        for geom in area_geoms[layer]:
            for part in _cropped_parts(geom, square):
                rings = _rings_of(part)
                if rings is None:
                    continue
                areas[layer].append(AreaFeature(ring=rings[0], holes=rings[1]))

    trees: list[Tree] = []
    for element in points:
        x, y = (float(v) for v in pool.coords(element.span)[0])
        if not in_square(x, y, radius):
            continue
        crown = parse_length_m(element.tags.get("diameter_crown"))
        radius_m = crown / 2.0 if crown else DEFAULT_TREE_RADIUS_M
        radius_m = min(max(radius_m, MIN_TREE_RADIUS_M), MAX_TREE_RADIUS_M)
        trees.append(Tree(x=round(x, 3), y=round(y, 3), radius_m=round(radius_m, 3)))

    tagged = sum(1 for b in buildings if b.height_source == "tag")
    count = len(buildings)
    stats = Stats(
        building_count=count,
        coverage=classify_coverage(count, footprint_area, (2.0 * radius) ** 2),
        height_tag_ratio=round(tagged / count, 6) if count else 0.0,
    )

    return SceneGraph(
        bounds=Bounds(min_x=-radius, min_y=-radius, max_x=radius, max_y=radius),
        center=Center(lat=request.lat, lon=request.lon),
        buildings=buildings,
        roads=roads,
        water=areas["water"],
        green=areas["green"],
        trees=trees,
        stats=stats,
    )
