# FrameCraft RUNBOOK

Pick a spot on a map, tune it in a live 3D editor, download a watertight,
print-ready framed miniature of that place as `.3mf` (or `.stl`).

Data: OpenStreetMap only (Overpass + OSM raster tiles). Attribution
`© OpenStreetMap contributors` is in the app footer, the 3MF `Description`
metadata and a `CREDITS.txt` next to every export. Google/Apple/Bing sources are
forbidden by design and by review.

## 1. Setup

Prerequisites (native run, any OS):

| Tool | Version used | Notes |
|---|---|---|
| `uv` | 0.12 | installs Python 3.12 itself (`.python-version` in `services/bake`) |
| Node + npm | Node 20+ (26 used) | `apps/web` uses `npm ci` with a committed lock file |
| GNU make | 4.x | on Windows: `winget install ezwinports.make` (Git Bash provides `sh`) |
| curl | any | used by `make up` health polling and the gates |
| Docker + compose | optional | `make up` uses `docker compose` when present, native processes otherwise |

```
git clone <repo> framecraft && cd framecraft
make install        # uv sync + npm ci + playwright chromium
make up             # bake API on :8000, web on :3000 (waits for /health and /)
open http://localhost:3000
make down
```

Windows: run `make` from Git Bash. The Makefile recipes are POSIX `sh`; `make
up` finds the real PIDs behind the ports and `make down` uses `taskkill` so the
child `node`/`python` processes die too. Never pipe `make up` through another
command from a tool shell (the background children keep the pipe open);
redirect it to a file instead.

Environment knobs: `NEXT_PUBLIC_BAKE_API_URL` (default `http://localhost:8000`),
`FRAMECRAFT_WEB_MODE=prod` (`make up` serves `next build && next start` instead
of `next dev`), `FRAMECRAFT_OFFLINE=1` (any Overpass network attempt raises;
presets keep working from the committed fixtures - the test suites set this).

## 2. Make targets

| Target | What it does |
|---|---|
| `make help` | list targets (default) |
| `make install` | `uv sync` in `services/bake`, `npm ci` in `apps/web`, `npx playwright install chromium` |
| `make contracts` | regenerate `services/bake/app/contracts.py` and `apps/web/lib/contracts.ts` from `packages/contracts/schema/*.json` (never hand-edit the outputs) |
| `make up` / `make down` | start / stop both services (docker compose if available, else native, idempotent) |
| `make dev` | both services natively in the foreground, Ctrl-C stops both |
| `make test` | pytest (`services/bake`) + vitest (`apps/web`) |
| `make gate` | G4: pytest + eslint + `tsc --noEmit` + vitest + `next build` + Playwright smoke against the real stack; brings the stack up and down itself, checks the teardown really freed :8000/:3000, non-zero on any failure |
| `make bake-fixture` | bake the Chicago preset offline to `artifacts/chicago.3mf` (+ `.stl`, sidecar `.json`, `CREDITS.txt`) and print the validator table |
| `make validate FILE=x.3mf` (or `make validate x.3mf`) | run the printability validator CLI on a `.3mf`/`.stl`: the nine checks from `04` plus 3MF container checks, exit 1 on any FAIL. Parameters come from the bake's `<stem>.json` sidecar; an unusable sidecar is a `sidecar_params` FAIL row (exit 1) and `--plate-mm` / `--nozzle-mm` then say what to judge the file against |
| `make refresh-fixtures` | re-fetch the six preset Overpass responses into `fixtures/` (network) |
| `make clean` | remove `.next`, baked artifacts, `.run`, logs |

Ports: web `localhost:3000`; bake API `localhost:8000` with `GET /health`,
`GET /presets`, `POST /scene`, `POST /bake`, `GET /bake/{job_id}`,
`GET /files/{name}`. OpenAPI docs at `localhost:8000/docs`.

## 3. Architecture

The browser (Next.js 15, App Router, react-three-fiber, MapLibre, zustand)
posts a `SceneRequest` (lat, lon, radius, rotation, optional preset) to the
FastAPI bake service, which fetches one Overpass query (cached to
`fixtures/<sha1>.json`, presets never touch the network), normalises OSM into a
`SceneGraph` (metres in a local UTM/ENU frame centred at the pin, heights
inferred per `03`, seven-step geometry hygiene, rotate-then-crop, coverage
classification) and caches it for 24 h. The editor turns `SceneGraph` +
`PrintParams` into three.js geometry with no CSG (one `InstancedMesh` for
buildings, ribbon roads, earcut water/green, instanced cone trees) so every
slider re-renders locally; only location, radius and rotation refetch. `Bake`
runs the `04` solid pipeline server-side in a worker thread: 2D minimum-feature
repair with shapely (dilation, gap closing, 80th-percentile block heights,
tree filtering), extrusion and batched tree-shaped unions in `manifold3d`
(chamfered plate, frame lip, engraved/embossed roads, recessed water, raised
green), then a hand-written 3MF (+ binary STL, sidecar JSON, CREDITS.txt) that
must pass all validators (manifold, watertight, volume, self-intersection,
bounding box, sits-at-zero, min wall probe, triangle budget, degenerate faces)
before the job is marked `done`. Preview and bake share one transform-math
module implemented twice (`services/bake/app/geom/transform.py`,
`apps/web/lib/transform.ts`) and pinned by a parity fixture to 0.01 mm; the four
wire contracts live as JSON Schema in `packages/contracts/` and are frozen.

## 4. Verification status (this host: Windows 11, 32 cores, no Docker, no GPU)

| Gate | Command | Result |
|---|---|---|
| G1 | `make up && curl -sf localhost:8000/health && curl -sf localhost:3000` | PASS (~8 s to healthy) |
| G2 | `cd services/bake && uv run pytest tests/test_ingest.py -q` + Chicago `/scene` | PASS - 994 buildings, coverage `good`, 35 ms cold / 8 ms warm |
| G3 | `make bake-fixture && make validate artifacts/chicago.3mf` | PASS - 11 s, 180x180x34.7 mm, 68,682 triangles, 1 watertight body, min wall 0.81 mm |
| G4 | `make gate` | PASS - 327 pytest, 140 vitest, lint + `tsc --noEmit` + build clean, 2 Playwright e2e, teardown checked, 180 s |
| A7 | clean clone -> `make install && make up` | PASS - 134 files / 68 MB, install 16 s, up 16 s, /health + web 200, `make bake-fixture` 10 s, `make validate` ALL CHECKS PASS, `make down` frees both ports (see `docs/handoff/06-polish.md`) |

Acceptance (01): A1 preset -> preview 0.1-0.3 s warm; A2 lake pin shows the
"fewer than 20 buildings" warning and disables Bake; A3 no server call on any
slider (asserted), ~22-25 fps under headless SwiftShader (30 fps must be
re-measured on real GPU hardware); A4 Chicago bake 9-11 s through the UI
(budget 90 s); A5 all validators pass on the baked file and on the
browser-downloaded file; A6 proxied (trimesh loads the 3MF as one watertight
body at Z=0; the manual slicer procedure is in `docs/handoff/05-qa-gate.md`);
A7 `make install && make up` from a clean copy of the tree (see
`docs/handoff/06-polish.md`). All six presets bake in 3-7 s and pass every
validator. Details per phase: `docs/handoff/0N-*.md`; every judgment call:
`DECISIONS.md`; anything found by a gate and not papered over:
`docs/handoff/FAILURES.md`.

## 5. Known gaps

Out of scope for the MVP per `01` (stubbed or omitted deliberately):

- No accounts, auth, payments or order history.
- No hand-modeled landmark library or landmark substitution.
- Terrain: `terrain_exaggeration` is wired through preview and bake but the
  heightmap is flat (`terrain_z_scale` returns 1.0); the DEM fetcher
  (Copernicus GLO-30 via OpenTopography, API key) is not implemented.
- No multi-tile districts, magnet pockets or magnetic skyline; single material
  only; no server-side thumbnails, email, analytics; mobile layout is untuned.

Real limitations of what was built:

- `min_height_m` (buildings on stilts / bridges) is carried in the contract but
  ignored by both preview and bake; they print solid to the ground.
- Dense downtowns at small radii can exceed the 60 mm Z ceiling at default
  scales; the editor predicts the height from the shared math and disables Bake
  with the reason, and the bake refuses immediately with the same number.
- `height_tag_ratio` is below 0.15 for Chicago, Paris and London (OSM tags
  `building:levels`, not `height`), so the "heights are largely estimated"
  warning is honest and frequent.
- Road sets are footway-heavy (sidewalks map to class `path`); nothing filters
  them, so very large radii print busy surfaces. `building:part` is ignored.
- Editing rotation on a preset leaves the fixture path and needs a live Overpass
  call (bbox depends on rotation); offline it returns 502/503 with a message.
- The self-intersection validator is a sampled check plus manifold3d's
  guarantee, not an exhaustive triangle-pair test.
- On this host `ruff` and the `fast_simplification` wheel are blocked by a
  Windows Application Control policy; decimation falls back to manifold3d (no
  preset is anywhere near the 2M-triangle budget). Docker images are written
  and YAML-validated but were not built here.
- OSM fixtures are a 2026-08-29 snapshot; after `make refresh-fixtures`,
  regenerate `fixtures/chicago-scene.json` (command in
  `docs/handoff/02-geo-ingest.md`).

## 6. Highest-value next features

1. **Lidar / open-data roof geometry** where it exists (city LiDAR, open 3D
   building datasets): replace flat extrusions with real roof forms for the
   buildings that matter most visually, keeping the SceneGraph contract by
   adding an optional roof mesh per building.
2. **Hand-modeled landmark library with geo-anchored substitution**: a curated
   set of landmark meshes keyed by OSM id/footprint, swapped in at bake and
   preview time through the same scale math, so the Willis Tower or the Tour
   Eiffel print as themselves rather than as prisms.
3. **Multi-tile snap-together districts with joinery**: split a large radius
   into tiles that each fit the bed, with alignment pins/pockets generated by
   the same manifold pipeline, so a whole neighbourhood can be printed and
   assembled.
