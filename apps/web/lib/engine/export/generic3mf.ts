// Core-spec 3MF writer (the "generic" target), the browser twin of
// services/bake/app/export/mf3.py.
//
// Parts mode: `<basematerials id="1">` with one `<base>` per region, one mesh
// `<object>` per region carrying `pid`/`pindex`, one assembly object whose
// `<components>` list every region with an identity transform, and exactly
// one `<build><item>` for that assembly. Single mode: every region merged into
// one mesh, one object, one item. Both are what app/validate/container.py's
// rows accept (`3mf_parts`, `3mf_unit`, `3mf_objects`, `3mf_build_items`,
// `3mf_attribution`, `3mf_counts`, plus `3mf_components` / `3mf_materials`
// for a parts file).
//
// `<basematerials>` is part of the 3MF core specification (section 5.1), not
// the materials extension; no `m:` resource is needed for a per-part colour.
// Non-reserved metadata names carry the `framecraft:` prefix, which the core
// spec requires for anything outside its reserved list.

import type { EngineResult, ExportFile, RegionMesh } from "../types";
import {
  APPLICATION,
  ATTRIBUTION,
  LICENSE_LINE,
  colorRgba,
  description,
  isoDate,
  VERTEX_DECIMALS,
  orderedRegions,
  placeMerged,
  placeInBuildSpace,
  provenanceEntries,
  resolveOptions,
  type ExportOptions,
  type ResolvedExportOptions,
} from "./common";
import { XML_DECLARATION, escapeAttr, escapeText, fmtNum, transform3mf } from "./xml";
import { zipEntries } from "./zip";

export const CORE_NAMESPACE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
export const FRAMECRAFT_NAMESPACE = "https://framecraft.app/3mf/2026";
export const REL_TYPE_MODEL = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";
export const MODEL_CONTENT_TYPE = "application/vnd.ms-package.3dmanufacturing-3dmodel+xml";
export const RELS_CONTENT_TYPE = "application/vnd.openxmlformats-package.relationships+xml";

export const CONTENT_TYPES_PART = "[Content_Types].xml";
export const RELS_PART = "_rels/.rels";
export const MODEL_PART = "3D/3dmodel.model";

/** Resource id of the `<basematerials>`; mesh objects start at 2. */
export const MATERIALS_ID = 1;

export const MIME_3MF = "model/3mf";

export const CONTENT_TYPES_XML =
  XML_DECLARATION +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  `<Default Extension="rels" ContentType="${RELS_CONTENT_TYPE}"/>` +
  `<Default Extension="model" ContentType="${MODEL_CONTENT_TYPE}"/>` +
  "</Types>\n";

export const RELS_XML =
  XML_DECLARATION +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  `<Relationship Id="rel0" Type="${REL_TYPE_MODEL}" Target="/${MODEL_PART}"/>` +
  "</Relationships>\n";

/** `<mesh>` with every vertex and triangle; indices are validated against the vertex count. */
export function meshXml(positions: ArrayLike<number>, indices: ArrayLike<number>, indent = ""): string {
  const vertexCount = Math.floor(positions.length / 3);
  const parts: string[] = [];
  parts.push(`${indent}<mesh>\n${indent}<vertices>\n`);
  for (let i = 0; i + 2 < positions.length; i += 3) {
    parts.push(
      `${indent}<vertex x="${fmtNum(positions[i], VERTEX_DECIMALS)}"` +
        ` y="${fmtNum(positions[i + 1], VERTEX_DECIMALS)}"` +
        ` z="${fmtNum(positions[i + 2], VERTEX_DECIMALS)}"/>\n`,
    );
  }
  parts.push(`${indent}</vertices>\n${indent}<triangles>\n`);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) {
      throw new Error(`triangle ${i / 3} references a vertex beyond ${vertexCount}`);
    }
    parts.push(`${indent}<triangle v1="${a}" v2="${b}" v3="${c}"/>\n`);
  }
  parts.push(`${indent}</triangles>\n${indent}</mesh>\n`);
  return parts.join("");
}

export function metadataXml(entries: ReadonlyArray<readonly [string, string]>, indent = ""): string {
  return entries.map(([name, value]) => `${indent}<metadata name="${escapeAttr(name)}">${escapeText(value)}</metadata>\n`).join("");
}

/** The reserved-name block plus the `framecraft:` custom entries. */
export function genericMetadata(result: EngineResult, resolved: ResolvedExportOptions): Array<[string, string]> {
  const entries: Array<[string, string]> = [
    ["Title", resolved.title],
    ["Designer", resolved.designer],
    ["Description", description(result, resolved)],
    ["Copyright", ATTRIBUTION],
    ["LicenseTerms", LICENSE_LINE],
    ["Application", APPLICATION],
    ["CreationDate", isoDate(resolved.created)],
    ["framecraft:attribution", ATTRIBUTION],
    ["framecraft:scale", `1:${result.stats.scaleDenominator}`],
    // The provenance block, verbatim and in the same order as every other
    // format writes it (`common.provenanceEntries`, `[V3-P7-A10]`).
    ...provenanceEntries(result, resolved).map(
      ([key, value]) => [`framecraft:${key}`, value] as [string, string],
    ),
  ];
  if (resolved.source) {
    entries.push(["framecraft:lat", String(resolved.source.lat)]);
    entries.push(["framecraft:lon", String(resolved.source.lon)]);
    if (resolved.source.radius_m !== undefined) entries.push(["framecraft:radius_m", String(resolved.source.radius_m)]);
    if (resolved.source.rotation_deg !== undefined) entries.push(["framecraft:rotation_deg", String(resolved.source.rotation_deg)]);
    if (resolved.source.preset_id) entries.push(["framecraft:preset_id", resolved.source.preset_id]);
  }
  return entries;
}

export interface Generic3mfOptions extends ExportOptions {
  /**
   * "parts" writes one object per region with its colour; "single" merges
   * every region into one object. Defaults to the params' `color_mode`.
   */
  mode?: "parts" | "single";
}

export function partsModelXml(regions: readonly RegionMesh[], metadata: ReadonlyArray<readonly [string, string]>, assemblyName: string): string {
  if (regions.length === 0) {
    throw new Error("a parts 3MF needs at least one region with triangles");
  }
  const parts: string[] = [];
  parts.push(XML_DECLARATION);
  parts.push(
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NAMESPACE}" xmlns:framecraft="${FRAMECRAFT_NAMESPACE}">\n`,
  );
  parts.push(metadataXml(metadata));
  parts.push("<resources>\n");
  parts.push(`<basematerials id="${MATERIALS_ID}">\n`);
  regions.forEach((region) => {
    parts.push(`<base name="${escapeAttr(region.region)}" displaycolor="${colorRgba(region.colorHex)}"/>\n`);
  });
  parts.push("</basematerials>\n");
  regions.forEach((region, index) => {
    const id = MATERIALS_ID + 1 + index;
    parts.push(`<object id="${id}" name="${escapeAttr(region.region)}" type="model" pid="${MATERIALS_ID}" pindex="${index}">\n`);
    parts.push(meshXml(region.positions, region.indices));
    parts.push("</object>\n");
  });
  const assemblyId = MATERIALS_ID + 1 + regions.length;
  parts.push(`<object id="${assemblyId}" name="${escapeAttr(assemblyName)}" type="model">\n<components>\n`);
  regions.forEach((_region, index) => {
    parts.push(`<component objectid="${MATERIALS_ID + 1 + index}" transform="${transform3mf()}"/>\n`);
  });
  parts.push("</components>\n</object>\n</resources>\n");
  parts.push(`<build>\n<item objectid="${assemblyId}" transform="${transform3mf()}"/>\n</build>\n</model>\n`);
  return parts.join("");
}

export function singleModelXml(positions: ArrayLike<number>, indices: ArrayLike<number>, metadata: ReadonlyArray<readonly [string, string]>, name: string): string {
  if (indices.length < 3) {
    throw new Error("a single 3MF needs at least one triangle");
  }
  return (
    XML_DECLARATION +
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NAMESPACE}" xmlns:framecraft="${FRAMECRAFT_NAMESPACE}">\n` +
    metadataXml(metadata) +
    "<resources>\n" +
    `<object id="1" name="${escapeAttr(name)}" type="model">\n` +
    meshXml(positions, indices) +
    "</object>\n</resources>\n" +
    `<build>\n<item objectid="1" transform="${transform3mf()}"/>\n</build>\n</model>\n`
  );
}

export function exportGeneric3mf(result: EngineResult, options: Generic3mfOptions = {}): ExportFile {
  const resolved = resolveOptions(result, options);
  const mode = options.mode ?? (result.params.color_mode === "single" ? "single" : "parts");
  const placed = placeInBuildSpace(orderedRegions(result.regions));
  const metadata = genericMetadata(result, resolved);
  const model =
    mode === "single"
      ? (() => {
          // The boolean union, not a concatenation: see `common.placeMerged`.
          const merged = placeMerged(result, placed);
          return singleModelXml(merged.positions, merged.indices, metadata, resolved.title);
        })()
      : partsModelXml(placed.regions, metadata, resolved.title);
  const bytes = zipEntries(
    [
      { name: CONTENT_TYPES_PART, data: CONTENT_TYPES_XML },
      { name: RELS_PART, data: RELS_XML },
      { name: MODEL_PART, data: model },
    ],
    { mtime: resolved.created },
  );
  return { name: `${resolved.stem}.3mf`, mime: MIME_3MF, bytes };
}
