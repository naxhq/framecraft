# v3-02 audit - adversarial review of Phase 2 (commit 2a5d11e)

Auditor: independent agent, 2026-08-31. Scope: the Phase 2 state at 2a5d11e
("browser bake engine, Bambu Studio project 3MF, filament mapping, export
formats"). `lib/engine/engine.ts`, `lib/engine/types.ts` and
`solid/synthetic.test.ts` are already being edited by Phase 3 builders; every
finding in those files was verified against the 2a5d11e content (`git show`),
and may already be superseded where noted.

## What was independently verified and holds

- Bambu Studio claims re-verified against `bambulab/BambuStudio` master
  (fetched 2026-08-31, bbs_3mf.cpp 9,854 lines) by a separate research pass:
  `m_is_bbl_3mf` set only by `Application` starting `"BambuStudio-"` (the
  version-key assignment is commented out), p:UUID never required by the
  reader, `<part id>` maps to the split sub-object id, extruder read via
  `config.set_deserialize` and clamped against `filament_settings_id` length
  (out of range resets to 1), the four keys the CLI dereferences without null
  checks are all written, `custom_gcodes_per_layer` layout and ColorChange = 0
  confirmed from CustomGCode.hpp, plate_1.json and slice_info.config optional.
  Every claim in `bambu3mf.ts`'s header and DECISIONS [V3-P2-E3] checks out.
- A real Bambu project was produced (`npm run bake:cli`, Chicago fixture,
  parts params) and unzipped: entry set, component/object/part id integrity
  (1..6 sub-objects, assembly id 7), identity matrices, plate-centering
  translation (38,38 for 180 mm model on the 256 mm custom plate), extruders
  matching `colour.region_slots`, `filament_colour` in slot order, escaping,
  and the sidecar all correct.
- `building_skirt_mm: 0` bakes clean: the reference validator returns ALL
  CHECKS PASS (min_wall 0.9105, union 1 body, 0 degenerate faces), so the
  coincident-face worry at zero skirt does not materialise.
- Gate and CI plumbing: the web CI job installs uv before the validate step;
  the validate step runs only after both bake steps succeeded, so a stale
  artifact cannot be validated after a failed bake there; locally
  `scripts/gate-web-engine.sh` returns 1 on a bake failure before validating,
  so the same holds. Exit codes propagate (`|| rc=1` at Makefile:232).
- Worker protocol: a superseded bake's result can never land after the newer
  one (pending map keyed by id, old id deleted at supersede, unknown ids
  dropped in `client.ts:handleMessage`); transferred buffers are not touched
  after `postMessage`; the inline fallback shares the exact handlers; a
  bake-error reaches the UI through `engine.error` (StatsCard.tsx:33).
- Ingest: the sha1 cache key is the full query text, which includes the bbox
  derived from lat/lon/radius/rotation, so a cache entry cannot outlive a
  query change; the 7-day TTL is enforced on read; a 429 does advance to the
  next mirror. Height parsing mirrors the Python port ("12 m", "39'",
  levels <= 0 rejected, min_height guarded to (0, height)).
- e2e: every scene generation in smoke/ui/share/lettering/a11y routes
  `**/api/interpreter` to committed fixtures (no live Overpass in any spec);
  the strong assertions survive the rewrite: a downloaded file is run through
  `python -m app.cli validate` with exit code 0 and "ALL CHECKS PASS"
  asserted, the lettering ring count is pinned exactly (`toBe(8)` for
  "Chicago", ui.spec.ts:336), sliders are asserted fetch-free, the share link
  restores a fresh context and fires no fetch.
- 118/118 unit tests across `lib/engine/export`, protocol, client, colourMap,
  printers and enginePreview pass on this tree.

## Findings

### 1. BLOCKER - the colour-change planner emits zero changes on every real scene

`apps/web/lib/engine/export/colorchange.ts:80-103` decides separability by
axis-aligned Z-range overlap with `epsilonMm` defaulting to 1e-3 mm
(colorchange.ts:93). The [V3-P2] parts-mode ruling (DECISIONS.md lines
524-528) makes every region interpenetrate its neighbours by
`PART_OVERLAP_MM` = 0.2 mm and buildings reach `building_skirt_mm` = 0.3 mm
below the base top, so every region on a different slot from the base now
overlaps the base's Z range by 0.2-0.3 mm, two decades past the epsilon. The
overlap is interior, hidden material: a change at the base-top layer would
colour the visible model correctly, exactly as the pre-ruling flush partition
would have planned. The planner was not updated for the ruling.

Failure scenario: any scene with a base plus one differently-slotted region,
which is every real scene. The advertised "single-nozzle colour-change 3MF
with Z-band report" (commit message) never changes colour.

Verification: `npm run bake:cli --target color-change-3mf` on the Chicago
fixture with `fixtures/print-params-parts.json`. The produced
`Metadata/custom_gcode_per_layer.xml` contains no `<layer>` element at all,
all six regions are reported "shares layers with ... and keeps the loaded
colour", and `filament_colour` carries a single entry.

Resolution: FIXED. `colorchange.ts` now treats a seam overlap of at most
`CONSTRUCTION_OVERLAP_MM` (BUILDING_OVERLAP_MM 0.2 + building_skirt 0.3 + 0.05
slack, or `constructionOverlapFor(params)` from the caller) as interior
construction rather than shared layers, and containment at any depth as real
sharing; the plan itself became a Z-band sweep over claim intervals, so a slot
that owns a band exclusively gets a change at the boundary (midpoint of a
construction-scale gap, otherwise the new slot's first layer). On the Chicago
parts bake, `custom_gcode_per_layer.xml` now carries one
`<layer top_z="3.2" type="0" extruder="1" color="#D8D3C6"/>`: the buildings get
their own band from the base top up, while roads, water, parks (recessed into
the base) and the frame lip (which rises through the buildings) are still
reported as sharing layers. Regression tests added in `colorchange.test.ts` for
the real offsets (0.2 seam and 0.2+0.3 skirt separable, deeper sinking and
side-by-side inseparable, the measured Chicago Z ranges); the sample-fixture
test that asserted `changes == []` was corrected, not deleted: that scene now
honestly gets one change to the hero above the tallest ordinary building.

FOLLOW-UP for whoever owns `components/editor/ExportMenu.tsx` (not touched
here, Phase 3 UI owns it): line 61 prints `plan.inseparable` as "share layers
with another region and print in whatever colour is loaded". That list is now
the STRICT question (does anything on another slot share my layers), and a
region can be on it and still get its colour, as the Chicago buildings do. The
list the sentence wants is the regions that are not `served`:
`plan.report.filter((r) => !r.served).map((r) => r.region)`.

### 2. MAJOR - `ctx.warnings` is written and never read: unknown hero ids and lettering layout warnings vanish

`lib/engine/engine.ts:427` (at 2a5d11e) pushes "N hero building id(s) are not
in this scene" into `ctx.warnings`; `lib/engine/solid/lettering.ts:367`
pushes every `layout.warnings` entry there too. `EngineResult` has no
warnings field and `bake()` returns only `findings`/`resolvedText`
(engine.ts:272-279), so the channel created in `solid/context.ts:125` is a
dead end. The sidecar's `bake_result.warnings` is built from findings only
(`export/common.ts:324-328`).

Failure scenario: a share link carrying hero ids from another city, or a
stale hero after a re-generate; the user sees no hint anywhere (UI, sidecar,
CLI) that the hero was ignored.

Verification: bake of the Chicago fixture with
`hero_building_ids: ["nonexistent-hero-id"]`; sidecar `warnings: []`,
`findings: []`.

Note: engine.ts is being reworked by Phase 3; re-check there before fixing.

Resolution: FIXED. `ctx.warnings` is GONE, not routed: the field is off
`BakeContext` and `makeContext` no longer creates it, so there is nowhere
left to push a string that nothing reads. Its two writers now raise
findings. Unknown hero ids become `hero-unknown` (warning, region
`hero_building`), naming every id and saying a share link or a saved project
can carry ids from another location. `transform.lettering_layout`'s own
warning strings become one `lettering-adjusted` (info, region `lettering`)
carrying the shared layout's wording verbatim rather than the engine's
paraphrase, because they are informational: the line was still cut, and cut
correctly. Regression test in `lib/engine/solid/terrain.test.ts` ("reports a
hero id that is not in the scene"): a bake with `hero_building_ids:
["nonexistent-hero-id"]` produces the finding with the id in its detail, and
a bake with a real id produces none.

### 3. MAJOR - a schema-legal deep recess silently deletes or degrades its region

`lib/engine/solid/context.ts:255-266` (`placementOf`) clamps a region's
underside to `[baseTop/2, baseTop - 0.02]` but never clamps `top` against
`bottom`; `lib/engine/solid/areas.ts:220` then drops the region with a bare
`continue` when the extrusion comes back null. The contract allows
`proud_mm` down to -2.0 (print_params.json, RoadRegion/WaterRegion et al).

Failure scenario, both verified on the Chicago fixture, base 3 mm:
- water `proud_mm: -2.0` (the schema minimum): the water region disappears
  from the output entirely; the export lists five regions, `warnings: []`,
  `findings: []`. The user asked for a deep-water model and silently got no
  water at all.
- water `proud_mm: -1.5`, `depth_mm: 1.0`: the region survives only as the
  0.2 mm PART_OVERLAP slab at the pocket floor; the requested 1.0 mm depth
  is silently clamped to 0.2 mm with no finding.

Resolution: FIXED. `placementOf` (`solid/context.ts`) gained a third clamp:
the TOP is raised, if it has to be, so at least `MIN_REGION_DEPTH_MM` (0.2
mm, one layer, and half the thinnest contract default) of slab survives
above the pocket floor. So a deep request now builds the deepest thing the
plate can hold instead of an empty extrusion that `areas.ts` dropped on a
bare `continue`. `Placement` gained `builtDepthMm`, `builtProudMm` and
`clamped`, and `buildSurfaceRegion` raises `region-placement-clamped`
(warning) naming the region, both requested numbers, both built numbers and
the base thickness, with a SAFE one-click fix that writes the achievable
placement back. Verified on both of the audit's cases: water `proud_mm:
-2.0` now emits a region and the finding (was: five regions, `findings:
[]`), and `proud_mm: -1.5, depth_mm: 1.0` emits the finding for the 0.2 mm
slab it really gets. The default placements are arithmetically untouched -
water 1.5..2.5, roads 2.2..2.8, parks 2.6..3.0, rail 2.9..3.3, `clamped`
false for all four - which is why the Chicago default bake is still
byte-identical. Regression test: `terrain.test.ts`, "reports a recess too
deep for the base instead of dropping the region", which also asserts the
defaults do not trip it.

### 4. MAJOR - default slot table makes the preview and the Bambu print disagree about parks, rail and lettering colours

The frozen default `colour` table puts roads, parks, rail, lettering and
hero_building all on slot 4 with five different `region_colors`. The Bambu
exporter resolves one filament colour per slot as "first region in
REGION_NAMES order on that slot" (`export/common.ts:266-277`), which is
roads' #3A3A3A; the preview (`components/scene/RegionMeshes.tsx:77`) paints
each region with its own `colorHex`. So with untouched defaults the preview
shows green parks and gold lettering while the printed AMS output makes them
road-charcoal. `ColourGroup.tsx` raises no warning when regions sharing a
slot carry different colours (its only warning is the slot-count one).

Verification: `artifacts/audit-bambu.3mf` (default colour table):
`project_settings.config` `filament_colour` =
`["#D8D3C6","#D8D3C6","#2F7FC1","#3A3A3A"]`, parks part on extruder 4,
sidecar parks colour #5A9E4B.

Resolution: FIXED. `lib/colourMap.ts` gained `printedColors` (the colour a
region actually prints -- the winner of "first region in REGION_NAMES order
on its slot", mirroring `export/common.ts:slotColors`'s exact rule so the
panel can never name a different colour than the exporter writes),
`slotColourConflicts` (one entry per slot where two or more regions carry
genuinely different colours, naming the winner and the losing regions) and
`alignConflictsPatch` (a `region_colors` patch rewriting every losing region
onto its slot's printed colour). `ColourGroup.tsx`: each region row shows a
second, non-interactive "prints as" swatch (`colour-prints-as-<region>`,
title `Prints as #RRGGBB`) only when it disagrees with the row's own well; a
new warning (`colour-slot-conflicts`, same `Note tone="warn"` pattern as the
existing slot-count one) names every conflicted slot, its winning region and
colour, and the regions that lose; an "Align colours to what will print"
button applies `alignConflictsPatch` in one write. Verified against the audit's
own measurement: on the untouched defaults, `printedColors` resolves slot 4 to
whichever region is FIRST in REGION_NAMES order among the rows actually
present -- `hero_building` in the panel's pre-bake fallback (which lists every
colourable name including ones that may never bake, `colourRows`'s own
documented behaviour), or `roads` (#3A3A3A, matching the audit's real-bake
measurement exactly) once `hero_building` is excluded, e.g. because no hero is
picked and it has no mesh in a real `EngineResult`. A second, previously
unnoticed conflict on slot 1 (base #D8D3C6 vs frame #3A3A3A vs matting
#EDE9E0) was found by the same rule and is covered too. 18 new unit tests in
`colourMap.test.ts` (35 total in the file); e2e in `ui.spec.ts` ("a slot shared by regions of
different colours warns, shows what will actually print, and aligns in one
click") drives the real panel end to end, including the align button clearing
the warning. `ExportMenu.tsx`'s FOLLOW-UP note above (its `plan.inseparable`
regression) is also fixed: `notServedSentence` (`lib/colourMap.ts`) replaces
the inline logic, reads `plan.report.filter((r) => !r.served)`, and is covered
by its own unit tests including the exact "served but not separable" case the
follow-up describes (the Chicago buildings).

### 5. MINOR - the "exceeds profile slots" warning tests distinct-slot count, not slot numbers

`lib/colourMap.ts:55-57`: `exceedsProfileSlots` compares
`distinctSlots(rows).length > profileSlots`. Rows on slots {1,2,4,5} of a
4-slot Bambu profile trigger no warning (4 distinct), yet the export writes
five filament entries and addresses extruder 5, which the AMS does not have.
Verification: code path plus `slotColors`' `maxSlot` logic
(export/common.ts:271).

Resolution: FIXED. `exceedsProfileSlots` now also checks
`rows.some((row) => row.slot > profileSlots)`, catching a slot NUMBER above
the profile's count even when the distinct-slot count alone would not (the
audit's own {1,2,4,5}-on-a-4-slot-profile example: 4 distinct values, but
slot 5 does not exist on a 4-slot AMS). Two new unit tests in
`colourMap.test.ts` pin the exact scenario and confirm a profile that
genuinely has 5 slots is not flagged.

### 6. MINOR - a non-retryable HTTP status retries the same mirror four times and never fails over

`lib/engine/osm/overpass.ts:325-327`: only statuses in {429, 503, 504}
advance `mirrorIndex`; any other status (400, 403, 500) neither advances nor
breaks, so the loop re-POSTs the identical query to the identical mirror four
times with 3.5 s of backoff and reports failure without ever trying mirrors
two and three. A WAF-blocking mirror one therefore takes the whole ingest
down. Verification: code path; contrast with the 429 branch at 318-324.

Resolution: FIXED. `overpass.ts` fails over to the next mirror on every status
outside `RETRY_STATUSES` too (403, 500, 502 and so on, plus the existing
network/timeout paths), and returns immediately on the new
`QUERY_FAULT_STATUSES` {400, 422}, which are a verdict on the query and
identical at every mirror. Two tests added in `overpass.test.ts`.

### 7. MINOR - a cancelled queued bake still runs to completion

`lib/engine/protocol.ts:167-170` ignores bake cancels, and the
`queuedBake` slot (176-220) is executed when the running bake finishes even
if its client-side promise was already rejected (unmount, dispose on the
inline transport where `terminate()` is a no-op). The result is dropped by
id, so this is wasted compute only, up to one full Chicago-scale bake.

Resolution: FIXED. `protocol.cancelJob` now drops `queuedBake` when the cancel
names it (a running bake is still un-preemptible, as documented), and
`client.dispose()` posts a cancel for every pending job before `terminate()`,
which is what makes this reachable on the inline transport where `terminate()`
is a no-op. Tested in `protocol.test.ts` (the cancelled id posts nothing, ever)
and end to end through the inline transport in `client.test.ts`.

### 8. MINOR - the geometry kernel's documentation still describes the superseded flush partition

The [V3-P2-E2] ruling (DECISIONS.md, 2026-08-30) replaced the flush partition
with 0.2 mm seam interpenetration, and the code implements it
(`areas.ts:fittedSolid`, `solidBottomMm`, buildings skirt). But at 2a5d11e:
- `engine.ts` module header and `BakeOptions.onSolids` docstring still say
  regions "PARTITION the model. They touch on shared faces, never overlap".
- `types.ts` `EngineResult.merged` docstring says the same.
- `context.ts:34-56` `POCKET_GROW_MM` docstring narrates a 0.012 mm growth
  over a 0.02 mm separation; the constant is 0.002 and the layers abut.
- `validate.ts:17` claims a "no region overlaps another (they must partition
  the model)" check that `validate()` does not implement at all.
A future builder trusting these comments will re-break the seams.
(engine.ts/types.ts are Phase 3 working files; fix there.)

Resolution: FIXED, all four. `engine.ts`'s module header and
`BakeOptions.onSolids` now describe the 0.2 mm seam interpenetration, say
the union of the regions IS `merged`, and warn that per-region volumes
double-count the overlap; `types.ts`'s `EngineResult.merged` docstring says
the same and names `merged.volumeMm3` as the only volume a total or an
estimate may come from; `context.ts`'s `POCKET_GROW_MM` docstring was
rewritten to describe what it actually does (two micrometres, on ABUTTING
pockets, to stop a coincident vertical face) and to state explicitly that it
is a different problem at a different place from `PART_OVERLAP_MM`, which is
a hundred times bigger; `validate.ts`'s table row for the partition check
that does not exist is replaced by the two checks that do, plus a paragraph
saying there must not be a partition check because the overlap is
deliberate. `base.ts`'s `carveBase` docstring, which made the same claim in
passing, was corrected too.

### 9. MINOR - the wall-too-thin auto-fix halves the nozzle while its label says "widen the crop"

`lib/engine/solid/validate.ts:201-205`: the finding's fix is labelled "Widen
the crop so features print bigger" but the patch is
`nozzle_mm: max(0.1, nozzle/2)`, which neither widens anything nor matches
the user's physical nozzle; it just relaxes the threshold the check compares
against. Verification: code.

Resolution: FIXED. The patch no longer touches `nozzle_mm` - no automatic
fix may ever write it, because it describes the hardware and halving it only
halves the threshold the check compares against while the print still fails.
The fix now offers a bigger PLATE, which makes the model itself bigger:
`biggerPlateMm` (exported from `validate.ts`) asks the shared advisor's
`transform.recommend_plate_mm` for the smallest plate that brings the
widened fraction under target, falls back to one 20 mm step, and caps at
`transform.PLATE_MAX_MM`. At the top of the plate range it returns null and
the finding carries the advice as prose ("a bigger plate would print the
same city larger; so would a smaller radius") rather than a button, because
a smaller radius is a change to the SceneRequest and not to PrintParams.
Tested directly on the helper in `terrain.test.ts` rather than through a
bake, so the assertion cannot pass vacuously.

### 10. MINOR - `bandedCutters` is dead code with a docstring that oversells it

`lib/engine/solid/base.ts:163-192` is called by nothing (engine carves with
per-surface grown-pocket cutters; `buildings.socket` is always empty). Its
comment calls Z-banding "the whole answer to the sliver problem" while
DECISIONS [V3-P2-E2] (line 516) records it was measured worse (4,972
zero-area faces). Verification: repo-wide grep, single match.

Resolution: FIXED by deletion. `bandedCutters`, `Pocket` and
`BAND_OVERLAP_MM` are removed from `base.ts` along with the docstring that
called Z-banding "the whole answer to the sliver problem"; DECISIONS
`[V3-P2-E2]` already records it measured worse (4,972 zero-area faces) and
the engine has never called it. The two imports it was the only user of
(`CrossSection`, `unionSections`) went with it.

### 11. MINOR - share spec pins `schema_version` to literal 2 while the contract default is 3

`lib/share.ts:429` (`{ kind: "literal", value: 2 }`) vs `lib/contracts.ts:385`
(`schema_version: 3`). Normal links are unaffected (paramsDiff omits the
default-equal value), but a hand-made or tool-made link carrying the honest
`"schema_version": 3` is refused, and one carrying 2 would write 2 onto a v3
params object. Verification: code.

Resolution: FIXED. `FieldSpec`'s `"literal"` kind now carries `values:
readonly number[]` (was a single `value: number`), and
`PRINT_PARAM_SPEC.schema_version` is `{ kind: "literal", values: [2, 3] }`,
matching the frozen contract's own `2 | 3` type exactly -- a link naming
either legal value round-trips, one naming anything else (4, 1, ...) is
refused and names both legal values in its message ("must be 2 or 3", not
"must be 2"). `share.test.ts`'s existing `outOfRange({ schema_version: 3 })`
assertion, which had pinned the bug (asserted 3 itself was refused), now
checks 4 and 1 instead; a new test asserts both 2 and 3 decode successfully
and round-trip their own value.

### 12. MINOR - smoke happy path under-asserts the Chicago download against a stale justification

`e2e/smoke.spec.ts:364-374` skips validating the full-Chicago download,
citing a "measured, documented gap"; DECISIONS [V3-P2-E4] (line 530) records
that gap as closed ("ALL CHECKS PASS ... in BOTH modes"), and this audit's
own bakes of the same fixture reproduce ALL CHECKS PASS. The happy-path
assertion is now weaker than the truth allows (zip magic only); the gate's
bake:cli step does cover the combination, so this is redundancy lost, not a
hole. Verification: probes in this audit; artifacts/audit-skirt0.3mf table.

Resolution: FIXED. New dedicated test in `e2e/smoke.spec.ts`, "the downloaded
file passes the Python printability validator (full Chicago scene)": Chicago
preset, `color_mode: parts`, `export_target: generic-3mf` (not the happy
path's default `bambu-3mf` -- the reference validator's `trimesh`-based
loader cannot read Bambu's multi-part production-extension structure
regardless of geometry quality, a permanent format limitation, not this gap;
the happy path's own comment and the top-of-file A5 note were reworded to say
so precisely instead of citing an open gap).

First run (2026-08-31, `lib/engine/solid/**` under active concurrent edit by
the Phase 3 geometry builder) genuinely failed: `min_wall` 0.039 mm (threshold
0.72 mm), `degenerate_faces` 50, `bodies` 12 disconnected -- worse across all
three than the numbers DECISIONS [V3-P2-E4] closed this gap with, not merely
still-open. Flagged to the geometry builder directly with the full validator
output rather than guessed at or worked around; root cause turned out to be
real and specific to the app's OWN ingest path, not this fixture: the app
bakes the scene the browser engine ingests from live OSM data (780 elevated
`bridge`/`layer` ways in the Loop), while every engine test up to that point
baked `fixtures/chicago-scene.json` (the Python service's fixture, which
carries none), so the deck/abutment construction's coincident-face and
near-tangency defects were invisible to the existing suite entirely. Five
separate defects, fixed by the geometry builder (deck ribbon polygon
tolerance, abutment/ribbon tangency, a clipped square's shared walls, a
flared square's near-miss junction, an abutment foot landing exactly on a
grade road's underside); `scripts/bake-cli.ts` gained `--overpass`/`--terrain
demo` so the ingested scene can be baked headlessly, and `engine.test.ts` now
bakes it as a permanent regression test.

Re-run after that fix (this audit's own `make gate`, 2026-09-01): `min_wall`
0.7275 mm (barely above the 0.72 mm floor -- a real, if narrow, margin, not a
coincidence of the threshold), `degenerate_faces` 0, `bodies` 6 parts / 491
shells / union 1. ALL CHECKS PASS, both through `npm run bake:cli` directly
and through the real UI -> download -> CLI pipeline this test exercises.

UPDATE (Phase 3 geometry builder, same day): diagnosed and FIXED. The
regression was real, was mine, and was entirely `solid/bridges.ts`. Its cause
is that `fixtures/chicago-scene.json` carries no `bridge`/`layer` tags at all,
so the committed fixture every engine test used could not exercise elevated
geometry, while the scene this e2e bakes through the app's own ingest has 780
elevated ways in the Loop. Five separate coincident-face and near-tangency
defects in the deck and abutment construction, each measured and each listed
in `docs/handoff/v3-03-geometry.md` section 7c and `DECISIONS.md`
`[V3-P3-G13]`, `[V3-P3-G13b]`, `[V3-P3-G14]`. The same combination now reads
ALL CHECKS PASS in BOTH modes on the ingested scene (parts: min_wall 0.7275,
degenerate_faces 0, 6 parts / 491 shells / union 1, part_meshes clean; single:
min_wall 0.7275, degenerate_faces 0, bodies 1), and the committed Python-scene
default bake is byte-identical to the pre-phase file. `bake-cli.ts` gained an
`--overpass` flag so the ingested scene can be baked headlessly, and
`engine.test.ts` now bakes it as a permanent regression alongside the committed
fixture, so this class of defect cannot be invisible again.

### 13. MINOR - stale "live Overpass needed" comments in CI and the gate

`.github/workflows/ci.yml:215-223` (the e2e job's FRAMECRAFT_OFFLINE comment,
"A2 ... plus the rotation-nudge ... need real Overpass reachability") and the
Makefile gate step 8 comment ("the e2e drives one live Overpass query") both
describe the pre-rewrite suite. Every current spec routes
`**/api/interpreter` to committed fixtures (A2 uses `mockEmptyOverpass`; the
rotation nudges run under the Chicago mock), so no spec needs the network.
The step-8 stray-fixture guard is now guarding a path nothing exercises.
Verification: grep of all five spec files for mock installation.

Resolution: FIXED (comments only, no behaviour change). The CI e2e job's
`FRAMECRAFT_OFFLINE` comment and the Makefile's gate step 6/8 wording now say
that every spec routes `**/api/interpreter` to a committed fixture and that the
stray-fixture guard is kept for a future spec that forgets the mock.

### 14. MINOR - CityPreview.test.ts's V3_ENGINE_MOVES bucket carries a stale premise, though its assertions remain correct

`components/scene/CityPreview.test.ts:255-298`: the bucket's comment and test
title say the v3 groups rebuild nothing because "the engine that will read it
has not landed yet". The engine landed in this phase and does read `regions`,
`colour`, `heights`, `bridges` etc. (via the debounced engine job in
`store/editor.ts:setParam`), but through `scheduleEngineJob`, not through the
instanced-preview memo keys, so the assertions themselves are still right:
no INSTANCED layer reads those groups. Worth rewording before someone
"fixes" the deps. Related observed tradeoff, already documented in DECISIONS
line 500: while an engine job recomputes after a `colour` write, the
fallback instanced preview shows the v1 `part_colors` palette, not
`params.colour`.

Resolution: FIXED, incidentally, by the Phase 3 UI hand-off
(`docs/handoff/v3-03-ui.md`) before this audit note was read: the bucket's
comment was reworded to say the twelve remaining groups still rebuild nothing
in THIS file's sense because it describes the client-side approximate
preview, which the real engine job (`scheduleEngineJob`, reruns on every
`setParam` regardless of key) does not feed -- not because "the engine has
not landed". `hero_auto` was also carved out of the bucket into its own
asserted-real test in the same pass, for an unrelated reason (it now moves
`previewDeps.height` through `lib/warnings.ts`'s effective-hero-id
composition), which happens to be a second instance of exactly the kind of
staleness this finding warns about being reintroduced.

### 15. MINOR - `gate-web-engine.sh` assumes `artifacts/logs` exists

`scripts/gate-web-engine.sh:32` redirects into `artifacts/logs/` which only
`make gate` step 0 creates; running the script standalone on a clean tree
fails on the first redirect instead of baking. One `mkdir -p` would make it
self-contained. Verification: code; the script has no mkdir.

Resolution: FIXED. `scripts/gate-web-engine.sh` does `mkdir -p artifacts/logs`
before its first redirect, so it runs standalone on a clean tree.
