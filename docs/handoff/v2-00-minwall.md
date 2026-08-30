# v2 Task 0 - min_wall investigation

**Verdict: H1. The user's nozzle was 0.2 mm. No bug. No factor of two was lost
anywhere, and the HUD prints the quantity its label claims.** Geometry is
unchanged by this task (proved below), so the v1 golden may be generated from
the tree as it stands.

## The evidence

The bake the report describes is still on disk, with its own sidecar:

`artifacts/265aa8c0ed.json`

```
scene_request : lat 41.89063, lon -87.64045, radius_m 1980
print_params  : plate_mm 180, frame true, nozzle_mm 0.2   <-- H1
bake_result   : status done, min_wall_mm 0.4000287941087102
warnings      : "5170 buildings widened to meet minimum feature size"
validation    : passed true
```

That is the exact parameter set in the report (plate 180, frame on, radius
1980 m, hence usable 168 mm over a 3960 m span = 0.0424242 mm/m = 1:23,571) and
it records `nozzle_mm: 0.2`. Every other bake on disk was run at 0.4 and every
one of them reports a measured min wall of 0.80-0.88 mm:

| sidecar | radius | plate | nozzle | measured min_wall_mm |
|---|---|---|---|---|
| 265aa8c0ed | 1980 | 180 | **0.2** | **0.400** |
| chicago / 3f209242ea | 900 | 180 | 0.4 | 0.802 / 0.810 |
| 659ca8beb0, 7078df8323, 7a44b067ae, cedbe0e24c, e63bae7381, ec1d20627b | 900 | 200 | 0.4 | 0.802 |
| f0169857bb | 900 | 200 | 0.4 | 0.829 |
| 74448a7b88 | 900 | 200 (no frame) | 0.4 | 0.884 |
| 4bf24407b8 | 900 | 220 (no frame) | 0.4 | 0.804 |
| c58fed386e | 900 | 256 | 0.4 | 0.800 |
| d6f9cd6da9 | 900 | 256 (no frame) | 0.4 | 0.840 |

Both reported numbers follow from nozzle 0.2 and only from nozzle 0.2:

* HUD metres: `min_wall_ground = 2 * 0.2 / 0.0424242 = 9.43 m` -> `"9.4"`.
  At 0.4 it would read `18.9`.
* Print stat: `BakeStats.min_wall_mm` is the **measured** narrowest wall, and
  Stage 1 repairs to exactly `1.0 * min_wall`, so it lands just above
  `2 * 0.2 = 0.400` -> `"0.40 mm"`. At nozzle 0.4 the gate fails anything under
  `0.9 * 0.8 = 0.72 mm`, so a *passing* bake reporting 0.40 mm is arithmetically
  impossible; the passing status was itself the tell.

**H2 (a lost factor of two) is refuted** by the four call sites below, all of
which multiply by `MIN_WALL_NOZZLES = 2.0`, and by the fact that every 0.4 mm
bake on disk measures ~0.8 mm.

**H3 (the HUD printing a different threshold) is refuted by code**, and it was
worth refuting carefully: `min_detail_ground = 1 * nozzle / scale` at nozzle 0.4
and this scale is **also 9.4 m**, so the string alone cannot distinguish a
halved nozzle from a HUD reading the wrong threshold. `CityPreview.tsx` passed
`thresholds.min_wall`, not `min_detail`. Both readings are now pinned by tests.

The count is consistent too. The HUD's `3353` is the *preview's* `dilatedCount`
(04 stage 1 step 2 only: hydraulic diameter under the wall), while the bake's
`5170` also counts the appendage and slice-profile repairs. Measured on the
Chicago fixture at 900 m the same pair is 370 (preview) vs 509 (bake), ratio
0.73, against the report's 3353/5170 = 0.65 - the same relationship. Halving
the nozzle roughly halves the preview count (Chicago: 370 at 0.4, 208 at 0.2),
so a 0.4 mm session on that scene would have shown a count far larger than
3353 next to a bake count of 5170.

How the user got to 0.2: the nozzle slider (`ParamPanel.tsx:171`) has
`step={0.05}` over the contract range 0.1..1.2, so 0.20 is four steps left of
the 0.40 default and displays as "0.20 mm" while it is dragged. Nothing else
can set it - see "editor cannot silently start at 0.2" below.

## The four places, and what each computes

| # | Place | Expression | Value at nozzle 0.4 |
|---|---|---|---|
| 1 | `services/bake/app/geom/transform.py` `min_wall_mm` / `thresholds_ground_m` (and the TS mirror `apps/web/lib/transform.ts`) | `MIN_WALL_NOZZLES (2.0) * nozzle_mm`, then `/ scale` for ground metres | 0.8 mm |
| 2 | `apps/web/components/scene/CityPreview.tsx` HUD, via `dilatedNotice` in `apps/web/lib/preview.ts` | `thresholds.min_wall.toFixed(1)` where `thresholds = T.thresholds_ground_m(params, scale)` | 18.9 m at 1:23,571 |
| 3 | `services/bake/app/geom/thicken.py` Stage 1 | `MIN_WALL_REPAIR_FACTOR = 1.0` times that same `min_wall` (`survives_min_wall`, `widen_to_min_wall`) | repair to 0.8 mm |
| 4 | `services/bake/app/validate/checks.py` Stage 4 | `MIN_WALL_FAIL_FACTOR = 2 * MIN_WALL_PROBE_FACTOR = 0.9` times `T.min_wall_mm(params)`; `BakeStats.min_wall_mm` (`app/bake.py:252`) is `report.value_of("min_wall")`, the **measured** narrowest width | fail under 0.72 mm |

All four agree with 04 ("min_wall_mm = 2 * nozzle", "fail under min_wall_mm *
0.9") and with each other. `checks.py` imports `MIN_WALL_FAIL_FACTOR` from
`thicken` rather than redeclaring it, so the repair and the gate cannot drift.

`apps/web/lib/warnings.ts` mentions no wall or nozzle at all; the only HUD
string was the one in `CityPreview.tsx`.

### The editor cannot silently start at nozzle 0.2

* `apps/web/lib/contracts.ts` (GENERATED): `DEFAULT_PRINT_PARAMS.nozzle_mm =
  0.4`, `PARAM_RANGES.nozzle_mm = { min: 0.1, max: 1.2, default: 0.4 }`.
* `apps/web/store/editor.ts:172` initial state is `{ ...DEFAULT_PRINT_PARAMS }`;
  `resetParams` (line 228) restores the same object. `applyPreset` writes
  `location` only.
* The only `localStorage` key in the app is `framecraft-theme`
  (`store/editor.ts:239`, read back in `app/layout.tsx`). No params are
  persisted, so a stale session cannot carry a nozzle across a reload.

## Changes made (no behaviour change)

Nothing was broken, so nothing was fixed. What changed is that `2 * nozzle` is
no longer written out by hand in several places:

* `transform.py` / `transform.ts` gained `min_wall_mm(params)`,
  `min_gap_mm(params)`, `min_detail_mm(params)` - 04's three derived
  thresholds in PRINT mm, as named functions. `thresholds_ground_m` and
  `tree_min_radius_mm` now call them on both sides, and
  `checks.validate` uses `T.min_wall_mm(params)`.
* `preview.ts` gained `dilatedNotice(count, thresholds)`, which returns the
  whole HUD clause `"3353 widened to the 18.9 m minimum wall"`.
  `CityPreview.tsx` renders that instead of formatting the number inline, so
  the string is under test.
* `fixtures/parity-expected.json` regenerated: three new `thresholds_mm` keys
  per case. **No existing value changed** (`git diff` on the fixture is 15
  added lines, 0 modified).

The arithmetic is bit-identical (`2.0 * nozzle` then `/ scale`, same operations
in the same order), and it was verified end to end: re-baking the Chicago
preset after the change gives byte-identical stats, warnings and validator
values to the pre-change `artifacts/chicago.json` - 68,692 triangles,
167,624.12441295458 mm^3, min_wall 0.8015771163765992, every check value and
threshold equal.

## Tests added

Python, `services/bake/tests/test_transform.py`:

* `test_the_legal_nozzle_range_is_the_one_the_sweep_covers` - pins the sweep to
  the frozen contract (0.1 and 1.2 accepted, 0.09 and 1.21 rejected).
* `test_min_wall_mm_is_two_nozzles_across_the_whole_legal_range` - 0.1..1.2 in
  0.01 steps: `min_wall_mm == 2 * nozzle`, `min_gap_mm == 1.5 * nozzle`,
  `min_detail_mm == 1 * nozzle`, and `min_wall == 2 * min_detail` at every one.
* `test_ground_thresholds_are_the_print_thresholds_over_the_scale`.
* `test_the_reported_1_to_23571_bake_reads_18_9_m_at_the_default_nozzle` - the
  regression: 1:23,571, `"18.9"` at 0.4, `"9.4"` at 0.2, and `min_detail` at
  0.4 also `"9.4"` (the look-alike, pinned so it cannot be mistaken again).
* `test_stage_one_repairs_to_a_full_wall_and_stage_four_fails_at_nine_tenths` -
  asserts the real constants (`MIN_WALL_REPAIR_FACTOR is 1.0`,
  `MIN_WALL_FAIL_FACTOR == 0.9`, `checks.MIN_WALL_FAIL_FACTOR is
  thicken.MIN_WALL_FAIL_FACTOR`, and that `survives_min_wall`'s default
  `factor` argument *is* the repair constant), brackets the repair target
  behaviourally at 0.95 / 1.05 walls, and reads the Stage 4 threshold off a
  real `checks.validate()` report at five nozzles - never re-deriving it.
  It also asserts the reported `value` is the measured width (a 2-wall bar
  reports ~2 walls), which is what kills H3 for `BakeStats.min_wall_mm`.
* `test_parity_expectation_is_not_vacuous` extended: the fixture's
  `thresholds_mm` must be 04's multiples and the ground thresholds must be
  those over the scale.

TypeScript:

* `apps/web/lib/transform.test.ts`
  `"keeps min_wall at two nozzles across the whole legal range"` - the same
  0.01 mm sweep against the TS implementation, plus the contract's
  `PARAM_RANGES` / `DEFAULT_PRINT_PARAMS` ends; and
  `"agrees on the print-millimetre thresholds, 04's multiples of the nozzle"`
  in the parity block.
* `apps/web/lib/preview.test.ts`
  `"prints min_wall_mm / scale for every parity parameter set"` and
  `"reads 18.9 m at a 0.4 mm nozzle and 9.4 m at 0.2 mm on the 1:23,571 bake"` -
  the exact HUD strings, including the assertion that the clause is *not* the
  half-size look-alike.
* `apps/web/store/editor.test.ts`
  `"starts on the 0.4 mm nozzle and never picks one up from elsewhere"`.

No existing test was weakened or deleted.

## Verify

```sh
cd services/bake && uv run pytest -q                        # 332 passed
cd apps/web && npm test -- --run && npm run typecheck && npm run lint
                                                            # 147 passed, clean
# the shared-math fixture (regeneration is idempotent here)
cd services/bake && FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_transform.py -q
# geometry unchanged end to end
cd services/bake && uv run python -m app.cli bake --preset chicago-loop --out ../../artifacts/chicago.3mf
#   -> ALL CHECKS PASS, 68,692 triangles, 167,624.1 mm^3, min wall 0.802 mm
```

Counts before this task: 327 pytest, 140 vitest. After: 332 pytest, 147 vitest.
