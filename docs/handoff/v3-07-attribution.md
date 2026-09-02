# v3-07 - Phase 7 attribution: marks that cost something to remove

Scope: `apps/web/lib/engine/solid/attribution.ts` (new), `lib/engine/solid/
{ornaments,lettering,measure,tiling,mesh,context}.ts`, `lib/engine/{engine,
types}.ts`, `lib/engine/export/{common,generic3mf,bambu3mf,obj,step}.ts`,
`lib/bake.ts`, `scripts/bake-cli.ts`, `services/bake/app/{cli.py,validate/
checks.py}`, `LICENSE_AND_ATTRIBUTION.md` (new, repo root) and the tests beside
all of them. `[V3-P7-A1]` to `[V3-P7-A11]` in `DECISIONS.md` carry the rulings;
this file carries the numbers, the interface and the two things left for others.

The store, the components, `lib/share.ts`, `lib/geocode.ts`, `lib/project.ts`,
`lib/transform.ts`, the contracts and the e2e suite were not touched.

## 1. What every model now carries

Three engraved marks, on every bake, with no parameter that can turn any of
them off. Each says `FrameCraft`, then `© OpenStreetMap contributors` (the real
sign; all three committed faces have U+00A9, and there is a `(c)` fallback for
a face that does not), then the bake date.

| mark | where | fitted size | depth | id in `resolvedText` | surface label |
|---|---|---|---|---|---|
| deep underside | base underside, centred, spanning the plate | 5.83 mm cap, 174.7 mm wide (97 % of a 180 mm plate) | 0.50 mm on the 3 mm default, 0.60 mm from a 4 mm base up | `attribution-underside` | Base underside, mandatory attribution |
| frame inner wall | all four walls of the frame opening | 1.78 mm cap on the 2.00 mm lip | 0.40 mm | `attribution-frame-wall` | Frame inner wall |
| edge microtext | outer side face of the base, south edge | 1.20 mm cap | 0.20 mm | `attribution-microtext` | Base edge, microtext |
| second underside (frame off only) | underside, west edge, turned 90 degrees | 4.00 mm cap | as the deep mark | `attribution-underside-2` | Base underside, second mandatory attribution |

With the frame off, `attribution-frame-wall` is the ONLY line that is ever
`skipped`, and the second underside mark appears in its place. The two underside
marks cannot collide: the first moves to the north edge and gives up twice the
second's strip width, and the second is length-limited to what is left.

What all of this does and does not achieve, in the words a user should read
rather than an engineer's, is
[`LICENSE_AND_ATTRIBUTION.md`](../../LICENSE_AND_ATTRIBUTION.md): what the ODbL
asks of someone who redistributes a produced work, what FrameCraft engraves and
writes on their behalf, and an honest-limits paragraph that says plainly that
engraved plastic can be sanded off, meshes can be edited and file metadata is
routinely lost in transit.

The user's `underside_mark.template` is APPENDED under the mandatory text, at a
cap height capped by the mandatory line's own. `underside_mark.enabled: false`
removes that line and nothing else; it keeps the id `underside-mark`, so
`engine.resolveParamsEcho`, the OUTPUT panel and the reference validator's
`underside_probe_zs` all keep reading what they always read.

`solid/ornaments.ts` no longer cuts an underside mark at all: the whole
underside block belongs to `solid/attribution.ts`, and `buildLettering` is told
how much of it is spoken for (`undersideReserveMm`) before it stacks the user's
own `edge: "underside"` engravings below.

Two `info` findings are new and honest rather than decorative:
`attribution-wall-mark-fine` and `attribution-microtext-fine` say, with the
measured size and the nozzle in them, that a mark is finer than the nozzle can
resolve and is cut anyway because it is provenance. `attribution-mark-shallow`
says when the plate could not carry the full 0.6 mm. `attribution-span-short`
and `attribution-frame-wall-unavailable` exist for plates and profiles that
cannot do better.

## 2. The numbers

Chicago fixture, default parameters, `generic-3mf`, before and after.

| | before (v3-05 baseline) | after | delta |
|---|---|---|---|
| region triangles | 100 278 | 135 106 | +34 828 |
| merged triangles (what the single-mode file writes) | 110 210 (with marks, before the glyph simplify) | 93 746 | see below |
| model volume | 172 463 mm3 | 172 324 mm3 | -139 mm3 |
| frame region volume (plain lip) | 9 187.0 mm3 | 9 159.4 mm3 | -27.6 mm3 |
| min_wall (single / parts) | 0.8746 / 0.9096 | 0.8746 / 0.9379 | unchanged / better |
| bodies | 1 | 1 | unchanged |

The marks remove 139 mm3 in total: 27.6 mm3 from the four frame walls, the rest
from the underside pocket and the edge microtext. The triangle cost is the real
price of the feature: six copies of a 49-character line (one underside, four
walls, one edge). The glyph sections are re-flattened to the assets' own 0.02 mm
chord tolerance before they are extruded (`[V3-P7-A7]`), which took 9 860
triangles back off; dropping the wall mark from four walls to one would take
about 17 000 more, and is the lever to pull if the count ever matters.

Empty-scene plate and lip (the `synthetic.test.ts` pin): frame ring
9 187.2 mm3 becomes 9 159.1 mm3, the same 28.08 mm3 of wall marks.

## 3. File metadata

Every exporter writes the same five-field block, in the same order, from one
function (`export/common.provenanceEntries`):

```
author      place.author, trimmed; "" when unset (written anyway, so the block is uniform)
license     Model data © OpenStreetMap contributors, ODbL 1.0
generator   FrameCraft 3.0.0
source      lat=... lon=... radius_m=... [rotation_deg=... preset_id=...]
generated   ISO 8601 timestamp
```

* generic 3MF and Bambu 3MF: `<metadata name="framecraft:author">` and so on.
  The stand-alone `framecraft:generator` entry was REMOVED from both, because
  the block repeats it and the core spec requires metadata names to be unique
  inside one element.
* OBJ: `#` header comments, in the `.obj` and (for the first five lines) the
  `.mtl`.
* STEP: extra `FILE_DESCRIPTION` strings. Part 21 is 7-bit, so the copyright
  sign appears there as `\X2\00A9\X0\`; the ASCII tail is what a test greps.
* The sidecar gains `provenance` (the same five fields) and `attribution_bands`.

`place.author` also becomes the 3MF `Designer` and the STEP author when it is
set; blank leaves `FrameCraft`, which is what every file said before.

**The single-plate Bambu byte-hash moved**, on purpose, and was re-pinned to
`ddc4a39f8d2364de89c799fb594167ba571326efa9734964aef2fb487e89f008` after
diffing the unzipped `3D/3dmodel.model` entry by entry: nothing outside the
`<metadata>` list changed. The test now also asserts each block key appears
exactly once, so a future edit that drops the block fails on more than a hash.

## 4. The validator, and why it needed telling

The two small marks are finer than a 0.4 mm nozzle BY CONSTRUCTION: a 2 mm frame
wall holds about 1.8 mm of cap height and a plate edge holds 1.2 mm. At those
sizes the ridge between two strokes measures 0.11 mm, and the reference
validator's structural `min_wall` row measured exactly that and failed the file
(0.1103 mm at z = 4.26 in the lip band, 0.1840 mm at z = 1.90 on the plate
edge). It is not a wall: it is surface texture 0.4 mm deep in the face of a 6 mm
block with the whole block behind it.

The fix follows the `max_height_mm` precedent from phase 4 (`[V3-P4-E9]`) and
the `skip_bands` precedent the validator already had for underside pockets. The
engine DECLARES the Z bands its marks occupy, the sidecar carries them as
`attribution_bands`, `app/cli.py` reads them back, and `checks.validate`:

* excludes them from the structural `min_wall` probe, and says so in that row's
  message;
* judges them with a new **`attribution` row**, which is a guard on the
  exclusion rather than a rubber stamp. It fails a band over 2.5 mm tall, more
  than four bands (the two caps put a hard 10 mm ceiling on everything that can
  be skipped), a band outside the model, or a band with no material at its
  middle. It does NOT try to read the glyphs: a validator cannot tell an
  engraved credit from a scratch, and pretending otherwise would be worse than
  saying nothing. That the marks are cut is checked by `resolved_text` in the
  sidecar and by `attribution.test.ts` measuring the volume each removes.

The default bake declares three bands totalling 3.55 mm, 10.2 per cent of the
model height. A file with no sidecar field is judged exactly as it always was,
and the old `min_wall` message is reproduced verbatim when only underside
pockets are skipped, so `test_validator_min_wall_skips_only_the_underside_band`
still means what it meant.

The engine's own probes needed the same information for two different reasons
(`[V3-P7-A8]`): `measure.measureMinWall` was calling a letter counter on a
pocket floor a 0.44 mm wall, and `tiling.sliverHeights` was harvesting one as a
sliver, which is cut out of the whole model at every height and would punch a
hole through the tile. Excluding the bands took the 2 x 2 Chicago tile loss from
1.35 per cent to **0.45 per cent**, better than it was before this phase.

## 5. Validator runs

```sh
cd apps/web
npx vite-node scripts/bake-cli.ts -- --scene ../../fixtures/chicago-scene.json \
  --params ../../fixtures/print-params-default.json \
  --target generic-3mf --out ../../artifacts/p7-default-single.3mf
cd ../../services/bake && uv run python -m app.cli validate ../../artifacts/p7-default-single.3mf
```

**Chicago, default, single: ALL CHECKS PASS**

```
watertight         PASS    euler=2 bodies=1
min_wall           PASS    0.8746                  0.72
triangle_budget    PASS    93,746                  2,000,000
degenerate_faces   PASS    0                       0
attribution        PASS    3 band(s), 3.55 mm (10.2 % of height)
bodies             PASS    1                       1
3mf_attribution    PASS    present (2632 chars)
3mf_counts         PASS    xml 46,875 v / 93,746 t
```

**Chicago, default, parts (`fixtures/print-params-parts.json`): ALL CHECKS PASS**

```
min_wall           PASS    0.9379                  0.72
attribution        PASS    3 band(s), 3.55 mm (10.2 % of height)
bodies             PASS    6 parts, 463 shells, union 1
part_meshes        PASS    6 parts, 135,106 triangles (base, frame, buildings, roads, water, parks)
3mf_materials      PASS    6 entries
```

**Frame off: ALL CHECKS PASS** (synthetic scene, `artifacts/p7-synthetic-scene.json`)

```
watertight         PASS    euler=2 bodies=1
min_wall           PASS    15.75                   0.72
degenerate_faces   PASS    0                       0
attribution        PASS    2 band(s), 1.75 mm (9.3 % of height)
bodies             PASS    1                       1
```

Two underside marks and the microtext, and no frame-wall mark: exactly the
frame-off path.

### The frame-off Chicago bake fails, and it is not this phase

`fixtures/chicago-scene.json` with `frame: false` fails `min_wall` at 0.1667 mm
(five regions, one merged building block at x 154 to 164, y 118 to 124 in build
space, at every height from z = 4.5 to 16.7) and, at `plate_mm: 256`, also
`degenerate_faces` with 7 faces. **Both were reproduced with the attribution
marks disabled and are identical with and without them** (same count, same
numbers), so both belong to the frame-off crop and merge path, where the city
runs to the plate edge and the block scale changes. Left as found and reported
(`[V3-P7-A11]`) rather than fixed here: the remedy is in the building repair and
would move the DEFAULT bake's geometry, which several committed goldens pin.

## 6. Tests

```sh
cd apps/web
npx vitest run lib/engine       # 34 files, 423 tests   (was 33 / 393)
npx vitest run lib              # 65 files, 1215 tests  (was 62 / 1120)
npm run typecheck && npm run lint
cd ../../services/bake && uv run pytest -q     # 697 passed (was 694)
```

New: `lib/engine/solid/attribution.test.ts`, 30 tests over composition (product
name, real copyright sign, ASCII fallback, nothing dropped by the metrics
filter), layout (word wrap, one-line preference, size caps, mirroring, the 90
degree turn, wall normals), the three bakes (every mark cut by default and with
`underside_mark` off, the template appended, the span rule, the depth clamp and
the full 0.6 mm on a 5 mm base, the frame-off second mark, the declared bands)
and the metadata (every exporter's bytes parsed back, the sidecar block,
blank-safe author). Plus 3 in `services/bake/tests/test_lettering.py` for the
`attribution` row and the malformed-band path.

Four existing pins moved, each with the reason written beside it:

* `solid/frame.test.ts` "the default bake": the plain lip is 27.60 mm3 lighter,
  and the test now asserts `ring - frame.volumeMm3` against a named constant so
  the number is re-measurable from the bake itself.
* `solid/synthetic.test.ts` "an empty scene": the same 28.08 mm3.
* `solid/text.test.ts` "refuses an ornament when the frame is off": the
  assertion now excludes `attribution-*` lines (and asserts they ARE present),
  because they are not parameters and are cut on every bake.
* `export/tiles.test.ts` Bambu byte-hash: section 3 above.

Nothing was skipped, weakened or deleted. `services/bake/tests/test_v1_compat.py`
was not touched and is green.

## 7. Two repairs that were not about attribution

Both were found by this phase and both are strictly better than what was there:

* **`mesh.collapseNeedles`** (`[V3-P7-A9]`), a new last rung of `cleanMesh` that
  welds the two ends of ONE degenerate triangle's shortest edge and touches
  nothing else. The whole-mesh weld is all-or-nothing at its epsilon and
  `splitNeedles` cannot help when a needle's long edge is met by two triangles
  on the far side. It is OPT IN (`solid/tiling.ts` is the only caller) and it is
  guarded on the connected-body count as well as on openness, orientation and
  volume: a pinch is closed, oriented and volume-preserving and is still three
  objects where there was one. `componentCount` counts bodies the way
  `trimesh.body_count` does, so it answers the question the reference validator
  will ask. A knurled 2 x 2 Chicago tiling went from 17 degenerate faces across
  the four tiles to 0.
* **The wall cutter is clipped to the lip's own footprint.** It overshoots into
  the frame opening so its near face is not coincident with the wall it cuts,
  and the opening is exactly where the city is: buildings are cropped flush to
  that plane, so without the clip the attribution would be engraved into any
  building standing against the frame.

## 8. For whoever owns the UI

`EngineResult.resolvedText` now always contains three or four `attribution-*`
entries with the surface labels in section 1. They are never editable and never
`skipped` except the frame-wall one with the frame off. A Resolved output panel
that lists `resolvedText` gets them for free; a panel that wants to mark them as
non-editable can test `line.id.startsWith("attribution-")`.

`EngineResult.attributionBands` is new and optional (`Array<[low, high]>` in
mm). Nothing in the UI has to read it; it exists for the sidecar and the
validator.

`EngineInput.attribution` is deprecated and IGNORED (`[V3-P7-A1]`). Anything
setting it can stop.

The underside-mark section of this note is the anchor for
[`LICENSE_AND_ATTRIBUTION.md`](../../LICENSE_AND_ATTRIBUTION.md), which is the
honest version for users: what ODbL requires of someone redistributing a
produced work, what FrameCraft engraves and writes, and a paragraph that says
plainly that engraved plastic can be sanded off, meshes can be edited and
metadata is routinely lost in transit. The goal is to make casual removal
impractical and provenance provable, not to make removal impossible.

## 9. State at hand-off

* `apps/web`: `npx vitest run lib` 65 files / 1215 tests green, `npm run
  typecheck` and `npm run lint` clean. `next build` and Playwright were not run
  from here (the parallel web-editor agent owns them this phase).
* `services/bake`: `uv run pytest -q` 697 passed, `test_v1_compat.py` untouched.
* Three validator runs read ALL CHECKS PASS; the artefacts and their sidecars
  are in `artifacts/p7-*.3mf`.
* Nothing committed; all changes are working-tree.
* Left for others: the frame-off Chicago `min_wall` and `degenerate_faces`
  failures of section 5, which pre-date this phase; and the `expected_bodies`
  sidecar field that v3-05 left for the separate-frame and mount bakes, still
  open and now sitting beside an `attribution_bands` field that shows exactly
  how it would be done.
