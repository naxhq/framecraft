"use client";

import { BAKE_STALE_NOTE } from "@/lib/bake";
import { useEditorStore } from "@/store/editor";
import { Note } from "./Controls";

/** Filament density and infill factor the grams estimate below uses, unchanged from the pre-engine StatsCard's own footer text. */
const FILAMENT_DENSITY_G_PER_CM3 = 1.24;
const INFILL_FACTOR = 0.35;

/**
 * The printed-stats table from 01 step 5: triangle count, volume, bounding box,
 * estimated filament grams (labelled as an estimate, per 04), a manifold flag
 * and the measured minimum wall.
 *
 * Since FrameCraft v3 E4 every number here comes straight from the live
 * `EngineResult` (`state.engine.result`), not from a finished Bake: the debounced
 * engine job updates this card the moment it lands, whether or not the user has
 * clicked Bake yet -- "one truth: engine result when fresh" (E4 brief, item 3).
 * Volume and grams are summed/derived here (no `estimate.ts` module exists yet;
 * that is phase 4 work, out of this task's scope) using the same formula the
 * footer text has always documented. Manifold is the absence of a `not-manifold`
 * or `floating-island` error finding.
 *
 * When the result has gone stale (a PrintParams value, the location or the
 * scene moved after it was computed) the numbers are kept but labelled as
 * describing the previous computation.
 */
export function StatsCard() {
  const engine = useEditorStore((state) => state.engine);
  const result = engine.result;

  if (engine.status === "error" && engine.error) {
    return (
      <div
        data-testid="stats-card"
        className="rounded-plate border border-danger/40 bg-danger-soft p-3 text-2xs text-danger"
      >
        <p className="font-display font-semibold uppercase tracking-[0.14em]">
          The engine could not build a model
        </p>
        <p className="mt-1 leading-snug">{engine.error}</p>
      </div>
    );
  }

  if (!result) return null;

  const volumeMm3 = result.regions.reduce((total, region) => total + region.volumeMm3, 0);
  const estGrams = (volumeMm3 / 1000) * FILAMENT_DENSITY_G_PER_CM3 * INFILL_FACTOR;
  const isManifold = !result.findings.some(
    (finding) => finding.severity === "error" && (finding.id === "not-manifold" || finding.id === "floating-island"),
  );
  const minWallMm = result.stats.measuredMinWallMm ?? result.stats.minWallMm;

  const rows: Array<[string, string]> = [
    ["Triangles", result.stats.triangles.toLocaleString("en-US")],
    ["Volume", `${Math.round(volumeMm3).toLocaleString("en-US")} mm³`],
    [
      "Bounding box",
      `${result.stats.widthMm.toFixed(1)} × ${result.stats.depthMm.toFixed(1)} × ${result.stats.heightMm.toFixed(1)} mm`,
    ],
    ["Filament (estimate)", `${estGrams.toFixed(1)} g`],
    ["Manifold", isManifold ? "yes" : "no"],
    ["Min wall", `${minWallMm.toFixed(2)} mm`],
  ];

  return (
    <div
      data-testid="stats-card"
      className="rounded-plate border border-line bg-plate-sunken p-3"
    >
      <h4 className="mb-2 font-display text-2xs font-semibold uppercase tracking-[0.14em] text-ink-faint">
        {engine.stale ? "Print stats (previous computation)" : "Print stats"}
        {engine.status === "computing" ? " — updating..." : ""}
      </h4>
      {engine.stale ? (
        <div className="mb-2">
          <Note tone="warn" testId="stats-stale-note">
            {BAKE_STALE_NOTE}
          </Note>
        </div>
      ) : null}
      <dl className="space-y-1 text-2xs">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3">
            <dt className="text-ink-faint">{label}</dt>
            <dd
              className={
                label === "Manifold" && !isManifold ? "font-medium text-danger" : "text-ink"
              }
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-2xs text-ink-faint">
        Filament is an estimate: volume × 1.24 g/cm³ × 0.35 infill factor.
      </p>
    </div>
  );
}

export default StatsCard;
