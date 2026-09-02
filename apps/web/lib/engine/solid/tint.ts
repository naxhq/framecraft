/**
 * Per-building tint, as DATA.
 *
 * A tint is not geometry and it is not a filament. A printer lays down whatever
 * is in the slot, so the print path ignores every number here - the buildings
 * region keeps one slot and one colour whatever the tint says. What it is for
 * is the preview, and `export/obj.ts`, which is the one format that can carry a
 * material per body.
 *
 * The COLOUR itself is not computed here. `lib/tint.ts` owns it (the editor's
 * own module, `[V3-P5-C]`), and this module calls it, so the shade the preview
 * paints on a building and the shade the OBJ gives it are the same number from
 * the same function rather than two implementations that agree until one of
 * them is edited. What this module adds is the part only the build knows: WHICH
 * building solid each tint belongs to, and where it is on the plate
 * (`[V3-P5-F8]`).
 */

import type { PrintParams } from "../../contracts";
import { tintedColor } from "../../tint";
import type { BuildingTint } from "../types";

/** True when `colour.tint` is on. */
export function tintEnabled(params: PrintParams): boolean {
  return params.colour?.tint?.enabled === true;
}

/**
 * The tint list for a set of building solids, empty when tint is off.
 *
 * `id` is `BuildingSolid.id`: the SceneGraph id of the footprint that set the
 * solid's height, which is what the preview keys its own tint map by, so a
 * building has ONE tint wherever it is drawn.
 */
export function buildingTints(
  params: PrintParams,
  baseHex: string,
  buildings: ReadonlyArray<{ id: string; centroidMm: [number, number] }>,
): BuildingTint[] {
  if (!tintEnabled(params)) return [];
  const tint = params.colour?.tint;
  return buildings.map((building) => ({
    id: building.id,
    colorHex: tintedColor(building.id, baseHex, tint),
    centroidMm: building.centroidMm,
  }));
}

/**
 * At most this many distinct materials in an OBJ, however many tints there are.
 *
 * A city has hundreds of buildings and an MTL with hundreds of near-identical
 * materials is unreadable in every tool that opens one. The tints are bucketed
 * to this many by colour, which is a shade step of well under what a screen
 * shows (`[V3-P5-F8]`).
 */
export const MAX_TINT_MATERIALS = 32;

/**
 * Bucket a set of tints down to at most {@link MAX_TINT_MATERIALS} colours.
 *
 * The distinct shades are sorted by luminance and cut into that many groups of
 * equal count, each represented by the colour in the MIDDLE of its group. The
 * grid therefore comes from the palette's own spread rather than from the whole
 * sRGB cube: a tint set is a narrow band around one colour (12 degrees of hue
 * and 0.12 of lightness by default), and quantising the full cube to fit 32
 * buckets would flatten that band to two or three shades. Deterministic: the
 * sort is by luminance with the hex string breaking ties.
 */
export function bucketTints(
  tints: readonly BuildingTint[],
  max = MAX_TINT_MATERIALS,
): Map<string, string> {
  const out = new Map<string, string>();
  if (tints.length === 0) return out;
  const distinct = [...new Set(tints.map((t) => t.colorHex))].sort((a, b) => {
    const la = luminance(a);
    const lb = luminance(b);
    return la === lb ? (a < b ? -1 : a > b ? 1 : 0) : la - lb;
  });
  if (distinct.length <= max) {
    for (const hex of distinct) out.set(hex, hex);
    return out;
  }
  for (let bucket = 0; bucket < max; bucket += 1) {
    const from = Math.floor((bucket * distinct.length) / max);
    const to = Math.floor(((bucket + 1) * distinct.length) / max);
    if (to <= from) continue;
    const representative = distinct[Math.floor((from + to - 1) / 2)];
    for (let i = from; i < to; i += 1) out.set(distinct[i], representative);
  }
  return out;
}

/** Relative luminance of `#RRGGBB`, 0 to 1 (Rec. 709 weights). */
function luminance(hex: string): number {
  const match = /^#?([0-9a-f]{6})/i.exec(hex.trim());
  if (match === null) return 0;
  const value = parseInt(match[1], 16);
  return (
    (0.2126 * ((value >> 16) & 255) + 0.7152 * ((value >> 8) & 255) + 0.0722 * (value & 255)) /
    255
  );
}
