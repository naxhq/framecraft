# v2-06 audit — preview lettering, detail advisor, heroes, share link

Adversarial audit of phase V2-P6 (`apps/web/**`). The auditor did not write the
code under review. Every number below was measured on this host on 2026-08-30.

## Gate results on this tree

| command | result |
|---|---|
| `cd apps/web && npm test -- --run` | **496 passed, 27 files**, 0 failed, 0 skipped |
| `npm run typecheck` | clean |
| `npm run lint` (`--max-warnings 0`) | clean |
| `npm run build` | clean; First Load JS **141 kB**; 3 lazy glyph chunks (88 / 96 / 80 KB) and **0** glyph outlines in the page chunk — the `[V2-P6]` chunking claim verified |
| `npm run test:e2e` | **25 passed (4.0 m)**, `artifacts/e2e/results.json` = `{"passed":25}` — zero skipped, zero flaky, no retry needed |

No test was run twice and no bake-side edit interfered.

## Findings

### 1. MAJOR — a shared link naming a prototype key is accepted instead of refused, and plants a broken `params` object

`apps/web/lib/share.ts:409` (`const spec = PRINT_PARAM_SPEC[key];`) and
`apps/web/lib/share.ts:274` (`const field = spec.fields[key];`) look settings up
with a bare bracket read on an object literal. For any key that exists on
`Object.prototype` the lookup returns a truthy non-spec value rather than
`undefined`, so the `if (… === undefined) fail(…)` guard never fires;
`validate()`'s `switch (spec.kind)` then matches no case, falls out, and returns
`undefined`, which is written straight onto the params object at
`share.ts:421-424`.

Measured (`scratchpad/fuzz-share.mjs`, hand-made payloads):

```
unknown setting          -> refused   "…names a setting this version does not have (nope)"
__proto__ key            -> ACCEPTED
constructor key          -> ACCEPTED
toString key             -> ACCEPTED
valueOf key              -> ACCEPTED
nested __proto__         -> ACCEPTED   (north_arrow)
nested toString          -> ACCEPTED   (north_arrow)
engraving __proto__      -> ACCEPTED   (engravings[0])
```

This contradicts DECISIONS `[V2-P6]` ("a decoded link … is validated against the
frozen contract before it reaches the store") and the module's own "All or
nothing" promise (`share.ts:324-330`). It is not prototype pollution —
`Object.prototype.polluted` stays `undefined`, because the value written is
`undefined` and `__proto__ = undefined` is a no-op — but the params object that
reaches the store is damaged: after `?s=` carrying `{"p":{"toString":1}}`,

```
Object.hasOwn(params,'toString') = true (value undefined)
`${params}`                      THROWS TypeError: Cannot convert object to primitive value
String(params)                   THROWS TypeError
params + ''                      THROWS TypeError
new URLSearchParams({p: params}) THROWS TypeError
JSON.stringify(params)           ok
```

Nothing in the current tree string-coerces `params` (grepped), so this is latent
rather than a live crash — but the guarantee that a link is either fully applied
or fully refused is not held.

**The test that should catch it does not.** `lib/share.test.ts:340` ("refuses a
setting this build has never heard of") uses only `moon_phase`, an ordinary key,
so it passes over the whole class.

Reproduce: `node scratchpad/fuzz-share.mjs`, section 4.

### 2. MAJOR — the keyhole outline is 0.93 mm wrong, and the code claims it is exact

`apps/web/lib/previewText.ts:346`:

```ts
const theta = Math.asin(Math.min(1, half / radius));
```

The comment above it says "Where the slot's straight sides meet the entry
circle", and the function docstring (`previewText.ts:330-339`) says the outline
is "**Exact, not approximate** — the slot is narrower than the entry, so the two
tangents really are vertical lines between the two arcs."

The slot's straight sides are the vertical lines `x = cx ± half`. They meet the
⌀8 mm entry circle where `cos(angle) = half / radius`, i.e. at
`acos(2/4) = 60°` — not at `asin(2/4) = 30°`. With `theta = 30°` the arc is
terminated at `(cx + 3.464, cy + 2)`, which is not on the slot's side at all, and
the segment the code then emits to the cap arc at `(cx + 2, cy + 6)` is a slanted
chord, not a vertical tangent.

Measured (`scratchpad/ts_pieces.mjs`, section C), sampling the preview polygon
against the bake's true union (`lettering.keyhole_polygon`) at 400 heights:

```
asin(half/R) = 30.00 deg  (what the code uses)
acos(half/R) = 60.00 deg  (where the slot side is tangent)
max radial error of the preview keyhole outline: 0.9279 mm at y = centre + 3.465 mm
```

0.93 mm on a 4 mm entry radius: the preview draws a funnel-shaped shoulder where
the bake cuts a tangent one. This is by two orders of magnitude the largest
preview-vs-bake geometric error in the phase (everything else measures ≤0.005 mm,
see "Verified clean" below).

`lib/previewText.test.ts:280` ("draws the keyhole as one closed outline, not a
union") asserts only the four bounding-box extents and a positive area — all four
extents are set by the circle's cardinal points and the cap, none of which the
defect moves — so it is a **test weaker than its name**: it never compares the
outline to the union it claims to reproduce.

Reproduce: `node scratchpad/ts_pieces.mjs`.

### 3. MINOR — `advisorDeps` names two parameters the advisor does not read, and the test pins the waste

`apps/web/lib/advisor.ts:149` (`params.road_scale`) and `:151` (`params.water`).
Neither reaches the computation:

* `transform.detail_report` never mentions roads at all.
* `detail_report` builds `const areas = [...(scene.water ?? []), ...(scene.green ?? [])]`
  unconditionally (`apps/web/lib/transform.ts`, inside `detail_report`), so
  `params.water` cannot move it.
* `recommend_radius_m`, `recommend_plate_mm` and `detail_recommendation` mention
  neither (grepped).

Measured on the real 994-building Chicago scene (`scratchpad/advisor.mjs`):

```
plate_mm    -> advice changed     in advisorDeps: true
frame       -> advice changed     in advisorDeps: true
nozzle_mm   -> advice changed     in advisorDeps: true
road_scale  -> advice UNCHANGED   in advisorDeps: true   <== NEEDLESS KEY
water       -> advice UNCHANGED   in advisorDeps: true   <== NEEDLESS KEY
trees       -> advice UNCHANGED at plate 100/180, CHANGED at plate 256  (legitimately live)
detailAdvice cost: 2.08 ms per call
```

So dragging the road-width slider re-runs a whole-scene walk plus two grid
searches — 2.08 ms per tick — for a byte-identical result. It does not blow the
33 ms budget, which is why this is minor rather than major, but it is exactly the
class of key the phase's own `previewDeps` discipline exists to keep out
(`CityPreview.tsx:174-179`: "`transform.detail_report` walks every ring in the
scene, so it must not run on a height slider").

`components/scene/CityPreview.test.ts:174` and `:178` assert
`rebuiltBy("road_scale") === ["advisor","roads"]` and
`rebuiltBy("water") === ["advisor","water"]`, so the suite **pins the needless
rebuild as correct** rather than catching it.

### 4. MINOR — "at the contract's maxima" is not at the maxima, and the 2,319-character figure is wrong by roughly 2×

`apps/web/lib/share.test.ts:244-271` is named *"stays inside a browser URL even
at the contract's maxima"* and comments *"Measured 2,319 characters at the
absolute maxima the contract allows. The bound here is the claim."* It is not at
the maxima:

* hero ids are `way/1000000xx` — **14 characters**, where
  `PRINT_PARAM_SPEC.hero_building_ids.item.maxLength` (`share.ts:203`) is **64**;
* every string is ASCII, although `city_label` / `engravings[].text` /
  `underside_mark.template` accept any characters up to their length limit;
* `underside_mark.template`, `part_colors`, `scale_bar`, `north_arrow`,
  `color_mode` and the six numeric fields are left at their defaults, so they
  contribute nothing to the diff.

A genuinely maximal, **valid, round-tripping** configuration measures
(`scratchpad/maxlen.mjs`):

```
ASCII      payload  4031  URL  4056  ok=true   under 4096 = true
Greek 2B   payload  4884  URL  4909  ok=true   under 4096 = FALSE
CJK 3B     payload  5738  URL  5763  ok=true   under 4096 = FALSE
astral 4B  payload  4884  URL  4909  ok=true   under 4096 = FALSE
```

`expect(payload.length).toBeLessThan(4096)` therefore fails at the maxima the
test says it is exercising, for any non-ASCII label. 5.7 kB is still far inside
Chrome (~32 k), Firefox and Safari, so nothing is broken today — but the
statement in `docs/handoff/v2-06-preview.md:124-125` and in `DECISIONS [V2-P6]`
that the measured worst case is 2,319 characters is not correct, and 4–5.7 kB is
past the 2,083 that legacy IE/Edge and several chat clients truncate at, which is
the very failure the checksum exists to name.

### 5. MINOR — the a11y Tab-walk guard was not extended to this phase's controls

`apps/web/e2e/a11y.spec.ts:276` (`REQUIRED_IDS`) and `:302` (`REQUIRED_TESTIDS`)
still list only the V2-P4 controls. None of `copy-link-button`,
`advisor-use-radius`, `advisor-use-plate`, `share-link`, `share-notice-dismiss`,
`engraving-row` or `hero-list` appears anywhere in that test.

The controls **are** reachable — I checked rather than assumed. An audit-only
Playwright probe (`scratchpad/audit-e2e/audit.spec.ts`) pressed Tab 160 times on
a generated Chicago scene with every group open and read `document.activeElement`
each time:

```
tab stops (34 unique): shortcuts-button | theme-toggle | preview-canvas |
adjustments-chip | advisor-use-radius | reset-button | group-location-toggle |
city_label | radius_m | rotation_deg | … | group-output-toggle |
copy-link-button | generate-button
Tab reaches copy-link-button: true
Tab reaches advisor-use-radius: true
```

So this is a coverage gap, not a product defect. Related, and pre-existing from
V2-P4: the test is named *"every control is reachable by Tab, **in order**, with a
visible focus ring"* but its assertions are set-membership only
(`ids.has(…)`, `testIds.has(…)`, `groups.has(…)`) — no assertion anywhere checks
that the stops occur in a particular sequence.

### 6. MINOR — the advisor buttons are never clicked by the shipped suite

`e2e/ui.spec.ts:302-325` asserts the remedy button exists, is visible, and
carries a plausible `data-value`, and `docs/handoff/v2-06-preview.md:234-237`
explains that clicking is avoided because it is a live Overpass query. The
consequence is that nothing in the repository proves the button actually performs
the commit; `lib/advisor.test.ts` proves only that `applyAdvisorAction` calls
`setRadius` then `generate` on a stub.

I clicked it. `scratchpad/audit-e2e/audit.spec.ts:36`, with a request log on the
bake API:

```
[audit] "Use 280 m" -> radius 280 m, exactly 1 POST /scene
[audit] plate remedy offered at plate 100: false
```

**The behaviour is correct** — the radius control moves to the solved number and
exactly one `POST /scene` follows, the same as a slider release
(`groups/LocationGroup.tsx:60-61` is `onChange={setRadius}` /
`onCommit={() => void generate()}`, and `advisor.ts:175-180` is the same pair in
the same order). The `Use plate N` branch was never exercised at all: no plate
remedy is offered on the Chicago 900 m / plate 100 case the e2e drives, so that
code path has no end-to-end coverage in either the shipped suite or this audit.

### 7. MINOR — `FrameTextGroup` memoises on the whole `params` object

`apps/web/components/editor/groups/FrameTextGroup.tsx:77-88` (`context`, deps
`[graph, lat, lon, radius_m, params]`) and `:99-101` (`layout`, deps
`[params, context, rotation_deg]`). `store.setParam` rebuilds `params` by spread
on every write, so both memos miss on every slider tick, colour change and hero
pick, and `T.lettering_layout` is re-run each time — the precise trap
`CityPreview.tsx:82-94` documents and `textParamsKey` exists to avoid.

Measured cost (`scratchpad/cost.mjs`): `lettering_layout` is 0.010 ms with no
engravings and **0.138 ms** with eight engravings plus every ornament, so there is
no budget impact; the memos are simply decorative. Two smaller consequences:
`context` is rebuilt with a fresh identity on every write (so `EngravingsEditor`
re-renders on writes that cannot affect it), and the panel reads
`new Date().toISOString()` there (`:84`) while `CityPreview.tsx:226` pins `today`
in `useState` — the two `{date}` sources can disagree across midnight.

### 8. MINOR — a refused shared link stays refused across a reload

`store/editor.ts:350-362` sets `shareNotice` and stops; `EditorShell.tsx:120-122`
reads `window.location.search` once at mount. Neither clears the bad `?s=` from
the address bar, so dismissing the banner (`WarningBanners.tsx:63-71`) and then
reloading shows the same refusal again, forever, on what is now a bookmarked URL.
`OutputPanel.tsx:93` already demonstrates the fix in the happy path
(`window.history.replaceState`).

### 9. MINOR — a parity assertion was made tautological

`apps/web/lib/transform.test.ts:176` now reads
`const radius_m = expectedCase.radius_m;` where it previously derived the value
independently (`T.radius_m_from_bounds(scene.bounds)`). The unchanged assertion at
`:196`, `groundEq(radius_m, expectedCase.radius_m, "radius_m")`, therefore compares
the value to itself for all five parity cases. A weaker replacement was added at
`:139` (`expect(T.radius_m_from_bounds(scene.bounds)).toBeCloseTo(900, 9)`): once,
against a hard-coded number, instead of per case against the fixture.

The stated reason ("a case may name a radius the scene was not cropped at") is
legitimate for the new advisor case only; the change silently voided the check for
the four older ones. Note: `lib/transform.test.ts` is listed in
`docs/handoff/v2-06-preview.md:3-6` as **not touched by this phase**, so this
belongs to the V2-P5 diff carried in the same working tree — recorded here because
it is in the `apps/web` diff under audit.

### 10. NOTE — dark-theme preview tints are carried almost entirely by hue

Luminance contrast of the flat token values (a lower bound: the surfaces are lit
and shaded in 3D, and this is explicitly not a WCAG surface):

| pair | light | dark |
|---|---|---|
| hero `#E3A72F` vs building | 1.75 | **1.20** |
| hero-pick `#7D8794`/`#93A0B0` vs building | 2.98 | **1.50** |
| pocket vs base | 3.02 | **1.39** |
| engraved vs frame | 1.95 | 1.98 |
| embossed vs frame | 2.22 | 2.55 |

In the dark theme a hero in `own_color` is separated from an ordinary building
almost only by hue (warm orange against warm grey at 1.20:1), which is the channel
red-green colour deficiency removes. It is not the sole channel — `hero-hint`
states the count in words (`CityPreview.tsx:607-615`) and the Buildings group
lists the ids — and `#E3A72F` cannot be changed because it must equal the bake's
`assemble.HERO_COLOR`. Worth knowing, not worth a fix here.

### 11. NOTE — `detail_report` ignores `params.water`

With water turned off the score still counts every water polygon in the
`areas_dropped_fraction` term (measured: `areas_dropped_fraction` is 0.4781 with
water on and 0.4781 with water off, on Chicago). This is shared-math behaviour in
`transform.py`/`transform.ts`, i.e. the V2-P5 surface and out of this phase's
scope; flagged for the bake side. It is also half the reason for finding 3.

### 12. NOTE — the spec strip wraps at 1280×800

Screenshots in `scratchpad/shots/`. At 1920×1080 the strip is one row —
`SCALE · HEIGHT · MIN WALL · DETAIL 60 · fair · 994 buildings · Preview is
approximate…` — exactly as `v2-06-preview.md` §2 describes ("a fourth cell in the
spec strip"). At 1280×800 the middle column is 512 px wide and the strip wraps, so
`DETAIL` drops onto a second line below the other three instruments. The
recommendation row is 31 px, the sentence is **not** truncated at either width,
and the whole HUD occupies 88 px of a 713 px canvas (12.3 %) at 1280×800 and 5.9 %
at 1920×1080. Legible and within reason at both; noted only because the strip
reads as three instruments plus a stray one at the narrower width.

### 13. NOTE — a refused engraving is an info-toned row in the drawer

`lib/adjustments.ts:143-150` files every `layout.warnings` string into the
`repair` group ("Made printable") with `tone: "info"`, so
`engraving 1 (top) was not cut: …` sits beside `4 footprints were widened`. The
line itself is the shared math's own words and the per-line verdict in the panel
does carry `tone: "warn"` (`EngravingsEditor.tsx:232`), so nothing is hidden —
but a refusal is a thing that will not be printed, not a thing that was quietly
repaired.

---

## Verified clean (measured, not assumed)

**Preview-vs-bake placement fidelity is essentially exact.** For all 13 cases in
`fixtures/lettering-expected.json`, I rebuilt every drawable piece twice —
`previewText` in node against the committed glyph assets, and the bake's own
`lettering.place(text_polygons_mm(…))` / `north_arrow_polygon` /
`scale_bar_rules` / `scale_bar_label_glyphs` / `keyhole_polygon` /
`magnet_polygons` under `uv run python` — and compared the placed bounds
(`scratchpad/py_pieces.py`, `scratchpad/ts_pieces.mjs`):

```
max |delta| over all pieces and cases: 0.004744 mm
  (frame-off-skips-the-lip / keyhole.y0 — the 64-gon vs shapely quad_segs=16)
piece presence mismatches: none
layout.warnings: identical strings, identical order, all 13 cases
```

Every anchor, size, rotation, `mirror_x`, refusal and skip in the preview is the
shared math's. `placeArea` (`previewText.ts:189-205`) is algebraically the same
affine matrix as `lettering.place`'s `[cos·sx, −sin, sin·sx, cos, ax, ay]`. The
north arrow is drawn exactly where the shared math puts it, whatever that math
currently says about the sign (the in-flight bake fix was not second-guessed
here).

**Glyph flattening.** The web asset is flattened once at the contract's 8 mm
maximum; the bake re-flattens per printed size at 0.02 mm of print. Hausdorff
distance between the two contours, over `a e o S B 8 & @` × three faces
(`scratchpad/dil.py`):

```
sans  at 3 mm 0.03926 mm | at 6 mm 0.03937 mm
serif at 3 mm 0.03941 mm | at 6 mm 0.03874 mm
mono  at 3 mm 0.03869 mm | at 6 mm 0.03876 mm
```

≈0.04 mm, a tenth of a 0.4 mm nozzle, at both sizes. No defect.

**Mitre vs round dilation.** `DECISIONS [V2-P6]` admits the preview uses a mitre
offset where the bake uses a round-joined buffer. Measured over the fixture set,
the preview's placed ink bounds exceed the bake's by at most **0.0039 mm**
(0.0340 vs 0.0301 at `dilation_mm` 0.0301; 0.1593 vs 0.1576 at 0.1576). The
mitre limit of 3 never bites at these sizes. No defect.

**Share link round trip.** 500 randomised configurations across the whole
contract — every enum, both extremes of every numeric range, `0.1 + 0.2` and
`1/3` float artefacts, unicode / emoji / max-length / empty strings, 0–8
engravings, 0–12 heroes — round-tripped with **0 mismatches** on every field of
`SceneRequest` and `PrintParams`, nested objects included
(`scratchpad/fuzz-share.mjs`, section 1).

**Tamper rejection.** All 10,458 single-character substitutions of the base64
body were attempted; 15 were accepted, all at the final character (position 165
of 166), where base64's unused trailing bits make the substitution a different
spelling of the identical byte string — and all 15 decode to a **byte-identical
editor state**, verified by deep comparison (`scratchpad/fuzz2.mjs`, section A).
Not a defect. `v1.`, `v3.`, a missing version, a truncated body, an extra dot, an
uppercased digest, `""` and garbage are all refused with a named reason. Every
out-of-range value, over-long string, 9th engraving, 13th hero, bad hex colour
and non-numeric plate is refused with the field named; a partial nested group is
merged over its default as documented.

**Radius/rotation round trip through the store.** `applyShared`
(`store/editor.ts:333-348`) snaps the radius and rounds the rotation, which could
lose a value — but all six presets carry `radius_m: 900` and `snapRadius(900) =
900`, and every other path into `location.radius_m` is already snapped, so no
reachable configuration drifts.

**Memo discipline.** `previewDeps.text` is keyed on `textParamsKey`, a JSON string
of exactly the nine layout parameters; a building slider produces the same key.
`CityPreview.test.ts` pins `small_scale`/`large_scale`/`base_thickness_mm` →
`["height"]` only, `terrain_exaggeration` → nothing, the six lettering parameters
→ `["text"]` only, `hero_building_ids` → `["height"]` only, and colour/hero-mode →
nothing. `city_label`, the frame toggle and `nozzle_mm` all correctly rebuild the
text; a separate case pins that changing `rotation_deg` changes the text key.
`textDraw`'s shorter key (`[textModel, base_thickness_mm, frame]`) is sufficient:
`frame_geometry_mm` also reads `plate_mm`, but `plate_mm` is inside
`textParamsKey`, so `textModel` identity already covers it (verified by direct
evaluation).

**Heroes.** `preview.buildingInstanceMatrices` calls the shared
`T.building_top_mm_for(b, params, scale, heroes.has(b.id))` with
`T.hero_height_ids(params)`, which is empty in `own_color`. `matrixDeps` and
`warningDeps` both carry `heroHeightKey(params)`. Measured end to end by the
shipped e2e: 18.9 mm halved → 34.7 mm with a hero → 18.9 mm again in `own_color`.
`paletteFor` overrides exactly seven slots from `part_colors`; `hero`, `heroPick`,
`textEngraved`, `textEmbossed` and `pocket` survive into parts mode, and
`part_colors` is ignored entirely in `single`. `--fc-preview-hero` is `#E3A72F` in
both themes and `palette.test.ts` pins it against the bake's `HERO_COLOR`.

**Counters really are holes.** `"Chicago"` at 6 mm produces 8 areas, 3 of which
carry a counter (`a`, `g`, `o`), and `AreaSurfaces.areaTrianglePositions` puts
them through `ShapeUtils.triangulateShape(outline, holes)`.

**No XSS surface.** The only `dangerouslySetInnerHTML` in `apps/web` is the static
theme bootstrap in `app/layout.tsx:43`. `city_label`, engraving text, the advisor
sentence, the share URL and every shared-link refusal reason are React children or
React-escaped attributes.

**`history.replaceState` is not per-keystroke.** It fires only inside `copyLink`
(`OutputPanel.tsx:93`). The link itself is re-encoded on every `params` write
(`OutputPanel.tsx:81-84`), which is a `JSON.stringify` + base64 of a ~200-byte
diff — negligible.

**No skipped, `.only` or `.fixme` tests.** The single `test.skip` in the tree
(`e2e/smoke.spec.ts:546`) is conditional on Overpass returning 502/503, pre-exists
this phase unchanged, and did not fire in this run. The A1 (5 s) and A4 (90 s)
budgets at `smoke.spec.ts:30,34` are unchanged from `da9ab83`. axe runs with no
disabled rule and no excluded selector, 0 violations in both themes across four
states.

**A note on screenshots.** At 1280×800 the WebGL canvas came back unpainted in the
Playwright screenshot (a headless back-buffer timing artefact — the same probe at
1920×1080 captured the model correctly, and the shipped suite measures 16 fps and
994 drawn buildings at both widths). The drawn geometry was therefore verified
numerically rather than visually, as above.

---

Findings 1-9 are defects (2 major, 7 minor); findings 10-13 are notes and ask for
no change.

**AUDIT: 9 DEFECTS (0 blocker, 2 major)**

---

## Resolution (V2-P6-fix, by the phase author)

All 9 defects addressed: **both majors fixed with a regression test proved red
against the old code, and all 7 minors fixed** except finding 9, which is
another agent's file. Findings 10–13 are notes and asked for no change; §13 is
answered at the end.

Gates after the fixes, in the documented order, on this host:

| command | result |
|---|---|
| `npm test -- --run` | **506 passed, 27 files** (was 496), 0 failed, 0 skipped |
| `npm run typecheck` | clean |
| `npm run lint` (`--max-warnings 0`) | clean |
| `npm run build` | clean; First Load JS **143 kB**; glyph outlines still 0 in the page chunk |
| `npm run test:e2e` | **25 passed (4.1 m)**, zero skipped, zero flaky |

### 1 — MAJOR, prototype keys accepted. FIXED.

`lib/share.ts` gained `specFor(map, key)`, an `Object.hasOwn` guard, and **both**
lookups go through it: the top-level one in `decodeShare` and the nested one in
`validate`'s `object` branch (which also covers `part_colors` and every
`engravings[]` item, since they are the same code path). The tables stay
ordinary objects; the rule lives in one function.

`lib/share.test.ts` was extended from the single `moon_phase` case to the whole
class — `Object.getOwnPropertyNames(Object.prototype)`, all 12 of them, at three
depths, plus a guard-the-guard test that the list really contains `__proto__`,
`constructor`, `toString` and `valueOf`:

* `refuses an inherited name as a top-level setting`
* `refuses an inherited name inside a nested group` (`north_arrow`, `part_colors`)
* `refuses an inherited name inside an engravings item`
* `never hands the store a params object that cannot be coerced` — the concrete
  damage: an accepted params object must never carry an own prototype key, and
  `String(params)` must not throw.

**Proved non-vacuous.** With `specFor` reverted to the bare `map[key]` read,
those four tests are red (`4 failed | 21 passed`); with the fix, 26 pass. The
suite's other refusal cases are unchanged and still green.

### 2 — MAJOR, keyhole drawn with slanted chords. FIXED.

`Math.asin` → `Math.acos` in `previewText.keyholeArea`. A vertical slot side
`x = cx ± half` meets the entry circle where `cos θ = half / radius`, i.e. at
60°, not 30°. The docstring's "Exact" claim is now qualified honestly ("exact up
to the polygonal arcs — one chord's sagitta of a 64-gon, 0.005 mm") and carries
the reason for `acos`.

One second-order fix came with it: the arc's step count was `Math.round`, which
for the 300° span produced chords slightly *longer* than the 64-gon's. It is
`Math.ceil` now, so the sagitta is bounded by the circles the rest of the module
draws — otherwise the bounding-box tolerance the old test used (0.004818 mm)
would have been exceeded by 0.00006 mm, which is how I found it.

`lib/previewText.test.ts:280` was the weak test the audit named. It is kept and
two are added:

* `draws the keyhole outline ON the union the bake cuts` — the whole outline,
  **edges included** (16 samples per edge), against a signed distance function
  for the true union of the entry disc, the slot box and the cap disc, i.e. the
  same three shapes `lettering.keyhole_polygon` unions. Bound 0.01 mm.
* `meets the entry circle where the slot's own sides are, at 60 degrees` — the
  junction point is on both the circle and the slot side, and is a vertex of the
  drawn ring.

**Proved non-vacuous.** With `asin` restored, both are red: `worst radial error
0.7321 mm at (2.732, 80.000)` against the 0.01 mm bound. (The audit measured
0.9279 mm by sampling at heights; same defect, different metric.) With `acos`,
the worst error over the whole outline is under 0.005 mm.

### 3 — MINOR, needless advisor dependencies. FIXED.

`advisorDeps` is now `[graph, radius_m, plate_mm, frame, nozzle_mm, trees]`.
`road_scale` and `params.water` are gone, with the reason in the comment.

The two `CityPreview.test.ts` assertions that pinned the waste as correct now
read `rebuiltBy("road_scale") === ["roads"]` and `rebuiltBy("water") ===
["water"]`, and `trees` still legitimately reaches the advisor.

`advisor.test.ts` gained `names nothing the report cannot read`, which closes the
loop the other way: over four real scenes it asserts each of the four listed
parameters CAN move `detail_report`, that `road_scale` and `water` cannot, and
that neither is in the key any more. The test scenes gained two trees so the
`trees` half of that claim is not vacuous.

### 4 — MINOR, "maxima" that were not maxima. FIXED.

`share.test.ts` now builds a genuinely maximal configuration: every string at
its 64-character limit (city label, all eight engraving texts, the underside
template), twelve **64-character** hero ids, and every remaining numeric, enum
and nested field off its default — asserted by comparing `paramsDiff`'s key set
to the whole contract minus `schema_version`, so nothing can silently fall back
to a default and shrink the measurement. It is run at one, two, three and four
UTF-8 bytes per character.

Measured here (this `REQUEST`, which carries a preset id):

```
ascii          payload 4011   latin-1 2 byte 4864
cjk 3 byte     payload 5718   astral 4 byte  4864
default configuration 148  (141 with no preset id — the audit's figure)
```

The bound is now **8192**, with the browser-limit reasoning written next to it,
and the test also asserts the CJK case really is larger than the ASCII one so
the numbers cannot rot. A second test round-trips all four maxima.

The wrong figure was propagated in two more places and both are corrected:
`lib/share.ts`'s module docstring and `docs/handoff/v2-06-preview.md` §3.
`DECISIONS [V2-P6]` is append-only, so it is corrected by a `[V2-P6-fix]` line
rather than edited.

### 5 — MINOR, a11y Tab walk not extended. FIXED.

`REQUIRED_TESTIDS` gained `copy-link-button` and `advisor-use-radius`. Two
assertions were added so the list cannot pass for the wrong reason: the advisor
stop's precondition is stated (`detail-health` must be band `fair` in this
state, or the recommendation row would not render at all), and
`advisor-use-plate` is asserted **absent from both the DOM and the walk** —
no plate in the contract's range fixes this scene, so the shared math offers no
plate remedy, and "not in the tab order" and "not rendered" have to agree.

`share-link` and `share-notice-dismiss` are still not in this walk: both require
a state this test does not reach (a copy click, and a bad payload in the URL).
They are covered by `e2e/share.spec.ts` instead, which asserts the field's value
and clicks the dismiss button.

**Not fixed, and pre-existing:** the test is named "every control is reachable by
Tab, **in order**" and asserts set membership only. That is V2-P4's wording, the
walk is real, and adding a document-order assertion to somebody else's test on
this pass is more likely to add flake than to catch anything. Recorded here.

### 6 — MINOR, advisor buttons never clicked. FIXED.

`ui.spec.ts`'s advisor test now clicks `Use 280 m` and asserts the radius readout
becomes `280 m` and that **exactly one** `POST /scene` follows — polled to one,
then re-checked after 1.5 s so a second, stacked request would fail it. Only the
REQUEST is asserted, never the response, so the test does not depend on Overpass
being reachable; and `ui.spec.ts` gained `smoke.spec.ts`'s `pruneStrayFixtures`
in `afterAll`, so the one non-preset query this adds leaves no `fixtures/<sha1>
.json` behind (verified: 6 sha1 fixtures before and after, matching
`presets-index.json`).

Measured in the shipped run: `[ui] "Use 280 m" moved the radius to 280 m with
exactly 1 POST /scene`.

`Use plate N` remains without end-to-end coverage, for the reason in §5.

### 7 — MINOR, `FrameTextGroup` memoises on `params`. FIXED.

`context` is keyed on `[graph, lat, lon, radius_m, today, plate_mm, frame,
city_label]` — the four PrintParams values it actually reads, the scale being
`usable_span_mm`. `layout` is keyed on `[textParamsKey(params), context,
rotation_deg]`, the same string `previewDeps.text` uses.

The `{date}` disagreement is closed the same way `CityPreview` does it: `today`
is pinned in `useState` at mount rather than read from the clock on every render.
Both components pin at the same page load, so the panel and the preview cannot
disagree.

### 8 — MINOR, a refused link stays refused across a reload. FIXED.

`store.loadShared` now returns `"none" | "applied" | "refused"` instead of a
boolean, and `EditorShell` deletes the `s` parameter with
`history.replaceState` on a refusal — and **only** on a refusal: an accepted
payload is what the page is showing and the user may want to copy it again.

`e2e/share.spec.ts` asserts the URL no longer carries `s`, and that after
dismissing the banner **and reloading** the notice does not come back and the
editor is still on its defaults. Three store tests were updated to the new
return value, with the reason for the enum in a comment.

### 9 — MINOR, tautological parity assertion in `transform.test.ts`.
**NOT FIXED — HANDED OVER.**

`apps/web/lib/transform.test.ts` is out of this phase's scope (`v2-06-preview.md`
§0) and the bake-side agent is editing the transform pair right now; two agents
in one file is how a parity fixture gets half-regenerated. Handed to whoever owns
`transform.py` / `transform.ts` this run, with the audit's own reproduction:

> `:176` reads `const radius_m = expectedCase.radius_m;` and `:196` then asserts
> `groundEq(radius_m, expectedCase.radius_m)` — the value against itself, for all
> five cases. The V2-P5 reason (an advisor case may name a radius the scene was
> not cropped at) justifies it for that ONE case; the other four should go back
> to `T.radius_m_from_bounds(scene.bounds)`, per case, rather than resting on the
> single hard-coded `toBeCloseTo(900)` added at `:139`.

### 13 — NOTE, a refused engraving is info-toned in the drawer. Deliberately left.

The tone would have to be inferred by string-matching `layout.warnings`, or
`PreviewTextModel.notices` would have to become structured records — and the
shared math's messages are carried verbatim on purpose, so sniffing them for
"was not cut" is exactly the coupling this phase avoided everywhere else. The
refusal is already `tone: "warn"` in the panel, next to the control that caused
it (`engraving_N-fit`), which is where the user is. Noted for a future pass that
wants to change `notices` to `{message, refused}[]`.

### Files touched by this pass

`lib/share.ts`, `lib/share.test.ts`, `lib/previewText.ts`,
`lib/previewText.test.ts`, `lib/advisor.ts`, `lib/advisor.test.ts`,
`components/scene/CityPreview.test.ts`,
`components/editor/groups/FrameTextGroup.tsx`,
`components/editor/EditorShell.tsx`, `store/editor.ts`, `store/editor.test.ts`,
`e2e/a11y.spec.ts`, `e2e/ui.spec.ts`, `e2e/share.spec.ts`,
`docs/handoff/v2-06-preview.md`, `DECISIONS.md`. No file outside `apps/web/**`
plus the two documents; `lib/transform.ts`, `lib/lettering.test.ts`,
`lib/tokens.ts`, `lib/contracts.ts`, `lib/fonts/*`, `packages/contracts/**` and
`services/bake/**` were not touched.

**RESOLUTION: 8 of 9 fixed (both majors, 6 of 7 minors); 1 handed to the
transform owner.**
