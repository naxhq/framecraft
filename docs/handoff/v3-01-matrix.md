# v3-01 matrix (the V3-1 acceptance matrix)

Written by the matrix test agent against `docs/handoff/v3-01-pipeline-design.md`
section 6 and `docs/handoff/v3-01-pipeline.md` sections 3.6, 5 and 10. Every
number below was produced by running the code in this tree.

Gate V3-1 has two halves. `lib/engine/pipeline/graph.test.ts` already proves the
first: every `PrintParams` leaf is CLAIMED by a pipeline stage. This file proves
the second: every leaf DOES something, in the preview and in the written file.

## 1. What landed

```
apps/web/lib/engine/pipeline/
  matrix.assert.ts               readers over an EngineResult and over the bytes
                                 the export stage wrote (3MF parts, project
                                 settings, metadata, STL, OBJ, STEP, sidecar)
  matrix.run.ts                  MatrixGroup: one scene plus one `base`, its
                                 warm StageCache, its `before` snapshot
  matrix.probes.ts               the probe table (124 probes), the exemptions,
                                 the known defects
  matrix.test.ts                 coverage, the probes, the export_target sweep,
                                 the exemptions
  fixtures/overpassBlock.ts      the Overpass-shaped fixture the `heights.*`
                                 probes enter the pipeline through, one 46 m
                                 square per height rule at a known plan position
```

`testScenes.ts` was not changed: `block`, `rail`, `bridge` and `terrain` carry
everything the matrix needs except an untagged building, and that belongs in an
Overpass response rather than a finished `SceneGraph` (section 4).

**How a probe runs.** `before` is the default parameters plus the probe's
`base`; `after` is the same with one leaf written. Both go through
`runPipeline` in `mode: "export"`, so one run yields the `EngineResult` the
preview draws AND the files the export stage wrote. Probes that share a scene
and a `base` share one `before` build and one warm `StageCache`, which is what
keeps the file inside its budget: an `after` run re-runs only what the changed
leaf invalidates, and `parity.test.ts` is the standing proof that a warm run and
a cold one agree byte for byte. Region meshes are plain typed arrays extracted
from the kernel, so a `before` snapshot stays valid after the cache moves on.

**Two things the runner had to do.**

1. A probe may set `forceExport: true`, and exactly two do. The export gate
   (`lib/engine/export/gate.ts`) refuses a file whose model failed a Stage 4 row,
   and two probes trip one on purpose: `large_scale` at 2.0 and
   `custom_profile.max_height_mm` at 20 both break the height ceiling, which is
   the effect being probed. Those two force, each with the row named beside the
   flag; the other 122 probes, the `export_target` sweep and the exemption checks
   all export through the gate the product ships, so a change that starts
   producing a floating island or a wall under the minimum fails the matrix
   instead of being written and asserted as if nothing happened. Every flag was
   checked by running its probe unforced: a third candidate,
   `bridges.abutments`, turned out to raise its loose deck at `warning`
   severity, so the gate lets it through and the flag came off.
2. `base` merges into the defaults key by key rather than replacing whole
   groups, so a base that sets `colour.tint.enabled` keeps the default region
   colours.

**What the file side reads.** For the default target the assertions go through
the Bambu project's own two documents: `3D/Objects/object_1.model` carries the
meshes and `Metadata/model_settings.config` names each part and its extruder, so
`matrix.assert.ts` can hand a probe a per-region row with the vertex count, the
triangle count, the extruder, the bounding box and the volume the file's own
triangles enclose (a divergence sum over the parsed soup, never copied off the
`EngineResult`). That last number is what lets a probe assert a change of SHAPE
at an unchanged triangle count: a wider magnet pocket, a deeper engraving, a
wider shadow gap.

Four readers do the rest of the geometric work. `ringAt` reads a rectangular
ring at one height, measured from the plate centre, which is the shape a shadow
gap, a sight-edge rebate and a frame lip all have; `maxXPlusY` reads how far the
outer corner stands out along its diagonal, which a corner fillet pulls back by
exactly `r * (2 - sqrt(2))`; `maxZOverFootprint` reads the roof over ONE plan
square, which is what separates the eight `heights.*` rules from each other; and
`extentAtZ` with a plan window reads the glyph pockets of ONE frame edge. Each
works on raw positions, so the same call answers for the `EngineResult` and for
the written file, with `buildOffset` reading the frame shift out of the base
region and the base part of the same snapshot rather than assuming it. A tiled
build is read the same way: `zipEntry` pulls one tile's own 3MF out of the zip
and `bambuPartsOf` parses it, so no assertion anywhere compares a byte length.

## 2. The probe table

`base` names a constant in `matrix.probes.ts`. The scene is `block` unless
another is named. "preview" is read off the `EngineResult`, "file" off the bytes
the export stage wrote (the Bambu project unless the base names another target).

### Plate, base, nozzle, scale

| leaf | base | value | preview | file |
|---|---|---|---|---|
| `plate_mm` | | 220 | base bbox x span 180 to 220, scale denominator falls | base part bbox x span 180 to 220, sidecar `width_mm` 220 |
| `base_thickness_mm` | | 5 | base bbox z span 3 to 5, roads lifted 2 mm | base part z span 5, part volume up, sidecar `height_mm` +2 |
| `nozzle_mm` | | 0.8 | `minWallMm` 0.8 to 1.6, base triangles fall, parks (trees) volume up | base part triangles fall, parks part volume up, sidecar `min_wall_mm` 1.6 |
| `small_scale` | | 1.5 | buildings volume +10 % at an unchanged roof height | buildings part volume +10 %, sidecar region row agrees |
| `large_scale` | | 2.0 | `heightMm` x1.7 or more, `exceeds-height` raised | buildings part roof x1.7, sidecar warning "too tall to print" |
| `terrain_exaggeration` | `TERRAIN_ON`, terrain | 2.5 | `terrainReliefMm` more than doubles, base bbox top doubles | base part bbox top doubles, part volume +50 % |
| `road_mode` | | `"off"` | roads region absent, base volume up | roads part absent, sidecar region table loses roads |
| `road_scale` | | 2.0 | roads y span x1.8 to x2.05, volume +80 % | roads part y span and volume the same way |
| `trees` | | false | `stats.trees` 3 to absent, parks triangles quartered, parks top drops | parks part triangles quartered, part top drops |
| `water` | | false | water region absent, base volume up | water part absent, slot 3 falls back off `#2F7FC1` |
| `frame` | | false | frame region absent, `attribution-frame-wall` cuts to skipped, scale denominator falls | frame part absent, one fewer attribution band in the sidecar |

### Lettering

Base `LETTERING`: one top-edge engraving `{city}` at 4 mm, `city_label`
"Blockton". `INLAY` is the same line in inlay mode at 5 mm.

| leaf | base | value | preview | file |
|---|---|---|---|---|
| `city_label` | `LETTERING` | "Riverside" | `resolvedText` engraving-0 Blockton to Riverside, frame triangles move | file name `blockton.3mf` to `riverside.3mf`, 3MF `Title` follows |
| `engravings[].text` | `LETTERING` | "ZZZ" | resolved text ZZZ, frame triangles fall | frame part triangles fall, sidecar region row agrees |
| `engravings[].edge` | `LETTERING` | `"bottom"` | surface "top edge" to "bottom edge", pocket floors move from y +85 to y -85 | same move in the file's own vertices, triangle count unchanged |
| `engravings[].align` | `LETTERING` | `"end"` | pocket floor x span slides from the centre to x +66, same width | same slide in the file, same width |
| `engravings[].mode` | `LETTERING` | `"inlay"` | a `lettering` region appears with 7 bodies | a `lettering` part appears on extruder 4 |
| `engravings[].size_mm` | `LETTERING` | 7 | reported cap height 4 to above 6, frame volume falls | frame part volume falls, triangles move |
| `engravings[].depth_mm` | `LETTERING` | 1.0 | recess band floor 4.6 to 4.0, reported depth 1.0 | frame part volume falls by more than 5 mm3 at an unchanged triangle count |
| `engravings[].font` | `LETTERING` | `"serif"` | same string and cap height, top pocket span 15.93 to 16.07 mm, frame triangles rise | the same span in the file, frame part triangles rise |

### Ornaments and the underside mark

Base `ORNAMENTS`: north arrow on at 6 mm in the north-east corner, scale bar on
at the bottom edge fixed at 40 m, underside mark on.

| leaf | base | value | preview | file |
|---|---|---|---|---|
| `north_arrow.enabled` | `ORNAMENTS` | false | "north arrow" line gone, one fewer ornament recess band | frame part triangles fall, volume rises |
| `north_arrow.corner` | `ORNAMENTS` | `"sw"` | ornament pocket floor moves from x +88 to x -88 | same move in the file's vertices |
| `north_arrow.size_mm` | `ORNAMENTS` | 2 | reported arrow length above 4 to exactly 2, pocket narrows | frame part volume rises, pocket narrows in the file |
| `scale_bar.enabled` | `ORNAMENTS` | false | "scale bar (40 m)" line gone, frame triangles fall | frame part loses more than 300 triangles, volume rises |
| `scale_bar.edge` | `ORNAMENTS` | `"top"` | ornament pocket floor moves from y -85 to y +85 | same move in the file |
| `scale_bar.length_mode` | `ORNAMENTS` | `"auto"` | label "40 m" to "50 m", frame triangles rise | frame part triangles rise, volume falls |
| `scale_bar.length_m` | `ORNAMENTS` | 90 | label "40 m" to "90 m", frame triangles rise | frame part triangles rise, volume falls |
| `underside_mark.enabled` | `ORNAMENTS` | false | "underside-mark" line gone, base loses 2000+ triangles | base part loses 2000+ triangles, volume rises |
| `underside_mark.template` | `ORNAMENTS` | `"{city}"` | mark text "Blockton 1:2,381 2026-09-02" to "Blockton" | base part triangles fall, volume rises |

`scale_bar.length_m` is probed with `length_mode: "fixed"` in the base, per
`DECISIONS.md` `[V3.1-P1-13]`. The fixed length is also inside the 15 to 40 mm
printed window at this scale, which is why 40 m and 90 m both survive: a value
outside it is silently replaced by the auto length and the field would look dead.

### Hanger, heroes, place

| leaf | base | value | preview | file |
|---|---|---|---|---|
| `hanger` | `THICK` | `"cleat"` | a `cleat` region appears, base volume falls, underside recess bands appear | a `cleat` part appears in the project and in the sidecar region table |
| `hero_building_ids` | | `["b-tall"]` | `hero_building` region appears with 1 body, buildings falls from 3 bodies to 2 | hero part appears, buildings part volume falls |
| `hero_mode` | `HERO_SHORT` | `"own_color"` | hero roof over the plate 30.24 to 18.14 mm (exactly 0.6, the class multiplier the hero rule was holding off) AND slot 2 to 4, colour to `#E3A72F` | hero part roof falls by the same 0.6, extruder 2 to 4, slot 4 filament `#E3A72F` |
| `hero_auto.enabled` | | true | buildings region gone, `hero_building` carries all 3 bodies | buildings part gone from the project and the sidecar |
| `hero_auto.count` | `HERO_AUTO` | 1 | heroes 3 bodies to 1, buildings returns with 2 | hero part volume falls, buildings part returns |
| `place.country` | `PLACE` | "Farland" | engraving-0 "Landia Provo" to "Farland Provo", top pocket span +1.61 mm, bottom unchanged | the same span move in the file, frame part triangles rise |
| `place.state` | `PLACE` | "Westia" | engraving-0 to "Landia Westia", top pocket span +1.70 mm, bottom unchanged | the same span move in the file |
| `place.neighbourhood` | `PLACE` | "Uptown" | engraving-1 "Docks Tess" to "Uptown Tess", BOTTOM pocket span +2.90 mm, top unchanged | the same span move in the file |
| `place.author` | `PLACE` | "Bee" | engraving-1 to "Docks Bee", bottom pocket span narrows, top unchanged | 3MF `Designer` Tess to Bee, sidecar `provenance.author` follows, bottom span narrows |

### Region placement

| leaf | base | value | preview | file |
|---|---|---|---|---|
| `regions.roads.depth_mm` | | 1.5 | roads floor drops 0.5 mm+, volume x1.5, base volume falls | roads part floor and volume the same way |
| `regions.roads.proud_mm` | | 0.5 | roads top rises 0.7 mm above the plate, `road-placement-conflict` raised | roads part top rises 0.7 mm, sidecar warning "stand proud" |
| `regions.water.depth_mm` | | 0.5 | water z span 0.4 mm thinner, volume x0.7, base volume rises | water part z span and volume the same way |
| `regions.water.proud_mm` | | 0.3 | water floor and top both rise 0.8 mm at an unchanged volume | water part floor and top both rise 0.8 mm |
| `regions.parks.depth_mm` | | 1.5 | parks floor drops 1 mm+, volume doubles, base volume falls | parks part floor and volume the same way |
| `regions.parks.proud_mm` | | 0.8 | parks volume x1.4, triangles rise, `region-placement-clamped` raised | parks part triangles rise, sidecar warning "parks region does not fit" |
| `regions.rail.depth_mm` | rail | 1.2 | rail floor drops 0.5 mm+, volume doubles | rail part floor and volume the same way |
| `regions.rail.proud_mm` | rail | -0.5 | rail floor and top both drop 0.8 mm at an unchanged volume | rail part floor and top both drop 0.8 mm |
| `regions.rail.width_m` | rail | 3 | **DEFECT 1**, see section 5: the printed groove must NARROW by exactly (3 - 6) ground metres | the same in the file |
| `regions.building_skirt_mm` | | 1.5 | buildings foot drops 1 mm+ into the plate, volume rises | buildings part foot and volume the same way |

### Colour

`colour.region_slots.<region>` is probed for all eleven regions and
`colour.region_colors.<region>` for ten (the eleventh is exempt, section 4). Each
slot probe asserts the region's `slot` on the preview and that part's `extruder`
in `model_settings.config` plus the slot in the sidecar's region table, at an
unchanged triangle count. Each colour probe asserts the region's `colorHex` and
the sidecar's region row, and, where the region is the first one on its slot,
the filament colour `project_settings.config` loads into that slot.

| leaf | base | value | note |
|---|---|---|---|
| `colour.region_slots.base` | | 3 | slot 1 filament follows |
| `colour.region_slots.frame` | | 4 | |
| `colour.region_slots.matting` | `MATTING` | 3 | |
| `colour.region_slots.buildings` | | 3 | slot 2 filament follows |
| `colour.region_slots.hero_building` | `HERO_OWN` | 3 | |
| `colour.region_slots.roads` | | 2 | |
| `colour.region_slots.water` | | 2 | |
| `colour.region_slots.parks` | | 2 | |
| `colour.region_slots.rail` | rail | 2 | |
| `colour.region_slots.lettering` | `INLAY` | 2 | |
| `colour.region_slots.attribution` | `SLOT_OVERRUN` | 6 | see below |
| `colour.region_colors.base` | | `#112233` | slot 1 filament |
| `colour.region_colors.frame` | | `#445566` | |
| `colour.region_colors.matting` | `MATTING` | `#334455` | |
| `colour.region_colors.buildings` | | `#778899` | slot 2 filament |
| `colour.region_colors.hero_building` | `HERO_OWN` | `#667788` | slot 4 filament |
| `colour.region_colors.roads` | | `#AABBCC` | slot 4 filament |
| `colour.region_colors.water` | | `#DDEEFF` | slot 3 filament |
| `colour.region_colors.parks` | | `#102030` | |
| `colour.region_colors.rail` | rail | `#203040` | |
| `colour.region_colors.lettering` | `INLAY` | `#556677` | |

`colour.region_slots.attribution` needed a base that makes the audit's slot rule
fire (`SLOT_OVERRUN` parks the parks region on slot 9, which the 4-slot custom
profile cannot reach). No stage builds an attribution solid, so the ONLY place
this leaf is read is the `slot-beyond-profile` finding's one-click fix, which
restates the whole slot table; the probe reads the attribution entry of that
patch, on the `EngineResult` and again out of the sidecar's `findings` block.
That is a thin effect for a settings leaf and it is worth a ruling of its own
(section 6), but it is a real, field-specific, file-visible one, so the leaf is
probed rather than exempt.

| leaf | base | value | preview | file |
|---|---|---|---|---|
| `colour.palette` | | "dusk" | echoed on `result.params.colour.palette` | 3MF `framecraft:palette` default to dusk, sidecar `colour_palette` |
| `colour.tint.enabled` | `TINT_OBJ` | false | `buildingTints` 3 entries to none | MTL loses `buildings_tint_1`, gains a plain `buildings` material |
| `colour.tint.hue_range_deg` | `TINT_OBJ` | 90 | the three tint hexes all move | same material names, different `Kd` rows in the MTL |
| `colour.tint.lightness_range` | `TINT_OBJ` | 0.5 | the three tint hexes all move | same |
| `colour.tint.seed` | `TINT_OBJ` | 9 | the three tint hexes all move | same |
| `colour.gradient.enabled` | | true | `gradientBands` absent to 2, `buildings_band_2` appears on slot 3 | `buildings_band_2` part on extruder 3, buildings part volume falls |
| `colour.gradient.slots` | `GRADIENT` | `[2,3,4,1]` | `gradientBands` 2 to 3, `buildings_band_3` appears on slot 4 | `buildings_band_3` part on extruder 4 |

The tint probes need `export_target: "obj"` and `color_mode: "parts"`: a tint is
a shade of one filament and the print path ignores it by design, and OBJ in
parts mode is the one writer that turns it into per-building materials.

### Printer and export

| leaf | base | value | preview | file |
|---|---|---|---|---|
| `printer_profile` | | `"prusa-mini"` | `slot-beyond-profile` raised naming "Prusa MINI addresses 1 slot" | `printer_settings_id` and `printable_area` change, sidecar `printer_profile` |
| `custom_profile.plate_x_mm` | | 120 | `exceeds-profile-plate` raised naming a 120 x 256 mm bed | `printable_area` first column 256 to 120 |
| `custom_profile.plate_y_mm` | | 120 | `exceeds-profile-plate` raised naming a 256 x 120 mm bed | `printable_area` second column 256 to 120 |
| `custom_profile.max_height_mm` | | 20 | `exceeds-height` raised naming a 20 mm ceiling | sidecar `max_height_mm` 60 to 20, `printable_height` 20 |
| `custom_profile.nozzle_mm` | | 0.8 | echoed on `result.params.custom_profile.nozzle_mm` | `nozzle_diameter`, `printer_variant` and `printer_settings_id` all say 0.8 |
| `custom_profile.slots` | `SLOT_SIX` | 8 | `slot-beyond-profile` on the parks region is raised at 4 slots and gone at 8 | `filament_colour`, `filament_type` and `filament_settings_id` all 6 entries to 8 |
| `custom_profile.change_gcode` | `COLORCHANGE` | "M601" | echoed on `result.params.custom_profile.change_gcode` | `change_filament_gcode` M600 to M601, and every `custom_gcode_per_layer.xml` row carries it |
| `color_mode` | `GENERIC` | `"parts"` | echoed on `result.params.color_mode` | generic 3MF 1 object to 7, `<basematerials>` gains a `water` entry |
| `export_target` | | `"stl"` | echoed on `result.params.export_target` | `framecraft.3mf` to `framecraft.stl`, sidecar `export_target` |

Five leaves (`colour.palette`, `custom_profile.nozzle_mm`,
`custom_profile.change_gcode`, `color_mode`, `export_target`) have no geometric
effect by design: they say what to WRITE, not what to build, and
`DECISIONS.md` `[V3.1-P1-2]` says so of the palette in as many words. Their
preview assertion names the echoed leaf on `EngineResult.params`, which is the
object the export stage and the share link read, and their file assertion is the
load-bearing half. Those five are the whole of the matrix's remaining WEAK
preview column, and they are stated here so nobody reads them as weaker versions
of the others.

`export_target` additionally has its own sweep (`matrix.test.ts`, "writes a
different file set for every one of its seven values"): all seven values are
built, each is asserted to write exactly its own file names, each is asserted to
carry the part a reader of that format looks for (`model_settings.config` for the
Bambu project and its absence for the generic one, a triangle count for the STL,
`CREDITS.txt` in the parts zip, the `ISO-10303-21` header for STEP,
`custom_gcode_per_layer.xml` for the colour-change project), and no two targets
may write the same file set.

### Terrain, heights, bridges, exaggeration

| leaf | base | value | preview | file |
|---|---|---|---|---|
| `terrain.enabled` | terrain | true | `terrainReliefMm` absent to above 5, base top rises 5 mm+ | base part triangles rise, bbox top rises 5 mm+ |
| `terrain.smoothing` | `TERRAIN_ON`, terrain | 6 | relief falls, base top falls | base part top and volume fall |
| `heights.floor_height_m` | osm | 8 | the roof over the THREE-STOREY square rises by 3 x (8 - 3) ground metres times the scale; the control square does not move | the same roof, read from the written 3MF |
| `heights.unknown_default_m` | osm | 40 | the roof over the untagged square rises by the metres the leaf moved; the control square does not move | the same roof in the file |
| `heights.type_defaults.house` | osm | 40 | the roof over the `building=house` square rises by the metres the leaf moved; the control square does not move | the same roof in the file |
| `heights.type_defaults.apartments` | osm | 45 | the roof over the `building=apartments` square rises by the metres the leaf moved; the control square does not move | the same roof in the file |
| `heights.type_defaults.commercial` | osm | 50 | the roof over the `building=commercial` square rises by the metres the leaf moved; the control square does not move | the same roof in the file |
| `heights.type_defaults.retail` | osm | 55 | the roof over the `building=retail` square rises by the metres the leaf moved; the control square does not move | the same roof in the file |
| `heights.type_defaults.industrial` | osm | 60 | the roof over the `building=industrial` square rises by the metres the leaf moved; the control square does not move | the same roof in the file |
| `heights.type_defaults.garage` | osm | 35 | the roof over the `building=garage` square rises by the metres the leaf moved; the control square does not move | the same roof in the file |
| `bridges.enabled` | bridge | false | `stats.bridges` 1 to absent, roads top drops below the deck | roads part top drops below 3.5 mm, triangles fall |
| `bridges.clearance_mm` | bridge | 3.0 | roads top rises exactly 2 mm at an unchanged volume shape | roads part top rises 2 mm at an unchanged triangle count |
| `bridges.abutments` | bridge | false | roads triangles fall, `bridge-unsupported` raised | roads part triangles fall, sidecar carries the finding's own words "have nothing holding them up" and "Abutments are switched off" |
| `height_exaggeration.multiplier` | | 1.8 | the buildings' roof height ABOVE THE PLATE is multiplied by 1.8, footprint unchanged | same in the file's own part bbox |
| `height_exaggeration.curve` | | 0.8 | model height falls 3 mm+, buildings volume rises | buildings part roof falls 3 mm+, sidecar `height_mm` falls |

The eight `heights.*` probes run from `fixtures/overpassBlock.ts` through
`fetch` and `normalise`, because `heights.*` is read by `normalise` and by
nothing else: a finished `SceneGraph` already carries the heights the rules
decided. Each height probe also pins that the building COUNT is unchanged, so a
height change is not being read off a scene that gained or lost a body.

### Tiling

Base `TILED`: 2 x 2 dovetail tiles, 0.15 mm tolerance, index marks on.

| leaf | base | value | preview | file |
|---|---|---|---|---|
| `tiling.enabled` | `TILED` | false | `result.tiles` 4 to none, `stats.tiles` gone | `framecraft-tiles.zip` to `framecraft.3mf` |
| `tiling.cols` | `TILED` | 3 | `tileCols` 2 to 3, a "C1" tile appears, tile 0 narrows | the zip gains `framecraft-C1.3mf`, sidecar warning says 6 tiles |
| `tiling.rows` | `TILED` | 3 | `tileRows` 2 to 3, an "A3" tile appears | the zip gains `framecraft-A3.3mf`, sidecar warning says 6 tiles |
| `tiling.joint` | `TILED` | `"pin"` | tile A1's base gains triangles and changes volume | tile A1's OWN 3MF, unzipped: its base part gains triangles and changes volume |
| `tiling.tolerance_mm` | `TILED` | 0.6 | tiles A1 and B1 both lose base volume | the same two tiles' own 3MFs lose base volume |
| `tiling.index_mark` | `TILED` | false | all four tiles lose base triangles | all four tiles' own 3MFs lose base triangles |

The three joint leaves act inside each tile's own mesh, not on the tile grid, so
the preview assertions read `result.tiles[i].regions` rather than
`result.regions`, and the file assertion is the zip's byte length at an
unchanged entry list. That is the weakest file assertion in the table: the tile
files are nested 3MFs inside a zip, and unpacking a tile's own model to count
its dovetails would duplicate `solid/tiling.test.ts`, which already does it.

### Frame style and frame magnets

| leaf | base | value | preview | file |
|---|---|---|---|---|
| `frame_style.profile` | | `"chamfer"` | frame triangles rise, volume falls, z span unchanged | frame part the same way |
| `frame_style.corner` | | `"rounded"` | the outer corner is pulled back along its diagonal by exactly 3 x (2 - sqrt2) = 1.7574 mm, at an unchanged volume | the same pull-back in the file |
| `frame_style.corner_radius_mm` | `ROUNDED` | 9 | a further 6 x (2 - sqrt2) = 3.5147 mm of diagonal pull-back, at an unchanged volume | the same pull-back in the file |
| `frame_style.lip_depth_mm` | | 1.5 | **DEFECT 2**, see section 5: a 1.0 mm wide rebate floor must move from 0.4 to 1.5 mm under the lip top | the same rebate floor in the file |
| `frame_style.shadow_gap.enabled` | | true | base triangles rise, base volume falls by 300 mm3+ | base part the same way |
| `frame_style.shadow_gap.width_mm` | `SHADOW` | 2.5 | the channel ring's outer edge is unchanged and its inner edge moves in by exactly 1.5 mm, at the same floor z | the same ring in the file |
| `frame_style.shadow_gap.depth_mm` | `SHADOW` | 2.0 | the channel floor moves from 0.8 to 2.0 mm under the plate top and stays exactly 1.0 mm wide | the same floor in the file |
| `frame_style.matting.enabled` | | true | a `matting` region appears | a `matting` part appears in the project and the sidecar |
| `frame_style.matting.width_mm` | `MATTING` | 12 | matting volume x1.7, the roads under it are cropped narrower | matting part volume and roads part x span the same way |
| `frame_style.matting.proud_mm` | `MATTING` | 1.2 | matting top rises 0.8 mm, volume doubles | matting part top and volume the same way |
| `frame_style.separate.enabled` | | true | base gains 10000+ triangles and a mating step, frame lifts off the plate | base part gains 10000+ triangles, frame part triangles fall |
| `frame_style.separate.mount` | `SEPARATE` | `"magnet"` | frame gains 400+ triangles (discrete pockets, not one rib), base top falls | frame part gains 400+ triangles, base part top falls |
| `frame_style.separate.tolerance_mm` | `SEPARATE` | 0.6 | frame underside rises 0.4 mm, volume falls | frame part underside rises 0.4 mm, volume falls |
| `frame_style.texture.pattern` | `TEXTURE_OFF` | `"knurl"` | frame triangles x1.4+, volume falls | frame part the same way |
| `frame_style.texture.scale_mm` | `TEXTURE_ON` | 5.0 | frame triangles fall (coarser cells), volume rises | frame part the same way |
| `frame_style.texture.depth_mm` | `TEXTURE_ON` | 0.45 | frame volume falls by 100 mm3+ | frame part volume falls by 100 mm3+ |
| `hanger_magnet.diameter_mm` | `SEPARATE_MAGNET` | 4 | frame and plate each lose 45.31 mm3, the analytic bore delta for eight pockets, at an unchanged triangle count | the frame part loses the same 45.31 mm3 |
| `hanger_magnet.thickness_mm` | `SEPARATE_MAGNET` | 1 | frame gains 10 mm3+ at an unchanged triangle count | frame part the same way |
| `hanger_magnet.count` | `SEPARATE_MAGNET` | 4 | frame triangles x1.8+, base triangles rise | frame and base parts the same way |

`TEXTURE_OFF` and `TEXTURE_ON` carry `plate_mm: 120` and `scale_mm: 2.5`. The
knurl cutter costs by frame perimeter times pattern density, and at the default
180 mm plate with a 1 mm pitch one build took 7.6 s; the small plate brings all
three texture probes back under 2 s each without changing what they assert.

`hanger_magnet.*` is claimed by `frame-cutters` and reaches geometry only
through `frame_style.separate.mount: "magnet"`, which is why its base carries
that. The frozen schema describes the group as "Recessed magnet dimensions, used
when `hanger` is `magnets`", and that is NOT what the code does: the wall-hanger
magnets use the frozen constants `MAGNET_D_MM` 6.1 and `MAGNET_DEPTH_MM` 3.1
(`lib/transform.ts`), while `hanger_magnet.*` sizes the SEPARATE FRAME's magnet
mount (`solid/frame.ts:683`, `:749`). The leaves move real geometry either way,
so this is a description that no longer matches the code rather than a defect;
it is written up here so the next contract pass can fix the sentence.

## 3. Coverage and run time

`PRINT_PARAM_LEAF_PATHS` has 134 leaves. 124 are probed, 10 are exempt (the four
rulings, with `part_colors.*` expanded to its seven leaves). The coverage test
walks the generated list and fails on any leaf that is neither, so a schema
addition without a probe fails CI the same way a schema addition without a stage
claim already fails `graph.test.ts`. It also fails a probe whose path is not a
leaf, two probes on one leaf, a probe whose value equals what the base already
holds, and a `why` string that says "hash" or "bytes moved".

| run | probes | wall time | failures |
|---|---|---|---|
| before the audit fixes, quiet host | 124 | 99.9 s | the 2 defects |
| before the audit fixes, quiet host | 124 | 124.6 s | the 2 defects |
| before the audit fixes, other agents building | 124 | 175.2 s | the 2 defects |
| before the audit fixes, other agents building | 124 | 167.0 s | the 2 defects |
| after the audit fixes, other agents building | 124 | 131.7 s | the 2 defects |
| after the audit fixes, other agents building | 124 | 138.3 s | the 2 defects |

Budget three minutes. Six measured runs came in between 100 and 175 seconds, and
the spread is host load rather than variance in the file: every run did the same
work, and the slow ones were taken while other agents in this wave were building
and running their own suites on the same 32 cores. The audit's fixes cost
nothing measurable: they added four probe groups (the solo-slot colour bases)
and removed two cold builds (`F18`), which roughly cancel. The file prints its
own measured time (`matrix: 124 probes in NNN s`) on every run, so the number in
a CI log is never a guess.

The shape of the cost is 124 `after` runs plus 32 `before` builds on the small
synthetic scenes, about 700 ms each. Keeping it in ONE file is deliberate: the
warm cache per group is what makes an `after` run partial, and splitting the
table across files would cost a fresh cold build per group.

### How specific each assertion is

`docs/handoff/v3-01-matrix-audit.md` graded all 248 assertions against a rubric
that counts a bare `not.toBe` on a count, a zip's byte length, a stat eight
sibling fields all move, and a parameter echoed back as WEAK. After its fixes
(section 6 of that file):

| side | SPECIFIC | WEAK |
|---|---|---|
| preview | 119 | 5 |
| export | 123 | 1 |

The five preview WEAK are the five leaves that have no geometric effect by
design, listed in section 2. The one export WEAK is
`colour.region_slots.attribution`, which is defect 3 below.

Two limits are known and accepted. Enum leaves are one value deep: `road_mode`
probes `"off"` and never `"emboss"`, `frame_style.texture.pattern` probes
`"knurl"` out of four, `frame_style.profile` `"chamfer"` out of seven,
`hero_mode` never probes `"both"` and `engravings[].mode` never probes
`"emboss"`. Gate V3-1 asks for one non-default value per leaf, and
`export_target` is the exception that sweeps all seven. And the matrix proves a
field MOVES the model and the file; it does not prove the move is the right size
for anything but the fields whose probe names an analytic quantity.

## 4. Exemptions

Four rulings, ten leaves, each named in `matrix.probes.ts` with its
`DECISIONS.md` line and asserted in `matrix.test.ts`.

| leaf | ruling | compensating assertion |
|---|---|---|
| `schema_version` | `[V3.1-P1-2]` payload metadata, no physical meaning | the exemption test builds with `schema_version: 2` and asserts the sidecar's top-level echo moves 3 to 2 while the region list is unchanged; `share.test.ts` pins the version gate |
| `colour.preview_theme` | `[V3.1-P1-2]` a viewer setting that lives in the viewport HUD | the exemption test builds with `"light"` and asserts the sidecar's top-level `preview_theme` moves while `stats.triangles` is unchanged |
| `part_colors.*` (7) | `[V3.1-P1-2]` the v1 colour block, migrated into `colour.region_colors` at parse time | the exemption test asserts no stage claims any of the seven; the migration itself is the integration wave's test |
| `colour.region_colors.attribution` | `[V3.1-P1-13]` the mandatory marks are engraved cuts and never a body, so no colour can reach a file | the exemption test asserts no stage claims it, and that `colour.region_slots.attribution` IS claimed |

## 5. Defects

Two probes cannot be made to pass, and one leaf cannot be given a file-specific
assertion at all. None is skipped or quietly weakened: the two probes are in the
table, they fail, and the failure message names the ruling it is waiting for.

### Defect 1: `regions.rail.width_m` never reaches a scene

**Ruled.** `DECISIONS.md` `[V3.1-P2-1]`: the parameter is authoritative for
every rail ribbon, exactly as its schema description says; the per-type table
stays as `SceneGraph` data. Implemented in the Task 7 geometry wave.

**Repro.** `matrix.test.ts > matrix: rail defaults > regions.rail.width_m = 3`,
the `rail` synthetic scene at the defaults, the parameter driven from its 6 m
default DOWN to 3 m while the scene's own way carries 6 m.

**Observed.** Nothing moves. The rail region's x span stays 2.9200 mm before and
after, in the region and in the written 3MF, and its volume stays 265.646 mm3.

**What the probe pins.** The printed span must move by exactly
`(3 - 6) * mmPerM` = -1.26 mm, to two decimals, on both sides. The narrowing
direction is the point: a fallback moves nothing, `Math.max(way.width_m, param)`
moves nothing, and a sum widens, so all three wrong implementations fail this
assertion where a widening probe would have passed two of them.

**Where it should move.** `surface-rail` and `bridges`, both of which call
`solid/roads.ts:railWidthGroundM`:

```ts
export function railWidthGroundM(ctx: BuildContext, way: RailWay): number {
  const fallback = ctx.params.regions?.rail?.width_m ?? 6.0;
  return Math.max((way.width_m ?? fallback) * ctx.params.road_scale, ctx.thresholdsGroundM.min_wall);
}
```

The parameter is only a fallback for `Rail.width_m`, and
`osm/normalize.ts:734-750` sets `width_m` on EVERY rail way from its railway
type (`RAIL_WIDTH_M`: rail 5.0, light_rail 4.0, subway 5.0, tram 3.0, else 4.0).
`Rail.width_m` is a required field of the type, so a scene without it is not a
legal `SceneGraph` either, and the fallback is unreachable.

### Defect 2: `frame_style.lip_depth_mm` is resolved and dropped

**Ruled.** `DECISIONS.md` `[V3.1-P2-2]`: it is the sight-edge rebate on the
frame lip's inner top edge, a step `lip_depth_mm` deep and
`FRAME_SIGHT_EDGE_MM` = 1.0 mm wide, 0 meaning a flat lip. Implemented in the
Task 7 geometry wave.

**Repro.** `matrix.test.ts > matrix: block defaults > frame_style.lip_depth_mm =
1.5`, the `block` scene at the defaults, the leaf driven from 0.4 to 1.5 mm.
(1.5, not the schema's maximum 3.0: the lip it would be cut into is 2.2 mm tall.)

**Observed.** Nothing moves. The frame region's volume is 9159.310269228274 mm3
before and after, to the last digit, with the same triangle count and the same
bounding box, and the frame carries no ring of vertices at `frameTop - 0.4` for
the default rebate to sit on. Confirmed at 0.0 and 3.0 as well, on the `plain`,
`chamfer` and `ogee` profiles, and with a lettering line on the lip.

**What the probe pins.** All three parts of the ruling: the frame loses more
than 400 mm3 of section (`(1.5 - 0.4) mm` by 1.0 mm around a roughly 670 mm
inner perimeter), the rebate floor is at `frameTop - 1.5` after and at
`frameTop - 0.4` before, and that floor is exactly 1.0 mm wide, read as a ring.
An implementation that moved the frame volume some other way, cut a rebate of
another width, or cut it to another depth fails.

**Where it should move.** `frame` and `frame-cutters`, which claim
`frame_style.*`. `solid/frame.ts:180` resolves the leaf into
`FrameStyle.lipDepthMm`, and nothing in the tree reads that field: `grep -rn
lipDepth apps/web/lib` returns the interface member and that one assignment. The
strict-claims proxy still records the read, which is why `graph.test.ts`'s
"no unused claim" check is satisfied by a value that goes nowhere. That is worth
knowing on its own: a claim proves a leaf is READ, and only the matrix proves it
is USED.

### Defect 3: `colour.region_slots.attribution` reaches no exported byte

**Ruled, for now.** `DECISIONS.md` `[V3.1-P2-4]` keeps this leaf probed rather
than exempt, on the ground that the `slot-beyond-profile` finding's one-click
fix restates the whole slot table and that patch reaches the file through the
sidecar's `findings` block. The probe asserts exactly that, and passes.

**Why it is recorded here anyway.** That patch is the parameter copied back, not
a consequence of it, so by the matrix's own standard it is a WEAK export
assertion, and it is the only one left in the table. No stage builds an
attribution region solid, so nothing in the 3MF, the STL, the OBJ or the STEP
can move: `slotColors` (`export/common.ts:350`) walks BUILT regions, and there
is no attribution region to walk.

**The two honest resolutions**, both needing a ruling that supersedes
`[V3.1-P2-4]`: exempt the leaf under `[V3.1-P1-13]` with the fix-patch echo as
its compensating assertion, which makes the exemption list five rulings and
eleven leaves; or keep it probed and mark it a third red defect until a wave
gives the attribution marks a body to colour. The first is the smaller change
and matches `colour.region_colors.attribution`, which is already exempt for the
same reason.

## 6. Lines for DECISIONS.md (the orchestrator appends; this agent does not edit it)

The wave's first five lines landed as `[V3.1-P2-1]` through `[V3.1-P2-5]`. The
audit fixes change one of them and add one:

- [V3.1-P2-3] SUPERSEDED in part: the matrix no longer forces every export. Only
  the probes that deliberately trip a Stage 4 row carry `forceExport: true`, and
  today that is exactly two, `large_scale` at 2.0 and
  `custom_profile.max_height_mm` at 20, both `exceeds-height`. Every other
  probe, the `export_target` sweep and the exemption checks export through the
  gate the product ships, so a change that starts breaking a gate row fails the
  matrix. Reason: a global force suppressed the whole regression channel, which
  `docs/handoff/v3-01-matrix-audit.md` finding F10 measured.
- [V3.1-P2-6] `colour.region_slots.attribution` has no file-specific effect and
  the matrix records it as defect 3 in `docs/handoff/v3-01-matrix.md`. Either
  exempt it under `[V3.1-P1-13]` (the fix-patch echo becomes its compensating
  assertion, the exemption list grows to eleven leaves) or mark it a third red
  defect. Recorded because `[V3.1-P2-4]` accepted the echo, and the matrix
  applies a stricter standard to every other leaf.
