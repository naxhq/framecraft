# v3-07 perf (Task 7: engine latency, and the two dead fields)

Written by the engine performance agent against `docs/handoff/v3-01-pipeline.md`
sections 4 and 10 (the measured stage split and the runner), the Task 0
baseline in `docs/handoff/v3-00-baseline.md` section c, and the two rulings
`[V3.1-P2-1]` and `[V3.1-P2-2]`. Every number below was measured on this host
(Windows 11, Node through `vite-node`, the Chicago fixture) in the same session,
before and after, with the same scripts. Other agents were running vitest on
the machine for part of the session; each table says what the load was.

## 1. The profile before

`FRAMECRAFT_PERF=1 npm run export:cli` on `fixtures/chicago-scene.json`,
`fixtures/print-params-default.json`, target `bambu-3mf`, one cold run, tree at
`af02c98` (8 other node processes alive, none building):

| stage or row | ms |
|---|---|
| `engine.build` | 5126 |
| `phase.geometry` | 974 |
| `surface-roads` | 543 |
| `surface-parks` | 165 |
| `repair-buildings` | 98 |
| `attribution` | 93 |
| `phase.region` | 1142 |
| `sit` (the base carve, evaluated lazily here) | 270 |
| `finish-base` | 300 |
| `finish-buildings` | 242 |
| `finish-roads` | 204 |
| `finish-frame` | 58 |
| `finish-parks` | 52 |
| `finish.prune` (six regions) | 113 |
| `mesh.clean` (seven calls: six regions and the merged solid) | 2586 |
| `mesh.double` | 68 |
| `mesh.order` | 40 |
| `phase.audit` | 3009 |
| `assembly` | 519 |
| `merged` | 2031 |
| `measure` | 447 |
| `export.bambu-3mf` (writer) | 337 |
| CLI wall, process start to exit | 5470 |

Half of the build was `cleanMesh`. Per mesh (a scratch script calling
`cleanMesh` on each finished region's solid and on the merged solid, each rung
of the ladder separately):

| mesh | vertices | triangles | degenerate at 1e-7 | rung that clears | ladder ms |
|---|---|---|---|---|---|
| base | 27 176 | 54 348 | 345 | 1e-6 (weld 114, split 117) | 501 |
| frame | 8 848 | 17 696 | 0 | none needed | 2 |
| buildings | 10 217 | 19 486 | 128 | 1e-6 (weld 52, split 28) | 138 |
| roads | 16 574 | 34 636 | 72 | 1e-6 (weld 30, split 16) | 260 |
| water | 980 | 1 920 | 8 | 1e-6 (weld 4) | 13 |
| parks | 4 060 | 7 456 | 12 | 1e-6 (weld 6) | 47 |
| merged | 47 022 | 94 040 | 260 | 1e-4, after 1e-6 leaves 2 and 1e-5 leaves 1 | 2253 |

So the regions were one rung each and the merged solid walked all three, and a
rung on the merged solid cost 740 to 1370 ms. Inside a rung the cost was three
string-keyed structures: `weld`'s 27-cell grid scan built a template string
per cell per vertex (27 per vertex), `splitNeedles` built a `Map<string,
number>` over every directed edge of the mesh (3 per triangle, 282 000 on the
merged solid) to answer a lookup for the 260 needles, and `openEdges` ran a
`Map<number, number>` over the same 282 000 edges after every weld and every
split pass. None of the geometry was the cost.

The candidates the brief named, confirmed or ruled out:

- Rungs that change nothing: confirmed as a symptom, not the cause. On every
  region the first rung clears the mesh and the loop stops. On the merged
  solid all three rungs are needed (the coarsest is the one that clears it),
  so there was no rung to skip; each rung was simply slow.
- The merged solid rebuilt from primitives when the finished regions exist:
  ruled out. `assembly` is the reference recipe by ruling `[V3-P3-G7]` (the
  additive primitives unioned, only the visible part of each recess subtracted)
  and a union of the finished regions would carry every seam sliver into the
  export; it is 519 ms in the audit phase and gates nothing the preview shows.
- `pruneDebris` decomposing twice: ruled out; `pruneDebrisCounted` already made
  it one decomposition. What that one decomposition cost was 85 ms on the
  buildings region and 65 ms on the Overpass-path roads region, because
  `decompose()` copies every body into a Manifold of its own to count them.
- Per-polygon Clipper2 calls that could be batched: ruled out. Sub-rows added
  to `repairFlatLayer` show the roads layer is one union of its 6 000 ribbon
  primitives (393 ms over the three layers), one closing pair (102 ms) and a
  handful of whole-layer booleans; nothing is per polygon.
- The drape refining edges it does not need: not on this path, the Chicago
  fixture is flat.
- `measure`'s slice list: sub-rows show 15 slices, 30 `slice()` calls for
  99 ms, and 245 ms in the persistence intersect (66 calls of a small region
  against the whole unsimplified slice above). It is in the audit phase and
  left alone; the exact speed-up available is to decompose the slice above once
  per height and intersect each thin piece with the components whose boxes it
  overlaps, which changes the area sum only in the last bit of a double.

## 2. What changed, and why each was the real cost

All in `apps/web/lib/engine/solid/mesh.ts` unless said otherwise. The output of
`cleanMesh` is the same mesh to the last index and the same report to the
last digit: a scratch script ran the committed `mesh.ts` beside the new one on
every Chicago region and the merged solid, for the ladder, each single rung,
`weld: false`, `float32`, `collapseNeedles` and `hardenForFloat32`, 56 cases,
all identical.

1. **`weld` finds its pairs with a sort and a sweep** (`vertexPairs`), once per
   `cleanMesh` at the ladder's coarsest rung, and each rung filters the list by
   its own epsilon. The old scan was 27 template strings and 27 `Map` lookups
   per vertex; almost every vertex of a boolean result has no neighbour within
   a tenth of a micrometre, and a sweep along x pays for those only when the
   next vertex is already too far away. The choice of representative when
   several kept vertices qualify is reproduced exactly: the old scan met cells
   in dx, dy, dz order and a cell's bucket in insertion order, so the winner is
   the smallest (cell rank, kept index) pair, computed from the same
   `floor(coordinate / epsilon)` cells.
2. **`splitNeedles` indexes only the edges a needle can ask about.** A needle
   looks up exactly one directed edge, the twin of its longest edge; the pass
   now collects those keys first and indexes the mesh's edges against that set
   (numeric keys, `a * 2^32 + b`, the same key `openEdges` always used). The
   owner of an edge is still the last triangle that carries it.
3. **`openEdges` counts in typed arrays** (`EdgeCounts`, open addressing over a
   `Float64Array` of keys and an `Int32Array` of counts). Same keys, same
   counts, same definition of a bad edge.
4. **Perf rows** under `mesh.clean`: `mesh.clean.pairs`, `.weld`, `.split`,
   `.check`; under the surface repair: `surface.union`, `.close`, `.subtract`,
   `.clip`, `.simplify`, `.decompose`, `.printable`, `.reunion`, `.clean`; under
   the min-wall measurement: `measure.slice`, `.simplify`, `.decompose`,
   `.erode`, `.persist`, `.width`. No-ops with perf mode off.
5. **`pruneDebrisCounted` counts bodies off the mesh** (`manifold.ts`,
   `bodiesFromMesh`) when every body is at least ten floors above the debris
   floor: a union-find over the triangle edges of `getMesh()`, which is the
   same vertex graph `Manifold::Decompose` splits, so the count is exactly
   `decompose()`'s (checked on both Chicago scenes, 14 solids, every count
   equal). Volumes on that path are summed from the float32 read-out, so any
   body near the floor, and any inverted shell (the Overpass-path roads region
   carries one at -0.88 mm3), sends the call to the exact decomposition as
   before, whose numbers are the ones the findings print.
6. **`doublePositions`** (`manifold.ts`) compares the exact read-out against the
   float32 array directly and builds the widened copy only on the path that
   returns it.

Nothing moved from the region phase into the audit phase. The two candidates
(`canonicalMesh`'s ordering and the repair itself) are part of the region mesh
the preview receives, the region hash stands for, and the exporter writes; a
region streamed unordered or unrepaired and fixed at export time would be a
different object from the one on screen, and `triangleOwner` would have to be
permuted with it. At 36 and about 50 ms across the six regions after the
rewrite, neither was worth the protocol change.

## 3. After

### The export, cold

Same command, same tree apart from this wave's changes (four other node
processes alive, idle):

| row | before ms | after ms |
|---|---|---|
| `engine.build` | 5126 | 2797 |
| `phase.geometry` | 974 | 957 |
| `phase.region` | 1142 | 525 |
| `mesh.clean` (seven calls) | 2586 | 355 |
| `finish.prune` (six regions) | 113 | 13 |
| `phase.audit` | 3009 | 1314 |
| `merged` | 2031 | 314 |
| CLI wall | 5470 | 3170 |

The Task 0 baseline for the same export was 13 418 ms wall (median of three)
from the Export button to the download link in the browser, which included a
full rebuild in the worker; this session's like-for-like number is the CLI
wall, 5470 ms before and 3170 ms after, a 42 per cent cut in the
same process on the same host. Against the 13.4 s figure it is
76 per cent faster, with the caveat that the two were measured
in different processes.

### The eight warm changes

Node, one `StageCache`, `runPipeline` with `regionBatchMs: 0`, the default
parameters plus one frame-edge `{city}` line, every change measured from the
same warm default (the scratch harness resets to the default between changes).
"Before" is `docs/handoff/v3-01-pipeline.md` section 4, measured on this host
by the pipeline wave. The after numbers are the last of three runs of the
harness, taken with four other node processes alive; the five cheap changes
agreed to within 20 ms across the runs, but the three heavy ones did not
(`road_mode` 1076, 1349 and 1133 ms to the preview; `plate_mm` 1586, 1571 and
1574; `heights.floor_height_m` 2215, 2430 and 2359, with `normalise` alone
reading 492, 505 and 570 ms), so the machine was not quiet and the heavy
numbers carry about a quarter of a second of noise. The first run predates the
body-count change in section 2 (item 5).

| change | to preview before | to preview after | to done before | to done after | target |
|---|---|---|---|---|---|
| `engravings[0].text` | 118 | 74 | 4600 | 1464 | 400, met |
| `north_arrow.enabled` | 75 | 63 | 4600 | 1406 | 400, met |
| `frame_style.profile` (plain to chamfer) | 355 | 159 | 5000 | 1494 | 400, met |
| `colour.region_colors.buildings` | 312 | 102 | 4700 | 1703 | 400, met |
| `hanger` (none to keyhole) | 210 | 163 | 4700 | 1659 | 400, met |
| `road_mode` | 2053 | 1133 | 6600 | 2512 | 2000, met |
| `plate_mm` (180 to 200) | 2937 | 1574 | 5300 | 2878 | 2000, met |
| `heights.floor_height_m` (Overpass path) | 3983 | 2359 | 10300 | 4401 | 2000, missed |

Cold, fixture scene: 1466 ms to the last region, 2746 ms
to done (was 2500 and 7000). Cold, Overpass path from the committed response:
2803 ms to the last region, 4886 ms to done (was 4400 and 10 600).

### The one miss, with its split

`heights.floor_height_m` re-runs `normalise` from the cached response and then
everything, on the Overpass-shaped scene, which carries the rail layer and the
bridge decks the fixture scene does not. To the preview after this wave:

| stage | ms |
|---|---|
| `normalise` | 570 |
| `surface-roads` | 475 |
| `finish-roads` (bridge decks unioned in; the decompose is exact here because of the inverted shell) | 350 |
| `sit` (the base carve) | 285 |
| `bridges` | 200 |
| `surface-parks` | 158 |
| `finish-buildings` | 71 |
| everything else | 250 |
| to the last region | 2359 |

What would be needed: about 360 ms more on this run, 215 ms on the quietest of
the three (2215 ms to the preview, with `normalise` at 492). `normalise` is
`lib/engine/osm`, outside this wave's ownership, and is a quarter of the path;
the rest is Clipper2 (the ribbon union and the closing pair of the roads layer)
and one manifold3d boolean (the plate against the pocket prisms), neither of
which has an exact shortcut left in JavaScript. The two levers are a faster
normaliser and the roads union, in that order.

## 4. Part B: the two dead fields

### `regions.rail.width_m` (`[V3.1-P2-1]`)

`solid/roads.ts:railWidthGroundM` now reads the parameter only:
`max(regions.rail.width_m * road_scale, min_wall_ground)`. The way's own
`width_m` stays on the `RailWay` type and in the scene (the normaliser's
per-type table is SceneGraph data) and is not read by the geometry; the
function no longer takes the way. Both callers (`surface-rail` and the bridge
decks) go through it. The matrix probe (3 m asked where the way carries 6 m,
the ribbon must narrow by exactly 3 ground metres) is green.
`terrain.test.ts`'s rail test asserted the opposite of the ruling (a wider WAY
printed wider); it now asserts a wider way prints the same and a wider
parameter prints wider, with the ruling as the reason.

### `frame_style.lip_depth_mm` (`[V3.1-P2-2]`)

- **Geometry** (`solid/frame.ts`): `buildFrameLip` subtracts
  `buildSightEdgeRebate`, a band `FRAME_SIGHT_EDGE_MM` (1.0) wide along the top
  slab's inner edge from `lip_depth_mm` below the lip top up past it, on every
  profile and corner style, 0 meaning a flat lip. The depth is clamped to the
  lip's height (`transform.lip_rebate_depth_mm`, the same rule on both sides)
  and a value past it is reported (`frame-feature-clamped`, info). The cutter
  overshoots into the opening so it never shares a face with the wall it cuts.
  On a styled corner the rebate's outer edge keeps the opening's own radius
  rather than growing it by the band's width, exactly as the lip's outer and
  inner corners share one radius: that is what keeps the frame's volume
  independent of the corner style, which the `frame_style.corner` and
  `corner_radius_mm` probes pin to a nanolitre (a concentric rebate moved it
  by 2.6 and 4.5 mm3 and turned both red).
- **The flat face**: `frameTopFaceSection` and `topFaceWidthMm` exclude the
  rebate, so lettering, ornaments and the face texture clip to the 5 mm face;
  `reportNarrowTextBand` compares against `lip_face_width_mm` so only a
  profile, never the rebate, raises the narrowed-band warning.
- **The layout keeps clear** (`lib/transform.ts` and
  `services/bake/app/geom/transform.py`, mirrored): `FRAME_SIGHT_EDGE_MM`,
  `LIP_DEPTH_DEFAULT_MM`, `lip_rebate_depth_mm`, `lip_face_width_mm`;
  `edge_band_mm` is the flat face less the margin each side (4.0 mm at the
  defaults, was 5.0), `edge_band_center_mm` and the north arrow's corner
  square sit on the flat face (2.5 mm in from the outer edge, was 3.0), and
  the arrow's reduction warning names the face width. Both parity fixtures
  were regenerated from the Python side (`FRAMECRAFT_WRITE_PARITY=1`):
  `fixtures/lettering-expected.json` moved (every case with frame text),
  `fixtures/parity-expected.json` came back byte-identical; the TS suites
  assert against them and pass. Consequences a user will see: an
  auto-fitted frame line is 20 per cent smaller (the default `{city}` line on
  a 180 mm plate goes from 4.28 to about 3.4 mm), the north arrow's cap is
  3.43 mm (was 4.29, so a 4 mm arrow is now reduced with the warning), and an
  embossed "Chicago" no longer fits the default lip (its counters close at
  the 3.62 mm the band allows). Six Python lettering tests that pinned the
  5 mm band were updated with the ruling as the reason (the corner offset,
  the arrow cap and its warning text, and three strings that no longer fit
  in emboss or serif on the narrower band).
- **The attribution band starts below it** (`solid/attribution.ts`):
  `frameInnerWalls` ends the exposed wall at `top - lip_depth_mm`, so the
  mark is fitted to and centred in the wall under the step (1.36 mm text on
  the default, was 1.78). `WALL_MARK_MIN_HEIGHT_MM` is now
  `FRAME_LIP_MM - LIP_DEPTH_DEFAULT_MM` (1.6 mm): the plain lip's exposed
  wall at the default rebate, in place of the 2.0 mm `[V3-P7-A5]` set as the
  plain lip's full wall. At the default this keeps A5's classification
  (bevel_in, floating at 1.2 mm and a separate frame at 1.4 mm still fall back
  to the second underside mark); a rebate deeper than 0.4 mm takes the plain
  lip under it too, and a flat lip lets a floating or a separate frame carry
  the mark as well. The no-wall finding and the skipped line now say when the
  rebate is what shortened the wall.
- **Goldens moved, with this ruling as the reason.** The default frame volume
  on the 180 mm plate goes from 9159.31 to 8900.74 mm3, a 258.57 mm3 drop:
  270.40 mm3 of rebate (`4 * (85^2 - 84^2) * 0.4`) less 11.83 mm3 the smaller
  wall mark no longer cuts (15.81 mm3 of mark on `frame.test.ts`'s date, 16.16
  on `synthetic.test.ts`'s, 27.6 and 28.08 before). Updated: `frame.test.ts`
  (the default build, the top-face widths, the corner test's face area, plus
  a new check that the rebate floor is a ring from 84 to 85 mm and nothing
  else sits on that plane), `synthetic.test.ts` (the empty scene),
  `attribution.test.ts` (the threshold is the wall under the default rebate).
  On the Chicago export the gate's numbers are in section 5.

## 5. Validator results

`sh scripts/gate-web-engine.sh make`, this tree, both modes: **ALL CHECKS
PASS**. Single mode: watertight (euler 2, bodies 1), volume 1.721e5 mm3,
min_wall 0.8746 against 0.72, degenerate_faces 0, bodies 1. Parts mode:
watertight, volume 1.722e5 mm3, min_wall 0.9379, degenerate_faces 0, six parts,
462 shells, union 1, part_meshes 133 804 triangles each manifold and
watertight. The engine's own suites: `parity`, `incremental`, `engine`,
`synthetic`, `frame`, `terrain`, `tiling`, `attribution`, `stl`, `mesh`,
`text`, `ornaments`, `lettering`, `previewText`, `bambu3mf`, `generic3mf`,
`obj`, `step`, `colorchange`, `graph`, `client` all green;
`services/bake`: `test_lettering`, `test_transform`, `test_bake`,
`test_tokens`, `test_contracts`, `test_v1_compat` all green (409 and 99).

## 6. The matrix readings the rebate changed

Ten probes went red when `[V3.1-P2-2]` landed on a probe table written for a
rebate-free lip, and the orchestrator ruled that this wave owns those readings
in `lib/engine/pipeline/matrix.probes.ts` on one standard: every edited
reading asks the same physical question about the same field, more precisely,
and still fails if the field stops working. Nothing in the geometry could make
them green, for two reasons that are both the contract's own defaults: the
default engraving depth and the default rebate depth are both 0.4 mm, so a
lettering pocket's floor and the rebate's floor share a plane, and the
mandatory inner-wall attribution's glyphs occupy the opening's walls between
z 3.15 and 4.45 mm on every default lip (3.15 to 4.85 before the rebate, so
the pre-rebate lip already had 88 vertices on the plane the lip probe asks to
be empty; the line was never reached because the volume line failed first).

| probe | reading before | reading after | why |
|---|---|---|---|
| `frame_style.lip_depth_mm` | `ringAt` over the whole plane: a ring at `top - 0.4` before (count over 0), none at `top - 1.5` before (count 0), a ring at `top - 1.5` after that is 1.00 mm wide; the volume line | `cornerRingAt`: the same four reads restricted to the plate's four corner squares (vertices at least `innerHalf - 1` from the centre on BOTH axes), plus a fifth, that the default's floor at `top - 0.4` is gone after; the volume line unchanged, on the preview and the file | the rebate floor's vertices are its eight corners, all inside the corner squares; the attribution glyphs sit at the opening's half-width on one axis and inside it on the other, so both axes have to be banded (an x band alone keeps the east and west walls' glyphs). The count at `top - 1.5` read 328 whole-plane. |
| `engravings[].edge`, `engravings[].align` | `pocketFloor` and `filePocketFloor`: the extent of every vertex on the pocket floor's plane | on the frame, the extent of the vertices on the lip's flat face: `max(abs x, abs y)` at least `innerHalf + FRAME_SIGHT_EDGE_MM + LIP_TEXT_MARGIN_MM / 2` (85.25 mm on the 180 mm plate); other regions unchanged; every threshold unchanged | the rebate floor's corners at 84 and 85 mm entered the extent and every pocket read 170 mm wide and from -85 to 85. Ink is laid out on the flat face and never on the rebate, so the banded read is the pocket and nothing else. |
| `engravings[].font`, `place.country`, `place.state`, `place.neighbourhood`, `place.author` | `letteringSpan`: `extentAtZ` with a y half-plane window picking the edge | the same half-plane window, over the flat-face vertices only; every threshold unchanged | as above |
| `engravings[].size_mm = 7` | before reports 4.0; after reports over 6 | before 4.0; after strictly over 4, strictly under 7, and 5.41 to two decimals (`BAND_LIMIT_BLOCKTON_SANS_MM`, the fit of "Blockton" in sans to the 4 mm band) | the 5 mm band held this string at over 6 mm; the 4 mm band holds it at 5.41. A regression that stopped honouring `size_mm` (still 4), stopped clamping (7) or clamped to another band all fail. |
| `north_arrow.size_mm = 2` | before (a 6 mm request) reports over 4; after 2 | before reports 3.43 to two decimals and equals `transform.north_arrow_max_size_mm`; after 2, strictly under before | the arrow's cap on the 4 mm band is 3.43 mm (4.29 on the 5 mm band) |

With those readings every probe in the matrix passes on the current tree, and
both `KNOWN_DEFECTS` rows were deleted from `matrix.probes.ts` (the map is
empty), since `lib/controlCatalog.test.ts` reads it to refuse a control for a
field it names and the panel wave is shipping the rail width slider; that
test's "not vacuous" line, which asserted the lip row was present, is the
settings owner's to drop with the slider (`[V3.1-P2-6]`).
`lib/engine/export/tiles.test.ts`'s single-plate byte hash was re-pinned on
this tree with both causes named in its comment: the rebate (the frame mesh)
and the `schema_version` 4 default another wave put into `contracts.ts`
during the session (the Description metadata); the writer is untouched. The
same table is appended to `docs/handoff/v3-01-matrix-audit.md` as section 7.

## 7. Lines for DECISIONS.md (the orchestrator appends; this agent does not edit it)

- [V3.1-P7-13] The four surface stages, `bridges` and `trees` are keyed on
  `normalise#ground` (a content hash of the scene's bounds, centre, roads,
  rail, water, green and trees) and `repair-buildings#footprint` (a hash of
  the footprint union's polygons) instead of the whole scene and the whole
  repair, because `heights.*` moves a building's height and nothing outside
  `buildings` and `stats`, and the footprint union reads no height. A stage
  keyed on a scene part is handed a view of the scene whose other layers
  throw on read, so the digest stays honest by construction.
- [V3.1-P7-14] `normalise` projects a fetched response once
  (`osm/normalize.ts:projectOverpass`, every layer with the buildings'
  heights deferred as a `HeightPick`) and applies `PrintParams.heights` per
  run (`sceneFromProjected`); the projection is memoised on the `fetch`
  output object and lives exactly as long as that cache entry. Output is
  byte-identical to the one-pass normaliser at every rule set checked.
  `heights.floor_height_m` on the Chicago Overpass path went from 2359 ms
  (2668 on this host today) to about 210 ms to the preview.
- [V3.1-P7-16] `surface-overrides` is keyed on `normalise#overrides` (the
  ground digest plus a hash of every building's `id` and `osm_id`) and on
  `repair-buildings#footprint`, and its scene view exposes the buildings cut
  down to those two fields; an override region is keyed on
  `buildings#overrideBands` and the finish of every building-bearing region
  on `buildings#ownerIds`, a hash of the sorted owner ids rather than of the
  kernel's per-run original ids. With one coloured road,
  `heights.floor_height_m` is 216 to 227 ms to the preview against 2674
  before, the same 36 stages as without the override.
- [V3.1-P7-17] A stage keyed on a named part of any input is served that
  part alone (`runner.inputPartView`, `stages.PART_EXPOSURE`, the rest of
  the record behind getters that throw), the way a scene part already was;
  a part with no exposure listed is served whole and the table says so.
  `digestOf` sizes a plain-data output with a bounded walk before it
  serialises, so a scene or a raw response over the digest limit is never
  serialised only to be discarded. The projection's five ground arrays are
  frozen, shallow, so the one place they are shared by reference (every
  scene built from one projection, and the page in the no-Worker transport)
  cannot be edited through any of them.

- [V3.1-P7-7] `cleanMesh` finds coincident vertices with one sort and a sweep
  (`mesh.vertexPairs`, built once per call at the ladder's coarsest rung and
  filtered per rung), indexes only the directed edges a needle can ask about,
  and counts open edges in typed arrays. The output is the same mesh to the
  last index and the same report to the last digit, checked against the
  committed implementation on every Chicago region and the merged solid across
  every option; the merged solid's repair went from 2253 to 277 ms and the
  Chicago export's engine time from 5.1 to 3.0 s. The ladder is unchanged:
  every rung still starts from the kernel's mesh.
- [V3.1-P7-8] `pruneDebrisCounted` counts bodies with a union-find over
  `getMesh()`'s triangle edges when every body is at least ten debris floors
  up, which is exactly `Manifold::Decompose`'s vertex graph; any body near the
  floor or of negative volume goes to the exact decomposition as before, so
  every number a finding prints is still manifold3d's.
- [V3.1-P7-9] The sight-edge rebate's outer edge keeps the opening's own
  corner radius on a mitred or rounded frame, as the lip's two edges do, so
  the frame's volume does not depend on the corner style; a concentric step
  moved it by 2.6 mm3 at radius 3 and 4.5 mm3 at radius 9.
- [V3.1-P7-10] `WALL_MARK_MIN_HEIGHT_MM` is the plain lip's exposed inner wall
  at the default sight-edge rebate, `FRAME_LIP_MM - LIP_DEPTH_DEFAULT_MM` =
  1.6 mm, superseding the 2.0 mm of [V3-P7-A5] for the same reason A5 gave:
  the plain lip qualifies exactly, and the profiles A5 named still fall back.
- [V3.1-P7-11] The lettering band is the lip's flat face less the text margin
  each side: 4.0 mm at the defaults. The layout, the ornaments and the north
  arrow's corner square are sized and centred on that face in both mirrors,
  and the parity fixtures were regenerated for it.
- [V3.1-P7-12] A matrix reading of a plane on the frame is banded to the
  feature it asks about: the lip's flat face for a lettering or ornament
  pocket, the plate's corner squares for the sight-edge rebate's ring. The
  default engraving depth and the default rebate depth are both 0.4 mm, so
  the two floors share a plane, and the mandatory inner-wall attribution's
  glyphs occupy the opening's walls, so a whole-plane count can never be
  empty there; the band is a hard boundary in plan, not a tolerance, and every
  threshold the probes asserted before is unchanged. The two size probes pin
  the 4 mm band's own limits (5.41 mm for "Blockton" in sans, 3.43 mm for the
  north arrow) between the default and the request, so a field that stopped
  working or stopped clamping still fails. `KNOWN_DEFECTS` is empty.

## 8. The one miss, closed (Task 7 close-out)

Section 3 left `heights.floor_height_m` at 2359 ms to the preview against
2000, with `normalise` a quarter of it and the roads union, the road finish
and the base carve most of the rest. Both halves turned out to be cache
misses rather than geometry, and neither needed `solid/**` to change.

**Why the stage graph did not skip it.** `normalise` claims `heights.*`,
correctly: the rules decide every building's height. So a storey-height
change re-ran the whole ingest, and because the scene is not plain data under
the digest limit its digest is its key, so every stage that lists
`normalise` as an input re-ran too. That included the four surface stages,
`bridges` and `trees`, none of which reads a building: they read the roads,
rail, water, green and trees, plus the repair's footprint union, which reads
no height either (`solid/repair.ts` step 4: the union of the closed, cropped,
widened components). And because a surface stage re-ran, its solids were new
handles, so `base`, `region-base`, `sit` and every ground region followed.

**What changed.**

1. **Two named part digests** (`pipeline/stages.ts`). `normalise#ground` is a
   content hash of `bounds`, `center`, `roads`, `rail`, `water`, `green` and
   `trees` (`SCENE_GROUND_LAYERS`; 5 to 10 ms on Chicago, `digest.ground`),
   and `repair-buildings#footprint` is a hash of the footprint union's
   polygons (2 to 4 ms, `digest.section`). `surface-water`, `surface-rail`,
   `surface-roads`, `surface-parks`, `bridges` and `trees` are keyed on those
   two instead of the whole scene and the whole repair. `surface-overrides`
   stays keyed on the whole scene, because `reportOverrides` walks the
   buildings' ids; with no overrides its output is plain data with a stable
   digest, so nothing under it moves.
2. **A stage keyed on a scene part sees only that part** (`runner.ts:
   scenePartView`). The runner hands such a stage a view of the scene with
   every other layer behind a getter that throws, naming the stage and the
   part. A part digest is honest only while the stage reads nothing outside
   the part; this makes a ground stage that starts reading `buildings` a
   failed run rather than a stale cache. The seeded-scene path stores the
   same part digests, so a job carrying a finished scene keys identically.
3. **`normalise` projects once per fetched response** (`osm/normalize.ts`).
   Measured with the new `osm.normalize.*` rows, the 646 ms ingest was
   `areas` (the water and green dissolve) 508, `classify` 45, `buildings`
   (hygiene steps 1 to 7) 37, `emit-roads` 24, and the height rules under
   5. `sceneFromOverpass` is now `sceneFromProjected(projectOverpass(raw,
   request), rules)`: the projection carries every building with a deferred
   `HeightPick` (a leaf is one element's tags; a merge from steps 6 and 7 is
   the members' picks with the outline areas the tie-break used, so the
   tallest member is chosen per run exactly as `mergeGroup` chose it), and
   the second half applies the rules and builds the stats. The stage keeps
   the projection in a `WeakMap` on the `fetch` output, so it lives exactly
   as long as the fetch entry and a new response projects again. Not a stage
   of its own: the stage list is what the HUD, the plan events and the
   protocol's test seams name, and none of them needs to know. Output is
   byte-identical: the JSON of both Chicago and New York at five rule sets
   (frozen, defaults, 4 m storeys, 1 m storeys with a 40 m default, six
   changed type defaults) matched the committed implementation exactly, and
   `normalize.test.ts` now pins that a rule change moves `height_m`,
   `min_height_m`, `is_tall` and `height_source` and no other field, and
   that the ground arrays are shared, not copied.

> Superseded by the quiet-host table in 8.1: the figures in the next two
> tables were taken with other agents' suites running and are kept as the
> record of that session, not as what ships.

**Measured**, same harness as section 3 (Node, one `StageCache`, the Chicago
Overpass fixture through `fetchImpl`, `regionBatchMs: 0`, defaults plus one
frame-edge `{city}` line, every change from a warm default, ms to the end of
the region phase and to `done`), on this host with 12 to 15 other node
processes alive the whole session (other agents running vitest), so every
number carries that load and the heavy rows read a third above section 3's:

| `heights.floor_height_m` | to preview | to done | stages run | normalise |
|---|---:|---:|---:|---:|
| this tree before the change | 2668 | 4787 | 58 | 669 |
| part digests only | 1012 | 4073 | 41 | 758 |
| part digests and the projection, three runs | 203, 234, 265 | 2421 to 2544 | 41 | 32 to 50 |
| the same, final tree, three runs | 206, 208, 223 | 2025 to 2133 | 41 | 31 to 37 |

The 41 stages that still run are the ones a height really reaches: `context`,
`heroes`, `repair-buildings` (94 to 124 ms, the largest), `buildings`,
`tokens`, `labels`, the building regions (`finish-buildings` 51 to 71) and
the audit phase. The ground, the plate, its seat and every ground region are
cached. `normalise`'s remaining 30 ms is the runner's own walk over the
1.4 MB scene for handles and plain-data checks, not the ingest.

The other seven, re-measured on the final tree in the same session
(one run each, this load):

| change | to preview | target |
|---|---:|---|
| `engravings[0].text` | 88 | 400, met |
| `north_arrow.enabled` | 66 | 400, met |
| `frame_style.profile` | 152 | 400, met |
| `colour.region_colors.buildings` | 80 | 400, met |
| `hanger` | 146 | 400, met |
| `road_mode` | 2127, 2289, 2822 (1705 on this tree before the change) | 2000, see below |
| `plate_mm` | 3104, 3210, 3228 (2184 before) | 2000, see below |

`road_mode` and `plate_mm` are untouched by this change (they re-run the
same stages before and after: the roads union, the road finish, the base
carve) and read over 2000 on this host today, before and after alike, where
section 3 measured them at 1133 and 1574 on a quieter machine; the spread
between the `plate_mm` readings taken an hour apart on the same tree (2184,
then 3104 to 3228 with 16 node processes alive) is the load, not the code:
`surface-roads` alone read 479 ms in one run and 628 in the next. They should be re-measured on a
quiet host before anything is concluded about them.

**Tests.** `incremental.test.ts`: on the Overpass path a `floor_height_m`
change leaves `surface-*`, `bridges`, `trees`, `base`, `region-base`, `sit`,
`region-roads` and `finish-roads` cached while `heroes`, `repair-buildings`,
`buildings` and the building regions run, and the perf rows show one
`osm.project` against four `osm.normalize`; `scenePartView` exposes the
part's layers as they are, throws for the rest naming the stage and the part,
refuses a part the registry does not define, and the registry's six
ground-keyed stages run clean through it on a scene with every layer.
`normalize.test.ts`: the composition, the field-level "only the heights
moved", the shared ground arrays. `graph.test.ts`'s note pin required the
`describeGraph` block in `v3-01-pipeline.md` to be regenerated; the diff is
mostly stages and leaves other waves had added since the block was written,
plus the two parts here.

> The measurements quoted in the four paragraphs below were also taken
> under load; 8.1 carries the quiet-host readings for the override row.

**The audit's hole: a surface-bearing override.** The 206 ms above held
only with `object_overrides` empty. `surface-overrides` was still keyed on
the whole scene (its reconciliation walks the buildings' ids to say which
override rows name an object outside the crop), and once a group is built
its output carries handles, so its digest is its key: one coloured road put
`heights.floor_height_m` back to 2674 ms across 57 stages, because every
ground stage lists `surface-overrides` as an input. Closed the same way:
a second scene part, `normalise#overrides`, is the ground digest plus a
hash of every building's `id` and `osm_id`; the stage is keyed on it and on
`repair-buildings#footprint`, and its view of the scene exposes the ground
layers and the buildings cut down to those two fields (a height read on one
throws, naming the stage and the part). The override REGION needed two more
parts of `buildings`: `buildings#overrideBands` (the recoloured buildings'
band solids, the constant `none` when no group recoloured any) for the
`region-override_N` stages, and `buildings#ownerIds` for the finish of
every building-bearing region, a hash of WHICH buildings own a solid rather
than of the map itself, whose keys are the kernel's original ids and fresh
on every extrusion (keying on those broke the warm-equals-cold region hash,
which `incremental.test.ts` pins). A finish whose region was served from
the cache is then served too, with the attribution that matches that
solid's ids. Measured, same harness, this load (10 node processes):
`floor_height_m` with one coloured road 216 to 227 ms and 36 stages,
without 211 to 215 and 36, the override surface, its region and its finish
cached in both. `incremental.test.ts` drives it on the Overpass fixture with
a park override: the override surface, its region and finish, the plate and
its seat stay cached under a storey change, and the `override_1` region is
in the result.

**The other guard, `[V3.1-P7-17]`.** A stage keyed on
`repair-buildings#footprint` was handed the whole repair record. Now
`ctx.input()` serves a part-keyed input through `runner.inputPartView`: the
keys `stages.PART_EXPOSURE` lists for that part (`footprint`), the rest
throwing; the exposure table sits beside the digest so the two cannot
drift, and a part with no exposure listed (the cutter parts `base` reads,
`labels#roofs`, `buildings#socket`) is served whole, which the table says.
Pinned by a unit test on the view and by the registry check that every
footprint reader (`surface-overrides` and the six) runs clean through it.

**`digestOf` no longer serialises what it will throw away.** It walked a
1.4 MB scene with `stableJson`'s sorted-key replacer and discarded the text
for exceeding the digest limit, 20 ms per normalise and 116 ms per cold
fetch on the 9 MB response. `plainDataSize` now walks the value counting a
lower bound of its JSON length and stops the moment the limit is passed, so
both cost a few thousand steps; the exact length is still checked on the
text that is hashed. `normalise`'s stage time went from 31 to 37 ms to 19
to 24 on the runs above.

**The aliasing the audit noted, decided.** The projection's five ground
arrays are shared by reference into every scene built from it and, in the
no-Worker transport, into the page. No mutator exists, and one would now
throw: `projectOverpass` freezes the five arrays (shallow, since a deep
freeze would walk a megabyte per projection against a mutator nothing has).
`normalize.test.ts` asserts the freeze; the full suite ran clean through it,
which is also the proof that nothing in the tree mutates them today.

**An undeclared read, fixed by declaring it.** The strict-claims run on the
Chicago fixture caught `repair-buildings` reading `height_exaggeration`,
which another wave's `T.building_top_mm_for` now applies before comparing a
tower's printed top with its block's (the stacking decision). Not the same
bug as the miss above (that was over-invalidation; this is a key that did
not cover a read), but the same invariant: measured before the claim, a
`height_exaggeration.multiplier` change reached the preview in 95 to 107 ms
with 35 stages run and `repair-buildings` served STALE from the cache, its
stacking decided at the old exaggeration. With `height_exaggeration.*`
declared on the stage it is 225 to 536 ms and 37 stages (the repair, 128 to
337 ms under a concurrent vitest run, and the building regions), and the
ground stays cached because `repair-buildings#footprint` reads no height.
The slower number is the correct one.

**Also in this close-out:** `next.config.test.ts`, the build-level test the
v3-08 note lacked for its webpack hook (section 3 and 10.5 of that note).

### 8.1 The quiet-host table (2026-09-05): what ships

Every figure above in this section was taken with 10 to 16 node processes
alive and other agents' vitest runs competing for the cores, and is
superseded by this table. This one was taken 05:38 to 05:41 on 2026-09-05
with every other agent stopped. The host was not idle, and the note says
what it was doing: overall CPU 17 to 20 per cent over three samples before
the run, from an unrelated Vite plus Tauri dev session of the user's
(started 05:35, other project), an Adobe helper and a `next dev` server an
earlier wave left on :3010; 18 node processes existed, 13 of them idle
orphans of finished agents (four stale `serve-static`, two hung Playwright
processes, a `next dev`) at 0.1 to 1 s of CPU each over two days. No build
was running. Same harness as section 3 (Node through `vite-node`, one
`StageCache`, the Chicago Overpass fixture through `fetchImpl`,
`regionBatchMs: 0`, the defaults plus one frame-edge `{city}` line, every
change from a warm default), three runs per row, taken back to back in one
process; the three readings are given, not averaged. Cold: 2937 ms to the
last region, 5198 to done.

| change | to preview, 3 runs | to done, 3 runs | stages run | target | v3-07 section 3 |
|---|---|---|---:|---|---:|
| `engravings[0].text` | 88, 84, 97 | 2423, 2257, 2210 | 14 | 400, met | 74 |
| `north_arrow.enabled` | 59, 57, 70 | 2154, 2144, 2302 | 14 | 400, met | 63 |
| `frame_style.profile` | 185, 149, 151 | 2355, 2225, 2239 | 14 | 400, met | 159 |
| `colour.region_colors.buildings` | 78, 74, 72 | 2236, 2155, 2171 | 30 | 400, met | 102 |
| `hanger` | 162, 146, 150 | 2486, 2279, 2251 | 14 | 400, met | 163 |
| `road_mode` | 1979, 1949, 1898 | 4014, 3927, 4012 | 29 | 2000, met by 21 to 102 ms | 1133 |
| `plate_mm` | 2389, 2469, 2412 | 4218, 4423, 4423 | 66 | 2000, **missed** | 1574 |
| `heights.floor_height_m` | 194, 189, 189 | 2309, 2287, 2330 | 36 | 2000, met | 2359 (missed) |
| `heights.floor_height_m`, one coloured road | 262, 236, 195 | 2901, 2767, 2452 | 36 | 2000, met | not measured |
| `height_exaggeration.multiplier` | 175, 220, 230 | 2324, 2817, 2776 | 20 | (none) | not measured |

**Two rows regressed against v3-07, and it is not noise.** `road_mode` and
`plate_mm` are 1898 to 1979 and 2389 to 2469 against 1133 and 1574, three
runs each inside 80 ms of one another, on a host quieter than any earlier
reading in this section was taken on (the `heights` row here, 189 to 194,
is the lowest it has ever read, which is the check that this host is not
inflating the others). `plate_mm` misses its target by about 400 ms. Neither
row re-runs anything this close-out touched: the stages they run are the
same before and after every change in section 8, and the digests this
section added cost 12 to 16 ms in total on the rows that compute them.
Where the time went, stage by stage, `plate_mm` today against the same
stages in section 3's split:

| stage | v3-07 (section 3) | today, `plate_mm`, 3 runs | moved |
|---|---:|---|---:|
| `surface-parks` | 158 | 405, 424, 409 | +250 |
| `finish-roads` | 350 | 400, 429, 407 | +60 |
| `sit` | 285 | 342, 343, 344 | +60 |
| `surface-roads` | 475 | 496, 494, 496 | +20 |
| `merged` (audit phase, "to done" only) | 314 | 689, 792, 828 | +400 to +500 |

`surface-parks` is where the geometry wave's frame-on `mergeRecessRidges`
and `fittedSolid` seam trim run (section 9), and `merged` now carries a
`mesh.sweep` row of 342 ms (`sweepSlivers`) plus 346 ms of
`mesh.clean.check` across the finishes, none of which existed when section
3 was measured. That is the finding: the two rows regressed in `solid/**`,
by the geometry work of 2026-09-03, and `plate_mm` is over its target by
the size of the `surface-parks` growth plus a little. The "to done" column
is 700 to 900 ms above section 3 on every row for the same reason
(`merged`). Nothing here averages that away, and nothing in this close-out
can fix it: it is a `solid/**` cost, and whoever owns section 9 owns it.

**The wall-clock budgets, on this host.** Asked whether the six timing
failures in a loaded full run are marginal on a quiet machine. Measured
here, same window: `sceneFromOverpass` on the Chicago fixture 514 to 576 ms
in isolation against `normalize.test.ts`'s 1500 ms budget, so the budget
is 2.6x the cost when the test has a core to itself, and the 1519 ms
reading was the parallel suite on a loaded host, not the normaliser; the
hillside drape 11 254 ms alone and 11 978 ms inside the full suite against
15 000, a 20 to 25 per cent margin, which is the tightest of the explicit
budgets. Inside the full suite (`npm test`, every worker busy, 124 s wall,
2331 passed, 0 failed, 0 skipped on this tree) the tests nearest a 5 s
default timeout were the in-page fallback ingest at 3.55 s and two
`store/editor` failure-state tests at 3.50 and 3.53 s: about 1.5 s of
margin each under full parallel load, which is where they fail on a host
with another suite running. None of the four timeouts reproduced. No
budget was changed.

## 9. The geometry fix wave (2026-09-03): what it costs

Measured on the dev host with `FRAMECRAFT_PERF=1`, Chicago fixture, parts
profile, plate 180, `--target generic-3mf`, from the preset matrix run:
engine 4.8 to 6.0 s over four matrix runs (5.3 s in section 3's table; the
matrix run has `uv` and the validator competing for the machine, so the
spread is the machine's, not the code's). The new rows:

| span | calls | ms | what |
|---|---:|---:|---|
| `mesh.sweep` | 0-7 | 0 (was 1122 unconditional) | `sweepSlivers`, the kernel `simplify` at 1e-6; now only when `cleanMesh` leaves a face under its 1e-7 mm^2 repair threshold, which no Chicago region does |
| `buildings.slices` | 1 | 20 | `repairSliceProfiles`, the slice-profile neck repair over every block group |
| `surface.printable` | 4 | 57 | unchanged rows; `residueParts` now dilates twice (simplified and raw eroded ring) |
| `mesh.clean` | 7 | 1231 | unchanged; its `check` row is 770 of it |

`mergeRecessRidges` now runs frame-on and has no span of its own; it is inside
the `surface-parks` stage, whose wall clock moved by under 0.2 s on this
plate. `snapSection` is a `toPolygons` round trip per building solid and does
not register.

**Addendum, 2026-09-05 (Tokyo re-cut fix, `FAILURES.md` "Closed: the 0.204
regression").** A layer the merge re-cuts now goes back through its own
printability pass (`repair.printableSection`, the factored tail of
`repairFlatLayer`), so `surface.decompose` / `surface.printable` /
`surface.reunion` / `surface.clean` gain one call per re-cut additive layer -
parks on the default plate, at most rail and parks - each over the components
that layer has left. No new span name. The verification timings taken for
that fix (`vitest run lib/engine/solid`, 58.8 s, Chicago build 4629 ms) were
measured while the preset matrix and the validator were running on the same
host; they are not quiet-host numbers and must not be read against the tables
above.

Plate 256, `--target step`: engine 19.6 s, `export.step` 4.4 s for 273,066
triangles and 4.6 million entities; the writer's twelve-decimal grid lost
zero faces (`gridLostTriangles` 0), against the six to twelve the six-decimal
grid lost.


## 10. The `plate_mm` miss, worked (2026-09-05, after `[V3.1-P7-27]`)

`[V3.1-P7-27]` found `plate_mm` at 2389-2469 ms against 2000 and `road_mode`
marginal at 1898-1979, and put the growth in `solid/**`. This section is the
work on that finding: every row of the two changes attributed to a span,
what was made cheaper (all of it exactly: the same solids, the same meshes,
the same bytes), what was measured and declined because it would have moved
the geometry, and the numbers. Same harness as 8.1 (Node through
`vite-node`, one `StageCache`, the Chicago Overpass fixture through
`fetchImpl`, `regionBatchMs: 0`, defaults plus one frame-edge `{city}` line,
perf mode on). The host was busier than in 8.1 all session: overall CPU 22 to
40 per cent from the user's browsers and other long-lived processes, so the
absolute numbers here read above 8.1's, and the comparison that counts is
the interleaved one in 10.4, where both trees see the same noise.

Host census, taken when a quiet retake of the two rows was asked for at the
end of the run: overall CPU 44, 49 and 49 per cent over three samples with
nothing of ours running, from the user's own session (a game at about 0.8 of
a core, two msedge processes and two of their webviews, Discord, iCUE, Bambu
Studio), plus 18 node processes, most of them finished agents' orphans; a
retake attempted anyway ran into a Playwright headless Chrome from the gate
and is discarded. No truly idle measurement was obtainable on this host
during this run, and 8.1's table, labelled the quiet-host table, was itself
taken at 17 to 20 per cent: the quietest observed, not idle. Its
conclusions stand (the `heights` row read its lowest ever in it); the label
should be read that way.

### 10.1 Where `plate_mm` spends its 2.3 to 2.5 s to the preview

New spans (no-ops with perf mode off) name what the stage wall clocks hid.
One `plate_mm` run, 2326 ms to the preview, the region and geometry stages:

| stage | ms | of which |
|---|---:|---|
| `surface-roads` | 503 | `surface.union` 306 (13 919 ribbon contours, 111 236 points, to 1728 rings and 23 242 points), `surface.close` 106, the rest 90 |
| `finish-roads` | 380 | `finish.solid` 141 to 158 (the region's lazy boolean, roads with the bridge decks, evaluated on first read), `finish.mesh` 94, `finish.prune` 65 (`prune.decompose` 61: the pre-prune roads solid really carries sub-floor debris) |
| `surface-parks` | 379 | `surface.ridges` 196 (`ridges.judge` 100 over three passes, `ridges.islands` 21, `ridges.complement` 18, `ridges.recut` 20, `ridges.bridge` 9), `surface.extrude` 100 (six extrusions), `surface.fit` 22, the parks repair itself about 60 |
| `sit` | 320 to 344 | `sit.base`: the base carve (`plate - cutters`), lazy in the kernel and evaluated by this stage's bounding-box read |
| `bridges` | 223 | `bridges.decompose` 113 (the deck-and-column union, evaluated by `groundedOnly`), the deck repair 50, extrusions |
| `repair-buildings` | 125 | |
| `finish-base` | 94 | `mesh.clean` 57 (`mesh.clean.check` x4 31) |
| `attribution` | 91 | |
| `finish-buildings`, `finish-frame`, `region-roads`, `buildings` | 164 | |

So the geometry wave's own cost on this row is the ridge merge, the seam
trim and the re-cut, about 240 ms; the other 2.1 s is Clipper2 (the ribbon
union and its closing pair) and four kernel booleans (the base carve, the
roads-with-decks union, the deck-with-columns union, the six extrusions)
that predate it. Even a full rollback of section 9 would leave the row at
about 2100 on this host; the target cannot be met from `surface-parks`
alone.

### 10.2 What changed, and why each is exact

1. **`bridges` is keyed on `road_mode === "off"`, not on `road_mode`**
   (`stages.ts`, a `KeyedClaim` like `context`'s `frame_style.profile`).
   The stage's only read of the leaf is `roads.roadBridgeWays`' "are there
   roads at all"; engraved and embossed roads carry identical decks. An
   engrave-to-emboss change built the same 220 ms of decks before and after.
   The `describeGraph` block in `v3-01-pipeline.md` moves one line for it
   (`road_mode` to `road_mode=off` under `bridges`), regenerated.
2. **The ridge merge remembers the islands it cleared** (`areas.ts:
   mergeInto`). A bridge changes the complement only where it lands, so the
   next pass decomposes mostly the same islands; measured on the Chicago
   sink merge, pass two had 392 islands of which 380 were vertex-for-vertex
   the islands pass one had cleared, and every one was paying the erosion
   probe and the appendage search again. The verdict is cached by the exact
   polygon (rings rotated to their smallest vertex, sorted, hashed to find
   the candidate, then compared coordinate for coordinate), so a cache hit
   is the same polygon and nothing else. Islands the bridge touched are
   different polygons and are judged afresh; an island with a wedge is
   bridged and never recurs.
3. **The repair ladder's split passes check open edges by exact delta**
   (`mesh.ts`). `splitNeedles` now reports the triangles it retired and
   created, in order; the ladder keeps the mesh's edge table (the same
   open-addressing table `openEdges` builds, now clonable and decrementable)
   and moves it by those triangles, measuring the openness of the touched
   edges before and after. An untouched edge keeps both counts, so the moved
   count equals a full recount; a rejected pass is reverted. A weld still
   gets a full count (it rewrites every triangle). `mesh.clean.check` on the
   merged Chicago plate went from 186 to 210 ms for twelve calls to 66.
4. **`componentCount` indexes edges numerically** (`mesh.ts`). It keyed a
   `Map` by `"u,v"` strings over 3T edges; on the 118 000-triangle merged
   plate that was 226 to 253 ms of the 389 to 410 ms `mesh.sweep`, against
   89 to 93 for the kernel's simplify itself: the sweep was mostly its guard
   counting bodies twice. Same adjacency rule (edges with exactly two faces
   join), same table shape as `openEdges`.
5. **The finish reads a solid's mesh once, in double, for both the body
   count and the record** (`manifold.ts: readMesh`, `bodiesFromMesh`,
   `pruneDebrisCounted`, `toRegionMesh`; `stages.ts` finish and `merged`).
   The quick body count read float32 vertices and trusted a body only an
   order of magnitude above the debris floor; on the double read the
   volumes are the kernel's to within summation noise (bounded per body from
   the terms' magnitudes) and the margin is that noise. The record reuses the
   read whenever the solid it ships is the handle that was read, which saves
   the `warpBatch` copy `doublePositions` costs (17 to 25 ms a region). On
   Chicago this helps `finish-base`; `finish-roads` still decomposes because
   its pre-prune solid has real debris, which the count correctly declines to
   answer.
6. **Spans**: `surface.ridges`, `ridges.merge/complement/islands/judge/
   bridge/recut`, `surface.pocket/fit/extrude`, `finish.solid`, `finish.read`,
   `merged.read`, `sit.base`, `bridges.decompose/reunion`, `prune.quick/
   decompose/union`, `sweep.simplify/read/bodies`.

Not weakened, not skipped: no threshold, test, validator or repair changed.
`sweepSlivers` runs exactly when it ran before; it only no longer pays for a
string-keyed body count. The merge judges every island it judged before,
once.

### 10.3 Measured and declined

Two changes to the roads ribbon would have bought real time and were not
made, because each moves the geometry at the last digit and "unchanged
cities" means unchanged.

- **A two-level union** (chunks of 20 to 400 contours unioned first, then
  the chunks): the one-pass union of the Chicago ribbon is 250 ms warm and
  the two-level form 145 to 155. But Clipper2 rounds intermediate results
  to its 1e-8 grid, and the two forms differ: 1727 rings against 1728 on
  the raw union, and after the closing pair 172 to 191 of the 495 rings
  differ in at least one coordinate. Geometrically noise; not the same
  footprint.
- **Wedge sectors instead of full 16-gons at ribbon joints** (the two
  rectangles already cover a joint's disc except the outer wedge): built
  from the same sample points it is not identical either (the same area to
  the last digit, but 1800 rings against 1728, from zero-area slivers where
  a sector's radial edge meets the chord), and the guard it needs (both
  adjacent segments at least a half-width long) keeps 58 per cent of the
  circles on Chicago's dense node spacing, so it was 15 per cent of the
  union at best.

Also looked at and left: the roads-with-decks union and the base carve are
single kernel booleans on 70 000 to 80 000-triangle solids with no exact
shortcut; `Manifold.extrude` goes straight to the kernel's triangulator; the
JS binding (manifold-3d 3.5.1) has no double-precision mesh reader, so
`doublePositions`' kernel copy stays; deciding deck groundedness in 2D
instead of by decomposing the union is exact only with a tangency fallback
and would save the decompose, not the union.

### 10.4 The numbers

Interleaved A/B, three rounds of the working tree then a worktree of
`b938384`, two runs per change per round, back to back so both trees see the
same host; overall CPU 40 per cent from other processes throughout. Every
reading, ms:

| row | before (`b938384`), 6 readings | after, 6 readings |
|---|---|---|
| `plate_mm` to preview | 2539, 2560, 2344, 2526, 2533, 2511 | 2491, 2486, 2461, 2264, 2533, 2645 |
| `plate_mm` to done | 4529, 4497, 4260, 4565, 4517, 4463 | 4351, 4327, 4307, 3911, 4414, 4480 |
| `road_mode` to preview | 2115, 1955, 2067, 1941, 2011, 2004 | 1663, 1693, 1641, 1639, 1680, 1752 |
| `road_mode` to done | 4224, 4110, 4271, 4197, 4167, 4125 | 3646, 3691, 3519, 3546, 3642, 3867 |

`road_mode` is met with a real margin: median 1670 against 2000 on a host
where the old tree read 2010 (a miss on this host today), because the
bridges are cached. To done is 170 ms (plate) and 550 ms (road) cheaper,
which is items 3 and 4. **`plate_mm` to the preview is unchanged within the
noise**: median 2489 against 2530 before, and it misses on this host as it
missed on 8.1's quieter one. The 40 to 70 ms the row gained is the island
cache, the split checks and one saved read; the 2.1 s that remains is 10.1's
table and is not the geometry wave's.

What it would take: the ribbon union and closing pair (about 400 ms) and
the base carve (300 to 340) are the only two items large enough to reach the
target, and both are exact-by-construction library calls. The two-level
union is the only measured lever that gets close (about 100 ms), and it is a
geometry change; whether a 1e-8 mm footprint difference is acceptable is not
this note's call.

### 10.5 Tests, checks, and the six cities

`mesh.test.ts` gains a `describe` for the incremental count: the moved
table's count equals a full recount after every accepted split on one, two
and three needle bodies, the no-repair path reports the input's own count
(a box with a face removed is three open edges either way), and
`componentCount` still joins across two-face edges only (a doubled triangle
cuts itself and its twin off the box: three bodies). `bodies.test.ts` is new:
the double read answers exactly for a 0.027 mm3 body beside a 1000 mm3 one
(the float32 read declines), declines under the floor and on it, and agrees
with the kernel's decomposition on what is debris. `tsc --noEmit` and
`eslint --max-warnings 0` clean; `vitest run lib/engine/solid
lib/engine/pipeline` 18 files, 371 tests passed (the `describeGraph` pin
after the block was regenerated).

All six presets rebuilt through the browser engine (`export:cli --overpass
... --params fixtures/print-params-parts.json --target generic-3mf`, the
matrix script's own command) and judged by `make validate`, on this tree:

| preset | verdict | `min_wall` |
|---|---|---:|
| chicago-loop | ALL CHECKS PASS | 0.874 |
| new-york-midtown | ALL CHECKS PASS | 0.8873 |
| paris-eiffel | ALL CHECKS PASS | 1.0 |
| tokyo-shinjuku | FAIL `min_wall` | 0.2539, 2 of 468 |
| london-city | ALL CHECKS PASS | 0.8174 |
| san-francisco-fidi | ALL CHECKS PASS | 1.14 |

Unchanged from `FAILURES.md`'s table to the last digit.

### 10.6 Lines for DECISIONS.md (the orchestrator appends; this agent does not edit it)

- [V3.1-P7-29] `bridges` claims `road_mode` as the keyed test `=== "off"`:
  the decks depend on whether roads exist, not on engrave against emboss,
  so a `road_mode` change no longer rebuilds them. `road_mode` to the
  preview went from a median 2010 to 1670 ms in an interleaved A/B on a
  loaded host; the old reading was inside 21 ms of its target on a quiet one.
- [V3.1-P7-30] The `[V3.1-P7-27]` `plate_mm` miss stands, measured: median
  2489 ms to the preview after this work against 2530 before, interleaved on
  one host. Everything exact was taken (the ridge merge's island cache, the
  repair ladder's delta open-edge check, a numeric `componentCount` under the
  sliver sweep, one double mesh read per finish); what remains is the
  Clipper2 ribbon union and closing pair and four kernel booleans that
  predate the geometry wave. Two geometry-moving levers (a two-level ribbon
  union, wedge sectors at joints) were measured and declined; the first is
  worth about 100 ms and changes 172 to 191 of the road footprint's 495
  rings at the 1e-8 mm digit. Neither city verdict nor threshold moved.

## 11. The lettering interaction budget, worked (2026-09-06, after `[V3.1-P7-34]`)

`[V3.1-P7-34]` found "a lettering change reaches the model inside the
interaction budget" a coin flip: 447.6, 382, 421.8, 368, 401.3, 380 against
400 at factor 1. Reproduced on this tree before anything was touched: two of
three repeats failed (432.8 the one the runner printed). This section is where
the time went, measured before any change, what was changed, and the readings
after. The threshold is 400 ms at factor 1 throughout; nothing in the test,
the validator or any budget moved.

### 11.1 Where the time went

Measured in the browser the test uses (headless Chromium, SwiftShader, the
Chicago fixture through the route mock), `?perf=1` on, with a trace on the
engine worker's messages and the page's long tasks. One 390 ms reading:

| from | to | ms | what |
|---|---|---:|---|
| the input event | the `run` message leaves for the worker | 217 | 80 ms of `PIPELINE_DEBOUNCE_MS`, then 137 ms waiting for the main thread |
| the worker starts | `finish-frame` done | 142 | `lettering` 50 (`repair.stroke` 30, `repair.widen` 10), `finish-frame` 89 (`finish.solid` 67, read 8, prune 4, mesh 9), 78 cached stages about 3 |
| `region-ready` posted | the frame mesh is on the DOM (`data-region-versions`) | 5 | the transfer, the store write and the React commit |
| the DOM attribute moved | the test's `requestAnimationFrame` poll saw it | 27 | the next frame boundary |

So the engine was 116 to 142 ms of a 368 to 448 ms reading, and the rest was
the main thread: the page's long-task observer showed 60 to 79 ms tasks back
to back for the whole window, which is one r3f frame of this scene under
SwiftShader. The `Canvas` ran `frameloop="always"`, so the debounce timer
fired at the first frame boundary after 80 ms (Chrome runs a due frame ahead
of a due timer), the worker's region message was handled at the next one,
and the replaced mesh was seen at a third. This inverts the assumption the
task was written on: it read as a geometry cost and was mostly rendering
infrastructure, which is worth remembering before the next slow interaction
is chased into the engine.

The engine's own 116 to 142 ms had one avoidable piece. `frame` subtracts
every cutter from the lip in one lazy kernel boolean that `finish-frame`
evaluates, and on the Chicago plate that boolean is (measured with the
handles out of a warm cache): the lip 48 triangles, the eleven-glyph text
cutter 3164, the four mandatory attribution marks 3920 each. The whole
difference took 57 to 65 ms; the lip minus the text alone 9 to 10; the lip
minus everything but the text 50 to 51; and that blank minus the text 17 to
18. Every keystroke was re-cutting 15 680 triangles of attribution that the
keystroke cannot move, because `frame` reads the lettering whole.

### 11.2 What changed

1. **`frameloop="demand"`** (`components/scene/CityPreview.tsx`). A frame is
   rendered when something changed: every change that should move the
   picture reaches three.js as a React prop (a region mesh, the dimming, a
   tint, the theme) or as an OrbitControls `change` event, which drei
   invalidates on, damping included. Idle, the main thread is free, so the
   timer fires at 80 ms and the worker's message is handled when it lands.
2. **The `Canvas` behind a `memo`** of the props the scene reads
   (`PreviewCanvas`, same file; its three DOM handlers made identity-stable
   through refs). Demand mode alone still lost: r3f 9.7 re-applies the root
   configuration in a layout effect on every render of `<Canvas>`, and its
   size comparison never matches the measured rect it is handed (the rect
   carries `x`/`y`/`right`/`bottom`, the stored size does not, and `is.equ`
   checks that every key of the one exists on the other), so every render
   called `setSize` on the root store, whose subscription invalidates the
   loop. `CityPreview` re-renders on every stage event, which was one 60 ms
   frame per stage, back to back through the run. Six readings with demand
   mode but without the memo: 266.6, 339.5, 403.4, 300.4, 323.3, 333.9.
3. **Stable handlers and `userData` per region mesh**
   (`components/scene/RegionMeshes.tsx`). A fresh `{ region }` object or a
   fresh closure per render is a changed prop to r3f, and a changed prop is
   an applied prop, and an applied prop asks for a frame. The pointer
   handlers are now reused while the mesh, `onHover` and `onPick` they close
   over are the same, and `userData` is one object per region name.
4. **A `frame-blank` stage** (`pipeline/stages.ts`, `stage.ts`): the lip
   with the attribution marks, the ornaments, the mating features and the
   texture already cut, evaluated in its own stage and keyed on the CONTENT
   of those three cutter lists (`ornaments#frame`, `attribution#frame`,
   `frame-cutters#frame`, all three now in `PART_EXPOSURE`, the
   `frame-cutters` digest covering all of `mating` because that is what the
   part exposes) rather than on the stages that made them, which re-run with
   the lettering for the layout and come back with the same solids. `frame`
   then cuts only the text pockets from the blank when the text is engraved
   or absent; with no text the result is the blank itself, cutter for cutter
   and byte for byte what it was, which is what keeps the six cities' frames
   unchanged. Embossed text keeps the one-shot order (additive first, then
   every cutter), because a letter added to the blank would not meet the
   texture and ornament cutters the rest of the lip met.
5. **Spans** inside the lettering repair (`lettering.layout/glyphs/repair/
   extrude`, `repair.section/dilate/clip/widen/stroke/starve`) and
   `frame.blank`, all no-ops with perf mode off. What they show, and what was
   left alone: `repair.stroke` is `openingWidthMm`'s bisection, eight
   openings at sixteen segments over the whole line, 10 to 30 ms by glyph
   count. Its answer is compared against `0.9 x target` and the bisection grid
   decides the value within one resolution step, so a shortcut that skipped
   openings could move a verdict near the line; it stays.

Worker side, in Node (`vite-node`, one `StageCache`, the Chicago fixture
through `fetchImpl`, `regionBatchMs: 0`, a warm change of one frame-edge line,
four texts of 7 to 11 glyphs): to the end of the region phase 99 to 120 ms
before, 47 to 82 after; `finish-frame` 68 to 72 before, 28 to 33 after;
`finish.solid` 55 to 58 before, 13 to 19 after; `lettering` 16 to 47 in both.
The cold Chicago run pays the blank once, 44 ms in its own stage, and its
`finish-frame` drops from 72 to 16.

### 11.3 The six readings

`npx playwright test --project=chromium -g "a lettering change reaches the
model inside the interaction budget" --repeat-each=6`, this host, the
production build served static, nothing else of ours running:

| tree | six readings, ms | median |
|---|---|---:|
| before (`[V3.1-P7-34]`) | 447.6, 382, 421.8, 368, 401.3, 380 | 391 |
| scene changes 1 to 3 only | 315.1, 325.1, 320.3, 321.3, 296.4, 284.6 | 318 |
| **this section, all of it** | **203.4, 250.0, 206.3, 267.2, 265.6, 251.8** | **251** |

Six of six pass, the slowest 133 ms under the line. What remains is 80 ms
of debounce in the store (not this note's file), a frame for the dimming
that overlaps it, 50 to 80 ms of engine work, and one frame boundary at the
end. The test's own trace recording sits on top of all of that: the same
change measured by a plain script reads 236 to 267.

### 11.4 The viewport under demand mode, driven

The risk `frameloop="demand"` carries is a viewport that renders once per
gesture and stops, and no existing spec orbits. Driven with Playwright
against the served build, frames counted as WebGL draw calls on the preview's
canvas per animation frame (NOT `page.locator("canvas").first()`: that is the
MapLibre picker's canvas, which comes first in the DOM and happily pans; the
preview's is under `[data-testid="preview-canvas"]`):

| gesture | frames | picture |
|---|---|---|
| idle, 2 s | 0 | unchanged |
| left drag, 30 pointer moves | 90 during, 21 in the 1.5 s after release, 22 more in the next 1.5 s (damping at 16 fps runs about 3.5 s), then 0 | changed |
| wheel, 10 notches | 14 | changed |
| right drag (pan), 20 moves | 38 | changed |
| hover sweep, 36 samples over the model | popover visible on 35, 19 distinct titles, repositioned 34 times | |
| `plate_mm` 180 to 220 (a full rebuild) | dimmed false, true, false; 2 frames by the time the overlay showed, 10 over the run, 6 streamed region batches | |

Nothing needed an explicit `invalidate()`: drei's OrbitControls calls it on
`change`, r3f calls it on every applied prop and on every child added or
removed, and a streamed region is a prop. `e2e/viewport.spec.ts` holds the
idle (at most one frame in 1.5 s), the orbit (more than one frame across 20
moves and a picture that moved) and the rebuild (more than one frame) cases
permanently, on the tiny fixture (11 s here); it is not tagged `@smoke`, so
it runs in the full gate and nightly.

### 11.5 Tests, checks, and the six cities

`vitest run lib/engine/pipeline lib/engine/solid components/scene`: 24 files,
441 tests passed. `incremental.test.ts` pins `frame-blank` cached under a
text edit; the `describeGraph` block in `v3-01-pipeline.md` is regenerated
(one stage added, `ornaments` and `frame-cutters` gain a `frame` digest,
`frame` gains the `frame-blank` input). `tsc --noEmit` and `eslint
--max-warnings 0` clean.

All six presets rebuilt through the browser engine (`export:cli --overpass
... --params fixtures/print-params-parts.json --target generic-3mf`) and
judged by `make validate` on this tree: chicago-loop ALL CHECKS PASS 0.874,
new-york-midtown ALL CHECKS PASS 0.8873, paris-eiffel ALL CHECKS PASS 1.0,
tokyo-shinjuku FAIL `min_wall` 0.2539 (2 of 468, narrowest 0.254),
london-city ALL CHECKS PASS 0.8174, san-francisco-fidi ALL CHECKS PASS 1.14.
Unchanged to the last digit.

### 11.6 Lines for DECISIONS.md (the orchestrator appends; this agent does not edit it)

- [V3.1-P7-35] The lettering budget's miss was rendering, not geometry:
  116 to 142 ms of a 368 to 448 ms reading was engine work, and the rest was
  an always-on r3f loop at 60 ms a frame under software GL making the
  debounce timer, the worker's message and the replaced mesh each wait for a
  frame boundary. Measured with stage spans and a worker message trace before
  anything changed. A slow interaction is not an engine cost until the main
  thread has been looked at.
- [V3.1-P7-36] The preview `Canvas` runs `frameloop="demand"` behind a memo of
  the props the scene reads, with per-region handlers and `userData` held
  stable across renders. Demand alone was not enough: r3f 9.7 calls `setSize`
  on every `<Canvas>` render (its size comparison never matches the measured
  rect) and that invalidates a frame, so a re-render per stage event was a
  frame per stage event. Driven and counted: idle renders nothing, an orbit
  drag renders continuously with its damping tail, zoom, pan, hover and a
  streaming rebuild all render; `e2e/viewport.spec.ts` pins it.
- [V3.1-P7-37] `frame-blank` is a stage: the lip with every non-lettering
  cutter already out, keyed on the content of those cutters, so a keystroke
  cuts the text pockets and not 15 680 triangles of attribution marks. The
  frame boolean a lettering edit evaluates went from 55 to 65 ms to 13 to 19;
  with no text the frame is the blank, byte for byte what it was. Six
  readings: 203.4, 250.0, 206.3, 267.2, 265.6, 251.8 against 400, from
  447.6, 382, 421.8, 368, 401.3, 380. Six city verdicts unchanged.
