# v3-01 inventory: the engine as it actually runs

Read-only audit of `apps/web/lib/engine` and everything that feeds or consumes
it, written so the next phase can design an incremental stage graph with
per-stage memoization from facts rather than from `docs/ARCHITECTURE.md`.

**Tree state.** HEAD is `7eda2d7`. The working tree also carries uncommitted
perf-instrumentation work another agent landed during this pass: new
`lib/perf.ts`, `lib/perf.test.ts`, `components/editor/PerfHud.tsx`,
`e2e/perf.spec.ts`, and edits to `lib/engine/{engine,worker,protocol,client}.ts`,
`lib/engine/solid/{areas,manifold}.ts`, `lib/engine/osm/scene.ts`,
`lib/engine/export/index.ts`, `lib/bake.ts`, `store/editor.ts`,
`components/scene/{CityPreview,PreviewPane,RegionMeshes}.tsx`. Every line
number below is from the tree as read; a further edit to those files shifts
them by a few lines. That instrumentation is what made section 3's per-stage
numbers measurable without touching a source file. Nothing in this pass
modified a source file.

---

## 1. The bake traversal, in order

`bake()` is `lib/engine/engine.ts:129`. 63 ordered operations. `WASM` means the
step calls into the live manifold3d handle (a `Manifold`/`CrossSection` method
or a `ctx.wasm` constructor); a step marked no is pure TypeScript over numbers,
contours-as-arrays or finished meshes.

| # | operation | file:line | consumes | produces | WASM |
|---|---|---|---|---|---|
| 1 | `loadManifold()` | engine.ts:135 | (none) | `wasm` toplevel | yes (loads it) |
| 2 | `loadFaces(params)` | engine.ts:136 → lettering.ts:123 | `engravings[].font`, `underside_mark` | glyph outline cache (module-global) | no (async fetch) |
| 3 | `new Arena()` | engine.ts:138 | (none) | handle arena, freed in `finally` engine.ts:543 | no |
| 4 | `samplerFromGrid(input.terrain)` | engine.ts:145 → terrain/heightfield.ts:209 | `EngineInput.terrain` | `TerrainSampler \| null` | no |
| 5 | `makeContext(...)` | engine.ts:140 → context.ts:156 | 1, 3, 4, `EngineInput.scene`, `EngineInput.params` | `ctx` (scale, radiusM, thresholds, baseTopMm, cropHalfMm, findings/resolvedText/markBands channels) | no |
| 6 | `reportUnbuiltFrameStyle(ctx)` | engine.ts:147 → frame.ts:1161 | 5 | findings | no |
| 7 | `reportRoadModeConflict(ctx)` | engine.ts:148 → roads.ts:152 | 5 | findings | no |
| 8 | `makeDrape(ctx)` | engine.ts:153 → drape.ts:133 | 4, 5 | `Drape \| null` (displacement field, closures) | no |
| 9 | `reportRelief(ctx, drape)` | engine.ts:154 → engine.ts:660 | 8 | finding `terrain-low-relief` | no |
| 10 | `T.hero_ids(params)` fallback | engine.ts:159 | `EngineInput.heroIds` or `hero_building_ids` | hero id list | no |
| 11 | `repairBuildings(ctx, heroIds)` | engine.ts:160 → repair.ts:843 | 5, 10, `scene.buildings` | `RepairedBuildings`: footprint `CrossSection`, per-building sections, merge/dilate/fallback counts | yes |
| 12 | `reportHeroes(...)` | engine.ts:161 → engine.ts:679 | 11 | 3 hero findings | no |
| 13 | `buildSurfaceRegions(ctx, footprint)` | engine.ts:172 → areas.ts:440 | 5, 11 | 4 `SurfaceRegion` (solid, cutter, section, pocket, placement) | yes |
| 13a | per-layer loop over `SURFACE_ORDER` | areas.ts:451-458 | 13 | one repaired layer each, later layers blocked by earlier ones | yes |
| 13b | `repairFlatLayer` inside each layer | areas.ts:176 | 13a | min-feature-repaired contours | yes |
| 13c | `mergeRecessRidges` | areas.ts:461 | 13a | ridges handed to the recess that can swallow them | yes |
| 13d | pass two: `extrudeSection` solid + cutter | areas.ts:467-489 | 13a-c | the `SurfaceRegion` list | yes |
| 14 | `buildBuildings(ctx, repaired, drape)` | engine.ts:174 → buildings.ts:126 | 5, 8, 11 | gradient band solids, hero solid, sockets, tints, counts | yes |
| 15 | bands + hero into `solids` map | engine.ts:175-176 | 14 | `solids` entries | no |
| 16 | `buildBridges(ctx, footprint, drape)` | engine.ts:181 → bridges.ts:228 | 5, 8, 11 | deck solids joined to `roads`/`rail` | yes |
| 16a | `repairFlatLayer` per deck | bridges.ts:260 | 16 | repaired deck contours | yes |
| 16b | `survivesMinWall` / `widenThinParts` | bridges.ts:386, :390 | 16a | thin abutments widened or dropped | yes |
| 17 | `buildTrees(ctx, blockers, drape)` | engine.ts:185 → trees.ts:80 | 5, 8, 11, 13 (every non-`parks` surface section) | one cone union, kept/dropped/blocked counts | yes |
| 18 | `textTokenContext(scene, params, date)` | engine.ts:204 → previewText.ts:418 | `place.*`, `city_label`, `hero_building_ids` | token table for `{city}` etc. | no |
| 19 | `undersideReserveMm(ctx, date, expand)` | engine.ts:211 → attribution.ts:675 | 5, 18 | mm the mandatory underside mark reserves | no |
| 20 | `buildLettering(ctx, tokens, rot, reserve)` | engine.ts:206 → lettering.ts:496 | 2, 5, 18, 19 | `frameCut`, `frameAdd`, `inlayCut`, `inlay`, `baseCut`, `layout`, resolvedText | yes |
| 20a | `widenThinParts` on glyph sections | lettering.ts:214 | 20 | strokes widened to the nozzle | yes |
| 21 | `buildOrnaments(ctx, lettering.layout)` | engine.ts:214 → ornaments.ts:75 | 5, 20 | north-arrow + scale-bar `frameCut`/`baseCut` | yes |
| 22 | `buildAttribution(ctx, date, expand)` | engine.ts:215 → attribution.ts:792 | 5, 18 | `baseCut`, `frameCut`; fills `ctx.markBands` | yes |
| 23 | `reportNarrowTextBand(ctx, hasEdgeText)` | engine.ts:216 → frame.ts:527 | 20, 21 | finding | no |
| 24 | `buildHangers(ctx)` | engine.ts:226 → hangers.ts:359 | 5 | `baseCut` pockets + printed-in-place `parts` (cleat, easel) | yes |
| 25 | `parts` into `solids` | engine.ts:227 | 24 | `solids` entries | no |
| 26 | `batchedUnion(lettering.inlay)` | engine.ts:228 | 20 | `lettering` region solid | yes |
| 27 | `buildShadowGap(ctx)` | engine.ts:236 → frame.ts:592 | 5 | plate cutter | yes |
| 28 | `buildMatting(ctx)` | engine.ts:237 → frame.ts:634 | 5 | `matting` region solid | yes |
| 29 | `buildFrameMating(ctx)` | engine.ts:238 → frame.ts:706 | 5 | `baseAdd`, `baseCut`, `frameCut` for snap/magnet mating | yes |
| 30 | `buildFrameTexture(ctx, layout)` | engine.ts:239 → frame.ts:968 | 5, 20 | frame face texture cutter | yes |
| 31 | `buildPlate(ctx)` | engine.ts:242 → base.ts:34 | 5 | raw plate | yes |
| 32 | `batchedUnion([plate, ...mating.baseAdd])` | engine.ts:243 | 29, 31 | `withRidge` | yes |
| 33 | `carveBase(ctx, withRidge, cutters)` | engine.ts:244 → base.ts:77 | 13, 14, 20, 21, 22, 24, 27, 29, 32 | `carved` plate | yes |
| 34 | `drapeSolid(ctx, drape, carved)` | engine.ts:263 → drape.ts:187 | 8, 33 | draped `base` region | yes |
| 35 | `solids.set("base", ...)` | engine.ts:264 | 34 | `solids` entry | no |
| 36 | `buildFrameLip(ctx)` | engine.ts:267 → frame.ts:440 | 5 | frame lip (profile rings) | yes |
| 37 | `batchedUnion([lip, ...lettering.frameAdd])` | engine.ts:271 | 20, 36 | `raisedFrame` (embossed text added first) | yes |
| 38 | `subtractSolids(raisedFrame, cuts)` | engine.ts:274 | 20, 21, 22, 29, 30, 37 | `frame` region | yes |
| 39 | `solids.set("frame"/"matting")` | engine.ts:284, :286 | 28, 38 | `solids` entries | no |
| 40 | second `buildPlate` for the assembly | engine.ts:324 | 5, 29 | `assemblyPlate` (draped bakes only; 31's handle was consumed by 34) | yes |
| 41 | build `additive` / `rigid` / `standing` lists | engine.ts:328-347 | 14, 16, 17, 24, 28, 37, 40 | three ordered handle lists | no |
| 42 | groove `extrudeSection` per recessed surface | engine.ts:348-368 (extrude :357) | 13 | `grooves` cutters | yes |
| 43 | `batchedUnion(additive + rigid-if-flat)` | engine.ts:369 | 41 | `raised` | yes |
| 44 | `subtractSolids(raised, grooves + text + attribution + hangers + mating + gap + texture)` | engine.ts:376 | 20, 21, 22, 24, 27, 29, 30, 42, 43 | `carvedAssembly` | yes |
| 45 | `drapeSolid(ctx, drape, carvedAssembly)` | engine.ts:403 | 8, 44 | warped assembly | yes |
| 46 | `batchedUnion(warped + rigid + standing)` | engine.ts:399 | 41, 45 | `assembly`, the welded solid | yes |
| 47 | `drapeSolid` per surface region | engine.ts:416-419 | 8, 13 | draped region solids | yes |
| 48 | `solids.set(surface.region, ...)` | engine.ts:420 | 47 | `solids` entries | no |
| 49 | `batchedUnion` bridge into its region | engine.ts:421-424 | 16, 48 | `roads`/`rail` regions | yes |
| 50 | `batchedUnion` trees into `parks` | engine.ts:425-428 | 17, 48 | `parks` region | yes |
| 51 | `finishRegions(ctx, solids)` | engine.ts:431 → engine.ts:594 | every `solids` entry | `BuiltRegion[]`: pruned solid, body counts, `RegionMesh` | yes |
| 51a | `pruneDebris` per region | engine.ts:602 | 51 | debris-free region | yes |
| 51b | one shared `translate` to sit at z=0 | engine.ts:610-616 | 51a | placed regions | yes |
| 51c | `countBodies` + `toRegionMesh` per region | engine.ts:617-627 | 51b | the `Float64Array` meshes | yes |
| 52 | `undersideSkipBands(ctx)` | engine.ts:435 → attribution.ts:733 | 22 (`ctx.markBands`) | Z bands the min-wall probe must ignore | no |
| 53 | `measureMinWall(ctx, assembly, skip)` | engine.ts:435 → measure.ts:387 | 46, 52 | measured min wall, at-Z, slice count | yes (slices) |
| 54 | `validate(ctx, built, assembly, minWall)` | engine.ts:436 → validate.ts:212 | 46, 51, 53 | gate findings | yes |
| 55 | `addFinding` loop | engine.ts:444 | 54 | `ctx.findings` | no |
| 56 | `options.onSolids?.(built)` | engine.ts:447 | 51 | test-only escape hatch, handles still alive | no |
| 57 | `pruneDebris(assembly, UNION_DEBRIS_MM3)` | engine.ts:453 | 46 | `cleanAssembly` | yes |
| 58 | `toRegionMesh(cleanAssembly)` + `countBodies` | engine.ts:457 | 57 | `EngineResult.merged` | yes |
| 59 | `islandReport(ctx, cleanAssembly, built)` | engine.ts:470 → validate.ts:132 | 51, 57 | floating-island report | yes |
| 60 | `buildTiles(ctx, sources, cleanAssembly)` | engine.ts:477 → tiling.ts:274 | 51, 57 | `TileResult[]`, each with its own regions + merged | yes |
| 61 | `tileGridSpec(params)`, `regionBounds`, `triangleCount` | engine.ts:478-481, measure.ts:522, :529 | 51, 60 | `EngineStats` inputs | no |
| 62 | `auditPrintability({...})` | engine.ts:514 → audit/rules.ts:270 | 51, 55, 58, 59, 60, 61 | the ordered finding catalogue | no |
| 63 | `resolveParamsEcho(params, resolvedText)` | engine.ts:529 → engine.ts:560 | 20, 22 | `EngineResult.params` with tokens substituted | no |

`arena.dispose()` runs in the `finally` at engine.ts:543, so every WASM handle
above dies when `bake()` returns. Nothing survives a bake today.

### Grouped into the brief's stage list

| brief stage | steps | notes |
|---|---|---|
| normalise | (none) | **Not in `bake()` at all.** It is the other job kind: `runIngestJob` → `osm/scene.ts:buildScene` → `normalize.ts`, on a separate worker (`client.ts:209-211`). `bake()` receives a finished `SceneGraph`. |
| crop | inside 5, 11, 13 | Not a step. `ctx.cropHalfMm` (context.ts:164) and `ctx.recessClipHalfMm` (context.ts:183) are numbers every builder clips against itself (`cropSection` in areas.ts, bridges.ts). |
| minimum-feature repair | 11, 13b, 16a, 16b, 20a, and again at 53/60 | **Not a stage.** `repairBuildings` (11) covers buildings only. Each surface layer repairs itself inside `buildSurfaceRegions` (areas.ts:176); bridges repair inside `buildBridges` (bridges.ts:260, :386, :390); glyphs widen inside `buildLettering` (lettering.ts:214); `residueParts` runs again during measurement (measure.ts:196) and tiling (tiling.ts:1171). |
| terrain | 4, 8, 34, 45, 47 | **Applied at three separate points**, never once: the carved base (34), the welded assembly (45), and each surface region on its own (47). Buildings, decks, trees and printed-in-place mount parts are never warped; they are rigidly lifted (`drapeLiftMm`, drape.ts) and unioned in *after* the warp (engine.ts:399). |
| base | 31, 32, 33, 34, 40 | The plate is built **twice** on a draped bake: 31 is consumed by the drape at 34, so the assembly gets its own at 40. |
| frame | 27, 28, 29, 30, 36, 37, 38 | **Split in two by the whole base stage.** Shadow gap, matting, mating and texture (27-30) exist before the plate is carved because they are cutters into it; the lip itself (36-38) is built after the base is carved *and* draped. |
| buildings | 11, 14, 15 | Repair (11) runs before the surface layers, the extrusion (14) after them. |
| hero handling | 10, 11 (inside), 12, 14 | The hero split happens inside `repairBuildings` (repair.ts:865 reads `hero_mode`); `colourTwin` (engine.ts:646) decides at mesh time whether it gets its own colour. |
| roads / water / green / rail | 13 as one call | One builder, four layers, in `SURFACE_ORDER` precedence, each blocking the next (areas.ts:451-458). Individually timed as `solid.water`/`solid.rail`/`solid.roads`/`solid.parks`. |
| trees | 17, 50 | Joins the existing `parks` region rather than making one. |
| lettering | 2, 20, 26, and consumed at 33, 37, 38, 44 | Cutters built once, consumed four times. The emboss union (37) happens **before** the engrave subtraction (38) on the same lip. |
| ornaments | 21, consumed at 33, 38, 44 | Same shape as lettering. |
| hangers | 24, 25, consumed at 33, 44, and re-added at 41 | The pocket is a cutter; the printed-in-place part is added back to `standing` *after* the subtraction (engine.ts:347). |
| attribution | 19, 22, consumed at 33, 38, 44; bands read at 52, 60 | **Cut before and after the frame**, exactly as the brief suspected: `attribution.baseCut` goes into `carveBase` (33), `attribution.frameCut` into the frame lip subtraction (38), and **both** again into the assembly subtraction (44). `ctx.markBands` is a channel filled at 22 and read by the min-wall probe (52) and the tile sliver search (tiling.ts:59). |
| tiling | 60, 61 | Runs on the cleaned assembly, after everything. |
| assembly (weld/merge) | 40-46, 49, 50, 57, 58 | The welded solid is **not** a union of the finished regions (engine.ts:288-309 explains why); it is rebuilt from its own primitives. |
| audit | 52-55, 59, 62 | Split: `validate` (54) runs on the *un*-pruned assembly, `islandReport` (59) and `auditPrintability` (62) on the pruned one. |
| export | (none) | Outside `bake()` entirely, and on the **main thread** (section 6). |

### Interleavings that matter most for a stage graph

1. **Surfaces are built before buildings are extruded** (13 before 14) but after
   buildings are repaired (11). Any stage graph has to split "buildings" into a
   2D repair node and a 3D extrude node with the surface layers between them.
2. **Repair is not separable.** Five builders own their own repair pass. A
   `repair` stage does not exist to memoize.
3. **Cutter sets are built once and consumed at three or four later points**
   (lettering, ornaments, attribution, hangers, mating). Memoizing a "lettering"
   stage means memoizing a *set of live WASM handles*, which the arena frees at
   engine.ts:543.
4. **The drape is applied three times to three different solids.** A terrain
   change invalidates the base, the assembly and every surface region, but not
   buildings/trees/bridges, which are only rigidly lifted.
5. **`ctx` is a mutable channel.** `findings`, `resolvedText` and `markBands`
   are appended to by stages scattered across the whole traversal
   (context.ts:135-153). A memoized stage that does not re-run also does not
   re-append its findings.
6. **The plate is built twice, and `carved` is destroyed by the drape**
   (engine.ts:322 comment).

---

## 2. PrintParams field claims

`packages/contracts/schema/print_params.json`, fully expanded: **134 leaf
fields**. **13 are ENGINE-INERT** (no step in section 1 reads them, directly or
through a `lib/transform.ts` accessor or `lib/printers.ts:resolveProfile`).

Paths below are relative to `apps/web/`.

### The 13 ENGINE-INERT fields

| field | read instead by | why it is inert |
|---|---|---|
| `schema_version` | lib/share.ts:470, :647 | permalink version gate only |
| `part_colors.base` | components/scene/palette.ts:184, CityPreview.tsx:277 | v1 legacy colour block; the engine reads `colour.region_colors` |
| `part_colors.frame` | palette.ts:185 | same |
| `part_colors.buildings` | palette.ts:186 | same |
| `part_colors.roads` | palette.ts:187 | same |
| `part_colors.water` | palette.ts:188 | same |
| `part_colors.green` | palette.ts:189 | same |
| `part_colors.trees` | palette.ts:190 | same |
| `colour.palette` | components/editor/groups/ColourGroup.tsx:148, :151, :180; lib/share.ts:290 | a UI preset that *writes* `region_colors`; never read downstream |
| `colour.preview_theme` | components/scene/CityPreview.tsx:288, :750; lib/share.ts:311 | preview only |
| `export_target` | store/editor.ts:1052; components/editor/ExportMenu.tsx:31; lib/warnings.ts:307 | **verified**: the only reads inside `lib/engine/**` are the type alias at export/index.ts:17 and the sidecar echo of the *passed-in* argument at export/common.ts:429. `exportForTarget` takes `target` as a parameter (export/index.ts:69). |
| `hero_auto.enabled` | store/editor.ts:456; lib/heroes.ts:233; CityPreview.tsx:526 | resolved outside the engine into `EngineInput.heroIds` at store/editor.ts:479 |
| `hero_auto.count` | store/editor.ts:458; lib/heroes.ts:235 | same |

None is "read nowhere". Each has a real non-engine reader.

### The 121 engine-read fields, by consuming step

| field(s) | accessor / resolver | steps (section 1) | representative file:line |
|---|---|---|---|
| `plate_mm` | `T.scale_mm_per_m`:155, `T.plate_extents_mm`:375, `T.content_extents_mm`:385, `T.frame_geometry_mm`:391, `T.edge_usable_mm`:1564, `T.underside_mark_available_mm`:1809 | 5, 13, 19, 20, 24, 36, 62 | context.ts:159-165; hangers.ts:130; frame.ts:649; audit/rules.ts:322 |
| `base_thickness_mm` | `T.base_top_mm`:370 → `ctx.baseTopMm`; `T.deepest_recess_mm` | 5, 21, 22, 24, 31 | context.ts:180; attribution.ts:712; hangers.ts:100; ornaments.ts:164 |
| `nozzle_mm` | `T.min_wall_mm`:198, `min_gap_mm`:203, `min_detail_mm`:208, `thresholds_ground_m`:212, `text_stroke_target_mm`:1246 | 5, 11, 13b, 16b, 20a, 22, 53, 54, 62 | context.ts:175-179; measure.ts:417; validate.ts:369; lettering.ts:706 |
| `small_scale`, `large_scale` | `T.building_height_scale`:412 → `building_top_mm_exaggerated` | 11, 14, 54 | buildings.ts:96, :105; repair.ts:1029; validate.ts:301 |
| `terrain_exaggeration` | `T.terrain_z_scale`:237, `terrain_z_mm`:251 | 8, 34, 45, 47, 53, 54 | drape.ts:137, :163; measure.ts:398; validate.ts:335 |
| `terrain.enabled`, `terrain.smoothing` | `terrainEnabled`, `smoothingPasses` | 4 (grid built before the bake, store/editor.ts) | terrain/heightfield.ts:185, :190; terrain/tiles.ts:188, :294 |
| `road_mode` | `T.road_z_mm`:648 | 13, 16 | roads.ts:127, :153; bridges.ts:452 |
| `road_scale` | `T.road_width_ground_m`:640 | 11, 16 | bridges.ts:456; repair.ts:816 |
| `water` | `T.water_z_mm`:663 | 13 | areas.ts:99 |
| `trees` | (none) | 17, 62 | trees.ts:87; audit/rules.ts:226 |
| `frame` | `T.usable_span_mm`:155, `frame_geometry_mm`:394, `frame_text_available`:1538, `frame_content_inset_mm`:1002 | 5, 13, 20, 27-30, 36-38 | context.ts:165, :183; frame.ts:203; areas.ts:291; lettering.ts:105 |
| `city_label`, `place.country`, `place.state`, `place.neighbourhood`, `place.author` | `textTokenContext` (previewText.ts:418-422) | 18, 20, 22, and the export provenance | engine.ts:204; lettering.ts:572; attribution.ts:116; export/common.ts:38, :71 |
| `color_mode` | `T.color_mode`:549, `parts_mode`:554 | export writers only (outside `bake()`) | export/common.ts:210; export/generic3mf.ts:182 |
| `engravings[].{edge,align,text,mode,size_mm,depth_mm,font}` (7) | `T.lettering_layout`:1852 | 2, 20, 63 | lettering.ts:105, :285, :527, :572-594; engine.ts:541 |
| `north_arrow.{enabled,corner,size_mm}` (3) | `T.north_arrow_layout`:1946 | 21, 30 | ornaments.ts:121-124; frame.ts:881-883 |
| `scale_bar.{enabled,edge,length_mode,length_m}` (4) | `T.scale_bar_layout`:1975 | 20, 21, 30 | ornaments.ts:131-133; lettering.ts:109; frame.ts:886-888 |
| `underside_mark.{enabled,template}` (2) | `T.underside_mark_layout`:2049, `underside_pockets`:1789 | 2, 19, 22, 63 | attribution.ts:114-116; engine.ts:548, :551 |
| `hanger` | `T.underside_pockets`:1790, `underside_band_mm`:1800, `underside_pocket_depth_mm` | 19, 21, 24, 54 | hangers.ts:361; validate.ts:104; ornaments.ts:160; attribution.ts:617, :734 |
| `hanger_magnet.{diameter_mm,thickness_mm,count}` (3) | (none) | 29, 36 | frame.ts:683, :750, :751 |
| `hero_building_ids[]`, `hero_mode` (2) | `T.hero_ids`:440, `hero_own_color`:457, `hero_true_height`:452 | 10, 11, 51c | engine.ts:158, :617; repair.ts:865 |
| `regions.{roads,water,parks,rail}.{depth_mm,proud_mm}` (8), `regions.rail.width_m`, `regions.building_skirt_mm` (10) | `placementOf` (context.ts:344) | 13, 14, 16, 42, 53, 60 | areas.ts:84-92; roads.ts:111; buildings.ts:78; measure.ts:283-284; tiling.ts:933 |
| `colour.region_slots.*` (11), `colour.region_colors.*` (11) | `regionSlot` (context.ts:229), `regionColor` (context.ts:243) | 51c, 58, 60 | context.ts:236-255; engine.ts:599-600; buildings.ts:169 |
| `colour.gradient.enabled`, `colour.gradient.slots[]` (2) | `regionSlot`/`regionColor` | 14, 51c | context.ts:231-232, :249-253; buildings.ts:210-211 |
| `colour.tint.{enabled,hue_range_deg,lightness_range,seed}` (4) | `tintedColor` (lib/tint.ts:124) | 14 (tints echoed on the result; never geometry) | solid/tint.ts:25, :41; lib/tint.ts:126-129 |
| `printer_profile`, `custom_profile.{plate_x_mm,plate_y_mm,max_height_mm,nozzle_mm,slots,change_gcode}` (7) | `resolveProfile` (lib/printers.ts:255) | 54, 62, and export | validate.ts:81; audit/rules.ts:271, :507; export/bambu3mf.ts:382-390 |
| `heights.floor_height_m`, `heights.unknown_default_m`, `heights.type_defaults.*` (8) | `heightRulesFrom` | **ingest job, not `bake()`** | osm/heights.ts:227-240; osm/scene.ts:21 |
| `bridges.{enabled,clearance_mm,abutments}` (3) | (none) | 13, 16, 62 | bridges.ts:82-92; roads.ts:128; audit/rules.ts:229 |
| `height_exaggeration.{multiplier,curve}` (2) | `T.height_exaggeration_multiplier`:331, `_curve`:336 | 11, 14 | buildings.ts:96, :105 |
| `tiling.{enabled,cols,rows,joint,tolerance_mm,index_mark}` (6) | `tileGridSpec` (tiling.ts:190) | 20, 60, 61, 62 | tiling.ts:192-201; lettering.ts:116; audit/rules.ts:355 |
| `frame_style.*` (16, fully nested) | `frameStyle` (frame.ts:164), `T.frame_content_inset_mm`:1002 | 5, 6, 27-30, 36-38, 62 | frame.ts:166-196, :974-982, :1166-1170; context.ts:165; audit/rules.ts:409 |

Two indirections a dependency declaration must model:

- **`makeContext` collapses 8 params into 8 `ctx.*` names** (context.ts:156-188)
  and every downstream builder reads `ctx.*`, not `params.*`. A change to
  `plate_mm` or `frame` moves `ctx.scale`, `ctx.plateHalfMm`, `ctx.cropHalfMm`
  and `ctx.recessClipHalfMm` at once, which is a fan-out to nearly every stage.
- **`heights.*` never reaches `bake()`.** It is consumed by the *ingest* job
  (osm/heights.ts). Changing it must re-run ingest, not just the bake, which
  today it does not (`store/editor.ts:674` schedules a bake, never an ingest).

---

## 3. Timings

The perf module the parallel agent added made this measurable without editing
source: `setPerfEnabled(true)` (lib/perf.ts:236) plus `perfDrainTimings()`
(lib/perf.ts:379), driven from a scratch script outside the repo.

**CLI wall time**, `npm run bake:cli -- --scene fixtures/chicago-scene.json
--params fixtures/print-params-default.json --target generic-3mf`: **9.00 s
process wall, 7.76 s reported total, 7.29 s engine**. 6 regions, 135 130
triangles, 180.0 x 180.0 x 34.7 mm.

**Per-stage, one bake of the Chicago fixture at default params** (Node 26,
vite-node, warm WASM). Total 7 495 ms.

| stage | ms | calls | % |
|---|---|---|---|
| `solid.merged` (57, 58) | 3 411 | 2 | 45.5 |
| `solid.meshes` (51) | 1 702 | 1 | 22.7 |
| `solid.surfaces` (13) | 847 | 1 | 11.3 |
| ↳ `solid.roads` | 652 | 1 | 8.7 |
| ↳ `solid.parks` | 46 | 1 | 0.6 |
| ↳ `solid.water` | 4.5 | 1 | 0.1 |
| ↳ `solid.rail` | 0.1 | 1 | 0.0 |
| `solid.weld` (43, 44, 46) | 593 | 3 | 7.9 |
| `solid.measure` (53) | 585 | 1 | 7.8 |
| `solid.repair` (11) | 109 | 1 | 1.5 |
| `solid.attribution` (22) | 106 | 1 | 1.4 |
| `solid.audit` (62) | 37 | 1 | 0.5 |
| `solid.buildings` (14) | 21 | 1 | 0.3 |
| `solid.fonts` (2) | 15 | 1 | 0.2 |
| `solid.base` (31, 33) | 5.6 | 2 | 0.1 |
| `wasm.instantiate` | 5.1 | 1 | 0.1 |
| `solid.lettering` (20) | 1.4 | 1 | 0.0 |
| `solid.trees` (17) | 0.7 | 1 | 0.0 |
| `solid.frame` (27-30, 36, 38) | 0.6 | 6 | 0.0 |
| `solid.validate` (54) | 0.6 | 1 | 0.0 |
| `solid.bridges`, `solid.ornaments`, `solid.tiling`, `solid.hangers`, `solid.drape` | < 0.5 each | 1 each | 0.0 |

`stats.elapsedMs` reported 7 457 ms for the same run.

**The design consequence.** 68 % of a Chicago bake is steps 51, 57 and 58, all
of which run **after every geometry stage has finished** and none of which
depends on any single parameter. Memoizing every geometry stage perfectly and
re-running only the mesh extraction still costs about 5.1 s. An incremental
pipeline that does not also make `finishRegions` and the merged-solid
extraction incremental (per-region, so an untouched region keeps its mesh)
buys at most ~30 %.

**Not measurable without editing code**: the split of `solid.merged` between
`pruneDebris` and `toRegionMesh` (one span name covers both, engine.ts:453 and
:457), the split of `solid.meshes` between per-region prune, translate and
mesh conversion (one span, engine.ts:431), and anything inside `repair.ts`,
`measure.ts` or `tiling.ts` finer than their top-level span. Existing tests
assert only coarse ceilings: `TIME_BUDGET_MS = 15_000`
(solid/engine.test.ts:37, asserted :310), `TERRAIN_TIME_BUDGET_MS = 15_000`
(:47, asserted :500), `TILED_TIME_BUDGET_MS = 25_000` (solid/tiling.test.ts:32,
asserted :388), and 1 500 ms on ingest (osm/normalize.test.ts:32). There is no
`E2E_BUDGET_FACTOR` anywhere in the repo despite `docs/ARCHITECTURE.md:263`.

---

## 4. Worker boundary

**Message types** (`lib/engine/protocol.ts`). Requests: `IngestJobMessage`
(:38), `BakeJobMessage` (:45, fields `kind`, `id`, `input`, optional `perf`
:46), `CancelMessage` (:51, with `jobKind`). Responses:
`ingest-progress`, `ingest-done` (ok and failed variants), `bake-progress`,
`bake-done` (:86, carries the whole `EngineResult`), `bake-error`; each
optionally carries `timings: PerfTiming[]` (:56) in perf mode.

**Transferred vs cloned.** The only `postMessage` transfer list in the engine
is protocol.ts:269-272: it pushes `region.positions.buffer` and
`region.indices.buffer` for each entry of `result.regions`, and nothing else.
Measured on Chicago:

| payload | bytes | crosses as |
|---|---|---|
| `regions[].positions` (6 regions, 202 947 doubles) | 1 623 576 | **transferred** |
| `regions[].indices` (405 390 uint32) | 1 621 560 | **transferred** |
| `merged.positions` + `merged.indices` (93 762 triangles) | 2 250 336 | **structured-cloned** |
| stats, findings, resolvedText, params echo, attributionBands | 5 441 | structured-cloned |
| **total** | **5 500 913** | 59 % transferred, 41 % copied |

Per-region positions: base 649 488 B, frame 212 352 B, buildings 243 960 B,
roads 397 056 B, water 23 424 B, parks 97 296 B.

`EngineResult.merged` is the single largest buffer in the payload and it is
copied on every bake. So is every `TileResult`'s own regions and merged mesh
when tiling is on (engine.ts:499), which multiplies that by the tile count.

**Transfer detaches the worker's copy.** Because the region buffers are
transferred, the worker no longer owns them after posting. Any future
per-stage cache that wants to reuse a `RegionMesh` across bakes has to either
copy before posting or stop transferring.

**Is the SceneGraph re-sent every bake?** Yes. `EngineInput.scene:
SceneGraph` (types.ts:303), `BakeWireInput = EngineInput` (protocol.ts:36),
and the client posts the whole input with no transfer list
(client.ts:250: `postMessage({kind:"bake", id, input, perf: perfEnabled()})`).
The store passes `scene.graph` by reference on every debounced job
(store/editor.ts:474-481). The Chicago scene JSON is **1 204 057 bytes**, so
roughly 1.2 MB is structured-cloned into the worker on every slider settle,
for a scene that has not changed.

**Cancellation.** `cancelJob` (protocol.ts:186 region) does two different
things. For `jobKind: "ingest"` it aborts the `AbortController` in
`ingestControllers` and the Overpass fetch stops. For `jobKind: "bake"` it can
only drop a bake still sitting in `queuedBake`; a bake already running cannot
be preempted, because `bake()` runs synchronous manifold3d calls with no yield
points once WASM is loaded (protocol.ts:201-227 docstring, client.ts:32-36).
What actually protects the caller is client-side supersede
(`supersedeBake`, client.ts:283-298): it deletes the pending promise, rejects
it with `EngineClientError("cancelled", ...)`, and the late `bake-done` is
dropped by id on arrival (client.ts:307-315). **A running bake cannot be
interrupted between steps today.** Making stages interruptible is new work,
not a refactor of an existing hook.

**Single-flight rule.** `runBakeJob` (protocol.ts:228 region): if
`bakeRunning`, the message **overwrites** `queuedBake` rather than queueing
behind it, so a burst of N requests costs at most one more full bake after the
one under way. On completion the `finally` picks up whatever landed in the
single slot and recurses.

---

## 5. Preview consumption

**Drawn from `EngineResult` solids.** One `BufferGeometry` per `RegionMesh`,
`components/scene/RegionMeshes.tsx:33-40`, mounted `CityPreview.tsx:642`; tile
cut lines and index labels, `TileGrid.tsx:33-68`, mounted `CityPreview.tsx:643-645`;
per-building tints when `buildingTints` is non-empty, `CityPreview.tsx:552-555`.

**Approximated on the main thread** from SceneGraph + PrintParams: base slab
and four square frame bars (`BasePlate.tsx:31-58`); buildings as oriented boxes
in one InstancedMesh (`lib/preview.ts:228-276`, `InstancedBuildings.tsx:191-217`);
water and green fills (`lib/preview.ts:443-462` → `AreaSurfaces.tsx:100-137`);
road ribbons, flat and never cut (`lib/preview.ts:364-424` → `RoadRibbons.tsx:27-77`);
trees as 8-gon cones (`lib/preview.ts:480-520` → `TreeInstances.tsx:17-56`);
lettering, north arrow, scale bar, underside mark and hanger pockets as flat
fills (`lib/previewText.ts:483-612`, mounted `CityPreview.tsx:707-717`).

**The swap rule.** `lib/enginePreview.ts:26`: return the result only when
`engine.status === "ready"` **and** `engine.stale === false`; otherwise `null`.
Called once, `CityPreview.tsx:517`. Fresh: region meshes and tile grid mount,
every approximate layer is skipped (`:647`, `:650`, `:657`, `:664`, `:694`,
`:707`). Null: the whole approximate stack mounts and the region meshes
unmount. `InstancedBuildings` is mounted unconditionally (`:678`) with
`hidden={Boolean(freshEngineResult)}` (`:691`), which only sets opacity 0 and
drops shadows (`InstancedBuildings.tsx:196-197`) because raycasting ignores
opacity and the fused region mesh carries no per-building identity, so hero
picking needs it alive (`InstancedBuildings.tsx:92-105`).

**During a rebuild.** Because `stale` alone makes `freshEngineResult` null, the
**previous result is not drawn at all** while a newer job computes. The
approximation replaces it. `docs/ARCHITECTURE.md:243` says the instanced
preview stays up, which is correct, but it is worth stating that the
*engine geometry vanishes* rather than persisting. The badge is
`CityPreview.tsx:767-775`, `data-testid="engine-updating"`, text
`Updating model...`, gated on `engineStatus === "computing"` alone (`:767`).
`store/editor.ts:675` marks stale immediately while `scheduleEngineJob` waits
400 ms (`store/editor.ts:413`, `:442-445`) before status becomes `"computing"`
(`:471`), so for ~400 ms the preview is already degraded **with no badge**.

**Which params the approximate layers ignore.** This is the mechanism behind
"lettering and frame profile do nothing".

| param | approximate path |
|---|---|
| `frame` (bool) | rendered, `BasePlate.tsx:38-57` |
| `frame_style.profile` | **ignored**; `frame_style` appears nowhere under `components/scene/**`, `lib/preview.ts` or `lib/previewText.ts` (verified by grep). `T.frame_geometry_mm` uses constants only (`lib/transform.ts:390-401`, `FRAME_WIDTH_MM = 6.0` :31, `FRAME_LIP_MM = 2.0` :33) |
| `frame_style.corner`, `corner_radius_mm` | **ignored**; four square `boxGeometry` bars, `BasePlate.tsx:40-55` |
| `frame_style.lip_depth_mm` | **ignored**; lip height is the constant, `BasePlate.tsx:27` |
| `frame_style.shadow_gap`, `matting`, `separate`, `texture` | **ignored**; `T.frame_content_inset_mm` exists (`lib/transform.ts:1001-1010`) but no preview layer calls it |
| `engravings[]` | rendered as flat fills, `previewText.ts:523-533` → `CityPreview.tsx:707-717`. `depth_mm` not rendered (fill sits at lip top + 0.01 mm, `previewText.ts:641-645`); `mode` only picks a colour token (`CityPreview.tsx:219-223`) |
| `underside_mark`, `north_arrow`, `scale_bar` | rendered, `previewText.ts:573-576`, `:535-545`, `:547-571` |
| `hanger` | keyhole and magnets rendered (`previewText.ts:579-593`); `cleat` and `easel` render nothing |
| `hanger_magnet` | **ignored**; preview uses the constant `MAGNET_D_MM = 6.1` (`previewText.ts:386`, `transform.ts:935`) |
| `tiling`, `terrain`, `bridges`, `colour.gradient` | **ignored** entirely by the approximate path |
| `colour.tint` | rendered, `CityPreview.tsx:550-559` → `InstancedBuildings.tsx:153-158` |

**The `previewDeps` memo keys** (`CityPreview.tsx:111-204`): `scale`
`[graph, plate_mm, frame]`; `thresholds` `[scale, nozzle_mm]`; `layout`
`[graph, plate_mm, frame, nozzle_mm]`; `roads` adds `road_scale, road_mode`;
`water` adds `water`; `trees` adds `trees`; `height` is `predictedTopDeps`;
`text` is `[graph, textParamsKey(params), rotationDeg, date, faceVersion]`
where `textParamsKey` (`previewText.ts:439-454`) covers only `plate_mm, frame,
nozzle_mm, city_label, place, hero_building_ids, hero_auto, engravings,
north_arrow, scale_bar, underside_mark, hanger`. **No memo names
`frame_style`, `terrain`, `bridges`, `tiling`, `regions`, `colour` or
`height_exaggeration`.** This is pinned deliberately:
`components/scene/CityPreview.test.ts:299-320` asserts that all ten of those
groups "rebuild nothing", with the reasoning at `:255-298` that the engine is
the thing that will read them.

**The exact mechanism of the complaint.**

1. Touching `frame_style.*` calls `setParam`, which calls `markEngineStale`
   (`store/editor.ts:675`). `freshEngineResult` immediately becomes null
   (`enginePreview.ts:26`), so `RegionMeshes` (the only component that ever
   drew a profile, corner, matting, shadow gap or texture) **unmounts** and
   `BasePlate`'s four constant boxes take over. The control therefore *removes*
   the styled frame instead of changing it, then, ~7.5 s later, restores a
   frame whose difference from the old one is a few tenths of a millimetre of
   profile. The net visual impression over the whole interaction is "nothing
   happened".
2. For lettering the swap runs the other way. The flat fills are painted in
   dedicated `textEngraved`/`textEmbossed` tokens (`CityPreview.tsx:219-223`,
   `palette.ts:69-71`), so text is clearly visible **while stale**. When the
   fresh result lands, the engine's engraving is a boolean cut into the
   **frame** region (`engine.ts:274`) drawn in that region's single
   `colorHex` (`RegionMeshes.tsx:83`), with no contrast, at a camera distance
   of `plate_mm * 1.15` (`CityPreview.tsx:1020`). The letters visibly appear
   during the wait and visually vanish on success. Only an inlay gets its own
   `lettering` region and colour (`engine.ts:228`).
3. Two further ways text draws nothing at all: glyph outlines are fetched
   lazily, so the first build for a face returns no pieces and only records
   `missingFaces` (`previewText.ts:505-508`), needing the `faceVersion` bump at
   `CityPreview.tsx:367-389`; and edge engravings are gated on
   `frame_text_available` (`previewText.ts:523`), so with the frame off nothing
   is drawn.

**Preview text vs engine lettering.** They **share the layout function**:
`previewText.ts:489` and `solid/lettering.ts:363`, `:507` all call
`T.lettering_layout` (`lib/transform.ts:1833`). Sizes, anchors, rotations,
auto-fit and refusals are therefore identical. Below that they diverge:
`previewText.ts` makes flat `PreviewArea` fills with a mitre-limited pseudo-offset
(`:117-165`) and an analytic keyhole (`:352-381`), no booleans; the engine cuts
real solids. Preview text appears **before** any engine result (built from
params alone, `CityPreview.tsx:391-400`) and disappears when the result becomes
fresh.

---

## 6. Store and export path

**Param change → engine job.** `ENGINE_DEBOUNCE_MS = 400`
(`store/editor.ts:412`), one module-scope timer (`:413`) cleared and re-armed by
`scheduleEngineJob` (`:439-445`). `EngineJobState` has four fields
(`store/editor.ts:138-144`): `status: "idle"|"computing"|"ready"|"error"`
(`:136`), `result`, `error`, `stale`. `markEngineStale` (`:154-157`) flips
`stale` only when status is `ready`, returning the same object otherwise so no
re-render happens; it is cleared only on success (`:482`). Status goes
`computing` at `:470` (error cleared, previous result kept), `ready` at `:482`,
`error` at `:486-488`; a `"cancelled"` rejection returns early at `:485` and
leaves status at `computing` for the superseding job to own.

Setters that schedule a job: `setParam` `:674`, `resetParams` `:703`,
`setPrinterProfile` `:717`, `applyFinding` `:728`, `applySafeFindingFixes`
`:741`, `applyGeocodeResult` `:775`, `setPlaceName` `:785`,
`resetPlaceNameToDetected` `:795`, `applyHistorySnapshot` `:862`, `generate`
`:997`, `runTerrainJob` `:531` and `:561`. Setters that do **not**: `setPin`
`:586`, `setRadius` `:611`, `setRotation` `:621`, `applyPreset` `:632`,
`applyShared` `:902`: these wait for `generate()`.

**The SceneGraph is re-sent whole on every bake** (`store/editor.ts:474-481`),
structured-cloned, ~1.2 MB for Chicago. There is no scene handle.

**`requestBake()` reuse rule**, `store/editor.ts:1036`: re-run only if
`fresh.status !== "ready" || fresh.stale || result === null`. In words: reuse
the cached result only when the job finished successfully, nothing has
invalidated it, and a result object exists. Otherwise call `runEngineJob`
synchronously, bypassing the 400 ms debounce (`:467`). A pre-flight
`bakeBlockReason` (`:1027`, `lib/warnings.ts:367-374`) can refuse before any
work.

**"Stale" for a completed export** is a different flag: `BakeState.stale`
(`lib/bake.ts:44-51`), set by `markBakeStale`, which only affects a terminal
phase (`:91-94`, `isTerminal` `:222-224`). Effect: `bakeDownloadLinks` returns
`[]` (`:203-206`), the label becomes `"Done (outdated)"` (`:216`), and
`BAKE_STALE_NOTE` shows (`:66-67`, rendered `components/editor/OutputPanel.tsx:422`).
The files are kept but not offered.

**`runExport`** (`lib/bake.ts:129-166`): `perfSpan("export.run")` →
`exportForTarget(result, target, {...})` (`:138-144`) → `buildSidecarJson` and
`TextEncoder().encode` (`:145-160`) → size mark (`:163`). Blob creation is in
`bakeDone` (`:174-200`), one `URL.createObjectURL` per file (`:180`) and for
the sidecar (`:186`), after revoking the previous URLs (`:175`).

**Export target selection.** `exportForTarget` takes `target` as an argument
(`lib/engine/export/index.ts:69-75`) and dispatches on it (`:108-136`), with a
tiled short-circuit first (`:79-107`). Verified: nothing under `lib/engine/**`
reads `params.export_target` at runtime; the only hits are the type alias
(`index.ts:17`), a doc comment (`common.ts:363`) and the sidecar echo of the
passed-in value (`common.ts:429`). The single runtime read is
`store/editor.ts:1052`.

**Errors.** A non-cancelled bake rejection sets `engine.status = "error"` and
`engine.error` (`store/editor.ts:486-488`), keeping the result;
`components/editor/StatsCard.tsx:35-47` shows a danger card. A `"cancelled"`
`EngineClientError` is swallowed and returns `null` with no store write
(`:485`, `:1011`), leaving status at `computing`; if `requestBake` triggered it
the `null` becomes a bake failure carrying the *previous* `engine.error`
(`:1040-1043`). An export throw is caught at `:1064-1066` and becomes
`bakeFailedLocally`.

**Main-thread geometry work.** manifold WASM never loads on the main thread in
a browser: `createDefaultTransport` builds real Workers when `Worker` exists
(`lib/engine/client.ts:165-181`), two of them (`:209-211`), and no file under
`components/**`, `store/**` or `lib/*.ts` imports `lib/engine/solid/manifold`
(`lib/colourMap.ts:16` imports `solid/context`, whose manifold import is
`import type` only, `context.ts:22`). The `InlineTransport` fallback
(`client.ts:167-169`, `:177-179`) is the only in-page path, used in SSR,
`next build` prerender and vitest.

Main-thread work that *does* touch mesh data, in rough cost order:

- `RegionMeshes.buildGeometry` (`components/scene/RegionMeshes.tsx:33-40`):
  `Float64Array` → `Float32Array` copy of every region's positions (`:35`),
  index attribute (`:36`), `computeVertexNormals()` and
  `computeBoundingSphere()` (`:37-38`), per region, in a `useMemo` wrapped in
  `perfSpan("preview.geometry")` (`:45-54`). On Chicago that is 1.62 MB of
  doubles copied to floats plus normals for 135 130 triangles, every time a
  fresh result lands.
- Every export writer, full triangle serialization during `requestBake`:
  `export/common.ts:131`, `:179-182`, `mergeRegions` `:219-228`,
  `export/stl.ts:32-46`.
- The v1 instanced preview builders: `convexHull` (`lib/preview.ts:111-127`),
  `minAreaRect` rotating callipers (`:147-183`), `buildRoads` ribbon
  tessellation (`:364-407`).
- Instance matrix writes into live GPU buffers
  (`InstancedBuildings.tsx:120-128`, `TreeInstances.tsx:40`).
- Earcut triangulation for water and green fills
  (`AreaSurfaces.tsx:60-84`) with a manual normal loop (`:86-98`).
- Glyph work: ~280 KB of faces fetched (`CityPreview.tsx:369-389`),
  `buildPreviewText` (`previewText.ts:483`), ring offsetting (`:117-165`).
- Cheap read-only passes over region metadata: `colourRows`
  (`lib/colourMap.ts:35-44`), `estimate` (`lib/engine/estimate.ts:135`),
  `buildingTintMap` (`lib/tint.ts:136-144`).

**History.** `initHistory` subscribes at `store/history.ts:248` and skips when
`location` and `params` are reference-identical (`:249`). Only
`{location, params}` are snapshotted (`:232-234`).
`HISTORY_COALESCE_MS = 800` (`:49`) applied in `record` (`:92-94`);
`HISTORY_CAP = 100` (`:48`). **Undo does trigger a new engine job**:
`applySnapshot` (`:279`) calls `applyHistorySnapshot`, which calls
`scheduleEngineJob` unconditionally (`store/editor.ts:862`). It never re-runs
Overpass.

---

## 7. Tessellation and resolution knobs

There is **no global manifold quality setting**: `setCircularSegments`,
`setMinCircularAngle` and `setMinCircularEdgeLength` appear nowhere in the
repo. Every segment count is passed explicitly per call, and every knob below
is a module-level `export const` with no plumbing through `BakeOptions`. A
preview budget needs new plumbing.

**Cheapenable** (pure triangle or vertex count; lowering them does not change a
printability verdict):

| knob | value | file:line | controls |
|---|---|---|---|
| `TERRAIN_CELL_MM` | 3.0 | solid/drape.ts:54 | edge length `refineToLength` splits to before warping (drape.ts:195); the single biggest drape cost |
| `DRAPE_EDGE_MM` | 12.0 | solid/drape.ts:74 | floor of the drape taper band (drape.ts:87) |
| `TREE_SIDES` | 8 | lib/transform.ts:61 | cone sides per tree (trees.ts:194-198) |
| `TREE_CAP` | 2000 | lib/transform.ts:55 | max trees kept (trees.ts:89) |
| `CIRCLE_SEGMENTS` | 16 | solid/context.ts:95 | frame corner arcs (frame.ts:237), magnet holes (frame.ts:797), cleat screws (hangers.ts:207), repair circle stamps (repair.ts:764) |
| `DOT_SEGMENTS` | 12 | solid/frame.ts:102 | dot-texture circles (frame.ts:1037) |
| `PROFILE_SLABS` | 8 | solid/frame.ts:70 | slabs approximating bullnose/ogee/chamfer/bevel (frame.ts:368-401) |
| `HANGER_SLABS` | 8 | solid/hangers.ts:45 | keyhole roof / easel well steps (hangers.ts:155, :317) |
| `PIN_SEGMENTS` | 24 | solid/tiling.ts:80 | alignment-pin cylinder sides (tiling.ts:750) |
| `GLYPH_JOIN_SEGMENTS` | 16 | solid/lettering.ts:56 | arc segments on glyph offsets (lettering.ts:193-232) |
| `OPENING_SEGMENTS` | 64 | solid/measure.ts:48 | arcs on the min-wall erosion probes (measure.ts:138, :232, :479) |
| `REPAIR_OPENING_SEGMENTS` | 16 | solid/measure.ts:49 | the cheaper arc count repair already uses (repair.ts:376) |
| `MAX_DRAPED_SLICES` | 32 | solid/measure.ts:364 | explicit ceiling on the draped min-wall sweep (measure.ts:336) |
| `DRAPED_SLICE_PITCH_MM` | 0.05 | solid/measure.ts:354 | requested slice pitch before that cap |
| `UNION_BATCH` | 200 | solid/manifold.ts:543 | solids per batched union level (manifold.ts:571) |
| `SLIVER_PASSES` | 3 | solid/tiling.ts:170 | cut-line nudge passes (tiling.ts:1002, :1023) |
| `MIN_WALL_WIDEN_ROUNDS` | 6 | solid/repair.ts:82 | widen retries (step `minWall * 0.1`, repair.ts:662) |
| `APPENDAGE_ROUNDS` | 3 | solid/repair.ts:145 | appendage-trim iterations |
| `TEXTURE_MAX_ELEMENTS` | 2000 | solid/frame.ts:93 | cap on frame texture elements |
| `MAX_GRID_SAMPLES` / `MIN_GRID_SAMPLES` | 257 / 8 | terrain/heightfield.ts:59, :62 | DEM grid resolution (`gridSamplesFor` :69-71) |
| smoothing rounds clamp | 0..5 | terrain/heightfield.ts:144 | box-blur passes from `terrain.smoothing` |
| `MIN_ZOOM` / `MAX_ZOOM` | 12 / 14 | terrain/tiles.ts:44, :45 | DEM tile zoom (`zoomFor` :79-84) |
| `MAX_TILES` | 36 | terrain/tiles.ts:115 | DEM tiles fetched (tiles.ts:231) |
| `CIRCLE_SEGMENTS` (preview) | 64 | lib/previewText.ts:321 | preview glyph and ornament arcs |

**Structural** (changing them changes a verdict, not a triangle count):
`SIMPLIFY_EPS_MM` 0.001 (context.ts:92), `LAYER_SEPARATION_MM` 0.02
(context.ts:34), `POCKET_GROW_MM` 0.002 / `CUTTER_OVERSHOOT_MM` 0.5 /
`MIN_REGION_DEPTH_MM` 0.2 / `MAX_POCKET_FRACTION` 0.5 (context.ts:58, :89,
:319, :308), `EXTRUDE_SIMPLIFY_MM` 1e-4 and `DEBURR_MM` 1e-5 (manifold.ts:392,
:410), `Z_GRID_MM` 1/4096 (manifold.ts:499), `MITRE_LIMIT` 2.0
(manifold.ts:53), `DEBRIS_MM3` 0.01 / `UNION_DEBRIS_MM3` 1e-9 (manifold.ts:611,
:623), `DRAPE_SIMPLIFY_MM` 1e-6 and `LOW_RELIEF_MM` 0.8 (drape.ts:110, :99),
`SLICE_SIMPLIFY_MM` 0.002 (measure.ts:65), `OPENING_RESOLUTION_MM` 0.01 /
`OPENING_KEEP_FRACTION` 0.99 / `OPENING_BRACKET` 1.5 (measure.ts:35, :32, :54),
the fixed slice band fractions `[0.15, 0.35, 0.6, 0.85]` (measure.ts:294),
`WALL_PERSIST_PER_NOZZLE` 0.625 / `WALL_PERSIST_RATIO` 0.7 (measure.ts:79,
:82), `MIN_WALL_PROBE_FACTOR` 0.45 / `MIN_WALL_KEEP_FACTOR` 0.5 (repair.ts:65,
:79), the residue constants (repair.ts:96-134), the tiling snap constants
(tiling.ts:132-160), and `SIT_EPS_MM` 1e-9 (engine.ts:105).

Two traps. `SIMPLIFY_TOLERANCE_M` 0.25 (osm/normalize.ts:44) looks cheapenable
but is pinned by `osm/normalize.test.ts` against the committed Overpass
fixture. `flatten_tolerance_mm` 0.02 lives in the committed font assets
(`lib/fonts/*.glyphs.json:7`) and is consumed at `solid/attribution.ts:407` to
simplify *back* to the asset tolerance, so lowering it buys nothing and raising
it breaks the attribution min-wall check.

**A recommended preview budget**, all safe: raise `TERRAIN_CELL_MM`, lower
`TREE_SIDES`, `CIRCLE_SEGMENTS`, `DOT_SEGMENTS`, `PIN_SEGMENTS`,
`PROFILE_SLABS`, `HANGER_SLABS`, `MAX_DRAPED_SLICES` and `MAX_GRID_SAMPLES`,
and swap `OPENING_SEGMENTS` for `REPAIR_OPENING_SEGMENTS`. Note from section 3
that none of this touches the 68 % spent in mesh extraction.

---

## 8. Test surface

**Files that pin engine behaviour**, one line each.

`lib/engine/solid/engine.test.ts`: the Chicago golden, one bake in `beforeAll`
(`:77`), every claim about it. · `solid/synthetic.test.ts`: one
`04_PRINTABILITY_SPEC` property per small scene. · `solid/terrain.test.ts`:
drape, recesses, bridges, rail, trees probed on the finished model. ·
`solid/frame.test.ts`: profiles, corners, shadow gap, matting. ·
`solid/frameoff.test.ts`: the frame-off Chicago plate against the reference
validator rule. · `solid/text.test.ts`: lettering and ornaments on a small
plate. · `solid/tiling.test.ts`: tile grid, joints, cost of a cut. ·
`solid/attribution.test.ts`: the mandatory marks always present and legible. ·
`solid/measure.test.ts`: what the min-wall gate may spend, no bake. ·
`audit/rules.test.ts` and `audit/fixes.test.ts`: pure functions of finished
meshes. · `estimate.test.ts`: filament arithmetic, one real bake. ·
`client.test.ts`: the client against a fake `Worker`. ·
`client.supersede.test.ts`: supersede with a real Worker, `vi.mock("./engine")`
(`:28`). · `protocol.test.ts`: `runBakeJob` single-flight coalescing. ·
`protocol.terrain.test.ts`: terrain passed through verbatim,
`vi.mock("./engine")` (`:52`). · `export/{bambu3mf,generic3mf,stl,obj,step,colorchange,tiles,index,xml,zip}.test.ts`:
file structure per target, all off the synthetic `export/fixtures.ts`, none
bake. · `osm/{geometry,normalize,heights,presets,project,overpass,scene,sha1}.test.ts`:
ingest. · `terrain/tiles.test.ts`: the DEM fetcher against a synthetic
server. · `lib/transform.test.ts`: TS/Python parity on
`fixtures/parity-scene.json`. · `lib/bake.test.ts`: pure state transitions. ·
`lib/enginePreview.test.ts`: `freshEngineResult`. · `lib/preview.test.ts`:
preview geometry. · `components/scene/{AreaSurfaces,CityPreview,CityPreview.hud,InstancedBuildings,RegionMeshes,palette}.test.ts`:
triangulation, memo and effect keys, `RegionMesh` consumption. ·
`store/editor.test.ts`: store wiring and the no-server-call rule. ·
`store/editor.terrain.test.ts`: debounced DEM fetch. ·
`store/history.test.ts`: undo/redo coalescing.

**Direct `bake()` callers asserting on `EngineResult`**, about 79 call sites:
`solid/terrain.test.ts` ~31, `solid/synthetic.test.ts` ~16,
`solid/engine.test.ts` ~11, `solid/tiling.test.ts` ~9,
`solid/attribution.test.ts` ~8, plus one each in `estimate.test.ts:153`,
`solid/frame.test.ts:75`, `solid/text.test.ts` and `solid/frameoff.test.ts:86`.

**Timing budgets**: `TIME_BUDGET_MS = 15_000` (solid/engine.test.ts:37,
asserted :310), `TERRAIN_TIME_BUDGET_MS = 15_000` (:47, asserted :500),
`TILED_TIME_BUDGET_MS = 25_000` (solid/tiling.test.ts:32, asserted :388),
inline 1 500 ms (osm/normalize.test.ts:32), an inline per-update budget
(lib/preview.test.ts:367-371). Playwright: global `timeout: 300_000`
(playwright.config.ts:85), `expect.timeout: 15_000` (:86), project timeouts
180 s (:122) and 300 s (:135). `vitest.config.ts` sets no test timeout.

**`onSolids`**: exactly one consumer, `solid/engine.test.ts:208`, inside the
bake at `:205`. Declared `engine.ts:119`, invoked `engine.ts:447`.

**Tests that must change if `bake()` becomes a staged runner.**

| test | why |
|---|---|
| `solid/engine.test.ts` | uses `onSolids` (`:208`) **and** asserts wall clock (`:310`, `:500`) against one `beforeAll` bake; memoization makes both meaningless |
| `solid/tiling.test.ts` | asserts elapsed (`:388`) across 9 sequential bakes that would then share stages |
| `solid/terrain.test.ts`, `solid/synthetic.test.ts`, `solid/attribution.test.ts` | 31/16/8 direct bakes that assume independence; shared memoized stages need cache-key coverage |
| `protocol.test.ts` | asserts `bake()` is called exactly once per coalesced request; a memoizing runner changes that count |
| `protocol.terrain.test.ts`, `client.supersede.test.ts` | `vi.mock("./engine")` as `{ bake }`; a staged export surface breaks the mock shape |
| `solid/measure.test.ts` | pins the operation budget the gate may spend; per-stage memoization changes how often the gate runs |
| `solid/frame.test.ts`, `solid/text.test.ts`, `solid/frameoff.test.ts`, `estimate.test.ts` | call bake through a helper; signature and return-shape churn only |
| `components/scene/CityPreview.test.ts:299-320` | asserts that ten param groups rebuild nothing in `previewDeps`; if the preview starts reacting to `frame_style` or `tiling`, this test is the one that fails, by design |

**Playwright specs that exercise a bake** (`apps/web/e2e/`, all offline via
`overpassMock.ts`): `smoke.spec.ts` the primary flow end to end;
`ui.spec.ts` editor behaviour plus every export target as a Blob download;
`print.spec.ts` printer group, Issues drawer, 2x2 tiling and a tiled export;
`terrain.spec.ts` the terrain group against a mocked elevation tile;
`colour.spec.ts` palettes and themes with a `waitForFreshBake` helper (`:102`);
`lettering.spec.ts` `{city}` resolving in preview and in the baked sidecar
(`:95`); `share.spec.ts` a permalink round trip across two contexts, each
baking; `workflow.spec.ts` search, undo/redo, project download;
`a11y.spec.ts` axe over four editor states. The parallel agent also added
`e2e/perf.spec.ts`, uncommitted.
