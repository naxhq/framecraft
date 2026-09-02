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
  return (await tauriApi().core.invoke("cache_dir")) as string;
}
