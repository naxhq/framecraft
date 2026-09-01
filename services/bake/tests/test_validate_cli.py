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
#: Nothing here writes to ``artifacts/`` any more: every bake this suite judges
#: is one it made itself, under ``tmp_path`` (v2-07 audit, finding 1).

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
    # The summary line names the failing checks (the per-row "why" lines that
    # follow it are printed for every failure and are asserted below).
    summary = [line for line in out.splitlines() if line.startswith("FAILED:")]
    assert summary and "watertight" in summary[0]
    assert any(
        line.strip().startswith("watertight:") and "is_watertight=False" in line
        for line in out.splitlines()
    ), out


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


@pytest.fixture(scope="session")
def chicago_fixture_bake(tmp_path_factory) -> Path:
    """A FRESH Chicago bake at the contract defaults, in this session's tmp dir.

    Two things this must not be, and both have been tried:

    * a ``skipif`` on ``artifacts/chicago.3mf`` existing - that deleted G3's
      assertion from the suite on a clean clone, the machine where it is worth
      the most, and the gate accepts no skipped test (V2-P7);
    * a bake ``if not target.is_file()`` into ``artifacts/`` - that asserted
      about whatever bake happened to be lying there.  ``make bake-fixture
      PLATE=256`` used to write the same ``chicago.3mf`` stem at a NON-default
      plate, its sidecar said ``plate 256``, and the validator dutifully judged
      it against 256 and passed: "the default Chicago bake validates" measured
      about a file this tree did not make (v2-07 audit, finding 1).  Any
      surviving good artifact masked a pipeline regression.

    So: bake unconditionally, at ``PrintParams()`` defaults, into
    ``tmp_path_factory`` and never into ``artifacts/``.  The call is what ``make
    bake-fixture`` with no variables runs, offline from the committed Chicago
    Overpass fixture.  Session-scoped because it costs a real bake.
    """
    target = tmp_path_factory.mktemp("chicago-fixture-bake") / "chicago.3mf"
    code = cli.main(["bake", "--preset", "chicago-loop", "--out", str(target)])
    assert code == 0, "make bake-fixture (chicago-loop) failed"
    assert target.is_file()
    return target


def test_cli_passes_on_the_chicago_fixture_bake(chicago_fixture_bake, capsys):
    """G3's own command, kept green, on the bake this session just made."""
    code, out = run_cli(capsys, "validate", str(chicago_fixture_bake))
    assert code == 0, out
    assert "ALL CHECKS PASS" in out
    # The sidecar beside it is the one this bake wrote, so the table is judged
    # against the DEFAULT plate - the thing the old fixture could not promise.
    assert f"plate {PrintParams().plate_mm:g} mm" in out


def test_cli_fails_lettering_when_the_sidecar_asks_for_text_the_mesh_lacks(
    baked, tmp_path, capsys
):
    """v2-07 audit finding 2, through the shipped command.

    A mesh baked with NO text at all, judged against a sidecar that requests an
    engraving and the north arrow.  Every stroke measurement is 0.000 mm, no
    stroke is too thin because there is no stroke, and the row used to PASS on
    exactly that - which is what ``make gate-v2``'s ``lettering +PASS`` grep was
    accepting.  It must FAIL, and it must say how many pieces went missing.
    """
    target = tmp_path / "notext.3mf"
    shutil.copyfile(baked, target)
    payload = json.loads(baked.with_suffix(".json").read_text(encoding="utf-8"))
    payload["print_params"]["engravings"] = [
        {"edge": "top", "text": "CHICAGO", "size_mm": 6.0}
    ]
    payload["print_params"]["north_arrow"] = {
        "enabled": True,
        "corner": "ne",
        "size_mm": 4.0,
    }
    target.with_suffix(".json").write_text(json.dumps(payload), encoding="utf-8")

    code, out = run_cli(capsys, "validate", str(target))
    assert code == 1, out
    assert verdicts(out)["lettering"] == "FAIL"
    assert "measured 0 strokes" in out
    assert "the north arrow" in out and "engraving 1 (top)" in out
    assert "ALL CHECKS PASS" not in out

    # Non-vacuity: the untouched sidecar asks for no text, so there is no
    # `lettering` row at all and the same mesh passes.
    clean = _subprocess_validate(baked)
    assert clean.returncode == 0, clean.stdout + clean.stderr
    assert "lettering" not in verdicts(clean.stdout)


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


# --------------------------------------------------------------------------
# color_mode="parts": the multi-material package (PrintParams v2)
# --------------------------------------------------------------------------

#: The rows a parts file adds on top of STAGE4_CHECKS.  ``bodies`` is redefined
#: for this shape (one mesh object per part, no debris shell, and the assembled
#: union is still one connected solid) rather than dropped.
PARTS_CHECKS = (
    "bodies",
    "part_meshes",
    "3mf_color_mode",
    "3mf_parts",
    "3mf_unit",
    "3mf_objects",
    "3mf_build_items",
    "3mf_components",
    "3mf_materials",
    "3mf_attribution",
    "3mf_counts",
)


def _parts_scene() -> SceneGraph:
    """The single-colour scene plus a pond and a park, so the parts file has an
    inlay (water), an additive layer (green) and an engraved road."""
    from app.contracts import AreaFeature, Road, Tree

    base = _scene()
    return SceneGraph(
        bounds=base.bounds,
        center=base.center,
        buildings=base.buildings,
        roads=[Road(id="r1", path=[(-200.0, -30.0), (200.0, -30.0)], width_m=12.0, **{"class": "primary"})],
        water=[AreaFeature(ring=_square(120.0, -120.0, 90.0), holes=[])],
        green=[AreaFeature(ring=_square(-150.0, 120.0, 70.0), holes=[])],
        trees=[Tree(x=0.0, y=170.0, radius_m=12.0)],
        stats=base.stats,
    )


@pytest.fixture(scope="module")
def baked_parts(tmp_path_factory) -> Path:
    """A real parts bake: seven coloured objects in one 3MF, plus its sidecar."""
    out_dir = tmp_path_factory.mktemp("validate-cli-parts")
    request = SceneRequest(
        lat=41.8827, lon=-87.6233, radius_m=SYNTH_RADIUS_M, rotation_deg=0.0, preset_id=None
    )
    output = bake_pipeline.run_pipeline(
        _parts_scene(),
        request,
        PrintParams(color_mode="parts"),
        job_id="qagateparts",
        out_dir=out_dir,
        stem="qagateparts",
    )
    assert output.result.status == "done", output.result.error
    return out_dir / "qagateparts.3mf"


def rewrite_sidecar(path: Path, **updates) -> None:
    """Patch the ``print_params`` block of a bake sidecar in place."""
    sidecar = path.with_suffix(".json")
    payload = json.loads(sidecar.read_text(encoding="utf-8"))
    payload["print_params"].update(updates)
    sidecar.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def copy_bake(source: Path, target_dir: Path, stem: str) -> Path:
    """Copy a bake's .3mf and its sidecar so a corruption is local to one test."""
    target = target_dir / f"{stem}.3mf"
    shutil.copy(source, target)
    shutil.copy(source.with_suffix(".json"), target.with_suffix(".json"))
    return target


def test_cli_passes_on_a_parts_3mf(baked_parts, capsys):
    code, out = run_cli(capsys, "validate", str(baked_parts))
    assert code == 0, out
    assert "ALL CHECKS PASS" in out
    assert all(verdict == "PASS" for verdict in verdicts(out).values()), out
    # the header names the parts, so a human sees what was judged
    assert "parts          7:" in out
    assert "base, frame, buildings, roads, water, green, trees" in out


def test_cli_parts_table_lists_every_stage4_check_and_the_new_rows(baked_parts, capsys):
    _code, out = run_cli(capsys, "validate", str(baked_parts))
    table = rows(out)
    for name in STAGE4_CHECKS + PARTS_CHECKS:
        assert name in table, f"{name} missing from the parts table:\n{out}"
        verdict, value_and_threshold, _ = table[name]
        assert verdict in ("PASS", "FAIL")
        assert value_and_threshold, f"{name} printed no value/threshold"
    # ... and the union, not the concatenation, is what was judged
    assert "manifold3d union of the parts" in out


def test_cli_parts_rows_are_not_vacuous(baked_parts, capsys):
    """The new rows must report the real shape of this file, not constants."""
    _code, out = run_cli(capsys, "validate", str(baked_parts))
    table = rows(out)
    assert "7 parts" in table["bodies"][1]
    assert "7 entries" in table["3mf_materials"][1]
    assert "7 components" in table["3mf_components"][1]
    assert "7 mesh + 1 assembly" in table["3mf_objects"][1]
    assert "#2F7FC1FF" in table["3mf_materials"][1]  # the water filament


def test_cli_fails_when_the_sidecar_disagrees_with_the_file(baked_parts, tmp_path, capsys):
    copy = copy_bake(baked_parts, tmp_path, "disagree")
    rewrite_sidecar(copy, color_mode="single")
    code, out = run_cli(capsys, "validate", str(copy))
    assert code == 1
    assert verdicts(out)["3mf_color_mode"] == "FAIL"
    assert "one of the two is stale" in out


def test_cli_fails_a_single_file_whose_sidecar_claims_parts(baked, tmp_path, capsys):
    copy = copy_bake(baked, tmp_path, "claims-parts")
    rewrite_sidecar(copy, color_mode="parts")
    code, out = run_cli(capsys, "validate", str(copy))
    assert code == 1
    assert verdicts(out)["3mf_color_mode"] == "FAIL"


def test_cli_parts_mode_is_derived_from_the_file_even_without_a_sidecar(
    baked_parts, tmp_path, capsys
):
    target = tmp_path / "nosidecar.3mf"
    shutil.copy(baked_parts, target)
    code, out = run_cli(capsys, "validate", str(target), "--plate-mm", "180")
    assert "parts          7:" in out
    assert verdicts(out)["3mf_color_mode"] == "PASS"
    assert "file parts" in rows(out)["3mf_color_mode"][1]
    assert code == 0, out


def test_cli_fails_a_parts_file_whose_displaycolor_is_not_rgba8(
    baked_parts, tmp_path, capsys
):
    copy = copy_bake(baked_parts, tmp_path, "badcolor")
    rewrite_model_xml(
        copy, copy, lambda xml: xml.replace('displaycolor="#2F7FC1FF"', 'displaycolor="#2F7FC1"')
    )
    code, out = run_cli(capsys, "validate", str(copy))
    assert code == 1
    assert verdicts(out)["3mf_materials"] == "FAIL"
    assert "#RRGGBBAA" in out


def test_cli_fails_a_parts_file_with_a_pindex_out_of_range(baked_parts, tmp_path, capsys):
    copy = copy_bake(baked_parts, tmp_path, "badindex")
    rewrite_model_xml(copy, copy, lambda xml: xml.replace('pindex="0"', 'pindex="99"'))
    code, out = run_cli(capsys, "validate", str(copy))
    assert code == 1
    assert verdicts(out)["3mf_materials"] == "FAIL"
    assert "out of range" in out


def test_cli_fails_a_parts_file_with_a_missing_material_entry(
    baked_parts, tmp_path, capsys
):
    copy = copy_bake(baked_parts, tmp_path, "onefewer")
    rewrite_model_xml(
        copy, copy, lambda xml: xml.replace('<base name="trees" displaycolor="#5A9E4BFF"/>', "")
    )
    code, out = run_cli(capsys, "validate", str(copy))
    assert code == 1
    assert verdicts(out)["3mf_materials"] == "FAIL"
    assert "material entries for 7 parts" in out


def test_cli_fails_a_parts_file_with_a_dangling_component(baked_parts, tmp_path, capsys):
    copy = copy_bake(baked_parts, tmp_path, "dangling")
    rewrite_model_xml(
        copy, copy, lambda xml: xml.replace('<component objectid="2"/>', '<component objectid="404"/>')
    )
    code, out = run_cli(capsys, "validate", str(copy))
    assert code == 1
    assert verdicts(out)["3mf_components"] == "FAIL"
    assert "unknown object" in out


def test_cli_fails_a_parts_file_with_two_build_items(baked_parts, tmp_path, capsys):
    copy = copy_bake(baked_parts, tmp_path, "twobuilds")
    rewrite_model_xml(
        copy,
        copy,
        lambda xml: xml.replace("</build>", '<item objectid="2"/></build>'),
    )
    code, out = run_cli(capsys, "validate", str(copy))
    assert code == 1
    assert verdicts(out)["3mf_build_items"] == "FAIL"


def test_cli_fails_a_parts_file_with_a_floating_part(baked_parts, tmp_path, capsys):
    """04's single-body rule, in its parts form: the assembled union must still
    be one connected solid, so a part hovering above the plate is a failure."""
    import numpy as np

    copy = copy_bake(baked_parts, tmp_path, "floating")
    root, _ns = None, None
    with zipfile.ZipFile(copy) as zin:
        parts = {name: zin.read(name) for name in zin.namelist()}
    model = parts[mf3.MODEL_PART].decode("utf-8")
    cube = trimesh.creation.box(extents=(5.0, 5.0, 5.0))
    cube.apply_translation([0.0, 0.0, 40.0])
    extra_id = 99
    mesh_xml = (
        f'<object id="{extra_id}" name="floater" type="model" pid="1" pindex="0"><mesh>'
        + "<vertices>"
        + "".join(
            '<vertex x="%.12f" y="%.12f" z="%.12f"/>' % tuple(v) for v in cube.vertices
        )
        + "</vertices><triangles>"
        + "".join('<triangle v1="%d" v2="%d" v3="%d"/>' % tuple(f) for f in cube.faces)
        + "</triangles></mesh></object>"
    )
    model = model.replace("</resources>", mesh_xml + "</resources>")
    model = model.replace(
        "</components>", f'<component objectid="{extra_id}"/></components>'
    )
    # ... with its own material entry, so ONLY the bodies row can fail.
    model = model.replace(
        "</basematerials>", '<base name="floater" displaycolor="#FF00FFFF"/></basematerials>'
    )
    parts[mf3.MODEL_PART] = model.encode("utf-8")
    with zipfile.ZipFile(copy, "w", compression=zipfile.ZIP_DEFLATED) as zout:
        for name, payload in parts.items():
            zout.writestr(name, payload)

    code, out = run_cli(capsys, "validate", str(copy))
    assert code == 1
    assert verdicts(out)["bodies"] == "FAIL"
    assert "disconnected bodies" in out
    del np, root


def test_cli_exit_code_for_a_parts_file_through_a_real_subprocess(baked_parts):
    result = subprocess.run(
        [sys.executable, "-m", "app.cli", "validate", str(baked_parts)],
        cwd=SERVICE_ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ALL CHECKS PASS" in result.stdout
    assert "Traceback" not in result.stderr


# --------------------------------------------------------------------------
# v2-02 audit regressions: the component graph a slicer actually builds
# --------------------------------------------------------------------------


def test_cli_fails_a_parts_file_that_names_one_part_twice_and_another_never(
    baked_parts, tmp_path, capsys
):
    """The audit's finding 2: a count is not a check.

    ``<component objectid="2"/><component objectid="2"/>`` with one mesh object
    unreferenced is a file a slicer builds with two of one part and none of the
    other, and it used to pass every row - the component count still matched the
    part count.
    """
    copy = copy_bake(baked_parts, tmp_path, "duplicate-component")
    rewrite_model_xml(
        copy,
        copy,
        lambda xml: xml.replace(
            '<component objectid="3"/>', '<component objectid="2"/>', 1
        ),
    )
    code, out = run_cli(capsys, "validate", str(copy))
    assert code == 1
    assert verdicts(out)["3mf_components"] == "FAIL"
    assert "referenced more than once" in out
    assert "no component references" in out
    # ... and the mesh-side row fails too, because the count it compares against
    # is now the number of DISTINCT parts the assembly really builds.
    assert verdicts(out)["bodies"] == "FAIL"


def test_cli_judges_a_displaced_part_where_the_build_item_puts_it(
    baked_parts, tmp_path, capsys
):
    """The audit's finding 3, geometric half.

    trimesh keeps a component transform in ``scene.graph`` and leaves
    ``scene.geometry`` local, so a part translated 25 mm sideways used to be
    unioned in its own coordinates and read as one solid on the bed.  The parts
    are now PLACED first, so the rows that judge the assembled object see the
    object the slicer would build: two bodies, a bigger footprint than the plate,
    and a union that is not the single-mode solid.
    """
    copy = copy_bake(baked_parts, tmp_path, "displaced-part")
    rewrite_model_xml(
        copy,
        copy,
        lambda xml: xml.replace(
            '<component objectid="4"/>',
            '<component objectid="4" transform="1 0 0 0 1 0 0 0 1 200 0 0"/>',
            1,
        ),
    )
    code, out = run_cli(capsys, "validate", str(copy))
    assert code == 1
    table = verdicts(out)
    assert table["bodies"] == "FAIL", out
    assert table["bounding_box"] == "FAIL", out
    # ... and the header still names the parts in the file's own order
    assert "base, frame, buildings, roads, water, green, trees" in out


def test_cli_fails_a_parts_file_whose_component_carries_a_transform(
    baked_parts, tmp_path, capsys
):
    """The audit's finding 3: a displaced part validated as one solid.

    3MF lets a ``<component>`` carry a transform; FrameCraft's writer never
    emits one, and this validator judges the parts in their own coordinates, so
    a part translated 25 mm sideways used to read as a single body sitting on
    the bed.  A file that carries one is refused rather than mis-measured.
    """
    copy = copy_bake(baked_parts, tmp_path, "component-transform")
    rewrite_model_xml(
        copy,
        copy,
        lambda xml: xml.replace(
            '<component objectid="4"/>',
            '<component objectid="4" transform="1 0 0 0 1 0 0 0 1 25 0 0"/>',
            1,
        ),
    )
    code, out = run_cli(capsys, "validate", str(copy))
    assert code == 1
    assert verdicts(out)["3mf_components"] == "FAIL"
    assert "transform" in out and "25" in out
    # the row names the construct; the geometry rows above judge the placement


def test_cli_fails_a_parts_file_whose_build_item_carries_a_transform(
    baked_parts, tmp_path, capsys
):
    """Same reasoning one level up: a build-item transform moves the whole
    object off the bed, and ``sits_at_zero`` is measured on the geometry as
    authored."""
    copy = copy_bake(baked_parts, tmp_path, "item-transform")
    rewrite_model_xml(
        copy,
        copy,
        lambda xml: xml.replace(
            "<item objectid=", '<item transform="1 0 0 0 1 0 0 0 1 0 0 12" objectid=', 1
        ),
    )
    code, out = run_cli(capsys, "validate", str(copy))
    assert code == 1
    assert verdicts(out)["3mf_components"] == "FAIL"
    assert "build item carries transform" in out


def test_cli_accepts_an_explicit_identity_transform(baked_parts, tmp_path, capsys):
    """An identity matrix is not a displacement, and refusing one would fail a
    file that is exactly what FrameCraft writes."""
    copy = copy_bake(baked_parts, tmp_path, "identity-transform")
    rewrite_model_xml(
        copy,
        copy,
        lambda xml: xml.replace(
            '<component objectid="4"/>',
            '<component objectid="4" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
            1,
        ),
    )
    code, out = run_cli(capsys, "validate", str(copy))
    assert code == 0, out
    assert verdicts(out)["3mf_components"] == "PASS"


def test_container_transform_parsing_is_shared_and_strict():
    """The helper both rows use, pinned on its own."""
    from app.validate import container

    assert container.parse_transform(None) is None
    assert container.is_identity(None) is True
    assert container.is_identity(container.parse_transform("1 0 0 0 1 0 0 0 1 0 0 0"))
    assert not container.is_identity(container.parse_transform("1 0 0 0 1 0 0 0 1 25 0 0"))
    assert not container.is_identity(container.parse_transform("2 0 0 0 1 0 0 0 1 0 0 0"))
    # a malformed or short matrix is NOT quietly treated as the identity
    assert not container.is_identity(container.parse_transform("1 0 0"))
    assert not container.is_identity(container.parse_transform("a b c d e f g h i j k l"))


def test_cli_and_bake_run_the_same_container_functions():
    """Finding 5's remedy: one implementation, two callers.

    ``app/cli.py`` keeps its private names for readability, but they delegate to
    ``app/validate/container.py``, which is what the bake calls on the file it
    has just written.
    """
    from app import bake as bake_module
    from app import cli as cli_module
    from app.validate import container

    assert cli_module._threemf_parts_checks.__module__ == "app.cli"
    assert container.parts_checks is not None
    assert getattr(bake_module, "container") is container
    # the CLI's aliases really are thin: same rows, same order, on one file
    import inspect

    source = inspect.getsource(cli_module._threemf_parts_checks)
    assert "container.parts_checks(path, parts)" in source


@pytest.mark.parametrize(
    ("ceiling", "expected"),
    [
        (250.0, "250 mm"),
        (None, "60 mm"),
        ("tall", "60 mm"),
    ],
)
def test_cli_reads_the_height_ceiling_from_the_sidecar(
    baked, tmp_path, capsys, ceiling, expected
):
    """The bounding-box row is judged against the printer the bake names.

    A browser bake writes the resolved ``resolveProfile(params).maxHeightMm``
    into its sidecar as ``max_height_mm`` (DECISIONS ``[V3-P4-E9]``), so a 90 mm
    model made for a 250 mm machine validates honestly instead of failing
    against 04's reference 60.  A sidecar with no such key, or one carrying
    something that is not a positive number, leaves the 60 in place: a file that
    does not say what it was made for is judged as every file always was.
    """
    payload = _real_sidecar(baked)
    if ceiling is None:
        payload.pop("max_height_mm", None)
    else:
        payload["max_height_mm"] = ceiling
    target = _with_sidecar(baked, tmp_path, payload)

    code, out = run_cli(capsys, "validate", str(target))

    assert code == 0, out
    row = next(line for line in out.splitlines() if line.startswith("bounding_box"))
    assert expected in row
