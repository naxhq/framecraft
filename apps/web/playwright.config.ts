import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the P5 gate (`make gate`).
 *
 * The specs under ./e2e drive the REAL stack -- no route mocking, no fixtures:
 * next on :3000 talking to the FastAPI reference service (`services/bake`) on :8000, which talks to
 * the committed Overpass fixtures. That is the only way the smoke test can
 * prove 01's acceptance criteria end to end.
 *
 * Lifecycle: `make gate` brings the stack up (`make up`) before it runs the
 * e2e and takes it down afterwards, so `reuseExistingServer` is ALWAYS true --
 * a second uvicorn/next on the same port would fail anyway. When the stack is
 * down (a developer running `npx playwright test` on its own) the two entries
 * below start exactly what `make up`'s native path starts. They are spelled out
 * here rather than as `make up` because Playwright's webServer needs a process
 * that stays in the foreground, and it spawns through the platform shell --
 * cmd.exe on this Windows host, which does not have `make` on PATH.
 *
 * FRAMECRAFT_WEB_MODE=prod serves the production build (`next build`, then
 * the exported `out/` tree through `scripts/serve-static.mjs`; `output:
 * "export"` retired `next start`) instead of `next dev`, mirroring the same
 * switch in `make up`.
 *
 * ---------------------------------------------------------------------------
 * ORDER OF OPERATIONS -- read this before running the two together
 * ---------------------------------------------------------------------------
 *
 * `next build` and `next dev` share ONE directory, `apps/web/.next`. There is
 * no per-run dist dir, so they cannot be run at the same time and a build does
 * not leave a tree a dev server can serve. A dev server started on a `.next`
 * a build just wrote has to recompile it, and until it has, a request gets:
 *
 *   [WebServer] Error: Cannot find module .../.next/server/app/page.js
 *   [WebServer]  ⚠ Fast Refresh had to perform a full reload due to a runtime error
 *
 * and that full reload is counted by `smoke.spec.ts`'s `watchNavigations`, so
 * 01/A3's "no page reload on a PrintParams change" would fail with an
 * off-by-one navigation count that has nothing to do with the code under test.
 *
 * What actually decides it is WHO waits for the recompile:
 *
 *   * `npm run build` then `npm run test:e2e` **on its own** is the unsafe one.
 *     The `webServer` below starts `next dev` and Playwright begins driving it
 *     as soon as the port answers, i.e. during the recompile.
 *   * `make gate` does **not** do that. It runs `npm run build` (step 3), then
 *     `make up` (step 5), which starts `next dev` and then health-waits on
 *     `curl http://localhost:3000` for up to 120 s before Playwright is
 *     launched at all -- so the recompile happens inside the wait. Measured on
 *     this host, immediately after a `next build`: `✓ Compiled / in 1612ms`,
 *     `GET / 200`, and zero `Cannot find module` / `full reload` lines in
 *     `artifacts/logs/web.log` across the whole 4-minute suite ([V2-P7-fix]).
 *     `reuseExistingServer` then keeps this config's `webServer` out of it.
 *
 * Safe orders, pick one:
 *
 *   1. `npm run test:e2e` on its own, on a tree no build has touched since. It
 *      starts and stops what it needs.
 *   2. `npm run build`, then `make up` (which waits), then `npm run test:e2e`
 *      -- this is `make gate`'s order.
 *   3. `npm run build`, then `rm -rf .next`, then `npm run test:e2e`.
 *   4. `npm run build`, then `FRAMECRAFT_WEB_MODE=prod npm run test:e2e`, which
 *      serves the build instead of racing it.
 *
 * And never run `next build` while any dev server is alive -- including one
 * another person or another agent started on this host (DECISIONS [P4]).
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WEB_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const API_URL = process.env.NEXT_PUBLIC_BAKE_API_URL ?? "http://localhost:8000";
const PROD_WEB = process.env.FRAMECRAFT_WEB_MODE === "prod";

export default defineConfig({
  testDir: "./e2e",
  /*
   * `reuseExistingServer` below is ALWAYS true, for the reason spelled out
   * there, and the price is that a bare `npx playwright test` drives whatever
   * is already on the port -- including a build from before the change under
   * test. That happened on 2026-09-05 and cost an evening: two `siteperf`
   * tests reported as broken were running against an `out/` built an hour
   * before the fixes landed. The comment above ("safe orders, pick one") is
   * what we had, and it is not enough, so the order is now CHECKED. See
   * `e2e/serverFreshness.ts` for what it compares and how to opt out.
   */
  globalSetup: path.join(__dirname, "e2e", "serverFreshness.ts"),
  // One stack, one browser: the specs share a live server and a build queue.
  fullyParallel: false,
  workers: 1,
  // A gate does not get to be flaky-tolerant: a retry would hide a real defect.
  retries: 0,
  // A cold Chicago build is ~11 s and 04/A4 allows 90 s; a rotation change at a
  // non-preset angle is a live Overpass query on top of that.
  timeout: 300_000,
  expect: { timeout: 15_000 },
  // `list` for the human reading artifacts/logs/gate.log; `json` so `make gate`
  // can fail on a SKIPPED test. Playwright exits 0 on a skip, so without the
  // JSON reporter a suite that ran nothing would print GATE PASS.
  //
  // As of V2-P7 this suite contains no skip at all -- not even a conditional
  // one -- and `make gate` enforces that twice over: statically (no
  // skip/only/todo/fixme marker may be committed in any spec) and at runtime
  // (`results.json` `stats.skipped` must be 0). The last conditional skip was
  // A2's "Overpass is unreachable from this host", which is now a plain failing
  // assertion carrying the same diagnosis: the gate could never have accepted
  // it, so a skip only changed the wording.
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(REPO_ROOT, "artifacts", "e2e", "results.json") }],
  ],
  outputDir: path.join(REPO_ROOT, "artifacts", "e2e", "test-results"),
  use: {
    baseURL: WEB_URL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    // The r3f preview needs WebGL; headless Chromium has no GPU here and
    // Chrome now requires this flag before it will fall back to SwiftShader.
    launchOptions: {
      args: ["--enable-unsafe-swiftshader", "--disable-dev-shm-usage"],
    },
  },
  // Two projects over the SAME browser and the same specs. They differ only in
  // which titles they select, and neither is a default: `npm run test:e2e`
  // names `chromium` and `npm run test:e2e:smoke` names `chromium-smoke`, so a
  // bare `playwright test` is the only way to get both and nothing in the repo
  // does that.
  //
  //   chromium        every test. `make gate`, `make gate-nightly` and
  //                   nightly.yml's `e2e-full` run this one.
  //   chromium-smoke  the `@smoke` grep, which is what the required CI job and
  //                   `make gate-fast` run.
  //
  // Run `--project=chromium-smoke --list` for the count; that is the only
  // number worth trusting, because the tag grows with the waves (three titles
  // at v3-14, six after the pipeline and action-bar work, seven once
  // actionbar.spec.ts joined) and every total quoted in a comment goes stale.
  //
  // Measured on this host at E2E_BUDGET_FACTOR=3, from a full-suite run of the
  // v3.1 Wave 3 tree against the production build (12.8 min for all 71 tests):
  //
  //   42.4 s  the small-scene validator round trip: preset -> preview ->
  //           export -> download -> `uv run python -m app.cli validate` says
  //           ALL CHECKS PASS. The only tagged test whose bytes are judged by
  //           the reference validator rather than by the browser alone. It was
  //           6.2 s when this split was designed; the pipeline rework is where
  //           the rest went, and nothing has re-measured why.
  //   28.7 s  a lettering change reaches the model inside the interaction
  //           budget.
  //   26.2 s  a settings change keeps the model on screen, dimmed, under a
  //           stage overlay.
  //   15.8 s  Stop during a plate resize leaves the previous model on screen.
  //    2.1 s  the Bambu Studio project export, a SECOND target through the
  //           same UI, checked region by region for its own extruder.
  //    1.0 s  the empty-Overpass path: warn, and disable Export.
  //
  // That is 1 m 56 s for those six, against the 11.5 s this block used to
  // describe, and it does not include the tagged test in `actionbar.spec.ts`,
  // which landed after that run and has not been timed here.
  // The required job has a ten-minute timeout and GitHub's runners
  // are 2.2x to 3.7x slower than this host, which projects to 4 to 7 minutes
  // of tests before checkout, npm ci, the browser install and the dev server.
  // The tag needs pruning or the job needs a longer budget; whoever owns CI
  // should decide which. See docs/handoff/v3-06-actionbar.md.
  //
  // NOT tagged, deliberately: "happy path: Chicago preset previews, sliders
  // stay local, export downloads a 3MF". It is the most representative test
  // in the file and it is also 2.2 MINUTES here, because it builds all 992
  // Chicago buildings, measures a slider-driven frame rate and nudges the
  // rotation twice. GitHub's runners have no GPU and fall back to SwiftShader,
  // where the whole suite runs 2.2x to 3.7x slower than on this host, so that
  // one test alone projects to 5 to 8 minutes and would spend the entire
  // required-path budget. Full-Chicago geometry is not lost from the fast
  // path: the `build-and-validate` job exports the same 992-building fixture
  // twice through `export:cli` and the Python validator judges both files.
  // The UI-side happy path runs nightly. See docs/handoff/v3-14-ci.md.
  //
  // A tag is a SELECTOR, never a licence to run less: every test outside the
  // grep still runs, nightly and in the local full gate, and the zero-skip and
  // zero-expected-failure guards apply to both projects. `--grep` filters at
  // collection, so an unselected test is absent from results.json rather than
  // reported as skipped -- which is why the smoke job additionally asserts
  // that the grep selected something, a check the full project does not need.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "chromium-smoke", use: { ...devices["Desktop Chrome"] }, grep: /@smoke/ },
  ],
  webServer: [
    {
      command: "uv run uvicorn app.main:app --host 127.0.0.1 --port 8000",
      cwd: path.join(REPO_ROOT, "services", "bake"),
      url: `${API_URL}/health`,
      reuseExistingServer: true,
      timeout: 180_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      // `output: "export"` (v3 P8) retired `next start`; prod mode now serves
      // the exported `out/` tree the way GitHub Pages / Tauri will.
      command: PROD_WEB
        ? "npm run build && node scripts/serve-static.mjs --dir out --port 3000"
        : "npm run dev",
      cwd: path.join(REPO_ROOT, "apps", "web"),
      url: WEB_URL,
      reuseExistingServer: true,
      timeout: 300_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
