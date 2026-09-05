/**
 * `lib/platform.ts`: what happens when the desktop shell is only half there.
 *
 * WHAT THIS DEFENDS. `isTauri()` reads `__TAURI_INTERNALS__`, which Tauri
 * always sets. Every helper that follows calls `window.__TAURI__`, which only
 * `app.withGlobalTauri` exposes. The two travel together in
 * `apps/desktop/src-tauri/tauri.conf.json` today, and one flag apart the
 * passive helpers threw: `onProjectFileOpened` is called from an effect in
 * `components/editor/DesktopProjectOpener`, mounted by the root layout, so the
 * throw unmounted the whole editor and left a blank page. That shape is not
 * hypothetical -- it is what cost `e2e/siteperf.spec.ts`'s desktop-shell test
 * its entire 300 s timeout while the gate it exists to defend was never
 * reached (`docs/handoff/v3-08-siteperf.md` section 10.7).
 *
 * The line these tests draw: a feature that CANNOT appear degrades, a feature
 * the user CLICKED still fails loudly, and nothing pretends the environment is
 * healthy.
 *
 * This package's vitest environment is `node`, so `window` is stubbed here and
 * the module is re-imported per test -- the "said once" warning is module
 * state, and a shared module would make one test's warning another's silence.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type Platform = typeof import("./platform");

/** Fresh module, so the once-per-realm warning is once per test. */
async function load(): Promise<Platform> {
  vi.resetModules();
  return import("./platform");
}

/** The shell as it ships: the marker AND the IPC global `withGlobalTauri` exposes. */
function completeShell(): { invoke: ReturnType<typeof vi.fn>; listen: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn();
  const invoke = vi.fn((command: string) =>
    Promise.resolve(
      command === "take_pending_project"
        ? { filename: "chicago.framecraft", text: "{}", path: "C:/tmp/chicago.framecraft" }
        : "C:/tmp/cache",
    ),
  );
  const listen = vi.fn(() => Promise.resolve(stop));
  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: {},
    __TAURI__: { core: { invoke }, event: { listen } },
  });
  return { invoke, listen, stop };
}

/** The shell that broke the editor: the marker, and no IPC global behind it. */
function shellWithNoApi(): void {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
}

/** A worse one: the global is there, and half built. */
function shellWithHalfAnApi(): void {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, __TAURI__: { core: { invoke: () => Promise.resolve(null) } } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a shell with no IPC global: the editor survives it", () => {
  it("does not throw out of the effect that mounts the file opener", async () => {
    shellWithNoApi();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const platform = await load();

    // The exact call `DesktopProjectOpener` makes, and the one that used to
    // take the tree down with it.
    const stop = platform.onProjectFileOpened(() => {});
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });

  it("reports no pending project and no cache directory, rather than rejecting", async () => {
    shellWithNoApi();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const platform = await load();

    await expect(platform.takePendingProjectFile()).resolves.toBeNull();
    await expect(platform.platformCacheDir()).resolves.toBeNull();
  });

  it("is degraded the same way by a half-built global, which fails identically", async () => {
    shellWithHalfAnApi();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const platform = await load();

    expect(() => platform.onProjectFileOpened(() => {})).not.toThrow();
    await expect(platform.takePendingProjectFile()).resolves.toBeNull();
  });

  it("says so, once, rather than going quiet about it", async () => {
    shellWithNoApi();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const platform = await load();

    platform.onProjectFileOpened(() => {});
    await platform.takePendingProjectFile();
    await platform.platformCacheDir();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("withGlobalTauri");
  });

  it("still calls this the desktop shell, because it is one", async () => {
    shellWithNoApi();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const platform = await load();

    // Degrading must not rewrite what the app believes it is running in: the
    // service worker's `off:tauri` refusal and the About dialog's "Desktop
    // app" both read this, and both would start lying.
    expect(platform.isTauri()).toBe(true);
  });

  it("still fails loudly on the save the user actually clicked", async () => {
    shellWithNoApi();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const platform = await load();

    // `lib/exportFlow.ts` catches this and shows "failed". A silent no-op here
    // would be a save that reports success and writes nothing.
    await expect(platform.saveFileWithDialog("a.3mf", new Uint8Array([1]))).rejects.toThrow(/Tauri global API/);
  });
});

describe("a complete shell: nothing is degraded that works", () => {
  it("takes the launch project through the real IPC surface", async () => {
    const { invoke } = completeShell();
    const platform = await load();

    await expect(platform.takePendingProjectFile()).resolves.toEqual({
      filename: "chicago.framecraft",
      text: "{}",
      path: "C:/tmp/chicago.framecraft",
    });
    expect(invoke).toHaveBeenCalledWith("take_pending_project");
  });

  it("subscribes to the open-project event, and unsubscribes on cleanup", async () => {
    const { listen, stop } = completeShell();
    const platform = await load();

    const opened: string[] = [];
    const cleanup = platform.onProjectFileOpened((file) => opened.push(file.filename));
    expect(listen).toHaveBeenCalledWith(platform.OPEN_PROJECT_EVENT, expect.any(Function));

    // The handler the module registered, driven the way the Rust side drives it.
    const deliver = listen.mock.calls[0]?.[1] as (message: { payload: unknown }) => void;
    deliver({ payload: { filename: "paris.framecraft", text: "{}", path: "C:/tmp/paris.framecraft" } });
    deliver({ payload: { filename: 7 } });
    expect(opened, "a malformed payload is dropped, not handed on").toEqual(["paris.framecraft"]);

    await Promise.resolve();
    cleanup();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("warns about nothing", async () => {
    completeShell();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const platform = await load();

    platform.onProjectFileOpened(() => {});
    await platform.takePendingProjectFile();
    expect(warn).not.toHaveBeenCalled();
  });
});
