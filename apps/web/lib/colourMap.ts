/**
 * The COLOUR panel's data layer: one row per region (from the live
 * `EngineResult` when there is one, the contract defaults otherwise), which
 * slots exceed a printer profile, and "merge to N slots" -- grouping regions
 * by colour similarity (CIE76) and rewriting their `colour.region_slots` so
 * the model fits a profile with fewer AMS/MMU slots than it currently uses.
 *
 * The preview, this panel and every exporter read the SAME `EngineResult`
 * (`RegionMesh.slot`/`colorHex`), so nothing here recomputes a colour on its
 * own; it only reads `params.colour` (through `lib/engine/solid/context.ts`'s
 * `regionSlot`/`regionColor`, the one place that table is resolved) for the
 * regions a bake has not produced yet.
 */

import type { PrintParams } from "./contracts";
import { regionColor, regionSlot } from "./engine/solid/context";
import { REGION_NAMES, type EngineResult, type RegionName } from "./engine/types";

export interface ColourRow {
  region: RegionName;
  slot: number;
  colorHex: string;
}

/**
 * One row per region. While a bake result is fresh, the rows are exactly the
 * regions it produced (so the panel can never show a slot/colour the exported
 * file disagrees with); before the first bake (or while one is a stale
 * placeholder with no regions) every region name the contract can colour
 * shows up with its resolved default. `easel` is not listed: it has no
 * `colour.region_slots`/`region_colors` entry of its own, it always mirrors
 * `base` (`context.ts:regionSlot/regionColor`).
 */
export function colourRows(params: PrintParams, result: EngineResult | null): ColourRow[] {
  if (result && result.regions.length > 0) {
    return result.regions.map((region) => ({
      region: region.region,
      slot: region.slot,
      colorHex: region.colorHex,
    }));
  }
  return REGION_NAMES.filter((region) => region !== "easel").map((region) => ({
    region,
    slot: regionSlot(params, region),
    colorHex: regionColor(params, region),
  }));
}

/** The distinct slot numbers `rows` actually uses, ascending. */
export function distinctSlots(rows: readonly ColourRow[]): number[] {
  return [...new Set(rows.map((row) => row.slot))].sort((a, b) => a - b);
}

/** True when `rows` uses more filament slots than the printer profile has. */
export function exceedsProfileSlots(rows: readonly ColourRow[], profileSlots: number): boolean {
  return distinctSlots(rows).length > profileSlots;
}

// ---------------------------------------------------------------------------
// CIE76 colour distance
// ---------------------------------------------------------------------------

function hexToRgb8(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return [Number.isFinite(r) ? r : 0, Number.isFinite(g) ? g : 0, Number.isFinite(b) ? b : 0];
}

function srgbToLinear(c8: number): number {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** sRGB hex -> CIE L*a*b* (D65 reference white), the space CIE76 measures distance in. */
export function hexToLab(hex: string): [number, number, number] {
  const [r8, g8, b8] = hexToRgb8(hex);
  const r = srgbToLinear(r8);
  const g = srgbToLinear(g8);
  const b = srgbToLinear(b8);
  const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const y = r * 0.2126729 + g * 0.715152 + b * 0.072175;
  const z = r * 0.0193339 + g * 0.119192 + b * 0.9503041;
  const xn = 0.95047;
  const yn = 1.0;
  const zn = 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / xn);
  const fy = f(y / yn);
  const fz = f(z / zn);
  const l = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const bb = 200 * (fy - fz);
  return [l, a, bb];
}

/** CIE76 delta-E between two `#RRGGBB[AA]` colours: plain Euclidean distance in L*a*b*. */
export function deltaE76(hexA: string, hexB: string): number {
  const [l1, a1, b1] = hexToLab(hexA);
  const [l2, a2, b2] = hexToLab(hexB);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

// ---------------------------------------------------------------------------
// Merge to N slots
// ---------------------------------------------------------------------------

export interface MergePlan {
  /** False when `rows` already fits within `targetSlots` (nothing to patch). */
  changed: boolean;
  /** `colour.region_slots` overrides for every region that changed slot. */
  regionSlots: Partial<Record<RegionName, number>>;
  /** `colour.region_colors` overrides for every region that changed slot (it now shares its cluster's colour). */
  regionColors: Partial<Record<RegionName, string>>;
}

interface Cluster {
  slots: number[];
  regions: RegionName[];
  colorHex: string;
  weight: number;
}

/**
 * Group the CURRENT slots (not individual regions -- two regions already
 * sharing a slot are treated as one unit) into `targetSlots` clusters by
 * nearest CIE76 distance, agglomerative-nearest-pair, one merge at a time.
 * Ties and the final slot numbering are broken by the smallest ORIGINAL slot
 * number in a cluster, so the result is deterministic and the lowest slots
 * tend to keep their number.
 *
 * A merged cluster keeps the colour of its heavier (more regions) member,
 * never an average: every colour on the plate stays one a region actually
 * had, so "merge to N slots" never invents a filament nobody chose.
 */
export function planMergeToSlots(rows: readonly ColourRow[], targetSlots: number): MergePlan {
  if (!(targetSlots >= 1)) {
    throw new Error(`targetSlots must be at least 1 (got ${targetSlots})`);
  }

  const bySlot = new Map<number, ColourRow[]>();
  for (const row of rows) {
    const members = bySlot.get(row.slot) ?? [];
    members.push(row);
    bySlot.set(row.slot, members);
  }

  let clusters: Cluster[] = [...bySlot.entries()]
    .sort(([a], [b]) => a - b)
    .map(([slot, members]) => ({
      slots: [slot],
      regions: members.map((member) => member.region),
      colorHex: members[0].colorHex,
      weight: members.length,
    }));

  if (clusters.length <= targetSlots) {
    return { changed: false, regionSlots: {}, regionColors: {} };
  }

  while (clusters.length > targetSlots) {
    let bestI = 0;
    let bestJ = 1;
    let bestDistance = Infinity;
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const distance = deltaE76(clusters[i].colorHex, clusters[j].colorHex);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestI = i;
          bestJ = j;
        }
      }
    }
    const a = clusters[bestI];
    const b = clusters[bestJ];
    const heavier = a.weight >= b.weight ? a : b;
    const merged: Cluster = {
      slots: [...a.slots, ...b.slots],
      regions: [...a.regions, ...b.regions],
      colorHex: heavier.colorHex,
      weight: a.weight + b.weight,
    };
    clusters = [...clusters.filter((_, index) => index !== bestI && index !== bestJ), merged];
  }

  clusters = [...clusters].sort((a, b) => Math.min(...a.slots) - Math.min(...b.slots));

  const regionSlots: Partial<Record<RegionName, number>> = {};
  const regionColors: Partial<Record<RegionName, string>> = {};
  clusters.forEach((cluster, index) => {
    const newSlot = index + 1;
    for (const region of cluster.regions) {
      regionSlots[region] = newSlot;
      regionColors[region] = cluster.colorHex;
    }
  });

  return { changed: true, regionSlots, regionColors };
}
