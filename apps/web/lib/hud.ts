/**
 * The viewport spec strip: the three numbers that describe the object on
 * screen as a printed thing rather than as a picture.
 *
 *   1:10,714   ·   34.7 mm tall   ·   0.80 mm min wall
 *
 * All three come from code that is shared with the bake, not from local
 * arithmetic: the ratio through `lib/tokens.ts` (the mirrored token table, so
 * the number in the HUD is the number engraved on the frame), the height
 * through `warnings.predictedTopMm` (which is `transform.predicted_top_mm`, the
 * function the server's own 60 mm guard calls) and the wall through
 * `transform.min_wall_mm`.
 *
 * `min_wall_mm` in particular is worth stating out loud on screen: it is what
 * every thin footprint is repaired to, it moves with the nozzle, and it is the
 * one threshold whose look-alike (`min_detail`, exactly half of it) reads
 * completely plausibly in a HUD.
 */

import type { PrintParams, SceneGraph } from "./contracts";
import { format_scale, type TokenContext } from "./tokens";
import * as T from "./transform";
import { predictedTopMm } from "./warnings";

export interface SpecReadout {
  /** Small uppercase caption. */
  label: string;
  value: string;
  testId: string;
  /** `danger` past 04's 60 mm ceiling: the bake will refuse this model. */
  tone: "normal" | "danger";
}

/** `1:10,714`, or null when the scene has no measurable scale yet. */
export function scaleRatio(
  graph: SceneGraph | null,
  params: PrintParams,
): string | null {
  if (!graph) return null;
  const radius_m = T.radius_m_from_bounds(graph.bounds);
  if (!(radius_m > 0)) return null;
  const context: TokenContext = {
    lat: graph.center.lat,
    lon: graph.center.lon,
    scale_mm_per_m: T.scale_mm_per_m(params, radius_m),
    radius_m,
    date: "",
    buildings: graph.stats.building_count,
  };
  return format_scale(context);
}

/**
 * The strip, left to right, or an empty list without a scene.
 *
 * Deliberately three items: scale, height, wall. The building and tree counts
 * live in the second HUD line, and the full measured table stays in the
 * sidebar's Output group -- a predicted number and a baked number must never
 * sit in the same table (DECISIONS [P5-web]).
 */
export function specStrip(
  graph: SceneGraph | null,
  params: PrintParams,
): SpecReadout[] {
  if (!graph) return [];
  const out: SpecReadout[] = [];

  const ratio = scaleRatio(graph, params);
  if (ratio !== null) {
    out.push({ label: "Scale", value: ratio, testId: "spec-scale", tone: "normal" });
  }

  const top = predictedTopMm(graph, params);
  if (top !== null) {
    out.push({
      label: "Height",
      value: `${top.toFixed(1)} mm`,
      testId: "spec-height",
      tone: top >= T.MAX_HEIGHT_MM ? "danger" : "normal",
    });
  }

  out.push({
    label: "Min wall",
    value: `${T.min_wall_mm(params).toFixed(2)} mm`,
    testId: "spec-min-wall",
    tone: "normal",
  });

  return out;
}
