/**
 * Regenerate every screenshot in `docs/assets/` from the running app.
 *
 *   cd apps/web && node scripts/capture-screenshots.mjs
 *
 * The images in the README are the real interface, captured by driving it, so
 * a screenshot cannot outlive the UI it shows. Nothing here is a mock-up and
 * nothing is drawn by hand: each shot is a Playwright screenshot of a live
 * page that has been taken through the same steps a reader would take.
 *
 * What makes it repeatable:
 *
 *  - **The city is a fixture.** Every Overpass mirror is routed to the
 *    committed Chicago Loop response (`tests/fixtures/overpass-chicago-loop.json`),
 *    the same file the e2e suite uses, so the model in the picture is the same
 *    model on every host and never depends on Overpass being up.
 *  - **The search results are a fixture.** Photon and Nominatim are routed to
 *    the committed responses under `apps/web/e2e/fixtures/`.
 *  - **The context is fixed.** A fresh browser context (so `localStorage` is
 *    empty and the layout starts at its defaults), a 1440x900 viewport at
 *    device scale 2, light scheme, reduced motion, and CSS animation and
 *    transition durations zeroed before the shutter.
 *
 * What is NOT fixed, and cannot be: the OSM raster tiles behind the map pin
 * are fetched live from tile.openstreetmap.org (03 forbids any other source
 * and the repo carries no tile cache), so this script needs network for the
 * map region, and the estimate card's timing figures are whatever this host
 * measured. Run it twice on one tree and the layout, the model and the text
 * are identical; the millisecond counts are not.
 *
 * Flags:
 *   --url <origin>    base URL to drive (default http://localhost:3000, or
 *                     PLAYWRIGHT_BASE_URL)
 *   --out <dir>       output directory (default ../../docs/assets)
 *   --only <name,...> capture a subset by shot name
 *   --headed          watch it happen
 *
 * With no server listening on the base URL, the script starts `npm run dev`
 * itself and stops it on the way out; an already-running server is reused and
 * left alone.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(WEB_DIR, "..", "..");

const argv = process.argv.slice(2);

function flag(name) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

const BASE_URL = flag("url") ?? process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const OUT_DIR = path.resolve(flag("out") ?? path.join(REPO_ROOT, "docs", "assets"));
const ONLY = (flag("only") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
const HEADED = argv.includes("--headed");

/** Wide enough for the three-region layout at its defaults, short enough to read. */
const VIEWPORT = { width: 1440, height: 900 };

/** A cold Chicago build is ~7 s of engine time here; a slow host gets three times that. */
const BUILD_TIMEOUT_MS = 120_000;

/** MapLibre has no "idle" event this script can await from outside, so the tiles get a settle window. */
const MAP_SETTLE_MS = 3_000;

function log(message) {
  console.log(`[screenshots] ${message}`);
}

function fixture(...parts) {
  return readFileSync(path.join(REPO_ROOT, ...parts), "utf-8");
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

async function serverIsUp(url) {
  try {
    const response = await fetch(url, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

async function startServer() {
  const port = new URL(BASE_URL).port || "3000";
  log(`no server on ${BASE_URL}, starting \`npm run dev -- --port ${port}\``);
  const child = spawn("npm", ["run", "dev", "--", "--port", port], {
    cwd: WEB_DIR,
    stdio: "ignore",
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
  });
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (await serverIsUp(BASE_URL)) {
      log("dev server is up");
      return child;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`the dev server did not answer ${BASE_URL} within 300 s`);
}

function stopServer(child) {
  if (child === undefined) return;
  log("stopping the dev server this script started");
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/** Route the three third-party data sources the editor talks to at their committed fixtures. */
async function routeFixtures(page) {
  const overpass = fixture("tests", "fixtures", "overpass-chicago-loop.json");
  const photon = fixture("apps", "web", "e2e", "fixtures", "photon-chicago.json");
  const reverse = fixture("apps", "web", "e2e", "fixtures", "nominatim-reverse-chicago.json");
  const json = (body) => ({ status: 200, contentType: "application/json", body });

  await page.route("**/api/interpreter", (route) => route.fulfill(json(overpass)));
  await page.route("**/photon.komoot.io/**", (route) => route.fulfill(json(photon)));
  await page.route("**/nominatim.openstreetmap.org/**", (route) => route.fulfill(json(reverse)));
}

/** Zero every animation and transition, so a shot is never taken mid-fade. */
const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

async function openEditor(context) {
  const page = await context.newPage();
  await routeFixtures(page);
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="editor"]').waitFor({ state: "visible" });
  await page.locator('[data-testid="region-map"]').waitFor({ state: "visible" });
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.waitForTimeout(MAP_SETTLE_MS);
  return page;
}

/**
 * Press the Chicago preset, then Preview, and wait for a model that is really
 * there.
 *
 * Waiting on `preview-canvas` alone is not enough. The empty state ("Preview a
 * location to build the model") and the built state are different elements, a
 * restored location can leave the preset already active so that clicking it
 * changes nothing, and against a dev server a recompile between shots reloads
 * the page and takes the model with it. So the wait is on the built state's
 * own strip, `preview-stats`, and the empty state having gone.
 */
async function previewChicago(page) {
  await page.locator('[data-preset-id="chicago-loop"]').click();
  const preview = page.locator('[data-testid="preview-button"]');
  await preview.waitFor({ state: "visible" });
  // While a run is in flight this same button IS Cancel (`data-mode`), so
  // "enabled" is not permission to press it: pressing it there would stop the
  // build the preset just started.
  const mode = await preview.getAttribute("data-mode");
  if (mode !== "cancel" && (await preview.isEnabled())) await preview.click();
  await page.locator('[data-testid="preview-empty"]').waitFor({
    state: "hidden",
    timeout: BUILD_TIMEOUT_MS,
  });
  await page.locator('[data-testid="preview-canvas"]').waitFor({ timeout: BUILD_TIMEOUT_MS });
  await page.locator('[data-testid="preview-stats"]').waitFor({ timeout: BUILD_TIMEOUT_MS });
  await page.locator('[data-testid="stats-card"]').waitFor({ timeout: BUILD_TIMEOUT_MS });
  // The last regions stream in after the first frame; give the viewport a
  // moment to settle so the plate in the picture is the finished one.
  await page.waitForTimeout(2_500);
}

/**
 * Close every settings group, including the results block.
 *
 * The panel is one column: an open group, and above all the results block once
 * there is a model, take the height the group list would otherwise have. Every
 * shot of the panel therefore starts from everything closed and opens only
 * what it is a picture of.
 */
async function collapseGroups(page) {
  const open = page.locator(
    '[data-testid^="group-"][data-testid$="-toggle"][aria-expanded="true"]',
  );
  for (let guard = 0; guard < 20 && (await open.count()) > 0; guard += 1) {
    await open.first().evaluate((element) => {
      element.click();
    });
    await page.waitForTimeout(120);
  }
}

/**
 * Open one settings group by its id and put its header at the top of the
 * column.
 *
 * The header is clicked through the DOM rather than by the mouse. The settings
 * column scrolls inside a taller page, and a real click first waits for the
 * element to be stable in the VIEWPORT, which a header far down its own scroll
 * container never becomes. Nothing about which group is open is under test
 * here; the picture is.
 */
async function openGroup(page, id) {
  const toggle = page.locator(`[data-testid="group-${id}-toggle"]`);
  await toggle.waitFor({ state: "attached" });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.evaluate((element) => {
      element.click();
    });
  }
  await toggle.evaluate((element) => {
    element.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(400);
}

/**
 * Take the shot, then prove the page still says what it said.
 *
 * A dev server recompiles when anybody saves a file and reloads every page it
 * is serving, which empties the viewport. That can land between the wait and
 * the shutter, and the result is a photograph of the empty state with an exit
 * code of 0. So every shot that needs a model re-checks the model afterwards
 * and throws if it has gone, which sends the shot round again.
 */
async function shoot(target, file, page = undefined) {
  mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, file);
  await target.screenshot({ path: out });
  if (page !== undefined) {
    const stats = page.locator('[data-testid="preview-stats"]');
    if (!(await stats.isVisible())) {
      throw new Error(`${file}: the model was gone by the time the shot was taken`);
    }
  }
  log(`wrote ${path.relative(REPO_ROOT, out)}`);
}

// ---------------------------------------------------------------------------
// The shots
// ---------------------------------------------------------------------------

const SHOTS = [
  {
    name: "editor",
    file: "screenshot.png",
    description: "the whole editor with the Chicago Loop model on the plate",
    async capture(context) {
      const page = await openEditor(context);
      await previewChicago(page);
      await shoot(page, "screenshot.png", page);
      await page.close();
    },
  },
  {
    name: "settings",
    file: "screenshot-settings.png",
    description: "the settings column: every group says what it is set to",
    async capture(context) {
      const page = await openEditor(context);
      await previewChicago(page);
      // What this shot is about is the group list: every header stating what
      // that group is set to. Location, Scale and the results block are open
      // by default and any one of them fills the column.
      await collapseGroups(page);
      const groups = page.locator('[data-testid="param-groups"]');
      await groups.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.waitForTimeout(300);
      await shoot(groups, "screenshot-settings.png", page);
      await page.close();
    },
  },
  {
    name: "colour",
    file: "screenshot-colour.png",
    description: "palettes, per-region colours and the filament slot mapping",
    async capture(context) {
      const page = await openEditor(context);
      await previewChicago(page);
      // The results block is open by default and, once there is a model, it is
      // long enough to squeeze the group list to a few pixels. Everything
      // closes, then Colour alone opens, so the shot is of the colour controls
      // rather than of a sliver of them.
      await collapseGroups(page);
      await openGroup(page, "colour");
      // The group opens on the colour mode; the palettes and the per-region
      // slot rows are what the picture is for, so scroll to them.
      await page
        .locator('[data-testid="palette-builtin-list"]')
        .evaluate((element) => {
          element.scrollIntoView({ block: "start" });
        });
      await page.waitForTimeout(400);
      await shoot(page.locator('[data-testid="param-groups"]'), "screenshot-colour.png", page);
      await page.close();
    },
  },
  {
    name: "search",
    file: "screenshot-search.png",
    description: "the Photon type-ahead over the map",
    async capture(context) {
      const page = await openEditor(context);
      const box = page.locator('[data-testid="location-search"]');
      await box.click();
      await box.fill("chicago");
      await page.locator('[data-testid="search-popover"]').waitFor({ state: "visible" });
      await page.locator('[data-testid="search-result"]').first().waitFor({ state: "visible" });
      await page.waitForTimeout(500);
      await shoot(page.locator('[data-testid="region-map"]'), "screenshot-search.png");
      await page.close();
    },
  },
  {
    name: "objects",
    file: "screenshot-objects.png",
    description: "right-click a building: what it is, and its own overrides",
    async capture(context) {
      const page = await openEditor(context);
      await previewChicago(page);
      const canvas = page.locator('[data-testid="preview-canvas"]');
      const box = await canvas.boundingBox();
      if (box === null) throw new Error("the preview canvas has no box");
      // A right-click on the plate, the frame or a gap between blocks resolves
      // to no OSM object and the menu says so, which is not the picture. Walk a
      // few points over the Loop's towers and keep the first that answers.
      const spots = [
        [0.46, 0.42],
        [0.52, 0.36],
        [0.4, 0.46],
        [0.58, 0.44],
        [0.34, 0.38],
      ];
      const inspector = page.locator('[data-testid="object-inspector"]');
      let opened = false;
      for (const [u, v] of spots) {
        const point = { x: box.x + box.width * u, y: box.y + box.height * v };
        await page.mouse.move(point.x, point.y);
        await page.waitForTimeout(500);
        await page.mouse.click(point.x, point.y, { button: "right" });
        try {
          await inspector.waitFor({ timeout: 4_000 });
        } catch {
          continue;
        }
        // A menu that resolved nothing offers no action; that one is not worth
        // a picture either.
        if ((await page.locator('[data-testid="object-inspector-no-id"]').count()) > 0) {
          await page.keyboard.press("Escape");
          continue;
        }
        // Leave the pointer on the object so the hover card is in the shot too.
        await page.mouse.move(point.x + 2, point.y + 2);
        opened = true;
        break;
      }
      if (!opened) throw new Error("no right-click over the model opened an object menu");
      await page.waitForTimeout(700);
      await shoot(page, "screenshot-objects.png", page);
      await page.close();
    },
  },
];

// ---------------------------------------------------------------------------

async function main() {
  const selected = ONLY.length === 0 ? SHOTS : SHOTS.filter((shot) => ONLY.includes(shot.name));
  if (selected.length === 0) {
    throw new Error(`--only matched no shot; names: ${SHOTS.map((s) => s.name).join(", ")}`);
  }

  let server;
  if (!(await serverIsUp(BASE_URL))) {
    server = await startServer();
  } else {
    log(`reusing the server already answering ${BASE_URL}`);
  }

  /**
   * Every shot gets its OWN browser, and therefore its own empty
   * `localStorage` and its own software renderer.
   *
   * A fresh context alone is not enough on two counts. The layout, the
   * expanded groups and the last location all persist per device, so a second
   * shot in a shared context starts where the first left off: the preset is
   * already active, clicking it changes nothing, and the picture is of a page
   * that never built. And each shot builds all 992 Chicago buildings through
   * manifold WASM and draws them through SwiftShader; the third such build in
   * one browser process stopped arriving at all here, while the same shot on
   * its own is fine. A process per shot is a second of launch against that.
   */
  async function attempt(shot) {
    const browser = await chromium.launch({
      headless: !HEADED,
      // Headless Chromium has no GPU here and needs the flag before it falls
      // back to SwiftShader, which is what the r3f preview draws through.
      args: ["--enable-unsafe-swiftshader", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({
      baseURL: BASE_URL,
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: "light",
      reducedMotion: "reduce",
      permissions: [],
    });
    try {
      await shot.capture(context);
    } finally {
      await context.close();
      await browser.close();
    }
  }

  const failed = [];
  try {
    for (const shot of selected) {
      log(`${shot.name}: ${shot.description}`);
      // Against a dev server, a save by anyone recompiles and reloads the page
      // mid-run, which loses the model. Retry rather than write that picture.
      for (let tries = 1; ; tries += 1) {
        try {
          await attempt(shot);
          break;
        } catch (error) {
          const line = error.message.split("\n")[0];
          if (tries >= 3) {
            // One shot failing must not cost the others: the run reports what
            // it could not take and fails at the end, having taken the rest.
            log(`${shot.name}: GAVE UP after ${tries} attempts (${line})`);
            failed.push(shot.name);
            break;
          }
          log(`${shot.name}: attempt ${tries} failed (${line}), retrying`);
        }
      }
    }
  } finally {
    stopServer(server);
  }

  if (!existsSync(OUT_DIR)) throw new Error(`nothing was written to ${OUT_DIR}`);
  const taken = selected.length - failed.length;
  log(`done: ${taken} of ${selected.length} shot(s) in ${path.relative(REPO_ROOT, OUT_DIR)}`);
  if (failed.length > 0) throw new Error(`shots not taken: ${failed.join(", ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
