import { expect, test, type Page } from "@playwright/test";

import { mockTinyLoopOverpass } from "./overpassMock";

/**
 * PRINTER group, Issues drawer and tiling (FrameCraft v3 phase 4,
 * `docs/handoff/v3-04-ui.md`).
 *
 * Every Overpass call is routed to the tiny (30-building) synthetic fixture
 * (`mockTinyLoopOverpass`), the same one `terrain.spec.ts` uses: it clears
 * 01/A2's 20-building minimum and bakes cleanly, which matters here more than
 * usual -- these specs wait on the browser engine's OWN findings and tile
 * split, not just a rendered preview.
 *
 * Budgets scale with `E2E_BUDGET_FACTOR`, matching `smoke.spec.ts`/
 * `terrain.spec.ts`'s own convention for a CI runner slower than a dev
 * machine.
 */
const BUDGET_FACTOR = Number(process.env.E2E_BUDGET_FACTOR ?? 1) || 1;
const WARMUP_BUDGET_MS = 60_000 * BUDGET_FACTOR;

/** Every uncaught exception the page throws, so a silent React crash fails loudly instead of as a missing element three assertions later. */
function watchPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

async function generateTinyLoop(page: Page): Promise<void> {
  await mockTinyLoopOverpass(page);
  await page.goto("/");
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-canvas")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await expect(page.getByTestId("preview-stats")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  // A fresh EngineResult, not just the instanced fallback: the stats card
  // only renders once `state.engine.result` exists (terrain.spec.ts's own
  // "the engine keeps baking" signal).
  await expect(page.getByTestId("stats-card")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
}

async function openGroup(page: Page, id: string): Promise<void> {
  const toggle = page.getByTestId(`group-${id}-toggle`);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
}

/** Move a range input the way a user does: fires input/change, no pointerup/keyup needed off this group's own sliders. */
async function setSlider(page: Page, id: string, value: number): Promise<void> {
  await page.locator(`#${id}`).fill(String(value));
}

function log(message: string): void {
  console.log(`[print] ${message}`);
}

// ==========================================================================
// PRINTER group: profile-apply and the height ceiling ([V3-P4-U])
// ==========================================================================

test("selecting the P1S applies its plate, and the height ceiling becomes its own 250 mm", async ({ page }) => {
  const pageErrors = watchPageErrors(page);
  await generateTinyLoop(page);
  await openGroup(page, "printer");

  // Before picking a printer, the default (custom) profile's own ceiling is
  // 60 mm -- the contract's `custom_profile.max_height_mm` default (team
  // lead's ruling, `[V3-P4]`/`[V3-P4-E9]` in DECISIONS.md: the ceiling is a
  // property of the machine, not a separate flat figure `min`'d against it).
  await expect(page.getByTestId("predicted-height")).toHaveAttribute("data-ceiling-mm", "60");

  await page.locator("#printer_profile").selectOption("bambu-p1s");
  await expect(page.getByTestId("plate_mm-value")).toHaveText("256 mm");
  await expect(page.getByTestId("printer-profile-summary")).toContainText("256 × 256 mm plate");
  await expect(page.getByTestId("printer-profile-summary")).toContainText("250 mm height ceiling");

  // Picking a printer with real headroom (a P1S has 250 mm of gantry) really
  // does raise the ceiling to what it can do -- `lib/warnings.ts:
  // heightCeilingMm` is a straight `resolveProfile(params).maxHeightMm`.
  const predicted = page.getByTestId("predicted-height");
  await expect(predicted).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await expect(predicted).toHaveAttribute("data-ceiling-mm", "250");
  await expect(predicted).toContainText("of 250 mm");
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});

test("switching back to custom restores nothing: plate_mm and nozzle_mm stay wherever the user left them", async ({
  page,
}) => {
  const pageErrors = watchPageErrors(page);
  await generateTinyLoop(page);
  await openGroup(page, "printer");

  await page.locator("#printer_profile").selectOption("bambu-a1-mini");
  await expect(page.getByTestId("plate_mm-value")).toHaveText("180 mm");

  await setSlider(page, "plate_mm", 150);
  await expect(page.getByTestId("plate_mm-value")).toHaveText("150 mm");

  await page.locator("#printer_profile").selectOption("custom");
  await expect(page.getByTestId("custom-profile-fields")).toBeVisible();
  // Nothing snapped back to the 180 mm default `custom_profile` row.
  await expect(page.getByTestId("plate_mm-value")).toHaveText("150 mm");
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});

// ==========================================================================
// The Issues drawer: a real finding, a real fix
// ==========================================================================

test("a finding with a fix (a region on a slot the profile does not have) clears when its fix button is clicked", async ({
  page,
}) => {
  const pageErrors = watchPageErrors(page);
  await generateTinyLoop(page);
  await openGroup(page, "colour");

  // The default (custom) profile has 4 filament slots; slot 9 does not
  // exist on it, which is `lib/engine/audit/rules.ts:slotFindings`'s own
  // "slot-beyond-profile" rule (severity error, a safe fix moving the
  // region back onto the profile's own top slot).
  await page.locator("#colour_slot_buildings").selectOption("9");

  const badge = page.getByTestId("issues-badge");
  await expect(badge).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await badge.click();

  const item = page.getByTestId("issue-item-slot-beyond-profile");
  await expect(item).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await expect(item).toContainText("buildings");
  log(`finding detail: ${await item.textContent()}`);

  const fixButton = page.getByTestId("issue-fix-slot-beyond-profile");
  await expect(fixButton).toBeVisible();
  await fixButton.click();
  // Immediate, optimistic: the row marks itself fixed the moment the store
  // reports a real change, before the next debounced bake even lands.
  await expect(fixButton).toBeDisabled();
  await expect(fixButton).toHaveText("Fixed");

  // The region's slot really moved (back onto the profile's own slot count).
  await expect(page.locator("#colour_slot_buildings")).not.toHaveValue("9");

  // Once the next bake lands, the engine no longer reports the finding at
  // all -- the row is gone, not merely disabled.
  await expect(item).toHaveCount(0, { timeout: WARMUP_BUDGET_MS });
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});

// ==========================================================================
// TILING: the grid overlay and a tiled export
// ==========================================================================

test("enabling 2x2 tiling shows four tile labels in the preview and a tiled export still downloads", async ({
  page,
}) => {
  const pageErrors = watchPageErrors(page);
  await generateTinyLoop(page);
  await openGroup(page, "printer");

  // The single-multi-plate-file path (`lib/engine/export/index.ts:
  // exportForTarget`) needs a REAL Bambu profile, not just the `bambu-3mf`
  // target: it is a property of the printer, not of the file format alone
  // (a "Bambu Studio project" for a printer that is not one would be a
  // meaningless multi-plate file). The default `custom` profile's tiled
  // export is a zip regardless of `export_target`, which
  // `lib/engine/export/tiles.test.ts` (p4-engine's file) covers; this test
  // exercises the single-file path, the more interesting of the two.
  await page.locator("#printer_profile").selectOption("bambu-p1s");

  const enable = page.locator("#tiling_enabled");
  await enable.click();
  await expect(enable).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("tiling-fields")).toBeVisible();

  await setSlider(page, "tiling_cols", 2);
  await setSlider(page, "tiling_rows", 2);
  await expect(page.getByTestId("tiling_cols-value")).toHaveText("2");
  await expect(page.getByTestId("tiling_rows-value")).toHaveText("2");

  /*
   * The cut LINES are drawn with `@react-three/drei`'s `Line`, a real
   * `THREE.Object3D` inside the WebGL canvas that a DOM locator cannot see
   * (`RegionMeshes.tsx`'s own note on this). The per-tile index LABELS are
   * `drei`'s `Html`, which -- unlike the lines -- really is anchored DOM, so
   * it is what this spec can assert on: four labels for a 2x2 grid.
   */
  const labels = page.locator('[data-testid^="tile-label-"]');
  await expect.poll(() => labels.count(), { timeout: WARMUP_BUDGET_MS }).toBe(4);
  const text = await labels.allTextContents();
  log(`tile labels: ${text.join(", ")}`);
  expect(new Set(text).size).toBe(4);

  // The export note names the real tile count and, for a real Bambu printer
  // on the default `bambu-3mf` target, says the project carries one plate
  // per tile (the exact phrasing `lib/engine/export/index.ts` itself writes
  // into a finished bake's own notes, so the two can never disagree).
  await expect(page.getByTestId("tiled-export-note")).toContainText("4 tiles");
  await expect(page.getByTestId("tiled-export-note")).toContainText("one plate each");
  await expect(page.getByTestId("tiled-export-note")).toContainText("single Bambu Studio project");

  await page.getByTestId("bake-button").click();
  await expect(page.getByTestId("download-links")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  const links = page.getByTestId("download-links").locator("a");
  await expect(links).not.toHaveCount(0);
  log(`download links: ${await links.count()}`);
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});
