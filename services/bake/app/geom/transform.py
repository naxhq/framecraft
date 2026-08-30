"""Shared print-transform math for FrameCraft.

This module is the SINGLE source of the scale / height / threshold math
described in ``04_PRINTABILITY_SPEC.md``.  The preview (browser) and the bake
(server) must never compute any of these numbers independently:
``apps/web/lib/transform.ts`` mirrors this file function-for-function, with
identical (snake_case) names, and ``services/bake/tests/test_transform.py`` +
``apps/web/lib/transform.test.ts`` pin the two implementations to each other
through ``fixtures/parity-expected.json`` within 0.01 mm.

Rules for anyone editing this file:

* PURE standard library.  No numpy, no shapely, no pydantic.  It is imported by
  the bake pipeline (where numpy/shapely are available) *and* conceptually
  mirrored into TypeScript, so every operation here has to be expressible with
  plain floats.
* Inputs are duck-typed (:class:`ParamsLike`, :class:`BuildingLike`, ...) so
  the generated pydantic models in ``app/contracts.py`` can be passed straight
  in without importing pydantic here.
* Every length that comes out of a ``*_mm`` function is PRINT millimetres.
  Every length that comes out of a ``*_m`` / ``*_ground_m`` function is GROUND
  metres.  ``scale`` is always millimetres of print per metre of ground.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Optional, Protocol, Sequence, Tuple

# --------------------------------------------------------------------------
# Constants, all from 04_PRINTABILITY_SPEC.md.  None of these are user
# parameters; PrintParams is frozen and does not carry them.
# --------------------------------------------------------------------------

#: Stage 2.2 border lip width, in mm.  Enters the scale formula when frame is on.
FRAME_WIDTH_MM = 6.0
#: Stage 2.2 border lip rise above the base top, in mm.
FRAME_LIP_MM = 2.0
#: Stage 2.1 bottom outer edge chamfer (45 deg), in mm.  Bake only.
CHAMFER_MM = 0.6
#: Stage 2.3 deliberate building/base overlap so the union is unambiguous, mm.
BUILDING_OVERLAP_MM = 0.2
#: Stage 2.3 clamp on printed building height, mm.
MIN_BUILDING_HEIGHT_MM = 0.6
#: Stage 1 water recess below the base top, mm.
WATER_RECESS_MM = 0.5
#: Stage 1 green raise above the base top, mm.
GREEN_RAISE_MM = 0.3
#: Stage 1 road emboss height above the base top, mm.
EMBOSS_MM = 0.4
#: Stage 1 upper bound on engrave depth, mm (the other bound is base/3).
ENGRAVE_MAX_MM = 0.6
#: Known-trap list: inset the crop square before the final clip, mm.
CROP_INSET_MM = 0.05
#: Stage 1 trees: minimum printed site radius, mm.
TREE_MIN_RADIUS_MM = 0.5
#: Stage 1 trees: cone height as a multiple of the site radius.
TREE_HEIGHT_FACTOR = 3.0
#: Stage 1 trees: hard cap, keeping the largest.
TREE_CAP = 2000
#: Stage 1 trees: "model as an 8-sided cone".  The side count is part of the
#: PRINTED size of a tree (an 8-gon of circumradius r is only 2 r cos(pi/8)
#: wide across its flats), so :func:`tree_min_radius_mm` needs it and both
#: implementations must agree on it.
TREE_SIDES = 8
#: Stage 4 "Bounding box": Z must stay under this many millimetres.  Duplicated
#: from ``app/validate/checks.py`` (which owns the validator) so this module
#: stays free of every other import; ``tests/test_transform.py`` asserts the two
#: constants are equal.
MAX_HEIGHT_MM = 60.0
#: 02_TECH_SPEC.md: is_tall is height_m >= 40 and is computed in the SceneGraph.
TALL_BUILDING_M = 40.0

#: Threshold multipliers on the nozzle diameter (04, "Derived thresholds").
MIN_WALL_NOZZLES = 2.0
MIN_GAP_NOZZLES = 1.5
MIN_DETAIL_NOZZLES = 1.0


# --------------------------------------------------------------------------
# Structural types.  These describe the frozen contract objects without
# importing them, so this module stays stdlib-only.
# --------------------------------------------------------------------------


class ParamsLike(Protocol):
    """Structural view of ``PrintParams``."""

    plate_mm: float
    base_thickness_mm: float
    nozzle_mm: float
    small_scale: float
    large_scale: float
    terrain_exaggeration: float
    road_mode: str
    road_scale: float
    trees: bool
    water: bool
    frame: bool


class BuildingLike(Protocol):
    """Structural view of ``SceneGraph.buildings[]`` (only what we read)."""

    height_m: float
    is_tall: bool


class RoadLike(Protocol):
    """Structural view of ``SceneGraph.roads[]`` (only what we read)."""

    width_m: float


class TreeLike(Protocol):
    """Structural view of ``SceneGraph.trees[]`` (only what we read)."""

    radius_m: float


class BoundsLike(Protocol):
    """Structural view of ``SceneGraph.bounds``."""

    min_x: float
    min_y: float
    max_x: float
    max_y: float


class SceneLike(Protocol):
    """Structural view of a ``SceneGraph`` for the height guard only.

    ``bounds`` is deliberately absent: :func:`predicted_top_mm` takes the ground
    radius as an argument so a caller that already resolved it (the preview
    holds it in a memo) does not resolve it twice.
    """

    buildings: Sequence[BuildingLike]
    trees: Sequence[TreeLike]


@dataclass(frozen=True)
class Thresholds:
    """Minimum-feature thresholds expressed in GROUND metres."""

    min_wall: float
    min_gap: float
    min_detail: float


@dataclass(frozen=True)
class Extents:
    """An axis-aligned square region of the plate, in print millimetres."""

    min_x: float
    min_y: float
    max_x: float
    max_y: float
    size: float


@dataclass(frozen=True)
class FrameGeometry:
    """The border lip, in print millimetres.  ``enabled`` mirrors params.frame."""

    enabled: bool
    width_mm: float
    outer_half_mm: float
    inner_half_mm: float
    bottom_mm: float
    top_mm: float


# --------------------------------------------------------------------------
# Scale and thresholds
# --------------------------------------------------------------------------


def usable_span_mm(params: ParamsLike) -> float:
    """Plate width available to the model, in mm.

    04: ``usable = plate_mm - (2 * frame_width_mm if frame else 0)``.
    """
    return float(params.plate_mm) - (2.0 * FRAME_WIDTH_MM if params.frame else 0.0)


def scale_mm_per_m(params: ParamsLike, radius_m: float) -> float:
    """Print millimetres per ground metre.

    04 states ``scale = usable / (span_m * 1000)`` as a dimensionless mm/mm
    ratio; this function returns the same quantity multiplied by 1000, i.e.
    mm of print per metre of ground, because every downstream formula in 04
    immediately multiplies the dimensionless scale by 1000 again.

    Worked example from 04: a 1.8 km span on a 180 mm plate with the frame off
    is 1:10000, i.e. 0.1 mm/m.
    """
    span_m = 2.0 * float(radius_m)
    if span_m <= 0.0:
        raise ValueError("radius_m must be positive")
    return usable_span_mm(params) / span_m


def radius_m_from_bounds(bounds: BoundsLike) -> float:
    """Ground radius implied by a SceneGraph's bounds, in metres.

    The preview must scale by the radius the *scene* was built with, not by
    whatever the radius slider currently reads, or a stale scene would render
    at the wrong size.
    """
    width = float(bounds.max_x) - float(bounds.min_x)
    height = float(bounds.max_y) - float(bounds.min_y)
    return max(width, height) / 2.0


def thresholds_ground_m(params: ParamsLike, scale: float) -> Thresholds:
    """Minimum wall / gap / detail sizes converted to GROUND metres."""
    if scale <= 0.0:
        raise ValueError("scale must be positive")
    nozzle = float(params.nozzle_mm)
    return Thresholds(
        min_wall=(MIN_WALL_NOZZLES * nozzle) / scale,
        min_gap=(MIN_GAP_NOZZLES * nozzle) / scale,
        min_detail=(MIN_DETAIL_NOZZLES * nozzle) / scale,
    )


def terrain_z_scale(params: ParamsLike) -> float:
    """Vertical scale applied to terrain elevation.

    Terrain from DEM is out of scope for the MVP (01) and the heightmap is
    flat, so this is 1.0 for every input.  ``params.terrain_exaggeration`` is
    accepted and carried through both implementations identically so the
    parameter, the code path and the parity test all exist the day the DEM
    fetcher is switched on.
    """
    float(params.terrain_exaggeration)
    return 1.0


def terrain_z_mm(elevation_m: float, params: ParamsLike, scale: float) -> float:
    """Print height of a terrain sample, in mm above the base top.

    Always 0.0 in the MVP because the heightmap is flat (elevation_m is 0).
    """
    return float(elevation_m) * scale * terrain_z_scale(params)


# --------------------------------------------------------------------------
# Base plate and frame
# --------------------------------------------------------------------------


def base_top_mm(params: ParamsLike) -> float:
    """Z of the top face of the base slab, in mm.  The slab starts at z=0."""
    return float(params.base_thickness_mm)


def plate_extents_mm(params: ParamsLike) -> Extents:
    """Outer extents of the printed plate, centred on the origin."""
    half = float(params.plate_mm) / 2.0
    return Extents(
        min_x=-half, min_y=-half, max_x=half, max_y=half, size=float(params.plate_mm)
    )


def content_extents_mm(params: ParamsLike) -> Extents:
    """Region the city geometry may occupy, inset by CROP_INSET_MM.

    This is the ``usable`` square (plate minus the frame on both sides) minus
    the 0.05 mm inset from 04's trap list, which keeps a footprint that lands
    exactly on the crop edge from producing a zero-thickness wall.
    """
    half = usable_span_mm(params) / 2.0 - CROP_INSET_MM
    return Extents(min_x=-half, min_y=-half, max_x=half, max_y=half, size=2.0 * half)


def frame_geometry_mm(params: ParamsLike) -> FrameGeometry:
    """The border lip.  ``enabled`` is False when the frame toggle is off."""
    outer_half = float(params.plate_mm) / 2.0
    top = base_top_mm(params)
    return FrameGeometry(
        enabled=bool(params.frame),
        width_mm=FRAME_WIDTH_MM,
        outer_half_mm=outer_half,
        inner_half_mm=outer_half - FRAME_WIDTH_MM,
        bottom_mm=top,
        top_mm=top + FRAME_LIP_MM,
    )


# --------------------------------------------------------------------------
# Buildings
# --------------------------------------------------------------------------


def building_height_scale(building: BuildingLike, params: ParamsLike) -> float:
    """The height multiplier that applies to this building.

    ``is_tall`` is computed once in the SceneGraph (02) and never recomputed.
    """
    return float(params.large_scale if building.is_tall else params.small_scale)


def building_top_mm(building: BuildingLike, params: ParamsLike, scale: float) -> float:
    """Z of the roof, in mm.  04 stage 2.3, including the 0.6 mm clamp."""
    raw = float(building.height_m) * scale * building_height_scale(building, params)
    return base_top_mm(params) + max(MIN_BUILDING_HEIGHT_MM, raw)


def building_bottom_mm(params: ParamsLike) -> float:
    """Z the bake extrudes buildings FROM, in mm: base_top - 0.2.

    The 0.2 mm overlap exists so the union with the base slab is unambiguous.
    The preview draws buildings from ``base_top_mm`` instead (there is no union
    to disambiguate and the overlap would be hidden inside the slab).
    """
    return base_top_mm(params) - BUILDING_OVERLAP_MM


def ring_area_m2(ring: Sequence[Sequence[float]]) -> float:
    """Absolute shoelace area of a ring, in square metres.

    Rings follow the frozen SceneGraph convention (DECISIONS, [P1]): the first
    vertex is NOT repeated as the last, so closure is implicit here.
    """
    n = len(ring)
    if n < 3:
        return 0.0
    total = 0.0
    for i in range(n):
        x1, y1 = ring[i][0], ring[i][1]
        nxt = ring[(i + 1) % n]
        total += x1 * nxt[1] - nxt[0] * y1
    return abs(total) / 2.0


def ring_perimeter_m(ring: Sequence[Sequence[float]]) -> float:
    """Perimeter of an implicitly-closed ring, in metres."""
    n = len(ring)
    if n < 2:
        return 0.0
    total = 0.0
    for i in range(n):
        x1, y1 = ring[i][0], ring[i][1]
        nxt = ring[(i + 1) % n]
        dx = nxt[0] - x1
        dy = nxt[1] - y1
        total += (dx * dx + dy * dy) ** 0.5
    return total


def building_char_width_m(area_m2: float, perimeter_m: float) -> float:
    """Hydraulic diameter ``4 * area / perimeter`` (04 stage 1, buildings 1)."""
    if perimeter_m <= 0.0:
        return 0.0
    return 4.0 * float(area_m2) / float(perimeter_m)


def building_dilation_m(char_width_m: float, thresholds: Thresholds) -> float:
    """Buffer distance that brings a thin footprint up to the min wall.

    04 stage 1, buildings 2: ``d = (min_wall_ground - w) / 2``, never negative.
    """
    return max(0.0, (thresholds.min_wall - float(char_width_m)) / 2.0)


def building_dropped(area_m2: float, dilation_m: float, thresholds: Thresholds) -> bool:
    """04 stage 1, buildings 3: drop anything still smaller than min_detail^2.

    The exact post-dilation area needs a real 2D buffer, which neither the pure
    Python side nor the browser runs here; both approximate it as the area of a
    square of the same area grown by ``2 * d`` on the diagonal, which is the
    cheapest predicate the two implementations can agree on exactly.
    """
    side = float(area_m2) ** 0.5 + 2.0 * float(dilation_m)
    return side * side < thresholds.min_detail * thresholds.min_detail


# --------------------------------------------------------------------------
# Roads
# --------------------------------------------------------------------------


def road_width_ground_m(
    road: RoadLike, params: ParamsLike, thresholds: Thresholds
) -> float:
    """Printed road width in GROUND metres, after the min-feature clamp.

    04 stage 1, roads 1 buffers the centreline by
    ``max(width_m, min_wall_ground) / 2``; the road-scale slider multiplies the
    OSM width before that clamp (01: "Width multiplier before min-feature
    clamp").
    """
    return max(float(road.width_m) * float(params.road_scale), thresholds.min_wall)


def road_z_mm(params: ParamsLike) -> Optional[float]:
    """Road surface Z relative to the base top, in mm.

    engrave -> negative, ``-min(0.6, base_thickness/3)``;
    emboss  -> ``+0.4``;
    off     -> ``None`` (no road geometry at all).
    """
    mode = params.road_mode
    if mode == "off":
        return None
    if mode == "emboss":
        return EMBOSS_MM
    if mode == "engrave":
        return -min(ENGRAVE_MAX_MM, float(params.base_thickness_mm) / 3.0)
    raise ValueError("unknown road_mode: " + repr(mode))


# --------------------------------------------------------------------------
# Water and green
# --------------------------------------------------------------------------


def water_z_mm(params: ParamsLike) -> Optional[float]:
    """Water Z relative to the base top, in mm, or None when toggled off."""
    if not params.water:
        return None
    return -WATER_RECESS_MM


def green_z_mm(params: ParamsLike) -> float:
    """Green surface Z relative to the base top, in mm.

    PrintParams is frozen and has no green toggle, so green is always on.
    """
    return GREEN_RAISE_MM


def area_dropped(area_m2: float, thresholds: Thresholds) -> bool:
    """04 stage 1: water/green under ``min_detail_ground ** 2`` is dropped."""
    return float(area_m2) < thresholds.min_detail * thresholds.min_detail


# --------------------------------------------------------------------------
# Trees
# --------------------------------------------------------------------------


def tree_radius_mm(tree: TreeLike, scale: float) -> float:
    """Printed site radius of a tree, in mm."""
    return float(tree.radius_m) * scale


def tree_visible(tree: TreeLike, scale: float) -> bool:
    """04 stage 1, trees: only emit when the scaled radius reaches 0.5 mm.

    The "does not intersect a building or road footprint" half of 04's rule is
    a 2D predicate the bake evaluates with shapely; the preview cannot and does
    not run it, which is one of the documented preview approximations.
    """
    return tree_radius_mm(tree, scale) >= TREE_MIN_RADIUS_MM


def tree_min_radius_mm(params: ParamsLike) -> float:
    """Smallest printed site radius an 8-gon cone may have, in millimetres.

    04 caps the tree radius at 0.5 mm printed and says nothing about the nozzle,
    but an 8-gon of circumradius ``r`` is only ``2 * r * cos(pi/8)`` wide across
    its flats, so at the 0.5 mm floor a tree's *base* is 0.92 mm - under one
    extruded bead for every nozzle from 0.5 mm up.  The floor is therefore
    raised to whatever puts a full minimum wall across the base of the cone; at
    the default 0.4 mm nozzle that is 0.433 mm, so 04's 0.5 mm still binds and
    nothing changes.

    Lives here, not only in the bake, because a tree the bake drops must not be
    a tree the preview draws (DECISIONS [P5-web]).
    """
    by_nozzle = (MIN_WALL_NOZZLES * float(params.nozzle_mm)) / (
        2.0 * math.cos(math.pi / TREE_SIDES)
    )
    return max(TREE_MIN_RADIUS_MM, by_nozzle)


def tree_visible_for(tree: TreeLike, params: ParamsLike, scale: float) -> bool:
    """:func:`tree_visible` plus the nozzle-aware floor.

    This is the predicate the bake and the preview both filter on.
    :func:`tree_visible` keeps its two-argument signature (it is 04's literal
    rule and the parity fixture pins it); this one adds the printer.
    """
    return tree_radius_mm(tree, scale) >= tree_min_radius_mm(params)


def tree_height_mm(tree: TreeLike, scale: float) -> float:
    """Cone height, 3x the printed radius (04 stage 1, trees)."""
    return TREE_HEIGHT_FACTOR * tree_radius_mm(tree, scale)


def select_tree_indices(trees: Sequence[TreeLike], scale: float) -> List[int]:
    """Indices of the trees that actually get emitted.

    Visible ones only, capped at ``TREE_CAP`` by keeping the largest radius.
    Ties break on the original index so both implementations agree exactly.
    The result is returned in ascending original-index order.
    """
    visible = [i for i, t in enumerate(trees) if tree_visible(t, scale)]
    visible.sort(key=lambda i: (-float(trees[i].radius_m), i))
    return sorted(visible[:TREE_CAP])


def select_tree_indices_for(
    trees: Sequence[TreeLike], params: ParamsLike, scale: float
) -> List[int]:
    """:func:`select_tree_indices` with the nozzle-aware floor applied.

    Same ordering rules, so at the default nozzle (where the floor is 0.433 mm
    and 04's 0.5 mm still binds) it returns exactly the same indices.
    """
    visible = [i for i, t in enumerate(trees) if tree_visible_for(t, params, scale)]
    visible.sort(key=lambda i: (-float(trees[i].radius_m), i))
    return sorted(visible[:TREE_CAP])


# --------------------------------------------------------------------------
# Convenience aggregates used by both sides
# --------------------------------------------------------------------------


def building_footprint_metrics(
    ring: Sequence[Sequence[float]],
    holes: Sequence[Sequence[Sequence[float]]],
    thresholds: Thresholds,
) -> Tuple[float, float, float, float]:
    """``(area_m2, perimeter_m, char_width_m, dilation_m)`` for one footprint.

    Holes subtract from the area and add to the perimeter, which is what the
    hydraulic diameter of a multiply-connected footprint means.
    """
    area = ring_area_m2(ring)
    perimeter = ring_perimeter_m(ring)
    for hole in holes:
        area -= ring_area_m2(hole)
        perimeter += ring_perimeter_m(hole)
    area = max(0.0, area)
    char_width = building_char_width_m(area, perimeter)
    return area, perimeter, char_width, building_dilation_m(char_width, thresholds)


# --------------------------------------------------------------------------
# Whole-model height (04 stage 4, "Bounding box")
# --------------------------------------------------------------------------


def predicted_top_mm(scene: SceneLike, params: ParamsLike, radius_m: float) -> float:
    """Highest Z the finished model can reach, in mm, without building it.

    Every term is one of the functions above, i.e. exactly what the preview
    draws with, so this number is the height the user is looking at.  It is an
    UPPER bound on the baked height: stage 1 can lower a tower (a merged block
    takes the area-weighted 80th percentile of the heights it swallowed) and can
    drop a footprint entirely, but nothing in the pipeline makes a solid taller.

    Trees are counted with :func:`tree_visible` rather than
    :func:`tree_visible_for` on purpose: the nozzle-aware floor only ever drops
    trees, so ignoring it keeps the bound an upper bound, and the bake's guard
    reads the same number.  ``>= MAX_HEIGHT_MM`` is the refusal, matching 04
    stage 4's "Z under 60 mm".
    """
    scale = scale_mm_per_m(params, radius_m)
    base_top = base_top_mm(params)
    top = base_top
    frame = frame_geometry_mm(params)
    if frame.enabled:
        top = max(top, frame.top_mm)
    for building in scene.buildings:
        top = max(top, building_top_mm(building, params, scale))
    if params.trees:
        for tree in scene.trees:
            if tree_visible(tree, scale):
                top = max(top, base_top + tree_height_mm(tree, scale))
    return top


def model_too_tall(scene: SceneLike, params: ParamsLike, radius_m: float) -> bool:
    """True when the bake will refuse this model on 04's 60 mm Z ceiling."""
    return predicted_top_mm(scene, params, radius_m) >= MAX_HEIGHT_MM
