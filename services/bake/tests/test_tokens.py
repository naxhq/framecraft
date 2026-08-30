"""The shared token table, and the fixture that stops it drifting from TS.

``fixtures/tokens-expected.json`` is generated here and asserted by BOTH this
suite and ``apps/web/lib/tokens.test.ts``.  If the two implementations ever
disagree - a rounding tie, a locale-formatted thousands separator, a hemisphere
letter - one of the two suites goes red on the same case.

Regenerate the committed expectation with::

    FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_tokens.py

(the assertion still runs afterwards, so a regeneration can re-baseline the
fixture but can never hide a mismatch between the two implementations).
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List

import pytest

from app.geom import tokens as TK

REPO_ROOT = Path(__file__).resolve().parents[3]
TOKENS_EXPECTED = REPO_ROOT / "fixtures" / "tokens-expected.json"

# --- contexts ---------------------------------------------------------------
# CHICAGO is the real chicago-loop preset at the PrintParams defaults: plate
# 180 mm with the frame on is 168 mm usable over an 1800 m span, so
# scale_mm_per_m is 168/1800 and the ratio reads 1:10,714 (DECISIONS [V2-P2] -
# the brief's "1:9,650" matches no parameter combination this tree produces).
CHICAGO = {
    "city": "Chicago",
    "lat": 41.8827,
    "lon": -87.6233,
    "scale_mm_per_m": 168.0 / 1800.0,
    "radius_m": 900.0,
    "date": "2026-08-29",
    "buildings": 994,
}
# The 1:23,571 bake DECISIONS [V2-P1] investigated: radius 1980, plate 180,
# frame on -> 168 mm over 3960 m.
WIDE = {**CHICAGO, "scale_mm_per_m": 168.0 / 3960.0, "radius_m": 1980.0, "buildings": 2841}
# Plate 200 with the frame on, the other ratio the repo's own artifacts show.
PLATE_200 = {**CHICAGO, "scale_mm_per_m": 188.0 / 1800.0}
# No city typed: {city} must expand to "" and never to a guess.
UNSET_CITY = {**CHICAGO, "city": ""}
# Southern and eastern hemispheres, so {coords} exercises S and E.
SYDNEY = {
    "city": "Sydney",
    "lat": -33.8688,
    "lon": 151.2093,
    "scale_mm_per_m": 168.0 / 1800.0,
    "radius_m": 1500.0,
    "date": "2026-01-26",
    "buildings": 1841,
}
# A scene that has not been measured yet: {scale} has no honest value.
UNMEASURED = {**CHICAGO, "scale_mm_per_m": 0.0}
# The v3-P1 place/author/hero tokens, fully resolved.
WITH_PLACE = {
    **CHICAGO,
    "country": "United States",
    "state": "Illinois",
    "neighbourhood": "The Loop",
    "author": "Vahid Alizadeh",
    "hero_count": 3,
}
# Nothing resolved for any of them: every one must read as empty, not a guess.
NO_PLACE = {**CHICAGO, "country": "", "state": "", "neighbourhood": "", "author": "", "hero_count": 0}
ONE_HERO = {**CHICAGO, "hero_count": 1}
# Exact binary ties, to pin round_half_up against Python's banker's rounding
# and against Math.round: 0.5 m of radius, and a latitude that rounds to zero
# from below (which must not print "-0.0000").
HALF_METRE = {**CHICAGO, "radius_m": 0.5}
NEAR_ZERO = {**CHICAGO, "city": "Null Island", "lat": -0.00004, "lon": 0.0}
# Exactly zero, which must read "0.0000° N, 0.0000° E": the hemisphere letter is
# chosen by `value >= 0`, so the equator is north and the prime meridian is east
# rather than the "0.0000° S" a `> 0` test would print.
ZERO = {**CHICAGO, "city": "Null Island", "lat": 0.0, "lon": 0.0}
MILLION = {**CHICAGO, "buildings": 1234567}
# No buildings at all: the count must print "0", not "" and not "NaN".
NO_BUILDINGS = {**CHICAGO, "buildings": 0}
# The antimeridian, the far end of the lon range the contract allows.
ANTIMERIDIAN = {**CHICAGO, "city": "Antimeridian", "lat": 12.3456, "lon": -180.0}

CASES: List[Dict[str, Any]] = [
    {"text": "{city}", "ctx": CHICAGO},
    {"text": "{city}", "ctx": UNSET_CITY},
    {"text": "{lat}", "ctx": CHICAGO},
    {"text": "{lon}", "ctx": CHICAGO},
    {"text": "{lat} {lon}", "ctx": SYDNEY},
    {"text": "{lat} {lon}", "ctx": NEAR_ZERO},
    {"text": "{coords}", "ctx": CHICAGO},
    {"text": "{coords}", "ctx": SYDNEY},
    {"text": "{coords}", "ctx": NEAR_ZERO},
    {"text": "{scale}", "ctx": CHICAGO},
    {"text": "{scale}", "ctx": WIDE},
    {"text": "{scale}", "ctx": PLATE_200},
    {"text": "{scale}", "ctx": UNMEASURED},
    {"text": "{radius}", "ctx": CHICAGO},
    {"text": "{radius}", "ctx": WIDE},
    {"text": "{radius}", "ctx": HALF_METRE},
    {"text": "{date}", "ctx": CHICAGO},
    {"text": "{date}", "ctx": SYDNEY},
    {"text": "{buildings}", "ctx": CHICAGO},
    {"text": "{buildings}", "ctx": SYDNEY},
    {"text": "{buildings}", "ctx": MILLION},
    # the UndersideMark default template
    {"text": "{city} {scale} {date}", "ctx": CHICAGO},
    # every token at once, with punctuation between
    {
        "text": "{city} — {coords} · {scale} · {radius} · {buildings} buildings · {date} "
        "({lat}, {lon})",
        "ctx": CHICAGO,
    },
    # unknown tokens survive verbatim, including a known name in the wrong case
    {"text": "{city} {unknown} {Coords} {} {lat", "ctx": CHICAGO},
    # text with no tokens at all is returned untouched
    {"text": "  Printed by hand.  ", "ctx": CHICAGO},
    # adjacent tokens, and a token that expands to nothing between two spaces
    {"text": "{lat},{lon}", "ctx": CHICAGO},
    {"text": "[{city}]", "ctx": UNSET_CITY},
    # --- the gaps the v2-01 audit named ---------------------------------------
    # Zero latitude and zero longitude: N and E, never S and W.
    {"text": "{coords}", "ctx": ZERO},
    {"text": "{lat} {lon}", "ctx": ZERO},
    # The far end of the longitude range.
    {"text": "{coords}", "ctx": ANTIMERIDIAN},
    # A count of zero, and one that needs two separators.
    {"text": "{buildings}", "ctx": NO_BUILDINGS},
    {"text": "{buildings} buildings", "ctx": MILLION},
    # The same token twice in one string: a non-global regex would expand only
    # the first, and both implementations must expand both.
    {"text": "{city}, {city}", "ctx": CHICAGO},
    {"text": "{lat} {lat} {lat}", "ctx": SYDNEY},
    # Truly adjacent tokens with NO separator between the closing and opening
    # brace - the case a naive `}{`-splitting implementation gets wrong.
    {"text": "{lat}{lon}", "ctx": CHICAGO},
    {"text": "{city}{radius}{buildings}", "ctx": CHICAGO},
    # A lone opening brace, a lone closing brace, and a name that is not a token.
    {"text": "{", "ctx": CHICAGO},
    {"text": "}", "ctx": CHICAGO},
    {"text": "}{", "ctx": CHICAGO},
    {"text": "{notatoken}", "ctx": CHICAGO},
    {"text": "{ city }", "ctx": CHICAGO},
    # --- v3-P1: place, author and hero ---------------------------------------
    {"text": "{country}", "ctx": WITH_PLACE},
    {"text": "{state}", "ctx": WITH_PLACE},
    {"text": "{neighbourhood}", "ctx": WITH_PLACE},
    {"text": "{author}", "ctx": WITH_PLACE},
    {"text": "{hero}", "ctx": WITH_PLACE},
    {"text": "{hero}", "ctx": ONE_HERO},
    {"text": "{country} {state} {neighbourhood} {author} {hero}", "ctx": WITH_PLACE},
    # nothing resolved: every one of the five reads empty, never a guess
    {"text": "[{country}][{state}][{neighbourhood}][{author}][{hero}]", "ctx": NO_PLACE},
    {
        "text": "{city}, {neighbourhood}, {state}, {country} - by {author} ({hero} heroes)",
        "ctx": WITH_PLACE,
    },
]


def expand(case: Dict[str, Any]) -> str:
    return TK.expand_tokens(case["text"], TK.TokenContext.from_mapping(case["ctx"]))


def build_expected() -> Dict[str, Any]:
    return {
        "_comment": (
            "GENERATED by services/bake/tests/test_tokens.py. This is the contract "
            "between app/geom/tokens.py and apps/web/lib/tokens.ts; both test "
            "suites assert against it. Regenerate with FRAMECRAFT_WRITE_PARITY=1 "
            "uv run pytest tests/test_tokens.py"
        ),
        "tokens": list(TK.TOKENS),
        "cases": [
            {"text": case["text"], "ctx": case["ctx"], "expected": expand(case)}
            for case in CASES
        ],
    }


# ---------------------------------------------------------------------------
# the fixture
# ---------------------------------------------------------------------------


def test_tokens_expectation_matches_the_committed_fixture() -> None:
    fresh = build_expected()
    if os.environ.get("FRAMECRAFT_WRITE_PARITY") == "1":
        TOKENS_EXPECTED.write_text(
            json.dumps(fresh, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
            newline="\n",
        )
    assert TOKENS_EXPECTED.is_file(), (
        "fixtures/tokens-expected.json is missing; regenerate with "
        "FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_tokens.py"
    )
    committed = json.loads(TOKENS_EXPECTED.read_text(encoding="utf-8"))
    assert committed["tokens"] == list(TK.TOKENS)
    assert committed["cases"] == fresh["cases"]


def test_the_fixture_covers_every_token() -> None:
    committed = json.loads(TOKENS_EXPECTED.read_text(encoding="utf-8"))
    texts = " ".join(case["text"] for case in committed["cases"])
    for name in TK.TOKENS:
        assert "{" + name + "}" in texts, name


# ---------------------------------------------------------------------------
# the rules the fixture cannot state on its own
# ---------------------------------------------------------------------------


def test_the_table_has_exactly_thirteen_tokens_and_a_formatter_for_each() -> None:
    assert len(TK.TOKENS) == 13
    assert sorted(TK.FORMATTERS) == sorted(TK.TOKENS)


@pytest.mark.parametrize(
    "value,expected",
    [
        (0, "0"),
        (7, "7"),
        (999, "999"),
        (1000, "1,000"),
        (23571, "23,571"),
        (1234567, "1,234,567"),
        # Past the contract's reach, but the two implementations must still
        # agree: the TS mirror used to print "1e,+21" here, because String(1e21)
        # is "1e+21" (v2-01 audit finding 6).
        (2**53 - 1, "9,007,199,254,740,991"),
        (10**21, "1,000,000,000,000,000,000,000"),
    ],
)
def test_group_thousands(value: int, expected: str) -> None:
    assert TK.group_thousands(value) == expected


def test_coords_at_zero_read_north_and_east() -> None:
    """The equator is north and the prime meridian is east: the hemisphere
    letter is chosen by ``>= 0``, so a frame at Null Island reads
    ``0.0000° N, 0.0000° E`` rather than ``0.0000° S``."""
    assert TK.format_coords(TK.TokenContext.from_mapping(ZERO)) == "0.0000° N, 0.0000° E"
    negative_zero = TK.TokenContext.from_mapping({**ZERO, "lat": -0.0, "lon": -0.0})
    assert TK.format_coords(negative_zero) == "0.0000° N, 0.0000° E"


@pytest.mark.parametrize(
    "value,expected",
    [(0.5, 1), (1.5, 2), (2.5, 3), (0.4999, 0), (-0.5, 0), (900.0, 900)],
)
def test_round_half_up_is_not_bankers_rounding(value: float, expected: int) -> None:
    """``round(0.5)`` is 0 in Python and 1 in JS; the shared helper is 1 in both."""
    assert TK.round_half_up(value) == expected


def test_fixed_never_prints_negative_zero() -> None:
    assert TK.fixed(-0.00004, 4) == "0.0000"
    assert TK.fixed(-0.00006, 4) == "-0.0001"


def test_an_unknown_token_is_left_exactly_as_written() -> None:
    ctx = TK.TokenContext.from_mapping(CHICAGO)
    assert TK.expand_tokens("{nope}", ctx) == "{nope}"
    assert TK.expand_tokens("{CITY}", ctx) == "{CITY}"


def test_an_unmeasured_scale_leaves_the_token_standing() -> None:
    ctx = TK.TokenContext.from_mapping(UNMEASURED)
    assert TK.format_scale(ctx) is None
    assert TK.expand_tokens("scale {scale}", ctx) == "scale {scale}"


def test_the_city_token_is_never_guessed_from_the_coordinates() -> None:
    """This module never invents a value: an unset ``city`` (the caller's job
    to resolve, not this formatter's) expands to an empty string even though
    lat/lon plainly identify the place."""
    ctx = TK.TokenContext.from_mapping(UNSET_CITY)
    assert TK.format_city(ctx) == ""
    assert TK.expand_tokens("{city}{coords}", ctx) == "41.8827° N, 87.6233° W"


def test_hero_formats_a_count_not_a_name() -> None:
    """``SceneGraph.Building`` carries no ``name`` field (frozen contract), so
    ``{hero}`` is the count of selected heroes, empty when none are picked."""
    assert TK.format_hero(TK.TokenContext.from_mapping(CHICAGO)) == ""
    assert TK.format_hero(TK.TokenContext.from_mapping(ONE_HERO)) == "1"
    assert TK.format_hero(TK.TokenContext.from_mapping(WITH_PLACE)) == "3"


def test_place_and_author_tokens_default_to_empty_never_a_guess() -> None:
    ctx = TK.TokenContext.from_mapping(NO_PLACE)
    assert TK.format_country(ctx) == ""
    assert TK.format_state(ctx) == ""
    assert TK.format_neighbourhood(ctx) == ""
    assert TK.format_author(ctx) == ""
