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
};

function send(res, status, filePath) {
  res.writeHead(status, {
    "Content-Type": MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": statSync(filePath).size,
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(res);
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
      send(res, 200, candidate);
      return;
    }
  }
  notFound(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`serving ${root} at http://127.0.0.1:${port}${base === "" ? "" : `${base}/`}`);
});
