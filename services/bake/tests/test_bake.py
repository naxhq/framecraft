"""Phase 3 (mesh-bake) tests: the 04 pipeline, the validators, the API.

Everything here runs offline (``tests/conftest.py`` exports
``FRAMECRAFT_OFFLINE=1``); the Chicago golden test reads the committed Overpass
fixture through the same ingest path ``POST /scene`` uses.

Layout:

* ``test_golden_*``     - the Chicago preset at default params, every validator.
* ``test_stage1_*``     - the synthetic minimum-feature suite (04 stage 1).
* ``test_assembly_*``   - parameters that change the solid (04 stage 2).
* ``test_export_*``     - 3MF package structure, STL, sidecar, CREDITS.
* ``test_validator_*``  - the gate itself, including that it is not vacuous.
* ``test_api_*``        - POST /bake, GET /bake/{id}, GET /files/{name}.
"""
from __future__ import annotations

import json
import time
import zipfile
from pathlib import Path

import numpy as np
import pytest
import shapely
import trimesh
from fastapi.testclient import TestClient
from shapely.geometry import Polygon

from app import bake as bake_pipeline
from app import cli
from app import main as main_module
from app.contracts import (
    AreaFeature,
    BakeResult,
    Bounds,
    Building,
    Center,
    PrintParams,
    Road,
    SceneGraph,
    SceneRequest,
    Stats,
    Tree,
)
from app.export import mf3
from app.geom import assemble, extrude, thicken
from app.geom import transform as T
from app.ingest import normalize, overpass, presets
from app.validate import checks as validators

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "fixtures"

#: Synthetic scenes use a small radius so the thresholds are metres, not tens of
#: metres: at 250 m radius on a 180 mm plate with the frame on, scale is
#: 0.336 mm/m, min_wall 2.38 m, min_gap 1.79 m, min_detail 1.19 m.
SYNTH_RADIUS_M = 250.0


# --------------------------------------------------------------------------
# Scene builders
# --------------------------------------------------------------------------


def square_ring(cx: float, cy: float, size: float) -> list[tuple[float, float]]:
    """A CCW square ring, first vertex not repeated (DECISIONS [P1])."""
    h = size / 2.0
    return [(cx - h, cy - h), (cx + h, cy - h), (cx + h, cy + h), (cx - h, cy + h)]


def square_hole(cx: float, cy: float, size: float) -> list[tuple[float, float]]:
    """A CW ring, for use as a hole."""
    return list(reversed(square_ring(cx, cy, size)))


def building(
    ident: str,
    cx: float,
    cy: float,
    size: float,
    height: float,
    holes: list[list[tuple[float, float]]] | None = None,
    ring: list[tuple[float, float]] | None = None,
) -> Building:
    return Building(
        id=ident,
        ring=ring if ring is not None else square_ring(cx, cy, size),
        holes=holes or [],
        height_m=height,
        height_source="tag",
        min_height_m=0.0,
        is_tall=height >= T.TALL_BUILDING_M,
    )


def scene_graph(
    *,
    buildings: list[Building] | None = None,
    roads: list[Road] | None = None,
    water: list[AreaFeature] | None = None,
    green: list[AreaFeature] | None = None,
    trees: list[Tree] | None = None,
    radius: float = SYNTH_RADIUS_M,
    coverage: str = "good",
) -> SceneGraph:
    buildings = buildings or []
    return SceneGraph(
        bounds=Bounds(min_x=-radius, min_y=-radius, max_x=radius, max_y=radius),
        center=Center(lat=41.8827, lon=-87.6233),
        buildings=buildings,
        roads=roads or [],
        water=water or [],
        green=green or [],
        trees=trees or [],
        stats=Stats(
            building_count=len(buildings), coverage=coverage, height_tag_ratio=0.5
        ),
    )


def synth_request(radius: float = SYNTH_RADIUS_M) -> SceneRequest:
    return SceneRequest(
        lat=41.8827, lon=-87.6233, radius_m=radius, rotation_deg=0.0, preset_id=None
    )


def bake(
    scene: SceneGraph,
    params: PrintParams,
    tmp_path: Path,
    stem: str = "t",
    height_guard: bool = True,
):
    """Run the pipeline into a temp directory, debug dumps included."""
    return bake_pipeline.run_pipeline(
        scene,
        synth_request(T.radius_m_from_bounds(scene.bounds)),
        params,
        job_id=stem,
        out_dir=tmp_path,
        stem=stem,
        debug_root=tmp_path / "debug",
        height_guard=height_guard,
    )


def assert_all_validators_pass(report: validators.ValidationReport) -> None:
    failed = [f"{c.name}: {c.message}" for c in report.checks if not c.passed]
    assert not failed, "\n".join(failed)


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------


@pytest.fixture(scope="session")
def chicago_scene() -> SceneGraph:
    """The Chicago preset through the real ingest path, from the fixture."""
    request = presets.PRESETS_BY_ID["chicago-loop"].request()
    raw = overpass.load_raw(request, allow_network=False)
    return normalize.build_scene(raw, request)


@pytest.fixture(scope="session")
def chicago_bake(tmp_path_factory) -> tuple:
    """Bake Chicago once at default params; every golden test reads this."""
    scene_request = presets.PRESETS_BY_ID["chicago-loop"].request()
    raw = overpass.load_raw(scene_request, allow_network=False)
    scene = normalize.build_scene(raw, scene_request)
    out_dir = tmp_path_factory.mktemp("chicago")
    started = time.perf_counter()
    output = bake_pipeline.run_pipeline(
        scene,
        scene_request,
        PrintParams(),
        job_id="goldenchi",
        out_dir=out_dir,
        stem="chicago",
    )
    elapsed = time.perf_counter() - started
    print(f"\n[golden] Chicago bake: {elapsed:.1f} s, {output.result.stats.triangles} triangles")
    return output, elapsed, out_dir, scene


# ==========================================================================
# Golden: the Chicago preset at default params
# ==========================================================================


def test_golden_chicago_passes_every_validator(chicago_bake):
    output, _elapsed, _out_dir, _scene = chicago_bake
    assert_all_validators_pass(output.report)
    assert output.result.status == "done"
    assert output.result.error is None
    assert output.result.progress == 1.0


def test_golden_chicago_stats(chicago_bake):
    output, _elapsed, _out_dir, _scene = chicago_bake
    stats = output.result.stats
    assert stats is not None
    assert 0 < stats.triangles < validators.TRIANGLE_BUDGET
    assert stats.bbox_mm[0] <= 180.01 and stats.bbox_mm[1] <= 180.01
    assert stats.bbox_mm[2] < validators.MAX_HEIGHT_MM
    assert stats.is_manifold is True
    assert stats.est_grams > 0.0
    assert stats.volume_mm3 > 0.0
    assert stats.min_wall_mm >= 0.9 * 2 * PrintParams().nozzle_mm


def test_golden_chicago_sits_at_zero_and_is_centred(chicago_bake):
    output, _elapsed, out_dir, _scene = chicago_bake
    mesh = trimesh.load(out_dir / "chicago.3mf", force="mesh", process=False)
    assert abs(mesh.bounds[0][2]) <= validators.SIT_TOLERANCE_MM
    centre = (mesh.bounds[0] + mesh.bounds[1]) / 2.0
    assert abs(centre[0]) < 1e-6 and abs(centre[1]) < 1e-6


def test_golden_chicago_is_under_the_time_budget(chicago_bake):
    _output, elapsed, _out_dir, _scene = chicago_bake
    assert elapsed < 90.0, f"Chicago bake took {elapsed:.1f} s, budget is 90 s"


def test_golden_chicago_warns_about_the_repairs_it_made(chicago_bake):
    output, _elapsed, _out_dir, _scene = chicago_bake
    joined = " | ".join(output.result.warnings)
    assert "widened to meet minimum feature size" in joined
    assert "block heights merged" in joined


def test_golden_chicago_writes_every_artifact(chicago_bake):
    output, _elapsed, out_dir, _scene = chicago_bake
    assert (out_dir / "chicago.3mf").is_file()
    assert (out_dir / "chicago.stl").is_file()
    assert (out_dir / "chicago.json").is_file()
    assert (out_dir / "CREDITS.txt").is_file()
    assert output.result.files is not None
    assert output.result.files.file_3mf == "/files/chicago.3mf"
    assert output.result.files.stl == "/files/chicago.stl"


def test_golden_chicago_revalidates_from_the_written_3mf(chicago_bake):
    output, _elapsed, out_dir, _scene = chicago_bake
    mesh = trimesh.load(out_dir / "chicago.3mf", force="mesh", process=False)
    report = validators.validate(mesh, PrintParams())
    assert_all_validators_pass(report)
    assert len(mesh.faces) == output.result.stats.triangles


# ==========================================================================
# Stage 1: synthetic minimum-feature suite
# ==========================================================================


def test_stage1_single_square_building(tmp_path):
    scene = scene_graph(buildings=[building("w1", 0, 0, 40.0, 30.0)])
    output = bake(scene, PrintParams(), tmp_path, "square")
    assert_all_validators_pass(output.report)
    assert output.result.status == "done"

    params = PrintParams()
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    expected_top = T.base_top_mm(params) + 30.0 * scale
    # frame lip is 2 mm over the base top and the building is taller than that
    assert output.result.stats.bbox_mm[2] == pytest.approx(expected_top, abs=1e-6)


def test_stage1_two_buildings_closer_than_min_gap_merge_into_one_block():
    params = PrintParams()
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    thresholds = T.thresholds_ground_m(params, scale)
    gap = thresholds.min_gap * 0.5  # unprintable
    scene = scene_graph(
        buildings=[
            building("a", -(20.0 + gap / 2.0), 0, 40.0, 20.0),
            building("b", +(20.0 + gap / 2.0), 0, 40.0, 20.0),
        ]
    )
    repaired = thicken.repair_scene(scene, params)
    blocks = repaired.buildings.blocks
    assert len(blocks) == 1, "a sub-min-gap sliver must close into one block"
    assert repaired.buildings.merged_components == 1
    assert blocks[0].height.height_m == pytest.approx(20.0)


def test_stage1_two_buildings_further_than_min_gap_stay_separate():
    params = PrintParams()
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    thresholds = T.thresholds_ground_m(params, scale)
    gap = thresholds.min_gap * 4.0
    scene = scene_graph(
        buildings=[
            building("a", -(20.0 + gap / 2.0), 0, 40.0, 20.0),
            building("b", +(20.0 + gap / 2.0), 0, 40.0, 20.0),
        ]
    )
    repaired = thicken.repair_scene(scene, params)
    assert len(repaired.buildings.blocks) == 2


def test_stage1_block_height_is_the_area_weighted_80th_percentile():
    """A small tower must not raise the whole block, and must survive on top."""
    params = PrintParams()
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    thresholds = T.thresholds_ground_m(params, scale)
    gap = thresholds.min_gap * 0.5
    scene = scene_graph(
        buildings=[
            building("wide", 0.0, 0.0, 60.0, 15.0),
            building("tower", 30.0 + gap + 5.0, 0.0, 10.0, 90.0),
        ]
    )
    repaired = thicken.repair_scene(scene, params)
    blocks = repaired.buildings.blocks
    stacks = repaired.buildings.stacks
    assert len(blocks) == 1
    assert blocks[0].height.height_m == pytest.approx(15.0), "80th percentile by area"
    assert len(stacks) == 1, "a contributor over 1.5x the block height is preserved"
    assert stacks[0].height.height_m == pytest.approx(90.0)
    assert stacks[0].stands_on.height_m == pytest.approx(15.0)


def test_stage1_preserved_tower_bakes_to_its_own_height(tmp_path):
    params = PrintParams()
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    thresholds = T.thresholds_ground_m(params, scale)
    gap = thresholds.min_gap * 0.5
    scene = scene_graph(
        buildings=[
            building("wide", 0.0, 0.0, 60.0, 15.0),
            building("tower", 30.0 + gap + 5.0, 0.0, 10.0, 90.0),
        ]
    )
    output = bake(scene, params, tmp_path, "stack")
    assert_all_validators_pass(output.report)
    expected = T.base_top_mm(params) + 90.0 * scale
    assert output.result.stats.bbox_mm[2] == pytest.approx(expected, abs=1e-6)


def test_stage1_courtyard_survives_when_printable(tmp_path):
    scene = scene_graph(
        buildings=[building("court", 0, 0, 80.0, 25.0, holes=[square_hole(0, 0, 30.0)])]
    )
    params = PrintParams()
    repaired = thicken.repair_scene(scene, params)
    blocks = repaired.buildings.blocks
    assert len(blocks) == 1
    assert len(blocks[0].polygon.interiors) == 1, "a 30 m courtyard is printable"

    output = bake(scene, params, tmp_path, "court")
    assert_all_validators_pass(output.report)


def test_stage1_courtyard_below_min_gap_is_filled():
    params = PrintParams()
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    thresholds = T.thresholds_ground_m(params, scale)
    tiny = thresholds.min_gap * 0.5
    scene = scene_graph(
        buildings=[building("court", 0, 0, 60.0, 25.0, holes=[square_hole(0, 0, tiny)])]
    )
    repaired = thicken.repair_scene(scene, params)
    blocks = repaired.buildings.blocks
    assert len(blocks) == 1
    assert len(blocks[0].polygon.interiors) == 0, "a sub-min-gap courtyard closes up"


def test_stage1_self_intersecting_ring_is_repaired_not_crashed(tmp_path):
    """A bow tie: `make_valid`, never `buffer(0)`, and never an exception."""
    bowtie = [(-30.0, -30.0), (30.0, 30.0), (30.0, -30.0), (-30.0, 30.0)]
    assert not Polygon(bowtie).is_valid
    scene = scene_graph(buildings=[building("bow", 0, 0, 0, 25.0, ring=bowtie)])
    output = bake(scene, PrintParams(), tmp_path, "bowtie")
    assert_all_validators_pass(output.report)
    assert output.result.stats.volume_mm3 > 0.0


def test_stage1_empty_scene_still_produces_a_valid_plate(tmp_path):
    scene = scene_graph(buildings=[], coverage="sparse")
    params = PrintParams()
    output = bake(scene, params, tmp_path, "empty")
    assert_all_validators_pass(output.report)
    # base plate plus the 2 mm frame lip and nothing else
    expected = T.base_top_mm(params) + T.FRAME_LIP_MM
    assert output.result.stats.bbox_mm[2] == pytest.approx(expected, abs=1e-6)
    assert output.result.stats.bbox_mm[0] == pytest.approx(params.plate_mm, abs=1e-6)


def test_stage1_a_speck_of_a_building_is_widened_to_exactly_the_minimum_wall():
    """04 step 3 drops what is still under min_detail^2 *after* dilation.

    ``min_wall`` is two nozzles and ``min_detail`` is one, so a dilated
    footprint is always at least ``min_wall^2 == 4 * min_detail^2``: step 3 can
    only ever fire on a footprint that is degenerate to begin with (see the
    next test).  A speck therefore survives, at exactly the minimum wall.
    """
    params = PrintParams()
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    thresholds = T.thresholds_ground_m(params, scale)
    scene = scene_graph(buildings=[building("speck", 0, 0, thresholds.min_detail * 0.2, 20.0)])
    repaired = thicken.repair_scene(scene, params)
    block = repaired.buildings.blocks[0]
    side = block.polygon.bounds[2] - block.polygon.bounds[0]
    assert side == pytest.approx(thresholds.min_wall, rel=0.02)
    assert repaired.buildings.widened == 1


def test_stage1_a_degenerate_building_ring_produces_no_solid():
    collinear = [(-10.0, 0.0), (0.0, 0.0), (10.0, 0.0)]
    assert Polygon(collinear).area == 0.0
    scene = scene_graph(buildings=[building("flat", 0, 0, 0, 20.0, ring=collinear)])
    repaired = thicken.repair_scene(scene, params_default := PrintParams())
    assert repaired.buildings.solids == []
    assert thicken.polygon_from_rings(collinear, []) == []
    assert params_default.plate_mm == 180


def test_stage1_sub_detail_areas_are_dropped():
    """04: water and green under ``min_detail_ground ** 2`` are dropped."""
    params = PrintParams()
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    thresholds = T.thresholds_ground_m(params, scale)
    tiny = thresholds.min_detail * 0.5
    scene = scene_graph(
        green=[
            AreaFeature(ring=square_ring(-100.0, -100.0, tiny), holes=[]),
            AreaFeature(ring=square_ring(100.0, 100.0, 40.0), holes=[]),
        ]
    )
    repaired = thicken.repair_scene(scene, params)
    assert len(repaired.green.polygons) == 1
    assert repaired.green.dropped_small + repaired.green.dropped_thin >= 1
    assert T.area_dropped(tiny * tiny, thresholds) is True
    assert T.area_dropped(40.0 * 40.0, thresholds) is False


def test_stage1_thin_building_is_widened_to_the_minimum_wall():
    params = PrintParams()
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    thresholds = T.thresholds_ground_m(params, scale)
    thin = thresholds.min_wall * 0.4
    ring = [(-40.0, -thin / 2), (40.0, -thin / 2), (40.0, thin / 2), (-40.0, thin / 2)]
    scene = scene_graph(buildings=[building("sliver", 0, 0, 0, 20.0, ring=ring)])
    repaired = thicken.repair_scene(scene, params)
    assert repaired.buildings.widened == 1
    block = repaired.buildings.blocks[0]
    width = block.polygon.bounds[3] - block.polygon.bounds[1]
    assert width >= thresholds.min_wall * 0.95


def test_stage1_measures_width_per_appendage_not_per_region():
    """A 10 mm square with a 0.5 x 3 mm wing: the region survives the erosion
    probe, the wing does not, and only a per-appendage measure sees it."""
    square = Polygon([(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)])
    wing = Polygon([(10.0, 4.75), (13.0, 4.75), (13.0, 5.25), (10.0, 5.25)])
    shape = shapely.union_all([square, wing])
    min_wall = 0.8

    assert thicken.survives_min_wall(shape, min_wall) is True
    assert thicken.inscribed_width(shape, 0.008) == pytest.approx(10.0, abs=0.05)

    parts = thicken.thin_parts(shape, min_wall, 0.16)
    assert len(parts) == 1
    assert thicken.inscribed_width(parts[0], 0.008) == pytest.approx(0.5, abs=0.05)
    assert thicken.narrowest_width(shape, min_wall, 0.16) == pytest.approx(0.5, abs=0.05)


def test_stage1_a_thin_wing_is_widened_to_a_full_wall_not_dropped():
    square = Polygon([(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)])
    wing = Polygon([(10.0, 4.75), (13.0, 4.75), (13.0, 5.25), (10.0, 5.25)])
    shape = shapely.union_all([square, wing])
    min_wall = 0.8

    fixed = thicken.widen_thin_parts(shape, min_wall, 0.16)
    assert thicken.narrowest_width(fixed, min_wall, 0.16) >= 0.9 * min_wall
    assert fixed.area > shape.area  # widened, not amputated
    assert fixed.bounds[2] >= 13.0  # the wing is still there, and still 3 mm long


def test_stage1_a_thin_wing_can_also_be_stripped_where_widening_is_not_allowed():
    square = Polygon([(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)])
    wing = Polygon([(10.0, 4.75), (13.0, 4.75), (13.0, 5.25), (10.0, 5.25)])
    shape = shapely.union_all([square, wing])

    parts, cut = thicken.strip_thin_parts(shape, 0.8, 0.16)
    assert cut == 1
    assert len(parts) == 1
    assert parts[0].bounds[2] == pytest.approx(10.0, abs=0.4)
    assert thicken.narrowest_width(parts[0], 0.8, 0.16) >= 0.72


def test_stage1_building_wings_do_not_reach_the_baked_model(tmp_path):
    """The end-to-end version of the two tests above: a building with a wing
    thinner than the minimum wall bakes to a model with no sub-wall region."""
    params = PrintParams()
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    thresholds = T.thresholds_ground_m(params, scale)
    body = 60.0
    thin = thresholds.min_wall * 0.5
    ring = [
        (-body / 2, -body / 2),
        (body / 2, -body / 2),
        (body / 2, -thin / 2),
        (body / 2 + 40.0, -thin / 2),
        (body / 2 + 40.0, thin / 2),
        (body / 2, thin / 2),
        (body / 2, body / 2),
        (-body / 2, body / 2),
    ]
    scene = scene_graph(buildings=[building("winged", 0, 0, 0.0, 25.0, ring=ring)])
    output = bake(scene, params, tmp_path, "wing")
    assert_all_validators_pass(output.report)
    assert output.result.stats.min_wall_mm >= 0.9 * 2 * params.nozzle_mm


def test_stage1_footprints_never_reach_the_plate_edge():
    """04 trap list: a footprint coincident with the plate edge would be a
    zero-thickness wall, so the crop square is inset by 0.05 mm first."""
    params = PrintParams()
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    scene = scene_graph(
        buildings=[building("edge", SYNTH_RADIUS_M - 10.0, 0.0, 60.0, 20.0)]
    )
    repaired = thicken.repair_scene(scene, params)
    limit = T.content_extents_mm(params).max_x
    for solid in repaired.buildings.solids:
        assert solid.polygon.bounds[2] * scale <= limit + 1e-9
    assert limit < T.usable_span_mm(params) / 2.0


# ==========================================================================
# Stage 1: a recess must not leave a rind of base at the plate edge
# ==========================================================================


def _slice_appendage_widths(mesh, params: PrintParams, z: float) -> list[float]:
    """Every region width at ``z``, measured the way the Stage 4 gate does."""
    min_wall = T.MIN_WALL_NOZZLES * float(params.nozzle_mm)
    min_detail = min_wall * T.MIN_DETAIL_NOZZLES / T.MIN_WALL_NOZZLES
    floor = thicken.residue_area_floor(min_detail)
    regions = validators.make_slicer(mesh, None)(z)
    return [thicken.narrowest_width(region, min_wall, floor) for region in regions]


@pytest.mark.parametrize("plate_mm", [200.0, 256.0])
def test_frame_off_recesses_open_onto_the_plate_edge_instead_of_leaving_a_rind(
    chicago_scene, tmp_path, plate_mm
):
    """With the frame off the crop is only 0.05 mm inside the plate's own side
    wall, so a recess clipped to the crop leaves a 0.05 mm rind of base standing
    between the water (or an engraved road) and the physical edge - a wall no
    nozzle can lay down, on the real Chicago scene at the two plate sizes 01's
    slider offers."""
    params = PrintParams(plate_mm=plate_mm, frame=False)
    request = presets.PRESETS_BY_ID["chicago-loop"].request()
    output = bake_pipeline.run_pipeline(
        chicago_scene,
        request,
        params,
        job_id=f"rind{int(plate_mm)}",
        out_dir=tmp_path,
        stem=f"rind{int(plate_mm)}",
        debug_root=tmp_path / "debug",
    )
    assert_all_validators_pass(output.report)
    assert output.result.status == "done", output.result.error

    mesh = trimesh.load(tmp_path / f"rind{int(plate_mm)}.3mf", force="mesh", process=False)
    min_wall = T.MIN_WALL_NOZZLES * float(params.nozzle_mm)
    fail_at = validators.MIN_WALL_FAIL_FACTOR * min_wall
    probes = [T.base_top_mm(params) - 0.25] + validators.recess_probe_zs(params, min_wall)
    for z in probes:
        widths = _slice_appendage_widths(mesh, params, z)
        assert widths, f"no slice regions at z={z}"
        assert min(widths) >= fail_at, (
            f"z={z:.3f} mm holds an appendage {min(widths):.4f} mm wide "
            f"(threshold {fail_at:.3f} mm) on a {plate_mm:g} mm plate"
        )


def test_the_recess_slice_catches_the_rind_the_random_slices_missed(
    chicago_scene, tmp_path, monkeypatch
):
    """The other half: the deterministic recess slice is not decorative.

    Put the pre-fix clip back (a recess stopping at the inset crop square) and
    the same Chicago bake ships the rind.  ``slices=0`` removes every random
    slice, so what fails here is the recess probe alone - which is the point:
    12 random Z over a 40 mm model land inside a 0.5 mm water band only by
    luck, and this class of defect lives nowhere else.
    """
    monkeypatch.setattr(
        thicken,
        "recess_clip_square",
        lambda params, scale, grid: thicken.crop_square(params, scale),
    )
    params = PrintParams(plate_mm=200.0, frame=False)
    repaired = thicken.repair_scene(chicago_scene, params)
    assembly = assemble.assemble(repaired, params)
    vertices, faces = assemble.mesh_arrays(assembly.solid)
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False, validate=False)

    min_wall = T.MIN_WALL_NOZZLES * float(params.nozzle_mm)
    recess_zs = validators.recess_probe_zs(params, min_wall)
    assert recess_zs, "the default parameters have a water band and an engraving band"

    report = validators.validate(mesh, params, slices=0, self_intersection_sample=False)
    wall = next(check for check in report.checks if check.name == "min_wall")
    assert not wall.passed, wall.message
    # It is the plate-edge rind, at the 0.05 mm the crop inset leaves behind.
    assert wall.value == pytest.approx(T.CROP_INSET_MM, abs=0.01), wall.message


# ==========================================================================
# Stage 1: roads, water, green, trees
# ==========================================================================


def road(ident: str, points: list[tuple[float, float]], width: float = 12.0) -> Road:
    return Road(id=ident, path=points, width_m=width, **{"class": "residential"})


def _road_scene() -> SceneGraph:
    return scene_graph(
        buildings=[building("b", 0.0, 80.0, 40.0, 20.0)],
        roads=[road("r1", [(-200.0, 0.0), (200.0, 0.0)])],
    )


def test_roads_engrave_emboss_off_order_the_volume(tmp_path):
    volumes = {}
    for mode in ("engrave", "off", "emboss"):
        output = bake(_road_scene(), PrintParams(road_mode=mode), tmp_path, f"road-{mode}")
        assert_all_validators_pass(output.report)
        volumes[mode] = output.result.stats.volume_mm3
    assert volumes["emboss"] > volumes["off"] > volumes["engrave"]


def test_roads_never_tunnel_through_buildings():
    params = PrintParams()
    scene = scene_graph(
        buildings=[building("b", 0.0, 0.0, 60.0, 20.0)],
        roads=[road("r1", [(-200.0, 0.0), (200.0, 0.0)], width=30.0)],
    )
    repaired = thicken.repair_scene(scene, params)
    assert repaired.roads.polygons
    assert repaired.buildings.union is not None
    overlap = shapely.union_all(repaired.roads.polygons).intersection(
        repaired.buildings.union
    )
    assert overlap.area == pytest.approx(0.0, abs=1e-9)


def test_roads_are_at_least_one_minimum_wall_wide():
    params = PrintParams()
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    thresholds = T.thresholds_ground_m(params, scale)
    scene = scene_graph(roads=[road("r1", [(-200.0, 0.0), (200.0, 0.0)], width=0.5)])
    repaired = thicken.repair_scene(scene, params)
    merged = shapely.union_all(repaired.roads.polygons)
    width = merged.bounds[3] - merged.bounds[1]
    assert width >= thresholds.min_wall * 0.99


def test_engrave_depth_never_cuts_through_the_base(tmp_path):
    """A recess must stay above z = 0 for every legal base thickness."""
    for thickness in (2.0, 3.0, 8.0):
        params = PrintParams(base_thickness_mm=thickness)
        depth = -T.road_z_mm(params)
        assert 0.0 < depth < thickness
        output = bake(_road_scene(), params, tmp_path, f"depth-{thickness}")
        assert_all_validators_pass(output.report)
        assert output.result.stats.bbox_mm[2] == pytest.approx(
            T.base_top_mm(params) + 20.0 * T.scale_mm_per_m(params, SYNTH_RADIUS_M),
            abs=1e-6,
        )


def test_water_recess_removes_volume_and_green_adds_it(tmp_path):
    ring = square_ring(-100.0, -100.0, 80.0)
    with_water = scene_graph(water=[AreaFeature(ring=ring, holes=[])])
    with_green = scene_graph(green=[AreaFeature(ring=ring, holes=[])])
    plain = scene_graph()

    base = bake(plain, PrintParams(), tmp_path, "plain")
    water_on = bake(with_water, PrintParams(water=True), tmp_path, "water-on")
    water_off = bake(with_water, PrintParams(water=False), tmp_path, "water-off")
    green_on = bake(with_green, PrintParams(), tmp_path, "green-on")
    for output in (base, water_on, water_off, green_on):
        assert_all_validators_pass(output.report)

    assert water_on.result.stats.volume_mm3 < base.result.stats.volume_mm3
    assert water_off.result.stats.volume_mm3 == pytest.approx(
        base.result.stats.volume_mm3, rel=1e-9
    )
    assert green_on.result.stats.volume_mm3 > base.result.stats.volume_mm3


def test_water_and_green_use_the_transform_offsets():
    params = PrintParams()
    assert T.water_z_mm(params) == pytest.approx(-0.5)
    assert T.green_z_mm(params) == pytest.approx(0.3)
    assert T.water_z_mm(PrintParams(water=False)) is None


def test_trees_are_filtered_by_size_and_by_what_they_stand_on():
    params = PrintParams()
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    min_radius = T.TREE_MIN_RADIUS_MM / scale
    scene = scene_graph(
        buildings=[building("b", 0.0, 0.0, 60.0, 20.0)],
        roads=[road("r1", [(-200.0, 120.0), (200.0, 120.0)], width=20.0)],
        trees=[
            Tree(x=0.0, y=0.0, radius_m=min_radius * 2.0),  # inside the building
            Tree(x=0.0, y=120.0, radius_m=min_radius * 2.0),  # on the road
            Tree(x=-150.0, y=-150.0, radius_m=min_radius * 0.5),  # too small
            Tree(x=150.0, y=-150.0, radius_m=min_radius * 2.0),  # keeper
        ],
    )
    repaired = thicken.repair_scene(scene, params)
    assert len(repaired.trees) == 1
    assert repaired.trees[0].x_m == pytest.approx(150.0)
    assert repaired.trees_dropped == 3


def test_tree_radius_floor_is_nozzle_aware_and_leaves_the_default_alone():
    """04 asks for a 0.5 mm printed site radius and says nothing about the
    nozzle, but an 8-gon of circumradius r is only 2 r cos(pi/8) across its
    flats, so at 0.5 mm the base of the cone is 0.92 mm - under one bead for
    every nozzle from 0.5 mm up."""
    assert thicken.tree_min_radius_mm(PrintParams()) == pytest.approx(
        T.TREE_MIN_RADIUS_MM
    ), "the default 0.4 mm nozzle must keep 04's 0.5 mm floor exactly"
    for nozzle in (0.5, 0.6, 0.8, 1.2):
        floor = thicken.tree_min_radius_mm(PrintParams(nozzle_mm=nozzle))
        assert floor > T.TREE_MIN_RADIUS_MM
        across_flats = 2.0 * floor * np.cos(np.pi / thicken.TREE_SIDES)
        assert across_flats == pytest.approx(T.MIN_WALL_NOZZLES * nozzle)


def test_trees_below_the_nozzle_aware_floor_are_dropped_with_a_warning():
    params = PrintParams(nozzle_mm=0.8)
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    keeper = thicken.tree_min_radius_mm(params) / scale
    scene = scene_graph(
        trees=[
            Tree(x=-150.0, y=-150.0, radius_m=T.TREE_MIN_RADIUS_MM / scale),  # 04 only
            Tree(x=150.0, y=150.0, radius_m=keeper * 1.2),
        ]
    )
    repaired = thicken.repair_scene(scene, params)
    assert [round(t.x_m, 1) for t in repaired.trees] == [150.0]
    assert repaired.trees_dropped == 1
    assert any("tree site radius floor" in w for w in repaired.warnings)


@pytest.mark.parametrize("nozzle", [0.4, 0.6, 1.2])
def test_trees_bake_and_pass_every_validator_at_any_nozzle(tmp_path, nozzle):
    """04's cone tapers to a point by construction; the gate must read that as
    a taper at every nozzle, not as a thin wall from 0.5 mm up."""
    params = PrintParams(nozzle_mm=nozzle)
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    radius_m = 2.0 * thicken.tree_min_radius_mm(params) / scale
    scene = scene_graph(
        buildings=[building("b", -150.0, -150.0, 60.0, 25.0)],
        trees=[
            Tree(x=x, y=y, radius_m=radius_m)
            for x in (-60.0, 0.0, 60.0, 120.0)
            for y in (0.0, 80.0)
        ],
    )
    repaired = thicken.repair_scene(scene, params)
    assert len(repaired.trees) == 8, "the test would be vacuous with no trees"
    output = bake(scene, params, tmp_path, f"tree{nozzle}")
    assert_all_validators_pass(output.report)
    assert output.result.status == "done"


def test_trees_are_capped_at_two_thousand_keeping_the_largest():
    params = PrintParams()
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    min_radius = T.TREE_MIN_RADIUS_MM / scale
    trees = [
        Tree(x=-200.0 + (i % 60) * 6.0, y=-200.0 + (i // 60) * 8.0,
             radius_m=min_radius * (1.0 + i / 2600.0))
        for i in range(2600)
    ]
    scene = scene_graph(trees=trees)
    repaired = thicken.repair_scene(scene, params)
    assert len(repaired.trees) == T.TREE_CAP
    kept = sorted(t.radius_m for t in repaired.trees)
    dropped_max = min_radius * (1.0 + 599 / 2600.0)
    assert kept[0] >= dropped_max


def test_trees_bake_into_valid_eight_sided_cones(tmp_path):
    params = PrintParams()
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    radius_m = 2.0 * T.TREE_MIN_RADIUS_MM / scale
    scene = scene_graph(
        trees=[Tree(x=x, y=0.0, radius_m=radius_m) for x in (-120.0, 0.0, 120.0)]
    )
    output = bake(scene, params, tmp_path, "trees")
    assert_all_validators_pass(output.report)
    expected = T.base_top_mm(params) + T.TREE_HEIGHT_FACTOR * radius_m * scale
    assert output.result.stats.bbox_mm[2] == pytest.approx(
        max(expected, T.base_top_mm(params) + T.FRAME_LIP_MM), abs=1e-6
    )
    assert bake(scene, PrintParams(trees=False), tmp_path, "no-trees").result.stats.bbox_mm[
        2
    ] == pytest.approx(T.base_top_mm(params) + T.FRAME_LIP_MM, abs=1e-6)


# ==========================================================================
# Stage 2: assembly
# ==========================================================================


def test_frame_toggle_changes_the_usable_area_and_the_height(tmp_path):
    scene = scene_graph(buildings=[building("b", 0, 0, 40.0, 5.0)])
    framed = bake(scene, PrintParams(frame=True), tmp_path, "framed")
    bare = bake(scene, PrintParams(frame=False), tmp_path, "bare")
    for output in (framed, bare):
        assert_all_validators_pass(output.report)

    assert T.usable_span_mm(PrintParams(frame=True)) == pytest.approx(
        PrintParams().plate_mm - 2 * T.FRAME_WIDTH_MM
    )
    assert T.usable_span_mm(PrintParams(frame=False)) == pytest.approx(PrintParams().plate_mm)
    # the lip is the tallest thing on the framed plate, and it is gone without it
    assert framed.result.stats.bbox_mm[2] == pytest.approx(
        T.base_top_mm(PrintParams()) + T.FRAME_LIP_MM, abs=1e-6
    )
    assert bare.result.stats.bbox_mm[2] < framed.result.stats.bbox_mm[2]
    # both still occupy the whole plate footprint: the frame is part of the plate
    assert framed.result.stats.bbox_mm[0] == pytest.approx(180.0, abs=1e-6)
    assert bare.result.stats.bbox_mm[0] == pytest.approx(180.0, abs=1e-6)


def test_base_plate_is_chamfered_on_the_bottom_outer_edge():
    params = PrintParams()
    plate = extrude.base_plate(params)
    mesh = bake_pipeline.manifold_to_trimesh(plate)
    bottom = mesh.vertices[np.isclose(mesh.vertices[:, 2], 0.0)]
    top = mesh.vertices[np.isclose(mesh.vertices[:, 2], T.base_top_mm(params))]
    assert np.max(np.abs(bottom[:, :2])) == pytest.approx(
        params.plate_mm / 2.0 - T.CHAMFER_MM, abs=1e-6
    )
    assert np.max(np.abs(top[:, :2])) == pytest.approx(params.plate_mm / 2.0, abs=1e-6)
    # 45 degrees: the inset equals the rise
    assert T.CHAMFER_MM == pytest.approx(0.6)


def test_buildings_overlap_the_base_so_the_union_is_unambiguous():
    params = PrintParams()
    assert T.building_bottom_mm(params) == pytest.approx(
        T.base_top_mm(params) - T.BUILDING_OVERLAP_MM
    )
    assert T.building_bottom_mm(params) < T.base_top_mm(params)


def test_batched_union_is_tree_shaped_and_deduplicates():
    cubes = [
        extrude.Manifold.cube((1.0, 1.0, 1.0)).translate((3.0 * i, 0.0, 0.0))
        for i in range(7)
    ]
    merged = assemble.batched_union(cubes, batch=2)
    assert merged.volume() == pytest.approx(7.0)
    # the same object twice must not be unioned with itself
    once = assemble.batched_union([cubes[0], cubes[0]])
    assert once.volume() == pytest.approx(1.0)
    assert assemble.batched_union([]) is None
    assert assemble.batched_union([None, None]) is None


def test_assembly_result_is_a_single_body_sitting_at_zero(tmp_path):
    scene = scene_graph(
        buildings=[building("b", 0, 0, 40.0, 20.0)],
        roads=[road("r", [(-200.0, 40.0), (200.0, 40.0)])],
        water=[AreaFeature(ring=square_ring(-120, -120, 60.0), holes=[])],
        green=[AreaFeature(ring=square_ring(120, 120, 60.0), holes=[])],
    )
    repaired = thicken.repair_scene(scene, PrintParams())
    assembly = assemble.assemble(repaired, PrintParams())
    assert len(assembly.solid.decompose()) == 1
    bounds = assembly.solid.bounding_box()
    assert bounds[2] == pytest.approx(0.0, abs=1e-9)
    assert (bounds[0] + bounds[3]) / 2.0 == pytest.approx(0.0, abs=1e-9)
    assert (bounds[1] + bounds[4]) / 2.0 == pytest.approx(0.0, abs=1e-9)


def test_polygon_winding_is_fixed_before_extrusion():
    """04 trap list: a CW exterior would extrude inside out."""
    cw = list(reversed(square_ring(0, 0, 10.0)))
    solid = extrude.extrude_polygons([Polygon(cw)], 0.0, 5.0)
    assert solid.volume() == pytest.approx(500.0)
    assert solid.volume() > 0.0


def test_holes_extrude_as_holes_not_as_inside_out_solids():
    poly = Polygon(square_ring(0, 0, 10.0), [square_hole(0, 0, 4.0)])
    solid = extrude.extrude_polygons([poly], 0.0, 2.0)
    assert solid.volume() == pytest.approx((100.0 - 16.0) * 2.0)
    assert solid.genus() == 1


def test_a_hole_touching_its_own_exterior_still_extrudes(tmp_path):
    """04 trap list: shrink the hole by 1e-6 or the edge is non-manifold."""
    ring = square_ring(0, 0, 60.0)
    hole = [(-30.0, -10.0), (-30.0, 10.0), (0.0, 10.0), (0.0, -10.0)]
    parts = thicken.polygon_from_rings(ring, [hole])
    assert parts and all(p.is_valid for p in parts)
    scene = scene_graph(buildings=[building("notch", 0, 0, 0, 25.0, ring=ring, holes=[hole])])
    output = bake(scene, PrintParams(), tmp_path, "notch")
    assert_all_validators_pass(output.report)


# ==========================================================================
# Stage 3: export
# ==========================================================================


def test_export_3mf_package_structure(chicago_bake):
    _output, _elapsed, out_dir, _scene = chicago_bake
    path = out_dir / "chicago.3mf"
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        assert names == [mf3.CONTENT_TYPES_PART, mf3.RELS_PART, mf3.MODEL_PART]
        for info in zf.infolist():
            assert info.compress_type == zipfile.ZIP_DEFLATED
        model = zf.read(mf3.MODEL_PART).decode("utf-8")
        rels = zf.read(mf3.RELS_PART).decode("utf-8")
    assert f'xmlns="{mf3.CORE_NAMESPACE}"' in model
    assert 'unit="millimeter"' in model
    assert '<object id="1" type="model">' in model
    assert "<vertices>" in model and "<triangles>" in model
    assert '<item objectid="1"/>' in model
    assert mf3.REL_TYPE in rels


def test_export_3mf_metadata_carries_osm_attribution_and_the_parameters(chicago_bake):
    _output, _elapsed, out_dir, _scene = chicago_bake
    meta = mf3.read_metadata(out_dir / "chicago.3mf")
    assert "© OpenStreetMap contributors" in meta["Description"]
    assert "lat=41.8827" in meta["Description"]
    assert "radius_m=900" in meta["Description"]
    assert "preset_id=chicago-loop" in meta["Description"]
    assert "plate_mm=180" in meta["Description"]
    assert "road_mode=engrave" in meta["Description"]
    assert meta["Title"]
    assert meta["Designer"]
    assert meta["CreationDate"]


def test_export_3mf_refuses_a_non_reserved_metadata_name(tmp_path):
    with pytest.raises(ValueError):
        mf3.write_3mf(
            tmp_path / "x.3mf",
            np.zeros((3, 3)),
            np.array([[0, 1, 2]]),
            {"NotReserved": "x"},
        )


def test_export_credits_file_carries_the_odbl_notice(chicago_bake):
    _output, _elapsed, out_dir, _scene = chicago_bake
    text = (out_dir / "CREDITS.txt").read_text(encoding="utf-8")
    assert text.startswith("© OpenStreetMap contributors, ODbL; produced work by FrameCraft")
    assert "ODbL" in text


def test_export_sidecar_round_trips_through_the_contract_models(chicago_bake):
    _output, _elapsed, out_dir, _scene = chicago_bake
    payload = json.loads((out_dir / "chicago.json").read_text(encoding="utf-8"))
    assert payload["attribution"] == "© OpenStreetMap contributors"

    result = BakeResult(**payload["bake_result"])
    request = SceneRequest(**payload["scene_request"])
    params = PrintParams(**payload["print_params"])
    assert result.status == "done"
    assert result.files is not None and result.files.file_3mf.endswith(".3mf")
    assert request.preset_id == "chicago-loop"
    assert params.plate_mm == 180
    assert payload["validation"]["passed"] is True
    assert {c["name"] for c in payload["validation"]["checks"]} == {
        "manifold",
        "watertight",
        "volume",
        "self_intersection",
        "bounding_box",
        "sits_at_zero",
        "min_wall",
        "triangle_budget",
        "degenerate_faces",
    }
    # the serialised BakeResult uses the contract key "3mf", not "file_3mf"
    assert "3mf" in payload["bake_result"]["files"]


def test_export_stl_is_binary_and_loads_back(chicago_bake):
    _output, _elapsed, out_dir, _scene = chicago_bake
    path = out_dir / "chicago.stl"
    head = path.read_bytes()[:5]
    assert head != b"solid", "binary STL, not ASCII"
    mesh = trimesh.load(path, force="mesh", process=False)
    assert len(mesh.faces) > 0


def test_the_final_solid_survives_the_float32_round_trip_of_a_binary_stl(chicago_bake):
    output, _elapsed, out_dir, _scene = chicago_bake
    mesh = trimesh.load(out_dir / "chicago.3mf", force="mesh", process=False)
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces)
    assert assemble.degenerate_face_count(vertices, faces) == 0
    assert assemble.float32_defect_count(vertices, faces) == 0
    assert len(faces) == output.result.stats.triangles


def test_cli_validate_accepts_the_stl_the_bake_itself_wrote(chicago_bake, capsys):
    """`make validate` on a shipped .stl used to fail every topology check: a
    binary STL is an unindexed triangle soup, so every edge belongs to exactly
    one face until the exactly-coincident vertices are welded."""
    _output, _elapsed, out_dir, _scene = chicago_bake
    path = out_dir / "chicago.stl"

    raw = trimesh.load(path, force="mesh", process=False)
    assert len(raw.vertices) == 3 * len(raw.faces), "a binary STL has no vertex index"
    assert not raw.is_watertight

    welded, removed = cli._index_stl_triangle_soup(raw)
    assert removed > 0
    assert len(welded.faces) == len(raw.faces), "welding must not touch a triangle"
    assert welded.volume == pytest.approx(raw.volume, rel=1e-9)

    assert cli.main(["validate", str(path)]) == 0
    table = capsys.readouterr().out
    assert "ALL CHECKS PASS" in table
    assert "duplicate vertices" in table

    # the 3MF of the same model still passes with no welding at all
    assert cli.main(["validate", str(out_dir / "chicago.3mf")]) == 0
    assert "ALL CHECKS PASS" in capsys.readouterr().out


# ==========================================================================
# Stage 4: the validators
# ==========================================================================


def test_validator_table_names_every_check_and_its_verdict(chicago_bake):
    output, _elapsed, _out_dir, _scene = chicago_bake
    table = output.report.to_table()
    for check in output.report.checks:
        assert check.name in table
    assert "ALL CHECKS PASS" in table


def test_validator_rejects_a_mesh_with_a_hole_in_it():
    box = trimesh.creation.box(extents=(10.0, 10.0, 10.0))
    box.apply_translation([0.0, 0.0, 5.0])
    broken = trimesh.Trimesh(
        vertices=box.vertices.copy(), faces=box.faces[:-2].copy(), process=False
    )
    report = validators.validate(broken, PrintParams(), self_intersection_sample=False)
    assert not report.passed
    assert "watertight" in report.failed
    assert "manifold" in report.failed
    assert report.error_text() is not None


def test_validator_rejects_inverted_normals():
    box = trimesh.creation.box(extents=(10.0, 10.0, 10.0))
    box.apply_translation([0.0, 0.0, 5.0])
    flipped = trimesh.Trimesh(
        vertices=box.vertices.copy(), faces=box.faces[:, ::-1].copy(), process=False
    )
    report = validators.validate(flipped, PrintParams(), self_intersection_sample=False)
    assert not report.passed
    assert "volume" in report.failed


def test_validator_rejects_a_model_that_does_not_sit_at_zero():
    box = trimesh.creation.box(extents=(10.0, 10.0, 10.0))
    box.apply_translation([0.0, 0.0, 7.0])
    report = validators.validate(box, PrintParams(), self_intersection_sample=False)
    assert "sits_at_zero" in report.failed


def test_validator_rejects_a_model_wider_than_the_plate():
    box = trimesh.creation.box(extents=(300.0, 10.0, 10.0))
    box.apply_translation([0.0, 0.0, 5.0])
    report = validators.validate(box, PrintParams(), self_intersection_sample=False)
    assert "bounding_box" in report.failed


def test_validator_rejects_a_model_taller_than_sixty_millimetres():
    box = trimesh.creation.box(extents=(10.0, 10.0, 70.0))
    box.apply_translation([0.0, 0.0, 35.0])
    report = validators.validate(box, PrintParams(), self_intersection_sample=False)
    assert "bounding_box" in report.failed
    assert "60 mm" in report.get("bounding_box").message


def test_validator_min_wall_probe_catches_a_thin_wall():
    """A 0.3 mm wall is under 0.9 x min_wall (0.72 mm) and must fail."""
    wall = trimesh.creation.box(extents=(0.3, 40.0, 20.0))
    wall.apply_translation([0.0, 0.0, 10.0])
    report = validators.validate(wall, PrintParams(), self_intersection_sample=False)
    assert "min_wall" in report.failed


def test_validator_min_wall_probe_accepts_a_thick_wall():
    wall = trimesh.creation.box(extents=(3.0, 40.0, 20.0))
    wall.apply_translation([0.0, 0.0, 10.0])
    report = validators.validate(wall, PrintParams(), self_intersection_sample=False)
    assert report.get("min_wall").passed
    assert report.get("min_wall").value > 0.72


def test_validator_min_wall_probe_is_deterministic():
    wall = trimesh.creation.box(extents=(3.0, 40.0, 20.0))
    wall.apply_translation([0.0, 0.0, 10.0])
    first = validators.validate(wall, PrintParams(), self_intersection_sample=False)
    second = validators.validate(wall, PrintParams(), self_intersection_sample=False)
    assert first.get("min_wall").value == second.get("min_wall").value


def test_validator_min_wall_probe_ignores_a_tapering_cone_tip():
    """04 models trees as cones; an apex is a point, not a wall."""
    cone = extrude.Manifold.cylinder(6.0, 2.0, 0.0, extrude.TREE_SIDES, False)
    mesh = bake_pipeline.manifold_to_trimesh(cone)
    report = validators.validate(mesh, PrintParams(), manifold=cone)
    assert report.get("min_wall").passed


def test_validator_min_wall_measures_a_wing_not_the_body(tmp_path):
    """A 12 mm slab with a 0.5 mm x 3 mm wing: the erosion probe passes it
    (the slab survives) and the gate must still fail it."""
    body = extrude.Manifold.cube((12.0, 12.0, 8.0), True)
    wing = extrude.Manifold.cube((3.0, 0.5, 8.0), True).translate((7.0, 0.0, 0.0))
    solid = (body + wing).translate((0.0, 0.0, 4.0))
    mesh = bake_pipeline.manifold_to_trimesh(solid)

    slice_region = validators._cross_section_polygons(solid.slice(4.0))[0]
    assert thicken.survives_min_wall(slice_region, 0.8), "the body passes the probe"

    report = validators.validate(
        mesh, PrintParams(), manifold=solid, self_intersection_sample=False
    )
    check = report.get("min_wall")
    assert "min_wall" in report.failed
    assert check.value == pytest.approx(0.5, abs=0.05)


def test_validator_min_wall_verdict_and_report_never_contradict():
    """The old probe reported the hydraulic width 4A/P and failed on a separate
    erosion test, so it could print "0 of 4 regions are under 1.080 mm
    (narrowest 1.014 mm)" - a failure with nothing failing."""
    for extents in ((0.3, 40.0, 20.0), (3.0, 40.0, 20.0), (0.9, 40.0, 20.0)):
        wall = trimesh.creation.box(extents=extents)
        wall.apply_translation([0.0, 0.0, extents[2] / 2.0])
        report = validators.validate(wall, PrintParams(), self_intersection_sample=False)
        check = report.get("min_wall")
        assert check.passed == (check.value >= check.threshold)
        assert check.value == pytest.approx(extents[0], abs=0.05)


def test_validator_width_is_the_inscribed_circle_not_the_hydraulic_diameter():
    """A jagged island can have a hydraulic width 4A/P far under the threshold
    while being over 0.8 mm wide everywhere it matters; the old probe failed it
    with a message saying zero regions had failed."""
    n, base_r, amp, waves = 120, 0.55, 0.12, 17
    ring = []
    for i in range(n):
        theta = 2.0 * np.pi * i / n
        r = base_r + amp * (1 if i % 2 == 0 else -1) * abs(np.sin(waves * theta))
        ring.append((r * np.cos(theta), r * np.sin(theta)))
    island = Polygon(ring)
    assert island.is_valid

    hydraulic = 4.0 * island.area / island.length
    assert hydraulic < 0.72, "the fixture must reproduce the false failure"
    floor = thicken.residue_area_floor(0.4)
    assert thicken.inscribed_width(island, 0.008) > 0.8
    assert thicken.narrowest_width(island, 0.8, floor) > 0.8
    assert thicken.survives_min_wall(island, 0.8)


def test_validator_width_ignores_triangulation_t_junctions():
    """``Manifold.slice`` puts near-collinear vertices on an outline where a
    triangulation has a T-junction.  GEOS' negative buffer of the SAME triangle
    can then come back empty while the inscribed circle is unmoved."""
    triangle = [(-82.94, -20.90), (-83.95, -21.66), (-83.95, -19.57)]
    dense = []
    offsets = (3e-4, -5e-4, 7e-4)
    for i in range(3):
        a = np.asarray(triangle[i])
        b = np.asarray(triangle[(i + 1) % 3])
        edge = b - a
        normal = np.array([-edge[1], edge[0]]) / np.linalg.norm(edge)
        dense.append(tuple(a))
        dense.append(tuple((a + b) / 2.0 + normal * offsets[i]))
    plain = Polygon(triangle)
    with_t_junctions = Polygon(dense)
    assert len(with_t_junctions.exterior.coords) == 7

    tolerance = 0.008
    assert thicken.inscribed_width(with_t_junctions, tolerance) == pytest.approx(
        thicken.inscribed_width(plain, tolerance), abs=0.01
    )
    floor = thicken.residue_area_floor(0.4)
    assert thicken.narrowest_width(with_t_junctions, 0.8, floor) >= 0.72
    assert thicken.survives_min_wall(with_t_junctions, 0.8)


def test_validator_counts_degenerate_faces():
    box = trimesh.creation.box(extents=(10.0, 10.0, 10.0))
    box.apply_translation([0.0, 0.0, 5.0])
    verts = np.vstack([box.vertices, box.vertices[0] + [1e-9, 0.0, 0.0]])
    faces = np.vstack([box.faces, [[0, len(box.vertices), 0]]])
    mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
    report = validators.validate(mesh, PrintParams(), self_intersection_sample=False)
    assert "degenerate_faces" in report.failed


def test_validator_triangle_budget_and_the_decimation_path():
    sphere = trimesh.creation.icosphere(subdivisions=3)
    report = validators.validate(sphere, PrintParams(), self_intersection_sample=False)
    assert report.get("triangle_budget").passed
    reduced, note = validators.enforce_triangle_budget(sphere, budget=100, target=80)
    assert note is not None and "decimated" in note
    assert len(reduced.faces) < len(sphere.faces)


def test_validator_section_polygons_agree_with_the_manifold_slice():
    solid = extrude.Manifold.cube((10.0, 10.0, 10.0)) - extrude.Manifold.cube(
        (4.0, 4.0, 20.0)
    ).translate((3.0, 3.0, -5.0))
    mesh = bake_pipeline.manifold_to_trimesh(solid)
    by_trimesh = validators.section_polygons(mesh, 5.0)
    by_manifold = validators._cross_section_polygons(solid.slice(5.0))
    assert len(by_trimesh) == len(by_manifold) == 1
    assert by_trimesh[0].area == pytest.approx(by_manifold[0].area, rel=1e-9)
    assert by_trimesh[0].area == pytest.approx(100.0 - 16.0)


def test_est_grams_follows_the_04_formula():
    assert bake_pipeline.est_grams(1000.0) == pytest.approx(1000.0 / 1000 * 1.24 * 0.35)


# ==========================================================================
# Failure handling
# ==========================================================================


def test_a_failing_bake_is_quarantined_with_its_intermediate_solids(tmp_path):
    """04: do not silently ship.  Name the check, dump the solids.

    ``height_guard=False`` turns off the pre-Stage-1 shortcut only, so this
    still exercises the real path: build the whole model, let the Stage 4
    ``bounding_box`` validator refuse it, quarantine every artifact.  The
    validator is the gate; the guard is only a way of reaching the same verdict
    in under a millisecond (see the test below).
    """
    scene = scene_graph(buildings=[building("tower", 0, 0, 40.0, 400.0)])
    params = PrintParams(large_scale=2.0)
    output = bake(scene, params, tmp_path, "toohigh", height_guard=False)
    assert output.result.status == "failed"
    assert output.result.files is None
    assert "bounding_box" in output.result.error
    assert output.debug_dir is not None and output.debug_dir.is_dir()
    dumped = {p.name for p in output.debug_dir.iterdir()}
    assert "base.stl" in dumped
    assert "buildings.stl" in dumped
    assert "final.stl" in dumped
    assert "toohigh.3mf" in dumped, "the model itself is quarantined, not shipped"
    assert "toohigh.json" in dumped, "the sidecar records why it failed"
    assert not (tmp_path / "toohigh.3mf").exists()
    assert output.debug_dir.is_relative_to(tmp_path)


def test_a_model_over_sixty_millimetres_is_refused_before_stage_1(tmp_path):
    """01 allows a 250 m radius, and a dense downtown at that radius blows 04's
    60 mm ceiling at the DEFAULT parameters.  Discovering that after the whole
    pipeline is a several-second dead end; the preview's own height math answers
    it before any geometry is built."""
    scene = scene_graph(buildings=[building("tower", 0, 0, 40.0, 400.0)])
    params = PrintParams(large_scale=2.0)
    started = time.perf_counter()
    with pytest.raises(bake_pipeline.ModelTooTallError) as excinfo:
        bake(scene, params, tmp_path, "toohigh")
    elapsed = time.perf_counter() - started
    message = str(excinfo.value)
    assert "60 mm" in message
    assert "271.8 mm" in message, "the message names the height it computed"
    assert "large 2x" in message and "small 1x" in message
    assert elapsed < 1.0, f"the guard took {elapsed:.3f} s; it must not build anything"
    assert list(tmp_path.iterdir()) == [], "a refused bake writes nothing at all"
    assert isinstance(excinfo.value, bake_pipeline.BakeError)


def test_the_height_guard_never_refuses_a_model_that_would_have_fitted(tmp_path):
    """The prediction is an upper bound and it is TIGHT for an isolated
    building: what the guard reports is what the bake produces."""
    params = PrintParams()
    scene = scene_graph(buildings=[building("b", 0, 0, 40.0, 120.0)])
    predicted = bake_pipeline.predicted_top_mm(scene, params)
    assert predicted < validators.MAX_HEIGHT_MM
    output = bake(scene, params, tmp_path, "fits")
    assert output.result.stats.bbox_mm[2] == pytest.approx(predicted, abs=1e-6)
    assert_all_validators_pass(output.report)


def test_the_height_guard_counts_the_frame_and_the_trees_too(tmp_path):
    params = PrintParams()
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    empty = scene_graph(buildings=[])
    assert bake_pipeline.predicted_top_mm(empty, params) == pytest.approx(
        T.base_top_mm(params) + T.FRAME_LIP_MM
    )
    assert bake_pipeline.predicted_top_mm(empty, PrintParams(frame=False)) == pytest.approx(
        T.base_top_mm(params)
    )
    tall_tree = Tree(x=0.0, y=0.0, radius_m=4.0 * T.TREE_MIN_RADIUS_MM / scale)
    treed = scene_graph(buildings=[], trees=[tall_tree])
    assert bake_pipeline.predicted_top_mm(treed, params) == pytest.approx(
        T.base_top_mm(params) + T.tree_height_mm(tall_tree, scale)
    )
    assert bake_pipeline.predicted_top_mm(treed, PrintParams(trees=False)) == pytest.approx(
        T.base_top_mm(params) + T.FRAME_LIP_MM
    )


def test_an_empty_scene_is_refused_with_a_useful_message(tmp_path):
    scene = scene_graph(buildings=[], coverage="empty")
    with pytest.raises(bake_pipeline.EmptySceneError) as excinfo:
        bake(scene, PrintParams(), tmp_path, "nothing")
    assert "larger radius" in str(excinfo.value)


def test_progress_reaches_every_stage(tmp_path):
    seen: list[tuple[str, float]] = []
    bake_pipeline.run_pipeline(
        scene_graph(buildings=[building("b", 0, 0, 40.0, 20.0)]),
        synth_request(),
        PrintParams(),
        job_id="prog",
        out_dir=tmp_path,
        stem="prog",
        progress=lambda stage, value: seen.append((stage, value)),
    )
    assert [s for s, _ in seen] == ["scene", "repair", "extrude", "union", "export", "validate"]
    assert [v for _, v in seen] == sorted(v for _, v in seen)
    assert seen[-1][1] == 1.0


# ==========================================================================
# API
# ==========================================================================


@pytest.fixture()
def client():
    with TestClient(main_module.app) as test_client:
        yield test_client


def poll(test_client: TestClient, job_id: str, timeout_s: float = 120.0) -> BakeResult:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        response = test_client.get(f"/bake/{job_id}")
        assert response.status_code == 200
        result = BakeResult(**response.json())
        if result.status in ("done", "failed"):
            return result
        time.sleep(0.1)
    raise AssertionError(f"job {job_id} did not finish in {timeout_s} s")


def test_api_bake_chicago_end_to_end(client):
    started = time.perf_counter()
    response = client.post(
        "/bake",
        json={
            "scene_request": presets.PRESETS_BY_ID["chicago-loop"]
            .request()
            .model_dump(mode="json"),
            "print_params": PrintParams().model_dump(mode="json"),
        },
    )
    handled = time.perf_counter() - started
    assert response.status_code == 202
    assert handled < 2.0, "POST /bake must answer immediately"
    job_id = response.json()["job_id"]
    assert 8 <= len(job_id) <= 12
    assert all(c in "0123456789abcdef" for c in job_id)

    result = poll(client, job_id)
    assert result.status == "done", result.error
    assert result.progress == 1.0
    assert result.stats is not None and result.stats.is_manifold
    assert result.files is not None

    artifacts = bake_pipeline.ARTIFACTS_DIR
    produced = [artifacts / f"{job_id}.3mf", artifacts / f"{job_id}.stl", artifacts / f"{job_id}.json"]
    try:
        for path in produced:
            assert path.is_file(), path
        for url in (result.files.file_3mf, result.files.stl):
            served = client.get(url)
            assert served.status_code == 200
            assert len(served.content) > 1000
        assert client.get(f"/files/{job_id}.json").status_code == 200
    finally:
        for path in produced:
            path.unlink(missing_ok=True)


def test_api_unknown_job_is_404(client):
    assert client.get("/bake/deadbeef").status_code == 404


def test_api_empty_scene_fails_with_a_clear_error(client, monkeypatch):
    empty = scene_graph(buildings=[], coverage="empty")
    monkeypatch.setattr(main_module, "build_scene", lambda request: empty)
    response = client.post(
        "/bake",
        json={"scene_request": synth_request().model_dump(mode="json")},
    )
    assert response.status_code == 202
    result = poll(client, response.json()["job_id"], timeout_s=30.0)
    assert result.status == "failed"
    assert result.files is None
    assert "radius" in result.error


def test_api_bake_rejects_an_out_of_range_parameter(client):
    response = client.post(
        "/bake",
        json={
            "scene_request": synth_request().model_dump(mode="json"),
            "print_params": {**PrintParams().model_dump(mode="json"), "plate_mm": 9000},
        },
    )
    assert response.status_code == 422


def test_api_scene_failure_becomes_a_failed_job_not_a_500(client, monkeypatch):
    def boom(request):
        raise RuntimeError("overpass exploded")

    monkeypatch.setattr(main_module, "build_scene", boom)
    response = client.post(
        "/bake", json={"scene_request": synth_request().model_dump(mode="json")}
    )
    assert response.status_code == 202
    result = poll(client, response.json()["job_id"], timeout_s=30.0)
    assert result.status == "failed"
    assert "overpass exploded" in result.error


def test_api_files_route_is_path_traversal_safe(client):
    assert client.get("/files/..%2F..%2FCLAUDE.md").status_code in (400, 404)
    assert client.get("/files/nope.3mf").status_code == 404
