# FrameCraft

Web app that turns a map location into a 3D-printable framed miniature city:
MapLibre picker -> `POST /scene` (OSM via Overpass -> SceneGraph, meters in a
local ENU frame) -> live react-three-fiber preview -> `POST /bake` (manifold3d
solid pipeline per `04_PRINTABILITY_SPEC.md`) -> `.3mf` / `.stl` download.

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

- `packages/contracts/` is FROZEN after phase 1. No field may be renamed or
  removed without a line in `DECISIONS.md`. Regenerate, never hand-edit,
  `apps/web/lib/contracts.ts`.
- Boolean engine is `manifold3d`. The browser never runs booleans; the server
  never runs the preview. Preview and bake share one transform-math signature
  (Python + TS mirror, parity test within 0.01 mm).
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
· `make down` · `make clean`.

## Ports

Web `localhost:3000`, bake API `localhost:8000` (`/health`, `/presets`,
`/scene`, `/bake`, `/bake/{id}`, `/files/{name}`).
