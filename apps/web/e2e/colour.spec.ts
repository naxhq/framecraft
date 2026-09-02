import { expect, test, type Page } from "@playwright/test";

import { mockTinyLoopOverpass } from "./overpassMock";

/**
 * COLOUR and FRAME group expansion (FrameCraft v3 phase 5, `[V3-P5-C]`):
 * palettes, custom palette save/reapply, the contrast checker, the preview
 * theme toggle, and the FRAME group's profile/shadow-gap controls.
 *
 * Every Overpass call routes to the tiny synthetic fixture
 * (`mockTinyLoopOverpass`), the same convention `print.spec.ts`/
 * `terrain.spec.ts` use, so this suite runs offline and fast.
 */
const BUDGET_FACTOR = Number(process.env.E2E_BUDGET_FACTOR ?? 1) || 1;
const WARMUP_BUDGET_MS = 60_000 * BUDGET_FACTOR;

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
  await expect(page.getByTestId("stats-card")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
}

async function openGroup(page: Page, id: string): Promise<void> {
  const toggle = page.getByTestId(`group-${id}-toggle`);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
}

function log(message: string): void {
  console.log(`[colour] ${message}`);
}

/**
 * A custom palette, seeded straight into `localStorage` before the page ever
 * loads, that clashes base against buildings -- the only ADJACENT_PAIRS
 * entry guaranteed to exist as a REAL region in the tiny-loop fixture this
 * whole file builds against: that fixture is buildings-only (no `highway`,
 * `natural=water`, `landuse` or `leisure` tag anywhere in it), so a fresh
 * `EngineResult` never carries a `roads`/`water`/`parks` region at all, and
 * `colourRows` prefers the live result the moment one exists -- a pair that
 * needs one of those three can never be demonstrated against this scene once
 * the first build has landed, whatever colour edit drives it (found the hard
 * way: base recoloured to water's own blue, applied and visibly on the
 * plate, still raised nothing, because there was no `water` ROW to compare
 * against, not because the colour never landed). `base`/`buildings` has no
 * such gap: both are always built.
 *
 * Applying the palette is one reliable button click
 * (`palette-apply-e2e-clash`), the same mechanism `applying Blueprint`/
 * `saving the current colours` already prove out; nothing here drives a
 * native `<input type="color">` directly -- a raw `HTMLInputElement`
 * value-setter + dispatched `input`/`change` event proved reliable in
 * isolated local runs but NOT inside a full `make gate` run under system
 * load, and a flaky wait is not something to paper over with a longer
 * timeout when a fully reliable path already exists.
 */
const CLASH_PALETTE = {
  id: "e2e-clash",
  name: "E2E clash",
  region_colors: {
    base: "#4A4A4A",
    frame: "#3A3A3A",
    matting: "#EDE9E0",
    buildings: "#4B4B4B",
    hero_building: "#E3A72F",
    roads: "#3A3A3A",
    water: "#2F7FC1",
    parks: "#5A9E4B",
    rail: "#6B6B6B",
    lettering: "#E3A72F",
    attribution: "#D8D3C6",
  },
  savedAt: "2026-01-01T00:00:00.000Z",
};

async function seedClashPalette(page: Page): Promise<void> {
  await page.addInitScript((palette) => {
    window.localStorage.setItem("framecraft.palettes.v1", JSON.stringify([palette]));
  }, CLASH_PALETTE);
}

/**
 * Wait for the debounced engine job to land a FRESH result. Every colour
 * swatch and the contrast checker's own rows read `colourRows`, which prefers
 * the live `EngineResult` over `params` the moment one exists -- so any edit
 * only reaches the panel once the rebuild this edit itself scheduled actually
 * completes, not immediately on the state write (`ColourGroup.tsx`'s own
 * docstring on `colourRows`). The stats card labels a stale result
 * "(previous computation)"; this is the same signal the preview-theme test
 * uses.
 */
async function waitForFreshBuild(page: Page): Promise<void> {
  await expect(page.getByTestId("stats-card")).not.toContainText("previous computation", {
    timeout: WARMUP_BUDGET_MS,
  });
}

// ==========================================================================
// Palettes
// ==========================================================================

test("applying Blueprint recolours the region rows and the preview, and marks the palette active", async ({
  page,
}) => {
  const pageErrors = watchPageErrors(page);
  await generateTinyLoop(page);
  await openGroup(page, "colour");

  const baseBefore = await page.locator("#colour_color_base").inputValue();

  await page.getByTestId("palette-apply-blueprint").click();
  await expect(page.getByTestId("palette-apply-blueprint")).toHaveAttribute("aria-pressed", "true");

  // Blueprint's base is a deep blueprint blue -- definitely not the frozen
  // default's warm stone, so this proves the swatch actually moved, not just
  // the button's own pressed state. `colourRows` sources a region row from the
  // live engine result once one exists (`generateTinyLoop` waits for one), so
  // the swatch only updates once the next debounced build, scheduled by this
  // very click, actually lands -- a plain `inputValue()` read races that.
  await expect(page.locator("#colour_color_base")).toHaveValue("#13315c", { timeout: WARMUP_BUDGET_MS });

  log(`base colour: ${baseBefore} -> #13315c`);
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});

test("saving the current colours as a custom palette and reapplying it restores them", async ({ page }) => {
  const pageErrors = watchPageErrors(page);
  await generateTinyLoop(page);
  await openGroup(page, "colour");

  // Apply Noir, wait for it to actually land (button clicks are the reliable
  // way to move `colour.region_colors` in this e2e suite -- a native
  // `<input type="color">` fires its own React update correctly, but the
  // swatch it renders is still a CONTROLLED value sourced from `colourRows`,
  // which prefers the live engine result the instant one exists, so it only
  // shows a hand-typed colour once the debounced rebuild that edit itself
  // scheduled has actually landed; button-driven writes hit the exact same
  // path, just already proven reliable by the Blueprint test above), THEN
  // save it under a name -- this is what proves "the current colours",
  // whatever produced them, round-trip through a custom palette.
  await page.getByTestId("palette-apply-noir").click();
  await expect(page.locator("#colour_color_base")).toHaveValue("#1c1c1c", { timeout: WARMUP_BUDGET_MS });

  await page.locator("#palette-save-name").fill("My test palette");
  await page.getByTestId("palette-save").click();

  const savedButton = page.locator('[data-testid^="palette-apply-custom-"]');
  await expect(savedButton).toBeVisible();
  await expect(savedButton).toHaveAttribute("aria-pressed", "true");

  // Switch away, then back.
  await page.getByTestId("palette-apply-blueprint").click();
  await expect(page.locator("#colour_color_base")).toHaveValue("#13315c", { timeout: WARMUP_BUDGET_MS });

  await savedButton.click();
  await expect(page.locator("#colour_color_base")).toHaveValue("#1c1c1c", { timeout: WARMUP_BUDGET_MS });

  log("custom palette round-tripped through save and reapply");
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});

// ==========================================================================
// Contrast checker
// ==========================================================================

test("a deliberately clashing pair (base and buildings both mid grey) raises the contrast warning", async ({
  page,
}) => {
  const pageErrors = watchPageErrors(page);
  await seedClashPalette(page);
  await generateTinyLoop(page);
  await openGroup(page, "colour");

  // The frozen defaults already carry the exact clash this test raises on
  // purpose (buildings/base, same nominal colour inherited from the v1/v2
  // seven-part table, different filament slots --
  // `lib/contrastCheck.test.ts`'s own documented case), so start from
  // Blueprint (proven clash-free, `palettes.test.ts`) to get a genuine
  // before/after: no warning, then one.
  await page.getByTestId("palette-apply-blueprint").click();
  await expect(page.locator("#colour_color_base")).toHaveValue("#13315c", { timeout: WARMUP_BUDGET_MS });
  await expect(page.getByTestId("colour-contrast-warning")).toHaveCount(0);

  // base and buildings recoloured to two near-identical greys -- genuinely
  // different slots (1 and 2), so this is a real clash, applied through the
  // one reliable path (a palette button click; see `CLASH_PALETTE`'s own
  // docstring for why not a raw colour input, and not `water`/`roads`/
  // `parks`, here).
  await page.getByTestId(`palette-apply-${CLASH_PALETTE.id}`).click();
  await waitForFreshBuild(page);

  const warning = page.getByTestId("colour-contrast-warning");
  await expect(warning).toContainText("Buildings", { timeout: WARMUP_BUDGET_MS });
  await expect(warning).toContainText("Base");

  log(`contrast warning: ${(await warning.textContent())?.replace(/\s+/g, " ").trim()}`);
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});

// ==========================================================================
// Preview theme: viewport-only, geometry untouched
// ==========================================================================

test("flipping the preview theme changes only the canvas background, never the built geometry", async ({
  page,
}) => {
  const pageErrors = watchPageErrors(page);
  await generateTinyLoop(page);

  const viewport = page.locator('[data-fc-viewport-theme]');
  const themeBefore = await viewport.getAttribute("data-fc-viewport-theme");
  expect(themeBefore).toBe("dark");

  const statsBefore = (await page.getByTestId("stats-card").textContent()) ?? "";

  await page.getByTestId("preview-theme-toggle").click();
  await expect(viewport).toHaveAttribute("data-fc-viewport-theme", "light");

  // The engine job re-runs on any params change (including this one), so
  // wait for the NEXT fresh result rather than racing it -- the card labels
  // itself "(previous computation)" and adds a "Parameters changed" line
  // while the debounced rebuild is still in flight, so waiting for that text
  // to clear is what "fresh" means here (mirrors `smoke.spec.ts`'s own
  // stats-card discipline). Then compare its own reported geometry -- volume
  // and triangle count are read straight off `EngineResult.merged`/`stats`,
  // so if the theme flip changed the actual solid, either number would move.
  const statsCard = page.getByTestId("stats-card");
  await expect(statsCard).not.toContainText("previous computation", { timeout: WARMUP_BUDGET_MS });
  const statsAfter = (await statsCard.textContent()) ?? "";
  expect(statsAfter.replace(/\s+/g, " ").trim()).toBe(statsBefore.replace(/\s+/g, " ").trim());

  log("stats card identical across the preview-theme flip");
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});

// ==========================================================================
// FRAME group: profile + shadow gap
// ==========================================================================

test("selecting the ogee profile and a shadow gap updates the panel and an export still downloads", async ({
  page,
}) => {
  const pageErrors = watchPageErrors(page);
  await generateTinyLoop(page);
  await openGroup(page, "frame");

  await page.getByTestId("frame-profile-ogee").click();
  await expect(page.getByTestId("frame-profile-ogee")).toHaveAttribute("aria-checked", "true");

  const shadowGapToggle = page.locator("#frame_style_shadow_gap_enabled");
  await shadowGapToggle.click();
  await expect(shadowGapToggle).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#frame_style_shadow_gap_width_mm")).toBeVisible();

  await page.getByTestId("export-button").click();
  await expect(page.getByTestId("download-links")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  const links = page.getByTestId("download-links").locator("a");
  await expect(links).not.toHaveCount(0);

  log(`ogee + shadow gap: ${await links.count()} download link(s)`);
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});
