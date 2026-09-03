import { expect, test, type Page } from "@playwright/test";

import { mockTinyLoopOverpass } from "./overpassMock";

/**
 * The action bar (`components/editor/ActionBar.tsx`, `docs/handoff/
 * v3-06-actionbar.md`): the claims about it that only a laid-out page can
 * settle.
 *
 * `ActionBar.test.tsx` pins the COMPOSITION -- every state renders the same
 * controls in the same order, the progress model's arithmetic, the failure
 * models, and "no skeleton in a settled state" over four surfaces' rendered
 * HTML. None of that can say anything about layout, about a live region, or
 * about a real run, because `renderToStaticMarkup` has no box, no effects and
 * no store. This file is the other half, and until [V3.1-T6] it did not exist
 * while `ActionBar.tsx` named it in a comment.
 *
 * What it pins:
 *   1. The bar's own box never moves -- idle, mid-run, after a refusal, after a
 *      finished export -- which is the whole reason the bar was split out of
 *      the results panel.
 *   2. No skeleton in the idle, error or completed state (gate V3-2).
 *   3. The progress control is determinate: real stage names, a rising
 *      `aria-valuenow`, and a live region that speaks the PHASE.
 *   4. Cancel leaves the previous model, its stats and its estimate on screen,
 *      and reads as a cancel rather than as a refusal.
 *   5. A refused export names the reason and its copyable block carries the
 *      stage, the message and the app version.
 *   6. The compact format selector switches targets and the download's file
 *      name follows.
 *
 * Every Overpass call is routed to the 30-building synthetic fixture
 * (`mockTinyLoopOverpass`), the same one `print.spec.ts` uses: it clears 01/A2's
 * 20-building minimum, builds cleanly and builds fast, which is what lets the
 * tagged test below stay inside its budget.
 */

const BUDGET_FACTOR = Number(process.env.E2E_BUDGET_FACTOR ?? 1) || 1;
const WARMUP_BUDGET_MS = 60_000 * BUDGET_FACTOR;
/** The tagged test's own ceiling: 60 s at `E2E_BUDGET_FACTOR=3`, the figure [V3.1-P14-1] budgets the required CI path against. */
const SMOKE_BUDGET_MS = 20_000 * BUDGET_FACTOR;

function log(message: string): void {
  console.log(`[actionbar] ${message}`);
}

/** Every uncaught exception the page throws, so a silent React crash fails loudly instead of as a missing element three assertions later. */
function watchPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** Wait until no stage is running. */
async function pipelineSettled(page: Page): Promise<void> {
  await expect(page.locator("[data-pipeline-status]")).toHaveAttribute(
    "data-pipeline-status",
    "ready",
    { timeout: WARMUP_BUDGET_MS },
  );
  await expect(page.getByTestId("pipeline-stage-overlay")).toHaveCount(0, {
    timeout: WARMUP_BUDGET_MS,
  });
}

/** Land on the editor with the tiny fixture mocked, before anything has been built. */
async function openEditor(page: Page): Promise<void> {
  await mockTinyLoopOverpass(page);
  await page.goto("/");
  await expect(page.getByTestId("action-bar")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await expect(page.getByTestId("preset-row")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
}

/** Click the Chicago preset and wait for the whole model. */
async function previewTinyLoop(page: Page): Promise<void> {
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-stats")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await expect(page.getByTestId("stats-card")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await pipelineSettled(page);
}

// ---------------------------------------------------------------------------
// The box, recorded rather than sampled
// ---------------------------------------------------------------------------

interface BarSample {
  /** `x,y,w,h` of `action-bar-actions`, rounded to a tenth of a pixel. */
  rect: string;
  /** What the bar was showing when that box was measured, so a run and a failure are provably among the samples. */
  showing: string;
}

/**
 * Start recording the control row's box on every animation frame.
 *
 * Reading `boundingBox()` from Node at three chosen moments is a test of when
 * Node happened to look. The invariant is stronger than that: the row must not
 * move at ANY point during a run, a failure or an export, and a recorder inside
 * the page sees every frame of all three. Consecutive identical samples are
 * dropped, so the log is the list of transitions and `new Set(rects).size` is
 * the assertion.
 */
async function recordBarBox(page: Page): Promise<void> {
  // A web font swapping in after the first sample would move every box on the
  // page, which is a fact about font loading and not about this bar.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => {
    const samples: { rect: string; showing: string }[] = [];
    (window as unknown as { __barLog: typeof samples }).__barLog = samples;
    const has = (id: string): boolean => document.querySelector(`[data-testid="${id}"]`) !== null;
    const sample = (): void => {
      const row = document.querySelector('[data-testid="action-bar-actions"]');
      if (row === null) return;
      const box = row.getBoundingClientRect();
      const rect = [box.x, box.y, box.width, box.height].map((n) => n.toFixed(1)).join(",");
      const showing = [
        has("run-progress") ? "running" : "",
        has("export-error-detail") ? "refused" : "",
        has("export-cancelled-detail") ? "cancelled" : "",
        has("run-error-detail") ? "broken" : "",
        has("download-links") ? "downloads" : "",
      ]
        .filter((part) => part !== "")
        .join("+");
      const last = samples[samples.length - 1];
      if (last !== undefined && last.rect === rect && last.showing === showing) return;
      samples.push({ rect, showing: showing === "" ? "settled" : showing });
    };
    const tick = (): void => {
      sample();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function barSamples(page: Page): Promise<BarSample[]> {
  return page.evaluate(() => (window as unknown as { __barLog: BarSample[] }).__barLog ?? []);
}

/**
 * Assert the row never moved, and that the states named were really among the
 * frames that were measured.
 */
function expectBoxHeldThrough(samples: readonly BarSample[], states: readonly string[]): void {
  expect(samples.length, "the recorder captured no frames at all").toBeGreaterThan(0);
  const rects = [...new Set(samples.map((sample) => sample.rect))];
  const seen = samples.map((sample) => `${sample.showing} @ ${sample.rect}`).join(" | ");
  expect(rects, `the control row moved: ${seen}`).toHaveLength(1);
  for (const state of states) {
    expect(
      samples.some((sample) => sample.showing.includes(state)),
      `never observed the bar in the "${state}" state: ${seen}`,
    ).toBe(true);
  }
}

/** Every skeleton on the page, however it is spelled: a `-skeleton` test id or the shimmer keyframe. */
async function skeletons(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    for (const el of Array.from(document.querySelectorAll("[data-testid$='-skeleton']"))) {
      found.push(el.getAttribute("data-testid") ?? "unnamed");
    }
    for (const el of Array.from(document.querySelectorAll("[class*='fc-pulse']"))) {
      found.push(`fc-pulse on ${el.getAttribute("data-testid") ?? el.tagName.toLowerCase()}`);
    }
    return found;
  });
}

// ==========================================================================
// 1. Preview, export, a download, and a row that never moves
// ==========================================================================

test("the bar previews, exports and offers a download without ever moving @smoke", async ({
  page,
}) => {
  test.setTimeout(300_000 * BUDGET_FACTOR);
  const pageErrors = watchPageErrors(page);
  await openEditor(page);
  await recordBarBox(page);

  const startedAt = Date.now();

  // ---- idle: nothing built, and no placeholder pretending otherwise -------
  expect(await skeletons(page), "a skeleton in the idle state (gate V3-2)").toEqual([]);
  await expect(page.getByTestId("action-bar-status")).toContainText("Nothing built yet");

  // ---- a run, then a model ----------------------------------------------
  await previewTinyLoop(page);
  expect(await skeletons(page), "a skeleton in the completed state (gate V3-2)").toEqual([]);
  await expect(page.getByTestId("action-bar-status")).toContainText("Model ready");
  await expect(page.getByTestId("estimate-card")).toBeVisible();
  await expect(page.getByTestId("stats-card")).toBeVisible();

  // ---- the export, and a real Blob download ------------------------------
  const downloads = page.getByTestId("download-links");
  await page.getByTestId("export-button").click();
  await expect(downloads).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await expect(page.getByTestId("export-button")).toBeEnabled({ timeout: WARMUP_BUDGET_MS });
  const links = downloads.getByRole("link");
  await expect(links).not.toHaveCount(0);
  const names = await links.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("download") ?? ""),
  );
  const hrefs = await links.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("href") ?? ""),
  );
  log(`downloads: ${names.join(", ")}`);
  // The default target is `bambu-3mf`, and every export ships its sidecar.
  expect(names.some((name) => name.endsWith(".3mf"))).toBe(true);
  expect(names.some((name) => name.endsWith(".json"))).toBe(true);
  for (const href of hrefs) expect(href.startsWith("blob:")).toBe(true);
  expect(await skeletons(page), "a skeleton after a finished export").toEqual([]);

  // ---- and the row is exactly where it started ---------------------------
  const samples = await barSamples(page);
  log(`bar states: ${[...new Set(samples.map((s) => s.showing))].join(", ")}`);
  expectBoxHeldThrough(samples, ["running", "downloads"]);

  const elapsedMs = Date.now() - startedAt;
  log(`preview + export + download: ${elapsedMs} ms (budget ${SMOKE_BUDGET_MS} ms at factor ${BUDGET_FACTOR})`);
  expect(elapsedMs).toBeLessThan(SMOKE_BUDGET_MS);
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});

// ==========================================================================
// 2. The progress control is determinate
// ==========================================================================

test("the progress control walks real stages, with a rising value and a spoken phase", async ({
  page,
}) => {
  test.setTimeout(300_000 * BUDGET_FACTOR);
  const pageErrors = watchPageErrors(page);
  await openEditor(page);

  /*
   * Recorded frame by frame inside the page, for the same reason the box is:
   * a run reports 142 stage events on a full plan and polling from Node reads
   * whichever handful of them a round trip happened to land on. What is
   * asserted is the SEQUENCE -- that the value never went backwards, that more
   * than one real stage was named, and that the live region spoke more than one
   * phase -- none of which a sample of three can show.
   */
  await page.evaluate(() => {
    const rows: { stage: string; now: number; max: number; text: string; phase: string }[] = [];
    (window as unknown as { __progressLog: typeof rows }).__progressLog = rows;
    const sample = (): void => {
      const bar = document.querySelector('[data-testid="run-progress"]');
      if (bar === null) return;
      const spoken = document.querySelector('[data-testid="run-progress-phase"]');
      const row = {
        stage: bar.getAttribute("data-stage") ?? "",
        now: Number(bar.getAttribute("aria-valuenow") ?? "0"),
        max: Number(bar.getAttribute("aria-valuemax") ?? "0"),
        text: bar.getAttribute("aria-valuetext") ?? "",
        phase: (spoken?.textContent ?? "").trim(),
      };
      const last = rows[rows.length - 1];
      if (last !== undefined && last.stage === row.stage && last.now === row.now) return;
      rows.push(row);
    };
    const tick = (): void => {
      sample();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await previewTinyLoop(page);

  const rows = await page.evaluate(
    () =>
      (window as unknown as {
        __progressLog: { stage: string; now: number; max: number; text: string; phase: string }[];
      }).__progressLog ?? [],
  );
  log(`progress steps: ${rows.length}, stages: ${[...new Set(rows.map((r) => r.stage))].join(", ")}`);
  expect(rows.length, "the progress control was never on screen").toBeGreaterThan(0);

  /*
   * Split at every drop in the value, so each segment is ONE run.
   *
   * A preset click can be followed by a second, superseding run (a place-name
   * write schedules one on the 80 ms debounce), and that legitimately restarts
   * the count. Asserting monotonicity across the whole log would fail on a
   * behaviour that is correct; asserting it per run is the claim that is
   * actually being made.
   */
  const runs: (typeof rows)[] = [[]];
  for (const row of rows) {
    const current = runs[runs.length - 1];
    const previous = current[current.length - 1];
    if (previous !== undefined && row.now < previous.now) runs.push([row]);
    else current.push(row);
  }
  const longest = runs.reduce((best, run) => (run.length > best.length ? run : best), runs[0]);
  log(`runs observed: ${runs.length}, longest ${longest.length} steps`);
  expect(longest.length, "no run reported enough progress to judge").toBeGreaterThanOrEqual(3);

  // Real stage names, not a spinner: more than one, and each one spoken in
  // `aria-valuetext` beside the step number so it is heard, not only seen.
  const stages = [...new Set(longest.map((row) => row.stage))].filter((stage) => stage !== "");
  expect(stages.length, `only one stage was ever named: ${stages.join(", ")}`).toBeGreaterThan(1);
  for (const row of longest) {
    if (row.stage === "") continue;
    expect(row.text, `aria-valuetext said nothing about step ${row.now}`).toContain("step ");
  }

  // Determinate: the value moves, never backwards inside a run, and never past
  // the plan's own length. `aria-valuenow` is `index + 1` and `aria-valuemax`
  // is the plan, so the pair IS the fraction the fill is drawn from -- there is
  // no clock anywhere in it.
  const values = longest.map((row) => row.now);
  expect(Math.max(...values), `the value never moved: ${values.join(",")}`).toBeGreaterThan(
    Math.min(...values),
  );
  for (let i = 1; i < longest.length; i += 1) {
    expect(longest[i].now, `the value went backwards at step ${i}`).toBeGreaterThanOrEqual(
      longest[i - 1].now,
    );
    expect(longest[i].now).toBeLessThanOrEqual(longest[i].max);
    expect(longest[i].max).toBeGreaterThan(0);
  }

  // The live region announces the PHASE, which is what makes it usable: a
  // handful of sentences across a run rather than one per stage event.
  const phases = [...new Set(longest.map((row) => row.phase))].filter((phase) => phase !== "");
  log(`phases announced: ${phases.join(" | ")}`);
  expect(phases.length, `only one phase was announced: ${phases.join(" | ")}`).toBeGreaterThan(1);
  expect(phases.length, "a phase sentence per stage would be noise, not commentary").toBeLessThan(8);
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});

// ==========================================================================
// 3. Cancel keeps what is on screen, and reads as a cancel
// ==========================================================================

test("Cancel during a plate resize leaves the model, its stats and its estimate on screen", async ({
  page,
}) => {
  test.setTimeout(300_000 * BUDGET_FACTOR);
  const pageErrors = watchPageErrors(page);
  await openEditor(page);
  await previewTinyLoop(page);

  /*
   * The triangle count off the stats card, not the card's whole text: a stale
   * card correctly relabels its own heading ("previous computation") and adds a
   * note, so comparing the text wholesale would fail on the very behaviour that
   * proves the numbers were kept.
   */
  const triangleCount = async (): Promise<string> => {
    const text = (await page.getByTestId("stats-card").textContent()) ?? "";
    return /Triangles([\d,]+)/.exec(text.replace(/\s+/g, ""))?.[1] ?? "";
  };
  const triangles = await triangleCount();
  const estimate = await page.getByTestId("estimate-total").textContent();
  expect(triangles, "the stats card reported no triangle count").not.toBe("");
  expect(estimate).toBeTruthy();

  await recordBarBox(page);

  // A plate resize re-runs everything under `context`: the longest run the app
  // has, and the one worth being able to abandon.
  await page.locator("#plate_mm").fill("240");

  // Cancel from the BAR's own button, not the viewport's Stop: this is the
  // control that becomes Cancel while a run is in flight.
  const previewButton = page.getByTestId("preview-button");
  await expect(previewButton).toHaveAttribute("data-mode", "cancel", {
    timeout: 30_000 * BUDGET_FACTOR,
  });
  await expect(page.getByTestId("run-progress")).toBeVisible({ timeout: 30_000 * BUDGET_FACTOR });
  await previewButton.click();

  await expect(previewButton).toHaveAttribute("data-mode", "preview", {
    timeout: 30_000 * BUDGET_FACTOR,
  });
  await expect(page.locator("[data-pipeline-status]")).toHaveAttribute(
    "data-pipeline-status",
    "ready",
  );

  // The status line names the stage it stopped at, and calls it a cancel.
  const status = page.getByTestId("action-bar-status");
  await expect(status).toContainText("Cancelled", { timeout: 30_000 * BUDGET_FACTOR });

  // Nothing anywhere claims something broke or was refused. A cancel is not a
  // failure ([V3.1-T6] 2), and the previous model is still the model.
  await expect(page.getByTestId("run-error-detail")).toHaveCount(0);
  await expect(page.getByTestId("export-error-detail")).toHaveCount(0);
  await expect(page.getByTestId("stats-card")).toBeVisible();
  await expect(page.getByTestId("estimate-card")).toBeVisible();
  expect(await triangleCount(), "the stats card lost its numbers to a cancel").toBe(triangles);
  expect(await page.getByTestId("estimate-total").textContent()).toBe(estimate);
  // The numbers are dimmed and labelled, not replaced by four grey bars.
  await expect(page.getByTestId("estimate-card")).toHaveAttribute("data-stale", "true");
  expect(await skeletons(page), "a skeleton over a perfectly good previous estimate").toEqual([]);

  // Preview comes back, or the only way to start a build would be to nudge a
  // slider back and forth.
  await expect(previewButton).toBeEnabled();

  expectBoxHeldThrough(await barSamples(page), ["running"]);
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});

// ==========================================================================
// 4. A refused export, and the report it hands over
// ==========================================================================

test("a refused export names the reason and its copyable block carries the stage, message and version", async ({
  page,
}) => {
  test.setTimeout(300_000 * BUDGET_FACTOR);
  const pageErrors = watchPageErrors(page);
  await openEditor(page);
  await previewTinyLoop(page);
  await recordBarBox(page);

  /*
   * The refusal driven here is the editor's own pre-flight
   * (`lib/warnings.ts:exportBlockReason`), reached by asking for a keyhole
   * hanger the base cannot carry -- deterministic, and the same path
   * `ui.spec.ts` already proves disables the button.
   *
   * The OTHER refusal, the printability gate's ([V3.1-P1-15], whose message
   * names every blocking finding by id and whose detail block carries them on
   * `data-findings`), is asserted in `ActionBar.test.tsx` against a real
   * `ExportBlockedError` and a real `blockingFindings` call rather than here,
   * because it cannot be reached from this UI on a flat scene: the client
   * prediction `transform.predicted_top_mm` and the engine's measured
   * `bounds.max[2]` agree to the millimetre on every flat build (measured: 6.92
   * against 6.92), so the client refuses first every time. Terrain relief is
   * the only lever that separates them, and `e2e/terrainTile.ts` serves a
   * uniform tile. See `docs/handoff/v3-06-actionbar.md` for the measurement and
   * what it would take to close.
   */
  await page.getByTestId("group-frame-toggle").click();
  await page.locator("#hanger").selectOption("keyhole");
  await expect(page.getByTestId("export-block-reason")).toContainText("Keyhole hanger needs");
  await expect(page.getByTestId("export-button")).toBeDisabled();

  // Choosing a format exports (`ExportMenu.onChange`), so this is the user path
  // that reaches the refusal with the button already disabled.
  await page.locator("#export_target").selectOption("stl");

  const detail = page.getByTestId("export-error-detail");
  await expect(detail).toBeVisible({ timeout: 30_000 * BUDGET_FACTOR });
  await expect(page.getByTestId("export-error-detail-message")).toContainText(
    "The export was refused",
  );
  await expect(page.getByTestId("export-error-detail-message")).toContainText("Keyhole hanger");
  // It is a refusal, not a cancel, and the two surfaces never coexist.
  await expect(page.getByTestId("export-cancelled-detail")).toHaveCount(0);
  await expect(detail).toHaveAttribute("data-tone", "danger");

  // No file came out of it ([V3.1-P1-15]): the results panel says so and offers
  // nothing to download.
  await expect(page.getByTestId("export-phase")).toHaveText("No file written");
  await expect(page.getByTestId("download-links")).toHaveCount(0);

  // The block is behind the button until it is asked for, and the button
  // reveals it whether or not the clipboard write was allowed.
  await expect(page.getByTestId("export-error-detail-block")).toHaveCount(0);
  await page.getByTestId("export-error-detail-copy").click();
  const block = page.getByTestId("export-error-detail-block");
  await expect(block).toBeVisible();
  const text = (await block.textContent()) ?? "";
  log(`detail block: ${text.replace(/\n/g, " / ")}`);
  expect(text).toContain("what: the export was refused");
  expect(text).toContain("message: Keyhole hanger needs");
  // The app version, so a report says which build produced it, and a
  // fingerprint of the parameters, so two reports of "it broke" can be told
  // apart without shipping the whole settings object.
  expect(text).toMatch(/app: FrameCraft \d+\.\d+\.\d+/);
  expect(text).toMatch(/params: [0-9a-f]{12}/);

  // The failure appeared BELOW the controls and moved nothing.
  expectBoxHeldThrough(await barSamples(page), ["refused"]);
  expect(await skeletons(page), "a skeleton in the error state (gate V3-2)").toEqual([]);
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});

// ==========================================================================
// 5. The compact format selector
// ==========================================================================

test("the format selector switches targets and the download's file name follows", async ({
  page,
}) => {
  test.setTimeout(300_000 * BUDGET_FACTOR);
  const pageErrors = watchPageErrors(page);
  await openEditor(page);
  await previewTinyLoop(page);
  await recordBarBox(page);

  const downloads = page.getByTestId("download-links");
  const links = downloads.getByRole("link");
  const names = async (): Promise<string[]> =>
    links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("download") ?? ""));

  // Choosing a format writes `export_target` and exports in one action, so the
  // links on screen always match the format shown.
  const select = page.locator("#export_target");
  await select.selectOption("stl");
  await expect(downloads).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await expect.poll(async () => (await names()).some((n) => n.endsWith(".stl")), {
    timeout: WARMUP_BUDGET_MS,
  }).toBe(true);
  await expect(page.getByTestId("export-target-description")).toHaveAttribute("data-target", "stl");
  await expect(page.getByTestId("export-target-description")).toContainText("STL");
  log(`stl downloads: ${(await names()).join(", ")}`);

  // A second target through the same control: the name follows, and the old
  // one is gone rather than sitting next to it.
  await select.selectOption("generic-3mf");
  await expect.poll(async () => (await names()).some((n) => n.endsWith(".3mf")), {
    timeout: WARMUP_BUDGET_MS,
  }).toBe(true);
  expect((await names()).some((n) => n.endsWith(".stl"))).toBe(false);
  await expect(page.getByTestId("export-target-description")).toHaveAttribute(
    "data-target",
    "generic-3mf",
  );
  // The format the file was written in is reported from the worker's own
  // answer, not from a second read of the parameters.
  await expect(page.getByTestId("export-status")).toContainText("generic-3mf");
  log(`generic-3mf downloads: ${(await names()).join(", ")}`);

  expectBoxHeldThrough(await barSamples(page), ["downloads"]);
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});
