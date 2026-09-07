"""Overpass client + fixture cache (03 "Overpass query").

One query fetches every layer.  Every raw response is cached verbatim to
``fixtures/<sha1-of-query>.json`` and the cache is consulted before any network
call, so the six presets and the whole test suite run fully offline.

Setting ``FRAMECRAFT_OFFLINE=1`` turns any network attempt into an
:class:`OverpassOffline` error, which is how the tests prove they never reach
the internet.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import time
from pathlib import Path
from typing import Any

import httpx

from app.contracts import SceneRequest
from app.geom.project import LocalFrame

__all__ = [
    "OverpassError",
    "OverpassOffline",
    "OverpassUnavailable",
    "FixtureMissing",
    "PRIMARY_ENDPOINT",
    "MIRROR_ENDPOINT",
    "USER_AGENT",
    "FIXTURES_DIR",
    "BBOX_MARGIN",
    "unrotated_reach_m",
    "bbox_for",
    "build_query",
    "query_sha1",
    "fixture_path",
    "fatal_remark",
    "is_offline",
    "load_raw",
    "fetch_and_cache",
    "clear_memory_cache",
]

REPO_ROOT = Path(__file__).resolve().parents[4]
FIXTURES_DIR = REPO_ROOT / "fixtures"

PRIMARY_ENDPOINT = "https://overpass-api.de/api/interpreter"
MIRROR_ENDPOINT = "https://overpass.kumi.systems/api/interpreter"
USER_AGENT = "FrameCraft/0.1 (OSM-to-3D-print MVP; contact via repo)"

TIMEOUT_S = 180.0
MAX_ATTEMPTS = 3
BACKOFF_BASE_S = 2.0
MIRROR_STATUSES = frozenset({429, 504})

#: 03: "add 15% margin so the rotation crop is not starved".
BBOX_MARGIN = 1.15

#: The query text of 03, verbatim, with {bbox} substituted.
QUERY_TEMPLATE = """[out:json][timeout:180];
(
  way["building"]({bbox});
  relation["building"]({bbox});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|service|pedestrian|footway)$"]({bbox});
  way["natural"~"^(water|bay|strait|wood|scrub|grassland|heath|shrubbery|wetland)$"]({bbox});
  relation["natural"~"^(water|bay|strait|wood|scrub|grassland|heath|shrubbery|wetland)$"]({bbox});
  way["waterway"~"^(riverbank|dock)$"]({bbox});
  relation["waterway"~"^(riverbank|dock)$"]({bbox});
  way["landuse"~"^(grass|forest|meadow|recreation_ground|village_green|allotments|orchard|vineyard|cemetery|greenfield|reservoir|basin)$"]({bbox});
  relation["landuse"~"^(grass|forest|meadow|recreation_ground|village_green|allotments|orchard|vineyard|cemetery|greenfield|reservoir|basin)$"]({bbox});
  way["leisure"~"^(park|garden|pitch|playground|golf_course|nature_reserve|dog_park|common)$"]({bbox});
  relation["leisure"~"^(park|garden|pitch|playground|golf_course|nature_reserve|dog_park|common)$"]({bbox});
  node["natural"="tree"]({bbox});
);
out geom;
"""


class OverpassError(RuntimeError):
    """Base class for every failure of this module."""


class OverpassOffline(OverpassError):
    """A network call was attempted while FRAMECRAFT_OFFLINE is set."""


class OverpassUnavailable(OverpassError):
    """Overpass could not be reached (or kept failing) after every retry.

    ``switch_mirror`` marks a failure that the mirror may well survive (a
    timeout or an out-of-memory runtime error), so the retry loop treats it the
    same way it treats a 429 or a 504.
    """

    def __init__(self, message: str, *, switch_mirror: bool = False) -> None:
        super().__init__(message)
        self.switch_mirror = switch_mirror


class FixtureMissing(OverpassError):
    """No cached fixture for this query and the network was not allowed."""


# ---------------------------------------------------------------------------
# query construction
# ---------------------------------------------------------------------------


def unrotated_reach_m(radius_m: float, rotation_deg: float) -> float:
    """How far the rotated crop square reaches in the *unrotated* local frame.

    DECISIONS.md [P2]: ``half = radius_m * (|cos t| + |sin t|) * 1.15`` with
    ``t = rotation_deg mod 90``.  This is what :func:`bbox_for` must end up
    covering; it is not the half-width of the ring that produces it (that ring
    lives in the rotated frame, where the reach factor is already implied).
    Exposed so the invariant can be asserted directly.
    """
    t = math.radians(float(rotation_deg) % 90.0)
    reach = abs(math.cos(t)) + abs(math.sin(t))
    return float(radius_m) * reach * BBOX_MARGIN


def bbox_for(request: SceneRequest) -> tuple[float, float, float, float]:
    """Overpass bbox ``(south, west, north, east)`` covering the rotated crop.

    The window is the crop square plus 03's 15% margin, expressed in the
    *rotated* local frame; its corners and edges are projected back to WGS84
    (edges sampled, not just corners, so the UTM edge bulge cannot clip
    anything) and the extremes are taken.  ``LocalFrame.to_wgs84`` un-rotates
    the ring, so the resulting axis-aligned window automatically has the
    ``(|cos t| + |sin t|)`` reach of :func:`unrotated_reach_m`; multiplying the
    ring by that factor as well would square it and roughly double the area
    Overpass has to serve.
    """
    frame = LocalFrame(request.lat, request.lon, request.rotation_deg)
    half = float(request.radius_m) * BBOX_MARGIN
    steps = 16
    ts = [-half + (2 * half) * i / steps for i in range(steps + 1)]
    ring: list[tuple[float, float]] = []
    for t in ts:
        ring.append((t, -half))
        ring.append((t, half))
        ring.append((-half, t))
        ring.append((half, t))
    lonlat = frame.to_wgs84(ring)
    west = float(lonlat[:, 0].min())
    east = float(lonlat[:, 0].max())
    south = float(lonlat[:, 1].min())
    north = float(lonlat[:, 1].max())
    return (round(south, 7), round(west, 7), round(north, 7), round(east, 7))


def build_query(request: SceneRequest) -> str:
    """The exact 03 Overpass QL text for this request."""
    south, west, north, east = bbox_for(request)
    bbox = f"{south:.7f},{west:.7f},{north:.7f},{east:.7f}"
    return QUERY_TEMPLATE.format(bbox=bbox)


def query_sha1(query: str) -> str:
    return hashlib.sha1(query.encode("utf-8")).hexdigest()


def fixture_path(query: str) -> Path:
    return FIXTURES_DIR / f"{query_sha1(query)}.json"


# ---------------------------------------------------------------------------
# caching
# ---------------------------------------------------------------------------

_MEM_CACHE: dict[str, dict[str, Any]] = {}
#: Parsed Overpass responses are large (35-85 MB each in memory), so only a
#: couple are kept; the parsed SceneGraph cache in main.py is what keeps a warm
#: /scene fast.
_MEM_CACHE_MAX = 2


def clear_memory_cache() -> None:
    _MEM_CACHE.clear()


def _mem_get(key: str) -> dict[str, Any] | None:
    return _MEM_CACHE.get(key)


def _mem_put(key: str, value: dict[str, Any]) -> None:
    if key not in _MEM_CACHE and len(_MEM_CACHE) >= _MEM_CACHE_MAX:
        _MEM_CACHE.pop(next(iter(_MEM_CACHE)))
    _MEM_CACHE[key] = value


def read_fixture(path: Path) -> dict[str, Any]:
    """Read a cached raw Overpass response, memoized by path."""
    key = str(path)
    cached = _mem_get(key)
    if cached is not None:
        return cached
    data = json.loads(path.read_text(encoding="utf-8"))
    _mem_put(key, data)
    return data


def is_offline() -> bool:
    return os.environ.get("FRAMECRAFT_OFFLINE", "").strip().lower() in {"1", "true", "yes", "on"}


def _guard_network(url: str) -> None:
    if is_offline():
        raise OverpassOffline(
            f"FRAMECRAFT_OFFLINE is set; refusing to contact {url}. "
            "Expected a committed fixture for this query."
        )


# ---------------------------------------------------------------------------
# network
# ---------------------------------------------------------------------------


def _post(url: str, query: str) -> httpx.Response:
    _guard_network(url)
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    timeout = httpx.Timeout(TIMEOUT_S, connect=30.0)
    with httpx.Client(timeout=timeout, headers=headers, follow_redirects=True) as client:
        return client.post(url, content=query.encode("utf-8"))


def fatal_remark(data: Any) -> str | None:
    """The ``remark`` of a body that is an Overpass *error*, not data.

    Overpass reports a query timeout or an exhausted memory budget as **HTTP
    200** with an empty (or partial) ``elements`` list and a ``remark`` like
    ``"runtime error: Query timed out in \"query\" at line 4 after 180
    seconds."``.  Such a body must never be cached: it would freeze that
    location into an empty scene forever, because the fixture cache is
    consulted before the network and has no TTL.
    """
    if not isinstance(data, dict):
        return None
    remark = str(data.get("remark") or "").strip()
    if not remark:
        return None
    lowered = remark.lower()
    if "runtime error" in lowered or "out of memory" in lowered:
        return remark
    elements = data.get("elements")
    if isinstance(elements, list) and not elements:  # any remark + no data
        return remark
    return None


def _parse(text: str, url: str) -> dict[str, Any]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:  # Overpass sometimes answers HTML with 200
        raise OverpassUnavailable(f"{url} returned a non-JSON body ({exc})") from exc
    if not isinstance(data, dict) or not isinstance(data.get("elements"), list):
        remark = data.get("remark") if isinstance(data, dict) else None
        raise OverpassUnavailable(f"{url} returned no elements array (remark: {remark!r})")
    remark = fatal_remark(data)
    if remark is not None:
        lowered = remark.lower()
        raise OverpassUnavailable(
            f"{url} answered 200 with a server-side failure instead of data "
            f"(remark: {remark!r})",
            # a timeout / OOM is the body-level twin of a 504: try the mirror.
            switch_mirror="timed out" in lowered
            or "timeout" in lowered
            or "out of memory" in lowered,
        )
    return data


def fetch_and_cache(request: SceneRequest, *, sleep=time.sleep) -> dict[str, Any]:
    """Run the query against Overpass and write the raw response to the cache.

    3 attempts with exponential backoff; a 429, a 504 or a body that carries a
    ``runtime error`` remark switches to the kumi.systems mirror for the
    remaining attempts (03 "Retry policy").  The response is written to the
    fixture cache only once :func:`_parse` has accepted it, so a timed-out
    query can never be memoized as an empty scene.
    """
    query = build_query(request)
    path = fixture_path(query)
    endpoint = PRIMARY_ENDPOINT
    last_error = "unknown error"

    for attempt in range(MAX_ATTEMPTS):
        try:
            response = _post(endpoint, query)
            if response.status_code == 200:
                data = _parse(response.text, endpoint)  # raises on an error body
                FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
                path.write_text(response.text, encoding="utf-8", newline="\n")
                _mem_put(str(path), data)
                return data
        except OverpassOffline:
            raise
        except httpx.HTTPError as exc:
            last_error = f"{type(exc).__name__} from {endpoint}: {exc}"
        except OverpassUnavailable as exc:
            last_error = str(exc)
            if exc.switch_mirror and endpoint != MIRROR_ENDPOINT:
                endpoint = MIRROR_ENDPOINT
        else:
            last_error = f"HTTP {response.status_code} from {endpoint}"
            if response.status_code in MIRROR_STATUSES and endpoint != MIRROR_ENDPOINT:
                endpoint = MIRROR_ENDPOINT
        if attempt < MAX_ATTEMPTS - 1:
            sleep(BACKOFF_BASE_S * (2**attempt))

    raise OverpassUnavailable(
        f"Overpass unreachable after {MAX_ATTEMPTS} attempts ({last_error}). "
        "Try again in a minute or pick one of the preset cities."
    )


def load_raw(
    request: SceneRequest,
    *,
    allow_network: bool = True,
    force_network: bool = False,
) -> dict[str, Any]:
    """Raw Overpass JSON for a request: cache first, network second.

    ``allow_network=False`` (presets, tests) turns a cache miss into
    :class:`FixtureMissing` instead of a fetch.
    """
    query = build_query(request)
    path = fixture_path(query)
    if not force_network and path.is_file():
        data = read_fixture(path)
        remark = fatal_remark(data)
        if remark is None:
            return data
        # A fixture written before this check (or hand-placed) can hold an
        # Overpass error body; never serve it as an empty scene.
        _MEM_CACHE.pop(str(path), None)
        if not allow_network:
            raise FixtureMissing(
                f"cached Overpass response fixtures/{path.name} is a server error, not data "
                f"(remark: {remark!r}); delete it and re-run `make refresh-fixtures` while online"
            )
        return fetch_and_cache(request)
    if not allow_network:
        raise FixtureMissing(
            f"no cached Overpass fixture at fixtures/{path.name} for "
            f"({request.lat}, {request.lon}) r={request.radius_m} rot={request.rotation_deg}; "
            "run `make refresh-fixtures` while online"
        )
    return fetch_and_cache(request)
