/**
 * The preview swap rule, pulled out of `components/scene/CityPreview.tsx` so
 * it has its own test: `RegionMeshes` (the real engine result) replaces every
 * approximate instanced/flat-fill layer the moment the result is FRESH, and
 * falls back to the instanced preview otherwise -- never a flicker back to
 * an empty canvas while a newer job computes, and never a stale result shown
 * as if it matched the parameters on screen right now.
 */

import type { EngineJobState } from "@/store/editor";
import type { EngineResult } from "./engine/types";

/**
 * The `EngineResult` to actually render, or `null` when the instanced
 * fallback should be shown instead.
 *
 * "Fresh" is `ready` AND not `stale`: a result computed for OLDER parameters
 * is worse than the instanced approximation of the CURRENT ones (it would
 * show geometry, colours or a triangle count that disagree with the controls
 * on screen), so it is never returned here even though the store still keeps
 * it around (for the COLOUR panel and the stats card, which read the last
 * known result regardless of staleness -- see `docs/handoff/
 * v3-02-integration.md`).
 */
export function freshEngineResult(engine: Pick<EngineJobState, "status" | "result" | "stale">): EngineResult | null {
  if (engine.status !== "ready" || engine.stale) return null;
  return engine.result;
}
