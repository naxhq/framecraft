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

import json
import math
from dataclasses import dataclass, replace
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Optional, Protocol, Sequence, Tuple

from app.geom import tokens as TOK

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

#: A hero building is never printed SHORTER than its true relative height, but it
#: still grows with everyone else: its multiplier is ``max(1.0, the multiplier
#: its class would get)``.  The floor is 1.0 because 1.0 is "true relative
#: height" - the height the SceneGraph measured, scaled by nothing.
HERO_MIN_HEIGHT_SCALE = 1.0
#: ``hero_mode`` values that give a hero its true height.
HERO_TRUE_HEIGHT_MODES = ("true_height", "both")
#: ``hero_mode`` values that give a hero its own colour (i.e. its own 3MF part).
HERO_OWN_COLOR_MODES = ("own_color", "both")
#: ``color_mode`` value that makes the bake write one 3MF object per layer.
COLOR_MODE_PARTS = "parts"


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
    """Structural view of ``SceneGraph.buildings[]`` (only what we read).

    ``id`` is read through :func:`getattr` everywhere in this module, never as an
    attribute access, so a carrier that has no id - ``thicken.HeightSpec``, a
    merged block, a test stub - is still a perfectly good ``BuildingLike``.  Only
    the hero predicates look at it.
    """

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


def min_wall_mm(params: ParamsLike) -> float:
    """04's ``min_wall_mm = 2 * nozzle``: two perimeters, in PRINT mm.

    This is the number the Stage 1 repair widens to, the number Stage 4 fails
    under nine tenths of, and the number the preview HUD divides by the scale
    to say "widened to the X m minimum wall".  It exists as a function because
    ``2 * nozzle`` written out by hand in four places is four chances to drop
    the two -- and dropping it is invisible, because ``1 * nozzle`` is exactly
    :func:`min_detail_mm`, a real threshold that looks entirely plausible in a
    HUD string (DECISIONS [V2-P1]).
    """
    return MIN_WALL_NOZZLES * float(params.nozzle_mm)


def min_gap_mm(params: ParamsLike) -> float:
    """04's ``min_gap_mm = 1.5 * nozzle``, in PRINT mm.  Below this, gaps close."""
    return MIN_GAP_NOZZLES * float(params.nozzle_mm)


def min_detail_mm(params: ParamsLike) -> float:
    """04's ``min_detail_mm = 1.0 * nozzle``, in PRINT mm.  Below this, drop it."""
    return MIN_DETAIL_NOZZLES * float(params.nozzle_mm)


def thresholds_ground_m(params: ParamsLike, scale: float) -> Thresholds:
    """Minimum wall / gap / detail sizes converted to GROUND metres."""
    if scale <= 0.0:
        raise ValueError("scale must be positive")
    return Thresholds(
        min_wall=min_wall_mm(params) / scale,
        min_gap=min_gap_mm(params) / scale,
        min_detail=min_detail_mm(params) / scale,
    )


def terrain_z_scale(params: ParamsLike) -> float:
    """Vertical scale applied to terrain elevation.

    ``params.terrain_exaggeration`` (v1 field, range [0, 3], default 1.0),
    and nothing else.  This is THE ONE PLACE the exaggeration is applied
    ([V3-P3-G1]): the DEM grid the browser fetches stays in raw metres above
    the tile minimum, so moving the slider re-bakes without re-fetching a
    single tile, and no other module may multiply by it again.

    Before v3 this returned 1.0 for every input because the MVP heightmap was
    flat.  The DEM fetcher (``apps/web/lib/engine/terrain/tiles.ts``) is that
    fetcher, so the parameter is now live.  The default is 1.0, so every
    committed parity value is unchanged.
    """
    return float(params.terrain_exaggeration)


def terrain_z_mm(elevation_m: float, params: ParamsLike, scale: float) -> float:
    """Print height of a terrain sample, in mm above the base top.

    ``elevation_m`` is metres above the grid minimum, so this is 0.0 at the
    lowest point of the crop and the base slab keeps its full thickness there.
    """
    return float(elevation_m) * scale * terrain_z_scale(params)


# --------------------------------------------------------------------------
# Height exaggeration (PrintParams v3 ``height_exaggeration``)
#
# A separate knob from ``small_scale`` / ``large_scale``: those two multiply a
# building's height by its CLASS (tall or not), which is a step function at
# 40 m and cannot make a two-storey street readable without turning a tower
# into a spike.  This one is continuous in the height itself.
# --------------------------------------------------------------------------


#: Reference height the exaggeration curve pivots about, ground metres.  A
#: building of exactly this height is multiplied by ``multiplier`` whatever the
#: curve is, so the curve redistributes emphasis without changing the overall
#: size of the model.  50 m is about fifteen storeys: above the street wall of
#: every city this targets and well below its towers.
HEIGHT_EXAGGERATION_REF_M = 50.0

#: How hard ``curve = 1`` compresses.  The exponent is ``1 - curve * this``, so
#: the strongest curve is a 0.4 power law: a 400 m tower gains 2.9x less than a
#: 5 m shopfront does.  Bounded below 1 on purpose - at 1.0 the exponent would
#: reach 0 and every building would print at exactly the reference height.
HEIGHT_EXAGGERATION_CURVE_STRENGTH = 0.6


def exaggerated_height(
    h_m: float,
    multiplier: float,
    curve: float,
    h_ref: float = HEIGHT_EXAGGERATION_REF_M,
) -> float:
    """A real building height in metres, exaggerated for printing.

    ``curve = 0`` is the plain linear ``h * multiplier``, computed as exactly
    that expression so a default-constructed PrintParams cannot move a single
    bit of existing geometry.  ``curve`` in (0, 1] compresses the tall end:

        h' = multiplier * h_ref * (h / h_ref) ** (1 - curve * 0.6)

    which is continuous and strictly increasing in ``h`` for every legal
    ``curve``, exact at ``h = h_ref`` for every curve, and gives short
    buildings proportionally more than tall ones (the relative gain is
    ``multiplier * (h / h_ref) ** (-0.6 * curve)``, which is above the
    multiplier below the reference height and below it above).
    """
    height = float(h_m)
    factor = float(multiplier)
    bend = float(curve)
    if height <= 0.0:
        return 0.0
    if bend <= 0.0 or h_ref <= 0.0:
        return height * factor
    exponent = 1.0 - bend * HEIGHT_EXAGGERATION_CURVE_STRENGTH
    return factor * float(h_ref) * (height / float(h_ref)) ** exponent


def real_world_equivalent_m(
    h_m: float,
    multiplier: float,
    curve: float,
    h_ref: float = HEIGHT_EXAGGERATION_REF_M,
) -> float:
    """The inverse of :func:`exaggerated_height`.

    Given a height as the model SHOWS it (metres of unexaggerated building
    that would print to the same roof), return the real-world height that
    produced it, so the UI can write "at these settings a 25 m block reads as
    a 40 m one" from measured numbers rather than from a second formula
    ([V3-P3-G5]).  ``real_world_equivalent_m(exaggerated_height(h, m, c), m,
    c) == h`` to within floating point for every legal ``m`` and ``c``.
    """
    height = float(h_m)
    factor = float(multiplier)
    bend = float(curve)
    if height <= 0.0 or factor <= 0.0:
        return 0.0
    if bend <= 0.0 or h_ref <= 0.0:
        return height / factor
    exponent = 1.0 - bend * HEIGHT_EXAGGERATION_CURVE_STRENGTH
    return float(h_ref) * (height / (factor * float(h_ref))) ** (1.0 / exponent)


def height_exaggeration_multiplier(params: ParamsLike) -> float:
    """``params.height_exaggeration.multiplier``, defaulting to 1.0."""
    group = getattr(params, "height_exaggeration", None)
    if group is None:
        return 1.0
    return float(getattr(group, "multiplier", 1.0))


def height_exaggeration_curve(params: ParamsLike) -> float:
    """``params.height_exaggeration.curve``, defaulting to 0.0 (linear)."""
    group = getattr(params, "height_exaggeration", None)
    if group is None:
        return 0.0
    return float(getattr(group, "curve", 0.0))


def exaggerated_height_for(h_m: float, params: ParamsLike) -> float:
    """:func:`exaggerated_height` with the parameters read off ``params``.

    Short-circuits to the input at the v1/v2 defaults (1.0, 0.0) so nothing
    downstream can drift by a rounding step while the feature is off.
    """
    factor = height_exaggeration_multiplier(params)
    bend = height_exaggeration_curve(params)
    if factor == 1.0 and bend <= 0.0:
        return float(h_m)
    return exaggerated_height(h_m, factor, bend)


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
    """Z of the roof, in mm.  04 stage 2.3, including the 0.6 mm clamp.

    Hero-free by construction: :func:`building_top_mm_for` with ``is_hero=False``
    is this exact expression, and every v1 caller keeps calling this one.
    """
    return building_top_mm_for(building, params, scale, False)


# --------------------------------------------------------------------------
# Hero buildings (PrintParams v2)
#
# Three params drive them and all three are optional on the wire, so every
# accessor here reads through ``getattr`` with the v1 default: a v1 PrintParams
# (or a duck-typed stub) must behave exactly as it did before hero buildings
# existed.  Nothing below changes a single number when ``hero_building_ids`` is
# empty, which is the default.
# --------------------------------------------------------------------------


def hero_ids(params: ParamsLike) -> Tuple[str, ...]:
    """The building ids the user picked, in the order they picked them."""
    ids = getattr(params, "hero_building_ids", None) or ()
    return tuple(str(i) for i in ids)


def hero_mode(params: ParamsLike) -> str:
    """``true_height`` | ``own_color`` | ``both`` (the v1-equivalent default is
    ``true_height``, which is a no-op while no hero is picked)."""
    return str(getattr(params, "hero_mode", None) or "true_height")


def hero_true_height(params: ParamsLike) -> bool:
    """True when the mode grants heroes their true relative height."""
    return hero_mode(params) in HERO_TRUE_HEIGHT_MODES


def hero_own_color(params: ParamsLike) -> bool:
    """True when the mode gives each hero its own colour, i.e. its own part."""
    return hero_mode(params) in HERO_OWN_COLOR_MODES


def hero_height_ids(params: ParamsLike) -> frozenset:
    """Ids whose PRINTED HEIGHT is the hero height.

    Empty unless the mode grants it, so ``own_color`` alone changes no height.
    Hoisted out of the loops below because a scene can hold thousands of
    buildings and this set holds at most twelve.
    """
    if not hero_true_height(params):
        return frozenset()
    return frozenset(hero_ids(params))


def is_hero_id(building_id, params: ParamsLike) -> bool:
    """True when this SceneGraph building id is one the user picked (any mode)."""
    if building_id is None:
        return False
    return str(building_id) in hero_ids(params)


def building_is_hero(building: BuildingLike, params: ParamsLike) -> bool:
    """True when this building prints at its hero height."""
    ident = getattr(building, "id", None)
    if ident is None:
        return False
    return str(ident) in hero_height_ids(params)


def hero_height_scale(building: BuildingLike, params: ParamsLike) -> float:
    """A hero's height multiplier: ``max(1.0, the multiplier of its class)``.

    Never reduced below its true relative height, and still grows with everyone
    else when the user raises the slider.
    """
    return max(HERO_MIN_HEIGHT_SCALE, building_height_scale(building, params))


def building_height_scale_for(
    building: BuildingLike, params: ParamsLike, is_hero: bool
) -> float:
    """:func:`building_height_scale`, or the hero rule when ``is_hero``."""
    if is_hero:
        return hero_height_scale(building, params)
    return building_height_scale(building, params)


def building_top_mm_for(
    building: BuildingLike, params: ParamsLike, scale: float, is_hero: bool
) -> float:
    """:func:`building_top_mm` with the hero multiplier when ``is_hero``.

    ``building_top_mm`` is this function at ``is_hero=False``; the two are one
    expression, so the parity fixture's existing ``top_mm`` values cannot move.
    """
    raw = float(building.height_m) * scale * building_height_scale_for(
        building, params, is_hero
    )
    return base_top_mm(params) + max(MIN_BUILDING_HEIGHT_MM, raw)


def building_top_mm_exaggerated(
    building: BuildingLike, params: ParamsLike, scale: float, is_hero: bool
) -> float:
    """:func:`building_top_mm_for` with ``height_exaggeration`` applied first.

    The exaggeration is applied to the GROUND height, before the print scale
    and before the 0.6 mm clamp, because it is a statement about the city and
    not about the printer: a 3 m hut must still be raised to something the
    nozzle can lay down after being exaggerated, not before ([V3-P3-G5]).  At
    the defaults (multiplier 1.0, curve 0.0) :func:`exaggerated_height_for`
    returns its input unchanged, so this IS ``building_top_mm_for``.
    """
    height = exaggerated_height_for(float(building.height_m), params)
    raw = height * scale * building_height_scale_for(building, params, is_hero)
    return base_top_mm(params) + max(MIN_BUILDING_HEIGHT_MM, raw)


def color_mode(params: ParamsLike) -> str:
    """``single`` | ``parts``.  The v1 default is ``single``."""
    return str(getattr(params, "color_mode", None) or "single")


def parts_mode(params: ParamsLike) -> bool:
    """True when the bake writes one 3MF object per layer."""
    return color_mode(params) == COLOR_MODE_PARTS


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
    by_nozzle = min_wall_mm(params) / (2.0 * math.cos(math.pi / TREE_SIDES))
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

    A hero building is counted at its HERO height (never below its true relative
    height), because that is the height the bake will print and the height the
    preview draws; a hero can only ever raise this number, so it stays an upper
    bound.
    """
    scale = scale_mm_per_m(params, radius_m)
    base_top = base_top_mm(params)
    top = base_top
    frame = frame_geometry_mm(params)
    if frame.enabled:
        top = max(top, frame.top_mm)
    heroes = hero_height_ids(params)
    for building in scene.buildings:
        is_hero = bool(heroes) and str(getattr(building, "id", "")) in heroes
        top = max(top, building_top_mm_for(building, params, scale, is_hero))
    if params.trees:
        for tree in scene.trees:
            if tree_visible(tree, scale):
                top = max(top, base_top + tree_height_mm(tree, scale))
    return top


def model_too_tall(scene: SceneLike, params: ParamsLike, radius_m: float) -> bool:
    """True when the bake will refuse this model on 04's 60 mm Z ceiling."""
    return predicted_top_mm(scene, params, radius_m) >= MAX_HEIGHT_MM


# ==========================================================================
# Frame lettering and ornaments (PrintParams v2)
#
# Everything below is PRINT MILLIMETRES only.  A letter cut into the frame lip
# is a printed object: the map scale does not touch its size, and the only
# place the map enters is the scale bar's LABEL.
#
# This is the layout half of the feature.  It decides which edge a string sits
# on, how big it is after auto-fitting, where its baseline anchor is, which way
# it reads and whether it can be printed at all; ``app/geom/lettering.py`` then
# produces the geometry from exactly these numbers, and the preview draws it
# from the mirror of exactly these numbers.
# ==========================================================================

#: Clearance kept between the text's ink and the two long edges of the 6 mm lip
#: band, in mm.  It is what stops a descender from cutting a notch into the
#: inner wall of the lip, and it leaves a rim of at least one nozzle - a rim the
#: printer can actually lay down - between the ink and each edge.
LIP_TEXT_MARGIN_MM = 0.5

#: Length reserved at BOTH ends of every edge, measured from the plate corner,
#: in mm: the 6 mm corner square (which belongs to two edges at once and holds
#: the north arrow) plus a millimetre of air.
LIP_CORNER_RESERVE_MM = 7.0

#: The contract's ``engravings[].size_mm`` bounds, repeated here because the
#: auto-fit has to clamp to them and this module never imports the contract.
#: ``tests/test_lettering.py`` asserts they still equal PARAM_RANGES.
TEXT_MIN_SIZE_MM = 1.5
TEXT_MAX_SIZE_MM = 8.0

#: Auto-fitted sizes are floored onto this grid so Python and TypeScript cannot
#: disagree in the last bit of a division, and so a fitted size is a number a
#: human can read back ("shrunk to 4.28 mm").
TEXT_FIT_GRID_MM = 0.01

#: Gap between the scale bar and anything sharing its edge, in mm.
ORNAMENT_GAP_MM = 2.0

#: What a stroke of text is widened to, in nozzles, per mode.
#:
#: An EMBOSSED stroke is material standing on the lip, so it gets 04's own
#: minimum wall - two perimeters - like every other solid in the model.
#:
#: An ENGRAVED stroke is a VOID cut into the lip, and a void is not a wall: what
#: has to be laid down is the material AROUND it.  One nozzle is what makes a
#: groove appear at all (04's own ``min_detail``, "below this, drop it"), and it
#: is the right target for the same reason 04's road layer is not stripped of
#: its thin parts and ``thicken.merge_recess_ridges`` measures the complement
#: instead (DECISIONS [P3]).
#:
#: The cost of the two-nozzle alternative was MEASURED, over 12 (face, string)
#: pairs at every size a 6 mm lip can hold (v2-03 audit, and the corrected
#: DECISIONS [V2-P5-fix] line).  It is NOT a higher refusal rate: strict refuses
#: 11 of 72 reachable sizes against the shipped rule's 12 of 76.  It is LETTER
#: SEPARATION.  A 0.8 mm groove eats 0.8 mm out of an inter-letter gap of about
#: half a millimetre, and for the strings whose ink height caps the auto-fit
#: under ~4.9 mm - a descender or a `Y`, which is 4 of the 12 pairs, "Chicago"
#: in all three faces among them - the whole word becomes ONE trench at every
#: size the lip permits.  The other 8 pairs do reach a size where strict is as
#: separated as shipped, so this is a deviation with a real price on the common
#: case, not a free win either way.  Measured on the shipped rule: Inter
#: "Chicago" fits at 5.16 mm with a 0.4875 mm narrowest groove, 0.7649 mm
#: narrowest ridge and every counter open.
ENGRAVE_STROKE_NOZZLES = MIN_DETAIL_NOZZLES
EMBOSS_STROKE_NOZZLES = MIN_WALL_NOZZLES

#: Scale bar: the printed length the automatic 1-2-5 search aims for, in mm.
#: The 1-2-5 series steps by at most 2.5x and this window spans 2.67x, so a
#: candidate always exists.
SCALE_BAR_MIN_MM = 15.0
SCALE_BAR_MAX_MM = 40.0
#: Requested size of the scale bar's label, before the band auto-fit.
SCALE_BAR_LABEL_SIZE_MM = 6.0
#: The scale bar's label always uses this face: the contract's ``scale_bar`` has
#: no font field, and a legend reads best in the neutral one.
SCALE_BAR_FACE = "sans"
#: Height of the scale bar's end ticks, as a multiple of the bar's thickness.
SCALE_BAR_TICK_FACTOR = 3.0

#: North arrow: the arrowhead's width as a fraction of its length.
NORTH_ARROW_WIDTH_RATIO = 0.6
#: How deep the notch at the back of the arrowhead cuts in, as a fraction of
#: its length.  This is what makes the glyph two triangles rather than one.
NORTH_ARROW_NOTCH_RATIO = 0.3

#: Underside mark: 0.3 mm deep, per the brief, and its own text size.
UNDERSIDE_MARK_DEPTH_MM = 0.3
UNDERSIDE_MARK_SIZE_MM = 6.0
UNDERSIDE_MARK_FACE = "mono"
#: Clearance the mark keeps from the chamfer and from the magnet pockets, mm.
UNDERSIDE_MARK_MARGIN_MM = 2.0

#: Material that must remain above ANY underside pocket, in mm.  A pocket that
#: leaves less than this is refused rather than printed as a hole through the
#: plate.
HANGER_MIN_ROOF_MM = 1.0

#: Keyhole hanger: an 8 mm round entry with a 4 mm slot running toward the top
#: edge, 2 mm deep.  The slot is ABOVE the round hole so the frame drops onto
#: the screw and hangs level.
KEYHOLE_HOLE_D_MM = 8.0
KEYHOLE_SLOT_W_MM = 4.0
KEYHOLE_SLOT_LEN_MM = 6.0
KEYHOLE_DEPTH_MM = 2.0
#: Distance from the plate's top edge to the far end of the slot, mm.
KEYHOLE_EDGE_MARGIN_MM = 6.0

#: Magnet hanger: four 6.1 x 3.1 mm cylindrical pockets (a 6 x 3 mm magnet plus
#: a tenth of a millimetre of fit), inset this far from each edge.
MAGNET_D_MM = 6.1
MAGNET_DEPTH_MM = 3.1
MAGNET_INSET_MM = 12.0

#: Which edges read which way for a viewer facing the hung frame: top and
#: bottom upright, the left edge bottom-to-top, the right edge top-to-bottom.
EDGE_ROTATION_DEG: Dict[str, float] = {
    "top": 0.0,
    "bottom": 0.0,
    "left": 90.0,
    "right": -90.0,
}

#: Where the metrics generated by ``scripts/gen_font_assets.py`` live.  The web
#: mirror imports byte-identical copies from ``apps/web/lib/fonts/``.
FONT_METRICS_DIR = Path(__file__).resolve().parents[1] / "fonts"


@lru_cache(maxsize=8)
def font_metrics(face: str) -> dict:
    """The generated metrics table for one face.  Cached; read-only."""
    path = FONT_METRICS_DIR / f"{face}.metrics.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _glyph(face: str, ch: str) -> Optional[dict]:
    return font_metrics(face)["glyphs"].get(str(ord(ch)))


def _g(value: float) -> str:
    """Python's ``%g`` for the values this module formats, mirrored in TS.

    Six significant digits with the trailing zeros stripped, which is what
    ``f"{x:g}"`` produces for every number that reaches these messages (a
    nozzle, a size, a window bound) and what ``String(Number(x.toPrecision(6)))``
    produces in the mirror.
    """
    text = f"{float(value):.6g}"
    return text


def _f1(value: float) -> str:
    """One decimal, ties away from zero.  ``f"{x:.1f}"`` is ties-to-EVEN, which
    disagrees with the mirror at every tie, so the shared token formatter is
    used instead."""
    return TOK.fixed(float(value), 1)


def _f2(value: float) -> str:
    """Two decimals, ties away from zero (see :func:`_f1`)."""
    return TOK.fixed(float(value), 2)


@dataclass(frozen=True)
class TextFit:
    """One string measured and auto-fitted for one place on the frame.

    Every length is PRINT millimetres; ``*_em`` quantities never leave this
    module.  ``refused`` is the whole feature's verdict for this string: the
    bake will not cut it and the preview must not draw it.
    """

    face: str
    text: str
    dropped: str
    requested_mm: float
    size_mm: float
    width_mm: float
    ink_top_mm: float
    ink_bottom_mm: float
    dilation_mm: float
    stroke_mm: float
    min_size_mm: float
    gap_size_mm: float
    refused: bool
    reason: str
    warnings: Tuple[str, ...] = ()


@dataclass(frozen=True)
class Placement:
    """Where a piece of geometry goes on the plate, in print mm.

    ``anchor_x``/``anchor_y`` is the local origin (for text: the baseline pen
    start), ``rotation_deg`` is applied counter-clockwise about that origin and
    ``mirror_x`` is applied first, in the local frame.
    """

    anchor_x: float
    anchor_y: float
    rotation_deg: float
    mirror_x: bool = False


@dataclass(frozen=True)
class EngravingLayout:
    index: int
    edge: str
    align: str
    mode: str
    depth_mm: float
    placement: Placement
    fit: TextFit


@dataclass(frozen=True)
class NorthArrowLayout:
    enabled: bool
    corner: str
    size_mm: float
    placement: Placement


@dataclass(frozen=True)
class ScaleBarLayout:
    enabled: bool
    edge: str
    length_m: float
    label: str
    bar_mm: float
    thickness_mm: float
    tick_mm: float
    span_mm: float
    placement: Placement
    label_fit: Optional[TextFit]
    warnings: Tuple[str, ...] = ()


@dataclass(frozen=True)
class UndersideMarkLayout:
    enabled: bool
    depth_mm: float
    placement: Placement
    fit: Optional[TextFit]


@dataclass(frozen=True)
class LetteringLayout:
    engravings: Tuple[EngravingLayout, ...]
    north_arrow: NorthArrowLayout
    scale_bar: ScaleBarLayout
    underside_mark: UndersideMarkLayout
    warnings: Tuple[str, ...]


# --------------------------------------------------------------------------
# Text measurement
# --------------------------------------------------------------------------


def supported_codepoint(face: str, ch: str) -> bool:
    """True when the shared metrics table can lay this character out."""
    return _glyph(face, ch) is not None


def filter_text(face: str, text: str) -> Tuple[str, str]:
    """(the layable text, the characters dropped) for one face.

    An unsupported character is DROPPED, not replaced by the font's ``.notdef``
    box: a hollow rectangle engraved into a frame says "this software is
    broken", while a missing character plus a warning naming it says what
    actually happened.  Both sides drop exactly the same set, because the set is
    the shared metrics table rather than the font's own coverage.
    """
    kept = []
    dropped = []
    for ch in text:
        if supported_codepoint(face, ch):
            kept.append(ch)
        else:
            dropped.append(ch)
    return "".join(kept), "".join(dropped)


def text_advance_em(face: str, text: str) -> float:
    """Sum of the advance widths of ``text``, in em.  No kerning (see below).

    Kerning is deliberately not applied: the browser mirror would need a shaping
    engine to reproduce it, and a frame legend is a legend, not typesetting.
    """
    upem = float(font_metrics(face)["units_per_em"])
    total = 0.0
    for ch in text:
        g = _glyph(face, ch)
        if g is not None:
            total += float(g["adv"])
    return total / upem


def text_ink_em(face: str, text: str) -> Tuple[float, float]:
    """(highest, lowest) ink of ``text`` relative to the baseline, in em.

    Measured over the characters actually used, so a string with no descender
    is allowed to be bigger than one with a ``g`` in it.
    """
    upem = float(font_metrics(face)["units_per_em"])
    top = 0.0
    bottom = 0.0
    for ch in text:
        g = _glyph(face, ch)
        if g is None:
            continue
        if float(g["top"]) > top:
            top = float(g["top"])
        if float(g["bot"]) < bottom:
            bottom = float(g["bot"])
    return top / upem, bottom / upem


def text_stem_em(face: str, text: str) -> float:
    """The NARROWEST dominant stroke among the characters of ``text``, in em.

    The narrowest one is what decides the dilation, because 04 stage 1 widens
    every feature to the minimum wall and the widest dilation is the one the
    thinnest glyph asks for.  A blank glyph (space) has no stroke and is
    ignored.
    """
    upem = float(font_metrics(face)["units_per_em"])
    stem = 0.0
    for ch in text:
        g = _glyph(face, ch)
        if g is None:
            continue
        value = float(g["stem"])
        if value <= 0.0:
            continue
        if stem == 0.0 or value < stem:
            stem = value
    return stem / upem


def text_gap_em(face: str, text: str) -> float:
    """The NARROWEST gap between two adjacent letters of ``text``, in em.

    Measured across the advance from one glyph's right ink edge to the next
    glyph's left one, so it is the ridge of lip that survives between two
    engraved letters.  Returns a large number for a string of fewer than two
    inked glyphs, which is the honest answer: there is no gap to lose.
    """
    upem = float(font_metrics(face)["units_per_em"])
    gap: Optional[float] = None
    previous: Optional[dict] = None
    for ch in text:
        g = _glyph(face, ch)
        if g is None:
            continue
        if previous is not None:
            value = (float(previous["adv"]) - float(previous["right"])) + float(g["left"])
            if gap is None or value < gap:
                gap = value
        previous = g
    if gap is None:
        return float("inf")
    return max(0.0, gap) / upem


def text_stroke_target_mm(params: ParamsLike, mode: str = "engrave") -> float:
    """What a stroke of text is widened to, in mm.  See the two constants above."""
    nozzles = EMBOSS_STROKE_NOZZLES if mode == "emboss" else ENGRAVE_STROKE_NOZZLES
    return nozzles * float(params.nozzle_mm)


def text_dilation_mm(
    face: str, text: str, size_mm: float, params: ParamsLike, mode: str = "engrave"
) -> float:
    """04 stage 1, buildings 2, applied to a glyph: ``(target - w) / 2``.

    ``w`` is the printed stroke width of the thinnest glyph in the string and
    ``target`` is :func:`text_stroke_target_mm`.  Zero when the type is already
    fat enough, which for an engraving at a 0.4 mm nozzle is about 4.7 mm.
    """
    stem_mm = text_stem_em(face, text) * float(size_mm)
    if stem_mm <= 0.0:
        return 0.0
    return max(0.0, (text_stroke_target_mm(params, mode) - stem_mm) / 2.0)


def text_stroke_mm(
    face: str, text: str, size_mm: float, params: ParamsLike, mode: str = "engrave"
) -> float:
    """The printed width of the thinnest stroke AFTER the Stage 1 dilation."""
    stem_mm = text_stem_em(face, text) * float(size_mm)
    if stem_mm <= 0.0:
        return 0.0
    return stem_mm + 2.0 * text_dilation_mm(face, text, size_mm, params, mode)


def text_width_mm(
    face: str, text: str, size_mm: float, params: ParamsLike, mode: str = "engrave"
) -> float:
    """Printed width of the inked block, including the Stage 1 dilation."""
    return text_advance_em(face, text) * float(size_mm) + 2.0 * text_dilation_mm(
        face, text, size_mm, params, mode
    )


def text_height_mm(
    face: str, text: str, size_mm: float, params: ParamsLike, mode: str = "engrave"
) -> float:
    """Printed height of the inked block, including the Stage 1 dilation."""
    top, bottom = text_ink_em(face, text)
    return (top - bottom) * float(size_mm) + 2.0 * text_dilation_mm(
        face, text, size_mm, params, mode
    )


def size_for_extent_mm(
    available_mm: float,
    extent_em: float,
    stem_em: float,
    params: ParamsLike,
    mode: str = "engrave",
) -> float:
    """Largest ``size_mm`` whose inked extent still fits ``available_mm``.

    The inked extent is ``extent_em * size + 2 * dilation(size)`` and the
    dilation is itself a falling function of the size, so the relation is
    piecewise linear with a kink where the strokes stop needing to be widened.
    Both branches are solved in closed form - no iteration, so Python and
    TypeScript cannot disagree by an iteration count.
    """
    if extent_em <= 0.0:
        return TEXT_MAX_SIZE_MM
    wall = text_stroke_target_mm(params, mode)
    plain = float(available_mm) / extent_em
    if stem_em <= 0.0 or plain * stem_em >= wall:
        return plain  # no dilation at that size: the simple ratio is exact
    if extent_em <= stem_em:  # pragma: no cover - an advance is never <= a stem
        return plain
    return (float(available_mm) - wall) / (extent_em - stem_em)


def floor_to_grid(value: float, grid: float = TEXT_FIT_GRID_MM) -> float:
    """Round DOWN onto the fit grid.  Identical in both languages for value > 0."""
    if grid <= 0.0:
        return value
    return math.floor(value / grid) * grid


def ceil_to_grid(value: float, grid: float = TEXT_FIT_GRID_MM) -> float:
    if grid <= 0.0:
        return value
    return math.ceil(value / grid) * grid


def _size_for_ridge(
    ridge_em: float, stem_em: float, target_mm: float, detail_mm: float
) -> float:
    """Smallest size at which a ridge of ``ridge_em`` survives the dilation.

    The dilation eats ``2 * d = target - stem * size`` out of the ridge (both
    sides of it grow), and what is left has to be at least one nozzle wide::

        ridge * size - (target - stem * size) >= detail

    which is linear in the size.  The other way to satisfy it is to need no
    dilation at all (``size >= target / stem``) and still have a nozzle of ridge
    (``size >= detail / ridge``), so the answer is the smaller of the two.
    """
    if ridge_em <= 0.0 or stem_em <= 0.0:
        return 0.0
    by_shrink = (target_mm + detail_mm) / (ridge_em + stem_em)
    by_native = max(target_mm / stem_em, detail_mm / ridge_em)
    return min(by_shrink, by_native)


def text_min_size_mm(
    face: str, text: str, params: ParamsLike, mode: str = "engrave"
) -> float:
    """The smallest printed size at which this string can be cut at all.

    Two ridges of lip have to survive widening the strokes to their target, and
    both of them are what makes the text readable rather than a trench:

    * every COUNTER - the hole in an ``o``, an ``a``, an ``e``, an ``8``, a
      ``B``, and for a dotted or slashed glyph the ring around the island inside
      it.  An ``o`` with no hole is not an ``o``;
    * every GAP between two adjacent letters.  Lose it and the word is one
      shape.

    Each is a closed form (:func:`_size_for_ridge`), linear in the size, so this
    is a maximum over the string of minima of closed forms - no bisection, and
    the same number on both sides to the last bit.  A string of one glyph with no
    counter constrains nothing and comes back 0.
    """
    target = text_stroke_target_mm(params, mode)
    detail = min_detail_mm(params)
    upem = float(font_metrics(face)["units_per_em"])
    # Every counter is measured against the STRING's stem, not the glyph's own:
    # the dilation is one distance for the whole string (the thinnest glyph is
    # what sets it), so a fat glyph with a small counter loses just as much of
    # that counter as the thin glyph beside it does.
    stem_em = text_stem_em(face, text)
    needed = 0.0
    for ch in text:
        g = _glyph(face, ch)
        if g is None or g.get("counter") is None:
            continue
        value = _size_for_ridge(float(g["counter"]) / upem, stem_em, target, detail)
        if value > needed:
            needed = value
    return ceil_to_grid(needed)


def text_gap_size_mm(
    face: str, text: str, params: ParamsLike, mode: str = "engrave"
) -> float:
    """The smallest size at which adjacent letters keep a nozzle between them.

    Below it the ink of one letter comes within a nozzle of the next and the two
    join up where they are closest.  Unlike a closed counter this is a WARNING,
    not a refusal, and the difference is what the gap actually looks like: the
    space between two letters is a wedge, widest at the x-height and narrowest
    at one end, so the pair touches over a fraction of a millimetre and stays
    perfectly legible.  ``thicken.merge_recess_ridges`` then hands that
    sub-nozzle tip to the groove (it could not be printed either way) and the
    Stage 4 ``lettering`` row measures what is left.

    The number itself is honest but pessimistic: it comes from the ink extents
    in the shared metrics table, i.e. from the CLOSEST approach of the two
    letters, and treats it as if the whole gap were that narrow.
    """
    return ceil_to_grid(
        _size_for_ridge(
            text_gap_em(face, text),
            text_stem_em(face, text),
            text_stroke_target_mm(params, mode),
            min_detail_mm(params),
        )
    )


def fit_text(
    face: str,
    text: str,
    requested_mm: float,
    available_mm: float,
    band_mm: float,
    params: ParamsLike,
    what: str = "engraving",
    mode: str = "engrave",
) -> TextFit:
    """Auto-fit one string into a length and a band, and judge its printability.

    Never clips: a string that overruns its edge is made SMALLER (and the fitted
    size is named in a warning), and a string that cannot be made small enough,
    or that would lose its counters at the size that fits, is REFUSED with a
    message naming the size that would work.
    """
    warnings: List[str] = []
    layable, dropped = filter_text(face, text)
    if dropped:
        warnings.append(
            f"{len(dropped)} character(s) not in the {face} metrics were dropped from "
            f"the {what}: {dropped}"
        )
    requested = min(max(float(requested_mm), TEXT_MIN_SIZE_MM), TEXT_MAX_SIZE_MM)
    if not layable.strip():
        return TextFit(
            face=face,
            text=layable,
            dropped=dropped,
            requested_mm=requested,
            size_mm=requested,
            width_mm=0.0,
            ink_top_mm=0.0,
            ink_bottom_mm=0.0,
            dilation_mm=0.0,
            stroke_mm=0.0,
            min_size_mm=0.0,
            gap_size_mm=0.0,
            refused=True,
            reason=f"the {what} is empty",
            warnings=tuple(warnings),
        )

    stem_em = text_stem_em(face, layable)
    advance_em = text_advance_em(face, layable)
    top_em, bottom_em = text_ink_em(face, layable)
    by_length = size_for_extent_mm(available_mm, advance_em, stem_em, params, mode)
    by_band = size_for_extent_mm(band_mm, top_em - bottom_em, stem_em, params, mode)
    fitted = floor_to_grid(min(requested, by_length, by_band))
    min_size = text_min_size_mm(face, layable, params, mode)
    gap_size = text_gap_size_mm(face, layable, params, mode)

    refused = False
    reason = ""
    if fitted < TEXT_MIN_SIZE_MM:
        refused = True
        limit = "edge" if by_length <= by_band else "6 mm lip band"
        reason = (
            f"the {what} does not fit the {limit} even at the smallest legal "
            f"{_g(TEXT_MIN_SIZE_MM)} mm: it would need "
            + _f2(max(0.0, floor_to_grid(min(by_length, by_band))))
            + " mm"
        )
        fitted = TEXT_MIN_SIZE_MM
    elif fitted < requested:
        warnings.append(
            f"the {what} was reduced from {_g(requested)} mm to {_f2(fitted)} mm to fit "
            + ("the edge" if by_length <= by_band else "the 6 mm lip band")
        )

    if not refused and fitted < min_size:
        refused = True
        reason = (
            f"at {_f2(fitted)} mm a {_g(float(params.nozzle_mm))} mm nozzle cannot cut this "
            f"{what} without closing a counter; it needs "
            f"{_f2(min_size)} mm"
        )
        if min_size > TEXT_MAX_SIZE_MM:
            reason += f", which is over the {_g(TEXT_MAX_SIZE_MM)} mm maximum"
        elif min_size > min(by_length, by_band):
            reason += ", which does not fit this edge: shorten the text or widen the plate"

    if not refused and fitted < gap_size:
        warnings.append(
            f"at {_f2(fitted)} mm the letters of this {what} come within a nozzle of "
            f"each other and will touch where they are closest; {_f2(gap_size)} mm "
            f"would keep them apart"
        )

    return TextFit(
        face=face,
        text=layable,
        dropped=dropped,
        requested_mm=requested,
        size_mm=fitted,
        width_mm=text_width_mm(face, layable, fitted, params, mode),
        ink_top_mm=top_em * fitted,
        ink_bottom_mm=bottom_em * fitted,
        dilation_mm=text_dilation_mm(face, layable, fitted, params, mode),
        stroke_mm=text_stroke_mm(face, layable, fitted, params, mode),
        min_size_mm=min_size,
        gap_size_mm=gap_size,
        refused=refused,
        reason=reason,
        warnings=tuple(warnings),
    )


# --------------------------------------------------------------------------
# The frame edges
# --------------------------------------------------------------------------


def frame_text_available(params: ParamsLike) -> bool:
    """True when the frame lip exists to carry edge text and ornaments.

    Edge engravings, the north arrow and the scale bar all live on the 6 mm lip.
    With ``frame`` off there is no lip, so they are skipped (with one warning
    listing them).  The underside mark and the hanger do not need the frame.
    """
    return bool(params.frame)


def edge_axis(edge: str) -> Tuple[float, float]:
    """Unit vector along the reading direction of one edge."""
    if edge == "top" or edge == "bottom":
        return (1.0, 0.0)
    if edge == "left":
        return (0.0, 1.0)
    if edge == "right":
        return (0.0, -1.0)
    raise ValueError("unknown edge: " + repr(edge))


def edge_up(edge: str) -> Tuple[float, float]:
    """Unit vector of the text's UP direction on one edge.

    It is ``R(rotation) * (0, 1)``: +y on the top and bottom edges (both read
    upright), -x on the left edge (which reads bottom-to-top) and +x on the
    right one (which reads top-to-bottom), i.e. the letters on the two side
    edges stand with their feet toward the middle of the picture.
    """
    theta = math.radians(EDGE_ROTATION_DEG[edge])
    return (-math.sin(theta), math.cos(theta))


def edge_band_center_mm(params: ParamsLike, edge: str) -> Tuple[float, float]:
    """Centre point of one edge's lip band, in plate mm."""
    offset = float(params.plate_mm) / 2.0 - FRAME_WIDTH_MM / 2.0
    if edge == "top":
        return (0.0, offset)
    if edge == "bottom":
        return (0.0, -offset)
    if edge == "left":
        return (-offset, 0.0)
    if edge == "right":
        return (offset, 0.0)
    raise ValueError("unknown edge: " + repr(edge))


def edge_usable_mm(params: ParamsLike) -> float:
    """Length of one edge that text may occupy, in mm.

    The plate minus the two corner squares (which belong to two edges at once
    and hold the north arrow) at either end.
    """
    return max(0.0, float(params.plate_mm) - 2.0 * LIP_CORNER_RESERVE_MM)


def lip_text_margin_mm(params: ParamsLike) -> float:
    """Clearance between the ink and each long edge of the lip band, in mm.

    Never under one nozzle: a rim thinner than the nozzle is a rim the printer
    cannot lay down, and the whole point of the margin is that a rim remains.
    """
    return max(LIP_TEXT_MARGIN_MM, min_detail_mm(params))


def edge_band_mm(params: ParamsLike) -> float:
    """Height of the band the ink must stay inside, in mm."""
    return FRAME_WIDTH_MM - 2.0 * lip_text_margin_mm(params)


def north_arrow_max_size_mm(params: ParamsLike) -> float:
    """Largest arrow the lip can hold, in mm.

    The glyph is TURNED by the scene rotation, so the bound is its circumradius
    - the base corner at ``(0.3, -0.5) * size``, further from the centre than
    the tip is - and not its length.  Bounding the length instead still clipped
    a rotated arrow: at 29 deg a "fitted" 5 mm arrow reached 89.524 mm across an
    89.5 mm keep region.  Rotation-independent on purpose: an ornament that
    changed size when the user rotated the map would be worse than one that is
    0.7 mm shorter than asked.

    Without any of this the arrow was simply clipped - a 6 mm arrow, the
    contract's own maximum, lost the last 0.5 mm of its point at rotation 0 -
    because unlike text the arrow had no fitting step at all (v2-03 audit,
    finding 9).
    """
    reach = math.hypot(NORTH_ARROW_WIDTH_RATIO / 2.0, 0.5)
    return max(0.0, edge_band_mm(params) / (2.0 * reach))


def edge_placement(
    params: ParamsLike,
    edge: str,
    align: str,
    fit: TextFit,
    span_lo: float,
    span_hi: float,
) -> Placement:
    """Anchor and rotation for one fitted string on one edge.

    ``span_lo``/``span_hi`` are the along-edge interval the string may occupy,
    measured from the plate centre in the reading direction; they are the whole
    usable edge unless a scale bar has taken part of it.
    """
    width = fit.width_mm
    if align == "start":
        block_lo = span_lo
    elif align == "end":
        block_lo = span_hi - width
    else:
        block_lo = (span_lo + span_hi) / 2.0 - width / 2.0
    # The ink starts one dilation before the pen origin, so the pen goes here:
    u = block_lo + fit.dilation_mm
    # Centre the INK block across the band: the dilation grows it symmetrically,
    # so it cancels and only the glyphs' own extents matter.
    v = -(fit.ink_top_mm + fit.ink_bottom_mm) / 2.0
    cx, cy = edge_band_center_mm(params, edge)
    ax, ay = edge_axis(edge)
    ux, uy = edge_up(edge)
    return Placement(
        anchor_x=cx + u * ax + v * ux,
        anchor_y=cy + u * ay + v * uy,
        rotation_deg=EDGE_ROTATION_DEG[edge],
    )


# --------------------------------------------------------------------------
# The scale bar
# --------------------------------------------------------------------------

#: The 1-2-5 mantissas the automatic scale bar picks from.
SCALE_BAR_MANTISSAS = (1.0, 2.0, 5.0)
#: Decades searched, i.e. 0.1 m to 5 000 km.  Wide enough that a candidate
#: always lands inside the printed window at any legal scale.
SCALE_BAR_DECADES = tuple(range(-1, 8))


def scale_bar_candidates() -> List[float]:
    """Every 1-2-5 round number of ground metres, ascending."""
    out: List[float] = []
    for decade in SCALE_BAR_DECADES:
        for mantissa in SCALE_BAR_MANTISSAS:
            out.append(mantissa * (10.0**decade))
    return out


def scale_bar_auto_length_m(scale_mm_per_m: float) -> float:
    """The longest 1-2-5 round distance whose printed bar lands in the window.

    04 has no rule for this; the window is [15, 40] mm because a bar under
    15 mm is decorative and one over 40 mm crowds a 100 mm plate.  The 1-2-5
    series steps by at most 2.5x while the window spans 2.67x, so one always
    fits, and the longest is preferred because a longer bar reads more
    precisely.
    """
    if not scale_mm_per_m > 0.0:
        return 0.0
    best = 0.0
    for length_m in scale_bar_candidates():
        printed = length_m * scale_mm_per_m
        if SCALE_BAR_MIN_MM <= printed <= SCALE_BAR_MAX_MM and length_m > best:
            best = length_m
    if best > 0.0:
        return best
    # Unreachable at any legal scale, but a caller may pass anything: fall back
    # to the candidate closest to the window rather than to nothing at all.
    def distance(length_m: float) -> float:
        printed = length_m * scale_mm_per_m
        if printed < SCALE_BAR_MIN_MM:
            return SCALE_BAR_MIN_MM - printed
        return printed - SCALE_BAR_MAX_MM

    return min(scale_bar_candidates(), key=lambda v: (distance(v), -v))


def scale_bar_label(length_m: float) -> str:
    """``500 m`` / ``2 km`` / ``2.5 km``.

    Formatted through the shared token helpers, so a bar labelled next to a
    ``{scale}`` engraving cannot round differently from it.
    """
    if length_m >= 1000.0:
        km = length_m / 1000.0
        if abs(km - TOK.round_half_up(km)) < 1e-9:
            return f"{TOK.round_half_up(km)} km"
        return TOK.fixed(km, 1) + " km"
    if abs(length_m - TOK.round_half_up(length_m)) < 1e-9:
        return f"{TOK.round_half_up(length_m)} m"
    return TOK.fixed(length_m, 1) + " m"


def scale_bar_thickness_mm(params: ParamsLike) -> float:
    """Stroke thickness of the bar itself, in mm: never under a minimum wall."""
    return max(min_wall_mm(params), 0.8)


# --------------------------------------------------------------------------
# The underside: mark, keyhole, magnets
# --------------------------------------------------------------------------


def hanger_min_base_mm(hanger: str) -> float:
    """Thinnest base plate that can carry this hanger, in mm.

    A keyhole is 2 mm deep and four magnet pockets are 3.1 mm deep; both must
    leave :data:`HANGER_MIN_ROOF_MM` of solid plate above them, or the pocket
    is a hole through the picture.  The bake refuses rather than prints such a
    plate.

    This is NOT the number to show a user: it ignores what the top side has
    already taken off the same plate.  :func:`underside_min_base_mm` composes
    the two, and that is what the editor displays.
    """
    if hanger == "keyhole":
        return KEYHOLE_DEPTH_MM + HANGER_MIN_ROOF_MM
    if hanger == "magnets":
        return MAGNET_DEPTH_MM + HANGER_MIN_ROOF_MM
    return 0.0


def underside_mark_min_base_mm() -> float:
    """Thinnest base plate that can carry the 0.3 mm underside mark, in mm."""
    return UNDERSIDE_MARK_DEPTH_MM + HANGER_MIN_ROOF_MM


def deepest_recess_mm(params: ParamsLike) -> float:
    """How far the deepest TOP-side recess reaches below the base top, in mm.

    An underside pocket is measured against what is left of the plate, and what
    is left is thinner wherever a lake or an engraved road has already taken
    material off the top.
    """
    depth = 0.0
    water = water_z_mm(params)
    if water is not None:
        depth = max(depth, -water)
    road = road_z_mm(params)
    if road is not None and road < 0.0:
        depth = max(depth, -road)
    return depth


def underside_min_base_mm(params: ParamsLike) -> float:
    """Thinnest base this parameter set can print with, in mm.

    The hanger and the mark are cut from below, the water and the engraved roads
    from above, and the material between them is what has to hold.  This is the
    number the bake refuses on, and the number the editor displays: the TS
    mirror is called by ``apps/web/lib/warnings.ts``'s
    ``undersideBlockMessage``, which turns it into the `block` warning that
    disables Bake, exactly as ``predicted_top_mm`` does for the 60 mm ceiling.
    (That sentence was aspirational until [V2-P7-fix]: the mirror existed and
    was unit-tested, and no component, warning or advisor called it, so a
    keyhole on the default 3 mm base was offered and then refused by the bake -
    v2-07 audit, finding 4.)
    """
    needed = 0.0
    hanger = str(getattr(params, "hanger", None) or "none")
    if hanger != "none":
        needed = max(needed, hanger_min_base_mm(hanger))
    mark = getattr(params, "underside_mark", None)
    if mark is not None and bool(getattr(mark, "enabled", False)):
        needed = max(needed, underside_mark_min_base_mm())
    if needed <= 0.0:
        return 0.0
    return needed + deepest_recess_mm(params)


def keyhole_center_mm(params: ParamsLike) -> Tuple[float, float]:
    """Centre of the keyhole's round entry, in plate mm (top centre).

    Measured back from the plate's top edge: the margin, then the rounded end of
    the slot (which is what the screw shank actually rests in), then the slot
    itself.  So the WHOLE hanger, cap included, stays a margin inside the edge.
    """
    y = (
        float(params.plate_mm) / 2.0
        - KEYHOLE_EDGE_MARGIN_MM
        - KEYHOLE_SLOT_W_MM / 2.0
        - KEYHOLE_SLOT_LEN_MM
    )
    return (0.0, y)


def magnet_centers_mm(params: ParamsLike) -> List[Tuple[float, float]]:
    """Centres of the four magnet pockets, in plate mm."""
    offset = float(params.plate_mm) / 2.0 - MAGNET_INSET_MM
    return [(-offset, -offset), (offset, -offset), (-offset, offset), (offset, offset)]


def underside_pocket_depth_mm(params: ParamsLike, kind: str) -> float:
    """Depth of one underside pocket below z = 0, in mm."""
    if kind == "mark":
        return UNDERSIDE_MARK_DEPTH_MM
    if kind == "keyhole":
        return KEYHOLE_DEPTH_MM
    if kind == "magnets":
        return MAGNET_DEPTH_MM
    raise ValueError("unknown underside pocket: " + repr(kind))


def underside_pockets(params: ParamsLike) -> List[str]:
    """Which underside pockets this parameter set asks for, deepest last."""
    out: List[str] = []
    mark = getattr(params, "underside_mark", None)
    if mark is not None and bool(getattr(mark, "enabled", False)):
        out.append("mark")
    hanger = str(getattr(params, "hanger", None) or "none")
    if hanger in ("keyhole", "magnets"):
        out.append(hanger)
    return out


def underside_band_mm(params: ParamsLike) -> Optional[Tuple[float, float]]:
    """The Z band the underside pockets occupy, or None when there are none."""
    depths = [underside_pocket_depth_mm(params, kind) for kind in underside_pockets(params)]
    if not depths:
        return None
    return (0.0, max(depths))


def underside_mark_available_mm(params: ParamsLike) -> float:
    """Width the underside mark may occupy, in mm.

    The chamfer takes 0.6 mm off each edge of the bottom face, and a magnet
    pocket takes the corners; the mark stops clear of both.
    """
    half = float(params.plate_mm) / 2.0
    limit = half - CHAMFER_MM - UNDERSIDE_MARK_MARGIN_MM
    if str(getattr(params, "hanger", None) or "none") == "magnets":
        limit = min(
            limit,
            half - MAGNET_INSET_MM - MAGNET_D_MM / 2.0 - UNDERSIDE_MARK_MARGIN_MM,
        )
    return max(0.0, 2.0 * limit)


# --------------------------------------------------------------------------
# The whole layout
# --------------------------------------------------------------------------


def engraving_list(params: ParamsLike) -> List[object]:
    return list(getattr(params, "engravings", None) or [])


def lettering_layout(
    params: ParamsLike, ctx: "TOK.TokenContext", rotation_deg: float = 0.0
) -> LetteringLayout:
    """Where every piece of text and every ornament goes, and whether it prints.

    This is THE layout: the bake cuts from it and the preview draws from it, so
    a string the editor shows on the bottom edge at 4.28 mm is cut on the bottom
    edge at 4.28 mm.  Token expansion happens here too (through the shared
    ``tokens`` pair), so both sides also agree on the text itself.

    ``rotation_deg`` is the SceneRequest's rotation: the model is turned
    counter-clockwise by it, so the north arrow is turned back by the same
    amount and ends up pointing at true north in the printed object.
    """
    warnings: List[str] = []
    have_frame = frame_text_available(params)
    usable = edge_usable_mm(params)
    band = edge_band_mm(params)

    # -- the scale bar first: it may take part of an edge from the text ----
    bar = _scale_bar_layout(params, ctx, have_frame)
    if bar.warnings:
        warnings.extend(bar.warnings)
    taken: Dict[str, float] = {}
    if bar.enabled:
        taken[bar.edge] = bar.span_mm + ORNAMENT_GAP_MM

    engravings: List[EngravingLayout] = []
    for index, engraving in enumerate(engraving_list(params)):
        edge = str(engraving.edge)
        text = TOK.expand_tokens(str(engraving.text), ctx)
        face = str(getattr(engraving, "font", None) or "sans")
        offset = taken.get(edge, 0.0)
        span_lo = -usable / 2.0 + offset
        span_hi = usable / 2.0
        fit = fit_text(
            face,
            text,
            float(engraving.size_mm),
            max(0.0, span_hi - span_lo),
            band,
            params,
            what=f"{edge} engraving",
            mode=str(engraving.mode),
        )
        if not have_frame:
            # There is no lip to carry it, so it is REFUSED, not merely warned
            # about.  Saying "skipped" in a warning and then handing the bake a
            # fit with `refused=False` is what shipped an embossed engraving as
            # a pair of letters floating 1.8 mm above a frameless plate, with
            # every validator passing (v2-03 audit, finding 2).
            fit = replace(
                fit,
                refused=True,
                reason=(
                    "the frame is off, so there is no lip to engrave: turn the "
                    "frame on to print edge text"
                ),
                warnings=[],
            )
        placement = edge_placement(params, edge, str(engraving.align), fit, span_lo, span_hi)
        engravings.append(
            EngravingLayout(
                index=index,
                edge=edge,
                align=str(engraving.align),
                mode=str(engraving.mode),
                depth_mm=float(engraving.depth_mm),
                placement=placement,
                fit=fit,
            )
        )
        warnings.extend(fit.warnings)
        if fit.refused and have_frame:
            # With the frame off, the one summary line below names every piece
            # that went with it - the user turned one switch and gets told once.
            warnings.append(f"engraving {index + 1} ({edge}) was not cut: {fit.reason}")

    arrow = _north_arrow_layout(params, rotation_deg, have_frame)
    if arrow.enabled:
        asked = float(getattr(getattr(params, "north_arrow", None), "size_mm", 0.0) or 0.0)
        if arrow.size_mm < asked - 1e-9:
            warnings.append(
                f"the north arrow was reduced from {_g(asked)} mm to "
                f"{_g(arrow.size_mm)} mm to fit the {_g(FRAME_WIDTH_MM)} mm lip band"
            )
    mark = _underside_mark_layout(params, ctx)
    if mark.fit is not None:
        warnings.extend(mark.fit.warnings)
        if mark.fit.refused:
            warnings.append("the underside mark was not cut: " + mark.fit.reason)

    if not have_frame:
        skipped: List[str] = []
        if engravings:
            skipped.append(f"{len(engravings)} edge engraving(s)")
        if getattr(getattr(params, "north_arrow", None), "enabled", False):
            skipped.append("the north arrow")
        if getattr(getattr(params, "scale_bar", None), "enabled", False):
            skipped.append("the scale bar")
        if skipped:
            warnings.append(
                "the frame is off, so there is no lip to carry "
                + ", ".join(skipped)
                + "; turn the frame on to print them"
            )

    return LetteringLayout(
        engravings=tuple(engravings),
        north_arrow=arrow,
        scale_bar=bar,
        underside_mark=mark,
        warnings=tuple(warnings),
    )


def _north_arrow_layout(
    params: ParamsLike, rotation_deg: float, have_frame: bool
) -> NorthArrowLayout:
    arrow = getattr(params, "north_arrow", None)
    enabled = bool(getattr(arrow, "enabled", False)) and have_frame
    corner = str(getattr(arrow, "corner", None) or "ne")
    requested = float(getattr(arrow, "size_mm", None) or 4.0)
    size = min(requested, north_arrow_max_size_mm(params))
    offset = float(params.plate_mm) / 2.0 - FRAME_WIDTH_MM / 2.0
    sx = -1.0 if corner in ("nw", "sw") else 1.0
    sy = -1.0 if corner in ("se", "sw") else 1.0
    return NorthArrowLayout(
        enabled=enabled,
        corner=corner,
        size_mm=size,
        placement=Placement(
            anchor_x=sx * offset,
            anchor_y=sy * offset,
            # `project.LocalFrame.to_local` rotates the ground COUNTER-CLOCKWISE
            # by +rotation_deg (DECISIONS [P2]), so the ground direction of
            # bearing b lands on the model direction (sin(b - rot), cos(b - rot))
            # and true north (b = 0) lands on the +y axis turned CCW by +rot.  An
            # arrow drawn pointing +y therefore has to be turned by
            # +rotation_deg.  Turning it by -rotation_deg put it on ground
            # bearing 2*rot: at the New York preset's 29 deg the shipped arrow
            # pointed 59 deg away from north, and at rotation 90 it pointed due
            # south (v2-03 audit, finding 1).
            rotation_deg=float(rotation_deg),
        ),
    )


def _scale_bar_layout(
    params: ParamsLike, ctx: "TOK.TokenContext", have_frame: bool
) -> ScaleBarLayout:
    spec = getattr(params, "scale_bar", None)
    enabled = bool(getattr(spec, "enabled", False)) and have_frame
    edge = str(getattr(spec, "edge", None) or "bottom")
    mode = str(getattr(spec, "length_mode", None) or "auto")
    scale = float(ctx.scale_mm_per_m)
    warnings: List[str] = []

    auto_length = scale_bar_auto_length_m(scale)
    length_m = auto_length
    if mode == "fixed":
        requested = float(getattr(spec, "length_m", None) or 0.0)
        printed = requested * scale
        if printed > SCALE_BAR_MAX_MM or printed < SCALE_BAR_MIN_MM:
            if enabled:
                warnings.append(
                    f"the scale bar's fixed {TOK.round_half_up(requested)} m would print "
                    f"{_f1(printed)} mm, outside the {_g(SCALE_BAR_MIN_MM)}-{_g(SCALE_BAR_MAX_MM)} mm "
                    f"window; using {TOK.round_half_up(auto_length)} m instead"
                )
        else:
            length_m = requested

    bar_mm = length_m * scale
    thickness = scale_bar_thickness_mm(params)
    tick = SCALE_BAR_TICK_FACTOR * thickness
    label = scale_bar_label(length_m)
    label_fit = (
        fit_text(
            SCALE_BAR_FACE,
            label,
            SCALE_BAR_LABEL_SIZE_MM,
            max(0.0, edge_usable_mm(params) - bar_mm - ORNAMENT_GAP_MM),
            edge_band_mm(params),
            params,
            what="scale bar label",
        )
        if enabled
        else None
    )
    label_width = 0.0 if label_fit is None or label_fit.refused else label_fit.width_mm
    span = bar_mm + (ORNAMENT_GAP_MM + label_width if label_width > 0.0 else 0.0)
    if label_fit is not None and label_fit.refused:
        warnings.append("the scale bar prints without its label: " + label_fit.reason)

    # The bar takes the START of its edge and pushes any engraving there along:
    # splitting the edge is the only arrangement that works for every align.
    cx, cy = edge_band_center_mm(params, edge)
    ax, ay = edge_axis(edge)
    u = -edge_usable_mm(params) / 2.0
    return ScaleBarLayout(
        enabled=enabled,
        edge=edge,
        length_m=length_m,
        label=label,
        bar_mm=bar_mm,
        thickness_mm=thickness,
        tick_mm=tick,
        span_mm=span,
        placement=Placement(
            anchor_x=cx + u * ax, anchor_y=cy + u * ay, rotation_deg=EDGE_ROTATION_DEG[edge]
        ),
        label_fit=label_fit,
        warnings=tuple(warnings),
    )


def _underside_mark_layout(params: ParamsLike, ctx: "TOK.TokenContext") -> UndersideMarkLayout:
    spec = getattr(params, "underside_mark", None)
    enabled = bool(getattr(spec, "enabled", False))
    if not enabled:
        return UndersideMarkLayout(
            enabled=False,
            depth_mm=UNDERSIDE_MARK_DEPTH_MM,
            placement=Placement(0.0, 0.0, 0.0, True),
            fit=None,
        )
    template = str(getattr(spec, "template", None) or "")
    text = TOK.expand_tokens(template, ctx)
    fit = fit_text(
        UNDERSIDE_MARK_FACE,
        text,
        UNDERSIDE_MARK_SIZE_MM,
        underside_mark_available_mm(params),
        # The whole bottom face is available across the mark, so there is no
        # band to fit it into: the only vertical limit is its own size, and
        # twice that can never bind.
        UNDERSIDE_MARK_SIZE_MM * 2.0,
        params,
        what="underside mark",
    )
    # Centred on the bottom face and MIRRORED, so it reads the right way round
    # once the plate is turned over.  The pen origin is half a block to the left
    # of centre; the mirror then reflects the block back onto itself.
    # The pen origin is on the RIGHT of the block, not the left: the mirror
    # reflects the layout about the anchor (``x -> -x + anchor``), so a block
    # laid out from 0 to W ends up spanning ``[anchor - W, anchor]``.  Putting
    # the anchor at ``+W/2`` is what centres it on the plate.
    return UndersideMarkLayout(
        enabled=True,
        depth_mm=UNDERSIDE_MARK_DEPTH_MM,
        placement=Placement(
            anchor_x=fit.width_mm / 2.0 - fit.dilation_mm,
            anchor_y=-(fit.ink_top_mm + fit.ink_bottom_mm) / 2.0,
            rotation_deg=0.0,
            mirror_x=True,
        ),
        fit=fit,
    )


#: Decimal places every number in the shared layout dump is rounded to.
LAYOUT_JSON_PLACES = 6


def round_places(value: float, places: int = LAYOUT_JSON_PLACES) -> float:
    """Round for the shared JSON dump, ties away from zero, in both languages.

    Python's ``round`` is banker's rounding and JavaScript's ``Math.round`` is
    not, so the dump both test suites compare cannot use either; it goes through
    the same ``round_half_up`` the token pair already shares.
    """
    factor = 10.0**places
    scaled = float(value) * factor
    return TOK.round_half_up(abs(scaled)) / factor * (-1.0 if scaled < 0 else 1.0)


def _placement_json(placement: Placement) -> dict:
    return {
        "anchor_x": round_places(placement.anchor_x, 6),
        "anchor_y": round_places(placement.anchor_y, 6),
        "rotation_deg": round_places(placement.rotation_deg, 6),
        "mirror_x": placement.mirror_x,
    }


def _fit_json(fit: Optional[TextFit]) -> Optional[dict]:
    if fit is None:
        return None
    return {
        "face": fit.face,
        "text": fit.text,
        "dropped": fit.dropped,
        "requested_mm": round_places(fit.requested_mm, 6),
        "size_mm": round_places(fit.size_mm, 6),
        "width_mm": round_places(fit.width_mm, 6),
        "ink_top_mm": round_places(fit.ink_top_mm, 6),
        "ink_bottom_mm": round_places(fit.ink_bottom_mm, 6),
        "dilation_mm": round_places(fit.dilation_mm, 6),
        "stroke_mm": round_places(fit.stroke_mm, 6),
        "min_size_mm": round_places(fit.min_size_mm, 6),
        "gap_size_mm": round_places(fit.gap_size_mm, 6),
        "refused": fit.refused,
        "reason": fit.reason,
        "warnings": list(fit.warnings),
    }


def lettering_layout_json(
    params: ParamsLike, ctx: "TOK.TokenContext", rotation_deg: float = 0.0
) -> dict:
    """The layout as plain JSON.

    This is the shape ``fixtures/lettering-expected.json`` holds and that both
    test suites compare, so the dump itself is shared code rather than two
    hand-written serialisers that can drift apart.
    """
    layout = lettering_layout(params, ctx, rotation_deg)
    return {
        "engravings": [
            {
                "index": e.index,
                "edge": e.edge,
                "align": e.align,
                "mode": e.mode,
                "depth_mm": round_places(e.depth_mm, 6),
                "placement": _placement_json(e.placement),
                "fit": _fit_json(e.fit),
            }
            for e in layout.engravings
        ],
        "north_arrow": {
            "enabled": layout.north_arrow.enabled,
            "corner": layout.north_arrow.corner,
            "size_mm": round_places(layout.north_arrow.size_mm, 6),
            "placement": _placement_json(layout.north_arrow.placement),
        },
        "scale_bar": {
            "enabled": layout.scale_bar.enabled,
            "edge": layout.scale_bar.edge,
            "length_m": round_places(layout.scale_bar.length_m, 6),
            "label": layout.scale_bar.label,
            "bar_mm": round_places(layout.scale_bar.bar_mm, 6),
            "thickness_mm": round_places(layout.scale_bar.thickness_mm, 6),
            "tick_mm": round_places(layout.scale_bar.tick_mm, 6),
            "span_mm": round_places(layout.scale_bar.span_mm, 6),
            "placement": _placement_json(layout.scale_bar.placement),
            "label_fit": _fit_json(layout.scale_bar.label_fit),
            "warnings": list(layout.scale_bar.warnings),
        },
        "underside_mark": {
            "enabled": layout.underside_mark.enabled,
            "depth_mm": round_places(layout.underside_mark.depth_mm, 6),
            "placement": _placement_json(layout.underside_mark.placement),
            "fit": _fit_json(layout.underside_mark.fit),
        },
        "warnings": list(layout.warnings),
    }


# ==========================================================================
# Detail advisor (PrintParams v2)
#
# One honest sentence about what this radius and this plate are doing to the
# city, computed from the SAME predicates the preview already approximates the
# bake with, so the advice cannot contradict the picture on the canvas.
# ==========================================================================

#: Score penalties, in points per unit of fraction, clamped into 0..100.
#:
#: A building the repair had to DROP costs a full point per per cent - a city
#: that loses every building scores 0 - and one it had to WIDEN costs 0.6, since
#: a widened building is still there and still in the right place.  Trees and
#: water/green areas are worth a twentieth of a point each: losing every tree is
#: a five-point matter, not a fifty-point one.
#:
#: The two building weights do not sum to 100 on purpose.  They are penalties
#: per fraction, not shares of a budget, and each fraction is independently
#: 0..1: 100 % widened alone is 60 points off, landing AT 40, which is ``poor``,
#: and that is the case the band exists to name (measured on the committed
#: Chicago fixture: at plate 100 and a 3 000 m radius it widens 95 % of its
#: buildings and scores 34 - the shipped default preset, 900 m at plate 180,
#: widens 37 % and scores 70, which is ``fair``).
SCORE_WEIGHT_DROPPED = 100.0
SCORE_WEIGHT_WIDENED = 60.0
SCORE_WEIGHT_TREES = 5.0
SCORE_WEIGHT_AREAS = 5.0

#: Band edges.  75 and up is a model that looks like the map; 45 to 74 is one
#: that has lost its small buildings; below 45 the block structure is gone.
SCORE_BAND_GOOD = 75
SCORE_BAND_FAIR = 45

#: The advisor's target: at most this fraction of the buildings widened.
MAX_WIDENED_FRACTION = 0.25
#: Radius search grid and floor, in metres (the contract's own lower bound).
RADIUS_GRID_M = 10.0
RADIUS_MIN_M = 250.0
#: Plate search grid and bounds, in millimetres (the contract's own bounds).
PLATE_GRID_MM = 2.0
PLATE_MIN_MM = 100.0
PLATE_MAX_MM = 256.0


@dataclass(frozen=True)
class DetailReport:
    buildings_total: int
    widened: int
    dropped: int
    widened_fraction: float
    dropped_fraction: float
    trees_total: int
    trees_dropped_fraction: float
    areas_total: int
    areas_dropped_fraction: float
    min_wall_ground_m: float
    score: int
    band: str


def _char_widths(scene) -> List[Tuple[float, float]]:
    """``(area_m2, char_width_m)`` per building, computed once.

    Neither depends on any PrintParams, so the radius and plate searches below
    can sweep hundreds of candidates over a 3 000-building scene without
    re-walking a single ring.
    """
    out: List[Tuple[float, float]] = []
    for b in scene.buildings:
        area = ring_area_m2(b.ring)
        perimeter = ring_perimeter_m(b.ring)
        for hole in getattr(b, "holes", None) or ():
            area -= ring_area_m2(hole)
            perimeter += ring_perimeter_m(hole)
        area = max(0.0, area)
        out.append((area, building_char_width_m(area, perimeter)))
    return out


def _building_counts(
    footprints: Sequence[Tuple[float, float]], thresholds: Thresholds
) -> Tuple[int, int]:
    """(widened, dropped) over pre-measured footprints."""
    widened = 0
    dropped = 0
    for area, char_width in footprints:
        dilation = building_dilation_m(char_width, thresholds)
        if building_dropped(area, dilation, thresholds):
            dropped += 1
        elif dilation > 0.0:
            widened += 1
    return widened, dropped


def detail_report(scene, params: ParamsLike, radius_m: float) -> DetailReport:
    """How much of this city survives the minimum-feature repair, 0-100.

    Every count comes from the shared predicates the preview already draws with
    (:func:`building_dilation_m`, :func:`building_dropped`,
    :func:`area_dropped`, :func:`tree_visible_for`), so the advisor agrees with
    the canvas by construction rather than by coincidence.  The bake's own
    Stage 1 does better than this - it merges blocks rather than dropping them -
    so the report is an upper bound on the damage, which is the right side to
    err on for advice.
    """
    scale = scale_mm_per_m(params, radius_m)
    thresholds = thresholds_ground_m(params, scale)
    footprints = _char_widths(scene)
    widened, dropped = _building_counts(footprints, thresholds)
    total = len(footprints)

    trees = list(getattr(scene, "trees", None) or ())
    trees_total = len(trees)
    trees_kept = (
        len(select_tree_indices_for(trees, params, scale))
        if (trees_total and params.trees)
        else 0
    )
    trees_dropped = trees_total - trees_kept

    areas = list(getattr(scene, "water", None) or ()) + list(
        getattr(scene, "green", None) or ()
    )
    areas_total = len(areas)
    areas_dropped = sum(
        1 for a in areas if area_dropped(ring_area_m2(a.ring), thresholds)
    )

    def fraction(part: int, whole: int) -> float:
        return 0.0 if whole <= 0 else float(part) / float(whole)

    widened_fraction = fraction(widened, total)
    dropped_fraction = fraction(dropped, total)
    trees_fraction = fraction(trees_dropped, trees_total)
    areas_fraction = fraction(areas_dropped, areas_total)
    penalty = (
        SCORE_WEIGHT_DROPPED * dropped_fraction
        + SCORE_WEIGHT_WIDENED * widened_fraction
        + SCORE_WEIGHT_TREES * trees_fraction
        + SCORE_WEIGHT_AREAS * areas_fraction
    )
    score = max(0, min(100, TOK.round_half_up(100.0 - penalty)))
    band = "good" if score >= SCORE_BAND_GOOD else ("fair" if score >= SCORE_BAND_FAIR else "poor")
    return DetailReport(
        buildings_total=total,
        widened=widened,
        dropped=dropped,
        widened_fraction=widened_fraction,
        dropped_fraction=dropped_fraction,
        trees_total=trees_total,
        trees_dropped_fraction=trees_fraction,
        areas_total=areas_total,
        areas_dropped_fraction=areas_fraction,
        min_wall_ground_m=thresholds.min_wall,
        score=score,
        band=band,
    )


def _widened_fraction_at(
    footprints: Sequence[Tuple[float, float]], params: ParamsLike, radius_m: float
) -> float:
    if not footprints:
        return 0.0
    thresholds = thresholds_ground_m(params, scale_mm_per_m(params, radius_m))
    widened, _dropped = _building_counts(footprints, thresholds)
    return float(widened) / float(len(footprints))


class _PlateOverride:
    """A ``ParamsLike`` view of an existing params object with one plate size.

    The search sweeps plate sizes and must not mutate the caller's parameters,
    and this module may not import the pydantic model to copy it.
    """

    def __init__(self, params: ParamsLike, plate_mm: float) -> None:
        self._params = params
        self.plate_mm = float(plate_mm)

    def __getattr__(self, name: str):
        return getattr(self._params, name)


def recommend_radius_m(
    scene,
    params: ParamsLike,
    radius_m: float,
    max_widened_fraction: float = MAX_WIDENED_FRACTION,
) -> Optional[float]:
    """The largest radius that keeps the widened fraction under the target.

    Searched on a deterministic 10 m grid from the current radius down to the
    contract's 250 m floor, and solved rather than looked up: the answer moves
    with the plate, the nozzle and the city.  None when even 250 m is too coarse
    (a city of slivers), and the current radius itself when nothing is wrong.
    """
    footprints = _char_widths(scene)
    if not footprints:
        return None
    current = floor_to_grid(float(radius_m), RADIUS_GRID_M)
    if current < RADIUS_MIN_M:
        current = RADIUS_MIN_M
    steps = int(round((current - RADIUS_MIN_M) / RADIUS_GRID_M))
    for i in range(steps + 1):
        candidate = current - i * RADIUS_GRID_M
        if _widened_fraction_at(footprints, params, candidate) < max_widened_fraction:
            return candidate
    return None


def recommend_plate_mm(
    scene,
    params: ParamsLike,
    radius_m: float,
    max_widened_fraction: float = MAX_WIDENED_FRACTION,
) -> Optional[float]:
    """The smallest plate that keeps the widened fraction under the target.

    Searched on the contract's own 100-256 mm range, on a 2 mm grid, at the
    CURRENT radius: it is the other half of the advice, "keep the crop, print it
    bigger".  None when even 256 mm is not enough.
    """
    footprints = _char_widths(scene)
    if not footprints:
        return None
    steps = int(round((PLATE_MAX_MM - PLATE_MIN_MM) / PLATE_GRID_MM))
    for i in range(steps + 1):
        candidate = PLATE_MIN_MM + i * PLATE_GRID_MM
        view = _PlateOverride(params, candidate)
        if _widened_fraction_at(footprints, view, radius_m) < max_widened_fraction:
            return candidate
    return None


def detail_recommendation(
    scene,
    params: ParamsLike,
    radius_m: float,
    max_widened_fraction: float = MAX_WIDENED_FRACTION,
) -> Optional[str]:
    """One sentence naming the damage and the two ways out, or None when healthy.

    ``Radius 2400 m at plate 180 widens 65%. Try 540 m.`` - reproduced on the
    committed Chicago fixture, which is why it replaced an invented example
    whose "drops N buildings" clause this module's own
    ``test_04_stage1_rule_3_cannot_fire_after_rule_2`` proves unreachable from
    any SceneGraph (v2-03 audit, finding 11).  The clause is still built below,
    because the rule that would make it fire is 04's and not this file's to
    delete.
    """
    report = detail_report(scene, params, radius_m)
    healthy = report.dropped == 0 and report.widened_fraction < max_widened_fraction
    if healthy or report.buildings_total == 0:
        return None

    radius_text = TOK.round_half_up(float(radius_m))
    plate_text = TOK.round_half_up(float(params.plate_mm))
    percent = TOK.round_half_up(100.0 * report.widened_fraction)
    if report.dropped and percent:
        head = (
            f"Radius {radius_text} m at plate {plate_text} drops "
            f"{TOK.group_thousands(report.dropped)} buildings and widens {percent}%."
        )
    elif report.dropped:
        head = (
            f"Radius {radius_text} m at plate {plate_text} drops "
            f"{TOK.group_thousands(report.dropped)} buildings."
        )
    else:
        head = f"Radius {radius_text} m at plate {plate_text} widens {percent}%."

    better_radius = recommend_radius_m(scene, params, radius_m, max_widened_fraction)
    if better_radius is not None and better_radius >= float(radius_m):
        better_radius = None
    better_plate = recommend_plate_mm(scene, params, radius_m, max_widened_fraction)
    # Only ever offer a remedy that is a CHANGE in the helpful direction: a
    # smaller plate is never advice (it scales the city down and widens more),
    # and it can come back from the search whenever the current plate already
    # meets the widened target and it is the DROPS that are the complaint.
    if better_plate is not None and better_plate <= float(params.plate_mm):
        better_plate = None

    if better_radius is not None and better_plate is not None:
        return (
            head
            + f" Try {TOK.round_half_up(better_radius)} m, or plate "
            + f"{TOK.round_half_up(better_plate)}."
        )
    if better_radius is not None:
        return head + f" Try {TOK.round_half_up(better_radius)} m."
    if better_plate is not None:
        return head + f" Try plate {TOK.round_half_up(better_plate)}."
    return head + " No radius or plate in range fixes it: raise the nozzle detail instead."
