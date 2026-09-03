# v3.1-03 vocabulary: Preview and Export

"Bake" is retired. The app has exactly two primary actions:

- **Preview** builds or rebuilds the model from the current location and
  settings and shows it in the viewport. The old **Generate** button is now
  Preview; it still runs the Overpass ingest, after which the debounced engine
  job runs on its own exactly as before.
- **Export** writes the downloadable file in the currently selected format.
  The old **Bake** button is now Export.

Scope ruling: `[V3.1-O3]` in `DECISIONS.md`. Nothing in
`packages/contracts/`, `DECISIONS.md` or the historical handoff notes
(`docs/handoff/0*.md`, `v2-*.md`, `v3-00-*.md` .. `v3-08-*.md`) was touched.

---

## 1. The mapping applied

### 1.1 User-facing strings

| Before | After | Where |
|---|---|---|
| `Generate` / `Regenerate` / `Generating...` | `Preview` / `Preview again` / `Previewing...` | `components/editor/OutputPanel.tsx` |
| `Bake` / `Baking...` | `Export` / `Exporting...` | `OutputPanel.tsx` |
| `Not baked yet` | `Not exported yet` | `lib/exportFlow.ts:exportStatusLabel` |
| `Parameters changed since this bake - bake again ...` | `Parameters changed since this export. Export again to download a matching file.` | `lib/exportFlow.ts:EXPORT_STALE_NOTE` |
| `Generate a scene first.` | `Preview a location first.` | `lib/warnings.ts:exportBlockReason`, `store/editor.ts`, `groups/BuildingsGroup.tsx` |
| `Too few buildings to bake` | `Too few buildings to export` | `lib/issues.ts` |
| `The bake, the files and the measured stats.` | `The model, the files and the measured stats.` | `lib/groups.ts` (Output group summary) |
| `from the previous bake` | `from the previous build` | `components/editor/EstimateCard.tsx` (it labels the engine result, not a file) |
| `From the bake` | `From the model` | `lib/adjustments.ts` drawer heading |
| `Generate the scene for this location` | `Preview this location` | `lib/keyboard.ts` shortcut sheet (key **G** unchanged) |
| `Bake the printable model` | `Export the printable model file` | `lib/keyboard.ts` shortcut sheet (key **B** unchanged) |
| `Choose a file format; Bake exports it` | `Choose a file format; Export writes it` | `components/editor/ExportMenu.tsx` |
| `2. Generate. The scene arrives in a few seconds.` | `2. Preview. The model arrives in a few seconds.` | `components/scene/CityPreview.tsx` empty state |
| `4. Bake, and download the .3mf.` | `4. Export, and download the .3mf.` | same |
| `Keyboard: G generate - B bake - R reset` | `Keyboard: G preview - B export - R reset` | same |
| `The location moved. Generate to rebuild the model for it.` | `... Preview to rebuild the model for it.` | `components/editor/WarningBanners.tsx` |
| `Fetching the scene from OpenStreetMap...` docstring `While POST /scene is in flight` | `While the OpenStreetMap fetch is in flight` | `CityPreview.tsx:PreviewSkeleton` (the caption itself was already correct) |
| `... can take their own colour when the bake runs.` | `... when the model is built.` | `groups/BuildingsGroup.tsx` |
| `Each tile still bakes and exports through the same pipeline.` | `Each tile is built and exported through the same pipeline.` | `groups/PrinterGroup.tsx` |

`Updating model...` (the stale-preview badge) is unchanged, as instructed.
Progress and status rows now agree with the button: the row that already said
`Exporting...` is now started by a button that also says Export.

### 1.2 TypeScript identifiers (`apps/web/**`)

Engine / model build, the `Build` family:

| Before | After |
|---|---|
| `bake()` (`lib/engine/engine.ts`) | `buildModel()` |
| `EngineClient.bake()` | `EngineClient.buildModel()` |
| `EngineClientTransports.bake` | `.build` |
| `runBakeJob` / `runOneBake` | `runBuildJob` / `runOneBuild` |
| `BakeJobMessage` / `BakeProgressMessage` / `BakeDoneMessage` / `BakeErrorMessage` | `BuildJobMessage` / `BuildProgressMessage` / `BuildDoneMessage` / `BuildErrorMessage` |
| message kinds `"bake"`, `"bake-progress"`, `"bake-done"`, `"bake-error"`; `jobKind: "bake"` | `"build"`, `"build-progress"`, `"build-done"`, `"build-error"`; `jobKind: "build"` |
| `BakeWireInput` | `BuildWireInput` |
| `BakeOptions` | `BuildOptions` |
| `BakeContext` (`solid/context.ts`, 170 uses) | `BuildContext` |
| `bakeTransport` / `pendingBake` / `currentBakeId` / `supersedeBake` | `buildTransport` / `pendingBuild` / `currentBuildId` / `supersedeBuild` |
| `bakeRunning` / `queuedBake` / `resetBakeQueueForTest` | `buildRunning` / `queuedBuild` / `resetBuildQueueForTest` |
| `bakeWarnings` (`lib/adjustments.ts`) | `buildWarnings` |
| `AdjustmentGroup` value `"bake"`, item ids `bake-N` | `"build"`, `build-N` |
| perf span `engine.bake` / `engine.bake.client` | `engine.build` / `engine.build.client` |
| `bakeDate` (`engine.ts`) | `buildDate` |

Export flow, the `Export` family:

| Before | After |
|---|---|
| `lib/bake.ts` | `lib/exportFlow.ts` |
| `lib/bake.test.ts` | `lib/exportFlow.test.ts` |
| `scripts/bake-cli.ts` | `scripts/export-cli.ts` |
| `BakeState` / `BakePhase` / `initialBakeState` | `ExportState` / `ExportPhase` / `initialExportState` |
| store field `state.bake` | `state.exportState` (`export` alone is a reserved word) |
| `requestBake` | `requestExport` |
| `bakeDone` / `bakeExporting` / `bakeFailedLocally` | `exportDone` / `exportStarted` / `exportFailedLocally` |
| `markBakeStale` / `revokeBakeUrls` | `markExportStale` / `revokeExportUrls` |
| `bakeDownloadLinks` / `bakeStatusLabel` | `exportDownloadLinks` / `exportStatusLabel` |
| `BAKE_STALE_NOTE` | `EXPORT_STALE_NOTE` |
| `bakeBlockReason` (`lib/warnings.ts`) | `exportBlockReason` |
| `MIN_BUILDINGS_TO_BAKE` | `MIN_BUILDINGS_TO_EXPORT` |
| `resolveParamsForBake` | `resolveParamsForExport` |
| `Shortcut` action `"bake"` | `"export"` (the key stays **B**) |

Test-local helpers renamed with them: `bakeScene` -> `buildFromScene`,
`bakeWith` -> `buildWith`, `bakeWorker` -> `buildWorker`, `bakeMock` ->
`buildModelMock`, `bakePending` -> `buildPending`, `fakeBakeResult` ->
`fakeBuildResult`, `firstBake`/`secondBake` -> `firstBuild`/`secondBuild`,
`bakeId` -> `buildId`, `bakeBefore` -> `buildBefore`, `bakeButton` ->
`exportButton`, `bakeStatus` -> `exportStatus`, `withFinishedBake` ->
`withFinishedExport`, `waitForFreshBake` -> `waitForFreshBuild`,
`cardTextBeforeBake` -> `cardTextBeforeExport`, `bakeStartedAt`/`bakeMs` ->
`exportStartedAt`/`exportMs`, `BAKE_BUDGET_MS` -> `BUILD_BUDGET_MS`.

`generate()` in `store/editor.ts` and the `"generate"` shortcut action keep
their names: the identifier mapping in the brief covers `bake*` symbols, and
renaming the ingest action reaches into the scene state machine, which the
later action-bar task owns. Its user-facing label is Preview everywhere.

### 1.3 Playwright test ids

| Before | After |
|---|---|
| `generate-button` | `preview-button` |
| `bake-button` | `export-button` |
| `bake-status` | `export-status` |
| `bake-progress` | `export-progress` |
| `bake-notes` | `export-notes` |
| `bake-stale-note` | `export-stale-note` |
| `bake-block-reason` | `export-block-reason` |

Specs updated: `smoke`, `ui`, `a11y`, `colour`, `lettering`, `print`,
`terrain`, `share`, `workflow`, `perf`, plus `e2e/overpassMock.ts`.
`smoke.spec.ts` asserted the visible button text (`/^Generate$/`) and
`ui.spec.ts` asserted the empty viewport copy (`Generate`); both now assert
`Preview`. No assertion was weakened or removed.

### 1.4 Make, npm, CI

| Before | After |
|---|---|
| `make bake-fixture` | `make export-fixture` |
| `npm run bake:cli` | `npm run export:cli` |
| gate step 4 label `bake:cli` | `export:cli` |
| CI job `bake-service` | `reference-service` |
| CI steps `browser engine bake:cli (...)` | `browser engine export:cli (...)` |
| `gate-v2` shell helper `bake()` | `fixture()` (a shell function may not be called `export`) |
| `gate-v2` logs `gate-v2-*-bake.log` | `gate-v2-*-export.log` |
| `scripts/gate-web-engine.sh` log `bake-cli-<label>.log` | `export-cli-<label>.log` |

## 2. Aliases kept

| Alias | Behaviour |
|---|---|
| `make bake-fixture` | prints `bake-fixture is now export-fixture` on stderr, then runs `export-fixture`, forwarding `COLOR`, `TEXT` and `PLATE`. Verified: `make bake-fixture COLOR=bogus` prints the notice, then `make export-fixture: COLOR must be 'single' or 'parts' (got 'bogus')`, exit 2. |
| `npm run bake:cli` | forwards to `npm run export:cli --`, same script, same arguments. |

## 3. Names deliberately unchanged

Per `[V3.1-O3]`, these are reference-implementation internals or frozen
contract identifiers; renaming them changes nothing the author sees and would
churn CI, uv config and the v1 golden path.

- The Python package directory `services/bake/` and everything addressed
  through that path.
- Its HTTP routes `POST /bake`, `GET /bake/{id}`, and the CLI verb
  `python -m app.cli bake` (still what `make export-fixture` invokes).
- The `BakeResult` contract schema (`packages/contracts/schema/bake_result.json`)
  and the generated `BakeResult` / `BakeFiles` / `BakeStats` types plus the
  `bake_result` sidecar key.
- The docker-compose service `bake`, the `make up` / `make down` process name
  `bake`, and the `.claude/agents/mesh-bake.md` agent (its name is pinned by
  `05_AGENT_TEAM.md`, which is frozen and outside this task's edit list).

## 4. Remaining hits, and why each one stays

Grep over the whole tree, excluding `node_modules`, `out`, `.next`,
`DECISIONS.md`, the historical handoff notes, `services/bake/` and
`packages/contracts/`:

```
grep -nI -E '\bbake\b|\bBake\b|baking|Generate a scene'
```

Every surviving hit is one of these six cases.

1. **`services/bake` as a path** (the large majority: `Makefile`, `RUNBOOK.md`,
   `CONTRIBUTING.md`, `README.md`, `docs/ARCHITECTURE.md`, `.github/workflows/ci.yml`,
   `docker-compose.yml`, `.dockerignore`, `.gitignore`, `apps/web/playwright.config.ts`,
   `apps/web/e2e/smoke.spec.ts`, and ~30 `apps/web/lib/**` "mirrors
   `services/bake/app/...`" comments). Frozen by `[V3.1-O3]`.
2. **The reference service's routes and CLI verb**: `POST /bake` and
   `GET /bake/{id}` in `RUNBOOK.md`, `docs/ARCHITECTURE.md`,
   `.claude/agents/{mesh-bake,web-editor}.md`, `apps/web/lib/tokens.ts`,
   `apps/web/lib/resolvedOutput.ts`, `apps/web/lib/heroes.test.ts`; and
   `python -m app.cli bake` in `Makefile:461`.
3. **The frozen contract**: `BakeResult` / `BakeFiles` / `BakeStats` in
   `apps/web/lib/contracts.ts` (generated), `bake_result` in
   `apps/web/lib/engine/export/common.ts` and `lib/exportFlow.test.ts`,
   `"generator": "FrameCraft bake"` inside `fixtures/v1-golden/chicago-default.sidecar.json`
   (a byte-for-byte golden that `test_v1_compat.py` pins).
4. **The two aliases**, which exist to carry the old name:
   `apps/web/package.json` (`bake:cli`), `Makefile` (`bake-fixture` target,
   its `.PHONY` entry, its help line and the notice it prints).
5. **Files outside this task's edit list**: `CLAUDE.md`, `00_KICKOFF_PROMPT.md`,
   `01_PRODUCT_SPEC.md` .. `05_AGENT_TEAM.md`, `docs/IMPLEMENTATION_PLAN.md`,
   `docs/handoff/STATUS.md`, `docs/handoff/FAILURES.md`, `fixtures/*.json`
   (generated parity fixtures), `progress.md`. `CLAUDE.md` still documents
   `make bake-fixture` and `05_AGENT_TEAM.md` still names the `mesh-bake`
   agent and gate G3; the orchestrator owns both.
6. **The CHANGELOG entry that documents this rename**, which has to name the
   retired word.

Two hits worth calling out for whoever owns the specs next: `01_PRODUCT_SPEC.md:25`
still says "Click Bake. A job runs server-side", and `02_TECH_SPEC.md:144`
describes the bake path as a server route. Both predate v3 and are wrong on
two counts now, not just the vocabulary.

## 5. Accuracy: Export writes a model file, not G-code

Audited every string around Export, the format menu and the output panel.
There was no claim anywhere that FrameCraft slices or prints; three claims
overstated what the export does, and all three are fixed.

1. `components/editor/groups/ColourGroup.tsx` slot-and-colour hint said "What
   the **printed model**, the Bambu project and the colour-change plan actually
   use". The printed model does not exist yet. Now: "What the **exported file**,
   the Bambu project and the colour-change plan actually use ... This is what
   the preview shows once the model has been built."
2. `ColourGroup.tsx` tint note and `lib/warnings.ts:tintPreviewOnlyWarning`
   both said "the active export target (X) **prints** every building in its
   region's own slot colour" - the export target does not print. Now: "gives
   every building its region's own slot colour instead."
3. `components/scene/CityPreview.tsx` over-height badge said "Over the N mm
   **print ceiling** - the bake will refuse this", which read as though a
   printer were involved. Now: "Over the N mm **printer height ceiling**. The
   build will refuse this" - the ceiling is the active profile's, and the
   refusal is the engine's.

Also corrected while in the same files: the sidecar's `generator` field was
`FrameCraft web bake`, now `FrameCraft web engine` (nothing reads it as a key;
grep across the repo and `services/bake` returns one definition site);
`app/globals.css` called the indeterminate export bar "the bake bar when the
server has not reported a percentage yet", which named a server that no longer
exists.

The one claim about slicing that is kept, exactly as worded, is the Bambu
Studio project 3MF in `README.md`: "A project 3MF with every part assigned to a
filament slot, so it **opens ready to slice**." The colour-change target's own
note ("Approximate: one nozzle, colour changes at the height bands the geometry
allows") and the `custom_gcode_per_layer.xml` it writes are accurate and were
left alone: that target really does emit per-layer change commands.

Not touched, per the brief: the compact format selector next to Export.
`ExportMenu.tsx` and `OutputPanel.tsx` changed in strings and identifiers only.

## 6. Verification

| Check | Result |
|---|---|
| `npm run lint` (`eslint . --max-warnings 0`) | clean |
| `npm run typecheck` (`tsc --noEmit`) | clean |
| `npm test` (vitest) | 78 files, 1421 tests, 1421 passed, 0 skipped |
| `npm run build` (`next build`, static export) | 6/6 static pages, 2/2 exported, exit 0 |
| `sh scripts/gate-web-engine.sh make` | both files ALL CHECKS PASS (single and parts) via the renamed `export:cli` |
| `make help` / `make bake-fixture COLOR=bogus` | help lists `export-fixture` and the alias; the alias prints the notice and forwards |
| Playwright, `E2E_BUDGET_FACTOR=3`, all 10 specs | 50 expected, 50 passed, 0 skipped, 0 flaky (10.6 min) |

The gate-web-engine run is the proof the renamed CLI still produces validated
files: `npm run export:cli` wrote `artifacts/chicago-web-single.3mf` and
`artifacts/chicago-web-parts.3mf`, and `make validate` read ALL CHECKS PASS on
both, including the `bodies`, `part_meshes`, `3mf_*` and `attribution` rows.

No test, threshold or assertion was weakened, skipped or deleted anywhere in
this task. Three assertions changed the string they compare against because the
string itself is what the task renamed (`smoke.spec.ts` button text,
`ui.spec.ts` empty-viewport copy and keyboard hint, `warnings.test.ts` block
reason); each still asserts exactly what it asserted before.

The first full Playwright run caught one assertion the string grep had missed:
`ui.spec.ts:978` asserted the empty viewport contains `G generate`, which the
keyboard hint no longer says. It now asserts `G preview`, and the re-run is the
50/50 above.

## 7. Files renamed on disk

```
apps/web/lib/bake.ts        -> apps/web/lib/exportFlow.ts
apps/web/lib/bake.test.ts   -> apps/web/lib/exportFlow.test.ts
apps/web/scripts/bake-cli.ts -> apps/web/scripts/export-cli.ts
```

143 files changed in `apps/web` plus `Makefile`, `scripts/gate-web-engine.sh`,
`.github/workflows/ci.yml`, `README.md`, `RUNBOOK.md`, `CONTRIBUTING.md`,
`CHANGELOG.md`, `LICENSE_AND_ATTRIBUTION.md`, `docs/ARCHITECTURE.md` and the
six `.claude/agents/*.md`.

## 8. Three accuracy fixes made while in the same strings

- `EXPORT_STALE_NOTE` and the over-height badge were rewritten without the em
  dash the originals carried, since both sentences were being reworded anyway:
  "Parameters changed since this export. Export again to download a matching
  file." and "Over the N mm printer height ceiling. The build will refuse this."
- `groups/LocationGroup.tsx`'s rotation hint still said the rotation crop was
  "Server-side, so it refetches on release". There has been no server since v3.
  It now says "Releasing the slider refetches from OpenStreetMap and previews
  again", which is what the `onCommit` handler actually does.

## Orchestrator note on commit 511f3ea (2026-09-02)

The rename agent's claim above that CLAUDE.md and the v3-0x handoff notes were
left untouched is true of the agent's own edits. The commit that carries them,
511f3ea, also carries two orchestrator edits made in the same wave: CLAUDE.md
gained the make-target rename and the vocabulary rule (the orchestrator owns
that file), and docs/handoff/v3-00-baseline.md was reconciled per findings 1
and 10 to 13 of v3-00-baseline-audit.md. The audit of this commit
(v3-03-vocabulary-audit.md) records the discrepancy; its two majors are fixed
in the next commit (advisor.ts aria-label, perf.ts script name).
