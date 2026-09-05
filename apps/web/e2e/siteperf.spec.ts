import { spawn, type ChildProcessByStdio } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * `public/sw.js`, in a real browser, against a real HTTP server.
 *
 * WHAT THIS EXISTS TO PROVE. `docs/handoff/v3-08-siteperf.md` section 7.2
 * measured a returning visitor past GitHub Pages' 600 s freshness window
 * paying 3 184 699 B without the worker and 0 B with it. That number was taken
 * by hand, once, and nothing in the suite defended it: the worker had no test
 * of any kind, and no e2e drove one, because the suite's shared server is
 * `next dev` and the worker deliberately refuses to register there
 * (`lib/serviceWorker.ts`: dev chunk URLs carry no content hash, so cache-first
 * would break Fast Refresh).
 *
 * HOW IT RUNS ANYWAY. This spec brings its own origin: a small static tree
 * with the SHIPPED `public/sw.js` copied into it byte for byte, laid out with
 * the paths the real export uses (`/_next/static/**`, `/manifold/**`,
 * `/presets/<sha1>.json.gz`, `/icon.svg`), served by the repo's own
 * `scripts/serve-static.mjs` on an OS-assigned port. It touches neither the
 * suite's dev server nor `apps/web/out`, which is why it works on a runner
 * that never ran `next build` (nightly.yml's full suite does not).
 *
 * The worker's cache POLICY is pinned unit-side in
 * `lib/serviceWorkerScript.test.ts`, on the same file. What only a browser can
 * decide is here: that Cache Storage, `clients.claim`, the warm-up handshake
 * and the fetch handler compose into a return visit that costs the page
 * nothing. The last test closes the other half of the loop -- that the real
 * app still calls the registration module at all.
 */

const REPO_WEB = path.resolve(__dirname, "..");

/** The build id this fixture registers the worker under. */
const BUILD_ID = "siteperf-build-1";

/** Two of the six presets' sha1 shape; only the shape matters to the worker. */
const PRESET_SHA1 = "a".repeat(40);

interface Origin {
  url: string;
  /** stdin ignored, stdout and stderr piped: the port is read off stdout. */
  server: ChildProcessByStdio<null, Readable, Readable>;
  dir: string;
}

let origin: Origin;

/**
 * The page half, written out rather than imported.
 *
 * It cannot be imported: `lib/serviceWorker.ts` is TypeScript in a bundle this
 * fixture has no bundler for. So this script does the three things the real
 * one does that the WORKER can observe -- register `sw.js?v=<build id>`, hand
 * over this load's Resource Timing URLs once the worker is in control, and
 * record what the worker posts back -- and nothing else. Everything the page
 * half decides on its own (whether to register, the URL shape, the update
 * line, the kill switch) is unit-tested in `lib/serviceWorker.test.ts`; this
 * file is here for the worker.
 */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>FrameCraft service worker fixture</title>
<link rel="stylesheet" href="/_next/static/css/app-deadbeef.css">
<link rel="icon" href="/icon.svg">
<script src="/_next/static/chunks/main-abc123.js"></script>
</head>
<body>
<p id="fixture">service worker fixture</p>
<script>
window.__fromWorker = [];
navigator.serviceWorker.addEventListener("message", function (event) {
  window.__fromWorker.push(event.data);
});
function warm() {
  var controller = navigator.serviceWorker.controller;
  if (!controller) return;
  var urls = performance.getEntriesByType("resource").map(function (entry) { return entry.name; });
  controller.postMessage({ type: "framecraft:warm", urls: urls });
  window.__warmed = true;
}
// A stable-URL asset the real app fetches at runtime rather than linking, so
// the stale-while-revalidate bucket has something in it. The BODY is awaited,
// not just the headers: a Resource Timing entry appears when the response is
// fully received, and registering before that would hand the worker a warm-up
// list this asset is missing from.
fetch("/manifold/manifold.wasm").then(function (response) {
  return response.arrayBuffer();
}).then(function () {
  return navigator.serviceWorker.register("/sw.js?v=${BUILD_ID}");
}).then(function () {
  if (navigator.serviceWorker.controller) warm();
  else navigator.serviceWorker.addEventListener("controllerchange", warm);
  document.documentElement.dataset.fixtureReady = "1";
});
</script>
</body>
</html>
`;

/** A tree shaped like the export, with the shipped worker in it. */
function buildFixtureTree(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "framecraft-siteperf-"));
  const write = (relative: string, body: string): void => {
    const full = path.join(dir, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  };

  write("index.html", PAGE);
  // Big enough that "zero bytes" is a claim with something behind it.
  write("_next/static/chunks/main-abc123.js", `globalThis.__fixtureChunk = ${JSON.stringify("x".repeat(40_000))};\n`);
  write("_next/static/css/app-deadbeef.css", `#fixture { color: #123456; }\n/* ${"y".repeat(20_000)} */\n`);
  write("manifold/manifold.wasm", `not a wasm module, but ${"z".repeat(30_000)}`);
  write("icon.svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>\n');
  write(`presets/${PRESET_SHA1}.json.gz`, "pretend gzip");

  // The worker itself: the shipped file, unmodified.
  copyFileSync(path.join(REPO_WEB, "public", "sw.js"), path.join(dir, "sw.js"));
  return dir;
}

/** Start `scripts/serve-static.mjs` on a port the OS picks, and read that port back. */
async function startOrigin(dir: string): Promise<Origin> {
  const server = spawn(
    process.execPath,
    [path.join(REPO_WEB, "scripts", "serve-static.mjs"), "--dir", dir, "--port", "0"],
    { cwd: REPO_WEB, stdio: ["ignore", "pipe", "pipe"] },
  );

  const url = await new Promise<string>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`serve-static did not start: ${out}`)), 20_000);
    server.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (match !== null) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    server.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve-static exited with ${String(code)}: ${out}`));
    });
  });

  return { url, server, dir };
}

test.beforeAll(async () => {
  origin = await startOrigin(buildFixtureTree());
});

test.afterAll(() => {
  origin.server.kill();
  rmSync(origin.dir, { recursive: true, force: true });
});

/** A context that allows workers, and a page on the fixture origin. */
async function visit(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${origin.url}/`);
  await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === "1");
  return page;
}

/** Every URL this page's Cache Storage holds, across every cache. */
async function cachedUrls(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    }
    return urls;
  });
}

/**
 * Wait until the worker controls the page and has adopted what the load
 * fetched.
 *
 * `expect.poll`, not `page.waitForFunction`. An ASYNC predicate handed to
 * `waitForFunction` is never awaited: the Promise it returns is truthy on the
 * first poll, so the wait passes immediately whatever the answer would have
 * been. Measured against this Playwright build, a predicate of
 * `async () => false` resolved in 14 ms against a 3 s timeout. Every wait in
 * this file that has to read Cache Storage or the registration list therefore
 * goes through `expect.poll`, which does await.
 */
async function warmed(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await expect
    .poll(async () => (await cachedUrls(page)).filter((url) => url.includes("/_next/static/")).length, {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(2);
}

interface Transfer {
  /** The document's own bytes. Network first, so this is never zero. */
  navigationBytes: number;
  /** Everything else the page asked for, same-origin. */
  subresourceBytes: number;
  subresourceCount: number;
}

/** What this navigation cost the PAGE, from its own Resource Timing. */
async function transferred(page: Page): Promise<Transfer> {
  return page.evaluate(() => {
    const resources = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter((entry) =>
      entry.name.startsWith(location.origin),
    );
    const navigation = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    return {
      navigationBytes: navigation.reduce((total, entry) => total + entry.transferSize, 0),
      subresourceBytes: resources.reduce((total, entry) => total + entry.transferSize, 0),
      subresourceCount: resources.length,
    };
  });
}

test.describe("the service worker, end to end", () => {
  test("a return visit past the freshness window costs the page nothing", async ({ browser }) => {
    const context = await browser.newContext({ serviceWorkers: "allow" });

    // Everything the worker itself asks the network for, which is the only
    // traffic that still reaches the origin once a page is controlled.
    const workerFetches: string[] = [];
    context.on("request", (request) => {
      if (request.serviceWorker() !== null) workerFetches.push(request.url());
    });

    const page = await visit(context);
    const cold = await transferred(page);
    expect(cold.subresourceBytes, "the cold visit really did pull the tree over the wire").toBeGreaterThan(
      50_000,
    );
    await warmed(page);

    // What `max-age=600` expiring amounts to, and no more: the HTTP cache goes,
    // the registration and Cache Storage stay.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.clearBrowserCache");

    workerFetches.length = 0;
    const responses: Array<{ url: string; fromWorker: boolean }> = [];
    page.on("response", (response) => {
      const url = response.url();
      // The browser's own byte-check of the worker script is not the page's
      // traffic: it is one small file the user agent fetches on its own
      // schedule, outside any fetch handler, and it is what MAKES a new deploy
      // visible. It cannot be served from Cache Storage and must not be.
      if (url.startsWith(origin.url) && !url.includes("/sw.js")) {
        responses.push({ url, fromWorker: response.fromServiceWorker() });
      }
    });

    await page.goto(`${origin.url}/`);
    await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === "1");
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

    const warm = await transferred(page);
    expect(warm.subresourceCount, "the return visit asked for the same resources").toBeGreaterThanOrEqual(2);
    expect(warm.subresourceBytes, "and paid nothing for any of them").toBe(0);
    // The document is the one thing that is NOT free, and must not be: it is
    // network-first because a deploy replaces the whole tree, so a cached HTML
    // could name chunk URLs the origin no longer has. Asserting it is non-zero
    // keeps the row above honest about what the worker does and does not save.
    expect(warm.navigationBytes, "the document is fetched every visit, by design").toBeGreaterThan(0);

    const overTheWire = responses.filter((response) => !response.fromWorker).map((r) => r.url);
    expect(overTheWire, "every response on a return visit comes out of the worker").toEqual([]);

    // The cache-first bucket is the whole of the byte saving, so it is the one
    // the origin must not see again.
    expect(
      workerFetches.filter((url) => url.includes("/_next/static/")),
      "a content-hashed URL can never be stale, so it is never re-fetched",
    ).toEqual([]);

    // And the two policies that DO go back out, because they must.
    expect(
      workerFetches.filter((url) => url === `${origin.url}/`),
      "a document is network-first: a deploy can replace the whole tree",
    ).not.toEqual([]);
    expect(
      workerFetches.filter((url) => url.includes("/manifold/manifold.wasm")),
      "a stable URL is stale-while-revalidate: served from cache, refreshed behind",
    ).not.toEqual([]);

    await context.close();
  });

  test("the page is told when its build has left the origin", async ({ browser }) => {
    const context = await browser.newContext({ serviceWorkers: "allow" });
    const page = await visit(context);
    await warmed(page);

    // A chunk from a build this origin no longer serves: the mid-deploy case,
    // and the one the page cannot see for itself.
    const gone = await page.evaluate(async () => {
      const response = await fetch("/_next/static/chunks/from-a-build-that-went.js");
      return response.status;
    });
    expect(gone).toBe(404);

    await page.waitForFunction(() => {
      const seen = (window as unknown as { __fromWorker?: Array<{ type?: string }> }).__fromWorker ?? [];
      return seen.some((message) => message.type === "framecraft:update-ready");
    });

    const message = await page.evaluate(
      () => (window as unknown as { __fromWorker: Array<{ type?: string; reason?: string; buildId?: string }> }).__fromWorker,
    );
    expect(message).toContainEqual({
      type: "framecraft:update-ready",
      reason: "missing-chunk",
      buildId: BUILD_ID,
    });

    await context.close();
  });

  test("a preset response is held on its own, and only once asked for", async ({ browser }) => {
    const context = await browser.newContext({ serviceWorkers: "allow" });
    const page = await visit(context);
    await warmed(page);

    const presetCacheName = "framecraft-presets-v1";
    const before = await page.evaluate(async (name) => (await caches.keys()).includes(name), presetCacheName);
    expect(before, "1.7 MB per preset: nothing precaches these").toBe(false);

    const body = await page.evaluate(async (sha1) => {
      const response = await fetch(`/presets/${sha1}.json.gz`);
      return response.text();
    }, PRESET_SHA1);
    expect(body).toBe("pretend gzip");

    const held = await page.evaluate(
      async (name) => (await (await caches.open(name)).keys()).map((request) => request.url),
      presetCacheName,
    );
    expect(held).toEqual([`${origin.url}/presets/${PRESET_SHA1}.json.gz`]);

    await context.close();
  });
});

test.describe("the app's own registration", () => {
  /**
   * The fixture above proves the worker works. This proves the app still asks
   * for one.
   *
   * `installServiceWorker` writes its decision to `data-fc-sw` on every path,
   * so this fails two different ways: the attribute is missing if `page.tsx`
   * stopped calling the module, and its value is wrong if the environment gate
   * stopped agreeing with the server the suite is pointed at. Under the
   * suite's default `next dev` the honest answer is `off:dev`; under
   * `FRAMECRAFT_WEB_MODE=prod`, which serves the export over 127.0.0.1, it is
   * `on`.
   */
  test("the editor asks the registration module for a decision, and records it", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => document.documentElement.dataset.fcReady === "1");

    const decision = await page.evaluate(() => document.documentElement.dataset.fcSw);
    expect(decision, "app/page.tsx must still call installServiceWorker()").toBeDefined();
    expect(["on", "off:dev"]).toContain(decision);

    if (decision === "off:dev") {
      // The deliberate opt-out, and it has to be real: a worker here would
      // answer an edited chunk with the previous one and break Fast Refresh.
      expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(false);
    } else {
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    }
  });

  /**
   * The desktop-shell refusal, from the outside.
   *
   * `lib/platform.ts`'s `isTauri()` is `"__TAURI_INTERNALS__" in window` and
   * nothing else, so that global is what makes this page the shell to the one
   * function that DECIDES. The assertion is on the REASON rather than on the
   * absence of a worker, because under `next dev` there would be no worker
   * either way and a test that only checked for one would pass without the
   * gate existing at all. `registrationDecision` asks about Tauri before it
   * asks about the environment, which is what makes the two distinguishable
   * here.
   *
   * BOTH globals are injected, because both are what the shell has.
   * `apps/desktop/src-tauri/tauri.conf.json` sets `app.withGlobalTauri`, so
   * inside the real shell `window.__TAURI__` carries the IPC surface beside
   * `__TAURI_INTERNALS__`, and `lib/platform.ts` reads the first through the
   * second's answer: everything gated on `isTauri()` -- here
   * `DesktopProjectOpener`, mounted from the root layout -- then calls
   * `__TAURI__.core.invoke` / `.event.listen`. Injecting the marker alone
   * builds a shell that has never shipped, and the app dies in it: `tauriApi()`
   * throws "Tauri global API is not available" out of an effect, React unmounts
   * the tree, and `data-fc-ready` is never set, which is precisely how this
   * test used to fail -- on the app's boot, several layers away from the
   * registration gate it exists to defend. `invoke` resolving null is the
   * honest answer for both commands the opener sends (`take_pending_project`
   * with no file parked, and a listen that never fires).
   */
  test("the desktop shell is refused, and refused for being the desktop shell", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
      Object.defineProperty(window, "__TAURI__", {
        value: {
          core: { invoke: () => Promise.resolve(null) },
          event: { listen: () => Promise.resolve(() => {}) },
        },
        configurable: true,
      });
    });
    await page.goto("/");
    await page.waitForFunction(() => document.documentElement.dataset.fcReady === "1");

    expect(await page.evaluate(() => document.documentElement.dataset.fcSw)).toBe("off:tauri");
    expect(
      await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
      "the shell ships this same export, and must install nothing from it",
    ).toBe(0);
  });

  /**
   * The shell whose IPC global never arrived, which must still be an editor.
   *
   * The test above injects both globals because that is what the shell ships.
   * This one injects the MARKER ALONE on purpose, because that combination is
   * one `withGlobalTauri` away and used to be fatal: everything gated on
   * `isTauri()` called `window.__TAURI__`, so `DesktopProjectOpener` -- an
   * effect mounted by the ROOT LAYOUT, above every route -- threw during
   * commit, React unmounted the tree, and the desktop app was a blank page.
   * `lib/platform.ts` now degrades the passive callers instead: the file
   * association is simply not there, and it says so on the console rather than
   * going quiet. The save dialog still throws, because that one answers a
   * click and `lib/exportFlow.ts` shows the failure.
   *
   * A page error is asserted to be absent rather than a symptom of it, because
   * the symptom moves: with a different root layout the same throw might take
   * out a pane instead of the page, and it would still be the same defect.
   */
  test("a desktop shell with no IPC global gets the editor, not a blank page", async ({ page }) => {
    const crashes: string[] = [];
    page.on("pageerror", (error) => crashes.push(error.message));
    const warnings: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "warning") warnings.push(message.text());
    });

    await page.addInitScript(() => {
      Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    });
    await page.goto("/");

    await page.waitForFunction(() => document.documentElement.dataset.fcReady === "1");
    await expect(page.locator('[data-preset-id="chicago-loop"]')).toBeVisible();
    expect(crashes, "one absent global must not unmount the editor").toEqual([]);
    // Still the shell, still refused a worker for being it: degrading must not
    // rewrite what the app believes it is running in.
    expect(await page.evaluate(() => document.documentElement.dataset.fcSw)).toBe("off:tauri");
    expect(
      warnings.filter((line) => line.includes("withGlobalTauri")),
      "the missing feature is reported, not swallowed",
    ).not.toEqual([]);
  });

  /**
   * The kill switch, from the outside, on the real app.
   *
   * The state it exists to rescue is built by hand first, because `next dev`
   * deliberately registers nothing: a real registration plus a cache under
   * this app's prefix and one that is not ours. The probe worker is registered
   * under a scope the editor never navigates to, so it cannot intercept the
   * dev server's own chunks while this runs; `getRegistrations()` returns it
   * regardless, which is what the switch walks.
   */
  test("`?sw-off` retires every worker and every cache this app owns, and no others", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => document.documentElement.dataset.fcReady === "1");

    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js?v=kill-switch-probe", {
        scope: "/kill-switch-probe/",
      });
      await caches.open("framecraft-immutable-v1");
      await caches.open("somebody-elses-cache");
    });
    expect(
      await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
      "there has to be something to kill",
    ).toBeGreaterThan(0);

    await page.goto("/?sw-off");
    await page.waitForFunction(() => document.documentElement.dataset.fcReady === "1");

    // The teardown is started and not awaited by the page, so it is polled --
    // through `expect.poll`, for the reason spelled out on `warmed` above.
    await expect
      .poll(async () => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), {
        timeout: 15_000,
      })
      .toBe(0);
    await expect
      .poll(
        async () =>
          page.evaluate(async () => (await caches.keys()).filter((name) => name.startsWith("framecraft-")).length),
        { timeout: 15_000 },
      )
      .toBe(0);
    expect(
      await page.evaluate(async () => (await caches.keys()).includes("somebody-elses-cache")),
      "a Pages user site can host more than one app on one origin",
    ).toBe(true);
    expect(
      await page.evaluate(() => localStorage.getItem("framecraft.sw.off")),
      "a switch that forgot itself would be undone by the visitor's next click",
    ).not.toBeNull();

    await page.goto("/?sw-on");
    await page.waitForFunction(() => document.documentElement.dataset.fcReady === "1");
    expect(await page.evaluate(() => localStorage.getItem("framecraft.sw.off"))).toBeNull();
  });
});
