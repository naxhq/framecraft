"""Stage 2b of ``04_PRINTABILITY_SPEC.md``: union everything into one Manifold.

04 stage 2.5 is the difference between a 20 second bake and a 20 minute one:
never union N solids sequentially into one accumulator.  :func:`batched_union`
groups the solids into batches of roughly 200, unions each batch, and then
unions the batch results pairwise in a tree.  It also deduplicates first,
because 04's trap list forbids unioning a solid with itself.

Assembly order (all Z from :mod:`app.geom.transform`):

1. additive: chamfered base plate, frame lip, buildings, green raise, embossed
   roads, tree cones - one batched union;
2. subtractive: engraved roads and the water recess - applied *after* the union
   so a groove cannot be filled back in by a later add;
3. translate so ``min Z`` is exactly 0 and the model is centred on X and Y.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Iterable, Sequence

import numpy as np
from manifold3d import Error, Manifold, Mesh64, OpType

from app.geom import extrude, transform as T
from app.geom.thicken import RepairedScene

__all__ = [
    "float32_defect_count",
    "Assembly",
    "batched_union",
    "assemble",
    "finalize",
    "prune_debris",
    "degenerate_face_count",
]

#: 04 stage 2.5: "batch into groups of roughly 200".
UNION_BATCH = 200

#: 04 stage 4 counts a face under this area (mm^2) as degenerate.
DEGENERATE_FACE_AREA = 1e-9

#: Tolerance for the post-union sliver sweep, mm.  Surfaces move by less than
#: this, which is four orders of magnitude below the 0.001 mm the
#: ``sits_at_zero`` validator measures.
SIMPLIFY_TOL_MM = 1e-6

#: Decimal places the vertex weld rounds to when ``simplify`` leaves slivers
#: behind, tried in order (1e-6 mm to 1e-3 mm, i.e. 1 nm to 1 um - all far
#: below the print grid, and every step is volume-checked before it is kept).
WELD_DIGITS = (6, 5, 4, 3)

#: A body smaller than this (mm^3) is boolean debris, not a printable speck: the
#: smallest legal tree cone is ~0.37 mm^3 and the smallest building block is far
#: bigger.
MIN_BODY_VOLUME_MM3 = 0.01

#: The weld is rejected unless the volume it produces matches to this relative
#: tolerance, so a repair can never quietly change the model.
WELD_VOLUME_TOLERANCE = 1e-6


def _live(solids: Iterable[Manifold | None]) -> list[Manifold]:
    """Drop Nones and empties, and deduplicate by identity.

    04's trap list: "Do not union a solid with itself.  Deduplicate before the
    batch step."  Identity is the right key - two distinct Manifolds that happen
    to be equal are a legitimate (if wasteful) union, the same object twice is
    not.
    """
    seen: set[int] = set()
    out: list[Manifold] = []
    for solid in solids:
        if solid is None:
            continue
        key = id(solid)
        if key in seen:
            continue
        seen.add(key)
        if solid.is_empty():
            continue
        out.append(solid)
    return out


def batched_union(
    solids: Sequence[Manifold | None], batch: int = UNION_BATCH
) -> Manifold | None:
    """Union many solids in batches, then pairwise in a tree."""
    live = _live(solids)
    if not live:
        return None
    if len(live) == 1:
        return live[0]

    level = [
        Manifold.batch_boolean(live[i : i + batch], OpType.Add)
        for i in range(0, len(live), batch)
    ]
    while len(level) > 1:
        level = [
            Manifold.batch_boolean(level[i : i + 2], OpType.Add)
            if len(level[i : i + 2]) > 1
            else level[i]
            for i in range(0, len(level), 2)
        ]
    return level[0]


# --------------------------------------------------------------------------
# Post-union sanitation
# --------------------------------------------------------------------------


def mesh_arrays(solid: Manifold) -> tuple[np.ndarray, np.ndarray]:
    """(vertices, triangles) in float64.  ``to_mesh64``, never float32: float32
    would put ~1e-5 mm of noise on a 180 mm plate."""
    mesh = solid.to_mesh64()
    vertices = np.asarray(mesh.vert_properties, dtype=np.float64)[:, :3]
    faces = np.asarray(mesh.tri_verts).astype(np.int64)
    return vertices, faces


def degenerate_face_count(
    vertices: np.ndarray, faces: np.ndarray, area: float = DEGENERATE_FACE_AREA
) -> int:
    """Number of triangles under ``area`` mm^2 (04 stage 4's last validator)."""
    if len(faces) == 0:
        return 0
    tri = vertices[faces]
    areas = 0.5 * np.linalg.norm(
        np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1
    )
    return int((areas < area).sum())


def float32_defect_count(vertices: np.ndarray, faces: np.ndarray) -> int:
    """Defects the mesh acquires when it is written as a **binary STL**.

    04 stage 3 makes STL the fallback format, and a binary STL stores float32
    coordinates: the shipped ``.stl`` is a quantised rendering of the mesh the
    validators saw.  One float32 step at a 90 mm coordinate is 7.6e-6 mm, which
    is enough to collapse a triangle a nanometre across or to merge two vertices
    that were distinct - Chicago's STL came back with 8 zero-area faces and 4
    non-manifold edges while the 3MF of the same model (written ``%.12f``) was
    perfect.  Counting both here lets :func:`finalize` weld them away once,
    which costs 8 of 69 258 triangles and leaves the volume unchanged to 1e-11.
    """
    quantised = np.asarray(vertices, dtype=np.float32).astype(np.float64)
    collided = len(np.unique(vertices, axis=0)) - len(np.unique(quantised, axis=0))
    return degenerate_face_count(quantised, faces) + max(0, collided)


def _is_clean(vertices: np.ndarray, faces: np.ndarray) -> bool:
    """No zero-area face in float64, and none after the float32 round trip."""
    return (
        degenerate_face_count(vertices, faces) == 0
        and float32_defect_count(vertices, faces) == 0
    )


def prune_debris(solid: Manifold, min_volume: float = MIN_BODY_VOLUME_MM3) -> Manifold:
    """Drop zero-volume boolean debris left floating beside the model.

    A coincident-face boolean can leave a four-triangle body of volume 0.  It is
    manifold, so it passes every topology check, but it would print as nothing
    and it breaks the Euler/body-count relation.
    """
    bodies = solid.decompose()
    if len(bodies) <= 1:
        return solid
    kept = [b for b in bodies if b.volume() >= min_volume]
    if not kept or len(kept) == len(bodies):
        return solid
    return Manifold.batch_boolean(kept, OpType.Add)


def _weld(vertices: np.ndarray, faces: np.ndarray, digits: int) -> tuple[np.ndarray, np.ndarray]:
    """Merge vertices that agree to ``digits`` decimals and drop collapsed faces."""
    rounded = np.round(vertices, digits)
    _uniq, first, inverse = np.unique(rounded, axis=0, return_index=True, return_inverse=True)
    remapped = inverse[faces.reshape(-1)].reshape(faces.shape)
    keep = (
        (remapped[:, 0] != remapped[:, 1])
        & (remapped[:, 1] != remapped[:, 2])
        & (remapped[:, 2] != remapped[:, 0])
    )
    # Keep the original (unrounded) coordinate of each merged group so the model
    # is not quantised, only welded.
    return vertices[first], remapped[keep]


def finalize(solid: Manifold) -> Manifold:
    """Sweep boolean debris and sliver triangles out of the assembled solid.

    Booleans between exactly coincident faces leave triangles a few nanometres
    across.  They are harmless to a printer and invisible, but 04 stage 4
    requires **zero** faces under 1e-9 mm^2, so they are removed here rather
    than tolerated in the validator:

    1. drop zero-volume bodies (:func:`prune_debris`);
    2. ``Manifold.simplify`` at 1e-6 mm, which removes most of them;
    3. if any remain, weld vertices that agree to 1e-5 mm (then 1e-4 mm), drop
       the faces that collapse, and re-import through ``manifold3d``.  The
       re-import is only accepted when it comes back ``NoError`` with the same
       volume to 1e-6 relative, so this can never quietly change the model.

    "Clean" additionally means the mesh survives the float32 round trip a binary
    STL puts it through (:func:`float32_defect_count`), because that file is a
    shipped deliverable and ``make validate`` judges it with the same
    validators.
    """
    solid = prune_debris(solid)
    vertices, faces = mesh_arrays(solid)
    if _is_clean(vertices, faces):
        return solid

    simplified = solid.simplify(SIMPLIFY_TOL_MM)
    if simplified.status() == Error.NoError:
        vertices, faces = mesh_arrays(simplified)
        if _is_clean(vertices, faces):
            return simplified
        solid = simplified

    reference = solid.volume()
    for digits in WELD_DIGITS:
        vertices, faces = mesh_arrays(solid)
        welded_v, welded_f = _weld(vertices, faces, digits)
        if len(welded_f) == 0:
            continue
        candidate = Manifold(
            Mesh64(
                np.ascontiguousarray(welded_v, dtype=np.float64),
                np.ascontiguousarray(welded_f, dtype=np.uint64),
            )
        )
        if candidate.status() != Error.NoError:
            continue
        if abs(candidate.volume() - reference) > WELD_VOLUME_TOLERANCE * max(reference, 1.0):
            continue
        solid = candidate
        v, f = mesh_arrays(solid)
        if _is_clean(v, f):
            break
    return solid


@dataclass
class Assembly:
    """The finished solid plus every intermediate, for the debug dump."""

    solid: Manifold
    parts: dict[str, Manifold] = field(default_factory=dict)
    counts: dict[str, int] = field(default_factory=dict)


def assemble(
    repaired: RepairedScene,
    params: T.ParamsLike,
    progress: Callable[[str, float], None] | None = None,
) -> Assembly:
    """Stage 2: build every solid, union them, and sit the result at Z = 0."""

    def _tick(stage: str, value: float) -> None:
        if progress is not None:
            progress(stage, value)

    scale = repaired.scale
    parts: dict[str, Manifold] = {}
    counts: dict[str, int] = {}

    base = extrude.base_plate(params)
    parts["base"] = base
    additive: list[Manifold | None] = [base]

    lip = extrude.frame_lip(params)
    if lip is not None:
        parts["frame"] = lip
        additive.append(lip)

    buildings = extrude.building_solids(repaired.buildings.solids, params, scale)
    counts["buildings"] = len(buildings)
    building_union = batched_union(buildings)
    if building_union is not None:
        parts["buildings"] = building_union
        additive.append(building_union)

    road_z = T.road_z_mm(params)
    road_slab = None
    if road_z is not None and repaired.roads.polygons:
        road_slab = extrude.slab(repaired.roads.polygons, params, scale, road_z)
    if road_slab is not None:
        parts["roads"] = road_slab
        if road_z is not None and road_z > 0.0:
            additive.append(road_slab)

    green_slab = extrude.slab(
        repaired.green.polygons, params, scale, T.green_z_mm(params)
    )
    if green_slab is not None:
        parts["green"] = green_slab
        additive.append(green_slab)

    water_z = T.water_z_mm(params)
    water_slab = None
    if water_z is not None and repaired.water.polygons:
        water_slab = extrude.slab(repaired.water.polygons, params, scale, water_z)
    if water_slab is not None:
        parts["water"] = water_slab

    trees = extrude.tree_solids(repaired.trees, params, scale)
    counts["trees"] = len(trees)
    tree_union = batched_union(trees)
    if tree_union is not None:
        parts["trees"] = tree_union
        additive.append(tree_union)

    _tick("extrude", 0.45)

    solid = batched_union(additive)
    if solid is None:  # pragma: no cover - the base plate always exists
        solid = base

    cutters: list[Manifold] = []
    if road_slab is not None and road_z is not None and road_z < 0.0:
        cutters.append(road_slab)
    if water_slab is not None:
        cutters.append(water_slab)
    if cutters:
        solid = Manifold.batch_boolean([solid, *cutters], OpType.Subtract)

    solid = finalize(solid)

    _tick("union", 0.8)

    # 04 stage 2.7: sit at exactly z = 0, centred on X and Y.
    min_x, min_y, min_z, max_x, max_y, _max_z = solid.bounding_box()
    solid = solid.translate(
        (-(min_x + max_x) / 2.0, -(min_y + max_y) / 2.0, -min_z)
    )

    return Assembly(solid=solid, parts=parts, counts=counts)
