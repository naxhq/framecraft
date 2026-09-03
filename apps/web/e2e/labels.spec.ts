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
 * A roof this big, in square metres, holds a two-letter counterless label at
 * the 4 mm default with a wall's clearance on every side at the Chicago Loop's
 * print scale (about 0.09 mm per metre: 6 000 m2 is a 77 m square, 7 mm
 * across on the plate), or is shrunk to a size that still cuts. A smaller
 * named building would be labelled too, but the label might be refused, and
 * this test is about the manipulation, not the fit.
 */
const MIN_FOOTPRINT_M2 = 6_000;

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
 * with a roof big enough to hold the label (see `MIN_FOOTPRINT_M2`). A grid
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
      if (layer === "building" && named === "true" && area >= MIN_FOOTPRINT_M2) {
        const title = (await page.getByTestId("object-popover-title").textContent()) ?? "";
        return { at: { x, y }, title };
      }
    }
  }
  throw new Error(
    `no named building of ${MIN_FOOTPRINT_M2} m2 or more under a 99-point sweep; seen: ${
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
  const handle = page.getByTestId("label-handle-0");
  await expect(handle).toBeVisible({ timeout: REBUILD_BUDGET_MS });
  await expect(handle).toHaveAttribute("data-selected", "true");
  await expect(item).toHaveAttribute("data-label-status", "cut", { timeout: REBUILD_BUDGET_MS });
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
  const sidecarHref = await downloads.getByRole("link", { name: /\.json$/ }).getAttribute("href");
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
