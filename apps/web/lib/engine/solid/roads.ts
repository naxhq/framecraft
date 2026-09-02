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

import type { Point, Road } from "../../contracts";
import type { BuildContext } from "./context";
import { addFinding } from "./context";
import type { Contour } from "./manifold";
import { ribbonContours, roadContours } from "./repair";

/** A rail centreline, if the ingest side put one in the SceneGraph. */
export interface RailWay {
  path: Point[];
  width_m?: number;
  bridge?: boolean;
  layer?: number;
}

/**
 * True when this segment is carried over whatever is under it.
 *
 * `bridge=yes` is the tag that says so; a positive `layer` is the tag that says
 * so when the mapper did not use the first one, which on a downtown grid is
 * most of the elevated network. A NEGATIVE layer is a tunnel and never reaches
 * this engine (`osm/normalize.ts` drops it), so the test is one-sided.
 */
export function isElevated(way: { bridge?: boolean; layer?: number }): boolean {
  return way.bridge === true || (way.layer ?? 0) > 0;
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
    const record = entry as { width_m?: unknown; bridge?: unknown; layer?: unknown };
    out.push({
      path: path as Point[],
      width_m: typeof record.width_m === "number" ? record.width_m : undefined,
      bridge: record.bridge === true,
      layer: typeof record.layer === "number" ? record.layer : undefined,
    });
  }
  return out;
}

/**
 * The scene's roads, split into the ones at grade and the ones in the air.
 *
 * `bridge` and `layer` are additive TS-only fields on `EngineRoad`
 * (`osm/types.ts`), so they are read defensively for the same reason
 * `railWays` is: a SceneGraph from the Python service carries neither, and on
 * one of those every road is at grade, which is what it was before bridges
 * existed.
 */
export function splitRoadsByLevel(scene: {
  roads: readonly Road[];
}): { grade: Road[]; elevated: Road[] } {
  const grade: Road[] = [];
  const elevated: Road[] = [];
  for (const road of scene.roads) {
    if (isElevated(road as { bridge?: boolean; layer?: number })) elevated.push(road);
    else grade.push(road);
  }
  return { grade, elevated };
}

/** Roads this build will build in the air. Empty when `bridges.enabled` is false. */
export function bridgeRoadWays(scene: { roads: readonly Road[] }): Road[] {
  return splitRoadsByLevel(scene).elevated;
}

/** Rail ways this build will build in the air. */
export function bridgeRailWays(scene: unknown): RailWay[] {
  return railWays(scene).filter(isElevated);
}

/**
 * Printed ground width of one rail way, metres.
 *
 * `params.regions.rail.width_m` unless the way carries its own, clamped up to a
 * minimum wall exactly as a road's is: a rail line printed thinner than two
 * perimeters is a scratch, not a track.
 */
export function railWidthGroundM(ctx: BuildContext, way: RailWay): number {
  const fallback = ctx.params.regions?.rail?.width_m ?? 6.0;
  return Math.max(
    (way.width_m ?? fallback) * ctx.params.road_scale,
    ctx.thresholdsGroundM.min_wall,
  );
}

/**
 * Ribbon contours for the road layer, print mm. Empty when roads are off.
 *
 * With `bridges.enabled` the elevated segments are removed here and rebuilt by
 * `solid/bridges.ts`, so the ground under a viaduct keeps whatever is really
 * there. With bridges off every segment is laid at grade, which is v2's
 * behaviour and the reason this reads `bridgesEnabled` rather than assuming it.
 */
export function roadLayerContours(ctx: BuildContext): Contour[] {
  if (ctx.params.road_mode === "off") return [];
  const enabled = ctx.params.bridges?.enabled ?? true;
  const roads = enabled ? splitRoadsByLevel(ctx.scene).grade : ctx.scene.roads;
  return roadContours(ctx, roads);
}

/** Ribbon contours for the rail layer, print mm. */
export function railLayerContours(ctx: BuildContext): Contour[] {
  const enabled = ctx.params.bridges?.enabled ?? true;
  const ways = enabled ? railWays(ctx.scene).filter((w) => !isElevated(w)) : railWays(ctx.scene);
  if (ways.length === 0) return [];
  const out: Contour[] = [];
  for (const way of ways) {
    out.push(...ribbonContours(way.path, railWidthGroundM(ctx, way) * ctx.scale, ctx.scale));
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
export function reportRoadModeConflict(ctx: BuildContext): void {
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
