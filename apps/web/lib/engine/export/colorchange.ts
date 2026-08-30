// Single-nozzle colour planning: which regions can be printed in their own
// colour by pausing for a filament change at a layer boundary, and the
// `Metadata/custom_gcode_per_layer.xml` that tells Bambu Studio (and
// PrusaSlicer's descendants) where those changes go.
//
// A region is "separable by height" when its Z range does not overlap the Z
// range of any region on a different filament slot: the whole slab of layers
// it occupies can then be printed in its colour. A region that shares layers
// with a differently coloured one (buildings standing on a base of another
// colour, lettering cut into the frame) is reported as inseparable; the
// print keeps whatever colour is loaded through those layers.
//
// File format (verified against BambuStudio/src/libslic3r/Format/bbs_3mf.cpp,
// `_add_custom_gcode_per_print_z_file_to_archive` and
// `_extract_custom_gcode_per_print_z_from_archive`): the root is
// `<custom_gcodes_per_layer>`, one `<plate>` holding `<plate_info id="N"/>`,
// one `<layer top_z type extruder color extra gcode/>` per change and a
// `<mode value="SingleExtruder"/>`. `type` is CustomGCode::Type, where
// ColorChange is 0 (src/libslic3r/CustomGCode.hpp). The reader ignores
// `gcode` when `type` is present; the command actually emitted is the printer
// preset's change_filament_gcode, so the attribute is informational.

import type { RegionMesh, RegionName } from "../types";
import { colorRgb } from "./common";
import { XML_DECLARATION, escapeAttr, fmtNum } from "./xml";

export const CUSTOM_GCODE_PART = "Metadata/custom_gcode_per_layer.xml";
export const CUSTOM_GCODE_TYPE_COLOR_CHANGE = 0;
export const CUSTOM_GCODE_MODE_SINGLE_EXTRUDER = "SingleExtruder";
export const DEFAULT_LAYER_HEIGHT_MM = 0.2;

export interface ColorChangeOptions {
  /** Layer height the change is snapped to; defaults to 0.2 mm. */
  layerHeightMm?: number;
  /** Command written into the `gcode` attribute; defaults to M600. */
  changeGcode?: string;
  /** Two Z ranges closer than this are treated as touching, not overlapping. */
  epsilonMm?: number;
}

export interface RegionSeparability {
  region: RegionName;
  slot: number;
  zMin: number;
  zMax: number;
  separable: boolean;
  /** Regions on another slot whose Z range overlaps this one. */
  conflicts: RegionName[];
}

export interface ColorBand {
  fromZ: number;
  toZ: number;
  slot: number;
  color: string;
  regions: RegionName[];
}

export interface ColorChangeEvent {
  /** Top of the first layer printed in the new colour. */
  printZ: number;
  slot: number;
  color: string;
  regions: RegionName[];
}

export interface ColorChangePlan {
  layerHeightMm: number;
  changeGcode: string;
  /** Slot (and colour) loaded when the print starts. */
  initialSlot: number;
  initialColor: string;
  bands: ColorBand[];
  changes: ColorChangeEvent[];
  report: RegionSeparability[];
  separable: RegionName[];
  inseparable: RegionName[];
}

function overlaps(a: { zMin: number; zMax: number }, b: { zMin: number; zMax: number }, eps: number): boolean {
  return a.zMin < b.zMax - eps && b.zMin < a.zMax - eps;
}

/** Top of the first layer whose slab starts at or above `z`. */
export function snapToLayerTop(z: number, layerHeightMm: number): number {
  const layers = Math.floor((z + 1e-6) / layerHeightMm) + 1;
  return Math.round(layers * layerHeightMm * 10000) / 10000;
}

export function planColorChanges(regions: readonly RegionMesh[], options: ColorChangeOptions = {}): ColorChangePlan {
  const layerHeightMm = options.layerHeightMm ?? DEFAULT_LAYER_HEIGHT_MM;
  const changeGcode = options.changeGcode ?? "M600";
  const eps = options.epsilonMm ?? 1e-3;
  const live = regions.filter((r) => r.indices.length >= 3);

  const report: RegionSeparability[] = live.map((region) => {
    const zMin = region.bbox.min[2];
    const zMax = region.bbox.max[2];
    const conflicts = live
      .filter((other) => other !== region && other.slot !== region.slot && overlaps({ zMin, zMax }, { zMin: other.bbox.min[2], zMax: other.bbox.max[2] }, eps))
      .map((other) => other.region);
    return { region: region.region, slot: region.slot, zMin, zMax, separable: conflicts.length === 0, conflicts };
  });

  const colorOf = new Map<number, string>();
  for (const region of live) {
    if (!colorOf.has(region.slot)) colorOf.set(region.slot, colorRgb(region.colorHex));
  }

  // Bands: one per separable region, merged when the same slot overlaps or touches.
  const raw: ColorBand[] = report
    .filter((row) => row.separable)
    .map((row) => ({ fromZ: row.zMin, toZ: row.zMax, slot: row.slot, color: colorOf.get(row.slot) ?? "#FFFFFF", regions: [row.region] }))
    .sort((a, b) => a.fromZ - b.fromZ || a.toZ - b.toZ);
  const bands: ColorBand[] = [];
  for (const band of raw) {
    const last = bands[bands.length - 1];
    if (last && last.slot === band.slot && band.fromZ <= last.toZ + eps) {
      last.toZ = Math.max(last.toZ, band.toZ);
      last.regions.push(...band.regions);
    } else {
      bands.push({ ...band, regions: [...band.regions] });
    }
  }

  let initialSlot: number;
  if (bands.length > 0) {
    initialSlot = bands[0].slot;
  } else if (live.length > 0) {
    // Nothing is separable: start with the slot that owns the lowest region.
    initialSlot = live.reduce((best, r) => (r.bbox.min[2] < best.bbox.min[2] ? r : best), live[0]).slot;
  } else {
    initialSlot = 1;
  }
  const initialColor = colorOf.get(initialSlot) ?? "#FFFFFF";

  const changes: ColorChangeEvent[] = [];
  let current = initialSlot;
  for (const band of bands) {
    if (band.slot === current) continue;
    changes.push({ printZ: snapToLayerTop(band.fromZ, layerHeightMm), slot: band.slot, color: band.color, regions: [...band.regions] });
    current = band.slot;
  }

  return {
    layerHeightMm,
    changeGcode,
    initialSlot,
    initialColor,
    bands,
    changes,
    report,
    separable: report.filter((r) => r.separable).map((r) => r.region),
    inseparable: report.filter((r) => !r.separable).map((r) => r.region),
  };
}

/** `Metadata/custom_gcode_per_layer.xml` in the Bambu Studio layout. */
export function customGcodePerLayerXml(plan: ColorChangePlan, plateId = 1): string {
  const lines: string[] = [];
  lines.push(XML_DECLARATION.trimEnd());
  lines.push("<custom_gcodes_per_layer>");
  lines.push("<plate>");
  lines.push(`<plate_info id="${plateId}"/>`);
  for (const change of plan.changes) {
    lines.push(
      `<layer top_z="${fmtNum(change.printZ, 4)}" type="${CUSTOM_GCODE_TYPE_COLOR_CHANGE}" extruder="1" color="${escapeAttr(change.color)}" extra="" gcode="${escapeAttr(plan.changeGcode)}"/>`,
    );
  }
  lines.push(`<mode value="${CUSTOM_GCODE_MODE_SINGLE_EXTRUDER}"/>`);
  lines.push("</plate>");
  lines.push("</custom_gcodes_per_layer>");
  return lines.join("\n") + "\n";
}

/** One line per region for the UI or a CLI summary. */
export function describePlan(plan: ColorChangePlan): string[] {
  const out: string[] = [];
  out.push(`start with slot ${plan.initialSlot} (${plan.initialColor})`);
  for (const change of plan.changes) {
    out.push(`at z=${fmtNum(change.printZ, 2)} mm change to slot ${change.slot} (${change.color}) for ${change.regions.join(", ")}`);
  }
  for (const row of plan.report) {
    if (!row.separable) {
      out.push(`${row.region} (slot ${row.slot}) shares layers with ${row.conflicts.join(", ")} and keeps the loaded colour`);
    }
  }
  return out;
}
