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
    "enforce_triangle_budget",
    "section_polygons",
    "wall_persist_mm",
    "recess_probe_zs",
    "body_count",
    "TRIANGLE_BUDGET",
    "DECIMATION_TARGET",
    "MAX_HEIGHT_MM",
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
    """Re-import a trimesh into ``manifold3d``, or None if it is not a solid."""
    from manifold3d import Error, Manifold, Mesh64

    try:
        solid = Manifold(
            Mesh64(
                np.ascontiguousarray(mesh.vertices, dtype=np.float64),
                np.ascontiguousarray(mesh.faces, dtype=np.uint64),
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
) -> tuple[float, int, int]:
    """(narrowest wall, failing regions, regions measured), all in print mm."""
    z_lo = float(mesh.bounds[0][2])
    z_hi = float(mesh.bounds[1][2])
    persist = wall_persist_mm(min_wall_mm)
    if z_hi - z_lo <= 2.0 * persist:
        return math.inf, 0, 0

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
    for z in zs.tolist():
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
    return smallest, failing, measured


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
) -> ValidationReport:
    """Run every 04 stage 4 validator.  All must pass for a job to be ``done``."""
    checks: list[Check] = []

    plate_mm = float(params.plate_mm)
    min_wall_mm = T.MIN_WALL_NOZZLES * float(params.nozzle_mm)

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
    bbox_ok = bool(extents[0] <= limit and extents[1] <= limit and extents[2] < MAX_HEIGHT_MM)
    checks.append(
        Check(
            name="bounding_box",
            passed=bbox_ok,
            value=f"{extents[0]:.3f} x {extents[1]:.3f} x {extents[2]:.3f} mm",
            threshold=f"x,y <= {limit:.2f} mm; z < {MAX_HEIGHT_MM:.0f} mm",
            message=(
                "fits the selected plate"
                if bbox_ok
                else (
                    f"model is {extents[2]:.1f} mm tall, over the {MAX_HEIGHT_MM:.0f} mm limit; "
                    "lower the building height multipliers"
                    if extents[2] >= MAX_HEIGHT_MM
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
    smallest, failing, measured = _min_wall_probe(
        mesh, min_wall_mm, slices=slices, manifold=manifold, extra_zs=recess_zs
    )
    slice_count = slices + len(recess_zs)
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
