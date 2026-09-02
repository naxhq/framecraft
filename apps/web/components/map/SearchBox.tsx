"use client";

import { useEffect, useRef, useState } from "react";

import {
  placeNameFromLabel,
  radiusForResultType,
  scheduleForwardGeocode,
  type SearchResult,
} from "@/lib/geocode";
import { useEditorStore } from "@/store/editor";

/**
 * Address and place search: a text box over the map with a keyboard-navigable
 * autocomplete dropdown ([V3-P6]).
 *
 * Picking a result moves the pin, sets a radius by what kind of place it is
 * (`radiusForResultType`), binds the place name (preset cleared, source
 * "geocode" -- the same place-resolution path a reverse lookup already uses,
 * so "user edits always win" still holds afterwards), and generates. Query
 * text, the dropdown and its own request status are local component state:
 * none of it is a PrintParams field or `LocationState`, so it carries no
 * undo-history weight (`store/history.ts` only ever sees the resulting
 * `setPin`/`setRadius` write) and nothing here needs a project-file or
 * share-link slot.
 */
export function SearchBox() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"idle" | "searching" | "done" | "failed">("idle");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const requestQuery = useRef("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  // Set right before `pick()` writes the result's own label into `query`:
  // without this, that write is indistinguishable from the user having typed
  // the full label themselves, and the effect below would search for it --
  // reopening the dropdown moments after a pick, against the label of the
  // very place just picked.
  const skipNextSearch = useRef(false);

  useEffect(() => {
    if (skipNextSearch.current) {
      skipNextSearch.current = false;
      return undefined;
    }
    if (query.trim() === "") {
      setResults([]);
      setStatus("idle");
      setOpen(false);
      return undefined;
    }
    requestQuery.current = query;
    setStatus("searching");
    const cancel = scheduleForwardGeocode(query, (found, forQuery) => {
      // A result for a query the box no longer shows (superseded by a later
      // keystroke): the debounce already supersedes it internally, but the
      // guard is cheap insurance against a reordered response.
      if (forQuery !== requestQuery.current) return;
      setResults(found ?? []);
      setStatus(found === null ? "failed" : "done");
      setOpen(true);
      setActiveIndex(-1);
    });
    return cancel;
  }, [query]);

  const pick = (result: SearchResult): void => {
    const store = useEditorStore.getState();
    // `setPin` clears the preset and marks the scene stale; `applyGeocodeResult`
    // is the SAME place-resolution path a reverse lookup uses (source
    // "geocode", `city_label` filled unless the user has since typed their
    // own text over it) -- a search pick is not a stronger claim on the field
    // than a drag-and-settle would be, so it goes through the one path both
    // agree on rather than `setPlaceName`'s "wins forever" override.
    store.setPin(result.lat, result.lon);
    store.setRadius(radiusForResultType(result));
    store.applyGeocodeResult(result.lat, result.lon, {
      city: placeNameFromLabel(result.label),
      state: null,
      country: null,
      neighbourhood: null,
    });
    void store.generate();
    skipNextSearch.current = true;
    setQuery(result.label);
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.blur();
  };

  const move = (delta: 1 | -1): void => {
    if (results.length === 0) return;
    setActiveIndex((current) => {
      const next = (current + delta + results.length) % results.length;
      return next;
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open && results.length > 0) setOpen(true);
      move(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === "Enter") {
      if (open && activeIndex >= 0 && activeIndex < results.length) {
        event.preventDefault();
        pick(results[activeIndex]);
      }
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
  };

  useEffect(() => {
    if (activeIndex < 0) return;
    const item = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const activeId =
    activeIndex >= 0 && activeIndex < results.length ? `search-result-${activeIndex}` : undefined;

  return (
    <div className="pointer-events-auto absolute right-2 top-2 z-10 w-64 max-w-[70%]">
      {/*
        A combobox, not a plain text input with a menu bolted on: the ARIA
        pattern's roles are what let a screen reader announce "expanded, 3 of
        6" while the visible list stays where a sighted user already sees it.
      */}
      <div
        role="combobox"
        aria-expanded={open}
        // `aria-controls`/`aria-owns` must name an id that actually EXISTS in
        // the DOM (axe's `aria-valid-attr-value`, serious): the listbox below
        // is conditionally rendered (`{open ? <ul id="search-results-list">
        // ... : null}`), so pointing at it while closed named an id nothing
        // answers to. `undefined` while closed, same discipline every other
        // disclosure in this app already uses (`AdjustmentsChip`,
        // `IssuesBadge`, `HistoryChip`).
        aria-controls={open ? "search-results-list" : undefined}
        aria-owns={open ? "search-results-list" : undefined}
        aria-haspopup="listbox"
      >
        <input
          ref={inputRef}
          type="text"
          role="searchbox"
          aria-label="Search for a place"
          aria-autocomplete="list"
          aria-controls={open ? "search-results-list" : undefined}
          aria-activedescendant={activeId}
          data-testid="location-search"
          placeholder="Search for a place..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (results.length > 0) setOpen(true);
          }}
          onBlur={() => {
            // Deferred: a click on a result row fires blur before its own
            // click handler, and closing synchronously would drop the pick.
            window.setTimeout(() => setOpen(false), 150);
          }}
          className="w-full rounded-milled border border-line bg-plate/95 px-2.5 py-1.5 text-2xs text-ink shadow-raised placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {open ? (
        <ul
          ref={listRef}
          id="search-results-list"
          role="listbox"
          aria-label="Search results"
          data-testid="search-results"
          className="mt-1 max-h-60 overflow-y-auto rounded-plate border border-line bg-plate shadow-lifted"
        >
          {status === "searching" ? (
            <li className="px-2.5 py-1.5 text-2xs text-ink-faint">Searching...</li>
          ) : status === "failed" ? (
            <li data-testid="search-failed" className="px-2.5 py-1.5 text-2xs text-warn">
              Could not search right now. Check the connection and try again.
            </li>
          ) : results.length === 0 ? (
            <li data-testid="search-empty" className="px-2.5 py-1.5 text-2xs text-ink-faint">
              Nothing found for &quot;{query}&quot;.
            </li>
          ) : (
            results.map((result, index) => (
              <li
                key={`${result.lat},${result.lon},${index}`}
                id={`search-result-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                data-testid="search-result"
                // onMouseDown (not onClick): fires before the input's onBlur
                // timer's target check would matter, and before focus moves.
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(result);
                }}
                onMouseEnter={() => setActiveIndex(index)}
                className={`cursor-pointer px-2.5 py-1.5 text-2xs leading-snug ${
                  index === activeIndex ? "bg-plate-raised text-ink" : "text-ink-muted"
                }`}
              >
                {result.label}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

export default SearchBox;
