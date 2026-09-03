# v3-10 objects (Task 10: identify what you are looking at)

Every number below was produced by running the code in this tree against the
committed Chicago Loop fixture at 900 m radius, and each one is re-derived by a
test so it cannot quietly go stale.

## 1. Contract delta (schema_version 4)

`print_params.json`: `schema_version` enum `[2, 3]` -> `[2, 3, 4]`, default 3 ->
4. **No PrintParams field was added**, which is the point of [V3.1-O4]: v4 names
a SceneGraph revision, and the V3-1 matrix test fails any parameter leaf no
stage moves. `test_schema_migration.py::test_the_v4_revision_adds_no_print_params_field`
pins that.

`scene_graph.json`: `Building`, `Road` and `AreaFeature` each gain three
OPTIONAL, non-nullable strings.

| field | cap | present when |
| --- | --- | --- |
| `name` | 120 | the element has an OSM `name` tag and the scene is inside the name budget |
| `osm_id` | 32 | Building/Road: only when `id` carries a `-N` part suffix. AreaFeature: always (it has no `id`) |
| `kind` | 64 | the classifying tag as `key=value`. Road: only where it differs from `class` |

Two sparse-encoding rules, both lossless, both stated in the fields' own schema
descriptions and applied in exactly one place each (`normalize.ts` writes,
`lib/objectInfo.ts:sourceOsmId` / `roadKind` reads):

* **`osm_id` absent means `id` IS the source id.** Writing the duplicate on
  every entity cost 141 kB on Chicago, 11 % of the payload, for no information.
* **`Road.kind` absent means exactly `highway=<class>`.** Five of the ten
  highway values map onto the class of the same name, so the pair was the same
  words twice; the rule saved 32.7 kB and still resolves every road to a tag.

### The pinned test that did NOT have to be relaxed

`services/bake/tests/test_contracts.py::test_scene_graph_dumps_fixture_verbatim_without_by_alias`
asserts `SceneGraph(**fixture).model_dump() == fixture`, and pydantic v2 emits an
`Optional` field at `None` on every dump. `lib/engine/osm/types.ts` recorded that
as the reason the schema was left alone in v3.

The way through was in the schema, not in the test. These three properties are
optional AND non-nullable, so `null` is not one of their legal values: `None` on
the model means "the key was not sent", and a dump that wrote `null` would emit
an instance the contract itself rejects. `gen_py.py` now derives that (
`absent_by_default`: not required, no `default`, `null` not among its types) and
gives such a class a `@model_serializer(mode="wrap")` that drops those keys when
unset. No existing field matches the rule, so the generated output is unchanged
apart from the new members; `make contracts` is byte-stable on a second run.

`services/bake/tests/test_v1_compat.py` is green. `fixtures/print-params-default.json`
and `fixtures/lettering-expected.json` were regenerated (`FRAMECRAFT_WRITE_PARITY=1`);
the only line that moved in either is `schema_version`.

## 2. Measured SceneGraph size, before and after

Chicago Loop, 900 m: 992 buildings, 5 439 road segments, 41 water, 709 green.
Named: 432 buildings, 1 130 roads, 7 water, 19 green.

| | bytes | kB |
| --- | ---: | ---: |
| SceneGraph JSON before | 1 259 175 | 1 229.7 |
| SceneGraph JSON after | 1 457 891 | 1 423.7 |
| delta | +198 716 | +194.0 (+15.8 %) |

The v4 identity block is 211 897 B of the "after" figure (the delta is smaller
because buildings already carried `name` as a TS-only hint): `kind` 147 513,
`name` 47 198, `osm_id` 17 186.

**The cap: `SCENE_NAME_BUDGET_BYTES = 96 000`**, the UTF-8 bytes of `name` one
SceneGraph may spend. Chosen from the measurement above: Chicago spends 47 198,
so a scene up to twice its density loses nothing, and a 3 000 m scene with 8 000
buildings and 8 000 named road segments (roughly 450 kB of names) keeps only its
largest features'. Ranking is by printed footprint, largest first: polygons by
net area, roads by centreline length times width. Drops are counted into
`EngineStats.names_dropped`, and `lib/objectInfo.ts:nameBudgetWarning` turns that
into the Issues badge's `names-over-budget` entry (info level). Chicago drops
nothing, so the badge is silent there.

**Ingest time.** `sceneFromOverpass` over the 16k-element fixture is 483 ms
median on this host, against `normalize.test.ts`'s 1 500 ms budget; the budget
pass itself is 0.63 ms of that over 1 562 named entities, and the rest of the
identity work is per-element string handling of the same order. That timing
assertion failed once in a 100-file parallel vitest run competing with the
matrix suite's WASM builds, and passes repeatedly on its own. It is a wall-clock
assertion under contention, not a regression: 483 ms is a third of its budget.

## 3. The popover's data sources

Nothing in `components/scene/ObjectPopover.tsx` reads a `PrintParams` field, so
`CityPreview.test.ts`'s "no rendered layer reads a parameter" sweep needed no
new exemption. Everything is resolved in `lib/objectInfo.ts`, a pure function.

| shown | comes from |
| --- | --- |
| name, type, source element | SceneGraph v4 `name` / `kind` / `osm_id` |
| height, height source, footprint | SceneGraph `Building.height_m`, `height_source`, ring and holes |
| "Widened 0.28 m to reach the minimum wall" | `lib/preview.ts` `PreviewBuilding.dilation_m`, i.e. `transform.building_footprint_metrics`, the same predicate the engine repairs with |
| "Yes, this one is singled out" | the effective hero set `CityPreview` already computes (manual plus `hero_auto`), the set the worker resolves |
| road width, length, ribbon area | SceneGraph `Road.width_m` and path |
| water / green area | SceneGraph `AreaFeature` ring and holes |

An unnamed object is the common case and gets a full card: the heading falls
back to the type ("Footway", "Building"), the second line says there is no
OpenStreetMap name, and the facts below are identical.

Mechanics: `useObjectHover` throttles to 60 ms with a trailing pass (the pointer
usually STOPS on what the user wanted), holds the resolver in a ref so the
callback handed to the meshes never changes identity, and suppresses on any
pointer press until its release and on the wheel. Position is a `transform`
write through a ref; the content is state and is set only when
`ObjectInfo.key` changes, so sweeping one building re-renders one small
component once and the scene not at all. `RegionMeshes` attaches pointer
handlers only to the six pickable regions, so three.js does not raycast the base
or the frame on a move.

## 4. Picking accuracy, per kind

**Buildings: exact, no tolerance.** The `buildings`, `buildings_band_N` and
`hero_building` meshes carry `triangleOwner`/`owners` ([V3.1-P1-18]), and three's
`faceIndex` is the triangle ordinal `triangleOwner` is indexed by in both the
indexed and the recess-expanded branch of `buildGeometry`. `NO_OWNER` answers
nothing; a `block-<n>` owner answers "Merged block", which is the honest name for
several buildings the minimum-gap repair fused into one solid.

**Roads: nearest-entity in plan space, ranked by ribbon crossing.** The hit is
converted back to scene metres (`mm / scale`, the inverse of the single
multiplication `contoursFromRings` applies) and matched against the SceneGraph.
Ranking is `distance / (width/2 + 2 m)`, not raw distance: a hit at the outer
edge of a 16 m avenue is 8 m from its own centreline and can be 6 m from a
footway drawn beside it.

| sample | rate |
| --- | ---: |
| point on a road's own centreline names that road | 5 438 / 5 439 (99.98 %) |
| point at the ribbon EDGE names a road whose ribbon covers it | 99.1 % |
| ...names the exact way the surface came from | 59.1 % |
| ...names a road of the same printing class | 80.4 % |
| ribbon-edge points lying inside more than one road's ribbon | 47.9 % |

The 59.1 % is bounded by that last row, not by the lookup: the roads region is a
union with no per-triangle identity, so where two ribbons overlap there is no
single right answer to give. Cost is 0.09 ms per lookup over 5 439 segments,
once per throttled move.

**Water and green: containment first, nearest outline within 2 m otherwise.**
749 / 750 (99.87 %) of interior sample points name their own polygon. A point
inside a hole is inside no polygon and is rejected. `AreaFeature.osm_id` names
the LARGEST contributor to a dissolved polygon, not its only one, because water
and green are dissolved across elements; the field's schema description says so.

Rail, the base, the frame, the matting, the lettering and the mount parts are
not pickable: none is an OSM object, and a mesh with no handler is a mesh
three.js does not raycast.

## 5. Tint on the real solids, and picking without proxies

Two v3-06 audit findings, closed with the mechanism Task 10 already needed.

**C1, tint never reached the pixels.** The engine computed `buildingTints` and
the OBJ exporter wrote them; the only preview layer that had ever painted them
was deleted with the approximate stack, so nothing under `components/scene`
read `triangleOwner`, `owners` or `buildingTints` at all. `buildGeometry` now
takes a `TintMap` and, on a mesh that carries per-triangle identity, writes each
triangle its own building's colour into the same expanded colour attribute the
recess bands already used.

Two colour models share that buffer and which is in use is exactly whether the
mesh is tinted:

* untinted, the value is a MULTIPLIER on the material's colour (1 or the recess
  shade). Colour-space-neutral, material keeps `mesh.colorHex`, and an untinted
  region renders through the byte-identical path it always did.
* tinted, the value is the colour itself and the material is
  `MATERIAL_IDENTITY`. Absolute, because a per-building colour is not a multiple
  of the region's: the multiplier would be tint/region per channel, which
  divides by zero on a dark region and cannot exceed 1. `new Color(hex)`
  converts sRGB into the working space a vertex-colour attribute is assumed to
  already be in, which three does not do for attributes, so the tinted path
  renders the colour the material would have.

`MATERIAL_IDENTITY` is the CSS keyword `white`, not a design token and not a
hex. It has to be exactly (1, 1, 1) in every theme or a token redefined under
`.dark` would silently scale every building's tint, and a hex would fail
`lib/design-tokens.test.ts`'s no-raw-colour rule; `palette.ts`'s `MISSING`
keyword is the same precedent. The test asserts both the constant and that
three reads it as (1, 1, 1).

Verified end to end against a real engine build, not just in the unit test: on
the synthetic block scene with tint on, 3 buildings produce 3 owners, all 3
carry a tint, all 56 shipped triangles are owned, and they resolve to 3 distinct
tint colours. Cache invalidation is on the tint COLOURS (`tintsKeyOf`), not on
the array: `EngineResult` is a fresh object per run, so keying on the reference
would re-expand every building triangle after every build.

**C2, picking still used invisible proxies.** A click on a building region maps
`faceIndex` through `triangleOwner` to a building id, with the same 4 px
press-to-release slop the proxies used so an orbit that ends on a building is
not a pick, and a `block-<n>` or unattributed triangle is left alone rather than
promoted to a hero id nothing else knows. `BuildingPickProxies.tsx` and its test
are deleted, along with the `pickBuildings`/`pickParams`/`pickScale` props.

The viewport rule is stronger for it: no `PrintParams` object crosses the canvas
boundary now, not even to be passed through untouched. `CityPreview.test.ts`'s
exemption list is down to the two HUD hosts, its "names the type in only one
rendered file" case became "in no rendered file at all", and the deleted layer's
own invariant is replaced by one asserting picking goes through `ownerAt`.
`docs/handoff/v3-01-integration.md` records that named exception 1 is gone.

**The tint warning needed no change.** `lib/warnings.ts:306` says "Building
tint affects the preview and the OBJ export only". That overstated things only
because the preview half was missing; with C1 closed the sentence is exactly
true, so correcting it would have made it wrong.

One loose end: `lib/preview.ts:buildingInstanceMatrices` was the deleted
layer's, and now has no caller. Its tests are real and this module is not this
task's to reshape, so it is kept and its module docstring says so.

## 6. Contract consumers of `schema_version`

`lib/share.ts`'s `PRINT_PARAM_SPEC` literal is `[2, 3, 4]`; `parsePrintParams`
is the one door both a share link and a project file come in by, so that single
line is what makes a saved v4 file loadable. A v2 or v3 payload still loads and
is NOT rewritten: the parser returns the version the payload named.
`lib/project.test.ts` now round-trips a project per supported version and
refuses a 5.

Every other reader takes the VALUE and pins no literal, so none needed a change:
the export sidecar echo (`lib/engine/export/common.ts:458`), the `export` stage's
claim (`lib/engine/pipeline/stages.ts:1183`), the settings-diff exemption
(`lib/settingsDiff.ts:264`) and the matrix exemption
(`lib/engine/pipeline/matrix.probes.ts`). The permalink's own `v3.` tag is the
SHARE format version and is unrelated. There is no recent-designs store in this
tree (`store/` holds `editor.ts` and `layout.ts` only).

## 7. Tests

| suite | cases |
| --- | ---: |
| `apps/web/lib/engine/osm/normalize.identity.test.ts` | 14 |
| `apps/web/lib/objectInfo.test.ts` | 31 |
| `apps/web/components/scene/ObjectPopover.test.tsx` | 6 |
| `services/bake/tests/test_schema_migration.py` | 10 |
| `apps/web/e2e/objects.spec.ts` | 3 |
| `apps/web/components/scene/RegionMeshes.test.tsx` (tint + click rule) | +10 |
| `apps/web/lib/project.test.ts` (per-version round trip) | +4 |

Two tests were deleted with the code they tested: `BuildingPickProxies.test.ts`
(5 cases, all about the deleted layer's effect keys) and
`CityPreview.test.ts`'s "keeps the pick proxies invisible". Nothing was
weakened to make room: the sweep that file performs got STRICTER (no
`PrintParams` inside the canvas at all, where one used to be allowed through),
and the invisible-layer case was replaced by one asserting picking goes through
`ownerAt` and refuses a merged block.

The e2e sweeps a 63-point grid over the viewport rather than hard-coding a
pixel, then asserts the name and the height source on a named building, that the
popover closes over empty sky, and that it stays hidden through a four-step
camera drag and comes back after the release. It was written but NOT run here:
another agent holds the build lock, and Playwright needs the app built.

## 8. What the Python reference did NOT get, and why

`services/bake/app/ingest/normalize.py` still emits a pre-v4 SceneGraph. The
generated `contracts.py` accepts the identity fields (it has to: `extra="forbid"`
would otherwise reject a browser scene handed to the CLI validator), but the
reference does not produce them, on purpose:

* nothing reads them there. The reference is the printability validator and the
  v1 golden's parity partner; the popover is a browser feature.
* emitting them would mean regenerating `fixtures/chicago-scene.json`, which is
  the pre-v4 payload `test_schema_migration.py` uses AS its v1/v2/v3 migration
  case. Changing it would delete the evidence the migration works.

Producing them there is a one-function change if a later task needs it, and the
migration case should move to a frozen copy of the fixture first.

## 9. Files changed outside this task's own ownership

Each is a one-value consequence of the version bump, and each is load-bearing:

* `apps/web/lib/share.ts` and `share.test.ts`: the permalink codec's
  `schema_version` literal is `[2, 3, 4]`, or every link naming the current
  default would be refused.
* `apps/web/lib/contracts.test.ts`, `apps/web/lib/engine/pipeline/matrix.test.ts`,
  `services/bake/tests/test_contracts.py`: the asserted default moved 3 -> 4 and
  the "out of range" case moved 4 -> 5. No assertion was weakened.
* `apps/web/lib/issues.ts`: one row in `WARNING_TITLES` so the new warning has a
  title rather than repeating its own message.
* `apps/web/lib/preview.ts` and `apps/web/e2e/ui.spec.ts`: comments only, both
  falsified by deleting the pick proxies (one pointed at the deleted file, the
  other told the reader the click raycasts an invisible instanced mesh).
* `apps/web/lib/project.test.ts`: the per-version round trip the project-file
  half of the version bump needed.
