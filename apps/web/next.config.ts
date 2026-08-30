import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
    // support `node:` imports, and it is what the reference `bake:cli` /
    // vitest paths already rely on working.
    if (!isServer) {
      config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^node:/ }));
    }
    return config;
  },
};

export default nextConfig;
