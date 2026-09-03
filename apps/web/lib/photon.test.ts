/**
 * The Photon type-ahead client ([V3-P9]).
 *
 * `fetch` is mocked in every case here: this suite must never reach
 * photon.komoot.io, both because CI cannot depend on somebody else's public
 * endpoint being up and because a test suite hammering it is exactly the
 * behaviour the request policy below exists to prevent.
 *
 * Carries the coverage the forward half of `lib/geocode.test.ts` used to hold
 * (cache, fail-soft matrix, timeout, debounce) plus what is new in this phase:
 * the minimum query length, the abort-on-supersede, the LRU bound and the
 * 429/5xx policy.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PHOTON_CACHE_CAP,
  PHOTON_CACHE_TTL_MS,
  PHOTON_DEBOUNCE_MS,
  PHOTON_LIMIT,
  PHOTON_MIN_QUERY_CHARS,
  PHOTON_RATE_LIMIT_COOLDOWN_MS,
  PHOTON_RETRY_DELAY_MS,
  PHOTON_TIMEOUT_MS,
  extractPhotonPlaces,
  fetchPhotonSearch,
  photonCacheSize,
  photonPlaceKind,
  photonRateLimitedUntil,
  photonSearchUrl,
  radiusForPlace,
  readPhotonCache,
  resetPhotonForTests,
  retryAfterMs,
  schedulePhotonSearch,
  writePhotonCache,
  type PhotonPlace,
} from "./photon";

/** One Photon feature, in the shape the live API returns it. */
const CHICAGO_FEATURE = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [-87.6233, 41.8827] },
  properties: {
    osm_id: 122604,
    osm_type: "R",
    osm_key: "place",
    osm_value: "city",
    type: "city",
    name: "Chicago",
    state: "Illinois",
    country: "United States",
    countrycode: "US",
  },
};

const CHICAGO_RESPONSE = { type: "FeatureCollection", features: [CHICAGO_FEATURE] };

interface ResponseOptions {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  json?: () => Promise<unknown>;
}

function response(options: ResponseOptions = {}): Response {
  const status = options.status ?? 200;
  const headers = options.headers ?? {};
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: options.json ?? (() => Promise.resolve(options.body ?? CHICAGO_RESPONSE)),
  } as unknown as Response;
}

function place(overrides: Partial<PhotonPlace> = {}): PhotonPlace {
  return {
    id: "R1",
    name: "Chicago",
    context: "Illinois, United States",
    lat: 41.8827,
    lon: -87.6233,
    kind: "city",
    state: "Illinois",
    country: "United States",
    neighbourhood: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  resetPhotonForTests();
});

describe("photonSearchUrl", () => {
  it("asks for eight English results", () => {
    const url = photonSearchUrl("Chicago");
    expect(url).toContain("photon.komoot.io/api/");
    expect(url).toContain("q=Chicago");
    expect(url).toContain(`limit=${PHOTON_LIMIT}`);
    expect(url).toContain("lang=en");
    expect(PHOTON_LIMIT).toBe(8);
  });

  it("escapes a query rather than pasting it into the URL", () => {
    expect(photonSearchUrl("rue de l'Église & co")).toContain(
      "q=rue+de+l%27%C3%89glise+%26+co",
    );
  });

  it("adds the pin as a proximity bias, rounded to a tenth of a degree", () => {
    const url = photonSearchUrl("main st", { lat: 41.88274, lon: -87.62331 });
    expect(url).toContain("lat=41.9");
    expect(url).toContain("lon=-87.6");
  });

  it("sends no bias at all when there is none, rather than a zero one", () => {
    const url = photonSearchUrl("Chicago", null);
    expect(url).not.toContain("lat=");
    expect(url).not.toContain("lon=");
  });
});

describe("photonPlaceKind", () => {
  it("reads the OSM tag before Photon's own bucket", () => {
    // osm_key wins: a highway is a road however Photon classified it.
    expect(photonPlaceKind({ osm_key: "highway", osm_value: "residential", type: "city" })).toBe(
      "road",
    );
    expect(photonPlaceKind({ osm_key: "building", osm_value: "yes" })).toBe("building");
    expect(photonPlaceKind({ osm_key: "amenity", osm_value: "cafe" })).toBe("amenity");
  });

  it("maps place values to the radius table's own names", () => {
    expect(photonPlaceKind({ osm_key: "place", osm_value: "city" })).toBe("city");
    expect(photonPlaceKind({ osm_key: "place", osm_value: "town" })).toBe("town");
    expect(photonPlaceKind({ osm_key: "place", osm_value: "suburb" })).toBe("suburb");
    expect(photonPlaceKind({ osm_key: "place", osm_value: "neighbourhood" })).toBe("neighbourhood");
    expect(photonPlaceKind({ osm_key: "place", osm_value: "village" })).toBe("locality");
    expect(photonPlaceKind({ osm_key: "place", osm_value: "state" })).toBe("region");
  });

  it("falls back to Photon's type when the tag says nothing useful", () => {
    expect(photonPlaceKind({ type: "street" })).toBe("road");
    expect(photonPlaceKind({ type: "house" })).toBe("house");
    expect(photonPlaceKind({ type: "district" })).toBe("suburb");
    expect(photonPlaceKind({ type: "country" })).toBe("region");
  });

  it("is 'place', never a guess, for a feature it cannot classify", () => {
    expect(photonPlaceKind({})).toBe("place");
    expect(photonPlaceKind({ osm_key: "natural", osm_value: "peak" })).toBe("place");
  });
});

describe("radiusForPlace", () => {
  it("routes every kind through the frozen [V3-P6] table", () => {
    expect(radiusForPlace({ kind: "city" })).toBe(1500);
    expect(radiusForPlace({ kind: "town" })).toBe(1500);
    expect(radiusForPlace({ kind: "suburb" })).toBe(900);
    expect(radiusForPlace({ kind: "neighbourhood" })).toBe(900);
    expect(radiusForPlace({ kind: "building" })).toBe(400);
    expect(radiusForPlace({ kind: "house" })).toBe(400);
    expect(radiusForPlace({ kind: "amenity" })).toBe(400);
  });

  it("gives a road, a locality, a region and an unclassified place the 900 m default", () => {
    expect(radiusForPlace({ kind: "road" })).toBe(900);
    expect(radiusForPlace({ kind: "locality" })).toBe(900);
    expect(radiusForPlace({ kind: "region" })).toBe(900);
    expect(radiusForPlace({ kind: "place" })).toBe(900);
  });
});

describe("extractPhotonPlaces", () => {
  it("reads a feature, taking GeoJSON's [lon, lat] the right way round", () => {
    expect(extractPhotonPlaces(CHICAGO_RESPONSE)).toEqual([
      {
        id: "R122604",
        name: "Chicago",
        context: "Illinois, United States",
        lat: 41.8827,
        lon: -87.6233,
        kind: "city",
        state: "Illinois",
        country: "United States",
        neighbourhood: null,
      },
    ]);
  });

  it("carries the administrative fields a pick binds, rather than nulls", () => {
    // A pick writes these straight into `params.place`. Reading them off the
    // SAME answer that named the result is what stops an `applyGeocodeResult`
    // full of nulls from blanking three fields until a reverse lookup that
    // may never arrive refills them ([V3-P9-fix], audit finding 7).
    const places = extractPhotonPlaces({
      features: [
        {
          geometry: { coordinates: [-87.6359, 41.8789] },
          properties: {
            osm_id: 18378194,
            osm_type: "W",
            osm_key: "building",
            name: "Willis Tower",
            district: "The Loop",
            city: "Chicago",
            state: "Illinois",
            country: "United States",
          },
        },
      ],
    });
    expect(places[0].state).toBe("Illinois");
    expect(places[0].country).toBe("United States");
    // Photon calls it `district`; the store's field is `neighbourhood`.
    expect(places[0].neighbourhood).toBe("The Loop");
  });

  it("reads a missing administrative field as null, never as an empty string", () => {
    const places = extractPhotonPlaces({
      features: [
        {
          geometry: { coordinates: [0, 0] },
          properties: { osm_id: 1, osm_type: "N", name: "Null Island", state: "  " },
        },
      ],
    });
    expect(places[0].state).toBeNull();
    expect(places[0].country).toBeNull();
    expect(places[0].neighbourhood).toBeNull();
  });

  it("names a house-number result by its number and street", () => {
    const places = extractPhotonPlaces({
      features: [
        {
          geometry: { coordinates: [2.2945, 48.8584] },
          properties: {
            osm_id: 5013364,
            osm_type: "W",
            osm_key: "building",
            housenumber: "5",
            street: "Avenue Anatole France",
            city: "Paris",
            country: "France",
          },
        },
      ],
    });
    expect(places[0].name).toBe("5 Avenue Anatole France");
    expect(places[0].context).toBe("Avenue Anatole France, Paris, France");
    expect(places[0].kind).toBe("building");
  });

  it("never repeats the primary name in the context line", () => {
    const places = extractPhotonPlaces({
      features: [
        {
          geometry: { coordinates: [-87.6233, 41.8827] },
          properties: {
            osm_id: 1,
            osm_type: "R",
            name: "Chicago",
            city: "Chicago",
            state: "Illinois",
            country: "United States",
          },
        },
      ],
    });
    expect(places[0].context).toBe("Illinois, United States");
  });

  it("drops a feature with no name, no coordinates or coordinates out of range", () => {
    const places = extractPhotonPlaces({
      features: [
        { geometry: { coordinates: [-87.6233, 41.8827] }, properties: {} },
        { geometry: { coordinates: ["x", 41.8] }, properties: { name: "Bad" } },
        { geometry: { coordinates: [-87.6, 991] }, properties: { name: "Off world" } },
        { properties: { name: "No geometry" } },
        CHICAGO_FEATURE,
      ],
    });
    expect(places.map((entry) => entry.name)).toEqual(["Chicago"]);
  });

  it("keeps one row per OSM feature when the response repeats one", () => {
    const places = extractPhotonPlaces({ features: [CHICAGO_FEATURE, CHICAGO_FEATURE] });
    expect(places).toHaveLength(1);
  });

  it("is empty, not throwing, for anything that is not a FeatureCollection", () => {
    expect(extractPhotonPlaces(null)).toEqual([]);
    expect(extractPhotonPlaces(undefined)).toEqual([]);
    expect(extractPhotonPlaces([])).toEqual([]);
    expect(extractPhotonPlaces({ features: "nope" })).toEqual([]);
    expect(extractPhotonPlaces("nope")).toEqual([]);
  });
});

describe("the LRU cache", () => {
  it("answers a repeated query and refuses one past the time to live", () => {
    writePhotonCache("chicago", [place()], null, 1000);
    expect(readPhotonCache("Chicago ", null, 1000)).toHaveLength(1);
    expect(readPhotonCache("chicago", null, 1000 + PHOTON_CACHE_TTL_MS + 1)).toBeNull();
  });

  it("keys on the rounded bias too, so the same word near a different pin re-searches", () => {
    writePhotonCache("main st", [place()], { lat: 41.88, lon: -87.62 }, 0);
    expect(readPhotonCache("main st", { lat: 41.88, lon: -87.62 }, 0)).toHaveLength(1);
    // Same tenth of a degree: still the same cache entry.
    expect(readPhotonCache("main st", { lat: 41.87, lon: -87.63 }, 0)).toHaveLength(1);
    // A different city entirely: a different entry, so a miss.
    expect(readPhotonCache("main st", { lat: 48.85, lon: 2.35 }, 0)).toBeNull();
  });

  it(`holds at most ${PHOTON_CACHE_CAP} queries, evicting the least recently read`, () => {
    for (let index = 0; index < PHOTON_CACHE_CAP; index += 1) {
      writePhotonCache(`query ${index}`, [place()], null, 0);
    }
    expect(photonCacheSize()).toBe(PHOTON_CACHE_CAP);
    // Read the oldest, which moves it to the front of the queue.
    expect(readPhotonCache("query 0", null, 0)).not.toBeNull();
    writePhotonCache("one more", [place()], null, 0);
    expect(photonCacheSize()).toBe(PHOTON_CACHE_CAP);
    expect(readPhotonCache("query 0", null, 0)).not.toBeNull();
    // "query 1" was the least recently used once "query 0" was touched.
    expect(readPhotonCache("query 1", null, 0)).toBeNull();
  });
});

describe("retryAfterMs", () => {
  it("reads a delay in seconds", () => {
    expect(retryAfterMs("45")).toBe(45_000);
    expect(retryAfterMs(" 2 ")).toBe(2000);
  });

  it("reads an HTTP date as the distance from now", () => {
    const now = Date.parse("2026-09-02T12:00:00Z");
    expect(retryAfterMs("Wed, 02 Sep 2026 12:01:00 GMT", now)).toBe(60_000);
  });

  it("falls back to the fixed cooldown for a missing or unreadable header", () => {
    expect(retryAfterMs(null)).toBe(PHOTON_RATE_LIMIT_COOLDOWN_MS);
    expect(retryAfterMs("soon")).toBe(PHOTON_RATE_LIMIT_COOLDOWN_MS);
  });
});

describe("fetchPhotonSearch", () => {
  it("answers places for a 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response());
    const outcome = await fetchPhotonSearch("Chicago", { fetchImpl });
    expect(outcome).toEqual({ status: "ok", places: extractPhotonPlaces(CHICAGO_RESPONSE) });
  });

  it(`sends nothing for a query under ${PHOTON_MIN_QUERY_CHARS} characters`, async () => {
    const fetchImpl = vi.fn();
    expect(await fetchPhotonSearch("ch", { fetchImpl })).toEqual({ status: "ok", places: [] });
    expect(await fetchPhotonSearch("   ", { fetchImpl })).toEqual({ status: "ok", places: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a network failure and a 4xx as unavailable, never as an empty result", async () => {
    expect(
      await fetchPhotonSearch("Chicago", {
        fetchImpl: vi.fn().mockRejectedValue(new TypeError("offline")),
      }),
    ).toEqual({ status: "unavailable" });
    expect(
      await fetchPhotonSearch("Chicago", {
        fetchImpl: vi.fn().mockResolvedValue(response({ status: 400 })),
      }),
    ).toEqual({ status: "unavailable" });
    expect(
      await fetchPhotonSearch("Chicago", {
        fetchImpl: vi
          .fn()
          .mockResolvedValue(response({ json: () => Promise.reject(new SyntaxError("bad")) })),
      }),
    ).toEqual({ status: "unavailable" });
  });

  it(`retries a 5xx exactly once, ${PHOTON_RETRY_DELAY_MS} ms later, and takes the second answer`, async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({ status: 503 }))
      .mockResolvedValueOnce(response());
    const promise = fetchPhotonSearch("Chicago", { fetchImpl });
    await vi.advanceTimersByTimeAsync(PHOTON_RETRY_DELAY_MS - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    const outcome = await promise;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(outcome.status).toBe("ok");
  });

  it("gives up as unavailable when the retry fails too, and never tries a third time", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(response({ status: 500 }));
    const promise = fetchPhotonSearch("Chicago", { fetchImpl });
    await vi.advanceTimersByTimeAsync(PHOTON_RETRY_DELAY_MS + 10);
    expect(await promise).toEqual({ status: "unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it(`refuses to send anything for ${PHOTON_RATE_LIMIT_COOLDOWN_MS} ms after a 429`, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchImpl = vi.fn().mockResolvedValue(response({ status: 429 }));
    const first = await fetchPhotonSearch("Chicago", { fetchImpl });
    expect(first.status).toBe("rate-limited");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(photonRateLimitedUntil()).toBe(PHOTON_RATE_LIMIT_COOLDOWN_MS);

    // A second query inside the cooldown never reaches the network at all.
    vi.setSystemTime(PHOTON_RATE_LIMIT_COOLDOWN_MS - 1000);
    const second = await fetchPhotonSearch("Chicago area", { fetchImpl });
    expect(second).toEqual({ status: "rate-limited", retryAfterMs: 1000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Once it expires, traffic resumes.
    vi.setSystemTime(PHOTON_RATE_LIMIT_COOLDOWN_MS + 1);
    fetchImpl.mockResolvedValue(response());
    expect((await fetchPhotonSearch("Chicago area", { fetchImpl })).status).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("waits longer than the fixed cooldown when Retry-After asks for longer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(response({ status: 429, headers: { "Retry-After": "120" } }));
    await fetchPhotonSearch("Chicago", { fetchImpl });
    expect(photonRateLimitedUntil()).toBe(120_000);
  });

  it("never retries a 429, however short Retry-After claims to be", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(response({ status: 429, headers: { "Retry-After": "1" } }));
    await fetchPhotonSearch("Chicago", { fetchImpl });
    // The 30 s floor holds: a server asking to be hit again in a second is
    // still a server telling us we are asking too often.
    expect(photonRateLimitedUntil()).toBe(PHOTON_RATE_LIMIT_COOLDOWN_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it(`gives up as unavailable after ${PHOTON_TIMEOUT_MS} ms with no answer`, async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const promise = fetchPhotonSearch("Chicago", { fetchImpl });
    await vi.advanceTimersByTimeAsync(PHOTON_TIMEOUT_MS + 1);
    expect(await promise).toEqual({ status: "unavailable" });
  });

  it("reports a caller's own abort as aborted, which is not a failure to show", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const promise = fetchPhotonSearch("Chicago", { fetchImpl, signal: controller.signal });
    controller.abort();
    expect(await promise).toEqual({ status: "aborted" });
  });
});

describe("schedulePhotonSearch", () => {
  it(`sends nothing at all under ${PHOTON_MIN_QUERY_CHARS} characters`, async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn();
    const onOutcome = vi.fn();
    schedulePhotonSearch("ch", onOutcome, { fetchImpl });
    await vi.advanceTimersByTimeAsync(PHOTON_DEBOUNCE_MS * 10);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it(`waits ${PHOTON_DEBOUNCE_MS} ms and sends one request for a run of keystrokes`, async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(response());
    const onOutcome = vi.fn();
    for (const query of ["chi", "chic", "chica", "chicago"]) {
      schedulePhotonSearch(query, onOutcome, { fetchImpl });
      await vi.advanceTimersByTimeAsync(PHOTON_DEBOUNCE_MS - 50);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PHOTON_DEBOUNCE_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain("q=chicago");
    expect(onOutcome).toHaveBeenCalledTimes(1);
  });

  it("aborts the request already in flight when the next keystroke arrives", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    const onOutcome = vi.fn();

    schedulePhotonSearch("chi", onOutcome, { fetchImpl });
    await vi.advanceTimersByTimeAsync(PHOTON_DEBOUNCE_MS + 10);
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);

    schedulePhotonSearch("chic", onOutcome, { fetchImpl });
    expect(signals[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(PHOTON_DEBOUNCE_MS + 10);
    expect(signals).toHaveLength(2);
    // The superseded request has no news for the box.
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it("answers a cached query at once, with no request and no debounce", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(response());
    const onOutcome = vi.fn();

    schedulePhotonSearch("chicago", onOutcome, { fetchImpl });
    await vi.advanceTimersByTimeAsync(PHOTON_DEBOUNCE_MS + 10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    onOutcome.mockClear();
    schedulePhotonSearch("Chicago", onOutcome, { fetchImpl });
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports a rate limit and an outage to the caller rather than hanging", async () => {
    vi.useFakeTimers();
    const onOutcome = vi.fn();
    schedulePhotonSearch("chicago", onOutcome, {
      fetchImpl: vi.fn().mockResolvedValue(response({ status: 429 })),
    });
    await vi.advanceTimersByTimeAsync(PHOTON_DEBOUNCE_MS + 10);
    expect(onOutcome.mock.calls[0][0].status).toBe("rate-limited");

    resetPhotonForTests();
    const second = vi.fn();
    schedulePhotonSearch("bergen", second, {
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("offline")),
    });
    await vi.advanceTimersByTimeAsync(PHOTON_DEBOUNCE_MS + 10);
    expect(second).toHaveBeenCalledWith({ status: "unavailable" }, "bergen");
  });

  it("caches only a successful answer, so an outage does not stick", async () => {
    vi.useFakeTimers();
    schedulePhotonSearch("bergen", vi.fn(), {
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("offline")),
    });
    await vi.advanceTimersByTimeAsync(PHOTON_DEBOUNCE_MS + 10);
    expect(readPhotonCache("bergen")).toBeNull();
  });

  it("the returned canceller drops a still-pending debounce", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(response());
    const onOutcome = vi.fn();
    const cancel = schedulePhotonSearch("chicago", onOutcome, { fetchImpl });
    cancel();
    await vi.advanceTimersByTimeAsync(PHOTON_DEBOUNCE_MS * 4);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onOutcome).not.toHaveBeenCalled();
  });
});
