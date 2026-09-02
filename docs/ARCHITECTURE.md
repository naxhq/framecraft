# FrameCraft architecture

Written from the source as it exists at v3.0.0. Rulings that shaped it are
`[V3-*]` lines in `DECISIONS.md`; per-phase builder notes live in
`docs/handoff/v3-NN-*.md`. Section 9 records where v1/v2 differed.

## 1. System overview

FrameCraft is a fully client-side application. The Next.js app is a static
export (`next.config.ts`: `output: "export"`); `next build` writes a complete
`apps/web/out/` tree that any static file server, GitHub Pages, or the Tauri
desktop shell serves as-is. Everything the product does, Overpass ingest,
terrain fetch, solid geometry on the manifold WASM kernel, the printability
audit, and every export file, runs in the browser.

| Piece | Path | What it is |
|---|---|---|
| Web app | `apps/web/` | Next.js 15 App Router, React 19, TS strict, Tailwind 4, zustand 5, react-three-fiber 9 + drei, MapLibre GL 6, manifold-3d WASM, fflate |
| Engine | `apps/web/lib/engine/` | The TypeScript bake pipeline: `osm/` (ingest), `terrain/`, `solid/` (geometry), `audit/`, `export/` (writers), plus `engine.ts`, `worker.ts`, `client.ts`, `protocol.ts` |
| Reference | `services/bake/` | Python 3.12 FastAPI service: the reference implementation of the same pipeline and the CLI printability validator (`python -m app.cli validate`). Not a runtime dependency of the web app |
| Contracts | `packages/contracts/` | JSON Schema source of truth (schema version 3), generating `apps/web/lib/contracts.ts` and `services/bake/app/contracts.py` |
| Desktop | `apps/desktop/` | Tauri 2 shell embedding the same static export (section 8) |

The engine runs off the main thread in **two Web Workers**, one per job kind:
`lib/engine/client.ts`'s `EngineClient` holds an ingest transport and a bake
transport ("one per job kind, never shared", `EngineClientTransports`), each a
`WorkerTransport` over `lib/engine/worker.ts` when `Worker` exists and an
`InlineTransport` fallback otherwise (SSR, vitest, a browser that refuses
worker creation). `lib/engine/protocol.ts` holds the message protocol and the
job handlers (`runIngestJob`, `runBakeJob`, `cancelJob`), shared verbatim by
the worker and the inline fallback so the two cannot drift. Bakes are
single-flight: a request that arrives while one runs overwrites a single
queued slot, so the worker is never more than one bake behind.

The WASM binary is copied to `public/manifold/manifold.wasm` by
`apps/web/scripts/copy-manifold-wasm.mjs` (`predev`/`prebuild`);
`lib/engine/solid/manifold.ts:loadManifold` passes a `locateFile` override
outside Node, and `next.config.ts` carries a client-only webpack
`IgnorePlugin` for `node:` scheme imports in manifold's emscripten glue.

`services/bake` still answers `/health`, `/presets`, `/scene`, `/bake`,
`/bake/{id}`, `/files/{name}` on :8000, but nothing in the deployed app calls
them. Its jobs today: `make gate` bakes the committed Chicago fixture through
the browser engine's own CLI (`npm run bake:cli`) and judges the files with
the Python validator; `tests/test_transform.py` and `lib/transform.test.ts`
pin the shared transform math (`app/geom/transform.py` mirrored by
`lib/transform.ts`) against `fixtures/parity-expected.json` to 0.01 mm.

### 1.1 Contracts

`packages/contracts/schema/*.json` defines the four wire shapes
(`scene_request`, `scene_graph`, `print_params`, `bake_result`).
`PrintParams.schema_version` is `{enum: [2, 3], default: 3}`; every v3 group
(`place`, `regions`, `colour`, `printer_profile`, `custom_profile`,
`export_target`, `terrain`, `heights`, `bridges`, `height_exaggeration`,
`hero_auto`, `tiling`, `frame_style`, `hanger_magnet`, plus the extended
`hanger` enum and `Engraving` modes `inlay` / edge `underside`) is additive
and optional with v2-identical defaults, pinned by
`services/bake/tests/test_v1_compat.py` against `fixtures/v1-golden/`.
`make contracts` runs `gen_ts.py` and `gen_py.py`; the outputs are never
hand-edited. The SceneGraph schema itself is unchanged; the engine's extra
layers ride on structural supersets (`lib/engine/osm/types.ts`:
`EngineBuilding`, `EngineRoad`, `Rail`, `EngineSceneGraph`), assignable
anywhere a plain `SceneGraph` is expected (`[V3-P2-E1]`).

## 2. OSM ingest (`apps/web/lib/engine/osm/`)

- `overpass.ts`: `buildQuery`/`bboxFor` byte-identical to the Python builder
  (the Chicago preset query hashes to the committed fixture's own sha1).
  `fetchOverpass` walks `DEFAULT_MIRRORS` (`overpass-api.de`,
  `overpass.kumi.systems`, `overpass.private.coffee`) with 500 ms / 1 s / 2 s
  backoff and a 60 s per-attempt timeout; 400/422 return at once (a verdict on
  the query), any other failure advances to the next mirror. Responses cache
  in `MemoryOverpassCache` / `IndexedDbOverpassCache`; every path fails soft.
  An `AbortSignal` threads through so a superseded ingest stops its fetch.
- `tmerc.ts` + `project.ts`: hand-rolled WGS84 ellipsoidal UTM (Kruger
  n-series, validated against pyproj to sub-micron), `LocalFrame`
  (WGS84 <-> local ENU with rotation), crop and clip. Coordinates past this
  boundary are metres, x east, y north, origin at the pin; never Web Mercator.
- `normalize.ts` / `geometry.ts`: classify, project once, the `03` hygiene
  steps (make-valid, simplify, 1 mm snap, dedupe, dissolve, union of
  overlapping footprints), crop, emit. Measured parity against the Python
  `/scene` output on the 16k-element Chicago fixture: buildings 992 vs 994,
  roads 5439 vs 5443, trees exact, pinned with the known exceptions in
  `normalize.test.ts`. 496 ms warm in Node.
- `heights.ts`: the height chain, tunable by `params.heights`:
  `height`/`building:height` tags -> `building:levels * floor_height_m` plus
  `roof:height` -> per-type defaults (`heights.type_defaults`) or
  `unknown_default_m`, jittered by a sha1 of the OSM id, clamped; fallback
  counts are tallied on the emitted list (`EngineStats.height_fallback_counts`).
- v3 extras carried into the scene: building `name` and landmark hints
  (`tourism`, `historic`, `wikidata`), a `rail` layer, and `bridge`/`layer`
  tags on ways, which is what `solid/bridges.ts` builds decks from. The
  committed `fixtures/chicago-scene.json` (Python-produced) has none of these;
  the app's own ingest of the raw Overpass fixture carries 780 elevated ways,
  which is why `bake-cli` grew `--overpass` (section 7c of
  `docs/handoff/v3-03-geometry.md`).
- `presets.ts`: the six frozen presets, city names read from
  `apps/web/lib/presets.ts`. There is no `/presets` call.

## 3. Geometry (`apps/web/lib/engine/solid/`, `engine.ts`)

`bake(input: EngineInput, options?)` returns an `EngineResult`: watertight
`RegionMesh` solids (positions `Float64Array`), a welded `merged` solid,
`stats`, `findings` (the audit), `resolvedText` (every lettering line with its
resolved string or refusal), optional `tiles`, `buildingTints`,
`buildingBands`, `attributionBands`. It never throws for a printability
problem; refusals are findings.

**Regions.** Colourable regions (`types.ts:COLOURABLE_REGION_NAMES`): `base`,
`frame`, `matting`, `buildings`, `hero_building`, `roads`, `water`, `parks`,
`rail`, `lettering`, `attribution`, `easel`; derived regions add `cleat` and
`buildings_band_2..8` (height-gradient bands, split by equal count). Regions
are separate watertight bodies that **interpenetrate at every seam by
`PART_OVERLAP_MM` = 0.2 mm**, derived from the welded solid the way the Python
parts mode does it (`[V3-P2-E2]` ruling): a surface region is extruded from
its footprint grown 0.2 mm from 0.2 mm below its pocket floor, buildings reach
`regions.building_skirt_mm` into the base, the frame lip starts 0.2 mm inside
the plate, a lettering inlay reaches 0.2 mm past its pocket. Every extra lies
inside material `merged` already has, so the union of the regions is the
welded solid (measured 0.065 % boolean rounding apart). A flush partition was
built first and rejected by the reference validator: flush parts union with
seam slivers no tolerance sweep removed. Consequence: per-region
`volumeMm3` values double-count the seams; totals and estimates read
`EngineResult.merged.volumeMm3` only.

- `repair.ts`: Stage 1 in print millimetres on Clipper2: dilation,
  widen-to-min-wall (erosion probe, since `4A/P` misreads long strips), the
  closing pair, weighted-percentile block merge, appendage passes clipped
  inside the loop.
- `measure.ts`: the min-wall audit, question for question the reference
  validator's rule: per connected region of a slice, widest inscribed disc by
  erosion (`inscribedWidthMm`), only regions that persist one printed layer
  upward, saturating at the minimum wall. A draped bake adds
  `drapedSliceHeights`, a Z sweep between the flat probe planes, because a
  hillside puts walls at heights no flat slice list samples; `ctx.terrain` is
  null for flat bakes so they pay nothing. Declared attribution bands are
  excluded (section 6).
- `mesh.ts`: double-precision mesh repair on the way out (weld ladder, needle
  split, `collapseNeedles`), transactional: a pass that opens an edge or moves
  volume is discarded.
- Terrain (`lib/engine/terrain/`, `solid/drape.ts`): Mapzen Terrarium PNG
  tiles from AWS Open Data (`tiles.ts:fetchTerrainGrid`, zoom 12 to 14 from
  the radius, at most 36 tiles, fail-soft to a flat base), box-blur
  `terrain.smoothing`, exaggeration applied once in
  `transform.terrain_z_scale`. The drape is a vertical shear applied to the
  finished solids: the welded assembly is built flat and draped as one solid
  (draping plate and grooves separately left floating hillside fragments),
  buildings and trees are rigidly lifted by the lowest displacement under
  their footprint, the underside and chamfer stay flat, and the plan taper
  reaches zero across the frame band.
- `bridges.ts`: `bridge=yes` or `layer > 0` segments leave their grade layer
  and become decks `bridges.clearance_mm` above the local surface, with
  diamond abutment columns; ungrounded decks are dropped and counted.
  `trees.ts`: truncated cones joining the `parks` region, gated on printable
  size (all 5762 Chicago trees fall under the 0.5 mm floor at plate 180; 1699
  print at plate 256).
- `frame.ts`: seven profiles as stacked `CrossSection` rings (plain, chamfer,
  stepped, bevel-in, bullnose, ogee, floating), three corner styles, shadow
  gap, matting (its own region), a separate frame part with snap or magnet
  mating (lifted by the mount tolerance so it stays a second body), four face
  textures, and the lettering keep-out. `hangers.ts`: keyhole, magnets, French
  cleat, easel; the cleat wedge and easel leg print inside their own pockets
  (`loose-part-in-place` finding). `validate.ts:expectedBodies` excuses
  exactly the loose bodies the parameters ask for.
- `lettering.ts` / `ornaments.ts`: frame-edge lines through the shared
  `transform.lettering_layout`, engrave / emboss / inlay (the inlay is its own
  `lettering` region filling exactly the pocket it cuts), underside lines laid
  out locally and mirrored, north arrow, scale bar, refusals with measured
  numbers. Tokens (`{city}`, `{coords}`, `{scale}`, `{hero}`, ...) are
  resolved client-side (`lib/tokens.ts`); the engine echoes resolved strings
  into the persisted params (`engine.ts:resolveParamsEcho`).
- `tiling.ts`: `params.tiling` splits every region and `merged` on vertical
  planes (up to 6 x 6), dovetail or pin joints with an exact-clearance socket,
  the cut snapped to the cleanest line within 3 mm, remaining sub-nozzle fins
  measured and removed (`tile-seam-trimmed`), an index mark per tile. Each
  `TileResult` carries its own regions, welded `merged` and grid label.
- `audit/rules.ts` + `audit/fixes.ts`: the finding catalogue
  (`auditPrintability`: thin walls, floating islands, plate and height limits
  against the active printer profile, overhangs, slot-beyond-profile, tile
  findings) with one-click fixes; `applyFix` refuses any patch touching
  `nozzle_mm`, and `fix.safe` means it can be applied blind.
  `estimate.ts:estimate` turns `merged.volumeMm3` into grams, metres, layers
  and a stated-assumptions time figure, per slot.
- `printers.ts` (in `apps/web/lib/`): eight named profiles (Bambu H2S, P1S,
  X1C, A1, A1 mini, Prusa MK4, Prusa Mini, Ender 3) plus `custom`, verified
  against Bambu's own profile JSON; `resolveProfile(params)` is the one
  reader, and the height ceiling everywhere is the active profile's.

## 4. Attribution (`solid/attribution.ts`)

Every bake carries engraved marks no parameter can remove: a deep underside
mark spanning the plate, the same line on all four inner frame walls, 1.2 mm
microtext on the base's south edge, and a second underside mark when the frame
is off. The marks' Z bands are declared (`EngineResult.attributionBands`),
written to the sidecar as `attribution_bands`, excluded from the structural
min-wall probes on both sides, and guarded by the validator's own
`attribution` row (band height, count, and material checks; it does not
pretend to read glyphs). Every exporter writes one five-field provenance block
(`export/common.ts:provenanceEntries`: author, licence, generator, source,
generated). The user-facing statement of what this does and does not achieve
is `LICENSE_AND_ATTRIBUTION.md`.

## 5. Exporters (`apps/web/lib/engine/export/`)

Pure writers, `(result, options) => files`, no manifold, no DOM, no network;
`index.ts:exportForTarget` dispatches on `PrintParams.export_target`:

| target | writer | what it writes |
|---|---|---|
| `bambu-3mf` | `bambu3mf.ts` | A Bambu Studio project: split layout (`3D/3dmodel.model` assembly of `p:path` components, `3D/Objects/object_N.model` meshes, `Metadata/model_settings.config` with per-part extruders, `project_settings.config` from the printer profile, `slice_info.config`, `plate_N.json`), verified line-by-line against `bbs_3mf.cpp` and the installed Bambu Studio |
| `generic-3mf` | `generic3mf.ts` | Core-spec 3MF, the browser twin of `app/export/mf3.py`: `single` writes `EngineResult.merged` as one object, `parts` writes `<basematerials>` plus one object per region and one assembly; both pass the Python container rows |
| `stl` / `stl-parts-zip` | `stl.ts` | One welded binary body, or a zip of per-region STLs plus `CREDITS.txt` |
| `obj` | `obj.ts` | `o`/`usemtl` per region (per building body with tint on) plus `.mtl` |
| `step` | `step.ts` | AP214 faceted B-rep, one `PRODUCT` per region, with a size note above 50k triangles |
| `color-change-3mf` | `colorchange.ts` | The Bambu project on one extruder plus `custom_gcode_per_layer.xml` changes at separable Z bands; inseparable regions are reported, never guessed |

A tiled result routes through `tiles.ts`: one multi-plate Bambu project (one
plate per tile, at Bambu's own plate origins), or a zip of per-tile files.
`common.ts` places every model in build space, writes the `<stem>.json`
sidecar (`buildSidecarJson`: print params, provenance, `max_height_mm`,
`attribution_bands`, stats) that `make validate` judges files against, and
`CREDITS.txt` beside every export.

## 6. Preview, store, validation

- `store/editor.ts` owns one module-scope `EngineClient`. `generate()` calls
  `ingest()` (never a `/scene` POST); every scene-ready moment and every
  `PrintParams` write schedules a debounced (~400 ms) engine job
  (`scheduleEngineJob` / `runEngineJob`) into `state.engine`
  (`EngineJobState`: `idle|computing|ready|error` plus `stale`).
  `requestBake()` reuses a fresh result or runs one, then hands it to
  `lib/bake.ts:runExport`, which calls the exporter and yields Blob download
  URLs. Store setters never touch `fetch`; `store/editor.test.ts` enforces it.
- `components/scene/CityPreview.tsx` keeps the `previewDeps` discipline: every
  `useMemo` is keyed on named primitives read off `params`, never the object,
  so a slider rewrites only the layer that reads it, and
  `CityPreview.test.ts` walks every contract key against the dep lists.
- `lib/enginePreview.ts:freshEngineResult` is the swap rule:
  `components/scene/RegionMeshes.tsx` (one `BufferGeometry` per `RegionMesh`)
  replaces every approximate instanced/flat-fill layer the moment the engine
  result is `ready` and not `stale`; while a newer job computes, the instanced
  preview stays up with an "Updating model..." badge, and
  `InstancedBuildings.tsx` stays mounted invisibly so hero raycast picking
  keeps working. The same `EngineResult` feeds the preview, the filament
  mapper (`lib/colourMap.ts`: `colourRows`, `deltaE76`, `planMergeToSlots`)
  and every exporter, so the three cannot disagree.
- Workflow: Nominatim forward and reverse geocoding (`lib/geocode.ts`, one
  shared 1 rps queue, caches, fail soft) with `components/map/SearchBox.tsx`;
  `.framecraft.json` project files (`lib/project.ts`, full params, validated
  by the same `parsePrintParams` as links); deflate-compressed `?s=v3.` share
  links (`lib/share.ts`, 8000-char limit, still decodes v2); recent designs
  (`lib/recent.ts`); undo/redo (`store/history.ts`, reference-diff subscriber,
  800 ms coalescing, cap 100). Warnings surface only through the Issues badge.
- Validation is layered: the engine's own gate (`solid/validate.ts` plus
  `auditPrintability`) runs on every bake in the app; the Python validator
  cross-checks exported files independently of the TypeScript that wrote them
  (all 04 stage 4 rows, the container rows, and the sidecar-driven
  `max_height_mm` and `attribution` rows); and `make gate` ties them together
  (see `RUNBOOK.md` for the eight steps and current numbers). CI
  (`.github/workflows/ci.yml`) mirrors the gate: pytest, the static no-skip
  guard, lint/typecheck/vitest/build, both `bake:cli` bakes judged by the
  validator, and the Playwright suite with `E2E_BUDGET_FACTOR=3`.

## 7. Fonts and shared math

Glyph outlines for preview and engine come from committed assets
(`apps/web/lib/fonts/<face>.glyphs.json`, three OFL faces, generated by
`services/bake/scripts/gen_font_assets.py`); the layout lives in the shared
transform pair, so the preview draws text at the exact printed positions.
`lib/transform.ts` and `app/geom/transform.py` stay mirrored function for
function (scale, thresholds, Z placement, lettering layout, height
exaggeration curve and its true inverse, terrain scale), pinned by
`fixtures/parity-expected.json` and `fixtures/tokens-expected.json`.

## 8. Distribution (`docs/handoff/v3-08-dist.md`)

- **Static site.** One build-time knob, `NEXT_PUBLIC_BASE_PATH` (empty for a
  domain root and the desktop app, `/framecraft` for GitHub Pages), feeds
  `basePath`/`assetPrefix` and `apps/web/lib/basePath.ts`, which prefixes the
  two runtime-constructed URLs Next cannot rewrite (the MapLibre worker URL
  and the manifold WASM fetch, via `installWasmBasePathFetchShim`).
  `apps/web/scripts/serve-static.mjs` serves `out/` locally, with `--base`
  reproducing the Pages sub-path exactly. `.github/workflows/pages.yml`
  deploys on every push to main.
- **Desktop.** `apps/desktop/` is a Tauri 2 shell around the same `out/` tree
  (empty base path). No `@tauri-apps/*` JS is bundled: `apps/web/lib/platform.ts`
  detects Tauri and calls `window.__TAURI__.core.invoke` for the two Rust
  commands, `save_export` (native save dialog) and `cache_dir`.
  `.github/workflows/release.yml` builds installers on a `v*` tag (Windows
  msi+nsis, macOS universal dmg, Linux appimage+deb) and attaches them plus a
  zip of the static site to a GitHub Release; signing is secrets-driven and
  currently absent, so every artifact ships unsigned.

## 9. History

Through v1 and v2 the bake ran server-side: the browser POSTed a
`SceneRequest` to `services/bake`, which fetched Overpass, built the
SceneGraph, ran the manifold3d pipeline in a worker thread and served the
files, under the rule "the browser never runs booleans". `[V3-A1]` retired
that rule; `lib/api.ts` and the polling bake state machine were deleted in
phase 2 (`docs/handoff/v3-02-integration.md`). The v2 architecture is
preserved in git history (v1 baseline commit `da9ab83`, the v2 tree at the
start of the v3 run) and in `docs/handoff/v2-*.md`.

## 10. Known limitations

- **Draped thin walls.** Steep terrain can shear base walls under the printable
  minimum; the in-app audit warns (`wall-too-thin`, with the draped slice
  sweep) and offers the safe fixes, but the model is the user's call.
- **Tint is preview and OBJ only.** `colour.tint` is data, never geometry;
  3MF/STL/STEP colour by region (`[V3-P5-F8]`).
- **STEP is a faceted B-rep** (planar triangle faces, AP214), not smooth CAD
  surfaces; the export notes its size above 50k triangles (`[V3-A6]`).
- **Unsigned installers.** SmartScreen and Gatekeeper warn on first launch
  until signing secrets exist (`release.yml` header documents the hooks).
- **Loose-part bakes fail the reference `bodies` row by design.** A separate
  frame, cleat wedge or easel leg is a deliberate second body; the engine's
  own gate excuses exactly the expected ones (`expectedBodies`), but the file
  validator counts what is there. The `expected_bodies` sidecar field that
  would teach it is designed but not built (`docs/handoff/v3-05-frame.md`).
- **Frame-off Chicago fixture.** `frame: false` on the committed fixture fails
  the validator's `min_wall` row (0.167 mm in one merged block), and
  `degenerate_faces` at plate 256; pre-existing in the crop/merge path,
  reproduced independent of attribution (`[V3-P7-A11]`).
- **Per-region volumes double-count the 0.2 mm seams** (+5.18 % on Chicago);
  anything summing them instead of `merged.volumeMm3` is wrong.
- **Colour-change is band-limited.** Regions sharing Z layers with another
  slot cannot get their colour on one nozzle; the plan reports them as
  inseparable rather than pretending.
