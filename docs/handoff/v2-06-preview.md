# v2-06 — Text in the preview, the detail advisor, hero heights, shareable links

Phase V2-P6 (web editor). Scope: `apps/web/**` only. `lib/transform.ts`,
`lib/transform.test.ts`, `lib/lettering.test.ts`, `lib/tokens.ts`,
`lib/contracts.ts`, `lib/fonts/*.json`, `packages/contracts/**` and
`services/bake/**` were **not** touched — this phase consumes them.

Everything below is implemented and green on this host: **496 vitest**,
typecheck, lint (`--max-warnings 0`), `next build`, **25 Playwright** (was 19).

---

## 1. Task 3 — lettering, ornaments and the underside in the preview

`apps/web/lib/previewText.ts` (new) turns
`transform.lettering_layout(params, ctx, rotation_deg)` into flat filled
geometry. It computes no size, no anchor and no rotation of its own: the shared
math decides, this draws.

| piece | source of the shape | face | tone |
|---|---|---|---|
| edge engravings | `lib/fonts/<face>.glyphs.json`, laid out by the **metrics** advance | lip top | `engraved` / `embossed` |
| north arrow | `northArrowArea` — the bake's own four-point head | lip top | `engraved` |
| scale bar + label | `scaleBarAreas` = `lettering.scale_bar_rules`; the label offset by `bar_mm + ORNAMENT_GAP_MM + dilation` | lip top | `engraved` |
| underside mark | glyphs, `mirror_x` from the shared placement | plate bottom | `engraved` |
| keyhole / magnets | `keyholeArea` / `magnetAreas` | plate bottom | `pocket` |

* **Placement is `lettering.place()`, verbatim**: mirror in the local frame,
  rotate CCW, translate to the anchor — the same affine matrix, asserted
  element by element in `previewText.test.ts`.
* **Holes are counters.** Each glyph part carries its own holes, so the earcut
  (`AreaSurfaces.areaTrianglePositions`, reused unchanged) cuts the ring out of
  an `o`. Merged per (face, tone) into one BufferGeometry, four draw calls at
  most.
* **The dilation is applied.** `offsetRing` is a mitre offset with a limit of
  3× the distance and a fold guard — the same "cheap client-side stand-in for
  04 stage 1" the building footprints already get. The guard is an AREA test,
  not a winding test: a ring pushed past its own inradius keeps its rotational
  direction, so a winding check passes a knot (`offsetRing > keeps the ring
  rather than turning it inside out`).
* **Nothing is clipped and nothing is booleaned.** The keyhole is walked
  analytically as one outline (long arc, tangent, cap arc, tangent) instead of
  unioning a circle, a box and a circle.
* **A refused engraving draws nothing**, and an auto-fitted one draws at the
  fitted size. Both surface as `layout.warnings` — verbatim, sentence-cased —
  in the adjustments drawer under **Made printable** (`collectAdjustments`
  gained an optional `textNotices`).
* **New, beyond the brief:** each line in the Frame and text group now carries
  its own verdict (`engraving_N-fit`): `Cuts at 5.16 mm, reduced to fit the
  frame.` or `Not cut — …`. Without it, adding a line at the contract's 3 mm
  default silently draws nothing (see §6).

### Loading

`lib/fontGlyphs.ts` caches one face at a time behind `await import()`. Measured
in the production build: **0 glyph outlines in the page chunk** (`grep -c
'"shell"'` = 0) and three lazy chunks of 80–96 KB; First Load JS is **141 kB**,
unchanged by this phase. `facesNeeded(params)` asks only for what a layout will
use, and with the frame off only the underside mark's face is worth fetching.

### A defect this found

With `frame: false` the shared layout still measures the edge engravings (it
has to, to warn about them) and the bake's cutter then sits at `lip_top` with no
lip under it — it cuts air, which is what its "turn the frame on to print them"
warning means. The first version of this phase drew those letters floating 2 mm
over an empty plate. `buildPreviewText` now gates every lip piece on
`frame_text_available(params)`, matching `north_arrow_layout` /
`scale_bar_layout`. Two tests cover it (`skips every lip ornament with the frame
off`, non-vacuously — it asserts the same engraving IS drawn with the frame on —
and the `frame-off-skips-the-lip` case of `fixtures/lettering-expected.json`).

**Not fixed here, for the bake to judge:** an *embossed* engraving with the
frame off produces a solid from `lip_top - 0.2` to `lip_top + depth`, i.e. a
slab floating above the plate. `services/bake/**` is out of this phase's scope.

---

## 2. Task 4 — the detail advisor, and heroes in the preview

**HUD chip.** A fourth cell in the spec strip: `Detail 70 · fair`
(`detail-health`, with `data-band` and `data-score`). The band is stated in a
WORD as well as a colour (WCAG 1.4.1) and its colour is one of the editor's own
state tokens — `positive` / `warn` / `danger`, which `lib/contrast.test.ts`
already holds to 4.5:1 on this surface, so no new colour needed a new contrast
pair.

**Recommendation.** `transform.detail_recommendation`, verbatim, on a thin row
above the strip, only when the band is `fair` or `poor`. Beside it, the remedies
as buttons carrying the solved number: `Use 280 m` (`advisor-use-radius`) and
`Use plate N` (`advisor-use-plate`). A button is only offered when the sentence
names it, under the same "only a change in the helpful direction" rule.
`applyAdvisorAction` sends a radius through `setRadius` then `generate` — the
exact pair a slider release performs — and a plate through `setParam`.

**Hero `true_height` in the preview.** `preview.buildingInstanceMatrices` now
calls `building_top_mm_for(..., is_hero)` with `transform.hero_height_ids`. This
was "the one place the preview knowingly disagrees with the bake"
(`v2-04-ui.md` §11) and it is closed. Measured on Chicago: both multipliers at
50 % gives a predicted top of **18.9 mm**; picking the tallest building as a
hero takes it to **34.7 mm**, and switching to `own_color` returns it to 18.9.

**Hero `own_color`.** Heroes take the hero accent `#E3A72F` only when
`hero_own_color(params)`. In `true_height` they take a new
`--fc-preview-hero-pick` slate instead: the pick must stay visible, but painting
it the filament orange would promise a colour the bake will not print.

**Parts mode** already fed `part_colors` into the seven layers
(`paletteFor`); a test now pins that the lettering tones and the pocket colour
do NOT follow the filaments — an engraving painted the frame's own colour would
be invisible on the lip it sits in.

---

## 3. Task 5 — the shareable configuration

```
?s=v2.<base64url(JSON)>.<fnv1a32 of the JSON, 8 hex digits>
       └ {"r": SceneRequest, "p": the PrintParams that DIFFER from default}
```

* **Versioned first**, so a future payload is refused by name.
* **A diff**, so a default configuration is **141-148 characters**; the measured
  worst case at the contract's REAL maxima is **4,011 characters (ASCII)** and
  **5,718 (three-byte CJK)**, and a realistic one in the e2e is **679**.
  (The 2,319 first written here was measured on a configuration that was not
  at the maxima -- audit finding 4, corrected in `[V2-P6-fix]`.)
* **Base64url, not `deflate-raw`** — see DECISIONS `[V2-P6]`. Synchronous, no
  browser-support cliff in front of a Copy button.
* **Checksummed**, because a truncated payload usually still base64-decodes.
* **Validated** against the contract's own shapes and bounds
  (`PRINT_PARAM_SPEC`, built from the generated `PARAM_RANGES` / `PARAM_LIMITS`;
  only the enum members are written out, and a test asserts each contains the
  contract's default). A nested group is MERGED over its default, so a
  hand-made `{"north_arrow": {"enabled": true}}` still leaves a complete object.
* **All or nothing.** A rejected link leaves the editor on its defaults and puts
  a dismissible informational banner on screen (`share-notice`).

**Copy link** sits third in the Output action row, narrower than Generate and
Bake because it changes nothing about the model. It writes the clipboard, sets
`data-share-url` on the button (always, so a denied clipboard is not a dead
end), reveals a readonly `share-link` field, and calls
`history.replaceState` — no navigation.

**Loading** happens once in `EditorShell`'s mount effect and marks the scene
stale rather than fetching: opening a link in a background tab is not consent to
a live Overpass query. Generate is enabled and says "Generate".

---

## 4. `previewDeps` and the other memo keys

Two new entries, both all-primitives-or-the-graph like the existing eight:

```
text:    [graph, textParamsKey(params), rotation_deg, date, faceVersion]
advisor: advisorDeps(graph, params, radius_m)
         = [graph, radius_m, plate_mm, frame, nozzle_mm, road_scale, trees, water]
```

`textParamsKey` is a STRING of exactly `plate_mm, frame, nozzle_mm, city_label,
engravings, north_arrow, scale_bar, underside_mark, hanger` — a string so the
nested objects can be compared by value, which is what makes a `setNested` write
that changed nothing a no-op and a height slider free.

Changed keys, all in the strengthening direction:

* `warningDeps` gained `heroHeightKey(params)` — the string form of
  `hero_height_ids`, EMPTY in `own_color`. Without it the 60 mm guard and the
  HUD height did not follow a hero pick, which they must, because
  `predicted_top_mm` counts heroes at hero height.
* `matrixDeps` gained the same key, so picking a hero re-uploads
  `instanceMatrix` in `true_height`/`both` (its height really moved) and still
  does not in `own_color`.

`CityPreview.test.ts` was restated, not weakened: the old "a v2 personalisation
parameter rebuilds nothing" became three sharper claims — colour and hero-mode
rebuild nothing, the six lettering parameters rebuild **only** `text`, and a
hero pick rebuilds **only** `height`. `InstancedBuildings.test.ts`'s "does not
re-upload when a hero is picked" became "re-uploads only when a hero's HEIGHT
can move", plus a new case pinning the original defect for `own_color`.

---

## 5. Tests

**New vitest**: `lib/previewText.test.ts` (37), `lib/advisor.test.ts` (16),
`lib/share.test.ts` (20). **Extended**: `store/editor.test.ts` 38 → 46 (the
shared-link suite), `lib/warnings.test.ts` 12 → 15 (heroes),
`lib/adjustments.test.ts` (+5, lettering notices),
`components/scene/palette.test.ts` 11 → 14 (the token file really declares every
slot `PREVIEW_TOKENS` reads, in both themes, and `--fc-preview-hero` **is**
`#E3A72F` in both — the bake's `assemble.HERO_COLOR`),
`components/scene/CityPreview.test.ts` and
`components/scene/InstancedBuildings.test.ts` as above. **Total 496 passed
across 27 files** (was 400/24).

The load-bearing one is `previewText.test.ts`'s last suite: over every case in
`fixtures/lettering-expected.json`, every vertex the preview draws lands inside
its own 6 mm lip band and inside the usable length of its edge, nothing is drawn
for a refused piece, and the enabled ornaments are exactly the ones the layout
enables.

**New e2e** (`npm run test:e2e`, real stack, zero skips):

| test | file |
|---|---|
| `an engraving appears on the frame, and a refused one does not` | `ui.spec.ts` |
| `the detail chip follows the plate, and names a radius that would fix it` | `ui.spec.ts` |
| `a hero keeps its true height when the other buildings are scaled down` | `ui.spec.ts` |
| `a copied link restores the whole editor in a fresh browser` | `share.spec.ts` |
| `a link this build cannot read is refused, not half-applied` | `share.spec.ts` |
| `a truncated link says the link is damaged rather than doing nothing` | `share.spec.ts` |

`the v2 personalisation fields never reach the server` gained a keyboard hero
pick, so the "no `POST /scene` from a PrintParams change" guarantee now covers
`city_label`, a colour, an engraving, the hanger, the north arrow **and** a
hero.

Measured in the last full run: `77 good at plate 256 -> 60 fair at plate 100`,
advisor offers `Use 280 m`, `18.9 mm halved -> 34.7 mm with a hero`, engraving
drawn as **8 rings** ("Chicago" — the `i` is two), share link **679
characters**, restored preview draws **10 rings**, A1 warm preset 1.4 s, A4 bake
→ download 38 s, validator `ALL CHECKS PASS`.

### One deviation from the brief

The brief asked the e2e to show "the advisor chip changes band … when the plate
is set to 100 on Chicago". Measured: Chicago at 900 m is **already** `fair`
(score 70) on the default 180 mm plate, so 180 → 100 moves the score (70 → 60)
and the sentence (`Try 540 m` → `Try 280 m`) but not the band. The test sets
**256 → 100** instead, which is a real `good → fair` transition on the same
scene, and asserts the score drop, the band change, the sentence and the button
together.

The advisor's radius button IS clicked by the e2e (added in `[V2-P6-fix]`,
audit finding 6): the remedy is by construction not a preset radius, so only
the REQUEST is asserted -- the radius moves to the solved number and exactly
one `POST /scene` follows -- never the response, so the test does not depend
on Overpass being reachable, and `ui.spec.ts` now prunes the stray fixture a
completed query leaves. `Use plate N` still has no end-to-end coverage: no
plate in the contract's range fixes the Chicago case the suite drives, so the
shared math offers no plate remedy there.

---

## 6. Known limits

* **A new engraving is refused at its own default size.** The contract's
  `engravings[].size_mm` default is 3.0 mm and at a 0.4 mm nozzle
  `text_min_size_mm("Chicago")` is 3.09 mm — the counter of the `a` would close.
  The panel says so per line and the preview draws nothing, which is correct and
  is what the bake will do. The default was NOT overridden in the editor:
  `newEngraving` uses `PARAM_RANGES.engravings.size_mm.default`, and quietly
  seeding a different number would be the editor disagreeing with
  `PrintParams()`. If this is thought to be a poor first experience, the fix
  belongs in the contract's default, not in the panel.
* **The mitre offset is not a true polygon offset.** At a deep concavity it
  folds; the area guard catches that and keeps the undilated ring, so a letter
  is occasionally a hair thin in the preview. It is never a knot.
* Text is drawn ON the lip, not cut into it, and is not clipped to
  `lip_keep_region` — the auto-fit already guarantees it fits. The approximation
  note in the viewport says all of this out loud.
* The 3MF `Description` and the bake are untouched by this phase; nothing here
  is verified on a printer.

---

## 7. Verify

```sh
cd apps/web && npm test -- --run && npm run typecheck && npm run lint
cd apps/web && npx playwright test          # 25 passed, zero skipped
cd apps/web && npm run build                # LAST, and only with no dev server alive
```

`next build` and `next dev` share one `apps/web/.next`, so build LAST or
`rm -rf .next` between the two — the constraint is written at the top of
`playwright.config.ts` and in `v2-04-ui.md` §10. `make gate` and `make up` were
not run (not this phase's to run).
