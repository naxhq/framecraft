# 02 TECH SPEC

## Stack, decided

Do not relitigate these.

- Frontend: Next.js 15 App Router, TypeScript strict, Tailwind, zustand for
  editor state, react-three-fiber and drei for the 3D view, MapLibre GL for the
  2D picker.
- Bake service: Python 3.12, FastAPI, uvicorn. Libraries: `shapely`, `pyproj`,
  `numpy`, `manifold3d`, `trimesh`, `httpx`, `pydantic` v2.
- Job handling: in-process `asyncio` task registry with a dict of job ids.
  No Redis, no Celery, no queue broker in the MVP.
- Storage: local `./artifacts` volume served by FastAPI at `/files/{id}`.
- Orchestration: `docker-compose.yml` with two services plus a `Makefile`.
- Tests: `pytest` for Python, `vitest` for TS units, one Playwright smoke test.

**Boolean engine is `manifold3d`, not CGAL, not trimesh booleans, not pymesh.**
It is fast, it guarantees manifold output, and it has clean Python bindings.
This is the highest-leverage decision in the build.

## Repo layout

```
framecraft/
  apps/web/                  Next.js app
    app/
    components/editor/       ParamPanel, PresetRow, BakeButton, StatsCard
    components/scene/        CityPreview, InstancedBuildings, RoadRibbons
    components/map/          LocationPicker
    lib/contracts.ts         generated from packages/contracts
    lib/preview.ts           SceneGraph + PrintParams -> three.js geometry
    store/editor.ts
  services/bake/
    app/main.py              FastAPI routes
    app/ingest/overpass.py   Overpass client + fixture cache
    app/ingest/normalize.py  raw OSM -> SceneGraph
    app/geom/project.py      lat/lon -> local metric, crop, rotate
    app/geom/thicken.py      min-feature widening (see 04)
    app/geom/extrude.py      polygons -> solids
    app/geom/assemble.py     union everything into one manifold
    app/export/mf3.py        3MF writer
    app/export/stl.py
    app/validate/checks.py   the gate validators
    tests/
  packages/contracts/
    schema/*.json            JSON Schema, single source of truth
    gen_ts.py                emits apps/web/lib/contracts.ts
  fixtures/                  cached Overpass JSON per preset
  artifacts/                 bake outputs, gitignored
  docs/handoff/
  .claude/agents/
  docker-compose.yml
  Makefile
```

## The contracts, frozen in phase 1

Everything downstream depends on these. Phase 1 writes them as JSON Schema in
`packages/contracts/schema/` and generates both Pydantic models and TS types.
No later phase may change a field name without writing the change into
`DECISIONS.md`.

### `SceneRequest`

```json
{ "lat": 41.8827, "lon": -87.6233, "radius_m": 900,
  "rotation_deg": 0, "preset_id": "chicago-loop" }
```

`preset_id` is optional and only selects a cached fixture.

### `SceneGraph`

The intermediate representation. Produced once per location. Coordinates are
**meters in a local ENU frame with the requested center at (0,0)**, x east,
y north. Never pass lat/lon past this boundary.

```json
{
  "bounds": { "min_x": -900, "min_y": -900, "max_x": 900, "max_y": 900 },
  "center": { "lat": 41.8827, "lon": -87.6233 },
  "buildings": [
    { "id": "w123", "ring": [[x,y], ...], "holes": [[[x,y], ...]],
      "height_m": 92.0, "height_source": "tag|levels|default",
      "min_height_m": 0.0, "is_tall": true }
  ],
  "roads": [
    { "id": "w456", "path": [[x,y], ...], "width_m": 12.0,
      "class": "motorway|primary|secondary|residential|service|path" }
  ],
  "water":  [ { "ring": [[x,y], ...], "holes": [] } ],
  "green":  [ { "ring": [[x,y], ...], "holes": [] } ],
  "trees":  [ { "x": 12.4, "y": -88.1, "radius_m": 4.0 } ],
  "stats":  { "building_count": 1841, "coverage": "good|sparse|empty",
              "height_tag_ratio": 0.34 }
}
```

`is_tall` is `height_m >= 40`. It drives the small/large scale sliders and must
be computed once here, not recomputed in two places.

### `PrintParams`

```json
{ "plate_mm": 180, "base_thickness_mm": 3.0, "nozzle_mm": 0.4,
  "small_scale": 1.0, "large_scale": 1.0, "terrain_exaggeration": 1.0,
  "road_mode": "engrave", "road_scale": 1.0,
  "trees": true, "water": true, "frame": true }
```

### `BakeResult`

```json
{ "job_id": "...", "status": "queued|running|done|failed",
  "files": { "3mf": "/files/ab12.3mf", "stl": "/files/ab12.stl" },
  "stats": { "triangles": 412330, "volume_mm3": 39122.5,
             "bbox_mm": [180, 180, 41.2], "est_grams": 48.6,
             "is_manifold": true, "min_wall_mm": 0.81 },
  "warnings": ["47 buildings widened to meet minimum feature size"] }
```

## API surface

- `POST /scene` body `SceneRequest` returns `SceneGraph`. Cached by a hash of
  the request for 24 hours on disk.
- `POST /bake` body `{ scene_request, print_params }` returns
  `{ job_id }` immediately.
- `GET /bake/{job_id}` returns `BakeResult`.
- `GET /files/{name}` serves an artifact.
- `GET /presets` returns the six preset `SceneRequest` objects.
- `GET /health`.

## The one architectural rule that matters

**The browser never runs booleans, and the server never runs the preview.**

The preview path takes `SceneGraph` plus `PrintParams` and builds three.js
geometry with instanced boxes for buildings, extruded shapes for water and
green, and tube or ribbon meshes for roads. No CSG. It must handle 5000
buildings at interactive rates, so use `InstancedMesh` with a per-instance
matrix, and rebuild only the affected instance buffer when a slider moves.

The bake path takes the same two objects and runs the real solid pipeline
described in `04`. Both paths must apply scale, height multipliers, and
visibility toggles through **one shared function signature** so they cannot
drift. Implement the transform math once in Python, mirror it once in TS, and
add a test that compares the two on a fixed fixture within 0.01 mm.

## Performance budgets

- `/scene` cold, 900 m radius: under 8 s. Warm from fixture: under 300 ms.
- Preview build from SceneGraph: under 1.5 s for 3000 buildings.
- Slider re-render: under 33 ms.
- Bake, 900 m radius, 2000 buildings: under 90 s.

If the bake exceeds budget, the fix is to reduce boolean count by batching
buildings into groups of 200 before union, not to lower quality.
