"use client";

import { BAKE_STALE_NOTE } from "@/lib/bake";
import { useEditorStore } from "@/store/editor";

/**
 * The printed-stats card from 01 step 5: triangle count, volume, bounding box,
 * estimated filament grams (labelled as an estimate, per 04), manifold flag and
 * the measured minimum wall. Everything here comes from `BakeResult.stats`;
 * nothing is recomputed client-side.
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
        className="rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
      >
        <p className="font-semibold">Bake failed</p>
        <p className="mt-1 font-mono">{bake.error}</p>
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
      className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
    >
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {bake.stale ? "Print stats (previous bake)" : "Print stats"}
      </h3>
      {bake.stale ? (
        <p
          data-testid="stats-stale-note"
          className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
        >
          {BAKE_STALE_NOTE}
        </p>
      ) : null}
      <dl className="space-y-1 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3">
            <dt className="text-neutral-500 dark:text-neutral-400">{label}</dt>
            <dd
              className={`font-mono tabular-nums ${
                label === "Manifold" && !stats.is_manifold
                  ? "text-red-600 dark:text-red-400"
                  : ""
              }`}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[10px] text-neutral-400">
        Filament is an estimate: volume × 1.24 g/cm³ × 0.35 infill factor.
      </p>
    </div>
  );
}

export default StatsCard;
