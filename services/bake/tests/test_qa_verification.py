"""V2-P7 (qa-gate): independent verification of fixes qa-gate did not write.

This file is the *third pair of eyes*.  Every test here re-derives a claim from
something other than the code that makes the claim, and every one of them fails
on the behaviour that shipped before the fix it guards:

* the north arrow is measured **out of the finished solid** - a horizontal
  section through the frame lip of a real ``run_pipeline`` bake - and compared
  against true north derived from :mod:`app.geom.project`, never from
  ``transform.lettering_layout``.  The bug it catches (``-rotation_deg``) is due
  south at rotation 90 and 58 deg out at rotation 29.
* the hanger refusals are driven through ``POST /bake``, i.e. the path a user
  reaches, not through ``lettering.build`` directly.
* the v1 golden sidecar is fed to the real ``python -m app.cli validate``.
* the frame-off + emboss and the parts / text STLs are judged by the validator
  CLI on the **file that shipped**, not by the in-process report.

Everything runs offline from the committed fixtures (see ``conftest.py``).
"""
from __future__ import annotations

import json
import math
import shutil
from pathlib import Path

import pytest
import trimesh
from fastapi.testclient import TestClient
from shapely.geometry import Polygon

from app import bake as bake_pipeline
from app import cli
from app import main as main_module
from app.contracts import (
    Bounds,
    Building,
    Center,
    PrintParams,
    SceneGraph,
    SceneRequest,
    Stats,
)
from app.geom import lettering as L
from app.geom import transform as T
from app.ingest import normalize, overpass, presets
from app.validate import checks

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "fixtures"
GOLDEN_DIR = FIXTURES / "v1-golden"

#: UTM meridian convergence: true north is up to ~0.5 deg off grid north at the
#: presets, and no arrow drawn from a rotation angle alone can know that.  The
#: bug this guards against is 58 deg out, so the tolerance is not load bearing.
CONVERGENCE_TOLERANCE_DEG = 2.0

#: The rotation the brief names.  It is not a multiple of 180, so the sign of
#: the rotation is observable - which is the whole point.
ROTATION_DEG = 29.0


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def run_cli(capsys, *args: str) -> tuple[int, str]:
    """``python -m app.cli <args>`` in process; returns (exit code, stdout)."""
    code = cli.main(list(args))
    return code, capsys.readouterr().out


def rows(table: str) -> dict[str, tuple[str, str]]:
    """Parse the validator table into ``{check: (verdict, value+threshold)}``."""
    out: dict[str, tuple[str, str]] = {}
    for line in table.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[1] in ("PASS", "FAIL"):
            _head, _, tail = line.partition(parts[1])
            out[parts[0]] = (parts[1], tail.strip())
    return out


def _square(cx: float, cy: float, size: float) -> list[tuple[float, float]]:
    h = size / 2.0
    return [(cx - h, cy - h), (cx + h, cy - h), (cx + h, cy + h), (cx - h, cy + h)]


SYNTH_RADIUS_M = 250.0


def synthetic_scene() -> SceneGraph:
    """A two-building scene that bakes in a couple of seconds."""
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


def synthetic_request() -> SceneRequest:
    return SceneRequest(
        lat=41.8827, lon=-87.6233, radius_m=SYNTH_RADIUS_M, rotation_deg=0.0, preset_id=None
    )


def bake_synthetic(params: PrintParams, out_dir: Path, stem: str):
    return bake_pipeline.run_pipeline(
        synthetic_scene(),
        synthetic_request(),
        params,
        job_id=stem,
        out_dir=out_dir,
        stem=stem,
    )


@pytest.fixture(scope="module")
def client():
    with TestClient(main_module.app) as test_client:
        yield test_client


def poll(test_client: TestClient, job_id: str, timeout_s: float = 180.0):
    import time

    from app.contracts import BakeResult

    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        response = test_client.get(f"/bake/{job_id}")
        assert response.status_code == 200
        result = BakeResult(**response.json())
        if result.status in ("done", "failed"):
            return result
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not finish in {timeout_s} s")


# --------------------------------------------------------------------------
# (a) The north arrow, measured out of a real bake
# --------------------------------------------------------------------------


def true_north_bearing_deg(lat: float, lon: float, rotation_deg: float) -> float:
    """Where north lands on the plate, from ``project.py``'s convention alone.

    A point 0.01 deg due north of the centre is projected with the SAME
    :class:`~app.geom.project.LocalFrame` the ingest uses, and its plate-frame
    bearing (clockwise from +y) is read off.  Nothing in ``transform.py`` or
    ``lettering.py`` takes part, so an arrow that agrees with this agrees with
    the geometry the buildings were built from.
    """
    from app.geom.project import LocalFrame

    frame = LocalFrame(lat, lon, rotation_deg)
    x, y = frame.point_to_local(lon, lat + 0.01)
    return math.degrees(math.atan2(x, y)) % 360.0


def _arrow_recess_from_section(section: list[Polygon], plate_mm: float) -> Polygon:
    """The one hole in the frame band that is not the frame's inner opening."""
    band = [p for p in section if p.bounds[2] - p.bounds[0] > plate_mm * 0.9]
    assert len(band) == 1, f"expected one plate-wide section polygon, got {len(band)}"
    inner_side = plate_mm - 2.0 * T.FRAME_WIDTH_MM
    holes = [
        Polygon(ring)
        for ring in band[0].interiors
        if (Polygon(ring).bounds[2] - Polygon(ring).bounds[0]) < inner_side * 0.5
    ]
    assert len(holes) == 1, (
        f"expected exactly one small recess in the lip, found {len(holes)}: "
        f"{[h.bounds for h in holes]}"
    )
    return holes[0]


def _best_fit_bearing_deg(measured: Polygon, size_mm: float, ax: float, ay: float) -> float:
    """Compass bearing of the apex of the arrow recess ``measured``.

    A rotational alignment rather than a vertex pick: the recess has been
    dilated to a printable stroke and re-gridded, so no single vertex of it is
    "the apex" any more, but the shape's own axis survives all of that.  Coarse
    1 deg sweep, then 0.05 deg around the winner.

    ``lettering.place`` turns geometry COUNTERCLOCKWISE, so the glyph's apex -
    ``(0, +size/2)`` in its own frame - lands at compass bearing
    ``-rotation_deg`` (bearings run clockwise from +y, i.e. ``atan2(x, y)``).
    The returned number is the BEARING, so it can be compared with
    :func:`true_north_bearing_deg` without either side knowing the other's
    convention.
    """
    nominal = L.north_arrow_polygon(size_mm)

    def iou(theta: float) -> float:
        ref = L.place(nominal, ax, ay, theta)
        inter = measured.intersection(ref).area
        union = measured.union(ref).area
        return inter / union if union > 0.0 else 0.0

    coarse = max(range(360), key=lambda d: iou(float(d)))
    best, best_score = float(coarse), iou(float(coarse))
    step = 0.05
    theta = coarse - 1.0
    while theta <= coarse + 1.0 + 1e-9:
        score = iou(theta)
        if score > best_score:
            best, best_score = theta, score
        theta += step
    assert best_score > 0.4, (
        f"no rotation of the nominal arrow covers the recess (best IoU {best_score:.3f} "
        f"at {best:.2f} deg) - is the cut in the lip actually the north arrow?"
    )
    # place() is counterclockwise; a compass bearing is clockwise from +y.
    return (-best) % 360.0


def test_v2_north_arrow_in_a_real_bake_points_where_project_py_puts_north(tmp_path):
    """Chicago, baked at rotation 29, with the arrow read out of the solid.

    The measurement never touches ``lettering_layout``: the recess is lifted
    from a horizontal section of the exported ``.3mf`` and matched against the
    nominal arrow glyph by rotational alignment, and the expectation comes from
    ``project.LocalFrame``.  The shipped bug turned the arrow by
    ``-rotation_deg``, i.e. 58 deg out here, which this fails on by 56 deg.
    """
    scene_request = presets.PRESETS_BY_ID["chicago-loop"].request()
    raw = overpass.load_raw(scene_request, allow_network=False)
    scene = normalize.build_scene(raw, scene_request)
    rotated = scene_request.model_copy(update={"rotation_deg": ROTATION_DEG})

    params = PrintParams(north_arrow={"enabled": True, "corner": "ne", "size_mm": 4.0})
    out = bake_pipeline.run_pipeline(
        scene, rotated, params, job_id="arrow29", out_dir=tmp_path, stem="arrow29"
    )
    assert out.result.status == "done", out.result.error
    assert not any("north arrow was reduced" in w for w in out.result.warnings), (
        "4 mm is under the lip's cap, so the size used is the size asked for"
    )

    mesh = trimesh.load(tmp_path / "arrow29.3mf", force="mesh", process=False)
    plate = float(params.plate_mm)
    lip_top = T.base_top_mm(params) + T.FRAME_LIP_MM
    section = checks.section_polygons(mesh, lip_top - T.ENGRAVE_MAX_MM / 2.0)
    recess = _arrow_recess_from_section(section, plate)

    offset = plate / 2.0 - T.FRAME_WIDTH_MM / 2.0  # the "ne" corner of the band
    measured = _best_fit_bearing_deg(recess, 4.0, offset, offset)
    expected = true_north_bearing_deg(
        scene.center.lat, scene.center.lon, ROTATION_DEG
    )
    error = abs((measured - expected + 180.0) % 360.0 - 180.0)
    print(
        f"\n[qa] north arrow at rotation {ROTATION_DEG}: cut at {measured:.2f} deg, "
        f"project.py puts true north at {expected:.2f} deg (error {error:.2f} deg)"
    )
    assert error <= CONVERGENCE_TOLERANCE_DEG, (
        f"the arrow cut into the lip points {measured:.2f} deg but true north is "
        f"{expected:.2f} deg"
    )
    # ... and the wrong sign really is wrong, so the test is not vacuous.
    wrong = abs((measured + expected + 180.0) % 360.0 - 180.0)
    assert wrong > 10.0 * CONVERGENCE_TOLERANCE_DEG, (
        "rotation 29 must distinguish +rotation from -rotation"
    )


# --------------------------------------------------------------------------
# (b) Frame off + an embossed engraving: one body in the file that ships
# --------------------------------------------------------------------------


def test_v2_frame_off_with_an_emboss_ships_one_body_in_the_stl_the_bake_wrote(
    tmp_path, capsys
):
    """The complement of ``test_bake_with_the_frame_off_ships_no_floating_letters``.

    That test reads the in-process report; this one runs the shipped validator
    CLI over the ``.stl`` and the ``.3mf`` on disk, which is what a user gets.
    The pre-fix behaviour put an embossed "CHICAGO" 1.8 mm above a plate with no
    lip: a second, disconnected body in both files.
    """
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
    out = bake_synthetic(params, tmp_path, "frameoff")
    assert out.result.status == "done", out.result.error

    # The documented refusal, once, naming the remedy.
    notices = [w for w in out.result.warnings if "the frame is off" in w]
    assert len(notices) == 1 and "turn the frame on" in notices[0], out.result.warnings

    for suffix in (".3mf", ".stl"):
        code, table = run_cli(capsys, "validate", str(tmp_path / f"frameoff{suffix}"))
        parsed = rows(table)
        assert code == 0, table
        assert "ALL CHECKS PASS" in table
        assert parsed["bodies"][0] == "PASS", table
        assert parsed["bodies"][1].startswith("1 "), (
            f"{suffix} is not a single body: {parsed['bodies'][1]}"
        )


# --------------------------------------------------------------------------
# (d) The hanger refusals, through POST /bake
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "hanger,base_mm,minimum_mm",
    # The minima are spelled out rather than read back from `transform.py`:
    #   keyhole  2.0 mm pocket + 1.0 mm roof + 0.6 mm engraved roads = 3.6 mm
    #   magnets  3.1 mm pocket + 1.0 mm roof + 0.6 mm engraved roads = 4.7 mm
    # (the default `road_mode` is `engrave`, which takes 0.6 mm off the top of
    # the same plate the pocket is cut into from below).
    [("keyhole", 2.9, 3.6), ("magnets", 4.0, 4.7)],
)
def test_v2_api_refuses_a_hanger_the_base_cannot_carry(
    client, hanger, base_mm, minimum_mm
):
    """``status: failed``, the minimum named, and ``files`` null.

    A 2 mm keyhole (or a 3.1 mm magnet pocket) needs 1 mm of plate over it or it
    is a hole through the picture.  The bake refuses on arithmetic before it
    builds anything, so this costs no geometry - and it must reach the USER as a
    failed job with a message, never as a 500 or as a shipped file.
    """
    body = {
        "scene_request": presets.PRESETS_BY_ID["chicago-loop"]
        .request()
        .model_dump(mode="json"),
        "print_params": PrintParams(
            hanger=hanger, base_thickness_mm=base_mm
        ).model_dump(mode="json"),
    }
    response = client.post("/bake", json=body)
    assert response.status_code == 202
    result = poll(client, response.json()["job_id"])

    assert result.status == "failed", result.error
    assert result.files is None
    assert result.error is not None
    assert f"at least {minimum_mm:g} mm" in result.error, result.error
    assert f"{base_mm:g} mm" in result.error, result.error
    assert hanger in result.error, result.error


@pytest.mark.parametrize("hanger,base_mm", [("keyhole", 3.6), ("magnets", 4.7)])
def test_v2_the_hanger_refusal_is_not_vacuous_at_the_minimum(tmp_path, hanger, base_mm):
    """At exactly the minimum the same bake succeeds and passes every row.

    Without this the refusals above would be satisfied by a bake that refuses
    every hanger.
    """
    out = bake_synthetic(
        PrintParams(hanger=hanger, base_thickness_mm=base_mm),
        tmp_path,
        f"hanger-{hanger}",
    )
    assert out.result.status == "done", out.result.error
    assert all(check.passed for check in out.report.checks), [
        c.name for c in out.report.checks if not c.passed
    ]


# --------------------------------------------------------------------------
# (e) A v1 sidecar through the real validator CLI
# --------------------------------------------------------------------------


def test_v2_the_v1_golden_sidecar_still_validates_the_v1_golden_3mf(tmp_path, capsys):
    """``make validate`` on a file baked before PrintParams grew its v2 fields.

    ``fixtures/v1-golden/chicago-default.sidecar.json`` has eleven fields and no
    ``schema_version``; the v2 model has to read it, default the rest, and judge
    the mesh against the 180 mm plate it names.  A ``sidecar_params`` FAIL here
    would mean every 3MF a user baked before this run became unvalidatable.
    """
    target = tmp_path / "v1golden.3mf"
    shutil.copy(GOLDEN_DIR / "chicago-default.3mf", target)
    shutil.copy(GOLDEN_DIR / "chicago-default.sidecar.json", target.with_suffix(".json"))

    # The sidecar really is a v1 one: no schema_version, none of the v2 fields.
    payload = json.loads(target.with_suffix(".json").read_text(encoding="utf-8"))
    v1_params = payload["print_params"]
    assert "schema_version" not in v1_params
    for field in ("engravings", "north_arrow", "hanger", "color_mode", "city_label"):
        assert field not in v1_params, f"{field} is a v2 field; this is not a v1 sidecar"

    code, table = run_cli(capsys, "validate", str(target))
    parsed = rows(table)
    assert "sidecar_params" not in parsed or parsed["sidecar_params"][0] == "PASS", table
    assert "sidecar v1golden.json" in table, table
    assert "plate 180 mm" in table, table
    assert code == 0, table
    assert "ALL CHECKS PASS" in table


# --------------------------------------------------------------------------
# (f) Both v2 export modes still write a single-body STL the validator accepts
# --------------------------------------------------------------------------


def test_v2_parts_mode_and_text_mode_both_write_a_single_body_stl(tmp_path, capsys):
    """04 says the ``.stl`` is one welded solid whatever the 3MF looks like.

    ``COLOR=parts`` writes seven 3MF objects and ``TEXT=all`` cuts the lip; the
    STL beside either must still load as one body and pass every stage 4 row.
    The gate runs the same two assertions on the real Chicago artifacts
    (``make gate-v2``); this is the fast, hermetic version of them.
    """
    cases = {
        "parts": PrintParams(color_mode="parts"),
        "text": PrintParams(
            city_label="Chicago",
            base_thickness_mm=4.0,
            engravings=[
                {"edge": "top", "text": "{city}", "size_mm": 6.0, "font": "sans"},
                {
                    "edge": "right",
                    "text": "2026",
                    "size_mm": 6.0,
                    "font": "sans",
                    "mode": "emboss",
                },
            ],
            north_arrow={"enabled": True, "corner": "ne", "size_mm": 4.0},
            scale_bar={"enabled": True, "edge": "bottom", "length_mode": "auto"},
            hanger="keyhole",
            underside_mark={"enabled": True, "template": "{city} {scale} {date}"},
        ),
    }
    for stem, params in cases.items():
        out = bake_synthetic(params, tmp_path, stem)
        assert out.result.status == "done", f"{stem}: {out.result.error}"
        code, table = run_cli(capsys, "validate", str(tmp_path / f"{stem}.stl"))
        parsed = rows(table)
        assert code == 0, f"{stem} stl:\n{table}"
        assert "ALL CHECKS PASS" in table, f"{stem} stl:\n{table}"
        assert parsed["bodies"] == ("PASS", parsed["bodies"][1])
        assert parsed["bodies"][1].startswith("1 "), f"{stem} stl: {parsed['bodies'][1]}"
        # ...and the 3MF beside it, in whatever structure the mode asked for.
        code, table = run_cli(capsys, "validate", str(tmp_path / f"{stem}.3mf"))
        assert code == 0, f"{stem} 3mf:\n{table}"
        assert "ALL CHECKS PASS" in table, f"{stem} 3mf:\n{table}"

    # The two modes really did produce different packages, or the STL claim
    # above would be about one file twice.
    assert cli._threemf_is_parts(tmp_path / "parts.3mf")
    assert not cli._threemf_is_parts(tmp_path / "text.3mf")
