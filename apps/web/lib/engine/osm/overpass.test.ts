import { describe, expect, it, vi } from "vitest";
import {
  bboxFor,
  buildQuery,
  DEFAULT_MIRRORS,
  fetchOverpass,
  MemoryOverpassCache,
  querySha1,
  type OverpassCache,
} from "./overpass";

const CHICAGO_LOOP = { lat: 41.8827, lon: -87.6233, radius_m: 900.0, rotation_deg: 0.0 };

// No test in this file ever omits `fetchImpl`: fetchOverpass falls back to
// the global `fetch` otherwise, and Node 18+ has a real one. Every mock
// below stands in for the network so this suite runs fully offline.
const noSleep = async (): Promise<void> => {};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("buildQuery / querySha1", () => {
  it("produces the byte-identical 03 query text and sha1 as the Python builder, for the Chicago Loop preset", () => {
    const query = buildQuery(CHICAGO_LOOP);
    expect(querySha1(query)).toBe("a4e5375818f309940313e0ac08b8ebb88c615f9e");
  });

  it("contains every 03 element clause, out geom, and a 180s timeout", () => {
    const query = buildQuery(CHICAGO_LOOP);
    expect(query.startsWith("[out:json][timeout:180];\n(\n")).toBe(true);
    expect(query.trim().endsWith("out geom;")).toBe(true);
    for (const fragment of [
      'way["building"]',
      'relation["building"]',
      'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|service|pedestrian|footway)$"]',
      'way["natural"="water"]',
      'relation["natural"="water"]',
      'way["waterway"="riverbank"]',
      'way["landuse"~"^(grass|forest|meadow|recreation_ground)$"]',
      'way["leisure"~"^(park|garden|pitch)$"]',
      'node["natural"="tree"]',
    ]) {
      expect(query).toContain(fragment);
    }
  });

  it("a 15% margin bbox spans about 2 * 1.15 * radius meters", () => {
    const [south, west, north, east] = bboxFor(CHICAGO_LOOP);
    const spanM = (north - south) * 111_320.0;
    expect(spanM).toBeGreaterThan(2 * 1.15 * 900 * 0.98);
    expect(spanM).toBeLessThan(2 * 1.15 * 900 * 1.02);
    expect(east).toBeGreaterThan(west);
  });

  it("rotating by 90 degrees reuses the same bbox and query (the crop square is rotation-symmetric mod 90)", () => {
    const base = buildQuery(CHICAGO_LOOP);
    const turned = buildQuery({ ...CHICAGO_LOOP, rotation_deg: 90.0 });
    expect(turned).toBe(base);
  });
});

describe("fetchOverpass", () => {
  it("succeeds on the first mirror and caches the response", async () => {
    const body = { elements: [{ type: "node", id: 1, lat: 0, lon: 0, tags: { natural: "tree" } }] };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(input).toBe(DEFAULT_MIRRORS[0]);
      return jsonResponse(body);
    });
    const cache = new MemoryOverpassCache();

    const result = await fetchOverpass(CHICAGO_LOOP, { fetchImpl, cache, sleep: noSleep });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fromCache).toBe(false);
      expect(result.data.elements).toHaveLength(1);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(DEFAULT_MIRRORS[0]);
  });

  it("serves a cached response without calling fetch again", async () => {
    const body = { elements: [] };
    const cache = new MemoryOverpassCache();
    await cache.set(querySha1(buildQuery(CHICAGO_LOOP)), body);
    const fetchImpl = vi.fn();

    const result = await fetchOverpass(CHICAGO_LOOP, { fetchImpl, cache, sleep: noSleep });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.fromCache).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails over to the next mirror on a 429, and succeeds there", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      call++;
      if (call === 1) {
        expect(url).toBe(DEFAULT_MIRRORS[0]);
        return jsonResponse({}, 429);
      }
      expect(url).toBe(DEFAULT_MIRRORS[1]);
      return jsonResponse({ elements: [] });
    });

    const result = await fetchOverpass(CHICAGO_LOOP, { fetchImpl, cache: new MemoryOverpassCache(), sleep: noSleep });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails over on a 503 and a 504 in turn across three mirrors, then succeeds", async () => {
    const statuses = [503, 504];
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      const status = statuses[call];
      call++;
      if (status !== undefined) return jsonResponse({}, status);
      return jsonResponse({ elements: [] });
    });

    const result = await fetchOverpass(CHICAGO_LOOP, {
      fetchImpl,
      cache: new MemoryOverpassCache(),
      mirrors: DEFAULT_MIRRORS,
      sleep: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(call).toBe(3);
  });

  it("fails over to the next mirror on a 403 or a 500, which are facts about the mirror", async () => {
    for (const status of [403, 500, 502]) {
      let call = 0;
      const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
        call++;
        if (call === 1) {
          expect(url).toBe(DEFAULT_MIRRORS[0]);
          return jsonResponse({}, status);
        }
        expect(url).toBe(DEFAULT_MIRRORS[1]);
        return jsonResponse({ elements: [] });
      });

      const result = await fetchOverpass(CHICAGO_LOOP, { fetchImpl, cache: new MemoryOverpassCache(), sleep: noSleep });
      expect(result.ok).toBe(true);
      expect(call).toBe(2);
    }
  });

  it("gives up at once on a 400 or a 422: the query, not the mirror, is what is wrong", async () => {
    for (const status of [400, 422]) {
      const fetchImpl = vi.fn(async () => jsonResponse({}, status));
      const result = await fetchOverpass(CHICAGO_LOOP, { fetchImpl, cache: new MemoryOverpassCache(), sleep: noSleep });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("bad-response");
        expect(result.error.message).toContain(`HTTP ${status}`);
        expect(result.error.mirrorsTried).toEqual([DEFAULT_MIRRORS[0]]);
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("treats a 200 response with a runtime-error remark as a failure and retries", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call === 1) {
        return jsonResponse({ elements: [], remark: 'runtime error: Query timed out in "query" at line 4 after 180 seconds.' });
      }
      return jsonResponse({ elements: [{ type: "node", id: 1, lat: 0, lon: 0 }] });
    });

    const result = await fetchOverpass(CHICAGO_LOOP, { fetchImpl, cache: new MemoryOverpassCache(), sleep: noSleep });
    expect(result.ok).toBe(true);
    expect(call).toBe(2);
  });

  it("never caches an error body", async () => {
    const cache = new MemoryOverpassCache();
    const fetchImpl = vi.fn(async () => jsonResponse({ elements: [], remark: "runtime error: boom" }, 200));

    const result = await fetchOverpass(CHICAGO_LOOP, { fetchImpl, cache, sleep: noSleep });
    expect(result.ok).toBe(false);
    const key = querySha1(buildQuery(CHICAGO_LOOP));
    expect(await cache.get(key)).toBeUndefined();
  });

  it("exhausts all attempts and mirrors and resolves a typed error, never throwing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500));
    const result = await fetchOverpass(CHICAGO_LOOP, { fetchImpl, cache: new MemoryOverpassCache(), sleep: noSleep });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("bad-response");
      expect(result.error.mirrorsTried.length).toBeGreaterThan(0);
    }
  });

  it("classifies a network throw as kind 'network', not a raw exception", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await fetchOverpass(CHICAGO_LOOP, { fetchImpl, cache: new MemoryOverpassCache(), sleep: noSleep });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("network");
  });

  it("classifies an AbortError as kind 'timeout'", async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new DOMException("The operation was aborted", "AbortError");
      throw err;
    });
    const result = await fetchOverpass(CHICAGO_LOOP, { fetchImpl, cache: new MemoryOverpassCache(), sleep: noSleep });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("timeout");
  });

  it("accepts an explicit mirror override for the Settings UI", async () => {
    const custom = ["https://example.invalid/api/interpreter"];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      expect(url).toBe(custom[0]);
      return jsonResponse({ elements: [] });
    });
    const result = await fetchOverpass(CHICAGO_LOOP, { fetchImpl, mirrors: custom, cache: new MemoryOverpassCache(), sleep: noSleep });
    expect(result.ok).toBe(true);
  });

  it("respects a custom cache implementation", async () => {
    const store = new Map<string, unknown>();
    const cache: OverpassCache = {
      get: async (key) => store.get(key),
      set: async (key, value) => {
        store.set(key, value);
      },
    };
    const fetchImpl = vi.fn(async () => jsonResponse({ elements: [] }));
    await fetchOverpass(CHICAGO_LOOP, { fetchImpl, cache, sleep: noSleep });
    expect(store.size).toBe(1);
  });

  // FrameCraft v3 E4: an already-aborted `signal` (a superseded engine-client
  // ingest job) fails soft and never calls fetch at all.
  it("fails soft without ever calling fetch when `signal` is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => jsonResponse({ elements: [] }));
    const result = await fetchOverpass(CHICAGO_LOOP, {
      fetchImpl,
      cache: new MemoryOverpassCache(),
      sleep: noSleep,
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // A `signal` that aborts mid-attempt cancels the in-flight fetch (via
  // `AbortSignal.any` with the attempt's own timeout controller) rather than
  // waiting the full 60 s attempt timeout out.
  it("cancels an in-flight attempt when `signal` aborts while fetch is pending", async () => {
    const controller = new AbortController();
    let started: () => void = () => {};
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const pending = fetchOverpass(CHICAGO_LOOP, {
      fetchImpl,
      cache: new MemoryOverpassCache(),
      sleep: noSleep,
      signal: controller.signal,
    });
    await startedPromise;
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
