"""Ingest tests: Overpass fixtures -> SceneGraph (03).

Everything here is offline: ``conftest.py`` sets ``FRAMECRAFT_OFFLINE=1`` so any
network attempt raises, and the scenes are built from the six committed raw
Overpass fixtures under ``fixtures/``.

Building counts measured on the committed fixtures (2026-08-29, 900 m radius):
chicago-loop 994, new-york-midtown 2683, paris-eiffel 2905, tokyo-shinjuku
5401, london-city 2197, san-francisco-fidi 2648.  The ranges asserted below are
deliberately wide (roughly +/-40%) so an OSM refresh moves the numbers without
breaking the suite, while still catching a pipeline that silently drops or
duplicates whole layers.
"""
from __future__ import annotations

import argparse
import json
import math
import time

import pytest
from fastapi.testclient import TestClient
from shapely.geometry import LinearRing, Polygon

from app import main as main_module
from app.contracts import SceneGraph, SceneRequest, Stats
from app.geom import project
from app.ingest import normalize, overpass, presets

RADIUS = presets.PRESET_RADIUS_M
EPS = 1e-6


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------


def _raw(preset_id: str) -> dict:
    return overpass.load_raw(presets.PRESETS_BY_ID[preset_id].request(), allow_network=False)


def _scene(preset_id: str) -> SceneGraph:
    request = presets.PRESETS_BY_ID[preset_id].request()
    return normalize.build_scene(_raw(preset_id), request)


@pytest.fixture(scope="module")
def chicago() -> SceneGraph:
    return _scene("chicago-loop")


@pytest.fixture(scope="module")
def paris() -> SceneGraph:
    return _scene("paris-eiffel")


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(main_module.app)


# ---------------------------------------------------------------------------
# presets and fixture cache
# ---------------------------------------------------------------------------

EXPECTED_PRESETS = [
    ("chicago-loop", 41.8827, -87.6233, 0.0),
    ("new-york-midtown", 40.7549, -73.9840, 29.0),
    ("paris-eiffel", 48.8584, 2.2945, 0.0),
    ("tokyo-shinjuku", 35.6896, 139.7006, 0.0),
    ("london-city", 51.5155, -0.0922, 0.0),
    ("san-francisco-fidi", 37.7946, -122.3999, 0.0),
]


def test_six_presets_have_the_specified_centers():
    assert [(p.id, p.lat, p.lon, p.rotation_deg) for p in presets.PRESETS] == EXPECTED_PRESETS
    assert all(p.radius_m == 900.0 for p in presets.PRESETS)


@pytest.mark.parametrize("preset", presets.PRESETS, ids=[p.id for p in presets.PRESETS])
def test_every_preset_fixture_is_committed(preset: presets.Preset):
    path = overpass.fixture_path(overpass.build_query(preset.request()))
    assert path.is_file(), f"missing fixture for {preset.id}: {path.name}"


def test_query_text_matches_the_spec():
    query = overpass.build_query(presets.PRESETS_BY_ID["chicago-loop"].request())
    assert query.startswith("[out:json][timeout:180];\n(\n")
    assert query.rstrip().endswith("out geom;")
    # The tag sets, spelled once so the assertions below cannot drift from
    # each other ([V3.1-U9]).
    NAT = "water|bay|strait|wood|scrub|grassland|heath|shrubbery|wetland"
    LU = "grass|forest|meadow|recreation_ground|village_green|allotments|orchard|vineyard|cemetery|greenfield|reservoir|basin"
    LE = "park|garden|pitch|playground|golf_course|nature_reserve|dog_park|common"
    for line in (
        'way["building"]',
        'relation["building"]',
        'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|'
        'unclassified|service|pedestrian|footway)$"]',
        f'way["natural"~"^({NAT})$"]',
        f'relation["natural"~"^({NAT})$"]',
        'way["waterway"~"^(riverbank|dock)$"]',
        'relation["waterway"~"^(riverbank|dock)$"]',
        f'way["landuse"~"^({LU})$"]',
        f'relation["landuse"~"^({LU})$"]',
        f'way["leisure"~"^({LE})$"]',
        # Relations as well as ways, which is the half that was missing:
        # a park mapped as a multipolygon was never downloaded ([V3.1-U9]).
        f'relation["leisure"~"^({LE})$"]',
        'node["natural"="tree"]',
    ):
        assert line in query
    # 15% margin, unrotated: the bbox is ~2 * 1.15 * radius across.
    south, west, north, east = overpass.bbox_for(presets.PRESETS_BY_ID["chicago-loop"].request())
    span_m = (north - south) * 111_320.0
    assert 2 * 1.15 * RADIUS * 0.98 <= span_m <= 2 * 1.15 * RADIUS * 1.02


def test_rotation_by_90_reuses_the_same_bbox_and_fixture():
    base = presets.PRESETS_BY_ID["chicago-loop"].request()
    turned = base.model_copy(update={"rotation_deg": 90.0})
    assert overpass.build_query(base) == overpass.build_query(turned)


def test_network_is_blocked_while_offline():
    assert overpass.is_offline()
    request = presets.PRESETS_BY_ID["chicago-loop"].request()
    with pytest.raises(overpass.OverpassOffline):
        overpass.fetch_and_cache(request, sleep=lambda _s: None)


def test_missing_fixture_without_network_raises_fixture_missing():
    request = SceneRequest(lat=0.0, lon=0.0, radius_m=250.0, rotation_deg=0.0, preset_id=None)
    with pytest.raises(overpass.FixtureMissing):
        overpass.load_raw(request, allow_network=False)


# ---------------------------------------------------------------------------
# projection
# ---------------------------------------------------------------------------


def test_utm_zone_and_hemisphere():
    assert project.utm_epsg(41.8827, -87.6233) == 32616  # Chicago, zone 16 north
    assert project.utm_epsg(35.6896, 139.7006) == 32654  # Tokyo, zone 54 north
    assert project.utm_epsg(-33.8688, 151.2093) == 32756  # Sydney, zone 56 south


def test_frame_puts_the_center_at_the_origin_and_measures_meters():
    frame = project.LocalFrame(41.8827, -87.6233, 0.0)
    x, y = frame.point_to_local(-87.6233, 41.8827)
    assert abs(x) < 1e-6 and abs(y) < 1e-6
    # 0.001 deg of latitude is ~111.2 m due north.
    x, y = frame.point_to_local(-87.6233, 41.8837)
    assert abs(x) < 1.0
    assert 110.0 < y < 112.5


def test_rotation_turns_a_compass_bearing_into_plus_y():
    """rotation_deg is the bearing that ends up pointing +y (up) in the model."""
    lat, lon = 40.7549, -73.9840
    plain = project.LocalFrame(lat, lon, 0.0)
    turned = project.LocalFrame(lat, lon, 29.0)
    # a point 500 m away at bearing 29 deg
    bearing = math.radians(29.0)
    east = 500.0 * math.sin(bearing)
    north = 500.0 * math.cos(bearing)
    target = plain.to_wgs84([(east, north)])[0]
    x, y = turned.point_to_local(target[0], target[1])
    assert abs(x) < 0.5
    assert abs(y - 500.0) < 0.5


# ---------------------------------------------------------------------------
# tag parsing / height inference
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("12.5 m", 12.5),
        ("12.5m", 12.5),
        ("12,5 m", 12.5),
        ("15", 15.0),
        ("15.0", 15.0),
        ("41'", 41 * 0.3048),
        ("41'6\"", 41 * 0.3048 + 6 * 0.0254),
        ("135 ft", 135 * 0.3048),
        ("3 metres", 3.0),
        ("450 cm", 4.5),
        ("12;14", 12.0),
    ],
)
def test_parse_length_units(text: str, expected: float):
    parsed = normalize.parse_length_m(text)
    assert parsed is not None
    assert parsed == pytest.approx(expected, rel=1e-9)


@pytest.mark.parametrize("text", ["", "  ", "tall", "about 12", "-4", "0", None])
def test_parse_length_rejects_garbage(text):
    assert normalize.parse_length_m(text) is None


def test_height_rule_1_height_tag():
    height, source, _ = normalize.resolve_height({"building": "yes", "height": "12.5 m"}, "w1")
    assert (height, source) == (12.5, "tag")
    height, source, _ = normalize.resolve_height({"building": "yes", "height": "41'"}, "w1")
    assert source == "tag"
    assert height == pytest.approx(41 * 0.3048)


def test_height_rule_2_levels_and_roof():
    height, source, _ = normalize.resolve_height({"building": "yes", "building:levels": "3"}, "w2")
    assert (height, source) == (3 * 3.2, "levels")
    height, source, _ = normalize.resolve_height(
        {"building": "yes", "building:levels": "3", "roof:height": "2"}, "w2"
    )
    assert (height, source) == (3 * 3.2 + 2.0, "levels")


def test_height_rule_3_min_level():
    _, _, min_height = normalize.resolve_height(
        {"building": "yes", "building:levels": "10", "building:min_level": "2"}, "w3"
    )
    assert min_height == pytest.approx(2 * 3.2)


def test_height_rule_4_type_defaults_and_5_global_fallback():
    for building, base in normalize.TYPE_DEFAULT_HEIGHT_M.items():
        height, source, _ = normalize.resolve_height({"building": building}, f"w{building}")
        assert source == "default"
        assert abs(height - base) <= base * normalize.JITTER + 1e-9 or height == pytest.approx(
            normalize.MIN_HEIGHT_M
        )
    height, source, _ = normalize.resolve_height({"building": "yes"}, "w999")
    assert source == "default"
    assert abs(height - normalize.DEFAULT_HEIGHT_M) <= normalize.DEFAULT_HEIGHT_M * normalize.JITTER


def test_height_is_clamped():
    high, _, _ = normalize.resolve_height({"building": "yes", "height": "5000"}, "w4")
    low, _, _ = normalize.resolve_height({"building": "yes", "height": "0.4"}, "w5")
    assert high == normalize.MAX_HEIGHT_M
    assert low == normalize.MIN_HEIGHT_M


def test_jitter_is_deterministic_and_bounded():
    a = normalize.jitter_factor("w42")
    b = normalize.jitter_factor("w42")
    assert a == b
    assert abs(a - 1.0) <= normalize.JITTER
    others = {normalize.jitter_factor(f"w{i}") for i in range(50)}
    assert len(others) == 50  # different ids give different jitter
    tags = {"building": "yes"}
    assert normalize.resolve_height(tags, "w7") == normalize.resolve_height(tags, "w7")
    assert normalize.resolve_height(tags, "w7") != normalize.resolve_height(tags, "w8")


def test_road_width_and_class_tables():
    assert normalize.HIGHWAY_WIDTH_M == {
        "motorway": 24.0,
        "trunk": 20.0,
        "primary": 16.0,
        "secondary": 12.0,
        "tertiary": 10.0,
        "residential": 8.0,
        "unclassified": 8.0,
        "service": 5.0,
        "pedestrian": 6.0,
        "footway": 3.0,
    }
    assert normalize.road_width_m({"highway": "primary"}, "primary") == 16.0
    assert normalize.road_width_m({"highway": "primary", "lanes": "4"}, "primary") == 14.0
    assert normalize.road_width_m(
        {"highway": "primary", "lanes": "4", "width": "18 m"}, "primary"
    ) == 18.0
    # DECISIONS.md [P1] mapping into the smaller SceneGraph enum
    assert normalize.road_class("trunk") == "motorway"
    assert normalize.road_class("tertiary") == "secondary"
    assert normalize.road_class("unclassified") == "residential"
    assert normalize.road_class("pedestrian") == "path"
    assert normalize.road_class("footway") == "path"


def test_coverage_thresholds():
    crop = (2 * RADIUS) ** 2
    assert normalize.classify_coverage(19, 0.5 * crop, crop) == "empty"
    assert normalize.classify_coverage(20, 0.5 * crop, crop) == "sparse"
    assert normalize.classify_coverage(149, 0.5 * crop, crop) == "sparse"
    assert normalize.classify_coverage(150, 0.04 * crop, crop) == "good"
    assert normalize.classify_coverage(150, 0.039 * crop, crop) == "sparse"


# ---------------------------------------------------------------------------
# scene structure, over the Chicago and Paris fixtures
# ---------------------------------------------------------------------------


def _check_ring(ring, ccw: bool) -> None:
    assert len(ring) >= 3
    assert tuple(ring[0]) != tuple(ring[-1]), "rings must not repeat the closing vertex"
    assert LinearRing(ring).is_ccw is ccw


@pytest.mark.parametrize("name", ["chicago", "paris"])
def test_building_counts_are_plausible(name, request):
    scene: SceneGraph = request.getfixturevalue(name)
    lo, hi = {"chicago": (600, 1600), "paris": (1800, 4500)}[name]
    assert lo <= scene.stats.building_count <= hi
    assert scene.stats.building_count == len(scene.buildings)


@pytest.mark.parametrize("name", ["chicago", "paris"])
def test_coverage_is_good(name, request):
    scene: SceneGraph = request.getfixturevalue(name)
    assert scene.stats.coverage == "good"


@pytest.mark.parametrize("name", ["chicago", "paris"])
def test_every_polygon_is_valid_and_wound_correctly(name, request):
    scene: SceneGraph = request.getfixturevalue(name)
    for building in scene.buildings:
        _check_ring(building.ring, ccw=True)
        for hole in building.holes:
            _check_ring(hole, ccw=False)
        poly = Polygon(building.ring, building.holes)
        assert poly.is_valid, f"invalid footprint {building.id}"
        assert poly.area > 0
    for feature in list(scene.water) + list(scene.green):
        _check_ring(feature.ring, ccw=True)
        for hole in feature.holes:
            _check_ring(hole, ccw=False)
        assert Polygon(feature.ring, feature.holes).is_valid


@pytest.mark.parametrize("name", ["chicago", "paris"])
def test_heights_are_clamped_and_is_tall_is_consistent(name, request):
    scene: SceneGraph = request.getfixturevalue(name)
    for b in scene.buildings:
        assert normalize.MIN_HEIGHT_M <= b.height_m <= normalize.MAX_HEIGHT_M
        assert b.is_tall == (b.height_m >= 40.0)
        assert 0.0 <= b.min_height_m < b.height_m
        assert b.height_source in {"tag", "levels", "default"}


def test_height_source_distribution_is_sane(chicago: SceneGraph, paris: SceneGraph):
    for scene in (chicago, paris):
        sources = {b.height_source for b in scene.buildings}
        assert sources <= {"tag", "levels", "default"}
        tagged = sum(1 for b in scene.buildings if b.height_source == "tag")
        assert scene.stats.height_tag_ratio == pytest.approx(
            tagged / scene.stats.building_count, abs=1e-6
        )
        assert 0.0 < scene.stats.height_tag_ratio < 1.0
    # Chicago exercises all three inference rules.
    assert {b.height_source for b in chicago.buildings} == {"tag", "levels", "default"}
    # ... and a real downtown has skyscrapers.
    assert max(b.height_m for b in chicago.buildings) > 200.0
    assert any(b.is_tall for b in chicago.buildings)


@pytest.mark.parametrize("name", ["chicago", "paris"])
def test_everything_is_inside_the_bounds_and_no_latlon_leaks(name, request):
    scene: SceneGraph = request.getfixturevalue(name)
    b = scene.bounds
    assert (b.min_x, b.min_y, b.max_x, b.max_y) == (-RADIUS, -RADIUS, RADIUS, RADIUS)

    def inside(points):
        for x, y in points:
            assert b.min_x - EPS <= x <= b.max_x + EPS
            assert b.min_y - EPS <= y <= b.max_y + EPS

    for building in scene.buildings:
        inside(building.ring)
        for hole in building.holes:
            inside(hole)
    for road in scene.roads:
        inside(road.path)
    for feature in list(scene.water) + list(scene.green):
        inside(feature.ring)
    inside([(t.x, t.y) for t in scene.trees])
    # the center is the only lat/lon on a SceneGraph
    payload = scene.model_dump(mode="json")
    assert set(payload["center"]) == {"lat", "lon"}
    assert "lat" not in json.dumps(payload["buildings"][:50])


@pytest.mark.parametrize("name", ["chicago", "paris"])
def test_roads_and_trees_respect_the_contract(name, request):
    scene: SceneGraph = request.getfixturevalue(name)
    allowed = {"motorway", "primary", "secondary", "residential", "service", "path"}
    assert scene.roads, "a downtown crop must contain roads"
    for road in scene.roads:
        assert road.class_ in allowed
        assert road.width_m > 0
        assert len(road.path) >= 2
    assert {r.class_ for r in scene.roads} <= allowed
    for tree in scene.trees:
        assert tree.radius_m > 0


@pytest.mark.parametrize("name", ["chicago", "paris"])
def test_ids_are_unique_and_prefixed(name, request):
    scene: SceneGraph = request.getfixturevalue(name)
    ids = [b.id for b in scene.buildings]
    assert len(ids) == len(set(ids))
    assert all(i[0] in {"w", "r", "n"} for i in ids)
    assert all(r.id[0] in {"w", "r"} for r in scene.roads)


@pytest.mark.parametrize("preset", presets.PRESETS, ids=[p.id for p in presets.PRESETS])
def test_every_preset_normalizes_to_a_good_scene(preset: presets.Preset):
    """All six demo cities must survive the dirtiest real OSM geometry."""
    scene = _scene(preset.id)
    assert scene.stats.coverage == "good"
    assert scene.stats.building_count >= 150
    assert scene.bounds.max_x == preset.radius_m
    assert scene.center.lat == preset.lat and scene.center.lon == preset.lon
    for building in scene.buildings:
        assert Polygon(building.ring, building.holes).is_valid
    assert any(building.holes for building in scene.buildings), "courtyards must survive"


def test_scene_round_trips_through_the_frozen_contract(chicago: SceneGraph):
    payload = chicago.model_dump(mode="json")
    assert SceneGraph(**payload).model_dump(mode="json") == payload
    assert payload["roads"][0]["class"], "the contract key is 'class', not 'class_'"


# ---------------------------------------------------------------------------
# rotation
# ---------------------------------------------------------------------------


def test_rotating_the_crop_rotates_the_buildings(chicago: SceneGraph):
    """A 90 deg crop is the 0 deg crop rotated: the square is symmetric, so the
    same buildings come back with (x, y) -> (-y, x)."""
    request = presets.PRESETS_BY_ID["chicago-loop"].request()
    turned = normalize.build_scene(
        _raw("chicago-loop"), request.model_copy(update={"rotation_deg": 90.0})
    )
    assert turned.stats.building_count == chicago.stats.building_count

    def key(points):
        cx = sum(p[0] for p in points) / len(points)
        cy = sum(p[1] for p in points) / len(points)
        return (round(cx, 1), round(cy, 1))

    expected = sorted((round(-cy, 1), round(cx, 1)) for cx, cy in map(key, (b.ring for b in chicago.buildings)))
    actual = sorted(key(b.ring) for b in turned.buildings)
    assert len(expected) == len(actual)
    mismatched = sum(
        1
        for (ex, ey), (ax, ay) in zip(expected, actual)
        if abs(ex - ax) > 0.15 or abs(ey - ay) > 0.15
    )
    assert mismatched == 0
    assert {b.height_m for b in turned.buildings} == {b.height_m for b in chicago.buildings}


# ---------------------------------------------------------------------------
# synthetic coverage cases
# ---------------------------------------------------------------------------


def _square_way(way_id: int, lat: float, lon: float, size_deg: float, tags: dict) -> dict:
    return {
        "type": "way",
        "id": way_id,
        "tags": tags,
        "geometry": [
            {"lat": lat, "lon": lon},
            {"lat": lat, "lon": lon + size_deg},
            {"lat": lat + size_deg, "lon": lon + size_deg},
            {"lat": lat + size_deg, "lon": lon},
            {"lat": lat, "lon": lon},
        ],
    }


def test_synthetic_low_coverage_is_empty():
    lat, lon = 41.8827, -87.6233
    raw = {
        "elements": [
            _square_way(i, lat + i * 0.0004, lon, 0.0003, {"building": "yes"}) for i in range(5)
        ]
    }
    request = SceneRequest(lat=lat, lon=lon, radius_m=250.0, rotation_deg=0.0, preset_id=None)
    scene = normalize.build_scene(raw, request)
    assert scene.stats.building_count == 5
    assert scene.stats.coverage == "empty"
    assert scene.stats.height_tag_ratio == 0.0
    assert all(b.height_source == "default" for b in scene.buildings)


def test_synthetic_scene_with_no_elements_is_empty():
    request = SceneRequest(lat=0.0, lon=0.0, radius_m=250.0, rotation_deg=0.0, preset_id=None)
    scene = normalize.build_scene({"elements": []}, request)
    assert scene.stats == Stats(building_count=0, coverage="empty", height_tag_ratio=0.0)
    assert scene.buildings == [] and scene.roads == []


def test_degenerate_ways_are_dropped():
    lat, lon = 41.8827, -87.6233
    raw = {
        "elements": [
            {  # three nodes: fewer than 4 -> dropped by hygiene step 1
                "type": "way",
                "id": 1,
                "tags": {"building": "yes"},
                "geometry": [
                    {"lat": lat, "lon": lon},
                    {"lat": lat, "lon": lon + 0.0003},
                    {"lat": lat + 0.0003, "lon": lon},
                ],
            },
            {  # zero area
                "type": "way",
                "id": 2,
                "tags": {"building": "yes"},
                "geometry": [
                    {"lat": lat, "lon": lon},
                    {"lat": lat, "lon": lon + 0.0003},
                    {"lat": lat, "lon": lon + 0.0006},
                    {"lat": lat, "lon": lon},
                ],
            },
            _square_way(3, lat, lon, 0.0003, {"building": "yes"}),
        ]
    }
    request = SceneRequest(lat=lat, lon=lon, radius_m=250.0, rotation_deg=0.0, preset_id=None)
    scene = normalize.build_scene(raw, request)
    assert [b.id for b in scene.buildings] == ["w3"]


def test_overlapping_duplicates_are_deduped_but_neighbours_are_not():
    lat, lon = 41.8827, -87.6233
    raw = {
        "elements": [
            _square_way(1, lat, lon, 0.0003, {"building": "yes", "height": "20"}),
            # same footprint, tagged twice (relation + member way)
            _square_way(2, lat, lon, 0.0003, {"building": "yes", "height": "30"}),
            # shares an edge only: a Paris-style block neighbour, must survive
            _square_way(3, lat, lon + 0.0003, 0.0003, {"building": "yes", "height": "10"}),
        ]
    }
    request = SceneRequest(lat=lat, lon=lon, radius_m=250.0, rotation_deg=0.0, preset_id=None)
    scene = normalize.build_scene(raw, request)
    assert scene.stats.building_count == 2
    assert sorted(b.height_m for b in scene.buildings) == [10.0, 30.0]


# ---------------------------------------------------------------------------
# API: GET /presets, POST /scene
# ---------------------------------------------------------------------------


def test_get_presets_returns_the_six_requests(client: TestClient):
    response = client.get("/presets")
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 6
    assert [p["preset_id"] for p in body] == [p[0] for p in EXPECTED_PRESETS]
    for entry, (pid, lat, lon, rot) in zip(body, EXPECTED_PRESETS):
        assert (entry["lat"], entry["lon"], entry["rotation_deg"]) == (lat, lon, rot)
        assert entry["radius_m"] == 900
        assert set(entry) == {"lat", "lon", "radius_m", "rotation_deg", "preset_id"}
        assert SceneRequest(**entry).preset_id == pid


def test_post_scene_for_a_preset_is_offline_cached_and_good(
    client: TestClient, tmp_path, monkeypatch
):
    monkeypatch.setattr(main_module, "SCENE_CACHE_DIR", tmp_path / "scene")
    main_module._scene_mem_cache.clear()

    calls = {"post": 0, "normalize": 0}
    real_build = normalize.build_scene

    def counting_build(raw, request):
        calls["normalize"] += 1
        return real_build(raw, request)

    def forbidden_post(*_a, **_kw):  # pragma: no cover - must never run
        calls["post"] += 1
        raise AssertionError("the preset path must not touch the network")

    monkeypatch.setattr(main_module.normalize, "build_scene", counting_build)
    monkeypatch.setattr(overpass, "_post", forbidden_post)

    payload = presets.PRESETS_BY_ID["chicago-loop"].request().model_dump(mode="json")
    first = client.post("/scene", json=payload)
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["stats"]["coverage"] == "good"
    assert body["stats"]["building_count"] > 150
    assert body["center"] == {"lat": 41.8827, "lon": -87.6233}
    assert body["bounds"] == {"min_x": -900, "min_y": -900, "max_x": 900, "max_y": 900}
    assert SceneGraph(**body).stats.coverage == "good"
    assert calls == {"post": 0, "normalize": 1}
    assert (tmp_path / "scene").is_dir()

    started = time.perf_counter()
    second = client.post("/scene", json=payload)
    warm_s = time.perf_counter() - started
    assert second.status_code == 200
    assert second.json() == body
    assert calls["normalize"] == 1, "the second call must be served from the cache"
    assert warm_s < 2.0  # 02's warm budget is 300 ms; this is a loaded-CI guard

    # a cold process still finds the scene on disk
    main_module._scene_mem_cache.clear()
    third = client.post("/scene", json=payload)
    assert third.status_code == 200
    assert third.json() == body
    assert calls["normalize"] == 1


def test_post_scene_rejects_an_unknown_preset(client: TestClient):
    payload = {
        "lat": 41.8827,
        "lon": -87.6233,
        "radius_m": 900,
        "rotation_deg": 0,
        "preset_id": "atlantis",
    }
    response = client.post("/scene", json=payload)
    assert response.status_code == 400
    assert "atlantis" in response.json()["detail"]


def test_post_scene_without_a_fixture_fails_cleanly_while_offline(
    client: TestClient, tmp_path, monkeypatch
):
    monkeypatch.setattr(main_module, "SCENE_CACHE_DIR", tmp_path / "scene")
    main_module._scene_mem_cache.clear()
    response = client.post(
        "/scene",
        json={"lat": 0.0, "lon": 0.0, "radius_m": 250, "rotation_deg": 0, "preset_id": None},
    )
    assert response.status_code == 503
    assert "FRAMECRAFT_OFFLINE" in response.json()["detail"]


def test_post_scene_reports_502_when_overpass_is_down(client: TestClient, tmp_path, monkeypatch):
    monkeypatch.setattr(main_module, "SCENE_CACHE_DIR", tmp_path / "scene")
    main_module._scene_mem_cache.clear()

    def boom(request, **kwargs):
        raise overpass.OverpassUnavailable("Overpass unreachable after 3 attempts (HTTP 504)")

    monkeypatch.setattr(main_module.overpass, "load_raw", boom)
    response = client.post(
        "/scene",
        json={"lat": 10.0, "lon": 10.0, "radius_m": 250, "rotation_deg": 0, "preset_id": None},
    )
    assert response.status_code == 502
    assert "Overpass unreachable" in response.json()["detail"]


def test_committed_chicago_scene_fixture_matches_the_pipeline(chicago: SceneGraph):
    """fixtures/chicago-scene.json is generated from the committed raw fixture."""
    path = overpass.FIXTURES_DIR / "chicago-scene.json"
    committed = json.loads(path.read_text(encoding="utf-8"))
    assert committed["stats"] == chicago.model_dump(mode="json")["stats"]
    assert committed["stats"]["coverage"] == "good"
    assert len(committed["buildings"]) == chicago.stats.building_count


# ---------------------------------------------------------------------------
# fix pass: Overpass bbox, error bodies, cache poisoning
# ---------------------------------------------------------------------------

CHICAGO_LL = (41.8827, -87.6233)

#: Overpass reports a timed-out or out-of-memory query as HTTP 200 with an
#: empty ``elements`` list and a ``remark``; both bodies below are the shapes
#: the Overpass API documents.
TIMEOUT_BODY = json.dumps(
    {
        "version": 0.6,
        "generator": "Overpass API 0.7.62.7",
        "remark": 'runtime error: Query timed out in "query" at line 4 after 180 seconds.',
        "elements": [],
    }
)
OOM_BODY = json.dumps(
    {
        "version": 0.6,
        "generator": "Overpass API 0.7.62.7",
        "remark": 'runtime error: Query run out of memory in "query" at line 3.',
        "elements": [],
    }
)


class _FakeResponse:
    def __init__(self, status_code: int, text: str) -> None:
        self.status_code = status_code
        self.text = text


def _bbox_half_extent_m(request: SceneRequest) -> tuple[float, float]:
    """Half width/height of an Overpass bbox, measured in unrotated meters."""
    south, west, north, east = overpass.bbox_for(request)
    frame = project.LocalFrame(request.lat, request.lon, 0.0)
    xy = frame.to_local([west, east, west, east], [south, south, north, north])
    return (
        float(xy[:, 0].max() - xy[:, 0].min()) / 2.0,
        float(xy[:, 1].max() - xy[:, 1].min()) / 2.0,
    )


def test_bbox_applies_the_rotation_reach_exactly_once():
    """DECISIONS [P2]: half = radius_m * (|cos t| + |sin t|) * 1.15, applied once.

    The ring is built in the rotated frame and ``to_wgs84`` un-rotates it, so
    multiplying the ring by the reach factor as well squares it: New York would
    ask Overpass for a 2.8 km half-window instead of 1.4 km (~2x the area and
    ~2x the chance of hitting the 180 s timeout).
    """
    t = math.radians(29.0)
    expected = 1.15 * RADIUS * (math.cos(t) + math.sin(t))
    assert overpass.unrotated_reach_m(RADIUS, 29.0) == pytest.approx(expected)
    assert overpass.unrotated_reach_m(RADIUS, 0.0) == pytest.approx(1.15 * RADIUS)

    hx, hy = _bbox_half_extent_m(presets.PRESETS_BY_ID["new-york-midtown"].request())
    for half in (hx, hy):
        assert expected <= half <= expected * 1.02  # never starved, never squared
    assert hx < expected * 1.3  # the squared-reach bug is 36% wider than this

    # the five unrotated presets are unaffected (1.15 * radius plus a UTM bulge)
    for preset in presets.PRESETS:
        if preset.rotation_deg == 0.0:
            for half in _bbox_half_extent_m(preset.request()):
                assert 1.15 * RADIUS <= half <= 1.15 * RADIUS * 1.1


@pytest.mark.parametrize("body", [TIMEOUT_BODY, OOM_BODY], ids=["timeout", "out-of-memory"])
def test_a_200_carrying_a_runtime_error_is_retried_and_never_cached(body, tmp_path, monkeypatch):
    """A timeout body is a failed attempt, not an empty city.

    Caching it would freeze that location into ``coverage=empty`` forever: the
    fixture cache is consulted before the network and has no TTL.
    """
    monkeypatch.setattr(overpass, "FIXTURES_DIR", tmp_path)
    seen: list[str] = []

    def fake_post(url: str, query: str) -> _FakeResponse:
        seen.append(url)
        return _FakeResponse(200, body)

    monkeypatch.setattr(overpass, "_post", fake_post)
    request = SceneRequest(lat=10.0, lon=10.0, radius_m=900.0, rotation_deg=0.0, preset_id=None)

    with pytest.raises(overpass.OverpassUnavailable) as excinfo:
        overpass.fetch_and_cache(request, sleep=lambda _s: None)

    assert "runtime error" in str(excinfo.value).lower()
    assert len(seen) == overpass.MAX_ATTEMPTS, "an error body must count as a failed attempt"
    assert seen[0] == overpass.PRIMARY_ENDPOINT
    assert seen[1:] == [overpass.MIRROR_ENDPOINT] * (overpass.MAX_ATTEMPTS - 1), "mirror fallback"
    assert list(tmp_path.iterdir()) == [], "no fixture may be written for an error body"

    overpass.clear_memory_cache()
    with pytest.raises(overpass.FixtureMissing):
        overpass.load_raw(request, allow_network=False)
    overpass.clear_memory_cache()


def test_a_cached_error_body_is_never_served_as_an_empty_scene(tmp_path, monkeypatch):
    """Belt and braces for a fixture written before that check existed."""
    monkeypatch.setattr(overpass, "FIXTURES_DIR", tmp_path)
    request = SceneRequest(lat=10.0, lon=10.0, radius_m=900.0, rotation_deg=0.0, preset_id=None)
    path = overpass.fixture_path(overpass.build_query(request))
    path.write_text(TIMEOUT_BODY, encoding="utf-8")
    overpass.clear_memory_cache()

    with pytest.raises(overpass.FixtureMissing) as excinfo:
        overpass.load_raw(request, allow_network=False)
    assert "timed out" in str(excinfo.value).lower()
    overpass.clear_memory_cache()


def test_an_html_200_from_a_proxy_is_retried_not_raised_on_the_first_attempt(tmp_path, monkeypatch):
    """`_parse` runs inside the attempt, so its failures get the retry policy."""
    monkeypatch.setattr(overpass, "FIXTURES_DIR", tmp_path)
    seen: list[str] = []

    def fake_post(url: str, query: str) -> _FakeResponse:
        seen.append(url)
        return _FakeResponse(200, "<html><body>502 Bad Gateway</body></html>")

    monkeypatch.setattr(overpass, "_post", fake_post)
    request = SceneRequest(lat=10.0, lon=10.0, radius_m=900.0, rotation_deg=0.0, preset_id=None)
    with pytest.raises(overpass.OverpassUnavailable) as excinfo:
        overpass.fetch_and_cache(request, sleep=lambda _s: None)
    assert "non-JSON" in str(excinfo.value)
    assert len(seen) == overpass.MAX_ATTEMPTS
    assert list(tmp_path.iterdir()) == []


def test_fatal_remark_only_rejects_error_bodies():
    assert overpass.fatal_remark(json.loads(TIMEOUT_BODY)) is not None
    assert overpass.fatal_remark(json.loads(OOM_BODY)) is not None
    assert overpass.fatal_remark({"elements": [], "remark": "something odd"}) is not None
    assert overpass.fatal_remark({"elements": []}) is None  # a genuinely empty ocean tile
    assert overpass.fatal_remark({"elements": [{"type": "node"}], "remark": "note"}) is None
    # a *partial* answer with a runtime error is still a failure
    partial = json.loads(TIMEOUT_BODY)
    partial["elements"] = [{"type": "node", "id": 1}]
    assert overpass.fatal_remark(partial) is not None


def test_refresh_fixtures_if_missing_refetches_a_cached_error_body(tmp_path, monkeypatch):
    """`make refresh-fixtures` must not adopt a poisoned fixture as "cached"."""
    from app import cli

    monkeypatch.setattr(overpass, "FIXTURES_DIR", tmp_path)
    monkeypatch.setattr(cli, "FIXTURES_DIR", tmp_path)
    monkeypatch.setattr(cli, "PRESETS_INDEX", tmp_path / "presets-index.json")
    preset = presets.PRESETS_BY_ID["chicago-loop"]
    path = overpass.fixture_path(overpass.build_query(preset.request()))
    path.write_text(TIMEOUT_BODY, encoding="utf-8")
    overpass.clear_memory_cache()

    fetched: list[str] = []

    def fake_fetch(request, **_kw):
        fetched.append(request.preset_id or "")
        payload = {"elements": [{"type": "node", "id": 1, "lat": 0.0, "lon": 0.0}]}
        path.write_text(json.dumps(payload), encoding="utf-8")
        return payload

    monkeypatch.setattr(overpass, "fetch_and_cache", fake_fetch)
    args = argparse.Namespace(
        preset=["chicago-loop"], if_missing=True, keep_stale=True, handler=None
    )
    assert cli.cmd_refresh_fixtures(args) == 0
    assert fetched == ["chicago-loop"], "the error body must not count as a cached fixture"
    index = json.loads((tmp_path / "presets-index.json").read_text(encoding="utf-8"))
    assert index["presets"][0]["element_count"] == 1
    overpass.clear_memory_cache()


def test_every_committed_preset_fixture_is_data_not_an_error_body():
    for preset in presets.PRESETS:
        raw = overpass.load_raw(preset.request(), allow_network=False)
        assert overpass.fatal_remark(raw) is None, f"{preset.id} fixture is a server error"
        assert len(raw["elements"]) > 1000
        overpass.clear_memory_cache()


# ---------------------------------------------------------------------------
# fix pass: courtyards
# ---------------------------------------------------------------------------


def _metric_geometry(frame: project.LocalFrame, points) -> list[dict]:
    """Overpass ``geometry`` for a list of (x, y) meters in the local frame."""
    return [{"lat": float(lat), "lon": float(lon)} for lon, lat in frame.to_wgs84(points)]


def _metric_ring(frame: project.LocalFrame, x0: float, y0: float, size: float) -> list[dict]:
    return _metric_geometry(
        frame,
        [(x0, y0), (x0 + size, y0), (x0 + size, y0 + size), (x0, y0 + size), (x0, y0)],
    )


def _multipolygon(rel_id: int, outer: list[dict], inners: list[list[dict]], outer_ref: int) -> dict:
    members = [{"type": "way", "ref": outer_ref, "role": "outer", "geometry": outer}]
    for k, inner in enumerate(inners):
        members.append(
            {"type": "way", "ref": 950_000 + 10 * rel_id + k, "role": "inner", "geometry": inner}
        )
    return {
        "type": "relation",
        "id": rel_id,
        "tags": {"building": "yes", "type": "multipolygon"},
        "members": members,
    }


def _synthetic_request(radius_m: float = 250.0) -> SceneRequest:
    lat, lon = CHICAGO_LL
    return SceneRequest(lat=lat, lon=lon, radius_m=radius_m, rotation_deg=0.0, preset_id=None)


@pytest.mark.parametrize("size", [20.0, 8.0], ids=["25%-courtyard", "4%-courtyard"])
def test_a_courtyard_survives_its_outer_way_being_tagged_building(size: float):
    """Old-style OSM tagging repeats ``building=*`` on the multipolygon's outer way.

    Overpass returns both (03 step 6 says so); the hole-less way used to win -
    through step 7's union above 5% and through step 6's dedupe below it - and
    the courtyard was printed solid.
    """
    frame = project.LocalFrame(*CHICAGO_LL, 0.0)
    outer = _metric_ring(frame, 0.0, 0.0, 40.0)
    raw = {
        "elements": [
            {"type": "way", "id": 903, "tags": {"building": "yes"}, "geometry": outer},
            _multipolygon(3, outer, [_metric_ring(frame, 10.0, 10.0, size)], outer_ref=903),
        ]
    }
    scene = normalize.build_scene(raw, _synthetic_request())
    assert scene.stats.building_count == 1
    building = scene.buildings[0]
    assert building.id == "r3", "the relation is authoritative, not its outer way"
    assert len(building.holes) == 1, "the courtyard was filled in"
    assert Polygon(building.ring, building.holes).area == pytest.approx(1600.0 - size**2, abs=1.0)


@pytest.mark.parametrize("inner_y", [10.0, 0.0], ids=["touches-an-edge", "touches-a-corner"])
def test_a_hole_that_touches_its_own_exterior_is_emitted_as_a_notch(inner_y: float):
    """Inner-ring vertices drafted onto an outer edge are common in OSM.

    The epsilon-wide sliver ``difference`` leaves behind used to survive
    ``simplify`` and then collapse into a ring self-intersection at mm
    rounding, costing the building all of its holes (corner case) or the whole
    building (edge case). Snap-rounding before validation makes it a notch.
    """
    frame = project.LocalFrame(*CHICAGO_LL, 0.0)
    raw = {
        "elements": [
            _multipolygon(
                1,
                _metric_ring(frame, 0.0, 0.0, 40.0),
                [_metric_ring(frame, 0.0, inner_y, 10.0)],
                outer_ref=900_001,
            )
        ]
    }
    scene = normalize.build_scene(raw, _synthetic_request())
    assert scene.stats.building_count == 1, "the notched building was dropped"
    footprint = Polygon(scene.buildings[0].ring, scene.buildings[0].holes)
    assert footprint.is_valid
    assert footprint.area == pytest.approx(1500.0, abs=1.0), "the notch was filled in"


def test_london_relation_1439717_keeps_its_courtyard():
    """Haberdashers Hall: the london-city fixture holds relation r1439717 *and*
    its ``building``-tagged outer way w100835946."""
    scene = _scene("london-city")
    by_id = {b.id: b for b in scene.buildings}
    assert "w100835946" not in by_id, "the outer way must not be emitted on its own"
    hall = by_id["r1439717"]
    assert len(hall.holes) == 1
    assert Polygon(hall.ring, hall.holes).area == pytest.approx(1213.0, rel=0.05)
    assert Polygon(hall.ring).area == pytest.approx(1556.0, rel=0.05)


def test_no_preset_emits_a_footprint_that_lost_its_holes_to_rounding():
    """Every emitted ring is already valid on the 1 mm emission grid."""
    for preset in presets.PRESETS:
        scene = _scene(preset.id)
        assert any(b.holes for b in scene.buildings)
        for building in scene.buildings:
            assert Polygon(building.ring, building.holes).is_valid, f"{preset.id} {building.id}"
            for hole in building.holes:
                assert Polygon(hole).area >= normalize.MIN_FEATURE_AREA_M2
            for point in building.ring:
                assert tuple(point) == (round(point[0], 3), round(point[1], 3))
        overpass.clear_memory_cache()


# ---------------------------------------------------------------------------
# fix pass: hostile tag values
# ---------------------------------------------------------------------------

HOSTILE_NUMBERS = ["inf", "-inf", "Infinity", "nan", "NaN", "1e308", "1e400", "9" * 400]


@pytest.mark.parametrize("text", HOSTILE_NUMBERS)
def test_parse_length_rejects_non_finite(text: str):
    assert normalize.parse_length_m(text) is None
    assert normalize.parse_length_m(float("inf")) is None
    assert normalize.parse_length_m(float("nan")) is None


@pytest.mark.parametrize("text", HOSTILE_NUMBERS)
def test_parse_levels_never_returns_a_non_finite_number(text: str):
    parsed = normalize.parse_levels(text)
    assert parsed is None or math.isfinite(parsed)
    assert normalize.parse_levels(float("inf")) is None
    assert normalize.parse_levels(float("nan")) is None


@pytest.mark.parametrize("text", HOSTILE_NUMBERS + ["1e307", "0", "-3"])
def test_road_width_is_finite_and_clamped(text: str):
    for tag in ("width", "lanes"):
        width = normalize.road_width_m({"highway": "residential", tag: text}, "residential")
        assert math.isfinite(width)
        assert normalize.MIN_ROAD_WIDTH_M <= width <= normalize.MAX_ROAD_WIDTH_M
    # the 03 table and the lanes rule are untouched inside the physical range
    assert normalize.road_width_m({"highway": "motorway"}, "motorway") == 24.0
    assert normalize.road_width_m({"lanes": "4"}, "primary") == 14.0


@pytest.mark.parametrize("text", HOSTILE_NUMBERS)
def test_height_stays_finite_for_hostile_tags(text: str):
    for tag in ("height", "building:levels", "roof:height", "min_height", "building:min_level"):
        height, _, min_height = normalize.resolve_height({"building": "yes", tag: text}, "w1")
        assert math.isfinite(height)
        assert normalize.MIN_HEIGHT_M <= height <= normalize.MAX_HEIGHT_M
        assert math.isfinite(min_height) and 0.0 <= min_height < height


def test_a_hostile_tag_cannot_put_a_non_finite_number_on_the_wire():
    """``lanes=1e308`` used to serialise as ``"width_m": null`` (and as
    non-standard ``Infinity`` in the disk cache)."""
    frame = project.LocalFrame(*CHICAGO_LL, 0.0)
    raw = {
        "elements": [
            {
                "type": "way",
                "id": 7,
                "tags": {"highway": "residential", "lanes": "1e308"},
                "geometry": _metric_geometry(frame, [(-100.0, 0.0), (100.0, 0.0)]),
            },
            {
                "type": "way",
                "id": 8,
                "tags": {"highway": "service", "width": "9" * 400},
                "geometry": _metric_geometry(frame, [(-100.0, 20.0), (100.0, 20.0)]),
            },
        ]
    }
    scene = normalize.build_scene(raw, _synthetic_request())
    assert len(scene.roads) == 2
    # allow_nan=False is what artifacts/cache/scene now writes with
    text = json.dumps(scene.model_dump(mode="json"), allow_nan=False)
    for road in SceneGraph(**json.loads(text)).roads:
        assert math.isfinite(road.width_m)
        assert normalize.MIN_ROAD_WIDTH_M <= road.width_m <= normalize.MAX_ROAD_WIDTH_M
