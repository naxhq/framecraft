import { describe, expect, it, vi } from "vitest";

import {
  CACHE_PREFIX,
  DECISION_ATTRIBUTE,
  KILL_SWITCH_STORAGE_KEY,
  MAX_WARM_URLS,
  SKIP_WAITING_MESSAGE,
  UPDATE_READY_MESSAGE,
  UPDATE_TOAST_ID,
  WARM_MESSAGE,
  killSwitchState,
  markDecision,
  registerServiceWorker,
  registrationDecision,
  serviceWorkerUrl,
  shouldRegister,
  showUpdateToast,
  unregisterServiceWorkers,
  warmUrlsFrom,
  type ContainerLike,
  type DocumentLike,
  type ElementLike,
  type RegistrationLike,
  type StorageLike,
  type WorkerLike,
} from "./serviceWorker";

/*
 * This package's vitest environment is `node` and no jsdom is installed, so
 * the DOM and the ServiceWorkerContainer are hand-built here against the
 * structural interfaces `serviceWorker.ts` exports. They are small on purpose:
 * the only DOM behaviour the module depends on is create / append / remove /
 * getElementById / a click listener.
 */

class FakeElement implements ElementLike {
  className = "";
  textContent: string | null = null;
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  private readonly listeners = new Map<string, Array<() => void>>();
  removed = false;

  constructor(
    readonly tag: string,
    private readonly doc: FakeDocument,
  ) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") this.doc.register(value, this);
  }

  appendChild(child: unknown): unknown {
    this.children.push(child as FakeElement);
    return child;
  }

  remove(): void {
    this.removed = true;
    const id = this.attributes.get("id");
    if (id !== undefined) this.doc.unregister(id);
  }

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  /** Depth-first search for the first descendant whose text matches. */
  find(text: string): FakeElement | null {
    for (const child of this.children) {
      if (child.textContent === text) return child;
      const deeper = child.find(text);
      if (deeper !== null) return deeper;
    }
    return null;
  }
}

class FakeDocument implements DocumentLike {
  private readonly ids = new Map<string, FakeElement>();
  readonly bodyChildren: FakeElement[] = [];
  readonly body = {
    appendChild: (child: unknown): unknown => {
      this.bodyChildren.push(child as FakeElement);
      return child;
    },
  };

  createElement(tag: string): ElementLike {
    return new FakeElement(tag, this);
  }

  getElementById(id: string): ElementLike | null {
    const element = this.ids.get(id);
    return element === undefined || element.removed ? null : element;
  }

  register(id: string, element: FakeElement): void {
    this.ids.set(id, element);
  }

  unregister(id: string): void {
    this.ids.delete(id);
  }

  toast(): FakeElement | null {
    return (this.getElementById(UPDATE_TOAST_ID) as FakeElement | null) ?? null;
  }
}

class FakeWorker implements WorkerLike {
  state = "installing";
  readonly posted: unknown[] = [];
  private readonly listeners: Array<() => void> = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  addEventListener(_type: "statechange", listener: () => void): void {
    this.listeners.push(listener);
  }

  transitionTo(state: string): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

class FakeRegistration implements RegistrationLike {
  installing: WorkerLike | null = null;
  waiting: WorkerLike | null = null;
  unregistered = 0;
  /** What `unregister()` reports back: false is a worker that was already gone. */
  unregisterResult = true;
  private readonly listeners: Array<() => void> = [];

  addEventListener(_type: "updatefound", listener: () => void): void {
    this.listeners.push(listener);
  }

  async unregister(): Promise<boolean> {
    this.unregistered += 1;
    return this.unregisterResult;
  }

  updateFound(worker: FakeWorker): void {
    this.installing = worker;
    for (const listener of this.listeners) listener();
  }
}

class FakeContainer implements ContainerLike {
  controller: { postMessage(message: unknown): void } | null = null;
  readonly registration = new FakeRegistration();
  readonly registered: string[] = [];
  readonly controllerPosts: unknown[] = [];
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  failWith: Error | null = null;
  /** Set to make `register` RESOLVE with nothing, the way a stubbing harness does. */
  resolveWithNothing = false;
  /** What `getRegistrations()` hands back; defaults to this container's own one. */
  existing: FakeRegistration[] | null = null;

  controlledBy(): void {
    this.controller = { postMessage: (message: unknown) => this.controllerPosts.push(message) };
  }

  async register(url: string): Promise<RegistrationLike | undefined> {
    this.registered.push(url);
    if (this.failWith !== null) throw this.failWith;
    if (this.resolveWithNothing) return undefined;
    return this.registration;
  }

  async getRegistrations(): Promise<readonly RegistrationLike[]> {
    return this.existing ?? [this.registration];
  }

  addEventListener(type: "controllerchange" | "message", listener: (event: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: "controllerchange" | "message", data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

const BASE_OPTIONS = {
  resources: [{ name: "https://example.test/_next/static/chunks/a.js" }],
  origin: "https://example.test",
  basePath: "",
  buildId: "abc123",
};

/** A browser tab on a deployed build: every clause of the gate satisfied. */
const BROWSER_ENV = {
  hasServiceWorker: true,
  isSecureContext: true,
  nodeEnv: "production",
  isDesktopShell: false,
} as const;

describe("shouldRegister", () => {
  it("registers in a secure production browser", () => {
    expect(shouldRegister(BROWSER_ENV)).toBe(true);
  });

  it("never registers under `next dev`, where chunk URLs carry no content hash", () => {
    expect(shouldRegister({ ...BROWSER_ENV, nodeEnv: "development" })).toBe(false);
  });

  it("declines an insecure context and a browser without service workers", () => {
    expect(shouldRegister({ ...BROWSER_ENV, isSecureContext: false })).toBe(false);
    expect(shouldRegister({ ...BROWSER_ENV, hasServiceWorker: false })).toBe(false);
  });

  /**
   * The desktop shell passes every OTHER clause, which is exactly why this one
   * has to exist. `apps/desktop/src-tauri/tauri.conf.json` sets
   * `frontendDist: "../../web/out"`, so Tauri ships this same production
   * export with `sw.js` in it, over a secure-context custom protocol. Without
   * this line the worker installs inside the app and starts intercepting
   * local file reads for no possible gain.
   */
  it("never registers inside the Tauri desktop shell, whatever else is true", () => {
    expect(shouldRegister({ ...BROWSER_ENV, isDesktopShell: true })).toBe(false);
    // Not merely "because production": the shell is refused even when every
    // other clause is the most favourable value it can take.
    expect(
      shouldRegister({
        hasServiceWorker: true,
        isSecureContext: true,
        nodeEnv: "production",
        isDesktopShell: true,
      }),
    ).toBe(false);
  });
});

describe("registrationDecision", () => {
  it("names the reason, not just the verdict, for every environment", () => {
    expect(registrationDecision(BROWSER_ENV)).toBe("on");
    expect(registrationDecision({ ...BROWSER_ENV, nodeEnv: "development" })).toBe("off:dev");
    expect(registrationDecision({ ...BROWSER_ENV, isSecureContext: false })).toBe("off:insecure");
    expect(registrationDecision({ ...BROWSER_ENV, hasServiceWorker: false })).toBe("off:unsupported");
    expect(registrationDecision({ ...BROWSER_ENV, isDesktopShell: true })).toBe("off:tauri");
  });

  it("blames the desktop shell rather than anything downstream of it", () => {
    // The shell is a secure context running a production build, so the clause
    // order is what makes the reported reason true.
    expect(
      registrationDecision({ ...BROWSER_ENV, isDesktopShell: true, nodeEnv: "development" }),
    ).toBe("off:tauri");
  });

  it("agrees with `shouldRegister` on every one of them", () => {
    for (const env of [
      BROWSER_ENV,
      { ...BROWSER_ENV, nodeEnv: "development" },
      { ...BROWSER_ENV, isSecureContext: false },
      { ...BROWSER_ENV, hasServiceWorker: false },
      { ...BROWSER_ENV, isDesktopShell: true },
    ]) {
      expect(shouldRegister(env)).toBe(registrationDecision(env) === "on");
    }
  });
});

describe("markDecision", () => {
  it("writes the decision where a browser test can read it", () => {
    const sink: { dataset: Record<string, string | undefined> } = { dataset: {} };
    markDecision(sink, "off:dev");
    expect(sink.dataset[DECISION_ATTRIBUTE]).toBe("off:dev");
    markDecision(sink, "on");
    expect(sink.dataset[DECISION_ATTRIBUTE]).toBe("on");
  });

  it("does nothing without a document, rather than throwing on a prerender", () => {
    expect(() => markDecision(null, "on")).not.toThrow();
  });
});

describe("serviceWorkerUrl", () => {
  it("serves the worker from the deployment's own base path", () => {
    expect(serviceWorkerUrl("", "abc")).toBe("/sw.js?v=abc");
    expect(serviceWorkerUrl("/framecraft", "abc")).toBe("/framecraft/sw.js?v=abc");
  });

  it("omits the version when there is no build id, so a bare dev build still resolves", () => {
    expect(serviceWorkerUrl("/framecraft", "")).toBe("/framecraft/sw.js");
  });

  it("escapes a build id that is not URL-safe", () => {
    expect(serviceWorkerUrl("", "a b&c")).toBe("/sw.js?v=a%20b%26c");
  });
});

describe("warmUrlsFrom", () => {
  it("keeps same-origin resources and drops everything else", () => {
    const urls = warmUrlsFrom(
      [
        { name: "https://example.test/_next/static/chunks/a.js" },
        { name: "https://tile.openstreetmap.org/12/1/2.png" },
        { name: "https://overpass-api.de/api/interpreter" },
        { name: "data:text/plain,inline" },
      ],
      "https://example.test",
    );
    expect(urls).toEqual(["https://example.test/_next/static/chunks/a.js"]);
  });

  it("deduplicates and caps the list", () => {
    const entries = [{ name: "https://example.test/a.js" }, { name: "https://example.test/a.js" }];
    expect(warmUrlsFrom(entries, "https://example.test")).toHaveLength(1);

    const many = Array.from({ length: MAX_WARM_URLS + 40 }, (_, i) => ({ name: `https://example.test/${i}.js` }));
    expect(warmUrlsFrom(many, "https://example.test")).toHaveLength(MAX_WARM_URLS);
  });
});

describe("showUpdateToast", () => {
  it("renders one dismissible toast with a working reload action", () => {
    const doc = new FakeDocument();
    const onReload = vi.fn();
    const toast = showUpdateToast(doc, onReload) as FakeElement;

    expect(toast.attributes.get("role")).toBe("status");
    expect(doc.bodyChildren).toHaveLength(1);
    const reload = toast.find("Reload");
    expect(reload).not.toBeNull();
    reload?.fire("click");
    expect(onReload).toHaveBeenCalledTimes(1);

    toast.find("Later")?.fire("click");
    expect(toast.removed).toBe(true);
    expect(doc.getElementById(UPDATE_TOAST_ID)).toBeNull();
  });

  it("never stacks a second toast on top of the first", () => {
    const doc = new FakeDocument();
    const first = showUpdateToast(doc, vi.fn());
    const second = showUpdateToast(doc, vi.fn());
    expect(second).toBe(first);
    expect(doc.bodyChildren).toHaveLength(1);
  });

  it("does nothing before there is a body to put it in", () => {
    const doc: DocumentLike = {
      createElement: (tag) => new FakeElement(tag, new FakeDocument()),
      getElementById: () => null,
      body: null,
    };
    expect(showUpdateToast(doc, vi.fn())).toBeNull();
  });
});

describe("registerServiceWorker", () => {
  it("registers the versioned worker URL under the base path", async () => {
    const container = new FakeContainer();
    const doc = new FakeDocument();
    await registerServiceWorker({
      ...BASE_OPTIONS,
      container,
      doc,
      reload: vi.fn(),
      basePath: "/framecraft",
    });
    expect(container.registered).toEqual(["/framecraft/sw.js?v=abc123"]);
  });

  it("resolves null and shows nothing when registration is refused", async () => {
    const container = new FakeContainer();
    container.failWith = new Error("SecurityError");
    const doc = new FakeDocument();
    const result = await registerServiceWorker({ ...BASE_OPTIONS, container, doc, reload: vi.fn() });
    expect(result).toBeNull();
    expect(doc.toast()).toBeNull();
  });

  it("hands the controlling worker the same-origin URLs this load already fetched", async () => {
    const container = new FakeContainer();
    container.controlledBy();
    await registerServiceWorker({
      ...BASE_OPTIONS,
      container,
      doc: new FakeDocument(),
      reload: vi.fn(),
      resources: [{ name: "https://example.test/_next/static/chunks/a.js" }, { name: "https://tile.openstreetmap.org/1.png" }],
    });
    expect(container.controllerPosts).toEqual([
      { type: WARM_MESSAGE, urls: ["https://example.test/_next/static/chunks/a.js"] },
    ]);
  });

  it("waits for the first-ever worker to claim the page before warming it", async () => {
    const container = new FakeContainer();
    await registerServiceWorker({ ...BASE_OPTIONS, container, doc: new FakeDocument(), reload: vi.fn() });
    expect(container.controllerPosts).toEqual([]);

    container.controlledBy();
    container.emit("controllerchange");
    expect(container.controllerPosts).toEqual([
      { type: WARM_MESSAGE, urls: ["https://example.test/_next/static/chunks/a.js"] },
    ]);
  });

  it("stays silent on a first install: an update notice with nothing to update is a lie", async () => {
    const container = new FakeContainer();
    const doc = new FakeDocument();
    await registerServiceWorker({ ...BASE_OPTIONS, container, doc, reload: vi.fn() });

    const worker = new FakeWorker();
    container.registration.updateFound(worker);
    worker.transitionTo("installed");
    expect(doc.toast()).toBeNull();
  });

  it("offers the reload once a new worker has installed behind the one in charge", async () => {
    const container = new FakeContainer();
    container.controlledBy();
    const doc = new FakeDocument();
    const reload = vi.fn();
    await registerServiceWorker({ ...BASE_OPTIONS, container, doc, reload });

    const worker = new FakeWorker();
    container.registration.updateFound(worker);
    worker.transitionTo("installing");
    expect(doc.toast()).toBeNull();

    worker.transitionTo("installed");
    const toast = doc.toast();
    expect(toast).not.toBeNull();

    container.registration.waiting = worker;
    toast?.find("Reload")?.fire("click");
    expect(worker.posted).toEqual([{ type: SKIP_WAITING_MESSAGE }]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("offers the reload when a worker already sat waiting before this load", async () => {
    const container = new FakeContainer();
    container.controlledBy();
    container.registration.waiting = new FakeWorker();
    const doc = new FakeDocument();
    await registerServiceWorker({ ...BASE_OPTIONS, container, doc, reload: vi.fn() });
    expect(doc.toast()).not.toBeNull();
  });

  it("offers the reload when the worker reports a chunk the origin no longer serves", async () => {
    const container = new FakeContainer();
    container.controlledBy();
    const doc = new FakeDocument();
    await registerServiceWorker({ ...BASE_OPTIONS, container, doc, reload: vi.fn() });
    expect(doc.toast()).toBeNull();

    container.emit("message", { type: UPDATE_READY_MESSAGE, reason: "missing-chunk" });
    expect(doc.toast()).not.toBeNull();
  });

  it("ignores an unrelated message from the worker", async () => {
    const container = new FakeContainer();
    container.controlledBy();
    const doc = new FakeDocument();
    await registerServiceWorker({ ...BASE_OPTIONS, container, doc, reload: vi.fn() });
    container.emit("message", { type: "something-else" });
    container.emit("message", undefined);
    expect(doc.toast()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the kill switch
// ---------------------------------------------------------------------------

/** `localStorage`, small enough to see all of. */
class FakeStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  /** Set to make every access throw, the way a sandboxed iframe does. */
  throws = false;

  getItem(key: string): string | null {
    if (this.throws) throw new Error("storage is not available");
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.throws) throw new Error("storage is not available");
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    if (this.throws) throw new Error("storage is not available");
    this.map.delete(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }
}

/** `caches`, holding names only: the kill switch never reads a body. */
class FakeCaches {
  constructor(private names: string[]) {}
  readonly deleted: string[] = [];

  async keys(): Promise<readonly string[]> {
    return [...this.names];
  }

  async delete(name: string): Promise<boolean> {
    if (!this.names.includes(name)) return false;
    this.names = this.names.filter((entry) => entry !== name);
    this.deleted.push(name);
    return true;
  }
}

describe("killSwitchState", () => {
  const url = (query: string): string => `https://example.test/framecraft/${query}`;

  it("is off on an ordinary load, and asks storage for nothing it did not put there", () => {
    const storage = new FakeStorage();
    expect(killSwitchState(url(""), storage)).toBe("off");
    expect(storage.has(KILL_SWITCH_STORAGE_KEY)).toBe(false);
  });

  it("`?sw-off` turns it on AND remembers it, so the next load is clean too", () => {
    const storage = new FakeStorage();
    expect(killSwitchState(url("?sw-off"), storage)).toBe("on");
    expect(storage.has(KILL_SWITCH_STORAGE_KEY)).toBe(true);
    // The whole point: no query string this time, and it is still off.
    expect(killSwitchState(url(""), storage)).toBe("on");
  });

  it("`?sw-on` puts it back and forgets the flag", () => {
    const storage = new FakeStorage();
    killSwitchState(url("?sw-off"), storage);
    expect(killSwitchState(url("?sw-on"), storage)).toBe("off");
    expect(storage.has(KILL_SWITCH_STORAGE_KEY)).toBe(false);
    expect(killSwitchState(url(""), storage)).toBe("off");
  });

  it("kills rather than revives when a link carries both", () => {
    // The safe direction: someone pasting a recovery link with a stale
    // parameter still gets the recovery.
    expect(killSwitchState(url("?sw-on&sw-off"), new FakeStorage())).toBe("on");
  });

  it("still honours the query string when storage throws, and never throws itself", () => {
    const storage = new FakeStorage();
    storage.throws = true;
    expect(killSwitchState(url("?sw-off"), storage)).toBe("on");
    expect(killSwitchState(url(""), storage)).toBe("off");
    expect(killSwitchState(url(""), null)).toBe("off");
  });

  it("treats an unparseable href as no query rather than failing", () => {
    expect(killSwitchState("not a url", new FakeStorage())).toBe("off");
  });
});

describe("unregisterServiceWorkers", () => {
  it("unregisters every worker and deletes every cache this app owns", async () => {
    const container = new FakeContainer();
    const second = new FakeRegistration();
    container.existing = [container.registration, second];
    const caches = new FakeCaches([
      `${CACHE_PREFIX}immutable-v1`,
      `${CACHE_PREFIX}presets-v1`,
      "someone-elses-cache",
    ]);

    const outcome = await unregisterServiceWorkers(container, caches);

    expect(outcome.workers).toBe(2);
    expect(container.registration.unregistered).toBe(1);
    expect(second.unregistered).toBe(1);
    // Only ours. A Pages user site can host more than one app on one origin,
    // and the other one's data is not this switch's to delete.
    expect(caches.deleted.sort()).toEqual([`${CACHE_PREFIX}immutable-v1`, `${CACHE_PREFIX}presets-v1`]);
    expect(outcome.caches).toHaveLength(2);
    expect(await caches.keys()).toEqual(["someone-elses-cache"]);
  });

  it("counts only the workers that really went", async () => {
    const container = new FakeContainer();
    container.registration.unregisterResult = false;
    const outcome = await unregisterServiceWorkers(container, new FakeCaches([]));
    expect(container.registration.unregistered).toBe(1);
    expect(outcome.workers).toBe(0);
  });

  it("survives a container that refuses to enumerate, and still clears the caches", async () => {
    const container: Pick<ContainerLike, "getRegistrations"> = {
      getRegistrations: () => Promise.reject(new Error("denied")),
    };
    const caches = new FakeCaches([`${CACHE_PREFIX}static-v1`]);
    const outcome = await unregisterServiceWorkers(container, caches);
    expect(outcome.workers).toBe(0);
    expect(outcome.caches).toEqual([`${CACHE_PREFIX}static-v1`]);
  });

  it("survives a browser with no cache storage at all", async () => {
    const container = new FakeContainer();
    const outcome = await unregisterServiceWorkers(container, null);
    expect(outcome.workers).toBe(1);
    expect(outcome.caches).toEqual([]);
  });
});

describe("registerServiceWorker fails soft", () => {
  it("returns null when `register` rejects", async () => {
    const container = new FakeContainer();
    container.failWith = new Error("workers are not allowed here");
    const doc = new FakeDocument();
    expect(await registerServiceWorker({ ...BASE_OPTIONS, container, doc, reload: vi.fn() })).toBeNull();
    expect(doc.toast()).toBeNull();
  });

  /**
   * The DOM types say this cannot happen; Playwright's `serviceWorkers:
   * "block"` does it anyway, and reading `.waiting` off the result threw an
   * uncaught TypeError into the page twice per load in every worker-blocked
   * run of the byte measurements in `docs/handoff/v3-08-siteperf.md`.
   */
  it("returns null when `register` RESOLVES with nothing, instead of throwing into the page", async () => {
    const container = new FakeContainer();
    container.resolveWithNothing = true;
    const doc = new FakeDocument();
    await expect(
      registerServiceWorker({ ...BASE_OPTIONS, container, doc, reload: vi.fn() }),
    ).resolves.toBeNull();
    expect(container.registered).toHaveLength(1);
    expect(doc.toast()).toBeNull();
  });
});
