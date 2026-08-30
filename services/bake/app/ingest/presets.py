"""The six MVP preset cities (01 "Preset cities for the MVP").

Each preset pins a center, a radius and a rotation so the demo is reproducible;
its raw Overpass response is committed under ``fixtures/`` and a preset request
never touches the network.  Ids and labels are fixed by DECISIONS.md ([P1]);
the labels live client-side keyed by ``preset_id``, and are repeated here only
so ``fixtures/presets-index.json`` is readable by a human.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.contracts import SceneRequest

__all__ = ["Preset", "PRESETS", "PRESETS_BY_ID", "preset_requests", "get_preset"]

PRESET_RADIUS_M = 900.0


@dataclass(frozen=True)
class Preset:
    id: str
    label: str
    lat: float
    lon: float
    radius_m: float = PRESET_RADIUS_M
    rotation_deg: float = 0.0

    def request(self) -> SceneRequest:
        return SceneRequest(
            lat=self.lat,
            lon=self.lon,
            radius_m=self.radius_m,
            rotation_deg=self.rotation_deg,
            preset_id=self.id,
        )


PRESETS: tuple[Preset, ...] = (
    Preset("chicago-loop", "Chicago — Loop", 41.8827, -87.6233),
    Preset("new-york-midtown", "New York — Midtown", 40.7549, -73.9840, rotation_deg=29.0),
    Preset("paris-eiffel", "Paris — Tour Eiffel", 48.8584, 2.2945),
    Preset("tokyo-shinjuku", "Tokyo — Shinjuku", 35.6896, 139.7006),
    Preset("london-city", "London — City", 51.5155, -0.0922),
    Preset("san-francisco-fidi", "San Francisco — Financial District", 37.7946, -122.3999),
)

PRESETS_BY_ID: dict[str, Preset] = {p.id: p for p in PRESETS}


def preset_requests() -> list[SceneRequest]:
    """The six preset ``SceneRequest`` objects returned by ``GET /presets``."""
    return [p.request() for p in PRESETS]


def get_preset(preset_id: str) -> Preset | None:
    return PRESETS_BY_ID.get(preset_id)
