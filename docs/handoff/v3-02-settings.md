# v3-02 settings: the truth audit

Task 2 of the v3.1 run. Written against the tree after the pipeline landed
(`docs/handoff/v3-01-pipeline.md`), the inventory that counted the controls
(`docs/handoff/v3-02-inventory.md` section 1) and the rulings in
`DECISIONS.md` `[V3.1-P1-2]`, `[V3.1-P1-13]` and `[V3.1-O6]`.

## 1. What decides the answer now

Before the pipeline, "does this control do anything?" was a grep. It is now a
lookup. Every stage declares the `PrintParams` leaves it reads
(`lib/engine/pipeline/stages.ts`, readable as `describeGraph()`), the preview
draws the pipeline's own region solids, and the export runs the same stages
and writes their output. So:

> A leaf claimed by a stage moves the preview and the file. A leaf no stage
> claims moves neither.

That is the whole audit. A control writing a claimed leaf is real; a control
writing an unclaimed leaf is decoration and this wave removed it.

Eight leaves are claimed by nothing: the seven `part_colors.*` and
`colour.region_colors.attribution`. Both are ruled exemptions
(`[V3.1-P1-2]` and `[V3.1-P1-13]`), and they are two of the four exemption
ENTRIES the rulings name. The other two, `schema_version` and
`colour.preview_theme`, are claimed by the `export` stage alone for the
sidecar echo, so they are exempt from the matrix rather than from the
registry. No control may write any of the four.

## 2. The catalog

`apps/web/lib/controlCatalog.ts` is new, and is now the single source of truth
for every control's id, group, kind, label, help string, test id and the leaf
paths it writes. Every group component reads its labels and help strings from
it, so the copy a user reads, the copy Task 5's settings search will index and
the copy the tests assert are one string in one place.

**96 rows: 95 controls the settings panel renders, plus the export-format
select**, which lives in `ExportMenu.tsx` (the action-bar task's file) and is
catalogued here only so its help string exists.

`lib/controlCatalog.test.ts` holds the audit to it, with 17 tests:

- every path a control names is a real `PRINT_PARAM_LEAF_PATHS` entry;
- every path a control names is claimed by a stage, so no control is
  decorative;
- no control writes one of the four matrix exemptions, nor `schema_version`,
  nor `colour.preview_theme`;
- every claimed leaf with no control is listed with its reason (section 5), so
  a gap cannot go quiet again;
- no control writes a leaf in the matrix's own `KNOWN_DEFECTS`. Stage claims
  are wildcards (`frame_style.*` claims every leaf under it), so "claimed" is
  not proof that anything reads a field; `KNOWN_DEFECTS` is the list of leaves
  whose probe fails because the engine is wrong, and a control for one of
  those is a control shipping ahead of its effect;
- **every control the group components render has a row**. This one walks
  every `.tsx` under `components/editor` recursively, partitions it into
  scanned files and files declared out of scope with a reason, and parses the
  scanned ones with a brace-aware JSX scanner (a regex cannot find the end of
  an open tag: `onClick={() => f(a, b)}` alone carries two characters that
  would end it early; block comments are blanked first, because a JSDoc line
  reading "a real `<button>`" is prose). It fails when a control has no
  catalog row, when a row names a control nothing renders, when a control
  carries no id, test id or catalog call at all, or when a new component is
  neither scanned nor excluded;
- no control carries its help as a `title` alone: a scanned open tag with
  `title={labelled(...)}` and no `aria-describedby` fails;
- the removed controls stay removed, asserted against the comment-stripped
  sources.

The behavioural half of `[V3.1-P1-13]` lives in
`components/editor/groups/ColourGroup.test.ts` (7 tests), because the catalog's
own exemption test reads the catalog's `writes` array and can only confirm what
the catalog says about itself. That file drives the real patch builders the
three colour buttons call, over every built-in palette, a real eleven-to-two
merge and a real align whose fixture makes `attribution` a loser, pushes each
patch through the real store setter, and reads
`params.colour.region_colors.attribution` back.

## 3. The table

Preview effect names the stages that re-run and what the matrix probe measured
changing. Export effect says what moves in the written file. Test names the
`lib/engine/pipeline/matrix.test.ts` probe where the matrix agent landed one,
and the catalog test plus the graph claim otherwise (which is the case for
every non-parameter control, since the matrix only probes `PrintParams`).

| Group | Control | Label | Field | Preview effect (stage, and what changes) | Export effect | Test |
|---|---|---|---|---|---|---|
| location | `city_label` | Place name | `city_label` | `tokens`, `export`: the label is what `{city}` expands to, and it also names the file and the 3MF title | the region solids, in every target | matrix `city_label = "Riverside"` |
| location | `reset-place-name` | Reset to detected | `city_label` | `tokens`, `export`: the label is what `{city}` expands to, and it also names the file and the 3MF title | the region solids, in every target | matrix `city_label = "Riverside"` |
| location | `author` | Author | `place.author` | `tokens`, `export`: the author is both the `{author}` token and the Designer every exported file is stamped with | the region solids, in every target | matrix `place.author = "Bee"` |
| location | `radius_m` | Radius | (location) | no stage: it is not a print parameter, see the column to the left | a different crop, so every solid in every target | `controlCatalog.test.ts` + `graph.test.ts` |
| location | `rotation_deg` | Rotation | (location) | no stage: it is not a print parameter, see the column to the left | a different crop, so every solid in every target | `controlCatalog.test.ts` + `graph.test.ts` |
| scale | `plate_mm` | Plate size | `plate_mm` | `context`, `tokens`, `lettering` and 7 more: the plate is the printed square, so the base region and every part placed on it grow with it | the region solids, in every target | matrix `plate_mm = 220` |
| scale | `base_thickness_mm` | Base thickness | `base_thickness_mm` | `context`, `repair-buildings`, `buildings` and 8 more: the plate gets thicker, so the base region is taller and everything standing on it is lifted | the region solids, in every target | matrix `base_thickness_mm = 5` |
| scale | `nozzle_mm` | Nozzle diameter | `nozzle_mm` | `context`, `trees`, `lettering` and 8 more: a wider nozzle doubles the minimum wall, which coarsens the plate's cuts and fattens the tree cones | the region solids, in every target | matrix `nozzle_mm = 0.8` |
| buildings | `small_scale` | Small building scale | `small_scale` | `repair-buildings`, `buildings`: small footprints are dilated so they survive the nozzle, which adds material to the buildings region without changi... | the region solids, in every target | matrix `small_scale = 1.5` |
| buildings | `large_scale` | Large building scale | `large_scale` | `repair-buildings`, `buildings`, `validate`: tall buildings are stretched, so the model's printed height doubles and trips the height ceiling | the region solids, in every target | matrix `large_scale = 2` |
| buildings | `hero-remove` | Remove | `hero_building_ids` | `heroes`, `tokens`: the named building is lifted out of the buildings region into its own hero region | the region solids, in every target | matrix `hero_building_ids = ["b-tall"]` |
| buildings | `hero-clear-all` | Clear all | `hero_building_ids` | `heroes`, `tokens`: the named building is lifted out of the buildings region into its own hero region | the region solids, in every target | matrix `hero_building_ids = ["b-tall"]` |
| buildings | `hero_auto_enabled` | Auto-detect heroes | `hero_auto.enabled` | `heroes`, `tokens`: the worker scores the scene's buildings and promotes the top ones, which on this three-building block is all of them | the region solids, in every target | matrix `hero_auto.enabled = true` |
| buildings | `hero_auto_count` | Auto-detected count | `hero_auto.count` | `heroes`, `tokens`: how many buildings the automatic pick promotes: three leaves nothing behind, one leaves two ordinary buildings | the region solids, in every target | matrix `hero_auto.count = 1` |
| heights | `heights_floor_height_m` | Floor height | `heights.floor_height_m` | `normalise`: a storey's height, applied to the building tagged with three levels and no height | the region solids, in every target | matrix `heights.floor_height_m = 8` |
| heights | `heights_unknown_default_m` | Unknown building default | `heights.unknown_default_m` | `normalise`: the height a building with no height, no storeys and no recognised type is given | the region solids, in every target | matrix `heights.unknown_default_m = 40` |
| heights | `height_exaggeration_multiplier` | Height exaggeration | `height_exaggeration.multiplier` | `buildings`: every building's printed height above the plate is multiplied, so the model gets taller without changing footprint | the region solids, in every target | matrix `height_exaggeration.multiplier = 1.8` |
| heights | `height_exaggeration_curve` | Exaggeration curve | `height_exaggeration.curve` | `buildings`: the curve compresses tall buildings towards the short ones, so the tallest loses height while the footprints stay | the region solids, in every target | matrix `height_exaggeration.curve = 0.8` |
| surface | `road_mode` | Road mode | `road_mode` | `surface-roads`, `bridges`, `hangers` and 1 more: roads off removes the roads region entirely and leaves the plate uncarved where they ran | the region solids, in every target | matrix `road_mode = "off"` |
| surface | `road_scale` | Road scale | `road_scale` | `surface-rail`, `surface-roads`, `bridges`: the road ribbon is drawn twice as wide, so the roads region widens across the centreline | the region solids, in every target | matrix `road_scale = 2` |
| surface | `water` | Water | `water` | `surface-water`, `hangers`, `frame-cutters`: the pond stops being built, so the water region and its filament slot leave the file | the region solids, in every target | matrix `water = false` |
| surface | `trees` | Trees | `trees` | `trees`, `audit`: the tree cones are unioned into the parks region, so switching them off flattens parks to its bare surface | the region solids, in every target | matrix `trees = false` |
| terrain | `terrain_enabled` | Terrain | `terrain.enabled` | `terrain`: the hillside is draped over the plate, which lifts the plate top and every surface with it | the region solids, in every target | matrix `terrain.enabled = true` |
| terrain | `terrain_exaggeration` | Vertical exaggeration | `terrain_exaggeration` | `terrain`, `measure`, `validate`: the hillside's printed relief is multiplied, so the draped plate and everything on it climb | the region solids, in every target | matrix `terrain_exaggeration = 2.5` |
| terrain | `terrain_smoothing` | Smoothing | `terrain.smoothing` | `terrain`: the heightfield is blurred before it drapes, so the printed relief drops | the region solids, in every target | matrix `terrain.smoothing = 6` |
| frame | `frame` | Frame | `frame` | `context`, `surface-parks`, `tokens` and 11 more: no frame means no frame region, no lip for the mandatory wall mark, and a wider city on the same plate | the region solids, in every target | matrix `frame = false` |
| frame | `frame-profile-*` | Frame profile | `frame_style.profile` | `context`, `lettering`, `ornaments` and 5 more: the profile is the frame's cross-section, so a chamfer rebuilds the lip with a sloped face | the region solids, in every target | matrix `frame_style.profile = "chamfer"` |
| frame | `frame_style_corner` | Corners | `frame_style.corner` | `lettering`, `ornaments`, `attribution` and 3 more: the frame's outer corners are filleted, which adds the arc's facets without changing the enclosed volume | the region solids, in every target | matrix `frame_style.corner = "rounded"` |
| frame | `frame_style_corner_radius_mm` | Corner radius | `frame_style.corner_radius_mm` | `lettering`, `ornaments`, `attribution` and 3 more: how big the corner fillet is, which changes how the arc is faceted | the region solids, in every target | matrix `frame_style.corner_radius_mm = 9` |
| frame | `frame_style_shadow_gap_enabled` | Add a shadow gap | `frame_style.shadow_gap.enabled` | `context`, `lettering`, `ornaments` and 4 more: a recessed channel is cut into the plate all round the city, so the frame reads as floating above it | the region solids, in every target | matrix `frame_style.shadow_gap.enabled = true` |
| frame | `frame_style_shadow_gap_width_mm` | Width | `frame_style.shadow_gap.width_mm` | `context`, `lettering`, `ornaments` and 4 more: how wide the channel is, so a wider gap takes more plate material at the same triangle count | the region solids, in every target | matrix `frame_style.shadow_gap.width_mm = 2.5` |
| frame | `frame_style_shadow_gap_depth_mm` | Depth | `frame_style.shadow_gap.depth_mm` | `lettering`, `ornaments`, `attribution` and 3 more: how deep the channel is cut, so a deeper gap takes more plate material at the same triangle count | the region solids, in every target | matrix `frame_style.shadow_gap.depth_mm = 2` |
| frame | `frame_style_matting_enabled` | Add matting | `frame_style.matting.enabled` | `context`, `lettering`, `ornaments` and 4 more: a mount board is built between the frame and the city, as its own region on its own filament | the region solids, in every target | matrix `frame_style.matting.enabled = true` |
| frame | `frame_style_matting_width_mm` | Width | `frame_style.matting.width_mm` | `context`, `lettering`, `ornaments` and 4 more: how far the mount board reaches inwards, which also crops the city under it | the region solids, in every target | matrix `frame_style.matting.width_mm = 12` |
| frame | `frame_style_matting_proud_mm` | Standing proud | `frame_style.matting.proud_mm` | `lettering`, `ornaments`, `attribution` and 3 more: how far the mount board stands above the plate, so it gets thicker | the region solids, in every target | matrix `frame_style.matting.proud_mm = 1.2` |
| frame | `frame_style_separate_enabled` | Print the frame separately | `frame_style.separate.enabled` | `lettering`, `ornaments`, `attribution` and 3 more: the frame becomes a separate printed part that mates with the plate, so both bodies are rebuilt around the joint | the region solids, in every target | matrix `frame_style.separate.enabled = true` |
| frame | `frame_style_separate_mount` | Mount | `frame_style.separate.mount` | `lettering`, `ornaments`, `attribution` and 3 more: how the separate frame is held on: a snap ridge is one continuous rib, magnets are discrete pockets in both parts | the region solids, in every target | matrix `frame_style.separate.mount = "magnet"` |
| frame | `frame_style_separate_tolerance_mm` | Fit tolerance | `frame_style.separate.tolerance_mm` | `lettering`, `ornaments`, `attribution` and 3 more: the clearance in the frame-to-plate joint, so a looser fit lifts the frame's underside and thins it | the region solids, in every target | matrix `frame_style.separate.tolerance_mm = 0.6` |
| frame | `frame_style_texture_pattern` | Pattern | `frame_style.texture.pattern` | `lettering`, `ornaments`, `attribution` and 3 more: the pattern milled into the frame's top face, so a knurl replaces a flat face with a field of pyramids | the region solids, in every target | matrix `frame_style.texture.pattern = "knurl"` |
| frame | `frame_style_texture_scale_mm` | Pattern scale | `frame_style.texture.scale_mm` | `lettering`, `ornaments`, `attribution` and 3 more: the pitch of the pattern, so a coarser knurl has fewer, larger cells | the region solids, in every target | matrix `frame_style.texture.scale_mm = 5` |
| frame | `frame_style_texture_depth_mm` | Pattern depth | `frame_style.texture.depth_mm` | `lettering`, `ornaments`, `attribution` and 3 more: how deep the pattern is cut, so a deeper knurl takes more frame material | the region solids, in every target | matrix `frame_style.texture.depth_mm = 0.45` |
| frame | `north_arrow_enabled` | Show a north arrow | `north_arrow.enabled` | `lettering`: the arrow is a pocket in the lip, so switching it off removes one resolved line and one ornament band | the region solids, in every target | matrix `north_arrow.enabled = false` |
| frame | `north_arrow_corner` | Corner | `north_arrow.corner` | `lettering`: the arrow moves from the north-east corner of the lip to the south-west one | the region solids, in every target | matrix `north_arrow.corner = "sw"` |
| frame | `north_arrow_size_mm` | Size | `north_arrow.size_mm` | `lettering`: a smaller arrow is cut, and the engine reports the length it used after the lip's own clamp | the region solids, in every target | matrix `north_arrow.size_mm = 2` |
| frame | `scale_bar_enabled` | Show a scale bar | `scale_bar.enabled` | `fonts`, `lettering`: the bar and its label are pockets in the lip, so switching them off removes a resolved line and most of the lip's c... | the region solids, in every target | matrix `scale_bar.enabled = false` |
| frame | `scale_bar_edge` | Edge | `scale_bar.edge` | `lettering`: the bar moves from the south rail of the lip to the north one | the region solids, in every target | matrix `scale_bar.edge = "top"` |
| frame | `scale_bar_length_mode` | Length | `scale_bar.length_mode` | `lettering`: auto picks the roundest ground length that prints inside the 15 to 40 mm window instead of the fixed 40 m | the region solids, in every target | matrix `scale_bar.length_mode = "auto"` |
| frame | `scale_bar_length_m` | Ground length | `scale_bar.length_m` | `lettering`: the fixed ground length the bar stands for, and therefore its printed length and its label | the region solids, in every target | matrix `scale_bar.length_m = 90` |
| frame | `underside_mark_enabled` | Mark the underside | `underside_mark.enabled` | `lettering`, `attribution`, `measure`: the owner's own underside line stops being cut into the plate | the region solids, in every target | matrix `underside_mark.enabled = false` |
| frame | `underside_mark_template` | Template | `underside_mark.template` | `lettering`, `attribution`: the template is the string cut underneath, after token expansion | the region solids, in every target | matrix `underside_mark.template = "{city}"` |
| frame | `hanger` | Fitting | `hanger` | `lettering`, `ornaments`, `attribution` and 3 more: a French cleat is a second printable part plus its mating pocket in the plate | the region solids, in every target | matrix `hanger = "cleat"` |
| frame | `hanger_magnet_diameter_mm` | Magnet diameter | `hanger_magnet.diameter_mm` | `frame-cutters`: how wide the magnet pockets are bored in the frame and the plate, at the same pocket count | the region solids, in every target | matrix `hanger_magnet.diameter_mm = 4` |
| frame | `hanger_magnet_thickness_mm` | Magnet thickness | `hanger_magnet.thickness_mm` | `frame-cutters`: how deep the magnet pockets are bored, so a thinner magnet leaves more material behind | the region solids, in every target | matrix `hanger_magnet.thickness_mm = 1` |
| frame | `hanger_magnet_count` | Magnet count | `hanger_magnet.count` | `frame-cutters`: how many magnets are set into each side of the joint, so twice as many pockets are bored | the region solids, in every target | matrix `hanger_magnet.count = 4` |
| frame | `engraving-add` | Add a line of lettering | `engravings[].edge` and 6 more | `fonts`, `lettering`: the same glyphs are cut into the opposite edge, so the pocket floors move from the north rail to the south one | the region solids, in every target | matrix `engravings[].edge = "bottom"` |
| frame | `engraving_*-remove` | Remove | `engravings[].edge` and 6 more | `fonts`, `lettering`: the same glyphs are cut into the opposite edge, so the pocket floors move from the north rail to the south one | the region solids, in every target | matrix `engravings[].edge = "bottom"` |
| frame | `engraving_*_text` | Text | `engravings[].text` | `lettering`: a different string cuts different glyphs into the frame lip | the region solids, in every target | matrix `engravings[].text = "ZZZ"` |
| frame | `engraving_*_edge` | Edge | `engravings[].edge` | `fonts`, `lettering`: the same glyphs are cut into the opposite edge, so the pocket floors move from the north rail to the south one | the region solids, in every target | matrix `engravings[].edge = "bottom"` |
| frame | `engraving_*_align` | Align | `engravings[].align` | `lettering`: the line slides to the end of its edge: the same glyph pockets, a different span along x | the region solids, in every target | matrix `engravings[].align = "end"` |
| frame | `engraving_*_mode` | Mode | `engravings[].mode` | `lettering`: an inlay fills the pocket with a second body, which is the only thing that builds a lettering region | the region solids, in every target | matrix `engravings[].mode = "inlay"` |
| frame | `engraving_*_font` | Font | `engravings[].font` | `fonts`, `lettering`: a different face means different glyph outlines for the same string | the region solids, in every target | matrix `engravings[].font = "serif"` |
| frame | `engraving_*_size_mm` | Cap height | `engravings[].size_mm` | `lettering`: bigger glyphs are cut, and the engine reports the cap height it could actually fit on the lip | the region solids, in every target | matrix `engravings[].size_mm = 7` |
| frame | `engraving_*_depth_mm` | Depth | `engravings[].depth_mm` | `lettering`: the pocket is cut deeper: the same glyph outline, a floor 0.6 mm lower and that much less frame material | the region solids, in every target | matrix `engravings[].depth_mm = 1` |
| colour | `color_mode` | Colour | `color_mode` | `export`: single mode writes the welded solid as one object; parts mode writes one object per region with a base material each | one merged object or one per region in the generic 3MF, the OBJ and the STEP; the Bambu project always writes one per region | matrix `color_mode = "parts"` |
| colour | `hero_mode` | Hero buildings print as | `hero_mode` | `repair-buildings`, `finish-hero_building`: the hero stops borrowing the buildings filament and takes its own slot and colour | the region solids and their slot and colour tables, in every target | matrix `hero_mode = "own_color"` |
| colour | `palette-apply-*` | Apply palette | `colour.region_colors.base` and 21 more | `finish-base`, `finish-easel`, `finish-cleat` and 20 more: the colour the base region carries into the preview, the sidecar's region table and slot 1's filament | every region's colour and slot in every target, and `framecraft:palette` in both 3MF writers | matrix `colour.region_colors.base = "#112233"` |
| colour | `palette-delete-*` | Delete | (object-override) | no stage: it is not a print parameter, see the column to the left | nothing: the palette library is this browser's | `controlCatalog.test.ts` + `graph.test.ts` |
| colour | `palette-save-name` | Save current colours as | (object-override) | no stage: it is not a print parameter, see the column to the left | nothing: the palette library is this browser's | `controlCatalog.test.ts` + `graph.test.ts` |
| colour | `palette-save` | Save | `colour.palette` | `export`: the palette names the swatch set the colours came from; it is provenance, written into the 3MF metadata and the sid... | `framecraft:palette` in both 3MF writers and `colour_palette` in the sidecar; no solid moves | matrix `colour.palette = "dusk"` |
| colour | `colour_slot_*` | Filament slot | `colour.region_slots.base` and 10 more | `finish-base`, `finish-easel`, `finish-cleat` and 11 more: the filament slot the base region prints on, written into the file as that part's extruder | the region solids and their slot and colour tables, in every target | matrix `colour.region_slots.base = 3` |
| colour | `colour_color_*` | Colour | `colour.region_colors.base` and 10 more | `finish-base`, `finish-easel`, `finish-cleat` and 19 more: the colour the base region carries into the preview, the sidecar's region table and slot 1's filament | the region solids and their slot and colour tables, in every target | matrix `colour.region_colors.base = "#112233"` |
| colour | `align-slot-colours` | Align colours to what will print | `colour.region_colors.base` and 10 more | `finish-base`, `finish-easel`, `finish-cleat` and 19 more: the colour the base region carries into the preview, the sidecar's region table and slot 1's filament | the region solids and their slot and colour tables, in every target | matrix `colour.region_colors.base = "#112233"` |
| colour | `merge-to-profile-slots` | Merge to profile slots | `colour.region_slots.base` and 21 more | `finish-base`, `finish-easel`, `finish-cleat` and 20 more: the filament slot the base region prints on, written into the file as that part's extruder | the region solids and their slot and colour tables, in every target | matrix `colour.region_slots.base = 3` |
| colour | `colour_tint_enabled` | Vary building colour | `colour.tint.enabled` | `buildings`: the tint gives every building its own shade, which the OBJ writer turns into one material per building | the region solids, in every target | matrix `colour.tint.enabled = false` |
| colour | `colour_tint_hue` | Hue range | `colour.tint.hue_range_deg` | `buildings`: how far around the hue wheel the per-building shades may wander | the region solids, in every target | matrix `colour.tint.hue_range_deg = 90` |
| colour | `colour_tint_lightness` | Lightness range | `colour.tint.lightness_range` | `buildings`: how far up and down in lightness the per-building shades may wander | the region solids, in every target | matrix `colour.tint.lightness_range = 0.5` |
| colour | `colour-tint-reroll` | Reroll | `colour.tint.seed` | `buildings`: the seed that decides which building gets which shade | the region solids, in every target | matrix `colour.tint.seed = 9` |
| colour | `colour_gradient_enabled` | Band buildings by height | `colour.gradient.enabled` | `buildings`, `finish-buildings`, `finish-hero_building` and 7 more: the buildings are split into height bands, each its own region on its own filament slot | the region solids and their slot and colour tables, in every target | matrix `colour.gradient.enabled = true` |
| colour | `colour_gradient_bands` | Bands | `colour.gradient.slots` | `buildings`, `finish-buildings`, `finish-hero_building` and 7 more: the slot list is the band count: four entries split the buildings into more bands than two, and each band takes its... | the region solids and their slot and colour tables, in every target | matrix `colour.gradient.slots = [2,3,4,1]` |
| colour | `colour-gradient-band-slot-*` | Band filament slot | `colour.gradient.slots` | `buildings`, `finish-buildings`, `finish-hero_building` and 7 more: the slot list is the band count: four entries split the buildings into more bands than two, and each band takes its... | the region solids and their slot and colour tables, in every target | matrix `colour.gradient.slots = [2,3,4,1]` |
| printer | `printer_profile` | Printer profile | `plate_mm`, `nozzle_mm`, `printer_profile` | `context`, `tokens`, `lettering` and 11 more: the plate is the printed square, so the base region and every part placed on it grow with it | the printer named in the sidecar and the Bambu project's machine and slot table; no solid moves | matrix `plate_mm = 220` |
| printer | `custom_profile_plate_x_mm` | Plate width | `custom_profile.plate_x_mm` | `validate`, `audit`, `export`: the custom bed's width: a 180 mm plate no longer fits across it, and the file says the bed is narrower | the plate size in the sidecar and the plate-fit finding; no solid moves | matrix `custom_profile.plate_x_mm = 120` |
| printer | `custom_profile_plate_y_mm` | Plate depth | `custom_profile.plate_y_mm` | `validate`, `audit`, `export`: the custom bed's depth: the same plate no longer fits front to back, and the file says the bed is shallower | the plate size in the sidecar and the plate-fit finding; no solid moves | matrix `custom_profile.plate_y_mm = 120` |
| printer | `custom_profile_max_height_mm` | Height ceiling | `custom_profile.max_height_mm` | `validate`, `audit`, `export`: the Z ceiling the build is judged against, which the validator reads back out of the sidecar | `printable_height` in the Bambu project and `max_height_mm` in the sidecar, plus the too-tall finding; no solid moves | matrix `custom_profile.max_height_mm = 20` |
| printer | `custom_profile_slots` | Filament slots | `custom_profile.slots` | `validate`, `audit`, `export`: how many filaments the custom machine can address, which decides whether the regions' slots are reachable | the filament slot count in the Bambu project and the sidecar; no solid moves | matrix `custom_profile.slots = 2` |
| printer | `custom_profile_change_gcode` | Colour-change command | `custom_profile.change_gcode` | `validate`, `audit`, `export`: the command the colour-change project tells the slicer to run at each filament swap | `change_filament_gcode` in the Bambu project and the colour-change plan; no solid moves | matrix `custom_profile.change_gcode = "M601"` |
| printer | `tiling_enabled` | Split into tiles | `tiling.enabled` | `fonts`, `tiling`, `audit`: tiling splits the model into printable pieces and writes a zip of them; off, it is one model in one file | the region solids, in every target | matrix `tiling.enabled = false` |
| printer | `tiling_cols` | Columns | `tiling.cols` | `tiling`, `audit`: how many columns the plate is cut into, so a third column of tiles appears and each tile is narrower | the region solids, in every target | matrix `tiling.cols = 3` |
| printer | `tiling_rows` | Rows | `tiling.rows` | `tiling`, `audit`: how many rows the plate is cut into, so a third row of tiles appears | the region solids, in every target | matrix `tiling.rows = 3` |
| printer | `tiling_joint` | Joint | `tiling.joint` | `tiling`, `audit`: the shape cut into the seam so two tiles register with each other: a dovetail and a pin are different geometry | the region solids, in every target | matrix `tiling.joint = "pin"` |
| printer | `tiling_tolerance_mm` | Joint tolerance | `tiling.tolerance_mm` | `tiling`, `audit`: the clearance left in every joint, so a looser fit removes material from the tiles that carry the sockets | the region solids, in every target | matrix `tiling.tolerance_mm = 0.6` |
| printer | `tiling_index_mark` | Mark tile index | `tiling.index_mark` | `fonts`, `tiling`, `audit`: the grid reference engraved into each tile's underside, so switching it off removes those pockets from every tile | the region solids, in every target | matrix `tiling.index_mark = false` |
| output | `group-*-toggle` | Group header | (viewer) | no stage: it is not a print parameter, see the column to the left | nothing: presentation only | `controlCatalog.test.ts` + `graph.test.ts` |
| output | `reset-button` | Reset all | (all-parameters) | no stage: it is not a print parameter, see the column to the left | everything below, back at the defaults | `controlCatalog.test.ts` + `graph.test.ts` |
| output | `group-output-toggle` | Output | (viewer) | no stage: it is not a print parameter, see the column to the left | nothing: presentation only | `controlCatalog.test.ts` + `graph.test.ts` |
| output | `export_target` | Export format | `export_target` | `export`: the target is the file format the export stage writes, and each one writes a different set of files | which files the Export action writes | matrix `export_target = "stl"` |

## 4. Removed

| Removed | Where it was | Why |
|---|---|---|
| The **Lip depth** slider (`frame_style_lip_depth_mm`), its catalog row, its help string and its table row | `FrameTextGroup.tsx` | `frame_style.lip_depth_mm` is in the matrix's `KNOWN_DEFECTS`: `solid/frame.ts` resolves it into `FrameStyle.lipDepthMm` and nothing reads that field, so it moves no geometry at any profile. `[V3.1-P2-2]` lands the sight-edge rebate in the next wave and that wave re-adds the control with it. A control must never ship ahead of its effect. |
| The seven part-colour wells (`part_color_base`, `_frame`, `_buildings`, `_roads`, `_water`, `_green`, `_trees`) and the "Part colours" block around them | `ColourGroup.tsx` | `part_colors.*` is the v1 colour block and no pipeline stage claims a single one of its seven leaves, so the wells changed nothing in any exported file. `[V3.1-P1-2]`. The real wells are the per-region ones in Filament slots. |
| The `part-colors-disabled-note` ("Switch to one filament per part to change these") | `ColourGroup.tsx` | It explained the state of controls that no longer exist. |
| The attribution colour well (`colour-color-attribution`) | `ColourGroup.tsx`, filament-slot rows | The mandatory attribution marks are engraved cuts into the base and the frame, never a body, so no stage ever asks for their colour and no value there could reach a file. `[V3.1-P1-13]`. The attribution SLOT select stays: the audit's slot-beyond-profile rule really reads `colour.region_slots.attribution`. The row now shows "cut" where the well was, with a note saying why. |
| `ColorField`, the colour-well primitive | `Controls.tsx` | The seven part-colour wells were its only caller. An unused primitive is how a removed control quietly comes back. |
| The "7 parts" badge on the Colour group | `ParamPanel.tsx` | It counted the seven wells. `color_mode` now reads "one per part". |

Two things the brief listed for removal that were **already** where they
belong:

- **`colour.preview_theme` has no settings-panel control.** Its toggle is
  already in the viewport HUD (`components/scene/PreviewPane.tsx`, test id
  `preview-theme-toggle`). The catalog test pins that no panel control writes
  it.
- **`heights.*` is no longer inert.** `normalise` claims all eight
  `heights.*` leaves and `stagesInvalidatedBy(["heights.floor_height_m"])`
  starts at `normalise` and reaches `export`, so a change re-reads every
  building height from the cached Overpass response with no network. Both
  sliders' help strings now say exactly that. See section 6 for the one thing
  still outstanding on the store side.

Nothing else was found decorative. Every remaining flag from the inventory's
list of 24 is a control whose field a stage really claims:

- `colour.palette` is written into both 3MF writers' metadata as
  `framecraft:palette` and into the sidecar as `colour_palette`, so the
  palette picker's help now says the name reaches the file.
- `color_mode` is claimed by the export stage. Its help now names the three
  targets it actually changes (generic 3MF, OBJ, STEP) and says a Bambu
  project always writes one object per region, instead of reading as
  universal.
- `export_target` is claimed by the export stage and decides which files are
  written.
- `hero_auto.*` is claimed by the `heroes` stage.
- The four tint controls are claimed by `buildings`; the OBJ-only caveat is
  in the toggle's help string as well as in the standing note.
- The terrain, height-exaggeration, magnet and tiling controls are all
  claimed. What the inventory flagged about them was preview LATENCY, not
  inertness, and the pipeline's incremental runs are the answer to that.

## 5. Claimed, with effects, and still no control

Twenty-five leaves are read by a stage and have no control in the settings
panel. `controlCatalog.test.ts` asserts this list exactly, so it cannot grow
silently.

| Leaves | Why there is no control yet |
|---|---|
| `regions.roads.*`, `regions.water.*`, `regions.parks.*`, `regions.rail.*`, `regions.building_skirt_mm` (10) | No UI at all. These decide how deep each surface is cut and how far above or below the base top it sits, and they are what the Surface group's help strings have to quote numbers from. **The settings-panel task adds a Regions section.** |
| `bridges.enabled`, `bridges.clearance_mm`, `bridges.abutments` (3) | No UI at all, and `bridges.enabled` defaults to **true**, so every model builds bridge decks with no way to turn them off. **The settings-panel task adds a Bridges section.** |
| `heights.type_defaults.*` (6) | One row per building type is a table, not a slider. The two `heights.*` sliders above it are controllable; these six are not. |
| `place.country`, `place.state`, `place.neighbourhood` | Written by the reverse geocoder from the pin, never typed. |
| `custom_profile.nozzle_mm` | The Scale group's `nozzle_mm` is the one nozzle a build uses; the profile's copy is only a default the profile applies on selection. |
| `schema_version` | Payload metadata. |
| `colour.preview_theme` | The viewport HUD's own toggle writes it. |

## 6. Copy

- `LocationGroup.tsx`: the radius slider's "Half the ground span. Changing it
  refetches the scene." is now "Half the ground span of the square that
  prints, so it decides how much city fits and at what scale. Releasing the
  slider refetches from OpenStreetMap."
- The place-name field's transient lookup status ("Looking up the place
  name...", "Could not look up a place name for this pin...") moved out of the
  field's HINT and into a note under it (`place-detect-status`). The hint is
  now the standing description of what the field does, which is what
  `aria-describedby` should say; swapping it for a status message left the
  control undescribed exactly while something was happening.
- "the file is built" became "the file is written" in the lettering token
  note.
- Em dashes are gone from every string these files render: the Scale group
  summary, the hero-mode idle note, both "nothing yet" token previews and the
  engraving fit verdict, which now reads "Not cut: ..." with a colon.
- `lib/groups.ts`: the Colour summary was "One filament, or one per part",
  which described the seven wells. It is now "A filament slot and a colour for
  every region of the model." The Surface summary said "planting", which is
  not a control; it says "trees".
- No user-visible string in the group components says "scene", "bake" or
  "build the model". "Build plate" and "the tallest object this printer can
  build" stay: those are printing, not the vocabulary rule.

## 7. Help strings

**96 help strings written**, one per catalog row (95 panel controls plus
the export-format select), and 17 section
descriptions for the labelled blocks (`Frame profile`, `Shadow gap`,
`Matting`, `Separate frame part`, `Face texture`, `Lettering`, `North arrow`,
`Scale bar`, `Underside mark`, `Hanger`, `Hero buildings`, `Auto-detected`,
`Palette`, `Filament slots`, `Building tint`, `Height gradient`, `Tiling`).

Every one is in physical terms, never a restatement of the control's own name,
and the numbers come from `lib/transform.ts` and the contract defaults, not
from memory:

- the frame is "a 6 mm border standing 2 mm proud of the base" that "takes
  12 mm off the plate" (`FRAME_WIDTH_MM`, `FRAME_LIP_MM`);
- the nozzle is where "the minimum wall is twice it and the minimum gap one
  and a half times" (`MIN_WALL_NOZZLES`, `MIN_GAP_NOZZLES`);
- water "sits 0.5 mm below the base top and the pocket is cut 1.0 mm deep"
  (`regions.water.proud_mm`, `regions.water.depth_mm`);
- roads are placed "0.6 mm deep, 0.2 mm below the base top"
  (`regions.roads.*`), and the road-mode help says so rather than repeating
  v1's "embossed ones stand 0.4 mm proud", because since `[V3-P2-E2]` the
  region placement wins over the mode and a disagreement is reported as an
  issue;
- trees are "one and a half times as tall as they are wide, up to 2000 of
  them" and "a cone under 1 mm across is dropped": `TREE_HEIGHT_FACTOR` is 3.0
  but multiplies the RADIUS, and `TREE_MIN_RADIUS_MM` is 0.5 mm of radius, so
  both numbers double or halve on the way to a diameter (`TREE_CAP` is the
  2000);
- the underside mark is "cut 0.3 mm into the bottom of the base"
  (`UNDERSIDE_MARK_DEPTH_MM`);
- the exaggeration curve "bends that multiplier around a 50 m reference"
  (`HEIGHT_EXAGGERATION_REF_M`);
- an auto scale bar picks "a round ground distance that fits between 15 and
  40 mm of lip" (`SCALE_BAR_MIN_MM`, `SCALE_BAR_MAX_MM`).

Where a number depends on another setting, the help names that setting: the
matting width is "on top of the 12 mm the frame already takes", the shadow-gap
depth is "bounded by the base thickness", the height bands are "capped at
eight and at the printer profile's filament count", the magnet pocket is
"bounded by the base thickness so it never breaks through".

**How they are shown.** Every help string is the control's description, not a
tooltip. The five `Controls` primitives already wired `aria-describedby` to a
visible `Hint`; the controls built out of buttons now do too. Where a visible
line would bury the list it belongs to (a Remove button in a row, the eleven
filament-slot cells, the height-band selects) the description is a shared
`Hint` or an `SrHint` (`sr-only`) that every row points at, plus a `title` for
a mouse. Nothing relies on `title` alone.

Two smaller changes in `Controls.tsx` fall out of this:

- every primitive now emits `data-testid={id}` on its interactive element, so
  every control has one stable handle and the catalog's test-id column is
  never empty;
- `ColorField` is gone (section 4).

## 8. The `part_colors` migration

`lib/share.ts:parsePrintParams` now carries a payload's `part_colors` into
`colour.region_colors`, and only when the payload does not already name
`colour.region_colors`. `lib/project.ts:parseProject` inherits it by calling
the same function: a project file and a share link must never migrate a
payload two different ways, exactly as they must never validate one two
different ways.

The mapping is `base`, `frame`, `buildings`, `roads`, `water` onto themselves,
and both `green` and `trees` onto `parks`. Trees are unioned INTO the parks
region (`lib/engine/solid/trees.ts`), so the printed object has one colour for
both; `green` is the area colour and wins when a payload names two different
values.

Eight tests, six in `share.test.ts` and two in `project.test.ts`: a v1 payload
(all seven wells), a payload naming only `trees`, a v2 payload whose `colour`
block has no `region_colors`, a v3 payload naming both (region colours win and
`part_colors` still round-trips), a payload with no `part_colors` at all, and
the whole thing through `decodeShare`.

One existing test changed, and it gained assertions rather than losing them.
`share.test.ts`'s "round-trips every key the contract declares, one at a time"
now states the ruled behaviour for the one key whose round trip is
deliberately not the identity: `part_colors` still comes back exactly as it
went in, AND its six colours are asserted to have landed on the regions the
engine paints. Every other key is still `toEqual` as before.

## 9. Tests

| File | What changed |
|---|---|
| `lib/controlCatalog.test.ts` | New. 17 tests, described in section 2. |
| `components/editor/groups/ColourGroup.test.ts` | New. 7 tests: the behavioural pin `[V3.1-P1-13]` asks for, driving the real palette, merge and align patch builders and the real store setter. |
| `lib/groups.test.ts` | Three tests added: every group has at least one catalog control, and the group summaries say what the group still contains (no em dash, no "bake", Colour names filament slots, Surface does not say "planting"). |
| `components/editor/Controls.test.ts` | Four source guards added: every primitive emits `data-testid={id}`; every hint is wired through `aria-describedby` (five primitives plus `Field`); `ColorField` is no longer exported; `SrHint` is. One fixture updated for the store's new `SceneState.hash`. |
| `lib/share.test.ts` | Six migration tests added; the exhaustive round-trip test states the `part_colors` ruling. |
| `lib/project.test.ts` | Two migration tests added. |
| `e2e/ui.spec.ts` | The two sites that drove the part-colour wells now drive the per-region wells, and assert no `part_color_*` control exists. One test added: seven help strings read through `aria-describedby` and compared to the catalog, covering all five primitives plus the two controls that share one hint between eleven rows. |
| `e2e/a11y.spec.ts` | The axe sweep waited on `part-colors` to be on screen; it waits on `colour-region-rows` and `colour-color-water`. |
| `e2e/share.spec.ts` | Writes and restores `colour-color-water` instead of `part_color_water`. |
| `e2e/print.spec.ts` | Unchanged: it never touched a removed control. |

Nothing was skipped, weakened or deleted.

## 10. Verification

`npm run lint` clean over `components/editor`, the four `lib` files and `e2e`.
`npm run typecheck` reports nothing in any file this task owns.
`npx vitest run` over the six owned files: **111 passed, 0 skipped**.

`next build` succeeded under the build lock. `ui.spec.ts`, `print.spec.ts` and
`a11y.spec.ts` with `E2E_BUDGET_FACTOR=3`, run serially: **28 passed, 1
failed**, and the failure is not this task's (see below).

## 11. For the orchestrator

1. **`print.spec.ts:111` fails, and the cause is the pipeline's new debounce.**
   The test clicks a finding's fix button and asserts the button goes disabled
   and reads "Fixed" before the next build lands. `IssuesBadge.tsx` clears its
   `fixedIds` set whenever the findings list changes, and with
   `PIPELINE_DEBOUNCE_MS = 80` (down from 400) the fresh findings arrive first,
   so the row is gone rather than disabled. `IssuesBadge.tsx` and
   `store/editor.ts` belong to the integration and action-bar work, and the
   test must not be weakened: either the badge keeps its "Fixed" mark until the
   row disappears, or the test asserts the end state directly. Flagged, not
   touched.
2. **The `heights.*` item is closed.** It was raised here when the store
   still called `engineClient.buildModel` with an already-normalised graph. In
   the working tree `store/editor.ts` schedules `startPipelineRun` from the
   `SceneRequest`, `fetch` claims no params and `normalise` claims all eight
   `heights.*` leaves, so a heights change re-runs normalisation off the cached
   response with no network. The help strings and the `ui.spec.ts` assertion
   are true as written.
3. **Two files outside the stated ownership were edited, minimally, because
   removing the wells broke them:** `e2e/a11y.spec.ts` (one waited-on test id)
   and `e2e/share.spec.ts` (one control written and read back). Both changes
   are one-for-one swaps onto the per-region wells.
4. **No new store setter was needed.** Every write still goes through
   `setParam` / `setNested` / the existing location setters.
5. **`regions.*` and `bridges.*` remain without any control**, as instructed.
   Section 5 is the list the settings-panel task should work from;
   `bridges.enabled` defaulting to true with no way to turn it off is the
   sharpest item on it.
