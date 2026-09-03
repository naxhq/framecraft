/**
 * Non-blocking (and two blocking) warnings derived from the SceneGraph and the
 * current PrintParams.
 *
 * 01/A2: a location with fewer than 20 buildings must show a clear
 * low-coverage warning rather than an empty scene or a crash.
 * 03: when `height_tag_ratio` is under 0.15 the UI must say heights are
 * largely estimated.
 * 04 stage 4: the printed model must stay under 60 mm tall. The build refuses
 * such a model in under a millisecond (`ModelTooTallError`), so the editor
 * has to reach the same verdict from the same math -- offering an Export the
 * engine will refuse is exactly the preview/build divergence 01 calls the
 * worst failure mode. The prediction is pure client-side arithmetic over the
 * SceneGraph already in memory, and never a network call.
 *
 * [V2-P5] adds a second refusal of the same shape: a base too thin to carry
 * what is cut into its underside (`lettering.BaseTooThinError`, the arithmetic
 * in `transform.underside_min_base_mm`). Two docstrings in `transform.py` said
 * "the editor predicts the refusal from this function" and nothing in
 * `apps/web` called it, so `hanger = keyhole` on the default 3 mm base was
 * silently offered and the user found out from a failed build (v2-07 audit,
 * finding 4). It is a `block` warning now, exactly like `model-too-tall`.
 */

import type { PrintParams, SceneGraph } from "./contracts";
import type { EngineBuilding } from "./engine/osm/types";
import { effectiveHeroHeightKey, effectiveHeroIds } from "./heroes";
import { resolveProfile } from "./printers";
import { resolvedOutputLines } from "./resolvedOutput";
import { tintIsPreviewOnly } from "./tint";
import type { TokenContext } from "./tokens";
import * as T from "./transform";

/**
 * The height ceiling `predictedTopMm` is judged against: the ACTIVE printer
 * profile's own usable height, `lib/printers.ts:resolveProfile(params).
 * maxHeightMm` -- straight, no `Math.min` with 04's old flat 60 mm figure
 * (team lead's ruling, `[V3-P4]`/`[V3-P4-E9]` in DECISIONS.md; mirrors
 * `lib/engine/solid/validate.ts:maxHeightMm(ctx)`, so the UI's block/readout
 * and the engine's own "exceeds-height" finding can never disagree about
 * which model is too tall). The ceiling is a property of the machine: a P1S
 * really does have 250 mm of gantry, and refusing a 90 mm model on it
 * because a different printer's product ceiling said 60 would be wrong.
 *
 * This holds every existing default in place without a `min()`: the
 * contract's own `custom_profile.max_height_mm` default is 60 (moved from
 * 250 alongside this ruling -- `packages/contracts/schema/print_params.json`,
 * regenerated), and `printer_profile` defaults to `"custom"`, so a
 * default-constructed `PrintParams` still resolves to 60 mm here. Picking a
 * NAMED printer genuinely raises or lowers the ceiling to what that printer
 * can actually do (the P1S's own 250 mm, the A1 mini's 180 mm, ...), which is
 * the whole point of the PRINTER group existing.
 */
export function heightCeilingMm(params: PrintParams): number {
  return resolveProfile(params).maxHeightMm;
}

/** 01/A2. `coverage: "empty"` is the server's own verdict on the same rule. */
export const MIN_BUILDINGS_TO_EXPORT = 20;
/** 03: under this share of `height_source === "tag"`, heights are guesses. */
export const ESTIMATED_HEIGHT_RATIO = 0.15;

export type WarningLevel = "info" | "warn" | "block";

export interface SceneWarning {
  id: string;
  level: WarningLevel;
  message: string;
}

/**
 * `params` with `hero_building_ids` widened to the EFFECTIVE hero set (manual
 * plus, once `hero_auto` is on, the auto-promoted ones) when auto-detect is
 * on; `params` itself, unchanged, otherwise.
 *
 * `transform.predicted_top_mm` (frozen to this phase's other builder) only
 * ever reads `params.hero_building_ids`/`hero_mode`; this is how an
 * auto-promoted hero's true-height boost reaches the 60 mm guard and the HUD
 * without a change on that side of the file-ownership boundary.
 */
function effectiveParamsForHeight(graph: SceneGraph, params: PrintParams): PrintParams {
  if (!params.hero_auto?.enabled) return params;
  const ids = effectiveHeroIds(graph.buildings as EngineBuilding[], params);
  return { ...params, hero_building_ids: ids };
}

/**
 * Height the finished print would reach, mm, or null when there is no scene.
 *
 * Straight from `transform.predicted_top_mm`, the function the build's own guard
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
  return T.predicted_top_mm(graph, effectiveParamsForHeight(graph, params), radius_m);
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
 *   height multipliers, the tree toggle, and -- since a hero (manual or, once
 *   `hero_auto` is on, auto-promoted) is counted at its HERO height --
 *   `effectiveHeroHeightKey`, the string form of the EFFECTIVE id set over
 *   `transform.hero_height_ids`'s own gate;
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
 *
 * `effectiveHeroHeightKey` (not the manual-only `heroHeightKey`) is what makes
 * `hero_auto` a REAL dependency here (phase 3, `[V3-P3-U]`): toggling it, or
 * moving its count, changes this string exactly when the EFFECTIVE hero set
 * (and therefore the predicted top) actually changes -- which needs a
 * building for `hero_auto` to promote, so it is a no-op on an empty scene,
 * same as every other hero move on one.
 *
 * `printer_profile` and `custom_profile?.max_height_mm` (phase 4,
 * `[V3-P4-U]`) are the ONE pair of exceptions to "names every parameter the
 * PREDICTION reads, and no other": neither moves `predicted_top_mm` itself --
 * only `heightCeilingMm`, what it is compared AGAINST, moves with them. They
 * are listed here anyway because every reader of this dep list (the OUTPUT
 * panel's ceiling text, the preview's HUD tone, its too-tall pill) recomputes
 * from the SAME memo key, and a stale ceiling comparison after switching
 * printers -- correct number, wrong colour -- is exactly the kind of thing
 * this list exists to prevent. `warnings.test.ts`'s own closed-set check only
 * asserts the one direction that matters (a dep that DOES move the
 * prediction must be listed); it does not fail on an extra, honest dep.
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
    effectiveHeroHeightKey(graph ? (graph.buildings as EngineBuilding[]) : undefined, params),
    params.printer_profile,
    params.custom_profile?.max_height_mm,
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
 * disables Export (see `exportBlockReason`).
 */
export function sceneWarnings(
  graph: SceneGraph | null,
  params: PrintParams,
): SceneWarning[] {
  if (!graph) return [];
  const warnings: SceneWarning[] = [];
  const { building_count: count, coverage, height_tag_ratio: ratio } = graph.stats;

  if (coverage === "empty" || count < MIN_BUILDINGS_TO_EXPORT) {
    warnings.push({
      id: "coverage-empty",
      level: "block",
      message:
        `Fewer than ${MIN_BUILDINGS_TO_EXPORT} buildings here (${count}) — ` +
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
  const ceiling = heightCeilingMm(params);
  if (top !== null && top >= ceiling) {
    warnings.push({
      id: "model-too-tall",
      level: "block",
      message:
        `Model would be ${top.toFixed(1)} mm tall ` +
        `(${resolveProfile(params).label} ceiling ${ceiling.toFixed(0)} mm) — ` +
        "lower the building scales or the plate size, or pick a taller printer",
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

/**
 * One info-level entry when `colour.tint` is on and the active
 * `export_target` cannot express it (every target except `obj`, v3 phase 5,
 * `[V3-P5-C]`, `lib/tint.ts:tintIsPreviewOnly`). Graph-independent (unlike
 * `sceneWarnings`): whether a tint reaches the print is a fact about
 * `params` alone, so this shows up even before a scene has loaded.
 */
export function tintPreviewOnlyWarning(params: PrintParams): SceneWarning[] {
  if (!tintIsPreviewOnly(params.colour, params.export_target)) return [];
  return [
    {
      id: "tint-preview-only",
      level: "info",
      message:
        "Building tint affects the preview and the OBJ export only. " +
        `The active export target (${params.export_target ?? "bambu-3mf"}) ` +
        "gives every building its region's own filament colour instead.",
    },
  ];
}

/**
 * A pipeline stage that threw, as an Issues-badge entry (v3.1).
 *
 * The house rule is that everything the user needs to be told goes through the
 * Issues badge, and a failed stage is exactly that: the model on screen is the
 * last one that succeeded, and without this the only sign would be that it
 * stopped following the controls. Error level, because nothing downstream of
 * the stage ran; the stage is named, so the drawer says WHERE it broke rather
 * than only that something did.
 */
export function pipelineFailureWarning(
  failure: { stage: string; message: string } | null,
): SceneWarning[] {
  if (failure === null) return [];
  return [
    {
      id: "pipeline-stage-failed",
      level: "warn",
      message:
        `The ${failure.stage} stage could not finish: ${failure.message} ` +
        "The model on screen is the last one that built.",
    },
  ];
}

/**
 * Lettering-specific warnings: an empty line, an empty underside mark, or the
 * frame being off with lettering configured for it.
 *
 * Separate from `sceneWarnings` on purpose: those read only `(graph, params)`,
 * while these need a `TokenContext` (the resolved place, the scene's scale and
 * building count, today's date) that only a caller with a live scene and a
 * resolved place can build. Every caller that shows the Issues badge merges
 * the two lists (`components/scene/CityPreview.tsx`); `exportBlockReason` does
 * not, because nothing here is ever `block` level -- an empty line is omitted
 * from the export (`lib/exportFlow.ts`), never a reason to refuse it.
 *
 * One info-level entry when the frame is off and lettering is configured for
 * it (never one per line: turning Frame back on fixes every line at once), and
 * one warn-level entry per line (or the underside mark) that resolves empty,
 * naming the exact `{token}` responsible.
 */
export function letteringWarnings(
  params: PrintParams,
  ctx: TokenContext,
): SceneWarning[] {
  const lines = resolvedOutputLines(params, ctx);
  const warnings: SceneWarning[] = [];

  if (lines.some((line) => line.cause === "frame-off")) {
    warnings.push({
      id: "frame-off-lettering",
      level: "info",
      message:
        "Frame is off, so the frame edge lettering will not be cut. " +
        "Turn on Frame to engrave the edges.",
    });
  }

  for (const line of lines) {
    if (line.cause !== "empty") continue;
    warnings.push({
      id: `${line.id}-empty`,
      level: "warn",
      message: line.reason ?? `${line.surface} is empty.`,
    });
  }

  return warnings;
}

/** Why Export is disabled, or null when it is allowed. */
export function exportBlockReason(
  graph: SceneGraph | null,
  params: PrintParams,
): string | null {
  if (!graph) return "Preview a location first.";
  const blocking = sceneWarnings(graph, params).find((w) => w.level === "block");
  return blocking ? blocking.message : null;
}
