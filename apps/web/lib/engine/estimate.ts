/**
 * Filament and time, estimated.
 *
 * Every number this module returns is a ROUGH estimate and is labelled one:
 * `EstimateResult.isEstimate` is always true and `caveat` is the sentence the
 * UI shows beside the figures. The only honest source for a real answer is the
 * slicer, which knows the wall count, the infill pattern, the acceleration
 * profile and the travel path; this is the number a user needs BEFORE they open
 * the slicer, to decide whether the model is a two hour print or a two day one.
 *
 * The volume it starts from is `EngineResult.merged`, never the sum of the
 * region volumes. The regions interpenetrate at every seam by
 * `PART_OVERLAP_MM` on purpose (DECISIONS `[V3-P2-E2]`), so summing them
 * double-counts every seam: +5.18 % on the Chicago plate. Per-slot volumes ARE
 * summed from the regions, because there is no other way to attribute volume to
 * a filament, and then scaled by the one factor that makes them add up to the
 * merged volume (`[V3-P4-E2]`).
 */

import type { PrintParams } from "../contracts";
import type {
  EngineResult,
  EstimateAssumptions,
  EstimateResult,
  RegionMesh,
  RegionName,
  SlotEstimate,
} from "./types";
import { REGION_NAMES } from "./types";

/** PLA, g/cm3. The commonest spool, and what every estimate here assumes. */
export const PLA_DENSITY_G_CM3 = 1.24;

/** Filament diameter, mm. */
export const FILAMENT_DIAMETER_MM = 1.75;

/** Layer height the time model counts in, mm. */
export const LAYER_HEIGHT_MM = 0.2;

/**
 * Extruded volume as a fraction of the model's own volume.
 *
 * A slicer does not fill a solid: it lays two or three perimeters, a few solid
 * top and bottom layers, and a sparse grid in between. At the 15 % sparse infill
 * every default profile ships, a chunky model like this one comes out somewhere
 * near half its geometric volume - lower for a thick base slab, higher for the
 * thin walls and small towers that make up a city, where the perimeters alone
 * are most of the section.
 *
 * 0.55 is the calibration constant for the whole estimate: it is what puts the
 * default Chicago build in a plausible window against a real slice, and it is
 * ROUGH. Anything that changes the infill, the wall count or the layer height
 * moves it, and the estimate does not know about any of them (`[V3-P4-E2]`).
 */
export const MATERIAL_FRACTION = 0.55;

/**
 * Volumetric flow the time model assumes, mm3/s.
 *
 * A 0.4 mm nozzle at 0.2 mm layers and 100 mm/s is 8 mm3/s, which is the middle
 * of what every stock profile in this class runs and well inside what the
 * hotends can melt. It is the term that dominates the estimate for a model this
 * size, so it is the first thing to change if the numbers read low or high.
 */
export const FLOW_MM3_PER_S = 8;

/**
 * Fixed cost per layer, seconds.
 *
 * The layer change itself, the Z hop, the seam, and the acceleration and
 * deceleration the flow figure above pretends does not happen. Four seconds a
 * layer is a few minutes over a print of this height, so it matters for a short
 * flat plate and disappears for a tall one.
 */
export const OVERHEAD_S_PER_LAYER = 4;

/**
 * Travel speed expressed as plan area covered per second, mm2/s.
 *
 * A crude stand-in for the real thing: how long the head spends moving without
 * extruding scales with how spread out the layer is, and the model's own
 * footprint is the only measure of that available here without slicing it.
 * 40 000 mm2/s puts a full 180 mm plate at 0.8 s of travel a layer, which is
 * the right order for a head crossing a bed at 300 mm/s a handful of times.
 */
export const TRAVEL_AREA_RATE_MM2_PER_S = 40_000;

export const ESTIMATE_CAVEAT =
  "Rough estimate. It assumes PLA at 0.2 mm layers with the usual walls and sparse infill, " +
  "and it does not know your slicer's profile. Slice the file for a real answer.";

/** Cross-section of the filament, mm2. */
export function filamentAreaMm2(diameterMm: number = FILAMENT_DIAMETER_MM): number {
  return Math.PI * (diameterMm / 2) ** 2;
}

/** Grams of PLA for a volume of extruded material. */
export function gramsFor(volumeMm3: number, densityGCm3: number = PLA_DENSITY_G_CM3): number {
  return (volumeMm3 / 1000) * densityGCm3;
}

/** Metres of 1.75 mm filament for a volume of extruded material. */
export function metresFor(volumeMm3: number, diameterMm: number = FILAMENT_DIAMETER_MM): number {
  return volumeMm3 / filamentAreaMm2(diameterMm) / 1000;
}

/** "5 h 12 min", "48 min", "under a minute". */
export function formatDuration(seconds: number): string {
  if (!(seconds > 0)) return "under a minute";
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 1) return "under a minute";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} min`;
}

export interface EstimateOptions {
  /** Defaults to 0.2 mm; the Bambu writer's own default layer height. */
  layerHeightMm?: number;
  materialFraction?: number;
  flowMm3PerS?: number;
  overheadSPerLayer?: number;
  travelAreaRateMm2PerS?: number;
  densityGCm3?: number;
  filamentDiameterMm?: number;
}

/**
 * Filament per slot, filament in total, and a print time, for one build.
 *
 * Pure: it reads the meshes and the parameters and touches nothing else.
 */
export function estimate(
  result: Pick<EngineResult, "regions" | "merged" | "stats">,
  params: PrintParams,
  options: EstimateOptions = {},
): EstimateResult {
  const assumptions: EstimateAssumptions = {
    densityGCm3: options.densityGCm3 ?? PLA_DENSITY_G_CM3,
    filamentDiameterMm: options.filamentDiameterMm ?? FILAMENT_DIAMETER_MM,
    layerHeightMm: options.layerHeightMm ?? LAYER_HEIGHT_MM,
    materialFraction: options.materialFraction ?? MATERIAL_FRACTION,
    flowMm3PerS: options.flowMm3PerS ?? FLOW_MM3_PER_S,
    overheadSPerLayer: options.overheadSPerLayer ?? OVERHEAD_S_PER_LAYER,
    travelAreaRateMm2PerS: options.travelAreaRateMm2PerS ?? TRAVEL_AREA_RATE_MM2_PER_S,
  };

  const totalVolume = Math.max(0, result.merged.volumeMm3);
  const slots = slotBreakdown(result.regions, totalVolume, assumptions);

  const filamentVolume = totalVolume * assumptions.materialFraction;
  const grams = gramsFor(filamentVolume, assumptions.densityGCm3);
  const metres = metresFor(filamentVolume, assumptions.filamentDiameterMm);

  const heightMm = Math.max(0, result.merged.bbox.max[2] - result.merged.bbox.min[2]);
  const layers = totalVolume > 0 ? Math.max(1, Math.ceil(heightMm / assumptions.layerHeightMm)) : 0;
  const planAreaMm2 = Math.max(
    0,
    (result.merged.bbox.max[0] - result.merged.bbox.min[0]) *
      (result.merged.bbox.max[1] - result.merged.bbox.min[1]),
  );
  // Per layer: a fixed overhead, the material that layer extrudes, and a travel
  // term that grows with how far apart the islands in it are. Summed over the
  // layers the middle term is just the total volume, so how the volume is
  // distributed between layers cannot change the answer and is not modelled.
  const seconds =
    layers === 0
      ? 0
      : layers * assumptions.overheadSPerLayer +
        filamentVolume / assumptions.flowMm3PerS +
        (layers * planAreaMm2) / assumptions.travelAreaRateMm2PerS;

  return {
    isEstimate: true,
    slots,
    volumeMm3: totalVolume,
    filamentVolumeMm3: filamentVolume,
    grams,
    metres,
    layers,
    layerHeightMm: assumptions.layerHeightMm,
    seconds,
    duration: formatDuration(seconds),
    assumptions,
    caveat: ESTIMATE_CAVEAT,
  };
}

/**
 * Volume per filament slot, scaled so the slots add up to the merged volume.
 *
 * The regions overlap each other at every seam, so their volumes sum to more
 * than the model has. One factor is applied to all of them rather than trying
 * to attribute each seam to a side: the overlap is a thin skin on a shared
 * boundary, so it is close to proportional to the area each region contributes,
 * and any split of it is arbitrary at this precision.
 */
function slotBreakdown(
  regions: readonly RegionMesh[],
  totalVolume: number,
  assumptions: EstimateAssumptions,
): SlotEstimate[] {
  const rawTotal = regions.reduce((sum, region) => sum + Math.max(0, region.volumeMm3), 0);
  const factor = rawTotal > 0 && totalVolume > 0 ? totalVolume / rawTotal : 0;
  const bySlot = new Map<number, { volume: number; colorHex: string; regions: RegionName[] }>();
  for (const name of REGION_NAMES) {
    for (const region of regions) {
      if (region.region !== name) continue;
      const entry = bySlot.get(region.slot) ?? {
        volume: 0,
        colorHex: region.colorHex,
        regions: [],
      };
      entry.volume += Math.max(0, region.volumeMm3) * factor;
      if (!entry.regions.includes(region.region)) entry.regions.push(region.region);
      bySlot.set(region.slot, entry);
    }
  }
  return [...bySlot.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slot, entry]) => {
      const filamentVolume = entry.volume * assumptions.materialFraction;
      return {
        slot,
        colorHex: entry.colorHex,
        regions: entry.regions,
        volumeMm3: entry.volume,
        filamentVolumeMm3: filamentVolume,
        grams: gramsFor(filamentVolume, assumptions.densityGCm3),
        metres: metresFor(filamentVolume, assumptions.filamentDiameterMm),
      };
    });
}
