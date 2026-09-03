"use client";

import { EXPORT_STALE_NOTE } from "@/lib/exportFlow";
import type { EngineSceneGraph } from "@/lib/engine/osm/types";
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
 * `EngineResult` (`state.pipeline.result`), not from a finished Export: the
 * debounced pipeline run updates this card the moment it lands, whether or not
 * the user has clicked Export yet -- "one truth: engine result when fresh" (E4
 * brief, item 3). Volume and grams are summed here from the region volumes
 * using the same formula the footer text has always documented; the filament
 * and time card next to it is `lib/engine/estimate.ts`'s own, per slot.
 * Manifold is the absence of a `not-manifold` or `floating-island` error
 * finding.
 *
 * When the result has gone stale (a PrintParams value, the location or the
 * scene moved after it was computed) the numbers are KEPT and labelled as
 * describing the previous computation. That was always this card's choice and
 * it is now the estimate card's too ([V3.1-T6]): a skeleton over a good
 * previous value is a worse answer than the value.
 */
export function StatsCard() {
  const engine = useEditorStore((state) => state.pipeline);
  const graph = useEditorStore((state) => state.scene.graph);
  const result = engine.result;

  if (engine.status === "error" && engine.error !== null) {
    return (
      <div
        data-testid="stats-card"
        className="rounded-plate border border-danger/40 bg-danger-soft p-3 text-2xs text-danger"
      >
        <p className="font-display font-semibold uppercase tracking-[0.14em]">
          The engine could not build a model
        </p>
        <p className="mt-1 leading-snug">{engine.error.message}</p>
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

  // Phase 3 HEIGHTS: how many buildings got no usable OSM height at all and
  // fell back to `heights.unknown_default_m` (`repair.ts`'s own definition of
  // `heightFallbacks`, `height_source === "default"`). The tag/levels/default
  // split is a cheap read off the already-fetched SceneGraph -- no extra pass
  // over the buildings -- so it rides along as a native tooltip rather than a
  // second row.
  const fallbackCounts = (graph as EngineSceneGraph | null)?.stats.height_fallback_counts;
  const fallbackTooltip = fallbackCounts
    ? `${fallbackCounts.tag} from an explicit height tag, ${fallbackCounts.levels} from a level count, ${fallbackCounts.default} guessed entirely`
    : undefined;

  const rows: Array<[string, string, string?]> = [
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
  if (result.stats.heightFallbacks > 0) {
    rows.push([
      "Height fallbacks",
      `${result.stats.heightFallbacks.toLocaleString("en-US")} building${result.stats.heightFallbacks === 1 ? "" : "s"}`,
      fallbackTooltip,
    ]);
  }

  return (
    <div
      data-testid="stats-card"
      className="rounded-plate border border-line bg-plate-sunken p-3"
    >
      <h4 className="mb-2 font-display text-2xs font-semibold uppercase tracking-[0.14em] text-ink-faint">
        {engine.stale ? "Print stats (previous computation)" : "Print stats"}
        {engine.status === "running" ? ", updating..." : ""}
      </h4>
      {engine.stale ? (
        <div className="mb-2">
          <Note tone="warn" testId="stats-stale-note">
            {EXPORT_STALE_NOTE}
          </Note>
        </div>
      ) : null}
      <dl className="space-y-1 text-2xs">
        {rows.map(([label, value, tooltip]) => (
          <div key={label} className="flex justify-between gap-3">
            <dt className="text-ink-faint">{label}</dt>
            <dd
              title={tooltip}
              data-testid={label === "Height fallbacks" ? "stats-height-fallbacks" : undefined}
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
