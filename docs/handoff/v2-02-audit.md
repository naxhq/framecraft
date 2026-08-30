# v2-02 audit — adversarial review of the parts colour export and the hero bake half

Auditor: independent (did not write the code under review). Tree read at
`services/bake/app` md5-pinned at the start of the audit; re-checked at the end —
**no file under audit changed during the review**. Concurrent churn from the
lettering agent is confined to new files (`app/geom/lettering.py`, `app/fonts/`,
`pyproject.toml`, `uv.lock`); none of it touches the code below.

Artifacts examined as shipped: `artifacts/chicago-parts.3mf` (+ `.stl`, `.json`,
plate 256, seven parts) and `artifacts/chicago.3mf` (single, plate 180).
All geometry measurements below were re-derived from `fixtures/chicago-scene.json`
at **plate 180, defaults, `color_mode="parts"`** unless stated otherwise, so the
single-mode and parts-mode numbers are directly comparable.

Scratch scripts (not part of the repo):
`…/scratchpad/{partition.py,attribute.py,corrupt.py}`.

---

## What is correct

Stated up front so the findings are read in proportion.

* The shipped `chicago-parts.3mf` is a structurally valid multi-material 3MF:
  one `<basematerials id="1">` with one `<base>` per part, seven mesh objects
  `id=2..8` each carrying `pid="1"` and a distinct in-range `pindex`, one
  assembly object `id="9"` holding seven `<component>`s, exactly one
  `<build><item objectid="9"/></build>`, `unit="millimeter"`, resources declared
  before they are referenced, no self-reference, and the OSM attribution intact
  in `Description`. No mesh object is separately referenced by the build.
  `trimesh.load` returns a `Scene` with exactly 7 geometries.
* The base-pocket / inlay geometry is exactly as documented. Measured slice
  areas at plate 180 (mm²): base is the full 32 400 up to z=1.95, drops to
  20 856.93 at 2.05 (road pocket opens at 2.0) and to 17 133.85 at 2.15 (water
  pocket opens at 2.1) and stays there to 2.9. Road inlay occupies
  [1.8, 2.4], water inlay [1.9, 2.5], each overlapping solid base by exactly
  0.2 mm before its pocket begins. `base ∩ frame` = 835.200 mm³ = the frame ring
  area × exactly 0.2 mm.
* **No two parts meet on a coincident vertical face.** Every zero-volume pair in
  the intersection matrix (`frame×buildings`, `frame×green`, `buildings×green`,
  `buildings×roads`, `roads×green`, `water×green`) is a genuine 0.02 mm
  (`LAYER_SEPARATION_MM`) or 0.05 mm (`CROP_INSET_MM`) gap, not a shared face.
* **The parts lose nothing.** `single − union` = 0.00000000 mm³ (41 shells, all
  of zero volume). The parts are a superset, never a subset — see finding 4.
* Hero bake half works end to end. A `hero_mode=both`, `small/large_scale=0.5`
  bake with heroes `w64388609` (340 m), `w28292694` (32 m, buried) and one
  bogus id produced: a part named `hero:w64388609` with its own `<base
  displaycolor="#E3A72FFF"/>` at `pindex=3`, sorted between `buildings` and
  `roads` per `PART_ORDER`; model height 34.733 mm = 340 m × 0.09333 mm/m + 3 mm,
  i.e. the hero kept true height while every neighbour halved; and the two
  warnings `…hero building ids are not in this scene and were ignored:
  w-does-not-exist` and `…hero buildings are shorter than the block they merged
  into…: w28292694`. No crash on either edge case.
* **`fixtures/parity-expected.json` is genuinely additive.** Parsed both
  revisions and walked them key by key: **0 committed values changed or
  removed**; 13 new per-case keys and 516 new per-building keys, plus the fourth
  case. Verified, not taken on trust.
* **G8 green.** `uv run pytest tests/test_v1_compat.py` → 11 passed in 19.5 s.
  The golden was generated from a clean worktree of `da9ab83`, not re-recorded.
* **Test integrity holds.** `git diff -- '*test*'` introduces no `skip`, no
  `xfail`, and no widened tolerance. The four removed assertions are all
  replaced by strictly stronger ones (`len(cases) == 3` → `== 4` plus new
  nozzle-multiple assertions; `"watertight" in out.splitlines()[-1]` → the
  `FAILED:` summary line *and* a `watertight: … is_watertight=False` message
  line).
* **Single mode is untouched.** `make validate artifacts/chicago.3mf` still
  reports `3mf_objects PASS 1 / 1` and `bodies PASS 1 / 1`; the single-mode
  solid has 68 692 triangles in *both* modes, bit-for-bit the same count.
* Parts-mode STL is one welded body: `make validate artifacts/chicago-parts.stl`
  → ALL CHECKS PASS, `bodies PASS 1`.
* Corrupt-file rejection is good in eight of ten cases: a sidecar/file colour-mode
  disagreement (either direction), `pindex` out of range, an unknown `pid`, a
  `displaycolor="#FFF"`, a deleted `<basematerials>`, two build items, a build
  item pointing at a mesh object, a self-referencing component, an orphan mesh
  object, a floating debris shell, inverted normals on a part, and a wholly
  disconnected part are **all** correctly failed. The two that are not are
  findings 2 and 3.

---

## Findings

### 1. MAJOR — two colour parts own the same recess floor, with an exactly coincident top face, wherever an engraved road crosses water

`services/bake/app/geom/assemble.py:511-525` (the `for layer, polys, z, _cutter
in recesses:` loop, specifically the `others` subtraction at 522-524).

Each inlay is differenced against every *other* recess's single-mode **cutter**.
The road cutter spans `[2.4, 3.5]` and the water inlay spans `[1.9, 2.5]`, so
that subtraction removes only the water inlay's top 0.1 mm over the road
footprint. It does not remove the water inlay from that region — it **truncates
it to exactly the road inlay's own top plane, z = 2.4**.

Measured at plate 180:

```
water ∩ roads               262.2468 mm³, z 1.9 .. 2.4   (524.5 mm² doubly owned)
water part top z            2.5000      roads part top z  2.4000
water cross-section z=2.39  4205.5519 mm²
water cross-section z=2.41  3807.1591 mm²   ->  398.4 mm² of water tops out at 2.4
roads cross-section z=2.39 13565.3524 mm²
roads cross-section z=2.41     0.0000 mm²   ->  the whole road part tops out at 2.4
```

So over 398.4 mm² — 9.5 % of the water part's surface — the water part and the
road part present **the same horizontal top face at exactly z = 2.4** and fully
interpenetrate for 0.5 mm below it. Which filament prints the visible groove
floor where a road crosses the Chicago River is left to the slicer to arbitrate.
That is precisely the failure mode the 0.2 mm interpenetration rule exists to
prevent, and unlike every other coincident face in this design it is on a
**visible printed surface**, not buried inside the base.

The claim it contradicts is explicit:
`docs/handoff/v2-02-color.md:88-90` — "the deeper recess owns the floor where
they overlap"; `DECISIONS.md:236` — same wording. The second half of both
sentences ("no inlay can stand proud of the model") *is* satisfied; the
ownership half is not.

`tests/test_bake.py::test_parts_z_ranges_interpenetrate_by_the_04_overlap`
cannot catch this: it asserts on each part's **bounding box** z-extremes
(`git diff` lines 4143-4144 assert `z[name][1] == floor` and `z[name][0] ==
floor - PART_INLAY_MM`), and the water part's bbox top is 2.5 — the truncated
region is interior to the bbox.

Reproduce:

```sh
cd services/bake && uv run python <scratchpad>/attribute.py 180
# section "recess floor ownership where roads and water overlap"
```

The fix is in `color_parts`: subtract the other recess's **inlay** (or the other
recess polygons) rather than its cutter, so the deeper inlay genuinely owns the
shared footprint. Not applied — audit only.

---

### 2. MAJOR — a parts 3MF that references one part twice and another not at all passes every validator

`services/bake/app/cli.py:636-645` and `services/bake/app/validate/checks.py:641-648`.

`_threemf_parts_checks` walks `<component>` children, resolves each `objectid`,
and then checks only a **count**: `if children and len(children) != len(meshes)`
(cli.py:644). It never checks that the referenced ids are *distinct*, and never
checks that every mesh object is referenced. `validate_parts`'s `bodies` row is
the same count comparison (`components == len(parts)`, checks.py:646).

A file whose `<components>` reads
`<component objectid="3"/><component objectid="3"/>` — the buildings part twice,
the base part never — is a file a slicer builds with two towers and no base
plate. It validates:

```
[duplicate_component       ] rc=0  ALL CHECKS PASS
   bodies             PASS    2 parts, 2 shells, union 1
   3mf_components     PASS    2 components   1 build item -> 1 assembly -> N mesh objects
   3mf_counts         PASS    xml 16 v / 24 t   parts 16 v / 24 t
```

`3mf_counts` cannot help: it sums the XML's vertices/triangles over *all* mesh
objects and compares against the geometries `trimesh` loaded, which is also all
mesh objects — neither side reads the build graph.

Reproduce: `cd services/bake && uv run python <scratchpad>/corrupt.py`
(case `duplicate_component`; the script builds a clean two-part file first and
confirms it passes, then rewrites only the `<components>` element and re-zips).

---

### 3. MAJOR — a `<component transform="…">` that displaces a part is ignored; the validator judges a union that is not the object the slicer assembles

`services/bake/app/cli.py:636-643` (the component loop reads `objectid` only) and
`services/bake/app/cli.py:915-944` (`_parts_union_mesh` unions the part meshes in
their *local* coordinates).

3MF lets a `<component>` carry a `transform` matrix. FrameCraft's own writer
never emits one, so shipped artifacts are unaffected — but `make validate` is
the tool for judging an arbitrary file, and it silently validates the wrong
geometry. Injecting `transform="1 0 0 0 1 0 0 0 1 25 0 0"` (translate the
buildings part 25 mm in X, which disconnects it from the base) gives:

```
[component_transform   ] rc=0 ALL CHECKS PASS
```

`bodies`, `parts_union`, `min_wall`, `bounding_box` and `sits_at_zero` are all
computed from the untransformed meshes, so a two-body model reads as one solid
sitting on the bed. `docs/handoff/v2-02-color.md:250-253` names exactly this as
a manual-check failure mode ("any part offset from the others (means the shared
translation was lost)") and lists `3mf_components` among the automated proxies
for A6. It is not one. Either read and apply the transform, or fail any file
that carries a non-identity one.

Reproduce: the second scratch block in the transcript, or add
`transform="1 0 0 0 1 0 0 0 1 25 0 0"` to a `<component>` of
`<scratchpad>/corrupt/clean.3mf` and re-run `app.cli validate`.

---

### 4. MAJOR — the parts do NOT partition the single-mode solid, and `parts_union` structurally cannot detect it

`services/bake/app/validate/checks.py:705-729` (the check) and
`services/bake/app/geom/assemble.py:496-529` (the cause).

`color_parts` applies the recess cutters **only to the base part**
(assemble.py:485-493). The `buildings`, `green`, `trees` and embossed-road parts
are emitted from the raw primitives (assemble.py:506, 526-529) and are never cut.
Single mode subtracts those cutters from the *whole* additive union
(assemble.py:364-370). Wherever a cutter overlaps an additive layer the two
modes therefore disagree.

That overlap is not hypothetical. `thicken.merge_recess_ridges`
(`services/bake/app/geom/thicken.py:1443-1522`, the bridge union at 1496-1517)
grows unprintable base islands by `RIDGE_BRIDGE_CELLS * grid` and unions them
into the road layer **without re-subtracting the buildings**, undoing the 0.02 mm
`separate()` clearance that `repair_roads` established. Measured at plate 180:

```
roads ∩ buildings                    1.552827 m² of ground
union − single                       0.00946880 mm³  in 66 bodies
   of which inside the road cutter   0.00946879 mm³   (99.9999 %)
   of which inside the water cutter  0.00000000 mm³
single − union                       0.00000000 mm³
attributed to the buildings part     0.00946879 mm³   bbox z 2.8 .. 9.371
```

1.55 m² × (0.09333 mm/m)² × ~0.7 mm ≈ 0.0095 mm³ — the arithmetic closes
exactly. This is a **systematic** discrepancy with a named geometric cause, not
floating-point noise: the shipped `.3mf` carries slivers of building wall
(0.02 mm thick, the layer-separation distance) that the `.stl` of the same bake
does not.

`parts_union` cannot see it, and could not see a much larger one:

* it compares **volume and bounding box only** (checks.py:708-712), so equal-and-
  opposite errors cancel exactly;
* its budget is `1e-6` relative = **0.1676 mm³** on this model, **17.7×** the
  real error already present. Nothing bounds the error: a ridge bridge landing
  on a larger building scales it linearly and the row keeps passing.

The claims this contradicts are unqualified: `DECISIONS.md:233` — "parts mode
PARTITIONS the single-mode solid"; `docs/handoff/v2-02-color.md:92-97` — "**The
parts partition the model.** `base_part ∪ inlay = base_solid − cutter` exactly,
by construction". The *base* identity is genuinely exact and verified above; the
whole-model partition is not, because the cutters also cut the buildings.

Practical print impact is nil (0.0135 mm² of footprint, far under one nozzle
bead), and `make validate` on the parts file does judge the union so the extra
material is min-wall-probed there. The defect is that the gate which is the sole
proof of the headline property does not test that property. A symmetric-
difference test (`vol(A−B) + vol(B−A) == 0`) costs two booleans and is exact.

Reproduce:

```sh
cd services/bake && uv run python <scratchpad>/partition.py 180
cd services/bake && uv run python <scratchpad>/attribute.py 180
```

---

### 5. MAJOR — the bake never validates the 3MF container it just wrote; the handoff says it does

`services/bake/app/bake.py:273-282`.

The bake appends only `validate_parts(...)`, which yields exactly three rows:
`bodies`, `part_meshes`, `parts_union`. Confirmed against the shipped sidecar:

```
$ python -c "...json.load(open('artifacts/chicago-parts.json'))['validation']"
['manifold','watertight','volume','self_intersection','bounding_box',
 'sits_at_zero','min_wall','triangle_budget','degenerate_faces',
 'bodies','part_meshes','parts_union']
```

`3mf_materials`, `3mf_components`, `3mf_color_mode`, `3mf_objects`,
`3mf_build_items`, `3mf_counts`, `3mf_unit` and `3mf_attribution` live only in
`app/cli.py` and run only under `make validate`. `docs/handoff/v2-02-color.md:100`
introduces the table of six rows with "In the bake (`checks.validate_parts`,
appended to the Stage 4 report **only** in parts mode) **and** in `app.cli
validate`" — three of those six never run in the bake.

This matters on the product path, not the fixture path: `POST /bake` marks a job
`done` on `report.passed` alone (bake.py:298), so a web-app user downloads a
`.3mf` whose material table, component graph and build item were never checked.
`write_3mf_parts` guards duplicate names, empty parts and unparseable colours
(mf3.py:298-310), which is real but is not the same set of rows. The remedy is
one call: run `cli._threemf_parts_checks` on `mf3_path` before deciding
`report.passed`.

---

### 6. MINOR — 04's triangle budget is not enforced on the shipped `.3mf` in parts mode

`services/bake/app/bake.py:221-234`.

`enforce_triangle_budget` reduces the single-mode `mesh` (which becomes the
`.stl`); the parts are deliberately left un-decimated so the partition survives,
and a warning is appended. But `triangle_budget` is then evaluated on the
**decimated** mesh while the file that actually ships carries the parts —
110 062 triangles at plate 180 against the single solid's 68 692, and 208 008 at
plate 256. A model that decimates would ship a `.3mf` over 2 000 000 triangles
with `triangle_budget PASS`. `DECISIONS.md:251` acknowledges the trade-off and
notes no preset comes within 25× of the budget, which is true for presets and
not for an arbitrary user location. `part_meshes` reports the summed triangle
count but does not threshold it.

---

### 7. MINOR — `finalize()` runs `prune_debris` on each part independently, and up to 16 dropped shells would fit inside the `parts_union` tolerance

`services/bake/app/geom/assemble.py:472` (`finalize(solid).translate(offset)` in
`emit`), `assemble.py:167-180`, `checks.py:118,121`.

On the assembled solid a sub-`MIN_BODY_VOLUME_MM3` (0.01 mm³) shell really is
boolean debris. On a single colour part it may be a legitimate piece of the
model — a green patch clipped by the crop, an inlay fragment left by the
`others` subtraction — that the base part does not contain, so dropping it
removes material from the union. On Chicago nothing is lost (`single − union`
= 0.00000000 mm³, verified), so this is latent, not active. It is worth flagging
because the only guard is finding 4's volume tolerance: 0.1676 mm³ ÷ 0.01 mm³ =
**16 such shells could be dropped with `parts_union` still passing**.

---

### 8. MINOR — a `repair_slice_profiles` patch inherits a hero's height but is emitted in the buildings colour

`services/bake/app/geom/thicken.py:1246`
(`patches.append(BuildingSolid(piece, solid.height, solid.stands_on))` — three
positional arguments, so `hero_id` defaults to `None`).

`DECISIONS.md:243` justifies withholding `hero_id` from a patch (a fraction of a
mm³ as the sole body of a hero part is what `finalize`'s debris sweep would
drop) and that reasoning is sound. The consequence is not recorded anywhere: the
patch keeps `solid.height`, whose `is_hero` flag is `True`, so it is extruded to
the **hero's** printed top (`extrude.building_solid_pairs` → `building_top_mm_for
(solid.height, …, solid.height.is_hero)`) while being coloured as `buildings`.
A hero that needs a slice-profile patch would print with a strip of
building-coloured material running its full hero height alongside it. Not
observed on Chicago (no patch landed on the hero in the test bake) and not
covered by any test.

---

### 9. MINOR — `make bake-fixture PLATE=<non-numeric>` fails with a traceback, and the recipe no longer echoes its command

`Makefile:191-203`.

`PLATE` is interpolated straight into the JSON (`fields="$$fields\"plate_mm\":$(PLATE)"`,
Makefile:200) with no validation, unlike `COLOR`, which is checked against
`single|parts` and exits 2. `make bake-fixture PLATE=abc` reaches
`json.loads` in `cli._print_params_from_args` and surfaces as a
`json.decoder.JSONDecodeError` traceback. Separately, the recipe gained a
leading `@` (Makefile:192), so the `uv run` command line is no longer echoed;
the added `echo "baking … -> artifacts/$$stem.3mf $$*"` covers most of that
loss but not the exact invocation.

Behavioural equivalence of the plain target is otherwise sound: with no `COLOR`
and no `PLATE`, `set --` leaves `"$@"` empty, so the command is byte-identical
to v1's, still writing `artifacts/chicago.3mf`.

---

### 10. NOTE — "`git diff fixtures/v1-golden` empty" is trivially true

`fixtures/v1-golden/` is **untracked** (`git status --short` → `?? fixtures/v1-golden/`),
so `git diff` on it is empty by construction and proves nothing. The directory's
integrity rests instead on `tests/test_v1_compat.py`'s own provenance note and on
the digest test, both of which are sound. Worth committing the directory before
this is cited as evidence again.

---

### 11. NOTE — the twelve-hero cap is enforced by the contract only

`packages/contracts/schema/print_params.json` (`hero_building_ids.maxItems: 12`).
Verified: `PrintParams(hero_building_ids=[13 ids])` raises `ValidationError`,
12 is accepted. `transform.hero_ids` and `thicken.repair_buildings` apply no
defensive cap — a duck-typed params object returns all 50 of 50 ids. Every
production path (API and CLI) constructs a `PrintParams`, so this is a test-only
surface, but the handoff's "max 12" is a contract fact, not a bake fact.

---

### 12. NOTE — Python `or` vs TypeScript `??` in the hero/colour accessors is unreachable, not equivalent

`services/bake/app/geom/transform.py:376,450` use
`str(getattr(params, …, None) or "<default>")`, which falls back on the empty
string; `apps/web/lib/transform.ts:325,406` use `??`, which does not. A params
object carrying `hero_mode: ""` or `color_mode: ""` would diverge. Both are
`enum`-constrained in the frozen schema and `PrintParams(color_mode="")` /
`PrintParams(hero_mode="")` were both confirmed to raise `ValidationError`, so
the divergence is not reachable through the contract. Everything else in the
mirrored pair matches name for name, argument order for argument order, and
`getattr(building, "id", None)` / `building.id ?? ""` behave identically on a
carrier with no id.

---

### 13. NOTE — the parts-mode bake-time regression is ~0.7 s, not 5 s

Measured on this host at the **same** plate (180) and the same scene, so the
comparison is apples to apples:

```
single  repair 5.86 s  assemble 0.53 s  parts 0  tris 68 692
parts   repair 5.44 s  assemble 1.26 s  parts 6  tris 68 692 + 110 062 over 6 objects
```

Parts adds ~0.73 s of assembly plus ~2 s of Stage 4 (seven extra part meshes).
The 16 s / 25 s pair in `docs/handoff/v2-02-color.md:206-210` compares plate 180
against plate 256, which is a plate-size difference, not a mode difference. The
mode costs almost nothing. Acceptable.

---

### 14. NOTE — A6 remains unproven, and two of its named proxies are now known-weak

`docs/handoff/v2-02-color.md:217-253` correctly marks the Bambu/PrusaSlicer
import as manual and unautomatable on this host. Findings 2 and 3 show that two
of the five automated proxies it leans on (`3mf_components`, and the union
`bodies` row behind it) accept files a slicer would build wrong. The manual
procedure in §8 is well written and should be executed before release; until it
is, "imports as one object with N parts" rests on the file's structural
conformance (which is good, see *What is correct*) and on no observed slicer
behaviour.

---

## Summary of severities

| # | Severity | Where | One line |
|---|---|---|---|
| 1 | major | `assemble.py:511-525` | road and water inlays share the recess floor with a coincident top face at z=2.4 over 398 mm² |
| 2 | major | `cli.py:636-645`, `checks.py:641-648` | a duplicate `<component objectid>` (and an unreferenced part) passes every row |
| 3 | major | `cli.py:636-643,915-944` | `<component transform>` ignored; a 25 mm-displaced part validates as one solid |
| 4 | major | `checks.py:705-729`, `assemble.py:496-529` | parts are a strict superset of the single solid by 0.0095 mm³; volume-only check has 17.7× headroom |
| 5 | major | `bake.py:273-282` | the bake ships a parts `.3mf` without ever running `3mf_materials` / `3mf_components` / `3mf_color_mode` |
| 6 | minor | `bake.py:221-234` | triangle budget judged on the decimated STL, not on the parts that ship |
| 7 | minor | `assemble.py:472` | per-part `prune_debris` can silently drop up to 16 shells inside the union tolerance |
| 8 | minor | `thicken.py:1246` | a hero's slice-profile patch prints at hero height in the buildings colour |
| 9 | minor | `Makefile:191-203` | `PLATE=` is unvalidated (traceback); recipe no longer echoes its command |
| 10 | note | `fixtures/v1-golden/` | untracked, so "git diff is empty" proves nothing |
| 11 | note | `print_params.json` | twelve-hero cap is contract-only, no defensive cap |
| 12 | note | `transform.py:376,450` vs `transform.ts:325,406` | `or` vs `??`, unreachable through the enum |
| 13 | note | `v2-02-color.md:206-210` | mode costs ~0.7 s; the quoted 16/25 s compares plate sizes |
| 14 | note | `v2-02-color.md:217-253` | A6 manual check outstanding; two of its proxies are weakened by #2 and #3 |

Nothing here blocks shipping the artifact that exists: `artifacts/chicago-parts.3mf`
is a valid, printable, correctly-assembled multi-material package and every
validator that runs on it passes honestly. Findings 1 and 4 are defects in the
*feature* (one colour surface is slicer-arbitrated; the partition claim is
overstated and untested); findings 2, 3 and 5 are defects in the *gate* (files
that would slice wrong are accepted, and the bake trusts a writer it never
audits).

**AUDIT: 9 DEFECTS (0 blocker, 5 major)**

---

## Resolution (V2-P5 fix pass, 2026-08-30)

Applied by the mesh-bake agent, in the same phase as the lettering work (the
files overlap). Every fix has a regression test named below; no test was
weakened, skipped or deleted. Re-run after: `uv run pytest -q` (558 passed),
`make bake-fixture COLOR=parts && make validate artifacts/chicago-parts.3mf`
(ALL CHECKS PASS), the same at `PLATE=256` (ALL CHECKS PASS),
`uv run pytest tests/test_v1_compat.py` (11 passed, G8), plus
`COLOR=parts TEXT=all` and the plain single-colour fixture (68,692 triangles,
unchanged).

### 1. MAJOR — two parts own the same recess floor — **FIXED** (with a measured residual)

`extrude.inlay_claim` is new: where two recesses overlap, the inlay that comes
first in layer precedence (water) keeps the floor and the other (roads) is
**capped under it** — cut off above `winner_inlay_bottom + PART_OVERLAP_MM` over
the winner's footprint. The loser's remaining material is entirely inside what
the winner and the base already cover, so nothing is lost, and the two
interpenetrate by 04's own 0.2 mm exactly like every other pair in this model.

Measured on Chicago at plate 180, at the road floor minus 0.01 mm:

```
before   water 4205.55 mm^2   roads 13565.35 mm^2   both 398.4 mm^2 (contiguous)
after    water 4205.55 mm^2   roads 13070.81 mm^2   both  29.95 mm^2
```

The residual 29.95 mm² is **not** a shared region: it is a rim
`CLAIM_INSET_MM = 0.05 mm` wide (an eighth of a nozzle) where the cap stops
short of the winner's own edge on purpose. Ending the cap exactly on that edge
was tried first and is worse: the two recess outlines run within ~16 µm of each
other wherever `merge_recess_ridges` has grown the road layer along a bank, so
the loser keeps a 16 µm rind, and a rind is two zero-area triangles in a shipped
part (`part_meshes` failed on it). Cutting the loser away laterally instead was
also tried, and is worse again — see finding 4's note on shared faces.

Tests: `test_parts_no_two_parts_own_the_same_recess_floor` (both-reached floor
under 1 % of either cross-section; the road part is gone entirely above its own
floor; no pair of parts overlaps except base×anything and the deliberate
water×roads cap) and `test_parts_the_capped_inlay_is_buried_not_deleted` (what
the loser keeps is inside `water ∪ base`, to 1e-9 mm³).

### 2. MAJOR — duplicate/unreferenced `<component>` passes — **FIXED**

`validate/container.py`'s `parts_checks` now requires the component list to be
**distinct**, to reference **every** mesh object, and to reference **only** mesh
objects; the count it returns to `validate_parts` is the number of DISTINCT
correctly-referenced components, so the mesh-side `bodies` row fails as well.

Test: `test_cli_fails_a_parts_file_that_names_one_part_twice_and_another_never`
(asserts `3mf_components` FAIL naming both "referenced more than once" and
"no component references", and `bodies` FAIL).

### 3. MAJOR — `<component transform>` ignored — **FIXED**

`container.parse_transform` / `container.is_identity` are new. A non-identity
transform on a `<component>` **or** on the `<build><item>` fails
`3mf_components` naming the matrix. FrameCraft's writer never emits one, and
this validator judges the parts in their own coordinates, so refusing to judge
such a file is the honest option (the brief allowed either). An explicit
identity matrix is accepted.

Tests: `test_cli_fails_a_parts_file_whose_component_carries_a_transform`,
`..._whose_build_item_carries_a_transform`,
`test_cli_accepts_an_explicit_identity_transform`,
`test_container_transform_parsing_is_shared_and_strict`.

### 4. MAJOR — the parts are a strict superset; `parts_union` cannot see it — **FIXED**

Two halves:

* **The partition is now exact.** `color_parts` cuts EVERY additive part
  (`frame`, `buildings`, each hero, embossed `roads`, `green`, `trees`) by the
  same recess cutters single mode subtracts from the whole additive union
  (`assemble.carved`). Measured on Chicago at plate 180:
  `union − single` 0.0094688 mm³ → **9.0e-9 mm³**, `single − union` 0.0 →
  **1.9e-13 mm³**. At plate 256: 1.28e-8 mm³ total.
* **The check now has teeth.** `checks.symmetric_difference_mm3` computes
  `vol(A−B) + vol(B−A)` with manifold3d and `parts_union` fails over
  `PART_UNION_SYMDIFF_MM3 = thicken.PRINT_GRID_MM ** 3` = 1e-6 mm³ — derived
  from the pipeline's own snap grid, and 168,000× tighter than the volume-only
  budget it replaces. The volume and bounding-box comparisons are kept.

Two secondary defects had to be fixed to get there, both found by this work:

* `checks.manifold_from_mesh` returned **None for every mesh**, including a
  plain cube: trimesh hands out a read-only `TrackedArray` and
  `np.ascontiguousarray` passes it through, which manifold3d's binding refuses.
  Every caller silently used its fallback — `_part_bodies` was reporting the
  whole part's volume as its "smallest shell" (making the debris half of
  `bodies` vacuous) and `make_slicer` was using `trimesh.section` instead of
  `Manifold.slice`. Fixed with `np.array(..., order="C")`, which copies.
* `assemble.finalize` took its volume reference AFTER `simplify`, so a
  destructive simplify could never be caught. On the union of the colour parts
  it ate 0.4326 mm³ and split a body off. The reference is now taken first and
  the simplify is checked against it exactly as the weld already was.

The parts union is also no longer put through `finalize` in the bake: it is
swept for zero-volume debris only (`UNION_DEBRIS_MM3 = 1e-9`), because
`MIN_BODY_VOLUME_MM3` would drop a legitimate 0.0018 mm³ island of road inlay
and report material the parts really carry as missing.

Tests: `test_parts_partition_the_single_mode_solid_exactly`,
`test_parts_every_additive_part_is_cut_by_the_recesses`,
`test_parts_union_check_fails_on_a_manufactured_partition_error` (a 1 mm³ bite
out of an interior region — invisible to volume and bbox — must fail).

### 5. MAJOR — the bake never validates the container it wrote — **FIXED**

The container rows moved out of `app/cli.py` into `app/validate/container.py`
(the CLI keeps its private names as thin delegates) and `bake.run_pipeline` now
runs them on the file it has just written, in **both** modes:

```
parts  sidecar rows: ... bodies part_meshes parts_union 3mf_color_mode 3mf_parts
                     3mf_unit 3mf_objects 3mf_build_items 3mf_components
                     3mf_materials 3mf_attribution 3mf_counts     (21 rows, was 12)
single sidecar rows: ... 3mf_parts 3mf_unit 3mf_objects 3mf_build_items
                     3mf_attribution 3mf_counts                   (15 rows, was 9)
```

A failing container row therefore fails `report.passed`, and a failing bake
ships nothing (the existing quarantine path). The component count `bodies`
compares against now comes from the FILE rather than from the assembly.

Tests: `test_parts_bake_runs_the_container_rows_on_the_file_it_wrote`,
`test_parts_bake_ships_nothing_when_a_container_row_fails` (monkeypatches the
writer to emit a duplicate component and asserts `status == "failed"`,
`files is None` and no `.3mf` in the output directory),
`test_cli_and_bake_run_the_same_container_functions`.
`test_export_sidecar_round_trips_through_the_contract_models` was updated to the
new exact row set (it pinned the old one).

### 6. MINOR — triangle budget not enforced on the shipped parts — **FIXED**

`validate_parts`' `part_meshes` row now fails when the parts' total exceeds
`TRIANGLE_BUDGET`. Test:
`test_parts_triangle_budget_is_judged_on_the_parts_that_ship`.

### 7. MINOR — per-part `prune_debris` could drop shells inside the union tolerance — **FIXED by finding 4**

No code change to `emit`. The guard the audit named — "the only guard is finding
4's volume tolerance, 16 such shells could be dropped" — is now the exact
symmetric difference, so a dropped shell fails `parts_union` outright rather
than hiding inside a budget. The union measurement itself no longer prunes at
0.01 mm³ (see finding 4).

### 8. MINOR — a hero's slice-profile patch printed in the buildings colour — **FIXED**

`thicken.repair_slice_profiles` gives each patch the `hero_id` of the solid whose
height it inherits. DECISIONS [V2-P3] withheld it because a patch as a second
body of a hero part is what the debris sweep could drop; that risk is now caught
loudly by the exact `parts_union` instead of silently breaking the partition.
Test: `test_parts_a_slice_profile_patch_keeps_the_colour_of_what_it_patches`
(the neck is fabricated by monkeypatching the detector — two synthetic squares
cannot make the corridor-shaped neck the real repair looks for, and the
invariant under test is what the patch CARRIES).

### 9. MINOR — `PLATE=` unvalidated — **FIXED** (half)

`make bake-fixture PLATE=abc` and `PLATE=1.2.3` now exit 2 with
`PLATE must be a number of millimetres (got 'abc')` before anything runs.

**NOT FIXED**: the recipe still starts with `@`, so the exact `uv run` line is
not echoed. The recipe echoes the target and the full `--params` JSON it will
pass, which is the information that matters, and removing the `@` would print
the twenty-line shell body of the recipe on every invocation.

### 6. MAJOR (added after the audit) — additive parts were cut only by the recess cutters — **FIXED**

Single mode subtracts `[road?, water?, text_cutter, underside_cutter]` from the
whole additive union; `carved()` was handed only the recess cutters. One
invariant fixes all three consequences (embossed text escaping the text cutter,
every other additive part escaping both the text and underside cutters, and the
text cutter being applied to nothing at all in parts mode with the frame off):
**every additive part loses what single mode subtracts, in single mode's
order**. On `TEXT=all COLOR=parts` the two modes now report the same volume
(199,812.6339 mm³ both; symmetric difference 5.6e-7 mm³) where the lettering
handoff had recorded 199,812.6434 vs 199,812.6339.

Tests: `test_parts_every_additive_part_is_cut_by_the_full_cutter_list` (no part
except the base holds any volume inside the text or underside cutters) and
`test_parts_with_text_and_pockets_still_partition_the_single_solid`.

### 7. NOTE (upgraded) — per-part `prune_debris` was unconditional — **FIXED**

`assemble._prune_covered` drops a sub-0.01 mm³ shell only when the other parts
already hold it; `finalize` is called with `min_body_volume=0.0` for a colour
part. The 12 chips (6.4e-4 mm³) it used to drop were all inside another part's
interpenetration band — true, but unenforced. The parts are now built first and
finalized once at the end, because the sweep needs to see the other parts.
Test: `test_parts_debris_is_dropped_only_when_another_part_holds_it` (a covered
chip is dropped, an uncovered one survives).

### 3 (revisited) — the transform is now APPLIED as well as reported

`cli._placed_parts` looks each geometry's instance transform up in
`scene.graph` and applies it, so every geometric row judges the object the
slicer would build. On a tampered copy of the Chicago parts file, a component
translated 25 mm in X now fails `bounding_box` (198.95 mm across a 180 mm
plate) and `bodies` (68 disconnected bodies) as well as `3mf_components`.
Test: `test_cli_judges_a_displaced_part_where_the_build_item_puts_it`.

### 10-14. NOTES — **NOT FIXED**, deliberately

* **10** (`fixtures/v1-golden/` untracked): committing it is the orchestrator's
  call, not a bake-side change; the digest test remains the real guard.
* **11** (twelve-hero cap is contract-only): every production path constructs a
  `PrintParams`; a defensive cap would duplicate the contract in a second place.
* **12** (`or` vs `??`): unreachable through the enum, as the audit says.
* **13** (bake-time regression is ~0.7 s): a documentation correction to
  `v2-02-color.md`, whose owner is the parts-export phase.
* **14** (A6 manual check): still outstanding and still manual. Findings 2 and 3
  are fixed, so the two proxies the audit called weak are no longer weak, but no
  slicer has been run.
