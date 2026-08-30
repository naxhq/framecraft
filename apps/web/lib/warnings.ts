/**
 * Non-blocking (and two blocking) warnings derived from the SceneGraph and the
 * current PrintParams.
 *
 * 01/A2: a location with fewer than 20 buildings must show a clear
 * low-coverage warning rather than an empty scene or a crash.
 * 03: when `height_tag_ratio` is under 0.15 the UI must say heights are
 * largely estimated.
 * 04 stage 4: the printed model must stay under 60 mm tall. The bake refuses
 * such a model in under a millisecond (`bake.ModelTooTallError`), so the editor
 * has to reach the same verdict from the same math -- offering a Bake the
 * server will bounce is exactly the preview/bake divergence 01 calls the worst
 * failure mode. The prediction is pure client-side arithmetic over the
 * SceneGraph already in memory: no `/scene` call, no `/bake` call.
 */

import type { PrintParams, SceneGraph } from "./contracts";
import * as T from "./transform";

/** 01/A2. `coverage: "empty"` is the server's own verdict on the same rule. */
export const MIN_BUILDINGS_TO_BAKE = 20;
/** 03: under this share of `height_source === "tag"`, heights are guesses. */
export const ESTIMATED_HEIGHT_RATIO = 0.15;

export type WarningLevel = "info" | "warn" | "block";

export interface SceneWarning {
  id: string;
  level: WarningLevel;
  message: string;
}

/**
 * Height the finished print would reach, mm, or null when there is no scene.
 *
 * Straight from `transform.predicted_top_mm`, the function the bake's own guard
 * calls, so the number shown in the UI is the number the server compares to 60.
 * Cheap enough (one pass over the buildings) to live in a `useMemo`.
 */
export function predictedTopMm(
  graph: SceneGraph | null,
  params: PrintParams,
): number | null {
  if (!graph) return null;
  const radius_m = T.radius_m_from_bounds(graph.bounds);
  if (!(radius_m > 0)) return null;
  return T.predicted_top_mm(graph, params, radius_m);
}

/**
 * The `useMemo` key for anything derived from `sceneWarnings` /
 * `predictedTopMm`, in one place -- the same discipline as `previewDeps`
 * (DECISIONS [P4-fix]): never name `params` itself, because `store.setParam`
 * re-creates it by spread on every write.
 *
 * These are exactly the PrintParams `predicted_top_mm` reads: the plate and the
 * frame (they set the scale), the base thickness (the model starts on the base
 * top), both height multipliers, and the tree toggle. `warnings.test.ts` fails
 * if any other parameter ever starts moving the prediction.
 */
export function warningDeps(
  graph: SceneGraph | null,
  params: PrintParams,
): unknown[] {
  return [
    graph,
    params.plate_mm,
    params.frame,
    params.base_thickness_mm,
    params.small_scale,
    params.large_scale,
    params.trees,
  ];
}

/**
 * Every warning the current scene deserves. A `block` level warning also
 * disables Bake (see `bakeBlockReason`).
 */
export function sceneWarnings(
  graph: SceneGraph | null,
  params: PrintParams,
): SceneWarning[] {
  if (!graph) return [];
  const warnings: SceneWarning[] = [];
  const { building_count: count, coverage, height_tag_ratio: ratio } = graph.stats;

  if (coverage === "empty" || count < MIN_BUILDINGS_TO_BAKE) {
    warnings.push({
      id: "coverage-empty",
      level: "block",
      message:
        `Fewer than ${MIN_BUILDINGS_TO_BAKE} buildings here (${count}) — ` +
        "enlarge the radius or move the pin.",
    });
  } else if (coverage === "sparse") {
    warnings.push({
      id: "coverage-sparse",
      level: "warn",
      message: `Low building coverage: ${count} buildings; consider a larger radius.`,
    });
  }

  const top = predictedTopMm(graph, params);
  if (top !== null && top >= T.MAX_HEIGHT_MM) {
    warnings.push({
      id: "model-too-tall",
      level: "block",
      message:
        `Model would be ${top.toFixed(1)} mm tall ` +
        `(limit ${T.MAX_HEIGHT_MM.toFixed(0)} mm) — ` +
        "lower the building scales or the plate size",
    });
  }

  if (ratio < ESTIMATED_HEIGHT_RATIO) {
    warnings.push({
      id: "estimated-heights",
      level: "warn",
      message:
        "Building heights are largely estimated from OSM tags " +
        `(only ${Math.round(ratio * 100)}% carry a real height).`,
    });
  }

  return warnings;
}

/** Why Bake is disabled, or null when it is allowed. */
export function bakeBlockReason(
  graph: SceneGraph | null,
  params: PrintParams,
): string | null {
  if (!graph) return "Generate a scene first.";
  const blocking = sceneWarnings(graph, params).find((w) => w.level === "block");
  return blocking ? blocking.message : null;
}
