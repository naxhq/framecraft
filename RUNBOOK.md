# FrameCraft RUNBOOK

Pick a spot on a map, tune it in a live 3D editor, download a print-ready
framed miniature of that place. Since v3 the whole pipeline runs in the
browser: Overpass ingest, terrain, the manifold WASM solid engine, the audit
and every exporter live in `apps/web/lib/engine/**`, and `next build` emits a
fully static site. Architecture: `docs/ARCHITECTURE.md`.

## 1. What runs where

- **Web app** (`apps/web`, :3000): standalone. It never calls `services/bake`.
  Deployed as GitHub Pages (<https://naxhq.github.io/framecraft/>), a
  self-hosted static tree, or the Tauri desktop app.
- **Reference service** (`services/bake`, :8000): optional. It is the Python
  reference implementation and the CLI printability validator
  (`python -m app.cli validate`, wrapped by `make validate`). You only need it
  to run the validator, the pytest suite, or its API (`/health`, `/presets`,
  `/scene`, `/bake`, `/bake/{id}`, `/files/{name}`, OpenAPI at `:8000/docs`)
  for comparing the two pipelines by hand.

Data: OpenStreetMap (Overpass + OSM raster tiles), Nominatim geocoding,
Mapzen Terrarium elevation tiles. Attribution obligations and what the
engraved marks do: `LICENSE_AND_ATTRIBUTION.md`.

## 2. Setup

| Tool | Version | Notes |
|---|---|---|
| Node + npm | 22+ | `apps/web` and `apps/desktop` use `npm ci` |
| `uv` | 0.12 | installs Python 3.12 itself; only needed for `services/bake` |
| GNU make | 4.x | recipes are POSIX sh; on Windows run from Git Bash |
| Rust toolchain | stable | only to build the desktop (Tauri) bundle |

```sh
make install        # uv sync + npm ci + playwright chromium
make dev            # both services in the foreground, Ctrl-C stops both
# or web alone:
cd apps/web && npm run dev
```

`make up` / `make down` start and stop both in the background (pid files in
`.run/`, logs in `artifacts/logs/`). `FRAMECRAFT_WEB_MODE=prod` makes `up`
serve the static export (`next build`, then
`node scripts/serve-static.mjs --dir out --port 3000`) instead of `next dev`.

## 3. Make targets

| Target | What it does |
|---|---|
| `make help` | list targets (default) |
| `make install` | `uv sync` (services/bake), `npm ci` (apps/web), `npx playwright install chromium` |
| `make contracts` | regenerate `contracts.py` and `contracts.ts` from `packages/contracts/schema/*.json`; never hand-edit the outputs |
| `make up` / `make down` | start / stop the reference service (:8000) and web (:3000); docker compose if present, else native; `down` verifies the ports actually freed |
| `make dev` | both services natively, foreground |
| `make test` | `pytest -q` (services/bake) then `vitest run` (apps/web) |
| `make gate` | the full quality gate, section 4 |
| `make gate-v2` | the v2 geometry gates on the reference pipeline: G8 v1-golden, parts builds at plate 180 and 256, TEXT=all, parts+text, each validated as `.3mf` and `.stl` |
| `make export-fixture` | build and export the Chicago preset through the **reference Python CLI** to `artifacts/chicago.3mf`; `COLOR=parts`, `TEXT=all`, `PLATE=100..256` compose into distinct stems. `make bake-fixture` is a deprecation alias that prints the new name and runs it |
| `make validate FILE=x` (or `make validate x`) | the printability validator on a `.3mf`/`.stl`: the 04 rows, the parts/lettering rows, the container rows, plus the sidecar-driven `max_height_mm` and `attribution` rows; exit 1 on any FAIL |
| `make refresh-fixtures` | re-fetch the six preset Overpass responses (network) |
| `make clean` | remove `.next`, exported artifacts, `.run`, logs |

### The browser engine from the command line

`npm run export:cli` (in `apps/web`, via vite-node) runs the TypeScript engine
on a scene and params JSON and writes the export plus a sidecar `make
validate` can judge:

```sh
cd apps/web
npm run export:cli -- --scene ../../fixtures/chicago-scene.json \
  --params ../../fixtures/print-params-default.json \
  --target generic-3mf --out ../../artifacts/chicago-web.3mf
```

Flags (`apps/web/scripts/export-cli.ts`): `--scene <scene.json>` or
`--overpass <overpass.json>` (ingest a raw Overpass response through
`lib/engine/osm`, the app's own path, which carries rail and bridge tags a
Python-produced SceneGraph does not); `--params`; `--target` (any
`export_target`: `bambu-3mf`, `generic-3mf`, `stl`, `stl-parts-zip`, `obj`,
`step`, `color-change-3mf`); `--terrain <grid.json|demo|demo:<relief_m>>`
(a synthetic ramp, so a draped build validates reproducibly offline);
`--radius <m>` and `--rotation <deg>` for `--overpass`;
`--tiling COLSxROWS[:joint[:tolerance_mm]]` (joint `dovetail` or `pin`;
also writes every tile as its own file with its own sidecar, since the tiled
export itself is a zip or multi-plate project the validator cannot open);
`--out`; `--title`.

## 4. The gate (`make gate`)

Steps as the Makefile labels them, every one checked:

0. stop any running stack (the gate owns the lifecycle)
1. static no-skip guard over every vitest and Playwright source (no
   `.skip`/`.only`/`.todo`/`.fixme`/`.fail`/`xit` marker anywhere)
2. pytest (`services/bake`), failing on any skip/xfail as well as any failure
3. eslint (`--max-warnings 0`), `tsc --noEmit`, vitest (no skipped/todo),
   `rm -rf apps/web/.next`, `next build`
4. browser engine: `scripts/gate-web-engine.sh` builds the Chicago fixture via
   `npm run export:cli` in both modes (`fixtures/print-params-default.json`
   single, `fixtures/print-params-parts.json` parts) and both files must read
   ALL CHECKS PASS from `make validate`
5. Playwright chromium presence check
6. `make up`, then the Playwright suite; `results.json` is walked for skipped
   and expected-failure tests
7. teardown, checked: a failing `make down` or a port still listening fails
   the gate
8. `fixtures/` is clean (no stray sha1 Overpass fixture)

Zero skipped tests and zero expected failures are gate conditions enforced in
several independent places (static guard, pytest summary, vitest summary,
results.json).

## 5. Verification matrix (latest full gate: `artifacts/logs/v3-06-gate-2.log`)

| Check | Result |
|---|---|
| Static no-skip guard | 84 test files scanned, no marker |
| pytest (`services/bake`) | **697 passed**, 0 skipped/xfailed (226.7 s) |
| eslint + `tsc --noEmit` | clean |
| vitest (`apps/web`) | **1382 passed** in 75 files (93.4 s) |
| `next build` (static export) | clean |
| Browser engine + validator | **ALL CHECKS PASS**, single and parts mode |
| Playwright | **48 passed**, 0 failed, 0 flaky, 0 skipped, 0 expected-failure (8.6 min, 9 spec files incl. two in-suite validator runs, both ALL CHECKS PASS) |
| Teardown + fixtures | ports freed, no stray fixture; **GATE PASS** |

`make gate-v2` (reference-pipeline geometry gates) passes separately; see the
`gate-v2-*.log` files beside the gate log.

## 6. Static build and desktop app locally

```sh
cd apps/web && npm run build            # writes the full static site to out/
node scripts/serve-static.mjs --dir out --port 4510
# sub-path exactly as GitHub Pages serves it (set the env var from PowerShell
# on Windows; Git Bash mangles leading-slash values):
NEXT_PUBLIC_BASE_PATH=/framecraft npm run build
node scripts/serve-static.mjs --dir out --port 4511 --base /framecraft
```

Desktop (Tauri 2, needs Rust):

```sh
cd apps/desktop && npm ci
npm run dev      # tauri dev against the web build
npm run build    # installers under src-tauri/target/release/bundle/{msi,nsis}
```

`tauri.conf.json`'s `beforeBuildCommand` builds `apps/web` with an empty base
path into `apps/web/out`, which `frontendDist` points at.

## 7. CI and release workflows

- `.github/workflows/ci.yml` (push to main, every PR): three jobs mirroring
  the gate. `reference-service` (pytest, zero-skip check), `web` (no-skip guard,
  lint, typecheck, vitest, `next build`, both `export:cli` runs judged by the
  Python validator), `e2e` (Playwright with `E2E_BUDGET_FACTOR=3`, every spec
  Overpass-mocked from committed fixtures, results.json checked, artifacts
  uploaded on failure).
- `.github/workflows/pages.yml` (push to main, or manual dispatch): builds
  with `NEXT_PUBLIC_BASE_PATH=/framecraft`, adds `.nojekyll`, deploys
  `apps/web/out` to GitHub Pages. One-time repo setup: Settings > Pages >
  Source "GitHub Actions".
- `.github/workflows/release.yml` (tag `v*`): creates the GitHub Release
  first (`gh release create --generate-notes`), then a fail-fast:false
  tauri-action matrix attaches installers (Windows msi+nsis, macOS universal
  dmg, Linux appimage+deb) plus a source-map-free zip of the root-base static
  site. Signing is optional and secrets-driven; unset means unsigned.

## 8. Troubleshooting

- **`make: command not found` (this host).** GNU make is installed via winget
  but not on PATH in fresh shells; prefix Bash calls with:
  `export PATH="/c/Users/Vahid/AppData/Local/Microsoft/WinGet/Packages/ezwinports.make_Microsoft.Winget.Source_8wekyb3d8bbwe/bin:$PATH"`
- **Port 3000/8000 still held after a killed gate.** `next dev` respawns its
  child server under a new pid when the supervisor dies, so `.run/web.pid`
  goes stale and `make down`'s probe rightly reports the survivor. Stop the
  current owner directly (`netstat -ano | grep ":3000 "`, then
  `Stop-Process -Id <pid> -Force`). Run the gate detached from anything that
  can time it out (11 to 16 minutes on this host), and never pipe `make up`
  through another command (redirect to a file instead).
- **A concurrent Playwright session blocks the gate.** Playwright's own
  `webServer` holds :8000 and :3000 for its whole run, so `make up` refuses
  to bind. When probing for one on Windows, match `Name -eq 'node.exe'` AND
  the command line, or the probe counts itself.
- **Leftover node/chromium processes slow everything.** Orphaned processes
  from earlier runs load the box (seven stray `node.exe` at 82 % CPU were
  measured stretching engine builds from 3 s to 5+ s); clear them before
  timing-sensitive gates, or budgets start flaking.
- **Slow or software-GL machines.** Every WebGL/WASM-heavy e2e wait scales
  with `E2E_BUDGET_FACTOR` (default 1; CI uses 3). Raise it rather than
  editing timeouts.
- **Windows Smart App Control blocks fresh executables** (cargo build
  scripts, test binaries, os error 4551) in the repo tree. For local
  cargo/Tauri builds, point `CARGO_TARGET_DIR` at the agent scratchpad (or
  any allowed) directory and copy the bundles back. GitHub runners are
  unaffected.
- **`NEXT_PUBLIC_BASE_PATH=/framecraft` arrives mangled from Git Bash**
  (MSYS path conversion); set it from PowerShell.
- **Manual `next build` fails over a stale `.next`** with
  `PageNotFoundError`; `rm -rf apps/web/.next` first (the gate does this
  itself).

## 9. Known limitations (v3)

- Plate 256 mm carries residual geometry defects on the Chicago preset: 6 to 7 degenerate faces (both frame states) and one thin lobe in frame-off parts mode; analysed in docs/handoff/FAILURES.md, warned by the in-app audit, default plate 180 unaffected.

- Steep terrain can drape base walls under the printable minimum; the in-app
  audit warns and offers safe fixes, and the draped min-wall sweep is what
  catches it.
- Per-building tint shows in the preview and the OBJ export only; other
  formats colour by region.
- STEP output is a faceted B-rep (triangle faces), with a size note above
  50k triangles.
- Desktop installers are unsigned: SmartScreen/Gatekeeper warn on first
  launch.
- A separate frame, cleat or easel build is deliberately a second body, and
  the reference validator's `bodies` row reads 2 vs 1 for it (the engine's
  own gate excuses exactly the expected loose parts; an `expected_bodies`
  sidecar field is designed but not built).
- The frame-off Chicago fixture fails the validator's `min_wall` row (and
  `degenerate_faces` at plate 256); pre-existing crop/merge behaviour,
  `DECISIONS.md` `[V3-P7-A11]`.
- Single-nozzle colour change only recolours regions whose Z bands are
  exclusive to their slot; the rest are reported as inseparable.
- Share links cap at 8000 characters with no server-side fallback; the UI
  offers a project file instead.
- Bambu Studio 2.8.1.55's CLI crashes on Bambu-flavoured input on this host,
  so the full `--export-3mf` round trip is verified by loader probes and the
  GUI, not return code 0 (`docs/handoff/v3-02-export.md`).
