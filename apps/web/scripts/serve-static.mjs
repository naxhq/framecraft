/**
 * Tiny dependency-free static file server for the exported `out/` tree.
 *
 * Why it exists: `output: "export"` retired `next start`, but three flows
 * still need the production tree served over HTTP exactly the way GitHub
 * Pages will serve it: `FRAMECRAFT_WEB_MODE=prod` (Playwright and `make up`),
 * the P8 sub-path verification, and the README screenshot run. `npx serve`
 * would add a dependency and cannot mount the tree under a sub-path.
 *
 *   node scripts/serve-static.mjs --dir out --port 3000
 *   node scripts/serve-static.mjs --dir out --port 3000 --base /framecraft
 *
 * With --base, the tree is served ONLY under that prefix (a request outside
 * it 404s), which is what makes a root-absolute URL bug visible locally
 * instead of first appearing on Pages.
 *
 * Two things it now does that a bare file server does not, both because this
 * is also the server the site's performance is measured on:
 *
 *   Precompressed variants. If `<file>.br` exists and the client sent
 *   `Accept-Encoding: br`, that file is sent with `Content-Encoding: br`;
 *   likewise `.gz`. `scripts/precompress.mjs` writes them. GitHub Pages
 *   compresses on the fly and serves gzip only (measured, never brotli), so
 *   this buys nothing THERE; it is for self-hosting the release zip, where it
 *   is worth about 18 % of the JS on the wire.
 *
 *   Real cache lifetimes on content-addressed paths. Every response used to
 *   carry `Cache-Control: no-store`, which makes a warm-load measurement
 *   meaningless: nothing can ever be reused. `_next/static/**` and
 *   `/presets/<sha1>.json.gz` carry a content hash or a query hash in the URL,
 *   so they get `immutable`. Everything else, the HTML included, stays
 *   `no-store`.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", argValue("--dir", "out"));
const port = Number(argValue("--port", "3000"));
const base = argValue("--base", "").replace(/\/$/, "");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  // A bundled preset response. The bytes ARE gzip and the client inflates them
  // itself (`lib/engine/osm/overpass.ts`), so this must never be served with
  // `Content-Encoding: gzip`: the browser would inflate it a second time.
  ".gz": "application/gzip",
};

/** URLs whose bytes cannot change without the URL changing: a content hash or a query sha1. */
function isImmutablePath(pathname) {
  return pathname.startsWith("/_next/static/") || /^\/presets\/[0-9a-f]{40}\.json\.gz$/.test(pathname);
}

/**
 * The precompressed sibling to send for this request, or null.
 *
 * Only ever `<file>.br` / `<file>.gz` beside the file that was asked for, so
 * a request for a `.gz` asset is served as itself, not as somebody's encoding
 * of something else.
 */
function encodedVariant(filePath, acceptEncoding) {
  const accepts = String(acceptEncoding ?? "").toLowerCase();
  if (/\bbr\b/.test(accepts) && existsSync(`${filePath}.br`)) {
    return { file: `${filePath}.br`, encoding: "br" };
  }
  if (/\bgzip\b/.test(accepts) && existsSync(`${filePath}.gz`)) {
    return { file: `${filePath}.gz`, encoding: "gzip" };
  }
  return null;
}

function send(res, status, filePath, pathname = "", acceptEncoding = "") {
  const variant = status === 200 ? encodedVariant(filePath, acceptEncoding) : null;
  const bodyFile = variant === null ? filePath : variant.file;
  const headers = {
    "Content-Type": MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": statSync(bodyFile).size,
    "Cache-Control": isImmutablePath(pathname) ? "public, max-age=31536000, immutable" : "no-store",
    Vary: "Accept-Encoding",
  };
  if (variant !== null) headers["Content-Encoding"] = variant.encoding;
  res.writeHead(status, headers);
  createReadStream(bodyFile).pipe(res);
}

function notFound(res) {
  const page = path.join(root, "404.html");
  if (existsSync(page)) {
    send(res, 404, page);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    notFound(res);
    return;
  }

  if (base !== "") {
    if (pathname === base) {
      res.writeHead(301, { Location: `${base}/` });
      res.end();
      return;
    }
    if (!pathname.startsWith(`${base}/`)) {
      notFound(res);
      return;
    }
    pathname = pathname.slice(base.length);
  }

  const resolved = path.resolve(root, `.${pathname}`);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    notFound(res);
    return;
  }

  const candidates = [];
  if (pathname.endsWith("/")) {
    candidates.push(path.join(resolved, "index.html"));
  } else {
    candidates.push(resolved, `${resolved}.html`, path.join(resolved, "index.html"));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      send(res, 200, candidate, pathname, req.headers["accept-encoding"]);
      return;
    }
  }
  notFound(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`serving ${root} at http://127.0.0.1:${port}${base === "" ? "" : `${base}/`}`);
});
