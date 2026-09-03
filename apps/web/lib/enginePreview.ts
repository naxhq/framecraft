/**
 * What the viewport is showing right now, pulled out of
 * `components/scene/CityPreview.tsx` so it has its own test.
 *
 * Since v3.1 there is only ONE thing to draw: the region meshes the pipeline
 * streamed (`state.pipeline.regions`). There is no approximate stack to fall
 * back to, so a run in flight no longer takes the model off the screen -- the
 * previous meshes stay, dimmed, under an overlay naming the stage that is
 * running. This module owns the two decisions that follow from that: how the
 * meshes are presented, and whether the finished `EngineResult` may be read as
 * describing what is on screen.
 */

import type { PipelineJobState } from "@/store/editor";
import type { EngineResult } from "./engine/types";

/** The pipeline fields the viewport's presentation depends on. */
export type PreviewSource = Pick<PipelineJobState, "status" | "stale" | "regions" | "result">;

export type PreviewPhase =
  /** Nothing has ever been built: the plate outline and the invitation to Preview. */
  | "empty"
  /** A run is under way and there is nothing yet to show it against. */
  | "first"
  /** A run is under way over meshes from an earlier one. */
  | "building"
  /** The meshes describe the parameters on screen. */
  | "current"
  /** The meshes are from before the last change and no run is in flight yet. */
  | "outdated";

export interface PreviewView {
  phase: PreviewPhase;
  /** Draw the meshes through the dim token: they are not what the controls say. */
  dimmed: boolean;
  /** Show the stage overlay naming what the worker is doing. */
  overlay: boolean;
}

/**
 * The viewport's presentation for one pipeline state.
 *
 * Dimming is deliberately wider than the overlay: a parameter write marks the
 * result stale immediately and the run only starts `PIPELINE_DEBOUNCE_MS`
 * later, and going bright-dim-bright across that gap reads as a flicker. The
 * overlay names a stage, so it appears only while a stage is actually running.
 *
 * An error leaves the meshes undimmed: the last good model IS what is on
 * screen and it is still exactly what the last successful run produced. The
 * failure is reported by the Issues badge, not by greying the object out.
 */
export function previewView(pipeline: PreviewSource): PreviewView {
  const has = pipeline.regions.size > 0;
  if (pipeline.status === "running") {
    return { phase: has ? "building" : "first", dimmed: has, overlay: true };
  }
  if (!has) return { phase: "empty", dimmed: false, overlay: false };
  if (pipeline.status === "ready" && !pipeline.stale) {
    return { phase: "current", dimmed: false, overlay: false };
  }
  if (pipeline.status === "error") {
    return { phase: "outdated", dimmed: false, overlay: false };
  }
  return { phase: "outdated", dimmed: true, overlay: false };
}

/**
 * The `EngineResult` that describes what is on screen, or null.
 *
 * "Fresh" is `ready` AND not `stale`: a result computed for OLDER parameters
 * would report a triangle count, a height or a filament plan that disagrees
 * with the controls, so it is never returned here even though the store keeps
 * it (the stats card and the COLOUR panel read the last known result whatever
 * its staleness, and say so).
 */
export function freshEngineResult(pipeline: Pick<PipelineJobState, "status" | "stale" | "result">): EngineResult | null {
  if (pipeline.status !== "ready" || pipeline.stale) return null;
  return pipeline.result;
}
