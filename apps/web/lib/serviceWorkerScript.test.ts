/**
 * `public/sw.js`, the shipped bytes, exercised in a sandbox.
 *
 * This is the OTHER half of `serviceWorker.test.ts`. That file covers the page
 * side -- whether to register, which URL, the update line. This one covers the
 * worker itself: 300 lines of cache policy that reach every visitor and, until
 * this file existed, had no automated test of any kind
 * (`docs/handoff/v3-08-siteperf.md` section 9).
 *
 * HOW. The worker is a plain script, not a module: it cannot be imported, and
 * `next dev` never registers it, so an e2e cannot reach it either
 * (`e2e/siteperf.spec.ts` drives the real thing in a real browser and is the
 * companion to this file). So the real source is read off disk and run in a
 * `node:vm` context holding hand-built `self`, `caches` and `fetch`. Nothing is
 * copied, transcribed or re-implemented here: a change to `public/sw.js` is a
 * change to what these tests run, which is the only arrangement in which they
 * can fail for the right reason.
 *
 * `Response` and `Headers` are the host's own (Node 22 has both), because a
 * fake of those would be testing the fake.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(path.resolve(__dirname, "..", "public", "sw.js"), "utf-8");

const ORIGIN = "https://framecraft.test";

// ---------------------------------------------------------------------------
// the host objects the worker reaches for
// ---------------------------------------------------------------------------

interface RequestLike {
  url: string;
  method: string;
  mode: string;
  destination: string;
  headers: Headers;
}

/** `cache.put`, `cache.delete` and `caches.match` all take either shape. */
type CacheKey = string | RequestLike;

function keyOf(key: CacheKey): string {
  return typeof key === "string" ? key : key.url;
}

/** Insertion-ordered, which is what `cache.keys()` promises and what `trim` relies on. */
class FakeCache {
  readonly entries: Array<{ key: string; response: Response }> = [];

  keys(): Promise<string[]> {
    return Promise.resolve(this.entries.map((entry) => entry.key));
  }

  put(key: CacheKey, response: Response): Promise<void> {
    const name = keyOf(key);
    const at = this.entries.findIndex((entry) => entry.key === name);
    if (at >= 0) this.entries.splice(at, 1);
    this.entries.push({ key: name, response });
    return Promise.resolve();
  }

  delete(key: CacheKey): Promise<boolean> {
    const name = keyOf(key);
    const at = this.entries.findIndex((entry) => entry.key === name);
    if (at < 0) return Promise.resolve(false);
    this.entries.splice(at, 1);
    return Promise.resolve(true);
  }

  find(key: CacheKey): Response | undefined {
    return this.entries.find((entry) => entry.key === keyOf(key))?.response;
  }
}

class FakeCacheStorage {
  readonly open_ = new Map<string, FakeCache>();

  open(name: string): Promise<FakeCache> {
    const existing = this.open_.get(name);
    if (existing !== undefined) return Promise.resolve(existing);
    const created = new FakeCache();
    this.open_.set(name, created);
    return Promise.resolve(created);
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.open_.keys()]);
  }

  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.open_.delete(name));
  }

  match(key: CacheKey, options?: { cacheName?: string }): Promise<Response | undefined> {
    const named = options?.cacheName;
    if (named !== undefined) return Promise.resolve(this.open_.get(named)?.find(key));
    for (const cache of this.open_.values()) {
      const hit = cache.find(key);
      if (hit !== undefined) return Promise.resolve(hit);
    }
    return Promise.resolve(undefined);
  }

  /** The keys held in one cache, or [] when the worker never opened it. */
  keysIn(name: string): string[] {
    return this.open_.get(name)?.entries.map((entry) => entry.key) ?? [];
  }
}

interface DispatchedEvent {
  responded: Promise<Response> | null;
  waited: Array<Promise<unknown>>;
}

type EventListener = (event: unknown) => void;

interface WorkerOptions {
  /** The worker's own script URL. Its `?v=` is the build id the worker reports. */
  href?: string;
  scope?: string;
  /**
   * What the network answers. Throw from here to model an offline origin, or
   * return a Promise to hold a response open across another event.
   */
  respond?: (url: string) => Response | Promise<Response>;
}

interface Worker {
  caches: FakeCacheStorage;
  /** Every URL the worker asked the network for, in order. */
  fetched: string[];
  /** Everything the worker posted to a window client. */
  toClients: unknown[];
  claims: number;
  skipWaitings: number;
  /** How many times the worker retired its own registration. */
  unregisters: number;
  install(): Promise<void>;
  activate(): Promise<void>;
  message(data: unknown): Promise<void>;
  fetchEvent(request: RequestLike): DispatchedEvent;
  /** Dispatch, wait for the response AND for whatever the worker held open. */
  serve(request: RequestLike): Promise<Response>;
}

function loadWorker(options: WorkerOptions = {}): Worker {
  const href = options.href ?? `${ORIGIN}/sw.js?v=build-1`;
  const scope = options.scope ?? `${ORIGIN}/`;
  const respond = options.respond ?? (() => new Response("payload", { status: 200 }));

  const cacheStorage = new FakeCacheStorage();
  const fetched: string[] = [];
  const toClients: unknown[] = [];
  const listeners = new Map<string, EventListener[]>();
  let claims = 0;
  let skipWaitings = 0;
  let unregisters = 0;

  const self = {
    // A real `WorkerLocation` carries both, and `sw.js` reads both: `href` for
    // the build id on its own script URL, `origin` for the same-origin gate.
    location: { href, origin: new URL(href).origin },
    registration: {
      scope,
      unregister(): Promise<boolean> {
        unregisters += 1;
        return Promise.resolve(true);
      },
    },
    addEventListener(type: string, listener: EventListener): void {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    skipWaiting(): void {
      skipWaitings += 1;
    },
    clients: {
      matchAll(): Promise<Array<{ postMessage(message: unknown): void }>> {
        return Promise.resolve([
          {
            postMessage(message: unknown): void {
              toClients.push(message);
            },
          },
        ]);
      },
      claim(): Promise<void> {
        claims += 1;
        return Promise.resolve();
      },
    },
  };

  const sandbox = {
    self,
    caches: cacheStorage,
    fetch(input: CacheKey): Promise<Response> {
      const url = keyOf(input);
      fetched.push(url);
      try {
        return Promise.resolve(respond(url));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    URL,
    Response,
    Headers,
  };

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: "public/sw.js" });

  const fire = async (type: string, event: { waited: Array<Promise<unknown>> }): Promise<void> => {
    for (const listener of listeners.get(type) ?? []) listener(event);
    await Promise.all(event.waited);
  };

  const lifecycle = (type: string): Promise<void> => {
    const event = { waited: [] as Array<Promise<unknown>>, waitUntil(promise: Promise<unknown>) { event.waited.push(promise); } };
    return fire(type, event);
  };

  const fetchEvent = (request: RequestLike): DispatchedEvent => {
    const event: DispatchedEvent & {
      request: RequestLike;
      respondWith(promise: Promise<Response>): void;
      waitUntil(promise: Promise<unknown>): void;
    } = {
      request,
      responded: null,
      waited: [],
      respondWith(promise: Promise<Response>): void {
        event.responded = promise;
      },
      waitUntil(promise: Promise<unknown>): void {
        event.waited.push(promise);
      },
    };
    for (const listener of listeners.get("fetch") ?? []) listener(event);
    return event;
  };

  return {
    caches: cacheStorage,
    fetched,
    toClients,
    get claims() {
      return claims;
    },
    get skipWaitings() {
      return skipWaitings;
    },
    get unregisters() {
      return unregisters;
    },
    install: () => lifecycle("install"),
    activate: () => lifecycle("activate"),
    message: async (data: unknown): Promise<void> => {
      const event = {
        data,
        waited: [] as Array<Promise<unknown>>,
        waitUntil(promise: Promise<unknown>) {
          event.waited.push(promise);
        },
      };
      for (const listener of listeners.get("message") ?? []) listener(event);
      await Promise.all(event.waited);
    },
    fetchEvent,
    serve: async (request: RequestLike): Promise<Response> => {
      const event = fetchEvent(request);
      expect(event.responded, `the worker did not answer ${request.url}`).not.toBeNull();
      const response = await (event.responded as Promise<Response>);
      await Promise.all(event.waited);
      return response;
    },
  };
}

function req(url: string, init: Partial<RequestLike> = {}): RequestLike {
  return {
    url,
    method: init.method ?? "GET",
    mode: init.mode ?? "no-cors",
    destination: init.destination ?? "script",
    headers: init.headers ?? new Headers(),
  };
}

function navigation(url: string): RequestLike {
  return req(url, { mode: "navigate", destination: "document" });
}

const CHUNK_CACHE = "framecraft-immutable-v1";
const PRESET_CACHE = "framecraft-presets-v1";
const DOCUMENT_CACHE = "framecraft-documents-v1";
const staticCache = (buildId: string): string => `framecraft-static-v1-${buildId}`;

const CHUNK = `${ORIGIN}/_next/static/chunks/main-abc123.js`;
const PRESET = `${ORIGIN}/presets/${"a".repeat(40)}.json.gz`;

// ---------------------------------------------------------------------------

describe("/_next/static/**: cache first, forever", () => {
  it("fetches a miss once, stores it, and never asks again", async () => {
    const worker = loadWorker();
    await worker.serve(req(CHUNK));
    expect(worker.fetched).toEqual([CHUNK]);
    expect(worker.caches.keysIn(CHUNK_CACHE)).toEqual([CHUNK]);

    const again = await worker.serve(req(CHUNK));
    expect(worker.fetched, "a content-hashed URL can never be stale").toEqual([CHUNK]);
    expect(again.status).toBe(200);
  });

  it("never caches a 404, and tells the page its build has left the origin", async () => {
    const worker = loadWorker({ respond: () => new Response("gone", { status: 404 }) });
    const response = await worker.serve(req(CHUNK));

    expect(response.status).toBe(404);
    expect(worker.caches.keysIn(CHUNK_CACHE), "a 404 must never become a cache entry").toEqual([]);
    expect(worker.toClients).toEqual([
      { type: "framecraft:update-ready", reason: "missing-chunk", buildId: "build-1" },
    ]);
  });

  it("drops the oldest entry once the 240-entry cap is passed", async () => {
    const worker = loadWorker();
    for (let i = 0; i < 241; i += 1) {
      await worker.serve(req(`${ORIGIN}/_next/static/chunks/c${i}.js`));
    }
    const held = worker.caches.keysIn(CHUNK_CACHE);
    expect(held).toHaveLength(240);
    expect(held, "oldest first").not.toContain(`${ORIGIN}/_next/static/chunks/c0.js`);
    expect(held).toContain(`${ORIGIN}/_next/static/chunks/c240.js`);
  });
});

describe("navigations: network first, cached document as the offline fallback", () => {
  it("asks the network every time, even holding a cached copy", async () => {
    const worker = loadWorker();
    await worker.serve(navigation(`${ORIGIN}/`));
    expect(worker.caches.keysIn(DOCUMENT_CACHE)).toEqual([`${ORIGIN}/`]);

    await worker.serve(navigation(`${ORIGIN}/`));
    expect(
      worker.fetched,
      "a Pages deploy replaces the whole tree, so a cached HTML can name chunks that are gone",
    ).toHaveLength(2);
  });

  it("serves the cached document when the network is gone", async () => {
    let offline = false;
    const worker = loadWorker({
      respond: () => {
        if (offline) throw new Error("network down");
        return new Response("<!doctype html>the app", { status: 200 });
      },
    });
    await worker.serve(navigation(`${ORIGIN}/`));
    offline = true;
    const response = await worker.serve(navigation(`${ORIGIN}/`));
    expect(await response.text()).toBe("<!doctype html>the app");
  });

  it("does not cache a document the origin did not serve", async () => {
    const worker = loadWorker({ respond: () => new Response("nope", { status: 500 }) });
    await worker.serve(navigation(`${ORIGIN}/`));
    expect(worker.caches.keysIn(DOCUMENT_CACHE)).toEqual([]);
  });
});

describe("the preset responses: their own cache, and never precached", () => {
  it("installs without touching the network or opening a cache", async () => {
    const worker = loadWorker();
    await worker.install();
    expect(worker.fetched, "1.7 MB per preset: nothing here is worth precaching").toEqual([]);
    expect(await worker.caches.keys()).toEqual([]);
  });

  it("keeps a fetched preset out of the chunk cache", async () => {
    const worker = loadWorker();
    await worker.serve(req(PRESET));
    expect(worker.caches.keysIn(PRESET_CACHE)).toEqual([PRESET]);
    expect(worker.caches.keysIn(CHUNK_CACHE)).toEqual([]);

    await worker.serve(req(PRESET));
    expect(worker.fetched).toHaveLength(1);
  });

  it("holds three presets, then drops the oldest", async () => {
    const worker = loadWorker();
    const names = ["a", "b", "c", "d"].map((letter) => `${ORIGIN}/presets/${letter.repeat(40)}.json.gz`);
    for (const name of names) await worker.serve(req(name));
    expect(worker.caches.keysIn(PRESET_CACHE)).toEqual(names.slice(1));
  });

  it("claims only the sha1-shaped name, so the manifest is somebody else's business", () => {
    const worker = loadWorker();
    for (const url of [
      `${ORIGIN}/presets/index.json`,
      `${ORIGIN}/presets/chicago-loop.json.gz`,
      `${ORIGIN}/presets/${"a".repeat(39)}.json.gz`,
    ]) {
      expect(worker.fetchEvent(req(url)).responded, `${url} is not a preset asset`).toBeNull();
    }
  });
});

describe("/manifold/**, /maplibre/** and the icons: stale while revalidate", () => {
  const WASM = `${ORIGIN}/manifold/manifold.wasm`;

  it("answers from the cache and refreshes behind it", async () => {
    let body = "first";
    const worker = loadWorker({ respond: () => new Response(body, { status: 200 }) });
    await worker.serve(req(WASM));
    expect(worker.caches.keysIn(staticCache("build-1"))).toEqual([WASM]);

    body = "second";
    const response = await worker.serve(req(WASM));
    expect(await response.text(), "the cached copy is served at once").toBe("first");
    expect(worker.fetched, "and the refresh really went out").toEqual([WASM, WASM]);
    const refreshed = await worker.caches.match(WASM, { cacheName: staticCache("build-1") });
    expect(await refreshed?.text()).toBe("second");
  });

  it("holds the refresh open with waitUntil, so a terminated worker cannot strand a stale entry", async () => {
    const worker = loadWorker();
    await worker.serve(req(WASM));
    const event = worker.fetchEvent(req(WASM));
    // The cached copy comes back first; the assertion is that the refresh
    // behind it was handed to the event rather than left running loose.
    await event.responded;
    expect(
      event.waited,
      "the background refresh must be held open with waitUntil",
    ).toHaveLength(1);
    await Promise.all(event.waited);
  });

  it("says 504 offline when there is nothing cached and no network", async () => {
    const worker = loadWorker({
      respond: () => {
        throw new Error("network down");
      },
    });
    const response = await worker.serve(req(WASM));
    expect(response.status).toBe(504);
  });
});

describe("the static cache is keyed by the build id, and only it is", () => {
  it("names the cache after the build the worker was registered for", async () => {
    const worker = loadWorker({ href: `${ORIGIN}/sw.js?v=build-7` });
    await worker.serve(req(`${ORIGIN}/icon.svg`));
    expect(await worker.caches.keys()).toEqual([staticCache("build-7")]);
  });

  it("leaves the content-addressed caches alone, because their URLs already carry a hash", async () => {
    const worker = loadWorker({ href: `${ORIGIN}/sw.js?v=build-7` });
    await worker.serve(req(CHUNK));
    await worker.serve(req(PRESET));
    expect(await worker.caches.keys()).toEqual([CHUNK_CACHE, PRESET_CACHE]);
  });

  it("retires the previous build's stable-URL copies on activate, and keeps the hashed ones", async () => {
    const worker = loadWorker({ href: `${ORIGIN}/sw.js?v=build-2` });
    // What a build-1 worker left behind.
    await worker.caches.open(staticCache("build-1"));
    await worker.caches.open(CHUNK_CACHE);
    await worker.caches.open(PRESET_CACHE);
    await worker.activate();

    expect(
      await worker.caches.keys(),
      "the previous build's stable-URL copies go; the content-addressed ones stay",
    ).toEqual([CHUNK_CACHE, PRESET_CACHE]);
    expect(worker.claims).toBe(1);

    // And this worker writes its own, under its own build id.
    await worker.serve(req(`${ORIGIN}/icon.svg`));
    expect(worker.caches.keysIn(staticCache("build-2"))).toEqual([`${ORIGIN}/icon.svg`]);
  });
});

describe("activate", () => {
  it("deletes framecraft caches it does not know and leaves everybody else's alone", async () => {
    const worker = loadWorker();
    await worker.caches.open("framecraft-immutable-v0");
    await worker.caches.open("some-other-app");
    await worker.activate();

    const remaining = await worker.caches.keys();
    expect(remaining).not.toContain("framecraft-immutable-v0");
    expect(remaining).toContain("some-other-app");
  });
});

describe("what the worker refuses to handle", () => {
  it("leaves non-GET, cross-origin, ranged and unclaimed requests to the network", () => {
    const worker = loadWorker();
    const untouched: Array<[string, RequestLike]> = [
      ["a POST", req(CHUNK, { method: "POST" })],
      ["an OSM tile", req("https://tile.openstreetmap.org/12/1/2.png")],
      ["an Overpass query", req("https://overpass-api.de/api/interpreter", { method: "POST" })],
      ["a ranged request", req(CHUNK, { headers: new Headers({ range: "bytes=0-1" }) })],
      ["a path no bucket claims", req(`${ORIGIN}/CREDITS.txt`)],
    ];
    for (const [what, request] of untouched) {
      expect(worker.fetchEvent(request).responded, `${what} must reach the network untouched`).toBeNull();
    }
    expect(worker.fetched).toEqual([]);
  });
});

describe("the warm-up", () => {
  it("adopts only the same-origin URLs its own buckets claim", async () => {
    const worker = loadWorker();
    await worker.message({
      type: "framecraft:warm",
      urls: [
        CHUNK,
        `${ORIGIN}/manifold/manifold.wasm`,
        `${ORIGIN}/CREDITS.txt`,
        "https://tile.openstreetmap.org/12/1/2.png",
        "not a url at all",
      ],
    });
    expect(worker.fetched.sort()).toEqual([`${ORIGIN}/manifold/manifold.wasm`, CHUNK].sort());
    expect(worker.caches.keysIn(CHUNK_CACHE)).toEqual([CHUNK]);
    expect(worker.caches.keysIn(staticCache("build-1"))).toEqual([`${ORIGIN}/manifold/manifold.wasm`]);
  });

  it("does not re-fetch what it already holds", async () => {
    const worker = loadWorker();
    await worker.serve(req(CHUNK));
    await worker.message({ type: "framecraft:warm", urls: [CHUNK] });
    expect(worker.fetched).toHaveLength(1);
  });

  it("is an optimisation: a warm that fails changes nothing", async () => {
    const worker = loadWorker({
      respond: () => {
        throw new Error("network down");
      },
    });
    await worker.message({ type: "framecraft:warm", urls: [CHUNK] });
    expect(worker.caches.keysIn(CHUNK_CACHE)).toEqual([]);
  });

  it("ignores a warm with no URL list, and any other message", async () => {
    const worker = loadWorker();
    await worker.message({ type: "framecraft:warm" });
    await worker.message({ type: "something-else" });
    await worker.message(null);
    expect(worker.fetched).toEqual([]);
    expect(worker.skipWaitings).toBe(0);
  });

  it("steps aside for the page's reload-to-update", async () => {
    const worker = loadWorker();
    await worker.message({ type: "framecraft:skip-waiting" });
    expect(worker.skipWaitings).toBe(1);
  });
});

describe("a sub-path deployment", () => {
  it("matches the same buckets under /framecraft/ as it does at the root", async () => {
    const worker = loadWorker({
      href: "https://naxhq.github.io/framecraft/sw.js?v=build-1",
      scope: "https://naxhq.github.io/framecraft/",
    });
    const base = "https://naxhq.github.io/framecraft";
    await worker.serve(req(`${base}/_next/static/chunks/main-abc123.js`));
    await worker.serve(req(`${base}/presets/${"a".repeat(40)}.json.gz`));
    await worker.serve(req(`${base}/maplibre/maplibre-gl-csp-worker.js`));

    expect(worker.caches.keysIn(CHUNK_CACHE)).toEqual([`${base}/_next/static/chunks/main-abc123.js`]);
    expect(worker.caches.keysIn(PRESET_CACHE)).toEqual([`${base}/presets/${"a".repeat(40)}.json.gz`]);
    expect(worker.caches.keysIn(staticCache("build-1"))).toEqual([
      `${base}/maplibre/maplibre-gl-csp-worker.js`,
    ]);
  });
});

describe("`?sw-off`: the worker's half of the kill switch", () => {
  /*
   * WHY THE WORKER HAS A HALF AT ALL. `registration.unregister()` stops a
   * worker claiming FUTURE clients. It does not evict the worker already
   * controlling open pages, which goes on handling every fetch until the last
   * tab holding it is unloaded. So the page-side teardown deleted the caches
   * and this worker refilled them from the page's own subresource loads --
   * measured on the real app, `framecraft-immutable-v1` was back within two
   * seconds of every teardown, which is what `e2e/siteperf.spec.ts` caught.
   */
  const KILL = { type: "framecraft:kill" };

  it("deletes the caches it owns, leaves another app's alone, unregisters, and says it has", async () => {
    const worker = loadWorker();
    await worker.serve(req(CHUNK));
    await worker.serve(req(`${ORIGIN}/icon.svg`, { destination: "image" }));
    await worker.caches.open("somebody-elses-cache");

    await worker.message(KILL);

    expect(await worker.caches.keys(), "a Pages user site can host more than one app").toEqual([
      "somebody-elses-cache",
    ]);
    expect(worker.unregisters).toBe(1);
    expect(worker.toClients).toContainEqual({ type: "framecraft:killed" });
  });

  it("stops intercepting, so the page it was retired from goes to the network itself", async () => {
    const worker = loadWorker();
    await worker.serve(req(CHUNK));
    await worker.message(KILL);

    // Not `serve`: the point is that nothing is answered at all.
    expect(worker.fetchEvent(req(CHUNK)).responded, "a retired worker answers nothing").toBeNull();
    expect(worker.fetchEvent(navigation(`${ORIGIN}/`)).responded).toBeNull();
  });

  it("cannot refill a swept cache from a response that was already in flight", async () => {
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const worker = loadWorker({ respond: (url) => (url === CHUNK ? held : new Response("payload")) });

    // A cache-first miss, with the network still open when the kill arrives.
    const inFlight = worker.fetchEvent(req(CHUNK));
    await worker.message(KILL);
    release(new Response("payload", { status: 200 }));
    await inFlight.responded;
    await Promise.all(inFlight.waited);

    expect(await worker.caches.keys(), "the write found the flag up and wrote nothing").toEqual([]);
  });

  it("ignores a warm-up that arrives after it was retired", async () => {
    const worker = loadWorker();
    await worker.message(KILL);
    await worker.message({ type: "framecraft:warm", urls: [CHUNK] });

    expect(worker.fetched).toEqual([]);
    expect(await worker.caches.keys()).toEqual([]);
  });
});
