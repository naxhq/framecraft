import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the P5 gate (`make gate`).
 *
 * The specs under ./e2e drive the REAL stack -- no route mocking, no fixtures:
 * next on :3000 talking to the FastAPI bake service on :8000, which talks to
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
  // One stack, one browser: the specs share a live server and a bake queue.
  fullyParallel: false,
  workers: 1,
  // A gate does not get to be flaky-tolerant: a retry would hide a real defect.
  retries: 0,
  // A cold Chicago bake is ~11 s and 04/A4 allows 90 s; a rotation change at a
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
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
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
