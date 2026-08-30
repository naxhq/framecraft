# V2-P7 audit — adversarial review of the qa-gate phase (G7 / gate-v2)

Auditor: independent (did not write the work under audit). Date: 2026-08-30.
Scope: `Makefile`, `apps/web/playwright.config.ts`, `apps/web/e2e/*`,
`apps/web/package.json`, `services/bake/tests/*`,
`docs/handoff/v2-07-qa.md`, `docs/handoff/FAILURES.md` (F2), the `[V2-P7]`
lines of `DECISIONS.md`.

Constraint honoured: `make gate` was running throughout, so no `make gate`,
`gate-v2`, `up`, `bake-fixture`, `next build`, `test:e2e` or full-pytest run was
issued. Probes were run against scratch copies under the session scratchpad and
against single non-baking commands (`npm test -- --run`, `npm run typecheck`,
`PrintParams(...)` construction, a live read-only `netstat`/`curl` port probe).

---

## What was verified as sound (so the findings below are read in proportion)

These were probed, not taken on trust:

* **Static no-skip guard has teeth.** Run against a 17-file probe tree, the
  exact `Makefile:156-163` `find` + `grep -E` catches `test.skip(`,
  `it.skip.each`, `describe.only`, `test.fixme`, `test.skipIf`, `test.todo`,
  `xit(`, `test.describe.skip` in a **nested** folder, and a `.test.tsx`
  extension; it correctly prunes `node_modules`. It also flags the marker
  inside a string literal (a false positive, which is the safe direction).
  Run for real from the repo root: **31 spec files scanned, 0 markers**, which
  matches the handoff's count exactly.
* **The empty-glob case is handled.** `echo "" | wc -l` is `1`, so a broken
  glob would otherwise report "1 test files scanned"; `Makefile:158`'s
  `[ -z "$specs" ]` fires first and fails the gate.
* **Summary greps behave.** `Makefile:179` flags `1 skipped`, `1 xfailed`,
  `2 xpassed` and does not flag `591 passed`, `1 deselected`, `1 warning`,
  `12 failed`. `Makefile:191` flags `1 skipped` and `1 todo` (both the `Tests`
  and the `Test Files` line) and does not flag a clean vitest summary. pytest
  here is 9.1.1 and its `-q` summary is a single unwrapped line.
* **`results.json` handling is correct.** `Makefile:204` deletes the file
  *before* `make up`, and `Makefile:207`'s `require()` throws (non-zero, caught
  by the `||`) if the reporter never wrote one — so a stale or missing report
  fails rather than passes. `playwright.config.ts:80-83` does configure the
  json reporter at `REPO_ROOT/artifacts/e2e/results.json`.
* **The port probe has teeth.** Ran `port_listening()` verbatim against the
  live stack: `LISTENING 8000`, `LISTENING 3000`, `free 65123`. `:8000 ` cannot
  match `:18000 ` (the literal colon is required).
* **Step 7 is not vacuous.** `fixtures/` is not in `.gitignore`, so an
  untracked `<40-hex>.json` really does show in `git status --porcelain`; the
  six preset sha1 fixtures are tracked and therefore invisible to it; `cut -c4-`
  is the right offset for porcelain v1.
* **No rc is swallowed in `make gate`.** Every `|| true` in the recipe is on a
  diagnostic `grep`/`tail` or on step 0's deliberate pre-clean. `pyrc`/`vrc`
  are captured immediately after their redirected subshells and both are
  checked. There is no pipe that loses an exit status. `SHELL := sh` with one
  backslash-continued line keeps `rc` in one shell; `exit $rc` is last.
  `gate-v2`'s `need`/`check`/`bake` are plain function calls (no subshell), so
  their `rc=1` writes reach the parent.
* **Both removed skips are strictly stronger.** `smoke.spec.ts:553-558` keeps
  both diagnoses (Overpass unreachable / `FRAMECRAFT_OFFLINE` was set) and the
  `FRAMECRAFT_OFFLINE` body assertion above it is untouched; the assertion
  changed from `test.skip(cond)` + `expect(status).toBe(200)` to
  `expect(status).toBe(200)` with a richer message. Nothing was loosened.
* **`make bake-fixture` at defaults is unchanged.** With no `COLOR`/`TEXT`/
  `PLATE`, `$@` is empty and `Makefile:395` is the HEAD command verbatim.
  `gate-v2` is in `.PHONY` (`:3`) and in `make help` (`:17-18`).
* **Playwright matrix rows check out against the spec text**: `a11y.spec.ts:107`
  is a real 2-theme loop over 4 states asserting only serious/critical with no
  rule disabled and `incomplete` printed not asserted; `share.spec.ts:100` opens
  a genuinely fresh `browser.newContext()`; `ui.spec.ts:197` enumerates
  `city_label`, `color_mode`+`part_color_water`, an engraving row, `#hanger`,
  `#north_arrow_enabled`, a keyboard hero pick, `hero_mode` **both directions**,
  `#scale_bar_enabled`, `#underside_mark_enabled`, and asserts *every* call to
  the bake API is `[]` (`watchApi` at `:22` filters on `API_URL`, not on
  `/scene`); `ui.spec.ts:398-404` asserts exactly one `POST /scene` after the
  advisor click and re-checks after 1.5 s; `smoke.spec.ts:30/34` still hold
  `A1_BUDGET_MS = 5_000` / `A4_BUDGET_MS = 90_000`; `smoke.spec.ts:384-394`
  really spawns `uv run python -m app.cli validate` and asserts exit 0 +
  `ALL CHECKS PASS`. 25 tests total (16 ui + 3 share + 4 a11y + 2 smoke).
* **Independent re-run of the permitted suites**: `npm test -- --run` →
  **27 files, 531 passed, 0 skipped**; `npm run typecheck` → clean. Both agree
  with the handoff.
* **`gate-v2`'s row patterns cannot match a FAIL line.** `'lettering +PASS'`
  requires the literal `PASS` in the verdict column; a failing row prints
  `FAIL`. (But see finding 2 for the *other* way that assertion is weak.)
* **The hanger arithmetic in the handoff is right.**
  `transform.underside_min_base_mm` = `hanger_min_base_mm` + `deepest_recess_mm`,
  and with the default `road_mode="engrave"` that is 2.0+1.0+0.6 = **3.6** and
  3.1+1.0+0.6 = **4.7**. The brief's 3.0/4.1 are `hanger_min_base_mm` alone.
  The correction in `docs/handoff/v2-07-qa.md:176-183` and DECISIONS
  `[V2-P7]:388` is accurate.

---

## Findings

### 1. MAJOR — the G3 session fixture validates a *pre-existing* artifact, not the bake it makes

`services/bake/tests/test_validate_cli.py:510-527`

```
    target = ARTIFACTS / "chicago.3mf"
    if not target.is_file():
        ... cli.main(["bake", ...])
```

The `skipif` is gone (good), but the replacement only bakes **when the file is
absent**. On this host — and on any host that has ever run `make bake-fixture`
or a previous pytest session — `test_cli_passes_on_the_chicago_fixture_bake`
asserts about a file the current tree did not produce. A pipeline regression is
masked by any surviving good artifact, which is exactly the false green G3
exists to prevent. The brief's requirement ("assert on the bake it makes, not on
a pre-existing artifact") is not met.

It is worse than stale-file risk, because `Makefile:386-392` lets `PLATE`
change the *parameters* without changing the *stem*: `COLOR` and `TEXT` rename
the output (`chicago-parts`, `chicago-text`), `PLATE` does not.

Reproduce:

```
make bake-fixture PLATE=256          # overwrites artifacts/chicago.3mf at 256 mm
cd services/bake && uv run pytest tests/test_validate_cli.py -k chicago_fixture
```

The test passes: the sidecar beside the file says `plate 256`, so the validator
judges it against 256 and reports `ALL CHECKS PASS`. "The default Chicago bake
validates" is now asserted about a non-default bake, and nothing says so.

Direction (not applied): bake unconditionally, into `tmp_path_factory`, or make
the fixture compare the file's sidecar against `PrintParams()` before trusting
it. Separately, `PLATE` should take a stem suffix the way `COLOR`/`TEXT` do.

### 2. MAJOR — `gate-v2`'s G6 assertion is satisfiable with zero letters cut

`Makefile:328` (and `:331`, `:336`, `:339`) assert `'lettering +PASS'`.
`services/bake/app/validate/checks.py:956-1090`:

* the row is emitted iff `bands` is non-empty (`:981-983`), and `bands` comes
  from `lettering_probe_zs(params)` — i.e. from the **parameters that were
  requested**, never from geometry that was actually cut;
* `passed = not bad` (`:1069`) and `bad` only ever collects strokes/ridges that
  are *too thin*. With **zero** strokes found, `bad` is empty and the row is
  `lettering  PASS  0.000 mm stroke / 0.000 mm ridge`.

So a regression that requests every ornament and silently produces none keeps
the row present *and* PASS, and `make gate-v2` stays green. The handoff's claim
(`v2-07-qa.md:92`, DECISIONS `[V2-P7]:383`) that the rows "have to PASS, not
merely be present" is true but does not buy what it sounds like: PASS does not
imply letters. The measured evidence in `v2-07-qa.md:299` (`0.488 mm stroke /
0.765 mm ridge`) is exactly the number the gate is not asserting.

Reproduce: read `checks.py:1069-1090`; a run whose stroke value is `0.000` still
matches `grep -E 'lettering +PASS'`. Direction: assert a non-zero measurement,
e.g. `'lettering +PASS +[1-9]'` / `'over [1-9]'`, and likewise for `base_floor`
(`checks.py:1148` has the same shape).

### 3. MAJOR — the zero-skip net has one hole nothing covers: Playwright `test.fail()`

`Makefile:162-163`. The marker alternation is
`(skip|only|fixme|todo|skipIf|failing)`. It contains `failing` (a vitest name)
but **not `fail`**, which is Playwright's own expected-failure annotation. A
`test.fail()` test that fails is reported by the JSON reporter as
`stats.expected`, not `stats.skipped`, so:

* step 1 (static) does not see it — regex miss;
* step 5 (`results.json stats.skipped`) does not see it — it is not a skip;
* it is the exact analogue of the `xfailed`/`xpassed` the **pytest** side is
  explicitly made to reject at `Makefile:179`.

A broken acceptance test annotated `test.fail()` therefore passes the whole
gate. Reproduce (probe, scratchpad `probe/apps/web/e2e/p08_pw_fail.spec.ts`):

```
test("a", async () => { test.fail(); });
```

→ the guard command prints nothing.

Also missed statically, but **caught at runtime** by the vitest / Playwright
skip counters, so lower risk — listed so the guard is not believed to be
absolute: `test .skip(` (space before the dot), `test` + newline + `.skip(`
(the guard is line-based), `test["skip"](`, `test.concurrent.skip(`,
`test.runIf(false)`. All six probes and the nine that *are* caught are in
`…/scratchpad/probe/`.

### 4. MAJOR — the editor never computes the hanger minimum, and two docstrings say it does

`services/bake/app/geom/transform.py:1605` — *"the editor predicts the refusal
from this function"* — and `:1641` — *"the number the bake refuses on and the
editor should display"*. Neither is true today:

```
$ grep -rn underside_min_base_mm apps/web --include=*.ts --include=*.tsx | grep -v '\.test\.'
apps/web/lib/transform.ts:1514:export function underside_min_base_mm(...)
```

The function exists in the TS mirror and is unit-tested
(`apps/web/lib/lettering.test.ts:227-231`, agreeing with
`services/bake/tests/test_lettering.py:877-881` at 3.6 / 3.0), but **no
component, warning or advisor calls it**. `components/editor/groups/
FrameTextGroup.tsx:271-278` offers the hanger select with the hint "A fitting
added to the back so the plate can go on a wall" and nothing else; there is no
"too thin" string anywhere in `apps/web/components` or `apps/web/lib`.

So `hanger=keyhole` + `base_thickness_mm=3` is silently offered, and the user
learns about it only from a failed bake. `v2-07-qa.md:311` states "No
application defect was found"; this is one, it is in the surface the phase's own
item (d) verifies server-side, and no vitest or e2e covers the UI side of it.

### 5. MINOR — the new playwright.config comment declares `make gate`'s own build order unsafe

`apps/web/playwright.config.ts:24-51` (added this phase) states that
`npm run build` followed by starting `next dev` "reproducibly poisons the dev
server" (`Cannot find module .next/server/app/page.js`, plus a Fast-Refresh full
reload that `smoke.spec.ts`'s `watchNavigations` counts), and lists three safe
orders: e2e alone, build + `rm -rf .next` + e2e, or build + `FRAMECRAFT_WEB_MODE=
prod`.

`make gate` follows **none** of them: `Makefile:196` runs `npm run build`, then
`Makefile:205` runs `make up`, which at `Makefile:77` starts `npm run dev` on
that same `.next`. No `rm -rf .next`, and `FRAMECRAFT_WEB_MODE` is never set.
This ordering is pre-existing (it is at HEAD too) and satisfies DECISIONS
`[P4]:59` (never build *while* dev is up); what is new is the comment declaring
it hazardous. Most likely the comment is over-broad — `make up` health-waits up
to 120 s (`Makefile:80-91`), which gives `next dev` time to recompile before
Playwright connects — but as written the repo now tells the next reader that its
primary gate uses a poisoning order, and if the comment is right the A3
navigation assertion is a latent flake. One of the two needs correcting.

For the record, answering the brief directly: **the gate runs Playwright against
`next dev`, never against `next build` + `next start`.** The production path
exists only under `FRAMECRAFT_WEB_MODE=prod`, which the gate does not set, so
`next build` in step 3 is a compile check whose output is then thrown away.

### 6. MINOR — the teardown's `make down` rc check is unreachable; only the port probe has teeth

`Makefile:214-221` treats a non-zero `make down` as a gate failure. `down:`
(`Makefile:99-114`) cannot return non-zero: the docker branch is skipped on this
host, every `taskkill`/`kill` is `|| true`, and each loop iteration ends with
`echo`, so the recipe's status is always 0. The real assertion is the port probe
at `:222-230` (verified live: it does report 8000 and 3000 as busy).

Harmless in effect, but `v2-07-qa.md:26` and DECISIONS `[P6-fix]:177` both
present the rc check as a working gate condition, which it is not.

### 7. MINOR — `PLATE=` is validated for shape only, not for range

`Makefile:386-392` rejects non-numerics, `1.2.3` and a bare `.`, but does no
range check. `PLATE=99` and `PLATE=257` pass the Makefile. Verified they are
caught downstream by the contract (`packages/contracts/schema/print_params.json`
`plate_mm` minimum 100 / maximum 256 → `Field(ge=/le=)` per `[P1-fix]`):

```
99 REJECTED: ValidationError   257 REJECTED: ValidationError
256 ACCEPTED                   180 ACCEPTED
```

So it fails closed — but with a pydantic error out of `app.cli` rather than the
Makefile's own usage message, and only after `uv` has started. Cheap to add the
bound beside the existing `case`.

### 8. MINOR — `gate-v2` step 1 asserts less than the handoff says, and skips no-skip

`Makefile:302-304` runs `uv run pytest tests/test_v1_compat.py -q` and checks
only the exit code. `docs/handoff/v2-07-qa.md:89` records the assertion as
"11 passed"; no count is asserted. Unlike `make gate` step 2, this invocation
has no `-rs` and no skipped/xfailed check, so a `skipif` added to
`test_v1_compat.py` would leave `make gate-v2` green (the full pytest run inside
`make gate` would still catch it, so this is defence-in-depth, not a hole).

### 9. MINOR — F2's fix hard-codes the refused size 0.25 mm from the flip point

`apps/web/e2e/ui.spec.ts:295` sets `3` as "a size the shared math really
refuses". F2's own measurement (`FAILURES.md`, the `2.0 refused / 3.0 refused /
3.25 refused=False` block) puts the boundary between 3.0 and 3.25 mm. The number
is a literal with no link to `lettering_layout`, so a small change to
`text_stroke_target_mm`, the nozzle default or the bundled face flips it — the
same class of coupling F2 was written about, just to a measurement instead of to
a default. It fails loudly rather than silently, so this is brittleness, not a
false green. `:311`'s `expect(withText).toBe(8)` is font-coupled in the same
way. The F2 write-up itself is accurate, and the fix is a real strengthening
(the 3 mm case now also requires the drawn rings to fall back to 0).

### 10. NOTE — the static guard is `apps/web`-only and `.ts/.tsx`-only

`Makefile:156-157`. A `*.test.js` / `*.test.mjs` spec — which vitest's default
include would still run — is not scanned (verified with probe
`p14_wrongext.test.js`). `services/bake` is not scanned at all for
`pytest.mark.skip`/`skipif`/`xfail`/`importorskip`/`pytest.skip(`; the runtime
summary check at `Makefile:179` covers all of those, but a `conftest.py`
`collect_ignore` would be invisible to both. The tree is clean today: a repo-wide
grep for those markers, and for `test.fail(`/`.concurrent.`/`runIf`, returns
nothing.

### 11. NOTE — the north-arrow measurement is independent of the layout, but not of `place`'s sign

`services/bake/tests/test_qa_verification.py:209-246`. The *expectation* is
genuinely independent (`project.LocalFrame` only, `:176-189`), and the *angle*
is genuinely measured out of a section of the exported 3MF — both as claimed.
But the recovery fits the mesh against `lettering.north_arrow_polygon` rotated
by `lettering.place`, then returns `(-best) % 360`. A sign error *inside*
`place` would rotate the baked arrow and the test's interpretation together, and
the test would still pass; only a wrong angle *handed to* `place` (which is the
shipped `-rotation_deg` bug) is caught. The helper documents the convention, and
the non-vacuity check at `:293-296` is real, so this is a scope note rather than
a defect.

### 12. NOTE — the API-level hanger refusal covers only the default `road_mode`

`test_qa_verification.py:347-383` parametrises `keyhole@2.9→3.6` and
`magnets@4.0→4.7`, both at the default `road_mode="engrave"`.
`underside_min_base_mm` also varies with `road_mode` and `water` (3.0 with both
off). That dependency **is** covered, at unit level and in both languages
(`services/bake/tests/test_lettering.py:877-881`,
`apps/web/lib/lettering.test.ts:227-231`), and the two agree — so the arithmetic
in the parametrize comment is correct and the gap is only that no API-level test
exercises the non-default branch.

### 13. NOTE — a self-comparing assertion

`test_qa_verification.py:478`:
`assert parsed["bodies"] == ("PASS", parsed["bodies"][1])` compares the second
element with itself, so it means only `parsed["bodies"][0] == "PASS"`. The real
value check is the next line. Harmless, but it reads as an assertion about the
body count when it is not.

### 14. NOTE — nothing in the gate detects a *deleted* test

The brief's "no test weakened, skipped or deleted" is enforced for *skipped*
(four ways) and for *weakened* only by review. There is no count floor for
pytest, vitest or Playwright, so removing a test lowers the numbers in STATUS.md
and passes the gate. Given the phase records 599 / 531 / 25, a `>=` assertion on
those three counts would close it cheaply.

---

## Housekeeping checked and clean

* No leftover probe or scratch file in the repo: the handoff's
  `fixtures/0000…0000.json` and the `apps/web/lib` marker probe are both gone;
  `fixtures/` holds exactly the six preset sha1 files listed by
  `presets-index.json` plus the committed non-sha1 fixtures.
  `services/bake/scripts/gen_font_assets.py` is `[V2-P5]` lettering work, not a
  qa artefact.
* `docs/handoff/STATUS.md:32` records V2-P7 accurately (472 s, 599/531/25, 0
  skipped, gate-v2 151 s, F2).
* `DECISIONS.md:378-393` matches the code, with the exceptions called out in
  findings 6 and 8.
* `apps/web/package.json` in this diff: `lint` gained `--max-warnings 0`
  (`[V2-P1-fix]`), `@axe-core/playwright` added, dependency list reordered. No
  script's meaning changed for the gate; `test` is `vitest run`, so
  `Makefile:187` cannot hang in watch mode.
* One test-file assertion outside the phase's own narrative:
  `services/bake/tests/test_validate_cli.py:262-272` replaced
  `assert "watertight" in out.splitlines()[-1]` with a `FAILED:`-line lookup
  plus a new `is_watertight=False` detail assertion. Net stronger, and it is not
  attributable to V2-P7 from a single squashed baseline commit — recorded here
  only so it is not mistaken for a silent weakening later.

---

AUDIT: 14 DEFECTS (0 blocker, 4 major)

---

## Resolution — [V2-P7-fix], 2026-08-30

Fixer pass over this audit. Every finding is marked FIXED or NOT FIXED with the
reason. No test was weakened, skipped or deleted; nothing in
`packages/contracts/` was touched; `make bake-fixture` at defaults is unchanged.

### 1. MAJOR — the G3 session fixture — **FIXED**

`chicago_fixture_bake` bakes **unconditionally**, at `PrintParams()` defaults,
into `tmp_path_factory`, and never reads or writes `artifacts/`. The test also
asserts the printed header names the default plate, so the table cannot be a
judgement against some other one.

Separately, `PLATE=` now takes a stem suffix in the Makefile
(`chicago-p256.3mf`, `chicago-parts-p256.3mf`) and is **range-checked 100..256**
with the Makefile's own message, so a plate override can no longer overwrite the
default artifact at all. Verified: `make bake-fixture PLATE=256` left
`artifacts/chicago.3mf`'s mtime untouched and wrote `chicago-p256.3mf`.
`make gate-v2` step 3, `RUNBOOK.md`'s `bake-fixture` / G5 / `gate-v2` rows and
`docs/handoff/v2-07-qa.md` follow the new stem.

### 2. MAJOR — `lettering PASS` with zero letters — **FIXED**

`checks.lettering_expected_pieces(params)` asks the SHARED layout which pieces it
agreed to cut, on the same probe bands `lettering_probe_zs` produces. A band that
carries an accepted piece and shows **0 strokes** is now a FAIL reading
`requested N pieces (…), measured 0 strokes at the … band z=…`. PASS-with-zero
survives only when nothing was requested or everything was refused — refusing
text is a documented outcome, losing it is not. The row prints
`126 strokes of 7 piece(s); 0.488 mm stroke / 0.765 mm ridge`, and `gate-v2`
greps `lettering +PASS +[1-9][0-9]* strokes of [1-9][0-9]* piece` — the number,
not the word. Checked against five synthetic rows: only the genuine one matches,
where the old pattern matched four.

The validator has no scene, so tokens expand against a documented worst-case
`TokenContext` (longest coords / scale / radius / buildings, real `{city}` from
the params). A longer string is harder to fit, never easier, so the piece count
can only ever UNDER-count — it cannot fail a bake that was right to cut nothing.

Regressions: `test_validator_lettering_fails_when_an_accepted_piece_left_no_stroke`
(unit, with the refused-size control beside it) and
`test_cli_fails_lettering_when_the_sidecar_asks_for_text_the_mesh_lacks` (a mesh
baked with no text, judged against a sidecar that requests an engraving and the
north arrow → exit 1, `lettering FAIL`, plus the untouched-sidecar control).

### 3. MAJOR — Playwright `test.fail()` — **FIXED**

`fail` joins the static alternation, and step 5 additionally walks
`results.json`'s suite tree for any test whose `expectedStatus !== "passed"`.
Both layers proved on a planted probe, then removed:

* static — a scratch spec carrying `test.fail()` and `test.fail.each` is named
  by the guard's own `find`+`grep` (2 hits), and the five pre-existing markers
  (`failing`, `it.skip`, `test.only`, `xit`, `test.describe.skip`) still match;
* runtime — a real Playwright run of a `test.fail()` spec reported
  `stats = {expected: 2, skipped: 0, unexpected: 0}`, i.e. **green under the old
  check**, with `expectedStatus: "failed"` on the annotated test. The new node
  check exits 1 and names it.

### 4. MAJOR — the editor never computed the hanger minimum — **FIXED**

`apps/web/lib/warnings.ts` gained `undersideBlockMessage`, a `block` warning
(`id: base-too-thin-for-underside`) built from
`transform.underside_min_base_mm`, so Bake is disabled exactly as for
`model-too-tall` — for keyhole, magnets and the underside mark. It names the
recess, because the number the bake refuses on is 3.6 mm and not the 3.0 mm
`hanger_min_base_mm` alone suggests.

`warningDeps` gained `hanger`, `underside_mark.enabled`, `road_mode` and
`water`: all four move the minimum (3.6 → 3.5 with the roads off → 3.0 with the
water off too). `previewDeps.height` was split onto a new `predictedTopDeps`, the
height half of the same list, so picking a hanger does not invalidate the
canvas's building-height pass — `CityPreview.test.ts` catches that layer by
layer and did.

Cover: five vitest cases plus a `warningDeps` walk against
`underside_min_base_mm`, and an e2e (`a keyhole the base cannot carry disables
Bake and names the minimum`) on the Chicago preset, no network, asserting the
disabled button, the banner, the reason, that a forced click reaches no `/bake`,
and that 4 mm re-enables it. The two `transform.py` docstrings now describe what
the code does.

### 5. MINOR — the playwright.config order comment — **FIXED (comment corrected)**

Measured rather than argued. After `npm run build`, `make up` starts `next dev`
and health-waits on `curl localhost:3000` for up to 120 s, so the recompile
finishes before Playwright is launched. On this host the dev log read
`✓ Compiled / in 1612ms` then `GET / 200`, and across the whole 4.1-minute suite
`artifacts/logs/web.log` held **zero** `Cannot find module` or `full reload`
lines. The comment was over-broad: it now says that *who waits for the recompile*
is what decides it, names `make gate`'s order as safe and why, and keeps
`rm -rf .next` and `FRAMECRAFT_WEB_MODE=prod` as the other options. `make gate`'s
own comment says the same. The gate's order is unchanged, so nothing about its
runtime is a guess.

### 6. MINOR — the unreachable `make down` rc check — **FIXED**

`make down` verifies by PORT: after the kill it waits up to 15 s for 8000 and
3000 to clear and exits 1 naming the survivor; `docker compose down` is no longer
swallowed either. Proved reachable — a `node http` server planted on :3000 made
`make down` print `down: port 3000 is STILL held by pid 55076 - web did not stop`
and exit 1; with the port freed, and with the real stack up, it exits 0.

### 7. MINOR — `PLATE=` range — **FIXED**

Range-checked 100..256 with `awk`, beside the existing shape check, with a
message that names `print_params.json` as the source. Verified: 99 and 257
rejected by the Makefile; 100, 256 and 180.5 accepted; `abc` and `1.2.3` still
rejected by the shape check.

### 8. MINOR — `gate-v2` step 1 — **FIXED**

Runs `-q -rs` into `artifacts/logs/gate-v2-g8.log`, asserts
`(^|[^0-9])11 passed` through the same `need()` the other steps use, and fails
on any `skipped` / `xfailed` / `xpassed`.

### 9. MINOR — the hard-coded refused size — **FIXED**

`ui.spec.ts` derives it from `lettering_layout` itself
(`largestRefusedCapHeightMm`, walking the slider's own 0.1 mm step down from the
seeded default), asserts the slider readout matches, and logs it — the run
printed `the shared layout refuses a 3.0 mm cap height`. `:311`'s
`expect(withText).toBe(8)` is left alone on purpose: eight rings for "Chicago" is
a measurement of the earcut output, and deriving it from the same layout would
make it circular.

### 10-14. NOTES — **NOT FIXED**, deliberately

* **10** — widening the static guard to `.js`/`.mjs` and to `services/bake` was
  outside this brief; the tree is clean today (a repo-wide grep for the pytest
  markers and for `test.fail(` / `.concurrent.` / `runIf` still returns nothing)
  and the runtime summary checks cover both languages.
* **11** — scope note, no defect. Unchanged.
* **12** — the non-default `road_mode` branch is now covered on the WEB side
  (`warnings.test.ts` walks 3.6 → 3.5 → 3.0) as well as at unit level in both
  languages. No new API-level parametrisation was added.
* **13** — the self-comparing tuple is harmless and the real value check is the
  next line; touching it is churn.
* **14** — count floors for pytest/vitest/Playwright were not added: the counts
  move every phase by design, and a floor would be edited by the same hand that
  deletes a test. Not in this brief.

### Verification actually run

| Command | Result |
|---|---|
| `cd services/bake && uv run pytest -q -rs` | **601 passed**, 0 skipped, 0 xfailed, 254 s |
| `cd apps/web && npm test -- --run` | **537 passed** in 27 files, 0 skipped |
| `cd apps/web && npm run typecheck` / `npm run lint` | clean (`--max-warnings 0`) |
| `cd apps/web && npm run build` | rc 0 |
| `npm run test:e2e` (stack up, after the build) | **26 passed**, `stats.skipped = 0`, 0 expected-failure, 4.1 m |
| `make gate-v2 > artifacts/logs/gate-v2-fix07.log` | **GATE-V2 PASS**, rc 0 |
| `make down` (idle / with a survivor on :3000) | rc 0 / rc 1 naming the pid |

`make gate` was deliberately NOT run here: the orchestrator runs it after this
pass.
