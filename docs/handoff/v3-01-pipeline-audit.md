# v3-01 pipeline audit (Task 1 core, commit adc99e9)

Adversarial read-only audit of `apps/web/lib/engine/**` as of `adc99e9`
("Task 1: one incremental pipeline in the worker"), run against a detached
worktree of that commit and a second worktree of `511f3ea` for the export
comparison. Nothing in the repo was modified; every probe is a vite-node
script under the session scratchpad
(`scratchpad/pipe/apps/web/scripts/audit/*.ts`, the export comparer at
`scratchpad/audit-fable/compare-exports.py`). Commands below run from
`apps/web` of the adc99e9 worktree after `npm ci`.

Severity scale: blocker (an invariant from the brief is violated with a
user-visible symptom), major (a defect that will bite once the next wave wires
the feature, or a design promise the code does not keep), minor (a real defect
with a small blast radius), note (measured facts worth keeping).

Counts: 2 blocker, 5 major, 9 minor, 9 note.

## Findings

### 1. Blocker: content digests ignore a stage's channels, so `audit` and `export` serve stale findings after a data-only stage changes only what it reported

`runner.ts:311-317` (`digestOf`) hashes `output` alone; `runner.ts:730` calls
it with the stage's output and owned handles; `cache.ts:34-41` documents the
rule. A stage whose output holds no WASM handle and is plain data gets a
content digest, and its consumers stay cached when that digest is unchanged.
But `findings`, `resolvedText` and `markBands` live in the entry's `channels`
(`cache.ts:25-29`), not in the output, so a re-run that produces the same
output with different findings leaves every consumer cached. `audit` reads
every channel through `ctx.findingsBefore()` (`stages.ts:1145`,
`result.ts:32-44`), yet its key covers only its declared inputs
(`stages.ts:1095-1109`), none of which is `lettering`, `ornaments`,
`hangers`, `attribution` or the surface stages except through `merged`. When
`lettering` has no cutters at all (frame off, or every line refused) it is
exactly such a data-only stage.

Symptom, reproduced on the Chicago fixture: with the frame off and an
underside line the plate refuses, changing the text from `XXXX...` to
`YYYY...` re-runs only `lettering`; `result.findings[0].title` still quotes
`XXXX...` and its detail still says `0.63 mm` where a cold build says
`0.64 mm`. On the block test scene the warm result has 5 findings where the
cold one has 6, the export stage is served from the cache and the sidecar's
`findings` and `resolved_text` are the previous parameter set's.

Prove it:

```
npx vite-node scripts/audit/stale2.ts     # Chicago, frame off, refused underside X -> Y
npx vite-node scripts/audit/alias.ts      # block scene; steps "C" and "A again 2" print BAD
```

Smallest correct fix: hash the channels with the output.
`digestOf(key, { output, channels }, owned)` in `runner.ts:730`, with
`stableJson` of that pair in `runner.ts:314`. Channels are always plain data,
so every existing content-digest optimisation survives and a finding change
propagates through `assembly` and `merged` to `audit` and `export` exactly as
a cutter change does. Then add a warm-versus-cold equality assertion to
`incremental.test.ts` for a lettering change with the frame off (finding 10).

### 2. Blocker: the main-thread region map can keep a dead region after a superseded run

`runner.ts:599-603` computes `removed` from the keys of `job.known` only;
`region-ready` events carry no hash (`runner.ts:580-588`), so a consumer
learns a region's hash only from `done` (`runner.ts:759`). A run that streams
a new region and is then superseded before `done` (the normal case under the
80 ms debounce) leaves the page holding a mesh with no hash; the next run
cannot list it in `known`, so a region that has since disappeared is never
reported removed.

Reproduced: gradient on, run cancelled at `merged` after
`buildings_band_2` streamed; gradient off; the client map still holds
`buildings_band_2` while the result has six regions. The preview would draw
the old band on top of the new buildings, which breaks "the preview renders
the actual solids the pipeline produced".

```
npx vite-node scripts/audit/stale.ts      # scenario 2 prints "DEAD REGION KEPT: buildings_band_2"
```

Smallest correct fix: in `removedRegions()` report every `REGION_NAMES` entry
whose finish output is null or absent, not only those in `known` (a superset
is harmless: the consumer deletes what it does not hold). Cleaner: put the
finish key on each `RegionMesh` in `region-ready` so the page's map is always
hash-complete. The compat `EngineClient.runBuild` is immune because it starts
from an empty map per build (`client.ts:617-621`); the `PipelineClient` flow
the next wave adopts is not.

### 3. Major: an export supersedes the run in flight, the run's result is lost, and the worker re-posts every region to nobody

`client.ts:326-335` (`exportFiles`) calls `supersede()`
(`client.ts:374-389`), which rejects the pending run's `done` as cancelled and
posts a cancel. The worker stops the run at the next boundary and starts the
export job with the cancelled run's params (`protocol.ts:304-318`), so the
files are current, but the page never receives that run's `done`: no
findings, no stats, no region hashes for the state on screen. The export job
also carries `known: {}` (`protocol.ts:316`), so `noteFinished`
(`runner.ts:589-598`) copies and posts every finished region and `done`
copies and transfers the merged mesh; the client drops both because no run is
pending for that id (`client.ts:420`). Measured on Chicago: 3295 KiB of
regions plus 2323 KiB of merged mesh per export, all discarded, and the
file bytes themselves are structured-cloned rather than transferred (finding
5).

```
npx vite-node scripts/audit/cancel.ts     # scenario A: run(TWO).done rejected, export ok, 6 regions posted
npx vite-node scripts/audit/transfer.ts   # "export generic-3mf" rows
```

Fix: queue an export behind a pending run instead of superseding it (the
session already serialises jobs; the client only needs to not reject the run),
or resolve the run's `done` from the export job's `done` event. In the runner,
skip `noteFinished` and the merged copy when `job.mode === "export"`.

### 4. Major: `done` re-sends the 2.2 MB merged mesh every run, and with tiling on structured-clones 5.9 MB of tile meshes every run

`runner.ts:754-759` copies and transfers `result.merged` on every `done`,
including a run in which every stage was cached ("same params again":
2197 KiB transferred, 0 stages ran). `assembleResult` (`result.ts:152,176`)
puts `tiles` on the result whole; nothing strips or transfers them, so with
`tiling` on every `done` clones 5876 KiB (`tiles[].regions[].positions`,
`indices`, `tiles[].merged.*`), again even when nothing ran. The design's
"structured clones of large payloads are gone" holds for regions and the
scene request only.

```
npx vite-node scripts/audit/transfer.ts   # rows "same params again" and "tiled, same params again"
```

Fix: hash-gate `merged` like a region (`knownMergedHash` on the job, or
carry the merged key on `done` and post the mesh only when it changed), and
strip tile meshes from `done` (stream them like regions, or drop them from
the wire now that exports run in the worker). Add a transfer list to the
`files` event (`runner.ts:765`): the design ruling 6 and the note's section
10 both say the bytes are transferred; they are cloned (1103 KiB for a
generic 3MF, 1445 KiB for the STL zip).

### 5. Major: the compat build never passes `knownSceneHash`, so the worker echoes the 1.2 MB scene back on every build

`client.ts:601-610` (`runBuild`) posts `mode: "full"` with a `cached` source
and no `knownSceneHash`; `runner.ts:653` and `:684` then emit `scene-ready`
with the whole scene because `job.knownSceneHash !== key`. The request is 40
bytes as the note says; the response is the scene, structured-cloned, on
every slider settle. Measured: 1183 KiB of JSON on the wire per warm run,
all of it the scene.

Fix: `knownSceneHash: this.lastScene?.hash ?? null` in `runBuild`, and for a
`scene` source the seed key (`hashParts(["normalise", "seed", key])`, which
`runner.ts:657` computes; expose it or compute it client-side).

### 6. Major: nothing refuses an export whose validator failed

The export stage (`stages.ts:1165-1221`) writes files whatever `validate`
returned; `exportForTarget` has no gate; the only UI gate is
`exportBlockReason` (`store/editor.ts:1032`, `lib/warnings.ts:367-374`),
which reads scene-level warnings (too few buildings) and never the engine's
findings. `StatsCard.tsx:53-55` computes `isManifold` for display only. This
predates the pipeline (511f3ea has the same gate), but the brief's "a failing
export ships nothing" and 04 stage 4's "on failure, do not silently ship"
are not met, and the worker's export stage is now the one place that could
meet them for every caller.

Fix: the export stage throws (an `error` event, no `files`) when
`ctx.input("validate")` carries an `error` severity finding unless
`ExportRequest.force` is set; the CLI passes `force` after printing the
finding.

### 7. Major: the export stage's key does not cover the parameter echo the file embeds

`runner.ts:517-520` (`assembled()`) calls `assembleResult(cache, job.params)`
with the raw params, and `result.ts:101-124` spreads every leaf into
`result.params`, which every writer persists (`print_params` in the sidecar,
provenance in the 3MF). The export key hashes nine claimed leaves plus the
request and input digests (`stages.ts:1168-1170`). The graph test pins that
every claimant is upstream of export, which covers claimed leaves, but the
eight unclaimed ones (`part_colors.*`, `colour.region_colors.attribution`)
and any future unclaimed leaf go stale in the file whenever the export is
served from the cache. Today `createdIso` differs per request so the export
rarely caches in the app; the alias probe shows the cached path is reachable
(finding 1's step C served a cached export). The strict-claims proxy cannot
see these reads because they go through the raw object.

Fix: add an `export` extra `params-echo` hashed as `stableJson(job.params)`
(`runner.ts:191-240`), so the key changes whenever the persisted echo would.

### 8. Minor: `hash.ts` contains raw NUL and 0x01 bytes, so git treats the file as binary

`hash.ts:20`, `:21`, `:27` return strings beginning with a literal U+0000
and `hash.ts:48` joins parts with a literal U+0001. Sound as sentinels, but
`git diff`, code review and `git show` render the file as `Bin 0 -> 2013
bytes`, and an editor or formatter that normalises control characters would
silently change every cache key. Fix: spell the two sentinels as the
JavaScript escape sequences (backslash u 0000 and backslash u 0001) in the
source instead of the raw bytes.

### 9. Minor: the supersede test dropped its latency bound

`511f3ea:apps/web/lib/engine/client.supersede.test.ts:122` asserted an ingest
requested during a slow build resolves within 1 s. The rewritten test (adc99e9
`client.supersede.test.ts`) asserts only that it resolves. The cancel latency
is now the longest stage (`merged`, 2.2 to 3.3 s on Chicago), which the design
accepts until Task 7, but no test pins the new ceiling. Fix: assert cancel
latency on the block scene against a stated budget, or assert the cancelled
job's `atStage` is the stage after the abort.

### 10. Minor: the new tests would not catch finding 1 or the tile payloads

`incremental.test.ts:97-103` asserts stage states only and never compares a
warm result with a cold one; `parity.test.ts:43-57` compares regions, merged,
findings, resolved text, bands, params and stats but not `tiles`,
`buildingTints` or `buildingBands`, and both sequences keep the frame on, so
`lettering` always owns handles and the data-only path is never exercised.
Fix: a canonical deep-equality of the whole `EngineResult` (typed arrays
hashed, `elapsedMs` dropped) after every step of an aliasing sequence, as in
`scripts/audit/alias.ts`, including a frame-off refused-text step and a
tiling on and off step.

### 11. Minor: the strict-claims test never runs the export stage or the Chicago fixture

`graph.test.ts:206-216` runs `buildModel` (mode `full`) on the synthetic
scenes; the export stage's claims are unverified by CI. My sweep of 94 runs
(four scenes, thirteen parameter variants, every export target in export
mode, the Chicago fixture) found no undeclared read and no read outside the
proxy other than finding 7's echo, so the registry is honest today, but the
guarantee rests on a scratch script. Fix: one export-mode strict run per
target in `graph.test.ts`. The sweep also lists claims never read
(`islands`: 18 `frame_style.*` leaves plus `frame` and `hanger`, bands 3 to 8,
`finish-easel`/`finish-cleat` colours, `bridges`: two rail leaves,
`frame-cutters`: `hanger_magnet.count`, `export`: `export_target`); the
design's "no more" rule has no test.

### 12. Minor: the stage table hides the digest cost

`runner.ts:716` takes `elapsedMs` before `collectHandles`, `digestOf`, the
part digests and `cache.set` (`runner.ts:717-736`), and `report("done")`
comes after them (`runner.ts:737`). Measured on Chicago with a keyhole and an
underside line: `attribution` reports 85 to 104 ms while the wall time
between its `start` and `done` events is 99 to 124 ms; every other stage is
within 3 ms. Fix: measure after `cache.set`, or record a `digest.<stage>`
perf row.

### 13. Minor: a cancel inside the region phase drops the unflushed batch

`runner.ts:622-625` returns on abort without `flushRegions()`, so finished
regions inside the current 50 ms window never reach the page; the successor
run resends them (its `known` lacks their hash), so this costs one extra copy
per superseded run rather than correctness. Fix: flush pending regions before
emitting `cancelled`.

### 14. Minor: an export after a scene-only run uses the ingest's params

`protocol.ts:283-290` records `this.last` for every run mode, including
`scene`; `EngineClient.ingest` (`client.ts:537`) sends `{}` when called
without params. An `exportFiles` between an ingest and a build would run the
whole pipeline with empty params and fail in `context`. The store passes its
params to ingest (`store/editor.ts:991`), so this is unreachable today. Fix:
record `last` only for `preview` and `full` runs and reject the export
otherwise.

### 15. Minor: `sceneKeyOf` is duplicated

`client.ts:651-653` and `engine.ts:71-73` are the same function. Keep one.

### 16. Minor: STL normals differ from 511f3ea in the last float32 bit

The single STL and the base, frame and buildings parts differ in 728, 96, 2
and 6 entries. The vertex-triple sets are identical; the differences are the
face normals, recomputed from a rotated vertex order, with a maximum
component delta of 4.5e-15 and no sign flip. Explained by [V3.1-P1-6]; every
3MF object, the OBJ face set and the STEP point set are the same set as at
511f3ea (section "Export matrix" below).

## Notes

17. Findings order against 511f3ea: `reportUnbuiltFrameStyle` moved from the
    context step to the `frame` stage and `reportRoadModeConflict` to
    `surface-roads`, so within one severity band the order can differ from the
    old traversal for a scene that raises both a frame-style and a road-mode
    or terrain finding. The Chicago default sidecar's findings are identical.
    Warm and cold agree with each other in every probe.
18. The lazy base carve is evaluated once per handle: a probe boolean costs
    99 ms on the first `boundingBox()` and 0.1 ms on the second, and a
    derived `translate` reuses it. `sit`'s 280 to 330 ms is paid once;
    `finish-base`'s cost is its own `decompose()`.
19. `canonicalMesh` runs only inside `toRegionMesh` (a finish or merged
    re-run) and inside `solidsDigest` on the cutters of a stage that re-ran;
    the latter is the hidden cost in finding 12.
20. No worker restart exists after an unrecoverable WASM abort (neither did
    at 511f3ea); a stage that throws is recovered (probe E: handles 30 before,
    30 after, the next run served 69 stages from the cache).
21. A `cached` scene key the worker does not hold produces the
    `sceneNotCached` error and `EngineClient` resends the scene; a `known`
    hash the cache does not hold is simply re-posted; a ghost region name in
    `known` is reported removed.
22. `date` is stamped per run by the client and the store, so a run after
    midnight re-runs `tokens`, `lettering`, `attribution` and, through the
    `attribution#base` digest, the base carve; an export uses the last run's
    date, which matches the preview. The SceneRequest rotation reaches
    `lettering` as the `rotation` extra; no other stage reads it.
23. `stableJson` aliases `-0` with `0` and a `Map` or `Set` with `{}`; params
    are JSON and `isPlainData` refuses class instances for output digests, so
    neither reaches a key. `hashParts` uses a real separator (0x01).
24. The one-generation bound is measured on JS handles only; a cached lazy
    `base` keeps its old cutters' C++ nodes alive until it is evaluated or
    replaced. Not measured here; the JS counts were flat in every probe.
25. At adc99e9 the app still exports on the main thread from the store's
    result (`lib/exportFlow.ts:138`); the worker export stage is unused by the
    UI until the integration wave.

## Timings (Chicago fixture, Node, this host, nothing else running)

Cold per-stage table from `FRAMECRAFT_PERF=1 npm run export:cli`, beside the
note's section 4:

| stage | note | measured |
|---|---|---|
| repair-buildings | 117 | 99 |
| surface-roads | 620 | 551 |
| surface-parks | 206 | 160 |
| attribution | 102 | 93 |
| sit | 330 | 280 |
| finish-base | 369 | 332 |
| finish-buildings | 305 | 216 |
| finish-roads | 280 | 199 |
| assembly | 725 | 639 |
| merged | 3205 | 2826 |
| to `done` | 7.0 s | 6.2 s |

Warm, one change from the default with one frame-edge `{city}` line, cache
reset to that state before each row (`scripts/audit/warm.ts`):

| change | note preview / done | measured preview / done |
|---|---|---|
| `engravings[0].text` | 118 ms / 4.6 s | 202 ms / 4.6 s |
| `north_arrow.enabled` | 75 ms / 4.6 s | 83 ms / 4.3 s |
| `frame_style.profile` plain to chamfer | 355 ms / 5.0 s | 344 ms / 5.0 s |
| `colour.region_colors.buildings` | 312 ms / 4.7 s | 324 ms / 4.3 s |
| `hanger` none to keyhole | 210 ms / 4.7 s | 170 ms / 4.1 s |
| `road_mode` | 2053 ms / 6.6 s | 1598 ms / 4.8 s |
| `plate_mm` | 2937 ms / 5.3 s | 2191 ms / 4.0 s |
| `heights.floor_height_m` | 3983 ms / 10.3 s | not reproduced (Overpass path) |

The stages that re-ran per row match the note's lists. The note's numbers are
honest; `merged` dominates every "to done" figure as stated.

## Export matrix (511f3ea against adc99e9, default params, CLI)

Seven targets plus `--tiling 2x2` for Bambu and STL. Every 3MF object
(generic, Bambu, colour-change, all four tiles) has the same triangle set and
vertex count; the OBJ face set, the STEP entity counts and point set, the
Bambu config parts, the colour-change layer file and CREDITS.txt are
identical. Differences: `framecraft:generated` timestamps, the one ruled
`framecraft:palette` entry, the sidecar's `colour_palette`, `preview_theme`
and `schema_version`, and the STL normal bits of finding 16.

## What passed

Vitest for `lib/engine/pipeline`, `protocol*.test.ts`, `client*.test.ts`:
46 tests green in the worktree. The strict-claims sweep: no undeclared read
in 94 runs. Hash keys: no practical alias (`scripts/audit/hashprobe.ts`).
Cancellation: cooperative at boundaries, completed outputs kept, an abort
inside `fetch` reported as cancelled, no handle leak on a stage error.
Attribution: the provenance metadata and the mark geometry are byte-for-byte
what 511f3ea wrote; `attributionBands` and `recessBands` agree warm and cold
in every probe. The aliasing sequence (engravings with equal cutter digests,
frame on and off with a profile change, gradient bands appearing and
vanishing, tiling toggled, terrain grid present and absent, heroes appearing)
matched a cold build byte for byte in 22 of 24 steps; the two failures are
finding 1.

## Verdict

The core is well built: the registry is honest under the proxy, the keys are
sound, the cache never dangles a handle, cold and warm geometry agree, the
exports are the same triangles as before, and the timings in the note are
real. It is not shippable as the product's incremental engine until finding 1
is fixed, because a warm run can present findings and a sidecar that describe
the previous parameter set, and finding 2 lets the preview keep a solid the
model no longer has. Both fixes are a few lines in `runner.ts`. Findings 3
to 5 are what the integration wave will hit first: the export path fights the
run it needs, and the worker still moves the scene, the merged mesh and the
tiles across the boundary on every settle. Finding 6 is the one spec
invariant neither this commit nor its parent meets.

## Fixes (pipeline agent, 2026-09-02, in `lib/engine/**` and `scripts/export-cli.ts` only)

Every wire and client change is additive: new optional fields, no renamed
event, no removed field. Line numbers are as of this edit.

| Finding | Fix | Test (fails before, passes after) |
| --- | --- | --- |
| 1 (blocker) | `pipeline/runner.ts:346-349` `digestOf` hashes `stableJson({ output, channels })`, so a stage's findings, resolved text and mark bands are part of the digest every downstream key hashes. | `pipeline/incremental.test.ts:359` "audit finding 1": frame off, refused underside X then Y, warm `resolvedText`, `findings`, `params` equal the cold build; and the aliasing sequence (A, B, A, AAAA, BBBB, refused, A, frame off, chamfer, gradient on and off, tiling on and off) compared whole-result by `pipeline/testCompare.ts` `canonical`/`diffCanonical` (typed arrays hashed, `elapsedMs` dropped): the port of `scripts/audit/alias.ts`. |
| 2 (blocker) | `pipeline/runner.ts:637` records each finished region's key; `region-ready` carries `hashes` (`runner.ts:628`), and `runner.ts:647` `removedRegions` names every region whose cache entry is missing or null, not only the ones in `known`, so a region streamed by a superseded run and gone from the next model is reported `removed`. `client.ts:214` `RegionsEvent.hashes`. | `pipeline/incremental.test.ts:426` "audit finding 2" (worker side, port of `stale.ts`/`stale2.ts`) and `client.test.ts:457` "a region streamed by a cancelled run ... is deleted from a map driven by the client's events" (client side). |
| 3 (major) | `protocol.ts:245`: an export queued behind a run no longer aborts it; the run posts `done`, then the export runs on the settled cache. Export mode streams no `region-ready` (`runner.ts:614,662`), posts `done` with `result: null` (`runner.ts:812-823`), and the file bytes are copied then transferred (`runner.ts:830-831`). `client.ts:355,410` `exportFiles` supersedes only an earlier export. | `protocol.test.ts:166` "PipelineSession: exports (audit finding 3)"; `client.test.ts:404` "exportFiles during a run does not supersede it". |
| 4 (major) | `done` carries `mergedHash` and `tilesHash` (`runner.ts:823`); the run message takes optional `knownMergedHash`/`knownTilesHash` (`protocol.ts:82-83`); the worker strips the merged mesh and the tile meshes when the hash matches (`runner.ts:817-819`, `pipeline/result.ts:135,140`); `client.ts:287,333,526` keeps the last copies and re-attaches them. | `pipeline/incremental.test.ts:498` "audit finding 4"; `client.test.ts:429` "a second run of the same params gets the merged mesh and the tile meshes back". |
| 5 (major) | `client.ts:673`: the compat build passes `knownSceneHash` (`seedSceneHash(sceneKey)` from `runner.ts:278` for a fresh scene, the cached hash for a cached one), so the worker never echoes the scene. | `client.test.ts:447` "the compat build tells the worker which scene it holds". |
| 6 (major) | `export/gate.ts` (new): `STAGE_4_FINDING_IDS`, `blockingFindings`, `ExportBlockedError`; `pipeline/stages.ts:1170-1179` export declares `validate` as an input and throws unless `exportRequest.force`; `runner.ts:568` maps it to `detail.blocking`; `scripts/export-cli.ts:28,117,235` refuses with exit 1 unless `--force`. Ruling text for DECISIONS below. | `pipeline/exportGate.test.ts` (new). |
| 7 (major) | `pipeline/stages.ts:1172` export claims the `params-echo` extra; `runner.ts:252,272` hashes the whole `PrintParams` into the export key and hands the stage the echo it embeds. | `pipeline/incremental.test.ts:477` "audit finding 7" (`part_colors.base` re-runs `export` only, sidecar echoes it). |
| 8 (minor) | `pipeline/hash.ts:20,21,27,48`: the sentinels are ` `/`` escapes; the file is text again. | `pipeline/hash.test.ts` unchanged (keys are byte-identical). |
| 9 (minor) | `client.supersede.test.ts:113` "cancel latency (audit finding 9)": an ingest during a block-scene build resolves within 3000 ms and the build rejects `cancelled`. | itself |
| 10 (minor) | Whole-result canonical comparison after every step of an aliasing sequence, frame-off refused step and tiling on/off included: `pipeline/testCompare.ts`, `pipeline/incremental.test.ts:359`. | itself |
| 11 (minor) | `pipeline/graph.test.ts:221` one export-mode strict run per `EXPORT_TARGETS` entry, and a strict `buildModel` of the Chicago fixture. | itself |
| 12 (minor) | `runner.ts:790`: `elapsedMs` is taken after `collectHandles`, the digests and `cache.set`, so the stage table includes the digest cost. | `pipeline/graph.test.ts` progress test (stage `elapsedMs` covers the whole stage). |
| 13 (minor) | `runner.ts:673,759`: `flushRegions()` before either `cancelled` emit. | `pipeline/incremental.test.ts:426` (the cancelled run's bands reach the map). |
| 14 (minor) | `protocol.ts:291`: `last` is recorded only for `preview` and `full`; an export with nothing built is refused with "nothing to export" (`protocol.ts:316`). | `protocol.test.ts:212` "an export before any model was built is refused". |
| 15 (minor) | `client.ts:35` imports `sceneKeyOf` from `engine.ts`; the copy is gone. | typecheck |
| 16 (minor) | No change: explained by [V3.1-P1-6]. | `export/*.test.ts` unchanged. |

Ruling text for DECISIONS.md (the orchestrator appends):

- [V3.1-P1-13] A failing export ships nothing. The export stage reads
  `validate`'s findings and refuses, by finding id, when any Stage 4 row
  (`not-manifold`, `floating-island`, `exceeds-plate`, `exceeds-height`,
  `wall-too-thin`) is at `error`; the refusal is a `PipelineStageError` at
  stage `export` whose `detail.blocking` lists the findings, and no `files`
  event is posted. `ExportRequest.force` (CLI `--force`) writes the files
  anyway for debugging, with the findings still in the sidecar. Warnings never
  block.

API additions for the integration wave (all optional, all backward compatible):

- `RegionsEvent.hashes` (worker `region-ready.hashes`): the hash of every
  region in the batch; keep them and pass them back as `known`.
- `RegionsEvent.removed` is a superset now: every region streamed earlier that
  the model no longer has, whether or not the caller named it in `known`.
- `RunDone.mergedHash` / `RunDone.tilesHash` (worker `done.mergedHash`,
  `done.tilesHash`); `RunInput.knownMergedHash` / `knownTilesHash` (run
  message `knownMergedHash`/`knownTilesHash`). `PipelineClient.run` fills them
  from its own last copies and re-attaches the meshes when the worker strips
  them, so a caller that uses the client sees whole meshes and pays no copy.
- `ExportRequest.force`; an export refused by the gate rejects with a
  `PipelineStageError` at stage `export` and `detail.blocking`.
- `exportFiles` no longer supersedes a run in flight: it waits for the run's
  `done`, streams no regions, posts `done` with `result: null`, and its file
  bytes are transferred.
- `seedSceneHash(key)` is exported from `lib/engine/pipeline` for callers that
  hand a fresh scene to the worker and want the scene hash it will get back.
