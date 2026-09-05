/**
 * Runtime platform detection: the same static bundle runs in a browser tab
 * and inside the FrameCraft desktop app (Tauri 2, `apps/desktop`). This
 * module is the ONLY place that knows the difference.
 *
 * Deliberately NO static import of any `@tauri-apps/*` package: the web
 * bundle must not carry Tauri code. The desktop shell sets
 * `app.withGlobalTauri` in `tauri.conf.json`, so inside Tauri the IPC
 * surface is reachable as `window.__TAURI__` with zero imports; in a plain
 * browser neither global exists and every helper here reports "browser".
 */

interface TauriGlobal {
  core: {
    invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  /**
   * Tauri's event bus, present in the same global bundle `withGlobalTauri`
   * exposes. `listen` resolves to its own unlisten function.
   */
  event: {
    listen: (
      event: string,
      handler: (message: { payload: unknown }) => void,
    ) => Promise<() => void>;
  };
}

/** True when running inside the Tauri desktop shell. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function tauriApi(): TauriGlobal {
  const api = typeof window === "undefined" ? undefined : (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!api) throw new Error("Tauri global API is not available (withGlobalTauri off, or not running under Tauri)");
  return api;
}

/** What a half-initialised global looks like before it has been checked. */
interface PartialTauriGlobal {
  core?: { invoke?: unknown };
  event?: { listen?: unknown };
}

const MISSING_API_MESSAGE =
  "FrameCraft: running inside the desktop shell, but its IPC global (window.__TAURI__) is missing or " +
  "incomplete -- withGlobalTauri is off, or the shell is only partly initialised. The desktop-only " +
  "features (open-with, the native save dialog, the cache directory) are unavailable for this session; " +
  "everything else works.";

/** Said once per realm. A per-call warning would be one line per file the OS opens. */
let warnedAboutMissingApi = false;

/**
 * The IPC surface, or null when this shell has not got one.
 *
 * WHY THIS EXISTS ALONGSIDE `tauriApi`. `isTauri()` reads
 * `__TAURI_INTERNALS__`, which Tauri always sets, while the API this module
 * calls is `__TAURI__`, which only `app.withGlobalTauri` exposes
 * (`apps/desktop/src-tauri/tauri.conf.json` sets it, so the two travel
 * together today). One config flag apart, every `isTauri()` branch here was
 * calling into a global that was not there -- and `onProjectFileOpened` is
 * called from an effect in `components/editor/DesktopProjectOpener`, mounted
 * by the root layout, so the throw unmounted the entire editor. A white page,
 * two layers from a line nobody would connect to it. That is not a Tauri
 * detail; a single absent global must not be able to take the app down.
 *
 * So the PASSIVE callers -- the ones the app runs on its own, whose whole
 * result is a feature quietly not being there -- go through here and degrade.
 * `saveFileWithDialog` deliberately does NOT: it answers a click, and
 * `lib/exportFlow.ts` turns its failure into a "failed" the user is shown.
 * Degrading is for a feature that cannot appear, never for one that appears
 * and does nothing.
 *
 * The shape is checked, not just the presence, because a partly-built global
 * fails in exactly the same way as an absent one. Nothing is masked: this
 * says so on the console, `isTauri()` still reports the shell honestly, and
 * the save dialog still throws.
 */
function optionalTauriApi(): TauriGlobal | null {
  const raw =
    typeof window === "undefined" ? undefined : (window as unknown as { __TAURI__?: PartialTauriGlobal }).__TAURI__;
  if (raw === undefined || typeof raw.core?.invoke !== "function" || typeof raw.event?.listen !== "function") {
    if (!warnedAboutMissingApi) {
      warnedAboutMissingApi = true;
      console.warn(MISSING_API_MESSAGE);
    }
    return null;
  }
  return raw as unknown as TauriGlobal;
}

/** Uint8Array -> base64, chunked so a multi-MB 3MF never blows the argument-spread limit. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

/**
 * Save `bytes` through the desktop save dialog (`save_export` in
 * `apps/desktop/src-tauri/src/lib.rs`). Resolves true when the user picked a
 * location and the file was written, false when they cancelled the dialog.
 * Throws outside Tauri; callers gate on `isTauri()` first.
 */
export async function saveFileWithDialog(filename: string, bytes: Uint8Array): Promise<boolean> {
  const saved = await tauriApi().core.invoke("save_export", {
    filename,
    dataBase64: toBase64(bytes),
  });
  return saved !== null;
}

/**
 * The desktop app's data directory (for future offline caches). Null in the
 * browser, where there is no such thing.
 */
export async function platformCacheDir(): Promise<string | null> {
  if (!isTauri()) return null;
  const api = optionalTauriApi();
  if (api === null) return null;
  return (await api.core.invoke("cache_dir")) as string;
}

// ---------------------------------------------------------------------------
// Opening a project from the operating system (Task 13)
// ---------------------------------------------------------------------------

/** The event the Rust side emits when a `.framecraft` file is opened while the app is already running. */
export const OPEN_PROJECT_EVENT = "framecraft://open-project";

/** A project file handed to the app by the OS: its name, and the text the Rust side already read. */
export interface OpenedProjectFile {
  /** The file's base name, e.g. `chicago-2026-09-03.framecraft`. Decides whether the load reports a legacy extension. */
  readonly filename: string;
  /** The whole file, decoded as UTF-8 by the Rust side. */
  readonly text: string;
  /** The absolute path, for a message that has to name the file that failed. */
  readonly path: string;
}

/**
 * Narrow an untrusted IPC payload to an `OpenedProjectFile`.
 *
 * The Rust side is the only sender, but the boundary is still a JSON value
 * typed `unknown`, and a shape check here is what keeps `any` out of the
 * module and a malformed payload out of the store.
 */
export function asOpenedProjectFile(value: unknown): OpenedProjectFile | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const { filename, text, path } = record;
  if (typeof filename !== "string" || typeof text !== "string" || typeof path !== "string") {
    return null;
  }
  return { filename, text, path };
}

/**
 * The project the app was LAUNCHED with, if any, taken exactly once.
 *
 * Launching by double-click delivers the path as a process argument long
 * before the WebView exists, so the Rust side parks it and the page collects
 * it when it is ready. Taking clears it, so a reload of the WebView does not
 * reopen a file the user has since moved on from. Null in a browser, and null
 * when the app was started normally.
 */
export async function takePendingProjectFile(): Promise<OpenedProjectFile | null> {
  if (!isTauri()) return null;
  const api = optionalTauriApi();
  if (api === null) return null;
  return asOpenedProjectFile(await api.core.invoke("take_pending_project"));
}

/**
 * Listen for a project opened while the app is already running: a second
 * double-click, which the single-instance plugin routes to this window rather
 * than starting a second copy, and macOS's open-documents event.
 *
 * Returns a function that stops listening. Outside Tauri it is a no-op that
 * still returns one, so a caller's cleanup path needs no platform branch --
 * and so does a shell with no IPC global, which is the same answer for the
 * same reason: there is no listener to stop. This one is load bearing, not
 * tidiness. The caller is an effect in `components/editor/DesktopProjectOpener`
 * mounted by the root layout, so a throw from here unmounts the editor and
 * leaves a blank page (see `optionalTauriApi`).
 */
export function onProjectFileOpened(
  handler: (file: OpenedProjectFile) => void,
): () => void {
  if (!isTauri()) return () => {};
  const api = optionalTauriApi();
  if (api === null) return () => {};
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void api
    .event.listen(OPEN_PROJECT_EVENT, (message) => {
      const file = asOpenedProjectFile(message.payload);
      if (file !== null) handler(file);
    })
    .then((stop) => {
      // Subscribing is async and unsubscribing may be asked for first; without
      // this the listener would outlive the component that registered it.
      if (cancelled) stop();
      else unlisten = stop;
    });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
