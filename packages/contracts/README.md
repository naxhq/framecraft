# packages/contracts

Single source of truth for the four wire contracts shared by `services/bake`
(Python/Pydantic v2) and `apps/web` (TypeScript): `SceneRequest`, `SceneGraph`,
`PrintParams`, `BakeResult`. Current schema version: **3**
(`PrintParams.schema_version`; the other three contracts are not versioned).

```
packages/contracts/
  schema/
    scene_request.json   input to POST /scene
    scene_graph.json     output of POST /scene, input to POST /bake
    print_params.json    editor parameters shared by the live preview and the bake pipeline
    bake_result.json     output of GET /bake/{job_id}
  gen_py.py               schema/*.json -> services/bake/app/contracts.py (Pydantic v2 models)
  gen_ts.py                schema/*.json -> apps/web/lib/contracts.ts (TS interfaces + DEFAULT_PRINT_PARAMS/PARAM_RANGES/PARAM_LIMITS)
```

## Rules

- Schemas are [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12/schema).
  Every object schema sets `"additionalProperties": false`. Nested object
  shapes live under `$defs` and are referenced with `$ref`; inline (un-named)
  object schemas are rejected by both generators.
- **`gen_py.py` and `gen_ts.py` are deterministic and idempotent**: given the
  same schemas, running either twice produces byte-identical output, and the
  generated files always equal what a fresh run produces. This is enforced by
  `services/bake/tests/test_contracts.py` ((a) in its docstring) - never
  hand-edit `services/bake/app/contracts.py` or `apps/web/lib/contracts.ts`.
- Regenerate both with `make contracts` (from the repo root), or directly:
  ```sh
  python packages/contracts/gen_py.py
  python packages/contracts/gen_ts.py
  ```
- **`required` beats `default`, but only inside `$defs`.** A nested object
  (`PartColors`, `Engraving`, ...) that lists a property in `required` gets a
  required field in the generated model even if that property also carries a
  `default` - a partial object sent directly is a wrong value, not an
  under-specified request (DECISIONS `[V2-P2-fix]`). The four PrintParams
  ROOT-level models stay envelopes: every root property keeps its schema
  default regardless of `required`, so `PrintParams()` / `PrintParams.model_validate({})`
  is always the documented "no parameters supplied" object.
- **Every field with a `default` needs one in every branch the caller can
  omit.** A property that points at a `$defs` object (or an array of one)
  must carry an object-shaped `default` naming every property that object's
  own `required` list demands, or generation fails loudly rather than
  emitting a `default_factory` that raises on first construction.
- Nested/mutable defaults (objects, non-empty arrays) are per-instance:
  Python via `Field(default_factory=lambda: ...)`, TypeScript via
  `defaultPrintParams()` (`structuredClone` of the frozen `DEFAULT_PRINT_PARAMS`
  constant). Never share a nested default across instances.
- `PARAM_RANGES` / `PARAM_LIMITS` (TypeScript only; Python carries the same
  bounds inline via `Field(ge=, le=, min_length=, max_length=)`) are built by
  walking `PrintParams`' properties **recursively** through `$ref`s (directly,
  or through an array's items): a bounded scalar is a leaf, an object
  reference recurses into that object's own properties by the same rule. This
  is why `PARAM_RANGES.regions.rail.width_m` and
  `PARAM_RANGES.frame_style.shadow_gap.width_mm` exist despite sitting two
  `$defs` deep - a UI slider several levels down still never re-types a bound.
- Field names are frozen once shipped: no rename or removal without a
  `DECISIONS.md` line. New fields must be additive and optional, with a
  default identical to the previous version's behaviour, so an old payload
  loads unchanged (`services/bake/tests/test_v1_compat.py`, G8).

## History

- **v1** (`da9ab83`): no `schema_version` field. The eleven flat parameters
  the MVP shipped with.
- **v2** (`fcadbeb`): `schema_version` becomes `{"enum": [2], "default": 2}`.
  Adds `city_label`, `color_mode`, `part_colors`, `engravings`, `north_arrow`,
  `scale_bar`, `hanger`, `underside_mark`, `hero_building_ids`, `hero_mode` -
  personalisation, colours and hero buildings for the single-file bake
  pipeline. See `docs/handoff/v2-01-contracts.md`.
- **v3** (this run, `[V3-A2]`): `schema_version` becomes
  `{"enum": [2, 3], "default": 3}`. Adds `place`, `regions`, `colour`,
  `printer_profile`, `custom_profile`, `export_target`, `terrain`, `heights`,
  `bridges`, `height_exaggeration`, `hero_auto`, `tiling`, `frame_style`,
  `hanger_magnet` for the browser engine (`apps/web/lib/engine/**`,
  `docs/IMPLEMENTATION_PLAN.md`), plus two new `Engraving` enum members
  (`mode: "inlay"`, `edge: "underside"`) and two new `hanger` enum members
  (`"cleat"`, `"easel"`). Every v3 field is optional with a v2-identical
  default; `services/bake` ignores all of it (the browser engine's own
  concern) and keeps baking byte-identical v1 geometry. Field-by-field
  reference: `docs/handoff/v3-01-contracts.md`.
