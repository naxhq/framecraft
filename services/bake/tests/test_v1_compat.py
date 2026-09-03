"""G8: a default-constructed v2 PrintParams still bakes the v1 model, exactly.

``fixtures/v1-golden/`` was produced from a clean ``git worktree`` of commit
da9ab83 - the v1 tree, before any v2 edit existed - by running the same command
``make bake-fixture`` runs::

    uv run python -m app.cli bake --preset chicago-loop --out ../../artifacts/chicago.3mf

so it is an independent reference, not a re-recording of whatever the working
tree happened to produce.  Committed alongside the digest is the whole 645 kB
``.3mf``, so a future mismatch can be diffed rather than merely reported.

"Byte-identical" is literal here.  The canonical geometry digest is the sha256
of the exact text of the ``<vertices>...</vertices>`` element followed by the
``<triangles>...</triangles>`` element of ``3D/3dmodel.model`` - the two
elements that ARE the mesh - so a reordered triangle, a flipped winding or a
one-ulp coordinate change all move it.

Three tests:

(a) the current pipeline, driven through ``bake.run_pipeline`` (the same public
    entry ``POST /bake`` uses) on the Chicago preset at ``PrintParams()``,
    reproduces the golden digest, triangle count and volume;
(b) the committed v1 sidecar's ``print_params`` block loads through the v2
    model, equals ``PrintParams()`` and validates against the v2 schema;
(c) the 3MF this tree writes in single mode is the golden's model XML byte for
    byte outside ``<metadata>``, and inside it differs only where it must -
    ``CreationDate`` (today's date) and the ``Description``'s PrintParams
    recital, which gains the v2 keys at their defaults and changes no v1 pair
    (DECISIONS [V2-P2]).  This pins Task 2's "single mode stays byte for byte"
    before parts export is written.

Offline throughout: the preset's Overpass response is a committed fixture and
``allow_network=False`` is passed explicitly.

Run it with::

    cd services/bake && uv run pytest tests/test_v1_compat.py
"""
from __future__ import annotations

import hashlib
import json
import re
import zipfile
from pathlib import Path

import jsonschema
import pytest

from app import bake as bake_pipeline
from app.contracts import PrintParams
from app.ingest import normalize, overpass, presets

REPO_ROOT = Path(__file__).resolve().parents[3]
GOLDEN_DIR = REPO_ROOT / "fixtures" / "v1-golden"
GOLDEN_JSON = GOLDEN_DIR / "chicago-default.json"
GOLDEN_SIDECAR = GOLDEN_DIR / "chicago-default.sidecar.json"
GOLDEN_3MF = GOLDEN_DIR / "chicago-default.3mf"
PRINT_PARAMS_SCHEMA = REPO_ROOT / "packages" / "contracts" / "schema" / "print_params.json"

MODEL_PART = "3D/3dmodel.model"


# ---------------------------------------------------------------------------
# the canonical digest
# ---------------------------------------------------------------------------


def model_xml(path: Path) -> str:
    """The ``3D/3dmodel.model`` document of a 3MF package, as text."""
    with zipfile.ZipFile(path) as zf:
        return zf.read(MODEL_PART).decode("utf-8")


def element_text(xml: str, tag: str) -> str:
    """The exact source text of ``<tag>...</tag>``, opening and closing tags
    included.  Deliberately textual: a parse-and-recompare would normalise away
    exactly the formatting differences this test exists to catch."""
    start = xml.index(f"<{tag}>")
    end = xml.index(f"</{tag}>") + len(f"</{tag}>")
    return xml[start:end]


def geometry_digest(xml: str) -> str:
    """sha256 over the vertices element followed by the triangles element."""
    payload = element_text(xml, "vertices") + element_text(xml, "triangles")
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def golden() -> dict:
    return json.loads(GOLDEN_JSON.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def golden_xml() -> str:
    return model_xml(GOLDEN_3MF)


@pytest.fixture(scope="module")
def baked(tmp_path_factory) -> dict:
    """One bake of the Chicago preset at the v2 defaults, shared by the tests.

    Goes through ``bake.run_pipeline`` - the same call ``POST /bake``'s job
    worker and the CLI both make - so nothing about this test's path is
    special-cased.
    """
    request = presets.get_preset("chicago-loop").request()
    raw = overpass.load_raw(request, allow_network=False)
    scene = normalize.build_scene(raw, request)
    out_dir = tmp_path_factory.mktemp("v1compat")
    output = bake_pipeline.run_pipeline(
        scene,
        request,
        PrintParams(),
        job_id="chicago",
        out_dir=out_dir,
        stem="chicago",
    )
    path = out_dir / "chicago.3mf"
    return {"output": output, "path": path, "xml": model_xml(path)}


# ---------------------------------------------------------------------------
# (a) geometry
# ---------------------------------------------------------------------------


def test_default_v2_params_reproduce_the_v1_geometry_digest(baked, golden):
    assert geometry_digest(baked["xml"]) == golden["geometry_digest"]["sha256"]


def test_default_v2_params_reproduce_the_v1_triangle_and_vertex_counts(baked, golden):
    stats = baked["output"].result.stats
    assert stats is not None
    assert stats.triangles == golden["triangles"]
    assert baked["xml"].count("<vertex ") == golden["vertices"]


def test_default_v2_params_reproduce_the_v1_volume_and_min_wall(baked, golden):
    stats = baked["output"].result.stats
    assert stats.volume_mm3 == golden["volume_mm3"]
    assert stats.min_wall_mm == golden["min_wall_mm"]
    assert list(stats.bbox_mm) == list(golden["bbox_mm"])


def test_default_v2_params_reproduce_the_v1_warnings(baked, golden):
    assert list(baked["output"].result.warnings) == list(golden["warnings"])


def test_the_bake_still_passes_every_validator(baked):
    report = baked["output"].report
    assert report is not None and report.passed, [c.name for c in report.checks if not c.passed]


# ---------------------------------------------------------------------------
# (b) the v1 sidecar loads through the v2 model
# ---------------------------------------------------------------------------


def test_the_v1_sidecar_print_params_load_and_equal_the_v2_defaults():
    sidecar = json.loads(GOLDEN_SIDECAR.read_text(encoding="utf-8"))
    v1_params = sidecar["print_params"]
    # It really is a v1 block: none of the v2 or v3 keys are in it.
    assert "schema_version" not in v1_params
    assert set(v1_params) == set(PrintParams().model_dump().keys()) - {
        # v2 (schema_version 2)
        "schema_version",
        "city_label",
        "color_mode",
        "part_colors",
        "engravings",
        "north_arrow",
        "scale_bar",
        "hanger",
        "underside_mark",
        "hero_building_ids",
        "hero_mode",
        # v3 (schema_version 3), [V3-P1c]: this Python model default is now 3,
        # not 2, but the golden sidecar is still a genuine v1 payload and must
        # still load to exactly PrintParams() - the extra fourteen keys just
        # widen the same "carries none of them" claim.
        "place",
        "regions",
        "colour",
        "printer_profile",
        "custom_profile",
        "export_target",
        "terrain",
        "heights",
        "bridges",
        "height_exaggeration",
        "hero_auto",
        "tiling",
        "frame_style",
        "hanger_magnet",
        # v4 (schema_version 4), [V3.1-O4]: the per-object overrides the
        # right-click inspector writes. Empty by default, so the same "carries
        # none of them and still loads to exactly PrintParams()" claim holds.
        "object_overrides",
        # v4, Task 12: the surface labels the viewport places. Empty by
        # default for the same reason (docs/handoff/v3-12-labels.md).
        "labels",
    }
    assert PrintParams(**v1_params) == PrintParams()


def test_the_v1_sidecar_print_params_validate_against_the_v2_schema():
    sidecar = json.loads(GOLDEN_SIDECAR.read_text(encoding="utf-8"))
    schema = json.loads(PRINT_PARAMS_SCHEMA.read_text(encoding="utf-8"))
    jsonschema.validate(instance=sidecar["print_params"], schema=schema)


def test_a_v1_bake_request_body_is_still_accepted_at_the_api_boundary():
    """The wire, not just the model: ``POST /bake``'s body model must take a v1
    client's payload unchanged.  ``extra="forbid"`` makes the opposite mistake
    loud, so this pins the direction that would fail silently."""
    from app.main import BakeRequest

    sidecar = json.loads(GOLDEN_SIDECAR.read_text(encoding="utf-8"))
    body = BakeRequest(
        scene_request=sidecar["scene_request"], print_params=sidecar["print_params"]
    )
    assert body.print_params == PrintParams()
    # ...and a body that omits print_params entirely means the same thing.
    assert BakeRequest(scene_request=sidecar["scene_request"]).print_params == PrintParams()


# ---------------------------------------------------------------------------
# (c) the 3MF is byte-identical outside the metadata block
# ---------------------------------------------------------------------------

_METADATA_RE = re.compile(r"<metadata name=\"([^\"]+)\">(.*?)</metadata>", re.DOTALL)


def split_metadata(xml: str) -> tuple[str, dict[str, str]]:
    """(document with every metadata element removed, {name: value})."""
    meta = {m.group(1): m.group(2) for m in _METADATA_RE.finditer(xml)}
    return _METADATA_RE.sub("", xml), meta


#: A key boundary in the Description's ``k=v k=v`` recital: a space followed by
#: a snake_case name and an "=".  Splitting on plain spaces would not do - the
#: v2 values include dict reprs ("part_colors={'base': '#D8D3C6', ...}") that
#: contain spaces of their own, and those reprs use ": ", never " word=".
_RECITAL_BOUNDARY = re.compile(r" (?=[a-z_]+=)")


def params_recital(description: str) -> dict[str, str]:
    """The ``PrintParams: k=v k=v ...`` tail of the Description metadata, as a
    mapping.  ``mf3.build_metadata`` sorts the keys and joins them with spaces."""
    tail = description.split("PrintParams: ", 1)[1].rstrip(".")
    pairs = {}
    for token in _RECITAL_BOUNDARY.split(tail):
        key, _, value = token.partition("=")
        pairs[key] = value
    return pairs


def test_single_mode_writes_the_v1_geometry_xml_byte_for_byte(baked, golden_xml):
    """Everything outside <metadata> - the model element, the resources, the
    mesh, the build item - must be identical text."""
    now_body, _ = split_metadata(baked["xml"])
    gold_body, _ = split_metadata(golden_xml)
    assert now_body == gold_body


def test_single_mode_changes_no_metadata_except_creationdate_and_description(
    baked, golden_xml
):
    _, now_meta = split_metadata(baked["xml"])
    _, gold_meta = split_metadata(golden_xml)
    assert list(now_meta) == list(gold_meta)
    differing = {k for k in gold_meta if now_meta[k] != gold_meta[k]}
    assert differing <= {"CreationDate", "Description"}
    for name in ("Title", "Designer", "Copyright", "LicenseTerms", "Application"):
        assert now_meta[name] == gold_meta[name]


def test_the_description_gains_only_the_v2_defaults(baked, golden_xml):
    """The Description recites the PrintParams, so a v2+v3 model necessarily
    adds keys to it.  Nothing else about it may move: the prose, the
    attribution and the location must match, and every v1 key must keep its
    v1 value."""
    _, now_meta = split_metadata(baked["xml"])
    _, gold_meta = split_metadata(golden_xml)
    now_desc, gold_desc = now_meta["Description"], gold_meta["Description"]
    assert now_desc.split("PrintParams: ")[0] == gold_desc.split("PrintParams: ")[0]

    now_pairs = params_recital(now_desc)
    gold_pairs = params_recital(gold_desc)
    assert {k: now_pairs[k] for k in gold_pairs} == gold_pairs
    added = set(now_pairs) - set(gold_pairs)
    assert added == {
        # v2 (schema_version 2)
        "schema_version",
        "city_label",
        "color_mode",
        "part_colors",
        "engravings",
        "north_arrow",
        "scale_bar",
        "hanger",
        "underside_mark",
        "hero_building_ids",
        "hero_mode",
        # v3 (schema_version 3), [V3-P1c]
        "place",
        "regions",
        "colour",
        "printer_profile",
        "custom_profile",
        "export_target",
        "terrain",
        "heights",
        "bridges",
        "height_exaggeration",
        "hero_auto",
        "tiling",
        "frame_style",
        "hanger_magnet",
        # v4 (schema_version 4), [V3.1-O4]
        "object_overrides",
        # v4, Task 12 surface labels
        "labels",
    }
