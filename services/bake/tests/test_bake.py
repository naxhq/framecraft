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
from app import export
from app.export import mf3
from app.geom import assemble, extrude, lettering, thicken
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


def test_export_credits_file_names_the_three_bundled_typefaces(chicago_bake):
    """v2-03 finding 5: CREDITS.txt used to say "third-party sources: none".

    Three OFL faces are bundled and their outlines are cut into the model, so
    the file has to name them and their licence.  The old sentence is gone: it
    now scopes the denial to MAP DATA, which is the claim that is true.
    """
    _output, _elapsed, out_dir, _scene = chicago_bake
    text = (out_dir / "CREDITS.txt").read_text(encoding="utf-8")
    assert "third-party sources: none" not in text
    assert "SIL Open Font License 1.1" in text
    for face in export.FONT_CREDITS:
        assert face.name in text and face.version in text
        assert face.copyright in text


def test_export_3mf_license_terms_name_the_fonts_only_when_text_was_cut(tmp_path):
    """The package says what is in it: a lettered model carries third-party
    letterforms, a plain one does not."""
    scene = scene_graph(buildings=[building("b1", 0.0, 0.0, 120.0, 40.0)])
    plain = bake(scene, PrintParams(), tmp_path, "no-text")
    lettered = bake(
        scene,
        PrintParams(engravings=[{"edge": "top", "text": "CHICAGO", "size_mm": 6.0}]),
        tmp_path,
        "with-text",
    )
    assert plain.result.status == "done" and lettered.result.status == "done"

    plain_meta = mf3.read_metadata(tmp_path / "no-text.3mf")
    letter_meta = mf3.read_metadata(tmp_path / "with-text.3mf")
    assert "Open Font License" not in plain_meta["LicenseTerms"]
    assert export.FONT_LICENSE_LINE in letter_meta["LicenseTerms"]
    assert export.FONT_LICENSE_LINE in letter_meta["Description"]
    # ... and the ODbL notice is still there, in both
    for meta in (plain_meta, letter_meta):
        assert meta["LicenseTerms"].startswith("OpenStreetMap data is licensed")
        assert meta["Copyright"] == "© OpenStreetMap contributors"


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
    # 04 stage 4's nine mesh rows, plus the stage 3 CONTAINER rows: the job that
    # writes the package audits it before deciding it can ship, so a download
    # can never be marked done on a file nobody read (v2-02 audit, finding 5).
    # `bodies` is 01/A6's one-connected-solid rule; it used to live only in
    # `app/cli.py`, so the bake could mark a three-body model done (v2-03,
    # finding 2).  The parts path has always had its own `bodies` row.
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
        "3mf_parts",
        "3mf_unit",
        "3mf_objects",
        "3mf_build_items",
        "3mf_attribution",
        "3mf_counts",
        "bodies",
    }
    # the serialised BakeResult uses the contract key "3mf", not "file_3mf"
    assert "3mf" in payload["bake_result"]["files"]


def test_bake_with_the_frame_off_ships_no_floating_letters(tmp_path):
    """v2-03 finding 2: an embossed engraving with `frame=false` used to ship.

    The lip it sits on does not exist, so the letters were a separate shell
    hovering 1.8 mm over the plate - and every validator passed, because the
    only one that would have caught it (`bodies`) ran under `make validate` and
    not inside the bake.  Both halves are asserted here: nothing is built, and
    if something were, the gate would now name it.
    """
    scene = scene_graph(buildings=[building("b1", 0.0, 0.0, 120.0, 40.0)])
    params = PrintParams(
        frame=False,
        base_thickness_mm=3.0,
        engravings=[
            {"edge": "top", "text": "CHICAGO", "size_mm": 6.0, "mode": "emboss"},
            {"edge": "bottom", "text": "2026", "size_mm": 6.0, "mode": "engrave"},
        ],
        north_arrow={"enabled": True, "corner": "ne", "size_mm": 4.0},
        scale_bar={"enabled": True},
    )
    out = bake(scene, params, tmp_path, "frame-off")
    assert out.result.status == "done", out.result.error
    assert_all_validators_pass(out.report)

    row = next(c for c in out.report.checks if c.name == "bodies")
    assert row.passed and row.value == 1, row.message
    notice = [w for w in out.result.warnings if "the frame is off" in w]
    assert len(notice) == 1 and "turn the frame on" in notice[0]

    letters = lettering.build(
        params, bake_pipeline.token_context(scene, params), rotation_deg=0.0
    )
    assert letters.cut == [] and letters.emboss == []

    # ... and the model is the same object as one asked for no text at all
    plain = bake(scene, PrintParams(**{**params.model_dump(), "engravings": [],
                                       "north_arrow": {"enabled": False},
                                       "scale_bar": {"enabled": False}}),
                 tmp_path, "frame-off-plain")
    assert plain.result.status == "done", plain.result.error
    assert out.result.stats.bbox_mm == pytest.approx(plain.result.stats.bbox_mm, abs=1e-6)
    assert out.result.stats.volume_mm3 == pytest.approx(
        plain.result.stats.volume_mm3, abs=1e-6
    )


def test_bodies_row_names_a_floating_island(tmp_path):
    """The row itself: a plate with a chip hovering over it fails, and says how
    many objects a slicer would show."""
    from manifold3d import Manifold, OpType

    plate = Manifold.cube((20.0, 20.0, 3.0), False)
    island = Manifold.cube((4.0, 4.0, 1.0), False).translate((8.0, 8.0, 5.0))
    solid = Manifold.batch_boolean([plate, island], OpType.Add)

    good = validators.single_body_check(bake_pipeline.manifold_to_trimesh(plate), plate)
    assert good.passed and good.value == 1

    bad = validators.single_body_check(bake_pipeline.manifold_to_trimesh(solid), solid)
    assert not bad.passed
    assert bad.value == 2 and bad.threshold == 1
    assert "2 objects" in bad.message


#: The detail advisor on the SHIPPED preset, measured through the real ingest
#: path (`presets.chicago-loop` -> `normalize.build_scene`, the committed
#: Overpass fixture) with the scene held at 900 m and only the advisor's radius
#: varied.  DECISIONS and the handoff claimed 80/74/68/35 and "the default
#: preset is good"; the truth is 70/61/52/34 and the default preset is FAIR
#: (v2-03 audit, finding 3).  Pinned so the record cannot drift from the code
#: again - if a weight or a predicate changes, this test says so.
CHICAGO_DETAIL_SCORES = {
    (900.0, 180): (70, "fair"),
    (1500.0, 180): (61, "fair"),
    (2400.0, 180): (52, "fair"),
    (3000.0, 100): (34, "poor"),
}


@pytest.mark.parametrize("case", sorted(CHICAGO_DETAIL_SCORES))
def test_detail_advisor_scores_on_the_real_preset(chicago_scene, case):
    radius_m, plate_mm = case
    want_score, want_band = CHICAGO_DETAIL_SCORES[case]
    report = T.detail_report(chicago_scene, PrintParams(plate_mm=plate_mm), radius_m)
    assert (report.score, report.band) == (want_score, want_band)


def test_detail_advisor_score_composition_on_the_default_preset(chicago_scene):
    """Every term of the default preset's 70, from the counts it came from.

    Widened 370/994 = 37.2 % -> 22.33, trees 5 762/5 762 = 100 % -> 5.00, areas
    360/753 = 47.8 % -> 2.39, dropped 0 -> 0.00; penalty 29.72, score 70.  The
    claimed 80 was not reachable from any weighting in the file.
    """
    report = T.detail_report(chicago_scene, PrintParams(), 900.0)
    assert (report.buildings_total, report.widened, report.dropped) == (994, 370, 0)
    assert report.trees_total == 5762
    assert report.trees_dropped_fraction == 1.0, (
        "every OSM tree here is the normalizer's default 4 m crown, which is "
        "0.37 mm of radius at 1:10,714 - under the 0.5 mm floor, so the bake "
        "prints none of them and 5 of the 100 points are a constant on this preset"
    )
    assert report.areas_total == 753
    penalty = (
        T.SCORE_WEIGHT_DROPPED * report.dropped_fraction
        + T.SCORE_WEIGHT_WIDENED * report.widened_fraction
        + T.SCORE_WEIGHT_TREES * report.trees_dropped_fraction
        + T.SCORE_WEIGHT_AREAS * report.areas_dropped_fraction
    )
    assert penalty == pytest.approx(29.72, abs=0.01)
    assert report.score == 70 and report.band == "fair"
    # The BAKE stays quiet at `fair` - `_detail_advice` gates on the band - so
    # nothing user-visible changes with the corrected number.  The editor's HUD
    # gates on the widened fraction instead and does speak here, which is the
    # honest thing for it to say about 37 % of the buildings.
    assert bake_pipeline._detail_advice(chicago_scene, PrintParams()) is None
    assert T.detail_recommendation(chicago_scene, PrintParams(), 900.0) == (
        "Radius 900 m at plate 180 widens 37%. Try 540 m."
    )


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


def test_validator_judges_height_against_the_printer_the_bake_names():
    """``max_height_mm`` is the ACTIVE printer's gantry, not a fixed 60.

    The ceiling belongs to the machine (DECISIONS ``[V3-P4-E9]``): the same
    70 mm model is unprintable on a 60 mm ceiling and perfectly printable on a
    P1S, and the browser bake records which one it was made for in its sidecar.
    Passing nothing keeps 04's own figure, so every file without a sidecar is
    judged exactly as it always was (the test above).
    """
    box = trimesh.creation.box(extents=(10.0, 10.0, 70.0))
    box.apply_translation([0.0, 0.0, 35.0])

    tall = validators.validate(
        box, PrintParams(), self_intersection_sample=False, max_height_mm=250.0
    )
    assert "bounding_box" not in tall.failed
    assert "250 mm" in tall.get("bounding_box").threshold

    short = validators.validate(
        box, PrintParams(), self_intersection_sample=False, max_height_mm=50.0
    )
    assert "bounding_box" in short.failed
    assert "50 mm" in short.get("bounding_box").message


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


# ==========================================================================
# color_mode="parts": one 3MF object per layer (PrintParams v2)
# ==========================================================================


#: The layer parts a full scene emits, in the order assemble.PART_ORDER fixes.
ALL_LAYER_PARTS = ("base", "frame", "buildings", "roads", "water", "green", "trees")


def seven_layer_scene() -> SceneGraph:
    """A synthetic scene in which all seven layers are non-empty.

    At the 250 m synthetic radius the scale is 0.336 mm/m, so the 12 m tree site
    prints at 4.03 mm and clears 04's 0.5 mm floor - no preset does at the
    default plate (DECISIONS [V2-P0]).
    """
    return scene_graph(
        buildings=[
            building("w1", -120.0, -100.0, 60.0, 40.0),
            building("w2", 100.0, 90.0, 50.0, 20.0),
            building("w3", -100.0, 120.0, 40.0, 90.0),
        ],
        roads=[road("r1", [(-200.0, 0.0), (200.0, 0.0)])],
        water=[AreaFeature(ring=square_ring(120.0, -120.0, 90.0), holes=[])],
        green=[AreaFeature(ring=square_ring(-160.0, 40.0, 70.0), holes=[])],
        trees=[Tree(x=0.0, y=160.0, radius_m=12.0)],
    )


def model_root(path: Path):
    """(parsed 3D/3dmodel.model, namespace prefix) of a 3MF package."""
    import xml.etree.ElementTree as ET

    with zipfile.ZipFile(path) as zf:
        return ET.fromstring(zf.read(mf3.MODEL_PART)), f"{{{mf3.CORE_NAMESPACE}}}"


def part_names(output) -> list:
    """The ``name`` of every mesh object in a bake's 3MF, in file order."""
    root, ns = model_root(output.paths["3mf"])
    return [
        obj.get("name")
        for obj in root.iter(f"{ns}object")
        if obj.find(f"{ns}mesh") is not None
    ]


@pytest.fixture(scope="session")
def chicago_parts_bake(tmp_path_factory) -> tuple:
    """Chicago at the defaults in PARTS mode: the golden for this feature."""
    scene_request = presets.PRESETS_BY_ID["chicago-loop"].request()
    raw = overpass.load_raw(scene_request, allow_network=False)
    scene = normalize.build_scene(raw, scene_request)
    out_dir = tmp_path_factory.mktemp("chicago-parts")
    output = bake_pipeline.run_pipeline(
        scene,
        scene_request,
        PrintParams(color_mode="parts"),
        job_id="goldenparts",
        out_dir=out_dir,
        stem="chicago-parts",
    )
    return output, out_dir, scene


def test_parts_golden_chicago_passes_every_validator(chicago_parts_bake):
    output, _out_dir, _scene = chicago_parts_bake
    assert_all_validators_pass(output.report)
    assert output.result.status == "done"
    # ... including the three rows single mode does not have.
    for name in ("bodies", "part_meshes", "parts_union"):
        assert output.report.get(name) is not None, f"{name} row missing"


def test_parts_golden_chicago_emits_six_parts_at_the_default_plate(chicago_parts_bake):
    """No preset has a printable tree at the default plate/radius (every OSM
    tree radius is capped at 4.0 m, 0.37 mm at 1:10,714, under 04's 0.5 mm
    floor - DECISIONS [V2-P0]), so Chicago at the defaults is six parts."""
    output, _out_dir, _scene = chicago_parts_bake
    assert part_names(output) == ["base", "frame", "buildings", "roads", "water", "green"]


def test_parts_3mf_loads_as_a_scene_with_one_watertight_geometry_per_part(
    chicago_parts_bake,
):
    output, _out_dir, _scene = chicago_parts_bake
    scene = trimesh.load(output.paths["3mf"], process=False)
    assert isinstance(scene, trimesh.Scene)
    assert list(scene.geometry.keys()) == part_names(output)
    for name, geom in scene.geometry.items():
        assert geom.is_watertight, name
        assert geom.volume > 0.0, name


def test_parts_golden_chicago_still_writes_one_welded_stl(chicago_parts_bake):
    """04 stage 3's fallback format has no notion of parts: it stays the single
    welded body, and it is the same mesh single mode writes."""
    output, out_dir, _scene = chicago_parts_bake
    mesh, _welded = cli._index_stl_triangle_soup(
        trimesh.load(out_dir / "chicago-parts.stl", force="mesh", process=False)
    )
    assert validators.body_count(mesh) == 1
    assert mesh.is_watertight
    assert len(mesh.faces) == output.result.stats.triangles


def test_parts_all_seven_layers_become_parts(tmp_path):
    output = bake(seven_layer_scene(), PrintParams(color_mode="parts"), tmp_path, "seven")
    assert_all_validators_pass(output.report)
    assert part_names(output) == list(ALL_LAYER_PARTS)

    root, ns = model_root(output.paths["3mf"])
    materials = root.findall(f".//{ns}basematerials")
    assert len(materials) == 1
    assert len(materials[0].findall(f"{ns}base")) == 7
    build = root.find(f"{ns}build")
    assert len(build.findall(f"{ns}item")) == 1
    assembly = [o for o in root.iter(f"{ns}object") if o.find(f"{ns}components") is not None]
    assert len(assembly) == 1
    assert len(assembly[0].findall(f"{ns}components/{ns}component")) == 7


def test_parts_union_is_exactly_the_single_mode_solid(tmp_path):
    """The parts PARTITION the model: same volume, same bounding box, same
    validators.  Baked twice from one scene so nothing is assumed."""
    scene = seven_layer_scene()
    single = bake(scene, PrintParams(), tmp_path, "single")
    parts = bake(scene, PrintParams(color_mode="parts"), tmp_path, "parts")
    assert_all_validators_pass(single.report)
    assert_all_validators_pass(parts.report)

    a, b = single.result.stats, parts.result.stats
    assert a.triangles == b.triangles
    assert a.volume_mm3 == pytest.approx(b.volume_mm3, rel=1e-12)
    assert list(a.bbox_mm) == list(b.bbox_mm)
    assert a.min_wall_mm == pytest.approx(b.min_wall_mm, rel=1e-12)
    # ... and single mode is still a one-object package.
    root, ns = model_root(single.paths["3mf"])
    assert len(list(root.iter(f"{ns}object"))) == 1
    assert not root.findall(f".//{ns}basematerials")


def test_parts_z_ranges_interpenetrate_by_the_04_overlap(tmp_path):
    """Every part-to-part contact overlaps by 04's 0.2 mm, and the recess floor
    is exactly where single mode puts it."""
    params = PrintParams(color_mode="parts")
    output = bake(seven_layer_scene(), params, tmp_path, "zranges")
    scene = trimesh.load(output.paths["3mf"], process=False)
    z = {name: (geom.bounds[0][2], geom.bounds[1][2]) for name, geom in scene.geometry.items()}

    base_top = T.base_top_mm(params)
    overlap = extrude.PART_OVERLAP_MM
    assert overlap == T.BUILDING_OVERLAP_MM == 0.2
    assert z["base"][0] == pytest.approx(0.0) and z["base"][1] == pytest.approx(base_top)
    # additive layers rise from base_top - 0.2 ...
    for name in ("frame", "buildings", "green", "trees"):
        assert z[name][0] == pytest.approx(base_top - overlap), name
    assert z["frame"][1] == pytest.approx(base_top + T.FRAME_LIP_MM)
    assert z["green"][1] == pytest.approx(base_top + T.GREEN_RAISE_MM)
    # ... and each recess inlay sits directly under its own floor.
    assert extrude.PART_INLAY_MM >= 0.6
    for name, offset in (("water", T.water_z_mm(params)), ("roads", T.road_z_mm(params))):
        floor = extrude.recess_floor_mm(params, offset)
        assert floor == pytest.approx(base_top + offset)
        assert z[name][1] == pytest.approx(floor), name
        assert z[name][0] == pytest.approx(floor - extrude.PART_INLAY_MM), name
        assert z[name][0] > 0.0, name


def test_parts_the_base_is_pocketed_under_every_recess(tmp_path):
    """The recess is still a recess: at a height inside the inlay the base part
    has a hole exactly where the inlay is."""
    from shapely.geometry import Point

    params = PrintParams(color_mode="parts")
    output = bake(seven_layer_scene(), params, tmp_path, "pocket")
    scene = trimesh.load(output.paths["3mf"], process=False)
    water_z = T.water_z_mm(params)
    probe = extrude.inlay_bottom_mm(params, water_z) + extrude.PART_INLAY_MM / 2.0

    base_at = shapely.union_all(validators.section_polygons(scene.geometry["base"], probe))
    water_at = shapely.union_all(validators.section_polygons(scene.geometry["water"], probe))
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    centre = Point(120.0 * scale, -120.0 * scale)  # the pond, in print mm
    assert water_at.contains(centre), "the water inlay does not cover the pond"
    assert not base_at.contains(centre), "the base was not pocketed for the inlay"
    # ... and the base is solid again below the inlay.
    below = extrude.inlay_bottom_mm(params, water_z) - 0.05
    base_below = shapely.union_all(validators.section_polygons(scene.geometry["base"], below))
    assert base_below.contains(centre)


def test_parts_material_entries_are_one_per_part_in_rgba8(tmp_path):
    colors = {
        "base": "#112233",
        "frame": "#445566",
        "buildings": "#778899",
        "roads": "#aabbcc",
        "water": "#ddeeff",
        "green": "#010203",
        "trees": "#040506",
    }
    params = PrintParams(color_mode="parts", part_colors=colors)
    output = bake(seven_layer_scene(), params, tmp_path, "colors")
    root, ns = model_root(output.paths["3mf"])
    entries = root.findall(f".//{ns}basematerials/{ns}base")
    assert [e.get("name") for e in entries] == list(ALL_LAYER_PARTS)
    assert [e.get("displaycolor") for e in entries] == [
        colors[name].upper() + "FF" for name in ALL_LAYER_PARTS
    ]
    # every object points at its own entry, in range
    objects = [o for o in root.iter(f"{ns}object") if o.find(f"{ns}mesh") is not None]
    assert [o.get("pindex") for o in objects] == [str(i) for i in range(7)]
    assert {o.get("pid") for o in objects} == {str(mf3.MATERIALS_ID)}


def test_parts_writer_normalises_and_rejects_colours():
    assert mf3.normalize_color("#a1b2c3") == "#A1B2C3FF"
    assert mf3.normalize_color("#A1B2C380") == "#A1B2C380"
    for bad in ("#12345", "112233", "#gg1122", "", "#1122334455"):
        with pytest.raises(ValueError):
            mf3.normalize_color(bad)


def test_parts_validator_rejects_a_union_that_is_not_the_model():
    """Non-vacuous: a union that is not the reference solid must fail."""
    box_a = trimesh.creation.box(extents=(10.0, 10.0, 10.0))
    bigger = trimesh.creation.box(extents=(10.0, 10.0, 11.0))
    good = validators.validate_parts(
        [("a", box_a)], union=box_a, reference=box_a, components=1
    )
    assert all(c.passed for c in good), [c.message for c in good if not c.passed]

    bad = validators.validate_parts(
        [("a", box_a)], union=box_a, reference=bigger, components=1
    )
    assert "parts_union" in {c.name for c in bad if not c.passed}


def test_parts_validator_rejects_debris_and_a_broken_part():
    solid = trimesh.creation.box(extents=(10.0, 10.0, 10.0))
    speck = trimesh.creation.box(extents=(0.1, 0.1, 0.1))  # 0.001 mm^3
    rows = {c.name: c for c in validators.validate_parts([("a", solid), ("b", speck)])}
    assert not rows["bodies"].passed and "debris" in rows["bodies"].message

    holed = solid.copy()
    holed.update_faces(np.arange(len(holed.faces)) != 0)
    rows = {c.name: c for c in validators.validate_parts([("a", holed)], components=1)}
    assert not rows["part_meshes"].passed
    assert "not watertight" in rows["part_meshes"].message

    # a component count that disagrees with the part count is a failure too
    rows = {c.name: c for c in validators.validate_parts([("a", solid)], components=2)}
    assert not rows["bodies"].passed


def test_parts_mode_is_off_by_default_and_writes_the_v1_package(tmp_path):
    output = bake(seven_layer_scene(), PrintParams(), tmp_path, "default")
    root, ns = model_root(output.paths["3mf"])
    assert len(list(root.iter(f"{ns}object"))) == 1
    assert root.find(f"{ns}build").findall(f"{ns}item")[0].get("objectid") == "1"
    # `bodies` is in BOTH modes now - one connected solid is 01/A6's rule for
    # the model, not a property of the parts path (v2-03 audit, finding 2) -
    # while `parts_union` is meaningless without parts.
    bodies = output.report.get("bodies")
    assert bodies is not None and bodies.passed and bodies.value == 1
    assert output.report.get("parts_union") is None


def test_parts_an_empty_layer_is_not_written_as_an_empty_object(tmp_path):
    """A 3MF object must hold a mesh, so a layer with nothing in it is skipped -
    which is why the part count is a function of the scene."""
    scene = scene_graph(buildings=[building("w1", 0.0, 0.0, 60.0, 30.0)])
    output = bake(
        scene, PrintParams(color_mode="parts", frame=False, road_mode="off"), tmp_path, "bare"
    )
    assert_all_validators_pass(output.report)
    assert part_names(output) == ["base", "buildings"]


def test_parts_survive_a_frame_off_recess_that_reaches_the_plate_edge(tmp_path):
    """DECISIONS [P5-fix]: with the frame off a recess may run past the crop, so
    the inlay (which is 0.2 mm wider still) has to be clipped to the plate."""
    scene = scene_graph(
        buildings=[building("w1", 0.0, 0.0, 60.0, 30.0)],
        water=[AreaFeature(ring=square_ring(180.0, 0.0, 260.0), holes=[])],
    )
    output = bake(scene, PrintParams(color_mode="parts", frame=False), tmp_path, "edge")
    assert_all_validators_pass(output.report)
    parts = trimesh.load(output.paths["3mf"], process=False)
    half = float(PrintParams().plate_mm) / 2.0
    for name, geom in parts.geometry.items():
        assert geom.bounds[0][0] >= -half - 1e-9, name
        assert geom.bounds[1][0] <= half + 1e-9, name


# ==========================================================================
# Hero buildings (PrintParams v2)
# ==========================================================================


def hero_scene() -> SceneGraph:
    """Two footprints closer than the minimum gap, so Stage 1 merges them: a
    100 m hero next to a 20 m neighbour."""
    return scene_graph(
        buildings=[
            building("hero", -12.0, 0.0, 24.0, 100.0),
            building("plain", 13.0, 0.0, 24.0, 20.0),
        ]
    )


def test_hero_keeps_its_true_height_while_its_neighbours_halve(tmp_path):
    params = PrintParams(
        small_scale=0.5, large_scale=0.5, hero_building_ids=["hero"], hero_mode="true_height"
    )
    scene = hero_scene()
    output = bake(scene, params, tmp_path, "heroheight")
    assert_all_validators_pass(output.report)

    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    hero_top = T.base_top_mm(params) + 100.0 * scale * 1.0
    assert output.result.stats.bbox_mm[2] == pytest.approx(hero_top, abs=1e-6)
    # ... and without the hero the same scene prints at half that height.
    plain = bake(scene, PrintParams(small_scale=0.5, large_scale=0.5), tmp_path, "heroless")
    assert plain.result.stats.bbox_mm[2] == pytest.approx(
        T.base_top_mm(params) + 100.0 * scale * 0.5, abs=1e-6
    )


def test_hero_survives_block_merging_as_a_separate_solid():
    params = PrintParams(small_scale=1.0, large_scale=1.0, hero_building_ids=["hero"])
    scene = hero_scene()
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    thresholds = T.thresholds_ground_m(params, scale)
    layer = thicken.repair_buildings(
        scene.buildings,
        thresholds,
        thicken.crop_square(params, scale),
        grid=thicken.PRINT_GRID_MM / scale,
        params=params,
        scale=scale,
    )
    # The two footprints fused into one block ...
    assert layer.merged_components == 1
    heroes = layer.heroes
    assert heroes and all(s.hero_id == "hero" for s in heroes)
    # ... the hero is stacked on that block, not swallowed by it ...
    assert all(s.stands_on is not None for s in heroes)
    # ... and the block took the NEIGHBOUR's height, not the hero's.
    blocks = [s for s in layer.blocks if s.height.height_m > 0.0]
    assert blocks and all(s.height.height_m == pytest.approx(20.0) for s in blocks)


def test_hero_is_never_exempt_from_the_minimum_feature_repair():
    """A hero footprint under the minimum wall is widened exactly like any
    other, and one that is still too small is dropped and reported."""
    params = PrintParams(hero_building_ids=["thin", "speck"])
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    thresholds = T.thresholds_ground_m(params, scale)
    thin_ring = [(-40.0, -0.6), (40.0, -0.6), (40.0, 0.6), (-40.0, 0.6)]
    scene = scene_graph(
        buildings=[
            building("thin", 0.0, 0.0, 0.0, 30.0, ring=thin_ring),
            building("speck", 100.0, 100.0, 0.3, 30.0),
        ]
    )
    repaired = thicken.repair_scene(scene, params)
    assert repaired.buildings.widened >= 1
    for solid in repaired.buildings.solids:
        assert thicken.survives_min_wall(solid.polygon, thresholds.min_wall)
    assert "speck" in repaired.buildings.hero_dropped
    assert any("hero buildings were dropped" in w for w in repaired.warnings)


def test_hero_gets_its_own_3mf_part_when_the_mode_asks_for_a_colour(tmp_path):
    params = PrintParams(
        color_mode="parts",
        small_scale=0.5,
        large_scale=0.5,
        hero_building_ids=["hero"],
        hero_mode="both",
    )
    output = bake(hero_scene(), params, tmp_path, "heropart")
    assert_all_validators_pass(output.report)
    assert part_names(output) == ["base", "frame", "buildings", "hero:hero"]

    root, ns = model_root(output.paths["3mf"])
    entries = root.findall(f".//{ns}basematerials/{ns}base")
    assert entries[-1].get("name") == "hero:hero"
    assert entries[-1].get("displaycolor") == assemble.HERO_COLOR.upper() + "FF"
    # the hero part really is the tall solid, standing on the block
    scene = trimesh.load(output.paths["3mf"], process=False)
    hero = scene.geometry["hero:hero"]
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    assert hero.bounds[1][2] == pytest.approx(T.base_top_mm(params) + 100.0 * scale, abs=1e-6)
    block_top = T.base_top_mm(params) + 20.0 * scale * 0.5
    assert hero.bounds[0][2] == pytest.approx(block_top - T.BUILDING_OVERLAP_MM, abs=1e-6)


def test_hero_own_color_alone_changes_no_height(tmp_path):
    """``own_color`` gives the hero a part, not a multiplier."""
    params = PrintParams(
        color_mode="parts",
        small_scale=0.5,
        large_scale=0.5,
        hero_building_ids=["hero"],
        hero_mode="own_color",
    )
    output = bake(hero_scene(), params, tmp_path, "heroplain")
    assert_all_validators_pass(output.report)
    assert "hero:hero" in part_names(output)
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    assert output.result.stats.bbox_mm[2] == pytest.approx(
        T.base_top_mm(params) + 100.0 * scale * 0.5, abs=1e-6
    )


def test_hero_in_single_mode_is_simply_unioned(tmp_path):
    params = PrintParams(hero_building_ids=["hero"], hero_mode="both")
    output = bake(hero_scene(), params, tmp_path, "herosingle")
    assert_all_validators_pass(output.report)
    root, ns = model_root(output.paths["3mf"])
    assert len(list(root.iter(f"{ns}object"))) == 1
    mesh = trimesh.load(output.paths["3mf"], force="mesh", process=False)
    assert validators.body_count(mesh) == 1


def test_hero_ids_that_are_not_in_the_scene_warn_and_are_ignored(tmp_path):
    params = PrintParams(color_mode="parts", hero_building_ids=["hero", "nope", "alsono"])
    output = bake(hero_scene(), params, tmp_path, "herounknown")
    assert_all_validators_pass(output.report)
    warning = [w for w in output.result.warnings if "not in this scene" in w]
    assert warning and "nope" in warning[0] and "alsono" in warning[0]
    assert "hero" not in warning[0].split(": ", 1)[1]


def test_hero_shorter_than_its_block_is_reported_not_faked():
    params = PrintParams(hero_building_ids=["plain"], hero_mode="both")
    repaired = thicken.repair_scene(hero_scene(), params)
    assert repaired.buildings.hero_buried == ["plain"]
    assert not repaired.buildings.heroes
    assert any("cannot be shown separately" in w for w in repaired.warnings)


def test_hero_alone_in_its_block_owns_the_block(tmp_path):
    """A hero with no neighbour has nothing to stack on: the block IS the hero,
    so it still gets its own part and its own height."""
    params = PrintParams(
        color_mode="parts",
        small_scale=0.5,
        large_scale=0.5,
        hero_building_ids=["lonely"],
        hero_mode="both",
    )
    scene = scene_graph(buildings=[building("lonely", 0.0, 0.0, 40.0, 80.0)])
    output = bake(scene, params, tmp_path, "herolone")
    assert_all_validators_pass(output.report)
    assert part_names(output) == ["base", "frame", "hero:lonely"]
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    assert output.result.stats.bbox_mm[2] == pytest.approx(
        T.base_top_mm(params) + 80.0 * scale, abs=1e-6
    )


def test_the_height_guard_counts_the_hero(tmp_path):
    """04's 60 mm ceiling, refused before Stage 1 - with the hero multiplier."""
    scene = scene_graph(buildings=[building("tower", 0.0, 0.0, 40.0, 170.0)])
    halved = PrintParams(small_scale=0.5, large_scale=0.5)
    assert bake_pipeline.predicted_top_mm(scene, halved) < validators.MAX_HEIGHT_MM
    hero = PrintParams(small_scale=0.5, large_scale=0.5, hero_building_ids=["tower"])
    assert bake_pipeline.predicted_top_mm(scene, hero) >= validators.MAX_HEIGHT_MM
    with pytest.raises(bake_pipeline.ModelTooTallError) as excinfo:
        bake(scene, hero, tmp_path, "herotall")
    assert "60 mm limit" in str(excinfo.value)


def test_api_bake_honours_color_mode(client, monkeypatch):
    monkeypatch.setattr(main_module, "build_scene", lambda request: seven_layer_scene())
    response = client.post(
        "/bake",
        json={
            "scene_request": synth_request().model_dump(mode="json"),
            "print_params": {**PrintParams().model_dump(mode="json"), "color_mode": "parts"},
        },
    )
    assert response.status_code == 202
    result = poll(client, response.json()["job_id"], timeout_s=120.0)
    assert result.status == "done", result.error
    # BakeResult.files is unchanged: still exactly the 3mf and the stl.
    assert result.files is not None
    assert set(result.files.model_dump().keys()) == {"3mf", "stl"}
    name = result.files.file_3mf.rsplit("/", 1)[-1]
    root, ns = model_root(bake_pipeline.ARTIFACTS_DIR / name)
    assert len([o for o in root.iter(f"{ns}object") if o.find(f"{ns}mesh") is not None]) == 7
    assert len(root.findall(f".//{ns}basematerials/{ns}base")) == 7


# --------------------------------------------------------------------------
# v2-02 audit regressions: the colour partition and the package the bake writes
# --------------------------------------------------------------------------


def crossing_scene() -> SceneGraph:
    """A road that crosses a pond, which is where the two recesses overlap.

    The audit measured 262 mm^3 of doubly-owned recess floor on Chicago wherever
    a road crosses the river; this is the same situation in twenty lines.
    """
    return SceneGraph(
        bounds=Bounds(min_x=-250.0, min_y=-250.0, max_x=250.0, max_y=250.0),
        center=Center(lat=41.8827, lon=-87.6233),
        buildings=[building("w1", -120.0, 120.0, 60.0, 18.0)],
        roads=[
            Road(
                id="r1",
                path=[(-200.0, 0.0), (200.0, 0.0)],
                width_m=14.0,
                **{"class": "primary"},
            )
        ],
        water=[AreaFeature(ring=square_ring(0.0, 0.0, 160.0), holes=[])],
        green=[AreaFeature(ring=square_ring(150.0, -150.0, 60.0), holes=[])],
        trees=[],
        stats=Stats(building_count=1, coverage="good", height_tag_ratio=1.0),
    )


def part_solids(assembly) -> dict:
    return {part.layer: part.solid for part in assembly.color_parts}


def assemble_parts(scene: SceneGraph, params: PrintParams):
    return assemble.assemble(thicken.repair_scene(scene, params), params)


def test_parts_no_two_parts_own_the_same_recess_floor(tmp_path):
    """Where a road crosses water, the visible floor has ONE owner.

    The audit's finding 1: both inlays used to fill the same 0.5 mm and present
    the SAME top face at the same z over 398 mm^2 of Chicago, leaving the slicer
    to arbitrate which filament prints the groove floor.  The loser is now
    CAPPED under the winner (``extrude.inlay_claim``), so its material there is
    buried; the two still interpenetrate by 04's 0.2 mm, which is what every
    other pair of parts in this model does, and the only floor they both reach
    is the ``CLAIM_INSET_MM`` band where the cap stops short of the winner's own
    edge on purpose (see that constant for why).
    """
    from manifold3d import Manifold, OpType

    params = PrintParams(color_mode="parts")
    assembly = assemble_parts(crossing_scene(), params)
    by_layer = part_solids(assembly)
    assert {"water", "roads"} <= set(by_layer), "the fixture must have both recesses"

    road_floor = extrude.recess_floor_mm(params, T.road_z_mm(params))
    water_floor = extrude.recess_floor_mm(params, T.water_z_mm(params))
    assert road_floor < water_floor, "the road groove is the deeper one here"

    just_under = road_floor - 0.01
    water_area = by_layer["water"].slice(just_under).area()
    road_area = by_layer["roads"].slice(just_under).area()
    both = Manifold.batch_boolean(
        [by_layer["water"], by_layer["roads"]], OpType.Intersect
    ).slice(just_under).area()
    assert water_area > 0.0 and road_area > 0.0, "the two really do meet here"
    # The whole point: the shared footprint is owned by the water part, not by
    # both.  What is left is the deliberate 0.05 mm rim, which cannot be more
    # than a hundredth of the area the two would otherwise have shared.
    assert both <= 0.01 * min(water_area, road_area), (
        f"{both:.3f} mm^2 of floor is still reached by both parts "
        f"(water {water_area:.1f}, roads {road_area:.1f})"
    )
    # ... and above the road floor the road part is gone entirely, so the
    # visible floor at 2.4 belongs to the water part alone.
    assert by_layer["roads"].slice(road_floor + 0.01).area() == pytest.approx(0.0)

    # No pair of parts overlaps except through a deliberate interpenetration:
    # the base with everything it carries, and the two inlays by the 0.2 mm cap.
    for i, a in enumerate(assembly.color_parts):
        for b in assembly.color_parts[i + 1 :]:
            volume = Manifold.batch_boolean(
                [a.solid, b.solid], OpType.Intersect
            ).volume()
            if volume > 1e-9:
                pair = {a.layer, b.layer}
                assert "base" in pair or pair == {"water", "roads"}, (
                    f"{a.name} x {b.name} = {volume}"
                )


def test_parts_the_capped_inlay_is_buried_not_deleted(tmp_path):
    """The cap must not open a hole: what the loser keeps under the winner is
    exactly what the winner and the base already cover."""
    from manifold3d import Manifold, OpType

    params = PrintParams(color_mode="parts")
    assembly = assemble_parts(crossing_scene(), params)
    by_layer = part_solids(assembly)
    covered = Manifold.batch_boolean(
        [by_layer["water"], by_layer["base"]], OpType.Add
    )
    buried = Manifold.batch_boolean(
        [by_layer["roads"], by_layer["water"]], OpType.Intersect
    )
    assert buried.volume() > 0.0, "the fixture must actually overlap"
    outside = Manifold.batch_boolean([buried, covered], OpType.Subtract).volume()
    assert outside == pytest.approx(0.0, abs=1e-9), (
        f"{outside:.6g} mm^3 of the capped inlay is outside what covers it"
    )


def test_parts_partition_the_single_mode_solid_exactly(tmp_path):
    """The audit's finding 4: the parts used to be a strict SUPERSET.

    A recess cutter cuts the buildings too (``merge_recess_ridges`` grows the
    road layer back over them), and single mode subtracted the cutters from the
    whole additive union while parts mode pocketed only the base.  The
    difference is measured here in both directions, with the same symmetric
    difference the ``parts_union`` row uses.
    """
    from manifold3d import Manifold, OpType

    params = PrintParams(color_mode="parts")
    assembly = assemble_parts(crossing_scene(), params)
    extra = Manifold.batch_boolean(
        [assembly.parts_union, assembly.solid], OpType.Subtract
    ).volume()
    missing = Manifold.batch_boolean(
        [assembly.solid, assembly.parts_union], OpType.Subtract
    ).volume()
    assert extra + missing <= validators.PART_UNION_SYMDIFF_MM3, (
        f"parts - single = {extra:.6g}, single - parts = {missing:.6g}"
    )
    # The bound is derived from the pipeline's own snap grid, not chosen to fit.
    assert validators.PART_UNION_SYMDIFF_MM3 == thicken.PRINT_GRID_MM**3
    # ... and it is far tighter than the volume-only budget it replaces, which
    # is what let the old error through.
    assert validators.PART_UNION_SYMDIFF_MM3 < 1e-4 * (
        validators.PART_UNION_VOLUME_TOLERANCE * assembly.solid.volume()
    )


def test_parts_every_additive_part_is_cut_by_the_recesses(tmp_path):
    """The mechanism behind the fix: a part that a groove crosses loses that
    material, exactly as the single-mode union does."""
    from manifold3d import Manifold, OpType

    params = PrintParams(color_mode="parts")
    scene = crossing_scene()
    repaired = thicken.repair_scene(scene, params)
    assembly = assemble.assemble(repaired, params)
    by_layer = part_solids(assembly)
    scale = repaired.scale
    road_cutter = extrude.slab(
        repaired.roads.polygons, params, scale, T.road_z_mm(params)
    )
    assert road_cutter is not None
    for layer in ("buildings", "green"):
        if layer not in by_layer:
            continue
        inside = Manifold.batch_boolean(
            [by_layer[layer], road_cutter], OpType.Intersect
        ).volume()
        assert inside == pytest.approx(0.0, abs=1e-9), (
            f"the {layer} part still holds {inside:.6g} mm^3 inside the road groove"
        )


def test_parts_union_check_fails_on_a_manufactured_partition_error():
    """The row has teeth: take a millimetre out of one part and it fails.

    A volume-and-bounding-box check could not see this, which is the whole
    point: the cube removed here is interior, so the bounding box does not move
    and the volume budget (0.168 mm^3 on a Chicago plate) would swallow it.
    """
    from manifold3d import Manifold, OpType

    solid = Manifold.cube((20.0, 20.0, 5.0), False)
    bite = Manifold.cube((1.0, 1.0, 1.0), False).translate((5.0, 5.0, 2.0))
    broken = Manifold.batch_boolean([solid, bite], OpType.Subtract)
    full = bake_pipeline.manifold_to_trimesh(solid)
    partial = bake_pipeline.manifold_to_trimesh(broken)

    good = validators.validate_parts(
        [("only", full)], union=full, reference=full, components=1
    )
    assert next(c for c in good if c.name == "parts_union").passed

    bad = validators.validate_parts(
        [("only", partial)], union=partial, reference=full, components=1
    )
    row = next(c for c in bad if c.name == "parts_union")
    assert not row.passed
    assert "missing 1" in row.message or "missing 0.999" in row.message
    # the volume-only test would have passed it: 1 mm^3 is under the relative
    # budget for a model this size... so assert the symmetric difference is what
    # failed, not the volume.
    extra, missing, ok = validators.symmetric_difference_mm3(partial, full)
    assert not ok and missing == pytest.approx(1.0, abs=1e-6) and extra < 1e-9


def test_parts_triangle_budget_is_judged_on_the_parts_that_ship(tmp_path, monkeypatch):
    """04's budget applies to the .3mf, which in parts mode is the parts.

    ``enforce_triangle_budget`` decimates the single-mode solid that becomes the
    .stl and deliberately leaves the parts alone (decimating them independently
    would break the partition), so the budget has to be re-asserted on the parts
    or a model that decimated would ship a .3mf over it with
    ``triangle_budget PASS``.
    """
    params = PrintParams(color_mode="parts")
    output = bake(seven_layer_scene(), params, tmp_path, "budget")
    total = sum(
        len(mesh.faces)
        for _name, mesh in [
            (name, geom)
            for name, geom in trimesh.load(
                output.paths["3mf"], process=False
            ).geometry.items()
        ]
    )
    assert total > 0
    monkeypatch.setattr(validators, "TRIANGLE_BUDGET", total // 2)
    meshes = [
        (name, geom)
        for name, geom in trimesh.load(output.paths["3mf"], process=False).geometry.items()
    ]
    rows = validators.validate_parts(meshes, components=len(meshes))
    row = next(c for c in rows if c.name == "part_meshes")
    assert not row.passed and "budget" in row.message


def test_parts_bake_runs_the_container_rows_on_the_file_it_wrote(tmp_path):
    """The audit's finding 5: the bake used to ship a package it never read.

    ``POST /bake`` marks a job done on ``report.passed`` alone, so every row that
    only ran under ``make validate`` was a row the product path never saw.
    """
    parts = bake(seven_layer_scene(), PrintParams(color_mode="parts"), tmp_path, "container")
    names = [c.name for c in parts.report.checks]
    for row in ("3mf_materials", "3mf_components", "3mf_color_mode", "3mf_counts",
                "3mf_unit", "3mf_objects", "3mf_build_items", "3mf_attribution",
                "3mf_parts"):
        assert row in names, f"{row} is missing from the parts bake report: {names}"
    assert parts.report.passed
    # single mode gets the single-colour container rows, for the same reason
    single = bake(seven_layer_scene(), PrintParams(), tmp_path, "container-single")
    single_names = [c.name for c in single.report.checks]
    for row in ("3mf_parts", "3mf_unit", "3mf_objects", "3mf_build_items",
                "3mf_attribution", "3mf_counts"):
        assert row in single_names, single_names
    assert "3mf_materials" not in single_names
    assert single.report.passed


def test_parts_bake_ships_nothing_when_a_container_row_fails(tmp_path, monkeypatch):
    """A package the bake cannot vouch for is quarantined like any other failure."""
    from app.export import mf3

    real = mf3.write_3mf_parts

    def broken(path, parts, metadata):
        written = real(path, parts, metadata)
        # Reference the first part twice and the last one never: a file a slicer
        # would build with two of one part and no other.
        import zipfile

        with zipfile.ZipFile(written) as zin:
            payload = {name: zin.read(name) for name in zin.namelist()}
        model = payload[mf3.MODEL_PART].decode("utf-8")
        first = model[model.index("<component objectid=") :]
        first = first[: first.index("/>") + 2]
        last_id = str(1 + len(parts))
        model = model.replace(f'<component objectid="{last_id}"/>', first, 1)
        payload[mf3.MODEL_PART] = model.encode("utf-8")
        with zipfile.ZipFile(written, "w", compression=zipfile.ZIP_DEFLATED) as zout:
            for name, data in payload.items():
                zout.writestr(name, data)
        return written

    monkeypatch.setattr(mf3, "write_3mf_parts", broken)
    output = bake(
        seven_layer_scene(), PrintParams(color_mode="parts"), tmp_path, "broken"
    )
    assert output.result.status == "failed"
    assert output.result.files is None
    assert "3mf_components" in (output.result.error or "") or "bodies" in (
        output.result.error or ""
    )
    assert not (tmp_path / "broken.3mf").exists(), "a file that failed must not ship"


def test_parts_a_slice_profile_patch_keeps_the_colour_of_what_it_patches(monkeypatch):
    """The audit's finding 8: a patch inherited a hero's HEIGHT but not its id,
    so it printed at hero height in the buildings colour.

    The neck is FABRICATED here.  ``repair_slice_profiles`` only produces a patch
    when the union of two footprints has a corridor its members do not - a real
    but rare shape that two synthetic squares cannot make (a corner pinch is
    filled by the mitre-joined opening) - and the invariant under test is about
    what the patch CARRIES, not about what finds it.  Monkeypatching the
    detector is what makes the branch run at all.
    """
    params = PrintParams(hero_building_ids=["w-hero"], hero_mode="both")
    scale = T.scale_mm_per_m(params, SYNTH_RADIUS_M)
    thresholds = T.thresholds_ground_m(params, scale)
    grid = thicken.PRINT_GRID_MM / scale
    crop = thicken.crop_square(params, scale)

    size = 40.0
    a = Polygon(square_ring(-19.5, -19.5, size))
    b = Polygon(square_ring(19.5, 19.5, size))
    hero = thicken.BuildingSolid(
        a, thicken.HeightSpec(30.0, False, True), None, "w-hero"
    )
    other = thicken.BuildingSolid(b, thicken.HeightSpec(120.0, True, False), None, None)
    layer = thicken.BuildingLayer(solids=[hero, other])

    calls = {"n": 0}
    real_thin_parts = thicken.thin_parts

    def one_neck(poly, min_wall, area_floor, factor=thicken.MIN_WALL_REPAIR_FACTOR):
        """A single thin neck at the corner the two footprints share, once."""
        calls["n"] += 1
        if calls["n"] != 2:  # the first call sees one footprint alone
            return []
        return [Polygon(square_ring(0.0, 0.0, 1.0))]

    monkeypatch.setattr(thicken, "thin_parts", one_neck)
    added = thicken.repair_slice_profiles(layer, params, thresholds, scale, crop, grid)
    monkeypatch.setattr(thicken, "thin_parts", real_thin_parts)

    patches = layer.solids[2:]
    assert added == len(patches) >= 1, "the fabricated neck must produce a patch"
    for patch in patches:
        source = next(s for s in (hero, other) if s.height is patch.height)
        assert patch.hero_id == source.hero_id, (
            "a patch must print in the colour of the solid whose height it takes"
        )
    # ... and in this arrangement the patch really does belong to the HERO: the
    # patch goes to the shortest solid of the prefix, which is the 30 m hero.
    assert any(p.hero_id == "w-hero" for p in patches)
    assert all(p.height.is_hero for p in patches if p.hero_id == "w-hero")


def lettered_params(**overrides):
    """Parts mode with an engraving, an emboss, a hanger and an underside mark.

    Every cutter single mode has is present: two recesses, the engraved-text
    cutter and the underside pockets.
    """
    base = dict(
        color_mode="parts",
        base_thickness_mm=4.0,
        city_label="Chicago",
        engravings=[
            {"edge": "top", "text": "CHICAGO", "size_mm": 6.0, "font": "sans"},
            {
                "edge": "top",
                "text": "2026",
                "size_mm": 6.0,
                "font": "sans",
                "mode": "emboss",
                "align": "end",
            },
        ],
        north_arrow={"enabled": True, "corner": "ne", "size_mm": 4.0},
        hanger="keyhole",
        underside_mark={"enabled": True, "template": "{city}"},
    )
    base.update(overrides)
    return PrintParams(**base)


def test_parts_every_additive_part_is_cut_by_the_full_cutter_list(tmp_path):
    """The audit's finding 6: ``carved()`` only got the RECESS cutters.

    Single mode subtracts ``[road, water, text, underside]`` from the whole
    additive union, so an embossed engraving never met the engraved-text cutter,
    buildings/green/trees/heroes met neither the text nor the underside cutter,
    and with the frame OFF the text cutter was applied to nothing at all.  The
    invariant is one line: every additive part loses what single mode subtracts.
    """
    from manifold3d import Manifold, OpType

    params = lettered_params()
    scene = seven_layer_scene()
    ctx = bake_pipeline.token_context(scene, params, date="2026-08-30")
    letters = lettering.build(params, ctx, rotation_deg=0.0)
    assert letters.cut and letters.underside_cut, "the fixture must exercise both"
    repaired = thicken.repair_scene(scene, params)
    assembly = assemble.assemble(repaired, params, lettering=letters)
    assert assembly.color_parts

    cutters = assemble.batched_union([*letters.cut, *letters.underside_cut])
    assert cutters is not None
    # The sit-at-zero translation is the identity for a plate that is already
    # centred and already starts at z = 0, so parts and cutters share a frame.
    base = next(p for p in assembly.color_parts if p.layer == "base")
    box = base.solid.bounding_box()
    assert (box[0], box[1], box[2]) == pytest.approx(
        (-params.plate_mm / 2.0, -params.plate_mm / 2.0, 0.0), abs=1e-9
    )
    for part in assembly.color_parts:
        if part.layer == "base":
            continue  # the base's recesses are pockets; its underside IS cut
        inside = Manifold.batch_boolean(
            [part.solid, cutters], OpType.Intersect
        ).volume()
        assert inside == pytest.approx(0.0, abs=1e-9), (
            f"the {part.name} part holds {inside:.6g} mm^3 inside a cutter"
        )


def test_parts_with_text_and_pockets_still_partition_the_single_solid(tmp_path):
    """The same model in both modes describes the same object, with every kind
    of cutter in play."""
    from manifold3d import Manifold, OpType

    params = lettered_params()
    scene = seven_layer_scene()
    single = bake(scene, PrintParams(**{**params.model_dump(), "color_mode": "single"}),
                  tmp_path, "text-single")
    parts = bake(scene, params, tmp_path, "text-parts")
    assert single.result.status == "done", single.result.error
    assert parts.result.status == "done", parts.result.error
    row = next(c for c in parts.report.checks if c.name == "parts_union")
    assert row.passed, row.message
    # the two modes agree on the model's volume to the last microlitre
    assert single.result.stats.volume_mm3 == pytest.approx(
        parts.result.stats.volume_mm3, abs=1e-6
    )


def test_parts_debris_is_dropped_only_when_another_part_holds_it(tmp_path):
    """The audit's finding 7: the per-part prune used to be unconditional.

    Every chip it dropped happened to lie inside another part's 0.2 mm
    interpenetration band, so nothing was lost - but nothing said so.  A chip
    that is NOT covered has to survive, and the ``bodies`` row is then what
    reports it.
    """
    from manifold3d import Manifold, OpType

    body = Manifold.cube((10.0, 10.0, 2.0), False)
    chip = Manifold.cube((0.2, 0.2, 0.05), False).translate((12.0, 3.0, 0.5))
    solid = Manifold.batch_boolean([body, chip], OpType.Add)
    assert chip.volume() < assemble.MIN_BODY_VOLUME_MM3
    assert len(solid.decompose()) == 2, "the chip must be a separate shell"

    covering = Manifold.cube((1.0, 1.0, 1.0), False).translate((11.8, 2.8, 0.2))
    swept = assemble._prune_covered(solid, covering)
    assert len(swept.decompose()) == 1, "a chip another part holds is dropped"
    assert swept.volume() == pytest.approx(body.volume(), abs=1e-9)

    far = Manifold.cube((1.0, 1.0, 1.0), False).translate((-5.0, -5.0, 0.0))
    kept = assemble._prune_covered(solid, far)
    assert len(kept.decompose()) == 2, "a chip nobody holds must survive the sweep"
    assert kept.volume() == pytest.approx(solid.volume(), abs=1e-12)
