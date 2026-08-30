"""Binary STL writer.  04 stage 3: "STL binary is the fallback, written by
trimesh."

trimesh is used here and only here (plus the Stage 4 validators).  It is never
used for a boolean - ``manifold3d`` owns every CSG operation in this codebase.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import trimesh

__all__ = ["to_trimesh", "write_stl"]


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
    """Write a binary STL.  Returns the path written."""
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    data = trimesh.exchange.stl.export_stl(mesh)
    out.write_bytes(data)
    return out
