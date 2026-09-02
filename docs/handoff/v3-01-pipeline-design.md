# v3-01 pipeline design (frozen interface for the Task 1 agents)

Written by the orchestrator from `docs/handoff/v3-01-inventory.md` and
`v3-02-inventory.md`. This is the contract between the pipeline core agent
(engine side), the integration agent (store and preview side) and the matrix
test agent. Names below are binding; an agent that needs to deviate writes the
reason in its handoff note and a `[V3.1-P1-*]` line in `DECISIONS.md`.

## 1. What the inventory proved

- One traversal, 63 operations, every WASM handle freed at the end. Nothing
  survives between two jobs, so every slider settle costs a full 7.5 s Chicago
  build even when only a lettering string moved.
- 68 % of that time is not geometry: `finishRegions` (1.7 s) and the welded
  `merged` extraction (3.4 s) run after everything and depend on everything.
- The preview never waits for the solids: `stale` alone unmounts the engine
  meshes and the approximate layers take over, and those layers ignore
  `frame_style`, `tiling`, `terrain`, `bridges`, `regions`, `colour` and
  `height_exaggeration` by design (pinned in `CityPreview.test.ts:299-320`).
  That is the author's "most settings do nothing".
- Engraved frame text is cut into the frame region and drawn in the frame
  colour, so it becomes invisible exactly when the real result lands.
- `heights.*` is read by ingest only; a change schedules a build and no ingest,
  so the two sliders cannot be applied without moving the pin.
- The region meshes are transferred (detaching the worker's copy), the merged
  mesh and the 1.2 MB scene are structured-cloned on every job.

## 2. Rulings

1. **One resolution.** The preview renders the exact solids the export writes.
   No reduced-tessellation preview: the geometry stages cost about 1.8 s on
   Chicago and the segment-count knobs are a rounding error inside that, so a
   second resolution would double the cache for nothing. The named-exception
   list in `v3-01-pipeline.md` therefore contains presentation and picking
   items only (section 7), never a geometric approximation of a printed part.
2. **Two-phase delivery inside one job.** Stages are ordered so that every
   per-region mesh is finished and posted to the main thread before the
   assembly, the merged extraction, the min-wall measure, validation, islands,
   tiling and the audit run. The preview updates at the first phase; findings,
   stats and export readiness arrive at the second. A parameter change that
   only moves a lettering string re-runs lettering, the frame region and its
   finish, and the preview is on screen before the audit starts.
3. **Progressive regions.** The worker posts each finished region mesh as soon
   as its `finish.<region>` stage completes (batched at most every 50 ms). On
   a first build the plate appears, then the buildings, then the surfaces.
   The main thread keeps a map `region -> {hash, mesh}` and only replaces
   entries whose hash changed; the worker never re-sends an unchanged region.
4. **The cache lives in the worker and holds WASM handles.** One output per
   stage (the latest), keyed by the stage's input hash. When a stage re-runs,
   the previous output's handles are deleted. Memory is bounded by
   construction: never more than one generation. The per-job `Arena` becomes a
   per-stage arena for temporaries; a stage's declared outputs are moved out of
   the arena and owned by the cache.
5. **Fetch and normalise are stages of the same pipeline, in the same
   worker.** `fetch` (Overpass, cached in memory and IndexedDB exactly as today)
   and `normalise` (`osm/scene.ts:buildScene`) are stages 0 and 1, keyed by the
   SceneRequest and by `heights.*`. The second worker goes away. The normalised
   SceneGraph is posted to the main thread once per new hash (`scene-ready`),
   because the map overlay, the picking proxies and the stats need it. A
   `heights.*` change re-runs `normalise` from the cached Overpass response
   with no network, which closes the inventory's worst flag.
6. **Exporters run in the worker.** `exportForTarget` and `buildSidecarJson`
   are pure; they move behind an `export` stage whose inputs are the second
   phase outputs plus `export_target`, `color_mode`, the printer profile and
   the provenance fields. Files come back as transferred `ArrayBuffer`s. This
   removes the largest remaining main-thread block and makes "Export = run the
   remaining uncached stages and write the file" literally true.
7. **Cancellation is cooperative at stage boundaries.** The runner checks an
   abort flag before every stage; a manifold call in progress cannot be
   interrupted and the longest single stage (the merged extraction) is the
   ceiling on cancel latency until Task 7 shortens it. A superseded job keeps
   every stage output it completed; the successor reuses them.
8. **Findings are stage outputs, not a channel.** `ctx.findings`,
   `ctx.resolvedText` and `ctx.markBands` become part of the producing stage's
   output and are concatenated in stage order when the result is assembled, so
   a memoised stage that does not re-run still contributes its findings.
9. **Matrix exemptions are exactly three, each with a stated reason and a
   compensating test**: `schema_version` (payload metadata, no physical
   meaning; the sidecar echoes it and `share.test.ts` pins the version gate),
   `colour.preview_theme` (a viewer setting that the settings sweep moves out
   of the settings panel into the viewport HUD; it changes the preview
   background and is echoed in the sidecar), and `part_colors.*` (the v1
   colour block; a loaded v1 or v2 payload that carries `part_colors` and no
   `colour.region_colors` is migrated into `region_colors` at parse time, and
   the migration is tested; the seven wells disappear from the UI). Every
   other leaf field, including `colour.palette` (written into the sidecar and
   the 3MF metadata), `export_target`, `color_mode`, `hero_auto.*` and every
   `heights.*` field, must move both the preview and the file.
10. **Location is not a parameter.** `lat`, `lon`, `radius_m`, `rotation_deg`
    and the preset id form the `fetch` stage key; changing them marks the
    scene stale and waits for the Preview action (network cost is explicit).
    Every `PrintParams` write schedules a live incremental run after a short
    debounce (`PIPELINE_DEBOUNCE_MS = 80`, down from 400) and supersedes any
    run in flight at its next stage boundary.

## 3. Module layout (engine side, owned by the pipeline core agent)

```
apps/web/lib/engine/pipeline/
  paths.ts      ParamPath type = the generated PRINT_PARAM_LEAF_PATHS union
  hash.ts       stable hashing of picked param fields + upstream hashes
  stage.ts      StageDef, StageContext, StageOutput types, defineStage()
  stages.ts     THE ordered registry: every stage with its param and input claims
  graph.ts      validation (acyclic, inputs declared before use), topo order,
                downstream-of(paths) queries, machine-readable export
  cache.ts      one-generation cache with handle disposal
  runner.ts     runPipeline(job, cache, emit, signal): incremental execution,
                progress events, phase checkpoints, cancellation
  result.ts     assembles EngineResult from stage outputs (stage order)
  index.ts      public surface
```

`lib/engine/engine.ts` keeps an exported `buildModel(input, options)` (the
renamed `bake`) implemented as "run every stage with a fresh cache and return
the EngineResult", so the ~79 direct test callers and `bake-cli` keep working
with signature-only churn. `onSolids` survives as a runner option.

### 3.1 Contract generation

`packages/contracts/gen_ts.py` additionally emits
`export const PRINT_PARAM_LEAF_PATHS = [...] as const` and
`export type PrintParamPath = (typeof PRINT_PARAM_LEAF_PATHS)[number]`: every
leaf of `print_params.json` as a dotted path, arrays as `engravings[].text`,
nested objects fully expanded, in schema order. `gen_py.py` emits the same list
as `PRINT_PARAM_LEAF_PATHS: tuple[str, ...]`. Deterministic, regenerated by
`make contracts`, never hand-edited. The graph test compares the registry's
claims against this list, so a schema addition without a claim fails CI.

### 3.2 Stage definition

```ts
interface StageDef<Out> {
  id: StageId;                      // string literal, unique, kebab-case
  params: readonly PrintParamPath[];// leaf paths this stage reads (may use
                                    // prefix form "frame_style.*" expanded by
                                    // graph.ts against PRINT_PARAM_LEAF_PATHS)
  inputs: readonly StageId[];       // upstream stage outputs it consumes
  extra?: readonly ExtraKey[];      // non-PrintParams keys: "scene-request",
                                    // "terrain-grid", "hero-ids", "date",
                                    // "export-target-request", "labels",
                                    // "object-overrides" (the last two land
                                    // with Tasks 11 and 12)
  phase: "scene" | "geometry" | "region" | "audit" | "export";
  run(ctx: StageContext, inputs: InputsOf<...>): Out | Promise<Out>;
  dispose?(out: Out): void;         // delete WASM handles owned by the output
}
```

A stage reads parameters ONLY through `ctx.param(path)` for the paths it
declared; `ctx.param` throws in tests when a stage reads an undeclared path
(a Proxy over the params object in a `strictClaims` mode the graph test turns
on). That is what makes the declarations trustworthy rather than aspirational.

### 3.3 The registry (ordered; ids are binding)

| id | phase | params (leaf paths, prefixes expanded) | inputs | output |
|---|---|---|---|---|
| `fetch` | scene | (none; extra `scene-request`) | | raw Overpass response (cached by request sha1, memory + IndexedDB) |
| `normalise` | scene | `heights.*` | fetch | EngineSceneGraph (posted once per hash as `scene-ready`) |
| `context` | geometry | `plate_mm`, `base_thickness_mm`, `nozzle_mm`, `frame`, `frame_style.shadow_gap.*`, `frame_style.matting.*`, `regions.*`, `printer_profile`, `custom_profile.*` | normalise | scale, extents, thresholds, placements (pure numbers) |
| `terrain` | geometry | `terrain.enabled`, `terrain.smoothing`, `terrain_exaggeration` (extra `terrain-grid`) | context | sampler + drape closures, relief finding |
| `heroes` | geometry | `hero_building_ids[]`, `hero_mode`, `hero_auto.enabled`, `hero_auto.count` (extra `hero-ids` only if the store still resolves auto heroes; prefer moving `heroCandidates` scoring here so the field is claimed by the worker) | normalise | effective hero id list + hero findings |
| `repair-buildings` | geometry | `small_scale`, `large_scale`, `height_exaggeration.*`, `road_scale`, `regions.building_skirt_mm` | context, heroes | footprint CrossSection, per-building sections, counts |
| `surface-water` | geometry | `water`, `regions.water.*` | context, repair-buildings | SurfaceRegion |
| `surface-rail` | geometry | `regions.rail.*` | context, repair-buildings, surface-water | SurfaceRegion |
| `surface-roads` | geometry | `road_mode`, `road_scale`, `regions.roads.*`, `bridges.enabled` | context, repair-buildings, surface-water, surface-rail | SurfaceRegion |
| `surface-parks` | geometry | `regions.parks.*` | context, repair-buildings, surface-water, surface-rail, surface-roads | SurfaceRegion |
| `buildings` | geometry | `small_scale`, `large_scale`, `height_exaggeration.*`, `hero_mode`, `regions.building_skirt_mm`, `colour.gradient.*`, `colour.tint.*`, `colour.region_slots.buildings`, `colour.region_slots.hero_building`, `colour.region_colors.buildings`, `colour.region_colors.hero_building` | context, terrain, heroes, repair-buildings | band solids, hero solid, sockets, tints |
| `bridges` | geometry | `bridges.*`, `road_mode`, `road_scale`, `regions.roads.*`, `regions.rail.*` | context, terrain, repair-buildings | deck solids per region, dropped count |
| `trees` | geometry | `trees` | context, terrain, repair-buildings, surface-water, surface-rail, surface-roads, surface-parks | cone union, counts |
| `tokens` | geometry | `city_label`, `place.*`, `hero_building_ids[]` (extra `date`) | normalise, heroes | token table |
| `fonts` | geometry | `engravings[].font`, `underside_mark.enabled`, `underside_mark.template` | | glyph outlines (module cache) |
| `attribution` | geometry | `frame`, `hanger`, `underside_mark.*`, `base_thickness_mm` | context, tokens, fonts | baseCut, frameCut, markBands, underside reserve |
| `lettering` | geometry | `engravings[].*`, `frame`, `hanger`, `tiling.enabled`, `tiling.cols`, `tiling.rows`, `scale_bar.*`, `colour.region_slots.lettering`, `colour.region_colors.lettering` | context, tokens, fonts, attribution | frameCut, frameAdd, inlayCut, inlay, baseCut, layout, resolvedText, findings |
| `ornaments` | geometry | `north_arrow.*`, `scale_bar.*`, `hanger`, `base_thickness_mm` | context, lettering | frameCut, baseCut |
| `hangers` | geometry | `hanger`, `base_thickness_mm` | context | baseCut pockets, standing parts (cleat, easel) |
| `frame-cutters` | geometry | `frame_style.shadow_gap.*`, `frame_style.matting.*`, `frame_style.separate.*`, `frame_style.texture.*`, `hanger_magnet.*`, `north_arrow.*`, `scale_bar.*`, `colour.region_slots.matting`, `colour.region_colors.matting` | context, lettering, ornaments | gap cutter, matting solid, mating (baseAdd, baseCut, frameCut), texture cutter |
| `base` | geometry | `base_thickness_mm`, `colour.region_slots.base`, `colour.region_colors.base` | context, terrain, surface-* (4), buildings, lettering, ornaments, attribution, hangers, frame-cutters | base region solid (carved, draped) |
| `frame` | geometry | `frame`, `frame_style.profile`, `frame_style.corner`, `frame_style.corner_radius_mm`, `frame_style.lip_depth_mm`, `colour.region_slots.frame`, `colour.region_colors.frame`, `colour.region_slots.attribution`, `colour.region_colors.attribution` | context, lettering, ornaments, attribution, frame-cutters | frame region solid, matting region passthrough |
| `region-<name>` | region | the region's slot and colour fields | the stages that feed it | final region solid (drape applied, bridges joined into roads/rail, trees into parks, inlay union for lettering, standing parts for cleat/easel) |
| `sit` | region | (none) | region-base, hangers | the shared Z offset that puts the model on the bed |
| `finish-<name>` | region | (none) | region-<name>, sit | RegionMesh (prune, translate, mesh) posted as `region-ready` |
| `assembly` | audit | (none) | every geometry stage | the welded solid rebuilt from primitives (steps 40 to 46) |
| `merged` | audit | (none) | assembly, sit | cleaned assembly + RegionMesh |
| `measure` | audit | `nozzle_mm`, `terrain_exaggeration` | assembly, attribution | min-wall report |
| `validate` | audit | `printer_profile`, `custom_profile.*`, `hanger`, `frame_style.separate.*` | assembly, measure, every finish-* | gate findings, expected bodies |
| `islands` | audit | (none) | merged, every finish-* | island report |
| `tiling` | audit | `tiling.*` | merged, every finish-*, attribution | TileResult[] |
| `audit` | audit | `printer_profile`, `custom_profile.*`, `trees`, `bridges.enabled`, `tiling.*`, `frame_style.*`, `colour.region_slots.*` | validate, islands, tiling, measure, every stage that emits findings | the ordered finding catalogue, stats |
| `export` | export | `export_target`, `color_mode`, `printer_profile`, `custom_profile.*`, `place.*`, `city_label`, `colour.palette`, `colour.preview_theme`, `schema_version` (sidecar echo) | audit, merged, every finish-*, tiling | ExportFile[] (transferred) + sidecar |

Region names are the existing `COLOURABLE_REGION_NAMES` plus derived
`buildings_band_N`, `cleat`; `region-*` and `finish-*` stages are generated
from that list at module load so the registry stays finite and greppable.
`graph.ts` exports `describeGraph()` returning `{stages: [{id, phase, params,
inputs}]}` as plain JSON; the design doc's table above must match its output
(the pipeline note pastes the generated table, not a hand copy).

The `frame`, `bridges`, `tiling` and `audit` rows above claim more fields than
the inventory found read today because the inventory found real readers in
those steps (`frame.ts:881-888`, `roads.ts:128`, `audit/rules.ts:229`, `:355`,
`:409`); the pipeline agent verifies each claim by running the strict-claims
Proxy on the Chicago fixture and on the synthetic scenes and trims or extends
the table from what the code actually reads. The rule is: declare exactly what
is read, no more, no less; the Proxy enforces "no less", and the graph test's
"unused claim" check (a declared path never read across the whole matrix run)
enforces "no more".

## 4. Worker protocol (`lib/engine/protocol.ts`), additive

Requests: `{kind:"run", id, request: SceneRequest, params, terrainGrid?, date,
mode:"preview"|"full", perf}`; `{kind:"export", id, target, ...provenance}`;
`{kind:"cancel", id}`; `{kind:"set-scene-response", ...}` is NOT needed (the
worker fetches). `mode:"preview"` stops after the region phase; `mode:"full"`
continues through the audit phase; a subsequent `full` after a `preview` runs
only the audit phase because the region phase is cached. The store always asks
for `full` (findings are part of the product), and the two-phase delivery is
what makes the preview fast, not the mode; `mode` exists for tests and for
the CLI.

Events, all carrying `id`: `stage` `{stage, index, total, state:"start"|"done"|
"cached"|"skipped", elapsedMs}`; `scene-ready` `{scene, hash}`; `region-ready`
`{regions: RegionMesh[], removed: string[]}` (positions and indices
transferred, copied out of the cache first); `phase` `{phase, elapsedMs}`;
`done` `{result: EngineResult without region positions (they were streamed),
regionHashes, timings}`; `error` `{stage, message, detail}`; `cancelled`
`{atStage}`; `files` `{files:[{name, bytes}], sidecar}` transferred.

`client.ts` exposes `PipelineClient` with `run(input): RunHandle` (`handle.
progress` observable, `handle.regions` observable, `handle.done` promise,
`handle.cancel()`), and `exportFiles(target, provenance)`. Single-flight stays:
a new `run` while one is in flight sets the abort flag; the worker stops at the
next stage boundary, replies `cancelled`, then starts the newest request.

## 5. Store and preview (owned by the integration agent)

- `store/editor.ts`: `state.engine` becomes `state.pipeline` with
  `{status:"idle"|"running"|"ready"|"error", stale, progress:{stage, index,
  total, elapsedMs, etaMs|null, phase}, regions: Map<string, RegionMesh>,
  regionHashes, result: EngineResult|null, error:{stage, message, detail}|null}`.
  `etaMs` is null until three stages have reported and is computed from the
  previous run's per-stage durations for the stages still ahead.
  `cancelPipeline()` calls `handle.cancel()`; the last good `regions` and
  `result` stay on screen. Every `setParam` schedules a run after
  `PIPELINE_DEBOUNCE_MS` (80). `heights.*` writes go through the same path
  (the worker re-normalises). Location writes mark the scene stale and do not
  run; the Preview action runs.
- `components/scene/CityPreview.tsx`: the approximate layers (`BasePlate`,
  `RoadRibbons`, `AreaSurfaces`, `TreeInstances`, the `previewText` flat fills)
  are removed from rendering. `RegionMeshes` draws `state.pipeline.regions`
  progressively and keeps the previous meshes while a run is in flight, dimmed
  (opacity token) under an overlay naming the current stage. `InstancedBuildings`
  stays as an invisible picking layer only (renamed `BuildingPickProxies`,
  never visible), because Tasks 10 and 11 need per-object raycasting.
  `CityPreview.test.ts:299-320` is rewritten: the new invariant is that every
  PrintParams leaf path is claimed by a pipeline stage, and the preview reacts
  to a region hash change, not to a parameter.
- Recess shading: the engine emits `recessBands` (lettering engrave, ornament,
  underside) alongside `attributionBands`; `RegionMeshes` assigns a darker
  vertex colour to triangles whose centroid Z lies inside a band of its own
  region, so engraved text reads at viewing distance without any change to the
  geometry. This is presentation, listed as such in the exceptions.
- `lib/bake.ts` (renamed by Task 3) becomes a thin export flow over
  `PipelineClient.exportFiles`; the stale-export labelling stays.

## 6. Tests (owned by the matrix test agent, runner API from section 3)

- `lib/engine/pipeline/graph.test.ts`: the registry is acyclic; every input is
  declared upstream; every `PRINT_PARAM_LEAF_PATHS` entry is claimed by at
  least one stage except the three exemptions, each named with its reason; no
  claimed path is missing from the schema; `describeGraph()` matches the table
  in `v3-01-pipeline.md` (the note embeds the JSON).
- `lib/engine/pipeline/matrix.test.ts`: for every leaf path, a probe
  `{path, value, base?: Partial<PrintParams>, scene?: "synthetic"|"rail"|
  "bridge"|"terrain", assertPreview(before, after), assertExport(before,
  after)}`. `assertPreview` compares `EngineResult` regions (a specific region's
  triangle count, volume, bbox, colour, slot, tint list, band count, resolved
  text, findings) and `assertExport` parses the produced files (3MF XML object
  count, material colours, metadata, STL body bbox, sidecar fields, Bambu
  project settings) for a field-specific difference. Runs on the small
  synthetic scenes (a build there is a few hundred milliseconds) so the whole
  matrix stays under two minutes. A probe that cannot assert a field-specific
  change is a defect report, not a weaker assertion.
- `lib/engine/pipeline/incremental.test.ts`: changing `engravings[0].text` on
  a warm cache re-runs exactly `tokens`? no: `lettering`, `ornaments`,
  `frame-cutters`, `base`?, `frame`, the affected `region-*`/`finish-*`, and
  the audit phase, and nothing under `repair-buildings`, `surface-*`,
  `buildings`, `trees`; changing `plate_mm` re-runs everything after
  `normalise`; changing `heights.floor_height_m` re-runs `normalise` and
  everything after it; a cancelled run keeps its completed stages. Assert by
  stage-event lists, not timing.
- `lib/engine/pipeline/parity.test.ts`: `buildModel()` (fresh cache) and a
  warm incremental run that arrives at the same params produce byte-identical
  region meshes and identical `merged` (same cache key means same bytes).
- Timing budgets in existing tests stay as they are (fresh cache = full run).

## 7. Named exceptions (to be listed in `v3-01-pipeline.md`)

1. Building pick proxies: invisible per-building boxes for raycasting only;
   never rendered; a test proves their footprints equal the scene footprints.
2. Recess shading: vertex colours on declared bands; geometry untouched; a test
   proves the shaded triangles lie inside the bands.
3. Map overlay and stats use the SceneGraph, not the solids.

Anything else an agent wants to add to this list needs a `DECISIONS.md` line.
