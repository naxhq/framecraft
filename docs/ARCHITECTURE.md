# FrameCraft architecture

Written from the source as it exists today. Spec references (`01`..`04` at the repo
root) are given where they explain intent; `DECISIONS.md` records every deviation.

## 1. System overview

Two runtime pieces and one generated contracts package.

| Piece | Path | Stack | Port |
|---|---|---|---|
| Web editor | `apps/web/` | Next.js 15 App Router, React 19, TS strict, Tailwind 4, zustand 5, react-three-fiber 9 + drei, MapLibre GL 6 | 3000 |
| Bake service | `services/bake/` | Python 3.12, FastAPI + uvicorn, shapely, pyproj, numpy, manifold3d, trimesh, httpx, pydantic v2, fontTools | 8000 |

Flow: MapLibre picker -> `POST /scene` (OSM via Overpass -> SceneGraph in local ENU
metres) -> live r3f preview -> `POST /bake` (manifold3d pipeline) -> `.3mf` / `.stl` from
`GET /files/{name}`. The browser never runs a boolean and the server never renders a
preview; both share one transform-math module mirrored in Python and TypeScript (3.1).

### 1.1 Contracts

`packages/contracts/schema/*.json` is the single source of truth for the four wire
shapes: `scene_request.json`, `scene_graph.json`, `print_params.json`,
`bake_result.json`. Two stdlib-only generators produce the bindings:
`packages/contracts/gen_py.py` -> `services/bake/app/contracts.py` (pydantic v2,
`extra="forbid"`, alias-aware for `3mf` and `class`) and `packages/contracts/gen_ts.py`
-> `apps/web/lib/contracts.ts` (interfaces, `DEFAULT_PRINT_PARAMS`,
`defaultPrintParams()`, `PARAM_RANGES`, `PARAM_LIMITS`). `make contracts` regenerates
both; neither is hand-edited. The package is frozen at schema version 2:
`PrintParams.schema_version` is the literal `2`, every v2 field is optional with a
v1-identical default, and `tests/test_v1_compat.py` pins a default v2 bake to the
committed golden under `fixtures/v1-golden/`.

Top-level `PrintParams` fields: `schema_version`, `plate_mm`, `base_thickness_mm`,
`nozzle_mm`, `small_scale`, `large_scale`, `terrain_exaggeration`, `road_mode`,
`road_scale`, `trees`, `water`, `frame`, `city_label`, `color_mode`, `part_colors`,
`engravings`, `north_arrow`, `scale_bar`, `hanger`, `underside_mark`,
`hero_building_ids`, `hero_mode`.

### 1.2 Make targets (`Makefile`, POSIX sh recipes)

| Target | What it does |
|---|---|
| `install` | `uv sync` (bake), `npm ci` (web), `npx playwright install chromium` |
| `contracts` | run both generators |
| `up` / `down` / `dev` | start or stop both services; docker compose if present, else native uvicorn + `next dev` with pid files in `.run/` and logs in `artifacts/logs/`; `up` health-waits up to 120 s; `FRAMECRAFT_WEB_MODE=prod` serves `next build && next start` |
| `test` | `pytest -q` then `vitest run` |
| `gate` | G4/G7: static no-skip guard, pytest (fails on skip/xfail), eslint, `tsc --noEmit`, vitest, `next build`, `make up`, Playwright, checked `make down`, stray-fixture check |
| `gate-v2` | G8 (v1 golden), G5 at plate 180 and 256 (`COLOR=parts`), G6 (`TEXT=all`), both composed; every output validated as `.3mf` and `.stl` |
| `bake-fixture` | `python -m app.cli bake --preset chicago-loop`; `COLOR=parts`, `PLATE=<mm>`, `TEXT=all` compose into distinct stems |
| `validate FILE=x` | `python -m app.cli validate <abs path>` |
| `refresh-fixtures` | `python -m app.cli refresh-fixtures` |
| `clean` | remove `.next`, baked artifacts, `.run`, logs |

`docker-compose.yml` builds both images, mounts `./artifacts` and `./fixtures` into the
bake container, and passes `NEXT_PUBLIC_BAKE_API_URL` as a build arg to the web image.

## 2. OSM ingest and the SceneGraph

### 2.1 Overpass client (`services/bake/app/ingest/overpass.py`)

- `build_query(request)` renders `QUERY_TEMPLATE`, the verbatim `03` Overpass QL, with
  one `{bbox}`: building ways and relations; highways matching
  `motorway|trunk|primary|secondary|tertiary|residential|unclassified|service|pedestrian|footway`;
  `natural=water` ways and relations; `waterway=riverbank`; landuse
  `grass|forest|meadow|recreation_ground`; leisure `park|garden|pitch`; `natural=tree`
  nodes; `out geom`, server timeout 180 s.
- `bbox_for(request)` projects the crop square plus 15 % (`BBOX_MARGIN = 1.15`) from the
  rotated local frame back to WGS84 via `LocalFrame.to_wgs84`, sampling edges and corners.
- Endpoints `PRIMARY_ENDPOINT = https://overpass-api.de/api/interpreter` and
  `MIRROR_ENDPOINT = https://overpass.kumi.systems/api/interpreter`; `_post` uses httpx
  with 180 s read, 30 s connect, User-Agent `FrameCraft/0.1`.
- `fetch_and_cache`: `MAX_ATTEMPTS = 3`, exponential backoff from `BACKOFF_BASE_S = 2.0`;
  HTTP 429/504 or a 200 with a runtime-error / out-of-memory `remark` (`fatal_remark`)
  switches the remaining attempts to the mirror. Error bodies are never cached.
- Fixture cache: accepted raw responses go verbatim to `fixtures/<sha1 of query>.json`
  (`query_sha1`, `fixture_path`) and `load_raw` reads the cache before any network call;
  `FRAMECRAFT_OFFLINE=1` raises `OverpassOffline` on any network attempt and
  `allow_network=False` raises `FixtureMissing` on a miss. `fixtures/presets-index.json`
  (written by `app/cli.py refresh-fixtures`) maps each preset id to its fixture file,
  fetch time, element count and byte size.

### 2.2 Presets (`app/ingest/presets.py`)

Six frozen `Preset` dataclasses (`chicago-loop`, `new-york-midtown` at rotation 29,
`paris-eiffel`, `tokyo-shinjuku`, `london-city`, `san-francisco-fidi`), all at
`PRESET_RADIUS_M = 900`. `preset_requests()` is what `GET /presets` returns; labels are
repeated client-side in `apps/web/lib/presets.ts`.

### 2.3 Projection and crop (`app/geom/project.py`)

`LocalFrame(lat, lon, rotation_deg)` picks the UTM zone from the centre (`utm_epsg`),
builds pyproj transformers both ways, and `to_local` projects, recentres and rotates
coordinate arrays in one vectorised pass (x east, y north, metres, origin at the request
centre, rotation counter-clockwise so bearing `rotation_deg` points at +y). `to_wgs84`
serves only the Overpass bbox. `crop_square`, `clip_polygon`, `clip_line`, `in_square`
perform the axis-aligned crop of side `2 * radius_m`. Web Mercator is never used.

### 2.4 Normalisation (`app/ingest/normalize.py`)

`build_scene(raw, request)` classifies elements into building / road / water / green /
tree (`_layer_of`), pools coordinates, projects once, applies the `03` hygiene steps
(make_valid, 0.25 m simplify, 1 mm snap grid, 0.5 m centroid dedupe, union of overlapping
footprints), crops, and emits the contract.

- Heights (`resolve_height`, in order): `height` / `building:height` via `parse_length_m`
  (metres, feet-inches, `ft`, multi-values) -> `building:levels * 3.2` plus `roof:height`
  -> `TYPE_DEFAULT_HEIGHT_M` per building type (skyscraper 120, church 25, apartments 18,
  house 7, garage 3, ...) or `DEFAULT_HEIGHT_M = 8`, both jittered plus or minus 6 % by a
  sha1 of the OSM id (`jitter_factor`); clamped 2..600 m; `building:min_level` /
  `min_height` set `min_height_m`; `is_tall` is `height_m >= 40`.
- Roads: `road_width_m` takes the `width` tag, else `lanes * 3.5`, else `HIGHWAY_WIDTH_M`
  (motorway 24, trunk 20, primary 16, secondary 12, tertiary 10, residential and
  unclassified 8, pedestrian 6, service 5, footway 3), clamped 0.5..60 m. `HIGHWAY_CLASS`
  maps the ten tags onto `motorway|primary|secondary|residential|service|path`.
- Trees: `diameter_crown / 2`, else 4 m, clamped 0.5..20 m.
- Coverage (`classify_coverage`): `empty` under 20 buildings, `good` at 150 or more
  covering at least 4 % of the crop, else `sparse`.

### 2.5 SceneGraph shape

Top-level keys: `bounds` (`min_x`, `min_y`, `max_x`, `max_y`), `center` (`lat`, `lon`,
the only degrees in the document), `buildings` (`id`, `ring`, `holes`, `height_m`,
`height_source` in `tag|levels|default`, `min_height_m`, `is_tall`), `roads` (`id`,
`path`, `width_m`, `class`), `water` and `green` (`ring`, `holes`), `trees` (`x`, `y`,
`radius_m`), `stats` (`building_count`, `coverage`, `height_tag_ratio`). Metres, local
ENU, origin (0,0); rings unclosed, exteriors CCW, holes CW.

### 2.6 Endpoints (`app/main.py`)

`GET /health`; `GET /presets`; `POST /scene` -> `build_scene(request)`, where
`_resolve_request` serves an unmodified preset from its fixture with the network off and
anything else cache-then-network, cached under `artifacts/cache/scene/<sha256>.json` for
24 h plus a six-entry in-process LRU (Overpass failure 502, offline 503).
`POST /bake` -> 202 `{job_id}`; `_run_bake` builds the scene through the same
`build_scene`, then runs `bake.bake_job` in a worker thread behind a two-slot semaphore.
`GET /bake/{job_id}` returns the `BakeResult` (`queued|running|done|failed`, `progress`,
`warnings`, `error`, `files`, `stats`). `GET /files/{name}` serves `artifacts/` with
path-traversal checks. CORS allows `http://localhost:3000`.

## 3. Geometry generation (the bake)

`app/bake.py:run_pipeline` is `04` end to end: coverage guard (`EmptySceneError`) ->
60 mm guard (`predicted_top_mm`) -> lettering build -> Stage 1 repair -> detail advice ->
Stage 2 assemble -> `manifold_to_trimesh` (float64) -> triangle budget -> Stage 3 export
-> Stage 4 validate -> sidecar and `CREDITS.txt`. A failed validator moves the outputs to
`artifacts/debug/<job_id>/` and returns `status: failed` naming the check. `JobRegistry`
is the in-process job dict; `bake_job` publishes `STAGE_PROGRESS` per stage.
`app/cli.py` exposes `refresh-fixtures`, `scene`, `bake` (`--preset` or
`--lat/--lon/--radius`, `--params JSON`, `--out`) and `validate` (`.3mf` or `.stl`,
judged against the `<stem>.json` sidecar beside it).

### 3.1 Shared transform math (`app/geom/transform.py`, `apps/web/lib/transform.ts`)

Pure stdlib Python, mirrored function for function with the same snake_case names in
TypeScript. `tests/test_transform.py` and `lib/transform.test.ts` both assert against
`fixtures/parity-expected.json` (built from `fixtures/parity-scene.json`) within 0.01 mm.
Key functions: scale (`usable_span_mm` = plate minus 2 x 6 mm frame, `scale_mm_per_m`,
`radius_m_from_bounds`, `content_extents_mm`, `frame_geometry_mm`); thresholds
(`min_wall_mm = 2 * nozzle`, `min_gap_mm = 1.5 * nozzle`, `min_detail_mm = nozzle`,
`thresholds_ground_m`); heights and Z (`building_top_mm` with the 0.6 mm clamp,
`road_z_mm`, `water_z_mm` -0.5, `green_z_mm` +0.3, `predicted_top_mm`,
`model_too_tall`); heroes (`hero_ids`, `hero_true_height`, `hero_own_color`,
`building_top_mm_for`, `parts_mode`); trees (`tree_min_radius_mm`,
`select_tree_indices_for`, cap 2000, 8 sides); lettering layout (`fit_text`,
`edge_placement`, `lettering_layout` returning `EngravingLayout`, `NorthArrowLayout`,
`ScaleBarLayout`, `UndersideMarkLayout` and warnings, `scale_bar_auto_length_m`,
`underside_min_base_mm`, `keyhole_center_mm`, `magnet_centers_mm`); advisor
(`detail_report`, `recommend_radius_m`, `recommend_plate_mm`, `detail_recommendation`).

`app/geom/tokens.py` and `apps/web/lib/tokens.ts` are the same kind of pair: the eight
tokens `{city}`, `{lat}`, `{lon}`, `{coords}`, `{scale}`, `{radius}`, `{date}`,
`{buildings}` with hand-rolled formatting, pinned by `fixtures/tokens-expected.json`.

### 3.2 Stage 1, printability repair (`app/geom/thicken.py`)

Ground metres on shapely, before any extrusion. `repair_scene` runs `repair_buildings`
(make_valid, hole shrink, dilate thin footprints to a full min wall, merge blocks at an
area-weighted 80th-percentile height, drop sub-detail), `repair_areas` for water then
green, `repair_roads` (centreline buffer to the clamped width), `merge_recess_ridges`,
`select_trees`. Every threshold comes from `transform`; `MIN_WALL_PROBE_FACTOR = 0.45`
and `MIN_WALL_FAIL_FACTOR = 0.9` are shared with the Stage 4 `min_wall` validator so the
repair and the gate cannot drift. Output is a `RepairedScene` plus warnings.

### 3.3 Stage 2, solids and assembly

`app/geom/extrude.py` is the only place ground metres become print millimetres
(`contours_mm`). Polygons become `manifold3d.CrossSection` objects and are extruded
(`extrude_polygons`, `building_solids`, `slab`, `tree_cone`); `base_plate` carries the
0.6 mm bottom chamfer, `frame_lip` the 6 x 2 mm lip. Parts mode adds `inlay_slab`,
`inlay_claim`, `recess_pocket`, `frame_lip_part`.

`app/geom/assemble.py:assemble` does one `batched_union` (batches of 200, then pairwise)
of the additive solids (base, lip, buildings, green, embossed roads, trees, embossed
text), subtracts the cutters (engraved roads, water recess, engraved text, north arrow,
scale bar, underside pockets) with `Manifold.batch_boolean(..., OpType.Subtract)`, runs
`finalize` (sliver sweep, debris prune, checked vertex weld) and translates the solid to
z = 0 centred on X and Y. manifold3d is the only boolean engine; trimesh is used only at
the export boundary (`export/stl.py:to_trimesh`, `process=False`) and in the validators.

Parts mode (`color_mode = "parts"`): `color_parts` cuts the same geometry into one solid
per layer in `PART_ORDER` (`base`, `frame`, `buildings`, `hero:<id>`, `roads`, `water`,
`green`, `trees`). Additive parts pass through the local `carved()` helper, which
subtracts single mode's cutters from each part; a recess becomes an inlay under its own
floor with the base pocketed 0.2 mm shallower. Parts interpenetrate by
`PART_OVERLAP_MM = 0.2` and their union (`Assembly.parts_union`) is kept so the gate can
prove it equals the single-mode solid. Own-colour heroes get `HERO_COLOR = "#E3A72F"`.

### 3.4 Lettering and ornaments (`app/geom/lettering.py`)

Glyph outlines come from fontTools over three bundled OFL faces (`FACE_FILES`: `sans`
Inter, `serif` Source Serif 4, `mono` JetBrains Mono under `app/fonts/<face>/`),
flattened at `FLATTEN_TOLERANCE_MM = 0.02`. `build(params, ctx, rotation_deg)` consumes
`transform.lettering_layout` and, per piece: outlines at the fitted size ->
`repair_text` (Stage 1 rules in print mm) -> `place` and clip to `lip_keep_region` ->
`merge_stroke_ridges` for engraved text -> measure the narrowest stroke and counter and
refuse the piece if the gate would fail it. It returns a `LetteringGeometry` with `cut`
(engraved text, `north_arrow_polygon` turned back by the scene rotation,
`scale_bar_polygons` with rules and label), `emboss` (embossed text) and `underside_cut`
(`underside_pocket_polygons`: the mono underside mark, `keyhole_polygon`,
`magnet_polygons`). `BaseTooThinError` refuses a base too thin for its pockets before
anything is built.

### 3.5 Stage 4, the gate (`app/validate/checks.py`, `app/validate/container.py`)

`checks.validate(mesh, params, manifold=...)` yields one `Check` row per `04` rule:
`manifold`, `watertight`, `volume`, `self_intersection`, `bounding_box` (plate plus
0.01 mm, Z under `MAX_HEIGHT_MM = 60`), `sits_at_zero`, `min_wall` (12 seeded Z slices
plus one per recess band, `Manifold.slice` when available), `triangle_budget`
(2,000,000, decimated to 1,500,000 by `enforce_triangle_budget`), `degenerate_faces`.
Lettering adds `lettering` and `base_floor` (`validate_lettering`,
`validate_base_floor`). Single mode adds `bodies` (`single_body_check`); parts mode adds
`bodies`, `part_meshes`, `parts_union` (`validate_parts`). `container.py` audits the
package itself, in the bake and the CLI alike: `3mf_parts`, `3mf_model_xml`, `3mf_unit`,
`3mf_objects`, `3mf_build_items`, `3mf_attribution`, `3mf_counts`, plus
`3mf_components`, `3mf_materials`, `3mf_color_mode` for a parts file.

## 4. The 3D preview (`apps/web`)

### 4.1 Geometry (`lib/preview.ts`)

Pure functions, no three.js, no booleans, no maths of its own: every scale, threshold
and Z comes from `lib/transform.ts`. `buildBuildings` turns each footprint into a
minimum-area oriented rectangle (`convexHull`, `minAreaRect`) dilated by the same
`building_dilation_m` the bake uses and counts what the bake would widen or drop;
`buildingInstanceMatrices` writes straight into an `InstancedMesh` buffer. `buildRoads`
triangulates flat ribbons, `buildAreas` converts water and green rings to `PreviewArea`
records, `buildTrees` / `treeInstanceMatrices` follow `select_tree_indices_for`;
`buildPreview` bundles them into a `PreviewModel`.

### 4.2 Components (`components/scene/`)

- `PreviewPane.tsx` loads `CityPreview` via `next/dynamic` with `ssr: false`.
- `CityPreview.tsx` owns the r3f `Canvas`, one root-group rotation for three.js's Y-up,
  and the `previewDeps` table: every `useMemo` is keyed on primitives read off `params`
  (never the object) so a height slider rewrites only the building matrices (`scale`:
  `plate_mm`, `frame`; `thresholds`: scale, `nozzle_mm`; `roads`: plus `road_scale`,
  `road_mode`; `water`: `water`; `trees`: `trees`; `height`: `predictedTopDeps`; `text`:
  `textParamsKey`, rotation, date, loaded-face count). It also renders the HUD spec strip
  (`lib/hud.ts:specStrip`: scale ratio, predicted height, min wall), the adjustments chip
  (`lib/adjustments.ts`), the advisor chip (`lib/advisor.ts`) and hero picking by raycast
  and keyboard (`lib/heroes.ts`, `lib/heroCursor.ts`).
- `InstancedBuildings.tsx`: one `InstancedMesh` of a unit box with per-instance colour;
  `matrixDeps` keys the upload on base thickness, the two multipliers and `heroHeightKey`.
- `RoadRibbons.tsx`: one `BufferGeometry` updated in place when the vertex count is
  unchanged, drawn at `road_z_mm` above the base rather than cut.
- `AreaSurfaces.tsx`: earcut via `ShapeUtils.triangulateShape`, one merged geometry per
  layer, at `water_z_mm` and `green_z_mm`.
- `BasePlate.tsx`: slab and four lip bars from `plate_extents_mm`, `frame_geometry_mm`,
  `base_top_mm` (no chamfer); `TreeInstances.tsx`: one `InstancedMesh` of an 8-sided cone.

### 4.3 Lettering preview (`lib/previewText.ts`, `lib/fontGlyphs.ts`, `lib/fonts/*`)

`buildPreviewText` takes the same `transform.lettering_layout` the bake cuts from,
expands tokens through `textTokenContext`, and turns glyph outlines (`glyphAreas`, with
the layout's dilation applied by `offsetRing`), `northArrowArea`, `scaleBarAreas`,
`keyholeArea` and `magnetAreas` into `PreviewArea` records placed by `placeArea`. Pieces
carry a tone (`engraved|embossed|pocket`) and a face (`top|bottom`); `textLayers` and
`textPieceZMm` put them on the lip or the underside as flat fills. What the layout
refuses is not drawn. `lib/fonts/<face>.glyphs.json` (font units, flattened at the 8 mm
maximum) and `<face>.metrics.json` are generated by
`services/bake/scripts/gen_font_assets.py`; `fontGlyphs.ts` imports a face lazily the
first time a layout names it (`loadGlyphFace`, `loadedGlyphFace`, `facesNeeded`).

### 4.4 State (`store/editor.ts`)

One zustand store: `location` (`lat`, `lon`, `radius_m`, `rotation_deg`, `preset_id`),
`params` (a full `PrintParams`), `scene` (`status`, `graph`, `request`, `stale`,
`message`), `bake` (`BakeState`), `presets`, `theme`, `presetChosen`, `heroCapHit`,
`adjustmentsOpen`, `shareNotice`. Only `setPin`, `setRadius`, `setRotation` and
`applyPreset` can lead to a network call, and they only mark the scene `stale`; the
`POST /scene` happens in `generate()` when the user asks. Every `setParam` /
`setNested` / `toggleHero` write is local: the preview recomputes from the SceneGraph in
memory and a finished bake is marked stale (`markBakeStale`) so its download is
withdrawn; `store/editor.test.ts` fails if any `setParam` touches `fetch`.
`requestBake` runs `warnings.bakeBlockReason` (coverage, 60 mm ceiling, underside base
floor) and refuses locally before calling `startBake`.

### 4.5 API client and bake flow (`lib/api.ts`, `lib/bake.ts`)

`BAKE_API_URL = process.env.NEXT_PUBLIC_BAKE_API_URL ?? "http://localhost:8000"` is the
one base URL; `fetchPresets`, `fetchScene`, `startBake`, `fetchBakeResult` and `fileUrl`
wrap the five endpoints and raise `ApiError` with status and path. `lib/bake.ts` is the
pure job state machine: `bakeStarted`, `reduceBake` (ignores a foreign job id, keeps
progress monotonic), `shouldPoll`, `markBakeStale`, `bakeDownloadLinks` (3MF first,
nothing while stale). The store polls `GET /bake/{id}` every `POLL_INTERVAL_MS = 1000`
until `done` or `failed`.

### 4.6 Sharing, warnings, presets, map

- `lib/share.ts`: `?s=v2.<base64url(JSON)>.<fnv1a32 hex>` where the JSON is
  `{"r": SceneRequest, "p": PrintParams fields that differ from default}`; `encodeShare`,
  `decodeShare` (validates every field against `PRINT_PARAM_SPEC`, refuses unknown
  versions and bad checksums), `shareUrl`, `readShareParam`. Applying a link marks the
  scene stale and never fetches.
- `lib/warnings.ts`: `sceneWarnings` yields `info|warn|block` rows (coverage under
  `MIN_BUILDINGS_TO_BAKE = 20`, estimated heights under `ESTIMATED_HEIGHT_RATIO = 0.15`,
  widened/dropped counts, the 60 mm ceiling via `predictedTopMm`, the hanger base floor
  via `undersideBlockMessage`); `lib/adjustments.ts:collectAdjustments` folds the
  informational ones into the Issues chip; `bakeBlockReason` disables Bake.
- `lib/presets.ts`: `PRESET_LABELS` (id -> label), `PRESET_ORDER`, `presetLabel(id)`,
  `sortPresets(list)`. The preset objects are the `SceneRequest`s from `GET /presets`
  (`lat`, `lon`, `radius_m`, `rotation_deg`, `preset_id`).
- `components/map/LocationPicker.tsx` renders OSM raster tiles from `tile.openstreetmap.org` only; there is no geocoder.

## 5. The 3MF, STL and sidecar

`app/export/mf3.py` writes a core-spec 3MF: an OPC zip with exactly
`[Content_Types].xml`, `_rels/.rels` and `3D/3dmodel.model`, namespace
`http://schemas.microsoft.com/3dmanufacturing/core/2015/02`, `unit="millimeter"`,
vertices at twelve fixed decimals. There is no vendor extension, no production or slice
extension, and no Bambu Studio or PrusaSlicer project metadata; only the reserved core
metadata names are used (`RESERVED_METADATA`), and `build_metadata` fills `Title`,
`Designer`, `Description` (attribution, location, every PrintParams value, the font
licence line when text was cut), `Copyright`, `LicenseTerms`, `Application`,
`CreationDate`.

- Single mode (`write_3mf`): one `<object id="1" type="model">` with `<mesh>`, one
  `<build><item objectid="1"/>`.
- Parts mode (`write_3mf_parts`, `parts_model_xml`): `<basematerials id="1">` with one
  `<base name displaycolor="#RRGGBBAA">` per part (`normalize_color`), one `<object>` per
  part with `pid="1"` and its `pindex`, one container object named `FrameCraft` whose
  `<components>` list every part, and a single build item for that container.

`app/export/stl.py:write_stl` writes binary STL through trimesh; in both modes the STL is
the single welded body. `app/export/__init__.py` writes `CREDITS.txt` (ODbL attribution
plus `FONT_CREDITS`) and the `<stem>.json` sidecar (`sidecar_payload`): `attribution`,
`license`, `generator`, `created_at`, the exact `scene_request` and `print_params`, the
full `bake_result`, `scene_stats`, the `validation` report (every check row with value
and threshold) and `timings_s`. `make validate` judges a file against that sidecar.

## 6. Test harness

- **pytest** (`services/bake/tests/`, `uv run pytest`): `conftest.py` exports
  `FRAMECRAFT_OFFLINE=1` for every test. `test_contracts.py` (generators, schema bounds),
  `test_ingest.py` (fixtures -> SceneGraph), `test_transform.py` and `test_tokens.py`
  (the parity fixtures), `test_bake.py` (golden Chicago, Stage 1, assembly, export,
  validators, API), `test_lettering.py` (fonts, layout, ornaments,
  `fixtures/lettering-expected.json`), `test_v1_compat.py` (G8 golden),
  `test_validate_cli.py` (the CLI on real and corrupted files), `test_qa_verification.py`
  (independent re-derivations). Parity fixtures regenerate with `FRAMECRAFT_WRITE_PARITY=1`.
- **vitest** (`apps/web/vitest.config.ts`, `npm test`): node environment, `**/*.test.ts(x)`
  beside the code under `lib/`, `store/`, `components/scene/`, `components/editor/`; `e2e/` excluded.
- **Playwright** (`apps/web/playwright.config.ts`, `npm run test:e2e`): one chromium
  worker, no retries, no mocking, `webServer` entries that start uvicorn and `next dev`
  when the stack is down (`reuseExistingServer`), results to
  `artifacts/e2e/results.json`. Specs: `smoke.spec.ts` (01's A1..A5: preset preview under
  5 s warm, open-water pin blocks Bake, sliders make no server call, Chicago bakes to a
  download in under 90 s through the live service, and the downloaded `.3mf` passes
  `python -m app.cli validate`), `ui.spec.ts` (self-hosted fonts, groups, engravings,
  hanger refusal, hero picking, breakpoints, keyboard), `share.spec.ts` (link round trip
  across contexts, refusals), `a11y.spec.ts` (axe-core in both themes, Tab order).
- **`make gate`** chains them: static no-skip guard over every test source, pytest with a
  skip/xfail check, eslint, `tsc --noEmit`, vitest with a skip/todo check, `next build`
  (before the stack is up), `make up`, Playwright with a `results.json` skip and
  `test.fail` check, a checked `make down` with a port probe, and a check that the e2e
  left no stray `fixtures/<sha1>.json`. `make gate-v2` covers the geometry gates
  separately because they take several minutes of manifold3d.

## 7. Known limits

- The preview never runs booleans: buildings are oriented boxes, the repair is a
  per-footprint dilation (neighbours the bake merges are still drawn apart), engraved
  roads, water and lettering are flat fills on the surface, and the chamfer is not drawn
  (`CityPreview.tsx`, `docs/handoff/v2-06-preview.md`).
- The browser never writes the 3MF; every file comes from the bake service via `GET /files/{name}`.
- The lettering layout predicts printability from glyph metrics while the bake measures
  the finished groove; they can disagree, always with the bake refusing
  (`docs/handoff/v2-03-lettering.md` section 8).
- No Nominatim or reverse geocoding: `{city}` is only ever the typed `city_label`
  (`DECISIONS.md` [V2-P2]).
- The parts export is core-spec 3MF only: no slicer project metadata, so filament
  assignment happens in the slicer, and slicer import is a manual check
  (`docs/handoff/v2-02-color.md` section 8).
- Terrain is flat: `terrain_exaggeration` is carried through both transforms but
  `terrain_z_mm` is always 0 (`01` out of scope). Bake jobs live in one process
  (`JobRegistry`, 64 entries, two concurrent bakes); there is no persistent queue.
- The Next app has no API routes or server-only code (`apps/web/app` holds only
  `layout.tsx`, `page.tsx`, `globals.css` and icons; `next.config.ts` is empty), and
  `NEXT_PUBLIC_BAKE_API_URL` is inlined at build time, binding a build to one bake origin.
