/**
 * Nominatim reverse geocoding: cache, rate limit, debounce and fail-soft
 * behaviour, plus `[V3-P6]`'s frozen kind-to-radius table. `fetch` is always
 * mocked here -- this suite must never touch the network, per the project rule
 * that CI can never call a live geocoder.
 *
 * The forward (type-ahead) half of this module moved to Photon in [V3-P9];
 * `lib/photon.test.ts` carries its coverage, including the cache, the
 * fail-soft matrix, the abort-on-timeout case and the debounce.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GEOCODE_CACHE_TTL_MS,
  GEOCODE_DEBOUNCE_MS,
  GEOCODE_MIN_INTERVAL_MS,
  GEOCODE_TIMEOUT_MS,
  GEOCODE_USER_AGENT,
  extractGeocodeResult,
  fetchReverseGeocode,
  geocodeCacheKey,
  radiusForResultType,
  readCache,
  resetGeocodeSchedulerForTests,
  resolveReverseGeocode,
  scheduleReverseGeocode,
  suppressNextReverseGeocode,
  suppressedReverseGeocodePin,
  writeCache,
  type GeocodeResult,
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

describe("suppressNextReverseGeocode", () => {
  beforeEach(() => {
    withStorage(fakeStorage());
    vi.useFakeTimers();
  });

  it("skips the lookup for the pin it was armed for, and reports it", async () => {
    // A pick already knows the name of what the user chose. Without this, the
    // reverse lookup its own pin move triggers overwrites "Willis Tower" with
    // "Chicago" 600 ms later, with no user action to explain it.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(CHICAGO_RESPONSE));
    const onResult = vi.fn();
    suppressNextReverseGeocode(...CHICAGO);
    expect(suppressedReverseGeocodePin()).not.toBeNull();

    scheduleReverseGeocode(...CHICAGO, onResult, { fetchImpl });
    await vi.advanceTimersByTimeAsync(GEOCODE_DEBOUNCE_MS + GEOCODE_MIN_INTERVAL_MS + 10);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
    expect(suppressedReverseGeocodePin()).toBeNull();
  });

  it("does not skip a lookup for any other pin, and disarms itself", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(CHICAGO_RESPONSE));
    const onResult = vi.fn();
    suppressNextReverseGeocode(...CHICAGO);

    scheduleReverseGeocode(48.8566, 2.3522, onResult, { fetchImpl });
    await vi.advanceTimersByTimeAsync(GEOCODE_DEBOUNCE_MS + GEOCODE_MIN_INTERVAL_MS + 10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Armed for one pin move only: a pin dragged back later resolves normally.
    expect(suppressedReverseGeocodePin()).toBeNull();
  });

  it("is one shot: the pin picked, then dragged away and back, resolves normally", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(CHICAGO_RESPONSE));
    const onResult = vi.fn();
    suppressNextReverseGeocode(...CHICAGO);
    scheduleReverseGeocode(...CHICAGO, onResult, { fetchImpl });
    await vi.advanceTimersByTimeAsync(GEOCODE_DEBOUNCE_MS + 10);
    expect(fetchImpl).not.toHaveBeenCalled();

    scheduleReverseGeocode(...CHICAGO, onResult, { fetchImpl });
    await vi.advanceTimersByTimeAsync(GEOCODE_DEBOUNCE_MS + GEOCODE_MIN_INTERVAL_MS + 10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// the kind-to-radius table, shared with lib/photon.ts
// ===========================================================================

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
