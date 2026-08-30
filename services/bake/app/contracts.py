"""GENERATED FROM packages/contracts/schema — DO NOT EDIT.

Regenerate with `make contracts` (runs packages/contracts/gen_py.py and
packages/contracts/gen_ts.py). Hand edits here will be overwritten.
"""
from __future__ import annotations

from typing import Annotated, List, Literal, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field


# ---- from scene_request.json ----------------------
class SceneRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    lat: Annotated[float, Field(ge=-90, le=90)]
    lon: Annotated[float, Field(ge=-180, le=180)]
    radius_m: Annotated[float, Field(ge=250, le=3000)]
    rotation_deg: Annotated[float, Field(ge=0, le=360)]
    preset_id: Optional[str] = None


# ---- from scene_graph.json ------------------------
class Bounds(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    min_x: float
    min_y: float
    max_x: float
    max_y: float


class Center(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    lat: Annotated[float, Field(ge=-90, le=90)]
    lon: Annotated[float, Field(ge=-180, le=180)]


Point = Tuple[float, float]


Ring = Annotated[List[Point], Field(min_length=3)]


class Building(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    id: str
    ring: Ring
    holes: List[Ring] = Field(default_factory=list)
    height_m: Annotated[float, Field(ge=0)]
    height_source: Literal["tag", "levels", "default"]
    min_height_m: Annotated[float, Field(ge=0)] = 0.0
    is_tall: bool


class Road(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    id: str
    path: Annotated[List[Point], Field(min_length=2)]
    width_m: Annotated[float, Field(gt=0)]
    class_: Literal["motorway", "primary", "secondary", "residential", "service", "path"] = Field(alias="class")


class AreaFeature(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    ring: Ring
    holes: List[Ring] = Field(default_factory=list)


class Tree(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    x: float
    y: float
    radius_m: Annotated[float, Field(gt=0)]


class Stats(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    building_count: Annotated[int, Field(ge=0)]
    coverage: Literal["good", "sparse", "empty"]
    height_tag_ratio: Annotated[float, Field(ge=0, le=1)]


class SceneGraph(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    bounds: Bounds
    center: Center
    buildings: List[Building]
    roads: List[Road]
    water: List[AreaFeature]
    green: List[AreaFeature]
    trees: List[Tree]
    stats: Stats


# ---- from print_params.json -----------------------
class PrintParams(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    plate_mm: Annotated[float, Field(ge=100, le=256)] = 180
    base_thickness_mm: Annotated[float, Field(ge=2, le=8)] = 3.0
    nozzle_mm: Annotated[float, Field(ge=0.1, le=1.2)] = 0.4
    small_scale: Annotated[float, Field(ge=0.5, le=1.5)] = 1.0
    large_scale: Annotated[float, Field(ge=0.5, le=2.0)] = 1.0
    terrain_exaggeration: Annotated[float, Field(ge=0.0, le=3.0)] = 1.0
    road_mode: Literal["engrave", "emboss", "off"] = "engrave"
    road_scale: Annotated[float, Field(ge=0.5, le=2.0)] = 1.0
    trees: bool = True
    water: bool = True
    frame: bool = True


# ---- from bake_result.json ------------------------
class BakeFiles(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    file_3mf: str = Field(alias="3mf")
    stl: str


class BakeStats(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    triangles: Annotated[int, Field(ge=0)]
    volume_mm3: Annotated[float, Field(ge=0)]
    bbox_mm: Tuple[float, float, float]
    est_grams: Annotated[float, Field(ge=0)]
    is_manifold: bool
    min_wall_mm: Annotated[float, Field(ge=0)]


class BakeResult(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    job_id: str
    status: Literal["queued", "running", "done", "failed"]
    files: Optional[BakeFiles] = None
    stats: Optional[BakeStats] = None
    warnings: List[str] = Field(default_factory=list)
    progress: Optional[Annotated[float, Field(ge=0, le=1)]] = None
    error: Optional[str] = None
