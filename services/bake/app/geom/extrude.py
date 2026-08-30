"""Stage 2a of ``04_PRINTABILITY_SPEC.md``: polygons -> ``manifold3d`` solids.

This module is the *only* place where the pipeline crosses from ground metres
(shapely, Stage 1) into print millimetres (manifold3d, Stage 2).  04: "Work in
print millimetres from here on.  Convert once, at the boundary."  The boundary
is :func:`contours_mm`.

Rules:

* Polygons become solids through ``manifold3d.CrossSection`` and
  ``CrossSection.extrude``.  Nothing is ever round-tripped through STL, and no
  trimesh boolean is used anywhere - manifold3d is the boolean engine.
* Exteriors go in counter-clockwise and holes clockwise
  (``FillRule.Positive``).  04's trap list: the opposite winding produces
  inside-out solids that pass a naive volume check.
* Every Z comes from :mod:`app.geom.transform`.
"""
from __future__ import annotations

from typing import Iterable, Sequence

import numpy as np
import shapely
from manifold3d import CrossSection, FillRule, Manifold, OpType
from shapely.geometry import Polygon, box
from shapely.geometry.polygon import orient

from app.geom import transform as T
from app.geom.thicken import TREE_SIDES, BuildingSolid, TreeSite

__all__ = [
    "contours_mm",
    "cross_section",
    "extrude_polygons",
    "base_plate",
    "frame_lip",
    "frame_lip_part",
    "building_solids",
    "slab",
    "recess_floor_mm",
    "inlay_bottom_mm",
    "inlay_slab",
    "inlay_claim",
    "hairline_solid",
    "shadow_polygons",
    "HAIRLINE_MM",
    "recess_pocket",
    "tree_cone",
    "tree_solids",
]

#: How far a subtractive slab (engraved roads, recessed water) reaches above the
#: base top, in mm.  It has to clear every additive surface feature (green
#: +0.3 mm, embossed roads +0.4 mm) so a recess cuts cleanly through them, and
#: it must not reach a building or a tree - Stage 1 already keeps those layers
#: disjoint in XY (DECISIONS [P3]).
SUBTRACT_OVERSHOOT_MM = 0.5

#: Thickness of a colour INLAY, in mm: the slab of water/road colour that sits
#: directly under a recess floor in parts mode, so the recess still prints as a
#: recess but its floor comes out in its own filament.  04 has no rule for this
#: (it has no colour at all); 0.6 mm is three 0.2 mm layers, enough that the
#: floor is opaque in its own colour rather than showing the base through it.
#: The inlay is always strictly inside the base slab: the recess floor is at
#: least ``base_thickness/2`` (:func:`slab` clamps the depth there) and the
#: contract floors the base at 2 mm, so the inlay bottom never drops below
#: 0.4 mm.
PART_INLAY_MM = 0.6

#: Interpenetration between two colour parts, in mm.  Deliberately 04's own
#: building/base overlap: "a deliberate overlap, so the union is unambiguous".
#: Two parts that met on an exactly coincident face would leave the slicer to
#: choose which filament owns it.
PART_OVERLAP_MM = T.BUILDING_OVERLAP_MM


# --------------------------------------------------------------------------
# shapely -> manifold3d
# --------------------------------------------------------------------------


def _ring_mm(coords, scale: float) -> np.ndarray:
    """Ring coordinates in ground metres -> an (N, 2) float64 array in mm."""
    arr = np.asarray(coords, dtype=np.float64)[:-1, :2]  # shapely repeats the first point
    if scale != 1.0:
        arr = arr * scale
    return np.ascontiguousarray(arr)


def contours_mm(polys: Iterable[Polygon], scale: float) -> list[np.ndarray]:
    """Polygons (ground metres) -> manifold contours (print mm), correct winding.

    ``shapely.geometry.polygon.orient(p, 1.0)`` gives a CCW exterior and CW
    holes, which is exactly what ``FillRule.Positive`` expects.
    """
    out: list[np.ndarray] = []
    for poly in polys:
        if poly.is_empty or poly.area <= 0.0:
            continue
        fixed = orient(poly, 1.0)
        out.append(_ring_mm(fixed.exterior.coords, scale))
        for hole in fixed.interiors:
            out.append(_ring_mm(hole.coords, scale))
    return out


def cross_section(polys: Iterable[Polygon], scale: float = 1.0) -> CrossSection | None:
    """A ``CrossSection`` in print millimetres, or None when the input is empty."""
    contours = contours_mm(polys, scale)
    if not contours:
        return None
    section = CrossSection(contours, FillRule.Positive)
    if section.is_empty():
        return None
    return section


def extrude_polygons(
    polys: Iterable[Polygon], z_bottom_mm: float, z_top_mm: float, scale: float = 1.0
) -> Manifold | None:
    """Extrude polygons between two Z planes.  Returns None for empty input."""
    height = float(z_top_mm) - float(z_bottom_mm)
    if height <= 0.0:
        return None
    section = cross_section(polys, scale)
    if section is None:
        return None
    solid = section.extrude(height)
    if z_bottom_mm != 0.0:
        solid = solid.translate((0.0, 0.0, float(z_bottom_mm)))
    return solid


# --------------------------------------------------------------------------
# Base plate and frame
# --------------------------------------------------------------------------


def base_plate(params: T.ParamsLike) -> Manifold:
    """04 stage 2.1: the plate square from z=0 to base_thickness, chamfered.

    The bottom outer edge carries a 45 degree, ``transform.CHAMFER_MM`` chamfer
    to kill elephant foot.  The chamfer is built as a tapered extrusion of the
    inset square (``scale_top`` grows it back to full size over exactly the same
    distance it rises, which is what makes the angle 45 degrees); the plate is
    centred on the origin, so the uniform scale about the origin is exact.
    """
    half = float(params.plate_mm) / 2.0
    thickness = T.base_top_mm(params)
    chamfer = min(T.CHAMFER_MM, thickness / 2.0, half / 2.0)

    upper = Manifold.extrude(
        CrossSection([_square_ring(half)], FillRule.Positive), thickness - chamfer
    ).translate((0.0, 0.0, chamfer))
    if chamfer <= 0.0:
        return upper
    grow = half / (half - chamfer)
    lower = Manifold.extrude(
        CrossSection([_square_ring(half - chamfer)], FillRule.Positive),
        chamfer,
        scale_top=(grow, grow),
    )
    return Manifold.batch_boolean([lower, upper], OpType.Add)


def _square_ring(half: float) -> np.ndarray:
    """A CCW square contour of half-extent ``half``, centred on the origin."""
    return np.array(
        [[-half, -half], [half, -half], [half, half], [-half, half]], dtype=np.float64
    )


def _frame_ring(frame: T.FrameGeometry):
    return box(
        -frame.outer_half_mm, -frame.outer_half_mm, frame.outer_half_mm, frame.outer_half_mm
    ).difference(
        box(
            -frame.inner_half_mm, -frame.inner_half_mm, frame.inner_half_mm, frame.inner_half_mm
        )
    )


def frame_lip(params: T.ParamsLike) -> Manifold | None:
    """04 stage 2.2: the 6 mm border lip rising 2 mm above the base top."""
    frame = T.frame_geometry_mm(params)
    if not frame.enabled:
        return None
    return extrude_polygons([_frame_ring(frame)], frame.bottom_mm, frame.top_mm)


def frame_lip_part(params: T.ParamsLike) -> Manifold | None:
    """The frame lip as a COLOUR PART: the same ring, starting 0.2 mm lower.

    In single mode the lip sits exactly on the base top, which is fine for a
    union.  As a separate part it would meet the base on an exactly coincident
    face, so it reaches ``PART_OVERLAP_MM`` down into the plate instead - the
    same deliberate overlap 04 gives every building.  The extra 0.2 mm is inside
    the base slab (the frame band is over solid plate, and a recess is never
    clipped into that band when the frame is on), so the union of the parts is
    unchanged.
    """
    frame = T.frame_geometry_mm(params)
    if not frame.enabled:
        return None
    return extrude_polygons(
        [_frame_ring(frame)], frame.bottom_mm - PART_OVERLAP_MM, frame.top_mm
    )


# --------------------------------------------------------------------------
# Buildings
# --------------------------------------------------------------------------


def building_solids(
    solids: Sequence[BuildingSolid], params: T.ParamsLike, scale: float
) -> list[Manifold]:
    """04 stage 2.3: one solid per repaired footprint.

    A merged block rises from ``base_top - 0.2`` (the deliberate overlap that
    makes the union with the plate unambiguous).  A preserved tall footprint
    starts at its block's roof, minus the same 0.2 mm overlap so the two solids
    interpenetrate instead of meeting on a coincident face (DECISIONS [P3]);
    the printed shape is identical because the block below is solid.
    """
    return [solid for _s, solid in building_solid_pairs(solids, params, scale)]


def building_solid_pairs(
    solids: Sequence[BuildingSolid], params: T.ParamsLike, scale: float
) -> list[tuple[BuildingSolid, Manifold]]:
    """:func:`building_solids` keeping each footprint next to its solid.

    Parts-mode export needs to know WHICH footprint produced a solid (a hero gets
    its own 3MF object); single mode does not and calls the list form above, so
    its code path is unchanged.
    """
    bottom = T.building_bottom_mm(params)
    out: list[tuple[BuildingSolid, Manifold]] = []
    for solid in solids:
        top = T.building_top_mm_for(solid.height, params, scale, solid.height.is_hero)
        if solid.stands_on is None:
            z0 = bottom
        else:
            z0 = (
                T.building_top_mm_for(
                    solid.stands_on, params, scale, solid.stands_on.is_hero
                )
                - T.BUILDING_OVERLAP_MM
            )
        if top <= z0:
            continue
        piece = extrude_polygons([solid.polygon], z0, top, scale)
        if piece is not None:
            out.append((solid, piece))
    return out


# --------------------------------------------------------------------------
# Surface features
# --------------------------------------------------------------------------


def slab(
    polys: Sequence[Polygon], params: T.ParamsLike, scale: float, offset_mm: float
) -> Manifold | None:
    """04 stage 2.4: a thin slab booleaned into the base top.

    ``offset_mm`` is the signed surface offset from :mod:`app.geom.transform`
    (``+0.4`` embossed roads, ``+0.3`` green, ``-0.5`` water, ``-engrave``).
    Positive offsets produce an additive slab that overlaps 0.2 mm into the
    plate; negative offsets produce a cutter that starts at the recess depth and
    reaches ``SUBTRACT_OVERSHOOT_MM`` above the base top so it also removes any
    raised feature sitting on the same spot.  A recess never reaches z=0: 04
    caps the engrave depth at ``base_thickness/3`` and water at 0.5 mm, and the
    contract floors ``base_thickness_mm`` at 2 mm.
    """
    if not polys or offset_mm == 0.0:
        return None
    top = T.base_top_mm(params)
    if offset_mm > 0.0:
        return extrude_polygons(polys, top - T.BUILDING_OVERLAP_MM, top + offset_mm, scale)
    depth = min(-offset_mm, top * 0.5)
    return extrude_polygons(polys, top - depth, top + SUBTRACT_OVERSHOOT_MM, scale)


# --------------------------------------------------------------------------
# Colour inlays (parts mode only)
#
# A recess is SUBTRACTIVE: in single mode the water and the engraved roads are
# holes in the base, and a hole has no colour of its own.  In parts mode each
# recess gets an INLAY instead - a slab of its own filament filling the volume
# directly below the recess floor, entirely inside what single mode prints as
# base - and the base part is pocketed to make room for it.  The recess stays
# exactly as deep as it was; only the material under its floor changes colour.
#
#   z = base_top          --------+          +--------   base part
#   z = floor                     |__________|           <- recess floor: the
#   z = floor - 0.6       |____________________|            inlay's top face
#   z = floor - 0.4       (the base part resumes here: 0.2 mm of overlap)
#
# --------------------------------------------------------------------------


def recess_floor_mm(params: T.ParamsLike, offset_mm: float) -> float:
    """Z of the floor of a recess, in mm.  Mirrors :func:`slab`'s own clamp."""
    top = T.base_top_mm(params)
    depth = min(-float(offset_mm), top * 0.5)
    return top - depth


def inlay_bottom_mm(params: T.ParamsLike, offset_mm: float) -> float:
    """Z of the bottom of a recess inlay, in mm.  Always above z = 0."""
    return recess_floor_mm(params, offset_mm) - PART_INLAY_MM


def inlay_slab(
    polys: Sequence[Polygon], params: T.ParamsLike, scale: float, offset_mm: float
) -> Manifold | None:
    """The inlay solid for one recess layer, before it is clipped to the plate.

    Grown by ``PART_OVERLAP_MM`` in XY as well as in Z: the inlay's sides meet
    the base inside the plate, so without the lateral growth the two parts would
    share a vertical face along the whole outline of every pond.  The rim is
    buried inside the base part (the base is solid above and beside it there), so
    growing it changes nothing about the union.
    """
    if not polys or offset_mm >= 0.0:
        return None
    grown = shapely.buffer(
        shapely.union_all(list(polys)),
        PART_OVERLAP_MM / scale,
        join_style="mitre",
        quad_segs=2,
        mitre_limit=2.0,
    )
    parts = [p for p in _polygonal(grown)]
    if not parts:
        return None
    return extrude_polygons(
        parts, inlay_bottom_mm(params, offset_mm), recess_floor_mm(params, offset_mm), scale
    )


def inlay_claim(
    polys: Sequence[Polygon], params: T.ParamsLike, scale: float, offset_mm: float
) -> Manifold | None:
    """What one recess inlay claims from every inlay after it in precedence.

    Where two recesses overlap, exactly one part may own the visible floor: two
    parts filling the same volume and presenting the same top face at the same z
    is what leaves the slicer to arbitrate which filament prints the groove
    (v2-02 audit, finding 1 - 398 mm^2 of it on Chicago, wherever a road crosses
    the river).

    The claim is a prism over the winner's footprint that starts
    ``PART_OVERLAP_MM`` above the winner's own underside.  Subtracting it CAPS
    the loser under the winner instead of cutting it away sideways, which is the
    only arrangement that satisfies all three requirements at once:

    * the visible floor has ONE owner - what the loser keeps is entirely buried
      inside the winner and the base;
    * nothing is lost - the union of the parts is still the same set, because
      what the loser keeps is exactly what the base and the winner already
      cover, so this cannot open a hole in the partition;
    * no two parts meet on a coincident FACE.  They interpenetrate by 04's own
      0.2 mm instead, like every other pair in this design.  That is not a
      nicety: cutting the loser away laterally leaves the two inlays sharing a
      vertical face, and re-importing the union of such a mesh through
      manifold3d moved its volume by 0.43 mm^3 and split a body off it - so
      ``make validate`` reported a file the bake had just passed as two
      disconnected bodies.

    The footprint is built from the SAME expression :func:`inlay_slab` grows the
    inlay from, so the winner's own sides and this prism's sides are the same
    contour and the cap can leave no rind between them.
    """
    if not polys:
        return None
    grown = shapely.buffer(
        shapely.union_all(list(polys)),
        (PART_OVERLAP_MM - CLAIM_INSET_MM) / scale,
        join_style="mitre",
        quad_segs=2,
        mitre_limit=2.0,
    )
    parts = _polygonal(grown)
    if not parts:
        return None
    floor = inlay_bottom_mm(params, offset_mm) + PART_OVERLAP_MM
    return extrude_polygons(
        parts, floor, T.base_top_mm(params) + SUBTRACT_OVERSHOOT_MM, scale
    )


#: How far INSIDE the winning inlay's own edge the cap stops, in mm.
#:
#: The cap has to end somewhere, and the loser's material at that edge has to be
#: either buried or absent.  Ending it exactly on the winner's edge leaves the
#: loser a rind wherever the two recess outlines run within a hair of each other
#: - a road along a river bank, which after ``merge_recess_ridges`` they often
#: do - and a 16 um rind is two zero-area triangles in a shipped part.  Ending
#: the cap a twentieth of a millimetre INSIDE buries the step in the winner
#: instead: the loser is simply left uncapped in a 0.05 mm band, continuous with
#: its own material outside it, with no thin feature anywhere.
#:
#: The cost is that both parts reach the recess floor across that 0.05 mm band -
#: an eighth of a nozzle wide, about 10 mm^2 on a Chicago plate against the
#: 398 mm^2 the old cutter-based truncation left doubly owned.
CLAIM_INSET_MM = 0.05

#: Width under which a leftover of an inlay is a HAIRLINE, in mm.  Where two
#: recess footprints run within a hair of each other - a road along a river bank
#: - cutting one inlay out of the other leaves a rind a few micrometres wide.
#: It is real material and it has to go somewhere (the partition is exact), but
#: it must not stay a separate feature of a colour part: nothing under a tenth
#: of a millimetre is a printable ridge, and a mesh that carries one gives the
#: union of the parts zero-area triangles no weld can remove without eating
#: 0.4 mm^3 of the model with them.  Real inlay features are at least
#: ``min_wall + 2 * PART_OVERLAP_MM`` = 1.2 mm wide, twelve times this.
HAIRLINE_MM = 0.1


def shadow_polygons(solid: Manifold) -> list[Polygon]:
    """A solid's plan-view shadow as shapely polygons, in print millimetres."""
    section = solid.project()
    if section.is_empty():
        return []
    out: list[Polygon] = []
    for piece in section.decompose():
        rings = piece.to_polygons()
        shells = [r for r in rings if _signed_area(r) > 0.0]
        holes = [r for r in rings if _signed_area(r) < 0.0]
        if not shells:
            continue
        poly = Polygon(shells[0], holes)
        if not poly.is_valid:
            poly = shapely.make_valid(poly)
        out.extend(_polygonal(poly))
    return out


def _signed_area(ring) -> float:
    x = np.asarray(ring, dtype=np.float64)
    return 0.5 * float(
        np.dot(x[:, 0], np.roll(x[:, 1], -1)) - np.dot(x[:, 1], np.roll(x[:, 0], -1))
    )


def hairline_solid(solid: Manifold | None, width_mm: float = HAIRLINE_MM) -> Manifold | None:
    """The part of ``solid`` that is narrower than ``width_mm`` in plan.

    A 2D morphological opening of the solid's own shadow, in shapely with ROUND
    joins - a true opening.  (manifold3d's own ``CrossSection.offset`` was tried
    first and left seven eighths of a known 16 um rind behind at every join
    type, so the shadow is handed to shapely, which is also what every other
    minimum-feature measurement in this pipeline uses.)  Returns None when
    nothing is that thin.
    """
    if solid is None or solid.is_empty():
        return None
    radius = float(width_mm) / 2.0
    thin: list[Polygon] = []
    for poly in shadow_polygons(solid):
        opened = shapely.buffer(
            shapely.buffer(poly, -radius, quad_segs=4), radius, quad_segs=4
        )
        rest = poly.difference(opened) if not opened.is_empty else poly
        thin.extend(p for p in _polygonal(rest) if p.area > 0.0)
    if not thin:
        return None
    top = solid.bounding_box()[5] + SUBTRACT_OVERSHOOT_MM
    prism = extrude_polygons(thin, -SUBTRACT_OVERSHOOT_MM, top)
    if prism is None:
        return None
    rind = Manifold.batch_boolean([solid, prism], OpType.Intersect)
    return None if rind.is_empty() else rind


def recess_pocket(
    polys: Sequence[Polygon], params: T.ParamsLike, scale: float, offset_mm: float
) -> Manifold | None:
    """The cutter that hollows the BASE part out for an inlay.

    It is :func:`slab`'s subtractive cutter with a deeper bottom: down to
    ``inlay_bottom + PART_OVERLAP_MM`` instead of stopping at the recess floor.
    Everything it removes between the floor and that depth is filled back in by
    :func:`inlay_slab`, with 0.2 mm to spare, so
    ``base_part | inlay == base_solid - single_mode_cutter`` exactly.
    """
    if not polys or offset_mm >= 0.0:
        return None
    return extrude_polygons(
        list(polys),
        inlay_bottom_mm(params, offset_mm) + PART_OVERLAP_MM,
        T.base_top_mm(params) + SUBTRACT_OVERSHOOT_MM,
        scale,
    )


def _polygonal(geom) -> list[Polygon]:
    """Polygonal parts of a shapely geometry (a local ``explode``)."""
    if geom is None or geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    if geom.geom_type in ("MultiPolygon", "GeometryCollection"):
        out: list[Polygon] = []
        for part in geom.geoms:
            out.extend(_polygonal(part))
        return out
    return []


# --------------------------------------------------------------------------
# Trees
# --------------------------------------------------------------------------


def tree_cone(site: TreeSite, params: T.ParamsLike, scale: float) -> Manifold:
    """04 stage 1, trees: an 8-sided cone of height 3x the printed radius."""
    radius = T.tree_radius_mm(site, scale)
    height = T.tree_height_mm(site, scale)
    z0 = T.base_top_mm(params) - T.BUILDING_OVERLAP_MM
    cone = Manifold.cylinder(
        height + T.BUILDING_OVERLAP_MM, radius, 0.0, TREE_SIDES, False
    )
    return cone.translate((site.x_m * scale, site.y_m * scale, z0))


def tree_solids(
    sites: Sequence[TreeSite], params: T.ParamsLike, scale: float
) -> list[Manifold]:
    return [tree_cone(site, params, scale) for site in sites]
