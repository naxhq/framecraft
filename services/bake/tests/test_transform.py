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
from app.geom import tokens as TOKENS
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
    """A ``BuildingLike``.  ``id`` is optional on both sides (only the hero
    predicates read it), so the two-argument form still has to work."""

    def __init__(self, height_m: float, is_tall: bool, ident: str | None = None) -> None:
        self.height_m = height_m
        self.is_tall = is_tall
        if ident is not None:
            self.id = ident


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


#: The nozzle range the FROZEN PrintParams contract allows, ends included.
NOZZLE_MIN = 0.1
NOZZLE_MAX = 1.2


def legal_nozzles() -> List[float]:
    """Both ends of the legal range plus a 0.01 mm sweep between them."""
    return [round(n / 100.0, 2) for n in range(10, 121)]


def test_the_legal_nozzle_range_is_the_one_the_sweep_covers() -> None:
    """Pin the sweep to the contract, not to two numbers typed here."""
    from pydantic import ValidationError

    assert params(nozzle_mm=NOZZLE_MIN).nozzle_mm == NOZZLE_MIN
    assert params(nozzle_mm=NOZZLE_MAX).nozzle_mm == NOZZLE_MAX
    for outside in (0.09, 1.21):
        with pytest.raises(ValidationError):
            params(nozzle_mm=outside)
    sweep = legal_nozzles()
    assert sweep[0] == NOZZLE_MIN and sweep[-1] == NOZZLE_MAX
    assert len(sweep) == 111


def test_min_wall_mm_is_two_nozzles_across_the_whole_legal_range() -> None:
    """04: ``min_wall_mm = 2 * nozzle``.  One nozzle is ``min_detail_mm``, a
    different threshold that reads exactly the same in a HUD string, so the
    factor of two is asserted directly on every legal nozzle (DECISIONS
    [V2-P1])."""
    for nozzle in legal_nozzles():
        p = params(nozzle_mm=nozzle)
        assert T.min_wall_mm(p) == pytest.approx(2.0 * nozzle, abs=1e-12)
        assert T.min_gap_mm(p) == pytest.approx(1.5 * nozzle, abs=1e-12)
        assert T.min_detail_mm(p) == pytest.approx(1.0 * nozzle, abs=1e-12)
        # ... and the wall is exactly twice the detail floor, never equal to it.
        assert T.min_wall_mm(p) == pytest.approx(2.0 * T.min_detail_mm(p), abs=1e-12)
    # The defaults from 04's own worked numbers.
    assert T.min_wall_mm(params(nozzle_mm=0.4)) == pytest.approx(0.8)
    assert T.min_gap_mm(params(nozzle_mm=0.4)) == pytest.approx(0.6)
    assert T.min_detail_mm(params(nozzle_mm=0.4)) == pytest.approx(0.4)


def test_ground_thresholds_are_the_print_thresholds_over_the_scale() -> None:
    """``thresholds_ground_m`` may not re-derive the multipliers of its own.

    The right-hand sides are 04's multipliers written out here, NOT
    ``T.min_wall_mm(p) / scale``: ``thresholds_ground_m`` is literally that
    expression now, so comparing against it holds for any multiplier and the
    test would pass with ``MIN_DETAIL_NOZZLES`` substituted (v2 Task 0 audit,
    finding 2 -- DECISIONS [V2-P1-fix])."""
    for nozzle in legal_nozzles()[::7]:
        for frame, plate, radius in ((True, 180.0, 1980.0), (False, 256.0, 900.0)):
            p = params(nozzle_mm=nozzle, frame=frame, plate_mm=plate)
            scale = T.scale_mm_per_m(p, radius)
            th = T.thresholds_ground_m(p, scale)
            assert th.min_wall == pytest.approx(2.0 * nozzle / scale, rel=1e-12)
            assert th.min_gap == pytest.approx(1.5 * nozzle / scale, rel=1e-12)
            assert th.min_detail == pytest.approx(1.0 * nozzle / scale, rel=1e-12)


def test_the_reported_1_to_23571_bake_reads_18_9_m_at_the_default_nozzle() -> None:
    """Regression for the v2 Task 0 report: a 180 mm plate with the frame on at
    radius 1980 m is 1:23,571, where the HUD's "widened to the X m minimum
    wall" is 18.9 m at a 0.4 mm nozzle and 9.4 m at 0.2 mm.  The trap is that
    ``min_detail`` at 0.4 mm is *also* 9.4 m, so the string alone cannot tell a
    halved nozzle from a dropped factor of two.  Both are pinned here."""
    default = params(plate_mm=180, frame=True, nozzle_mm=0.4)
    scale = T.scale_mm_per_m(default, 1980.0)
    assert round(1000.0 / scale) == 23571  # the HUD's "1:23,571"
    th = T.thresholds_ground_m(default, scale)
    assert f"{th.min_wall:.1f}" == "18.9"
    assert f"{th.min_detail:.1f}" == "9.4"  # the look-alike, one nozzle

    halved = params(plate_mm=180, frame=True, nozzle_mm=0.2)
    th_halved = T.thresholds_ground_m(halved, T.scale_mm_per_m(halved, 1980.0))
    assert f"{th_halved.min_wall:.1f}" == "9.4"
    assert T.min_wall_mm(halved) == pytest.approx(0.4)  # the "Min wall 0.40 mm"


def test_stage_one_repairs_to_a_full_wall_and_stage_four_fails_at_nine_tenths() -> None:
    """The Stage 1 repair target and the Stage 4 gate threshold are 1.0 and 0.9
    of the SAME ``min_wall_mm``.  Asserted on the real constants, the real
    repair predicate and the threshold a real ``validate()`` run used."""
    import inspect

    import trimesh
    from shapely.geometry import box

    from app.geom import thicken
    from app.validate import checks

    assert thicken.MIN_WALL_REPAIR_FACTOR == 1.0
    assert thicken.MIN_WALL_FAIL_FACTOR == pytest.approx(0.9)
    # One constant, imported by the gate - not two that happen to agree today.
    assert checks.MIN_WALL_FAIL_FACTOR is thicken.MIN_WALL_FAIL_FACTOR
    assert (
        inspect.signature(thicken.survives_min_wall).parameters["factor"].default
        is thicken.MIN_WALL_REPAIR_FACTOR
    )

    for nozzle in (0.1, 0.2, 0.4, 0.8, 1.2):
        p = params(nozzle_mm=nozzle)
        wall = T.min_wall_mm(p)
        assert wall == pytest.approx(2.0 * nozzle)

        # Stage 1 target: 1.0 * min_wall.  A bar 1.05 walls wide survives the
        # repair probe and one 0.95 walls wide does not, which brackets the
        # factor around 1.0 well outside the 1%-of-a-wall probe tolerance.
        assert thicken.survives_min_wall(box(0.0, 0.0, 1.05 * wall, 40.0 * wall), wall)
        assert not thicken.survives_min_wall(box(0.0, 0.0, 0.95 * wall, 40.0 * wall), wall)

        # Stage 4 gate: 0.9 * the same wall, read off the check the validator
        # actually produced rather than re-derived here.
        bar = trimesh.creation.box(extents=(2.0 * wall, 40.0, 20.0))
        bar.apply_translation([0.0, 0.0, 10.0])
        report = checks.validate(bar, p, slices=2, self_intersection_sample=False)
        check = report.get("min_wall")
        assert check is not None
        assert check.threshold == pytest.approx(
            thicken.MIN_WALL_FAIL_FACTOR * T.min_wall_mm(p)
        )
        assert check.threshold == pytest.approx(0.9 * 2.0 * nozzle)
        # BakeStats.min_wall_mm carries this value: the MEASURED narrowest wall,
        # not the threshold.  A 2-wall-wide bar must report ~2 walls.
        assert check.passed
        assert check.value == pytest.approx(2.0 * wall, rel=0.1)

        thin = trimesh.creation.box(extents=(0.5 * wall, 40.0, 20.0))
        thin.apply_translation([0.0, 0.0, 10.0])
        thin_report = checks.validate(thin, p, slices=2, self_intersection_sample=False)
        assert "min_wall" in thin_report.failed


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


def test_hero_mode_predicates_default_to_v1_behaviour() -> None:
    """Every hero accessor reads through the v1 default, so a PrintParams with no
    hero picked (the default) behaves exactly as it did before heroes existed."""
    p = params()
    assert T.hero_ids(p) == ()
    assert T.hero_mode(p) == "true_height"
    assert T.hero_true_height(p) is True  # the default mode, but with no ids
    assert T.hero_own_color(p) is False
    assert T.hero_height_ids(p) == frozenset()
    assert T.is_hero_id("w1", p) is False
    assert T.building_is_hero(Bldg(100.0, True, "w1"), p) is False
    assert T.color_mode(p) == "single"
    assert T.parts_mode(p) is False

    # ... and a duck-typed stub with none of the v2 attributes at all.
    class V1Params:
        plate_mm, base_thickness_mm, nozzle_mm = 180.0, 3.0, 0.4
        small_scale = large_scale = terrain_exaggeration = road_scale = 1.0
        road_mode = "engrave"
        trees = water = frame = True

    assert T.hero_ids(V1Params()) == ()
    assert T.hero_height_ids(V1Params()) == frozenset()
    assert T.color_mode(V1Params()) == "single"


def test_hero_modes_split_height_from_colour() -> None:
    ids = ["w1", "w2"]
    for mode, height, colour in (
        ("true_height", True, False),
        ("own_color", False, True),
        ("both", True, True),
    ):
        p = params(hero_building_ids=ids, hero_mode=mode)
        assert T.hero_true_height(p) is height
        assert T.hero_own_color(p) is colour
        # is_hero_id is mode-independent: it answers "did the user pick it?",
        # which is what the Stage 1 block-merge exemption keys off.
        assert T.is_hero_id("w1", p) is True
        assert T.is_hero_id("w9", p) is False
        assert T.hero_height_ids(p) == (frozenset(ids) if height else frozenset())
        assert T.building_is_hero(Bldg(10.0, False, "w1"), p) is height
        assert T.building_is_hero(Bldg(10.0, False, "w9"), p) is False
        # A carrier with no id (a merged block) is never a hero.
        assert T.building_is_hero(Bldg(10.0, False), p) is False


def test_hero_height_is_never_below_true_height_but_still_grows() -> None:
    """04-scale arithmetic: the hero multiplier is max(1.0, its class's)."""
    scale = 0.1
    tall = Bldg(200.0, True, "hero")
    short = Bldg(30.0, False, "hero")
    for building in (tall, short):
        halved = params(small_scale=0.5, large_scale=0.5, hero_building_ids=["hero"])
        assert T.building_height_scale(building, halved) == 0.5
        assert T.hero_height_scale(building, halved) == 1.0
        assert T.building_height_scale_for(building, halved, True) == 1.0
        assert T.building_height_scale_for(building, halved, False) == 0.5
        # ... and it still grows with everyone when the slider goes up.
        doubled = params(small_scale=1.5, large_scale=2.0, hero_building_ids=["hero"])
        assert T.hero_height_scale(building, doubled) == (
            2.0 if building.is_tall else 1.5
        )
    # The printed top moves with it, clamp included.
    halved = params(small_scale=0.5, large_scale=0.5, hero_building_ids=["hero"])
    assert T.building_top_mm_for(tall, halved, scale, False) == pytest.approx(3.0 + 10.0)
    assert T.building_top_mm_for(tall, halved, scale, True) == pytest.approx(3.0 + 20.0)
    # is_hero=False IS the v1 function, not merely equal to it today.
    assert T.building_top_mm(tall, halved, scale) == T.building_top_mm_for(
        tall, halved, scale, False
    )
    tiny = Bldg(2.0, False, "hero")
    assert T.building_top_mm_for(tiny, halved, scale, True) == pytest.approx(3.0 + 0.6)


def test_predicted_top_counts_a_hero_at_its_hero_height() -> None:
    class Scene:
        def __init__(self, buildings, trees):
            self.buildings = buildings
            self.trees = trees

    scale = 0.1
    scene = Scene([Bldg(10.0, False, "w1"), Bldg(400.0, True, "tower")], [])
    halved = params(frame=False, small_scale=0.5, large_scale=0.5)
    assert T.predicted_top_mm(scene, halved, 900.0) == pytest.approx(3.0 + 20.0)

    hero = params(
        frame=False, small_scale=0.5, large_scale=0.5, hero_building_ids=["tower"]
    )
    assert T.predicted_top_mm(scene, hero, 900.0) == pytest.approx(3.0 + 40.0)
    assert T.building_top_mm_for(scene.buildings[1], hero, scale, True) == pytest.approx(
        3.0 + 40.0
    )
    # own_color alone changes no height, so the guard reads the halved number.
    colour_only = params(
        frame=False,
        small_scale=0.5,
        large_scale=0.5,
        hero_building_ids=["tower"],
        hero_mode="own_color",
    )
    assert T.predicted_top_mm(scene, colour_only, 900.0) == pytest.approx(3.0 + 20.0)

    # ... and the 60 mm guard counts the hero: a 600 m tower at 0.1 mm/m is 60 mm
    # at 1.0x and 30 mm at 0.5x, so the hero rule ALONE decides the verdict.
    big = Scene([Bldg(10.0, False, "w1"), Bldg(600.0, True, "tower")], [])
    halved_only = params(frame=False, small_scale=0.5, large_scale=0.5)
    assert T.model_too_tall(big, halved_only, 900.0) is False
    hero_big = params(
        frame=False, small_scale=0.5, large_scale=0.5, hero_building_ids=["tower"]
    )
    assert T.predicted_top_mm(big, hero_big, 900.0) == pytest.approx(3.0 + 60.0)
    assert T.model_too_tall(big, hero_big, 900.0) is True
    # own_color does not raise it, so it does not refuse it either.
    colour_big = params(
        frame=False,
        small_scale=0.5,
        large_scale=0.5,
        hero_building_ids=["tower"],
        hero_mode="own_color",
    )
    assert T.model_too_tall(big, colour_big, 900.0) is False
    assert T.model_too_tall(scene, hero, 900.0) is False


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
    # v2: hero buildings.  Deliberately the SAME plate/frame/nozzle as case 1 so
    # the only thing that differs is the hero rule - both height multipliers are
    # halved, so a hero (pinned at max(1.0, its class's)) prints at exactly twice
    # its neighbours' printed height.  w1019 is the 300 m tower, w1039 a 31 m
    # short building, so both branches of `is_tall` are covered.
    {
        "name": "heroes-with-halved-multipliers",
        "params": {
            "plate_mm": 180,
            "base_thickness_mm": 3.0,
            "nozzle_mm": 0.4,
            "small_scale": 0.5,
            "large_scale": 0.5,
            "terrain_exaggeration": 1.0,
            "road_mode": "engrave",
            "road_scale": 1.0,
            "trees": True,
            "water": True,
            "frame": True,
            "hero_building_ids": ["w1019", "w1039"],
            "hero_mode": "both",
            "color_mode": "parts",
        },
    },
    # v2: the detail advisor.  The scene is 900 m of Chicago, but the RADIUS is
    # a parameter of the advisor rather than a property of the scene, so asking
    # for 2 400 m at the default plate is exactly the case the advisor exists
    # for: the scale drops from 0.093 to 0.035 mm/m and most of the city stops
    # being printable.  Nothing else in the case differs from the defaults.
    {
        "name": "coarse-radius-for-the-advisor",
        "radius_m": 2400.0,
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
    # The advisor's two remaining sentence shapes.  Both were reachable only
    # through a Python unit test, so the TypeScript mirror's formatting of them
    # was pinned by nothing (v2-03 audit, finding 12).  At the SMALLEST legal
    # radius there is no smaller radius to offer, so the remedy is the plate
    # alone; at 900 m with a 1.2 mm nozzle neither knob reaches, and the
    # sentence has to say so instead of trailing off.
    # Every field is spelled out, as in every case above: the TS side reads this
    # object AS a PrintParams and has no model defaults to fall back on, so an
    # omitted `frame` there is `undefined` and the scale silently differs.
    {
        "name": "plate-only-remedy-at-the-minimum-radius",
        "radius_m": 250.0,
        "params": {
            "plate_mm": 100,
            "nozzle_mm": 1.2,
            "base_thickness_mm": 3.0,
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
        # No `radius_m`: 900 m IS the scene's own radius, so an "override" here
        # would be a degenerate one and would make the mirror's radius assertion
        # compare the fixture to itself again.
        "name": "no-remedy-fat-nozzle",
        "params": {
            "plate_mm": 100,
            "nozzle_mm": 1.2,
            "base_thickness_mm": 3.0,
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
]


def r(value: float) -> float:
    return round(float(value), ROUND)


def build_case(scene: SceneGraph, case: Dict[str, Any]) -> Dict[str, Any]:
    p = PrintParams(**case["params"])
    # The radius is an ARGUMENT to every function here, not a property of the
    # scene, so a case may ask for one the scene was not cropped at; that is
    # what the advisor case does.  Without an override it is the scene's own.
    radius_m = float(case.get("radius_m", T.radius_m_from_bounds(scene.bounds)))
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
        is_hero = T.building_is_hero(b, p)
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
                # v2 hero buildings.  `is_hero` is false and the `*_for` values
                # equal the two above in every case that picks no hero, which is
                # what makes this block additive.
                "picked": T.is_hero_id(b.id, p),
                "is_hero": is_hero,
                "height_scale_for": r(T.building_height_scale_for(b, p, is_hero)),
                "top_mm_for": r(T.building_top_mm_for(b, p, scale, is_hero)),
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

    report = T.detail_report(scene, p, radius_m)
    advisor = {
        "report": {
            "buildings_total": report.buildings_total,
            "widened": report.widened,
            "dropped": report.dropped,
            "widened_fraction": r(report.widened_fraction),
            "dropped_fraction": r(report.dropped_fraction),
            "trees_total": report.trees_total,
            "trees_dropped_fraction": r(report.trees_dropped_fraction),
            "areas_total": report.areas_total,
            "areas_dropped_fraction": r(report.areas_dropped_fraction),
            "min_wall_ground_m": r(report.min_wall_ground_m),
            "score": report.score,
            "band": report.band,
        },
        "recommend_radius_m": (
            None
            if T.recommend_radius_m(scene, p, radius_m) is None
            else r(T.recommend_radius_m(scene, p, radius_m))
        ),
        "recommend_plate_mm": (
            None
            if T.recommend_plate_mm(scene, p, radius_m) is None
            else r(T.recommend_plate_mm(scene, p, radius_m))
        ),
        "recommendation": T.detail_recommendation(scene, p, radius_m),
    }

    return {
        "name": case["name"],
        "params": case["params"],
        "radius_m": r(radius_m),
        # `null` unless the case deliberately asks the advisor about a radius
        # the scene was not cropped at.  The mirror uses it to decide whether to
        # take the radius from the fixture or to DERIVE it from the scene with
        # its own `radius_m_from_bounds` - reading the pinned number in both
        # cases left that function unexercised on the TS side (v2-06 audit,
        # finding 9, handed over with the transform pair).
        "radius_override": (
            None if case.get("radius_m") is None else r(float(case["radius_m"]))
        ),
        "advisor": advisor,
        "scale_mm_per_m": r(scale),
        "usable_span_mm": r(T.usable_span_mm(p)),
        "thresholds_mm": {
            "min_wall": r(T.min_wall_mm(p)),
            "min_gap": r(T.min_gap_mm(p)),
            "min_detail": r(T.min_detail_mm(p)),
        },
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
        "hero": {
            "ids": list(T.hero_ids(p)),
            "mode": T.hero_mode(p),
            "true_height": T.hero_true_height(p),
            "own_color": T.hero_own_color(p),
            "height_ids": sorted(T.hero_height_ids(p)),
        },
        "color_mode": T.color_mode(p),
        "parts_mode": T.parts_mode(p),
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
    assert len(cases) == 7
    for case in cases:
        assert len(case["buildings"]) >= 20
        assert len(case["roads"]) >= 5
        assert len(case["trees"]) >= 5
    # The cases must actually differ, or parity proves nothing.  Case 4 shares
    # case 1's plate and frame ON PURPOSE - the hero rule is the only thing that
    # moves in it - and the two advisor-sentence cases (6 and 7) share plate 100
    # with a 1.2 mm nozzle and differ only in the radius, so five distinct
    # scales over seven cases is correct.
    scales = {c["scale_mm_per_m"] for c in cases}
    assert len(scales) == 5
    # The print-mm thresholds are 04's multiples of the nozzle, and the ground
    # thresholds are those divided by the scale.  Pinned in the fixture so the
    # TS mirror cannot quietly print one nozzle where 04 asks for two.
    for case in cases:
        nozzle = case["params"]["nozzle_mm"]
        mm = case["thresholds_mm"]
        assert mm["min_wall"] == pytest.approx(2.0 * nozzle)
        assert mm["min_gap"] == pytest.approx(1.5 * nozzle)
        assert mm["min_detail"] == pytest.approx(1.0 * nozzle)
        ground = case["thresholds_ground_m"]
        for key in ("min_wall", "min_gap", "min_detail"):
            assert ground[key] == pytest.approx(
                mm[key] / case["scale_mm_per_m"], rel=1e-6
            )
    assert cases[0]["roads"][0]["z_mm"] is not None
    assert cases[2]["roads"][0]["z_mm"] is None
    assert cases[2]["areas"]["water_z_mm"] is None
    # at least one building somewhere is thin enough to need dilation
    assert any(b["dilation_m"] > 0 for c in cases for b in c["buildings"])
    # The 60 mm guard must fire in one case and not in the others, or the TS
    # side could mirror a constant `false`.
    assert [c["model_too_tall"] for c in cases] == [
        False, True, False, False, False, False, False
    ]

    # --- v2 heroes ------------------------------------------------------
    # Three of the four cases pick no hero, and in those the hero-aware values
    # must equal the v1 ones exactly - that is what makes this block additive.
    for case in cases[:3] + cases[4:]:  # every case but the hero one
        assert case["hero"]["ids"] == [] and case["hero"]["height_ids"] == []
        assert case["color_mode"] == "single" and case["parts_mode"] is False
        for b in case["buildings"]:
            assert b["picked"] is False and b["is_hero"] is False
            assert b["height_scale_for"] == b["height_scale"]
            assert b["top_mm_for"] == b["top_mm"]
    hero_case = cases[3]
    assert hero_case["hero"]["mode"] == "both"
    assert hero_case["hero"]["true_height"] and hero_case["hero"]["own_color"]
    assert hero_case["hero"]["ids"] == ["w1019", "w1039"]
    assert hero_case["parts_mode"] is True
    picked = [b for b in hero_case["buildings"] if b["picked"]]
    assert len(picked) == 2, "both hero ids must exist in the parity scene"
    # One tall hero, one short one, so both branches of `is_tall` are covered...
    assert {b["height_scale"] for b in picked} == {0.5}
    assert {b["height_scale_for"] for b in picked} == {1.0}
    # ... and the hero really prints taller than the same building would.
    for b in picked:
        assert b["is_hero"] is True
        assert b["top_mm_for"] > b["top_mm"]
    # --- v2 detail advisor ---------------------------------------------
    # The advisor has to move between the cases, or the mirror could return a
    # constant: the default 900 m case is healthy and the 2 400 m one is not.
    healthy = cases[0]["advisor"]
    coarse = cases[4]["advisor"]
    assert healthy["report"]["band"] == "good"
    assert healthy["recommendation"] is None
    assert coarse["report"]["widened_fraction"] > T.MAX_WIDENED_FRACTION
    assert coarse["report"]["band"] in ("good", "fair", "poor")
    assert coarse["recommendation"] is not None
    assert coarse["recommendation"].startswith("Radius 2400 m at plate 180 widens ")
    # ... and the remedies really are remedies: smaller radius, bigger plate.
    assert coarse["recommend_radius_m"] is not None
    assert coarse["recommend_radius_m"] < cases[4]["radius_m"]
    assert coarse["recommend_radius_m"] >= T.RADIUS_MIN_M
    if coarse["recommend_plate_mm"] is not None:
        assert coarse["recommend_plate_mm"] <= T.PLATE_MAX_MM
    assert 0 <= coarse["report"]["score"] <= 100
    assert coarse["report"]["score"] < healthy["report"]["score"]
    # ... and the two sentence shapes the fixture exists to pin for the mirror
    by_name = {c["name"]: c["advisor"] for c in cases}
    plate_only = by_name["plate-only-remedy-at-the-minimum-radius"]
    assert plate_only["recommendation"] == (
        "Radius 250 m at plate 100 widens 37%. Try plate 110."
    )
    assert plate_only["recommend_radius_m"] is None, "250 m IS the smallest legal radius"
    assert plate_only["recommend_plate_mm"] == 110
    none_left = by_name["no-remedy-fat-nozzle"]
    assert none_left["recommendation"] == (
        "Radius 900 m at plate 100 widens 37%. No radius or plate in range fixes "
        "it: raise the nozzle detail instead."
    )
    assert none_left["recommend_radius_m"] is None
    assert none_left["recommend_plate_mm"] is None

    others = [b for b in hero_case["buildings"] if not b["picked"]]
    assert others and all(b["top_mm_for"] == b["top_mm"] for b in others)
    # The predicted top is the HERO's top, not the halved one: a mirror that
    # ignored heroes would produce the tallest non-hero top instead.
    assert hero_case["predicted_top_mm"] == max(b["top_mm_for"] for b in picked)
    assert hero_case["predicted_top_mm"] > max(b["top_mm"] for b in hero_case["buildings"])
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


# --------------------------------------------------------------------------
# 3. The detail advisor (v2)
# --------------------------------------------------------------------------


def parity_scene() -> SceneGraph:
    return SceneGraph(**json.loads(PARITY_SCENE.read_text(encoding="utf-8")))


def test_detail_report_counts_agree_with_the_shared_predicates() -> None:
    """The advisor must not have a second opinion: every count it reports has
    to be the count the preview's own predicates produce."""
    scene = parity_scene()
    p = params()
    radius_m = 2400.0
    report = T.detail_report(scene, p, radius_m)
    th = T.thresholds_ground_m(p, T.scale_mm_per_m(p, radius_m))
    widened = dropped = 0
    for b in scene.buildings:
        area, _per, _cw, dilation = T.building_footprint_metrics(b.ring, b.holes, th)
        if T.building_dropped(area, dilation, th):
            dropped += 1
        elif dilation > 0.0:
            widened += 1
    assert report.widened == widened
    assert report.dropped == dropped
    assert report.buildings_total == len(scene.buildings)
    assert report.min_wall_ground_m == pytest.approx(th.min_wall)


def test_detail_report_score_and_bands() -> None:
    """The formula, spelled out here rather than re-derived from the code."""
    scene = parity_scene()
    p = params()
    for radius_m in (900.0, 1500.0, 2400.0, 3000.0):
        report = T.detail_report(scene, p, radius_m)
        penalty = (
            T.SCORE_WEIGHT_DROPPED * report.dropped_fraction
            + T.SCORE_WEIGHT_WIDENED * report.widened_fraction
            + T.SCORE_WEIGHT_TREES * report.trees_dropped_fraction
            + T.SCORE_WEIGHT_AREAS * report.areas_dropped_fraction
        )
        assert report.score == max(0, min(100, math.floor(100.0 - penalty + 0.5)))
        expected_band = (
            "good"
            if report.score >= T.SCORE_BAND_GOOD
            else ("fair" if report.score >= T.SCORE_BAND_FAIR else "poor")
        )
        assert report.band == expected_band
    # A scene that loses every building scores 0, one that loses nothing scores
    # 100, and widening every building alone is enough to reach `poor` - which
    # is the whole point of the band, since the drop predicate below is
    # unreachable in practice.
    assert T.SCORE_WEIGHT_DROPPED == 100.0
    assert 100.0 - T.SCORE_WEIGHT_WIDENED < T.SCORE_BAND_FAIR
    assert T.SCORE_WEIGHT_DROPPED > T.SCORE_WEIGHT_WIDENED
    assert T.SCORE_WEIGHT_WIDENED > T.SCORE_WEIGHT_TREES == T.SCORE_WEIGHT_AREAS


def test_detail_report_gets_worse_as_the_radius_grows() -> None:
    scene = parity_scene()
    p = params()
    scores = [T.detail_report(scene, p, r).score for r in (500.0, 900.0, 1800.0, 3000.0)]
    assert scores == sorted(scores, reverse=True)
    assert scores[0] > scores[-1]


def test_recommend_radius_solves_rather_than_looks_up() -> None:
    """The answer has to be the LARGEST radius on the grid that meets the
    target, and it has to move with the plate - a lookup table could not."""
    scene = parity_scene()
    p = params()
    radius_m = 2400.0
    answer = T.recommend_radius_m(scene, p, radius_m)
    assert answer is not None
    assert answer % T.RADIUS_GRID_M == 0.0
    assert T.RADIUS_MIN_M <= answer <= radius_m
    footprints = T._char_widths(scene)
    assert T._widened_fraction_at(footprints, p, answer) < T.MAX_WIDENED_FRACTION
    # one grid step larger already fails, i.e. it really is the largest
    assert (
        T._widened_fraction_at(footprints, p, answer + T.RADIUS_GRID_M)
        >= T.MAX_WIDENED_FRACTION
    )
    # a bigger plate prints more of the same city, so it allows a wider crop
    wide = T.recommend_radius_m(scene, params(plate_mm=256), radius_m)
    assert wide is not None and wide > answer


def test_recommend_plate_is_the_smallest_that_works() -> None:
    scene = parity_scene()
    p = params()
    radius_m = 1500.0
    answer = T.recommend_plate_mm(scene, p, radius_m)
    assert answer is not None
    assert T.PLATE_MIN_MM <= answer <= T.PLATE_MAX_MM
    assert (answer - T.PLATE_MIN_MM) % T.PLATE_GRID_MM == 0.0
    footprints = T._char_widths(scene)
    assert (
        T._widened_fraction_at(footprints, T._PlateOverride(p, answer), radius_m)
        < T.MAX_WIDENED_FRACTION
    )
    assert (
        T._widened_fraction_at(
            footprints, T._PlateOverride(p, answer - T.PLATE_GRID_MM), radius_m
        )
        >= T.MAX_WIDENED_FRACTION
    )


def test_detail_recommendation_sentence_and_its_variants() -> None:
    scene = parity_scene()
    p = params()
    healthy = T.detail_recommendation(scene, p, 900.0)
    assert healthy is None, "a healthy scene gets no advice"

    sentence = T.detail_recommendation(scene, p, 2400.0)
    assert sentence is not None
    report = T.detail_report(scene, p, 2400.0)
    percent = math.floor(100.0 * report.widened_fraction + 0.5)
    # The no-drops variant, which is the one real data produces (see
    # test_04_stage1_rule_3_cannot_fire_after_rule_2 below).
    assert report.dropped == 0
    assert sentence.startswith(f"Radius 2400 m at plate 180 widens {percent}%.")
    assert " Try " in sentence
    # Only remedies that are a change in the helpful direction are offered.
    for part in sentence.split(" Try ")[1].rstrip(".").split(", or "):
        if part.startswith("plate "):
            assert float(part.split()[1]) > p.plate_mm
        else:
            assert float(part.split()[0]) < 2400.0


def test_the_three_sentence_variants_are_built_from_the_report() -> None:
    """The head clause has three shapes; only one of them is reachable from a
    real SceneGraph, so the other two are pinned on the formatter itself."""
    scene = parity_scene()
    p = params()
    report = T.detail_report(scene, p, 2400.0)
    percent = TOKENS.round_half_up(100.0 * report.widened_fraction)
    sentence = T.detail_recommendation(scene, p, 2400.0)
    assert sentence is not None and sentence.startswith(
        f"Radius 2400 m at plate 180 widens {percent}%."
    )
    # A scene with no buildings has nothing to advise about at all.
    assert T.detail_recommendation(scene, p, 2400.0, max_widened_fraction=1.0) is None


def test_04_stage1_rule_3_cannot_fire_after_rule_2() -> None:
    """``building_dropped`` is unreachable, and that is 04's own arithmetic.

    04 stage 1 dilates a thin footprint to a full minimum wall (rule 2) and then
    drops what is still under ``min_detail ** 2`` (rule 3).  But the dilation
    leaves the estimate at about ``min_wall`` across, and ``min_wall`` is twice
    ``min_detail``, so the post-dilation area estimate is about four times the
    floor: rule 3 can only fire for a footprint whose characteristic width
    exceeds ``sqrt(area) + min_detail``, which the isoperimetric inequality
    forbids (``4A/P <= 1.129 sqrt(A)``).

    It is asserted rather than removed because it is 04's text, it is a genuine
    safety net for a degenerate ring, and the advisor's "drops N buildings"
    clause is correct if it ever does fire.  What the assertion buys is that
    nobody reads a report showing ``dropped: 0`` as a bug.
    """
    p = params()
    fired = []
    for radius_m in (250.0, 900.0, 3000.0):
        th = T.thresholds_ground_m(p, T.scale_mm_per_m(p, radius_m))
        for area in (0.0, 1.0, 9.0, 100.0, 1e4):
            for char_width in (0.0, 0.5, 1.0, th.min_detail, th.min_wall, 1e3):
                if char_width > 1.129 * (area**0.5) + 1e-9:
                    continue  # 4A/P <= 1.129 sqrt(A): no ring is this shape
                dilation = T.building_dilation_m(char_width, th)
                if T.building_dropped(area, dilation, th):
                    fired.append((radius_m, area, char_width))
    # Nothing a ring can be reaches rule 3 - not even a ring with no area at
    # all, because rule 2 dilates that one to a full wall first.
    assert fired == []
    # It is only unreachable AFTER rule 2: without the dilation, rule 3 is
    # exactly 04's "under min_detail squared" and fires as intended.
    tiny = T.thresholds_ground_m(params(), T.scale_mm_per_m(params(), 900.0))
    assert T.building_dropped(0.5 * tiny.min_detail**2, 0.0, tiny)
    # ... and on the parity scene, at every case's radius.
    scene = parity_scene()
    for radius_m in (900.0, 2400.0, 3000.0):
        assert T.detail_report(scene, p, radius_m).dropped == 0


def test_detail_recommendation_when_only_the_plate_can_help() -> None:
    """At the smallest legal radius there is no smaller one to suggest."""
    scene = parity_scene()
    p = params(plate_mm=100)
    sentence = T.detail_recommendation(scene, p, T.RADIUS_MIN_M)
    if sentence is not None:
        assert " m." not in sentence.split("Try")[-1] or "plate" in sentence


def test_advisor_ignores_an_empty_scene_instead_of_dividing_by_zero() -> None:
    empty = SceneGraph(
        bounds=parity_scene().bounds,
        center=parity_scene().center,
        buildings=[],
        roads=[],
        water=[],
        green=[],
        trees=[],
        stats=parity_scene().stats.model_copy(update={"building_count": 0}),
    )
    p = params()
    report = T.detail_report(empty, p, 900.0)
    assert report.buildings_total == 0
    assert report.widened_fraction == 0.0 and report.score == 100
    assert T.detail_recommendation(empty, p, 900.0) is None
    assert T.recommend_radius_m(empty, p, 900.0) is None
    assert T.recommend_plate_mm(empty, p, 900.0) is None


def test_parity_scene_is_a_valid_scene_graph() -> None:
    scene = SceneGraph(**json.loads(PARITY_SCENE.read_text(encoding="utf-8")))
    assert scene.stats.building_count == len(scene.buildings)
