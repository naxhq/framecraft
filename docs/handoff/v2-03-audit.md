# v2-03 audit — frame lettering, ornaments, detail advisor

Adversarial audit of phase V2-P5 (`docs/handoff/v2-03-lettering.md`). Nothing in
this phase was written by the auditor. Everything below was reproduced on this
host (Windows 11, uv + npm, no Docker) on 2026-08-30.

The concurrent parts fixer is editing `assemble.py` / `cli.py` / `checks.py` /
`bake.py`; its in-flight changes are not audited. One number moved under me and
is flagged as churn in note 18.

---

## Gate results on this tree (all green)

| command | result |
|---|---|
| `uv run pytest -q tests/test_lettering.py tests/test_transform.py tests/test_v1_compat.py` | 130 passed, 19.4 s |
| `npx vitest run lib/lettering.test.ts lib/transform.test.ts` | 100 passed |
| `npm run typecheck` | clean |
| `make bake-fixture TEXT=all` | ALL CHECKS PASS, 17.8 s, `lettering` 0.488 mm stroke / 0.765 mm ridge, `base_floor` 2 kinds / 6 probes / worst gap 0 mm² |
| `make validate artifacts/chicago-text.3mf` | ALL CHECKS PASS (from the sidecar alone) |
| `make bake-fixture COLOR=parts TEXT=all` | ALL CHECKS PASS, 24.1 s |

Green does not mean correct: two of the defects below are invisible to this
suite because the tests that should have caught them assert the wrong thing.

---

## Findings

### 1. BLOCKER — the north arrow points `2 × rotation_deg` away from true north

`services/bake/app/geom/transform.py:1819` (`rotation_deg=-float(rotation_deg)`)
and its mirror `apps/web/lib/transform.ts:1685`.

`app/geom/project.py:88-91` rotates the geometry **counter-clockwise** by
`rotation_deg` (`xr = x·cos − y·sin`, `yr = x·sin + y·cos`), which is exactly
what DECISIONS `[P2]` says. Under that map the ground direction of bearing `b`
lands on the model direction `(sin(b − rot), cos(b − rot))`. True north
(`b = 0`) therefore lands on `(−sin rot, cos rot)` — the +y axis rotated CCW by
**+rot**. An arrow drawn pointing +y must be turned by `+rotation_deg`.
Turning it by `−rotation_deg` puts it on the model direction
`(sin rot, cos rot)`, i.e. on ground bearing `2·rot`.

Reproduced twice.

*Analytically*, against `LocalFrame` at Chicago:

| rotation | true north (model deg) | shipped `−rot` | error | alternative `+rot` | error |
|---|---|---|---|---|---|
| 0 | 89.58 | 90.00 | +0.42 | 90.00 | +0.42 |
| 29 | 118.58 | 61.00 | **−57.58** | 119.00 | +0.42 |
| 90 | 179.58 | 0.00 | **−179.58** | 180.00 | +0.42 |

(the residual 0.42° is UTM meridian convergence, not the bug.)

*In the shipped geometry*: baked the `new-york-midtown` preset (rotation 29) via
`app.cli bake` with `north_arrow {enabled, ne, 6 mm}`, sliced the lip at
`lip_top − ENGRAVE_MAX_MM/2`, took the arrow groove nearest the NE corner —
tip at **60.42°** where true north is at **119.66°**, a **59.2° error**. At
rotation 90 the arrow points due south.

Why the suite is silent: `services/bake/tests/test_lettering.py:509-517` places
the glyph with `arrow.placement.rotation_deg` and then asserts the tip is where
*that same rotation* put it. It is a tautology — it cannot fail for any sign.
Nothing in the test tree ever compares the arrow against `LocalFrame`, a
bearing, or the projection at all. `fixtures/lettering-expected.json` pins
`rotation_deg: -29.0` in the three `north-arrow-*-rotated` cases, so the fix has
to regenerate the fixture. DECISIONS `[V2-P5]` ("It is rotated by
`-rotation_deg`, so it points at true north in the printed model") and the
handoff §3 state the same error.

**Fix:** `+float(rotation_deg)` on both sides, regenerate
`fixtures/lettering-expected.json`, and replace the tautological test with one
that projects a point due north through `LocalFrame` and compares.

---

### 2. BLOCKER — with the frame off, an embossed engraving ships as a floating island

`services/bake/app/geom/lettering.py:1129` — `build()` iterates
`layout.engravings` with no `frame_text_available` test.
`transform.py:1803` disables the north arrow when the frame is off and
`transform.py:1828` disables the scale bar, but the engravings list is built
unconditionally at `transform.py:1735-1763` with `refused=False`, and
`transform.py:1784` only appends a warning saying they were skipped.

They are not skipped. Reproduced end to end (Chicago fixture scene,
`frame=false`, one `mode:"emboss"` engraving, depth 1.5):

```
status: done          ← every validator PASS
warning: "the frame is off, so there is no lip to carry 1 edge engraving(s)"
STL bodies: 3         ← the plate plus two letter islands
bounds z: [0.0, 37.0]  base top = 3.0 mm, emboss solid z = [4.80, 6.50]
```

The letters float 1.8 mm above the plate with nothing under them, because
`lip_top` is computed as `base_top + FRAME_LIP_MM` whether or not a lip exists
(`lettering.py:1026`) and `keep` is set to `None` rather than to "nothing"
(`lettering.py:1033`). Engraved text with the frame off is harmlessly inert (the
cutter floats clear of the base and subtracts nothing), so this is emboss-only —
but `mode: "emboss"` is a legal contract value and the default plate is 3 mm.

`validate_lettering` returns `[]` when `frame` is false (`checks.py:863`), so no
Stage 4 row measures the island either. The `bodies` check that would have
caught it (`bodies PASS 1` in the `make validate` table) is a file-level CLI
check and is not part of the report `run_pipeline` marks `done` on.

`tests/test_lettering.py:443` (`test_layout_frame_off_skips_the_lip_ornaments…`)
asserts only the layout's warning and the two disabled ornaments; it never calls
`L.build`.

**Fix:** refuse (or drop) every edge engraving when `frame_text_available` is
false, in `lettering_layout`, so preview and bake agree; add a build-level
assertion that `LetteringGeometry.cut`/`.emboss` are empty with the frame off.

---

### 3. MAJOR — the advisor scores quoted in DECISIONS and the handoff do not reproduce

DECISIONS `[V2-P5]`: *"Measured: Chicago at 900 m scores 80 (good), at 2 400 m
68 (fair), at plate 100 and 3 000 m 35 (poor)."*
`docs/handoff/v2-03-lettering.md` §5 repeats it and adds 1 500 m → 74.

Measured here on the same committed Overpass fixture through the same ingest
path (`presets.chicago-loop` → `normalize.build_scene`):

| case | claimed | actual |
|---|---|---|
| 900 m, plate 180 (**the default preset**) | 80, good | **70, fair** |
| 1 500 m, plate 180 | 74, fair | **61, fair** |
| 2 400 m, plate 180 | 68, fair | **52, fair** |
| 3 000 m, plate 100 | 35, poor | **34, poor** |

Composition at 900 m: widened 370/994 = 37.2 % → 22.33 pts, trees
5 762/5 762 = 100 % → 5.00 pts, areas 360/753 = 47.8 % → 2.39 pts, total penalty
29.72, score 70. The claimed 80 is not reachable from any weighting in the file.

This matters twice: the numbers are the evidence cited for the weights and the
band edges, and the headline claim that the shipped default preset lands in
`good` is wrong — it lands in `fair`. (The one-liner is not shown at `fair`, so
no user-visible behaviour changes; the decision record does.)

Related: every Chicago bake loses 100 % of its trees, so 5 of the 100 points are
a constant offset on the default preset rather than a signal.

---

### 4. MAJOR — the build-time refusal names no working size, and there is a silent preview/print divergence band

`services/bake/app/geom/lettering.py:1062-1069`. The stroke branch of `verify()`
reports the measured width and then says *"try a larger size, a plainer face or
a finer nozzle"* — no number. The handoff §2 step 6 claims the opposite:
*"the piece is REFUSED (nothing cut, warning naming the size that would work)"*.

Reproduced with serif `1:10,714` on the top edge at the default nozzle:

| size | `fit.refused` (what the preview draws from) | cut solids | warning |
|---|---|---|---|
| 3.0 | True | 0 | names 3.47 mm — correct |
| 3.5 | **False** | **0** | "narrowest stroke measured 0.30 mm against the 0.36 mm minimum; try a larger size…" |
| 4.0 | False | 0 | 0.31 mm, same message |
| 4.5 | False | 0 | 0.31 mm, same message |
| 5.0 | False | 0 | 0.30 mm, same message |
| 5.5 | False | 0 | 0.29 mm, same message |
| 6.0 | False | 1 | — |

Five consecutive legal sizes where the editor draws the string, the bake ships
without it, and the message gives the user no size to move to. The measured
width does not even trend toward the threshold as the size grows (0.30 → 0.31 →
0.29), so "try a larger size" is not actionable advice.

The handoff §8 admits a 12-in-150 disagreement rate; on this one string it is
5 of the 6 reachable sizes.

Aggravating: the *counter* branch (`lettering.py:1070-1077`) does name a size,
but it names `fit.min_size_mm` — and that branch can only fire when the layout
already judged the current size to be at or above `min_size_mm`. When it fires
it names a size known not to work.

**Fix:** the build-side refusal should search for and name a size that measures
clean (the same closed-form bracket the layout uses, then a measured bisection),
or the layout should be made conservative enough that the build never
contradicts it.

---

### 5. MAJOR — `CREDITS.txt` denies third-party sources, and the web tree ships derived font outlines with no licence

`artifacts/CREDITS.txt` (written by every bake):

> Elevation, imagery and any other third-party sources: none. FrameCraft uses
> OpenStreetMap data only.

That is now false: three OFL faces are bundled and their outlines are cut into
the printed model. The bake side is correct and complete —
`services/bake/app/fonts/{sans,serif,mono}/OFL.txt` are all genuine SIL OFL 1.1
texts with their copyright lines (Inter 4.001 `40d692fc…`, Source Serif 4.005
`e5a4ee6a…` with Reserved Font Name 'Source', JetBrains Mono 2.304
`a0bf60ef…`), `fsType 0` on all three, none over 412 KB, sha256 and version
recorded in and asserted against the generated metrics.

The web side is not: `apps/web/lib/fonts/{sans,serif,mono}.glyphs.json` is
959 KB of extracted outlines from those three faces, shipped to the browser,
with no accompanying OFL notice — `apps/web/licences/` carries only
`OFL-Archivo.txt` and `OFL-IBM-Plex-Sans.txt` (the UI faces from V2-P4).

**Fix:** name the three faces and their licences in `CREDITS.txt` and the 3MF
Description, and copy the three `OFL.txt` files into `apps/web/licences/`.

---

### 6. MINOR — the deviation's stated justification is quantitatively false

DECISIONS `[V2-P5]`: *"a two-nozzle target merged **every** letter pair of
**every** string tried into one trench"*; `transform.py:797`: *"a two-nozzle
target refuses or smears every string tried"*.

Measured (method and full table in the numbers section below): the strict rule
refuses at essentially the same rate as the shipped rule (11/72 vs 12/76 of the
sizes the auto-fit can reach) and keeps the letters as separate as the shipped
rule at some reachable size for **8 of 12** (face, string) pairs. The claim
holds for 4 of 12 — the short strings with a descender, whose ink height caps
them under ~4.9 mm.

The deviation is still defensible; the argument written down for it is not the
argument the measurements support. See the numbers section for the honest form.

---

### 7. MINOR — `transform.py`'s own numbers for the deviation are stale and disagree with DECISIONS

`services/bake/app/geom/transform.py:797-799` says the one-nozzle target prints
"Chicago" at **5.32 mm with 0.41 mm strokes and 0.48 mm ridges**. DECISIONS
`[V2-P5]` says **5.16 mm / 0.49 mm / 0.77 mm**. The shipped bake measures
**5.16 mm fitted, 0.4875 mm narrowest groove, 0.7649 mm narrowest ridge** —
DECISIONS is right and the code comment is stale.

---

### 8. MINOR — the engraved rim is `margin − 0.02 mm`, not the margin

`lettering.py:1146-1160` clips to `lip_keep_region` and *then* grows the cutter
by `LAYER_SEPARATION_MM` (0.02 mm), so the separation pushes ink back outside
the keep region. DECISIONS `[V2-P5]` claims the clip guarantees "the rim left
between the ink and each edge of the lip is always [the margin]".

Measured on `artifacts/chicago-text.3mf`: the engraved ink reaches ±2.520 mm
across the 6 mm band (rim 0.480 mm, margin 0.500); the embossed engraving, which
is not separated, reaches exactly ±2.500 mm. Harmless — 0.48 mm is still above
one nozzle — but the invariant as written does not hold.

---

### 9. MINOR — the north arrow is clipped, with no auto-fit and no warning

`lettering.py:1189` clips the arrow to `lip_keep_region`, and unlike text the
arrow has no fitting step. Its half-length is `size/2` against a half-band of
`FRAME_WIDTH_MM/2 − margin` = 2.5 mm, so any arrow over 5.0 mm loses its tip —
including the contract maximum of 6.0 mm.

Measured on the rotation-29 New York bake (size 6.0, corner `ne`): the groove
reaches y = 89.520 where the un-clipped tip would be at 89.640, so 0.12 mm of
the point is cut. At rotation 0 a 6 mm arrow loses the full 0.5 mm. Cosmetic,
but it flattens the arrowhead and nothing says so.

---

### 10. MINOR — the underside mark's own strokes and ridges are measured by no Stage 4 row

`checks.py:1283-1284` hands the whole `[0, max pocket depth]` band to
`base_floor`; `lettering_probe_zs` (`checks.py:855`) probes only the frame-lip
bands; `validate_base_floor` (`checks.py:1012`) asks only whether the plate above
each pocket *footprint* is solid, over a rectangle that deliberately
over-covers the letters (`lettering.py:869-873`). Nothing measures the mark's
stroke or ridge widths at Stage 4. Before this phase they were (incorrectly, per
DECISIONS) measured by `min_wall`; now they are measured by nothing.

The gap is narrow — the mark goes through `lettering.build`'s pre-ship
`verify()`, and a sub-nozzle groove on the underside is cosmetic rather than
structural — but DECISIONS `[V2-P5]` says `base_floor` "judges that band
instead", which over-states what it judges.

`tests/test_lettering.py:955`
(`test_validator_min_wall_skips_only_the_underside_band`) does not test the skip:
it builds a model with **no** underside feature and asserts nothing changed. The
skip path itself is untested.

Measured on the shipped bake: `min_wall` reports "narrowest wall 0.802 mm over
1364 regions on 13 slices (1 slice(s) in the underside pocket band are judged by
base_floor instead)" — 1 of 14 slices, so the coverage loss is small.

---

### 11. MINOR — DECISIONS and a code comment misstate the score arithmetic

DECISIONS `[V2-P5]` and `transform.py:2055`: *"widening every building alone is
40 points off, which lands in `poor`"*. With `SCORE_WEIGHT_WIDENED = 60.0` it is
**60 points off**, landing **at** score 40, which is poor. The code is right and
`test_detail_report_score_and_bands` asserts the right inequality
(`100 − 60 < 45`); only the prose is wrong.

Also `transform.py:2270`, `detail_recommendation`'s docstring example
`Radius 2400 m at plate 180 drops 114 buildings and widens 64%. Try 1100 m, or
plate 256.` shows a head clause that the same module's own
`test_04_stage1_rule_3_cannot_fire_after_rule_2` proves is unreachable from any
SceneGraph, with numbers that match nothing in the tree. The handoff §5 example
(`Radius 2400 m at plate 180 widens 65%. Try 540 m.`) is correct — I reproduced
it exactly on the real Chicago scene.

---

### 12. MINOR — the shared fixture pins no "plate-only remedy" sentence

`fixtures/parity-expected.json` has 5 cases: three healthy (`null`), one
both-remedies (`small-plate-fat-nozzle-roads-off`, "Try 450 m, or plate 188.")
and one radius-only (`coarse-radius-for-the-advisor`, "Try 1290 m."). The
plate-only branch (`detail_recommendation`'s third return) is covered by a
Python unit test (`tests/test_transform.py:1185`) but by nothing on the
TypeScript side, so that branch of the mirror's formatting is unpinned. Same for
the "No radius or plate in range fixes it" branch.

---

### 13. NOTE — `bake.token_context(scene, scene_request, params, date)` never uses `scene_request`

`services/bake/app/bake.py:~85`. Dead parameter; every field the context needs
comes from `scene` and `params`.

---

## Groove-width deviation: numbers

**Method.** A faithful re-run of `lettering.build`'s engrave branch with the
stroke target and the ridge floor injected as parameters — same
`repair_text` → `place` → `_clip(lip_keep_region)` → `merge_stroke_ridges` →
`widen_necks` → `separated` sequence, same measures (`thicken.narrowest_width`,
`counter_widths_mm`, `text_area_floor`). SHIPPED = groove target and ridge floor
`min_detail` (0.4 mm). STRICT = both `min_wall` (0.8 mm). Default nozzle 0.4,
plate 180, 6 mm lip → 5.0 mm usable band, 166 mm usable edge. 12 (face, string)
pairs × sizes 3.0–8.0 mm in 0.5 mm steps. Refusal = the exact condition
`build()` applies (lost counter, or narrowest stroke under `0.9 × target`, or
narrowest counter under `0.9 × ridge floor`). Only sizes at or below that rule's
own band cap (`size_for_extent_mm` on the ink height) are counted, because the
auto-fit can never ask for more.

**(a) Refusal rate — the strict rule is not worse.**

| | refusals / reachable sizes | rate |
|---|---|---|
| shipped (groove → 1 nozzle) | 12 / 76 | 16 % |
| strict (groove → min_wall) | 11 / 72 | 15 % |

The shipped rule's 12 are concentrated on the serif: it refuses serif
`1:10,714` at **every** reachable size (3.0–5.5; its band cap is 5.97 and it
only clears at 5.97-6.0). The strict rule accepts that same string at 4.0–5.5
with 6–9 separate pieces. On refusals the strict rule is, if anything, better.

**(b) Letter separation — this is where the strict rule pays.** Connected groove
components at each size (`X` = refused); the shipped rule holds ≈ one component
per inked glyph everywhere.

| face / string | band cap (strict) | strict pieces at 3.0 … 6.0 mm | shipped, same range |
|---|---|---|---|
| sans `Chicago` (7 glyphs) | 4.76 | X, 1, 1, 1 | 7, 8, 8, 8 |
| serif `Chicago` | 4.65 | X, X, 1, 1 | X, 8, 8, 8 |
| mono `Chicago` | 4.83 | 1, 2, 3, 3 | 8, 8, 8, 8 |
| serif `NEW YORK` (8) | 6.62 | 2, 2, 2, X, 2, X, X | 5, 6, 7, 7, 7, X, X |
| sans `1:10,714` (8) | 5.08 | X, 3, 7, 8, 8 | 9, 9, 9, 9, 9 |
| sans `41.8827 N` (9) | 6.33 | X, 4, 6, 8, 7, 8, 8 | 8 throughout |
| sans `NEW YORK` | 6.31 | 2, 3, 2, 3, 4, 6, **7** | 6, 7, 7, 7, 7, 7, 7 |
| serif `1:10,714` | 5.56 | X, 2, 6, 7, **9**, **9** | X, X, X, X, X, X |
| serif `41.8827 N` | 6.78 | X, X, 2, 5, 6, **8**, **8** | 7, 8, 8, 8, 8, X, X |
| mono `1:10,714` | 5.17 | 6, 7, **9**, **9**, **9** | 10, 9, 9, 10, 10 |
| mono `NEW YORK` | 6.20 | 2, 2, 3, 3, 3, 6, **7** | 7, 6, 7, 7, 7, 7, 7 |
| mono `41.8827 N` | 6.31 | 4, 6, 5, 7, **8**, **8**, **8** | 8 throughout |

**4 of 12** pairs are a single trench (or near it) at *every* size the 6 mm lip
can hold: `Chicago` in all three faces and serif `NEW YORK`. **8 of 12** reach a
size where the strict rule is as separated as the shipped one. The four that
fail are exactly the strings whose ink height (a descender, `g`/`Y`) caps them
under about 4.9 mm, where a 0.8 mm target eats most of an already-small
inter-letter gap.

**(c) The size the strict rule would name, and whether the lip can hold it.**
`text_min_size_mm` at the `min_wall` target versus that string's strict band cap:

| face | strings | strict min_size | strict band cap | fits? |
|---|---|---|---|---|
| sans | 4 | 3.31 – 4.63 | 4.76 – 6.33 | 4 / 4 |
| serif | 4 | 4.02 – 5.59 | 4.65 – 6.78 | 3 / 4 — serif `Chicago` needs 5.08 against a 4.65 cap |
| mono | 4 | 3.77 – 4.25 | 4.83 – 6.31 | 4 / 4 |

So **11 of 12** named sizes do fit a 6 mm lip. But clearing the counter rule is
not the same as keeping letters apart: at sans `Chicago`'s strict minimum of
4.61 mm the whole word is still one trench.

**(d) Is a one-nozzle groove physically resolvable at a 0.4 mm nozzle?**
04 itself defines `min_detail_mm = 1.0 * nozzle` as the "below this, drop it"
floor, so one nozzle is this project's own declared resolvable detail and the
deviation is internally consistent. In slicer terms (PrusaSlicer / Bambu Studio,
Arachne): the perimeter generator runs on the *solid*, so the two walls flanking
the groove each get their own loop and the modelled 0.4 mm void survives into
the toolpath — the slicer does not close it. What narrows it is extrusion: a
0.4 mm nozzle lays a bead of roughly 0.42–0.45 mm and the plastic spreads, so
the printed groove reads as a visible line typically 0.25–0.35 mm across rather
than a clean-walled 0.4 mm channel. Legible, not crisp. An 0.8 mm groove is
unambiguously crisp. This is a print-quality judgement neither I nor the
engineer can settle without hardware (handoff §8 says as much).

**(e) Recommendation to the orchestrator.** Keep the deviation, correct the
justification. The measured cost of the strict rule is **not** refusals (15 % vs
16 %) — it is letter separation, and only for strings whose ink height caps the
auto-fit under about 5 mm; for those the whole word becomes one trench at every
size a 6 mm lip permits. If a stricter groove is wanted later, the shape that
the numbers support is per-string rather than global: take `min_wall` grooves
when the fitted size clears the strict minimum **and** the measured component
count still matches the glyph count, and fall back to one nozzle otherwise, with
the existing `lettering` row measuring whichever was used. One flag either way:
under the shipped rule the G6 fixture's left engraving (serif `1:10,714`) is
accepted only at 5.97 mm, which is its band cap to the hundredth — a 0.01 mm
smaller fit refuses it. It is the most fragile piece in the fixture.

---

## Verified clean (no defect)

14. **Placement matches the layout in the shipped mesh.** Sliced
    `artifacts/chicago-text.stl` at both engraved bands and the embossed one and
    projected the ink onto each edge's (axis, up) frame: along-edge and
    across-band extents agree with `lettering_layout` to ≤ 0.48 mm (right-side
    bearing plus the 0.02 mm separation). Rotations are 0 / 0 / +90 / −90 as
    specified — top and bottom upright, left bottom-to-top, right top-to-bottom,
    feet toward the picture, which is right for a wall-hung frame. 16 open
    counters at the engraved band. The scale bar takes the start of the bottom
    edge and the `{coords}` engraving lays out in what is left, exactly as
    designed. Narrowest groove **0.4875 mm** (≥ 0.4), narrowest lip ridge
    **0.7649 mm** (≥ 0.72), narrowest embossed stroke **0.800 mm**.
15. **Hanger boundaries are exactly the 1.0 mm rule.** keyhole: refused at 2.90
    and 2.99 mm with a message naming 3 mm, allowed at exactly 3.00 (1.000 mm of
    floor left). magnets: refused at 4.00, 4.05, 4.09, allowed at exactly 4.10.
    `validate_base_floor` uses the same predicate and flips at the same
    boundary. Mark ∩ pockets = 0.0000 mm²; mark clears the plate edge by
    2.60 mm (chamfer 0.6) and 17.05 mm with magnets; keyhole sits 6.00 mm inside
    the top edge at plates 100 / 180 / 256; mark depth 0.3 < base − 1.0 in every
    case the bake allows. With the default 0.6 mm road engraving the composite
    rule needs 3.6 mm (keyhole) / 4.7 mm (magnets), which is why the fixture
    bakes at 4 mm.
16. **Both new validators genuinely fail.** Independently built corrupt meshes:
    `lettering` fails a lip ridge at 0.30 / 0.35 / 0.36 mm and passes at 0.38;
    fails a groove at 0.20 / 0.35 / 0.36 and passes at 0.40 (threshold
    0.9 × min_detail = 0.36). `base_floor` fails a 2 mm keyhole in a 2.5 and a
    2.9 mm plate, passes at 3.0, and catches a pocket cut right through.
17. **The layout refusal path is clean and names sizes that work.** Twelve
    (face, string) pairs forced to refuse at 1.5 mm: all shipped **nothing**
    (0 cut solids, 0 emboss, empty `measures`, one warning), and re-running at
    the size the message named was accepted and cut in all twelve — e.g. sans
    `e` refused at 1.50 naming 3.33 mm, cut at 3.33. No half-cuts.
18. **The parity fixture is strictly additive.** Semantic diff of
    `fixtures/parity-expected.json` against `HEAD`: 0 keys removed, **0 existing
    values changed**; the 166 deleted lines are all comma-only reflows. Cases
    3 → 5, and the 20 new `parity-scene.json` footprints do not move any
    existing row. Test integrity: `git diff -- '*test*'` removes five assertions,
    every one replaced by an equal-or-stronger one (`len(cases) == 3` → `== 5`,
    the `model_too_tall` list → three explicit asserts, `PRINT_PARAMS_EXAMPLE`
    equality → a subset equality plus an exact v2-field-set assertion). No
    `skip`, `xfail`, or `.only` anywhere in the new suites.
19. **`recommend_radius_m` is a real solve.** It sweeps the 10 m grid downward
    from the current radius to the 250 m floor and returns the first candidate
    under the target — the largest satisfying radius whether or not the
    fraction is monotone. It is in fact monotone by construction
    (`min_wall_ground ∝ radius` over a fixed footprint set): 0 non-monotone steps
    over 216 samples on the real Chicago scene. `recommend_plate_mm` sweeps
    2 mm upward over [100, 256] at the current radius. Score formula: all
    fractions 0 → 100; everything dropped → 0; everything widened → 40 (poor).
    Bands ≥75 good / ≥45 fair / else poor. One caveat, not a defect: neither
    search re-crops the scene to the candidate radius, so the fraction it
    reports is "the same buildings printed at a finer scale" rather than the
    fraction after the crop.
20. **Preview/print outline divergence is under a tenth of a nozzle.**
    `apps/web/lib/fonts/*.glyphs.json` is flattened once at
    `GLYPH_ASSET_SIZE_MM = 8.0`, i.e. at `0.02 · upem / 8` font units; drawn at
    size `S` its print-space chord error is `0.02 · S/8` ≤ 0.02 mm, while the
    bake re-flattens at exactly 0.02 mm for the real `S`. Both bound the same
    curve, so the two polygons differ by at most `0.02 + 0.0025·S` mm — 0.033 mm
    at the fixture's 5.16 mm fit, 0.040 mm at the 8 mm maximum. Contours are
    rounded to 1e-3 font units (≈ 4 nm of print). The preview is the *finer*
    approximation at every size under 8 mm.
21. **Fonts and assets.** Three genuine OFL faces, unmodified static regulars,
    `fsType 0`, 412 / 274 / 262 KB (none near 2 MB), version and sha256 recorded
    in and asserted against the metrics, 190 codepoints per face, metrics
    byte-identical in both trees, glyph JSON produced by the committed
    deterministic generator. No proprietary face. (Licence *placement* is
    finding 5.)
22. **Composition and timing.** `TEXT=all` 17.8 s / 89,466 triangles;
    `COLOR=parts TEXT=all` 24.1 s, ALL CHECKS PASS, 6 parts. `make validate` on
    the 3MF reproduces `lettering` and `base_floor` from the sidecar alone.
    No stray files: `fixtures/` holds only Overpass sha caches and the pinned
    fixtures, `services/bake/scripts/` holds only `gen_font_assets.py`,
    `artifacts/` is gitignored.
23. **Churn.** `parts_union` now reads 199,812.6339 vs 199,812.6339 mm³ where
    the handoff recorded 199,812.6434 vs 199,812.6339 — the concurrent parts
    fixer is editing `assemble.py` / `bake.py`. Not audited here.

---

**AUDIT: 12 DEFECTS (2 blocker, 3 major)**

---

## Resolution (mesh-bake, 2026-08-30)

Both blockers, all three majors and all eight minors are addressed, each with a
regression test. Finding 8 is a corrected record plus a newly pinned invariant
rather than a geometry change, for the reason given under its heading. Nothing was weakened, skipped or deleted to make a gate
pass. Decisions are the `- [V2-P5-fix]` lines in `DECISIONS.md`; the numbers and
the new size table are in `docs/handoff/v2-03-lettering.md` (§5, §8, §8a, §10).

### 1. BLOCKER — north arrow — FIXED

`transform.py` and `transform.ts` both turn the arrow by `+rotation_deg`.
`test_ornament_north_arrow_points_at_true_north` derives north from the
projection itself (`LocalFrame.point_to_local` on a point 0.01 deg further
north), compares compass bearings at rotations 0/29/90/180/271 within 1.0 deg of
UTM meridian convergence, and asserts the opposite sign fails at every angle
that is not a multiple of 180. The TS unit test that pinned `-29` was replaced
by one that walks the same five angles. `fixtures/lettering-expected.json` pins
`rotation_deg: 29.0`.

### 2. BLOCKER — frame-off emboss ships — FIXED

Three separate holes, all closed:

* the shared layout now REFUSES each engraving when the frame is off
  (`refused=True` with a reason naming the remedy) instead of handing back an
  accepted fit beside a warning — that `refused=False` is what `build()` read;
* `lettering.build` checks `params.frame` itself, so the arrow, the bar and
  every engraving are skipped even from a forged layout
  (`test_build_frame_off_builds_no_lip_geometry_even_from_a_forged_layout`);
* **why three bodies passed:** the bake had no `bodies` row in single mode at
  all. 01/A6's one-connected-solid rule lived only in `app/cli.py`, i.e. only
  under `make validate`. `checks.single_body_check` is now shared, the bake
  appends it in BOTH modes, and the CLI delegates to it
  (`test_bodies_row_names_a_floating_island`,
  `test_bake_with_the_frame_off_ships_no_floating_letters`).

The frame-off case still emits exactly ONE warning: the per-engraving "was not
cut" lines are folded into the summary that names them all.

### 3. MAJOR — advisor scores — FIXED (record corrected, code kept)

Reproduced exactly, including the audit's mid-radius numbers: the audit held the
scene at its 900 m crop and varied only the advisor's radius, which is the
reproducible path on the committed fixture. **70 / 61 / 52 / 34**, pinned by
`test_detail_advisor_scores_on_the_real_preset`, and the composition of the 70
by `test_detail_advisor_score_composition_on_the_default_preset`. The weights
and band edges are unchanged: the numbers were wrong, the scale was not.
`DECISIONS`, the handoff §5 and two code comments are corrected on both sides of
the mirror.

Confirmed and documented: every OSM tree in this fixture is the normalizer's
default 4 m crown, 0.37 mm of radius at 1:10,714, under the 0.5 mm floor — the
bake really does print none of them, so the 5-point tree term is honest but
constant on this preset.

One correction to the audit's own wording: the bake is quiet at `fair`
(`_detail_advice` gates on the band), but `detail_recommendation` — what the
editor HUD shows — gates on the widened fraction and does speak on the default
preset: `Radius 900 m at plate 180 widens 37%. Try 540 m.` That sentence is
pinned too.

### 4. MAJOR — refusal names no working size — FIXED

The refusal now names a size the geometry was MEASURED at, through the identical
chain the real cutter goes through, separation included: a widening ladder
(+0.25 … +6.0 mm, capped at the contract's 8 mm) then a 0.05 mm walk back down.
Serif `1:10,714` at 3.5 mm reports `it prints at 5.75 mm`, which is exactly
where the brute-force sweep says it starts cutting; serif `Wrigley Field` at
3.5 mm reports 3.80 mm. When nothing works it says `no size up to X mm` with X
the largest size actually tried. The counter branch goes through the same search
instead of naming `fit.min_size_mm`. Bounded at 21 probes, memoised per fitted
size, run only on the refusal path (0.5–4 s; a successful bake pays nothing).

**On the divergence band itself.** The audit's alternative — make the layout
conservative enough that the build never contradicts it — is not reachable: the
layout predicts from per-glyph metrics and the geometry measures a groove after
`merge_stroke_ridges` has bridged whatever sub-nozzle ridges the *string*
contains, which is not a function of any per-glyph number. Measuring the
pre-separation copy WAS tried (it agrees with the layout on all 24 pairs) and it
is wrong: it ships serif `1:10,714` at 3.5 mm on a 0.412 mm reading, and then
Stage 4's `lettering` row measures the groove that was really cut at 0.303 mm
and the whole bake fails. A refused string costs one string; a failed bake costs
the model. Re-measured over the strings a user actually types, the band is 2 of
24 (face, string) pairs, both on the modulated serif — see the table below.

### 4b. The default `size_mm`, measured

3 faces × 8 strings × sizes 2.00–8.00 in 0.25 steps, 6 mm lip, default nozzle,
plate 180, top edge, engraved. Smallest size that produces a cutter:

| string | sans | serif | mono |
|---|---|---|---|
| `CHICAGO` | 3.25 | 3.75 | 3.75 |
| `Chicago` | 3.25 | 3.50 | 3.00 |
| `1:10,714` | 3.25 | **5.75** | 2.50 |
| `41.8827, -87.6233` | 3.25 | 3.75 | 2.75 |
| `2026-08-30` | 2.50 | 3.25 | 2.75 |
| `Chicago 2026` | 3.25 | 3.50 | 3.00 |
| `N` | 2.00 | 2.00 | 2.00 |
| `Wrigley Field` | 3.50 | 4.00 | 3.50 |

Layout and build agree exactly on 22 of the 24; the exceptions are serif
`1:10,714` (layout from 3.50, bake from 5.75) and serif `Wrigley Field` (3.50 /
4.00).

At the old default of 3.0 mm the DEFAULT face refuses six of these eight
strings. The contract default is raised to **4.0 mm** — 3.75 is the smallest
step that works everywhere except serif `1:10,714`, and two thresholds sit
exactly at 3.75 while printability is not monotonic in the size, so 4.0 takes
one step of margin. Changed in the schema and regenerated with `make contracts`;
`transform.ts`'s mirror is pinned against `PARAM_RANGES` by a new test.
`fixtures/print-params-default.json` is unaffected (a default `PrintParams`
carries no engravings) and G8 is unaffected (v1 had no lettering).

### 5. MAJOR — CREDITS and the web glyph assets — FIXED

`CREDITS.txt` scopes its "no third-party sources" denial to MAP DATA and lists
Inter 4.001, Source Serif 4 4.005 and JetBrains Mono 2.304 with their copyright
lines and the OFL; `export.FONT_CREDITS` is asserted against the generated
metrics and the bundled OFL headers, so it cannot go stale. The 3MF
`LicenseTerms` and `Description` carry a one-line form, but only when text was
actually cut. `scripts/gen_font_assets.py` copies each `OFL.txt` into
`apps/web/licences/` in the same run that regenerates the outlines;
`apps/web/lib/fonts/README.md` and the licences README name the three faces.

### 6, 7. MINOR — the deviation's justification — REWRITTEN

Per the ORCHESTRATOR RULING the one-nozzle engraved groove is KEPT and the
justification is replaced with the audit's own measurements, on both sides of
the mirror and in an appended `- [V2-P5-fix]` line (the original `[V2-P5]` line
is untouched — `DECISIONS.md` is append-only). The stale 5.32 / 0.41 / 0.48
figures are replaced by the measured 5.16 mm / 0.4875 mm / 0.7649 mm.

### 8. MINOR — the engraved rim — RECORD CORRECTED, INVARIANT PINNED

Reproduced: engraved ink reaches 89.520 mm and embossed 89.4983 mm on a 180 mm
plate with a 0.5 mm margin. The geometry is left alone deliberately — insetting
the keep region by the separation would move every engraved glyph and would put
the G6 fixture's most fragile piece (serif `1:10,714`, accepted at its band cap
to the hundredth) at risk for a 0.02 mm cosmetic gain. The true invariant is
pinned tightly by `test_build_engraved_rim_is_the_margin_less_the_separation`.

### 9. MINOR — the clipped arrow — FIXED

Auto-fitted to the band, bounded by the glyph's circumradius rather than its
length (the base corner is further from the centre than the tip, so a
length-bounded arrow still crossed the keep region at rotation 29). Cap 4.287 mm
on a 6 mm lip; a larger request is reduced with a warning naming both numbers.
Mirrored in TS and pinned by the existing `north-arrow-nw-rotated` fixture case,
which asked for 6.0 mm and now records 4.287465 plus the warning.

### 10. MINOR — the underside mark's own strokes — FIXED

The `lettering` row probes the underside band at half the mark's depth with the
same floors it uses on the lip, clipping to the slice's own outline with its
holes filled so the chamfer is not read as a perimeter groove. Measured on a
bake with a mark and a keyhole: 2 text bands, 40 strokes, narrowest 0.490 mm.
`test_validator_min_wall_skips_only_the_underside_band` now builds a model that
HAS a pocket, and a deliberately 0.12 mm groove on the underside fails the row
with `underside stroke ...`. `min_wall`'s message says the skipped slice goes to
`base_floor and lettering`.

### 11. MINOR — score arithmetic prose — FIXED

"40 points off" is 60 points off, landing AT 40, in `DECISIONS` (corrected by an
appended line) and in both mirrors. `detail_recommendation`'s docstring example
is replaced by `Radius 2400 m at plate 180 widens 65%. Try 540 m.`, reproduced
here on the committed fixture, with a note that the "drops N buildings" clause
is kept because the rule that would fire it is 04's.

### 12. MINOR — unpinned advisor sentences — FIXED

`fixtures/parity-expected.json` has two new cases,
`plate-only-remedy-at-the-minimum-radius` and `no-remedy-fat-nozzle`, so all
three remedy shapes are pinned on both sides. Found while adding them: a case
whose `params` omits a field is read by the TS side as `undefined` (it has no
model defaults), which silently changed the scale — every case spells every
field out.

### 13. NOTE — dead parameter — FIXED

`bake.token_context(scene, params, date)`.

### Also fixed here (handed over from the v2-06 audit, finding 9)

`lib/transform.test.ts` derived each parity case's `radius_m` from the
expectation it then asserted against. Cases carry `radius_override` now (null
unless the case deliberately asks about another radius) and the mirror derives
the rest with its own `radius_m_from_bounds`.

### Gates re-run on this tree

| gate | command | result |
|---|---|---|
| full Python suite | `cd services/bake && uv run pytest -q` | 591 passed, 0 skipped |
| G8 | `uv run pytest tests/test_v1_compat.py` | 11 passed |
| G6 | `make bake-fixture TEXT=all` | ALL CHECKS PASS, 35.73 mm |
| G5 (180) | `make bake-fixture COLOR=parts && make validate FILE=artifacts/chicago-parts.3mf` | ALL CHECKS PASS, 6 parts |
| G5 (256) | `make bake-fixture COLOR=parts PLATE=256 && make validate …` | ALL CHECKS PASS, 7 parts |
| parts + text | `make bake-fixture COLOR=parts TEXT=all && make validate FILE=artifacts/chicago-parts-text.3mf` | ALL CHECKS PASS |
| web unit | `cd apps/web && npx vitest run` | 531 passed (27 files) |
| types | `cd apps/web && npm run typecheck` | clean |
