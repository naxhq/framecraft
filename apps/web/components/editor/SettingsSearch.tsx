"use client";

import { type RefObject } from "react";

import { labelled } from "@/lib/controlCatalog";
import { highlight, type SearchHit } from "@/lib/settingsSearch";
import { Hint } from "./Controls";

/**
 * The settings search box and the hit lists it puts at the top of each group.
 *
 * The panel is ninety-odd controls in twelve groups, and eleven of those groups
 * start collapsed, so "where is the setting for X" is the question the panel
 * has to answer fastest. Three parts, all driven by `lib/settingsSearch.ts`:
 *
 *  - **the box**, with a clear affordance and the slash-key shortcut on it;
 *  - **the hit list**, rendered inside each group that holds a match, with the
 *    matched run of the label and of the help string marked. The real controls
 *    stay below it: a hit is a route to the control, never a copy of it, so
 *    nothing here can drift from what the control actually does;
 *  - **the empty state**, which says what was searched for and offers the way
 *    out rather than leaving a blank panel.
 *
 * Nothing in here writes a parameter. The query is layout state, so it never
 * enters `PrintParams` and never counts as a change (DECISIONS `[V3.1-O6]`).
 */
export function SettingsSearch({
  query,
  onQuery,
  hitCount,
  inputRef,
}: {
  query: string;
  onQuery: (value: string) => void;
  hitCount: number;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const spec = labelled("settings-search");
  const clear = labelled("settings-search-clear");
  const searching = query.trim() !== "";

  /*
    Escape empties the box before the shell's global dismiss ever sees it:
    while a search is running, that is what Escape means in here. It lives
    outside the JSX because a line comment inside an open tag is the one place
    an apostrophe can break the catalog test's tag scanner.
  */
  const onKeyDown = (event: { key: string; stopPropagation: () => void }): void => {
    if (event.key !== "Escape" || query === "") return;
    event.stopPropagation();
    onQuery("");
  };

  return (
    <div className="border-b border-line bg-plate px-4 pb-2.5 pt-2">
      <label htmlFor={spec.id} className="sr-only">
        {spec.label}
      </label>
      <div className="relative flex items-center">
        <input
          ref={inputRef}
          id="settings-search"
          data-testid="settings-search"
          type="search"
          value={query}
          placeholder="Search settings"
          aria-describedby="settings-search-hint"
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={onKeyDown}
          className="w-full rounded-milled border border-control bg-plate-raised py-1.5 pl-2 pr-16 text-sm text-ink placeholder:text-ink-faint"
        />
        {searching ? (
          <button
            type="button"
            id="settings-search-clear"
            data-testid="settings-search-clear"
            aria-label={`${clear.label} settings search`}
            aria-describedby="settings-search-hint"
            title={clear.hint}
            onClick={() => {
              onQuery("");
              inputRef.current?.focus();
            }}
            className="absolute right-1.5 rounded-milled border border-control px-1.5 py-0.5 text-2xs text-ink-muted transition-colors hover:bg-plate-sunken hover:text-ink"
          >
            {clear.label}
          </button>
        ) : (
          <kbd
            aria-hidden="true"
            className="absolute right-2 rounded-milled border border-line bg-plate-sunken px-1.5 py-0.5 text-2xs text-ink-faint"
          >
            /
          </kbd>
        )}
      </div>
      {searching ? (
        <p
          data-testid="settings-search-count"
          aria-live="polite"
          className="mt-1.5 text-2xs text-ink-faint"
        >
          {hitCount === 0
            ? "Nothing matches"
            : `${hitCount} ${hitCount === 1 ? "match" : "matches"}`}
        </p>
      ) : (
        <Hint id="settings-search-hint">{spec.hint}</Hint>
      )}
      {searching ? (
        <span id="settings-search-hint" className="sr-only">
          {spec.hint}
        </span>
      ) : null}
    </div>
  );
}

/** One group's matches, at the top of its body. */
export function SearchHits({
  group,
  hits,
  query,
  onFocusControl,
}: {
  group: string;
  hits: readonly SearchHit[];
  query: string;
  onFocusControl: (testId: string) => void;
}) {
  if (hits.length === 0) return null;
  return (
    <ul
      data-testid={`search-hits-${group}`}
      aria-label={`Matches in this group for ${query}`}
      className="space-y-1 rounded-milled border border-accent/40 bg-accent-soft p-2"
    >
      {hits.map((hit) => (
        <li key={`${hit.kind}-${hit.id}`}>
          <button
            type="button"
            data-testid={`search-hit-${hit.id}`}
            disabled={hit.focusTestId === null}
            aria-describedby="settings-search-hint"
            onClick={() => {
              if (hit.focusTestId !== null) onFocusControl(hit.focusTestId);
            }}
            className="w-full rounded-milled px-1 py-0.5 text-left text-2xs leading-snug text-ink-muted transition-colors hover:bg-plate-raised disabled:cursor-default"
          >
            <span className="font-medium text-ink">
              <Marked text={hit.label} query={query} />
            </span>
            <span className="block text-ink-faint">
              <Marked text={hit.help} query={query} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Nothing matched: say what was searched for, and offer the way back. */
export function SearchEmpty({ query, onClear }: { query: string; onClear: () => void }) {
  const spec = labelled("settings-search-empty-clear");
  return (
    <div data-testid="settings-search-empty" className="space-y-2 px-4 py-6">
      <p className="text-sm font-medium text-ink">No setting matches “{query}”.</p>
      <p className="text-2xs leading-snug text-ink-faint">
        Every control is searched by its name and by what it does to the printed
        object, so plainer words often work better: try “depth”, “filament”,
        “height” or “frame”.
      </p>
      <button
        type="button"
        id="settings-search-empty-clear"
        data-testid="settings-search-empty-clear"
        aria-describedby="settings-search-hint"
        title={spec.hint}
        onClick={onClear}
        className="rounded-milled border border-control bg-plate-raised px-2 py-1 text-2xs text-ink transition-colors hover:border-ink-faint"
      >
        {spec.label}
      </button>
    </div>
  );
}

/** The matched runs of a string, marked. Never HTML built from a string. */
function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlight(text, query).map((segment, index) =>
        segment.hit ? (
          <mark
            key={index}
            className="rounded-[2px] bg-accent px-0.5 text-accent-ink"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

export default SettingsSearch;
