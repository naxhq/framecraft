import { expect, test, type Page } from "@playwright/test";

import { mockChicagoOverpass } from "./overpassMock";

/**
 * Perf mode (`?perf=1`, `lib/perf.ts`) end to end.
 *
 * The unit tests pin the recording API; this pins the thing a unit test
 * cannot: that the marks are actually WIRED, in a real browser, across the two
 * realms the pipeline runs in. The engine build and the OSM ingest happen inside
 * Web Workers, and their timings only reach the page because `worker.ts` drains
 * them onto the job result and `client.ts` rebases and merges them. If any link
 * in that chain breaks, the HUD still renders and the console still prints --
 * just without the rows that matter. So the assertions here are on the ROWS and
 * their milliseconds, not on the panel existing.
 *
 * Overpass is route-mocked from the committed Chicago fixture like every other
 * spec in this suite, so the run is offline and deterministic.
 */

const BUDGET_FACTOR = Number(process.env.E2E_BUDGET_FACTOR ?? 1) || 1;
const PREVIEW_BUDGET_MS = 60_000 * BUDGET_FACTOR;
const BUILD_BUDGET_MS = 90_000 * BUDGET_FACTOR;

interface HudRow {
  name: string;
  scope: string;
  ms: number;
}

/** Every row the perf HUD is currently showing, read off its data attributes. */
async function hudRows(page: Page): Promise<HudRow[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="perf-row"]')].map((element) => ({
      name: element.getAttribute("data-perf-name") ?? "",
      scope: element.getAttribute("data-perf-scope") ?? "",
      ms: Number(element.getAttribute("data-perf-ms") ?? "0"),
    })),
  );
}

function rowNamed(rows: HudRow[], name: string): HudRow | undefined {
  return rows.find((row) => row.name === name);
}

function log(message: string): void {
  console.log(`[perf] ${message}`);
}

test.describe.configure({ mode: "serial" });

test("the perf HUD does not exist without ?perf=1", async ({ page }) => {
  await mockChicagoOverpass(page);
  await page.goto("/");
  await expect(page.getByTestId("preset-row")).toBeVisible();
  // Not "hidden": the component returns null, so there is no element at all.
  await expect(page.getByTestId("perf-hud")).toHaveCount(0);
  expect(
    await page.evaluate(() => "__framecraftPerf" in window),
    "perf mode published its window hook without being asked for",
  ).toBe(false);
});

test("?perf=1 times the Overpass round trip, the normalise, the solid build and the export", async ({
  page,
}) => {
  await mockChicagoOverpass(page);
  await page.goto("/?perf=1");

  const hud = page.getByTestId("perf-hud");
  await expect(hud).toBeVisible();
  // Navigation Timing is available before any user action, which is the half of
  // the report that answers "why is the first paint slow".
  await expect(page.getByTestId("perf-navigation")).toBeVisible();

  // ---- a preview: ingest (worker) + engine build (the other worker) --------
  await page.locator('[data-preset-id="chicago-loop"]').click();
  await expect(page.getByTestId("preview-stats")).toBeVisible({ timeout: PREVIEW_BUDGET_MS });
  const statsCard = page.getByTestId("stats-card");
  await expect(statsCard).toContainText("Triangles", { timeout: BUILD_BUDGET_MS });

  await expect
    .poll(async () => (await hudRows(page)).map((row) => row.name), {
      timeout: BUILD_BUDGET_MS,
      message: "the HUD never listed the ingest and build rows",
    })
    .toEqual(expect.arrayContaining(["overpass.fetch", "osm.normalize", "engine.build"]));

  const previewRows = await hudRows(page);
  log(previewRows.map((row) => `${row.name}=${row.ms.toFixed(1)}ms`).join(" "));

  for (const name of ["overpass.fetch", "osm.normalize", "engine.build"]) {
    const row = rowNamed(previewRows, name);
    expect(row, `the HUD has no ${name} row`).toBeDefined();
    expect(row?.ms ?? 0, `${name} reported a non-positive duration`).toBeGreaterThan(0);
    // Both of these are recorded INSIDE an engine worker; a "main" scope here
    // would mean the merge silently fell back to the in-page transport.
    expect(row?.scope, `${name} was not recorded in the worker`).toBe("worker");
  }

  // At least one named step of the solid pipeline, not just the build total.
  const solidRows = previewRows.filter((row) => row.name.startsWith("solid."));
  expect(solidRows.length, "no solid pipeline steps were timed").toBeGreaterThan(0);
  for (const row of solidRows) expect(row.ms).toBeGreaterThanOrEqual(0);
  expect(
    solidRows.reduce((total, row) => total + row.ms, 0),
    "every solid step reported zero",
  ).toBeGreaterThan(0);

  // The structured-clone hop back to the page: only the client can see it.
  const transfer = rowNamed(previewRows, "engine.transfer");
  expect(transfer, "the worker -> page transfer was not measured").toBeDefined();

  // Bundle rows: the load half of the report.
  const resources = page.getByTestId("perf-resource");
  expect(await resources.count(), "no resource rows in the HUD").toBeGreaterThan(0);

  // ---- an export ---------------------------------------------------------
  const exportButton = page.getByTestId("export-button");
  await expect(exportButton).toBeEnabled({ timeout: BUILD_BUDGET_MS });
  await exportButton.click();
  await expect(page.getByTestId("download-links")).toBeVisible({ timeout: BUILD_BUDGET_MS });

  await expect
    .poll(async () => (await hudRows(page)).some((row) => row.name.startsWith("export.")), {
      timeout: BUILD_BUDGET_MS,
      message: "the HUD never listed an export row",
    })
    .toBe(true);

  const exportRows = (await hudRows(page)).filter((row) => row.name.startsWith("export."));
  log(exportRows.map((row) => `${row.name}=${row.ms.toFixed(1)}ms`).join(" "));
  const run = rowNamed(exportRows, "export.run");
  expect(run, "the HUD has no export.run row").toBeDefined();
  expect(run?.ms ?? 0, "export.run reported a non-positive duration").toBeGreaterThan(0);
  // The default target is bambu-3mf, and its writer gets its own row.
  const writer = rowNamed(exportRows, "export.bambu-3mf");
  expect(writer, "the HUD has no per-exporter row").toBeDefined();
  expect(writer?.ms ?? 0).toBeGreaterThan(0);
  // The payload size rides on a mark, so it has no duration but must have bytes.
  const bytes = await page
    .locator('[data-testid="perf-row"][data-perf-name="export.bytes"]')
    .textContent();
  expect(bytes ?? "", "the export payload size was not recorded").toMatch(/[kM]?B/);

  // ---- the Copy button hands over the same block -------------------------
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByTestId("perf-copy").click();
  await expect(page.getByTestId("perf-copy")).toHaveText("Copied");
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain("FrameCraft perf:");
  expect(clipboard).toContain("name\tscope\tcount\tms\tbytes");
  expect(clipboard).toContain("overpass.fetch");
  expect(clipboard).toContain("engine.build");
  expect(clipboard).toContain("export.run");
});
