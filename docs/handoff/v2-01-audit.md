# v2-01 audit — contracts v2, the v1 golden, the shared token table

Adversarial audit of Task 1 (`packages/contracts/**`, the two generated contract
files, `fixtures/v1-golden/**`, `fixtures/print-params-default.json`,
`fixtures/tokens-expected.json`, `services/bake/app/geom/tokens.py`,
`apps/web/lib/tokens.ts`, `services/bake/tests/test_contracts.py`,
`services/bake/tests/test_v1_compat.py`, `services/bake/tests/test_tokens.py`,
`apps/web/lib/contracts.test.ts`, `apps/web/lib/tokens.test.ts`). The auditor
did not write any of it. Churn in `services/bake/app/{geom,export,validate}`,
`apps/web/components`, `apps/web/store`, `fixtures/parity-expected.json` and
`test_transform.py` belongs to concurrent agents and was excluded, except where
a Task 1 artifact is consumed there (finding 2).

Host: Windows 11, Git Bash, no Docker. Nothing was modified except this file;
scratch probes were written to the session scratchpad and run from there.

---

## Findings

### 1. MAJOR — a partial `part_colors` is rejected by jsonschema and by tsc, but silently accepted and back-filled by Pydantic

`packages/contracts/schema/print_params.json:57` puts all seven keys in
`PartColors.required`, and `apps/web/lib/contracts.ts:81-89` emits all seven as
required TS properties. `services/bake/app/contracts.py:98-104` gives every one
of them a default, so the generated model accepts a palette with keys missing
and silently fills the rest.

```
case                                jsonschema   pydantic
partial part_colors (base only)          False       True   <<< DIVERGENCE
empty part_colors {}                     False       True   <<< DIVERGENCE
```

(33 other payload probes — the hex pattern in both directions, 8-digit hex,
65-char `city_label`/`text`/`template`, 9 engravings, 13 hero ids, `size_mm`
1.49/8.1, `depth_mm` 0.1/1.6, `north_arrow.size_mm` 1.99/6.01,
`scale_bar.length_m` 9/5001, `schema_version` 1 and 3, unknown keys at top level
and inside both `part_colors` and an `Engraving`, an `Engraving` missing `edge`
or `text`, a non-string hero id, bogus `hanger`/`color_mode`/`hero_mode` — agree
exactly between the two validators.)

Reproduce:

```sh
cd services/bake && uv run python - <<'PY'
import json, jsonschema
from app.contracts import PrintParams
V1 = json.load(open("../../fixtures/v1-golden/chicago-default.sidecar.json"))["print_params"]
schema = json.load(open("../../packages/contracts/schema/print_params.json"))
bad = {**V1, "part_colors": {"base": "#D8D3C6"}}
print("pydantic:", PrintParams(**bad).part_colors)          # succeeds, six defaults injected
jsonschema.validate(instance=bad, schema=schema)            # raises: 'frame' is a required property
PY
```

Consequence: `POST /bake` accepts a body the frozen contract declares illegal
and the TS type refuses to construct. In parts mode (Task 2) a client that sends
a half palette gets six silently-defaulted filament colours instead of a 422 —
the failure mode is a wrong-coloured print, not an error.

Root cause is in the generator, not the schema: `packages/contracts/gen_py.py:236`
emits a default whenever the schema fragment has one, without consulting the
object's `required` list, so `required` + per-property `default` (the exact
combination `PartColors` uses, and the combination DECISIONS.md:203 says is
deliberate) cannot be expressed in Pydantic by this generator.

Untested in either direction: `OUT_OF_RANGE_CASES`
(`services/bake/tests/test_contracts.py:326-431`) carries only range, pattern
and length cases; nothing in the suite pins required-ness parity for any of the
five new `$defs`. See finding 4.

Either fix is defensible — drop the six non-`base` keys from `PartColors.required`
so the schema matches the model, or teach `gen_py.py` to omit the default for a
property that is in `required` so the model matches the schema and TS — but the
three declarations must agree, and a parity case must pin whichever is chosen.

### 2. MAJOR — `DEFAULT_PRINT_PARAMS`' nested v2 defaults are shared mutable objects, and the store's shallow spread aliases them

`apps/web/lib/contracts.ts:172` declares `DEFAULT_PRINT_PARAMS` as a plain
mutable object literal (only `PARAM_RANGES:217` is `as const`). Its six new
nested values — `part_colors:187`, `engravings:196`, `north_arrow:197`,
`scale_bar:202`, `underside_mark:209`, `hero_building_ids:213` — are single
module-level instances.

`apps/web/store/editor.ts:172` (initial state) and `apps/web/store/editor.ts:228`
(`resetParams`) both build the params from `{ ...DEFAULT_PRINT_PARAMS }`, a
*shallow* copy, so `state.params.part_colors` and the other five **are** the
module-level default objects, not copies of them.

Reproduce (scratch, no repo files touched):

```sh
cd apps/web && node --experimental-strip-types - <<'JS'
const C = await import("file:///D:/VahidVibeProject/CityDesign3D/apps/web/lib/contracts.ts");
const copy = { ...C.DEFAULT_PRINT_PARAMS };
console.log(copy.part_colors === C.DEFAULT_PRINT_PARAMS.part_colors); // true
copy.part_colors.base = "#000000";
copy.engravings.push({ edge: "top", text: "leak" });
console.log(C.DEFAULT_PRINT_PARAMS.part_colors.base);                 // #000000
console.log(JSON.stringify(C.DEFAULT_PRINT_PARAMS.engravings));       // [{"edge":"top","text":"leak"}]
JS
```

After that, `resetParams()` resets to a corrupted "default", and
`editor.test.ts:163`'s `toEqual(DEFAULT_PRINT_PARAMS)` still passes because both
sides moved together.

This is precisely the hazard the Python half went out of its way to prevent —
`Field(default_factory=lambda: PartColors(...))` at `contracts.py:155-160`,
pinned by `test_nested_v2_defaults_are_independent_per_instance`
(`test_contracts.py:577`), which I verified genuinely holds. The TS mirror has
neither the guard nor a test, so the "one statement of the defaults in both
languages" claim (DECISIONS.md:207) holds for values but not for aliasing.

Latent today — nothing edits a nested parameter in place yet, and `setParam`
(`editor.ts:220`) replaces rather than mutates — but Task 2/3 add exactly the UI
(a colour picker per part, an engraving list, a hero-id list) that will mutate
these in place. A deep clone at the two store sites, an `Object.freeze` walk in
the generator, or emitting a `defaultPrintParams()` factory alongside the
constant would all close it.

### 3. MINOR — `02_TECH_SPEC.md` still documents the v1 `PrintParams` only

`02_TECH_SPEC.md:104-110` shows the eleven v1 keys and nothing else, under the
heading "The contracts, frozen in phase 1". CLAUDE.md names the specs as the
source of truth; the shipped contract now has 22 properties and five `$defs`.
Only `DECISIONS.md:201-206` records the addition. A later agent reading 02 to
learn the contract will build against a shape that no longer exists.

### 4. MINOR — no required-ness or `additionalProperties` parity coverage for the five new `$defs`

`test_additional_properties_are_rejected` (`services/bake/tests/test_contracts.py:285`)
exercises only top-level `PrintParams`. I confirmed by hand that both validators
reject an unknown key inside `part_colors` and inside an `Engraving`, and that an
`Engraving` missing `edge` or missing `text` is rejected by both — so nothing is
broken there. But nothing in the suite pins it, and that gap is exactly why
finding 1 shipped green: the bound-parity harness would have caught it the
moment a `required`-shaped case was added to `OUT_OF_RANGE_CASES`.

### 5. MINOR — `PARAM_RANGES` publishes no cap for the array and string bounds

`packages/contracts/gen_ts.py:145` (`numeric_range_entries`) emits only fragments
carrying both `minimum` and `maximum`, so `engravings` `maxItems: 8`,
`hero_building_ids` `maxItems: 12` and the `maxLength: 64` on `city_label`,
`Engraving.text` and `UndersideMark.template` reach TS as types and runtime
validation but not as constants. The v2 UI will have to hard-code `8`, `12` and
`64` at its call sites — the re-typed-bound drift `PARAM_RANGES` exists to
prevent, and the same class of defect the v2 Task 0 audit found in the HUD.

### 6. NOTE — one Python/TS token divergence, at `buildings >= 1e21`

`group_thousands` diverges because `String(1e21)` is `"1e+21"` in JS:

```
buildings 1e21   python "1,000,000,000,000,000,000,000"   ts "1e,+21"
```

Unreachable through the contract (`Stats.building_count` is a real OSM count) and
not worth a code change; recorded so the mirror's "cannot drift" claim is exact.

Thirty other edge cases I ran through both implementations agree byte for byte:
`lon = -180`, `lat = -90`, `buildings = 0` and negative, a token repeated twice
in one string, four adjacent tokens with no separator, a lone `{`, `}{`,
`{{city}}`, a city label that is itself `{lat}` (no rescan in either), `$&`/`$1`/
``$` ``/`$'` in a replacement value (JS `String.replace` does not expand them
from a function return, matching `re.sub`), an integer scale ratio, a `.5` tie in
the scale ratio, `scale = 1e-9`, negative and NaN scale, radius ties at 2.5/-0.5/
-1.5, latitude ties at `.00005` and `1.00005`, `-0`, empty text, a combining-mark
and astral-plane city label, `{city_label}` and `{lat2}` as unknown names, and a
fractional `buildings`.

### 7. NOTE — `fixtures/tokens-expected.json` gaps

No case repeats a token in one string; no case has two truly adjacent tokens
(the closest, `{lat},{lon}`, has a comma between); no `lon = -180`; no
`buildings = 0`. All four agree across languages when run (finding 6), so
nothing is broken — the fixture simply would not catch a future regression in
them, and the two-tokens-touching case is the one a naive non-global regex
would break.

### 8. NOTE — `{coords}` prints `0.0000° S` for a latitude that rounds to zero from below

Fixture case index 8 (`lat: -4e-05`) pins `"0.0000° S, 0.0000° E"`. Both
implementations agree, so this is a pinned decision rather than drift, but a
frame engraved `0.0000° S` reads as a bug to a buyer. Worth a product call
before Task 3 cuts it.

### 9. NOTE — the one rewritten assertion in the test diff is not a loosening

`git diff -- '*test*'` adds 97 assertion lines and removes exactly one:
`test_print_params_round_trips` (`test_contracts.py:260`) traded
`model_dump() == PRINT_PARAMS_EXAMPLE` for "every v1 key round-trips unchanged"
plus "the extra keys are exactly the eleven named v2 fields", with
`test_print_params_v2_round_trips:269` covering the v2 values. Equivalent
strength. No `skip`, `xfail`, `.only` or `todo` was added anywhere.

---

## What I verified and found sound

**Schema fidelity.** Every field, enum, bound, default and `$def` matches the
brief exactly (`schema_version` integer `enum [2]` default 2 and **not** in
`required`; `city_label`/`color_mode`/`part_colors`/`engravings`/`north_arrow`/
`scale_bar`/`hanger`/`underside_mark`/`hero_building_ids`/`hero_mode` all
optional with v1-preserving defaults; `Engraving` 1.5–8.0 / 0.2–1.5 with
`align`/`mode`/`font` defaults; `NorthArrow` 2.0–6.0; `ScaleBar` 10–5000;
`maxItems` 8 and 12; the hex pattern accepting `#RRGGBB` and `#RRGGBBAA`).
Diffed against `da9ab83`: every v1 property object is byte-identical, the v1
`required` list is unchanged, and `additionalProperties: false` holds on the
root and on all five new `$defs`. Nested objects' defaults are fully populated,
and each nested property carries its own `default` too, so the object-level
default really is the all-defaults instance.

**Generator.** `make contracts` twice: both generated files byte-stable
(identical md5 across three snapshots), and `git status --short` after each shows
nothing regenerated that should not be. Pydantic `default_factory` objects are
per-instance, verified by identity and by mutation across two `PrintParams()`
instances (`part_colors`, `engravings`, `hero_building_ids`, `north_arrow`).
`pattern`, `max_length` and array `max_length` are enforced by the model as well
as by the schema.

**TS side.** `DEFAULT_PRINT_PARAMS` deep-equals `fixtures/print-params-default.json`
deep-equals `PrintParams().model_dump(mode="json")` (asserted on both sides, and
re-checked here). `PARAM_RANGES` nested groups match the schema bounds exactly
(`engravings.size_mm` 1.5/8.0/3.0, `engravings.depth_mm` 0.2/1.5/0.4,
`north_arrow.size_mm` 2.0/6.0/4.0, `scale_bar.length_m` 10/5000/500), and every
v1 entry keeps its position and shape. The new fields are optional on the
`PrintParams` type, which is what the schema's `required` list says and what the
store and every consumer already satisfy (they all spread `DEFAULT_PRINT_PARAMS`,
which carries all 22 keys) — see finding 2 for the one thing that spread gets
wrong.

**Golden integrity.** Recomputed the sha256 independently over the exact
`<vertices>…</vertices>` + `<triangles>…</triangles>` source text of
`3D/3dmodel.model` in the committed `chicago-default.3mf`:
`0e20725e9c738a1af7e91a62dd2808ae94f74027f2811b51c65790873ce08758` — matches the
recorded digest. `<vertex ` count 34,348, `<triangle ` count 68,692 and model
XML 5,314,084 bytes all match the record. `chicago-default.sidecar.json`'s
`print_params` is a pure v1 object (11 keys, no `schema_version`, no v2 key), and
its `bake_result.stats` and `warnings` match `chicago-default.json` field for
field. `test_v1_compat.py` bakes through `bake.run_pipeline`, which is what
`bake.bake_job:389` — the `POST /bake` worker — and `cli.py:257` both call.

**The "byte-identical outside `<metadata>`" assertion is not vacuous.** Stripping
metadata removes 740 of 5,314,082 characters; the compared body still contains
all 34,348 `<vertex ` and 68,692 `<triangle ` elements. Prepending one character
to the first vertex's `x` attribute breaks both the body comparison and the
digest; swapping `v1`/`v2` on the first triangle breaks the digest; a
metadata-only edit does not break the body comparison. (Done on an in-memory copy
of the extracted XML; the fixture was never written to.)

**Housekeeping.** `git worktree list` shows only the main tree. No scratch file
was left in the repo — the untracked set is exactly the declared deliverables
plus the two other agents' handoff notes. `make contracts` regenerates only
`services/bake/app/contracts.py` and `apps/web/lib/contracts.ts`.
`FRAMECRAFT_WRITE_PARITY` appears nowhere in the Makefile, so the two
self-writing fixture tests cannot go vacuous inside the gate. The DECISIONS
`[V2-P2]` lines match the code as written, including the honest correction that
the brief's "Chicago 1:9,650" corresponds to no producible parameter combination
(1:10,714 at the defaults) — I re-derived 168 mm / 1800 m and agree.
`build_metadata` values are XML-escaped at `mf3.py:105`, so the new
user-controlled `city_label` cannot inject into the 3MF Description.

**Suites.** `cd services/bake && FRAMECRAFT_OFFLINE=1 uv run pytest -q
tests/test_contracts.py tests/test_v1_compat.py tests/test_tokens.py` → 112
passed. `cd apps/web && npm test -- --run` → 13 files, 200 passed;
`npm run typecheck` clean; `npm run lint` (`--max-warnings 0`) clean.
`make gate` / `make up` not run, per instructions.

---

AUDIT: 9 DEFECTS (0 blocker, 2 major)

---

## Resolution (fixer, 2026-08-29)

Scope of this pass: `packages/contracts/**`, the two generated outputs (via
`make contracts`, never by hand), `services/bake/tests/test_contracts.py`,
`services/bake/app/geom/tokens.py`, `apps/web/lib/tokens.ts`, the two token test
files, `fixtures/tokens-expected.json` and `apps/web/lib/contracts.test.ts`.
Nothing else was touched. Decisions are logged as `- [V2-P2-fix]` lines in
`DECISIONS.md`.

| # | Severity | Status |
|---|---|---|
| 1 | MAJOR | **FIXED** in the generator |
| 2 | MAJOR | **FIXED** in the generator |
| 3 | MINOR | **NOT FIXED**, by decision |
| 4 | MINOR | **FIXED** |
| 5 | MINOR | **FIXED** |
| 6 | NOTE | **FIXED** |
| 7 | NOTE | **FIXED** |
| 8 | NOTE | **PARTLY** — the zero case is now pinned; `-4e-05` left as it is |
| 9 | NOTE | no action needed (the audit's own finding) |

**1 — partial `part_colors` accepted by Pydantic.** Fixed at the root cause, in
`gen_py.py`, and in the direction the audit preferred: a property listed in a
nested `$defs` object's `required` now emits `Field(...)` with **no** default, so
`required` wins over `default` exactly as jsonschema reads it. `PartColors` now
requires all seven colours in all three declarations. The nested defaults still
reach every caller through the outer optional property's `default_factory`,
which spells out every key — and `gen_py.py` now *raises at generation time* if
an object default ever omits a required key of the `$defs` it points at, so that
invariant cannot rot silently.

The rule is scoped to `$defs` objects; a ROOT model keeps the schema default on
its required properties, because `PrintParams()` is the documented "no
parameters supplied" object and `BakeResult(job_id=…, status="failed")` is
constructed that way inside `bake.py`. That asymmetry is deliberate and is now
recorded in `DECISIONS.md` rather than left implicit: a root is an API envelope,
a `$def` is a value. `PrintParams() == PrintParams.model_validate({})` is pinned.

Beyond `PartColors`, the rule also caught `Building.holes`,
`Building.min_height_m` and `AreaFeature.holes` (each `required` *and*
defaulted). Every construction site in the tree already passes them, and both
committed scene fixtures carry them on every element, so no caller changed —
jsonschema had been rejecting an omission there all along.

**2 — `DEFAULT_PRINT_PARAMS` aliasing.** `gen_ts.py` now emits a recursive
`deepFreeze()` helper, wraps the constant in it (with an explicit type argument,
so the object literal keeps its excess-property check), and emits an exported
`defaultPrintParams()` factory returning a `structuredClone` deep copy. The
constant keeps its name, type and shape, so `fixtures/print-params-default.json`
and every existing consumer are unaffected; what changes is that the audit's
reproduction now throws a `TypeError` instead of corrupting the default. The
store was **not** edited (the web-editor agent owns it and has been told to
switch to the factory) — until it does, its shallow spread is safe but its
nested values are the frozen originals, so an in-place nested write there will
throw rather than corrupt.

**3 — `02_TECH_SPEC.md` documents only the v1 `PrintParams`.** NOT FIXED, by
decision: the v1 specs are left as written for this run, the v2 shape is
documented in `docs/handoff/v2-01-contracts.md`, and the RUNBOOK will carry it.
Editing 02 mid-run would also have put this fixer in a file two other agents are
reading. The finding stands as a real documentation gap for the run's owner.

**4 — no required-ness / `additionalProperties` parity for the five new
`$defs`.** Fixed with eleven new both-validators-reject cases (partial, empty and
one-key-short `part_colors`; `Engraving` missing `edge`, missing `text`, and
empty; an unknown key inside each of the five `$defs`), six both-validators-
accept cases, and `test_every_required_property_of_a_nested_def_is_required_in_
the_model`, which walks all four schemas and asserts a per-file count so it
cannot pass vacuously.

One correction to the fix brief: it asked for an empty `north_arrow`/`scale_bar`/
`underside_mark` to be *rejected* by both. It is not, and must not be — those
three list nothing in `required` precisely so a share link can send
`{"enabled": true}`. The true parity is pinned instead (both accept; the model
fills each absent member from that member's own schema default).

**5 — no constants for the array and string caps.** Fixed with a new
`PARAM_LIMITS` constant beside `PARAM_RANGES`, derived from the schema:
`engravings.max_items` 8, `hero_building_ids.max_items` 12,
`city_label.max_length`, `engravings.text.max_length` and
`underside_mark.template.max_length` at 64. A sibling constant rather than a
widening of `PARAM_RANGES`, so no existing `{min,max,default}` row changes shape.

**6 — `buildings >= 1e21`.** Fixed rather than merely recorded:
`group_thousands` in `tokens.ts` now takes its digits from
`BigInt(...).toString()` for any finite magnitude, so the two languages agree for
every integer instead of every integer under 1e21. Non-finite input keeps its
previous JS spelling, so nothing reachable through the contract changed.

**7 — fixture gaps.** `fixtures/tokens-expected.json` went from 27 to 41 cases:
zero latitude and zero longitude, `lon = -180`, `buildings` 0 and 1,234,567, the
same token twice in one string, two truly adjacent tokens with no separator
between the braces, a lone `{`, a lone `}`, `}{`, `{notatoken}` and `{ city }`.
Regenerated the documented way (`FRAMECRAFT_WRITE_PARITY=1`), never by hand.

**8 — `0.0000° S` for a latitude that rounds to zero from below.** The zero case
is now pinned in both languages (`0.0000° N, 0.0000° E`, and `-0.0` reads the
same as `0.0`). The `-4e-05` case is left as it is: the value really is south of
the equator, both implementations agree, and rounding the hemisphere letter as
well as the digits would make `{coords}` contradict the `{lat}` printed beside
it. Still a product call, now a narrower one.

### Verified

```
make contracts x3                  both generated files byte-identical (md5) each time
services/bake  pytest -q tests/test_contracts.py tests/test_v1_compat.py tests/test_tokens.py
                                   138 passed (G8 among them, after regeneration)
apps/web       vitest lib/contracts.test.ts lib/tokens.test.ts   73 passed
apps/web       npm run lint        clean (--max-warnings 0)
```

### Failing outside this scope, reported not fixed

Concurrent agents are mid-edit. Each of these was re-run after a wait and is in
a file this pass may not touch; none is caused by a change made here (the full
`services/bake` suite is 419 passed, and `npm run typecheck` is clean).

- `apps/web/lib/preview.test.ts:391` asserts `parity.cases` has length 3 while
  `fixtures/parity-expected.json` now holds 4 — 1 vitest failure, owned by the
  transform/parity agent. Its two pytest twins in
  `services/bake/tests/test_transform.py` were failing the same way earlier in
  this pass and that agent has since fixed them; the TS half is still open.
- `apps/web/components/scene/CityPreview.tsx:136` — `react-hooks/exhaustive-deps`
  warning (`useMemo has an unnecessary dependency: 'theme'`), which fails
  `npm run lint --max-warnings 0`. It appeared *during* this pass (lint was
  clean an hour earlier), owned by the UI agent. `lib/contracts.ts` is
  eslint-ignored, and no file in this scope produces a warning.
