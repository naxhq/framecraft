/**
 * Roads and rail: the two centreline layers.
 *
 * 04 stage 1 (roads) buffers each centreline by
 * `max(width_m, min_wall_ground) / 2` with flat caps and round joins, unions
 * the result and subtracts the buildings, and that is what `repair.ts` does.
 * This module owns what is specific to the two layers: where the widths come
 * from, and how the v1 `road_mode` switch and the v3 `regions.roads` placement
 * fit together.
 *
 * The ruling on that last point (DECISIONS `[V3-P2-E2]`): `road_mode` decides
 * whether roads exist at all, and `regions.roads.proud_mm` decides where they
 * sit. A negative `proud_mm` is an engraved road and a positive one is an
 * embossed road, so the two settings can disagree; when they do, the placement
 * wins and the disagreement is reported with a one-click fix rather than
 * resolved silently in either direction.
 */

import type { Point } from "../../contracts";
import type { BakeContext } from "./context";
import { addFinding } from "./context";
import type { Contour } from "./manifold";
import { ribbonContours, roadContours } from "./repair";

/** A rail centreline, if the ingest side put one in the SceneGraph. */
export interface RailWay {
  path: Point[];
  width_m?: number;
}

/**
 * The scene's rail ways.
 *
 * `scene_graph.json` is frozen without a `rail` layer, and the ingest phase
 * carries railways as an additive extra key. Reading it defensively means the
 * rail region appears the moment ingest emits it and is simply empty until
 * then, with no contract change and no crash on an older scene.
 */
export function railWays(scene: unknown): RailWay[] {
  const layer = (scene as { rail?: unknown }).rail;
  if (!Array.isArray(layer)) return [];
  const out: RailWay[] = [];
  for (const entry of layer) {
    if (typeof entry !== "object" || entry === null) continue;
    const path = (entry as { path?: unknown }).path;
    if (!Array.isArray(path) || path.length < 2) continue;
    const width = (entry as { width_m?: unknown }).width_m;
    out.push({
      path: path as Point[],
      width_m: typeof width === "number" ? width : undefined,
    });
  }
  return out;
}

/** Ribbon contours for the road layer, print mm. Empty when roads are off. */
export function roadLayerContours(ctx: BakeContext): Contour[] {
  if (ctx.params.road_mode === "off") return [];
  return roadContours(ctx, ctx.scene.roads);
}

/**
 * Ribbon contours for the rail layer, print mm.
 *
 * The width is `params.regions.rail.width_m` unless the way carries its own,
 * and it is clamped up to a minimum wall exactly as a road's is: a rail line
 * printed thinner than two perimeters is a scratch, not a track.
 */
export function railLayerContours(ctx: BakeContext): Contour[] {
  const ways = railWays(ctx.scene);
  if (ways.length === 0) return [];
  const fallback = ctx.params.regions?.rail?.width_m ?? 6.0;
  const out: Contour[] = [];
  for (const way of ways) {
    const groundM = Math.max(
      (way.width_m ?? fallback) * ctx.params.road_scale,
      ctx.thresholdsGroundM.min_wall,
    );
    out.push(...ribbonContours(way.path, groundM * ctx.scale, ctx.scale));
  }
  return out;
}

/**
 * Say so when `road_mode` and `regions.roads.proud_mm` disagree.
 *
 * Both are live settings in v3 and the panel shows them in different groups, so
 * a user who set "emboss" and left the default negative offset would otherwise
 * see engraved roads with nothing explaining why.
 */
export function reportRoadModeConflict(ctx: BakeContext): void {
  const mode = ctx.params.road_mode;
  const proud = ctx.params.regions?.roads?.proud_mm ?? -0.2;
  if (mode === "emboss" && proud < 0) {
    addFinding(ctx, {
      id: "road-placement-conflict",
      severity: "warning",
      title: "Roads are set to emboss but sit below the surface",
      detail:
        `Road mode is "emboss" while the roads region is placed ${(-proud).toFixed(2)} mm ` +
        "below the base top, so they print as grooves. The region placement wins.",
      region: "roads",
      fix: {
        label: "Raise roads above the surface",
        safe: true,
        patch: { regions: { roads: { proud_mm: 0.4 } } },
      },
    });
  }
  if (mode === "engrave" && proud > 0) {
    addFinding(ctx, {
      id: "road-placement-conflict",
      severity: "warning",
      title: "Roads are set to engrave but stand proud",
      detail:
        `Road mode is "engrave" while the roads region is placed ${proud.toFixed(2)} mm ` +
        "above the base top, so they print as ridges. The region placement wins.",
      region: "roads",
      fix: {
        label: "Sink roads into the surface",
        safe: true,
        patch: { regions: { roads: { proud_mm: -0.2 } } },
      },
    });
  }
}
