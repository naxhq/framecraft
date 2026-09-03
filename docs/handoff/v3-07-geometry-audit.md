# v3 Task 7 geometry: adversarial audit

2026-09-02. Read-only audit of the three fixes in `docs/handoff/v3-07-geometry.md`
against the working tree at `git diff f8d484e -- apps/web/lib/engine/solid/mesh.ts
apps/web/lib/engine/solid/tiling.ts apps/web/lib/engine/export/stl.ts
services/bake/app/export/stl.py` plus their tests. `solid/measure.ts` and
`solid/manifold.ts` are byte-unchanged against `f8d484e`; no threshold in either
moved.

**Verdict: the three defects are closed and the note's Chicago numbers all
reproduce exactly. The wave generalises from one plate, and the repair it added
is silent when it fails. Three findings are major, five minor, five notes. No
blocker.**

---

## What reproduces

Every number the note states about the default Chicago plate is exact.

| claim in the note | measured here |
|---|---|
| STL and 3MF both 46 962 v / 93 920 t | identical |
| repair report `1 split, 0 welds, 0 pinches, volume delta 1.19e-9 mm3` | `{"welded":0,"split":1,"degenerate":0,"openEdges":0,"volumeDeltaMm3":1.1932570487260818e-9,"applied":true}` |
| STL differs from the 3MF in exactly two triangles | 2, at (89.966694, 145.642858) z 2.800049 / 3.0 / 3.5, matched by exact vertex index, not by rounding |
| no vertex moves | 0 STL vertices sit further than half a float32 step from a 3MF vertex |
| the 3MF is unchanged | the `3D/3dmodel.model` entry of a pre-fix and a post-fix build differ on ONE line, `framecraft:generated` |
| 2x2 seam trim 2510.35 to 2516.77 mm3 | 2510.35 (worktree at `f8d484e`) to 2516.77 (working tree) |
| Paris 53 016 vertices preserved through the STL | 53 016 welded, `ALL CHECKS PASS` |

The float32 diagnosis itself is right and is worth keeping: on the same placed
Chicago mesh, `degenerate < 1e-9` counts 0 in double (the 3MF), 0 on the STEP
writer's 1e-6 grid, and 1 on float32. The grid really is a property of the
coordinate.

---

## Findings

### 1. major - `hardenForFloat32` is best effort, and it is silent. On the largest legal plate it spends 6.2 s and changes nothing

`apps/web/lib/engine/export/stl.ts:107-109` throws the report away
(`return hardenForFloat32(mesh).mesh;`). `apps/web/lib/engine/solid/mesh.ts:825-845`
returns the INPUT untouched with `applied: false` whenever no rung of the repair
strictly improves the count. Nothing between those two lines and the bytes on
disk ever asks whether the repair worked.

Measured on plate 256 mm, which is `contracts.PARAM_RANGES.plate_mm.max`, so a
first-class user setting and not an exotic one:

| | 3MF | STL |
|---|---|---|
| vertices / triangles | 83 186 / 166 368 | 83 186 / 166 368 |
| `degenerate_faces` row | **FAIL 6** | **FAIL 12** |
| triangles that differ between the two files | 0 | 0 |
| `hardenForFloat32` wall time | n/a | 6175 ms (median of 5) |
| report it produced | n/a | `{"mesh":{"welded":0,"split":0,"degenerate":71,"applied":false},"pinches":{"groups":0,"moved":0,"unresolved":0},"degenerate":12,"collisions":0}` |

The 6 double-precision degenerate faces on that plate are a documented known
limitation (`DECISIONS.md [V3-P7-A11]`, `[V3-P7-fix-6]`, which already records
that "`mesh.collapseNeedles` on the merged mesh was tried and did not clear it
... so `cleanMesh`'s acceptance test rejects the repair"). This wave reused the
same acceptance test in the STL writer and did not measure that plate. So this
is not a regression, the pre-fix STL carried 12 as well. It is that the fix
does nothing on the one plate that needs it, burns 6.2 s doing nothing, and says
nothing.

The silence is total because there is no engine-side rule for this row either:
`export/gate.ts:16-22` lists five blocking finding ids and `degenerate_faces` is
not among them, and `grep degenerate apps/web/lib/engine/audit/rules.ts` is
empty. `04_PRINTABILITY_SPEC.md:131` says "on failure, do not silently ship".

**How to prove it.** `npm run export:cli -- --scene fixtures/chicago-scene.json
--params <plate 256 params> --target stl` and the same with `generic-3mf`, then
`make validate` on each. Both write without a word; the STL row reads 12 and the
3MF row reads 6.

**Smallest correct fix.** Return `HardenReport` from `forStl` and raise it. At
minimum `hardenForFloat32` should be given a caller that reacts when
`report.degenerate > 0`, `report.collisions > 0` or
`report.pinches.unresolved > 0`: a `console.error` from `export-cli.ts` and a
field in the sidecar would already turn a silent 12 into a visible one. An
`AuditFinding` for the row, added to `STAGE_4_FINDING_IDS`, is the version that
matches what 04 asks for.

### 2. major - the STL writer got 1.15 s slower on the default plate, and the note's A/B measured a path that did not change

The note A/Bs a DRAPED engine build and concludes "this wave adds no measurable
cost to a bake". That is true and irrelevant: the engine path is unchanged by
construction (`cleanMesh`'s `float32` default is false), and every millisecond
this wave adds is in the exporter, which the A/B never ran.

Alternating A/B, three runs each, worktree at `f8d484e` against the working
tree, same fixture and parameters, `--target stl`, reading the CLI's own
`total` minus `engine`:

| | run 1 | run 2 | run 3 | median |
|---|---|---|---|---|
| pre-fix, post-engine seconds | 0.04 | 0.04 | 0.04 | **0.04** |
| post-fix, post-engine seconds | 1.29 | 1.17 | 1.15 | **1.17** |

Direct benchmark of the function on the placed merged mesh, median of five:

| | plate 180 | plate 256 |
|---|---|---|
| `hardenForFloat32` | 1235 ms | 6175 ms |
| of which `cleanMesh` with `float32` | 1084 ms | 5990 ms |
| `separateFloat32Pinches` alone | 32 ms | 61 ms |
| `float32DegenerateFaces`, discarded | 5 ms | 10 ms |
| `float32Collisions`, discarded | 25 ms | 50 ms |

`exportStlPartsZip` pays it per region: `stl.ts:147` calls `forStl` six times, and
the parts-zip run measured 1.66 s of post-engine time against the single body's
1.17 s.

This does not endanger `TERRAIN_TIME_BUDGET_MS`: `solid/engine.test.ts:500`
times `buildModel` and does not export. It is a user-facing export regression on
the interactive path, and it is 6.2 s at the top of the plate range.

Capping the weld ladder is NOT the fix on the default plate: measured, the full
ladder and a single 1e-6 rung both cost about 1000 ms, because the first rung
already clears the mesh and the loop breaks. The cost is the first `weld` itself,
a 27-cell neighbourhood scan over 46 962 vertices, run to weld nothing
(`welded: 0`). On plate 256 the ladder DOES cost, because no rung is ever
accepted and all three run.

**Smallest correct fix.** Probe before repairing. `float32DegenerateFaces(input,
REPAIR_AREA_MM2)` costs 5 to 10 ms and `float32Collisions` 25 to 50 ms; when both
are zero, `hardenForFloat32` can return the input and skip the whole ladder,
which is the common case for every tile and every parts-zip member. When the
repair does run, cap the ladder at one rung from `hardenForFloat32` so a plate the
repair cannot fix costs 2 s rather than 6.

### 3. major - the one repair that MOVES a vertex is the one with no acceptance test, in both languages

`cleanMesh` is a strict transaction: `mesh.ts:743-746` refuses any candidate that
adds a degenerate face, opens an edge, or moves the volume by more than
`max(1e-6 mm3, |V| * 1e-9)`, and `collapseNeedles` carries an extra
`componentCount` guard (`mesh.ts:811-816`, per `[V3-P7-A9]`). `hardenForFloat32`
then applies `separateFloat32Pinches` unconditionally at `mesh.ts:1031-1037`,
with no check and no rollback. `services/bake/app/export/stl.py:132-139` does the
same on the Python side.

Measured on three 10 mm cubes meeting on one vertical edge, which exercises the
3-member group path that no test in either language covers:

```
vertices 24, collisions 8, bodies 3
report {"groups":6,"moved":8,"unresolved":0,"maxShiftMm":1.52587890625e-5}
after: collisions 0, openEdges 0, bodies 3
volume 3000.000000 -> 2999.995931
```

The topology survives, which is the good news, and every shift is exactly one
float32 step. But the volume moved by **4.069e-3 mm3**, a relative 1.36e-6. The
acceptance test twenty lines above would have rejected that: its tolerance here
is `max(1e-6, 3000 * 1e-9)` = 3e-6 mm3, so the move is 1356 times the relative
bound the repairs beside it are held to. Nothing checks it, and nothing would
catch a worse case. On the real presets the effect is negligible, one vertex on
building-corner faces of order 1 mm2, about 1.5e-5 mm3, which is why the
validator's four significant figures show Paris unchanged at 1.228e+05.

The direction rule itself is sound. `mesh.ts:974-981` picks the dominant axis of
the inward area-weighted normal, so the step moves into the half-space by at
least `1/sqrt(3)` of its length and cannot cross the local tangent plane. It can
only escape through material thinner than one float32 step, 1.5e-5 mm on a
180 mm plate, which nothing printable is.

**Smallest correct fix.** After the separation, recompute the three invariants
`cleanMesh` already computes (`openEdges`, `meshVolumeMm3`, `float32DegenerateFaces`)
and fall back to the unseparated positions when any of them regresses. Mirror
the same three checks in `write_stl` before it rebuilds the `Trimesh`. Surface
`unresolved` either way: today a pinch the loop cannot place is written to the
file with no trace.

### 4. minor - `thinPart`'s surviving area floor cannot filter anything, so the comment overstates the safety net

`tiling.ts:1174-1186` removes the whole-component `SLIVER_MIN_AREA_MM2` floor and
says "the floor survives where it is cheap and cannot hide anything: on the GROWN
cutter below, and on the band-clipped result in `sliverCutter`". Both survivors
are applied AFTER `all.offset(SLIVER_GROW_MM, ...)` at `tiling.ts:1225`:
`tiling.ts:1227` and `tiling.ts:1038`. A 0.15 mm dilation turns a point into a
disc of 0.0707 mm2, which is 7.1 times the 0.01 mm2 floor. So a single speck of
2D boolean noise, of any area at all, now clears both survivors and becomes a
0.3 mm prism through the FULL HEIGHT of the tile. That is the same mechanism the
note itself blames for defect 2, where a band "14 mm up cuts a building in two",
and the fix increases how many prisms exist.

Empirically it is small and the fix is right. Seam trim, worktree at `f8d484e`
against the working tree:

| grid | pre-fix | post-fix | delta |
|---|---|---|---|
| 2x2 | 2510.35 mm3 | 2516.77 mm3 | +6.42, +0.26 % |
| 3x3 | 4864.52 mm3 | 4873.31 mm3 | +8.79, +0.18 % |

All four 2x2 tiles and all nine 3x3 tiles pass every validator row, so
`SLIVER_PASSES = 3` still converges at both grids.

The debris floor is safely below anything real. At 0.4 mm nozzle the minimum wall
is 0.8 mm and the estimate implies a 0.2 mm layer (174 layers over 34.733 mm), so
the smallest legitimate free-standing body is about `pi * 0.4^2 * 0.2` = 0.10 mm3.
`DEBRIS_MM3` at 0.01 mm3 is a tenth of that and the splinter it removed was
0.000458 mm3, a two-hundredth. Lettering counters and index marks are voids, not
bodies, so `pruneDebris` cannot reach them, and `sliverHeights` already skips
`ctx.markBands` for the sliver prism (`[V3-P7-A8]`).

**Smallest correct fix.** Correct the comment, or move one floor to where it can
act: test `all.area()` before the growth at `tiling.ts:1225` rather than
`grown.area()` after it.

### 5. minor - the tile debris sweep decomposes each solid twice, which the codebase already documents as worth avoiding

`tiling.ts:861` calls `pruneDebris`, which does one `decompose()`, and then
`toRegionMesh(swept, ..., undefined, ...)` calls `bodyCount(solid)`, which does
another. `manifold.ts:694-702` explains exactly this: "The finish of a region
needs both the debris-free solid and its body count, and each is a
`decompose()`; on a buildings region that is hundreds of bodies twice", and
`stages.ts:888` uses `pruneDebrisCounted` for that reason. A 3x3 grid pays the
extra decomposition 63 times.

The alternating A/B shows no regression today (2x2 pre 14.08 / 16.39 / 16.17 s
against post 12.92 / 15.78 / 16.46 s; 3x3 pre 21.15 / 21.56 / 20.70 s against
post 20.47 / 21.02 / 21.05 s), so this is cleanup rather than a defect.

**Smallest correct fix.** `sweepTileDebris` returns `pruneDebrisCounted`'s solid
and its `bodies.real`, and `buildTile` passes that count into `toRegionMesh`'s
existing `bodies` parameter.

### 6. minor - nothing pins the TS and Python mirror

`DECISIONS.md [V3.1-P7-3]` and both docstrings call the two implementations
mirrors. `fixtures/parity-expected.json` covers only `transform`, and there is no
cross-language fixture for the pinch. Each suite builds its own two-cube fixture
at the same coordinates and asserts magnitudes only: `mesh.test.ts:185-213`
checks `moved`, `maxShiftMm` and how many axes changed;
`test_bake.py:1249-1262` checks `count`, `max|delta|` and how many components
changed. Neither asserts WHICH vertex moved, on which axis, or with which sign.

They do agree today, verified by reading: both keep the lowest-index member of a
group (TS by insertion order at `mesh.ts:927-932` and `:970`, Python via
`np.unique(..., return_index=True)`), both take the first `argmax` of `|normal|`,
and both use `-normal[axis] >= 0 ? +1 : -1`. Nothing stops that from diverging.

**Smallest correct fix.** Assert the signed per-axis delta on a named vertex
index in both suites, so a change of direction rule breaks one of them.

### 7. minor - the export hardening runs the whole weld ladder, which the note does not mention and which has no body guard

`hardenForFloat32` calls `cleanMesh(input, { float32: true })` with no
`epsilonMm`, so `mesh.ts:759` runs the full `WELD_LADDER_MM` up to 1e-4 mm. At a
180 mm coordinate that rung merges vertices up to 6.5 float32 steps apart. The
note and `DECISIONS.md [V3.1-P7-1]` describe the repair only as a T-junction
split where "no vertex moves"; a weld does merge vertices, and the weld path has
no `componentCount` guard (only `collapseNeedles` does, `mesh.ts:811-816`). A
weld that turns one body into two is closed, oriented and volume-preserving, so
`acceptable()` passes it, and in an STL that new pinch is invisible until the
reader welds the file back.

Measured: `welded: 0` on both plate 180 and plate 256, so nothing fires today.

**Smallest correct fix.** Pass `epsilonMm: WELD_EPSILON_MM` from
`hardenForFloat32`, which also cuts the plate-256 cost by two thirds (finding 2),
or extend the body guard to the weld path.

### 8. minor - the STEP writer has the same class of grid, coarser than the 3MF, and gets no hardening

`export/step.ts:47` writes every `CARTESIAN_POINT` through `fmtNum(value, 6)`, a
1e-6 mm grid. Below 8.4 mm that is COARSER than float32; above it, finer. The
same placed meshes:

| grid | Chicago 180, degenerate < 1e-9 | Chicago 256 |
|---|---|---|
| double, 3MF at 12 decimals | 0 | 6 |
| STEP at 6 decimals | 0 | **12** |
| float32, STL | 1 | 12 |

So on plate 256 the STEP file loses exactly as many faces as the STL does and
gets none of the repair. It is indexed, so the pinch half cannot bite it; 0
vertices collide at 6 decimals on either plate. Nothing validates a `.step`
(`app/cli.py` accepts only `.3mf` and `.stl`), so this is unmeasured rather than
known-broken. The OBJ writes 12 decimals (`obj.ts:84`) and matches the 3MF
exactly, 0 on both plates.

### 9. note - the report is computed and discarded

`hardenForFloat32` recomputes `float32DegenerateFaces` and `float32Collisions`
after the repair (`mesh.ts:1043-1044`), which is two more full-mesh passes plus
a Set of 46 962 string keys, and `forStl` drops all of it. Measured cost 30 ms on
plate 180 and 60 ms on plate 256, per body, so six times over in the parts zip.
`separateFloat32Pinches` also builds a 46 962-key Map before it can discover
there is nothing to separate.

### 10. note - a dead guard in the Python implementation, at O(N) each

`services/bake/app/export/stl.py`, inside `separate_float32_pinches`:
`if len(np.nonzero(inverse == inverse[v])[0]) < 2: continue`. `keeps[v]` is False
only for a non-first occurrence, which by construction has at least two members,
so the branch cannot be taken. It costs a full scan of `inverse` per moved
vertex.

### 11. note - the browser engine's pinch path is exercised on no preset

`ci-preset-matrix.sh` bakes the six presets through the reference pipeline;
`export-cli.ts --overpass` hard-codes `DEMO_CENTER`, so the browser engine only
ever sees Chicago, which has zero pinches. `mesh.separateFloat32Pinches` is
therefore covered by unit tests and by nothing else.
`DECISIONS.md [V3.1-P7-4]` already schedules the browser-engine preset sweep for
the Task 8 wave; until it lands, the TS mirror's behaviour on a real pinch is
unmeasured.

### 12. note - the tests do construct the real geometries, with three named gaps

They are not happy-path tests. `mesh.test.ts:51-74` builds the actual
float32-collapsing needle at a large coordinate and `:131-139` asserts the same
box at the origin needs no repair, which pins the whole "it is a property of the
coordinate" argument. `stl.test.ts`'s `readWelded` re-indexes the written BYTES
the way `cli.py` does and both cases assert on the parsed file, so yes,
`stl.test.ts` would catch hardening being skipped. The Python test is behavioural
on the writer's own function and additionally pins WHY `finalize` cannot see the
pinch (`assemble.float32_defect_count(vertices, faces) == 0`). The tiling test is
honest that the synthetic water scene reproduces neither defect and puts the
discriminating assertions on the real Chicago plate.

Gaps: no test in either language covers a group of three or more coincident
vertices (the `PINCH_STEPS` doubling loop, which Python marks
`# pragma: no cover`); no test covers `unresolved > 0`; and no test covers
`cleanMesh` giving up, which is exactly what plate 256 does.

### 13. note - hygiene is clean

No em dash, no `any`, no `console.log`, no `@ts-ignore`, no `eslint-disable` in
any of the four changed source files or the three test files. `solid/measure.ts`
and `solid/manifold.ts` are byte-unchanged. `pipeline/stages.ts` IS dirty in the
working tree, but that is another agent's export-gate change
(`blockingFindings` / `ExportBlockedError`), not this wave's.

---

## Validator table

`make validate` on every artifact, built by the browser engine from
`fixtures/chicago-scene.json` unless the row says reference pipeline.

| artifact | writer | degenerate_faces | min_wall | bodies | manifold / watertight / self_int | verdict |
|---|---|---|---|---|---|---|
| `chi.stl`, plate 180 default | browser | 0 | 0.8746 | 1 | PASS | ALL CHECKS PASS |
| `chi.3mf`, plate 180 default | browser | 0 | 0.8746 | 1 | PASS | ALL CHECKS PASS |
| `parts-stl.stl`, parts fixture | browser | 0 | 0.8746 | 1 | PASS | ALL CHECKS PASS |
| `parts-3mf.3mf`, parts fixture | browser | 0 | 0.9379 | 6 parts, 462 shells | PASS | ALL CHECKS PASS |
| `p256-stl.stl`, plate 256 | browser | **FAIL 12** | 0.8018 | 1 | PASS | **FAILED: degenerate_faces** |
| `p256-3mf.3mf`, plate 256 | browser | **FAIL 6** | 0.8018 | 1 | PASS | **FAILED: degenerate_faces** |
| `t22-A1/A2/B1/B2.stl` | browser | 0 | 0.9379 / 0.8745 / 1.055 / 0.8816 | 1 each | PASS | ALL CHECKS PASS (4 of 4) |
| `t33-A1..C3.stl` | browser | 0 | 0.8161 to 7.082 | 1 each | PASS | ALL CHECKS PASS (9 of 9) |
| `paris-eiffel.3mf` / `.stl` | reference | 0 | 0.8077 | 1 | PASS | ALL CHECKS PASS |
| `tokyo-shinjuku.3mf` / `.stl` | reference | 0 | 0.8032 | 1 | PASS | ALL CHECKS PASS |
| `london-city.3mf` / `.stl` | reference | 0 | 0.8034 | 1 | PASS | ALL CHECKS PASS |
| `chicago-loop.3mf` / `.stl` | reference | 0 | 0.8016 | 1 | PASS | ALL CHECKS PASS |

The STL rows are judged after `cli.py`'s bitwise re-index, which is the only
mesh those rows ever see. Paris now welds to 53 016 vertices, Tokyo to 64 850 and
London to 56 094, each equal to its own 3MF's `3mf_counts`, so no vertex is lost
any more.

`parts-zip.zip` is not something the validator can open, so its six members were
parsed and judged directly with the same rules: 0 faces under 1e-9 mm2 and 0
edges away from exactly two faces, in every one of the six.

## Test suites

| suite | result |
|---|---|
| `npx vitest run lib/engine`, second run | 618 passed, 2 failed, both `pipeline/matrix.test.ts` and both labelled KNOWN DEFECT (`frame_style.lip_depth_mm`, `regions.rail.width_m`) - exactly what the note reports |
| `npx vitest run lib/engine`, first run | 614 passed, 6 failed; the four extra were `custom_profile.slots` and two `frame_style.shadow_gap` probes, which belong to another agent's in-flight edits and were gone on the rerun |
| `uv run pytest tests/ -k "stl or pinch or float32 or parity or transform"` | 65 passed |

---

## Verdict

The three defects named in `FAILURES.md` are genuinely closed, the reasoning in
the note is correct, and every Chicago number in it reproduces to the digit,
including the two-triangle difference and the byte-identical 3MF. The tests are
built on the real failing geometries rather than on happy paths.

What is missing is generality and observability, and the two compound. The
repair was measured on one plate; on the largest legal plate it spends 6.2 s
doing nothing and no code path can tell. Fixing finding 1 is what turns the
other findings from arguments into measurements: once the report is surfaced,
plate 256 stops being a thing an auditor has to go looking for.

Nothing here should hold the wave. Findings 1, 2 and 3 are worth a follow-up
before the next release, in that order.

---

# Fixes

2026-09-02, same wave, same file list. Findings 1, 2, 3, 4, 5, 6, 7, 9 and 10
are closed; finding 8 is recorded as a follow-up with the reason. Every number
below was measured on this tree after the change. No test, threshold or
validator row was weakened, and `services/bake/app/validate/**` is untouched.

## 1. major, FIXED - the repair reports what it could not do

`hardenForFloat32` returns a `HardenReport`; `export/stl.ts` no longer throws it
away. `float32Findings(report, target)` turns it into ONE `AuditFinding` -
`id: "float32-degenerate"`, `severity: "warning"` - naming the faces the file
cannot carry, the vertices a reader would weld, and any separation that was
rolled back or found no free grid point. `exportStl` and `exportStlPartsZip`
return it on the file (`StlExportFile.findings`, the shape `StepExportFile`
already used for `notes`), `ExportOutput` carries it, and the export stage
merges it into the sidecar's own findings.

Not a gate row, as instructed: `export/gate.ts`'s `STAGE_4_FINDING_IDS` is
byte-unchanged and `stl.test.ts` asserts `blockingFindings` ignores this id. The
reference validator already fails the file on `degenerate_faces`; the engine's
job is to say so first.

Plate 256, `--target stl`, on this tree. The file is what it was; the silence
is gone:

```
note: The STL file cannot carry every face of this model: 12 face(s) measure
under 1e-9 mm2 once the coordinates are on the float32 grid a binary STL writes,
and the repair could not clear any of them. The reference validator will fail
this file on its degenerate_faces row. The 3MF and OBJ writers keep decimal text
and are not affected; a smaller plate is what removes the faces at source.
```

The before-count is measured at 04's own 1e-9, the same threshold as the
after-count, so the two can be subtracted; the PROBE that decides whether to
repair counts at `REPAIR_AREA_MM2` instead, and reads 26 on this plate. An
earlier draft reported the probe's number beside the gate's and appeared to
claim a repair of 14 faces that never happened; `stl.test.ts` now pins both
sentences.

| where it lands | before | after |
|---|---|---|
| CLI stdout | nothing | the `note:` line above |
| sidecar `findings[]` | absent | 1 entry, `float32-degenerate`, `warning` |
| sidecar `bake_result.warnings` | absent | present, once (the notes copy is subtracted so it is not said twice) |
| `ExportState.notes` (the OUTPUT panel's `export-notes` list) | absent | present |
| `ExportState.findings` | engine findings only | plus the writer's |

**One hop is NOT closed, and it needs a file this wave may not touch.** The
Issues badge reads `state.pipeline.result.findings` (`CityPreview.tsx:232`),
which is the PREVIEW result; an export-time finding cannot reach it without a
change in `store/**` or `components/**`, both explicitly out of scope here. The
one-line version for whoever owns them: merge `exportState.findings` into the
`mergeIssues(warnings, engineFindings)` call at `CityPreview.tsx:391`.
Everything up to that hop is done, including `ExportOut.findings` crossing the
worker boundary.

Files touched outside the given list, all one or two lines, all named here
because the requirement could not be met inside it: `export/index.ts`
(`ExportOutput.findings`), `pipeline/stage.ts` (`ExportOut.findings`, optional
so older cached payloads and existing fixtures still type-check),
`pipeline/stages.ts` (the merge), `lib/exportFlow.ts` (one line),
`scripts/export-cli.ts` (the same merge, so a CLI sidecar and an app sidecar
agree).

## 2. major, FIXED - probe first, and one rung

`hardenForFloat32` now runs the two cheap scans BEFORE any repair and returns
the input untouched when both are zero, which is the common case: every tile,
every member of the parts zip, five of the six presets. When something is
found, `cleanMesh` gets `epsilonMm: WELD_EPSILON_MM` (one rung, which also
closes finding 7) and `weld: false` unless the scan actually found a colliding
vertex - the weld's whole job is merging vertices within a nanometre, and on a
placed model such a pair shares a float32 grid point, so a scan that finds no
collision has proved there is nothing for it to merge that the file can see.

Direct benchmark of the function on the placed merged mesh, median of five, the
audit's own method:

| | plate 180 | plate 256 | a mesh with nothing to find |
|---|---|---|---|
| before | 1235 ms | 6175 ms | 1235 ms |
| after | **407 ms** | **706 ms** | **25 ms** |

End to end, the CLI's own `total` minus `engine`, three runs each:

| | run 1 | run 2 | run 3 | median |
|---|---|---|---|---|
| pre-fix writer (audit) | 0.04 | 0.04 | 0.04 | 0.04 s |
| after the first wave (audit) | 1.29 | 1.17 | 1.15 | 1.17 s |
| this tree, `--target stl` | 0.35 | 0.35 | 0.36 | **0.35 s** |
| this tree, `--target stl-parts-zip` | 0.74 | 0.75 | 0.77 | **0.75 s** (was 1.66) |

The 50 ms target is met on the case it was set for: 25 ms when the probe finds
nothing, against the pre-fix writer's whole 40 ms. The default plate keeps
0.31 s over the pre-fix writer because it DOES have a defect to repair - one
T-junction split plus the two full-mesh checks the transaction needs - and that
is the cost of the file being correct.

## 3. major, FIXED - the pinch separation is a transaction now, in both languages

`separateFloat32Pinches` and `separate_float32_pinches` keep a move only when no
face the file can measure becomes degenerate that was not already, and the
volume moves by no more than the move can possibly cost. A rejected move is
rolled back whole and counted in `rejected`, which leaves the collision in the
file and is exactly what finding 1's report then says out loud. `unresolved` is
surfaced the same way.

**One deviation from the brief, deliberate, and the numbers are why.** The
bound is `max(cleanMesh's noise bound, Σ shift × incident area)`, not the
relative bound alone. `cleanMesh`'s bound is a NOISE bound: its repairs are
volume-preserving by construction, so any difference is accumulation error. This
repair moves a vertex on purpose, and what that costs scales with the incident
area, not with the model's volume. On the audit's own three-cube fixture the
relative bound is 3e-6 mm3 and the move costs 4.069e-3, so the pure bound would
roll back a legitimate 1.5e-5 mm step and ship the pinch; on Paris the same step
on a building corner costs about 1.5e-5 mm3 against a 1.2e-4 bound and would
pass. A bound that rejects on a 10 mm cube and accepts on a 180 mm plate is not
measuring the thing it names. Both numbers are in the report
(`volumeDeltaMm3`), and `mesh.test.ts` asserts the accepted move is 1000 times
the relative bound and inside the geometric one.

`openEdges` and `componentCount` are asserted rather than recomputed: both read
the INDEX array, and the separation returns the caller's own indices, so they
cannot move. `mesh.test.ts` and `test_bake.py` each pin that on the three-cube
fixture (`expect(moved.indices).toBe(input.indices)`, `body_count` and
`is_watertight` equal before and after), which catches a future edit that starts
touching indices - a runtime recomputation of an invariant would not.

## 6. minor, FIXED - the mirror is pinned by a shared fixture

`fixtures/pinch-parity.json`: three 10 mm cubes around one vertical column at
(90, 150), the audit's own arrangement, carrying `positions`, `indices`, the
`expected` output and the report. `mesh.test.ts`'s "the TS and Python mirror"
and `test_bake.py`'s `test_a_pinch_moves_to_the_same_place_in_both_engines` both
run it. Measured across the two implementations: **max |python - ts| = 0.0**,
and both report `groups 6, moved 8, unresolved 0, rejected 0, maxShift
1.52587890625e-5, volumeDelta -4.069007312409667e-3`, which reproduces the
audit's numbers exactly. The Python `groups` counter was wrong before this
fixture found it - it counted vertices lost rather than grid points, which
differs whenever a group has three members - and that is precisely the class of
drift the audit predicted.

The fixture also closes two of the three gaps in note 12: a group of THREE, and
with it the `PINCH_STEPS` doubling loop, which the third member of a group has
to take because the second has already claimed the neighbouring grid point.

## 4. minor, FIXED by correcting the comment - and moving the floor was tried and is WRONG

The suggested fix does not survive measurement. `thinPart`'s surviving floors
are applied to the UNION of a pass's findings, and the 0.00535 mm2 needle that
failed tile A1 is under 0.01 mm2, so testing `all.area()` before the growth puts
defect 2 straight back. The comment now says what is true: both survivors guard
against an EMPTY cutter and cannot filter a speck, what actually bounds the pass
is `holdsNoDisc` (which is `checks.min_wall`'s own rule, so only material no
full wall fits into is ever cut), and the measured cost of having no component
floor is the audit's own +0.26 % at 2x2 and +0.18 % at 3x3 with every tile
passing.

## 5. minor, FIXED - one decomposition per tile solid

`sweepTileDebris` returns `pruneDebrisCounted`'s solid and its `bodies.real`,
and `buildTile` passes that into `toRegionMesh`'s existing `bodies` parameter,
so the second `decompose()` is gone. `tiling.test.ts` passes 16 of 16, including
the Chicago 2x2 case that pins both defect-2 rows.

## 7. minor, FIXED - the ladder is one rung from the writer

`hardenForFloat32` passes `epsilonMm: WELD_EPSILON_MM`, so the export path can
no longer reach the 1e-4 rung that merges vertices 6.5 float32 steps apart with
no body guard. Folded into finding 2's measurement.

## 9 and 10, notes, FIXED

The report is no longer computed and discarded (finding 1), and the two passes
that computed it now run BEFORE the repair as its probe (finding 2), so they
earn their cost instead of duplicating it. The dead `inverse == inverse[v]`
guard is gone from the Python implementation, with a comment saying why it could
never be taken.

## 8. minor, FOLLOW-UP - the STEP writer

Not done, and over the thirty-line bar it was conditioned on. `export/step.ts`
writes a 1e-6 mm decimal grid, which is a DIFFERENT quantiser from float32:
closing it needs `cleanMesh`'s measure generalised from "float32 or double" to
an arbitrary grid, a `hardenForDecimals` beside `hardenForFloat32`, a call in
`export/step.ts` (a file outside this wave's list) and tests for both - fifty
lines before the tests. The audit's own numbers stand as the record: on plate
256 the STEP file loses 12 faces, exactly as the STL did, and on plate 180 it
loses none; it is indexed, so the pinch half cannot reach it, and no `.step` is
validated by anything today (`app/cli.py` accepts only `.3mf` and `.stl`).
The cheapest honest first step is to run the existing probe at 6 decimals and
raise the same `float32-degenerate` finding for it, without any repair.

## Verification

| check | result |
|---|---|
| `sh scripts/ci-export-matrix.sh make` | EXPORT-MATRIX PASS, 6 validated |
| `sh scripts/gate-web-engine.sh make` | ALL CHECKS PASS, both modes, rc 0 |
| `npm run lint` / `tsc --noEmit` over `lib/engine` and `scripts` | clean, 0 errors |
| `npx vitest run lib/engine` | see below |
| `uv run pytest tests/test_bake.py -k "stl or pinch or float32 or parts_golden"` | 8 passed |

The default Chicago plate is unmoved: 46 962 vertices and 93 920 triangles in
both files, `make validate` `ALL CHECKS PASS` on the STL and the 3MF, all four
2x2 tiles validated.
