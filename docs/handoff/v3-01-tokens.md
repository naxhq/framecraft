# v3-01 - Lettering token fix

Scope: the eight-token table becoming a thirteen-token resolution service, a
new Nominatim reverse-geocode client, the Place name / Author fields, the
Resolved-output panel, empty-line and frame-off warnings, and client-side
token expansion before `POST /bake`. Ran concurrently with `v3-01-contracts`
(the `place`, `hero_building_ids`-adjacent and `terrain` fields it landed on
`PrintParams` are consumed here, not authored here).

## 1. The bug and the fix

`{city}` was bound to `PrintParams.city_label`, which nothing ever wrote to,
so it always expanded to `""`. Fix, in priority order:

1. A preset's own city name (`apps/web/lib/presets.ts`'s new
   `PRESET_CITY_NAMES` / `presetCityName()`), client-side, no network.
2. A debounced Nominatim reverse geocode (`apps/web/lib/geocode.ts`) for a
   pin that is not on a preset.
3. The user's own typed text in the Place name field, which always wins from
   the moment they type it.

The store tracks this as `placeDetect: { status, source, detectedCity,
overridden }` in `apps/web/store/editor.ts` - deliberately named apart from
`PrintParams.place` (the unrelated v3 wire field for country/state/
neighbourhood/author) so the two are never confused in code or in review.

## 2. Files changed

- `apps/web/lib/tokens.ts` / `services/bake/app/geom/tokens.py`: five new
  tokens (`{country} {state} {neighbourhood} {author} {hero}`), `resolve_text`
  (TS only, returns which tokens were empty - see DECISIONS `[V3-P1]`).
- `apps/web/lib/geocode.ts` (new): Nominatim reverse geocode, 600 ms debounce,
  1 req/s queue, 30 day localStorage cache keyed by lat/lon at 3 decimals,
  5 s timeout, fails soft to `null` on every path.
- `apps/web/lib/presets.ts`: `PRESET_CITY_NAMES` / `presetCityName()`.
- `apps/web/lib/resolvedOutput.ts` (new): `resolvedOutputLines(params, ctx)`,
  the single source of truth for what cuts vs. skips and why. Feeds the
  Issues badge, the Resolved output panel and the bake request.
- `apps/web/lib/warnings.ts`: `letteringWarnings()`, built on
  `resolvedOutputLines` - one warn per empty line/mark naming the token, one
  info entry for the whole frame when it is off.
- `apps/web/lib/bake.ts`: `resolveParamsForBake(params, ctx)` - token
  expansion happens once, client-side, right before `POST /bake`; an empty
  line is omitted outright, never sent as `""`; the frame off omits every
  engraving; an empty underside mark is sent `enabled: false`.
- `apps/web/lib/previewText.ts`: `textTokenContext`/`textParamsKey` read
  `params.place` and the hero count too, so the 3D preview and the fit layout
  see the same resolved values everywhere else does.
- `apps/web/store/editor.ts`: `placeDetect` state; `applyGeocodeResult`,
  `setPlaceName`, `resetPlaceNameToDetected`, `setAuthor`, `initAuthor`
  actions; `setPin`/`applyPreset` updated to seed/clear detection without ever
  clobbering a user override; `applyShared` treats a link's own non-empty
  label as an override. `"place"` added to `NestedParamKey`.
- `apps/web/components/editor/EditorShell.tsx`: the geocode-triggering effect
  (always mounted, watches `lat/lon/preset_id`) and `initAuthor()` on mount  - 
  deliberately NOT inside the store's core actions (see DECISIONS `[V3-P1]`
  for why: `setPin`/`setRadius`/`setRotation` stay network-free, matching the
  existing `store/editor.test.ts` guarantee).
- `apps/web/components/editor/groups/LocationGroup.tsx`: "City label" renamed
  to "Place name" in place (`id="city_label"` unchanged for e2e), a "reset to
  detected" affordance, a placeholder falling back to `{coords}` formatting,
  and a new Author field bound to `params.place.author`.
- `apps/web/components/editor/EngravingsEditor.tsx`: the inline "Not cut"
  reason is replaced with a token-specific one when that is the cause;
  `aria-disabled` and the required "Turn on Frame to engrave the edges." copy
  when the frame is off.
- `apps/web/components/editor/groups/FrameTextGroup.tsx`: same token-specific
  reason for the underside mark preview; its own frame-off note reworded to
  cover only the north arrow and scale bar (no longer duplicating the new
  lettering-specific note).
- `apps/web/components/editor/OutputPanel.tsx`: the "Resolved output" panel  - 
  one row per text that will be cut, its surface, and cut/skipped + reason.
- `apps/web/components/scene/CityPreview.tsx`: `letteringWarnings` merged into
  the Issues-badge warnings memo.
- `apps/web/e2e/lettering.spec.ts` (new).
- Second pass, per the team lead's follow-up ruling (DECISIONS `[V3-P1]`):
  `apps/web/lib/advisor.test.ts`, `apps/web/lib/share.ts`,
  `apps/web/lib/share.test.ts` - the three remaining v3-exhaustiveness guards.
  See section 4 below for what changed in each.

## 3. Deliberate deviations from the brief's literal wording

- **`{hero}` is a count, not a name.** `SceneGraph.Building` carries no `name`
  field; a literal hero name cannot be resolved without a contract change,
  which is out of this task's authority. See DECISIONS `[V3-P1]`.
- **No "MODEL" group exists** in this tree's seven-group panel; the Place
  name and Author fields live in `LocationGroup`, which already owned the
  field this bug is about.
- **Author is bound to the (concurrently-landed) `params.place.author` wire
  field**, not a disconnected localStorage-only value: localStorage only
  prefills a fresh session, per DECISIONS `[V3-P1]`.

## 4. Tests

- `apps/web/lib/tokens.test.ts`: 73 tests (was ~30), including `resolve_text`.
- `apps/web/lib/geocode.test.ts` (new): 25 tests - cache/TTL/rate-limit/
  debounce/fail-soft, `fetch` always mocked.
- `apps/web/lib/presets.test.ts` (new): 6 tests.
- `apps/web/lib/resolvedOutput.test.ts` (new): 17 tests.
- `apps/web/lib/warnings.test.ts`: +6 `letteringWarnings` tests, plus the v3
  `MOVES` exhaustiveness fix (see below).
- `apps/web/lib/bake.test.ts`: +9 `resolveParamsForBake` tests.
- `apps/web/store/editor.test.ts`: +24 place-resolution/author tests, plus
  the v3 `PARAM_MOVES`/`nestedKeys()` exhaustiveness fix.
- `apps/web/lib/previewText.test.ts`: updated for the extended
  `textTokenContext`/`textParamsKey`.
- `apps/web/components/scene/CityPreview.test.ts`: `V2_TEXT_MOVES` gained
  `place`; the hero-pick memo test's expectation moved from `["height"]` to
  `["height", "text"]` (the `{hero}` token).
- `services/bake/tests/test_tokens.py`: +5 new-token cases, +2 direct tests;
  `fixtures/tokens-expected.json` regenerated (24 Python cases).
- `apps/web/e2e/lettering.spec.ts` (new): one end-to-end test covering the
  full acceptance flow below.

Contract-exhaustiveness guard tests that went red from schema_version 3
landing concurrently, fixed in two passes. First pass, while touching the
files anyway (not scope creep): `store/editor.test.ts`, `lib/warnings.test.ts`,
`CityPreview.test.ts`'s `V2_TEXT_MOVES`/hero-pick test. Second pass, per the
team lead's explicit follow-up ruling (recorded in DECISIONS `[V3-P1]`) to
take the remaining three files since nobody else was editing `apps/web`:
- `lib/advisor.test.ts`: `MOVES` extended with the same fourteen v3 entries.
- `lib/share.ts`: `PRINT_PARAM_SPEC` extended with a `FieldSpec` per v3 group
  (nested per leaf), `hanger`'s two new enum members, and a new
  `ENGRAVING_EDGES` list (`Engraving.edge` gained `"underside"`;
  `ScaleBar.edge` did not, so it can no longer share `EDGES`).
- `lib/share.test.ts`: `randomParams()`/`maximal()` extended to cover all
  fourteen groups; a new "round-trips a v3 payload" test; the "stays inside a
  browser URL" bound corrected from 8 kB to 16 kB with the comment's measured
  numbers updated (the v3 groups roughly double the field count -- still
  comfortably under Chrome's ~32 k address bar).
- `components/scene/CityPreview.test.ts`: a new `V3_ENGINE_MOVES` bucket
  asserting the thirteen non-`place` v3 groups currently rebuild NOTHING (the
  browser engine that will read them has not landed yet); `place` itself
  stays in `V2_TEXT_MOVES`, not `V3_ENGINE_MOVES` -- a deliberate, logged
  deviation from the ruling's literal grouping, because `place` already is a
  live preview dependency today (the `{country}`/`{state}`/`{neighbourhood}`/
  `{author}` tokens this same phase wired up), unlike the other thirteen.

## 5. Verification

```
cd apps/web && npm run typecheck && npm run lint && npx vitest run
cd services/bake && uv run pytest -q
# with `export PATH=".../ezwinports.make.../bin:$PATH"` and `make up` (native, no Docker):
cd apps/web && npx playwright test
make down
```

Final state on this host: typecheck clean, lint clean (0 warnings), vitest
**640/640 across 30 files** (fully green -- the 6 pre-existing failures from
the concurrent contracts landing are all fixed), Python 685/685, Playwright
27/27 including the full `smoke.spec.ts` (real bake, validator
"ALL CHECKS PASS") and the new `lettering.spec.ts`.

## 6. Acceptance checks (from the brief)

- Chicago preset -> `{city}` engraving on the top edge shows "Chicago" in the
  live preview (glyph rings drawn, `data-preview-text-count > 0`) and in the
  Resolved output panel (`status: cut`): PASS.
- Bake -> the sidecar's `print_params.engravings[0].text` is `"Chicago"`
  (not the raw `{city}` token): PASS.
- Clearing the Place name field: Issues badge shows "Line 1: the {city} token
  has no value.", the Resolved output row flips to `skipped`: PASS.
- Turning Frame off: `EngravingsEditor` shows "Turn on Frame to engrave the
  edges.", the row is `aria-disabled`, the text input is disabled, the
  Resolved output row explains "Frame is off": PASS.
- A dragged (non-preset) pin resolves `{city}` via Nominatim within the 5 s
  timeout or falls back (fail soft): exercised by `lib/geocode.test.ts`'s
  mocked-`fetch` suite; not re-exercised live in e2e, since `smoke.spec.ts`'s
  one real pin drop is deliberately left unmocked (see DECISIONS `[V3-P1]`)
  and does not assert on the geocode outcome.
