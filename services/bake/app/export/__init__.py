"""Export package: 3MF (primary), binary STL (fallback), sidecar JSON, CREDITS.

04 stage 3 also requires a sidecar ``<name>.json`` carrying the full
``BakeResult`` plus the exact ``SceneRequest`` and ``PrintParams`` "so any
output is reproducible", and CLAUDE.md requires the OSM attribution in a
``CREDITS.txt`` next to every export.  Both writers live here so no caller can
produce a 3MF without them.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from app.export import mf3, stl

__all__ = [
    "mf3",
    "stl",
    "ATTRIBUTION",
    "CREDITS_TEXT",
    "CREDITS_FILENAME",
    "write_credits",
    "write_sidecar",
    "sidecar_payload",
]

ATTRIBUTION = mf3.ATTRIBUTION
CREDITS_FILENAME = "CREDITS.txt"

CREDITS_TEXT = (
    "© OpenStreetMap contributors, ODbL; produced work by FrameCraft\n"
    "\n"
    "Map data in this model comes from OpenStreetMap and is licensed under the\n"
    "Open Database License 1.0 (https://opendatacommons.org/licenses/odbl/).\n"
    "The printed model is a Produced Work under that licence; keep this notice\n"
    "with the file and credit \"© OpenStreetMap contributors\" wherever the\n"
    "model or a photograph of it is published.\n"
    "\n"
    "Elevation, imagery and any other third-party sources: none. FrameCraft\n"
    "uses OpenStreetMap data only.\n"
)


def write_credits(directory: str | Path) -> Path:
    """Write ``CREDITS.txt`` next to an export.  Returns the path written."""
    out = Path(directory) / CREDITS_FILENAME
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(CREDITS_TEXT, encoding="utf-8", newline="\n")
    return out


def sidecar_payload(
    *,
    bake_result: Mapping[str, Any],
    scene_request: Mapping[str, Any],
    print_params: Mapping[str, Any],
    validation: Mapping[str, Any] | None = None,
    scene_stats: Mapping[str, Any] | None = None,
    timings_s: Mapping[str, float] | None = None,
    created: datetime | None = None,
) -> dict[str, Any]:
    """The sidecar document.  Every nested block is contract JSON, verbatim."""
    when = created or datetime.now(timezone.utc)
    return {
        "attribution": ATTRIBUTION,
        "license": "ODbL 1.0",
        "generator": "FrameCraft bake",
        "created_at": when.replace(microsecond=0).isoformat(),
        "scene_request": dict(scene_request),
        "print_params": dict(print_params),
        "bake_result": dict(bake_result),
        "scene_stats": dict(scene_stats) if scene_stats is not None else None,
        "validation": dict(validation) if validation is not None else None,
        "timings_s": dict(timings_s) if timings_s is not None else None,
    }


def write_sidecar(path: str | Path, payload: Mapping[str, Any]) -> Path:
    """Write the sidecar JSON.  ``allow_nan=False`` - a non-finite number here
    would produce a file no other JSON parser can read."""
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return out
