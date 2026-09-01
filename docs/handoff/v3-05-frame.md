# v3-05 - Phase 5 frame geometry: profiles, mounts, bands, tints

Scope: `apps/web/lib/engine/solid/{frame,hangers,tint,context,buildings,repair,
validate,mesh,ornaments}.ts`, `lib/engine/{engine,types}.ts`,
`lib/engine/export/obj.ts` (tint materials only), `lib/transform.ts` (frame and
mount constants, additive), `services/bake/app/geom/transform.py` (the mirror of
the two mount minima, additive), and the tests beside them. The store, the
components, `lib/palettes*`, `lib/tint.ts`, `lib/contrast*`, the e2e suite, the
Makefile and CI were not touched. `[V3-P5-F1]` to `[V3-P5-F8]` in `DECISIONS.md`
carry the rulings; this file carries the numbers and the interface.

## 1. What was built

| file | what it is |
|---|---|
| `solid/frame.ts` | rewritten: seven profiles as stacked rings, three corner styles, the shadow gap, matting, the separate frame and its two mounts, the four face textures, the lettering keep-out |
| `solid/hangers.ts` | new: the French cleat (undercut slot + wall wedge) and the easel (well, leaning socket, leg), both printed in place |
| `solid/tint.ts` | new: `buildingTints` (ids, colours, centroids) and `bucketTints` (at most 32 materials). The COLOUR comes from `lib/tint.ts`, called not copied |
| `solid/buildings.ts` | the height-gradient split, equal count per band, plus the tint list |
| `solid/validate.ts` | `expectedBodies`: the bodies a parameter set is SUPPOSED to leave loose, and the island report's excusal of exactly those |
| `solid/mesh.ts` | the weld ladder (`[V3-P5-F1b]`), which is what clears the one sliver a rounded corner leaves |
| `export/obj.ts` | one `o` group per building body and one material per tint bucket, when the tint is on |

`types.ts` gained, additively: `COLOURABLE_REGION_NAMES`,
`DERIVED_REGION_NAMES`, `GRADIENT_MAX_BANDS`, `bandRegionName`, `bandIndexOf`,
`BuildingTint`, `BuildingBandSummary`, `EngineResult.{buildingTints,
buildingBands}`, `EngineStats.gradientBands`. Nothing was renamed or removed.

## 2. For the UI agent: the exact names and types

`REGION_NAMES` is now `COLOURABLE_REGION_NAMES` (the twelve that were there,
unchanged, in the same order) followed by `DERIVED_REGION_NAMES`:

```
cleat
buildings_band_2  buildings_band_3  buildings_band_4  buildings_band_5
buildings_band_6  buildings_band_7  buildings_band_8
```

* `cleat` is the wall-side wedge of a French cleat. Like `easel`, it has no
  `colour.region_slots` entry of its own and borrows `base`'s slot and colour.
* `buildings_band_N` is band N of a height gradient. Band 1 is plain
  `buildings`, so the names start at 2. Slot: `colour.gradient.slots[N-1]`.
  Colour: interpolated between the buildings colour and the hero colour, unless
  the UI later supplies explicit per-band colours (that would be one more table
  in the contract; nothing in the engine has to change for it, `regionColor` in
  `solid/context.ts` reads a table already).
* A row for a derived region should only be shown when the bake produced one:
  `colourRows(params, result)` already lists exactly the regions of a fresh
  result, and the no-result fallback should keep iterating
  `COLOURABLE_REGION_NAMES` rather than `REGION_NAMES`.
* `ColourGroup.tsx`'s `REGION_LABELS: Record<RegionName, string>` needs the
  eight new keys or the type must become `Record<ColourableRegionName, string>`
  with a fallback. (It already has them: that file was ahead of this one.)

Two new result fields, both absent unless the feature is on:

```ts
result.buildingTints?: Array<{ id: string; colorHex: string; centroidMm: [number, number] }>
result.buildingBands?: Array<{
  region: RegionName; slot: number; colorHex: string;
  topRangeMm: [number, number];   // printed roof heights this band covers
  buildings: number;              // solids in the band
}>
result.stats.gradientBands?: number
```

`buildingTints[i].colorHex` is exactly `tintedColor(id, buildingsColour,
params.colour.tint)` from `lib/tint.ts`, so a preview that has a fresh result
can read it straight off and one that does not can compute the same value. The
engine IMPORTS that function rather than reimplementing it
(`solid/tint.ts` -> `lib/tint.ts`), which is deliberate and is the only reason
the two can never drift: changing its signature changes the bake. The
BANDS are the one place the preview's own approximation and the bake differ:
`lib/tint.ts:heightBandIndex` splits by equal HEIGHT, the bake splits by equal
COUNT (`[V3-P5-F7]`), so a preview with a fresh result should read
`buildingBands[].topRangeMm` (or just colour the band regions) rather than
recompute.

New findings the Issues badge will see: `frame-feature-refused` (warning: the
shadow gap, the matting, the magnet mount or the texture would not fit, always
with the measured numbers), `frame-text-band-narrowed` (warning: the profile
leaves less flat top than the text was laid out for), `gradient-bands-capped`
(warning), `loose-part-in-place` (info: the cleat wedge or the easel leg prints
inside its own pocket and has to be pushed out).

## 3. Validator runs

Every combination below is the committed Chicago fixture at default parameters
plus the named change, baked through `scripts/bake-cli.ts` to `generic-3mf` and
judged by the reference validator (`uv run python -m app.cli validate`).

| bake | regions | triangles | volume mm3 | min_wall | degenerate | bodies | verdict | engine |
|---|---|---|---|---|---|---|---|---|
| default, single | 6 | 100 278 | 172 463 | 0.8746 | 0 | 1 | **ALL CHECKS PASS** | 5.2 s |
| default, parts | 6 | 100 278 | 172 463 | 0.9096 | 0 | 6 parts, union 1 | **ALL CHECKS PASS** | 5.2 s |
| chamfer + rounded corners | 6 | 101 366 | 172 314 | 0.8746 | 0 | 1 | **ALL CHECKS PASS** | 5.1 s |
| ogee + shadow gap + matting, parts | 7 | 88 444 | 162 507 | 0.9096 | 0 | 7 parts, union 1 | **ALL CHECKS PASS** | 4.7 s |
| separate frame, snap, single | 6 | 100 342 | 170 709 | 0.8746 | 0 | **2** | bodies row 2 vs 1 (expected, below) | 5.6 s |
| knurl texture | 6 | 136 398 | 172 075 | 0.8746 | 0 | 1 | **ALL CHECKS PASS** | 7.9 s |
| cleat mount (5 mm base) | 7 | 100 610 | 236 616 | 0.8746 | 0 | **2** | bodies row 2 vs 1 (expected, below) | 5.4 s |
| easel mount (5 mm base) | 7 | 100 450 | 235 755 | 0.8746 | 0 | **2** | bodies row 2 vs 1 (expected, below) | 5.4 s |
| gradient, 2 bands, parts | 7 | 100 278 | 172 463 | 0.9096 | 0 | 7 parts, union 1 | **ALL CHECKS PASS** | 4.8 s |
| stepped + mitred + brush | 6 | 127 934 | 170 538 | 0.8746 | 0 | 1 | **ALL CHECKS PASS** | 7.0 s |
| floating + dots | 6 | 149 304 | 167 339 | 0.8046 | 0 | 1 | **ALL CHECKS PASS** | 8.2 s |
| separate frame, magnet, 4 mm magnet | 6 | 101 302 | 203 812 | 0.8161 | 0 | **2** | bodies row 2 vs 1 (expected, below) | 5.5 s |

The gradient run's parts file carries every band as its own object, materials
included: `7 entries: base, frame, buildings, roads, water, parks,
buildings_band_2 #E3A72FFF`, and `part_meshes PASS 7 parts ... each manifold,
watertight, positive volume, no degenerate face`. The ogee run's carries
`matting #EDE9E0FF` the same way. The same bake as `bambu-3mf` puts every band
through the existing parts machinery untouched: `Metadata/model_settings.config`
lists `base, frame, buildings, roads, water, parks, buildings_band_2` with
extruders `1, 1, 2, 4, 3, 4, 3`, so band 2 is a part of its own on the slot
`colour.gradient.slots[1]` asked for.

### The bodies exception

Four of the twelve bakes deliberately emit a part that is NOT welded to the
plate: a separate frame, a cleat wedge, an easel leg. Their file therefore has
two bodies in it, and the reference validator's `bodies` row says so:

```
bodies             FAIL    2                       1
  bodies: 2 disconnected bodies; a slicer would show 2 objects
```

Every other row in all four passes, including `min_wall`, `degenerate_faces`,
`watertight` (`euler=2 bodies=2, closed, even euler <= 4`), `sits_at_zero` and
`bounding_box`. This is a documented exception, not a weakened check:

* the ENGINE's own gate knows the number and where it comes from.
  `solid/validate.ts:expectedBodies(ctx)` derives the expected loose parts from
  the PARAMETERS (`frame_style.separate.enabled` -> `frame`, `hanger: cleat` ->
  `cleat`, `hanger: easel` -> `easel`) and `islandReport` excuses exactly one
  body per expected region. A bake that came apart any other way is still a
  `floating-island` error with its volume and its region in it, and a SECOND
  loose body of the same region is still reported;
* the reference validator judges a FILE and has no parameters, so it counts what
  is there. Making its row PASS needs an `expected_bodies` field in the bake
  sidecar and a reader in `services/bake/app/cli.py`, which is exactly the
  phase 4 `max_height_mm` pattern (`v3-04-engine.md` section 4a) in two files
  this phase does not own. It is a 20-line change and the right one; it is left
  for whoever owns `export/common.ts` and `cli.py`.

### Two other honest warnings

* A separate frame raises `unsupported-overhang` (warning, 3.2 per cent of the
  surface): its underside is a 4 176 mm2 horizontal down-face 0.2 mm above the
  plate. It prints without support - the first layer lands on the plate top -
  but `audit/rules.ts` only excuses faces within 0.5 mm of the BED. Worth a
  rule refinement in the file that owns it ("within 0.5 mm of any face below
  it"), not something to silence here.
* The default `hanger_magnet` (6 mm) does not fit a 6 mm frame band and is
  refused with the largest that does. 4 mm and under fits.

## 4. The default bake is unchanged

`plain` + `square` takes the pre-phase-5 code path verbatim, and every number
agrees with `v3-04-engine.md`'s own baseline:

```
target generic-3mf: 6 regions, 100278 triangles, 180.0 x 180.0 x 34.7 mm
estimate: 172463 mm3 of model, 117.6 g, 39.4 m of filament, 174 layers, about 3 h 32 min
  slot 1 #D8D3C6: 58.7 g (base, frame)   slot 2 #D8D3C6: 48.0 g (buildings)
  slot 3 #2F7FC1:  3.3 g (water)         slot 4 #3A3A3A:  7.7 g (roads, parks)
min_wall 0.8746 (single) / 0.9096 (parts), degenerate_faces 0, bodies 1 / 6 parts union 1
```

The three mechanisms that could have moved it, and why they cannot: the crop
inset is zero when neither the gap nor the matting is on; the weld ladder is
never entered by a mesh that arrives with no degenerate face; and the frame's
plain path is the same single extrusion of the same single ring it always was
(`frame.test.ts` pins the ring volume, both Z faces and the region list).

## 5. Tests

```sh
cd apps/web
npx vitest run lib/engine       # 33 files, 393 tests   (was 32 / 358)
npx vitest run lib              # 62 files, 1120 tests
npm run typecheck && npx eslint lib/engine lib/transform.ts --max-warnings 0
cd ../../services/bake && uv run pytest -q     # 694 passed
```

New: `lib/engine/solid/frame.test.ts` (33 tests: profiles, corners, shadow gap,
matting, the separate frame and both mounts, the four textures and the cap and
the text clearance, the cleat and easel parts and their refusals, the bands, the
tints, and the default), plus 2 in `lib/engine/export/obj.test.ts` for the tint
materials. Nothing was skipped, weakened or deleted.

Reproducing the validator table (parameter files are the default fixture with
one group changed):

```sh
cd apps/web
npx vite-node scripts/bake-cli.ts -- --scene ../../fixtures/chicago-scene.json \
  --params <variant>.json --target generic-3mf --out ../../artifacts/p5-<name>.3mf
cd ../../services/bake
uv run python -m app.cli validate ../../artifacts/p5-<name>.3mf
```

## 6. State at hand-off

- `apps/web`: `npx vitest run lib` 62 files / 1120 tests green; `npm run
  typecheck` and `eslint --max-warnings 0` clean over `lib/engine` and
  `lib/transform.ts`. `next build` and Playwright were not run from here (the
  parallel web-editor agent owns them this phase).
- `services/bake`: `uv run pytest -q` 694 passed, with the two mount minima
  mirrored into `transform.py` (constants and two branches; no default moves, so
  `test_v1_compat.py` is untouched and green).
- Nothing committed; all changes are working-tree.
- Left for others, all named above: the `expected_bodies` sidecar field for the
  reference validator; the overhang rule's "within 0.5 mm of the bed" exclusion;
  per-band colours in the contract if the UI wants them.
