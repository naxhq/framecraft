"""Stage 4 of ``04_PRINTABILITY_SPEC.md``: the validators.  These are the gate.

``validate(mesh, params)`` returns a :class:`ValidationReport` with one
:class:`Check` per row of 04's table.  All of them must pass before a job is
marked ``done``; on failure the pipeline names the failing check in
``BakeResult.error`` and dumps the intermediate solids to
``artifacts/debug/<job_id>/``.

Method notes (the handoff repeats these):

* **Manifold** - ``manifold3d``'s own ``status() == Error.NoError`` when the
  Manifold is still in hand, plus the trimesh equivalent
  (``is_watertight and is_winding_consistent``) so a file loaded from disk can
  be validated with the same function.
* **Watertight** - ``is_watertight`` plus an Euler characteristic consistent
  with the body count: a closed orientable surface has an even
  ``euler_number`` no greater than ``2 * body_count`` (equality only when every
  body has genus 0).
* **Volume** - positive, and equal to its own absolute value, which is what
  catches inverted normals.
* **Self-intersection** - manifold3d guarantees none for valid inputs, and
  Stage 1 makes every input valid (``make_valid``, oriented rings, shrunk
  holes).  That guarantee is recorded together with two independent pieces of
  evidence computed here: every edge is shared by exactly two faces and there
  are no duplicate triangles, and a deterministic sample of faces is tested
  pairwise for edge/triangle crossings through a grid broad phase.
* **Min wall** - 12 deterministic Z slices (stratified, seeded RNG) plus one
  fixed slice inside every recess band (:func:`recess_probe_zs`), because a
  0.5 mm water band on a 50 mm model is otherwise sampled only by luck.  Each
  slice is cut with ``Manifold.slice`` when the solid can be handed to
  manifold3d and with ``trimesh.section`` otherwise (see :func:`make_slicer`),
  and turned into shapely polygons with their holes.  A region only counts as a
  *wall* if it still holds at least ``WALL_PERSIST_RATIO`` of its area one
  printed layer (:func:`wall_persist_mm`) higher; that is what keeps a tapering
  tip - 04 models trees as cones, whose apex is a point by construction - from
  being read as an infinitely thin wall, while a vertical wall keeps 100% of its
  area and is always measured.  The width of a counted region is
  ``thicken.narrowest_width``: the region's own inscribed diameter, lowered by
  the inscribed diameter of every appendage the ``0.45 * min_wall`` opening
  leaves behind, so a 0.5 mm wing on a 40 mm block is measured as 0.5 mm and not
  as 40.  A region **fails** when that width is under ``0.9 * min_wall_mm``,
  which is 04's rule verbatim, and the same number is what gets **reported**.
"""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import shapely
import trimesh
from shapely.geometry import Polygon

from app.geom import thicken
from app.geom import transform as T
from app.geom.thicken import MIN_WALL_FAIL_FACTOR

__all__ = [
    "Check",
    "ValidationReport",
    "validate",
    "validate_parts",
    "single_body_check",
    "enforce_triangle_budget",
    "section_polygons",
    "wall_persist_mm",
    "recess_probe_zs",
    "validate_lettering",
    "validate_base_floor",
    "lettering_probe_zs",
    "lettering_expected_pieces",
    "validator_token_context",
    "frame_band_polygon",
    "body_count",
    "TRIANGLE_BUDGET",
    "DECIMATION_TARGET",
    "MAX_HEIGHT_MM",
    "MIN_PART_BODY_VOLUME_MM3",
    "PART_UNION_VOLUME_TOLERANCE",
    "PART_UNION_BBOX_TOLERANCE_MM",
    "PART_UNION_SYMDIFF_MM3",
    "symmetric_difference_mm3",
]

#: 04 stage 4: triangle budget and the decimation target when it is exceeded.
TRIANGLE_BUDGET = 2_000_000
DECIMATION_TARGET = 1_500_000

#: 04 stage 4: Z must stay under 60 mm and X/Y within the plate plus a hair.
MAX_HEIGHT_MM = 60.0
PLATE_TOLERANCE_MM = 0.01

#: 04 stage 4: the model sits at exactly z = 0, within this tolerance.
SIT_TOLERANCE_MM = 0.001

#: 04 stage 4: a face under this area is degenerate.
DEGENERATE_FACE_AREA = 1e-9

#: Min-wall probe.  ``MIN_WALL_FAIL_FACTOR`` (0.9) is imported from
#: :mod:`app.geom.thicken` so the Stage 1 repair and this gate cannot drift.
MIN_WALL_SLICES = 12
MIN_WALL_SEED = 20260829
#: The look-ahead for the "is this a wall or a tapering tip?" test is ONE PRINTED
#: LAYER, expressed as a fraction of the nozzle: 0.625 x nozzle is the classic
#: 0.25 mm layer at the default 0.4 mm nozzle, i.e. exactly the constant this
#: module used before, and it keeps the test meaningful at 0.1 and 1.2 mm.
#: A fixed 0.25 mm made the taper test nozzle-dependent in the wrong direction:
#: 04 models a tree as a cone, and a cone's cross-section shrinks by 1/3 of the
#: look-ahead per layer, so with a fixed look-ahead the band of a cone that got
#: *measured* started at a fixed 0.51 mm radius - under one wall for every
#: nozzle above 0.45 mm, which failed every scene that had a visible tree.
WALL_PERSIST_PER_NOZZLE = 0.625
#: The look-ahead at the default 0.4 mm nozzle, mm.  See :func:`wall_persist_mm`.
WALL_PERSIST_MM = 0.25
WALL_PERSIST_RATIO = 0.7

#: Self-intersection spot check budgets.
SI_FACE_SAMPLE = 6000
SI_PAIR_BUDGET = 400_000
SI_SEED = 20260830

#: Parts mode.  A shell smaller than this (mm^3) is boolean debris, not a
#: printable piece of a colour part; the same number ``assemble.prune_debris``
#: uses on the assembled solid.
MIN_PART_BODY_VOLUME_MM3 = 0.01
#: The union of the parts must reproduce the single-mode solid's volume to this
#: relative tolerance and its bounding box to this many millimetres.
PART_UNION_VOLUME_TOLERANCE = 1e-6
PART_UNION_BBOX_TOLERANCE_MM = 1e-6
#: ... and, which is the check that actually has teeth, the two must be the SAME
#: SET: ``vol(parts - single) + vol(single - parts)`` under this many mm^3.
#:
#: Volume and bounding box alone cannot see a partition error - equal and
#: opposite differences cancel exactly, and the relative volume budget above is
#: 0.168 mm^3 on a Chicago plate, seventeen times the 0.0095 mm^3 of building
#: wall the parts used to carry that the single solid did not.  The symmetric
#: difference is two booleans and is exact.
#:
#: The bound is ONE CELL of the pipeline's own snap grid, cubed
#: (``thicken.PRINT_GRID_MM ** 3`` = 1e-6 mm^3): Stage 1 puts every polygon on
#: that grid, so nothing the two modes can legitimately disagree about is bigger
#: than a cell, and the only difference that survives is the sub-nanometre
#: retriangulation noise of performing the union here rather than there.
#: Measured on Chicago at plate 180 and 256 with the partition fixed: 0.0.
PART_UNION_SYMDIFF_MM3 = thicken.PRINT_GRID_MM**3


# --------------------------------------------------------------------------
# Report types
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Check:
    name: str
    passed: bool
    value: Any
    threshold: Any
    message: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "passed": self.passed,
            "value": _jsonable(self.value),
            "threshold": _jsonable(self.threshold),
            "message": self.message,
        }


@dataclass
class ValidationReport:
    checks: list[Check] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return all(c.passed for c in self.checks)

    @property
    def failed(self) -> list[str]:
        return [c.name for c in self.checks if not c.passed]

    def get(self, name: str) -> Check | None:
        for c in self.checks:
            if c.name == name:
                return c
        return None

    def value_of(self, name: str, default: Any = None) -> Any:
        check = self.get(name)
        return default if check is None else check.value

    def error_text(self) -> str | None:
        """The message for ``BakeResult.error``, naming the failing check."""
        bad = [c for c in self.checks if not c.passed]
        if not bad:
            return None
        head = bad[0]
        rest = f" (also: {', '.join(c.name for c in bad[1:])})" if len(bad) > 1 else ""
        return f"validator '{head.name}' failed: {head.message}{rest}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "failed": self.failed,
            "checks": [c.to_dict() for c in self.checks],
        }

    def to_table(self) -> str:
        name_w = max(6, *(len(c.name) for c in self.checks)) if self.checks else 6
        value_w = 22
        rows = [
            f"{'check'.ljust(name_w)}  {'result':<6}  {'value'.ljust(value_w)}  threshold",
            f"{'-' * name_w}  {'-' * 6}  {'-' * value_w}  {'-' * 20}",
        ]
        for c in self.checks:
            rows.append(
                f"{c.name.ljust(name_w)}  {'PASS' if c.passed else 'FAIL':<6}  "
                f"{_fmt(c.value).ljust(value_w)}  {_fmt(c.threshold)}"
            )
        verdict = "ALL CHECKS PASS" if self.passed else f"FAILED: {', '.join(self.failed)}"
        rows.append("")
        rows.append(verdict)
        # The value/threshold columns say WHICH row failed; only the message says
        # why (which part, which colour, how far out).  Printing it for the
        # failing rows costs nothing when everything passes and is the whole
        # diagnosis when something does not.
        for c in self.checks:
            if not c.passed:
                rows.append(f"  {c.name}: {c.message}")
        return "\n".join(rows)


def _jsonable(value: Any) -> Any:
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _fmt(value: Any) -> str:
    if value is None:
        return "-"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, (int, np.integer)):
        return f"{int(value):,}"
    if isinstance(value, (float, np.floating)):
        v = float(value)
        if not math.isfinite(v):
            return "n/a"
        return f"{v:.4g}"
    return str(value)


# --------------------------------------------------------------------------
# Geometry helpers
# --------------------------------------------------------------------------


def _signed_area(ring: np.ndarray) -> float:
    x, y = ring[:, 0], ring[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def _cross_section_polygons(section: Any) -> list[Polygon]:
    """A ``manifold3d.CrossSection`` -> shapely polygons, one per solid region."""
    out: list[Polygon] = []
    for piece in section.decompose():
        rings = piece.to_polygons()
        shells = [r for r in rings if _signed_area(r) > 0.0]
        holes = [r for r in rings if _signed_area(r) < 0.0]
        if not shells:
            continue
        poly = Polygon(shells[0], holes)
        if len(shells) > 1:  # defensive: decompose gives one shell per piece
            poly = shapely.union_all([Polygon(s) for s in shells])
            if holes:
                poly = poly.difference(shapely.union_all([Polygon(h) for h in holes]))
        for part in _polygons(poly if poly.is_valid else shapely.make_valid(poly)):
            if part.area > 0.0:
                out.append(part)
    return out


def manifold_from_mesh(mesh: trimesh.Trimesh) -> Any | None:
    """Re-import a trimesh into ``manifold3d``, or None if it is not a solid.

    ``np.array(..., order="C")`` and not ``np.ascontiguousarray``: trimesh hands
    out a READ-ONLY ``TrackedArray`` for ``vertices``, ``ascontiguousarray``
    passes a read-only array straight through when no conversion is needed, and
    manifold3d's nanobind binding refuses one - so this function used to return
    None for every mesh it was given, including a plain cube.  Nothing crashed,
    because every caller has a fallback: ``_part_bodies`` fell back to trimesh's
    connected components (and to the WHOLE part's volume as its "smallest
    shell", which made the debris half of the ``bodies`` row vacuous) and
    ``make_slicer`` fell back to ``trimesh.section``, the path DECISIONS [P3]
    documents as the inferior one.  ``np.array`` always copies, so the array it
    hands over is writable.
    """
    from manifold3d import Error, Manifold, Mesh64

    try:
        solid = Manifold(
            Mesh64(
                np.array(mesh.vertices, dtype=np.float64, order="C"),
                np.array(mesh.faces, dtype=np.uint64, order="C"),
            )
        )
    except Exception:
        return None
    return solid if solid.status() == Error.NoError else None


def make_slicer(mesh: trimesh.Trimesh, manifold: Any = None):
    """A ``z -> list[Polygon]`` cross-section function for the min-wall probe.

    Prefers ``manifold3d``'s exact ``Manifold.slice``: a horizontal cut through
    two solids that touch at a single point (two preserved towers standing on
    one block do exactly that) comes out of ``trimesh.section`` as a
    self-intersecting ring, and *any* even-odd nesting of that ring soup reads
    the courtyard next to the pinch as solid and the tower as a sliver -
    a min-wall failure with no physical cause.  ``Manifold.slice`` is exact,
    keeps holes as holes, and is ~5x faster.  ``trimesh.section`` remains the
    fallback for a mesh manifold3d refuses to import (which the ``manifold``
    check has already failed on anyway).
    """
    from manifold3d import Error

    solid = manifold if manifold is not None and manifold.status() == Error.NoError else None
    if solid is None:
        solid = manifold_from_mesh(mesh)
    if solid is not None:
        return lambda z: _cross_section_polygons(solid.slice(float(z)))
    return lambda z: section_polygons(mesh, z)


def section_polygons(mesh: trimesh.Trimesh, z: float) -> list[Polygon]:
    """Solid regions of the horizontal cross-section at ``z``, with holes.

    ``trimesh.section`` gives the closed 3D polylines.  Turning that ring soup
    into solid regions needs even-odd nesting *and* tolerance for a ring that
    self-touches (a building with a notch produces exactly that), so the
    nesting is done by ``manifold3d.CrossSection`` with ``FillRule.EvenOdd``
    and ``decompose()`` - the same Clipper2 code the bake itself runs - rather
    than by hand or through ``Path2D.polygons_full`` (which needs ``rtree``,
    an optional trimesh dependency this service does not carry).
    """
    try:
        sec = mesh.section(plane_normal=(0.0, 0.0, 1.0), plane_origin=(0.0, 0.0, float(z)))
    except Exception:  # a slice that hits no face
        return []
    if sec is None:
        return []

    contours: list[np.ndarray] = []
    for path in sec.discrete:
        pts = np.asarray(path, dtype=np.float64)[:, :2]
        if len(pts) >= 4 and np.allclose(pts[0], pts[-1]):
            pts = pts[:-1]
        if len(pts) < 3:
            continue
        contours.append(np.ascontiguousarray(pts))
    if not contours:
        return []

    from manifold3d import CrossSection, FillRule

    return _cross_section_polygons(CrossSection(contours, FillRule.EvenOdd))


def _polygons(geom) -> list[Polygon]:
    if geom is None or geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    if geom.geom_type in ("MultiPolygon", "GeometryCollection"):
        out: list[Polygon] = []
        for part in geom.geoms:
            out.extend(_polygons(part))
        return out
    return []


def wall_persist_mm(min_wall_mm: float) -> float:
    """One printed layer, in mm: the look-ahead of the tapering-tip test.

    Derived from ``min_wall_mm`` (which is ``2 * nozzle``) so the probe needs no
    extra argument, and floored at nothing - a 0.1 mm nozzle gets a 0.0625 mm
    look-ahead, which is what a 0.1 mm nozzle prints.
    """
    nozzle = float(min_wall_mm) / T.MIN_WALL_NOZZLES
    return WALL_PERSIST_PER_NOZZLE * nozzle


def body_count(mesh: trimesh.Trimesh, manifold: Any = None) -> int:
    """Disconnected shells in the solid: ``manifold3d`` first, trimesh second."""
    if manifold is not None:
        try:
            return max(1, len(manifold.decompose()))
        except Exception:  # pragma: no cover - manifold3d always decomposes
            pass
    try:
        return int(mesh.body_count)
    except Exception:  # pragma: no cover - needs scipy, which is a hard dep
        return 1


# --------------------------------------------------------------------------
# Self-intersection spot check
# --------------------------------------------------------------------------


def _edge_topology(mesh: trimesh.Trimesh) -> tuple[int, int]:
    """(edges not shared by exactly two faces, duplicate triangles)."""
    edges = np.sort(mesh.edges_sorted, axis=1)
    _uniq, counts = np.unique(edges, axis=0, return_counts=True)
    bad_edges = int((counts != 2).sum())
    faces = np.sort(np.asarray(mesh.faces), axis=1)
    _uf, fcounts = np.unique(faces, axis=0, return_counts=True)
    dupes = int((fcounts - 1).sum())
    return bad_edges, dupes


def _segments_hit_triangles(
    origins: np.ndarray, targets: np.ndarray, tri: np.ndarray
) -> np.ndarray:
    """Vectorised Moller-Trumbore segment/triangle test (strictly interior)."""
    eps = 1e-12
    v0, v1, v2 = tri[:, 0], tri[:, 1], tri[:, 2]
    e1 = v1 - v0
    e2 = v2 - v0
    d = targets - origins
    pvec = np.cross(d, e2)
    det = np.einsum("ij,ij->i", e1, pvec)
    ok = np.abs(det) > eps
    inv = np.zeros_like(det)
    inv[ok] = 1.0 / det[ok]
    tvec = origins - v0
    u = np.einsum("ij,ij->i", tvec, pvec) * inv
    qvec = np.cross(tvec, e1)
    v = np.einsum("ij,ij->i", d, qvec) * inv
    t = np.einsum("ij,ij->i", e2, qvec) * inv
    return ok & (u > eps) & (v > eps) & (u + v < 1.0 - eps) & (t > eps) & (t < 1.0 - eps)


def _sampled_self_intersections(mesh: trimesh.Trimesh, seed: int = SI_SEED) -> tuple[int, int]:
    """(intersecting pairs found, pairs tested) over a deterministic sample."""
    faces = np.asarray(mesh.faces)
    n = len(faces)
    if n < 2:
        return 0, 0
    rng = np.random.default_rng(seed)
    if n > SI_FACE_SAMPLE:
        idx = np.sort(rng.choice(n, SI_FACE_SAMPLE, replace=False))
    else:
        idx = np.arange(n)
    tris = mesh.vertices[faces[idx]]
    lo = tris.min(axis=1)
    hi = tris.max(axis=1)

    span = float(np.max(hi - lo)) if len(idx) else 0.0
    cell = max(span * 4.0, 1e-6)
    keys = np.floor(lo / cell).astype(np.int64)
    buckets: dict[tuple[int, int, int], list[int]] = {}
    for k, key in enumerate(map(tuple, keys.tolist())):
        buckets.setdefault(key, []).append(k)

    pairs_a: list[int] = []
    pairs_b: list[int] = []
    budget = SI_PAIR_BUDGET
    for key, members in buckets.items():
        neighbours: list[int] = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    neighbours.extend(
                        buckets.get((key[0] + dx, key[1] + dy, key[2] + dz), ())
                    )
        for a in members:
            for b in neighbours:
                if b <= a:
                    continue
                pairs_a.append(a)
                pairs_b.append(b)
                budget -= 1
                if budget <= 0:
                    break
            if budget <= 0:
                break
        if budget <= 0:
            break
    if not pairs_a:
        return 0, 0

    a = np.asarray(pairs_a)
    b = np.asarray(pairs_b)
    # AABB rejection
    keep = np.all(lo[a] <= hi[b], axis=1) & np.all(lo[b] <= hi[a], axis=1)
    a, b = a[keep], b[keep]
    if len(a) == 0:
        return 0, 0
    # Faces that share a vertex always touch; that is adjacency, not a crossing.
    fa, fb = faces[idx][a], faces[idx][b]
    shares = (fa[:, :, None] == fb[:, None, :]).any(axis=(1, 2))
    a, b = a[~shares], b[~shares]
    if len(a) == 0:
        return 0, len(keep)

    ta, tb = tris[a], tris[b]
    hit = np.zeros(len(a), dtype=bool)
    for i, j in ((0, 1), (1, 2), (2, 0)):
        hit |= _segments_hit_triangles(ta[:, i], ta[:, j], tb)
        hit |= _segments_hit_triangles(tb[:, i], tb[:, j], ta)
    return int(hit.sum()), int(len(a))


# --------------------------------------------------------------------------
# Min wall
# --------------------------------------------------------------------------


def recess_probe_zs(params: T.ParamsLike, min_wall_mm: float) -> list[float]:
    """Deterministic Z heights inside every recess band, print mm.

    The random stratified slices cover the model uniformly, so on a 40-51 mm
    Chicago they land in the 0.5 mm water band (or the 0.6 mm engraving band)
    only by luck: whether Stage 4 sees an unprintable ridge *of base* between
    two recesses, or a rind left where a recess stops short of the plate edge,
    was a coin toss.  Those bands are exactly where that failure class lives,
    so each one also gets a slice of its own, every run.

    The height is the midpoint of ``[band_bottom, band_top - persist]`` rather
    than of the band itself, so the "is this a wall or a tapering tip?"
    look-ahead at ``z + persist`` still lands inside the same band: at the band
    midpoint the look-ahead would land exactly on the base top, where the
    region does not persist and would be skipped.  A band shallower than one
    look-ahead cannot be probed that way at all and is left to the random
    slices.
    """
    persist = wall_persist_mm(min_wall_mm)
    base_top = T.base_top_mm(params)
    depths: list[float] = []
    water_z = T.water_z_mm(params)
    if water_z is not None and water_z < 0.0:
        depths.append(-water_z)
    road_z = T.road_z_mm(params)
    if road_z is not None and road_z < 0.0:
        depths.append(-road_z)
    zs: list[float] = []
    for depth in depths:
        if depth <= persist:
            continue
        z = base_top - (depth + persist) / 2.0
        if z > 0.0:
            zs.append(z)
    return sorted(set(zs))


def _min_wall_probe(
    mesh: trimesh.Trimesh,
    min_wall_mm: float,
    slices: int = MIN_WALL_SLICES,
    manifold: Any = None,
    extra_zs: Sequence[float] = (),
    skip_bands: Sequence[tuple[float, float]] = (),
) -> tuple[float, int, int, int]:
    """(narrowest wall, failing regions, regions measured, slices skipped).

    ``skip_bands`` are Z ranges this probe must not judge, and today there is
    exactly one caller for it: the band occupied by the UNDERSIDE pockets (the
    maker's mark, the keyhole, the magnet pockets).  The "is this a wall?" test
    below looks one printed layer UPWARD, which correctly excludes a roof - a
    region with nothing above it - but a pocket cut into the bottom face is the
    mirror image: the plate above it is solid, so the ridge between two letters
    of the mark persists upward perfectly and gets measured as a free-standing
    wall, which it is not.  Those bands are judged by the purpose-built
    ``base_floor`` validator instead, which asks the question that actually
    matters there (is there a millimetre of plate over the pocket?).  With no
    underside feature the list is empty and nothing about the probe changes.
    """
    z_lo = float(mesh.bounds[0][2])
    z_hi = float(mesh.bounds[1][2])
    persist = wall_persist_mm(min_wall_mm)
    if z_hi - z_lo <= 2.0 * persist:
        return math.inf, 0, 0, 0

    slicer = make_slicer(mesh, manifold)
    rng = np.random.default_rng(MIN_WALL_SEED)
    if slices > 0:
        edges = np.linspace(z_lo + 1e-3, z_hi - 1e-3, slices + 1)
        zs = edges[:-1] + rng.random(slices) * np.diff(edges)
    else:
        zs = np.empty(0, dtype=float)
    inside = [z for z in extra_zs if z_lo + 1e-3 < z < z_hi - 1e-3]
    if inside:
        zs = np.concatenate([zs, np.asarray(inside, dtype=float)])

    # The same noise floor Stage 1's repair uses, so the gate cannot measure an
    # appendage the repair was blind to (and vice versa).
    min_detail = min_wall_mm * T.MIN_DETAIL_NOZZLES / T.MIN_WALL_NOZZLES
    area_floor = thicken.residue_area_floor(min_detail)
    fail_at = MIN_WALL_FAIL_FACTOR * min_wall_mm
    smallest = math.inf
    failing = 0
    measured = 0
    skipped = 0
    for z in zs.tolist():
        if any(lo <= z <= hi for lo, hi in skip_bands):
            skipped += 1
            continue
        regions = slicer(z)
        if not regions:
            continue
        above = slicer(z + persist)
        above_union = shapely.union_all(above) if above else None
        for region in regions:
            if above_union is None:
                continue
            kept = region.intersection(above_union).area
            if kept < WALL_PERSIST_RATIO * region.area:
                continue  # a roof or a tapering tip, not a wall
            measured += 1
            width = thicken.narrowest_width(region, min_wall_mm, area_floor)
            smallest = min(smallest, width)
            if width < fail_at:
                failing += 1
    return smallest, failing, measured, skipped


# --------------------------------------------------------------------------
# Parts mode (PrintParams v2, color_mode="parts")
# --------------------------------------------------------------------------


def _part_bodies(mesh: trimesh.Trimesh) -> tuple[int, float]:
    """(shells, smallest shell volume mm^3) of one colour part.

    ``manifold3d`` decomposes exactly and gives a signed volume per shell; a
    mesh it refuses to import is judged by trimesh's connected components with
    no per-shell volume (the ``part_meshes`` row fails it anyway).
    """
    solid = manifold_from_mesh(mesh)
    if solid is not None:
        try:
            pieces = solid.decompose()
        except Exception:  # pragma: no cover - manifold3d always decomposes
            pieces = []
        if pieces:
            return len(pieces), min(float(p.volume()) for p in pieces)
    return body_count(mesh), float(mesh.volume)


def single_body_check(mesh: trimesh.Trimesh, manifold: Any = None) -> Check:
    """01/A6: the model must open in a slicer as ONE object, not one plus debris.

    04 stage 4's ``watertight`` row deliberately tolerates several bodies - its
    Euler test is ``even and <= 2 * body_count`` - because it judges an arbitrary
    mesh.  A finished FrameCraft plate is not arbitrary: it is one connected
    solid sitting on the bed, and a floating island is exactly the failure a
    slicer surfaces to the user.  This row was for a long time only in
    ``app/cli.py``, i.e. only under ``make validate``, so the bake could and did
    mark a job ``done`` on a model with three bodies - a frameless plate with two
    embossed letters hovering over it (v2-03 audit, finding 2).
    """
    bodies = body_count(mesh, manifold)
    return Check(
        name="bodies",
        passed=bodies == 1,
        value=bodies,
        threshold=1,
        message=(
            "one connected solid, so a slicer shows a single object"
            if bodies == 1
            else f"{bodies} disconnected bodies; a slicer would show {bodies} objects "
            "(a floating island or leftover boolean debris)"
        ),
    )


def validate_parts(
    parts: Sequence[tuple[str, trimesh.Trimesh]],
    *,
    union: trimesh.Trimesh | None = None,
    reference: trimesh.Trimesh | None = None,
    components: int | None = None,
    union_solid: Any = None,
    reference_solid: Any = None,
) -> list[Check]:
    """The extra Stage 4 rows a ``color_mode="parts"`` model has to pass.

    Purely ADDITIVE: single mode produces none of these rows and every rule it
    already had still applies, to the whole solid, unchanged.

    * ``bodies`` - every part is a non-empty solid with no debris shell, and the
      file declares exactly one mesh object per part (``components``).  04's
      single-body rule is a rule about what a SLICER shows, and in parts mode
      the slicer shows one object made of these parts; the assembled union is
      still required to be one connected shell, which is where that rule lives
      now.  A *part* cannot be required to be one shell: a city's buildings
      layer is hundreds of separate blocks by construction, and 04 stage 1's
      whole job is to decide which of them merge.
    * ``part_meshes`` - each part on its own is manifold, watertight, has
      positive volume and no degenerate face.
    * ``parts_union`` - the manifold union of the parts IS the single-mode
      solid: same volume to ``PART_UNION_VOLUME_TOLERANCE`` relative and the
      same bounding box.  This is what makes it legitimate to run the rest of
      the gate on one of the two.
    """
    checks: list[Check] = []
    names = [name for name, _mesh in parts]

    shells = 0
    empty: list[str] = []
    debris: list[str] = []
    for name, mesh in parts:
        count, smallest = _part_bodies(mesh)
        shells += count
        if count == 0 or len(mesh.faces) == 0:
            empty.append(name)
        elif smallest < MIN_PART_BODY_VOLUME_MM3:
            debris.append(f"{name} ({smallest:.4g} mm^3)")
    union_bodies = None if union is None else body_count(union)
    bodies_ok = (
        bool(parts)
        and not empty
        and not debris
        and (components is None or components == len(parts))
        and (union_bodies is None or union_bodies == 1)
    )
    detail = []
    if empty:
        detail.append(f"empty part(s): {', '.join(empty)}")
    if debris:
        detail.append(f"debris shell(s): {', '.join(debris)}")
    if components is not None and components != len(parts):
        detail.append(f"{components} components for {len(parts)} parts")
    if union_bodies is not None and union_bodies != 1:
        detail.append(f"the assembled union is {union_bodies} disconnected bodies")
    checks.append(
        Check(
            name="bodies",
            passed=bodies_ok,
            value=f"{len(parts)} parts, {shells} shells"
            + ("" if union_bodies is None else f", union {union_bodies}"),
            threshold="one mesh object per part, no debris, union is one solid",
            message=(
                "every part is a solid piece of one connected object"
                if bodies_ok
                else "; ".join(detail) or "no parts"
            ),
        )
    )

    bad: list[str] = []
    total_triangles = 0
    for name, mesh in parts:
        total_triangles += int(len(mesh.faces))
        reasons = []
        if not bool(mesh.is_watertight):
            reasons.append("not watertight")
        if not bool(mesh.is_winding_consistent):
            reasons.append("inconsistent winding")
        volume = float(mesh.volume)
        if not (volume > 0.0 and volume == abs(volume)):
            reasons.append(f"volume {volume:.6g}")
        degenerate = int((mesh.area_faces < DEGENERATE_FACE_AREA).sum())
        if degenerate:
            reasons.append(f"{degenerate} degenerate faces")
        if reasons:
            bad.append(f"{name}: {', '.join(reasons)}")
    # 04 stage 4's triangle budget, on the geometry that actually ships in parts
    # mode.  `enforce_triangle_budget` decimates the SINGLE-mode solid (which
    # becomes the .stl) and deliberately leaves the parts alone so the partition
    # survives, so the budget has to be re-asserted here or a model that
    # decimated would ship a .3mf over the budget with `triangle_budget PASS`.
    if total_triangles >= TRIANGLE_BUDGET:
        bad.append(
            f"the parts hold {total_triangles:,} triangles, over 04's "
            f"{TRIANGLE_BUDGET:,} budget (the .stl is decimated; the parts are not)"
        )
    checks.append(
        Check(
            name="part_meshes",
            passed=not bad and bool(parts),
            value=f"{len(parts)} parts, {total_triangles:,} triangles"
            + (f" ({', '.join(names)})" if len(names) <= 8 else ""),
            threshold="each manifold, watertight, positive volume, no degenerate face",
            message=(
                "every part is a valid solid on its own"
                if not bad and parts
                else "; ".join(bad) or "no parts to judge"
            ),
        )
    )

    if union is not None and reference is not None:
        vu = float(union.volume)
        vr = float(reference.volume)
        volume_ok = abs(vu - vr) <= PART_UNION_VOLUME_TOLERANCE * max(abs(vr), 1.0)
        bbox_delta = float(
            np.max(np.abs(np.asarray(union.bounds) - np.asarray(reference.bounds)))
        )
        bbox_ok = bbox_delta <= PART_UNION_BBOX_TOLERANCE_MM
        extra, missing, symdiff_ok = symmetric_difference_mm3(
            union, reference, union_solid=union_solid, reference_solid=reference_solid
        )
        detail: list[str] = []
        if not volume_ok:
            detail.append(f"volume differs by {abs(vu - vr):.6g} mm^3")
        if not bbox_ok:
            detail.append(f"bounding box differs by {bbox_delta:.3g} mm")
        if not symdiff_ok:
            detail.append(
                f"the parts hold {extra:.6g} mm^3 the single solid does not and are "
                f"missing {missing:.6g} mm^3 of it"
            )
        passed = bool(volume_ok and bbox_ok and symdiff_ok)
        checks.append(
            Check(
                name="parts_union",
                passed=passed,
                value=f"{vu:,.4f} mm^3 vs {vr:,.4f} mm^3, symmetric difference "
                f"{extra + missing:.3g} mm^3, bbox delta {bbox_delta:.2e} mm",
                threshold=(
                    f"same set to {PART_UNION_SYMDIFF_MM3:g} mm^3, volume within "
                    f"{PART_UNION_VOLUME_TOLERANCE:g} relative, bbox within "
                    f"{PART_UNION_BBOX_TOLERANCE_MM:g} mm"
                ),
                message=(
                    "the union of the parts IS the single-colour solid, set for set"
                    if passed
                    else "the parts do not partition the model: " + "; ".join(detail)
                ),
            )
        )
    return checks


def symmetric_difference_mm3(
    union: trimesh.Trimesh,
    reference: trimesh.Trimesh,
    union_solid: Any = None,
    reference_solid: Any = None,
) -> tuple[float, float, bool]:
    """``(vol(union - reference), vol(reference - union), within tolerance)``.

    The only test that can actually see a partition error.  Volume and bounding
    box cancel equal-and-opposite differences exactly; this asks whether the two
    solids are the same SET, which is what "the parts partition the model" means.

    Returns ``(inf, inf, False)`` if either solid cannot be handed to manifold3d,
    because an unanswerable question is not a pass.
    """
    from manifold3d import Manifold, OpType

    # The Manifolds themselves when the caller still holds them (the bake does):
    # re-importing a mesh is a round trip through float64 triangles that a
    # nanometre-wide seam sliver can fail outright, and an unanswerable question
    # is not a pass.
    a = union_solid if union_solid is not None else manifold_from_mesh(union)
    b = reference_solid if reference_solid is not None else manifold_from_mesh(reference)
    if a is None or b is None:
        return math.inf, math.inf, False
    extra = float(Manifold.batch_boolean([a, b], OpType.Subtract).volume())
    missing = float(Manifold.batch_boolean([b, a], OpType.Subtract).volume())
    return extra, missing, (extra + missing) <= PART_UNION_SYMDIFF_MM3


# --------------------------------------------------------------------------
# Frame lettering and the underside (PrintParams v2)
# --------------------------------------------------------------------------

#: How far inside a pocket's outline the ``base_floor`` probe measures, in mm.
#: The pocket's own wall is a vertical face and a slice through it lands on the
#: outline itself; stepping in by a twentieth of a millimetre asks about the
#: material, not about the boundary.
POCKET_PROBE_INSET_MM = 0.05
#: Fractions of the required roof at which every pocket is probed.  Three
#: slices, so the roof has to be solid THROUGHOUT the millimetre above the
#: pocket - one slice just above the pocket would say nothing about a recess
#: cutting down into that millimetre from the top.
POCKET_PROBE_FRACTIONS = (0.1, 0.5, 0.9)
#: Uncovered area, in mm^2, that still counts as covered.  A slice of a
#: cylinder is a polygon, not a circle, so a few square micrometres of chord
#: sagitta is not a breach.
POCKET_COVER_TOLERANCE_MM2 = 1e-3


def frame_band_polygon(params: T.ParamsLike) -> Polygon | Any:
    """The frame lip's own footprint, in model millimetres.

    The model is centred on X and Y and sits at z = 0 (04 stage 2.7), so plate
    coordinates and model coordinates are the same thing.
    """
    frame = T.frame_geometry_mm(params)
    outer = shapely.box(
        -frame.outer_half_mm, -frame.outer_half_mm, frame.outer_half_mm, frame.outer_half_mm
    )
    inner = shapely.box(
        -frame.inner_half_mm, -frame.inner_half_mm, frame.inner_half_mm, frame.inner_half_mm
    )
    return outer.difference(inner)


def lettering_probe_zs(params: T.ParamsLike) -> list[tuple[float, str]]:
    """``(z, mode)`` for every band that carries text or an ornament, print mm.

    An engraved band is probed at half its depth below the lip's top face and an
    embossed one at half its height above it, i.e. in the middle of the material
    that makes the letter - which is where the strokes are widest and the ridges
    between them narrowest.
    """
    if not bool(params.frame):
        return []
    lip_top = T.base_top_mm(params) + T.FRAME_LIP_MM
    out: set[tuple[float, str]] = set()
    for engraving in getattr(params, "engravings", None) or ():
        depth = float(getattr(engraving, "depth_mm", None) or 0.4)
        if depth <= 0.0:
            continue
        if str(getattr(engraving, "mode", "engrave")) == "emboss":
            out.add((lip_top + depth / 2.0, "emboss"))
        else:
            out.add((lip_top - depth / 2.0, "engrave"))
    ornament = False
    if bool(getattr(getattr(params, "north_arrow", None), "enabled", False)):
        ornament = True
    if bool(getattr(getattr(params, "scale_bar", None), "enabled", False)):
        ornament = True
    if ornament:
        out.add((lip_top - T.ENGRAVE_MAX_MM / 2.0, "engrave"))
    return sorted(out)


def underside_probe_zs(params: T.ParamsLike) -> list[tuple[float, str]]:
    """``(z, "underside")`` for the mark cut into the bottom of the plate.

    The mark is text, and its strokes and ridges are exactly as printable-or-not
    as the ones on the lip; they were measured by NO Stage 4 row (``min_wall``
    skips the pocket band and hands it to ``base_floor``, which only asks
    whether the plate above each pocket is still solid - v2-03 audit, finding
    10).  Probed at half the mark's depth, where the strokes are widest and the
    ridges between them narrowest, exactly as on the lip.
    """
    mark = getattr(params, "underside_mark", None)
    if not bool(getattr(mark, "enabled", False)):
        return []
    depth = T.UNDERSIDE_MARK_DEPTH_MM
    if depth <= 0.0:
        return []
    return [(depth / 2.0, "underside")]


#: The context the validator expands ``{token}``s against when it asks the
#: shared layout WHICH pieces of text will be cut.  A ``.3mf`` carries its
#: parameters (the sidecar) but not the scene they were baked from, so the
#: lat/lon, the scale, the radius and the building count are not recoverable
#: here - only ``{city}``, which is a PrintParams field, is exact.
#:
#: Every value below is therefore chosen to make the expansion at least as LONG
#: as any real one, and a longer string is harder to fit, never easier
#: (``fit_text`` shrinks until it fits or refuses).  So "this context says the
#: piece is not refused" implies the real one is not refused either, and the
#: expected-piece count below can only ever UNDER-count.  Under-counting costs
#: coverage; over-counting would fail a bake that was right to cut nothing.
#:
#: * ``-89.9999 / -179.9999``  the longest ``{coords}``/``{lat}``/``{lon}``
#: * ``0.02`` mm per ground metre  ``{scale}`` = ``1:50,000``, longer than any
#:   scale a 100-256 mm plate over a 200-2 000 m radius can produce, and the
#:   auto scale bar it implies is the WIDEST the window allows (2 000 m -> 40 mm),
#:   so an engraving sharing that edge is judged against the least room
#: * ``99999`` m and ``999999`` buildings  the longest ``{radius}``/``{buildings}``
#: * the date is always 10 characters, so any ISO date is exact
VALIDATOR_CTX_LAT = -89.9999
VALIDATOR_CTX_LON = -179.9999
VALIDATOR_CTX_SCALE_MM_PER_M = 0.02
VALIDATOR_CTX_RADIUS_M = 99999.0
VALIDATOR_CTX_BUILDINGS = 999999
VALIDATOR_CTX_DATE = "2026-08-30"


def validator_token_context(params: T.ParamsLike) -> Any:
    """The worst-case :class:`app.geom.tokens.TokenContext` described above."""
    from app.geom import tokens

    return tokens.TokenContext(
        lat=VALIDATOR_CTX_LAT,
        lon=VALIDATOR_CTX_LON,
        scale_mm_per_m=VALIDATOR_CTX_SCALE_MM_PER_M,
        radius_m=VALIDATOR_CTX_RADIUS_M,
        date=VALIDATOR_CTX_DATE,
        buildings=VALIDATOR_CTX_BUILDINGS,
        city=str(getattr(params, "city_label", "") or ""),
    )


def lettering_expected_pieces(params: T.ParamsLike) -> list[tuple[float, str, str]]:
    """``(z, mode, label)`` for every piece of text the LAYOUT says will be cut.

    :func:`lettering_probe_zs` answers "what did the parameters ASK for", which
    is why a row exists at all.  This answers "what did the shared layout AGREE
    to", which is what the geometry then has to show: a piece the layout did not
    refuse and that leaves no stroke at its own band is text that vanished
    silently, and ``0.000 mm stroke  PASS`` is the wrong verdict for it (v2-07
    audit, finding 2).

    A refusal is the layout's own (``TextFit.refused``, an empty fit after the
    unsupported characters are dropped, the frame being off) - the same test
    ``lettering.build`` makes before it cuts, so the two cannot disagree about
    what should be there.  The z values are computed with the same expressions
    as :func:`lettering_probe_zs` and :func:`underside_probe_zs`, so they land
    on exactly the same bands.
    """
    layout = T.lettering_layout(params, validator_token_context(params))
    out: list[tuple[float, str, str]] = []
    lip_top = T.base_top_mm(params) + T.FRAME_LIP_MM
    if bool(params.frame):
        sources = T.engraving_list(params)
        for placed in layout.engravings:
            fit = placed.fit
            if fit is None or fit.refused or not fit.text:
                continue
            source = sources[placed.index] if placed.index < len(sources) else None
            depth = float(getattr(source, "depth_mm", None) or 0.4)
            if depth <= 0.0:
                continue
            label = f"engraving {placed.index + 1} ({placed.edge})"
            if str(placed.mode) == "emboss":
                out.append((lip_top + depth / 2.0, "emboss", label))
            else:
                out.append((lip_top - depth / 2.0, "engrave", label))
        ornament_z = lip_top - T.ENGRAVE_MAX_MM / 2.0
        if layout.north_arrow.enabled:
            out.append((ornament_z, "engrave", "the north arrow"))
        if layout.scale_bar.enabled:
            out.append((ornament_z, "engrave", "the scale bar"))
    mark = layout.underside_mark
    if mark.enabled and mark.fit is not None and not mark.fit.refused and mark.fit.text:
        depth = float(mark.depth_mm or T.UNDERSIDE_MARK_DEPTH_MM)
        if depth > 0.0:
            out.append((depth / 2.0, "underside", "the underside mark"))
    return out


def validate_lettering(
    mesh: trimesh.Trimesh, params: T.ParamsLike, manifold: Any = None
) -> list[Check]:
    """The ``lettering`` row: every stroke and every complement ridge measured.

    The band is sliced in the middle of the material that forms the letters and
    the slice is clipped to the frame lip's own footprint (the city stops
    0.05 mm short of it, so nothing else can get into the measurement).  Then:

    * a **stroke** is a groove for engraved text (the lip minus the slice) and a
      standing island for embossed text.  It fails under ``0.9 * min_wall``,
      which is 04 stage 4's own rule and the number Stage 1 widened every glyph
      to;
    * a **complement ridge** is what is left of the lip between two strokes.  It
      fails under ``0.9 * min_detail`` - ONE nozzle - and is reported whenever it
      is under a wall.  The floor is a nozzle rather than a wall because the gap
      between two letters of a 5 mm face is about half a millimetre at every
      size a 6 mm lip can hold: a wall-high floor would not print better text,
      it would merge every pair of letters into an unreadable smear (the same
      reasoning, and the same measure, as ``thicken.merge_recess_ridges``, which
      is what actually swallows a sub-nozzle ridge before it is ever printed).

    Both measurements use ``thicken.narrowest_width``, the inscribed-circle
    measure Stage 1 repaired with and the ``min_wall`` validator reports with.

    The row also fails when a piece the layout AGREED to cut left no stroke at
    its own band at all (:func:`lettering_expected_pieces`).  Measuring only the
    narrowest stroke made "nothing was cut" indistinguishable from "everything
    was cut perfectly": both report ``0.000 mm stroke`` and no ``bad`` entry, so
    a regression that requested every ornament and produced none passed this row
    and the gate that greps it (v2-07 audit, finding 2).  A parameter set that
    asked for nothing, or whose every piece the layout refused, still passes with
    zero - refusing text is a documented outcome, losing it is not.
    """
    bands = lettering_probe_zs(params) + underside_probe_zs(params)
    if not bands:
        return []
    from app.geom import lettering

    expected: dict[tuple[float, str], list[str]] = {}
    for z, mode, label in lettering_expected_pieces(params):
        expected.setdefault((z, mode), []).append(label)
    pieces = sum(len(labels) for labels in expected.values())
    strokes_at: dict[tuple[float, str], int] = {}

    min_wall = T.min_wall_mm(params)
    min_detail = T.min_detail_mm(params)
    # 04 stage 1's own area floor, which is what the lettering repair measured
    # with: the two have to speak one language or the gate would fail a corner
    # lens the repair was right to ignore (see lettering.text_area_floor).
    area_floor = lettering.text_area_floor(params)
    # An engraved stroke is a VOID and an embossed one is MATERIAL, so they get
    # different floors: one nozzle for the void (below it the groove does not
    # appear at all) and 04's two-perimeter wall for the material.  Same for the
    # complement: the lip between two grooves is material but it is a SURFACE
    # ridge on a solid roof, not a free-standing wall - see
    # thicken.merge_recess_ridges, which swallows anything under a nozzle.
    engrave_fail = MIN_WALL_FAIL_FACTOR * T.text_stroke_target_mm(params, "engrave")
    emboss_fail = MIN_WALL_FAIL_FACTOR * T.text_stroke_target_mm(params, "emboss")
    ridge_fail = MIN_WALL_FAIL_FACTOR * min_detail
    band = frame_band_polygon(params)
    slicer = make_slicer(mesh, manifold)

    narrowest_stroke = math.inf
    narrowest_ridge = math.inf
    strokes = 0
    ridges = 0
    bad: list[str] = []
    for z, mode in bands:
        regions = slicer(z)
        if not regions:
            continue
        if mode == "underside":
            # The underside slice is the whole plate, not the lip band, and the
            # plate's own outline is chamfered - so the region to measure inside
            # is the slice with its holes FILLED.  Anything else would read the
            # chamfer's setback as a groove around the whole perimeter.
            solid = shapely.union_all([r for r in regions])
            area = shapely.union_all(
                [Polygon(piece.exterior) for piece in thicken.explode(solid)]
            )
        else:
            area = band
            solid = shapely.union_all([r for r in regions]).intersection(band)
        if solid.is_empty:
            continue
        if mode == "emboss":
            # Embossed strokes are MATERIAL standing on the lip, so they get
            # 04's minimum wall; the gaps between them are voids and get the
            # same one-nozzle floor as any other void.
            for piece in thicken.explode(solid):
                if piece.area < area_floor:
                    continue
                strokes += 1
                strokes_at[(z, mode)] = strokes_at.get((z, mode), 0) + 1
                width = thicken.narrowest_width(piece, min_wall, area_floor)
                narrowest_stroke = min(narrowest_stroke, width)
                if width < emboss_fail:
                    bad.append(f"embossed stroke {width:.3f} mm at z={z:.2f}")
            for gap in thicken.explode(band.difference(solid)):
                if gap.area < area_floor:
                    continue
                ridges += 1
                width = thicken.narrowest_width(gap, min_detail, area_floor)
                narrowest_ridge = min(narrowest_ridge, width)
                if width < ridge_fail:
                    bad.append(f"embossed gap {width:.3f} mm at z={z:.2f}")
            continue
        for groove in thicken.explode(area.difference(solid)):
            if groove.area < area_floor:
                continue
            strokes += 1
            strokes_at[(z, mode)] = strokes_at.get((z, mode), 0) + 1
            width = thicken.narrowest_width(groove, min_detail, area_floor)
            narrowest_stroke = min(narrowest_stroke, width)
            if width < engrave_fail:
                where = "underside stroke" if mode == "underside" else "engraved stroke"
                bad.append(f"{where} {width:.3f} mm at z={z:.2f}")
        for piece in thicken.explode(solid):
            if piece.area < area_floor:
                continue
            ridges += 1
            width = thicken.narrowest_width(piece, min_detail, area_floor)
            narrowest_ridge = min(narrowest_ridge, width)
            if width < ridge_fail:
                where = "underside ridge" if mode == "underside" else "lip ridge"
                bad.append(f"{where} {width:.3f} mm at z={z:.2f}")

    # Every piece the layout accepted has to show up as material at its own
    # band.  Reported last so a thin stroke - which names a measurement - still
    # heads the message when both are wrong.
    for (z, mode), labels in sorted(expected.items()):
        if strokes_at.get((z, mode), 0) > 0:
            continue
        bad.append(
            f"requested {len(labels)} pieces ({', '.join(labels)}), measured 0 "
            f"strokes at the {mode} band z={z:.2f} mm"
        )

    stroke_value = 0.0 if not math.isfinite(narrowest_stroke) else narrowest_stroke
    ridge_value = 0.0 if not math.isfinite(narrowest_ridge) else narrowest_ridge
    passed = not bad
    thin_ridge = math.isfinite(narrowest_ridge) and narrowest_ridge < min_wall
    message = (
        f"narrowest stroke {stroke_value:.3f} mm over {strokes}, narrowest lip ridge "
        f"{ridge_value:.3f} mm over {ridges}, on {len(bands)} text band(s) carrying "
        f"{pieces} piece(s) the layout accepted"
        if passed
        else "; ".join(bad[:4]) + (f"; +{len(bad) - 4} more" if len(bad) > 4 else "")
    )
    if passed and thin_ridge:
        message += (
            f" (a ridge under one wall, {ridge_value:.3f} mm: the letters print but "
            f"they crowd)"
        )
    return [
        Check(
            name="lettering",
            passed=passed,
            value=(
                f"{strokes} strokes of {pieces} piece(s); {stroke_value:.3f} mm "
                f"stroke / {ridge_value:.3f} mm ridge"
            ),
            threshold=(
                f"engraved stroke >= {engrave_fail:.3f} mm, embossed stroke >= "
                f"{emboss_fail:.3f} mm, ridge >= {ridge_fail:.3f} mm"
            ),
            message=message,
        )
    ]


def validate_base_floor(
    mesh: trimesh.Trimesh, params: T.ParamsLike, manifold: Any = None
) -> list[Check]:
    """The ``base_floor`` row: nothing cut from below breaches the plate.

    Every underside pocket - the mark, the keyhole, the magnet pockets - has to
    leave ``HANGER_MIN_ROOF_MM`` of solid plate above it.  That is checked twice
    over: once as arithmetic against the shared
    :func:`app.geom.transform.underside_min_base_mm` (which is also what the bake
    refuses on, before it builds anything), and once on the finished MESH, by
    slicing at three heights inside that millimetre and asserting the pocket's
    own footprint lies inside the solid at each of them.  The mesh half is what
    catches a lake or an engraved road cutting DOWN into the same millimetre from
    the top, which no arithmetic on the base thickness alone can see.
    """
    from app.geom import lettering

    pockets = lettering.underside_pocket_polygons(params)
    if not pockets:
        return []
    roof = T.HANGER_MIN_ROOF_MM
    base_needed = T.underside_min_base_mm(params)
    base = float(params.base_thickness_mm)
    bad: list[str] = []
    if base + 1e-9 < base_needed:
        bad.append(
            f"the base is {base:g} mm and these pockets need {base_needed:g} mm"
        )

    slicer = make_slicer(mesh, manifold)
    probed = 0
    worst = 0.0
    cache: dict[float, Any] = {}
    for kind, footprints, depth in pockets:
        for fraction in POCKET_PROBE_FRACTIONS:
            z = depth + fraction * roof
            if z not in cache:
                regions = slicer(z)
                cache[z] = shapely.union_all(regions) if regions else None
            solid = cache[z]
            for footprint in footprints:
                probe = footprint.buffer(-POCKET_PROBE_INSET_MM)
                if probe.is_empty:
                    continue
                probed += 1
                missing = probe.area if solid is None else probe.difference(solid).area
                worst = max(worst, missing)
                if missing > POCKET_COVER_TOLERANCE_MM2:
                    bad.append(
                        f"{missing:.3f} mm^2 of the {kind} pocket has no plate over it "
                        f"at z={z:.2f} mm"
                    )
    passed = not bad
    return [
        Check(
            name="base_floor",
            passed=passed,
            value=f"{len(pockets)} pocket kind(s), {probed} probes, worst gap {worst:.4g} mm^2",
            threshold=f">= {roof:g} mm of plate above every pocket",
            message=(
                f"every underside pocket keeps {roof:g} mm of plate over it"
                if passed
                else "; ".join(bad[:4]) + (f"; +{len(bad) - 4} more" if len(bad) > 4 else "")
            ),
        )
    ]


# --------------------------------------------------------------------------
# Triangle budget
# --------------------------------------------------------------------------


def enforce_triangle_budget(
    mesh: trimesh.Trimesh,
    budget: int = TRIANGLE_BUDGET,
    target: int = DECIMATION_TARGET,
) -> tuple[trimesh.Trimesh, str | None]:
    """04 stage 4: decimate to ``target`` when the mesh exceeds ``budget``.

    ``trimesh.simplify_quadric_decimation`` is preferred.  It needs the native
    ``fast_simplification`` extension; when that cannot be loaded (this dev host
    blocks the DLL under an Application Control policy, see DECISIONS [P1]) the
    equivalent ``manifold3d`` simplifier is bisected onto the same target, which
    keeps the result manifold by construction.
    """
    faces = len(mesh.faces)
    if faces < budget:
        return mesh, None
    try:
        reduced = mesh.simplify_quadric_decimation(face_count=int(target))
        note = f"decimated from {faces} to {len(reduced.faces)} triangles (quadric)"
        return reduced, note
    except Exception:
        from manifold3d import Manifold, Mesh64

        m = Manifold(
            Mesh64(
                np.ascontiguousarray(mesh.vertices, dtype=np.float64),
                np.ascontiguousarray(mesh.faces, dtype=np.uint64),
            )
        )
        lo, hi = 0.0, float(np.max(mesh.extents)) / 20.0
        best = m
        for _ in range(24):
            mid = (lo + hi) / 2.0
            candidate = m.simplify(mid)
            if candidate.num_tri() > target:
                lo = mid
            else:
                best = candidate
                hi = mid
        out = best.to_mesh64()
        reduced = trimesh.Trimesh(
            vertices=np.asarray(out.vert_properties)[:, :3].astype(np.float64),
            faces=np.asarray(out.tri_verts).astype(np.int64),
            process=False,
            validate=False,
        )
        note = f"decimated from {faces} to {len(reduced.faces)} triangles (manifold3d)"
        return reduced, note


# --------------------------------------------------------------------------
# The gate
# --------------------------------------------------------------------------


def validate(
    mesh: trimesh.Trimesh,
    params: T.ParamsLike,
    *,
    manifold: Any = None,
    slices: int = MIN_WALL_SLICES,
    self_intersection_sample: bool = True,
    max_height_mm: float | None = None,
) -> ValidationReport:
    """Run every 04 stage 4 validator.  All must pass for a job to be ``done``.

    ``max_height_mm`` is the Z ceiling the bounding-box row judges against, and
    it defaults to 04's own :data:`MAX_HEIGHT_MM`.  It exists because the
    ceiling is a property of the PRINTER, not of the product: a P1S has 250 mm
    of gantry and an A1 mini 180, and a bake made for one of them is not
    unprintable because 04's reference figure is 60 (DECISIONS ``[V3-P4-E9]``).
    ``app/cli.py`` reads the resolved number out of the bake sidecar's
    ``max_height_mm`` when the file has one, so a taller bake validates against
    the printer it was made for and everything without a sidecar keeps the
    figure it has always been judged against.
    """
    checks: list[Check] = []

    plate_mm = float(params.plate_mm)
    ceiling_mm = MAX_HEIGHT_MM if max_height_mm is None else float(max_height_mm)
    # 04's ``2 * nozzle``, from the shared transform math rather than spelled
    # out here, so the gate can never measure against a different wall than the
    # one Stage 1 repaired to or the preview HUD advertised (DECISIONS [V2-P1]).
    min_wall_mm = T.min_wall_mm(params)

    watertight = bool(mesh.is_watertight)
    winding = bool(mesh.is_winding_consistent)

    # ---- manifold -------------------------------------------------------
    status_text = "not carried"
    status_ok = True
    if manifold is not None:
        from manifold3d import Error

        status = manifold.status()
        status_ok = status == Error.NoError
        status_text = str(status).replace("Error.", "")
    trimesh_manifold = watertight and winding
    checks.append(
        Check(
            name="manifold",
            passed=bool(status_ok and trimesh_manifold),
            value=f"{status_text}; watertight={watertight} winding={winding}",
            threshold="NoError + watertight + consistent winding",
            message=(
                "manifold3d reports a clean solid and the exported triangles agree"
                if status_ok and trimesh_manifold
                else f"manifold3d status {status_text}, "
                f"watertight={watertight}, winding_consistent={winding}"
            ),
        )
    )

    # ---- watertight -----------------------------------------------------
    bodies = body_count(mesh, manifold)
    euler = int(mesh.euler_number)
    euler_ok = euler % 2 == 0 and euler <= 2 * bodies
    checks.append(
        Check(
            name="watertight",
            passed=bool(watertight and euler_ok),
            value=f"euler={euler} bodies={bodies}",
            threshold=f"closed, even euler <= {2 * bodies}",
            message=(
                "closed surface with an Euler characteristic consistent with the body count"
                if watertight and euler_ok
                else f"is_watertight={watertight}, euler_number={euler}, body_count={bodies}"
            ),
        )
    )

    # ---- volume ---------------------------------------------------------
    volume = float(mesh.volume)
    volume_ok = volume > 0.0 and volume == abs(volume)
    checks.append(
        Check(
            name="volume",
            passed=volume_ok,
            value=volume,
            threshold="> 0 mm^3",
            message=(
                f"{volume:,.1f} mm^3"
                if volume_ok
                else f"volume {volume} is not positive (inverted normals?)"
            ),
        )
    )

    # ---- self-intersection ---------------------------------------------
    bad_edges, dupes = _edge_topology(mesh)
    if self_intersection_sample:
        hits, tested = _sampled_self_intersections(mesh)
    else:
        hits, tested = 0, 0
    si_ok = bad_edges == 0 and dupes == 0 and hits == 0
    checks.append(
        Check(
            name="self_intersection",
            passed=si_ok,
            value=f"{hits} in {tested} sampled pairs; {bad_edges} bad edges; {dupes} dupes",
            threshold="0",
            message=(
                "manifold3d guarantees an intersection-free result for valid inputs "
                "(stage 1 make_valid + oriented rings); edge topology and a sampled "
                "face-pair probe agree"
                if si_ok
                else f"{hits} intersecting sampled face pairs, {bad_edges} non-manifold "
                f"edges, {dupes} duplicate triangles"
            ),
        )
    )

    # ---- bounding box ---------------------------------------------------
    extents = mesh.extents.astype(float)
    limit = plate_mm + PLATE_TOLERANCE_MM
    bbox_ok = bool(extents[0] <= limit and extents[1] <= limit and extents[2] < ceiling_mm)
    checks.append(
        Check(
            name="bounding_box",
            passed=bbox_ok,
            value=f"{extents[0]:.3f} x {extents[1]:.3f} x {extents[2]:.3f} mm",
            threshold=f"x,y <= {limit:.2f} mm; z < {ceiling_mm:.0f} mm",
            message=(
                "fits the selected plate"
                if bbox_ok
                else (
                    f"model is {extents[2]:.1f} mm tall, over the {ceiling_mm:.0f} mm limit; "
                    "lower the building height multipliers"
                    if extents[2] >= ceiling_mm
                    else f"footprint {extents[0]:.2f} x {extents[1]:.2f} mm does not fit a "
                    f"{plate_mm:.0f} mm plate"
                )
            ),
        )
    )

    # ---- sits at zero ---------------------------------------------------
    min_z = float(mesh.bounds[0][2])
    sits_ok = abs(min_z) <= SIT_TOLERANCE_MM
    checks.append(
        Check(
            name="sits_at_zero",
            passed=sits_ok,
            value=min_z,
            threshold=f"|min z| <= {SIT_TOLERANCE_MM}",
            message=("sits flat on the bed" if sits_ok else f"min z is {min_z} mm, not 0"),
        )
    )

    # ---- min wall -------------------------------------------------------
    recess_zs = recess_probe_zs(params, min_wall_mm)
    underside = T.underside_band_mm(params)
    skip_bands = [underside] if underside is not None else []
    smallest, failing, measured, skipped = _min_wall_probe(
        mesh,
        min_wall_mm,
        slices=slices,
        manifold=manifold,
        extra_zs=recess_zs,
        skip_bands=skip_bands,
    )
    slice_count = slices + len(recess_zs) - skipped
    fail_at = min_wall_mm * MIN_WALL_FAIL_FACTOR
    reported = 0.0 if not math.isfinite(smallest) else smallest
    # One measure decides both numbers: `failing` counts the regions whose
    # narrowest wall is under `fail_at` and `reported` is the narrowest of them
    # all, so the verdict and the message can never contradict each other.
    wall_ok = failing == 0
    checks.append(
        Check(
            name="min_wall",
            passed=bool(wall_ok),
            value=reported,
            threshold=fail_at,
            message=(
                f"narrowest wall {reported:.3f} mm over {measured} regions on "
                f"{slice_count} slices"
                + (
                    f" ({skipped} slice(s) in the underside pocket band are judged "
                    f"by base_floor and lettering instead)"
                    if skipped
                    else ""
                )
                if wall_ok
                else f"{failing} of {measured} sampled regions are under "
                f"{fail_at:.3f} mm (narrowest {reported:.3f} mm)"
            ),
        )
    )

    # ---- triangle budget -------------------------------------------------
    triangles = int(len(mesh.faces))
    tri_ok = triangles < TRIANGLE_BUDGET
    checks.append(
        Check(
            name="triangle_budget",
            passed=tri_ok,
            value=triangles,
            threshold=TRIANGLE_BUDGET,
            message=(
                f"{triangles:,} triangles"
                if tri_ok
                else f"{triangles:,} triangles exceeds the {TRIANGLE_BUDGET:,} budget"
            ),
        )
    )

    # ---- frame lettering and the underside (v2, additive) -----------------
    # Both rows appear only when the parameters ask for the feature: a row for a
    # model that carries no text at all would be a pass with nothing behind it,
    # and every v1 report keeps exactly the rows it had.
    checks.extend(validate_lettering(mesh, params, manifold=manifold))
    checks.extend(validate_base_floor(mesh, params, manifold=manifold))

    # ---- degenerate faces ------------------------------------------------
    degenerate = int((mesh.area_faces < DEGENERATE_FACE_AREA).sum())
    checks.append(
        Check(
            name="degenerate_faces",
            passed=degenerate == 0,
            value=degenerate,
            threshold=0,
            message=(
                "no zero-area triangles"
                if degenerate == 0
                else f"{degenerate} faces smaller than {DEGENERATE_FACE_AREA} mm^2"
            ),
        )
    )

    return ValidationReport(checks=checks)
