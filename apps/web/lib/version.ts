/**
 * Who made this build, which build it is, and under what terms.
 *
 * Every identity string the product shows -- product name, version, commit,
 * build date, copyright holder, repository and licence links -- is declared
 * here once and read from here by the footer (`components/editor/SiteFooter`),
 * the About dialog (`components/editor/AboutDialog`) and anything else that
 * needs to name the build. Nothing in this file is hand-maintained: the
 * version comes from `apps/web/package.json`, the commit from git, and both
 * are inlined at build time by `next.config.ts` from `scripts/version.mjs`,
 * which is also what stamps the three desktop manifests. One source, three
 * surfaces.
 *
 * The desktop shell has no version of its own. It renders this same bundle,
 * so its About dialog reads these same constants, and `Cargo.toml` /
 * `tauri.conf.json` are stamped from the web package rather than edited by
 * hand (`scripts/stamp-version.mjs`, pinned by `version.test.ts`).
 */

/**
 * What the app is called. Not derived from the package name (`framecraft-web`)
 * on purpose: the package is an implementation detail and the product name is
 * a brand.
 */
export const PRODUCT_NAME = "FrameCraft";

/** The copyright holder, identical in LICENSE, README, the footer, the About dialog and the installer metadata. */
export const COPYRIGHT_HOLDER = "NAXHQ";

/** The year the copyright line carries. Stays put when the version moves: it is the year of first publication, not of this build. */
export const COPYRIGHT_YEAR = "2026";

export const REPOSITORY_URL = "https://github.com/naxhq/framecraft";

export const LICENCE_NAME = "MIT";

export const LICENCE_URL = `${REPOSITORY_URL}/blob/main/LICENSE`;

/** The OSM credit, a licence obligation rather than a courtesy; the same string the exporters engrave and write into file metadata. */
export const OSM_CREDIT = "© OpenStreetMap contributors";

/**
 * What a build with no commit id shows.
 *
 * Mirrors `scripts/version.mjs:NO_COMMIT_LABEL`; the two are checked against
 * each other in `version.test.ts` so a rewording in one cannot drift from the
 * other.
 */
export const NO_COMMIT_LABEL = "source build";

/**
 * The version a bundle reports when nothing inlined one.
 *
 * Only reachable outside a Next build -- vitest, or a stray `node` import --
 * because `next.config.ts` sets the three variables below for `next dev` and
 * `next build` alike. It is deliberately not a plausible release number: if
 * this ever shows up in a screenshot, the answer is "this was not built", not
 * "this is version 0".
 */
export const UNBUILT_VERSION = "0.0.0-unbuilt";

export interface BuildInfo {
  /** Semver, from `apps/web/package.json`. */
  readonly version: string;
  /** Short git sha, or the empty string when the build had no git and no override. */
  readonly commit: string;
  /** Full ISO 8601 instant, UTC. */
  readonly buildDate: string;
}

/**
 * This build, resolved.
 *
 * A FUNCTION, not a module-level constant, and that matters in exactly one
 * place. The three reads are written out as complete `process.env.NEXT_PUBLIC_*`
 * expressions because that literal form is what Next's bundler substitutes, and
 * a substituted literal reads the same inside a function as outside it -- so
 * the browser and the desktop shell are unaffected either way. What the
 * function buys is Node: `scripts/export-cli.ts` produces the files CI hands to
 * the Python validator, and there is no bundler there to inline anything, so it
 * sets the variable itself at startup (`scripts/stamp-version-env.mjs`). A
 * constant would have been read before that assignment could happen.
 *
 * Under vitest neither path applies and every call returns
 * `UNBUILT_VERSION`, which is deliberate: it keeps the byte-pinned export
 * goldens (`lib/engine/export/tiles.test.ts`) stable across version bumps
 * instead of turning every release into a golden re-pin.
 */
export function buildInfo(): BuildInfo {
  return {
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? UNBUILT_VERSION,
    commit: process.env.NEXT_PUBLIC_COMMIT_SHA ?? "",
    buildDate: process.env.NEXT_PUBLIC_BUILD_DATE ?? "",
  };
}

/** The version alone, for anything that needs it without the rest (export metadata, file headers). */
export function appVersion(): string {
  return buildInfo().version;
}

/** `FrameCraft 3.1.0`. */
export function productLabel(info: BuildInfo = buildInfo()): string {
  return `${PRODUCT_NAME} ${info.version}`;
}

/** The commit, or the words that say there is not one. Never an invented sha. */
export function commitLabel(info: BuildInfo = buildInfo()): string {
  return info.commit === "" ? NO_COMMIT_LABEL : info.commit;
}

/**
 * The build date as a calendar day, `2026-09-03`.
 *
 * Day resolution, not the instant: the instant is in the file for anyone who
 * wants it, and a footer that changes every time a developer rebuilds is noise
 * in every screenshot and every visual diff. An unparseable or missing value
 * yields the empty string rather than "Invalid Date".
 */
export function buildDateLabel(info: BuildInfo = buildInfo()): string {
  if (info.buildDate === "") return "";
  const parsed = new Date(info.buildDate);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

/** `© 2026 NAXHQ`. */
export function copyrightLine(): string {
  return `© ${COPYRIGHT_YEAR} ${COPYRIGHT_HOLDER}`;
}

/**
 * One line naming the build: `FrameCraft 3.1.0 · a1b2c3d4e5f6 · 2026-09-03`.
 *
 * The separator is a middle dot rather than a dash so the line still reads
 * when the commit is the words `source build`.
 */
export function buildStamp(info: BuildInfo = buildInfo()): string {
  const date = buildDateLabel(info);
  return [productLabel(info), commitLabel(info), date].filter((part) => part !== "").join(" · ");
}
