"use client";

import type { Phase } from "@/lib/engine/pipeline";
import { stageLabel } from "@/lib/hud";

/**
 * The determinate progress control the action bar shows while a run or an
 * export is under way.
 *
 * Everything on it is reported, never invented. The bar's fill is the plan's
 * own `index / total` from `state.pipeline.progress` (the worker names the
 * stage that is running before it runs it), the elapsed figure is a wall
 * clock the caller owns, and the "left" figure appears only when the store
 * has an `etaMs` at all -- which it sets after three stages of a run have
 * reported and never before, because two stages into a plan of seventy any
 * number would be noise.
 *
 * There is deliberately no timer-driven animation of the FILL. A bar that
 * creeps forward on a clock is a lie about how much is done, and the whole
 * reason the pipeline reports stages is so this does not have to guess.
 */

export type RunKind = "preview" | "export";

export interface RunProgressModel {
  kind: RunKind;
  /** The stage id running now, as the worker named it. */
  stage: string;
  /** Its 0-based position in the plan, and the plan's length. */
  index: number;
  total: number;
  phase: Phase;
  /** Wall-clock milliseconds since this run started. */
  elapsedMs: number;
  /** The store's estimate for the stages still ahead, or null. */
  etaMs: number | null;
}

/**
 * One sentence per phase, for the live region.
 *
 * The live region announces the PHASE, not the stage: a full Chicago plan
 * reports 142 stage events, and a screen reader reading each of them out is
 * unusable. Five phase changes is a commentary; 142 is noise.
 */
const PHASE_SENTENCE: Record<Phase, string> = {
  scene: "Reading the map data.",
  geometry: "Building the geometry.",
  region: "Finishing each region.",
  audit: "Checking the model.",
  export: "Writing the file.",
};

const KIND_VERB: Record<RunKind, string> = {
  preview: "Building the model",
  export: "Writing the export",
};

/** `0.4 s`, `12 s`, `1 min 05 s`. Whole seconds past ten, because tenths of a minute-long run are noise. */
export function formatElapsed(ms: number): string {
  const safe = ms > 0 ? ms : 0;
  if (safe < 10_000) return `${(safe / 1000).toFixed(1)} s`;
  if (safe < 60_000) return `${Math.round(safe / 1000)} s`;
  const totalSeconds = Math.round(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
}

/**
 * `about 3 s left`, or null.
 *
 * Null is the honest answer for a null `etaMs` (fewer than three stages have
 * reported, or the remaining stages have never been timed) and for anything
 * under half a second, where "about 0 s left" reads as broken.
 */
export function formatEta(etaMs: number | null): string | null {
  if (etaMs === null || etaMs < 500) return null;
  return `about ${Math.round(etaMs / 1000)} s left`;
}

/** `Building the model: roads, step 14 of 71`. What `aria-valuetext` says, so the stage is spoken rather than only the number. */
export function progressValueText(model: RunProgressModel): string {
  const label = stageLabel(model.stage);
  const step = `step ${Math.min(model.index + 1, model.total)} of ${model.total}`;
  return label === "" ? `${KIND_VERB[model.kind]}, ${step}` : `${KIND_VERB[model.kind]}: ${label}, ${step}`;
}

/** The visible line under the bar: what is running, how far in, how long it has taken, and how long is left when that is known. */
export function progressDetailText(model: RunProgressModel): string {
  const label = stageLabel(model.stage);
  const parts = [
    label === "" ? KIND_VERB[model.kind] : `${KIND_VERB[model.kind]}: ${label}`,
    `${Math.min(model.index + 1, model.total)} of ${model.total}`,
    `${formatElapsed(model.elapsedMs)} elapsed`,
  ];
  const eta = formatEta(model.etaMs);
  if (eta !== null) parts.push(eta);
  return parts.join(" · ");
}

/** The filled fraction, 0 to 1. Zero for an empty plan rather than NaN. */
export function progressFraction(model: RunProgressModel): number {
  if (model.total <= 0) return 0;
  return Math.min(Math.max((model.index + 1) / model.total, 0), 1);
}

export function ProgressBar({ model }: { model: RunProgressModel }) {
  const fraction = progressFraction(model);
  return (
    <div className="space-y-1" data-testid="run-progress-group">
      <div
        role="progressbar"
        data-testid="run-progress"
        data-kind={model.kind}
        data-stage={model.stage}
        data-phase={model.phase}
        data-index={model.index}
        data-total={model.total}
        aria-label={KIND_VERB[model.kind]}
        aria-valuemin={0}
        aria-valuemax={model.total}
        aria-valuenow={Math.min(model.index + 1, model.total)}
        aria-valuetext={progressValueText(model)}
        className="h-1.5 overflow-hidden rounded-milled bg-plate-sunken"
      >
        <div
          className="h-full rounded-milled bg-accent transition-[width] duration-150"
          style={{ width: `${(fraction * 100).toFixed(1)}%` }}
        />
      </div>
      <p data-testid="run-progress-detail" className="truncate text-2xs text-ink-muted">
        {progressDetailText(model)}
      </p>
      {/*
        The commentary a screen reader hears. `sr-only` rather than hidden:
        `aria-live` on a `display:none` element announces nothing at all.
      */}
      <p
        role="status"
        aria-live="polite"
        data-testid="run-progress-phase"
        className="sr-only"
      >
        {PHASE_SENTENCE[model.phase]}
      </p>
    </div>
  );
}

export default ProgressBar;
