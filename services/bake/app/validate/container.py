"""3MF CONTAINER checks: the package a bake writes, not the mesh inside it.

04 stage 3 specifies the package (``[Content_Types].xml``, ``_rels/.rels``,
``3D/3dmodel.model``, ``unit="millimeter"``, the metadata carrying the OSM
attribution) and A6 needs a slicer to open it as ONE object sitting on the bed.
None of that is a question about a mesh, so it does not belong in
``checks.validate`` (DECISIONS [P5-qa]) - but it does belong in the BAKE: the
job that writes the file is the job that must audit it, or ``POST /bake`` marks
a download ``done`` on a package whose material table, component graph and build
item nobody ever read (v2-02 audit, finding 5).

This module is therefore the shared home of those rows.  ``app/cli.py``'s
``validate`` command and ``app/bake.py``'s pipeline call exactly the same
functions on exactly the same file.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, Sequence

if TYPE_CHECKING:  # pragma: no cover - import-time typing only
    import trimesh

    from app.validate.checks import Check

__all__ = [
    "document",
    "is_parts",
    "parts_checks",
    "structure_checks",
    "color_mode_check",
    "is_rgba8",
    "IDENTITY_TRANSFORM",
    "parse_transform",
]

#: A 3MF ``transform`` is a row-major 4x3 matrix; this is the identity.
IDENTITY_TRANSFORM = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0)
#: How far a transform entry may differ from the identity and still count as one.
TRANSFORM_EPS = 1e-9


def parse_transform(value: str | None) -> tuple[float, ...] | None:
    """A 3MF ``transform`` attribute as twelve floats, or None when absent.

    Returns the identity for an unparseable value so the caller reports "not the
    identity" rather than crashing on someone else's file.
    """
    if value is None:
        return None
    parts = value.replace(",", " ").split()
    if len(parts) != 12:
        return tuple([float("nan")] * 12)
    try:
        return tuple(float(p) for p in parts)
    except ValueError:
        return tuple([float("nan")] * 12)


def is_identity(matrix: tuple[float, ...] | None) -> bool:
    """True when a parsed transform is the identity (or absent)."""
    if matrix is None:
        return True
    if len(matrix) != len(IDENTITY_TRANSFORM):
        return False
    return all(
        abs(a - b) <= TRANSFORM_EPS for a, b in zip(matrix, IDENTITY_TRANSFORM)
    )


def document(path: Path) -> tuple[list["Check"], Any]:
    """(container rows for the package itself, parsed model root or None).

    Shared by the single-colour and the parts row builders so a broken package
    is reported the same way in both: the three OPC parts, no DTD, well-formed
    XML.  ``None`` for the root means one of those rows already FAILED and there
    is nothing more to say about the model.
    """
    import xml.etree.ElementTree as ET
    import zipfile

    from app.export import mf3
    from app.validate.checks import Check

    required = (mf3.CONTENT_TYPES_PART, mf3.RELS_PART, mf3.MODEL_PART)
    threshold_parts = ", ".join(required)
    try:
        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
            payload = zf.read(mf3.MODEL_PART) if mf3.MODEL_PART in names else b""
    except (zipfile.BadZipFile, OSError, KeyError) as exc:
        return (
            [
                Check(
                    name="3mf_parts",
                    passed=False,
                    value=f"unreadable: {type(exc).__name__}",
                    threshold=threshold_parts,
                    message=f"{path.name} is not a readable OPC (zip) package: {exc}",
                )
            ],
            None,
        )

    missing = [part for part in required if part not in names]
    checks = [
        Check(
            name="3mf_parts",
            passed=not missing,
            value=f"{len(names)} parts" + (f", missing {', '.join(missing)}" if missing else ""),
            threshold=threshold_parts,
            message=(
                f"missing required 3MF part(s): {', '.join(missing)}"
                if missing
                else "[Content_Types].xml, _rels/.rels and 3D/3dmodel.model are all present"
            ),
        )
    ]
    if not payload:
        return checks, None

    # Same hardening as mf3.read_metadata: a 3MF has no legitimate use for a DTD.
    if b"<!DOCTYPE" in payload[:4096] or b"<!ENTITY" in payload[:4096]:
        checks.append(
            Check(
                name="3mf_model_xml",
                passed=False,
                value="declares a DTD",
                threshold="no DTD",
                message="the model part declares a DTD; refusing to parse it",
            )
        )
        return checks, None

    try:
        root = ET.fromstring(payload)
    except ET.ParseError as exc:
        checks.append(
            Check(
                name="3mf_model_xml",
                passed=False,
                value=f"unparseable: {exc}",
                threshold="well-formed XML",
                message=f"3D/3dmodel.model is not well-formed XML: {exc}",
            )
        )
        return checks, None
    return checks, root


def is_parts(path: Path) -> bool:
    """True when the package is a multi-material (``color_mode="parts"``) one.

    Read off the FILE, never off the sidecar: an ``<object>`` that holds
    ``<components>`` is the 3MF way of saying "this object is assembled from
    those parts", and that is what a slicer acts on.  ``cmd_validate`` compares
    this with the sidecar's ``color_mode`` and fails if the two disagree.
    """
    from app.export import mf3

    _checks, root = document(path)
    if root is None:
        return False
    ns = f"{{{mf3.CORE_NAMESPACE}}}"
    return any(obj.find(f"{ns}components") is not None for obj in root.iter(f"{ns}object"))


def parts_checks(
    path: Path, parts: "Sequence[tuple[str, trimesh.Trimesh]]"
) -> tuple[list["Check"], int | None]:
    """Container checks for a PARTS ``.3mf`` (04 stage 3 + PrintParams v2).

    The single-colour rows are redefined for this shape rather than weakened:
    ``3mf_objects`` still says "one object gets built", it is just spelled "N
    mesh objects and exactly one assembly object" here, and ``3mf_counts`` still
    matches every vertex and triangle the XML declares against the loader's,
    summed over the parts.  Two rows are new: ``3mf_materials`` (one
    ``<base>`` per part, every colour a real ``#RRGGBBAA``, every ``pindex`` in
    range) and ``3mf_components`` (exactly one build item, pointing at an
    assembly whose children all exist and are all mesh objects).
    """
    from app.export import mf3
    from app.validate.checks import Check

    checks, root = document(path)
    if root is None:
        return checks, None
    ns = f"{{{mf3.CORE_NAMESPACE}}}"

    unit = root.get("unit")
    checks.append(
        Check(
            name="3mf_unit",
            passed=unit == "millimeter",
            value=unit or "-",
            threshold="millimeter",
            message=(
                "the model is declared in millimetres"
                if unit == "millimeter"
                else f"unit is {unit!r}; a FrameCraft plate is authored in millimetres"
            ),
        )
    )

    objects = list(root.iter(f"{ns}object"))
    by_id = {obj.get("id"): obj for obj in objects}
    meshes = [obj for obj in objects if obj.find(f"{ns}mesh") is not None]
    assemblies = [obj for obj in objects if obj.find(f"{ns}components") is not None]
    objects_ok = len(assemblies) == 1 and len(meshes) == len(objects) - 1 and len(meshes) >= 1
    checks.append(
        Check(
            name="3mf_objects",
            passed=objects_ok,
            value=f"{len(meshes)} mesh + {len(assemblies)} assembly",
            threshold="N mesh objects + exactly 1 assembly object",
            message=(
                f"{len(meshes)} coloured parts assembled into one object, so a slicer "
                "shows a single object with one part per filament"
                if objects_ok
                else f"{len(objects)} objects: {len(meshes)} with a mesh and "
                f"{len(assemblies)} with components; a parts file needs exactly one "
                "assembly and the rest meshes"
            ),
        )
    )

    build = root.find(f"{ns}build")
    items = [] if build is None else build.findall(f"{ns}item")
    checks.append(
        Check(
            name="3mf_build_items",
            passed=len(items) == 1,
            value=len(items),
            threshold=1,
            message=(
                "exactly one <build><item>, placed once on the bed"
                if len(items) == 1
                else f"{len(items)} build items; A6 needs exactly one"
            ),
        )
    )

    # --- 3mf_components: the build item points at the assembly, whose children
    # all exist, are all mesh objects, are all DISTINCT, cover every mesh object
    # in the file, and carry no transform.
    #
    # A count alone is not enough and the v2-02 audit proved it: a file whose
    # <components> names the buildings part twice and the base part not at all
    # passed every row, and a slicer would have built two towers and no plate.
    # A <component transform> is worse, because it is silently CORRECT 3MF: the
    # geometry rows used to be computed on the LOCAL meshes, so a part displaced
    # 25 mm sideways read as one solid sitting on the bed.  Those rows now judge
    # the PLACED parts (``cli._placed_parts``), so the displacement is measured;
    # this row additionally reports the construct, because FrameCraft writes no
    # transform and a file that carries one was assembled somewhere else.
    problems: list[str] = []
    children: list[str] = []
    mesh_ids = [obj.get("id") for obj in meshes]
    if len(items) != 1:
        problems.append(f"{len(items)} build items")
    else:
        item_transform = parse_transform(items[0].get("transform"))
        if not is_identity(item_transform):
            problems.append(
                f"the build item carries transform={items[0].get('transform')!r}; "
                "this validator judges the parts as authored"
            )
        target = items[0].get("objectid")
        assembly = by_id.get(target)
        if assembly is None:
            problems.append(f"build item points at unknown object {target!r}")
        elif assembly.find(f"{ns}components") is None:
            problems.append(f"object {target!r} has no <components>")
        else:
            for component in assembly.iter(f"{ns}component"):
                ref = component.get("objectid")
                children.append(ref or "?")
                child = by_id.get(ref)
                if child is None:
                    problems.append(f"component points at unknown object {ref!r}")
                elif child.find(f"{ns}mesh") is None:
                    problems.append(f"component {ref!r} is not a mesh object")
                matrix = parse_transform(component.get("transform"))
                if not is_identity(matrix):
                    problems.append(
                        f"component {ref!r} carries transform="
                        f"{component.get('transform')!r}; FrameCraft writes no "
                        "component transform, and one that is not the identity "
                        "means the file was assembled somewhere else"
                    )
    seen: dict[str, int] = {}
    for ref in children:
        seen[ref] = seen.get(ref, 0) + 1
    repeated = sorted(ref for ref, n in seen.items() if n > 1)
    if repeated:
        problems.append(
            "object(s) referenced more than once: "
            + ", ".join(f"{ref} x{seen[ref]}" for ref in repeated)
        )
    unreferenced = [oid for oid in mesh_ids if oid not in seen]
    if children and unreferenced:
        problems.append(
            "mesh object(s) no component references: " + ", ".join(str(o) for o in unreferenced)
        )
    if children and len(children) != len(meshes):
        problems.append(f"{len(children)} components for {len(meshes)} mesh objects")
    distinct = len({ref for ref in children if ref in set(mesh_ids)})
    checks.append(
        Check(
            name="3mf_components",
            passed=not problems and bool(children),
            value=f"{len(children)} components, {distinct} distinct",
            threshold="1 build item -> 1 assembly -> every mesh object once, no transform",
            message=(
                "every part is referenced exactly once by the assembled object"
                if not problems and children
                else "; ".join(problems) or "the build item references no components"
            ),
        )
    )

    # --- 3mf_materials -------------------------------------------------
    resources = root.find(f"{ns}resources")
    groups = [] if resources is None else resources.findall(f"{ns}basematerials")
    entries = [] if len(groups) != 1 else groups[0].findall(f"{ns}base")
    material_ids = {g.get("id") for g in groups}
    bad_colors = [
        f"{e.get('name') or '?'}={e.get('displaycolor')!r}"
        for e in entries
        if not is_rgba8(e.get("displaycolor"))
    ]
    bad_index: list[str] = []
    for obj in meshes:
        pid, pindex = obj.get("pid"), obj.get("pindex")
        if pid not in material_ids:
            bad_index.append(f"object {obj.get('id')} pid={pid!r}")
            continue
        if pindex is None or not pindex.isdigit() or int(pindex) >= len(entries):
            bad_index.append(f"object {obj.get('id')} pindex={pindex!r}")
    materials_ok = (
        len(groups) == 1
        and len(entries) == len(meshes)
        and len(entries) > 0
        and not bad_colors
        and not bad_index
    )
    detail: list[str] = []
    if len(groups) != 1:
        detail.append(f"{len(groups)} <basematerials> resources, need exactly 1")
    elif len(entries) != len(meshes):
        detail.append(f"{len(entries)} material entries for {len(meshes)} parts")
    if bad_colors:
        detail.append(f"displaycolor is not #RRGGBBAA: {', '.join(bad_colors)}")
    if bad_index:
        detail.append(f"material index out of range: {', '.join(bad_index)}")
    checks.append(
        Check(
            name="3mf_materials",
            passed=materials_ok,
            value=f"{len(entries)} entries: "
            + ", ".join(
                f"{e.get('name') or '?'} {(e.get('displaycolor') or '-').upper()}"
                for e in entries[:8]
            ),
            threshold="one <base> per part, #RRGGBBAA, pindex in range",
            message=(
                "one filament slot per part, each with a valid display colour"
                if materials_ok
                else "; ".join(detail)
            ),
        )
    )

    description = ""
    for node in root.findall(f"{ns}metadata"):
        if node.get("name") == "Description":
            description = node.text or ""
    has_attribution = mf3.ATTRIBUTION in description
    checks.append(
        Check(
            name="3mf_attribution",
            passed=has_attribution,
            value=(
                f"present ({len(description)} chars)"
                if has_attribution
                else f"absent ({len(description)} chars of Description)"
            ),
            threshold="OSM attribution in Description",
            message=(
                "the OSM attribution travels with the file"
                if has_attribution
                else "Description metadata does not carry '© OpenStreetMap contributors'"
            ),
        )
    )

    xml_vertices = len(root.findall(f".//{ns}vertex"))
    xml_triangles = len(root.findall(f".//{ns}triangle"))
    loaded_v = sum(len(mesh.vertices) for _name, mesh in parts)
    loaded_t = sum(len(mesh.faces) for _name, mesh in parts)
    counts_ok = xml_vertices == loaded_v and xml_triangles == loaded_t and loaded_t > 0
    checks.append(
        Check(
            name="3mf_counts",
            passed=counts_ok,
            value=f"xml {xml_vertices:,} v / {xml_triangles:,} t",
            threshold=f"parts {loaded_v:,} v / {loaded_t:,} t",
            message=(
                "every vertex and triangle the file declares is in a loaded part"
                if counts_ok
                else f"the XML declares {xml_vertices} vertices / {xml_triangles} "
                f"triangles but the loaded parts hold {loaded_v} / {loaded_t}"
            ),
        )
    )
    # DISTINCT, not len(children): `validate_parts`'s `bodies` row compares this
    # with the number of parts, and a file that names one part twice and another
    # never has to fail there as well as here.
    return checks, distinct


def is_rgba8(value: str | None) -> bool:
    """3MF ``displaycolor`` written the way FrameCraft writes it: 8 hex digits."""
    return bool(value) and re.fullmatch(r"#[0-9A-Fa-f]{8}", str(value)) is not None


def structure_checks(path: Path, mesh: "trimesh.Trimesh") -> list["Check"]:
    """Container checks for a ``.3mf``, on top of 04 stage 4's mesh validators.

    04 stage 3 specifies the package a bake must write and A6 needs a slicer to
    open it as ONE object sitting on the bed, so ``make validate`` judges the
    file as well as the mesh: the three OPC parts exist, the model is declared
    in millimetres, there is exactly one ``<object>`` and exactly one build
    ``<item>`` (two would make a slicer show two bodies), the ``Description``
    metadata carries the OSM attribution the licence requires, and the vertex /
    triangle counts the XML declares are exactly what the loader handed back
    (an object no build item references, or a loader that silently welded, both
    show up here).
    """
    from app.export import mf3
    from app.validate.checks import Check

    checks, root = document(path)
    if root is None:
        return checks

    ns = f"{{{mf3.CORE_NAMESPACE}}}"
    unit = root.get("unit")
    checks.append(
        Check(
            name="3mf_unit",
            passed=unit == "millimeter",
            value=unit or "-",
            threshold="millimeter",
            message=(
                "the model is declared in millimetres"
                if unit == "millimeter"
                else f'unit is {unit!r}; a FrameCraft plate is authored in millimetres'
            ),
        )
    )

    objects = root.findall(f".//{ns}object")
    checks.append(
        Check(
            name="3mf_objects",
            passed=len(objects) == 1,
            value=len(objects),
            threshold=1,
            message=(
                "exactly one <object>, so a slicer shows one body"
                if len(objects) == 1
                else f"{len(objects)} <object> elements; A6 needs exactly one"
            ),
        )
    )

    build = root.find(f"{ns}build")
    items = [] if build is None else build.findall(f"{ns}item")
    checks.append(
        Check(
            name="3mf_build_items",
            passed=len(items) == 1,
            value=len(items),
            threshold=1,
            message=(
                "exactly one <build><item>, placed once on the bed"
                if len(items) == 1
                else f"{len(items)} build items; A6 needs exactly one"
            ),
        )
    )

    description = ""
    for node in root.findall(f"{ns}metadata"):
        if node.get("name") == "Description":
            description = node.text or ""
    has_attribution = mf3.ATTRIBUTION in description
    checks.append(
        Check(
            name="3mf_attribution",
            passed=has_attribution,
            # Deliberately not the text itself: a Windows console codepage that
            # cannot encode "(c)" would turn printing the row into a crash.
            value=(
                f"present ({len(description)} chars)"
                if has_attribution
                else f"absent ({len(description)} chars of Description)"
            ),
            threshold="OSM attribution in Description",
            message=(
                "the OSM attribution travels with the file"
                if has_attribution
                else "Description metadata does not carry '© OpenStreetMap contributors'"
            ),
        )
    )

    xml_vertices = len(root.findall(f".//{ns}vertex"))
    xml_triangles = len(root.findall(f".//{ns}triangle"))
    mesh_counts = (
        f"mesh {len(mesh.vertices):,} v / {len(mesh.faces):,} t"
        if mesh is not None
        else "a loadable mesh"
    )
    counts_ok = mesh is not None and (
        xml_vertices == len(mesh.vertices) and xml_triangles == len(mesh.faces)
    )
    checks.append(
        Check(
            name="3mf_counts",
            passed=counts_ok,
            value=f"xml {xml_vertices:,} v / {xml_triangles:,} t",
            threshold=mesh_counts,
            message=(
                "every vertex and triangle the file declares is in the loaded mesh"
                if counts_ok
                else (
                    f"the XML declares {xml_vertices} vertices / {xml_triangles} triangles "
                    + (
                        f"but the loader produced {len(mesh.vertices)} / {len(mesh.faces)}"
                        if mesh is not None
                        else "but the file did not load as a triangle mesh at all"
                    )
                )
            ),
        )
    )
    return checks


def color_mode_check(structure: str, declared: str | None) -> "Check":
    """The file's shape and its sidecar must tell the same story.

    A parts file whose sidecar says ``single`` (or the other way round) means one
    of the two is stale, and every colour decision below it - which filament
    prints which layer - is then unverifiable.  With no sidecar there is nothing
    to disagree with, so the row records what the FILE says and passes.
    """
    from app.validate.checks import Check

    agree = declared is None or declared == structure
    return Check(
        name="3mf_color_mode",
        passed=agree,
        value=f"file {structure}" + ("" if declared is None else f", sidecar {declared}"),
        threshold="the file structure and the sidecar agree",
        message=(
            (
                f"the file is a {structure}-colour package"
                + ("" if declared is None else " and its sidecar says so")
            )
            if agree
            else f"the file is a {structure}-colour package but its sidecar records "
            f"color_mode={declared!r}; one of the two is stale"
        ),
    )


