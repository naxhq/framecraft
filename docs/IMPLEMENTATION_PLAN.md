# FrameCraft v3 implementation plan

Written 2026-08-30 before any v3 implementation code. The architecture of the tree
this plan starts from is in `docs/ARCHITECTURE.md`. Rulings made while executing
this plan are appended to `DECISIONS.md` as `[V3-*]` lines. Phase notes land in
`docs/handoff/v3-NN-<phase>.md`. This file is updated as phases close.

## Ground rules for the run

- The brief's `src/lib/...` paths map to `apps/web/lib/...` (this repo has no `src/`).
- One commit (or short series) per phase, author Vahid Alizadeh only, no trailers.
- After each phase: `npm run typecheck && npm test && npm run build` in `apps/web`,
  `uv run pytest` in `services/bake` when Python changed, Playwright when the UI
  changed, then commit and push; GitHub Actions must be green before the next phase.
- No em dashes in UI copy, docs or comments. The Issues badge is the only warning
  surface. Every new setting: live preview, project file, permalink, undo history.
- Fail soft on every network call (Overpass, Nominatim, DEM tiles).
- Subagents implement; the orchestrator writes docs, decisions and commits.

## The one architectural change

The brief's phases 2 and 8 only fit together if geometry and export run in the
browser. v3 therefore introduces a TypeScript engine, `apps/web/lib/engine/**`, on
the `manifold-3d` WASM package (the same boolean kernel the Python service uses),
executed in a Web Worker. Its output, a list of watertight region meshes, is what
the preview renders, what the filament mapper colours, and what every exporter
writes, so the three cannot disagree. `services/bake` remains as the reference
implementation and the CLI validator used by CI to check the browser engine's
files (`make validate`). See `[V3-A1]`.

Engine interfaces (fixed before the parallel phase 2 work starts):

- `SceneGraph` (unchanged contract type from `lib/contracts.ts`), produced by
  `lib/engine/osm/*` from Overpass JSON. Parity test: the Chicago Loop fixture must
  produce the same layer counts as `fixtures/chicago-scene.json` from the Python
  service.
- `PrintParams` v3 (contracts schema version 3) is the only settings object.
- `RegionMesh { region, positions: Float32Array, indices: Uint32Array, volumeMm3,
  bbox, slot, colorHex }` for regions `base | frame | matting | buildings |
  hero_building | roads | water | parks | rail | lettering | attribution | easel`.
- `EngineResult { regions: RegionMesh[], stats, findings: AuditFinding[],
  resolvedText: ResolvedLine[], tiles?: TileResult[] }`.
- Exporters take `EngineResult + ExportOptions` and return `Uint8Array` files; they
  never touch manifold.

## Phase 0: baseline (this commit)

Files: `docs/ARCHITECTURE.md` (new), `docs/IMPLEMENTATION_PLAN.md` (new),
`tests/fixtures/overpass-chicago-loop.json` (copy of the cached Chicago Loop
Overpass response, 12.7 MB, so engine tests never hit the network),
`.github/workflows/ci.yml` (pytest, vitest, typecheck, build, Playwright with
mocked network), `CLAUDE.md` (authorship rule), `DECISIONS.md` (`[V3-A*]`).
The vitest and Playwright harnesses already exist (`apps/web/vitest.config.ts`,
`apps/web/playwright.config.ts`, `apps/web/e2e/smoke.spec.ts` bakes Chicago).
Then: create `naxhq/framecraft`, push, confirm CI.

## Phase 1: lettering token fix (current stack, no engine yet)

Order: presets gain `cityName` -> token service -> Nominatim reverse geocode ->
override field -> empty-line warnings -> frame-off gating -> resolved output panel
-> tests -> e2e.

Files: `apps/web/lib/presets.ts` (`cityName`), `apps/web/lib/tokens.ts` (the single
resolver: `{city} {lat} {lon} {coords} {scale} {radius} {date} {buildings} {country}
{state} {neighbourhood} {author} {hero}`), `apps/web/lib/geocode.ts` (new: Nominatim
reverse, 1 rps queue, User-Agent, localStorage cache keyed by lat/lon rounded to
3 decimals, fail soft), `apps/web/store/editor.ts` (place context: preset city,
geocode result, user override, `placeName` wins), `apps/web/lib/warnings.ts`
(`engraving-empty-line` with line number and token name, `frame-off-lettering`),
`apps/web/components/editor/EngravingsEditor.tsx` (inline reason, disabled state
with "Turn on Frame to engrave the edges"), `apps/web/components/editor/groups/*`
(Place name field in MODEL, "Resolved output" panel in OUTPUT),
`apps/web/lib/bake.ts` (send resolved strings; skip empty lines), tests next to each
file, `apps/web/e2e/lettering.spec.ts`.

## Contracts v3 (parallel with phase 1)

Files: `packages/contracts/schema/print_params.json` (schema_version 3; new
optional groups: `place`, `regions` depths/heights/skirt, `colour` slots and
palette, `printer_profile`, `export_target`, `terrain`, `heights`, `water`,
`rail`, `bridges`, `height_exaggeration`, `hero_auto`, `tiling`, `frame` styling,
`hanger` extended enum with magnet dims, `attribution` user template, `lettering[]`
mode `inlay`), `packages/contracts/gen_ts.py`, `gen_py.py`, regenerated
`apps/web/lib/contracts.ts` and `services/bake/app/contracts.py`,
`services/bake/tests/test_contracts.py`, `fixtures/v1-golden/*` untouched,
`tests/test_v1_compat.py` must stay green.

## Phase 2: engine, Bambu project 3MF, filament mapping, exports

Three parallel builders with disjoint files, then one integrator.

- E1 ingest: `apps/web/lib/engine/osm/{overpass,normalize,heights,project,scene}.ts`
  (mirror list and failover, 429/504 backoff, IndexedDB cache; height fallback
  chain of phase 3c built in from the start; `railway` ways and `bridge`/`layer`
  tags carried into the SceneGraph as extra layers), tests against the fixture.
- E2 solids: `apps/web/lib/engine/solid/{manifold,regions,base,frame,buildings,
  areas,roads,lettering,ornaments,repair,measure}.ts` producing separate watertight
  solids per region with user-settable inset depth and top height, building skirt,
  Stage 1 style repairs through `CrossSection.offset`, min-wall measurement by
  morphological opening, manifold/genus/bounds checks. Tests bake the Chicago
  fixture scene.
- E3 export: `apps/web/lib/engine/export/{zip,xml,generic3mf,bambu3mf,stl,obj,
  step,colorchange}.ts`, `apps/web/scripts/bake-cli.ts` (Node CLI used by CI and
  `make validate`). Bambu writer verified against the Bambu Studio source
  (`bbs_3mf.cpp`) and loaded with the installed `bambu-studio.exe` CLI.
- E4 integration (`web-editor`): `apps/web/lib/engine/worker.ts`, `lib/engine/
  client.ts`, `lib/bake.ts` (Bake -> worker -> file), `components/editor/
  ExportMenu.tsx` (Bambu 3MF, generic 3MF, STL single, STL per-region zip, OBJ+MTL,
  STEP, single-nozzle colour-change), COLOUR panel region rows with slot selector
  and swatch, merge-to-N-slots, preview recolour from engine meshes
  (`components/scene/RegionMeshes.tsx`), warnings, e2e updated to the engine flow
  with Overpass mocked from the fixture.

## Phase 3: geometry and realism

Files: `apps/web/lib/engine/terrain/{tiles,heightfield}.ts` (Terrarium tiles,
exaggeration, smoothing, drape), `lib/engine/solid/base.ts` (heightfield top),
`lib/engine/solid/{areas,roads}.ts` (drape, recessed water, bridges with
abutments, rail region), `lib/heroes.ts` (auto scoring: height, area, landmark
tags, wikidata; `{hero}` token), `lib/engine/osm/heights.ts` (settings for floor
height and unknown default, fallback counts to the status bar),
`lib/transform.ts` + `services/bake/app/geom/transform.py` + parity fixture
(height exaggeration curve is shared math), UI groups TERRAIN, HEROES, HEIGHTS.

## Phase 4: print, export, validation

Files: `apps/web/lib/printers.ts` (profiles H2S, P1S, X1C, A1, A1 mini, MK4,
Mini, Ender 3, Custom), `lib/engine/audit/{rules,fixes}.ts` (thin walls,
islands, overhangs, merged buildings, tiny text, bounds, slot beyond profile;
one-click fixes; auto-fix all safe), `lib/engine/estimate.ts` (volume, grams,
metres, time model), `lib/engine/solid/tiling.ts` (N x M split, dovetail or
pin-and-socket, tolerance, tile index engraving), preview overlay
`components/scene/TileGrid.tsx`, OUTPUT panel estimate block, PRINTER group.

## Phase 5: frame and colour expansion

Files: `lib/engine/solid/frame.ts` (profiles plain, chamfer, stepped, bevel-in,
bullnose, ogee, floating; corners square, mitred, rounded; shadow gap; matting;
separate frame part with snap-fit or magnet mating; face textures),
`lib/engine/solid/lettering.ts` (inlay mode as its own region, up to eight lines
on five surfaces), `lib/engine/solid/hangers.ts` (keyhole, French cleat, magnet
recess, easel foot), `lib/palettes.ts` (Blueprint, Noir, Pastel, Brass on Black,
Terracotta, Nordic, Chicago; custom save/load in localStorage and permalink),
`lib/tint.ts` (per-building tint, height gradient, gated by slots), `lib/contrast.ts`
(adjacent-region similarity warning), preview theme toggle, FRAME and COLOUR groups.

## Phase 6: app and workflow

Files: `lib/geocode.ts` (forward search with autocomplete, debounce, cache,
rate-limit state), `components/map/SearchBox.tsx`, `lib/project.ts`
(`.framecraft.json` save/load, validation), `lib/share.ts` (v3 payload, deflate
via fflate, base64url, length guard with stored share id fallback), `lib/recent.ts`
(recent designs), `store/history.ts` (undo/redo, coalesced sliders, Ctrl+Z /
Ctrl+Shift+Z, history sheet from the adjustments chip).

## Phase 7: attribution

Files: `lib/engine/solid/attribution.ts` (deep underside mark >= 0.6 mm, frame
inner-wall mark or second underside mark, microtext 1.2 mm on a base edge),
exporter metadata in `generic3mf`, `bambu3mf`, `obj`, `step`,
`LICENSE_AND_ATTRIBUTION.md`, non-editable attribution row in the UI.

## Phase 8: distribution

Files: `apps/web/next.config.ts` (`output: "export"`, env base path),
`lib/engine/osm/overpass.ts` mirror config, `.github/workflows/pages.yml`,
`apps/desktop/` (Tauri 2: `src-tauri/{Cargo.toml,tauri.conf.json,src/main.rs,
src/lib.rs}` with save-to-folder, cache dir, larger memory; runtime feature check
in `apps/web/lib/platform.ts`), `.github/workflows/release.yml` (matrix Windows
msi+nsis, macOS universal dmg, Linux AppImage+deb, on `v*` tags, signing from
secrets when present), `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, tag
`v3.0.0`, enable Pages.

## Verification matrix

| Check | Command |
|---|---|
| Unit | `cd apps/web && npm test` |
| Types and lint | `npm run typecheck && npm run lint` |
| Build | `npm run build` (static export) |
| E2E | `npm run test:e2e` (Overpass mocked from `tests/fixtures`) |
| Reference service | `cd services/bake && uv run pytest` |
| Browser engine file validity | `npm run bake:cli -- --scene fixtures/chicago-scene.json --params fixtures/print-params-default.json --target generic-3mf --out artifacts/chicago-web.3mf` then `make validate FILE=artifacts/chicago-web.3mf` |
| Bambu load | `bambu-studio.exe --export-3mf` round trip on the exported project |
| Full gate | `make gate` |
