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
 * FRAMECRAFT_WEB_MODE=prod serves the production build (`next build && next
 * start`) instead of `next dev`, mirroring the same switch in `make up`.
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
  // can fail on a SKIPPED test. Playwright exits 0 on a skip, and the only skip
  // in this suite (A2 when Overpass is unreachable) is exactly the case where
  // the gate must not print GATE PASS.
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
      command: PROD_WEB ? "npm run build && npm run start" : "npm run dev",
      cwd: path.join(REPO_ROOT, "apps", "web"),
      url: WEB_URL,
      reuseExistingServer: true,
      timeout: 300_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
