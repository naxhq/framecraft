"""Frame lettering and ornaments: glyph outlines -> printable 2D geometry.

This module turns text into the same kind of shapely polygons every other
Stage 1 layer produces, and then applies the *same* minimum-feature repair
(``04_PRINTABILITY_SPEC.md`` stage 1) to them, because a letter that is thinner
than the nozzle is exactly as unprintable as a building that is.

Three OFL fonts are bundled under ``app/fonts/<face>/`` (see the handoff note
for versions, URLs and licences).  Outlines come from ``fontTools``; beziers are
flattened at :data:`FLATTEN_TOLERANCE_MM` of PRINT tolerance, so the number of
segments depends on the printed ``size_mm`` - a 3 mm letter needs fewer chords
than an 8 mm one to look equally round.

Units.  Everything below works either in FONT UNITS (the font's own em grid,
``face.upem`` per em) or in PRINT MILLIMETRES.  There are no ground metres
anywhere in this file: the frame lip is a printed object, its size does not
depend on the map scale, and the only place the map enters is the scale bar's
*label*.  Functions are suffixed ``_units`` or ``_mm`` accordingly.

The layout - which edge, which anchor, which rotation, which fitted size - is
NOT decided here.  It lives in :mod:`app.geom.transform`, mirrored by
``apps/web/lib/transform.ts``, so the preview draws the text exactly where the
bake cuts it.  This module consumes that layout and produces geometry.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Callable, Iterable, Sequence

import shapely
import shapely.affinity
from fontTools.pens.basePen import BasePen
from fontTools.ttLib import TTFont
from shapely.geometry import Polygon
from shapely.geometry.base import BaseGeometry

from app.geom import thicken
from app.geom import tokens as TOK
from app.geom import transform as T

__all__ = [
    "FONT_DIR",
    "FACE_FILES",
    "FLATTEN_TOLERANCE_MM",
    "GLYPH_ASSET_SIZE_MM",
    "STEM_AREA_RATIO",
    "Face",
    "load_face",
    "face_metrics",
    "advance_units",
    "supported_char",
    "glyph_contours_units",
    "glyph_polygon_units",
    "glyph_stem_units",
    "glyph_counter_units",
    "text_area_floor",
    "counter_regions",
    "counter_cores",
    "counter_widths_mm",
    "text_polygons_mm",
    "text_advance_units",
    "place",
    "repair_text",
    "TextRepair",
    "merge_stroke_ridges",
    "north_arrow_polygon",
    "scale_bar_polygons",
    "scale_bar_rules",
    "scale_bar_label_glyphs",
    "keyhole_polygon",
    "magnet_polygons",
    "underside_pocket_polygons",
    "LetteringGeometry",
    "BaseTooThinError",
    "build",
]

#: Where the bundled OFL faces live.  One directory per face, each holding the
#: static TTF exactly as it was published plus its licence file.
FONT_DIR = Path(__file__).resolve().parents[1] / "fonts"

#: ``PrintParams.engravings[].font`` -> (directory, file name).
FACE_FILES: dict[str, tuple[str, str]] = {
    "sans": ("sans", "Inter-Regular.ttf"),
    "serif": ("serif", "SourceSerif4-Regular.ttf"),
    "mono": ("mono", "JetBrainsMono-Regular.ttf"),
}

#: Bezier flattening tolerance, in PRINT millimetres.  Converted to font units
#: with the printed size, so the chord count follows the printed size instead of
#: being a fixed number that is coarse on an 8 mm letter and wasteful on a
#: 1.5 mm one.  0.02 mm is one twentieth of the default nozzle.
FLATTEN_TOLERANCE_MM = 0.02

#: The printed size the committed glyph assets (``apps/web/lib/fonts/*.glyphs
#: .json``) are flattened at.  It is the contract's MAXIMUM ``size_mm``, i.e. the
#: finest flattening any legal engraving can ask for, so the preview never draws
#: a coarser outline than the bake cuts.
GLYPH_ASSET_SIZE_MM = 8.0

#: Ceiling of the "what size WOULD work" search behind a refusal.  It is the
#: contract's maximum ``engravings[].size_mm``: naming a size the editor cannot
#: accept would be no better than naming none (v2-03 audit, finding 4).
TEXT_SEARCH_MAX_MM = 8.0

#: Offsets above the refused size the search tries, in order.  It widens as it
#: climbs because a string that needs 0.25 mm more is common and one that needs
#: 4 mm more is rare, and every probe is a full minimum-feature repair (~0.6 s
#: on a 14-glyph string).  Ten probes bracket the whole legal range.
TEXT_SEARCH_LADDER_MM: tuple[float, ...] = (
    0.25,
    0.5,
    0.75,
    1.0,
    1.5,
    2.0,
    2.5,
    3.0,
    4.0,
    5.0,
    6.0,
)

#: Resolution of the refining walk back down from the size that worked.  0.05 mm
#: is the contract's own resolution for ``size_mm``.
TEXT_SEARCH_FINE_MM = 0.05

#: How far that walk may go, in steps.  Bounds the whole search at 21 probes:
#: printability is not monotonic in the size (the repair widens different
#: terminals at different sizes and the ridge merge bridges different pairs), so
#: the walk stops at the first size that fails and reports the last that worked
#: - a size that is measured, even when a smaller one further down would also
#: have worked.
TEXT_SEARCH_REFINE_STEPS = 10

#: Hard cap on the chords one bezier may be split into.  Never reached at legal
#: sizes (an 8 mm letter needs 3-6); it only bounds a pathological input.
MAX_CURVE_SEGMENTS = 64

#: Fraction of a glyph's area the morphological opening must still cover for a
#: radius to count as "inside the stroke".  :func:`glyph_stem_units` binary
#: searches the largest such radius, so it measures the DOMINANT stroke width -
#: which is what decides whether the glyph needs dilating - instead of the
#: narrowest tapering terminal, which every glyph has and which Stage 1's
#: appendage rule widens anyway.
STEM_AREA_RATIO = 0.5

#: Binary-search resolution of :func:`glyph_stem_units`, in font units.  The
#: coarsest em in the three bundled faces is 1000 units, so a quarter of a unit
#: is 1/4000 em - four orders of magnitude below a nozzle.
STEM_SEARCH_TOLERANCE_UNITS = 0.25

#: Codepoints the metrics/glyph assets carry: printable ASCII, the degree sign
#: and the printable Latin-1 supplement (so an accented city name lays out).
#: U+00AD (soft hyphen) is excluded: it is an invisible line-break hint.
SUPPORTED_CODEPOINTS: tuple[int, ...] = tuple(range(32, 127)) + tuple(
    c for c in range(0xA0, 0x100) if c != 0xAD
)


# --------------------------------------------------------------------------
# Faces
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Face:
    """One loaded font face.  Immutable and cached; fontTools objects inside."""

    name: str
    path: Path
    upem: int
    ascender: int
    descender: int
    cap_height: int
    x_height: int
    cmap: dict
    glyph_set: object
    hmtx: object
    notdef: str

    def glyph_name(self, ch: str) -> str | None:
        """Glyph name for one character, or None when the face has no glyph."""
        return self.cmap.get(ord(ch))


@lru_cache(maxsize=8)
def load_face(name: str) -> Face:
    """Load one of the three bundled faces.  Cached: a bake reads each once."""
    try:
        directory, filename = FACE_FILES[name]
    except KeyError:  # pragma: no cover - the contract's enum prevents this
        raise ValueError(f"unknown font face: {name!r}") from None
    path = FONT_DIR / directory / filename
    font = TTFont(str(path), lazy=True)
    os2 = font["OS/2"]
    head = font["head"]
    hhea = font["hhea"]
    return Face(
        name=name,
        path=path,
        upem=int(head.unitsPerEm),
        ascender=int(hhea.ascent),
        descender=int(hhea.descent),
        cap_height=int(getattr(os2, "sCapHeight", 0) or hhea.ascent),
        x_height=int(getattr(os2, "sxHeight", 0) or 0),
        cmap=dict(font.getBestCmap()),
        glyph_set=font.getGlyphSet(),
        hmtx=font["hmtx"],
        notdef=".notdef",
    )


def face_metrics(name: str) -> dict:
    """The face-level numbers the generated metrics JSON carries."""
    face = load_face(name)
    return {
        "face": face.name,
        "file": face.path.name,
        "units_per_em": face.upem,
        "ascender": face.ascender,
        "descender": face.descender,
        "cap_height": face.cap_height,
        "x_height": face.x_height,
    }


def supported_char(face: Face, ch: str) -> bool:
    """True when this character is in the shared metrics table AND in the face.

    The two conditions are separate on purpose: the metrics table is the set the
    TypeScript mirror can lay out, so a character the FONT has but the table does
    not must still be dropped, or the preview and the bake would disagree about
    the width of the same string.
    """
    return ord(ch) in SUPPORTED_CODEPOINTS and face.glyph_name(ch) is not None


def advance_units(face: Face, ch: str) -> int:
    """Advance width of one character, in font units.  0 for an unknown glyph."""
    name = face.glyph_name(ch)
    if name is None:
        return 0
    return int(face.hmtx[name][0])


def text_advance_units(face: Face, text: str) -> tuple[int, list[str]]:
    """(total advance in font units, the characters that were dropped).

    No kerning: the three bundled faces carry GPOS kerning, but applying it would
    put a shaping engine in the browser mirror as well.  Plain advance widths are
    what both sides can agree on to the last unit, and a frame legend is not
    typesetting.
    """
    total = 0
    dropped: list[str] = []
    for ch in text:
        if not supported_char(face, ch):
            dropped.append(ch)
            continue
        total += advance_units(face, ch)
    return total, dropped


# --------------------------------------------------------------------------
# Outlines
# --------------------------------------------------------------------------


def _quad_point(p0, p1, p2, t: float) -> tuple[float, float]:
    s = 1.0 - t
    return (
        s * s * p0[0] + 2.0 * s * t * p1[0] + t * t * p2[0],
        s * s * p0[1] + 2.0 * s * t * p1[1] + t * t * p2[1],
    )


def _cubic_point(p0, p1, p2, p3, t: float) -> tuple[float, float]:
    s = 1.0 - t
    a, b, c, d = s * s * s, 3.0 * s * s * t, 3.0 * s * t * t, t * t * t
    return (
        a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
        a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    )


def _segments_for(second_difference: float, factor: float, tolerance: float) -> int:
    """Chords needed so the polyline stays within ``tolerance`` of the curve.

    For a quadratic the deviation of an ``n``-chord polyline is bounded by
    ``|P0 - 2 P1 + P2| / (8 n^2)`` and for a cubic by ``3 max(|d1|, |d2|) /
    (4 n^2)``; ``factor`` is the constant of whichever curve is being flattened.
    """
    if second_difference <= 0.0 or tolerance <= 0.0:
        return 1
    n = math.ceil(math.sqrt(factor * second_difference / tolerance))
    return max(1, min(MAX_CURVE_SEGMENTS, int(n)))


class _FlattenPen(BasePen):
    """A fontTools pen that emits flat contours in font units.

    ``BasePen`` decomposes composite glyphs (an accented letter is a component
    reference) and normalises multi-point quadratic splines into individual
    ``_qCurveToOne`` calls with the implied on-curve points inserted, so this
    pen only has to flatten one curve at a time.
    """

    def __init__(self, glyph_set, tolerance: float) -> None:
        super().__init__(glyph_set)
        self.tolerance = max(float(tolerance), 1e-9)
        self.contours: list[list[tuple[float, float]]] = []
        self._cur: list[tuple[float, float]] = []

    # -- pen protocol ----------------------------------------------------
    def _moveTo(self, pt) -> None:
        self._flush()
        self._cur = [(float(pt[0]), float(pt[1]))]

    def _lineTo(self, pt) -> None:
        self._cur.append((float(pt[0]), float(pt[1])))

    def _qCurveToOne(self, p1, p2) -> None:
        p0 = self._cur[-1] if self._cur else (0.0, 0.0)
        dx = p0[0] - 2.0 * p1[0] + p2[0]
        dy = p0[1] - 2.0 * p1[1] + p2[1]
        n = _segments_for(math.hypot(dx, dy), 1.0 / 8.0, self.tolerance)
        for i in range(1, n + 1):
            self._cur.append(_quad_point(p0, p1, p2, i / n))

    def _curveToOne(self, p1, p2, p3) -> None:  # pragma: no cover - TTF is quadratic
        p0 = self._cur[-1] if self._cur else (0.0, 0.0)
        d1 = math.hypot(p0[0] - 2.0 * p1[0] + p2[0], p0[1] - 2.0 * p1[1] + p2[1])
        d2 = math.hypot(p1[0] - 2.0 * p2[0] + p3[0], p1[1] - 2.0 * p2[1] + p3[1])
        n = _segments_for(max(d1, d2), 3.0 / 4.0, self.tolerance)
        for i in range(1, n + 1):
            self._cur.append(_cubic_point(p0, p1, p2, p3, i / n))

    def _closePath(self) -> None:
        self._flush()

    def _endPath(self) -> None:
        self._flush()

    def _flush(self) -> None:
        if len(self._cur) >= 3:
            first, last = self._cur[0], self._cur[-1]
            if abs(first[0] - last[0]) < 1e-9 and abs(first[1] - last[1]) < 1e-9:
                self._cur = self._cur[:-1]
        if len(self._cur) >= 3:
            self.contours.append(self._cur)
        self._cur = []


def flatten_tolerance_units(face: Face, size_mm: float) -> float:
    """:data:`FLATTEN_TOLERANCE_MM` expressed in this face's font units."""
    if size_mm <= 0.0:
        raise ValueError("size_mm must be positive")
    return FLATTEN_TOLERANCE_MM * face.upem / float(size_mm)


def glyph_contours_units(
    face: Face, ch: str, tolerance_units: float
) -> list[list[tuple[float, float]]]:
    """Flat contours of one glyph, in font units, in the font's own order."""
    name = face.glyph_name(ch)
    if name is None:
        return []
    pen = _FlattenPen(face.glyph_set, tolerance_units)
    face.glyph_set[name].draw(pen)
    return pen.contours


def _contours_to_geometry(contours: Sequence[Sequence[tuple[float, float]]]) -> BaseGeometry | None:
    """Contours -> a polygonal geometry with counters as HOLES.

    Nesting is decided by CONTAINMENT DEPTH, not by winding direction: a contour
    inside an odd number of others is a hole, one inside an even number is a
    shell.  Direction would work for a font that follows the TrueType convention
    perfectly, containment works for every font, and it is the same even-odd rule
    a rasteriser applies - which is why the counters of ``o``, ``a``, ``e``, ``8``
    and ``B`` come out as holes rather than as filled blobs.
    """
    rings: list[Polygon] = []
    for contour in contours:
        if len(contour) < 3:
            continue
        poly = Polygon(contour)
        if not poly.is_valid:
            poly = shapely.make_valid(poly)
            parts = thicken.explode(poly)
            if not parts:
                continue
            poly = max(parts, key=lambda p: p.area)
        if poly.area > 0.0:
            rings.append(Polygon(poly.exterior))
    if not rings:
        return None

    # Depth is counted with WHOLE-RING containment, never with a representative
    # point: the representative point of the filled outer ring of an ``o`` lands
    # in the middle of the counter, so the outer ring would count itself as
    # nested inside its own counter and the glyph would come out empty.
    depth = [0] * len(rings)
    for i, ring in enumerate(rings):
        for j, other in enumerate(rings):
            if i != j and other.contains(ring):
                depth[i] += 1

    shells = [i for i in range(len(rings)) if depth[i] % 2 == 0]
    holes = [i for i in range(len(rings)) if depth[i] % 2 == 1]
    built: list[Polygon] = []
    for i in shells:
        own: list = []
        for h in holes:
            # A hole belongs to the DEEPEST shell that contains it, so a ring
            # nested three deep does not punch a hole in the outermost shell.
            if depth[h] != depth[i] + 1:
                continue
            if rings[i].contains(rings[h]):
                own.append(rings[h].exterior.coords)
        poly = Polygon(rings[i].exterior.coords, own)
        if not poly.is_valid:
            poly = shapely.make_valid(poly)
        built.extend(thicken.explode(poly))
    if not built:
        return None
    return shapely.union_all(built)


def glyph_polygon_units(face: Face, ch: str, tolerance_units: float) -> BaseGeometry | None:
    """One glyph as a polygonal geometry in font units, counters as holes."""
    return _contours_to_geometry(glyph_contours_units(face, ch, tolerance_units))


def _scaled(geom: BaseGeometry, factor: float, dx: float = 0.0, dy: float = 0.0) -> BaseGeometry:
    return shapely.affinity.affine_transform(geom, [factor, 0.0, 0.0, factor, dx, dy])


def glyph_polygon_mm(face: Face, ch: str, size_mm: float) -> BaseGeometry | None:
    """One glyph at its printed size, baseline on y=0, origin at the pen point."""
    geom = glyph_polygon_units(face, ch, flatten_tolerance_units(face, size_mm))
    if geom is None or geom.is_empty:
        return None
    return _scaled(geom, float(size_mm) / face.upem)


def text_polygons_mm(
    text: str, face_name: str, size_mm: float
) -> tuple[list[Polygon], list[str]]:
    """A whole string as polygons in print mm.  Returns (polygons, dropped).

    The string is laid out along +x from the origin with the baseline on y = 0,
    which is the local frame :func:`place` then rotates onto the requested frame
    edge.  Advance widths only, no kerning (see :func:`text_advance_units`).
    """
    face = load_face(face_name)
    tolerance = flatten_tolerance_units(face, size_mm)
    factor = float(size_mm) / face.upem
    pen_x = 0
    out: list[Polygon] = []
    dropped: list[str] = []
    for ch in text:
        if not supported_char(face, ch):
            dropped.append(ch)
            continue
        geom = glyph_polygon_units(face, ch, tolerance)
        if geom is not None and not geom.is_empty:
            out.extend(thicken.explode(_scaled(geom, factor, dx=pen_x * factor)))
        pen_x += advance_units(face, ch)
    return out, dropped


# --------------------------------------------------------------------------
# Per-glyph measurements (the numbers the shared layout math predicts from)
# --------------------------------------------------------------------------


def glyph_stem_units(geom: BaseGeometry | None, upem: int) -> float:
    """Dominant stroke width of a glyph, in font units.

    Defined as ``2 * r`` for the largest ``r`` whose morphological opening still
    covers :data:`STEM_AREA_RATIO` of the glyph's area.  A stroke of width ``w``
    survives an opening at ``r <= w/2`` and vanishes above it, so this is the
    stroke width of the bulk of the glyph.  It is scale free - the search runs in
    font units and the printed stroke is ``stem * size_mm / upem`` - and it
    deliberately ignores the tapering terminals every glyph has, which Stage 1's
    appendage rule widens rather than refuses.
    """
    if geom is None or geom.is_empty or geom.area <= 0.0:
        return 0.0
    area = geom.area
    lo = 0.0
    hi = float(upem) / 2.0
    for _ in range(40):
        if hi - lo <= STEM_SEARCH_TOLERANCE_UNITS:
            break
        mid = (lo + hi) / 2.0
        opened = shapely.buffer(shapely.buffer(geom, -mid, quad_segs=4), mid, quad_segs=4)
        if not opened.is_empty and opened.intersection(geom).area >= STEM_AREA_RATIO * area:
            lo = mid
        else:
            hi = mid
    return 2.0 * lo


def _params_with_size(
    params: T.ParamsLike, index: int, size_mm: float
) -> "T.ParamsLike | None":
    """A copy of ``params`` with engraving ``index`` asked for at ``size_mm``.

    Used only by the refusal's "what size would work" search, which has to
    re-run the SHARED layout at the candidate size rather than just re-scaling
    the outlines: the auto-fit, the dilation and the placement all depend on it.
    Returns ``None`` for a params object that cannot be copied (a test double),
    in which case the refusal falls back to advice without a number.
    """
    engravings = list(getattr(params, "engravings", ()) or ())
    if index >= len(engravings):
        return None
    engraving = engravings[index]
    if hasattr(engraving, "model_copy") and hasattr(params, "model_copy"):
        engravings[index] = engraving.model_copy(update={"size_mm": float(size_mm)})
        return params.model_copy(update={"engravings": engravings})
    return None


def text_area_floor(params: T.ParamsLike) -> float:
    """Area under which a measured sliver of text is not a feature, mm^2.

    04 stage 1's own noise floor - ``min_detail ** 2``, "anything under this in
    area is dropped" - rather than the quarter of it :func:`thicken.residue_area
    _floor` uses for buildings.  The quarter exists because GEOS splits one
    building wing into halves that straddle the full floor when the same layer is
    measured in ground metres and in print millimetres (DECISIONS [P3-fix]);
    text is measured in print millimetres only, and it has something buildings do
    not: dozens of ACUTE convex corners per string.  The morphological opening
    that isolates a thin appendage rounds every convex corner sharper than its
    own radius, leaving a lens of about ``0.7 * (0.45 * min_wall) ** 2`` - 0.09
    mm^2 at the default nozzle - whose inscribed width is the corner's radius,
    not any wall's.  Below 04's floor those lenses are noise; a stroke that is
    genuinely too thin is a stroke, i.e. several times longer than it is wide,
    and is an order of magnitude above it.
    """
    detail = T.min_detail_mm(params)
    return detail * detail


def counter_regions(geom: BaseGeometry | None) -> list[Polygon]:
    """The counters of a glyph: its holes MINUS whatever stands inside them.

    A hole on its own is not the counter when something is drawn inside it.
    JetBrains Mono's zero carries a dot, and Inter's ``%``-family glyphs are
    built the same way: the printable ridge is the ring of space BETWEEN the
    island and the surrounding stroke, and it is far narrower than the hole that
    contains both.  Measuring the hole instead would promise a counter three
    times wider than the one that has to survive the dilation - and would then
    protect a "counter" that runs straight through the middle of the dot.
    """
    if geom is None or geom.is_empty:
        return []
    parts = thicken.explode(geom)
    if not parts:
        return []
    ink = shapely.union_all(parts)
    out: list[Polygon] = []
    for part in parts:
        for interior in part.interiors:
            hole = Polygon(interior)
            if not hole.is_valid:
                pieces = thicken.valid_polygons(hole)
                if not pieces:
                    continue
                hole = max(pieces, key=lambda p: p.area)
            out.extend(thicken.valid_polygons(hole.difference(ink)))
    return out


def glyph_counter_units(geom: BaseGeometry | None) -> float | None:
    """Narrowest counter of a glyph, in font units.

    None when the glyph has no counter, which means no dilation can ever close
    one and the glyph puts no upper bound on how much it may be widened.
    """
    narrowest: float | None = None
    for counter in counter_regions(geom):
        width = thicken.inscribed_width(counter, max(counter.length, 1.0) * 1e-4)
        if width <= 0.0:
            continue
        narrowest = width if narrowest is None else min(narrowest, width)
    return narrowest


# --------------------------------------------------------------------------
# Placement
# --------------------------------------------------------------------------


def place(
    geom: BaseGeometry,
    anchor_x: float,
    anchor_y: float,
    rotation_deg: float,
    mirror_x: bool = False,
) -> BaseGeometry:
    """Move text/ornament geometry from its local frame onto the plate.

    Local frame: +x is the reading direction, +y is the text's up direction, the
    origin is the baseline anchor.  ``mirror_x`` is applied FIRST, in the local
    frame, which is what makes the underside mark read correctly once the plate
    is turned over.
    """
    theta = math.radians(float(rotation_deg))
    cos_t = math.cos(theta)
    sin_t = math.sin(theta)
    sx = -1.0 if mirror_x else 1.0
    # [a b; d e] = R(theta) . diag(sx, 1)
    return shapely.affinity.affine_transform(
        geom,
        [cos_t * sx, -sin_t, sin_t * sx, cos_t, float(anchor_x), float(anchor_y)],
    )


# --------------------------------------------------------------------------
# Stage 1 repair, applied to text exactly as it is applied to a building layer
# --------------------------------------------------------------------------


@dataclass
class TextRepair:
    """What the minimum-feature repair did to one piece of text."""

    polygons: list[Polygon] = field(default_factory=list)
    widened: int = 0
    dropped: int = 0
    counters_before: int = 0
    counters_after: int = 0
    narrowest_mm: float = 0.0
    #: Narrowest COUNTER left in the repaired text, print mm (0.0 when the text
    #: has no counter at all).  A counter is a ridge of lip standing inside a
    #: letter, so it obeys the complement-ridge rule, not the stroke rule.
    narrowest_counter_mm: float = 0.0

    @property
    def lost_counters(self) -> int:
        return max(0, self.counters_before - self.counters_after)


def dilate_glyph(poly: Polygon, distance: float) -> BaseGeometry:
    """04 stage 1, buildings 2, applied to a glyph.

    ROUND joins, not mitre: a mitre join turns the apex of an ``A`` or the spur
    of a ``4`` into a spike several times the dilation long, which the appendage
    pass then has to cut off again.  A round join is also what a widened letter
    is supposed to look like - it is the outline a broader pen would have drawn.
    """
    if distance <= 0.0:
        return poly
    return shapely.buffer(poly, distance, quad_segs=4, join_style="round")


def counter_cores(polys: Iterable[Polygon], params: T.ParamsLike) -> list[Polygon]:
    """A one-nozzle-wide core of every counter that starts wide enough to keep.

    The uniform dilation shrinks a counter by exactly ``2 * d``, and that is the
    model the shared refusal rule uses: an engraving is allowed through when its
    counters survive it at least one nozzle wide.  The appendage pass that
    follows, however, grows every stroke that is STILL thin - which on a face
    whose horizontals are much lighter than its stems means growing into the
    counter, past what the model promised, until the letter pinches shut.

    These cores are subtracted back out after that pass, so a counter the rule
    let through really does come out at least a nozzle wide.  At a size where
    nothing needs the extra widening they are entirely inside the counter and
    subtracting them changes nothing.
    """
    detail = T.min_detail_mm(params)
    tolerance = detail * thicken.MIC_TOLERANCE_RATIO
    keeps: list[Polygon] = []
    for counter in counter_regions(shapely.union_all(list(polys))):
        width = thicken.inscribed_width(counter, tolerance)
        if width <= detail:
            continue  # doomed anyway: there is nothing here to protect
        core = shapely.buffer(
            counter, -(width - detail) / 2.0, quad_segs=4, join_style="round"
        )
        keeps.extend(thicken.explode(core))
    return keeps


def counter_widths_mm(polys: Iterable[Polygon], params: T.ParamsLike) -> list[float]:
    """Inscribed width of every counter in the repaired text, print mm."""
    detail = T.min_detail_mm(params)
    tolerance = detail * thicken.MIC_TOLERANCE_RATIO
    parts = list(polys)
    if not parts:
        return []
    return [
        thicken.inscribed_width(counter, tolerance)
        for counter in counter_regions(shapely.union_all(parts))
    ]


def repair_text(
    polys: Iterable[Polygon],
    params: T.ParamsLike,
    dilation_mm: float = 0.0,
    target_mm: float | None = None,
    grid_mm: float = thicken.PRINT_GRID_MM,
) -> TextRepair:
    """04 stage 1, applied per glyph, in PRINT millimetres.

    The same steps in the same order as every other layer, with the glyph's
    measured stroke standing in for 04's hydraulic diameter:

    1. dilate by ``(target - stroke) / 2`` so the thinnest stroke of the string
       reaches its target (04 stage 1, buildings 2) - one nozzle for an engraved
       groove, a full minimum wall for embossed material, see
       :func:`app.geom.transform.text_stroke_target_mm`.  ``dilation_mm``
       comes from :func:`app.geom.transform.text_dilation_mm`, i.e. from the same
       shared number the preview drew with and the refusal was judged on;
    2. snap onto the 0.01 mm print grid and deburr (:func:`thicken.snap`);
    3. widen what is STILL thinner than a wall - the tapering terminals every
       glyph has - through :func:`thicken.widen_thin_parts`, which is 04's
       dilation rule applied per appendage;
    4. drop anything under ``min_detail ** 2`` (04 stage 1, buildings 3);
    5. measure the survivor with :func:`thicken.narrowest_width`, the Stage 4
       gate's own inscribed-circle measure, so the repair and the gate speak one
       language here exactly as they do for buildings.

    Text is measured in print millimetres rather than ground metres because a
    letter is a printed object: the map scale does not touch its size.
    """
    min_wall = T.min_wall_mm(params) if target_mm is None else float(target_mm)
    min_detail = T.min_detail_mm(params)
    area_floor = text_area_floor(params)
    out = TextRepair()
    narrowest = math.inf
    grown: list[Polygon] = []
    for poly in polys:
        out.counters_before += len(poly.interiors)
        grown.extend(thicken.valid_polygons(dilate_glyph(poly, dilation_mm)))
    cores = counter_cores(grown, params)
    protect = shapely.union_all(cores) if cores else None
    for poly in thicken.snap(grown, grid_mm):
        repaired = poly
        if thicken.thin_parts(repaired, min_wall, area_floor):
            repaired = thicken.widen_thin_parts(repaired, min_wall, area_floor)
            out.widened += 1
        if protect is not None:
            repaired = shapely.union_all(thicken.valid_polygons(repaired.difference(protect)))
        parts = [
            p
            for p in thicken.regrid_layer(thicken.valid_polygons(repaired), grid_mm)
            if p.area >= min_detail * min_detail
        ]
        if not parts:
            out.dropped += 1
            continue
        for part in parts:
            out.counters_after += len(part.interiors)
            narrowest = min(narrowest, thicken.narrowest_width(part, min_wall, area_floor))
            out.polygons.append(part)
    out.narrowest_mm = 0.0 if not math.isfinite(narrowest) else narrowest
    counters = counter_widths_mm(out.polygons, params)
    out.narrowest_counter_mm = min(counters) if counters else 0.0
    return out


def merge_stroke_ridges(
    strokes: Sequence[Polygon],
    domain: Polygon,
    params: T.ParamsLike,
    grid_mm: float = thicken.PRINT_GRID_MM,
) -> list[Polygon]:
    """The complement-ridge rule, applied to engraved text.

    What prints between two engraved strokes is a ridge of lip, and a ridge the
    nozzle cannot lay down at all has to be swallowed by the groove beside it -
    exactly what :func:`app.geom.thicken.merge_recess_ridges` does for two
    engraved roads that run too close together.  It is called here with the same
    machinery and one substitution: the ridge floor is ``min_detail`` (ONE
    nozzle) instead of ``min_wall`` (two).

    Why the substitution is not a weakening: the gap between two adjacent
    letters of a 5 mm face is about a tenth of an em, i.e. half a millimetre, so
    a full-wall floor at a 0.4 mm nozzle would merge every pair of letters in
    every string at every size the 6 mm lip can hold - it would not print
    better text, it would print an unreadable smear.  A ridge under one nozzle
    is different in kind: the printer cannot resolve the two grooves at all, so
    the ridge is not material that fails to be laid down, it is material that
    was never going to appear.  The Stage 4 ``lettering`` validator measures the
    ridges that survive and reports them, so nothing here is unmeasured.
    """
    if not strokes:
        return []
    detail = T.min_detail_mm(params)
    thresholds = T.Thresholds(min_wall=detail, min_gap=detail, min_detail=detail)
    layer = thicken.AreaLayer(polygons=list(strokes))
    thicken.merge_recess_ridges(
        layer, [layer], thresholds, crop=domain, grid=grid_mm, domain=domain
    )
    return layer.polygons


# --------------------------------------------------------------------------
# Ornaments
# --------------------------------------------------------------------------


#: Re-exported from the shared layout math so the arrow's proportions are one
#: number, not two.
NORTH_ARROW_WIDTH_RATIO = T.NORTH_ARROW_WIDTH_RATIO
NORTH_ARROW_NOTCH_RATIO = T.NORTH_ARROW_NOTCH_RATIO


def north_arrow_polygon(size_mm: float) -> Polygon:
    """The north arrow, in its local frame: +y is north, centred on the origin.

    Two triangles sharing the axis - tip, right base, notch, left base - which
    is the classic compass arrowhead and, as one concave quadrilateral, is
    literally two triangles.  It is cut, not raised: a 4 mm spike standing
    0.4 mm proud on the corner of a lip is the first thing to snap off, while
    the same shape sunk into the lip cannot.
    """
    length = float(size_mm)
    half_w = NORTH_ARROW_WIDTH_RATIO * length / 2.0
    half_l = length / 2.0
    notch = -half_l + NORTH_ARROW_NOTCH_RATIO * length
    return Polygon(
        [(0.0, half_l), (half_w, -half_l), (0.0, notch), (-half_w, -half_l)]
    )


def scale_bar_rules(layout: "T.ScaleBarLayout") -> list[Polygon]:
    """The bar and its two end ticks, in the bar's local frame.

    Local frame: +x runs along the edge from the bar's left end, +y is up, and
    the origin sits on the band's centre line.  The bar is drawn a full minimum
    wall thick, so unlike the label it needs no dilation at all.
    """
    half_t = layout.thickness_mm / 2.0
    half_tick = layout.tick_mm / 2.0
    out = [shapely.box(0.0, -half_t, layout.bar_mm, half_t)]
    for x in (0.0, layout.bar_mm):
        out.append(shapely.box(x - half_t, -half_tick, x + half_t, half_tick))
    return out


def scale_bar_label_glyphs(layout: "T.ScaleBarLayout") -> list[Polygon]:
    """The bar's label, in the bar's local frame, positioned after the bar.

    It follows the bar by :data:`app.geom.transform.ORNAMENT_GAP_MM` so the two
    share one edge without either being centred on top of the other.  It is
    returned separately from :func:`scale_bar_rules` because it is TEXT: it goes
    through the glyph dilation its own fit asked for, while the bar does not.
    """
    fit = layout.label_fit
    if fit is None or fit.refused or not fit.text:
        return []
    glyphs, _dropped = text_polygons_mm(fit.text, fit.face, fit.size_mm)
    dx = layout.bar_mm + T.ORNAMENT_GAP_MM + fit.dilation_mm
    dy = -(fit.ink_top_mm + fit.ink_bottom_mm) / 2.0
    out: list[Polygon] = []
    for poly in glyphs:
        out.extend(thicken.explode(_scaled(poly, 1.0, dx=dx, dy=dy)))
    return out


def scale_bar_polygons(layout: "T.ScaleBarLayout", params: T.ParamsLike) -> list[Polygon]:
    """The bar, its ticks and its label together, undilated - for tests only.

    The bake repairs the two halves separately (see :func:`scale_bar_rules`);
    this convenience form exists so a test can ask for the whole ornament.
    """
    return scale_bar_rules(layout) + scale_bar_label_glyphs(layout)


def keyhole_polygon(params: T.ParamsLike) -> Polygon:
    """The 8 mm round entry plus its 4 mm slot, in plate mm.

    The slot runs toward the TOP edge of the plate: the screw head goes through
    the round hole and the frame then drops onto the shank, so the slot has to be
    above the hole for the picture to hang level with north up.
    """
    cx, cy = T.keyhole_center_mm(params)
    hole = shapely.Point(cx, cy).buffer(T.KEYHOLE_HOLE_D_MM / 2.0, quad_segs=16)
    slot = shapely.box(
        cx - T.KEYHOLE_SLOT_W_MM / 2.0,
        cy,
        cx + T.KEYHOLE_SLOT_W_MM / 2.0,
        cy + T.KEYHOLE_SLOT_LEN_MM,
    )
    end = shapely.Point(cx, cy + T.KEYHOLE_SLOT_LEN_MM).buffer(
        T.KEYHOLE_SLOT_W_MM / 2.0, quad_segs=16
    )
    merged = shapely.union_all([hole, slot, end])
    parts = thicken.valid_polygons(merged)
    return max(parts, key=lambda p: p.area)


def magnet_polygons(params: T.ParamsLike) -> list[Polygon]:
    """The four 6.1 mm magnet pockets, in plate mm."""
    return [
        shapely.Point(x, y).buffer(T.MAGNET_D_MM / 2.0, quad_segs=16)
        for x, y in T.magnet_centers_mm(params)
    ]


def underside_pocket_polygons(params: T.ParamsLike) -> list[tuple[str, list[Polygon], float]]:
    """``(kind, footprints, depth_mm)`` for every pocket cut into the underside.

    Reconstructed from ``params`` alone - no scene, no tokens - so the Stage 4
    ``base_floor`` validator can rebuild it from a file's sidecar.  The mark is
    represented by the RECTANGLE it is allowed to occupy rather than by its
    letters: the validator asks whether the plate above the pocket is solid, and
    over-covering the pocket only makes that question stricter.
    """
    out: list[tuple[str, list[Polygon], float]] = []
    for kind in T.underside_pockets(params):
        depth = T.underside_pocket_depth_mm(params, kind)
        if kind == "mark":
            half_w = T.underside_mark_available_mm(params) / 2.0
            half_h = T.UNDERSIDE_MARK_SIZE_MM
            if half_w > 0.0:
                out.append((kind, [shapely.box(-half_w, -half_h, half_w, half_h)], depth))
        elif kind == "keyhole":
            out.append((kind, [keyhole_polygon(params)], depth))
        elif kind == "magnets":
            out.append((kind, magnet_polygons(params), depth))
    return out


# --------------------------------------------------------------------------
# Solids
# --------------------------------------------------------------------------


@dataclass
class LetteringGeometry:
    """Everything the assembly has to add to, or take out of, the model."""

    #: Cutters for the frame lip: engraved text, the north arrow, the scale bar.
    cut: list = field(default_factory=list)
    #: Additive solids on the lip's top face: embossed text.
    emboss: list = field(default_factory=list)
    #: Cutters for the base plate, from below: the mark, the keyhole, the magnets.
    underside_cut: list = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    #: One row per piece of text actually cut, for the handoff and the tests.
    measures: list[dict] = field(default_factory=list)

    def __bool__(self) -> bool:
        return bool(self.cut or self.emboss or self.underside_cut)


class BaseTooThinError(ValueError):
    """The underside features would break through the base plate.

    Raised by :func:`build` and re-raised by the pipeline as a ``BakeError``: a
    hole through the picture is not something to warn about and ship.
    """


def _place_polygons(polys: Sequence[Polygon], placement: "T.Placement") -> list[Polygon]:
    out: list[Polygon] = []
    for poly in polys:
        out.extend(
            thicken.explode(
                place(
                    poly,
                    placement.anchor_x,
                    placement.anchor_y,
                    placement.rotation_deg,
                    placement.mirror_x,
                )
            )
        )
    return out


def _band_domain(params: T.ParamsLike, edge: str) -> Polygon:
    """The rectangle of lip an edge's engraving may occupy, in plate mm."""
    cx, cy = T.edge_band_center_mm(params, edge)
    half_len = float(params.plate_mm) / 2.0
    half_band = T.FRAME_WIDTH_MM / 2.0
    if edge in ("top", "bottom"):
        return shapely.box(cx - half_len, cy - half_band, cx + half_len, cy + half_band)
    return shapely.box(cx - half_band, cy - half_len, cx + half_band, cy + half_len)


def _clip(polys: Sequence[Polygon], keep: Polygon | None) -> list[Polygon]:
    """Keep only the part of the ink that lies inside ``keep``."""
    if keep is None:
        return list(polys)
    out: list[Polygon] = []
    for poly in polys:
        out.extend(thicken.valid_polygons(poly.intersection(keep)))
    return out


def _frame_ring_polygon(params: T.ParamsLike):
    """The lip's own footprint, in plate mm."""
    frame = T.frame_geometry_mm(params)
    outer = shapely.box(
        -frame.outer_half_mm, -frame.outer_half_mm, frame.outer_half_mm, frame.outer_half_mm
    )
    inner = shapely.box(
        -frame.inner_half_mm, -frame.inner_half_mm, frame.inner_half_mm, frame.inner_half_mm
    )
    return outer.difference(inner)


def lip_keep_region(params: T.ParamsLike) -> Polygon:
    """Where ink may land on the lip: the band inset by the text margin.

    Everything placed on the lip - engraved text, embossed text, the arrow, the
    scale bar - is clipped to this ring, which is what guarantees the RIM between
    the ink and each edge of the lip is exactly the margin and never a hairline.
    The layout already sizes the text to fit inside it; the clip exists because
    the appendage pass can grow a terminal by up to half a wall AFTER the size
    was chosen, and a fifth of a millimetre of overshoot at the band edge leaves
    a sliver of lip no nozzle can lay down.  It only ever trims such an
    overshoot: the string itself is never cut short, which is what the auto-fit
    is for.
    """
    margin = T.lip_text_margin_mm(params)
    ring = _frame_ring_polygon(params)
    inset = shapely.buffer(ring, -margin, join_style="mitre", quad_segs=1, mitre_limit=2.0)
    parts = thicken.valid_polygons(inset)
    if not parts:
        return ring
    return parts[0] if len(parts) == 1 else shapely.union_all(parts)


def build(
    params: T.ParamsLike,
    ctx: "TOK.TokenContext",
    rotation_deg: float = 0.0,
    layout: "T.LetteringLayout | None" = None,
) -> LetteringGeometry:
    """Every engraving and ornament, as manifold3d solids in print millimetres.

    The layout comes from :func:`app.geom.transform.lettering_layout` - the
    shared function the preview draws from - so this routine never decides where
    anything goes; it only cuts it.  Each piece goes through the same sequence:

    1. glyph outlines at the fitted size;
    2. 04 stage 1 (:func:`repair_text`): dilate to a full minimum wall, snap,
       widen the terminals, protect the counters, drop the unprintable;
    3. place it on the plate and clip it to :func:`lip_keep_region`;
    4. for engraved text, hand the sub-nozzle ridges between the strokes to the
       strokes (:func:`merge_stroke_ridges`) and re-widen whatever neck the
       bridge leaves in the groove;
    5. MEASURE the finished geometry - the narrowest stroke against
       ``0.9 * min_wall`` and the narrowest counter against ``0.9 * min_detail``,
       which are the Stage 4 ``lettering`` validator's own thresholds - and cut
       nothing at all if it does not hold.

    Step 5 is why a refusal can appear here as well as in the shared layout math:
    that math PREDICTS printability from per-glyph measurements and is what the
    preview draws, while this is the real geometry.  A refusal is always safe;
    shipping a letter the gate would fail is not.
    """
    from app.geom import extrude  # local: extrude imports thicken, not lettering

    out = LetteringGeometry()
    # `layout` is an injection point for the tests: the shipped bug was a layout
    # that said an engraving was printable while the frame was off, and the only
    # way to assert the guard here is to hand it exactly that (v2-03, finding 2).
    layout = layout if layout is not None else T.lettering_layout(params, ctx, rotation_deg)
    out.warnings.extend(layout.warnings)

    base_needed = T.underside_min_base_mm(params)
    if base_needed > 0.0 and float(params.base_thickness_mm) + 1e-9 < base_needed:
        raise BaseTooThinError(
            f"the underside features need a base of at least {base_needed:g} mm "
            f"(this one is {float(params.base_thickness_mm):g} mm): the "
            + " and ".join(T.underside_pockets(params))
            + " would break through the plate"
        )

    lip_top = T.base_top_mm(params) + T.FRAME_LIP_MM
    separation = thicken.LAYER_SEPARATION_MM
    grid = thicken.PRINT_GRID_MM
    min_wall = T.min_wall_mm(params)
    min_detail = T.min_detail_mm(params)
    area_floor = text_area_floor(params)
    ridge_fail = thicken.MIN_WALL_FAIL_FACTOR * min_detail
    keep = lip_keep_region(params) if bool(params.frame) else None

    def widen_necks(polys: Sequence[Polygon], target: float) -> list[Polygon]:
        """Re-apply 04's appendage rule after the ridge merge.

        Bridging a sub-nozzle ridge joins two grooves through a channel as narrow
        as that ridge was; the channel is a stroke like any other and has to
        reach a full wall.
        """
        fixed: list[Polygon] = []
        for poly in polys:
            if thicken.thin_parts(poly, target, area_floor):
                poly = thicken.widen_thin_parts(poly, target, area_floor)
            fixed.extend(thicken.valid_polygons(poly))
        return thicken.regrid_layer(fixed, grid)

    def narrowest_of(polys: Sequence[Polygon], target: float) -> float:
        return min(thicken.narrowest_width(p, target, area_floor) for p in polys)

    def remedy(search: "Callable[[], tuple[float | None, float]] | None", fallback: float) -> str:
        """The tail of a refusal: a size that WORKS, measured, or why there is none.

        The old tail was "try a larger size, a plainer face or a finer nozzle" -
        no number - and the counter branch named ``fit.min_size_mm``, a size the
        layout had already judged acceptable and the geometry had just refused.
        Both left the user with nothing to do (v2-03 audit, finding 4).
        """
        if search is None:
            return (
                f"it needs about {max(fallback, 0.0):.2f} mm, a plainer face or a "
                f"finer nozzle"
            )
        found, searched_to = search()
        if found is None:
            return (
                f"no size up to {searched_to:.2f} mm cuts this string in this face "
                f"at a {float(params.nozzle_mm):g} mm nozzle; try a plainer face, a "
                f"shorter string or a finer nozzle"
            )
        return f"it prints at {found:.2f} mm; try that size, a plainer face or a finer nozzle"

    def narrowest_gap_mm(polys: Sequence[Polygon], domain: Polygon) -> float | None:
        """The narrowest void between raised pieces inside ``domain``, print mm.

        Stage 4's own reading of an embossed band (:func:`app.validate.checks.
        check_lettering`: the band less the material, every part measured with
        :func:`thicken.narrowest_width` at the one-nozzle floor), taken here on
        the pieces before they are extruded.  Engraved text never needs it:
        :func:`merge_stroke_ridges` hands a sub-nozzle ridge to the groove
        before anything is measured.  Embossed text has no such merge yet
        ([V3.1-P2-5]), so a pair of letters that come within a nozzle of each
        other leave a slit the printer cannot lay down and the gate fails; this
        is what lets the refusal below see that slit first.
        """
        material = shapely.union_all(list(polys))
        if material.is_empty:
            return None
        widths = [
            thicken.narrowest_width(void, min_detail, area_floor)
            for void in thicken.explode(domain.difference(material))
            if void.area >= area_floor
        ]
        return min(widths) if widths else None

    def verify(
        polys: Sequence[Polygon],
        what: str,
        min_size_mm: float,
        target: float,
        search: "Callable[[], float | None] | None" = None,
        gap_domain: Polygon | None = None,
    ) -> bool:
        """Measure the finished geometry; warn and refuse if it does not hold.

        ``polys`` is the cutter as it will be applied, separation included,
        because that is the geometry Stage 4's ``lettering`` row slices out of
        the finished mesh.  The two agree to the last hundredth: serif
        ``1:10,714`` at 3.5 mm measures 0.303 mm here and 0.303 mm at z=4.80 in
        the mesh, against a 0.360 mm minimum.  (It measures 0.412 mm before the
        0.02 mm separation offset, which is why that copy is not the one
        judged - shipping on it turns a refused string into a failed bake.)

        ``search``, when given, is called only on the refusal path and returns a
        size that really does measure clean, so the warning can name one.

        ``gap_domain`` is given for EMBOSSED text: the band the pieces stand in,
        so the void between two raised letters is judged by the same one-nozzle
        floor the gate applies to it (``ridge_fail``).  An engraved line's
        ridges were merged before this point and need no such check.
        """
        if not polys:
            return False
        stroke_fail = thicken.MIN_WALL_FAIL_FACTOR * target
        narrowest = narrowest_of(polys, target)
        counters = counter_widths_mm(polys, params)
        narrowest_counter = min(counters) if counters else None
        if narrowest < stroke_fail:
            out.warnings.append(
                f"the {what} was not cut: after the minimum-feature repair its "
                f"narrowest stroke measured {narrowest:.2f} mm against the "
                f"{stroke_fail:.2f} mm minimum; " + remedy(search, min_size_mm)
            )
            return False
        if narrowest_counter is not None and narrowest_counter < ridge_fail:
            out.warnings.append(
                f"the {what} was not cut: widening it to a full minimum wall left a "
                f"counter {narrowest_counter:.2f} mm wide, under the {ridge_fail:.2f} mm "
                f"a {float(params.nozzle_mm):g} mm nozzle can hold; "
                + remedy(search, min_size_mm)
            )
            return False
        if gap_domain is not None:
            gap = narrowest_gap_mm(polys, gap_domain)
            if gap is not None and gap < ridge_fail:
                out.warnings.append(
                    f"the {what} was not cut: two of its raised letters come within "
                    f"{gap:.2f} mm of each other, under the {ridge_fail:.2f} mm a "
                    f"{float(params.nozzle_mm):g} mm nozzle can leave between them; "
                    + remedy(search, min_size_mm)
                )
                return False
        return True

    probed: dict[tuple[int, float], bool] = {}

    def engraving_measures_clean(index: int, size_mm: float) -> bool:
        """Cached by (engraving, size): the auto-fit clamps a range of requested
        sizes onto the same fitted one, and each probe is a full repair."""
        key = (index, round(float(size_mm), 3))
        hit = probed.get(key)
        if hit is None:
            hit = _engraving_measures_clean(index, size_mm)
            probed[key] = hit
        return hit

    def _engraving_measures_clean(index: int, size_mm: float) -> bool:
        """Would engraving ``index`` cut cleanly if the user asked for ``size_mm``?

        The whole layout is re-run at the candidate size - not just the glyph
        outlines - so the answer is about a size a user can actually type: the
        auto-fit, the dilation, the placement and the clip are all the ones that
        size would really get.
        """
        trial = _params_with_size(params, index, size_mm)
        if trial is None:
            return False
        try:
            layout2 = T.lettering_layout(trial, ctx, rotation_deg)
        except Exception:  # pragma: no cover - a malformed candidate
            return False
        if index >= len(layout2.engravings):
            return False
        placed = layout2.engravings[index]
        fit2 = placed.fit
        if fit2.refused or not fit2.text:
            return False
        target2 = T.text_stroke_target_mm(trial, placed.mode)
        glyphs2, _ = text_polygons_mm(fit2.text, fit2.face, fit2.size_mm)
        repair2 = repair_text(glyphs2, params, dilation_mm=fit2.dilation_mm, target_mm=target2)
        if repair2.lost_counters:
            return False
        polys2 = _clip(_place_polygons(repair2.polygons, placed.placement), keep)
        if placed.mode == "engrave" and polys2:
            polys2 = _clip(
                widen_necks(
                    merge_stroke_ridges(
                        polys2, _band_domain(params, placed.edge), params, grid
                    ),
                    target2,
                ),
                keep,
            )
            # the same separation the real cutter gets, so a size named here is
            # a size that survives Stage 4 and not merely this measurement
            polys2 = separated(polys2)
        if not polys2:
            return False
        if narrowest_of(polys2, target2) < thicken.MIN_WALL_FAIL_FACTOR * target2:
            return False
        counters2 = counter_widths_mm(polys2, params)
        if counters2 and min(counters2) < ridge_fail:
            return False
        if placed.mode == "emboss":
            gap2 = narrowest_gap_mm(polys2, _band_domain(params, placed.edge))
            if gap2 is not None and gap2 < ridge_fail:
                return False
        return True

    def smallest_working_size(index: int, from_mm: float) -> "tuple[float | None, float]":
        """The smallest size above ``from_mm`` whose geometry measures clean.

        Returns ``(size or None, the largest size actually tried)`` so the
        warning can say "no size up to 6.50 mm works" and mean it, rather than
        quoting a ceiling the budget never reached.

        A coarse ladder and then one refining pass, because printability is NOT
        monotonic in the size - the repair widens different terminals at
        different sizes and the ridge merge bridges different pairs, so a plain
        bisection can step over the answer.  Only ever run on the refusal path,
        and capped at ``TEXT_SEARCH_STEPS`` measurements.
        """
        fine = TEXT_SEARCH_FINE_MM
        base = max(from_mm, 0.0)
        found: float | None = None
        searched_to = base
        for offset in TEXT_SEARCH_LADDER_MM:
            size = round(base + offset, 3)
            if size > TEXT_SEARCH_MAX_MM + 1e-9:
                break
            searched_to = size
            if engraving_measures_clean(index, size):
                found = size
                break
        if found is None:
            return None, searched_to
        # Walk back down from the size that worked, so the number in the warning
        # is the smallest measured one within a ladder step of it.  The ladder
        # widens as it climbs, so this pass is what keeps the answer tight.
        for _ in range(TEXT_SEARCH_REFINE_STEPS):
            probe = round(found - fine, 3)
            if probe <= base or not engraving_measures_clean(index, probe):
                break
            found = probe
        return found, searched_to

    def record(
        what: str,
        mode: str,
        size_mm: float,
        polys: Sequence[Polygon],
        repair: TextRepair,
        target: float,
    ) -> None:
        counters = counter_widths_mm(polys, params)
        out.measures.append(
            {
                "what": what,
                "mode": mode,
                "size_mm": size_mm,
                "target_mm": target,
                "narrowest_mm": narrowest_of(polys, target),
                "narrowest_counter_mm": min(counters) if counters else 0.0,
                "widened": repair.widened,
                "dropped": repair.dropped,
                "counters": len(counters),
            }
        )

    def separated(polys: Sequence[Polygon]) -> list[Polygon]:
        """Grow a cutter so it cannot share a face with what it cuts.

        This is :func:`app.geom.thicken.separate`'s job and its distance, with
        ROUND joins instead of mitre ones.  A mitre offset of a glyph outline
        puts a spike on every vertex of every curve, capped at the mitre limit
        but still a few hundredths of a millimetre long, and 30 such spikes
        around the bowl of an ``o`` turn a smooth 0.85 mm counter into a jagged
        one whose narrowest reading is 0.2 mm - a Stage 4 failure invented
        entirely by the offset.  Round joins reproduce the curve.
        """
        merged = shapely.union_all(list(polys))
        if merged.is_empty or separation <= 0.0:
            return list(polys)
        return thicken.valid_polygons(
            shapely.buffer(merged, separation, quad_segs=4, join_style="round")
        )

    def engrave_solid(polys: Sequence[Polygon], depth_mm: float):
        return extrude.extrude_polygons(
            list(polys),
            lip_top - depth_mm,
            lip_top + extrude.SUBTRACT_OVERSHOOT_MM,
        )

    # ---- edge engravings ------------------------------------------------
    # Nothing that lives on the lip is built when there is no lip.  The shared
    # layout math already refuses every one of them (and disables the arrow and
    # the bar), so this is the belt to that braces: an emboss with no lip under
    # it is a floating island, and it shipped once.
    on_the_lip = bool(params.frame)
    for engraving in layout.engravings:
        fit = engraving.fit
        if not on_the_lip or fit.refused or not fit.text:
            continue
        what = f"{engraving.edge} engraving"
        target = T.text_stroke_target_mm(params, engraving.mode)
        glyphs, _dropped = text_polygons_mm(fit.text, fit.face, fit.size_mm)
        repair = repair_text(
            glyphs, params, dilation_mm=fit.dilation_mm, target_mm=target
        )
        if repair.lost_counters:
            out.warnings.append(
                f"the {what} was not cut: widening it to a full minimum wall closed "
                f"{repair.lost_counters} counter(s); "
                + remedy(
                    lambda i=engraving.index: smallest_working_size(i, fit.size_mm),
                    fit.min_size_mm,
                )
            )
            continue
        polys = _clip(_place_polygons(repair.polygons, engraving.placement), keep)
        if engraving.mode == "engrave" and polys:
            polys = _clip(
                widen_necks(
                    merge_stroke_ridges(
                        polys, _band_domain(params, engraving.edge), params, grid
                    ),
                    target,
                ),
                keep,
            )
            # Separate BEFORE measuring: the cutter that grows here is the
            # geometry the Stage 4 validator will slice, so it is the geometry
            # this refusal has to judge.  Measured on the pre-separation copy
            # instead, serif "1:10,714" at 3.5 mm reads 0.412 mm and ships - and
            # then Stage 4's `lettering` row measures the groove it really cut
            # at 0.303 mm and the whole bake fails.  A refusal costs the user
            # one string; a failed bake costs them the model.
            polys = separated(polys)
        if not verify(
            polys,
            what,
            fit.min_size_mm,
            target,
            search=lambda i=engraving.index: smallest_working_size(i, fit.size_mm),
            gap_domain=_band_domain(params, engraving.edge) if engraving.mode == "emboss" else None,
        ):
            continue
        if engraving.mode == "emboss":
            solid = extrude.extrude_polygons(
                polys, lip_top - T.BUILDING_OVERLAP_MM, lip_top + engraving.depth_mm
            )
            if solid is not None:
                out.emboss.append(solid)
        else:
            solid = engrave_solid(polys, engraving.depth_mm)
            if solid is not None:
                out.cut.append(solid)
        record(
            f"engraving {engraving.index + 1} ({engraving.edge})",
            engraving.mode,
            fit.size_mm,
            polys,
            repair,
            target,
        )

    # ---- north arrow ----------------------------------------------------
    arrow = layout.north_arrow
    if arrow.enabled and on_the_lip:
        target = T.text_stroke_target_mm(params, "engrave")
        repair = repair_text(
            [north_arrow_polygon(arrow.size_mm)], params, target_mm=target
        )
        polys = _clip(_place_polygons(repair.polygons, arrow.placement), keep)
        polys = separated(polys) if polys else polys
        if polys and verify(polys, "north arrow", arrow.size_mm, target):
            solid = engrave_solid(polys, T.ENGRAVE_MAX_MM)
            if solid is not None:
                out.cut.append(solid)
                record("north arrow", "engrave", arrow.size_mm, polys, repair, target)

    # ---- scale bar ------------------------------------------------------
    bar = layout.scale_bar
    if bar.enabled and on_the_lip and bar.bar_mm > 0.0:
        # The rules are already a full wall thick; the label is text and takes
        # the dilation its own fit asked for.  Repairing them together would
        # either fatten the bar or leave the label to the appendage pass alone.
        target = T.text_stroke_target_mm(params, "engrave")
        repair = repair_text(scale_bar_rules(bar), params, target_mm=target)
        label_dilation = 0.0 if bar.label_fit is None else bar.label_fit.dilation_mm
        label = repair_text(
            scale_bar_label_glyphs(bar),
            params,
            dilation_mm=label_dilation,
            target_mm=target,
        )
        repair.polygons.extend(label.polygons)
        repair.widened += label.widened
        repair.dropped += label.dropped
        polys = _clip(_place_polygons(repair.polygons, bar.placement), keep)
        if polys:
            polys = _clip(
                widen_necks(
                    merge_stroke_ridges(
                        polys, _band_domain(params, bar.edge), params, grid
                    ),
                    target,
                ),
                keep,
            )
            polys = separated(polys)
        if polys and verify(polys, "scale bar", bar.thickness_mm, target):
            solid = engrave_solid(polys, T.ENGRAVE_MAX_MM)
            if solid is not None:
                out.cut.append(solid)
                record(
                    f"scale bar ({bar.label})",
                    "engrave",
                    bar.thickness_mm,
                    polys,
                    repair,
                    target,
                )

    # ---- underside mark -------------------------------------------------
    mark = layout.underside_mark
    if mark.enabled and mark.fit is not None and not mark.fit.refused and mark.fit.text:
        target = T.text_stroke_target_mm(params, "engrave")
        glyphs, _dropped = text_polygons_mm(mark.fit.text, mark.fit.face, mark.fit.size_mm)
        repair = repair_text(
            glyphs, params, dilation_mm=mark.fit.dilation_mm, target_mm=target
        )
        polys = _place_polygons(repair.polygons, mark.placement)
        if repair.lost_counters:
            out.warnings.append(
                f"the underside mark was not cut: widening it to a full minimum wall "
                f"closed {repair.lost_counters} counter(s); it needs about "
                f"{mark.fit.min_size_mm:.2f} mm"
            )
        else:
            polys = separated(polys) if polys else polys
        if polys and not repair.lost_counters and verify(
            polys, "underside mark", mark.fit.min_size_mm, target
        ):
            solid = extrude.extrude_polygons(
                polys,
                -extrude.SUBTRACT_OVERSHOOT_MM,
                mark.depth_mm,
            )
            if solid is not None:
                out.underside_cut.append(solid)
                record(
                    "underside mark", "engrave", mark.fit.size_mm, polys, repair, target
                )

    # ---- hanger ---------------------------------------------------------
    hanger = str(getattr(params, "hanger", None) or "none")
    if hanger == "keyhole":
        solid = extrude.extrude_polygons(
            [keyhole_polygon(params)], -extrude.SUBTRACT_OVERSHOOT_MM, T.KEYHOLE_DEPTH_MM
        )
        if solid is not None:
            out.underside_cut.append(solid)
    elif hanger == "magnets":
        solid = extrude.extrude_polygons(
            magnet_polygons(params), -extrude.SUBTRACT_OVERSHOOT_MM, T.MAGNET_DEPTH_MM
        )
        if solid is not None:
            out.underside_cut.append(solid)

    return out
