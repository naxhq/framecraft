/**
 * The nine groups, and the persistence of which ones are collapsed.
 *
 * The failure this file guards against is the one a `try { JSON.parse } catch`
 * usually still has: storage that is present but useless (a stray value, an old
 * key, a browser that throws on READ as well as on write) leaving the panel
 * with a partial record and every group rendering closed on a first visit.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GROUPS,
  GROUP_IDS,
  GROUP_STORAGE_KEY,
  defaultCollapsed,
  loadCollapsed,
  mergeCollapsed,
  saveCollapsed,
  type CollapsedGroups,
} from "./groups";

/** A localStorage stand-in with switchable failure modes. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: () => null,
    length: 0,
    read: (key: string) => data.get(key) ?? null,
  };
}

function withStorage(storage: unknown): void {
  vi.stubGlobal("window", { localStorage: storage });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the group table", () => {
  it("names the nine groups the panel is built from", () => {
    expect(GROUP_IDS).toEqual([
      "location",
      "scale",
      "buildings",
      "heights",
      "surface",
      "terrain",
      "frame",
      "colour",
      "output",
    ]);
  });

  it("gives every group a title and a summary", () => {
    for (const group of GROUPS) {
      expect(group.title.length, group.id).toBeGreaterThan(0);
      expect(group.summary.length, group.id).toBeGreaterThan(0);
    }
  });

  it("starts with the two personalisation groups and terrain collapsed", () => {
    const collapsed = defaultCollapsed();
    expect(collapsed).toEqual({
      location: false,
      scale: false,
      buildings: false,
      heights: false,
      surface: false,
      terrain: true,
      frame: true,
      colour: true,
      output: false,
    });
  });
});

describe("mergeCollapsed", () => {
  it("falls back to the defaults for anything that is not an object", () => {
    for (const raw of [null, undefined, 3, "open", true, [], [1, 2]]) {
      expect(mergeCollapsed(raw)).toEqual(defaultCollapsed());
    }
  });

  it("keeps the defaults for groups the stored value does not mention", () => {
    const merged = mergeCollapsed({ location: true });
    expect(merged.location).toBe(true);
    // ...and every other group still has its default, not `undefined`.
    expect(merged.scale).toBe(false);
    expect(merged.frame).toBe(true);
    expect(Object.keys(merged).sort()).toEqual([...GROUP_IDS].sort());
  });

  it("ignores non-boolean and unknown keys", () => {
    const merged = mergeCollapsed({
      location: "yes",
      colour: 0,
      nonsense: true,
    });
    expect(merged.location).toBe(false);
    expect(merged.colour).toBe(true);
    expect("nonsense" in merged).toBe(false);
  });
});

describe("loadCollapsed", () => {
  it("returns the defaults with no stored value", () => {
    withStorage(fakeStorage());
    expect(loadCollapsed()).toEqual(defaultCollapsed());
  });

  it("returns the defaults for a corrupt stored value", () => {
    withStorage(fakeStorage({ [GROUP_STORAGE_KEY]: "{not json" }));
    expect(loadCollapsed()).toEqual(defaultCollapsed());
  });

  it("returns the defaults when reading throws (private mode)", () => {
    withStorage({
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => undefined,
    });
    expect(loadCollapsed()).toEqual(defaultCollapsed());
  });

  it("returns the defaults with no window at all (server render)", () => {
    vi.stubGlobal("window", undefined);
    expect(loadCollapsed()).toEqual(defaultCollapsed());
  });

  it("round-trips a real state through save and load", () => {
    const storage = fakeStorage();
    withStorage(storage);
    const state: CollapsedGroups = {
      ...defaultCollapsed(),
      location: true,
      colour: false,
    };
    saveCollapsed(state);
    expect(storage.read(GROUP_STORAGE_KEY)).toBeTruthy();
    expect(loadCollapsed()).toEqual(state);
  });
});

describe("saveCollapsed", () => {
  it("does not throw when storage refuses to write", () => {
    withStorage({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(() => saveCollapsed(defaultCollapsed())).not.toThrow();
  });

  it("does nothing, and does not throw, without a window", () => {
    vi.stubGlobal("window", undefined);
    expect(() => saveCollapsed(defaultCollapsed())).not.toThrow();
  });
});
