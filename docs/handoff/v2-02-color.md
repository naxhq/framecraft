# v2-02 — Parts-based colour export, and the bake half of hero buildings

Scope: `services/bake/app/{bake,cli}.py`, `app/geom/{transform,thicken,extrude,assemble}.py`,
`app/export/mf3.py`, `app/validate/checks.py`, `apps/web/lib/transform.ts` (+ its
test — the shared pair is mine this phase), `tests/{test_bake,test_transform,test_validate_cli}.py`,
`fixtures/parity-*.json`, the Makefile's `bake-fixture` recipe.

`color_mode` defaults to `single`, `hero_building_ids` defaults to `[]`, and every
new code path is gated on one of those two, so **nothing about a v1 bake moved**:
`make bake-fixture` still reproduces the v1 golden geometry digest
`0e20725e…` byte for byte (verified on the file `make` wrote, not only through
`run_pipeline`), and `tests/test_v1_compat.py` is 11/11 green.

---

## 1. What parts mode writes

`PrintParams.color_mode = "parts"` makes Stage 3 write one 3MF `<object>` per
**non-empty** layer plus one per own-colour hero, assembled into a single object:

```
<resources>
  <basematerials id="1">
    <base name="base"      displaycolor="#D8D3C6FF"/>
    … one entry per part, in part order, always 8 hex digits …
  </basematerials>
  <object id="2" name="base"      type="model" pid="1" pindex="0"><mesh>…</mesh></object>
  <object id="3" name="frame"     type="model" pid="1" pindex="1"><mesh>…</mesh></object>
  …
  <object id="N+2" name="FrameCraft" type="model">
    <components><component objectid="2"/>…<component objectid="N+1"/></components>
  </object>
</resources>
<build><item objectid="N+2"/></build>
```

* Part order is `assemble.PART_ORDER`: `base, frame, buildings, hero…, roads,
  water, green, trees`. Heroes sit next to the buildings they stand on.
* Each hero object is named `hero:<osm id>` and carries the shared accent
  `#E3A72F` (the frozen `part_colors` has seven keys and no hero key), with its
  **own** `<base>` entry, so "one material entry per part" is literally true and
  a user can re-assign one slot per hero in the slicer.
* `mf3.normalize_color` upper-cases and pads to `#RRGGBBAA`; a value the
  contract's own pattern would reject raises rather than being written.
* The **STL is unchanged in both modes**: one welded body, written from the
  assembled solid. 3MF is 04's primary format; STL has no notion of parts.
* Single mode writes exactly the v1 package (one `<object id="1">`, no
  `<basematerials>`), byte for byte.

## 2. Part geometry — the exact z ranges

Everything is derived from `transform.py`. With the defaults (`base_thickness
3 mm`, engraved roads, water on) the z ranges are:

| part | z from | z to | contact with | overlap |
|---|---|---|---|---|
| `base` | 0.0 | 3.0 (`base_top`), **pocketed** to `inlay_bottom + 0.2` under every recess | — | — |
| `frame` | 2.8 (`base_top − 0.2`) | 5.0 (`+ FRAME_LIP_MM`) | base | 0.2 mm in z |
| `buildings` | 2.8 | `building_top_mm` | base | 0.2 mm in z |
| `hero:<id>` | `block_top − 0.2` | `building_top_mm_for(…, is_hero=True)` | buildings | 0.2 mm in z |
| `roads` (engrave) | 1.8 | 2.4 (`base_top − 0.6`, the recess floor) | base | 0.2 mm in z + 0.2 mm in xy |
| `roads` (emboss) | 2.8 | 3.4 | base | 0.2 mm in z |
| `water` | 1.9 | 2.5 (`base_top − 0.5`) | base | 0.2 mm in z + 0.2 mm in xy |
| `green` | 2.8 | 3.3 | base | 0.2 mm in z |
| `trees` | 2.8 | cone apex | base (and green, where a tree stands on it) | 0.2 mm in z |

The **inlay** is the whole point of the feature. A recess is subtractive, and a
hole has no colour, so each recess layer becomes a slab of its own filament
filling `[floor − PART_INLAY_MM, floor]` — entirely inside what single mode
prints as base — while the base part is pocketed from `inlay_bottom + 0.2` up.
The recess stays exactly as deep as it was; its **floor** now prints in the
water/road colour.

```
  z = base_top   ────────┐                    ┌────────   base part
  z = floor              └────────────────────┘           ← recess floor = inlay top
  z = floor−0.6  ┌────────────────────────────────┐       ← inlay (0.6 mm ≥ the brief's floor)
  z = floor−0.4  └── base part resumes here ──────┘       ← 0.2 mm of interpenetration
```

`PART_INLAY_MM = 0.6` is always safely inside the plate: `slab()` clamps a recess
to `base_thickness/2`, and the contract floors the base at 2 mm, so the inlay
bottom never drops below 0.4 mm. The inlay is also grown 0.2 mm **laterally**
(`extrude.inlay_slab`) — without it the inlay's side wall and the base's pocket
wall would be an exactly coincident vertical face for the slicer to arbitrate.
That rim is buried inside the base part, so it changes no printed surface.

Two overlapping recesses (water 0.5 mm, engraved roads 0.6 mm) are handled by
subtracting every *other* recess cutter from each inlay, so the deeper recess
owns the floor where they overlap and no inlay can stand proud of the model.

**The parts partition the model.** `base_part ∪ inlay = base_solid − cutter`
exactly, by construction: the pocket is the single-mode cutter with a deeper
bottom, and everything it removes below the floor is what the inlay puts back.
Measured on Chicago: union of the parts 167,624.1339 mm³ against the single-mode
solid's 167,624.1244 mm³ (5.7e-8 relative, tolerance 1e-6) with a bbox delta of
exactly 0.

## 3. Validator rows added (additive — nothing was weakened)

In the bake (`checks.validate_parts`, appended to the Stage 4 report **only** in
parts mode) and in `app.cli validate`:

| row | rule |
|---|---|
| `bodies` | every part is a non-empty solid with no debris shell (< 0.01 mm³), the file declares exactly one mesh object per part (= the component count), and the assembled union is **one connected shell**. |
| `part_meshes` | every part, on its own, is manifold, watertight, has positive volume and zero degenerate faces. |
| `parts_union` | the manifold union of the parts equals the single-mode solid: volume within 1e-6 relative, bounding box within 1e-6 mm. Bake only — the CLI has no second solid to compare against, so it *validates* the union instead. |
| `3mf_materials` | exactly one `<basematerials>`, one `<base>` per part, every `displaycolor` a real `#RRGGBBAA` (8 hex digits in the file even when the param had 6), every object's `pid`/`pindex` in range. |
| `3mf_components` | exactly one `<build><item>`, pointing at an object with `<components>` whose children all exist and are all mesh objects, one per part. |
| `3mf_color_mode` | the mode derived from the **file structure** and the mode recorded in the sidecar's `color_mode` agree. With no sidecar there is nothing to disagree with: the row records what the file says and passes. |

Redefined for the parts shape, never weakened for single mode:

* `3mf_objects` — single: "exactly one object". Parts: "N mesh objects + exactly
  one assembly object" (the assembly is what the slicer shows as one object).
* `3mf_counts` — the XML's vertex/triangle counts now sum over the parts.
* `bodies` — v1's "exactly one connected shell" still applies to single mode and
  to the STL, and in parts mode it applies to the **assembled union**.

**Deviation, deliberate:** the brief asked for "exactly one connected shell per
part". No city can satisfy that — the buildings layer of Chicago is 274 separate
blocks, the green layer 165 patches, and 04 stage 1's whole job is to decide
which blocks merge. A part is required instead to be a valid solid with no
debris shell, and connectivity is enforced where it means something (the union).
Recorded in DECISIONS as `[V2-P3]`.

**Which solid is judged.** The bake runs 04 stage 4 on the single-mode assembled
solid (the one the STL carries) and pins `parts_union` on top, so the two are
provably the same set. `app.cli validate` has only the file, so it computes the
manifold union of the parts (never the concatenation — the parts interpenetrate
by design, so concatenating them is a self-intersecting soup) and judges that.
That union is put through `assemble.finalize`, the same sliver sweep Stage 2
runs, because the boolean is performed *by the command*: re-triangulating two
interpenetrating parts left exactly one nanometre-wide triangle on the Chicago
fixture, present in no shipped artifact. Nothing in the file is repaired — every
part is loaded `process=False` and judged as-is by `part_meshes`.

`ValidationReport.to_table()` now prints a `  <row>: <message>` line under the
summary for each FAILING row. The value/threshold columns say which row failed;
only the message says which part, which colour, how far out.

## 4. Hero buildings — the bake half

`hero_building_ids` (max 12, SceneGraph ids) + `hero_mode`.

1. **`true_height`** (modes `true_height`, `both`). Shared math, mirrored in
   `transform.py` and `transform.ts` with identical names:
   `hero_ids`, `hero_mode`, `hero_true_height`, `hero_own_color`,
   `hero_height_ids`, `is_hero_id`, `building_is_hero`, `hero_height_scale`,
   `building_height_scale_for`, `building_top_mm_for`, `color_mode`,
   `parts_mode`. A hero's multiplier is `max(1.0, the multiplier its class would
   get)` — never below its true relative height, still growing with everyone.
   `building_top_mm` is now literally `building_top_mm_for(…, is_hero=False)`,
   so no existing value moved. `predicted_top_mm` / `model_too_tall` count
   heroes at hero height, so the 60 mm guard and the Bake button agree.
2. **`own_color`** (modes `own_color`, `both`): each hero is its own 3MF part in
   parts mode; in single mode it is simply unioned (one object, one body).
3. **Block-merge exemption** (any mode, because a hero must exist as a solid to
   be coloured): a hero's height never enters its block's area-weighted 80th
   percentile, and the hero is preserved as its own solid stacked on that block
   from `block_top − 0.2` — the same treatment 04 stage 1 already gives a
   footprint over 1.5× the block height, minus the 1.5× test. A hero that is the
   *only* contributor to its component owns the block outright (there is nothing
   to stack on). A hero **shorter** than its merged block cannot be shown
   separately; it is merged like any footprint and a warning names it.
4. Heroes are **never** exempt from the minimum-feature repair, the crop, or any
   Stage 4 check. A hero widened, or dropped, is reported by name.
5. Unknown hero ids: a warning naming them, otherwise ignored.

Warnings added: `… hero building ids are not in this scene and were ignored: …`,
`… hero buildings were dropped by the minimum feature repair: …`,
`… hero buildings are shorter than the block they merged into …`.

## 5. Parity fixture

`fixtures/parity-scene.json` is untouched. `fixtures/parity-expected.json` gained
a **fourth** case, `heroes-with-halved-multipliers` (plate/frame identical to
case 1 so the hero rule is the only thing that moves: `small_scale` and
`large_scale` both 0.5, heroes `w1019` the 300 m tower and `w1039` a 31 m
building, `hero_mode: both`, `color_mode: parts`), plus four new per-building
keys (`picked`, `is_hero`, `height_scale_for`, `top_mm_for`) and a per-case
`hero` / `color_mode` / `parts_mode` block. **Every previously committed value is
byte-identical** — verified by diffing the parsed JSON key by key, not by eye.
In the three hero-free cases `top_mm_for == top_mm` and `is_hero is false`, which
is what makes the addition provably additive; in the hero case the predicted top
is the hero's (31.0 mm) and not the tallest halved building's (17.0 mm).

## 6. Makefile

```sh
make bake-fixture                       # unchanged -> artifacts/chicago.3mf
make bake-fixture COLOR=parts           # -> artifacts/chicago-parts.3mf (+ .stl, .json, CREDITS.txt)
make bake-fixture COLOR=parts PLATE=256 # plate override, honoured by both modes
make bake-fixture PLATE=200             # single colour on a 200 mm plate
make validate artifacts/chicago-parts.3mf
```

`COLOR` accepts only `single`/`parts` (anything else exits 2 before baking).
Both overrides become a `--params` JSON object, so the sidecar records exactly
what was baked and `make validate` judges the file against those parameters.

## 7. Measured on this host

| bake | parts | triangles (3MF) | union vol | time |
|---|---|---|---|---|
| Chicago, defaults, single | — | 68,692 | 167,624.124 mm³ | 16 s |
| Chicago, defaults, parts | **6** (base, frame, buildings, roads, water, green) | 110,062 over 6 objects | 167,624.134 mm³ | 16 s |
| Chicago, `PLATE=256`, parts | **7** (+ trees) | 208,008 | 387,863.874 mm³ | 25 s |

Six at the default plate because no preset has a printable tree there — every OSM
tree radius is capped at 4.0 m, which is 0.37 mm at 1:10,714, under 04's 0.5 mm
floor (DECISIONS `[V2-P0]`, `[P4]`). Per-part shells on the default bake: base 1,
frame 1, buildings 274, roads 10, water 12, green 165 — 463 in total, one
connected union.

## 8. MANUAL slicer check (cannot be automated on this host)

A6 stays *proxied*, not passed. The automated proxies are `3mf_components`,
`3mf_materials`, `bodies`, `sits_at_zero` and the trimesh-Scene test. Do this by
hand once per release, on `artifacts/chicago-parts.3mf`:

**Bambu Studio** (tested shape: 1.9+)
1. `File ▸ Import ▸ Import 3MF…` and pick `artifacts/chicago-parts.3mf`.
2. The Objects panel must show **one object** ("FrameCraft") with a disclosure
   triangle, and under it **6 parts** named `base`, `frame`, `buildings`,
   `roads`, `water`, `green` — not 6 top-level objects and not 1 flat mesh.
3. Each part row has a filament chip. Assign a filament per part (the display
   colours are already distinct: warm grey / charcoal / blue / green). If the
   importer did not map the display colours to slots automatically, set them by
   hand — six clicks — and note that in the release notes.
4. Orbit to the river: the **water part must be visible in its own colour at the
   bottom of the recess**, 0.5 mm below the plate top, not flush and not hidden.
5. `Slice plate`. Expect **no** "object has been cut"/"non-manifold" warning, a
   filament change per part in the preview, and a first layer that is one solid
   180 × 180 mm square.
6. Preview layer ~12 (z ≈ 2.4 mm): the road grooves must appear in the road
   colour, surrounded by base colour.

**PrusaSlicer** (2.7+)
1. `File ▸ Import ▸ Import 3MF…`, keep "as a single object with multiple parts"
   if asked.
2. Right panel: one object, 6 sub-volumes with the same names. Right-click a
   part ▸ `Change extruder` to give each its own slot (in single-extruder mode
   the parts still slice as one body — that is expected).
3. `Slice now`: no errors, and `Preview ▸ Feature type` shows the parts as
   distinct volumes.
4. Sanity: `Object manipulation` reports 180 × 180 × 34.73 mm and z-min 0.

Failure modes worth reporting: parts imported as separate *objects* (means the
`<components>` object was ignored), any part offset from the others (means the
shared translation was lost), or the water part invisible (means the base was
not pocketed).

## 9. Tests

`tests/test_bake.py` (25 new): `test_parts_golden_chicago_passes_every_validator`,
`…_emits_six_parts_at_the_default_plate`,
`test_parts_3mf_loads_as_a_scene_with_one_watertight_geometry_per_part`,
`test_parts_golden_chicago_still_writes_one_welded_stl`,
`test_parts_all_seven_layers_become_parts`,
`test_parts_union_is_exactly_the_single_mode_solid`,
`test_parts_z_ranges_interpenetrate_by_the_04_overlap`,
`test_parts_the_base_is_pocketed_under_every_recess`,
`test_parts_material_entries_are_one_per_part_in_rgba8`,
`test_parts_writer_normalises_and_rejects_colours`,
`test_parts_validator_rejects_a_union_that_is_not_the_model`,
`test_parts_validator_rejects_debris_and_a_broken_part`,
`test_parts_mode_is_off_by_default_and_writes_the_v1_package`,
`test_parts_an_empty_layer_is_not_written_as_an_empty_object`,
`test_parts_survive_a_frame_off_recess_that_reaches_the_plate_edge`,
`test_hero_keeps_its_true_height_while_its_neighbours_halve`,
`test_hero_survives_block_merging_as_a_separate_solid`,
`test_hero_is_never_exempt_from_the_minimum_feature_repair`,
`test_hero_gets_its_own_3mf_part_when_the_mode_asks_for_a_colour`,
`test_hero_own_color_alone_changes_no_height`,
`test_hero_in_single_mode_is_simply_unioned`,
`test_hero_ids_that_are_not_in_the_scene_warn_and_are_ignored`,
`test_hero_shorter_than_its_block_is_reported_not_faked`,
`test_hero_alone_in_its_block_owns_the_block`,
`test_the_height_guard_counts_the_hero`, `test_api_bake_honours_color_mode`.

`tests/test_validate_cli.py` (12 new): `test_cli_passes_on_a_parts_3mf`,
`test_cli_parts_table_lists_every_stage4_check_and_the_new_rows`,
`test_cli_parts_rows_are_not_vacuous`,
`test_cli_fails_when_the_sidecar_disagrees_with_the_file`,
`test_cli_fails_a_single_file_whose_sidecar_claims_parts`,
`test_cli_parts_mode_is_derived_from_the_file_even_without_a_sidecar`,
`test_cli_fails_a_parts_file_whose_displaycolor_is_not_rgba8`,
`test_cli_fails_a_parts_file_with_a_pindex_out_of_range`,
`test_cli_fails_a_parts_file_with_a_missing_material_entry`,
`test_cli_fails_a_parts_file_with_a_dangling_component`,
`test_cli_fails_a_parts_file_with_two_build_items`,
`test_cli_fails_a_parts_file_with_a_floating_part`,
`test_cli_exit_code_for_a_parts_file_through_a_real_subprocess`.

`tests/test_transform.py` (+4) and `apps/web/lib/transform.test.ts` (+4) mirror
each other on the hero predicates, the hero multiplier, the 60 mm guard and the
new parity case.

One existing assertion was adjusted, not weakened:
`test_cli_fails_when_a_triangle_is_deleted` asserted "the LAST line names
watertight"; it now asserts the `FAILED:` summary line names it *and* that the
new per-row message line for `watertight` is present and reads
`is_watertight=False`.

## 10. Verify

```sh
cd services/bake && uv run pytest -q                      # 458 passed
cd services/bake && uv run pytest tests/test_v1_compat.py # G8, 11 passed
cd services/bake && FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_transform.py
cd apps/web && npx vitest run lib/transform.test.ts && npm run typecheck && npm run lint

make bake-fixture COLOR=parts && make validate artifacts/chicago-parts.3mf            # 6 parts
make bake-fixture COLOR=parts PLATE=256 && make validate artifacts/chicago-parts.3mf  # 7 parts
make bake-fixture && make validate artifacts/chicago.3mf                              # v1, unchanged
```
