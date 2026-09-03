import { expect, test, type Page } from "@playwright/test";

import { mockTinyLoopOverpass } from "./overpassMock";

/**
 * PRINTER group, Issues drawer and tiling (FrameCraft v3 phase 4,
 * `docs/handoff/v3-04-ui.md`).
 *
 * Every Overpass call is routed to the tiny (30-building) synthetic fixture
 * (`mockTinyLoopOverpass`), the same one `terrain.spec.ts` uses: it clears
 * 01/A2's 20-building minimum and builds cleanly, which matters here more than
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
  // "the engine keeps building" signal).
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

  /*
   * Record every state the button passes through, rather than sampling it.
   *
   * The v3 form asserted the transient directly ("disabled, reading Fixed")
   * and became flaky: `PIPELINE_DEBOUNCE_MS` is 80 ms (`[V3.1-P1-3]`, down from
   * 400), so the incremental run the click schedules can retire the whole row
   * before a poll from Node gets to look. The v3.1 form replaced it with the
   * `expect.poll(...).not.toBe("still offered")` below, which is a true
   * invariant but passes with the DEFECT present as well: `.not.toBe` is
   * satisfied the moment the row retires, and the broken behaviour (clear every
   * mark whenever a fresh findings array arrives) also ends with the row
   * retired. Reverting `IssuesBadge.tsx` to `setFixedIds(new Set())` left that
   * assertion green, so the one case the fix exists for -- the mark holding
   * while its row is still on screen -- was asserted nowhere outside the pure
   * function ([V3.1-T6] 3).
   *
   * A recorder inside the page has no race to lose. It samples on every DOM
   * mutation AND every animation frame, keeping only the transitions, so the
   * whole sequence is readable afterwards however fast it ran. The defect puts
   * an `enabled:` entry after `disabled:Fixed` while the row is still present,
   * which is exactly what the assertions after the click forbid.
   */
  await page.evaluate((testId) => {
    const log: string[] = [];
    (window as unknown as { __fixLog: string[] }).__fixLog = log;
    const sample = (): void => {
      const el = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
      const state =
        el === null
          ? "absent"
          : `${el.disabled ? "disabled" : "enabled"}:${(el.textContent ?? "").trim()}`;
      if (log[log.length - 1] !== state) log.push(state);
    };
    sample();
    new MutationObserver(sample).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["disabled"],
    });
    const tick = (): void => {
      sample();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, "issue-fix-slot-beyond-profile");

  await fixButton.click();
  // Immediate and optimistic: the row answers from the store's own report of
  // what changed, not from a finished build. The invariant below holds whatever
  // the timing is: the button is NEVER left offering the same fix a second
  // time. The recorder above is what pins the stronger claim.
  //
  // Both facts are read in ONE synchronous DOM evaluation, deliberately.
  // Asking the locator twice (`count()`, then `isDisabled()`) is a race
  // against the very rebuild this assertion is about: the row can be retired
  // between the two calls, and `isDisabled()` takes no timeout of its own
  // (Playwright's `actionTimeout` defaults to 0, and this config sets none),
  // so it then waits for a detached element forever and the poll dies of its
  // own timeout without ever having produced a value. Read as one snapshot,
  // the three outcomes are exhaustive and none of them can hang.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const button = document.querySelector<HTMLButtonElement>(
            '[data-testid="issue-fix-slot-beyond-profile"]',
          );
          if (button === null) return "retired with its row";
          return button.disabled ? "marked fixed" : "still offered";
        }),
      { timeout: WARMUP_BUDGET_MS },
    )
    .not.toBe("still offered");

  // The region's slot really moved (back onto the profile's own slot count),
  // and it moved from the click, not from the build: this is the same state
  // the button read.
  await expect(page.locator("#colour_slot_buildings")).not.toHaveValue("9");

  // Once the next build lands, the engine no longer reports the finding at
  // all -- the row is gone, not merely disabled.
  await expect(item).toHaveCount(0, { timeout: WARMUP_BUDGET_MS });

  // Now the recorder's sequence, which is the assertion the pure function's
  // unit tests cannot make: the mark held for as long as the row did.
  const states = await page.evaluate(
    () => (window as unknown as { __fixLog: string[] }).__fixLog ?? [],
  );
  log(`fix button states: ${states.join(" -> ")}`);

  // 1. The optimistic mark really appeared. Without this the rest is vacuous:
  //    a button that went straight from offered to absent would satisfy any
  //    "never offered again" claim while marking nothing.
  const marked = states.indexOf("disabled:Fixed");
  expect(states, "the button never read Fixed").not.toEqual([]);
  expect(marked, `no "disabled:Fixed" in ${states.join(" -> ")}`).toBeGreaterThanOrEqual(0);

  // 2. It was never taken back. Every state after the mark is either the mark
  //    itself or the row's disappearance -- never the fix on offer again.
  //    Clearing the marks on a fresh findings array puts an `enabled:` entry
  //    here, because the array that arrives 80 ms after the click still carries
  //    this row.
  expect(
    states.slice(marked + 1).filter((state) => state.startsWith("enabled:")),
    `the mark was taken back while the row was still on screen: ${states.join(" -> ")}`,
  ).toEqual([]);

  // 3. And the row is what retired it, not a timer.
  expect(states[states.length - 1]).toBe("absent");
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
  // into a finished export's own notes, so the two can never disagree).
  await expect(page.getByTestId("tiled-export-note")).toContainText("4 tiles");
  await expect(page.getByTestId("tiled-export-note")).toContainText("one plate each");
  await expect(page.getByTestId("tiled-export-note")).toContainText("single Bambu Studio project");

  await page.getByTestId("export-button").click();
  await expect(page.getByTestId("download-links")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  const links = page.getByTestId("download-links").locator("a");
  await expect(links).not.toHaveCount(0);
  log(`download links: ${await links.count()}`);
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});
