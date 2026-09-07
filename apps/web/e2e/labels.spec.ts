import { expect, test, type Locator, type Page } from "@playwright/test";

import { mockChicagoOverpass } from "./overpassMock";

/**
 * Surface labels (v3.1 Task 12), in a real browser with a real pointer.
 *
 * The unit suites own the maths (`lib/labelAnchor.test.ts`), the cut itself
 * (`lib/engine/solid/labels.test.ts`), the store (`store/editor.labels.test.ts`)
 * and every leaf's effect on the preview and the file (`matrix.labels.ts`).
 * What only a browser can prove is the direct manipulation:
 *
 *  - a right-click on a named building offers "Label its roof", and taking it
 *    puts a label on the roof, counted against the cap from the first one;
 *  - the pipeline cuts it: the handle appears on the roof, the resolved output
 *    says "cut", and an export's sidecar carries the band and the text;
 *  - dragging the handle moves the anchor; the keyboard turns and resizes it;
 *  - Delete takes it off again.
 *
 * Offline like every other suite here: the Overpass mirror is route-mocked
 * from the committed Chicago Loop fixture.
 */

const BUDGET_FACTOR = Number(process.env.E2E_BUDGET_FACTOR ?? 1) || 1;
const WARMUP_BUDGET_MS = 60_000 * BUDGET_FACTOR;
/** One Chicago rebuild after a parameter write, plus the export. */
const REBUILD_BUDGET_MS = 90_000 * BUDGET_FACTOR;

/** Longer than the popover's own throttle, so a move has certainly been applied. */
const SETTLE_MS = 180;

/**
 * The footprint band, in square metres, a roof has to be in to be worth
 * labelling here. Both bounds matter, and the upper one is the surprising one.
 *
 * The floor is the fit: at the Chicago Loop's print scale (about 0.093 mm per
 * metre, 1:10,714) a 5 000 m2 roof is a 71 m square, 6.6 mm across on the
 * plate, which holds two counterless letters at the 4 mm default with a wall's
 * clearance on every side, or is shrunk to a size that still cuts. A smaller
 * named building would be labelled too, but the label might be refused, and
 * this test is about the manipulation, not the fit.
 *
 * The ceiling is the SHAPE. A roof label is cut into the highest repaired
 * building solid under the anchor, eroded by one minimum wall
 * (docs/handoff/v3-12-labels.md section 4), so what has to be roomy is the one
 * solid the centre lands on, not the sum of the footprint. Area is therefore a
 * necessary condition and not a sufficient one, and a footprint several times
 * larger than any tower in the crop is the signature of a multi-building
 * complex whose centre lands on a wing. The Chicago Loop fixture has exactly
 * one: The Art Institute of Chicago, 25 980 m2 of wings around courtyards and
 * a railway, which refuses "IT" even at the 1.50 mm minimum -- while every
 * tower in the same sweep is between 800 and 5 400 m2 and takes it. This band
 * picks the roomiest plain block (Chase Tower, 5 296 m2) and steps over the
 * complex.
 */
const MIN_FOOTPRINT_M2 = 5_000;
const MAX_FOOTPRINT_M2 = 10_000;

async function generateChicago(page: Page): Promise<void> {
  await mockChicagoOverpass(page);
  await page.goto("/");
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-canvas")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await expect(page.getByTestId("preview-stats")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await expect(page.getByTestId("preview-triangles")).toContainText("triangles", {
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

/** The popover's Footprint row as a number of square metres, or 0 when it shows none. */
async function footprintM2(popover: Locator): Promise<number> {
  const text = (await popover.textContent()) ?? "";
  const match = /Footprint\s*([\d\s,.]+)\s*m/.exec(text);
  if (match === null) return 0;
  return Number(match[1].replace(/[^\d.]/g, "")) || 0;
}

/**
 * Sweep the middle of the viewport until the pointer lands on a NAMED building
 * with a roof that holds the label (see the footprint band above). A grid
 * rather than one fixed point, for the reason `objects.spec.ts` gives: where a
 * building sits on screen depends on the camera, the plate and the fixture.
 */
async function hoverUntilLabellableBuilding(
  page: Page,
  popover: Locator,
): Promise<{ at: { x: number; y: number }; title: string }> {
  const box = await page.getByTestId("preview-canvas").boundingBox();
  if (box === null) throw new Error("the preview canvas has no box");
  const seen: string[] = [];
  for (let row = 0; row < 9; row += 1) {
    for (let column = 0; column < 11; column += 1) {
      const x = box.x + box.width * (0.2 + (column / 10) * 0.6);
      const y = box.y + box.height * (0.2 + (row / 8) * 0.6);
      await page.mouse.move(x, y);
      await page.waitForTimeout(SETTLE_MS);
      if (!(await popover.isVisible())) continue;
      const layer = (await popover.getAttribute("data-object-layer")) ?? "";
      const named = (await popover.getAttribute("data-object-named")) ?? "";
      const area = await footprintM2(popover);
      seen.push(`${layer}/${named}/${area}`);
      if (
        layer === "building" &&
        named === "true" &&
        area >= MIN_FOOTPRINT_M2 &&
        area <= MAX_FOOTPRINT_M2
      ) {
        const title = (await page.getByTestId("object-popover-title").textContent()) ?? "";
        return { at: { x, y }, title };
      }
    }
  }
  throw new Error(
    `no named building between ${MIN_FOOTPRINT_M2} and ${MAX_FOOTPRINT_M2} m2 under a 99-point sweep; seen: ${
      seen.join(", ") || "nothing at all"
    }`,
  );
}

test("a right-click labels a roof; the label is cut, exported, dragged, turned, resized and removed", async ({
  page,
}) => {
  await generateChicago(page);
  const popover = page.getByTestId("object-popover");
  const { at, title } = await hoverUntilLabellableBuilding(page, popover);

  // ---- place: the inspector's Label row ---------------------------------
  await expect(page.getByTestId("labels-panel")).toHaveCount(0);
  await page.mouse.click(at.x, at.y, { button: "right" });
  const inspector = page.getByTestId("object-inspector");
  await expect(inspector).toBeVisible();
  await expect(inspector).toHaveAttribute("data-inspector-layer", "building");
  const labelRow = page.getByTestId("inspector-label");
  await expect(labelRow).toHaveText("Label its roof");
  await labelRow.click();
  await expect(inspector).toBeHidden();

  // Counted against the cap from the first one, and named after the building.
  const panel = page.getByTestId("labels-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("labels-count")).toHaveText("1 of 12 labels");
  const item = page.getByTestId("label-item-0");
  await expect(item).toHaveAttribute("data-label-layer", "building");
  await expect(item).toHaveAttribute("data-label-u", "0.5");
  await expect(item).toHaveAttribute("data-label-v", "0.5");
  await expect(page.getByTestId("label-row-0")).toContainText(title);
  // Placed and selected: its fields are open.
  await expect(page.getByTestId("label-row-0")).toHaveAttribute("aria-pressed", "true");

  // Two letters with no counters, at the 4 mm default: a label the roof found
  // above holds, and one a 0.4 mm nozzle cuts at any size the fit may shrink
  // it to (a letter with a counter, an A or a B, is refused under 3.33 mm).
  await page.locator("#label_0_text").fill("IT");
  await expect(page.locator("#label_0_text")).toHaveValue("IT");
  await expect(item).toHaveAttribute("data-label-size", "4");

  // ---- cut: the pipeline reports the band, the handle sits on it ---------
  // The card's verdict first, and the engine's own words with it. A refused
  // label has no band and therefore no handle (`LabelGizmo` draws pipeline
  // output only), so waiting on the handle first reports a missing element
  // where the real news is the refusal -- and the refusal names the roof and
  // the size it gave up at. Polled rather than asserted once, because the
  // build for the label as PLACED (its text still the building's own name, too
  // long for most roofs) may land between the placement and this line and
  // report "not cut" for a label the "IT" build then cuts.
  const reason = page.getByTestId("label-item-0-reason");
  await expect
    .poll(
      async () => {
        const status = await item.getAttribute("data-label-status");
        if (status === "cut") return "cut";
        // `count()` rather than `textContent()`: the reason row is there only
        // while the card says "not cut", and a locator read of an absent
        // element waits out the whole test, not the poll's interval.
        const words = (await reason.count()) > 0 ? ((await reason.textContent()) ?? "") : "";
        return words === "" ? `${status}` : `${status}: ${words}`;
      },
      { timeout: REBUILD_BUDGET_MS, intervals: [100] },
    )
    .toBe("cut");
  const handle = page.getByTestId("label-handle-0");
  await expect(handle).toBeVisible({ timeout: REBUILD_BUDGET_MS });
  await expect(handle).toHaveAttribute("data-selected", "true");
  await openGroup(page, "output");
  const resolvedRow = page.getByTestId("resolved-output-row-label-0");
  await expect(resolvedRow).toBeVisible();
  await expect(resolvedRow).toHaveAttribute("data-status", "cut");
  await expect(resolvedRow).toContainText("IT");
  await expect(resolvedRow).toContainText("Roof of");

  // ---- export: the sidecar carries the band and the text -----------------
  const exportButton = page.getByTestId("export-button");
  await expect(exportButton).toBeEnabled({ timeout: REBUILD_BUDGET_MS });
  await exportButton.click();
  const downloads = page.getByTestId("download-links");
  await expect(downloads).toBeVisible({ timeout: REBUILD_BUDGET_MS });
  const sidecarHref = await downloads.getByTestId("download-link-report").getAttribute("href");
  expect(sidecarHref, "the sidecar link has no href").toBeTruthy();
  const sidecar = await page.evaluate(async (url) => {
    const res = await fetch(url);
    return (await res.json()) as {
      label_bands: Array<{ index: number; mode: string; rect: unknown[]; region: string }>;
      print_params: { labels: Array<{ text: string; size_mm: number }> };
      resolved_text: Array<{ id: string; status: string; text: string }>;
    };
  }, sidecarHref as string);
  expect(sidecar.label_bands).toHaveLength(1);
  expect(sidecar.label_bands[0]).toMatchObject({ index: 0, mode: "engrave" });
  expect(sidecar.label_bands[0].rect.length).toBeGreaterThanOrEqual(4);
  expect(sidecar.print_params.labels).toHaveLength(1);
  expect(sidecar.print_params.labels[0]).toMatchObject({ text: "IT", size_mm: 4 });
  expect(sidecar.resolved_text.find((line) => line.id === "label-0")).toMatchObject({ status: "cuts", text: "IT" });

  // ---- drag: the handle moves the anchor off the centre ------------------
  const handleBox = await handle.boundingBox();
  if (handleBox === null) throw new Error("the label handle has no box");
  const hx = handleBox.x + handleBox.width / 2;
  const hy = handleBox.y + handleBox.height / 2;
  // A short drag: a few pixels is about a millimetre on the plate, well past
  // the centre snap (4 % of the roof) and well inside the roof, so the label
  // still fits and is still cut where it lands.
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  for (let step = 1; step <= 3; step += 1) {
    await page.mouse.move(hx + step * 2, hy + step);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  const u = Number(await item.getAttribute("data-label-u"));
  const v = Number(await item.getAttribute("data-label-v"));
  expect(u !== 0.5 || v !== 0.5, `the drag left the anchor at (${u}, ${v})`).toBe(true);
  expect(u).toBeGreaterThanOrEqual(0);
  expect(u).toBeLessThanOrEqual(1);
  // The camera did not orbit under the drag: the model is still framed the
  // same way, so the handle is still where the pointer let go of it.
  await expect(handle).toBeVisible({ timeout: REBUILD_BUDGET_MS });

  // ---- keyboard: turn and resize from the row ----------------------------
  const row = page.getByTestId("label-row-0");
  await row.focus();
  await page.keyboard.press("]");
  await expect(item).toHaveAttribute("data-label-rotation", "-5");
  await page.keyboard.press("[");
  await page.keyboard.press("[");
  await expect(item).toHaveAttribute("data-label-rotation", "5");
  await page.keyboard.press("=");
  await expect(item).toHaveAttribute("data-label-size", "4.25");
  await page.keyboard.press("-");
  await expect(item).toHaveAttribute("data-label-size", "4");

  // ---- remove ------------------------------------------------------------
  await row.focus();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("labels-panel")).toHaveCount(0);
  await expect(page.getByTestId("label-handle-0")).toHaveCount(0, { timeout: REBUILD_BUDGET_MS });
});
