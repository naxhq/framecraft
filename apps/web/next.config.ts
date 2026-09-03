import { execFileSync } from "node:child_process";

import type { NextConfig } from "next";

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
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return `t${Date.now().toString(36)}`;
  }
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
  env: { NEXT_PUBLIC_BUILD_ID: buildId() },
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
    }

    /*
     * Give the two big vendors a chunk each.
     *
     * This does not make the page load fewer bytes: maplibre-gl and three are
     * imported by components that mount on the landing page, so they are on
     * the critical path either way and only `components/**` can change that.
     * What it changes is WHICH FILE they live in across deploys. Measured on
     * the deployed build, vendor code is smeared over mixed chunks (one 420 kB
     * chunk holds glyph handling, projection and geometry together), so any
     * app-code edit that shifts webpack's module ids rewrites their content
     * hashes and a returning visitor re-downloads all of it. Pinned to their
     * own cache groups, a deploy that only touched the editor leaves
     * maplibre-gl (543 kB) and three (742 kB) byte-identical, so the service
     * worker's cache-first copies stay valid and the update costs nothing.
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
