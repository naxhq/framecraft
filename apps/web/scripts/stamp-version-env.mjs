/**
 * Put this build's version into the environment, for Node entry points that
 * have no bundler to inline it.
 *
 * `lib/version.ts` reads `process.env.NEXT_PUBLIC_APP_VERSION`, which
 * `next.config.ts` substitutes as a literal in the browser and the desktop
 * shell. `scripts/export-cli.ts` runs the same exporters under plain Node,
 * where nothing substitutes anything, so without this the files CI hands to
 * the Python validator would be stamped with `UNBUILT_VERSION` instead of the
 * version the release actually is.
 *
 * A SIDE-EFFECT module rather than a function call, and imported FIRST by its
 * one consumer, because ES modules evaluate their imports in order and to
 * completion: this file has finished running before the engine's own modules
 * are even parsed. A function called from inside `main()` would be too late
 * for anything that reads the version while its module initialises.
 *
 * Never overwrites a value that is already set, so a release pipeline that
 * pins the variable keeps its pin.
 */

import { readPackageVersion } from "./version.mjs";

if (process.env.NEXT_PUBLIC_APP_VERSION === undefined || process.env.NEXT_PUBLIC_APP_VERSION === "") {
  process.env.NEXT_PUBLIC_APP_VERSION = readPackageVersion();
}
