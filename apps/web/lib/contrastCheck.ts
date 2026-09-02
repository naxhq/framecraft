/**
 * The COLOUR panel's contrast checker (v3 phase 5, `[V3-P5-C]`).
 *
 * Two regions that touch on the printed model and share too close a colour
 * read as one blob rather than two parts -- the whole point of a filament
 * change. This checks every pair of regions that are PHYSICALLY adjacent
 * (share a face or an edge on the model, not merely both present) against
 * the colour each will actually PRINT (`printedColors` -- the slot winner,
 * `lib/colourMap.ts`, not the row's own `colorHex`, which can lie about what
 * comes out of the nozzle when two regions share a slot).
 *
 * Distance metric: CIE76 (plain Euclidean distance in CIE L*a*b*), reusing
 * `lib/colourMap.ts:deltaE76`/`hexToLab` rather than a second colour-space
 * implementation. CIEDE2000 is the perceptually truer metric, but CIE76 is
 * already the metric `lib/colourMap.ts` uses for "merge to N slots" -- one
 * distance function for the whole app is worth more than the extra accuracy
 * at the low end of the scale this check cares about (documented choice,
 * `[V3-P5-C]`).
 */

import type { ColourRow } from "./colourMap";
import { deltaE76, printedColors } from "./colourMap";
import { BUILTIN_PALETTES } from "./palettes";
import { bandIndexOf, type RegionName } from "./engine/types";

/**
 * Pairs of regions that touch on the physical model, base pairs from the
 * brief. Band regions (the height-gradient slots, `buildings_band_2..8`,
 * `[V3-P5-F7]`) are handled separately by `bandAdjacentPairs` below, since
 * which ones exist depends on `colour.gradient` and how many bands the
 * current build produced, not on a fixed table.
 */
export const ADJACENT_PAIRS: ReadonlyArray<readonly [RegionName, RegionName]> = [
  ["base", "frame"],
  ["base", "roads"],
  ["base", "water"],
  ["base", "parks"],
  ["buildings", "base"],
  ["matting", "frame"],
  ["matting", "base"],
  ["lettering", "frame"],
];

/**
 * Band-region neighbour pairs: consecutive gradient bands touch each other
 * (band 1, which keeps the name `buildings`, through the highest band
 * present), chained in band-index order. `buildings`/`base` is already in
 * `ADJACENT_PAIRS`, so band 1 needs no separate anchor here. Returns `[]`
 * when `regionsPresent` carries no band beyond `buildings` itself (the
 * gradient is off, or the current rows predate a build).
 */
export function bandAdjacentPairs(
  regionsPresent: ReadonlySet<RegionName>,
): Array<readonly [RegionName, RegionName]> {
  const present = [...regionsPresent]
    .map((region) => ({ region, index: bandIndexOf(region) }))
    .filter((entry): entry is { region: RegionName; index: number } => entry.index !== null)
    .sort((a, b) => a.index - b.index);
  const pairs: Array<readonly [RegionName, RegionName]> = [];
  for (let i = 0; i < present.length - 1; i += 1) {
    pairs.push([present[i].region, present[i + 1].region]);
  }
  return pairs;
}

/** Below this CIE76 distance, two adjacent regions are judged to clash. Roughly "a careful eye tells them apart across a seam" at this delta-E. */
export const CONTRAST_THRESHOLD = 12;

export interface ContrastIssue {
  regionA: RegionName;
  regionB: RegionName;
  colorA: string;
  colorB: string;
  distance: number;
  /** A palette swatch that would separate `regionA` from `regionB`'s printed colour, closest to `regionA`'s current colour. Null when no candidate clears the threshold. */
  suggestionForA: string | null;
}

/** Every unique region colour across the built-in palettes, deduplicated, uppercase. */
function candidateSwatches(): string[] {
  const set = new Set<string>();
  for (const palette of BUILTIN_PALETTES) {
    for (const hex of Object.values(palette.region_colors)) {
      if (hex) set.add(hex.toUpperCase());
    }
  }
  return [...set];
}

/**
 * The palette swatch nearest to `current` (smallest CIE76 distance) that
 * still clears `CONTRAST_THRESHOLD` from `other`. Null when nothing in the
 * built-in palettes would separate the two -- `other` is an unusual colour a
 * user picked by hand, and the checker says so rather than proposing
 * something that would still clash.
 */
export function nearestSeparatingColor(current: string, other: string): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidateSwatches()) {
    if (deltaE76(candidate, other) < CONTRAST_THRESHOLD) continue;
    const distanceFromCurrent = deltaE76(candidate, current);
    if (distanceFromCurrent < bestDistance) {
      bestDistance = distanceFromCurrent;
      best = candidate;
    }
  }
  return best;
}

/**
 * Every adjacent pair whose PRINTED colours (not the raw `region_colors`
 * entries -- what actually comes off the nozzle once slot-sharing is
 * resolved) fall under `CONTRAST_THRESHOLD`, one issue per pair, in
 * `ADJACENT_PAIRS` order. A region absent from `rows` (not yet built by any
 * build and not a v1/v2 default -- should not happen, but a defensive read
 * rather than a crash) is skipped rather than compared against `undefined`.
 */
export function contrastIssues(rows: readonly ColourRow[]): ContrastIssue[] {
  const printed = printedColors(rows);
  const slotByRegion = new Map(rows.map((row) => [row.region, row.slot]));
  const present = new Set(rows.map((row) => row.region));
  const pairs = [...ADJACENT_PAIRS, ...bandAdjacentPairs(present)];
  const issues: ContrastIssue[] = [];
  for (const [a, b] of pairs) {
    const colorA = printed.get(a);
    const colorB = printed.get(b);
    if (!colorA || !colorB) continue;
    // Two regions sharing one filament SLOT print in the same colour by
    // construction -- that is a single-filament choice, already surfaced by
    // `lib/colourMap.ts:slotColourConflicts`'s own warning ("Align colours to
    // what will print"), not a colour a user could have picked differently.
    // Flagging it here would tell the user to fix something they cannot fix
    // without giving the pair a slot of its own, which is the OTHER control's
    // job. FrameCraft's own frozen defaults rely on this: base/frame/matting
    // share slot 1 on purpose.
    if (slotByRegion.get(a) === slotByRegion.get(b)) continue;
    const distance = deltaE76(colorA, colorB);
    if (distance >= CONTRAST_THRESHOLD) continue;
    issues.push({
      regionA: a,
      regionB: b,
      colorA,
      colorB,
      distance,
      suggestionForA: nearestSeparatingColor(colorA, colorB),
    });
  }
  return issues;
}

/** One line per issue: "Base and roads are hard to tell apart (delta-E 4.2). Try #3A3A3A for roads." */
export function contrastIssueSentence(issue: ContrastIssue, label: (region: RegionName) => string): string {
  const names = `${label(issue.regionA)} and ${label(issue.regionB)}`;
  const base = `${names} are hard to tell apart (delta-E ${issue.distance.toFixed(1)}).`;
  if (issue.suggestionForA === null) return base;
  return `${base} Try ${issue.suggestionForA} for ${label(issue.regionA)}.`;
}
