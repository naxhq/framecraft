# Audit: commit `3e5883c`, "Task 0: permanent ?perf=1 mode and the measured v3.1 baseline"

Adversarial review by an agent that did not write the code. Read-only: nothing
in `apps/`, `services/` or `packages/` was modified. All line references are to
the commit (`git show 3e5883c:<path>`), not to the working tree.

## What was verified by running it, not by reading it

Two git worktrees were created under the session scratchpad at `3e5883c` and at
its parent `7eda2d7`, with `node_modules` junctioned from the main tree (the
commit touches no manifest, so the same install is valid for both). Five
interleaved `npm run bake:cli` runs per commit, Chicago fixture, default
parameters, STL target:

| tree | runs (ms) | median | min | max |
|---|---|---:|---:|---:|
| `7eda2d7` (before) | 8075, 8163, 8408, 8111, 8189 | 8163 | 8075 | 8408 |
| `3e5883c` (after) | 8082, 8019, 8231, 8036, 8255 | 8082 | 8019 | 8255 |

The instrumented tree is 81 ms faster at the median, which is noise. **Finding 1
of the brief, "zero cost when off", holds.** The worktrees were removed
afterwards; `git worktree list` shows only the main tree.

A second probe forced perf mode on inside Node by installing a `localStorage`
stub before the first import, then baked the same fixture and dumped the report.
It recorded **36 spans total** for a 992-building bake, which settles the other
half of question 1: there is no per-triangle and no per-region instrumentation.
That probe is the evidence behind finding 2 below.

---

## Findings

### 1. Blocker. The baseline note contradicts itself about what was measured, and its opening provenance claim is false for half the document.

`docs/handoff/v3-00-baseline.md:846` states, in the table "What could not be
measured, and why":

> WASM instantiate time | The app sets no `performance.mark`, and
> `WebAssembly.instantiate` is not covered by any Performance API entry type.
> Only the fetch (7.4 to 55.0 ms) is observable.

The same file reports `wasm.instantiate` as a measured three-run median twice,
at `:70` (9.3 / 9.3 / 11.6 ms) and at `:172` (12.3 / 10.0 / 12.4 ms), from the
instrumentation this very commit adds.

`:333` compounds it:

> Companion note: `docs/handoff/v3-00-baseline.md` (local dev, owned by another
> agent). This one covers only the deployed site, the desktop build and CI.

That sentence is inside `docs/handoff/v3-00-baseline.md`, naming itself as a
separate document. Two agents' notes were concatenated without reconciliation.
The seam is at `:324`.

`:3` then claims of the whole file:

> Every number here was read out of the browser's own Performance API through
> the permanent `?perf=1` mode (`apps/web/lib/perf.ts`). Nothing is estimated.

False for every number after `:324`, which was measured against deployed commit
`7eda2d7` (`:342`), a build that predates perf mode and therefore cannot have
produced a single `?perf=1` row. Also false for section b (`zlib.gzipSync` /
`brotliCompressSync` over `apps/web/out`), for 1.5 (`curl -sI`), for 1.3 and 1.4
(Chrome DevTools Protocol network events), and for section 3 (GitHub run
timestamps). Section 4 at `:326` restates the provenance correctly, which makes
`:3` an unretracted overclaim rather than an oversight.

**How to prove it.** Read `:3`, `:70`, `:172`, `:333` and `:846` side by side.
Then `git show 7eda2d7:apps/web/lib/perf.ts` returns "does not exist in
7eda2d7", which is the deployed commit named at `:342`.

**Smallest correct fix.** Retitle at `:324` to "Part B, measured on deployed
`7eda2d7` (no perf mode)", delete the self-referential companion line at `:333`,
narrow `:3` to "Sections a, c and d come from `?perf=1`; sections b, 1 to 3 come
from Resource Timing, CDP, `zlib` and GitHub run metadata", and replace the
row at `:846` with the measured `wasm.instantiate` figure plus the caveat that
it was unavailable on the deployed build.

---

### 2. Major. Nested spans are printed as a flat table that invites summing, and the sum exceeds the whole.

`engine.ts:172` wraps `buildSurfaceRegions` as `solid.surfaces`. Inside it,
`areas.ts:453` wraps each layer as `` `solid.${region}` ``. The four layer rows
are strictly contained in the parent row, but `foldRows` (`perf.ts:523-547`)
emits all five as siblings and `perfText` (`perf.ts:646-684`), the console table
(`perf.ts:710-719`) and the HUD table (`PerfHud.tsx:135-156`) render them with
no indentation, no parent column and no total.

Measured on the Chicago fixture with perf forced on:

| quantity | ms |
|---|---:|
| `engine.bake` | 7243.9 |
| sum of every other row | 7850.8 |
| excess | 606.9 |
| `solid.water` + `solid.rail` + `solid.roads` + `solid.parks` | 657.6 |

The excess is the nested layers. The same shape appears three more times:
`solid.drape.assembly` (`engine.ts:403`) sits inside `solid.weld`
(`engine.ts:399`); `wasm.fetch` (`manifold.ts:124`) sits inside
`wasm.instantiate` (`manifold.ts:106`); `export.<target>`
(`export/index.ts:74`) and `export.sidecar` (`bake.ts:145`) sit inside
`export.run` (`bake.ts:132`).

The note gets this right in exactly one place, the prose at `:204` ("`solid.surfaces`
0.9 s of which `solid.roads` is 0.6 s"), and nowhere else. Nothing in the tool
itself carries the information, so the next phase reading only the HUD will
double count.

**How to prove it.** Run the probe described above, or in the browser sum the ms
column of the HUD and compare it to the `engine.bake` row.

**Smallest correct fix.** Add `parent?: string` to `PerfTiming`, set it from a
module-level span stack in `perfSpan`, and have `foldRows` mark a row whose
parent is present. One extra character in the HUD name cell and one tab column
in `perfText` is enough.

---

### 3. Major. `export.<target>` recurses into itself, so a tiled export reports roughly twice its real cost.

`export/index.ts:69-75` wraps `writeForTarget` in a span named
`` `export.${target}` ``. `export/index.ts:97`, inside `writeForTarget`, calls
`exportForTarget` again once per tile:

```
writeTile: (tileResult, tileOptions) =>
  exportForTarget(tileResult, target, { ...options, ...tileOptions, profile }).files,
```

For a tiled non-Bambu export the folded row therefore holds one outer span that
contains N inner spans of the same name. `totalMs` is outer plus the sum of the
inner spans, which is about twice the real elapsed time. The comment at
`:70-73` claims "the row's count is the number of files this export actually
wrote"; the count is actually tiles plus one, and for a non-tiled `obj` export
the count is 1 while the target writes two files.

**How to prove it.** Bake with tiling on, export STL, and compare the
`export.<target>` row against the `export.run` row that encloses it. The child
will read larger than its parent.

**Smallest correct fix.** Have the tiled branch call `writeForTarget` rather
than `exportForTarget`, and correct the comment.

---

### 4. Major. `wasm.instantiate` does not measure instantiation.

`manifold.ts:106` is `perfSpan("wasm.instantiate", () => modulePromiseSource)`,
where `modulePromiseSource` is the emscripten factory promise created at
`:95-100`. The span therefore covers locate, fetch, compile and instantiate as
one number. The docstring at `:101-105` says so honestly, but the row name does
not, and `recordWasmFetch` (`:118-132`) then re-reports the fetch portion as a
sibling row read out of Resource Timing. A reader of the table sees a 3.8 ms
fetch and a 9.3 ms instantiate and will add them.

This is the direct cause of half of finding 1: the note's section 5 denies that
instantiation was measurable, because on the deployed build it was not, and
nobody noticed that section a now reports it.

**How to prove it.** Compare `manifold.ts:106` against the row label at
`docs/handoff/v3-00-baseline.md:70`.

**Smallest correct fix.** Rename the span to `wasm.load` and state in the note
that `wasm.fetch` is a subset of it.

---

### 5. Major. `preview.geometry` is labelled as a GPU upload and is not one.

`RegionMeshes.tsx:46-53` wraps the `useMemo` factory that calls `buildGeometry`
for every region. `buildGeometry` (`RegionMeshes.tsx:33-40`) allocates a
`BufferGeometry`, copies float64 positions into a `Float32Array`, sets the
index, and calls `computeVertexNormals` and `computeBoundingSphere`. Every one
of those is CPU-side. Three.js uploads a buffer to the GPU lazily, on the first
render that binds it, which is after this span has closed.

The note nonetheless calls the row "float64 to float32, normals, upload"
(`:200`), derives "preset click to engine meshes uploaded" from it (`:79`), and
heads the section "Preset click to the engine meshes on screen" (`:164`). The
time between the mark and the first pixel is not measured anywhere;
`preview.firstFrame` (`CityPreview.tsx:1025`) fires on the first frame of the
whole canvas, which happens about 12 s earlier per the note's own `:78`.

**How to prove it.** Read `buildGeometry`. No `WebGLRenderer`, no
`gl.bufferData`, no `geometry.attributes.position.needsUpdate` round trip.

**Smallest correct fix.** Relabel the row "geometry build (CPU)" in the note and
drop the words "uploaded" and "on screen" from `:79` and `:164`, or add a second
`useFrame` mark that fires on the first frame after a new `regions` identity.

---

### 6. Minor. A cross-realm clock failure is silently reported as a 0 ms transfer.

`client.ts:315-320` computes the worker-to-page hop as
`receivedEpochMs - posted.epochMs`, subtracting a worker `performance.timeOrigin`
from the page's. That is legitimate in Chromium, where both are Unix-epoch
milliseconds off the same monotonic base, but `Math.max(0, ...)` at `:319`
converts any negative result into a plausible-looking `0.0` row rather than an
absent or flagged one. `e2e/perf.spec.ts:111-112` only asserts the row is
defined, never that it is positive, so a broken clock domain passes the gate.

**How to prove it.** Patch `posted.epochMs` upward in a debugger and watch the
row read 0.0 while the spec still passes.

**Smallest correct fix.** Drop the row entirely when the delta is negative, and
tighten the spec to `toBeGreaterThan(0)` like the other four rows.

---

### 7. Minor. The wire is not byte-identical with perf off, contrary to the docstring that says it is.

`worker.ts:39` claims "With perf off, both branches below are one boolean read
and the wire is byte-identical to what it was before." `client.ts:233` and
`client.ts:250` send `perf: perfEnabled()`, so every ingest and bake message now
carries an explicit `perf: false` property that did not exist before.

**Smallest correct fix.** `...(perfEnabled() ? { perf: true } : {})` at both call
sites, or correct the comment.

---

### 8. Minor. Per-frame work was added to the render loop regardless of the flag.

`CityPreview.tsx:634` mounts `PerfFirstFrame` unconditionally.
`CityPreview.tsx:1020-1027` registers a `useFrame` callback. The `Canvas` at
`:608` sets no `frameloop`, so it defaults to `always`: the callback is invoked
roughly sixty times a second for the life of the page, with perf mode off
included, and it never unsubscribes after recording its one mark. The cost per
call is a ref read and a return, so this is small, but it is exactly the class
of unconditional hot-path work the brief asks about and it is avoidable.

**Smallest correct fix.** Render `PerfFirstFrame` only when `perfEnabled()`, and
have the callback return the r3f unsubscribe after the first frame.

---

### 9. Minor. Rows accumulate across jobs, and only a manual button separates one run from the next.

`perfFlush` (`perf.ts:702-739`) builds a report and never clears the buffer.
`store/editor.ts:486`, `:1002` and `:1069` call it after every engine job,
ingest and export. A second bake in the same session folds into the first row,
doubling `count` and `totalMs`. The note's own re-measure instructions
(`docs/handoff/v3-00-baseline.md:290`) say "**Clear** resets the counters, which
is how each of the three runs is isolated", which is correct and is the only
thing standing between the published tables and doubled numbers. Nothing in the
code enforces it, and the scripted driver described at `:305-311` relies on the
operator remembering to call `reset()`.

**Smallest correct fix.** Give `perfFlush` an optional `{ reset: true }` and use
it from the export and engine-job call sites, or have the HUD show elapsed since
the last clear so a stale accumulation is visible.

---

### 10. Minor. Two byte totals in the note exclude a row that the table above them includes.

`:59` says "The warm navigation transfers **exactly the same 3,616,857 bytes** as
the cold one." The kind table at `:50-57` sums to 3,655,209 B. The difference is
38,352 B, exactly the HTML row at `:52`. The stated total is resource-only while
the table it follows counts the document.

Same class at `:620`: "the warm navigation re-transfers the full 3 561 196 B"
against a cold total of 3,562,072 B in the table at `:608-615`. The 876 B gap is
exactly the Image row.

**Smallest correct fix.** Say "3,616,857 B of subresources, excluding the 38,352 B
document" and "3,561,196 B of the 3,562,072 B, the favicon excepted".

---

### 11. Minor. The "deferred today" list contradicts the eager/deferred column three rows above it.

`:127` says "Deferred today: `manifold/manifold.wasm` and one 80,417 B chunk,
both on the first bake." `:116` marks a 189,765 B `chunks/framework…js` as "no,
not requested by `/`". Section b also accounts 17 of 31 `.js` files as eager
(`:123`) and one as deferred, leaving 13 files and about 626 kB unclassified in
either direction.

**Smallest correct fix.** Change `:127` to "Not requested by `/`:
`manifold.wasm`, one 80,417 B chunk on the first bake, and 13 further `.js`
files totalling 626,350 B that nothing on this route pulls at all."

---

### 12. Minor. One table uses two different orderings in adjacent columns.

The export table header at `:226` labels its second column "wall (min / med /
max)". The row at `:228` reads `13,044 / 13,418 / 24,761 ms` for wall, which is
min/med/max, and `1,033 / 1,009 / 1,096 ms` for `export.run`, which is only
coherent as the file-wide median/min/max convention set at `:5`. Two conventions
in one row.

**Smallest correct fix.** Reorder the wall column to median/min/max and delete
the header's parenthetical.

---

### 13. Minor. The cold-load JS total understates itself by 13,845 B against its own stated method.

`:418` says the byte tables are a "Union of page Resource Timing and CDP network
events, so cross-origin tiles ... are counted from the wire." `:458` lists the
engine worker chunk as `0 (13 845 on the wire)` and carries 0 into the sum, so
the 933,826 B JS figure at `:425` and `:794` is 13,845 B low even though the real
number is printed one column away. The rest of that table is exact: the 19 chunk
rows sum to 933,826 B to the byte, and the five kind rows sum to 1,286,751 B to
the byte.

**Smallest correct fix.** Count the worker chunk at 13,845 B and restate both
totals, or add a footnote saying the JS row is Resource Timing only.

---

### 14. Minor. Perf mode has no Node or CLI entry point, so the reference bake cannot be profiled.

`detect()` (`perf.ts:200-216`) reads only `location.search` and `localStorage`.
Neither exists in `vite-node`, and `setPerfEnabled` is exported but called from
nowhere except `worker.ts:59` and `:63`. `scripts/bake-cli.ts` has no flag and
reads no environment variable, so `npm run bake:cli` can never record a span.
The brief's own request to compare `bake:cli` with and without perf is not
satisfiable without patching the tree, which is what this audit had to do.

**Smallest correct fix.** Add `if (process.env.FRAMECRAFT_PERF === "1")` to
`detect()`, which costs one guarded `globalThis.process` read and makes the whole
solid pipeline profilable from the command line.

---

### 15. Minor. The commit carries four unrelated files, and its `DECISIONS.md` entries do not record the decision it makes.

`.claude/agents/geo-ingest.md`, `qa-gate.md`, `scaffolder.md` and
`web-editor.md` each change `model: sonnet` to `model: opus`. That is a team
configuration change with nothing to do with Task 0.

`DECISIONS.md` gains ten lines, `[V3.1-O1]` through `[V3.1-O6]` and `[V3.1-P1-1]`
through `[V3.1-P1-4]`. They cover naming, authorship, vocabulary, contract
sequencing, escalation, layout state and the Task 1 pipeline design. None of
them records what this commit actually decides: a permanent instrumentation
layer inside the solid hot path, and two new optional fields (`perf` on the job
messages, `timings` on the terminal responses) on the engine worker protocol.
`packages/contracts/` is untouched, so no frozen-schema rule is broken, but the
protocol is the boundary two realms agree on and the log is where that belongs.

**Smallest correct fix.** Split the agent-model change into its own commit and
append one `[V3.1-P0-1]` line describing perf mode, the two protocol fields and
the off-is-free guarantee.

---

### 16. Note. One type was loosened, and it is the documented one.

`perf.ts:367` is `as unknown as T`, a double cast, so that one function covers
both the synchronous and the promise-returning shape. It is commented at
`:355-357` and there is no better option without splitting the API in two. A
side effect worth knowing: a non-Promise thenable passed through `perfSpan`
comes back as a native Promise, not the original object. Nothing in the
codebase relies on that identity. No `any`, no `@ts-ignore`, no
`eslint-disable` anywhere in the commit.

---

### 17. Note. `longTasks.observed` can be a confident false zero.

`startLongTaskObserver` (`perf.ts:429-447`) sets `longTaskSupported = true`
whenever `observer.observe` does not throw. Firefox does not throw on an
unsupported `type`; it warns and delivers nothing. The report would then say
`observed: true, count: 0`, which the HUD renders as "long tasks 0" and
`perfText` renders as a measured zero. The docstring at `:443-445` says the
intent is the opposite.

**Smallest correct fix.** Gate on
`PerformanceObserver.supportedEntryTypes?.includes("longtask")`.

---

### 18. Note. `navigation` reads event fields that are zero before the events fire.

`navigationTiming` (`perf.ts:505-514`) returns `entry.domContentLoadedEventEnd`
and `entry.loadEventEnd` unchecked. Both are 0 until their event fires. A report
built from `PerfHud`'s mount effect can therefore print "load 0.0 ms"
(`PerfHud.tsx:118`), which reads as instant rather than as not-yet.

**Smallest correct fix.** Return `null` for a field that is still 0 and render
`n/a`, the same treatment paint timing already gets at `:494-503`.

---

### 19. Note. Two things are installed for the life of the page and never removed.

`perfInstall` (`perf.ts:763-775`) starts a `PerformanceObserver` and publishes
`window.__framecraftPerf`. Neither is ever disconnected or deleted, and
`PerfHud`'s effect returns only the `perfSubscribe` unsubscribe
(`PerfHud.tsx:47`). This is deliberate for a diagnostic mode and costs nothing
when perf is off, but note that `perfReset` (`perf.ts:406-411`) zeroes the
long-task counters while the observer keeps feeding them, so Clear does not give
a clean long-task window the way it gives a clean span window.

---

### 20. Note. The browser's own User Timing buffer grows without bound.

`perfMark` calls `performance.mark` (`perf.ts:283-288`) and `finish` calls
`performance.measure` (`perf.ts:319-323`). `MAX_TIMINGS` (`perf.ts:163`) caps
this module's own array at 4000, but nothing calls `clearMarks` or
`clearMeasures`. A long profiling session accumulates entries the module never
reads back. Harmless in practice, and the `try`/`catch` handles a full buffer.

---

### 21. Note. The unit tests are good, with two gaps.

`lib/perf.test.ts` tests behaviour, not implementation. The "off is really off"
block at `:123-167` asserts the observable form (recorded nothing, flushed
nothing, no subscriber call) rather than restating guards, the caching test at
`:103-110` proves the hot-path claim through a call count, and the rebase test
at `:298-316` is the only place the cross-realm clock contract is pinned. All of
them would fail if a guard were removed.

The gaps: `perfInstall` is never called by any test, so
`startLongTaskObserver` and the `window.__framecraftPerf` publication have no
unit coverage at all (only the e2e negative case at `e2e/perf.spec.ts:58-61`).
And `perfResetDetectionForTest` (`perf.ts:414`) and
`perfResetInstallForTest` (`perf.ts:778`) are test-only exports living in
shipped code.

---

### 22. Note. The e2e spec is a real guard, and it lengthens the job the note calls the sole CI bottleneck.

`e2e/perf.spec.ts` asserts positive milliseconds for `overpass.fetch`,
`osm.normalize` and `engine.bake` (`:92-99`), a positive sum across the solid
rows (`:105-108`), and positive milliseconds for `export.run` and
`export.bambu-3mf` (`:133-139`). It also pins scope to `worker` for the three
worker rows (`:98`), which is what would catch a silent fall-back to the inline
transport. **Instrumentation that recorded zero would fail this spec**, which
answers question 5 of the brief in the affirmative.

Two softer spots. `expect(row.ms).toBeGreaterThanOrEqual(0)` at `:104` is
vacuous on its own and only earns its place because of the sum assertion two
lines later. The `export.bytes` assertion at `:141-144` matches `/[kM]?B/`
against the row text, which a genuine `0 B` payload would satisfy.

`playwright.config.ts:77` sets `testDir: "./e2e"` with no `testMatch`, and CI
runs `npm run test:e2e`, so this spec is in the gate. It adds a full preview,
bake and export cycle to the `e2e` job that section 4 of the note identifies as
the entire CI wall-clock, currently 18m 58s to 31m 49s for the suite step. That
is the right trade, but it should be a knowing one.

---

### 23. Note. Copying a share link drops `?perf=1` from the address bar.

`components/editor/OutputPanel.tsx:159` calls
`window.history.replaceState(null, "", link)` with the encoded share link,
replacing the whole URL. Perf mode survives for the session because `detect()`
caches into `detected` (`perf.ts:225-229`) before that can happen, but a reload
after copying a link silently loses the mode. The `localStorage` flag documented
at `:295` for the desktop shell is immune and is the better instruction for the
web too.

---

### 24. Note. The HUD is clean; the docstring understates what ships.

`PerfHud.tsx` renders `null` until an effect confirms `perfEnabled()`
(`:39-48`, `:73`), which is correct for a statically exported page. It lives
outside the r3f tree (`PreviewPane.tsx:29-31`), so `setReport` on every flush
re-renders the panel and never the scene. Both buttons are real `<button>`
elements with text labels, so they are keyboard reachable and have accessible
names, and the toggle carries `aria-expanded` (`:105`). Every token used
resolves in `app/globals.css`: `--radius-panel:275`, `--radius-milled:273`,
`--color-control:228`, `--color-line-strong:227`, `--text-2xs:255`. No warning
or issue text appears in the panel, so the "warnings only through the Issues
badge" rule is respected.

Two small things. The panel has no `role` or accessible name of its own, so a
screen reader meets an unlabelled region, and the Copy button's "Copied" state
changes text without an `aria-live` region to announce it. And the docstring at
`:23-24` says the shipped app carries "a few hundred bytes of dead branch": in
fact `lib/perf.ts` is imported by `engine.ts`, `client.ts`, `protocol.ts`,
`worker.ts`, `bake.ts`, `export/index.ts`, `areas.ts`, `manifold.ts`,
`scene.ts`, `store/editor.ts`, `RegionMeshes.tsx` and `CityPreview.tsx`, so the
whole module ships to every user. The note measures that honestly at `:26-29`
(4 kB page JS, 5 kB First Load JS); only the docstring understates it.

---

## Counts

| severity | count |
|---|---:|
| blocker | 1 |
| major | 4 |
| minor | 10 |
| note | 9 |

---

## Verdict

The instrumentation itself is good work and the central claim survives an
adversarial test: five interleaved fixture bakes per commit put the perf-off
cost at 81 ms *below* the uninstrumented parent, and a forced-on probe records
36 spans for a 992-building bake, so nothing per-triangle or per-region was
added to the hot path. The guards are consistent, the transport change is
genuinely additive and optional, the unit tests assert behaviour rather than
restating the implementation, the e2e spec would fail on silently-zero
instrumentation, the HUD stays out of the render tree and out of the Issues
channel, and there is not one lint suppression, `any`, or stray `console.log` in
the commit. Where the work falls down is in the arithmetic the next phase will
build on. Four span pairs nest without saying so, and the measured consequence
is a table whose rows sum to 607 ms more than the bake they describe; one span
recurses into itself and roughly doubles a tiled export; `wasm.instantiate` and
`preview.geometry` are both named for something other than what they measure.
Worse, the baseline note is two documents stapled together and never
reconciled, to the point of citing itself as a companion and stating in section 5
that WASM instantiate time could not be measured while printing measured medians
for it in sections a and c. The bundle tables are exact to the byte and deserve
to be trusted; the pipeline table needs a parent column and the note needs an
editing pass before Task 1 optimises against it. Fix finding 1 and findings 2
through 5, and this becomes the solid baseline it claims to be.

---

## Fixes

Closed by the perf-mode fixer, wave 2. Scope: `apps/web/lib/perf.ts`,
`lib/perf.test.ts`, `components/editor/PerfHud.tsx` and the smallest edits in
`components/scene/` for findings 5 and 8, plus `lib/advisor.ts` and
`lib/advisor.test.ts` for the two rename-audit items at the end. Findings 3, 4,
6, 7 and 14 belong to the engine agent and are untouched here; finding 1 and
the note's own numbers (10 to 13) are a documentation pass and are untouched
too.

`cd apps/web && npm run lint && npm run typecheck && npm test`: 83 files, 1533
tests, all passing, none skipped, on the tree as these changes landed (13:33).
A later run of the same suite fails inside `lib/engine/**` and its consumers:
`lib/engine/solid/lettering.ts:509` calls `withEngravings`, which
`lib/engine/solid/context.ts:199` exports and `lettering.ts` does not import.
That is the engine agent's file, mid-edit, and nothing to do with these fixes;
`lib/perf.test.ts`, `components/scene/PerfFrameMark.test.tsx` and
`components/scene/RegionMeshes.test.tsx` are green either way (60 tests). Lint
and typecheck report nothing against any file listed below; what the tree
reports at the time of writing is confined to `lib/engine/**`. Playwright was
not run (another agent holds the build lock this wave).

| finding | fix | where | test |
|---|---|---|---|
| 2 | Spans are a tree. `perfSpan` keeps a frame stack, so every timing carries `parent` and `depth`; rows carry `selfMs`; `perfTotalMs` sums the top level only. The console table, the copied text and the HUD indent children, print `self` beside `ms`, and total only depth 0. | `lib/perf.ts:338` `:361` `:755` `:816` `:847`, `PerfHud.tsx:201` `:232` `:253` | `lib/perf.test.ts` "nested spans": a parent with two children, the flat sum proven larger than the top-level total, a grandchild, a mark inside a span, indentation in `perfText` |
| 5 | `preview.geometry` is now `preview.geometryBuild`, named for the CPU work it actually does (float64 to float32, index, normals, bounding sphere). The upload it was credited with gets its own mark, `preview.geometryOnScreen`, on the first frame that renders the new meshes. | `RegionMeshes.tsx:47` `:62` `:91` | `components/scene/RegionMeshes.test.tsx`: the span name, the absence of the old one, `buildGeometry` proven CPU-only, one on-screen mark per build |
| 8 | The first-frame probe moved into `PerfFrameMark`, which decides BEFORE subscribing: with perf mode off nothing renders and `useFrame` is never called, so the render loop is untouched. With it on, the probe unmounts itself after its one mark, which is how r3f unsubscribes. | `PerfFrameMark.tsx:23`, `CityPreview.tsx:636`, `RegionMeshes.tsx:91` | `components/scene/PerfFrameMark.test.tsx`: no frame callback registered with perf off (verified failing against the old unguarded component), one with it on, one mark however many frames run |
| 9 | Runs. Every `perfFlush` closes one and opens the next, timings carry their run id, and rows fold within a run and never across one, so a second build cannot double the first one's `count` and `totalMs`. The last 10 runs are kept, older ones are dropped with their timings, the console prints the closed run only, and the HUD has a run picker plus the Clear button it already had. | `lib/perf.ts:230` `:568` `:592` `:1029`, `PerfHud.tsx:179` | `lib/perf.test.ts` "runs": ids per flush, two builds proven not to fold, the console table proven to hold one run, the cap at `MAX_RUNS`, Clear back to run 1, worker timings re-stamped with the page's run |
| 17 | `longtask` support is read from `PerformanceObserver.supportedEntryTypes`, not inferred from `observe` not throwing. Firefox does not throw; it warns and delivers nothing, and the report used to call that a measured zero. | `lib/perf.ts:631` | `lib/perf.test.ts` "perfInstall": observed true where the entry type exists, `observed: false` and "not observed in this browser" where it does not |
| 18 | `domContentLoadedMs` and `loadMs` are `number \| null`, null while the event has not fired, rendered as `n/a` like paint timing already was. The HUD re-reads the report once on `load` when it mounted before it. | `lib/perf.ts:730`, `PerfHud.tsx:76` `:166` | `lib/perf.test.ts` "navigation timing": null and "load n/a" before the events, the real figures after |
| 19 | `perfUninstall` disconnects the long-task observer and deletes `window.__framecraftPerf`. It runs when the HUD unmounts and whenever `setPerfEnabled` turns the mode off. The `load` listener is removed in the same cleanup. | `lib/perf.ts:303` `:1123`, `PerfHud.tsx:83` | `lib/perf.test.ts` "perfInstall": the hook published, then disconnected and gone after `setPerfEnabled(false)`; a no-op in a realm that never installed |
| 20 | `performance.clearMarks`/`clearMeasures` are called for the names of each harvested batch, at both harvest points (`perfFlush` on the page, `perfDrainTimings` in a worker). By name, never a bare `clearMarks()`, because Next.js and React share that buffer. | `lib/perf.ts:540` `:504` `:1029` | `lib/perf.test.ts` "User Timing buffer": cleared by name on flush and on drain |
| 23 | Confirmed, not changed: `OutputPanel.tsx:159` replaces the address bar with the encoded share link, so the copied link does NOT carry `?perf=1` to whoever receives it, which is the behaviour to keep. The cost is that a reload after copying starts with perf mode off; the `localStorage` flag is the durable switch and is now documented as such in the module docstring. | `lib/perf.ts:40` | none (no behaviour change) |

Two more from `docs/handoff/v3-03-vocabulary-audit.md`, both in files nobody
else held this wave.

| finding | fix | where | test |
|---|---|---|---|
| vocabulary audit, `advisor.ts:113` | The radius button's accessible name said "generate again", the retired verb. It says "preview again" now, which is what the button does (`[V3.1-O3]`). Only a screen reader ever reads that string aloud, which is why it outlived the rename everywhere else. | `lib/advisor.ts:113` | `lib/advisor.test.ts:191` asserts the whole label, and the button-voice test above it now also asserts that no action's accessible name contains "generate" |
| vocabulary audit, `perf.ts:26` | The module docstring named an npm script `build:cli` that does not exist; the script is `export:cli` (`apps/web/package.json`). | `lib/perf.ts:26` | none (a comment) |

Two things a reader of the next baseline should know.

**The HUD shows every kept run by default, grouped by run, rather than only the
latest one.** `e2e/perf.spec.ts` requires the ingest, build and export rows to
be on screen and on the clipboard together (`:87`, `:92-99`, `:153-155`), and
those three are three separate flushes; a latest-run-only default would fail
three assertions that may not be weakened. The defect finding 9 describes is
fixed at the source instead: rows never fold across runs, so two builds are two
rows, never one row with a doubled count. The picker narrows to a single run.

**The copied text keeps `name\tscope\tcount\tms\tbytes` as its leading columns**
and appends `self` after them, rather than putting `self` beside `ms`, because
`e2e/perf.spec.ts:152` asserts that exact header. Child rows are indented two
spaces per level in the name column, and each run is its own block with a
`total (top level)` line.

**Still open in the note itself** (finding 1's owner): `v3-00-baseline.md:85`,
`:207` and `:246` still name `preview.geometry` and still describe it as an
upload.

Checked against `e2e/perf.spec.ts` by reading it, not by running it: every test
id it uses (`perf-hud`, `perf-navigation`, `perf-row` with `data-perf-name` /
`data-perf-scope` / `data-perf-ms`, `perf-resource`, `perf-copy`, `perf-clear`,
`perf-toggle`) is unchanged, and the new elements (`perf-run-select`,
`perf-run-head`, `perf-total`) carry test ids of their own so none of them can
be mistaken for a `perf-row`.
