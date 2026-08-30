"""Contract-freeze tests for packages/contracts/.

(a) The two generators are deterministic: regenerating into a temp dir
    produces output byte-identical to the committed generated files.
(b) fixtures/chicago-scene.json validates against schema/scene_graph.json.
(c) The example JSON objects from 02_TECH_SPEC.md round-trip through the
    generated Pydantic models (enum/status "a|b|c" placeholders in the spec
    prose are resolved to one concrete member; everything else matches the
    spec verbatim).
(d) The generated Pydantic models agree with the JSON Schema on every
    numeric/array bound: an out-of-range instance rejected by jsonschema is
    rejected by the model too.
(e) Default (non-alias) serialization emits the contract's own key names
    ("3mf", "class"), so a caller that forgets by_alias=True still writes
    contract-shaped JSON.
"""
from __future__ import annotations

import copy
import importlib.util
import json
import tempfile
from pathlib import Path

import jsonschema
import pytest
from pydantic import ValidationError

from app import contracts

REPO_ROOT = Path(__file__).resolve().parents[3]
CONTRACTS_DIR = REPO_ROOT / "packages" / "contracts"
SCHEMA_DIR = CONTRACTS_DIR / "schema"
COMMITTED_PY = REPO_ROOT / "services" / "bake" / "app" / "contracts.py"
COMMITTED_TS = REPO_ROOT / "apps" / "web" / "lib" / "contracts.ts"
FIXTURE = REPO_ROOT / "fixtures" / "chicago-scene.json"


def _load_generator(name: str):
    spec = importlib.util.spec_from_file_location(name, CONTRACTS_DIR / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# (a) generators are deterministic and match the committed output
# ---------------------------------------------------------------------------


def test_gen_py_matches_committed_output():
    gen_py = _load_generator("gen_py")
    with tempfile.TemporaryDirectory() as tmp:
        out_path = Path(tmp) / "contracts.py"
        out_path.write_text(gen_py.generate(), encoding="utf-8", newline="\n")
        assert out_path.read_text(encoding="utf-8") == COMMITTED_PY.read_text(encoding="utf-8")


def test_gen_ts_matches_committed_output():
    gen_ts = _load_generator("gen_ts")
    with tempfile.TemporaryDirectory() as tmp:
        out_path = Path(tmp) / "contracts.ts"
        out_path.write_text(gen_ts.generate(), encoding="utf-8", newline="\n")
        assert out_path.read_text(encoding="utf-8") == COMMITTED_TS.read_text(encoding="utf-8")


def test_generators_are_idempotent():
    """Running a generator twice produces identical output (no timestamps,
    no unstable ordering)."""
    gen_py = _load_generator("gen_py")
    gen_ts = _load_generator("gen_ts")
    assert gen_py.generate() == gen_py.generate()
    assert gen_ts.generate() == gen_ts.generate()


# ---------------------------------------------------------------------------
# (b) fixtures/chicago-scene.json validates against scene_graph.json
# ---------------------------------------------------------------------------


def test_chicago_fixture_validates_against_scene_graph_schema():
    schema = json.loads((SCHEMA_DIR / "scene_graph.json").read_text(encoding="utf-8"))
    instance = json.loads(FIXTURE.read_text(encoding="utf-8"))
    jsonschema.validate(instance=instance, schema=schema)


@pytest.mark.parametrize(
    "schema_name",
    ["scene_request.json", "scene_graph.json", "print_params.json", "bake_result.json"],
)
def test_schema_files_are_valid_draft_2020_12(schema_name):
    schema = json.loads((SCHEMA_DIR / schema_name).read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator.check_schema(schema)
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert "title" in schema and "$id" in schema


# ---------------------------------------------------------------------------
# (c) 02_TECH_SPEC.md example objects round-trip through the Pydantic models
# ---------------------------------------------------------------------------

SCENE_REQUEST_EXAMPLE = {
    "lat": 41.8827,
    "lon": -87.6233,
    "radius_m": 900,
    "rotation_deg": 0,
    "preset_id": "chicago-loop",
}

# The 02 example's "ring": [[x,y], ...] / "path": [[x,y], ...] are prose
# placeholders, not valid JSON; filled in here with concrete closed rings.
# "tag|levels|default" / "motorway|primary|..." / "good|sparse|empty" are
# the enum's allowed members listed inline, not a literal value; resolved
# to one concrete member each.
SCENE_GRAPH_EXAMPLE = {
    "bounds": {"min_x": -900, "min_y": -900, "max_x": 900, "max_y": 900},
    "center": {"lat": 41.8827, "lon": -87.6233},
    "buildings": [
        {
            "id": "w123",
            "ring": [[0.0, 0.0], [20.0, 0.0], [20.0, 15.0], [0.0, 15.0]],
            "holes": [],
            "height_m": 92.0,
            "height_source": "tag",
            "min_height_m": 0.0,
            "is_tall": True,
        }
    ],
    "roads": [
        {
            "id": "w456",
            "path": [[-50.0, 0.0], [50.0, 0.0]],
            "width_m": 12.0,
            "class": "primary",
        }
    ],
    "water": [
        {"ring": [[100.0, 100.0], [120.0, 100.0], [120.0, 120.0], [100.0, 120.0]], "holes": []}
    ],
    "green": [
        {"ring": [[-120.0, -120.0], [-100.0, -120.0], [-100.0, -100.0], [-120.0, -100.0]], "holes": []}
    ],
    "trees": [{"x": 12.4, "y": -88.1, "radius_m": 4.0}],
    "stats": {"building_count": 1841, "coverage": "good", "height_tag_ratio": 0.34},
}

PRINT_PARAMS_EXAMPLE = {
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

# status placeholder "queued|running|done|failed" resolved to "done" since
# files/stats are populated, matching a completed job; progress/error are
# the ADDITIVE fields (DECISIONS.md) and default to null when unset.
BAKE_RESULT_EXAMPLE = {
    "job_id": "ab12",
    "status": "done",
    "files": {"3mf": "/files/ab12.3mf", "stl": "/files/ab12.stl"},
    "stats": {
        "triangles": 412330,
        "volume_mm3": 39122.5,
        "bbox_mm": [180, 180, 41.2],
        "est_grams": 48.6,
        "is_manifold": True,
        "min_wall_mm": 0.81,
    },
    "warnings": ["47 buildings widened to meet minimum feature size"],
    "progress": None,
    "error": None,
}


def test_scene_request_round_trips():
    obj = contracts.SceneRequest(**SCENE_REQUEST_EXAMPLE)
    assert obj.model_dump(mode="json") == SCENE_REQUEST_EXAMPLE


def test_scene_graph_round_trips():
    obj = contracts.SceneGraph(**SCENE_GRAPH_EXAMPLE)
    assert obj.model_dump(mode="json", by_alias=True) == SCENE_GRAPH_EXAMPLE
    # is_tall is defined as height_m >= 40 (02_TECH_SPEC.md); keep the
    # fixture internally consistent even though the model does not enforce
    # the cross-field rule itself (geo-ingest computes it once, upstream).
    assert obj.buildings[0].is_tall == (obj.buildings[0].height_m >= 40)


def test_print_params_round_trips():
    obj = contracts.PrintParams(**PRINT_PARAMS_EXAMPLE)
    assert obj.model_dump(mode="json") == PRINT_PARAMS_EXAMPLE


def test_bake_result_round_trips():
    obj = contracts.BakeResult(**BAKE_RESULT_EXAMPLE)
    assert obj.model_dump(mode="json", by_alias=True) == BAKE_RESULT_EXAMPLE


def test_bake_result_queued_has_null_files_and_stats():
    obj = contracts.BakeResult(job_id="ab12", status="queued", warnings=[])
    assert obj.files is None
    assert obj.stats is None
    assert obj.progress is None
    assert obj.error is None


def test_additional_properties_are_rejected():
    with pytest.raises(Exception):
        contracts.PrintParams(**PRINT_PARAMS_EXAMPLE, extra_field_not_in_schema=True)


# ---------------------------------------------------------------------------
# (d) schema bounds and Pydantic bounds agree
# ---------------------------------------------------------------------------

VALID_EXAMPLES = [
    ("scene_request.json", "SceneRequest", SCENE_REQUEST_EXAMPLE),
    ("scene_graph.json", "SceneGraph", SCENE_GRAPH_EXAMPLE),
    ("print_params.json", "PrintParams", PRINT_PARAMS_EXAMPLE),
    ("bake_result.json", "BakeResult", BAKE_RESULT_EXAMPLE),
]

# (schema file, model name, base example, path to the field, out-of-range value).
# Every entry violates a minimum/maximum/exclusiveMinimum/minItems keyword that
# exists in the schema; test (d) asserts jsonschema and the generated model both
# reject it, so the models never accept input the contract forbids.
OUT_OF_RANGE_CASES = [
    ("scene_request.json", "SceneRequest", SCENE_REQUEST_EXAMPLE, ["lat"], 999),
    ("scene_request.json", "SceneRequest", SCENE_REQUEST_EXAMPLE, ["lat"], -91),
    ("scene_request.json", "SceneRequest", SCENE_REQUEST_EXAMPLE, ["lon"], -500),
    ("scene_request.json", "SceneRequest", SCENE_REQUEST_EXAMPLE, ["lon"], 181),
    ("scene_request.json", "SceneRequest", SCENE_REQUEST_EXAMPLE, ["radius_m"], 1),
    ("scene_request.json", "SceneRequest", SCENE_REQUEST_EXAMPLE, ["radius_m"], 5000),
    ("scene_request.json", "SceneRequest", SCENE_REQUEST_EXAMPLE, ["rotation_deg"], -45),
    ("scene_request.json", "SceneRequest", SCENE_REQUEST_EXAMPLE, ["rotation_deg"], 400),
    ("print_params.json", "PrintParams", PRINT_PARAMS_EXAMPLE, ["plate_mm"], 9999),
    ("print_params.json", "PrintParams", PRINT_PARAMS_EXAMPLE, ["plate_mm"], 0),
    ("print_params.json", "PrintParams", PRINT_PARAMS_EXAMPLE, ["base_thickness_mm"], -1),
    ("print_params.json", "PrintParams", PRINT_PARAMS_EXAMPLE, ["base_thickness_mm"], 9),
    ("print_params.json", "PrintParams", PRINT_PARAMS_EXAMPLE, ["nozzle_mm"], 0),
    ("print_params.json", "PrintParams", PRINT_PARAMS_EXAMPLE, ["nozzle_mm"], 2.0),
    ("print_params.json", "PrintParams", PRINT_PARAMS_EXAMPLE, ["small_scale"], 50),
    ("print_params.json", "PrintParams", PRINT_PARAMS_EXAMPLE, ["large_scale"], 0.1),
    ("print_params.json", "PrintParams", PRINT_PARAMS_EXAMPLE, ["terrain_exaggeration"], -1),
    ("print_params.json", "PrintParams", PRINT_PARAMS_EXAMPLE, ["road_scale"], 9),
    ("scene_graph.json", "SceneGraph", SCENE_GRAPH_EXAMPLE, ["roads", 0, "width_m"], 0),
    ("scene_graph.json", "SceneGraph", SCENE_GRAPH_EXAMPLE, ["roads", 0, "path"], [[0.0, 0.0]]),
    ("scene_graph.json", "SceneGraph", SCENE_GRAPH_EXAMPLE, ["buildings", 0, "height_m"], -1),
    ("scene_graph.json", "SceneGraph", SCENE_GRAPH_EXAMPLE, ["buildings", 0, "min_height_m"], -2),
    (
        "scene_graph.json",
        "SceneGraph",
        SCENE_GRAPH_EXAMPLE,
        ["buildings", 0, "ring"],
        [[0.0, 0.0], [1.0, 1.0]],
    ),
    ("scene_graph.json", "SceneGraph", SCENE_GRAPH_EXAMPLE, ["trees", 0, "radius_m"], 0),
    ("scene_graph.json", "SceneGraph", SCENE_GRAPH_EXAMPLE, ["stats", "building_count"], -1),
    ("scene_graph.json", "SceneGraph", SCENE_GRAPH_EXAMPLE, ["stats", "height_tag_ratio"], 7),
    ("scene_graph.json", "SceneGraph", SCENE_GRAPH_EXAMPLE, ["center", "lat"], 120),
    ("bake_result.json", "BakeResult", BAKE_RESULT_EXAMPLE, ["progress"], 5.0),
    ("bake_result.json", "BakeResult", BAKE_RESULT_EXAMPLE, ["progress"], -0.5),
    ("bake_result.json", "BakeResult", BAKE_RESULT_EXAMPLE, ["stats", "triangles"], -1),
    ("bake_result.json", "BakeResult", BAKE_RESULT_EXAMPLE, ["stats", "volume_mm3"], -1),
    ("bake_result.json", "BakeResult", BAKE_RESULT_EXAMPLE, ["stats", "min_wall_mm"], -0.5),
    ("bake_result.json", "BakeResult", BAKE_RESULT_EXAMPLE, ["stats", "bbox_mm"], [1.0, 2.0]),
]


def _with(base: dict, path: list, value) -> dict:
    """Deep-copy `base` and overwrite the entry at `path` with `value`."""
    instance = copy.deepcopy(base)
    cursor = instance
    for key in path[:-1]:
        cursor = cursor[key]
    cursor[path[-1]] = value
    return instance


def _schema(name: str) -> dict:
    return json.loads((SCHEMA_DIR / name).read_text(encoding="utf-8"))


@pytest.mark.parametrize("schema_name,model_name,example", VALID_EXAMPLES)
def test_in_range_examples_accepted_by_schema_and_model(schema_name, model_name, example):
    """Baseline for test (d): the unmutated examples pass both validators, so
    the rejection cases below fail for the bound and not for something else."""
    jsonschema.validate(instance=example, schema=_schema(schema_name))
    getattr(contracts, model_name)(**example)


@pytest.mark.parametrize(
    "schema_name,model_name,base,path,value",
    OUT_OF_RANGE_CASES,
    ids=[f"{c[1]}.{'.'.join(str(p) for p in c[3])}={c[4]}" for c in OUT_OF_RANGE_CASES],
)
def test_out_of_range_rejected_by_schema_and_model(schema_name, model_name, base, path, value):
    instance = _with(base, path, value)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=instance, schema=_schema(schema_name))
    with pytest.raises(ValidationError):
        getattr(contracts, model_name)(**instance)


# ---------------------------------------------------------------------------
# (e) default serialization emits the contract's key names, not the Python ones
# ---------------------------------------------------------------------------


def test_scene_graph_dumps_fixture_verbatim_without_by_alias():
    instance = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert contracts.SceneGraph(**instance).model_dump(mode="json") == instance


def test_bake_files_dump_uses_contract_key_without_by_alias():
    files = contracts.BakeFiles(**BAKE_RESULT_EXAMPLE["files"])
    assert files.model_dump() == BAKE_RESULT_EXAMPLE["files"]
    assert "file_3mf" not in files.model_dump_json()


def test_road_dump_uses_contract_key_without_by_alias():
    road = contracts.Road(**SCENE_GRAPH_EXAMPLE["roads"][0])
    assert road.model_dump(mode="json") == SCENE_GRAPH_EXAMPLE["roads"][0]
    assert "class_" not in road.model_dump_json()


def test_bake_result_dumps_without_by_alias():
    obj = contracts.BakeResult(**BAKE_RESULT_EXAMPLE)
    assert json.loads(obj.model_dump_json()) == BAKE_RESULT_EXAMPLE
