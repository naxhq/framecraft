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

const nextConfig: NextConfig = {
  output: "export",
  // An empty string is not a legal `basePath` value; only set the pair when
  // a sub-path is actually requested.
  ...(basePath !== "" ? { basePath, assetPrefix: basePath } : {}),
  // Pages serves `/framecraft/` (a directory) rather than `/framecraft`;
  // trailing-slash routing makes the exported tree match that shape.
  trailingSlash: true,
  images: { unoptimized: true },
  webpack: (config, { isServer, webpack }) => {
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
    return config;
  },
};

export default nextConfig;
