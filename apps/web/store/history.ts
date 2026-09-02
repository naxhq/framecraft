/**
 * Undo / redo: a bounded history of `location` + `params`, coalescing rapid
 * changes to the same setting into one step ([V3-P6]).
 *
 * `history` is deliberately its OWN zustand store rather than fields bolted
 * onto `useEditorStore`: recording works by SUBSCRIBING to the editor store
 * (`initHistory`) and diffing `location`/`params` by reference across each
 * notification, rather than by touching `store/editor.ts`'s twenty-odd
 * setters one at a time. This is what makes "Palette apply, project load,
 * share restore, and auto-fix-all each count as ONE step" true for free: every
 * one of those actions already writes the store with a single `set()` call
 * (`applyShared`, `applyProject`, `setNested`, `applySafeFindingFixes`, ...),
 * and zustand notifies subscribers once per `set()` call, not once per field
 * -- so one call in, one history entry out, with no special-casing here.
 *
 * `location`/`params` are the only slices recorded (`HistorySnapshot`);
 * `scene`, `engine`, `bake`, `placeDetect`, `terrain` and the transient UI
 * flags are never diffed, which is what keeps a geocode result, a live engine
 * job or a bake's own progress out of the history the brief asks for.
 *
 * Undo/redo write back through `store/editor.ts`'s own `applyHistorySnapshot`,
 * using the EXACT snapshot object already held in an entry (never a copy):
 * that reference equality is what lets this module's own subscriber recognise
 * "this notification is the jump I just caused" and skip re-recording it,
 * without a re-entrancy flag.
 */

import { create } from "zustand";

import type { PrintParams } from "@/lib/contracts";
import { presetLabel } from "@/lib/presets";
import { type LocationState, useEditorStore } from "./editor";

export interface HistorySnapshot {
  location: LocationState;
  params: PrintParams;
}

export interface HistoryEntry {
  snapshot: HistorySnapshot;
  /** "Radius 900 m to 1200 m", "Preset: Chicago", ... */
  label: string;
  /** The coalescing key: entries with the same path within `HISTORY_COALESCE_MS` replace each other instead of stacking. */
  path: string;
  at: number;
}

export const HISTORY_CAP = 100;
export const HISTORY_COALESCE_MS = 800;

interface HistoryState {
  entries: HistoryEntry[];
  /** Index into `entries` of the CURRENT state. */
  cursor: number;
  open: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Record a transition from `previous` to `next`, coalescing where the same leaf changed within the window. */
  record: (previous: HistorySnapshot, next: HistorySnapshot, now?: number) => void;
  /** Step back one entry, returning the snapshot to apply, or null at the start. */
  undo: () => HistorySnapshot | null;
  /** Step forward one entry, returning the snapshot to apply, or null at the tip. */
  redo: () => HistorySnapshot | null;
  /** Jump straight to `index` (a click in the history list), returning its snapshot, or null if out of range. */
  jumpTo: (index: number) => HistorySnapshot | null;
  /** Seed the stack with the current state as its only entry (module init / a hard reset for tests). */
  reset: (initial: HistorySnapshot, label?: string) => void;
  setOpen: (open: boolean) => void;
}

function flags(cursor: number, length: number): { canUndo: boolean; canRedo: boolean } {
  return { canUndo: cursor > 0, canRedo: cursor < length - 1 };
}

export const useHistoryStore = create<HistoryState>()((set, get) => ({
  entries: [],
  cursor: -1,
  open: false,
  canUndo: false,
  canRedo: false,

  record: (previous, next, now = Date.now()) => {
    const { path, label } = describeChange(previous, next);
    set((state) => {
      let entries = state.entries;
      let cursor = state.cursor;
      // A change made after stepping back drops whatever redo branch was
      // ahead of it: the usual undo-stack rule, so redo never resurrects a
      // step that a fresh edit has since made impossible to replay cleanly.
      if (cursor < entries.length - 1) entries = entries.slice(0, cursor + 1);
      const tip = entries[cursor];
      const coalesce = tip !== undefined && tip.path === path && now - tip.at < HISTORY_COALESCE_MS;
      if (coalesce) {
        entries = [...entries.slice(0, cursor), { snapshot: next, label, path, at: now }];
      } else {
        entries = [...entries, { snapshot: next, label, path, at: now }];
        cursor += 1;
      }
      if (entries.length > HISTORY_CAP) {
        const overflow = entries.length - HISTORY_CAP;
        entries = entries.slice(overflow);
        cursor -= overflow;
      }
      return { entries, cursor, ...flags(cursor, entries.length) };
    });
  },

  undo: () => {
    const { entries, cursor } = get();
    if (cursor <= 0) return null;
    const nextCursor = cursor - 1;
    set({ cursor: nextCursor, ...flags(nextCursor, entries.length) });
    return entries[nextCursor].snapshot;
  },

  redo: () => {
    const { entries, cursor } = get();
    if (cursor >= entries.length - 1) return null;
    const nextCursor = cursor + 1;
    set({ cursor: nextCursor, ...flags(nextCursor, entries.length) });
    return entries[nextCursor].snapshot;
  },

  jumpTo: (index) => {
    const { entries } = get();
    if (index < 0 || index >= entries.length) return null;
    set({ cursor: index, ...flags(index, entries.length) });
    return entries[index].snapshot;
  },

  reset: (initial, label = "Start") => {
    set({
      entries: [{ snapshot: initial, label, path: "__init__", at: Date.now() }],
      cursor: 0,
      canUndo: false,
      canRedo: false,
    });
  },

  setOpen: (open) => set({ open }),
}));

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function humanizeKey(key: string): string {
  const spaced = key.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function unitFor(key: string): string {
  if (key.endsWith("_mm")) return " mm";
  if (key.endsWith("_m")) return " m";
  if (key.endsWith("_deg")) return "°";
  return "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatScalar(value: unknown, key: string): string {
  if (typeof value === "number") return `${value}${unitFor(key)}`;
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "string") return value === "" ? "(empty)" : value;
  return "changed";
}

/** One changed top-level `PrintParams` key -> a short label, diving one level into a nested group to find the leaf that actually moved. */
function describeParamsLeaf(key: string, before: unknown, after: unknown): string {
  const name = humanizeKey(key);
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const inner of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[inner]) === JSON.stringify(after[inner])) continue;
      return `${name} ${humanizeKey(inner).toLowerCase()} ${formatScalar(before[inner], inner)} to ${formatScalar(after[inner], inner)}`;
    }
    return `${name} changed`;
  }
  if (Array.isArray(before) || Array.isArray(after)) return `${name} changed`;
  return `${name} ${formatScalar(before, key)} to ${formatScalar(after, key)}`;
}

function describeParamsChange(
  before: PrintParams,
  after: PrintParams,
): { path: string; label: string } | null {
  const a = before as unknown as Record<string, unknown>;
  const b = after as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
    return { path: `params.${key}`, label: describeParamsLeaf(key, a[key], b[key]) };
  }
  return null;
}

/** A friendly one-line label plus a coalescing key for a location/params transition. */
export function describeChange(
  before: HistorySnapshot,
  after: HistorySnapshot,
): { path: string; label: string } {
  if (
    before.location.preset_id !== after.location.preset_id &&
    after.location.preset_id !== null
  ) {
    return { path: "location.preset", label: `Preset: ${presetLabel(after.location.preset_id)}` };
  }
  if (before.location.radius_m !== after.location.radius_m) {
    return {
      path: "location.radius_m",
      label: `Radius ${before.location.radius_m} m to ${after.location.radius_m} m`,
    };
  }
  if (before.location.rotation_deg !== after.location.rotation_deg) {
    return {
      path: "location.rotation_deg",
      label: `Rotation ${before.location.rotation_deg}° to ${after.location.rotation_deg}°`,
    };
  }
  if (before.location.lat !== after.location.lat || before.location.lon !== after.location.lon) {
    return { path: "location.pin", label: "Pin moved" };
  }
  const paramsChange = describeParamsChange(before.params, after.params);
  if (paramsChange) return paramsChange;
  return { path: "composite", label: "Settings changed" };
}

// ---------------------------------------------------------------------------
// Wiring to the editor store
// ---------------------------------------------------------------------------

function snapshotOf(state: { location: LocationState; params: PrintParams }): HistorySnapshot {
  return { location: state.location, params: state.params };
}

let previous: HistorySnapshot = snapshotOf(useEditorStore.getState());
let unsubscribe: (() => void) | null = null;

/**
 * Start recording. Idempotent (a second call re-seeds from the CURRENT editor
 * state rather than stacking a second subscription) -- safe to call from
 * `EditorShell`'s mount effect, which can re-run under React 19 Strict Mode.
 */
export function initHistory(): void {
  if (unsubscribe !== null) unsubscribe();
  previous = snapshotOf(useEditorStore.getState());
  useHistoryStore.getState().reset(previous);
  unsubscribe = useEditorStore.subscribe((state) => {
    if (state.location === previous.location && state.params === previous.params) return;
    const next = snapshotOf(state);
    try {
      useHistoryStore.getState().record(previous, next);
    } catch (error) {
      // A bug in the history recorder must never break the primary editing
      // experience. Concretely: zustand notifies its listeners with a plain
      // iteration, so an uncaught exception THROWN HERE propagates out and
      // can stop OTHER listeners registered after this one -- including
      // React's own re-render subscription -- from ever running again,
      // which freezes the whole UI at whatever it last rendered rather than
      // merely losing one undo step.
      console.warn("[framecraft] history record failed:", error);
    }
    previous = next;
  });
}

/** Test-only: drop the subscription between test files. */
export function stopHistoryForTests(): void {
  if (unsubscribe !== null) unsubscribe();
  unsubscribe = null;
}

function applySnapshot(snapshot: HistorySnapshot): void {
  // Set BEFORE writing the editor store: the subscriber above compares by
  // reference, and this snapshot IS the exact object the entry holds, so the
  // notification `applyHistorySnapshot` triggers is recognised as this jump
  // and never re-recorded as a new user action.
  previous = snapshot;
  useEditorStore.getState().applyHistorySnapshot(snapshot);
}

export function undoHistory(): boolean {
  const snapshot = useHistoryStore.getState().undo();
  if (snapshot === null) return false;
  applySnapshot(snapshot);
  return true;
}

export function redoHistory(): boolean {
  const snapshot = useHistoryStore.getState().redo();
  if (snapshot === null) return false;
  applySnapshot(snapshot);
  return true;
}

export function jumpToHistory(index: number): boolean {
  const snapshot = useHistoryStore.getState().jumpTo(index);
  if (snapshot === null) return false;
  applySnapshot(snapshot);
  return true;
}
