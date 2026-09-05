/**
 * Registration, warm-up and the update affordance for `public/sw.js`.
 *
 * The worker itself is a plain script served from `public/` (it cannot be
 * bundled: a service worker has to be a top-level file at the scope it
 * controls). This module is the page half: it decides WHETHER to register,
 * builds the registration URL, hands the worker the assets the first load
 * already fetched, and puts a "reload to update" line on screen when a newer
 * build is waiting.
 *
 * Why the seams. Every exported function takes its host objects as arguments
 * with minimal structural types rather than reaching for the globals, because
 * this package's vitest environment is `node`: there is no `document`, no
 * `navigator.serviceWorker` and no jsdom to fake them. The real DOM objects
 * satisfy these interfaces, so the app passes the genuine ones and the tests
 * pass small fakes, with no `any` and no cast on either side.
 */
import { BASE_PATH } from "./basePath";
import { isTauri } from "./platform";

/** The build this bundle came from; `next.config.ts` inlines it. Empty in a bare `next dev`. */
export const BUILD_ID: string = process.env.NEXT_PUBLIC_BUILD_ID ?? "";

export const UPDATE_READY_MESSAGE = "framecraft:update-ready";
export const SKIP_WAITING_MESSAGE = "framecraft:skip-waiting";
export const WARM_MESSAGE = "framecraft:warm";
/** `?sw-off` telling the controlling worker to stand down, and the worker saying it has. */
export const KILL_MESSAGE = "framecraft:kill";
export const KILLED_MESSAGE = "framecraft:killed";

/**
 * How long the teardown waits for that acknowledgement before sweeping anyway.
 *
 * A worker that never answers is exactly the worker `?sw-off` exists for, so
 * this can only ever be a bound, never a requirement: past it the page carries
 * on and does what it did before this handshake existed.
 */
export const KILL_ACK_TIMEOUT_MS = 2_000;

/** The most Resource Timing entries one warm message will carry. A cold load has 33. */
export const MAX_WARM_URLS = 120;

export const UPDATE_TOAST_ID = "fc-update-toast";

/**
 * The kill switch.
 *
 * A worker that ships with a caching bug cannot be retired the way an ordinary
 * bug is: the broken worker is the thing serving the page, so a fix reaches a
 * visitor only if the worker it replaces lets it. `?sw-off` is the escape
 * hatch that needs no deploy. It unregisters every worker on this origin,
 * deletes every `framecraft-` cache, and REMEMBERS the choice in
 * `localStorage`, so the next load is clean too rather than re-registering the
 * moment the query string is dropped. `?sw-on` puts it back.
 *
 * Documented in RUNBOOK.md and in `docs/handoff/v3-08-siteperf.md`.
 */
export const KILL_SWITCH_QUERY = "sw-off";
export const REVIVE_QUERY = "sw-on";
export const KILL_SWITCH_STORAGE_KEY = "framecraft.sw.off";
/** Every cache this app owns starts with this, and nothing else may be deleted. */
export const CACHE_PREFIX = "framecraft-";

// ---------------------------------------------------------------------------
// structural seams
// ---------------------------------------------------------------------------

export interface WorkerLike {
  state: string;
  postMessage(message: unknown): void;
  addEventListener(type: "statechange", listener: () => void): void;
}

export interface RegistrationLike {
  installing: WorkerLike | null;
  waiting: WorkerLike | null;
  addEventListener(type: "updatefound", listener: () => void): void;
  unregister(): Promise<boolean>;
}

export interface ContainerLike {
  controller: { postMessage(message: unknown): void } | null;
  /**
   * `undefined` is not in the DOM's own signature and is accepted anyway: a
   * harness that stubs this (Playwright's `serviceWorkers: "block"`) resolves
   * with nothing, and the caller has to survive it rather than throw into the
   * page.
   */
  register(url: string): Promise<RegistrationLike | undefined>;
  addEventListener(type: "controllerchange" | "message", listener: (event: { data?: unknown }) => void): void;
  getRegistrations(): Promise<readonly RegistrationLike[]>;
}

/** Just the two `caches` methods the kill switch uses. */
export interface CacheStorageLike {
  keys(): Promise<readonly string[]>;
  delete(cacheName: string): Promise<boolean>;
}

/** Just the three `localStorage` methods the kill switch uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/*
 * `appendChild` takes `unknown` on purpose, in both interfaces below.
 *
 * The DOM declares it as `<T extends Node>(node: T) => T`, and a structural
 * type that says `(child: ElementLike) => void` is assignable in NEITHER
 * direction: `ElementLike` is not a `Node` and `Node` has none of these
 * members. Widening the parameter to `unknown` makes the real `HTMLElement`
 * satisfy the interface without a cast anywhere, at the cost of not checking
 * what is appended -- which is a cost paid inside one function that only ever
 * appends elements it just created.
 */
export interface ElementLike {
  className: string;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  appendChild(child: unknown): unknown;
  remove(): void;
  addEventListener(type: string, listener: () => void): void;
}

export interface DocumentLike {
  createElement(tag: string): ElementLike;
  getElementById(id: string): ElementLike | null;
  body: { appendChild(child: unknown): unknown } | null;
}

/** Just the `name` of a Resource Timing entry, which is the resource URL. */
export interface TimedResource {
  name: string;
}

// ---------------------------------------------------------------------------
// pure decisions
// ---------------------------------------------------------------------------

/**
 * Why this page has a worker, or why it has not.
 *
 * `off:killed` is the kill switch; the other four are the environments the
 * worker deliberately stays out of, in the order `registrationDecision` asks
 * about them.
 */
export type RegistrationDecision =
  | "on"
  | "off:killed"
  | "off:tauri"
  | "off:dev"
  | "off:insecure"
  | "off:unsupported";

/** The `data-fc-sw` dataset key `installServiceWorker` writes its decision to. */
export const DECISION_ATTRIBUTE = "fcSw";

export interface RegistrationEnvironment {
  /** `"serviceWorker" in navigator` */
  hasServiceWorker: boolean;
  /** `window.isSecureContext`: https, or localhost over http. */
  isSecureContext: boolean;
  /** `process.env.NODE_ENV`. */
  nodeEnv: string;
  /** `isTauri()`: running inside the desktop shell rather than a browser tab. */
  isDesktopShell: boolean;
}

/**
 * Whether to register at all.
 *
 * Development is excluded deliberately and permanently. `next dev` serves
 * `_next/static` chunks whose URLs are NOT content-hashed, so the worker's
 * cache-first rule would answer an edited chunk with the previous one and
 * break Fast Refresh. The production export is the only build whose asset URLs
 * carry a content hash, which is the whole premise of the cache policy.
 *
 * The DESKTOP SHELL is excluded for a different reason, and it is not
 * optional. `apps/desktop/src-tauri/tauri.conf.json` points `frontendDist` at
 * `apps/web/out`, so the shell ships this exact static export -- `sw.js`
 * included -- runs the production build, and serves it over a custom protocol
 * that WebView2 treats as a secure context. Every other clause here therefore
 * passes inside Tauri, and the worker would install and start intercepting the
 * shell's own asset reads. There is nothing there for it to win: the desktop
 * bundle reads its files off local disk with no network and no cache lifetime
 * to extend, so all a worker adds is a second copy of the bundle in Cache
 * Storage and a class of bug that can only be cleared from inside the app.
 */
export function shouldRegister(env: RegistrationEnvironment): boolean {
  return registrationDecision(env) === "on";
}

/**
 * What this environment decided, and WHY, in one token.
 *
 * `shouldRegister` answers yes or no, which is all the caller needs and not
 * enough for anyone looking at a page that has no worker: "off" and "never
 * asked" are different states and only one of them is a defect. The reason is
 * written to `data-fc-sw` on the document element (`markDecision` below), next
 * to `data-fc-ready`, so `e2e/siteperf.spec.ts` can tell the deliberate
 * `next dev` opt-out from a page that stopped calling this module at all.
 *
 * The clause order is the reason order, not a behaviour: the desktop shell is
 * also a secure context running a production build, so it would otherwise
 * report "on" and the honest answer is "tauri".
 */
export function registrationDecision(env: RegistrationEnvironment): RegistrationDecision {
  if (!env.hasServiceWorker) return "off:unsupported";
  if (env.isDesktopShell) return "off:tauri";
  if (!env.isSecureContext) return "off:insecure";
  if (env.nodeEnv === "development") return "off:dev";
  return "on";
}

/** Just `document.documentElement`'s `dataset`, which is a `DOMStringMap`. */
export interface DecisionSink {
  dataset: Record<string, string | undefined>;
}

/** Record the decision where a browser test can read it. */
export function markDecision(sink: DecisionSink | null, decision: RegistrationDecision): void {
  if (sink === null) return;
  sink.dataset[DECISION_ATTRIBUTE] = decision;
}

// ---------------------------------------------------------------------------
// the kill switch
// ---------------------------------------------------------------------------

/** What this load asks of the worker, read from the URL and the remembered flag. */
export type KillSwitchState = "off" | "on";

/**
 * Read the kill switch, and let this load's query string change it.
 *
 * `?sw-off` turns it on and remembers it; `?sw-on` turns it off and forgets
 * it; with neither, the remembered flag decides. Remembering is the whole
 * point: a visitor sent `?sw-off` by a maintainer must stay clean on the next
 * navigation, when the query string is gone and the broken worker would
 * otherwise be re-registered by the very next line of this module.
 *
 * Storage access can throw outright in a sandboxed iframe or a browser set to
 * block site data, so every touch is guarded and a failure reads as "not
 * asked" rather than taking the app down.
 */
export function killSwitchState(href: string, storage: StorageLike | null): KillSwitchState {
  let query: URLSearchParams;
  try {
    query = new URL(href).searchParams;
  } catch {
    query = new URLSearchParams();
  }
  const asked = query.has(KILL_SWITCH_QUERY);
  const revoked = query.has(REVIVE_QUERY);
  try {
    if (asked) {
      storage?.setItem(KILL_SWITCH_STORAGE_KEY, "1");
      return "on";
    }
    if (revoked) {
      storage?.removeItem(KILL_SWITCH_STORAGE_KEY);
      return "off";
    }
    if (storage === null) return "off";
    return storage.getItem(KILL_SWITCH_STORAGE_KEY) === null ? "off" : "on";
  } catch {
    // The query string still decides even when storage is unavailable; it just
    // cannot be remembered past this navigation.
    return asked ? "on" : "off";
  }
}

/** The half of the container `silenceController` needs: who is in charge, and a way to hear back. */
export type ControllerChannel = Pick<ContainerLike, "controller" | "addEventListener">;

/**
 * Tell the worker CONTROLLING this page to stand down, and wait until it says
 * it has.
 *
 * This is the step without which the kill switch does not kill.
 * `registration.unregister()` stops a worker claiming future clients; it does
 * NOT evict the worker already controlling open pages, which keeps handling
 * every fetch of this very page until the last tab holding it is unloaded. So
 * the old teardown deleted the caches and the still-live worker refilled them
 * from the page's own subresource loads -- measured on the real app, the chunk
 * cache was back within two seconds, every run.
 *
 * `sw.js` answers by going inert (no interception, no writes), deleting the
 * `framecraft-` caches itself and unregistering, then posting
 * `framecraft:killed`. Waiting for that is what orders the two halves: the
 * page's own sweep below then runs against a worker that can no longer write.
 *
 * Resolves false when there is nothing to silence, when the worker does not
 * answer inside `timeoutMs`, or when posting throws -- all of which leave the
 * caller doing exactly what it did before, which is the honest fallback for a
 * switch whose whole purpose is broken workers.
 */
export async function silenceController(
  container: ControllerChannel,
  timeoutMs: number = KILL_ACK_TIMEOUT_MS,
): Promise<boolean> {
  const controller = container.controller;
  if (controller === null) return false;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    try {
      container.addEventListener("message", (event) => {
        const data = event.data;
        if (typeof data === "object" && data !== null && "type" in data && data.type === KILLED_MESSAGE) {
          done();
        }
      });
      controller.postMessage({ type: KILL_MESSAGE });
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

/**
 * Retire every worker this origin has, and every cache this app owns.
 *
 * The controlling worker is silenced FIRST (`silenceController`), because
 * unregistering does not stop it and a live worker refills a swept cache from
 * the page's own loads.
 *
 * Deliberately NOT `caches.keys()` wholesale: only names starting with
 * `framecraft-` are deleted, so a worker from something else sharing the
 * origin (a Pages user site with more than one app on it) keeps its own data.
 *
 * Returns what it removed, so the caller can say so and a test can assert it.
 */
export async function unregisterServiceWorkers(
  container: Pick<ContainerLike, "getRegistrations"> & ControllerChannel,
  cacheStorage: CacheStorageLike | null,
): Promise<{ workers: number; caches: string[] }> {
  await silenceController(container);
  let workers = 0;
  try {
    const registrations = await container.getRegistrations();
    for (const registration of registrations) {
      if (await registration.unregister()) workers += 1;
    }
  } catch {
    // Nothing to do about it, and nothing this should take down.
  }
  const removed: string[] = [];
  if (cacheStorage !== null) {
    try {
      for (const name of await cacheStorage.keys()) {
        if (!name.startsWith(CACHE_PREFIX)) continue;
        if (await cacheStorage.delete(name)) removed.push(name);
      }
    } catch {
      // Same.
    }
  }
  return { workers, caches: removed };
}

/**
 * The registration URL: the worker file under this deployment's base path,
 * carrying the build id.
 *
 * The `?v=` is what makes a deploy visible to the browser. The worker's bytes
 * rarely change, so registering the bare path would leave a visitor on the
 * worker they installed months ago; a new build id is a new script URL, which
 * installs a new worker and (while an old one still controls open tabs) parks
 * it in `waiting`, which is the state the update line reports.
 */
export function serviceWorkerUrl(basePath: string, buildId: string): string {
  const path = basePath === "" ? "/sw.js" : `${basePath}/sw.js`;
  return buildId === "" ? path : `${path}?v=${encodeURIComponent(buildId)}`;
}

/**
 * The same-origin URLs from a page's Resource Timing worth handing to the
 * worker.
 *
 * Deliberately coarse: this side filters by origin and count only, and
 * `sw.js`'s `bucketFor` decides what it will actually hold. One matcher, in
 * one file, cannot drift from itself.
 */
export function warmUrlsFrom(entries: readonly TimedResource[], origin: string): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.size >= MAX_WARM_URLS) break;
    let url: URL;
    try {
      url = new URL(entry.name, origin);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    seen.add(url.href);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// the update affordance
// ---------------------------------------------------------------------------

/**
 * The "a new version is ready" line, built from design tokens only.
 *
 * It is created here rather than in a component because a service worker
 * update can land at any moment, including before React has mounted, and
 * because this affordance must not depend on the editor's state tree. It is
 * idempotent: a second call while the line is on screen returns the existing
 * element instead of stacking another one.
 */
export function showUpdateToast(doc: DocumentLike, onReload: () => void): ElementLike | null {
  const existing = doc.getElementById(UPDATE_TOAST_ID);
  if (existing !== null) return existing;
  if (doc.body === null) return null;

  const toast = doc.createElement("div");
  toast.setAttribute("id", UPDATE_TOAST_ID);
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.className =
    "fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-md border border-line-strong bg-plate-raised px-4 py-2 text-xs text-ink shadow-lg";

  const label = doc.createElement("span");
  label.textContent = "A newer version of FrameCraft is ready.";
  toast.appendChild(label);

  const reload = doc.createElement("button");
  reload.setAttribute("type", "button");
  reload.className =
    "rounded border border-control px-2 py-1 text-2xs text-ink hover:border-control-strong hover:bg-plate-sunken";
  reload.textContent = "Reload";
  reload.addEventListener("click", onReload);
  toast.appendChild(reload);

  const dismiss = doc.createElement("button");
  dismiss.setAttribute("type", "button");
  dismiss.setAttribute("aria-label", "Dismiss the update notice");
  dismiss.className = "text-2xs text-ink-faint hover:text-ink";
  dismiss.textContent = "Later";
  dismiss.addEventListener("click", () => toast.remove());
  toast.appendChild(dismiss);

  doc.body.appendChild(toast);
  return toast;
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export interface RegisterOptions {
  container: ContainerLike;
  doc: DocumentLike;
  /** Called when the user asks for the new build. The app passes `() => location.reload()`. */
  reload: () => void;
  /** Resource Timing entries of the load that is registering, for the warm-up. */
  resources: readonly TimedResource[];
  origin: string;
  basePath?: string;
  buildId?: string;
}

/**
 * Register the worker, warm it with what this load already fetched, and wire
 * the update line.
 *
 * Fails soft in every direction: a rejected `register` (an origin that
 * forbids workers, a browser with the feature disabled) resolves to null and
 * the app runs exactly as it did before, straight off the network. So does a
 * `register` that RESOLVES with nothing, which the DOM types say cannot
 * happen and a test harness that stubs `navigator.serviceWorker` does anyway
 * (Playwright's `serviceWorkers: "block"`): reading `.waiting` off it threw an
 * uncaught `TypeError` into the page, twice per load, in every
 * worker-blocked run of the byte measurements in
 * `docs/handoff/v3-08-siteperf.md`.
 */
export async function registerServiceWorker(options: RegisterOptions): Promise<RegistrationLike | null> {
  const basePath = options.basePath ?? BASE_PATH;
  const buildId = options.buildId ?? BUILD_ID;

  let registration: RegistrationLike;
  try {
    const registered = await options.container.register(serviceWorkerUrl(basePath, buildId));
    if (registered === undefined || registered === null) return null;
    registration = registered;
  } catch {
    return null;
  }

  const announce = (): void => {
    showUpdateToast(options.doc, () => {
      // Ask the waiting worker to take over, then reload onto it. Reloading
      // without this would just start the old worker again.
      const waiting = registration.waiting;
      if (waiting !== null) waiting.postMessage({ type: SKIP_WAITING_MESSAGE });
      options.reload();
    });
  };

  // A worker that is already waiting when this page loads: a deploy landed
  // between two visits and the previous worker is still in charge.
  if (registration.waiting !== null && options.container.controller !== null) {
    announce();
  }

  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (installing === null) return;
    installing.addEventListener("statechange", () => {
      // `installed` with a controller already in place means an update, not a
      // first install. A first install has no controller and must stay silent.
      if (installing.state === "installed" && options.container.controller !== null) announce();
    });
  });

  // The worker also raises this itself, from the one case the page cannot
  // see: a `_next/static` request that 404s because a deploy removed the
  // build this page is running.
  options.container.addEventListener("message", (event) => {
    const data = event.data;
    if (typeof data === "object" && data !== null && "type" in data && data.type === UPDATE_READY_MESSAGE) {
      announce();
    }
  });

  const controller = options.container.controller;
  if (controller !== null) {
    controller.postMessage({ type: WARM_MESSAGE, urls: warmUrlsFrom(options.resources, options.origin) });
  } else {
    // First registration: the worker is not controlling this page yet, so
    // wait for it to claim us and then hand over the same list.
    options.container.addEventListener("controllerchange", () => {
      const claimed = options.container.controller;
      if (claimed !== null) {
        claimed.postMessage({ type: WARM_MESSAGE, urls: warmUrlsFrom(options.resources, options.origin) });
      }
    });
  }

  return registration;
}

/**
 * Read the real globals, decide, and register.
 *
 * Returns false without registering anything when the environment is not one
 * the worker belongs in (`next dev`, an insecure origin, a browser without
 * service workers, the desktop shell), so the caller needs no feature
 * detection of its own.
 *
 * The kill switch is checked BEFORE `shouldRegister`, and it does not merely
 * decline to register: it tears down whatever is already installed. A visitor
 * who needs `?sw-off` has a worker in place and is being served by it, so
 * "return early" would leave them exactly where they were.
 */
export function installServiceWorker(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;

  const root = typeof document === "undefined" ? null : document.documentElement;

  const storage = readableStorage();
  if (killSwitchState(window.location.href, storage) === "on") {
    if ("serviceWorker" in navigator) {
      void unregisterServiceWorkers(
        navigator.serviceWorker,
        typeof caches === "undefined" ? null : caches,
      );
    }
    markDecision(root, "off:killed");
    return false;
  }

  const env: RegistrationEnvironment = {
    hasServiceWorker: "serviceWorker" in navigator,
    isSecureContext: window.isSecureContext,
    nodeEnv: process.env.NODE_ENV ?? "",
    isDesktopShell: isTauri(),
  };
  const decision = registrationDecision(env);
  markDecision(root, decision);
  if (decision !== "on") return false;

  const resources: TimedResource[] =
    typeof performance === "undefined" ? [] : performance.getEntriesByType("resource").map((entry) => ({ name: entry.name }));

  void registerServiceWorker({
    container: navigator.serviceWorker,
    doc: document,
    reload: () => window.location.reload(),
    resources,
    origin: window.location.origin,
  });
  return true;
}

/** `localStorage`, or null where reading it throws (a sandboxed iframe, blocked site data). */
function readableStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
