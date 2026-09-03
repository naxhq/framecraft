/**
 * The viewport spec strip: the three numbers that describe the object on
 * screen as a printed thing rather than as a picture.
 *
 *   1:10,714   ·   34.7 mm tall   ·   0.80 mm min wall
 *
 * All three come from code that is shared with the build, not from local
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
import type { PipelineProgress } from "@/store/editor";
import { format_scale, type TokenContext } from "./tokens";
import * as T from "./transform";
import { heightCeilingMm, predictedTopMm } from "./warnings";

export interface SpecReadout {
  /** Small uppercase caption. */
  label: string;
  value: string;
  testId: string;
  /** `danger` past `warnings.heightCeilingMm`: the model is taller than the printer allows. */
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
 * sidebar's Output group -- a predicted number and a built number must never
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
      tone: top >= heightCeilingMm(params) ? "danger" : "normal",
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

// ---------------------------------------------------------------------------
// The pipeline stage overlay (v3.1)
// ---------------------------------------------------------------------------

/**
 * Stage ids that do not read as an English noun on their own.
 *
 * Everything else is derived: `surface-roads`, `region-roads` and
 * `finish-roads` are all "roads" to a person watching the model appear, and a
 * plain id like `buildings` or `lettering` already says what it is. Keeping the
 * table to the exceptions is what stops it drifting out of step with the
 * registry: a stage added without an entry still names itself.
 */
const STAGE_WORDS: Record<string, string> = {
  fetch: "fetching from OpenStreetMap",
  normalise: "reading the map data",
  context: "measuring the plate",
  "repair-buildings": "repairing footprints",
  "frame-cutters": "frame details",
  sit: "seating the model",
  assembly: "welding the model",
  merged: "cleaning the mesh",
  measure: "measuring the walls",
  validate: "checking printability",
  islands: "checking for loose parts",
  audit: "collecting findings",
  export: "writing the file",
};

/** The prefixes that name a phase of one region rather than a thing of their own. */
const STAGE_PREFIXES = ["surface-", "region-", "finish-"];

/** A stage id as a person would say it: `finish-roads` is "roads", `repair-buildings` is "repairing footprints". */
export function stageLabel(stage: string): string {
  if (stage === "") return "";
  const known = STAGE_WORDS[stage];
  if (known !== undefined) return known;
  for (const prefix of STAGE_PREFIXES) {
    if (stage.startsWith(prefix)) return stage.slice(prefix.length).replace(/[-_]/g, " ");
  }
  return stage.replace(/[-_]/g, " ");
}

/**
 * The viewport overlay's line: `Building: roads (14 of 71)`.
 *
 * The counter is the plan's own index, so it reaches its total exactly once
 * per run and never invents progress the worker did not report. Null before
 * the first stage of a run has been named, where the honest thing to say is
 * nothing rather than "Building:  (0 of 0)".
 */
export function stageOverlayText(progress: PipelineProgress): string | null {
  const label = stageLabel(progress.stage);
  if (label === "" || progress.total === 0) return null;
  return `Building: ${label} (${progress.index + 1} of ${progress.total})`;
}

/**
 * `about 3 s left`, or null when there is nothing honest to say yet.
 *
 * `etaMs` is null for the first three stages of a run and for a run whose
 * remaining stages have never been timed, and this rounds to whole seconds
 * because the number is an estimate from the previous run's durations, not a
 * measurement of this one.
 */
export function stageEtaText(progress: PipelineProgress): string | null {
  if (progress.etaMs === null || progress.etaMs < 500) return null;
  return `about ${Math.round(progress.etaMs / 1000)} s left`;
}
