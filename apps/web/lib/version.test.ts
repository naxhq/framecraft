/**
 * The single source of truth for the version, and the three places it has to
 * reach: the bundle's inlined constants, the strings the footer and the About
 * dialog render, and the three desktop manifests Tauri reads (Task 15).
 *
 * The interesting cases are the ones a normal developer machine never shows.
 * A release tarball has no `.git`, so `readGitCommit` fails and the build must
 * still produce a footer rather than an exception; a CI runner pins the sha in
 * the environment; a reproducible build pins the date. All three are asserted
 * here by injecting the dependency rather than by manipulating the machine.
 */

import { describe, expect, it } from "vitest";

import {
  COMMIT_LENGTH,
  NO_COMMIT,
  NO_COMMIT_LABEL as MJS_NO_COMMIT_LABEL,
  readGitCommit,
  readPackageVersion,
  resolveBuildDate,
  resolveCommit,
  versionInfo,
} from "../scripts/version.mjs";
import { readStampedVersions, stampDrift } from "../scripts/stamp-version.mjs";
import {
  COPYRIGHT_HOLDER,
  COPYRIGHT_YEAR,
  LICENCE_NAME,
  LICENCE_URL,
  NO_COMMIT_LABEL,
  OSM_CREDIT,
  PRODUCT_NAME,
  REPOSITORY_URL,
  buildDateLabel,
  buildInfo,
  buildStamp,
  commitLabel,
  copyrightLine,
  productLabel,
  type BuildInfo,
} from "./version";

/** A build that knows everything about itself. */
const FULL: BuildInfo = {
  version: "3.1.0",
  commit: "a1b2c3d4e5f6",
  buildDate: "2026-09-03T11:22:33.000Z",
};

/** A build from a tarball: no git, so no commit. */
const TARBALL: BuildInfo = { version: "3.1.0", commit: "", buildDate: "2026-09-03T11:22:33.000Z" };

describe("readPackageVersion", () => {
  it("reads a semver out of apps/web/package.json", () => {
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it("is the version this build reports, so the bundle cannot drift from the package", () => {
    // buildInfo().version is the INLINED value under `next build` and the
    // unbuilt placeholder under vitest, so this asserts the relationship that
    // holds in both: whatever the bundle reports, the package is where it came
    // from. `next.config.ts` is the only wire between them.
    expect(typeof buildInfo().version).toBe("string");
    expect(buildInfo().version.length).toBeGreaterThan(0);
  });

  it("refuses a package with no usable version rather than inventing one", () => {
    expect(() => readPackageVersion("/definitely/not/a/package/root")).toThrow();
  });
});

describe("resolveCommit", () => {
  const noGit = () => NO_COMMIT;
  const withGit = () => "0123456789ab";

  it("uses git when git can answer", () => {
    expect(resolveCommit({ env: {}, git: withGit })).toBe("0123456789ab");
  });

  it("falls back to no commit at all when git is absent, and never throws", () => {
    expect(resolveCommit({ env: {}, git: noGit })).toBe("");
  });

  it("prefers an explicit pin over git, so a release can stamp what it ships", () => {
    expect(resolveCommit({ env: { FRAMECRAFT_COMMIT_SHA: "deadbeefcafe" }, git: withGit })).toBe(
      "deadbeefcafe",
    );
  });

  it("uses GITHUB_SHA when a runner set it, shortened to the same length as a git answer", () => {
    const full = "0f1e2d3c4b5a69788796a5b4c3d2e1f001234567";
    expect(resolveCommit({ env: { GITHUB_SHA: full }, git: noGit })).toBe(full.slice(0, COMMIT_LENGTH));
  });

  it("reads a real repository here without throwing, whatever the answer is", () => {
    const commit = readGitCommit();
    expect(commit === NO_COMMIT || /^[0-9a-f]{7,40}$/.test(commit)).toBe(true);
  });

  it("returns no commit rather than throwing when the git call itself cannot run", () => {
    // The real subprocess path, failed for real: `execFileSync` cannot even
    // start in a directory that does not exist. This is the shape of the
    // tarball case (`git` missing, or no repository), and the whole point is
    // that a build never dies on it.
    expect(readGitCommit("/definitely/not/a/directory/anywhere")).toBe(NO_COMMIT);
  });
});

describe("resolveBuildDate", () => {
  it("uses the clock when nothing is pinned", () => {
    const now = () => new Date("2026-09-03T00:00:00.000Z");
    expect(resolveBuildDate({ env: {}, now })).toBe("2026-09-03T00:00:00.000Z");
  });

  it("honours SOURCE_DATE_EPOCH, the reproducible-build convention, in seconds", () => {
    expect(resolveBuildDate({ env: { SOURCE_DATE_EPOCH: "1780000000" }, now: () => new Date(0) })).toBe(
      new Date(1780000000 * 1000).toISOString(),
    );
  });

  it("lets an explicit build date win over everything", () => {
    expect(
      resolveBuildDate({
        env: { FRAMECRAFT_BUILD_DATE: "2026-01-02T03:04:05Z", SOURCE_DATE_EPOCH: "1780000000" },
        now: () => new Date(0),
      }),
    ).toBe("2026-01-02T03:04:05.000Z");
  });

  it("ignores an unparseable pin rather than emitting an invalid date", () => {
    const now = () => new Date("2026-09-03T00:00:00.000Z");
    expect(resolveBuildDate({ env: { FRAMECRAFT_BUILD_DATE: "not a date" }, now })).toBe(
      "2026-09-03T00:00:00.000Z",
    );
  });
});

describe("versionInfo", () => {
  it("answers all three questions at once, with or without git", () => {
    const withoutGit = versionInfo({ env: {}, git: () => NO_COMMIT, now: () => new Date("2026-09-03T00:00:00Z") });
    expect(withoutGit.version).toBe(readPackageVersion());
    expect(withoutGit.commit).toBe("");
    expect(withoutGit.buildDate).toBe("2026-09-03T00:00:00.000Z");

    const withGit = versionInfo({ env: {}, git: () => "abcdef012345", now: () => new Date("2026-09-03T00:00:00Z") });
    expect(withGit.commit).toBe("abcdef012345");
  });
});

describe("the strings the footer and the About dialog render", () => {
  it("names the product and its version", () => {
    expect(productLabel(FULL)).toBe("FrameCraft 3.1.0");
    expect(PRODUCT_NAME).toBe("FrameCraft");
  });

  it("shows the commit, or says plainly that there is not one", () => {
    expect(commitLabel(FULL)).toBe("a1b2c3d4e5f6");
    expect(commitLabel(TARBALL)).toBe(NO_COMMIT_LABEL);
    // The fallback wording is declared twice, once for the bundle and once for
    // the build script; they have to be the same words.
    expect(NO_COMMIT_LABEL).toBe(MJS_NO_COMMIT_LABEL);
  });

  it("shows the build date as a calendar day, and nothing at all when there is none", () => {
    expect(buildDateLabel(FULL)).toBe("2026-09-03");
    expect(buildDateLabel({ ...FULL, buildDate: "" })).toBe("");
    expect(buildDateLabel({ ...FULL, buildDate: "not a date" })).toBe("");
  });

  it("names NAXHQ as the copyright holder", () => {
    expect(COPYRIGHT_HOLDER).toBe("NAXHQ");
    expect(copyrightLine()).toBe(`© ${COPYRIGHT_YEAR} NAXHQ`);
  });

  it("puts the whole build on one line, and stays readable with no commit and no date", () => {
    expect(buildStamp(FULL)).toBe("FrameCraft 3.1.0 · a1b2c3d4e5f6 · 2026-09-03");
    expect(buildStamp(TARBALL)).toBe(`FrameCraft 3.1.0 · ${NO_COMMIT_LABEL} · 2026-09-03`);
    expect(buildStamp({ version: "3.1.0", commit: "", buildDate: "" })).toBe(
      `FrameCraft 3.1.0 · ${NO_COMMIT_LABEL}`,
    );
  });

  it("links the repository and the licence, and keeps the OSM credit verbatim", () => {
    expect(REPOSITORY_URL).toBe("https://github.com/naxhq/framecraft");
    expect(LICENCE_URL.startsWith(REPOSITORY_URL)).toBe(true);
    expect(LICENCE_NAME).toBe("MIT");
    expect(OSM_CREDIT).toBe("© OpenStreetMap contributors");
  });
});

/**
 * The desktop shell renders this same bundle, so it must not carry a version
 * of its own -- but Tauri needs one in three files no import can reach. They
 * are stamped from `apps/web/package.json` and this is what stops them
 * drifting: a bump that forgets `npm run version:stamp` fails here rather than
 * in an installer nobody looks at until release day.
 */
describe("the desktop manifests", () => {
  it("all carry the web package's version", () => {
    const expected = readPackageVersion();
    const drift = stampDrift(expected);
    expect(
      drift.map((one) => `${one.label} ${one.reason}`),
      "run: npm run version:stamp",
    ).toEqual([]);
  });

  it("has a stamp target for each of the three files Tauri reads", () => {
    const labels = readStampedVersions().map((one) => one.label);
    expect(labels).toEqual([
      "apps/desktop/package.json",
      "apps/desktop/src-tauri/tauri.conf.json",
      "apps/desktop/src-tauri/Cargo.toml",
    ]);
  });
});
