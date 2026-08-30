import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Phase 1: the lettering token fix ([V3-P1]).
 *
 * Chicago preset -> `{city}` on the top frame edge resolves to "Chicago" in
 * the preview AND in the baked sidecar, without the user ever typing
 * anything. Clearing the Place name field warns with the specific empty
 * token; turning the frame off disables the lettering controls with the
 * required copy.
 *
 * Nominatim is route-mocked so this suite never touches the real geocoder:
 * the flow below never drops a custom pin (it stays on the Chicago preset,
 * which resolves its city name client-side, per `lib/presets.ts`), but the
 * mock is in place defensively so a future edit to this file cannot
 * accidentally add a live network dependency.
 */

const API_URL = process.env.NEXT_PUBLIC_BAKE_API_URL ?? "http://localhost:8000";
const WARMUP_BUDGET_MS = 60_000;
const A4_BUDGET_MS = 90_000;

function mockNominatim(page: Page): void {
  void page.route("**/nominatim.openstreetmap.org/**", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        address: {
          city: "Mock City",
          state: "Mock State",
          country: "Mock Country",
          neighbourhood: "Mock Neighbourhood",
        },
      }),
    }),
  );
}

async function generateChicago(page: Page): Promise<void> {
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-canvas")).toBeVisible({
    timeout: WARMUP_BUDGET_MS,
  });
  await expect(page.getByTestId("preview-stats")).toBeVisible({
    timeout: WARMUP_BUDGET_MS,
  });
}

/** Open a collapsed group by its id, a no-op if it is already open. */
async function openGroup(page: Page, id: string): Promise<void> {
  const group = page.getByTestId(`group-${id}`);
  if ((await group.getAttribute("data-collapsed")) === "true") {
    await page.getByTestId(`group-${id}-toggle`).click();
  }
  await expect(group).toHaveAttribute("data-collapsed", "false");
}

test("Chicago's {city} resolves in the preview, the Resolved output panel and the baked sidecar; an empty label warns; Frame off disables lettering", async ({
  page,
  request,
}) => {
  mockNominatim(page);
  await page.goto("/");
  await generateChicago(page);

  // ---- the preset alone resolves {city}, no typing required -------------
  await expect(page.locator("#city_label")).toHaveValue("Chicago");

  await openGroup(page, "frame");
  await page.getByTestId("engraving-add").click();
  await expect(page.getByTestId("engraving-row")).toHaveCount(1);
  // `newEngraving`'s default text is already "{city}" on the top edge.
  await expect(page.locator("#engraving_0_edge")).toHaveValue("top");
  await expect(page.locator("#engraving_0_text")).toHaveValue("{city}");
  await expect(page.getByTestId("engraving_0-preview")).toContainText("Chicago");

  // ---- the preview draws glyph rings for it ------------------------------
  const viewport = page.locator("[data-preview-text-count]");
  await expect
    .poll(async () => Number(await viewport.getAttribute("data-preview-text-count")))
    .toBeGreaterThan(0);

  // ---- the Resolved output panel names it as cutting "Chicago" ----------
  await openGroup(page, "output");
  const resolvedRow = page.getByTestId("resolved-output-row-engraving-0");
  await expect(resolvedRow).toBeVisible();
  await expect(resolvedRow).toHaveAttribute("data-status", "cut");
  await expect(resolvedRow).toContainText("Chicago");
  await expect(resolvedRow).toContainText("Frame, top edge");

  // ---- bake, and the sidecar carries the resolved text, not the token ---
  const bakeButton = page.getByTestId("bake-button");
  await expect(bakeButton).toBeEnabled();
  await bakeButton.click();
  const downloads = page.getByTestId("download-links");
  await expect(downloads).toBeVisible({ timeout: A4_BUDGET_MS });
  const link = downloads.getByRole("link", { name: /3MF/ });
  const href = await link.getAttribute("href");
  expect(href, "the 3MF link has no href").toBeTruthy();

  const sidecarName = (href as string).replace(/\.3mf$/i, ".json");
  const sidecar = await request.get(
    sidecarName.startsWith("http") ? sidecarName : `${API_URL}${sidecarName}`,
  );
  expect(sidecar.status(), `no bake sidecar at ${sidecarName}`).toBe(200);
  const sidecarBody = (await sidecar.json()) as {
    print_params: { engravings: Array<{ text: string }> };
  };
  expect(sidecarBody.print_params.engravings).toHaveLength(1);
  expect(sidecarBody.print_params.engravings[0].text).toBe("Chicago");

  // ---- clearing the Place name field warns, and the row shows skipped ---
  await page.locator("#city_label").fill("");
  await expect(page.locator("#city_label")).toHaveValue("");
  await expect(page.getByTestId("engraving_0-preview")).toContainText(
    "the {city} token has no value",
  );
  await expect(resolvedRow).toHaveAttribute("data-status", "skipped");
  await expect(resolvedRow).toContainText("Line 1: the {city} token has no value");

  const chip = page.getByTestId("adjustments-chip");
  await expect(chip).toBeVisible();
  await chip.click();
  const drawer = page.getByTestId("adjustments-drawer");
  await expect(drawer).toContainText("Line 1: the {city} token has no value");
  await chip.click();
  await expect(page.getByTestId("adjustments-drawer")).toHaveCount(0);

  // ---- Frame off disables the lettering controls with the required copy -
  await page.locator("#city_label").fill("Chicago");
  await page.locator("#frame").click();
  await expect(page.getByTestId("engravings-frame-off")).toContainText(
    "Turn on Frame to engrave the edges.",
  );
  await expect(page.getByTestId("engraving-row").first()).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(page.locator("#engraving_0_text")).toBeDisabled();
  await expect(resolvedRow).toHaveAttribute("data-status", "skipped");
  await expect(resolvedRow).toContainText("Frame is off");
});
