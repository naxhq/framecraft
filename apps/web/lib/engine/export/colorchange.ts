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
// TWO Z RANGES THAT OVERLAP BY A CONSTRUCTION OFFSET DO NOT SHARE LAYERS.
// The regions this engine emits are not a flush partition: every one of them
// reaches `transform.BUILDING_OVERLAP_MM` (0.2 mm) into the body beside it and
// a building reaches `regions.building_skirt_mm` (0.3 mm by default) down
// through the base top, so the union is unambiguous (DECISIONS `[V3-P2-E2]`,
// `solid/context.ts` PART_OVERLAP_MM). That extra material is INTERIOR: it is
// buried inside the neighbour and no filament change can ever show on it. A
// planner that treated it as shared layers would find every region on every
// real scene inseparable and emit no change at all, which is exactly what the
// v3-02 audit measured (finding 1). So an overlap of at most
// `CONSTRUCTION_OVERLAP_MM` at a seam - where neither range contains the other
// - is construction, not sharing; anything deeper, and any containment (a
// recessed road inside the base's range, a lettering inlay inside the frame's)
// is real sharing and is reported.
//
// The plan itself is a Z-band sweep rather than a per-region verdict, because
// on a real scene the frame lip rises through the buildings' lower storeys:
// pairwise, buildings and frame share layers, but the layers ABOVE the base
// top are still owned by the buildings alone and can still be printed in their
// colour. Each elementary band between two claim edges is owned by the slots
// whose regions claim it; a band claimed by exactly one slot is assigned to
// it, a contested or empty band keeps the colour already loaded. A region is
// `separable` when nothing on another slot shares its layers (the strict,
// per-region question) and `served` when, under the plan, every layer it
// occupies is printed in its own colour. The frame in the example above is
// neither; the buildings are served but not separable.
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

import { BUILDING_OVERLAP_MM } from "../../transform";
import type { PrintParams } from "../../contracts";
import type { RegionMesh, RegionName } from "../types";
import { colorRgb } from "./common";
import { XML_DECLARATION, escapeAttr, fmtNum } from "./xml";

export const CUSTOM_GCODE_PART = "Metadata/custom_gcode_per_layer.xml";
export const CUSTOM_GCODE_TYPE_COLOR_CHANGE = 0;
export const CUSTOM_GCODE_MODE_SINGLE_EXTRUDER = "SingleExtruder";
export const DEFAULT_LAYER_HEIGHT_MM = 0.2;

/** `print_params.json`'s default for `regions.building_skirt_mm`. */
export const DEFAULT_BUILDING_SKIRT_MM = 0.3;

/**
 * How much Z overlap between two regions is construction rather than sharing.
 *
 * The seam interpenetration every region carries (`BUILDING_OVERLAP_MM`,
 * 0.2 mm) plus the default building skirt (0.3 mm), and 0.05 mm of slack for
 * the float arithmetic that produced the bounding boxes. Use
 * `constructionOverlapMm` for a bake whose `building_skirt_mm` is not the
 * default; `constructionOverlapFor` reads it off the params.
 */
export const CONSTRUCTION_OVERLAP_MM = BUILDING_OVERLAP_MM + DEFAULT_BUILDING_SKIRT_MM + 0.05;

/** The construction overlap for one bake's params (skirt + seam + slack). */
export function constructionOverlapFor(params: Pick<PrintParams, "regions">): number {
  const skirt = params.regions?.building_skirt_mm ?? DEFAULT_BUILDING_SKIRT_MM;
  return BUILDING_OVERLAP_MM + Math.max(0, skirt) + 0.05;
}

export interface ColorChangeOptions {
  /** Layer height the change is snapped to; defaults to 0.2 mm. */
  layerHeightMm?: number;
  /** Command written into the `gcode` attribute; defaults to M600. */
  changeGcode?: string;
  /** Two Z ranges closer than this are treated as touching, not overlapping. */
  epsilonMm?: number;
  /**
   * Seam overlap that is interior construction, not shared layers; defaults to
   * `CONSTRUCTION_OVERLAP_MM`.
   */
  constructionOverlapMm?: number;
}

export interface RegionSeparability {
  region: RegionName;
  slot: number;
  zMin: number;
  zMax: number;
  /** Nothing on another slot shares this region's layers. */
  separable: boolean;
  /** Under this plan, every layer the region occupies prints in its colour. */
  served: boolean;
  /** Regions on another slot that share layers with this one. */
  conflicts: RegionName[];
  /** Regions whose colour is printed over this one's layers, if any. */
  lostTo: RegionName[];
}

export interface ColorBand {
  fromZ: number;
  toZ: number;
  slot: number;
  color: string;
  /** The regions on this band's slot that have material in it. */
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
  /** Overlap treated as interior construction rather than shared layers. */
  constructionOverlapMm: number;
  /** Slot (and colour) loaded when the print starts. */
  initialSlot: number;
  initialColor: string;
  bands: ColorBand[];
  changes: ColorChangeEvent[];
  report: RegionSeparability[];
  separable: RegionName[];
  inseparable: RegionName[];
  /** Regions that do print entirely in their own colour under this plan. */
  served: RegionName[];
}

interface ZRange {
  zMin: number;
  zMax: number;
}

/**
 * Do two Z ranges share printed layers?
 *
 * No when they are disjoint or merely touch, no when they meet at a seam no
 * deeper than the construction overlap (that material is buried inside the
 * neighbour), yes when either range swallows the other, whatever the depth.
 */
function sharesLayers(a: ZRange, b: ZRange, tolerance: number, eps: number): boolean {
  const span = Math.min(a.zMax, b.zMax) - Math.max(a.zMin, b.zMin);
  if (span <= eps) return false;
  if (span >= a.zMax - a.zMin - eps || span >= b.zMax - b.zMin - eps) return true;
  return span > tolerance;
}

interface Claim extends ZRange {
  mesh: RegionMesh;
  /** The part of the range that is not buried in the region below it. */
  claimMin: number;
  claimMax: number;
}

/**
 * The Z span a region can actually be coloured over: its bounding box minus
 * the construction overlap it reaches down into whatever it stands on. Trimmed
 * by the depth the neighbour below really reaches, never by more than the
 * tolerance and never by more than half the region's own height, so a thin
 * inlay keeps a claim.
 */
function claimsOf(live: readonly RegionMesh[], tolerance: number, eps: number): Claim[] {
  const ranges = live.map((mesh) => ({ mesh, zMin: mesh.bbox.min[2], zMax: mesh.bbox.max[2] }));
  return ranges.map((r) => {
    let buried = 0;
    for (const other of ranges) {
      if (other === r || other.mesh.slot === r.mesh.slot) continue;
      // Only a body that starts BELOW this one can bury this one's underside.
      if (other.zMin >= r.zMin - eps || other.zMax <= r.zMin + eps) continue;
      buried = Math.max(buried, Math.min(tolerance, other.zMax - r.zMin));
    }
    const trim = Math.min(buried, (r.zMax - r.zMin) / 2);
    return { ...r, claimMin: r.zMin + trim, claimMax: r.zMax };
  });
}

/** Top of the first layer whose slab starts at or above `z`. */
export function snapToLayerTop(z: number, layerHeightMm: number): number {
  const layers = Math.floor((z + 1e-6) / layerHeightMm) + 1;
  return Math.round(layers * layerHeightMm * 10000) / 10000;
}

/** One elementary slice of Z between two claim edges, and the slot printed in it. */
interface Slice {
  fromZ: number;
  toZ: number;
  /** Claims with material in this slice. */
  owners: Claim[];
  slot: number;
  /** The slice is claimed by exactly one slot, so that slot owns it outright. */
  exclusive: boolean;
}

function sliceUp(claims: readonly Claim[], fallbackSlot: number, eps: number): Slice[] {
  const edges = [...new Set(claims.flatMap((c) => [c.claimMin, c.claimMax]))].sort((a, b) => a - b);
  const slices: Slice[] = [];
  let current = fallbackSlot;
  for (let i = 0; i + 1 < edges.length; i += 1) {
    const fromZ = edges[i];
    const toZ = edges[i + 1];
    if (toZ - fromZ <= eps) continue;
    const owners = claims.filter((c) => c.claimMin <= fromZ + eps && c.claimMax >= toZ - eps);
    const slots = [...new Set(owners.map((c) => c.mesh.slot))];
    // Exactly one slot has material here, so it can be printed in its colour.
    // A contested slice (two slots) or an empty one keeps the loaded colour:
    // there is no honest way to give both of them theirs with one nozzle.
    const exclusive = slots.length === 1;
    const slot = exclusive ? slots[0] : current;
    slices.push({ fromZ, toZ, owners, slot, exclusive });
    current = slot;
  }
  return slices;
}

export function planColorChanges(regions: readonly RegionMesh[], options: ColorChangeOptions = {}): ColorChangePlan {
  const layerHeightMm = options.layerHeightMm ?? DEFAULT_LAYER_HEIGHT_MM;
  const changeGcode = options.changeGcode ?? "M600";
  const eps = options.epsilonMm ?? 1e-3;
  const constructionOverlapMm = options.constructionOverlapMm ?? CONSTRUCTION_OVERLAP_MM;
  const live = regions.filter((r) => r.indices.length >= 3);

  const colorOf = new Map<number, string>();
  for (const region of live) {
    if (!colorOf.has(region.slot)) colorOf.set(region.slot, colorRgb(region.colorHex));
  }

  const claims = claimsOf(live, constructionOverlapMm, eps);
  // The slot to start in when the bottom of the model is contested: the one
  // that owns the lowest region.
  const fallbackSlot = claims.length > 0 ? claims.reduce((best, c) => (c.zMin < best.zMin ? c : best), claims[0]).mesh.slot : 1;
  const slices = sliceUp(claims, fallbackSlot, eps);

  // Bands: consecutive slices printed in the same slot, merged.
  const bands: ColorBand[] = [];
  /** Where the band's own slot actually has material, per band. */
  const ownedFrom: number[] = [];
  const ownedTo: number[] = [];
  for (const slice of slices) {
    const mine = slice.owners.filter((c) => c.mesh.slot === slice.slot);
    let index = bands.length - 1;
    if (index < 0 || bands[index].slot !== slice.slot) {
      bands.push({ fromZ: slice.fromZ, toZ: slice.toZ, slot: slice.slot, color: colorOf.get(slice.slot) ?? "#FFFFFF", regions: [] });
      ownedFrom.push(Number.POSITIVE_INFINITY);
      ownedTo.push(Number.NEGATIVE_INFINITY);
      index = bands.length - 1;
    } else {
      bands[index].toZ = slice.toZ;
    }
    for (const claim of mine) {
      if (!bands[index].regions.includes(claim.mesh.region)) bands[index].regions.push(claim.mesh.region);
      ownedFrom[index] = Math.min(ownedFrom[index], slice.fromZ);
      ownedTo[index] = Math.max(ownedTo[index], slice.toZ);
    }
  }

  const initialSlot = bands.length > 0 ? bands[0].slot : fallbackSlot;
  const initialColor = colorOf.get(initialSlot) ?? "#FFFFFF";

  const changes: ColorChangeEvent[] = [];
  for (let i = 1; i < bands.length; i += 1) {
    const band = bands[i];
    if (band.slot === bands[i - 1].slot) continue;
    // Where the previous slot's material stops and this one's begins. They
    // usually meet (a seam) or overlap, and then the change goes on the first
    // layer of the new region; when the claims leave a construction-scale gap
    // the change goes at its midpoint. A wide gap is not a boundary to split:
    // the new slot's own material is what has to be coloured, so start there.
    const previousTop = Number.isFinite(ownedTo[i - 1]) ? ownedTo[i - 1] : band.fromZ;
    const nextBottom = Number.isFinite(ownedFrom[i]) ? ownedFrom[i] : band.fromZ;
    const gap = nextBottom - previousTop;
    const boundaryZ = gap > eps && gap <= constructionOverlapMm ? (previousTop + nextBottom) / 2 : nextBottom;
    changes.push({ printZ: snapToLayerTop(boundaryZ, layerHeightMm), slot: band.slot, color: band.color, regions: [...band.regions] });
  }

  const report: RegionSeparability[] = claims.map((claim) => {
    const conflicts = claims
      .filter((other) => other !== claim && other.mesh.slot !== claim.mesh.slot && sharesLayers(claim, other, constructionOverlapMm, eps))
      .map((other) => other.mesh.region);
    const lost = slices.filter((slice) => slice.owners.includes(claim) && slice.slot !== claim.mesh.slot);
    const lostTo: RegionName[] = [];
    for (const slice of lost) {
      for (const owner of slice.owners) {
        if (owner.mesh.slot === slice.slot && !lostTo.includes(owner.mesh.region)) lostTo.push(owner.mesh.region);
      }
    }
    return {
      region: claim.mesh.region,
      slot: claim.mesh.slot,
      zMin: claim.zMin,
      zMax: claim.zMax,
      separable: conflicts.length === 0,
      served: lost.length === 0,
      conflicts,
      lostTo,
    };
  });

  return {
    layerHeightMm,
    changeGcode,
    constructionOverlapMm,
    initialSlot,
    initialColor,
    bands,
    changes,
    report,
    separable: report.filter((r) => r.separable).map((r) => r.region),
    inseparable: report.filter((r) => !r.separable).map((r) => r.region),
    served: report.filter((r) => r.served).map((r) => r.region),
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
    // What the print does, not the strict per-region verdict: a region can
    // share layers with another and still get its colour, because the region
    // it shares them with is the one that loses (`RegionSeparability.served`).
    if (!row.served) {
      const shared = row.lostTo.length > 0 ? row.lostTo : row.conflicts;
      out.push(`${row.region} (slot ${row.slot}) shares layers with ${shared.join(", ")} and keeps the loaded colour`);
    }
  }
  return out;
}
