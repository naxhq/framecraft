import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { mockTinyLoopOverpass, watchOverpass } from "./overpassMock";
import {
  NOMINATIM_REVERSE_CITY,
  PHOTON_EMPTY_BODY,
  mockNominatimReverse,
  mockPhoton,
  photonParisBody,
  watchNominatim,
  watchPhoton,
} from "./photonMock";

/**
 * The location type-ahead ([V3-P9]).
 *
 * What this proves, and why each one needs a real browser rather than the
 * vitest suites that already cover `lib/photon.ts` and `lib/coordinates.ts`:
 *
 *  1. The request policy is only true END TO END. A debounce that a unit test
 *     satisfies with fake timers still sends a request per keystroke if the
 *     component re-mounts the scheduler, so the count is measured off the wire
 *     here, and the abort is measured as the browser's own failed request.
 *  2. "Picking does not build" is a claim about two modules at once (this
 *     control and the store), so it is measured as an Overpass call count.
 *  3. A coordinate query never leaving the machine is the whole point of
 *     parsing locally, and only the network log can show that.
 *
 * Neither geocoder is ever reached: both hosts route to the committed fixtures
 * in `e2e/fixtures/`. Budgets scale with `E2E_BUDGET_FACTOR`, matching every
 * other spec in this directory.
 */

const BUDGET_FACTOR = Number(process.env.E2E_BUDGET_FACTOR ?? 1) || 1;
const WARMUP_BUDGET_MS = 60_000 * BUDGET_FACTOR;
/** Comfortably past the 250 ms debounce plus a slow runner's own scheduling. */
const SETTLE_MS = 1_500 * BUDGET_FACTOR;
const POLL_MS = 10_000 * BUDGET_FACTOR;

/** Every uncaught page exception, so a silent React crash fails loudly. */
function watchPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

function searchBox(page: Page) {
  return page.getByTestId("location-search");
}

/**
 * Is the pin marker inside the map's own viewport?
 *
 * The camera-follow assertion needs no instrumentation: MapLibre positions a
 * marker by transform and leaves it in the DOM wherever it lands, so a pin the
 * camera did not follow sits far outside the container's box, and Playwright's
 * own geometry says so.
 */
async function pinIsOnScreen(page: Page): Promise<boolean> {
  const pin = await page.locator('[data-testid="map-pin"]').first().boundingBox();
  const map = await page.getByTestId("map").boundingBox();
  if (pin === null || map === null) return false;
  const x = pin.x + pin.width / 2;
  const y = pin.y + pin.height / 2;
  return x >= map.x && x <= map.x + map.width && y >= map.y && y <= map.y + map.height;
}

test("two characters send nothing, and the third sends exactly one request", async ({ page }) => {
  const errors = watchPageErrors(page);
  const photon = watchPhoton(page);
  await mockPhoton(page);
  await mockNominatimReverse(page);
  await page.goto("/");

  const search = searchBox(page);
  await search.click();
  await search.pressSequentially("ch");
  await page.waitForTimeout(SETTLE_MS);

  // Under the minimum there is nothing to ask about, so nothing is asked.
  expect(photon.requests).toEqual([]);
  await expect(page.getByTestId("search-status")).toContainText("Keep typing");

  await search.pressSequentially("i");
  await expect.poll(() => photon.requests.length, { timeout: POLL_MS }).toBe(1);
  expect(photon.requests[0]).toContain("q=chi&");
  expect(photon.requests[0]).toContain("limit=8");
  // The pin biases the query so nearby answers rank first.
  expect(photon.requests[0]).toContain("lat=41.9");

  // The fixture's three features become three rows, each with its own kind.
  await expect(page.getByTestId("search-result")).toHaveCount(3);
  const rows = page.getByTestId("search-result");
  await expect(rows.nth(0)).toContainText("Chicago");
  await expect(rows.nth(0)).toContainText("City");
  await expect(rows.nth(1)).toContainText("South Michigan Avenue");
  await expect(rows.nth(1)).toContainText("Road");
  await expect(rows.nth(2)).toContainText("Willis Tower");
  await expect(rows.nth(2)).toContainText("Building");

  // A second line of context, not just a name.
  await expect(rows.nth(0)).toContainText("Cook County, Illinois, United States");
  expect(errors).toEqual([]);
});

test("a fourth keystroke aborts the request the third one started", async ({ page }) => {
  const errors = watchPageErrors(page);
  const photon = watchPhoton(page);
  // Held open long enough that the next keystroke lands while it is still in
  // flight: an answered request has nothing left to abort.
  await mockPhoton(page, { delayMs: 4000 });
  await mockNominatimReverse(page);
  await page.goto("/");

  const search = searchBox(page);
  await search.click();
  await search.pressSequentially("chi");
  await expect.poll(() => photon.requests.length, { timeout: POLL_MS }).toBe(1);
  expect(photon.requests[0]).toContain("q=chi&");

  await search.pressSequentially("c");
  await expect.poll(() => photon.failed.length, { timeout: POLL_MS }).toBeGreaterThan(0);
  expect(photon.failed[0].url).toContain("q=chi&");
  expect(photon.failed[0].reason).toContain("ABORTED");

  // And the newer query does go out, so the abort cancelled the request, not
  // the search.
  await expect.poll(() => photon.requests.length, { timeout: POLL_MS }).toBe(2);
  expect(photon.requests[1]).toContain("q=chic&");
  expect(errors).toEqual([]);
});

test("arrow down and Enter move the pin, size the radius and light Preview without an Overpass call", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  const overpass = watchOverpass(page);
  const photon = watchPhoton(page);
  await mockTinyLoopOverpass(page);
  await mockPhoton(page);
  await mockNominatimReverse(page);
  await page.goto("/");

  // A built scene first, so "Preview lights up again" is a real transition
  // rather than the button's own cold-start state.
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-stats")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await expect(page.getByTestId("preview-button")).toBeDisabled();
  const buildsBefore = overpass.filter((call) => call.method === "POST").length;
  expect(buildsBefore).toBeGreaterThan(0);

  const search = searchBox(page);
  await search.click();
  await search.pressSequentially("chi");
  await expect(page.getByTestId("search-result")).toHaveCount(3);

  await search.press("ArrowDown");
  await expect(page.getByTestId("search-result").nth(0)).toHaveAttribute("aria-selected", "true");
  await search.press("Enter");

  // A "city" result is 1500 m ([V3-P6]'s table), up from the 900 m default.
  await expect(page.getByTestId("radius_m-value")).toHaveText("1500 m");
  await expect(page.locator("#city_label")).toHaveValue("Chicago");
  await expect(page.getByTestId("search-results")).toBeHidden();

  // Preview is offered again, and picking has not spent an Overpass query on
  // its own: building stays the user's move.
  await expect(page.getByTestId("preview-button")).toBeEnabled();
  await expect(page.getByTestId("preview-button")).toHaveText("Preview again");
  await page.waitForTimeout(SETTLE_MS);
  expect(overpass.filter((call) => call.method === "POST").length).toBe(buildsBefore);
  expect(photon.requests).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("the map camera follows a pick to another continent", async ({ page }) => {
  // The blocker from the audit. Until [V3-P9-fix] the only code that moved the
  // viewport was gated on `preset_id`, which `setPin` nulls, so a search pick
  // left the map exactly where it was with the pin, the radius circle and the
  // crop square all off screen. Paris is 6600 km from the default Chicago pin,
  // so at zoom 13 an unmoved camera cannot possibly still show the marker.
  const errors = watchPageErrors(page);
  await mockPhoton(page, { body: photonParisBody() });
  await mockNominatimReverse(page);
  await page.goto("/");
  await expect(page.locator('[data-testid="map-pin"]').first()).toBeVisible();
  expect(await pinIsOnScreen(page)).toBe(true);

  const search = searchBox(page);
  await search.click();
  await search.pressSequentially("par");
  await expect(page.getByTestId("search-result")).toHaveCount(1, { timeout: POLL_MS });
  await page.getByTestId("search-result").first().click();
  await expect(page.locator("#city_label")).toHaveValue("Paris");

  // fitBounds animates for 900 ms; poll rather than guess when it settles.
  await expect.poll(() => pinIsOnScreen(page), { timeout: POLL_MS }).toBe(true);
  expect(errors).toEqual([]);
});

test("clicking the map moves the pin without the camera flying back at the user", async ({
  page,
}) => {
  // The other half of the camera rule: a pin the MAP itself placed is where
  // the user just clicked, so answering it with a 900 ms fly-to would fight
  // them. Proven by the map's own centre staying put across a click.
  const errors = watchPageErrors(page);
  await mockPhoton(page);
  await mockNominatimReverse(page);
  await page.goto("/");
  const map = page.getByTestId("map");
  await expect(map).toBeVisible();
  await page.waitForTimeout(SETTLE_MS);

  const before = await page.locator('[data-testid="map-pin"]').first().boundingBox();
  const box = await map.boundingBox();
  expect(before).not.toBeNull();
  expect(box).not.toBeNull();
  if (box === null || before === null) return;

  // A point well away from the pin, the radius handle and the map controls.
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.72);
  await page.waitForTimeout(SETTLE_MS);

  const after = await page.locator('[data-testid="map-pin"]').first().boundingBox();
  expect(after).not.toBeNull();
  if (after === null) return;
  // The pin moved to the click; had the camera recentred on it, it would have
  // ended up back near the middle of the map instead.
  expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeGreaterThan(20);
  expect(Math.abs(after.y - (box.y + box.height / 2))).toBeGreaterThan(40);
  expect(errors).toEqual([]);
});

test("the name a pick binds is not overwritten by the reverse lookup it triggers", async ({
  page,
}) => {
  // Audit finding 7. The Photon fixture and the Nominatim fixture deliberately
  // name DIFFERENT places, so whichever wrote `#city_label` is visible: before
  // the fix this read "Chicago" and then flipped to "Cook County" about 600 ms
  // later, with no user action.
  const errors = watchPageErrors(page);
  const nominatim = watchNominatim(page);
  await mockPhoton(page);
  await mockNominatimReverse(page);
  await page.goto("/");
  await page.waitForTimeout(SETTLE_MS);
  const reverseBefore = nominatim.length;

  const search = searchBox(page);
  await search.click();
  await search.pressSequentially("chi");
  await expect(page.getByTestId("search-result")).toHaveCount(3, { timeout: POLL_MS });
  await page.getByTestId("search-result").nth(2).click();
  await expect(page.locator("#city_label")).toHaveValue("Willis Tower");

  // Well past the 600 ms reverse debounce and its 1 rps queue slot.
  await page.waitForTimeout(3_000 * BUDGET_FACTOR);
  await expect(page.locator("#city_label")).toHaveValue("Willis Tower");
  expect(page.locator("#city_label")).not.toHaveText(NOMINATIM_REVERSE_CITY);
  // The suppressed lookup is not merely ignored, it is never sent.
  expect(nominatim.length).toBe(reverseBefore);

  // And the suppression is one shot, not a permanent off switch: a COORDINATE
  // pick names nothing, so its pin move must still be reverse-geocoded. That
  // difference between the two pick kinds is the whole design, so it is
  // asserted rather than described.
  await search.fill("48.8566, 2.3522");
  await expect(page.getByTestId("search-coordinate").first()).toBeVisible();
  await page.getByTestId("search-result").first().click();
  await expect.poll(() => nominatim.length, { timeout: POLL_MS }).toBeGreaterThan(reverseBefore);
  await expect(page.locator("#city_label")).toHaveValue(NOMINATIM_REVERSE_CITY);
  expect(errors).toEqual([]);
});

test("Enter with nothing highlighted takes the first row, which is the coordinate fallback", async ({
  page,
}) => {
  // The unavailable message tells people to enter coordinates instead. Audit
  // finding 5: doing exactly that and pressing Enter used to do nothing at
  // all, because Enter was gated on a highlighted row.
  const errors = watchPageErrors(page);
  await mockPhoton(page, { status: 429, headers: { "Retry-After": "60" }, body: "{}" });
  await mockNominatimReverse(page);
  await page.goto("/");

  const search = searchBox(page);
  await search.click();
  await search.pressSequentially("chicago");
  await expect(page.getByTestId("search-unavailable")).toBeVisible({ timeout: POLL_MS });

  await search.fill("48.8566, 2.3522");
  await expect(page.getByTestId("search-coordinate").first()).toBeVisible();
  // No ArrowDown: straight to Enter, exactly as the message's advice implies.
  await search.press("Enter");
  await expect(search).toHaveValue("48.85660, 2.35220");
  await expect.poll(() => pinIsOnScreen(page), { timeout: POLL_MS }).toBe(true);
  expect(errors).toEqual([]);
});

test("a composing IME sends nothing and its commit key does not pick a row", async ({ page }) => {
  // Audit finding 6. React's `onChange` IS the DOM `input` event, which fires
  // on every composition update, so uncommitted romaji would otherwise be sent
  // to a public endpoint; and Enter is how an IME commits, so it must not
  // select a search result mid-word.
  const errors = watchPageErrors(page);
  const photon = watchPhoton(page);
  await mockPhoton(page);
  await mockNominatimReverse(page);
  await page.goto("/");

  const search = searchBox(page);
  await search.click();

  // Compose "chicago" without committing it. The value is written through the
  // native setter so React's own change tracker registers it, which is what
  // makes this the real thing rather than a no-op the guard never sees.
  await search.evaluate((element: HTMLInputElement) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(element, "chicago");
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(search).toHaveValue("chicago");
  await page.waitForTimeout(SETTLE_MS);
  // Seven committed characters would have been one request; seven uncommitted
  // ones are none.
  expect(photon.requests).toEqual([]);
  await expect(page.getByTestId("search-result").filter({ hasText: "Chicago" })).toHaveCount(0);

  // Committing the candidate is what finally searches.
  await search.evaluate((element: HTMLInputElement) => {
    element.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "chicago" }),
    );
  });
  await expect(page.getByTestId("search-result")).toHaveCount(3, { timeout: POLL_MS });
  expect(photon.requests).toHaveLength(1);

  // Now the other half: Enter is how an IME commits, so an Enter carrying
  // `isComposing` must not select the highlighted row.
  await search.press("ArrowDown");
  await expect(page.getByTestId("search-result").nth(0)).toHaveAttribute("aria-selected", "true");
  await search.evaluate((element: HTMLInputElement) => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }),
    );
  });
  await page.waitForTimeout(500 * BUDGET_FACTOR);
  await expect(page.locator("#city_label")).toHaveValue("");
  await expect(page.getByTestId("search-results")).toBeVisible();

  // A plain Enter still picks, so the guard blocks the commit key and nothing else.
  await search.press("Enter");
  await expect(page.locator("#city_label")).toHaveValue("Chicago");
  expect(errors).toEqual([]);
});

test("a coordinate pair is answered locally, with no request to either geocoder", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  const overpass = watchOverpass(page);
  const photon = watchPhoton(page);
  const nominatim = watchNominatim(page);
  await mockTinyLoopOverpass(page);
  await mockPhoton(page);
  await mockNominatimReverse(page);
  await page.goto("/");

  // The shell reverse-geocodes the default pin on load; only what happens
  // AFTER that is this test's business.
  await page.waitForTimeout(SETTLE_MS);
  const reverseBefore = nominatim.length;

  // A radius the user chose by hand, so the pick below has something to lose.
  // Audit finding 13: `[V3-P6]`'s table classifies a PLACE, and a raw
  // coordinate is not a place, so there is nothing to classify and no licence
  // to overwrite this.
  await page.locator("#radius_m").fill("1500");
  await expect(page.getByTestId("radius_m-value")).toHaveText("1500 m");

  const search = searchBox(page);
  await search.click();
  await search.fill("41°52'57.7\"N 87°37'23.9\"W");
  const coordinate = page.getByTestId("search-coordinate").first();
  await expect(coordinate).toBeVisible();
  await expect(coordinate).toContainText("41.88269, -87.62331");
  await expect(page.getByTestId("search-result").first()).toContainText("DMS");

  await page.waitForTimeout(SETTLE_MS);
  expect(photon.requests).toEqual([]);
  expect(nominatim.length).toBe(reverseBefore);

  await page.getByTestId("search-result").first().click();
  await expect(search).toHaveValue("41.88269, -87.62331");
  await expect(page.getByTestId("radius_m-value")).toHaveText("1500 m");
  expect(overpass.filter((call) => call.method === "POST")).toEqual([]);
  expect(photon.requests).toEqual([]);
  expect(errors).toEqual([]);
});

test("ArrowUp from nothing selected lands on the last row, and Escape clears the pointer", async ({
  page,
}) => {
  // Audit finding 8 (the wrap was off by one from -1) and finding 4
  // (`aria-activedescendant` kept naming an option after the listbox unmounted,
  // which is `aria-valid-attr-value` at serious impact).
  const errors = watchPageErrors(page);
  await mockPhoton(page);
  await mockNominatimReverse(page);
  await page.goto("/");

  const search = searchBox(page);
  await search.click();
  await search.pressSequentially("chi");
  await expect(page.getByTestId("search-result")).toHaveCount(3, { timeout: POLL_MS });

  await search.press("ArrowUp");
  await expect(page.getByTestId("search-result").nth(2)).toHaveAttribute("aria-selected", "true");
  await expect(search).toHaveAttribute("aria-activedescendant", /place/);
  await expect(search).toHaveAttribute("aria-expanded", "true");

  // Closing must take the pointer with it: an id naming an unmounted element
  // is exactly what `aria-controls` is guarded against here.
  await search.press("Escape");
  await expect(page.getByTestId("search-results")).toHaveCount(0);
  expect(await search.getAttribute("aria-activedescendant")).toBeNull();
  expect(await search.getAttribute("aria-controls")).toBeNull();
  await expect(search).toHaveAttribute("aria-expanded", "false");
  expect(errors).toEqual([]);
});

test("the live region announces the result count and the unavailable message", async ({ page }) => {
  // Audit finding 3: the success case announced nothing at all, so a screen
  // reader user typed, heard silence, and had to arrow into a list they were
  // never told existed. The region is mounted for the life of the control and
  // only its text changes.
  const errors = watchPageErrors(page);
  await mockPhoton(page);
  await mockNominatimReverse(page);
  await page.goto("/");

  const live = page.getByTestId("search-live");
  await expect(live).toHaveAttribute("aria-live", "polite");

  const search = searchBox(page);
  await search.click();
  await search.pressSequentially("chi");
  await expect(live).toContainText("3 results", { timeout: POLL_MS });

  await search.fill("41.8827, -87.6233");
  await expect(live).toContainText("coordinate readings");

  await page.unrouteAll();
  await mockPhoton(page, { status: 503, body: "{}" });
  await mockNominatimReverse(page);
  await search.fill("bergen");
  await expect(live).toContainText("Search is unavailable right now", { timeout: POLL_MS });
  expect(errors).toEqual([]);
});

test("a rate-limited search says so inside the box and points at coordinates", async ({ page }) => {
  const errors = watchPageErrors(page);
  await mockPhoton(page, { status: 429, headers: { "Retry-After": "60" }, body: "{}" });
  await mockNominatimReverse(page);
  await page.goto("/");

  const search = searchBox(page);
  await search.click();
  await search.pressSequentially("chicago");

  const message = page.getByTestId("search-unavailable");
  await expect(message).toBeVisible({ timeout: POLL_MS });
  await expect(message).toContainText("Search is unavailable right now, enter coordinates instead");
  await expect(message).toContainText("41.8827, -87.6233");

  // The box still works: coordinates need no server at all.
  await search.fill("41.8827, -87.6233");
  await expect(page.getByTestId("search-coordinate").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("an outage reads the same way, and an empty answer does not", async ({ page }) => {
  const errors = watchPageErrors(page);
  await mockPhoton(page, { status: 200, body: PHOTON_EMPTY_BODY });
  await mockNominatimReverse(page);
  await page.goto("/");

  const search = searchBox(page);
  await search.click();
  await search.pressSequentially("nowhereatall");
  // "Nothing matched" is a different fact from "the search is down", and the
  // box has to be able to say which.
  await expect(page.getByTestId("search-empty")).toBeVisible({ timeout: POLL_MS });
  await expect(page.getByTestId("search-unavailable")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a picked place comes back as a recent, is removable, and the list can be cleared", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await mockPhoton(page);
  await mockNominatimReverse(page);
  await page.goto("/");

  const search = searchBox(page);
  await search.click();
  await search.pressSequentially("chi");
  await expect(page.getByTestId("search-result")).toHaveCount(3);
  await page.getByTestId("search-result").nth(2).click();
  await expect(search).toHaveValue("Willis Tower");
  // A "building" result is 400 m, not the city's 1500 m.
  await expect(page.getByTestId("radius_m-value")).toHaveText("400 m");

  await page.getByTestId("search-clear").click();
  await expect(page.getByTestId("search-recent")).toHaveCount(1);
  await expect(page.getByTestId("search-recent")).toContainText("Willis Tower");
  // "Use my location" is offered but never called until it is chosen.
  await expect(page.getByTestId("search-geolocate")).toBeVisible();

  await page.getByTestId("search-recent-remove").click();
  await expect(page.getByTestId("search-recent")).toHaveCount(0);

  // Pick again, then clear the whole list.
  await search.pressSequentially("chi");
  await expect(page.getByTestId("search-result")).toHaveCount(3);
  await page.getByTestId("search-result").nth(0).click();
  await page.getByTestId("search-clear").click();
  await expect(page.getByTestId("search-recent")).toHaveCount(1);
  await page.getByTestId("search-clear-recents").click();
  await expect(page.getByTestId("search-recent")).toHaveCount(0);
  expect(errors).toEqual([]);
});

/**
 * `e2e/a11y.spec.ts` sweeps the whole editor in two states; this sweeps the one
 * control this phase built, in every state it can be in, in both themes. The
 * combobox pattern's failure mode is exactly the kind axe catches and a human
 * reading the JSX does not: an `aria-controls` naming a listbox that is not in
 * the DOM, an interactive control nested inside a `role="option"`, or a badge
 * whose text drops under 4.5:1 on the raised row background.
 */
async function auditSearch(page: Page, label: string): Promise<void> {
  // Settle: the rows cross-fade on hover and axe reads computed colours.
  await page.waitForTimeout(400);
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  const summary = blocking
    .map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.length} nodes)`)
    .join(" | ");
  console.log(
    `[search a11y] ${label}: ${results.violations.length} violations, ${results.passes.length} passes`,
  );
  expect(blocking, `axe found blocking violations in ${label}: ${summary}`).toEqual([]);
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  if ((theme === "dark") !== isDark) await page.getByTestId("theme-toggle").click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(theme === "dark");
  await page.waitForTimeout(600);
}

for (const theme of ["light", "dark"] as const) {
  test(`axe: the ${theme} search box is clean in every state it can be in`, async ({ page }) => {
    test.setTimeout(180_000 * BUDGET_FACTOR);
    await mockPhoton(page);
    await mockNominatimReverse(page);
    await page.goto("/");
    await expect(page.getByTestId("editor")).toBeVisible();
    await setTheme(page, theme);

    const search = searchBox(page);

    // 1. Closed: the combobox must not point at a listbox that is not there.
    await auditSearch(page, `${theme} / closed`);

    // 2. Focused and empty: "Use my location" plus (initially empty) recents.
    await search.click();
    await expect(page.getByTestId("search-geolocate")).toBeVisible();
    await auditSearch(page, `${theme} / empty and focused`);

    // 3. Below the minimum: the inline hint, no listbox.
    await search.pressSequentially("ch");
    await expect(page.getByTestId("search-status")).toBeVisible();
    await auditSearch(page, `${theme} / hint`);

    // 4. Results, with a row highlighted through the keyboard.
    await search.pressSequentially("i");
    await expect(page.getByTestId("search-result")).toHaveCount(3, { timeout: POLL_MS });
    await search.press("ArrowDown");
    await auditSearch(page, `${theme} / results with an active row`);

    // 4b. Blurred while a row was highlighted. The state the audit's finding 4
    // lived in: the listbox unmounts and the input must stop naming an option
    // id that no longer exists (`aria-valid-attr-value`, serious).
    await search.press("Tab");
    await expect(page.getByTestId("search-results")).toHaveCount(0);
    expect(await search.getAttribute("aria-activedescendant")).toBeNull();
    await auditSearch(page, `${theme} / blurred with a row highlighted`);

    // 5. The coordinate row.
    await search.click();
    await search.fill("41.8827, -87.6233");
    await expect(page.getByTestId("search-coordinate").first()).toBeVisible();
    await auditSearch(page, `${theme} / coordinates`);

    // 6. Recents, with a removable row.
    await search.fill("");
    await search.pressSequentially("chi");
    await expect(page.getByTestId("search-result")).toHaveCount(3, { timeout: POLL_MS });
    await page.getByTestId("search-result").nth(0).click();
    await page.getByTestId("search-clear").click();
    await expect(page.getByTestId("search-recent")).toHaveCount(1);
    await auditSearch(page, `${theme} / recents`);
  });
}

test("the popover credits Photon and Nominatim, and so does the app footer", async ({ page }) => {
  await mockPhoton(page);
  await mockNominatimReverse(page);
  await page.goto("/");

  await searchBox(page).click();
  const credit = page.getByTestId("search-attribution");
  await expect(credit).toBeVisible();
  await expect(credit).toContainText("Search by Photon (komoot)");
  await expect(credit).toContainText("geocoding by Nominatim");
  await expect(credit).toContainText("© OpenStreetMap contributors");

  await expect(page.locator("footer")).toContainText("Search by Photon (komoot)");
  await expect(page.locator("footer")).toContainText("geocoding by Nominatim");
  await expect(page.locator("footer")).toContainText("© OpenStreetMap contributors");
});
