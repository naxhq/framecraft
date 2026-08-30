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
(f) PrintParams schema_version 2 is backward compatible: a v1 payload (which
    carries none of the v2 keys) loads, validates and equals PrintParams(),
    every v1 field keeps its name/type/range/default, the nested v2 defaults
    are per-instance, and fixtures/print-params-default.json states the
    defaults once for both languages.
"""
from __future__ import annotations

import copy
import importlib.util
import json
import os
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

# The eleven names schema_version 2 adds.  Spelled out here on purpose: this is
# the list a future phase would have to edit deliberately, and the round-trip
# test below fails the moment the generated model grows or loses one.
V2_PRINT_PARAM_FIELDS = [
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
]

# A fully-populated v2 payload: every new field present and in range, so the
# out-of-range cases below have a non-vacuous baseline to mutate.
PRINT_PARAMS_V2_EXAMPLE = {
    **PRINT_PARAMS_EXAMPLE,
    "schema_version": 2,
    "city_label": "Chicago",
    "color_mode": "parts",
    "part_colors": {
        "base": "#D8D3C6",
        "frame": "#3A3A3A",
        "buildings": "#D8D3C6",
        "roads": "#3A3A3A",
        "water": "#2F7FC1",
        "green": "#5A9E4B",
        "trees": "#5A9E4B",
    },
    "engravings": [
        {
            "edge": "bottom",
            "align": "center",
            "text": "{city} {coords}",
            "mode": "engrave",
            "size_mm": 3.0,
            "depth_mm": 0.4,
            "font": "sans",
        }
    ],
    "north_arrow": {"enabled": True, "corner": "ne", "size_mm": 4.0},
    "scale_bar": {
        "enabled": True,
        "edge": "bottom",
        "length_mode": "fixed",
        "length_m": 500,
    },
    "hanger": "keyhole",
    "underside_mark": {"enabled": True, "template": "{city} {scale} {date}"},
    "hero_building_ids": ["w123", "w456"],
    "hero_mode": "both",
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
    """02's example is a v1 payload: every v1 key round-trips unchanged, and the
    only keys the v2 model adds are the eleven named above."""
    obj = contracts.PrintParams(**PRINT_PARAMS_EXAMPLE)
    dumped = obj.model_dump(mode="json")
    assert {k: dumped[k] for k in PRINT_PARAMS_EXAMPLE} == PRINT_PARAMS_EXAMPLE
    assert sorted(set(dumped) - set(PRINT_PARAMS_EXAMPLE)) == sorted(V2_PRINT_PARAM_FIELDS)


def test_print_params_v2_round_trips():
    obj = contracts.PrintParams(**PRINT_PARAMS_V2_EXAMPLE)
    assert obj.model_dump(mode="json") == PRINT_PARAMS_V2_EXAMPLE


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
    ("print_params.json", "PrintParams", PRINT_PARAMS_V2_EXAMPLE),
    ("bake_result.json", "BakeResult", BAKE_RESULT_EXAMPLE),
]

TOO_LONG = "x" * 65

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
    # v2 fields: numeric bounds, string lengths, the hex pattern, array caps
    # and the schema_version enum.
    ("print_params.json", "PrintParams", PRINT_PARAMS_V2_EXAMPLE, ["schema_version"], 1),
    ("print_params.json", "PrintParams", PRINT_PARAMS_V2_EXAMPLE, ["schema_version"], 3),
    ("print_params.json", "PrintParams", PRINT_PARAMS_V2_EXAMPLE, ["city_label"], TOO_LONG),
    (
        "print_params.json",
        "PrintParams",
        PRINT_PARAMS_V2_EXAMPLE,
        ["part_colors", "base"],
        "D8D3C6",
    ),
    (
        "print_params.json",
        "PrintParams",
        PRINT_PARAMS_V2_EXAMPLE,
        ["part_colors", "water"],
        "#12345",
    ),
    (
        "print_params.json",
        "PrintParams",
        PRINT_PARAMS_V2_EXAMPLE,
        ["engravings", 0, "size_mm"],
        1.4,
    ),
    (
        "print_params.json",
        "PrintParams",
        PRINT_PARAMS_V2_EXAMPLE,
        ["engravings", 0, "size_mm"],
        8.1,
    ),
    (
        "print_params.json",
        "PrintParams",
        PRINT_PARAMS_V2_EXAMPLE,
        ["engravings", 0, "depth_mm"],
        0.1,
    ),
    (
        "print_params.json",
        "PrintParams",
        PRINT_PARAMS_V2_EXAMPLE,
        ["engravings", 0, "depth_mm"],
        1.6,
    ),
    (
        "print_params.json",
        "PrintParams",
        PRINT_PARAMS_V2_EXAMPLE,
        ["engravings", 0, "text"],
        TOO_LONG,
    ),
    (
        "print_params.json",
        "PrintParams",
        PRINT_PARAMS_V2_EXAMPLE,
        ["engravings"],
        [dict(PRINT_PARAMS_V2_EXAMPLE["engravings"][0])] * 9,
    ),
    (
        "print_params.json",
        "PrintParams",
        PRINT_PARAMS_V2_EXAMPLE,
        ["north_arrow", "size_mm"],
        1.9,
    ),
    (
        "print_params.json",
        "PrintParams",
        PRINT_PARAMS_V2_EXAMPLE,
        ["north_arrow", "size_mm"],
        6.1,
    ),
    (
        "print_params.json",
        "PrintParams",
        PRINT_PARAMS_V2_EXAMPLE,
        ["scale_bar", "length_m"],
        9,
    ),
    (
        "print_params.json",
        "PrintParams",
        PRINT_PARAMS_V2_EXAMPLE,
        ["scale_bar", "length_m"],
        5001,
    ),
    (
        "print_params.json",
        "PrintParams",
        PRINT_PARAMS_V2_EXAMPLE,
        ["underside_mark", "template"],
        TOO_LONG,
    ),
    (
        "print_params.json",
        "PrintParams",
        PRINT_PARAMS_V2_EXAMPLE,
        ["hero_building_ids"],
        [f"w{i}" for i in range(13)],
    ),
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


# The same both-validators-agree harness applied to SHAPE rather than to bounds:
# a required key missing from a nested object, and an unknown key inside one.
# Both were untested in either direction, which is exactly how gen_py.py came to
# emit a default for every property of PartColors - all seven of which the schema
# lists in `required` - so a half palette was rejected by jsonschema and by the
# TS type but silently back-filled by the model (DECISIONS [V2-P2-fix]).
FULL_PALETTE = dict(PRINT_PARAMS_V2_EXAMPLE["part_colors"])
FULL_ENGRAVING = dict(PRINT_PARAMS_V2_EXAMPLE["engravings"][0])

MISSHAPEN_CASES = [
    # PartColors lists all seven keys in `required`: a partial palette is not a
    # palette. Six silently-defaulted filaments would print in the wrong colours
    # rather than answer 422.
    ("PartColors partial", ["part_colors"], {"base": "#D8D3C6"}),
    ("PartColors empty", ["part_colors"], {}),
    (
        "PartColors missing trees",
        ["part_colors"],
        {k: v for k, v in FULL_PALETTE.items() if k != "trees"},
    ),
    # Engraving requires `edge` and `text` (the rest default).
    (
        "Engraving missing edge",
        ["engravings", 0],
        {k: v for k, v in FULL_ENGRAVING.items() if k != "edge"},
    ),
    (
        "Engraving missing text",
        ["engravings", 0],
        {k: v for k, v in FULL_ENGRAVING.items() if k != "text"},
    ),
    ("Engraving empty", ["engravings", 0], {}),
    # additionalProperties: false holds on all five new $defs, not just the root.
    ("unknown key in PartColors", ["part_colors", "hue"], "#FFFFFF"),
    ("unknown key in Engraving", ["engravings", 0, "colour"], "#FFFFFF"),
    ("unknown key in NorthArrow", ["north_arrow", "cornre"], "ne"),
    ("unknown key in ScaleBar", ["scale_bar", "length_ft"], 1640),
    ("unknown key in UndersideMark", ["underside_mark", "tempalte"], "{city}"),
]

# The deliberate asymmetry: NorthArrow, ScaleBar and UndersideMark require
# NOTHING, so a share link may send `{"enabled": true}` and let the rest default.
# Pinned here so a later "make everything required" pass has to argue with a
# test instead of quietly breaking short links.
UNDER_SPECIFIED_CASES = [
    ("north_arrow", {}, "NorthArrow"),
    ("north_arrow", {"enabled": True}, "NorthArrow"),
    ("scale_bar", {}, "ScaleBar"),
    ("scale_bar", {"enabled": True}, "ScaleBar"),
    ("underside_mark", {}, "UndersideMark"),
    ("underside_mark", {"enabled": True}, "UndersideMark"),
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


@pytest.mark.parametrize(
    "path,value", [(c[1], c[2]) for c in MISSHAPEN_CASES], ids=[c[0] for c in MISSHAPEN_CASES]
)
def test_misshapen_nested_objects_rejected_by_schema_and_model(path, value):
    """A nested object missing a required key, or carrying an unknown one, is
    illegal under the schema - so the model must refuse it too, rather than
    quietly filling in what the caller did not send."""
    instance = _with(PRINT_PARAMS_V2_EXAMPLE, path, value)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=instance, schema=_schema("print_params.json"))
    with pytest.raises(ValidationError):
        contracts.PrintParams(**instance)


@pytest.mark.parametrize(
    "field,value,model_name",
    UNDER_SPECIFIED_CASES,
    ids=[f"{c[0]}={c[1]}" for c in UNDER_SPECIFIED_CASES],
)
def test_ornaments_accept_a_partial_object_in_schema_and_model(field, value, model_name):
    """The three ornament objects require nothing, in BOTH validators, and the
    model fills each absent member from that object's own schema default."""
    instance = _with(PRINT_PARAMS_V2_EXAMPLE, [field], value)
    jsonschema.validate(instance=instance, schema=_schema("print_params.json"))
    loaded = getattr(contracts.PrintParams(**instance), field)
    defaults = _schema("print_params.json")["$defs"][model_name]["properties"]
    for name, prop in defaults.items():
        expected = value.get(name, prop["default"])
        assert getattr(loaded, name) == expected, name


def _model_field_names(model) -> dict:
    """Contract key -> pydantic FieldInfo, undoing the "3mf"/"class" aliases."""
    return {info.alias or name: info for name, info in model.model_fields.items()}


# How many required properties each schema's object $defs declare between them
# (scene_graph: Building 7 + Road 4 + AreaFeature 2 + Tree 3 + Bounds 4 +
# Center 2 + Stats 3; print_params: PartColors 7 + Engraving 2; bake_result:
# BakeFiles 2 + BakeStats 6).  Spelled out so the test below cannot pass by
# walking an empty list, and so shrinking a `required` list is a deliberate edit.
REQUIRED_DEF_PROPERTIES = {
    "scene_request.json": 0,  # no $defs at all
    "scene_graph.json": 25,
    "print_params.json": 9,
    "bake_result.json": 8,
}


@pytest.mark.parametrize("schema_name", sorted(REQUIRED_DEF_PROPERTIES))
def test_every_required_property_of_a_nested_def_is_required_in_the_model(schema_name):
    """The generator rule behind the parity above, pinned once for all four
    schemas: inside a $defs object, `required` wins over `default`, so no
    regeneration can reintroduce a nested model that back-fills a key the
    contract says the caller must send."""
    schema = _schema(schema_name)
    checked = 0
    for def_name, def_schema in schema.get("$defs", {}).items():
        if def_schema.get("type") != "object":
            continue
        fields = _model_field_names(getattr(contracts, def_name))
        for prop_name in def_schema.get("required", []):
            assert fields[prop_name].is_required(), f"{def_name}.{prop_name}"
            checked += 1
    assert checked == REQUIRED_DEF_PROPERTIES[schema_name]


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


# ---------------------------------------------------------------------------
# (f) schema_version 2 is backward compatible with v1 payloads
# ---------------------------------------------------------------------------


def test_a_v1_print_params_payload_loads_and_equals_the_default_model():
    """A v1 bake sidecar carries none of the v2 keys.  It must still load, and
    it must mean exactly what a default-constructed v2 PrintParams means -
    which is what tests/test_v1_compat.py then proves geometrically."""
    v1 = contracts.PrintParams(**PRINT_PARAMS_EXAMPLE)
    assert v1 == contracts.PrintParams()


def test_an_empty_print_params_body_still_means_the_defaults():
    """The ROOT model stays an envelope: `PrintParams()` is the documented "no
    parameters supplied" object and an empty JSON body means the same thing, so
    the strict required-means-required rule the nested $defs now follow
    (DECISIONS [V2-P2-fix]) did not leak up to the API boundary and break every
    caller that sends a partial parameter set."""
    assert contracts.PrintParams.model_validate({}) == contracts.PrintParams()
    assert contracts.PrintParams(plate_mm=200) == contracts.PrintParams.model_validate(
        {"plate_mm": 200}
    )


def test_the_default_nested_objects_are_complete_instances():
    """The outer default_factory names every key of a nested model, so making
    those models required-complete cannot leave `PrintParams()` half-built."""
    params = contracts.PrintParams()
    for field, model_name in (
        ("part_colors", "PartColors"),
        ("north_arrow", "NorthArrow"),
        ("scale_bar", "ScaleBar"),
        ("underside_mark", "UndersideMark"),
    ):
        declared = _schema("print_params.json")["$defs"][model_name]["properties"]
        assert set(getattr(params, field).model_dump()) == set(declared), model_name


def test_a_v1_print_params_payload_still_validates_against_the_v2_schema():
    jsonschema.validate(instance=PRINT_PARAMS_EXAMPLE, schema=_schema("print_params.json"))


def test_default_print_params_dump_validates_against_the_v2_schema():
    """The model's own output is legal input: no default violates its bound,
    its pattern or its enum, and no required key goes missing."""
    instance = contracts.PrintParams().model_dump(mode="json")
    jsonschema.validate(instance=instance, schema=_schema("print_params.json"))
    assert instance["schema_version"] == 2


def test_schema_version_is_optional_and_not_required():
    schema = _schema("print_params.json")
    assert "schema_version" not in schema["required"]
    assert schema["properties"]["schema_version"]["enum"] == [2]
    # Absent is legal, and loading a payload without it still yields v2.
    assert contracts.PrintParams(**PRINT_PARAMS_EXAMPLE).schema_version == 2


def test_every_v1_field_keeps_its_name_type_range_and_default():
    """The v1 half of the contract is frozen inside the v2 revision."""
    schema = _schema("print_params.json")["properties"]
    v1_shape = {
        "plate_mm": ("number", 100, 256, 180),
        "base_thickness_mm": ("number", 2, 8, 3.0),
        "nozzle_mm": ("number", 0.1, 1.2, 0.4),
        "small_scale": ("number", 0.5, 1.5, 1.0),
        "large_scale": ("number", 0.5, 2.0, 1.0),
        "terrain_exaggeration": ("number", 0.0, 3.0, 1.0),
        "road_scale": ("number", 0.5, 2.0, 1.0),
    }
    for name, (json_type, low, high, default) in v1_shape.items():
        prop = schema[name]
        assert (prop["type"], prop["minimum"], prop["maximum"], prop["default"]) == (
            json_type,
            low,
            high,
            default,
        ), name
    assert schema["road_mode"]["enum"] == ["engrave", "emboss", "off"]
    assert schema["road_mode"]["default"] == "engrave"
    for name in ("trees", "water", "frame"):
        assert schema[name] == {"type": "boolean", "default": True}


def test_nested_v2_defaults_are_independent_per_instance():
    """default_factory, not a shared mutable: editing one model's engravings or
    part colours must not reach into the next one."""
    a = contracts.PrintParams()
    b = contracts.PrintParams()
    assert a.part_colors is not b.part_colors
    assert a.engravings is not b.engravings
    a.engravings.append(contracts.Engraving(edge="top", text="hello"))
    a.part_colors.water = "#000000"
    assert b.engravings == []
    assert b.part_colors.water == "#2F7FC1"


def test_part_colors_default_uses_four_distinct_filaments():
    """The AMS rationale for the default palette (DECISIONS [V2-P2]): four
    slots cover the whole scene, paired base+buildings / roads+frame /
    water / green+trees."""
    colors = contracts.PrintParams().part_colors
    assert colors.base == colors.buildings
    assert colors.roads == colors.frame
    assert colors.green == colors.trees
    assert len({colors.base, colors.roads, colors.water, colors.green}) == 4


# fixtures/print-params-default.json is the shared statement of "the defaults",
# written here and asserted by BOTH this suite and apps/web/lib/contracts.test.ts,
# so DEFAULT_PRINT_PARAMS in TS cannot drift from PrintParams() in Python.
DEFAULTS_FIXTURE = REPO_ROOT / "fixtures" / "print-params-default.json"


def test_default_print_params_fixture_matches_the_model():
    fresh = contracts.PrintParams().model_dump(mode="json")
    if os.environ.get("FRAMECRAFT_WRITE_PARITY") == "1":
        DEFAULTS_FIXTURE.write_text(
            json.dumps(fresh, indent=2) + "\n", encoding="utf-8", newline="\n"
        )
    assert DEFAULTS_FIXTURE.is_file(), (
        "fixtures/print-params-default.json is missing; regenerate with "
        "FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_contracts.py"
    )
    assert json.loads(DEFAULTS_FIXTURE.read_text(encoding="utf-8")) == fresh
