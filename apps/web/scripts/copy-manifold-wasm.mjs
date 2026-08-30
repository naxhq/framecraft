/**
 * Copy `manifold-3d`'s `manifold.wasm` into `public/manifold/` so
 * `lib/engine/solid/manifold.ts`'s `locateFile` override (used everywhere
 * except Node: the engine Web Worker, and a plain browser tab when Workers
 * are unavailable) can point at a URL that actually serves it.
 *
 * Why this exists: same bug class as `copy-maplibre-worker.mjs`. Outside
 * Node, `manifold-3d`'s emscripten glue locates its `.wasm` with
 * `new URL("manifold.wasm", import.meta.url)`; Next's bundler rewrites
 * `import.meta.url` inside a worker chunk to the chunk's own URL under
 * `/_next/static/...`, which does not serve `manifold.wasm` next to it. The
 * root-relative public path this script copies to is stable regardless of
 * which chunk the engine ends up in.
 *
 * Runs from `predev` and `prebuild`, so the file is always in step with the
 * installed `manifold-3d` version. The output is gitignored.
 */

import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "public", "manifold");

const wasmPath = require.resolve("manifold-3d/manifold.wasm");

await mkdir(target, { recursive: true });
await copyFile(wasmPath, join(target, "manifold.wasm"));
console.log("manifold.wasm copied to public/manifold");
