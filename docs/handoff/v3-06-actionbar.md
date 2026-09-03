# v3-06 action bar: the two actions, in one place that never moves

Task 6 of the v3.1 run. Sections 1 to 3, 5 and 9 were written after the fact by
the auditor, from the code as it stood at the Wave 3 checkpoint `af02c98`: the
agent that built this was interrupted before it wrote anything down. Sections 4,
6, 7, 8, 10 and 11 were rewritten by the closing pass that fixed everything
section A of `v3-06-interrupted-audit.md` found. Where the code and a claim
about it disagree, the code is quoted.

Files: `apps/web/components/editor/ActionBar.tsx`, `ProgressBar.tsx`,
`ExportErrorDetail.tsx`, `ExportMenu.tsx`, `OutputPanel.tsx`,
`IssuesBadge.tsx`, `EstimateCard.tsx`, `StatsCard.tsx`, `lib/exportFlow.ts`,
their tests, and `e2e/actionbar.spec.ts` (new in the closing pass). The mount
point is in `EditorShell.tsx`.

The decision text this task's files cite three times is in section 12; it is
`[V3.1-T6]` and the orchestrator appends it to `DECISIONS.md`.

## 1. The defect it closes

Preview and Export used to open `OutputPanel`, the results block at the bottom
of the settings column. Everything else in that block -- the export status
line, the download links, the estimate card, the stats, the resolved-output
table -- grew and shrank as a run reported. So the two buttons the whole
editor exists for moved under the pointer at exactly the moment the user was
watching them, and a finished export could push Export itself off the visible
part of the column.

The fix is structural rather than cosmetic. `EditorShell` now mounts
`ActionBar` as a SIBLING of `ParamPanel`, at the top of the settings column
and outside the panel's own scrolling list:

```
aside (settings column)
  ActionBar        <- fixed at the top, never scrolls away
  ParamPanel       <- scrolls, and holds the results panel at its end
```

Everything that can change size is rendered after the controls, so a run, a
cancel, a failure and a finished export can only ever move what is UNDER
them.

## 2. What the bar holds

In order, top to bottom:

| Slot | Control | Notes |
|---|---|---|
| actions, row 1 | **Preview** | Becomes **Cancel** while a run is in flight, and stays enabled there. |
| | **Export** | Disabled while exporting, and whenever `exportBlockReason` returns a reason, which is then its `title` and the text of `export-block-reason`. |
| | **format select** | `ExportMenu`, a native `<select>` over the seven `EXPORT_TARGETS`. |
| actions, row 2 | **Save project**, **Load project**, **Copy link** | The quieter row: a `.framecraft.json` write, a file-input read, and the compressed share link. |
| status | `ProgressBar` while something runs, otherwise one line of text | One slot, so the two never stack and never leave a gap. |
| notes | predicted height, the reason Export is refused, a failure's message with its copyable block, the share link | All below the controls, by construction. |

The RESULTS stay in `OutputPanel`: estimate, export links, resolved output,
stats, recent designs, in that fixed order, each slot rendering nothing inside
its wrapper rather than disappearing, so a result arriving never reorders the
ones below it. Actions here, outcomes there.

**Preview's enablement** is `sceneStatus === "ready" && !sceneStale &&
hasModel && !pipelineStale` -- disabled only when the model on screen already
matches this location AND these settings. The second half of that is the part
worth keeping: after a cancel the scene is still current but there is no fresh
model, and a Preview that stayed disabled there would leave the user nudging a
slider back and forth to get a build started.

**The format select is compact on purpose** and does not lose what a wider
control would have said. Every option carries its one-line description as a
native `title`, and the selected target's description is rendered under the
bar and pointed at by `aria-describedby`
(`EXPORT_TARGET_DESCRIPTIONS`, a `Record<ExportTarget, string>` so a target
added to the contract fails to compile rather than shipping undescribed).
Selecting a target writes `params.export_target` through the ordinary
`setParam` path, so it round-trips through a share link and a project file
like every other control.

## 3. The progress model is reported, never invented

`ProgressBar` is determinate and reads `state.pipeline.progress`, which the
worker fills by naming each stage before it runs it. The fill is the plan's
own `index / total`. There is deliberately no timer-driven animation of the
fill: a bar that creeps forward on a clock is a lie about how much is done,
and the whole reason the pipeline reports stages is so this does not have to
guess. The elapsed figure is the page's wall clock; the "left" figure appears
only once the store has an `etaMs` at all, which it sets after three stages
have reported and never before, because two stages into a plan of seventy any
number would be noise.

An export is one job over the same plan, and the arithmetic says so rather
than assuming it:

- `EXPORT_PLAN_IDS` and `BUILD_PLAN_IDS` are `planFor("export")` and
  `planFor("full")`; `EXPORT_WRITER_IDS` is the tail of the first past the
  second.
- While the build half runs, the numbers are the run's own counted against the
  EXPORT plan's length, so the bar does not jump when the writer starts.
- Once the model is already fresh, the export IS just the writer, and the bar
  stands at the last step instead of walking through stages that never ran.
  Its `etaMs` there is `null`: the store times the run's stages, not this one,
  so there is no honest number for "left" and therefore no number.

That the export plan really is the build plan plus a tail is pinned in
`ActionBar.test.tsx` rather than assumed in `ActionBar.tsx`, so a stage added
to the export phase moves the control instead of quietly making its
denominator wrong.

The live region announces the PHASE, not the stage. A full Chicago plan
reports 142 stage events; five phase changes is a commentary, 142 is noise.

## 4. Cancel, including a cancel during an export

Preview becomes Cancel while `pipeline.status === "running"` and calls
`cancelPipeline()`. Four things are true of a cancel and none of them is an
error:

1. **The model on screen stays.** The store keeps the last good result; only
   `pipeline.stale` goes true.
2. **The status says where it stopped.** `statusLine` renders
   `Cancelled at <stage label>.`, held until the next run starts, and the run
   is not reported as a failure anywhere.
3. **Preview lights up again immediately**, by the `!pipelineStale` half of
   the enablement rule above.
4. **A cancelled EXPORT reads as cancelled**, names its stage, and leaves the
   previous download alone.

Point 4 is what the audit found broken (A2, blocker). Press Export, then Cancel
while the build half runs, and the bar said "The export was refused: The engine
could not build a model." -- false in both halves. The chain:
`cancelPipeline` leaves `pipeline.error` at `null` deliberately, because a
cancel is not a failure; `requestExport` then sees its run resolve `null` with
no error to quote and writes its fallback string; the bar turned that string
into an `exportFailureModel`, so the copyable block recorded
`what: the export was refused` for something the user asked for.

**Nothing in a single store snapshot can separate the two.** A gate refusal and
a cancelled export land in the same `exportState.phase` of `failed`, with
`pipeline.error` null in both cases and the same fallback message available. The
transition can: a run that stopped running without landing a NEW result and
without an error was stopped by somebody. That is `stepRunOutcome`, a pure
function of the previous render's observation plus this one's, and
`useRunOutcome` is the effect that drives it.

```
running true -> false, result unchanged, no pipeline/scene error
  => cancelled at `stage`, and it was an EXPORT's cancel if an export was in
     flight when the run went down
```

Two details are load-bearing and both are pinned:

- **The export-in-flight bit is a ref, not a read of `exportState.phase`.** The
  store writes the cancelled pipeline and the failed export in two `set` calls
  that React batches into one render, so by the time the effect looks the phase
  has already moved to `failed`.
- **A cancel is retired by the next export and by a finished one**, or
  "Cancelled at roads." would still be on screen under a fresh download link.

The surface is the same `ExportErrorDetail` in a quiet tone rather than the
danger palette, under `export-cancelled-detail`, and it says what happened, at
which stage, and that the previous download is untouched. `exportStatusLabel`'s
`failed` case stopped echoing the store's message for the same reason: the
results panel's phase row now reads "No file written", which is true of every
failed export ([V3.1-P1-15]), and the sentence explaining WHY belongs to the one
surface that can tell a cancel from a refusal.

The store is unchanged. The bar reports what it observed; a follow-up that makes
`requestExport` write a cancelled outcome itself is listed in section 10.

`EditorShell` also makes Escape the cancel key, but only as the ELSE branch of
the overlay rule: with a sheet, drawer, issues list or history popover open,
Escape closes that, because Escape with a drawer up is a request to close the
drawer, not to abandon a build the user cannot even see behind it. With
nothing open and a run in flight, it cancels.

## 4b. The dead branch that came out

`ActionBar.tsx` disabled Preview on `!pipelineRunning && (fetching || nothingToPreview)`
and labelled it "Previewing..." while `fetching`. Both were unreachable (A5):
`scene.status === "loading"` is written in exactly one place, inside
`generate()`, and the next statement starts the run in the same synchronous
block, so `pipelineRunning` is true whenever `fetching` is and `Cancel` always
wins. A disabled expression with a branch nothing can enter is a claim about
behaviour no test can fail, so it is gone and the reachable state is asserted
instead.

## 5. The skeleton rule

The rule this wave adopted (`[V3.1-T6]`, and `EstimateCard.tsx`'s own header):

> A skeleton may only be shown while a request is in flight AND there is no
> previous value to show.

So a FIRST build shows one; every rebuild keeps the previous figures on screen,
dimmed and labelled as the previous computation, because they are still the
best answer there is; and in every settled state -- idle, error, completed --
there is no skeleton at all. An idle skeleton is the defect this replaces: it
says "loading" when nothing is loading, forever.

`ActionBar.test.tsx`'s last block is the load-bearing one. It scans the
RENDERED markup of the action bar, the estimate card and the stats card in the
idle, error and completed states and asserts that no skeleton appears in any
of the nine combinations, and it looks for a skeleton by shape -- a
`data-testid` ending `-skeleton`, or the shimmer keyframe -- rather than by
naming the one test id today's implementation happens to use, so a skeleton
spelled a new way is still caught. The positive cases are pinned beside it: a
first build DOES show `estimate-card-skeleton`, and a rebuild over a previous
value shows none.

## 6. The failure surface

`ExportErrorDetail` is one component used three times: a run that broke
(`run-error-detail`), an export that was refused (`export-error-detail`) and an
export the user cancelled (`export-cancelled-detail`, in the quiet tone). Which
one is on screen is `failureNotice`, a pure function, and the order in it is the
argument: a run failure outranks an export's report of it, and a cancel is
checked BEFORE a refusal because the store gives both the same phase and the
same message. Two rules govern all three, and they are the whole point of the
component:

1. **The main text is readable.** One sentence naming what failed and where,
   in the words the engine used. No stack, no `at Object.<anonymous>`, no
   JSON. A traceback in the panel tells a user nothing and hides the one
   sentence that would have.
2. **Nothing is swallowed.** The message, the failing stage, the blocking
   finding ids, the stack when one crossed the wire, the application version
   and a fingerprint of the parameters are all one click away on
   `Copy details` -- and that click also REVEALS the block, so a browser that
   refuses clipboard access still leaves the text selectable. (The same
   fallback `Copy link` already uses.)

The stage and the finding ids are also on the element as `data-stage` and
`data-findings`, and the palette as `data-tone`, so a test can assert the
diagnosis rather than the prose. The three uses carry different test ids, so a
run failure, an export refusal and a cancel are separately addressable and can
never be mistaken for one another.

The refusal's finding ids are re-derived from the model on screen with
`blockingFindings`, the SAME function the gate refuses with, rather than parsed
back out of the sentence, so the ids in the block are the gate's own.

**The surface is its own store subscriber** (`RunOutcomeNotice`), for the reason
`RunStatus` is one: telling a cancel from a refusal needs
`pipeline.progress.stage`, which a full Chicago run writes 142 times, and
reading that from `ActionBar` would re-render the buttons, the share-link memo
and every note on all 142.

## 7. The IssuesBadge fix

`e2e/print.spec.ts:111` had a race, and it was the badge's fault rather than
the test's. The badge cleared EVERY optimistic "Fixed" mark whenever the
findings list changed. Pressing a row's fix button schedules an incremental
run 80 ms later (`PIPELINE_DEBOUNCE_MS`, `[V3.1-P1-3]`, down from 400), and
any new findings array -- including one that still carried the row just fixed
-- wiped the mark, so the button went back to offering the same fix a second
time on a setting that had already moved.

The rule now: **a mark belongs to its ROW and is retired when the row is.**
That is `survivingFixedIds(marked, findings)`, a pure function the effect
calls, covered by `IssuesBadge.test.tsx` (5 tests) on the four cases that
matter: the mark survives a new array carrying the same id, it is retired when
its row goes, only the rows that went are retired, and an empty findings list
retires everything.

**The e2e proof was weakened before it was strengthened.** The v3 form asserted
the transient directly ("disabled, reading Fixed"), which an 80 ms debounce can
finish before an assertion looks at it. The v3.1 form replaced it with
`expect.poll(...).not.toBe("still offered")`, and the audit showed that passes
with the defect present: `.not.toBe` is satisfied the moment the row retires,
and the broken behaviour ends with the row retired too. Reverting
`IssuesBadge.tsx` to `setFixedIds(new Set())` left the spec green (A3).

What pins it now is a recorder inside the page, installed before the click. It
samples the fix button on every DOM mutation and every animation frame, keeps
only the transitions, and the assertions read the resulting sequence after the
row has retired:

1. `disabled:Fixed` really appears, so the rest is not vacuous.
2. No `enabled:` state appears after it. The defect writes exactly that: the
   findings array that lands 80 ms after the click still carries this row, so
   clearing every mark puts the fix back on offer while the row is on screen.
3. The last state is `absent`, so it was the row that retired the mark.

A recorder has no race to lose, and it fails for the right reason with the
sequence printed in the message. The weaker poll is kept beside it as a liveness
check.

## 7b. The export writer's findings reach the badge

`DECISIONS.md [V3.1-P7-5]` says a face that float32 hardening cannot clear "is
reported as a `float32-degenerate` warning that reaches the sidecar, the CLI and
the Issues badge". It reached the first two (A4). `exportDone` built
`exportState.findings` as the model's findings plus the writer's own, and
nothing in the app ever read that field: the badge's list came from
`pipeline.result.findings`, which is the PRE-writer list.

`IssuesBadge` now subscribes to `exportState.findings` itself and folds them in
with `withExportFindings`, which is the whole change. Three properties make it
safe:

- **The live list wins.** `exportState.findings` opens with a copy of the
  model's findings as they stood when the file was written, so merging the other
  way would let a finished export's stale measurement overwrite the current
  build's row. Only ids the live list does not carry are added.
- **Only while the export is current.** A stale export describes a file that no
  longer matches what is on screen, the same reason `exportDownloadLinks`
  withdraws its links, so its rows are withdrawn with them.
- **The same array back when it adds nothing**, so the "Fixed" marks keyed on
  the joined ids are not disturbed by an export with nothing new to say.

Routing it in the badge rather than in `CityPreview` keeps the change inside one
file and gives the badge one place where its list is assembled.

## 8. Tests

| File | Tests | What it holds |
|---|---:|---|
| `components/editor/ActionBar.test.tsx` | 51 | the export plan's arithmetic, the progress model, the status line in every settled state, `stepRunOutcome` driven event by event, `failureNotice`'s routing, the three failure models, the bar's own composition, the skeleton rule, and the results panel's five fixed slots |
| `components/editor/IssuesBadge.test.tsx` | 9 | `survivingFixedIds` (section 7) and `withExportFindings` (section 7b) |
| `lib/exportFlow.test.ts` | 14 | the export state machine, the phase label, and that a failed export keeps the previous files and their Blob URLs |
| `components/editor/Controls.test.ts` | 15 | the commit gate and the request budget |
| `lib/contrast.test.ts` | 12 | the control-boundary token inventory, section 9 |

`npx vitest run components/editor lib/exportFlow.test.ts`: 6 files, 106 tests,
all passing. `npm run lint` and `npx tsc --noEmit` clean.

### The browser half

`e2e/actionbar.spec.ts` is new, five tests, one of them tagged. It exists
because none of the above can say anything about layout, a live region or a real
run: `renderToStaticMarkup` has no box, no effects and no store.

| Test | What it pins |
|---|---|
| the bar previews, exports and offers a download without ever moving `@smoke` | the idle and completed states carry no skeleton, the export writes a `.3mf` and its sidecar as `blob:` links, and the control row's box is identical across every frame of all of it |
| the progress control walks real stages | more than one real stage named, `aria-valuenow` rising and never past `aria-valuemax`, `aria-valuetext` naming the stage, and the live region speaking more than one PHASE |
| Cancel during a plate resize | the model, its triangle count and its estimate stay, dimmed and labelled rather than blanked; nothing claims a stage broke; Preview comes back |
| a refused export | the reason in the sentence, and `what`, `message`, `app: FrameCraft <version>` and a 12-hex `params` fingerprint in the copyable block |
| the format selector | switching target re-exports, the download's extension follows, and the old file is gone rather than sitting beside the new one |

**The box is recorded, not sampled.** Reading `boundingBox()` at three chosen
moments is a test of when Node happened to look. A recorder inside the page
samples the row's rectangle every animation frame, keeps the transitions, and
the assertion is `new Set(rects).size === 1` plus a check that the frames it
kept really included the states named (a run in flight, a refusal on screen, a
download offered). It waits for `document.fonts.ready` first, so a late font
swap is not reported as the bar moving.

**The tagged test's budget** is `20_000 * E2E_BUDGET_FACTOR`, which is 60 s at
`E2E_BUDGET_FACTOR=3`, measured inside the test and asserted. It runs against
the 30-building tiny-loop fixture and covers preview, export and a download,
which is what [V3.1-P14-1] asks a tagged test to be.

`@smoke` now selects **seven** titles: the six in `e2e/smoke.spec.ts` plus this
one. `playwright.config.ts` still says three in its comment and tabulates three
durations against the required job's ten-minute budget. That comment is stale in
a way that matters and is listed below.

## 9. The contrast token inventory moved with the controls

`lib/contrast.test.ts` scans the tree for files that draw a control edge and
asserts each uses `border-control` / `border-control-strong` rather than the
decorative hairline. `OutputPanel.tsx` was on that list and is deliberately
not any more: every control it drew moved into `ActionBar.tsx`, and
`ExportErrorDetail.tsx` and `ExportMenu.tsx` joined the list as new files that
draw one.

The removal is asserted, not merely dropped. Three tests were added around it:

- the results panel contains none of `preview-button`, `export-button`,
  `copy-link-button` or a `<select>`, so the actions really left rather than
  merely losing their token; its one remaining interactive edge is
  `border border-positive`, a token held to the stricter 4.5:1 text floor.
- `ProgressBar.tsx` draws NO border at all: its track is a filled well and its
  fill is `accent`, a pair already asserted at the 3:1 non-text floor. If it
  ever grows an edge, that test fails and the file has to join the inventory
  rather than reaching for the hairline.
- the inventory guard re-derives the same set from the tree, so a new
  control-bearing component cannot quietly stay unlisted, and a listed file
  that stopped drawing a control edge fails too.

Net: 7 tests and 13 assertions before, 10 tests and 20 assertions after.

## 10. Still open

Everything section A of `v3-06-interrupted-audit.md` listed is closed; the
Fixes section at the end of that file names each finding, the file and line it
was fixed at, and the test that now holds it. What is left is below, and none of
it was in this task's own files.

**No e2e reaches the printability gate's refusal.** The spec drives the
EDITOR's refusal (`exportBlockReason`, a keyhole hanger the base cannot carry),
which is deterministic. The gate's refusal, the one whose message names every
blocking finding by id, is asserted in `ActionBar.test.tsx` against a real
`ExportBlockedError` and a real `blockingFindings` call instead, because it
cannot be reached from this UI on a flat scene. Measured on the tiny-loop
fixture: `transform.predicted_top_mm` and the engine's `bounds.max[2]` agree to
the millimetre on every flat build (6.92 against 6.92, 5.05 against 5.05), so
the client always refuses first and the gate never gets asked. Terrain relief is
the only lever that separates them:

| params | engine height | predicted | `exportBlockReason` | gate |
|---|---:|---:|---|---|
| custom ceiling 20 mm, plate 256, terrain on, exaggeration 3, 40 m of relief | 20.68 mm | 8.69 mm | null | refuses, `exceeds-height` |
| stock 60 mm ceiling, plate 256, terrain on, exaggeration 3, 200 m of relief | 64.62 mm | 8.69 mm | null | refuses, `exceeds-height` |

`e2e/terrainTile.ts:terrariumPng` serves a UNIFORM tile, so `rangeM` is 0 and
terrain adds nothing to any e2e build. A ramp -- either per pixel, or a
different elevation per tile keyed off the tile x/y in the route handler -- makes
the row above reproducible in a browser. That file is `terrain.spec.ts`'s and
was not touched here. `wall-too-thin`, `not-manifold`, `floating-island` and
`exceeds-plate` were all probed on the same fixture (nozzle 0.8 and 1.2, plate
100 with tiling off, and both combined with terrain) and none of them fired at
any severity.

**The store still writes the misleading string.** `requestExport` writes
`state.pipeline.error?.message ?? "The engine could not build a model."` when
its run resolves `null`, and the bar now classifies that from the transition
rather than believing it. The tidier fix is in `store/editor.ts`: when the run
resolved `null` and `pipeline.status !== "error"`, write a cancelled outcome
instead of calling `exportFailedLocally`. That is one call site plus a reducer
in `lib/exportFlow.ts` and it would let the bar drop `stepRunOutcome`'s
`exportInFlight` half. Not done here because `store/**` belongs to another
agent this wave.

**The `playwright.config.ts` @smoke comment is stale.** It states the tag
selects exactly three titles and tabulates their durations against the required
job's ten-minute budget. It selects seven. Whoever owns CI should re-measure the
tag with `--project=chromium-smoke --list` and rewrite that block; nothing else
in the repo records what the required path now costs.

**`e2e/actionbar.spec.ts` has not been run.** Another agent held
`artifacts/build.lock` for `next build` and Playwright for the whole of this
pass, so the spec is written against the app's own test ids and the patterns
`smoke.spec.ts` and `print.spec.ts` already prove, and typechecked and linted,
but not executed. It should be run before the wave closes. The two assertions
most likely to want adjusting on a first run are the tagged test's 20 s per
budget factor and `expectBoxHeldThrough`'s exact-rectangle equality.

## 11. Where the pieces live

```
components/editor/ActionBar.tsx            the bar, the progress models, statusLine,
                                           stepRunOutcome / useRunOutcome, failureNotice,
                                           RunStatus and RunOutcomeNotice (two subscribers)
components/editor/ProgressBar.tsx          the determinate control and its live region
components/editor/ExportErrorDetail.tsx    the failure surface, its two tones, Copy details
components/editor/ExportMenu.tsx           the compact format select and its descriptions
components/editor/OutputPanel.tsx          results only, five fixed slots, export-phase
components/editor/EditorShell.tsx          mounts the bar above the panel; Escape cancels
components/editor/IssuesBadge.tsx          survivingFixedIds, withExportFindings
lib/exportFlow.ts                          the export state machine and EXPORT_FAILED_LABEL
e2e/actionbar.spec.ts                      the box, the progress control, cancel, refusal,
                                           the format select
e2e/print.spec.ts                          the "Fixed" mark recorder
```

## 12. `[V3.1-T6]`, for `DECISIONS.md`

`EstimateCard.tsx`, `StatsCard.tsx` and `ActionBar.test.tsx` cite this id and no
such line existed. The orchestrator appends the text below; nothing here edits
`DECISIONS.md`.

> - [V3.1-T6] The action bar (Task 6), five rulings.
>   1. **A skeleton may be shown only while a request is genuinely in flight AND
>      there is no previous value to show.** A first build shows one; every
>      rebuild keeps the previous figures on screen, dimmed and labelled as the
>      previous computation, because a superseded number is a better answer than
>      a grey bar; and in the idle, error and completed states there is none at
>      all. Enforced by shape rather than by name: `ActionBar.test.tsx` scans the
>      rendered markup of the estimate card, the stats card, the results panel
>      and the bar in all three settled states for a `data-testid` ending
>      `-skeleton` or the `fc-pulse` keyframe, and `e2e/actionbar.spec.ts` scans
>      the whole live page in the same three states.
>   2. **A cancelled export reads as cancelled, not as a refusal.** The store
>      cannot tell them apart -- `cancelPipeline` leaves `pipeline.error` null
>      because a cancel is not an error, so `requestExport` falls through to "The
>      engine could not build a model." for a user-pressed Cancel -- so the bar
>      classifies it from the TRANSITION instead: a run that stopped running
>      without a new result and without an error was stopped by somebody
>      (`ActionBar.tsx:stepRunOutcome`). A cancelled export gets its own surface
>      (`export-cancelled-detail`, quiet tone), names the stage it stopped at,
>      and keeps the previous export's files and Blob URLs untouched.
>      `exportStatusLabel`'s `failed` case stops echoing the store's message and
>      reads "No file written", which is true of every failed export
>      ([V3.1-P1-15]); the sentence explaining why belongs to the bar.
>   3. **The optimistic "Fixed" mark belongs to its ROW and is retired when the
>      row is** (`survivingFixedIds`). Proven end to end by a recorder in the
>      page that logs every state the fix button passes through, so the claim
>      "the mark held while the row was on screen" is asserted rather than raced
>      for; an `expect.poll(...).not.toBe(...)` over the same transient passes
>      with the defect present and is not sufficient.
>   4. **The export writer's findings reach the Issues badge**, closing the
>      third clause of [V3.1-P7-5]. `IssuesBadge` folds `exportState.findings`
>      in behind the live list, deduplicated with the live row winning (the
>      export's list opens with a copy of the model's own, so the other
>      direction would let a stale measurement overwrite a current one) and only
>      while the export is not stale.
>   5. **The control row's box is an invariant, measured.** Everything that can
>      change size renders after the controls, and `e2e/actionbar.spec.ts`
>      records `action-bar-actions`'s rectangle on every animation frame across a
>      run, a refusal and a finished export and asserts one distinct value.
>      Unreachable branches in the bar's own state (the `fetching` term on
>      Preview's disabled expression and the "Previewing..." label it fed) are
>      removed rather than left as untestable claims.
