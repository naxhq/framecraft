# v3 Task 9 audit: the location search

Adversarial review of the uncommitted Task 9 change set. Reviewer did not write
the code. Read-only: nothing outside this file was modified.

Change set bounded by `git status` and
`git diff HEAD -- apps/web/components/map apps/web/lib/photon.ts
apps/web/lib/coordinates.ts apps/web/lib/recentSearches.ts
apps/web/lib/geocode.ts apps/web/e2e`. `apps/web/lib/engine/**` is another
agent's live rewrite and is out of scope here except where a shared symbol is
named.

## What was run

| Command | Result |
|---|---|
| `npx vitest run lib/coordinates.test.ts lib/photon.test.ts lib/recentSearches.test.ts lib/geocode.test.ts` | 4 files, 140 tests, all pass, 186 ms |
| `npx tsc --noEmit` | clean, exit 0 |
| `E2E_BUDGET_FACTOR=3 npx playwright test --project=chromium e2e/search.spec.ts` | 9 passed, 1 failed, 3.9 min |
| `vite-node` probe of `coordinateReadings` over 56 inputs | table in finding 9 and 10 |

`artifacts/build.lock` did not exist, so the axe sweeps were run rather than
reviewed statically. **All 12 axe states report 0 violations**, reproduced
independently (light and dark, closed / empty / hint / results-with-active-row
/ coordinates / recents). That result is real but narrower than it looks: see
findings 2 and 4, both of which are outside what those states visit or what axe
checks at all.

The one e2e failure is not this task's. `search.spec.ts:129` waits for
`preview-stats` after clicking the `chicago-loop` preset and times out at
180 s with the Preview button still reading "Preview"
(`artifacts/e2e/test-results/search-arrow-down-and-Ente-4dd9c-ew-without-an-Overpass-call-chromium/error-context.md:154`).
The search box is never touched before that line. The engine build not
completing is consistent with the concurrent `lib/engine/**` rewrite, which the
implementer's own note already flags. Everything the test would have asserted
about the search box after line 129 therefore went unverified in this run.

## Findings

### 1. Blocker: picking a result never moves the map

`components/map/LocationPicker.tsx:238-247` is the only code in the repo that
changes the map viewport, and it is gated on `presetId`:

```
if (!map || !presetId || presetId === lastPresetRef.current) return;
```

`setPin` writes `preset_id: null` (`store/editor.ts:598`). A search pick goes
through `moveTo` -> `setPin` (`components/map/SearchBox.tsx:220`), so `presetId`
is null and the effect returns immediately. The overlay effect at
`LocationPicker.tsx:220-233` moves the marker, the radius circle and the crop
square to the new coordinates, but the camera stays where it was.

Search for a place outside the current viewport and the map shows an unchanged
picture with the pin, the circle and the crop square all off-screen. The only
visible feedback is the radius chip and the place name changing. For a feature
whose entire purpose is travelling to a place, that reads as broken.

This is not a regression: the previous SearchBox did not fly either
(`git show HEAD:apps/web/components/map/SearchBox.tsx`, no `fitBounds`,
`flyTo`, `setCenter` or `panTo` anywhere in it). It becomes a blocker now
because the old box could only reach one Nominatim answer per deliberate
submit, and the new one is a type-ahead over the whole planet.

**How to prove it.** Route Photon to a fixture whose feature is far from the
default Chicago pin, pick it, then read `map.getCenter()`. Or in the browser:
search "Paris", pick the city, watch the map. No test can catch it today
because every fixture in `e2e/fixtures/photon-chicago.json` sits within a few
hundred metres of the default pin, so the existing assertions pass whether the
camera moves or not.

**Smallest fix.** In `LocationPicker.tsx`, add an effect that fits the map to
the radius ring whenever `lat`/`lon` change to a value the map did not itself
produce. The picker already computes exactly that ring at lines 241-246 for the
preset path; guard it with a ref holding the last coordinates the map's own
click and drag handlers wrote (`LocationPicker.tsx:188`, `:193`) so a user
clicking the map is not fought by a camera animation.

### 2. Major: the ARIA combobox is split across two elements, so the expanded state is never on the focused control

`SearchBox.tsx:429-439` puts `role="combobox"`, `aria-expanded`,
`aria-controls`, `aria-owns` and `aria-haspopup` on a wrapper `<div>` that is
not focusable and has no accessible name. Focus lives on the `<input>` at
`:440-447`, which carries `role="searchbox"`, `aria-autocomplete="list"`,
`aria-activedescendant` and its own `aria-controls`.

That is the deprecated ARIA 1.1 arrangement. Under ARIA 1.2 the combobox role
and its state belong on the text input itself. As written, a screen reader user
focused on the input is never told the popover expanded or collapsed, because
`aria-expanded` is on an element they are not on. `aria-activedescendant` on a
`searchbox` referring into a listbox owned by an ancestor is at best
implementation-defined.

**Why the axe sweep does not catch it.** Verified: 0 violations in all 12
states. axe checks that referenced ids resolve and that roles are valid, not
that the pattern composes. `aria-input-field-name` (serious) selects
`[role="combobox"]` and the wrapper div has no `aria-label`, `aria-labelledby`
or `title`, yet the closed-state sweep passes it. Whatever the reason, a green
axe run is not evidence the pattern is right, and the spec note at
`SearchBox.tsx:423-427` claims more than the sweep proves.

**How to prove it.** NVDA or VoiceOver on the box: type three characters, listen
for "expanded"; arrow down, listen for the option text. Neither is announced.

**Smallest fix.** Move `role="combobox"`, `aria-expanded`, `aria-controls` and
`aria-haspopup` onto the `<input>`, drop `role="searchbox"` and the wrapper's
role and `aria-owns`, and keep the wrapper as a plain positioning `<div>`.

### 3. Major: no live region for the result count

The brief asks for an announcement of "N results". `StatusLine`
(`SearchBox.tsx:677-739`) returns `null` for the success case: when three
results arrive, `phase` is `"results"`, `nothingFound` is false, and every
branch falls through to `return null` at `:738`. Nothing is announced. A screen
reader user types, hears nothing, and has to arrow into a list they were not
told exists.

Compounding it: each `role="status"` node is mounted and unmounted together
with its own text (`:690`, `:701`, `:712`, `:718`, `:725`, `:732`), and the
whole popover unmounts at `:500`. A live region inserted at the same instant as
its content is the classic unreliable pattern; the region should already be in
the DOM when its text changes.

**How to prove it.** Read the accessibility tree in the results state and look
for a live region containing a count. There is none.

**Smallest fix.** One always-mounted visually hidden `<p role="status"
aria-live="polite">` outside the `popoverOpen` conditional, whose text is set
to the count on success, to the empty message, and to the unavailable message.
Leave the visible `StatusLine` paragraphs as plain text with no live role.

### 4. Major: `aria-activedescendant` is left pointing at a removed id after a blur close

`activeId` (`SearchBox.tsx:408-409`) is computed from `options` alone, with no
reference to `listboxOpen`. The blur path (`:470-475`) sets `open` to false
after 150 ms and never resets `activeIndex`. `setActiveIndex(-1)` is called on
Escape (`:393`), on a pick (`:234`), on a removal (`:351`) and on each search
outcome (`:169`), but not on the blur close.

So: arrow down onto a row, click the map, wait 200 ms. `popoverOpen` goes
false, the listbox unmounts, and the input still carries
`aria-activedescendant="search-option-place-R122604"` naming an element that no
longer exists. That is `aria-valid-attr-value` at serious impact, the exact
rule the comments at `:432-438` and `:448-450` were written to defend against
for `aria-controls`.

**How to prove it.** In the running app, focus the box, type three characters,
press ArrowDown, click the map, then read
`document.querySelector('[data-testid=location-search]').getAttribute('aria-activedescendant')`
and try `document.getElementById(...)` on the value. The e2e axe sweep never
visits this state: it audits closed only before anything is typed
(`e2e/search.spec.ts:314`).

**Smallest fix.**
`const activeId = listboxOpen && activeIndex >= 0 && activeIndex < options.length ? options[activeIndex].id : undefined;`

### 5. Major: Enter does nothing when no row is highlighted

`SearchBox.tsx:382-388` acts on Enter only when `activeIndex >= 0`. Type a
coordinate pair and press Enter and nothing happens. That is the path the
failure message itself sends people down: "Search is unavailable right now,
enter coordinates instead" (`:64`), shown at `:706`. A user who follows that
instruction, types the coordinates and presses Enter gets silence, and has to
discover ArrowDown first.

**How to prove it.** Type `41.8827, -87.6233`, press Enter, read
`useEditorStore.getState().location`. Unchanged.

**Smallest fix.** On Enter with `activeIndex < 0` and `options.length > 0`,
choose `options[0]`. The first option is already the best reading for a
coordinate query and the top-ranked place otherwise.

### 6. Major: no IME composition guard

`onChange` at `SearchBox.tsx:455` fires on every composition update, because
React's `onChange` is the DOM `input` event and that fires while an IME is
composing. Typing a Japanese or Chinese place name therefore sends Photon
requests for uncommitted romaji or pinyin of three characters or more, which is
both wasted traffic on somebody else's public endpoint and a list of wrong
answers flickering under the composition window.

Worse, Enter is how an IME candidate is committed. `onKeyDown` at `:382` does
not check `isComposing`, so committing a candidate while a row is highlighted
selects that row and moves the pin instead of finishing the word.

The brief asked specifically for this to be confirmed; it is not handled.

**How to prove it.** Chrome with a Japanese IME, or synthetically: dispatch
`input` events with `isComposing: true` and count requests; dispatch
`keydown` with `key: "Enter"` and `isComposing: true` and watch `pick` run.

**Smallest fix.** Hold a `composingRef` set by `onCompositionStart` and
`onCompositionEnd`, skip the search effect while it is true, and return early
from `onKeyDown` when `event.nativeEvent.isComposing` is true.

### 7. Major: the Photon place name is overwritten by Nominatim about 600 ms later

`moveTo` (`SearchBox.tsx:218-226`) calls `applyGeocodeResult` with the Photon
name in `city`. `setPin` then changes `location.lat`/`lon`, which re-runs
`EditorShell.tsx:196-202`'s effect, which schedules a Nominatim reverse geocode
for the new pin. When it lands, `applyGeocodeResult` rewrites `city_label`
again (`store/editor.ts:773`) because `placeDetect.overridden` is false.

Pick "Willis Tower" and the Place name field reads "Willis Tower", then flips
to "Chicago" a moment later with no user action. The same call also blanks
`params.place.country`, `state` and `neighbourhood` (`store/editor.ts:764-766`)
until the reverse geocode refills them, so an offline or rate-limited Nominatim
leaves those three fields empty where they previously held real values.

The handoff note's claim that a pick "binds the place name through
`applyGeocodeResult`" is therefore true for about half a second.

**Why no test sees it.** `e2e/search.spec.ts:145` asserts
`#city_label` has value "Chicago". The Photon fixture's first feature is named
"Chicago" and the Nominatim reverse fixture's city is "Chicago", so the
assertion holds whichever wrote it. Removing the `applyGeocodeResult` call from
`moveTo` entirely would not fail any test in the suite.

**Smallest fix.** Either drop the name binding from `moveTo` and let the
existing reverse geocode name the pin (which is what `pickCoordinates` already
does deliberately, `:258-261`), or pass the Photon name through a path that
marks it as user-chosen so the reverse result does not clobber it. Do not send
`{country: null, state: null, neighbourhood: null}` into `applyGeocodeResult`
in either case.

### 8. Minor: ArrowUp from nothing selected skips the last row

`SearchBox.tsx:367`: `setActiveIndex((current) => (current - 1 + count) % count)`.
With `current` at its initial `-1` and eight options that is
`(-1 - 1 + 8) % 8 = 6`, the second from last. ArrowUp on a freshly opened
listbox is supposed to land on the last option. ArrowDown from `-1` is correct
(`:360` gives 0) and both wrap correctly once a row is selected, so this is the
one entry point that is off by one.

**Smallest fix.** `setActiveIndex((current) => (current <= 0 ? count : current) - 1)`.

### 9. Minor: a typed minus sign and a contradicting hemisphere letter resolve silently to the letter

Measured with `vite-node` against `lib/coordinates.ts`:

```
"-41.8827 N, 87.6233 W"   ->  41.88270, -87.62330
```

`signedValue` (`coordinates.ts:385-393`) treats the letter as authoritative
whenever one is present. For agreeing input (`-33.8688 S` -> -33.8688) that is
right and is what the comment at `:388-389` describes. For contradicting input
it discards the sign the user typed and puts the pin in the opposite
hemisphere, roughly 9200 km from where they meant.

**Smallest fix.** In `signedValue`, return no value when
`component.degrees < 0` and the hemisphere is `N` or `E`, and drop the reading
in `placements`. A contradiction is not a coordinate.

### 10. Minor: a lowercase `s` for South is rejected while lowercase `n`, `e` and `w` are accepted

Measured:

```
"33.8688S, 151.2093E"   ->  -33.86880, 151.20930
"33.8688s, 151.2093e"   ->  REJECTED
"s 33.86 e 151.20"      ->  REJECTED
"34.05s 18.42e"         ->  REJECTED
"n 41.88, w 87.62"      ->  41.88000, -87.62000
```

`coordinates.ts:187-191` claims lowercase `s` for the seconds mark before
`:198-201` can read `S` for South, and only `S` is uppercase-only; `:193`,
`:203` and `:208` all accept both cases for N, E and W. The documented reason
(the s/S collision) is real, but the resulting asymmetry means every
southern-hemisphere pair typed in lowercase silently falls through to Photon as
free text and is never offered as a coordinate row. Sydney, Cape Town, Buenos
Aires and Auckland users hit this; Chicago users do not.

**Smallest fix.** Treat a lowercase `s` as South when it is the first or last
token of a component and no minutes token has been read, which is the only
position South can occupy and never the position the seconds mark occupies.
Failing that, document the uppercase requirement in the coordinate hint at
`SearchBox.tsx:65`.

### 11. Minor: the tokenizer rejects a newline, a semicolon and surrounding parentheses

Measured:

```
"41.8827\n-87.6233"      ->  REJECTED
"41.8827;-87.6233"       ->  REJECTED
"(41.8827, -87.6233)"    ->  REJECTED
```

`tokenize` (`coordinates.ts:105-114`) skips only the space and the tab and
treats only the comma as a separator; everything else returns null at `:214`.
A pair pasted out of a spreadsheet cell, a log line or a code literal is
rejected and turned into a Photon request for text no geocoder will ever match.
Correctly rejected in the same run, and worth keeping rejected:
`41,8827 -87,6233` (European decimal comma, four components),
`41.8827, -87.6233, 5`, `Route 66`, `1600 Pennsylvania Ave`, `12.34`,
`45, 181`, `lat 41.88 lon -87.62`.

**Smallest fix.** Add `\n`, `\r`, `;`, `(` and `)` to the skip and separator
branches at `:105-114`.

### 12. Minor: the recents list is not shared across tabs, though the comment says it is

`SearchBox.tsx:99-101` says the recents "survive a reload and are shared with
any other tab; the event keeps this copy honest without polling". The event is
a `CustomEvent` dispatched on `window` (`recentSearches.ts:106`) and is
same-document only. A pick in one tab is invisible to another tab until it
remounts. Every localStorage claim in the module header at
`recentSearches.ts:1-16` is otherwise accurate, and the private-mode and
corrupt-store paths are correct and tested (`recentSearches.test.ts:133-178`).

**Smallest fix.** Also register `window.addEventListener("storage", refresh)`
in the effect at `:101-106`, filtered on
`event.key === RECENT_SEARCH_STORAGE_KEY`, or delete the sentence.

### 13. Minor: a coordinate or recent pick overwrites a deliberately chosen radius

`pickCoordinates` (`SearchBox.tsx:261`) calls
`radiusForResultType({type: null, addresstype: null})`, which returns the 900 m
default (`lib/geocode.ts:304`). A user who set 1500 m by dragging the radius
handle and then typed coordinates to move the pin loses that choice with no
warning. `[V3-P6]`'s table is a rule for classifying a *place*; a raw
coordinate carries no class, and the honest answer is to leave the radius
alone. `pickRecent` (`:278`) has the same shape but a real kind, so it is
defensible there.

Verified against the frozen table (`lib/geocode.ts:299-305`): city and town
1500, suburb/neighbourhood/quarter 900, building/amenity/house 400, everything
else 900. `radiusForPlace` routes every `PlaceKind` through it unchanged
(`lib/photon.ts:302-304`), and `photon.test.ts:156-173` pins all eleven kinds.
The rule matches `[V3-P6]`.

### 14. Minor: the stale-response guard is React's cleanup ordering, not a sequence number

`schedulePhotonSearch` hands `onOutcome` the query it was called for
(`lib/photon.ts:529`, `:568`), and `photon.test.ts:521` asserts that argument.
The component ignores it: `SearchBox.tsx:157` destructures only `outcome`.

The `.then` guard at `lib/photon.ts:566` checks `cancelled` and
`outcome.status === "aborted"`. Neither covers a superseded request whose
`response.json()` resolved a tick before the abort landed: it returns
`{status: "ok"}` and `cancelled` is false, because a later
`schedulePhotonSearch` call aborts the previous controller (`:540-543`) without
setting the previous call's `cancelled` flag.

Today this cannot fire, because the component returns the canceller as the
effect cleanup (`:156`) and React runs cleanup before the next effect, so
`cancelled` is always set before the new schedule. That is a correctness
property of React's scheduling, not of this module, and it evaporates the
moment anyone calls `schedulePhotonSearch` outside an effect or adds a second
consumer. The module-level `debounceTimer` and `inFlight`
(`lib/photon.ts:506-507`) are shared by every caller for the same reason.

**Smallest fix.** In `SearchBox.tsx`, hold the current query in a ref and add
`if (forQuery !== queryRef.current) return;` at the top of the outcome handler.
Two lines, and it makes the guard local to the component that needs it.

### 15. Minor: `delay()` leaks its abort listener

`lib/photon.ts:402-410` adds an `abort` listener to the caller's signal and
never removes it. One leaked listener per 5xx retry, on a signal that dies with
the request, so the practical cost is nil, but it is the only listener in the
file without a matching removal (`attempt` removes its own at `:450`). It also
never resolves early when the signal was *already* aborted before the call, so
an aborted retry still waits the full 2000 ms before returning.

**Smallest fix.** `if (signal?.aborted) return Promise.resolve();` at the top,
and remove the listener in a `finally`.

### 16. Minor: Delete on a highlighted recent fires while the input holds whitespace

`SearchBox.tsx:397-405` justifies itself with "they are only ever on screen
while the box is empty". The recents branch keys on `trimmed === ""`
(`:176`), not on `query === ""`, so a box holding only spaces shows the recents
list. Backspace then removes a recent instead of deleting a space, and
`event.preventDefault()` at `:402` stops the text edit outright.

**Smallest fix.** Gate the branch on `query === ""` rather than on the
highlighted option's kind, or check `query === ""` in addition.

### 17. Minor: the remove control on a recent row is not reachable by keyboard or announced

`SearchBox.tsx:631-643` is a `role="presentation"` span with an `onMouseDown`
handler and a `title`. The reasoning at `:625-629` is correct as far as it goes
(an interactive control inside `role="option"` is axe's `nested-interactive`),
but the chosen way out leaves a pointer-only affordance that assistive
technology cannot see. The keyboard route exists (Delete on the highlighted
row, spelled out at `:548-550`) yet is undiscoverable to anyone who cannot see
that sentence, and screen reader users get no hint the row is removable at all.

**Smallest fix.** The APG's own answer to a list with per-row controls is the
grid pattern: `role="grid"` on the `<ul>`, `role="row"` on each `<li>`, the
label in a `role="gridcell"` and the remove control in a second one as a real
`<button>`. That keeps axe green and makes the control focusable.

## Request policy under adversarial typing: verified

Traced through `SearchBox.tsx:122-173` and `lib/photon.ts:527-583`, and
confirmed end to end by `e2e/search.spec.ts` tests 1 and 2, both of which pass.

| Sequence | Requests | Aborts |
|---|---|---|
| `c`, `ch` | 0 | 0 |
| `chi`, pause past 250 ms | 1 | 0 |
| 4th character inside the debounce | 1 (the previous debounce is cleared, never sent) | 0 |
| 4th character after the request went out | 1 | 1 |
| delete back to `ch` | 0 | 1 (the in-flight `chi`) |
| paste 30 characters | 1 | 0 |

The abort reaches `fetch`: `attempt` creates an inner controller, forwards the
external signal to it (`lib/photon.ts:424-425`) and passes
`controller.signal` into `fetchImpl` (`:430`). Proven off the wire rather than
from the source: `e2e/search.spec.ts:104-106` asserts the superseded URL turns
up in Chromium's own `requestfailed` list with `net::ERR_ABORTED`. That test
would fail, not pass silently, if the signal stopped being passed.

Minimum length is enforced three times: the component (`SearchBox.tsx:142`),
the scheduler (`lib/photon.ts:546`) and the request function (`:477`).
Whitespace padding is handled by all three, since all three trim. IME
composition is not, which is finding 6.

The LRU key includes the rounded bias (`lib/photon.ts:327-329`, `:124-127`),
uses the same `BIAS_DECIMALS` as the URL builder (`:135-138`), and a cache hit
returns before the debounce is ever scheduled (`:552-558`), so it costs no
request. Pinned by `photon.test.ts:264-271` and `:491-504`.

## Failure handling: verified, with one number worth knowing

Every path was traced and every one reaches a terminal state. **No path leaves
the control in a permanent "searching" state.**

| Condition | Behaviour | Evidence |
|---|---|---|
| 429 without `Retry-After` | 30 s cooldown, no retry, later queries refused locally | `photon.ts:493-496`, `photon.test.ts:363-383` |
| 429 with `Retry-After: 120` | 120 s cooldown | `photon.test.ts:385-393` |
| 429 with `Retry-After: 1` | 30 s floor holds | `photon.test.ts:395-406` |
| 5xx | one retry after 2 s, then unavailable, never a third | `photon.ts:487-491`, `photon.test.ts:339-361` |
| network error, 4xx | unavailable | `photon.test.ts:319-337` |
| malformed JSON | unavailable (the `json()` rejection is caught at `photon.ts:443`) | `photon.test.ts:330-336` |
| hung request | 5 s timeout, then unavailable | `photon.ts:420-423`, `photon.test.ts:408-421` |
| zero features | `search-empty`, distinct from `search-unavailable` | `SearchBox.tsx:410`, `:731`, e2e test 6 passes |

The one number: a 5xx that times out twice takes **12 s** to produce a message
(5 s timeout, 2 s retry delay, 5 s timeout), and the box says "Searching..."
for all of it with no cancel affordance. Within the letter of "never a hang",
but a long silence. Consider capping the whole attempt chain rather than each
attempt.

## Selection semantics: mostly correct

- **No Overpass.** `moveTo` calls `setPin`, `setRadius` and
  `applyGeocodeResult` only (`SearchBox.tsx:218-226`). None of the three calls
  `generate()` or `ingest`. Confirmed as a POST count in
  `e2e/workflow.spec.ts:84` and `e2e/search.spec.ts:153`. The previous
  implementation called `store.generate()` on every pick
  (`git show HEAD:apps/web/components/map/SearchBox.tsx`, line 85). Genuine
  improvement, correctly claimed.
- **Stale and Preview.** `setPin` sets `scene.stale`, `markEngineStale` and
  `markExportStale` (`store/editor.ts:597-607`); `setRadius` does the same
  (`:616-622`). Preview lights up.
- **Not free, though.** `setPin` and `setRadius` each call `scheduleTerrainJob`
  (`store/editor.ts:611`, `:623`) and `applyGeocodeResult` calls
  `scheduleEngineJob` (`store/editor.ts:778`). With terrain enabled that is a
  DEM tile fetch; with a scene already built, `runEngineJob` re-runs the WASM
  boolean pass over the *previous* location's scene graph
  (`store/editor.ts:467-470` returns early only when `scene.graph` is null).
  Pre-existing store behaviour shared with a map click, not introduced here,
  but the note's "no rebuild" is about Overpass only and should say so.
- **Radius rule.** Matches `[V3-P6]`, see finding 13 for the coordinate case.
- **Place name.** Binds with source "geocode" and respects `overridden`
  (`store/editor.ts:773`), so a user's typed name wins. It does not survive the
  reverse geocode that its own pin move triggers: finding 7.

## Recents and geolocation: correct

Storage key `framecraft.search.recent.v1`, cap 8, dedupe on name plus
coordinates rounded to four decimals (`recentSearches.ts:20-50`). Removal,
clearing, a corrupt value, a non-array value, a per-entry malformed row, a
storage that throws on every call and a missing `window` are all handled and
all tested (`recentSearches.test.ts:133-178`). Cross-tab sync is the one false
claim, finding 12.

`navigator.geolocation.getCurrentPosition` is called only from `locateMe`
(`SearchBox.tsx:308`), which runs only from `choose` (`:344`), which runs only
from a click or Enter on the row. Nothing on mount, nothing on focus. Denial,
timeout and position-unavailable each get their own sentence
(`:327-333`), there is no retry, and a browser without the API is handled
(`:299-303`). `e2e/search.spec.ts:253` asserts the row is offered without being
called. Two small things, neither worth a number: nothing prevents starting a
second lookup while one is pending, and the success callback writes state with
no mounted check.

## Attribution: correct

`app/layout.tsx:53-60` renders "Search by Photon (komoot), geocoding by
Nominatim, map data (c) OpenStreetMap contributors" in the always-visible
footer. The popover repeats it at `SearchBox.tsx:566-573`, unconditionally
whenever the popover is open, not on hover. The OSM credit is unchanged in
wording and still also flows to the map's own `AttributionControl`
(`LocationPicker.tsx:99`, `:115`). `e2e/search.spec.ts:348-363` asserts both
places. No finding.

## Tests: strong, with four gaps

The unit suites exercise behaviour rather than restating internals. The abort
test observes the signal actually handed to `fetchImpl` and asserts
`signals[0].aborted` flips (`photon.test.ts:465-489`); the debounce test
advances fake timers through four keystrokes and asserts one request
(`:450-463`); the 5xx test asserts nothing has been sent at
`PHOTON_RETRY_DELAY_MS - 1` and exactly two calls after (`:339-352`). The e2e
mocks every host it needs: `photon.komoot.io` and all of
`nominatim.openstreetmap.org` (`e2e/photonMock.ts:18-20`), plus Overpass
through `watchOverpass` and `mockTinyLoopOverpass`.

**Would the specs pass against a broken abort?** No, and this is the suite's
best work. `e2e/search.spec.ts:104-106` polls Chromium's `requestfailed` list
for the superseded URL with `net::ERR_ABORTED`. Drop the signal from the
`fetch` call and the request completes normally, `failed` stays empty, and the
poll times out.

Gaps:

1. Nothing covers the late-resolving superseded response of finding 14.
2. `e2e/search.spec.ts:145`'s `city_label` assertion cannot distinguish the
   Photon binding from the Nominatim overwrite, because both fixtures say
   "Chicago" (finding 7).
3. Nothing asserts the map viewport (finding 1).
4. The axe sweep visits six states and never the blurred-with-active-row state
   of finding 4.

Note also `console.log` at `e2e/search.spec.ts:287`, which prints six lines per
theme into the Playwright output. Harmless, deliberate, mentioned only because
item 9 of the brief asked.

## Item 9 sweep: clean

- **Bundle.** Nothing added to the first load. `SearchBox` is reached only
  through `LocationPicker`, which `MapPane.tsx` loads with
  `dynamic(..., { ssr: false })`, so `photon.ts`, `coordinates.ts` and
  `recentSearches.ts` ride in the MapLibre chunk. All three are dependency-free.
- **Module-level timers.** `photon.ts:506-507` holds a debounce timer and an
  abort controller at module scope; `resetPhotonForTests` clears both. Same
  shape as the pre-existing `geocode.ts:199-201`. Fine for one consumer, see
  finding 14.
- **Leaked listeners.** One, in `delay()`, finding 15. The recents listener and
  the blur timer are both cleaned up (`SearchBox.tsx:105`, `:108-113`).
- **Design tokens.** Every class used resolves in `app/globals.css`:
  `plate`, `plate-raised`, `plate-sunken`, `bench`, `line`, `line-strong`,
  `control`, `ink`, `ink-muted`, `ink-faint`, `warn`, `focus`, `text-2xs`,
  `rounded-milled`, `rounded-plate`, `shadow-raised`, `shadow-lifted`. No raw
  hex, no arbitrary colour.
- **Em dashes.** None in the new source. The only U+2014 is inside the
  normalisation character class at `coordinates.ts:83`, where it is correct.
- **Console.** No `console.*` in `photon.ts`, `coordinates.ts`,
  `recentSearches.ts` or `SearchBox.tsx`.

## Two notes, both sanctioned by DECISIONS

- `[V3.1-P9-2]` sanctions the two-row answer for an ambiguous decimal pair, and
  it works as documented: `41.8827, -87.6233` yields the intended reading first
  and `-87.62330, 41.88270` second, `91, 10` yields the single longitude-first
  row `10, 91`, `45, 181` yields nothing, `0, 0` and `90, 180` yield one row
  each. Worth knowing that this means the commonest paste on earth grows a
  second row pointing at Antarctica. ArrowDown once plus Enter still picks the
  right one, so the risk is low.
- A short numeric free-text query is captured as coordinates and never reaches
  Photon: `12 34` measures as two coordinate rows. `SearchBox.tsx:134-141`
  returns before the Photon branch whenever `readings.length > 0`. Correct per
  `[V3.1-P9-1]`; a user searching for a numbered address gets no place results
  for that exact string.

## Verdict

The engineering underneath this is good and in several places better than the
brief asked for. The request policy is real, enforced in three layers, and
proven off the wire rather than with fake timers. The failure matrix is
complete with no path that hangs. The coordinate parser is a tokenizer rather
than a regular expression, and it earns that choice: every address-shaped
string in a 56-input probe was rejected, including the European decimal comma
that a looser parser would have mangled. The removal of `generate()` from the
pick path saves an Overpass query and a WASM pass on a keystroke, and it is
measured as a POST count rather than asserted in prose. The recents module's
fail-soft contract is genuinely tested rather than claimed.

What holds it back is that the feature does not visibly work for its main use.
Searching for a place outside the current viewport leaves the map exactly where
it was, with the pin, the circle and the crop square all off-screen; only the
radius chip and the place name move. That is finding 1, and it should be fixed
before this ships, even though it predates the rewrite, because the old
Nominatim box could only reach one place per submit and this one is a
type-ahead over the planet. Behind it sit three accessibility defects that a
green axe run does not rule out and in one case cannot see: the combobox role
and its expanded state are on a div nobody focuses, no live region ever
announces a result count, and `aria-activedescendant` is left dangling after a
blur. Then the smaller sharp edges: Enter does nothing on the coordinate
fallback the error message itself recommends, an IME sends uncommitted syllables
to a public endpoint and steals the commit key, and the place name a pick binds
is overwritten by Nominatim half a second later in a way no test can currently
see.

None of that is architectural. Findings 1 and 4 are a few lines each, 3 and 5
are small additions, 2 is moving four attributes down one element, and 6 is a
ref plus two guards. The parser findings, 9 through 11, are three narrow edits
to one file with a probe already written to check them. Fix 1 through 7 and
this is ready.

---

# Fixes

Applied by the implementer after the review. Every blocker and major, plus
every minor that fit inside twenty lines. Each row names the test that fails
against the pre-fix code and passes against the fixed code; no existing
assertion was weakened, and both suites the audit measured grew rather than
shrank.

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | Blocker: picking never moves the map | `LocationPicker.tsx:256-292` replaces the preset-only fly with "the pin is somewhere the camera is not framed on, and this map did not put it there". The map's own click and pin-drag handlers stamp `selfMovedRef` first (`:205`, `:211`), so a user clicking the map is never answered with a fly-back | `search.spec.ts` "the map camera follows a pick to another continent" (a Paris fixture 6600 km from the default pin; the pin marker must still lie inside the map's own box) and "clicking the map moves the pin without the camera flying back at the user" |
| 2 | Major: combobox split across two elements | `SearchBox.tsx:588-604`: `role="combobox"`, `aria-expanded`, `aria-haspopup`, `aria-controls` and `aria-activedescendant` all sit on the `input` now; `role="searchbox"`, the wrapper's role and `aria-owns` are gone and the wrapper is plain positioning | `search.spec.ts` "ArrowUp from nothing selected lands on the last row, and Escape clears the pointer" asserts `aria-expanded` on the input itself in both states; both axe sweeps still report 0 violations |
| 3 | Major: no live region for the result count | `SearchBox.tsx:565-580` adds one always-mounted `role="status" aria-live="polite"` region outside the popover, fed by `liveAnnouncement` (`:102-145`). Every `role="status"` was removed from the visible `StatusLine` paragraphs, so a message is announced once rather than twice | `search.spec.ts` "the live region announces the result count and the unavailable message" (3 results, then coordinate readings, then the outage sentence) |
| 4 | Major: `aria-activedescendant` left dangling after a blur close | `SearchBox.tsx:537-540` gates `activeId` on `listboxOpen` | `search.spec.ts` "ArrowUp ... Escape clears the pointer" plus a new sixth axe state, "blurred with a row highlighted", in both themes |
| 5 | Major: Enter does nothing with no row highlighted | `SearchBox.tsx:500-510` takes `options[0]` when nothing is highlighted | `search.spec.ts` "Enter with nothing highlighted takes the first row, which is the coordinate fallback", reached through the 429 message that recommends exactly that |
| 6 | Major: no IME composition guard | `SearchBox.tsx:222` skips the search effect while composing (a `composing` STATE, not a ref, so committing re-runs the effect); `:468` returns from `onKeyDown` on `event.nativeEvent.isComposing`; `:596-603` wires `onCompositionStart` and `onCompositionEnd` | `search.spec.ts` "a composing IME sends nothing and its commit key does not pick a row": seven uncommitted characters send zero requests, an `isComposing` Enter leaves the highlighted row unpicked, and a plain Enter still picks |
| 7 | Major: the Photon name is overwritten by Nominatim 600 ms later | `geocode.ts:230-260` adds `suppressNextReverseGeocode`, armed by `moveTo` (`SearchBox.tsx:320`) only when a pick actually binds a name, read and disarmed together by the next `scheduleReverseGeocode` so it can never outlive one pin move. `PhotonPlace` now carries `state`, `country` and `neighbourhood` (`photon.ts:303-308`), so `applyGeocodeResult` no longer blanks three fields | The two fixtures now name DIFFERENT places on purpose: `nominatim-reverse-chicago.json` resolves to "Cook County". `search.spec.ts` "the name a pick binds is not overwritten by the reverse lookup it triggers" picks Willis Tower, waits well past the debounce, asserts the field and that the request was never sent, then proves the suppression is one shot by picking a COORDINATE and watching the reverse lookup fire. Plus `geocode.test.ts` "suppressNextReverseGeocode" (3 cases) and 2 new `photon.test.ts` cases |
| 8 | Minor: ArrowUp from nothing skips the last row | `SearchBox.tsx:484` | `search.spec.ts` "ArrowUp from nothing selected lands on the last row" |
| 9 | Minor: a sign contradicting its hemisphere letter | `coordinates.ts:419-433` adds `contradicts`, and `placements` (`:465`) drops the reading | `coordinates.test.ts` rejection rows for `-41.8827 N, 87.6233 W` and `41.8827 N, -87.6233 E` |
| 10 | Minor: lowercase `s` for South rejected | The tokenizer stops guessing: a lowercase `s` becomes `{kind: "sec", south: true}` (`coordinates.ts:216-221`) and the component readers resolve it by POSITION through `asHemisphere` (`:73-79`). Directly after a seconds number it is the mark; anywhere a hemisphere letter could stand it is South | `coordinates.test.ts` accepts `33.8688s, 151.2093e`, `s 33.8688 e 151.2093`, `34.05s 18.42e` and a degrees-minutes form ending in a lowercase s, while the d/m/s spelling still reads its s as the seconds mark |
| 11 | Minor: newline, semicolon and brackets rejected | `coordinates.ts:122-142` skips newline, carriage return and both bracket pairs, and treats the semicolon as a separator | `coordinates.test.ts` accepts the newline, semicolon, parenthesised and bracketed pairs; the European decimal comma `41,8827 -87,6233` and `lat 41.88 lon -87.62` stay rejected, now asserted explicitly rather than left to a probe |
| 12 | Minor: recents not shared across tabs | `SearchBox.tsx:160-175` registers `storage` alongside the custom event, filtered on `RECENT_SEARCH_STORAGE_KEY`; the comment at `recentSearches.ts:34-40` now says why both are needed (the custom event fires only in the writing tab, `storage` only in the others) | The same-tab half is covered by the existing recents e2e test. The cross-tab half is a browser event with no per-tab harness in this suite, so the claim is documented against the mechanism rather than asserted |
| 13 | Minor: a coordinate pick overwrites a chosen radius | `moveTo` now takes a nullable radius; `pickCoordinates` (`SearchBox.tsx:367`) and the geolocation success path pass null. `[V3-P6]`'s table classifies a place, and a raw coordinate is not one | `search.spec.ts` "a coordinate pair is answered locally" sets 1500 m by hand first and asserts it survives the pick. It previously asserted the 900 m default, which the old code happened to write |
| 14 | Minor: stale-response guard relies on React's ordering | `SearchBox.tsx:233` records `latestQuery`, `:243` drops any outcome for a query the box no longer shows | Covered by the existing abort and debounce e2e tests. This is defence in depth for a case React's cleanup ordering currently prevents, so it has no failing-before test and none is claimed |
| 15 | Minor: `delay()` leaks its abort listener | `photon.ts:415-431` returns immediately when the signal is already aborted, and removes the listener on both paths | Covered by the existing 5xx retry tests, which still assert exactly two attempts and the 2 s spacing |
| 16 | Minor: Delete fires while the box holds whitespace | `SearchBox.tsx:524` gates on the raw `query === ""` rather than the trimmed one | Covered by the existing recents e2e test; the whitespace case is a one-line guard with no separate scenario |

## Not fixed, and why

**Finding 17, the pointer-only remove control.** The APG grid pattern the audit
recommends means `role="grid"`, `role="row"` and two gridcells per row, a real
button inside one of them, and the arrow-key handling a grid inside a combobox
implies. That is well past twenty lines and it changes the popup role the
combobox advertises, which touches every ARIA assertion in the suite. The
finding is correct and worth doing; it is a task of its own, not a fix-up.
Meanwhile the keyboard route (Delete or Backspace on the highlighted row) is
real and the popover footer states it.

**The 12 second worst case** noted under "Failure handling" (two 5 s timeouts
either side of the 2 s retry) is unchanged. Capping the whole attempt chain
rather than each attempt changes the failure contract the audit verified as
correct, so it is left for the team lead to call.

## Verification after the fixes

| Command | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `eslint` over every file this task owns | clean, 0 warnings |
| `npx vitest run lib/coordinates.test.ts lib/photon.test.ts lib/recentSearches.test.ts lib/geocode.test.ts` | 4 files, **160** tests, all pass, was 140 |
| `E2E_BUDGET_FACTOR=3 npx playwright test e2e/search.spec.ts` | **17** passed, was 9 passed and 1 failed |
| `E2E_BUDGET_FACTOR=3 npx playwright test e2e/workflow.spec.ts` | 4 passed |
| `E2E_BUDGET_FACTOR=3 npx playwright test e2e/a11y.spec.ts` | 4 passed, 0 violations in all 10 states |

The search box's own axe sweep now visits **seven** popover states per theme
rather than six, the new one being the blurred-with-active-row state of finding
4. All fourteen report 0 violations.

The audit's note that the arrow-down test timed out waiting for `preview-stats`
did not reproduce in any of these runs: that test now passes in about 7 s, so
it was the concurrent `lib/engine/**` rewrite as suspected. `eslint` across the
whole app still reports one warning, an unused `PipelineEvent` in
`lib/engine/client.ts`, which belongs to that same rewrite and is not touched
here.
