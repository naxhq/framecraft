# v3-06: adversarial audit of two interrupted tasks

Read-only audit of the work committed unverified at `af02c98` ("Wave 3
checkpoint"), bounded by `git diff f8d484e af02c98`. Three areas: Task 6 (the
action bar), Task 8 (deployed-site performance), and the Task 1 integration
follow-ups under `components/scene/**` and `store/editor.ts`.

Nothing in this pass modified a source file. Line numbers are from the tree as
committed; the working tree carries unrelated uncommitted contract edits from
another agent, which do not touch any file judged here.

## What was run

```
npx vitest run components/editor components/scene lib/serviceWorker.test.ts lib/engine/osm/overpass.test.ts
```

**12 files, 169 tests, 169 passed, 0 failed, 0 skipped.**

| file | tests |
|---|---:|
| `components/editor/ActionBar.test.tsx` | 36 |
| `components/editor/Controls.test.ts` | 15 |
| `components/editor/IssuesBadge.test.tsx` | 5 |
| `components/editor/groups/ColourGroup.test.ts` | 7 |
| `components/scene/BuildingPickProxies.test.ts` | 5 |
| `components/scene/CityPreview.hud.test.ts` | 4 |
| `components/scene/CityPreview.test.ts` | 20 |
| `components/scene/PerfFrameMark.test.tsx` | 3 |
| `components/scene/RegionMeshes.test.tsx` | 15 |
| `components/scene/palette.test.ts` | 13 |
| `lib/engine/osm/overpass.test.ts` | 28 |
| `lib/serviceWorker.test.ts` | 20 |

Also run, both clean: `npx eslint` over every changed file under
`apps/web/{components,lib,app}`, and `npx tsc --noEmit`. `next build` and
Playwright were not run (another agent holds the lock).

Counts: **4 blocker, 8 major, 9 minor, 5 note.**

---

## Task 6: the action bar

### A1. BLOCKER. The task's central invariant has no test, and the source claims one it does not have

`apps/web/components/editor/ActionBar.tsx:377` reads: "The controls, in a row
whose box is measured by `e2e/actionbar.spec.ts` before and after a run and
after a failure: nothing below may move it."

`apps/web/e2e/actionbar.spec.ts` does not exist. Beyond that, no Playwright
spec anywhere references the bar or anything the task added.

**Prove it.** `ls apps/web/e2e/` lists fourteen files, none of them
`actionbar.spec.ts`. Then:

```
grep -rn "action-bar\|run-progress\|run-error-detail\|export-error-detail" apps/web/e2e
```

returns nothing. The test ids `action-bar`, `action-bar-actions`,
`action-bar-status`, `action-bar-status-slot`, `run-progress`,
`run-progress-detail`, `run-progress-phase`, `run-error-detail` and
`export-error-detail` are rendered and referenced only by
`ActionBar.test.tsx`, which is a `renderToStaticMarkup` unit test and can say
nothing about layout, live regions or a real run.

**Smallest correct fix.** Add `apps/web/e2e/actionbar.spec.ts` that reads
`page.getByTestId("action-bar-actions").boundingBox()` at three moments (idle,
mid-run, after a forced failure) and asserts the box is identical, plus one
assertion that `run-progress` carries a rising `aria-valuenow`. If that spec is
out of scope, delete the claim at `ActionBar.tsx:377` rather than leave a
comment naming a file that does not exist.

### A2. BLOCKER. Cancelling during an export is reported as a build failure

Press Export, then press Cancel while the build half is running. The bar shows
"The export was refused: The engine could not build a model." That is false in
both halves: nothing was refused, and nothing failed.

The chain:

- `store/editor.ts:1490` `cancelPipeline` calls `activeRun.handle.cancel()`.
- `store/editor.ts:843-853` handles the `cancelled` code and deliberately
  leaves `pipeline.error` at `null`, because a cancel is not a failure.
- `store/editor.ts:1434-1442` `requestExport` sees `resultForExport` resolve
  `null` and writes
  `exportFailedLocally(state, state.pipeline.error?.message ?? "The engine could not build a model.")`.
  With `pipeline.error` null, the fallback string is what ships.
- `components/editor/ActionBar.tsx:366-367` turns that into an
  `exportFailureModel`, so the copyable detail block records `what: the export
  was refused` for a user-initiated stop.

**Prove it.** In a browser: Preview a preset, move `plate_mm`, press Export,
press Cancel before it finishes. Or in a unit test, set
`pipeline.status: "ready"`, `error: null`, drive `requestExport` against a
cancelled run and read `exportState.error`.

**Smallest correct fix.** In `requestExport`, distinguish a cancel from a
failure before writing the export state: when the run resolved `null` and
`get().pipeline.status !== "error"`, return the export to `idle` (or a
dedicated `cancelled` phase) with "Export cancelled." instead of calling
`exportFailedLocally`.

### A3. MAJOR. The "Fixed" mark regression test was weakened, not strengthened

The brief asked that the mark survive until its row disappears, against
`e2e/print.spec.ts:111`. The pure function is now correct and covered
(`IssuesBadge.tsx:65-75 survivingFixedIds`, five tests in
`IssuesBadge.test.tsx`). The end-to-end assertion went the other way.

`e2e/print.spec.ts:146-154` replaced `expect(fixButton).toBeDisabled()` plus
`toHaveText("Fixed")` with:

```ts
await expect
  .poll(async () => {
    if ((await fixButton.count()) === 0) return "retired with its row";
    return (await fixButton.isDisabled()) ? "marked fixed" : "still offered";
  }, { timeout: WARMUP_BUDGET_MS })
  .not.toBe("still offered");
```

`expect.poll(...).not.toBe(x)` retries until the value differs from `x`, so
`"retired with its row"` satisfies it. The old, broken behaviour (clear every
mark on a fresh findings array) also ends with the row retired once the build
lands, so this assertion passes with the bug present. The one case the fix
exists for, the mark holding while the row is still on screen, is now asserted
nowhere outside the pure function.

**Prove it.** Revert `IssuesBadge.tsx` to `setFixedIds(new Set())` and the spec
still passes.

**Smallest correct fix.** Assert the surviving state on a finding whose fix does
not retire the row in one build, or stub `PIPELINE_DEBOUNCE_MS` upward for that
spec, then assert `Fixed` while `fixButton` is still present.

### A4. MAJOR. The export writer's `float32-degenerate` finding never reaches the Issues badge

`DECISIONS.md [V3.1-P7-5]` states the finding "reaches the sidecar, the CLI and
the Issues badge". It reaches the first two only.

- `lib/exportFlow.ts:160` builds `exportState.findings` as
  `[...findings, ...(outcome.findings ?? [])]`, so the writer's finding is on
  the store.
- No component reads `exportState.findings`. `grep -rn "exportState.findings"
  apps/web/{components,lib,store,app}` returns only the assignment.
- `components/scene/CityPreview.tsx:232` sources the badge from
  `state.pipeline.result?.findings` alone, and `:391` merges only that with the
  client warnings. `lib/issues.ts:15` says so in its own docstring.
- `store/editor.ts:1466` passes `result.findings`, the pre-writer list, so
  `pipeline.result.findings` never gains the writer's rows either.

The finding is visible today only as a string in the export notes list
(`OutputPanel.tsx:167-172`) and in the downloaded sidecar.

**Smallest correct fix.** In `CityPreview.tsx`, subscribe to
`state.exportState.findings` and pass it to `mergeIssues` alongside
`engineFindings`. `mergeIssues` already dedupes by id, so an export re-run
cannot double a row.

### A5. MINOR. Dead branch: the "Previewing..." label and the `fetching` guard cannot be reached

`ActionBar.tsx:387` disables Preview on `!pipelineRunning && (fetching || nothingToPreview)`
and `:399-400` labels it "Previewing..." while `fetching`. Both are unreachable.
`scene.status === "loading"` is written in exactly one place,
`store/editor.ts:1411` inside `generate()`, and the next statement
(`:1417 startPipelineRun`, which sets `pipeline.status: "running"` at
`:686-693`) runs in the same synchronous block. So `pipelineRunning` is true
whenever `fetching` is, and `pipelineRunning ? "Cancel"` always wins.

**Prove it.** `grep -n 'status: "loading"' apps/web/store/editor.ts` returns two
lines, one of them `terrain`.

**Smallest correct fix.** Drop `fetching` from the disabled expression and the
"Previewing..." branch.

### A6. MINOR. `[V3.1-T6]` is cited three times and does not exist

`EstimateCard.tsx:31`, `StatsCard.tsx:30` and `ActionBar.test.tsx:3` all cite
`[V3.1-T6]` as the ruling behind the skeleton rule. `grep -c "V3.1-T6"
DECISIONS.md` returns `0`. No decision line was written for Task 6 at all.

### A7. MINOR. Two soft spots in `ActionBar.test.tsx`

`ActionBar.test.tsx:320` is `expect(renderToStaticMarkup(<ActionBar />)).toBeTruthy()`,
which asserts nothing about anything. And the `settled` fixture at `:316-319`
sets `scene.status: "ready"` with `graph: null`, a combination the store cannot
produce (`generate()` only ever reaches `ready` with a graph), so the
disabled-Preview case is proved against an impossible state.

### A8. MINOR. Typo in a load-bearing comment

`e2e/print.spec.ts:140`: "It cannot be read that way any anymore".

### A9. NOTE. What the bar does get right

The skeleton rule itself is correctly implemented and well covered:
`EstimateCard.tsx:52` now requires `running && est === null`, a superseded
estimate stays on screen dimmed and labelled (`:73-89`), and
`ActionBar.test.tsx:368-428` scans rendered HTML of four surfaces across the
idle, error and completed states for any `-skeleton` id or the `fc-pulse`
keyframe. Save goes through the native path in the desktop shell
(`ActionBar.tsx:332-340`, the v3-02 inventory defect). The progress control is
genuinely determinate, driven by the plan's own `index/total` with no timer on
the fill (`ProgressBar.tsx:103-131`), and carries `aria-valuenow`,
`aria-valuetext` and a phase-level live region.

---

## Task 8: deployed-site performance

### B1. BLOCKER. The service worker registers inside the Tauri desktop shell, ungated

`app/page.tsx:24` calls `installServiceWorker()` unconditionally.
`lib/serviceWorker.ts:295-315` gates on three things only: `"serviceWorker" in
navigator`, `window.isSecureContext`, and `process.env.NODE_ENV !==
"development"`. It never calls `isTauri()`.

The desktop shell meets all three. `apps/desktop/src-tauri/tauri.conf.json`
sets `frontendDist: "../../web/out"`, so the same static export, including
`public/sw.js`, ships inside the app; the shell runs the production build; and
the WebView2 origin is a localhost-class secure context. So the worker installs
over Tauri's custom protocol and begins intercepting the shell's own asset
fetches, for no benefit at all: the desktop bundle reads its files locally and
has nothing to save on a network round trip.

`lib/platform.ts:20 isTauri()` exists and is already used for exactly this kind
of gate at `ActionBar.tsx:334` and `lib/exportFlow.ts:203`.

**Prove it.** `grep -n "isTauri" apps/web/lib/serviceWorker.ts` returns nothing,
and `lib/serviceWorker.test.ts` has no case for it.

**Smallest correct fix.** First line of `installServiceWorker`:
`if (isTauri()) return false;`, with a test beside the three existing
`shouldRegister` cases.

### B2. MAJOR. There is no kill switch

Nothing in `apps/web` ever calls `ServiceWorkerRegistration.unregister()`, and
the only cache deletion is `public/sw.js:231-243`, which drops caches whose
names are not in `KNOWN_CACHES`. A worker that ships with a caching bug can
therefore only be retired by shipping another worker and persuading every
visitor to accept the update. There is no query-parameter escape hatch, no
localStorage flag, and no documented recovery.

**Prove it.** `grep -rn "unregister" apps/web/{lib,app,public,scripts}` hits
only the test's own fake DOM registry.

**Smallest correct fix.** In `installServiceWorker`, before registering: if
`new URL(location.href).searchParams.has("sw-off")` or a
`framecraft.sw.off` localStorage key is set, iterate
`navigator.serviceWorker.getRegistrations()`, unregister each, delete every
cache whose name starts with `framecraft-`, and return false.

### B3. MAJOR. First-load JS did not fall, and the change does not try to make it

`next.config.ts:77-79` says so in its own words: "This does not make the page
load fewer bytes: maplibre-gl and three are imported by components that mount
on the landing page." The chunk split changes which file vendor code lives in
across deploys, which helps a returning visitor's cache, not a first load. No
`dynamic()` boundary moved and nothing was deferred.

Measured over `apps/web/out`, which is a post-change export (it carries the
`vendor-maplibre` and `vendor-three` chunks only this config produces):

| tree | files | raw B | gzip B | brotli B |
|---|---:|---:|---:|---:|
| baseline (`v3-00-baseline.md` section b, `.js` + `.mjs`) | 33 | 4 079 752 | 1 148 188 | 961 324 |
| now | 31 | 4 282 798 | 1 212 141 | 1 008 030 |

Whole-tree JS grew about 5 percent on every column. The deployed first-load
figure the brief names, 947 671 B of transfer over 19 files
(`v3-00-baseline.md:431`), cannot be re-measured without serving the build, and
no post-change measurement of it was recorded anywhere.

**Smallest correct fix.** None in code; this is a scope statement. Either record
the real post-change number, or take one of `v3-00-baseline.md` section b's own
deferral candidates (maplibre behind the first map interaction, three behind the
first preset).

### B4. MAJOR. The task's handoff document and decision lines were never written

`scripts/ci-preset-matrix.sh:27` cites `docs/handoff/v3-08-siteperf.md`, and so
does `DECISIONS.md [V3.1-P7-4]`. The file does not exist; it is the only
referenced handoff document in the repo that is missing. `DECISIONS.md` gained
nineteen lines in this commit and not one of them covers the service worker,
the bundled preset assets, the vendor chunk split or the boot status line.

**Prove it.** `ls docs/handoff | grep siteperf` is empty;
`grep -n "service worker\|siteperf\|V3.1-T8" DECISIONS.md` is empty.

### B5. MAJOR. `scripts/precompress.mjs` is written, documented, and invoked by nothing

`grep -rn "precompress" package.json Makefile .github/workflows/` returns no
call site. The consumer half was built and shipped:
`scripts/serve-static.mjs:78-92 encodedVariant` looks for `<file>.br` and
`<file>.gz` siblings and sets `Content-Encoding` from them. Nothing in any
build, target or workflow produces those siblings. (`apps/web/out` has them,
from a manual run.)

**Smallest correct fix.** Add `node scripts/precompress.mjs` after `next build`
in the `serve-static` path and, if it is meant for Pages at all, in
`pages.yml`; or delete both halves. Note that GitHub Pages compresses on the
fly and ignores precompressed siblings, which `precompress.mjs:10-16` already
says, so the honest home for this is the local server and the desktop bundle.

### B6. MAJOR. The preset manifest costs a request in front of every first Overpass fetch, preset or not

`lib/engine/osm/overpass.ts:391-403` tries the bundled path before the mirror
loop, unconditionally. `loadManifest` (`:227-242`) awaits
`<base>/presets/index.json` whatever the location is, and the result is awaited
before a single mirror is contacted. A user who drops a pin somewhere that is
not one of the six presets therefore pays a full round trip, a 404 on a build
that carries no assets, in front of the exact request this task exists to make
faster. The miss is memoised per realm (`:230`), so it is once per page load,
not once per preview.

**Prove it.** `overpass.test.ts:370` ("falls through to the mirrors on a build
that ships no assets") asserts the fallback works; it does not assert the
mirrors were not delayed. Read `fetchOverpass` at `:391`: the `await` is
sequential.

**Smallest correct fix.** Carry `preset_id` into `FetchOverpassOptions` and skip
the bundled path entirely when it is null, since the manifest can only ever
answer a preset query. Failing that, start `loadManifest` and the first mirror
attempt together and take whichever resolves usefully first.

### B7. MINOR. Cache names are not keyed by the build id, and two buckets need it

`public/sw.js:48-53` fixes every cache name to a `SCHEMA = "v1"` suffix, so a
deploy invalidates nothing; the `activate` sweep at `:231-243` only drops
caches outside `KNOWN_CACHES`. That is correct for `/_next/static/**`, whose
URLs carry a content hash, and it is what the file argues at `:19-21`. It is
not correct for the two buckets whose URLs are stable: `/manifold/**` and
`/maplibre/**` are stale-while-revalidate (`:94-101`, `:288-290`), so a visitor
runs one deploy behind on the MapLibre worker pair until a second visit.

**Smallest correct fix.** Put the build id (already available at `:72`) in
`STATIC_CACHE`'s name only, leaving the chunk and preset caches keyed by
content as they are.

### B8. MINOR. The stale-while-revalidate refresh is not held open

`public/sw.js:142-156` starts the background fetch and returns the cached copy
without passing the refresh promise to `event.waitUntil`. A worker terminated
between the return and the `cache.put` leaves the entry stale, and because the
next hit takes the same path it can stay stale indefinitely on a page that is
never open long enough.

**Smallest correct fix.** Thread the `FetchEvent` into the handler and
`event.waitUntil(network)`.

### B9. MINOR. `trim` walks the whole cache on every write

`public/sw.js:104-115`: `putAndTrim` calls `trim`, which calls `cache.keys()`,
on every single `put`. On a cold load that is one full enumeration of up to 240
entries per chunk cached.

**Smallest correct fix.** Keep a count in the worker and call `trim` only when
it exceeds the cap, or trim once in `activate`.

### B10. NOTE. The first-run status line is not a skeleton and cannot survive idle

Checked directly, because V3-2 forbids exactly this. `app/layout.tsx:114-124`
renders the line with the `hidden` attribute and Tailwind's preflight enforces
it with `display: none !important`
(`node_modules/tailwindcss/preflight.css:396`), so the `flex` class cannot
reveal it and a browser with JavaScript off never sees it. The script
(`layout.tsx:63-95`) reveals only after 300 ms, removes the node when
`data-fc-ready` is set and the MapLibre canvas exists, and removes it
unconditionally at a 10 s cap. It is a status line, not a placeholder, and it
cannot outlive the load. This one is right.

### B11. NOTE. The bundled preset path is genuinely reachable, for all six presets

`overpass.test.ts:27` pins only the Chicago Loop sha1. I recomputed the
TypeScript `querySha1(buildQuery(request))` for every entry in
`fixtures/presets-index.json` and each one equals its committed `fixture_file`
stem, New York's 29-degree rotation included. So every bundled asset can
actually be found. Nothing guards the other five against a future query edit.

**Smallest correct fix.** Widen that test to loop the index rather than name one
preset.

### B12. NOTE. Asset sizes, measured

`gzip -9`, the same level `bundle-preset-assets.mjs:95` uses:

| | bytes |
|---|---:|
| six preset assets, gzip, total | 9 195 733 |
| largest single asset (Tokyo) | 1 867 192 |
| Chicago Loop | 1 763 827 |

The "8.7 MB" in `pages.yml:59` and the script header is MiB and is correct
(8.77 MiB). A visitor downloads one of these, only on a preset click, and
`public/sw.js:284` caps the preset cache at three entries.

### B13. MINOR. A debugging probe was committed

`apps/web/scripts/_probe-scene-size.ts` is 75 lines of twelve bare
`console.log` calls, referenced by nothing (`grep -rn "_probe-scene-size"`
returns only itself).

---

## Task 1 integration follow-ups

### C1. BLOCKER. Per-building tint does not reach the pixels, and the UI says it does

`DECISIONS.md [V3.1-P1-18]` states that `triangleOwner` and `owners` "restores
per-building tint on the actual meshes after the approximate layer was
deleted". The engine half is real: `stages.ts:906-907` attributes every shipped
triangle, `runner.ts:643` transfers the buffer, and `result.ts:191` carries
`buildingTints`. The preview half was never written.

```
grep -rn "triangleOwner\|buildingTints\|owners" apps/web/components/scene
```

returns nothing. `RegionMeshes.tsx:72-107 buildGeometry` reads only the recess
bands and the shade, and `:251` hands three.js a single `mesh.colorHex` for the
whole buildings region. `InstancedBuildings.tsx`, which was the tint consumer,
was deleted in this same commit.

The user-visible consequence is worse than "the control does nothing":
`lib/warnings.ts:306-318 tintPreviewOnlyWarning` still puts an Issues row on
screen reading "Building tint affects the preview and the OBJ export only",
while the preview now shows no tint at all. The four tint controls
(`colour.tint.enabled`, `hue_range_deg`, `lightness_range`, `seed`) affect
exactly one thing in the whole product: the OBJ exporter.

**Prove it.** Preview any preset, open Colour, toggle "Vary building colour" and
reroll. Nothing on screen changes. The grep above is the static proof.

**Smallest correct fix.** In `buildGeometry`, when the region is `buildings` and
`region.triangleOwner` is present, take the expanded-triangle path that already
exists for bands and write the per-owner tint into the colour attribute,
looking each owner up in `result.buildingTints`. The expansion, the attribute
and the `vertexColors` flag are all already there for the recess bands.

### C2. MAJOR. Hero picking still uses invisible proxies, and their stated reason is no longer true

`BuildingPickProxies` is not dead code: `PreviewScene.tsx:100-105` mounts it.
But its docstring at `:15-19` justifies it with "the pipeline's fused region
meshes carry no per-building identity to pick out", which stopped being true at
`[V3.1-P1-18]`; that same decision line promises "exact picking without
proxies". So the app now ships both: the per-triangle identity the engine
computes and transfers on every finish (8 to 15 ms per region, 289 owners on
Chicago), and an invisible `InstancedMesh` of up to 994 oriented boxes with its
own matrix upload (`BuildingPickProxies.tsx:38-60`) doing the job instead.

**Smallest correct fix.** Raycast `region-buildings` and map
`intersection.faceIndex` through `triangleOwner` to `owners`, then delete the
layer, its test and the `pickBuildings`/`pickParams`/`pickScale` props from
`PreviewScene`.

### C3. NOTE. No React state inside the r3f tree

Checked all four in-canvas components. `PreviewScene.tsx`, `RegionMeshes.tsx`,
`BuildingPickProxies.tsx` and `TileGrid.tsx` hold no `useState`, no
`useReducer` and no store subscription. `FitView` (`PreviewScene.tsx:127-141`)
reads `useThree` selectors, which are three.js store reads, not React state.
The only `useState` under the canvas is `PerfFrameMark.tsx:24`, which registers
nothing at all unless perf mode is on. This one is clean.

### C4. MINOR. Stale references to the four deleted preview layers

`InstancedBuildings.tsx`, `BasePlate.tsx`, `RoadRibbons.tsx`,
`AreaSurfaces.tsx` and `TreeInstances.tsx` were deleted in this commit. Still
named as if they exist: `lib/tint.ts:18` and `:135`, `lib/heroes.ts:86`,
`components/scene/TileGrid.tsx:16`, `e2e/ui.spec.ts:783`.

---

## Not implemented at all

### Task 6

1. `apps/web/e2e/actionbar.spec.ts`. No e2e coverage of the layout invariant,
   the progress control, the `aria-valuenow` / live region, Cancel, or the
   copyable detail block. `ActionBar.tsx:377` names the file anyway.
2. A correct outcome for Cancel pressed during an export (A2).
3. An end-to-end proof that a "Fixed" mark survives while its row is on screen;
   the existing spec was rewritten to pass either way (A3).
4. A route from the export writer's findings to the Issues badge (A4).
5. A `DECISIONS.md` line for the task. `[V3.1-T6]` is cited by three files and
   does not exist.

### Task 8

1. A Tauri gate on service worker registration (B1).
2. A kill switch or any documented recovery from a bad worker (B2).
3. Any first-load JS reduction, and any recorded post-change measurement of the
   947 671 B figure (B3).
4. `docs/handoff/v3-08-siteperf.md`, which two shipped files cite (B4).
5. Wiring for `scripts/precompress.mjs`, whose consumer half already ships
   (B5).
6. A `DECISIONS.md` line for the service worker, the bundled preset assets, the
   vendor chunk split, or the boot status line.

### Task 1 follow-ups

1. Per-building tint on the real meshes, which is the stated point of
   `[V3.1-P1-18]` (C1).
2. Proxy-free hero picking, promised by the same line (C2).
3. A reader for `exportState.findings`, which is populated and orphaned (A4).

---

## Fixes: Task 6 (section A), closed

Every finding in section A above, plus the five "not implemented at all" items
under Task 6, with where it was fixed and what now fails if it regresses. This
pass touched only the action bar's own files and its tests; nothing under
`store/**`, `components/scene/**` or `lib/engine/**` was changed, so sections B
and C are untouched and still open.

| Finding | Fixed at | Test that holds it |
|---|---|---|
| A1 BLOCKER: `e2e/actionbar.spec.ts` does not exist while `ActionBar.tsx:377` cites it | `apps/web/e2e/actionbar.spec.ts` (new, 5 tests); the comment rewritten at `ActionBar.tsx:409-415` to describe what the spec really measures | `actionbar.spec.ts` "the bar previews, exports and offers a download without ever moving @smoke", which records `action-bar-actions`'s rectangle every animation frame and asserts one distinct value across a run, a refusal and a finished export |
| A2 BLOCKER: cancelling during an export is reported as a build failure | `ActionBar.tsx:621 stepRunOutcome`, `:686 useRunOutcome`, `:741 failureNotice`, `:227 exportCancelledModel`; the quiet tone at `ExportErrorDetail.tsx:41-46` and `:75-85`; the phase row at `lib/exportFlow.ts:196 EXPORT_FAILED_LABEL` and `OutputPanel.tsx:126-136` | `ActionBar.test.tsx` describe "telling a cancel from a failure" (11 tests): the cancel path and the refusal path are driven through the same batched render sequence and must land on different surfaces; `actionbar.spec.ts` "Cancel during a plate resize leaves the model, its stats and its estimate on screen" |
| A3 MAJOR: the "Fixed" proof was rewritten to pass either way | `e2e/print.spec.ts:135-186`, a mutation-and-frame recorder installed before the click, with the sequence asserted at `:221-248` | `print.spec.ts` "a finding with a fix ... clears when its fix button is clicked": fails if any `enabled:` state follows the first `disabled:Fixed` while the row is present |
| A4 MAJOR: `float32-degenerate` never reaches the Issues badge | `IssuesBadge.tsx:91 withExportFindings` and `:106-117`, subscribing to `exportState.findings` directly | `IssuesBadge.test.tsx` describe "withExportFindings" (4 tests): the writer's row is added, a stale export copy never overwrites a live row, duplicates collapse, and an empty addition returns the same array |
| A5 MINOR: the `fetching` guard and the "Previewing..." label are unreachable | `ActionBar.tsx:424-434` (the disabled expression) and `:444` (the label), both removed | `ActionBar.test.tsx` "keeps Preview live while the scene is being fetched, because the run already owns the button" |
| A6 MINOR: `[V3.1-T6]` is cited three times and does not exist | text written, as a numbered list, in `docs/handoff/v3-06-actionbar.md` section 12 | not a test; the orchestrator appends it to `DECISIONS.md` |
| A7 MINOR: two soft spots in `ActionBar.test.tsx` | the `toBeTruthy()` assertion deleted and the `settled` fixture given a real `SceneGraph` (`ActionBar.test.tsx:115-141` the graph, `:620-645` the test) | the same test, now proving the disabled case against a state the store can actually produce |
| A8 MINOR: typo in a load-bearing comment | `e2e/print.spec.ts`, the comment rewritten | none needed |
| "Not implemented" 1 to 5 | all five above | as above |

Two things that were reported and are worth carrying forward. Neither is a
defect in this task's files.

1. **No e2e can reach the printability gate's refusal.** The client prediction
   `transform.predicted_top_mm` and the engine's measured `bounds.max[2]` agree
   to the millimetre on every flat build (6.92 against 6.92 on the tiny-loop
   fixture), so `exportBlockReason` always refuses first. Terrain relief is the
   only lever that separates them and `e2e/terrainTile.ts` serves a uniform
   tile. The measured recipe and the one-line change that would make it
   reproducible are in `docs/handoff/v3-06-actionbar.md` section 10.
2. **The store still writes "The engine could not build a model." for a
   cancel.** The bar no longer believes it, but the tidier fix is the one this
   audit proposed, in `store/editor.ts:requestExport`. Left for whoever owns
   the store.

Verified: `npm run lint` clean, `npx tsc --noEmit` clean,
`npx vitest run components/editor lib/exportFlow.test.ts` 6 files / 106 tests /
0 failed. `next build` and Playwright were NOT run: `artifacts/build.lock` was
held by another agent for the whole of this pass.
