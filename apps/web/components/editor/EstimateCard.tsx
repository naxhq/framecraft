"use client";

import { useMemo } from "react";

import { estimate, formatDuration } from "@/lib/engine/estimate";
import { useEditorStore } from "@/store/editor";

/**
 * How far the printed time range's low/high ends sit from `estimate()`'s own
 * point value, mm3-model-agnostic and UI-only ([V3-P4-U]): `lib/engine/
 * estimate.ts` already documents its own material-fraction constant as a
 * calibration guess, so a single point number reads more confident than the
 * underlying model is. A modest, explicitly-not-derived-from-anything spread
 * (25% under, 50% over -- print time is dominated by walls and travel the
 * flat volume model does not see, so it skews to running long more often
 * than short) says "rough" the way a single number cannot; the CAVEAT text
 * underneath still carries the real disclaimer.
 */
const TIME_RANGE_LOW = 0.75;
const TIME_RANGE_HIGH = 1.5;

/**
 * The OUTPUT group's estimate block, ahead of the Export button: per-slot
 * filament (a colour dot, grams, metres), the total, and a print time range,
 * every number labelled an estimate, from `lib/engine/estimate.ts:estimate()`
 * run on the live engine result (`EngineResult.params`, the parameters that
 * result was actually built from -- not necessarily the live panel values,
 * exactly like the stats card and the resolved-output panel already read the
 * engine result rather than re-deriving from `state.params`).
 *
 * The skeleton rule ([V3.1-T6], the defect this replaces): a skeleton may
 * appear ONLY while a request is genuinely in flight AND there is nothing
 * previous to show. Before, the only condition was "a job is running", so
 * every parameter write replaced a perfectly good estimate with four grey
 * bars, 80 ms after the keystroke, for the whole build -- which is what made a
 * loading placeholder read as a permanent one, and made the card's own
 * docstring ("a STALE-but-present result still renders") false. Now a previous
 * value stays on screen, dimmed and labelled, and the skeleton is what an
 * empty card shows on the FIRST build only. In the idle, error and completed
 * states there is no skeleton at all, which
 * `components/editor/ActionBar.test.tsx` asserts for this card and its three
 * neighbours.
 */
export function EstimateCard() {
  const status = useEditorStore((state) => state.pipeline.status);
  const stale = useEditorStore((state) => state.pipeline.stale);
  const result = useEditorStore((state) => state.pipeline.result);

  const est = useMemo(() => (result ? estimate(result, result.params) : null), [result]);
  const running = status === "running";

  if (running && est === null) {
    return (
      <div
        data-testid="estimate-card-skeleton"
        role="status"
        aria-live="polite"
        aria-label="Estimating filament and print time"
        className="animate-[fc-pulse_1.6s_ease-in-out_infinite] rounded-plate border border-line bg-plate-sunken p-3"
      >
        <div className="h-3 w-32 rounded-milled bg-plate-raised" />
        <div className="mt-3 h-3 w-full rounded-milled bg-plate-raised" />
        <div className="mt-1.5 h-3 w-full rounded-milled bg-plate-raised" />
        <div className="mt-3 h-3 w-3/4 rounded-milled bg-plate-raised" />
      </div>
    );
  }

  if (!est) return null;

  const low = formatDuration(est.seconds * TIME_RANGE_LOW);
  const high = formatDuration(est.seconds * TIME_RANGE_HIGH);
  // Dimmed while the numbers describe a model the controls have moved past.
  // Opacity, not a skeleton: the figures are still the best answer there is.
  const superseded = stale || running;

  return (
    <div
      data-testid="estimate-card"
      data-stale={superseded ? "true" : "false"}
      className={`rounded-plate border border-line bg-plate-sunken p-3 ${superseded ? "opacity-60" : ""}`}
    >
      <h4 className="mb-2 flex items-baseline justify-between gap-2 font-display text-2xs font-semibold uppercase tracking-[0.14em] text-ink-faint">
        <span>Filament and time (estimate)</span>
        {superseded ? (
          <span data-testid="estimate-card-stale-label" className="normal-case text-ink-faint">
            from the previous build
          </span>
        ) : null}
      </h4>

      <ul className="space-y-1" data-testid="estimate-slots">
        {est.slots.map((slot) => (
          <li
            key={slot.slot}
            data-testid={`estimate-slot-${slot.slot}`}
            className="flex items-center justify-between gap-2 text-2xs"
          >
            <span className="flex min-w-0 items-center gap-1.5 text-ink-muted">
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-full border border-control-strong"
                style={{ backgroundColor: slot.colorHex }}
              />
              Slot {slot.slot}
            </span>
            <span className="shrink-0 text-ink">
              {slot.grams.toFixed(1)} g · {slot.metres.toFixed(1)} m
            </span>
          </li>
        ))}
      </ul>

      <dl className="mt-2 space-y-1 border-t border-line pt-2 text-2xs">
        <div className="flex justify-between gap-3">
          <dt className="text-ink-faint">Total filament</dt>
          <dd data-testid="estimate-total" className="text-ink">
            {est.grams.toFixed(1)} g · {est.metres.toFixed(1)} m
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-ink-faint">Print time</dt>
          <dd data-testid="estimate-time-range" className="text-ink">
            {low} – {high}
          </dd>
        </div>
      </dl>

      <p className="mt-2 text-2xs text-ink-faint">{est.caveat}</p>
    </div>
  );
}

export default EstimateCard;
