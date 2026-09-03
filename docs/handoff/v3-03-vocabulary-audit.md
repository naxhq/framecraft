# v3.1-03 vocabulary audit (adversarial)

Audit of commit `511f3ea` "Task 3: Preview and Export replace Bake and Generate"
against its brief, ruling `[V3.1-O3]` and its handoff note
`docs/handoff/v3-03-vocabulary.md`. Everything below was read out of the
committed tree (`git show 511f3ea:<path>`, `git grep <pattern> 511f3ea`), not
the working tree, which other agents are editing. Line numbers are the
committed tree's.

Counts: 0 blocker, 2 major, 6 minor, 5 note.

---

## Major

### 1. The only user-facing string left in the retired Generate family is an aria-label

`apps/web/lib/advisor.ts:113`

```
ariaLabel: `Use a ${radius} m radius and generate again`,
```

This is the accessible name of the printability advisor's radius button, whose
visible label three lines above is `Use ${radius} m`. A sighted user reads
"Use 540 m"; a screen-reader user hears "Use a 540 m radius and generate
again", naming an action that no longer exists in the interface. The button's
handler calls `setRadius` then `generate()`, which the whole rest of the app
now presents as Preview.

The sweep missed it because the note's own grep
(`grep -nI -E '\bbake\b|\bBake\b|baking|Generate a scene'`, section 4) never
looks for lowercase `generate` outside the phrase "Generate a scene", and
because nothing asserts this string:
`git grep -niE 'generate again' 511f3ea -- apps/web` returns exactly one line,
and `a11y.spec.ts`'s advisor walk asserts the button is reachable, not what it
is called.

**Prove it:** `git grep -n 'generate again' 511f3ea -- apps/web`.

**Smallest fix:** `ariaLabel: \`Use a ${radius} m radius and preview again\``,
matching the Preview button's own "Preview again" label in
`components/editor/OutputPanel.tsx:235`.

### 2. The handoff note contradicts its own commit in two places

`docs/handoff/v3-03-vocabulary.md:12-14`

> Nothing in `packages/contracts/`, `DECISIONS.md` or the historical handoff
> notes (`docs/handoff/0*.md`, `v2-*.md`, `v3-00-*.md` .. `v3-08-*.md`) was
> touched.

The same commit rewrites `docs/handoff/v3-00-baseline.md` by 54 lines,
including measured numbers (JS transfer 933,826 to 947,671 B; the total row
1,286,751 to 1,300,596 B; the export wall column relabelled and its first two
values reordered) and the provenance paragraph. `packages/contracts/` and
`DECISIONS.md` really are untouched; the historical handoff note is not.

`docs/handoff/v3-03-vocabulary.md:189-193`

> **Files outside this task's edit list**: `CLAUDE.md`, ... `CLAUDE.md` still
> documents `make bake-fixture` ... the orchestrator owns both.

`CLAUDE.md` is edited by this commit: it gains a six-line Vocabulary rule and
its make-target list now reads `make export-fixture ... (bake-fixture is a
deprecation alias)` at `CLAUDE.md:62-63`. The note describes a state of that
file that the commit itself removed.

Consequence: the handoff note is the record a later agent reads instead of the
diff. Both false claims point away from the two documents whose changes are
least expected from a rename task, which is exactly where review attention was
needed. The commit message, unlike the note, is accurate about the baseline
work.

**Prove it:** `git show 511f3ea --stat | grep -E 'CLAUDE.md|v3-00-baseline.md'`
and `git show 511f3ea:CLAUDE.md | sed -n '48,64p'`.

**Smallest fix:** amend the two paragraphs in the note to say that
`CLAUDE.md` gained the vocabulary rule and the renamed target, and that
`v3-00-baseline.md` was corrected under the Task 0 audit rather than left
untouched.

---

## Minor

### 3. `perf.ts` now names a script that does not exist

`apps/web/lib/perf.ts:26`

```
 *  - **Node** (`build:cli`, vitest). `perfEnabled()` is false there unless a
```

The line said `bake:cli` before. The blanket bake to build substitution sent
it to the Build family, but this reference is to the npm script, which went to
the Export family: the scripts are `export:cli` and its alias `bake:cli`
(`apps/web/package.json:15-16`). There is no `build:cli` anywhere in the tree.

**Prove it:** `git grep -n 'build:cli' 511f3ea` returns this one line;
`git grep -n '"export:cli"' 511f3ea -- apps/web/package.json` returns the real
name.

**Smallest fix:** `build:cli` to `export:cli` in that comment.

### 4. The Task 0 baseline still labels its rows with the retired span name

`docs/handoff/v3-00-baseline.md:181`, `:223`, `:238`

The commit renames the perf span `engine.bake` to `engine.build`
(`apps/web/lib/engine/engine.ts:549`, asserted at `apps/web/e2e/perf.spec.ts:87`
and `:92`), and it edits `v3-00-baseline.md` in the same commit, but leaves
three rows in that document keyed on `engine.bake`, including the prose "The
wall times are dominated by a full engine re-bake (`engine.bake` 11,749 ms".
The v3.1 performance work compares new HUD readings against this table; the
row names no longer match what `?perf=1` emits.

**Prove it:** `git grep -n 'engine\.bake' 511f3ea -- docs apps/web` lists the
three baseline rows plus the note's own mapping table, and no code hit.

**Smallest fix:** rename the three labels to `engine.build` in
`v3-00-baseline.md`, with a parenthetical that the deployed Part B numbers
predate the rename.

### 5. The released 3.0.0 and 1.0.0 changelog entries were rewritten

`CHANGELOG.md:36`, `:65`, `:86`

- 3.0.0 Added: "Client-side bake engine" is now "Client-side build engine".
- 3.0.0 Changed: "The Python bake service became the reference implementation"
  is now "The Python service became the reference implementation".
- 1.0.0: "server-side manifold3d bake" is now "server-side manifold3d build".

A Keep a Changelog file records what each version shipped. At the 3.0.0 tag the
engine entry point is `bake()`, the flow module is `lib/bake.ts` and the make
target is `make bake-fixture`; the entry now describes that release with names
that did not exist in it. Consequence is bounded: a reader tracing a symbol
back to the release it shipped in gets a name that never appears in that tree.
The Unreleased entry at `CHANGELOG.md:7-28` already documents the rename in
full, so editing the released entries adds nothing that was missing.

**Prove it:** `git show 511f3ea -- CHANGELOG.md` shows the three edits below
the `## [3.0.0]` and `## [1.0.0]` headings.

**Smallest fix:** restore the three released lines verbatim and leave the
Unreleased entry as the record of the rename.

### 6. Two user-visible strings still speak of "the scene"

`apps/web/components/editor/OutputPanel.tsx:232` (the Preview button's disabled
title): "The scene already matches this location."
`apps/web/components/editor/groups/LocationGroup.tsx:105` (the radius hint):
"Half the ground span. Changing it refetches the scene."

`exportBlockReason` was correctly moved off this noun in the same commit
("Generate a scene first." became "Preview a location first.",
`apps/web/lib/warnings.ts:359`), and the empty state now says "The model
arrives in a few seconds" (`components/scene/CityPreview.tsx:982`). "Scene"
survives in exactly the two places a user reads when something is disabled or
about to refetch, which is where a third noun costs the most.

**Prove it:** `git grep -nE 'matches this location|refetches the scene' 511f3ea -- apps/web/components`.

**Smallest fix:** "The model already matches this location." and "Changing it
refetches from OpenStreetMap."

### 7. The shipped definition of Preview is wider than the button

`CLAUDE.md:48-50` and `CHANGELOG.md:11-13` now define Preview as building or
rebuilding the model "from the current location and settings". The button calls
`generate()` (`components/editor/OutputPanel.tsx:230`), which is the Overpass
ingest for the location, and it is `disabled` whenever
`sceneIsCurrent = sceneStatus === "ready" && !stale`
(`OutputPanel.tsx:113`, `:231`). A settings-only change leaves the button
disabled: the rebuild happens on the debounced engine job, not on Preview.
`SHORTCUTS`'s own description is narrower and correct, "Preview this location"
(`apps/web/lib/keyboard.ts:39`).

The behaviour is fine for the user, because the debounce does rebuild. The
defect is that the definition now sitting in `CLAUDE.md`, the file every later
agent reads as a hard rule, promises a button behaviour the code does not have,
and the next task in the wave is the action bar.

**Prove it:** `git show 511f3ea:apps/web/components/editor/OutputPanel.tsx | sed -n '107,116p;226,236p'`
against `git show 511f3ea:CLAUDE.md | sed -n '48,50p'`.

**Smallest fix:** in `CLAUDE.md` and the Unreleased entry, say Preview
"fetches the location and builds the model from it; settings changes rebuild on
their own", or widen `generate()`'s enabled condition in the action-bar task
and keep the sentence.

### 8. A rename commit carries the Task 0 measurement corrections

`docs/handoff/v3-00-baseline-audit.md` (new, 524 lines) and the 54 changed
lines of `docs/handoff/v3-00-baseline.md` are Task 0 audit output, not
vocabulary. The commit message discloses this, so it is not hidden, but
`git revert 511f3ea` to back out the rename would also silently restore the
superseded baseline numbers. 163 files in one commit also makes the rename
itself hard to review as a unit.

**Prove it:** `git show 511f3ea --stat | grep v3-00`.

**Smallest fix:** none retroactive. Land the remaining Task 0 code findings as
their own commit.

---

## Note

### 9. Article left ungrammatical by the mechanical rename

`apps/web/lib/exportFlow.ts:69`: "Revoke every Blob URL a `ExportState` is
holding" (was "a `BakeState`"). One occurrence; the sweep for `a Export|a
export` finds no other.

### 10. Build-family jargon reached user-visible copy

The user's two words are Preview and Export, but three visible strings now name
a third thing, "the build":

- `components/editor/EstimateCard.tsx:78` "from the previous build"
- `components/scene/CityPreview.tsx:947` "Over the N mm printer height ceiling.
  The build will refuse this."
- `components/scene/CityPreview.tsx` HUD "Preview is approximate: the build
  merges buildings closer than ..."

Each replaced "the bake", so no ground was lost, and the note argues each
labels the engine result rather than a file. It is still an internal family
name on screen. "The model" reads correctly in all three.

### 11. The Generate family survives in code, by design, but not silently

`store/editor.ts:generate()`, the `Shortcut` action `"generate"`
(`apps/web/lib/keyboard.ts:26`), and the Playwright helpers `generateChicago`
and `generateTinyLoop` (six specs) keep the retired word. The note explains the
deferral at its section 1.2 and `docs/ARCHITECTURE.md:227` documents it as
"`generate()` (the Preview action)", so this is a disclosed deferral rather
than a miss. Flagged only because the brief asked for Playwright helper names
specifically, and because the CHANGELOG's "the word bake is retired from ...
the TypeScript in `apps/web`" is true while the parallel claim about Generate
is not made anywhere, which is the right call and worth keeping that way.

### 12. A frozen gate now depends on the deprecation alias

`05_AGENT_TEAM.md:117` defines gate G3 as
`make bake-fixture && make validate artifacts/chicago.3mf`. That file is frozen
and outside the task's edit list, so G3 runs only through the alias. Retiring
the alias later silently deletes a frozen gate. Worth a `DECISIONS.md` line
before the alias is ever removed.

### 13. Pre-existing stale route comments in files this commit swept

`apps/web/lib/tokens.ts:29`, `:293`, `apps/web/lib/resolvedOutput.ts:17`,
`apps/web/lib/heroes.test.ts:6` still describe `POST /bake` as the live path,
and `apps/web/components/editor/Controls.tsx:19` still says the sliders commit
to "a POST /scene that is a live Overpass query". No such route has been called
since v3. These predate the commit and are justified under `[V3.1-O3]` as route
names, but the sentences around them assert a runtime that does not exist, and
this commit edited most of these files.

---

## Verified clean

Checks that found nothing, recorded so they are not repeated:

- **No residual identifier.**
  `git grep -nE '\b(bake[A-Za-z0-9_]*|[a-zA-Z0-9]+Bake[A-Za-z0-9]*)\b' 511f3ea -- apps/web ':!apps/web/lib/contracts.ts'`
  filtered of `services/bake` paths, `POST /bake`, the `BakeResult`/`BakeFiles`/
  `BakeStats`/`bake_result` contract names and `bake:cli` returns three hits,
  all of them `path.join(REPO_ROOT, "services", "bake")`. No half-renamed pair:
  nothing named `bake*` calls `buildModel()`.
- **No persisted state was dropped.** The eight storage keys
  (`framecraft.geocode.v1`, `framecraft.geocode.search.v1`, `framecraft-groups`,
  `framecraft.palettes.v1`, `framecraft.perf`, `framecraft.recent.v1`,
  `framecraft-theme`, `framecraft.author.v1`) are unchanged by the commit and
  none contained the retired words. The renamed store field `state.bake` to
  `state.exportState` is excluded from undo history
  (`store/history.ts:17`) and appears in neither `lib/project.ts` nor
  `lib/share.ts`, so no project file or permalink carries it. No migration is
  needed.
- **The frozen surfaces are untouched.** `git show 511f3ea --stat` contains no
  file under `services/`, `packages/` or `fixtures/`. `DECISIONS.md` is not in
  the commit.
- **`make bake-fixture` forwards and propagates.** Against the committed
  Makefile extracted to a temp file: `make -n bake-fixture COLOR=parts` expands
  to `make export-fixture COLOR="parts" TEXT="" PLATE=""`; `COLOR=bogus`,
  `TEXT=bogus` and `PLATE=999` each print the notice and exit 2, the child's
  own status.
- **`npm run bake:cli -- <args>` forwards on both shells.** With a probe
  package replicating the two-line alias, the inner script receives identical
  argv from the alias and from `export:cli` directly, in Git Bash and in
  PowerShell, including `--params '{"color_mode":"parts"}'`; a failing child's
  exit code 7 comes back through the alias unchanged.
- **`gate-v2` calls the right target.** Its shell helper is renamed `bake()` to
  `fixture()` and invokes `$(MAKE) export-fixture` at Makefile:335-338; gate
  step 4 calls `scripts/gate-web-engine.sh`, which calls
  `npm run export:cli`, and its renamed status variable `clirc` has no
  leftover `bakerc` reference.
- **The CI job rename is safe.** Nothing in `.github/workflows/ci.yml` has a
  `needs:` on the old `bake-service`, and `gh api` reports the repository has
  neither branch protection nor rulesets on `main`, so no required status check
  is keyed on the old job name.
- **No assertion was weakened.** Every changed `expect` in `apps/web/e2e`,
  `lib`, `store` and `components` kept its matcher and its strictness. The one
  visible-text assertion became stricter-equivalent, `/^Generate$/` to
  `/^Preview$/` (`e2e/smoke.spec.ts`), not a switch to a test id; the empty
  viewport still asserts copy ("Preview", "G preview") rather than a testid.
  No test moved from a string assertion to a `data-testid` assertion.
- **No slicing or G-code claim.** `README.md:17` "press Preview, then Export.
  Download the model file your slicer wants" and `README.md:33` "so it opens
  ready to slice" are the strongest claims made. The sidecar provenance is
  `generator: "FrameCraft web engine"`
  (`apps/web/lib/engine/export/common.ts:385`, changed from "FrameCraft web
  bake"), `GENERATOR_NAME` is `"FrameCraft"`, `CREDITS_TEXT`
  (`lib/engine/export/stl.ts:99`) and the 3MF metadata carry no "bake". The
  colour-change target's "Approximate: one nozzle, colour changes at the height
  bands the geometry allows" is accurate and untouched; that exporter really
  does write `custom_gcode_per_layer.xml`.
- **Two actions, not three.** The action row is Preview, Export and a `<select>`
  labelled "Export format" (`components/editor/ExportMenu.tsx:57-66`); the
  project Save/Load and Copy-link sit in a separate, quieter row. The shortcut
  sheet renders key plus description only (`ShortcutSheet.tsx:90-102`) and its
  two entries, "Preview this location" and "Export the printable model file",
  match the two buttons. One wrinkle, pre-existing and out of scope per the
  brief: changing the format select immediately re-exports, so the picker is
  an action as well as a selector.

---

## Verdict

The rename itself is done properly. The identifier sweep is complete to the
letter, with a Build family for the engine and an Export family for the flow
and no half-renamed pair anywhere in `apps/web`; the frozen surfaces named by
`[V3.1-O3]` are provably untouched; both deprecation aliases work, forward
every override and return the child's exit status on Windows and POSIX; no
persisted key changed, so no user loses saved state; no assertion was weakened
or converted from a visible string to a test id; and the accuracy pass over the
Export copy holds, with the Bambu project claimed as "opens ready to slice" and
nothing stronger. The two aliases, the CI job rename and the gate wiring were
each exercised rather than reasoned about, and all four pass.

What is wrong is at the edges the sweep's own grep could not see and in the
paper trail. One user-facing string, the advisor's aria-label at
`apps/web/lib/advisor.ts:113`, still says "generate again", audible only to a
screen-reader user and covered by no test; that is the single defect a user can
still hit and should be fixed before the action-bar task builds on this
vocabulary. The handoff note then misdescribes its own diff twice, claiming the
historical handoff notes and `CLAUDE.md` were left alone when both were edited,
which is the more expensive fault because the note, not the diff, is what the
next agent reads. Behind those sit a comment naming a `build:cli` script that
does not exist, a baseline table still keyed on the retired `engine.bake` span,
a rewrite of the released 3.0.0 and 1.0.0 changelog entries that buys nothing
the Unreleased entry does not already say, and a definition of Preview now
frozen into `CLAUDE.md` that is wider than the button it describes. None of
these blocks the wave. All six are small, local edits, and the two major ones
should land before the note is treated as the record of this task.
