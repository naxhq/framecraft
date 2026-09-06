import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Refuse to run the suite against a server that is not serving this tree.
 *
 * WHY THIS EXISTS, and why it is a check rather than a comment.
 * `playwright.config.ts` sets `reuseExistingServer: true` unconditionally, and
 * it has to: `make gate` starts the stack itself and health-waits on it before
 * Playwright is launched, so a second `next`/`uvicorn` on the same port would
 * simply fail. The cost is that a bare `npx playwright test` drives WHATEVER is
 * already on the port, builds it never asked for included, and says nothing.
 *
 * That is not hypothetical. On 2026-09-05 a full run reported two failures in
 * `siteperf.spec.ts` against a `:3000` whose `out/` had been built an hour
 * before the fixes under test landed: the served `sw.js` had none of the new
 * code in it. Two people then spent an evening looking for a defect in a
 * kill switch that was already fixed. A gate that can pass or fail on a build
 * nobody asked for is not a gate, and the config comment telling you to build
 * first is exactly what we already had.
 *
 * WHAT IT CHECKS, in the order it checks it.
 *
 *  1. `public/sw.js` is served verbatim by BOTH `next dev` and the static
 *     export, so the bytes on the wire must equal the bytes on disk. This one
 *     needs no mode detection and no timestamps: it is an equality.
 *  2. If the server is serving a static export, it must be THIS `out/` --
 *     the same index.html, byte for byte -- because a run against somebody
 *     else's tree is the same silent failure wearing a different hat.
 *  3. And that `out/` must be newer than every source it is built from. This
 *     is the half that catches an edit to a BUNDLED file: `sw.js` is copied
 *     verbatim so an out-of-date one shows up in check 1, but a stale
 *     `lib/platform.ts` is invisible until its chunk is rebuilt.
 *
 * `next dev` compiles from source per request and cannot be stale, so checks
 * 2 and 3 do not apply to it and are skipped rather than fudged.
 *
 * THE ESCAPE HATCH IS EXPLICIT, which is the whole point:
 * `PLAYWRIGHT_ALLOW_STALE_SERVER=1` skips all of it, for the one legitimate
 * case -- deliberately pointing `PLAYWRIGHT_BASE_URL` at an origin that is not
 * built from this working tree. A check with no way out gets deleted the first
 * time it is inconvenient; a check you have to opt out of by name is one
 * nobody can trip over by accident.
 */

const WEB_ROOT = path.resolve(__dirname, "..");

/** The directories a client bundle is actually built from. */
const SOURCE_DIRS = ["app", "components", "lib", "store", "public", "styles"];

/** Single files that change what the bundle contains. */
const SOURCE_FILES = ["next.config.ts", "package.json", "package-lock.json", "tsconfig.json", "postcss.config.mjs"];

/** Not shipped to the browser, so an edit here cannot make a build stale. */
function isNotBundled(file: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || file.endsWith(".md");
}

interface Newest {
  file: string;
  mtimeMs: number;
}

function newestUnder(root: string, skip: (file: string) => boolean, found: Newest | null = null): Newest | null {
  if (!existsSync(root)) return found;
  let newest = found;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      newest = newestUnder(full, skip, newest);
      continue;
    }
    if (skip(entry.name)) continue;
    const { mtimeMs } = statSync(full);
    if (newest === null || mtimeMs > newest.mtimeMs) newest = { file: full, mtimeMs };
  }
  return newest;
}

/** Line endings only: a checkout or a copy step may rewrite them, and that is not staleness. */
function normalise(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function when(mtimeMs: number): string {
  return new Date(mtimeMs).toISOString().replace("T", " ").slice(0, 19);
}

/*
 * The detail is printed, and the thrown Error is ONE line.
 *
 * Playwright renders a failed `globalSetup` by printing `error.stack`, and an
 * indented line inside a multi-line message comes out formatted as a stack
 * frame -- so the explanation arrives disguised as the internals of the thing
 * that produced it. Printing the body first and throwing a single summary line
 * keeps the message readable and the trace honest about where it came from.
 */
function refuse(baseUrl: string, what: string, detail: string, remedy: string): never {
  const summary = `Stale server: ${baseUrl} is not serving this working tree`;
  console.error(
    [
      "",
      "-".repeat(78),
      `  ${summary.toUpperCase()}`,
      "-".repeat(78),
      "",
      `  ${what}`,
      `  ${detail}`,
      "",
      "  This run would test code nobody asked to test, so it is refusing to start.",
      `  Fix: ${remedy}`,
      "",
      "  Deliberately pointing at an origin built from another tree? Say so by name:",
      "    PLAYWRIGHT_ALLOW_STALE_SERVER=1",
      "-".repeat(78),
      "",
    ].join("\n"),
  );
  /*
   * One artifact, measured rather than papered over. On this Windows host
   * Playwright's teardown after a refused `globalSetup` aborts Node with
   * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and the process
   * exits 127 instead of 1. It happens with `process.exit(1)` here too, so it
   * is the runner's own teardown of the reused-server watcher and not this
   * throw; `throw` is kept because it is the supported shape and lets
   * Playwright clean up what it started. The exit is non-zero either way, so
   * `make gate` fails as it should -- and the block printed above it is what
   * anyone reading the log will actually act on.
   */
  throw new Error(`${summary}. ${what}. Fix: ${remedy}`);
}

/** Status 0 means nothing answered: there is no server to be stale, so there is nothing to check. */
async function get(url: string): Promise<{ status: number; body: string }> {
  try {
    const response = await fetch(url, { headers: { "cache-control": "no-cache" } });
    return { status: response.status, body: response.status === 200 ? await response.text() : "" };
  } catch {
    return { status: 0, body: "" };
  }
}

export default async function assertServerIsFresh(): Promise<void> {
  if (process.env.PLAYWRIGHT_ALLOW_STALE_SERVER === "1") return;

  const baseUrl = (process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

  // 1. The worker, served verbatim in both modes.
  const servedWorker = await get(`${baseUrl}/sw.js`);
  // Nothing is listening: `webServer` is about to start one, and a server this
  // run starts itself cannot be a server this run did not ask for. (Playwright
  // may launch `webServer` before or after this hook depending on version; both
  // orders are handled by treating "no answer" as "nothing to check".)
  if (servedWorker.status === 0) return;
  const diskWorker = readFileSync(path.join(WEB_ROOT, "public", "sw.js"), "utf-8");
  if (servedWorker.status !== 200 || normalise(servedWorker.body) !== normalise(diskWorker)) {
    refuse(
      baseUrl,
      "the served /sw.js is not apps/web/public/sw.js",
      servedWorker.status === 200
        ? "same path, different bytes: the server is running an older copy"
        : `the server answered ${String(servedWorker.status)} for it`,
      "restart the server, or rebuild it: cd apps/web && npm run build",
    );
  }

  // Static export or `next dev`? The export ships a real /404.html; the dev
  // server answers 404 for that path, because it has no such route.
  const notFoundPage = await get(`${baseUrl}/404.html`);
  if (notFoundPage.status !== 200) return; // `next dev`: compiled per request, never stale.

  const outDir = path.join(WEB_ROOT, "out");
  const indexPath = path.join(outDir, "index.html");
  if (!existsSync(indexPath)) return; // A static server on some other tree, and no local export to compare it to.

  // 2. It must be THIS export.
  const servedIndex = await get(`${baseUrl}/`);
  if (normalise(servedIndex.body) !== normalise(readFileSync(indexPath, "utf-8"))) {
    refuse(
      baseUrl,
      "the served page is not apps/web/out/index.html",
      "a static export is being served, and it is not the one in this tree",
      "point the run at this tree's export, or rebuild and restart it",
    );
  }

  // 3. And it must be newer than what it was built from.
  const newestBuilt = newestUnder(outDir, () => false);
  if (newestBuilt === null) return;
  let newestSource: Newest | null = null;
  for (const dir of SOURCE_DIRS) newestSource = newestUnder(path.join(WEB_ROOT, dir), isNotBundled, newestSource);
  for (const file of SOURCE_FILES) {
    const full = path.join(WEB_ROOT, file);
    if (!existsSync(full)) continue;
    const { mtimeMs } = statSync(full);
    if (newestSource === null || mtimeMs > newestSource.mtimeMs) newestSource = { file: full, mtimeMs };
  }
  if (newestSource !== null && newestSource.mtimeMs > newestBuilt.mtimeMs) {
    refuse(
      baseUrl,
      `${path.relative(WEB_ROOT, newestSource.file)} changed at ${when(newestSource.mtimeMs)}`,
      `and apps/web/out was built at ${when(newestBuilt.mtimeMs)} -- the bundle under test predates the source`,
      "cd apps/web && npm run build",
    );
  }
}
