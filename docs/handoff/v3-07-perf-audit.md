# v3-07 perf audit (Task 7 close-out: part digests and the projection cache)

Adversarial audit of `docs/handoff/v3-07-perf.md` section 8,
`v3-01-pipeline.md` 3.9 and `DECISIONS.md` `[V3.1-P7-13]`, against the code
in `apps/web/lib/engine/pipeline/{stages,runner}.ts` and
`apps/web/lib/engine/osm/{normalize,scene}.ts`. Tree `7d02e0e` (the wave
checkpoint that carries the change; `af02c98` is the tree before it).
Nothing was fixed, nothing committed, no test or threshold touched. The
scratch harness (`apps/web/scripts/_audit-t7-harness.ts`, deleted after the
run) built the Chicago Overpass path through `fetchImpl` on one `StageCache`,
`regionBatchMs: 0`, defaults plus one frame-edge `{city}` line, and timed each
change to the end of the region phase and to `done`, exactly as the note's
harness did.

Suites run on this tree: `incremental`, `normalize`, `graph`, `parity` 47/47
green; `matrix` 143/144 (finding 5); `next.config.test.ts` 5/5 green and
3/5 red on a mutant (finding 8).

## Findings

### 1. MEDIUM. The target is met only while no override owns a surface; one road override puts `heights.floor_height_m` back at 2.7 s

**Evidence.** Harness, same cache, same change (`floor_height_m` 3 to 4 and
back), three shapes:

| params | to region phase | to done | stages run / cached |
|---|---:|---:|---|
| defaults + `{city}` | 253, 247, 223, 252, 232 ms | 2295 to 2382 | 41 / 39 |
| + one BUILDING override (`color`) | 210, 207 ms | 2114, 2244 | 41 / 39 |
| + one ROAD override (`color`) | **2674, 2675 ms** | 4875, 4828 | **57 / 23** |

With the road override the run list is the pre-change list: `surface-water`,
`surface-rail`, `surface-roads`, `surface-parks`, `trees`, `base`,
`region-base`, `sit`, `finish-base`, `region-roads`, `finish-roads`,
`region-water`, `finish-water`, `region-parks`, `finish-parks` all re-run on
a change that moved no ground.

**Cause.** `surface-overrides` is keyed on the whole scene
(`stages.ts:663-689`, `inputs: ["normalise", ...]` with no `inputDigests`),
because `reportOverrides` calls `reconcileOverrides(ctx.scene, ...)`, which
walks `scene.buildings`. With no override, or a building-only override, its
output is `{ surfaces: [], unbuilt: [] }`, plain data, so its content digest
is stable and nothing under it moves. With a road, water or green override
the output holds `RepairedSurface` records with `CrossSection` handles, so
`digestOf` returns the KEY (`runner.ts:346-351`), the key contains the whole
`normalise` digest, and every one of the six ground stages lists
`surface-overrides` as a whole-digest input (`stages.ts:719,730,749,766`),
so their keys move with it. `repairSurfaceLayer` also unions the override
sections in as blockers, so the dependency is real; only its granularity is
wrong.

The note (section 8, item 1) says the whole-scene key is deliberate and that
"with no overrides its output is plain data with a stable digest". It does
not say the target is missed with one. `[V3.1-P7-13]` says "All eight Task 7
targets are now met" without the qualification. Per-object overrides are a
shipped v3.1 feature (Task 11), and a user who has recoloured one road gets
the 2.7 s path on every storey-height change.

Not a correctness defect: the extra runs are cache misses, never stale
geometry. A fix (not applied) is to split the reporting, which needs the
buildings, from the surface building, which does not, and key the surface
half on `normalise#ground` and `repair-buildings#footprint` like its
consumers.

**Reproduce.** Any warm run on the Chicago Overpass path with
`object_overrides: [{ osm_id: <a road id>, layer: "road", color: "#00ff00" }]`,
then change `heights.floor_height_m`; read the stage events.

### 2. LOW. `[V3.1-P7-13]` and `[V3.1-P7-14]` contradict each other

P7-13: "All eight Task 7 targets are now met." P7-14, the next line: the
`road_mode` and `plate_mm` readings "are not trusted and must be taken again
on a quiet host" and read 2127-2822 and 3104-3228 ms today against a 2000 ms
target; "the re-measurement is a release gate item". Both cannot stand as
written; the note's own table (section 8, "see below") is the honest one.
`DECISIONS.md:908-930`.

### 3. LOW. The residual 30 ms in `normalise` is mis-attributed, and the same runner behaviour costs 116 ms on every cold Preview

The note says `normalise`'s remaining 30 ms "is the runner's own walk over
the 1.4 MB scene for handles and plain-data checks, not the ingest".
Measured (harness G, on the cached Chicago scene):

| runner step | ms | bytes serialised |
|---|---:|---:|
| `JSON.stringify(scene)` (what `digest.ground` costs, for scale) | 6 | 1 423 kB |
| `stableJson({ output: { scene }, channels })` in `digestOf` | **20** | 2 073 kB |
| `stableJson({ output: { raw, fromCache } })` in `digestOf` for `fetch` | **116** | 9 126 kB |

`digestOf` (`runner.ts:346-351`) serialises the whole output with sorted keys
and THEN compares the length against `DIGEST_LIMIT_CHARS` (256 000), so for
the scene and for the raw Overpass response the serialisation is done in
full and discarded every time the stage runs. That is 20 of the 33-44 ms the
stage reports per heights change (about a tenth of the 206 ms), and 116 ms
on every cold `fetch`. Pre-existing runner behaviour, not introduced by this
change; reported because the note's account of the number is wrong and the
cheap fix (a size pre-check, or a per-stage opt-out for outputs known to be
large) sits in the file this wave edited.

### 4. LOW. `repair-buildings#footprint` has no runtime guard, unlike `normalise#ground`

A stage keyed on `normalise#ground` reads the scene through `scenePartView`,
where every other layer throws. A stage keyed on `repair-buildings#footprint`
reads `ctx.input("repair-buildings")`, the whole `RepairedBuildings`
(`merged`, `dilated`, `heightFallbacks`, the blocks, the hero lists), with
nothing stopping it. Today all six read `.footprint` and nothing else
(`stages.ts:693, 790, 857, 871`; `buildSurfaceRegion`, `mergeRecessRidges`,
`buildBridges`, `buildTrees` take the section, not the record), so no
geometry is stale now. A future `.merged` read in any of them would be
served stale after a heights change, silently, which is exactly the failure
the scene view was built to turn into a thrown error. The note's "the digest
stays honest by construction" holds for one of the two parts.

### 5. LOW. The matrix suite is red on this tree (1 of 144), not because of this change, and the close-out does not say so

`matrix.test.ts` "the matrix covers every PrintParams leaf" fails: eleven
`object_overrides[].*` leaves have neither a probe nor an exemption.
`object_overrides` entered `packages/contracts/schema/print_params.json` in
the same checkpoint (0 mentions at `af02c98`, 3 at `7d02e0e`) and
`matrix.probes.ts` mentions it nowhere; that is the overrides wave's gap.
The 132 probes themselves pass, so "every probe in the matrix passes" (note
section 6) is true while `npx vitest run lib/engine/pipeline/matrix.test.ts`
is red. The matrix runs every probe warm on one shared cache per group
(`matrix.run.ts:MatrixGroup`), so it does exercise the part digests; it just
has no probe for the leaves that decide finding 1.

### 6. INFO. In the inline transport the page now shares the projection's arrays

`sceneFromProjected` returns the projection's own `roads`, `rail`, `water`,
`green`, `trees` arrays (`normalize.ts:1232-1236`, pinned by
`normalize.test.ts`). The worker path structured-clones the scene on
`scene-ready`, so the page never touches them. `InlineTransport`
(`client.ts:124-152`, the no-`Worker` fallback) hands the response object to
the store by reference, so there `state.scene.graph.roads` IS the array every
future `normalise` of that fetch will emit. No code mutates a scene layer in
place (searched `lib`, `store`, `components` for sort/push/splice/reverse and
field assignment on the five layers and their entries; `applyNameBudget`
mutates only objects the projection created, and before it returns). A
future in-place sort on the main thread would poison the projection without
a test noticing. Latent, not live.

### 7. INFO. `stagesInvalidatedBy` over-predicts

For `heights.floor_height_m` it names 78 stages; 41 run. It has no consumer
in the app (only tests, as an upper bound), so nothing shows wrong. The HUD
and the ETA read the plan events, not the predictor.

### 8. `next.config.test.ts` asserts what the note claims, and goes red without the hook

Green as committed: 5/5, two real production client builds of maplibre-gl,
three, @react-three/fiber and manifold-3d through Next's bundled webpack in
about 1 s of wall time. A mutant `next.config.ts` with the `emit: false` rule
and the `splitChunks` block removed and the `IgnorePlugin` kept: 3/5 red
(`vendor-maplibre.js` and `vendor-three.js` absent from the assets, one
`.wasm` emitted), the two survivors being the sanity checks that both builds
resolved every vendor. Deleting the hook outright makes `beforeAll` throw
("next.config.ts defines no webpack hook"), all red. The test matches the
v3-08 note's section 10.5 claim and section 3's chunk claim. No finding.

## What was attacked and held

**Part digest completeness.** Everything a ground stage reads, enumerated:
the scene through `ctx.scene`/`ctx.build.scene` (`areas.ts:187,193` water and
green; `roads.ts:92,139` roads; `roads.ts:59` rail; `trees.ts:86` trees;
`bounds` only through `context`'s numbers, `context.ts:159`), all inside
`SCENE_GROUND_LAYERS`; the repair's `.footprint` only (finding 4); params
through the claims; `surface-overrides`, `terrain`, `context` and the earlier
surface stages by whole digest. The override helpers on the ground path
(`hiddenOverrideIds`, `overrideGroups`, `baseOsmIdOfArea`) take `params`
only; `reconcileOverrides(scene, ...)` is called from `surface-overrides` and
`audit` alone. The scene has exactly two layers outside the part
(`buildings`, `stats`) and both throw through the view; the throwing getters
are non-enumerable, so a spread, `Object.keys` or `JSON.stringify` of the
view yields the ground layers and nothing else, and no ground callee spreads
the scene. The seeded-scene path stores the same part digests
(`runner.ts:777-778`). `context`'s digest is a content hash of numbers derived
from `bounds` and params, so it is stable across a heights change; the
harness confirms `terrain`, `lettering`, `attribution`, `base`, `sit` and
every ground finish cached. The old `mergeGroup`'s tallest-then-largest
tie-break (`af02c98` `normalize.ts:371-398`) is reproduced by `resolvePick`
over the same tree with the same outline areas, and `normalize.test.ts:31-33`
pins JSON equality with the one-pass normaliser at two rule sets.

**The projection cache.** `PROJECTED` is keyed on the `fetch` output object;
that object exists for exactly one fetch key, and the key is
`stableJson(request)` over every field of the `SceneRequest` (`runner.ts:216`),
so a preset change, a rotation change, a radius change and a re-fetch each
produce a new `FetchOut` and a new projection; eviction is the fetch entry
being dropped. `projectOverpass` reads `raw` and `request` only, no params
and no module state. What goes stale is nothing; what is shared is the
arrays (finding 6).

**The numbers.** Reproduced: 204-257 ms to the region phase and 2001-2382 to
`done` for `floor_height_m`, 41 run / 39 cached, in both harness shapes
(`known: {}` as the note's harness, and `known`/`knownSceneHash` carried
over as the app does; the second is 204-257 too). `normalise` 33-44 ms.
What the span does not include: the 1.4 MB `scene-ready` re-post on every
heights change (`structuredClone` of the scene is 10 ms on the worker side;
the main thread's deserialisation and the re-render of the fourteen
`scene.graph` consumers are not measured by anything in the repo, and no
e2e measures a heights change). The number is real for what it measures;
finding 1 is where it stops being representative.

**Invariants.** Strict claims: untouched, `ctx.params` is still the proxy
and the scene view is not a parameter read. Two-phase delivery and
cooperative cancellation: unchanged (`normalise` was synchronous before).
`PRINT_PARAM_LEAF_PATHS`: `graph.test.ts` green.

**Exports.** The strongest check available was run: a warm heights-change
export (`mode: "export"` after `floor_height_m` 3 to 4 on a warm cache, so
the ground, plate, seat and every ground finish came from the cache under
re-built buildings) against a cold export at the same params on a fresh
cache. The Bambu 3MF is byte-identical (1 911 864 B, sha1
`d6aca701edca448fcd5ac65cad124cd047e75910` both), and so is every region
mesh and the merged mesh. A cache that was then taken through a building
override, a road override (finding 1's shape) and back to no override at
floor 4 also returns every region and the merged mesh to the cold bytes
(`base 0afeade7`, `frame 8f70d8f2`, `buildings f896e6ac`, `roads 2f303a50`,
`water 6e858e88`, `parks b1e1ca2b`, `merged fee3a167`, 171 450 triangles),
and two cold builds agree with each other. Perf mode on or off makes no
difference to the bytes. So nothing the part digests served was stale in
any sequence tried, and a file exported from the warm cache is the file a
cold build writes.

`make validate` was also started on a warm heights-change export
(`scratchpad/audit-warm-heights.3mf`, 170 868 triangles, 780 bridge ways).
The reference validator had not produced a line after 25 minutes of wall
time at about three cores and a 20 to 28 GB working set, and this audit did
not wait for it. That is a validator cost on an Overpass-path export with
bridges, not a finding about this change; the byte identity above is the
evidence the invariant rests on here, and the gate's own validation runs on
the CLI's fixture-path export.

**A note on the tree.** Between the second and third harness runs, other
agents changed `solid/areas.ts`, `solid/repair.ts`, `solid/attribution.ts`,
`solid/manifold.ts` and the one `fittedSolid` call in `stages.ts`
(`deeperLayers`, a surface-trimming change; file mtimes 18:37 to 18:54,
uncommitted). That moved the Chicago region meshes by 582 triangles between
two runs of the same script, which looked like non-determinism until the
mtimes explained it. None of it touches the T7 code (`SCENE_GROUND_LAYERS`,
`GROUND_READS`, the two digests, `normalise`, `scenePartView`,
`projectOverpass`/`sceneFromProjected`). Every comparison in this file was
made within one process on one tree; the timings in finding 1 and the
reproduction table were taken on `7d02e0e` plus those edits.
