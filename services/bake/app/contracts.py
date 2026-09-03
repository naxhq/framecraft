"""GENERATED FROM packages/contracts/schema — DO NOT EDIT.

Regenerate with `make contracts` (runs packages/contracts/gen_py.py and
packages/contracts/gen_ts.py). Hand edits here will be overwritten.
"""
from __future__ import annotations

from typing import Annotated, Any, List, Literal, Optional, Tuple

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SerializerFunctionWrapHandler,
    model_serializer,
)


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
    holes: List[Ring]
    height_m: Annotated[float, Field(ge=0)]
    height_source: Literal["tag", "levels", "default"]
    min_height_m: Annotated[float, Field(ge=0)]
    is_tall: bool
    name: Optional[Annotated[str, Field(max_length=120)]] = None
    osm_id: Optional[Annotated[str, Field(max_length=32)]] = None
    kind: Optional[Annotated[str, Field(max_length=64)]] = None

    @model_serializer(mode="wrap")
    def _omit_absent(self, handler: SerializerFunctionWrapHandler) -> Any:
        """Drop `name`, `osm_id`, `kind` from a dump when they are absent.

        These properties are optional AND non-nullable in the schema, so `null`
        is not one of their legal values: `None` on the model means "the key was
        not sent", and a dump that wrote `null` would emit an instance the
        contract itself rejects.  Omitting them is also what lets a payload
        written against an EARLIER schema version round-trip through this model
        byte for byte (services/bake/tests/test_contracts.py's
        `test_scene_graph_dumps_fixture_verbatim_without_by_alias`, and the
        per-version migration cases in tests/test_schema_migration.py).
        """
        data = handler(self)
        for key in ("name", "osm_id", "kind"):
            if key in data and data[key] is None:
                del data[key]
        return data


class Road(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    id: str
    path: Annotated[List[Point], Field(min_length=2)]
    width_m: Annotated[float, Field(gt=0)]
    class_: Literal["motorway", "primary", "secondary", "residential", "service", "path"] = Field(alias="class")
    name: Optional[Annotated[str, Field(max_length=120)]] = None
    osm_id: Optional[Annotated[str, Field(max_length=32)]] = None
    kind: Optional[Annotated[str, Field(max_length=64)]] = None

    @model_serializer(mode="wrap")
    def _omit_absent(self, handler: SerializerFunctionWrapHandler) -> Any:
        """Drop `name`, `osm_id`, `kind` from a dump when they are absent.

        These properties are optional AND non-nullable in the schema, so `null`
        is not one of their legal values: `None` on the model means "the key was
        not sent", and a dump that wrote `null` would emit an instance the
        contract itself rejects.  Omitting them is also what lets a payload
        written against an EARLIER schema version round-trip through this model
        byte for byte (services/bake/tests/test_contracts.py's
        `test_scene_graph_dumps_fixture_verbatim_without_by_alias`, and the
        per-version migration cases in tests/test_schema_migration.py).
        """
        data = handler(self)
        for key in ("name", "osm_id", "kind"):
            if key in data and data[key] is None:
                del data[key]
        return data


class AreaFeature(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    ring: Ring
    holes: List[Ring]
    name: Optional[Annotated[str, Field(max_length=120)]] = None
    osm_id: Optional[Annotated[str, Field(max_length=32)]] = None
    kind: Optional[Annotated[str, Field(max_length=64)]] = None

    @model_serializer(mode="wrap")
    def _omit_absent(self, handler: SerializerFunctionWrapHandler) -> Any:
        """Drop `name`, `osm_id`, `kind` from a dump when they are absent.

        These properties are optional AND non-nullable in the schema, so `null`
        is not one of their legal values: `None` on the model means "the key was
        not sent", and a dump that wrote `null` would emit an instance the
        contract itself rejects.  Omitting them is also what lets a payload
        written against an EARLIER schema version round-trip through this model
        byte for byte (services/bake/tests/test_contracts.py's
        `test_scene_graph_dumps_fixture_verbatim_without_by_alias`, and the
        per-version migration cases in tests/test_schema_migration.py).
        """
        data = handler(self)
        for key in ("name", "osm_id", "kind"):
            if key in data and data[key] is None:
                del data[key]
        return data


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
class PartColors(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    base: Annotated[str, Field(pattern="^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")]
    frame: Annotated[str, Field(pattern="^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")]
    buildings: Annotated[str, Field(pattern="^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")]
    roads: Annotated[str, Field(pattern="^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")]
    water: Annotated[str, Field(pattern="^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")]
    green: Annotated[str, Field(pattern="^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")]
    trees: Annotated[str, Field(pattern="^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")]


class Engraving(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    edge: Literal["top", "bottom", "left", "right", "underside"]
    align: Literal["start", "center", "end"] = "center"
    text: Annotated[str, Field(max_length=64)]
    mode: Literal["engrave", "emboss", "inlay"] = "engrave"
    size_mm: Annotated[float, Field(ge=1.5, le=8.0)] = 4.0
    depth_mm: Annotated[float, Field(ge=0.2, le=1.5)] = 0.4
    font: Literal["sans", "serif", "mono"] = "sans"


class NorthArrow(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    enabled: bool = False
    corner: Literal["ne", "nw", "se", "sw"] = "ne"
    size_mm: Annotated[float, Field(ge=2.0, le=6.0)] = 4.0


class ScaleBar(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    enabled: bool = False
    edge: Literal["top", "bottom", "left", "right"] = "bottom"
    length_mode: Literal["auto", "fixed"] = "auto"
    length_m: Annotated[float, Field(ge=10, le=5000)] = 500


class UndersideMark(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    enabled: bool = False
    template: Annotated[str, Field(max_length=64)] = "{city} {scale} {date}"


class Place(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    country: Annotated[str, Field(max_length=64)] = ""
    state: Annotated[str, Field(max_length=64)] = ""
    neighbourhood: Annotated[str, Field(max_length=64)] = ""
    author: Annotated[str, Field(max_length=64)] = ""


class RoadRegion(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    depth_mm: Annotated[float, Field(ge=0.2, le=3.0)] = 0.6
    proud_mm: Annotated[float, Field(ge=-2.0, le=2.0)] = -0.2


class WaterRegion(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    depth_mm: Annotated[float, Field(ge=0.2, le=3.0)] = 1.0
    proud_mm: Annotated[float, Field(ge=-2.0, le=2.0)] = -0.5


class ParkRegion(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    depth_mm: Annotated[float, Field(ge=0.2, le=3.0)] = 0.4
    proud_mm: Annotated[float, Field(ge=-2.0, le=2.0)] = 0.0


class RailRegion(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    depth_mm: Annotated[float, Field(ge=0.2, le=3.0)] = 0.4
    proud_mm: Annotated[float, Field(ge=-2.0, le=2.0)] = 0.3
    width_m: Annotated[float, Field(ge=2, le=20)] = 6.0


class Regions(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    roads: RoadRegion = Field(default_factory=lambda: RoadRegion(depth_mm=0.6, proud_mm=-0.2))
    water: WaterRegion = Field(default_factory=lambda: WaterRegion(depth_mm=1.0, proud_mm=-0.5))
    parks: ParkRegion = Field(default_factory=lambda: ParkRegion(depth_mm=0.4, proud_mm=0.0))
    rail: RailRegion = Field(default_factory=lambda: RailRegion(depth_mm=0.4, proud_mm=0.3, width_m=6.0))
    building_skirt_mm: Annotated[float, Field(ge=0, le=1)] = 0.3


class RegionSlots(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    base: Annotated[int, Field(ge=1, le=16)] = 1
    frame: Annotated[int, Field(ge=1, le=16)] = 1
    matting: Annotated[int, Field(ge=1, le=16)] = 1
    buildings: Annotated[int, Field(ge=1, le=16)] = 2
    hero_building: Annotated[int, Field(ge=1, le=16)] = 4
    roads: Annotated[int, Field(ge=1, le=16)] = 4
    water: Annotated[int, Field(ge=1, le=16)] = 3
    parks: Annotated[int, Field(ge=1, le=16)] = 4
    rail: Annotated[int, Field(ge=1, le=16)] = 4
    lettering: Annotated[int, Field(ge=1, le=16)] = 4
    attribution: Annotated[int, Field(ge=1, le=16)] = 1


class RegionColors(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    base: Annotated[str, Field(pattern="^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")] = "#D8D3C6"
    frame: Annotated[str, Field(pattern="^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")] = "#3A3A3A"
    matting: Annotated[str, Field(pattern="^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")] = "#EDE9E0"
    buildings: Annotated[str, Field(pattern="^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")] = "#D8D3C6"
    hero_building: Annotated[str, Field(pattern="^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")] = "#E3A72F"
    roads: Annotated[str, Field(pattern="^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")] = "#3A3A3A"
    water: Annotated[str, Field(pattern="^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")] = "#2F7FC1"
    parks: Annotated[str, Field(pattern="^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")] = "#5A9E4B"
    rail: Annotated[str, Field(pattern="^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")] = "#6B6B6B"
    lettering: Annotated[str, Field(pattern="^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")] = "#E3A72F"
    attribution: Annotated[str, Field(pattern="^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")] = "#D8D3C6"


class Tint(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    enabled: bool = False
    hue_range_deg: Annotated[float, Field(ge=0, le=60)] = 12
    lightness_range: Annotated[float, Field(ge=0, le=0.5)] = 0.12
    seed: int = 1


class Gradient(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    enabled: bool = False
    slots: Annotated[List[Annotated[int, Field(ge=1, le=16)]], Field(max_length=16)] = Field(default_factory=lambda: [2, 3])


class Colour(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    region_slots: RegionSlots = Field(default_factory=lambda: RegionSlots(base=1, frame=1, matting=1, buildings=2, hero_building=4, roads=4, water=3, parks=4, rail=4, lettering=4, attribution=1))
    region_colors: RegionColors = Field(default_factory=lambda: RegionColors(base="#D8D3C6", frame="#3A3A3A", matting="#EDE9E0", buildings="#D8D3C6", hero_building="#E3A72F", roads="#3A3A3A", water="#2F7FC1", parks="#5A9E4B", rail="#6B6B6B", lettering="#E3A72F", attribution="#D8D3C6"))
    palette: Annotated[str, Field(max_length=32)] = "default"
    tint: Tint = Field(default_factory=lambda: Tint(enabled=False, hue_range_deg=12, lightness_range=0.12, seed=1))
    gradient: Gradient = Field(default_factory=lambda: Gradient(enabled=False, slots=[2, 3]))
    preview_theme: Literal["dark", "light"] = "dark"


class CustomProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    plate_x_mm: Annotated[float, Field(ge=100, le=400)] = 256
    plate_y_mm: Annotated[float, Field(ge=100, le=400)] = 256
    max_height_mm: Annotated[float, Field(ge=20, le=500)] = 60
    nozzle_mm: Annotated[float, Field(ge=0.2, le=1.0)] = 0.4
    slots: Annotated[int, Field(ge=1, le=16)] = 4
    change_gcode: str = "M600"


class Terrain(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    enabled: bool = False
    smoothing: Annotated[int, Field(ge=0, le=5)] = 1


class TypeDefaults(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    house: float = 6
    apartments: float = 15
    commercial: float = 12
    retail: float = 6
    industrial: float = 8
    garage: float = 3


class Heights(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    floor_height_m: Annotated[float, Field(ge=2, le=5)] = 3.0
    unknown_default_m: Annotated[float, Field(ge=2, le=60)] = 8.0
    type_defaults: TypeDefaults = Field(default_factory=lambda: TypeDefaults(house=6, apartments=15, commercial=12, retail=6, industrial=8, garage=3))


class Bridges(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    enabled: bool = True
    clearance_mm: Annotated[float, Field(ge=0, le=5)] = 1.0
    abutments: bool = True


class HeightExaggeration(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    multiplier: Annotated[float, Field(ge=0.25, le=4)] = 1.0
    curve: Annotated[float, Field(ge=0, le=1)] = 0.0


class HeroAuto(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    enabled: bool = False
    count: Annotated[int, Field(ge=1, le=12)] = 3


class Tiling(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    enabled: bool = False
    cols: Annotated[int, Field(ge=1, le=6)] = 1
    rows: Annotated[int, Field(ge=1, le=6)] = 1
    joint: Literal["dovetail", "pin"] = "dovetail"
    tolerance_mm: Annotated[float, Field(ge=0, le=1)] = 0.15
    index_mark: bool = True


class ShadowGap(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    enabled: bool = False
    width_mm: Annotated[float, Field(ge=0.4, le=5)] = 1.0
    depth_mm: Annotated[float, Field(ge=0.2, le=5)] = 0.8


class Matting(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    enabled: bool = False
    width_mm: Annotated[float, Field(ge=1, le=30)] = 6
    proud_mm: Annotated[float, Field(ge=0, le=3)] = 0.4


class Separate(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    enabled: bool = False
    mount: Literal["snap", "magnet"] = "snap"
    tolerance_mm: Annotated[float, Field(ge=0, le=1)] = 0.2


class Texture(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    pattern: Literal["none", "brush", "knurl", "hatch", "dots"] = "none"
    scale_mm: Annotated[float, Field(ge=0.3, le=5)] = 1.0
    depth_mm: Annotated[float, Field(ge=0.05, le=1)] = 0.2


class FrameStyle(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    profile: Literal["plain", "chamfer", "stepped", "bevel_in", "bullnose", "ogee", "floating"] = "plain"
    corner: Literal["square", "mitred", "rounded"] = "square"
    corner_radius_mm: Annotated[float, Field(ge=0, le=20)] = 3
    lip_depth_mm: Annotated[float, Field(ge=0, le=3)] = 0.4
    shadow_gap: ShadowGap = Field(default_factory=lambda: ShadowGap(enabled=False, width_mm=1.0, depth_mm=0.8))
    matting: Matting = Field(default_factory=lambda: Matting(enabled=False, width_mm=6, proud_mm=0.4))
    separate: Separate = Field(default_factory=lambda: Separate(enabled=False, mount="snap", tolerance_mm=0.2))
    texture: Texture = Field(default_factory=lambda: Texture(pattern="none", scale_mm=1.0, depth_mm=0.2))


class HangerMagnet(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    diameter_mm: Annotated[float, Field(ge=3, le=20)] = 6
    thickness_mm: Annotated[float, Field(ge=1, le=10)] = 2
    count: Annotated[int, Field(ge=1, le=8)] = 2


class ObjectOverride(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    osm_id: Annotated[str, Field(max_length=32)]
    layer: Literal["building", "road", "water", "green"]
    hidden: bool = False
    height_scale: Annotated[float, Field(ge=0.1, le=4.0)] = 1.0
    hero: Literal["inherit", "on", "off"] = "inherit"
    tint: Annotated[str, Field(pattern="^$|^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")] = ""
    slot: Annotated[int, Field(ge=0, le=16)] = 0
    color: Annotated[str, Field(pattern="^$|^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")] = ""
    road_mode: Literal["inherit", "engrave", "emboss", "off"] = "inherit"
    width_scale: Annotated[float, Field(ge=0.25, le=4.0)] = 1.0
    raise_mm: Annotated[float, Field(ge=-2.0, le=2.0)] = 0.0


class Label(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    target_osm_id: Annotated[str, Field(max_length=32)]
    layer: Literal["building", "road", "water", "green"]
    surface: Literal["building_top", "ground"]
    u: Annotated[float, Field(ge=0, le=1)] = 0.5
    v: Annotated[float, Field(ge=0, le=1)] = 0.5
    rotation_deg: Annotated[float, Field(ge=-180, le=180)] = 0
    size_mm: Annotated[float, Field(ge=1.5, le=8.0)] = 4.0
    mode: Literal["engrave", "emboss"] = "engrave"
    depth_mm: Annotated[float, Field(ge=0.2, le=1.5)] = 0.4
    font: Literal["sans", "serif", "mono"] = "sans"
    text: Annotated[str, Field(max_length=64)] = ""
    follow: bool = False


class PrintParams(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    schema_version: Literal[2, 3, 4] = 4
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
    city_label: Annotated[str, Field(max_length=64)] = ""
    color_mode: Literal["single", "parts"] = "single"
    part_colors: PartColors = Field(default_factory=lambda: PartColors(base="#D8D3C6", frame="#3A3A3A", buildings="#D8D3C6", roads="#3A3A3A", water="#2F7FC1", green="#5A9E4B", trees="#5A9E4B"))
    engravings: Annotated[List[Engraving], Field(max_length=8)] = Field(default_factory=list)
    north_arrow: NorthArrow = Field(default_factory=lambda: NorthArrow(enabled=False, corner="ne", size_mm=4.0))
    scale_bar: ScaleBar = Field(default_factory=lambda: ScaleBar(enabled=False, edge="bottom", length_mode="auto", length_m=500))
    hanger: Literal["none", "keyhole", "magnets", "cleat", "easel"] = "none"
    underside_mark: UndersideMark = Field(default_factory=lambda: UndersideMark(enabled=False, template="{city} {scale} {date}"))
    hero_building_ids: Annotated[List[str], Field(max_length=12)] = Field(default_factory=list)
    hero_mode: Literal["true_height", "own_color", "both"] = "true_height"
    place: Place = Field(default_factory=lambda: Place(country="", state="", neighbourhood="", author=""))
    regions: Regions = Field(default_factory=lambda: Regions(roads=RoadRegion(depth_mm=0.6, proud_mm=-0.2), water=WaterRegion(depth_mm=1.0, proud_mm=-0.5), parks=ParkRegion(depth_mm=0.4, proud_mm=0.0), rail=RailRegion(depth_mm=0.4, proud_mm=0.3, width_m=6.0), building_skirt_mm=0.3))
    colour: Colour = Field(default_factory=lambda: Colour(region_slots=RegionSlots(base=1, frame=1, matting=1, buildings=2, hero_building=4, roads=4, water=3, parks=4, rail=4, lettering=4, attribution=1), region_colors=RegionColors(base="#D8D3C6", frame="#3A3A3A", matting="#EDE9E0", buildings="#D8D3C6", hero_building="#E3A72F", roads="#3A3A3A", water="#2F7FC1", parks="#5A9E4B", rail="#6B6B6B", lettering="#E3A72F", attribution="#D8D3C6"), palette="default", tint=Tint(enabled=False, hue_range_deg=12, lightness_range=0.12, seed=1), gradient=Gradient(enabled=False, slots=[2, 3]), preview_theme="dark"))
    printer_profile: Literal["custom", "bambu-h2s", "bambu-p1s", "bambu-x1c", "bambu-a1", "bambu-a1-mini", "prusa-mk4", "prusa-mini", "ender-3"] = "custom"
    custom_profile: CustomProfile = Field(default_factory=lambda: CustomProfile(plate_x_mm=256, plate_y_mm=256, max_height_mm=60, nozzle_mm=0.4, slots=4, change_gcode="M600"))
    export_target: Literal["bambu-3mf", "generic-3mf", "stl", "stl-parts-zip", "obj", "step", "color-change-3mf"] = "bambu-3mf"
    terrain: Terrain = Field(default_factory=lambda: Terrain(enabled=False, smoothing=1))
    heights: Heights = Field(default_factory=lambda: Heights(floor_height_m=3.0, unknown_default_m=8.0, type_defaults=TypeDefaults(house=6, apartments=15, commercial=12, retail=6, industrial=8, garage=3)))
    bridges: Bridges = Field(default_factory=lambda: Bridges(enabled=True, clearance_mm=1.0, abutments=True))
    height_exaggeration: HeightExaggeration = Field(default_factory=lambda: HeightExaggeration(multiplier=1.0, curve=0.0))
    hero_auto: HeroAuto = Field(default_factory=lambda: HeroAuto(enabled=False, count=3))
    tiling: Tiling = Field(default_factory=lambda: Tiling(enabled=False, cols=1, rows=1, joint="dovetail", tolerance_mm=0.15, index_mark=True))
    frame_style: FrameStyle = Field(default_factory=lambda: FrameStyle(profile="plain", corner="square", corner_radius_mm=3, lip_depth_mm=0.4, shadow_gap=ShadowGap(enabled=False, width_mm=1.0, depth_mm=0.8), matting=Matting(enabled=False, width_mm=6, proud_mm=0.4), separate=Separate(enabled=False, mount="snap", tolerance_mm=0.2), texture=Texture(pattern="none", scale_mm=1.0, depth_mm=0.2)))
    hanger_magnet: HangerMagnet = Field(default_factory=lambda: HangerMagnet(diameter_mm=6, thickness_mm=2, count=2))
    object_overrides: Annotated[List[ObjectOverride], Field(max_length=24)] = Field(default_factory=list)
    labels: Annotated[List[Label], Field(max_length=12)] = Field(default_factory=list)


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


# ---- derived constants --------------------
# Every leaf of PrintParams as a dotted path, in schema order: nested objects
# expanded, arrays of objects as `engravings[].text`, arrays of scalars as one
# leaf. Mirrors apps/web/lib/contracts.ts PRINT_PARAM_LEAF_PATHS exactly.
PRINT_PARAM_LEAF_PATHS: tuple[str, ...] = (
    "schema_version",
    "plate_mm",
    "base_thickness_mm",
    "nozzle_mm",
    "small_scale",
    "large_scale",
    "terrain_exaggeration",
    "road_mode",
    "road_scale",
    "trees",
    "water",
    "frame",
    "city_label",
    "color_mode",
    "part_colors.base",
    "part_colors.frame",
    "part_colors.buildings",
    "part_colors.roads",
    "part_colors.water",
    "part_colors.green",
    "part_colors.trees",
    "engravings[].edge",
    "engravings[].align",
    "engravings[].text",
    "engravings[].mode",
    "engravings[].size_mm",
    "engravings[].depth_mm",
    "engravings[].font",
    "north_arrow.enabled",
    "north_arrow.corner",
    "north_arrow.size_mm",
    "scale_bar.enabled",
    "scale_bar.edge",
    "scale_bar.length_mode",
    "scale_bar.length_m",
    "hanger",
    "underside_mark.enabled",
    "underside_mark.template",
    "hero_building_ids",
    "hero_mode",
    "place.country",
    "place.state",
    "place.neighbourhood",
    "place.author",
    "regions.roads.depth_mm",
    "regions.roads.proud_mm",
    "regions.water.depth_mm",
    "regions.water.proud_mm",
    "regions.parks.depth_mm",
    "regions.parks.proud_mm",
    "regions.rail.depth_mm",
    "regions.rail.proud_mm",
    "regions.rail.width_m",
    "regions.building_skirt_mm",
    "colour.region_slots.base",
    "colour.region_slots.frame",
    "colour.region_slots.matting",
    "colour.region_slots.buildings",
    "colour.region_slots.hero_building",
    "colour.region_slots.roads",
    "colour.region_slots.water",
    "colour.region_slots.parks",
    "colour.region_slots.rail",
    "colour.region_slots.lettering",
    "colour.region_slots.attribution",
    "colour.region_colors.base",
    "colour.region_colors.frame",
    "colour.region_colors.matting",
    "colour.region_colors.buildings",
    "colour.region_colors.hero_building",
    "colour.region_colors.roads",
    "colour.region_colors.water",
    "colour.region_colors.parks",
    "colour.region_colors.rail",
    "colour.region_colors.lettering",
    "colour.region_colors.attribution",
    "colour.palette",
    "colour.tint.enabled",
    "colour.tint.hue_range_deg",
    "colour.tint.lightness_range",
    "colour.tint.seed",
    "colour.gradient.enabled",
    "colour.gradient.slots",
    "colour.preview_theme",
    "printer_profile",
    "custom_profile.plate_x_mm",
    "custom_profile.plate_y_mm",
    "custom_profile.max_height_mm",
    "custom_profile.nozzle_mm",
    "custom_profile.slots",
    "custom_profile.change_gcode",
    "export_target",
    "terrain.enabled",
    "terrain.smoothing",
    "heights.floor_height_m",
    "heights.unknown_default_m",
    "heights.type_defaults.house",
    "heights.type_defaults.apartments",
    "heights.type_defaults.commercial",
    "heights.type_defaults.retail",
    "heights.type_defaults.industrial",
    "heights.type_defaults.garage",
    "bridges.enabled",
    "bridges.clearance_mm",
    "bridges.abutments",
    "height_exaggeration.multiplier",
    "height_exaggeration.curve",
    "hero_auto.enabled",
    "hero_auto.count",
    "tiling.enabled",
    "tiling.cols",
    "tiling.rows",
    "tiling.joint",
    "tiling.tolerance_mm",
    "tiling.index_mark",
    "frame_style.profile",
    "frame_style.corner",
    "frame_style.corner_radius_mm",
    "frame_style.lip_depth_mm",
    "frame_style.shadow_gap.enabled",
    "frame_style.shadow_gap.width_mm",
    "frame_style.shadow_gap.depth_mm",
    "frame_style.matting.enabled",
    "frame_style.matting.width_mm",
    "frame_style.matting.proud_mm",
    "frame_style.separate.enabled",
    "frame_style.separate.mount",
    "frame_style.separate.tolerance_mm",
    "frame_style.texture.pattern",
    "frame_style.texture.scale_mm",
    "frame_style.texture.depth_mm",
    "hanger_magnet.diameter_mm",
    "hanger_magnet.thickness_mm",
    "hanger_magnet.count",
    "object_overrides[].osm_id",
    "object_overrides[].layer",
    "object_overrides[].hidden",
    "object_overrides[].height_scale",
    "object_overrides[].hero",
    "object_overrides[].tint",
    "object_overrides[].slot",
    "object_overrides[].color",
    "object_overrides[].road_mode",
    "object_overrides[].width_scale",
    "object_overrides[].raise_mm",
    "labels[].target_osm_id",
    "labels[].layer",
    "labels[].surface",
    "labels[].u",
    "labels[].v",
    "labels[].rotation_deg",
    "labels[].size_mm",
    "labels[].mode",
    "labels[].depth_mm",
    "labels[].font",
    "labels[].text",
    "labels[].follow",
)
