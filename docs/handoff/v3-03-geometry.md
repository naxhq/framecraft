# v3-03 - Phase 3 geometry: terrain, drape, bridges, rail, trees, height exaggeration

Scope: `apps/web/lib/engine/terrain/**` (new), `apps/web/lib/engine/solid/**`,
`apps/web/lib/engine/engine.ts`, `apps/web/lib/engine/types.ts` (additive only),
and the shared-math pair `apps/web/lib/transform.ts` +
`services/bake/app/geom/transform.py` with `fixtures/parity-expected.json` and
its two test files. Nothing in `store/`, `components/`, `lib/heroes.ts`,
`lib/warnings.ts`, `e2e/`, the Makefile or CI was touched. Rulings are
`[V3-P3-G1]` to `[V3-P3-G15]` in `DECISIONS.md`. `scripts/bake-cli.ts` was
handed to this phase by the team lead for the `--terrain` and `--overpass`
flags section 7c and 7d need.

## 0. The headline

**With terrain off, the Chicago default bake is BYTE-IDENTICAL to the file this
phase started from**, and the reference validator reads `ALL CHECKS PASS` with
every number unchanged. See section 7. Everything below is what happens when
terrain, bridges, rail, trees or the exaggeration are switched on.

## 1. Files

| File | New? | What it owns |
|---|---|---|
| `lib/engine/terrain/png.ts` | new | Enough PNG to read a Terrarium tile in Node, on fflate, no new dependency |
| `lib/engine/terrain/heightfield.ts` | new | Terrarium decode, grid build, normalisation, box-blur smoothing, the bilinear sampler |
| `lib/engine/terrain/tiles.ts` | new | `fetchTerrainGrid`, zoom choice, the tile mosaic, fail-soft |
| `lib/engine/solid/drape.ts` | new | The displacement field, the vertical shear, the rigid lift |
| `lib/engine/solid/bridges.ts` | new | Elevated road and rail decks and their abutments |
| `lib/engine/solid/trees.ts` | new | Tree markers, the printable-size gate, the point-in-layer index |
| `lib/engine/solid/base.ts` | changed | The terrain hook and the `terrain-not-draped` finding REMOVED; the plate is built flat and draped afterwards |
| `lib/engine/solid/buildings.ts` | changed | Rigid lift per solid; `building_top_mm_exaggerated` |
| `lib/engine/solid/roads.ts` | changed | Grade / elevated split, `railWidthGroundM`, `isElevated` |
| `lib/engine/engine.ts` | changed | The drape order, the assembly restructure, the new stats and the low-relief finding |
| `lib/engine/types.ts` | changed | Four optional `EngineStats` fields |
| `lib/engine/solid/fixture.ts` | changed | `hillGrid`, `rampGrid`, `road`, `area`, `surfaceHeightAt`, rail and trees in `scene()` |
| `lib/transform.ts` / `app/geom/transform.py` | changed | `terrain_z_scale` is live; the exaggeration curve, its inverse, `building_top_mm_exaggerated` |

## 2. Terrain (3a)

`fetchTerrainGrid({lat, lon, radiusM, rotationDeg}, params, {fetch?})` is the
one entry point, and it is exactly what `store/editor.ts` already calls.

- Source: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`,
  keyless, CORS-open, public domain (`[V3-P3-G2]`). `TerrainGrid.source` carries
  the credit line, `TERRARIUM_SOURCE`.
- Zoom: the coarsest of 12, 13, 14 whose pixels meet
  `min(30 m, 2 * radius / 64)`. Chicago at 900 m gets z13 (14.2 m/px); a 250 m
  crop gets z14; a 5 km crop gets z12. Capped at `MAX_TILES` = 36.
- Decoding: `createImageBitmap` + `OffscreenCanvas` in the browser,
  `terrain/png.ts` in Node. The Node path is the one the tests exercise, on all
  five PNG scanline filters, because the test server encodes them in rotation.
- Resampling: bilinear in tile-pixel space into a square grid over the ROTATED
  crop in scene metres, through the ingest side's own `LocalFrame`, so the
  rotation lives in exactly one place. Grid size `2 * radius / cellM + 1`,
  clamped to [8, 257].
- Normalisation: metres above the grid's own minimum, read back out of the
  float32 array so the minimum is exactly 0 (tracking the double that went in
  left it 2.3e-5 m off, and the base slab's thickness depends on that zero).
- `params.terrain.smoothing` box-blur passes (0 to 5), separable, edge-clamped,
  re-normalised afterwards.
- **Exaggeration is NOT in the grid** (`[V3-P3-G1]`). It is
  `transform.terrain_z_scale`, applied once, where an elevation becomes print
  millimetres. Moving the slider re-bakes without re-fetching a tile.
- Fail-soft to `null` for: the switch off, a non-finite or non-positive radius,
  a rejected fetch, a non-200, a body that is not a PNG this decoder reads, a
  tile of the wrong size, or a crop needing more than `MAX_TILES`.

## 3. The drape (3a), and the two bugs it took to get right

The drape is a **vertical shear** applied to finished solids (`[V3-P3-G3]`):

```
(x, y, z) -> (x, y, z + weight(z) * displacement(x, y))
```

- `displacement` is `transform.terrain_z_mm(sampler, params, scale)` times a
  plan taper that reaches zero at the crop edge.
- `weight` is 0 below the chamfer, ramps to 1 by `0.35 * base_thickness`, and is
  1 above. So the underside stays flat on the bed, the 45 degree chamfer keeps
  its angle, and every printed height above the base slab is TRANSLATED rather
  than stretched.
- `displacement >= 0` (the grid is normalised to its minimum), so the map's
  z-derivative is `1 + weight'(z) * displacement >= 1`: it cannot fold, and it
  is a bijection of space, so it maps unions to unions and differences to
  differences. Every seam, interpenetration and weld from `[V3-P2-E2]` survives
  without being re-derived.
- Buildings and trees are rigidly TRANSLATED by the LOWEST displacement under
  their own footprint (outline vertices plus an interior lattice at the drape
  resolution, so a courtyard block cannot miss its own dip). A tower keeps a
  flat roof and plumb walls and is buried in the hill on its high side. The weld
  is guaranteed because `lift_min - skirt < displacement(x, y)` everywhere.
- The frame is not draped, and does not need to be: the plan taper is zero
  across the whole 6 mm band.

Two things had to be measured rather than reasoned about:

1. **Warping the plate and the grooves separately does not work** (`[V3-P3-G7]`).
   A warp is per-vertex and interpolated linearly across each triangle, so two
   solids warped separately agree only to their own chord error, and the plate
   top and a groove floor are 0.2 mm apart. Chicago came out with ten fragments
   of hillside floating in the air (0.0008 to 2.2 mm3, all inside the taper).
   Fix: the welded assembly is built FLAT and draped as ONE solid. Surface
   regions are still draped individually, which is safe because they overlap the
   base laterally as well as vertically.
2. **A fixed 3 mm plan taper is the steepest thing on the plate** (`[V3-P3-G8]`).
   Chord error of a smoothstep of amplitude `A` over width `L` sampled every `h`
   is about `0.75 A h^2 / L^2`; at `L = h` that is most of `A`. The taper width
   now scales with the relief: `clamp(4 * relief, 12 mm, 0.6 * cropHalf)`, which
   bounds the error at `0.42 / A` mm.

`terrain-not-draped` is gone. The new info finding is `terrain-low-relief`,
raised when the scaled relief is under 0.8 mm (two layers), carrying the
measured number and a safe one-click fix that doubles `terrain_exaggeration`.

## 4. Water, bridges, rail (3d)

**Water** was already a recess by placement; what phase 3 adds is that it is a
recess below the LOCAL surface. `terrain.test.ts` proves it by probing the
welded model with a 0.4 mm column at two points on the same contour, one in the
pond and one on bare base: the step between them is exactly
`regions.water.proud_mm`, wherever on the hillside the pair sits. The floor of
that recess is the water region's own top face (the darker floor the preview
reads), not a hole in the base.

**Rail** is a full region: `params.regions.rail.width_m` when the way carries
none, `depth_mm` / `proud_mm` like any other surface layer, its own slot and
colour. It appears the moment `scene.rail` is present (E1 emits it) and is
absent otherwise.

**Bridges** (`[V3-P3-G4]`): `bridge=yes` or `layer > 0`, on roads or rail, gated
on `params.bridges.enabled`.

- The segment is REMOVED from its grade layer and rebuilt as a slab
  `bridges.clearance_mm` above the local surface, thickness
  `max(region depth_mm, 0.6 mm)`.
- Bridge footprints never enter the precedence blocker chain, so the river keeps
  its own recessed surface under the deck. Only buildings block a deck.
- `bridges.abutments` builds a column at each free end, from
  `max(base/2, base - 1 mm)` up into the deck, clipped to the deck's own
  footprint. With abutments off the decks are genuinely loose and the engine
  raises `bridge-unsupported` (warning) instead of shipping them silently.
- A deck joins the region its segments came from, so bridges add no region, no
  slot and no colour.

## 5. Height exaggeration (3e)

Shared math, mirrored function for function (`[V3-P3-G5]`):

```
exaggerated_height(h_m, multiplier, curve, h_ref = 50)
real_world_equivalent_m(h_m, multiplier, curve, h_ref = 50)   # the INVERSE
height_exaggeration_multiplier(params) / height_exaggeration_curve(params)
exaggerated_height_for(h_m, params)
building_top_mm_exaggerated(building, params, scale, is_hero)
```

- `curve = 0` is literally `h * multiplier`, so the double default is an exact
  identity and no existing number can move by a rounding step.
- `curve` in (0, 1] is `multiplier * h_ref * (h / h_ref) ** (1 - curve * 0.6)`:
  continuous, strictly increasing, exact at the pivot for every curve, and the
  relative gain is `multiplier * (h / h_ref) ** (-0.6 * curve)`, so short
  buildings gain more than tall ones.
- Applied to the GROUND height, before the print scale and before the 0.6 mm
  clamp, in `buildings.ts`. A stacked tower reads its block's top through the
  same function, so the two still meet exactly.
- `real_world_equivalent_m` is the **true inverse**, not an alias: given a
  height as the model shows it, it returns the real height that produced it.
  `real_world_equivalent_m(exaggerated_height(h, m, c), m, c) == h` for every
  legal pair, and that identity is pinned on both sides.
  `components/editor/groups/HeightsGroup.tsx` already reads it this way.
- `exaggeratedHeight` and `realWorldEquivalentM` are exported as camelCase
  aliases of the same function objects for the UI; the file's own convention is
  snake_case so it can be diffed against `transform.py`.
- `terrain_z_scale` is now `params.terrain_exaggeration` instead of a constant
  1.0. Two committed parity values moved as a result and no others.

### Parity fixture

Regenerated the sanctioned way,
`FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_transform.py`. Added:

- two new cases (9 in total): `terrain-and-height-exaggeration` (terrain 2.0,
  multiplier 2.0, curve 0.35, otherwise case 1's parameters so only the v3 knobs
  move) and `height-exaggeration-full-curve` (multiplier 0.25, curve 1.0,
  terrain 0.0, frame off);
- per case: `terrain_z_mm` at three elevations, and a `height_exaggeration`
  block (multiplier, curve, the curve sampled at six ground heights);
- per building: `exaggerated_height_m` and `top_mm_exaggerated`;
- one top-level `height_exaggeration_matrix`: seven `(multiplier, curve)` pairs
  over the whole legal rectangle, each with the curve and its round trip at the
  same six heights. Params-independent, so it is pinned once rather than nine
  times.

Diffed before accepting: every v1/v2 value in the seven original cases is
unchanged except `terrain_z_scale` in the two cases that set
`terrain_exaggeration` away from 1.0, which is the point of the change.

## 6. Trees

`transform.select_tree_indices_for` decides which trees survive, unchanged: it
is the shared predicate the reference bake and the preview already filter on.
What this phase adds is the geometry and 04's second half.

- **Truncated cone, not pointed** (`[V3-P3-G6]`). A pointed cone fails the Stage
  4 minimum-wall gate at 0.485 mm on the Chicago plate, and correctly so. The
  taper stops at `min_wall / (2 cos(pi/8))`, the same printable floor the cone's
  base has to clear, leaving a top face exactly one minimum wall across. A trunk
  is added when the floor leaves it genuinely narrower than the canopy; at
  Chicago scale it does not, so the reference's plain cone silhouette prints.
- A tree centred inside the buildings, roads, rail or water footprint is left
  out (parks are not blockers - parkland is where trees belong). The test is on
  the CENTRE, through a Y-banded edge index rather than a bounding-box cull,
  because the road layer's few components each span most of the plate.
- A tree whose whole canopy does not fit inside the crop square is left out
  rather than clipped to a crescent.
- Trees join the `parks` region: parkland's slot, parkland's colour, no new
  region. They are unioned into the assembly AFTER the recess subtraction, or a
  tree beside a kerb has its base carved into a crescent by the road's groove.
- Findings: `trees-too-small` (info, one summary with the count and the floor)
  and `trees-blocked` (info, the count that stood on something else).

## 7. Numbers

### The terrain regression, before and after

```sh
cd apps/web && npm run bake:cli -- --scene ../../fixtures/chicago-scene.json \
  --params ../../fixtures/print-params-default.json \
  --target generic-3mf --out ../../artifacts/chicago-web.3mf
cd ../../services/bake && uv run python -m app.cli validate ../../artifacts/chicago-web.3mf
```

Run against the tree as it stood before this phase and again after it. Every
part of the 3MF hashes IDENTICAL (`3D/3dmodel.model`, `[Content_Types].xml`,
`_rels/.rels`), and the validator table is the same row for row:

| check | value |
|---|---|
| manifold | watertight=True winding=True |
| watertight | euler=2 bodies=1 |
| volume | 1.725e+05 mm3 |
| self_intersection | 0 in 21 sampled pairs |
| bounding_box | 180.000 x 180.000 x 34.733 mm |
| sits_at_zero | 0 |
| min_wall | 0.8746 (threshold 0.72) |
| triangle_budget | 58,978 |
| degenerate_faces | 0 |
| bodies | 1 |
| 3mf_counts | xml 29,491 v / 58,978 t |

**ALL CHECKS PASS**, both before and after. The only difference in the run is
one new `info` line on stderr, `5762 of 5762 trees are too small to print`,
which is the finding the brief asks for.

### Chicago timing and size

| | |
|---|---|
| Flat default bake | **4.6 to 5.3 s** in Node (three runs: 4633, 5038, 5339 ms) |
| Draped bake, 60 m of relief | 7.2 to 7.5 s, 194,982 triangles against 100,278 flat |
| Draped height | 37.85 mm, relief 5.60 mm printed, one body, no error findings |
| Plate 256 with trees | 12.6 s, 1699 markers |

The 6 s target is met, but the margin is smaller than the 3.0 s the v3-02
handoff recorded, and the difference is host load rather than this phase: the
flat output is byte-identical, so no geometry work was added, and these runs
were taken with seven `node.exe` processes and 82 % CPU on the box (a parallel
agent building concurrently). Worth re-timing on an idle host before treating
5.3 s as the number.

### Trees at the two plates

| Plate | Scale | Site radius | Kept | Dropped |
|---|---|---|---|---|
| 180 | 0.0933 mm/m | 0.373 mm | **0** | 5762 (all under the 0.5 mm floor) |
| 256 | 0.1356 mm/m | 0.542 mm | **1699** | 4063 |

All 5 762 Chicago sites are 4.0 m across, so the floor is all-or-nothing between
the two plates. At 256 the `TREE_CAP` of 2000 binds first and 301 of those
survivors then fall inside a building, road, rail or water footprint or over the
crop edge.

## 7b. v3-02 audit findings routed to this phase

Five findings landed in files this phase owns. All five are marked FIXED in
`docs/handoff/v3-02-audit.md` with the detail; the summary:

| # | Fix |
|---|---|
| 2 MAJOR | `ctx.warnings` is **removed**, not routed. The field is off `BakeContext` and `makeContext` no longer creates it, so there is nowhere left to push a string nothing reads. Unknown hero ids raise `hero-unknown` (warning); the shared layout's own adjustment strings raise one `lettering-adjusted` (info). |
| 3 MAJOR | `placementOf` gained a third clamp: the top is raised so at least `MIN_REGION_DEPTH_MM` (0.2 mm) of slab survives. `Placement` gained `builtDepthMm`, `builtProudMm`, `clamped`; `buildSurfaceRegion` raises `region-placement-clamped` (warning) with both requested and both built numbers and a safe fix. Default placements are arithmetically untouched. |
| 8 MINOR | The stale flush-partition docstrings in `engine.ts` (header and `onSolids`), `types.ts` (`merged`), `context.ts` (`POCKET_GROW_MM`), `validate.ts` (the partition row that was never implemented) and `base.ts` (`carveBase`) now describe the 0.2 mm interpenetration that is actually built. |
| 9 MINOR | The wall-too-thin fix no longer writes `nozzle_mm`. It offers a bigger PLATE through the shared advisor (`biggerPlateMm`, exported and tested directly), capped at `PLATE_MAX_MM`, and falls back to prose when there is no plate left to offer. |
| 10 MINOR | `bandedCutters`, `Pocket` and `BAND_OVERLAP_MM` deleted from `base.ts`, with the two imports they were the only user of. |

Regressions for 2, 3 and 9 are in `lib/engine/solid/terrain.test.ts` under
"findings that used to vanish (v3-02 audit)". The thin-wall one asserts on the
exported helper rather than on a bake, because a conditional assertion inside
`if (finding !== undefined)` would pass vacuously the day the finding stopped
firing.

After all five, the Chicago default bake still validates with every number
identical to the pre-phase baseline (volume 1.725e+05, min_wall 0.8746, 58,978
triangles, 29,491 vertices, bodies 1, degenerate 0, ALL CHECKS PASS).

## 7c. The scene the app actually bakes, and the bridge rebuild it forced

`fixtures/chicago-scene.json` comes from the Python service and carries **no
`bridge`/`layer` tags and no rail layer**, so it exercises none of this phase's
elevated geometry. The scene the APP bakes, built by `lib/engine/osm`, has
**780 elevated ways** in the Loop. Every bridge defect below was invisible on the
committed fixture and immediate on the ingested one; the phase-3 UI agent found
the first symptom through the e2e download, which is what prompted this.

`apps/web/scripts/bake-cli.ts` therefore gained `--overpass <overpass.json>`
(ingest through `lib/engine/osm`, the app's own path) alongside
`--terrain <grid.json|demo|demo:<relief_m>>`, `--radius` and `--rotation`.

Five defects, each measured, each a variation on "a boolean across a coincident
or near-tangent face leaves zero-area triangles" (`[V3-P3-G13]`):

| Symptom | Cause | Fix |
|---|---|---|
| min_wall 0.794 vs 0.800 | a deck ribbon at exactly `min_wall`; a 16-gon join's flats are 2 % narrower than its diameter | `DECK_MIN_WIDTH_FACTOR` 1.25: a deck IS the wall, a grade road is a groove |
| min_wall 0.393 | an abutment disc intersects the ribbon in a lens tapering to nothing | drop the disc |
| 720 degenerate faces | a square clipped back to the deck shares the deck's own walls | drop the clip |
| 167 degenerate faces | a square flared to 1.2 of the deck width sits 0.1 mm from the deck's wall at a junction | drop the flare |
| 80 faces, 11 zero-volume shells | the footing taken from the deck's grown shape put its wall back on the buildings the deck was cut against | a DIAMOND (a square turned 45 degrees, so its edges are never parallel to a north-south street grid) of the deck's nominal width, clipped to the crop and to nothing else |
| 1 degenerate face | `base_top - 1 mm` is 2.0 mm on a 3 mm base and so is `areas.solidBottomMm` for the grade roads: two formulas, one plane | `abutmentFootMm`, two seam overlaps below the deepest legal pocket floor |
| min_wall 0.205 | the deck cut flush against buildings and grown back leaves the grown lip in the air where a building is shorter than the deck | hold the deck `PART_OVERLAP_MM` CLEAR of buildings instead (`[V3-P3-G13b]`) |
| `bodies` union 11 | decks whose ends land inside a building have no abutment | `groundedOnly` drops and counts them (`[V3-P3-G14]`) |

### Result, on the scene the app bakes

```sh
cd apps/web && npm run bake:cli -- --overpass ../../tests/fixtures/overpass-chicago-loop.json \
  --params ../../fixtures/print-params-parts.json --target generic-3mf --out ../../artifacts/parts-ingest.3mf
cd ../../services/bake && uv run python -m app.cli validate ../../artifacts/parts-ingest.3mf
```

**ALL CHECKS PASS in both modes**: parts (min_wall 0.7275, degenerate 0, 6 parts
/ 491 shells / union 1, part_meshes clean, 137,864 triangles) and single
(min_wall 0.7275, degenerate 0, bodies 1). One of the 780 ways is reported
through `bridge-unsupported`. Before this work the same file read min_wall
0.039, degenerate_faces 50 and union 12 bodies.

The committed Python-scene default bake is unaffected and still byte-identical
(section 7).

## 7d. A DRAPED bake through the reference validator

The team lead asked for this explicitly, and it earns its place: it finds
something the engine's own gate does not see.

```sh
cd apps/web && npm run bake:cli -- --scene ../../fixtures/chicago-scene.json \
  --params ../../fixtures/print-params-default.json --terrain demo \
  --target generic-3mf --out ../../artifacts/chicago-terrain.3mf
cd ../../services/bake && uv run python -m app.cli validate ../../artifacts/chicago-terrain.3mf
```

`--terrain demo` is a synthetic 60 m west-to-east ramp rather than a DEM fetch,
because a bake whose geometry depends on what a remote elevation service served
that minute is not a reproducible gate. `--terrain <grid.json>` takes a real
`fetchTerrainGrid` result for checking a specific place.

| check | parts mode | single mode |
|---|---|---|
| manifold | PASS watertight, consistent winding | PASS |
| watertight | PASS euler=2 bodies=1 | PASS |
| volume | PASS 2.293e+05 mm3 | PASS |
| bounding_box | PASS 180.000 x 180.000 x 37.876 mm | PASS |
| sits_at_zero | PASS 0 | PASS |
| **min_wall** | **FAIL 0.138 (3 of 394 sampled regions)** | **FAIL 0.146 (3 of 394)** |
| triangle_budget | PASS 135,120 | PASS 64,512 |
| degenerate_faces | **PASS 0** | FAIL 4 |
| bodies | PASS union 1 | PASS 1 |
| part_meshes | PASS 6 parts, each clean | n/a |
| every 3mf_* row | PASS | PASS |

**The geometry is sound; the finding is real, and the engine now raises it.**
What the validator is measuring: a horizontal slice of a sloped model cuts
obliquely, so a groove wall that is a full wall thick measured across itself
presents as a sliver in plan. Parts mode shows the mesh itself is clean
(degenerate 0, union 1 body); this is a printability finding, not a broken
solid.

The engine used to be SILENT about it - `measureMinWall` reported 0.800 mm
(saturated) and raised nothing. Two terrain-only changes fixed that
(`[V3-P3-G16]`), both gated on `ctx.terrain` so no flat bake samples an extra
height and the committed golden cannot move:

1. **Slice heights.** `sliceHeights` picks feature PLANES, and draping smears
   each of them over a band as tall as the relief. `drapedSliceHeights` walks
   the union of those bands at a 0.05 mm pitch, capped at `MAX_DRAPED_SLICES`.
2. **The width rule.** The engine measured `inscribedWidthMm`, the widest disc
   that fits in a region; the reference reports `thicken.narrowest_width`, that
   number lowered by every appendage the `0.45 * min_wall` opening leaves. On a
   flat bake the two agree because Stage 1 removed every thin appendage in 2D;
   on a draped bake the oblique cut grows wings the 2D repair never saw.
   `narrowestWidthMm` mirrors the reference rule, and `residueParts` is exported
   from `repair.ts` so the gate and the repair find the same wings.

The engine now reports **0.096 mm across 2 regions** against the validator's
0.146 - stricter than the validator, which is the safe direction - as a
`wall-too-thin` error whose detail names the count, explains the oblique cut,
and whose one-click SAFE fix halves `terrain_exaggeration` (`[V3-P3-G17]`).
A draped bake costs 8.5 s against 6.0 s flat.

**What remains a limitation:** the model really does have those two sub-nozzle
places at 60 m of relief, and the engine reports them rather than removing them.
The repair-time mitigation the brief allowed - scaling `min_wall`/`min_gap` by a
slope factor - was deliberately not taken: the wings come from the oblique CUT,
not from the footprint the repair works on, so widening footprints does not
remove them, and an unvalidated threshold change on the draped path would trade
a measured limitation for an unmeasured one. The remedy the user is given (less
exaggeration) attacks the mechanism directly. Single mode also keeps 4 degenerate
faces from `refineToLength` splitting an already-intricate mesh;
`DRAPE_SIMPLIFY_MM` removes most, and parts mode reaches zero because each
region is refined on its own.

For completeness, the three FLAT runs beside it, all on the current tree:

| bake | min_wall | degenerate | bodies | verdict |
|---|---|---|---|---|
| committed fixture, single | 0.8746 | 0 | 1 | ALL CHECKS PASS |
| committed fixture, parts | 0.9096 | 0 | 6 parts, union 1 | ALL CHECKS PASS |
| ingested scene, parts | 0.7275 | 0 | 6 parts, union 1 | ALL CHECKS PASS |

The committed fixture's parts bake reads 0.9096 exactly as `[V3-P2-E2]`
recorded it, so the parts path itself never regressed: the failure the audit
caught was the ingested scene's 780 bridges, and only that.

## 8. Verify

```sh
cd apps/web && npx vitest run lib/engine lib/transform    # 439 passed, 28 files
cd apps/web && npx vitest run                             # 1061 passed, 61 files
cd apps/web && npm run typecheck && npm run lint          # both clean
cd services/bake && uv run pytest -q                      # 690 passed
cd services/bake && uv run pytest -q tests/test_transform.py   # 49 passed
```

Owned suites, per file:

| File | Tests |
|---|---|
| `lib/transform.test.ts` | 157 (7 matrix rows x 3, plus one new `it` in each of the 9 cases, plus the two new cases' share of the existing 12) |
| `lib/engine/solid/engine.test.ts` | 20 (was 17: Chicago trees, Chicago draped, Chicago as ingested) |
| `lib/engine/solid/terrain.test.ts` | 21 (new; 18 phase 3, 3 v3-02 audit regressions) |
| `lib/engine/terrain/tiles.test.ts` | 17 (new) |
| `lib/engine/solid/synthetic.test.ts` | 12 (the terrain hook case rewritten) |
| `lib/engine/solid/text.test.ts` | 7 (unchanged) |

Python parity: `tests/test_transform.py` 49 passed, of which five are new unit
tests on the curve (linearity and exactness at `curve = 0`, monotonicity and
continuity, short-over-tall, the inverse round trip, and the exaggerated
building top).

Regenerating the parity fixture (never hand-edit it):

```sh
cd services/bake && FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_transform.py
```

## 9. State at hand-off, and what is not done

- Nothing committed; all changes are working-tree. `next build` and Playwright
  were not run, per the brief.
- The whole-app `npm run lint` and `npm run typecheck` are clean as of this run.
  Five files outside this task's ownership had type errors mid-phase
  (`components/editor/groups/{BuildingsGroup,HeightsGroup,TerrainGroup}.tsx`,
  `lib/engine/protocol.terrain.test.ts`, `lib/previewText.test.ts`); the
  parallel UI agent fixed all five while this was in flight.
- **A draped bake still FAILS `min_wall` in the reference validator** (0.138 mm
  parts / 0.146 mm single, three of 394 sampled slice regions; single mode also
  keeps 4 degenerate faces). The engine now DETECTS and reports it - 0.096 mm
  across 2 regions, stricter than the validator - with a count, an explanation
  and a safe one-click fix that halves `terrain_exaggeration`, so nothing is
  silent any more (section 7d, `[V3-P3-G16]`, `[V3-P3-G17]`). What remains is
  that the geometry itself is not repaired: a level slice through a hillside
  cuts sloped grooves obliquely, and removing that needs a slope-aware repair
  the brief scoped as optional and I judged not worth an unvalidated threshold
  change. Terrain is off by default, so no default bake is affected.
- **Terrain is not in the preview's own path.** The engine drapes; whether
  `components/scene/*` renders the region meshes it gets back is the UI agent's
  side and was green when last checked.
- **Bridge piers.** Only END abutments are built, which is what the brief asks
  for. A long viaduct over water has an unsupported span between them; it is
  connected and printable, but a 60 mm bridge with no intermediate pier will sag
  in the middle. Intermediate piers need a "where is it safe to land one" rule
  (not in water, not on a building) that phase 3 does not have.
- **The drape refines to a fixed 3 mm.** Adaptive refinement (fine where the
  field is curved, coarse where it is flat) would cut the draped triangle count
  well below 195 k. `refineToLength` has no such mode, so it would mean
  subdividing by hand.
- **A tree is a marker, not a tree.** Truncated cone plus optional trunk, eight
  sides. Species, canopy variety and a proper crown are out of scope.
- `TREE_CAP` is 2000 and is `transform`'s, shared with the reference. At plate
  256 that is the binding constraint on Chicago, not printability.
