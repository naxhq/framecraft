/**
 * Recent designs: a small localStorage list of share payloads, so a design
 * copied or exported earlier this session (or a previous one) is one click away
 * instead of a link dug out of chat history ([V3-P6]).
 *
 * Every successful export and every Copy-link records an entry here. The
 * payload is the same `v3.<base64url>.<checksum>` string `lib/share.ts`
 * already produces -- restoring a recent design is `decodeShare` on it,
 * exactly like opening a shared link, so the two paths can never disagree
 * about what a payload means or how it is validated. `lib/share.ts` is not
 * imported here to keep this module a plain data store; callers hold the
 * payload string.
 */

export const RECENT_STORAGE_KEY = "framecraft.recent.v1";
export const RECENT_CAP = 12;

export interface RecentDesign {
  /** Place name plus the save date, e.g. "Chicago (2026-08-29)". */
  name: string;
  /** ISO 8601, when this entry was recorded. */
  savedAt: string;
  /** The share payload (`lib/share.ts:encodeShare`'s return value). */
  payload: string;
}

function readStore(): RecentDesign[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentDesign);
  } catch {
    return [];
  }
}

function isRecentDesign(value: unknown): value is RecentDesign {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    typeof record.savedAt === "string" &&
    typeof record.payload === "string" &&
    record.payload !== ""
  );
}

/** Fired after every write, so `components/editor/RecentDesigns.tsx` can refresh its own read without polling storage. */
export const RECENT_CHANGED_EVENT = "framecraft:recent-changed";

function writeStore(list: readonly RecentDesign[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // The in-memory list still works for this session (private mode, quota).
  }
  try {
    window.dispatchEvent(new CustomEvent(RECENT_CHANGED_EVENT));
  } catch {
    // A minimal/stubbed `window` (a test double, an unusual embedder) without
    // a real event target: `RecentDesigns` falls back to its own on-mount
    // read next time it remounts, which is the only cost.
  }
}

/** The current list, newest first. Never throws; a corrupt store reads as empty. */
export function listRecent(): RecentDesign[] {
  return readStore();
}

/**
 * "Chicago (2026-08-29)": the place name plus the save date, or
 * "Custom location (…)" when there is no place name to show.
 */
export function recentDesignName(place: string, now: Date = new Date()): string {
  const label = place.trim() !== "" ? place.trim() : "Custom location";
  return `${label} (${now.toISOString().slice(0, 10)})`;
}

/**
 * Record a design, newest first, deduplicated by payload (an unchanged
 * design copied twice moves to the front rather than appearing twice) and
 * capped at `RECENT_CAP` (oldest dropped first). Returns the new list, so a
 * caller can update its own view without a second read.
 */
export function recordRecent(
  name: string,
  payload: string,
  now: Date = new Date(),
): RecentDesign[] {
  const existing = readStore().filter((entry) => entry.payload !== payload);
  const entry: RecentDesign = { name, savedAt: now.toISOString(), payload };
  const next = [entry, ...existing].slice(0, RECENT_CAP);
  writeStore(next);
  return next;
}

/** Drop one entry by payload. */
export function removeRecent(payload: string): RecentDesign[] {
  const next = readStore().filter((entry) => entry.payload !== payload);
  writeStore(next);
  return next;
}

/** Clear the whole list. */
export function clearRecent(): void {
  writeStore([]);
}
