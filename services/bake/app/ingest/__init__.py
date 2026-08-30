"""OSM ingest: Overpass client, fixture cache, presets, and normalization.

``overpass`` fetches (or reads from ``fixtures/``) the raw response for a
SceneRequest, ``normalize`` turns that response into a SceneGraph, and
``presets`` holds the six committed demo locations.
"""
from __future__ import annotations

from app.ingest import normalize, overpass, presets

__all__ = ["normalize", "overpass", "presets"]
