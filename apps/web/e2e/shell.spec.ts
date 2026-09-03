import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { DEFAULT_SIZES, HANDLE_PX, REGION_MIN_PX } from "../lib/layout";
import { mockChicagoOverpass, mockEmptyOverpass } from "./overpassMock";

/**
 * The application shell: three resizable regions, two of them hideable, either
 * the map or the preview able to take the whole window.
 *
 * Four things here cannot be reached by a unit test, and each one is a defect
 * this suite was written against:
 *
 *  1. **A drag is a real drag.** `lib/layout.test.ts` proves the arithmetic;
 *     only a browser proves that the pointer, the divider and the column agree
 *     about where 520 px is, and that the answer survives a reload.
 *  2. **Maximizing must not unmount anything.** The map keeps its WebGL
 *     context and the viewport keeps its model, which is a claim about DOM
 *     identity across a state change and about nothing else.
 *  3. **The settings column is fixed-purpose.** Its scroll position and the
 *     action bar's box are MEASURED across a run, a refusal and a finished
 *     export, rather than asserted from the markup.
 *  4. **The layout travels** (DECISIONS `[V3.1-O6]`): a permalink and a
 *     project file restore the sender's framing, through the same Copy link
 *     and Save/Load buttons a user presses.
 *
 * Everything here is the `lg` layout, which is what the 1280 px Playwright
 * viewport is.
 */

const BUDGET_FACTOR = Number(process.env.E2E_BUDGET_FACTOR ?? 1) || 1;
const WARMUP_BUDGET_MS = 60_000 * BUDGET_FACTOR;
const EXPORT_BUDGET_MS = 90_000 * BUDGET_FACTOR;

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DOWNLOAD_DIR = path.join(REPO_ROOT, "artifacts", "e2e", "shell");

function log(message: string): void {
  console.log(`[shell] ${message}`);
}

/**
 * Land on the editor with Overpass mocked.
 *
 * Playwright gives every test its own browser context, so `localStorage` is
 * empty here and the layout starts on the default without having to be
 * cleared. The two tests that care about the difference between "this device
 * remembers" and "the document said so" clear it explicitly, mid-test, where
 * that distinction is the thing being measured.
 */
async function openEditor(page: Page): Promise<void> {
  await mockChicagoOverpass(page);
  await page.goto("/");
  await expect(page.getByTestId("editor")).toBeVisible();
  await expect(page.getByTestId("region-map")).toBeVisible();
}

async function previewChicago(page: Page): Promise<void> {
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-canvas")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await expect(page.getByTestId("preview-stats")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
}

/** A region's width on screen, to the nearest pixel. */
async function widthOf(page: Page, region: "map" | "viewport" | "settings"): Promise<number> {
  const box = await page.getByTestId(`region-${region}`).boundingBox();
  expect(box, `region-${region} has no box`).not.toBeNull();
  return Math.round(box?.width ?? 0);
}

/**
 * The width the three regions share: the row minus its two dividers.
 *
 * Measured rather than assumed at 1268 px. A window scrollbar, a device pixel
 * ratio or a future header change moves the row by a pixel or two, and every
 * expectation below that would otherwise be a literal is derived from this so
 * a one-pixel difference reads as a difference and not as a failure.
 */
async function regionRoom(page: Page): Promise<number> {
  const row = await page.getByTestId("editor-regions").boundingBox();
  expect(row, "the region row has no box").not.toBeNull();
  return Math.round((row?.width ?? 0) - 2 * HANDLE_PX);
}

/** Drag a divider by `dx` pixels, the way a pointer does. */
async function dragHandle(page: Page, boundary: "map" | "settings", dx: number): Promise<void> {
  const handle = page.getByTestId(`layout-handle-${boundary}`);
  const box = await handle.boundingBox();
  expect(box, `layout-handle-${boundary} has no box`).not.toBeNull();
  if (box === null) return;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, y, { steps: 12 });
  await page.mouse.up();
}

// ==========================================================================
// 1. Resizing
// ==========================================================================

test("the columns resize by drag, keep the size per device, and reset from the divider", async ({
  page,
}) => {
  await openEditor(page);
  expect(await widthOf(page, "map")).toBe(DEFAULT_SIZES.map);

  await dragHandle(page, "map", 120);
  await expect
    .poll(() => widthOf(page, "map"), { timeout: 5_000 })
    .toBe(DEFAULT_SIZES.map + 120);
  const viewportAfterDrag = await widthOf(page, "viewport");
  log(`map 400 -> ${DEFAULT_SIZES.map + 120}, viewport ${viewportAfterDrag}`);

  // Per device: the width is this browser's, and a reload is where a layout
  // that only lived in React state would quietly go back to the default.
  await page.reload();
  await expect(page.getByTestId("region-map")).toBeVisible();
  await expect.poll(() => widthOf(page, "map"), { timeout: 5_000 }).toBe(DEFAULT_SIZES.map + 120);

  // The settings divider is independent, and grows leftwards.
  await dragHandle(page, "settings", -60);
  await expect
    .poll(() => widthOf(page, "settings"), { timeout: 5_000 })
    .toBe(DEFAULT_SIZES.settings + 60);
  expect(await widthOf(page, "map")).toBe(DEFAULT_SIZES.map + 120);

  // Double-click puts ONE divider back and leaves the other where it was.
  await page.getByTestId("layout-handle-map").dblclick();
  await expect.poll(() => widthOf(page, "map"), { timeout: 5_000 }).toBe(DEFAULT_SIZES.map);
  expect(await widthOf(page, "settings")).toBe(DEFAULT_SIZES.settings);
});

test("a divider is a keyboard control with a name, a percentage and its own limits", async ({
  page,
}) => {
  await openEditor(page);
  const handle = page.getByTestId("layout-handle-map");
  const room = await regionRoom(page);
  const percent = (px: number): string => String(Math.round((px / room) * 100));

  await expect(handle).toHaveAttribute("role", "separator");
  await expect(handle).toHaveAttribute("aria-orientation", "vertical");
  await expect(handle).toHaveAttribute("aria-label", "Resize the map column");
  await expect(handle).toHaveAttribute("aria-controls", "fc-region-map");
  await expect(handle).toHaveAttribute("aria-valuenow", percent(DEFAULT_SIZES.map));

  await handle.focus();
  await expect(handle).toBeFocused();

  await handle.press("ArrowRight");
  await handle.press("ArrowRight");
  await expect.poll(() => widthOf(page, "map"), { timeout: 5_000 }).toBe(DEFAULT_SIZES.map + 32);

  await handle.press("Shift+ArrowLeft");
  await expect.poll(() => widthOf(page, "map"), { timeout: 5_000 }).toBe(DEFAULT_SIZES.map - 32);

  // Home and End are the two ends of what this divider may do, and the
  // percentage follows.
  await handle.press("Home");
  await expect.poll(() => widthOf(page, "map"), { timeout: 5_000 }).toBe(REGION_MIN_PX.map);
  await expect(handle).toHaveAttribute("aria-valuenow", percent(REGION_MIN_PX.map));

  // The far end is the viewport's floor, not the map's own maximum: the
  // settings column keeps its width and the middle keeps its minimum.
  const widest = room - DEFAULT_SIZES.settings - REGION_MIN_PX.viewport;
  await handle.press("End");
  await expect.poll(() => widthOf(page, "map"), { timeout: 5_000 }).toBe(widest);
  expect(await widthOf(page, "viewport")).toBe(REGION_MIN_PX.viewport);

  // Enter is the double-click.
  await handle.press("Enter");
  await expect.poll(() => widthOf(page, "map"), { timeout: 5_000 }).toBe(DEFAULT_SIZES.map);
  await expect(handle).toBeFocused();
});

test("every layout control is reachable by Tab, with a name and a focus ring", async ({
  page,
}) => {
  await openEditor(page);
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  const wanted = [
    "layout-collapse-map",
    "layout-maximize-map",
    "layout-maximize-viewport",
    "layout-collapse-settings",
    "layout-handle-map",
    "layout-handle-settings",
  ];
  const seen = new Map<string, { name: string; ring: string }>();
  for (let press = 0; press < 80 && seen.size < wanted.length; press += 1) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active === null) return null;
      const style = getComputedStyle(active);
      return {
        testId: active.getAttribute("data-testid") ?? "",
        name: active.getAttribute("aria-label") ?? (active.textContent ?? "").trim(),
        ring: `${style.outlineStyle}/${style.outlineWidth}`,
      };
    });
    if (stop !== null && wanted.includes(stop.testId)) {
      seen.set(stop.testId, { name: stop.name, ring: stop.ring });
    }
  }

  expect(
    wanted.filter((id) => !seen.has(id)),
    "never reached by Tab",
  ).toEqual([]);
  for (const [id, stop] of seen) {
    expect(stop.name.length, `${id} has no accessible name`).toBeGreaterThan(0);
    expect(stop.ring.startsWith("none"), `${id} has no focus ring (${stop.ring})`).toBe(false);
  }
  log(`tab walk reached ${seen.size} layout controls`);
});

// ==========================================================================
// 2. Maximize, without unmounting anything
// ==========================================================================

test("maximizing gives one region the window and takes nothing else down with it", async ({
  page,
}) => {
  await openEditor(page);
  await previewChicago(page);

  const mapCanvases = page.locator("canvas.maplibregl-canvas");
  await expect(mapCanvases).toHaveCount(1);
  // A mark on the live canvas element. It survives only if this exact node
  // survives, which is the whole claim: a remount would build a new canvas and
  // a new WebGL context, and the map would reload its tiles.
  await page.evaluate(() => {
    const canvas = document.querySelector("canvas.maplibregl-canvas");
    if (canvas !== null) (canvas as HTMLElement).dataset.fcShellMark = "kept";
  });
  const modelBefore = await page.getByTestId("preview-stats").textContent();

  // The keyboard route, which is the one a user has after the header scrolls
  // out of reach on a narrow window.
  await page.keyboard.press("v");
  await expect(page.getByTestId("editor-regions")).toHaveAttribute("data-maximized", "viewport");
  await expect(page.getByTestId("region-map")).toBeHidden();
  await expect(page.getByTestId("param-sheet")).toBeHidden();
  await expect(page.getByTestId("layout-handle-map")).toHaveCount(0);
  // Hidden, not gone: the canvas is still in the document, with its mark.
  await expect(mapCanvases).toHaveCount(1);

  // The visible restore control says what it does.
  const restore = page.getByTestId("layout-maximize-viewport");
  await expect(restore).toHaveText("Restore");
  await expect(restore).toHaveAttribute("aria-pressed", "true");
  await restore.click();

  await expect(page.getByTestId("editor-regions")).toHaveAttribute("data-maximized", "none");
  await expect(page.getByTestId("region-map")).toBeVisible();
  await expect(mapCanvases).toHaveCount(1);
  const survived = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.maplibregl-canvas") as HTMLCanvasElement | null;
    if (canvas === null) return { mark: null as string | null, lost: null as boolean | null };
    const gl =
      (canvas.getContext("webgl2") as WebGL2RenderingContext | null) ??
      (canvas.getContext("webgl") as WebGLRenderingContext | null);
    return { mark: canvas.dataset.fcShellMark ?? null, lost: gl === null ? null : gl.isContextLost() };
  });
  expect(survived.mark, "the map was remounted by a maximize").toBe("kept");
  expect(survived.lost, "the map's WebGL context was lost by a maximize").not.toBe(true);
  // And the viewport still holds the model it had, with no rebuild.
  await expect(page.getByTestId("preview-stats")).toHaveText(modelBefore ?? "");

  // The map's own maximize is the same control the other way round, and the
  // two hide toggles say why they are unavailable while it is on.
  await page.getByTestId("layout-maximize-map").click();
  await expect(page.getByTestId("editor-regions")).toHaveAttribute("data-maximized", "map");
  await expect(page.getByTestId("region-viewport")).toBeHidden();
  await expect(page.getByTestId("layout-collapse-map")).toBeDisabled();
  await expect(page.getByTestId("layout-collapse-settings")).toHaveAttribute(
    "title",
    "Restore the columns before hiding one",
  );
  await page.keyboard.press("m");
  await expect(page.getByTestId("editor-regions")).toHaveAttribute("data-maximized", "none");
  await expect(page.getByTestId("region-viewport")).toBeVisible();
});

// ==========================================================================
// 3. Collapse, and the way back
// ==========================================================================

test("either side column hides completely, and the rail it leaves brings it back", async ({
  page,
}) => {
  await openEditor(page);

  await page.getByTestId("layout-collapse-map").click();
  await expect(page.getByTestId("region-map")).toBeHidden();
  await expect(page.getByTestId("layout-handle-map")).toHaveCount(0);
  // The viewport takes the room, and the settings column does not move.
  expect(await widthOf(page, "settings")).toBe(DEFAULT_SIZES.settings);

  const rail = page.getByTestId("layout-rail-map");
  await expect(rail).toBeVisible();
  await expect(rail).toHaveAttribute("aria-label", "Show the map column");
  await rail.click();
  await expect(page.getByTestId("region-map")).toBeVisible();
  await expect(rail).toHaveCount(0);

  // The settings side, from the keyboard, and its own rail.
  await page.keyboard.press("]");
  await expect(page.getByTestId("param-sheet")).toBeHidden();
  const settingsRail = page.getByTestId("layout-rail-settings");
  await expect(settingsRail).toBeVisible();
  await expect(settingsRail).toHaveAttribute("aria-label", "Show the settings column");
  await settingsRail.click();
  await expect(page.getByTestId("param-sheet")).toBeVisible();
  expect(await widthOf(page, "settings")).toBe(DEFAULT_SIZES.settings);
});

// ==========================================================================
// 4. The settings column is fixed-purpose
// ==========================================================================

interface ShellFrame {
  actions: { x: number; y: number; width: number; height: number } | null;
  barTop: number | null;
  barLeft: number | null;
  barWidth: number | null;
  scrollTop: number;
}

async function shellFrame(page: Page): Promise<ShellFrame> {
  const actions = await page.getByTestId("action-bar-actions").boundingBox();
  const bar = await page.getByTestId("action-bar").boundingBox();
  const scrollTop = await page
    .getByTestId("param-groups")
    .evaluate((element) => element.scrollTop);
  return {
    actions,
    barTop: bar === null ? null : bar.y,
    barLeft: bar === null ? null : bar.x,
    barWidth: bar === null ? null : bar.width,
    scrollTop,
  };
}

test("results, progress and a refusal never move the settings column or the action bar", async ({
  page,
}) => {
  await openEditor(page);
  await previewChicago(page);

  // Somewhere in the middle of the group list, deliberately not at either end:
  // a scroller pinned to its own maximum can be clamped by a change in height
  // and would report "unmoved" for the wrong reason.
  await page.getByTestId("param-groups").evaluate((element) => {
    element.scrollTop = 120;
  });
  const baseline = await shellFrame(page);
  expect(baseline.actions, "the action row has no box").not.toBeNull();
  expect(baseline.scrollTop).toBeGreaterThan(0);
  log(`baseline actions ${JSON.stringify(baseline.actions)} scrollTop ${baseline.scrollTop}`);

  // --- during a run -------------------------------------------------------
  await page.locator("#plate_mm").fill("200");
  await expect(page.getByTestId("pipeline-stage-overlay")).toBeVisible({
    timeout: WARMUP_BUDGET_MS,
  });
  const during = await shellFrame(page);
  expect(during.actions, "a run in flight moved the action row").toEqual(baseline.actions);
  expect(during.scrollTop, "a run in flight moved the settings column").toBe(baseline.scrollTop);
  expect([during.barTop, during.barLeft, during.barWidth]).toEqual([
    baseline.barTop,
    baseline.barLeft,
    baseline.barWidth,
  ]);
  await expect(page.getByTestId("pipeline-stage-overlay")).toHaveCount(0, {
    timeout: WARMUP_BUDGET_MS,
  });

  // --- a refusal ----------------------------------------------------------
  // An empty Overpass response: the coverage warning fires and Export is
  // refused, so the settings column gains a note and the viewport a banner.
  // A preset chip is what re-fetches here, because Preview is (correctly)
  // disabled while the model already matches the location.
  await page.unroute("**/api/interpreter");
  await mockEmptyOverpass(page);
  await page.locator('[data-preset-id="san-francisco-fidi"]').click();
  await expect(page.getByTestId("export-block-reason")).toBeVisible({
    timeout: WARMUP_BUDGET_MS,
  });
  await expect(page.getByTestId("export-button")).toBeDisabled();
  const refused = await shellFrame(page);
  expect(refused.actions, "a refusal moved the action row").toEqual(baseline.actions);
  expect(refused.scrollTop, "a refusal moved the settings column").toBe(baseline.scrollTop);

  // --- a finished export --------------------------------------------------
  await page.unroute("**/api/interpreter");
  await mockChicagoOverpass(page);
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("export-button")).toBeEnabled({ timeout: WARMUP_BUDGET_MS });
  await page.getByTestId("export-button").click();
  await expect(page.getByTestId("download-links")).toBeVisible({ timeout: EXPORT_BUDGET_MS });
  await expect(page.getByTestId("export-button")).toBeEnabled({ timeout: EXPORT_BUDGET_MS });
  const exported = await shellFrame(page);
  expect(exported.actions, "a finished export moved the action row").toEqual(baseline.actions);
  expect(exported.scrollTop, "a finished export moved the settings column").toBe(
    baseline.scrollTop,
  );
});

// ==========================================================================
// 5. The layout travels with the design ([V3.1-O6])
// ==========================================================================

test("a permalink restores the sender's layout, on a device that has none of its own", async ({
  page,
}) => {
  await openEditor(page);
  await dragHandle(page, "map", 100);
  await page.getByTestId("layout-collapse-settings").click();
  await expect(page.getByTestId("param-sheet")).toBeHidden();

  const link = await page.getByTestId("copy-link-button").getAttribute("data-share-url");
  expect(link, "the copy-link button carries no URL").not.toBeNull();
  log(`link ${String(link).length} characters`);

  // The recipient's own layout is out of the way, so what comes back can only
  // have come from the link.
  await page.evaluate(() => window.localStorage.removeItem("framecraft.layout.v1"));
  await page.goto(String(link));
  await expect(page.getByTestId("editor")).toBeVisible();
  await expect.poll(() => widthOf(page, "map"), { timeout: 5_000 }).toBe(DEFAULT_SIZES.map + 100);
  await expect(page.getByTestId("layout-rail-settings")).toBeVisible();
});

test("a project file carries the layout through the Save and Load buttons", async ({ page }) => {
  await openEditor(page);
  await dragHandle(page, "map", -80);
  await expect.poll(() => widthOf(page, "map"), { timeout: 5_000 }).toBe(DEFAULT_SIZES.map - 80);

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const started = page.waitForEvent("download", { timeout: WARMUP_BUDGET_MS });
  await page.getByTestId("save-project-button").click();
  const download = await started;
  const file = path.join(DOWNLOAD_DIR, download.suggestedFilename());
  await download.saveAs(file);
  const saved = JSON.parse(fs.readFileSync(file, "utf-8")) as {
    layout?: { map?: number };
    params: Record<string, unknown>;
  };
  expect(saved.layout?.map).toBe(DEFAULT_SIZES.map - 80);
  // A sibling of the settings, never one of them.
  expect(Object.keys(saved.params)).not.toContain("layout");

  // Put the layout back to the default, then let the file restore it.
  await page.getByTestId("layout-handle-map").dblclick();
  await expect.poll(() => widthOf(page, "map"), { timeout: 5_000 }).toBe(DEFAULT_SIZES.map);
  await page.getByTestId("load-project-input").setInputFiles(file);
  await expect.poll(() => widthOf(page, "map"), { timeout: 5_000 }).toBe(DEFAULT_SIZES.map - 80);
});
