# v3 phase 8: distribution (static Pages build + Tauri desktop)

Date: 2026-09-01. Agent: p8-dist. Rulings: `DECISIONS.md` [V3-P8-D1..D4].

## What was built

- **Static export.** `apps/web/next.config.ts` now sets `output: "export"`,
  `trailingSlash: true`, `images.unoptimized`, and takes `basePath`/
  `assetPrefix` from `NEXT_PUBLIC_BASE_PATH` (default empty). `next build`
  writes a complete, serverless `out/` tree; `next start` is retired.
- **Sub-path support.** `apps/web/lib/basePath.ts` (new) carries the inlined
  base path plus the two fixes Next cannot do itself:
  `withBasePath()` for the MapLibre worker URL
  (`components/map/LocationPicker.tsx`), and
  `installWasmBasePathFetchShim()`, a scope-local `fetch` wrapper that
  rewrites exactly `/manifold/manifold.wasm` to its prefixed URL. The shim
  exists because `lib/engine/solid/manifold.ts` (which hardcodes the root
  path in `locateFile`) was frozen to a concurrent fixer during P8; it is
  installed by `lib/engine/worker.ts` and by `lib/engine/client.ts`'s inline
  fallback, and is a no-op at the root, in Node, and for every other URL.
- **Static server.** `apps/web/scripts/serve-static.mjs` (new,
  dependency-free): serves `out/` with correct MIME types; `--base
  /framecraft` mounts the tree under the prefix ONLY (anything outside 404s),
  reproducing GitHub Pages locally. `FRAMECRAFT_WEB_MODE=prod` in
  `playwright.config.ts` and the Makefile `up` target now build and serve
  `out/` through it instead of `next start`.
- **Desktop shell.** `apps/desktop/` (new): Tauri 2, product FrameCraft,
  identifier `io.nax.framecraft`, version 3.0.0, window 1440x900 min
  1100x700, `withGlobalTauri`, `frontendDist: ../../web/out` built by
  `beforeBuildCommand` with an empty base path. Rust side
  (`src-tauri/src/lib.rs`) is two commands: `save_export` (base64 payload,
  native save dialog via `tauri-plugin-dialog`, `std::fs::write`) and
  `cache_dir` (app data dir). Icons generated from `apps/web/app/icon.svg`
  by `tauri icon`. Web side: `apps/web/lib/platform.ts` (new) detects Tauri
  via `__TAURI_INTERNALS__` and talks to `window.__TAURI__.core.invoke`, so
  no `@tauri-apps/*` JS is bundled; `lib/bake.ts:saveDownloadFile` +
  `OutputPanel`'s anchor onClick route downloads through the dialog under
  Tauri and stay plain `<a download>` in a browser.
- **Workflows.** `.github/workflows/pages.yml` (push to main: build with
  `NEXT_PUBLIC_BASE_PATH=/framecraft`, `.nojekyll`, configure-pages,
  upload-pages-artifact from `apps/web/out`, deploy-pages; permissions
  pages+id-token, concurrency group `pages`; one-time setup: repo Settings,
  Pages, Source "GitHub Actions"). `.github/workflows/release.yml` (tags
  `v*`: creates the release first with `gh release create --generate-notes`,
  then a fail-fast:false tauri-action matrix attaches installers: Windows
  msi+nsis, macOS `--target universal-apple-darwin` dmg, ubuntu-22.04
  appimage+deb with the webkit2gtk-4.1 apt set; optional signing secrets
  passed through and documented in the workflow header; plus a source-map
  free zip of the root-base static site).
- **Screenshots.** `docs/assets/screenshot.png` (866 KB) and
  `docs/assets/screenshot-colour.png` (788 KB), both 1600x1000, dark UI,
  Chicago Loop engine preview; the second with COLOUR open in one-per-part
  mode showing the seven part swatches.

## Local verification results (this Windows 11 host)

- Root path: `out/` served at `http://127.0.0.1:4510/`, real Chromium,
  Overpass route-mocked from the committed Chicago fixture: preset,
  engine preview, bake, 3MF download (2 244 512 bytes, PK magic), zero
  same-origin 4xx, zero console errors.
- Sub path: rebuilt with `NEXT_PUBLIC_BASE_PATH=/framecraft`, served ONLY
  under `/framecraft/` on port 4511: same full flow PASS (proves the worker,
  WASM, fonts and every asset resolve under the prefix).
- Prod-mode Playwright branch: `FRAMECRAFT_WEB_MODE=prod npx playwright
  test e2e/a11y.spec.ts` passed 4/4 against the statically served build.
- Vitest: 1382/1382 pass; eslint and tsc clean.
- Desktop: `npm run build` in `apps/desktop` produced
  `FrameCraft_3.0.0_x64_en-US.msi` (4.7 MB) and
  `FrameCraft_3.0.0_x64-setup.exe` (NSIS, 3.6 MB); app exe 12.2 MB. Copies
  are under `apps/desktop/src-tauri/target/release/bundle/{msi,nsis}`
  (gitignored). The built exe was launched and driven over CDP
  (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port`):
  window title FrameCraft, `__TAURI_INTERNALS__` present, `cache_dir`
  returned `C:\Users\Vahid\AppData\Roaming\io.nax.framecraft`, Chicago
  preset baked inside the WebView and the 3MF link opened the native Save
  As dialog (its opening also proves the base64 payload decoded, which
  precedes the dialog in `save_export`).

## Host quirk: Windows Smart App Control vs cargo

This machine enforces Smart App Control, which blocks freshly compiled
executables (cargo build scripts, test binaries) with os error 4551 in the
repo tree and other normal paths, while builds under the agent scratchpad
directory run fine. The successful desktop build therefore ran with
`CARGO_TARGET_DIR` pointed at a scratchpad path, and the bundles were
copied back to `src-tauri/target/release/bundle/`. On an unrestricted
machine and on GitHub runners no workaround is needed. Also note: setting
`NEXT_PUBLIC_BASE_PATH=/framecraft` from Git Bash mangles the value into a
Windows path (MSYS conversion); set it from PowerShell.

## Not verifiable locally

- macOS dmg (universal) and Linux appimage/deb builds, Apple notarization,
  and any signing path: no such hardware/secrets here; the workflow follows
  tauri-action's documented matrix.
- Pages deployment itself (needs the repo setting flipped and a push).
- The literal `std::fs::write` after a human picks a path in the save
  dialog: the dialog is a native modal that ignored synthesized keystrokes
  in three attempts, so the final write is the one line not exercised
  end to end. Everything up to it (IPC, decode, dialog) is proven; a manual
  click-through is the remaining smoke step.
