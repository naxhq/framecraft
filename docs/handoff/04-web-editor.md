# 04 - web editor (phase P4, web-editor)

The `/` editor: MapLibre picker, preset row, react-three-fiber preview,
parameter panel, Generate and Bake flows, stats card, warnings, themes.
Plus the deliverable everything else hangs off: **the shared transform math**.

---

## 1. Shared transform math (the important part)

`services/bake/app/geom/transform.py` is the single source of every scale,
threshold, printed height and z offset in `04_PRINTABILITY_SPEC.md`.
`apps/web/lib/transform.ts` mirrors it function-for-function with **identical
snake_case names**, so the two files diff side by side.

Both are pinned to `fixtures/parity-expected.json`, which
`services/bake/tests/test_transform.py` regenerates and asserts on every run and
`apps/web/lib/transform.test.ts` re-derives independently in TS.

```
make contracts is unrelated here; regenerate the parity fixture with:
  cd services/bake && FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_transform.py
```

### API (identical on both sides)

| function | returns |
|---|---|
| `usable_span_mm(params)` | plate minus 2x6 mm when the frame is on |
| `scale_mm_per_m(params, radius_m)` | **print mm per ground metre** |
| `radius_m_from_bounds(bounds)` | the radius the SceneGraph was built with |
| `thresholds_ground_m(params, scale)` | `{min_wall, min_gap, min_detail}` in ground m |
| `terrain_z_scale(params)` / `terrain_z_mm(...)` | 1.0 / 0.0 (flat MVP heightmap) |
| `base_top_mm`, `plate_extents_mm`, `content_extents_mm`, `frame_geometry_mm` | plate + frame in mm |
| `building_height_scale`, `building_top_mm`, `building_bottom_mm` | roof / floor z in mm |
| `ring_area_m2`, `ring_perimeter_m`, `building_char_width_m`, `building_dilation_m`, `building_dropped`, `building_footprint_metrics` | stage-1 footprint repair |
| `road_width_ground_m`, `road_z_mm` | road width in ground m, z in mm or `null` |
| `water_z_mm`, `green_z_mm`, `area_dropped` | surface layers |
| `tree_radius_mm`, `tree_visible`, `tree_height_mm`, `select_tree_indices` | stage-1 trees incl. the 2000 cap |

Constants (`FRAME_WIDTH_MM` 6, `FRAME_LIP_MM` 2, `CHAMFER_MM` 0.6,
`BUILDING_OVERLAP_MM` 0.2, `MIN_BUILDING_HEIGHT_MM` 0.6, `WATER_RECESS_MM` 0.5,
`GREEN_RAISE_MM` 0.3, `EMBOSS_MM` 0.4, `ENGRAVE_MAX_MM` 0.6, `CROP_INSET_MM`
0.05, `TREE_MIN_RADIUS_MM` 0.5, `TREE_HEIGHT_FACTOR` 3, `TREE_CAP` 2000) live in
both files and are asserted equal through the fixture.

`transform.py` is **stdlib only** and duck-typed with `typing.Protocol`, so
mesh-bake imports it unchanged in phase 3 and passes the generated pydantic
models straight in. Nothing in it needs numpy or shapely.

### Parity fixtures

- `fixtures/parity-scene.json` - phase 1's hand-authored Chicago SceneGraph plus
  a 3x80 m sliver, a 3x3 m shed, a 12x12x210 m tower, three larger trees and a
  5x5 m green patch, so dilation, the tall/short split, tree visibility and the
  sub-detail drop are all exercised. Kept separate from `chicago-scene.json`
  (geo-ingest regenerates that from real Overpass data).
- `fixtures/parity-expected.json` - 3 parameter cases x every derived value.
  Case 1 defaults; case 2 plate 256, frame off, small 0.5, large 2.0, emboss,
  road scale 2.0, terrain 3.0; case 3 plate 100, base 8, nozzle 0.6, roads off,
  water off. Scales are 0.0933 / 0.1422 / 0.0489 mm/m; dilation, tree selection,
  road z and the green drop all differ between cases, so parity is not vacuous
  (there is a test asserting exactly that).

TS compares print-mm values within **0.01 mm** and ground-metre values within
0.01 mm *of print* (`diff * scale`); booleans and counts must match exactly.

---

## 2. Component map (`apps/web`)

```
app/layout.tsx           pre-paint theme script, persistent "© OpenStreetMap contributors" footer
app/page.tsx             server component -> <EditorShell/>
app/globals.css          Tailwind v4 + @custom-variant dark (class-driven, not prefers-color-scheme)

components/editor/
  EditorShell.tsx        3-column layout: map+presets | preview+warnings | params+bake+stats
  PresetRow.tsx          GET /presets on mount, labels from lib/presets.ts, click = apply + Generate
  ParamPanel.tsx         every 01 control + nozzle; percent sliders map to the 0.5..2.0 floats
  Controls.tsx           Slider / Toggle / Segmented / PanelSection primitives (stateless)
  BakeButton.tsx         Generate + Bake, progress bar, download links, bake warnings
  StatsCard.tsx          BakeResult.stats, filament labelled "estimate"
  WarningBanners.tsx     coverage + estimated-heights + stale + scene-error banners
  ThemeToggle.tsx        light/dark, persisted

components/map/
  MapPane.tsx            dynamic(ssr:false) boundary
  LocationPicker.tsx     MapLibre + OSM raster, pin, radius handle, circle, rotated crop square

components/scene/
  PreviewPane.tsx        dynamic(ssr:false) boundary
  CityPreview.tsx        Canvas, lights, grid, OrbitControls, memo keys, approximation note
  BasePlate.tsx          slab + 4-bar frame lip
  InstancedBuildings.tsx one InstancedMesh, matrix-only updates
  RoadRibbons.tsx        one merged ribbon mesh, in-place buffer reuse
  AreaSurfaces.tsx       water/green merged into one earcut geometry per layer
  TreeInstances.tsx      one InstancedMesh of an 8-sided cone, axis pre-rotated to +z

lib/  api.ts  bake.ts  contracts.ts (GENERATED)  geo.ts  presets.ts  preview.ts
      transform.ts  warnings.ts
store/editor.ts
scripts/copy-maplibre-worker.mjs   (predev / prebuild)
```

## 3. Store shape (`store/editor.ts`)

```ts
location  { lat, lon, radius_m, rotation_deg, preset_id }   // the only refetch trigger
params    PrintParams                                        // never triggers a fetch
scene     { status: idle|loading|ready|error, graph, message, request, stale }
bake      { phase: idle|queued|running|done|failed, jobId, progress, result, error, warnings }
presets   { status, items, message }
theme     "light" | "dark"
```

Actions: `setPin` / `setRadius` (snaps to 10 m, clamps 250..3000) / `setRotation`
/ `applyPreset` mark the scene stale; `setParam` / `resetParams` do not.
`generate()` POSTs `/scene` (aborting any in-flight request), `loadPresets()`
GETs `/presets`, `requestBake()` POSTs `{scene_request, print_params}` and then
polls `GET /bake/{id}` every second through the pure reducer in `lib/bake.ts`
until the phase is terminal. `scene.request` is the exact `SceneRequest` that
produced the graph, and the bake reuses it verbatim.

`store/editor.test.ts` drives **every** key of the frozen `PrintParams` through
`setParam` with `fetch` spied on and asserts zero calls; it also asserts the
list of keys equals `Object.keys(DEFAULT_PRINT_PARAMS)`, so a new contract field
cannot slip past the test.

## 4. How the preview approximates the bake

`lib/preview.ts` takes `SceneGraph + PrintParams` and emits plain numbers and
typed arrays in print millimetres (no three.js import, so it unit-tests in
node). Every dimension comes from `lib/transform.ts`; the only geometry it
computes itself is *shape*.

| bake (04) | preview | why |
|---|---|---|
| real footprint polygons, unioned | minimum-area oriented bounding rectangle per building, one InstancedMesh | 5000 buildings at interactive rates; boxes are what a slider can update in 0.06 ms |
| `buffer(d)` then `union.buffer(g).buffer(-g)` closing | per-footprint widen by `2*d`, floored at `min_wall_ground` | the browser never runs booleans, so neighbours are **not** merged - the canvas says "the bake merges buildings closer than X m" using the real `min_gap_ground` |
| buildings extruded from `base_top - 0.2` | drawn from `base_top` | the 0.2 mm overlap only disambiguates the bake's union and is hidden inside the slab |
| engraved roads cut 0.6 mm into the slab | flat ribbons drawn just above the base top | cutting is a boolean; a surface under an opaque slab is invisible |
| water recessed 0.5 mm | flat surface just above the base top, blue | same |
| green raised 0.3 mm | flat surface at `base_top + 0.3` | exact |
| trees rejected if they hit a building/road | only the 0.5 mm radius rule is applied | the intersection test needs shapely |
| bottom chamfer 0.6 mm | omitted | invisible at preview scale |
| roads subtracted from buildings | not subtracted | boolean |

Everything else - scale, min-feature thresholds, printed heights and the 0.6 mm
clamp, the tall/short multiplier split, road widths and the min-wall clamp,
tree selection and cone size, plate/frame extents, drop decisions - is the
*same code path* as the bake, through `transform.ts`.

Slider cost, measured on the real 994-building Chicago SceneGraph (node):
`buildBuildings` 1.7 ms, `buildRoads` 2.8 ms (55k triangles), earcut for 352
green polygons 1.5 ms, `buildTrees` 0.1 ms, whole `buildPreview` 4 ms,
`buildingInstanceMatrices` **0.06 ms** (1.6 ms at 5000 buildings). Memo keys in
`CityPreview` mean a height slider only re-runs the last one.

## 5. Warnings and gating (`lib/warnings.ts`)

- `coverage === "empty"` or `building_count < 20` -> **blocking** banner
  "Fewer than 20 buildings here (N) - enlarge the radius or move the pin", Bake
  disabled (01/A2). Both the banner and the button read the same function.
- `coverage === "sparse"` -> "Low building coverage: N buildings; consider a
  larger radius."
- `height_tag_ratio < 0.15` -> "Building heights are largely estimated from OSM
  tags (only N% carry a real height)." (03)
- plus a stale-location banner and a scene-error banner.

## 6. The MapLibre worker trap (read this before upgrading maplibre)

maplibre-gl 6 resolves its worker with
`new URL("./maplibre-gl-worker.mjs", import.meta.url)`. Next's bundler rewrites
`import.meta.url` to the **document URL**, so the request lands on the app's 404
HTML page, the module worker fails to parse, and it dies **silently**: no error
event, raster tiles keep rendering, and every GeoJSON source stays empty
forever. That is why the radius circle and the crop square rendered nothing at
first, with a completely clean console.

Fix, in two halves that must stay together:

1. `apps/web/scripts/copy-maplibre-worker.mjs` copies `maplibre-gl-worker.mjs`
   and the `maplibre-gl-shared.mjs` chunk it imports into `public/maplibre/`;
   wired to `predev` and `prebuild` in `package.json`, output gitignored.
2. `LocationPicker.tsx` calls `setWorkerUrl("/maplibre/maplibre-gl-worker.mjs")`
   at module scope (client-only, behind the `ssr:false` boundary).

## 7. Verification run on this host

```
cd services/bake && uv run pytest tests/test_transform.py -q        # 19 passed
cd services/bake && uv run pytest -q                                # transform + contracts green
cd apps/web && npx tsc --noEmit && npm run lint && npm test         # clean / clean / 82 passed
cd apps/web && npm run build                                        # compiled, 4/4 static pages
```

Live check with the real bake API (`uv run uvicorn app.main:app --port 8000`)
and `npm run dev`, driven through Playwright's Chromium:

- six presets from `GET /presets` with the DECISIONS labels;
- OSM raster tiles, attribution control, radius circle, rotated crop square,
  draggable pin and radius handle;
- Chicago preset -> 994 buildings, 1:8654, "335 widened to the 6.9 m minimum
  wall", estimated-heights warning at 11 %;
- Paris preset -> map flies, 2905 buildings, Seine and Champ de Mars visible;
- **0 `/scene` calls** from any PrintParams slider; 1 per preset click; 1 per
  rotation release;
- theme toggle flips `<html class="dark">` and the canvas background;
- Bake shows the real error `/bake failed (HTTP 404): Not Found` because
  mesh-bake has not landed `/bake` yet - no mock, no fallback;
- console clean apart from that 404, a React devtools notice, SwiftShader
  performance notes and one `THREE.Clock` deprecation warning from drei.

## 8. What is stubbed / left for others

- **`/bake` and `/bake/{id}` do not exist yet** (mesh-bake, phase 3). The whole
  client flow is implemented against the frozen `BakeResult` contract and unit
  tested with canned results **in the test file only**; the UI currently shows
  the real 404. Nothing else is needed on the web side when the endpoints land.
- **Terrain** is wired end to end (`terrain_exaggeration` slider ->
  `terrain_z_scale` -> preview and bake) but returns a flat 1.0 z-scale; the
  panel says "flat terrain in the MVP" (01 out-of-scope).
- **Trees** currently render as 0 for Chicago and Paris. That is 04's rule
  working: OSM tree radii there are below the ~5.4 m needed for a 0.5 mm printed
  radius at a 180 mm plate. Preview and bake agree.
- **Mobile layout polish** is out of scope per 01; the grid collapses to one
  column under `lg` but is not tuned.
- `e2e/` is untouched - qa-gate owns the Playwright specs. Useful hooks already
  in the DOM: `data-testid` on `preset-row`, `map`, `map-pin`,
  `map-radius-handle`, `preview-canvas`, `preview-empty`,
  `preview-approximation`, `warnings`, `warning-coverage-empty`,
  `warning-coverage-sparse`, `warning-estimated-heights`, `scene-stale`,
  `scene-error`, `generate-button`, `bake-button`, `bake-status`,
  `download-links`, `stats-card`, `theme-toggle`, plus `id`/`data-preset-id`
  attributes on every control (`plate_mm`, `base_thickness_mm`, `nozzle_mm`,
  `small_scale`, `large_scale`, `terrain_exaggeration`, `road_mode`,
  `road_scale`, `trees`, `water`, `frame`, `radius_m`, `rotation_deg`) and
  `<id>-value` testids for their readouts.

## 9. Notes for qa-gate

- **Do not run `next build` while `next dev` is up.** It rewrites `.next` under
  the dev server, which then serves 404 chunks and 500s the page. Build first,
  or restart dev afterwards.
- Frame rate could not be measured meaningfully here: headless Chromium falls
  back to SwiftShader, where a single idle frame of the Chicago preview costs
  ~45 ms regardless of our code. The JS side is measured and fast (section 4);
  01/A3's 30 fps needs a real GPU to confirm.
- The first `/scene` for a non-preset location hits Overpass and can take
  several seconds; presets are served from committed fixtures.

## 10. Fix pass (audit round 1)

Four verified defects, four fixes, no test weakened and no contract field
touched. `packages/contracts/` untouched; `lib/contracts.ts` untouched.

### 10.1 `lib/geo.ts` -- the crop square was drawn the wrong way round

`project.py`'s `LocalFrame.to_local` rotates the **geometry** counter-clockwise
by `+rotation_deg` (`xr = x cos - y sin`, `yr = x sin + y cos`) and *then*
clips it to the axis-aligned square. The region of the world that survives is
therefore that square mapped back through the inverse rotation, i.e. turned
**clockwise** by `rotation_deg` -- which is exactly what DECISIONS [P2] always
said the picker had to draw. `cropSquareRing` was drawing it CCW, so the
overlay only agreed with the printed crop at multiples of 45 deg (which is why
the Chicago/45 deg checks passed). At New York's 29 deg the drawn corners landed
at 1.378 x radius in the model frame and the square sat 58 deg away from the
printed one.

Fix: apply the inverse rotation (`east = x cos + y sin`,
`north = -x sin + y cos`). `geo.test.ts`'s direction test now asserts the SW
corner swings from bearing 225 to bearing **270** at +45 deg, and a new test
takes each drawn corner back to an ENU offset, applies the server's `+theta`
and asserts it lands on `(+-r, +-r)` for 0/17/29/45/90/233/359 deg. The old CCW
code fails that test at every angle that is not a multiple of 45.

The [P4] DECISIONS line claiming the server applies `-rotation_deg` is
superseded; `geo.ts`'s docstring now states the real convention and cites [P2].

### 10.2 `components/scene/AreaSurfaces.tsx` -- holes were painted over

`Shape.extractPoints()` repeats each contour's first point at the end;
`ShapeUtils.triangulateShape` calls `removeDupEndPts`, which pops those
duplicates **in place**, and then numbers the hole vertices off the *shortened*
outline. The vertex array was concatenated *before* that call, so every hole
index was off by one per preceding contour. Reproduced on the installed three
0.185.1 with a 100x100 ring and a 20x20 island: `extractPoints` yields 5+5
points, `triangulateShape` shrinks them to 4+4, max face index 7 against a
10-element array, signed area 9800 instead of 9600 and 7 triangles covering the
island centre. `fixtures/chicago-scene.json` ships 2 water and 2 green polygons
with holes (Paris has more), so this was live on real data.

Fix: build the vertex array after `triangulateShape`, the way three's own
`ShapeGeometry` does. The loop is now the exported pure function
`areaTrianglePositions(areas)` so it can be tested in node without a WebGL
context; `AreaSurfaces.test.ts` asserts merged area == ring area - hole area
and that no triangle contains a hole centroid, for one hole, two holes and two
merged areas. It stayed in the component rather than moving to `lib/preview.ts`
because that module's rule 3 is "no three.js".

### 10.3 `components/scene/CityPreview.tsx` -- height sliders rebuilt the layers

`thresholds` was `useMemo(..., [params, scale])`, and `store.setParam` rebuilds
`params` by spread on every write, so `thresholds` got a new identity on every
tick of every slider. The water and green memos list it, so `buildAreas` re-ran,
`AreaSurfaces` re-triangulated all 711 green polygons of the 900 m Chicago crop,
allocated a fresh `BufferGeometry`, disposed the old one and re-uploaded it --
per frame of a `small_scale` / `large_scale` / `base_thickness` / `road_scale` /
`terrain` drag. ~1.5 ms in node, so the 33 ms budget still held, but it is a
direct violation of 02's "rebuild only the affected instance buffer when a
slider moves".

Fix: all seven memo keys now come from the exported `previewDeps` map, which
lists only primitives read off `params` plus the identity-stable `graph`.
`thresholds` is keyed on `[scale, params.nozzle_mm]`; water/green on
`[graph, scale, params.nozzle_mm(, params.water)]`. `scale` is a number, so an
identical recomputation stays identity-stable and does not propagate.

`CityPreview.test.ts` replays React's own rule (recompute iff a dep fails
`Object.is`) over those exact arrays: the four height/terrain sliders rebuild
**nothing**, while nozzle/plate/frame/road/tree/water still rebuild precisely
the layers they change (so the assertion is not vacuous), no dep is ever a
non-`graph` object, and the PrintParams key list is checked against the frozen
contract so a new field cannot slip past.

### 10.4 `components/editor/Controls.tsx` -- keyboard navigation hit Overpass

`Slider` wired `onKeyUp={onCommit}` and `onPointerUp={onCommit}` with no change
detection, and `onCommit` for #radius_m / #rotation_deg is `generate()`.
Verified live: Tab into #radius_m, Tab on into #rotation_deg and release Shift
= three POST /scene with zero value change. Five quick ArrowRight taps = five
POST /scene (four client-aborted, which does not stop the server's Overpass
query, measured 6.6-11.5 s each).

Fix: `createCommitGate(run, delayMs)` -- `onChange` marks dirty, release
commits only when dirty, and the commit is debounced by
`COMMIT_DEBOUNCE_MS = 250` so a burst of taps costs one request. `onKeyUp` is
additionally filtered by `isValueChangingKey` (Arrow*/Home/End/PageUp/PageDown,
rejecting Tab/Shift/Escape/Enter and any Ctrl/Meta/Alt chord). The gate is
created once per Slider (`useRef`), reads the latest `onCommit` through a ref
because ParamPanel passes an inline arrow, and is cancelled on unmount.

`Controls.test.ts` drives the real exported helpers: Tab/Shift/Tab and a
click-without-drag each cost **0** `fetch` calls against the real store, five
arrow taps cost exactly **1** with the final coalesced radius on the wire, and
the key predicate is enumerated both ways.

The suggested `store.generate()` short-circuit was deliberately not added: it
would make the Generate button a silent no-op on a ready, non-stale scene, and
the gate already removes every no-change request.

### 10.5 Verification

```
cd apps/web && npm run lint && npm run build && npm test
cd services/bake && uv run pytest -q
```

eslint clean, `next build` clean (4 static routes), vitest 103 passed across 9
files (was 79 across 6), pytest 197 passed. No dev server was running during
the build, per the section 9 warning.

---

## 11. Follow-up (phase P5, web-editor): mirroring the two bake-only rules

Phase 3 added two rules to the bake that the editor did not mirror. Both are
preview/bake divergences, which 01 calls the worst failure mode, and
DECISIONS [P3-fix] explicitly left them for this phase ("NOT DONE, outside this
fix pass's file scope and left for web-editor"). They are now shared math.

### 11.1 What moved into `transform.py` / `transform.ts`

Additive only, identical names and semantics on both sides, mirrored in the
same commit, parity fixture regenerated:

| helper | meaning |
|---|---|
| `TREE_SIDES = 8` | 04 stage 1's "8-sided cone"; part of a tree's printed width |
| `MAX_HEIGHT_MM = 60` | 04 stage 4 "Bounding box", Z under 60 mm |
| `tree_min_radius_mm(params)` | `max(0.5, 2*nozzle / (2 cos(pi/8)))` mm |
| `tree_visible_for(tree, params, scale)` | `tree_visible` **and** the floor |
| `select_tree_indices_for(trees, params, scale)` | selection with the floor |
| `predicted_top_mm(scene, params, radius_m)` | max over buildings, frame, trees |
| `model_too_tall(scene, params, radius_m)` | `predicted_top_mm >= 60` |

`tree_visible(tree, scale)` keeps its two-argument signature: it is 04's literal
rule and the committed parity values depend on it. The floor is a second,
composable predicate rather than a new argument, so every existing call site and
every existing expectation stays valid.

`SceneLike` (Python `Protocol`, TS `interface`) is `buildings` + `trees` only;
the ground radius is an argument, so the caller passes the one it already has
(`radius_m_from_bounds(scene.bounds)` on the server, the preview's memo in the
browser) and nothing is resolved twice. `transform.py` stays stdlib-only.

### 11.2 The bake now calls the shared versions (no behaviour change)

- `app/bake.py::predicted_top_mm` is a three-line wrapper over
  `T.predicted_top_mm`. `run_pipeline`'s `height_guard` and
  `ModelTooTallError` are untouched.
- `app/geom/thicken.py::tree_min_radius_mm` is an alias for
  `T.tree_min_radius_mm`; `TREE_SIDES` is re-exported from `transform` (same
  value 8, so `extrude`'s cone and `test_bake.py`'s `thicken.TREE_SIDES` are
  unaffected); `select_trees` filters with `T.tree_visible_for` and picks with
  `T.select_tree_indices_for`. The unused `import math` went with it.
- `MAX_HEIGHT_MM` is duplicated in `transform.py` (which imports nothing) and
  `validate/checks.py` (which owns the validator); `test_transform.py` asserts
  the two are equal, and asserts `bake.predicted_top_mm == T.predicted_top_mm`
  for all three parity parameter sets, so the wrapper cannot rot.

288 pytest green (was 282; +6 in `test_transform.py`).

### 11.3 Parity fixture

`fixtures/parity-expected.json` gained, per case: `tree_min_radius_mm`,
`max_height_mm`, `predicted_top_mm`, `model_too_tall`, and per tree
`visible_for` / `selected_for`. The fixture is non-vacuous by assertion on both
sides:

| case | scale | tree floor | predicted top | too tall |
|---|---|---|---|---|
| defaults (180 mm, frame) | 0.0933 mm/m | 0.5 mm | 31.0 mm | no |
| 256 mm, no frame, large 2.0 | 0.1422 mm/m | 0.5 mm | **88.3 mm** | **yes** |
| 100 mm, nozzle 0.6 | 0.0489 mm/m | **0.649 mm** | 22.7 mm | no |

Case 3 has one tree that passes 04's 0.5 mm rule and fails the floor, so the TS
side cannot mirror a constant. Both suites assert within 0.01 mm as before.

### 11.4 Editor

- `lib/warnings.ts` gained `predictedTopMm(graph, params)` (null without a
  scene, and null for a degenerate zero-radius bounds so `scale_mm_per_m` can
  never throw in a render) and a second `block`-level warning, `model-too-tall`:
  `Model would be X mm tall (limit 60 mm) — lower the building scales or the
  plate size`. `sceneWarnings` and `bakeBlockReason` now take `params`.
  Coverage still blocks first, so a 5-building scene says "enlarge the radius"
  rather than complaining about the height.
- `warningDeps(graph, params)` is the exported `useMemo` key, the same
  discipline as `previewDeps` (DECISIONS [P4-fix]): `graph`, `plate_mm`,
  `frame`, `base_thickness_mm`, `small_scale`, `large_scale`, `trees` -- never
  `params` itself. `warnings.test.ts` walks every key of the frozen
  `PrintParams` and fails if a parameter that moves the prediction is missing
  from the list, or if a listed one turns out not to.
- `BakeButton` disables Bake on the block reason (it already did) and renders
  `Predicted height X mm of 60 mm` in red past the limit, with
  `data-testid="predicted-height"` and a `data-predicted-mm` attribute for the
  Playwright smoke test. `WarningBanners` shows the same sentence as a banner.
  `store.requestBake` passes `params` to `bakeBlockReason`, so the guard is on
  the button, the banner and the action.
- The preview HUD chip now reads `... · 34.7 mm tall`, plus a red
  `preview-too-tall` chip past the ceiling and a `preview-tree-floor` chip when
  a fat nozzle raises the tree floor ("A 0.8 mm nozzle drops trees under 9.3 m
  of site radius").
- `lib/preview.ts::buildTrees` filters with `select_tree_indices_for`, so the
  preview draws exactly the trees the bake keeps (modulo the
  building/road-intersection half of 04's rule, which needs a boolean and can
  only ever remove more). `treeFloorNoticeMetres` backs the new chip.
- `previewDeps.trees` gained `nozzle_mm` (the floor is nozzle-aware) and a new
  `previewDeps.height` key delegates to `warningDeps`.

**No new server call.** The prediction is one pass over `buildings[].height_m`
in the SceneGraph already in memory; the height sliders still fetch nothing.
`CityPreview.test.ts` now asserts that a height slider rebuilds *only* the
`height` memo and no geometry layer.

### 11.5 Verified at runtime

`make up`, real `/scene`, Chicago Loop preset at radius 900, headless Chromium,
zero console errors:

| large_scale | predicted (editor) | Bake |
|---|---|---|
| 100 % | 34.7 mm | enabled |
| 150 % | 50.6 mm | enabled |
| 200 % | 66.5 mm | **disabled**, banner + chip + reason |

34.7 mm is exactly the Z of the baked `artifacts/chicago.3mf` from G3, and
`POST /bake` with `large_scale: 2.0` answers
`failed | this model would print 66.5 mm tall, over the 60 mm limit`. Editor and
server agree to the digit, which is the whole point of the change. Note for the
orchestrator: Chicago at 200 % is *correctly* blocked -- DECISIONS [P3] already
recorded that it reaches 66.5 mm and that the bake refuses it.

### 11.6 Verification

```
cd apps/web && npm run lint && npm run build && npm test
cd services/bake && uv run pytest -q
```

eslint clean, `next build` clean (4 static routes), vitest **125** passed across
10 files (was 103 across 9), pytest **288** passed (was 282). No dev server was
running during the build.
