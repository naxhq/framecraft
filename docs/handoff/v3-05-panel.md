# v3-05 panel: the settings panel

Task 5 of the v3.1 run, against the tree at `af02c98` plus the wave's other
work. It rebuilds the settings panel around one idea: **a group you cannot see
into is a group you cannot use**, so eleven of the twelve groups now start
closed and every one of them says what it is set to on its own header.

Files: `lib/groups.ts`, new `lib/settingsDiff.ts`, new `lib/settingsSearch.ts`,
`lib/controlCatalog.ts`, `components/editor/{ParamPanel,CollapsibleGroup,
HistoryChip}.tsx`, new `components/editor/{SettingsSearch,ChangesFromDefault}.tsx`,
new `components/editor/groups/{RegionsGroup,BridgesGroup}.tsx`, plus tests.

---

## 1. What starts open, and what a closed header says

`defaultCollapsed()` now opens **Location** and **Scale and size** only. Twelve
open groups is a 4000 px scroll on a 1280 screen, which is how a panel ends up
being read by scrolling instead of by looking. The expanded set is still
per-device `localStorage` (`framecraft-groups`), still merged over the defaults
so an unknown or corrupt key falls back rather than rendering everything shut,
and still **layout, not a setting** (`[V3.1-O6]`): it never enters
`PrintParams`, so it cannot reach a share link, a file or the changes counter.

That trade only works if a closed group can be read, so
`lib/groups.ts:summariseGroup(id, params, context)` computes one line per group
from the CURRENT parameters, and `CollapsibleGroup` renders it on the header
whether the group is open or closed:

| group | line at the defaults |
|---|---|
| Location | `no place name, 900 m radius` |
| Scale and size | `180 mm plate, 3 mm base, 0.4 mm nozzle` |
| Buildings | `0/12 heroes` (plus `small 120 %` / `tall 150 %` when moved) |
| Heights | `3 m storeys, 8 m fallback` |
| Surface | `roads engraved, water, trees` |
| Surface depths | `roads 0.6 mm deep, water 1 mm, rail 6 m wide` |
| Bridges | `on, 1 mm clearance, abutments` |
| Terrain | `off, the base stays flat` |
| Frame and text | `plain, 6 mm border, 0 lines` |
| Colour | `default, one filament` |
| Printer | `custom printer, one piece` |

Never a fixed string: `groups.test.ts` asserts each line differs from the
group's standing summary, and that the line moves when the field it names
moves. The Buildings line keeps the exact `N/12 heroes` fragment
`e2e/ui.spec.ts` and `e2e/share.spec.ts` have always read off that header.

## 2. The header reads as a header

The old header was 11 px uppercase in the FAINT ink on the SAME surface as the
controls under it, i.e. quieter than the control labels it was heading. Now:
the sunken surface behind it, `text-xs` semibold in full ink, a 2 px rule
standing at the left edge of an open group, the computed state line right
aligned and truncated, a count badge when the group holds changes, and the
body on the raised plate with the standing summary at the top. Three signals,
none of them colour alone.

The per-section **Reset** is a SIBLING of the toggle, never a child: a button
inside a button is invalid HTML and unreachable by keyboard in several
browsers. It is invisible (and disabled) while the section is already at its
defaults.

## 3. Section reset, and the changes list

Both are `lib/settingsDiff.ts`, which is the one place that answers "what has
moved":

- **A section owns exactly the leaves its controls write**, read off
  `lib/controlCatalog.ts` rather than typed out again, so a reset cannot touch
  a field the section does not show. `frame_style.lip_depth_mm` has no control
  (`[V3.1-P2-6]`) and a Frame reset provably leaves it where it is; Surface owns
  `road_mode` and Surface depths owns `regions.roads.*`, and neither reset
  reaches the other.
- **One undo entry.** A reset touching one top-level key goes through
  `setParam` (which is also what reschedules the terrain job for the two fields
  that need it); a reset touching several goes through `applyHistorySnapshot`
  with the current location and the new params, which is one `set()` call and
  therefore one entry (see section 6). A per-row revert is always one key, so
  always `setParam`.
- **The counter counts settings, not events.** `changeCount` is every leaf that
  differs from the contract default and is a setting at all. The three
  `place.*` names the reverse geocoder writes from the pin, `schema_version` and
  `colour.preview_theme` are excluded by name and with a reason
  (`NOT_A_SETTING`), because "3 changed" on a design nobody has touched is
  worse than no counter.
- Fields that differ and have no control (the six `heights.type_defaults.*`,
  `custom_profile.nozzle_mm`, `frame_style.lip_depth_mm`) are counted and named
  in a note at the foot of the list, saying Reset all is what puts them back.

The list itself is the panel header's `changes-chip`, opening `changes-list`:
one row per changed setting with the control's own label, its section, its
default, its current value and a Revert.

**It is not the floating history chip.** `HistoryChip` counts undo STEPS and
`e2e/workflow.spec.ts` pins that count ("3 changes" after three edits); this
counts fields that differ from the contract right now. Two questions, two
answers, deliberately worded apart ("3 changes" against "3 changed").

## 4. Search

`lib/settingsSearch.ts` indexes the catalog: every control's label, its
section's heading and its help string, which is the copy the control itself
renders. Every query token must match, so "rail width" narrows where "rail"
does not; an exact label beats a word-boundary hit in a label, which beats a
mention in a help string.

In the panel: groups with no hit are not rendered, groups with a hit are forced
open WITHOUT touching the stored collapse state, each such group gets a hit
list at the top of its body with the matched runs marked, and the real controls
stay on screen below it. A hit row focuses and scrolls to its control; a hit on
a labelled block or on a control rendered once per item (`engraving_*_text`)
has nothing single to focus and only opens the group. `/` focuses the box from
anywhere that is not a text field, Escape empties it, and there is a Clear
button in the box and another in the empty state, which names what was searched
for and suggests plainer words.

The `output` group is deliberately not indexed: Reset all is always on screen
and the export-format select lives in the action bar, so a hit there could not
be scrolled to.

## 5. The two contract groups that had no UI

Both were read by the geometry stages and reachable through a share link with
no control anywhere (`docs/handoff/v3-02-settings.md` section 5).

**Surface depths** (`regions.*`, ten controls). A region spans
`[base_top + proud - depth, base_top + proud]` and the base is carved by the
same footprint (`solid/areas.ts`), so the help strings say exactly that: a
thickness and a height against the plate top, per region, plus the rail
ribbon's ground width and the building skirt. Roads and water are disabled with
a note when the Surface group has switched that layer off.

**Bridges** (`bridges.*`, three controls). `bridges.enabled` has defaulted to
TRUE since schema_version 3 with no way to turn it off, which was the sharpest
gap on that list. Off, every crossing is laid at grade, which is v2's
behaviour; on, the deck stands `clearance_mm` above the local surface with an
abutment under each end, and switching the abutments off tells the user the
decks print as loose pieces, which is what the engine's own finding says.

`controlCatalog.test.ts:CLAIMED_WITHOUT_A_CONTROL` loses all thirteen entries.
What is left in it is machine-written data, the six-row building-type table
nobody has drawn, and `frame_style.lip_depth_mm`.

**The Lip depth slider is back**, in the Frame profile block, because its
geometry landed in the same wave: `[V3.1-P2-2]` cuts a sight-edge rebate into
the lip's inner top edge, `lip_depth_mm` deep by `transform.FRAME_SIGHT_EDGE_MM`
(1.0 mm) wide round the opening, and the default frame volume moved from
9159.31 to 8900.74 mm3 with it. The help string names that fixed 1.0 mm width
as well as the depth, because the width is not a setting and a reader given
only a depth cannot picture the step; it also says zero leaves the lip flat.
`[V3.1-P2-6]` is satisfied in the order it demands: the effect first, then the
control.

## 6. Undo and redo cover what the panel writes

`store/history.ts` records by SUBSCRIBING to the editor store and diffing
`location`/`params` by reference, so it covers every panel write for free: one
`set()` call in, one entry out. Every control in the panel writes through
`setParam`, `setNested` or (for a multi-key section reset)
`applyHistorySnapshot`, and each of those is exactly one `set()`. Nothing the
panel stores about ITSELF is recorded, which is correct: the expanded set and
the search box are not parameters.

Two gaps, both label-quality rather than correctness, and both in files this
task does not own:

1. **A composite write is labelled by its first changed key.**
   `describeChange` walks the top-level keys and returns on the first
   difference, so a Frame section reset reads "Frame changed" in the history
   list rather than "Reset: Frame and text". It is still ONE entry and undo
   still restores everything in it. Fixing it wants a small hook in
   `store/history.ts` (a label to use for the next recorded change).
2. **`NestedParamKey` has no `regions` or `bridges`.** The two new groups
   therefore write through `setParam` with a spread rather than `setNested`.
   Same result, one more line per call site. Worth adding both to the union in
   `store/editor.ts`, and a real `applyParamsPatch(patch: Partial<PrintParams>)`
   would let a section reset stop borrowing `applyHistorySnapshot`.

Undo and redo are also now VISIBLE: they were three interactions deep (open the
drawer, find the button, press it) while the shortcut sheet advertised Ctrl+Z.
They are buttons on the history chip's own row, with the step list still in the
drawer, and the shortcuts are unchanged.

## 7. Tests

| File | What changed |
|---|---|
| `lib/settingsDiff.test.ts` | New. 20 tests: leaf read and immutable write, an absent v3 block filled from the contract, what each section owns, a reset that leaves the uncontrolled `heights.type_defaults.*` rows and the other sections alone, the Frame section owning `lip_depth_mm` again now that its geometry is in, the reset and the revert driven through the REAL store setter, the counter against the geocoder's own writes, and the `[V3.1-O6]` pin that layout state has no key in `PrintParams` to land in. |
| `lib/settingsSearch.test.ts` | New. 13 tests: every group reachable, nothing from the action bar, matching by help as well as by label, the ranking, the focus target, and highlighting (merged overlaps, every occurrence, the string rebuilt exactly). |
| `lib/groups.test.ts` | Twelve groups, the new default open set, and a new block for the header state lines including the two new groups and a v1 payload with neither block present. 21 tests. |
| `lib/controlCatalog.test.ts` | `CLAIMED_WITHOUT_A_CONTROL` loses the ten `regions.*` and three `bridges.*` rows, and then `frame_style.lip_depth_mm` when its slider returned. The target set gains `section-parameters`, with a new test that checks it from the other end: every group has leaves for its reset, and every leaf a reset would write is one a control in that group writes. The removal pin for the Lip depth slider became a return pin (the source renders it again) plus a new test that its help names the rebate's fixed 1.0 mm width and what zero means. |
| `lib/contrast.test.ts` | The control-boundary inventory gains `SettingsSearch.tsx` and `ChangesFromDefault.tsx`. |
| `lib/keyboard.ts` | One display-only row for `/`, so the shortcut sheet lists it. Bare `/` is still not dispatched by that module; the panel owns it. |
| `e2e/ui.spec.ts` | The collapse test now asserts the new default set and reads a computed header line. Four tests gained an `openGroup(page, "buildings")` and one gained Surface and Heights. Four new tests: the search (shortcut, filtering, marking, focus, empty state, and that clearing restores the panel), a section reset with its single undo step, the changes list with a per-row revert and the `[V3.1-O6]` check that opening a group is not a change, and the ten surface-depth sliders driving a rebuild. |
| `e2e/a11y.spec.ts` | The axe sweep and the unnamed-control census now open EVERY settings group (their comments always claimed they did). The tab walk opens the six it has always covered, explicitly; Surface depths and Bridges are left out of that one on purpose, because the walk is bounded at 120 presses and must complete a cycle. |
| `e2e/smoke.spec.ts`, `e2e/share.spec.ts`, `e2e/workflow.spec.ts` | One `openGroup` each (Buildings, Buildings in both contexts, Surface). Mechanical: no assertion changed. |

Nothing was skipped, weakened or deleted.

## 8. Verification

`npx tsc --noEmit` over the whole app: **clean, no output**. `npm run lint`
(`eslint . --max-warnings 0`): **clean**. Both were re-run after the last edit
in this task, so the tree compiles at this stopping point.

`npx vitest run` over the whole app: **2074 passed, 22 failed**, and every
failure but one belongs to the frame and lip-depth geometry landing in
parallel (`solid/frame`, `attribution`, `synthetic`, `terrain`, `matrix`,
`export/tiles`). The one on this task's surface is item 1 below.

`next build` and Playwright were not run: the build lock was held elsewhere for
the whole of this task. The e2e above is written, typechecked and linted, and
has not been executed.

## 9. For the orchestrator

1. **`controlCatalog.test.ts` has one red assertion, and it is a cross-agent
   ordering effect rather than a defect in the panel.** Two sliders ship here
   whose geometry ships in **w4-engineperf2**'s work in the same wave: Rail
   width (`[V3.1-P2-1]`, the parameter made authoritative for every rail
   ribbon) and Lip depth (`[V3.1-P2-2]`, the sight-edge rebate). That test
   refuses a control for any field still listed in
   `lib/engine/pipeline/matrix.probes.ts:KNOWN_DEFECTS`, and both engine halves
   are already in the working tree while both `KNOWN_DEFECTS` rows are still
   there. It goes green when w4-engineperf2 deletes them, which that agent is
   doing in the same pass; the orchestrator ruled to ship both sliders on that
   basis. Neither the engine nor `KNOWN_DEFECTS` was touched here, and the
   assertion was not weakened: its stale "the list still names lip depth"
   vacuity guard is now a two-sided check that each of those two fields is
   absent from `KNOWN_DEFECTS` AND has a control, which is the state the
   deletion produces.
2. **Two other red rows in this selection belong to other tasks, and both
   predate anything here.** `lib/contrast.test.ts` needs one more inventory
   row, `components/editor/PaneChrome.tsx`, which uses `border-control` and is
   the shell task's new file (my two are in). `lib/design-tokens.test.ts`
   reports a raw `#ffffff` in `components/scene/RegionMeshes.tsx`, which is the
   scene task's file and outside this task's ownership entirely.
3. **Three specs outside this task's ownership were edited, minimally**
   (`smoke`, `share`, `workflow`: one `openGroup` call each) plus `a11y`
   (the three group loops), because the new default collapse state unmounts
   controls those tests drive. No assertion was changed in any of them.
4. **`lib/keyboard.ts` gained one display-only row** so the shortcut sheet
   mentions `/`. It dispatches nothing new.
5. **Two store improvements are named in section 6** and neither blocks: a
   label hook for a composite write in `store/history.ts`, and
   `regions`/`bridges` in `NestedParamKey` plus an `applyParamsPatch` setter in
   `store/editor.ts`.

---

## Follow-up (v3.1): the pinned Output section starved the group list

`e2e/a11y.spec.ts`'s tab walk failed on `group-buildings-toggle` with
`<section data-testid="group-output"> intercepts pointer events`. It was not a
z-index overlay. Measured on a production build at 1280x720, the settings
column spent its 599 px like this:

| region | height |
| --- | --- |
| `action-bar` (`shrink-0`) | 199 px |
| `ParamPanel` header | 43 px |
| search box + its printed hint | 103 px |
| **`param-groups`** | **0 px** (scroll height 8134 px) |
| `group-output` (`shrink-0`) | 381 px, 127 px of it clipped off the bottom |

`flex-1` is `flex: 1 1 0%` with no floor, so the group list absorbed all the
negative free space and collapsed to zero visible height. Every group toggle
was then unclickable, and the last 127 px of the Output section - the bottom of
the stats and recent-designs cards - was clipped away by the sheet's
`overflow-hidden` and reachable by nothing.

`[V3-P4-U]`'s `max-h-[45vh]` cap was meant to prevent exactly this and could
not: **the viewport is not the column.** 45vh is 324 px at this height, and the
column had 254 px left after the action bar and the panel header, so the cap
never bound. Three changes, all in the space actually being divided:

- `param-groups` carries `min-h-[45%]` instead of `min-h-0` - a floor measured
  against the panel, which has a definite height the whole way up. It binds
  when the column is short and gets out of the way when it is tall.
- `group-output` drops `shrink-0` and becomes a `min-h-0` flex column, so it
  shrinks and scrolls inside the column instead of overflowing it. It stays
  pinned (`[V2-P4]`); the action row that pin was written for has since moved
  to `ActionBar` at the top of the column, so what is pinned here is results.
- `OutputPanel`'s results block is `flex-1 min-h-0` rather than `max-h-[45vh]`.

**Visible change:** the search box's three-line printed hint is now `SrHint`
(the component whose whole purpose is "a control with no room for a visible
line"). The copy, the `aria-describedby` wiring and the id the hit rows and the
clear button reference are unchanged, and it is also on the box's `title`; it
was costing the group list 51 px on every screen forever to repeat what the
placeholder and the `/` badge already say. Search block: 103 px -> 53 px.

After: group list 180 px and scrolling, Output 124 px and scrolling, nothing
clipped (the sheet's scroll height equals its own height again), all six
toggles reachable.

**Verified both directions** on a real `next build` served as static files, in
an isolated tree on its own port:

- `e2e/a11y.spec.ts` 4/4 pass, tab walk included (115 distinct controls over
  120 presses); `e2e/print.spec.ts` 4/4 pass.
- Mutation probe: the pre-fix `shrink-0` / `min-h-0` / `max-h-[45vh]`
  construction restored (keeping the search-hint change, so the flex fix is
  shown to be the load-bearing one) -> the tab walk fails again with the same
  `group-output ... intercepts pointer events` and the search box subtree
  intercepting. The test would catch this coming back.

Pre-existing and NOT caused by this change, confirmed by building HEAD in the
same isolated tree and re-running: `e2e/shell.spec.ts` 4 failures (it waits on
`getByTestId("region-settings")`, a test id `ResizableRegions` does not render)
and `e2e/ui.spec.ts`'s two hero-picking tests.

---

## Follow-up 2 (v3.1): six e2e failures that were never anyone's

Six tests were failing before this task and were verified against HEAD in an
isolated tree first, so none of them came from the panel fix above. Four are
`shell.spec.ts`, written during Task 4 and, on the evidence below, **never
run**; two are `ui.spec.ts` hero tests. One of the six was hiding a real
product defect.

### The real defect: Copy link did not carry the layout

`ActionBar` computes the share URL in a `useMemo` keyed on `[href, location,
params]`, and `shareUrl` defaults its layout argument to
`currentLayoutPayload()`, which reads the layout store imperatively. But
`ActionBar` subscribed to nothing in that store and takes no prop from
`ResizableRegions`, so a divider drag or a hidden column never re-rendered it
and the memo never re-ran. Measured on the shipped build: dragging the map
divider 400 px -> 500 px and then collapsing the settings column left
`data-share-url` **byte for byte unchanged**. `[V3.1-O6]`'s promise that a
shared design opens the way its author framed it was broken through the one
button that makes the link.

Fixed by subscribing to `sizes`, `collapsed` and `maximized` and passing the
payload explicitly, built by `lib/layout.ts:layoutPayload` -- the same pure
function `currentLayoutPayload` calls, so there is still one definition of what
a payload is. Save project was never affected: it builds its payload at click
time rather than from a memo, which is why only the permalink test caught this.

### The four `shell.spec.ts` failures

1. **`widthOf(page, "settings")` asked for `region-settings`,** a test id that
   has never existed -- the settings column is `param-sheet` (`ResizableRegions`
   names it after the bottom sheet it becomes below `lg`). Every settings-width
   assertion in the file threw on a null box instead of measuring, and two tests
   burned a 300 s timeout each. Corrected to the real id; four dead assertions
   are now live.
2. **The first thing those live assertions said was that one of them was wrong.**
   After dragging the settings divider 60 px and double-clicking the *map*
   divider, the file expected the settings column back at its default -- while
   the sentence directly above it said "puts ONE divider back and leaves the
   other where it was", and `lib/layout.test.ts` pins exactly that ("map back to
   default, settings still 500"). Corrected to `DEFAULT_SIZES.settings + 60`.
3. **The scroll test measured its own scrolling.** It set `param-groups`
   `scrollTop = 120`, then started a run by filling `#plate_mm` -- which sits at
   y ~= 985 in a 180 px port, so Playwright scrolled it into view and the list
   moved to 653, and the next assertion reported "a run in flight moved the
   settings column". The run moves nothing: measured 653 before the overlay
   appeared, while it was up, and after it cleared. It now scrolls the control
   into view first and takes the baseline there, and asserts the baseline is
   neither 0 nor pinned to the maximum, which is what the original comment
   claimed and never checked.
4. The permalink test, which was the real defect above.

### The two `ui.spec.ts` hero tests

Neither was a picking defect; both screenshots said so.

5. **Keyboard:** the pick worked -- the cursor read "Building 2 of 992 - 303 m -
   hero" and the viewport chip read "1 hero building" -- but the hero LIST lives
   in the Buildings group, collapsed by default since Task 5, so `hero-item` was
   unmounted. The test was measuring a collapse state. It opens the group now,
   the same one-line correction `smoke`, `share` and `workflow` already got.
6. **Click:** it waited for `preview-canvas` and `preview-stats`, both of which
   are on screen while the solid engine is still running, then clicked into an
   empty viewport -- the failure screenshot shows "Building the model:
   attribution - 20 of 80 - 4.0 s elapsed" with nothing rendered. It waits for
   the stage overlay to clear now.

   With that fixed it failed differently, and the second failure is worth
   recording: picking a hero rebuilds the model, and a pixel on the boundary
   between two roofs can belong to the neighbour afterwards, so a second click
   there ADDS a hero instead of dropping the first. Measured: Aon Center (340 m)
   picks and drops cleanly from the same point; Parkline (78 m) picks, then the
   same point adds an unnamed 15 m neighbour. The camera does not move and the
   silhouette does not change (screenshots before and after are the same
   framing) -- the offsets grid is simply coarse against 992 buildings in a
   900 m crop. So the search is now for a point that ROUND TRIPS: click picks
   exactly one hero, and a click on the same point drops it. That is the whole
   claim under test rather than a weaker one, and a point that fails either half
   is an edge pixel, not a verdict on picking.

### Verified both directions, isolated build and port

Green: `shell.spec.ts` 8/8, `ui.spec.ts` 25/25, `a11y.spec.ts` 4/4 -- 37 tests,
4.1 min, from six failures and two 300 s timeouts.

Mutations, each reintroduced on its own:

| reintroduced | result |
| --- | --- |
| `ActionBar` back to HEAD (no layout subscription) | permalink test red, the other seven green |
| `widthOf` back to `region-settings` | both settings-width tests red, one at the original 5-minute timeout |
| the keyboard test's `openGroup("buildings")` removed | red |
| the click test's round-trip search back to first-pick-wins | red |

Not touched, and still failing for their owners: nothing -- all six are green.

## Follow-up 3 (v3.1): the smoke happy path wanted two `openGroup`s, not one

`e2e/smoke.spec.ts`'s "happy path" burned its whole 300 s test timeout waiting
for `getByRole("radio", { name: "emboss" })`, and took the other seven tests in
the file down with it -- the file is `test.describe.configure({ mode: "serial" })`,
so a failure in the first test leaves the rest reported as "did not run". That
is the whole of the "7 did not run" line in a `--project=chromium` run.

The table above records this file as having got "one `openGroup` (Buildings)".
It needed two. Step 5 drives four PrintParams controls in a row, and they are
not all in one group: `plate_mm` and `base_thickness_mm` are in Scale and size
(open by default), `large_scale` is in Buildings, and `road_mode` -- the
segmented control whose stops are named `engrave` / `emboss` / `off` -- is in
**Surface**, which is collapsed and therefore unmounted. The test opened
Buildings and then reached straight past Surface for a control that was not in
the DOM. Nothing about the `min-h-[45%]` / `min-h-0` layout work was involved:
the page snapshot from the failing run shows the Surface toggle present and
unexpanded, with Location, Scale, Buildings and Output expanded around it.

Corrected with `openGroup(page, "surface")` before the two `road_mode` clicks,
which is what a user does to reach that control. No assertion changed.

Verified both directions on an isolated static build and port: `smoke.spec.ts`
8/8 green (1.5 min); with the one line removed again, red at exactly the
original symptom -- 5.1 min, "waiting for getByRole('radio', { name:
'emboss' })", 1 failed and 7 did not run.

One unrelated near-miss seen once in those runs and not reproduced: "a
lettering change reaches the model inside the interaction budget" measured
401.3 ms against its 400 ms budget on a loaded host, then 380 ms on the next
run. It is a 0.3 % overrun on a busy machine, not a regression from this fix,
but the budget has no headroom left at `E2E_BUDGET_FACTOR=1`.
