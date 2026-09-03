import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { NO_COMMIT_LABEL, UNBUILT_VERSION } from "../lib/version";

/**
 * What the build says it is, on a page a browser actually rendered
 * (DECISIONS `[V3.1-P15-5]`).
 *
 * Task 15's identity strings were covered only by `lib/version.test.ts` and
 * `components/editor/SiteFooter.test.tsx`, and both render through
 * `renderToStaticMarkup` in a plain Node process. Nothing inlines
 * `NEXT_PUBLIC_APP_VERSION` there, so `buildInfo().version` is always
 * `UNBUILT_VERSION` in those tests: they prove the footer renders A version and
 * can say nothing about whether a shipped page shows a REAL one. The stamp is
 * single-sourced from `apps/web/package.json` through `next.config.ts`, which
 * was proved by bumping that file and watching `stamp-version.mjs --check`
 * fail; this is the other end of the same claim, and the only end a user sees.
 *
 * So the assertions here are the ones only a served page can make:
 *
 *  1. the footer's stamp is the version in `package.json`, not the placeholder;
 *  2. the About dialog opens, and its Version row says the same thing, which is
 *     what "one source, three surfaces" means when it is true;
 *  3. the commit is either a real short sha or the documented label for a build
 *     with no git, never empty and never a plausible-looking invention;
 *  4. the copyright holder and the OSM credit are on the dialog, because both
 *     are obligations rather than decoration.
 *
 * No Overpass mock and no model: nothing here builds anything, which is what
 * keeps it cheap enough to be worth running on every full suite.
 */

const PACKAGE_VERSION: string = (
  JSON.parse(readFileSync(path.resolve(__dirname, "..", "package.json"), "utf-8")) as {
    version: string;
  }
).version;

/** A short commit as `scripts/version.mjs` writes it: lower-case hex. */
const SHORT_COMMIT = /^[0-9a-f]{7,40}$/;

test("the footer and the About dialog agree on a real version, on a served page", async ({
  page,
}) => {
  await page.goto("/");

  const stamp = page.getByTestId("about-button");
  await expect(stamp).toBeVisible();

  // The placeholder is deliberately not a plausible release number, so a page
  // that was never built through `next.config.ts` fails here rather than
  // shipping a screenshot of "0.0.0-unbuilt".
  await expect(stamp).not.toContainText(UNBUILT_VERSION);
  await expect(stamp).toContainText(PACKAGE_VERSION);

  await stamp.click();
  const dialog = page.getByTestId("about-dialog");
  await expect(dialog).toBeVisible();

  const version = dialog.locator('[data-about-row="version"] dd');
  await expect(version).toHaveText(PACKAGE_VERSION);

  const commit = await dialog.locator('[data-about-row="commit"] dd').innerText();
  expect(commit.trim().length, "the commit row is empty").toBeGreaterThan(0);
  expect(
    SHORT_COMMIT.test(commit.trim()) || commit.trim() === NO_COMMIT_LABEL,
    `the commit row reads ${JSON.stringify(commit)}, which is neither a short sha nor ${JSON.stringify(NO_COMMIT_LABEL)}`,
  ).toBe(true);

  const built = await dialog.locator('[data-about-row="built"] dd').innerText();
  expect(built.trim().length, "the built row is empty").toBeGreaterThan(0);

  await expect(dialog.getByTestId("about-copyright")).toContainText("NAXHQ");
  await expect(dialog.getByTestId("about-copyright")).toContainText("MIT");
  await expect(dialog.getByTestId("about-attribution")).toContainText(
    "© OpenStreetMap contributors",
  );

  await dialog.getByTestId("about-dialog-close").click();
  await expect(dialog).toBeHidden();
});
