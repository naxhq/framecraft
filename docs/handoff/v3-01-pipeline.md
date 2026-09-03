# v3-01 pipeline (Task 1: the pipeline core, engine side)

Written by the pipeline core agent against `docs/handoff/v3-01-pipeline-design.md`
(binding) and `docs/handoff/v3-01-inventory.md` (measured facts). Everything
below was produced by running the code in this tree; the stage table is the
program's own `describeGraph()` output, embedded verbatim and checked by
`lib/engine/pipeline/graph.test.ts` against the registry on every test run.

## 1. What landed

`apps/web/lib/engine/pipeline/`: `paths.ts` (the generated
`PRINT_PARAM_LEAF_PATHS` as `ParamPath`, prefix expansion, path reads),
`hash.ts` (SHA-1 stage keys), `stage.ts` (ids, phases, extras, the per-stage
context, every output type), `claims.ts` (the strict-claims Proxy),
`stages.ts` (the ordered registry, 71 stages), `graph.ts` (validation at
module load, downstream and upstream queries, `describeGraph()`), `cache.ts`
(the one-generation cache), `runner.ts` (`runPipeline`), `result.ts`
(`assembleResult`), `testScenes.ts` (four synthetic scenes for the matrix
wave) and `index.ts`.

`lib/engine/engine.ts:buildModel(input, options)` is now the pipeline over a
fresh cache and returns the same `EngineResult` shape plus the new optional
`recessBands`; every direct caller, `scripts/export-cli.ts` and
`scripts/gate-web-engine.sh` run unchanged. `lib/engine/protocol.ts` holds
`PipelineSession` (one cache, single flight, supersede at the next stage
boundary) and the additive message protocol; `lib/engine/worker.ts` binds one
session; `lib/engine/client.ts` exposes `PipelineClient` (design section 4)
and keeps `EngineClient` (`ingest`, `buildModel`, cancel semantics) for the
store, implemented over it. The second worker is gone. Exporters run in the
worker as the `export` stage; `colour.palette` is written into the sidecar
(`colour_palette`) and into both 3MF writers' metadata (`framecraft:palette`).
`packages/contracts/gen_ts.py` and `gen_py.py` emit `PRINT_PARAM_LEAF_PATHS`
(134 leaves); `make contracts` is byte-stable on a second run.

## 2. The generated stage table

`describeGraph()` as JSON. `inputs` entries of the form `stage#part` are
read through a named part digest (section 3.9); `digests` lists the parts a
stage defines. Params render prefixes expanded; a keyed claim renders as
`path=label`.

```json describeGraph
{
  "stages": [
    {
      "id": "fetch",
      "phase": "scene",
      "params": [],
      "inputs": [],
      "extra": [
        "scene-request"
      ],
      "digests": []
    },
    {
      "id": "normalise",
      "phase": "scene",
      "params": [
        "heights.floor_height_m",
        "heights.unknown_default_m",
        "heights.type_defaults.house",
        "heights.type_defaults.apartments",
        "heights.type_defaults.commercial",
        "heights.type_defaults.retail",
        "heights.type_defaults.industrial",
        "heights.type_defaults.garage"
      ],
      "inputs": [
        "fetch"
      ],
      "extra": [
        "scene-request"
      ],
      "digests": [
        "ground"
      ]
    },
    {
      "id": "context",
      "phase": "geometry",
      "params": [
        "plate_mm",
        "base_thickness_mm",
        "nozzle_mm",
        "frame",
        "frame_style.profile=floating",
        "frame_style.shadow_gap.enabled",
        "frame_style.shadow_gap.width_mm",
        "frame_style.matting.enabled",
        "frame_style.matting.width_mm"
      ],
      "inputs": [
        "normalise"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "terrain",
      "phase": "geometry",
      "params": [
        "terrain_exaggeration",
        "terrain.enabled",
        "terrain.smoothing"
      ],
      "inputs": [
        "context"
      ],
      "extra": [
        "terrain-grid"
      ],
      "digests": []
    },
    {
      "id": "heroes",
      "phase": "geometry",
      "params": [
        "hero_building_ids",
        "hero_auto.enabled",
        "hero_auto.count",
        "object_overrides[].osm_id",
        "object_overrides[].layer",
        "object_overrides[].hero"
      ],
      "inputs": [
        "normalise"
      ],
      "extra": [
        "hero-ids"
      ],
      "digests": []
    },
    {
      "id": "repair-buildings",
      "phase": "geometry",
      "params": [
        "base_thickness_mm",
        "small_scale",
        "large_scale",
        "hero_mode",
        "height_exaggeration.multiplier",
        "height_exaggeration.curve",
        "object_overrides[].osm_id",
        "object_overrides[].layer",
        "object_overrides[].hidden",
        "object_overrides[].height_scale"
      ],
      "inputs": [
        "normalise",
        "context",
        "heroes"
      ],
      "extra": [],
      "digests": [
        "footprint"
      ]
    },
    {
      "id": "surface-overrides",
      "phase": "geometry",
      "params": [
        "road_scale",
        "water",
        "regions.roads.depth_mm",
        "regions.roads.proud_mm",
        "regions.water.depth_mm",
        "regions.water.proud_mm",
        "regions.parks.depth_mm",
        "regions.parks.proud_mm",
        "bridges.enabled",
        "object_overrides[].osm_id",
        "object_overrides[].layer",
        "object_overrides[].hidden",
        "object_overrides[].slot",
        "object_overrides[].color",
        "object_overrides[].road_mode",
        "object_overrides[].width_scale",
        "object_overrides[].raise_mm"
      ],
      "inputs": [
        "normalise",
        "context",
        "repair-buildings"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "surface-water",
      "phase": "geometry",
      "params": [
        "water",
        "regions.water.depth_mm",
        "regions.water.proud_mm",
        "object_overrides[].osm_id",
        "object_overrides[].layer",
        "object_overrides[].hidden",
        "object_overrides[].slot",
        "object_overrides[].color",
        "object_overrides[].road_mode",
        "object_overrides[].raise_mm"
      ],
      "inputs": [
        "normalise#ground",
        "context",
        "repair-buildings#footprint",
        "surface-overrides"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "surface-rail",
      "phase": "geometry",
      "params": [
        "road_scale",
        "regions.rail.depth_mm",
        "regions.rail.proud_mm",
        "regions.rail.width_m",
        "bridges.enabled"
      ],
      "inputs": [
        "normalise#ground",
        "context",
        "repair-buildings#footprint",
        "surface-overrides",
        "surface-water"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "surface-roads",
      "phase": "geometry",
      "params": [
        "road_mode",
        "road_scale",
        "regions.roads.depth_mm",
        "regions.roads.proud_mm",
        "bridges.enabled",
        "object_overrides[].osm_id",
        "object_overrides[].layer",
        "object_overrides[].hidden",
        "object_overrides[].slot",
        "object_overrides[].color",
        "object_overrides[].road_mode",
        "object_overrides[].width_scale",
        "object_overrides[].raise_mm"
      ],
      "inputs": [
        "normalise#ground",
        "context",
        "repair-buildings#footprint",
        "surface-overrides",
        "surface-water",
        "surface-rail"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "surface-parks",
      "phase": "geometry",
      "params": [
        "frame",
        "regions.parks.depth_mm",
        "regions.parks.proud_mm",
        "object_overrides[].osm_id",
        "object_overrides[].layer",
        "object_overrides[].hidden",
        "object_overrides[].slot",
        "object_overrides[].color",
        "object_overrides[].road_mode",
        "object_overrides[].raise_mm"
      ],
      "inputs": [
        "normalise#ground",
        "context",
        "repair-buildings#footprint",
        "surface-overrides",
        "surface-water",
        "surface-rail",
        "surface-roads"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "buildings",
      "phase": "geometry",
      "params": [
        "base_thickness_mm",
        "small_scale",
        "large_scale",
        "regions.building_skirt_mm",
        "colour.region_colors.buildings",
        "colour.region_colors.hero_building",
        "colour.tint.enabled",
        "colour.tint.hue_range_deg",
        "colour.tint.lightness_range",
        "colour.tint.seed",
        "colour.gradient.enabled",
        "colour.gradient.slots",
        "height_exaggeration.multiplier",
        "height_exaggeration.curve",
        "object_overrides[].osm_id",
        "object_overrides[].layer",
        "object_overrides[].tint",
        "object_overrides[].slot",
        "object_overrides[].color",
        "object_overrides[].road_mode",
        "object_overrides[].raise_mm"
      ],
      "inputs": [
        "normalise",
        "context",
        "terrain",
        "repair-buildings"
      ],
      "extra": [],
      "digests": [
        "socket"
      ]
    },
    {
      "id": "bridges",
      "phase": "geometry",
      "params": [
        "road_mode",
        "road_scale",
        "regions.roads.depth_mm",
        "regions.rail.depth_mm",
        "regions.rail.width_m",
        "bridges.enabled",
        "bridges.clearance_mm",
        "bridges.abutments",
        "object_overrides[].osm_id",
        "object_overrides[].layer",
        "object_overrides[].hidden",
        "object_overrides[].road_mode",
        "object_overrides[].width_scale"
      ],
      "inputs": [
        "normalise#ground",
        "context",
        "terrain",
        "repair-buildings#footprint"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "trees",
      "phase": "geometry",
      "params": [
        "nozzle_mm",
        "trees"
      ],
      "inputs": [
        "normalise#ground",
        "context",
        "terrain",
        "repair-buildings#footprint",
        "surface-parks"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "tokens",
      "phase": "geometry",
      "params": [
        "plate_mm",
        "frame",
        "city_label",
        "hero_building_ids",
        "place.country",
        "place.state",
        "place.neighbourhood",
        "place.author",
        "hero_auto.enabled",
        "hero_auto.count"
      ],
      "inputs": [
        "normalise"
      ],
      "extra": [
        "date"
      ],
      "digests": []
    },
    {
      "id": "fonts",
      "phase": "geometry",
      "params": [
        "frame",
        "engravings[].edge",
        "engravings[].font",
        "scale_bar.enabled",
        "tiling.enabled",
        "tiling.index_mark",
        "labels[].font"
      ],
      "inputs": [],
      "extra": [],
      "digests": []
    },
    {
      "id": "labels",
      "phase": "geometry",
      "params": [
        "plate_mm",
        "base_thickness_mm",
        "nozzle_mm",
        "small_scale",
        "large_scale",
        "road_scale",
        "frame",
        "hero_mode",
        "regions.building_skirt_mm",
        "height_exaggeration.multiplier",
        "height_exaggeration.curve",
        "labels[].target_osm_id",
        "labels[].layer",
        "labels[].surface",
        "labels[].u",
        "labels[].v",
        "labels[].rotation_deg",
        "labels[].size_mm",
        "labels[].mode",
        "labels[].depth_mm",
        "labels[].font",
        "labels[].text",
        "labels[].follow"
      ],
      "inputs": [
        "normalise",
        "context",
        "terrain",
        "repair-buildings",
        "surface-parks",
        "fonts"
      ],
      "extra": [],
      "digests": [
        "base",
        "roofs",
        "ground"
      ]
    },
    {
      "id": "lettering",
      "phase": "geometry",
      "params": [
        "plate_mm",
        "base_thickness_mm",
        "nozzle_mm",
        "frame",
        "engravings[].edge",
        "engravings[].align",
        "engravings[].text",
        "engravings[].mode",
        "engravings[].size_mm",
        "engravings[].depth_mm",
        "engravings[].font",
        "north_arrow.enabled",
        "north_arrow.corner",
        "north_arrow.size_mm",
        "scale_bar.enabled",
        "scale_bar.edge",
        "scale_bar.length_mode",
        "scale_bar.length_m",
        "hanger",
        "underside_mark.enabled",
        "underside_mark.template",
        "regions.roads.depth_mm",
        "regions.roads.proud_mm",
        "regions.water.depth_mm",
        "regions.water.proud_mm",
        "regions.parks.depth_mm",
        "regions.parks.proud_mm",
        "regions.rail.depth_mm",
        "regions.rail.proud_mm",
        "frame_style.profile",
        "frame_style.corner",
        "frame_style.corner_radius_mm",
        "frame_style.lip_depth_mm",
        "frame_style.shadow_gap.enabled",
        "frame_style.shadow_gap.width_mm",
        "frame_style.shadow_gap.depth_mm",
        "frame_style.matting.enabled",
        "frame_style.matting.width_mm",
        "frame_style.matting.proud_mm",
        "frame_style.separate.enabled",
        "frame_style.separate.mount",
        "frame_style.separate.tolerance_mm",
        "frame_style.texture.pattern",
        "frame_style.texture.scale_mm",
        "frame_style.texture.depth_mm"
      ],
      "inputs": [
        "context",
        "tokens",
        "fonts"
      ],
      "extra": [
        "date",
        "rotation"
      ],
      "digests": [
        "base"
      ]
    },
    {
      "id": "ornaments",
      "phase": "geometry",
      "params": [
        "plate_mm",
        "base_thickness_mm",
        "nozzle_mm",
        "frame",
        "hanger",
        "regions.roads.depth_mm",
        "regions.roads.proud_mm",
        "regions.water.depth_mm",
        "regions.water.proud_mm",
        "regions.parks.depth_mm",
        "regions.parks.proud_mm",
        "regions.rail.depth_mm",
        "regions.rail.proud_mm",
        "frame_style.profile",
        "frame_style.corner",
        "frame_style.corner_radius_mm",
        "frame_style.lip_depth_mm",
        "frame_style.shadow_gap.enabled",
        "frame_style.shadow_gap.width_mm",
        "frame_style.shadow_gap.depth_mm",
        "frame_style.matting.enabled",
        "frame_style.matting.width_mm",
        "frame_style.matting.proud_mm",
        "frame_style.separate.enabled",
        "frame_style.separate.mount",
        "frame_style.separate.tolerance_mm",
        "frame_style.texture.pattern",
        "frame_style.texture.scale_mm",
        "frame_style.texture.depth_mm"
      ],
      "inputs": [
        "context",
        "lettering"
      ],
      "extra": [],
      "digests": [
        "base"
      ]
    },
    {
      "id": "attribution",
      "phase": "geometry",
      "params": [
        "plate_mm",
        "base_thickness_mm",
        "nozzle_mm",
        "frame",
        "hanger",
        "underside_mark.enabled",
        "underside_mark.template",
        "regions.roads.depth_mm",
        "regions.roads.proud_mm",
        "regions.water.depth_mm",
        "regions.water.proud_mm",
        "regions.parks.depth_mm",
        "regions.parks.proud_mm",
        "regions.rail.depth_mm",
        "regions.rail.proud_mm",
        "frame_style.profile",
        "frame_style.corner",
        "frame_style.corner_radius_mm",
        "frame_style.lip_depth_mm",
        "frame_style.shadow_gap.enabled",
        "frame_style.shadow_gap.width_mm",
        "frame_style.shadow_gap.depth_mm",
        "frame_style.matting.enabled",
        "frame_style.matting.width_mm",
        "frame_style.matting.proud_mm",
        "frame_style.separate.enabled",
        "frame_style.separate.mount",
        "frame_style.separate.tolerance_mm",
        "frame_style.texture.pattern",
        "frame_style.texture.scale_mm",
        "frame_style.texture.depth_mm"
      ],
      "inputs": [
        "context",
        "tokens",
        "fonts"
      ],
      "extra": [
        "date"
      ],
      "digests": [
        "base",
        "frame"
      ]
    },
    {
      "id": "hangers",
      "phase": "geometry",
      "params": [
        "plate_mm",
        "base_thickness_mm",
        "road_mode",
        "water",
        "hanger"
      ],
      "inputs": [
        "context"
      ],
      "extra": [],
      "digests": [
        "base"
      ]
    },
    {
      "id": "frame-cutters",
      "phase": "geometry",
      "params": [
        "plate_mm",
        "base_thickness_mm",
        "nozzle_mm",
        "road_mode",
        "water",
        "frame",
        "frame_style.profile",
        "frame_style.corner",
        "frame_style.corner_radius_mm",
        "frame_style.lip_depth_mm",
        "frame_style.shadow_gap.enabled",
        "frame_style.shadow_gap.width_mm",
        "frame_style.shadow_gap.depth_mm",
        "frame_style.matting.enabled",
        "frame_style.matting.width_mm",
        "frame_style.matting.proud_mm",
        "frame_style.separate.enabled",
        "frame_style.separate.mount",
        "frame_style.separate.tolerance_mm",
        "frame_style.texture.pattern",
        "frame_style.texture.scale_mm",
        "frame_style.texture.depth_mm",
        "hanger_magnet.diameter_mm",
        "hanger_magnet.thickness_mm",
        "hanger_magnet.count"
      ],
      "inputs": [
        "context",
        "lettering"
      ],
      "extra": [],
      "digests": [
        "base"
      ]
    },
    {
      "id": "base",
      "phase": "geometry",
      "params": [],
      "inputs": [
        "context",
        "terrain",
        "surface-parks",
        "buildings#socket",
        "labels#base",
        "lettering#base",
        "ornaments#base",
        "attribution#base",
        "hangers#base",
        "frame-cutters#base"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "frame",
      "phase": "geometry",
      "params": [
        "plate_mm",
        "base_thickness_mm",
        "nozzle_mm",
        "frame",
        "frame_style.profile",
        "frame_style.corner",
        "frame_style.corner_radius_mm",
        "frame_style.lip_depth_mm",
        "frame_style.shadow_gap.enabled",
        "frame_style.shadow_gap.width_mm",
        "frame_style.shadow_gap.depth_mm",
        "frame_style.matting.enabled",
        "frame_style.matting.width_mm",
        "frame_style.matting.proud_mm",
        "frame_style.separate.enabled",
        "frame_style.separate.mount",
        "frame_style.separate.tolerance_mm",
        "frame_style.texture.pattern",
        "frame_style.texture.scale_mm",
        "frame_style.texture.depth_mm"
      ],
      "inputs": [
        "context",
        "lettering",
        "ornaments",
        "attribution",
        "frame-cutters"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-base",
      "phase": "region",
      "params": [],
      "inputs": [
        "base"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "sit",
      "phase": "region",
      "params": [],
      "inputs": [
        "region-base",
        "hangers"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-base",
      "phase": "region",
      "params": [
        "colour.region_slots.base",
        "colour.region_colors.base"
      ],
      "inputs": [
        "region-base",
        "sit"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-frame",
      "phase": "region",
      "params": [],
      "inputs": [
        "frame"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-frame",
      "phase": "region",
      "params": [
        "colour.region_slots.frame",
        "colour.region_colors.frame"
      ],
      "inputs": [
        "region-frame",
        "sit"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-matting",
      "phase": "region",
      "params": [],
      "inputs": [
        "frame-cutters"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-matting",
      "phase": "region",
      "params": [
        "colour.region_slots.matting",
        "colour.region_colors.matting"
      ],
      "inputs": [
        "region-matting",
        "sit"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-buildings",
      "phase": "region",
      "params": [],
      "inputs": [
        "buildings",
        "labels#roofs"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-buildings",
      "phase": "region",
      "params": [
        "colour.region_slots.buildings",
        "colour.region_colors.buildings",
        "colour.region_colors.hero_building",
        "colour.gradient.enabled",
        "colour.gradient.slots"
      ],
      "inputs": [
        "region-buildings",
        "sit",
        "buildings"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-hero_building",
      "phase": "region",
      "params": [],
      "inputs": [
        "buildings",
        "labels#roofs"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-hero_building",
      "phase": "region",
      "params": [
        "hero_mode",
        "colour.region_slots.buildings",
        "colour.region_slots.hero_building",
        "colour.region_colors.buildings",
        "colour.region_colors.hero_building",
        "colour.gradient.enabled",
        "colour.gradient.slots"
      ],
      "inputs": [
        "region-hero_building",
        "sit",
        "buildings"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-roads",
      "phase": "region",
      "params": [],
      "inputs": [
        "context",
        "terrain",
        "surface-parks",
        "bridges",
        "labels#ground"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-roads",
      "phase": "region",
      "params": [
        "colour.region_slots.roads",
        "colour.region_colors.roads"
      ],
      "inputs": [
        "region-roads",
        "sit"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-water",
      "phase": "region",
      "params": [],
      "inputs": [
        "context",
        "terrain",
        "surface-parks",
        "labels#ground"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-water",
      "phase": "region",
      "params": [
        "colour.region_slots.water",
        "colour.region_colors.water"
      ],
      "inputs": [
        "region-water",
        "sit"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-parks",
      "phase": "region",
      "params": [],
      "inputs": [
        "context",
        "terrain",
        "surface-parks",
        "trees",
        "labels#ground"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-parks",
      "phase": "region",
      "params": [
        "colour.region_slots.parks",
        "colour.region_colors.parks"
      ],
      "inputs": [
        "region-parks",
        "sit"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-rail",
      "phase": "region",
      "params": [],
      "inputs": [
        "context",
        "terrain",
        "surface-parks",
        "bridges"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-rail",
      "phase": "region",
      "params": [
        "colour.region_slots.rail",
        "colour.region_colors.rail"
      ],
      "inputs": [
        "region-rail",
        "sit"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-lettering",
      "phase": "region",
      "params": [],
      "inputs": [
        "lettering"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-lettering",
      "phase": "region",
      "params": [
        "colour.region_slots.lettering",
        "colour.region_colors.lettering"
      ],
      "inputs": [
        "region-lettering",
        "sit"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-attribution",
      "phase": "region",
      "params": [],
      "inputs": [],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-attribution",
      "phase": "region",
      "params": [],
      "inputs": [
        "region-attribution",
        "sit"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-easel",
      "phase": "region",
      "params": [],
      "inputs": [
        "hangers"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-easel",
      "phase": "region",
      "params": [
        "colour.region_slots.base",
        "colour.region_colors.base"
      ],
      "inputs": [
        "region-easel",
        "sit"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-cleat",
      "phase": "region",
      "params": [],
      "inputs": [
        "hangers"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-cleat",
      "phase": "region",
      "params": [
        "colour.region_slots.base",
        "colour.region_colors.base"
      ],
      "inputs": [
        "region-cleat",
        "sit"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-buildings_band_2",
      "phase": "region",
      "params": [],
      "inputs": [
        "buildings",
        "labels#roofs"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-buildings_band_2",
      "phase": "region",
      "params": [
        "colour.region_colors.buildings",
        "colour.region_colors.hero_building",
        "colour.gradient.enabled",
        "colour.gradient.slots"
      ],
      "inputs": [
        "region-buildings_band_2",
        "sit",
        "buildings"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-buildings_band_3",
      "phase": "region",
      "params": [],
      "inputs": [
        "buildings",
        "labels#roofs"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-buildings_band_3",
      "phase": "region",
      "params": [
        "colour.region_colors.buildings",
        "colour.region_colors.hero_building",
        "colour.gradient.enabled",
        "colour.gradient.slots"
      ],
      "inputs": [
        "region-buildings_band_3",
        "sit",
        "buildings"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-buildings_band_4",
      "phase": "region",
      "params": [],
      "inputs": [
        "buildings",
        "labels#roofs"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-buildings_band_4",
      "phase": "region",
      "params": [
        "colour.region_colors.buildings",
        "colour.region_colors.hero_building",
        "colour.gradient.enabled",
        "colour.gradient.slots"
      ],
      "inputs": [
        "region-buildings_band_4",
        "sit",
        "buildings"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-buildings_band_5",
      "phase": "region",
      "params": [],
      "inputs": [
        "buildings",
        "labels#roofs"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-buildings_band_5",
      "phase": "region",
      "params": [
        "colour.region_colors.buildings",
        "colour.region_colors.hero_building",
        "colour.gradient.enabled",
        "colour.gradient.slots"
      ],
      "inputs": [
        "region-buildings_band_5",
        "sit",
        "buildings"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-buildings_band_6",
      "phase": "region",
      "params": [],
      "inputs": [
        "buildings",
        "labels#roofs"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-buildings_band_6",
      "phase": "region",
      "params": [
        "colour.region_colors.buildings",
        "colour.region_colors.hero_building",
        "colour.gradient.enabled",
        "colour.gradient.slots"
      ],
      "inputs": [
        "region-buildings_band_6",
        "sit",
        "buildings"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-buildings_band_7",
      "phase": "region",
      "params": [],
      "inputs": [
        "buildings",
        "labels#roofs"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-buildings_band_7",
      "phase": "region",
      "params": [
        "colour.region_colors.buildings",
        "colour.region_colors.hero_building",
        "colour.gradient.enabled",
        "colour.gradient.slots"
      ],
      "inputs": [
        "region-buildings_band_7",
        "sit",
        "buildings"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-buildings_band_8",
      "phase": "region",
      "params": [],
      "inputs": [
        "buildings",
        "labels#roofs"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-buildings_band_8",
      "phase": "region",
      "params": [
        "colour.region_colors.buildings",
        "colour.region_colors.hero_building",
        "colour.gradient.enabled",
        "colour.gradient.slots"
      ],
      "inputs": [
        "region-buildings_band_8",
        "sit",
        "buildings"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-override_1",
      "phase": "region",
      "params": [],
      "inputs": [
        "context",
        "terrain",
        "surface-parks",
        "buildings",
        "labels#roofs"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-override_1",
      "phase": "region",
      "params": [
        "colour.region_slots.buildings",
        "colour.region_slots.roads",
        "colour.region_slots.water",
        "colour.region_slots.parks",
        "colour.region_colors.buildings",
        "colour.region_colors.roads",
        "colour.region_colors.water",
        "colour.region_colors.parks",
        "object_overrides[].osm_id",
        "object_overrides[].layer",
        "object_overrides[].slot",
        "object_overrides[].color",
        "object_overrides[].road_mode",
        "object_overrides[].raise_mm"
      ],
      "inputs": [
        "region-override_1",
        "sit",
        "buildings"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-override_2",
      "phase": "region",
      "params": [],
      "inputs": [
        "context",
        "terrain",
        "surface-parks",
        "buildings",
        "labels#roofs"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-override_2",
      "phase": "region",
      "params": [
        "colour.region_slots.buildings",
        "colour.region_slots.roads",
        "colour.region_slots.water",
        "colour.region_slots.parks",
        "colour.region_colors.buildings",
        "colour.region_colors.roads",
        "colour.region_colors.water",
        "colour.region_colors.parks",
        "object_overrides[].osm_id",
        "object_overrides[].layer",
        "object_overrides[].slot",
        "object_overrides[].color",
        "object_overrides[].road_mode",
        "object_overrides[].raise_mm"
      ],
      "inputs": [
        "region-override_2",
        "sit",
        "buildings"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-override_3",
      "phase": "region",
      "params": [],
      "inputs": [
        "context",
        "terrain",
        "surface-parks",
        "buildings",
        "labels#roofs"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-override_3",
      "phase": "region",
      "params": [
        "colour.region_slots.buildings",
        "colour.region_slots.roads",
        "colour.region_slots.water",
        "colour.region_slots.parks",
        "colour.region_colors.buildings",
        "colour.region_colors.roads",
        "colour.region_colors.water",
        "colour.region_colors.parks",
        "object_overrides[].osm_id",
        "object_overrides[].layer",
        "object_overrides[].slot",
        "object_overrides[].color",
        "object_overrides[].road_mode",
        "object_overrides[].raise_mm"
      ],
      "inputs": [
        "region-override_3",
        "sit",
        "buildings"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "region-override_4",
      "phase": "region",
      "params": [],
      "inputs": [
        "context",
        "terrain",
        "surface-parks",
        "buildings",
        "labels#roofs"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "finish-override_4",
      "phase": "region",
      "params": [
        "colour.region_slots.buildings",
        "colour.region_slots.roads",
        "colour.region_slots.water",
        "colour.region_slots.parks",
        "colour.region_colors.buildings",
        "colour.region_colors.roads",
        "colour.region_colors.water",
        "colour.region_colors.parks",
        "object_overrides[].osm_id",
        "object_overrides[].layer",
        "object_overrides[].slot",
        "object_overrides[].color",
        "object_overrides[].road_mode",
        "object_overrides[].raise_mm"
      ],
      "inputs": [
        "region-override_4",
        "sit",
        "buildings"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "assembly",
      "phase": "audit",
      "params": [],
      "inputs": [
        "context",
        "terrain",
        "surface-parks",
        "buildings",
        "bridges",
        "trees",
        "labels",
        "lettering",
        "ornaments",
        "attribution",
        "hangers",
        "frame-cutters",
        "frame"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "merged",
      "phase": "audit",
      "params": [
        "colour.region_slots.base",
        "colour.region_colors.base"
      ],
      "inputs": [
        "assembly",
        "sit"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "measure",
      "phase": "audit",
      "params": [
        "base_thickness_mm",
        "nozzle_mm",
        "terrain_exaggeration",
        "frame",
        "hanger",
        "underside_mark.enabled",
        "regions.roads.depth_mm",
        "regions.roads.proud_mm",
        "regions.water.depth_mm",
        "regions.water.proud_mm",
        "regions.parks.depth_mm",
        "regions.parks.proud_mm",
        "regions.rail.depth_mm",
        "regions.rail.proud_mm"
      ],
      "inputs": [
        "context",
        "terrain",
        "assembly",
        "labels"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "validate",
      "phase": "audit",
      "params": [
        "plate_mm",
        "nozzle_mm",
        "large_scale",
        "terrain_exaggeration",
        "frame",
        "printer_profile",
        "custom_profile.plate_x_mm",
        "custom_profile.plate_y_mm",
        "custom_profile.max_height_mm",
        "custom_profile.nozzle_mm",
        "custom_profile.slots",
        "custom_profile.change_gcode"
      ],
      "inputs": [
        "normalise",
        "context",
        "terrain",
        "assembly",
        "measure",
        "finish-base",
        "finish-frame",
        "finish-matting",
        "finish-buildings",
        "finish-hero_building",
        "finish-roads",
        "finish-water",
        "finish-parks",
        "finish-rail",
        "finish-lettering",
        "finish-attribution",
        "finish-easel",
        "finish-cleat",
        "finish-buildings_band_2",
        "finish-buildings_band_3",
        "finish-buildings_band_4",
        "finish-buildings_band_5",
        "finish-buildings_band_6",
        "finish-buildings_band_7",
        "finish-buildings_band_8",
        "finish-override_1",
        "finish-override_2",
        "finish-override_3",
        "finish-override_4"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "islands",
      "phase": "audit",
      "params": [
        "frame",
        "hanger",
        "frame_style.profile",
        "frame_style.corner",
        "frame_style.corner_radius_mm",
        "frame_style.lip_depth_mm",
        "frame_style.shadow_gap.enabled",
        "frame_style.shadow_gap.width_mm",
        "frame_style.shadow_gap.depth_mm",
        "frame_style.matting.enabled",
        "frame_style.matting.width_mm",
        "frame_style.matting.proud_mm",
        "frame_style.separate.enabled",
        "frame_style.separate.mount",
        "frame_style.separate.tolerance_mm",
        "frame_style.texture.pattern",
        "frame_style.texture.scale_mm",
        "frame_style.texture.depth_mm"
      ],
      "inputs": [
        "context",
        "merged",
        "finish-base",
        "finish-frame",
        "finish-matting",
        "finish-buildings",
        "finish-hero_building",
        "finish-roads",
        "finish-water",
        "finish-parks",
        "finish-rail",
        "finish-lettering",
        "finish-attribution",
        "finish-easel",
        "finish-cleat",
        "finish-buildings_band_2",
        "finish-buildings_band_3",
        "finish-buildings_band_4",
        "finish-buildings_band_5",
        "finish-buildings_band_6",
        "finish-buildings_band_7",
        "finish-buildings_band_8",
        "finish-override_1",
        "finish-override_2",
        "finish-override_3",
        "finish-override_4"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "tiling",
      "phase": "audit",
      "params": [
        "base_thickness_mm",
        "nozzle_mm",
        "frame",
        "regions.roads.depth_mm",
        "regions.roads.proud_mm",
        "regions.water.depth_mm",
        "regions.water.proud_mm",
        "regions.parks.depth_mm",
        "regions.parks.proud_mm",
        "regions.rail.depth_mm",
        "regions.rail.proud_mm",
        "tiling.enabled",
        "tiling.cols",
        "tiling.rows",
        "tiling.joint",
        "tiling.tolerance_mm",
        "tiling.index_mark"
      ],
      "inputs": [
        "context",
        "merged",
        "attribution",
        "finish-base",
        "finish-frame",
        "finish-matting",
        "finish-buildings",
        "finish-hero_building",
        "finish-roads",
        "finish-water",
        "finish-parks",
        "finish-rail",
        "finish-lettering",
        "finish-attribution",
        "finish-easel",
        "finish-cleat",
        "finish-buildings_band_2",
        "finish-buildings_band_3",
        "finish-buildings_band_4",
        "finish-buildings_band_5",
        "finish-buildings_band_6",
        "finish-buildings_band_7",
        "finish-buildings_band_8",
        "finish-override_1",
        "finish-override_2",
        "finish-override_3",
        "finish-override_4"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "audit",
      "phase": "audit",
      "params": [
        "plate_mm",
        "nozzle_mm",
        "trees",
        "frame",
        "colour.region_slots.base",
        "colour.region_slots.frame",
        "colour.region_slots.matting",
        "colour.region_slots.buildings",
        "colour.region_slots.hero_building",
        "colour.region_slots.roads",
        "colour.region_slots.water",
        "colour.region_slots.parks",
        "colour.region_slots.rail",
        "colour.region_slots.lettering",
        "colour.region_slots.attribution",
        "printer_profile",
        "custom_profile.plate_x_mm",
        "custom_profile.plate_y_mm",
        "custom_profile.max_height_mm",
        "custom_profile.nozzle_mm",
        "custom_profile.slots",
        "custom_profile.change_gcode",
        "bridges.enabled",
        "tiling.enabled",
        "tiling.cols",
        "tiling.rows",
        "tiling.joint",
        "tiling.tolerance_mm",
        "tiling.index_mark",
        "frame_style.profile",
        "object_overrides[].osm_id",
        "object_overrides[].layer",
        "object_overrides[].slot",
        "object_overrides[].color",
        "object_overrides[].road_mode",
        "object_overrides[].raise_mm"
      ],
      "inputs": [
        "normalise",
        "context",
        "terrain",
        "repair-buildings",
        "surface-overrides",
        "buildings",
        "bridges",
        "trees",
        "merged",
        "measure",
        "validate",
        "islands",
        "tiling",
        "finish-base",
        "finish-frame",
        "finish-matting",
        "finish-buildings",
        "finish-hero_building",
        "finish-roads",
        "finish-water",
        "finish-parks",
        "finish-rail",
        "finish-lettering",
        "finish-attribution",
        "finish-easel",
        "finish-cleat",
        "finish-buildings_band_2",
        "finish-buildings_band_3",
        "finish-buildings_band_4",
        "finish-buildings_band_5",
        "finish-buildings_band_6",
        "finish-buildings_band_7",
        "finish-buildings_band_8",
        "finish-override_1",
        "finish-override_2",
        "finish-override_3",
        "finish-override_4"
      ],
      "extra": [],
      "digests": []
    },
    {
      "id": "export",
      "phase": "export",
      "params": [
        "schema_version",
        "city_label",
        "color_mode",
        "place.author",
        "colour.palette",
        "colour.preview_theme",
        "printer_profile",
        "custom_profile.plate_x_mm",
        "custom_profile.plate_y_mm",
        "custom_profile.max_height_mm",
        "custom_profile.nozzle_mm",
        "custom_profile.slots",
        "custom_profile.change_gcode",
        "export_target"
      ],
      "inputs": [
        "audit",
        "merged",
        "tiling",
        "attribution",
        "buildings",
        "lettering",
        "ornaments",
        "normalise",
        "validate",
        "finish-base",
        "finish-frame",
        "finish-matting",
        "finish-buildings",
        "finish-hero_building",
        "finish-roads",
        "finish-water",
        "finish-parks",
        "finish-rail",
        "finish-lettering",
        "finish-attribution",
        "finish-easel",
        "finish-cleat",
        "finish-buildings_band_2",
        "finish-buildings_band_3",
        "finish-buildings_band_4",
        "finish-buildings_band_5",
        "finish-buildings_band_6",
        "finish-buildings_band_7",
        "finish-buildings_band_8",
        "finish-override_1",
        "finish-override_2",
        "finish-override_3",
        "finish-override_4"
      ],
      "extra": [
        "export-request",
        "params-echo"
      ],
      "digests": []
    }
  ]
}
```

The same as a table:

| # | id | phase | params | inputs | extra | digests |
|---|---|---|---|---|---|---|
| 1 | `fetch` | scene | (none) | (none) | scene-request | (none) |
| 2 | `normalise` | scene | heights.floor_height_m, heights.unknown_default_m, heights.type_defaults.house, heights.type_defaults.apartments, heights.type_defaults.commercial, heights.type_defaults.retail, heights.type_defaults.industrial, heights.type_defaults.garage | fetch | scene-request | (none) |
| 3 | `context` | geometry | plate_mm, base_thickness_mm, nozzle_mm, frame, frame_style.profile=floating, frame_style.shadow_gap.enabled, frame_style.shadow_gap.width_mm, frame_style.matting.enabled, frame_style.matting.width_mm | normalise | (none) | (none) |
| 4 | `terrain` | geometry | terrain_exaggeration, terrain.enabled, terrain.smoothing | context | terrain-grid | (none) |
| 5 | `heroes` | geometry | hero_building_ids, hero_auto.enabled, hero_auto.count | normalise | hero-ids | (none) |
| 6 | `repair-buildings` | geometry | base_thickness_mm, small_scale, large_scale, hero_mode | normalise, context, heroes | (none) | (none) |
| 7 | `surface-water` | geometry | water, regions.water.depth_mm, regions.water.proud_mm | normalise, context, repair-buildings | (none) | (none) |
| 8 | `surface-rail` | geometry | road_scale, regions.rail.depth_mm, regions.rail.proud_mm, regions.rail.width_m, bridges.enabled | normalise, context, repair-buildings, surface-water | (none) | (none) |
| 9 | `surface-roads` | geometry | road_mode, road_scale, regions.roads.depth_mm, regions.roads.proud_mm, bridges.enabled | normalise, context, repair-buildings, surface-water, surface-rail | (none) | (none) |
| 10 | `surface-parks` | geometry | frame, regions.parks.depth_mm, regions.parks.proud_mm | normalise, context, repair-buildings, surface-water, surface-rail, surface-roads | (none) | (none) |
| 11 | `buildings` | geometry | base_thickness_mm, small_scale, large_scale, regions.building_skirt_mm, colour.region_colors.buildings, colour.region_colors.hero_building, colour.tint.enabled, colour.tint.hue_range_deg, colour.tint.lightness_range, colour.tint.seed, colour.gradient.enabled, colour.gradient.slots, height_exaggeration.multiplier, height_exaggeration.curve | context, terrain, repair-buildings | (none) | socket |
| 12 | `bridges` | geometry | road_mode, road_scale, regions.roads.depth_mm, regions.rail.depth_mm, regions.rail.width_m, bridges.enabled, bridges.clearance_mm, bridges.abutments | normalise, context, terrain, repair-buildings | (none) | (none) |
| 13 | `trees` | geometry | nozzle_mm, trees | normalise, context, terrain, repair-buildings, surface-parks | (none) | (none) |
| 14 | `tokens` | geometry | plate_mm, frame, city_label, hero_building_ids, place.country, place.state, place.neighbourhood, place.author, hero_auto.enabled, hero_auto.count | normalise | date | (none) |
| 15 | `fonts` | geometry | frame, engravings[].edge, engravings[].font, scale_bar.enabled, tiling.enabled, tiling.index_mark | (none) | (none) | (none) |
| 16 | `lettering` | geometry | plate_mm, base_thickness_mm, nozzle_mm, frame, engravings[].edge, engravings[].align, engravings[].text, engravings[].mode, engravings[].size_mm, engravings[].depth_mm, engravings[].font, north_arrow.enabled, north_arrow.corner, north_arrow.size_mm, scale_bar.enabled, scale_bar.edge, scale_bar.length_mode, scale_bar.length_m, hanger, underside_mark.enabled, underside_mark.template, regions.roads.depth_mm, regions.roads.proud_mm, regions.water.depth_mm, regions.water.proud_mm, regions.parks.depth_mm, regions.parks.proud_mm, regions.rail.depth_mm, regions.rail.proud_mm, frame_style.profile, frame_style.corner, frame_style.corner_radius_mm, frame_style.lip_depth_mm, frame_style.shadow_gap.enabled, frame_style.shadow_gap.width_mm, frame_style.shadow_gap.depth_mm, frame_style.matting.enabled, frame_style.matting.width_mm, frame_style.matting.proud_mm, frame_style.separate.enabled, frame_style.separate.mount, frame_style.separate.tolerance_mm, frame_style.texture.pattern, frame_style.texture.scale_mm, frame_style.texture.depth_mm | context, tokens, fonts | date, rotation | base |
| 17 | `ornaments` | geometry | plate_mm, base_thickness_mm, nozzle_mm, frame, hanger, regions.roads.depth_mm, regions.roads.proud_mm, regions.water.depth_mm, regions.water.proud_mm, regions.parks.depth_mm, regions.parks.proud_mm, regions.rail.depth_mm, regions.rail.proud_mm, frame_style.profile, frame_style.corner, frame_style.corner_radius_mm, frame_style.lip_depth_mm, frame_style.shadow_gap.enabled, frame_style.shadow_gap.width_mm, frame_style.shadow_gap.depth_mm, frame_style.matting.enabled, frame_style.matting.width_mm, frame_style.matting.proud_mm, frame_style.separate.enabled, frame_style.separate.mount, frame_style.separate.tolerance_mm, frame_style.texture.pattern, frame_style.texture.scale_mm, frame_style.texture.depth_mm | context, lettering | (none) | base |
| 18 | `attribution` | geometry | plate_mm, base_thickness_mm, nozzle_mm, frame, hanger, underside_mark.enabled, underside_mark.template, regions.roads.depth_mm, regions.roads.proud_mm, regions.water.depth_mm, regions.water.proud_mm, regions.parks.depth_mm, regions.parks.proud_mm, regions.rail.depth_mm, regions.rail.proud_mm, frame_style.profile, frame_style.corner, frame_style.corner_radius_mm, frame_style.lip_depth_mm, frame_style.shadow_gap.enabled, frame_style.shadow_gap.width_mm, frame_style.shadow_gap.depth_mm, frame_style.matting.enabled, frame_style.matting.width_mm, frame_style.matting.proud_mm, frame_style.separate.enabled, frame_style.separate.mount, frame_style.separate.tolerance_mm, frame_style.texture.pattern, frame_style.texture.scale_mm, frame_style.texture.depth_mm | context, tokens, fonts | date | base, frame |
| 19 | `hangers` | geometry | plate_mm, base_thickness_mm, road_mode, water, hanger | context | (none) | base |
| 20 | `frame-cutters` | geometry | plate_mm, base_thickness_mm, nozzle_mm, road_mode, water, frame, frame_style.profile, frame_style.corner, frame_style.corner_radius_mm, frame_style.lip_depth_mm, frame_style.shadow_gap.enabled, frame_style.shadow_gap.width_mm, frame_style.shadow_gap.depth_mm, frame_style.matting.enabled, frame_style.matting.width_mm, frame_style.matting.proud_mm, frame_style.separate.enabled, frame_style.separate.mount, frame_style.separate.tolerance_mm, frame_style.texture.pattern, frame_style.texture.scale_mm, frame_style.texture.depth_mm, hanger_magnet.diameter_mm, hanger_magnet.thickness_mm, hanger_magnet.count | context, lettering | (none) | base |
| 21 | `base` | geometry | (none) | context, terrain, surface-parks, buildings#socket, lettering#base, ornaments#base, attribution#base, hangers#base, frame-cutters#base | (none) | (none) |
| 22 | `frame` | geometry | plate_mm, base_thickness_mm, nozzle_mm, frame, frame_style.profile, frame_style.corner, frame_style.corner_radius_mm, frame_style.lip_depth_mm, frame_style.shadow_gap.enabled, frame_style.shadow_gap.width_mm, frame_style.shadow_gap.depth_mm, frame_style.matting.enabled, frame_style.matting.width_mm, frame_style.matting.proud_mm, frame_style.separate.enabled, frame_style.separate.mount, frame_style.separate.tolerance_mm, frame_style.texture.pattern, frame_style.texture.scale_mm, frame_style.texture.depth_mm | context, lettering, ornaments, attribution, frame-cutters | (none) | (none) |
| 23 | `region-base` | region | (none) | base | (none) | (none) |
| 24 | `sit` | region | (none) | region-base, hangers | (none) | (none) |
| 25 | `finish-base` | region | colour.region_slots.base, colour.region_colors.base | region-base, sit | (none) | (none) |
| 26 | `region-frame` | region | (none) | frame | (none) | (none) |
| 27 | `finish-frame` | region | colour.region_slots.frame, colour.region_colors.frame | region-frame, sit | (none) | (none) |
| 28 | `region-matting` | region | (none) | frame-cutters | (none) | (none) |
| 29 | `finish-matting` | region | colour.region_slots.matting, colour.region_colors.matting | region-matting, sit | (none) | (none) |
| 30 | `region-buildings` | region | (none) | buildings | (none) | (none) |
| 31 | `finish-buildings` | region | colour.region_slots.buildings, colour.region_colors.buildings, colour.region_colors.hero_building, colour.gradient.enabled, colour.gradient.slots | region-buildings, sit | (none) | (none) |
| 32 | `region-hero_building` | region | (none) | buildings | (none) | (none) |
| 33 | `finish-hero_building` | region | hero_mode, colour.region_slots.buildings, colour.region_slots.hero_building, colour.region_colors.buildings, colour.region_colors.hero_building, colour.gradient.enabled, colour.gradient.slots | region-hero_building, sit | (none) | (none) |
| 34 | `region-roads` | region | (none) | context, terrain, surface-parks, bridges | (none) | (none) |
| 35 | `finish-roads` | region | colour.region_slots.roads, colour.region_colors.roads | region-roads, sit | (none) | (none) |
| 36 | `region-water` | region | (none) | context, terrain, surface-parks | (none) | (none) |
| 37 | `finish-water` | region | colour.region_slots.water, colour.region_colors.water | region-water, sit | (none) | (none) |
| 38 | `region-parks` | region | (none) | context, terrain, surface-parks, trees | (none) | (none) |
| 39 | `finish-parks` | region | colour.region_slots.parks, colour.region_colors.parks | region-parks, sit | (none) | (none) |
| 40 | `region-rail` | region | (none) | context, terrain, surface-parks, bridges | (none) | (none) |
| 41 | `finish-rail` | region | colour.region_slots.rail, colour.region_colors.rail | region-rail, sit | (none) | (none) |
| 42 | `region-lettering` | region | (none) | lettering | (none) | (none) |
| 43 | `finish-lettering` | region | colour.region_slots.lettering, colour.region_colors.lettering | region-lettering, sit | (none) | (none) |
| 44 | `region-attribution` | region | (none) | (none) | (none) | (none) |
| 45 | `finish-attribution` | region | (none) | region-attribution, sit | (none) | (none) |
| 46 | `region-easel` | region | (none) | hangers | (none) | (none) |
| 47 | `finish-easel` | region | colour.region_slots.base, colour.region_colors.base | region-easel, sit | (none) | (none) |
| 48 | `region-cleat` | region | (none) | hangers | (none) | (none) |
| 49 | `finish-cleat` | region | colour.region_slots.base, colour.region_colors.base | region-cleat, sit | (none) | (none) |
| 50 | `region-buildings_band_2` | region | (none) | buildings | (none) | (none) |
| 51 | `finish-buildings_band_2` | region | colour.region_colors.buildings, colour.region_colors.hero_building, colour.gradient.enabled, colour.gradient.slots | region-buildings_band_2, sit | (none) | (none) |
| 52 | `region-buildings_band_3` | region | (none) | buildings | (none) | (none) |
| 53 | `finish-buildings_band_3` | region | colour.region_colors.buildings, colour.region_colors.hero_building, colour.gradient.enabled, colour.gradient.slots | region-buildings_band_3, sit | (none) | (none) |
| 54 | `region-buildings_band_4` | region | (none) | buildings | (none) | (none) |
| 55 | `finish-buildings_band_4` | region | colour.region_colors.buildings, colour.region_colors.hero_building, colour.gradient.enabled, colour.gradient.slots | region-buildings_band_4, sit | (none) | (none) |
| 56 | `region-buildings_band_5` | region | (none) | buildings | (none) | (none) |
| 57 | `finish-buildings_band_5` | region | colour.region_colors.buildings, colour.region_colors.hero_building, colour.gradient.enabled, colour.gradient.slots | region-buildings_band_5, sit | (none) | (none) |
| 58 | `region-buildings_band_6` | region | (none) | buildings | (none) | (none) |
| 59 | `finish-buildings_band_6` | region | colour.region_colors.buildings, colour.region_colors.hero_building, colour.gradient.enabled, colour.gradient.slots | region-buildings_band_6, sit | (none) | (none) |
| 60 | `region-buildings_band_7` | region | (none) | buildings | (none) | (none) |
| 61 | `finish-buildings_band_7` | region | colour.region_colors.buildings, colour.region_colors.hero_building, colour.gradient.enabled, colour.gradient.slots | region-buildings_band_7, sit | (none) | (none) |
| 62 | `region-buildings_band_8` | region | (none) | buildings | (none) | (none) |
| 63 | `finish-buildings_band_8` | region | colour.region_colors.buildings, colour.region_colors.hero_building, colour.gradient.enabled, colour.gradient.slots | region-buildings_band_8, sit | (none) | (none) |
| 64 | `assembly` | audit | (none) | context, terrain, surface-parks, buildings, bridges, trees, lettering, ornaments, attribution, hangers, frame-cutters, frame | (none) | (none) |
| 65 | `merged` | audit | colour.region_slots.base, colour.region_colors.base | assembly, sit | (none) | (none) |
| 66 | `measure` | audit | base_thickness_mm, nozzle_mm, terrain_exaggeration, frame, hanger, underside_mark.enabled, regions.roads.depth_mm, regions.roads.proud_mm, regions.water.depth_mm, regions.water.proud_mm, regions.parks.depth_mm, regions.parks.proud_mm, regions.rail.depth_mm, regions.rail.proud_mm | context, terrain, assembly | (none) | (none) |
| 67 | `validate` | audit | plate_mm, nozzle_mm, large_scale, terrain_exaggeration, frame, printer_profile, custom_profile.plate_x_mm, custom_profile.plate_y_mm, custom_profile.max_height_mm, custom_profile.nozzle_mm, custom_profile.slots, custom_profile.change_gcode | normalise, context, terrain, assembly, measure, finish-base, finish-frame, finish-matting, finish-buildings, finish-hero_building, finish-roads, finish-water, finish-parks, finish-rail, finish-lettering, finish-attribution, finish-easel, finish-cleat, finish-buildings_band_2, finish-buildings_band_3, finish-buildings_band_4, finish-buildings_band_5, finish-buildings_band_6, finish-buildings_band_7, finish-buildings_band_8 | (none) | (none) |
| 68 | `islands` | audit | frame, hanger, frame_style.profile, frame_style.corner, frame_style.corner_radius_mm, frame_style.lip_depth_mm, frame_style.shadow_gap.enabled, frame_style.shadow_gap.width_mm, frame_style.shadow_gap.depth_mm, frame_style.matting.enabled, frame_style.matting.width_mm, frame_style.matting.proud_mm, frame_style.separate.enabled, frame_style.separate.mount, frame_style.separate.tolerance_mm, frame_style.texture.pattern, frame_style.texture.scale_mm, frame_style.texture.depth_mm | context, merged, finish-base, finish-frame, finish-matting, finish-buildings, finish-hero_building, finish-roads, finish-water, finish-parks, finish-rail, finish-lettering, finish-attribution, finish-easel, finish-cleat, finish-buildings_band_2, finish-buildings_band_3, finish-buildings_band_4, finish-buildings_band_5, finish-buildings_band_6, finish-buildings_band_7, finish-buildings_band_8 | (none) | (none) |
| 69 | `tiling` | audit | base_thickness_mm, nozzle_mm, frame, regions.roads.depth_mm, regions.roads.proud_mm, regions.water.depth_mm, regions.water.proud_mm, regions.parks.depth_mm, regions.parks.proud_mm, regions.rail.depth_mm, regions.rail.proud_mm, tiling.enabled, tiling.cols, tiling.rows, tiling.joint, tiling.tolerance_mm, tiling.index_mark | context, merged, attribution, finish-base, finish-frame, finish-matting, finish-buildings, finish-hero_building, finish-roads, finish-water, finish-parks, finish-rail, finish-lettering, finish-attribution, finish-easel, finish-cleat, finish-buildings_band_2, finish-buildings_band_3, finish-buildings_band_4, finish-buildings_band_5, finish-buildings_band_6, finish-buildings_band_7, finish-buildings_band_8 | (none) | (none) |
| 70 | `audit` | audit | plate_mm, nozzle_mm, trees, frame, colour.region_slots.base, colour.region_slots.frame, colour.region_slots.matting, colour.region_slots.buildings, colour.region_slots.hero_building, colour.region_slots.roads, colour.region_slots.water, colour.region_slots.parks, colour.region_slots.rail, colour.region_slots.lettering, colour.region_slots.attribution, printer_profile, custom_profile.plate_x_mm, custom_profile.plate_y_mm, custom_profile.max_height_mm, custom_profile.nozzle_mm, custom_profile.slots, custom_profile.change_gcode, bridges.enabled, tiling.enabled, tiling.cols, tiling.rows, tiling.joint, tiling.tolerance_mm, tiling.index_mark, frame_style.profile | normalise, context, terrain, repair-buildings, buildings, bridges, trees, merged, measure, validate, islands, tiling, finish-base, finish-frame, finish-matting, finish-buildings, finish-hero_building, finish-roads, finish-water, finish-parks, finish-rail, finish-lettering, finish-attribution, finish-easel, finish-cleat, finish-buildings_band_2, finish-buildings_band_3, finish-buildings_band_4, finish-buildings_band_5, finish-buildings_band_6, finish-buildings_band_7, finish-buildings_band_8 | (none) | (none) |
| 71 | `export` | export | schema_version, city_label, color_mode, place.author, colour.palette, colour.preview_theme, printer_profile, custom_profile.plate_x_mm, custom_profile.plate_y_mm, custom_profile.max_height_mm, custom_profile.nozzle_mm, custom_profile.slots, custom_profile.change_gcode, export_target | audit, merged, tiling, attribution, buildings, lettering, ornaments, normalise, validate, finish-base, finish-frame, finish-matting, finish-buildings, finish-hero_building, finish-roads, finish-water, finish-parks, finish-rail, finish-lettering, finish-attribution, finish-easel, finish-cleat, finish-buildings_band_2, finish-buildings_band_3, finish-buildings_band_4, finish-buildings_band_5, finish-buildings_band_6, finish-buildings_band_7, finish-buildings_band_8 | export-request, params-echo | (none) |

## 3. Where the table differs from the design's, and why the code says so

Every claim was set from what the code reads, measured with the strict-claims
Proxy in recording mode over 28 scene and parameter variants (the Chicago
fixture through both the provided-scene and the Overpass paths, the four
synthetic scenes, every frame style, every hanger, every export target, tiling
in both joints, terrain, gradients, tints, heroes in both modes, a plate past
the profile, a thin wall, a tall building). The sweep ended with zero
undeclared reads. Three declared leaves the sweep did not exercise are read on
failing branches only and are kept with a comment on the stage:
`validate` reads `terrain_exaggeration` and `frame` on the thin-wall branch
(the hilly remedy and the bigger-plate advice through `recommend_plate_mm`),
`audit` reads `trees` when a parks island carries a one-click fix.

### 3.1 The surface layers

`surface-water`, `surface-rail` and `surface-roads` are pass one of the layer
pipeline (the repaired footprint, each blocked by the ones before it) and
`surface-parks` is pass one for parks PLUS the ridge merge and the extrusion
of all four layers. The merge (`areas.mergeRecessRidges`, frame off only)
needs to know which recessed layers exist, which is known only when every
layer has been repaired, and its sink is the last recessed layer that was
actually built; extrusion is milliseconds. The expensive part of each layer
(roads' repair is 620 ms on Chicago) stays in its own stage, so a
`regions.parks.*` change re-runs the parks repair and four cheap extrusions,
not the road repair. `region-water`, `region-roads` and `region-rail` and
`trees` therefore list `surface-parks`, not their own layer's stage.
`mergeInto` no longer frees the pre-merge sections: they are another stage's
cached output.

### 3.2 `lettering` does not depend on `attribution`

The underside reserve the lettering lays out around is a pure layout both
compute (`attribution.undersideReserveMm`), so `lettering` computes it itself
and the registry keeps the old traversal's order (lettering, ornaments,
attribution): `resolvedText` and the findings come out in the order every
existing test expects.

### 3.3 The scene is `normalise`'s output and nothing else's

Every stage that reads the scene (through `ctx.scene` or `ctx.build.scene`)
lists `normalise` as an input: `repair-buildings`, the four surface stages,
`bridges`, `trees`, `tokens`, `heroes`, `validate` (the bigger-plate advice
walks the footprints), `audit`, `export`. The runner throws when a stage
touches the scene without the declaration. The design routed the scene through
`context`; that would let a scene change hide behind the context's unchanged
numbers under the digest rule (3.9).

### 3.4 `terrain` claims `terrain.enabled` and `terrain.smoothing` for real

The worker gates the grid on `terrain.enabled` (a grid handed straight to
`buildModel()` or the CLI carries `gate: "always"` and is authoritative, which
is what every direct caller means by it) and applies `terrain.smoothing`
itself, once. `fetchTerrainGrid` now returns the RAW grid stamped
`smoothing: 0` (`TerrainGrid.smoothing`, additive); a grid with no stamp is
final as given, so the synthetic grids of the terrain tests are untouched.
`terrain/tiles.test.ts`'s smoothing test was rewritten accordingly (section
8). The store still refetches on a smoothing change (its cache key includes
it); the next wave can drop that.

### 3.5 `heroes` resolves `hero_auto` in the worker

`hero_building_ids`, `hero_auto.enabled` and `hero_auto.count` are claimed by
`heroes`, which runs `heroCandidates` and `autoHeroIds` itself; the store's
`heroIds` still arrives as the `hero-ids` extra and wins when present (it is
the same computation). `tokens` needs only `normalise` (`heroTokenInfo`
recomputes the candidates) and also reads `plate_mm` and `frame` for the
`{scale}` token.

### 3.6 Claims trimmed or extended from the design's rows

`fonts` reads `engravings[].edge`, `engravings[].font`, `frame`,
`scale_bar.enabled`, `tiling.enabled` and `tiling.index_mark` (`facesFor`),
not `underside_mark.*`. `repair-buildings` reads `small_scale`, `large_scale`,
`hero_mode` and `base_thickness_mm` (the skirt clamp), not
`height_exaggeration.*` or `regions.building_skirt_mm`. `buildings` reads no
slots and no `hero_mode`. `bridges` reads `regions.roads.depth_mm`,
`regions.rail.depth_mm` and `regions.rail.width_m` only. `surface-rail` also
reads `bridges.enabled` and `road_scale`. `trees` reads `nozzle_mm`.
`ornaments` reads no `north_arrow.*` or `scale_bar.*` at all: the layout comes
from `lettering`, and it reads `frame_style.*` (the lip geometry) plus the
eight placement leaves. `hangers` and `frame-cutters` read `road_mode` and
`water` through `transform.deepest_recess_mm`, and no `regions.*`. `base` and
`assembly` read nothing themselves. `measure` reads `underside_mark.enabled`
and the eight placement leaves. `tiling` reads no `hanger` or
`underside_mark.*`: `ctx.markBands` is always filled by the attribution, so
the fallback never runs. `audit` reads `frame_style.profile` and
`colour.region_slots.*` and, on failing branches, `plate_mm`, `trees`,
`bridges.enabled`. `export` reads `place.author` only, not `place.*`.
`context` claims `frame_style.profile` as a keyed claim (`=floating`): it
reads the profile only to ask whether the frame is floating (the 2 mm gap the
city gives way to), and keying on the raw string would rebuild the whole
model for a plain-to-chamfer change.

The colour leaves are claimed by `finish-<name>`, not by `region-<name>`:
`regionSlot` and `regionColor` are read when the mesh is made. `buildings`
is gradient band 1 and reads `colour.gradient.*` and the hero colour it ramps
towards; band N (2 and up) exists only with the gradient on and never reads
`region_slots.buildings`; `hero_building` reads its own and the buildings'
colours plus `hero_mode`; `easel` and `cleat` read the base colour.
`finish-attribution` claims nothing: no stage produces an attribution region
solid (the marks are cuts), so it is always null (section 5).

### 3.7 Region and finish stages interleave

`region-<name>` and `finish-<name>` are generated per region and interleaved
(`region-base`, `sit`, `finish-base`, `region-frame`, `finish-frame`, ...),
so the plate is finished and posted before the next region is built. `sit`
reads the base region solid and the hanger parts, as the design says; it no
longer sees the other regions, which cannot reach below the bed, and
`validate` still reports a model that does not sit at zero.

### 3.8 Extras and modes

Extras are `scene-request`, `terrain-grid` (`{grid, gate}`), `hero-ids`,
`date`, `rotation` (the SceneRequest's rotation, which the lettering needs
for the north arrow; added, because the compat path has no SceneRequest) and
`export-request`. Modes are `scene` (added: the compat `ingest` stops after
`normalise`), `preview`, `full` and `export`. A run's source is an Overpass
request, a finished scene with a key, or `cached` (the `normalise` hash a
`scene-ready` event carried), which is how the store's build after an ingest
sends 40 bytes instead of 1.2 MB of scene; a stale key errors and the client
resends the scene.

### 3.9 Two things the design did not have, both needed for the 400 ms targets

**Content digests for data outputs.** A stage whose output is plain data (the
context numbers, the `sit` offset, a token table, the min-wall report)
contributes a content hash to downstream keys instead of its own key, and
its generation is not pinned by consumers that only read it. A base change
re-runs `sit`, but the offset is still 0, so `finish-buildings` and every
other finish stay cached. Generations are pinned only for inputs whose
handles an output actually references (found by walking the output), which
is exactly the set that can dangle when the input is replaced.

**Named part digests.** `lettering#base`, `ornaments#base`,
`attribution#base` and `#frame`, `hangers#base`, `frame-cutters#base` and
`buildings#socket` are content hashes of the cutter meshes those stages hand
the base (the constant `none` for an empty list, else the canonically ordered
meshes). `base` is keyed on those parts, so a frame-edge text, an ornament on
the lip or a profile change no longer re-carves the plate and re-finishes it.
Exact, because two solids with the same mesh are the same solid; cheap,
because the cutters are text pockets and a keyhole.

Two more parts, from the Task 7 close-out (`v3-07-perf.md` section 8):
`normalise#ground` is a content hash of the scene's `bounds`, `center`,
`roads`, `rail`, `water`, `green` and `trees` (`stages.SCENE_GROUND_LAYERS`),
and `repair-buildings#footprint` is a hash of the polygons of the union the
base is socketed with. The four surface stages, `bridges` and `trees` are
keyed on those two instead of the whole scene and the whole repair, because
`heights.*` moves a building's height and nothing outside `buildings` and
`stats`, and the footprint union reads no height. A stage keyed on a scene
part is handed a view of the scene with every other layer behind a getter
that throws (`runner.scenePartView`), so a ground stage that started reading
a building would fail its run rather than be served stale ground.

**Canonical mesh order.** `toRegionMesh` now sorts vertices by coordinate and
triangles by their lowest vertex (`mesh.canonicalMesh`). manifold3d orders
output triangles by the original ids of the meshes they came from, and those
ids are allocated in construction order, so a warm incremental run and a cold
run of the same parameters agreed on every coordinate and every triangle but
not on their order. Now they are the same bytes (`parity.test.ts`), which is
what lets a region hash stand for its mesh. Cost: 47 ms across the seven
meshes of a Chicago build.

### 3.10 Files touched outside `lib/engine/**`

`lib/transform.ts:recommend_plate_mm` builds its plate candidates as a
Proxy view over the params instead of a spread copy; no number changes and
`lib/transform.test.ts` (the TS/Python parity fixture) is green, so
`app/geom/transform.py` needs no mirror. `solid/lettering.ts` and
`solid/context.ts:withEngravings` do the same for the edge-line layout. Both
exist because a spread copy reads every leaf of the params, which the strict
Proxy would count as a dependency of the caller on all of them.
`e2e/perf.spec.ts` asserts the stage rows instead of the retired `solid.*`
names (section 8). `lib/perf.ts` was not touched.

## 4. Measurements (Chicago fixture, Node, this host)

Per stage, one cold full run through a Node-side `PipelineClient` on the
inline transport (the same `PipelineSession` the worker runs), and the same
numbers from `FRAMECRAFT_PERF=1 npm run export:cli` (which prints this table).
Total 7.0 s to `done`, 2.5 s to the last `region-ready`.

| stage | ms |
|---|---|
| repair-buildings | 117 |
| surface-water | 4 |
| surface-roads | 620 |
| surface-parks | 206 |
| buildings | 19 |
| fonts | 18 |
| lettering | 2 |
| attribution | 102 |
| base | 4 (lazy: the carve is evaluated by `sit`) |
| sit | 330 |
| finish-base | 369 |
| finish-frame | 78 |
| finish-buildings | 305 |
| finish-roads | 280 |
| finish-water | 14 |
| finish-parks | 113 |
| assembly | 725 |
| merged | 3205 |
| measure | 641 |
| validate | 1 |
| islands | 3 |
| audit | 6 |
| every other stage | under 1 |

Wall time from request to the last `region-ready` (the preview) and to
`done`, warm cache, after each single change from the default with one
frame-edge `{city}` line (the app's own default; the fixture file has no
engraving, so "a lettering string moved" needs one to move):

| change | to preview | to done | stages that re-ran | target |
|---|---|---|---|---|
| `engravings[0].text` | 118 ms | 4.6 s | lettering, ornaments, frame-cutters, frame, region-frame, finish-frame (83), region-lettering, then the audit phase | 400 ms, met |
| `north_arrow.enabled` | 75 ms | 4.6 s | lettering, ornaments, frame-cutters, frame, finish-frame (67), audit phase | 400 ms, met |
| `frame_style.profile` (plain to chamfer) | 355 ms | 5.0 s | lettering, ornaments, attribution (110), frame-cutters, frame, finish-frame (227), audit phase | 400 ms, met |
| `colour.region_colors.buildings` | 312 ms | 4.7 s | buildings (22), region and finish of buildings (287) and of every band, audit phase | 400 ms, met |
| `hanger` (none to keyhole) | 210 ms | 4.7 s | lettering, attribution (112), hangers, frame, finish-frame (73), audit phase | 400 ms, met |
| `road_mode` | 2053 ms | 6.6 s | surface-roads (715), surface-parks (191), bridges, trees, hangers, frame-cutters, base, sit (340), finish-base (415), finish-roads (308), finish-water, finish-parks (64), audit phase | 2 s, missed by 53 ms |
| `plate_mm` | 2937 ms | 5.3 s | everything under `context` (48 stages): the geometry phase is 1.2 s, the finishes 1.7 s | 2 s, missed |
| `heights.floor_height_m` (Overpass path) | 3983 ms | 10.3 s | normalise (605) from the cached response, no fetch, then everything | 2 s, missed |

The region phase is dominated by `finish-base`, not by `merged`: `merged`
is in the audit phase, after the preview. The split the inventory could not
make, from the `finish.prune` and `finish.mesh` spans and the four rows under
`toRegionMesh`: over the six regions, `pruneDebrisCounted` is 114 ms and the
mesh extraction 883 ms; of the extraction, `getMesh` is 6 ms, the double
read-out 83 ms, the canonical order 47 ms and `cleanMesh` (the repair
ladder) the rest. `merged` is 2.4 ms of prune and 3174 ms of extraction, all
of it `cleanMesh` on a welded solid that carries seam slivers. `sit` costs
330 ms because `boundingBox()` is the first call that evaluates the base's
lazy boolean. `pruneDebrisCounted` folds the old `pruneDebris` and
`countBodies` into one decomposition per region. The three misses are the
same lever: the repair ladder and the base carve; the design's Task 7 is
where it is shortened.

The cold run through the Overpass path (fake `fetch` serving the committed
fixture) is 10.6 s to `done`, 4.4 s to the last region: `normalise` is 735 ms
and `finish-roads` roughly triples (924 ms) because that scene carries the
rail layer and the bridge decks the Python fixture does not.

## 5. Named exceptions (design section 7)

1. Building pick proxies: invisible per-building boxes for raycasting only,
   never rendered (next wave, `BuildingPickProxies`).
2. Recess shading: vertex colours on the declared bands, geometry untouched.
   The engine now emits `recessBands` (lettering engrave and inlay pockets,
   ornaments, underside pockets, per region with `[low, high]` Z) beside
   `attributionBands`.
3. Map overlay and stats use the SceneGraph, not the solids.

Nothing was added to the list. Two contract leaves need a ruling rather than
an exception:

- `colour.region_colors.attribution` is claimed by no stage because no stage
  produces an attribution region solid (the mandatory marks are cuts into the
  base and the frame). `graph.test.ts` lists it beside the seven
  `part_colors.*` leaves as measured, not ruled. Its slot IS read by the
  audit's slot rule.
- `scale_bar.length_m` is read only when `scale_bar.length_mode` is
  `"fixed"`; the sweep's first pass used the non-enum `"manual"` and found
  it dead, which is how the field would look to a user who sets a length
  without the mode.

## 6. Memory

20 warm re-runs alternating two texts on the Chicago fixture (Node,
`--expose-gc`): cache entries 70 throughout, cache handles 313 before and
313 after, `outstandingWasmObjects()` 313 before and 313 after, JS heap
216 MB before and 67 MB after a forced GC, RSS 793 MB before and 705 MB
after. `incremental.test.ts` pins the same invariant on the small scene and
checks the count returns to its starting value when the cache is disposed.

## 7. Tests and gates

`npm run lint` clean, `npm run typecheck` clean, `npm test`: 86 files,
1580 tests passed, 0 skipped, 0 todo (this note's own JSON block is one of
them). One run of the full suite tripped the Chicago hillside build's 15 s
budget at 19.2 s under the parallel workers' load; the file alone passes
(20 of 20) and a second full run passed clean. The budgets are unchanged.
`sh scripts/gate-web-engine.sh make`: ALL CHECKS PASS in both modes (single:
min wall 0.8746 mm, 93,762 triangles; parts: min wall 0.9379 mm, 78,308
triangles). `make contracts` twice: both generated files byte-stable.

Under the build lock: `npm run build` exit 0 (static export, `/` 175 kB,
279 kB first load), then `E2E_BUDGET_FACTOR=3 npx playwright test
e2e/smoke.spec.ts e2e/lettering.spec.ts --project=chromium`: 6 passed in
1.5 min (lettering 17.5 s; smoke happy path 39.0 s, low coverage, the small
and the full Chicago validator round trips at 4.5 s and 20.0 s, the Bambu
per-extruder export). The first Playwright attempt failed the happy path's
warm preset click: the store fired a debounced build 400 ms after the
previous scene arrived, which superseded the Chicago ingest in flight and
left the scene in `loading`. `EngineClient.buildModel` now waits for an
in-flight ingest instead of superseding it (`client.test.ts` pins it); an
ingest still supersedes a build.

## 8. Existing tests rewritten, and what each asserts now

- `lib/engine/protocol.test.ts`: three runs fired while the first is past
  the buildings repair: the first posts `cancelled` and never `done`, the
  second posts nothing at all, the third posts `done` with exactly the stages
  the first completed served as `cached`, in the same order, its regions
  streamed and its `done` result stripped; a queued job cancelled before it
  starts never posts; sequential identical runs are served entirely from the
  cache and a text change re-runs `lettering` but not `buildings`.
- `lib/engine/protocol.terrain.test.ts`: a real small build through the real
  session: a posted grid produces `stats.terrainReliefMm`, no grid does not,
  and with `gate: "param"` the grid is used only when `terrain.enabled`.
- `lib/engine/client.test.ts`: the new wire (`run`, `stage`, `scene-ready`,
  `region-ready`, `done`, `files`, `error`, `cancelled`), no `perf` key on the
  wire with perf off, a second build after an ingest sends a `cached` scene
  key, streamed positions are re-attached to the stripped result, progress is
  routed per job, supersede and late messages, cancel, transport errors,
  dispose; `PipelineClient` streams regions in preview mode and exports files
  afterwards through the inline transport.
- `lib/engine/client.supersede.test.ts`: an ingest requested while a build is
  under way resolves first and the build rejects `cancelled`; the stages the
  superseded build completed are served `cached` to the next build and none
  is run twice.
- `lib/engine/terrain/tiles.test.ts` ("applies params.terrain.smoothing"): the
  fetcher returns the raw grid stamped `smoothing: 0` with identical
  elevations for both settings, and `smoothGrid` on it lowers the relief.
- `lib/engine/export/tiles.test.ts` ("writes exactly the bytes it wrote before
  tiling existed"): the pinned SHA-256 moved once more, for the one
  `framecraft:palette` metadata entry, checked entry by entry on the unzipped
  model; the test now also asserts the entry is present.
- `e2e/perf.spec.ts`: the HUD rows asserted are the stage rows (`context`,
  `repair-buildings`, ..., `merged`, `audit`) and `phase.geometry` instead of
  the retired `solid.*` names.

New: `pipeline/graph.test.ts`, `pipeline/incremental.test.ts`,
`pipeline/parity.test.ts`.

## 9. Perf fixes from the v3-00 audit

- Finding 3: a tiled export writes its tiles through `writeForTarget`, so
  `export.<target>` no longer nests inside itself.
- Finding 4: in perf mode `loadManifold` reads the binary itself
  (`wasm.fetch`, with `wasm.bytes` carrying the size), hands it to emscripten
  through `instantiateWasm` and times `WebAssembly.instantiate` alone
  (`wasm.instantiate`), then `wasm.setup`. With perf off the ordinary
  streaming load runs untouched.
- Finding 6: the worker's marks carry `epochMs` (its `timeOrigin` plus its
  clock) and are rebased on the page; a negative `engine.transfer` hop is
  dropped rather than reported as zero.
- Finding 7: `perf: true` rides on a job message only when perf is on; there
  is no `timings` field with perf off. The wire is byte-identical.
- Finding 14: `FRAMECRAFT_PERF=1 npm run export:cli` prints the stage table
  (the flag is read in `export-cli.ts`, not in `lib/perf.ts`).
- Each stage is a span named by its id, nested under `phase.<name>` and
  `engine.build`; `overpass.fetch`, `osm.normalize`, `export.run`,
  `export.<target>` and `export.bytes` keep their names.

## 10. For the next wave (store and preview)

- `PipelineClient.run({source, params, terrain, heroIds, date, rotationDeg,
  mode, known, knownSceneHash})` returns a handle with `progress` (`plan`
  first, then `stage` events with `index`, `total`, `state` and `elapsedMs`,
  and `phase` events), `regions` (`{regions, removed, hashes}`, positions
  transferred, copied out of the cache first; `removed` names every region
  the model no longer has, whether or not you named it in `known`), `scene`
  and `done` (`{result, regionHashes, scene, elapsedMs, mergedHash,
  tilesHash}`; `result.regions` carry no positions). Pass the map you hold as
  `known` (the hashes from `regions.hashes`) and the worker will not resend
  an unchanged region; pass `knownSceneHash` and it will not resend the
  scene. The client fills `knownMergedHash`/`knownTilesHash` from its own
  last copies and re-attaches the merged mesh and the tile meshes when the
  worker strips them, so `done.result` always carries whole meshes.
- `PipelineClient.exportFiles({target?, stem?, title?, source?, createdIso,
  layerHeightMm?, force?})` waits for a run in flight (it never supersedes
  one), runs the remaining stages on the settled cache and returns
  `{files, sidecar, sidecarName, notes, plan}` with the bytes transferred. It
  rejects with a `PipelineStageError` at stage `export` whose
  `detail.blocking` lists the Stage 4 findings when the printability gate
  failed; `force: true` writes the files anyway.
- The audit's fixes, with the file and line of each and the test that pins
  it, are the "Fixes" section of `v3-01-pipeline-audit.md`.
- `PIPELINE_DEBOUNCE_MS = 80` and the store's `state.pipeline` shape are the
  design's section 5; `elapsedMs` per stage from the previous run is what the
  ETA is computed from (`CacheEntry.elapsedMs` holds it worker-side).
- `EngineResult.recessBands` is on every result, empty for a plate with no
  cuts.
- Per-triangle building identity: the `buildings`, `buildings_band_N` and
  `hero_building` region meshes carry `triangleOwner` (a `Uint32Array`, one
  entry per triangle, transferred with the positions and emptied wherever
  they are) indexing `owners` (the building ids, sorted; a SceneGraph id, or
  `block-<n>` for a merged block). `NO_OWNER` (`types.ts`) marks a triangle
  nothing could be attributed to; Chicago has none. The `buildings` stage
  records each extrusion's manifold original id (`BuiltBuildings.ownerIds`)
  and the finish stages read the ids back off the union's triangle runs by
  geometry (`solid/owners.ts`, about 10 ms on Chicago's 19 000-triangle
  region, the `finish.owners` perf row). The identity is a pure function of
  the finish's inputs, so the region hash covers it: a hero promotion or a
  band change moves the hash, a colour change re-finishes to the same owners.
- Perf mode: the events that end a run (`done`, `files`, `cancelled`,
  `error`) are posted after the `engine.build` span closes, so a run's own
  row is on the message `worker.ts` drains the buffer onto, for the first run
  and the last (`protocol.perfStampedPost`; the v3-01 integration note's
  repro and `e2e/perf.spec.ts`).

## 11. Lines for DECISIONS.md (the orchestrator appends; this agent does not edit it)

- [V3.1-P1-5] Stage keys hash content digests, not keys, for data-only
  outputs, and pin an input's generation only when the output references its
  handles; `base` is keyed on named part digests (`lettering#base`,
  `ornaments#base`, `attribution#base`, `hangers#base`,
  `frame-cutters#base`, `buildings#socket`) that are content hashes of the
  cutter meshes. Reason: without them a frame-edge text change re-carved and
  re-finished the plate (1.15 s to the preview against the 400 ms target);
  with them it is 118 ms. The mechanism is exact (same mesh, same solid) and
  the alias rule keeps the one-generation cache safe.
- [V3.1-P1-6] `toRegionMesh` writes every mesh in canonical order (vertices
  by coordinate, triangles by lowest vertex). Reason: manifold3d orders output
  triangles by original mesh id, which depends on allocation history, so a
  warm incremental run and a cold run of the same parameters differed in byte
  order; now they are byte-identical and a region hash stands for its mesh.
- [V3.1-P1-7] `surface-parks` repairs the parks layer, merges the base
  ridges and extrudes all four surface layers; `surface-water`, `-rail` and
  `-roads` are the repaired footprints only. Reason: the ridge merge's sink is
  the last recessed layer that was built, known only after every layer's
  repair; extrusion is milliseconds, the repairs are the cost.
- [V3.1-P1-8] `lettering` does not depend on `attribution` (the underside
  reserve is a pure layout both compute), so the registry order and the
  resolved-text order stay lettering, ornaments, attribution.
- [V3.1-P1-9] `fetchTerrainGrid` returns the raw grid stamped
  `TerrainGrid.smoothing = 0`; the `terrain` stage applies
  `terrain.smoothing` and gates on `terrain.enabled` (a grid passed to
  `buildModel()` or the CLI is authoritative). Reason: the two leaves are
  claimed by a worker stage and applied once, and a smoothing change becomes a
  stage re-run rather than a refetch.
- [V3.1-P1-10] `context` claims `frame_style.profile` as a keyed claim
  (floating or not). Reason: the crop inset depends only on whether the frame
  is floating; keying on the profile string would rebuild the whole model for
  a plain-to-chamfer change.
- [V3.1-P1-11] `colour.region_colors.attribution` is claimed by no stage:
  no stage produces an attribution region solid (the marks are cuts). Either
  a later task gives the field a solid to colour or it joins the matrix
  exemptions; the graph test lists it as measured, not ruled.
- [V3.1-P1-12] The run modes are `scene`, `preview`, `full` and `export`;
  `scene` exists for the compat `EngineClient.ingest` and never loads the
  WASM kernel. The `rotation` extra carries the SceneRequest's rotation to the
  lettering, because a `buildModel()` call has no SceneRequest.
- [V3.1-P1-13] A failing export ships nothing. The export stage reads
  `validate`'s findings and refuses, by finding id, when any Stage 4 row
  (`not-manifold`, `floating-island`, `exceeds-plate`, `exceeds-height`,
  `wall-too-thin`) is at `error`; the refusal is a `PipelineStageError` at
  stage `export` whose `detail.blocking` lists the findings, and no `files`
  event is posted. `ExportRequest.force` (CLI `--force`) writes the files
  anyway for debugging, with the findings still in the sidecar. Warnings never
  block.
- [V3.1-P1-14] A stage's content digest covers its channels (findings,
  resolved text, mark bands) as well as its output, and `region-ready` names
  every region the model lacks in `removed` and carries each region's hash in
  `hashes`. Reason: the audit's two blockers; a data-only stage whose only
  change was what it reported served stale findings, and a band streamed by a
  superseded run outlived the model.
- [V3.1-P1-15] An export queued behind a run waits for it instead of
  aborting it, streams no regions and posts `done` with `result: null`; a
  run's `done` carries `mergedHash` and `tilesHash` and strips the merged
  mesh and the tile meshes the caller already holds. Reason: the export path
  used to fight the run it needed, and every settle moved 2.2 MB (8.1 MB with
  tiling) across the worker boundary.
- [V3.1-P1-16] Building identity rides on the region mesh: the `buildings`
  stage gives every building solid its own manifold original id and keeps the
  id-to-building map in its output; the building finish stages attribute
  every shipped triangle to a building by geometry against the union's
  triangle runs and ship `RegionMesh.triangleOwner` / `owners`. Reason: the
  preview's per-building tints and the picking of Tasks 10 and 11 read the
  real solids instead of proxies, and the mesh repairs (`cleanMesh`,
  `canonicalMesh`) may reorder, weld or split triangles, so index bookkeeping
  through them would be fragile where a centroid lookup is exact.

