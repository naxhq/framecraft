// Bambu Studio project 3MF writer.
//
// Every structural fact below was read off BambuStudio/src/libslic3r/Format/
// bbs_3mf.cpp (master, fetched 2026-08-30) and src/slic3r/GUI/Plater.cpp; the
// line references are in docs/handoff/v3-02-export.md section 2. In short:
//
// * The reader sets `m_is_bbl_3mf` only when the `Application` metadata
//   starts with "BambuStudio-" (the rest is parsed as the generator version);
//   `BambuStudio:3mfVersion` is read but no longer flips the flag, and its
//   absence in the main model is harmless. Without a parseable generator
//   version the project config is never loaded and the GUI shows "The 3mf is
//   not from Bambu Lab, load geometry data and color data only". The GUI also
//   wants `printer_model` to name a BBL vendor model, or, failing that, a
//   `nozzle_diameter` list that is consistent with the other per-extruder
//   options, before it accepts the project config at all.
// * The model is `<model ... xmlns:BambuStudio="http://schemas.bambulab.com/
//   package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/
//   production/2015/06" requiredextensions="p">`. One object per ModelObject
//   holds only `<components>`, one per volume, each pointing with `p:path`
//   at a per-object file `3D/Objects/object_<id>.model` that carries the
//   volume meshes as its own `<object>`s and an empty `<build/>`.
//   `3D/_rels/3dmodel.model.rels` lists every such file with the 3dmodel
//   relationship type; the reader discovers sub-models only through it.
// * `Metadata/model_settings.config` gives the object its name and each
//   `<part id=... subtype="normal_part">` its `name`, `matrix` and config
//   keys such as `extruder`; the `<plate>` block places the instance.
// * `Metadata/project_settings.config` is the flat JSON a DynamicPrintConfig
//   serialises to (every value a string or a string array).

import { resolveProfile, type PrinterProfile } from "../../printers";
import type { EngineResult, ExportFile, RegionMesh } from "../types";
import { constructionOverlapFor, customGcodePerLayerXml, CUSTOM_GCODE_PART, planColorChanges, type ColorChangePlan } from "./colorchange";
import {
  ATTRIBUTION,
  LICENSE_LINE,
  description,
  isoDate,
  orderedRegions,
  placeInBuildSpace,
  resolveOptions,
  slotColors,
  triangleCount,
  type ExportOptions,
  type ResolvedExportOptions,
} from "./common";
import {
  CONTENT_TYPES_PART,
  CORE_NAMESPACE,
  FRAMECRAFT_NAMESPACE,
  MIME_3MF,
  MODEL_CONTENT_TYPE,
  MODEL_PART,
  REL_TYPE_MODEL,
  RELS_CONTENT_TYPE,
  RELS_PART,
  meshXml,
  metadataXml,
} from "./generic3mf";
import { IDENTITY_MATRIX_4X4, XML_DECLARATION, escapeAttr, fmtNum, transform3mf } from "./xml";
import { zipEntries, type ZipEntry } from "./zip";

export const BAMBU_NAMESPACE = "http://schemas.bambulab.com/package/2021";
export const PRODUCTION_NAMESPACE = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06";

/**
 * Generator version written after "BambuStudio-". 2.0.0.0 is the oldest
 * version that skips every legacy migration in the GUI loader (bed-size
 * translation below 1.5.9, prime-tower rewrite below 2.0.0) and is not newer
 * than any 2.x install, so neither the "saved with a newer version" dialog
 * nor the CLI's version refusal fires.
 */
export const BAMBU_APPLICATION_VERSION = "02.00.00.00";
export const BAMBU_APPLICATION = `BambuStudio-${BAMBU_APPLICATION_VERSION}`;
export const BBS_3MF_VERSION = "1";

export const MODEL_RELS_PART = "3D/_rels/3dmodel.model.rels";
export const OBJECT_MODEL_PART = "3D/Objects/object_1.model";
export const MODEL_SETTINGS_PART = "Metadata/model_settings.config";
export const PROJECT_SETTINGS_PART = "Metadata/project_settings.config";
export const SLICE_INFO_PART = "Metadata/slice_info.config";
export const PLATE_JSON_PART = "Metadata/plate_1.json";

const OBJECT_UUID_SUFFIX = "-61cb-4c03-9d28-80fed5dfa1dc";
const SUB_OBJECT_UUID_SUFFIX = "-81cb-4c03-9d28-80fed5dfa1dc";
const COMPONENT_UUID_SUFFIX = "-b206-40ff-9872-83e8017abed1";
const BUILD_UUID = "2c7c17d8-22b5-4d84-8835-1976022ea369";
const BUILD_UUID_SUFFIX = "-b1ec-4553-aec9-835e5b724bb4";

/** The one ModelObject's backup id; object file name and UUIDs derive from it. */
const BACKUP_ID = 1;

export const BAMBU_CONTENT_TYPES_XML =
  XML_DECLARATION +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
  ` <Default Extension="rels" ContentType="${RELS_CONTENT_TYPE}"/>\n` +
  ` <Default Extension="model" ContentType="${MODEL_CONTENT_TYPE}"/>\n` +
  ' <Default Extension="png" ContentType="image/png"/>\n' +
  ' <Default Extension="gcode" ContentType="text/x.gcode"/>\n' +
  "</Types>";

export const BAMBU_RELS_XML =
  XML_DECLARATION +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
  ` <Relationship Target="/${MODEL_PART}" Id="rel-1" Type="${REL_TYPE_MODEL}"/>\n` +
  "</Relationships>";

export const BAMBU_MODEL_RELS_XML =
  XML_DECLARATION +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
  ` <Relationship Target="/${OBJECT_MODEL_PART}" Id="rel-1" Type="${REL_TYPE_MODEL}"/>\n` +
  "</Relationships>";

function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

export interface Bambu3mfOptions extends ExportOptions {
  /** Defaults to `resolveProfile(result.params)`. */
  profile?: PrinterProfile;
  /**
   * The single-nozzle (colour-change) target: every part on extruder 1 and a
   * `Metadata/custom_gcode_per_layer.xml` with one change per separable band.
   */
  singleNozzle?: boolean;
  /** Layer height the colour changes snap to; defaults to 0.2 mm. */
  layerHeightMm?: number;
}

export interface Bambu3mfExport extends ExportFile {
  profile: PrinterProfile;
  /** Present for the single-nozzle target. */
  plan: ColorChangePlan | null;
  /** Object id of the assembly and the part ids in region order, for tests and the sidecar. */
  objectId: number;
  partIds: number[];
}

export interface BambuPart {
  id: number;
  region: RegionMesh;
  extruder: number;
}

function modelHeader(): string {
  return (
    XML_DECLARATION +
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NAMESPACE}" xmlns:BambuStudio="${BAMBU_NAMESPACE}"` +
    ` xmlns:p="${PRODUCTION_NAMESPACE}" requiredextensions="p" xmlns:framecraft="${FRAMECRAFT_NAMESPACE}">\n`
  );
}

export function bambuMetadata(result: EngineResult, resolved: ResolvedExportOptions): Array<[string, string]> {
  const date = isoDate(resolved.created);
  return [
    ["Application", BAMBU_APPLICATION],
    ["BambuStudio:3mfVersion", BBS_3MF_VERSION],
    ["Copyright", ATTRIBUTION],
    ["CreationDate", date],
    ["Description", description(result, resolved)],
    ["Designer", resolved.designer],
    ["License", LICENSE_LINE],
    ["ModificationDate", date],
    ["Origin", ""],
    ["Title", resolved.title],
    ["framecraft:attribution", ATTRIBUTION],
    ["framecraft:generator", "FrameCraft 3.0.0"],
    ["framecraft:scale", `1:${result.stats.scaleDenominator}`],
    ...(resolved.source
      ? ([
          ["framecraft:lat", String(resolved.source.lat)],
          ["framecraft:lon", String(resolved.source.lon)],
        ] as Array<[string, string]>)
      : []),
  ];
}

/** `3D/3dmodel.model`: metadata, the assembly object of components, one build item. */
export function bambuMainModelXml(parts: readonly BambuPart[], objectId: number, metadata: ReadonlyArray<readonly [string, string]>, itemTranslation: readonly [number, number, number]): string {
  const out: string[] = [modelHeader(), metadataXml(metadata, " ")];
  out.push(" <resources>\n");
  out.push(`  <object id="${objectId}" p:UUID="${hex8(BACKUP_ID)}${OBJECT_UUID_SUFFIX}" type="model">\n   <components>\n`);
  parts.forEach((part, index) => {
    out.push(
      `    <component p:path="/${OBJECT_MODEL_PART}" objectid="${part.id}" p:UUID="${hex8(index + (BACKUP_ID << 16))}${COMPONENT_UUID_SUFFIX}" transform="${transform3mf()}"/>\n`,
    );
  });
  out.push("   </components>\n  </object>\n </resources>\n");
  out.push(` <build p:UUID="${BUILD_UUID}">\n`);
  out.push(
    `  <item objectid="${objectId}" p:UUID="${hex8(objectId)}${BUILD_UUID_SUFFIX}" transform="${transform3mf(itemTranslation[0], itemTranslation[1], itemTranslation[2])}" printable="1"/>\n`,
  );
  out.push(" </build>\n</model>\n");
  return out.join("");
}

/** `3D/Objects/object_1.model`: one mesh object per part, no build items. */
export function bambuObjectModelXml(parts: readonly BambuPart[]): string {
  const out: string[] = [modelHeader()];
  out.push(metadataXml([["BambuStudio:3mfVersion", BBS_3MF_VERSION]], " "));
  out.push(" <resources>\n");
  parts.forEach((part, index) => {
    out.push(`  <object id="${part.id}" p:UUID="${hex8(index + (BACKUP_ID << 16))}${SUB_OBJECT_UUID_SUFFIX}" type="model">\n`);
    out.push(meshXml(part.region.positions, part.region.indices, "   "));
    out.push("  </object>\n");
  });
  out.push(" </resources>\n <build/>\n</model>\n");
  return out.join("");
}

export function bambuModelSettingsXml(parts: readonly BambuPart[], objectId: number, objectName: string, objectExtruder: number): string {
  const out: string[] = [XML_DECLARATION, "<config>\n"];
  out.push(`  <object id="${objectId}">\n`);
  out.push(`    <metadata key="name" value="${escapeAttr(objectName)}"/>\n`);
  out.push(`    <metadata key="extruder" value="${objectExtruder}"/>\n`);
  out.push(`    <metadata face_count="${triangleCount(parts.map((p) => p.region))}"/>\n`);
  for (const part of parts) {
    const faces = Math.floor(part.region.indices.length / 3);
    out.push(`    <part id="${part.id}" subtype="normal_part">\n`);
    out.push(`      <metadata key="name" value="${escapeAttr(part.region.region)}"/>\n`);
    out.push(`      <metadata key="matrix" value="${IDENTITY_MATRIX_4X4}"/>\n`);
    out.push(`      <metadata key="extruder" value="${part.extruder}"/>\n`);
    out.push(
      `      <mesh_stat face_count="${faces}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n`,
    );
    out.push("    </part>\n");
  }
  out.push("  </object>\n");
  out.push("  <plate>\n");
  out.push('    <metadata key="plater_id" value="1"/>\n');
  out.push('    <metadata key="plater_name" value=""/>\n');
  out.push('    <metadata key="locked" value="false"/>\n');
  out.push("    <model_instance>\n");
  out.push(`      <metadata key="object_id" value="${objectId}"/>\n`);
  out.push('      <metadata key="instance_id" value="0"/>\n');
  out.push('      <metadata key="identify_id" value="1"/>\n');
  out.push("    </model_instance>\n");
  out.push("  </plate>\n");
  out.push("  <assemble>\n");
  out.push(`   <assemble_item object_id="${objectId}" instance_id="0" transform="${transform3mf()}" offset="0 0 0" />\n`);
  out.push("  </assemble>\n");
  out.push("</config>\n");
  return out.join("");
}

export interface ProjectSettingsInput {
  profile: PrinterProfile;
  filamentColors: string[];
  singleNozzle: boolean;
}

/** `Metadata/project_settings.config`: the flat string-valued JSON Bambu Studio loads as a DynamicPrintConfig. */
export function bambuProjectSettings(input: ProjectSettingsInput): Record<string, string | string[]> {
  const { profile, filamentColors, singleNozzle } = input;
  const x = fmtNum(profile.plateXMm, 3);
  const y = fmtNum(profile.plateYMm, 3);
  const settings: Record<string, string | string[]> = {
    name: "project_settings",
    from: "project",
    version: BAMBU_APPLICATION_VERSION,
    nozzle_diameter: [fmtNum(profile.nozzleMm, 2)],
    printable_area: ["0x0", `${x}x0`, `${x}x${y}`, `0x${y}`],
    printable_height: fmtNum(profile.maxHeightMm, 3),
    filament_colour: filamentColors,
    filament_type: filamentColors.map(() => "PLA"),
    curr_bed_type: profile.bambu?.bedType ?? "Textured PEI Plate",
  };
  // The CLI (src/BambuStudio.cpp, after Model::read_from_file on a bbl 3mf)
  // dereferences printer_settings_id, print_settings_id, filament_settings_id
  // and nozzle_diameter without a null check, so every Bambu-flavoured
  // project carries all four; a missing one is an access violation, not an
  // error message. For a Bambu row they are the machine preset's own default
  // process and filament names; a third-party row gets FrameCraft names that
  // the GUI resolves to its current selection.
  settings.printer_variant = fmtNum(profile.nozzleMm, 2);
  if (profile.bambu) {
    settings.printer_model = profile.bambu.printerModel;
    settings.printer_settings_id = profile.bambu.printerSettingsId;
    settings.print_settings_id = profile.bambu.printProfile;
    settings.filament_settings_id = filamentColors.map(() => profile.bambu?.filamentProfile ?? "Generic PLA");
  } else {
    settings.printer_settings_id = `${profile.label} ${fmtNum(profile.nozzleMm, 2)} nozzle`;
    settings.print_settings_id = "0.20mm Standard @FrameCraft";
    settings.filament_settings_id = filamentColors.map(() => "Generic PLA");
    if (singleNozzle) {
      // Bambu machines keep their system change_filament_gcode (the AMS
      // sequence); a third-party single-nozzle printer gets the profile's
      // pause command so the colour changes actually stop the print.
      settings.change_filament_gcode = profile.changeGcode;
    }
  }
  return settings;
}

export function bambuSliceInfoXml(): string {
  return (
    XML_DECLARATION +
    "<config>\n" +
    "  <header>\n" +
    '    <header_item key="X-BBL-Client-Type" value="slicer"/>\n' +
    `    <header_item key="X-BBL-Client-Version" value="${BAMBU_APPLICATION_VERSION}"/>\n` +
    "  </header>\n" +
    "</config>\n"
  );
}

export interface PlateJsonInput {
  objectId: number;
  objectName: string;
  bounds: { min: readonly number[]; max: readonly number[] };
  itemTranslation: readonly [number, number, number];
  filamentIds: number[];
  filamentColors: string[];
  firstExtruder: number;
  nozzleMm: number;
  layerHeightMm: number;
  bedType: string;
}

/** `Metadata/plate_1.json` in the PlateBBoxData layout (informational; nothing in the reader consumes it). */
export function bambuPlateJson(input: PlateJsonInput): string {
  const minX = input.bounds.min[0] + input.itemTranslation[0];
  const minY = input.bounds.min[1] + input.itemTranslation[1];
  const maxX = input.bounds.max[0] + input.itemTranslation[0];
  const maxY = input.bounds.max[1] + input.itemTranslation[1];
  const round = (v: number): number => Math.round(v * 1000) / 1000;
  const bbox = [round(minX), round(minY), round(maxX), round(maxY)];
  const payload = {
    bbox_all: bbox,
    bbox_objects: [
      {
        id: input.objectId,
        bbox,
        area: round((maxX - minX) * (maxY - minY)),
        layer_height: input.layerHeightMm,
        name: input.objectName,
      },
    ],
    filament_ids: input.filamentIds,
    filament_colors: input.filamentColors,
    is_seq_print: false,
    first_extruder: input.firstExtruder,
    nozzle_diameter: input.nozzleMm,
    version: 2,
    bed_type: input.bedType,
    first_layer_time: 0,
  };
  return JSON.stringify(payload);
}

export function exportBambu3mf(result: EngineResult, options: Bambu3mfOptions = {}): Bambu3mfExport {
  const resolved = resolveOptions(result, options);
  const profile = options.profile ?? resolveProfile(result.params);
  const singleNozzle = options.singleNozzle === true;
  const placed = placeInBuildSpace(orderedRegions(result.regions));
  if (placed.regions.length === 0) {
    throw new Error("a Bambu project needs at least one region with triangles");
  }
  const plan = singleNozzle
    ? planColorChanges(placed.regions, {
        layerHeightMm: options.layerHeightMm,
        changeGcode: profile.changeGcode,
        constructionOverlapMm: constructionOverlapFor(result.params),
      })
    : null;

  const parts: BambuPart[] = placed.regions.map((region, index) => ({
    id: index + 1,
    region,
    extruder: singleNozzle ? 1 : region.slot,
  }));
  const objectId = parts.length + 1;
  const base = parts.find((p) => p.region.region === "base") ?? parts[0];
  const objectExtruder = base.extruder;

  const width = placed.bounds.max[0] - placed.bounds.min[0];
  const depth = placed.bounds.max[1] - placed.bounds.min[1];
  const itemTranslation: [number, number, number] = [
    Math.round(((profile.plateXMm - width) / 2) * 1000) / 1000,
    Math.round(((profile.plateYMm - depth) / 2) * 1000) / 1000,
    0,
  ];

  const filamentColors = plan ? [plan.initialColor] : slotColors(placed.regions, profile.slots);
  const filamentIds = filamentColors.map((_c, i) => i + 1);
  const layerHeightMm = plan ? plan.layerHeightMm : (options.layerHeightMm ?? 0.2);
  const bedType = profile.bambu?.bedType ?? "Textured PEI Plate";

  const entries: ZipEntry[] = [
    { name: CONTENT_TYPES_PART, data: BAMBU_CONTENT_TYPES_XML },
    { name: RELS_PART, data: BAMBU_RELS_XML },
    { name: MODEL_PART, data: bambuMainModelXml(parts, objectId, bambuMetadata(result, resolved), itemTranslation) },
    { name: MODEL_RELS_PART, data: BAMBU_MODEL_RELS_XML },
    { name: OBJECT_MODEL_PART, data: bambuObjectModelXml(parts) },
    { name: MODEL_SETTINGS_PART, data: bambuModelSettingsXml(parts, objectId, resolved.title, objectExtruder) },
    { name: PROJECT_SETTINGS_PART, data: JSON.stringify(bambuProjectSettings({ profile, filamentColors, singleNozzle }), null, 4) + "\n" },
    { name: SLICE_INFO_PART, data: bambuSliceInfoXml() },
    {
      name: PLATE_JSON_PART,
      data: bambuPlateJson({
        objectId,
        objectName: resolved.title,
        bounds: placed.bounds,
        itemTranslation,
        filamentIds,
        filamentColors,
        firstExtruder: objectExtruder,
        nozzleMm: profile.nozzleMm,
        layerHeightMm,
        bedType,
      }),
    },
  ];
  if (plan) {
    entries.push({ name: CUSTOM_GCODE_PART, data: customGcodePerLayerXml(plan, 1) });
  }
  const bytes = zipEntries(entries, { mtime: resolved.created });
  return {
    name: `${resolved.stem}${singleNozzle ? "-colorchange" : ""}.3mf`,
    mime: MIME_3MF,
    bytes,
    profile,
    plan,
    objectId,
    partIds: parts.map((p) => p.id),
  };
}
