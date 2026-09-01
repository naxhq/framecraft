import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { expect, test, type Page } from "@playwright/test";

import { mockChicagoOverpass, mockEmptyOverpass, mockTinyLoopOverpass, watchOverpass, type OverpassCall } from "./overpassMock";

/**
 * The FrameCraft smoke test: 01's primary user flow, end to end.
 *
 * Since FrameCraft v3 E4 the app never calls `services/bake` at all: ingest
 * (Overpass) and the bake (manifold3d) both run in the browser. This suite
 * therefore runs fully offline -- every Overpass mirror is route-mocked from
 * a committed fixture (`overpassMock.ts`), never the real service -- and
 * `services/bake` is used only as the CLI printability validator, exactly as
 * `make gate`'s own browser-engine step uses it.
 *
 * What it pins down, by 01's acceptance criteria:
 *   A1  preset -> preview in under the budget, measured and asserted
 *   A2  an empty Overpass response shows the low-coverage warning and blocks Bake
 *   A3  no fetch on a PrintParams slider, and no page reload
 *   A4  bake -> done -> a Blob download link in under 90 s
 *   A5  the downloaded file passes `python -m app.cli validate` (exit 0),
 *       proven twice: a small synthetic scene and, separately, the full
 *       Chicago scene at real complexity (audit v3-02 finding 12's restored
 *       assertion; DECISIONS.md [V3-P2-E4] records the min-wall gap that used
 *       to make the Chicago-scale check unreliable as closed). The happy
 *       path's own Chicago download stays a structural (zip-magic) check
 *       only, because it exports the default `bambu-3mf`, a format the
 *       reference validator's `trimesh`-based loader cannot read regardless
 *       of geometry quality -- a permanent limitation, not the gap that
 *       closed.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const BUDGET_FACTOR = Number(process.env.E2E_BUDGET_FACTOR ?? 1) || 1;
const A1_BUDGET_MS = 5_000 * BUDGET_FACTOR;
// Every WebGL-heavy wait scales with E2E_BUDGET_FACTOR, not just A1: a CI
// runner's software WebGL (SwiftShader on two cores) is measurably slower
// than a dev machine at every one of these, not only the one budget that
// happened to get a literal number first.
const WARMUP_BUDGET_MS = 60_000 * BUDGET_FACTOR;
const A4_BUDGET_MS = 90_000 * BUDGET_FACTOR;

const ingestFetches = (calls: OverpassCall[]): number =>
  calls.filter((call) => call.method === "POST").length;

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
 * that a PrintParams slider costs no fetch.
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

/** Fetch a Blob object URL's bytes from inside the page (Node's `request` fixture cannot reach a `blob:` URL). */
async function fetchBlob(page: Page, url: string): Promise<Buffer> {
  const base64 = await page.evaluate(async (blobUrl) => {
    const response = await fetch(blobUrl);
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }, url);
  return Buffer.from(base64, "base64");
}

test.describe.configure({ mode: "serial" });

// ==========================================================================
// The happy path
// ==========================================================================

test("happy path: Chicago preset previews, sliders stay local, bake downloads a 3MF", async ({
  page,
}) => {
  const calls = watchOverpass(page);
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
  await mockChicagoOverpass(page);
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
  // 01/A1 says under budget on a WARM run, so the click that gets timed is the
  // SECOND Chicago click. Warm up first: Chicago, then a second preset backed
  // by a DIFFERENT mocked response (so the HUD building count really has to
  // change and change back, proving the timed click rebuilt the preview and
  // not merely re-rendered a cached one), then Chicago again.
  const canvas = page.getByTestId("preview-canvas");
  const previewStats = page.getByTestId("preview-stats");

  await chicago.click();
  await expect(canvas).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await expect(previewStats).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  const chicagoBuildings = buildingsIn(await previewStats.textContent());
  expect(chicagoBuildings).toBeGreaterThan(500);

  await page.unroute("**/api/interpreter");
  await mockTinyLoopOverpass(page);
  const otherPreset = page.locator('[data-preset-id="san-francisco-fidi"]');
  await otherPreset.click();
  await expect
    .poll(async () => buildingsIn(await previewStats.textContent()), {
      timeout: WARMUP_BUDGET_MS,
      intervals: [50],
    })
    .not.toBe(chicagoBuildings);

  await page.unroute("**/api/interpreter");
  await mockChicagoOverpass(page);
  const beforePreset = ingestFetches(calls);
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

  // ...through at most one ingest fetch, never more. `protocol.ts`'s Overpass
  // cache is a real 7-day TTL keyed by query text (`osm/overpass.ts`), and
  // this Chicago click sends the byte-identical query the first click already
  // cached, so a clean cache hit costs ZERO network fetches -- the point this
  // assertion actually guards is that returning to a preset never re-fires
  // the request twice (a debounce or dedupe bug), not that a fetch happens at
  // all. The poll above already proves a real rebuild ran either way: a stale
  // re-render could not have taken the HUD from the other preset's building
  // count back to `chicagoBuildings`. See DECISIONS.md [V3-P2-E4].
  const newIngestFetches = ingestFetches(calls) - beforePreset;
  log(`A1 warm Chicago click cost ${newIngestFetches} ingest fetch(es) (0 = cache hit, 1 = cache miss)`);
  expect(newIngestFetches).toBeLessThanOrEqual(1);

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

  // ---- 5. PrintParams sliders: no fetch, no reload (01 step 4, A3) ------
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

  // Give any stray request time to appear before asserting there was none. The
  // debounced engine job (a WASM bake, never a fetch) runs in here too.
  await page.waitForTimeout(1_500);
  const sliderCalls = calls.slice(beforeSliders);
  expect(
    sliderCalls,
    `a PrintParams change triggered a fetch: ${JSON.stringify(sliderCalls)}`,
  ).toEqual([]);
  expect(navigations()).toBe(navigationsBefore);
  expect(
    await page.evaluate(
      () => (window as unknown as Record<string, string>).__framecraftE2E,
    ),
  ).toBe("alive");
  await expect(previewStats).toBeVisible();

  // ---- 5b. A3's frame rate: the preview keeps rendering, measured and
  //          reported, asserted by waiting for progress rather than by
  //          sampling a fixed window --------------------------------------
  //
  // A fixed "run for exactly 2 s, expect > N frames" window is exactly the
  // kind of assertion a slow, oversubscribed CI runner (software WebGL,
  // two cores) can miss even when the preview is working correctly -- it
  // measures a RATE against a wall-clock window, and the window itself is
  // not scaled by E2E_BUDGET_FACTOR. Polling for the frame counter to
  // advance past where it started asks the real question instead ("does
  // driving a slider on every frame still produce frames at all, without
  // ever leaving the browser tab") and its own timeout scales the same way
  // every other WebGL-heavy wait in this file does.
  const started = await page.evaluate(() => {
    const slider = document.getElementById("small_scale") as HTMLInputElement | null;
    if (!slider) return false;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    if (!setter) return false;
    const state = { frames: 0, startedAt: performance.now(), handle: 0 };
    (window as unknown as Record<string, unknown>).__framecraftFrameCounter = state;
    const tick = () => {
      setter.call(slider, String(100 + (state.frames % 8) * 5));
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      state.frames += 1;
      state.handle = requestAnimationFrame(tick);
    };
    state.handle = requestAnimationFrame(tick);
    return true;
  });
  expect(started, "the small_scale slider was not on the page").toBe(true);

  const frameCount = () =>
    page.evaluate(
      () =>
        (
          (window as unknown as Record<string, unknown>).__framecraftFrameCounter as
            | { frames: number }
            | undefined
        )?.frames ?? 0,
    );
  const before = await frameCount();
  await expect
    .poll(frameCount, {
      message: "the preview stopped rendering while a slider moved",
      timeout: 10_000 * BUDGET_FACTOR,
    })
    .toBeGreaterThan(before);

  // Let it run a little longer, still bounded, purely to REPORT a measured
  // rate -- 01/A3 asks for 30 fps on a 3000-building scene; this host has no
  // GPU (SwiftShader), so the number is informational, not asserted.
  await page.waitForTimeout(1_500 * BUDGET_FACTOR);
  const fpsInfo = await page.evaluate(() => {
    const state = (window as unknown as Record<string, unknown>).__framecraftFrameCounter as
      | { frames: number; startedAt: number; handle: number }
      | undefined;
    if (!state) return { fps: 0, frames: 0 };
    cancelAnimationFrame(state.handle);
    const fps = Math.round((state.frames / (performance.now() - state.startedAt)) * 1000);
    return { fps, frames: state.frames };
  });
  log(`A3 slider-driven frame rate: ${fpsInfo.fps} fps, ${fpsInfo.frames} frames on ${buildings} buildings (headless SwiftShader, no GPU; 01 target is 30 fps on real hardware)`);

  // Still no fetch: the whole point of A3's second half.
  expect(calls.slice(beforeSliders)).toEqual([]);
  await setSlider(page, "small_scale", 100);

  // ---- 6. rotation IS a location change: exactly one new ingest fetch ---
  const beforeRotation = ingestFetches(calls);
  const t6 = Date.now();
  await nudgeSlider(page, "rotation_deg", "ArrowRight");
  await expect(page.getByTestId("rotation_deg-value")).toHaveText("1°");
  // The commit is debounced by 250 ms and then re-ingests; wait well past
  // that. The worker also has to finish whatever `small_scale`'s own engine
  // job is running first: `EngineClient.bake()` cannot preempt a bake once
  // the worker has started it (`client.ts:supersedeBake`), so the A3 stress
  // test just above can leave a full Chicago-scale bake queued ahead of this
  // ingest message in the same worker. DECISIONS.md [V3-P2-E4].
  await expect
    .poll(() => ingestFetches(calls) - beforeRotation, { timeout: WARMUP_BUDGET_MS })
    .toBe(1);
  log(`A6 rotation nudge -> ingest fetch: ${((Date.now() - t6) / 1000).toFixed(1)} s`);
  await page.waitForTimeout(2_000);
  expect(ingestFetches(calls) - beforeRotation).toBe(1);

  // Back to 0 so the bake runs on the preset (fixture-backed, offline).
  const t6b = Date.now();
  await nudgeSlider(page, "rotation_deg", "ArrowLeft");
  await expect(page.getByTestId("rotation_deg-value")).toHaveText("0°");
  await expect(page.getByTestId("generate-button")).toHaveText(/^Generate$/, {
    timeout: WARMUP_BUDGET_MS,
  });
  await expect(page.getByTestId("scene-error")).toHaveCount(0);
  await expect(previewStats).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  log(`A6b rotation nudge back -> preview: ${((Date.now() - t6b) / 1000).toFixed(1)} s`);

  // ---- 7. the engine result and the stats card populate on their own ---
  // ("one truth: engine result when fresh", not gated on clicking Bake).
  const statsCard = page.getByTestId("stats-card");
  await expect(statsCard).toBeVisible({ timeout: A4_BUDGET_MS });
  await expect(statsCard).toContainText("Triangles", { timeout: A4_BUDGET_MS });
  const cardTextBeforeBake = (await statsCard.textContent()) ?? "";
  log(`stats card before Bake is even clicked: ${cardTextBeforeBake.replace(/\s+/g, " ").trim()}`);
  await expect(statsCard).toContainText("Volume");
  await expect(statsCard).toContainText("Bounding box");
  await expect(statsCard).toContainText("Filament (estimate)");
  await expect(statsCard).toContainText("Manifold");
  expect(cardTextBeforeBake).toMatch(/Triangles\s*[\d,]+/);
  expect(cardTextBeforeBake).toMatch(/mm³/);
  expect(cardTextBeforeBake).toMatch(/\d+\.\d\s*×\s*\d+\.\d\s*×\s*\d+\.\d\s*mm/);
  expect(cardTextBeforeBake).toMatch(/\d+\.\d\s*g/);

  // ---- 8. bake, and a Blob download link appears ------------------------
  const bakeButton = page.getByTestId("bake-button");
  await expect(bakeButton).toBeEnabled();
  const bakeStartedAt = Date.now();
  await bakeButton.click();
  await expect(page.getByTestId("bake-status")).toBeVisible();

  const downloads = page.getByTestId("download-links");
  await expect(downloads).toBeVisible({ timeout: A4_BUDGET_MS });
  const bakeMs = Date.now() - bakeStartedAt;
  log(`A4 bake -> done: ${(bakeMs / 1000).toFixed(1)} s (01/A4 budget ${A4_BUDGET_MS / 1000} s)`);
  expect(bakeMs).toBeLessThan(A4_BUDGET_MS);
  await expect(page.getByTestId("bake-status")).toContainText("Done");

  // ---- 9. the download link really is a well-formed 3MF (a real zip) ---
  //
  // NOT run through `python -m app.cli validate` here: this download is the
  // default `bambu-3mf` (a multi-part project), and the reference validator
  // reads a single `3D/3dmodel.model` part via `trimesh`'s stock 3MF loader,
  // which does not resolve Bambu's separate `3D/Objects/object_N.model`
  // parts -- a permanent format mismatch, not a geometry gap. The full
  // Chicago scene's GEOMETRY does now pass the validator cleanly
  // (DECISIONS.md [V3-P2-E4]; the min-wall gap that used to make this
  // unreliable is closed), proven end to end through the same
  // UI -> download -> CLI pipeline, at this same scale, via `generic-3mf`
  // (audit v3-02 finding 12's restored assertion) in "the downloaded file
  // passes the Python printability validator (full Chicago scene)" below.
  const meshLink = downloads.getByRole("link", { name: /\.3mf$/ });
  await expect(meshLink).toBeVisible();
  const href = await meshLink.getAttribute("href");
  expect(href, "the 3MF link has no href").toBeTruthy();
  expect(href, "the download is a Blob object URL, not a server path").toMatch(/^blob:/);
  log(`3MF href: ${href}`);

  const body = await fetchBlob(page, href as string);
  expect(body.length).toBeGreaterThan(0);
  // A 3MF is an OPC package: it must start with the zip local-file signature.
  expect(body.subarray(0, 2).toString("latin1")).toBe("PK");
  log(`3MF download: ${body.length.toLocaleString("en-US")} bytes`);

  const sidecarLink = downloads.getByRole("link", { name: /\.json$/ });
  await expect(sidecarLink).toBeVisible();
  const sidecarHref = await sidecarLink.getAttribute("href");
  const sidecarBody = await fetchBlob(page, sidecarHref as string);
  const sidecar = JSON.parse(sidecarBody.toString("utf-8")) as {
    print_params: { plate_mm: number };
    bake_result: { status: string };
  };
  expect(sidecar.print_params.plate_mm).toBe(200);
  expect(sidecar.bake_result.status).toBe("done");

  // ---- 10. moving a slider retires the finished bake --------------------
  // 01's promise is that the preview and the printed result agree, so a bake
  // whose parameters have since moved may not stay downloadable.
  const beforeStale = ingestFetches(calls);
  await setSlider(page, "small_scale", 110);
  await expect(page.getByTestId("bake-stale-note")).toBeVisible();
  await expect(page.getByTestId("download-links")).toHaveCount(0);
  await expect(page.getByTestId("bake-status")).toContainText("outdated");
  await expect(statsCard).toContainText("previous computation");
  // ...and retiring it never triggers a fetch either.
  expect(ingestFetches(calls) - beforeStale).toBe(0);

  // Nothing crashed on the way through, and nothing 404'd for an icon.
  expect(crashes, `uncaught page errors: ${crashes.join(" | ")}`).toEqual([]);
  expect(missingIcons, `site icon 404s: ${missingIcons.join(" | ")}`).toEqual([]);
});

// ==========================================================================
// A2: the low-coverage path
// ==========================================================================

test("low coverage: an empty Overpass response warns and disables Bake", async ({
  page,
}) => {
  // A synthetic near-empty response stands in for "a pin in open water":
  // since ingest is route-mocked, WHERE the pin lands no longer matters, only
  // that Overpass answers with nothing to build from.
  await mockEmptyOverpass(page);
  await page.goto("/");

  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("scene-error")).toHaveCount(0);

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

// ==========================================================================
// A5: the download -> validator pipeline, proven end to end
// ==========================================================================

test("the downloaded file passes the Python printability validator (small scene)", async ({
  page,
}) => {
  // A small (30-building) synthetic scene that -- unlike the full Chicago
  // fixture above -- bakes and validates cleanly end to end: proven directly
  // against `services/bake`'s own CLI while building this fixture (see
  // `docs/handoff/v3-02-integration.md`). `color_mode: "parts"` is set
  // because `services/bake/app/validate/checks.py`'s `bodies` check is
  // architecturally unable to pass in `single` mode (the engine partitions
  // regions; single mode only concatenates them, never welds a seam) --
  // `validate_parts()` is what actually checks "the assembled union is one
  // solid", which this engine's regions really are.
  await mockTinyLoopOverpass(page);
  await page.goto("/");
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-stats")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await expect(page.getByTestId("warning-coverage-empty")).toHaveCount(0);

  await page.getByTestId("group-colour-toggle").click();
  await page.locator("#color_mode").getByRole("radio", { name: "one per part" }).click();

  // The Python validator below judges the plain core-spec structure
  // `generic3mf.ts` writes (one `<object>` per part in the single
  // `3D/3dmodel.model` part); the default export target is `bambu-3mf`
  // (`contracts.ts`), a MULTI-PART project (`bambu3mf.ts`) whose mesh data
  // lives in a separate `3D/Objects/object_1.model` file the validator's
  // `3mf_objects`/`3mf_components`/`3mf_materials` checks do not resolve --
  // that combination is real, intentional, and has its own dedicated test
  // right below this one (Bambu Studio project structure). Select the format
  // this specific test actually means to prove. DECISIONS.md [V3-P2-E4].
  await page.locator("#export_target").selectOption("generic-3mf");

  const bakeButton = page.getByTestId("bake-button");
  await expect(bakeButton).toBeEnabled();
  await bakeButton.click();
  const downloads = page.getByTestId("download-links");
  await expect(downloads).toBeVisible({ timeout: A4_BUDGET_MS });

  const meshLink = downloads.getByRole("link", { name: /\.3mf$/ });
  const meshHref = await meshLink.getAttribute("href");
  const meshBody = await fetchBlob(page, meshHref as string);

  const sidecarLink = downloads.getByRole("link", { name: /\.json$/ });
  const sidecarHref = await sidecarLink.getAttribute("href");
  const sidecarBody = await fetchBlob(page, sidecarHref as string);

  const outDir = path.join(REPO_ROOT, "artifacts", "e2e");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "tiny-loop-e2e.3mf");
  const sidecarFile = path.join(outDir, "tiny-loop-e2e.json");
  fs.writeFileSync(outFile, meshBody);
  fs.writeFileSync(sidecarFile, sidecarBody);

  const validate = spawnSync(`uv run python -m app.cli validate "${outFile}"`, {
    cwd: path.join(REPO_ROOT, "services", "bake"),
    shell: true,
    encoding: "utf-8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    timeout: 300_000,
  });
  const validatorOutput = `${validate.stdout ?? ""}${validate.stderr ?? ""}`;
  log(`validator on the downloaded small-scene file:\n${validatorOutput}`);
  expect(validate.status, validatorOutput).toBe(0);
  expect(validatorOutput).toContain("ALL CHECKS PASS");
  expect(validatorOutput).toContain("sidecar tiny-loop-e2e.json");
});

test("the downloaded file passes the Python printability validator (full Chicago scene)", async ({
  page,
}) => {
  // Audit v3-02 finding 12: the happy path's own Chicago download is only
  // checked for zip-magic ("PK"), citing a "measured, documented gap" that
  // DECISIONS.md [V3-P2-E4] (the entry timestamped after the min-wall fix)
  // records as CLOSED: `npm run bake:cli` on the full Chicago fixture passes
  // `make validate` cleanly in BOTH `color_mode`s. This test is that
  // restored assertion, run through the real UI -> download -> CLI pipeline
  // the small-scene test above already proves, at full Chicago complexity
  // (992 buildings) instead of the 30-building synthetic one -- the same
  // combination `make gate`'s own browser-engine step exercises via
  // `fixtures/print-params-parts.json`, so this is deliberate redundancy,
  // not new coverage the gate lacks.
  //
  // `generic-3mf`, not the happy path's default `bambu-3mf`: the reference
  // validator reads a single `3D/3dmodel.model` part via `trimesh`'s stock
  // 3MF loader, which does not resolve Bambu's separate `3D/Objects/
  // object_N.model` production-extension parts -- a permanent format
  // mismatch, not something this closed gap affects (see the "Bambu Studio
  // project export" test below for that structure's own, different checks).
  await mockChicagoOverpass(page);
  await page.goto("/");
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-stats")).toBeVisible({ timeout: WARMUP_BUDGET_MS });

  await page.getByTestId("group-colour-toggle").click();
  await page.locator("#color_mode").getByRole("radio", { name: "one per part" }).click();
  await page.locator("#export_target").selectOption("generic-3mf");

  const bakeButton = page.getByTestId("bake-button");
  // A short fixed timeout measured flaky on a slower CI runner at full
  // Chicago complexity (992 buildings): `preview-stats` visible does not
  // guarantee the button has actually become interactive yet on a 2-core
  // software-WebGL host still busy with the instanced preview's first paint.
  // The assertion itself (enabled, not merely present) is unchanged; only
  // how long it is given to become true scales with `E2E_BUDGET_FACTOR`.
  await expect(bakeButton).toBeEnabled({ timeout: WARMUP_BUDGET_MS });
  const bakeStartedAt = Date.now();
  await bakeButton.click();
  const downloads = page.getByTestId("download-links");
  await expect(downloads).toBeVisible({ timeout: A4_BUDGET_MS });
  log(`Chicago parts bake -> done: ${((Date.now() - bakeStartedAt) / 1000).toFixed(1)} s`);

  const meshLink = downloads.getByRole("link", { name: /\.3mf$/ });
  const meshHref = await meshLink.getAttribute("href");
  const meshBody = await fetchBlob(page, meshHref as string);

  const sidecarLink = downloads.getByRole("link", { name: /\.json$/ });
  const sidecarHref = await sidecarLink.getAttribute("href");
  const sidecarBody = await fetchBlob(page, sidecarHref as string);

  const outDir = path.join(REPO_ROOT, "artifacts", "e2e");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "chicago-full-e2e.3mf");
  const sidecarFile = path.join(outDir, "chicago-full-e2e.json");
  fs.writeFileSync(outFile, meshBody);
  fs.writeFileSync(sidecarFile, sidecarBody);

  const validate = spawnSync(`uv run python -m app.cli validate "${outFile}"`, {
    cwd: path.join(REPO_ROOT, "services", "bake"),
    shell: true,
    encoding: "utf-8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    timeout: 300_000,
  });
  const validatorOutput = `${validate.stdout ?? ""}${validate.stderr ?? ""}`;
  log(`validator on the downloaded full-Chicago file:\n${validatorOutput}`);
  expect(validate.status, validatorOutput).toBe(0);
  expect(validatorOutput).toContain("ALL CHECKS PASS");
  expect(validatorOutput).toContain("sidecar chicago-full-e2e.json");
});

// ==========================================================================
// The Bambu Studio project export
// ==========================================================================

test("exporting a Bambu Studio project writes every region on its own extruder", async ({
  page,
}) => {
  await mockTinyLoopOverpass(page);
  await page.goto("/");
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-stats")).toBeVisible({ timeout: WARMUP_BUDGET_MS });

  // bambu-3mf is the contract default (`export_target`), so this exercises
  // the default Bake path, not an exotic one.
  await expect(page.locator("#export_target")).toHaveValue("bambu-3mf");

  const bakeButton = page.getByTestId("bake-button");
  await expect(bakeButton).toBeEnabled();
  await bakeButton.click();
  const downloads = page.getByTestId("download-links");
  await expect(downloads).toBeVisible({ timeout: A4_BUDGET_MS });

  const projectLink = downloads.getByRole("link", { name: /\.3mf$/ });
  const href = await projectLink.getAttribute("href");
  const body = await fetchBlob(page, href as string);
  expect(body.subarray(0, 2).toString("latin1")).toBe("PK");

  // A minimal, dependency-free zip central-directory reader: enough to list
  // entry names without adding a new package for one e2e assertion.
  const entries = zipEntryNames(body);
  log(`Bambu project entries: ${entries.join(", ")}`);
  expect(entries).toContain("[Content_Types].xml");
  expect(entries).toContain("_rels/.rels");
  expect(entries).toContain("3D/3dmodel.model");
  expect(entries).toContain("Metadata/model_settings.config");
  expect(entries).toContain("Metadata/project_settings.config");
  expect(entries.some((name) => /^3D\/Objects\/object_\d+\.model$/.test(name))).toBe(true);

  const modelSettings = extractZipEntry(body, "Metadata/model_settings.config").toString("utf-8");
  // Every region the tiny scene produced has its own `<part>` with an
  // `extruder` metadata key -- the Bambu writer always splits by region,
  // whatever `color_mode` says (`lib/engine/export/bambu3mf.ts`).
  const extruders = [...modelSettings.matchAll(/<metadata key="extruder" value="(\d+)"\/>/g)].map(
    (m) => m[1],
  );
  log(`model_settings.config extruders: ${extruders.join(", ")}`);
  expect(extruders.length).toBeGreaterThan(0);
  expect(modelSettings).toContain('<part id=');
});

/** Entry names from a zip's end-of-central-directory + central-directory records (no compression assumptions, just names). */
function zipEntryNames(zip: Buffer): string[] {
  const eocdSig = 0x06054b50;
  let eocdOffset = -1;
  for (let i = zip.length - 22; i >= 0; i -= 1) {
    if (zip.readUInt32LE(i) === eocdSig) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("not a zip: no end-of-central-directory record found");
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  const cdOffset = zip.readUInt32LE(eocdOffset + 16);
  const names: string[] = [];
  let offset = cdOffset;
  const cdSig = 0x02014b50;
  for (let i = 0; i < entryCount; i += 1) {
    if (zip.readUInt32LE(offset) !== cdSig) throw new Error(`bad central directory record at ${offset}`);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf-8");
    names.push(name);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/** The (stored or deflated) bytes of one zip entry, decompressed if needed. */
function extractZipEntry(zip: Buffer, entryName: string): Buffer {
  const localSig = 0x04034b50;
  let offset = 0;
  while (offset < zip.length) {
    if (zip.readUInt32LE(offset) !== localSig) break;
    const method = zip.readUInt16LE(offset + 8);
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf-8");
    const dataStart = offset + 30 + nameLength + extraLength;
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    if (name === entryName) {
      if (method === 0) return Buffer.from(raw);
      return zlib.inflateRawSync(raw);
    }
    offset = dataStart + compressedSize;
  }
  throw new Error(`zip entry not found: ${entryName}`);
}
