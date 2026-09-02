# v3-06: app and workflow ([V3-P6])

FrameCraft v2 web-editor engineer, phase 6 of `docs/IMPLEMENTATION_PLAN.md`:
address/place search, the project file, the v3 permalink, recent designs,
and undo/redo. Full context: `05_AGENT_TEAM.md`, `01_PRODUCT_SPEC.md`,
`02_TECH_SPEC.md`, `DECISIONS.md`'s `[V3-P6]` lines (the source of every
ambiguity ruling below).

## 1. Search (`lib/geocode.ts`, `components/map/SearchBox.tsx`)

`lib/geocode.ts` grew a forward-geocoding half mirroring the existing reverse
half: `fetchForwardGeocode`/`resolveForwardGeocode`/`scheduleForwardGeocode`,
a 7-day localStorage cache (`GEOCODE_SEARCH_CACHE_KEY`) keyed by normalised
query, a 400 ms debounce. The two kinds of lookup now share ONE module-level
1 rps queue (`enqueueGeocodeRequest`), refactored out of what used to be
`scheduleReverseGeocode`'s own inline queue -- Nominatim's usage policy is a
budget on the client, not per endpoint.

`radiusForResultType` implements the brief's table verbatim: city/town
1500 m, suburb/neighbourhood/quarter 900 m, building/amenity/house 400 m,
default 900 m.

`SearchBox.tsx` is a combobox overlay docked top-right on the map (ARIA
`role="combobox"` + `role="listbox"`, full keyboard nav: arrows, Enter,
Escape). Picking a result calls `setPin`, `setRadius(radiusForResultType(...))`,
and `applyGeocodeResult` (NOT `setPlaceName`) so a search pick sits on the
same place-resolution path a reverse lookup already uses -- `[V3-P6]`
decision. A `skipNextSearch` ref stops the box from re-searching its own
label text after a pick writes it back into the query state.

## 2. Project file (`lib/project.ts`)

`.framecraft.json`: `{format: "framecraft-project", version: 3, saved_at,
pin, radius_m, rotation_deg, preset_id, place, params: PrintParams}`. Carries
the WHOLE `PrintParams` object, not a diff (unlike a share link) -- a file
on disk should keep meaning the same thing after a future default changes.
`parseProject` reuses `lib/share.ts`'s new `parsePrintParams` export (see
below), so a project file and a share link validate a setting value
identically by construction. `downloadProject` triggers a Blob-URL download;
`store/editor.ts:applyProject` applies the result AND calls `generate()`
immediately (a project load is a deliberate "open this" action, unlike a
share restore which stays stale for the user's own Generate click).

## 3. Share link v3 (`lib/share.ts`)

`SHARE_VERSION` is now `"v3"`: the payload is `deflateSync`'d (fflate, raw
deflate, already a runtime dependency) before base64url. `DECODABLE_VERSIONS
= ["v2", "v3"]` -- `decodeShare` still reads a plain, uncompressed v2 link
made before this phase. The checksum is computed over the DECOMPRESSED JSON
text in both cases, so `checksum()` itself is unchanged. Measured at the
contract's real maxima (the `maximal()` fixture, highly repetitive by
construction): 1766-1811 characters compressed against 6828-9218 uncompressed
pre-phase; a default configuration is 134 characters. `SHARE_LINK_LENGTH_LIMIT
= 8000`: past it, the Copy-link UI (`OutputPanel.tsx`) refuses to copy and
offers Save-project instead -- there is no share-id server by design.

Refactor: the params-parsing loop that used to live inline in `decodeShare`
is now `parsePrintParams` (exported), reused by `lib/project.ts`.

## 4. Recent designs (`lib/recent.ts`, `components/editor/RecentDesigns.tsx`)

`framecraft.recent.v1`, cap 12, newest first, deduped by payload (a repeat
moves to the front rather than duplicating). Every successful Copy-link and
every completed bake (`OutputPanel.tsx`, a `useEffect` keyed on the whole
`bake` object so it fires exactly once per "done" transition) records
`{name: "<place> (<date>)", savedAt, payload}` where `payload` is the exact
`encodeShare` string -- restoring an entry is `decodeShare` on it, the same
path a shared link takes. `writeStore` fires a `framecraft:recent-changed`
window event so the list widget refreshes without polling storage.

## 5. Undo/redo (`store/history.ts`, `components/editor/HistoryChip.tsx`)

A SEPARATE zustand store, wired by subscribing to `useEditorStore` and
diffing `location`/`params` BY REFERENCE across each notification --
`store/editor.ts`'s setters were not touched individually. Since zustand
notifies once per `set()` call, one compound action (`applyPreset`,
`applyShared`, `applyProject`, `resetParams`, `applySafeFindingFixes`, a
palette apply) is naturally one history entry. Coalescing: a change with the
SAME "path" (e.g. `location.radius_m`) within `HISTORY_COALESCE_MS` (800 ms)
of the previous entry replaces it instead of stacking. Cap 100
(`HISTORY_CAP`), oldest dropped.

`describeChange` produces the label ("Radius 900 m to 1200 m", "Preset:
Chicago", "Plate mm 180 mm to 200 mm", ...): location fields get a
hand-written sentence each; a `PrintParams` change is described generically
by finding the first differing top-level key and, for a nested group, the
first differing leaf inside it.

`applyHistorySnapshot` (new `store/editor.ts` action) applies an undo/redo
target: marks the scene stale ONLY when location actually differs in value
(never on a pure-params step), always reschedules the debounced WASM engine
job (never a network call), and never itself calls `generate()` -- so undo
can never trigger an Overpass refetch on its own, per the brief.

`HistoryChip.tsx`: a new chip with Undo/Redo buttons and a clickable step
list (`jumpToHistory`), same visual language as `AdjustmentsChip`/`IssuesBadge`
(see the `[V3-P6]` DECISIONS line on why this was not folded into
`AdjustmentsChip`) but rendered in `EditorShell`'s HEADER, not in
`CityPreview`'s scene-gated chip stack: `CityPreview` returns `PreviewEmpty`
before a scene exists and never reaches that stack's render branch at all,
while a parameter change is recorded into history from the very first slider
move -- found by `e2e/workflow.spec.ts` failing (`element(s) not found`) on a
scenario that changes settings without ever generating a scene.

A second, more serious bug in the same component was also only caught by the
e2e run, not by reading the code: its step count read `entries.length - 1`
(every step ever recorded) instead of `cursor` (the step CURRENTLY applied).
Undo never shrinks `entries` -- it only moves `cursor` backward, which is
what keeps a redo branch alive -- so the two numbers are identical at the tip
of history and diverge the instant a real undo runs, at which point the chip
kept showing the pre-undo count forever. A raw-keydown diagnostic (logging
`ctrlKey`/`key`/`target` from a second `window` listener) proved the Ctrl+Z
shortcut dispatched correctly and `useHistoryStore`'s own `cursor` moved as
expected; only the chip's OWN derived display was wrong. Fixed by reading
`cursor` directly, with a separate `hasHistory` (`entries.length > 1`) boolean
for "does the chip render/close its drawer at all", since `stepCount` can now
legitimately read 0 (undone all the way back to Start) while real history
(and a Redo) still exists.

Keyboard: `lib/keyboard.ts:shortcutFor` now special-cases Ctrl+Z / Ctrl+Shift+Z
(and Cmd on Mac) ahead of the "never a chord" rule, but still behind the
"never inside a typing target" rule (checked first) so a text field's native
undo is never hijacked. `EditorShell.tsx` dispatches `undo`/`redo` even while
another overlay (shortcut sheet, Issues/Adjustments drawer) is open.

## 6. Attribution standing copy

`FrameTextGroup.tsx`'s underside-mark template field gained one line of
standing copy noting that the text is appended to the mandatory FrameCraft +
OpenStreetMap credit; p7-attribution's engine work enforces this, this is
only the UI saying so.

## Tests

- `lib/geocode.test.ts`: +34 (forward geocode fetch/cache/schedule, shared
  queue, `radiusForResultType`, `placeNameFromLabel`).
- `lib/share.test.ts`: v2 back-compat suite, version-refusal test updated for
  v3-as-default, compactness numbers remeasured and re-asserted, `payloadOf`
  test helper now deflates.
- `lib/project.ts` / `lib/project.test.ts`: new, 15 tests (round trip,
  filename, every refusal path).
- `lib/recent.ts` / `lib/recent.test.ts`: new, 12 tests (cap, dedupe, fail-soft
  storage, corrupt-entry filtering).
- `store/history.ts` / `store/history.test.ts`: new, 29 tests (`describeChange`,
  coalescing, cap, undo/redo/jumpTo, wired-to-editor-store integration,
  "undo never fetches unless location changed", composite-action-is-one-step).
- `lib/keyboard.test.ts`: +5 (Ctrl+Z/Ctrl+Shift+Z, Cmd variant, Alt-refusal,
  typing-target refusal), "documents every action" list updated.
- `e2e/workflow.spec.ts`: new -- search+pick, three-settings+Ctrl+Z x2+chip
  count, save/reload/load project round trip, copy-link+fresh-context restore
  (light version of `e2e/share.spec.ts`'s exhaustive one). The undo/redo test
  drives boolean/numeric controls only (not a text field: see the `[V3-P6]`
  DECISIONS line on the `.fill()` input-timing artifact this session
  observed); the project round-trip test uses an `openGroup` helper
  (mirroring `e2e/lettering.spec.ts`'s), since a group's collapse state
  persists to localStorage across `page.reload()`.
- `e2e/share.spec.ts`: `s=v2.` -> `s=v3.` assertions updated for the new
  default write version; back-compat itself is covered in `lib/share.test.ts`.

## Verification

```
cd apps/web
npx tsc --noEmit -p .           # clean
npx eslint . --max-warnings 0   # clean
npx vitest run                  # 1382/1382 green
npx playwright test e2e/workflow.spec.ts   # 4/4, run four times to confirm stable
```

Full `make gate` (`artifacts/logs/v3-06-gate.log`, run after p7-attribution
confirmed their tree settled): **GATE PASS**. `uv run pytest` in
`services/bake` 697 passed; `apps/web` lint/typecheck/vitest (1382 passed) all
clean; `next build` succeeds; `bake:cli` + `make validate` ALL CHECKS PASS on
both the default and parts fixtures; the full Playwright suite (every spec
file, not just this phase's) is **48 passed, 0 failed, 0 flaky, 0 skipped**.

The first gate run caught two real accessibility bugs `make gate`'s own
`e2e/a11y.spec.ts` found and neither unit tests nor a code read had: `SearchBox.tsx`
pointed `aria-controls`/`aria-owns` at a listbox id that does not exist in the
DOM while closed (axe `aria-valid-attr-value`, fixed the same way every other
disclosure in this app already handles it), and two new `<input>`s (the
search box itself, and `OutputPanel.tsx`'s hidden project-file input) had no
accessible name at all. Both fixed (see the matching `[V3-P6]` DECISIONS
line); the second gate run is the clean one above.

## Deviations / ambiguity rulings (see `DECISIONS.md` for the full text)

- `[V3-P6]` History chip is a new, separate widget, not a repurposed
  `AdjustmentsChip`.
- `[V3-P6]` No share-id backend; length guard offers a project-file save
  instead.
- `[V3-P6]` Share version tag now names the payload FORMAT, decoupled from
  `PrintParams.schema_version`.
