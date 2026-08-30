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
from typing import Callable, Iterable, Protocol, Sequence

import numpy as np
from manifold3d import Error, Manifold, Mesh64, OpType

from app.geom import extrude, transform as T
from app.geom.thicken import RepairedScene

__all__ = [
    "float32_defect_count",
    "Assembly",
    "ColorPart",
    "HERO_COLOR",
    "PART_ORDER",
    "batched_union",
    "assemble",
    "color_parts",
    "finalize",
    "prune_debris",
    "_prune_covered",
    "UNION_DEBRIS_MM3",
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

#: Debris threshold for the PARTS-UNION measurement (mm^3).  Unioning parts that
#: interpenetrate by 0.2 mm leaves a handful of exactly-zero-volume shells at the
#: seams, and those have to go or the union reads as eight bodies.  What must NOT
#: go is a legitimate small island of a colour part: `MIN_BODY_VOLUME_MM3`
#: (0.01 mm^3) would take a 0.0018 mm^3 sliver of road inlay with it and the
#: partition check would then report material the parts really do carry as
#: missing.  A nanolitre is boolean debris and nothing else.
UNION_DEBRIS_MM3 = 1e-9


class LetteringLike(Protocol):
    """Structural view of :class:`app.geom.lettering.LetteringGeometry`.

    Declared structurally so this module does not import ``lettering`` (which
    imports ``extrude``, which imports ``thicken``): the assembly only needs
    three lists of solids.
    """

    cut: Sequence[Manifold]
    emboss: Sequence[Manifold]
    underside_cut: Sequence[Manifold]


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


def finalize(solid: Manifold, min_body_volume: float = MIN_BODY_VOLUME_MM3) -> Manifold:
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
    solid = prune_debris(solid, min_body_volume)
    vertices, faces = mesh_arrays(solid)
    if _is_clean(vertices, faces):
        return solid

    # The reference is taken BEFORE the simplify, and the simplify is checked
    # against it exactly as the weld below is.  It used to be accepted on its
    # status alone, with the reference taken afterwards, so a `simplify` that
    # removed real material could never be caught: on the union of the colour
    # parts (which meet on genuine coincident faces at the recess floor) it ate
    # 0.4326 mm^3 and split a body off, and `make validate` then reported a file
    # the bake had just passed as two disconnected bodies.
    reference = solid.volume()
    simplified = solid.simplify(SIMPLIFY_TOL_MM)
    if simplified.status() == Error.NoError and abs(
        simplified.volume() - reference
    ) <= WELD_VOLUME_TOLERANCE * max(reference, 1.0):
        vertices, faces = mesh_arrays(simplified)
        if _is_clean(vertices, faces):
            return simplified
        solid = simplified
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


#: Every own_color hero shares one accent colour: the FROZEN ``part_colors`` has
#: seven keys and no hero key, and a per-hero palette would need a contract
#: change.  Each hero is still its own object with its own ``<base>`` entry, so
#: "one material entry per part" stays literally true and a user who wants a
#: different filament per hero can re-assign one slot per part in the slicer.
HERO_COLOR = "#E3A72F"

#: The order colour parts are emitted in, and therefore the order they appear in
#: the slicer's part list.  Structural layers first (base, frame), then the
#: buildings and the heroes that stand on them, then the surface layers.
PART_ORDER = ("base", "frame", "buildings", "hero", "roads", "water", "green", "trees")


@dataclass(frozen=True)
class ColorPart:
    """One 3MF ``<object>`` in parts mode.

    ``name`` is the layer name (``base``, ``frame``, ..., or ``hero:<osm id>``)
    and doubles as the object's ``name`` attribute, the ``<base>`` material name
    and the geometry key trimesh gives it when the file is loaded back.
    """

    name: str
    color: str
    solid: Manifold
    layer: str


@dataclass
class Assembly:
    """The finished solid plus every intermediate, for the debug dump."""

    solid: Manifold
    parts: dict[str, Manifold] = field(default_factory=dict)
    counts: dict[str, int] = field(default_factory=dict)
    #: Parts-mode only: one entry per non-empty layer (plus one per own_color
    #: hero), whose union is exactly :attr:`solid`.  Empty in single mode.
    color_parts: list[ColorPart] = field(default_factory=list)
    #: Parts-mode only: the manifold union of :attr:`color_parts`, kept so the
    #: gate can prove it equals :attr:`solid` rather than assuming it.
    parts_union: Manifold | None = None


def assemble(
    repaired: RepairedScene,
    params: T.ParamsLike,
    progress: Callable[[str, float], None] | None = None,
    lettering: "LetteringLike | None" = None,
) -> Assembly:
    """Stage 2: build every solid, union them, and sit the result at Z = 0.

    ``lettering`` is the frame text and the ornaments
    (:func:`app.geom.lettering.build`), already in print millimetres: embossed
    text joins the additive batch, engraved text and the underside pockets join
    the cutters.  It is ``None`` for a parameter set that asks for none of them,
    which is the default and reproduces v1 geometry byte for byte.
    """

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

    building_pairs = extrude.building_solid_pairs(repaired.buildings.solids, params, scale)
    buildings = [solid for _footprint, solid in building_pairs]
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

    # Frame lettering and ornaments.  Embossed text is additive and sits on the
    # lip's top face; engraved text, the north arrow and the scale bar are
    # cutters into that same face; the underside mark and the hanger pockets are
    # cutters into the base from below.  All three lists are empty for a v1
    # parameter set, so nothing about a v1 model changes.
    emboss_text = list(getattr(lettering, "emboss", None) or ())
    cut_text = list(getattr(lettering, "cut", None) or ())
    cut_underside = list(getattr(lettering, "underside_cut", None) or ())
    if emboss_text:
        emboss_union = batched_union(emboss_text)
        if emboss_union is not None:
            parts["lettering-emboss"] = emboss_union
            additive.append(emboss_union)

    _tick("extrude", 0.45)

    solid = batched_union(additive)
    if solid is None:  # pragma: no cover - the base plate always exists
        solid = base

    cutters: list[Manifold] = []
    if road_slab is not None and road_z is not None and road_z < 0.0:
        cutters.append(road_slab)
    if water_slab is not None:
        cutters.append(water_slab)
    text_cutter = batched_union(cut_text)
    if text_cutter is not None:
        parts["lettering-cut"] = text_cutter
        cutters.append(text_cutter)
    underside_cutter = batched_union(cut_underside)
    if underside_cutter is not None:
        parts["underside-cut"] = underside_cutter
        cutters.append(underside_cutter)
    if cutters:
        solid = Manifold.batch_boolean([solid, *cutters], OpType.Subtract)

    solid = finalize(solid)

    _tick("union", 0.8)

    # 04 stage 2.7: sit at exactly z = 0, centred on X and Y.
    min_x, min_y, min_z, max_x, max_y, _max_z = solid.bounding_box()
    offset = (-(min_x + max_x) / 2.0, -(min_y + max_y) / 2.0, -min_z)
    solid = solid.translate(offset)

    assembly = Assembly(solid=solid, parts=parts, counts=counts)
    if not T.parts_mode(params):
        return assembly

    # Parts mode: the same geometry again, cut into one solid per colour.  Every
    # part is built from the primitives above and translated by the SAME offset,
    # so the assembled object is in exactly the position single mode prints it.
    assembly.color_parts = color_parts(
        repaired,
        params,
        base=base,
        building_pairs=building_pairs,
        frame=extrude.frame_lip_part(params),
        road_slab=road_slab,
        road_z=road_z,
        water_slab=water_slab,
        green_slab=green_slab,
        tree_union=tree_union,
        offset=offset,
        text_cutter=text_cutter,
        emboss_solids=emboss_text,
        underside_cutter=underside_cutter,
    )
    # The union is a boolean performed HERE, so its own debris is swept here: two
    # parts that interpenetrate by 0.2 mm re-triangulate into a handful of
    # exactly-zero-volume shells at the seams, which belong to this measurement
    # and to no shipped part (each part was finalized on its own in `emit`).
    # Only the debris: `finalize` would also WELD, and its weld is accepted on a
    # 1e-6 RELATIVE volume match - 0.168 mm^3 on a Chicago plate - which silently
    # ate 0.0153 mm^3 of genuine road inlay and made the partition look broken.
    parts_union = batched_union([p.solid for p in assembly.color_parts])
    assembly.parts_union = (
        None if parts_union is None else prune_debris(parts_union, UNION_DEBRIS_MM3)
    )
    for part in assembly.color_parts:
        parts[f"part-{part.name}"] = part.solid
    counts["color_parts"] = len(assembly.color_parts)
    return assembly


# --------------------------------------------------------------------------
# Colour parts (PrintParams v2, color_mode="parts")
# --------------------------------------------------------------------------

#: Fallback palette, used only for a duck-typed params object that carries no
#: ``part_colors``.  The real defaults live in the FROZEN contract.
DEFAULT_PART_COLORS = {
    "base": "#D8D3C6",
    "frame": "#3A3A3A",
    "buildings": "#D8D3C6",
    "roads": "#3A3A3A",
    "water": "#2F7FC1",
    "green": "#5A9E4B",
    "trees": "#5A9E4B",
}


def part_color(params: T.ParamsLike, layer: str) -> str:
    """The filament colour for one layer, from ``params.part_colors``."""
    palette = getattr(params, "part_colors", None)
    fallback = DEFAULT_PART_COLORS.get(layer, DEFAULT_PART_COLORS["base"])
    if palette is None:
        return fallback
    return str(getattr(palette, layer, None) or fallback)


def color_parts(
    repaired: RepairedScene,
    params: T.ParamsLike,
    *,
    base: Manifold,
    building_pairs: Sequence[tuple],
    frame: Manifold | None,
    road_slab: Manifold | None,
    road_z: float | None,
    water_slab: Manifold | None,
    green_slab: Manifold | None,
    tree_union: Manifold | None,
    offset: tuple[float, float, float],
    text_cutter: Manifold | None = None,
    emboss_solids: Sequence[Manifold] = (),
    underside_cutter: Manifold | None = None,
) -> list[ColorPart]:
    """Cut the assembled model into one solid per colour.

    The parts PARTITION the single-mode solid: their manifold union is the same
    set, so the printed object is identical and every Stage 4 validator sees the
    same geometry.  Where two parts touch they interpenetrate by
    ``extrude.PART_OVERLAP_MM`` instead of meeting on a coincident face:

    * buildings, trees, green and embossed roads already rise from
      ``base_top - 0.2`` (04 stage 2.3's own overlap);
    * the frame lip is lowered by the same 0.2 mm (:func:`extrude.frame_lip_part`);
    * a hero stacks on its block from ``block_top - 0.2`` (Stage 1's rule);
    * a recess becomes an INLAY under its own floor, and the base is pocketed
      0.2 mm shallower than the inlay's bottom and 0.2 mm narrower than its rim
      (:func:`extrude.inlay_slab` / :func:`extrude.recess_pocket`).
    """
    scale = repaired.scale
    out: list[ColorPart] = []

    pending: list[tuple[str, str, Manifold]] = []

    def emit(name: str, layer: str, solid: Manifold | None) -> None:
        """Queue a part.  Nothing is finalized until every part exists.

        The debris sweep needs to know what the OTHER parts hold before it may
        drop a chip (see :func:`_prune_covered`), so the finalize/translate step
        happens once, at the end, instead of here.
        """
        if solid is None or solid.is_empty():
            return
        pending.append((name, layer, solid))

    def carved(solid: Manifold | None, cutters: Sequence[Manifold]) -> Manifold | None:
        """An ADDITIVE part with single mode's CUTTERS taken out of it.

        Single mode subtracts the whole cutter list from the whole additive union
        (``assemble``'s ``cutters`` step), so every additive PART has to lose the
        same material, in the same order, or the two modes describe different
        objects.  It is not hypothetical: ``thicken.merge_recess_ridges`` grows
        the road layer over the buildings it was separated from, so a road groove
        really does clip the corner of a block - 0.0095 mm^3 of it on Chicago,
        which used to ship in the .3mf and not in the .stl of the same bake.

        The list is the FULL one - recesses, then the engraved-text cutter, then
        the underside pockets - and not just the recesses.  Handing only the
        recesses over let three things diverge: an embossed engraving never met
        the engraved-text cutter, buildings/green/trees/heroes met neither the
        text nor the underside cutter, and with the frame OFF the text cutter was
        applied to nothing at all while single mode still subtracted it.
        """
        if solid is None or not cutters:
            return solid
        return Manifold.batch_boolean([solid, *cutters], OpType.Subtract)

    # --- the recesses, deepest first ------------------------------------
    # (layer, polygons, z offset, the single-mode cutter that made the recess)
    recesses: list[tuple[str, list, float, Manifold]] = []
    water_z = T.water_z_mm(params)
    if water_slab is not None and water_z is not None and repaired.water.polygons:
        recesses.append(("water", repaired.water.polygons, water_z, water_slab))
    if road_slab is not None and road_z is not None and road_z < 0.0 and repaired.roads.polygons:
        recesses.append(("roads", repaired.roads.polygons, road_z, road_slab))

    #: The single-mode cutters, in the same order ``assemble`` subtracts them.
    #: Every ADDITIVE part is cut by ALL of them, exactly as the single-mode
    #: union is; the BASE is the one exception, because its recesses are cut by
    #: the deeper ``recess_pocket`` instead and filled back by the inlays.
    recess_cutters = [cutter for _layer, _polys, _z, cutter in recesses]
    all_cutters = list(recess_cutters)
    if text_cutter is not None:
        all_cutters.append(text_cutter)
    if underside_cutter is not None:
        all_cutters.append(underside_cutter)

    pockets = [
        pocket
        for layer, polys, z, _cutter in recesses
        if (pocket := extrude.recess_pocket(polys, params, scale, z)) is not None
    ]
    base_part = base
    if pockets:
        base_part = Manifold.batch_boolean([base, *pockets], OpType.Subtract)
    # The underside mark, the keyhole and the magnet pockets are cut from BELOW
    # and never reach past the base top, so they belong to the base part alone -
    # applying them here is exactly what single mode applied to the whole solid.
    if underside_cutter is not None:
        base_part = Manifold.batch_boolean([base_part, underside_cutter], OpType.Subtract)
    emit("base", "base", base_part)

    # Engraved text is cut out of the lip and embossed text stands on it; both
    # are the frame's colour, and both live entirely above the base top, so the
    # partition still holds (single mode subtracts/adds the same solids to the
    # whole model).
    frame_part = frame
    if emboss_solids:
        # Single mode unions the embossed text into the additive batch and cuts
        # the whole batch afterwards, so the emboss is cut too.  Do the same
        # here, in the same order - and when the frame is off there is no lip to
        # carry it, so an emboss with no frame is not emitted at all (the shared
        # layout math refuses those; this is the belt to its braces).
        if frame_part is not None:
            frame_part = batched_union([frame_part, *emboss_solids])
    emit("frame", "frame", carved(frame_part, all_cutters))

    # --- buildings, and one part per own_color hero ----------------------
    want_heroes = T.hero_own_color(params)
    plain: list[Manifold] = []
    heroes: dict[str, list[Manifold]] = {}  # insertion-ordered
    for footprint, solid in building_pairs:
        hero_id = getattr(footprint, "hero_id", None)
        if want_heroes and hero_id is not None:
            heroes.setdefault(str(hero_id), []).append(solid)
        else:
            plain.append(solid)
    emit("buildings", "buildings", carved(batched_union(plain), all_cutters))
    for hero_id, solids in heroes.items():
        emit(f"hero:{hero_id}", "hero", carved(batched_union(solids), all_cutters))

    # --- surface layers --------------------------------------------------
    # ``recesses`` is in LAYER PRECEDENCE order (water, then engraved roads -
    # the order ``repair_scene`` builds them in), and the first layer to claim a
    # patch of floor keeps it.
    claimed: list[Manifold] = []
    for layer, polys, z, _cutter in recesses:
        inlay = extrude.inlay_slab(polys, params, scale, z)
        if inlay is None:
            continue
        # Clip to the plate: with the frame off a recess may legally reach past
        # the plate edge (DECISIONS [P5-fix]) and the inlay's 0.2 mm rim reaches
        # further still, and the chamfer means the plate is not a prism.
        inlay = Manifold.batch_boolean([inlay, base], OpType.Intersect)
        # Never stand proud of the model: where another recess cuts deeper, this
        # inlay is truncated to what single mode actually leaves standing.
        others = [c for other, _p, _z, c in recesses if other != layer]
        if others:
            inlay = Manifold.batch_boolean([inlay, *others], OpType.Subtract)
        # ... and never share that floor with the inlay that claimed it first.
        # Subtracting the other CUTTER (which is what this used to do) truncates
        # this inlay to exactly the other inlay's top plane and leaves both parts
        # filling the same 0.5 mm and presenting the SAME visible floor at the
        # same z - 398 mm^2 of it on Chicago, wherever a road crosses the river,
        # with the filament left to the slicer to arbitrate.  The CLAIM buries
        # this one under the winner instead, so the floor has a single owner and
        # the two still interpenetrate by 0.2 mm rather than sharing a face.
        if claimed:
            inlay = Manifold.batch_boolean([inlay, *claimed], OpType.Subtract)
        claim = extrude.inlay_claim(polys, params, scale, z)
        if claim is not None:
            claimed.append(claim)
        # The text and underside cutters apply to an inlay as well.  They cannot
        # reach one today (text lives above the base top, the pockets below the
        # inlay's floor), but the invariant is "every part loses what single mode
        # subtracts", not "every part we think it can reach".
        extra = [c for c in all_cutters if c not in recess_cutters]
        emit(layer, layer, carved(inlay, extra))
    if road_z is not None and road_z > 0.0:
        # Embossed: additive, not an inlay, so it is cut like every other
        # additive part (the water cutter can reach it).
        emit("roads", "roads", carved(road_slab, all_cutters))
    emit("green", "green", carved(green_slab, all_cutters))
    emit("trees", "trees", carved(tree_union, all_cutters))

    # --- one sweep at the end, now that every part exists ----------------
    solids = [solid for _n, _l, solid in pending]
    for index, (name, layer, solid) in enumerate(pending):
        others = batched_union([s for i, s in enumerate(solids) if i != index])
        swept = _prune_covered(solid, others)
        color = HERO_COLOR if layer == "hero" else part_color(params, layer)
        out.append(
            ColorPart(
                name=name,
                color=color,
                # No unconditional prune: `_prune_covered` has already dropped
                # exactly the chips another part holds, and `finalize`'s own
                # 0.01 mm^3 sweep would take the rest of them out of the model.
                solid=finalize(swept, min_body_volume=0.0).translate(offset),
                layer=layer,
            )
        )

    order = {name: i for i, name in enumerate(PART_ORDER)}
    out.sort(key=lambda p: order.get(p.layer, len(order)))
    return out


def _prune_covered(
    solid: Manifold, others: Manifold | None, min_volume: float = MIN_BODY_VOLUME_MM3
) -> Manifold:
    """Drop a colour part's boolean chips - but only the ones nothing loses.

    A sub-``MIN_BODY_VOLUME_MM3`` shell of a colour part is usually debris left
    where two solids touched, and on the Chicago plates every one of them lies
    inside another part's 0.2 mm interpenetration band, so dropping it changes
    the printed object not at all.  "Usually" is not a guarantee, and an
    unconditional prune is a silent hole in the partition the moment a chip is
    the only thing covering its own patch of ground (measured: 12 chips,
    6.4e-4 mm^3, all covered - today).  So a chip is dropped only when it is
    covered by the other parts, and kept otherwise; the ``bodies`` validator
    still refuses a part that ships a debris shell, which is what makes a KEPT
    chip visible rather than silent.
    """
    bodies = solid.decompose()
    if len(bodies) <= 1 or others is None:
        return solid
    kept: list[Manifold] = []
    dropped = 0
    for body in bodies:
        volume = body.volume()
        if volume >= min_volume:
            kept.append(body)
            continue
        inside = Manifold.batch_boolean([body, others], OpType.Intersect).volume()
        if inside >= volume * (1.0 - 1e-6):
            dropped += 1
            continue
        kept.append(body)
    if not kept or dropped == 0:
        return solid
    return Manifold.batch_boolean(kept, OpType.Add)
