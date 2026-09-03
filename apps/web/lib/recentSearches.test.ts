/**
 * The search box's recent-places list ([V3-P9]): the cap, the de-duplication
 * rule and the "a broken store is an empty store" contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RECENT_SEARCH_CAP,
  RECENT_SEARCH_CHANGED_EVENT,
  RECENT_SEARCH_STORAGE_KEY,
  clearRecentSearches,
  forgetRecentSearch,
  listRecentSearches,
  recentSearchKey,
  rememberRecentSearch,
  type RecentSearch,
} from "./recentSearches";

/** A localStorage stand-in, the same shape `lib/geocode.test.ts` uses. */
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

const events: string[] = [];

function withStorage(storage: unknown): void {
  events.length = 0;
  vi.stubGlobal("window", {
    localStorage: storage,
    dispatchEvent: (event: Event) => {
      events.push(event.type);
      return true;
    },
  });
}

function entry(
  overrides: Partial<Omit<RecentSearch, "searchedAt">> = {},
): Omit<RecentSearch, "searchedAt"> {
  return {
    name: "Chicago",
    context: "Illinois, United States",
    lat: 41.8827,
    lon: -87.6233,
    kind: "city" as const,
    ...overrides,
  };
}

beforeEach(() => withStorage(fakeStorage()));
afterEach(() => vi.unstubAllGlobals());

describe("rememberRecentSearch", () => {
  it("puts the newest pick first and fires the change event", () => {
    rememberRecentSearch(entry({ name: "Bergen", lat: 60.39, lon: 5.32 }));
    const list = rememberRecentSearch(entry());
    expect(list.map((item) => item.name)).toEqual(["Chicago", "Bergen"]);
    expect(events).toEqual([RECENT_SEARCH_CHANGED_EVENT, RECENT_SEARCH_CHANGED_EVENT]);
  });

  it("moves a repeated pick to the top instead of listing it twice", () => {
    rememberRecentSearch(entry());
    rememberRecentSearch(entry({ name: "Bergen", lat: 60.39, lon: 5.32 }));
    const list = rememberRecentSearch(entry());
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe("Chicago");
  });

  it("treats two places at the same name but different coordinates as different", () => {
    rememberRecentSearch(entry({ name: "Springfield", lat: 39.8, lon: -89.6 }));
    const list = rememberRecentSearch(entry({ name: "Springfield", lat: 42.1, lon: -72.6 }));
    expect(list).toHaveLength(2);
  });

  it(`keeps at most ${RECENT_SEARCH_CAP}, dropping the oldest`, () => {
    for (let index = 0; index < RECENT_SEARCH_CAP + 4; index += 1) {
      rememberRecentSearch(entry({ name: `Place ${index}`, lat: index, lon: index }));
    }
    const list = listRecentSearches();
    expect(list).toHaveLength(RECENT_SEARCH_CAP);
    expect(list[0].name).toBe(`Place ${RECENT_SEARCH_CAP + 3}`);
    expect(list.some((item) => item.name === "Place 0")).toBe(false);
  });

  it("round-trips the administrative fields a pick bound", () => {
    // Returning to a recent place must restore `params.place` from the same
    // answer that named it, not blank it and wait on a reverse lookup.
    const list = rememberRecentSearch(
      entry({ state: "Illinois", country: "United States", neighbourhood: "The Loop" }),
    );
    expect(list[0].state).toBe("Illinois");
    expect(list[0].country).toBe("United States");
    expect(list[0].neighbourhood).toBe("The Loop");
    expect(listRecentSearches()[0].country).toBe("United States");
  });

  it("keeps an entry written before those fields existed", () => {
    withStorage(
      fakeStorage({
        [RECENT_SEARCH_STORAGE_KEY]: JSON.stringify([
          { name: "Bergen", context: "Norway", lat: 60.39, lon: 5.32, kind: "city", searchedAt: "x" },
        ]),
      }),
    );
    const list = listRecentSearches();
    expect(list).toHaveLength(1);
    expect(list[0].state).toBeUndefined();
  });

  it("stamps the pick with the time it happened", () => {
    const list = rememberRecentSearch(entry(), new Date("2026-09-02T10:00:00Z"));
    expect(list[0].searchedAt).toBe("2026-09-02T10:00:00.000Z");
  });
});

describe("forgetRecentSearch and clearRecentSearches", () => {
  it("removes exactly one entry by its key", () => {
    rememberRecentSearch(entry());
    rememberRecentSearch(entry({ name: "Bergen", lat: 60.39, lon: 5.32 }));
    const list = forgetRecentSearch(recentSearchKey(entry()));
    expect(list.map((item) => item.name)).toEqual(["Bergen"]);
  });

  it("leaves the list alone for a key that is not in it", () => {
    rememberRecentSearch(entry());
    expect(forgetRecentSearch("nothing@0.0000,0.0000")).toHaveLength(1);
  });

  it("empties the whole list", () => {
    rememberRecentSearch(entry());
    rememberRecentSearch(entry({ name: "Bergen", lat: 60.39, lon: 5.32 }));
    expect(clearRecentSearches()).toEqual([]);
    expect(listRecentSearches()).toEqual([]);
  });
});

describe("recentSearchKey", () => {
  it("ignores case and surrounding space in the name", () => {
    expect(recentSearchKey({ name: "  Chicago ", lat: 41.8827, lon: -87.6233 })).toBe(
      recentSearchKey({ name: "chicago", lat: 41.8827, lon: -87.6233 }),
    );
  });

  it("rounds the coordinates, so a metre of drift is still the same place", () => {
    expect(recentSearchKey({ name: "Chicago", lat: 41.88271, lon: -87.62331 })).toBe(
      recentSearchKey({ name: "Chicago", lat: 41.88272, lon: -87.62334 }),
    );
  });
});

describe("a store that cannot be trusted", () => {
  it("reads as empty when the value is not JSON", () => {
    withStorage(fakeStorage({ [RECENT_SEARCH_STORAGE_KEY]: "{not json" }));
    expect(listRecentSearches()).toEqual([]);
  });

  it("reads as empty when the value is not an array", () => {
    withStorage(fakeStorage({ [RECENT_SEARCH_STORAGE_KEY]: '{"name":"Chicago"}' }));
    expect(listRecentSearches()).toEqual([]);
  });

  it("drops individual entries that are malformed and keeps the rest", () => {
    withStorage(
      fakeStorage({
        [RECENT_SEARCH_STORAGE_KEY]: JSON.stringify([
          { name: "", context: "", lat: 1, lon: 1, kind: "city", searchedAt: "x" },
          { name: "No coords", context: "", kind: "city", searchedAt: "x" },
          { name: "Off world", context: "", lat: 991, lon: 1, kind: "city", searchedAt: "x" },
          { name: "Odd kind", context: "", lat: 1, lon: 1, kind: "spaceport", searchedAt: "x" },
          { name: "Fine", context: "", lat: 1, lon: 1, kind: "city", searchedAt: "x" },
        ]),
      }),
    );
    expect(listRecentSearches().map((item) => item.name)).toEqual(["Fine"]);
  });

  it("survives a storage that throws on every call", () => {
    const throwing = {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("private mode");
      },
    };
    withStorage(throwing);
    expect(listRecentSearches()).toEqual([]);
    expect(() => rememberRecentSearch(entry())).not.toThrow();
  });

  it("reads as empty with no window at all, as it does during a server render", () => {
    vi.stubGlobal("window", undefined);
    expect(listRecentSearches()).toEqual([]);
    expect(() => clearRecentSearches()).not.toThrow();
  });
});
