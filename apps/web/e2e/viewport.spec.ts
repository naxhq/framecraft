import { expect, test, type Page } from "@playwright/test";

import { mockTinyLoopOverpass } from "./overpassMock";

/**
 * The preview viewport renders on demand (`[V3.1-P7-34]`): the r3f `Canvas`
 * runs `frameloop="demand"`, so a frame is rendered when something changed
 * and not sixty times a second regardless. That is what gives a lettering
 * edit its interaction budget back (an idle loop was costing every hop to the
 * screen a frame boundary on software GL), and it carries one risk no other
 * spec here watches for: a viewport that renders once per gesture and then
 * stops, or never responds to the mouse at all, because nothing asked for the
 * next frame. So this spec drives the real thing and counts frames.
 *
 * A frame is counted as "WebGL draw calls happened on the preview's canvas
 * since the last animation frame", sampled from a `requestAnimationFrame`
 * loop installed before the page loads. The MapLibre picker has a WebGL canvas
 * too and comes first in DOM order; only the canvas under
 * `data-testid="preview-canvas"` counts.
 */

const BUDGET_FACTOR = Number(process.env.E2E_BUDGET_FACTOR ?? 1) || 1;
const WARMUP_BUDGET_MS = 60_000 * BUDGET_FACTOR;

declare global {
  interface Window {
    __framecraftPreviewFrames?: () => number;
  }
}

async function installFrameCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let draws = 0;
    let frames = 0;
    type Hooked = WebGLRenderingContext & { __framecraftHooked?: boolean };
    /** Count this context's draw calls, but only once its canvas turns out to be the preview's. */
    const hook = (canvas: HTMLCanvasElement, ctx: Hooked): void => {
      ctx.__framecraftHooked = true;
      let preview: boolean | null = null;
      const isPreview = (): boolean => {
        if (preview === null) {
          if (canvas.closest('[data-testid="preview-canvas"]') !== null) preview = true;
          else if (canvas.isConnected) preview = false;
        }
        return preview === true;
      };
      for (const name of ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"] as const) {
        const target = ctx as unknown as Record<string, unknown>;
        const orig = target[name];
        if (typeof orig !== "function") continue;
        target[name] = function (this: unknown, ...a: unknown[]) {
          if (isPreview()) draws += 1;
          return (orig as (...x: unknown[]) => unknown).apply(this, a);
        };
      }
    };
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      ...args: Parameters<HTMLCanvasElement["getContext"]>
    ) {
      const ctx = (origGetContext as (...a: unknown[]) => unknown).apply(this, args) as Hooked | null;
      if (ctx && typeof ctx.drawElements === "function" && !ctx.__framecraftHooked) hook(this, ctx);
      return ctx;
    } as typeof HTMLCanvasElement.prototype.getContext;
    let last = 0;
    const sample = (): void => {
      if (draws !== last) {
        frames += 1;
        last = draws;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    window.__framecraftPreviewFrames = () => frames;
  });
}

const frames = (page: Page): Promise<number> => page.evaluate(() => window.__framecraftPreviewFrames?.() ?? 0);

/** Wait until the pipeline is idle, i.e. no stage is running. */
async function pipelineSettled(page: Page): Promise<void> {
  await expect(page.locator("[data-pipeline-status]")).toHaveAttribute("data-pipeline-status", "ready", {
    timeout: WARMUP_BUDGET_MS,
  });
  await expect(page.getByTestId("pipeline-stage-overlay")).toHaveCount(0, { timeout: WARMUP_BUDGET_MS });
}

/**
 * Wait until the preview has rendered nothing for half a second. OrbitControls
 * damping keeps asking for frames after a drag until the motion is under its
 * epsilon, and on software GL at about sixteen frames a second that tail runs
 * for a few seconds; the phases that count frames start from a still picture.
 */
async function still(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const before = await frames(page);
        await page.waitForTimeout(500);
        return (await frames(page)) - before;
      },
      { message: "the preview never stopped rendering", timeout: 20_000 * BUDGET_FACTOR },
    )
    .toBe(0);
}

test("the viewport renders on demand: nothing while idle, continuously under the mouse, and as a rebuild streams", async ({
  page,
}) => {
  test.setTimeout(300_000 * BUDGET_FACTOR);
  await installFrameCounter(page);
  await mockTinyLoopOverpass(page);
  await page.goto("/");
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-stats")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await pipelineSettled(page);
  await still(page);

  const canvas = page.locator('[data-testid="preview-canvas"] canvas').first();
  const box = await canvas.boundingBox();
  expect(box, "the preview canvas has no box").not.toBeNull();
  if (box === null) return;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const clip = { x: box.x, y: box.y, width: box.width, height: box.height };

  // 1. Idle: a still model asks for no frame. This is the property the
  //    lettering budget rests on, and the one `frameloop="always"` never had.
  const idleBefore = await frames(page);
  await page.waitForTimeout(1_500);
  const idle = (await frames(page)) - idleBefore;
  expect(idle, `an idle preview rendered ${idle} frame(s) in 1.5 s`).toBeLessThanOrEqual(1);

  // 2. Orbit: a left drag across the model. The camera must track the pointer
  //    for the whole gesture, not render once and stop, and the picture must
  //    actually have moved.
  const pictureBefore = await page.screenshot({ clip });
  const dragBefore = await frames(page);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 20; i += 1) {
    await page.mouse.move(cx + i * 4, cy + i * 2);
    await page.waitForTimeout(16);
  }
  const duringDrag = (await frames(page)) - dragBefore;
  await page.mouse.up();
  expect(duringDrag, `an orbit drag of 20 pointer moves rendered ${duringDrag} frame(s): the camera does not track the pointer`).toBeGreaterThan(1);
  await still(page);
  const pictureAfter = await page.screenshot({ clip });
  expect(pictureAfter.equals(pictureBefore), "the orbit drag left the picture exactly as it was").toBe(false);

  // 3. A rebuild: the plate resize re-runs everything and streams the regions
  //    back one batch at a time; each batch that reaches the screen is a
  //    frame, and the dimming that starts the run is another.
  const rebuildBefore = await frames(page);
  await page.locator("#plate_mm").fill("220");
  await expect(page.getByTestId("pipeline-stage-overlay")).toBeVisible({ timeout: 30_000 * BUDGET_FACTOR });
  await expect(page.locator("[data-pipeline-dimmed]")).toHaveAttribute("data-pipeline-dimmed", "true");
  await pipelineSettled(page);
  await still(page);
  const duringRebuild = (await frames(page)) - rebuildBefore;
  expect(duringRebuild, `a streaming rebuild rendered ${duringRebuild} frame(s)`).toBeGreaterThan(1);
  await expect(page.locator("[data-pipeline-dimmed]")).toHaveAttribute("data-pipeline-dimmed", "false");
});
