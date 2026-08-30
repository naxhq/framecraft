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
 *
 * [V2-P5] adds a second refusal of the same shape: a base too thin to carry
 * what is cut into its underside (`lettering.BaseTooThinError`, the arithmetic
 * in `transform.underside_min_base_mm`). Two docstrings in `transform.py` said
 * "the editor predicts the refusal from this function" and nothing in
 * `apps/web` called it, so `hanger = keyhole` on the default 3 mm base was
 * silently offered and the user found out from a failed bake (v2-07 audit,
 * finding 4). It is a `block` warning now, exactly like `model-too-tall`.
 */

import type { PrintParams, SceneGraph } from "./contracts";
import { heroHeightKey } from "./heroes";
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
 * Every PrintParams field either of the two BLOCK warnings reads:
 *
 * * `predicted_top_mm` (the 60 mm ceiling) -- the plate and the frame (they set
 *   the scale), the base thickness (the model starts on the base top), both
 *   height multipliers, the tree toggle, and -- since a hero is counted at its
 *   HERO height -- `heroHeightKey`, the string form of
 *   `transform.hero_height_ids`;
 * * `underside_min_base_mm` (the hanger floor) -- the base thickness again, the
 *   hanger, whether the underside mark is on, and `road_mode`/`water`, which
 *   BOTH move the minimum, because an engraved road or a lake takes material
 *   off the same plate from above: a keyhole needs 3.6 mm at the defaults,
 *   3.5 mm with the roads off and 3.0 mm with the water off as well.
 *
 * `warnings.test.ts` fails if any other parameter ever starts moving either.
 *
 * The hero key is a STRING and not the id array, and the mark is its `enabled`
 * flag and not the object: every entry here has to be a primitive or the graph
 * (`CityPreview.test.ts` asserts it, because `previewDeps.height` is this
 * list), and an object's identity changes on every write regardless of its
 * contents.
 */
export function warningDeps(
  graph: SceneGraph | null,
  params: PrintParams,
): unknown[] {
  return [
    ...predictedTopDeps(graph, params),
    params.hanger,
    Boolean(params.underside_mark?.enabled),
    params.road_mode,
    params.water,
  ];
}

/**
 * The height half of `warningDeps` on its own: the memo key for anything that
 * reads `predictedTopMm` and nothing else.
 *
 * `previewDeps.height` is this list, not the whole of `warningDeps`. The hanger
 * floor moves with `hanger`, `road_mode` and `water`, none of which change how
 * tall the model is drawn, and keying the canvas's height pass on them would
 * make picking a hanger re-run the building-height pass for nothing --
 * precisely the over-invalidation `previewDeps` exists to prevent
 * (`CityPreview.test.ts` asserts it, layer by layer).
 */
export function predictedTopDeps(
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
    heroHeightKey(params),
  ];
}

/** How the UI names each hanger, and what to do when the base cannot carry it. */
const UNDERSIDE_REMEDY: Record<string, [string, string]> = {
  keyhole: ["Keyhole hanger", "choose no hanger"],
  magnets: ["Magnet hanger", "choose no hanger"],
};

/**
 * The message for a base too thin to carry what is cut into its underside, or
 * null when the base is thick enough (or nothing is cut into it).
 *
 * The number is `transform.underside_min_base_mm`, i.e. the number
 * `services/bake/app/geom/lettering.py` refuses on -- the pocket depth, plus
 * the millimetre of plate that has to stay over it, plus the deepest recess the
 * top side has already taken out of the same plate. Naming the recess matters:
 * at the defaults a keyhole wants 3.6 mm, not the 3.0 mm `hanger_min_base_mm`
 * alone suggests, and a user told "3.0" who then types 3.0 is refused anyway.
 */
export function undersideBlockMessage(params: PrintParams): string | null {
  const needed = T.underside_min_base_mm(params);
  const base = params.base_thickness_mm;
  if (!(needed > 0) || base + 1e-9 >= needed) return null;

  const hanger = params.hanger ?? "none";
  const [what, remedy] =
    hanger !== "none" && UNDERSIDE_REMEDY[hanger]
      ? UNDERSIDE_REMEDY[hanger]
      : ["Underside mark", "turn the underside mark off"];

  let message =
    `${what} needs a base of at least ${needed.toFixed(1)} mm ` +
    `(now ${base.toFixed(1)} mm) — raise the base thickness or ${remedy}.`;

  const recess = T.deepest_recess_mm(params);
  if (recess > 0) {
    const road = T.road_z_mm(params);
    const source =
      road !== null && road < 0 && -road >= recess - 1e-9 ? "engraved roads" : "water";
    message +=
      ` The ${source} already take ${recess.toFixed(1)} mm off the same plate from above.`;
  }
  return message;
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

  const underside = undersideBlockMessage(params);
  if (underside !== null) {
    warnings.push({
      id: "base-too-thin-for-underside",
      level: "block",
      message: underside,
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
