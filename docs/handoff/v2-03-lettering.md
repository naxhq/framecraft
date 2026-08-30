# v2-03 — Frame lettering, ornaments and the detail advisor

Phase V2-P5 (mesh-bake). Everything below is implemented, tested and green on
this host. Decisions are logged as `- [V2-P5]` lines in `DECISIONS.md`; this
note is the *how it works and what to consume* companion.

---

## 1. The fonts

Three OFL faces, bundled as the **static regular TTF exactly as published**,
each with its licence next to it. Nothing is subsetted or re-generated, so the
sha256 in the metrics asset identifies the upstream file.

| face | file | version | sha256 (16) | upem | source |
|---|---|---|---|---|---|
| `sans` | `Inter-Regular.ttf` | `4.001;git-9221beed3` | `40d692fce188e447` | 2048 | <https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip> → `extras/ttf/Inter-Regular.ttf`, licence `LICENSE.txt` |
| `serif` | `SourceSerif4-Regular.ttf` | `4.005;hotconv 1.1.0` | `e5a4ee6a3d87bb90` | 1000 | <https://github.com/adobe-fonts/source-serif/releases/download/4.005R/source-serif-4.005_Desktop.zip> → `TTF/SourceSerif4-Regular.ttf`, licence `LICENSE.md` |
| `mono` | `JetBrainsMono-Regular.ttf` | `2.304; ttfautohint (v1.8.4.7)` | `a0bf60ef0f83c5ed` | 1000 | <https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip> → `fonts/ttf/JetBrainsMono-Regular.ttf`, licence `OFL.txt` |

They live in `services/bake/app/fonts/<face>/` (TTF + `OFL.txt`). All three are
SIL Open Font License 1.1; `test_font_files_and_licences_are_bundled` asserts
the licence is present and says so. 947 KB of font in total.

`fonttools` was added to `services/bake/pyproject.toml` (`uv add fonttools`,
4.63.0). It is the only new dependency.

### Generated assets

`services/bake/scripts/gen_font_assets.py` (committed, deterministic) writes:

* `apps/web/lib/fonts/<face>.metrics.json` **and**
  `services/bake/app/fonts/<face>.metrics.json` — byte for byte identical, so
  neither tree reaches into the other at runtime. Per codepoint: `adv`, `stem`
  (dominant stroke), `counter` (narrowest counter, or null), `top`/`bot`/`left`/
  `right` (ink extents). All in FONT UNITS. 190 codepoints per face: printable
  ASCII + printable Latin-1 + the degree sign.
* `apps/web/lib/fonts/<face>.glyphs.json` — flattened contours per glyph, in
  font units, counters marked as holes, flattened at the contract's maximum
  8 mm size (the finest any legal engraving asks for). ~280 KB per face; **the
  web phase should `await import()` the face it needs**, not static-import all
  three, or the client bundle grows by 850 KB.

Regenerate with `cd services/bake && uv run python scripts/gen_font_assets.py`.
Three tests keep the assets honest: the two metrics copies must be identical,
every number must re-derive from the TTF, and the committed contours must equal
what `gen_font_assets.glyph_parts` produces today.

---

## 2. What the bake does with text

`services/bake/app/geom/lettering.py`. Units are FONT UNITS or PRINT MM — never
ground metres: a letter is a printed object and the map scale does not touch it.

1. **Outlines** — `fontTools` `BasePen` (which decomposes composites) with a
   flattening pen. Beziers are flattened at **0.02 mm of PRINT tolerance**, so
   the chord count follows the printed size (`flatten_tolerance_units`).
2. **Nesting** — contours become polygons by CONTAINMENT DEPTH, so counters come
   out as holes in every face. A representative-point test gets `o` wrong and
   produces an empty glyph; this is tested for `o a e 8 B` × 3 faces.
   `counter_regions` subtracts anything standing *inside* a hole, which is what
   makes JetBrains Mono's dotted zero measure its real ring.
3. **04 stage 1, per glyph** (`repair_text`): dilate by `(target − stroke)/2`,
   snap to the 0.01 mm print grid, widen the terminals
   (`thicken.widen_thin_parts`), put the counter cores back, drop what is under
   `min_detail²`, measure with `thicken.narrowest_width` — the Stage 4 gate's
   own measure.
4. **Place and clip** — `place()` (mirror → rotate → translate) then clip to
   `lip_keep_region` (the band minus the text margin), which is what guarantees
   the rim between the ink and the lip edge.
5. **Ridges** — for engraved text, `merge_stroke_ridges` hands every ridge under
   one nozzle to the groove using `thicken.merge_recess_ridges` itself; the
   bridge it leaves is re-widened to the stroke target.
6. **Verify** — the finished geometry is measured again and the piece is
   REFUSED (nothing cut, warning naming the size that would work) if the
   narrowest stroke or counter does not hold.
7. **Solids** — engrave: a 0.02 mm round-joined separation, extruded from
   `lip_top − depth` to `lip_top + 0.5`. Emboss: from `lip_top − 0.2`
   (04's own overlap) to `lip_top + depth`. Underside: from `−0.5` to `depth`.

### The stroke targets (deviation from the brief, deliberate)

| | target | Stage 4 floor |
|---|---|---|
| engraved stroke (a void) | **1 nozzle** (`min_detail`) | `0.9 × min_detail` |
| embossed stroke (material) | **2 nozzles** (`min_wall`) | `0.9 × min_wall` |
| lip ridge between strokes | — | `0.9 × min_detail` |

The brief asks for `min_wall` on every stroke. Measured on this tree: a
two-nozzle target on an engraving merges **every** letter pair of every string
at every size a 6 mm lip can hold (the natural inter-letter gap is ~0.5 mm and
the dilation eats 0.4 mm of it), and leaves the rim between the text and the
lip edge at 0.11 mm. A groove is a void: what must be laid down is the material
around it — the same reasoning 04 already applies to the road layer, which is
not stripped of its thin parts and whose complement is measured instead. So
engraved strokes get one nozzle and embossed ones keep 04's two perimeters. See
`DECISIONS.md` `[V2-P5]` for the full argument and the numbers.

---

## 3. The shared layout math

`services/bake/app/geom/transform.py` ⟷ `apps/web/lib/transform.ts`, identical
snake_case names, pinned by `fixtures/lettering-expected.json`.

**The web phase consumes these** (all print mm, plate centred at (0,0), +y = the
north edge):

```
lettering_layout(params, ctx, rotation_deg) -> LetteringLayout
lettering_layout_json(params, ctx, rotation_deg)      # the pinned dump shape
  .engravings[]  {index, edge, align, mode, depth_mm,
                  placement {anchor_x, anchor_y, rotation_deg, mirror_x},
                  fit {face, text, dropped, requested_mm, size_mm, width_mm,
                       ink_top_mm, ink_bottom_mm, dilation_mm, stroke_mm,
                       min_size_mm, gap_size_mm, refused, reason, warnings}}
  .north_arrow   {enabled, corner, size_mm, placement}
  .scale_bar     {enabled, edge, length_m, label, bar_mm, thickness_mm,
                  tick_mm, span_mm, placement, label_fit, warnings}
  .underside_mark{enabled, depth_mm, placement, fit}
  .warnings[]
```

Supporting functions the editor will want directly:

```
frame_text_available(params)          # false with the frame off
hanger_min_base_mm(hanger)            # pocket + 1 mm
underside_mark_min_base_mm()
underside_min_base_mm(params)         # ... composed with the deepest recess
                                      #     -> THE number the bake refuses on
keyhole_center_mm(params) / magnet_centers_mm(params) / underside_band_mm
edge_axis / edge_up / edge_band_center_mm / edge_usable_mm / edge_band_mm
fit_text(face, text, requested, available, band, params, what, mode)
text_min_size_mm / text_gap_size_mm / text_stroke_target_mm / text_dilation_mm
text_advance_em / text_ink_em / text_stem_em / text_gap_em / filter_text
font_metrics(face)                    # the generated table
scale_bar_auto_length_m / scale_bar_label / scale_bar_candidates
```

To DRAW a piece of text the preview needs: `fit.text` (already token-expanded
and filtered), `fit.size_mm`, the glyph contours from
`apps/web/lib/fonts/<face>.glyphs.json` scaled by `size_mm / units_per_em`, laid
out along +x by `adv`, then mirrored (`placement.mirror_x`), rotated
(`placement.rotation_deg`, CCW) and translated to the anchor. That is exactly
what `lettering.place()` does on the bake side.

### Conventions

* **Edges** — top/bottom upright (0°), left reads bottom-to-top (+90°), right
  reads top-to-bottom (−90°); the letters on the side edges stand with their
  feet toward the picture.
* **Baseline** — the string's own ink block is centred across the band; the
  margin to each band edge is `max(0.5 mm, one nozzle)`.
* **Align** — `start`/`center`/`end` along the reading direction, within the
  usable edge (plate − 2 × 7 mm of corner reserve), less whatever the scale bar
  has taken.
* **Auto-fit** — shrinks for the edge length AND for the 6 mm band, floors onto
  a 0.01 mm grid, warns naming the fitted size, never clips. Below the
  contract's 1.5 mm it refuses.
* **North arrow** — a two-triangle arrowhead in the chosen lip corner, rotated
  by `−rotation_deg` so it points at true north; engraved.
* **Scale bar** — takes the START of its edge (the edge is split; an engraving
  there lays out in what is left). Automatic length is the longest 1-2-5 round
  number of ground metres printing between 15 and 40 mm; a `fixed` length
  outside that window is replaced and warned about.
* **Underside mark** — mono, 6 mm, centred on the bottom face, MIRRORED in x,
  0.3 mm deep, clear of the chamfer and the magnet pockets.
* **Hanger** — keyhole: 8 mm round entry + 4 mm slot toward the top edge, 2 mm
  deep. Magnets: four ⌀6.1 × 3.1 mm pockets 12 mm in from each edge.

### Refusals and warnings

| condition | outcome |
|---|---|
| counter would close (`fitted < text_min_size_mm`) | **REFUSED**, message names the size that works |
| does not fit even at 1.5 mm | **REFUSED**, names the size it would need |
| letters would touch (`fitted < text_gap_size_mm`) | warning only (the gap is a wedge; the tip is merged) |
| shrunk to fit | warning naming the fitted size |
| unsupported characters | dropped, warning naming them |
| frame off | every lip piece **REFUSED** (`fit.refused`), one warning listing them |
| north arrow larger than the band | fitted to `north_arrow_max_size_mm`, warning naming both sizes |
| geometry does not hold after the repair | **REFUSED** by the bake, with the measured width AND a size the bake has measured to work (`it prints at 5.75 mm`), or `no size up to X mm` |
| base too thin for the pockets | **BakeError** — status failed, nothing shipped |

---

## 4. The Stage 4 rows (additive)

`app/validate/checks.py`. Both rows appear **only when the parameters ask for
the feature**, so every v1 report keeps exactly the rows it had.

* **`lettering`** — slices the mesh in the middle of each text band
  (`lip_top − depth/2` engraved, `lip_top + depth/2` embossed, and
  `UNDERSIDE_MARK_DEPTH_MM/2` for the underside mark), clips to the lip's own
  footprint (for the underside, to the slice's own outline with its holes
  filled, so the chamfer is not read as a groove), and measures every stroke and
  every complement ridge with
  `thicken.narrowest_width` against the table above. Fails on the corrupt
  meshes in `test_validator_lettering_fails_a_stroke_thinner_than_a_nozzle`,
  `..._fails_a_ridge_thinner_than_a_nozzle` and
  `..._holds_the_embossed_rule_to_a_full_wall`.
* **`base_floor`** — for every underside pocket (mark, keyhole, magnets), the
  arithmetic (`underside_min_base_mm`) *and* three slices inside the millimetre
  above the pocket, each asserting the pocket's footprint lies inside the solid.
  The slices are what catch a lake or a road engraving eating the roof from the
  top. Fails on the two corrupt meshes in
  `test_validator_base_floor_fails_when_a_pocket_breaches_the_plate` and
  `..._catches_a_recess_eating_the_roof`.
* The `min_wall` probe now **skips the underside pocket band** (and says so in
  its message) because its "does this persist one layer up?" test cannot judge a
  pocket cut from below. `base_floor` judges whether the plate above each pocket
  is still solid and `lettering` measures the mark's own strokes and ridges
  there; between them the band is covered. With no underside feature nothing
  changes.

---

## 5. The detail advisor

`transform.py` / `transform.ts`, computed from the SAME shared predicates the
preview draws with (`building_dilation_m`, `building_dropped`, `area_dropped`,
`tree_visible_for`).

```
detail_report(scene, params, radius_m) -> {buildings_total, widened, dropped,
    widened_fraction, dropped_fraction, trees_total, trees_dropped_fraction,
    areas_total, areas_dropped_fraction, min_wall_ground_m, score, band}
recommend_radius_m(scene, params, radius_m, max_widened_fraction=0.25)
recommend_plate_mm(scene, params, radius_m, max_widened_fraction=0.25)
detail_recommendation(scene, params, radius_m) -> str | null
```

**Score** — `100 − (100·dropped + 60·widened + 5·trees + 5·areas)`, clamped
0..100. Bands: **≥75 good, ≥45 fair, else poor**.

**Measured** on the committed Chicago fixture through the real ingest path
(`presets.chicago-loop` → `normalize.build_scene`), the scene held at its 900 m
crop and only the advisor's `radius_m` varied — the four numbers are pinned by
`test_detail_advisor_scores_on_the_real_preset`:

| case | score | band |
|---|---|---|
| 900 m, plate 180 (**the shipped default preset**) | **70** | fair |
| 1 500 m, plate 180 | 61 | fair |
| 2 400 m, plate 180 | 52 | fair |
| 3 000 m, plate 100 | 34 | poor |

Composition of the 70: widened 370/994 = 37.2 % → 22.33, trees 5 762/5 762 =
100 % → 5.00, areas 360/753 = 47.8 % → 2.39, dropped 0 → 0.00; penalty 29.72.

An earlier version of this section and of `DECISIONS [V2-P5]` claimed 80/74/68/35
and that the default preset lands in `good`. It does not: it lands in **fair**,
and no weighting in the file reaches 80 from those counts (v2-03 audit, finding
3). Nothing user-visible changes — the bake only speaks at `poor` — but the
record did. Note also that every OSM tree in this fixture is the normalizer's
default 4 m crown, which is 0.37 mm of radius at 1:10,714 and under the 0.5 mm
floor, so *all* of them drop and 5 of the 100 points are a constant on this
preset rather than a signal.

**Sentence** — `Radius 2400 m at plate 180 widens 65%. Try 540 m.` The
"drops N buildings" clause exists and is correct, but note that **04 stage 1's
rule 3 is unreachable after rule 2** (proved in
`test_04_stage1_rule_3_cannot_fire_after_rule_2`), so real scenes report
`dropped: 0` and take the no-drops variant. Remedies are only offered when they
are a change in the helpful direction.

The bake appends the sentence to `BakeResult.warnings` when the band is `poor`.

---

## 6. Verify

```sh
export PATH="/c/Users/Vahid/AppData/Local/Microsoft/WinGet/Packages/ezwinports.make_Microsoft.Winget.Source_8wekyb3d8bbwe/bin:$PATH"

# G6 (this phase's gate)
make bake-fixture TEXT=all && make validate artifacts/chicago-text.3mf

# it composes with parts mode
make bake-fixture COLOR=parts TEXT=all && make validate artifacts/chicago-parts-text.3mf

# G5, G8 and the suites
make bake-fixture COLOR=parts && make validate artifacts/chicago-parts.3mf
cd services/bake && uv run pytest -q                       # 543 passed
cd services/bake && uv run pytest tests/test_v1_compat.py -q   # 11 passed
cd apps/web && npx vitest run && npm run typecheck && npm run lint   # 400 passed

# regenerate the pinned fixtures (never by hand)
cd services/bake && FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_transform.py tests/test_lettering.py
cd services/bake && uv run python scripts/gen_font_assets.py
```

### Measured, 2026-08-30, this host

| bake | result |
|---|---|
| `TEXT=all` | ALL CHECKS PASS — 180.000 × 180.000 × 35.733 mm, 89,466 triangles, min wall 0.8016 mm, **lettering 0.488 mm stroke / 0.765 mm ridge**, **base_floor 2 pocket kinds, 6 probes, worst gap 0 mm²**, 15.8 s |
| `COLOR=parts TEXT=all` | ALL CHECKS PASS — 6 parts, `parts_union` 199,812.6434 vs 199,812.6339 mm³, bbox delta 0 |
| `COLOR=parts` (G5) | ALL CHECKS PASS — 6 parts / 6 materials, unchanged |
| `make validate` on both files | ALL CHECKS PASS including `lettering` and `base_floor` from the sidecar alone |

Auto-fit on the `TEXT=all` fixture: all four engravings requested 8 mm and were
reduced to 5.16 / 5.48 / 5.97 / 6.30 mm by the 6 mm lip band, each with a
warning naming the fitted size.

### Test names

`services/bake/tests/test_lettering.py` (75 tests): `test_font_*` (5),
`test_glyph_*` (8), `test_layout_*` (10), `test_ornament_*` (9),
`test_hanger_*`/`test_underside_*` (3), `test_repair_*` (5),
`test_validator_*` (6), `test_parity_lettering_*` (2), `test_pipeline_*` (2).
`services/bake/tests/test_transform.py` gained the advisor suite (8 tests) and a
fifth parity case. `apps/web/lib/lettering.test.ts` (21 tests) asserts the
13-case fixture plus the unit behaviour; `apps/web/lib/transform.test.ts` gained
the advisor parity per case and four advisor unit tests.

---

## 7. What the web phase must do

1. Draw text and ornaments **only** from `lettering_layout(...)` — never
   recompute a size, an anchor or a rotation. `lettering_layout_json` is the
   same data as plain JSON if that is easier to memoise.
2. Import `apps/web/lib/fonts/<face>.glyphs.json` **dynamically**, per face.
3. Show `fit.refused` pieces as refused (with `fit.reason`) rather than drawing
   them: the bake will not cut them.
4. Surface `fit.warnings` and `layout.warnings` — they are the same strings the
   bake reports.
5. Disable/annotate the Bake button from `underside_min_base_mm(params) >
   params.base_thickness_mm`, which is exactly what the bake refuses on.
5b. Seed a new engraving at the contract default (**4.0 mm** now, not 3.0) and
   clamp the north arrow's control to `north_arrow_max_size_mm(params)` —
   4.287 mm on a 6 mm lip — or show the same "was reduced" warning the shared
   layout emits. Both numbers come from `transform.ts`; do not hard-code them.
6. Use `detail_report` / `detail_recommendation` for the HUD; the bake shows the
   same sentence when the band is `poor`.

## 8. Known limits

* The layout math PREDICTS printability from per-glyph metrics; the bake
  MEASURES the finished groove, after the ridge merge has bridged whatever
  sub-nozzle ridges the string contains. Neither can be derived from the other,
  so they disagree on some strings, always in the safe direction (the bake
  refuses what the preview showed). Re-measured this run over 3 faces × 8
  strings a user actually types × 25 sizes (§8a below): **22 of the 24 (face,
  string) pairs agree to the last quarter-millimetre**; the two that do not are
  serif `1:10,714` (layout accepts from 3.50 mm, the bake cuts from 5.75) and
  serif `Wrigley Field` (3.50 against 4.00). The refusal now names a size the
  bake has actually measured — `it prints at 5.75 mm` — instead of "try a larger
  size" (v2-03 audit, finding 4).
* The measurement that decides is taken on the SEPARATED cutter, which is what
  Stage 4 slices out of the finished mesh. Judged before that 0.02 mm offset the
  same serif `1:10,714` measures 0.412 mm and ships — and then the Stage 4
  `lettering` row measures the groove it really cut at 0.303 mm and the whole
  bake fails. A refused string costs the user one string; a failed bake costs
  them the model.
* `text_gap_size_mm` is pessimistic by construction (bounding-box closest
  approach, not the real wedge), which is why it warns rather than refuses.
* Serif engravings under ~3.5 mm at a 0.4 mm nozzle are refused. That is the
  face, not the code: its horizontals are half the weight of its stems.

### 8a. Smallest size that actually prints, per face and per string

Measured on the 6 mm lip at the default nozzle, plate 180, top edge, engraved;
"layout" is the smallest size `fit.refused` is false at and "bake" the smallest
that produces a cutter. Sizes swept 2.00–8.00 mm in 0.25 mm steps (8.0 is the
contract maximum).

| string | sans | serif | mono |
|---|---|---|---|
| `CHICAGO` | 3.25 | 3.75 | 3.75 |
| `Chicago` | 3.25 | 3.50 | 3.00 |
| `1:10,714` (`{scale}`) | 3.25 | **5.75** | 2.50 |
| `41.8827, -87.6233` (`{coords}`) | 3.25 | 3.75 | 2.75 |
| `2026-08-30` (`{date}`) | 2.50 | 3.25 | 2.75 |
| `Chicago 2026` | 3.25 | 3.50 | 3.00 |
| `N` | 2.00 | 2.00 | 2.00 |
| `Wrigley Field` | 3.50 | 4.00 | 3.50 |

At the old contract default of **3.0 mm the default face (sans) refuses six of
these eight strings**, which is what the web phase hit on a freshly seeded
engraving. **3.75 mm** is the smallest quarter-millimetre step at which all
three faces cut everything except serif `1:10,714`; the default was raised to
**4.0 mm**, one step above it, because two of those thresholds sit exactly at
3.75 and printability is not monotonic in the size. `packages/contracts/schema/
print_params.json` → `make contracts` → `PARAM_RANGES.engravings.size_mm.default`
and `transform.ts`'s `ENGRAVING_DEFAULT_SIZE_MM`, pinned on both sides.
* Nothing here is verified on a printer. The claims are geometric.

---

## 9. Also in this phase: the v2-02 parts-export audit fixes

The five majors (and four of the five minors) from `docs/handoff/v2-02-audit.md`
were fixed here rather than by a separate agent, because they live in the same
files as the lettering work. The full write-up is the **Resolution** section
appended to that audit; the decisions are `- [V2-P3-fix]` lines in
`DECISIONS.md`. In one line each:

1. the recess floor now has one owner (the loser is capped under the winner);
2. `<components>` must be distinct, complete and mesh-only;
3. a `<component transform>` (or a build-item transform) is refused;
4. the parts partition the single solid exactly (9e-9 mm³) and `parts_union` is
   a symmetric-difference test bounded by the print grid cubed;
5. the bake runs the 3MF container rows on the file it writes, in both modes.

Two latent defects surfaced on the way and are fixed too:
`checks.manifold_from_mesh` returned None for every mesh (a read-only numpy
array), which had been silently disabling the exact slicer and the per-part
debris check; and `assemble.finalize` took its volume reference after
`simplify`, so a destructive simplify could never be caught.

---

## 10. Also in this phase: the v2-03 lettering audit fixes

Both blockers, all three majors and all eight minors from
`docs/handoff/v2-03-audit.md` are addressed here, each with a regression test
(finding 8 as a corrected record plus a pinned invariant, not a geometry
change); the
full write-up is the **Resolution** section appended to that audit and the
decisions are the `- [V2-P5-fix]` lines in `DECISIONS.md`. In one line each:

1. **B1** the north arrow is turned by `+rotation_deg` and the test that let the
   wrong sign through now derives true north from the projection itself;
2. **B2** the frame-off refusal is a refusal (not a warning beside an accepted
   fit), `build()` checks the frame too, and the `bodies` row runs inside the
   bake in single mode — a three-body plate used to pass every validator;
3. **M3** the advisor's real scores are measured and pinned (§5);
4. **M4** a refusal names a size the bake has measured, and the contract's
   default `size_mm` is 4.0 (§8a);
5. **M5** `CREDITS.txt` and the 3MF `LicenseTerms` name the three OFL faces, and
   `gen_font_assets.py` copies each licence into `apps/web/licences/`;
6. **minors** the deviation's justification is rewritten from the audit's own
   measurements (6, 7); the true engraved rim, `margin − 0.02 mm`, is pinned (8);
   the north arrow is auto-fitted to the band instead of clipped (9); the
   `lettering` row now measures the underside mark's own strokes and the
   min-wall skip path is finally exercised (10); the score prose and the
   docstring example are corrected (11); the advisor's plate-only and no-remedy
   sentences are pinned in `fixtures/parity-expected.json`, so the TS mirror
   formats them under test (12); `token_context`'s dead `scene_request`
   parameter is gone (13).

Also fixed here, handed over by the web phase: `lib/transform.test.ts` derived
each parity case's `radius_m` from the expectation it then asserted against.
Cases now carry `radius_override` (null unless the case deliberately asks about
another radius) and the mirror derives the rest with its own
`radius_m_from_bounds` (v2-06 audit, finding 9).
