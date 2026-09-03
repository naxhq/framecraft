import { expect, test } from "@playwright/test";

import { mockChicagoOverpass, watchOverpass } from "./overpassMock";

/**
 * The shareable configuration, end to end and across two browser contexts.
 *
 * `lib/share.test.ts` proves the payload round-trips; this proves the PRODUCT
 * does: that Copy link puts a real URL on the clipboard and in the address bar,
 * that opening it in a browser that has never seen this editor restores every
 * control -- including an engraving, a picked hero and a filament colour -- and
 * that it stops there rather than firing a live Overpass query nobody asked
 * for.
 */

const WARMUP_BUDGET_MS = 60_000;

const ingestFetches = (calls: ReturnType<typeof watchOverpass>): number =>
  calls.filter((call) => call.method === "POST").length;

function log(message: string): void {
  console.log(`[share] ${message}`);
}

test.describe.configure({ mode: "serial" });

test("a copied link restores the whole editor in a fresh browser", async ({
  page,
  context,
  browser,
}) => {
  // The clipboard is the point of the button, so the happy path is exercised
  // rather than assumed. The link is ALSO in the DOM, which is what a browser
  // that denies this permission falls back to -- and what this test reads.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  const calls = watchOverpass(page);
  await mockChicagoOverpass(page);
  await page.goto("/");

  // ---- 1. a preset, then a spread of v2 settings ------------------------
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-stats")).toBeVisible({
    timeout: WARMUP_BUDGET_MS,
  });

  await page.locator("#city_label").fill("Bergen");
  await page.locator("#plate_mm").fill("200");
  await expect(page.getByTestId("plate_mm-value")).toHaveText("200 mm");

  await page.getByTestId("group-frame-toggle").click();
  await page.getByTestId("engraving-add").click();
  await page.locator("#engraving_0_text").fill("{city}");
  await page.locator("#engraving_0_size_mm").fill("6");
  await page.locator("#engraving_0_edge").selectOption("bottom");
  await expect(page.getByTestId("engraving_0-fit")).toContainText("Cuts at");
  await page.locator("#hanger").selectOption("magnets");

  await page.getByTestId("group-colour-toggle").click();
  await page.locator("#color_mode").getByRole("radio", { name: "one per part" }).click();
  // The per-region wells, which is what actually reaches the exported file
  // (`colour.region_colors`); the v1 `part_colors` wells were removed in the
  // settings truth audit and their values are migrated on the way in.
  await page.getByTestId("colour-color-water").fill("#123456");
  await expect(page.getByTestId("colour-color-water")).toHaveValue("#123456");

  // A hero, picked from the keyboard so the test does not depend on a raycast
  // landing on a building.
  await page.getByTestId("preview-canvas").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("hero-item")).toHaveCount(1);
  // The id: what the share LINK actually carries (`PrintParams.hero_building_ids`
  // is a bare array of OSM way ids, [V3-P1]). The row's own TEXT is not where
  // to read it from any more -- since phase 3's hero auto-detect, a resolved
  // scene shows the building's real OSM name there instead
  // (`lib/heroes.ts:heroDisplayName`), which this row already has, having
  // generated its scene above. The Remove button's `aria-label` still spells
  // the id out verbatim regardless (`BuildingsGroup.tsx`), so read it from
  // there.
  const heroLabel = (await page.getByTestId("hero-item").first().textContent()) ?? "";
  log(`hero label with a resolved scene: ${heroLabel.trim()}`);
  const removeLabel = await page
    .getByTestId("hero-item")
    .first()
    .locator("button")
    .getAttribute("aria-label");
  const heroId = (removeLabel ?? "").replace("Remove hero building ", "").trim();
  expect(heroId).toMatch(/^\w+/);
  // The resolved name really is a name, not the bare id showing through
  // because nothing resolved -- otherwise the "after restore, before
  // Preview" check below (which asserts the id) would pass vacuously.
  expect(heroLabel).not.toContain(heroId);

  // ---- 2. copy the link -------------------------------------------------
  const copy = page.getByTestId("copy-link-button");
  await copy.click();
  const link = (await copy.getAttribute("data-share-url")) ?? "";
  expect(link, "the Copy link button carries no URL").toContain("s=v3.");
  log(`link is ${link.length} characters`);
  // The address bar became the link, without a navigation.
  expect(page.url()).toContain("s=v3.");
  // ...and it is in the DOM for a browser that refuses the clipboard.
  await expect(page.getByTestId("share-link")).toHaveValue(link);
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe(link);

  // ---- 3. open it in a browser that has never seen this editor ----------
  const fresh = await browser.newContext();
  const other = await fresh.newPage();
  const otherCalls = watchOverpass(other);
  await mockChicagoOverpass(other);
  try {
    await other.goto(link);
    await expect(other.getByTestId("editor")).toBeVisible();

    await expect(other.locator("#city_label")).toHaveValue("Bergen");
    await expect(other.getByTestId("plate_mm-value")).toHaveText("200 mm");
    await expect(other.getByTestId("radius_m-value")).toHaveText("900 m");
    await expect(other.getByTestId("group-buildings-toggle")).toContainText("1/12 heroes");
    // Before Preview there is no scene to resolve a NAME from at all (step 4
    // below asserts that restoring a link never fetches on its own), so the
    // honest, stable thing the row can show is the id the link carries --
    // never the misleading "unnamed building" a bare lookup-miss would claim.
    await expect(other.getByTestId("hero-item").first()).toContainText(heroId);
    await expect(other.getByTestId("hero-item").first()).not.toContainText("unnamed building");

    // A fresh context has fresh localStorage, so the two personalisation groups
    // are collapsed again and have to be opened to read their controls.
    await other.getByTestId("group-frame-toggle").click();
    await expect(other.getByTestId("engraving-row")).toHaveCount(1);
    await expect(other.locator("#engraving_0_text")).toHaveValue("{city}");
    await expect(other.locator("#engraving_0_size_mm")).toHaveValue("6");
    await expect(other.locator("#engraving_0_edge")).toHaveValue("bottom");
    await expect(other.locator("#hanger")).toHaveValue("magnets");

    await other.getByTestId("group-colour-toggle").click();
    await expect(other.getByTestId("colour-color-water")).toHaveValue("#123456");

    // ---- 4. it stops there: stale, ready to Preview, no fetch ------------
    await expect(other.getByTestId("preview-empty")).toBeVisible();
    await expect(other.getByTestId("preview-button")).toBeEnabled();
    await expect(other.getByTestId("share-notice")).toHaveCount(0);
    await other.waitForTimeout(1_000);
    expect(
      ingestFetches(otherCalls),
      "opening a shared link fetched a scene by itself",
    ).toBe(0);

    // ---- 5. Preview, and the lettering is really on the model -----------
    await other.getByTestId("preview-button").click();
    await expect(other.getByTestId("preview-stats")).toBeVisible({
      timeout: WARMUP_BUDGET_MS,
    });
    expect(ingestFetches(otherCalls)).toBe(1);

    // Now that a scene exists, the SAME hero re-resolves to the SAME name
    // Preview showed in the original context -- the restored id round-tripped
    // to a real building, not an id nothing in the re-ingested scene answers to.
    const restoredHeroLabel = (await other.getByTestId("hero-item").first().textContent()) ?? "";
    log(`hero label after restore + Preview: ${restoredHeroLabel.trim()}`);
    expect(restoredHeroLabel).not.toContain("unnamed building");
    expect(restoredHeroLabel.trim()).toBe(heroLabel.trim());

    const viewport = other.locator("[data-preview-text-count]");
    await expect
      .poll(async () => Number(await viewport.getAttribute("data-preview-text-count")), {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    log(
      `restored preview draws ${await viewport.getAttribute("data-preview-text-count")} rings of lettering`,
    );
  } finally {
    await fresh.close();
  }

  // Copying a link never triggered a fetch on the original page either.
  expect(ingestFetches(calls)).toBe(1);
});

test("a link this build cannot read is refused, not half-applied", async ({ page }) => {
  const calls = watchOverpass(page);
  // A valid-looking payload from a future schema: the version is the first
  // thing checked, so it is named rather than guessed at.
  await page.goto("/?s=v9.abcdef.00000000");

  const notice = page.getByTestId("share-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("different version");
  log(`refusal: ${(await notice.textContent())?.trim()}`);

  // The editor is on its defaults, whole -- not on some half-restored state.
  await expect(page.getByTestId("plate_mm-value")).toHaveText("180 mm");
  await expect(page.locator("#city_label")).toHaveValue("");
  await expect(page.getByTestId("preview-empty")).toBeVisible();
  await page.waitForTimeout(500);
  expect(ingestFetches(calls)).toBe(0);

  // The bad payload is taken back out of the address bar, so dismissing the
  // banner and reloading does not bring the same refusal back forever on what
  // is by then a bookmarked URL.
  expect(page.url()).not.toContain("s=v9");
  expect(new URL(page.url()).searchParams.get("s")).toBeNull();

  // It is a message about something that already happened, so it can be put away.
  await page.getByTestId("share-notice-dismiss").click();
  await expect(page.getByTestId("share-notice")).toHaveCount(0);

  // ...and it stays away across a reload, which it did not before.
  await page.reload();
  await expect(page.getByTestId("share-notice")).toHaveCount(0);
  await expect(page.getByTestId("plate_mm-value")).toHaveText("180 mm");
});

test("a truncated link says the link is damaged rather than doing nothing", async ({
  page,
}) => {
  // The digest is what turns "a chat client wrapped the URL" into a message.
  await page.goto("/?s=v2.eyJyIjp7ImxhdCI6NDEuODgyN30.deadbeef");
  const notice = page.getByTestId("share-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/edited or truncated|damaged/);
  await expect(page.getByTestId("plate_mm-value")).toHaveText("180 mm");
});
