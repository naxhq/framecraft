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
    "building_solids",
    "slab",
    "tree_cone",
    "tree_solids",
]

#: How far a subtractive slab (engraved roads, recessed water) reaches above the
#: base top, in mm.  It has to clear every additive surface feature (green
#: +0.3 mm, embossed roads +0.4 mm) so a recess cuts cleanly through them, and
#: it must not reach a building or a tree - Stage 1 already keeps those layers
#: disjoint in XY (DECISIONS [P3]).
SUBTRACT_OVERSHOOT_MM = 0.5


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


def frame_lip(params: T.ParamsLike) -> Manifold | None:
    """04 stage 2.2: the 6 mm border lip rising 2 mm above the base top."""
    frame = T.frame_geometry_mm(params)
    if not frame.enabled:
        return None
    ring = box(
        -frame.outer_half_mm, -frame.outer_half_mm, frame.outer_half_mm, frame.outer_half_mm
    ).difference(
        box(
            -frame.inner_half_mm, -frame.inner_half_mm, frame.inner_half_mm, frame.inner_half_mm
        )
    )
    return extrude_polygons([ring], frame.bottom_mm, frame.top_mm)


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
    bottom = T.building_bottom_mm(params)
    out: list[Manifold] = []
    for solid in solids:
        top = T.building_top_mm(solid.height, params, scale)
        if solid.stands_on is None:
            z0 = bottom
        else:
            z0 = T.building_top_mm(solid.stands_on, params, scale) - T.BUILDING_OVERLAP_MM
        if top <= z0:
            continue
        piece = extrude_polygons([solid.polygon], z0, top, scale)
        if piece is not None:
            out.append(piece)
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
