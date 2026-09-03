# v3-14 CI diet: adversarial audit

Read-only audit of the uncommitted Task 14 change set: `.github/workflows/ci.yml`,
`.github/workflows/nightly.yml`, `.github/workflows/desktop-build.yml`,
`.github/workflows/release.yml`, `.github/actions/cache-report/action.yml`,
`scripts/ci-export-matrix.sh`, `scripts/ci-preset-matrix.sh`, `Makefile`,
`apps/web/playwright.config.ts`, `apps/web/package.json`,
`apps/web/e2e/smoke.spec.ts`, `RUNBOOK.md`, `CONTRIBUTING.md`.
`apps/web/lib/engine/**` and `apps/web/components/map/**` were out of scope.

Nothing was modified. No `make -n` was run on any gate target. Every workflow and
the composite action were parsed with PyYAML through `uv run --with pyyaml` in
`services/bake`: all six parse. Both new scripts pass `sh -n`. `shellcheck` is
not installed on this host, so the shell review below is by reading.

Counts: **3 blockers, 5 major, 12 minor, 3 notes.**

---

## 1. Coverage accounting

Every check the old `ci.yml` ran, and every check `make gate` runs, mapped to
where it runs now. "fast" is `.github/workflows/ci.yml`, "nightly" is
`.github/workflows/nightly.yml`.

| Check | Old home | New home | Verdict |
|---|---|---|---|
| static no-skip guard (find + xargs grep over every `*.test.*` / `*.spec.*`) | old `ci.yml` job `web`, `make gate` step 1 | fast `lint-typecheck` (`ci.yml:67-84`), `make gate-fast` step 1 (`Makefile:329-346`) | present, regex byte-identical |
| pytest `-q -rs` | old `web` sibling job `reference-service` | fast `pytest` (`ci.yml:200-202`) | present, but see B2 |
| pytest zero skipped / xfailed / xpassed | old `ci.yml:42-50` | fast `ci.yml:204-212` | present, regex identical |
| eslint `--max-warnings 0` | old `ci.yml:92-94` | fast `ci.yml:109-111` | present |
| `tsc --noEmit` | old `ci.yml:96-98` | fast `ci.yml:113-115` | present |
| vitest | old `ci.yml:100-102` | fast `ci.yml:151-153` | present, but see B2 |
| vitest zero skipped / todo | old `ci.yml:104-112` | fast `ci.yml:155-163` | present, regex identical |
| `next build` | old `ci.yml:114-116` | fast `ci.yml:275-277` | present |
| `export:cli` single mode | old `ci.yml:140-145` | fast `ci.yml:307-312` | present, flags identical |
| `export:cli` parts mode | old `ci.yml:147-152` | fast `ci.yml:314-319` | present, flags identical |
| validator on both files, `rc` aggregated | old `ci.yml:163-169` | fast `ci.yml:323-329` | present, byte-identical |
| Playwright, whole suite | old `ci.yml:213-226` | nightly `e2e-full` (`nightly.yml:133-138`) | present |
| Playwright, one representative path | did not exist separately | fast `e2e-smoke` (`ci.yml:440-449`) | new |
| `results.json` zero-skip + zero-expected-failure walk | old `ci.yml:228-262` | fast `ci.yml:455-495` **and** nightly `nightly.yml:143-177` | present in both, walk logic identical; the fast copy adds a non-empty-selection assertion |
| e2e artifact upload on failure | old `ci.yml:269-278` | fast `ci.yml:513-522` (7 days) and nightly `nightly.yml:179-188` (14 days) | present |
| `fixtures/` stray-sha1 check (`make gate` step 8) | never in CI | fast `ci.yml:501-511` | new on fast, **absent from nightly** (see M4) |
| `make gate-v2` | never in CI | nightly `geometry-gates` (`nightly.yml:232-233`) | new |
| every export target + tiling | never anywhere | nightly `export-matrix` (`nightly.yml:310-311`) | new |
| all six presets offline | never anywhere | nightly `preset-matrix` (`nightly.yml:389-392`) | new |
| desktop installers | release.yml on a tag only | release.yml on a tag + nightly `desktop` | new, **but broken**, see B1 |
| `make up` / `make down` lifecycle + port teardown assertion (`make gate` steps 0, 6, 7) | never in CI | still local only | unchanged, not a regression |

**Nothing lands in "nowhere."** The union of fast plus nightly is a strict
superset of the old required path. The two zero-skip guards survive verbatim in
both paths (the vitest and pytest greps are character-for-character the old
ones; the `results.json` walk is the same `walk`/`expectedStatus` traversal in
`ci.yml:469-478` and `nightly.yml:157-166`). The Playwright walk runs on the
smoke subset and on the full suite, as required.

Two caveats on that clean sheet, developed below: the nightly workflow as
written will not start at all (**B1**), which sends every "nightly" row in the
table to nowhere in practice; and two of the five fast jobs cannot report a
failure of their primary check (**B2**).

---

## 2. Findings

### B1. blocker. `nightly.yml`'s `desktop` job escalates `GITHUB_TOKEN` permissions, so the nightly workflow fails validation

`nightly.yml:31-33` sets workflow permissions to `contents: read` plus
`actions: read`. `nightly.yml:407-411` calls `./.github/workflows/desktop-build.yml`,
which declares `permissions: contents: write` at `desktop-build.yml:32-33`.

A called workflow can only maintain or reduce the caller's token permissions,
never raise them. GitHub's own documentation states permissions "can only be
maintained or reduced, not elevated, throughout the chain", and the observed
failure is a validation error of the form `The nested job 'desktop' is requesting
'contents: write', but is only allowed 'contents: read'.` The check happens when
the run is created, not when the job starts, so `if: github.event_name != 'push'`
at `nightly.yml:409` does not save it: the guard is evaluated after validation.

Consequence: the entire nightly run errors out. Every check this task moved off
the required path (the 57 remaining Playwright tests, `make gate-v2`, the export
matrix, the preset matrix) then runs nowhere at all, which is the exact failure
the brief calls a blocker. The task never executed a workflow (`v3-14-ci.md`
section 9 says `act` is not installed and nothing was pushed), so this was never
observed.

How to prove it: push the branch and run `gh workflow run nightly.yml`, or
`gh api repos/:owner/:repo/actions/workflows/nightly.yml/dispatches`. The run
appears with a red annotation and zero jobs started.

Smallest correct fix: drop the `permissions:` block from `desktop-build.yml`
entirely so the called workflow inherits whatever the caller grants, then give
release.yml's caller the write scope it needs:

```yaml
# release.yml, the desktop job
  desktop:
    needs: create-release
    permissions:
      contents: write
    uses: ./.github/workflows/desktop-build.yml
```

Nightly then builds under `contents: read`, which is all a build-and-discard run
needs. The alternative one-liner (add `permissions: {contents: write}` to
nightly's `desktop` job) also works but hands the nightly build a write token it
has no use for.

### B2. blocker. The required path cannot fail on a vitest or pytest failure: no `pipefail`

`ci.yml:153` is `npm test 2>&1 | tee vitest.log` and `ci.yml:202` is
`uv run pytest -q -rs 2>&1 | tee pytest.log`. Neither step, nor the workflow,
sets `shell:` or a `defaults.run.shell`. GitHub's default shell on Linux is
`bash -e {0}`, without `pipefail`; only an explicit `shell: bash` gets
`bash --noprofile --norc -eo pipefail {0}`. The pipeline therefore exits with
`tee`'s status, which is always 0.

The follow-up steps do not compensate. `ci.yml:155-163` greps for
`[0-9]+ (skipped|todo)` and `ci.yml:204-212` greps for
`[0-9]+ (skipped|xfailed|xpassed)`. A test that simply **fails** prints
`N failed`, matches neither, and the job goes green.

Proof, run on this host:

```
$ bash -e -c 'false 2>&1 | tee /dev/null; echo "exit: $?"'
exit: 0
$ bash --noprofile --norc -eo pipefail -c 'false 2>&1 | tee /dev/null'; echo $?
1
```

This is inherited from the old `ci.yml:102` and `ci.yml:40`, not introduced by
Task 14. It is still a blocker for the deliverable as briefed: `unit` and
`pytest` are two of the five jobs that make up the required merge gate, and
neither can turn red for the reason it exists.

Smallest correct fix, one block at the top of both `ci.yml` and `nightly.yml`:

```yaml
defaults:
  run:
    shell: bash
```

Verify the composite action is unaffected: `cache-report/action.yml:43` already
declares `shell: bash`, so it already runs with `-eo pipefail` and its `set -u`,
`|| prior="unknown"` and `if json=$(...)` guards are all `-e` safe.

### B3. blocker. `RUNBOOK.md` section 7 tells the reader the opposite of the truth about what the fast path proves

Three separate wrong statements in the one document whose purpose is to stop a
green tick being read as a release signal.

1. `RUNBOOK.md:175-179`: "Only 2 of the 50 Playwright tests ran. **The happy
   path** (preset, preview, a local PrintParams change, export, a 3MF download)
   and the small-scene validator round trip." The happy path is precisely the
   test that was deliberately excluded (`playwright.config.ts:138-148`,
   `ci.yml:340-344`, `v3-14-ci.md:87`). A reader of section 7 concludes the most
   representative test ran on their pull request when it did not. The count is
   also wrong twice over: three tests are tagged, and the suite is 60 tests, not
   50 (verified below).
2. `RUNBOOK.md:203-206`: "bambu-3mf, generic-3mf, color-change-3mf, stl and
   every tile get a full printability verdict, while stl-parts-zip, obj and step
   get a non-empty-plus-header check." `scripts/ci-export-matrix.sh:134-140`
   gives bambu-3mf and color-change-3mf the **structure** check, not a
   validator verdict, and the script's own header (`ci-export-matrix.sh:26-34`)
   and `v3-14-ci.md:180` both say so. The RUNBOOK promotes two structure rows to
   validated rows.
3. `CONTRIBUTING.md:93` repeats "2 of the 50 acceptance tests."

How to prove the counts:

```
$ cd apps/web && npx playwright test --project=chromium-smoke --list
Total: 3 tests in 1 file
$ npx playwright test --project=chromium --list
Total: 60 tests in 11 files
```

Smallest correct fix: in `RUNBOOK.md:175` name the three tagged tests (empty
Overpass, small-scene validator round trip, Bambu project export) and say
explicitly that the happy path is **not** among them; in `RUNBOOK.md:203` move
bambu-3mf and color-change-3mf into the structure sentence; replace every
hard-coded suite size with "the tagged subset" and "the full suite".

### M1. major. Nightly does not gate the tag release, though `nightly.yml` says it does

`nightly.yml:5-8` claims the tag trigger exists "so the full suite, the geometry
gates and every export format run BEFORE release.yml's installers are built on
that same tag." Both workflows fire on the same `push` to `refs/tags/v*`
(`nightly.yml:24-25`, `release.yml:20-22`). They are separate workflows with no
dependency between them, so they start concurrently, and `release.yml` creates
the GitHub Release and attaches installers whether nightly is green, red, or
still running.

How to prove it: tag a throwaway commit and watch both runs in `gh run list`;
their `startedAt` values are within seconds of each other and release.yml
finishes first (its `create-release` job has `timeout-minutes: 5`).

Smallest correct fix: either correct the comment to say the two run in parallel
and nightly is advisory, or make it real by turning the heavy jobs into a
reusable workflow that `release.yml`'s `create-release` job depends on.

### M2. major. The warm-miss assertion can fail unrelated pull requests

`.github/actions/cache-report/action.yml:88-101` fails the job whenever the
restore reported a miss while the cache API lists an entry with that exact key,
readable, created before the run started. The API query correctly distinguishes
a first-ever run from a regression, which answers the brief's question, and the
`prior = 0` and `prior = unknown` branches are right. But `cache-hit != true`
is not only produced by "the entry was not there":

- `actions/cache` swallows restore errors. On a transient cache-service 5xx it
  logs `Failed to restore` and sets `cache-hit` to false. The entry is still
  listed by the API, so the report calls it a **WARM MISS** and exits 1. An
  unrelated pull request goes red on a GitHub incident.
- `actions/cache` matches on key **and** an internal version derived from the
  path list and compression. If anyone ever changes `path:` for one of these
  keys in one workflow and not the other, every run misses while the API keeps
  listing the other workflow's entry. That is a permanent, self-inflicted red
  with a misleading error message. Today all four paths agree across `ci.yml`
  and `nightly.yml`, so it is a latent trap rather than a live bug.
- Eviction landing between the restore step and the report step produces the
  same false red, with a narrow window.

`v3-14-ci.md:275-285` lists three honest limits but not these.

Smallest correct fix: keep the row, downgrade the enforcement so it cannot block
a contributor. Either gate `fail=1` on `github.ref == 'refs/heads/main'`, or
require two consecutive warm misses before failing (the fallback the brief
originally allowed).

### M3. major. The `next build` cache key guarantees a new cache entry on every commit, evicting the caches the ten-minute budget depends on

`ci.yml:256` keys `apps/web/.next/cache` on the lock hash plus
`hashFiles('apps/web/app/**', 'apps/web/components/**', 'apps/web/lib/**',
'apps/web/store/**', 'apps/web/public/**', ...)`. Any source edit produces a new
key, and `actions/cache` saves under the new key in the post step. Every push and
every pull-request commit therefore writes a fresh `.next/cache` entry into the
repository's 10 GB cache budget. GitHub evicts least-recently-used entries once
the budget is exceeded, and the entries most likely to be evicted are the ones
this workflow does not rewrite on every commit: npm, uv, and above all the
Playwright browser bundle the baseline measures at 3m 46s to re-download
(`ci.yml:400-402`).

The task recognised the key churns (`ci.yml:260-262` sets `enforce: "false"` for
exactly that reason) but treated it only as a reporting problem, not as a budget
problem.

How to prove it: after a week on main, `gh api repos/:owner/:repo/actions/cache/usage`
and `gh cache list --limit 100` show the `next-*` entries dominating both the
count and the size.

Smallest correct fix: key the next cache on the lock file plus `github.ref_name`
only, and let the existing `restore-keys` (`ci.yml:257-258`) supply warmth. Next
invalidates its own cache entries internally, so an exact source hash buys
nothing that `restore-keys` does not already give.

### M4. major. The full nightly Playwright suite has no stray-fixture guard

`ci.yml:501-511` runs `make gate` step 8 on the fast path: it fails if a
40-hex-character `.json` appeared under `fixtures/`, which is what happens when a
spec reaches Overpass unmocked. `nightly.yml`'s `e2e-full` job has no equivalent
step. The three tagged tests are checked; the 57 that are not tagged, and are
therefore the far likelier source of a forgotten route mock, are not.

`make gate` (`Makefile:275-289`) has the check, so the local full gate is
stronger than the nightly full gate.

How to prove it: delete the `**/api/interpreter` route mock from any non-smoke
spec, run the suite, and observe that nothing in `nightly.yml` notices.

Smallest correct fix: copy the `ci.yml:501-511` step verbatim into `e2e-full`,
keeping `if: always()`.

### M5. major. `gate-fast` and the fast CI path claim mirror status they do not have on the `git` precondition

`Makefile:380-389` wraps the stray-fixture check in `if command -v git ...; fi`
with no `else`. `make gate` at `Makefile:275-289` has an `else` arm (`:287-288`)
that sets `rc=1` with "git is not on PATH, cannot check fixtures/ for strays". So
on a host without git, `make gate` fails and `make gate-fast` silently passes
with one fewer assertion, while `RUNBOOK.md:189` and the `gate-fast` header
comment say the two run "the same guards".

Smallest correct fix: add the same `else ... rc=1` arm before the `fi` at
`Makefile:389`.

---

### Minor

1. **`Makefile:318` contradicts `Makefile:378`.** The comment says the grep "must
   have selected at least 2 tests"; the code asserts `ran<3`. Change the comment
   to 3.
2. **Stale suite sizes in code comments.** `ci.yml:10` ("50 tests"), `ci.yml:344`
   ("the other 47 tests"), `playwright.config.ts:121-127` ("every test", "against
   8.6 min for all 50"), `v3-14-ci.md:106` ("50 tests in 10 files"). Measured
   now: 60 tests in 11 files. `search.spec.ts` landed from another agent during
   this task, so the drift is not this task's doing, but the numbers are wrong in
   files this task wrote.
3. **`RUNBOOK.md:181` understates the fast path.** "One of the seven export
   targets was exercised" ignores the `@smoke` Bambu project test, which drives
   bambu-3mf through the UI on every commit. `v3-14-ci.md:157` gets this right.
4. **Unreachable error message in the Playwright version step.** `ci.yml:405-410`
   and `nightly.yml:101-107` do `v=$(node -p "...")` then `if [ -z "$v" ]`. Under
   `bash -e` a failing `node -p` aborts the step at the assignment, so the
   friendly `::error::could not read @playwright/test's version` never prints.
   Use `v=$(node -p "..." || true)`.
5. **Sidecar not asserted for tiles.** `ci-export-matrix.sh:171-194` validates
   each tile `.3mf` but never checks that `generic-3mf-A1.json` and its three
   siblings were written, although the header at `ci-export-matrix.sh:174` and
   `export-cli.ts:314-343` both make the sidecar part of the contract.
6. **The tiled build reuses the plain build's `--out` stem.**
   `ci-export-matrix.sh:125` and `:176` both target
   `artifacts/export-matrix/generic-3mf.3mf`, so the second run overwrites the
   first run's sidecar `generic-3mf.json`. The validated `.3mf` itself survives
   (a tiled build writes a zip, not a `.3mf`, at `--out`), so this is cosmetic,
   but a `--out .../generic-3mf-tiled.3mf` removes the ambiguity.
7. **`ci-preset-matrix.sh:42-57` ignores the reader's exit status.** The `node -e`
   block sets `process.exitCode = 1` when a fixture file is missing but the shell
   only inspects `$presets` and the `count -lt 6` guard at `:59`. A seventh preset
   with a missing fixture passes silently. Capture and test `$?`.
8. **Two parallel npm caches.** `ci.yml` and `nightly.yml` cache `~/.npm` under an
   explicit key, while `release.yml:70-73` and `desktop-build.yml:53-57` still use
   `setup-node`'s `cache: npm`, which caches the same directory under a different
   key. Both consume the same 10 GB budget, which compounds M3.
9. **Nightly signs and notarizes with the real Apple credentials every night.**
   `nightly.yml:411` is `secrets: inherit`, and `desktop-build.yml:87-98` exports
   `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` whenever they are non-empty,
   regardless of `inputs.tag_name`. Guard the `APPLE_*` lines on
   `inputs.tag_name != ''` so a build-only run stays a build.
10. **`$GITHUB_ENV` write is fragile for multi-line or quote-bearing secrets.**
    `desktop-build.yml:90` is `echo "$1=$2" >> "$GITHUB_ENV"`, which produces an
    invalid entry for any secret containing a newline, and `:91-98` interpolate the
    secret inside single quotes, which a secret containing a single quote would
    break out of. Moved verbatim from `release.yml` at HEAD, so pre-existing. Use
    the heredoc delimiter form.
11. **Cache summary rows go missing after an earlier failure.** In
    `build-and-validate` the uv report at `ci.yml:292-297` sits after `next build`
    at `:275-277`. When the build fails, the job summary has npm and next rows and
    no uv row. The action itself does write its own row before exiting 1
    (`action.yml:94` precedes `:101`), so the failing row is always visible.
12. **No `DECISIONS.md` line.** The change makes a policy decision that the
    required merge gate is now deliberately partial. `docs/handoff/v3-14-ci.md`
    records it; the append-only decisions log does not.

### Notes

1. **`grep -a` is a GNU extension**, used at `ci-export-matrix.sh:113`. Fine on
   `ubuntu-latest` and on Git Bash, not POSIX. Both scripts otherwise avoid
   bashisms: no `local`, no arrays, no `[[`, and `$((x + 1))` throughout. Both
   pass `sh -n`. `structure()`'s `$#` at `:120` is read after `shift 2`, so the
   marker count it prints is correct.
2. **`created_at` versus `run_started_at` comparison** at `action.yml:78` is a
   lexicographic string compare. The API returns fractional seconds
   (`...:00.000Z`) and `github.run_started_at` does not (`...:00Z`), so an entry
   created in the same second as the run start sorts as "before". A one-second
   window, harmless in practice.
3. **`dtolnay/rust-toolchain@stable`** at `desktop-build.yml:60` is a floating
   branch, not a tag or SHA. Pre-existing, moved verbatim, and the only
   non-`@vN` action reference in the tree.

---

## 3. The `@smoke` subset, judged on its merits

Verified selection, not inferred:

```
$ cd apps/web && npx playwright test --project=chromium-smoke --list
  smoke.spec.ts:439  low coverage: an empty Overpass response warns and disables Export @smoke
  smoke.spec.ts:468  the downloaded file passes the Python printability validator (small scene) @smoke
  smoke.spec.ts:612  exporting a Bambu Studio project writes every region on its own extruder @smoke
Total: 3 tests in 1 file
```

- **`--grep` and the project select only these.** The project-level
  `grep: /@smoke/` at `playwright.config.ts:158` matches the tag in the title, and
  `chromium` at `:157` carries no `grepInvert`, so the tag selects without
  excluding. Confirmed by the two `--list` runs.
- **`testDir` / `testMatch` inheritance is correct.** The config sets only
  `testDir: "./e2e"` at `:77` with no `testMatch` or `testIgnore`, so
  `chromium-smoke` inherits the same discovery as `chromium`. The new
  `apps/web/e2e/fixtures/` directory holds two `.json` files and matches no test
  glob.
- **`webServer` reaches the smoke project.** It is declared at config level
  (`:160-183`), not per project, so `npm run test:e2e:smoke` starts uvicorn and
  `next dev` exactly as the full run does.
- **`npm run test:e2e` still runs everything.** `package.json:14` became
  `playwright test --project=chromium`; with two projects defined, naming the
  project is what preserves the old behaviour, and `--list` confirms 60 tests.
  `make gate` at `Makefile:249` calls `npm run test:e2e`, so its behaviour is
  unchanged.
- **`E2E_BUDGET_FACTOR` reaches the smoke project.** It is read at
  `smoke.spec.ts:39` as `process.env.E2E_BUDGET_FACTOR`, per spec file, not in
  the config, so a step-level `env:` at `ci.yml:443` applies to whichever project
  runs.
- **No assertion changed in `smoke.spec.ts`.** `git diff HEAD -- apps/web/e2e/smoke.spec.ts`
  is three hunks, each a single title line gaining ` @smoke`. Nothing else.

**On dropping the happy path.** The note's reasoning at `v3-14-ci.md:87-101` is
sound arithmetic and I do not dispute the numbers: 2m 12s locally, a 2.2x to 3.7x
SwiftShader penalty, so 5 to 8 minutes for one test against a seven-minute
budget. But the substitute it offers is not equivalent, and the note slightly
oversells it. `build-and-validate` proves the **engine** builds and exports 992
Chicago buildings that the validator accepts. The happy path proves something
different: that the r3f preview renders them, that a slider change stays local
and provokes no navigation (01/A3), that the frame rate holds, and that the
download actually lands in the browser. A regression that leaves `export:cli`
green and the preview blank, or that reintroduces a full page reload on a
PrintParams change, is invisible to the fast path and waits until 03:30 UTC.

That is the largest single risk the change accepts, and given the fast path is
projected at 3m 30s to 5m 40s against a ten-minute budget, there is roughly four
minutes of headroom that is currently unspent. My recommendation is not to tag
the happy path as it stands, but to add a third small tagged test that asserts
only the cheap half of it (preset applies, canvas paints a non-empty frame, one
slider change causes zero navigations) on the small synthetic scene the other
tagged tests already use. That costs seconds, not minutes, and closes the gap the
note itself flags at `v3-14-ci.md:99-101` as "the first thing to reconsider."

---

## 4. Workflow correctness, item by item

- **`needs` graph.** `ci.yml` has no `needs` anywhere: five genuinely independent
  jobs, correct. `nightly.yml` likewise. `release.yml:53` and `:62` keep
  `needs: create-release` for both `desktop` and `web-zip`, unchanged.
- **`timeout-minutes`.** Every job sets one; none is left at the 60-minute
  default except where 60 is deliberate. But `v3-14-ci.md:135` claims "roughly
  three to four times the projection", which holds for `unit` (12m against 3m 05s)
  and `pytest` (15m against 3m 20s) and not for `lint-typecheck` (10m against
  0m 50s, twelve times) or `build-and-validate` (15m against 2m 15s, nearly
  seven times). More to the point, the ten-minute budget is asserted nowhere: a
  hung job can hold the required path for fifteen minutes and still be "green
  path, under budget" by the note's own accounting. Consider `timeout-minutes: 10`
  on all five.
- **Concurrency.** `ci.yml:38-40` is `ci-${{ github.workflow }}-${{ github.ref }}`
  with `cancel-in-progress: true`; `nightly.yml:27-29` is `nightly-${{ github.ref }}`
  with `cancel-in-progress: false`. The groups cannot collide, so a push cannot
  cancel a nightly and a nightly cannot cancel a push. `cancel-in-progress: false`
  is right for the schedule. One consequence worth knowing: `cancel-in-progress:
  true` also applies to pushes to `main`, so two pushes in quick succession leave
  the first commit with a cancelled required run.
- **Permissions.** `ci.yml:44-46` is `contents: read` plus `actions: read`, which
  is exactly what the cache API query needs and nothing more. `nightly.yml:31-33`
  is the same and is the cause of **B1**. `desktop-build.yml:32-33` asks for
  `contents: write`, which only the release caller needs.
- **`workflow_call` contract.** `desktop-build.yml:19-30` declares `tag_name`
  (string, default `""`) and `timeout_minutes` (number, default 60), no `secrets:`
  block, so both callers use `secrets: inherit`. `release.yml:52-57` passes
  `tag_name: ${{ github.ref_name }}`, which is byte-for-byte what
  `tauri-action`'s `tagName` received at HEAD (`release.yml:120` before the
  change), and the three matrix `args` strings are unchanged, so **asset names are
  identical to before**. `nightly.yml:410` passes nothing, so `tagName` is empty
  and `tauri-action` neither creates nor uploads to a release: a pure build, as
  intended.
- **`if:` guards.** `nightly.yml:409` `github.event_name != 'push'` correctly
  skips the desktop matrix on the `v*` tag trigger and keeps it for `schedule`
  and `workflow_dispatch`.
- **Shell defaults.** Neither new workflow sets `defaults.run.shell`. See **B2**.
  The composite action does set `shell: bash` (`action.yml:43`), so it alone gets
  `-eo pipefail`.
- **Matrix `fail-fast`.** Only one matrix exists, `desktop-build.yml:38`, and it
  keeps `fail-fast: false` from HEAD, so one platform breaking still reports the
  other two.
- **Artifact retention.** 7 days on the fast path (`ci.yml:522`), 14 on nightly
  (`nightly.yml:188`, `:242`, `:320`, `:401`). Reasonable and deliberate.
- **Secrets on `pull_request`.** `ci.yml` references only `${{ github.token }}`
  (four cache-report call sites) and no `secrets.*`. A fork pull request needs
  nothing it cannot have.

---

## 5. Caching

| Cache | Path | Key | Restore keys | Changes when it should? |
|---|---|---|---|---|
| npm | `~/.npm` | `npm-<os>-<hash of apps/web/package-lock.json>` | none | yes |
| uv | `~/.cache/uv` | `uv-<os>-<hash of services/bake/uv.lock>` | none | yes |
| Playwright | `~/.cache/ms-playwright` | `playwright-<os>-<@playwright/test version>` | none | yes, and only on a Playwright bump |
| next | `apps/web/.next/cache` | lock hash + hash of app, components, lib, store, public, three configs | `next-<os>-<lock hash>-` | yes, and far too often: see **M3** |

The Playwright version is extracted at `ci.yml:403-412` with
`node -p "require('./apps/web/package-lock.json').packages['node_modules/@playwright/test'].version"`,
which returns `1.62.1` on this tree. Keying on the version rather than the whole
lock is the right call and does what the comment at `ci.yml:400-402` says: an
unrelated dependency bump no longer discards a 3m 46s download. The one flaw is
the unreachable error branch, minor 4.

The browsers-versus-OS-deps split at `ci.yml:431-438` and `nightly.yml:124-131`
is correct: `install-deps chromium` on a hit (the apt libraries live outside
`~/.cache`), `install --with-deps chromium` on a miss. No path installs the
browser without its OS deps.

On `.github/actions/cache-report/action.yml`: the API-based definition of a warm
miss is genuinely stronger than the lock-file comparison the brief suggested, and
it answers the four scenarios asked about correctly for three of them. First-ever
run after this lands: `prior = 0`, cold miss, no failure. New branch: a pull
request reads `refs/pull/N/merge` or the default branch, both accepted by the
`select(.ref == $cur or .ref == $def)` filter at `action.yml:77`, so a
default-branch entry both restores and is counted, and the two agree. Cache API
down or a token without `actions: read`: `prior = "unknown"`, the row reads
"warmth NOT asserted", no failure, no silent pass. Cache eviction: the entry
disappears from the listing too, so `prior = 0`. The sibling-job race is closed
by `select(.created_at < $t)` at `action.yml:78`.

What it does not handle is a restore that fails for a reason other than absence.
That is **M2**. The summary row is written before the failure (`action.yml:94`
precedes `:101`), so a failing cache row is always visible in
`$GITHUB_STEP_SUMMARY`; a row for a cache whose report step never ran, because an
earlier step failed, is not (minor 11). The header is emitted once per job via a
`$RUNNER_TEMP` marker at `action.yml:55-64`, which is correct per job and per
runner.

---

## 6. Scripts

Both pass `sh -n`. `shellcheck` is not on this host; the review below is by
reading.

- **POSIX compliance.** No `local`, no arrays, no `[[ ]]`, no `${var,,}`,
  arithmetic via `$(( ))`, functions in the portable form. The one extension is
  `grep -a` (note 1). Both will run under dash on `ubuntu-latest` and under Git
  Bash on this host. `"$MAKE_BIN"` is quoted at `ci-export-matrix.sh:85` and
  `ci-preset-matrix.sh:70`, and the Makefile passes `"$(MAKE)"` quoted at
  `Makefile:410` and `:412`, so a Windows make path containing spaces survives.
- **Exit-code aggregation.** Both scripts set `rc=1` and continue. In
  `ci-export-matrix.sh` every one of the seven targets plus the four tiles is
  attempted regardless of an earlier failure (`:125`, `:126`, `:134-140`,
  `:146-168`, `:176-194`), and the counters `validated` and `structural`
  increment in the current shell because `judge`/`structure` are invoked outside
  any subshell. `ci-preset-matrix.sh:86-110` uses `continue` on a build failure so
  the remaining presets still run. One failing target fails the job and the rest
  still report. Correct.
- **The tiled case.** `ci-export-matrix.sh:176-194` builds `--tiling 2x2` and
  validates `generic-3mf-A1.3mf` through `-B2.3mf` individually, asserting all
  four exist. The naming matches `tileStem` (`apps/web/lib/engine/export/tiles.ts:51`,
  pinned by `tiles.test.ts:217` as `city-B2`). Each tile is judged in its own
  right, which is the point. The per-tile sidecar is written by
  `export-cli.ts:334-343` but not asserted (minor 5).
- **The preset matrix's honesty.** The reference pipeline covers all six presets
  offline: `cmd_bake` at `services/bake/app/cli.py` sets
  `allow_network=not (args.offline or bool(request.preset_id))`, so a preset id
  alone forces offline, and the nightly job also sets `FRAMECRAFT_OFFLINE: "1"`
  at `nightly.yml:390-391`. `bake` writes the `.3mf` and the `.stl` beside it, so
  judging both at `ci-preset-matrix.sh:102-108` is real. The browser-engine row is
  Chicago-only for the reason stated, and the `--center` gap is correctly recorded
  as an open item rather than quietly skipped.
- **Windows.** Both run here: `sh scripts/... ` ignores the `#!/usr/bin/sh`
  shebang, `wc -c < file`, `tail -n`, `tr` and `grep -a` all behave under Git
  Bash, and nothing sets an environment variable to a value beginning with `/`
  that MSYS path conversion would mangle. The `make gate-fast` and
  `make gate-nightly` recipes likewise set only `FRAMECRAFT_OFFLINE=` and
  `E2E_BUDGET_FACTOR=3` (`Makefile:376`), neither of which is a path.

---

## 7. Local mirrors

- **`make gate` is unchanged in behaviour.** The only touch is
  `package.json:14`, `playwright test` becoming `playwright test --project=chromium`.
  With one project defined, the bare command ran that project; with two defined,
  naming it is what keeps the old behaviour, and `--list` confirms the same 60
  tests. No line of the `gate:` recipe (`Makefile:181-297`) changed.
- **`make gate-fast` mirrors the fast CI job set closely but not exactly.** It
  runs the static guard, pytest plus its zero-skip grep, eslint, tsc, vitest plus
  its zero-skip grep, `next build`, `scripts/gate-web-engine.sh` (the same two
  exports and two validations `build-and-validate` runs), the `@smoke` subset,
  the `results.json` walk with the non-empty-selection assertion, and the
  stray-fixture check. Two divergences: the `git`-missing arm (**M5**) and the
  fact that gate-fast skips the whole e2e block after any earlier failure
  (`Makefile:370-372`) whereas CI's five jobs are independent and always all
  report. The second is a reasonable local shortcut, but it means gate-fast tells
  you less than CI does on a red run, and the header comment does not say so.
- **`make gate-nightly` mirrors the nightly job set**, allowing for the desktop
  matrix that cannot run on one host and which the recipe says so at
  `Makefile:414-415`. It runs `make gate` (a superset of `e2e-full`),
  `make gate-v2`, then both matrix scripts, each with `|| rc=1` so everything is
  attempted. Correct.
- **`.PHONY` and `help`.** Both new targets are in `.PHONY` at `Makefile:3` and
  documented in `help` at `Makefile:18-22`.

---

## 8. Verdict

The shape of this change is right and the accounting behind it is unusually
honest: the job graph is genuinely parallel, the cheap check does come before the
expensive one inside every job, the caches are keyed on the right inputs, one
runner and one Node version carry the fast path, the desktop matrix has been
lifted into a single reusable definition with two callers so release and nightly
cannot drift, and the two new matrix scripts add coverage that has never existed
in this repository, including three real defects they found and did not suppress.
The zero-skip guards survive verbatim on both paths, the `results.json` walk runs
over the smoke subset and the full suite, and the smoke job adds a
non-empty-selection assertion the full suite does not need. Nothing that used to
run has been deleted, and no assertion has been loosened to buy speed.

It is not shippable as it stands. The nightly workflow, which is where every
check this task moved off the required path now lives, fails GitHub's permission
validation before a single job starts, and because the task was never able to
execute a workflow this was never seen. Two of the five required jobs cannot go
red for the failure they exist to detect, because the default runner shell has no
`pipefail` and both pipe through `tee`. And the one document whose job is to stop
a green tick being mistaken for a release signal tells the reader that the happy
path ran when the happy path is the single test most deliberately excluded, and
promotes two structure-only export rows to full validator verdicts. Those three
are cheap to fix: a permissions block, a `defaults.run.shell` block, and three
corrected paragraphs. The five major findings are about resilience and truth in
advertising rather than correctness, and none of them requires rethinking the
design. Fix the blockers, run `nightly.yml` once on `workflow_dispatch` before
trusting the coverage table above, and this is a good change.

---

## 9. Fixes

Applied by the CI engineer against this audit. Ownership was unchanged:
`.github/**`, the Makefile's new targets and `help`, `playwright.config.ts`,
the `scripts` block of `apps/web/package.json`, RUNBOOK section 7,
CONTRIBUTING, and `scripts/ci-*.sh`. No guard was weakened and no assertion was
deleted. Line numbers are post-fix.

### Blockers

**B1, nested-job permission escalation.** Dropped the `permissions:` block from
the reusable workflow so it inherits the caller's token, and moved
`contents: write` onto release.yml's `desktop` job instead. Nightly now calls it
under `contents: read`, which is all a build-and-discard run needs.
`desktop-build.yml:32-44` carries the reason in place of the block;
`release.yml:53-62` is the caller that grants write.
*Verified:* both files re-parsed with PyYAML. `desktop-build.yml` has no
top-level `permissions` key at all, `release.yml`'s `desktop` job declares
`permissions.contents: write`, and `nightly.yml`'s caller declares none. A
callee that requests nothing cannot request more than it is allowed.

**B2, no pipefail on the required path.** Added `defaults.run.shell: bash` to
both workflows, which is what supplies `--noprofile --norc -eo pipefail`, with a
reasoning block naming the affected steps.
`ci.yml:54-77`, `nightly.yml:44-53`.
*Verified:* the audit's proof re-run on this host rather than taken on trust.
`bash -e -c 'false 2>&1 | tee /dev/null'` exits **0**;
`bash --noprofile --norc -eo pipefail -c 'false 2>&1 | tee /dev/null'` exits
**1**. Per step: `ci.yml:182-184` pipes `npm test` through `tee` and
`ci.yml:230-232` pipes `uv run pytest -q -rs` through `tee`; those two are the
only pipelines whose left-hand side can fail, so they are the only two steps
whose status changes. Every other `run:` in both files is either a single
command (whose status is already the step's) or a script that aggregates its own
`rc` and ends in `exit $rc`, so `-eo pipefail` is a no-op for them. `nightly.yml`
has no piped step today; the setting is there so the next one added is not
silently unfailable.

**B3, RUNBOOK told the reader the opposite of the truth.** Section 7 now lists
the three tagged tests by name, states outright that the happy path is the one
test deliberately excluded, and adds the two things only it asserts: the r3f
preview at Chicago scale, and 01/A3's no-page-reload on a PrintParams change.
The export paragraph moves bambu-3mf and color-change-3mf out of the validated
list into the structure-only list, with the measured reason. Every hard-coded
suite size was replaced or refreshed.
`RUNBOOK.md:175-215`, `RUNBOOK.md:224-238`, `CONTRIBUTING.md:87-112`, and
sections 2, 3, 6, 8 and 9 of `v3-14-ci.md`.
*Verified:* `npx playwright test --project=chromium --list` reports **60 tests
in 11 files** and `--project=chromium-smoke --list` reports **3 tests in 1
file**. Both numbers now appear in RUNBOOK, CONTRIBUTING,
`playwright.config.ts:121-129` and the handoff note. A grep for the old claims
(`all 50`, `50 tests`, `48 acceptance`, `47 tests`, `2 of the 50`) over the
owned files returns nothing.

### Majors

**M1, nightly does not gate the tag release.** Fixed the claim, not the
behaviour. `nightly.yml:5-16` now says the tag trigger is ADVISORY, that both
workflows fire on the same tag push and start within seconds of each other, and
that release.yml publishes whether nightly is green, red or still running.
Making it mechanical means lifting the heavy jobs into a reusable workflow that
`create-release` depends on, which is named as the larger change it is.
*Verified:* read against `nightly.yml:33-34` and `release.yml:20-22`, both
`push: tags: ["v*"]`, with no dependency between the two workflows.

**M2, the warm-miss assertion could redden unrelated pull requests.** The
failure now fires only on a push to the default branch. Everywhere else the same
row is printed and a `::warning::` annotation is raised, so nothing is hidden.
`action.yml:88-118`, with a comment naming the three false-positive sources the
audit found: a swallowed restore error during a cache-service outage, an
internal-version mismatch if a `path:` ever diverges between workflows, and an
eviction landing between the restore step and the report step.
*Verified:* re-parsed. The `prior = unknown` and `prior = 0` branches are
untouched, so a cold miss and an unreachable API still behave exactly as before.
The enforcing branch is reached only when `GITHUB_EVENT_NAME` is `push` and
`GITHUB_REF` equals the default-branch ref; both are read as `${VAR:-}` so
`set -u` cannot abort the step. This makes the check accurate rather than
lenient: it still fails, on the branch where a red run reaches a maintainer, for
the condition it was written to catch.

**M3, the next cache key evicted the caches the budget depends on.** The key
drops the source hash and becomes lock hash plus `github.ref_name`;
`restore-keys` is unchanged and still supplies cross-branch warmth.
`ci.yml:246-278`.
*Verified:* by the eviction argument the audit makes. A per-branch key is
written once per branch instead of once per commit, so the entries it used to
push out of the 10 GB budget (npm, uv, and the Playwright bundle the baseline
measures at 3m 46s to re-download) survive. `enforce: "false"` is kept, now
justified by "a first build on a new branch is a legitimate miss" rather than by
per-commit churn.

**M4, the nightly full suite had no stray-fixture guard.** Copied verbatim into
`e2e-full`, with `if: always()`. `nightly.yml:180-195`.
*Verified:* diffed against `ci.yml:517-531`. Same
`git status --porcelain -- fixtures/`, same `[0-9a-f]{40}\.json$` pattern, same
`::error::` and `exit 1`. Nightly now matches both `make gate` step 8 and the
fast path, which matters more here: the 57 untagged tests are the likelier place
for a forgotten route mock.

**M5, gate-fast passed where gate failed.** Added the missing `else ... rc=1`
arm so `make gate-fast` fails on a host without git, exactly as `make gate`
does at `Makefile:287-288`. `Makefile:394-396`.
*Verified:* recipe body extracted, `$(MAKE)` and `$$` substituted, `sh -n`
clean.

### Minors fixed

| # | Fix | Where |
|---|---|---|
| 1 | Comment corrected from "at least 2" to "at least 3", matching the `ran<3` assertion. | `Makefile:323-326` |
| 2 | Every stale suite size refreshed to the measured 60 in 11 files, and the derived counts (57 untagged) with them. | `ci.yml:10-29`, `ci.yml:346-351`, `playwright.config.ts:121-129`, `Makefile:19`, `Makefile:418`, plus the three docs |
| 3 | RUNBOOK no longer understates the fast path: two export targets are exercised, generic-3mf through `export:cli` and bambu-3mf through the `@smoke` UI test. | `RUNBOOK.md:203-206` |
| 4 | `node -p` guarded with `2>/dev/null || true`, and the emptiness test widened to catch the string `undefined`, so the friendly diagnostic is reachable under `-e`. | `ci.yml:427-434`, `nightly.yml:110-117` |
| 5 | Each tile's sidecar is asserted before the tile is judged, since `make validate` reads the file against that sidecar. | `ci-export-matrix.sh:191-197` |
| 6 | The tiled build gets its own stem, `generic-3mf-tiled`, so it can no longer overwrite the plain build's sidecar. | `ci-export-matrix.sh:176-201` |
| 7 | The preset reader's exit status is captured and tested, so a preset with no committed fixture fails the job instead of passing when six others are present. | `ci-preset-matrix.sh:55-64` |
| 9 | The `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` notarization trio is gated on `inputs.tag_name != ''`, so a nightly build-and-discard run no longer notarizes with Apple every night. | `desktop-build.yml:96-130` |
| 10 | Secrets reach the step through `env:` instead of `${{ }}` interpolation into the script body, and are written to `$GITHUB_ENV` with the heredoc delimiter form, so a newline or a single quote in a secret is handled. | `desktop-build.yml:96-130` |

**Also taken from section 4:** all five required jobs dropped to
`timeout-minutes: 10` (`ci.yml:92`, `:155`, `:203`, `:255`, `:353`). The
ten-minute budget is now an assertion rather than a claim, and a hung job can no
longer hold the required path for fifteen minutes while still being called
"under budget".

### Not fixed, with reasons

**Minor 8, two parallel npm caches.** Hand-rolling the key in `release.yml`'s
`web-zip` and `desktop-build.yml` would be wrong, not merely more work: `~/.npm`
is not npm's cache directory on Windows or macOS, and `desktop-build.yml` runs
on all three. `setup-node`'s built-in cache resolves the path per OS, which is
exactly why those two jobs use it. The cost is one extra entry per lock file,
which the M3 fix more than repays. Recorded in `v3-14-ci.md` section 7.

**Minor 11, cache rows missing after an earlier failure.** The audit's own
parenthetical settles it: the action writes its row before exiting 1
(`action.yml:105` precedes `:120`), so a failing row is always visible. A
missing row belongs to a cache whose report step never ran because an earlier
step failed, and that failed step already explains itself. Adding `if: always()`
to the report steps would run cache reports after a failed build for no signal.

**Minor 12, no `DECISIONS.md` line.** `DECISIONS.md` is outside this wave's
ownership and is append-only, with the orchestrator committing per phase. The
decision that the required merge gate is now deliberately partial is stated in
`v3-14-ci.md` and in RUNBOOK section 7. **Action for the orchestrator:** add the
line.

**Section 3's recommended fourth `@smoke` test.** Writing a new test means
writing new assertions, which this wave's brief explicitly excludes: tags may be
added to test titles, but no assertion may change. The recommendation is sound
and the headroom is real, roughly four minutes of the ten-minute budget unspent.
**Action for the orchestrator:** commission a small test asserting the cheap
half of the happy path (the preset applies, the canvas paints a non-empty frame,
one slider change causes zero navigations) on the synthetic scene the tagged
tests already use, and tag it `@smoke`.

**Notes 1, 2 and 3.** Accepted as written. `grep -a` is a GNU extension and is
fine on the two hosts these scripts run on, `ubuntu-latest` and Git Bash. The
`created_at` versus `run_started_at` one-second window is now recorded in
`v3-14-ci.md` section 7 as limit 4. `dtolnay/rust-toolchain@stable` is
pre-existing and was moved verbatim; pinning it is a supply-chain decision
beyond this task.

### Re-verification after every fix

- Every workflow and the composite action re-parsed with PyYAML through
  `uv run --with pyyaml` in `services/bake`: `ci.yml`, `nightly.yml`,
  `desktop-build.yml`, `release.yml`, `pages.yml`, `cache-report/action.yml`.
- `sh -n` on `scripts/ci-export-matrix.sh` and `scripts/ci-preset-matrix.sh`.
- `make help` runs, so the Makefile parses; both new recipes extracted,
  `$(MAKE)` and `$$` substituted, and passed through `sh -n`.
- `npx playwright test --list` on both projects, for the counts quoted above.
- `scripts/ci-export-matrix.sh` re-run end to end after the stem and sidecar
  changes.
- The two blockers' proofs re-run rather than quoted: the pipefail exit codes,
  and the absence of a `permissions:` key in the callee.
