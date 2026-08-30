"""The thirteen text tokens FrameCraft expands in engravings and the underside
mark.

This module is one half of a MIRRORED PAIR: ``apps/web/lib/tokens.ts`` is the
same table with the same snake_case names, so the string the editor previews on
the frame is byte for byte the string the bake cuts into it.  The pair is pinned
by ``fixtures/tokens-expected.json``, which both test suites assert against
(DECISIONS [V2-P2], and the same arrangement transform.py/transform.ts already
uses per [P4]).

Rules:

* This module is a pure FORMATTER.  It never decides what ``{city}`` (or
  ``{country}``, ``{state}``, ``{neighbourhood}``, ``{author}``) actually says -
  the caller resolves that and hands the resolved string in on
  :class:`TokenContext`.  In production that caller is the TS side: every
  engraving reaching ``POST /bake`` is already fully resolved client-side
  (DECISIONS [V3-P1]), so ``services/bake/app/bake.py`` never populates these
  five fields today and they default to empty - this module still carries them,
  with the same formatting rules as the TS mirror, purely so the shared
  ``expand_tokens`` behaviour (and the ``tokens-expected.json`` fixture) stays
  provably identical between the two languages.
* ``{hero}`` is the COUNT of selected hero buildings, not a building's real
  name: ``SceneGraph.Building`` (the frozen contract) carries no ``name``
  field, so there is nothing honest to print in its place.
* An unknown ``{token}`` is left exactly as written - it is far likelier to be
  a deliberate brace in someone's text than a typo we should silently eat.
* Every number is formatted by hand (:func:`fixed`, :func:`group_thousands`,
  :func:`round_half_up`) instead of through ``format()`` / ``toFixed()`` /
  ``toLocaleString()``, because those three disagree with their JS counterparts
  at ties and under locales.  Arithmetic here is plain IEEE-754 doubles in both
  languages, so the two implementations cannot drift.

Stdlib only, no pydantic: the bake passes the real models in, the tests pass
plain data, and neither needs an import of the other.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Callable, Dict, Mapping, Optional, Tuple

__all__ = [
    "TOKENS",
    "TokenContext",
    "FORMATTERS",
    "expand_tokens",
    "format_city",
    "format_lat",
    "format_lon",
    "format_coords",
    "format_scale",
    "format_radius",
    "format_date",
    "format_buildings",
    "format_country",
    "format_state",
    "format_neighbourhood",
    "format_author",
    "format_hero",
    "fixed",
    "group_thousands",
    "round_half_up",
]

#: Every token name, in the order the docs list them.
TOKENS: Tuple[str, ...] = (
    "city",
    "lat",
    "lon",
    "coords",
    "scale",
    "radius",
    "date",
    "buildings",
    "country",
    "state",
    "neighbourhood",
    "author",
    "hero",
)

#: Decimal places for a latitude or longitude: ~11 m at the equator, which is
#: finer than the crop this model is a picture of.
COORD_DECIMALS = 4

_TOKEN_RE = re.compile(r"\{([A-Za-z_][A-Za-z_0-9]*)\}")


@dataclass(frozen=True)
class TokenContext:
    """Everything the token table can talk about.

    ``date`` is supplied by the CALLER as an ISO ``YYYY-MM-DD`` string and never
    read from the clock here, so a bake and its preview agree and a test is not
    a function of the day it runs on.
    """

    lat: float
    lon: float
    scale_mm_per_m: float
    radius_m: float
    date: str
    buildings: int
    city: str = ""
    country: str = ""
    state: str = ""
    neighbourhood: str = ""
    author: str = ""
    #: How many hero buildings are selected.  ``{hero}`` formats this count,
    #: never a name - see the module docstring.
    hero_count: int = 0

    @staticmethod
    def from_mapping(data: Mapping[str, object]) -> "TokenContext":
        """Build a context from plain JSON (the fixture's ``ctx`` objects)."""
        return TokenContext(
            lat=float(data["lat"]),  # type: ignore[arg-type]
            lon=float(data["lon"]),  # type: ignore[arg-type]
            scale_mm_per_m=float(data["scale_mm_per_m"]),  # type: ignore[arg-type]
            radius_m=float(data["radius_m"]),  # type: ignore[arg-type]
            date=str(data.get("date", "")),
            buildings=int(data["buildings"]),  # type: ignore[arg-type]
            city=str(data.get("city", "")),
            country=str(data.get("country", "")),
            state=str(data.get("state", "")),
            neighbourhood=str(data.get("neighbourhood", "")),
            author=str(data.get("author", "")),
            hero_count=int(data.get("hero_count", 0)),  # type: ignore[arg-type]
        )


# ---------------------------------------------------------------------------
# number formatting, mirrored verbatim in tokens.ts
# ---------------------------------------------------------------------------


def round_half_up(value: float) -> int:
    """Round to the nearest integer, ties away from zero on the positive side.

    ``math.floor(x + 0.5)``, which is exactly what ``Math.round`` does in JS.
    Python's own ``round`` is banker's rounding and would disagree on every
    tie (``round(0.5) == 0``), which is precisely the kind of one-off that
    would show up as a 1:23,570 engraved next to a 1:23,571 preview.
    """
    return int(math.floor(value + 0.5))


def group_thousands(value: int) -> str:
    """``23571`` -> ``"23,571"``.  Hand-rolled so JS locales cannot change it.

    ``str(int(...))`` is plain decimal at every magnitude in Python; the TS
    mirror has to reach for ``BigInt`` to get the same, because ``String(1e21)``
    is ``"1e+21"`` there.  Both sides therefore group the same digit string.
    """
    sign = "-" if value < 0 else ""
    digits = str(abs(int(value)))
    groups = []
    while len(digits) > 3:
        groups.insert(0, digits[-3:])
        digits = digits[:-3]
    groups.insert(0, digits)
    return sign + ",".join(groups)


def fixed(value: float, decimals: int) -> str:
    """``value`` with exactly ``decimals`` places, ties away from zero.

    Built from integer arithmetic on the scaled value so Python and JS produce
    the same digits; a negative value that rounds to zero prints ``0.0000``,
    never ``-0.0000``.
    """
    factor = 10**decimals
    scaled = int(math.floor(abs(value) * factor + 0.5))
    whole, frac = divmod(scaled, factor)
    sign = "-" if value < 0 and scaled != 0 else ""
    return f"{sign}{whole}." + str(frac).rjust(decimals, "0")


# ---------------------------------------------------------------------------
# the formatters
# ---------------------------------------------------------------------------


def format_city(ctx: TokenContext) -> str:
    """The user's typed city label, verbatim; empty when they typed nothing."""
    return ctx.city or ""


def format_lat(ctx: TokenContext) -> str:
    """Signed latitude, 4 decimals: ``41.8827`` / ``-33.8688``."""
    return fixed(ctx.lat, COORD_DECIMALS)


def format_lon(ctx: TokenContext) -> str:
    """Signed longitude, 4 decimals: ``-87.6233``."""
    return fixed(ctx.lon, COORD_DECIMALS)


def format_coords(ctx: TokenContext) -> str:
    """``41.8827° N, 87.6233° W`` - absolute values plus a hemisphere letter."""
    ns = "N" if ctx.lat >= 0 else "S"
    ew = "E" if ctx.lon >= 0 else "W"
    lat = fixed(abs(ctx.lat), COORD_DECIMALS)
    lon = fixed(abs(ctx.lon), COORD_DECIMALS)
    return f"{lat}° {ns}, {lon}° {ew}"


def format_scale(ctx: TokenContext) -> Optional[str]:
    """``1:23,571`` from ``scale_mm_per_m`` (print mm per ground metre, [P4]).

    Returns None - which leaves ``{scale}`` standing in the text - when the
    scale is not positive.  There is no honest ratio for a scene that has not
    been measured yet, and printing ``1:0`` or an empty gap onto a frame is
    worse than printing the token the user typed.
    """
    if not ctx.scale_mm_per_m > 0:
        return None
    return "1:" + group_thousands(round_half_up(1000.0 / ctx.scale_mm_per_m))


def format_radius(ctx: TokenContext) -> str:
    """``900 m`` - whole metres, no thousands separator (DECISIONS [V2-P2])."""
    return f"{round_half_up(ctx.radius_m)} m"


def format_date(ctx: TokenContext) -> str:
    """The caller's ISO date, verbatim."""
    return ctx.date or ""


def format_buildings(ctx: TokenContext) -> str:
    """``1,841`` - the building count with thousands separators."""
    return group_thousands(int(ctx.buildings))


def format_country(ctx: TokenContext) -> str:
    """The resolved country name, verbatim; empty when nothing resolved one."""
    return ctx.country or ""


def format_state(ctx: TokenContext) -> str:
    """The resolved state or province, verbatim; empty when nothing resolved one."""
    return ctx.state or ""


def format_neighbourhood(ctx: TokenContext) -> str:
    """The resolved neighbourhood, verbatim; empty when nothing resolved one."""
    return ctx.neighbourhood or ""


def format_author(ctx: TokenContext) -> str:
    """The author's own typed name, verbatim; empty when they typed nothing."""
    return ctx.author or ""


def format_hero(ctx: TokenContext) -> str:
    """``3`` - how many hero buildings are selected, or ``""`` when none are.

    Not a building's name: see the module docstring for why.
    """
    count = int(ctx.hero_count)
    return group_thousands(count) if count > 0 else ""


#: token name -> formatter.  A formatter returning None means "cannot be
#: expanded"; the token is then left in the text exactly as written.
FORMATTERS: Dict[str, Callable[[TokenContext], Optional[str]]] = {
    "city": format_city,
    "lat": format_lat,
    "lon": format_lon,
    "coords": format_coords,
    "scale": format_scale,
    "radius": format_radius,
    "date": format_date,
    "buildings": format_buildings,
    "country": format_country,
    "state": format_state,
    "neighbourhood": format_neighbourhood,
    "author": format_author,
    "hero": format_hero,
}


def expand_tokens(text: str, ctx: TokenContext) -> str:
    """Replace every known ``{token}`` in ``text``; leave everything else alone.

    Nothing but the tokens is touched: no trimming, no case folding, no collapse
    of the spaces around a token that expanded to "".
    """

    def replace(match: "re.Match[str]") -> str:
        formatter = FORMATTERS.get(match.group(1))
        if formatter is None:
            return match.group(0)
        value = formatter(ctx)
        return match.group(0) if value is None else value

    return _TOKEN_RE.sub(replace, text)
