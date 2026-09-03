# v3-01 matrix audit (adversarial)

Written by an auditor who did not write the matrix. Read in full:
`docs/handoff/v3-01-matrix.md`, `docs/handoff/v3-01-pipeline-design.md` section 6,
`apps/web/lib/engine/pipeline/matrix.{assert,run,probes,test}.ts`,
`pipeline/fixtures/overpassBlock.ts`, `pipeline/testScenes.ts`, and
`DECISIONS.md` `[V3.1-P1-2]`, `[V3.1-P1-13]`, `[V3.1-P2-1..5]`.

Read-only audit. No source file was modified. Nothing was committed.

Measured run on this host (other agents building concurrently):

```
npx vitest run lib/engine/pipeline/matrix.test.ts
matrix: 124 probes in 107.7 s
Test Files  1 failed (1)
     Tests  2 failed | 130 passed (132)
  Duration  108.35s
```

The two failures are the two KNOWN DEFECT rows, and both printed the defect
sentence ahead of the assertion. No third failure, no flake.

## 1. Rubric used

- **SPECIFIC**: the assertion names a physical consequence of that field. A
  named region's volume, a bbox extent or span, a colour, a slot or extruder, a
  resolved string, a named finding, a metadata or settings entry, a file name, a
  part appearing or leaving, or a named region's triangle count **with a
  direction** (`toBeLessThan` / `toBeGreaterThan`, optionally with a magnitude).
- **WEAK**: a property many other fields also move. A bare `not.toBe` on a count
  or a float (the numeric form of "the hash moved"), a zip's byte length, a
  global stat that eight sibling fields all move, or the parameter echoed back
  on `result.params` or in the sidecar.
- **MISSING**: trivially true or absent.

On the export side the brief's rule is applied strictly: a sidecar echo of the
parameter is not an export effect. The sidecar IS a shipped file
(`scripts/export-cli.ts:299` writes `<stem>.json`, `lib/exportFlow.ts:131`
downloads it), so sidecar content **derived** from geometry (region triangle
counts and volumes, `stats.height_mm`, warnings built from findings) counts as a
file effect; a sidecar field that is the parameter copied back does not.

## 2. Classification table

124 probes, both sides. `S` = SPECIFIC, `W` = WEAK, `M` = MISSING. Line numbers
are `matrix.probes.ts` unless named otherwise.

| # | leaf | line | preview | export |
|---|---|---|---|---|
| 1 | `plate_mm` | 176 | S | S |
| 2 | `base_thickness_mm` | 193 | S | S |
| 3 | `nozzle_mm` | 209 | S | S |
| 4 | `small_scale` | 226 | S | S |
| 5 | `large_scale` | 240 | S | S |
| 6 | `terrain_exaggeration` | 256 | S | S |
| 7 | `road_mode` | 271 | S | S |
| 8 | `road_scale` | 287 | S | S |
| 9 | `trees` | 306 | S | S |
| 10 | `water` | 322 | S | S |
| 11 | `frame` | 338 | S | S |
| 12 | `city_label` | 358 | S | S |
| 13 | `engravings[].text` | 376 | S | S |
| 14 | `engravings[].edge` | 391 | S | S |
| 15 | `engravings[].align` | 409 | S | S |
| 16 | `engravings[].mode` | 429 | S | S |
| 17 | `engravings[].size_mm` | 448 | S | S |
| 18 | `engravings[].depth_mm` | 464 | S | S |
| 19 | `engravings[].font` | 480 | S (thin, F14) | S |
| 20 | `north_arrow.enabled` | 497 | S | S |
| 21 | `north_arrow.corner` | 513 | S | S |
| 22 | `north_arrow.size_mm` | 529 | S | S |
| 23 | `scale_bar.enabled` | 545 | S | S |
| 24 | `scale_bar.edge` | 561 | S | S |
| 25 | `scale_bar.length_mode` | 576 | S | S |
| 26 | `scale_bar.length_m` | 592 | S | S |
| 27 | `underside_mark.enabled` | 608 | S | S |
| 28 | `underside_mark.template` | 624 | S | S |
| 29 | `hanger` | 642 | S | S |
| 30 | `hero_building_ids` | 662 | S | S |
| 31 | `hero_mode` | 680 | S (dormant half, F8) | S |
| 32 | `hero_auto.enabled` | 697 | S | S |
| 33 | `hero_auto.count` | 713 | S | S |
| 34 | `place.country` | 732 | S | **W** |
| 35 | `place.state` | 748 | S | **W** |
| 36 | `place.neighbourhood` | 762 | S | **W** |
| 37 | `place.author` | 777 | S | S |
| 38 | `regions.roads.depth_mm` | 795 | S | S |
| 39 | `regions.roads.proud_mm` | 810 | S | S |
| 40 | `regions.water.depth_mm` | 825 | S | S |
| 41 | `regions.water.proud_mm` | 840 | S | S |
| 42 | `regions.parks.depth_mm` | 854 | S | S |
| 43 | `regions.parks.proud_mm` | 869 | S | S |
| 44 | `regions.rail.depth_mm` | 884 | S | S |
| 45 | `regions.rail.proud_mm` | 898 | S | S |
| 46 | `regions.rail.width_m` | 913 | S (one-sided, F9) | S (one-sided, F9) |
| 47 | `regions.building_skirt_mm` | 925 | S | S |
| 48 | `colour.region_slots.base` | 940 / 1753 | S | S |
| 49 | `colour.region_slots.frame` | 941 / 1753 | S | S |
| 50 | `colour.region_slots.matting` | 942 / 1753 | S | S |
| 51 | `colour.region_slots.buildings` | 943 / 1753 | S | S |
| 52 | `colour.region_slots.hero_building` | 944 / 1753 | S | S |
| 53 | `colour.region_slots.roads` | 945 / 1753 | S | S |
| 54 | `colour.region_slots.water` | 946 / 1753 | S | S |
| 55 | `colour.region_slots.parks` | 947 / 1753 | S | S |
| 56 | `colour.region_slots.rail` | 948 / 1753 | S | S |
| 57 | `colour.region_slots.lettering` | 949 / 1753 | S | S |
| 58 | `colour.region_slots.attribution` | 951 | S | **W** |
| 59 | `colour.region_colors.base` | 978 / 1780 | S | S |
| 60 | `colour.region_colors.frame` | 979 / 1793 | S | **W** |
| 61 | `colour.region_colors.matting` | 980 / 1793 | S | **W** |
| 62 | `colour.region_colors.buildings` | 981 / 1780 | S | S |
| 63 | `colour.region_colors.hero_building` | 982 / 1780 | S | S |
| 64 | `colour.region_colors.roads` | 983 / 1780 | S | S |
| 65 | `colour.region_colors.water` | 984 / 1780 | S | S |
| 66 | `colour.region_colors.parks` | 985 / 1793 | S | **W** |
| 67 | `colour.region_colors.rail` | 986 / 1793 | S | **W** |
| 68 | `colour.region_colors.lettering` | 987 / 1793 | S | **W** |
| 69 | `colour.palette` | 990 | **W** | S |
| 70 | `colour.tint.enabled` | 1007 | S | S |
| 71 | `colour.tint.hue_range_deg` | 1022 / 1806 | S | S |
| 72 | `colour.tint.lightness_range` | 1023 / 1806 | S | S |
| 73 | `colour.tint.seed` | 1024 / 1806 | S | S |
| 74 | `colour.gradient.enabled` | 1028 | S | S |
| 75 | `colour.gradient.slots` | 1046 | S | S |
| 76 | `printer_profile` | 1065 | S | S |
| 77 | `custom_profile.plate_x_mm` | 1081 | S | S |
| 78 | `custom_profile.plate_y_mm` | 1095 | S | S |
| 79 | `custom_profile.max_height_mm` | 1109 | S | S |
| 80 | `custom_profile.nozzle_mm` | 1124 | **W** (ruled) | S |
| 81 | `custom_profile.slots` | 1140 | S | **W** |
| 82 | `custom_profile.change_gcode` | 1154 | **W** (ruled) | S (thin, F16) |
| 83 | `color_mode` | 1170 | **W** (ruled) | S |
| 84 | `export_target` | 1187 | **W** (ruled) | S |
| 85 | `terrain.enabled` | 1205 | S | S |
| 86 | `terrain.smoothing` | 1220 | S | S |
| 87 | `heights.floor_height_m` | 1237 | **W** | **W** |
| 88 | `heights.unknown_default_m` | 1250 / 1835 | **W** | **W** |
| 89 | `heights.type_defaults.house` | 1251 / 1835 | **W** | **W** |
| 90 | `heights.type_defaults.apartments` | 1252 / 1835 | **W** | **W** |
| 91 | `heights.type_defaults.commercial` | 1253 / 1835 | **W** | **W** |
| 92 | `heights.type_defaults.retail` | 1254 / 1835 | **W** | **W** |
| 93 | `heights.type_defaults.industrial` | 1255 / 1835 | **W** | **W** |
| 94 | `heights.type_defaults.garage` | 1256 / 1835 | **W** | **W** |
| 95 | `bridges.enabled` | 1260 | S | S |
| 96 | `bridges.clearance_mm` | 1277 | S | S |
| 97 | `bridges.abutments` | 1291 | S | S (loose, F15) |
| 98 | `height_exaggeration.multiplier` | 1308 | S | S |
| 99 | `height_exaggeration.curve` | 1327 | S | S |
| 100 | `tiling.enabled` | 1343 | S | S |
| 101 | `tiling.cols` | 1361 | S | S |
| 102 | `tiling.rows` | 1379 | S | S |
| 103 | `tiling.joint` | 1396 | S | **W** |
| 104 | `tiling.tolerance_mm` | 1417 | S | **W** |
| 105 | `tiling.index_mark` | 1438 | S | **W** |
| 106 | `frame_style.profile` | 1462 | S | S |
| 107 | `frame_style.corner` | 1477 | S | S |
| 108 | `frame_style.corner_radius_mm` | 1491 | **W** | **W** |
| 109 | `frame_style.lip_depth_mm` | 1505 | **W** | **W** |
| 110 | `frame_style.shadow_gap.enabled` | 1517 | S | S |
| 111 | `frame_style.shadow_gap.width_mm` | 1531 | S (pair, F11) | S (pair, F11) |
| 112 | `frame_style.shadow_gap.depth_mm` | 1546 | S (pair, F11) | S (pair, F11) |
| 113 | `frame_style.matting.enabled` | 1561 | S | S |
| 114 | `frame_style.matting.width_mm` | 1577 | S | S |
| 115 | `frame_style.matting.proud_mm` | 1592 | S | S |
| 116 | `frame_style.separate.enabled` | 1607 | S | S |
| 117 | `frame_style.separate.mount` | 1622 | S | S |
| 118 | `frame_style.separate.tolerance_mm` | 1637 | S | S |
| 119 | `frame_style.texture.pattern` | 1652 | S | S |
| 120 | `frame_style.texture.scale_mm` | 1667 | S | S |
| 121 | `frame_style.texture.depth_mm` | 1682 | S | S |
| 122 | `hanger_magnet.diameter_mm` | 1698 | S (tight, F19) | S (tight, F19) |
| 123 | `hanger_magnet.thickness_mm` | 1714 | S | S |
| 124 | `hanger_magnet.count` | 1729 | S | S |

### Totals

| side | SPECIFIC | WEAK | MISSING |
|---|---|---|---|
| preview | 109 | 15 | 0 |
| export | 101 | 23 | 0 |

Preview WEAK: the five echo-only leaves (69, 80, 82, 83, 84), the eight
`heights.*` (87 to 94), and the two `not.toBe` frame probes (108, 109).

Export WEAK: three `place.*` (34 to 36), `colour.region_slots.attribution` (58),
five `colour.region_colors.*` (60, 61, 66, 67, 68), `custom_profile.slots` (81),
the eight `heights.*` (87 to 94), three `tiling.*` (103 to 105), and the two
`not.toBe` frame probes (108, 109).

## 3. Findings

Severity: **blocker** for a WEAK or MISSING assertion on a field that can carry a
specific one; **major** for a base that leaves the field dormant or half dormant,
or for a probe that would pass a wrong implementation; **minor** otherwise.

### F1. BLOCKER. Eight `heights.*` probes share one assertion that any of the eight satisfies

`matrix.probes.ts:1835-1853` (`heightProbe`) and `:1237-1249`
(`heights.floor_height_m`). Preview asserts `stats.heightMm` rose by 2 mm and the
buildings region's total volume rose; export asserts the buildings PART's roof
rose by 2 mm and the sidecar's `height_mm` rose. Every one of these is a property
of the WHOLE buildings region, and each of the eight probe values (35 to 60 m)
makes its own building the tallest in the fixture, so **each probe's assertion is
satisfied by any of the other seven fields**. If `normalise` read the `retail`
default where it means `industrial`, both probes still pass. That is the exact
false-pass the gate exists to catch.

`fixtures/overpassBlock.ts:77-96` already places each type at a known plan
position (`ring(eastM, northM, 46)`), and `TYPE_DEFAULT_BUILDINGS` already maps
the type to an id, so the specific assertion costs one reader.

Replacement, both sides: add `maxZOverFootprint(mesh, x0, x1, y0, y1)` to
`matrix.assert.ts` (a five-line loop, the mirror of the existing
`partExtentAtZ`), then assert that the roof over THAT type's own footprint square
rises from its default height to the probed one, in millimetres, and that the
roof over at least one other type's footprint is unchanged. For
`heights.floor_height_m` the footprint is way 102 (three storeys), for
`heights.unknown_default_m` way 101, and for each `type_defaults` key the way
named in `TYPE_DEFAULT_BUILDINGS`. Keep the existing `bodies` invariant.

### F2. BLOCKER. Three `tiling.*` export assertions are a zip byte length

`matrix.probes.ts:1411-1414` (`joint`), `:1432-1435` (`tolerance_mm`),
`:1454-1457` (`index_mark`). Each asserts the zip's entry list is unchanged and
`after.files[0].bytes.length !== before.files[0].bytes.length` (or is smaller).
A byte length is "the bytes moved" with extra steps: it would move for a changed
timestamp, a changed comment, or any unrelated geometry change inside any tile.

The note argues that unpacking a tile would duplicate `solid/tiling.test.ts`.
That argument does not hold, because **the reader for the specific assertion is
already written and used by nothing**: `matrix.assert.ts:397` exports `zipEntry`,
and no probe or test imports it (verified by grep across `lib/`).

Replacement: `zipEntry(before.files[0].bytes, "framecraft-A1.3mf")` gives the
tile's own 3MF; feed those bytes to a bytes-taking variant of `bambuParts` (split
`bambuParts` at its `onlyFile` call, three lines) and assert on the tile's `base`
part exactly what the preview side already asserts on `result.tiles[i].regions`:
for `joint`, tile A1's base triangle count rises; for `tolerance_mm`, tile A1's
and tile B1's base volume falls; for `index_mark`, all four tiles' base triangle
counts fall. Same numbers, read out of the written file.

### F3. BLOCKER. Five `colour.region_colors.*` probes have no export effect at all

`matrix.probes.ts:1793-1800` (`colorProbe`'s `assertExport`) at call sites
`:979` (frame), `:980` (matting), `:985` (parks), `:986` (rail), `:987`
(lettering). When `slot === null` the ONLY export assertion is
`sidecarRegions(after.sidecar).get(region)?.color`, which is
`region.colorHex` copied verbatim from the parameter into the sidecar. That is a
sidecar echo, which the gate does not accept. Nothing in the written 3MF moves:
these five regions are never first on their slot (`base` holds slot 1 ahead of
`frame` and `matting`; `hero_building` holds slot 4 ahead of `roads`, `parks`,
`rail` and `lettering`), so `slotColors` (`export/common.ts:350-362`) never
publishes their colour into `filament_colour`.

The field can absolutely support a specific export assertion. The generic 3MF in
parts mode writes one `<base>` per region with a `displaycolor`, and
`matrix.assert.ts:328-344` already parses it (`generic3mf().materials`, used by
the `color_mode` probe at `:1183`).

Replacement: give `colorProbe` a base of
`{export_target: "generic-3mf", color_mode: "parts"}` merged with its existing
base, and assert
`generic3mf(after.files).materials.find(m => m.name === region)?.color` moves to
the probed hex while the before value differs. Apply it to all ten colour probes
for uniformity, keeping the `filament_colour` clause for the five that have one
by switching those probes to the Bambu target as today. If a single target is
preferred, the alternative is a base that parks the region on an otherwise
unused slot (`colour.region_slots.frame: 5`) so `filament_colour[4]` carries it.

### F4. BLOCKER. `frame_style.corner_radius_mm` asserts only that a count is not equal

`matrix.probes.ts:1491-1503`. Preview: `triangleCount(after) !== triangleCount(before)`
plus `volumeMm3` close to before. Export: `P(after).triangles !== P(before).triangles`.
No direction, no magnitude, no geometry. Any change to the frame's tessellation
passes. The `volumeMm3` clause is a genuine and interesting invariant (an outer
fillet and the matching inner fillet of a rectangular ring cancel exactly), but
it is an invariant, not evidence the radius moved.

The field carries a clean, computable consequence: with corner radius `r` the
outermost point along the diagonal sits at `max(x + y) = 2 * halfPlate - r * (2 - sqrt(2))`.
Going from 3 mm to 9 mm moves it from about 1.76 mm to about 5.27 mm of cut-back.

Replacement, both sides: at the frame's top z, take
`max(x + y)` over the frame vertices (`verticesAtZ` on the preview,
`partExtentAtZ`'s loop shape on the file) and assert it falls by
`(9 - 3) * (2 - Math.sqrt(2))` within 0.1 mm, keeping the unchanged-volume
invariant. The same reader, applied at `r = 0` versus `r = 3`, would also turn
`frame_style.corner` (probe 107) from adequate into airtight.

### F5. BLOCKER. `frame_style.lip_depth_mm`'s assertion is not the ruled semantics

`matrix.probes.ts:1505-1515`. Both sides are `expect(volumeMm3).not.toBe(volumeMm3)`.
That is the numeric spelling of "the hash moved", and it is the only probe in the
table whose failure message reads `expected 9159.310269228274 not to be
9159.310269228274`.

`DECISIONS.md` `[V3.1-P2-2]` rules the exact geometry: a sight-edge rebate on the
frame lip's inner top edge, `lip_depth_mm` deep and `FRAME_SIGHT_EDGE_MM` = 1.0 mm
wide, with 0 meaning a flat lip. The probe as written would go green for an
implementation that changed the frame's OUTER profile, that made the frame
thicker rather than thinner, or that cut a rebate of any width at any depth. It
also does not assert a direction: a deeper rebate must REMOVE frame material.

Replacement, both sides: assert the frame volume FALLS by at least
`(3.0 - 0.4) mm * 1.0 mm * innerPerimeter` minus a corner allowance (roughly
1200 mm3 on the 180 mm plate at the default frame width; the exact bound follows
from `FRAME_SIGHT_EDGE_MM` once it lands), and assert the rebate floor exists:
vertices at `frameTopZ - 3.0` whose plan extent is exactly `2 * 1.0` mm wider
than the lip's inner opening. `verticesAtZ` and `partExtentAtZ` already give
both. Until [V3.1-P2-2] lands the probe stays red either way, so this can be
written now and will pin the ruled shape when the geometry wave arrives.

### F6. BLOCKER. `place.country`, `place.state` and `place.neighbourhood` export assertions are a bare count inequality

`matrix.probes.ts:742-745`, `:757-759`, `:772-774`. Two of the three assert
nothing but `P(after, "frame").triangles !== P(before, "frame").triangles`; the
third adds a sidecar-versus-file consistency check that is not a change
assertion. Fifteen other fields move the frame's triangle count. The direction is
not even claimed.

`place.author` (`:786-790`) shows what these should look like: it reads the 3MF
`Designer` metadata and the sidecar's `provenance.author`. The other three
tokens do not have a metadata slot, but their glyphs do reach the file, and the
substituted strings have different advance widths ("Provo" to "Westia", "Docks"
to "Uptown").

Replacement: assert the engraved line's pocket floor in the FILE moves the way
the preview says the string did. `filePocketFloor(snapshot, "frame", "lettering")`
already exists (`matrix.probes.ts:86-93`) and is used by the `engravings[].edge`
and `.align` probes. For `place.state`, "Landia Westia" is longer than
"Landia Provo", so the pocket floor's x span must widen by a measurable amount at
a centred alignment; assert `to[1] - to[0]` exceeds `from[1] - from[0]` by more
than 1 mm and that the frame's triangle count rises. Same shape for `country` and
`neighbourhood`.

### F7. BLOCKER. `custom_profile.slots` has no effect on any written file

`matrix.probes.ts:1140-1152`. The export assertion is
`warnings(after) toContain "slots this printer does not have"`, which reads
`sidecar.bake_result.warnings`, which is built from the same finding the PREVIEW
assertion already checks. The two sides assert one fact twice.

This is not a shortcut, it is the truth about the field as the code stands:
`bambu3mf.ts:552` calls `slotColors(everyRegion, profile.slots)` and
`export/common.ts:357` computes
`maxSlot = Math.max(slotCount, ...regions.map(r => r.slot), 1)`. With the default
region slots reaching 4, lowering `custom_profile.slots` from 4 to 2 leaves
`maxSlot` at 4, so `filament_colour`, `filament_type`, `filament_settings_id` and
`filament_ids` are all byte-identical. The field currently reaches no exported
byte.

Replacement, keeping both sides specific: probe `custom_profile.slots: 8` with a
base of `{colour: {region_slots: {parks: 6}}}`. Before (4 slots, parks on 6) the
`slot-beyond-profile` finding fires and `filament_colour` has 6 entries; after
(8 slots) the finding is gone and `filament_colour` has 8 entries with
`filament_ids` running 1 to 8. Preview asserts a named finding disappearing,
export asserts the project settings' filament arrays growing. If the wave prefers
to keep the value at 2, then the honest conclusion is that the field has no file
effect and the gate must report it as a defect alongside the other two, not carry
it as a green probe.

### F8. MAJOR. `hero_mode`'s base leaves half the field dormant, and the probe pins the dormancy

`matrix.probes.ts:680-696`, base `HERO` at `:136`
(`{hero_building_ids: ["b-tall"]}`, everything else default).

`solid/buildings.ts:117-124` states the field's two effects: `true_height` and
`both` raise the hero's HEIGHT, `own_color` and `both` give it its own slot and
colour. `transform.ts:467` returns an empty hero set when the mode is not a
true-height mode, so the height half is real. But with `small_scale` and
`large_scale` both at their default 1.0, `hero_height_scale` and
`building_height_scale` coincide, so switching `true_height` to `own_color`
changes nothing but the colour. The probe's
`expect(R(after).volumeMm3).toBeCloseTo(R(before).volumeMm3, 6)` at `:689` does
not merely tolerate that, it PINS it: the probe would go red if the height half
ever started working.

Replacement: base `{hero_building_ids: ["b-tall"], large_scale: 1.6}`. Then
`true_height` holds the hero at scale 1.0 while ordinary buildings are stretched
to 1.6, and `own_color` drops the hero into the ordinary rule. Assert the hero's
roof above the plate falls by a factor of 1.6 AND the slot moves 2 to 4 and the
colour to `#E3A72F`, with the file's hero part showing both. That exercises the
whole field. The third value `both` stays unprobed, which is within the gate's
letter (one non-default value per leaf).

### F9. MAJOR. The rail fixture's way width equals the parameter default, so probe 46 cannot pin the ruling

`matrix.probes.ts:912-923` and `testScenes.ts:45`
(`{ id: "rail-1", path: [[90, -180], [90, 180]], width_m: 6 }`). The default
`regions.rail.width_m` is also 6.0 (`contracts.ts`). The probe writes 14 and
asserts only `spanOf(after) > spanOf(before) * 1.8`, a one-sided lower bound in
the widening direction.

Two consequences. First, on the `before` side the two candidate semantics are
indistinguishable today, which is part of why the defect was invisible for so
long. Second, and worse, **once [V3.1-P2-1] is implemented the probe will go
green for an implementation that does not match the ruling**: `Math.max(way.width_m, param)`
gives max(6, 14) = 14 and passes, as does `way.width_m + param`. The ruling says
the parameter is AUTHORITATIVE, meaning it must also NARROW a wider rail way.

Measured today: before span 2.9199999943 mm, the assertion needs more than
5.256 mm, and the ruled fix yields about 6.8 mm, so the probe will indeed flip to
green. That is the problem, not the reassurance.

Replacement: probe the narrowing direction. Set the value to 3 (below the rail
way's 6 m, and 3 m at this scale is about 1.46 mm, comfortably above the 0.8 mm
minimum-wall clamp) and assert the printed rail x span falls to about half,
`toBeCloseTo(beforeSpan * 3 / 6, 1)`, on both sides. Only an authoritative
parameter passes that; a fallback, a max and a sum all fail it. If the wave wants
the widening direction as well, widen `railScene()`'s way to 12 m and keep the
probe value at 14, which then tests both semantics in one comparison. Note that
changing `testScenes.ts` moves other pipeline fixtures, so the narrowing variant
is the cheaper of the two.

### F10. MAJOR. `force: true` is global, not per probe

`matrix.run.ts:37-51`. `EXPORT_REQUEST` is one module constant carrying
`force: true`, and `build()` at `:196` hands it to EVERY build, `before` and
`after`, for all 124 probes and for the export_target sweep and the exemption
tests. The brief for `[V3.1-P2-3]` and the note both justify forcing for the
handful of probes that deliberately break a Stage 4 row, and that justification
is sound. It does not justify forcing the other roughly 118.

The cost is a suppressed regression channel. If a future change to
`frame_style.separate.enabled` starts producing a floating island, or a
`nozzle_mm` change starts tripping `wall-too-thin`, the matrix writes the bytes
and asserts on them exactly as before and says nothing. Every probe's export is
currently exempt from the gate the product ships.

Only a small set actually needs the flag. From the assertions themselves:
`large_scale` (`exceeds-height`), `custom_profile.max_height_mm`
(`exceeds-height`), `custom_profile.plate_x_mm` and `.plate_y_mm`
(`exceeds-profile-plate`), and plausibly `printer_profile` (a 180 mm plate on a
180 x 180 mm Prusa MINI bed).

Replacement: add `forceExport?: true` to the `Probe` interface, thread it through
`MatrixGroup.run` into `EXPORT_REQUEST`, set it on those four or five probes with
a comment naming the Stage 4 row each one trips, and let the other 119 export
unforced. A probe that then fails because the gate refused is a real finding, and
the failure message already carries the probe's `why` line to explain it.

### F11. MAJOR. `frame_style.shadow_gap.width_mm` and `.depth_mm` have identical assertions

`matrix.probes.ts:1531-1544` and `:1546-1559`. Both assert "base triangle count
unchanged, base volume falls by more than 500 mm3". Width goes 1.0 to 2.5 and
depth 0.8 to 2.0, and both remove roughly the frame's inner perimeter times
1.2 mm2, so each probe passes the other's assertion. An implementation that swapped
the two fields is invisible to the matrix.

Replacement: `depth_mm` asserts the channel FLOOR drops by exactly 1.2 mm
(`verticesAtZ` at `plateTop - depth` on the preview, `partExtentAtZ` at the same
z in the file, and the base part's `bbox.min[2]` is not it, so read the band).
`width_mm` asserts the channel's plan extent at the unchanged floor z widens by
exactly 2 x 1.5 mm. Both readers exist. The unchanged triangle count stays as the
invariant that proves the cutter's facet count did not move.

### F12. MAJOR. `colour.region_slots.attribution` reaches no written file either

`matrix.probes.ts:951-975`. The export assertion walks
`sidecar.findings[].fix.patch.colour.region_slots.attribution`, that is, the
parameter echoed back inside a one-click fix patch inside the sidecar. Nothing in
the 3MF, the STL, the OBJ or the STEP moves, and the note and
`DECISIONS.md` `[V3.1-P2-4]` both say so ("that is a thin effect").

The gate's own wording settles this: a field that cannot be asserted with a
file-specific change is a defect the gate reports, not a probe that goes green.
Carrying it as a passing probe is the one place where the matrix's own standard
is relaxed rather than enforced. Two honest resolutions, both better than the
present state: (a) exempt it under `[V3.1-P1-13]` with the fix-patch echo as the
compensating assertion, which makes the exemption list five and the ruling
explicit, or (b) keep it probed and mark it a third KNOWN DEFECT so the gate
reports it red alongside the other two. Recommendation is (a), because unlike the
rail width and the lip depth there is no geometry anyone intends to build.

### F13. MINOR. `colour.palette` is a fifth echo-only preview leaf the note does not list

`matrix.probes.ts:990-1002`; the note's paragraph at
`docs/handoff/v3-01-matrix.md` section 2 ("Four leaves ... have no geometric
effect by design") names `custom_profile.nozzle_mm`, `custom_profile.change_gcode`,
`color_mode` and `export_target`. `colour.palette`'s preview assertion is
`before.result.params.colour?.palette === "default"` and after `=== "dusk"`,
which is the same echo. Its export side is genuinely specific (the 3MF
`framecraft:palette` metadata entry). `DECISIONS.md` `[V3.1-P1-2]` already says
palette "does so by being written into the sidecar and the 3MF metadata", so the
ruling covers it; the note's count of four should read five, and the sentence
"nobody reads those four rows as weaker versions of the others" should include
palette.

### F14. MINOR. `engravings[].font`'s preview leans on a bare directional count, and its first clause is trivially true

`matrix.probes.ts:480-493`. `expect(resolvedLine(after, "engraving-0")?.text).toBe("Blockton")`
asserts the string did NOT change, which is true before the probe runs; the work
is done by `triangleCount(frame) > triangleCount(frame)`. That is directional, so
it clears the bar, but a serif face has a specific consequence the probe could
name: different advance widths, so the pocket floor's x span at a centred
alignment differs. Add `filePocketFloor` span inequality on both sides, as in F6.

### F15. MINOR. `bridges.abutments`'s export warning check is a one-word substring

`matrix.probes.ts:1302`: `expect(warnings(after)).toContain("bridge")`. The
string "bridge" appears in bridge warnings generally, including the ones
`bridges.enabled` produces. Tighten to the `bridge-unsupported` finding's own
title text, matching the precision of the preview clause at `:1298`.

### F16. MINOR. `custom_profile.change_gcode` parses the layer rows but does not assert them

`matrix.probes.ts:1163-1167` asserts `bambuProject().change_filament_gcode`
(a real settings move, so the probe is SPECIFIC) and then only
`colorChangeLayers(after.files).length > 0`. But `export/colorchange.ts:337`
writes `gcode="${escapeAttr(plan.changeGcode)}"` into every `<layer>` row, and
`colorChangeLayers` already returns that attribute. One extra line
(`expect(colorChangeLayers(after.files).map(l => l.gcode)).toEqual(rows.fill("M601"))`)
covers the second place the field lands in the file.

### F17. MINOR. Ten exported readers in `matrix.assert.ts` are used by nothing

Verified by grep across `apps/web/lib`: `regionOf`, `vertexCount`, `findingIds`,
`planExtentInZ` (`:104`), `bambuBuildItems` (`:305`), `stlBbox` (`:352`),
`objGroups` (`:371`), `stepShells` (`:391`), `zipEntry` (`:397`) and
`sidecarParams` (`:434`) have no caller. This is worth naming not as dead code
but as evidence: `zipEntry` is exactly the reader F2 needs, `stlBbox` would give
the STL target a geometric assertion instead of a triangle count, and
`stepShells` would give STEP one. The readers were built and then not wired up.

### F18. MINOR. The `block` scene at the defaults is built cold three times

`matrix.test.ts:124` (the "block defaults" group), `:150` (the export_target
sweep) and `:199` (the exemptions). Each is a fresh `MatrixGroup.open("block", undefined)`
with its own `StageCache`, so the file pays two extra cold builds it does not
need. Hoisting one shared group into a module-level `beforeAll` would save
roughly 1.5 s of the 108 s. Not urgent, but it contradicts the note's own
argument for keeping the table in one file ("the warm cache per group is what
makes an `after` run partial").

### F19. MINOR. `hanger_magnet.diameter_mm`'s 20 mm3 margin sits close to the analytic delta

`matrix.probes.ts:1705`. Diameter 3 to 4 mm at thickness 2 mm and count 2 gives
`2 * (pi/4) * (16 - 9) * 2 = 22.0 mm3` of extra bore, and a faceted cylinder
undershoots the circle by about 0.3 percent, so the assertion's 20 mm3 threshold
has roughly 2 mm3 of headroom. It passes today and the geometry is deterministic,
so this is not a flake, but a change to the pocket's facet count could move it.
Prefer `toBeCloseTo(22.0, 0)` against the analytic delta, which also pins the
diameter rather than merely its direction.

### F20. MINOR. Coverage of enum leaves is one value deep

`road_mode` probes `"off"` and never `"emboss"`; `frame_style.texture.pattern`
probes `"knurl"` and never `brush`, `hatch` or `dots`; `frame_style.profile`
probes `"chamfer"` out of seven values; `hero_mode` never probes `"both"`;
`engravings[].mode` never probes `"emboss"`. The gate asks for one non-default
value per leaf, so this is within its letter and is recorded only so a later wave
knows the matrix does not prove the enum branches. `export_target` is the
exception and sweeps all seven (`matrix.test.ts:146-189`).

## 4. The five directed checks

**(2) Probe bases.** Every base that the brief named is correct.
`scale_bar.length_m` runs with `length_mode: "fixed"` in `ORNAMENTS` (`:129`)
per `[V3.1-P1-13]`, and both 40 m and 90 m land inside the 15 to 40 mm printed
window at 1:2381. `hanger_magnet.*` runs with `frame_style.separate.enabled` and
mount `magnet` (`SEPARATE_MAGNET`, `:147`), which is the correct reading of
`[V3.1-P2-5]`, not `hanger: "magnets"`. `tiling.tolerance_mm` runs on `TILED`
with 2 x 2 tiles. `terrain.smoothing` runs on the terrain scene with
`TERRAIN_ON`, and `sceneSetup` (`matrix.run.ts:68`) forces the GRID's own
`smoothing` to 0 so the parameter is the only smoother in play, which is a
better base than the brief asked for. `regions.rail.*` runs on the rail scene.
`hero_mode` runs with a hero present. Two bases are nonetheless defective:
`hero_mode` leaves the height half asleep (F8) and `custom_profile.slots` leaves
the region slots at defaults so the field cannot reach the file (F7). A third,
`regions.rail.width_m`, has a fixture whose way width coincides with the
parameter default (F9).

**(3) Real file parsing.** Confirmed throughout, with no string-contains on zip
bytes anywhere. `bambuParts` (`matrix.assert.ts:254`) unzips and XML-parses BOTH
`Metadata/model_settings.config` and `3D/Objects/object_1.model`, joins them by
part id, and computes each part's volume by a divergence sum over the file's own
triangles (`:210-228`), never copied off the `EngineResult`. `bambuProject`
JSON-parses `Metadata/project_settings.config`. `bambuMetadata` and `generic3mf`
XML-parse the model document. `stlTriangles` reads the binary header count with a
`DataView` at `STL_HEADER_BYTES`. `colorChangeLayers` XML-parses
`Metadata/custom_gcode_per_layer.xml`. `zipNames` goes through `unzipAll`. The
only substring checks are `sidecarWarnings().join(" ")` (a sidecar text field,
correctly used as a warning check, though see F15) and the sweep's
`ISO-10303-21` header read over the STEP file's first 20 bytes, which is what a
STEP header is. The one gap is the tile zip (F2).

**(4) The exemption test.** PASS, and it is tighter than the note claims. The
size is pinned (`matrix.test.ts:84`, `EXEMPT.size === 10`), every reason must
match `/^\[V3\.1-P1-(2|13)\]/` (`:86`), no exempt path may also be probed
(`:87`), and each of the ten keys is separately pinned by a
`EXEMPT.get(path)` assertion that throws on `undefined`: `schema_version` at
`:209`, `colour.preview_theme` at `:218`, `colour.region_colors.attribution` at
`:226`, and the seven `part_colors.*` at `:235`. So the list is exactly the four
rulings expanded. All four compensating assertions the note lists are present:
the sidecar echo 3 to 2 with the region list unchanged (`:210-213`), the
`preview_theme` echo with `stats.triangles` unchanged (`:219-222`), and the
`claimedPaths()` checks for the attribution colour and the seven v1 colours
(`:228-237`), including the positive check that
`colour.region_slots.attribution` IS claimed. The only slack is that the note
cites `share.test.ts` as the version gate's compensating test and the matrix does
not reference it; `apps/web/lib/share.test.ts` does exist.

**(5) `force: true`.** Global, not per probe. See F10. The gate's refusal path is
NOT asserted by any matrix probe, and does not need to be:
`pipeline/exportGate.test.ts:41-61` runs an unforced export of a model that trips
`exceeds-height`, asserts `status === "error"`, `error.stage === "export"`, the
message names the finding, no `files` event was emitted, and `files` is null,
then re-runs with `force: true` and asserts the bytes arrive with the error
finding still on the result. That is the correct division of labour.

**(6) The coverage guard.** Verified by reading, and the mechanism is sound.
`matrix.test.ts:79-80` computes
`PRINT_PARAM_LEAF_PATHS.filter(p => !probed.has(p) && !EXEMPT.has(p))` and
expects `[]` with the message "these leaves have neither a probe nor an
exemption". `PRINT_PARAM_LEAF_PATHS` is generated by `make contracts`
(`contracts.ts:735-871`, 134 entries), so a schema addition lands in that list
mechanically and the test goes red until it gets a probe or an exemption; and
because `EXEMPT.size` is pinned at 10 and every reason must carry one of the two
ruling ids, the escape hatch of quietly exempting the new leaf is closed too. The
sibling guards are real as well: duplicate probes fail at `:75`, a probe path
that is not a schema leaf fails at `:77`, a probe whose value equals what its
base already holds fails at `:99-111`, and a `why` string mentioning hash, bytes
moved or differs fails at `:95`. The one thing the guard cannot see is a probe
whose assertions are true regardless, which is what section 2 of this document is
for, and F5 shows that hole is not theoretical.

**(7) The two KNOWN DEFECT rows.** They fail, loudly, and they name the defect.
`check()` at `matrix.test.ts:53-66` catches the assertion error and rethrows with
`KNOWN DEFECT (docs/handoff/v3-01-matrix.md): <reason>` in front of the probe's
path, value, side and `why` line. The observed output for both rows carries the
full sentence. On whether they flip green automatically: `regions.rail.width_m`
will, and that is finding F9's problem, because it will also flip green for two
implementations that contradict `[V3.1-P2-1]`. `frame_style.lip_depth_mm` will
flip green on any change that moves the frame volume by any amount in any
direction, which does not pin `[V3.1-P2-2]`'s 1.0 mm by `lip_depth_mm` sight-edge
rebate at all (F5). Neither probe's assertion is currently the right one for the
ruled semantics.

**(8) Run time and determinism.** 107.7 s measured here with other agents
building, inside the three-minute budget and consistent with the note's four
recorded runs. The file prints its own elapsed time. Determinism is sound:
`MatrixGroup.run` (`matrix.run.ts:171-175`) clones the group's base params for
every probe, so no parameter leaks between probes; `MATRIX_DATE` and a fixed
`createdIso` keep the clock out of the files; the `before` snapshot holds plain
typed arrays extracted from the kernel, so it survives the cache moving on. There
is no probe order dependence in the assertions, and the one asymmetry (the
`before` build is cold, every `after` is warm) can only produce loud failures,
not silent passes, because every probe pairs its "unchanged" clauses with a
"changed" clause. Floating tolerances are mostly generous; the two worth naming
are the 20 mm3 magnet margin (F19) and `frame_style.corner`'s
`expect(P(after).bbox).toEqual(P(before).bbox)` at `:1487`, an exact deep
equality on floats parsed out of the model XML, which holds today because both
sides serialise the same decimals but would break on a sub-micron shift.

## 5. Verdict

**The matrix is strong evidence for gate V3-1 and it is not yet sufficient
evidence.** 109 of 124 preview assertions and 101 of 124 export assertions name a
real physical consequence of their field, the file readers parse actual zip, XML,
JSON and binary content rather than searching bytes, the coverage guard genuinely
closes against schema additions, the exemption list is exactly the four rulings
with all four compensating assertions present, and the two dead fields fail red
with their defect named instead of being skipped. That is a better matrix than
the gate's wording demanded.

The gap is that 24 leaves are proved by an assertion another field would also
satisfy, and 7 blocker findings cover 22 of them: eight `heights.*` leaves that
are mutually indistinguishable (F1), three tile files proved by a zip's byte
length when the unzip reader is already written and unused (F2), five region
colours whose only export trace is a sidecar echo (F3), two frame leaves proved
by `not.toBe` (F4, F5), three `place.*` tokens proved by an undirected triangle
count (F6), and one printer field that reaches no exported byte at all (F7). Two
further leaves are proved in a state where the field is half asleep (F8) or where
the fixture cannot distinguish the ruled semantics from two wrong ones (F9), and
every probe's export currently bypasses the shipped export gate (F10).

None of that is a reason to reopen the design. Every blocker has a named
replacement assertion, most of them use readers that already exist in
`matrix.assert.ts`, and none requires new engine geometry except the two that are
already ruled in `[V3.1-P2-1]` and `[V3.1-P2-2]`. Recommendation: land F1 through
F7 and F9 before the gate is called green, treat F8, F10, F11 and F12 as the same
wave's cleanup, and record F12's ruling (exempt the attribution slot or mark it a
third defect) in `DECISIONS.md`, because the present handling is the one place
where the matrix applies a lower standard than the one it enforces on everything
else.

## 6. Fixes (matrix test agent, after the audit)

Every finding below was landed in `apps/web/lib/engine/pipeline/matrix.{assert,run,probes,test}.ts`
and `pipeline/fixtures/overpassBlock.ts`. `testScenes.ts` was not touched: the
one finding that suggested changing it (F9) took the cheaper narrowing variant
the audit itself preferred. Measured after the fixes:

```
npx vitest run lib/engine/pipeline/matrix.test.ts
matrix: 124 probes in 138.3 s
     Tests  2 failed | 130 passed (132)
```

The two failures are the two ruled dead fields, and both now fail on the RULED
geometry rather than on a `not.toBe`.

| side | SPECIFIC | WEAK | was WEAK |
|---|---|---|---|
| preview | 119 | 5 | 15 |
| export | 123 | 1 | 23 |

### F1. Eight `heights.*` probes, fixed

`maxZOverFootprint` landed in `matrix.assert.ts`, and
`fixtures/overpassBlock.ts` now exports `OSM_FOOTPRINTS` (each type's plan
centre, the leaf that decides it and that leaf's default) plus
`OSM_BUILDING_SIZE_M` and `OSM_LEVELS`, with the eight ways built from that
table. `heightProbe` takes the footprint name and reads the roof over THAT 46 m
square, on the `EngineResult` and again out of the written 3MF's own vertices
through `buildOffset`. It asserts the roof rises by the metres the leaf moved
times the printed scale, inside the 6 percent the height jitter can add, and
that the roof over a CONTROL square (`unknown`, or `house` for the unknown
probe) does not move at all. `heights.floor_height_m` is the same probe with a
`levelsFactor` of `OSM_LEVELS`. The `bodies` invariant stayed.

### F2. Three `tiling.*` export assertions, fixed

`bambuParts` was split: `bambuPartsOf(bytes)` takes raw 3MF bytes, and
`bambuParts(files)` is that over `onlyFile`. `matrix.probes.ts` gained
`tilePart(snapshot, label, region)`, which pulls `framecraft-A1.3mf` out of the
zip with the previously unused `zipEntry` and reads its own
`model_settings.config` and sub-model. `joint` asserts tile A1's base triangle
count rises and its volume moves; `tolerance_mm` asserts tiles A1 and B1 lose
base volume; `index_mark` asserts all four tiles lose base triangles. No byte
length is compared anywhere.

### F3. Five `colour.region_colors.*` with no export effect, fixed

`colorProbe` now takes the slot whose `filament_colour` entry must carry the
swatch, plus a `solo` marker. The five regions that are never first on their
default slot (`frame`, `matting`, `parks`, `rail`, `lettering`) get a base that
parks them on a slot of their own (5, 7, 6, 6, 7), so `slotColors` publishes
their colour and the probe asserts `filament_colour[slot - 1]` moves from the
default swatch to the probed hex. All ten colour probes additionally call
`expectSlotColourComesFromTheFirstRegion`, which finds a slot genuinely shared
by two built regions of different colours and asserts the file loaded the FIRST
one's swatch there and not the second's. That is the shipped rule
(`export/common.ts:slotColors`) asserted in the file, in both snapshots.

### F4. `frame_style.corner_radius_mm`, fixed

`maxXPlusY` landed in `matrix.assert.ts`. The probe asserts the outer corner is
pulled back along its diagonal by exactly `(9 - 3) * (2 - sqrt(2))` = 3.5147 mm,
to three decimals, on the preview and in the file. Measured: 3.5147 on both
sides, so the analytic value is exact here and the tolerance is real. The
unchanged-volume invariant stayed. `frame_style.corner` (probe 107) took the
same treatment at `r = 3`: pull-back exactly `3 * (2 - sqrt(2))` = 1.7574 mm,
measured 1.7574.

### F5. `frame_style.lip_depth_mm`, fixed to the ruled shape

The probe value moved from 3.0 to 1.5 mm (3.0 is deeper than the 2.2 mm lip it
would be cut into). It now asserts the three things `[V3.1-P2-2]` rules: the
frame loses more than 400 mm3 of section, the rebate FLOOR is at `frameTop - 1.5`
in the after and at `frameTop - 0.4` in the before, and that floor is exactly
`FRAME_SIGHT_EDGE_MM` = 1.0 mm wide, read as a ring with `ringAt`. Same three in
the written file. It still fails, on the volume clause, and the failure now names
the ruling instead of printing `expected X not to be X`.

### F6. Three `place.*` export assertions, fixed

`letteringSpan(snapshot, where, edge)` landed in `matrix.probes.ts`: the x span
of the glyph pocket floors on ONE frame edge, with the edge picked by a plan
window on the recess band's z. `country` and `state` assert the top edge's span
widens by more than 1 mm while the bottom edge's is unchanged to six decimals;
`neighbourhood` asserts the opposite pair; `place.author` gained the narrowing
clause ("Bee" is shorter than "Tess"). Measured widenings: country 1.605 mm,
state 1.703 mm, neighbourhood 2.898 mm, identical in the preview and the file.

### F7. `custom_profile.slots`, fixed

The probe is now 4 to 8 on a base that parks `parks` on slot 6
(`SLOT_SIX`). Before: `slot-beyond-profile` fires and `filament_colour` has six
entries. After: the finding is gone and `filament_colour`, `filament_type` and
`filament_settings_id` all have eight. The field reaches the file.

### F8. `hero_mode`'s dormant half, fixed

The base is now `HERO_SHORT` (`hero_building_ids` plus `large_scale: 0.6`),
because `hero_height_scale` is `max(1.0, building_height_scale)` and only a
class multiplier BELOW 1.0 separates the two rules. `true_height` holds the
hero's roof at 30.240 mm over the plate; `own_color` drops it to 18.144 mm,
exactly 0.6 of it, while the slot moves 2 to 4 and the colour to `#E3A72F`. Both
halves are asserted, on the preview and in the file, and the probe no longer
pins the height half asleep.

### F9. `regions.rail.width_m`'s one-sided assertion, fixed

The probe drives the parameter DOWN, to 3 m against the way's 6 m, and asserts
the printed rail x span moves by exactly `(3 - 6) * mmPerM` = -1.26 mm, to two
decimals, on both sides. A fallback moves nothing, `max(way, param)` moves
nothing and a sum widens, so only the authoritative parameter `[V3.1-P2-1]`
rules passes. `testScenes.ts` was left alone.

### F10. Global `force: true`, fixed

`Probe` gained `forceExport?: true`, `MatrixGroup.run` takes the flag,
`EXPORT_REQUEST` no longer carries it, and `MatrixGroup.open` takes its own so a
group whose BASE tripped a row would have to say so. Two probes carry it and
each names the row: `large_scale` and `custom_profile.max_height_mm`, both
`exceeds-height`. Verified by running every flagged probe unforced:
`bridges.abutments` was also flagged at first and the gate ALLOWED it (the loose
deck is raised at `warning`), so the flag came off. The other 122 probes, the
export_target sweep and the exemption checks all export through the shipped gate.

### F11. `frame_style.shadow_gap.width_mm` and `.depth_mm`, fixed

`ringAt(positions, z, centreX, minAbsX, tol)` landed, reading a rectangular ring
from the plate centre and dropping geometry nearer the middle, which separates
the gap from the road and park recesses that share its z. `width_mm` asserts the
ring's OUTER edge is unchanged to six decimals and its inner edge moves in by
exactly 1.5 mm, at the unchanged floor z. `depth_mm` asserts the floor is at
`plateTop - 0.8` before and absent there after, present at `plateTop - 2.0`
after and absent there before, and still exactly 1.0 mm wide. Neither probe can
now pass the other's assertion. A `SLICE_TOL_MM` of 0.01 mm is used to find a cut
face, because the kernel returns a 0.8 mm channel floor at z = 5.199951.

### F12. `colour.region_slots.attribution`, NOT changed

`DECISIONS.md` `[V3.1-P2-4]` rules this leaf probed rather than exempt, with the
`slot-beyond-profile` fix patch as its effect, and that ruling was appended after
the matrix landed. The audit's own two resolutions both need a ruling that
supersedes it, so the probe is unchanged and this is now the ONE remaining WEAK
export assertion in the table. It is recorded as a defect in
`docs/handoff/v3-01-matrix.md` section 5 with both resolutions named, so the next
wave can settle it in one line.

### F13. The note's echo-only count, fixed

`docs/handoff/v3-01-matrix.md` section 2 now names five leaves, `colour.palette`
included, and cites `[V3.1-P1-2]` for it.

### F14. `engravings[].font`, fixed

The probe asserts the top edge's pocket span widens by more than 0.1 mm (a
serif face has wider advances at the same cap height; measured 15.933 to 16.073)
on the preview and in the file, keeps the rising triangle count, and keeps the
unchanged string and cap height explicitly as the invariants that isolate the
face.

### F15. `bridges.abutments`'s warning check, fixed

It now asserts the `bridge-unsupported` finding's own words with abutments off
("have nothing holding them up" and "Abutments are switched off") and that the
before side carries neither.

### F16. `custom_profile.change_gcode`'s layer rows, fixed

The probe asserts every row of `custom_gcode_per_layer.xml` carries `M601` after
and `M600` before, alongside the `change_filament_gcode` settings entry.

### F17. Ten unused readers, resolved

`vertexCount`, `findingIds`, `sidecarParams` and `planExtentInZ` were deleted;
`planExtentInZ` is replaced by the more general `extentAtZ(positions, z, tol,
window)`, which `partExtentAtZ` now delegates to. `zipEntry` is used by F2's
`tilePart`. `stlBbox`, `objGroups`, `stepShells` and `bambuBuildItems` are used
by the `export_target` sweep, which now also asserts the STL body's 180 mm span
and its zero base, one `MANIFOLD_SOLID_BREP` for the single-colour STEP, a
`base` group in the OBJ, one build item and a real base mesh in the Bambu
project, and more than one `.stl` inside the parts zip. `regionOf` stays: it is
what `mustRegion` is built on.

### F18. Three cold builds of the block defaults, fixed

`matrix.test.ts` holds one lazily opened `sharedBlock` group used by the
"block defaults" probe group, the `export_target` sweep and the exemption
checks, disposed by the file's own `afterAll`.

### F19. The magnet bore margin, fixed

`hanger_magnet.diameter_mm` asserts the frame and the plate each lose
`MAGNET_BORE_DELTA_MM3` = 45.31 mm3 to one decimal, the measured bore delta for
eight pockets (`count` per side, four sides) at `pi/4 * (4^2 - 3^2)` = 5.498 mm2
each over the frame's roughly 1.03 mm share of the 2 mm magnet. The probe now
pins the diameter, not its direction.

### F20. Enum depth, accepted

Unchanged, and recorded in `docs/handoff/v3-01-matrix.md` as a known limit: the
gate asks for one non-default value per leaf, `export_target` sweeps all seven,
and the other enums are one value deep.

## 7. Readings changed by the Task 7 geometry wave (`[V3.1-P2-2]`)

Appended by the engine performance agent, on the orchestrator's ruling that
the wave owns these readings on one standard: each asks the same physical
question about the same field, more precisely, and still fails if the field
stops working. The full account, with the measured numbers, is section 6 of
`docs/handoff/v3-07-perf.md`. Two facts of the contract, not of the probes,
forced them: the default engraving depth and the default sight-edge rebate
depth are both 0.4 mm, so a lettering pocket's floor and the rebate's floor
share a plane; and the mandatory inner-wall attribution's glyphs occupy the
opening's walls between z 3.15 and 4.45 mm on every default lip (3.15 to 4.85
before the rebate), so a whole-plane count at `top - 1.5` was never empty.

| probe | reading before | reading after | why |
|---|---|---|---|
| `frame_style.lip_depth_mm` | `ringAt` over the whole plane: a ring at `top - 0.4` before, none at `top - 1.5` before, a 1.00 mm ring at `top - 1.5` after; the volume line | `cornerRingAt`: the same reads restricted to the plate's four corner squares (at least `innerHalf - 1` from the centre on both axes), plus the default's floor gone after; volume line unchanged, preview and file | the rebate floor's vertices are its eight corners, inside the corner squares; the attribution glyphs are at the opening's half-width on one axis only, so both axes are banded |
| `engravings[].edge`, `engravings[].align` | `pocketFloor`, `filePocketFloor`: every vertex on the pocket floor's plane | on the frame, only the vertices on the lip's flat face (`max(abs x, abs y)` at least `innerHalf + 1 + 0.25`); thresholds unchanged | the rebate floor's corners at 84 and 85 mm made every pocket read 170 mm wide |
| `engravings[].font`, `place.country`, `place.state`, `place.neighbourhood`, `place.author` | `letteringSpan`: a y half-plane window | the same window over flat-face vertices only; thresholds unchanged | as above |
| `engravings[].size_mm = 7` | after reports over 6 | after over 4, under 7, and 5.41 to two decimals (the band-limited fit of "Blockton" in sans on the 4 mm band) | the band is 4 mm, not 5, since the layout keeps clear of the rebate |
| `north_arrow.size_mm = 2` | before (a 6 mm request) reports over 4 | before 3.43 to two decimals and equal to `north_arrow_max_size_mm`; after 2, under before | the cap on the 4 mm band is 3.43 mm |

`KNOWN_DEFECTS` is empty: both fields landed and their probes pass on their
own. F17's `extentAtZ` is no longer imported by `matrix.probes.ts`
(`letteringSpan` reads the flat face through its own extent); it stays in
`matrix.assert.ts` for `partExtentAtZ`.
