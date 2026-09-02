/**
 * Recent designs: cap, dedupe by payload, and fail-soft storage ([V3-P6]).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RECENT_CAP,
  clearRecent,
  listRecent,
  recentDesignName,
  recordRecent,
  removeRecent,
} from "./recent";

/** The same localStorage stand-in `lib/geocode.test.ts` uses. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: () => null,
    length: 0,
  };
}

function withStorage(storage: unknown): void {
  vi.stubGlobal("window", { localStorage: storage });
}

afterEach(() => vi.unstubAllGlobals());

describe("recentDesignName", () => {
  it("joins the place name and the ISO date", () => {
    expect(recentDesignName("Chicago", new Date("2026-08-29T12:00:00Z"))).toBe(
      "Chicago (2026-08-29)",
    );
  });

  it("falls back to 'Custom location' for a blank place", () => {
    expect(recentDesignName("", new Date("2026-08-29T12:00:00Z"))).toBe(
      "Custom location (2026-08-29)",
    );
    expect(recentDesignName("   ", new Date("2026-08-29T12:00:00Z"))).toBe(
      "Custom location (2026-08-29)",
    );
  });
});

describe("recordRecent / listRecent", () => {
  beforeEach(() => withStorage(fakeStorage()));

  it("is empty before anything is recorded", () => {
    expect(listRecent()).toEqual([]);
  });

  it("adds newest first", () => {
    recordRecent("Chicago (2026-08-29)", "v3.aaa.111");
    recordRecent("Paris (2026-08-29)", "v3.bbb.222");
    const list = listRecent();
    expect(list.map((entry) => entry.name)).toEqual([
      "Paris (2026-08-29)",
      "Chicago (2026-08-29)",
    ]);
  });

  it("dedupes by payload, moving the repeat to the front instead of duplicating it", () => {
    recordRecent("Chicago (2026-08-29)", "v3.same.111");
    recordRecent("Paris (2026-08-29)", "v3.other.222");
    recordRecent("Chicago again (2026-08-30)", "v3.same.111");
    const list = listRecent();
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe("Chicago again (2026-08-30)");
    expect(list[0].payload).toBe("v3.same.111");
  });

  it(`caps the list at ${RECENT_CAP}, dropping the oldest`, () => {
    for (let i = 0; i < RECENT_CAP + 5; i += 1) {
      recordRecent(`design ${i}`, `v3.p${i}.000`);
    }
    const list = listRecent();
    expect(list).toHaveLength(RECENT_CAP);
    // Newest first, and the oldest five fell off the end.
    expect(list[0].name).toBe(`design ${RECENT_CAP + 4}`);
    expect(list.some((entry) => entry.name === "design 0")).toBe(false);
  });

  it("removeRecent drops exactly one entry by payload", () => {
    recordRecent("Chicago", "v3.a.1");
    recordRecent("Paris", "v3.b.2");
    const next = removeRecent("v3.a.1");
    expect(next.map((entry) => entry.payload)).toEqual(["v3.b.2"]);
    expect(listRecent().map((entry) => entry.payload)).toEqual(["v3.b.2"]);
  });

  it("clearRecent empties the list", () => {
    recordRecent("Chicago", "v3.a.1");
    clearRecent();
    expect(listRecent()).toEqual([]);
  });

  it("fails soft when storage throws on read or write", () => {
    withStorage({
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("private mode");
      },
    });
    expect(() => recordRecent("Chicago", "v3.a.1")).not.toThrow();
    expect(listRecent()).toEqual([]);
  });

  it("treats a corrupt store as empty rather than throwing", () => {
    withStorage(fakeStorage({ "framecraft.recent.v1": "not json" }));
    expect(listRecent()).toEqual([]);
  });

  it("drops entries that are not shaped like a RecentDesign", () => {
    withStorage(
      fakeStorage({
        "framecraft.recent.v1": JSON.stringify([
          { name: "Chicago", savedAt: "2026-08-29T00:00:00Z", payload: "v3.a.1" },
          { name: "Bad", payload: "" },
          { not: "a recent design" },
          "just a string",
        ]),
      }),
    );
    expect(listRecent()).toEqual([
      { name: "Chicago", savedAt: "2026-08-29T00:00:00Z", payload: "v3.a.1" },
    ]);
  });

  it("has no window at all in a non-browser context", () => {
    vi.stubGlobal("window", undefined);
    expect(() => recordRecent("Chicago", "v3.a.1")).not.toThrow();
    expect(listRecent()).toEqual([]);
  });
});
