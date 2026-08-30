# 01 - scaffold (phase P1, scaffolder)

## File tree created

```
.gitignore
Makefile
docker-compose.yml

packages/contracts/
  schema/scene_request.json
  schema/scene_graph.json
  schema/print_params.json
  schema/bake_result.json
  gen_py.py                      -> services/bake/app/contracts.py
  gen_ts.py                      -> apps/web/lib/contracts.ts

services/bake/
  pyproject.toml  uv.lock  .python-version  Dockerfile
  app/__init__.py
  app/main.py                    FastAPI app, GET /health, GET /files/{name}
  app/contracts.py               GENERATED, do not hand-edit
  app/ingest/__init__.py         empty package, geo-ingest owns the modules
  app/geom/__init__.py           empty package, mesh-bake owns the modules
  app/export/__init__.py         empty package, mesh-bake owns the modules
  app/validate/__init__.py       empty package, mesh-bake owns the modules
  tests/__init__.py
  tests/test_contracts.py        generator determinism + fixture + round-trip tests

apps/web/
  package.json  package-lock.json  tsconfig.json  next.config.ts
  postcss.config.mjs  eslint.config.mjs  vitest.config.ts  playwright.config.ts
  Dockerfile
  app/layout.tsx                 persistent OSM attribution footer
  app/page.tsx                   renders "ok"
  app/globals.css
  lib/api.ts                     BAKE_API_URL
  lib/api.test.ts                trivial vitest unit test
  lib/contracts.ts               GENERATED, do not hand-edit
  e2e/.gitkeep                   qa-gate's Playwright specs go here
  components/editor/.gitkeep     web-editor owns
  components/scene/.gitkeep      web-editor owns
  components/map/.gitkeep        web-editor owns
  store/.gitkeep                 web-editor owns (store/editor.ts)

fixtures/chicago-scene.json      hand-authored sample SceneGraph
artifacts/.gitkeep  artifacts/logs/  (gitignored contents)
```

## How to run natively (this host: Windows 11, Git Bash, no Docker)

```
export PATH="/c/Users/Vahid/AppData/Local/Microsoft/WinGet/Packages/ezwinports.make_Microsoft.Winget.Source_8wekyb3d8bbwe/bin:$PATH"
make install   # uv sync + npm ci + playwright chromium
make up        # starts bake :8000 and web :3000, polls both /health, <=120s
make down      # stops both, frees the ports
make test      # pytest -q (14 tests) + vitest run (1 test)
make contracts # regenerate contracts.py / contracts.ts from schema/*.json
```

`make up` / G1 verified end-to-end on this host this session: fresh `make up`
started real PIDs (python.exe running uvicorn, node.exe running next dev),
`curl -sf localhost:8000/health` -> `{"status":"ok","version":"0.1.0"}`,
`curl -sf localhost:3000` -> 200, re-running `make up` reported both already
running (idempotent), and `make down` freed both ports. Stack is left DOWN.

## Contracts (FROZEN as of this phase)

`packages/contracts/schema/{scene_request,scene_graph,print_params,bake_result}.json`
- JSON Schema draft 2020-12, `$id` + `title` on every file, `additionalProperties: false`
  on every object (root and every `$defs` entry).
- Field names match `02_TECH_SPEC.md` verbatim, including the two ADDITIVE
  `BakeResult` fields (`progress`, `error`) pre-approved by the orchestrator.
- Generators: `packages/contracts/gen_py.py` -> `services/bake/app/contracts.py`
  (Pydantic v2, `extra="forbid"`, enums as `Literal`, `3mf`/`class` keys aliased
  to `file_3mf`/`class_` with `populate_by_name=True`) and `gen_ts.py` ->
  `apps/web/lib/contracts.ts` (interfaces, string-literal unions, quoted `"3mf"`
  key, plus `DEFAULT_PRINT_PARAMS` and `PARAM_RANGES` consts). Both are
  deterministic, idempotent, stdlib-only. `make contracts` regenerates both.
- `services/bake/tests/test_contracts.py`: (a) regenerates both generators'
  output into a temp dir and diffs byte-for-byte against the committed files,
  plus an idempotency check; (b) validates `fixtures/chicago-scene.json` and
  all four schema files themselves against draft 2020-12; (c) round-trips the
  02 example JSON objects (enum placeholders like `"tag|levels|default"`
  resolved to one concrete member) through the generated Pydantic models, plus
  an `additionalProperties` rejection test. All 14 tests pass.

**Contracts are frozen.** No field may be renamed or removed from here on
without a `DECISIONS.md` line and a matching regeneration.

## What was stubbed (per CLAUDE.md / 01's out-of-scope list, not placeholder logic)

- `app/ingest`, `app/geom`, `app/export`, `app/validate`: empty packages only
  (`__init__.py`), no module files - geo-ingest and mesh-bake own those.
- `apps/web` editor UI, 3D preview, MapLibre picker, zustand store: not built;
  `page.tsx` only proves the stack is wired (renders "ok" + OSM footer).
- `app/cli.py` (bake/validate/refresh-fixtures subcommands): not created: the
  Makefile targets that need it (`bake-fixture`, `validate`, `refresh-fixtures`)
  are wired to the exact commands mesh-bake/geo-ingest/qa-gate will implement
  against, and will start working the moment that file exists.
- `docker-compose.yml` + both `Dockerfile`s: written per spec, YAML/syntax
  validated, but never built or run (no Docker on this host).

## Could not verify on this host

- **ruff**: both `ruff` and `uv run python -m ruff` fail with `OSError:
  [WinError 4551] An Application Control policy has blocked this file` - a
  host security policy, unrelated to this repo. `services/bake/pyproject.toml`
  carries a correct `[tool.ruff]` config; verify on CI or another machine.
- **Docker / docker-compose**: not installed on this host per the project
  brief. Compose file and Dockerfiles are syntactically valid (parsed with
  PyYAML) but unbuilt.
- **Playwright e2e / `make gate`**: no specs exist yet (qa-gate owns
  `apps/web/e2e/`), so `test:e2e` currently reports "no tests found" by
  design; not a failure of this phase.

See `DECISIONS.md` for the full list of judgment calls made this phase
(contract range/enum choices, Pydantic aliasing convention, the Windows
PID-capture fix in `make up`/`make down`, dependency version pins).

---

## Fix pass (post-audit)

Two independent audits of this scaffold found five verified defects. All five
are fixed; the smallest correct change was made in each case and no test,
assertion or validator threshold was weakened. No contract field was renamed,
removed or added, so the phase-1 freeze still holds.

### 1. `gen_py.py` dropped every numeric and array constraint (major)

The generator emitted only types, so `SceneRequest(lat=999, radius_m=1)`,
`PrintParams(plate_mm=0, nozzle_mm=0)`, `Road(width_m=0)`,
`BakeResult(progress=5.0)`, `Stats(building_count=-1)` and a two-point `Ring`
were all accepted by `contracts.py` while `jsonschema` rejected each one.
Because FastAPI validates the `/scene` and `/bake` bodies with exactly these
models, the API accepted input the contract forbids (`plate_mm=0` makes 04's
scale zero and divides by zero) and the published OpenAPI carried no bounds.

Fix: `gen_py.py` maps `minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`
to `Field(ge=/le=/gt=/lt=)` and `minItems`/`maxItems` to
`Annotated[List[T], Field(min_length=/max_length=)]`, skipping the item-count
bounds where `minItems == maxItems` already produces a fixed `Tuple`
(`Point`, `bbox_mm`). Two small helpers (`numeric_constraints`,
`length_constraints`) plus `annotate()` keep the emitted order fixed, so the
byte-identical determinism test still holds. `Annotated` was added to the
generated import line. Constraints inside `anyOf[T, null]` are emitted on the
inner branch (`progress: Optional[Annotated[float, Field(ge=0, le=1)]]`),
which is the form pydantic 2.13.5 enforces.

### 2. Default serialization emitted non-contract keys (major)

`Road.model_dump_json()` produced `"class_"` and `BakeFiles.model_dump()`
produced `file_3mf`, so any caller that forgot `by_alias=True` wrote JSON the
TS client reads as `undefined` (roads vanish from the preview, download links
break). This mattered for three not-yet-written paths that bypass FastAPI's
response model: 02's 24 h `/scene` disk cache, 04's `<name>.json` bake
sidecar, and qa-gate's validator CLI.

Fix: the emitted `model_config` is now
`ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)`.
Verified under the locked pydantic 2.13.5: `model_dump()` and
`model_dump_json()` now emit `3mf` and `class` with no other behaviour change,
and explicit `by_alias=True` still works. The `[P1]` DECISIONS line that told
downstream phases to remember `by_alias=True` is superseded by a `[P1-fix]`
line (DECISIONS.md is append-only, so the original line is left in place and
the new line names it explicitly).

### 3. `make up` adopted (and `make down` killed) foreign processes (major)

`start_native` wrote any pre-existing listener's PID into `.run/<name>.pid`;
`make down` then `taskkill //T //F`'d it. Reproduced with an unrelated
`python -m http.server`, which `make down` force-killed with no confirmation.

Fix: a listener whose PID does not match the PID already recorded in
`.run/<name>.pid` is now a hard error - `error: port <p> already in use by
pid <pid> (not started by make up); stop it or choose a free port`, exit 1 -
and no pid file is written. A listener whose PID *does* match the recorded one
still reports "already running", so `make up` stays idempotent on rerun, and
the POSIX path (no `netstat -ano`/`LISTENING` output) still falls through to
the original `kill -0` check. Re-verified: with a foreign listener on :8000,
`make up` exits 1, writes no pid file, and the foreign process survives.

### 4. Catch-all rule swallowed every unknown target (major)

`%: @:` made `make gaet` and `make tset` exit 0 silently, so a typo in a CI or
gate script failed open. Fix: the rule is now wrapped in
`ifneq (,$(filter validate,$(MAKECMDGOALS)))`, so `make validate
artifacts/x.3mf` still works while unknown targets fail with "No rule to make
target". Verified both ways.

### 5. No `.dockerignore` anywhere (major)

`apps/web/Dockerfile` runs `npm ci` and then `COPY . .`, which overlays the
host's Windows-native `node_modules` (`@next/swc-win32-*`,
`lightningcss-win32-*`, `@tailwindcss/oxide-win32-*`), the host `.next` output
and any future `.env` file onto the freshly installed Linux image; the
root-context bake build uploaded `apps/web/node_modules`,
`services/bake/.venv` and `.git` as build context.

Fix: added `apps/web/.dockerignore` and a root `.dockerignore` with the
exclusions listed in DECISIONS.md. **Still unverified on this host** - Docker
is not installed, so the impact is inferred from `COPY` semantics rather than
observed, the same caveat that already applies to both Dockerfiles.

### Tests added

`services/bake/tests/test_contracts.py` grew two sections:

- **(d) bound parity** - 33 out-of-range instances (both ends of each
  double-bounded field) asserted rejected by `jsonschema` *and* by the
  generated model, plus an in-range baseline per schema so the rejection cases
  cannot pass vacuously.
- **(e) default serialization** - `SceneGraph(**fixture).model_dump(mode="json")
  == fixture` and `BakeFiles`/`Road`/`BakeResult` dumps compared against the
  contract JSON, all without passing `by_alias`.

### Verification run for this fix pass

```
make contracts
cd services/bake && uv run pytest -q          # 55 passed (was 14)
cd apps/web && npm run build                  # compiled, 4/4 static pages
cd apps/web && npm test                       # 1 passed
make up && curl -sf localhost:8000/health && curl -sf localhost:3000 && make down
make gaet                                     # No rule to make target 'gaet'  (expected)
```

`apps/web/lib/contracts.ts` is unchanged: `gen_ts.py` was not touched, and TS
interfaces cannot express numeric ranges - the bounds live on the server, which
is the validating side. The stack is left DOWN and both ports free.
