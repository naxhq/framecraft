"""Binary STL writer.  04 stage 3: "STL binary is the fallback, written by
trimesh."

trimesh is used here and only here (plus the Stage 4 validators).  It is never
used for a boolean - ``manifold3d`` owns every CSG operation in this codebase.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import trimesh

__all__ = [
    "to_trimesh",
    "write_stl",
    "separate_float32_pinches",
    "EMPTY_PINCH_REPORT",
    "PINCH_STEPS",
]

#: How many float32 steps the separation may take before it gives up.  One is
#: enough for every case measured; the doubling exists only so a group of three
#: or more coincident vertices cannot loop.  Mirrors ``mesh.PINCH_STEPS``.
PINCH_STEPS = 8

#: The shape :func:`separate_float32_pinches` reports in, mirroring the browser
#: engine's ``PinchReport``.
EMPTY_PINCH_REPORT: dict[str, float] = {
    "groups": 0,
    "moved": 0,
    "unresolved": 0,
    "rejected": 0,
    "max_shift_mm": 0.0,
    "volume_delta_mm3": 0.0,
}


def _mesh_volume(vertices: np.ndarray, faces: np.ndarray) -> float:
    """Signed volume of a closed triangle mesh, mm^3 (the divergence theorem)."""
    a = vertices[faces[:, 0]]
    b = vertices[faces[:, 1]]
    c = vertices[faces[:, 2]]
    return float(np.einsum("ij,ij->", a, np.cross(b, c)) / 6.0)


def _volume_noise(volume_mm3: float) -> float:
    """``assemble``'s and ``cleanMesh``'s shared bound: a relative 1e-9, floored."""
    return max(1e-6, abs(volume_mm3) * 1e-9)


def separate_float32_pinches(
    vertices: np.ndarray, faces: np.ndarray
) -> tuple[np.ndarray, dict[str, float]]:
    """Give every vertex a float32 grid point of its own.  (positions, report)

    A binary STL is a triangle soup: it has no vertex index, so a reader
    recovers the topology by welding identical coordinates - which is exactly
    what ``app/cli.py``'s ``_index_stl_triangle_soup`` does before this file is
    judged.  Two distinct vertices at ONE point therefore become one, and the
    edge they each shared with a common neighbour is handed to four faces:
    ``manifold``, ``watertight`` and ``self_intersection`` all fail on a model
    whose 3MF - indexed, and written ``%.12f`` - passes every row.

    That configuration is not a defect of the mesh and no weld can remove it.
    It is how ``manifold3d`` represents two sheets of a surface that touch along
    an edge, which at this scale is two building corners meeting exactly:
    measured, one on Paris (at -19.080, -77.350, z 3.771 to 4.650), one on
    Tokyo, two on London, none on Chicago, New York or San Francisco.
    ``assemble.finalize`` cannot reach it, and the reason is worth knowing
    before anyone tries again there.  Traced on the Paris plate, ``finalize``
    receives 53 035 vertices, 10 of which a float32 reader would lose (9 created
    by the rounding, 1 an exact duplicate in double), 7 degenerate faces in
    float64 and 19 in float32.  Its simplify and weld ladder clears all of that
    and stops at 53 016 vertices with the ONE exact duplicate still in place,
    and ``_is_clean`` then answers True: ``float32_defect_count`` scores
    ``len(unique(vertices)) - len(unique(quantised))``, and a pair that is
    already one row of ``unique(vertices)`` contributes nothing to that
    difference by construction.  Welding it would not help in any case - it is
    the same non-manifold edge, made explicit, and manifold3d would refuse the
    re-import.

    So the FILE is made to say what the mesh says, to the finest it can: the
    second vertex of a colliding group is moved one float32 step at the model's
    own scale (1.5e-5 mm on a 180 mm plate) into its own material, against its
    area-weighted vertex normal and along that vector's dominant axis.  Four
    orders of magnitude under the print grid, and the smallest move the format
    can express - a smaller one rounds straight back onto the point it came
    from.  The mirror of ``mesh.separateFloat32Pinches`` in the browser engine,
    pinned against it by ``fixtures/pinch-parity.json``.

    TRANSACTIONAL, like every repair in ``assemble``: the move is kept only when
    no face the file can measure becomes degenerate that was not already, and
    the volume moves by no more than one step across the faces the moved
    vertices carry (``sum(shift * incident area)``, the exact worst case for a
    translation) or by the shared noise bound, whichever is larger.  The pure
    relative bound is the wrong test on its own for a repair that moves a vertex
    on purpose: its cost scales with the incident area, not with the model's
    volume, so on a 10 mm cube it would reject a legitimate 1.5e-5 mm step
    (4.1e-3 mm^3 against 3e-6) while accepting the same step on a plate.  The
    topology is untouched by construction - the faces keep their indices - and
    ``tests/test_bake.py`` pins that rather than recomputing it here.  A
    rejected move is rolled back whole and counted in ``report["rejected"]``.
    """
    verts = np.asarray(vertices, dtype=np.float64)
    tris = np.asarray(faces, dtype=np.int64)
    quantised = verts.astype(np.float32)
    taken = {tuple(row) for row in quantised.tolist()}
    if len(taken) == len(verts):
        return verts, dict(EMPTY_PINCH_REPORT)

    _uniq, first, inverse = np.unique(
        quantised, axis=0, return_index=True, return_inverse=True
    )
    inverse = np.asarray(inverse).reshape(-1)
    keeps = np.zeros(len(verts), dtype=bool)
    keeps[np.asarray(first).reshape(-1)] = True

    # Area-weighted vertex normals, from the cross products the winding gives,
    # and the plain incident area beside them for the acceptance bound.
    a = verts[tris[:, 0]]
    face_normals = np.cross(verts[tris[:, 1]] - a, verts[tris[:, 2]] - a)
    face_areas = 0.5 * np.linalg.norm(face_normals, axis=1)
    normals = np.zeros_like(verts)
    incident = np.zeros(len(verts), dtype=np.float64)
    for corner in range(3):
        np.add.at(normals, tris[:, corner], face_normals)
        np.add.at(incident, tris[:, corner], face_areas)

    # One step at the largest coordinate the mesh holds, so the separation is
    # the same size wherever it lands rather than vanishing to a denormal at a
    # vertex sitting on z = 0 - which is every vertex of a placed underside.
    scale = np.float32(max(1.0, float(np.abs(verts).max())))
    grid = float(np.nextafter(scale, np.float32(np.inf)) - scale)

    moved = verts.copy()
    # Grid points carrying more than one vertex, which is what the browser
    # engine's `groups` counts; `len(verts) - len(taken)` is the number of
    # vertices LOST, which is a different number whenever a group has three.
    groups = int((np.bincount(inverse, minlength=len(_uniq)) > 1).sum())
    count = 0
    unresolved = 0
    max_shift = 0.0
    budget = 0.0
    # `keeps[v]` is False exactly for a non-first occurrence of a float32 row,
    # which by construction has at least two members, so no membership test is
    # needed here (the one that used to be cost a full scan of `inverse` per
    # vertex and could never be taken; v3-07 audit, note 10).
    for v in np.nonzero(~keeps)[0]:
        axis = int(np.argmax(np.abs(normals[v])))
        direction = 1.0 if -normals[v][axis] >= 0 else -1.0
        origin = float(moved[v][axis])
        here = np.float32(origin)
        step = max(grid, float(abs(np.nextafter(here, np.float32(np.inf)) - here)))
        for _ in range(PINCH_STEPS):
            moved[v][axis] = origin + direction * step
            key = tuple(moved[v].astype(np.float32).tolist())
            if key not in taken:
                taken.add(key)
                shift = abs(float(moved[v][axis]) - origin)
                max_shift = max(max_shift, shift)
                budget += shift * float(incident[v])
                count += 1
                break
            step *= 2.0
        else:  # pragma: no cover - eight doublings always find a free point
            moved[v][axis] = origin
            unresolved += 1
    report = dict(EMPTY_PINCH_REPORT)
    report["groups"] = groups
    report["unresolved"] = unresolved
    if count == 0:
        return verts, report

    # The transaction, the mirror of `mesh.separateFloat32Pinches`: the faces
    # keep their indices, so a translation can only move the volume and the
    # areas, and those are the two things measured.
    before = _mesh_volume(verts, tris)
    delta = _mesh_volume(moved, tris) - before
    allowance = max(_volume_noise(before), budget)
    from app.geom.assemble import degenerate_face_count

    degenerate_before = degenerate_face_count(quantised.astype(np.float64), tris)
    degenerate_after = degenerate_face_count(
        moved.astype(np.float32).astype(np.float64), tris
    )
    if abs(delta) > allowance or degenerate_after > degenerate_before:
        report["rejected"] = count
        return verts, report
    report["moved"] = count
    report["max_shift_mm"] = max_shift
    report["volume_delta_mm3"] = float(delta)
    return moved, report


def to_trimesh(vertices: np.ndarray, triangles: np.ndarray) -> trimesh.Trimesh:
    """Wrap manifold3d output in a Trimesh **without** any processing.

    ``process=False`` matters: trimesh's default merge/cleanup pass would
    silently weld vertices and could change a mesh manifold3d already
    guarantees.  What is validated must be what is exported.
    """
    return trimesh.Trimesh(
        vertices=np.asarray(vertices, dtype=np.float64),
        faces=np.asarray(triangles, dtype=np.int64),
        process=False,
        validate=False,
    )


def write_stl(path: str | Path, mesh: trimesh.Trimesh) -> Path:
    """Write a binary STL.  Returns the path written.

    The mesh handed over is the one Stage 4 judged, and it is written as it is
    except for one thing the FORMAT cannot carry: two distinct vertices on one
    float32 grid point (:func:`separate_float32_pinches`).  Nothing is welded,
    no face is added or dropped, and a mesh with no such pair - Chicago, New
    York, San Francisco - is written byte for byte what it was.
    """
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    positions, report = separate_float32_pinches(mesh.vertices, mesh.faces)
    if report["moved"]:
        mesh = trimesh.Trimesh(
            vertices=positions,
            faces=np.asarray(mesh.faces),
            process=False,
            validate=False,
        )
    data = trimesh.exchange.stl.export_stl(mesh)
    out.write_bytes(data)
    return out
