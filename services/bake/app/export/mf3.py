"""3MF writer.  04 stage 3: "3MF is the primary format.  Write it directly."

A 3MF file is an OPC (zip) package with exactly three parts for a single
un-textured model:

* ``[Content_Types].xml`` - declares the ``.rels`` and ``.model`` content types;
* ``_rels/.rels``          - one relationship pointing at the model part;
* ``3D/3dmodel.model``     - the model XML, ``unit="millimeter"``, one
  ``<object type="model">`` holding ``<vertices>`` and ``<triangles>``, and one
  ``<build><item objectid="1"/></build>``.

The ``<metadata>`` block carries the OSM attribution, the location and the full
PrintParams, so a file found on a disk two years from now is self-describing.
Only names reserved by the 3MF core specification are used (Title, Designer,
Description, Copyright, LicenseTerms, CreationDate, Application); anything else
would need its own XML namespace.
"""
from __future__ import annotations

import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping
from xml.sax.saxutils import escape, quoteattr

import numpy as np

__all__ = [
    "CORE_NAMESPACE",
    "ATTRIBUTION",
    "CONTENT_TYPES_PART",
    "RELS_PART",
    "MODEL_PART",
    "write_3mf",
    "read_metadata",
]

CORE_NAMESPACE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
REL_TYPE = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"
MODEL_CONTENT_TYPE = "application/vnd.ms-package.3dmanufacturing-3dmodel+xml"
RELS_CONTENT_TYPE = "application/vnd.openxmlformats-package.relationships+xml"

ATTRIBUTION = "© OpenStreetMap contributors"

CONTENT_TYPES_PART = "[Content_Types].xml"
RELS_PART = "_rels/.rels"
MODEL_PART = "3D/3dmodel.model"

#: Metadata names reserved by the 3MF core spec (section "Metadata").  Anything
#: outside this set must be namespaced, so the writer refuses it.
RESERVED_METADATA = (
    "Title",
    "Designer",
    "Description",
    "Copyright",
    "LicenseTerms",
    "Rating",
    "CreationDate",
    "ModificationDate",
    "Application",
)

_CONTENT_TYPES_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    f'<Default Extension="rels" ContentType="{RELS_CONTENT_TYPE}"/>'
    f'<Default Extension="model" ContentType="{MODEL_CONTENT_TYPE}"/>'
    "</Types>\n"
)

_RELS_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    f'<Relationship Id="rel0" Type="{REL_TYPE}" Target="/{MODEL_PART}"/>'
    "</Relationships>\n"
)


#: Vertex coordinates are written with twelve decimals - fixed point, never
#: scientific notation (the 3MF schema's ST_Number is a plain decimal).  Twelve
#: decimals is three orders of magnitude finer than manifold3d's own working
#: tolerance for a 180 mm plate, so no two distinct vertices can collapse into
#: one on the way through the file and turn a watertight solid into a
#: non-manifold one.  The trailing zeros cost nothing after DEFLATE.
_VERTEX_FMT = '<vertex x="%.12f" y="%.12f" z="%.12f"/>'


def _vertices_xml(vertices: np.ndarray) -> str:
    rows = np.asarray(vertices, dtype=np.float64).tolist()
    fmt = _VERTEX_FMT.__mod__
    return "".join(fmt((x, y, z)) for x, y, z in rows)


def _triangles_xml(triangles: np.ndarray) -> str:
    rows = np.asarray(triangles, dtype=np.int64).tolist()
    fmt = '<triangle v1="%d" v2="%d" v3="%d"/>'.__mod__
    return "".join(fmt((a, b, c)) for a, b, c in rows)


def model_xml(
    vertices: np.ndarray, triangles: np.ndarray, metadata: Mapping[str, str]
) -> str:
    """The ``3D/3dmodel.model`` document as a string."""
    meta = "".join(
        f"<metadata name={quoteattr(name)}>{escape(str(value))}</metadata>"
        for name, value in metadata.items()
        if value is not None
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<model unit="millimeter" xml:lang="en-US" xmlns="{CORE_NAMESPACE}">'
        f"{meta}"
        "<resources>"
        '<object id="1" type="model">'
        "<mesh>"
        f"<vertices>{_vertices_xml(vertices)}</vertices>"
        f"<triangles>{_triangles_xml(triangles)}</triangles>"
        "</mesh>"
        "</object>"
        "</resources>"
        "<build>"
        '<item objectid="1"/>'
        "</build>"
        "</model>\n"
    )


def build_metadata(
    *,
    title: str,
    scene_request: Mapping[str, object],
    print_params: Mapping[str, object],
    designer: str = "FrameCraft",
    created: datetime | None = None,
) -> dict[str, str]:
    """The reserved-name metadata block 04 stage 3 asks for.

    ``Description`` carries the attribution, the location (lat, lon, radius_m,
    rotation_deg, preset_id) and the full parameter set, in that order, as one
    human-readable line.
    """
    when = created or datetime.now(timezone.utc)
    location = (
        f"lat={scene_request.get('lat')} lon={scene_request.get('lon')} "
        f"radius_m={scene_request.get('radius_m')} "
        f"rotation_deg={scene_request.get('rotation_deg')} "
        f"preset_id={scene_request.get('preset_id')}"
    )
    params = " ".join(f"{k}={v}" for k, v in sorted(print_params.items()))
    return {
        "Title": title,
        "Designer": designer,
        "Description": (
            f"{ATTRIBUTION}, ODbL. Produced work by FrameCraft. "
            f"Location: {location}. PrintParams: {params}."
        ),
        "Copyright": ATTRIBUTION,
        "LicenseTerms": "OpenStreetMap data is licensed under the ODbL 1.0.",
        "Application": "FrameCraft",
        "CreationDate": when.date().isoformat(),
    }


def write_3mf(
    path: str | Path,
    vertices: np.ndarray,
    triangles: np.ndarray,
    metadata: Mapping[str, str],
) -> Path:
    """Write a single-object 3MF package.  Returns the path written."""
    unknown = [name for name in metadata if name not in RESERVED_METADATA]
    if unknown:
        raise ValueError(f"non-reserved 3MF metadata names need a namespace: {unknown}")

    vertices = np.asarray(vertices, dtype=np.float64)
    triangles = np.asarray(triangles, dtype=np.int64)
    if vertices.ndim != 2 or vertices.shape[1] != 3:
        raise ValueError("vertices must be (N, 3)")
    if triangles.ndim != 2 or triangles.shape[1] != 3:
        raise ValueError("triangles must be (M, 3)")

    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    document = model_xml(vertices, triangles, metadata)
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        zf.writestr(CONTENT_TYPES_PART, _CONTENT_TYPES_XML)
        zf.writestr(RELS_PART, _RELS_XML)
        zf.writestr(MODEL_PART, document)
    return out


#: Refuse to decompress a model part larger than this (zip-bomb guard).
MAX_MODEL_PART_BYTES = 512 * 1024 * 1024


def read_metadata(path: str | Path) -> dict[str, str]:
    """Read the ``<metadata>`` block back out of a 3MF package.

    Hardened for the CLI, which may be pointed at a file from anywhere: the
    model part's declared size is checked before it is decompressed, and a
    document carrying a DOCTYPE is rejected outright rather than handed to
    ``ElementTree`` (whose expat parser expands internal entities, i.e. the
    "billion laughs" amplification).  3MF has no legitimate use for a DTD.
    """
    import xml.etree.ElementTree as ET

    with zipfile.ZipFile(path) as zf:
        info = zf.getinfo(MODEL_PART)
        if info.file_size > MAX_MODEL_PART_BYTES:
            raise ValueError(f"{MODEL_PART} is implausibly large ({info.file_size} bytes)")
        payload = zf.read(MODEL_PART)
    head = payload[:4096].lstrip()
    if b"<!DOCTYPE" in head or b"<!ENTITY" in payload[:4096]:
        raise ValueError("3MF model part declares a DTD; refusing to parse it")
    root = ET.fromstring(payload)
    out: dict[str, str] = {}
    for node in root.findall(f"{{{CORE_NAMESPACE}}}metadata"):
        name = node.get("name")
        if name:
            out[name] = node.text or ""
    return out
