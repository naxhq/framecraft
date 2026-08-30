/**
 * Copy MapLibre's web worker (and the shared chunk it imports) into
 * `public/maplibre/` so `setWorkerUrl()` in components/map/LocationPicker.tsx
 * can point at a URL that actually serves JavaScript.
 *
 * Why this exists: maplibre-gl 6 resolves its worker with
 * `new URL("./maplibre-gl-worker.mjs", import.meta.url)`. Next's bundler
 * rewrites `import.meta.url` to the document URL, so the worker request lands
 * on the app's 404 HTML page. The module worker then fails to parse and dies
 * *silently* -- raster tiles keep working (they never touch the worker) while
 * every GeoJSON source stays empty forever, which is how the radius circle and
 * the crop square went missing. See docs/handoff/04-web-editor.md.
 *
 * Runs from `predev` and `prebuild`, so the files are always in step with the
 * installed maplibre-gl version. The output is gitignored.
 */

import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "public", "maplibre");

const distDir = dirname(require.resolve("maplibre-gl/dist/maplibre-gl.mjs"));
const files = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

await mkdir(target, { recursive: true });
for (const file of files) {
  await copyFile(join(distDir, file), join(target, file));
}
console.log(`maplibre worker copied to public/maplibre (${files.join(", ")})`);
