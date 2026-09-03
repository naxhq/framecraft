# v3-13 dist audit (adversarial audit of Tasks 13 and 15)

Auditor: the agent that wrote Task 16, not the agent that wrote 13 or 15. Every
claim below is either an execution result on this tree or a stated limit on
what could be executed here.

Verdict: **the work is sound in substance**. The round trip survives everything
it was attacked with, the version stamp is genuinely single-sourced, and the
attribution obligation is met in the exported bytes on both surfaces. Two
findings, one of them a process gap rather than a defect.

## What was done about the findings

All three were fixed on the orchestrator's ruling, in this audit's own second
pass. The findings below are left as written, in the present tense of the
audit, because a finding rewritten after its fix stops explaining why the fix
exists.

| finding | fix | evidence |
| --- | --- | --- |
| 2, the four credit literals | `export/common.ts:ATTRIBUTION` and `solid/attribution.ts:OSM_CREDIT` now import `lib/version.ts:OSM_CREDIT`; `OSM_CREDIT_ASCII` is derived from it by substituting the sign; both `MODEL_DATA_LICENCE` constants are built from it. The map overlay cannot import it, so `version.test.ts` reads `LocationPicker.tsx` and pins its literal. `version.ts`'s docstring, which claimed the exporters used its copy when they did not, now says what is true. | 3 new tests in `version.test.ts` (25 passed). Each was mutation-tested: diverging the engraved credit reddens two of them, and pointing the overlay assertion at a wrong string reddens the third with the real extracted value. A fresh export still carries the credit in `Copyright`, `framecraft:attribution` and the ODbL line, and all three marks still read `cuts`. |
| 1, `cargo test` runs nowhere | A `Rust unit tests (open-with contract)` step in `desktop-build.yml`, before the bundle, on all three platforms. That workflow already installs the toolchain and the Linux system dependencies, the compile it does is the one `tauri build` then reuses, and a release cannot ship over a red test. Not the required path: the cold compile is minutes. | `cargo test --lib` green locally, 7 passed. Smart App Control blocks executing a freshly built binary inside the repo, which is what os error 4551 was; `CARGO_TARGET_DIR` pointed outside the tree runs it. The workflow YAML parses and the step is in the right place. |
| the reach audit's `[V3.1-P5-4]`, the settings search skipping the `output` group | The group-level exclusion in `lib/settingsSearch.ts` is gone. Every group is searched; what is excluded is the rows in the `output` bucket that are not settings, by the rule "writes a `PrintParams` leaf" rather than by a hand-kept list, so a future control that lands there and moves the model is searchable the day it is catalogued. Typing "format" now finds Export format. The two tests that encoded the old premise were re-pointed, not relaxed: one now forbids a hit that goes nowhere (the search's own box, a group header, Reset all, a transient inspector or label row, a `*` row with no section to open) over a wider set of queries than before, and the count test restates the new rule from the catalogue rather than from the implementation. | `settingsSearch.test.ts` 14 passed, up from 13, including a new test that "format", "export format" and "3mf" each return `export_target`. The panel can act on the hit: `focusControl` queries the whole document and the select is always rendered in the action bar. |
| the reach audit's `[V3.1-P15-5]`, nothing reading the version on a real page | New `e2e/about.spec.ts`: on a served page, the footer stamp is `package.json`'s version and not the `0.0.0-unbuilt` placeholder, the About dialog opens and its Version row says the same thing, the commit is a real short sha or the documented no-git label and never empty, and the copyright holder and the OSM credit are both on the dialog. It builds no model, so it is cheap. | 1 passed in 1.1 s against a served page. Mutation-probed: asserting a wrong version fails with `Received: "3.1.0"`, so the assertion reads the live DOM rather than passing on an empty locator. Not tagged `@smoke`: what the required path's Playwright subset carries is a CI budget decision that belongs to whoever owns that tag. |
| 3, the `-notes.framecraft` argv filter | `project_path_from_args` no longer disqualifies an argument for a leading dash. The extension is the discriminator, `--` ends the switches, and a `--name=value` switch is skipped whole so its value cannot be read as the path. | 3 new Rust tests: a hyphen-leading name opens (with and without `--`), `--open=/tmp/loop.framecraft` does not and the real path later in the list still does, and paths with spaces and non-ASCII open. The pre-existing flag test was not touched and still passes. |

---

## Finding 1 (worst): the Rust half of Task 13 is tested by nothing that runs

`apps/desktop/src-tauri/src/lib.rs` carries four unit tests, and they are the
only automated coverage of the whole open-with contract:
`recognises_both_project_extensions`, `finds_the_project_argument_and_never_the_executable`,
`ignores_flags_and_unrelated_arguments`, `reads_a_project_file_with_its_name_and_refuses_a_missing_one`.

`cargo` appears nowhere in `Makefile`, `scripts/*.sh` or `.github/workflows/*.yml`
(the only match in the tree is `Cargo.lock`). `make gate`, `make gate-fast` and
`make gate-nightly` never invoke it; `desktop-build.yml` builds installers, and
`cargo build` does not compile `#[cfg(test)]` code. So those four tests have
never been executed by any gate or CI job in this repository.

Nor could this audit execute them. On this host:

```
$ cd apps/desktop/src-tauri && cargo test --lib
error: failed to run custom build command for `crc32fast v1.5.1`
  An Application Control policy has blocked this file. (os error 4551)
```

That is a Windows Application Control policy refusing to execute a freshly
built build script, an environment limit rather than a defect in the crate. The
consequence for this audit is worth stating plainly: **the Rust half has no
execution evidence at all, here or in CI.** What follows about it is a code
read.

What the read says, and it is simple enough to be read with confidence:
`project_path_from_args` skips argv[0], skips anything starting with `-`, and
takes the first remaining argument whose name ends (ASCII-case-insensitively)
in `.framecraft` or `.framecraft.json`. It never splits or joins an argument,
so a path containing spaces arrives as the single argv entry the OS produced
and is unaffected; `to_ascii_lowercase` leaves non-ASCII bytes alone and the
suffix compare is over UTF-8, so a non-ASCII path with an ASCII extension
matches. The `single_instance` plugin is registered first, and its callback
delivers the project and then calls `focus_main_window` (unminimize, show,
set_focus) on the `main` window, which is what "route a second launch to the
running window" requires. `deliver_project` emits `framecraft://open-project`
when the page has already drained the slot once, and parks it otherwise, so a
launch-time file and a later double-click both arrive.

Suggested closure (not applied, it is outside a one-line certainty): add
`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` to
`desktop-build.yml`, or to `gate-nightly` on the one runner that has a Rust
toolchain. Until then the four tests are documentation.

Minor, same area: a project file whose name begins with a hyphen
(`-notes.framecraft`) is skipped by the flag filter and cannot be opened by
double-click. The comment states the trade deliberately; recorded so it is not
rediscovered as a bug.

## Finding 2: the OSM credit is four independent literals, and a docstring says otherwise

`lib/version.ts:OSM_CREDIT` documents itself as "the OSM credit ... the same
string the exporters engrave and write into file metadata". The exporters do
not import it. The string is declared, separately, in:

| file | what it feeds |
| --- | --- |
| `lib/version.ts` | the About dialog |
| `lib/engine/solid/attribution.ts` | the ENGRAVED marks (with an ASCII fallback for faces with no `©` glyph) |
| `lib/engine/export/common.ts` (`ATTRIBUTION`) | the 3MF metadata and the sidecar |
| `components/map/LocationPicker.tsx` | the map overlay credit |

All four are byte-identical today, and `lib/version.test.ts:188` pins one of
them to the literal. Nothing pins them to each other, so an edit to one would
diverge silently, and this is a licence obligation rather than a caption. Not
fixed here: making the engine import from `lib/version.ts` touches
`lib/engine/**`, which this audit was told not to edit, and it is a real change
rather than a one-line certainty. The cheap alternative is one assertion in
`version.test.ts` that the four constants are equal.

---

## What was attacked, and what held

### 1. The `.framecraft` round trip: 29 of 29 checks pass

Harness: `apps/web/scripts/_audit-project.ts` (temporary, untracked, passes
`eslint` and `tsc --noEmit`; delete it when this audit is read). Run with
`npx vite-node -c vitest.config.ts scripts/_audit-project.ts` from `apps/web`.
It builds a maximal project (a non-ASCII place name, three overrides across all
three layers with every optional member set, two labels with anchors and
`follow`, two engravings, three hero ids, a moved palette and two region
colours and a region slot, an ogee mitred frame with a 1.2 mm lip, a moved
plate and base), serialises it, parses it back and deep-diffs every leaf.

Held: every `params` leaf survives (a full recursive diff, not a spot check);
the location survives; `labels` and `object_overrides` survive member for
member; `layout` survives exactly, sizes and collapsed side and maximized
region; the identity fields survive including `Sāo Paulo / 東京`; a top-level
block this build does not model is carried through rather than dropped;
`app_version` is reported; a save, load, save again is byte-identical.

Refused loudly, each with its own sentence naming what is wrong: truncated
JSON, non-JSON, a foreign `format` tag, envelope version 2, envelope version 5,
an out-of-range latitude, a non-numeric radius, an unknown SETTINGS key
("names a setting this version does not have (not_a_real_setting)"), 13 labels
against the cap of 12, 25 overrides against the cap of 24. Nothing half-loaded
in any of those cases.

Migrated rather than refused, and said so once: a version-3 envelope with no
`app_version`, under a `.framecraft.json` name, with every parameter intact and
`savedBy` empty. Filenames with spaces and non-ASCII (`São Paulo
design.framecraft`, `設計 2026.framecraft`, `C:/My Designs/東京.framecraft`) load
as current; `São Paulo design.framecraft.json` and `設計.FrameCraft.JSON` are
recognised as legacy. A corrupt `layout` block does not refuse the file: it
degrades to the default width and the clamped minimum, with no NaN.

### 2. The version stamp is single-sourced, and drift fails a test

At `apps/web/package.json` 3.1.0, `node scripts/stamp-version.mjs --check`
reports "all desktop manifests match" and exits 0. Bumping that one file to
`3.1.99-audit` makes the same check name all three desktop manifests
(`apps/desktop/package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`)
and exit 1. `lib/version.test.ts` runs that check, so the drift fails `npm test`
on the required CI path. `package.json` was restored from the index afterwards
and `git diff` on it is empty.

The web surfaces read the same source through `next.config.ts`, which inlines
`NEXT_PUBLIC_APP_VERSION` from `readPackageVersion()`; the footer rendered
"FrameCraft 3.1.0 · af02c98c1c05 · 2026-09-03" in a live capture from a real
dev build (`docs/assets/screenshot.png`). The exporters read the same variable
through `lib/engine/export/common.ts:GENERATOR_VERSION = appVersion()`: an
export run with `NEXT_PUBLIC_APP_VERSION=3.1.99-audit` wrote that string into
both `Application` and `framecraft:generator` in the file, and into the
sidecar. No surface was found hardcoding a version.

### 3. Attribution, from the bytes

`artifacts/audit-t13.3mf` (Chicago fixture, generic-3mf, browser engine).
`3D/3dmodel.model` carries `© OpenStreetMap contributors` (U+00A9 confirmed by
byte inspection, not by the terminal's rendering of it) in `Copyright`,
`Description`, `framecraft:attribution` and, with the ODbL line, in
`LicenseTerms` and `framecraft:license`. The sidecar carries it too.

The engraved marks are confirmed by the reference validator reading the mesh,
not by reading the source: `uv run python -m app.cli validate` returns
`attribution PASS  3 band(s), 3.15 mm (9.1 % of height)` and
`3mf_attribution PASS  present (2666 chars)`, with **ALL CHECKS PASS** on every
row. The sidecar's `resolved_text` names the three marks (base underside,
frame inner wall, base edge microtext), each `"status": "cuts"`.

---

## Limits of this audit

- No installer was built and no desktop binary was run, so the file
  association is verified as far as its Rust source and its manifest
  (`fileAssociations` `ext: ["framecraft"]`, `mimeType`, `role`/`rank`, the
  macOS `exportedType`) and no further. The double-click itself is unproven on
  every platform.
- `cargo test` could not run here at all (finding 1).
- The round trip was exercised through `parseProject` / `buildProject`
  directly. The Load button and the OS-open path both funnel into
  `parseProject`, which is what makes that the right seam, but the button was
  not clicked in this audit.
