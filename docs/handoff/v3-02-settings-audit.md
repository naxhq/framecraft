# v3-02 settings truth: adversarial audit

Task 2 of the v3.1 run, audited against the working tree at the time of
writing (`git diff f8d484e` over `components/editor/**`, `lib/controlCatalog.ts`,
`lib/groups.ts`, `lib/share.ts`, `lib/project.ts` and the named tests).
The implementer's note is `docs/handoff/v3-02-settings.md`; the rulings are
`DECISIONS.md` `[V3.1-P1-2]`, `[V3.1-P1-13]`, `[V3.1-P2-1..5]`.

What was reproduced and passes: `npx vitest run lib/controlCatalog.test.ts
lib/groups.test.ts components/editor/Controls.test.ts lib/share.test.ts
lib/project.test.ts` gives **100 passed, 0 skipped**, exactly as the note
claims. The catalog holds 96 control rows and 17 section rows, all ids and
test ids unique. A replica of the test's JSX scanner run over the eleven
scanned components finds **96 control tags naming 95 distinct ids**, none
anonymous, none missing a row, and the only catalog row nothing renders is
`export-target-select` (deliberately outside the scan). The seven part-colour
wells, their block, their disabled note and the `ColorField` primitive are
gone from the whole repo, with no orphan DOM id or test id left behind. The
`part_colors` migration is real, is reached by share links, project files and
the recent-designs list (recents store payload strings and restore through
`decodeShare`), and does not touch a payload that already names
`colour.region_colors`.

The defects below are what the note's own claims do not survive.

---

## Blockers

### 1. Three colour controls write `colour.region_colors.attribution`, which `[V3.1-P1-13]` says no control may write, and the test that is meant to pin it cannot see them

`apps/web/lib/controlCatalog.ts:122` builds `REGION_COLOUR_LEAVES` by
filtering `colour.region_colors.attribution` out, and rows `palette-apply-*`
(`:953`), `colour_color_*` (`:1003`), `align-slot-colours` (`:1013`) and
`merge-to-profile-slots` (`:1023`) all declare that filtered list. The real
setters do not honour it:

- `apps/web/components/editor/groups/ColourGroup.tsx:169` calls
  `paletteApplyPatch`, and `apps/web/lib/palettes.ts:198` returns
  `region_colors: { ...palette.region_colors }`. Every built-in palette
  declares an `attribution` colour (`lib/palettes.ts:66`, `:81`, `:96`, and
  `PALETTE_REGION_NAMES` at `:300` lists it). `store/editor.ts:1058`'s
  `setNested` replaces `colour.region_colors` with that object wholesale, so
  **one click on any palette writes the forbidden leaf**.
- `ColourGroup.tsx:141` calls `planMergeToSlots`, and
  `apps/web/lib/colourMap.ts:301` writes `regionColors[region]` for every
  region in every cluster, `attribution` included.
- `ColourGroup.tsx:153` calls `alignConflictsPatch`
  (`lib/colourMap.ts:158`), which writes any losing region's colour. At the
  frozen defaults `attribution` and `base` share slot 1 and the same hex, so
  it is filtered out today; edit the base colour and `attribution` becomes a
  loser and is written.

`lib/controlCatalog.test.ts:351` ("no control writes one of the four matrix
exemptions") asks `controlsWriting(path)`, which reads the catalog's own
`writes` array. It can only ever confirm what the catalog says about itself.
`[V3.1-P1-13]` requires that "a test pins that no control writes it"; no such
test exists.

**Prove it.** In a vitest file:
`expect(paletteApplyPatch(builtinPalette("blueprint")!, slots).region_colors.attribution).toBe("#EAF0FA")`.
Or in the app: open Colour, click Blueprint, read
`useEditorStore.getState().params.colour.region_colors.attribution`.

**Smallest fix.** Strip the leaf in one place rather than at four call sites:
have `paletteApplyPatch`, `planMergeToSlots` and `alignConflictsPatch`
outputs pass through a single `withoutAttributionColour(patch)` helper in
`lib/colourMap.ts`, and add the behavioural test the ruling asks for: apply
every built-in palette, merge, and align, and assert
`params.colour.region_colors.attribution` never moves off the default.

### 2. `frame_style_lip_depth_mm` is a live slider for a field the matrix's own file says moves no geometry, and the note's table cites that red probe as its proof

`apps/web/components/editor/groups/FrameTextGroup.tsx:329` renders the Lip
depth slider; `lib/controlCatalog.ts:574` catalogues it as writing
`frame_style.lip_depth_mm`. `apps/web/lib/engine/pipeline/matrix.probes.ts:1891`
declares `KNOWN_DEFECTS`, and `:1897` names this exact leaf: "`solid/frame.ts`
frameStyle resolves it into `FrameStyle.lipDepthMm` and nothing reads that
field, so the setting moves no geometry at any profile." `[V3.1-P2-2]` and
`[V3.1-P2-3]` confirm the probe stays red until the Task 7 geometry wave.

The brief for this task is that every control changes the preview and the
exported file, and that a decorative control is implemented or removed. This
one is decorative today, it was neither implemented nor removed, and
`docs/handoff/v3-02-settings.md:98` states a preview effect ("a deeper lip
must remove frame material"), an export effect ("the region solids, in every
target") and a test (`matrix frame_style.lip_depth_mm = 3`) without saying
that the probe currently fails by design.

The catalog test does not catch it because stage claims are wildcards:
`lib/engine/pipeline/stages.ts:592`, `:611`, `:640` and `:698` claim
`frame_style.*`, so `claimedPaths()` marks every leaf under it claimed.
`lib/engine/pipeline/graph.test.ts:180`'s strict-claims run only catches a
stage reading something it did NOT declare; over-declaration is free. The
same wildcard hides `regions.rail.width_m`, the other `KNOWN_DEFECTS` entry,
though that leaf has no control.

**Prove it.** `frame_style.lip_depth_mm` is in `KNOWN_DEFECTS`; run the
matrix probe for it and watch it fail, or grep `lipDepthMm` and find only the
resolver in `lib/engine/solid/frame.ts`, no reader.

**Smallest fix.** Do not weaken anything. Add one assertion to
`lib/controlCatalog.test.ts`: no control may write a path in
`KNOWN_DEFECTS`, with a named, dated exemption list carrying the DECISIONS id
that authorises it. Then either disable the slider with a one-line note until
Task 7 lands it, or record the exemption explicitly. Correct the note's table
row to say the effect is pending `[V3.1-P2-2]`.

---

## Majors

### 3. The three `hanger_magnet.*` sliders do nothing in one of the two states that reveal them, and their help describes exactly that dead state

`FrameTextGroup.tsx:172` computes `magnetInUse = params.hanger === "magnets"
|| separate.mount === "magnet"` and `:617` renders the three sliders whenever
it is true. `hanger_magnet.*` is read in exactly one place,
`lib/engine/solid/frame.ts:749`, inside `buildFrameMating`, which returns
early at `:711` unless `frame_style.separate` is enabled. The wall hanger's
pockets use the frozen `MAGNET_D_MM` and `MAGNET_DEPTH_MM`
(`lib/transform.ts:1708`, `:1780`, `:1814`). This is `[V3.1-P2-5]` verbatim.

So with Fitting set to "Magnet pockets" and no separate frame, all three
sliders move nothing. The catalog help repeats the error the same wave ruled
against: `controlCatalog.ts:818` says the pocket is "cut into the back,
bounded by the base thickness", and `:828` says the count is "Shared by the
magnet hanger and a separate frame's magnet mount". The matrix probes agree
with the ruling and not with the help: all three
(`matrix.probes.ts:1698`, `:1714`, `:1729`) run on `base: SEPARATE_MAGNET`
(`:146`), which enables the separate frame.

**Prove it.** Set `hanger = "magnets"`, separate frame off, move Magnet
diameter, and compare region volumes: unchanged.

**Smallest fix.** Gate the block on `separate.mount === "magnet"` only, and
rewrite the three help strings to say they size the separate frame's mount.
If the wall hanger should honour them too, that is a geometry change and
belongs in Task 7 with a DECISIONS line.

### 4. Nine group-header toggles are controls the panel renders with no catalog row, and the completeness test cannot see them

`apps/web/components/editor/CollapsibleGroup.tsx:43` renders
`<button data-testid={`group-${id}-toggle`}>` once per group;
`ParamPanel.tsx:135` maps it over the nine non-output groups. The catalog
carries `group-output-toggle` (`controlCatalog.ts:1231`) and not the other
nine, so the boundary is not a principle, it is an omission.

`lib/controlCatalog.test.ts:115`'s `SCANNED` list is hand-written and does not
include `CollapsibleGroup.tsx`, so the "has a row for every control the panel
renders" test never looks. The brief's question, whether a control can hide
from the scan, is answered: not inside a conditional or a `.map` (the scan is
static and finds those), but yes inside any component the list forgets.

**Prove it.** Add `components/editor/CollapsibleGroup.tsx` to `SCANNED` and
re-run: the test reports `group-*-toggle (components/editor/CollapsibleGroup.tsx)`
as missing. I ran a replica of the scanner and it does exactly that.

**Smallest fix.** Derive `SCANNED` rather than typing it: walk
`components/editor/**/*.tsx` minus an explicit, commented exclusion list, and
add a catalog row for `group-*-toggle` with one help string. The same change
surfaces `ExportMenu.tsx` and `OutputPanel.tsx`, which is finding 10.

### 5. Two buttons rely on `title` alone, which the note says nothing does

`ColourGroup.tsx:436` (`align-slot-colours`) and `:452`
(`merge-to-profile-slots`) carry `title={labelled(...).hint}` and no
`aria-describedby` and no `Hint` or `SrHint` to point at. Every other button
in the panel was wired (`hero-remove`, `hero-clear-all`, `reset-place-name`,
`reset-button`, `group-output-toggle`, `engraving-add`, `engraving_*-remove`,
`palette-apply-*`, `palette-delete-*`, `palette-save`, `colour-tint-reroll`
all resolve to a rendered element; I checked each).

`docs/handoff/v3-02-settings.md:295` claims "Nothing relies on `title`
alone." `Controls.test.ts:238` is named "wires every hint through
aria-describedby, never through title alone" but only counts regex matches
inside `Controls.tsx`, so it cannot see a group component. `title` is not
announced by most screen readers and is unreachable by keyboard, and axe does
not flag a missing description, so `a11y.spec.ts` stays green.

**Prove it.** `page.getByTestId("align-slot-colours").getAttribute("aria-describedby")`
returns null.

**Smallest fix.** Add `aria-describedby` plus an `SrHint` to both, exactly as
`hero-clear-all` does at `BuildingsGroup.tsx:171`. Then rename or widen the
Controls test so its name matches its reach.

### 6. The note's "Export effect" column is a template, and it is false for at least six rows

Nearly every row of the table at `docs/handoff/v3-02-settings.md:67` says
"the region solids, in every target". The matrix's own `assertExport` blocks
say what really moves, and for the printer rows they disagree flatly:

- `custom_profile_change_gcode` (note line 155): `matrix.probes.ts:1163`
  asserts `bambuProject(...).change_filament_gcode` moves from M600 to M601.
  No region solid changes at all, and only the Bambu and colour-change
  targets carry it.
- `custom_profile_max_height_mm` (note line 153): `matrix.probes.ts:1117`
  asserts the sidecar's `max_height_mm` and the project's `printable_height`
  move, plus an `exceeds-height` finding appears. The solids are identical.
- The same applies to `custom_profile_plate_x_mm`, `_plate_y_mm`,
  `_slots` and `printer_profile`.

The brief asks for rows that say "changes the model" without saying what.
About eighty rows do, and six of them are wrong rather than merely vague.

**Prove it.** Read `assertExport` for each probe named in the row's Test
column and compare with the row's Export effect cell.

**Smallest fix.** Generate the Export effect column from
`matrix.probes.ts`'s `why` plus a one-line summary of `assertExport`, or
hand-write the six printer rows. Do not ship a generated column that was not
generated.

### 7. `colour_color_*` writes `colour.palette`, which the catalog does not declare and which reaches the exported file

`ColourGroup.tsx:125`'s `setColor` writes both `region_colors` and `palette`
(it flips the id to `custom` unless the new table still matches a built-in).
`controlCatalog.ts:1003` declares only the region colours.
`colour.palette` is claimed by the export stage (`stages.ts:1169`) and
written into both 3MF writers as `framecraft:palette`
(`lib/engine/export/common.ts:101`) and into the sidecar. So a control the
catalog says touches colours also renames the palette recorded in the file.

A related inconsistency: `alignColours` (`ColourGroup.tsx:153`) rewrites
region colours and does NOT flip the palette id, so after one click the file
still claims a palette whose table no longer matches.

**Smallest fix.** Add `"colour.palette"` to the `colour_color_*` row's
`writes`, and make `alignColours` and `mergeToProfile` flip the id the same
way `setColor` does.

### 8. The frame-profile picker is the hand-rolled radiogroup that `Segmented` was rewritten to stop shipping

`FrameTextGroup.tsx:267` renders a `role="radiogroup"` div holding seven
`role="radio"` buttons, all in the tab order, with no arrow-key handler and
no roving tabindex. `Controls.tsx:319` documents why `Segmented` was
rebuilt: "Before this it was three plain buttons carrying `role='radio'`, so
a screen reader announced 'radio 1 of 3', which tells the user arrows will
work, and then arrows did nothing while Tab walked through all three." This
block is that pattern, seven wide, in a group this wave restructured.

**Prove it.** Focus `frame-profile-plain`, press ArrowRight: nothing moves,
and Tab visits all seven.

**Smallest fix.** Render it through `Segmented` (it already takes
`options`), or lift `Segmented`'s `move()` and roving tabindex into this
block.

### 9. The `trees` help string states two wrong numbers, in a section the note holds up as evidence that the numbers came from `lib/transform.ts`

`controlCatalog.ts:494`: "Stands cones on the green areas, three times as
tall as they are wide, up to 2000 of them. A cone under 0.5 mm across is
dropped."

- `lib/transform.ts:731` returns `TREE_HEIGHT_FACTOR * tree_radius_mm(...)`,
  and `TREE_HEIGHT_FACTOR` is 3.0 (`:53`). Height is three times the RADIUS,
  so a cone is one and a half times as tall as it is wide.
- `lib/transform.ts:695` drops a tree when `tree_radius_mm(...) <
  TREE_MIN_RADIUS_MM`, and `TREE_MIN_RADIUS_MM` is 0.5 (`:51`). The threshold
  is 0.5 mm of RADIUS, so a cone under 1.0 mm across is dropped.

`docs/handoff/v3-02-settings.md:273` cites both constants as proof the copy
is accurate. Every other number I checked is right: 12 mm of border
(`FRAME_WIDTH_MM` 6), min wall twice and min gap one and a half times the
nozzle (`MIN_WALL_NOZZLES`, `MIN_GAP_NOZZLES`), water 0.5 mm below and 1.0 mm
deep, roads 0.6 mm deep and 0.2 mm below (`regions.*` defaults), underside
0.3 mm, 50 m exaggeration reference, 15 to 40 mm scale bar, 7 mm corner
reserve, 2 to 6 mm arrow, 1.5 to 8 mm cap height, 60 degrees of hue, half a
step of lightness.

**Smallest fix.** "one and a half times as tall as they are wide ... a cone
under 1 mm across is dropped".

### 10. The catalog's boundary is undeclared, and the one row outside it names an id that does not exist

`controlCatalog.ts:1242` gives `export-target-select` the DOM `id`
`export-target-select`. `ExportMenu.tsx:61` renders `id="export_target"` with
`data-testid="export-target-select"`. The `id` field is documented at
`controlCatalog.ts:70` as "The control's DOM `id`", so the row is wrong, and
it is unfalsifiable because `ExportMenu.tsx` is excluded from `SCANNED`
(`controlCatalog.test.ts:114`).

The same exclusion hides `OutputPanel.tsx`'s eight buttons
(`preview-button`, `export-button`, `copy-link-button`,
`save-project-button`, `load-project-button`,
`share-too-large-save-project`, `load-project-input`, `share-link`), none of
which has a row, while `ParamPanel.tsx`'s two do. Nothing states the rule
that decides which side of the line a control falls on.

**Smallest fix.** Correct the `id` to `export_target`, and add one paragraph
to the catalog's header defining its scope, with `OutputPanel.tsx` named as
out of scope and why.

---

## Minors

### 11. `frame_style_lip_depth_mm`'s help describes the wrong axis, and contradicts the note's own table

`controlCatalog.ts:578` says "How far the profile's moulding eats into the
lip's 6 mm width." `[V3.1-P2-2]` rules it is a DEPTH: a sight-edge rebate
`lip_depth_mm` deep and `FRAME_SIGHT_EDGE_MM` (1.0 mm) wide. The note's own
table (line 98) says "how deep the frame's inner lip steps down". Two of the
three descriptions in this wave disagree with each other.

### 12. `printer_profile` writes `plate_mm` and `nozzle_mm`, undeclared

`store/editor.ts:1080` spreads `profileApplyPatch`
(`lib/printers.ts:242`), which returns `{ printer_profile, plate_mm,
nozzle_mm }`. `controlCatalog.ts:1106` declares `["printer_profile"]`. The
help string is honest about it; the machine-readable column is not, and Task
5's search will index the column.

### 13. `palette-save-name` promises an export effect it does not have

`controlCatalog.ts:972`: "the name written into the exported file." The
control writes nothing but local React state (`ColourGroup.tsx:163`); the
Save button is what writes `colour.palette`. The note's own table (line 137)
gives this row the export effect "nothing: the palette library is this
browser's". Trim the clause.

### 14. The exhaustive share round-trip test now skips its deep equality for `part_colors`

`lib/share.test.ts:432` replaces `expect(decoded.params).toEqual(params)`
with a `continue` and seven targeted assertions. The targeted assertions are
good, but the blanket check is gone for that key, so a migration that also
corrupted `colour.palette` or `region_slots` would pass. The note (line 325)
says the test "gained assertions rather than losing them", which is not
accurate.

**Fix.** Keep the deep equality against the expected post-migration object:
`expect(decoded.params).toEqual({ ...params, colour: { ...params.colour, region_colors: expected } })`.

### 15. The brief's invalid-colour migration case is untested

`PART_COLOR_SPEC` (`lib/share.ts:204`) validates each well against
`HEX_COLOUR`, so `{ part_colors: { water: "nope" } }` is refused before
`migratePartColors` runs. The behaviour is correct and unpinned; one test
would keep it that way.

### 16. Disabled states without an explanation

`SurfaceGroup.tsx:42` disables Road scale when roads are off;
`TerrainGroup.tsx:50` and `:61` disable both terrain sliders when terrain is
off; `ColourGroup.tsx:319` disables Save with an empty name. None says why.
`FrameTextGroup.tsx:482` does explain the frame-off case, but it names only
the north arrow and the scale bar, while the same condition disables the
frame profile, corners, lip depth, shadow gap, matting, separate frame,
texture and the lettering editor, four of which sit ABOVE the notice.

### 17. The new e2e help test covers two kinds of primitive, not five

`e2e/ui.spec.ts:998` says "one per kind of primitive". The three controls
read are `#nozzle_mm` (slider), `#water` (toggle) and
`#heights_floor_height_m` (slider). The select, the text field and the colour
well are not covered, and the colour well and the filament-slot select are
precisely the ones using a shared `Hint` id rather than the primitive's own,
so they are the ones a refactor can break silently. I verified by hand that
both currently resolve.

### 18. Region colour wells stay editable where they cannot reach the file

With `color_mode` single and `export_target` set to the generic 3MF, the OBJ
or the STEP, every region is welded into one object
(`lib/engine/export/common.ts:229`), so the per-region colours do not reach
the file. Nothing in the panel says so. The removed
`part-colors-disabled-note` used to say something adjacent. The default
target (Bambu) always writes one object per region, so the wells do matter
there, and the `color_mode` help is accurate about which targets it changes.

### 19. Removing `ColorField` removed the only place a colour's hex was readable

`Controls.tsx`'s deleted `ColorField` printed the hex next to the well and
documented why: "a filament is chosen by its code as often as by its look,
and a swatch alone cannot be read out to a slicer." The per-region rows
(`ColourGroup.tsx:377`) show a swatch only, and `e2e/share.spec.ts:64` now
reads the input's value instead of a visible hex. The rationale is now unmet
anywhere in the panel.

---

## Notes

20. **The note's outstanding item 2 is already resolved.**
    `docs/handoff/v3-02-settings.md:370` says the store still calls
    `engineClient.buildModel` with an already-normalised graph, so the
    `heights.*` help strings promise something that does not happen. In the
    working tree `store/editor.ts:548` schedules `startPipelineRun` with the
    `SceneRequest`, the `fetch` stage claims no params
    (`stages.ts:272`) and `normalise` claims `heights.*` (`:288`), so a
    heights change re-runs normalisation off the cached response with no
    network. The help strings and the new `ui.spec.ts` assertion are true.
    The orchestrator's to-do list should drop that item.

21. **One em dash survives in a file this task edited**: `Controls.tsx:324`,
    inside a comment. `StatsCard.tsx:95` renders one to the user, but that
    file belongs to the pipeline rename, not to this task.
    `AdjustmentsChip.tsx` and `EditorShell.tsx` also contain some.

22. **The note's pointer for the preview-theme toggle is stale.** Line 180
    names `CityPreview.tsx:preview-theme-toggle`; in the working tree it is
    `components/scene/PreviewPane.tsx:57`. `colour.preview_theme` does
    round-trip through a link and a project file (`lib/share.ts:317`), and
    no settings-panel control writes it.

23. **`store/editor.ts:257` still lists `part_colors` as a `setNested` key.**
    Nothing calls it and `store/editor.test.ts` drives it deliberately, so
    this is not a defect, only the last place the removed block is still
    reachable from the UI layer.

24. No `any`, no raw hex, no token violation found in the audited files.
    Keyboard operability is fine everywhere except finding 8: `Segmented`
    implements the full ARIA radiogroup pattern, sliders keep their
    release-to-commit gate off Tab and Shift, and every restructured button
    is a real `<button>`.

---

## Verdict

The mechanism this task introduced is sound and is the right one: a catalog
joined to the pipeline's stage claims turns "does this control do anything?"
from a grep into a lookup, the 96 rows really are the 95 rendered controls
plus one, the removals are complete with no orphans, and the `part_colors`
migration is correct and reaches all three entry points. The copy is a large
improvement and its numbers are right in every case I checked but one. What
the wave did not do is test the thing it claims to have tested. Three of the
four assertions the note leans on are self-referential: the exemption test
reads the catalog rather than the setters, so three controls write the leaf
`[V3.1-P1-13]` forbids; the completeness test reads a hand-written file list,
so nine group toggles are uncatalogued; the aria-describedby test reads one
file, so two buttons ship with a tooltip and no description. And the central
premise, "a leaf claimed by a stage moves the preview and the file", is false
for wildcard-claimed leaves: `frame_style.lip_depth_mm` has a slider, a
catalog row and a table row asserting an effect that the matrix's own
`KNOWN_DEFECTS` says does not exist, and `hanger_magnet.*` has three sliders
that do nothing in one of the two states that reveal them. The table's
Export effect column is a template that is wrong for the six printer rows.
None of this is hidden by a weakened test: no assertion was deleted or
loosened except the one deep equality in finding 14, and every test I ran
passes. The gap is between what the tests check and what the note says they
check. Fix findings 1, 2 and 3, wire the two buttons, correct the tree
numbers and the six printer rows, and the note becomes true.


---

## Fixes

Applied by the implementer against this audit. Every blocker and major, and
every minor. Line numbers are from the tree as written.

### Blockers

**1. Three colour controls wrote `colour.region_colors.attribution`.**
Fixed where the ruling puts it: the group patches the ten other regions and
never spreads a palette table that includes the eleventh.
`ColourGroup.tsx:124 withoutAttributionColour` strips the key, and the three
buttons now go through pure builders that all use it,
`palettePatch` (`:144`), `mergePatch` (`:167`) and `alignPatch` (`:187`), so
there is one guard rather than four call sites remembering. The builders also
re-derive `colour.palette`, which is finding 7.
*Test:* `components/editor/groups/ColourGroup.test.ts`, 7 tests, driving the
real builders and the real store setter rather than the catalog's own `writes`
array: `:47` proves the premise is not vacuous (every built-in really does
declare an attribution colour, and at least one differs from the frozen value),
`:71` applies **every** built-in palette, `:95` runs a real eleven-slot to
two-slot merge, `:132` runs a real align on a fixture that makes `attribution`
a loser, and each reads
`useEditorStore.getState().params.colour.region_colors.attribution` back.

**2. `frame_style_lip_depth_mm` shipped ahead of its geometry.**
The slider is removed this wave, with its catalog row, its help string and its
table row. `FrameTextGroup.tsx:351` carries the reason in place of the control;
`[V3.1-P2-2]` lands the sight-edge rebate next wave and that wave re-adds the
control with it.
*Test:* `controlCatalog.test.ts:425` fails for any control writing a leaf in
`matrix.probes.ts:KNOWN_DEFECTS`, and asserts the list really still names this
leaf, so re-adding the slider before the geometry fails here rather than in the
matrix. `:517` pins the source, comment-stripped. The leaf moved into
`CLAIMED_WITHOUT_A_CONTROL` with the wildcard-claim reason spelled out.

### Majors

**3. The three `hanger_magnet.*` sliders did nothing with a wall hanger.**
`FrameTextGroup.tsx:176` now gates them on `separate.enabled && separate.mount
=== "magnet"`, which is exactly `buildFrameMating`'s own precondition, and
`:639` says what the wall hanger uses instead (a fixed 6.1 by 3.1 mm pocket).
The three help strings say they size the separate frame's mount.
*Test:* the matrix probes for all three already run on `base: SEPARATE_MAGNET`,
so the help now describes the state the probes measure.

**4. Nine group-header toggles had no catalog row and no scan.**
The scan is derived, not typed: `controlCatalog.test.ts` walks every `.tsx`
under `components/editor` recursively and partitions it into scanned files and
`OUT_OF_SCOPE_FILES` (`:138`), each with a stated reason. Thirteen files are
scanned, including `CollapsibleGroup.tsx` and `ExportMenu.tsx`. The group
header is catalogued at `controlCatalog.ts:1228`.
*Test:* `controlCatalog.test.ts:483` fails when a component under
`components/editor` is neither scanned nor excluded, so a new file forces a
decision. Block comments are blanked before scanning, because
`CollapsibleGroup.tsx`'s JSDoc says "a real `<button>`" and that is prose.

**5. Two buttons relied on `title` alone.**
`ColourGroup.tsx:568` and `:588` now carry `aria-describedby` pointing at an
`SrHint`, as `hero-clear-all` does.
*Test:* `controlCatalog.test.ts:505` scans every open tag in every scanned file
and fails any that has `title={labelled(...)}` and no `aria-describedby`. That
is the reach the old `Controls.test.ts` check lacked.

**6. The Export effect column was a template.**
Regenerated from the stage shape rather than from a blanket phrase: only stages
that build or cut a body count as moving a solid, so `validate`, `audit`,
`measure`, `islands` and `export` no longer read as geometry. The six printer
rows and the four metadata rows are written from the probes' own `assertExport`
(`printable_height`, `change_filament_gcode`, the plate-fit and too-tall
findings, `framecraft:palette`), and every one of them now ends "no solid
moves". `colour_slot_*` says the same: a slot changes the tables, not a shape.

**7. `colour_color_*` wrote `colour.palette` undeclared, and align and merge
did not flip it.** The catalog row declares it; `mergePatch` and `alignPatch`
re-derive the id from the resulting table (`paletteIdFor`), so a file can no
longer claim a palette whose colours have since moved.
*Test:* `ColourGroup.test.ts:110`.

**8. The frame-profile picker was a hand-rolled radiogroup.**
`Controls.tsx:337 radioGroupKeyDown` is the ARIA contract as one function, and
`Segmented` now uses it too, so the pattern exists once.
`FrameTextGroup.tsx:287` wires it with a roving `tabIndex`: one Tab stop,
arrows move the selection, Home and End jump to the ends.
*Test:* `a11y.spec.ts`'s Tab walk asserts one stop per radiogroup and reaches
the end of the panel.

**9. The `trees` help string had two wrong numbers.**
`controlCatalog.ts:507`: one and a half times as tall as wide, dropped under
1 mm across. Both constants are radius-based, which is what the note now says.

**10. The catalog's boundary was undeclared and its one outside row was wrong.**
`controlCatalog.ts:25` states the scope in the header. The export select's row
carries its real DOM id, `export_target` (`:1258`), and `ExportMenu.tsx` is now
scanned, so that id is checked rather than asserted.

### Minors

| # | Fix | Where |
|---|---|---|
| 11 | Moot: the Lip depth control and its help string are gone (finding 2). | -- |
| 12 | `printer_profile` declares `plate_mm` and `nozzle_mm`, which `profileApplyPatch` really writes. | `controlCatalog.ts:1111` |
| 13 | `palette-save-name`'s help no longer promises an export effect; Save is named as what writes the name. | `controlCatalog.ts` |
| 14 | The deep equality is restored, aimed at the expected post-migration object, so a migration that also moved `colour.palette` or `region_slots` fails. The six moved colours are still named on top. | `share.test.ts:440` |
| 15 | A malformed v1 colour is refused before the migration runs, and now pinned. | `share.test.ts:1238` |
| 16 | Road scale, both terrain sliders and the frame-off notice say why they are disabled; the frame notice names all nine things the frame carries, not two. | `SurfaceGroup.tsx:46`, `TerrainGroup.tsx:65`, `FrameTextGroup.tsx:502` |
| 17 | The e2e help test reads all five primitives plus the two controls that share one hint between eleven rows. | `ui.spec.ts:1054` |
| 18 | A warning when `color_mode` is single and the target welds every region into one body, naming the target and the two ways out. | `ColourGroup.tsx:247`, `:530` |
| 19 | The hex is readable again, next to every region well, with the reason `ColorField` carried. | `ColourGroup.tsx:460` |

### Notes

| # | Action |
|---|---|
| 20 | Item 2 of the note's orchestrator list is closed, with the working tree's own evidence. |
| 21 | The em dash in `Controls.tsx`'s `Segmented` comment is gone. |
| 22 | The note's preview-theme pointer now says `components/scene/PreviewPane.tsx`. |
| 23 | No action: `part_colors` stays a `setNested` key because the contract is frozen at schema version 3 and `store/editor.test.ts` drives it deliberately. |
| 24 | No action needed. |

### Verification after the fixes

`npm run lint` clean over `components/editor`, the four `lib` files and `e2e`.
`npm run typecheck` reports nothing in any file this task owns.
`npx vitest run` over the six owned files: **111 passed, 0 skipped**
(`controlCatalog` 17, `ColourGroup` 7, `Controls` 14, `groups` 15, `share` 41,
`project` 17).
