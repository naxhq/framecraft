import fs from "node:fs";
import path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";

import { mockChicagoOverpass, mockTinyLoopOverpass } from "./overpassMock";

/**
 * "What am I looking at?", in a real browser with a real pointer.
 *
 * The unit suites own the content model (`lib/objectInfo.test.ts`) and the
 * markup (`components/scene/ObjectPopover.test.tsx`). What only a browser can
 * prove is the part that is made of raycasts and pointer events:
 *
 *  - a hover over the model resolves to a named building, with the height
 *    source the SceneGraph gave it, through `RegionMesh.triangleOwner` on the
 *    real solids rather than any proxy;
 *  - the popover closes when the pointer leaves the model;
 *  - a camera drag suppresses it, so orbiting does not drag a card across the
 *    thing being looked at.
 *
 * Offline like every other suite here: the Overpass mirror is route-mocked from
 * the committed Chicago Loop fixture.
 */

const BUDGET_FACTOR = Number(process.env.E2E_BUDGET_FACTOR ?? 1) || 1;
const WARMUP_BUDGET_MS = 60_000 * BUDGET_FACTOR;

/** Longer than the popover's own throttle, so a move has certainly been applied. */
const SETTLE_MS = 180;

async function generateChicago(page: Page): Promise<void> {
  await mockChicagoOverpass(page);
  await page.goto("/");
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-canvas")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await expect(page.getByTestId("preview-stats")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  // The popover reads the finished region meshes, so wait for the model itself
  // rather than for the canvas element.
  await expect(page.getByTestId("preview-triangles")).toContainText("triangles", {
    timeout: WARMUP_BUDGET_MS,
  });
}

interface Reading {
  visible: boolean;
  layer: string;
  named: string;
  heightSource: string;
  method: string;
  title: string;
}

async function read(popover: Locator, page: Page): Promise<Reading> {
  const visible = await popover.isVisible();
  return {
    visible,
    layer: (await popover.getAttribute("data-object-layer")) ?? "",
    named: (await popover.getAttribute("data-object-named")) ?? "",
    heightSource: (await popover.getAttribute("data-height-source")) ?? "",
    method: (await popover.getAttribute("data-pick-method")) ?? "",
    title: visible
      ? ((await page.getByTestId("object-popover-title").textContent()) ?? "")
      : "",
  };
}

/**
 * Sweep the middle of the viewport until the pointer lands on a NAMED building.
 *
 * A grid rather than one fixed point: where a particular building sits on
 * screen depends on the camera, the plate size and the fixture, and a test that
 * hard-codes a pixel is a test that breaks when any of the three moves. 432 of
 * the fixture's 992 buildings carry a name, so a sweep finds one quickly.
 */
async function sweepUntil(
  page: Page,
  popover: Locator,
  want: string,
  accept: (reading: Reading) => boolean,
): Promise<{ reading: Reading; at: { x: number; y: number } }> {
  const box = await page.getByTestId("preview-canvas").boundingBox();
  if (box === null) throw new Error("the preview canvas has no box");
  const seen: string[] = [];
  for (let row = 0; row < 7; row += 1) {
    for (let column = 0; column < 9; column += 1) {
      const x = box.x + box.width * (0.25 + (column / 8) * 0.5);
      const y = box.y + box.height * (0.25 + (row / 6) * 0.5);
      await page.mouse.move(x, y);
      await page.waitForTimeout(SETTLE_MS);
      const reading = await read(popover, page);
      if (reading.visible) seen.push(`${reading.layer}/${reading.named}`);
      if (accept(reading)) return { reading, at: { x, y } };
    }
  }
  throw new Error(
    `no ${want} under a 63-point sweep of the viewport; what was seen: ${
      seen.join(", ") || "nothing at all"
    }`,
  );
}

/** The download directory this spec saves an exported file into. */
const DOWNLOAD_DIR = path.join(process.cwd(), "..", "..", "artifacts", "e2e-objects");

/** The 30-building synthetic scene: the same model, in a fraction of the time. */
async function generateTinyLoop(page: Page): Promise<void> {
  await mockTinyLoopOverpass(page);
  await page.goto("/");
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-canvas")).toBeVisible({ timeout: WARMUP_BUDGET_MS });
  await expect(page.getByTestId("preview-triangles")).toContainText("triangles", {
    timeout: WARMUP_BUDGET_MS,
  });
}

/** `region:version` pairs the viewport is currently showing. */
async function regionVersions(page: Page): Promise<string> {
  return (
    (await page.locator("[data-region-versions]").getAttribute("data-region-versions")) ?? ""
  );
}

/**
 * Open the right-click menu on a real object, and say which one it landed on.
 *
 * The sweep is the hover sweep: where a particular building sits on screen
 * depends on the camera and the fixture, so the point is FOUND (by hovering
 * until the popover names an object) and then right-clicked, rather than
 * hard-coded.
 */
async function inspectABuilding(page: Page): Promise<Reading> {
  const popover = page.getByTestId("object-popover");
  const { reading, at } = await hoverUntilNamedBuilding(page, popover);
  await page.mouse.click(at.x, at.y, { button: "right" });
  await expect(page.getByTestId("object-inspector")).toBeVisible();
  return reading;
}

const hoverUntilNamedBuilding = (page: Page, popover: Locator) =>
  sweepUntil(
    page,
    popover,
    "named building",
    (reading) => reading.visible && reading.layer === "building" && reading.named === "true",
  );

const hoverUntilAnyObject = (page: Page, popover: Locator) =>
  sweepUntil(page, popover, "object of any kind", (reading) => reading.visible);

test("hovering a building names it and says where its height came from", async ({ page }) => {
  await generateChicago(page);
  const popover = page.getByTestId("object-popover");
  await expect(popover).toBeHidden();

  const { reading } = await hoverUntilNamedBuilding(page, popover);

  // The name is an OpenStreetMap name, not a type fallback.
  expect(reading.title.length).toBeGreaterThan(2);
  expect(reading.title).not.toBe("Building");
  // The height source is one the contract allows, and the card says it in words.
  expect(["tag", "levels", "default"]).toContain(reading.heightSource);
  await expect(popover).toContainText(/An OSM height tag|OSM floor count|Estimated from/);
  await expect(popover).toContainText("Height");
  await expect(popover).toContainText("Footprint");
  // Buildings are picked off the real solids' per-triangle owners, not by a
  // nearest-anything search.
  expect(reading.method).toBe("triangle-owner");
});

test("the popover closes when the pointer leaves the model", async ({ page }) => {
  await generateChicago(page);
  const popover = page.getByTestId("object-popover");
  await hoverUntilNamedBuilding(page, popover);
  await expect(popover).toBeVisible();

  const box = await page.getByTestId("preview-canvas").boundingBox();
  if (box === null) throw new Error("the preview canvas has no box");
  // The very top of the viewport is sky above the plate: no pickable geometry,
  // and the model is framed with room around it.
  await page.mouse.move(box.x + box.width * 0.5, box.y + 4);
  await page.waitForTimeout(SETTLE_MS);
  await expect(popover).toBeHidden();
});

test("a camera drag suppresses the popover", async ({ page }) => {
  await generateChicago(page);
  const popover = page.getByTestId("object-popover");
  const { at } = await hoverUntilNamedBuilding(page, popover);
  await expect(popover).toBeVisible();

  // An orbit: press, sweep across the model, release. The pointer stays over
  // pickable geometry the whole way, so anything visible here is the popover
  // chasing the drag.
  await page.mouse.down();
  for (let step = 1; step <= 4; step += 1) {
    await page.mouse.move(at.x + step * 18, at.y + step * 9);
    await page.waitForTimeout(SETTLE_MS);
    await expect(popover, `visible during drag step ${step}`).toBeHidden();
  }
  await page.mouse.up();

  // ...and it comes back afterwards, so the suppression is a suppression and
  // not a break. The camera has moved, so the point it comes back at is found
  // the same way it was found the first time rather than assumed.
  await hoverUntilAnyObject(page, popover);
  await expect(popover).toBeVisible();
});

// ==========================================================================
// Per-object overrides (v3.1 Task 11)
//
// [V3.1-O8]: a feature reaches the user only if a test that reads the USER'S
// OWN surface says so. So each claim below is made twice over -- once against
// the viewport (a region mesh that arrives on screen) and once against the
// bytes of a downloaded file -- from one action taken in the menu itself.
// ==========================================================================

/** The distinctive filament a test picks, so it cannot be mistaken for a default. */
const OVERRIDE_HEX = "#B00020";

/**
 * Give the object under the menu its own filament, in the menu itself.
 *
 * The two halves are independent (`overrideRegionStyle`), so both are set: a
 * slot the printer will load it from, and a colour nothing else on the plate
 * uses, which is what makes the assertion on the exported bytes unambiguous.
 */
async function chooseItsOwnFilament(page: Page): Promise<void> {
  await page.getByTestId("inspector-colour").click();
  await page.getByTestId("override-slot").selectOption("3");
  await page.getByTestId("override-color").fill(OVERRIDE_HEX);
  await page.getByTestId("inspector-back").click();
  await expect(page.getByTestId("object-inspector-summary")).toContainText(/slot 3, own colour/i);
  await page.keyboard.press("Escape");
}

test("a filament chosen in the right-click menu reaches the preview", async ({ page }) => {
  // The full fixture, not the 30-building synthetic one: this test picks its
  // object with a real right-click, and the tiny scene's buildings are a few
  // pixels across on a plate that fills the viewport.
  await generateChicago(page);
  const reading = await inspectABuilding(page);
  expect(reading.layer).toBe("building");

  const before = await regionVersions(page);
  expect(before, "an override region exists before anything asked for one").not.toContain(
    "override_1",
  );

  await chooseItsOwnFilament(page);

  // `data-region-versions` moves the moment a region's mesh is replaced on
  // screen, so an `override_1` entry in it IS the overridden object drawn in
  // its own filament rather than inside `buildings`. The buildings region is
  // rebuilt too: the object left it.
  await expect
    .poll(() => regionVersions(page), { timeout: WARMUP_BUDGET_MS })
    .toContain("override_1");
  expect(await regionVersions(page)).not.toBe(before);
});

test("...and the same choice reaches the exported file", async ({ page }) => {
  // The small scene and the keyboard route, so this test spends its budget on
  // the EXPORT rather than on a second full-fixture build: what it is here to
  // judge is the bytes.
  await generateTinyLoop(page);

  // No settings are touched at all: the default target is the Bambu project,
  // which always writes one object per region whatever `color_mode` says, so
  // the override's own part and the filament it asked for are both readable
  // without moving a control this test is not about.
  await page.getByTestId("preview-canvas").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+F10");
  await expect(page.getByTestId("object-inspector")).toBeVisible();
  await chooseItsOwnFilament(page);
  await expect
    .poll(() => regionVersions(page), { timeout: WARMUP_BUDGET_MS })
    .toContain("override_1");

  // Export is offered only for a model that is current, which is the whole
  // point of the staleness rule; a click before then would be a click on a
  // disabled button.
  await expect(page.getByTestId("export-button")).toBeEnabled({ timeout: WARMUP_BUDGET_MS });
  await page.getByTestId("export-button").click();
  await expect(page.getByTestId("download-links")).toBeVisible({ timeout: WARMUP_BUDGET_MS });

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const started = page.waitForEvent("download", { timeout: WARMUP_BUDGET_MS });
  await page.getByTestId("download-links").locator("a").first().click();
  const download = await started;
  const file = path.join(DOWNLOAD_DIR, download.suggestedFilename());
  await download.saveAs(file);

  const archive = unzipSync(new Uint8Array(fs.readFileSync(file)));
  // The part list: the override is a part of its own, on the extruder the menu
  // chose. The three `<metadata>` lines are written together in that order, so
  // matching across them is what ties THIS part to THAT extruder rather than
  // finding the two facts separately somewhere in the file.
  const settings = strFromU8(archive["Metadata/model_settings.config"]);
  expect(settings, "the exported project has no part for the override").toMatch(
    /key="name" value="override_1"\/>\s*<metadata key="matrix"[^>]*\/>\s*<metadata key="extruder" value="3"/,
  );
  // ...and slot 3's filament is the colour the menu picked.
  const project = JSON.parse(strFromU8(archive["Metadata/project_settings.config"])) as {
    filament_colour: string[];
  };
  expect(
    project.filament_colour[2],
    `slot 3's filament is ${project.filament_colour[2]}, not the colour chosen in the menu`,
  ).toBe(OVERRIDE_HEX);
  console.log(
    `[objects] override_1 exported in ${OVERRIDE_HEX}, ${Math.round(fs.statSync(file).size / 1024)} KiB`,
  );
});

test("the object menu opens on a road from the keyboard, and its width reaches the model", async ({
  page,
}) => {
  await generateChicago(page);

  // Tab reaches the viewport, Page Down walks off the building layer onto the
  // roads, and the readout says where the cursor is. Every one of these is a
  // key press: nothing here is reachable only with a pointer.
  await page.getByTestId("preview-canvas").focus();
  const cursor = page.getByTestId("preview-cursor");
  await page.keyboard.press("PageDown");
  await expect(cursor).toHaveAttribute("data-cursor-layer", "road");
  await expect(cursor).toContainText(/^Road 1 of \d+/);
  await page.keyboard.press("ArrowDown");
  await expect(cursor).toContainText(/^Road 2 of \d+/);

  // Shift+F10 is the context menu, on the object the cursor is on.
  await page.keyboard.press("Shift+F10");
  const menu = page.getByTestId("object-inspector");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute("data-inspector-layer", "road");

  // The roving focus is on a real menu item, and it is marked: a menu whose
  // focused row carries no outline is a menu a keyboard user cannot follow.
  const focused = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const style = active === null ? null : getComputedStyle(active);
    return {
      role: active?.getAttribute("role") ?? "",
      inMenu: active?.closest('[role="menu"]') !== null,
      outline: style === null ? "" : `${style.outlineStyle}/${style.outlineWidth}`,
    };
  });
  expect(focused.inMenu, "focus did not land inside the menu").toBe(true);
  expect(focused.role).toMatch(/^menuitem/);
  expect(focused.outline, "the focused menu item has no visible ring").not.toMatch(/^none/);

  // Arrow to the width view and widen the road. The slider commits on release
  // and on key-up, so one press is one write.
  const before = await regionVersions(page);
  await page.getByTestId("inspector-width_scale").click();
  const width = page.locator("#override-width-scale");
  await expect(width).toBeFocused();
  await width.press("ArrowRight");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // The roads region is rebuilt: the model on screen is the model the override
  // asked for, from a key press alone.
  await expect
    .poll(() => regionVersions(page), { timeout: WARMUP_BUDGET_MS })
    .not.toBe(before);
});

test("an override is one undo step, and the changes counter names it", async ({ page }) => {
  // The small scene, reached by keyboard: no raycast is needed to open the
  // menu on the building the viewport's own cursor is already on, so this test
  // costs a fraction of a full-fixture run and proves the keyboard route to a
  // BUILDING at the same time.
  await generateTinyLoop(page);
  const chip = page.getByTestId("changes-chip");
  const countOf = async (): Promise<number> =>
    Number(/(\d+) changed/.exec((await chip.textContent()) ?? "")?.[1] ?? 0);
  const before = await countOf();

  await page.getByTestId("preview-canvas").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("preview-cursor")).toContainText(/^Building 1 of \d+/);
  await page.keyboard.press("Shift+F10");
  await expect(page.getByTestId("object-inspector")).toHaveAttribute(
    "data-inspector-layer",
    "building",
  );
  await page.getByTestId("inspector-hide").click();
  await expect(page.getByTestId("object-inspector-summary")).toContainText("Hidden");
  await page.keyboard.press("Escape");

  // The settings-diff chip counts it, and its drawer names it: an override is
  // a setting that differs from the contract like any other.
  await expect.poll(countOf).toBe(before + 1);
  await chip.click();
  await expect(page.getByTestId("changes-list")).toContainText("Object overrides");
  await chip.click();

  // The history step names the OBJECT, not just the array: the coalescing key
  // carries the object too, so two buildings hidden in the same second stay two
  // steps instead of folding into one.
  const history = page.getByTestId("history-chip");
  await history.click();
  await expect(page.getByTestId("history-drawer")).toContainText(/Building \S+: hidden/);
  await history.click();

  // ...and one press of undo takes it back off.
  await page.keyboard.press("Control+z");
  await expect.poll(countOf).toBe(before);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(countOf).toBe(before + 1);
});
