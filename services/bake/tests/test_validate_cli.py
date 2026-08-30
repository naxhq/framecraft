"""Phase 5 (qa-gate): the ``make validate`` CLI.

``make validate FILE=x.3mf`` is gate G3 and half of the A5 evidence, so this
suite drives the command itself - not the library behind it - on artifacts a
real bake produced, and proves it is *not vacuous*: a deliberately corrupted
copy of the same file has to come back FAIL with the right check named and a
non-zero exit code.

Layout:

* ``test_cli_passes_*``       - a freshly baked .3mf / .stl, every row PASS.
* ``test_cli_table_*``        - the table shape 04 stage 4 asks for.
* ``test_cli_fails_*``        - one corruption per validator, each named.
* ``test_cli_structure_*``    - the 3MF container checks (04 stage 3).
* ``test_cli_exit_code_*``    - the real subprocess, i.e. what make sees.
* ``test_a6_*``               - the strongest automated proxy for "opens in a
  slicer as one object sitting on the bed" (see docs/handoff/05-qa-gate.md).
* ``test_cli_*sidecar*``      - the ``<stem>.json`` the bake writes beside the
  mesh: a broken one has to be a FAIL row, never a pydantic traceback.

Everything here runs offline: the scenes are synthetic, no fixture, no network.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import numpy as np
import pytest
import trimesh

from app import bake as bake_pipeline
from app import cli
from app.contracts import (
    Bounds,
    Building,
    Center,
    PrintParams,
    SceneGraph,
    SceneRequest,
    Stats,
)
from app.export import mf3
from app.geom import transform as T

REPO_ROOT = Path(__file__).resolve().parents[3]
SERVICE_ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = REPO_ROOT / "artifacts"

#: Small radius: the whole point is a fast, deterministic solid, not a city.
SYNTH_RADIUS_M = 250.0

#: Every row 04 stage 4 requires, by the name ``checks.py`` gives it.
STAGE4_CHECKS = (
    "manifold",
    "watertight",
    "volume",
    "self_intersection",
    "bounding_box",
    "sits_at_zero",
    "min_wall",
    "triangle_budget",
    "degenerate_faces",
)

#: Rows that judge the whole solid rather than the container, so they run for a
#: ``.stl`` too.  ``bodies`` is the A6 half ``watertight`` deliberately does not
#: assert: that row tolerates several bodies by design (its Euler test is
#: ``even and <= 2 * body_count``), and ``3mf_objects`` counts XML elements, so
#: a second shell written into the same ``<object>`` gets past both.
SOLID_CHECKS = ("bodies",)

#: The container rows this phase added on top (04 stage 3).
STRUCTURE_CHECKS = (
    "3mf_parts",
    "3mf_unit",
    "3mf_objects",
    "3mf_build_items",
    "3mf_attribution",
    "3mf_counts",
)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def _square(cx: float, cy: float, size: float) -> list[tuple[float, float]]:
    h = size / 2.0
    return [(cx - h, cy - h), (cx + h, cy - h), (cx + h, cy + h), (cx - h, cy + h)]


def _scene() -> SceneGraph:
    buildings = [
        Building(
            id="w1",
            ring=_square(-60.0, -40.0, 70.0),
            holes=[],
            height_m=60.0,
            height_source="tag",
            min_height_m=0.0,
            is_tall=True,
        ),
        Building(
            id="w2",
            ring=_square(70.0, 60.0, 50.0),
            holes=[],
            height_m=20.0,
            height_source="tag",
            min_height_m=0.0,
            is_tall=False,
        ),
    ]
    return SceneGraph(
        bounds=Bounds(
            min_x=-SYNTH_RADIUS_M,
            min_y=-SYNTH_RADIUS_M,
            max_x=SYNTH_RADIUS_M,
            max_y=SYNTH_RADIUS_M,
        ),
        center=Center(lat=41.8827, lon=-87.6233),
        buildings=buildings,
        roads=[],
        water=[],
        green=[],
        trees=[],
        stats=Stats(building_count=len(buildings), coverage="good", height_tag_ratio=1.0),
    )


@pytest.fixture(scope="module")
def baked(tmp_path_factory) -> Path:
    """A real bake: ``.3mf`` + ``.stl`` + the ``.json`` sidecar beside them."""
    out_dir = tmp_path_factory.mktemp("validate-cli")
    request = SceneRequest(
        lat=41.8827,
        lon=-87.6233,
        radius_m=SYNTH_RADIUS_M,
        rotation_deg=0.0,
        preset_id=None,
    )
    output = bake_pipeline.run_pipeline(
        _scene(),
        request,
        PrintParams(),
        job_id="qagate",
        out_dir=out_dir,
        stem="qagate",
    )
    assert output.result.status == "done", output.result.error
    return out_dir / "qagate.3mf"


def run_cli(capsys, *args: str) -> tuple[int, str]:
    """``python -m app.cli <args>`` in process; returns (exit code, stdout)."""
    code = cli.main(list(args))
    return code, capsys.readouterr().out


def rows(table: str) -> dict[str, tuple[str, str, str]]:
    """Parse the printed table into ``{check: (verdict, value, threshold)}``."""
    out: dict[str, tuple[str, str, str]] = {}
    for line in table.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[1] in ("PASS", "FAIL"):
            head, _, tail = line.partition(parts[1])
            value_and_threshold = tail.strip()
            out[parts[0]] = (parts[1], value_and_threshold, head.strip())
    return out


def verdicts(table: str) -> dict[str, str]:
    return {name: value[0] for name, value in rows(table).items()}


def remesh(source: Path, target: Path, vertices, faces) -> Path:
    """Rewrite ``source`` with different geometry, keeping its metadata."""
    mf3.write_3mf(target, np.asarray(vertices), np.asarray(faces), mf3.read_metadata(source))
    return target


def rewrite_model_xml(source: Path, target: Path, transform, *, drop: str | None = None) -> Path:
    """Copy a 3MF, passing its model XML through ``transform``.

    ``drop`` omits one part from the package entirely.
    """
    with zipfile.ZipFile(source) as zin:
        parts = {name: zin.read(name) for name in zin.namelist()}
    model = parts[mf3.MODEL_PART].decode("utf-8")
    parts[mf3.MODEL_PART] = transform(model).encode("utf-8")
    if drop is not None:
        parts.pop(drop, None)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as zout:
        for name, payload in parts.items():
            zout.writestr(name, payload)
    return target


# --------------------------------------------------------------------------
# The happy path
# --------------------------------------------------------------------------


def test_cli_passes_on_a_freshly_baked_3mf(baked, capsys):
    code, out = run_cli(capsys, "validate", str(baked))
    assert code == 0, out
    assert "ALL CHECKS PASS" in out
    assert all(verdict == "PASS" for verdict in verdicts(out).values()), out


def test_cli_passes_on_the_stl_of_the_same_bake(baked, capsys):
    code, out = run_cli(capsys, "validate", str(baked.with_suffix(".stl")))
    assert code == 0, out
    assert "ALL CHECKS PASS" in out
    # The STL is a triangle soup; the CLI says so instead of silently welding.
    assert "duplicate vertices" in out


def test_cli_table_lists_every_stage4_check_with_a_value_and_a_threshold(baked, capsys):
    _code, out = run_cli(capsys, "validate", str(baked))
    table = rows(out)
    for name in STAGE4_CHECKS + SOLID_CHECKS + STRUCTURE_CHECKS:
        assert name in table, f"{name} missing from the table:\n{out}"
        verdict, value_and_threshold, _ = table[name]
        assert verdict in ("PASS", "FAIL")
        assert value_and_threshold, f"{name} printed no value/threshold"
    assert "check" in out and "result" in out and "value" in out and "threshold" in out


def test_cli_reports_the_parameters_it_validated_against(baked, capsys):
    _code, out = run_cli(capsys, "validate", str(baked))
    # The sidecar the bake wrote is what sets plate/nozzle, not a guess.
    assert "sidecar qagate.json" in out
    assert "plate 180 mm" in out and "nozzle 0.4 mm" in out


def test_cli_refuses_a_file_that_does_not_exist(capsys):
    code, _out = run_cli(capsys, "validate", str(SERVICE_ROOT / "nope.3mf"))
    assert code == 2


# --------------------------------------------------------------------------
# Not vacuous: one corruption per validator
# --------------------------------------------------------------------------


def test_cli_fails_when_a_triangle_is_deleted(baked, tmp_path, capsys):
    mesh = trimesh.load(baked, force="mesh", process=False)
    holed = remesh(
        baked,
        tmp_path / "holed.3mf",
        mesh.vertices,
        np.delete(np.asarray(mesh.faces), 0, axis=0),
    )
    code, out = run_cli(capsys, "validate", str(holed))
    assert code == 1
    assert "ALL CHECKS PASS" not in out
    assert verdicts(out)["watertight"] == "FAIL"
    assert verdicts(out)["manifold"] == "FAIL"
    assert "watertight" in out.splitlines()[-1]


def test_cli_fails_when_the_model_is_scaled_past_the_plate(baked, tmp_path, capsys):
    mesh = trimesh.load(baked, force="mesh", process=False)
    big = remesh(
        baked, tmp_path / "big.3mf", np.asarray(mesh.vertices) * 1.5, mesh.faces
    )
    code, out = run_cli(capsys, "validate", str(big))
    assert code == 1
    assert verdicts(out)["bounding_box"] == "FAIL"
    # ...and only that: scaling up cannot break the topology.
    assert verdicts(out)["watertight"] == "PASS"
    assert verdicts(out)["sits_at_zero"] == "PASS"


def test_cli_fails_when_the_model_is_lifted_off_the_bed(baked, tmp_path, capsys):
    mesh = trimesh.load(baked, force="mesh", process=False)
    lifted = remesh(
        baked,
        tmp_path / "lifted.3mf",
        np.asarray(mesh.vertices) + np.array([0.0, 0.0, 2.0]),
        mesh.faces,
    )
    code, out = run_cli(capsys, "validate", str(lifted))
    assert code == 1
    assert verdicts(out)["sits_at_zero"] == "FAIL"
    assert verdicts(out)["watertight"] == "PASS"


def test_cli_fails_when_the_plate_override_is_smaller_than_the_model(baked, capsys):
    code, out = run_cli(capsys, "validate", str(baked), "--plate-mm", "100")
    assert code == 1
    assert verdicts(out)["bounding_box"] == "FAIL"


def test_cli_fails_on_an_inverted_solid(baked, tmp_path, capsys):
    """Flipped winding: 04 asks for volume == abs(volume) exactly for this."""
    mesh = trimesh.load(baked, force="mesh", process=False)
    flipped = remesh(
        baked,
        tmp_path / "flipped.3mf",
        mesh.vertices,
        np.asarray(mesh.faces)[:, ::-1],
    )
    code, out = run_cli(capsys, "validate", str(flipped))
    assert code == 1
    assert verdicts(out)["volume"] == "FAIL"


# --------------------------------------------------------------------------
# The 3MF container (04 stage 3)
# --------------------------------------------------------------------------


def test_cli_structure_fails_without_the_rels_part(baked, tmp_path, capsys):
    broken = rewrite_model_xml(
        baked, tmp_path / "norels.3mf", lambda xml: xml, drop=mf3.RELS_PART
    )
    code, out = run_cli(capsys, "validate", str(broken))
    assert code == 1
    assert verdicts(out)["3mf_parts"] == "FAIL"
    assert "_rels/.rels" in out


def test_cli_structure_fails_on_a_file_that_is_not_a_zip(tmp_path, capsys):
    junk = tmp_path / "junk.3mf"
    junk.write_bytes(b"not a package at all")
    code, out = run_cli(capsys, "validate", str(junk))
    assert code == 1
    assert verdicts(out)["3mf_parts"] == "FAIL"


def test_cli_structure_fails_on_the_wrong_unit(baked, tmp_path, capsys):
    inches = rewrite_model_xml(
        baked,
        tmp_path / "inch.3mf",
        lambda xml: xml.replace('unit="millimeter"', 'unit="inch"'),
    )
    code, out = run_cli(capsys, "validate", str(inches))
    assert code == 1
    assert verdicts(out)["3mf_unit"] == "FAIL"


def test_cli_structure_fails_on_two_build_items(baked, tmp_path, capsys):
    two = rewrite_model_xml(
        baked,
        tmp_path / "twoitems.3mf",
        lambda xml: xml.replace(
            '<item objectid="1"/>', '<item objectid="1"/><item objectid="1"/>'
        ),
    )
    code, out = run_cli(capsys, "validate", str(two))
    assert code == 1
    assert verdicts(out)["3mf_build_items"] == "FAIL"
    assert verdicts(out)["3mf_objects"] == "PASS"


def test_cli_structure_fails_without_the_osm_attribution(baked, tmp_path, capsys):
    stripped = rewrite_model_xml(
        baked,
        tmp_path / "noattrib.3mf",
        lambda xml: xml.replace(mf3.ATTRIBUTION, "Somebody Else"),
    )
    code, out = run_cli(capsys, "validate", str(stripped))
    assert code == 1
    assert verdicts(out)["3mf_attribution"] == "FAIL"


def test_cli_structure_fails_when_an_object_is_never_built(baked, tmp_path, capsys):
    """A second, unreferenced object: the XML declares more than the mesh has."""

    def add_object(xml: str) -> str:
        return xml.replace(
            "</resources>",
            '<object id="2" type="model"><mesh><vertices>'
            '<vertex x="0.000000000000" y="0.000000000000" z="0.000000000000"/>'
            '<vertex x="1.000000000000" y="0.000000000000" z="0.000000000000"/>'
            '<vertex x="0.000000000000" y="1.000000000000" z="0.000000000000"/>'
            '</vertices><triangles>'
            '<triangle v1="0" v2="1" v3="2"/>'
            "</triangles></mesh></object></resources>",
        )

    extra = rewrite_model_xml(baked, tmp_path / "twoobjects.3mf", add_object)
    code, out = run_cli(capsys, "validate", str(extra))
    assert code == 1
    assert verdicts(out)["3mf_objects"] == "FAIL"
    assert verdicts(out)["3mf_counts"] == "FAIL"


def _with_floating_cube(source: Path, target: Path, z: float = 30.0) -> Path:
    """The baked solid plus a 5 mm cube hovering at ``z``, in ONE ``<object>``.

    This is the file a slicer opens as two objects while every XML-counting row
    (``3mf_objects``, ``3mf_build_items``, ``3mf_counts``) still says one.
    """
    mesh = trimesh.load(source, force="mesh", process=False)
    cube = trimesh.creation.box(extents=(5.0, 5.0, 5.0))
    cube.apply_translation([0.0, 0.0, z])
    vertices = np.vstack([np.asarray(mesh.vertices), np.asarray(cube.vertices)])
    faces = np.vstack(
        [np.asarray(mesh.faces), np.asarray(cube.faces) + len(mesh.vertices)]
    )
    return remesh(source, target, vertices, faces)


def test_cli_fails_when_a_second_disconnected_body_is_added(baked, tmp_path, capsys):
    """01/A6: a floating island is exactly what a slicer surfaces to the user."""
    twobodies = _with_floating_cube(baked, tmp_path / "twobodies.3mf")
    code, out = run_cli(capsys, "validate", str(twobodies))
    assert code == 1, out
    assert "ALL CHECKS PASS" not in out
    assert verdicts(out)["bodies"] == "FAIL"
    # ...and it is the ONLY thing wrong: the package is still well formed and
    # the mesh is still closed, which is why this row has to exist at all.
    assert verdicts(out)["watertight"] == "PASS"
    assert verdicts(out)["3mf_objects"] == "PASS"
    assert verdicts(out)["3mf_build_items"] == "PASS"
    assert verdicts(out)["3mf_counts"] == "PASS"
    assert "bodies" in out.splitlines()[-1]


def test_cli_fails_on_a_second_body_in_an_stl_too(baked, tmp_path, capsys):
    """A ``.stl`` gets no container rows at all, so ``bodies`` is all it has."""
    mesh = trimesh.load(baked, force="mesh", process=False)
    cube = trimesh.creation.box(extents=(5.0, 5.0, 5.0))
    cube.apply_translation([0.0, 0.0, 30.0])
    combined = trimesh.Trimesh(
        vertices=np.vstack([np.asarray(mesh.vertices), np.asarray(cube.vertices)]),
        faces=np.vstack(
            [np.asarray(mesh.faces), np.asarray(cube.faces) + len(mesh.vertices)]
        ),
        process=False,
        validate=False,
    )
    target = tmp_path / "twobodies.stl"
    target.write_bytes(trimesh.exchange.stl.export_stl(combined))
    code, out = run_cli(capsys, "validate", str(target))
    assert code == 1, out
    assert verdicts(out)["bodies"] == "FAIL"


def test_cli_bodies_row_passes_on_the_real_bake(baked, capsys):
    """Not vacuous in the other direction: the shipped file reads exactly one."""
    _code, out = run_cli(capsys, "validate", str(baked))
    assert rows(out)["bodies"][0] == "PASS"
    assert rows(out)["bodies"][1].split()[0] == "1"


def test_cli_structure_refuses_a_model_part_with_a_doctype(baked, tmp_path, capsys):
    bomb = rewrite_model_xml(
        baked,
        tmp_path / "doctype.3mf",
        lambda xml: xml.replace(
            '<?xml version="1.0" encoding="UTF-8"?>\n',
            '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE model [<!ENTITY a "b">]>\n',
        ),
    )
    code, out = run_cli(capsys, "validate", str(bomb))
    assert code == 1
    assert "DTD" in out


# --------------------------------------------------------------------------
# What make sees: a real process and a real exit code
# --------------------------------------------------------------------------


def _subprocess_validate(path: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "app.cli", "validate", str(path)],
        cwd=SERVICE_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def test_cli_exit_code_is_zero_for_a_good_file_and_one_for_a_bad_one(baked, tmp_path):
    good = _subprocess_validate(baked)
    assert good.returncode == 0, good.stdout + good.stderr
    assert "ALL CHECKS PASS" in good.stdout

    mesh = trimesh.load(baked, force="mesh", process=False)
    bad = remesh(
        baked,
        tmp_path / "bad.3mf",
        np.asarray(mesh.vertices),
        np.delete(np.asarray(mesh.faces), 5, axis=0),
    )
    failed = _subprocess_validate(bad)
    assert failed.returncode == 1, failed.stdout + failed.stderr
    assert "FAILED:" in failed.stdout
    assert "ALL CHECKS PASS" not in failed.stdout


@pytest.mark.skipif(
    not (ARTIFACTS / "chicago.3mf").is_file(),
    reason="artifacts/chicago.3mf is not baked (run: make bake-fixture)",
)
def test_cli_passes_on_the_chicago_fixture_bake(capsys):
    """G3's own command, kept green: `make validate artifacts/chicago.3mf`."""
    code, out = run_cli(capsys, "validate", str(ARTIFACTS / "chicago.3mf"))
    assert code == 0, out
    assert "ALL CHECKS PASS" in out


# --------------------------------------------------------------------------
# A6 proxy: "opens in a slicer as one object, flat on the bed"
# --------------------------------------------------------------------------


def test_a6_proxy_the_3mf_loads_as_one_watertight_body_sitting_at_zero(baked):
    """The strongest check available without a slicer on this host.

    Loaded through trimesh's own 3MF reader (the same lxml path Bambu Studio's
    and PrusaSlicer's importers exercise conceptually): one body, watertight,
    positive volume, and its lowest point on the bed.
    """
    with baked.open("rb") as handle:
        mesh = trimesh.load(handle, file_type="3mf", force="mesh", process=False)
    assert isinstance(mesh, trimesh.Trimesh)
    assert mesh.is_watertight
    assert mesh.is_winding_consistent
    assert mesh.volume > 0
    assert mesh.body_count == 1
    assert abs(mesh.bounds[0][2]) <= 0.001
    assert mesh.bounds[1][2] < T.MAX_HEIGHT_MM


def test_a6_proxy_the_scene_graph_form_keeps_one_object(baked):
    """Loaded as a scene (not force="mesh"), the package still holds one part."""
    scene = trimesh.load(baked)
    geometries = (
        scene.geometry if hasattr(scene, "geometry") else {"mesh": scene}
    )
    assert len(geometries) == 1


# --------------------------------------------------------------------------
# The bake sidecar: a broken one is a verdict, never a traceback
# --------------------------------------------------------------------------


def _with_sidecar(baked: Path, tmp_path: Path, payload) -> Path:
    """A copy of the baked ``.3mf`` whose ``<stem>.json`` sidecar is ``payload``.

    ``payload`` is written verbatim when it is a string, else as JSON.
    """
    target = tmp_path / "scratch.3mf"
    shutil.copy(baked, target)
    sidecar = target.with_suffix(".json")
    sidecar.write_text(
        payload if isinstance(payload, str) else json.dumps(payload),
        encoding="utf-8",
    )
    return target


def _real_sidecar(baked: Path) -> dict:
    return json.loads(baked.with_suffix(".json").read_text(encoding="utf-8"))


def test_cli_fails_the_sidecar_row_when_its_params_are_outside_the_contract(
    baked, tmp_path, capsys
):
    """A sidecar the FROZEN contract rejects used to reach the terminal as a
    pydantic traceback with no table at all."""
    payload = _real_sidecar(baked)
    payload["print_params"]["plate_mm"] = 5000  # contract maximum is 256
    target = _with_sidecar(baked, tmp_path, payload)

    code, out = run_cli(capsys, "validate", str(target))

    assert code == 1, out
    assert "sidecar params invalid" in out
    assert "plate_mm" in out
    assert verdicts(out)["sidecar_params"] == "FAIL"
    assert "ALL CHECKS PASS" not in out
    # The mesh was still judged: the broken sidecar does not swallow the table.
    for name in STAGE4_CHECKS:
        assert name in verdicts(out)


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ("{not json at all", "not valid JSON"),
        ({"scene_request": {"lat": 1.0}}, "no print_params object"),
        ({"print_params": "180 mm please"}, "no print_params object"),
        ({"print_params": {"plate_mm": "wide"}}, "plate_mm"),
        ({"print_params": {"road_mode": "airbrush"}}, "road_mode"),
        ({"print_params": {"nozzle_mm": 0.4, "gantry_mm": 3}}, "gantry_mm"),
    ],
)
def test_cli_reports_every_unusable_sidecar_shape_as_one_fail_row(
    baked, tmp_path, capsys, payload, expected
):
    target = _with_sidecar(baked, tmp_path, payload)

    code, out = run_cli(capsys, "validate", str(target))

    assert code == 1, out
    assert "sidecar params invalid" in out
    assert expected in out
    assert verdicts(out)["sidecar_params"] == "FAIL"


def test_cli_falls_back_to_the_command_line_overrides_when_the_sidecar_is_bad(
    baked, tmp_path, capsys
):
    """--plate-mm / --nozzle-mm still say what to judge the file against."""
    payload = _real_sidecar(baked)
    payload["print_params"]["base_thickness_mm"] = 99  # contract maximum is 8
    target = _with_sidecar(baked, tmp_path, payload)

    code, out = run_cli(capsys, "validate", str(target), "--plate-mm", "200")

    assert code == 1, out
    assert "parameters     command line" in out
    assert "plate 200 mm" in out
    assert verdicts(out)["sidecar_params"] == "FAIL"
    # 04 stage 4 still ran against the 200 mm plate the caller named.
    assert verdicts(out)["bounding_box"] == "PASS"


def test_cli_uses_an_override_that_repairs_the_offending_field(baked, tmp_path, capsys):
    """An override lands BEFORE validation, so it can make the sidecar legal."""
    payload = _real_sidecar(baked)
    payload["print_params"]["nozzle_mm"] = 99  # contract maximum is 1.2
    target = _with_sidecar(baked, tmp_path, payload)

    code, out = run_cli(capsys, "validate", str(target), "--nozzle-mm", "0.4")

    assert "sidecar params invalid" not in out
    assert "sidecar scratch.json + command line" in out
    assert "nozzle 0.4 mm" in out
    assert code == 0, out


def test_cli_keeps_reading_a_good_sidecar(baked, tmp_path, capsys):
    """The control: an untouched sidecar still sets the parameters, no row."""
    target = _with_sidecar(baked, tmp_path, _real_sidecar(baked))
    code, out = run_cli(capsys, "validate", str(target))
    assert code == 0, out
    assert "sidecar scratch.json" in out
    assert "sidecar_params" not in out
    assert "ALL CHECKS PASS" in out


def test_cli_rejects_an_override_the_contract_itself_forbids(baked, capsys):
    """A bad --plate-mm is a usage error (2), not a verdict about the file."""
    code = cli.main(["validate", str(baked), "--plate-mm", "5000"])
    captured = capsys.readouterr()
    assert code == 2
    assert "invalid override" in captured.err
    assert "plate_mm" in captured.err
    assert captured.out == ""


def test_cli_subprocess_prints_no_traceback_for_a_broken_sidecar(baked, tmp_path):
    """The literal command from the bug report, through a real process."""
    payload = _real_sidecar(baked)
    payload["print_params"]["plate_mm"] = 5000
    target = _with_sidecar(baked, tmp_path, payload)

    done = subprocess.run(
        [sys.executable, "-m", "app.cli", "validate", str(target)],
        cwd=SERVICE_ROOT,
        capture_output=True,
        text=True,
        timeout=600,
    )
    combined = done.stdout + done.stderr
    assert done.returncode == 1, combined
    assert "Traceback" not in combined
    assert "ValidationError" not in combined
    assert "sidecar params invalid" in done.stdout
    assert "FAILED: sidecar_params" in done.stdout
