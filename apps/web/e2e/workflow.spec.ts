import os from "node:os";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { mockChicagoOverpass, watchOverpass } from "./overpassMock";
import { mockNominatimReverse, mockPhoton } from "./photonMock";

/**
 * Phase 6: app and workflow features ([V3-P6]).
 *
 * Search, undo/redo, the project file and the permalink, each exercised as a
 * real user would reach them rather than through the unit suites alone:
 *
 *  1. Search "Chicago" (Photon route-mocked) and pick a result -- the pin
 *     moves and the place name fills in without a manual reverse-geocode
 *     round trip, and Preview lights up instead of building by itself
 *     ([V3-P9]). `e2e/search.spec.ts` covers the type-ahead's own request
 *     policy; this test covers the workflow around a pick.
 *  2. Three settings changed, Ctrl+Z twice: the values revert in order and
 *     the history chip's count follows every step.
 *  3. Save the project, reload the page (a genuinely fresh editor), load the
 *     file back, and every setting is exactly what was saved.
 *  4. Copy a permalink and open it in a fresh browser context -- the same
 *     pattern `e2e/share.spec.ts` already proves exhaustively, kept light
 *     here since this suite is about the WORKFLOW around it, not the payload
 *     format itself.
 *
 * Budgets scale with `E2E_BUDGET_FACTOR`, matching every other spec in this
 * directory (`smoke.spec.ts`, `a11y.spec.ts`, `print.spec.ts`, `colour.spec.ts`).
 */

const BUDGET_FACTOR = Number(process.env.E2E_BUDGET_FACTOR ?? 1) || 1;
const WARMUP_BUDGET_MS = 60_000 * BUDGET_FACTOR;

/**
 * Open a collapsed group by its id, a no-op if it is already open (same
 * pattern `e2e/lettering.spec.ts` uses). Blindly clicking the toggle is
 * wrong here: the collapse state persists to localStorage, which survives
 * `page.reload()`, so a group opened earlier in a test is still open after
 * a reload and a second click would CLOSE it.
 */
async function openGroup(page: Page, id: string): Promise<void> {
  const group = page.getByTestId(`group-${id}`);
  if ((await group.getAttribute("data-collapsed")) === "true") {
    await page.getByTestId(`group-${id}-toggle`).click();
  }
  await expect(group).toHaveAttribute("data-collapsed", "false");
}

/**
 * Route both geocoders this suite touches: Photon for the type-ahead and
 * Nominatim for the reverse lookup that names a dropped pin ([V3-P9]). Neither
 * is ever reached over the network; `e2e/photonMock.ts` holds the fixtures.
 */
async function mockGeocoders(page: Page): Promise<void> {
  await mockPhoton(page);
  await mockNominatimReverse(page);
}

test.describe.configure({ mode: "serial" });

test("search picks a place, moves the pin and fills the place name", async ({ page }) => {
  const calls = watchOverpass(page);
  await mockGeocoders(page);
  await mockChicagoOverpass(page);
  await page.goto("/");

  const search = page.getByTestId("location-search");
  await search.fill("Chicago");
  await expect(page.getByTestId("search-results")).toBeVisible();
  await expect(page.getByTestId("search-result")).toHaveCount(3, { timeout: 5_000 });
  await expect(page.getByTestId("search-result").first()).toContainText("Chicago");

  await page.getByTestId("search-result").first().click();

  // Picking a "city" result sets a 1500 m radius (`radiusForResultType`) and
  // fills the place name through the same geocode-source path a reverse
  // lookup uses, without the user typing anything.
  await expect(page.getByTestId("radius_m-value")).toHaveText("1500 m");
  await expect(page.locator("#city_label")).toHaveValue("Chicago");
  await expect(page.getByTestId("search-results")).toBeHidden();

  // A pick does NOT build ([V3-P9]): it marks the scene stale and offers
  // Preview, which is the user's own move. Anything else would spend an
  // Overpass query on a keystroke.
  expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  const preview = page.getByTestId("preview-button");
  await expect(preview).toBeEnabled();

  await preview.click();
  await expect(page.getByTestId("preview-stats")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  expect(calls.filter((call) => call.method === "POST").length).toBeGreaterThan(0);
});

test("changing three settings and pressing Ctrl+Z twice reverts them, and the history chip follows", async ({
  page,
}) => {
  // Deliberately no preset click and no Preview here: clicking a preset
  // itself writes `city_label` (a real, one-entry history step of its own,
  // `applyPreset`), which would make "3 changes" mean something different
  // depending on whether a preset was clicked first. Undo/redo is exercised
  // directly against the fresh default state instead, which needs no
  // network at all.
  await page.goto("/");

  // Three independent boolean/numeric settings, in order: plate size, the
  // frame toggle, the water toggle -- three different history "paths", so
  // none of them coalesce into one entry with another. `frame` and `water`
  // both DEFAULT TO ON (`DEFAULT_PRINT_PARAMS.frame`/`.water === true`), so
  // each click here turns them off, not on. A text field is deliberately not
  // used for this step: `.fill()` on a text input is exercised elsewhere in
  // this suite (the place name, in every other test here), and keeping this
  // specific test to boolean/numeric controls only is what makes it about
  // undo/redo rather than about text-input behaviour.
  await page.locator("#plate_mm").fill("200");
  await expect(page.getByTestId("plate_mm-value")).toHaveText("200 mm");

  await page.getByTestId("group-frame-toggle").click();
  await expect(page.locator("#frame")).toHaveAttribute("aria-checked", "true");
  await page.locator("#frame").click();
  await expect(page.locator("#frame")).toHaveAttribute("aria-checked", "false");

  // Water is in the Surface group, which starts collapsed since Task 5.
  await openGroup(page, "surface");
  await expect(page.locator("#water")).toHaveAttribute("aria-checked", "true");
  await page.locator("#water").click();
  await expect(page.locator("#water")).toHaveAttribute("aria-checked", "false");

  const historyChip = page.getByTestId("history-chip");
  await expect(historyChip).toContainText("3 changes");

  // Focus is already outside any typing target (the last interaction was a
  // toggle button, not a text field), so Ctrl+Z reaches the app-level
  // shortcut directly (`lib/keyboard.ts:shortcutFor`).
  await page.keyboard.press("Control+z");
  await expect(historyChip).toContainText("2 changes");
  await expect(page.locator("#water")).toHaveAttribute("aria-checked", "true");
  // The two earlier changes are untouched.
  await expect(page.locator("#frame")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("plate_mm-value")).toHaveText("200 mm");

  await page.keyboard.press("Control+z");
  await expect(historyChip).toContainText("1 change");
  await expect(page.locator("#frame")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("plate_mm-value")).toHaveText("200 mm");

  // Redo brings the frame toggle back off.
  await page.keyboard.press("Control+Shift+z");
  await expect(historyChip).toContainText("2 changes");
  await expect(page.locator("#frame")).toHaveAttribute("aria-checked", "false");
});

test("save project, reload, load project: every setting comes back", async ({ page }) => {
  await mockGeocoders(page);
  await mockChicagoOverpass(page);
  await page.goto("/");
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-stats")).toBeVisible({ timeout: WARMUP_BUDGET_MS });

  await page.locator("#plate_mm").fill("210");
  await page.locator("#city_label").fill("Bergen");
  await page.getByTestId("group-frame-toggle").click();
  // `frame` defaults to ON; this click turns it off, so the saved project
  // really does carry a NON-default value to round-trip.
  await page.locator("#frame").click();
  await expect(page.locator("#frame")).toHaveAttribute("aria-checked", "false");

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("save-project-button").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain("bergen");
  // The current extension, and NOT the legacy double one it replaced.
  expect(download.suggestedFilename().endsWith(".framecraft")).toBe(true);

  const savedPath = path.join(os.tmpdir(), `framecraft-workflow-${Date.now()}.framecraft`);
  await download.saveAs(savedPath);

  // A genuinely fresh editor: reload drops every in-memory (non-localStorage)
  // setting back to the contract's defaults.
  await page.reload();
  await expect(page.getByTestId("plate_mm-value")).toHaveText("180 mm");
  await expect(page.locator("#city_label")).toHaveValue("");

  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByTestId("load-project-button").click(),
  ]);
  await fileChooser.setFiles(savedPath);

  await expect(page.getByTestId("plate_mm-value")).toHaveText("210 mm");
  await expect(page.locator("#city_label")).toHaveValue("Bergen");
  // The group's OWN collapse state (`lib/groups.ts`) persists to localStorage
  // and survives the reload above -- it is already open from the click at
  // line 173, so this is `openGroup`, not a second blind click (which would
  // CLOSE it instead).
  await openGroup(page, "frame");
  await expect(page.locator("#frame")).toHaveAttribute("aria-checked", "false");

  // Loading a project re-ingests immediately, unlike a share link.
  await expect(page.getByTestId("preview-stats")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await expect(page.getByTestId("project-error")).toHaveCount(0);
});

test("a copied link restores in a fresh browser context", async ({ page, context, browser }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockGeocoders(page);
  await mockChicagoOverpass(page);
  await page.goto("/");
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-stats")).toBeVisible({ timeout: WARMUP_BUDGET_MS });

  await page.locator("#plate_mm").fill("205");
  await page.locator("#city_label").fill("Tokyo");

  const copy = page.getByTestId("copy-link-button");
  await copy.click();
  const link = (await copy.getAttribute("data-share-url")) ?? "";
  expect(link).toContain("s=v3.");

  const fresh = await browser.newContext();
  const other = await fresh.newPage();
  await mockChicagoOverpass(other);
  try {
    await other.goto(link);
    await expect(other.getByTestId("plate_mm-value")).toHaveText("205 mm");
    await expect(other.locator("#city_label")).toHaveValue("Tokyo");
    // A share restore stays stale until Preview; it never fetches on its own.
    await expect(other.getByTestId("preview-button")).toBeEnabled();
  } finally {
    await fresh.close();
  }
});
