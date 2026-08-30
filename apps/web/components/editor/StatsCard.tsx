"use client";

import { BAKE_STALE_NOTE } from "@/lib/bake";
import { useEditorStore } from "@/store/editor";
import { Note } from "./Controls";

/**
 * The printed-stats table from 01 step 5: triangle count, volume, bounding box,
 * estimated filament grams (labelled as an estimate, per 04), manifold flag and
 * the measured minimum wall. Everything here comes from `BakeResult.stats`;
 * nothing is recomputed client-side, and nothing predicted is allowed in --
 * the predicted height lives in the viewport spec strip and above the Bake
 * button, so a guess can never be mistaken for a measurement.
 *
 * When the bake has gone stale (a PrintParams value, the location or the scene
 * moved after it finished) the numbers are kept but labelled as describing the
 * previous bake, because they no longer describe the preview on screen.
 */
export function StatsCard() {
  const bake = useEditorStore((state) => state.bake);
  const stats = bake.result?.stats ?? null;

  if (bake.phase === "failed" && bake.error) {
    return (
      <div
        data-testid="stats-card"
        className="rounded-plate border border-danger/40 bg-danger-soft p-3 text-2xs text-danger"
      >
        <p className="font-display font-semibold uppercase tracking-[0.14em]">
          Bake failed
        </p>
        <p className="mt-1 leading-snug">{bake.error}</p>
      </div>
    );
  }

  if (!stats) return null;

  const [x, y, z] = stats.bbox_mm;
  const rows: Array<[string, string]> = [
    ["Triangles", stats.triangles.toLocaleString("en-US")],
    ["Volume", `${stats.volume_mm3.toLocaleString("en-US")} mm³`],
    ["Bounding box", `${x.toFixed(1)} × ${y.toFixed(1)} × ${z.toFixed(1)} mm`],
    ["Filament (estimate)", `${stats.est_grams.toFixed(1)} g`],
    ["Manifold", stats.is_manifold ? "yes" : "no"],
    ["Min wall", `${stats.min_wall_mm.toFixed(2)} mm`],
  ];

  return (
    <div
      data-testid="stats-card"
      className="rounded-plate border border-line bg-plate-sunken p-3"
    >
      <h4 className="mb-2 font-display text-2xs font-semibold uppercase tracking-[0.14em] text-ink-faint">
        {bake.stale ? "Print stats (previous bake)" : "Print stats"}
      </h4>
      {bake.stale ? (
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
                label === "Manifold" && !stats.is_manifold
                  ? "font-medium text-danger"
                  : "text-ink"
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
