import { describe, expect, it, vi } from "vitest";

import {
  MAX_WARM_URLS,
  SKIP_WAITING_MESSAGE,
  UPDATE_READY_MESSAGE,
  UPDATE_TOAST_ID,
  WARM_MESSAGE,
  registerServiceWorker,
  serviceWorkerUrl,
  shouldRegister,
  showUpdateToast,
  warmUrlsFrom,
  type ContainerLike,
  type DocumentLike,
  type ElementLike,
  type RegistrationLike,
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
  private readonly listeners: Array<() => void> = [];

  addEventListener(_type: "updatefound", listener: () => void): void {
    this.listeners.push(listener);
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

  controlledBy(): void {
    this.controller = { postMessage: (message: unknown) => this.controllerPosts.push(message) };
  }

  async register(url: string): Promise<RegistrationLike> {
    this.registered.push(url);
    if (this.failWith !== null) throw this.failWith;
    return this.registration;
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

describe("shouldRegister", () => {
  it("registers in a secure production browser", () => {
    expect(shouldRegister({ hasServiceWorker: true, isSecureContext: true, nodeEnv: "production" })).toBe(true);
  });

  it("never registers under `next dev`, where chunk URLs carry no content hash", () => {
    expect(shouldRegister({ hasServiceWorker: true, isSecureContext: true, nodeEnv: "development" })).toBe(false);
  });

  it("declines an insecure context and a browser without service workers", () => {
    expect(shouldRegister({ hasServiceWorker: true, isSecureContext: false, nodeEnv: "production" })).toBe(false);
    expect(shouldRegister({ hasServiceWorker: false, isSecureContext: true, nodeEnv: "production" })).toBe(false);
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
