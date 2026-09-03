"""The reference validator's ``labels`` row and the min-wall masks (v3.1 Task 12).

The browser engine cuts a name into a roof or a ground surface and declares,
per label, a Z band and the ink polygon it occupies (the sidecar's
``label_bands``).  ``checks.validate`` masks the polygon out of the structural
``min_wall`` probe inside the band and judges the strokes and ridges inside it
by a ``labels`` row with the lettering row's own thresholds.  These tests build
the geometry with manifold3d rather than baking a scene, so every width they
assert on is one they set:

* a 0.6 mm groove and a 0.5 mm ridge inside a declared polygon pass the row
  and are NOT measured by ``min_wall``;
* the same ridge WITHOUT the declaration is measured, and fails, which is what
  the mask exists to prevent judging as a wall;
* a band that carries no stroke, a stroke under one nozzle, a band taller than
  the contract's deepest label and a band outside the model each fail with the
  band named;
* the caps in the validator are the contract's own numbers;
* the CLI reads ``label_bands`` off the sidecar defensively.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import trimesh
from manifold3d import Manifold

from app import cli
from app.contracts import PrintParams
from app.validate import checks

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA = REPO_ROOT / "packages" / "contracts" / "schema" / "print_params.json"

PLATE_MM = 40.0
BLOCK_MM = 20.0
BLOCK_TOP_MM = 13.0
GROOVE_DEPTH_MM = 0.4


def _box(x0: float, y0: float, z0: float, x1: float, y1: float, z1: float) -> Manifold:
    return Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0])


def _to_mesh(solid: Manifold) -> trimesh.Trimesh:
    mesh = solid.to_mesh()
    return trimesh.Trimesh(
        vertices=np.asarray(mesh.vert_properties)[:, :3],
        faces=np.asarray(mesh.tri_verts),
        process=False,
    )


def _labelled_block(groove_mm: float = 0.6, ridge_mm: float = 0.5, cut: bool = True) -> Manifold:
    """A 3 mm plate carrying a 20 mm block, with two grooves in its roof.

    The grooves run along y, are ``groove_mm`` wide and ``GROOVE_DEPTH_MM``
    deep, and leave a ``ridge_mm`` ridge of roof between them: the shape two
    engraved letters leave.
    """
    plate = _box(-PLATE_MM / 2, -PLATE_MM / 2, 0.0, PLATE_MM / 2, PLATE_MM / 2, 3.0)
    block = _box(-BLOCK_MM / 2, -BLOCK_MM / 2, 2.8, BLOCK_MM / 2, BLOCK_MM / 2, BLOCK_TOP_MM)
    solid = plate + block
    if not cut:
        return solid
    # The grooves run the full height of the declared ink polygon (y +-6), so
    # inside it the ridge is a strip on its own whose width is what is measured.
    z0 = BLOCK_TOP_MM - GROOVE_DEPTH_MM
    left = _box(-ridge_mm / 2 - groove_mm, -6.0, z0, -ridge_mm / 2, 6.0, BLOCK_TOP_MM + 0.5)
    right = _box(ridge_mm / 2, -6.0, z0, ridge_mm / 2 + groove_mm, 6.0, BLOCK_TOP_MM + 0.5)
    return solid - left - right


def _band(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "id": "label-0",
        "index": 0,
        "mode": "engrave",
        "z": [BLOCK_TOP_MM - GROOVE_DEPTH_MM, BLOCK_TOP_MM],
        "face_z": BLOCK_TOP_MM,
        # The ink polygon spans the grooves' full length, as the engine's does
        # (the ink box grown by a nozzle): nothing the label cut lies outside it.
        "rect": [[-3.0, -6.0], [3.0, -6.0], [3.0, 6.0], [-3.0, 6.0]],
        "region": "buildings",
    }
    base.update(overrides)
    return base


@pytest.fixture(scope="module")
def params() -> PrintParams:
    return PrintParams(plate_mm=100.0)


def test_a_declared_label_passes_the_labels_row_and_is_masked_out_of_min_wall(params):
    solid = _labelled_block()
    mesh = _to_mesh(solid)
    report = checks.validate(mesh, params, manifold=solid, label_bands=[_band()])
    labels = report.get("labels")
    assert labels is not None and labels.passed, labels.message
    assert "1 band(s); 2 strokes" in str(labels.value)
    # 0.600 mm grooves, a 0.500 mm ridge: the numbers the block was built with.
    assert "0.600 mm stroke / 0.500 mm ridge" in str(labels.value)
    assert report.get("min_wall").passed, report.get("min_wall").message


def test_the_same_ridge_without_a_declaration_is_measured_as_a_wall_and_fails():
    solid = _labelled_block()
    mesh = _to_mesh(solid)
    # Deep enough in the band that the "is this a wall?" look-ahead one printed
    # layer up still lands inside the grooves, as it does for a ground label.
    z = BLOCK_TOP_MM - 0.35
    smallest, failing, measured, _skipped = checks._min_wall_probe(
        mesh, 0.8, slices=0, manifold=solid, extra_zs=[z]
    )
    assert failing >= 1 and smallest < 0.72, (smallest, failing, measured)
    masked, failing_masked, _measured, _ = checks._min_wall_probe(
        mesh, 0.8, slices=0, manifold=solid, extra_zs=[z], masks=checks._label_masks(checks._clean_label_bands([_band()]))
    )
    assert failing_masked == 0
    # The block's own walls at that height are still measured: 20 mm, not a sliver.
    assert masked >= 0.8


def test_a_band_that_carries_no_stroke_fails_by_name(params):
    solid = _labelled_block(cut=False)
    mesh = _to_mesh(solid)
    report = checks.validate(mesh, params, manifold=solid, label_bands=[_band(id="label-7")])
    row = report.get("labels")
    assert not row.passed
    assert "label-7: declared engrave band" in row.message
    assert "carries no stroke" in row.message


def test_a_stroke_under_one_nozzle_fails_with_its_width(params):
    solid = _labelled_block(groove_mm=0.2)
    mesh = _to_mesh(solid)
    report = checks.validate(mesh, params, manifold=solid, label_bands=[_band()])
    row = report.get("labels")
    assert not row.passed
    assert "engraved stroke 0.200 mm" in row.message


def test_a_ridge_under_one_nozzle_fails_too(params):
    solid = _labelled_block(ridge_mm=0.2)
    mesh = _to_mesh(solid)
    report = checks.validate(mesh, params, manifold=solid, label_bands=[_band()])
    row = report.get("labels")
    assert not row.passed
    assert "ridge 0.200 mm" in row.message


def test_an_embossed_band_measures_the_standing_letters(params):
    # Two 0.9 mm bars standing 0.4 mm proud of the roof, 0.6 mm apart.
    solid = _labelled_block(cut=False)
    bar_a = _box(-1.2, -4.0, BLOCK_TOP_MM - 0.2, -0.3, 4.0, BLOCK_TOP_MM + 0.4)
    bar_b = _box(0.3, -4.0, BLOCK_TOP_MM - 0.2, 1.2, 4.0, BLOCK_TOP_MM + 0.4)
    raised = solid + bar_a + bar_b
    mesh = _to_mesh(raised)
    band = _band(mode="emboss", z=[BLOCK_TOP_MM, BLOCK_TOP_MM + 0.4])
    report = checks.validate(mesh, params, manifold=raised, label_bands=[band])
    row = report.get("labels")
    assert row.passed, row.message
    assert "2 strokes" in str(row.value)
    assert "0.900 mm stroke" in str(row.value)
    # A bar under two nozzles is a wall the emboss rule fails.
    thin = solid + _box(-0.3, -4.0, BLOCK_TOP_MM - 0.2, 0.3, 4.0, BLOCK_TOP_MM + 0.4)
    report = checks.validate(_to_mesh(thin), params, manifold=thin, label_bands=[band])
    assert not report.get("labels").passed
    assert "embossed stroke 0.600 mm" in report.get("labels").message


def test_bands_are_bounded_like_the_attribution_bands(params):
    solid = _labelled_block()
    mesh = _to_mesh(solid)
    tall = _band(z=[BLOCK_TOP_MM - 2.0, BLOCK_TOP_MM])
    outside = _band(z=[BLOCK_TOP_MM + 5.0, BLOCK_TOP_MM + 5.4])
    report = checks.validate(mesh, params, manifold=solid, label_bands=[tall, outside])
    row = report.get("labels")
    assert not row.passed
    assert "over 1.5 mm tall" in row.message
    assert "outside the model" in row.message
    too_many = [_band(id=f"label-{i}") for i in range(checks.LABEL_BAND_MAX_COUNT + 1)]
    report = checks.validate(mesh, params, manifold=solid, label_bands=too_many)
    assert "over the 12 allowed" in report.get("labels").message


def test_the_caps_are_the_contracts_own_numbers():
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    assert checks.LABEL_BAND_MAX_COUNT == schema["properties"]["labels"]["maxItems"]
    assert checks.LABEL_BAND_MAX_MM == schema["$defs"]["Label"]["properties"]["depth_mm"]["maximum"]


def test_no_declaration_adds_no_row(params):
    solid = _labelled_block(cut=False)
    report = checks.validate(_to_mesh(solid), params, manifold=solid)
    assert report.get("labels") is None
    assert report.get("min_wall").passed


def test_malformed_bands_are_dropped_not_raised():
    cleaned = checks._clean_label_bands(
        [
            "not a dict",
            {"z": "nope"},
            {"z": [1.0]},
            {"z": [2.0, 1.0], "rect": [[0, 0], [1, 0], [1, 1]]},
            {"z": [1.0, 2.0], "rect": [[0, 0], [1, 0]]},
            {"z": [1.0, 2.0], "rect": [[0, 0], [1, 0], [1, 1]], "mode": "weird"},
        ]
    )
    assert len(cleaned) == 1
    assert cleaned[0].mode == "engrave"
    assert cleaned[0].low == 1.0 and cleaned[0].high == 2.0


def test_the_cli_reads_label_bands_off_the_sidecar(tmp_path: Path):
    model = tmp_path / "labelled.3mf"
    model.write_bytes(b"")
    assert cli._label_bands_from_sidecar(model) is None
    sidecar = tmp_path / "labelled.json"
    sidecar.write_text(json.dumps({"label_bands": [_band(), "junk", 3]}), encoding="utf-8")
    bands = cli._label_bands_from_sidecar(model)
    assert bands is not None and len(bands) == 1
    assert bands[0]["id"] == "label-0"
    sidecar.write_text("{not json", encoding="utf-8")
    assert cli._label_bands_from_sidecar(model) is None
    sidecar.write_text(json.dumps({"label_bands": "no"}), encoding="utf-8")
    assert cli._label_bands_from_sidecar(model) is None
