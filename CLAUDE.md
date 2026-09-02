# FrameCraft

Web app that turns a map location into a 3D-printable framed miniature city.
Since v3 the whole pipeline runs client-side: MapLibre picker -> Overpass fetch
and normalize in a worker (`apps/web/lib/engine/osm`) -> SceneGraph (meters,
local ENU) -> manifold3d WASM solid engine (`lib/engine/solid`, second worker)
-> one EngineResult feeding the r3f preview, the filament mapper and every
exporter (Bambu project 3MF, generic 3MF, STL, OBJ, STEP, colour-change) ->
Blob or Tauri save. `services/bake` is the Python reference implementation and
CLI validator (`make validate`), not a runtime dependency.

Specs are the source of truth: `01_PRODUCT_SPEC.md`, `02_TECH_SPEC.md`,
`03_GEODATA_SPEC.md`, `04_PRINTABILITY_SPEC.md`, `05_AGENT_TEAM.md`.
Decisions log: `DECISIONS.md` (append-only). Phase notes: `docs/handoff/`.

## Repo layout (from 02)

```
apps/web/                  Next.js 15 App Router, TS strict, Tailwind, zustand, r3f+drei, MapLibre
  app/  components/{editor,scene,map}/  lib/contracts.ts (GENERATED)  lib/preview.ts  store/editor.ts
services/bake/             Python 3.12, FastAPI, uvicorn; shapely, pyproj, numpy, manifold3d, trimesh, httpx, pydantic v2
  app/main.py  app/ingest/{overpass,normalize}.py  app/geom/{project,thicken,extrude,assemble}.py
  app/export/{mf3,stl}.py  app/validate/checks.py  tests/
packages/contracts/        schema/*.json (single source of truth) + gen_ts.py -> apps/web/lib/contracts.ts
fixtures/                  cached Overpass JSON per preset + chicago-scene.json sample SceneGraph
artifacts/                 bake outputs (gitignored)
docs/handoff/              phase notes NN-<phase>.md, STATUS.md, FAILURES.md
.claude/agents/            the six subagent definitions
docker-compose.yml  Makefile  RUNBOOK.md
```

## Hard rules

- `packages/contracts/` is FROZEN at **schema version 3** (re-frozen 2026-09-02;
  v1/v2 fields unchanged, v3 fields optional with v2-identical defaults, pinned
  by `tests/test_v1_compat.py` against `fixtures/v1-golden/`). No rename/removal
  without a `DECISIONS.md` line. `make contracts` regenerates both outputs;
  never hand-edit `contracts.ts` / `contracts.py`.
- Boolean engine is `manifold3d`, running as WASM in the browser engine
  (`apps/web/lib/engine`); the Python service uses the same kernel as the
  reference validator. Preview, mapper and exports read one EngineResult, and
  shared transform math stays mirrored (Python + TS, parity fixtures).
- SceneGraph coordinates are meters, local ENU, center at (0,0). No lat/lon
  past that boundary. Never Web Mercator for geometry.
- OSM only (Overpass + OSM raster tiles). Google/Apple/Bing sources are forbidden.
  Attribution `© OpenStreetMap contributors` in the footer, 3MF metadata, CREDITS.txt.
- No placeholder deliverables. Stubs only for items listed out of scope in `01`.
- Python: use `uv` (`services/bake/pyproject.toml`, Python 3.12). Web: `npm`.
- This dev host is Windows 11 without Docker; `make` targets must work natively
  (uv + npm) and under docker compose. Use POSIX sh in Makefile recipes.

## Make targets

`make up` (start both services; docker compose if present, else native)
`make dev` (native, foreground) · `make install` · `make test` · `make gate`
(pytest + vitest + next build + Playwright smoke) · `make bake-fixture`
(Chicago preset -> `artifacts/chicago.3mf`) · `make validate FILE=...`
(CLI validator table) · `make refresh-fixtures` (re-fetch Overpass fixtures)
· `make gate-v2` (G5 + G6 + G8: parts, text, v1 golden) · `make down` · `make clean`.

## Ports

Web `localhost:3000` (standalone since v3); reference bake API
`localhost:8000` (optional, only for the Python service's own API and tests).

## Git authorship

Every commit is authored by `Vahid Alizadeh <vahid.alizadeh@gmail.com>` only.
No `Co-Authored-By:` trailers, no session links, no generator lines in commit
messages. The repo-local `git config user.name/user.email` is already set;
subagents must not commit (the orchestrator commits per phase).
