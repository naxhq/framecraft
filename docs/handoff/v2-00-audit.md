# v2 Task 0 - adversarial audit of the min-wall investigation

Auditor did not write the audited code. Scope: the uncommitted Task 0 diff
(`transform.py` / `transform.ts`, `preview.ts`, `CityPreview.tsx`, `checks.py`,
`fixtures/parity-expected.json`, four test files) plus
`docs/handoff/v2-00-minwall.md` and the `[V2-P1]` lines in `DECISIONS.md`.
The orchestrator's edits to `.claude/agents/*.md` and `docs/handoff/STATUS.md`
were ignored per brief. Nothing was fixed. Two source mutations were made to
test whether the suite bites; both were restored byte-for-byte (verified by
`md5sum` and by `git diff --numstat` returning to the pre-audit values, and by a
full 332-test pytest run afterwards).

---

## What was verified as CORRECT

**H1 evidence is real and reproduces.** `artifacts/265aa8c0ed.json` records
`print_params.nozzle_mm = 0.2`, `plate_mm 180.0`, `frame true`,
`scene_request.radius_m 1980.0`, `bake_result.stats.min_wall_mm
0.4000287941087102`, the `min_wall` check `threshold 0.36000000000000004`
(= 0.9 x 0.4), and `validation.passed true`.
Arithmetic: `usable = 180 - 2*6 = 168 mm`, `scale = 168 / 3960 = 0.042424...
mm/m`, `round(1000/scale) = 23571`. At nozzle 0.2, `min_wall_ground = 0.4 /
0.042424 = 9.4286 m` -> `"9.4"`, and `min_wall_mm = 0.400`. At nozzle 0.4 the
same two numbers would be `0.8 / 0.042424 = 18.857 m` -> `"18.9"` and a gate
`fail_at` of `0.9 * 0.8 = 0.72 mm`, so a *passing* bake reporting 0.40 mm is
impossible. Independently re-tabulated all 14 sidecars in `artifacts/`: exactly
one bake ran at nozzle 0.2 (the reported parameter set, measuring 0.4000); all
thirteen 0.4 mm bakes measure 0.8002 - 0.8841. The report's table is accurate.

**H3 refutation is sound, and read from the code, not the report.**
`CityPreview.tsx:324` renders `dilatedNotice(layout.dilatedCount, thresholds)`;
`preview.ts:565` returns `thresholds.min_wall.toFixed(1)`, and `thresholds`
comes from `T.thresholds_ground_m` (`transform.ts:192`,
`min_wall: min_wall_mm(params) / scale`), i.e. two nozzles - not `min_detail`.
`BakeStats.min_wall_mm` is `report.value_of("min_wall")` (`app/bake.py:252`),
whose `value` is `reported = smallest` from `_min_wall_probe`
(`checks.py:770`, `checks.py:551-570`) - the measured narrowest solid-region
width, not `fail_at` and not a detail floor. The look-alike is real:
`min_detail_ground` at nozzle 0.4 and 1:23,571 is also 9.4286 m, so the HUD
string alone cannot separate the two hypotheses; both readings are now pinned.

**The new tests do bite (mutation-tested, then reverted).** Changing
`preview.ts:565` from `thresholds.min_wall` to `thresholds.min_detail` fails
2 vitest assertions (`preview.test.ts:399/404` and `preview.test.ts:416`,
"Expected 18.9 ... Received 9.4"). Changing `transform.py:228` from
`MIN_WALL_NOZZLES` to `MIN_DETAIL_NOZZLES` fails 8 pytest tests, including all
three new ones. (But see finding 1: the *component* call site is not covered.)

**Behaviour identity of the refactor - all four call sites are IEEE-identical.**

| site | before | after |
|---|---|---|
| `transform.py:246` | `(MIN_WALL_NOZZLES * nozzle) / scale`, `nozzle = float(params.nozzle_mm)` | `min_wall_mm(params) / scale` = same product, same divisor, same order |
| `transform.py:498` | `(MIN_WALL_NOZZLES * float(params.nozzle_mm)) / (2.0*cos(pi/8))` | `min_wall_mm(params) / (2.0*cos(pi/8))` |
| `transform.ts:192` / `transform.ts:435` | same two expressions | same two substitutions |
| `checks.py:633` | `T.MIN_WALL_NOZZLES * float(params.nozzle_mm)` | `T.min_wall_mm(params)` (identical body) |

No rounding, no reassociation, no dependence on `frame` anywhere in the moved
math (`frame` only enters `scale`, untouched). The Stage 4 failing threshold is
still `MIN_WALL_FAIL_FACTOR * min_wall_mm` with `MIN_WALL_FAIL_FACTOR = 2.0 *
MIN_WALL_PROBE_FACTOR = 0.9` imported from `thicken` (`checks.py:58`,
`thicken.py:84-89`), i.e. `0.9 * (2 * nozzle)`. `wall_persist_mm`
(`checks.py:330`), the residue/area-floor math (`checks.py:532`) and
`tree_min_radius_mm`'s floor are untouched by the diff.

**Test integrity.** `git diff --numstat -- '*test*'` is `61/0`, `40/0`, `20/0`,
`146/0` - 267 added lines, zero removed. `git diff | grep '^+.*(skip|xfail|
eslint-disable|@ts-ignore|@ts-expect-error)'` finds nothing outside a STATUS.md
table cell. The `2 x nozzle` sweep covers 0.10..1.20 inclusive at 0.01
(111 points) in **both** languages - `range(10, 121)` in
`test_transform.py:105` and `for (let n = 10; n <= 120; n += 1)` in
`transform.test.ts:322` - asserted at `pytest.approx(..., abs=1e-12)` and
`toBeCloseTo(..., 12)` (tolerance 5e-13). Both ends are pinned to the frozen
contract, not to typed literals (`contracts.py:100` `Field(ge=0.1, le=1.2)`;
`PARAM_RANGES.nozzle_mm`). The Stage 1 / Stage 4 test reads the real constants
(`thicken.MIN_WALL_REPAIR_FACTOR`, `checks.MIN_WALL_FAIL_FACTOR is
thicken.MIN_WALL_FAIL_FACTOR`, `inspect.signature(survives_min_wall)`), the real
`survives_min_wall` predicate, and the threshold off a real `checks.validate()`
report at five nozzles.

**Parity fixture.** `git diff --numstat fixtures/parity-expected.json` is
`15 0` - purely additive, no existing value modified. Regeneration is proven
idempotent without writing: `test_parity_expectation_matches_the_committed_
fixture` (`test_transform.py:648`) does `assert committed == fresh` on the whole
document, and it passes. The TS side consumes the new block
(`transform.test.ts:157-166`, `preview.test.ts:385`), so an old fixture would
throw rather than skip.

**Runs (this audit, on the restored tree).**

```
services/bake  uv run pytest -q tests/test_transform.py tests/test_validate_cli.py   66 passed
services/bake  uv run pytest -q                                                     332 passed (exit 0)
apps/web       npm test -- --run                                    147 passed (10 files)
apps/web       npm run typecheck                                    clean
apps/web       npm run lint                                         clean, 0 problems
```

Counts match the engineer's report exactly (332 / 147).

---

## Findings

### 1. MAJOR - the HUD call site is still untested; the exact H3 regression ships silently
`apps/web/components/scene/CityPreview.tsx:324`

The refactor put the *string* under test but not the *threshold selection*.
`dilatedNotice` is well covered, but nothing asserts that `CityPreview` passes
`thresholds` to it rather than formatting `thresholds.min_detail` inline again.
`CityPreview.test.ts` covers only `previewDeps` memo keys; there is no render
test and no Playwright assertion on the HUD text (`grep -rn "widened to"
apps/web` hits only `preview.ts`, `preview.test.ts` and a `bake.test.ts`
fixture string).

Reproduce (done, then reverted):

1. In `CityPreview.tsx:324` replace `` ` · ${dilatedNotice(layout.dilatedCount,
   thresholds)}` `` with the pre-refactor inline form using
   `thresholds.min_detail.toFixed(1)`.
2. `cd apps/web && npm test -- --run` -> **147 passed**. Nothing fails.
3. `npm run lint` -> `1 problem (0 errors, 1 warning)`, only
   `'dilatedNotice' is defined but never used`. `package.json:11` is
   `"lint": "eslint ."` with no `--max-warnings 0`, and `Makefile:139` runs
   `npm run lint` plain, so eslint exits 0 and **`make gate` stays green**.
   Deleting the now-unused import removes even the warning.

So the precise failure mode this task was commissioned to rule out - a HUD that
prints one nozzle where 04 asks for two - can be reintroduced by a one-line edit
that no gate catches. `DECISIONS.md` `[V2-P1]` ("so the exact string - metres and
label together - is asserted by vitest rather than living untested inside
`CityPreview.tsx`") and `v2-00-minwall.md:110-112` ("`CityPreview.tsx` renders
that instead of formatting the number inline, so the string is under test")
both overstate what was delivered: the untested surface moved from the string to
the argument. Note the same gap pre-exists for `mergeNoticeMetres`
(`CityPreview.tsx:313`) and `treeFloorNoticeMetres` (`CityPreview.tsx:220`) -
this is a systemic pattern, but Task 0 claimed to close it for this clause.

### 2. MINOR - two of the new threshold tests are tautologies after the refactor
`services/bake/tests/test_transform.py:143-152` and
`apps/web/lib/transform.test.ts:165`

`test_ground_thresholds_are_the_print_thresholds_over_the_scale` asserts
`th.min_wall == approx(T.min_wall_mm(p) / scale)`, and the TS twin asserts
`groundEq(thresholds.min_wall, T.min_wall_mm(params) / scale)`. Since the
refactor, `thresholds_ground_m` *is literally* `min_wall_mm(params) / scale`
(`transform.py:246`, `transform.ts:192`), so neither assertion can fail for any
value of the multipliers - swap `MIN_WALL_NOZZLES` for `MIN_DETAIL_NOZZLES` and
both still pass. The docstring's stated intent ("`thresholds_ground_m` may not
re-derive the multipliers of its own") was meaningful against the pre-refactor
inlined form and is now structurally guaranteed. Real coverage of the ground
thresholds comes from the fixture and the sweep tests, so nothing is unprotected
- but these two blocks are dead weight and read as coverage they do not provide.
To be non-vacuous they must compare against `2 * nozzle / scale` spelled out
independently of the helper.

### 3. MINOR - `DECISIONS.md` `[V2-P1]` overstates "zero occurrences"
`DECISIONS.md` (V2-P1, "Hand-written `2 * nozzle` is zero occurrences outside
the helpers now") vs `services/bake/app/validate/checks.py:337` and
`services/bake/app/validate/checks.py:532`

True only for the forward product. `checks.py:337`
(`nozzle = float(min_wall_mm) / T.MIN_WALL_NOZZLES`, inside `wall_persist_mm`)
and `checks.py:532`
(`min_detail = min_wall_mm * T.MIN_DETAIL_NOZZLES / T.MIN_WALL_NOZZLES`, inside
`_min_wall_probe`) still reconstruct the nozzle and the detail floor from the
raw multipliers by hand - the same drift risk in inverse form - and were not
routed through the new helpers. Not a behaviour defect: both are exact in
IEEE754 (`2*n` and `/2.0` are power-of-two scalings), and both are structurally
forced, because `wall_persist_mm` and `_min_wall_probe` receive a `float`
min-wall rather than `params` and so cannot call `T.min_wall_mm`. The code is
fine; the decision line's absolute wording is not.

### 4. NOTE - the "byte-identical re-bake" proof is not reproducible from the tree
`docs/handoff/v2-00-minwall.md:118-122`

`artifacts/` is gitignored and `artifacts/chicago.json` has mtime 22:57:51,
after the source edits (`transform.ts` 22:47:53), so the pre-change file it was
compared against has been overwritten; the comparison cannot be re-run here. It
is corroborated indirectly and holds up: committed pre-change records at
`da9ab83` (`docs/handoff/06-polish.md:162`, `DECISIONS.md:178`) give the same
`180x180x34.733 mm, min wall 0.8016` for the Chicago fixture, and the four call
sites are provably identical arithmetic (above). The triangle count 68,692 has
no committed pre-change record, so that specific number rests on the engineer's
and orchestrator's runs alone.

### 5. NOTE - the 3353 vs 5170 reconciliation is the one unverified leg of H1
`docs/handoff/v2-00-minwall.md:58-65`

The mechanism checks out by reading the code: `preview.ts:245-258` increments
`dilatedCount` only when `T.building_footprint_metrics` returns `dilation > 0`
(04 Stage 1 step 2, hydraulic diameter under `min_wall`), against the same
`thresholds_ground_m`, while the bake's warning also counts the appendage and
slice-profile repairs, so preview < bake is expected. The 370/509 Chicago
measurement quoted as the calibration was not re-run in this audit. Everything
else supporting H1 is confirmed directly from the sidecar, so this does not
change the verdict.

### 6. NOTE - stale line citation
`docs/handoff/v2-00-minwall.md:68` cites `ParamPanel.tsx:171` for
`step={0.05}`; line 171 is `id="nozzle_mm"` and `step={0.05}` is
`ParamPanel.tsx:175`. Cosmetic; the claim itself (a 0.05 mm slider step over
0.1..1.2, so 0.20 is four steps left of the default) is correct.

---

## Verdict

The investigation's conclusion is correct and the evidence is real: **H1, the
user's nozzle was 0.2 mm; no factor of two is missing anywhere.** The refactor
is numerically inert at every call site, the tests are additive and non-vacuous
where it matters, and the parity fixture is purely additive. The one substantive
defect is that the guarantee the task advertised - the HUD's minimum-wall clause
being under test - stops one line short of the component that renders it.

AUDIT: 6 DEFECTS (0 blocker, 1 major)

---

## Resolution (fixer pass, 2026-08-29)

| # | Finding | Status |
|---|---|---|
| 1 | MAJOR - HUD call site untested | **FIXED** (structurally + guarded + gate ratchet) |
| 2 | MINOR - tautological ground-threshold assertions | **FIXED** (both languages) |
| 3 | MINOR - `[V2-P1]` overstates "zero occurrences" | **FIXED** (correction line in `DECISIONS.md`; code unchanged, deliberately) |
| 4 | NOTE - "byte-identical re-bake" not reproducible from the tree | **NOT FIXED** (see below) |
| 5 | NOTE - 3353 vs 5170 reconciliation unverified | **NOT FIXED** (see below) |
| 6 | NOTE - stale line citation `ParamPanel.tsx:171` -> `:175` | **NOT FIXED** (see below) |

### 1 - MAJOR, fixed three ways

* **Signature.** `dilatedNotice(count, params, scale)` (`apps/web/lib/preview.ts`)
  now derives the metres from the shared `T.min_wall_mm(params) / scale` and no
  longer accepts a `Thresholds` record. The threshold selection therefore lives
  in the tested module; the component has no wrong field to pass, and passing a
  `Thresholds` where `PrintParams` is expected does not type-check.
* **Gate ratchet.** `apps/web/package.json` -> `"lint": "eslint . --max-warnings 0"`.
  The tree emits zero warnings, so this is free today and makes the audit's
  orphaned `dilatedNotice` import a gate failure rather than a warning.
* **Source guard.** New `apps/web/components/scene/CityPreview.hud.test.ts` (4
  assertions) reads `CityPreview.tsx` as text: the `layout.dilatedCount` ternary
  must call `dilatedNotice(`, must not name `min_detail` / `min_gap` / `toFixed`,
  the literal `"minimum wall"` must not appear in the component, and there must
  be exactly one `dilatedNotice(` call. It is crude and its header says so, with
  the reason (no WebGL canvas in the node environment; no Playwright scene that
  deterministically dilates a footprint).
* **Coverage added to `preview.test.ts`**: the 18.9 m / 9.4 m strings at
  1:23,571 are unchanged, and a Chicago-default case was added - plate 180,
  frame on, radius 900 (1:10,714) - reading `"8.6 m"` at nozzle 0.4 and
  `"4.3 m"` at 0.2, with `min_detail` at 0.4 pinned to the same 4.3 m so the
  look-alike is pinned at a second scale too.

**Mutation test of the fix** (the audit's own reproduction, applied and reverted):

| mutation | vitest | `npm run lint` |
|---|---|---|
| inline `thresholds.min_detail.toFixed(1)` at the call site | **4 failures** (all in `CityPreview.hud.test.ts`) | **exit 1** - `1 problem (0 errors, 1 warning)`, "ESLint found too many warnings (maximum: 0)" |
| ... and the now-unused import deleted (the audit's silent variant) | **4 failures** | exit 0 |
| reverted | back to baseline | exit 0 |

So the regression is red under both variants, and under the noisy one it is red twice.

### 2 - MINOR, fixed
`services/bake/tests/test_transform.py::test_ground_thresholds_are_the_print_thresholds_over_the_scale`
and the `"agrees on the print-millimetre thresholds"` block in
`apps/web/lib/transform.test.ts` now assert against `2 * nozzle / scale`,
`1.5 * nozzle / scale` and `1.0 * nozzle / scale` computed in the test. Both
docstrings/comments record why. Substituting `MIN_DETAIL_NOZZLES` for
`MIN_WALL_NOZZLES` now fails them.

### 3 - MINOR, fixed as a documentation correction
`DECISIONS.md` gained a `[V2-P1-fix]` line naming `checks.py:337` and
`checks.py:532` as surviving inverse forms. The code was **not** changed: both
functions receive a `float` min-wall rather than `params`, so neither can call
`T.min_wall_mm`, and routing them through the helpers would mean widening two
internal signatures for no behavioural gain. The audit agreed they are exact and
structurally forced.

### 4, 5, 6 - NOT FIXED, and why

* **4** is unfixable after the fact: `artifacts/` is gitignored and the
  pre-change `chicago.json` was overwritten, so the comparison cannot be
  re-created without re-running the pre-change tree. The audit corroborated the
  claim from committed records at `da9ab83` and from the four call sites being
  identical arithmetic; nothing further is available from this tree. The
  standing protection is `services/bake/tests/test_v1_compat.py` (contracts
  phase), which pins bake output byte-for-byte against the committed v1 golden.
* **5** is a re-measurement, not a defect: the mechanism was confirmed by
  reading `preview.ts:245-258`. Re-running the 370/509 Chicago figure needs a
  full bake and does not change the verdict.
* **6** is a stale line citation in a completed phase note. `docs/handoff/`
  notes are a record of what was known at the time; the claim itself is correct
  and editing the number would not make the note more accurate about anything
  load-bearing.

### Verification (this pass)

```
cd apps/web && npm test -- --run        150 passed, 2 failed *
cd apps/web && npm run typecheck        clean
cd apps/web && npm run lint             clean, 0 problems (with --max-warnings 0)
cd services/bake && uv run pytest -q tests/test_transform.py   30 passed
```

\* The two failures are `store/editor.test.ts` and
`components/scene/CityPreview.test.ts`, both `"covers every field/key of the
frozen PrintParams contract"`, both failing at the same baseline before this
pass began: the concurrent contracts phase has added the v2 PrintParams fields
(`schema_version`, `city_label`, `color_mode`, `engravings`, `hanger`,
`hero_building_ids`, `hero_mode`, `north_arrow`, `part_colors`, `scale_bar`,
`underside_mark`) and `previewDeps` / the store do not enumerate them yet. Not
this pass's work and not touched by it (re-checked after the mutation runs,
still the same two). Test count went 147 -> 152: +1 `preview.test.ts` case,
+4 the new source guard, and the removal of no test anywhere.
