# 03 - mesh-bake (phase P3)

`SceneGraph` + `PrintParams` -> one watertight `Manifold` -> `.3mf` / `.stl` /
sidecar `.json` / `CREDITS.txt`, gated by every validator in
`04_PRINTABILITY_SPEC.md`. Plus `POST /bake`, `GET /bake/{job_id}` and the
`bake` / `validate` CLI subcommands that `make bake-fixture` and
`make validate` call.

## Files written (nothing outside this list was touched)

```
services/bake/app/geom/thicken.py     Stage 1: 2D minimum-feature repair (ground metres)
services/bake/app/geom/extrude.py     Stage 2a: shapely -> manifold3d, base plate, frame, cones
services/bake/app/geom/assemble.py    Stage 2b: batched tree union, sanitation, sit-at-zero
services/bake/app/export/__init__.py  sidecar JSON + CREDITS.txt writers
services/bake/app/export/mf3.py       3MF writer (zip, 3 parts) + metadata reader
services/bake/app/export/stl.py       binary STL writer, manifold3d -> trimesh boundary
services/bake/app/validate/checks.py  Stage 4: validate(mesh, params) -> ValidationReport
services/bake/app/validate/__init__.py
services/bake/app/bake.py             NEW: pipeline orchestrator + in-process job registry
services/bake/app/main.py             ADDED POST /bake, GET /bake/{job_id}, main.build_scene()
services/bake/app/cli.py              ADDED `bake` and `validate` subcommands
services/bake/tests/test_bake.py      NEW: 67 offline tests
services/bake/pyproject.toml          +scipy +networkx +lxml +fast-simplification (see below)
services/bake/uv.lock                 relocked
docs/handoff/03-mesh-bake.md          this file
DECISIONS.md                          +30 [P3] lines
```

`app/geom/transform.py` was **not modified**: no function was added, so
`apps/web/lib/transform.ts`, `fixtures/parity-*.json` and
`tests/test_transform.py` are untouched and still pin the two implementations to
each other. Every scale, threshold, height, Z offset, tree filter and plate
extent the bake uses comes from that module.

## Pipeline

### Stage 1 - minimum-feature repair, 2D, ground metres (`thicken.py`)

Per layer, in 04's order.

**Buildings**

1. rings -> shapely via `make_valid` (never `buffer(0)`), holes shrunk by 1e-6
   and *subtracted* rather than passed to `Polygon(shell, holes)`, so a hole
   that touches its own exterior is a clean notch (04 trap list).
2. hydraulic width `w = 4A/P` and dilation `d = (min_wall - w)/2`, both from
   `transform.building_footprint_metrics`, applied with
   `buffer(d, join_style=2)`. Counted for the warning.
3. drop under `min_detail^2`; then `widen_to_min_wall` repeats the dilation in
   tenths of a wall until the footprint survives the erosion probe, because
   04's hydraulic formula leaves a *strip* at `min_wall - t` (see DECISIONS).
4. close the layer: `union.buffer(g).buffer(-g)`, `g = min_gap/2`, mitre joins.
5. re-split into components; each takes the **area-weighted 80th percentile**
   of the heights it swallowed (smallest height whose cumulative area reaches
   80%), inheriting that contributor's `is_tall`. Any contributor over `1.5x`
   the block height becomes a second solid on top of the block.
6. final clip against the crop square, already inset 0.05 mm (04 trap list);
   blocks first, then towers clipped to the *surviving* blocks so none can
   float.

**Roads** buffer each centreline by
`max(width_m * road_scale, min_wall)/2` (flat caps, round joins), union, close
at `min_wall/2` (see below), subtract the buildings, clip.

**Water / green** buffer-clean, subtract in precedence order
(water -> roads -> green), drop under `min_detail^2`, clip. Water recesses
0.5 mm, green raises 0.3 mm, both from `transform`.

**Trees** `transform.tree_visible` + the 2000 cap from
`transform.select_tree_indices`, minus any tree standing on a building, a road
or (our addition) water.

**Numerical hygiene applied to every layer** - the part that made the
difference between "manifold" and "manifold with 1931 zero-area faces":

* snap-round onto a **0.01 mm print grid** (`shapely.set_precision`), because
  OSM arrives on a 1 mm *ground* grid = 1e-4 mm of print at 1:10000;
* open by two grid cells keeping the components **separate**, so a hairline
  limb is measured on its own and dropped instead of riding along on a fat
  body;
* re-snap, then strip collinear vertices (a straight edge with a mid-point
  triangulates into a zero-area cap);
* union the whole layer once more on the grid (`finish_layer`), so two
  independently snapped neighbours cannot overlap by a fraction of a cell;
* grow any subtrahend by 0.02 mm (`separate`) so no two solids ever meet on an
  exactly coincident vertical face;
* `merge_recess_ridges`: measure every island of the recesses' complement with
  the validator's own erosion probe and hand the failing ones to the deepest
  recess. An engraved road is a groove; what prints is the complement.

### Stage 2 - extrusion and assembly, print millimetres (`extrude.py`, `assemble.py`)

The single conversion point is `extrude.contours_mm`. Polygons become
`manifold3d.CrossSection` contours with `shapely.geometry.polygon.orient(p, 1)`
(CCW exterior, CW holes, `FillRule.Positive`) and are extruded with
`CrossSection.extrude`. Nothing is round-tripped through STL mid-pipeline and
no trimesh boolean is used anywhere.

* base plate: the plate square from 0 to `base_thickness`, with the bottom
  outer edge chamfered 0.6 mm at 45 degrees (a tapered extrusion of the inset
  square whose `scale_top` grows it back to full size over exactly the same
  rise);
* frame lip: 6 mm border ring from `base_top` to `base_top + 2`;
* buildings from `base_top - 0.2` to `transform.building_top_mm` (0.6 mm floor);
  towers from `block_top - 0.2` to their own top;
* additive slabs (green +0.3, embossed roads +0.4) overlap 0.2 mm into the
  plate; subtractive slabs (engraved roads, water) run from their depth up to
  `base_top + 0.5` so a recess also cuts a raised feature, and never reach z=0;
* trees: `Manifold.cylinder(h, r, 0, 8)`, height 3r;
* **union in batches of 200 with `Manifold.batch_boolean(Add)`, then the batch
  results pairwise in a tree**, after deduplicating by identity (04 trap list);
* cutters are subtracted *after* the union, so a groove cannot be refilled;
* `finalize`: drop zero-volume boolean debris, `simplify(1e-6 mm)`, and if any
  face under 1e-9 mm^2 survives, weld vertices agreeing to 1e-6..1e-3 mm and
  re-import through manifold3d, accepting the repair only on `NoError` with the
  same volume to 1e-6 relative;
* translate so `min Z == 0.0` exactly and the model is centred on X and Y.

### Stage 3 - export (`export/`)

`mf3.write_3mf` builds the zip itself (`ZIP_DEFLATED`) with exactly three
parts, in order: `[Content_Types].xml`, `_rels/.rels`, `3D/3dmodel.model`. The
model is `unit="millimeter"`, `xmlns` the 2015/02 core namespace, one
`<object id="1" type="model">` with `<vertices>`/`<triangles>`, one
`<build><item objectid="1"/></build>`. Metadata (reserved names only):
`Title`, `Designer`, `Description`, `Copyright`, `LicenseTerms`, `Application`,
`CreationDate`. `Description` carries
`© OpenStreetMap contributors, ODbL`, the location
(`lat lon radius_m rotation_deg preset_id`) and every `PrintParams` field.

Coordinates are `%.12f` fixed point. **At 6 significant digits trimesh reloaded
the Chicago plate as non-manifold** - the rounding merged distinct vertices.

`stl.write_stl` writes binary STL via `trimesh.exchange.stl.export_stl`;
`stl.to_trimesh` is the one and only manifold3d -> trimesh conversion
(`process=False`, float64 via `to_mesh64`).

Alongside every export: `<stem>.json` (attribution, licence, timestamp, the
exact `SceneRequest`, the exact `PrintParams`, the full `BakeResult`, the scene
stats, the validation report and per-stage timings - every block round-trips
through the generated models) and `CREDITS.txt`.

### Stage 4 - validators (`validate/checks.py`)

`validate(mesh, params, *, manifold=None) -> ValidationReport`; `to_table()`
renders the CLI table. Methods:

| Check | Method |
|---|---|
| `manifold` | `Manifold.status() == NoError` when the solid is in hand, **and** `is_watertight and is_winding_consistent` |
| `watertight` | `is_watertight`, `euler_number` even and `<= 2 * body_count` (chi = 2(B - genus); body count from `Manifold.decompose()` or `trimesh.body_count`) |
| `volume` | `volume > 0` and `volume == abs(volume)` (inverted normals) |
| `self_intersection` | manifold3d's guarantee, recorded with two computed pieces of evidence: every edge shared by exactly two faces and no duplicate triangles (complete), plus a deterministic grid-broad-phase sample of up to 6000 faces / 400k pairs tested for edge-triangle crossings |
| `bounding_box` | X, Y `<= plate_mm + 0.01`; Z `< 60` |
| `sits_at_zero` | `abs(bounds[0][2]) <= 0.001` |
| `min_wall` | see below |
| `triangle_budget` | `< 2,000,000`; `enforce_triangle_budget` decimates to 1.5M first |
| `degenerate_faces` | zero faces under 1e-9 mm^2 |

**min_wall, in full.** 12 stratified Z heights from a seeded RNG
(`seed=20260829`, so the answer is identical run to run). Each height is cut
into 2D solid regions - with `Manifold.slice` when a Manifold can be built from
the mesh, `trimesh.section` + even-odd nesting otherwise (a test asserts the two
agree; `Manifold.slice` is preferred because `trimesh.section` returns a *ring
soup* and two solids touching at one point come back as a single
self-intersecting ring, which any even-odd nesting misreads). A region counts
as a **wall** only if it still holds 70% of its area 0.25 mm higher: that is
what stops a tapering tip - 04 models trees as cones and allows a 0.5 mm
printed radius, so an apex is a point, not a wall - from reading as an
infinitely thin wall, while a vertical wall keeps 100% of its area. A counted
region **fails** when `buffer(-0.45 * min_wall_mm)` empties it, i.e. it is
under `0.9 * min_wall_mm` in every direction (04's fail rule). The **reported**
number is the hydraulic width `4A/P` - the same measure 04 stage 1 uses, so the
repair and the gate speak one language; for a long strip it is twice the
caliper width. Both conditions must hold.

On any failure the pipeline returns `status: "failed"` with `error` naming the
check, moves the `.3mf`/`.stl`/`.json` into `artifacts/debug/<job_id>/` (so
nothing unvalidated is ever downloadable) and dumps every intermediate solid
there as STL: `base`, `frame`, `buildings`, `roads`, `water`, `green`, `trees`,
`final`.

## API and CLI

* `POST /bake` `{scene_request, print_params}` -> `202 {"job_id": "<10 hex>"}`
  immediately. The job takes an `asyncio.Semaphore(2)` (extra jobs queue), then
  `asyncio.to_thread`s the scene build (through the same `main.build_scene` -
  same preset resolution, same 24 h disk cache, same LRU as `POST /scene`) and
  then the pipeline. Progress lands on `BakeResult.progress`:
  scene 0.05, repair 0.25, extrude 0.45, union 0.8, export 0.9, validate 1.0.
* `GET /bake/{job_id}` -> `BakeResult`; 404 for an unknown id, otherwise always
  200. A refused or crashed bake is `status: "failed"` with `error`, never a
  500. `stats.coverage == "empty"` is refused with "no OpenStreetMap buildings
  in this area: try a larger radius or a different location".
* `GET /files/{name}` unchanged (already path-traversal safe); outputs are
  `artifacts/<job_id>.3mf|.stl|.json` and `BakeResult.files` holds
  `/files/<job_id>.3mf`.
* `uv run python -m app.cli bake --preset chicago-loop --out ../../artifacts/chicago.3mf [--params JSON|@file] [--lat --lon --radius --rotation] [--offline]`
  runs the pipeline synchronously, writes all four files next to `--out`,
  prints the validator table plus stats and warnings, exits non-zero if any
  validator fails.
* `uv run python -m app.cli validate <file.3mf|.stl> [--plate-mm] [--nozzle-mm]`
  loads with `trimesh.load(..., force="mesh", process=False)`, reads plate and
  nozzle from the sidecar `<stem>.json` when present, prints the table, exits
  0/1.

## Measured on this host (Windows 11, 32 cores, uv + Python 3.12)

Bake only, default `PrintParams`, excluding the scene build. All six presets
pass **every** validator.

| preset | buildings | bake | triangles | volume mm3 | est. g | min wall | repair / assemble / export / validate |
|---|---|---|---|---|---|---|---|
| chicago-loop | 994 | **2.9 s** | 68 742 | 167 598 | 72.7 | 0.802 | 2.00 / 0.30 / 0.13 / 0.43 |
| new-york-midtown | 2 683 | 2.7 s | 62 410 | 337 286 | 146.4 | 1.161 | 1.74 / 0.23 / 0.13 / 0.64 |
| paris-eiffel | 2 905 | 4.5 s | 103 158 | 122 196 | 53.0 | 0.805 | 3.19 / 0.44 / 0.21 / 0.66 |
| tokyo-shinjuku | 5 401 | **6.6 s** | 132 820 | 138 779 | 60.2 | 0.807 | 3.99 / 0.69 / 0.27 / 1.60 |
| london-city | 2 197 | 5.8 s | 111 872 | 140 542 | 61.0 | 0.799 | 4.23 / 0.47 / 0.22 / 0.86 |
| san-francisco-fidi | 2 648 | 3.7 s | 86 432 | 161 070 | 69.9 | 0.820 | 2.60 / 0.29 / 0.17 / 0.61 |

02's budget is 90 s and the aim was under 30 s; Tokyo, the 5 401-building
worst case, is **6.6 s**. Tokyo does *not* exceed budget. `make bake-fixture`
end to end (scene from fixture + bake + export + validate) is 6.7 s.

Profile shape: shapely Stage 1 is 60-70% of every bake, manifold3d Stage 2 is
5-10%. **The batched tree union never showed up as a cost** (0.23-0.69 s), so
04's batching advice is satisfied with room to spare and the optimisation
pressure is on shapely, not on the boolean engine.

Also measured (Chicago, all validators passing in every row): road mode
engrave/emboss/off, frame on/off, water on/off, trees on/off, plate 100 and
256 mm, base 2 and 8 mm, nozzle 0.1 and 1.2 mm, `road_scale` 0.5 and 2.0,
`small/large_scale` 0.5, and several combinations - 18 parameter cases, 0
failures.

`est_grams` is an **estimate**: `volume_mm3 / 1000 * 1.24 * 0.35`, i.e. PLA at
15% infill with 3 walls. It is labelled as an estimate in the CLI output and
should be in the UI too.

## Warnings emitted

Verbatim strings, Chicago at default params:

```
443 buildings widened to meet minimum feature size
3 buildings dropped below the minimum printable size
block heights merged for 126 components
16 tall buildings preserved above their block
5762 trees dropped
107 water/green areas dropped below the minimum feature size
```

"5762 trees dropped" is not a bug: 04 only emits a tree whose *scaled* site
radius reaches 0.5 mm, which at a 900 m radius on a 180 mm plate needs a 5.4 m
OSM tree radius, and Chicago has none (web-editor measured the same thing,
DECISIONS [P4]).

## Tests

`services/bake/tests/test_bake.py`, **67 tests, ~15 s**, all offline.

* **golden** - the Chicago preset through the real ingest path at default
  params: every validator passes, triangles under 2M, bbox within 180x180 and
  under 60 mm, `min z == 0`, centred, `is_manifold`, `est_grams > 0`, the
  measured `min_wall`, the four artifacts on disk, the bake time printed and
  asserted under 90 s, and the written `.3mf` re-validated after a round trip
  through trimesh.
* **stage 1 synthetic** - single square; two buildings across a sub-minimum gap
  (must merge) and across a printable gap (must not); the 80th-percentile block
  height with a preserved tower, and that tower's printed height; a courtyard
  that survives and one below `min_gap` that fills; a self-intersecting bow-tie
  ring; an empty scene (base + lip only, still valid); a speck widened to
  exactly `min_wall`; a degenerate collinear ring; sub-detail areas dropped; a
  thin sliver widened; nothing coincident with the plate edge.
* **layers** - engrave/emboss/off volume ordering (`emboss > off > engrave`);
  roads never tunnel through buildings; road width clamped to `min_wall`;
  engrave depth never cuts through a 2 mm base; water removes volume, green
  adds it, `water=false` is a no-op; trees filtered by size / building / road,
  capped at 2000 keeping the largest, and baked as cones.
* **stage 2** - frame on/off; the chamfer measured at the bottom face; the
  0.2 mm building overlap; batched union tree-shaped, deduplicating, empty-safe;
  one body sitting at zero and centred; CW input winding fixed before extrusion;
  holes extrude as holes (`genus == 1`); a hole touching its own exterior.
* **export** - the 3MF zip has exactly the three parts, all deflated,
  `unit="millimeter"`, the core namespace, one object, one build item; metadata
  carries the attribution, the location and the parameters; a non-reserved
  metadata name is refused; CREDITS.txt; the sidecar round-trips through
  `BakeResult` / `SceneRequest` / `PrintParams` and serialises `"3mf"` (not
  `file_3mf`); the STL is binary and reloads.
* **validators, proven non-vacuous** - a mesh with a hole, inverted normals, a
  model off the bed, one wider than the plate, one over 60 mm, a 0.3 mm wall
  (fails) and a 3 mm wall (passes), determinism of the probe, a cone tip
  ignored, a degenerate face counted, the decimation path, and
  `section_polygons` agreeing with `Manifold.slice`.
* **failure handling** - a bake that fails `bounding_box` is quarantined into
  `artifacts/debug/<job_id>/` with `base.stl`, `buildings.stl`, `final.stl` and
  the `.3mf`, and nothing is left in the output directory; an `empty` scene is
  refused with a message about the radius; progress hits all six stages in
  order.
* **API** - `POST /bake` for the Chicago preset answers in under 2 s with a
  10-hex job id, polls to `done`, the three artifacts exist under `artifacts/`
  and `GET /files` serves them; unknown job 404; an empty scene becomes a
  failed job with a clear error; a scene-build exception becomes a failed job,
  not a 500; an out-of-range parameter is a 422; `/files` path traversal.

Whole suite: `cd services/bake && uv run pytest -q` -> **264 passed in ~52 s**
(197 pre-existing, unchanged and still green).

## Verify

```
cd services/bake && uv run pytest -q
make bake-fixture && make validate artifacts/chicago.3mf     # G3
```

Both were run on this host: 264 passed; `make bake-fixture` 6.7 s, ALL CHECKS
PASS; `make validate artifacts/chicago.3mf` ALL CHECKS PASS, exit 0.

## Known limitations

* **The 60 mm ceiling is reachable from the UI.** Chicago with
  `large_scale = 2.0` is 66.5 mm tall and fails `bounding_box`. The bake does
  not clamp - clamping would silently diverge from the preview, which 01 calls
  the worst failure mode - so the editor should warn before the bake. The
  failure message names the height and the slider.
* **`min_height_m` is ignored.** The contract carries it, `transform.py` has no
  function for it and the preview does not use it either, so a building on
  stilts prints solid to the ground. Consistent between preview and bake.
* **`terrain_exaggeration` is a no-op**, as 01 requires: the heightmap is flat
  and `transform.terrain_z_scale` returns 1.0. The parameter and the code path
  exist for the day the DEM fetcher is switched on.
* **Reported `min_wall_mm` is a hydraulic width**, not a caliper reading. For a
  long strip it is twice the true width. It is the measure 04 stage 1 uses, and
  the pass/fail gate is a true erosion probe, but the number in the stats card
  should be read as "narrowest feature, 04's own measure".
  *SUPERSEDED by the Fix pass below: it is now the inscribed-circle diameter of
  the narrowest appendage, i.e. a true caliper reading, and the same number
  decides the verdict.*
* **The self-intersection check is a spot check plus a guarantee**, exactly as
  04 frames it. Exhaustive triangle-pair testing on a 130k-face mesh is out of
  budget; the edge-topology half is complete.
* **`fast_simplification` cannot load on this host** (Windows Application
  Control, like `ruff` in DECISIONS [P1]), so `enforce_triangle_budget` runs its
  manifold3d fallback here. The quadric branch is the one that will run in CI.
  No preset comes close to 2M triangles (max 133k), so neither branch fires in
  normal use.
* **`ruff` still cannot run on this host**; style was kept to the configured
  rules by hand and an AST pass was used to confirm there are no unused imports.
* Road `class` is not filtered: Chicago's 5 443 roads are 3 982 footways, and
  they are all buffered and engraved. That matches the preview exactly, which is
  the priority, but a "drop sidewalks above N metres radius" rule would make the
  print cleaner. Raise it as a product decision, not a bug.
* The bake holds the whole scene in memory in the worker thread; two concurrent
  Tokyo bakes are roughly 2 x 300 MB. The semaphore is 2 for that reason as much
  as for CPU.
---

# Fix pass (fixer, P3)

Five verified defects from the independent audits, all fixed inside
`services/bake/app/{geom/thicken.py, geom/extrude.py, geom/assemble.py,
validate/checks.py, bake.py, cli.py}` and `tests/test_bake.py`.
`packages/contracts/` and `app/geom/transform.py` were **not touched**, so the
frozen schemas, `apps/web/lib/transform.ts` and `fixtures/parity-*.json` are
unchanged and `test_contracts.py` / `test_transform.py` / `test_ingest.py` are
untouched and green.

## 1. Trees could not be printed with any nozzle over ~0.45 mm

The cause was **not** the tree size. `min_wall`'s "is this a wall or a tapering
tip?" test looked one FIXED 0.25 mm layer ahead, and a cone's cross-section
shrinks by a third of the look-ahead per layer, so the band of a cone that got
*measured* always started at a 0.51 mm radius, i.e. a 0.94 mm wall - under
`0.9 * min_wall` for every nozzle above ~0.45 mm. No tree radius can fix that,
because every cone tapers through that band; making the radius bigger only adds
wider slices above it. The look-ahead is now one printed layer,
`wall_persist_mm = 0.625 * nozzle`, which is exactly 0.25 mm at the default
0.4 mm nozzle (the reported widths there are unchanged to the last digit).

Separately, 04's 0.5 mm printed tree radius is *nozzle-independent*, but an
8-gon of circumradius `r` is only `2 r cos(pi/8)` wide across its flats, so at
0.5 mm the base of the cone is 0.92 mm - under one bead from a 0.5 mm nozzle up.
`thicken.tree_min_radius_mm` raises the floor to whatever puts a full minimum
wall across the base; at 0.4 mm it is 0.433 mm, so 04's 0.5 mm still binds and
nothing changes. Bake-only, like the "does not intersect a building or a road"
half of 04's tree rule, and it only ever drops trees the preview showed.

Measured: lone cones r = 0.55..5.0 mm pass at nozzle 0.1/0.4/0.5/0.6/0.8/1.2
(they failed at 0.6+ before). Chicago re-cropped to 250 m - 740 tree nodes, 161
to 308 emitted depending on the nozzle - bakes `done` with every validator green
at nozzle 0.4, 0.5, 0.6, 0.8 and 1.2.

## 2. No fast fail on 04's 60 mm Z ceiling

`bake.predicted_top_mm(scene, params)` maxes `transform.building_top_mm` over
the buildings with the frame top and the tree cone tops - every term from the
same `transform.py` the preview draws with - and `run_pipeline` raises
`ModelTooTallError` (a `BakeError`) before Stage 1, naming the height and the
sliders. Chicago at radius 450 m and default parameters is refused in 0.000 s
with "this model would print 66.5 mm tall", the exact height the full pipeline
took 2.3 s to discover and then quarantine.

The prediction is an upper bound (Stage 1's area-weighted block percentile can
only lower a tower, never raise one) and it is *tight* for an isolated building,
which the tests pin. The Stage 4 `bounding_box` validator is still the gate:
`run_pipeline(..., height_guard=False)` skips only the shortcut, and the
quarantine test uses it so the build-then-fail-then-dump path stays exercised.

**Left for web-editor** (outside this pass's file scope): mirror the same
predicate in `apps/web` from `lib/transform.ts` to disable/annotate the Bake
button, and hide a tree under `max(0.5, nozzle / cos(pi/8))` mm of printed
radius in the preview.

## 3. Sub-minimum-wall wings shipped, unseen by Stage 1 and by the gate

Both sides judged a region by "does `buffer(-0.45 * min_wall)` leave anything?",
which is a question about the *region*: a 0.5 mm wing on a 40 mm block passes.
chicago-loop shipped 18 wings over 1 mm long and 1 mm tall, five of them over
10 mm tall.

The width is now measured per appendage on both sides, through one shared
function (`thicken.narrowest_width`): the region's inscribed width, lowered by
the inscribed width of every part the opening at `0.45 * min_wall` leaves
behind. Stage 1 repairs what it finds -

* `widen_thin_parts` - 04's dilation rule applied to the wing, after the layer
  closing, where growing is legal;
* `strip_thin_parts` - cut it off, after the crop and on the additive surface
  layers, where growing would undo the clip;
* `repair_slice_profiles` - the neck that exists only in a horizontal SLICE.
  What prints at height z is the union of the solids that reach that high, and
  two preserved towers overlapping by a corner make a 0.5 mm neck above their
  block that neither footprint has. Sorted by printed top, the solids present at
  z are exactly a PREFIX of the sorted list, so walking the prefixes covers
  every cross-section the model can have;
* `merge_recess_ridges` - the same, for the base ridges *between* the recesses,
  now per appendage, over the whole plate rather than the crop square, and with
  enough passes to verify itself.

Three numerical details each cost a bake to find and are documented in
`DECISIONS.md`: the opening is grown by `0.02 * min_wall` before the difference
(GEOS leaves a micrometre-wide "rind" along every long edge whose *area* looks
like a real wing); the residue noise floor is `0.25 * min_detail^2`, not
`min_detail^2` (GEOS splits one wing into two halves in ground metres and leaves
it whole in print millimetres, straddling the full floor); and every pass is
iterated four times, breaking early, because repairing a wing exposes the next
one and a pass that ends by repairing has not verified itself.

Verified with the audit's own script, `artifacts/audit/thinwalls.py`:

| model | residues before | after |
|---|---|---|
| chicago-loop | 29 (18 >= 1 mm tall) | 0 |
| chicago plate 100 | 21 | 0 |
| chicago nozzle 0.6 | 21 (19 >= 3 mm tall) | 0 |
| london-city | - | 0 |
| tokyo-shinjuku | 16 (5 >= 10 mm tall) | 1, zero height |

## 4. Two false `min_wall` failures on contract-legal requests

`validate` used two different measures - it *reported* the hydraulic width
`4A/P` and *failed* on an erosion probe - and could therefore print "0 of 4
sampled regions are under 1.080 mm (narrowest 1.014 mm)": a failure with nothing
failing. Both are replaced by one robust measure,
`2 * shapely.maximum_inscribed_circle(region, 0.01 * min_wall).length`, used for
the number and for the verdict, with 04's `< 0.9 * min_wall` rule unchanged.

* rotation 37 deg, radius 900: the failing "region" was a building triangle
  0.84 mm across whose `Manifold.slice` outline carried three T-junction
  vertices 0.3-0.7 um off its edges; GEOS' negative buffer of the 6-vertex
  version is empty where the 3-vertex one is not. Now `done`, narrowest 0.881 mm.
* radius 3000: the jagged base island whose hydraulic width was 0.49 mm is
  0.85 mm across its inscribed circle. Now `done`, narrowest 0.806 mm.

Stage 1 uses the same measure with a wider target (`MIN_WALL_REPAIR_FACTOR = 1.0`,
04's own dilation target, against the gate's 0.9) so the repair and the gate
cannot disagree across the ground-metres/print-millimetres boundary.

## 5. `make validate` always failed on the bake's own STL

A binary STL is an unindexed triangle soup, so `trimesh.load(process=False)`
returned 206 226 vertices for 68 742 faces and every edge belonged to one face.
`cli._index_stl_triangle_soup` welds the *exactly* coincident vertices (bitwise
`np.unique`, never a tolerance pass, so it cannot close a real crack) and prints
how many it merged.

That exposed a second, real defect: a binary STL stores float32, and one float32
step at a 90 mm coordinate is 7.6e-6 mm - enough to collapse 8 of Chicago's
triangles and create 4 non-manifold edges. `assemble.finalize` now also requires
the mesh to survive that round trip (`float32_defect_count`), which one 1e-6 mm
weld achieves at a cost of 8 triangles and no measurable volume change.
`make validate` passes on `artifacts/chicago.3mf` **and** `artifacts/chicago.stl`.

## Verification

```
cd services/bake && uv run pytest -q            # 282 passed (was 268)
make bake-fixture && make validate artifacts/chicago.3mf
make validate FILE=artifacts/chicago.stl
```

Fourteen tests were added and none were deleted, skipped, xfailed or loosened.
The only existing test edited is the quarantine test, which now passes
`height_guard=False` so it keeps failing at the Stage 4 `bounding_box` validator
(every assertion in it is unchanged) instead of at the new fast guard.

Beyond the suite, re-verified by hand: all six presets at default parameters;
Chicago at nozzle 0.1/0.3/0.5/0.6/0.8/1.0/1.2, plate 100/256, frame off, road
emboss/off, water off, trees off, all-minimum and all-maximum sliders; Chicago
re-cropped to 250/450/900/3000 m and rotated 37 deg; and tree-bearing scenes at
five nozzles. Every one is `done` with all nine validators green, or refused in
under a millisecond by the height guard (`chi-maxall`, 71.5 mm; `r450`, 66.5 mm).

## Cost

Chicago bakes in 5.5 s against 2.9 s before (02's budget is 90 s); tokyo-shinjuku
10.2 s against 6.6 s. The appendage passes are the difference: an inscribed
circle and an opening per region, per Stage 1 layer and per validator slice.
Triangle counts move by under 1% and every narrowest-wall reading improved
(chicago 0.810 mm against a 0.720 mm threshold, tokyo 0.803, london 0.821).
