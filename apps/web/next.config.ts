import type { NextConfig } from "next";

import { versionInfo } from "./scripts/version.mjs";

/**
 * FrameCraft v3 P8: the app is a fully static site (`output: "export"`).
 * Everything the product does (Overpass fetch, WASM geometry, exporters)
 * already runs client-side, so `next build` writes a complete `out/` tree
 * that any static file server (GitHub Pages, `scripts/serve-static.mjs`,
 * Tauri's asset protocol) can serve as-is. `next start` no longer applies;
 * `next dev` is unchanged.
 *
 * NEXT_PUBLIC_BASE_PATH ("" by default, "/framecraft" for GitHub Pages) is
 * the ONE knob for sub-path hosting. It is inlined at build time into: this
 * config's `basePath`/`assetPrefix`, and `lib/basePath.ts`, which prefixes
 * the two runtime-constructed public URLs Next cannot rewrite on its own
 * (the MapLibre worker URL and the manifold WASM fetch).
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/**
 * The version, the commit and the build date, resolved ONCE for this build by
 * `scripts/version.mjs` -- the same module that stamps the desktop manifests,
 * so the web footer, the desktop About dialog and the installer metadata can
 * never disagree. `lib/version.ts` reads the three inlined values back.
 */
const build = versionInfo();

/**
 * An identifier for THIS build, inlined as `NEXT_PUBLIC_BUILD_ID`.
 *
 * `lib/serviceWorker.ts` registers `sw.js?v=<this>`, which is what makes a
 * deploy visible to a browser that already has a worker installed: the worker
 * file itself rarely changes, so without a changing URL a returning visitor
 * would keep the worker they installed months ago and never be offered the new
 * build. The commit sha is the honest value where there is one (CI, and any
 * checkout); a working tree with no git available falls back to the build
 * timestamp, which is unique per build and no less correct, only noisier.
 *
 * NEXT_PUBLIC_BUILD_ID from the environment wins, so a release pipeline can
 * pin it.
 */
function buildId(): string {
  const fromEnv = process.env.NEXT_PUBLIC_BUILD_ID;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (build.commit !== "") return build.commit;
  return `t${Date.now().toString(36)}`;
}

const nextConfig: NextConfig = {
  output: "export",
  // An empty string is not a legal `basePath` value; only set the pair when
  // a sub-path is actually requested.
  ...(basePath !== "" ? { basePath, assetPrefix: basePath } : {}),
  // Pages serves `/framecraft/` (a directory) rather than `/framecraft`;
  // trailing-slash routing makes the exported tree match that shape.
  trailingSlash: true,
  images: { unoptimized: true },
  env: {
    NEXT_PUBLIC_BUILD_ID: buildId(),
    NEXT_PUBLIC_APP_VERSION: build.version,
    NEXT_PUBLIC_COMMIT_SHA: build.commit,
    NEXT_PUBLIC_BUILD_DATE: build.buildDate,
  },
  webpack: (config, { dev, isServer, webpack }) => {
    // `manifold-3d`'s emscripten glue (`lib/engine/solid/manifold.ts`'s only
    // dependency) branches on `ENVIRONMENT_IS_NODE` and only then does
    // `await import("node:module")` (and a couple of Node-only `node:url`/
    // `node:fs` paths beside it) to load the WASM binary off disk -- correct
    // and unreachable in a browser, since `ENVIRONMENT_IS_NODE` is false
    // there, but webpack's CLIENT compilation target still has to be able to
    // COMPILE around the `node:` URI scheme it does not otherwise handle
    // ("UnhandledSchemeError"). The server compilation (Next's SSR pass of
    // this "use client" module tree) keeps it: that target really does
    // support `node:` imports, and it is what the reference `export:cli` /
    // vitest paths already rely on working.
    if (!isServer) {
      config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^node:/ }));

      /*
       * Stop the client build emitting its own copy of `manifold.wasm`.
       *
       * The export used to carry the same 541 470 bytes twice
       * (`docs/handoff/v3-00-baseline.md`, and section 9 of the v3-08 note):
       * `manifold/manifold.wasm`, which `scripts/copy-manifold-wasm.mjs` puts
       * in `public/` and which is the one actually fetched, and
       * `_next/static/media/manifold.<hash>.wasm`, which the baseline recorded
       * as NEVER REQUESTED.
       *
       * The second copy comes from one line of emscripten glue:
       *
       *   if (Module["locateFile"]) { return locateFile("manifold.wasm") }
       *   return new URL("manifold.wasm", import.meta.url).href
       *
       * webpack sees the `new URL(..., import.meta.url)` and emits the file as
       * an asset whether or not the expression can ever run, and here it
       * cannot: `lib/engine/solid/manifold.ts` passes `locateFile` on every
       * non-Node path, so the first branch always wins in a browser and the
       * second is dead. `emit: false` keeps the URL webpack rewrites the
       * expression to -- nothing reads it -- and skips writing the file.
       *
       * Client only. The server compilation and vitest read the wasm through
       * `require.resolve("manifold-3d/manifold.wasm")` off disk in
       * `node_modules`, which this does not touch.
       */
      config.module.rules.push({
        test: /[\\/]manifold-3d[\\/]manifold\.wasm$/,
        type: "asset/resource",
        generator: { emit: false },
      });
    }

    /*
     * Give the two big vendors a chunk each.
     *
     * MEASURED, not asserted. Two builds of the same commit differing only in
     * this block, served and driven three times each
     * (docs/handoff/v3-08-siteperf.md section 7.4):
     *
     *                    first load JS   cold wire   requests   JS on disk
     *   with these        293 kB         3 184 328 B   17       4 282 554 B
     *   without them      293 kB         3 193 662 B   20       4 291 148 B
     *
     * So it is worth 9 334 B and three requests on a cold load, and nothing at
     * all on the first-load figure `next build` reports. maplibre-gl and three
     * are imported by components that mount on the landing page, so they are
     * on the critical path either way and only `components/**` can change
     * that. Nobody should read this block as a first-load optimisation.
     *
     * An earlier version of this comment also claimed the split keeps the
     * vendor chunks byte-identical across deploys that only touch app code,
     * where webpack would otherwise renumber and re-hash them. That was not
     * reproducible: adding a new module and importing it from `app/page.tsx`
     * left `vendor-maplibre` and `vendor-three` on the same content hash WITH
     * these groups, and left the four mixed chunks that hold the same
     * libraries on THEIR same hashes without them. Deterministic module ids
     * already do that job. The claim is withdrawn rather than restated.
     *
     * What is left is small and real: three fewer files, 9 kB less on the
     * wire, and two chunks named after what is in them, so the service
     * worker's cache and any future measurement can refer to them by name
     * instead of by a hash that means nothing.
     *
     * Production client build only: `next dev` has no content hashes to keep
     * stable, and the server compilation does not ship to a browser.
     */
    if (!isServer && !dev) {
      const splitChunks = config.optimization?.splitChunks;
      if (typeof splitChunks === "object" && splitChunks !== null) {
        splitChunks.cacheGroups = {
          ...splitChunks.cacheGroups,
          fcMaplibre: {
            chunks: "all",
            test: /[\\/]node_modules[\\/]maplibre-gl[\\/]/,
            name: "vendor-maplibre",
            priority: 40,
            reuseExistingChunk: true,
            enforce: true,
          },
          fcThree: {
            chunks: "all",
            test: /[\\/]node_modules[\\/](three|@react-three)[\\/]/,
            name: "vendor-three",
            priority: 40,
            reuseExistingChunk: true,
            enforce: true,
          },
        };
      }
    }
    return config;
  },
};

export default nextConfig;
