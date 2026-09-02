# v3-02 inventory: editor UI, shell, vocabulary

Read-only audit of `apps/web` as it stands in the working tree on `main`
(HEAD 7eda2d7, plus the uncommitted perf-instrumentation work another agent
landed during this pass: `lib/perf.ts`, `lib/perf.test.ts`,
`components/editor/PerfHud.tsx`, and edits to `CityPreview.tsx`,
`PreviewPane.tsx`, `RegionMeshes.tsx`, `lib/bake.ts`, `store/editor.ts`,
`lib/engine/{client,protocol,engine,worker}.ts`,
`lib/engine/osm/scene.ts`, `lib/engine/solid/{areas,manifold}.ts`,
`lib/engine/export/index.ts`). Line numbers are from the tree as read; a
further edit to those files can shift them by a few lines. Every claim carries
a `file:line`. Nothing in this pass modified a source file.

Terms used in the control table:

- **Preview reacts?** whether a layer in `components/scene/CityPreview.tsx`
  or a `previewDeps` entry reads the field, and which layer. "approx" means
  the instanced / flat-fill fallback repaints or rebuilds immediately.
  "engine-solid only" means nothing in the approximate preview reads it and
  the change appears only when `RegionMeshes` swaps in a fresh `EngineResult`
  (debounced 400 ms plus the WASM bake, `store/editor.ts:412`,
  `lib/enginePreview.ts`).
- **Export reacts?** whether any file under `lib/engine/**` (geometry, audit,
  estimate or an exporter) reads the field. Established by grep over
  `lib/engine` and `lib/transform.ts`, file names given.

The authority for the "preview reacts?" column is not assumption: it is
`components/scene/CityPreview.test.ts:234-330`, which drives every key of the
frozen contract through `previewDeps` and asserts, key by key, which layers
rebuild.

---

## 1. Every control

**Count: 129 user-facing controls, 107 of which write a `PrintParams` field or
`LocationState`. 24 are flagged** (either column "no", or "engine-solid only"
with no approximate feedback at all and no indication that the setting is
inert). The flagged rows are collected in section 1.11.

`data-testid` is given only where one exists. Most panel controls carry an
`id` and no test id: the `Slider` primitive emits `data-testid="<id>-value"`
on its readout only (`components/editor/Controls.tsx:193`), `ColorField`
emits `data-testid="<id>-hex"` (`Controls.tsx:531`), and `Toggle`,
`Segmented`, `SelectField` and `TextField` emit none at all
(`Controls.tsx:257`, `:368`, `:474`, `:429`).

### 1.1 Location (`components/editor/groups/LocationGroup.tsx`)

| Control | Label | Type | Setter | Field | Help today | testid | Preview reacts? | Export reacts? |
|---|---|---|---|---|---|---|---|---|
| `city_label` (`:58`) | Place name | text | `setPlaceName` (`store/editor.ts:778`) | `city_label` | yes, three variants (`:44-48`): "Looking up the place name...", "Could not look up a place name for this pin. Type one yourself, or use the coordinates.", "This is the {city} token. Type your own text and it wins from here on — a preset or a dragged pin no longer overwrites it." | none | yes, `text` layer only (`CityPreview.test.ts:216`) | yes, `lib/engine/export/common.ts` (sidecar/provenance) plus every `{city}` token through `lib/engine/solid/lettering.ts` |
| Reset to detected (`:73`) | Reset to detected (name) | button | `resetPlaceNameToDetected` (`store/editor.ts:788`) | `city_label` | no | `reset-place-name` | as above | as above |
| `author` (`:84`) | Author | text | `setAuthor` (`store/editor.ts:798`) | `place.author` | "This is the {author} token, for a credit line in an engraving or the underside mark." | none | yes, `text` layer (`CityPreview.test.ts:220`) | yes, `lib/engine/export/common.ts`, `lib/engine/export/step.ts` |
| `radius_m` (`:95`) | Radius | slider, commit-gated | `setRadius` + `generate()` on release | `location.radius_m` | "Half the ground span. Changing it refetches the scene." | none | yes, whole scene | yes, ingest |
| `rotation_deg` (`:108`) | Rotation | slider, commit-gated | `setRotation` + `generate()` | `location.rotation_deg` | "Turns the crop before it is squared. The dashed square on the map is what prints. Server-side, so it refetches on release." | none | yes, whole scene | yes, ingest |

The two sliders are the only controls in the panel that can reach the network,
and only on release through `Controls.createCommitGate`
(`components/editor/Controls.tsx:69`, 250 ms debounce at `:45`).

Map surface (`components/map/LocationPicker.tsx`): map click `:187` and pin
drag `:191` call `setPin`; the square handle drag `:205` calls `setRadius`,
and its `dragend` `:206` calls `generate()`. Handle tooltip is
`title="Drag to change the radius"` (`:130`). Standing hint at `:258`: "Click
to move the pin · drag the square handle to set the radius. The dashed square
is what gets printed."

### 1.2 Scale and size (`groups/ScaleSizeGroup.tsx`)

| Control | Label | Type | Setter | Field | Help today | Preview reacts? | Export reacts? |
|---|---|---|---|---|---|---|---|
| `plate_mm` (`:32`) | Plate size | slider | `setParam` | `plate_mm` | "The square the model is printed on. With the frame on, 12 mm of it becomes border." | yes, `scale`+`layout`+`roads`+`water`+`green`+`trees`+`height`+`text`+`advisor` | yes, `audit/rules.ts`, `solid/frame.ts`, `solid/hangers.ts`, `solid/validate.ts`, `solid/attribution.ts` |
| `base_thickness_mm` (`:44`) | Base thickness | slider | `setParam` | `base_thickness_mm` | "Solid slab under everything." | yes, `height` + `textDraw` | yes, `solid/hangers.ts`, `solid/lettering.ts`, `solid/ornaments.ts`, `solid/tiling.ts`, `solid/attribution.ts` |
| `nozzle_mm` (`:56`) | Nozzle diameter | slider | `setParam` | `nozzle_mm` | "Your printer's nozzle. It sets the minimum wall, gap and detail, so a wider one merges more of the city into fewer blocks." | yes, `thresholds`+`layout`+`roads`+`water`+`green`+`trees`+`advisor`+`spec` | yes, `audit/rules.ts`, `solid/measure.ts`, `solid/validate.ts`, `solid/tiling.ts`, `solid/lettering.ts` |

Readout `scale-summary` at `:68`.

### 1.3 Buildings (`groups/BuildingsGroup.tsx`)

| Control | Label | Type | Setter | Field | Help today | testid | Preview reacts? | Export reacts? |
|---|---|---|---|---|---|---|---|---|
| `small_scale` (`:103`) | Small building scale | slider (percent) | `setParam` | `small_scale` | "Height multiplier for buildings under 40 m." | none | yes, `height` + `InstancedBuildings` matrix buffer (`InstancedBuildings.tsx:53`) | yes, `lib/transform.ts` printed height |
| `large_scale` (`:115`) | Large building scale | slider | `setParam` | `large_scale` | "Height multiplier for buildings 40 m and over. Push this too far and the model passes the 60 mm print ceiling." | none | yes, same | yes, plus `solid/validate.ts` |
| Remove hero (`:151`) | Remove | button | `toggleHero` | `hero_building_ids` | group hint at `:129`: "Click a building in the preview to pick it out. Heroes keep their true height and can take their own colour when the bake runs." | `hero-item` (row) | yes, `height` + `text` (`CityPreview.test.ts:246`) | yes, `heroIds` argument, `engine.ts:158` |
| Clear all (`:167`) | Clear all | button | `clearHeroes` | `hero_building_ids` | no | none | as above | as above |
| `hero_auto_enabled` (`:191`) | Auto-detect heroes | toggle | `setNested("hero_auto")` | `hero_auto.enabled` | "Promotes the tallest, biggest-footprint and most landmark-tagged buildings automatically, on top of anything picked by hand." | none | yes, `height` only when a real building is promoted (`CityPreview.test.ts:332`) | indirect: `store/editor.ts:454 currentHeroIds` computes the set and passes it as `heroIds`. Nothing under `lib/engine` reads `params.hero_auto` |
| `hero_auto_count` (`:199`) | Auto-detected count | slider | `setNested("hero_auto")` | `hero_auto.count` | "How many buildings to promote automatically. Manual picks are never evicted for one of these." | none | as above | as above |

### 1.4 Heights (`groups/HeightsGroup.tsx`)

| Control | Label | Type | Setter | Field | Help today | Preview reacts? | Export reacts? |
|---|---|---|---|---|---|---|---|
| `heights_floor_height_m` (`:50`) | Floor height | slider | `setNested("heights")` | `heights.floor_height_m` | "How tall one storey counts as, when a building only carries building:levels." | **no** | **no, not at bake time** |
| `heights_unknown_default_m` (`:62`) | Unknown building default | slider | `setNested("heights")` | `heights.unknown_default_m` | "The guess used when OSM carries no height or level count at all, and the building type has no better default of its own." | **no** | **no, not at bake time** |
| `height_exaggeration_multiplier` (`:74`) | Height exaggeration | slider | `setNested("height_exaggeration")` | `height_exaggeration.multiplier` | "A flat multiplier on every printed building height, on top of the small/large building scales." | no (`CityPreview.test.ts:306`) | yes, `lib/transform.ts` |
| `height_exaggeration_curve` (`:86`) | Exaggeration curve | slider | `setNested("height_exaggeration")` | `height_exaggeration.curve` | "0 keeps the multiplier flat; higher settings pull a tower down and a shed up relative to a straight multiply, so one skyscraper does not dwarf the block." | no | yes, `lib/transform.ts` |

The two `heights.*` sliders are the sharpest finding in this pass. See 1.11.

### 1.5 Surface (`groups/SurfaceGroup.tsx`)

| Control | Label | Type | Setter | Field | Help today | Preview reacts? | Export reacts? |
|---|---|---|---|---|---|---|---|
| `road_mode` (`:26`) | Road mode | segmented radiogroup | `setParam` | `road_mode` | "Engraved roads are cut 0.6 mm into the slab; embossed ones stand 0.4 mm proud." | yes, `roads` | yes, `solid/roads.ts`, `solid/bridges.ts` |
| `road_scale` (`:35`) | Road scale | slider | `setParam` | `road_scale` | "Width multiplier, applied before the minimum-feature clamp." | yes, `roads` | yes, `solid/roads.ts` |
| `water` (`:48`) | Water | toggle | `setParam` | `water` | "Recessed 0.5 mm below the base top." | yes, `water` | yes, `solid/areas.ts`, `solid/measure.ts`, `solid/tiling.ts` |
| `trees` (`:56`) | Trees | toggle | `setParam` | `trees` | "Cones on the green areas, three times as tall as they are wide, capped at 2000. Trees too small to print are dropped." | yes, `trees`+`height`+`advisor` | yes, `solid/trees.ts`, `audit/rules.ts` |

There is no green/planting toggle on the frozen contract
(`CityPreview.test.ts:181`).

### 1.6 Terrain (`groups/TerrainGroup.tsx`)

| Control | Label | Type | Setter | Field | Help today | Preview reacts? | Export reacts? |
|---|---|---|---|---|---|---|---|
| `terrain_enabled` (`:35`) | Terrain | toggle | `setNested("terrain")` | `terrain.enabled` | "Drapes the base over real ground elevation instead of a flat slab. Off by default." | engine-solid only | yes, `engine.ts`, `solid/drape.ts`, `solid/context.ts`, `solid/measure.ts`, `solid/validate.ts`, `terrain/tiles.ts` |
| `terrain_exaggeration` (`:43`) | Vertical exaggeration | slider | `setParam` (top-level field, not nested) | `terrain_exaggeration` | "Stretches the elevation relief so a gentle slope reads on the plate. Ignored while terrain is off." | engine-solid only | yes, `engine.ts`, `solid/validate.ts`, `lib/transform.ts` |
| `terrain_smoothing` (`:56`) | Smoothing | slider | `setNested("terrain")` | `terrain.smoothing` | "Blurs the elevation sample before draping it, so buildings do not sit on a jagged terrace." | engine-solid only | yes, `terrain/heightfield.ts` |

Status notes `terrain-loading`, `terrain-error`, `terrain-low-relief-hint`,
`terrain-attribution` at `:69-85`.

### 1.7 Frame and text (`groups/FrameTextGroup.tsx`, `EngravingsEditor.tsx`)

39 controls. Every one writes through `setParam` or `setNested`, and every one
is `engine-solid only` in the preview except `frame` itself and the lettering
block. `frame_style` as a whole rebuilds nothing in `previewDeps`
(`CityPreview.test.ts:308`).

| Control | Label | Type | Field | Help today | Preview reacts? | Export reacts? |
|---|---|---|---|---|---|---|
| `frame` (`:260`) | Frame | toggle | `frame` | "A 6 mm border standing 2 mm proud of the base. It costs 12 mm of plate, so the city inside gets smaller." | yes, everything | yes, `solid/frame.ts` and 7 more |
| 7 profile buttons (`:272`, testid `frame-profile-<value>`, wrapper `frame-profile-options`) | Plain / Chamfer / Stepped / Bevel in / Bullnose / Ogee / Floating | radiogroup | `frame_style.profile` | field hint `:270`: "Every profile costs the same plate footprint as the plain lip; only the cross-section changes. A profile the engine has not built yet still previews as the plain lip and the Issues badge says so." Plus a native `title` per button carrying the one-line description (`:280`) | engine-solid only | yes, `solid/frame.ts` |
| `frame_style_corner` (`:306`) | Corners | select | `frame_style.corner` | none | engine-solid only | yes |
| `frame_style_corner_radius_mm` (`:314`) | Corner radius | slider, conditional | `frame_style.corner_radius_mm` | none | engine-solid only | yes |
| `frame_style_lip_depth_mm` (`:326`) | Lip depth | slider | `frame_style.lip_depth_mm` | "How far the lip's own moulding cuts into its 6 mm width." | engine-solid only | yes |
| `frame_style_shadow_gap_enabled` (`:342`) | Add a shadow gap | toggle | `frame_style.shadow_gap.enabled` | field hint `:341`: "A recessed groove between the frame and the base, as if the frame floats above the plate." | engine-solid only | yes |
| `frame_style_shadow_gap_width_mm` (`:351`) | Width | slider | `.shadow_gap.width_mm` | none | engine-solid only | yes |
| `frame_style_shadow_gap_depth_mm` (`:362`) | Depth | slider | `.shadow_gap.depth_mm` | none | engine-solid only | yes |
| `frame_style_matting_enabled` (`:378`) | Add matting | toggle | `.matting.enabled` | field hint `:377`: "A recessed board between the frame and the city, like the mat around a photograph." | engine-solid only | yes |
| `frame_style_matting_width_mm` (`:387`) | Width | slider | `.matting.width_mm` | "Plate the city loses to the matting, on top of what the frame itself already costs." | engine-solid only | yes |
| `frame_style_matting_proud_mm` (`:399`) | Standing proud | slider | `.matting.proud_mm` | none | engine-solid only | yes |
| `frame_style_separate_enabled` (`:415`) | Print the frame separately | toggle | `.separate.enabled` | field hint `:414`: "Prints the frame as its own piece from the base, so each can be a different filament without a colour change." | engine-solid only | yes |
| `frame_style_separate_mount` (`:424`) | Mount | select | `.separate.mount` | none | engine-solid only | yes |
| `frame_style_separate_tolerance_mm` (`:432`) | Fit tolerance | slider | `.separate.tolerance_mm` | "Extra clearance between the two parts. Widen it if the frame prints too tight to seat." | engine-solid only | yes |
| `frame_style_texture_pattern` (`:449`) | Pattern | select | `.texture.pattern` | field hint `:448`: "A relief pattern cut into the frame's visible front face." | engine-solid only | yes |
| `frame_style_texture_scale_mm` (`:459`) | Pattern scale | slider | `.texture.scale_mm` | none | engine-solid only | yes |
| `frame_style_texture_depth_mm` (`:470`) | Pattern depth | slider | `.texture.depth_mm` | none | engine-solid only | yes |
| Add a line of lettering (`EngravingsEditor.tsx:263`, testid `engraving-add`) | button | `engravings` | tokens note `:279` | yes, `text` | yes, `solid/lettering.ts` |
| Remove line (`:158`, testid `engraving_N-remove`) | Remove | button | `engravings` | none | yes, `text` | yes |
| `engraving_N_text` (`:170`) | Text | text | `engravings[N].text` | live "Cuts as:" preview at `:181` | yes, `text` | yes |
| `engraving_N_edge` / `_align` / `_mode` / `_font` (`:197-227`) | Edge / Align / Mode / Font | selects | `engravings[N].*` | none | yes, `text` | yes |
| `engraving_N_size_mm` (`:231`) | Cap height | slider | `engravings[N].size_mm` | fit verdict note at `:254` | yes, `text` | yes |
| `engraving_N_depth_mm` (`:242`) | Depth | slider | `engravings[N].depth_mm` | none | yes, `text` | yes |
| `north_arrow_enabled` (`:506`) | Show a north arrow | toggle | `north_arrow.enabled` | none on the toggle; `frame-off-notice` at `:498` explains the disabled case | yes, `text` | yes, `solid/ornaments.ts` |
| `north_arrow_corner` (`:515`) | Corner | select | `north_arrow.corner` | none | yes, `text` | yes |
| `north_arrow_size_mm` (`:523`) | Size | slider | `north_arrow.size_mm` | none | yes, `text` | yes |
| `scale_bar_enabled` (`:539`) | Show a scale bar | toggle | `scale_bar.enabled` | none | yes, `text` | yes |
| `scale_bar_edge` (`:548`) | Edge | select | `scale_bar.edge` | none | yes, `text` | yes |
| `scale_bar_length_mode` (`:556`) | Length | select | `scale_bar.length_mode` | "Auto picks a round distance that fits the edge." | yes, `text` | yes |
| `scale_bar_length_m` (`:566`) | Ground length | slider | `scale_bar.length_m` | none | yes, `text` | yes |
| `underside_mark_enabled` (`:583`) | Mark the underside | toggle | `underside_mark.enabled` | "Cut into the bottom of the base, where it never shows on a shelf." | yes, `text` | yes, `solid/attribution.ts`, `engine.ts` |
| `underside_mark_template` (`:592`) | Template | text | `underside_mark.template` | live "Cuts as:" at `:606` (testid `underside_mark-preview`) plus the standing note at `:629` | yes, `text` | yes |
| `hanger` (`:638`) | Fitting | select | `hanger` | field hint `:637`: "A fitting added to the back so the plate can go on a wall or an easel." | yes, `text` | yes, `solid/hangers.ts`, `solid/validate.ts` |
| `hanger_magnet_diameter_mm` (`:647`) | Magnet diameter | slider | `hanger_magnet.diameter_mm` | none | no (`CityPreview.test.ts:310`) | yes, `solid/frame.ts` |
| `hanger_magnet_thickness_mm` (`:657`) | Magnet thickness | slider | `hanger_magnet.thickness_mm` | none | no | yes |
| `hanger_magnet_count` (`:667`) | Magnet count | slider | `hanger_magnet.count` | "Shared by the magnet hanger and a separate frame's magnet mount -- one pocket size either way." | no | yes |

### 1.8 Colour (`groups/ColourGroup.tsx`)

| Control | Label | Type | Field | Help today | testid | Preview reacts? | Export reacts? |
|---|---|---|---|---|---|---|---|
| `color_mode` (`:237`) | Colour | segmented | `color_mode` | "One filament exports a single object. One per part exports each part with its own colour, ready for a multi-material printer." | none (radiogroup id `color_mode`) | yes, repaints the approximate layers through `paletteFor` (`components/scene/palette.ts:176`), no geometry rebuild | partial: only `lib/engine/export/generic3mf.ts:182` reads it, to choose single-object vs one-object-per-region. No other target |
| 7 colour wells (`:252`) | Base / Buildings / Roads / Frame / Water / Planting / Trees | `input[type=color]` | `part_colors.<key>` | field hint `:248`: "The defaults are four filaments, not seven: the base shares with the buildings, the frame with the roads, and the trees with the planting." | wrapper `part-colors`, per-well `part_color_<key>-hex` | yes, but only the approximate layers and only in `parts` mode; nothing once a fresh engine result is up | **no. Nothing under `lib/engine` reads `part_colors`** |
| `hero_mode` (`:270`) | Hero buildings print as | select | `hero_mode` | "True height keeps a hero at its real relative height even when the other buildings are scaled down. Own colour gives it its own filament." | none | only through `heroHeightKey`; with no hero picked it moves nothing (`CityPreview.test.ts:212`) | yes, `lib/engine/engine.ts:617` via `T.hero_own_color` |
| Built-in palette buttons (`:293`) | palette label | buttons | `colour.region_colors` + `region_slots` + `palette` | field hint `:288` plus a native `title` carrying each palette's description | `palette-apply-<id>`, list `palette-builtin-list` | engine-solid only | yes, region colours reach every exporter through `solid/context.ts:regionColor` |
| Custom palette apply (`:329`) | saved name | button | same | no | `palette-apply-<id>` | engine-solid only | yes |
| Custom palette delete (`:338`) | Delete | button | localStorage only | `aria-label` "Delete palette <name>" | `palette-delete-<id>` | n/a | n/a |
| `palette-save-name` (`:353`) | Save current colours as | text | UI-only local state | no | none | n/a | n/a |
| Save (`:360`) | Save | button | localStorage + `colour.palette` | no | `palette-save` | no | **no. `colour.palette` is not read anywhere under `lib/engine`; it is a label for the picker** |
| Per-region slot select (`:390`) | `<Region> filament slot` | select | `colour.region_slots.<region>` | field hint `:375`: "What the printed model, the Bambu project and the colour-change plan actually use: a slot and a colour per region. This is what the preview shows once a bake has run." | `colour-slot-<region>` | engine-solid only | yes, `solid/context.ts`, `export/bambu3mf.ts`, `export/colorchange.ts` |
| Per-region colour (`:404`) | `<Region> colour` | color | `colour.region_colors.<region>` (+ flips `palette` to custom) | as above | `colour-color-<region>` | engine-solid only | yes |
| Align colours (`:454`) | Align colours to what will print | button | `colour.region_colors` | inside `colour-slot-conflicts` note | `align-slot-colours` | engine-solid only | yes |
| Merge to profile slots (`:469`) | Merge to N slots | button | `region_slots` + `region_colors` | inside `colour-slots-exceed-profile` note | `merge-to-profile-slots` | engine-solid only | yes |
| `colour_tint_enabled` (`:485`) | Vary building colour | toggle | `colour.tint.enabled` | field hint `:482`: "A small random colour shift per building, so a block of identical footprints does not read as one slab." | yes, through the `tintColors` memo (`CityPreview.tsx:545`), outside `previewDeps` | **OBJ only.** `solid/tint.ts` feeds `EngineResult.buildingTints`; `lib/tint.ts:tintIsPreviewOnly` marks every other target |
| `colour_tint_hue` (`:492`) | Hue range | slider | `colour.tint.hue_range_deg` | none | yes, `tintColors` | OBJ only |
| `colour_tint_lightness` (`:502`) | Lightness range | slider | `colour.tint.lightness_range` | none | yes, `tintColors` | OBJ only |
| Reroll (`:516`) | Reroll | button | `colour.tint.seed` | seed readout `colour-tint-seed` | `colour-tint-reroll` | yes, `tintColors` | OBJ only |
| `colour_gradient_enabled` (`:541`) | Band buildings by height | toggle | `colour.gradient.enabled` | field hint `:539`: "Bands the buildings by height, tallest in one filament, shortest in another. Bounded by the active printer profile's own filament count." | engine-solid only | yes, `solid/buildings.ts` |
| `colour_gradient_bands` (`:549`) | Bands | slider | `colour.gradient.slots` length | none | engine-solid only | yes |
| Per-band slot select (`:568`) | Band N filament slot | select | `colour.gradient.slots[i]` | none | `colour-gradient-band-slot-<i>` | engine-solid only | yes |

### 1.9 Printer (`groups/PrinterGroup.tsx`)

| Control | Label | Type | Field | Help today | Preview reacts? | Export reacts? |
|---|---|---|---|---|---|---|
| `printer_profile` (`:52`) | Printer profile | select | `printer_profile` (+ `plate_mm`, `nozzle_mm` once, `store/editor.ts:707`) | "Sets the plate size and the nozzle once, on selection; move them afterwards and they stay put. Also sets the height ceiling below and how many filament slots the Colour group's slot warning checks against." | `height` only, for the ceiling comparison (`CityPreview.test.ts:323`); the `plate_mm`/`nozzle_mm` it writes rebuild everything | yes, via `resolveProfile` in `audit/rules.ts:49`, `export/bambu3mf.ts:30`, `export/common.ts:6`, `export/index.ts:5`, `solid/validate.ts:38` |
| `custom_profile_plate_x_mm` (`:66`) | Plate width | slider | `custom_profile.plate_x_mm` | none | no | yes, `audit/rules.ts` plate-fit finding |
| `custom_profile_plate_y_mm` (`:76`) | Plate depth | slider | `custom_profile.plate_y_mm` | none | no | yes |
| `custom_profile_max_height_mm` (`:86`) | Height ceiling | slider | `custom_profile.max_height_mm` | none | yes, `height` (`CityPreview.test.ts:326`) | yes, `solid/validate.ts` |
| `custom_profile_slots` (`:96`) | Filament slots | slider | `custom_profile.slots` | none | no | yes, `audit/rules.ts`, `export/bambu3mf.ts` |
| `custom_profile_change_gcode` (`:106`) | Colour-change command | text | `custom_profile.change_gcode` | none | no | yes, `export/colorchange.ts` |
| `tiling_enabled` (`:127`) | Split into tiles | toggle | `tiling.enabled` | field hint `:123` | engine-solid only (`TileGrid` needs a fresh result) | yes, `solid/tiling.ts` |
| `tiling_cols` (`:135`) | Columns | slider | `tiling.cols` | none | engine-solid only | yes |
| `tiling_rows` (`:146`) | Rows | slider | `tiling.rows` | none | engine-solid only | yes |
| `tiling_joint` (`:155`) | Joint | select | `tiling.joint` | "How adjacent tiles key into each other." | engine-solid only | yes |
| `tiling_tolerance_mm` (`:163`) | Joint tolerance | slider | `tiling.tolerance_mm` | "Gap left in the joint so two printed tiles actually fit together." | engine-solid only | yes |
| `tiling_index_mark` (`:174`) | Mark tile index | toggle | `tiling.index_mark` | "Cut a small (column, row) mark into each tile so they go back together in the right order." | engine-solid only | yes |

Two standing notes: `printer-profile-summary` (`:115`) and
`printer-help-note` (`:186`).

### 1.10 Output and shell actions

| Control | Label | Type | Action | Field | Help today | testid |
|---|---|---|---|---|---|---|
| Generate (`OutputPanel.tsx:227`) | Generate / Regenerate / Generating... | button | `generate()` | location ingest | `title` "The scene already matches this location." while disabled | `generate-button` |
| Bake (`:237`) | Bake / Baking... | button | `requestBake()` | none | `title` = `bakeBlockReason` | `bake-button` |
| Export format (`ExportMenu.tsx:60`) | Export format (sr-only label) | select | `setParam` + immediate `requestBake()` | `export_target` | `title` "Choose a file format; Bake exports it" | `export-target-select` |
| Copy link (`OutputPanel.tsx:254`) | Copy link / Link copied | button | clipboard + `history.replaceState` | none | `title` "Copy a link that restores every setting on this page" | `copy-link-button` |
| Save project (`:275`) | Save project | button | `downloadProject` | none | `title` "Download this whole design as a .framecraft.json file" | `save-project-button` |
| Load project (`:284`) | Load project | button | file input then `applyProject` | whole state | `title` "Load a .framecraft.json file, replacing every setting" | `load-project-button` |
| Reset all (`ParamPanel.tsx:117`) | Reset all | button | `resetParams` | every field | none | `reset-button` |
| Output group toggle (`ParamPanel.tsx:152`) | Output, show/hide results | button | local + localStorage | none | none | `group-output-toggle` |
| 9 group toggles (`CollapsibleGroup.tsx:42`) | group title | button | `saveCollapsed` | none | none | `group-<id>-toggle` |
| 6 preset chips (`PresetRow.tsx:37`) | preset label | button | `applyPreset` + `generate()` | location | none | `data-preset-id` |
| Shortcuts (`EditorShell.tsx:235`) | ? | button | opens sheet | none | `aria-label` "Keyboard shortcuts" | `shortcuts-button` |
| Theme (`ThemeToggle.tsx:22`) | Light / Dark | button | `toggleTheme` | none | `aria-label` "Switch to the X theme" | `theme-toggle` |
| History chip / Undo / Redo / step items (`HistoryChip.tsx:82,108,117,133`) | N changes / Undo / Redo / label | buttons | `undoHistory` etc | whole snapshot | none | `history-chip`, `history-undo`, `history-redo`, `history-item` |
| Param sheet toggle (`EditorShell.tsx:295`) | Model parameters, Show/Hide | button | local | none | none | `param-sheet-toggle` |
| Preview theme (`CityPreview.tsx:806`) | Dark viewport / Light viewport | button | `setNested("colour")` | `colour.preview_theme` | `title` "Preview theme: X" | `preview-theme-toggle` |
| Issues badge + Auto-fix all safe issues + per-issue fix (`IssuesBadge.tsx:115,141,173`) | Issues: N / Auto-fix all safe issues / fix label | buttons | `applyFinding`, `applySafeFindingFixes` | arbitrary params via `audit/fixes.ts` | none | `issues-badge`, `auto-fix-safe`, `issue-fix-<id>` |
| Adjustments chip (`AdjustmentsChip.tsx:66`) | N adjustments made | button | opens drawer | none | none | `adjustments-chip` |
| Advisor remedies (`CityPreview.tsx:858`) | e.g. "Use 540 m" | buttons | `setRadius`+`generate()` or `setParam("plate_mm")` | radius / plate | `aria-label` e.g. "Use a 540 m radius and generate again" (`lib/advisor.ts:113`) | `advisor-use-radius`, `advisor-use-plate` |
| Preview canvas (`CityPreview.tsx:607`) | 3D preview | `role="application"` | `toggleHero` on click and Enter | `hero_building_ids` | `aria-label` names the arrow keys | `preview-canvas` |
| Search box (`SearchBox.tsx:160`) | Search for a place | combobox | `setPin`+`setRadius`+`applyGeocodeResult`+`generate()` | location + place | placeholder only | `location-search` |
| Recent designs (`RecentDesigns.tsx:57,78,90`) | Recent (N) / entry / Clear recent designs | buttons | `applyShared` | whole state | `title` = entry name | `recent-designs-toggle`, `recent-design-item`, `recent-designs-clear` |
| Share notice dismiss (`WarningBanners.tsx:63`) | × | button | `setShareNotice(null)` | none | `aria-label` "Dismiss the shared link message" | `share-notice-dismiss` |

### 1.11 Flagged for the settings truth audit

**24 controls. Ordered worst first.**

1. **`heights.floor_height_m` and `heights.unknown_default_m` are inert after
   the first Generate.** `params.heights` is consumed only by `buildScene`
   (`lib/engine/osm/scene.ts:21`), which runs in the **ingest** job. Nothing
   under `lib/engine/solid/**`, `lib/engine/engine.ts` or `lib/transform.ts`
   reads it, so the debounced bake `store/editor.ts:466 runEngineJob`
   schedules on every write cannot apply it. Worse, `setParam` does not set
   `scene.stale` (`store/editor.ts:668`), so `sceneIsCurrent` stays true
   (`OutputPanel.tsx:111`) and the Generate button carries a real `disabled`
   attribute with the title "The scene already matches this location."
   **The user cannot re-apply the change without moving the pin, the radius
   or the rotation.** Two sliders, no preview feedback, no export feedback,
   no route to make them take effect.
2. **The seven part colour wells never reach a file.** `part_colors` has
   exactly three readers in the whole app: the ColourGroup UI
   (`ColourGroup.tsx:128`), `components/scene/palette.ts:176 paletteFor`, and
   the share/project validators. Grep over `lib/engine` returns nothing. They
   repaint the approximate preview in `parts` mode and stop mattering the
   moment a fresh `EngineResult` lands, because `RegionMeshes` paints from
   `colour.region_colors` instead. The field hint says nothing about this.
3. **`colour.palette` is a label only.** The Save button writes it and the
   picker reads it back; no engine or exporter reads it. The colours it
   applies do reach the export, so the effect is not zero, but the saved name
   itself is UI state stored in `PrintParams`.
4. **`color_mode` reaches exactly one exporter.** Only
   `lib/engine/export/generic3mf.ts:182` reads it. Under the default
   `bambu-3mf` target the segmented control changes the preview palette and
   nothing in the file. The hint ("One filament exports a single object...")
   reads as universal.
5. **The four tint controls are OBJ-only** (`lib/tint.ts:tintIsPreviewOnly`).
   This one is already surfaced, in `colour-tint-preview-only-note`
   (`ColourGroup.tsx:526`), so it is honest today. Listed for completeness.
6-24. **Engine-solid only, with no approximate feedback at all**: the three
   terrain controls, the two `height_exaggeration` sliders, the three
   `hanger_magnet` sliders, and the six tiling controls. Each is genuinely
   read by the engine, so the export column is "yes", but between the write
   and the bake landing the preview shows the previous shape with only the
   "Updating model..." badge (`CityPreview.tsx:772`) to say so.
   `CityPreview.test.ts:317` asserts this as deliberate behaviour, not a
   defect, but from the user's side these controls have a multi-second dead
   zone and no per-control indication.

**Two contract groups have no UI at all.** `regions` (roads/water/parks/rail
recess depths and `building_skirt_mm`) and `bridges` (`enabled`,
`clearance_mm`, `abutments`) are read heavily by the engine
(`solid/areas.ts`, `solid/roads.ts`, `solid/bridges.ts`, `solid/context.ts`,
`audit/rules.ts`) and are reachable through a share link or a project file,
but no group renders a control for them. `bridges.enabled` defaults to
**true** (`lib/contracts.ts:520`), so every model builds bridge decks with no
way to turn them off in the interface. `heights.type_defaults` is likewise
UI-less.

---

## 2. The idle skeleton

**There are exactly two skeletons in the app.** Grep over `app/`,
`components/`, `lib/`, `store/`, `e2e/` for `pulse`, `skeleton`, `shimmer`
returns only these two plus the keyframes that drive them. There is no
`animate-pulse` (Tailwind's own) anywhere; both use a project keyframe
`fc-pulse` defined at `app/globals.css:346`, and the bake bar uses a second,
`fc-indeterminate`, at `app/globals.css:336`.

**The one below the predicted height is the estimate card's.**
`components/editor/EstimateCard.tsx:43-57`, `data-testid="estimate-card-skeleton"`,
four grey bars on `bg-plate-sunken` inside a pulsing wrapper. It is the first
child of the OUTPUT panel's results block (`OutputPanel.tsx:394`), which sits
directly under the predicted-height line (`OutputPanel.tsx:343-354`).

**Its condition is one thing and one thing only: `engine.status === "computing"`**
(`EstimateCard.tsx:43`). It ignores `engine.result` and `engine.stale`
entirely. That check runs **before** the `if (!est) return null` at `:60`, so a
perfectly good stale result never renders while a newer job is in flight. The
card's own docstring at `:33` claims the opposite ("A STALE-but-present result
still renders (labelled 'from the previous bake')"), and the "from the
previous bake" span at `:69` is unreachable during a recompute. The result is
that **every parameter write replaces the populated estimate with a skeleton**,
400 ms after the keystroke, for the whole bake, which is what makes it read as
a skeleton for nothing. The neighbouring `StatsCard` makes the opposite choice
and keeps its numbers, labelling the heading "Print stats (previous
computation)" (`StatsCard.tsx:94`).

**A correction on the brief's framing.** In the true idle state, with no
SceneGraph, neither this skeleton nor the predicted-height line renders:

- `predictedTopMm` returns `null` when `graph` is null (`lib/warnings.ts:98`),
  so the `predicted-height` paragraph is not in the DOM at all.
- `runEngineJob` returns before touching `status` when there is no graph
  (`store/editor.ts:469`), so `engine.status` stays `"idle"` and the card
  returns `null`.
- "Generate a scene first." (`lib/warnings.ts:371`) is present in the idle
  state only as the Bake button's native `title` attribute
  (`OutputPanel.tsx:242`). The `bake-block-reason` note that would show it as
  text is gated on `blockReason && graph` (`OutputPanel.tsx:356`), so it never
  renders without a scene. The only other rendering of that string is in
  `BuildingsGroup.tsx:217`, inside the Auto-detected list, which is itself
  gated on `hero_auto.enabled` and that defaults to `false`
  (`lib/contracts.ts:528`).

So the state described in the brief does not reproduce from the code as
written. What does reproduce, and is worth fixing, is the skeleton replacing a
good stale estimate on every edit.

**The other skeleton** is `PreviewSkeleton` in the viewport
(`components/scene/CityPreview.tsx:992-1008`, `data-testid="preview-skeleton"`,
`role="status"`), rendered when `!graph && scene.status === "loading"`
(`CityPreview.tsx:581`). Its caption still says "Fetching the scene from
OpenStreetMap..." and its docstring at `:991` still says "While `POST /scene`
is in flight", which is stale wording since v3 retired the server bake.

**Third animated element, not a skeleton**: the indeterminate export bar,
`OutputPanel.tsx:411-418`, `data-testid="bake-progress"`, shown while
`bake.phase === "exporting"`.

---

## 3. Shell layout

### Column structure

`app/page.tsx:9` renders `EditorShell` and nothing else. `app/layout.tsx:45`
wraps it in `body > main.flex-1` plus a permanent footer.

`components/editor/EditorShell.tsx:208` is the editor root
(`data-testid="editor"`), `h-[calc(100dvh-2.75rem)]`, hidden below `sm`. It
holds a header (`:212`) and one grid (`:256`).

At `lg` and above the grid is
`lg:grid-cols-[minmax(0,var(--spacing-atlas))_minmax(0,1fr)_var(--spacing-rail)]`
(`EditorShell.tsx:257`): a fixed-token atlas column for the map, a flexible
middle for the preview, a fixed-token rail for the parameters. Both widths are
design tokens, not literals.

- **Map column** `EditorShell.tsx:263`, `aria-label="Location"`, contains
  `MapPane` (`components/map/MapPane.tsx:19`, a `dynamic(..., {ssr:false})`
  wrapper around `LocationPicker`).
- **Preview column** `:272`, `aria-label="Preview"`, contains
  `WarningBanners` then `PreviewPane` (`components/scene/PreviewPane.tsx:19`,
  also `ssr:false`).
- **Parameter rail** `:287`, `<aside aria-label="Parameters"
  data-testid="param-sheet">`, containing `ParamPanel`.

Below `lg` the same three sections become a flex column and the aside becomes
a fixed bottom sheet, `h-12` closed and `h-[42dvh]` open (`:291`). The column
reserves the sheet's height through a custom property
`--fc-sheet-reserve` set inline at `:261`, deliberately a custom property
rather than a `padding-bottom` so `lg:pb-0` can win. Below `sm`, a plain
"needs a desktop" state renders instead (`:326`, `data-testid="desktop-recommended"`).

### Where OutputPanel mounts, and how it reflows the settings column

`OutputPanel` is **not** a group in the scrolling list. `ParamPanel.tsx:112`
is a `flex h-full min-h-0 flex-col`; the nine parameter groups live in a
`min-h-0 flex-1 overflow-y-auto` div (`:127`, `data-testid="param-groups"`),
and Output is a `shrink-0` sibling pinned below it (`:146`,
`data-testid="group-output"`, `class="fc-scored"`). The docstring at
`ParamPanel.tsx:43` states the rule: Bake is the primary action once a scene
exists and a primary action must not be scrollable away.

The reflow after the first run is real and was found by running the browser,
not by reading. `OutputPanel.tsx:385` caps the results block at
`max-h-[45vh] overflow-y-auto` with `tabIndex={0}`. The comment at `:362-384`
records why: without the cap, the estimate card plus a finished bake's status
and links plus the stats card pushed the `shrink-0` Output section past the
sidebar height and squeezed the scrolling group list to zero, making every
group unreachable by click. The action row, the predicted height and the block
reason are deliberately outside the cap.

The Output group's collapse toggle (`ParamPanel.tsx:152`) folds only the
results. `aria-controls` is set to `undefined` while collapsed (`:160`)
because the action row is always rendered.

### localStorage

Seven keys, every access wrapped in try/catch:

| Key | Written by | Holds |
|---|---|---|
| `framecraft-theme` | `store/editor.ts:69,962` and the pre-paint script `app/layout.tsx:29` | light/dark |
| `framecraft-groups` | `lib/groups.ts:19,158` | per-group collapse state |
| `framecraft.author.v1` | `store/editor.ts:78,802` | Author field prefill, survives `resetParams` |
| `framecraft.recent.v1` | `lib/recent.ts:15,57` | up to 12 share payloads |
| `framecraft.palettes.v1` | `lib/palettes.ts:220,272` | saved custom palettes |
| `framecraft.geocode.v1` | `lib/geocode.ts:52,87` | reverse geocode cache, 30 days |
| `framecraft.geocode.search.v1` | `lib/geocode.ts:278,344` | forward search cache, 7 days |

An eighth, `framecraft.perf` (`lib/perf.ts:35`), is read but never written by
the UI: it is the opt-in switch for performance instrumentation.

Nothing about the layout beyond group collapse is persisted. The bottom
sheet's open state, the Output collapse (which is in `framecraft-groups`), the
drawer states and the preview camera are all session-local.

### Keyboard shortcuts

`lib/keyboard.ts:38-53` is the single source of the map, and
`ShortcutSheet.tsx:90` renders it:

| Key | Action |
|---|---|
| G | Generate the scene for this location |
| B | Bake the printable model |
| R | Reset every parameter to its default |
| Ctrl+Z / Cmd+Z | Undo the last change |
| Ctrl+Shift+Z | Redo |
| ? (and Shift+/) | Show this list |
| Esc | Close the drawer, sheet or dialog |
| Tab, arrows, arrows-in-preview | display-only rows, `action: null` (`:46-52`) |

Two safety rules, both in `shortcutFor` (`lib/keyboard.ts:113`): never inside
a typing target (`isTypingTarget:90`, and a `type=range` is deliberately not
one), and never a chord except the undo/redo pair.

### The overlay rule

`EditorShell.tsx:99`: `if (sheet || drawer || issues || history) return;`.
Four overlays tracked through a ref written on every render (`:50-60`) so the
`window` listener is bound once (`:131`). Two documented exceptions:

- `dismiss` (Escape) always gets through and closes what is open, outermost
  last (`:76-83`).
- `undo` and `redo` are exempt (`:88-95`), on the stated reasoning that
  Ctrl+Z with a drawer open is still a request to undo.

`help` is deliberately included in the suppression (`:96`) so re-pressing `?`
is not a silent no-op. The comment at `:39-49` records the defect this
replaced: with the sheet open, B started a real bake behind it and R reset
every parameter with no undo.

### Footer and attribution

`app/layout.tsx:52-56`: a permanent footer in the root layout, outside every
route, reading "Map data © OpenStreetMap contributors" between two hairlines.
The comment at `:47` states it is a licence obligation. A second attribution
lives on the map itself, `AttributionControl({compact:true})` at
`LocationPicker.tsx:114` fed by the raster source's own
`attribution: "© OpenStreetMap contributors"` (`:47`, `:99`). A third is in
the engine's mandatory engraved marks (`lib/engine/solid/attribution.ts`) and
a fourth in every export's provenance block
(`lib/engine/export/common.ts:provenanceEntries`).

### Theme

`components/editor/ThemeToggle.tsx`, in the header at `EditorShell.tsx:244`.
Label is the target theme ("Dark" while light), `aria-label` "Switch to the X
theme", `data-testid="theme-toggle"`. `store/editor.ts:955 setTheme` toggles
`.dark` on `<html>`, sets `colorScheme`, and writes `framecraft-theme`.
`initTheme` (`:973`) adopts whatever the pre-paint script in
`app/layout.tsx:26-37` already decided, which is what prevents a flash. The
viewport has its **own** independent theme switch writing
`colour.preview_theme` (`CityPreview.tsx:806`), scoped to a
`data-fc-viewport-theme` attribute so it never touches the panels.

---

## 4. Vocabulary

### 4.1 User-facing strings: 20 bake strings across 14 files, 11 generate strings across 7 files

Bake, in render order:

| File:line | String |
|---|---|
| `lib/groups.ts:109` | "The bake, the files and the measured stats." (Output group summary) |
| `components/editor/groups/BuildingsGroup.tsx:129` | "...can take their own colour when the bake runs." |
| `components/editor/groups/ColourGroup.tsx:375` | "...This is what the preview shows once a bake has run." |
| `components/editor/groups/PrinterGroup.tsx:123` | "Each tile still bakes and exports through the same pipeline." |
| `components/editor/EngravingsEditor.tsx:281` | "They expand when the file is baked, and the line above each field shows what they say now." |
| `components/editor/OutputPanel.tsx:245` | "Baking..." |
| `components/editor/OutputPanel.tsx:245` | "Bake" |
| `components/editor/ExportMenu.tsx:65` | `title` "Choose a file format; Bake exports it" |
| `components/editor/EstimateCard.tsx:69` | "from the previous bake" |
| `lib/bake.ts:66` | `BAKE_STALE_NOTE` "Parameters changed since this bake — bake again to download a matching file." |
| `lib/bake.ts:198` | "Not baked yet" |
| `lib/adjustments.ts:37` | "From the bake" (drawer heading) |
| `lib/issues.ts:57` | "Too few buildings to bake" |
| `lib/keyboard.ts:40` | "Bake the printable model" |
| `components/scene/CityPreview.tsx:502` | "Preview is approximate: the bake merges buildings closer than..." |
| `components/scene/CityPreview.tsx:506` | "...refusals are the bake's own." (same string) |
| `components/scene/CityPreview.tsx:945` | "Over the N mm print ceiling — the bake will refuse this." |
| `components/scene/CityPreview.tsx:982` | "4. Bake, and download the .3mf." |
| `components/scene/CityPreview.tsx:985` | "Keyboard: G generate · B bake · R reset · ? for the full list" |
| `lib/palettes.ts:127` | "Baked clay reds and warm sand, like an unglazed tile." (unrelated sense of the word; a rename must not touch it) |

Generate / Regenerate:

| File:line | String |
|---|---|
| `components/editor/OutputPanel.tsx:235` | "Generating..." |
| `components/editor/OutputPanel.tsx:235` | "Regenerate" |
| `components/editor/OutputPanel.tsx:235` | "Generate" |
| `lib/warnings.ts:371` | "Generate a scene first." (Bake button `title`, and the `bake-block-reason` note when a graph exists) |
| `store/editor.ts:1048` | "Generate a scene first." (bake failure message) |
| `components/editor/groups/BuildingsGroup.tsx:217` | "Generate a scene first." |
| `components/editor/WarningBanners.tsx:83` | "The location moved. Generate to rebuild the model for it." |
| `components/scene/CityPreview.tsx:981` | "2. Generate. The scene arrives in a few seconds." |
| `components/scene/CityPreview.tsx:985` | "G generate" (same string as the bake row above) |
| `lib/keyboard.ts:39` | "Generate the scene for this location" |
| `lib/advisor.ts:113` | `aria-label` "Use a N m radius and generate again" |

### 4.2 TypeScript identifiers and files: 63 distinct identifiers, 3 files

Distinct identifiers containing bake/Bake/BAKE across `lib`, `components`,
`store`, `app`, `scripts`, `e2e`: **63**. The load-bearing ones:

- Store: `state.bake`, `requestBake`, `BakeState`, `BakePhase`,
  `initialBakeState`, `markBakeStale`, `bakeExporting`, `bakeDone`,
  `bakeFailedLocally`, `bakeDownloadLinks`, `bakeStatusLabel`,
  `revokeBakeUrls`, `BAKE_STALE_NOTE`, `resolveParamsForBake`.
- Engine protocol: `BakeJobMessage`, `BakeDoneMessage`, `BakeErrorMessage`,
  `BakeProgressMessage`, `BakeWireInput`, `runBakeJob`, `bakeTransport`,
  `pendingBake`, `currentBakeId`, `supersedeBake`, `queuedBake`.
- Warnings: `bakeBlockReason`, `MIN_BUILDINGS_TO_BAKE`.
- **Generated and frozen**: `BakeResult`, `BakeFiles`, `BakeStats` in
  `lib/contracts.ts:340-362`, generated from
  `packages/contracts/schema/bake_result.json`. These cannot be renamed
  without a `DECISIONS.md` line and a contract regeneration, per `CLAUDE.md`.

Files: `apps/web/lib/bake.ts`, `apps/web/lib/bake.test.ts`,
`apps/web/scripts/bake-cli.ts`. Directory `services/bake/`.

### 4.3 Tests and test ids: 7 test ids, 140 e2e lines

Test ids carrying the word: `bake-button`, `bake-status`, `bake-progress`,
`bake-notes` (all `data-testid=` in `OutputPanel.tsx`), `bake-stale-note` and
`bake-block-reason` (via the `Note` component's `testId` prop), and
`generate-button`. Seven.

e2e lines mentioning bake or generate, per spec: `smoke` 45, `ui` 43,
`colour` 16, `print` 10, `lettering` 9, `a11y` 8, `terrain` 5, `share` 3,
`workflow` 1. **140 lines across 9 specs.**

Two of these assert the visible strings rather than the ids, so a rename
breaks them: `smoke.spec.ts:332` (`toHaveText(/^Generate$/)`) and
`smoke.spec.ts:367,425` (`toContainText("Done")`, `toContainText("outdated")`,
from `bakeStatusLabel`). `a11y.spec.ts:351` requires `bake-button` in the tab
walk and `a11y.spec.ts:383` asserts `generate-button` is absent from it.

### 4.4 Make targets and scripts: 1 target, 1 npm script, 45 Makefile lines

- Makefile: one target named for it, `bake-fixture` (declared `.PHONY` at
  `Makefile:3`, rule at `:419`), plus a shell helper function `bake()` inside
  `gate-v2` (`:332`). 45 lines in the file contain the word, most of them the
  `services/bake` path and the `python -m app.cli bake` invocation at `:460`.
- npm: `apps/web/package.json:15`, `"bake:cli": "vite-node scripts/bake-cli.ts --"`.
- The reference service directory `services/bake/` and its CLI verb
  `app.cli bake`.

### 4.5 Docs: 1544 occurrences across 64 tracked markdown files

Heaviest: `DECISIONS.md` 392, `docs/handoff/03-mesh-bake.md` 68,
`docs/handoff/04-web-editor.md` 56,
`docs/handoff/v3-02-integration.md` 54, `docs/ARCHITECTURE.md` 29,
`RUNBOOK.md` 26. `DECISIONS.md` is append-only, so its occurrences are
historical record and must not be rewritten.

### 4.6 Strings that imply Export produces G-code or a print

Three, in ascending severity:

1. `components/scene/CityPreview.tsx:945` "Over the N mm **print** ceiling —
   the bake will refuse this." The ceiling is a machine limit, so "print" is
   defensible, but paired with "the bake will refuse" it reads as though a
   printer is involved.
2. `components/editor/groups/ColourGroup.tsx:375` "What the **printed model**,
   the Bambu project and the colour-change plan actually use". The Bambu
   project is a model file; the printed model does not exist yet.
3. `components/editor/groups/ColourGroup.tsx:530` "...the active export target
   (X) **prints** every building in its region's own slot colour." This one
   states that the export prints. `lib/warnings.ts:315` carries the same
   sentence for the Issues drawer.

Also worth noting: `bakeStatusLabel` already says "Exporting..."
(`lib/bake.ts:200`) while the button that started it says "Baking...". The
status row and the button disagree about what the operation is called, today,
before any rename.

---

## 5. Search

`components/map/SearchBox.tsx` plus `lib/geocode.ts`.

| Aspect | Today |
|---|---|
| Provider | Nominatim, `https://nominatim.openstreetmap.org/search?format=jsonv2&q=...&limit=6&addressdetails=0` (`lib/geocode.ts:275,415`). OSM only, per the hard rule |
| Identification | `User-Agent: FrameCraft/3.0 (https://github.com/naxhq/framecraft)` attempted (`geocode.ts:47,418`), documented as usually dropped by browsers. No `email=` parameter, deliberately |
| Debounce | 400 ms after the last keystroke (`GEOCODE_SEARCH_DEBOUNCE_MS`, `geocode.ts:276`) |
| Minimum characters | **None.** Any non-whitespace query searches (`geocode.ts:467`). Only an empty or whitespace query short-circuits to `[]` |
| Rate limiting | One shared module-level queue across forward and reverse lookups, `enqueueGeocodeRequest` (`geocode.ts:211`), never starting two requests under `GEOCODE_MIN_INTERVAL_MS` = 1000 ms apart (`:50`). A cache hit skips the queue entirely |
| Abort handling | Per-request `AbortController` with a 5 s timeout (`GEOCODE_TIMEOUT_MS`, `:51`; wired at `:411-412`). No cancellation of an in-flight request when a newer keystroke arrives: the scheduler cancels the *debounce* and the *callback* (`:491`), and a second guard in the component drops a result whose query no longer matches (`SearchBox.tsx:60`) |
| Keyboard navigation | ArrowDown/ArrowUp wrap through results, Enter picks the active one, Escape closes the list (`SearchBox.tsx:101-128`). Active row scrolled into view with `block:"nearest"` (`:130`). Full combobox ARIA: `role="combobox"` + `aria-expanded` + `aria-controls`/`aria-owns` set only while open, `aria-activedescendant`, `role="listbox"`, `role="option"` (`:146-217`) |
| Result rows | `onMouseDown` with `preventDefault`, not `onClick`, so the input's own blur timer cannot swallow the pick (`:214`) |
| Coordinate parsing | **None.** A "41.88, -87.62" query is sent to Nominatim as free text |
| Recents | **None in the search box.** `lib/recent.ts` is a separate feature (recent *designs*, keyed on share payloads, surfaced in the Output panel) |
| Geolocation | **None.** No `navigator.geolocation` call anywhere in `apps/web` |
| Caching | `framecraft.geocode.search.v1` in localStorage, 7 day TTL, keyed on the normalised query (`geocode.ts:278-370`). An empty result list caches too |
| Attribution | **None on the search box or its dropdown.** The only attributions are the global footer and the MapLibre control |
| Radius on pick | `radiusForResultType` (`geocode.ts:298`): city/town 1500 m, suburb/neighbourhood/quarter 900 m, building/amenity/house 400 m, otherwise 900 m |
| What a pick does | `setPin`, `setRadius`, `applyGeocodeResult` with `city: placeNameFromLabel(label)`, then `generate()` (`SearchBox.tsx:69-91`) |

**Reusable by a Photon type-ahead, unchanged:** the whole component
(`SearchBox.tsx`) including its combobox ARIA, the keyboard handler, the
blur/`onMouseDown` ordering, the `skipNextSearch` guard, and the `pick()`
store choreography. On the `lib/geocode.ts` side: `scheduleForwardGeocode`'s
debounce-plus-shared-queue shape, `readSearchCache`/`writeSearchCache`,
`radiusForResultType`, `placeNameFromLabel`, and the null-versus-empty-array
contract that lets the dropdown distinguish "could not search" from "nothing
found".

**Needs replacing for Photon:** `NOMINATIM_SEARCH_URL` and the query string
(`:415`), `extractSearchResults` (`:378`, Nominatim's flat
`display_name`/`lat`/`lon`/`type`/`addresstype` shape versus Photon's GeoJSON
`features[].properties`), `radiusForResultType`'s key names (Photon uses
`osm_key`/`osm_value`), and the 1 rps queue, which is a Nominatim policy
constraint that a self-hosted or public Photon does not impose in the same
form. The attribution line has to be added either way.

---

## 6. Preview picking

**Only buildings are pickable. Roads, water, green areas, trees, the base and
the frame are not.** Grep for `onClick`/`onPointer` across
`components/scene/*.tsx` returns hits in exactly one geometry component,
`InstancedBuildings.tsx:198-205`. `AreaSurfaces.tsx`, `RoadRibbons.tsx`,
`TreeInstances.tsx`, `BasePlate.tsx`, `RegionMeshes.tsx` and `TileGrid.tsx`
carry no pointer handlers at all.

**How the raycast works.** Every building is one instance of a unit box in a
single `InstancedMesh` (`InstancedBuildings.tsx:192`). r3f's `onClick` hands
back `event.instanceId`, which indexes the **`buildings` array**, not the
SceneGraph, because the preview has already dropped the footprints the bake
drops (`:23-27`, `:176`). The id it yields is
`buildings[instanceId].id`, an OSM way id string, passed to `onPick`
(`:188`), which `CityPreview.tsx:687` turns into `setCursorId(id)` plus
`toggleHero(id)`.

**Drag rejection.** `onPointerDown` records the client coordinates
(`:170`) and the click handler discards the pick if the pointer moved more
than 4 px (`:185`), so an orbit drag ending on a building is not a pick.

**Picking survives the engine swap.** Once a fresh `EngineResult` lands,
`RegionMeshes` draws the real geometry and `InstancedBuildings` stays mounted
with `hidden` (`CityPreview.tsx:690`), which sets `transparent`/`opacity:0`
and turns off shadows but leaves it in the raycast. The comment at
`InstancedBuildings.tsx:93-105` records the verification: three.js raycasting
consults neither `visible` nor material opacity, checked against
`node_modules/three/src/core/Raycaster.js`. The fused region mesh carries no
per-building identity, so this is the only path to a hero.

**Keyboard path.** `lib/heroCursor.ts` is pure data, no three.js. The walk
order is tallest first, then largest footprint, then id (`cursorOrder:37`),
chosen because OrbitControls makes any spatial "up" meaningless
(`:10-17`). `moveCursor:62` clamps at both ends rather than wrapping;
Home/End jump. `cursorStepFor:100` maps arrows to next/previous, Home/End to
first/last, Enter and Space to toggle. The viewport is the focus stop
(`CityPreview.tsx:607`, `role="application"`, `tabIndex={0}`), and
`cursorLabel:82` feeds the live region at `CityPreview.tsx:786`.

**Hero identity elsewhere.** `lib/heroes.ts` owns the cap
(`HERO_CAP = PARAM_LIMITS.hero_building_ids.max_items`, `:26`), the refusal
message (`heroCapMessage:58`, "That is the limit: N hero buildings. Remove one
to pick another."), the scoring for auto-detect (`heroCandidates:161`,
`autoHeroIds:200`) and the display name (`heroDisplayName:239`).

---

## 7. Project file, share link, undo

### Project file (`lib/project.ts`)

Shape (`:34-46`): `{format: "framecraft-project", version: 3, saved_at: ISO
8601, pin: {lat, lon}, radius_m, rotation_deg, preset_id, place, params}`.
`place` is documented as a convenience for a human reading the file; a load
reads `params.city_label` instead (`:43`).

The version field is `PROJECT_VERSION = 3` (`:30`), checked for **exact
equality** on load (`:147`), so both an older and a newer file are refused by
name. `format` is checked first (`:140`).

Extension is `.framecraft.json` (`PROJECT_FILE_EXTENSION`, `:32`). The
filename is `<slug>-<YYYY-MM-DD>.framecraft.json` where the slug is the place
name lowercased, non-alphanumerics collapsed to hyphens, capped at 60 chars
(`projectFilename:72`).

`params` is validated by `parsePrintParams` from `lib/share.ts:793`, the very
same validator a share link uses, merged over `defaultPrintParams()`. Every
rejection names what is wrong and nothing is half-applied (`:128-207`).

**Save is a plain anchor download** (`downloadProject:88`), and
`OutputPanel.tsx:177 saveProject` calls it with **no `isTauri()` gate**. That
is a gap: `lib/bake.ts:224 saveDownloadFile` exists precisely because "anchor
downloads are inert inside wry" (`apps/desktop/src-tauri/src/lib.rs:6`), and
`OutputPanel.tsx:433-440` routes the export links through it. Save project
does not, so **inside the desktop app the Save project button silently does
nothing.** Load works, because the hidden `<input type="file">`
(`OutputPanel.tsx:292`, `accept=".json,application/json"`) is a WebView
feature; a `.framecraft.json` file matches the `.json` extension filter.

The Tauri command itself (`save_export`,
`apps/desktop/src-tauri/src/lib.rs:20`) takes `filename` and a base64 payload,
calls `set_file_name(&filename)` and `blocking_save_file()`, and writes the
bytes. It sets **no file-type filter** (`add_filter` appears nowhere) and does
no extension enforcement, so a user who deletes the extension in the dialog
gets an extensionless file. `cache_dir` (`:47`) is the second command and is
currently unused by the web side beyond `platformCacheDir`
(`lib/platform.ts:58`).

### Share link (`lib/share.ts`)

Format `?s=v3.<base64url(deflate-raw(JSON))>.<fnv1a32 of the JSON, 8 hex>`
(`:6-8`). The payload is `{r: SceneRequest, p: the PrintParams that differ
from the default}` (`encodeShare:660`, `paramsDiff:645`). `SceneRequest`
carries `lat`, `lon`, `radius_m`, `rotation_deg` and `preset_id` when set.

The version tag names the **payload format**, not `schema_version` (`:11-18`).
`SHARE_VERSION = "v3"` is what is written; `DECODABLE_VERSIONS = ["v2","v3"]`
is what is read, so uncompressed v2 links still decode (`:73`, `:712`).

Not encoded, deliberately: the SceneGraph, the engine result, the bake state,
the collapse state, the theme, the search query, the recents list and the undo
history. A restore therefore marks the scene stale and stops
(`store/editor.ts:902 applyShared`), because "opening a link in a background
tab is not consent to" an Overpass query (`:893-897`).

`SHARE_LINK_LENGTH_LIMIT = 8000` (`:88`) is a UI guard only, not a decode
guard; past it `OutputPanel.tsx:153` shows `share-too-large` and points at the
project file instead.

### Undo (`store/history.ts`)

Covers `location` and `params` only (`HistorySnapshot:34`). Explicitly not
covered (`:16-19`): `scene`, `engine`, `bake`, `placeDetect`, `terrain` and
the transient UI flags. So a geocode result, a running engine job and a bake's
progress stay out of history.

Also **not covered, and worth stating for the shell rebuild**: no UI layout
state is in history. Group collapse, the bottom sheet, the Output fold, the
drawers, the theme, the preview camera and the search box's own query, results
and dropdown state (`SearchBox.tsx:27-33`, local component state) are all
outside it. The search box's docstring at `SearchBox.tsx:21` says so
explicitly: history sees only the resulting `setPin`/`setRadius`.

Recording works by subscribing to the editor store and diffing by reference
(`initHistory:244`), not by instrumenting the twenty-odd setters. Because
zustand notifies once per `set()` call, a palette apply, a project load, a
share restore and auto-fix-all each land as exactly one step for free
(`:9-15`). Cap is `HISTORY_CAP = 100` (`:48`), coalescing window
`HISTORY_COALESCE_MS = 800` ms keyed on the changed leaf's path (`:49`,
`:92`). Undo/redo write back through `applyHistorySnapshot`
(`store/editor.ts:847`) using the exact snapshot object the entry holds, which
is how the subscriber recognises its own jump without a re-entrancy flag
(`history.ts:273-280`). A recorder exception is caught and logged rather than
allowed to break other zustand listeners (`:251-263`).

Labels come from `describeChange:198`, which prefers preset, then radius, then
rotation, then pin, then the first differing `PrintParams` key, diving one
level into a nested group to name the leaf.

### Recents (`lib/recent.ts`)

A recent design **is** a share payload (`:23`), so restoring one runs
`decodeShare` exactly like a link (`RecentDesigns.tsx:38`). Recorded on a
successful Copy-link and on every successful bake
(`OutputPanel.tsx:142,210`). Cap 12 (`RECENT_CAP:16`), deduplicated by
payload. Writes fire a `framecraft:recent-changed` CustomEvent (`:52`) so the
list refreshes without polling.

---

## 8. Tests

### e2e (`apps/web/e2e/*.spec.ts`)

| Spec | What it asserts |
|---|---|
| `smoke.spec.ts` | The happy path (Chicago preset previews, sliders stay local, a bake downloads a 3MF); an empty Overpass response warns and disables Bake; both downloaded files pass the Python printability validator (small scene and full Chicago); a Bambu project writes every region on its own extruder |
| `ui.spec.ts` | 15 tests: self-hosted fonts, group collapse persisting across a reload, the v2 personalisation fields never fetching, slot-colour conflicts and the one-click align, an engraving appearing on the frame, a keyhole disabling Bake, the detail chip and its radius remedy, hero true height, the adjustments chip and drawer, the keyboard sheet, sheet modality, Escape focus return, keyboard hero picking, click hero picking, auto-detect on real landmarks, `{hero}` resolving live, tablet bottom sheet, desktop static column, phone notice, and the empty viewport copy |
| `a11y.spec.ts` | axe clean in both themes across every state; every panel control has an accessible name; a real 120-press Tab walk asserting order, required ids, required test ids, one stop per radiogroup, and a visible focus ring on every stop |
| `colour.spec.ts` | Applying Blueprint recolours the rows and the preview; saving and reapplying a custom palette; a clashing pair raising the contrast warning; the preview theme changing only the canvas; the ogee profile plus a shadow gap still downloading |
| `print.spec.ts` | Selecting the P1S applies its plate and its 250 mm ceiling; switching back to custom leaves the sliders alone; a finding's fix button clearing it; 2x2 tiling showing four labels and exporting |
| `lettering.spec.ts` | `{city}` resolving in the preview, the Resolved output panel and the baked sidecar; an empty label warning; Frame off disabling lettering |
| `share.spec.ts` | A copied link restoring the whole editor in a fresh browser; an unreadable version refused not half-applied; a truncated link reported as damaged |
| `terrain.spec.ts` | Enabling terrain fetches a mocked elevation tile and the model stays baked; terrain does not block an engraving |
| `workflow.spec.ts` | Search picks a place, moves the pin and fills the place name; three settings plus Ctrl+Z twice reverting with the chip following; save/reload/load returning every setting; a copied link restoring in a fresh context |

**Which of these the rename or the shell rebuild will move.** All nine specs
touch a bake or generate id or string (140 lines, section 4.3). The ones that
assert the visible **text** rather than a test id, and so break on a rename
rather than on an id change:

- `smoke.spec.ts:332` `toHaveText(/^Generate$/)`.
- `smoke.spec.ts:367` `toContainText("Done")` and `:425`
  `toContainText("outdated")`, both from `bakeStatusLabel`.
- `smoke.spec.ts:457` and `ui.spec.ts:421,424` assert `bake-block-reason`
  text, which is `lib/warnings.ts`'s wording.

The ones the shell rebuild will move, because they assert layout:

- `ui.spec.ts:888` tablet bottom sheet, `:942` desktop static column,
  `:953` phone notice, `:971` the empty-viewport copy.
- `ui.spec.ts:161` group collapse and its localStorage persistence.
- `a11y.spec.ts:224` the Tab walk, which asserts DOM order matches reading
  order across the whole shell and requires `shortcuts-button`,
  `theme-toggle`, `reset-button`, `bake-button`, `preview-canvas`,
  `copy-link-button` and `advisor-use-radius` to be reached (`:347-364`), and
  asserts `generate-button` is absent because it is disabled (`:383`).

### vitest that pins UI structure

| File | What it pins |
|---|---|
| `components/scene/CityPreview.test.ts` | The `previewDeps` contract: no key names `params` or anything derived from it; a height slider rebuilds no geometry; each parameter rebuilds exactly the listed layers; the v2 paint block rebuilds nothing; the v2 lettering block rebuilds only `text`; the v3 engine block rebuilds nothing; `hero_auto` and the printer profile rebuild only `height`; and a coverage test (`:366`) that walks **every key of the frozen contract**, so a new field with no dep entry fails here |
| `components/scene/CityPreview.hud.test.ts` | A source guard: the minimum-wall clause comes from `dilatedNotice`, is called exactly once, names no other threshold, and the string itself stays in `lib/preview.ts` |
| `components/editor/Controls.test.ts` | `isValueChangingKey` accepts only the keys a range input responds to; the real `createCommitGate` does not commit on no change, commits once after a change, coalesces five arrow taps into one request, and drops a pending commit on unmount |
| `lib/groups.test.ts` | The group table names ten groups; every group has a title and a summary; the three personalisation groups plus terrain start collapsed; `mergeCollapsed` falls back to the defaults for a corrupt, partial, non-object or unknown-key value; `loadCollapsed` survives private mode and SSR; a real round trip |
| `lib/keyboard.test.ts` | The four action keys, capitals, Shift+/, chord refusal, typing-target refusal, Ctrl+Z and Cmd+Z, Alt refusal, no hijack of a field's native undo, and that the sheet's list documents every action the dispatcher can produce and marks display-only rows as such |
| `lib/contrast.test.ts` | WCAG AA: 4.5:1 for every text pair in both themes, 3:1 for every control boundary, the decorative hairline kept separate from the control boundary, and that every file drawing a control edge uses the boundary token |
| `lib/design-tokens.test.ts` | No raw hex colour outside the one allowlisted token file, in any spelling; every light token redefined for dark; the theme mapped through `var()` |
| `components/editor/InstancedBuildings.test.ts` | `matrixDeps`, the instance-matrix rebuild key |
| `store/editor.test.ts` | Every key of the frozen contract driven through `setParam` with `fetch` spied on, failing if any setter reaches the network |

Note for the rename: `lib/keyboard.test.ts:111-134` asserts the shortcut sheet
list is complete against the dispatcher, so renaming the `bake` action means
touching `Shortcut`, `SHORTCUTS`, `shortcutFor`, `EditorShell`'s switch and
this test together.
