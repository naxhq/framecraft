/**
 * Nominatim reverse geocoding: cache, rate limit, debounce and fail-soft
 * behaviour. `fetch` is always mocked here -- this suite must never touch the
 * network, per the project rule that CI can never call a live geocoder.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GEOCODE_CACHE_TTL_MS,
  GEOCODE_DEBOUNCE_MS,
  GEOCODE_MIN_INTERVAL_MS,
  GEOCODE_SEARCH_CACHE_TTL_MS,
  GEOCODE_SEARCH_DEBOUNCE_MS,
  GEOCODE_TIMEOUT_MS,
  GEOCODE_USER_AGENT,
  extractGeocodeResult,
  extractSearchResults,
  fetchForwardGeocode,
  fetchReverseGeocode,
  geocodeCacheKey,
  placeNameFromLabel,
  radiusForResultType,
  readCache,
  readSearchCache,
  resetGeocodeSchedulerForTests,
  resolveForwardGeocode,
  resolveReverseGeocode,
  scheduleForwardGeocode,
  scheduleReverseGeocode,
  writeCache,
  writeSearchCache,
  type GeocodeResult,
  type SearchResult,
} from "./geocode";

/** A localStorage stand-in, the same shape `lib/groups.test.ts` uses. */
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

const CHICAGO: [number, number] = [41.8827, -87.6233];

const CHICAGO_RESPONSE = {
  address: {
    city: "Chicago",
    state: "Illinois",
    country: "United States",
    neighbourhood: "The Loop",
  },
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetGeocodeSchedulerForTests();
});

describe("extractGeocodeResult", () => {
  it("reads city, state, country and neighbourhood off the address object", () => {
    expect(extractGeocodeResult(CHICAGO_RESPONSE)).toEqual({
      city: "Chicago",
      state: "Illinois",
      country: "United States",
      neighbourhood: "The Loop",
    });
  });

  it("falls back through town, village, municipality, county for city", () => {
    expect(extractGeocodeResult({ address: { town: "Bergen" } }).city).toBe("Bergen");
    expect(extractGeocodeResult({ address: { village: "Bergen" } }).city).toBe("Bergen");
    expect(extractGeocodeResult({ address: { municipality: "Bergen" } }).city).toBe("Bergen");
    expect(extractGeocodeResult({ address: { county: "Bergen" } }).city).toBe("Bergen");
    // city wins over every fallback when present
    expect(
      extractGeocodeResult({ address: { city: "Chicago", town: "Nope" } }).city,
    ).toBe("Chicago");
  });

  it("falls back through suburb, quarter for neighbourhood", () => {
    expect(extractGeocodeResult({ address: { suburb: "Loop" } }).neighbourhood).toBe("Loop");
    expect(extractGeocodeResult({ address: { quarter: "Loop" } }).neighbourhood).toBe("Loop");
  });

  it("reads every field as null rather than a guess when nothing is there", () => {
    expect(extractGeocodeResult({})).toEqual({
      city: null,
      state: null,
      country: null,
      neighbourhood: null,
    });
    expect(extractGeocodeResult(null)).toEqual({
      city: null,
      state: null,
      country: null,
      neighbourhood: null,
    });
    expect(extractGeocodeResult(undefined)).toEqual({
      city: null,
      state: null,
      country: null,
      neighbourhood: null,
    });
  });

  it("treats a blank or whitespace-only field as absent", () => {
    expect(extractGeocodeResult({ address: { city: "   " } }).city).toBeNull();
    expect(extractGeocodeResult({ address: { city: "" } }).city).toBeNull();
  });
});

describe("fetchReverseGeocode", () => {
  it("requests jsonv2 at zoom 14 with the FrameCraft User-Agent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(CHICAGO_RESPONSE));
    const result = await fetchReverseGeocode(CHICAGO[0], CHICAGO[1], fetchImpl);
    expect(result).toEqual({
      city: "Chicago",
      state: "Illinois",
      country: "United States",
      neighbourhood: "The Loop",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("nominatim.openstreetmap.org/reverse");
    expect(url).toContain("format=jsonv2");
    expect(url).toContain("zoom=14");
    expect(url).toContain(`lat=${encodeURIComponent(String(CHICAGO[0]))}`);
    expect(url).toContain(`lon=${encodeURIComponent(String(CHICAGO[1]))}`);
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(GEOCODE_USER_AGENT);
    // No email query parameter: the Accept-Language default is left alone.
    expect(url).not.toContain("email=");
  });

  it("fails soft to null on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 503));
    expect(await fetchReverseGeocode(CHICAGO[0], CHICAGO[1], fetchImpl)).toBeNull();
  });

  it("fails soft to null when fetch itself rejects", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await fetchReverseGeocode(CHICAGO[0], CHICAGO[1], fetchImpl)).toBeNull();
  });

  it("fails soft to null on an unparsable body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("bad json")),
    } as unknown as Response);
    expect(await fetchReverseGeocode(CHICAGO[0], CHICAGO[1], fetchImpl)).toBeNull();
  });

  it(`aborts and fails soft after ${GEOCODE_TIMEOUT_MS} ms`, async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const promise = fetchReverseGeocode(CHICAGO[0], CHICAGO[1], fetchImpl);
    await vi.advanceTimersByTimeAsync(GEOCODE_TIMEOUT_MS);
    expect(await promise).toBeNull();
  });
});

describe("cache", () => {
  beforeEach(() => withStorage(fakeStorage()));

  it("round-trips a result keyed by lat/lon rounded to 3 decimals", () => {
    const result: GeocodeResult = {
      city: "Chicago",
      state: "Illinois",
      country: "United States",
      neighbourhood: "The Loop",
    };
    writeCache(41.88271, -87.62329, result);
    // 41.8827 rounds to the same key as 41.88271 at 3 decimals.
    expect(readCache(41.8827, -87.6233)).toEqual(result);
  });

  it("keys distinct locations separately", () => {
    writeCache(41.8827, -87.6233, { city: "Chicago", state: null, country: null, neighbourhood: null });
    expect(readCache(48.8566, 2.3522)).toBeNull();
  });

  it("expires after the 30 day TTL", () => {
    const result: GeocodeResult = { city: "Chicago", state: null, country: null, neighbourhood: null };
    const stored = Date.parse("2026-01-01T00:00:00Z");
    writeCache(41.8827, -87.6233, result, stored);
    expect(readCache(41.8827, -87.6233, stored + GEOCODE_CACHE_TTL_MS - 1)).toEqual(result);
    expect(readCache(41.8827, -87.6233, stored + GEOCODE_CACHE_TTL_MS + 1)).toBeNull();
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
    expect(() => writeCache(41.8827, -87.6233, { city: "X", state: null, country: null, neighbourhood: null })).not.toThrow();
    expect(readCache(41.8827, -87.6233)).toBeNull();
  });

  it("treats a corrupt cache value as empty rather than throwing", () => {
    withStorage(fakeStorage({ "framecraft.geocode.v1": "not json" }));
    expect(readCache(41.8827, -87.6233)).toBeNull();
  });

  it("has no window at all in a non-browser context", () => {
    vi.stubGlobal("window", undefined);
    expect(() => writeCache(41.8827, -87.6233, { city: "X", state: null, country: null, neighbourhood: null })).not.toThrow();
    expect(readCache(41.8827, -87.6233)).toBeNull();
  });
});

describe("geocodeCacheKey", () => {
  it("rounds to 3 decimals", () => {
    expect(geocodeCacheKey(41.88271, -87.62329)).toBe(geocodeCacheKey(41.8827, -87.6233));
    expect(geocodeCacheKey(41.8827, -87.6233)).not.toBe(geocodeCacheKey(41.8837, -87.6233));
  });
});

describe("resolveReverseGeocode", () => {
  beforeEach(() => withStorage(fakeStorage()));

  it("answers from the cache without touching fetchImpl", async () => {
    writeCache(41.8827, -87.6233, {
      city: "Chicago",
      state: "Illinois",
      country: "United States",
      neighbourhood: "The Loop",
    });
    const fetchImpl = vi.fn();
    const result = await resolveReverseGeocode(41.8827, -87.6233, fetchImpl);
    expect(result?.city).toBe("Chicago");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches and caches on a miss", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(CHICAGO_RESPONSE));
    const result = await resolveReverseGeocode(41.8827, -87.6233, fetchImpl);
    expect(result?.city).toBe("Chicago");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Second call is now a cache hit.
    const second = await resolveReverseGeocode(41.8827, -87.6233, fetchImpl);
    expect(second?.city).toBe("Chicago");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed lookup, so a later attempt can retry", async () => {
    const failing = vi.fn().mockResolvedValue(jsonResponse({}, false, 503));
    expect(await resolveReverseGeocode(41.8827, -87.6233, failing)).toBeNull();
    const succeeding = vi.fn().mockResolvedValue(jsonResponse(CHICAGO_RESPONSE));
    expect((await resolveReverseGeocode(41.8827, -87.6233, succeeding))?.city).toBe("Chicago");
    expect(succeeding).toHaveBeenCalledTimes(1);
  });
});

describe("scheduleReverseGeocode", () => {
  beforeEach(() => {
    withStorage(fakeStorage());
    vi.useFakeTimers();
  });

  it(`waits ${GEOCODE_DEBOUNCE_MS} ms after the pin stops moving before it fetches`, async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(CHICAGO_RESPONSE));
    const onResult = vi.fn();
    scheduleReverseGeocode(41.8827, -87.6233, onResult, { fetchImpl });
    await vi.advanceTimersByTimeAsync(GEOCODE_DEBOUNCE_MS - 1);
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ city: "Chicago" }),
      41.8827,
      -87.6233,
    );
  });

  it("a later call before the debounce elapses supersedes the earlier one", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(CHICAGO_RESPONSE));
    const onResult = vi.fn();
    scheduleReverseGeocode(48.8566, 2.3522, onResult, { fetchImpl });
    await vi.advanceTimersByTimeAsync(200);
    // The pin kept moving before Paris's debounce fired.
    scheduleReverseGeocode(41.8827, -87.6233, onResult, { fetchImpl });
    await vi.advanceTimersByTimeAsync(GEOCODE_DEBOUNCE_MS + 50);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(expect.anything(), 41.8827, -87.6233);
  });

  it(`never starts two requests under ${GEOCODE_MIN_INTERVAL_MS} ms apart`, async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(CHICAGO_RESPONSE)));
    const onResult = vi.fn();

    scheduleReverseGeocode(1, 1, onResult, { fetchImpl });
    await vi.advanceTimersByTimeAsync(GEOCODE_DEBOUNCE_MS + 1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    scheduleReverseGeocode(2, 2, onResult, { fetchImpl });
    await vi.advanceTimersByTimeAsync(GEOCODE_DEBOUNCE_MS + 1);
    // The debounce elapsed but the 1 request/second floor has not.
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(GEOCODE_MIN_INTERVAL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("a cache hit answers after the debounce without touching fetchImpl", async () => {
    writeCache(41.8827, -87.6233, {
      city: "Chicago",
      state: null,
      country: null,
      neighbourhood: null,
    });
    const fetchImpl = vi.fn();
    const onResult = vi.fn();
    scheduleReverseGeocode(41.8827, -87.6233, onResult, { fetchImpl });
    await vi.advanceTimersByTimeAsync(GEOCODE_DEBOUNCE_MS + 1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ city: "Chicago" }),
      41.8827,
      -87.6233,
    );
  });

  it("the returned canceller drops a still-pending debounce", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(CHICAGO_RESPONSE));
    const onResult = vi.fn();
    const cancel = scheduleReverseGeocode(41.8827, -87.6233, onResult, { fetchImpl });
    cancel();
    await vi.advanceTimersByTimeAsync(GEOCODE_DEBOUNCE_MS + GEOCODE_MIN_INTERVAL_MS + 10);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// forward geocoding (search)
// ===========================================================================

const CHICAGO_SEARCH_RESPONSE = [
  {
    display_name: "Chicago, Cook County, Illinois, United States",
    lat: "41.8827",
    lon: "-87.6233",
    type: "city",
    addresstype: "city",
  },
];

describe("radiusForResultType", () => {
  it("gives a city or town 1500 m", () => {
    expect(radiusForResultType({ type: "city", addresstype: null })).toBe(1500);
    expect(radiusForResultType({ type: "town", addresstype: null })).toBe(1500);
    expect(radiusForResultType({ type: null, addresstype: "town" })).toBe(1500);
  });

  it("gives a suburb or neighbourhood 900 m", () => {
    expect(radiusForResultType({ type: "suburb", addresstype: null })).toBe(900);
    expect(radiusForResultType({ type: "neighbourhood", addresstype: null })).toBe(900);
    expect(radiusForResultType({ type: "quarter", addresstype: null })).toBe(900);
  });

  it("gives a building or amenity 400 m", () => {
    expect(radiusForResultType({ type: "building", addresstype: null })).toBe(400);
    expect(radiusForResultType({ type: "amenity", addresstype: null })).toBe(400);
    expect(radiusForResultType({ type: "house", addresstype: null })).toBe(400);
  });

  it("defaults to 900 m for anything else, including nothing at all", () => {
    expect(radiusForResultType({ type: "road", addresstype: null })).toBe(900);
    expect(radiusForResultType({ type: null, addresstype: null })).toBe(900);
  });

  it("prefers addresstype over type when both are present", () => {
    expect(radiusForResultType({ type: "administrative", addresstype: "city" })).toBe(1500);
  });
});

describe("placeNameFromLabel", () => {
  it("takes the leading part before the first comma", () => {
    expect(placeNameFromLabel("Chicago, Cook County, Illinois, United States")).toBe("Chicago");
  });

  it("trims whitespace around the leading part", () => {
    expect(placeNameFromLabel("  Bergen ,Norway")).toBe("Bergen");
  });

  it("falls back to the whole label when there is no comma", () => {
    expect(placeNameFromLabel("Chicago")).toBe("Chicago");
  });

  it("falls back to the whole label when the leading part is empty", () => {
    expect(placeNameFromLabel(", Illinois")).toBe(", Illinois");
  });
});

describe("extractSearchResults", () => {
  it("reads label, lat, lon, type and addresstype off each entry", () => {
    expect(extractSearchResults(CHICAGO_SEARCH_RESPONSE)).toEqual([
      {
        label: "Chicago, Cook County, Illinois, United States",
        lat: 41.8827,
        lon: -87.6233,
        type: "city",
        addresstype: "city",
      },
    ]);
  });

  it("drops an entry missing a label or a coordinate rather than throwing", () => {
    expect(
      extractSearchResults([
        { display_name: "No coords", lat: "not a number", lon: "-87.6" },
        { lat: "41.8", lon: "-87.6" },
        { display_name: "Fine", lat: "1", lon: "2" },
      ]),
    ).toEqual([{ label: "Fine", lat: 1, lon: 2, type: null, addresstype: null }]);
  });

  it("is empty, not throwing, for anything that is not an array", () => {
    expect(extractSearchResults(null)).toEqual([]);
    expect(extractSearchResults(undefined)).toEqual([]);
    expect(extractSearchResults({})).toEqual([]);
    expect(extractSearchResults("nope")).toEqual([]);
  });
});

describe("fetchForwardGeocode", () => {
  it("requests jsonv2 with a limit and the FrameCraft User-Agent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(CHICAGO_SEARCH_RESPONSE));
    const results = await fetchForwardGeocode("Chicago", fetchImpl);
    expect(results).toEqual([
      {
        label: "Chicago, Cook County, Illinois, United States",
        lat: 41.8827,
        lon: -87.6233,
        type: "city",
        addresstype: "city",
      },
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("nominatim.openstreetmap.org/search");
    expect(url).toContain("format=jsonv2");
    expect(url).toContain("q=Chicago");
    expect(url).toContain("limit=6");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(GEOCODE_USER_AGENT);
  });

  it("answers [] for a blank query without a request", async () => {
    const fetchImpl = vi.fn();
    expect(await fetchForwardGeocode("   ", fetchImpl)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails soft to null on a non-2xx response, a rejected fetch or bad json", async () => {
    expect(
      await fetchForwardGeocode("x", vi.fn().mockResolvedValue(jsonResponse([], false, 503))),
    ).toBeNull();
    expect(
      await fetchForwardGeocode("x", vi.fn().mockRejectedValue(new TypeError("failed"))),
    ).toBeNull();
    expect(
      await fetchForwardGeocode(
        "x",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError("bad json")),
        } as unknown as Response),
      ),
    ).toBeNull();
  });

  it(`aborts and fails soft after ${GEOCODE_TIMEOUT_MS} ms`, async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const promise = fetchForwardGeocode("Chicago", fetchImpl);
    await vi.advanceTimersByTimeAsync(GEOCODE_TIMEOUT_MS);
    expect(await promise).toBeNull();
  });
});

describe("forward geocode cache", () => {
  beforeEach(() => withStorage(fakeStorage()));

  const RESULT: SearchResult = {
    label: "Chicago",
    lat: 41.8827,
    lon: -87.6233,
    type: "city",
    addresstype: "city",
  };

  it("round-trips a result list keyed by the normalised query", () => {
    writeSearchCache("  Chicago  ", [RESULT]);
    expect(readSearchCache("chicago")).toEqual([RESULT]);
    expect(readSearchCache("CHICAGO")).toEqual([RESULT]);
  });

  it("caches an empty ('no results') list too", () => {
    writeSearchCache("nowhere at all", []);
    expect(readSearchCache("nowhere at all")).toEqual([]);
  });

  it(`expires after the ${GEOCODE_SEARCH_CACHE_TTL_MS / 86_400_000} day TTL`, () => {
    const stored = Date.parse("2026-01-01T00:00:00Z");
    writeSearchCache("chicago", [RESULT], stored);
    expect(readSearchCache("chicago", stored + GEOCODE_SEARCH_CACHE_TTL_MS - 1)).toEqual([RESULT]);
    expect(readSearchCache("chicago", stored + GEOCODE_SEARCH_CACHE_TTL_MS + 1)).toBeNull();
  });

  it("fails soft when storage throws", () => {
    withStorage({
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("private mode");
      },
    });
    expect(() => writeSearchCache("chicago", [RESULT])).not.toThrow();
    expect(readSearchCache("chicago")).toBeNull();
  });

  it("resolveForwardGeocode answers from cache without touching fetchImpl", async () => {
    writeSearchCache("chicago", [RESULT]);
    const fetchImpl = vi.fn();
    expect(await resolveForwardGeocode("chicago", fetchImpl)).toEqual([RESULT]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resolveForwardGeocode fetches and caches on a miss", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(CHICAGO_SEARCH_RESPONSE));
    const first = await resolveForwardGeocode("Chicago", fetchImpl);
    expect(first?.length).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const second = await resolveForwardGeocode("Chicago", fetchImpl);
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("scheduleForwardGeocode", () => {
  beforeEach(() => {
    withStorage(fakeStorage());
    vi.useFakeTimers();
  });

  it(`waits ${GEOCODE_SEARCH_DEBOUNCE_MS} ms after typing stops before it searches`, async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(CHICAGO_SEARCH_RESPONSE));
    const onResult = vi.fn();
    scheduleForwardGeocode("Chicago", onResult, { fetchImpl });
    await vi.advanceTimersByTimeAsync(GEOCODE_SEARCH_DEBOUNCE_MS - 1);
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ label: expect.stringContaining("Chicago") })]),
      "Chicago",
    );
  });

  it("a later keystroke before the debounce elapses supersedes the earlier query", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(CHICAGO_SEARCH_RESPONSE));
    const onResult = vi.fn();
    scheduleForwardGeocode("Chic", onResult, { fetchImpl });
    await vi.advanceTimersByTimeAsync(200);
    scheduleForwardGeocode("Chicago", onResult, { fetchImpl });
    await vi.advanceTimersByTimeAsync(GEOCODE_SEARCH_DEBOUNCE_MS + 50);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain("q=Chicago");
  });

  it("answers [] immediately for a blank query, without a debounce", () => {
    const onResult = vi.fn();
    scheduleForwardGeocode("   ", onResult);
    expect(onResult).toHaveBeenCalledWith([], "   ");
  });

  it("a search result 'nothing found' (empty array) and a search failure (null) are told apart", async () => {
    const empty = vi.fn();
    scheduleForwardGeocode("nowhere", empty, {
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse([])),
    });
    await vi.advanceTimersByTimeAsync(GEOCODE_SEARCH_DEBOUNCE_MS + 1);
    expect(empty).toHaveBeenCalledWith([], "nowhere");

    const failed = vi.fn();
    scheduleForwardGeocode("boom", failed, {
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("offline")),
    });
    // The shared 1 rps queue still holds "nowhere"'s slot; the min interval,
    // not just the debounce, has to elapse before "boom" gets its turn.
    await vi.advanceTimersByTimeAsync(GEOCODE_SEARCH_DEBOUNCE_MS + GEOCODE_MIN_INTERVAL_MS + 1);
    expect(failed).toHaveBeenCalledWith(null, "boom");
  });

  it("shares the 1 rps queue with reverse geocoding", async () => {
    const reverseFetch = vi.fn().mockResolvedValue(jsonResponse(CHICAGO_RESPONSE));
    const searchFetch = vi.fn().mockResolvedValue(jsonResponse(CHICAGO_SEARCH_RESPONSE));
    const onReverse = vi.fn();
    const onSearch = vi.fn();

    scheduleReverseGeocode(1, 1, onReverse, { fetchImpl: reverseFetch });
    await vi.advanceTimersByTimeAsync(GEOCODE_DEBOUNCE_MS + 1);
    expect(reverseFetch).toHaveBeenCalledTimes(1);

    scheduleForwardGeocode("Chicago", onSearch, { fetchImpl: searchFetch });
    await vi.advanceTimersByTimeAsync(GEOCODE_SEARCH_DEBOUNCE_MS + 1);
    // The debounce elapsed but the shared 1 request/second floor has not.
    expect(searchFetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(GEOCODE_MIN_INTERVAL_MS);
    expect(searchFetch).toHaveBeenCalledTimes(1);
  });

  it("the returned canceller drops a still-pending debounce", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(CHICAGO_SEARCH_RESPONSE));
    const onResult = vi.fn();
    const cancel = scheduleForwardGeocode("Chicago", onResult, { fetchImpl });
    cancel();
    await vi.advanceTimersByTimeAsync(GEOCODE_SEARCH_DEBOUNCE_MS + GEOCODE_MIN_INTERVAL_MS + 10);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });
});
