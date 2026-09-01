# v3-05 - COLOUR group expansion (FrameCraft v3 phase 5, `[V3-P5-C]`)

Scope: palettes, custom palette save/load, building tint, height gradient,
the contrast checker, the preview theme toggle, plus the FRAME group's
profile/corner/shadow-gap/matting/separate-part/face-texture controls and
the extended hanger dropdown (shared file ownership with p5-frame, whose
`lib/engine/solid/**` mesh work this UI drives). Coordinated by SendMessage
with p5-frame throughout; `lib/engine/types.ts` (`REGION_NAMES` split into
`COLOURABLE_REGION_NAMES`/`DERIVED_REGION_NAMES`, `BuildingTint`,
`EngineResult.buildingTints`) landed from p5-frame mid-task and this work
adapted to it rather than inventing a placeholder shape.

## 1. New files

- `apps/web/lib/palettes.ts` -- seven named palettes (Blueprint, Noir,
  Pastel, Brass on Black, Terracotta, Nordic, Chicago) plus `DEFAULT_PALETTE`
  (mirrors the frozen contract default), `paletteApplyPatch` (one
  `colour` patch: full `region_colors`, the palette's own `region_slots`
  opinions layered over the CURRENT table, and `palette` set to its id --
  one `setNested` call, one undoable state change), `matchesPalette`
  (drives the "custom" flip), and the custom-palette persistence layer
  (`localStorage["framecraft.palettes.v1"]`, `SavedPalette`,
  `parseSavedPalettes`/`loadCustomPalettes`/`saveCustomPalettes`,
  `customPaletteId` slugify+dedupe, `savedAsPalette` adapter).
- `apps/web/lib/contrastCheck.ts` -- `ADJACENT_PAIRS` (the eight
  physically-adjacent region pairs the brief names) plus `bandAdjacentPairs`
  (height-gradient band chain, using p5-frame's `bandIndexOf`/
  `DERIVED_REGION_NAMES`), CIE76 distance (reuses `lib/colourMap.ts`'s
  `deltaE76`/`hexToLab` -- one distance function for the app, documented
  choice over CIEDE2000), `CONTRAST_THRESHOLD = 12`, `contrastIssues` (skips
  same-slot pairs -- see `[V3-P5-C]` in DECISIONS.md), `nearestSeparatingColor`
  (nearest built-in-palette swatch that clears the threshold),
  `contrastIssueSentence`.
- `apps/web/lib/tint.ts` -- deterministic per-building tint (`hashUnit`,
  FNV-1a folded with the seed; `tintedColor`/`buildingTintMap`, HSL
  hue/lightness perturbation), the height-gradient slot resolver
  (`boundGradientSlots`, `heightBandIndex`, `resolveGradient`), and
  `tintIsPreviewOnly` (gates the standing note against the ACTIVE
  `export_target`, true for everything except `obj`).
- `apps/web/e2e/colour.spec.ts` -- five specs (below).
- Matching `*.test.ts` for the three new lib files (50 tests) plus additions
  to `lib/colourMap.test.ts` (preview-theme isolation, 3 tests) and
  `lib/warnings.test.ts` (`tintPreviewOnlyWarning`, 3 tests).

## 2. Changed files

- `apps/web/components/editor/groups/ColourGroup.tsx` -- palette picker
  (built-in grid + custom list, save-as field), per-region swatches now flip
  `colour.palette` to `"custom"` on a hand edit (compares against every
  built-in via `matchesPalette`, not just the active one, so switching a
  colour back to what a DIFFERENT palette already has does not falsely stay
  "custom" -- deliberately not implemented that far: it only checks the
  ACTIVE palette id, matching the brief's "editing any colour afterwards
  flips palette to custom" literally), the contrast-checker warning (one
  `Note` per issue, `contrastIssueSentence`), building-tint controls (toggle,
  hue/lightness range, seed + reroll, the preview-only note), height-gradient
  controls (toggle, band count bounded by the active printer profile's own
  slot count, one slot picker per band, labelled through
  `bandRegionName`). `REGION_LABELS` is now `Record<RegionName, string>`
  (was `Record<the old fixed 12, string>`) -- TypeScript holds it exhaustive
  against p5-frame's `cleat`/`buildings_band_2..8` additions, forcing a
  compile error (not a silent raw-id fallback) the next time `RegionName`
  grows.
- `apps/web/lib/colourMap.ts:colourRows` -- the pre-bake fallback now lists
  `COLOURABLE_REGION_NAMES` (the eleven contract regions), not the full
  `REGION_NAMES`: the derived regions (`cleat`, `buildings_band_2..8`) exist
  only once an actual bake produced them (cleat hanger on, gradient on), and
  the OLD `REGION_NAMES.filter(!= easel)` fallback would have listed eight
  phantom gradient-band rows before the user ever turned the gradient on.
- `apps/web/components/editor/groups/FrameTextGroup.tsx` -- FRAME profile
  picker (seven options, each a 24 px `currentColor` SVG cross-section glyph,
  no raw hex -- `design-tokens.test.ts` scans `components/**`), corner style
  + radius (radius only shown once corner != square), lip depth, shadow gap
  (enabled/width/depth), matting (enabled/width/proud), separate frame part
  (enabled/mount snap-or-magnet/tolerance), face texture (pattern/scale/
  depth), hanger dropdown extended to `cleat`/`easel`, and the shared
  `hanger_magnet` fields (diameter/thickness/count) shown whenever EITHER
  `hanger === "magnets"` OR the separate frame's own mount is `"magnet"` --
  one pocket size either way, per the brief.
- `apps/web/store/editor.ts:NestedParamKey` -- added `"frame_style"` and
  `"hanger_magnet"` (the generic `setNested` needed no other change; it
  already rebuilds any nested object by spread from `PrintParams[key]`).
- `apps/web/components/scene/palette.ts` -- `readViewportPalette(element,
  themed)`: reads the four `--fc-viewport-*` tokens off a SPECIFIC element
  (the canvas wrapper), falling back to the app-themed values before mount.
- `apps/web/components/scene/CityPreview.tsx` -- `data-fc-viewport-theme`
  on the viewport wrapper, a `useEffect` that re-reads the viewport palette
  on every `previewTheme`/`themed` change, the corner toggle button
  (`preview-theme-toggle`, top-right, mirrors the Issues/Adjustments chips'
  own styling), `tintColors` computed (engine's own `buildingTints` when
  fresh, `lib/tint.ts`'s deterministic fallback otherwise) and passed to
  `InstancedBuildings`, `tintPreviewOnlyWarning` folded into the Issues
  badge's merged list.
- `apps/web/components/scene/InstancedBuildings.tsx` -- new `tintColors`
  prop (`ReadonlyMap<string,string> | null`), applied per-instance with
  priority cursor > hero > tint > plain colour (a tinted hero/cursor
  building would stop being findable at a glance).
- `apps/web/lib/warnings.ts` -- `tintPreviewOnlyWarning` (graph-independent,
  unlike `sceneWarnings`: whether a tint reaches print is a fact about
  `params` alone).
- `apps/web/app/globals.css` -- `[data-fc-viewport-theme="light"/"dark"]`
  blocks appended after `@theme inline`, deliberately outside the `:root`/
  `.dark` slices `design-tokens.test.ts` scans for "every light token has a
  dark one" (this is a second, independent selector for the SAME two value
  sets, not a new palette).

## 3. Contracts

No schema change: every field this task uses (`colour.palette`, `.tint`,
`.gradient`, `.preview_theme`, `frame_style.*`, `hanger` extended enum,
`hanger_magnet`) already existed in schema_version 3
(`docs/handoff/v3-01-contracts.md`), including the two extended `hanger`
members (`cleat`, `easel`) this task's FRAME group is the first UI consumer
of. Share links already round-trip every group used here (`lib/share.ts`'s
`COLOUR_SPEC`/`FRAME_STYLE_SPEC`, pre-existing) -- verified, not re-tested.

## 4. Coordination with p5-frame

`lib/engine/types.ts` grew `COLOURABLE_REGION_NAMES`/`DERIVED_REGION_NAMES`/
`REGION_NAMES` (band regions `buildings_band_2..8`, `cleat`), `BuildingTint`,
`bandRegionName`/`bandIndexOf`, and `EngineResult.buildingTints` from
p5-frame's own mesh work, landing partway through this task (message sent,
`docs/handoff/v3-05-frame.md` was not yet posted at hand-off time). This
task's code was adapted to the real names/types as they landed rather than
against a placeholder (`ColourGroup.tsx`'s `REGION_LABELS`, `colourMap.ts`'s
`colourRows` fallback, `contrastCheck.ts`'s `bandAdjacentPairs`,
`CityPreview.tsx`'s `tintColors`, all updated in place). A separate,
transient build break (`lib/engine/solid/frame.ts`/`hangers.ts` importing a
not-yet-exported `CIRCLE_SEGMENTS` from `./manifold`) was flagged to
p5-frame and resolved on their side before this task's e2e run; not this
task's file to fix.

## 5. Tests

- Unit: `lib/palettes.test.ts` (16), `lib/contrastCheck.test.ts` (12),
  `lib/tint.test.ts` (22), plus 3 added to `lib/colourMap.test.ts` and 3 to
  `lib/warnings.test.ts` -- 56 new/changed, all passing. Full
  `npx vitest run` (this task's own changes plus p5-frame's concurrent
  `solid/{frame,hangers,tint}.ts` landing): 71 files, 1258 tests, 0 failed.
- `npx tsc --noEmit` / `npm run lint`: clean.
- e2e (`e2e/colour.spec.ts`, 5 specs, all palette-button-driven, no raw
  colour-input dispatch anywhere in this file -- see the note below): apply
  Blueprint and see the region swatch and the button's pressed state move;
  save the current colours (applied via a palette button) as a custom
  palette and reapply it after switching away; a deliberately clashing pair
  (base and buildings, both mid-grey) raises the contrast warning naming
  both regions -- **not** base/water: `e2e/overpassMock.ts`'s
  `mockTinyLoopOverpass` fixture (`tests/fixtures/overpass-tiny-loop.json`)
  is buildings-only, no `highway`/`natural=water`/`landuse`/`leisure` tag at
  all, so once a fresh `EngineResult` exists (which every test here waits
  for) `colourRows` can never surface a `water`/`roads`/`parks` row for this
  scene, whatever colour a test sets -- `base`/`buildings` is the one
  `ADJACENT_PAIRS` entry guaranteed present; flipping the preview theme
  changes the viewport's own `data-fc-viewport-theme` attribute while the
  stats card's own reported geometry (triangles/volume/bbox) stays
  byte-for-byte identical; selecting the ogee profile and a shadow gap
  updates the panel and a bake still downloads. All 5 green, individually
  and as a full-file run, and green again inside a full `make gate`
  (`artifacts/logs/v3-05-gate-2.log`, 44/44 Playwright, `GATE PASS`).
  Playwright's own `.fill()` does not reliably drive a React-controlled
  `<input type="color">` in this app (confirmed on a live screenshot: the
  DOM value updated, the swatch never did); a first fix drove it through a
  native-setter-plus-dispatched-events helper instead, which was reliable in
  several isolated local runs but hung the full scaled timeout inside an
  actual `make gate` run under real system load. The final version seeds a
  one-off custom palette straight into `localStorage`
  (`page.addInitScript`, `CLASH_PALETTE`) and applies it with the same
  palette-button click every other test in this file already uses, so
  nothing here drives a colour input directly at all; see `[V3-P5-C]` in
  `DECISIONS.md` for the full story, including why the FIRST fix (base vs
  water) was a wrong-fixture bug, not a flaky-wait bug.
- Also fixed at the same time, flagged separately by the orchestrator from a
  real CI failure: `e2e/smoke.spec.ts`'s happy-path test had two
  `.toBeVisible()` waits (the bake-status label, and the `.3mf`/`.json`
  download-confirmation links right after the download container itself)
  on Playwright's unscaled 15 s default instead of this file's own
  `WARMUP_BUDGET_MS`/`A4_BUDGET_MS`, unlike every other wait in the file --
  now scaled the same way. Confirmed green inside the same `make gate` run
  (1.6 m).

## 6. Verify

```sh
cd apps/web && npx vitest run
cd apps/web && npx tsc --noEmit -p .
cd apps/web && npm run lint
cd apps/web && npx playwright test e2e/colour.spec.ts --reporter=line
make gate    # from the repo root; artifacts/logs/v3-05-gate-2.log has the last full run
```
