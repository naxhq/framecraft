"""Stage 1 of ``04_PRINTABILITY_SPEC.md``: 2D minimum-feature repair.

Everything in this module works in **ground metres**, on shapely geometry, and
runs *before* any extrusion.  The order of the steps inside each layer is the
order 04 writes them in; do not reorder them.

Every printed dimension and every threshold comes from
:mod:`app.geom.transform` (the module the TypeScript preview mirrors), never
from a number typed in here.  The only constants this file owns are the ones
04 states as pure 2D-repair mechanics: the hole shrink from the trap list, the
buffer resolutions, and the erosion probe that mirrors the Stage 4 min-wall
validator.

Known traps honoured here (04, "Known trap list"):

* ``buffer(0)`` is never used as a validity fix; :func:`valid_polygons` uses
  ``shapely.make_valid``.
* Interior rings get the 1e-6 negative buffer so a hole that touches its own
  exterior cannot produce a non-manifold edge downstream.
* The crop square is inset (``transform.CROP_INSET_MM``) before the final clip
  so no footprint is coincident with the plate edge.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Sequence

import numpy as np
import shapely
from shapely import STRtree
from shapely.geometry import LineString, Polygon, box
from shapely.geometry.base import BaseGeometry

from app.geom import transform as T

__all__ = [
    "HeightSpec",
    "BuildingSolid",
    "BuildingLayer",
    "AreaLayer",
    "TreeSite",
    "RepairedScene",
    "repair_scene",
    "valid_polygons",
    "polygon_from_rings",
    "explode",
    "close_layer",
    "survives_min_wall",
    "inscribed_width",
    "thin_parts",
    "narrowest_width",
    "widen_thin_parts",
    "strip_thin_parts",
    "residue_area_floor",
    "tree_min_radius_mm",
]

# --------------------------------------------------------------------------
# Constants owned by this module (2D repair mechanics only).
# --------------------------------------------------------------------------

#: Trap list: interior rings are shrunk by this much (ground metres) so a hole
#: that touches its own exterior cannot become a zero-width bridge.
HOLE_SHRINK_M = 1e-6

#: Quadrant segments for the road centreline buffer.  A printed road is under a
#: millimetre wide, so 4 segments per quadrant (a 16-gon end cap) is already far
#: below the nozzle; more only inflates the vertex count of a 5 000-way union.
ROAD_QUAD_SEGS = 4

#: Quadrant segments for the closing buffer pairs.  Closing uses mitre joins
#: (``join_style=2``) which are resolution free; this only affects the caps of
#: degenerate inputs.
CLOSE_QUAD_SEGS = 4

#: Mitre limit for the closing buffers, keeping spikes off sharp corners.
CLOSE_MITRE_LIMIT = 2.0

#: Erosion probe factor shared with the Stage 4 ``min_wall`` validator: a region
#: that vanishes under ``buffer(-factor * min_wall)`` is narrower than
#: ``0.9 * min_wall`` everywhere, which is exactly the validator's fail rule.
#: Stage 1 drops such regions so the pipeline and the gate agree by
#: construction (DECISIONS [P3]).
MIN_WALL_PROBE_FACTOR = 0.45

#: 04 stage 4 fails a region under ``0.9 * min_wall``; the erosion probe above is
#: that same number expressed as a radius.  Both the repair and the gate import
#: this one constant so they can never drift apart.
MIN_WALL_FAIL_FACTOR = 2.0 * MIN_WALL_PROBE_FACTOR

#: Stage 1 repairs to a FULL minimum wall, which is what 04 stage 1 asks for
#: ("dilate by (min_wall_ground - w) / 2"); Stage 4 fails only under 0.9 of one.
#: The margin is not cosmetic: the repair works in ground metres on shapely and
#: the gate works in print millimetres on slices of a boolean result, so the
#: same wall is measured twice through a 0.01 mm snap grid, a batched union and
#: a 1%-of-a-wall inscribed-circle tolerance.  Repairing only to the gate's 0.9
#: left regions measuring 0.720 mm against a 0.720 mm threshold, and left every
#: preset with a handful of 0.68-0.71 mm wings.  Repairing to 1.0 leaves none
#: and costs nothing measurable.
MIN_WALL_REPAIR_FACTOR = 1.0

#: Accuracy of :func:`inscribed_width`, as a fraction of ``min_wall``.  GEOS'
#: maximum-inscribed-circle search is a branch and bound: the tolerance is what
#: stops it, so it has to be relative or the same code would be exact-and-slow
#: in print millimetres and coarse in ground metres.  1% of a wall is 0.008 mm
#: at the default nozzle, well under the 0.01 mm print grid.
MIC_TOLERANCE_RATIO = 0.01

#: Mitre limit for the opening that isolates thin appendages.  A high limit
#: keeps a sharp convex corner where it was, so only genuinely narrow limbs -
#: not every acute corner of every OSM footprint - show up as residue.
RESIDUE_MITRE_LIMIT = 10.0

#: Tolerance on the opening/region boundary, as a fraction of a wall.  GEOS'
#: offset curve does not reproduce a long straight edge to the last bit, so
#: ``poly - opening`` comes back with a "rind": a hairline a few micrometres
#: wide running the length of the boundary, whose AREA (0.04 mm^2 over 30 mm of
#: edge) is that of a real wing while its width is that of nothing at all.
#: Growing the opening by this much before the difference removes the rind
#: exactly - it is adjacent to the opening along its whole length - while a real
#: wing, which touches the opening only where it meets the body, loses a
#: fraction of a per cent of its area.  0.02 of a wall is 0.016 mm at the
#: default nozzle, under two cells of the 0.01 mm print grid.
RESIDUE_EDGE_TOLERANCE = 0.02

#: Noise floor for an opening residue part, as a fraction of 04's
#: ``min_detail ** 2``.  The floor exists only to throw away what the mitre
#: opening leaves at a corner - parts of 1e-3 mm^2 and less - while a real wing
#: is 0.2 mm^2 and up.  It cannot be ``min_detail ** 2`` itself: GEOS splits one
#: 4 mm x 0.17 mm wing into two 0.23 mm^2 halves in ground metres and leaves it
#: whole (0.46 mm^2) in print millimetres, so at nozzle 0.5 the full floor made
#: the repair blind to a wing the gate then measured.  A quarter of it still
#: clears the noise by a factor of forty.
RESIDUE_AREA_RATIO = 0.25


def residue_area_floor(min_detail: float) -> float:
    """The area under which an opening residue part is numerical noise."""
    return RESIDUE_AREA_RATIO * float(min_detail) * float(min_detail)

#: How many repair-and-remeasure rounds the appendage passes run.  Repairing a
#: wing exposes a second one where it met the body - widening fills a notch,
#: cutting opens one - so a single pass is never enough, and a pass that ends by
#: repairing has not verified itself.  Every round after the first is free: the
#: loops break as soon as a round finds nothing.  Four cleared every appendage
#: on all six presets at every nozzle.
APPENDAGE_ROUNDS = 4

#: How many extra tenth-of-a-wall dilations :func:`widen_to_min_wall` will try
#: before giving up on a footprint.  Six covers the worst case, a footprint
#: whose inscribed radius starts at zero.
MIN_WALL_WIDEN_ROUNDS = 6

#: Quadrant segments used by the erosion probe.
PROBE_QUAD_SEGS = 4

#: Every Stage 1 layer is snap-rounded onto a grid this fine, expressed in PRINT
#: millimetres and converted to ground metres with the scene's scale.  OSM
#: geometry arrives on a 1 mm *ground* grid (geo-ingest, DECISIONS [P2-fix]),
#: which at 1:10000 is 1e-4 mm of print - fine enough to feed the boolean engine
#: 4-nanometre slivers.  0.01 mm is 1/40 of a 0.4 mm nozzle, i.e. invisible, and
#: it cuts the degenerate-face count of a Chicago bake from 1931 to 69
#: (DECISIONS [P3]).
PRINT_GRID_MM = 0.01

#: Radius of the deburring opening in :func:`snap`, in print-grid cells.  Two
#: cells (0.02 mm) is 1/20 of a nozzle and removes every hairline limb observed
#: across the six presets.
DEBURR_GRID_CELLS = 2.0

#: Area threshold for the collinear-vertex sweep, in squared print-grid cells.
#: A vertex whose removal changes the ring by less than a quarter of a grid
#: cell squared (2.5e-5 mm^2) is not a corner, it is snap-rounding residue.
COLLINEAR_AREA_CELLS = 0.25

#: How far an unprintable base island is grown, in print-grid cells, before it
#: is handed to the recess that swallows it (see :func:`merge_recess_ridges`).
RIDGE_BRIDGE_CELLS = 4.0

#: Layers are separated by this much (print millimetres) where one is
#: differenced out of another, so no two solids meet on an exactly coincident
#: vertical face.  Coincident faces are the single largest source of boolean
#: slivers: the road layer alone contributed ~1800 of them before this.
LAYER_SEPARATION_MM = 0.02

#: 04 stage 1, trees: "model as an 8-sided cone".  The number lives in
#: :mod:`app.geom.transform` because the tree radius floor depends on it and the
#: preview has to apply the same floor; re-exported here because
#: :mod:`app.geom.extrude` builds the cone from it.
TREE_SIDES = T.TREE_SIDES

#: 04 stage 1, buildings 5: a contributing footprint taller than this multiple
#: of the block height is preserved as a separate stacked solid.
STACK_HEIGHT_FACTOR = 1.5

#: 04 stage 1, buildings 5: the block height is this weighted percentile of the
#: contributing heights, weighted by footprint area.
BLOCK_HEIGHT_PERCENTILE = 0.8


# --------------------------------------------------------------------------
# Result types
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class HeightSpec:
    """Duck-types :class:`app.geom.transform.BuildingLike`.

    A merged block is not a SceneGraph building, so it needs its own carrier for
    the two fields the height math reads.  ``is_tall`` is *inherited* from the
    contributing footprint that supplied the percentile height - never
    recomputed, per 02 ("computed once here, not recomputed in two places").

    ``is_hero`` says this solid prints at the HERO multiplier
    (``max(1.0, its class's)``, :func:`app.geom.transform.hero_height_scale`).
    It is False for every v1 solid, so the extruded height of a scene with no
    hero picked is bit-identical to v1's.
    """

    height_m: float
    is_tall: bool
    is_hero: bool = False


@dataclass(frozen=True)
class BuildingSolid:
    """One extrudable building footprint in ground metres.

    ``stands_on`` is ``None`` for a merged block (it rises from the base plate)
    and carries the block's height for a preserved tall footprint stacked on top
    of that block.

    ``hero_id`` is the SceneGraph building id when this solid IS a hero the user
    picked; parts-mode export gives every such solid its own 3MF object and its
    own colour.  ``None`` for everything else.
    """

    polygon: Polygon
    height: HeightSpec
    stands_on: HeightSpec | None = None
    hero_id: str | None = None


@dataclass
class BuildingLayer:
    solids: list[BuildingSolid] = field(default_factory=list)
    union: BaseGeometry | None = None
    widened: int = 0
    dropped_small: int = 0
    dropped_thin: int = 0
    merged_components: int = 0
    stacked: int = 0
    #: Hero ids the user picked that no building in this scene carries.
    hero_unknown: list[str] = field(default_factory=list)
    #: Hero ids whose block is taller than they are, so they cannot be shown as
    #: a solid of their own (they are merged into the block like any footprint).
    hero_buried: list[str] = field(default_factory=list)
    #: Hero ids that had a footprint but survived Stage 1 with no solid at all.
    hero_dropped: list[str] = field(default_factory=list)

    @property
    def blocks(self) -> list[BuildingSolid]:
        return [s for s in self.solids if s.stands_on is None]

    @property
    def stacks(self) -> list[BuildingSolid]:
        return [s for s in self.solids if s.stands_on is not None]

    @property
    def heroes(self) -> list[BuildingSolid]:
        return [s for s in self.solids if s.hero_id is not None]

    def hero_ids(self) -> list[str]:
        """Hero ids that really produced a solid, in first-appearance order."""
        out: list[str] = []
        for solid in self.solids:
            if solid.hero_id is not None and solid.hero_id not in out:
                out.append(solid.hero_id)
        return out


@dataclass
class AreaLayer:
    """Roads, water or green after repair: flat polygons in ground metres."""

    polygons: list[Polygon] = field(default_factory=list)
    dropped_small: int = 0
    dropped_thin: int = 0

    @property
    def union(self) -> BaseGeometry | None:
        if not self.polygons:
            return None
        return shapely.union_all(self.polygons)


@dataclass(frozen=True)
class TreeSite:
    x_m: float
    y_m: float
    radius_m: float


@dataclass
class RepairedScene:
    """Everything Stage 2 needs, all in ground metres."""

    scale: float
    thresholds: T.Thresholds
    crop: Polygon
    buildings: BuildingLayer
    roads: AreaLayer
    water: AreaLayer
    green: AreaLayer
    trees: list[TreeSite] = field(default_factory=list)
    trees_dropped: int = 0
    warnings: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------
# Small shapely helpers
# --------------------------------------------------------------------------


def explode(geom: BaseGeometry | None) -> list[Polygon]:
    """Flatten any geometry into its non-empty polygonal parts."""
    if geom is None or geom.is_empty:
        return []
    gtype = geom.geom_type
    if gtype == "Polygon":
        return [geom] if geom.area > 0.0 else []
    if gtype in ("MultiPolygon", "GeometryCollection"):
        out: list[Polygon] = []
        for part in geom.geoms:
            out.extend(explode(part))
        return out
    return []


def valid_polygons(geom: BaseGeometry | None) -> list[Polygon]:
    """``make_valid`` and keep the polygonal parts.

    04's trap list forbids ``buffer(0)`` as a validity fix, so this is the only
    repair used anywhere in the bake.
    """
    if geom is None or geom.is_empty:
        return []
    if geom.geom_type in ("Polygon", "MultiPolygon") and geom.is_valid:
        return explode(geom)
    return explode(shapely.make_valid(geom))


def polygon_from_rings(
    ring: Sequence[Sequence[float]], holes: Sequence[Sequence[Sequence[float]]]
) -> list[Polygon]:
    """SceneGraph rings -> valid shapely polygons.

    Rings follow the frozen convention (DECISIONS [P1]): the first vertex is not
    repeated, exterior CCW, holes CW.  Holes are shrunk by
    :data:`HOLE_SHRINK_M` and subtracted rather than passed to ``Polygon(shell,
    holes)``, which is what makes a hole that touches (or crosses) its own
    exterior safe to extrude.
    """
    if len(ring) < 3:
        return []
    shells = valid_polygons(Polygon(ring))
    if not shells or not holes:
        return shells

    cut: list[Polygon] = []
    for hole in holes:
        if len(hole) < 3:
            continue
        for part in valid_polygons(Polygon(hole)):
            shrunk = shapely.buffer(part, -HOLE_SHRINK_M, quad_segs=1, join_style="mitre")
            cut.extend(explode(shrunk))
    if not cut:
        return shells

    holes_union = shapely.union_all(cut)
    out: list[Polygon] = []
    for shell in shells:
        out.extend(valid_polygons(shell.difference(holes_union)))
    return out


def close_layer(geom: BaseGeometry, gap: float) -> BaseGeometry:
    """04 stage 1, buildings 4: ``union.buffer(g).buffer(-g)``.

    Mitre joins are used so a convex corner comes back exactly where it started
    instead of being rounded by the dilate/erode pair, and so the closed layer
    does not carry thousands of arc vertices into the boolean engine.
    """
    if gap <= 0.0 or geom.is_empty:
        return geom
    grown = shapely.buffer(
        geom, gap, quad_segs=CLOSE_QUAD_SEGS, join_style="mitre", mitre_limit=CLOSE_MITRE_LIMIT
    )
    shrunk = shapely.buffer(
        grown, -gap, quad_segs=CLOSE_QUAD_SEGS, join_style="mitre", mitre_limit=CLOSE_MITRE_LIMIT
    )
    return shrunk


def survives_min_wall(
    poly: Polygon, min_wall: float, factor: float = MIN_WALL_REPAIR_FACTOR
) -> bool:
    """True when Stage 1 may keep this region: it is wide enough somewhere.

    The measure is the Stage 4 validator's own - the widest disc that fits
    inside the region - so the repair and the gate speak one language; only the
    factor differs (:data:`MIN_WALL_REPAIR_FACTOR` here, the gate's 0.9 there),
    which is the margin that survives the ground-metres-to-print-millimetres
    round trip.  The old ``buffer(-0.45 * min_wall).is_empty`` form of the same
    question disagrees with the inscribed circle by a per-cent or so on a jagged
    boundary - GEOS' offset curve is an approximation where the inscribed circle
    is exact - and that was enough to let Stage 1 keep an island the gate failed.
    """
    if min_wall <= 0.0:
        return True
    return inscribed_width(poly, min_wall * MIC_TOLERANCE_RATIO) >= factor * min_wall


# --------------------------------------------------------------------------
# Width, measured per appendage rather than per region
# --------------------------------------------------------------------------


def inscribed_width(poly: Polygon, tolerance: float) -> float:
    """Width of the region: ``2 * maximum_inscribed_circle`` radius.

    This is the one width measure the repair and the Stage 4 gate both use.  It
    is a true geometric width (the largest disc that fits), it is robust to the
    near-collinear vertices ``Manifold.slice`` puts on an outline at a
    triangulation T-junction - where a GEOS negative buffer of the *same*
    triangle comes back empty - and unlike the hydraulic diameter
    ``4 * area / perimeter`` it cannot be dragged under the threshold by a
    jagged boundary.
    """
    if poly is None or poly.is_empty or poly.area <= 0.0:
        return 0.0
    try:
        radius = shapely.maximum_inscribed_circle(poly, float(tolerance))
    except Exception:  # pragma: no cover - GEOS refuses only degenerate input
        return 0.0
    return 2.0 * float(radius.length)


def _opening(poly: Polygon, radius: float) -> BaseGeometry | None:
    """Morphological opening at ``radius``, clipped back to ``poly``.

    None means nothing at all survives the erosion, i.e. the whole region is
    narrower than ``2 * radius`` everywhere.
    """
    eroded = shapely.buffer(
        poly,
        -radius,
        quad_segs=PROBE_QUAD_SEGS,
        join_style="mitre",
        mitre_limit=RESIDUE_MITRE_LIMIT,
    )
    if eroded.is_empty:
        return None
    grown = shapely.buffer(
        eroded,
        radius,
        quad_segs=PROBE_QUAD_SEGS,
        join_style="mitre",
        mitre_limit=RESIDUE_MITRE_LIMIT,
    )
    try:
        return grown.intersection(poly)
    except Exception:  # pragma: no cover - GEOS repairs this itself in practice
        return shapely.make_valid(grown).intersection(shapely.make_valid(poly))


def _residue(poly: Polygon, min_wall: float, area_floor: float) -> list[Polygon]:
    """Parts of ``poly`` the opening at ``0.45 * min_wall`` cannot reach.

    "Does ``buffer(-0.45 * min_wall)`` leave anything?" answers a question about
    the *region*: a 0.5 mm wing hanging off a 40 mm block passes it, because the
    block survives.  The opening residue is that wing on its own, so it can be
    measured (and repaired) on its own.  Parts under ``min_detail ** 2`` of area
    are 04 stage 1's own noise floor and are ignored.
    """
    opened = _opening(poly, MIN_WALL_PROBE_FACTOR * min_wall)
    if opened is None:
        return [poly]
    tolerated = shapely.buffer(
        opened,
        RESIDUE_EDGE_TOLERANCE * min_wall,
        quad_segs=2,
        join_style="mitre",
        mitre_limit=2.0,
    )
    try:
        residue = poly.difference(tolerated)
    except Exception:  # pragma: no cover
        residue = shapely.make_valid(poly).difference(shapely.make_valid(tolerated))
    return [p for p in valid_polygons(residue) if p.area >= area_floor]


def thin_parts(
    poly: Polygon,
    min_wall: float,
    area_floor: float,
    factor: float = MIN_WALL_REPAIR_FACTOR,
) -> list[Polygon]:
    """Appendages of ``poly`` that are themselves too narrow to print.

    ``factor`` is :data:`MIN_WALL_REPAIR_FACTOR` for the Stage 1 repair, so a
    wing is widened or cut a little before the Stage 4 gate would fail it.
    """
    if min_wall <= 0.0 or poly.is_empty or poly.area <= 0.0:
        return []
    tolerance = min_wall * MIC_TOLERANCE_RATIO
    fail_at = factor * min_wall
    return [
        part
        for part in _residue(poly, min_wall, area_floor)
        if inscribed_width(part, tolerance) < fail_at
    ]


def narrowest_width(poly: Polygon, min_wall: float, area_floor: float) -> float:
    """The narrowest printable width anywhere in ``poly``.

    The region's own inscribed width, lowered by the inscribed width of every
    appendage the opening leaves behind.  This is what the Stage 4 ``min_wall``
    validator reports, so ``BakeStats.min_wall_mm`` really is the narrowest wall
    in the model and not merely the widest disc that fits somewhere in it.
    """
    if poly.is_empty or poly.area <= 0.0:
        return 0.0
    tolerance = min_wall * MIC_TOLERANCE_RATIO if min_wall > 0.0 else 0.0
    width = inscribed_width(poly, tolerance)
    if min_wall <= 0.0:
        return width
    for part in _residue(poly, min_wall, area_floor):
        width = min(width, inscribed_width(part, tolerance))
    return width


def widen_thin_parts(
    poly: Polygon, min_wall: float, area_floor: float, rounds: int = APPENDAGE_ROUNDS
) -> Polygon:
    """04's dilation rule applied to the *appendage* instead of the footprint.

    Each wing narrower than the minimum wall is grown by ``(min_wall - w) / 2``
    - 04 stage 1, buildings 2, with ``w`` measured on the wing - and unioned
    back, which brings the wing itself up to a full wall instead of leaving it
    to print as one fragile perimeter (or to be dropped by the slicer).
    """
    if min_wall <= 0.0:
        return poly
    tolerance = min_wall * MIC_TOLERANCE_RATIO
    out = poly
    for _ in range(max(1, int(rounds))):
        parts = thin_parts(out, min_wall, area_floor)
        if not parts:
            break
        grown = [
            shapely.buffer(
                part,
                max((min_wall - inscribed_width(part, tolerance)) / 2.0, tolerance),
                join_style="mitre",
                quad_segs=CLOSE_QUAD_SEGS,
                mitre_limit=CLOSE_MITRE_LIMIT,
            )
            for part in parts
        ]
        merged = valid_polygons(shapely.union_all([out, *grown]))
        if not merged:
            break
        out = max(merged, key=lambda p: p.area)
    return out


def strip_thin_parts(
    poly: Polygon, min_wall: float, area_floor: float, rounds: int = APPENDAGE_ROUNDS
) -> tuple[list[Polygon], int]:
    """Cut every sub-minimum-wall appendage off ``poly``.  Returns (parts, cut).

    Used where 04's dilation is not available - after the final crop, where
    growing a footprint would push it back over the plate edge, and on the
    surface layers, where growing one layer would push it under another.

    Iterated, because cutting a wing off leaves a notch in the body and the
    material beside that notch can itself be the next wing.
    """
    if min_wall <= 0.0:
        return [poly], 0
    out = [poly]
    cut = 0
    for _ in range(max(1, int(rounds))):
        nxt: list[Polygon] = []
        found = 0
        for part in out:
            necks = thin_parts(part, min_wall, area_floor)
            if not necks:
                nxt.append(part)
                continue
            found += len(necks)
            try:
                remainder = part.difference(shapely.union_all(necks))
            except Exception:  # pragma: no cover
                remainder = shapely.make_valid(part).difference(
                    shapely.make_valid(shapely.union_all(necks))
                )
            nxt.extend(valid_polygons(remainder))
        out = nxt
        cut += found
        if not found:
            break
    return out, cut


def _prune_ring(coords: np.ndarray, area_eps: float) -> np.ndarray | None:
    """Drop vertices whose removal changes the ring by less than ``area_eps``."""
    ring = np.asarray(coords, dtype=np.float64)
    if len(ring) > 1 and np.allclose(ring[0], ring[-1]):
        ring = ring[:-1]
    for _ in range(4):
        n = len(ring)
        if n < 4:
            break
        prev = np.roll(ring, 1, axis=0)
        nxt = np.roll(ring, -1, axis=0)
        cross = np.abs(
            (ring[:, 0] - prev[:, 0]) * (nxt[:, 1] - prev[:, 1])
            - (ring[:, 1] - prev[:, 1]) * (nxt[:, 0] - prev[:, 0])
        )
        drop = cross <= 2.0 * area_eps
        if not drop.any():
            break
        # Never drop two neighbours in the same pass: the survivor's own
        # collinearity is re-measured on the next pass.
        keep = np.ones(n, dtype=bool)
        for i in np.nonzero(drop)[0]:
            if keep[(i - 1) % n] and keep[(i + 1) % n]:
                keep[i] = False
        if keep.all() or keep.sum() < 3:
            break
        ring = ring[keep]
    if len(ring) < 3:
        return None
    return ring


def drop_collinear(poly: Polygon, area_eps: float) -> Polygon | None:
    """Remove collinear (and all-but-collinear) vertices from every ring.

    Snap rounding leaves three points on one straight edge often enough that
    the extruder's triangulator emits an exactly zero-area cap triangle from
    them, which 04 stage 4 counts as a degenerate face.  ``shapely.simplify``
    with ``preserve_topology=True`` does not reliably remove them, so this does
    it explicitly.  Vertices are only ever removed, never moved, so the result
    stays on the print grid.
    """
    shell = _prune_ring(np.asarray(poly.exterior.coords), area_eps)
    if shell is None:
        return None
    holes = []
    for interior in poly.interiors:
        pruned = _prune_ring(np.asarray(interior.coords), area_eps)
        if pruned is not None:
            holes.append(pruned)
    out = Polygon(shell, holes)
    return out if out.is_valid and out.area > 0.0 else poly


def _open_and_split(snapped: Polygon, radius: float, grid: float) -> list[Polygon]:
    """The erode -> split -> dilate -> clip half of :func:`snap`, for one polygon.

    Raises ``shapely.errors.GEOSException`` when GEOS' overlay cannot do it;
    :func:`snap` degrades to the un-opened polygon in that case.
    """
    out: list[Polygon] = []
    eroded = shapely.buffer(snapped, -radius, quad_segs=2, join_style="mitre")
    for limb in valid_polygons(eroded):
        grown = shapely.buffer(limb, radius, quad_segs=2, join_style="mitre")
        for part in valid_polygons(grown.intersection(snapped)):
            for tidy in valid_polygons(shapely.set_precision(part, grid)):
                pruned = drop_collinear(tidy, COLLINEAR_AREA_CELLS * grid * grid)
                if pruned is not None:
                    out.extend(valid_polygons(pruned))
    return out


def snap(polys: Iterable[Polygon], grid: float) -> list[Polygon]:
    """Put a layer on the print grid and take the burrs off it.

    Three steps, and all three matter:

    1. ``set_precision`` (GEOS snap rounding, topology repairing) puts every
       vertex on the print grid, so the boolean engine is never handed two
       vertices a nanometre apart.
    2. A morphological *opening* at half a grid cell removes the hairline
       appendages the Stage 1 closing leaves behind.  Those appendages hang off
       a point where the boundary touches itself, and a horizontal slice through
       such a pinch reads as a *separate* region a few micrometres wide - which
       is a min-wall validator failure with no printable cause.
    3. ``set_precision`` again, because the opening's buffer output is not on
       the grid.

    The opening is done as erode -> **split into components** -> dilate, not as
    a plain erode/dilate pair: splitting is what lets the caller's
    minimum-feature filter judge each limb on its own, so a hairline limb is
    dropped instead of surviving because the body it hangs off is fat.  Nothing
    can be disconnected by this - every layer overlaps the base plate, which is
    a single solid.

    GEOS' floating-point overlay is not robust for every input: a dilated limb
    can share an edge with its own source at a vertex GEOS cannot reproduce, and
    ``TopologyException: Ring edge missing`` aborts the whole bake (observed on
    chicago-loop at nozzle 0.6 with the frame off - a pre-existing failure, not
    a consequence of what this layer holds).  The opening is a *deburring* pass,
    not a correctness invariant - every caller still runs the minimum-feature
    filters afterwards - so a polygon GEOS refuses to open is kept snapped and
    un-opened instead of taking the bake down with it.
    """
    if grid <= 0.0:
        return [p for p in polys if not p.is_empty]
    radius = DEBURR_GRID_CELLS * grid
    out: list[Polygon] = []
    for poly in polys:
        for snapped in valid_polygons(shapely.set_precision(poly, grid)):
            try:
                out.extend(_open_and_split(snapped, radius, grid))
            except shapely.errors.GEOSException:
                pruned = drop_collinear(snapped, COLLINEAR_AREA_CELLS * grid * grid)
                out.extend(valid_polygons(pruned if pruned is not None else snapped))
    return out


def separate(geom: BaseGeometry | None, distance: float) -> BaseGeometry | None:
    """Grow a subtrahend so the difference leaves a visible gap, not a shared edge."""
    if geom is None or geom.is_empty or distance <= 0.0:
        return geom
    return shapely.buffer(geom, distance, join_style="mitre", quad_segs=2, mitre_limit=2.0)


def widen_to_min_wall(
    poly: Polygon, min_wall: float, rounds: int = MIN_WALL_WIDEN_ROUNDS
) -> Polygon | None:
    """Grow a footprint until it survives the minimum-wall probe.

    04 stage 1 widens a thin footprint by ``(min_wall - w) / 2`` with ``w`` the
    hydraulic diameter.  For a long strip the hydraulic diameter is *twice* the
    true width, so that formula leaves a strip ``min_wall - t`` wide - under the
    real minimum.  Rather than delete the building (a long narrow block is a
    real building, and 04's whole point here is to widen, not to discard), the
    dilation is repeated in tenths of a wall until the same erosion probe the
    Stage 4 validator runs comes back non-empty.  Returns None if it never does.
    """
    if survives_min_wall(poly, min_wall):
        return poly
    step = min_wall * 0.1
    for i in range(1, rounds + 1):
        grown = shapely.buffer(poly, step * i, join_style="mitre", quad_segs=CLOSE_QUAD_SEGS)
        if survives_min_wall(grown, min_wall):
            return grown
    return None


def _drop_unprintable(
    polys: Iterable[Polygon],
    min_detail: float,
    min_wall: float,
    grid: float = 0.0,
    strip_thin: bool = True,
) -> tuple[list[Polygon], int, int]:
    """Drop sub-detail-area parts and every sub-min-wall *appendage*.

    Returns (kept, small, thin).  A region is judged twice: once as a whole
    (is any disc of ``0.9 * min_wall`` inside it?) and once per appendage,
    because a 0.5 mm wing on a 40 mm block passes the first test and still
    prints as a single fragile perimeter.  The wing is cut off rather than
    widened here: every caller has already clipped its layer (to the crop
    square, or to the space the layers above it leave), and growing it back
    would undo that clip.

    ``strip_thin=False`` is for a SUBTRACTIVE layer - an engraved road, water.
    What prints there is the layer's complement, so a thin limb of the cutter is
    a thin *groove*, which is harmless, while cutting it away would leave a new
    unprintable ridge of base between the groove and its neighbour.  Those
    complements are measured by :func:`merge_recess_ridges` instead.
    """
    kept: list[Polygon] = []
    small = 0
    thin = 0
    floor = min_detail * min_detail
    residue_floor = residue_area_floor(min_detail)
    for poly in polys:
        if poly.area < floor:
            small += 1
            continue
        if not survives_min_wall(poly, min_wall):
            thin += 1
            continue
        if not strip_thin:
            kept.append(poly)
            continue
        parts, cut = strip_thin_parts(poly, min_wall, residue_floor)
        thin += cut
        if cut and grid > 0.0:
            # The difference leaves the cut edge off the print grid; re-snapping
            # also deburrs whatever hairline the cut left behind - and can
            # itself expose one more wing, so the strip is repeated on the
            # snapped result until it comes back clean.
            parts = snap(parts, grid)
            for _ in range(APPENDAGE_ROUNDS):
                regrouped: list[Polygon] = []
                again = 0
                for part in parts:
                    stripped, extra = strip_thin_parts(part, min_wall, residue_floor)
                    again += extra
                    regrouped.extend(snap(stripped, grid) if extra else [part])
                thin += again
                parts = regrouped
                if not again:
                    break
        for part in parts:
            if part.area < floor:
                small += 1
                continue
            if not survives_min_wall(part, min_wall):
                thin += 1
                continue
            kept.append(part)
    return kept, small, thin


def finish_layer(
    polys: Iterable[Polygon],
    grid: float,
    thresholds: T.Thresholds,
    strip_thin: bool = True,
) -> tuple[list[Polygon], int, int]:
    """Snap, deburr, drop the unprintable parts, then re-union the whole layer.

    The final layer-wide ``set_precision`` matters: :func:`snap` works one
    polygon at a time, and snap-rounding two formerly-adjacent polygons
    independently can leave them overlapping by a fraction of a grid cell.
    Clipper2 then resolves that overlap at full double precision when the layer
    becomes a ``CrossSection``, and the sub-nanometre vertex it computes shows
    up in the finished mesh as a hairline island of base metal.  Snapping the
    union puts the whole layer back on one consistent grid.
    """
    kept, small, thin = _drop_unprintable(
        snap(polys, grid),
        thresholds.min_detail,
        thresholds.min_wall,
        grid=grid,
        strip_thin=strip_thin,
    )
    return regrid_layer(kept, grid), small, thin


def regrid_layer(polys: Iterable[Polygon], grid: float) -> list[Polygon]:
    """Put a whole layer back on one consistent grid and drop its stray vertices.

    The layer-wide ``set_precision`` is the half of :func:`finish_layer` that has
    nothing to do with minimum features, split out so a caller that must NOT
    re-run the minimum-feature drops can still regrid what it built (see
    :func:`merge_recess_ridges`).
    """
    kept = list(polys)
    if not kept or grid <= 0.0:
        return kept
    out: list[Polygon] = []
    for part in valid_polygons(shapely.set_precision(shapely.union_all(kept), grid)):
        pruned = drop_collinear(part, COLLINEAR_AREA_CELLS * grid * grid)
        if pruned is not None:
            out.extend(valid_polygons(pruned))
    return out


def _weighted_percentile(
    values: Sequence[float], weights: Sequence[float], q: float
) -> tuple[float, int]:
    """Area-weighted percentile of ``values``; returns (value, index).

    The returned index is the contributor that supplied the value, so the caller
    can inherit its ``is_tall`` flag instead of recomputing it.  Definition: the
    smallest value whose cumulative weight reaches ``q`` of the total.  Ties
    break on the original index so the result is deterministic.
    """
    order = sorted(range(len(values)), key=lambda i: (values[i], i))
    total = float(sum(weights))
    if total <= 0.0:
        idx = order[-1]
        return float(values[idx]), idx
    target = q * total
    running = 0.0
    for i in order:
        running += float(weights[i])
        if running >= target - 1e-12:
            return float(values[i]), i
    idx = order[-1]
    return float(values[idx]), idx


# --------------------------------------------------------------------------
# Buildings
# --------------------------------------------------------------------------


def repair_buildings(
    buildings: Sequence,
    thresholds: T.Thresholds,
    crop: Polygon,
    grid: float = 0.0,
    params: T.ParamsLike | None = None,
    scale: float = 1.0,
) -> BuildingLayer:
    """04 stage 1, buildings, steps 1-5 followed by the inset crop.

    ``params`` and ``scale`` are used by :func:`repair_slice_profiles`, which
    needs the *printed* height of each solid to know which solids share a
    horizontal slice, and by the hero-building rule below (a hero's printed top
    depends on the hero multiplier, so "does this hero rise above its block?" is
    a question about print millimetres, not ground metres).

    HERO BUILDINGS (PrintParams v2).  A hero is exempt from step 5's block
    merging, exactly the way 04 already preserves a footprint over 1.5x the
    block height: its height never enters the block's area-weighted percentile,
    and it is kept as its own solid stacked on that block.  It is NOT exempt from
    anything else - steps 1-3, the appendage passes, the crop and every Stage 4
    check apply to a hero footprint unchanged.
    """
    layer = BuildingLayer()
    if not buildings:
        return layer

    picked: tuple[str, ...] = T.hero_ids(params) if params is not None else ()
    hero_set = frozenset(picked)
    if hero_set:
        known = {str(getattr(b, "id", "")) for b in buildings}
        layer.hero_unknown = [h for h in picked if h not in known]
        hero_set = hero_set - set(layer.hero_unknown)
    hero_true_height = bool(params is not None and T.hero_true_height(params))

    footprints: list[Polygon] = []
    heights: list[HeightSpec] = []
    #: SceneGraph id of the building each footprint came from, parallel to
    #: ``footprints``; only the hero rule reads it.
    sources: list[str] = []
    widened = 0
    dropped_small = 0

    for b in buildings:
        parts = polygon_from_rings(b.ring, b.holes)
        if not parts:
            continue
        # Steps 1-2: hydraulic width and the dilation that brings it up to the
        # minimum wall.  Both come from the shared transform math so the preview
        # counts the same footprints as widened.
        _area, _perimeter, _width, dilation = T.building_footprint_metrics(
            b.ring, b.holes, thresholds
        )
        ident = str(getattr(b, "id", ""))
        is_hero = ident in hero_set
        spec = HeightSpec(
            height_m=float(b.height_m),
            is_tall=bool(b.is_tall),
            is_hero=is_hero and hero_true_height,
        )
        if dilation > 0.0:
            widened += 1
            grown = shapely.buffer(parts, dilation, join_style="mitre", quad_segs=CLOSE_QUAD_SEGS)
            parts = [p for g in grown for p in valid_polygons(g)]
        # Step 3: drop anything still under the minimum detail area, and widen
        # anything the hydraulic-diameter formula left under the real wall.
        for part in parts:
            if part.area < thresholds.min_detail * thresholds.min_detail:
                dropped_small += 1
                continue
            thick = widen_to_min_wall(part, thresholds.min_wall)
            if thick is None:
                dropped_small += 1
                continue
            if thick is not part and dilation <= 0.0:
                widened += 1  # 04's formula said no, the probe said yes
            footprints.append(thick)
            heights.append(spec)
            sources.append(ident)

    layer.widened = widened
    layer.dropped_small = dropped_small
    if not footprints:
        return layer

    # Step 4: close the layer so unprintable slivers between neighbours fuse.
    merged = close_layer(shapely.union_all(footprints), thresholds.min_gap / 2.0)
    components = valid_polygons(merged)
    if not components:
        return layer

    # Steps 1-2 again, per appendage.  The hydraulic width of a whole block says
    # nothing about the 0.5 mm wing sticking out of it, and closing the layer
    # creates such wings (two footprints fusing across a sliver leave the sliver
    # as a limb).  04's dilation rule is applied to the limb itself.
    floor = residue_area_floor(thresholds.min_detail)
    widened_parts = 0
    thickened: list[Polygon] = []
    for component in components:
        fixed = widen_thin_parts(component, thresholds.min_wall, floor)
        if fixed is not component:
            widened_parts += 1
        thickened.append(fixed)
    components = thickened
    layer.widened += widened_parts

    # Step 5: each component takes the area-weighted 80th percentile of the
    # heights it swallowed; a contributor above 1.5x that keeps its own solid.
    tree = STRtree(components)
    reps = shapely.points([[p.x, p.y] for p in (f.representative_point() for f in footprints)])
    hit = tree.query(reps, predicate="intersects")
    per_component: dict[int, list[int]] = {}
    matched: set[int] = set()
    for foot_idx, comp_idx in zip(hit[0].tolist(), hit[1].tolist()):
        if foot_idx in matched:
            continue  # a representative point on a shared edge: first wins
        matched.add(foot_idx)
        per_component.setdefault(comp_idx, []).append(foot_idx)
    # A footprint whose representative point missed (closing can round a corner
    # away from it) must not lose its height: fall back to an area query so a
    # swallowed tower still raises its block.
    missing = [i for i in range(len(footprints)) if i not in matched]
    for i in missing:
        candidates = tree.query(footprints[i], predicate="intersects").tolist()
        if not candidates:
            continue
        best = max(candidates, key=lambda c: components[c].intersection(footprints[i]).area)
        per_component.setdefault(best, []).append(i)

    solids: list[BuildingSolid] = []
    merged_components = 0
    stacked = 0
    buried: list[str] = []
    for comp_idx, component in enumerate(components):
        members = per_component.get(comp_idx)
        if not members:
            # A closing artefact with no contributor: keep it at the smallest
            # printable height rather than dropping a hole in the block.
            solids.append(BuildingSolid(component, HeightSpec(0.0, False)))
            continue
        if len(members) > 1:
            merged_components += 1
        # A hero is exempt from the merge: its height never raises the block it
        # stands on, so it can always rise out of it.  When EVERY contributor is
        # a hero there is no non-hero height to take a percentile of, so the
        # block falls back to all of them (and, if they are all the same hero,
        # the block simply IS that hero - see ``block_hero`` below).
        pool = [i for i in members if sources[i] not in hero_set] or members
        values = [heights[i].height_m for i in pool]
        weights = [footprints[i].area for i in pool]
        block_h, winner = _weighted_percentile(values, weights, BLOCK_HEIGHT_PERCENTILE)
        block_hero: str | None = None
        block_is_hero = False
        if hero_set and pool is members:
            owners = {sources[i] for i in members}
            if len(owners) == 1 and next(iter(owners)) in hero_set:
                block_hero = next(iter(owners))
                block_is_hero = hero_true_height
        block = HeightSpec(
            height_m=block_h,
            is_tall=heights[pool[winner]].is_tall,
            is_hero=block_is_hero,
        )
        solids.append(BuildingSolid(component, block, hero_id=block_hero))
        # Only the hero branch needs a printed height, and only a hero-bearing
        # scene has params; a v1 call may pass params=None.
        block_top = _height_top_mm(block, params, scale) if hero_set else 0.0
        for i in members:
            hero_id = sources[i] if sources[i] in hero_set else None
            if hero_id is not None and hero_id != block_hero:
                # 04's 1.5x rule does not apply to a hero: any hero that stands
                # taller than its block keeps its own solid, so its colour and
                # its true height are both visible.  One that does not is buried
                # in the block, which is reported rather than faked.
                if _height_top_mm(heights[i], params, scale) > block_top:
                    stacked += 1
                    solids.append(
                        BuildingSolid(
                            footprints[i], heights[i], stands_on=block, hero_id=hero_id
                        )
                    )
                elif hero_id not in buried:
                    buried.append(hero_id)
                continue
            if heights[i].height_m > STACK_HEIGHT_FACTOR * block_h and block_h > 0.0:
                stacked += 1
                solids.append(BuildingSolid(footprints[i], heights[i], stands_on=block))

    layer.merged_components = merged_components
    layer.stacked = stacked
    layer.hero_buried = buried

    # Final clip, against the crop square already inset by 0.05 mm.  Blocks go
    # first: a stacked tower is then clipped to the blocks that actually
    # survived, so a tower whose block was dropped can never be left floating.
    clipped: list[BuildingSolid] = []
    dropped_thin = 0
    dropped_small_after = 0
    for solid in solids:
        if solid.stands_on is not None:
            continue
        pieces = snap(valid_polygons(solid.polygon.intersection(crop)), grid)
        kept, small, thin = _drop_unprintable(
            pieces, thresholds.min_detail, thresholds.min_wall, grid=grid
        )
        dropped_small_after += small
        dropped_thin += thin
        for piece in kept:
            clipped.append(BuildingSolid(piece, solid.height, None, solid.hero_id))

    block_union = shapely.union_all([s.polygon for s in clipped]) if clipped else None
    for solid in solids:
        if solid.stands_on is None or block_union is None:
            continue
        pieces = snap(valid_polygons(solid.polygon.intersection(block_union)), grid)
        kept, small, thin = _drop_unprintable(
            pieces, thresholds.min_detail, thresholds.min_wall, grid=grid
        )
        dropped_small_after += small
        dropped_thin += thin
        for piece in kept:
            clipped.append(
                BuildingSolid(piece, solid.height, solid.stands_on, solid.hero_id)
            )

    layer.solids = clipped
    if hero_set:
        # A hero is never exempt from the minimum-feature repair or the crop, so
        # it can lose every piece like any other footprint.  Say so rather than
        # letting a picked building silently vanish from the part list.
        survived = {s.hero_id for s in clipped if s.hero_id is not None}
        layer.hero_dropped = [
            h for h in picked if h in hero_set and h not in survived and h not in buried
        ]
    layer.dropped_small += dropped_small_after
    layer.dropped_thin = dropped_thin
    layer.union = block_union
    if params is not None:
        layer.widened += repair_slice_profiles(layer, params, thresholds, scale, crop, grid)
    return layer


def _height_top_mm(spec: HeightSpec, params: T.ParamsLike, scale: float) -> float:
    """Printed Z of a height carrier's roof, in mm, hero multiplier included."""
    return T.building_top_mm_for(spec, params, scale, spec.is_hero)


def _solid_top_mm(solid: BuildingSolid, params: T.ParamsLike, scale: float) -> float:
    """Printed Z of this solid's roof, in mm, straight from ``transform``."""
    return _height_top_mm(solid.height, params, scale)


def repair_slice_profiles(
    layer: BuildingLayer,
    params: T.ParamsLike,
    thresholds: T.Thresholds,
    scale: float,
    crop: Polygon,
    grid: float,
) -> int:
    """Widen thin walls that exist only in a horizontal SLICE of the stack.

    A footprint is not what prints at height z: what prints is the union of
    every solid that reaches that high.  Two preserved towers (04 stage 1,
    buildings 5) that overlap by a corner make a 0.5 mm neck in their union
    above the block top that neither footprint has on its own, and no
    per-footprint repair can see it.

    Sorted by printed top, the set of solids present at z is exactly a PREFIX of
    the sorted list, so walking the prefixes checks every cross-section the
    model can have.  Each thin neck gets 04's dilation rule and the patch is
    given to the SHORTEST solid of the prefix - the band where that
    cross-section is the one that prints.  A patch belonging to a stacked solid
    is clipped to the block union so it can never be left floating (the same
    rule the stacks themselves follow).  Returns the number of patches added.
    """
    solids = layer.solids
    if len(solids) < 2 or thresholds.min_wall <= 0.0:
        return 0
    floor = residue_area_floor(thresholds.min_detail)
    min_wall = thresholds.min_wall

    components = valid_polygons(shapely.union_all([s.polygon for s in solids]))
    if not components:
        return 0
    tree = STRtree(components)
    reps = shapely.points([[p.x, p.y] for p in (s.polygon.representative_point() for s in solids)])
    hit = tree.query(reps, predicate="intersects")
    groups: dict[int, list[int]] = {}
    matched: set[int] = set()
    for solid_idx, comp_idx in zip(hit[0].tolist(), hit[1].tolist()):
        if solid_idx in matched:
            continue
        matched.add(solid_idx)
        groups.setdefault(comp_idx, []).append(solid_idx)

    patches: list[BuildingSolid] = []
    for members in groups.values():
        if len(members) < 2:
            continue
        members.sort(key=lambda i: -_solid_top_mm(solids[i], params, scale))
        accumulated = None
        for index in members:
            solid = solids[index]
            accumulated = (
                solid.polygon
                if accumulated is None
                else shapely.union_all([accumulated, solid.polygon])
            )
            limit = crop if solid.stands_on is None else (layer.union or crop)
            for _ in range(APPENDAGE_ROUNDS):
                necks = thin_parts(accumulated, min_wall, floor)
                if not necks:
                    break
                grown = shapely.union_all(
                    [
                        shapely.buffer(
                            neck,
                            max(
                                (min_wall - inscribed_width(neck, min_wall * MIC_TOLERANCE_RATIO))
                                / 2.0,
                                min_wall * MIC_TOLERANCE_RATIO,
                            ),
                            join_style="mitre",
                            quad_segs=CLOSE_QUAD_SEGS,
                            mitre_limit=CLOSE_MITRE_LIMIT,
                        )
                        for neck in necks
                    ]
                )
                pieces = snap(valid_polygons(grown.intersection(limit)), grid)
                pieces = [p for p in pieces if p.area > 0.0]
                if not pieces:
                    break
                accumulated = shapely.union_all([accumulated, *pieces])
                for piece in pieces:
                    # The patch keeps the hero id of the solid it patches, not
                    # just its HEIGHT.  It is extruded to that solid's printed
                    # top either way (``solid.height`` carries ``is_hero``), so
                    # withholding the id printed a strip of BUILDING-coloured
                    # material running the full height of a HERO (v2-02 audit,
                    # finding 8).  DECISIONS [V2-P3] withheld it because a
                    # fraction of a mm^3 as a second body of a hero part is what
                    # `finalize`'s debris sweep could drop, silently breaking the
                    # partition - which the exact `parts_union` symmetric
                    # difference now catches loudly instead.
                    patches.append(
                        BuildingSolid(piece, solid.height, solid.stands_on, solid.hero_id)
                    )

    if not patches:
        return 0
    layer.solids = solids + patches
    blocks = [s.polygon for s in layer.solids if s.stands_on is None]
    layer.union = shapely.union_all(blocks) if blocks else layer.union
    return len(patches)


# --------------------------------------------------------------------------
# Roads
# --------------------------------------------------------------------------


def repair_roads(
    roads: Sequence,
    params: T.ParamsLike,
    thresholds: T.Thresholds,
    crop: Polygon,
    subtract: Sequence[BaseGeometry | None] = (),
    grid: float = 0.0,
    separation: float = 0.0,
) -> AreaLayer:
    """04 stage 1, roads: buffer, union, subtract buildings, clip."""
    layer = AreaLayer()
    if params.road_mode == "off" or not roads:
        return layer

    lines: list[LineString] = []
    half_widths: list[float] = []
    for r in roads:
        if len(r.path) < 2:
            continue
        line = LineString(r.path)
        if line.length <= 0.0:
            continue
        lines.append(line)
        half_widths.append(T.road_width_ground_m(r, params, thresholds) / 2.0)
    if not lines:
        return layer

    ribbons = shapely.buffer(
        lines,
        np.asarray(half_widths, dtype=np.float64),
        quad_segs=ROAD_QUAD_SEGS,
        cap_style="flat",
        join_style="round",
    )
    # 04 does not close the road layer, but an engraved road is a groove and
    # what actually prints is its COMPLEMENT: two grooves less than a wall
    # apart leave a ridge of base metal no nozzle can lay down.  Closing the
    # road layer at min_wall/2 merges those grooves, which is the same argument
    # 04 makes for buildings one paragraph earlier (DECISIONS [P3]).
    geom: BaseGeometry = close_layer(shapely.union_all(ribbons), thresholds.min_wall / 2.0)
    for other in subtract:
        blocker = separate(other, separation)
        if blocker is not None and not blocker.is_empty:
            geom = geom.difference(blocker)
    geom = geom.intersection(crop)

    # An engraved road is a cutter: what prints is the base around it, so its own
    # thin limbs are grooves, not walls (see ``_drop_unprintable``).
    kept, small, thin = finish_layer(
        valid_polygons(geom), grid, thresholds, strip_thin=params.road_mode != "engrave"
    )
    layer.polygons = kept
    layer.dropped_small = small
    layer.dropped_thin = thin
    return layer


# --------------------------------------------------------------------------
# Water and green
# --------------------------------------------------------------------------


def repair_areas(
    features: Sequence,
    thresholds: T.Thresholds,
    crop: Polygon,
    subtract: Sequence[BaseGeometry | None] = (),
    grid: float = 0.0,
    separation: float = 0.0,
    strip_thin: bool = True,
) -> AreaLayer:
    """04 stage 1, water and green: buffer-clean, subtract, drop, clip."""
    layer = AreaLayer()
    if not features:
        return layer

    polys: list[Polygon] = []
    for f in features:
        polys.extend(polygon_from_rings(f.ring, f.holes))
    if not polys:
        return layer

    # 04: "buffer-clean the same way", i.e. the closing pair.  ``min_wall`` is
    # 2 nozzles and ``min_gap`` 1.5, so closing at min_wall/2 subsumes 04's
    # min_gap/2 and additionally removes the unprintable ridges a recessed
    # water layer would otherwise leave between two ponds (DECISIONS [P3]).
    geom: BaseGeometry = close_layer(shapely.union_all(polys), thresholds.min_wall / 2.0)
    for other in subtract:
        blocker = separate(other, separation)
        if blocker is not None and not blocker.is_empty:
            geom = geom.difference(blocker)
    geom = geom.intersection(crop)

    kept, small, thin = finish_layer(
        valid_polygons(geom), grid, thresholds, strip_thin=strip_thin
    )
    layer.polygons = kept
    layer.dropped_small = small
    layer.dropped_thin = thin
    return layer


# --------------------------------------------------------------------------
# Trees
# --------------------------------------------------------------------------


def tree_min_radius_mm(params: T.ParamsLike) -> float:
    """Smallest printed site radius an 8-gon cone may have, in millimetres.

    04 caps the tree radius at 0.5 mm printed and says nothing about the nozzle,
    but an 8-gon of circumradius ``r`` is only ``2 * r * cos(pi/8)`` wide across
    its flats, so at the 0.5 mm floor a tree's *base* is 0.92 mm wide - under one
    extruded bead for every nozzle from 0.5 mm up, and under the Stage 4
    ``min_wall`` gate from 0.46 mm up.  The floor is therefore raised to whatever
    puts a full minimum wall across the base of the cone; at the default 0.4 mm
    nozzle that is 0.433 mm, so 04's 0.5 mm still binds and nothing changes.

    The rule now lives in :mod:`app.geom.transform` (mirrored by
    ``apps/web/lib/transform.ts``) so the preview hides exactly the trees the
    bake drops; this alias keeps the Stage 1 call sites and the warning text
    reading in Stage 1 terms.  ``warnings`` still reports the count.
    """
    return T.tree_min_radius_mm(params)


def select_trees(
    trees: Sequence,
    params: T.ParamsLike,
    scale: float,
    crop: Polygon,
    exclude: Sequence[BaseGeometry | None] = (),
) -> tuple[list[TreeSite], int]:
    """04 stage 1, trees.  Returns (kept, dropped).

    Visibility and the 2000 cap come from ``transform`` so the preview picks the
    same trees; the "does not intersect a building or road footprint" half is a
    2D predicate only the bake can evaluate, and so is the nozzle-aware radius
    floor in :func:`tree_min_radius_mm`.
    """
    if not params.trees or not trees:
        return [], 0

    visible = [i for i, t in enumerate(trees) if T.tree_visible_for(t, params, scale)]
    dropped = len(trees) - len(visible)
    if not visible:
        return [], dropped

    blockers = [g for g in exclude if g is not None and not g.is_empty]
    if blockers:
        blocker = shapely.union_all(blockers)
        discs = shapely.buffer(
            shapely.points([[trees[i].x, trees[i].y] for i in visible]),
            np.asarray([float(trees[i].radius_m) for i in visible], dtype=np.float64),
            quad_segs=2,
        )
        clear = shapely.disjoint(discs, blocker) & shapely.covered_by(discs, crop)
    else:
        discs = shapely.buffer(
            shapely.points([[trees[i].x, trees[i].y] for i in visible]),
            np.asarray([float(trees[i].radius_m) for i in visible], dtype=np.float64),
            quad_segs=2,
        )
        clear = shapely.covered_by(discs, crop)

    survivors = [visible[k] for k in range(len(visible)) if bool(clear[k])]
    dropped += len(visible) - len(survivors)

    subset = [trees[i] for i in survivors]
    keep = T.select_tree_indices_for(subset, params, scale)
    dropped += len(subset) - len(keep)
    sites = [
        TreeSite(float(subset[k].x), float(subset[k].y), float(subset[k].radius_m)) for k in keep
    ]
    return sites, dropped


# --------------------------------------------------------------------------
# Whole-scene entry point
# --------------------------------------------------------------------------


def merge_recess_ridges(
    sink: AreaLayer,
    recess_layers: Sequence[AreaLayer],
    thresholds: T.Thresholds,
    crop: Polygon,
    grid: float,
    passes: int = 4,
    domain: Polygon | None = None,
) -> None:
    """Swallow the unprintable ridges *left between* the recessed layers.

    Each recessed layer is closed against itself, but what actually prints on
    the base top is the layers' COMPLEMENT, and two grooves - or a groove and a
    pond - can leave an island of base metal no nozzle can lay down.  Every
    island is measured with the same erosion probe the Stage 4 ``min_wall``
    validator uses; an island that fails is handed to ``sink`` (the deepest
    recess), which makes the two agree by construction.  Mutates ``sink`` in
    place.
    """
    recesses = [layer.union for layer in recess_layers if layer.polygons]
    recesses = [g for g in recesses if g is not None and not g.is_empty]
    if not recesses:
        return
    floor = residue_area_floor(thresholds.min_detail)
    # The complement has to be measured over the whole BASE PLATE, not over the
    # crop square: a groove that runs close to the crop edge leaves a nub of
    # base hanging off the 6 mm band outside the crop, and clipping the
    # complement at the crop turns that nub into part of a fat island that
    # nothing is wrong with.  The bridge below is still clipped to ``crop`` -
    # the region a recess is allowed to occupy, which is the inset crop square
    # with the frame on and the plate square with it off
    # (:func:`recess_clip_square`).
    field = crop if domain is None else domain
    for _ in range(passes):
        recess = shapely.union_all(recesses)
        islands = explode(field.difference(recess))
        bad: list[Polygon] = []
        for island in islands:
            if not survives_min_wall(island, thresholds.min_wall):
                bad.append(island)
                continue
            # A city block is fat in the middle and can still taper to a
            # 0.2 mm wedge where two grooves converge; that wedge is a ridge no
            # nozzle can lay down, exactly like a whole unprintable island.
            bad.extend(thin_parts(island, thresholds.min_wall, floor))
        if not bad:
            return
        # Bridge, do not merely absorb: an island between two recesses can be a
        # hairline of literally zero area (GEOS reports 0.0 for it, and it only
        # exists at all because Clipper2 resolved two overlapping cutters at
        # full double precision).  Unioning a zero-area polygon into the sink
        # changes nothing, so the island is grown by a few grid cells first,
        # which fuses the two recesses across it.
        widened = shapely.buffer(
            shapely.union_all(bad),
            RIDGE_BRIDGE_CELLS * grid,
            quad_segs=2,
            join_style="mitre",
        ).intersection(crop)
        base = sink.union
        merged = (
            shapely.union_all([base, widened]) if base is not None else widened
        )
        # The bridge is regridded but NEVER put back through the layer's
        # minimum-feature drops.  ``_drop_unprintable`` would discard it for
        # being small or narrow - which is exactly what used to leave the ridge
        # standing: a wedge between two ponds is bridged into the *road* layer
        # (the deepest recess), where it is an isolated ~0.1 mm^2 polygon under
        # ``min_detail^2``, so every one of the four passes rebuilt it and every
        # one dropped it again.  What a sub-minimum CUTTER polygon prints as is
        # a dimple no nozzle reaches, i.e. solid base; what dropping it prints
        # as is a ridge of base no nozzle can lay down.  The sink's own polygons
        # were already filtered when its layer was built, and its drop counters
        # keep those counts.
        sink.polygons = regrid_layer(snap(valid_polygons(merged), grid), grid)
        recesses = [
            layer.union for layer in recess_layers if layer.polygons and layer.union is not None
        ]
        if not recesses:
            return


def crop_square(params: T.ParamsLike, scale: float) -> Polygon:
    """The final clip square in ground metres, already inset by 0.05 mm."""
    half = T.content_extents_mm(params).max_x / scale
    return box(-half, -half, half, half)


def plate_square(params: T.ParamsLike, scale: float) -> Polygon:
    """The printed plate outline in ground metres (no inset, no frame band)."""
    half = T.plate_extents_mm(params).max_x / scale
    return box(-half, -half, half, half)


def recess_clip_square(params: T.ParamsLike, scale: float, grid: float) -> Polygon:
    """Where a SUBTRACTIVE layer (water, engraved roads) may reach.

    An additive layer stops at the inset crop square: 04's ``CROP_INSET_MM``
    keeps a footprint that lands exactly on the crop edge from producing a
    zero-thickness wall.  A recess is the opposite case.  What prints there is
    the layer's COMPLEMENT, so clipping the cutter 0.05 mm inside the edge of
    the region it is cut from leaves a 0.05 mm RIND of base standing between
    the recess and that edge - an unprintable wall the recess itself created.

    With the frame ON the crop is a full ``FRAME_WIDTH_MM`` inside the plate,
    the rind sits under the 6 mm lip, and it is fused into solid material: the
    crop is the right clip.  With the frame OFF the usable square *is* the
    plate, so the crop edge is exactly ``CROP_INSET_MM`` inside the plate's own
    side wall and the rind is a real 0.05 mm appendage of the base slab,
    reaching the physical plate edge (verified on chicago-loop, plate 240 and
    256 mm: Stage 4 ``min_wall`` fails at 0.050 mm).  The cutter is therefore
    clipped to the plate square grown by ``RIDGE_BRIDGE_CELLS`` grid cells
    instead, so the recess opens onto the plate side wall - and lands strictly
    outside it, which keeps the boolean off a coincident vertical face.
    """
    if params.frame:
        return crop_square(params, scale)
    return shapely.buffer(
        plate_square(params, scale),
        RIDGE_BRIDGE_CELLS * grid,
        quad_segs=1,
        join_style="mitre",
    )


def repair_scene(scene, params: T.ParamsLike) -> RepairedScene:
    """Run every Stage 1 layer, in 04's order, and collect the warnings."""
    radius_m = T.radius_m_from_bounds(scene.bounds)
    scale = T.scale_mm_per_m(params, radius_m)
    thresholds = T.thresholds_ground_m(params, scale)
    crop = crop_square(params, scale)
    grid = PRINT_GRID_MM / scale
    separation = LAYER_SEPARATION_MM / scale
    # Additive layers stop at ``crop``; a recess may run out to the plate edge
    # instead of leaving a 0.05 mm rind of base behind it (see
    # :func:`recess_clip_square`).  With the frame on the two are the same call.
    recess_clip = recess_clip_square(params, scale, grid)

    buildings = repair_buildings(
        scene.buildings, thresholds, crop, grid=grid, params=params, scale=scale
    )

    # Water is the deepest recess and comes first.  An EMBOSSED road is
    # additive, so it must not overlap the water cutter: the cutter would slice
    # the raised ribbon and the T-junctions it inserts on the ribbon's top face
    # retriangulate into zero-area cap triangles.  An ENGRAVED road is a recess
    # like the water, so the two may overlap freely.
    water = AreaLayer()
    if params.water:
        # Water is a recess too: 04 sinks it 0.5 mm below the base top.
        water = repair_areas(
            scene.water,
            thresholds,
            recess_clip,
            subtract=[buildings.union],
            grid=grid,
            separation=separation,
            strip_thin=False,
        )

    road_subtract: list[BaseGeometry | None] = [buildings.union]
    if params.road_mode == "emboss":
        road_subtract.append(water.union)
    roads = repair_roads(
        scene.roads,
        params,
        thresholds,
        # An engraved road is a cutter and gets the recess clip; an embossed one
        # is a raised ribbon, i.e. an additive feature, and stops at the crop.
        recess_clip if params.road_mode == "engrave" else crop,
        subtract=road_subtract,
        grid=grid,
        separation=separation,
    )

    plate = plate_square(params, scale)
    if params.road_mode == "engrave":
        merge_recess_ridges(roads, [roads, water], thresholds, recess_clip, grid, domain=plate)
    elif water.polygons:
        merge_recess_ridges(water, [water], thresholds, recess_clip, grid, domain=plate)
    road_union = roads.union

    # Green comes last and gives way to every other layer.  Subtracting the
    # roads here (rather than letting the 3D boolean cut the raised slab) is
    # what keeps the cutter's wall from crossing the green top face: a crossing
    # inserts a T-junction vertex on that face and the retriangulation turns
    # the collinear triple into a zero-area cap triangle.
    green = repair_areas(
        scene.green,
        thresholds,
        crop,
        subtract=[buildings.union, water.union, road_union],
        grid=grid,
        separation=separation,
    )

    trees, trees_dropped = select_trees(
        scene.trees, params, scale, crop, exclude=[buildings.union, road_union, water.union]
    )

    warnings: list[str] = []
    if buildings.widened:
        warnings.append(
            f"{buildings.widened} buildings widened to meet minimum feature size"
        )
    dropped_buildings = buildings.dropped_small + buildings.dropped_thin
    if dropped_buildings:
        warnings.append(f"{dropped_buildings} buildings dropped below the minimum printable size")
    if buildings.merged_components:
        warnings.append(f"block heights merged for {buildings.merged_components} components")
    if buildings.stacked:
        warnings.append(f"{buildings.stacked} tall buildings preserved above their block")
    if buildings.hero_unknown:
        warnings.append(
            f"{len(buildings.hero_unknown)} hero building ids are not in this scene "
            f"and were ignored: {', '.join(buildings.hero_unknown)}"
        )
    if buildings.hero_dropped:
        warnings.append(
            f"{len(buildings.hero_dropped)} hero buildings were dropped by the minimum "
            f"feature repair: {', '.join(buildings.hero_dropped)}"
        )
    if buildings.hero_buried:
        warnings.append(
            f"{len(buildings.hero_buried)} hero buildings are shorter than the block "
            f"they merged into and cannot be shown separately: "
            f"{', '.join(buildings.hero_buried)}"
        )
    if trees_dropped:
        warnings.append(f"{trees_dropped} trees dropped")
        floor_mm = tree_min_radius_mm(params)
        if floor_mm > T.TREE_MIN_RADIUS_MM:
            warnings.append(
                f"tree site radius floor raised to {floor_mm:.2f} mm so an 8-sided cone "
                f"is a full minimum wall wide at its base with a "
                f"{float(params.nozzle_mm):g} mm nozzle"
            )
    dropped_areas = (
        water.dropped_small + water.dropped_thin + green.dropped_small + green.dropped_thin
    )
    if dropped_areas:
        warnings.append(f"{dropped_areas} water/green areas dropped below the minimum feature size")

    return RepairedScene(
        scale=scale,
        thresholds=thresholds,
        crop=crop,
        buildings=buildings,
        roads=roads,
        water=water,
        green=green,
        trees=trees,
        trees_dropped=trees_dropped,
        warnings=warnings,
    )
