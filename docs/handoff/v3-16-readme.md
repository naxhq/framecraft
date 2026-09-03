# v3-16 readme (Task 16: the README and its screenshots)

What the repository says about itself, brought level with what the app is at
3.1.0, plus a committed way to regenerate every picture in it.

Files: `README.md` (rewritten), `CHANGELOG.md` (3.1.0 section), `RUNBOOK.md`
(three edits), new `apps/web/scripts/capture-screenshots.mjs`, and the images
under `docs/assets/`.

## 1. The rule this task ran under

Every sentence in the README was checked against the code in this tree before
it was written, and three kinds of sentence were refused:

- **A feature with no user-visible surface.** Surface labels (Task 12) were
  held out of the README for most of this task: the engine half
  (`lib/engine/solid/labels.ts`, the `labels` stage) and the contract half
  (`print_params.labels`) existed, and nothing under `components/` or `store/`
  read or wrote `labels`. They went in only once the surface arrived, which it
  did mid-task: `store/editor.ts`'s label actions, `components/editor/
  LabelsPanel.tsx`, `components/scene/LabelGizmo.tsx`, and the "Label its roof"
  row in the right-click menu, which is visible in `screenshot-objects.png`.
  This is [V3.1-O8]'s rule applied to documentation: a claim that a feature
  reaches the user needs the user-visible surface to exist, and the way it was
  settled was a screenshot of the menu, not a grep.
- **A number nobody measured on this tree.** The old README's "larger memory
  budget" for the desktop build is gone; what `docs/handoff/v3-08-dist.md`
  actually proves is a native save dialog, and that is what it now says.
  "Per-slot volume, grams, metres, layers" became "grams and metres per slot, a
  total, and a print time range", because that is what `EstimateCard` renders.
- **Anything OPEN in `FAILURES.md` described as done.** All three open items
  are in the README's own Limitations section, in the CHANGELOG's Known issues
  block and in RUNBOOK section 9: the browser engine failing the validator on
  five of the six preset cities, the plate-256 residue, and the STEP writer's
  six-decimal grid.

Counts and enums in the feature list are read from
`packages/contracts/schema/print_params.json` rather than carried over: eight
named printer profiles plus custom, seven frame profiles, three corner styles,
seven export targets, eight built-in palettes (Default plus seven), 24 object
overrides of which four may claim a slot, 12 labels, 12 settings groups.

## 2. What the README now leads with

Vocabulary first ([V3.1-O3]): the page is organised around **Preview** and
**Export**, with a section that says what each one does, that Export writes a
model file and never G-code, and that "opens ready to slice" is a claim about
the Bambu Studio project 3MF and nothing else. The word "bake" does not appear.

Then the thing that is new about 3.1 and hardest to convey in a screenshot:
everything except the location rebuilds on its own, because the engine is a
stage graph in one worker and each stage knows which parameters it reads. The
README says a colour or a lettering change lands in a fraction of a second and
a plate or heights change takes seconds; the per-stage milliseconds are in
[V3.1-P1-14] and were deliberately not copied into a document that cannot be
re-measured when they move.

The v3.1 surfaces each get a paragraph: the resizable three-region shell, the
settings panel that states what each group is set to, the Photon type-ahead
with local coordinate parsing and recents, hover identity (exact for buildings,
nearest-entity for roads and areas, and the README says which is which), the
right-click override menu, `.framecraft` project files, and the desktop builds.
Footer: FrameCraft 3.1.0, (c) 2026 NAXHQ, and the unabridged attribution line
the app's own footer carries.

## 3. The capture script

`apps/web/scripts/capture-screenshots.mjs`, one line to run:

```sh
cd apps/web && node scripts/capture-screenshots.mjs
```

Five shots, named for what they show: `editor`, `settings`, `colour`, `search`,
`objects`, into `docs/assets/` (the directory the README already referenced).
`--only <name,...>`, `--out <dir>`, `--url <origin>` and `--headed` are the
flags.

It is a script and not a spec on purpose. The e2e suite is a gate: every file
under `e2e/` runs in `make gate`, is walked for skips, and asserts. A capture
run asserts nothing, costs a full Chicago build five times over, and would have
to be excluded from the very project it lived in. As a script it is also
runnable against a deployed origin (`--url https://naxhq.github.io/framecraft/`)
without a Playwright project existing for it.

What makes it repeatable:

- Overpass is routed to `tests/fixtures/overpass-chicago-loop.json`, and Photon
  and Nominatim to the committed fixtures under `apps/web/e2e/fixtures/`, so
  the city in the picture and the search results are the same on every host and
  none of it depends on somebody else's endpoint.
- A fresh context per run: empty `localStorage`, so the layout and the group
  expansion start at their defaults; 1440x900 at device scale 2; light scheme;
  reduced motion; and every CSS animation and transition duration zeroed
  before the shutter, so no shot lands mid-fade.
- The steps are the e2e suite's own (`[data-preset-id="chicago-loop"]`, then
  Preview, then `preview-canvas`, `preview-stats` and `stats-card`), not
  sleeps.
- **One context per shot.** The first version shared a browser context across
  the five, and shots two to five photographed a page that had never built:
  the layout, the expanded groups and the last location all persist per device,
  so the preset was already active on page two and clicking it changed nothing.
  A fresh context per shot is an empty `localStorage` and the same starting
  point every time.
- **The wait is on the built state, not on a canvas.** `preview-canvas` and the
  empty state are different elements and the empty state has its own
  (`preview-empty`), so the wait is "the empty state is gone AND the built
  strip is here". The first version waited on the canvas alone and was
  satisfied by a page that had lost its model.
- **Three attempts per shot, and every shot is re-checked after the shutter.**
  Against a dev server, any agent saving a file recompiles and reloads the page
  mid-run and the model goes with it, which can land between the wait and the
  screenshot. So each shot that needs a model asserts the model is still there
  afterwards and throws if it is not, and the shot goes round again. All three
  defects above were found by LOOKING at the captured images; the exit code was
  0 for four wrong pictures.
- Group headers are opened and closed through the DOM rather than by the mouse.
  The settings column scrolls inside a page taller than the viewport, and a
  real click waits for viewport stability a header deep in its own scroll
  container never reaches. Nothing here is testing that the header is
  clickable; `e2e/ui.spec.ts` does that.

What is not repeatable, stated in the script's header rather than glossed: the
OSM raster tiles behind the map region are fetched live from
tile.openstreetmap.org, because 03 forbids any other tile source and the repo
carries no tile cache, so the map region needs network; and the estimate card's
timing figures are whatever the host measured.

The settings column is matched as
`[data-testid="region-settings"], [data-testid="param-sheet"]` because that id
is mid-rename in the shell work; either tree captures.

## 4. CHANGELOG and RUNBOOK

`CHANGELOG.md`: the Unreleased block became `## [3.1.0] - 2026-09-03` and grew
the rest of the wave, each entry carrying its DECISIONS id. Added: the
incremental worker pipeline, live rebuilds at 80 ms, the resizable shell, the
settings panel, Photon search, object names and hover identity, per-object
overrides, per-building tint on the real meshes, the two-path CI, and this
capture script. Fixed: the rail width parameter, STL float32 hardening, the
float32 pinch separation that unblocked Paris, Tokyo and London, the two tiling
defects, and the skeleton rule. A **Known issues** block closes the section
with the three open FAILURES items. The 3.0.0 and earlier sections were not
touched ([V3.1-P3-2]).

`RUNBOOK.md`: `make gate-fast` and `make gate-nightly` are now rows in the
targets table (section 3) rather than only prose in section 7; the
`export:cli` flag list gained `--center <lat,lon>` with the reason it exists;
section 3 gained a "Screenshots for the README" subsection; and section 9 is
now "Known limitations (v3.1)" and opens with the five failing preset cities
and the STEP grid.

## 5. Verification

- All five images in `docs/assets/` were regenerated by the committed script
  against this tree and then LOOKED AT, one at a time. That is the check that
  matters here: four earlier captures exited 0 and were wrong.
  - `screenshot.png`: the three regions, the Chicago Loop on the plate, the
    stats strip (1:10,714, 34.7 mm, 0.80 mm min wall, 992 buildings), the
    estimate and the resolved attribution marks, and the 3.1.0 footer.
  - `screenshot-settings.png`: nine group headers with their state lines, from
    "Chicago, 900 m radius" to "plain, 6 mm border, 0 lines".
  - `screenshot-colour.png`: the eight built-in palettes with their swatches,
    Default through Chicago, and the save-a-palette field.
  - `screenshot-search.png`: the Photon popover, three results with CITY, ROAD
    and BUILDING badges, and its attribution footer.
  - `screenshot-objects.png`: the right-click menu on "The Heritage at
    Millennium Park", with Label its roof, the three hero rows, Height, Its own
    filament, Its own shade, Leave it out of the model and Reset this object.
- `node --check` and `npx eslint` both clean on the capture script (the gate
  runs `eslint . --max-warnings 0`, so an unused helper there would fail it).
- No em dash or en dash in any of the four files (`grep` for both).
- Every `docs/assets/*.png` the README references is written by a named shot in
  the script; there are no images in the README the script cannot regenerate.

## 6. For whoever runs it next

The dev-server path works and the final run took all five shots in one pass,
but it fights an active wave: earlier runs lost shots to another agent's save
recompiling and reloading the page. On a quiet tree, or before a release, run
it against the production build instead, which cannot reload underneath it:

```sh
cd apps/web && npm run build && node scripts/serve-static.mjs --dir out --port 3010 &
cd apps/web && node scripts/capture-screenshots.mjs --url http://localhost:3010
```

(Take `artifacts/build.lock` around the build, as the wave's rule says.) The
script reuses any server already answering the URL, so it starts nothing and
stops nothing in that shape.

Two notes on the lock and the server, for the record. `artifacts/build.lock`
was held for 14 hours by `w3close2`, an agent an account usage limit had
killed; this task took the holder file over on the orchestrator's ruling and
then released the directory, because its own page-driving was finished and
holding it blocks everyone. And the `serve-static.mjs` on :3000 was NOT reused:
its `out/` tree was built at 03:53, before Tasks 4, 5, 10, 11 and 12 landed, so
every picture taken from it would have shown an interface that no longer
exists. A throwaway `next dev` on :3010 was used instead and stopped
afterwards; `next build` was never run.
