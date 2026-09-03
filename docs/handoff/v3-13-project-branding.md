# v3.1 tasks 13 and 15: the `.framecraft` project file, and branding

Date: 2026-09-03. Agent: w6-dist.

## Task 13: the project file format

### The container is plain JSON, not gzipped JSON

Measured before deciding. A MAXIMAL project -- every optional block set, every
list at the contract's `maxItems` (8 engravings at 64 characters, 12 hero ids,
24 object overrides, 12 surface labels), every bounded number at its maximum,
a custom printer profile with 400 characters of change G-code, a sixteen-slot
gradient, the full frame style, and a non-default layout:

| project | JSON | gzip -9 | ratio |
|---|---|---|---|
| defaults only | 4 444 B | 1 371 B | 0.31 |
| maximal | 19 907 B | 2 076 B | 0.10 |

Compression would save 17.8 kB on the worst file the contract can express.
That is not worth making the file unreadable in a text editor, unsearchable by
`grep`, undiffable in git and unopenable by anything that does not know
FrameCraft -- all properties `lib/project.ts` already claimed for the format.
A hypothetical measured alongside it, an override AND a label for all 992
Chicago Loop buildings (which the item caps do not currently allow), is 369 kB,
still nothing for a local file. `lib/project.test.ts` pins a 64 kB bound as a
change detector: the conversation reopens if a maximal project ever approaches
a megabyte.

### What changed

- Extension is `.framecraft` (`PROJECT_FILE_EXTENSION`). `.framecraft.json`
  still loads (`LEGACY_PROJECT_FILE_EXTENSION`) and is never written again.
- Envelope version 4. Version 3 (what FrameCraft 3.0 wrote) still reads;
  `READABLE_PROJECT_VERSIONS` is the set. The only structural difference is the
  new `app_version` field, so migration fills that in and moves no data.
- Three version-ish fields, three different questions: `version` is the FILE
  format's revision, `params.schema_version` is the contract revision the
  settings were written against, `app_version` is the FrameCraft build that
  wrote the file.
- `parseProject(text, filename?)` now returns `migrated: string | null` on the
  ok branch. `filename` only ever affects that sentence; the BYTES decide
  whether a file loads. The sentence is built by the exported, tested
  `migrationNotice`.
- It reaches the user through two surfaces, because the two ways a project can
  be opened have nothing in common. The **Load button** puts it in the action
  bar's own `project-migrated` slot, beside the existing `project-error`, in
  the informational tone rather than the warning one: nothing failed, the
  design is on screen. The decision is a new exported pure function,
  `ActionBar.projectLoadNotices`, sitting beside `statusLine` and
  `failureNotice` and following that file's own pattern, so the rule is
  testable without a DOM. The **desktop open-with path** has no action bar in
  reach (it is mounted from the root layout), so it uses the editor's existing
  dismissible notice banner, `setShareNotice` -> `WarningBanners`. That
  banner's dismiss control was relabelled from "Dismiss the shared link
  message" to "Dismiss this message", since it now carries more than one kind.
- Unknown top-level blocks are carried through (`ProjectExtras`, on the ok
  branch as `extras`, back into `buildProject` as its fifth argument). The
  envelope is deliberately LAX where the settings block is strict: an unknown
  SETTING would silently not apply, so it is a refusal; an unknown BLOCK is a
  newer FrameCraft's work, and dropping it would destroy it on the next save.
  A key that collides with a modelled field is ignored, never allowed to
  overwrite it.

### Object overrides, labels and hero selections

All three turned out to be PRINT PARAMETERS. `object_overrides` and `labels`
landed inside `PrintParams` while this task was in flight (Tasks 11 and 12);
hero selection has always been `hero_building_ids` / `hero_mode` / `hero_auto`.
The project file therefore captures every one of them through `params`, which
it writes whole rather than as a diff, and this module needed no field for any
of them. The `extras` channel above is what is left of the brief's "leave the
reader tolerant and the writer forward compatible": it is for a block a future
build adds beside `params` and `layout`. Layout stays where `[V3.1-O6]` put it.

### The desktop file association

`apps/desktop/src-tauri/tauri.conf.json`, `bundle.fileAssociations`, one entry
covering all three platforms because each reads a different subset:

| platform | what it reads | field |
|---|---|---|
| Windows | shell association + Explorer's Type column | `ext`, `description` |
| macOS | `CFBundleDocumentTypes` + `UTExportedTypeDeclarations` | `name`, `role: Editor`, `rank: Owner`, `exportedType.identifier`, `conformsTo: [public.json]` |
| Linux | `MimeType=` in the generated `.desktop` entry | `mimeType` |

Only `.framecraft` is registered. `.framecraft.json` deliberately is NOT: only
the last extension of a double extension reaches an OS association, so
registering it would mean claiming `.json` outright, which is antisocial.
Legacy files open through the app's own Load button, whose picker offers
`.framecraft`, `.framecraft.json` and `.json` (`PROJECT_FILE_ACCEPT`).

### The open path, end to end

`apps/desktop/src-tauri/src/lib.rs`:

- `project_path_from_args` skips argv[0] and anything flag-shaped, and accepts
  only a name ending in one of the two extensions, so no stray argument can
  make the app open something arbitrary. Pure, and unit-tested in Rust.
- `read_project` refuses a file over 32 MB before allocating it (three orders
  of magnitude above a maximal project) and returns `{filename, text, path}`.
  The bytes are read in Rust so the WebView never needs filesystem permission
  on an arbitrary path.
- Launch (Windows, Linux): the path arrives as a process argument in `setup`,
  and is PARKED because the WebView does not exist yet.
- Second launch: `tauri-plugin-single-instance` (new dependency) hands the new
  process's argv to the running one, which delivers the file and focuses the
  window instead of starting a second copy.
- macOS: `RunEvent::Opened` in the run loop, cfg-gated to macOS/iOS, covers
  both launch and later double-clicks.
- Delivery picks its channel from whether the page has ever asked: park before
  the first `take_pending_project`, emit `framecraft://open-project` after.
  Taking clears the slot, so a WebView reload does not reopen a stale file.

Web side: `lib/platform.ts` gains `takePendingProjectFile`,
`onProjectFileOpened` and the `asOpenedProjectFile` shape check (no `any` at
the IPC boundary); `components/editor/DesktopProjectOpener.tsx` (renders
nothing, mounted from the root layout) validates through the SAME
`parseProject` the Load button uses and reports through the same notice.

Note on the Cargo dependency: it is declared under
`[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]`,
NOT `cfg(desktop)`. `desktop` is a cfg Tauri sets from its build script, which
Cargo's own target tables cannot see, so a `cfg(desktop)` dependency is
silently never resolved and the crate does not compile.

## Task 15: branding, version and copyright

### One source of truth

`apps/web/package.json`'s `version` (now **3.1.0**) is it. Nothing else is
hand-maintained.

```
apps/web/package.json  version
        |
        v
apps/web/scripts/version.mjs        version + commit + build date, resolved once
        |                    \
        v                     v
next.config.ts (env: ...)     scripts/stamp-version.mjs --write
        |                             |
        v                             v
lib/version.ts                 apps/desktop/package.json
   (NEXT_PUBLIC_APP_VERSION,   apps/desktop/src-tauri/tauri.conf.json
    _COMMIT_SHA, _BUILD_DATE)  apps/desktop/src-tauri/Cargo.toml
        |
        +--> SiteFooter (web)  --> AboutDialog (both, and the desktop About)
```

The desktop shell renders the same bundle, so its About dialog reads the same
inlined constants the web footer does. Its three manifests are stamped rather
than edited: Tauri reads `tauri.conf.json` BEFORE running
`beforeBuildCommand`, so a script that rewrote it during the build would be
one build too late. The stamped values are committed and drift is a test
failure (`lib/version.test.ts`), not a surprise in an installer. Fix drift
with `npm run version:stamp` in `apps/web`; check it with `npm run
version:check`.

### Commit and date resolution, and the no-git fallback

Commit, in order: `FRAMECRAFT_COMMIT_SHA`, then `NEXT_PUBLIC_COMMIT_SHA`, then
`GITHUB_SHA` (every runner sets it), then `git rev-parse --short=12 HEAD`,
then **nothing**. "Nothing" is the empty string, never an invented sha, and
every display path renders it as the words **"source build"**. That is the
stated tarball fallback: git missing from PATH, a checkout that is not a
repository, a repository with no commits, and a git that exits non-zero all
collapse to it, and none of them may fail a build.

Date: `FRAMECRAFT_BUILD_DATE`, then `NEXT_PUBLIC_BUILD_DATE`, then
`SOURCE_DATE_EPOCH` (the cross-ecosystem reproducible-build convention, in
seconds), then the clock. Shown as a calendar day; the full instant is in the
file for anyone who wants it.

`.github/workflows/release.yml` needed no change: `actions/checkout` leaves a
usable `.git`, and `GITHUB_SHA` is set regardless.

### Exports stamp the real version

`lib/engine/export/common.ts` typed the version as the literal
`APPLICATION = "FrameCraft 3.0.0"`, and `stl.ts` repeated it in its 80-byte
binary header. That is how the previous release shipped installers saying
3.1.0 while every model they exported said 3.0.0, which is worse than no
version at all: a file that names a release it did not come from sends a bug
report to the wrong commit. Both now derive from `appVersion()`.

`GENERATOR_VERSION` was declared and never read by anything; it derives too
rather than being deleted, since the 3MF provenance vocabulary names it.

**`lib/version.ts` resolves lazily** for exactly one reason. The browser and
the desktop shell get a bundler-substituted literal whether the read is inside
a function or not, but `scripts/export-cli.ts` runs the same exporters under
plain Node, where nothing substitutes anything, and it is the CLI that
produces the files CI hands to the Python validator. So the CLI sets the
variable itself, through `scripts/stamp-version-env.mjs` imported in FIRST
position: ES modules evaluate imports in order and to completion, so that file
has finished running before the engine is parsed. A module-level constant
would have been read before the assignment could happen. Verified by running
the real CLI on `fixtures/parity-scene.json`: the generic 3MF comes out with
`Application` and `framecraft:generator` both reading `FrameCraft 3.1.0`.

Under **vitest** neither path applies and the version resolves to
`UNBUILT_VERSION` permanently. That is deliberate, and it is what keeps the
byte-pinned export golden in `lib/engine/export/tiles.test.ts` stable across
release bumps instead of turning every version bump into a golden re-pin.

**Six tests asserted the literal, not four**: the four named in the brief plus
two in `lib/engine/solid/attribution.test.ts` (the provenance list every
exporter must carry, and the sidecar's provenance block). All six now assert
against `APPLICATION` PLUS a separate shape assertion,
`/^FrameCraft \d+\.\d+\.\d+/`. That pair is stronger than the literal it
replaced: the shape check fails if the version stops resolving or stops being
a version, so the value assertion cannot degenerate into the writer agreeing
with itself. The shape deliberately accepts a semver prerelease, because a
release candidate really does stamp one.

**The tiles golden was re-pinned to `bca6c6aa...`, with the two causes
separated rather than assumed.** Re-running that test with
`NEXT_PUBLIC_APP_VERSION=3.0.0` reproduces `7b82383f...` exactly, which is what
the tree produced before this change, proving Tasks 11 and 12 own that move
(`object_overrides` and `labels` joined `PrintParams`, and every 3MF carries
`PrintParams` in its `Description`) and that this task moved exactly one
metadata value, `framecraft:generator`. All three hashes and the method are in
the test's comment.

### The copyright holder is NAXHQ

Changed, consistently, in: `LICENSE` (`Copyright (c) 2026 Vahid Alizadeh` ->
`Copyright (c) 2026 NAXHQ`), `README.md` (the licence paragraph and the
closing credit line), `lib/version.ts` (`COPYRIGHT_HOLDER`, which the footer
and the About dialog render), `apps/web/package.json` (`author`, plus
`license`, `homepage`, `repository`), `apps/desktop/src-tauri/Cargo.toml`
(`authors`, plus `license` and `repository`) and
`apps/desktop/src-tauri/tauri.conf.json` (`bundle.publisher`,
`bundle.copyright`, and `licenseFile` pointing at the repository LICENSE).

**The licence terms are untouched.** Still MIT, same text, only the holder
string. `DECISIONS.md` `[V3-P8-C]` quotes the old holder in its rationale for
the MIT/ODbL split; that rationale is unchanged and only the name in it is now
stale. The orchestrator owns `DECISIONS.md`: this needs a `[V3.1-T15]` line
recording the holder change.

Every OSM obligation is intact: the footer credit is word for word what it
was, the About dialog repeats it, and the engraved marks, the 3MF metadata and
`CREDITS.txt` were not touched at all.

### The footer and the About dialog

`components/editor/SiteFooter.tsx` replaces the inline `<footer>` that was in
`app/layout.tsx`; it stays in the layout because the attribution is a licence
condition that has to survive every route. It shows the build stamp
(`FrameCraft 3.1.0 - <sha> - 2026-09-03`), `(c) 2026 NAXHQ`, the unchanged
Photon/Nominatim/OpenStreetMap credit, and links to the repository and the
licence. The build stamp is a button that opens `AboutDialog`.

There is ONE About dialog, not a native second one for the desktop. The
desktop shell renders this same bundle, so a native window would mean
maintaining two answers to one question and letting them drift; the dialog
adds what a one-line footer cannot hold (the full build date, the licence in
words, and which runtime is showing it, resolved after mount so the
prerendered HTML and the first client render agree). Modal mechanics mirror
`ShortcutSheet`.

## Verification

Run on this Windows 11 host.

| check | result |
|---|---|
| `npx vitest run lib/version.test.ts` | 22/22 pass |
| `npx vitest run components/editor/SiteFooter.test.tsx` | 11/11 pass |
| `npx vitest run lib/engine/export/` | 98/98 pass |
| `npx vitest run lib/engine/solid/attribution.test.ts` | 30/30 pass |
| `cargo check --all-targets` (scratchpad `CARGO_TARGET_DIR`) | clean |
| `cargo test --lib` | 4/4 pass |
| `npx tsc --noEmit` | clean, tree-wide |
| `npx eslint . --max-warnings 0` | clean, tree-wide |
| `next.config.ts` loaded through Next's own config loader | inlines all four constants: `NEXT_PUBLIC_BUILD_ID`, `_APP_VERSION` 3.1.0, `_COMMIT_SHA`, `_BUILD_DATE` |
| `export:cli` on `fixtures/parity-scene.json` | the generic 3MF's `Application` and `framecraft:generator` both read `FrameCraft 3.1.0` |
| `npx vitest run lib/project.test.ts` | **14 of 39 fail, blocked, see below** |
| `npx vitest run components/editor/ActionBar.test.tsx` | **3 of 57 fail, same block** |

### The blocked test, and why it is not this task's

`apps/web/lib/contracts.ts` now has `object_overrides` and `labels` on
`PrintParams`, but `apps/web/lib/share.ts`'s `PRINT_PARAM_SPEC` has no entry
for either. So `parsePrintParams` refuses the contract's OWN
`defaultPrintParams()` with "names a setting this version does not have
(object_overrides)". One cause, and it fails 4 tests in `lib/share.test.ts`
(including the one asserting the spec covers every default key), 14 in
`lib/project.test.ts` and 2 in `lib/layout.test.ts`; at runtime it breaks every
share-link restore and every project-file load, not just this task's.
`lib/share.ts` was left untouched to avoid colliding with the agent finishing
Task 11. Re-run `npx vitest run lib/project.test.ts lib/share.test.ts
lib/layout.test.ts` once those spec entries land.

As of the last full run the suite reads **2221 passed, 38 failed**, across a
tree several agents are still landing in. The 23 named above are the share.ts
gap; the rest are other agents' in-flight work (`advisor.test.ts` and
`warnings.test.ts` dep tables not yet naming the new contract leaves,
`controlCatalog.test.ts`, `design-tokens.test.ts` on a raw hex colour in
`ObjectInspector.tsx`, `CityPreview`, `RegionMeshes`, `normalize`,
`store/editor` and the pipeline matrix). Every suite this task owns passes:
161 of 161 across `lib/version.test.ts`, `components/editor/SiteFooter.test.tsx`,
all ten `lib/engine/export/` files and `lib/engine/solid/attribution.test.ts`.

`next build` and Playwright were not run: `artifacts/build.lock` was held by
w3-close2 for the whole of this task.

## Known gaps

1. **`LICENSE_AND_ATTRIBUTION.md` line 77 quotes `generator FrameCraft 3.0.0`**
   as an example of an export's provenance block. The exports themselves are
   fixed (see "Exports stamp the real version" above); that one documentation
   line still names the old release and belongs to the docs refresh.
2. **Nothing checks that a `v*` tag matches the stamped version.** The three
   desktop manifests cannot drift from each other or from the web package, but
   tagging `v3.2.0` against a 3.1.0 tree would still build installers named
   3.1.0. A one-line guard in `release.yml` would close it.
3. **macOS and Linux associations are config-verified, not runtime-verified.**
   The `fileAssociations` block is asserted field by field against what each
   platform's bundler reads, and the Windows/Linux argv path and the macOS
   `RunEvent::Opened` path are both implemented, but there is no macOS or
   Linux hardware here to double-click on. Same limitation `v3-08-dist.md`
   recorded for the dmg and AppImage builds.
4. **`e2e/workflow.spec.ts` was edited** (one assertion and one temp filename)
   because it asserted the old extension. It now asserts the saved file ends
   in `.framecraft`, which is strictly more specific than the `toContain` it
   replaced. That file was outside this task's stated ownership.
5. **`docs/ARCHITECTURE.md` line 250 still says `.framecraft.json`.** Left for
   whoever owns the docs refresh (Task 16) rather than edited from here.
6. **The tiles golden may need one more re-pin.** It was re-pinned against a
   tree where Tasks 11 and 12 are still landing. If the contract moves again,
   every 3MF's `Description` moves with it and this number goes stale; the
   test comment names the method for separating a legitimate cause from a
   writer regression.
7. **`lib/contrast.test.ts` was NOT touched.** The lead's note assigned it on
   the belief that this task had edited it; it had not, and a third writer was
   active in that file set. For whoever does take it: `AboutDialog.tsx` draws
   control edges (`border-line` on the panel, `border-control` on the close
   button and the two links) and wants rows; `SiteFooter.tsx` draws no control
   edge at all, only the pre-existing `fc-scored` top hairline and text
   underlines, so it wants the reasoned no-edge assertion rather than a
   vacuous row.
