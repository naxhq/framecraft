import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { mockChicagoOverpass } from "./overpassMock";

/**
 * Accessibility, measured rather than asserted by hand.
 *
 * axe-core runs over the real editor in four states and in both themes, and
 * anything it rates `serious` or `critical` fails the run. Those two impacts
 * are the ones that stop someone using the product at all: an unlabelled
 * control, text under WCAG AA contrast, a broken ARIA reference.
 *
 * Nothing is skipped and no rule is disabled. The one thing that is *reported*
 * rather than asserted is axe's `incomplete` list, which on this page is mostly
 * "cannot determine the background behind a WebGL canvas" -- a genuine limit of
 * a static checker, not a defect to hide.
 *
 * Budgets scale with `E2E_BUDGET_FACTOR`, matching `smoke.spec.ts`/
 * `terrain.spec.ts`'s own convention: the 2-core software-WebGL CI runner
 * measured slower on every wait here, not just one, and the real tab walk
 * below additionally raises its own PER-TEST timeout (`test.setTimeout`) --
 * the default 300 s Playwright test budget is separate from any one
 * `expect(...).toBeVisible({timeout})` and was what actually tripped on CI
 * (5.1 min into a 120-press walk), not a single slow assertion.
 */
const BUDGET_FACTOR = Number(process.env.E2E_BUDGET_FACTOR ?? 1) || 1;
const WARMUP_BUDGET_MS = 60_000 * BUDGET_FACTOR;
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

interface Violation {
  id: string;
  impact?: string | null;
  nodes: Array<{ target: unknown[]; failureSummary?: string }>;
  help: string;
}

/** A failure has to name the element and the numbers, or it is unactionable. */
function describe(violation: Violation): string {
  const nodes = violation.nodes
    .slice(0, 4)
    .map(
      (node) =>
        `${JSON.stringify(node.target)} ${(node.failureSummary ?? "")
          .replace(/\s+/g, " ")
          .trim()}`,
    )
    .join(" | ");
  return `${violation.id}: ${violation.help} (${violation.nodes.length} nodes) ${nodes}`;
}

async function auditWithAxe(page: Page, label: string): Promise<void> {
  // Settle before sampling. axe reads COMPUTED colours, and this UI cross-fades
  // (`transition-colors`, 150 ms) whenever a chip becomes active, a group
  // opens or the theme flips. Auditing mid-fade measures a blend of two states
  // that is on screen for a tenth of a second and belongs to neither -- it
  // produced a 1.81:1 "violation" between two greys that are never both shown.
  // The settled UI is the one a user reads, so it is the one that is audited.
  await page.waitForTimeout(400);
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations as unknown as Violation[];
  const blocking = violations.filter(
    (violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact),
  );
  const summary = violations
    .map((v) => `${v.impact}:${v.id}(${v.nodes.length})`)
    .join(", ");
  // `incomplete` is reported, never asserted: on this page it is axe saying it
  // cannot resolve the background behind a translucent panel or a WebGL canvas,
  // which is a limit of a static checker rather than a defect. The target is
  // printed so the claim can be checked instead of taken on trust.
  const review = results.incomplete
    .map((item) => `${item.id}@${JSON.stringify(item.nodes[0]?.target ?? [])}`)
    .join(", ");
  console.log(
    `[a11y] ${label}: ${violations.length} violations` +
      `${summary ? ` [${summary}]` : ""}, ` +
      `${results.incomplete.length} needs-review` +
      `${review ? ` [${review}]` : ""}, ${results.passes.length} passes`,
  );
  expect(
    blocking.map(describe),
    `serious or critical accessibility violations in "${label}"`,
  ).toEqual([]);
}

/** Flip the theme through the real control, not by setting a class. */
async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  const isDark = await page.evaluate(() =>
    document.documentElement.classList.contains("dark"),
  );
  if ((theme === "dark") !== isDark) {
    await page.getByTestId("theme-toggle").click();
  }
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.classList.contains("dark")),
    )
    .toBe(theme === "dark");
  // The class flips instantly but the surfaces cross-fade (`transition-colors`,
  // 150 ms). axe samples the COMPUTED colours, so auditing mid-fade measures a
  // blend that exists for a tenth of a second and fails contrast against
  // nothing real. Let the transition finish before measuring.
  await page.waitForTimeout(600);
}

async function generateChicago(page: Page): Promise<void> {
  await mockChicagoOverpass(page);
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-stats")).toBeVisible({
    timeout: WARMUP_BUDGET_MS,
  });
}

test.describe.configure({ mode: "serial" });

for (const theme of ["light", "dark"] as const) {
  test(`axe: the ${theme} editor is clean in every state`, async ({ page }) => {
    // Five states, each a real axe scan over the same slower CI runner the
    // tab-walk test above measures its own overrun on.
    test.setTimeout(300_000 * BUDGET_FACTOR);
    await page.goto("/");
    await expect(page.getByTestId("editor")).toBeVisible();
    await setTheme(page, theme);

    // 1. The empty state: what a first-time visitor lands on.
    await expect(page.getByTestId("preview-empty")).toBeVisible();
    await auditWithAxe(page, `${theme} / empty`);

    // 2. A real scene, with every group open so nothing is audited unrendered.
    await generateChicago(page);
    for (const group of ["frame", "colour", "printer"]) {
      const toggle = page.getByTestId(`group-${group}-toggle`);
      if ((await toggle.getAttribute("aria-expanded")) === "false") {
        await toggle.click();
      }
    }
    await expect(page.getByTestId("part-colors")).toBeVisible();
    await auditWithAxe(page, `${theme} / Chicago generated, all groups open`);

    // 3. The adjustments drawer open.
    const chip = page.getByTestId("adjustments-chip");
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page.getByTestId("adjustments-drawer")).toBeVisible();
    await auditWithAxe(page, `${theme} / adjustments drawer open`);
    await chip.click();

    // 3b. The Issues drawer open, WITH a real fix button in it (phase 4): the
    // default Chicago scene has no error/warning-level finding of its own, so
    // one is forced -- a region on a filament slot the default 4-slot custom
    // profile does not have -- exactly like `print.spec.ts`'s own "a finding
    // with a fix" test.
    await page.locator("#colour_slot_buildings").selectOption("9");
    const issuesBadge = page.getByTestId("issues-badge");
    await expect(issuesBadge).toBeVisible({ timeout: WARMUP_BUDGET_MS });
    await issuesBadge.click();
    await expect(page.getByTestId("issues-drawer")).toBeVisible();
    await expect(page.getByTestId("issue-fix-slot-beyond-profile")).toBeVisible();
    await auditWithAxe(page, `${theme} / issues drawer open, with a fix button`);
    await issuesBadge.click();
    await page.locator("#colour_slot_buildings").selectOption("1");

    // 4. The shortcut sheet, which is the one modal in the product.
    await page.getByTestId("shortcuts-button").click();
    await expect(page.getByTestId("shortcut-sheet")).toBeVisible();
    await auditWithAxe(page, `${theme} / shortcut sheet`);
    await page.getByTestId("shortcut-sheet-close").click();
  });
}

test("every control in the panel is reachable and named", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("editor")).toBeVisible();
  for (const group of ["frame", "colour", "printer"]) {
    const toggle = page.getByTestId(`group-${group}-toggle`);
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  }
  await page.getByTestId("engraving-add").click();

  // Every interactive control has an accessible name. `getByRole` with no name
  // filter enumerates them; an empty name is what a screen reader reads as
  // "button".
  const unnamed = await page.evaluate(() => {
    const selector =
      'input, select, textarea, button, [role="switch"], [role="radio"], a[href]';
    const problems: string[] = [];
    for (const node of Array.from(document.querySelectorAll(selector))) {
      const element = node as HTMLElement;
      if (element.offsetParent === null && element.tagName !== "INPUT") continue;
      const labelled =
        element.getAttribute("aria-label") ??
        (element.getAttribute("aria-labelledby")
          ? "by-id"
          : element.id
            ? (document.querySelector(`label[for="${element.id}"]`)?.textContent ?? "")
            : "") ??
        "";
      const text = (element.textContent ?? "").trim();
      const title = element.getAttribute("title") ?? "";
      if (!labelled.trim() && !text && !title) {
        problems.push(`${element.tagName}#${element.id || "(no id)"}`);
      }
    }
    return problems;
  });
  expect(unnamed, `controls with no accessible name: ${unnamed.join(", ")}`).toEqual([]);

});

/**
 * A REAL tab walk.
 *
 * The assertion this replaces counted elements matching a CSS selector and
 * called the number "keyboard-reachable". It never pressed a key, so it could
 * not fail for anything a keyboard user would actually hit: a control outside
 * the tab order, a focus trap, a `tabindex="-1"` on something real, or a DOM
 * order that does not match the reading order. It reported a DOM census as a
 * reachability measurement — and a 45-press walk run by hand found two defects
 * it was structurally incapable of finding.
 */
test("every control is reachable by Tab, in order, with a visible focus ring", async ({
  page,
}) => {
  // 120 real key presses plus a DOM read after each one, on the real Chicago
  // scene: measured 5.1 min on a 2-core software-WebGL CI runner, against
  // Playwright's own 300 s default TEST timeout (separate from any single
  // `expect(...).toBeVisible({timeout})` above, which is why raising
  // WARMUP_BUDGET_MS alone did not cover this one).
  test.setTimeout(300_000 * BUDGET_FACTOR);

  await page.goto("/");
  await expect(page.getByTestId("editor")).toBeVisible();
  await generateChicago(page);
  // Let the debounced WASM engine job settle before spending the walk's own
  // budget: a Tab press that lands mid-bake pays for whatever store-wide
  // re-render the engine result's arrival triggers on TOP of its own work,
  // which is exactly the kind of unrelated cost this walk should not have to
  // absorb 120 times over.
  await expect(page.getByTestId("engine-updating")).toHaveCount(0, { timeout: WARMUP_BUDGET_MS });
  for (const group of ["frame", "colour", "printer"]) {
    const toggle = page.getByTestId(`group-${group}-toggle`);
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  }

  interface Stop {
    tag: string;
    id: string;
    testId: string;
    /** The id of the enclosing radiogroup, if the stop is one of its options. */
    group: string;
    name: string;
    ring: string;
    inPortal: boolean;
  }

  const describeFocus = () =>
    page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active) return null;
      const style = getComputedStyle(active);
      return {
        tag: active.tagName,
        id: active.id ?? "",
        testId: active.getAttribute("data-testid") ?? "",
        // A radiogroup's id is on the container; focus lands on the selected
        // option, which has no id of its own.
        group: (active.closest('[role="radiogroup"]') as HTMLElement | null)?.id ?? "",
        name:
          active.getAttribute("aria-label") ??
          (active.textContent ?? "").trim().slice(0, 40),
        ring: `${style.outlineStyle}/${style.outlineWidth}`,
        // The Next dev-server overlay is not part of what we ship.
        inPortal: active.closest("nextjs-portal") !== null,
      };
    });

  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  const stops: Stop[] = [];
  const key = (stop: Stop): string =>
    `${stop.testId}|${stop.id}|${stop.group}|${stop.name}`;
  /**
   * A fixed number of presses, comfortably more than one cycle of the ~45 stops
   * this page has, rather than a "stop when we get back to the start" loop:
   * where the walk begins depends on what had focus, and an early false match
   * silently truncates the coverage this test exists to measure.
   */
  const PRESSES = 120;
  for (let i = 0; i < PRESSES; i += 1) {
    await page.keyboard.press("Tab");
    const stop = (await describeFocus()) as Stop | null;
    if (!stop) break;
    stops.push(stop);
  }
  // A repeat proves the walk went all the way round at least once, so "never
  // reached" below really means unreachable and not merely "we stopped early".
  expect(
    new Set(stops.map(key)).size,
    "the tab order never repeated in 120 presses; is there a focus trap?",
  ).toBeLessThan(stops.length);

  // `<body>` shows up once per cycle, when focus passes out of the document
  // into the browser's own chrome. It is not a control and has no ring.
  const shipped = stops.filter(
    (stop) => !stop.inPortal && stop.tag !== "BODY" && stop.tag !== "HTML",
  );
  const ids = new Set(shipped.map((stop) => stop.id).filter(Boolean));
  const testIds = new Set(shipped.map((stop) => stop.testId).filter(Boolean));
  const groups = new Set(shipped.map((stop) => stop.group).filter(Boolean));
  console.log(
    `[a11y] tab walk: ${stops.length} presses, ` +
      `${new Set(shipped.map(key)).size} distinct shipped controls`,
  );

  // Every group's controls, one from each, plus the things a user must reach.
  const REQUIRED_IDS = [
    "city_label", // Location
    "radius_m",
    "rotation_deg",
    "plate_mm", // Scale and size
    "nozzle_mm",
    "small_scale", // Buildings
    "large_scale",
    "road_scale", // Surface
    "water",
    "trees",
    "frame", // Frame and text
    "hanger",
    "hero_mode", // Colour
    "printer_profile", // Printer
  ];
  const missingIds = REQUIRED_IDS.filter((id) => !ids.has(id));
  expect(missingIds, `never reached by Tab: ${missingIds.join(", ")}`).toEqual([]);

  // The two segmented controls are reached through their selected option, so
  // they are found by the enclosing radiogroup's id rather than the stop's own.
  const missingGroups = ["road_mode", "color_mode"].filter((id) => !groups.has(id));
  expect(
    missingGroups,
    `radiogroup never reached by Tab: ${missingGroups.join(", ")}`,
  ).toEqual([]);

  const REQUIRED_TESTIDS = [
    "shortcuts-button",
    "theme-toggle",
    "reset-button",
    "bake-button",
    // The headline feature of the v2 redesign: a hero can be picked without a
    // mouse only if the viewport is in the tab order.
    "preview-canvas",
    // V2-P6. Copy link is an action like Generate and Bake, and the advisor's
    // remedy is a real button that moves the radius -- both were shipped
    // outside this list (audit v2-06 finding 5). The advisor button exists in
    // this state because Chicago at 900 m on a 180 mm plate is band `fair`,
    // which is asserted rather than assumed just below.
    "copy-link-button",
    "advisor-use-radius",
  ];
  const missingTestIds = REQUIRED_TESTIDS.filter((id) => !testIds.has(id));
  expect(missingTestIds, `never reached by Tab: ${missingTestIds.join(", ")}`).toEqual(
    [],
  );

  // The precondition for the advisor stop, stated: if the band were `good` the
  // recommendation row would not be rendered at all, and "never reached by Tab"
  // would be the wrong diagnosis.
  await expect(page.getByTestId("detail-health")).toHaveAttribute("data-band", "fair");
  // `advisor-use-plate` is deliberately NOT required: no plate in the
  // contract's range fixes this scene, so the shared math offers no plate
  // remedy and the button does not exist. Absent from the DOM, hence absent
  // from the walk -- and the two agree.
  await expect(page.getByTestId("advisor-use-plate")).toHaveCount(0);
  expect(testIds.has("advisor-use-plate")).toBe(false);

  // Generate is absent from the walk, and that is correct: the scene is
  // current, so it carries a real `disabled` attribute and a disabled control
  // must not be a dead tab stop. Asserted rather than assumed, because "not in
  // the tab order" and "disabled" have to agree.
  await expect(page.getByTestId("generate-button")).toBeDisabled();
  expect(testIds.has("generate-button")).toBe(false);

  // The six preset chips are reachable too.
  const presets = shipped.filter((stop) => /—/.test(stop.name)).length;
  expect(presets, "the preset chips are not in the tab order").toBeGreaterThanOrEqual(6);

  // A radiogroup is ONE stop, not one per option: the ARIA pattern promises
  // arrow keys, and it now delivers them (roving tabindex).
  const roadModeStops = shipped.filter((stop) => stop.name === "emboss").length;
  expect(roadModeStops, "the segmented control is more than one tab stop").toBe(0);

  // Every shipped stop shows a focus ring, including MapLibre's own buttons.
  const ringless = shipped.filter((stop) => stop.ring.startsWith("none"));
  expect(
    ringless.map((stop) => `${stop.tag} "${stop.name}" ${stop.ring}`),
    "tab stops with no visible focus indicator",
  ).toEqual([]);
});
