# 05 AGENT TEAM AND PHASE GRAPH

## Phase 0, orchestrator does this directly

Create these files before spawning anything.

**`CLAUDE.md`** at the repo root, under 60 lines: what FrameCraft is, the repo
layout from `02`, the rule that `packages/contracts` is frozen, the make
targets, and a pointer to `docs/handoff/` for phase notes. Every subagent reads
this automatically, so it is the cheapest way to keep them aligned.

**`DECISIONS.md`**: an append-only log. Format `- [phase] decision, one line`.

**`docs/handoff/STATUS.md`**: a table of phase, agent, gate, status.

**`.claude/agents/*.md`**: the six agents below. Frontmatter format:

```markdown
---
name: mesh-bake
description: Solid geometry, booleans, printability repair, and export
tools: Read, Write, Edit, Bash, Glob, Grep
model: opus
---
<system prompt body>
```

Every agent body must end with this block, verbatim:

```
OUTPUT PROTOCOL
Write your full notes to docs/handoff/NN-<phase>.md.
Return to the orchestrator at most 15 lines: what you built, what you decided,
what you stubbed, and the exact command that verifies your work.
Do not return code. Do not return file contents. Do not ask questions.
Resolve every ambiguity yourself and append it to DECISIONS.md.
```

## The six agents

**1. `scaffolder`** (model: sonnet)
Owns the repo skeleton, `docker-compose.yml`, `Makefile`, both package
manifests, linting, `.gitignore`, and `packages/contracts`. Writes JSON Schema
for `SceneRequest`, `SceneGraph`, `PrintParams`, `BakeResult` exactly as in
`02`, plus the generators that emit Pydantic models and `apps/web/lib/contracts.ts`.
Ships a `/health` endpoint and a Next.js page that renders "ok" so the stack is
provably wired before any real work lands. Its contracts output is frozen after
this phase.

**2. `geo-ingest`** (model: sonnet)
Owns `services/bake/app/ingest/**` and `app/geom/project.py`. Implements the
Overpass client with fixture caching and fallback mirror, tag normalization,
height inference, geometry hygiene, projection, rotation, crop, and coverage
classification, all per `03`. Commits the six preset fixtures. Delivers
`POST /scene` and `GET /presets`. Must include unit tests over the Chicago and
Paris fixtures asserting building counts, that every returned polygon is valid,
and that `height_source` distribution is sane.

**3. `mesh-bake`** (model: opus)
Owns `services/bake/app/geom/{thicken,extrude,assemble}.py`,
`app/export/**`, `app/validate/**`, and the `/bake` endpoints. Implements
everything in `04`. This is the hardest phase and gets the strongest model.
Must include a golden test that bakes the Chicago fixture at default params and
asserts every validator passes, plus a fast unit test suite over synthetic
shapes: a single square, two buildings separated by a sub-minimum gap, a
building with a hole, a self-intersecting ring, and an empty scene.

**4. `web-editor`** (model: sonnet)
Owns `apps/web/**`. Implements the MapLibre picker with a draggable radius, the
preset row, the r3f preview with `InstancedMesh` buildings and ribbon roads, the
parameter panel bound to zustand, the bake flow with polling and progress, and
the stats card. Must implement the shared transform math mirroring the Python
side and a vitest that checks the two agree on a fixture within 0.01 mm.
Dark and light themes. Reads `04` so the preview reflects the same
minimum-feature merging the bake will apply, at least approximately, using a
cheap 2D dilation on the client.

**5. `qa-gate`** (model: sonnet)
Owns `services/bake/tests/`, the Playwright smoke test, and `make validate`,
`make gate`, `make up`. Writes the CLI validator that takes a `.3mf` and prints
a pass or fail table from `04`. Writes the Playwright test covering the full
happy path from `01`. Does not modify application code; reports failures instead.

**6. `fixer`** (model: opus)
Spawned only on a gate failure. Receives the failing command, its stderr, and
the name of the owning phase. Makes the smallest change that turns the gate
green without weakening the assertion. Explicitly forbidden from deleting or
loosening a test to make it pass. If it cannot fix in its turn, it writes the
diagnosis to `docs/handoff/FAILURES.md` and returns.

## Phase graph

```
P0  orchestrator: CLAUDE.md, DECISIONS.md, agents            gate G0
P1  scaffolder:   skeleton + frozen contracts                gate G1
        |
        +-- P2 geo-ingest   (parallel)                       gate G2
        +-- P4 web-editor   (parallel, mocks /scene from a
        |                    committed fixture until P2 lands)
        |
P3  mesh-bake: runs after P2, needs a real SceneGraph        gate G3
P5  qa-gate:   runs after P3 and P4 both land                gate G4
P6  orchestrator: RUNBOOK.md, final summary
```

P2 and P4 are parallel because P4 consumes only the frozen contract plus a
committed `fixtures/chicago-scene.json`, which P1 produces as a hand-written
sample conforming to the schema. Tell `web-editor` this explicitly.

## Gates

| Gate | Command | Pass condition |
|---|---|---|
| G0 | `ls .claude/agents \| wc -l` | 6 |
| G1 | `make up && curl -sf localhost:8000/health && curl -sf localhost:3000` | both 200 |
| G2 | `cd services/bake && pytest tests/test_ingest.py -q` | green, and `/scene` on the Chicago preset returns coverage `good` |
| G3 | `make bake-fixture && make validate artifacts/chicago.3mf` | every validator in `04` passes |
| G4 | `make gate` | pytest, vitest, next build, and Playwright smoke all green |

On any gate failure: spawn `fixer` with only the command and its stderr, never
the whole repo. Maximum 3 attempts, then mark `DEGRADED` and continue.

## Context budget guidance for the orchestrator

Expected shape of a healthy run: six to nine subagent invocations total,
including fixers. Each returns roughly 15 lines. Your own context should hold
the five specs, `DECISIONS.md`, `STATUS.md`, and gate output only. If you catch
yourself reading application source, stop and delegate the reading instead.
