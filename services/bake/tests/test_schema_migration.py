"""One migration case per supported legacy contract revision.

``test_contracts.py`` freezes the CURRENT shape of the contract.  This file
asks the other question, once per revision that was ever written to disk or put
on a wire: *does a payload written against that revision still load, and does
loading and re-dumping it give the payload back?*

The revisions:

``PrintParams``
    v1 (no ``schema_version`` at all), v2, v3, v4.  The v1 case is not a
    reconstruction: it is the ``print_params`` block of
    ``fixtures/v1-golden/chicago-default.sidecar.json``, produced by a clean
    worktree of the v1 tree before any v2 edit existed (see
    ``test_v1_compat.py``'s module docstring).

``SceneGraph``
    v1/v2/v3, which are the same shape - none of them has the per-entity
    ``name``/``osm_id``/``kind`` that schema_version 4 added - and v4.  The
    v1/v2/v3 case is ``fixtures/chicago-scene.json``, the Python service's own
    ``POST /scene`` output.

The property asserted for every case is the same three things, so a future
revision adds a row rather than a test:

1. the legacy payload still validates against the CURRENT JSON Schema;
2. every key it carried survives a load and a dump with the same value;
3. the dump carries no key whose value is ``None`` - the v4 identity fields are
   optional AND non-nullable, so ``null`` is not a legal value for them and a
   model that emitted one would produce an instance its own schema rejects.
   ``gen_py.py``'s ``_omit_absent`` wrap serializer is what makes (2) and (3)
   true together, and it is generated from the schema rather than written by
   hand, so a fifth revision gets the same treatment for free.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import jsonschema
import pytest

from app import contracts

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_DIR = REPO_ROOT / "packages" / "contracts" / "schema"
SCENE_FIXTURE = REPO_ROOT / "fixtures" / "chicago-scene.json"
V1_SIDECAR = REPO_ROOT / "fixtures" / "v1-golden" / "chicago-default.sidecar.json"

# The identity properties schema_version 4 added to the SceneGraph.  Named here
# so the "no null ever reaches the wire" assertion below is about these fields
# specifically and not about whatever happens to be optional.
V4_IDENTITY_KEYS = ("name", "osm_id", "kind")


def _schema(name: str) -> dict:
    return json.loads((SCHEMA_DIR / name).read_text(encoding="utf-8"))


def _v1_print_params() -> dict:
    sidecar = json.loads(V1_SIDECAR.read_text(encoding="utf-8"))
    params = sidecar["print_params"]
    assert "schema_version" not in params, "the v1 golden sidecar is not a v1 payload any more"
    return params


def _nulls(value, path: str = "") -> list[str]:
    """Every path in a dumped payload whose value is ``None``."""
    out: list[str] = []
    if isinstance(value, dict):
        for key, inner in value.items():
            here = f"{path}.{key}" if path else key
            if inner is None:
                out.append(here)
            out.extend(_nulls(inner, here))
    elif isinstance(value, list):
        for index, inner in enumerate(value):
            out.extend(_nulls(inner, f"{path}[{index}]"))
    return out


def _survives(payload: dict, dumped: dict, path: str = "") -> None:
    """Assert every key of `payload` is in `dumped` with the same value."""
    for key, value in payload.items():
        here = f"{path}.{key}" if path else key
        assert key in dumped, f"{here} was lost on the way through the model"
        if isinstance(value, dict):
            _survives(value, dumped[key], here)
        else:
            assert dumped[key] == value, f"{here} changed value"


# ---------------------------------------------------------------------------
# PrintParams: v1, v2, v3, v4
# ---------------------------------------------------------------------------


def _print_params_case(version: int | None) -> dict:
    payload = copy.deepcopy(_v1_print_params())
    if version is not None:
        payload["schema_version"] = version
    return payload


PRINT_PARAMS_VERSIONS = [None, 2, 3, 4]


@pytest.mark.parametrize("version", PRINT_PARAMS_VERSIONS, ids=lambda v: f"v{v or 1}")
def test_a_print_params_payload_of_every_revision_still_loads(version):
    payload = _print_params_case(version)
    jsonschema.validate(instance=payload, schema=_schema("print_params.json"))

    loaded = contracts.PrintParams(**payload)
    dumped = loaded.model_dump(mode="json")

    _survives(payload, dumped)
    assert _nulls(dumped) == []
    # A payload that names no revision is v1, and v1 means "this object with
    # every later field at its default", which is the current default.
    assert dumped["schema_version"] == (version if version is not None else 4)
    # The dump is itself legal input, so a caller can round-trip a migrated
    # payload back through the same door it came in.
    jsonschema.validate(instance=dumped, schema=_schema("print_params.json"))


def test_every_v4_print_params_field_is_optional_and_defaults_to_the_v3_behaviour():
    """[V3.1-O4]: a contract addition lands WITH the feature that claims it.

    schema_version 4 opened naming a SceneGraph revision and no PrintParams
    field at all, because the V3-1 matrix test fails any parameter leaf no
    pipeline stage moves. The fields it has since gained arrived with the code
    that reads them (`object_overrides` with the right-click inspector). What
    must stay true of every one of them is the compatibility rule this whole
    file is about: none is required, each carries a default, and that default
    is the behaviour v3 had - which
    `test_a_print_params_payload_of_every_revision_still_loads` then checks by
    loading a payload that names none of them.
    """
    schema = _schema("print_params.json")
    v4_only = [
        name
        for name, prop in schema["properties"].items()
        if "schema_version 4" in prop.get("description", "") and name != "schema_version"
    ]
    assert "object_overrides" in v4_only
    required = set(schema.get("required", []))
    for name in v4_only:
        prop = schema["properties"][name]
        assert name not in required, f"{name} is a v4 addition and may not be required"
        assert "default" in prop, f"{name} is a v4 addition and needs a v3-identical default"
    # The one v4 default that is not simply "off": an empty override list, so a
    # default-constructed PrintParams builds byte-identical geometry.
    assert schema["properties"]["object_overrides"]["default"] == []
    assert schema["properties"]["schema_version"]["enum"] == [2, 3, 4]
    assert schema["properties"]["schema_version"]["default"] == 4


# ---------------------------------------------------------------------------
# SceneGraph: v1/v2/v3 (no identity) and v4 (identity)
# ---------------------------------------------------------------------------


def _v4_scene(legacy: dict) -> dict:
    """The legacy scene with schema_version 4 identity on one entity per layer."""
    scene = copy.deepcopy(legacy)
    scene["buildings"][0]["name"] = "Marquette Building"
    scene["buildings"][0]["kind"] = "building=commercial"
    scene["buildings"][0]["osm_id"] = "w1"
    scene["roads"][0]["name"] = "West Adams Street"
    scene["roads"][0]["kind"] = "highway=trunk"
    for layer in ("water", "green"):
        if scene[layer]:
            scene[layer][0]["name"] = f"A {layer} feature"
            scene[layer][0]["osm_id"] = "r2"
            scene[layer][0]["kind"] = "natural=water" if layer == "water" else "leisure=park"
    return scene


def _scene_cases() -> list[tuple[str, dict]]:
    legacy = json.loads(SCENE_FIXTURE.read_text(encoding="utf-8"))
    # The fixture is the pre-v4 shape, which is what makes it the v1/v2/v3 case.
    for entity in [*legacy["buildings"], *legacy["roads"], *legacy["water"], *legacy["green"]]:
        assert not any(key in entity for key in V4_IDENTITY_KEYS)
    return [("v1-v3", legacy), ("v4", _v4_scene(legacy))]


SCENE_CASES = _scene_cases()


@pytest.mark.parametrize("label,payload", SCENE_CASES, ids=[case[0] for case in SCENE_CASES])
def test_a_scene_graph_of_every_revision_dumps_back_verbatim(label, payload):
    jsonschema.validate(instance=payload, schema=_schema("scene_graph.json"))
    dumped = contracts.SceneGraph(**payload).model_dump(mode="json")
    # Verbatim, not merely lossless: the pre-v4 case is the assertion
    # `test_contracts.py::test_scene_graph_dumps_fixture_verbatim_without_by_alias`
    # makes, restated here per revision so a fifth one cannot quietly skip it.
    assert dumped == payload
    assert _nulls(dumped) == []
    jsonschema.validate(instance=dumped, schema=_schema("scene_graph.json"))


def test_the_v4_identity_is_absent_rather_than_null_on_a_legacy_scene():
    legacy = SCENE_CASES[0][1]
    dumped = contracts.SceneGraph(**legacy).model_dump(mode="json")
    entities = [*dumped["buildings"], *dumped["roads"], *dumped["water"], *dumped["green"]]
    assert entities, "the fixture has no entities to check"
    for entity in entities:
        for key in V4_IDENTITY_KEYS:
            assert key not in entity, f"{key} was emitted as null on a pre-v4 scene"


def test_the_v4_identity_survives_a_round_trip_when_it_is_there():
    v4 = SCENE_CASES[1][1]
    loaded = contracts.SceneGraph(**v4)
    assert loaded.buildings[0].name == "Marquette Building"
    assert loaded.buildings[0].kind == "building=commercial"
    assert loaded.buildings[0].osm_id == "w1"
    assert loaded.roads[0].name == "West Adams Street"
    # The one entity given identity keeps it; its neighbours stay absent.
    dumped = loaded.model_dump(mode="json")
    assert "name" in dumped["buildings"][0]
    assert "name" not in dumped["buildings"][1]


def test_the_identity_fields_are_optional_and_non_nullable_in_the_schema():
    """The property the omit-when-absent serializer is derived FROM.

    If a future edit gave one of these a `"default": null` or added `null` to
    its type, `gen_py.py` would stop omitting it and every assertion above would
    turn into a lie about a payload with `"name": null` in it. Asserted here so
    that edit fails at the schema rather than at the wire.
    """
    schema = _schema("scene_graph.json")
    for def_name in ("Building", "Road", "AreaFeature"):
        definition = schema["$defs"][def_name]
        for key in V4_IDENTITY_KEYS:
            prop = definition["properties"][key]
            assert key not in definition["required"], f"{def_name}.{key} became required"
            assert "default" not in prop, f"{def_name}.{key} gained a default"
            assert prop["type"] == "string", f"{def_name}.{key} became nullable"
