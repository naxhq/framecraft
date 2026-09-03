/**
 * Copy `apps/web/package.json`'s version into the three desktop manifests.
 *
 * The desktop shell ships the same bundle as the website, so it must not have
 * a version of its own -- but Tauri needs one in three places a JavaScript
 * import cannot reach: `apps/desktop/package.json`,
 * `apps/desktop/src-tauri/tauri.conf.json` (the installer's version) and
 * `apps/desktop/src-tauri/Cargo.toml` (the crate's). This script writes all
 * three from the one source.
 *
 * Why a stamp and not a build step: Tauri reads `tauri.conf.json` BEFORE it
 * runs `beforeBuildCommand`, so a script that rewrote the file during the
 * build would be one build too late. The stamped values are therefore
 * committed, and drift is a test failure rather than a surprise in an
 * installer: `lib/version.test.ts` runs this in `--check` mode, so a version
 * bump that forgets the desktop fails `npm test` on the required CI path.
 *
 *   node scripts/stamp-version.mjs --check   # report drift, exit 1
 *   node scripts/stamp-version.mjs --write   # fix it
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { APPS_ROOT, readPackageVersion } from "./version.mjs";

/**
 * One stamped location: how to read the version out of the file's text, and
 * how to put a new one back.
 *
 * Rewriting is a targeted regex substitution rather than parse-and-reserialise
 * because two of the three files are hand-formatted and one of them is TOML.
 * Reserialising `tauri.conf.json` through `JSON.stringify` would reorder
 * nothing but would still rewrite every line's whitespace, turning a
 * one-character version bump into a diff nobody can review.
 */
const TARGETS = [
  {
    label: "apps/desktop/package.json",
    path: join(APPS_ROOT, "desktop", "package.json"),
    // The manifest's own top-level "version", which in a package.json is the
    // second key; anchored to the start of a line so a dependency's version
    // can never match.
    pattern: /^(\s*"version"\s*:\s*")([^"]*)(")/m,
  },
  {
    label: "apps/desktop/src-tauri/tauri.conf.json",
    path: join(APPS_ROOT, "desktop", "src-tauri", "tauri.conf.json"),
    pattern: /^(\s*"version"\s*:\s*")([^"]*)(")/m,
  },
  {
    label: "apps/desktop/src-tauri/Cargo.toml",
    path: join(APPS_ROOT, "desktop", "src-tauri", "Cargo.toml"),
    // `[package]`'s own version: the first bare `version = "..."` at the start
    // of a line. Every dependency version in this manifest is either inline in
    // a table (`tauri = { version = "2", ... }`, which has no line start) or
    // under a later section, and the check below fails loudly if that ever
    // stops being true.
    pattern: /^(version\s*=\s*")([^"]*)(")/m,
  },
];

/** The version each target currently carries, or `null` when the pattern did not match. */
export function readStampedVersions(targets = TARGETS) {
  return targets.map((target) => {
    const text = readFileSync(target.path, "utf-8");
    const match = target.pattern.exec(text);
    return { label: target.label, path: target.path, version: match === null ? null : match[2] };
  });
}

/** Every target whose version is not `expected` (a missing match counts as drift). */
export function stampDrift(expected, targets = TARGETS) {
  return readStampedVersions(targets)
    .filter((found) => found.version !== expected)
    .map((found) => ({
      ...found,
      expected,
      reason: found.version === null ? "no version field matched" : `reads ${found.version}`,
    }));
}

/** Write `version` into every target that does not already carry it; returns the ones changed. */
export function writeStampedVersions(version, targets = TARGETS) {
  const changed = [];
  for (const target of targets) {
    const text = readFileSync(target.path, "utf-8");
    const match = target.pattern.exec(text);
    if (match === null) throw new Error(`${target.label}: no version field matched`);
    if (match[2] === version) continue;
    writeFileSync(target.path, text.replace(target.pattern, `$1${version}$3`), "utf-8");
    changed.push({ label: target.label, from: match[2], to: version });
  }
  return changed;
}

export { TARGETS };

// --- CLI -------------------------------------------------------------------

// `import.meta.main` is not available on every Node this repo supports, and
// comparing resolved paths is the portable form. Guarded so importing this
// module from a test never runs the CLI.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;

if (invokedDirectly) {
  const write = process.argv.includes("--write");
  const version = readPackageVersion();
  if (write) {
    const changed = writeStampedVersions(version);
    if (changed.length === 0) {
      console.log(`version ${version}: all desktop manifests already match`);
    } else {
      for (const one of changed) console.log(`${one.label}: ${one.from} -> ${one.to}`);
    }
  } else {
    const drift = stampDrift(version);
    if (drift.length === 0) {
      console.log(`version ${version}: all desktop manifests match`);
    } else {
      for (const one of drift) console.error(`${one.label}: ${one.reason}, expected ${version}`);
      console.error("run: node scripts/stamp-version.mjs --write");
      process.exitCode = 1;
    }
  }
}
