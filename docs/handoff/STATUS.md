# STATUS

| Phase | Agent | Gate | Command | Status |
|---|---|---|---|---|
| P0 | orchestrator | G0 | `ls .claude/agents \| wc -l` == 6 | PASS |
| P1 | scaffolder | G1 | `make up && curl -sf localhost:8000/health && curl -sf localhost:3000` | PASS |
| P2 | geo-ingest | G2 | `cd services/bake && pytest tests/test_ingest.py -q` + Chicago /scene coverage good | PASS |
| P3 | mesh-bake | G3 | `make bake-fixture && make validate artifacts/chicago.3mf` | PASS |
| P4 | web-editor | (G4) | vitest parity test + next build | PASS (via G4) |
| P5 | qa-gate | G4 | `make gate` | PASS |
| P6 | orchestrator | - | RUNBOOK.md + summary | PASS (RUNBOOK.md written; final make gate rc=0) |

Legend: PENDING, IN PROGRESS, PASS, DEGRADED (gate failed after 3 fix attempts; see FAILURES.md).

## Orchestrator notes for P5 (qa-gate)

- fixtures/ holds 12 sha1 Overpass files (134 MB) but presets-index.json references 6; prune the unreferenced ones (re-fetched hashes / audit leftovers) after confirming the six referenced files still load offline.
- The web-editor phase left apps/web/e2e/ empty; `make gate` cannot pass until the Playwright smoke test exists.
- `make up` output must be redirected to a file when invoked from a tool shell (background children hold the pipe).

## v2 run (2026-08-29)

| Phase | Agent | Gate | Command | Status |
|---|---|---|---|---|
| V2-P0 | orchestrator | - | agent notes, STATUS, DECISIONS | PASS |
| V2-P1 | mesh-bake (Task 0 min-wall investigation) | G3+G4 re-run if bug | `uv run pytest tests/test_transform.py` + vitest transform | PASS - verdict H1 (user nozzle 0.2, no bug; sidecar artifacts/265aa8c0ed.json); G3 re-run identical (68,692 tris, min wall 0.8016); audit: 1 major (HUD call site untested) FIXED by v2-fix-00, mutation-tested; PASS |
| V2-P2 | scaffolder (Task 1 contracts v2 + v1 golden + tokens) | G8 | `cd services/bake && uv run pytest tests/test_v1_compat.py` | PASS (G8 11 passed; golden 0e20725e from da9ab83 worktree); audit: 2 majors (required-vs-default in gen_py; shared mutable TS defaults) FIXED by v2-fix-01; PASS |
| V2-P3 | mesh-bake (Task 2 parts colour export) | G5 | `make bake-fixture COLOR=parts && make validate artifacts/chicago-parts.3mf` | GATE PASS (6 parts at 180, 7 at 256, G8 green); audit: 5 majors (inlay coincident faces, components count-only, transforms ignored, superset partition, bake skips container rows) -> all 5 FIXED by v2-lettering (+2 latent defects: manifold_from_mesh returned None for every mesh; finalize volume reference after simplify); G5/G8 green per agent; PASS (orchestrator re-ran G5 both plates after all fixes: ALL CHECKS PASS) |
| V2-P4 | web-editor (Task 6 UI redesign + v2 controls + hero picking) | (G7) | vitest + next build + axe e2e | BUILT (328 vitest, 15 e2e, axe 0 violations); audit: 5 majors (shortcuts behind modal, non-text contrast, fake tab-walk test, mouse-only hero picking, Escape scope) -> all 16 FIXED by v2-ui (contrast test, real Tab walk, keyboard hero cursor); 19 e2e green; PASS |
| V2-P5 | mesh-bake (Task 3 lettering/ornaments + Task 4 advisor math) | G6 | `make bake-fixture TEXT=all && make validate artifacts/chicago-text.3mf` | PASS - audit 2 blockers + 3 majors + 8 minors all FIXED by v2-lettering; orchestrator re-ran G3/G5(180,256)/G6/parts+text/G8 on 2026-08-30: ALL CHECKS PASS |
| V2-P6 | web-editor (Task 3 preview, Task 4 HUD + heroes, Task 5 share link) | (G7) | vitest + Playwright | BUILT (496 vitest, 25 e2e, 0 skipped); audit: 2 majors (share decoder accepts prototype keys; keyhole asin/acos) + 7 minors -> both majors + 6 minors FIXED by v2-preview (506 vitest, 25 e2e, 0 skipped); finding 9 handed to transform-pair owner; PASS |
| V2-P7 | qa-gate (G5-G8 wiring, axe-core, zero-skip, new e2e) | G7 | `make gate` | PASS (gate 472 s, gate-v2 151 s; F2 fixed); audit: 4 majors (G3 fixture validates pre-existing file, lettering row passes with 0 strokes, test.fail evades zero-skip, editor never predicts hanger refusal) -> all 4 + 6 minors FIXED by v2-fix-07; PASS |
| V2-P8 | orchestrator | G1-G8 | RUNBOOK, CLAUDE.md schema v2, re-freeze, summary | PASS - final `make gate-v2` 144 s + `make gate` 510 s (601 pytest, 537 vitest, 26 e2e, 0 skipped) on 2026-08-30; G1/G2/G3 PASS same day; RUNBOOK + CLAUDE.md updated; contracts re-frozen at schema version 2; nothing DEGRADED |

Every builder phase is followed by an adversarial audit (docs/handoff/v2-NN-audit.md) and, when the audit finds defects, a fixer pass.
