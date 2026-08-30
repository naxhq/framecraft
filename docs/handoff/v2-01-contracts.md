# v2-01 — Contracts v2, the v1 golden, and the shared token table

Scope: `packages/contracts/**`, the two generated contract files, the v1 golden
fixture set, `tests/test_v1_compat.py`, and the mirrored token pair. No pipeline
code was touched. `transform.py` / `transform.ts` / `checks.py` / `preview.ts`
were not edited (a concurrent audit owned them).

## 1. Schema changes

Only `packages/contracts/schema/print_params.json` changed. `scene_request.json`,
`scene_graph.json` and `bake_result.json` are untouched.

`schema_version` is `{"type": "integer", "enum": [2], "default": 2}` and is
**not** in `required`. Every v1 property keeps its name, type, bounds and
default verbatim, and the v1 `required` list is unchanged, so a v1 payload —
which has none of the new keys — still validates.

New optional properties, all defaulting to v1 behaviour:

| field | type | default |
|---|---|---|
| `city_label` | string, maxLength 64 | `""` |
| `color_mode` | `single` \| `parts` | `single` |
| `part_colors` | `$defs/PartColors` | 4-filament palette (below) |
| `engravings` | array of `$defs/Engraving`, maxItems 8 | `[]` |
| `north_arrow` | `$defs/NorthArrow` | all-defaults (`enabled: false`) |
| `scale_bar` | `$defs/ScaleBar` | all-defaults (`enabled: false`) |
| `hanger` | `none` \| `keyhole` \| `magnets` | `none` |
| `underside_mark` | `$defs/UndersideMark` | all-defaults (`enabled: false`) |
| `hero_building_ids` | array of string, maxItems 12 | `[]` |
| `hero_mode` | `true_height` \| `own_color` \| `both` | `true_height` |

New `$defs`:

- **PartColors** — seven `^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$` strings, all seven
  in `required`. Default palette is four distinct filaments so a 4-slot AMS
  works with no re-assignment: base+buildings `#D8D3C6`, roads+frame `#3A3A3A`,
  water `#2F7FC1`, green+trees `#5A9E4B`.
- **Engraving** — `edge` (required), `align` (default `center`), `text`
  (required, maxLength 64), `mode` (default `engrave`), `size_mm` 1.5–8.0
  default 3.0, `depth_mm` 0.2–1.5 default 0.4, `font` (default `sans`).
- **NorthArrow** — `enabled` false, `corner` `ne`, `size_mm` 2.0–6.0 default 4.0.
- **ScaleBar** — `enabled` false, `edge` `bottom`, `length_mode` `auto`,
  `length_m` 10–5000 default 500.
- **UndersideMark** — `enabled` false, `template` maxLength 64 default
  `{city} {scale} {date}`.

`NorthArrow`, `ScaleBar` and `UndersideMark` require nothing (a share link may
send `{"enabled": true}` and let the rest default); `Engraving` requires only
`edge` and `text`; `PartColors` requires all seven. Every property inside all
four still carries its own `default`, which is what makes each object-level
default exactly the all-defaults instance.

## 2. Generator extensions

`packages/contracts/gen_py.py`:

- `string_constraints()` → `minLength`/`maxLength`/`pattern` become
  `Field(min_length=/max_length=/pattern=)`; `scalar_constraints()` merges them
  with the existing numeric bounds at both scalar call sites.
- `py_default()` now returns `(kind, source)` — `"value"` for an immutable
  literal, `"factory"` for a callable expression — instead of a source string.
  Object defaults emit `Field(default_factory=lambda: T(k=v, ...))`, with the
  keyword order taken from the referenced `$defs`' own property order so the
  output is deterministic. This also fixed a latent bug: the old alias branch
  hard-coded `default_factory=list` for *any* mutable default.
- `extra="forbid"`, `populate_by_name`, `serialize_by_alias` and the [P1-fix]
  bound emission are unchanged and now apply to the five new nested models too.

`packages/contracts/gen_ts.py`:

- `ts_literal()` is recursive and indentation-aware, so nested object/array
  defaults render one key per line in `$defs` property order.
- `ref_target()` / `bounded()` / rewritten `numeric_range_entries()` give
  `PARAM_RANGES` nested groups: `PARAM_RANGES.north_arrow.size_mm.max`,
  `PARAM_RANGES.scale_bar.length_m`, `PARAM_RANGES.engravings.size_mm` (the
  array's *item* bounds keyed by the array's name). Every v1 entry keeps its
  exact position and shape.

Integer enums needed no change — `Literal[2]` in Python, `2` in TS, both via the
existing enum path.

Regenerated with `make contracts`. Both generated files are **pure insertions**
(contracts.py +54, contracts.ts +90, zero deletions); the determinism and
committed-output tests stay green.

## 3. The v1 golden

Generated from a clean `git worktree add … da9ab83` (the v1 tree, before any v2
edit existed), `uv sync` in that worktree, then the exact `make bake-fixture`
command. The worktree was removed afterwards; `git worktree list` shows only the
main tree.

**Canonical geometry digest** = sha256 over the exact source *text* of the
`<vertices>…</vertices>` element followed by the `<triangles>…</triangles>`
element of `3D/3dmodel.model`. Textual, not parsed, so a reordered triangle,
a flipped winding or a one-ulp coordinate all move it.

```
digest      0e20725e9c738a1af7e91a62dd2808ae94f74027f2811b51c65790873ce08758
vertices    34,348
triangles   68,692
volume      167624.12441295458 mm^3
bbox        180.0 x 180.0 x 34.733333333333334 mm
min wall    0.8015771163765992 mm
3mf size    645,101 bytes (under 6 MB, so committed whole)
```

Committed under `fixtures/v1-golden/`:
`chicago-default.json` (digest + stats + warnings + generating commit da9ab83 +
generation date 2026-08-29), `chicago-default.sidecar.json` (the real v1
sidecar, whose `print_params` block is a genuine v1 object), and
`chicago-default.3mf` so a future mismatch is diffable.

**The digest method was verified, not assumed**: before any v2 edit, the working
tree's bake reproduced the golden's *entire* model XML byte for byte.

## 4. `services/bake/tests/test_v1_compat.py` (G8)

Eleven tests, all passing, all offline (`allow_network=False`, committed
Overpass fixture). The bake goes through `bake.run_pipeline` — the same public
entry `POST /bake`'s worker and the CLI both use.

- `test_default_v2_params_reproduce_the_v1_geometry_digest`
- `test_default_v2_params_reproduce_the_v1_triangle_and_vertex_counts`
- `test_default_v2_params_reproduce_the_v1_volume_and_min_wall`
- `test_default_v2_params_reproduce_the_v1_warnings`
- `test_the_bake_still_passes_every_validator`
- `test_the_v1_sidecar_print_params_load_and_equal_the_v2_defaults`
- `test_the_v1_sidecar_print_params_validate_against_the_v2_schema`
- `test_a_v1_bake_request_body_is_still_accepted_at_the_api_boundary`
- `test_single_mode_writes_the_v1_geometry_xml_byte_for_byte`
- `test_single_mode_changes_no_metadata_except_creationdate_and_description`
- `test_the_description_gains_only_the_v2_defaults`

**Why (c) is three tests and not one.** `mf3.build_metadata` recites the whole
`PrintParams` object into the 3MF `Description`, so a v2 model necessarily
recites eleven more keys and a blanket "identical except CreationDate" could
never pass. The split is *stricter* than the blanket comparison: everything
outside `<metadata>` must be identical text; no metadata name may change value
except `CreationDate` and `Description`; and the `Description`'s `PrintParams:`
recital must keep every v1 `k=v` pair byte-identical while gaining exactly the
eleven v2 names. Nothing that could hide a geometry change was excluded.

**Task 2 (parts export) must keep all eleven green.** The first three are the
geometry guarantee; the last three are the "single mode stays byte for byte"
pin, in place before the code that could break it is written.

## 5. Contract tests extended

`services/bake/tests/test_contracts.py` — new section (f), plus 18 new
out-of-range cases in the bound-parity suite covering every new bounded field
(`schema_version` enum both directions, `city_label`/`text`/`template`
maxLength, the `part_colors` hex pattern, `engravings[].size_mm` and
`depth_mm` at both ends, `north_arrow.size_mm` at both ends,
`scale_bar.length_m` at both ends, `engravings` maxItems 9,
`hero_building_ids` maxItems 13) — each asserted rejected by **both**
jsonschema and the generated model, with `PRINT_PARAMS_V2_EXAMPLE` added to
`VALID_EXAMPLES` as the non-vacuous in-range baseline.

New tests: `test_a_v1_print_params_payload_loads_and_equals_the_default_model`,
`test_a_v1_print_params_payload_still_validates_against_the_v2_schema`,
`test_default_print_params_dump_validates_against_the_v2_schema`,
`test_schema_version_is_optional_and_not_required`,
`test_every_v1_field_keeps_its_name_type_range_and_default`,
`test_nested_v2_defaults_are_independent_per_instance`,
`test_part_colors_default_uses_four_distinct_filaments`,
`test_default_print_params_fixture_matches_the_model`,
`test_print_params_v2_round_trips`.

`fixtures/print-params-default.json` is `PrintParams().model_dump(mode="json")`,
written under `FRAMECRAFT_WRITE_PARITY=1` and asserted by pytest *and* by the
new `apps/web/lib/contracts.test.ts`, so `DEFAULT_PRINT_PARAMS` cannot drift
from `PrintParams()`.

## 6. The token table

`services/bake/app/geom/tokens.py` (stdlib only) and `apps/web/lib/tokens.ts`,
identical snake_case names per [P4]: `TOKENS`, `TokenContext`, `FORMATTERS`,
`expand_tokens`, `format_city|lat|lon|coords|scale|radius|date|buildings`, plus
the shared helpers `round_half_up`, `group_thousands`, `fixed`.

Formats: `{city}` verbatim (empty when unset — no reverse geocoding anywhere);
`{lat}`/`{lon}` signed at 4 dp; `{coords}` `41.8827° N, 87.6233° W`; `{scale}`
`1:23,571` from `round(1000 / scale_mm_per_m)` with thousands separators;
`{radius}` `900 m` (whole metres, no separator); `{date}` the caller's ISO
string verbatim; `{buildings}` grouped. Unknown tokens stay verbatim, and
`{scale}` stays verbatim when `scale_mm_per_m` is not positive.

Every number is formatted by hand rather than through `format()`/`toFixed()`/
`toLocaleString()`: Python's `round` is banker's rounding, JS's `Math.round` is
not, and `toLocaleString` is locale-dependent.

`fixtures/tokens-expected.json` — 27 cases covering every token, a mixed string,
unknown tokens, negative lat/lon, a near-zero latitude (must not print
`-0.0000`), a 0.5 m rounding tie, an unmeasured scale, and the three real scale
ratios. Written by `services/bake/tests/test_tokens.py` under
`FRAMECRAFT_WRITE_PARITY=1`, asserted by pytest and by
`apps/web/lib/tokens.test.ts`.

**Note for later phases:** the brief's "Chicago 1:9,650" matches no parameter
combination this tree produces. Chicago at the defaults is **1:10,714**
(plate 180, frame on, radius 900 → 168 mm over 1800 m); the closest ratio any
committed artifact shows is 1:9,574 at plate 200. The fixture pins 1:10,714,
1:23,571 and 1:9,574.

## 7. Web-side changes

`apps/web/lib/contracts.ts` is regenerated (never hand-edited). The editor does
**not** yet expose any v2 field; nothing was redesigned.

The three tests that walk every `PrintParams` key were extended with *real* v2
values rather than by widening a coverage list:

- `store/editor.test.ts` `PARAM_MOVES` — each v2 key now goes through
  `setParam` with `fetch` spied on, so none of them can reach the network.
- `lib/warnings.test.ts` `MOVES` — plus a new guard,
  "has a moved value for every non-boolean parameter", without which the new
  keys would have been walked as `undefined` and the "does not move the
  prediction" claim would have been vacuous.
- `components/scene/CityPreview.test.ts` — new test "rebuilds nothing when a v2
  personalisation parameter moves" *asserts* the classification instead of
  declaring it.

No test was weakened, skipped or deleted.

## 8. Verify

```sh
cd services/bake && uv run pytest -q                       # 389 passed
cd services/bake && uv run pytest tests/test_v1_compat.py  # G8, 11 passed
cd services/bake && uv run pytest tests/test_contracts.py tests/test_tokens.py
cd apps/web && npm test -- --run && npm run typecheck && npm run lint && npm run build
```

Regenerating (never hand-edit the outputs):

```sh
make contracts                                             # both generated files
cd services/bake && FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_contracts.py tests/test_tokens.py
```

## 9. State at hand-off

- Contracts are **re-frozen** at the end of this run. Field names match this
  document verbatim.
- Green on this host: full pytest suite, `npm test`, `npm run typecheck`,
  `npm run lint`, `npm run build`. `make gate` and `make up` were not run (not
  this phase's to run).
- Nothing committed; all changes are working-tree.
