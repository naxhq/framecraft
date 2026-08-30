# v3-01 - Contracts v3 (browser engine block)

Scope: `packages/contracts/**`, the two generated contract files, the v1
golden fixture set (untouched), `services/bake/tests/{test_contracts.py,
test_v1_compat.py}`, `apps/web/lib/contracts.test.ts`,
`fixtures/{print-params-default,lettering-expected}.json` (regenerated, no
logic change). No pipeline code, `transform.py`/`transform.ts`,
`checks.py`/`preview.ts`, and no `apps/web` file other than the generated
`lib/contracts.ts` and `lib/contracts.test.ts` were touched.

## 1. Schema changes

Only `packages/contracts/schema/print_params.json` changed.
`scene_request.json`, `scene_graph.json`, `bake_result.json` are untouched.

`schema_version` is `{"type": "integer", "enum": [2, 3], "default": 3}`, still
not in `required`. Every v1 and v2 property keeps its name, type, bounds and
default verbatim; the `required` list (the eleven v1 fields) is unchanged. See
`[V3-P1c]` in `DECISIONS.md` for why the default moved to 3 without breaking
`tests/test_v1_compat.py`.

### Extended v1/v2 fields (no rename, additive enum members only)

| field | change |
|---|---|
| `hanger` | enum gains `"cleat"`, `"easel"` (was `none/keyhole/magnets`) |
| `Engraving.mode` | enum gains `"inlay"` (was `engrave/emboss`) |
| `Engraving.edge` | enum gains `"underside"` (was `top/bottom/left/right`) |

### New top-level fields, all optional, default identical to "off"/v2 behaviour

| field | type | default |
|---|---|---|
| `place` | `$defs/Place` | `{country:"", state:"", neighbourhood:"", author:""}` |
| `regions` | `$defs/Regions` | see table below |
| `colour` | `$defs/Colour` | see table below |
| `printer_profile` | enum, 9 members | `"custom"` |
| `custom_profile` | `$defs/CustomProfile` | see table below |
| `export_target` | enum, 7 members | `"bambu-3mf"` |
| `terrain` | `$defs/Terrain` | `{enabled:false, smoothing:1}` (exaggeration reuses the existing top-level `terrain_exaggeration`) |
| `heights` | `$defs/Heights` | see table below |
| `bridges` | `$defs/Bridges` | `{enabled:true, clearance_mm:1.0, abutments:true}` |
| `height_exaggeration` | `$defs/HeightExaggeration` | `{multiplier:1.0, curve:0.0}` |
| `hero_auto` | `$defs/HeroAuto` | `{enabled:false, count:3}` |
| `tiling` | `$defs/Tiling` | see table below |
| `frame_style` | `$defs/FrameStyle` | see table below |
| `hanger_magnet` | `$defs/HangerMagnet` | `{diameter_mm:6, thickness_mm:2, count:2}` |

`bridges.enabled` defaults **true** (structural fallback, only matters once
`terrain` is on) - every other new `enabled`/effect field defaults **false**,
so a default-constructed v3 PrintParams still bakes v1 geometry
(`tests/test_v1_compat.py`, unchanged and green).

None of the new `$defs` objects declare a `required` list ( `[V3-P1c]`); every
leaf still has an explicit schema default, so a partial object (e.g. a share
link sending `{"colour": {"palette": "noir"}}`) still validates and loads.

## 2. Field-by-field reference (name, default, range)

Ranges omitted below have none in the schema (plain `type`/`enum`/`maxLength`
only); this is intentional, not missing (`[V3-P1c]`).

**place** (`Place`, root -> Place, no bounds, `maxLength` 64 each)
`country ""`, `state ""`, `neighbourhood ""`, `author ""`.

**regions** (`Regions`)
- `roads` (`RoadRegion`): `depth_mm 0.6` [0.2, 3.0], `proud_mm -0.2` [-2.0, 2.0]
- `water` (`WaterRegion`): `depth_mm 1.0` [0.2, 3.0], `proud_mm -0.5` [-2.0, 2.0]
- `parks` (`ParkRegion`): `depth_mm 0.4` [0.2, 3.0], `proud_mm 0.0` [-2.0, 2.0]
- `rail` (`RailRegion`): `depth_mm 0.4` [0.2, 3.0], `proud_mm 0.3` [-2.0, 2.0], `width_m 6.0` [2, 20]
- `building_skirt_mm 0.3` [0, 1]

**colour** (`Colour`)
- `region_slots` (`RegionSlots`, integer, all [1, 16]): `base 1`, `frame 1`,
  `matting 1`, `buildings 2`, `hero_building 4`, `roads 4`, `water 3`,
  `parks 4`, `rail 4`, `lettering 4`, `attribution 1`
- `region_colors` (`RegionColors`, `#RRGGBB[AA]`, no bounds): `base #D8D3C6`,
  `frame #3A3A3A`, `matting #EDE9E0`, `buildings #D8D3C6`,
  `hero_building #E3A72F`, `roads #3A3A3A`, `water #2F7FC1`, `parks #5A9E4B`,
  `rail #6B6B6B`, `lettering #E3A72F`, `attribution #D8D3C6`
- `palette "default"` (`maxLength` 32)
- `tint` (`Tint`): `enabled false`, `hue_range_deg 12` [0, 60],
  `lightness_range 0.12` [0, 0.5], `seed 1` (int, no range)
- `gradient` (`Gradient`): `enabled false`, `slots [2, 3]` (int array,
  `maxItems` 16, no per-item range)
- `preview_theme "dark"` (enum `dark`/`light`)

**printer_profile** `"custom"` (enum: `custom`, `bambu-h2s`, `bambu-p1s`,
`bambu-x1c`, `bambu-a1`, `bambu-a1-mini`, `prusa-mk4`, `prusa-mini`, `ender-3`)

**custom_profile** (`CustomProfile`): `plate_x_mm 256` [100, 400],
`plate_y_mm 256` [100, 400], `max_height_mm 250` [20, 500],
`nozzle_mm 0.4` [0.2, 1.0], `slots 4` (int) [1, 16], `change_gcode "M600"`
(no length bound)

**export_target** `"bambu-3mf"` (enum: `bambu-3mf`, `generic-3mf`, `stl`,
`stl-parts-zip`, `obj`, `step`, `color-change-3mf`)

**terrain** (`Terrain`): `enabled false`, `smoothing 1` (int) [0, 5].
Exaggeration is NOT a field here (corrected per orchestrator note, `[V3-P1c]`):
it reuses the existing top-level `terrain_exaggeration` (v1/v2 field, range
[0.0, 3.0], default 1.0, unchanged), which applies once `terrain.enabled` is
true.

**heights** (`Heights`): `floor_height_m 3.0` [2, 5],
`unknown_default_m 8.0` [2, 60], `type_defaults` (`TypeDefaults`, no bounds):
`house 6`, `apartments 15`, `commercial 12`, `retail 6`, `industrial 8`,
`garage 3`

**bridges** (`Bridges`): `enabled true`, `clearance_mm 1.0` [0, 5],
`abutments true`

**height_exaggeration** (`HeightExaggeration`): `multiplier 1.0` [0.25, 4],
`curve 0.0` [0, 1]

**hero_auto** (`HeroAuto`): `enabled false`, `count 3` (int) [1, 12]

**tiling** (`Tiling`): `enabled false`, `cols 1` (int) [1, 6],
`rows 1` (int) [1, 6], `joint "dovetail"` (enum `dovetail`/`pin`),
`tolerance_mm 0.15` [0, 1], `index_mark true`

**frame_style** (`FrameStyle`): `profile "plain"` (enum: `plain`, `chamfer`,
`stepped`, `bevel_in`, `bullnose`, `ogee`, `floating`),
`corner "square"` (enum: `square`, `mitred`, `rounded`),
`corner_radius_mm 3` [0, 20], `lip_depth_mm 0.4` [0, 3]
- `shadow_gap` (`ShadowGap`): `enabled false`, `width_mm 1.0` [0.4, 5],
  `depth_mm 0.8` [0.2, 5]
- `matting` (`Matting`): `enabled false`, `width_mm 6` [1, 30],
  `proud_mm 0.4` [0, 3]
- `separate` (`Separate`): `enabled false`, `mount "snap"`
  (enum `snap`/`magnet`), `tolerance_mm 0.2` [0, 1]
- `texture` (`Texture`): `pattern "none"` (enum: `none`, `brush`, `knurl`,
  `hatch`, `dots`), `scale_mm 1.0` [0.3, 5], `depth_mm 0.2` [0.05, 1]

**hanger** extended: `none`/`keyhole`/`magnets`/`cleat`/`easel`, default
unchanged `"none"`.

**hanger_magnet** (`HangerMagnet`): `diameter_mm 6` [3, 20],
`thickness_mm 2` [1, 10], `count 2` (int) [1, 8]

**Engraving** extended: `mode` gains `"inlay"` (default unchanged `"engrave"`);
`edge` gains `"underside"` (still required, no default); `maxItems` on
`engravings` unchanged at 8.

## 3. Generator extensions

`packages/contracts/gen_py.py`: `py_default` was rebuilt on top of a new
recursive `py_value_expr(value, schema_fragment)` that renders a Python
constructor expression for a JSON value of any shape - scalar, non-empty
scalar list (`Colour.gradient.slots -> [2, 3]`), or nested object whose own
properties can themselves be further nested objects
(`FrameStyle.shadow_gap -> ShadowGap(enabled=False, width_mm=1.0,
depth_mm=0.8)`). The prior version only supported an empty list default and
one level of scalar-only dict defaults; every v1/v2 default (scalars, `[]`,
one-level dicts) renders byte-identical to before.

`packages/contracts/gen_ts.py`: `numeric_range_entries` and `limit_entries`
were rewritten from one-level lookups (`bounded()`, a flat nested loop) into
general recursive tree walks over `$defs`, each with a `seen: frozenset[str]`
cycle guard (no cycle exists in this contract set, but the walk no longer
assumes that). `render_range_lines` / `render_limit_node` render those trees
at arbitrary depth. `range_literal` moved from a closure inside `generate()`
to module scope so the new top-level renderer can call it. Every v1/v2
`PARAM_RANGES`/`PARAM_LIMITS` entry (one level deep) renders identically;
v3 adds real two- and three-level nesting
(`PARAM_RANGES.regions.rail.width_m`, `PARAM_RANGES.frame_style.shadow_gap.width_mm`,
`PARAM_LIMITS.colour.gradient.slots.max_items`).

Regenerated with `make contracts`. Both generated files are pure insertions
plus the four extended enums; no v1/v2 line was removed or reordered.

## 4. Test changes

`services/bake/tests/test_contracts.py`: added `PRINT_PARAMS_V3_EXAMPLE` (a
fully-populated v3 payload exercising every new group and every new enum
member) and `V3_PRINT_PARAM_FIELDS`; extended `test_print_params_round_trips`
and added `test_print_params_v2_round_trips`'s counterpart
`test_print_params_v3_round_trips`; added it to `VALID_EXAMPLES`; changed the
`schema_version` out-of-range case from `3` (now valid) to `4`; added ~50 new
`OUT_OF_RANGE_CASES` (one representative min/max or enum-member violation per
new group); added 7 new `MISSHAPEN_CASES` (`additionalProperties: false` on a
plain v3 `$defs` and on a doubly-nested one, `FrameStyle.shadow_gap`); added
22 new `UNDER_SPECIFIED_CASES` (every new top-level object accepts `{}` and a
partial object); generalized `test_ornaments_accept_a_partial_object_in_schema_and_model`
to compare via `model_dump(mode="json")` instead of per-field `getattr`, so it
also covers groups whose own members are themselves nested objects (`Colour`,
`Regions`, `FrameStyle`, `Heights`); extended
`test_the_default_nested_objects_are_complete_instances` with all twelve new
object-valued top-level fields; added
`test_default_print_params_matches_every_schema_default_recursively` (one
test, walks every top-level default - because dict equality is recursive it
verifies every leaf at every depth in one assertion); updated
`test_default_print_params_dump_validates_against_the_v2_schema` and
`test_schema_version_is_optional_and_not_required` for the enum/default move.
`REQUIRED_DEF_PROPERTIES["print_params.json"]` stays `9` (no new `$defs`
declares `required`).

`services/bake/tests/test_v1_compat.py`: both literal "keys the model adds"
sets extended with the fourteen v3 names (`[V3-P1c]`); the eleven original
tests are otherwise unchanged and all pass; the v1 golden geometry digest,
triangle/vertex counts, volume, warnings and byte-identical-outside-metadata
checks are untouched.

`apps/web/lib/contracts.test.ts`: `NESTED_KEYS` extended from six to eighteen
entries (`printer_profile`/`export_target` stay out - plain string enums, not
objects); added `ALL_OBJECT_PATHS` (33 entries: root + 18 top-level + 14
deeper paths the freeze walk also visits, e.g.
`$.frame_style.shadow_gap`, `$.colour.gradient.slots`) replacing the old
"root + NESTED_KEYS" assumption, which does not hold once a nested object's
own members are themselves nested objects; added "starts every v3 engine
feature switched off" test; `PARAM_LIMITS` exact-key-list test extended with
`place`, `colour`; added `PARAM_RANGES`/`PARAM_LIMITS` v3 coverage at one and
two levels of nesting. `schema_version` assertion moved from `2` to `3`.

## 5. Fixture regeneration

`fixtures/print-params-default.json` and `fixtures/lettering-expected.json`
were regenerated with `FRAMECRAFT_WRITE_PARITY=1` (the same mechanism v2
used). Diffed before accepting: both diffs are purely additive (the new v3
keys/defaults, plus `schema_version: 2 -> 3` everywhere it appears) with zero
change to any v1/v2 value, warning string, or lettering layout result.

## 6. Verify

```sh
cd services/bake && uv run pytest -q                                  # whole suite
cd services/bake && uv run pytest tests/test_v1_compat.py             # G8, 11 passed
cd services/bake && uv run pytest tests/test_contracts.py             # 187 passed
cd apps/web && npx vitest run lib/contracts.test.ts                   # 26 passed
cd apps/web && npm run typecheck
```

Regenerating (never hand-edit the outputs):

```sh
make contracts
cd services/bake && FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_contracts.py tests/test_lettering.py tests/test_tokens.py
```

## 7. State at hand-off

- Contracts are schema_version 3; re-frozen at the end of the v3 run per
  `[V3-A2]`.
- `services/bake`: full `uv run pytest -q` green (see the orchestrator reply
  for the exact count), including `test_v1_compat.py` (G8, all 11) and
  `test_contracts.py`.
- `apps/web`: `lib/contracts.test.ts` (26 tests) and `npm run typecheck` are
  green. **Known, expected fallout, not fixed here (out of this task's file
  ownership):** five other test files assert "PrintParams has exactly these
  keys" against `DEFAULT_PRINT_PARAMS` and now fail because it grew fourteen
  keys - `lib/advisor.test.ts`, `lib/share.test.ts`, `lib/warnings.test.ts`,
  `store/editor.test.ts`, `components/scene/CityPreview.test.ts`. Each needs
  its own guard list extended with the fourteen v3 names, the same edit
  already applied to `lib/contracts.test.ts`'s `NESTED_KEYS`/`ALL_OBJECT_PATHS`.
  Additionally, after the `terrain.exaggeration` correction below,
  `apps/web/store/editor.test.ts:108` and `apps/web/lib/warnings.test.ts:78`
  each construct `{enabled: true, exaggeration: 2.0}` against the now-removed
  field and fail `npm run typecheck`; both are a one-line fix (drop
  `exaggeration: 2.0,`) for whoever owns those files.
  `next build` and Playwright were not run (build lock held by another agent
  per this task's brief).
- Nothing committed; all changes are working-tree.
