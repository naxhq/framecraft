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

/** The build this bundle came from; `next.config.ts` inlines it. Empty in a bare `next dev`. */
export const BUILD_ID: string = process.env.NEXT_PUBLIC_BUILD_ID ?? "";

export const UPDATE_READY_MESSAGE = "framecraft:update-ready";
export const SKIP_WAITING_MESSAGE = "framecraft:skip-waiting";
export const WARM_MESSAGE = "framecraft:warm";

/** The most Resource Timing entries one warm message will carry. A cold load has 33. */
export const MAX_WARM_URLS = 120;

export const UPDATE_TOAST_ID = "fc-update-toast";

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
}

export interface ContainerLike {
  controller: { postMessage(message: unknown): void } | null;
  register(url: string): Promise<RegistrationLike>;
  addEventListener(type: "controllerchange" | "message", listener: (event: { data?: unknown }) => void): void;
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

export interface RegistrationEnvironment {
  /** `"serviceWorker" in navigator` */
  hasServiceWorker: boolean;
  /** `window.isSecureContext`: https, or localhost over http. */
  isSecureContext: boolean;
  /** `process.env.NODE_ENV`. */
  nodeEnv: string;
}

/**
 * Whether to register at all.
 *
 * Development is excluded deliberately and permanently. `next dev` serves
 * `_next/static` chunks whose URLs are NOT content-hashed, so the worker's
 * cache-first rule would answer an edited chunk with the previous one and
 * break Fast Refresh. The production export is the only build whose asset URLs
 * carry a content hash, which is the whole premise of the cache policy.
 */
export function shouldRegister(env: RegistrationEnvironment): boolean {
  return env.hasServiceWorker && env.isSecureContext && env.nodeEnv !== "development";
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
 * the app runs exactly as it did before, straight off the network.
 */
export async function registerServiceWorker(options: RegisterOptions): Promise<RegistrationLike | null> {
  const basePath = options.basePath ?? BASE_PATH;
  const buildId = options.buildId ?? BUILD_ID;

  let registration: RegistrationLike;
  try {
    registration = await options.container.register(serviceWorkerUrl(basePath, buildId));
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
 * Returns false without touching anything when the environment is not one the
 * worker belongs in (`next dev`, an insecure origin, a browser without
 * service workers), so the caller needs no feature detection of its own.
 */
export function installServiceWorker(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const env: RegistrationEnvironment = {
    hasServiceWorker: "serviceWorker" in navigator,
    isSecureContext: window.isSecureContext,
    nodeEnv: process.env.NODE_ENV ?? "",
  };
  if (!shouldRegister(env)) return false;

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
