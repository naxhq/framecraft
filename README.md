# FrameCraft handoff package

Five spec files plus a kickoff prompt. Everything a Claude Code orchestrator
session needs to build the MVP without stopping to ask you anything.

## How to run it

1. Make an empty directory and drop all six files into it.
2. Open Claude Code there. Use Opus for the main session.
3. Paste the text below the horizontal rule in `00_KICKOFF_PROMPT.md`.
4. Walk away for a while.

Suggested flags for an uninterrupted run:

```
claude --model opus --dangerously-skip-permissions
```

Only use that flag in a container or a directory you do not mind it writing to
freely. Without it you will get permission prompts, which defeats the purpose.

## What you get

| File | Role |
|---|---|
| `00_KICKOFF_PROMPT.md` | The paste-in prompt. Orchestrator rules, context discipline, definition of done |
| `01_PRODUCT_SPEC.md` | Scope, user flow, parameter table, acceptance criteria, non-goals |
| `02_TECH_SPEC.md` | Stack decisions, repo layout, the four data contracts, API surface, perf budgets |
| `03_GEODATA_SPEC.md` | OSM sources, Overpass query, height inference, geometry hygiene, licensing |
| `04_PRINTABILITY_SPEC.md` | Scale math, minimum-feature repair, boolean assembly, 3MF export, validators |
| `05_AGENT_TEAM.md` | Six subagent definitions, phase graph, gates, handoff protocol |

## Why it is structured this way

The context problem is solved by making the orchestrator a router that never
reads source code. Subagents write to disk and return a short summary. The
specs are the shared memory instead of the transcript.

The quality problem is solved by `04`. Most map-to-mesh projects fail not at
geometry but at printability, so that file gets the most detail, the strongest
model assignment, and the strictest gate.

The correctness problem is solved by freezing the contracts in phase 1. Preview
and bake read the same `SceneGraph` and the same `PrintParams`, with a test
asserting the TypeScript and Python transform math agree. Preview and print
diverging is the worst failure this product can have.

## After the run

Read `RUNBOOK.md` and `DECISIONS.md` first, then `docs/handoff/STATUS.md` for
anything marked `DEGRADED`. The most likely rough edges are the minimum-wall
probe in the validator, the batched union performance on dense downtowns, and
the 80th-percentile height rule for merged building blocks. All three are tuning
problems, not redesigns.

Highest-value things to build next, in order: lidar roof geometry where open
data exists, a hand-modeled landmark library with geo-anchored substitution, and
multi-tile snap-together output with joinery.
