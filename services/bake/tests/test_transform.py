"""Tests for the shared print-transform math.

Two jobs:

1. Pin ``app/geom/transform.py`` to the worked example and the literal
   constants in ``04_PRINTABILITY_SPEC.md``.
2. Produce ``fixtures/parity-expected.json`` -- the contract between this
   module and its TypeScript mirror ``apps/web/lib/transform.ts``.  The dump is
   rebuilt from ``fixtures/parity-scene.json`` on every run and compared to the
   committed file, so a change on the Python side that is not mirrored in TS
   fails here first and in ``apps/web/lib/transform.test.ts`` second.

Regenerate the committed expectation with::

    FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_transform.py

(the assertion still runs afterwards, so a regeneration can never hide a
mismatch between the two *implementations*, only re-baseline the fixture).
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any, Dict, List

import pytest

from app.contracts import PrintParams, SceneGraph
from app.geom import transform as T

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "fixtures"
PARITY_SCENE = FIXTURES / "parity-scene.json"
PARITY_EXPECTED = FIXTURES / "parity-expected.json"

#: Every float written into the parity fixture is rounded to this many decimal
#: places so the JSON is stable across platforms.  0.01 mm is the agreement
#: tolerance; 9 decimals is far below it.
ROUND = 9


# --------------------------------------------------------------------------
# 1. Unit tests against 04_PRINTABILITY_SPEC.md
# --------------------------------------------------------------------------


def params(**overrides: Any) -> PrintParams:
    base: Dict[str, Any] = {
        "plate_mm": 180,
        "base_thickness_mm": 3.0,
        "nozzle_mm": 0.4,
        "small_scale": 1.0,
        "large_scale": 1.0,
        "terrain_exaggeration": 1.0,
        "road_mode": "engrave",
        "road_scale": 1.0,
        "trees": True,
        "water": True,
        "frame": True,
    }
    base.update(overrides)
    return PrintParams(**base)


class Bldg:
    def __init__(self, height_m: float, is_tall: bool) -> None:
        self.height_m = height_m
        self.is_tall = is_tall


class RoadStub:
    def __init__(self, width_m: float) -> None:
        self.width_m = width_m


class TreeStub:
    def __init__(self, radius_m: float) -> None:
        self.radius_m = radius_m


def test_worked_example_scale_is_one_to_ten_thousand() -> None:
    """04: 1.8 km span on a 180 mm plate, frame off -> 0.1 mm/m (1:10000)."""
    p = params(frame=False)
    scale = T.scale_mm_per_m(p, radius_m=900.0)
    assert scale == pytest.approx(0.1, abs=1e-12)
    # The dimensionless form 04 writes down, usable / (span_m * 1000).
    assert scale / 1000.0 == pytest.approx(1.0 / 10000.0, abs=1e-15)


def test_worked_example_min_wall_ground_is_eight_metres() -> None:
    p = params(frame=False)
    th = T.thresholds_ground_m(p, T.scale_mm_per_m(p, 900.0))
    assert th.min_wall == pytest.approx(8.0, abs=1e-9)
    assert th.min_gap == pytest.approx(6.0, abs=1e-9)
    assert th.min_detail == pytest.approx(4.0, abs=1e-9)


def test_frame_consumes_twelve_millimetres_of_plate() -> None:
    assert T.usable_span_mm(params(frame=True)) == 168.0
    assert T.usable_span_mm(params(frame=False)) == 180.0
    # ... and therefore shrinks the scale.
    assert T.scale_mm_per_m(params(frame=True), 900.0) == pytest.approx(168.0 / 1800.0)


def test_building_top_applies_the_right_multiplier_and_clamp() -> None:
    p = params(small_scale=0.5, large_scale=2.0)
    scale = T.scale_mm_per_m(p, 900.0)  # 0.093333 mm/m
    tall = Bldg(120.0, True)
    short = Bldg(20.0, False)
    assert T.building_top_mm(tall, p, scale) == pytest.approx(3.0 + 120.0 * scale * 2.0)
    assert T.building_top_mm(short, p, scale) == pytest.approx(3.0 + 20.0 * scale * 0.5)
    # 0.6 mm floor from 04 stage 2.3.
    tiny = Bldg(2.0, False)
    p2 = params(small_scale=0.5, plate_mm=100)
    scale2 = T.scale_mm_per_m(p2, 3000.0)
    assert T.building_top_mm(tiny, p2, scale2) == pytest.approx(3.0 + 0.6)


def test_building_bottom_is_base_top_minus_the_overlap() -> None:
    assert T.building_bottom_mm(params(base_thickness_mm=3.0)) == pytest.approx(2.8)
    assert T.building_bottom_mm(params(base_thickness_mm=8.0)) == pytest.approx(7.8)


def test_road_z_modes() -> None:
    assert T.road_z_mm(params(road_mode="off")) is None
    assert T.road_z_mm(params(road_mode="emboss")) == pytest.approx(0.4)
    # base/3 = 1.0 > 0.6 so the 0.6 mm cap wins
    assert T.road_z_mm(params(road_mode="engrave", base_thickness_mm=3.0)) == pytest.approx(-0.6)
    # The base/3 branch of min(0.6, base/3) never binds inside the contract's
    # 2..8 mm base range (2/3 > 0.6), so engrave depth is 0.6 mm everywhere.
    # The formula is kept verbatim from 04 so a future base range change works.
    assert T.road_z_mm(params(road_mode="engrave", base_thickness_mm=2.0)) == pytest.approx(-0.6)
    assert T.road_z_mm(params(road_mode="engrave", base_thickness_mm=8.0)) == pytest.approx(-0.6)


def test_road_width_applies_scale_before_the_clamp() -> None:
    p = params(frame=False, road_scale=2.0)
    th = T.thresholds_ground_m(p, T.scale_mm_per_m(p, 900.0))  # min_wall 8 m
    assert T.road_width_ground_m(RoadStub(12.0), p, th) == pytest.approx(24.0)
    # 3 m service road * 2.0 = 6 m, below the 8 m min wall -> clamped
    assert T.road_width_ground_m(RoadStub(3.0), p, th) == pytest.approx(8.0)


def test_water_and_green_offsets() -> None:
    assert T.water_z_mm(params(water=True)) == pytest.approx(-0.5)
    assert T.water_z_mm(params(water=False)) is None
    assert T.green_z_mm(params()) == pytest.approx(0.3)


def test_tree_radius_floor_is_nozzle_aware_and_leaves_the_default_alone() -> None:
    """An 8-gon of circumradius r is only 2 r cos(pi/8) across its flats, so at
    04's 0.5 mm floor the BASE of a cone is 0.92 mm - under one bead for every
    nozzle from 0.5 mm up.  Shared with the preview so it hides the same trees."""
    assert T.tree_min_radius_mm(params()) == pytest.approx(T.TREE_MIN_RADIUS_MM)
    for nozzle in (0.1, 0.2, 0.4):
        assert T.tree_min_radius_mm(params(nozzle_mm=nozzle)) == T.TREE_MIN_RADIUS_MM
    for nozzle in (0.5, 0.6, 0.8, 1.2):
        floor = T.tree_min_radius_mm(params(nozzle_mm=nozzle))
        assert floor > T.TREE_MIN_RADIUS_MM
        across_flats = 2.0 * floor * math.cos(math.pi / T.TREE_SIDES)
        assert across_flats == pytest.approx(T.MIN_WALL_NOZZLES * nozzle)


def test_tree_visible_for_is_tree_visible_plus_the_floor() -> None:
    p = params(frame=False, nozzle_mm=0.8)  # floor 0.866 mm
    scale = T.scale_mm_per_m(p, 900.0)  # 0.1 mm/m
    small = TreeStub(6.0)  # 0.6 mm printed
    big = TreeStub(9.0)  # 0.9 mm printed
    assert T.tree_visible(small, scale) is True
    assert T.tree_visible_for(small, p, scale) is False
    assert T.tree_visible_for(big, p, scale) is True
    trees = [small, big, TreeStub(1.0)]
    assert T.select_tree_indices(trees, scale) == [0, 1]
    assert T.select_tree_indices_for(trees, p, scale) == [1]
    # At the default nozzle the floor is 0.433 mm, so 04's 0.5 mm still binds
    # and the two selectors are the same function.
    d = params(frame=False)
    assert T.select_tree_indices_for(trees, d, scale) == T.select_tree_indices(
        trees, scale
    )


def test_predicted_top_takes_the_max_of_buildings_frame_and_trees() -> None:
    class Scene:
        def __init__(self, buildings, trees):
            self.buildings = buildings
            self.trees = trees

    p = params(frame=False)
    scale = T.scale_mm_per_m(p, 900.0)  # 0.1 mm/m
    empty = Scene([], [])
    assert T.predicted_top_mm(empty, p, 900.0) == pytest.approx(3.0)
    assert T.predicted_top_mm(empty, params(), 900.0) == pytest.approx(
        3.0 + T.FRAME_LIP_MM
    )
    tower = Bldg(400.0, True)
    tall = Scene([Bldg(10.0, False), tower], [])
    assert T.predicted_top_mm(tall, p, 900.0) == pytest.approx(3.0 + 40.0)
    assert T.model_too_tall(tall, p, 900.0) is False
    doubled = params(frame=False, large_scale=2.0)
    assert T.predicted_top_mm(tall, doubled, 900.0) == pytest.approx(3.0 + 80.0)
    assert T.model_too_tall(tall, doubled, 900.0) is True
    # Trees count, and only when the toggle is on.
    treed = Scene([], [TreeStub(20.0)])
    assert T.predicted_top_mm(treed, p, 900.0) == pytest.approx(
        3.0 + T.tree_height_mm(TreeStub(20.0), scale)
    )
    assert T.predicted_top_mm(treed, params(frame=False, trees=False), 900.0) == 3.0


def test_max_height_matches_the_stage_four_validator() -> None:
    """The constant is duplicated (transform.py imports nothing); pin it."""
    from app.validate import checks

    assert T.MAX_HEIGHT_MM == checks.MAX_HEIGHT_MM == 60.0


def test_the_bake_guard_delegates_to_the_shared_prediction() -> None:
    """The editor disables Bake from ``T.predicted_top_mm``; the server refuses
    from ``bake.predicted_top_mm``.  They must be one function."""
    from app import bake as bake_pipeline

    scene = SceneGraph(**json.loads(PARITY_SCENE.read_text(encoding="utf-8")))
    for case in PARITY_CASES:
        p = PrintParams(**case["params"])
        assert bake_pipeline.predicted_top_mm(scene, p) == T.predicted_top_mm(
            scene, p, T.radius_m_from_bounds(scene.bounds)
        )


def test_the_stage_one_tree_floor_delegates_to_the_shared_helper() -> None:
    from app.geom import thicken

    for nozzle in (0.1, 0.4, 0.5, 0.6, 1.2):
        p = params(nozzle_mm=nozzle)
        assert thicken.tree_min_radius_mm(p) == T.tree_min_radius_mm(p)
    assert thicken.TREE_SIDES == T.TREE_SIDES


def test_tree_visibility_height_and_cap() -> None:
    p = params(frame=False)
    scale = T.scale_mm_per_m(p, 900.0)  # 0.1 mm/m
    assert T.tree_visible(TreeStub(5.0), scale) is True  # 0.5 mm exactly
    assert T.tree_visible(TreeStub(4.9), scale) is False
    assert T.tree_height_mm(TreeStub(5.0), scale) == pytest.approx(1.5)
    assert T.tree_radius_mm(TreeStub(5.0), scale) == pytest.approx(0.5)

    trees = [TreeStub(4.0)] * 3 + [TreeStub(20.0)] * (T.TREE_CAP + 10)
    picked = T.select_tree_indices(trees, scale)
    assert len(picked) == T.TREE_CAP
    assert picked == sorted(picked)
    # the 4 m trees are invisible at this scale (0.4 mm) and never selected
    assert all(i >= 3 for i in picked)


def test_char_width_and_dilation() -> None:
    # A 90x120 m rectangle: area 10800, perimeter 420, w = 4A/P = 102.857 m
    ring = [[0.0, 0.0], [90.0, 0.0], [90.0, 120.0], [0.0, 120.0]]
    assert T.ring_area_m2(ring) == pytest.approx(10800.0)
    assert T.ring_perimeter_m(ring) == pytest.approx(420.0)
    w = T.building_char_width_m(10800.0, 420.0)
    assert w == pytest.approx(4.0 * 10800.0 / 420.0)

    th = T.Thresholds(min_wall=8.0, min_gap=6.0, min_detail=4.0)
    assert T.building_dilation_m(w, th) == 0.0
    assert T.building_dilation_m(2.0, th) == pytest.approx(3.0)


def test_ring_helpers_treat_rings_as_implicitly_closed() -> None:
    """DECISIONS [P1]: the first vertex is not repeated as the last."""
    square = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]]
    assert T.ring_area_m2(square) == pytest.approx(100.0)
    assert T.ring_perimeter_m(square) == pytest.approx(40.0)
    # winding must not change the reported area
    assert T.ring_area_m2(list(reversed(square))) == pytest.approx(100.0)
    assert T.ring_area_m2([[0.0, 0.0], [1.0, 1.0]]) == 0.0


def test_footprint_metrics_subtract_holes() -> None:
    th = T.Thresholds(min_wall=8.0, min_gap=6.0, min_detail=4.0)
    outer = [[0.0, 0.0], [100.0, 0.0], [100.0, 100.0], [0.0, 100.0]]
    hole = [[40.0, 40.0], [40.0, 60.0], [60.0, 60.0], [60.0, 40.0]]
    area, perim, w, d = T.building_footprint_metrics(outer, [hole], th)
    assert area == pytest.approx(10000.0 - 400.0)
    assert perim == pytest.approx(400.0 + 80.0)
    assert w == pytest.approx(4.0 * 9600.0 / 480.0)
    assert d == 0.0


def test_frame_and_plate_extents() -> None:
    p = params(plate_mm=180, base_thickness_mm=3.0, frame=True)
    plate = T.plate_extents_mm(p)
    assert (plate.min_x, plate.max_x, plate.size) == (-90.0, 90.0, 180.0)
    frame = T.frame_geometry_mm(p)
    assert frame.enabled is True
    assert frame.outer_half_mm == 90.0
    assert frame.inner_half_mm == 84.0
    assert frame.bottom_mm == 3.0
    assert frame.top_mm == 5.0
    content = T.content_extents_mm(p)
    assert content.max_x == pytest.approx(84.0 - T.CROP_INSET_MM)
    assert T.frame_geometry_mm(params(frame=False)).enabled is False


def test_terrain_is_flat_but_carried_through() -> None:
    for exaggeration in (0.0, 1.0, 3.0):
        p = params(terrain_exaggeration=exaggeration)
        assert T.terrain_z_scale(p) == 1.0
        assert T.terrain_z_mm(0.0, p, 0.1) == 0.0


def test_radius_from_bounds() -> None:
    class B:
        min_x, min_y, max_x, max_y = -900.0, -900.0, 900.0, 900.0

    assert T.radius_m_from_bounds(B()) == 900.0


def test_scale_rejects_a_zero_radius() -> None:
    with pytest.raises(ValueError):
        T.scale_mm_per_m(params(), 0.0)


# --------------------------------------------------------------------------
# 2. The TS/Python parity expectation file
# --------------------------------------------------------------------------

#: The three PrintParams sets the parity fixture covers.  Chosen to move every
#: branch: frame on/off (scale), both height multipliers away from 1.0, all
#: three road modes, and a nozzle/base/plate combination that pushes the
#: minimum-feature thresholds far enough to change which trees survive.
PARITY_CASES: List[Dict[str, Any]] = [
    {
        "name": "defaults",
        "params": {
            "plate_mm": 180,
            "base_thickness_mm": 3.0,
            "nozzle_mm": 0.4,
            "small_scale": 1.0,
            "large_scale": 1.0,
            "terrain_exaggeration": 1.0,
            "road_mode": "engrave",
            "road_scale": 1.0,
            "trees": True,
            "water": True,
            "frame": True,
        },
    },
    {
        "name": "large-plate-no-frame-emboss",
        "params": {
            "plate_mm": 256,
            "base_thickness_mm": 3.0,
            "nozzle_mm": 0.4,
            "small_scale": 0.5,
            "large_scale": 2.0,
            "terrain_exaggeration": 3.0,
            "road_mode": "emboss",
            "road_scale": 2.0,
            "trees": True,
            "water": True,
            "frame": False,
        },
    },
    {
        "name": "small-plate-fat-nozzle-roads-off",
        "params": {
            "plate_mm": 100,
            "base_thickness_mm": 8.0,
            "nozzle_mm": 0.6,
            "small_scale": 1.0,
            "large_scale": 1.0,
            "terrain_exaggeration": 0.0,
            "road_mode": "off",
            "road_scale": 1.0,
            "trees": True,
            "water": False,
            "frame": True,
        },
    },
]


def r(value: float) -> float:
    return round(float(value), ROUND)


def build_case(scene: SceneGraph, case: Dict[str, Any]) -> Dict[str, Any]:
    p = PrintParams(**case["params"])
    radius_m = T.radius_m_from_bounds(scene.bounds)
    scale = T.scale_mm_per_m(p, radius_m)
    th = T.thresholds_ground_m(p, scale)
    frame = T.frame_geometry_mm(p)
    plate = T.plate_extents_mm(p)
    content = T.content_extents_mm(p)
    road_z = T.road_z_mm(p)
    water_z = T.water_z_mm(p)
    selected = set(T.select_tree_indices(scene.trees, scale))
    selected_for = set(T.select_tree_indices_for(scene.trees, p, scale))

    buildings = []
    for b in scene.buildings:
        area, perimeter, char_width, dilation = T.building_footprint_metrics(
            b.ring, b.holes, th
        )
        buildings.append(
            {
                "id": b.id,
                "area_m2": r(area),
                "perimeter_m": r(perimeter),
                "char_width_m": r(char_width),
                "dilation_m": r(dilation),
                "dropped": T.building_dropped(area, dilation, th),
                "height_scale": r(T.building_height_scale(b, p)),
                "top_mm": r(T.building_top_mm(b, p, scale)),
                "bottom_mm": r(T.building_bottom_mm(p)),
            }
        )

    roads = [
        {
            "id": road.id,
            "width_ground_m": r(T.road_width_ground_m(road, p, th)),
            "z_mm": None if road_z is None else r(road_z),
        }
        for road in scene.roads
    ]

    trees = [
        {
            "index": i,
            "visible": T.tree_visible(t, scale),
            "visible_for": T.tree_visible_for(t, p, scale),
            "selected": i in selected,
            "selected_for": i in selected_for,
            "radius_mm": r(T.tree_radius_mm(t, scale)),
            "height_mm": r(T.tree_height_mm(t, scale)),
        }
        for i, t in enumerate(scene.trees)
    ]

    areas = {
        "water_z_mm": None if water_z is None else r(water_z),
        "green_z_mm": r(T.green_z_mm(p)),
        "water_dropped": [
            T.area_dropped(T.ring_area_m2(w.ring), th) for w in scene.water
        ],
        "green_dropped": [
            T.area_dropped(T.ring_area_m2(g.ring), th) for g in scene.green
        ],
    }

    return {
        "name": case["name"],
        "params": case["params"],
        "radius_m": r(radius_m),
        "scale_mm_per_m": r(scale),
        "usable_span_mm": r(T.usable_span_mm(p)),
        "thresholds_ground_m": {
            "min_wall": r(th.min_wall),
            "min_gap": r(th.min_gap),
            "min_detail": r(th.min_detail),
        },
        "base_top_mm": r(T.base_top_mm(p)),
        "terrain_z_scale": r(T.terrain_z_scale(p)),
        "tree_min_radius_mm": r(T.tree_min_radius_mm(p)),
        "max_height_mm": r(T.MAX_HEIGHT_MM),
        "predicted_top_mm": r(T.predicted_top_mm(scene, p, radius_m)),
        "model_too_tall": T.model_too_tall(scene, p, radius_m),
        "plate_extents_mm": {
            "min_x": r(plate.min_x),
            "min_y": r(plate.min_y),
            "max_x": r(plate.max_x),
            "max_y": r(plate.max_y),
            "size": r(plate.size),
        },
        "content_extents_mm": {
            "min_x": r(content.min_x),
            "min_y": r(content.min_y),
            "max_x": r(content.max_x),
            "max_y": r(content.max_y),
            "size": r(content.size),
        },
        "frame_mm": {
            "enabled": frame.enabled,
            "width_mm": r(frame.width_mm),
            "outer_half_mm": r(frame.outer_half_mm),
            "inner_half_mm": r(frame.inner_half_mm),
            "bottom_mm": r(frame.bottom_mm),
            "top_mm": r(frame.top_mm),
        },
        "areas": areas,
        "buildings": buildings,
        "roads": roads,
        "trees": trees,
    }


def build_expected() -> Dict[str, Any]:
    scene = SceneGraph(**json.loads(PARITY_SCENE.read_text(encoding="utf-8")))
    return {
        "_comment": (
            "GENERATED by services/bake/tests/test_transform.py. This is the "
            "contract between app/geom/transform.py and apps/web/lib/"
            "transform.ts; both test suites assert against it. Regenerate with "
            "FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_transform.py"
        ),
        "scene": "fixtures/parity-scene.json",
        "cases": [build_case(scene, case) for case in PARITY_CASES],
    }


def test_parity_expectation_matches_the_committed_fixture() -> None:
    fresh = build_expected()
    if os.environ.get("FRAMECRAFT_WRITE_PARITY") == "1":
        PARITY_EXPECTED.write_text(
            json.dumps(fresh, indent=2, sort_keys=False) + "\n", encoding="utf-8"
        )
    assert PARITY_EXPECTED.is_file(), (
        "fixtures/parity-expected.json is missing; regenerate with "
        "FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_transform.py"
    )
    committed = json.loads(PARITY_EXPECTED.read_text(encoding="utf-8"))
    assert committed == fresh


def test_parity_expectation_is_not_vacuous() -> None:
    """Guard against an empty or degenerate fixture silently passing."""
    expected = json.loads(PARITY_EXPECTED.read_text(encoding="utf-8"))
    cases = expected["cases"]
    assert len(cases) == 3
    for case in cases:
        assert len(case["buildings"]) >= 20
        assert len(case["roads"]) >= 5
        assert len(case["trees"]) >= 5
    # The three cases must actually differ, or parity proves nothing.
    scales = {c["scale_mm_per_m"] for c in cases}
    assert len(scales) == 3
    assert cases[0]["roads"][0]["z_mm"] is not None
    assert cases[2]["roads"][0]["z_mm"] is None
    assert cases[2]["areas"]["water_z_mm"] is None
    # at least one building somewhere is thin enough to need dilation
    assert any(b["dilation_m"] > 0 for c in cases for b in c["buildings"])
    # The 60 mm guard must fire in one case and not in the others, or the TS
    # side could mirror a constant `false`.
    assert [c["model_too_tall"] for c in cases] == [False, True, False]
    assert cases[1]["predicted_top_mm"] >= 60.0
    assert all(c["predicted_top_mm"] > c["base_top_mm"] for c in cases)
    # The nozzle-aware tree floor must bite in the fat-nozzle case and be a
    # no-op at the default nozzle, or the preview filter proves nothing.
    assert cases[0]["tree_min_radius_mm"] == 0.5
    assert cases[2]["tree_min_radius_mm"] > 0.5
    assert all(
        t["visible"] == t["visible_for"] and t["selected"] == t["selected_for"]
        for c in cases[:2]
        for t in c["trees"]
    )
    assert any(t["visible"] and not t["visible_for"] for t in cases[2]["trees"])
    assert all(not t["selected_for"] for t in cases[2]["trees"])


def test_parity_scene_is_a_valid_scene_graph() -> None:
    scene = SceneGraph(**json.loads(PARITY_SCENE.read_text(encoding="utf-8")))
    assert scene.stats.building_count == len(scene.buildings)
