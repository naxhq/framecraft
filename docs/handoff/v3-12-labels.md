# v3-12 surface-anchored labels (Tier A)

Task 12 of the v3.1 run: a name engraved into, or raised off, a building's
roof or the ground a street, a water body or a green area prints as, placed
and dragged in the viewport, at most twelve to a model. Contract, engine
stage, anchor maths, viewport gizmo, labels card, inspector row, share link,
project file, matrix probes and a browser test. Written by the Task 12
agent; the contract side (`print_params.json` `labels`, regenerated
`contracts.ts` / `contracts.py`) landed before the interruption this note
resumes from.

## 1. What landed

| piece | where | what |
|---|---|---|
| contract | `packages/contracts/schema/print_params.json` `labels[]`, `$defs.Label` | schema_version 4, optional, default `[]`, `maxItems` 12. Twelve leaves: `target_osm_id`, `layer`, `surface`, `u`, `v`, `rotation_deg`, `size_mm`, `mode`, `depth_mm`, `font`, `text`, `follow`. Ranges and caps in the generated `PARAM_RANGES.labels` / `PARAM_LIMITS.labels`. The schema's own v4 narrative and the `schema_version` description name `labels` (and the stale `ObjectOverride.slot`/`color` wording [V3.1-P11-1] flagged is corrected in the same pass); `make contracts` regenerated both outputs, `test_v1_compat.py` green. |
| anchor maths | `apps/web/lib/labelAnchor.ts` (+ `.test.ts`, 27 cases) | targets, frames, anchor <-> plan, snapping, nudging, the follow plan, and the params-level edits the store and the stage share (section 3). |
| the cut | `apps/web/lib/engine/solid/labels.ts` (+ `.test.ts`) | face selection, fit, shrink, the frame lettering's own Stage 1 repair, refusal naming the size that would cut, the bands (section 4). |
| stage | `apps/web/lib/engine/pipeline/stages.ts` `labels` | between `fonts` and `lettering`; claims `labels[].*` plus the scale, nozzle, skirt and exaggeration leaves the faces depend on. Attaches `LabelBand.pose` for the gizmo (section 6). Consumers: `base`, the surface regions, the building bands, `assembly`, `measure`. |
| result | `EngineResult.labelBands`, `EngineResult.sitShiftMm` | the bands the sidecar, the validator and the gizmo read; the `sit` lift the finished meshes were moved by, so a band in engine mm can be drawn over a mesh in sat mm. |
| share / project | `apps/web/lib/share.ts` `PRINT_PARAM_SPEC.labels` | the blocker this resumption cleared: every bound from the generated contract, item cap 12. `share.test.ts`'s random and maximal generators now cover both v3.1 arrays. |
| gizmo | `apps/web/components/scene/LabelGizmo.tsx` | one outline and one DOM handle per cut label; drag to move, a rotation handle on the selected one, keyboard on the handle (section 6). |
| card | `apps/web/components/editor/LabelsPanel.tsx` | the list, the count against the cap, the selected label's fields, "not cut" with the engine's reason. |
| inspector row | `apps/web/components/editor/ObjectInspector.tsx` | "Label its roof" / "Label this street" / "Label the water" / "Label this green": a label at the object's centre, selected. Cap refusal shown in place. |
| store | `apps/web/store/editor.ts` (+ `editor.labels.test.ts`) | `selectedLabel`, `labelCapHit`, `addLabel`, `selectLabel`, `moveLabel`, `rotateLabel`, `nudgeLabel`, `turnLabel`, `resizeLabel`, `patchLabel`, `removeLabel`; every one a `setParam("labels", ...)`. |
| matrix | `apps/web/lib/engine/pipeline/matrix.labels.ts` | twelve probes, one per leaf, on the `labelled` synthetic scene: preview from `labelBands`, file from the sidecar's `label_bands` and the written parts. |
| catalog | `apps/web/lib/controlCatalog.ts` `label-row-*`, `label_*_...` | nine rows, `object-override` target like the inspector's, so no section reset wipes a placed label; the twelve leaves are in `CLAIMED_WITHOUT_A_CONTROL` with the control that writes each. |
| browser | `apps/web/e2e/labels.spec.ts` | right-click -> Label its roof -> counted, cut, in the resolved output and the exported sidecar -> dragged -> turned and resized from the keyboard -> removed. |

## 2. The cap of twelve, measured

The contract text says the cap is measured, not chosen. The measurement, on
this host (Windows 11, node 22, the WASM kernel in vitest, no worker), on the
committed Chicago Loop SceneGraph (`fixtures/chicago-scene.json`, 994
buildings, 900 m radius, defaults) with twelve labels on the twelve fattest
hole-free roofs (two-letter counterless names, engrave at 4 mm and emboss at
5 mm alternating, every one of the twelve cut), then ONE label's `u` moved
from 0.5 to 0.6 on the warm cache, the drag the gizmo makes:

| | ms |
|---|---|
| cold build, twelve labels | 4 650 |
| warm rebuild after the drag, geometry phase (`labels` stage alone) | 57 (55) |
| warm rebuild after the drag, region phase (`region-buildings` + `finish-buildings`) | 136 |
| **preview on screen after the drag** | **~190** |
| audit phase behind it (`assembly` 801, `merged` 715, `measure` 304) | 1 834 |

So twelve labels keep the preview under the 400 ms target after a drag with
room to spare; what a drag costs is one glyph repair per label (about 4.5 ms
each) plus the building region's finish. The audit phase is the inventory's
known cost (`v3-01-pipeline-design.md` section 1) and is not moved by labels.
Past twelve the cost grows linearly in the `labels` stage and the region
finish; the cap is where a full re-run of the stage after a drag stays a
rounding error inside the region phase rather than the other way round.

The measurement also found the constraint section 4 states: at 3 mm a 0.4 mm
nozzle refuses any letter with a counter ("needs 3.33 mm" engraved, "needs
5.00 mm" embossed), and a seven-character name at 4 mm does not fit any roof
in the Loop at the default 900 m radius (roughly 0.09 mm per metre). The
browser test therefore labels with a counterless two-letter text at the
default size, and the card's "not cut" line is what a user sees for the rest.

## 3. The anchor model (`lib/labelAnchor.ts`)

A label is stored where it sits on its TARGET, never where it sits on the
plate: `u` along the target's principal axis, `v` across it, `rotation_deg`
from that axis. The frame rotates with the target, so an anchor survives a
SceneRequest rotation and a re-fetch.

- **Polygon targets** (a building footprint, a water or green ring): the
  minimum-area oriented rectangle (`preview.minAreaRect`); `u` runs along
  the long side, `v` across it, rotation 0 reads along the long side.
- **Road targets**: the centreline, chained across the parts a crop split a
  way into (`chainRoadParts`, longest part first, a part that meets nothing
  is left out); `u` is a fraction of arc length, `v` a fraction across the
  printed ribbon (0.5 on the centreline, the ribbon width being the roads
  layer's own clamp), rotation 0 reads along the local tangent.
- **Follow** (`followPlan`): each glyph sits on the chord of its own
  advance, walked in the direction that keeps the text upright. Three
  limits, any of which sets the label straight with the reason reported:
  the reading direction may turn at most 30 degrees between neighbouring
  glyphs, at most 120 degrees over the whole name, and the radius of
  curvature at every join (`advance / turn`) must be at least the cap
  height, the condition for the inside edge of a glyph box to keep positive
  length. A name longer than the street is refused.
- **Snapping**: a rotation within 7.5 degrees of a right angle lands on it;
  an anchor within 0.04 of the centre lands on it, per axis.
- **Storage precision**: `u`, `v` to four decimals, rotation to a tenth of a
  degree, `-0` folded to `0` (a share link is JSON).

The params-level edits (`addedLabel`, `movedLabel`, `rotatedLabel`,
`nudgedLabel`, `patchedLabel`, `removedLabel`) are what the store's actions
write and `labelPose` is what the stage attaches to each band, so a handle
and the groove under it cannot disagree.

## 4. The cut (`lib/engine/solid/labels.ts`)

- **Face.** A building is labelled on its roof, everything else on the
  ground it prints as; asking for the other surface is refused, not moved.
  The roof is the highest repaired building solid under the anchor (a
  tower on a block is labelled on the tower), after the drape's lift; the
  ground is the target's own outline intersected with the built surface
  region at the depth `regions.*` asked for.
- **Fit.** The ink polygon must lie inside the face eroded by one minimum
  wall (`FIT_MARGIN_WALLS = 1`). A label that does not fit at the size asked
  is shrunk on the size grid until it does (an `info` finding says by how
  much); one that does not fit at 1.50 mm is refused.
- **Print.** Every glyph goes through `lettering.repairText`, the frame
  lettering's Stage 1: dilated to the stroke target, clipped to the face,
  widened where a terminal is thin, measured, refused when the dilation
  closed a counter or the stroke still measures under the target. A refusal
  is a `warning` finding naming the size that would cut, with a one-click
  resize when growing is the remedy.
- **Solids.** An engrave is a cutter from `depth` below the face to past
  it; an emboss is the letters overlapping the face by `PART_OVERLAP_MM`.
  Roof pieces are applied to the building solids before the drape (and to
  every gradient band and override region that holds the building); ground
  pieces to the flat surface before the warp; a ground engrave deeper than
  its surface region also cuts the base. The thirteenth label and beyond
  are ignored with a finding.

## 5. Bands, sidecar, validator

Each cut label reports a `LabelBand`: `[low, high]` Z, the face Z, the ink
polygon grown by one nozzle (the hull of the glyph boxes when following),
the region, and since this resumption the `pose`. The sidecar writes
`label_bands` (`id`, `index`, `mode`, `z`, `face_z`, `rect`, `region`; the
pose stays out, the validator judges the rectangle), and the reference
validator masks each rectangle out of its structural `min_wall` probe inside
the band and judges the strokes and ridges inside it with the lettering
row's thresholds (`services/bake/tests/test_labels.py`). The engine's own
`measure` stage masks the same polygons (`labelMasks`), so a label never
trips the wall gate on its own ridges; `labels.test.ts` proves it and that
a labelled model passes the export gate.

## 6. Direct manipulation

`CityPreview.test.ts` holds every file under `components/scene/` to zero
parameter reads, so the gizmo is built from pipeline output only:

- **Handles are DOM.** `drei`'s `Html` puts a real `<button>` at each
  band's `pose` (and a second, the rotation handle, past the end of the
  selected one). A button can be focused, has an accessible name, takes the
  keyboard, and is something Playwright can find and drag; its pointer
  events never reach the canvas, so a drag never orbits the camera.
- **Drag.** Pointer capture on the handle; each move is intersected with
  the face's plane (the band's `faceZMm` plus `sitShiftMm`, carried into
  world space by the group's matrix) and handed to `moveLabel(index, x, y)`
  in engine millimetres, at most once per animation frame. The store, where
  the scene and the params may be read, turns it into `u`, `v` through
  `movedLabel`. The outline follows the pointer from a local override until
  the next result lands, then snaps to the real band.
- **Rotation handle.** The absolute angle of the pointer around the centre
  goes to `rotateLabel`, stored relative to the target's axis, snapped.
- **Keyboard**, on the handle and on the card's row alike
  (`labelKeyAction`): arrows nudge 0.5 mm in the label's own reading frame
  (Shift: 2 mm), `[` and `]` turn 5 degrees (Shift: 15), `+` and `-` resize
  by 0.25 mm (Shift: 1), Delete or Backspace removes, Escape deselects.
- **No attributes on the r3f group.** Found by driving the built app: r3f
  applies a dashed prop such as `data-testid` as a nested path
  (`data.testid`) and throws in `commitUpdate` when the object has no
  `data`, so a `<group>` that gained or lost the attribute as the band
  count crossed zero took the whole canvas down (`R3F: Cannot set
  "data-testid"`). The gizmo's group carries nothing; the DOM handles carry
  the test ids. `TileGrid` sets the same attribute on a group and a `Line`
  that never change after mount, which is why it has never tripped.
- **Placing.** The right-click inspector's first row. It places the label
  at the object's centre and selects it; the handle is then where it is
  dragged from. `addLabel` also accepts a plan point for a future click-to-
  place tool; nothing uses it yet.
- **The card** (`LabelsPanel`, docked under the viewport theme toggle, only
  while there is a label or a refused thirteenth): the count "n of 12
  labels" from the first one, the cap sentence when refused, one row per
  label named after its text or its target, the surface word, "not cut"
  with the engine's reason, and the selected label's fields (text, cap
  height, cut, depth, face, turn, follow for a street, remove).

Every write goes through `setParam("labels", ...)`: the model is marked
stale, the build rescheduled after the 80 ms debounce, the export withheld
until it lands, and the change is one undo entry (coalesced like a slider
drag).

## 7. Tests

- `lib/labelAnchor.test.ts` (27), `lib/engine/solid/labels.test.ts` (13,
  including the strict-claims run with every kind of label on the plate),
  `store/editor.labels.test.ts` (6), `lib/share.test.ts` (41, the random and
  maximal generators now carrying both arrays), `lib/project.test.ts`,
  `lib/layout.test.ts`, `components/editor/ActionBar.test.tsx` (the 23 the
  blocker failed), `components/scene/CityPreview.test.ts` (labels is a
  model-only key that moves no HUD memo), `store/editor.test.ts` (labels in
  the field coverage and the nested-reference lists),
  `lib/controlCatalog.test.ts` (the nine rows; the twelve leaves exempt with
  their control named), `lib/advisor.test.ts` and `lib/warnings.test.ts`
  (a moved value for both v3.1 arrays, which neither dependency key reads),
  `lib/contrast.test.ts` (the card in the boundary-token inventory).
- `matrix.test.ts`: the twelve `labels[]` probes pass. The suite as a whole
  is red on the eleven `object_overrides[]` leaves, which have neither a
  probe nor an exemption; that is Task 11's, not this task's.
- `e2e/labels.spec.ts`: one test, the whole loop (section 1's last row).

## 8. Left on the table, and findings for other tasks

- `object_overrides[]` has no matrix probes (Task 11): `matrix.test.ts`
  fails its coverage assertion on exactly those eleven leaves.
- `lib/controlCatalog.test.ts` fails on `DesktopProjectOpener.tsx` (no
  control tag) and on `about-button` / `about-dialog-close` (uncatalogued),
  all from Task 13's files.
- `graph.test.ts`'s Chicago strict-claims case fails on `repair-buildings`
  reading `height_exaggeration`, which it does not claim; not touched here.
- `recessBands` and `attributionBands` are in engine mm while the finished
  meshes are sat mm; `RegionMeshes` shades by centroid Z against the bands
  without the `sit` shift, so recess shading is off by the shift whenever a
  drape or a standing hanger reaches below the plate. `EngineResult.
  sitShiftMm` now exists for exactly this; the gizmo uses it, the shading
  does not yet.
- Click-to-place on a face (a "label tool" in the viewport) is designed
  for (`addLabel(target, at)`) but has no control; the inspector row places
  at the centre. Tier B: multi-line text, a label on a bridge deck, a label
  that spans two tiles.

## 9. Follow-up (v3.1 gate): which roof `e2e/labels.spec.ts` may label

The e2e swept the viewport for the first NAMED building whose popover reported
a footprint of 6 000 m2 or more, and then waited 90 s for a handle that never
came. In the Chicago Loop fixture exactly one building clears that bar, and it
is the worst possible one: The Art Institute of Chicago, 25 980 m2 of wings
around courtyards and a railway, which refuses the label -- correctly, and with
the reason in the card: `"IT" does not fit inside the roof of The Art Institute
of Chicago with a wall's clearance even at 1.50 mm`.

That is section 4 working as written. The cut takes the highest repaired
building solid **under the anchor**, eroded by one minimum wall, so what has to
be roomy is the single solid the centre lands on -- not the sum of the
footprint. Total area is a necessary condition and not a sufficient one, and
for a multi-building complex it is actively misleading. Measured over the
99-point sweep: 26 named buildings, 25 of them towers between 811 and 5 327 m2,
and the one 25 980 m2 complex. Tribune Tower (5 327 m2) and Chase Tower
(5 296 m2) both cut "IT"; the complex does not, at any size.

The spec now takes a footprint BAND, 5 000 to 10 000 m2: the floor is the fit
(a 5 000 m2 roof is 6.6 mm across at 1:10,714), the ceiling steps over the
complex, and the sweep lands on Chase Tower. It also asserts the card's verdict
BEFORE the handle, polling status-with-reason as one string, because a refused
label has no band and therefore no handle, and "element not found" is a worse
report than the engine's own sentence. The poll tolerates the transient "not
cut" from the build for the label as placed, whose text is still the building's
own name ("Chase Tower" does not fit either) until the test types "IT".

Verified both directions on an isolated static build and port: green in 45 s;
with the old 6 000 m2 floor and no ceiling restored, red in 2.9 min with
`Received: "skipped: Not cut: \"IT\" does not fit inside the roof of The Art
Institute of Chicago ..."`.

Worth a Tier B line: the refusal advises "shorten the text or move it", but
a refused label has no gizmo, so only the first half of that advice can be
taken from the viewport.
