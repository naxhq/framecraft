# v3-04 - Phase 4 engine: printability audit, estimates, tiling, multi-plate export

Scope: `apps/web/lib/engine/audit/**` (new), `lib/engine/estimate.ts` (new),
`lib/engine/solid/tiling.ts` (new), `lib/engine/export/tiles.ts` (new), plus the
wiring those needed in `lib/engine/engine.ts`, `lib/engine/types.ts` (additive
only), `lib/engine/solid/{validate,lettering}.ts`,
`lib/engine/export/{bambu3mf,index}.ts` and `apps/web/scripts/bake-cli.ts`, and
the tests beside each. `lib/printers.ts`, the store, the components,
`lib/warnings.ts`, `lib/colourMap.ts`, the e2e suite, the Makefile and CI were
not touched. `[V3-P4-E1]` to `[V3-P4-E8]` in `DECISIONS.md` carry the rulings.

## 1. What was built

| file | what it is |
|---|---|
| `lib/engine/audit/rules.ts` | the whole finding catalogue and `auditPrintability`, which assembles `EngineResult.findings` |
| `lib/engine/audit/fixes.ts` | `applyFix` / `applySafeFixes`: a deep-partial patch merge that reports every leaf it moved |
| `lib/engine/estimate.ts` | `estimate(result, params)`: per-slot and total volume, grams, metres, layers, time |
| `lib/engine/solid/tiling.ts` | the N x M split, dovetail and pin joints, cut snapping, sliver removal, index marks |
| `lib/engine/export/tiles.ts` | the tiled routing: one file per tile in a zip, or one plate per tile in a Bambu project |
| `lib/engine/export/bambu3mf.ts` | rewritten around a list of plates; one plate is byte-identical to before |
| `scripts/bake-cli.ts` | `--tiling COLSxROWS[:joint[:tol]]`, per-tile files with their own sidecars, estimate output |

`lib/engine/types.ts` gained, additively: `TileResult.merged`, `FixChange`,
`FixApplication`, `SlotEstimate`, `EstimateAssumptions`, `EstimateResult`, and
`EngineStats.{tiles,tileCols,tileRows}`. Nothing was renamed or removed.

## 2. The audit (4b)

`auditPrintability(input)` returns the complete finding list, error first,
de-duplicated. The split is: `solid/*` raises what needs a live WASM handle,
`audit/rules.ts` raises what can be measured from the finished meshes AND does
the assembly, so a caller asks one function "what is wrong with this model".

| id | severity | raised by | fix |
|---|---|---|---|
| `not-manifold` | error | `solid/validate.ts` | none |
| `floating-island` | error | `validate.islandReport` + `rules.ts` wording | drop the offending optional feature, never safe |
| `exceeds-plate` | error | `solid/validate.ts` (vs `plate_mm`) | none |
| `exceeds-profile-plate` | error | `rules.ts` (vs the ACTIVE profile) | smaller plate, or enable tiling with computed cols/rows |
| `exceeds-height` | error | `solid/validate.ts`, against the ACTIVE profile's ceiling | halve `large_scale`, not safe |
| `wall-too-thin` | error/warning | `solid/validate.ts` | terrain exaggeration (safe) or a bigger plate; NEVER the nozzle |
| `unsupported-overhang` | warning/info | `rules.ts` | none by design |
| `buildings-merged` | info | `rules.ts` | none |
| `slot-beyond-profile` | error | `rules.ts` | clamp to the profile's top slot (safe) |
| `tile-exceeds-plate` | error | `rules.ts` | a bigger grid |
| `tile-seam-trimmed`, `tile-joint-refused`, `tile-index-refused`, `tile-empty` | info/warning | `solid/tiling.ts` | none |
| `text-too-small` | warning | `solid/lettering.ts` | set the line to its measured working size, not safe |

Overhangs are area-weighted downward-facing triangles more than 50 degrees from
vertical, excluding faces within 0.5 mm of the bed; warning above 2 percent of
the surface, info above 0.5. The default Chicago plate reports none, which is
right: it is a plate, prisms and grooves, with no undercut anywhere.

`fix.safe` means "cannot make another finding worse AND throws nothing away
that the user asked for" (`[V3-P4-E3]`). `applyFix` refuses any patch touching
`nozzle_mm` at any depth, and `rules.test.ts` sweeps every rule's patch for it.

## 3. Estimates (4c)

`estimate(result, params)` is pure. Default Chicago, measured:

```
172463 mm3 of model, 117.6 g, 39.4 m of filament, 174 layers, about 3 h 32 min
  slot 1 #D8D3C6: 58.7 g (base, frame)
  slot 2 #D8D3C6: 48.0 g (buildings)
  slot 3 #2F7FC1:  3.3 g (water)
  slot 4 #3A3A3A:  7.7 g (roads, parks)
```

Constants and why: `[V3-P4-E2]`. The total volume is `merged.volumeMm3`, never
the sum of the regions; per-slot volumes are the region volumes scaled by one
factor so they add up to it. `estimate.test.ts` pins the 3 to 6 hour window
against a real bake, so the calibration cannot silently drift.

## 4. Tiling (4d)

`params.tiling.enabled` splits every region solid and `merged` on vertical
planes, `cols` west to east and `rows` south to north. Each tile is a
`TileResult` with its own regions, its own welded `merged`, its bbox and a grid
reference (`A1` is the top-left tile seen from above).

Joints, per `[V3-P4-E4]`: a `dovetail` is a plan trapezoid, 6 mm neck, 1.5 mm
flare a side, 5 mm deep, prismatic in Z so tiles mate by being lowered together;
a `pin` is a cylinder on the cut normal, 4 mm across clamped to fit inside the
base slab. The male key belongs to the lower-indexed tile of every seam. The
socket is the key's own section offset outward by `tolerance_mm`, which is what
makes the clearance exact on every flank and at the tip.

Two things a straight cut cannot do on its own, both measured rather than
assumed:

- the cut is SNAPPED to the cleanest line within 3 mm (`[V3-P4-E6]`); the
  nominal Chicago centre line landed 0.33 mm from a street groove's wall;
- what it still leaves too thin is MEASURED and REMOVED (`[V3-P4-E7]`), by the
  reference validator's own rule. Scanning every candidate line within 3 mm of
  the centre, the best still shaved 2.4 mm2 into sub-nozzle fins, so removal is
  not optional. The user is told, as `tile-seam-trimmed` with the volume in it.

## 4a. The height ceiling (team lead's ruling, `[V3-P4-E9]`)

The Z ceiling is the ACTIVE printer's usable height, `resolveProfile(params)
.maxHeightMm`, not `min(60, ...)`. Three places had to agree and now do:

- `solid/validate.ts:maxHeightMm` - the number in the `exceeds-height` finding;
- the editor's own readout and warning (p4-ui's side, `lib/warnings.ts`);
- the reference validator's bounding-box row, reached through the FILE:
  `export/common.ts` writes the resolved ceiling into the sidecar as
  `max_height_mm`, and `services/bake/app/cli.py:_max_height_from_sidecar`
  reads it back into `checks.validate(..., max_height_mm=)`. Absent, unreadable
  or not a positive number leaves 04's own 60, so a file with no sidecar (or
  one written before this existed) is judged exactly as it always was.

`audit/rules.ts`'s `exceeds-profile-height` was deleted rather than kept
alongside: one ceiling, one finding.

The contract half (`custom_profile.max_height_mm` default 250 -> 60) landed with
p4-ui's change and is confirmed end to end: the default Chicago bake writes
`max_height_mm: 60` into its sidecar and the validator's row reads
`x,y <= 180.01 mm; z < 60 mm`, ALL CHECKS PASS. One consequence worth knowing:
the pinned single-plate hash in `export/tiles.test.ts` MOVED with it, because
every 3MF carries its PrintParams in the Description metadata. The writer itself
is unchanged - verified again after the contract change by importing
`git show HEAD:...bambu3mf.ts` beside the current one, which produces the same
`b475962f...` for the same fixture.

Python side (minimal, as asked): one keyword-only parameter on
`checks.validate`, one sidecar reader in `cli.py`, two calls updated. Covered by
`tests/test_bake.py::test_validator_judges_height_against_the_printer_the_bake_names`
and `tests/test_validate_cli.py::test_cli_reads_the_height_ceiling_from_the_sidecar`
(parametrised over present / absent / garbage).

## 5. Export (4e)

`exportForTarget` routes a tiled result:

- `bambu-3mf` + a Bambu profile: ONE file, one plate per tile
  (`Metadata/plate_N.json`, one `<plate>` per tile in `model_settings.config`,
  one `3D/Objects/object_N.model` per tile, one build item per tile positioned
  at that plate's world origin);
- everything else, including a tiled colour-change project: a zip of per-tile
  files named `<stem>-A1.<ext>` plus `CREDITS.txt`.

The plate positions are Bambu Studio's own (`PartPlate.cpp`
`compute_origin`/`plate_stride_x`, `PartPlate.hpp` `compute_colum_count`),
which matters because nothing in a 3MF assigns an object to a plate: the loader
gives each instance to the first plate whose build volume its bounding box
intersects (`[V3-P4-E5]`).

Single-plate output is **byte-identical** to the committed writer, checked by
importing `git show HEAD:apps/web/lib/engine/export/bambu3mf.ts` beside the
current one and comparing outputs, on the real Chicago bake and on the export
fixture, and pinned forward by a hash test (`sha256 b475962f...`). That hash
tracks the CONTRACT as well as the writer, since the Description metadata
carries the PrintParams: it moved once when `custom_profile.max_height_mm`'s
default went 250 -> 60, and the test comment says to re-run the old-versus-new
import before ever editing it.

## 6. Measurements

| | |
|---|---|
| default Chicago bake (untiled) | 3.9 s engine, `ALL CHECKS PASS` |
| 2x2 tiled Chicago, plate 180 | **7.8 s engine** (budget 25 s), 8.4 s including export |
| tile sizes | A2 94.4 x 92.3 x 27.3, B2 87.7 x 92.3 x 5.0, A1 94.4 x 89.8 x 31.3, B1 87.7 x 89.8 x 34.7 mm |
| tile volumes | 56 861 / 24 251 / 54 946 / 35 868 mm3 (model 172 463) |
| material trimmed at the seams | about 2 000 mm3 of prism, under 0.3 percent of the model |

Reference validator, `uv run python -m app.cli validate` on each tile written by
`--tiling 2x2 --target generic-3mf`:

```
A1: min_wall 0.9105  degenerate_faces 0  bodies 1   ALL CHECKS PASS
B1: min_wall 1.0550  degenerate_faces 0  bodies 1   ALL CHECKS PASS
A2: min_wall 0.8161  degenerate_faces 0  bodies 1   ALL CHECKS PASS
B2: min_wall 0.8331  degenerate_faces 0  bodies 1   ALL CHECKS PASS
```

(against a 0.72 mm floor). The untiled model still reads `ALL CHECKS PASS`.

## 7. Verify

```sh
cd apps/web
npx vitest run lib/engine          # 27 files before this phase, 32 after (358 tests)
npx vitest run lib                 # 58 files, 1029 tests, all green
npm run typecheck && npx eslint lib/engine scripts/bake-cli.ts --max-warnings 0

# the tiled Chicago, end to end
npx vite-node scripts/bake-cli.ts -- --scene ../../fixtures/chicago-scene.json \
  --params ../../fixtures/print-params-default.json --target generic-3mf \
  --tiling 2x2 --out ../../artifacts/p4-tiled.3mf
cd ../../services/bake
uv run python -m app.cli validate ../../artifacts/p4-tiled-A1.3mf
uv run python -m app.cli validate ../../artifacts/p4-tiled-B1.3mf
```

`--tiling` also writes each tile as its own file with its own `<stem>.json`
sidecar, which is what makes a single tile validatable: the tiled export itself
is a zip or a multi-plate project and the reference validator can open neither.

## 8. State at hand-off

- `npx vitest run lib`: 58 files, 1029 tests, green. New: `audit/rules.test.ts`
  (21), `audit/fixes.test.ts` (13), `estimate.test.ts` (11),
  `solid/tiling.test.ts` (15), `export/tiles.test.ts` (15).
- `npm run typecheck` and `eslint --max-warnings 0` clean over `lib/engine` and
  `scripts/bake-cli.ts`. `next build` and Playwright were not run from here
  (owned by the parallel web-editor agent this phase); they reported the merged
  tree green afterwards: `npx vitest run` 1167 passed, typecheck and lint clean,
  and the full production Playwright suite 39/39 including the two Python
  validator smoke tests on real baked files.
- `services/bake`: `uv run pytest -q` 694 passed, including the two new height
  tests above.
- Nothing committed; all changes are working-tree.
- For the UI agent: `applyFix(params, finding)` and
  `applySafeFixes(params, findings)` return `FixApplication`
  (`{ params, changes: FixChange[], applied: string[], skipped }`), where each
  `FixChange` carries a dotted `path`, `before`, `after`, the `findingId` and a
  ready-made one-line `label` ("Plate 180 becomes 220"). `hasSafeFixes(findings)`
  says whether the "Auto-fix all safe issues" button should be shown at all.
  `EstimateResult` is documented in `types.ts`; every number in it is an
  estimate and `caveat` is the sentence to print beside them.
