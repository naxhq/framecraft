# 02 - geo-ingest (phase P2)

OSM -> SceneGraph. Overpass client + fixture cache, the six presets, the seven
hygiene steps, UTM projection, rotate-then-crop, coverage classification, and
the `GET /presets` + `POST /scene` routes.

## Files written (nothing outside this list was touched)

```
services/bake/app/ingest/__init__.py      package exports
services/bake/app/ingest/overpass.py      03 query text, bbox, sha1 fixture cache, retry/mirror, offline guard
services/bake/app/ingest/normalize.py     raw OSM -> SceneGraph (heights, widths, hygiene, emit)
services/bake/app/ingest/presets.py       the six presets (ids/labels from DECISIONS [P1])
services/bake/app/geom/project.py         LocalFrame (WGS84->UTM->ENU), rotation, crop helpers
services/bake/app/cli.py                  NEW: `refresh-fixtures` + `scene` subcommands (extensible)
services/bake/app/main.py                 ADDED GET /presets and POST /scene only
services/bake/tests/conftest.py           NEW: FRAMECRAFT_OFFLINE=1 for the whole suite
services/bake/tests/test_ingest.py        NEW: 73 offline tests
fixtures/<sha1>.json  x6                  raw Overpass responses (committed)
fixtures/presets-index.json               preset_id -> request / fixture_file / fetched_at / element_count / bytes
fixtures/chicago-scene.json               REGENERATED from the real Chicago fixture
DECISIONS.md                              appended 16 [P2] lines
```

`fixtures/parity-scene.json` and `fixtures/parity-expected.json` (web-editor)
were not touched.

## Overpass

* Query text is 03's verbatim, one query for all layers, `out geom;`.
  `[out:json][timeout:180];` and a 180 s httpx timeout,
  `User-Agent: FrameCraft/0.1 (OSM-to-3D-print MVP; contact via repo)`.
* bbox: the metric crop square's edges, grown by the 15% margin, are projected
  back to WGS84 (16 samples per edge) in the ROTATED frame; `to_wgs84`
  un-rotates them, so the geographic window automatically covers the crop's
  real reach `radius_m * (|cos t| + |sin t|) * 1.15` and the 29 deg New York
  corners cannot come back empty (see DECISIONS [P2] and [P2-fix]).
* Retries: 3 attempts, exponential backoff (2 s, 4 s), switch to
  `https://overpass.kumi.systems/api/interpreter` on 429, 504 or a body-level
  timeout/out-of-memory. A 200 with a non-JSON body, with no `elements` array,
  or with a `runtime error` remark counts as a failed attempt and is never
  written to the fixture cache (fix pass below).
* Every response is cached verbatim to `fixtures/<sha1-of-query-text>.json`;
  the cache is consulted before any network call. `FRAMECRAFT_OFFLINE=1` makes
  any network attempt raise `OverpassOffline`.

## The six fixtures (fetched 2026-08-29, the one allowed network moment)

| preset | rotation | fixture | MB | elements |
|---|---|---|---|---|
| chicago-loop | 0 | `a4e5375818f309940313e0ac08b8ebb88c615f9e.json` | 12.1 | 16 051 |
| new-york-midtown | 29 | `f41c2522860df8ead22956b8087aa0632b78c78c.json` | 12.9 | 16 998 |
| paris-eiffel | 0 | `f37cfe5a65e7a7b1c8753d51e41393edb335120f.json` | 12.3 | 19 421 |
| tokyo-shinjuku | 0 | `2889affd6a79d6138c5ef13ec34d513751f15ae3.json` | 8.1 | 12 681 |
| london-city | 0 | `e9ffa1a1e08167cfbbad93105151fe0a66235d64.json` | 12.1 | 17 743 |
| san-francisco-fidi | 0 | `0210e990619f1e505069b41003f4ece83d6d91a0.json` | 6.9 | 9 088 |

Total ~67 MB. **No fixture is near the 60 MB note threshold** (largest 12.9 MB).
The New York row was re-fetched in the fix pass below (its query text changed).
Re-fetch with `make refresh-fixtures` (= `uv run python -m app.cli
refresh-fixtures`); it pauses 5 s between queries per the Overpass usage
policy, rewrites `fixtures/presets-index.json`, and deletes sha1-named fixtures
that no preset points at any more (`--keep-stale` opts out, `--if-missing`
fetches only what is missing).

## Normalized output, per preset (900 m radius, this fixture set)

| preset | buildings | coverage | height_tag_ratio | tag / levels / default | tall | holes | roads | water | green | trees | normalize |
|---|---|---|---|---|---|---|---|---|---|---|---|
| chicago-loop | 994 | good | 0.111 | 110 / 368 / 516 | 213 | 5 | 5 443 | 42 | 711 | 5 762 | 1.53 s |
| new-york-midtown | 2 683 | good | 0.897 | 2 407 / 34 / 242 | 646 | 20 | 3 377 | 20 | 161 | 853 | 1.69 s |
| paris-eiffel | 2 905 | good | 0.009 | 27 / 1 814 / 1 064 | 14 | 303 | 4 228 | 20 | 188 | 7 716 | 1.15 s |
| tokyo-shinjuku | 5 401 | good | 0.159 | 858 / 247 / 4 296 | 160 | 11 | 3 317 | 22 | 99 | 577 | 1.02 s |
| london-city | 2 197 | good | 0.034 | 74 / 1 166 / 957 | 54 | 37 | 8 131 | 12 | 178 | 1 282 | 1.06 s |
| san-francisco-fidi | 2 648 | good | 0.704 | 1 865 / 137 / 646 | 207 | 34 | 3 958 | 3 | 73 | 497 | 0.71 s |

All six classify as `good`. Every one of the 16 828 emitted footprints is a
valid `Polygon(ring, holes)` with CCW exterior, CW holes, no repeated closing
vertex, and every coordinate inside `+/- radius_m`. All six validate against
`packages/contracts/schema/scene_graph.json` with `jsonschema`.

## Pipeline order

1. Classify elements (building / road / water / green / tree) and pool every
   lon/lat.
2. One vectorized pyproj pass: WGS84 -> UTM zone of the center (326xx north,
   327xx south) -> subtract the center -> rotate CCW by `rotation_deg`.
   Projection precedes hygiene because all 03 tolerances are metric; rotation
   is rigid so 03's rotate-then-crop is preserved (only the clip is later).
3. Hygiene, 03's seven steps in order: drop < 4 nodes / zero area; close rings;
   `make_valid` keeping only polygonal parts; orient exterior CCW and holes CW;
   `simplify(0.25, preserve_topology=True)`; dedupe centroids within 0.5 m with
   areas within 5% (STRtree `dwithin` + union-find); union footprints whose
   interiors genuinely overlap, keeping the max height.
4. Crop: intersect with the axis-aligned square of side `2 * radius_m`
   (buildings/water/green by intersection with multipolygon results split into
   separate entries, roads by intersection with MultiLineStrings split, trees
   by containment).
5. Emit the frozen contract, coordinates rounded to 1 mm.

Heights follow 03's order exactly, recording `height_source`: `height` tag ->
`"tag"` (parses `12.5 m`, `12,5 m`, `41'`, `41'6"`, `135 ft`, `450 cm`, plain
numbers); `building:levels * 3.2 + roof:height` -> `"levels"`;
`building:min_level * 3.2` -> `min_height_m`; type defaults and the 8.0 m
fallback -> `"default"` with a deterministic +/-6% jitter seeded by
`sha1(osm_id)`. Clamped to [2, 600]; `is_tall = height_m >= 40` computed only
here. Road widths use the 03 table keyed by the ORIGINAL highway tag, with
`width` preferred and `lanes * 3.5` next; `class` follows DECISIONS [P1].

## API

* `GET /presets` -> the six `SceneRequest` objects with `preset_id` set.
* `POST /scene` -> `SceneGraph`, validated through the generated models.
  Preset requests are served from the committed fixture with the network
  disabled. Caches: in-process LRU of 6 scenes plus
  `artifacts/cache/scene/<sha256-of-request>.json` with a 24 h mtime TTL.
  Errors: 400 unknown `preset_id`, 502 Overpass unreachable after retries /
  fixture missing, 503 when the service is running with `FRAMECRAFT_OFFLINE=1`.

Measured on this host (Chicago preset, TestClient): cold from the fixture
**1.74 s**, warm from memory **7-12 ms**, warm from the disk cache **32 ms**,
`GET /presets` **2 ms**. Budgets in 02 (cold < 8 s, warm < 300 ms) are met with
a wide margin.

## Tests

`services/bake/tests/test_ingest.py`, 73 tests, all offline
(`tests/conftest.py` exports `FRAMECRAFT_OFFLINE=1`; the preset `/scene` test
additionally monkeypatches `overpass._post` to a raising sentinel and asserts
it was never called). Coverage: preset table and fixture presence, 03 query
text and bbox margin, height/unit parsers, jitter determinism, road tables,
coverage thresholds, per-fixture building counts (Chicago and Paris, ranges
about +/-40% around the measured values), ring validity/winding/no-closing-
vertex, height clamps and `is_tall` consistency, `height_source` distribution
(all three rules present for Chicago, `height_tag_ratio` strictly in (0,1) and
equal to the tag share), bounds containment and "no lat/lon past the boundary",
road class enum, unique ids, contract round-trip, a 90 deg rotation equivalence
test, synthetic empty/degenerate/duplicate cases, all six presets normalizing
to `good`, and the `/presets` + `/scene` routes including cache hits and the
502/503/400 paths.

Whole suite: `cd services/bake && uv run pytest -q` -> **147 passed in ~16 s**
(74 pre-existing contract tests unchanged and still green). The fix pass below
adds 50 more, for **197 passed in ~40 s**.

## Known limitations

* `height_tag_ratio` is below 0.15 for Chicago (0.111), Paris (0.009) and
  London (0.034), so the UI's "heights are largely estimated" warning will fire
  on three of the six presets. That is the honest state of OSM there, not a
  parser bug (Paris and London are tagged with `building:levels`, not
  `height`).
* Road sets are footway-heavy: 3 982 of Chicago's 5 443 roads map to class
  `path` (sidewalks, crossings). 03's query asks for `footway`, so they are
  ingested; the preview and the bake may want to drop `path` at large radii.
  Nothing is filtered here.
* Hygiene step 7 deliberately does not merge buildings that only share a wall
  (see DECISIONS [P2]); a Paris block stays a row of separate prisms.
* Fixtures are an OSM snapshot from 2026-08-29. Counts will drift after
  `make refresh-fixtures`; the test ranges are wide on purpose, but a refresh
  should be followed by regenerating `fixtures/chicago-scene.json` with
  `uv run python -m app.cli scene --preset chicago-loop --compact --out ../../fixtures/chicago-scene.json`.
* A request that keeps a `preset_id` but edits the rotation is no longer the
  preset and needs a live Overpass fetch (the bbox depends on the rotation).
  The editor should expect a slower response there, or a 502/503 when offline.
* `building:part` (3D building detail), terrain and non-`out geom` fallbacks
  are not implemented; terrain is flagged off in the MVP per 03.
* `ruff` still cannot run on this host (Application Control policy, see
  DECISIONS [P1]); style was kept to the configured rules by hand.

## Verify

```
cd services/bake && uv run pytest -q
```

## Fix pass (2026-08-29, fixer, six audit defects)

All six verified defects fixed inside the P2 files; no test weakened, skipped
or deleted, no contract field touched. `cd services/bake && uv run pytest -q`
-> **197 passed** (147 before, 50 added). Seven `[P2-fix]` lines appended to
DECISIONS.md.

### 1-2. Overpass 200 that is really an error (major, `overpass.py`)

Overpass answers a query timeout or an exhausted memory budget with **HTTP
200**, an empty `elements` list and a `remark`
(`runtime error: Query timed out in "query" ... after 180 seconds.`). `_parse`
only checked that `elements` was a list, so the body was accepted, written to
`fixtures/<sha1>.json` and memoized - and because `load_raw` is
cache-before-network with no TTL, that location served `coverage=empty` with 0
buildings for ever. `make refresh-fixtures` would have committed the poison.

* `fatal_remark(data)` (new, exported) recognises a `runtime error` /
  `out of memory` remark, and also any remark next to an empty `elements` list.
* `_parse` raises `OverpassUnavailable(..., switch_mirror=True)` for the
  timeout/OOM shapes, so the retry loop falls back to the kumi.systems mirror
  exactly as it does for a 504 (03 "Retry policy").
* `_parse` now runs **inside** the per-attempt `try`, so a proxy's HTML 200
  gets the retry policy too instead of escaping on attempt 1.
* The fixture is written only after `_parse` has accepted the body.
* `load_raw` refuses to serve an already-cached error body: `FixtureMissing`
  when the network is off, a fresh fetch when it is on.

Tests: `test_a_200_carrying_a_runtime_error_is_retried_and_never_cached`
(timeout and OOM bodies, asserts 3 attempts, mirror on attempts 2-3, an empty
fixture dir and a `FixtureMissing` afterwards),
`test_an_html_200_from_a_proxy_is_retried_not_raised_on_the_first_attempt`,
`test_a_cached_error_body_is_never_served_as_an_empty_scene`,
`test_fatal_remark_only_rejects_error_bodies`,
`test_every_committed_preset_fixture_is_data_not_an_error_body`.

### 3. bbox applied the rotation reach twice (major, `overpass.py`)

The sampled ring lives in the **rotated** `LocalFrame`, and `to_wgs84`
un-rotates it - which is already what produces DECISIONS [P2]'s
`(|cos t| + |sin t|)` reach. Multiplying the ring by that reach as well made
the fetched window `1.15 * r * reach^2`: New York asked for a 1 941 m
half-extent instead of 1 407 m (at r=3000, rot=45 that is a 13.96 km side
instead of 9.76 km, ~2x the area and ~2x the timeout risk). The ring is now
built at `radius_m * BBOX_MARGIN`; `unrotated_reach_m()` documents the
invariant that `bbox_for` must satisfy.

Only the New York query text changed. Its fixture was re-fetched
(`f41c2522...`, 12.9 MB, 16 998 elements, down from 20.6 MB / 28 130) and
`fixtures/presets-index.json` regenerated; the other five sha1s are
byte-identical. **The normalized New York scene is unchanged** (2 683
buildings, height_tag_ratio 0.897, same roads/water/green/tree counts), i.e.
the 40% of the response that is gone was all outside the crop. Test:
`test_bbox_applies_the_rotation_reach_exactly_once` (NY within 2% of
`1.15 * 900 * (cos29 + sin29)`, the five unrotated presets within the UTM
bulge of `1.15 * 900`).

### 4. Courtyards filled by a `building`-tagged outer way (major, `normalize.py`)

When a multipolygon's outer member way is itself tagged `building=*` (old-style
OSM, and 03 step 6 says both come back), the hole-less way used to win: step 6
merged the pair keeping the largest area when the courtyard was under 5%, and
step 7 unioned them - filling the hole - when it was larger.

* Classification now collects the outer member way ids of every **building**
  relation that actually carries geometry, and skips those ways as standalone
  buildings. The relation is authoritative; it has the holes.
* Belt and braces: step 6 compares **hole-less** (exterior) areas so a holed
  relation still matches its outer way, and the merged group keeps the geometry
  and id of the member with the most interiors.

Real regression: london-city r1439717 (Haberdashers Hall) was emitted as
w100835946, 1 556 m2 with 0 holes; it is now r1439717, 1 213 m2 with 1 hole
(a 343 m2 courtyard no longer printed solid). Tests:
`test_london_relation_1439717_keeps_its_courtyard`,
`test_a_courtyard_survives_its_outer_way_being_tagged_building` (25% and 4%
courtyards, i.e. the union path and the dedupe path).

### 5. Holes touching their own exterior (major, `normalize.py`)

`difference()` on rings that differ by ~1e-9 m leaves an epsilon-wide sliver;
`simplify(0.25, preserve_topology=True)` keeps it by design, and the 1 mm
emission rounding then collapsed it into a ring self-intersection - so the
building lost all its holes (corner contact) or was dropped outright (edge
contact).

* `shapely.set_precision(g, 0.001)` (GEOS snap-rounding, topology repairing) at
  the end of `_clean` and again on each cropped part, i.e. the geometry is put
  on the emission grid **before** its validity is judged.
* `_rings_of` repairs a still-invalid rounded polygon with `make_valid` and
  emits its largest polygonal part, instead of silently dropping the holes and
  then the part.

Both synthetic cases now come out as valid 1 500 m2 notched polygons. Over the
six fixtures the hole-drop and part-drop fallbacks now fire **0 times**
(paris-eiffel previously lost 2 courtyards on a 4 607 m2 block). Tests:
`test_a_hole_that_touches_its_own_exterior_is_emitted_as_a_notch` (edge and
corner), `test_no_preset_emits_a_footprint_that_lost_its_holes_to_rounding`.

### 6. Non-finite tag values on the wire (major, `normalize.py`, `main.py`)

`parse_levels("1e308") * 3.5` was `inf`, `Road(width_m=inf)` passed pydantic,
FastAPI serialised it as `"width_m": null` (which then fails re-validation) and
the disk cache wrote non-standard `Infinity`.

* `parse_length_m` and `parse_levels` return `None` unless `math.isfinite`.
* `road_width_m` is clamped to `[MIN_ROAD_WIDTH_M, MAX_ROAD_WIDTH_M]` =
  [0.5, 60] m, matching the existing height and tree-radius clamps. The 03
  table and the `lanes * 3.5` rule are untouched inside that range.
* `main._cache_put` uses `json.dumps(..., allow_nan=False)`.

Tests: `test_parse_length_rejects_non_finite`,
`test_parse_levels_never_returns_a_non_finite_number`,
`test_road_width_is_finite_and_clamped`,
`test_height_stays_finite_for_hostile_tags` (all over
`inf`/`-inf`/`Infinity`/`nan`/`NaN`/`1e308`/`1e400`/400 digits), and
`test_a_hostile_tag_cannot_put_a_non_finite_number_on_the_wire` (a full scene
round-tripped through `json.dumps(allow_nan=False)` and back into `SceneGraph`).

### Effect on the six fixtures

Building counts, coverage and height_tag_ratio are unchanged for all six
(chicago 994, new-york 2 683, paris 2 905, tokyo 5 401, london 2 197, sf
2 648; all `good`). london-city gains one courtyard (105 -> 106 holes over
37 -> 38 buildings). `fixtures/chicago-scene.json` was regenerated with
`uv run python -m app.cli scene --preset chicago-loop --compact --out
../../fixtures/chicago-scene.json`: identical stats, 956 footprints moved by at
most 1 mm by the snap-rounding.

### Files touched in this pass

```
services/bake/app/ingest/overpass.py   fatal_remark, retry loop, bbox
services/bake/app/ingest/normalize.py  outer-way skip, dedupe, set_precision, clamps
services/bake/app/main.py              _cache_put allow_nan=False (2 lines)
services/bake/app/cli.py               refresh-fixtures --if-missing rejects a cached error body
services/bake/tests/test_ingest.py     +50 tests, nothing removed or relaxed
fixtures/f41c2522...json               NEW York fixture (old d4509a68... pruned)
fixtures/presets-index.json            regenerated
fixtures/chicago-scene.json            regenerated
DECISIONS.md                           +7 [P2-fix] lines
```

`make refresh-fixtures --preset new-york-midtown` also pruned an orphan sha1
fixture (`67ba0986...`) that no preset pointed at, which is that command's
documented stale-fixture behaviour.
