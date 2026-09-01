import { expect, test, type Page } from "@playwright/test";

import { DEFAULT_PRINT_PARAMS, PARAM_RANGES } from "../lib/contracts";
import * as T from "../lib/transform";
import { mockChicagoOverpass, watchOverpass, type OverpassCall } from "./overpassMock";

/**
 * The editor's own behaviour. Since FrameCraft v3 E4 the only network call
 * this app ever makes is the ingest fetch to an Overpass mirror
 * (`**\/api/interpreter`), routed to the committed Chicago Loop fixture by
 * `overpassMock.ts` so this suite runs fully offline and deterministically;
 * everything else (the bake, every export target, every PrintParams write)
 * is client-side WASM and a Blob download, asserted with no network watcher
 * at all.
 *
 * `smoke.spec.ts` owns 01's acceptance criteria; this file owns the things the
 * v2 redesign introduced and that a unit test cannot reach: self-hosted fonts,
 * the responsive breakpoints, the collapsible groups and their persistence,
 * the adjustments chip, the keyboard map, and hero picking by raycast.
 */

const WARMUP_BUDGET_MS = 60_000;

/**
 * The largest cap height the SHARED layout refuses for the seeded engraving.
 *
 * F2 fixed this test by naming 3 mm as "a size the shared math really refuses",
 * measured once by hand - and the measurement put the flip between 3.0 and
 * 3.25 mm, so a change to `text_stroke_target_mm`, to the nozzle default or to
 * the bundled face moves the literal onto the wrong side of it. That is the
 * same class of coupling F2 was written about, just to a measurement instead of
 * to a default (v2-07 audit, finding 9). So the number is derived here, from
 * `lettering_layout` itself - the very function the panel's verdict comes from
 * - by walking the slider's own 0.1 mm step down from the seeded default.
 *
 * The seed is `EngravingsEditor.newEngraving`: the first free edge (top),
 * centred, `{city}`, engraved, sans, at the contract's default cap height and
 * depth. `{city}` expands from `city_label`, a PrintParams field, so this fit
 * does not depend on the scene at all and the context below only has to be
 * well-formed.
 */
function largestRefusedCapHeightMm(): number {
  const ctx = {
    lat: 41.8827,
    lon: -87.6233,
    scale_mm_per_m: 168 / 1800,
    radius_m: 900,
    date: "2026-08-30",
    buildings: 994,
    city: "Chicago",
  };
  const { min, max, default: seeded } = PARAM_RANGES.engravings.size_mm;
  for (let tenths = Math.round(seeded * 10) - 1; tenths >= Math.round(min * 10); tenths -= 1) {
    const size_mm = tenths / 10;
    const params = {
      ...DEFAULT_PRINT_PARAMS,
      city_label: "Chicago",
      engravings: [
        {
          edge: "top" as const,
          align: "center" as const,
          text: "{city}",
          mode: "engrave" as const,
          size_mm,
          depth_mm: PARAM_RANGES.engravings.depth_mm.default,
          font: "sans" as const,
        },
      ],
    };
    if (T.lettering_layout(params, ctx).engravings[0].fit.refused) return size_mm;
  }
  throw new Error(
    `the shared layout refuses no cap height in [${min}, ${max}] mm for "Chicago" - ` +
      "this test cannot assert a refusal that does not exist",
  );
}

const REFUSED_SIZE_MM = largestRefusedCapHeightMm();

/** Every font host this product is forbidden to touch at runtime. */
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

const ingestFetches = (calls: OverpassCall[]): number =>
  calls.filter((call) => call.method === "POST").length;

/** Mock Overpass, load Chicago and wait for the preview to exist. */
async function generateChicago(page: Page): Promise<void> {
  await mockChicagoOverpass(page);
  await page.goto("/");
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-canvas")).toBeVisible({
    timeout: WARMUP_BUDGET_MS,
  });
  await expect(page.getByTestId("preview-stats")).toBeVisible({
    timeout: WARMUP_BUDGET_MS,
  });
}

/**
 * Move a range input the way a user does, WITHOUT releasing it: `fill` fires
 * input/change and never pointerup/keyup, so it exercises a PrintParams change
 * that must never trigger a fetch (the radius and rotation commit gates fire on
 * release, and only those two ever cause one, via the ingest job).
 */
async function setSlider(page: Page, id: string, value: number): Promise<void> {
  await page.locator(`#${id}`).fill(String(value));
}

function log(message: string): void {
  console.log(`[ui] ${message}`);
}

// ==========================================================================
// Typography
// ==========================================================================

test("self-hosted fonts: nothing is fetched from a Google font host", async ({
  page,
}) => {
  const offenders: string[] = [];
  page.on("request", (request) => {
    const host = new URL(request.url()).hostname;
    if (FONT_HOSTS.includes(host)) offenders.push(request.url());
  });

  const fontResponses: string[] = [];
  page.on("response", (response) => {
    const url = response.url();
    if (/\.woff2?($|\?)/.test(url)) fontResponses.push(new URL(url).origin);
  });

  await page.goto("/");
  await expect(page.getByTestId("editor")).toBeVisible();
  // Give the browser time to decide it needs the display face.
  await page.waitForTimeout(1_500);

  expect(offenders, `requests to a Google font host: ${offenders.join(", ")}`).toEqual(
    [],
  );

  // The two faces really are in use, and they come from this origin.
  const wordmark = page.getByTestId("editor").locator("h1");
  const display = await wordmark.evaluate((node) => getComputedStyle(node).fontFamily);
  const body = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  log(`display face: ${display}`);
  log(`ui face: ${body}`);
  expect(display).toContain("Archivo");
  expect(body).toContain("IBM Plex Sans");

  const origin = new URL(page.url()).origin;
  for (const fontOrigin of fontResponses) {
    expect(fontOrigin, `a font was served from ${fontOrigin}`).toBe(origin);
  }
  log(`${fontResponses.length} font files, all from ${origin}`);
});

// ==========================================================================
// Control groups
// ==========================================================================

test("control groups collapse, persist across a reload, and hide their controls", async ({
  page,
}) => {
  await page.goto("/");

  // Frame and text, and Colour, start collapsed; the rest start open.
  await expect(page.getByTestId("group-frame")).toHaveAttribute(
    "data-collapsed",
    "true",
  );
  await expect(page.getByTestId("group-colour")).toHaveAttribute(
    "data-collapsed",
    "true",
  );
  await expect(page.getByTestId("group-scale")).toHaveAttribute(
    "data-collapsed",
    "false",
  );
  await expect(page.locator("#plate_mm")).toBeVisible();

  // Collapsing really removes the controls rather than hiding them.
  await page.getByTestId("group-scale-toggle").click();
  await expect(page.getByTestId("group-scale")).toHaveAttribute(
    "data-collapsed",
    "true",
  );
  await expect(page.locator("#plate_mm")).toHaveCount(0);

  // Opening Colour reveals all seven part-colour wells.
  await page.getByTestId("group-colour-toggle").click();
  await expect(page.getByTestId("part-colors").locator('input[type="color"]')).toHaveCount(
    7,
  );

  // ...and the state survives a reload.
  await page.reload();
  await expect(page.getByTestId("group-scale")).toHaveAttribute(
    "data-collapsed",
    "true",
  );
  await expect(page.getByTestId("group-colour")).toHaveAttribute(
    "data-collapsed",
    "false",
  );
  await expect(page.locator("#plate_mm")).toHaveCount(0);

  // Put it back so the later tests start from the defaults.
  await page.getByTestId("group-scale-toggle").click();
  await page.getByTestId("group-colour-toggle").click();
  await expect(page.locator("#plate_mm")).toBeVisible();
});

// ==========================================================================
// The v2 fields are still purely local
// ==========================================================================

test("the v2 personalisation fields never trigger a fetch", async ({ page }) => {
  const calls = watchOverpass(page);
  await generateChicago(page);

  const before = calls.length;

  await page.locator("#city_label").fill("Chicago");
  await expect(page.locator("#city_label")).toHaveValue("Chicago");

  await page.getByTestId("group-colour-toggle").click();
  // The wells are disabled until the user asks for one filament per part.
  await expect(page.locator("#part_color_water")).toBeDisabled();
  await page.locator("#color_mode").getByRole("radio", { name: "one per part" }).click();
  await expect(page.locator("#part_color_water")).toBeEnabled();
  await page.locator("#part_color_water").fill("#123456");
  await expect(page.getByTestId("part_color_water-hex")).toHaveText("#123456");

  await page.getByTestId("group-frame-toggle").click();
  await page.getByTestId("engraving-add").click();
  await expect(page.getByTestId("engraving-row")).toHaveCount(1);
  await page.locator("#engraving_0_text").fill("{city} {coords}");
  // The expansion is the real token table, so it shows the typed label back.
  await expect(page.getByTestId("engraving_0-preview")).toContainText("Chicago");
  await expect(page.getByTestId("engraving_0-preview")).toContainText("° N");

  await page.locator("#hanger").selectOption("keyhole");
  await page.locator("#north_arrow_enabled").click();
  await expect(page.locator("#north_arrow_corner")).toBeVisible();

  // ...and picking a hero building, which is a PrintParams write like any
  // other even though it happens in the 3D viewport and now changes the
  // geometry on screen (the hero is drawn at its true height).
  const viewport = page.getByTestId("preview-canvas");
  await viewport.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("hero-item")).toHaveCount(1);

  // `hero_mode` is the one v2 control that changes the model's HEIGHT, so it is
  // the most plausible candidate for a refetch. Both directions, so a listener
  // that only fires on one of them cannot hide.
  await page.locator("#hero_mode").selectOption("own_color");
  await expect(page.locator("#hero_mode")).toHaveValue("own_color");
  await page.locator("#hero_mode").selectOption("true_height");
  await expect(page.locator("#hero_mode")).toHaveValue("true_height");

  // The remaining v2 writes that are neither text nor colour: the scale bar and
  // the underside mark, both of which the bake reads and never causes a fetch.
  await page.locator("#scale_bar_enabled").click();
  await expect(page.locator("#scale_bar_edge")).toBeVisible();
  await page.locator("#underside_mark_enabled").click();

  await page.waitForTimeout(1_000);
  const after = calls.slice(before);
  expect(after, `a v2 field triggered a fetch: ${JSON.stringify(after)}`).toEqual([]);
});

// ==========================================================================
// Slot colour conflicts (audit v3-02 MAJOR finding 4)
// ==========================================================================

test("a slot shared by regions of different colours warns, shows what will actually print, and aligns in one click", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("group-colour-toggle").click();

  // The untouched default colour table already disagrees on slot 4 (roads,
  // parks, rail, lettering and hero_building all share it with different
  // `region_colors`).
  const warning = page.getByTestId("colour-slot-conflicts");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("slot 4");

  // Parks' own well disagrees with its "prints as" swatch.
  const swatch = page.getByTestId("colour-prints-as-parks");
  await expect(swatch).toBeVisible();
  const printedTitle = (await swatch.getAttribute("title")) ?? "";
  expect(printedTitle).toContain("Prints as #");
  const ownValue = await page.locator("#colour_color_parks").inputValue();
  log(`parks own colour: ${ownValue}; ${printedTitle}`);
  expect(printedTitle.toLowerCase()).not.toContain(ownValue.toLowerCase());

  // One click aligns every losing region to what will actually print --
  // the warning clears once nothing disagrees any more.
  await page.getByTestId("align-slot-colours").click();
  await expect(warning).toHaveCount(0);
  await expect(page.getByTestId("colour-prints-as-parks")).toHaveCount(0);
});

// ==========================================================================
// Frame lettering in the preview
// ==========================================================================

test("an engraving appears on the frame, and a refused one does not", async ({
  page,
}) => {
  const calls = watchOverpass(page);
  await generateChicago(page);

  // The count is rings actually drawn on the plate, published by the viewport.
  const viewport = page.locator("[data-preview-text-count]");
  const drawn = async (): Promise<number> =>
    Number(await viewport.getAttribute("data-preview-text-count"));
  await expect(viewport).toHaveAttribute("data-preview-text-count", "0");

  await page.locator("#city_label").fill("Chicago");
  await page.getByTestId("group-frame-toggle").click();
  await page.getByTestId("engraving-add").click();
  await expect(page.getByTestId("engraving-row")).toHaveCount(1);

  const verdict = page.getByTestId("engraving_0-fit");
  const before = calls.length;

  // A new line takes the contract's default cap height, which [V2-P5-fix]
  // RAISED from 3.0 mm to 4.0 mm for exactly this reason: at 3 mm the default
  // face refuses six of eight real strings, so a freshly seeded engraving used
  // to be born unprintable. Pinned here, because until V2-P7 this test got its
  // refusal for free from the old default and silently became a "the default
  // is refused" assertion the moment the contract said otherwise.
  await expect(page.getByTestId("engraving_0_size_mm-value")).toHaveText("4.0 mm");
  await expect(verdict).toContainText("Cuts at");
  await expect.poll(drawn, { timeout: 15_000 }).toBeGreaterThan(0);

  // Now the refusal, at a size the shared math really refuses - taken FROM the
  // shared math (`largestRefusedCapHeightMm`), not written down, because the
  // boundary sits a tenth of a millimetre away and a literal drifts onto the
  // wrong side of it the moment a stroke target or the bundled face moves.
  // Around 3 mm a 0.4 mm nozzle closes the counter of the `a` in "Chicago".
  // The panel says so, and the preview takes the letters back off the plate:
  // showing text the bake will not cut is the divergence this whole phase
  // exists to avoid.
  log(`the shared layout refuses a ${REFUSED_SIZE_MM.toFixed(1)} mm cap height`);
  await page.locator("#engraving_0_size_mm").fill(String(REFUSED_SIZE_MM));
  await expect(page.getByTestId("engraving_0_size_mm-value")).toHaveText(
    `${REFUSED_SIZE_MM.toFixed(1)} mm`,
  );
  await expect(verdict).toContainText("Not cut");
  await expect(verdict).toContainText("mm");
  await expect.poll(drawn, { timeout: 15_000 }).toBe(0);

  // Raise the cap height past the refusal and the letters come back.
  await page.locator("#engraving_0_size_mm").fill("6");
  await expect(verdict).toContainText("Cuts at");
  await expect
    .poll(drawn, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const withText = await drawn();
  log(`engraving drawn as ${withText} rings`);
  // Eight rings for the seven letters of "Chicago": the `i` is two disjoint
  // pieces, stem and tittle, and the count is of RINGS the earcut receives --
  // which is what makes it a measure of geometry rather than of characters.
  expect(withText).toBe(8);

  // The ornaments land on the same face, from the same layout.
  await page.locator("#north_arrow_enabled").click();
  await expect.poll(drawn).toBeGreaterThan(withText);

  // The frame carries all of it, so turning the frame off takes it away and
  // says why -- in the adjustments drawer, with the shared math's own words.
  await page.locator("#frame").click();
  await expect.poll(drawn).toBe(0);
  await page.getByTestId("adjustments-chip").click();
  // Sentence case in the drawer, the shared math's own words otherwise.
  await expect(page.getByTestId("adjustments-drawer")).toContainText(
    "The frame is off, so there is no lip to carry",
  );
  await page.keyboard.press("Escape");
  await page.locator("#frame").click();
  await expect.poll(drawn).toBeGreaterThan(0);

  // None of that ever triggered a fetch.
  await page.waitForTimeout(500);
  expect(calls.slice(before)).toEqual([]);
});

// ==========================================================================
// The hanger floor: the editor predicts the bake's refusal
// ==========================================================================

test("a keyhole the base cannot carry disables Bake and names the minimum", async ({
  page,
}) => {
  // `transform.underside_min_base_mm` is what the engine refuses on, and two
  // docstrings in `transform.ts` claim the editor predicts the refusal from
  // it. Both numbers below come from the shared math, not from this file.
  await generateChicago(page);

  const bake = page.getByTestId("bake-button");
  await expect(bake).toBeEnabled();
  await expect(page.getByTestId("base_thickness_mm-value")).toHaveText("3.0 mm");

  const needed = T.underside_min_base_mm({
    ...DEFAULT_PRINT_PARAMS,
    hanger: "keyhole",
  });
  // 2.0 mm of pocket + 1.0 mm of plate over it + the 0.6 mm the DEFAULT
  // engraved roads take off the same plate from above. Not `hanger_min_base_mm`
  // alone, which is 3.0 and would be a number the bake then refuses anyway.
  expect(needed).toBeCloseTo(3.6, 9);

  await page.getByTestId("group-frame-toggle").click();
  await page.locator("#hanger").selectOption("keyhole");

  await expect(page.getByTestId("bake-block-reason")).toContainText(
    `Keyhole hanger needs a base of at least ${needed.toFixed(1)} mm (now 3.0 mm)`,
  );
  await expect(page.getByTestId("bake-block-reason")).toContainText(
    "raise the base thickness or choose no hanger",
  );
  await expect(page.getByTestId("warning-base-too-thin-for-underside")).toBeVisible();
  await expect(bake).toBeDisabled();

  // Clicking it must do nothing either -- a disabled button is the UI, the
  // store's own guard is the contract (`store.requestBake` re-checks): the
  // bake state stays exactly `idle`, nothing starts exporting.
  await bake.click({ force: true });
  await page.waitForTimeout(500);
  await expect(page.getByTestId("bake-status")).toHaveCount(0);

  // Raise the base past the minimum and Bake comes back.
  await page.locator("#base_thickness_mm").fill("4");
  await expect(page.getByTestId("base_thickness_mm-value")).toHaveText("4.0 mm");
  await expect(page.getByTestId("warning-base-too-thin-for-underside")).toHaveCount(0);
  await expect(page.getByTestId("bake-block-reason")).toHaveCount(0);
  await expect(bake).toBeEnabled();
});

// ==========================================================================
// The detail advisor
// ==========================================================================

test("the detail chip follows the plate, and names a radius that would fix it", async ({
  page,
}) => {
  const calls = watchOverpass(page);
  await generateChicago(page);

  const chip = page.getByTestId("detail-health");
  await expect(chip).toBeVisible();

  // A 256 mm plate prints the 900 m Chicago crop at 1:7,500: only a third of
  // the footprints need widening and the band is `good`, so there is no advice
  // to give and the strip stays off the screen.
  await setSlider(page, "plate_mm", 256);
  await expect(chip).toHaveAttribute("data-band", "good");
  const goodScore = Number(await chip.getAttribute("data-score"));
  await expect(page.getByTestId("detail-recommendation")).toHaveCount(0);

  const before = calls.length;
  await setSlider(page, "plate_mm", 100);
  await expect(chip).toHaveAttribute("data-band", "fair");
  const fairScore = Number(await chip.getAttribute("data-score"));
  log(`detail health: ${goodScore} good at plate 256 -> ${fairScore} fair at plate 100`);
  expect(fairScore).toBeLessThan(goodScore);
  await expect(chip).toContainText("fair");

  const advice = page.getByTestId("detail-recommendation");
  await expect(advice).toBeVisible();
  await expect(advice).toContainText("Radius 900 m at plate 100");
  await expect(advice).toContainText(/Try \d+ m/);

  // The remedy is a button carrying the solved number, not a hint.
  const useRadius = page.getByTestId("advisor-use-radius");
  await expect(useRadius).toBeVisible();
  const radius = Number(await useRadius.getAttribute("data-value"));
  expect(radius).toBeGreaterThan(0);
  expect(radius).toBeLessThan(900);
  await expect(advice).toContainText(`Try ${radius} m`);
  log(`advisor offers "${await useRadius.textContent()}"`);

  // Nothing so far triggered a fetch: the whole advisor is arithmetic over the
  // scene already in memory.
  await page.waitForTimeout(800);
  expect(
    calls.slice(before),
    `the advisor refetched the scene: ${JSON.stringify(calls.slice(before))}`,
  ).toEqual([]);

  // ---- and now click it -------------------------------------------------
  //
  // Nothing in the repository proved the button performs the commit;
  // `lib/advisor.test.ts` proves only that `applyAdvisorAction` calls
  // `setRadius` then `generate` on a stub (audit v2-06 finding 6).
  //
  // The remedy is by construction NOT a preset radius, so this is the one
  // place in this file that re-ingests: the mocked route from
  // `generateChicago` still answers it (Overpass does not see the radius),
  // so only the REQUEST COUNT is asserted, never a live network dependency.
  const ingestBefore = ingestFetches(calls);
  await useRadius.click();
  await expect(page.getByTestId("radius_m-value")).toHaveText(`${radius} m`);
  await expect.poll(() => ingestFetches(calls) - ingestBefore, { timeout: 15_000 }).toBe(1);
  // Exactly one, not one per re-render: `generate` supersedes and replaces
  // through the engine client, it does not stack.
  await page.waitForTimeout(1_500);
  expect(ingestFetches(calls) - ingestBefore).toBe(1);
  log(`"Use ${radius} m" moved the radius to ${radius} m with exactly 1 ingest fetch`);
});

// ==========================================================================
// Heroes are drawn at their hero height
// ==========================================================================

test("a hero keeps its true height when the other buildings are scaled down", async ({
  page,
}) => {
  await generateChicago(page);
  await page.waitForTimeout(1_000);

  const predicted = page.getByTestId("predicted-height");
  const heightMm = async (): Promise<number> =>
    Number(await predicted.getAttribute("data-predicted-mm"));

  // Halve both multipliers: every building, including the tallest, is drawn at
  // half its relative height.
  await setSlider(page, "small_scale", 50);
  await setSlider(page, "large_scale", 50);
  await expect(page.getByTestId("large_scale-value")).toHaveText("50 %");
  const halved = await heightMm();

  // The keyboard cursor walks the buildings tallest first, so the first arrow
  // lands on the one that sets the predicted top.
  const viewport = page.getByTestId("preview-canvas");
  await viewport.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("hero-item")).toHaveCount(1);

  // `hero_height_scale` is `max(1.0, the multiplier its class would get)`, so
  // at 50 % the hero comes back to its full relative height and the model gets
  // taller -- the number the engine's own 60 mm guard compares.
  await expect.poll(heightMm).toBeGreaterThan(halved);
  const withHero = await heightMm();
  log(`predicted height: ${halved} mm halved -> ${withHero} mm with a hero`);
  const base = 3;
  expect(withHero - base).toBeCloseTo(2 * (halved - base), 0);

  // In `own_color` the hero prints at everyone else's height again, so the
  // prediction has to come back down.
  await page.getByTestId("group-colour-toggle").click();
  await page.locator("#hero_mode").selectOption("own_color");
  await expect.poll(heightMm).toBe(halved);
});

// ==========================================================================
// Adjustments chip
// ==========================================================================

test("informational warnings collapse into one chip that opens a grouped drawer", async ({
  page,
}) => {
  await generateChicago(page);

  const chip = page.getByTestId("adjustments-chip");
  await expect(chip).toBeVisible();
  const label = (await chip.textContent()) ?? "";
  log(`chip: ${label.trim()}`);
  expect(label).toMatch(/\d+ adjustments? made/);

  // Closed by default: the drawer's items are not on screen.
  await expect(page.getByTestId("adjustments-drawer")).toHaveCount(0);
  await expect(chip).toHaveAttribute("aria-expanded", "false");

  await chip.click();
  const drawer = page.getByTestId("adjustments-drawer");
  await expect(drawer).toBeVisible();
  await expect(chip).toHaveAttribute("aria-expanded", "true");

  const items = drawer.getByTestId("adjustment-item");
  const count = await items.count();
  expect(count).toBeGreaterThan(0);
  // The chip counts exactly what the drawer lists.
  expect(label).toContain(String(count));
  // Chicago's heights are largely estimated, so that one is in here.
  await expect(drawer).toContainText("estimated");

  await chip.click();
  await expect(page.getByTestId("adjustments-drawer")).toHaveCount(0);
});

// ==========================================================================
// Keyboard
// ==========================================================================

test("keyboard: ? opens the sheet, letters are ignored while typing, R resets", async ({
  page,
}) => {
  const calls = watchOverpass(page);
  await generateChicago(page);

  // ? opens the sheet; Escape closes it.
  await page.keyboard.press("?");
  await expect(page.getByTestId("shortcut-sheet")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shortcut-sheet")).toHaveCount(0);

  // Typing in a text field must not fire anything.
  const beforeTyping = calls.length;
  const bakeStatus = page.getByTestId("bake-status");
  await page.locator("#city_label").fill("");
  await page.locator("#city_label").pressSequentially("Bergen");
  await expect(page.locator("#city_label")).toHaveValue("Bergen");
  await expect(page.getByTestId("shortcut-sheet")).toHaveCount(0);
  await expect(bakeStatus).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(calls.slice(beforeTyping)).toEqual([]);

  // R from outside a field resets every parameter, including the label.
  await page.locator("#plate_mm").fill("220");
  await expect(page.getByTestId("plate_mm-value")).toHaveText("220 mm");
  // Move focus out of the text field without touching the preview (a click on
  // the canvas would pick a hero).
  await page.getByTestId("editor").locator("h1").click();
  await page.keyboard.press("r");
  await expect(page.getByTestId("plate_mm-value")).toHaveText("180 mm");
  await expect(page.locator("#city_label")).toHaveValue("");

  // G on a current scene is a no-op, exactly like the disabled button. The
  // precondition is asserted first: if the scene had gone stale, "G fetched"
  // would be correct behaviour and the request count would be the wrong thing
  // to blame.
  await expect(page.getByTestId("generate-button")).toBeDisabled();
  const beforeG = ingestFetches(calls);
  await page.keyboard.press("g");
  await page.waitForTimeout(800);
  expect(ingestFetches(calls) - beforeG).toBe(0);
  await expect(page.getByTestId("generate-button")).toBeDisabled();
});

test("the shortcut sheet is really modal: no letter reaches the editor behind it", async ({
  page,
}) => {
  const calls = watchOverpass(page);
  await generateChicago(page);

  await page.getByTestId("plate_mm-value").waitFor();
  await page.getByTestId("shortcuts-button").click();
  await expect(page.getByTestId("shortcut-sheet")).toBeVisible();

  const before = calls.length;
  // B advertises "Bake the printable model" ON THIS SHEET; pressing it here
  // used to start a real server bake behind the dialog. R used to reset every
  // parameter, including up to eight engraving lines and twelve heroes.
  await page.keyboard.press("b");
  await page.keyboard.press("r");
  await page.keyboard.press("g");
  await page.waitForTimeout(800);

  await expect(page.getByTestId("shortcut-sheet")).toBeVisible();
  await expect(page.getByTestId("bake-status")).toHaveCount(0);
  expect(
    calls.slice(before),
    `a shortcut fired behind the modal: ${JSON.stringify(calls.slice(before))}`,
  ).toEqual([]);

  // Escape still gets through, because that is the modal's own key.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shortcut-sheet")).toHaveCount(0);
  // ...and the shortcuts work again once it is closed.
  await page.keyboard.press("?");
  await expect(page.getByTestId("shortcut-sheet")).toBeVisible();
  await page.getByTestId("shortcut-sheet-close").click();
});

test("Escape closes the adjustments drawer from anywhere, and hands focus back", async ({
  page,
}) => {
  await generateChicago(page);

  const chip = page.getByTestId("adjustments-chip");
  await chip.click();
  await expect(page.getByTestId("adjustments-drawer")).toBeVisible();

  // Focus somewhere else entirely: the drawer's Escape handler used to be a
  // React onKeyDown on the chip's wrapper, so this was where it stopped working
  // — while the shortcut sheet advertised "Esc — close the drawer, sheet or
  // dialog".
  await page.locator("#plate_mm").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("adjustments-drawer")).toHaveCount(0);

  // Focus stays where the user put it: Escape from a slider must not yank it.
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("plate_mm");

  // From inside the widget, focus comes back to the chip so the keyboard user
  // is not dropped at the top of the document.
  await chip.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("adjustments-drawer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("adjustments-drawer")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("data-testid"),
    ),
  ).toBe("adjustments-chip");

  // The drawer is focusable, so a keyboard user can scroll it once there is
  // enough in it to scroll (axe rates the alternative `serious`).
  await chip.click();
  await expect(page.getByTestId("adjustments-drawer")).toHaveAttribute("tabindex", "0");
});

// ==========================================================================
// Hero picking
// ==========================================================================

test("a hero building can be picked with the keyboard alone", async ({ page }) => {
  const calls = watchOverpass(page);
  await generateChicago(page);
  await page.waitForTimeout(1_000);

  const viewport = page.getByTestId("preview-canvas");
  await expect(viewport).toHaveAttribute("tabindex", "0");
  await viewport.focus();

  // The first arrow lands on the tallest building, whichever arrow it is.
  await page.keyboard.press("ArrowRight");
  const status = page.getByTestId("preview-cursor");
  await expect(status).toBeVisible();
  await expect(status).toContainText("Building 1 of");
  const first = (await status.textContent()) ?? "";
  log(`cursor: ${first.trim()}`);

  await page.keyboard.press("ArrowRight");
  await expect(status).toContainText("Building 2 of");

  const before = calls.length;
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("hero-item")).toHaveCount(1);
  await expect(status).toContainText("hero");

  // Enter again drops it: the same key, the same building.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("hero-item")).toHaveCount(0);

  // Home jumps back to the tallest.
  await page.keyboard.press("Home");
  await expect(status).toContainText("Building 1 of");

  await page.waitForTimeout(400);
  expect(calls.slice(before)).toEqual([]);
});

test("clicking a building in the preview picks it as a hero, and clicking it again drops it", async ({
  page,
}) => {
  const calls = watchOverpass(page);
  await generateChicago(page);
  // The camera settles after the fit; a click mid-animation can miss.
  await page.waitForTimeout(1_500);

  const canvas = page.getByTestId("preview-canvas");
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();
  const frame = box as { x: number; y: number; width: number; height: number };
  const heroes = page.getByTestId("hero-item");
  const before = calls.length;

  // The plate is dense but a single point can still land on the base, so try a
  // small grid around the centre until one click lands on a building. This
  // works whether the instanced approximation or the fresh RegionMeshes are
  // what is visually on screen: picking always raycasts the (possibly
  // invisible) instanced mesh, which three.js does regardless of visibility
  // or material opacity (`components/scene/InstancedBuildings.tsx`).
  const offsets = [
    [0, 0],
    [-0.08, 0.02],
    [0.08, 0.02],
    [0, 0.1],
    [-0.14, -0.04],
    [0.14, -0.04],
    [-0.05, 0.14],
    [0.05, 0.14],
    [0, -0.08],
  ];
  let hit: { x: number; y: number } | null = null;
  for (const [dx, dy] of offsets) {
    const point = {
      x: frame.width / 2 + dx * frame.width,
      y: frame.height / 2 + dy * frame.height,
    };
    await canvas.click({ position: point });
    if ((await heroes.count()) > 0) {
      hit = point;
      break;
    }
  }
  expect(hit, "no click in the middle of a 900 m Chicago crop hit a building").not.toBeNull();

  await expect(heroes).toHaveCount(1);
  const picked = (await heroes.first().textContent()) ?? "";
  log(`hero picked: ${picked.trim()}`);
  await expect(page.getByTestId("hero-hint")).toContainText("1 hero building");
  await expect(page.getByTestId("group-buildings-toggle")).toContainText("1/12 heroes");

  // Clicking the same building again drops it.
  await canvas.click({ position: hit as { x: number; y: number } });
  await expect(heroes).toHaveCount(0);

  // ...and none of that triggered a fetch.
  await page.waitForTimeout(500);
  expect(calls.slice(before)).toEqual([]);
});

// ==========================================================================
// Hero auto-detection (phase 3, docs/handoff/v3-03-ui.md)
// ==========================================================================

test("auto-detect promotes real, named landmarks on the Chicago fixture", async ({
  page,
}) => {
  await generateChicago(page);

  const buildingsToggle = page.getByTestId("group-buildings-toggle");
  if ((await buildingsToggle.getAttribute("aria-expanded")) !== "true") {
    await buildingsToggle.click();
  }
  await page.locator("#hero_auto_enabled").click();
  await expect(page.locator("#hero_auto_enabled")).toHaveAttribute("aria-checked", "true");
  // A generous quota: downtown Chicago carries plenty of named towers among
  // its tallest and biggest-footprint buildings, but not every one of the
  // very top few necessarily has an OSM `name` tag, so this widens the net
  // rather than betting the test on exactly which one wins the score. Set
  // AFTER enabling: the slider is disabled while auto-detect is off.
  await setSlider(page, "hero_auto_count", 8);

  const autoItems = page.getByTestId("hero-auto-item");
  await expect(autoItems.first()).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  const names = await autoItems.allTextContents();
  log(`auto-detected heroes: ${names.join(" | ")}`);
  expect(names.length).toBeGreaterThan(0);
  expect(names.some((text) => !text.includes("unnamed building"))).toBe(true);
});

test("{hero} resolves live in the frame-text editor once a hero is auto-detected", async ({
  page,
}) => {
  await generateChicago(page);

  const buildingsToggle = page.getByTestId("group-buildings-toggle");
  if ((await buildingsToggle.getAttribute("aria-expanded")) !== "true") {
    await buildingsToggle.click();
  }
  await page.locator("#hero_auto_enabled").click();
  await expect(page.locator("#hero_auto_enabled")).toHaveAttribute("aria-checked", "true");

  const frameToggle = page.getByTestId("group-frame-toggle");
  if ((await frameToggle.getAttribute("aria-expanded")) !== "true") {
    await frameToggle.click();
  }
  await page.getByTestId("engraving-add").click();
  // The live "Cuts as:" preview (`EngravingsEditor.tsx`) is pure client-side
  // token expansion (`FrameTextGroup`'s own `context`), independent of
  // whether a fresh WASM bake has landed -- unlike the Resolved output panel,
  // which can be reading the ENGINE's own (separately-owned) resolution by
  // the time an assertion runs, this cannot race the debounced engine job.
  await page.locator("#engraving_0_text").fill("{hero}");
  const preview = page.getByTestId("engraving_0-preview");
  await expect(preview).not.toContainText("{hero}");
  await expect(preview).not.toContainText("nothing yet");
  const cutsAs = ((await preview.textContent()) ?? "").trim();
  log(`{hero} cuts as: ${cutsAs}`);
  expect(cutsAs).not.toBe("Cuts as:");
});

// ==========================================================================
// Responsive
// ==========================================================================

test("tablet width turns the sidebar into a bottom sheet", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await mockChicagoOverpass(page);
  await page.goto("/");

  await expect(page.getByTestId("editor")).toBeVisible();
  await expect(page.getByTestId("desktop-recommended")).toBeHidden();

  const toggle = page.getByTestId("param-sheet-toggle");
  await expect(toggle).toBeVisible();
  await expect(page.getByTestId("param-sheet")).toHaveAttribute("data-open", "false");

  // Closed, the sheet is a bar at the bottom, not a column.
  const closed = await page.getByTestId("param-sheet").boundingBox();
  expect(closed?.height ?? 0).toBeLessThan(80);

  await toggle.click();
  await expect(page.getByTestId("param-sheet")).toHaveAttribute("data-open", "true");
  // The sheet slides open, so poll rather than measuring mid-transition.
  await expect
    .poll(async () => (await page.getByTestId("param-sheet").boundingBox())?.height ?? 0)
    .toBeGreaterThan(300);
  const open = await page.getByTestId("param-sheet").boundingBox();
  await expect(page.locator("#plate_mm")).toBeVisible();
  log(`bottom sheet: ${closed?.height}px closed, ${open?.height}px open`);

  // The whole point of a bottom sheet on a tablet is that you can still SEE
  // what you are changing. The open sheet used to cover the entire 3D canvas
  // and the spec strip, so the user could see the model or change it, never
  // both.
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-stats")).toBeVisible({
    timeout: WARMUP_BUDGET_MS,
  });
  await page.waitForTimeout(600);
  const sheetBox = await page.getByTestId("param-sheet").boundingBox();
  const canvasBox = await page.getByTestId("preview-canvas").boundingBox();
  const stripBox = await page.getByTestId("spec-scale").boundingBox();
  const sheetTop = sheetBox?.y ?? 0;
  const canvasBottom = (canvasBox?.y ?? 0) + (canvasBox?.height ?? 0);
  log(
    `with the sheet open: canvas ${canvasBox?.y}–${canvasBottom}, sheet top ${sheetTop}`,
  );
  expect(canvasBox?.height ?? 0, "the preview was squeezed to nothing").toBeGreaterThan(
    120,
  );
  expect(canvasBottom, "the open sheet covers the 3D preview").toBeLessThanOrEqual(
    sheetTop + 1,
  );
  expect(stripBox?.y ?? 0, "the open sheet covers the spec strip").toBeLessThan(
    sheetTop,
  );
});

test("desktop width keeps the sidebar as a static column", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByTestId("param-sheet-toggle")).toBeHidden();
  const sheet = await page.getByTestId("param-sheet").boundingBox();
  expect(sheet?.height ?? 0).toBeGreaterThan(400);
  await expect(page.locator("#plate_mm")).toBeVisible();
  await expect(page.getByTestId("map")).toBeVisible();
  await expect(page.getByTestId("preview-empty")).toBeVisible();
});

test("phone width says so instead of rendering a broken editor", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 780 });
  await page.goto("/");

  const notice = page.getByTestId("desktop-recommended");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("wider screen");
  await expect(page.getByTestId("editor")).toBeHidden();
  // No half-rendered map or 3D canvas behind it.
  await expect(page.getByTestId("preview-canvas")).toHaveCount(0);
  // The attribution is a licence obligation and survives every layout.
  await expect(page.locator("footer")).toContainText("© OpenStreetMap contributors");
});

// ==========================================================================
// Empty state
// ==========================================================================

test("the viewport says what to do before anything is generated", async ({ page }) => {
  await page.goto("/");
  const empty = page.getByTestId("preview-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("Choose a preset city");
  await expect(empty).toContainText("Generate");
  // The keyboard hints are on the empty state, where a first-time user is.
  await expect(empty).toContainText("G generate");
  await expect(page.getByTestId("preview-canvas")).toHaveCount(0);

  // Generate is the primary action while there is no scene, and Bake explains
  // itself rather than sitting there dead.
  await expect(page.getByTestId("generate-button")).toBeEnabled();
  await expect(page.getByTestId("bake-button")).toBeDisabled();
});
