/**
 * The build-time base path the app is served under ("" at the domain root,
 * "/framecraft" on GitHub Pages), and the two helpers that apply it to URLs
 * Next's own `basePath`/`assetPrefix` cannot reach.
 *
 * `NEXT_PUBLIC_BASE_PATH` is inlined by the bundler at build time, into the
 * page chunks AND the engine worker chunk, so this module is safe to import
 * from either side of the worker boundary. It must never be read at runtime
 * from `window.location`: the export is static, so the correct value is the
 * one the site was BUILT for, not wherever a copy happens to be mounted.
 */
export const BASE_PATH: string = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** Prefix a root-relative public path ("/maplibre/...") with the base path. */
export function withBasePath(path: string): string {
  if (BASE_PATH === "" || !path.startsWith("/")) return path;
  if (path === BASE_PATH || path.startsWith(`${BASE_PATH}/`)) return path;
  return `${BASE_PATH}${path}`;
}

/**
 * Mirrors `lib/engine/solid/manifold.ts`'s `MANIFOLD_WASM_PUBLIC_PATH`. The
 * literal is duplicated here ON PURPOSE: importing it would pull the whole
 * manifold-3d module graph into every chunk that only wants a URL helper.
 */
const MANIFOLD_WASM_ROOT_PATH = "/manifold/manifold.wasm";

declare global {
  var __framecraftWasmShim: boolean | undefined;
}

/**
 * Make the manifold WASM load work under a sub-path deployment.
 *
 * `lib/engine/solid/manifold.ts` points emscripten's `locateFile` at the
 * root-relative `/manifold/manifold.wasm` (the right call when the app owns
 * the origin, and that module is frozen for this phase). Under
 * NEXT_PUBLIC_BASE_PATH="/framecraft" that URL 404s, so this shim wraps the
 * global `fetch` of whichever scope loads the engine (the worker, or the
 * page for the inline fallback) and rewrites EXACTLY that one path to its
 * base-prefixed location. Every other request, Overpass and tiles included,
 * passes through byte-identical.
 *
 * No-op when the base path is empty, when already installed, and in any
 * Node runtime (vitest, export-cli, Next's prerender pass), where emscripten
 * reads the file from disk and never calls `fetch` for it.
 */
export function installWasmBasePathFetchShim(): void {
  if (BASE_PATH === "") return;
  if (typeof process !== "undefined" && process.versions?.node !== undefined) return;
  if (typeof fetch === "undefined") return;
  if (globalThis.__framecraftWasmShim) return;
  globalThis.__framecraftWasmShim = true;

  const original = globalThis.fetch.bind(globalThis);
  const rewritten = withBasePath(MANIFOLD_WASM_ROOT_PATH);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (url === MANIFOLD_WASM_ROOT_PATH) return original(rewritten, init);
    return original(input as RequestInfo, init);
  }) as typeof fetch;
}
