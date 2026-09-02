# Contributing to FrameCraft

## Prerequisites

- Node 22+ and npm
- Python 3.12 with [uv](https://docs.astral.sh/uv/)
- GNU make (recipes are POSIX sh; on Windows use Git Bash)
- Rust toolchain, only if you build the desktop (Tauri) bundle

## Setup

```sh
make install
```

Installs the Python service with `uv sync`, the web app with `npm ci`, and the
Playwright Chromium build.

## Run

```sh
make dev
```

Web editor on `localhost:3000`, the reference API on `localhost:8000`. Since
v3 the web app is standalone: the whole build pipeline runs in the browser, and
the Python service is only the reference implementation and validator. You can
develop most features with `cd apps/web && npm run dev` alone.

## Test

```sh
make test    # pytest + vitest
make gate    # the full quality gate
```

The gate is the bar for merging. It runs the static no-skip guard, pytest,
a browser-engine export checked by the Python reference validator,
eslint, `tsc --noEmit`, vitest, `next build`, and the Playwright end-to-end
suite, and it fails on any skipped, xfailed, or todo test: zero skips is
enforced, not encouraged. Release builds are additionally cross-checked by the
Python validator (`make validate FILE=...`), which reads exported files back
and verifies manifoldness, wall thickness, and container structure
independently of the TypeScript that wrote them.

## Repo layout

| Path | What it is |
|---|---|
| `apps/web/` | The Next.js editor. `lib/engine/` is the browser build engine: OSM ingest, terrain, solids on manifold WASM, audit, exporters |
| `services/bake/` | Python reference implementation and CLI validator; mirrors the engine's transform math, pinned by a parity fixture |
| `packages/contracts/` | JSON Schema source of truth for the wire shapes, plus the two generators |
| `fixtures/` | Cached Overpass responses and golden outputs the tests pin against |
| `docs/` | `ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md`, and per-phase handoff notes under `docs/handoff/` |

## The contracts freeze

`packages/contracts/schema/*.json` is frozen. Any schema change needs a line in
`DECISIONS.md` explaining it, must be additive (optional fields with defaults
identical to the previous behaviour), and must keep `tests/test_v1_compat.py`
green. Run `make contracts` to regenerate `apps/web/lib/contracts.ts` and
`services/bake/app/contracts.py`; never hand-edit the generated files.

## Code style

- TypeScript strict mode, no `any`.
- Use the design tokens; do not invent one-off colours or spacing.
- No em dashes in text, code comments, or docs; use commas, colons, or
  parentheses.
- User-facing warnings go through the Issues badge, the app's single warning
  surface; do not add ad hoc alerts or console warnings for users.

## Adding things

- **An export format**: add a pure writer in `apps/web/lib/engine/export/`
  (signature `(result, options) => ExportFile[]`, no DOM, no network) and wire
  it into the `export_target` dispatch in `lib/engine/export/index.ts`, with
  tests beside it.
- **A printer profile**: add an entry to the profile table in
  `apps/web/lib/printers.ts` (bed size, height ceiling, nozzle, filament
  slots) and extend `lib/printers.test.ts`.

## Pull requests

- `make gate` green, locally or in CI, before review.
- New behaviour comes with tests that would fail without it.
- Report honestly: if something is degraded, partial, or skipped, say so in
  the PR description rather than letting the diff imply otherwise.
- Schema or geometry-affecting changes get a `DECISIONS.md` line.
