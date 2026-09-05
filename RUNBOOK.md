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
| `make gate-fast` | the required CI path locally: the same five job bodies, the same `@smoke` Playwright subset (section 7) |
| `make gate-nightly` | the nightly CI path locally: the full Playwright suite, the export and preset matrices; the cross-platform installers cannot be built on this host |
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
`--radius <m>`, `--rotation <deg>` and `--center <lat,lon>` for `--overpass`
(a raw Overpass response carries no centre, so without `--center` every city
crops around the default pin, which is what hid the preset failures in section
9); `--tiling COLSxROWS[:joint[:tolerance_mm]]` (joint `dovetail` or `pin`;
also writes every tile as its own file with its own sidecar, since the tiled
export itself is a zip or multi-plate project the validator cannot open);
`--out`; `--title`.

### Screenshots for the README

```sh
cd apps/web && node scripts/capture-screenshots.mjs
```

Drives the real interface with Playwright and rewrites every image in
`docs/assets/`. Overpass, Photon and Nominatim are routed to the committed
fixtures, so the city and the search results are the same on every host; the
OSM raster tiles behind the map region are fetched live, so this one needs
network. It reuses a server already answering `http://localhost:3000` and
starts (and stops) `npm run dev` when there is none. `--only <name,...>`
captures a subset (`editor`, `settings`, `colour`, `search`, `objects`),
`--url <origin>` drives another server, `--out <dir>` writes elsewhere, and
`--headed` lets you watch.

Each shot runs in its own browser on an empty `localStorage`, and one that
needs a model re-checks after the shutter that the model is still on screen,
retrying up to three times: a dev server reloads every page it is serving when
anybody saves a file, and the picture that comes back from that is the empty
state. On a tree being edited, or before a release, capture against the
production build instead, which cannot reload underneath the run:

```sh
npm run build && node scripts/serve-static.mjs --dir out --port 3010 &
node scripts/capture-screenshots.mjs --url http://localhost:3010
```

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
# the six preset Overpass responses beside the app, as pages.yml ships them
node scripts/bundle-preset-assets.mjs --out out
# brotli/gzip siblings, which serve-static.mjs sends when the client accepts
# them; worth ~18 % of the JS to a self-host, nothing at all on GitHub Pages,
# which ignores them. release.yml runs this before it zips the site.
node scripts/precompress.mjs --dir out
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

CI runs on two paths since v3-14. The required one is fast and partial; the
nightly one is slow and complete. Neither runs less than the union of what CI
ran before: every check that existed still runs, on one path or the other.

### The required path, `.github/workflows/ci.yml`

Push to main and every pull request. Five jobs, all in parallel, one runner
combination (ubuntu-latest, Node 22), and inside each job the cheap check runs
before the expensive one.

| Job | What it runs |
|---|---|
| `lint-typecheck` | static no-skip guard, eslint `--max-warnings 0`, `tsc --noEmit` |
| `unit` | vitest, with the zero skipped/todo check |
| `pytest` | `services/bake` pytest, with the zero skipped/xfailed check |
| `build-and-validate` | `next build`, then both `export:cli` runs on the Chicago fixture judged by the Python validator |
| `e2e-smoke` | the `@smoke` Playwright subset, `E2E_BUDGET_FACTOR=3`, results.json checked, `fixtures/` checked for strays |

**Exactly three Playwright tests run on the required path**, all in
`smoke.spec.ts`, selected by the `@smoke` tag:

1. an empty Overpass response warns and disables Export
2. the downloaded file passes the Python printability validator, small scene
3. exporting a Bambu Studio project writes every region on its own extruder

**The happy path is NOT one of them.** "Chicago preset previews, sliders stay
local, export downloads a 3MF" is the most representative test in the suite and
it is the one test deliberately excluded, because it costs 2m 12s locally and 5
to 8 minutes on a runner with no GPU. It runs nightly. The measurement and the
reasoning are in the comment on `projects` in `apps/web/playwright.config.ts`.

**What a green required run does NOT prove.** It is a partial signal and should
be read as one:

- Every acceptance test outside those three did not run: accessibility,
  colour, lettering, perf, print, sharing, terrain, place search, the whole UI
  file and the workflow file. Run `npx playwright test --project=chromium
  --list` for the current total; it grows most weeks.
- **The r3f preview was never rendered at Chicago scale, and 01/A3's "a
  PrintParams change causes no page reload" was never asserted.** Both live
  only in the happy path. `build-and-validate` proves the engine builds and
  exports 992 Chicago buildings the validator accepts; it says nothing about
  whether the preview draws them or whether a slider reloads the page. A
  regression that leaves the export green and the canvas blank reaches main and
  waits for 03:30 UTC. This is the largest single risk the fast path accepts.
- `make gate-v2` did not run. No v1 golden check, no parts/plate/ornament
  geometry gate.
- Two of the seven export targets were exercised: generic-3mf through
  `export:cli` in both colour modes, and bambu-3mf through the UI in the
  `@smoke` Bambu test. The other five, and tiling, did not run.
- One of the six presets was exercised, and only as an already-normalised
  SceneGraph, never as a raw Overpass response.
- No desktop installer was built on any platform.

Everything in that list runs nightly. `make gate` is still the full local gate
and is what a release should be judged on.

The suite sizes above were measured with `npx playwright test --list`. Re-run
it rather than trusting the numbers: specs land often.

### The nightly path, `.github/workflows/nightly.yml`

03:30 UTC daily, on `workflow_dispatch`, and on a `v*` tag so the heavy set
runs before release.yml builds installers on that same tag.

| Job | What it runs |
|---|---|
| `e2e-full` | the whole Playwright suite, `E2E_BUDGET_FACTOR=3`, same results.json guard, same stray-fixture check |
| `geometry-gates` | `make gate-v2` |
| `export-matrix` | `scripts/ci-export-matrix.sh`: all seven `export_target` values plus a 2x2 tiled build, each tile validated |
| `preset-matrix` | `scripts/ci-preset-matrix.sh`: all six presets offline through their committed Overpass fixtures, each `.3mf` and `.stl` validated |
| `desktop` | the three installers, via the shared `desktop-build.yml`; skipped on the tag trigger because release.yml builds them there |

The export matrix judges what the validator can actually judge, and prints
which kind of row each target got:

- **Full printability verdict** (`make validate`, ALL CHECKS PASS asserted):
  generic-3mf, stl, and each of the four 2x2 tiles.
- **Structure only** (the file is non-empty and carries the parts that make it
  that format): bambu-3mf, color-change-3mf, stl-parts-zip, obj, step.

Two reasons for that split, both measured. `services/bake`'s CLI accepts
`.3mf` and `.stl` only, which rules the validator out for the zip, the OBJ and
the STEP. And a Bambu project, though it is a `.3mf`, puts its mesh in
`3D/Objects/object_1.model` rather than `3D/3dmodel.model`, where the
structural checks do not resolve: run on the full Chicago build the validator
did not finish in 14 minutes of wall clock, against 11 seconds for a generic
3MF. A structure row is weaker than a validated one, and it is still more than
the old CI did with those five formats, which was nothing.

### Running either path locally

```sh
make gate-fast      # the required path, same checks, same @smoke subset
make gate-nightly   # the nightly set, minus the cross-platform installers
make gate           # unchanged: the full local gate, every e2e test
```

`make gate-nightly` cannot build the macOS and Linux installers on this host;
the nightly `desktop` job is the only place all three are covered.

### Caching

Every cache is keyed explicitly rather than by `setup-node`'s or `setup-uv`'s
internal key, so the key is a value the workflow can name and assert on.

| Cache | Path | Key |
|---|---|---|
| npm | `~/.npm` | `apps/web/package-lock.json` hash |
| uv | `~/.cache/uv` | `services/bake/uv.lock` hash |
| Playwright browsers | `~/.cache/ms-playwright` | the `@playwright/test` version read out of the lock file |
| next build | `apps/web/.next/cache` | lock hash plus a hash of `app/`, `components/`, `lib/`, `store/`, `public/` and the configs |

`.github/actions/cache-report` writes one row per cache into the job summary
and fails the job on a WARM MISS: a key that already existed, on a ref this run
could read, created before this run started. A cold miss (a new lock file, or
the first run after a cache was added) is reported and does not fail. The
`next build` cache reports but never fails, because its key changes on every
source edit and a miss there is the normal outcome on a real pull request.

- `.github/workflows/desktop-build.yml`: the Tauri matrix as a reusable
  workflow, called by release.yml with a tag to attach to, and by nightly.yml
  with none, so the two cannot drift.
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
- **A bad service worker on the deployed site: `?sw-off`.** The worker
  (`apps/web/public/sw.js`) serves `/_next/static/**` cache-first and forever,
  so a worker that ships with a caching bug is the thing serving the page and
  cannot be fixed by deploying over it alone. Send the visitor to
  `https://<host>/framecraft/?sw-off`. That unregisters every worker on the
  origin, deletes every cache whose name starts with `framecraft-`, and
  REMEMBERS the choice in `localStorage` (`framecraft.sw.off`), so following
  navigations stay clean without the query string. `?sw-on` puts it back.
  Nothing else on the origin is touched, and neither flag needs a deploy.
  Registration is skipped entirely under `next dev`, on an insecure origin,
  and inside the Tauri desktop shell (`lib/serviceWorker.ts:shouldRegister`).

## 9. Known limitations (v3.1)

- The browser engine fails `make validate` on ONE of the six preset cities:
  tokyo-shinjuku, `min_wall` on four of 468 sampled regions, narrowest
  0.204 mm (re-measured 2026-09-05 on the current tree). The other five
  (chicago-loop, new-york-midtown, paris-eiffel, london-city,
  san-francisco-fidi) read ALL CHECKS PASS, as does the Python reference
  pipeline on all six.

  **This is worse than the two regions at 0.254 mm published earlier, not a
  restatement of it.** The v3.1 geometry work took five cities from failing to
  passing and left the sixth thinner and failing in two more places. Two of
  the four sites are the ones already diagnosed (z = 2.969 mm, 0.2539 mm, and
  z = 4.911 mm, 0.4989 mm, both unchanged to four decimals); the two new ones
  are at z = 2.575 and 2.625 mm, the deterministic recess probes inside the
  water and road bands, both 0.204 mm on the ground slice. Prime suspect:
  `mergeRecessRidges` moving onto the frame-on path in this same work.
  Tracked as `[V3.1-P7-25]` with an owner, so treat these numbers as the
  current state; if the fix lands they change again. The sites and the
  backed-out repairs are in `docs/handoff/FAILURES.md`. Reproduction:
  `docs/handoff/v3-08-siteperf.md` section 7.5 with the Tokyo fixture and
  `--center 35.6896,139.7006`; the build is deterministic, two runs gave the
  same four regions and the same widths.
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
