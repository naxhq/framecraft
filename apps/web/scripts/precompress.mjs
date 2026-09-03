/**
 * Write `.br` and `.gz` siblings for the compressible files in `out/`.
 *
 *   node scripts/precompress.mjs [--dir out]
 *
 * WHO THIS IS FOR, precisely, because it is easy to point it at the wrong
 * problem. GitHub Pages compresses on the fly and, measured with both curl and
 * a real Chromium offering `br`, serves gzip and only gzip
 * (`docs/handoff/v3-00-baseline.md` 1.5). It ignores files a repo ships, so
 * precompressing changes NOTHING on Pages. The desktop shell reads its bundle
 * through Tauri's asset protocol, where there is no wire and no negotiation,
 * so it changes nothing there either.
 *
 * It is worth doing for exactly one consumer: somebody self-hosting the static
 * site (the zip `release.yml` attaches) behind `scripts/serve-static.mjs` or
 * any server that honours precompressed siblings. There, brotli is worth about
 * 18 % of the JS and 23 % of the WASM against the gzip those servers would
 * otherwise produce.
 *
 * Already-compressed formats are skipped: woff2 grows under gzip (measured,
 * baseline section b), and a `.json.gz` preset asset is a payload the client
 * inflates itself, not an encoding.
 */

import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", argValue("--dir", "out"));

/** Extensions worth compressing. Everything else is either already compressed or too small to matter. */
const COMPRESSIBLE = new Set([".js", ".mjs", ".css", ".html", ".json", ".svg", ".txt", ".wasm", ".map", ".webmanifest"]);
/** Below this, the headers cost more than the saving. */
const MIN_BYTES = 1024;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

let files = 0;
let raw = 0;
let gzip = 0;
let brotli = 0;

for (const file of walk(root)) {
  const ext = path.extname(file).toLowerCase();
  if (!COMPRESSIBLE.has(ext)) continue;
  if (file.endsWith(".br") || file.endsWith(".gz")) continue;
  const size = statSync(file).size;
  if (size < MIN_BYTES) continue;

  const bytes = readFileSync(file);
  const gz = gzipSync(bytes, { level: 9 });
  const br = brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  });
  // A variant that is not smaller is not written: serve-static would then
  // send more bytes than the plain file for the sake of a header.
  if (gz.length < size) writeFileSync(`${file}.gz`, gz);
  if (br.length < size) writeFileSync(`${file}.br`, br);

  files += 1;
  raw += size;
  gzip += Math.min(gz.length, size);
  brotli += Math.min(br.length, size);
}

console.log(
  `precompress: ${files} file(s) under ${root}: ${raw} B raw, ${gzip} B gzip, ${brotli} B brotli ` +
    `(brotli saves ${raw === 0 ? 0 : (((gzip - brotli) / gzip) * 100).toFixed(1)}% against gzip)`,
);
