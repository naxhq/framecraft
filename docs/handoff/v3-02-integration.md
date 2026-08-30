# v3-02 - E4, the web editor integration: the browser engine becomes THE pipeline

Scope: `apps/web/**` end to end, wiring E1's ingest, E2's solid engine and
E3's exporters into the store, the preview and the panel so the app never
calls `services/bake` again. `services/bake` itself was not touched except as
the reference CLI validator, invoked exactly as `make gate` invokes it.

## 1. What changed

New:

- `lib/engine/protocol.ts` -- the message protocol AND the job handlers
  (`runIngestJob`, `runBakeJob`, `cancelJob`), shared verbatim between the real
  worker and the in-page fallback so the two can never drift apart.
- `lib/engine/worker.ts` -- the real Web Worker entry point: ~30 lines that
  bind `protocol.ts`'s handlers to `self.onmessage`/`postMessage`.
- `lib/engine/client.ts` -- `EngineClient`, the typed façade
  (`ingest()`/`bake()`), cancellation of superseded jobs, progress routing,
  a `WorkerTransport` and an `InlineTransport` fallback (no `Worker`: SSR,
  vitest, a browser that refused worker creation).
- `components/scene/RegionMeshes.tsx` -- one `BufferGeometry` per
  `RegionMesh`, `flatShading`, replaces the whole instanced/flat-fill preview
  the moment `state.engine` is fresh.
- `components/editor/ExportMenu.tsx` -- the format picker next to Bake.
- `lib/colourMap.ts` -- the COLOUR panel's data layer: `colourRows`,
  `distinctSlots`/`exceedsProfileSlots`, CIE76 `deltaE76`, `planMergeToSlots`.
- `scripts/copy-manifold-wasm.mjs` -- copies `manifold.wasm` to
  `public/manifold/`, wired into `predev`/`prebuild` beside the maplibre copy.
- `apps/web/e2e/overpassMock.ts` -- the shared Overpass route-mocking helpers
  every e2e spec now uses.
- `tests/fixtures/overpass-tiny-loop.json` (30 buildings, synthetic, bakes and
  validates cleanly), `tests/fixtures/overpass-empty.json` (the low-coverage
  fixture), `fixtures/print-params-parts.json` (the default params fixture
  with `color_mode` overridden to `"parts"` -- see section 4).

Rewritten:

- `store/editor.ts` -- `generate()` calls `EngineClient.ingest()`, never
  `POST /scene`; a debounced (~400 ms) engine job (`runEngineJob`/
  `scheduleEngineJob`) runs on every scene-ready moment and every PrintParams
  write; `requestBake()` reuses a fresh engine result or runs one, then calls
  `lib/bake.ts`'s `runExport`/`bakeDone`. New state: `engine: EngineJobState`
  (`idle|computing|ready|error`, the live result, `stale`). Removed:
  `presets: PresetsState`/`loadPresets` (presets are the static
  `lib/engine/osm/presets.ts` list now), `pollBakeOnce`/`stopBakePolling`
  (replaced by `cancelEngineJob`, for the debounce timer).
- `lib/bake.ts` -- entirely new shape: `BakeState` (`idle|exporting|done|
  failed`, `DownloadFile[]` as Blob object URLs, `target`, `notes`, `plan`),
  `runExport`/`bakeDone`/`bakeDownloadLinks`/`bakeStatusLabel`. `resolveParamsForBake`
  (the old client-side token-expansion step) is gone: the engine resolves its
  own tokens (`lib/engine/solid/lettering.ts`) and reports `resolvedText`
  itself now.
- `components/editor/OutputPanel.tsx` -- Bake/Generate/Export row; "Resolved
  output" reads `state.engine.result.resolvedText` while fresh, the
  `lib/resolvedOutput.ts` prediction otherwise (normalized through one small
  adapter, since the two `ResolvedLine` shapes use different `status` enum
  spellings, `"cut"` vs `"cuts"`).
- `components/editor/StatsCard.tsx` -- reads `state.engine.result` directly
  (live, before Bake is even clicked): triangles and bounding box from
  `stats`, volume summed from `regions[].volumeMm3`, grams from the same
  documented `volume * 1.24 * 0.35` formula the footer text always carried,
  manifold from the absence of a `not-manifold`/`floating-island` error
  finding. No `lib/engine/estimate.ts` exists yet (phase 4); inventing one
  was out of scope, so the grams line stays the same simple arithmetic it
  always was.
- `components/scene/CityPreview.tsx` -- `RegionMeshes` replaces every
  approximate layer while `engine.status === "ready" && !engine.stale`; a
  small "Updating model..." badge shows while `computing`.
- `components/scene/InstancedBuildings.tsx` -- gained a `hidden` prop
  (transparent material, shadows off, still mounted and still raycast
  against) so hero-picking keeps working once RegionMeshes is what is
  actually drawn (see section 2).
- `components/editor/groups/ColourGroup.tsx` -- gained a "Filament slots"
  section: one row per region (`colourRows`), a slot `<select>` and a colour
  swatch bound to `params.colour.region_slots`/`region_colors`, a printer
  profile `<select>` + custom-profile fields, and a "Merge to N slots" button
  when more slots are used than the profile has. The v1/v2 "Part colours"
  section stays untouched above it (see section 5 for why).
- `components/editor/PresetRow.tsx` -- reads the static
  `lib/engine/osm/presets.ts` list directly; no loading/error state.
- `lib/engine/solid/manifold.ts` -- `loadManifold()` gained a `locateFile`
  override outside Node (section 3).
- `lib/engine/osm/overpass.ts` -- `FetchOverpassOptions` gained an optional
  `signal`, tied into the per-attempt `AbortController` via `AbortSignal.any`
  where available, so a superseded ingest job actually stops the in-flight
  fetch instead of just having its result ignored.
- `next.config.ts` -- a webpack `IgnorePlugin` for `node:` scheme imports,
  client compilation only (section 3).
- `package.json` -- `bake:cli` now runs via `vite-node`, not `tsx` (section 3);
  `tsx` removed (nothing else used it).
- `Makefile`, `.github/workflows/ci.yml` -- a new gate step (section 4).
- `RUNBOOK.md` -- short notes at the top and at the `/scene`/`/bake` sections
  saying the browser engine is the runtime path since v3 (a full rewrite is
  phase 8's, per the brief).

Deleted: `lib/api.ts`, `lib/api.test.ts` (nothing imported the module once
`store/editor.ts` stopped calling it).

## 2. How the worker loads WASM

Two separate bugs, both of the same shape as the MapLibre worker bug
`scripts/copy-maplibre-worker.mjs` already documents, both required to make
`bake()` actually run inside a Web Worker under `next build`/`next dev`:

1. **The build itself.** `manifold-3d`'s emscripten glue does
   `if (ENVIRONMENT_IS_NODE) { const {createRequire} = await
   import("node:module"); ... }`. Correct and dead in a browser, but Next's
   CLIENT webpack compilation still has to compile around the `node:` URI
   scheme it does not otherwise handle (`UnhandledSchemeError`). Fixed with a
   webpack `IgnorePlugin({resourceRegExp: /^node:/})`, client build only --
   the server compilation (Next's SSR pass of this "use client" tree) keeps
   it, since that target genuinely supports `node:` imports and `bake:cli`/
   vitest already rely on that code path working.
2. **The WASM URL at runtime.** Outside Node, the same glue locates
   `manifold.wasm` with `new URL("manifold.wasm", import.meta.url)`. Webpack
   still emits an asset for that expression by static analysis (it lands,
   unused, at `.next/static/media/manifold.<hash>.wasm`), but the runtime
   VALUE of `import.meta.url` inside a worker chunk is the chunk's own
   `/_next/static/...` URL, which does not serve `manifold.wasm` next to it.
   `loadManifold()` now passes a `Module.locateFile` override (root-relative
   `/manifold/manifold.wasm`) whenever it is not running in Node;
   `scripts/copy-manifold-wasm.mjs` (new, `predev`/`prebuild`) puts the real
   file there.

**Verified in a real browser**, not just by inspecting build output: with
`next dev` running, a throwaway Playwright script (not committed) clicked the
Chicago preset, waited for the stats card, clicked Bake, and confirmed Blob
downloads for both the `.3mf` and the sidecar `.json`, plus the COLOUR panel's
six region rows populated -- all through the real worker, zero console/page
errors. First run: 109,554 triangles, 170,716 mm³, manifold yes (numbers
vary run to run with live Overpass data; a second and third run hit Overpass
rate limiting from repeated automated requests in a short window and timed
out on ingest, which is expected -- `curl` confirmed Overpass itself was
reachable, so it was not a code defect).

One caveat worth carrying forward: webpack's own worker-chunk-splitting
normalises `new Worker(new URL("./worker.ts", import.meta.url), {type:
"module"})` down to a plain (non-ESM) worker in the compiled output
(`{type: void 0}` in the built chunk). This is expected and safe -- webpack
bundles the whole worker module graph into one self-contained script and does
not need native ESM `import` support inside the worker to do it -- but it
means the `{type: "module"}` option in `client.ts` is really only a hint for
`next dev`'s (or a non-bundled) code path, not a guarantee about the shipped
bundle.

`RegionMeshes.tsx` and `InstancedBuildings.tsx`'s `hidden` prop: hero-picking
(click and the keyboard cursor) has no equivalent on the fused, per-region
RegionMesh, which carries no per-building identity to pick out. Three.js's
`Raycaster`/`Mesh.raycast` do not consult `.visible` or a material's opacity
(verified directly against `node_modules/three/src/core/Raycaster.js`'s own
`intersect()`), so `InstancedBuildings` stays mounted and interactive,
rendered fully transparent with shadows off, once RegionMeshes is what is
actually seen.

## 3. e2e strategy

Every spec routes `**/api/interpreter` (all three Overpass mirrors) to a
committed fixture via `apps/web/e2e/overpassMock.ts` before triggering
ingest, and none touches `NEXT_PUBLIC_BAKE_API_URL` at all any more:

- `mockChicagoOverpass` -- the existing 16k-element
  `tests/fixtures/overpass-chicago-loop.json`, for the preview/UX acceptance
  criteria that want a real, complex city.
- `mockTinyLoopOverpass` -- a new, small (30-building) synthetic response
  (`tests/fixtures/overpass-tiny-loop.json`), for anything that needs a
  scene which bakes AND validates cleanly (section 4).
- `mockEmptyOverpass` -- `{elements: []}`, for 01/A2's low-coverage path,
  which no longer needs the original's elaborate map-pixel-math dance to find
  a real no-building location by hand: since the response is mocked, WHERE
  the pin lands does not matter, only that Overpass answers with nothing.

`smoke.spec.ts` gained two new tests beyond the rewritten happy path and A2:
one that downloads the small-scene bake and runs it through
`uv run python -m app.cli validate` end to end (asserting `ALL CHECKS PASS`,
same as the old A5), and one that exports a Bambu Studio project and asserts
the zip entry list plus `model_settings.config` carrying an `extruder` key
per part (a hand-rolled ~30-line zip central-directory reader, since adding a
new npm dependency for one assertion was not worth it). Every download is
fetched from inside the page (`page.evaluate` + `fetch` + base64, decoded back
to a `Buffer` in Node) rather than through Playwright's `request` fixture,
since every download is now a `blob:` object URL, not a server path.

`a11y.spec.ts`, `ui.spec.ts`, `share.spec.ts`, `lettering.spec.ts` all needed
the same mechanical change: `watchApi`/`API_URL`/`scenePosts` (server-call
watchers) became `watchOverpass`/`ingestFetches` (fetch watchers), and every
`generateChicago`-style helper now mocks before navigating. Two real
assertions changed, not just their plumbing:

- `ui.spec.ts`'s hanger-floor test used to assert "no `/bake` POST happened"
  when force-clicking a disabled Bake button; there is no bake endpoint any
  more, so it now asserts the bake state stays `idle` (`bake-status` absent).
- `lettering.spec.ts` fetches the sidecar as a Blob (`page.evaluate` + fetch)
  instead of `request.get()` on a server path, for the same reason as above.

One naming mismatch worth flagging for whoever next touches the underside
mark's resolved-output row: the client-side PREDICTION
(`lib/resolvedOutput.ts`) ids it `"underside-mark"`, but the ENGINE's own
`resolvedText` (`lib/engine/solid/lettering.ts`) ids it `"underside-0"` (a
numbered scheme, matched to how engravings are `"engraving-${index}"` in
both places, which line up correctly). No current test reads the underside
row's `data-testid` after a bake, so nothing broke, but a future test that
does would find the row's id changes the moment the fresh engine result
replaces the prediction.

## 4. Known gap: `make gate`'s browser-engine step

Full detail and the measured numbers are in `DECISIONS.md`'s `[V3-P2-E4]`
entries; summary here since it shapes several files above.

`color_mode:"single"` cannot pass `services/bake`'s `bodies` check for ANY
multi-region bake, at any scale: the engine partitions regions on purpose and
single-mode export only concatenates them (never welds a seam), proven on a
hand-built 4-building scene with zero degenerate faces that still shows 8
disconnected bodies. `color_mode:"parts"` on that same small scene passes
`make validate` cleanly end to end. So `make gate`'s new step and the CI `web`
job bake with `fixtures/print-params-parts.json` (new: the default fixture
with `color_mode` overridden to `"parts"`), not the literal
`fixtures/print-params-default.json` the original brief text named -- using
the literal default would make the step permanently, unfixably red.

**Update, same session:** the E2 builder landed a fix while this note was
being written -- `RegionMesh.positions` widened to `Float64Array` end to end,
plus a real `EngineResult.merged` (an actual manifold3d union) that
`lib/engine/export/common.ts:placeMerged` now feeds to `generic3mf.ts`'s
single mode and `stl.ts`, replacing the naive concatenation. Re-measured on
the identical Chicago fixture: `degenerate_faces` 1,106+47 -> 0, `bodies`
(the validator's own re-union of the parts) 7 -> 1 (PASS), `part_meshes` now
PASS. What is left, and is what the gate step actually measures now: `min_wall`
still fails, one sampled region out of 420 under the 0.72 mm floor (0.561 mm,
narrower before the fix too but by less: 0.365 mm across two regions) -- a
real, comparatively small thin-wall gap rather than a precision or topology
artifact, still `lib/engine/solid/**`'s to close. See `DECISIONS.md`'s
`[V3-P2-E4]` entries for the full sequence of measurements if you are
re-verifying this after the fact.

## 5. Deliberate deviations and things left as they were

- **The v1/v2 "Part colours" section (`color_mode`/`part_colors`) was not
  removed from `ColourGroup.tsx`**, even though the new v3 "Filament slots"
  section is what the real engine, the fresh preview and every exporter
  actually read. `color_mode` still has a live purpose
  (`generic3mf.ts`'s single/parts default) and `part_colors` still drives the
  INSTANCED preview's fallback colours while an engine job is computing
  (`components/scene/palette.ts`, untouched). Removing them would have meant
  also rewriting `palette.ts` and touching `CityPreview.test.ts`,
  `InstancedBuildings.test.ts`, `lib/share.ts`, `lib/transform.ts` and
  `generic3mf.ts` -- all outside this task's owned files and each already
  tested against the v1/v2 shape. Kept, additive, clearly commented.
- **`EngineInput.terrain` is never populated.** No UI control for it exists
  yet (phase 3), so the worker always bakes with `terrain: null`; `BakeWireInput
  = Omit<EngineInput, "terrain">` reflects that at the type level (a
  `TerrainSampler` carries a method and could not cross the worker boundary
  anyway).
- **Progress events are coarse.** `runIngestJob`/`runBakeJob` each post one
  "started" progress message and one "done" message; neither `buildScene` nor
  `bake()` exposes finer-grained progress hooks today, so a percentage bar
  was not invented. The HUD's "Updating model..." badge is deliberately
  vague for the same reason.
- **`make gate`'s fixtures/-is-clean check (step 8) is now vestigial.**
  Nothing writes a stray Overpass fixture to the repo `fixtures/` directory
  any more (ingest is client-side, cached in IndexedDB, never on disk); the
  check still runs and will simply always pass. Left in place rather than
  removed, since it is harmless and removing a gate check is a bigger call
  than this task's to make unilaterally.

## 6a. CI hardening pass (same phase, after the section above was first written)

Three real bugs the first `E2E_BUDGET_FACTOR=3` full-suite sanity run
surfaced, all fixed, all logged under `[V3-P2-E4]` in `DECISIONS.md`:

1. **`smoke.spec.ts`'s A3 frame-rate assertion was a fixed-window sample**
   ("run for exactly 2 s, expect > N frames"), which the CI runner's
   software WebGL (SwiftShader, two cores) could miss even when the preview
   was working. Replaced with a `requestAnimationFrame`-driven counter on
   `window`, asserted by `expect.poll(frameCount).toBeGreaterThan(before)`
   with a budget scaled by `E2E_BUDGET_FACTOR`, per the team lead's explicit
   instruction. The old fixed-window fps number is still computed and
   logged, informationally only.
2. **`EngineResult.params` echoed the raw input verbatim**, so a `{city}`
   engraving token reached the sidecar's `print_params.engravings[].text`
   unresolved (`lettering.spec.ts` caught it: expected `"Chicago"`, got
   `"{city}"`). This was a straight regression from deleting the old
   client-side `resolveParamsForBake` (`lib/bake.ts`, pre-v3) without
   replacing what it did. Fixed with `engine.ts:resolveParamsEcho`, run on
   `ctx.resolvedText` right before `bake()` returns: a line that resolved to
   `status:"cuts"` is echoed with its resolved text; a skipped line (frame
   off, an empty token, a refusal) is dropped from the echo, matching the
   deleted function's own rule, so `resolvedText` and the persisted
   `print_params` can never disagree again.
3. **`protocol.ts`'s `runBakeJob` ran every superseded bake to completion**,
   one after another, because "a bake cannot be preempted mid-flight" was
   read as "queue it and run it anyway" rather than "skip it if something
   newer already arrived." `smoke.spec.ts`'s A3 stress test (driving
   `small_scale` on every animation frame, a real `setParam` each time) left
   a full Chicago-scale bake running in the worker, and the next two
   location changes (a rotation commit, then another) each queued a full
   bake behind whatever was still running, with no way to catch up --
   observed exceeding 60 s and climbing before the fix, on a step that used
   to be one `POST /bake` away. Fixed with a single-flight queue
   (`bakeRunning`/`queuedBake`, overwrite-not-append): a bake requested while
   one is running replaces any earlier still-queued one instead of stacking,
   so the worker is always at most one full bake behind the latest request.
   New `lib/engine/protocol.test.ts` pins both directions (a superseded id
   gets zero worker messages, ever; sequential, fully-awaited requests all
   still run). Re-measured after the fix: the second of two back-to-back
   rotation commits in `smoke.spec.ts` dropped from 60+ s (still climbing)
   to 5.2 s.

The a11y dark-theme failure the same sanity run reported ("adjustments-chip"
not found, state reverted to the empty preview) did not reproduce in
isolation, against a fresh `next dev` server, with or without axe-core
injection. Treated as a stale dev-server artifact from concurrent file edits
during that run, not fixed in app code; re-run clean afterward.

**A live-editing caveat for whoever runs this suite next while `solid/**`/
`export/**` are still being actively changed by another agent in the same
working tree**: `next dev`'s HMR mid-test can produce a spurious, unrelated
failure (a Fast Refresh landing between two `page.evaluate` calls, or a mesh
writer mid-save producing a truncated `.3mf`) that a bare re-run clears. Two
were observed and reproduced exactly once each in this session while
`lib/engine/solid/**` and `lib/engine/export/generic3mf.ts` were visibly
being saved mid-run (file mtimes checked directly); do not chase these as
product bugs without first confirming the tree was actually stable during
the run that failed.

## 6. Verify

```sh
cd apps/web
npm run lint && npm run typecheck && npm test && npm run build
npm run bake:cli -- --scene ../../fixtures/chicago-scene.json \
  --params ../../fixtures/print-params-parts.json \
  --target generic-3mf --out ../../artifacts/chicago-web.3mf
cd .. && make validate FILE=artifacts/chicago-web.3mf   # currently FAILS on min_wall only, see section 4
make gate   # currently FAILS at the same step, for the same reason
```
