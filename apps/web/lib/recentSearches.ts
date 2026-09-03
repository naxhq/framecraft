/**
 * The last eight places picked out of the search box ([V3-P9]).
 *
 * Distinct from `lib/recent.ts`, which remembers recent DESIGNS (a whole
 * share payload: location plus every print parameter, restored by
 * `decodeShare`). This one remembers only "where I looked", so it can offer
 * somewhere to go back to before a single character has been typed, and it
 * deliberately does not carry any print settings: returning to a place should
 * not silently re-apply the frame and colour choices that were on screen when
 * it was first visited.
 *
 * Storage is best-effort throughout. A corrupt value, a private-mode window
 * that throws on write, or a server render with no `window` at all each read
 * as an empty list rather than an error, exactly as `lib/recent.ts` and
 * `lib/groups.ts` already do.
 */

import type { PlaceKind } from "./photon";

export const RECENT_SEARCH_STORAGE_KEY = "framecraft.search.recent.v1";
export const RECENT_SEARCH_CAP = 8;

/** Identity precision: ~11 m, fine enough that two picks of one building coincide. */
const KEY_DECIMALS = 4;

export interface RecentSearch {
  /** The primary line as it was shown when picked. */
  name: string;
  /** The secondary line, possibly empty. */
  context: string;
  lat: number;
  lon: number;
  kind: PlaceKind;
  /** ISO 8601, when this entry was last picked. */
  searchedAt: string;
  /**
   * The administrative fields the pick bound, so returning to a recent place
   * restores `params.place` from the same answer rather than blanking it.
   * Optional: entries written before [V3-P9-fix] have none and stay valid.
   */
  state?: string | null;
  country?: string | null;
  neighbourhood?: string | null;
}

/**
 * Fired after every write so the search box can refresh without polling
 * storage. Same-document only, by design: the browser's own `storage` event
 * covers the other tabs (`window.addEventListener("storage", ...)` filtered on
 * `RECENT_SEARCH_STORAGE_KEY`), and it does NOT fire in the tab that wrote,
 * so the two together cover every tab exactly once.
 */
export const RECENT_SEARCH_CHANGED_EVENT = "framecraft:recent-search-changed";

/**
 * What makes two entries "the same place": the name plus the rounded
 * coordinates. Two different buildings on one street stay separate; the same
 * place picked twice moves to the top instead of appearing twice.
 */
export function recentSearchKey(entry: Pick<RecentSearch, "name" | "lat" | "lon">): string {
  return `${entry.name.trim().toLowerCase()}@${entry.lat.toFixed(KEY_DECIMALS)},${entry.lon.toFixed(
    KEY_DECIMALS,
  )}`;
}

const PLACE_KINDS: readonly string[] = [
  "city",
  "town",
  "suburb",
  "neighbourhood",
  "building",
  "house",
  "amenity",
  "road",
  "locality",
  "region",
  "place",
];

function isRecentSearch(value: unknown): value is RecentSearch {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    record.name.trim() !== "" &&
    typeof record.context === "string" &&
    typeof record.lat === "number" &&
    Number.isFinite(record.lat) &&
    Math.abs(record.lat) <= 90 &&
    typeof record.lon === "number" &&
    Number.isFinite(record.lon) &&
    Math.abs(record.lon) <= 180 &&
    typeof record.kind === "string" &&
    PLACE_KINDS.includes(record.kind) &&
    typeof record.searchedAt === "string"
  );
}

function readStore(): RecentSearch[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_SEARCH_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentSearch).slice(0, RECENT_SEARCH_CAP);
  } catch {
    return [];
  }
}

function writeStore(list: readonly RecentSearch[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECENT_SEARCH_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Private mode or a full quota: the caller's own copy still works today.
  }
  try {
    window.dispatchEvent(new CustomEvent(RECENT_SEARCH_CHANGED_EVENT));
  } catch {
    // A minimal `window` with no event target; the box re-reads on next mount.
  }
}

/** The current list, newest first. Never throws; a corrupt store reads as empty. */
export function listRecentSearches(): RecentSearch[] {
  return readStore();
}

/**
 * Record a pick at the top of the list, de-duplicated by `recentSearchKey` and
 * capped at `RECENT_SEARCH_CAP`. Returns the new list so a caller can render it
 * without a second read.
 */
export function rememberRecentSearch(
  entry: Omit<RecentSearch, "searchedAt">,
  now: Date = new Date(),
): RecentSearch[] {
  const key = recentSearchKey(entry);
  const kept = readStore().filter((existing) => recentSearchKey(existing) !== key);
  const next = [{ ...entry, searchedAt: now.toISOString() }, ...kept].slice(0, RECENT_SEARCH_CAP);
  writeStore(next);
  return next;
}

/** Drop one entry by its `recentSearchKey`. Returns the new list. */
export function forgetRecentSearch(key: string): RecentSearch[] {
  const next = readStore().filter((existing) => recentSearchKey(existing) !== key);
  writeStore(next);
  return next;
}

/** Drop every entry. Returns the (empty) new list. */
export function clearRecentSearches(): RecentSearch[] {
  writeStore([]);
  return [];
}
