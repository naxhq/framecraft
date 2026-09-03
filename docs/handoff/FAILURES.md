# FAILURES

Defects found by a gate or a test, written down instead of papered over.
Owner = the phase whose files must change. qa-gate does not modify application
code; it reports.

Format: one section per defect, newest last. Status: OPEN / FIXED (by whom).

---

## F1 — `npx tsc --noEmit` fails in `apps/web/lib/warnings.test.ts`

- **Found by**: P5 qa-gate, while type-checking the new `e2e/smoke.spec.ts`
  against the project's own `tsconfig.json`.
- **Owner**: web-editor (the file is a P5-web vitest test).
- **Severity**: low. It does **not** break `make gate`: `next build` type-checks
  only the app graph, `eslint .` is not type-aware, and vitest transpiles
  without checking. So this is a latent error that a stricter CI step (or an
  editor) surfaces, not a runtime or gate failure.
- **Status**: FIXED by P6 fixer (2026-08-29). The cast in `lib/warnings.test.ts`
  now takes the double hop (`as unknown as Record<string, unknown>`); the
  assertion is unchanged. To stop the class of error from coming back,
  `apps/web/package.json` gained `"typecheck": "tsc --noEmit"` and `make gate`
  step 2 now runs `npm run lint && npm run typecheck && npm test && npm run
  build`, so a type error anywhere in the project (tests, e2e specs, unreached
  modules) fails the gate instead of only showing up in an editor.
  Verify: `cd apps/web && npm run typecheck` -> rc 0.

Failing command (from `apps/web`), before the fix:

```
$ npx tsc --noEmit
lib/warnings.test.ts(179,8): error TS2352: Conversion of type 'PrintParams' to type 'Record<string, unknown>' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert the expression to 'unknown' first.
  Index signature for type 'string' is missing in type 'PrintParams'.
$ echo $?
2
```

The line is the `(moved as Record<string, unknown>)[key] = ...` write inside
`describe("warningDeps")`. TypeScript wants the double step
(`as unknown as Record<string, unknown>`) because `PrintParams` has no index
signature. The assertion the test makes is correct and must not be weakened;
only the cast needs the extra hop.

---

## F2 — `e2e/ui.spec.ts` asserted a premise `[V2-P5-fix]` had already deleted

- **Found by**: V2-P7 qa-gate, on the first authoritative `make gate` of the
  phase (2026-08-30).
- **Owner**: qa-gate (the file is a Playwright spec, which this phase owns).
  **No application code is at fault** — the app is behaving exactly as
  `[V2-P5-fix]` specified.
- **Severity**: gate-breaking. In `test.describe.configure({ mode: "serial" })`
  a failure takes the rest of the file with it, so this one assertion cost 13
  of the 25 acceptance tests (1 failed, 12 not run, reported as skipped).

Failing command and output:

```
$ make gate
...
  ✘  13 [chromium] › e2e\ui.spec.ts:259:5 › an engraving appears on the frame, and a refused one does not (18.7s)

    Error: expect(locator).toContainText(expected) failed
    Locator: getByTestId('engraving_0-fit')
    Expected substring: "Not cut"
    Received string:    "Cuts at 4.00 mm."
      at D:\VahidVibeProject\CityDesign3D\apps\web\e2e\ui.spec.ts:282:25

  1 failed
  12 did not run
  12 passed (3.0m)
gate: the Playwright suite FAILED
gate: 12 Playwright test(s) SKIPPED - the gate does not accept a skipped acceptance test
GATE FAIL
```

Diagnosis: the test got its refusal *for free* from the contract default. It
added an engraving row, took whatever cap height the contract seeded it with,
and asserted the panel said "Not cut". `[V2-P5-fix]` then raised
`engravings[].size_mm` from 3.0 mm to 4.0 mm **precisely so that a freshly
seeded engraving is printable** ("at 3.0 mm the DEFAULT face refuses six of the
eight" real strings). Measured against the shared math on this tree:

```
$ cd services/bake && uv run python -c "...lettering_layout for '{city}'='Chicago'..."
  2.0 refused=True    3.0 refused=True    3.25 refused=False
  4.0 refused=False   6.0 refused=False (fitted down to 5.16 mm)
```

So "Chicago" at the new 4.0 mm default cuts, and the test's whole premise was
gone. It had quietly turned into "the default is refused", which is the
opposite of what the contract now promises.

- **Status**: FIXED by V2-P7 qa-gate. The spec no longer infers the refused
  size: it now (1) **pins the new default** — `engraving_0_size_mm-value` reads
  `4.0 mm` and the verdict reads `Cuts at`, with rings drawn — then (2) sets
  3 mm explicitly, the old default, and requires `Not cut` **and the rings to
  go back to 0**, then (3) raises to 6 mm and requires exactly 8 rings again.
  That is strictly more coverage than before: the preview is now proved to take
  the letters *off* the plate when the verdict flips, not merely never to have
  put them on. Verify: `cd apps/web && npx playwright test --grep "an engraving
  appears on the frame"` -> 1 passed.
- **Note for whoever reads the V2-P6 handoff**: its "25 e2e, 0 skipped" was
  recorded against the pre-`[V2-P5-fix]` contract default. Nothing regressed
  between then and now; the two facts were just never re-checked together.

---

## Open: frame-off Chicago at plate 256 mm (v3-07-fix, 2026-09-01)

`[V3-P7-A11]`'s plate-180 failures are fixed (`docs/handoff/v3-07-fix.md`,
`[V3-P7-fix-1]`, `[V3-P7-fix-2]`). Two things at plate 256 are not. Reproduce
both with the params in `artifacts/frameoff-params/` (the default and parts
parameter files with `frame: false` and `plate_mm: 256`):

```sh
cd apps/web && npx vite-node scripts/bake-cli.ts --   --scene ../../fixtures/chicago-scene.json   --params ../../artifacts/frameoff-params/single-256.json   --target generic-3mf --out ../../artifacts/off-256.3mf
cd ../../services/bake && uv run python -m app.cli validate ../../artifacts/off-256.3mf
```

### 1. `degenerate_faces` 7, single mode - not a frame-off defect

The frame-ON plate-256 single bake fails the same row with **6** faces, so this
belongs to plate 256 and single mode, not to the frame. The faces are in
`EngineResult.merged`, the union of every region, and they survive `cleanMesh`:
`mesh.collapseNeedles` (the opt-in rung `[V3-P7-A9]` added for tiling, a strict
no-op on a mesh that already has none, so it cannot move plate 180) was enabled
on that mesh and the count stayed at **7**, which means `cleanMesh`'s acceptance
test is rejecting the repair rather than the repair being unavailable. It was
backed out again rather than left in as dead configuration. Next step: instrument
`weld` / `splitNeedles` / `collapseNeedles` on that specific mesh and find which
guard rejects - `acceptable()`'s volume tolerance, `openEdges`, or
`componentCount`.

### 2. `min_wall` 0.2998, parts mode - one region

One region at z = 2.805 mm (the 0.2 mm band between the road tops at 2.8 and the
base top at 3.0), a city block at x 106.2 to 114.0, y 232.2 to 237.6 in build
space, with a 0.46 x 0.44 mm lobe at its north-east corner hanging off a **4.6
micrometre pinch**. The pinch is made by `areas.grownPocket`: the road pocket is
the road footprint grown by `POCKET_GROW_MM` (2 um), and where the groove runs
along that block's edge the growth pinches the base almost through.

Four repairs were built and measured; none closes it:

| attempt | result |
|---|---|
| bridge the wedge into the roads layer (what shipped) | single 0.7972 PASS; parts still 0.2998, because carving the base leaves the block's corner overhanging 0.08 mm and the parts union reads the same lobe one layer up |
| also hold the bridge clear of the buildings | both modes 0.298 - the wedge IS at the block's corner, so the keep-out removes exactly the bridge that fixed it |
| measure the printed plan, `plate \ (pockets \ buildings)` | both modes 0.298 |
| widen the neck instead of carving it, by `(min_wall - w) / 2` | worse, 0.253; the pinch moves rather than closing and four passes do not converge |

The remaining lever is the pinch itself: hold `grownPocket` clear of the building
footprint, which is where the groove was already cut to. That would remove the
pinch at source **and** bring back the 602 zero-area faces at the
buildings/roads boundary that `POCKET_GROW_MM` exists to kill (see
`areas.grownPocket`'s own note). The trade needs measuring and it touches every
bake, frame on or off.

Note the asymmetry: single mode reads 0.7972 and parts reads 0.2998 on the same
geometry, because the mesh the engine welds and the union the reference validator
builds from the exported parts are not bit-identical at a 4.6 um neck. Do not
read the single-mode pass as "fixed".

### 3. The engine's flat min-wall gate is blind to this whole class

`measure.measureMinWall` measures, on a flat bake, only a region that VANISHES
under the `0.5 * min_wall` erosion. The block that failed held a 3.37 mm disc and
carried a 0.17 mm wing, so the gate saturated at 0.80 mm and said nothing while
the reference validator failed the file at 0.1667 mm. Two closures were
implemented, measured and backed out for cost - both take the default bake past
`engine.test.ts`'s 15 s `TIME_BUDGET_MS` (6.0 s -> 16.2 s), and the cost is the
residue probe itself, four Clipper2 offsets per region per slice, not the width
search behind it. Removing `narrowestWidthMm`'s `4A/P` pre-filter (which the
reference does not have) additionally turns three draped fixtures from clean into
`wall-too-thin` at 0.158 mm - findings that may well be real and that nobody has
judged. Closing this needs one cheaper appendage probe; see `[V3-P7-fix-4]`.

---

## One unexplained e2e stall, seen once, not reproducing (v3-07-fix2)

`e2e/smoke.spec.ts`'s happy path failed at the stats-card wait
(`expect(getByTestId('stats-card')).toBeVisible`, 90 s, "element(s) not found")
on the FIRST full three-spec run after `[V3-P7-fix2-1]` restored
`measureMinWall`'s filter order. The three full runs after it passed 10/10, as
did the `efbe953` control, and the happy path also passes on its own.

What is known:

* `StatsCard` returns `null` until `engine.result` is set even once, and the
  captured page showed the preview still on "Updating model...", so the engine
  had not landed a SINGLE result in that page - not a slow bake, a first result
  that never arrived. No console error, no engine finding, no error status
  (which would have rendered the card's error box instead).
* There is no measured cost difference left to blame. On the smoke test's own
  parameters the bake is 4.40 s against the pre-fix tree's 4.61 s; the default
  bake is 6.63 s against 5.70 s, and that +0.93 s is `[V3-P7-fix-5]`'s wing
  widening, which the control does not have.
* The Playwright trace was overwritten by the next run's `outputDir` clean
  before it could be read, so the console and network record is gone.

Where to look if it is seen again: `EngineClient` runs one bake at a time and a
running bake cannot be preempted (`[V3-P2-E4]`), so after A3's slider stress the
queue is one running plus one newest job, and a lost `done` message or a worker
that dies without an `onerror` would leave the status on "computing" forever with
exactly this signature. Keep the trace (`--trace on`) and log the worker's
message ids on both sides before concluding it is host load.

---

## Not defects (checked, and they hold)

Recorded here so the next phase does not re-investigate them:

- `GET /files/<name>.3mf` answers `application/octet-stream` (Python's
  `mimetypes` has no entry for `.3mf`, and Starlette 1.6's `FileResponse`
  falls back to octet-stream, not `text/plain`). The e2e asserts the content
  type is either that or the 3MF media type, and it passes.
- Baking Chicago with the sliders the smoke test moves (plate 200 mm, large
  building scale 120 %, base 4 mm) passes every validator: 200.000 x 200.000 x
  46.613 mm, min wall 0.829 mm, 75 886 triangles.
- `make validate` on a file whose PrintParams differ from the contract defaults
  FAILS `bounding_box` unless the bake's `<stem>.json` sidecar (or
  `--plate-mm`) tells it the plate size. That is the validator working, not a
  bug; the smoke test downloads the sidecar next to the `.3mf` for exactly this
  reason.

---

## Open: nightly export matrix defects found by the Task 14 CI diet (2026-09-02)

Found by `scripts/ci-export-matrix.sh` and `scripts/ci-preset-matrix.sh` (the
new `nightly.yml` jobs, also `make gate-nightly`) on the first local run against
the Task 3 tree. Owner: `lib/engine/solid` and `lib/engine/export` (the geometry
and perf wave). The checks were not weakened.

1. `stl` target on the Chicago fixture fails the validator's `degenerate_faces`
   row with 1 face, while the `generic-3mf` of the same build passes.
2. `--tiling 2x2`: tile A1 fails `min_wall` (0.037 mm) and `bodies` (one water
   debris shell); tiles A2, B1, B2 pass.
3. Presets Paris, Tokyo and London (through `--overpass fixtures/<sha1>.json`)
   each produce a `.3mf` that passes and an `.stl` that fails `manifold`,
   `watertight` and `self_intersection`. Chicago, New York and San Francisco
   pass both. Since both files are written from `EngineResult.merged`, the
   suspect is the STL writer's handling of the merged mesh (or the validator
   reading a binary STL differently from the 3MF), to be settled by diffing
   the two meshes before touching geometry.

Status: OPEN, queued for the Task 7 geometry wave after the pipeline lands.
