/**
 * The ONE place FrameCraft's version, commit and build date are decided.
 *
 * Three consumers read this module and nothing else:
 *
 *   - `next.config.ts`, which inlines the answers into the web bundle as
 *     `NEXT_PUBLIC_APP_VERSION` / `NEXT_PUBLIC_COMMIT_SHA` /
 *     `NEXT_PUBLIC_BUILD_DATE` (and reuses the commit for the service
 *     worker's `NEXT_PUBLIC_BUILD_ID`);
 *   - `scripts/stamp-version.mjs`, which copies the version into the three
 *     desktop manifests (`apps/desktop/package.json`,
 *     `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`);
 *   - `lib/version.test.ts`, which pins both of the above.
 *
 * `apps/web/package.json`'s `version` field is the source. The desktop shell
 * does not get a version of its own: it renders the same bundle, so its About
 * dialog reads the same inlined constants the web footer does, and its
 * installer metadata is stamped from here rather than hand-maintained.
 *
 * Written as `.mjs` with no dependencies because it has to run in three very
 * different contexts: inside Next's config loader, as a bare `node` script,
 * and under vitest.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `apps/web`, the package whose `version` is the product's version. */
export const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `apps/`, the parent of both `web` and `desktop`. */
export const APPS_ROOT = join(WEB_ROOT, "..");

/**
 * What a build with no git and no override reports as its commit.
 *
 * The empty string, not a fake sha: a tarball build genuinely does not know
 * which commit it came from, and inventing something sha-shaped would make an
 * unanswerable question look answered. Every display path turns the empty
 * string into the words `NO_COMMIT_LABEL` says.
 */
export const NO_COMMIT = "";

/** What the UI shows in place of a commit when there is none. */
export const NO_COMMIT_LABEL = "source build";

/** Short shas are 12 hex digits here, matching the service worker's build id. */
export const COMMIT_LENGTH = 12;

/**
 * Read `version` out of `apps/web/package.json`.
 *
 * Throws rather than defaulting: a build that cannot read its own version has
 * a broken checkout, and shipping "0.0.0" would hide that behind a plausible
 * looking number.
 *
 * @param {string} [root]
 * @returns {string}
 */
export function readPackageVersion(root = WEB_ROOT) {
  const manifestPath = join(root, "package.json");
  const raw = readFileSync(manifestPath, "utf-8");
  const version = JSON.parse(raw).version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${manifestPath} has no usable "version" field (read ${JSON.stringify(version)})`);
  }
  return version;
}

/**
 * Ask git for the short sha of HEAD, or `NO_COMMIT` when git cannot answer.
 *
 * Every failure mode collapses to the same answer on purpose: git missing from
 * PATH, a checkout that is not a repository (the tarball case), a repository
 * with no commits yet, and a git that exits non-zero are all "this build does
 * not know its commit", and none of them may fail a build.
 *
 * @param {string} [cwd]
 * @returns {string}
 */
export function readGitCommit(cwd = WEB_ROOT) {
  try {
    const out = execFileSync("git", ["rev-parse", `--short=${COMMIT_LENGTH}`, "HEAD"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{7,40}$/.test(out) ? out : NO_COMMIT;
  } catch {
    return NO_COMMIT;
  }
}

/**
 * The commit this build came from.
 *
 * Order, and why: an explicit `FRAMECRAFT_COMMIT_SHA` wins so a release
 * pipeline can pin exactly what it is shipping; `GITHUB_SHA` is next because
 * every GitHub runner sets it and it is right even in a checkout git itself
 * would answer for; then git; then nothing. `git` is injected so the "no git"
 * path is a test rather than a story about a machine without git installed.
 *
 * @param {{env?: Record<string, string | undefined>, git?: () => string}} [deps]
 * @returns {string}
 */
export function resolveCommit(deps = {}) {
  const { env = process.env, git = readGitCommit } = deps;
  const pinned = env.FRAMECRAFT_COMMIT_SHA ?? env.NEXT_PUBLIC_COMMIT_SHA ?? env.GITHUB_SHA ?? "";
  if (pinned !== "") return pinned.trim().slice(0, COMMIT_LENGTH).toLowerCase();
  return git();
}

/**
 * When this build was made, as a full ISO 8601 instant in UTC.
 *
 * `SOURCE_DATE_EPOCH` is honoured (it is the cross-ecosystem convention for a
 * reproducible build's timestamp, in seconds), and `FRAMECRAFT_BUILD_DATE`
 * overrides everything so a pipeline can stamp the release moment rather than
 * the moment a runner happened to compile.
 *
 * @param {{env?: Record<string, string | undefined>, now?: () => Date}} [deps]
 * @returns {string}
 */
export function resolveBuildDate(deps = {}) {
  const { env = process.env, now = () => new Date() } = deps;
  const pinned = env.FRAMECRAFT_BUILD_DATE ?? env.NEXT_PUBLIC_BUILD_DATE ?? "";
  if (pinned !== "") {
    const parsed = new Date(pinned);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const epoch = env.SOURCE_DATE_EPOCH ?? "";
  if (/^\d+$/.test(epoch)) return new Date(Number(epoch) * 1000).toISOString();
  return now().toISOString();
}

/**
 * Everything the footer, the About dialog and the desktop manifests need,
 * resolved once.
 *
 * @param {{root?: string, env?: Record<string, string | undefined>, git?: () => string, now?: () => Date}} [deps]
 * @returns {{version: string, commit: string, buildDate: string}}
 */
export function versionInfo(deps = {}) {
  const { root = WEB_ROOT, env = process.env, git, now } = deps;
  return {
    version: readPackageVersion(root),
    commit: resolveCommit({ env, git: git ?? (() => readGitCommit(root)) }),
    buildDate: resolveBuildDate({ env, now }),
  };
}
