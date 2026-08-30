import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page, type Request } from "@playwright/test";

/**
 * The FrameCraft smoke test: 01's primary user flow, end to end, against the
 * REAL stack (next on :3000 -> FastAPI on :8000 -> the committed Overpass
 * fixtures). Nothing here is mocked; a route interception would defeat the
 * purpose of a gate.
 *
 * What it pins down, by 01's acceptance criteria:
 *   A1  preset -> preview in under 5 s on a warm cache, measured and asserted
 *   A2  a pin in open water shows the low-coverage warning and blocks Bake
 *   A3  no server call on a PrintParams slider, and no page reload
 *   A4  bake -> done -> download link in under 90 s
 *   A5  the downloaded .3mf passes `python -m app.cli validate` (exit 0)
 *   A7  it only runs at all because `make up` brought the stack up
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const API_URL = process.env.NEXT_PUBLIC_BAKE_API_URL ?? "http://localhost:8000";

/**
 * 01/A1, literally: five seconds, on a warm cache. The timed click is the
 * SECOND Chicago click (see the happy path, step 3); the first one, on a clean
 * clone, parses a 12 MB Overpass fixture server-side and is not what A1 means.
 */
// Shared CI runners are two to three times slower than a dev laptop; the factor
// scales the wall-clock budgets only, never the assertions on the file itself.
const BUDGET_FACTOR = Number(process.env.E2E_BUDGET_FACTOR ?? 1) || 1;
const A1_BUDGET_MS = 5_000 * BUDGET_FACTOR;
/** How long the untimed warm-up clicks may take before the test gives up. */
const WARMUP_BUDGET_MS = 60_000;
/** 01/A4, literally: a Chicago bake reaches a download link in under 90 s. */
const A4_BUDGET_MS = 90_000;

/** Content types a .3mf download may legitimately carry. */
const THREEMF_CONTENT_TYPES = [
  "application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
  "application/octet-stream",
];

interface ApiCall {
  method: string;
  path: string;
}

/** Record every request the page makes to the bake API. */
function watchApi(page: Page): ApiCall[] {
  const calls: ApiCall[] = [];
  page.on("request", (request: Request) => {
    const url = request.url();
    if (url.startsWith(API_URL)) {
      calls.push({ method: request.method(), path: new URL(url).pathname });
    }
  });
  return calls;
}

const scenePosts = (calls: ApiCall[]): ApiCall[] =>
  calls.filter((call) => call.method === "POST" && call.path === "/scene");

/** The building count the preview HUD chip is currently reporting, or 0. */
function buildingsIn(statsText: string | null): number {
  return Number(/(\d+)\s+buildings/.exec(statsText ?? "")?.[1] ?? "0");
}

/** Count main-frame navigations, i.e. page reloads. */
function watchNavigations(page: Page): () => number {
  let count = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) count += 1;
  });
  return () => count;
}

/**
 * Move a range input the way a user does: set the value, then fire the same
 * input/change events React listens for. `fill` does exactly that and does NOT
 * fire pointerup/keyup, which is what makes it the right tool for asserting
 * that a PrintParams slider costs no request.
 */
async function setSlider(page: Page, id: string, value: number): Promise<void> {
  await page.locator(`#${id}`).fill(String(value));
}

/** Press a range input's arrow key, which DOES commit (radius / rotation). */
async function nudgeSlider(page: Page, id: string, key: string): Promise<void> {
  const slider = page.locator(`#${id}`);
  await slider.focus();
  await slider.press(key);
}

function log(message: string): void {
  // Surfaced by the `list` reporter and captured in artifacts/logs/gate.log.
  console.log(`[smoke] ${message}`);
}

/**
 * Delete the per-run Overpass fixtures a non-preset `/scene` leaves behind.
 *
 * `overpass.load_raw` caches every raw response as `fixtures/<sha1>.json`, so
 * the low-coverage test (a pin the user drops, i.e. never a preset) writes one
 * file per run. `presets-index.json` is the list of the six that are meant to
 * be there; anything else sha1-named is this run's garbage. Same rule as
 * `python -m app.cli refresh-fixtures`.
 */
function pruneStrayFixtures(): void {
  const dir = path.join(REPO_ROOT, "fixtures");
  const indexPath = path.join(dir, "presets-index.json");
  if (!fs.existsSync(indexPath)) return;
  const index = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as {
    presets: Array<{ fixture_file: string }>;
  };
  const keep = new Set(index.presets.map((preset) => preset.fixture_file));
  for (const name of fs.readdirSync(dir)) {
    if (/^[0-9a-f]{40}\.json$/.test(name) && !keep.has(name)) {
      fs.rmSync(path.join(dir, name));
      log(`pruned stray Overpass fixture ${name}`);
    }
  }
}

test.describe.configure({ mode: "serial" });

test.afterAll(() => {
  pruneStrayFixtures();
});

// ==========================================================================
// The happy path
// ==========================================================================

test("happy path: Chicago preset previews, sliders stay local, bake downloads a valid 3MF", async ({
  page,
  request,
}) => {
  const calls = watchApi(page);
  const navigations = watchNavigations(page);
  const crashes: string[] = [];
  page.on("pageerror", (error) => crashes.push(error.message));
  // A missing site icon is a 404 the browser logs to the console on EVERY page
  // load. `app/icon.svg` + `app/favicon.ico` (the App Router metadata
  // convention) are what stop it; this catches their removal.
  const missingIcons: string[] = [];
  page.on("response", (response) => {
    const name = new URL(response.url()).pathname.split("/").pop() ?? "";
    if (response.status() === 404 && /^(favicon\.ico|icon\.svg)$/.test(name)) {
      missingIcons.push(`${response.status()} ${response.url()}`);
    }
  });

  // ---- 1. land on / -----------------------------------------------------
  await page.goto("/");
  await expect(page.locator("footer")).toContainText("© OpenStreetMap contributors");
  // The document declares an icon, so the browser never falls back to a bare
  // /favicon.ico guess.
  await expect(page.locator('link[rel~="icon"]').first()).toHaveCount(1);

  // ---- 2. the six presets are listed ------------------------------------
  const presetButtons = page.getByTestId("preset-row").getByRole("button");
  await expect(presetButtons).toHaveCount(6);
  const chicago = page.locator('[data-preset-id="chicago-loop"]');
  await expect(chicago).toHaveText("Chicago — Loop");

  // A marker that only survives if the page is never reloaded (01 step 4).
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__framecraftE2E = "alive";
  });

  // ---- 3. pick Chicago; the preview appears -----------------------------
  // 01/A1 says five seconds on a WARM cache, so the click that gets timed is
  // the second Chicago click. Warm up first: Chicago (cold - a clean clone
  // parses a 12 MB Overpass fixture server-side here), then a second preset,
  // then Chicago again. Going away and coming back is also what makes the
  // measurement honest: the HUD building count has to change and change back,
  // so the timed click really did rebuild the preview.
  const canvas = page.getByTestId("preview-canvas");
  const previewStats = page.getByTestId("preview-stats");

  await chicago.click();
  await expect(canvas).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await expect(previewStats).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  const chicagoBuildings = buildingsIn(await previewStats.textContent());
  expect(chicagoBuildings).toBeGreaterThan(500);

  const otherPreset = page.locator('[data-preset-id="san-francisco-fidi"]');
  await otherPreset.click();
  await expect
    .poll(async () => buildingsIn(await previewStats.textContent()), {
      timeout: WARMUP_BUDGET_MS,
      intervals: [50],
    })
    .not.toBe(chicagoBuildings);

  const beforePreset = scenePosts(calls).length;
  const startedAt = Date.now();
  await chicago.click();
  await expect
    .poll(async () => buildingsIn(await previewStats.textContent()), {
      timeout: A1_BUDGET_MS,
      intervals: [20],
    })
    .toBe(chicagoBuildings);
  await expect(canvas).toBeVisible();
  const previewMs = Date.now() - startedAt;
  log(`A1 warm preset click -> preview: ${(previewMs / 1000).toFixed(2)} s (01/A1 budget ${A1_BUDGET_MS / 1000} s)`);
  expect(previewMs).toBeLessThan(A1_BUDGET_MS);

  // ...through exactly one POST /scene.
  expect(scenePosts(calls).length - beforePreset).toBe(1);

  // WebGL really produced a canvas, not just the wrapper div.
  await expect(canvas.locator("canvas")).toBeAttached();

  // ---- 4. the scene is the real Chicago, with no coverage warning -------
  const statsText = (await previewStats.textContent()) ?? "";
  const buildings = buildingsIn(statsText);
  log(`Chicago preview: ${statsText.trim()}`);
  expect(buildings).toBe(chicagoBuildings);
  expect(buildings).toBeGreaterThan(500);
  await expect(page.getByTestId("warning-coverage-empty")).toHaveCount(0);
  await expect(page.getByTestId("warning-coverage-sparse")).toHaveCount(0);
  await expect(page.getByTestId("scene-error")).toHaveCount(0);

  // ---- 5. PrintParams sliders: no request, no reload (01 step 4, A3) ----
  const beforeSliders = calls.length;
  const navigationsBefore = navigations();

  await setSlider(page, "plate_mm", 200);
  await expect(page.getByTestId("plate_mm-value")).toHaveText("200 mm");
  await setSlider(page, "large_scale", 120);
  await expect(page.getByTestId("large_scale-value")).toHaveText("120 %");
  await page.getByRole("radio", { name: "emboss" }).click();
  await page.getByRole("radio", { name: "engrave" }).click();
  await setSlider(page, "base_thickness_mm", 4);
  await expect(page.getByTestId("base_thickness_mm-value")).toHaveText("4.0 mm");

  // Give any stray request time to appear before asserting there was none.
  await page.waitForTimeout(1_500);
  const sliderCalls = calls.slice(beforeSliders);
  expect(
    sliderCalls,
    `a PrintParams change hit the bake API: ${JSON.stringify(sliderCalls)}`,
  ).toEqual([]);
  expect(navigations()).toBe(navigationsBefore);
  expect(
    await page.evaluate(
      () => (window as unknown as Record<string, string>).__framecraftE2E,
    ),
  ).toBe("alive");
  await expect(previewStats).toBeVisible();

  // ---- 5b. A3's frame rate, measured and reported ----------------------
  // Drive one height slider on every animation frame for two seconds and count
  // the frames that actually landed. 01/A3 asks for 30 fps on a 3000-building
  // scene; this host renders headless Chromium through SwiftShader (no GPU),
  // where one idle frame of the Chicago preview already costs ~45 ms
  // (DECISIONS [P4]), so the number is REPORTED, and only a catastrophic floor
  // is asserted. Re-measure on real GPU hardware before claiming A3.
  const fps = await page.evaluate(async () => {
    const slider = document.getElementById("small_scale") as HTMLInputElement | null;
    if (!slider) return 0;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    if (!setter) return 0;
    const startedAt = performance.now();
    let frames = 0;
    await new Promise<void>((resolve) => {
      const tick = () => {
        const elapsed = performance.now() - startedAt;
        if (elapsed >= 2_000) {
          resolve();
          return;
        }
        setter.call(slider, String(100 + (frames % 8) * 5));
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        frames += 1;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return Math.round((frames / (performance.now() - startedAt)) * 1000);
  });
  log(`A3 slider-driven frame rate: ${fps} fps on ${buildings} buildings (headless SwiftShader, no GPU; 01 target is 30 fps on real hardware)`);
  expect(fps, "the preview stopped rendering while a slider moved").toBeGreaterThan(4);
  // Still no server call: the whole point of A3's second half.
  expect(calls.slice(beforeSliders)).toEqual([]);
  await setSlider(page, "small_scale", 100);

  // ---- 6. rotation IS a location change: exactly one new POST /scene ----
  const beforeRotation = scenePosts(calls).length;
  await nudgeSlider(page, "rotation_deg", "ArrowRight");
  await expect(page.getByTestId("rotation_deg-value")).toHaveText("1°");
  // The commit is debounced by 250 ms and then fetches; wait well past that.
  await expect
    .poll(() => scenePosts(calls).length - beforeRotation, { timeout: 20_000 })
    .toBe(1);
  await page.waitForTimeout(2_000);
  expect(scenePosts(calls).length - beforeRotation).toBe(1);

  // Back to 0 so the bake runs on the preset (fixture-backed, no network).
  await nudgeSlider(page, "rotation_deg", "ArrowLeft");
  await expect(page.getByTestId("rotation_deg-value")).toHaveText("0°");
  await expect(page.getByTestId("generate-button")).toHaveText(/^Generate$/, {
    timeout: 120_000,
  });
  await expect(page.getByTestId("scene-error")).toHaveCount(0);
  await expect(previewStats).toBeVisible();

  // ---- 7. bake, poll to done -------------------------------------------
  const bakeButton = page.getByTestId("bake-button");
  await expect(bakeButton).toBeEnabled();
  const bakeStartedAt = Date.now();
  await bakeButton.click();
  await expect(page.getByTestId("bake-status")).toBeVisible();

  // The bar starts indeterminate (nothing has been reported yet) and must
  // become determinate: `BakeResult.progress` is real, per-stage, and a bar
  // that spins for 14 s while the server knows the number is a lie.
  const progressBar = page.getByTestId("bake-progress");
  await expect(progressBar).toBeVisible();
  await expect
    .poll(() => progressBar.getAttribute("data-determinate"), { timeout: A4_BUDGET_MS })
    .toBe("true");
  log(`bake progress bar reached ${await progressBar.getAttribute("data-progress")}%`);

  const downloads = page.getByTestId("download-links");
  await expect(downloads).toBeVisible({ timeout: A4_BUDGET_MS });
  const bakeMs = Date.now() - bakeStartedAt;
  log(`A4 bake -> done: ${(bakeMs / 1000).toFixed(1)} s (01/A4 budget ${A4_BUDGET_MS / 1000} s)`);
  expect(bakeMs).toBeLessThan(A4_BUDGET_MS);
  await expect(page.getByTestId("bake-status")).toContainText("Done");

  // ---- 8. the stats card (01 step 5) ------------------------------------
  const statsCard = page.getByTestId("stats-card");
  await expect(statsCard).toBeVisible();
  const cardText = (await statsCard.textContent()) ?? "";
  log(`stats card: ${cardText.replace(/\s+/g, " ").trim()}`);
  await expect(statsCard).toContainText("Triangles");
  await expect(statsCard).toContainText("Volume");
  await expect(statsCard).toContainText("Bounding box");
  await expect(statsCard).toContainText("Filament (estimate)");
  await expect(statsCard).toContainText("Manifold");
  expect(cardText).toMatch(/Triangles\s*[\d,]+/);
  expect(cardText).toMatch(/mm³/);
  expect(cardText).toMatch(/\d+\.\d\s*×\s*\d+\.\d\s*×\s*\d+\.\d\s*mm/);
  expect(cardText).toMatch(/\d+\.\d\s*g/);
  expect(cardText).toMatch(/Manifold\s*yes/);

  // ---- 9. the download link really serves a 3MF ------------------------
  const link = downloads.getByRole("link", { name: /3MF/ });
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  expect(href, "the 3MF link has no href").toBeTruthy();
  log(`3MF href: ${href}`);

  const response = await request.get(href as string);
  expect(response.status()).toBe(200);
  const contentType = (response.headers()["content-type"] ?? "").split(";")[0].trim();
  expect(THREEMF_CONTENT_TYPES).toContain(contentType);
  const body = await response.body();
  expect(body.length).toBeGreaterThan(0);
  // A 3MF is an OPC package: it must start with the zip local-file signature.
  expect(body.subarray(0, 2).toString("latin1")).toBe("PK");
  log(`3MF download: ${contentType}, ${body.length.toLocaleString("en-US")} bytes`);

  const outDir = path.join(REPO_ROOT, "artifacts", "e2e");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "chicago-e2e.3mf");
  fs.writeFileSync(outFile, body);

  // The bake writes a `<stem>.json` sidecar carrying the PrintParams it used,
  // and `make validate` reads it. Fetching it too is what lets the validator
  // judge the file against the 200 mm plate the sliders actually asked for,
  // instead of the contract default.
  const sidecarName = path.basename(href as string).replace(/\.3mf$/i, ".json");
  const sidecar = await request.get(`${API_URL}/files/${sidecarName}`);
  expect(sidecar.status(), `no bake sidecar at /files/${sidecarName}`).toBe(200);
  fs.writeFileSync(path.join(outDir, "chicago-e2e.json"), await sidecar.body());

  // ---- 10. and it passes the printability validator (A5) ---------------
  const validate = spawnSync(`uv run python -m app.cli validate "${outFile}"`, {
    cwd: path.join(REPO_ROOT, "services", "bake"),
    shell: true,
    encoding: "utf-8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    timeout: 300_000,
  });
  const validatorOutput = `${validate.stdout ?? ""}${validate.stderr ?? ""}`;
  log(`validator on the downloaded file:\n${validatorOutput}`);
  expect(validate.status, validatorOutput).toBe(0);
  expect(validatorOutput).toContain("ALL CHECKS PASS");
  // It judged the file against the parameters the bake really used.
  expect(validatorOutput).toContain("sidecar chicago-e2e.json");
  expect(validatorOutput).toContain("plate 200 mm");

  // ---- 11. moving a slider retires the finished bake -------------------
  // 01's promise is that the preview and the printed result agree, so a bake
  // whose parameters have since moved may not stay downloadable.
  const beforeStale = scenePosts(calls).length;
  await setSlider(page, "small_scale", 110);
  await expect(page.getByTestId("bake-stale-note")).toBeVisible();
  await expect(page.getByTestId("download-links")).toHaveCount(0);
  await expect(page.getByTestId("bake-status")).toContainText("outdated");
  await expect(page.getByTestId("stats-card")).toContainText("previous bake");
  // ...and retiring it is still a purely client-side change.
  expect(scenePosts(calls).length - beforeStale).toBe(0);

  // Nothing crashed on the way through, and nothing 404'd for an icon.
  expect(crashes, `uncaught page errors: ${crashes.join(" | ")}`).toEqual([]);
  expect(missingIcons, `site icon 404s: ${missingIcons.join(" | ")}`).toEqual([]);
});

// ==========================================================================
// A2: the low-coverage path
// ==========================================================================

test("low coverage: a pin in open water warns and disables Bake", async ({
  page,
  request,
}) => {
  // Chicago Loop is the reference point; the target is ~14 km east of it, well
  // out in Lake Michigan, where OSM has nothing at all.
  const presetsResponse = await request.get(`${API_URL}/presets`);
  expect(presetsResponse.status()).toBe(200);
  const presets = (await presetsResponse.json()) as Array<{
    preset_id: string | null;
    lat: number;
    lon: number;
    radius_m: number;
  }>;
  const chicagoPreset = presets.find((preset) => preset.preset_id === "chicago-loop");
  expect(chicagoPreset, "the chicago-loop preset is missing from GET /presets").toBeTruthy();
  const origin = chicagoPreset as { lat: number; lon: number; radius_m: number };
  const target = { lat: 41.9, lon: -87.45 };

  // Both the status AND the body: the only legitimate reason to skip this test
  // is that Overpass is unreachable, and a bake API started with
  // FRAMECRAFT_OFFLINE=1 answers /scene with the very same 503 (main.py maps
  // OverpassOffline -> 503). See the skip below.
  const sceneResponses: Array<{ status: number; body: Promise<string> }> = [];
  page.on("response", (response) => {
    if (response.url().startsWith(API_URL) && new URL(response.url()).pathname === "/scene") {
      sceneResponses.push({
        status: response.status(),
        body: response.text().catch(() => ""),
      });
    }
  });

  await page.goto("/");
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-stats")).toBeVisible({ timeout: WARMUP_BUDGET_MS });

  // The map draws its pin and its radius handle at two known geographic
  // points, so their pixel positions calibrate metres -> pixels exactly.
  const map = page.getByTestId("map");
  const pin = page.getByTestId("map-pin");
  const handle = page.getByTestId("map-radius-handle");
  await expect(pin).toBeVisible();
  await expect(handle).toBeVisible();
  await page.waitForTimeout(1_500); // the preset fitBounds animation

  const centreOf = async (locator: ReturnType<Page["getByTestId"]>) => {
    const box = await locator.boundingBox();
    expect(box, "a map marker has no bounding box").toBeTruthy();
    const value = box as { x: number; y: number; width: number; height: number };
    return { x: value.x + value.width / 2, y: value.y + value.height / 2 };
  };

  const pinBefore = await centreOf(pin);
  const handleBefore = await centreOf(handle);
  const pixelsPerMetre =
    Math.hypot(handleBefore.x - pinBefore.x, handleBefore.y - pinBefore.y) /
    origin.radius_m;
  expect(pixelsPerMetre).toBeGreaterThan(0);

  // Zoom out five steps so 14 km of lake fits on screen. Each click of the
  // control is exactly one zoom level, i.e. half the scale.
  const zoomOut = page.locator(".maplibregl-ctrl-zoom-out");
  const ZOOM_STEPS = 5;
  for (let step = 0; step < ZOOM_STEPS; step += 1) {
    await zoomOut.click();
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(1_200);

  const scale = pixelsPerMetre / 2 ** ZOOM_STEPS;
  const pinAfter = await centreOf(pin);
  const handleAfter = await centreOf(handle);
  const measured =
    Math.hypot(handleAfter.x - pinAfter.x, handleAfter.y - pinAfter.y) / origin.radius_m;
  expect(
    Math.abs(measured / scale - 1),
    `the map did not zoom out ${ZOOM_STEPS} steps (scale ${measured} vs ${scale} px/m)`,
  ).toBeLessThan(0.4);

  // Local ENU offset from the pin to the target, in metres, then in pixels.
  const eastM =
    (target.lon - origin.lon) * 111_320 * Math.cos((origin.lat * Math.PI) / 180);
  const northM = (target.lat - origin.lat) * 110_574;
  const clickAt = { x: pinAfter.x + eastM * scale, y: pinAfter.y - northM * scale };

  const mapBox = await map.boundingBox();
  expect(mapBox).toBeTruthy();
  const frame = mapBox as { x: number; y: number; width: number; height: number };
  expect(clickAt.x).toBeGreaterThan(frame.x + 40);
  expect(clickAt.x).toBeLessThan(frame.x + frame.width - 60);
  expect(clickAt.y).toBeGreaterThan(frame.y + 60);
  expect(clickAt.y).toBeLessThan(frame.y + frame.height - 40);

  await page.mouse.click(clickAt.x, clickAt.y);

  // The pin followed the click, so the store really took the new location.
  await expect(page.getByTestId("scene-stale")).toBeVisible();
  const pinDropped = await centreOf(pin);
  expect(Math.hypot(pinDropped.x - clickAt.x, pinDropped.y - clickAt.y)).toBeLessThan(6);
  await expect(page.getByTestId("generate-button")).toHaveText("Regenerate");

  // Generate: this one is a live Overpass query (it is not a preset).
  const before = sceneResponses.length;
  await page.getByTestId("generate-button").click();
  await expect
    .poll(() => sceneResponses.length - before, { timeout: 180_000 })
    .toBeGreaterThan(0);
  const last = sceneResponses[sceneResponses.length - 1];
  const status = last.status;
  const detail = await last.body;

  // This used to be a conditional test-level skip on `status === 502 || 503`:
  // an unreachable Overpass was treated as an infrastructure excuse. It is not
  // one the gate can accept. `make gate` already fails on any skipped test
  // (results.json `stats.skipped`), so the skip only changed the WORDING of the
  // failure -- and a conditional skip in the suite makes the gate's static
  // no-skip guard impossible to state absolutely. The assertion below is
  // therefore strictly stronger than what it replaces, and carries the two
  // diagnoses the skip used to print.
  //
  // The second one matters: `make up` passes the caller's environment through,
  // and a bake API started with FRAMECRAFT_OFFLINE=1 -- the variable this
  // repo's own test convention exports -- answers /scene with the very same
  // 503. That is not "Overpass is unreachable", it is "A2 was never
  // exercised", and it must be impossible to mistake for one.
  if (status === 502 || status === 503) {
    expect(
      detail,
      "the bake API is running with FRAMECRAFT_OFFLINE set, so A2 never reached " +
        "Overpass; start the stack without it (make gate does)",
    ).not.toContain("FRAMECRAFT_OFFLINE");
  }
  expect(
    status,
    `POST /scene did not answer 200. If this is ${status}, Overpass is ` +
      `unreachable from this host and 01/A2 cannot be exercised: ` +
      `${detail.slice(0, 300)}`,
  ).toBe(200);

  const warning = page.getByTestId("warning-coverage-empty");
  await expect(warning).toBeVisible({ timeout: 30_000 });
  await expect(warning).toContainText("Fewer than 20 buildings");
  log(`low coverage banner: ${(await warning.textContent())?.trim()}`);

  await expect(page.getByTestId("bake-button")).toBeDisabled();
  await expect(page.getByTestId("bake-block-reason")).toContainText(
    "Fewer than 20 buildings",
  );
  // A2: a warning, not an empty canvas and not a crash.
  await expect(page.getByTestId("preview-canvas")).toBeVisible();
});
