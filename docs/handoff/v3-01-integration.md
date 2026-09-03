# v3-01 integration (Task 1: the store and the preview)

Written against `docs/handoff/v3-01-pipeline-design.md` section 5 (binding),
`docs/handoff/v3-01-pipeline.md` sections 4, 5 and 10 (the API as it landed)
and `docs/handoff/v3-01-inventory.md` sections 5 and 6 (the mechanism of the
author's complaint). Every number below was measured in this tree.

## 1. The store shape as landed

`store/editor.ts` drives `PipelineClient` directly. `state.engine` is gone;
`state.pipeline` is:

```ts
export type PipelineStatus = "idle" | "running" | "ready" | "error";

interface PipelineProgress {
  stage: string;          // the stage RUNNING, "" before the first one
  index: number; total: number;
  elapsedMs: number;      // this run's reported stage time so far, not a clock
  etaMs: number | null;   // previous run's cost for the stages still ahead
  phase: Phase;
}

interface PipelineJobState {
  status: PipelineStatus;
  stale: boolean;
  progress: PipelineProgress;                  // IDLE_PIPELINE_PROGRESS when idle
  regions: ReadonlyMap<string, RegionMesh>;    // referentially stable per region
  regionHashes: Readonly<Record<string, string>>;
  result: EngineResult | null;                 // positions re-attached
  error: { stage: string; message: string; detail: string | null } | null;
  lastRunStageMs: Readonly<Record<string, number>>;
}
```

Exports: `PIPELINE_DEBOUNCE_MS = 80`, `ETA_MIN_STAGES = 3`,
`IDLE_PIPELINE_PROGRESS`, `NO_REGIONS`, `initialPipelineState`,
`markPipelineStale`, and `cancelPipeline()` in place of `cancelEngineJob()`.
`SceneState` gains `hash: string | null`, the worker's own `normalise` key,
sent back as `knownSceneHash`.

Rules, all pinned by `store/editor.pipeline.test.ts` (28 tests, a mocked
client driven event by event) and by `store/editor.test.ts` (72 tests, the
real inline transport):

- **Live runs use the request the last Preview fetched**, never
  `{kind:"cached"}`. That is what lets a `heights.*` write re-run `normalise`
  over the cached Overpass response with no network: with a cached source the
  runner serves `normalise` from the cache whatever `heights.*` says.
- `known` is `regionHashes`, kept hash-complete between events: a
  `region-ready` carries each mesh's own finish key and the store stores it
  with the mesh. A run cancelled halfway through the region phase therefore
  leaves `known` describing exactly what is on screen, including the regions
  the abandoned run replaced. `removed` is applied as the superset it is,
  dropping every named region whether or not the worker was told we held it.
  `done` adopts `regionHashes` wholesale.
- `heroIds: null`: the `heroes` stage resolves `hero_auto` in the worker
  (pipeline 3.5), so `currentHeroIds` is gone from the store.
- `terrain` is passed with `gate: "param"`, so the `terrain` stage owns the
  `terrain.enabled` decision ([V3.1-P1-9]).
- Errors land as `{stage, message, detail}` where `detail` is the worker's
  structured detail plus the stack. An Overpass failure is reported on the
  SCENE (with the mirrors tried) and leaves the last good model alone, exactly
  as `generate()` did before. A cancel is not an error.
- `requestExport()` awaits the run in flight (or starts one, superseding an
  in-flight run that a pending debounce has already made out of date) and then
  calls `PipelineClient.exportFiles`. It never builds twice. A refusal from
  the printability gate (`PipelineStageError` at stage `export`, Stage 4
  findings on `detail.blocking`) becomes the export error naming every failed
  check by title, and the previously downloadable files stay exactly where
  they were. `ExportRequest.force` is never sent; the request the store makes
  carries `stem`, `source` and `createdIso` and nothing else, which a test
  asserts by key.
- The `done` result's REGIONS are re-attached from the stream; `merged` and
  `tiles` are left exactly as `PipelineClient` handed them over, because the
  client already re-attaches the copies it kept when the worker strips them as
  unchanged (`knownMergedHash`/`knownTilesHash`, which the client fills in
  itself, so the store passes neither). `seedSceneHash` is not needed here:
  every run this store makes carries a `{kind:"request"}` source, so the scene
  hash always arrives on `scene-ready`.
- `generate()` keeps its name ([V3.1-O3]) and is now one run: fetch, normalise,
  the geometry, the regions and the audit, in one job with one cache.

`lib/exportFlow.ts` lost `runExport`/`writeExport`; `exportDone(previous,
ExportOut, findings)` turns the transferred bytes and the sidecar object into
Blob URLs, marks `export.bytes`, and keeps `EXPORT_STALE_NOTE` and
"Done (outdated)" unchanged. `stemForResult` stays and is passed to the
`export` stage, because the stage's own fallback does not `sanitizeStem`.

## 2. What was deleted

- `components/scene/BasePlate.tsx`, `RoadRibbons.tsx`, `AreaSurfaces.tsx`
  (+ its test), `TreeInstances.tsx`. `InstancedBuildings.tsx` became
  `BuildingPickProxies.tsx` (test renamed with it).
- `lib/preview.ts`: `buildRoads`, `buildAreas`, `buildTrees`,
  `treeInstanceMatrices`, `buildPreview`, `mergeNoticeMetres`,
  `PreviewRibbons`, `PreviewTree`, `PreviewModel`. What remains is the pick
  footprints (`buildBuildings`, `buildingInstanceMatrices`, the hull and
  rectangle maths), `PreviewArea` (the shared contour type the engine's own
  lettering, frame and tiling code consumes) and the two HUD notices.
- `lib/previewText.ts`: `textLayers`, `textPieceZMm`, `TEXT_Z_LIFT_MM`,
  `PreviewTextLayer`. `buildPreviewText` STAYS: it is the shared layout's
  answer to "how many rings does this text put on the plate and what did it
  refuse", published as `data-preview-text-count` and read by four e2e specs
  (`ui.spec.ts` pins the exact count of 8 rings for "Chicago"), and its
  `notices` are the adjustments drawer's. Nothing it produces is drawn.
- `components/scene/palette.ts`: `paletteFor` (the `part_colors` painter).
  `part_colors` is a matrix exemption now and the region meshes carry the
  engine's own colours.
- The "Updating model..." badge, the "Preview is approximate" note, and the
  approximate-layer half of `previewDeps` (`thresholds`, `roads`, `water`,
  `green`, `trees`).
- `store/editor.ts`: `EngineJobState`, `initialEngineState`,
  `markEngineStale`, `currentHeroIds`, `runEngineJob`, `cancelEngineJob`.

## 3. The viewport

`components/scene/PreviewScene.tsx` is new and holds everything inside
`<Canvas>`. That is what makes the invariant enforceable rather than
aspirational: `CityPreview.test.ts` reads every file under
`components/scene/`, and only `BuildingPickProxies.tsx` (named exception 1)
and the two HUD hosts outside the canvas (`CityPreview.tsx`,
`PreviewPane.tsx`) may read a `PrintParams` field at all. `PreviewScene` may
name the type twice, to declare the prop it hands the pick proxies untouched.
The same suite cross-checks the fifteen parameter groups the HUD does not read
against `claimedPaths()` from the stage registry, so "the viewport ignores it"
now has to mean "a stage reads it".

`RegionMeshes` takes the region map, `recessBands`, `dimmed` and the two
multipliers. `RegionGeometryCache` (a plain class, so it can be driven twice
in a test without a React renderer) rebuilds a region if and only if its
`RegionMesh` object, its band list or the shade changed.

Recess shading: a region with no bands keeps the indexed mesh exactly as
before and pays nothing. A region WITH bands is expanded to per-triangle
vertices and given a colour MULTIPLIER, 1 outside a band and `recessShade`
inside, so the region's own filament colour is unchanged outside the cuts.
The test walks every triangle and asserts the darkened ones have a centroid Z
inside a band, the light ones do not, and every coordinate the engine sent is
still present.

The viewer theme control moved to `PreviewPane`, which now carries
`data-fc-viewport-theme`, so it survives the empty and skeleton states. Two
new design tokens, `--fc-preview-dim-opacity` and `--fc-preview-recess-shade`,
declared per theme and read through `readViewportMultipliers`.

The stage overlay (`data-testid="pipeline-stage-overlay"`) carries a **Stop**
button wired to `cancelPipeline()`. It is its own store subscriber: a run
reports 142 stage events on a full Chicago plan, and reading `progress` from
`CityPreview` re-rendered the whole viewport on every one of them.

Copy: `CityPreview.tsx`'s height-ceiling pill says "The model will be
refused"; the retired approximation note took the other "the build" string
with it.

## 4. The exceptions list as it stands

Unchanged from `v3-01-pipeline.md` section 5, and no new entry:

1. **Building pick proxies** — invisible per-building boxes for raycasting
   only. `colorWrite: false` and `depthWrite: false` on a transparent
   material, never `visible={false}` (three's `Raycaster` checks `visible` and
   stops), no shadows, and no colour of any kind.
2. **Recess shading** — vertex colour multipliers on the declared bands,
   geometry untouched.
3. **Map overlay and stats use the SceneGraph, not the solids** — the HUD's
   building count is the scene's repaired footprint count, settled when the
   scene lands; the triangle count next to it is the model's, measured.

## 5. Measurements (built app, Chromium, `?perf=1`, Chicago fixture)

Main-thread work this task adds, cold full-Chicago preview:

| span | ms |
|---|---|
| `preview.region.base` | 10 |
| `preview.region.roads` | 7 |
| `preview.region.buildings` | 2 |
| `preview.region.frame` | 2 |
| `preview.region.parks` | 1 |
| `preview.region.water` | 0 |
| `preview.overlay` (288 stage events) | 1 |

Longest main-thread task during a run: **113 ms**, against **116 ms** measured
on the same page with NO run in flight at all (8 s idle: 83 tasks, 8466 ms
total, against 90 tasks and 8439 ms during the run). The ceiling is
SwiftShader rasterising a 172k-triangle scene every frame, not this task's
code: nothing it adds comes near 50 ms, the largest single block being the
10 ms base-region geometry build.

E2E budgets observed, `E2E_BUDGET_FACTOR=3`:

| measurement | observed | budget |
|---|---|---|
| lettering change to the frame region on screen | 530 ms (525, 542, 556, 615 across runs) | 1200 ms |
| warm preset click to preview (A1) | 1.33 s | 15 s |
| export to download (A4) | 2.1 s | 270 s |
| full Chicago parts export | 3.0 s | — |

The lettering number is measured INSIDE the page, from the input event to the
animation frame on which the frame region's version attribute moved. Polling
it from Node costs a round trip per sample and reported 1432 ms for the same
0.55 s of work. Against the design's own 400 ms target the browser misses by
about 130 ms where Node measured 118 ms; the extra is the 80 ms debounce plus
one React commit and one geometry upload.

## 6. Tests

`npm run lint` clean. `npm run typecheck` clean. `npm test`: 1836 tests, 0
skipped, 0 todo; 1831 pass. The five failures are all in `lib/engine/**`,
which this task may not touch: two are the matrix wave's own KNOWN DEFECT
probes ([V3.1-P2-1] rail width, [V3.1-P2-2] lip depth, both red until Task 7),
two are the pipeline wave in flight (`graph.test.ts`'s embedded stage table
against a registry that moved, and `incremental.test.ts`'s per-triangle
building identity), and one is `protocol.test.ts`, which passes in isolation
and failed only under the parallel workers' load. Every file this task owns is green:
16 files, 333 tests.

The pipeline author's additive API changes, and the test that covers each:

| adopted | test |
|---|---|
| per-region `hashes` on `region-ready`, kept with the mesh and sent back as `known` | "a cancel that arrives after regions were streamed keeps those regions AND their hashes" and "keeps each region's mesh object stable" |
| `removed` applied as a superset | "drops every region the worker says the model lost, including ones it was never told we hold" |
| `done.result` carries whole `merged` and `tiles`; only the regions are re-attached | "leaves the merged mesh and the tiles the client handed it alone" |
| the export refusal, named by finding | "names every check when the printability gate refuses the export" and "leaves the last good export alone when a later one is refused" |
| `ExportRequest.force` never sent | "never asks the engine to force a blocked export" (asserts the request's keys) |
| `knownMergedHash`/`knownTilesHash` left to the client, `seedSceneHash` not needed | "runs against the request the last Preview fetched, and re-sends neither the scene nor an unchanged region" |

New: `store/editor.pipeline.test.ts` (28). Rewritten:
`components/scene/CityPreview.test.ts` (20), `RegionMeshes.test.tsx` (13, the
two old files folded into one), `lib/enginePreview.test.ts` (12),
`lib/exportFlow.test.ts` (12), `store/editor.test.ts` (72),
`store/history.test.ts` (29), `store/editor.terrain.test.ts` (12), plus new
blocks in `lib/hud.test.ts`, `lib/warnings.test.ts` and
`components/scene/palette.test.ts`.

Under the build lock: `npm run build` exit 0 (static export, `/` 183 kB,
286 kB first load). `E2E_BUDGET_FACTOR=3`, chromium: `smoke` 8/8 (2.8 min),
`colour` + `lettering` + `terrain` + `share` 11/11 (1.3 min), `a11y` 4/4
(2.8 min, 0 axe violations in either theme). Also run and green: `ui` (22),
`workflow` (4), `search` (13), `print` (4).

Three tests were added to `smoke.spec.ts`: a frame-profile change keeps every
region on screen dimmed under an overlay naming a stage and rebuilds the frame
but not the buildings, with no Overpass call; the lettering budget above; and
Stop during a plate resize leaving the previous model up with nothing claiming
a stage broke.

## 7. Rewritten rather than deleted

- `CityPreview.test.ts:299-320` ("these ten groups rebuild nothing") is now
  two assertions instead of one: the groups still rebuild no HUD memo, AND
  every leaf of those groups is claimed by a pipeline stage
  (`claimedPaths()`), so the reason it is safe is checked rather than
  asserted. The old test was true and was the defect.
- `print.spec.ts`'s fix-button transient ("disabled, reading Fixed") became a
  poll over "never still offered". With `PIPELINE_DEBOUNCE_MS` at 80 ms the
  incremental run can retire the whole row before an assertion sees the
  transient; the invariant that survives is the one that matters.
- `store/editor.test.ts`'s share round trip writes `colour.region_colors`
  instead of the v1 `part_colors`. A payload naming `part_colors` without
  `region_colors` is deliberately MIGRATED at parse time ([V3.1-P1-2]), so
  round-tripping it is no longer the contract; `lib/share.test.ts` owns the
  migration.
- `smoke.spec.ts` gained `exportAndWait`: choosing a format in the export menu
  already exports (`ExportMenu.onChange`), so the panel can be showing a
  finished export before the button is pressed, and with the writer in the
  worker the old links stay on screen for the round trip. Reading an href
  without waiting for the links to CHANGE read a URL the click was about to
  revoke. This was latent before; the asynchronous export exposed it.

## 8. Found and not touched

**Engine (`lib/engine/**`, forbidden to this task).**

1. `worker.ts` drains `perfDrainTimings()` when it posts a terminal response,
   but `runner.ts:771` wraps the whole run in `perfSpan("engine.build", run)`,
   which closes only AFTER `done` has been emitted. A run's own `engine.build`
   row is therefore always one terminal message late, and invisible for the
   last run of a session. Repro: build, `?perf=1`, click the Chicago preset,
   wait for the stats card to show Triangles, read the HUD. `overpass.fetch`,
   `osm.normalize`, every stage row and every `phase.*` row are present;
   `engine.build` is absent, and appears only after a second run. This is why
   `e2e/perf.spec.ts:87` now fails. It passed before only because the store
   ran two jobs per preview (ingest then build) and the row the HUD showed was
   the INGEST's `engine.build`, misattributed. Not in this task's verification
   list; left red deliberately rather than weakened.
2. `runner.ts:errorDetail` returns `undefined` for any stage throw that is not
   an Overpass or undeclared-read error, so a stage failure crosses the wire
   as a bare message with no stack. The store surfaces everything that DOES
   arrive (`failureDetail` joins the structured detail and the main-thread
   stack), but the worker-side stack of the throwing stage is lost. Worth one
   line in the `error` event.
3. The `export` stage computes its own stem fallback without `sanitizeStem`
   (`stages.ts:1178`), so a city label carrying a path separator would reach a
   file name for any caller that does not pass `stem`. The store passes one.

**Product gap this wave opens.** `colour.tint.*` no longer reaches a pixel.
The tint was painted by the instanced approximation; the fused region meshes
carry one colour per region and `buildingTints` is metadata the OBJ exporter
reads. The contract still moves (`EngineResult.buildingTints` changes, so the
matrix probe passes) and `tintPreviewOnlyWarning` still fires for the targets
that cannot carry it, but its message says "affects the preview and the OBJ
export only" and the preview half is no longer true. Either the tint becomes
per-triangle vertex colour on the buildings region (the recess pass already
proves the mechanism) or the warning's copy has to change. Not this task's
files to decide.

**Concurrent-edit exception.** `components/editor/groups/ColourGroup.tsx:125`
and `TerrainGroup.tsx:25` are outside this task's list but each read
`state.engine`, which no longer exists. One selector line was changed in each
(`state.engine` to `state.pipeline`) and nothing else; the settings truth
agent's own edits to those files landed around it without conflict. The
compile-only edits inside the allowed list were `EstimateCard.tsx` (three
selectors plus `"computing"` to `"running"`), `ExportMenu.tsx` (one selector),
`OutputPanel.tsx` (one selector) and `StatsCard.tsx` (one selector, the error
now being an object with a `message`).

**Left for the action-bar and Tasks 10/11.** The keyboard building cursor and
the hero pick no longer have a visible highlight: the instanced layer that
painted them is invisible now, and the engine's hero solid carries its own
filament colour but nothing marks "the cursor is here". The readout
(`preview-cursor`, a live region) still announces it, so nothing is
unreachable, but a sighted keyboard user has lost the ring. Tasks 10 and 11
extend the pick proxies and are where it belongs. The unused
`--fc-preview-hero`, `-hero-pick`, `-cursor`, `-text-*` and `-pocket` slots
are kept in `palette.ts` and `globals.css` for exactly that reason.
