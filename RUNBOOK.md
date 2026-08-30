# FrameCraft RUNBOOK

Pick a spot on a map, tune it in a live 3D editor, download a watertight,
print-ready framed miniature of that place as `.3mf` (or `.stl`). v2 (schema
version 2) adds parts-based multi-colour 3MF export, border text and frame
ornaments, a detail advisor with hero buildings, shareable links and a redesigned
editor; a default-constructed v2 bake is byte-identical to v1.

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
| `make bake-fixture` | bake the Chicago preset offline at default params to `artifacts/chicago.3mf` (+ `.stl`, sidecar `.json`, `CREDITS.txt`) and print the validator table. Variables: `COLOR=parts` (parts-mode 3MF -> `artifacts/chicago-parts.3mf`), `TEXT=all` (text on all four edges, north arrow, scale bar, keyhole, underside mark -> `artifacts/chicago-text.3mf`; both -> `chicago-parts-text.3mf`), `PLATE=<100..256>` (plate override, range-checked by the Makefile against the contract's own `plate_mm` bounds; it takes a stem suffix like the other two, so `PLATE=256` writes `chicago-p256.3mf` and `COLOR=parts PLATE=256` writes `chicago-parts-p256.3mf` and neither can overwrite the default artifact) |
| `make validate FILE=x.3mf` (or `make validate x.3mf`) | run the printability validator CLI on a `.3mf`/`.stl`: the nine checks from `04`, the v2 rows (`bodies`, `part_meshes`, `parts_union`, `lettering`, `base_floor`) and the 3MF container rows (`3mf_parts`, `3mf_objects`, `3mf_counts`, `3mf_materials`, `3mf_components`, `3mf_color_mode`, `3mf_attribution`), exit 1 on any FAIL. Parameters come from the bake's `<stem>.json` sidecar; an unusable sidecar is a `sidecar_params` FAIL row (exit 1) and `--plate-mm` / `--nozzle-mm` then say what to judge the file against |
| `make gate-v2` | G5 + G6 + G8 in one run: `tests/test_v1_compat.py` (v1 golden, `11 passed` and nothing skipped both asserted), parts bake at plate 180 (6 parts, `chicago-parts`) and 256 (7 parts, `chicago-parts-p256`), `TEXT=all`, `COLOR=parts TEXT=all`, `make validate` on each `.3mf` and `.stl`; the `lettering` rows must PASS **with a non-zero stroke count**, not merely PASS; non-zero on any failure |
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

v2 additions (schema version 2, all optional fields with v1-identical defaults,
pinned by `services/bake/tests/test_v1_compat.py` against the v1 golden in
`fixtures/v1-golden/`): `color_mode: parts` makes the bake write one 3MF mesh
object per non-empty layer (base, frame, buildings, roads, water, green, trees,
plus one per own-colour hero), each with `pid/pindex` into a single
`<basematerials>` coloured from `part_colors`, assembled by one `<components>`
object and one build item; the parts partition the single-mode solid (water and
engraved roads become 0.6 mm inlays under the recess floor, every additive part
is cut by the recess cutters, the union is checked against the single-mode solid
to a 1e-6 mm^3 symmetric-difference bound) and the STL stays one welded body.
`app/geom/lettering.py` cuts border text from three bundled OFL faces (Inter,
Source Serif 4, JetBrains Mono via fontTools; counters as holes; the same Stage 1
repair and inscribed-circle measure as every other layer; engrave/emboss on the
6 mm lip; auto-fit with a warning; refusal naming a measured working size), plus
a north arrow, a 1-2-5 scale bar, a mirrored underside mark, and keyhole / magnet
hanger pockets that refuse thin bases. Token expansion ({city} {coords} {lat}
{lon} {scale} {radius} {date} {buildings}) and the text layout live in shared
Python/TS pairs (`geom/tokens.py`/`lib/tokens.ts`, the layout functions in the
transform pair) pinned by `fixtures/tokens-expected.json` and
`fixtures/lettering-expected.json`, so the preview draws text and ornaments as
flat fills at the exact printed positions (glyph outlines in
`apps/web/lib/fonts/*.glyphs.json`, generated from the same TTFs). The detail
advisor (`detail_report`, `recommend_radius_m`, `recommend_plate_mm`,
`detail_recommendation`) solves for the radius or plate that keeps the widened
fraction under 25% and is shown as a HUD health chip with real "Use N m" /
"Use plate N" actions. Hero buildings (click or keyboard pick, max 12) keep their
true height under the scale sliders and can be their own coloured part. The
editor state round-trips through `?s=v2.<base64url JSON diff>.<fnv1a32>` share
links. The editor itself was rebuilt on a CSS-token design system with
self-hosted OFL fonts (Archivo, IBM Plex Sans), grouped collapsible controls, a
warnings chip + drawer, a viewport HUD (scale, predicted height, min wall,
health), keyboard shortcuts, WCAG AA text and non-text contrast (a vitest
computes it), a real Tab-walk test and an axe-core pass in the Playwright gate.

## 4. Verification status (this host: Windows 11, 32 cores, no Docker, no GPU)

v2 run, 2026-08-30, every gate run by the orchestrator on the final tree:

| Gate | Command | Result |
|---|---|---|
| G1 | `make up && curl -sf localhost:8000/health && curl -sf localhost:3000` | PASS (/health ok, web 200, `make down` frees both ports) |
| G2 | `cd services/bake && uv run pytest tests/test_ingest.py -q` + Chicago `/scene` | PASS - 123 tests; 994 buildings, coverage `good`, 0.25 s |
| G3 | `make bake-fixture && make validate artifacts/chicago.3mf` | PASS - 68,692 triangles, one body, min wall 0.8016 mm (byte-identical to v1) |
| G4 / G7 | `make gate` | PASS - 510 s: static no-skip guard, 601 pytest, lint + `tsc --noEmit` + 537 vitest + `next build`, 26 Playwright (incl. axe-core in both themes, Tab walk, share-link round trip, hanger refusal), 0 skipped / 0 expected-failure (enforced five ways), teardown checked, fixtures clean |
| G5 | `make bake-fixture COLOR=parts && make validate artifacts/chicago-parts.3mf` | PASS - 6 parts / 6 basematerials / 1 build item at plate 180 (no printable tree at 1:10,714); `COLOR=parts PLATE=256` -> `artifacts/chicago-parts-p256.3mf`, 7 / 7; every part and the union pass; `.stl` one body |
| G6 | `make bake-fixture TEXT=all && make validate artifacts/chicago-text.3mf` | PASS - 180 x 180 x 35.73 mm, 89,466 triangles, `lettering` 126 strokes of 7 pieces, 0.488 mm stroke / 0.765 mm ridge, `base_floor` 0 mm^2 gap over keyhole + underside mark |
| G8 | `cd services/bake && uv run pytest tests/test_v1_compat.py` | PASS - 11 tests; digest 0e20725e... from a worktree of v1 commit da9ab83 |
| gate-v2 | `make gate-v2` | PASS - 144 s (G8 + G5 at 180/256 + G6 with 126 measured strokes + `COLOR=parts TEXT=all`, each validated as `.3mf` and `.stl`) |

v1 acceptance (01) still holds: A1 preset -> preview 0.09-0.2 s warm; A2 lake pin
shows the low-coverage warning and disables Bake (now a hard assertion, no skip);
A3 zero server calls on any PrintParams change including every v2 control
(asserted), fps measured under SwiftShader only; A4 Chicago bake 10-16 s through
the UI (budget 90 s); A5 every validator on the baked and the downloaded file;
A6 proxied (trimesh Scene load + container rows; manual Bambu/PrusaSlicer
procedure in `docs/handoff/v2-02-color.md`); A7 `make install && make up` from a
clean clone (verified for v1; v2 adds only committed assets: fonts, glyph JSON,
goldens). Every phase has a builder note `docs/handoff/v2-0N-*.md` and an
adversarial audit `docs/handoff/v2-0N-audit.md` with a Resolution section;
judgment calls are `[V2-*]` lines in `DECISIONS.md`; `docs/handoff/FAILURES.md`
F2 records the one gate failure of the run (a stale e2e size, fixed).

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

v2 limitations and deliberate deviations (each has a `DECISIONS.md` line):

- No preset prints a single tree at the default plate/radius: every OSM tree is
  capped at 4.0 m, which is 0.37 mm at 1:10,714, under `04`'s 0.5 mm floor. A
  default Chicago parts bake therefore has 6 parts; 7 parts (with trees) needs
  `COLOR=parts PLATE=256` (`artifacts/chicago-parts-p256.3mf`). `make gate-v2`
  checks both.
- Engraved text strokes (grooves) are widened to ONE nozzle, embossed strokes and
  the ridges between grooves to `min_wall` (two nozzles): a two-nozzle groove
  merges letters for descender strings under ~4.9 mm, and a one-nozzle groove
  admits one extrusion width. The audit's numbers are in
  `docs/handoff/v2-03-audit.md`.
- The contract default engraving `size_mm` is 4.0, not the brief's 3.0: at 3.0
  the sans face refuses 6 of 8 real strings on a 0.4 mm nozzle
  (`docs/handoff/v2-03-lettering.md` §8a). Refusals name the size that works.
- The parts-mode `bodies` rule is "one mesh object per part, no debris shells,
  the union is one solid", not "one connected shell per part": a buildings part
  is by construction hundreds of disconnected blocks.
- A6 (opens in Bambu Studio / PrusaSlicer as one object with N parts) is still
  proxied on this host (trimesh Scene load, container rows); the manual procedure
  is in `docs/handoff/v2-02-color.md`.
- The detail-advisor score is a heuristic (Chicago at defaults scores 70,
  band `fair`); the recommendation math is exact but the bands are judgment.
- The preview draws text, ornaments and pockets as flat fills at the printed
  positions (no recess/emboss depth), the underside mark is only visible when
  orbiting below the plate, and keyboard hero picking walks buildings
  tallest-first rather than spatially.
- Share links are uncompressed (up to ~4 k chars ASCII / ~5.7 k CJK at the
  contract maxima) and carry no scene data: opening one restores the editor and
  marks the scene for Generate.
- `02_TECH_SPEC.md` still documents the v1 `PrintParams`; the v2 schema in
  `packages/contracts/schema/print_params.json` is the source of truth.
- The Playwright suite has exactly one live-Overpass touch (a rotation nudge /
  advisor radius click on the Chicago preset); everything else runs from the
  committed fixtures.

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
