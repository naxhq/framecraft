# v3 Task 9: location search

The map's search affordance is now a Photon-backed type-ahead that also accepts
raw coordinates, remembers where you have been, and can ask the browser where
you are. Nominatim keeps exactly one job: the reverse lookup that names a pin
after it lands.

## What changed

| File | Change |
|---|---|
| `apps/web/lib/photon.ts` | **New.** Photon client: URL builder, GeoJSON reader, kind classifier, LRU cache, 429/5xx policy, debounce-and-abort scheduler |
| `apps/web/lib/coordinates.ts` | **New.** Local coordinate parser (decimal + DMS), tokenizer based, never fetches |
| `apps/web/lib/recentSearches.ts` | **New.** Last 8 picked places in localStorage, de-duplicated, removable, clearable |
| `apps/web/lib/geocode.ts` | Forward (Nominatim `/search`) path **removed**: `NOMINATIM_SEARCH_URL`, `extractSearchResults`, `fetchForwardGeocode`, `resolveForwardGeocode`, `scheduleForwardGeocode`, the 7-day search cache and `placeNameFromLabel`. Reverse geocoding, the 1 rps queue and `radiusForResultType` stay; the radius helper's parameter type is now a standalone `PlaceTypeHint` so `lib/photon.ts` can feed it |
| `apps/web/components/map/SearchBox.tsx` | Rewritten. Four row kinds in one listbox, two-line rows with a type badge, inline status, attribution footer, clear button |
| `apps/web/app/layout.tsx` | Footer line is now "Search by Photon (komoot), geocoding by Nominatim, map data © OpenStreetMap contributors" |
| `apps/web/e2e/photonMock.ts` | **New.** Route helpers and request/abort watchers for both geocoders |
| `apps/web/e2e/search.spec.ts` | **New**, 10 tests |
| `apps/web/e2e/workflow.spec.ts` | Search test now drives Photon, asserts a pick does **not** build, then clicks Preview |

`store/editor.ts` was **not** touched: `setPin` + `setRadius` +
`applyGeocodeResult` already express everything a pick needs, and all three
already mark the scene stale. No new setter was required.

## The parser table

`lib/coordinates.ts` tokenizes the whole string first (numbers, unit marks,
hemisphere letters, commas) and rejects at the first character that is not one
of those, which is what makes text-containing-digits a rejection rather than a
half-parsed guess. Two strategies then run over the tokens, decimal first, and
each must yield exactly two components consuming every token.

`lib/coordinates.test.ts` pins 25 accepted inputs and 22 rejections (47 rows,
above the brief's floor of 25, asserted by a test rather than left to a
reader's count). Highlights:

| Accepted | Reads as |
|---|---|
| `41.8827, -87.6233` / `41.8827 -87.6233` / `41.8827,-87.6233` | 41.8827, -87.6233 |
| `41.8827N, 87.6233W` / `N 41.8827 W 87.6233` / `87.6233W, 41.8827N` | 41.8827, -87.6233 |
| `-33.8688 S, 151.2093 E` | -33.8688, 151.2093 (letter and minus agree, not a double negative) |
| `-117.1611, 32.7157` | 32.7157, -117.1611 (longitude first: -117 cannot be a latitude) |
| `41°52'57.7"N 87°37'23.9"W` / `41 52 57.7 N 87 37 23.9 W` / `41d52m57.7sN 87d37m23.9sW` | 41.88269, -87.62331 |
| `48°51′24″N 2°21′08″E` | true prime and double prime normalised |
| `41 52` | 41, 52 (decimal, not degrees-and-minutes) |
| `0, 0` / `90, 180` / `-90, -180` | limits inclusive |

| Rejected | Why |
|---|---|
| `41.8827` / `-87.6233` | one number is half a pair |
| `Route 66` / `221B Baker Street` / `1600 Pennsylvania Ave NW` / `Sector 7` | text that merely contains digits |
| `91, 181` / `41.8827, 200` / `-95, -200` | out of range in both readings |
| `41.8827, -87.6233, 5` / `1,2,3` | a third component |
| `41°52'57.7"N` / `41 52 57.7 N` | one DMS component, no partner |
| `41°99'N 87°37'W` | 99 is not a minute value |
| `41N 52N` / `12E 15W` | two of the same axis |
| `41.8.8, -87.6` / `12:30` / `, 41.88, -87.62` | malformed |

**One deviation from the brief, deliberate.** The brief's `-87.6233, 41.8827`
example is written as a longitude-first pair, but -87.6233 is a perfectly legal
latitude, so no rule can tell the two readings apart from the text alone.
Silently swapping would move the pin to the wrong hemisphere for anyone who
meant it literally. `coordinateReadings()` therefore returns **both** readings
when both are in range and offers them as two rows, latitude first, the way
openstreetmap.org's own search does; when only one order is in range (the
brief's stated rule, `|first| > 90`) exactly one row appears and it carries
`swapped: true`. `parseCoordinates()` returns the best reading for callers that
want one.

## Request policy

Photon (`https://photon.komoot.io/api/?q=…&limit=8&lang=en`, plus `lat`/`lon`
biased on the current pin, rounded to a tenth of a degree):

- Nothing under **3 characters**, in the scheduler and again in
  `fetchPhotonSearch`, and again in the component.
- **250 ms** debounce; the previous in-flight request is `AbortController`
  aborted on every new keystroke, so a fast typist costs one answered request.
- **LRU cache, 50 queries, 10 minutes**, in memory (a 10 minute time to live is
  shorter than a session, so persisting it would only serve what this tab
  already has). Keyed on the normalised query **plus** the rounded bias, so the
  same word near a different pin re-searches rather than returning another
  city's answers. A cache hit answers synchronously, before the debounce.
- A coordinate query never reaches Photon at all.
- No forged `User-Agent`. Browsers refuse to let `fetch` set it (already
  documented in `lib/geocode.ts`), and faking identity through another header
  would be dishonest rather than polite. The page's own `Referer` is what a
  browser client can offer.
- Photon does **not** share Nominatim's 1 rps queue: different server,
  different policy, and queueing a keystroke behind a reverse lookup would make
  the box feel broken. Nominatim's queue and 600 ms debounce are untouched.

## Failure handling

All of it inline, inside the control. No console output, no dialogs.

| Condition | Behaviour |
|---|---|
| **429** | No retry for at least 30 s; `Retry-After` respected when it asks for *longer* (`max(30 s, Retry-After)`), so a server asking to be hit again in 1 s still gets 30. Requests inside the cooldown are refused locally without touching the network |
| **5xx** | Retried exactly once after 2 s, then given up as unavailable. Never a third attempt |
| **Network error / 4xx / bad JSON** | Unavailable |
| **5 s timeout** | Unavailable, never a hang |
| **Superseded** | Reported as `aborted` internally and never shown: a cancelled request has no news |
| Any of the above, in the UI | "Search is unavailable right now, enter coordinates instead." plus the coordinate hint, at `search-unavailable` |
| **Nothing found** | A different message at `search-empty`, so an empty answer never reads as an outage |
| **Geolocation** denied / timed out / unavailable | Its own inline sentence plus the same coordinate hint. `navigator.geolocation` is called only when the row is chosen |

## Behaviour of a pick

`setPin` → `setRadius` (through `[V3-P6]`'s frozen table, fed by Photon's
`osm_key`/`osm_value`/`type` normalised into one `PlaceKind`) →
`applyGeocodeResult` with source "geocode". **No `generate()`**: the scene is
marked stale, Preview lights up, and building stays the user's move. The
previous implementation called `generate()` on every pick, which spent an
Overpass query and a WASM boolean pass on a keystroke.

## Fixtures

- `apps/web/e2e/fixtures/photon-chicago.json` - a FeatureCollection of three
  features (a city, a road, a named building with a house number), so the kind
  badges, the context line and the name fallback are all exercised.
- `apps/web/e2e/fixtures/nominatim-reverse-chicago.json` - the reverse answer.
- Both routed through `apps/web/e2e/photonMock.ts`. Neither geocoder is ever
  reached from a test run.

## Tests

| Suite | Count |
|---|---|
| `lib/coordinates.test.ts` | 56 |
| `lib/photon.test.ts` | 39 |
| `lib/recentSearches.test.ts` | 15 |
| `lib/geocode.test.ts` | 30 (was 44; the 14 forward-path tests moved to `photon.test.ts`, which covers the same ground plus the minimum length, the abort, the LRU bound and the 429/5xx policy) |
| `e2e/search.spec.ts` | 10 |
| `e2e/workflow.spec.ts` | 4 (unchanged count; the search test now also asserts no Overpass call before Preview) |

`e2e/search.spec.ts` proves, off the wire rather than from fake timers: two
characters send nothing; the third sends exactly one request after the debounce
carrying `limit=8` and the pin bias; a fourth keystroke leaves the third
request in the browser's own failed list with `net::ERR_ABORTED` while the new
query goes out; arrow-down plus Enter moves the pin to 1500 m, fills the place
name, re-enables Preview and adds **zero** Overpass POSTs (`watchOverpass`); a
DMS string is answered locally with no request to either geocoder; a mocked 429
shows the fallback; an empty answer does not; a picked place returns as a
recent, is removable and the list can be cleared.

It also carries two axe sweeps of its own (light and dark, six popover states
each: closed, empty-and-focused, hint, results with an active row, coordinates,
recents). **Zero violations in all twelve.** That is deliberately narrower and
deeper than `e2e/a11y.spec.ts`'s whole-editor sweep, because the combobox
pattern's failure modes (an `aria-controls` naming a listbox that is not in the
DOM, an interactive control nested inside a `role="option"`) are exactly what a
reader of the JSX misses. The remove affordance on a recent row is therefore a
presentational span with a pointer handler, not a button, and the keyboard
route to the same action is Delete or Backspace on the highlighted row.

## Verification

`npm run lint`, `npm run typecheck` and the four suites above: green, zero
skipped. Playwright at `E2E_BUDGET_FACTOR=3`: `search.spec.ts` 10/10,
`workflow.spec.ts` 4/4, `a11y.spec.ts` 4/4 with 0 axe violations in every
state.

Two caveats, neither in this task's ownership:

1. `lib/engine/export/tiles.test.ts` and `lib/engine/terrain/tiles.test.ts` each
   fail one test in the full vitest run. Both are inside another agent's live
   `lib/engine/**` refactor (a new `lib/engine/pipeline/` tree plus export
   changes), and neither spec imports anything this task owns.
2. The first `a11y.spec.ts` attempts failed at the `adjustments-chip` step with
   the whole editor reset to its cold state mid-test, and one `next build`
   failed on a half-written `paletteEntries` in `lib/engine/export/bambu3mf.ts`.
   Both were the shared dev server recompiling under concurrent edits from that
   same refactor. Once the tree compiled again, all four a11y tests passed
   unchanged.

## One bug found and fixed by these tests

The deferred blur close (150 ms, so a pointer press on a row lands before the
popover shuts) was not cancelled when focus returned inside that window.
Picking a result and then clearing the box quickly enough let the old timer
fire against the *new* focus and close a popover the user had just reopened.
`onFocus` now clears the pending timer. Found by the recents e2e test failing
intermittently on exactly that interleaving, not by reading the code.

## Follow-ups for the team lead

- `ARCHITECTURE.md` section 6 still describes the workflow as "Nominatim
  forward and reverse geocoding (`lib/geocode.ts` …) with
  `components/map/SearchBox.tsx`". That sentence needs a line about Photon.
- `docs/handoff/v3-02-inventory.md` section 5's "Search" table now describes
  the previous implementation throughout.
- `DECISIONS.md` needs `[V3-P9]` lines for: Photon replacing Nominatim's
  forward path and why they do not share a rate-limit queue; the two-reading
  answer for an ambiguous coordinate pair; and a pick no longer calling
  `generate()`. I did not append them, per the "do not commit" rule and to keep
  an append-only file free of merge conflicts with the other agents in this
  wave.
