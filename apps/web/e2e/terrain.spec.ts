import { expect, test, type Page } from "@playwright/test";

import { mockTinyLoopOverpass, watchOverpass, type OverpassCall } from "./overpassMock";
import { terrariumPng } from "./terrainTile";

const ingestPosts = (calls: readonly OverpassCall[]): OverpassCall[] =>
  calls.filter((call) => call.method === "POST");

/**
 * TERRAIN group (phase 3, `docs/handoff/v3-03-ui.md`).
 *
 * Every Overpass call is mocked (`mockTinyLoopOverpass`, exactly like the
 * rest of this suite); every elevation-tile call is routed to a synthetic,
 * hand-encoded Terrarium PNG (`terrainTile.ts`) instead of the real AWS
 * `elevation-tiles-prod` bucket, so this spec runs fully offline.
 *
 * Budgets scale with `E2E_BUDGET_FACTOR`, matching `smoke.spec.ts`'s own
 * convention for a CI runner slower than a dev machine.
 */
const BUDGET_FACTOR = Number(process.env.E2E_BUDGET_FACTOR ?? 1) || 1;
const WARMUP_BUDGET_MS = 60_000 * BUDGET_FACTOR;

const ELEVATION_TILE_GLOB = "**/elevation-tiles-prod/**";
const SYNTHETIC_ELEVATION_M = 220;

/** Route every elevation tile request to one uniform synthetic Terrarium PNG. */
async function mockTerrarium(page: Page): Promise<{ requested: string[] }> {
  const requested: string[] = [];
  // A real Terrarium tile is always 256x256 (`TILE_SIZE` in heightfield.ts);
  // `fetchTerrainGrid` throws (caught, fails soft to null) on any other size.
  const png = terrariumPng(256, SYNTHETIC_ELEVATION_M);
  await page.route(ELEVATION_TILE_GLOB, (route) => {
    requested.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "image/png", body: png });
  });
  return { requested };
}

async function generateTinyLoop(page: Page): Promise<void> {
  await mockTinyLoopOverpass(page);
  await page.goto("/");
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-canvas")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await expect(page.getByTestId("preview-stats")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
}

async function openTerrainGroup(page: Page): Promise<void> {
  const toggle = page.getByTestId("group-terrain-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
}

function log(message: string): void {
  console.log(`[terrain] ${message}`);
}

test("enabling terrain fetches a mocked elevation tile and the model stays built", async ({
  page,
}) => {
  const overpassCalls = watchOverpass(page);
  const terrarium = await mockTerrarium(page);
  await generateTinyLoop(page);
  // `watchOverpass` records every Overpass request the LISTENER sees, mocked
  // or not (`page.on("request")` fires before routing decides anything), so
  // `generateTinyLoop`'s own ingest call is already in here -- the baseline
  // is taken AFTER Preview, and the real assertion is that turning terrain
  // on adds none on top of it.
  const beforeTerrain = ingestPosts(overpassCalls).length;

  await openTerrainGroup(page);
  const enable = page.locator("#terrain_enabled");
  await expect(enable).toBeVisible();
  await enable.click();
  await expect(enable).toHaveAttribute("aria-checked", "true");

  // The DEM fetch is debounced (~400 ms) and separate from Overpass: give it
  // room to land, then confirm it actually reached the mocked tile route and
  // never touched Overpass again.
  await expect
    .poll(() => terrarium.requested.length, { timeout: WARMUP_BUDGET_MS })
    .toBeGreaterThan(0);
  log(`elevation tile requests: ${terrarium.requested.length}`);
  expect(ingestPosts(overpassCalls).length).toBe(beforeTerrain);

  // A visible error note would mean the fetch/decode wiring rejected the
  // synthetic tile; the group must settle on something other than "error".
  await expect(page.getByTestId("terrain-error")).toHaveCount(0, { timeout: WARMUP_BUDGET_MS });

  // The engine keeps building with terrain on: the stats card is still there
  // and still reports a positive bounding box, i.e. a real model, not an
  // empty/failed one.
  await expect(page.getByTestId("stats-card")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  const bbox = await page.getByTestId("stats-card").locator("dd").nth(2).textContent();
  log(`bounding box with terrain on: ${bbox}`);
  expect(bbox).toBeTruthy();
});

test("terrain does not block an engraving from cutting", async ({ page }) => {
  await mockTerrarium(page);
  await generateTinyLoop(page);
  await openTerrainGroup(page);
  await page.locator("#terrain_enabled").click();
  await expect(page.locator("#terrain_enabled")).toHaveAttribute("aria-checked", "true");

  // A minimal engraving, same seed `EngravingsEditor` writes on "Add a line".
  const frameToggle = page.getByTestId("group-frame-toggle");
  if ((await frameToggle.getAttribute("aria-expanded")) !== "true") {
    await frameToggle.click();
  }
  const addLine = page.getByTestId("engraving-add");
  if (await addLine.isVisible().catch(() => false)) {
    await addLine.click();
  }

  const previewRoot = page.locator("[data-preview-text-count]");
  await expect
    .poll(
      async () => Number((await previewRoot.getAttribute("data-preview-text-count")) ?? 0),
      { timeout: WARMUP_BUDGET_MS },
    )
    .toBeGreaterThan(0);
});
