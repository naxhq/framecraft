# P5 — qa-gate

Gate **G4**: `make gate` runs pytest, eslint, vitest, `next build` and the
Playwright smoke test, brings the stack up and down around the e2e, and exits
non-zero if any step fails.

**Result: GATE PASS** (2026-08-29, Windows 11 + Git Bash, uv 0.12 / Python
3.12, node 26 / npm 11, no Docker).

```
export PATH="/c/Users/Vahid/AppData/Local/Microsoft/WinGet/Packages/ezwinports.make_Microsoft.Winget.Source_8wekyb3d8bbwe/bin:$PATH"
make gate > artifacts/logs/gate.log 2>&1; echo rc=$?     # -> rc=0, "GATE PASS"
```

| step | command | result |
|---|---|---|
| 0/4 | `make down` (the gate owns the stack lifecycle) | ok |
| 1/4 | `cd services/bake && uv run pytest -q` | **309 passed**, 64.5 s |
| 2/4 | `cd apps/web && npm run lint && npm test && npm run build` | eslint clean, **125 vitest** in 10 files, build clean |
| 3/4 | playwright chromium present | ok (hint printed if not) |
| 4/4 | `make up` → `npm run test:e2e` → `make down` | **2 passed**, 37.7 s |

Baseline before this phase was 288 pytest / 125 vitest; the 21 new tests are
`services/bake/tests/test_validate_cli.py`. No existing test, validator or
threshold was weakened, skipped or deleted.

---

## 1. What was built

### `apps/web/e2e/smoke.spec.ts` (2 tests, no mocking)

Drives the **real** stack: next on :3000 → FastAPI on :8000 → the committed
Overpass fixtures. There is no `page.route` interception anywhere; a mocked
`/scene` would make the gate a test of the mock.

**`happy path: Chicago preset previews, sliders stay local, bake downloads a
valid 3MF`** — 01's primary user flow, in order:

1. `GET /` → the persistent `© OpenStreetMap contributors` footer.
2. The preset row holds exactly **six** buttons; the Chicago one reads
   `Chicago — Loop` (DECISIONS [P1] label, em dash included).
3. Click it → assert **exactly one** `POST /scene`, the r3f `<canvas>` is
   attached, the HUD stats chip is visible, and record the elapsed time (A1).
4. The scene is really Chicago: `994 buildings` in the chip, and neither
   `warning-coverage-empty` nor `warning-coverage-sparse` nor `scene-error` is
   present.
5. Move `plate_mm` 180 → 200, `large_scale` 100 → 120 %, toggle road mode
   engrave → emboss → engrave, `base_thickness_mm` 3 → 4 → assert **zero**
   requests to the bake API, **zero** main-frame navigations, and that a
   `window` marker planted before the moves is still there (i.e. no reload).
6. Drive `small_scale` on every animation frame for 2 s and report the measured
   frame rate (A3, see the caveat below).
7. `rotation_deg` +1 with the keyboard → assert **exactly one** new
   `POST /scene` (rotation is a server-side crop, DECISIONS [P0]), then −1 back
   to 0 so the bake runs on the fixture-backed preset.
8. Press **Bake**, poll to `Done` and to a visible download row (A4).
9. The stats card shows triangles, volume, bounding box, filament grams and
   `Manifold yes` (01 step 5).
10. `request.get(href)` on the 3MF link → HTTP 200, non-empty body, content
    type `application/octet-stream` (or the 3MF media type), and the first two
    bytes are `PK` (a 3MF is an OPC zip). Saved to
    `artifacts/e2e/chicago-e2e.3mf`, with the bake's `<stem>.json` sidecar
    beside it as `chicago-e2e.json`.
11. `uv run python -m app.cli validate <that file>` via `child_process` →
    **exit 0** and `ALL CHECKS PASS`, and the output proves it judged the file
    against the sidecar's 200 mm plate rather than the contract default.
12. No uncaught page errors at any point.

**`low coverage: a pin in open water warns and disables Bake`** (01/A2) — loads
the Chicago preset, calibrates metres→pixels from the two map markers (the pin
and the radius handle are at two known geographic points), zooms out five steps
with the map control (each click is exactly one zoom level, verified by
re-measuring the marker distance to ±40 %), clicks ~14 km east into Lake
Michigan, confirms the pin followed the click and that Generate turned into
Regenerate, then Generates. Asserts the banner
`Fewer than 20 buildings here (0) — enlarge the radius or move the pin.`, that
**Bake is disabled**, that `bake-block-reason` says the same thing, and that
the canvas is still there (A2 wants a warning, not an empty scene or a crash).
That request is a **live Overpass query** (it is not a preset); it soft-skips
**only** when `POST /scene` answers 502/503, i.e. when Overpass is unreachable,
and never on an assertion failure.

`test.afterAll` prunes the `fixtures/<sha1>.json` files that a non-preset
`/scene` leaves behind (see §4), so the e2e cannot silently grow the repo.

### `apps/web/playwright.config.ts`

chromium only, headless, `retries: 0`, `workers: 1`, `fullyParallel: false`,
`trace: "retain-on-failure"` + screenshot on failure into
`artifacts/e2e/test-results/`, `baseURL` `http://localhost:3000`. Two
`webServer` entries with `reuseExistingServer: true`, so the config starts
**nothing** when `make up` already did. `--enable-unsafe-swiftshader` is passed
to Chromium: modern Chrome refuses the software WebGL fallback without it, and
there is no GPU here.

### The validator: `make validate FILE=<path>` / `make validate <path>`

The CLI already printed 04 stage 4's nine rows with value and threshold. This
phase added the **3MF container** rows to the `validate` subcommand only
(`services/bake/app/cli.py`; `app/validate/checks.py` is untouched):

| row | rule |
|---|---|
| `3mf_parts` | the package holds `[Content_Types].xml`, `_rels/.rels`, `3D/3dmodel.model` |
| `3mf_unit` | `<model unit="millimeter">` |
| `3mf_objects` | exactly one `<object>` |
| `3mf_build_items` | exactly one `<build><item>` |
| `3mf_attribution` | `Description` metadata carries `© OpenStreetMap contributors` |
| `3mf_counts` | the `<vertex>` / `<triangle>` counts in the XML equal the loaded mesh's |

The command exits **1** on any FAIL (stage 4 or container) and 0 only on
`ALL CHECKS PASS`. A `.3mf` that will not load at all now prints the container
table naming the broken part instead of a traceback; a `.stl` keeps its
existing behaviour (no container rows).

Full table on the committed fixture bake:

```
$ make validate artifacts/chicago.3mf
check              result  value                       threshold
manifold           PASS    not carried; watertight=True winding=True
watertight         PASS    euler=2 bodies=1            closed, even euler <= 2
volume             PASS    1.676e+05                   > 0 mm^3
self_intersection  PASS    0 in 33 sampled pairs; 0 bad edges; 0 dupes   0
bounding_box       PASS    180.000 x 180.000 x 34.733 mm   x,y <= 180.01 mm; z < 60 mm
sits_at_zero       PASS    0                           |min z| <= 0.001
min_wall           PASS    0.8097                      0.72
triangle_budget    PASS    68,682                      2,000,000
degenerate_faces   PASS    0                           0
3mf_parts          PASS    3 parts                     [Content_Types].xml, _rels/.rels, 3D/3dmodel.model
3mf_unit           PASS    millimeter                  millimeter
3mf_objects        PASS    1                           1
3mf_build_items    PASS    1                           1
3mf_attribution    PASS    present (343 chars)         OSM attribution in Description
3mf_counts         PASS    xml 34,343 v / 68,682 t     mesh 34,343 v / 68,682 t

ALL CHECKS PASS
```

`make validate FILE=artifacts/chicago.stl` also passes (the STL path indexes
the triangle soup first, DECISIONS [P3-fix]).

### `services/bake/tests/test_validate_cli.py` (21 tests, 3.3 s)

Bakes a small synthetic scene once per module (a real `run_pipeline`, so these
are artifacts the bake produced) and then proves the command is **not
vacuous** — one corruption per validator, each asserted by name:

- delete a triangle → `watertight` FAIL + `manifold` FAIL, exit 1;
- scale ×1.5 → `bounding_box` FAIL while topology stays PASS;
- translate +2 mm in z → `sits_at_zero` FAIL;
- reverse every face → `volume` FAIL;
- `--plate-mm 100` on a 180 mm model → `bounding_box` FAIL;
- drop `_rels/.rels` → `3mf_parts` FAIL; a non-zip file → same, no traceback;
- `unit="inch"` → `3mf_unit` FAIL; two `<item>` → `3mf_build_items` FAIL;
- rewrite the attribution → `3mf_attribution` FAIL;
- add an object no build item references → `3mf_objects` + `3mf_counts` FAIL;
- a model part carrying a `<!DOCTYPE>` → refused before parsing.

Plus the real subprocess (`sys.executable -m app.cli validate`) for the exit
codes `make` actually sees, the A6 proxies (below), and a
`test_cli_passes_on_the_chicago_fixture_bake` that keeps G3's own command green
whenever `artifacts/chicago.3mf` exists.

### Makefile

- **`gate`** — `make down` → pytest → (lint + vitest + build) → chromium check
  → `make up` (redirected to `artifacts/logs/up.log`) → `npm run test:e2e` →
  `make down` **always**, then `GATE PASS` / `GATE FAIL` and `exit $rc`. The
  e2e is skipped after an earlier failure (a broken build cannot be smoke
  tested) but the gate still exits non-zero. `next build` deliberately runs
  *before* `make up`: building into `.next` while `next dev` serves it corrupts
  the dev server (DECISIONS [P4]).
- **`up`** — unchanged except for the new `FRAMECRAFT_WEB_MODE` switch:
  `prod` builds and serves the production bundle (`npm run build` in the
  foreground, then `npm run start`), anything else keeps `next dev` so `make
  up` stays fast. Both verified on this host; the e2e passes against either.
- **`install`** — already ran `npx playwright install chromium`; the gate now
  checks for the binary and prints the exact command to run if it is missing.
- **`validate` / `down`** — unchanged behaviour, both argument forms verified.

---

## 2. Acceptance criteria audit (01)

| # | Criterion | How it is verified | Measured |
|---|---|---|---|
| **A1** | Preset previews in under 5 s warm | e2e `happy path` step 3, from the click to the canvas **and** the stats chip; gate asserts < 15 s and prints the real number | **0.12–0.15 s** (`next dev`), **0.19 s** (`next start`). Server side: 7–12 ms warm, 35 ms from the disk cache (P2) |
| **A2** | Arbitrary pin previews; under 20 buildings shows a clear warning, not an empty scene or a crash | e2e `low coverage` (pin ~14 km into Lake Michigan, live Overpass); plus `lib/warnings.test.ts` and `test_ingest.py`'s coverage classification | Banner `Fewer than 20 buildings here (0) — enlarge the radius or move the pin.`, Bake **disabled**, canvas still rendered |
| **A3** | 30 fps on a 3000-building scene; **no server call on a slider change** | *No server call*: e2e step 5 asserts an empty request list across four parameter changes + `store/editor.test.ts` (a `setParam` never touches `fetch`). *Frame rate*: e2e step 5b drives a slider on every frame for 2 s and reports fps | **0 API calls**, 0 navigations, marker survives. **22–25 fps** on 994 buildings in headless SwiftShader. See the caveat below |
| **A4** | Chicago bakes to a `.3mf` in under 90 s | e2e steps 7–8 (through the UI, with the moved sliders); `test_golden_chicago_is_under_the_time_budget` asserts < 90 s | **8.8–9.3 s** through the UI (plate 200 mm, large 120 %); 10.2 s via the CLI; 2.9 s pipeline-only (P3) |
| **A5** | The baked mesh passes every 04 validator | `make validate` on `artifacts/chicago.3mf` and on the file the browser downloaded; `test_validate_cli.py` (21) proves the command fails when it should; `test_bake.py` golden + synthetic suites | `ALL CHECKS PASS`, 15 rows. Chicago 180×180×34.733 mm, min wall 0.810 mm, 68 682 tris; e2e file 200×200×46.613 mm, min wall 0.829 mm, 75 886 tris |
| **A6** | Opens in Bambu Studio / PrusaSlicer as one object, flat at Z=0, slices cleanly | **Not fully verifiable on this host** (no slicer installed). Automated proxies: the `3mf_*` container rows, `sits_at_zero`, and `test_a6_proxy_*` (trimesh's own 3MF reader → one body, watertight, positive volume, `bounds[0][2] == 0`, top < 60 mm) | Proxies green on every bake. Manual procedure below |
| **A7** | `make up` from a clean clone brings the whole stack up | `make up` in this phase (dev and prod), gate step 4/4, G1 earlier; `make down` frees both ports | `up: bake and web are healthy` in ~10 s (dev) / ~40 s (prod, includes `next build`). `/health` 200, `/` 200 |

### A3 caveat (do not over-claim)

22–25 fps is a **software-renderer** number: headless Chromium here falls back to
SwiftShader, where one idle frame of the Chicago preview already costs ~45 ms
(DECISIONS [P4]). The test asserts only a catastrophic floor (> 4 fps, i.e.
"the preview did not stop rendering or start rebuilding geometry per tick") and
prints the measurement. **A3's 30 fps must be re-measured on real GPU
hardware.** The parts of A3 that *are* provable here — no server call, no
reload, and only the affected buffer rebuilding (`CityPreview.test.ts`) — are
asserted.

### A6 manual procedure (10 minutes, on a machine with a slicer)

1. `make bake-fixture` → `artifacts/chicago.3mf` (or use
   `artifacts/e2e/chicago-e2e.3mf`, which the browser really downloaded).
2. Open Bambu Studio (or PrusaSlicer) → *File ▸ Import ▸ Import 3MF*.
3. Confirm, before slicing:
   - the object list shows **one** object, not a group of bodies;
   - the object sits **on** the plate (Z = 0), no "object below bed" warning
     and no auto-drop applied;
   - the reported size is 180 × 180 × 34.7 mm (or the plate you baked);
   - *Repair* is **not** offered (it is offered only for non-manifold input).
4. Slice at 0.20 mm layer height, 0.4 mm nozzle, 15 % infill, 3 walls.
5. Expect zero errors and a preview whose first layer is one solid 180 mm
   square. Record the sliced time/filament next to the estimate the stats card
   showed (`est_grams` is volume × 1.24 × 0.35, labelled an estimate).
6. Repeat once with `.stl` to confirm the fallback format.

Report the result in this file; A6 stays *proxied* until someone does.

---

## 3. How to reproduce

```sh
export PATH="/c/Users/Vahid/AppData/Local/Microsoft/WinGet/Packages/ezwinports.make_Microsoft.Winget.Source_8wekyb3d8bbwe/bin:$PATH"

make install                      # uv sync + npm ci + playwright install chromium
make gate                         # the whole G4 gate, leaves the stack down
make validate artifacts/chicago.3mf

# pieces, for debugging
cd services/bake && uv run pytest -q tests/test_validate_cli.py
make up && cd apps/web && npx playwright test --grep "happy path"; cd ../.. && make down
FRAMECRAFT_WEB_MODE=prod make up  # production bundle instead of next dev
```

Never pipe `make up` through another command (its background children hold the
pipe); redirect to a file, as `make gate` does.

---

## 4. fixtures/ pruning

`fixtures/` held **12** sha1-named Overpass responses while
`presets-index.json` referenced **6**. The extra six were re-fetch leftovers
(P2-fix re-fetched New York) and audit debris; nothing in the repo referenced
them (`grep` over `*.py`, `*.ts`, `*.json`, `*.md` → no hits).

| | before | after |
|---|---|---|
| `fixtures/` on disk | 137 128 KB (133.9 MiB) | 67 372 KB (65.8 MiB) |
| sha1 fixtures | 12 | 6 (exactly the ones `presets-index.json` names) |

**Freed: 69 756 KB ≈ 68.1 MiB.** Removed: `05cd9e1e…`, `07ce7ff0…`,
`3efcd042…`, `64cc7626…`, `6a32b7e0…`, `f59806dc…`. Kept: the six preset
fixtures plus `chicago-scene.json`, `parity-scene.json`,
`parity-expected.json`, `presets-index.json`.

`uv run pytest -q` is **green offline after the prune** (309 passed, with
`FRAMECRAFT_OFFLINE=1` forced by `tests/conftest.py`), which is what proves the
six survivors are the ones the suite actually reads.

The e2e now keeps that invariant: a `/scene` at a user-dropped pin caches its
raw response as a new `fixtures/<sha1>.json`, so `smoke.spec.ts`'s `afterAll`
deletes every sha1-named file `presets-index.json` does not list — the same
rule `python -m app.cli refresh-fixtures` uses.

---

## 5. Ambiguities resolved (also in DECISIONS.md as `[P5-qa]`)

1. **Playwright's `webServer` does not shell out to `make up`.** The brief asks
   for the make target; Playwright needs a process that *stays* in the
   foreground (`make up` daemonises and exits) and spawns it through cmd.exe on
   this host, where `make` is not on PATH. The config therefore starts exactly
   the two commands `make up`'s native path starts, with
   `reuseExistingServer: true` so it starts nothing when the gate already
   brought the stack up. Same env switch (`FRAMECRAFT_WEB_MODE=prod`).
2. **The gate stops the stack before it builds.** `next build` while `next dev`
   is serving corrupts `.next` (DECISIONS [P4]), so `make gate` opens with
   `make down`. The gate owns the stack lifecycle end to end.
3. **The smoke test bakes with the sliders it moved** (plate 200 mm, large
   120 %), not with the defaults, and downloads the bake's `<stem>.json`
   sidecar so the validator judges the file against those parameters. Verified
   independently that this combination passes every validator (46.6 mm tall).
4. **Rotation is nudged +1° then back to 0°** before the bake. +1° proves
   rotation costs exactly one `POST /scene`; returning to 0° puts the bake back
   on the preset, which is fixture-backed and offline, so the gate does not
   depend on a live Overpass query for its main assertion. (The +1° fetch does
   go to the network the first time, then to the 24 h `/scene` disk cache.)
5. **Lake Michigan, not the open ocean.** The A2 pin has to be reachable by a
   map click, so it must be near the preset. 41.90/−87.45 is ~14 km offshore:
   Overpass returns **0 elements in 8 s** there (no coastline way is inside the
   bbox, so the Lake Michigan relation is not returned either), which makes it
   both cheap and unambiguous.
6. **The e2e prunes stray fixtures instead of leaving them.** See §4.
7. **A6 gets proxies plus a written manual procedure**, and is reported as
   *proxied*, never as passed.
8. **A3's 30 fps is measured and reported, not asserted.** Asserting it on
   SwiftShader would either fail honestly or pass a meaningless threshold; the
   catastrophic floor is asserted instead.
9. **The container checks live in `cli.py`, not `checks.py`.** 04 stage 4 is a
   mesh gate and `checks.validate(mesh, params)` has no file to look at;
   `app/validate/checks.py` (mesh-bake's file) is untouched.

---

## 6. Open items handed on

- **F1** in `FAILURES.md`: `npx tsc --noEmit` fails on
  `apps/web/lib/warnings.test.ts:179` (a cast needing `as unknown as`). Not in
  the gate's path; owner is web-editor.
- **A6** stays proxied until someone opens a `.3mf` in a slicer (§2).
- **A3's frame rate** must be re-measured on GPU hardware (§2).
- Docker/`docker compose` is still unverified on this host (no Docker). `make
  up`, `make gate` and `make validate` use POSIX sh recipes and the compose
  branch is unchanged, so the docker path is as verified as it was in P1.
- `ruff` remains blocked by this host's Windows Application Control policy
  (DECISIONS [P1]); the gate runs eslint + the Python test suite instead.

---

## 7. Fix pass (P5-fix, 2026-08-29)

Four audit-verified defects, fixed at their true root cause. **`make gate`
re-run: rc=0, GATE PASS** - 315 pytest (was 309), eslint clean, 125 vitest,
`next build` clean, 2 Playwright tests, **0 skipped**. Re-run a second time with
`FRAMECRAFT_OFFLINE=1` in the environment: also rc=0, also 2 passed / 0 skipped.
Nothing was weakened, skipped or deleted; no contract field was touched;
`transform.py` / `transform.ts` and `fixtures/parity-*.json` are untouched (no
shared-math helper was added).

```
export PATH="/c/Users/Vahid/AppData/Local/Microsoft/WinGet/Packages/ezwinports.make_Microsoft.Winget.Source_8wekyb3d8bbwe/bin:$PATH"
make gate > artifacts/logs/gate-fix.log 2>&1; echo rc=$?     # -> rc=0, GATE PASS
```

### D1 - frame OFF left a 0.05 mm rind of base at the plate edge

`services/bake/app/geom/thicken.py`. With the frame off `usable_span == plate`,
so `crop_square` sits exactly `CROP_INSET_MM` (0.05 mm) inside the plate's own
side wall. Every recess - water, engraved roads - was clipped to that crop, so
each one that reached the edge left a 0.05 mm rind of base standing between it
and the physical edge. Chicago Loop, all other params default: plate 240/256
failed Stage 4 `min_wall` at 0.050 mm; plate 200 shipped ~39 such appendages.
With the frame on the rind sits under the 6 mm lip and is fused into solid
material, which is why the default path never showed it.

New `thicken.recess_clip_square(params, scale, grid)`: `crop` with the frame on,
`plate_square` grown by `RIDGE_BRIDGE_CELLS * grid` with it off. It is used for
the water layer, for an *engraved* road layer (an embossed road is additive and
still stops at `crop`), and as the `merge_recess_ridges` bridge clip. Growing
past the plate keeps the cutter strictly outside the side wall, so the boolean
never sees a coincident vertical face; the recess simply opens onto the wall.

### D1b - the ridge bridge was being thrown away again every pass

Adding the deterministic recess slice (below) immediately failed the **default,
frame-on** Chicago bake at 0.113 mm - a pre-existing ridge the random slices had
never sampled. Root cause: `merge_recess_ridges` builds a bridge over the ridge
and then ran the merged layer back through `finish_layer`, whose
`_drop_unprintable` dropped the bridge for being under `min_detail^2`. The ridge
in question is a wedge between two *ponds*, and the sink is the *road* layer
(the deepest recess), so the bridge lands there as an isolated ~0.1 mm^2 polygon
with nothing to merge into. All four passes rebuilt it; all four dropped it.

The bridge is now regridded (`thicken.regrid_layer`, the `set_precision` +
collinear half of `finish_layer`) and kept. A sub-minimum **cutter** polygon
prints as a dimple no nozzle reaches, i.e. solid base; dropping it prints as a
ridge no nozzle can lay down - the same argument `strip_thin=False` already
makes for a cutter's thin limbs. The sink also keeps its own drop counters
instead of having them overwritten by the merge's.

### D1c - a pre-existing GEOS crash found while sweeping the parameter space

`chicago-loop` at nozzle 0.6 / frame off / plate 256 aborted the whole bake with
`TopologyException: Ring edge missing` inside `thicken.snap`'s dilate-and-clip.
Confirmed **pre-existing** (it reproduces with both Stage 1 changes above
reverted) and `grid_size=` fixed precision does not survive it either. `snap`
now degrades for that one polygon: it keeps it snapped and un-opened. The
opening is a deburring pass, not a correctness invariant - every caller still
runs the minimum-feature filters afterwards.

### D2 - the min-wall probe now always slices the recess bands

`services/bake/app/validate/checks.py`. `recess_probe_zs(params, min_wall)`
returns one deterministic Z per recess band on top of the 12 random stratified
slices. The height is the midpoint of `[band_bottom, band_top - persist]`, not
of the band: at the band midpoint the tapering-tip look-ahead lands exactly on
the base top, where the base does not persist and the region would be skipped.
A band shallower than one look-ahead is left to the random slices. The
`min_wall` message now reports `slices + len(recess_zs)`.

### D3 - `make validate` accepted a file with a second, disconnected body

`services/bake/app/cli.py` gained a `bodies` row (`_single_body_check`), run for
`.3mf` **and** `.stl`, PASS only at exactly one connected shell.
`artifacts/audit-tests/corrupt/twobodies.3mf` (the e2e Chicago bake plus a
floating 5 mm cube at z = 30, written into the same `<object>`) used to print
`ALL CHECKS PASS` with exit 0; it now prints `bodies FAIL 2 / 1` and exits 1.
04's `watertight` row tolerates several bodies on purpose (`even euler <= 2 *
body_count`) and `3mf_objects` / `3mf_counts` count XML elements, so nothing
else could catch it. `checks._body_count` became the public
`checks.body_count(mesh, manifold=None)`.

### D4 - the gate asserted budgets looser than 01

`apps/web/e2e/smoke.spec.ts`: `A1_BUDGET_MS` 15 s -> **5 s**, `A4_BUDGET_MS`
120 s -> **90 s**, i.e. 01/A1 and 01/A4 verbatim. "Warm cache" is now literal:
the happy path clicks Chicago, then `san-francisco-fidi`, then Chicago again and
times only the third click, polling the HUD building count back to Chicago's -
so the timed click provably rebuilt the preview and a clean clone's cold 12 MB
fixture parse is not what gets measured. Measured **0.09 s** (A1) and
**10.3 s** (A4).

### D5 - A2 soft-skipped on the 503 that `FRAMECRAFT_OFFLINE=1` produces

Three changes, because one was not enough:

1. `smoke.spec.ts` reads the 502/503 **body** and asserts the detail does not
   contain `FRAMECRAFT_OFFLINE` before it skips. That 503 is `main.py`'s
   `OverpassOffline` mapping, not "Overpass is unreachable".
2. `make gate` starts the stack with `FRAMECRAFT_OFFLINE=` (empty), so the bake
   API can reach Overpass whatever the caller exported.
3. `playwright.config.ts` adds a `json` reporter
   (`artifacts/e2e/results.json`) and the gate fails on `stats.skipped > 0`.
   Playwright exits 0 on a skip; a skipped acceptance test is not a pass.

Verified: `FRAMECRAFT_OFFLINE=1 make gate` -> rc=0, **2 passed / 0 skipped**, A2
banner really asserted. The skip detector itself was verified against a
`skipped: 1` report (exit 1).

### Regression tests added (6)

| test | proves |
|---|---|
| `test_bake.py::test_frame_off_recesses_open_onto_the_plate_edge_instead_of_leaving_a_rind[200.0]` / `[256.0]` | the real Chicago scene at frame=False passes every validator, and `base_top - 0.25` plus every `recess_probe_zs` height holds no appendage under `0.9 * min_wall` (`thicken.narrowest_width`, the gate's own measure) |
| `test_bake.py::test_the_recess_slice_catches_the_rind_the_random_slices_missed` | with the pre-fix clip monkeypatched back, `validate(..., slices=0)` - the recess probe **alone**, no random slice - fails at the 0.05 mm crop inset |
| `test_validate_cli.py::test_cli_fails_when_a_second_disconnected_body_is_added` | `bodies` FAIL + exit 1 while `watertight`, `3mf_objects`, `3mf_build_items`, `3mf_counts` all still PASS |
| `test_validate_cli.py::test_cli_fails_on_a_second_body_in_an_stl_too` | the row runs for `.stl`, which has no container rows |
| `test_validate_cli.py::test_cli_bodies_row_passes_on_the_real_bake` | not vacuous the other way: the shipped file reads exactly 1 |

### Parameter sweep re-run after the fixes (all 14 configs `done`, 0 failing checks)

Six presets at the defaults; chicago 200/256, london 256, tokyo 240 and paris
180 at frame=False; chicago at `road_mode=emboss`, at `water=False` and at
`nozzle_mm=0.6`. `make bake-fixture` + `make validate artifacts/chicago.3mf`
(G3) still `ALL CHECKS PASS`, now with the `bodies` row.

### Still open after this pass

- **F1** in `FAILURES.md` (`npx tsc --noEmit` on `lib/warnings.test.ts:179`) is
  unchanged and still not in the gate's path; owner is web-editor.
- A6 stays *proxied*, A3's frame rate still needs GPU hardware, Docker is still
  unverified on this host (section 6).
