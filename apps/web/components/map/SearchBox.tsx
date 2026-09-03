"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  coordinateReadings,
  formatCoordinates,
  type ParsedCoordinates,
} from "@/lib/coordinates";
import {
  radiusForResultType,
  suppressNextReverseGeocode,
  type GeocodeResult,
} from "@/lib/geocode";
import {
  PHOTON_MIN_QUERY_CHARS,
  PLACE_KIND_LABEL,
  radiusForPlace,
  schedulePhotonSearch,
  type PhotonPlace,
} from "@/lib/photon";
import {
  RECENT_SEARCH_CHANGED_EVENT,
  RECENT_SEARCH_STORAGE_KEY,
  clearRecentSearches,
  forgetRecentSearch,
  listRecentSearches,
  recentSearchKey,
  rememberRecentSearch,
  type RecentSearch,
} from "@/lib/recentSearches";
import { useEditorStore } from "@/store/editor";

/**
 * The location type-ahead ([V3-P9]).
 *
 * One combobox over the map that answers four different kinds of question
 * without the user having to say which they are asking:
 *
 *  1. A place name or address -> Photon (`lib/photon.ts`), debounced, aborted
 *     on the next keystroke, never sent under three characters.
 *  2. Raw coordinates in either notation -> parsed LOCALLY
 *     (`lib/coordinates.ts`) and offered as a "Go to coordinates" row before
 *     any request is made at all. A coordinate query never reaches Photon.
 *  3. Nothing typed yet -> the last eight places picked here
 *     (`lib/recentSearches.ts`), each removable, plus "Use my location".
 *  4. Somewhere the browser knows -> `navigator.geolocation`, called ONLY when
 *     that row is chosen, because choosing it is the user's own consent to the
 *     permission prompt that follows.
 *
 * Picking anything moves the pin, sizes the radius by what kind of place it is
 * (`[V3-P6]`'s frozen table) and binds the place name through
 * `applyGeocodeResult`. It deliberately does NOT build: the scene is marked
 * stale, Preview lights up, and running it stays the user's own move. Search
 * costs one small request; a build costs an Overpass query and a WASM boolean
 * pass, and nobody asked for that by typing.
 *
 * Every warning the user needs is inline, inside this control: an outage, a
 * rate limit, a refused location permission. Nothing here writes to the
 * console or raises a dialog.
 */

/** How long the popover stays up after a blur, so a click on a row still lands. */
const BLUR_CLOSE_MS = 150;

/** `navigator.geolocation`'s own budget before we call it a timeout. */
const GEOLOCATION_TIMEOUT_MS = 10_000;

const UNAVAILABLE_MESSAGE = "Search is unavailable right now, enter coordinates instead.";
const COORDINATE_HINT = 'Try 41.8827, -87.6233 or 41°52′57.7″N 87°37′23.9″W.';

type SearchOption =
  | { kind: "coordinates"; id: string; reading: ParsedCoordinates }
  | { kind: "place"; id: string; place: PhotonPlace }
  | { kind: "recent"; id: string; entry: RecentSearch }
  | { kind: "geolocate"; id: string };

type Phase =
  | "idle"
  | "too-short"
  | "searching"
  | "results"
  | "unavailable"
  | "locating"
  | "picked";

/** A Photon result as the address shape `applyGeocodeResult` writes. */
function placeAddress(place: PhotonPlace): GeocodeResult {
  return {
    city: place.name,
    state: place.state,
    country: place.country,
    neighbourhood: place.neighbourhood,
  };
}

/**
 * What the live region says, or the empty string when there is nothing to
 * announce. One sentence, computed from the same state the visible popover
 * renders, so the two can never disagree about what just happened.
 */
function liveAnnouncement(input: {
  open: boolean;
  phase: Phase;
  notice: string | null;
  nothingFound: boolean;
  query: string;
  count: number;
  coordinates: boolean;
}): string {
  if (!input.open) return "";
  if (input.notice !== null) return input.notice;
  if (input.phase === "unavailable") return `${UNAVAILABLE_MESSAGE} ${COORDINATE_HINT}`;
  if (input.phase === "locating") return "Finding your location.";
  if (input.phase === "searching") return "Searching.";
  if (input.phase === "too-short") {
    return `Keep typing: ${PHOTON_MIN_QUERY_CHARS} characters or more.`;
  }
  if (input.nothingFound) return `No results for ${input.query}.`;
  if (input.count === 0) return "";
  if (input.coordinates) {
    return input.count === 1
      ? "1 coordinate reading. Press Enter to go there."
      : `${input.count} coordinate readings. Use the arrow keys to choose one.`;
  }
  if (input.query === "") {
    return input.count === 1
      ? "1 suggestion. Use the arrow keys to review it."
      : `${input.count} suggestions. Use the arrow keys to review them.`;
  }
  return input.count === 1
    ? "1 result. Use the arrow keys to review it."
    : `${input.count} results. Use the arrow keys to review them.`;
}

export function SearchBox() {
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [places, setPlaces] = useState<PhotonPlace[]>([]);
  const [recents, setRecents] = useState<RecentSearch[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  // State, not a ref: committing an IME candidate has to RE-RUN the search
  // effect, and a ref change does not.
  const [composing, setComposing] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The query the newest scheduled search belongs to; see the guard below. */
  const latestQuery = useRef("");
  // Set immediately before `pick()` writes a chosen name into `query`: without
  // it that write is indistinguishable from the user typing the full name, and
  // the effect below would search for the very place just picked.
  const skipNextSearch = useRef(false);

  // Recents live in localStorage, so they survive a reload and are shared with
  // any other tab; the event keeps this copy honest without polling.
  useEffect(() => {
    setRecents(listRecentSearches());
    const refresh = (): void => setRecents(listRecentSearches());
    // Two events, because neither covers both cases: the custom one fires only
    // in the tab that wrote, and the browser's `storage` event fires only in
    // the OTHER tabs. Together they are exactly once per tab.
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null || event.key === RECENT_SEARCH_STORAGE_KEY) refresh();
    };
    window.addEventListener(RECENT_SEARCH_CHANGED_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(RECENT_SEARCH_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(
    () => () => {
      if (blurTimer.current !== null) clearTimeout(blurTimer.current);
    },
    [],
  );

  const trimmed = query.trim();

  // Coordinates are decided from the raw text on every render: the parse is
  // pure string work, and knowing the answer BEFORE the effect runs is what
  // keeps a coordinate query off the network entirely.
  const readings = useMemo(() => coordinateReadings(query), [query]);

  useEffect(() => {
    if (skipNextSearch.current) {
      skipNextSearch.current = false;
      return undefined;
    }
    setNotice(null);

    // An IME rewrites the field on every keystroke while a candidate is being
    // composed, and React's `onChange` IS the DOM `input` event, so it fires
    // for each of those. Searching them would send uncommitted romaji or
    // pinyin to a public endpoint and flash wrong answers under the
    // composition window. Nothing is searched until the candidate is
    // committed, at which point `composing` flips and this effect re-runs.
    if (composing) return undefined;

    if (trimmed === "") {
      setPlaces([]);
      setPhase("idle");
      return undefined;
    }
    if (readings.length > 0) {
      // A coordinate pair answers itself. No request, no debounce, no cache.
      setPlaces([]);
      setPhase("results");
      setOpen(true);
      setActiveIndex(-1);
      return undefined;
    }
    if (trimmed.length < PHOTON_MIN_QUERY_CHARS) {
      setPlaces([]);
      setPhase("too-short");
      setOpen(true);
      setActiveIndex(-1);
      return undefined;
    }

    setPhase("searching");
    setOpen(true);
    // The pin is read imperatively rather than subscribed to: it biases the
    // request that this keystroke starts, and a pin that moves later must not
    // re-run a search the user did not ask for again.
    const pin = useEditorStore.getState().location;
    latestQuery.current = query;
    return schedulePhotonSearch(
      query,
      (outcome, forQuery) => {
        // A result for a query the box no longer shows. `lib/photon.ts` aborts
        // the superseded request, but an abort that lands a tick after
        // `response.json()` already resolved still answers "ok" with the old
        // list, and its `cancelled` flag belongs to the previous call. Today
        // React's cleanup-before-next-effect ordering hides that; this guard
        // makes it a property of this component rather than of the scheduler.
        if (forQuery !== latestQuery.current) return;
        if (outcome.status === "ok") {
          setPlaces(outcome.places);
          setPhase("results");
        } else {
          // A rate limit and an outage read the same to someone typing: the
          // box cannot answer, and coordinates are the way through either way.
          setPlaces([]);
          setPhase("unavailable");
        }
        setOpen(true);
        setActiveIndex(-1);
      },
      { bias: { lat: pin.lat, lon: pin.lon } },
    );
  }, [query, trimmed, readings, composing]);

  const options = useMemo<SearchOption[]>(() => {
    if (trimmed === "") {
      return [
        { kind: "geolocate", id: "search-option-geolocate" },
        ...recents.map((entry) => ({
          kind: "recent" as const,
          id: `search-option-recent-${recentSearchKey(entry)}`,
          entry,
        })),
      ];
    }
    if (readings.length > 0) {
      return readings.map((reading, index) => ({
        kind: "coordinates" as const,
        id: `search-option-coordinates-${index}`,
        reading,
      }));
    }
    return places.map((place) => ({
      kind: "place" as const,
      id: `search-option-place-${place.id}`,
      place,
    }));
  }, [trimmed, readings, recents, places]);

  const listboxOpen = open && options.length > 0;

  useEffect(() => {
    if (activeIndex < 0) return;
    const item = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  /**
   * The one place the store is written. `setPin` clears the preset and marks
   * the scene stale, `setRadius` applies `[V3-P6]`'s table when the pick
   * carries a kind, and `applyGeocodeResult` binds the address through the
   * SAME path a reverse lookup takes (source "geocode"), so a user's own
   * typed name still wins.
   *
   * `generate()` is deliberately not called: the Preview button lights up and
   * the build stays the user's decision. (`setPin`/`setRadius` do schedule a
   * terrain job and an engine job, as a map click already did; what a pick
   * never costs is an Overpass query.)
   *
   * `place` carries Photon's own state/country/district rather than nulls: an
   * `applyGeocodeResult` with three nulls BLANKS `params.place` until a
   * reverse geocode refills it, so an offline Nominatim would leave three
   * fields empty that held real values a moment earlier.
   *
   * When an address is bound, the reverse lookup the pin move is about to
   * trigger is suppressed for these exact coordinates
   * (`suppressNextReverseGeocode`). Photon has already told us the name of the
   * thing the user chose; letting a coarser reverse answer overwrite "Willis
   * Tower" with "Chicago" half a second later, with no user action, is a bug,
   * not reconciliation.
   */
  const moveTo = useCallback(
    (lat: number, lon: number, radiusM: number | null, place: GeocodeResult | null) => {
      const store = useEditorStore.getState();
      if (place !== null) suppressNextReverseGeocode(lat, lon);
      store.setPin(lat, lon);
      if (radiusM !== null) store.setRadius(radiusM);
      if (place !== null) store.applyGeocodeResult(lat, lon, place);
    },
    [],
  );

  const closeAfterPick = useCallback((label: string) => {
    skipNextSearch.current = true;
    setQuery(label);
    setPlaces([]);
    setPhase("picked");
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.blur();
  }, []);

  const pickPlace = useCallback(
    (place: PhotonPlace) => {
      moveTo(place.lat, place.lon, radiusForPlace(place), placeAddress(place));
      setRecents(
        rememberRecentSearch({
          name: place.name,
          context: place.context,
          lat: place.lat,
          lon: place.lon,
          kind: place.kind,
          state: place.state,
          country: place.country,
          neighbourhood: place.neighbourhood,
        }),
      );
      closeAfterPick(place.name);
    },
    [moveTo, closeAfterPick],
  );

  const pickCoordinates = useCallback(
    (reading: ParsedCoordinates) => {
      const label = formatCoordinates(reading.lat, reading.lon);
      // No name is bound: `setPin` leaves the place resolving and the shell's
      // own reverse geocode names it, which is a better answer than the digits
      // the user typed. The RADIUS is left alone for the same reason:
      // `[V3-P6]`'s table classifies a PLACE, and a raw coordinate is not a
      // place, so there is nothing to classify and no licence to overwrite a
      // radius the user set by hand.
      moveTo(reading.lat, reading.lon, null, null);
      setRecents(
        rememberRecentSearch({
          name: label,
          context: "Coordinates",
          lat: reading.lat,
          lon: reading.lon,
          kind: "place",
        }),
      );
      closeAfterPick(label);
    },
    [moveTo, closeAfterPick],
  );

  const pickRecent = useCallback(
    (entry: RecentSearch) => {
      moveTo(
        entry.lat,
        entry.lon,
        radiusForResultType({ type: entry.kind, addresstype: null }),
        {
          city: entry.name,
          state: entry.state ?? null,
          country: entry.country ?? null,
          neighbourhood: entry.neighbourhood ?? null,
        },
      );
      setRecents(rememberRecentSearch({ ...entry }));
      closeAfterPick(entry.name);
    },
    [moveTo, closeAfterPick],
  );

  /**
   * Asked for only when this row is chosen. An explicit choice IS the consent
   * for the permission prompt the browser puts up next, which is why nothing
   * here runs on mount or on focus.
   */
  const locateMe = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.geolocation === undefined) {
      setNotice("This browser cannot share a location. Enter coordinates instead.");
      setPhase("idle");
      setOpen(true);
      return;
    }
    setPhase("locating");
    setNotice(null);
    setOpen(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        const label = formatCoordinates(latitude, longitude);
        // Same reasoning as a coordinate pick: a device position names no
        // kind of place, so the radius the user chose is left alone.
        moveTo(latitude, longitude, null, null);
        setRecents(
          rememberRecentSearch({
            name: label,
            context: "My location",
            lat: latitude,
            lon: longitude,
            kind: "place",
          }),
        );
        closeAfterPick(label);
      },
      (error) => {
        setPhase("idle");
        setOpen(true);
        if (error.code === error.PERMISSION_DENIED) {
          setNotice("Location permission was refused. Enter coordinates instead.");
        } else if (error.code === error.TIMEOUT) {
          setNotice("Finding your location took too long. Enter coordinates instead.");
        } else {
          setNotice("This device could not find a location. Enter coordinates instead.");
        }
      },
      { timeout: GEOLOCATION_TIMEOUT_MS, maximumAge: 60_000 },
    );
  }, [moveTo, closeAfterPick]);

  const choose = useCallback(
    (option: SearchOption) => {
      if (option.kind === "place") pickPlace(option.place);
      else if (option.kind === "coordinates") pickCoordinates(option.reading);
      else if (option.kind === "recent") pickRecent(option.entry);
      else locateMe();
    },
    [pickPlace, pickCoordinates, pickRecent, locateMe],
  );

  const removeRecent = useCallback((entry: RecentSearch) => {
    setRecents(forgetRecentSearch(recentSearchKey(entry)));
    setActiveIndex(-1);
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    // Enter is how an IME COMMITS a candidate, and the arrows move through the
    // candidate list. Acting on either mid-composition would pick a search
    // result instead of finishing the word the user is still typing.
    if (event.nativeEvent.isComposing || composing) return;

    const count = options.length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (count === 0) return;
      if (!open) setOpen(true);
      setActiveIndex((current) => (current + 1 + count) % count);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (count === 0) return;
      if (!open) setOpen(true);
      // From "nothing selected" (-1) ArrowUp must land on the LAST row, which
      // a plain `(current - 1 + count) % count` misses: -1 wraps to count - 2.
      setActiveIndex((current) => (current <= 0 ? count : current) - 1);
      return;
    }
    if (event.key === "Home") {
      if (!listboxOpen) return;
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      if (!listboxOpen) return;
      event.preventDefault();
      setActiveIndex(count - 1);
      return;
    }
    if (event.key === "Enter") {
      if (!listboxOpen || count === 0) return;
      // With nothing highlighted, Enter takes the FIRST row. The unavailable
      // message tells people to "enter coordinates instead"; someone who does
      // exactly that and presses Enter must not get silence and have to
      // discover ArrowDown for themselves. The first row is the best
      // coordinate reading, or the top-ranked place.
      const index = activeIndex >= 0 && activeIndex < count ? activeIndex : 0;
      event.preventDefault();
      choose(options[index]);
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
        setActiveIndex(-1);
      }
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      // Gated on the RAW query being empty, not on the trimmed one: the
      // recents branch keys on `trimmed === ""`, so a box holding only spaces
      // still lists them, and stealing Backspace there would stop the user
      // deleting those spaces.
      if (query !== "") return;
      const option = activeIndex >= 0 ? options[activeIndex] : undefined;
      if (option !== undefined && option.kind === "recent") {
        event.preventDefault();
        removeRecent(option.entry);
      }
    }
  };

  // Gated on `listboxOpen`, not on `activeIndex` alone: the deferred blur close
  // leaves `activeIndex` where it was, so without this the input goes on naming
  // an option id that unmounted with the listbox, which is exactly the
  // `aria-valid-attr-value` failure `aria-controls` is guarded against below.
  const activeId =
    listboxOpen && activeIndex >= 0 && activeIndex < options.length
      ? options[activeIndex].id
      : undefined;
  const nothingFound =
    phase === "results" && trimmed !== "" && readings.length === 0 && places.length === 0;
  const statusVisible =
    notice !== null ||
    nothingFound ||
    phase === "searching" ||
    phase === "unavailable" ||
    phase === "too-short" ||
    phase === "locating";
  const popoverOpen = open && (listboxOpen || statusVisible);
  const announcement = liveAnnouncement({
    open: popoverOpen,
    phase,
    notice,
    nothingFound,
    query: trimmed,
    count: options.length,
    coordinates: readings.length > 0,
  });

  return (
    <div className="pointer-events-auto absolute right-2 top-2 z-10 w-80 max-w-[78%]">
      {/*
        The live region is mounted for the life of the control and only its
        TEXT changes. A region inserted at the same instant as its content is
        the classic unreliable pattern: assistive technology has nothing to
        observe a change on. The visible `StatusLine` paragraphs below are
        plain text with no live role for the same reason, so a message is
        announced exactly once rather than twice.
      */}
      <p
        data-testid="search-live"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </p>
      {/*
        A combobox, not a text input with a menu bolted on. Every combobox
        attribute lives on the INPUT itself (ARIA 1.2), not on a wrapper: the
        wrapper is not focusable, so `aria-expanded` on it is a state a screen
        reader user standing on the input is never told about, and
        `aria-activedescendant` pointing into a listbox owned by an ancestor is
        implementation-defined at best. The wrapper below is plain positioning.
      */}
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Search for a place, an address or coordinates"
          aria-expanded={listboxOpen}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          // An ARIA reference must name an id that EXISTS: the listbox is
          // rendered only while there is something in it, so pointing at it
          // otherwise is `aria-valid-attr-value` (serious, axe). Same
          // discipline as `IssuesBadge` and `HistoryChip` ([V3-P6]).
          aria-controls={listboxOpen ? "search-results-list" : undefined}
          aria-activedescendant={activeId}
          // Same trap: the attribution paragraph lives inside the popover, so
          // naming it while the popover is shut points at an id nothing
          // answers to.
          aria-describedby={popoverOpen ? "search-attribution" : undefined}
          data-testid="location-search"
          placeholder="Search a place, address or coordinates"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={(event) => {
            setComposing(false);
            // The committed text is on the element already; React's change
            // event for it may or may not have fired first depending on the
            // browser, so read it here rather than assuming.
            setQuery(event.currentTarget.value);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => {
            // Cancel a close still pending from an earlier blur. Without this,
            // focusing again inside the deferral window (picking a result,
            // then clearing the box, all inside 150 ms) lets the old timer
            // fire against the NEW focus and shut the popover the user just
            // reopened. Found by `e2e/search.spec.ts`'s recents test, which
            // failed intermittently on exactly that interleaving.
            if (blurTimer.current !== null) {
              clearTimeout(blurTimer.current);
              blurTimer.current = null;
            }
            setOpen(true);
          }}
          onBlur={() => {
            // Deferred: a pointer press on a row fires blur before the row's
            // own handler, and closing synchronously would drop the pick.
            if (blurTimer.current !== null) clearTimeout(blurTimer.current);
            blurTimer.current = setTimeout(() => setOpen(false), BLUR_CLOSE_MS);
          }}
          className="w-full rounded-milled border border-control bg-plate/95 py-1.5 pl-2.5 pr-7 text-2xs text-ink shadow-raised placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-focus"
        />
        {query !== "" ? (
          <button
            type="button"
            data-testid="search-clear"
            aria-label="Clear the search"
            onMouseDown={(event) => {
              event.preventDefault();
              setQuery("");
              setPlaces([]);
              setPhase("idle");
              setNotice(null);
              setActiveIndex(-1);
              inputRef.current?.focus();
            }}
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded-milled px-1.5 py-0.5 text-2xs text-ink-faint transition-colors hover:text-ink"
          >
            &times;
          </button>
        ) : null}
      </div>

      {popoverOpen ? (
        <div
          data-testid="search-popover"
          className="mt-1 overflow-hidden rounded-plate border border-line bg-plate shadow-lifted"
        >
          {listboxOpen ? (
            <ul
              ref={listRef}
              id="search-results-list"
              role="listbox"
              aria-label="Search results"
              data-testid="search-results"
              className="max-h-72 overflow-y-auto"
            >
              {options.map((option, index) => (
                <li
                  key={option.id}
                  id={option.id}
                  role="option"
                  aria-selected={index === activeIndex}
                  data-testid="search-result"
                  data-kind={option.kind}
                  // onMouseDown, not onClick: it fires before the input's blur
                  // timer and before focus moves away from the box.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(option);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`flex cursor-pointer items-start gap-2 px-2.5 py-1.5 text-2xs leading-snug ${
                    index === activeIndex ? "bg-plate-raised text-ink" : "text-ink-muted"
                  }`}
                >
                  <OptionBody option={option} onRemove={removeRecent} />
                </li>
              ))}
            </ul>
          ) : null}

          <StatusLine
            phase={phase}
            notice={notice}
            query={trimmed}
            nothingFound={nothingFound}
          />

          {trimmed === "" && recents.length > 0 ? (
            <div className="flex items-center justify-between border-t border-line px-2.5 py-1">
              <span className="text-2xs text-ink-faint">
                Recent places. Delete removes the highlighted one.
              </span>
              <button
                type="button"
                data-testid="search-clear-recents"
                onMouseDown={(event) => {
                  event.preventDefault();
                  setRecents(clearRecentSearches());
                  setActiveIndex(-1);
                }}
                className="rounded-milled border border-control bg-plate-raised px-1.5 py-0.5 text-2xs text-ink transition-colors hover:border-ink-faint"
              >
                Clear all
              </button>
            </div>
          ) : null}

          <p
            id="search-attribution"
            data-testid="search-attribution"
            className="border-t border-line px-2.5 py-1 text-2xs text-ink-faint"
          >
            Search by Photon (komoot), geocoding by Nominatim, map data &copy; OpenStreetMap
            contributors
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** The two-line body of one row: a primary name, a kind badge, a context line. */
function OptionBody({
  option,
  onRemove,
}: {
  option: SearchOption;
  onRemove: (entry: RecentSearch) => void;
}) {
  if (option.kind === "geolocate") {
    return (
      <span className="min-w-0 flex-1" data-testid="search-geolocate">
        <span className="block truncate font-medium text-ink">Use my location</span>
        <span className="block truncate text-ink-faint">
          Asks this browser for permission when chosen
        </span>
      </span>
    );
  }

  if (option.kind === "coordinates") {
    const { reading } = option;
    return (
      <>
        <span className="min-w-0 flex-1" data-testid="search-coordinate">
          <span className="block truncate font-medium text-ink">Go to coordinates</span>
          <span className="block truncate text-ink-faint">
            {formatCoordinates(reading.lat, reading.lon)}
            {reading.swapped ? " (read longitude first)" : ""}
          </span>
        </span>
        <KindBadge label={reading.format === "dms" ? "DMS" : "Decimal"} />
      </>
    );
  }

  if (option.kind === "recent") {
    const { entry } = option;
    return (
      <>
        <span className="min-w-0 flex-1" data-testid="search-recent">
          <span className="block truncate font-medium text-ink">{entry.name}</span>
          {entry.context !== "" ? (
            <span className="block truncate text-ink-faint">{entry.context}</span>
          ) : null}
        </span>
        {/*
          A presentational span, not a button: an interactive control nested
          inside a `role="option"` is axe's `nested-interactive` (serious). The
          keyboard route to the same action is Delete on the highlighted row,
          which the footer above spells out.
        */}
        <span
          role="presentation"
          data-testid="search-recent-remove"
          title={`Remove ${entry.name} from recent places`}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRemove(entry);
          }}
          className="shrink-0 rounded-milled px-1 text-ink-faint transition-colors hover:text-ink"
        >
          &times;
        </span>
      </>
    );
  }

  const { place } = option;
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-ink">{place.name}</span>
        {place.context !== "" ? (
          <span className="block truncate text-ink-faint">{place.context}</span>
        ) : null}
      </span>
      <KindBadge label={PLACE_KIND_LABEL[place.kind]} />
    </>
  );
}

function KindBadge({ label }: { label: string }) {
  return (
    <span
      data-testid="search-result-kind"
      className="shrink-0 rounded-milled border border-line bg-plate-sunken px-1 py-px text-2xs uppercase tracking-[0.08em] text-ink-faint"
    >
      {label}
    </span>
  );
}

/**
 * The one place this control speaks to the user in prose. Every failure lands
 * here rather than in the console or a dialog, per the project's warning rule.
 */
function StatusLine({
  phase,
  notice,
  query,
  nothingFound,
}: {
  phase: Phase;
  notice: string | null;
  query: string;
  nothingFound: boolean;
}) {
  if (notice !== null) {
    return (
      <p
        data-testid="search-status"
        className="border-t border-line px-2.5 py-1.5 text-2xs leading-snug text-warn"
      >
        {notice} {COORDINATE_HINT}
      </p>
    );
  }
  if (phase === "unavailable") {
    return (
      <p
        data-testid="search-unavailable"
        className="px-2.5 py-1.5 text-2xs leading-snug text-warn"
      >
        {UNAVAILABLE_MESSAGE} {COORDINATE_HINT}
      </p>
    );
  }
  if (phase === "locating") {
    return (
      <p data-testid="search-status" className="px-2.5 py-1.5 text-2xs text-ink-faint">
        Finding your location...
      </p>
    );
  }
  if (phase === "searching") {
    return (
      <p data-testid="search-status" className="px-2.5 py-1.5 text-2xs text-ink-faint">
        Searching...
      </p>
    );
  }
  if (phase === "too-short") {
    return (
      <p data-testid="search-status" className="px-2.5 py-1.5 text-2xs text-ink-faint">
        Keep typing: {PHOTON_MIN_QUERY_CHARS} characters or more. {COORDINATE_HINT}
      </p>
    );
  }
  if (nothingFound) {
    return (
      <p data-testid="search-empty" className="px-2.5 py-1.5 text-2xs text-ink-faint">
        Nothing found for &quot;{query}&quot;. {COORDINATE_HINT}
      </p>
    );
  }
  return null;
}

export default SearchBox;
