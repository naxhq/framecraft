# v3 Task 7 - geometry: the three nightly export-matrix defects

2026-09-02. Closes the three defects `docs/handoff/FAILURES.md` opened under
"nightly export matrix defects found by the Task 14 CI diet". Both nightly
scripts now pass end to end; no check, threshold or validator row was touched.

Files changed: `apps/web/lib/engine/solid/mesh.ts` (+ new `mesh.test.ts`),
`apps/web/lib/engine/export/stl.ts` (+ `stl.test.ts`),
`apps/web/lib/engine/solid/tiling.ts` (+ `tiling.test.ts`),
`services/bake/app/export/stl.py`. `solid/measure.ts`, `solid/manifold.ts` and
`pipeline/stages.ts` were read and not changed.

---

## The finding that runs through all three: a file is not a mesh

Two of the three defects have nothing wrong with the geometry. They are the
gap between the mesh the engine builds and what a **binary STL** can express,
and the reference validator judges the file, so the gap is the defect.

A binary STL is float32 and carries no vertex index. Two consequences, and
each is one of the defects:

| what the mesh has | what the file has | which rows go red |
|---|---|---|
| a triangle whose vertices are collinear to within a float32 step | a triangle of zero area | `degenerate_faces` |
| two distinct vertices at one point | one vertex, and an edge on four faces | `manifold`, `watertight`, `self_intersection` |

The second is not caused by rounding at all - the vertices are coincident in
double - but both are answered on the same grid, and both are invisible to the
3MF, which writes decimal text at twelve places (`export/common.VERTEX_DECIMALS`)
and keeps its own index.

**The grid is a property of the coordinate, and the exporter moves every
coordinate.** `placeInBuildSpace` translates the model so its minimum sits at
the origin, which on a plate centred at (0, 0) is +90 mm in x and y. The
Chicago needle sits at x = -0.033 mm in the engine frame, where one float32
step is 4e-9 mm and nothing collapses, and at x = 89.967 mm in the file, where
it is 7.6e-6 mm and the triangle vanishes. So the repair cannot live in the
engine: it runs in the STL writer, on the placed mesh. That is also why the
3MF is untouched and byte for byte what it was - it needs none of this.

---

## 1. `degenerate_faces` 1 on the Chicago STL, 0 on its 3MF

**Measured.** Both files carry 46 962 vertices and 93 920 triangles. Parsing
both and measuring every face:

| | double | float32 |
|---|---|---|
| faces under 1e-9 mm2 | 0 | 1 |
| faces under 1e-7 mm2 (`REPAIR_AREA_MM2`) | 0 | 1 |
| distinct vertices lost to a shared grid point | - | 0 |

The one face is triangle 49 182, three vertices of a single vertical edge at
(89.966697693, 145.642852783) with z 2.800048828, 3.0 and 3.5. Their x and y
agree to 1.8e-6 mm, so the triangle measures **6.184e-7 mm2** in double - six
times the repair threshold, which is why `cleanMesh` correctly left it alone -
and **0** once the coordinates are on the float32 grid, whose step at 90 mm is
7.6e-6 mm and at 145 mm is 1.5e-5 mm.

**Fix.** `mesh.ts` learns to measure a face the way a file will:
`float32Positions`, `float32DegenerateFaces`, and an `exportArea` measure (the
smaller of the double and the float32 area) that `cleanMesh` uses when it is
given `float32: true`. The existing repair ladder then reaches the needle with
the repair it was built for: `splitNeedles` resolves the T-junction, which
retires the needle and the neighbour holding its long edge and puts two
triangles in their place. No vertex moves and the triangle count does not
change. `export/stl.ts` calls this through `hardenForFloat32`, on the placed
mesh, for the single body and for every member of the parts zip.

**Result.** `degenerate_faces` 1 -> **0**, `ALL CHECKS PASS`. The report on the
real plate: 1 split, 0 welds, 0 pinches, volume delta 1.19e-9 mm3.

**What did NOT change.** The engine's default is `float32: false`, so the
Chicago mesh, the 3MF, every region hash and every committed golden are exactly
what they were: 46 962 vertices, 93 920 triangles in the merged mesh, 135 284
region triangles, `172 335 mm3`, two runs of the exporter byte-identical apart
from the zip timestamp. The STL and the 3MF now differ in two triangles of
93 920 - the pair the split retired and the pair that replaced them - and that
difference is the defect being fixed, in the only file that has it.

---

## 2. `--tiling 2x2`, tile A1: `min_wall` 0.037 mm and one water debris shell

Two independent causes; the tile fails both rows and neither explains the other.

### `min_wall` 0.037 mm - a needle the sliver cutter stranded

**Measured.** Six of 176 sampled regions under 0.72 mm, all the same region at
six different heights: a slice island of **0.00535 mm2** spanning
0.0479 x 0.238 mm at build-space (73.337, 6.113), standing from z 6.35 to at
least 20.67. In the untiled build of the same parameters that place holds one
whole block of 50.39 mm2 from y 96.69 to 107.70 (engine frame). The tiling took
a 1.64 mm band out of the middle of it and left the southern tip behind.

The band is the sliver cutter's own work: it is one prism through the tile, so
what it removes at the height where it found a thin rind it also removes at
every other height, and 14 mm up that band cuts a building in two.
`SLIVER_PASSES` exists to catch exactly this on the next pass - and could not,
because `thinPart` dropped any whole component under `SLIVER_MIN_AREA_MM2`
(0.01 mm2) before asking whether a wall fits in it. Its comment claimed that
floor was "below anything a printer or the reference validator can see". The
validator has no area floor for a region: `checks._min_wall_probe` measures
every region a slice holds and fails it under `0.9 * min_wall`. A gate that
sees less than the judge is not a gate.

**Fix.** The whole-component floor is gone from `thinPart`; `holdsNoDisc`
decides, which is the validator's own rule. The floor survives where it is
cheap and can hide nothing: on the GROWN cutter and on the band-clipped result
in `sliverCutter`.

**Result.** Tile A1 `min_wall` 0.037 -> **0.9379 mm**. All four tiles
`ALL CHECKS PASS`. The cost is 6.42 mm3 more seam trim (2510.35 -> 2516.77,
+0.26 %), which the `tile-seam-trimmed` finding reports as it always did.

### `bodies` - a 0.000458 mm3 splinter of water

**Measured.** Tile A1's water part: 3 shells, smallest **0.000458 mm3**, a
0.064 x 0.017 x 1.2 mm splinter at (86.519, 59.542, 1.300) to (86.582, 59.559,
2.500). The validator's `bodies` row reports "debris shell(s): water".

The region solids arrive already pruned from `pipeline/stages.ts`'s finish
stage, but a tile is five booleans past that - two trims per axis, the keys
unioned in, the sockets and the sliver cutter taken out - and any of them can
shear a chip off and leave it floating. Nothing pruned again after the cut.

**Fix.** `buildTile` sweeps every tile solid (each region and the merged one)
with `pruneDebris` at the shared `manifold.DEBRIS_MM3` = 0.01 mm3, which is the
validator's own `MIN_PART_BODY_VOLUME_MM3`, so the two cannot disagree about
what a speck is.

**Result.** 116 shells with one debris shell -> **114 shells, no debris**.

---

## 3. Paris, Tokyo and London: the STL fails `manifold`, `watertight` and `self_intersection`

**The premise in the original note was wrong twice, and measuring first is what
found it.**

First, these files are not written by the browser engine. `ci-preset-matrix.sh`
bakes every preset through the REFERENCE pipeline
(`python -m app.cli bake --preset <id>`, which writes the `.3mf` and the `.stl`
beside it); its `--overpass` browser call is Chicago-only, by design, because
`export-cli.ts` hard-codes `DEMO_CENTER`. So the writer at fault is
`services/bake/app/export/stl.py`.

Second, float32 rounding does not create the coincidence. It only exposes it.

**Measured**, Paris, parsing the `.3mf` and the `.stl` of the same bake:

| | 3MF | STL as the validator reads it |
|---|---|---|
| vertices | 53 016 | 53 015 |
| triangles | 106 028 | 106 028 |
| faces under 1e-9 mm2 | 0 | 0 |
| directed edges without exactly one twin | 0 | **2** |

One vertex is lost, and it is not a rounding artefact: 3MF vertices 7246 and
7247 are at exactly the same point (-19.079999998212, -77.350000001490,
4.649760, written `%.12f`), and both are joined to vertex 6540 directly below
them at z 3.770653. Two building corners touching along a vertical edge, which
is how a manifold mesh represents a surface that touches itself. The 3MF is
indexed and carries it; a binary STL is a triangle soup, and `app/cli.py`'s
`_index_stl_triangle_soup` recovers the index by welding identical float32 rows
(bitwise, never a tolerance), which merges the pair and hands the edge to four
faces.

**No weld can repair this, and `assemble.finalize` never sees it.** Traced on
the Paris bake by spying on `_is_clean`:

| `finalize` pass | vertices | lost to float32 | of those, exact duplicates | degenerate float64 / float32 | verdict |
|---|---|---|---|---|---|
| entry | 53 035 | 10 | 1 | 7 / 19 | not clean |
| after `simplify` | 53 019 | 4 | 1 | 1 / 6 | not clean |
| after one weld rung | 53 016 | 1 | 1 | 0 / 0 | **clean** |

The ladder does its job on everything float32 rounding creates and stops with
the one pair that was coincident before any rounding. `_is_clean` calls that
clean because `float32_defect_count` scores
`len(unique(vertices)) - len(unique(quantised))`, and a pair that is already
ONE row of `unique(vertices)` contributes nothing to that difference by
construction. Widening that counter would not close the defect anyway: welding
the pair produces the same non-manifold edge, made explicit, and
`Manifold(Mesh64(...))` will not import it - it would only make `finalize` try
four rungs and reject all four on every bake that has a pinch.

**Fix.** The file is made to say what the mesh says, to the finest the format
has. `separate_float32_pinches` gives every vertex a grid point of its own: the
second vertex of a colliding group moves ONE float32 step at the model's own
scale - 1.5e-5 mm on a 180 mm plate, four orders of magnitude under the print
grid and the smallest move the format can express - into its own material,
against its area-weighted vertex normal and along that vector's dominant axis.
Nothing is welded, no face is added or dropped, and a mesh with no colliding
pair is written byte for byte what it was. `mesh.separateFloat32Pinches` is the
mirror in the browser engine, reached through `hardenForFloat32`.

**Counts.** Paris 1 pinch, Tokyo 1, London 2, Chicago 0, New York 0, San
Francisco 0 - which is exactly the three presets that failed.

**Result.** Paris `.stl`: `manifold`, `watertight`, `self_intersection` red ->
**`ALL CHECKS PASS`**, 53 016 vertices preserved, 0 open edges, volume
1.228e+05 mm3 unchanged. All six presets pass on both files;
`PRESET-MATRIX PASS`.

---

## Verification

| check | result |
|---|---|
| `sh scripts/ci-export-matrix.sh make` | EXPORT-MATRIX PASS (7 targets, 6 validated, 3 structure-checked) |
| `sh scripts/ci-preset-matrix.sh make` | PRESET-MATRIX PASS (6 presets, `.3mf` and `.stl` each, plus the browser Chicago) |
| `sh scripts/gate-web-engine.sh make` | ALL CHECKS PASS, both modes, rc 0 |
| `npm run lint` | clean |
| `npx tsc --noEmit`, `lib/engine/**` | 0 errors |
| `npx vitest run lib/engine` | 618 of 620 passed, 0 skipped |
| `services/bake` STL, validator-CLI and QA tests | 74 passed |

The two vitest failures are `lib/engine/pipeline/matrix.test.ts`'s
`frame_style.lip_depth_mm` and `regions.rail.width_m`, which the test itself
labels KNOWN DEFECT against `docs/handoff/v3-01-matrix.md` and which live in
`solid/frame.ts` and `solid/roads.ts`. Neither file was touched here.

**Timing.** No budget was changed. `engine.test.ts` passes 20/20 in isolation.
Under the load this host was carrying while several agents built at once, the
draped Chicago case measured 15.5 s, then 38.9 s, then 47.1 s against its 15 s
budget, so it was measured A/B instead, three runs each, alternating: HEAD's
`mesh.ts` 11 726 / 13 485 / 13 415 ms, this tree's 11 682 / 11 566 / 11 035 ms.
This wave adds no measurable cost to a bake, which is what it should do: the
engine's `cleanMesh` default is unchanged, and everything new runs in the
exporter.

## What is left

* The float32 measure is available to the engine (`cleanMesh`'s `float32`
  option) and is used only by the STL writer. If the 3MF ever moves to a
  coarser written precision, the same option is where that repair goes.
* `separate_float32_pinches` treats the symptom in the file. The pinch itself -
  two building corners meeting along a zero-thickness vertical edge - is real
  geometry that no printability row currently measures. Whether a plate should
  ship one is a question for `04_PRINTABILITY_SPEC.md`, not for a writer.
* `assemble.float32_defect_count` cannot count an exactly-coincident pair, per
  the table above. That is not this wave's to change - it would alter
  `finalize`'s behaviour on every bake that has a pinch, to no benefit, since
  the weld it would then attempt is rejected by construction. It is written
  down here and in the function's own docstring so the next person measures
  before assuming the reference already handles this.
* The synthetic water-across-a-cut scene in `tiling.test.ts` is a cheap guard
  and did not on its own reproduce either tiling defect: four scene variants
  were built and measured on the pre-fix tree and the worst wall any of them
  left was a full 0.80 mm. The fixture that carries both is the real Chicago
  plate, so the discriminating assertions live in the "split four ways" case.
  Verified by reverting each half of the fix in turn: without the debris sweep
  it fails at "A1 water: smallest shell 0.000458 mm3", and without the
  `thinPart` change at "A1 at z 2.90: 0.0385 mm".
