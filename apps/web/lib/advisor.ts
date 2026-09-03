/**
 * The detail advisor, as the viewport sees it.
 *
 * `transform.detail_report` / `detail_recommendation` are the shared math (they
 * are mirrored in `services/bake/app/geom/transform.py` and the build appends the
 * same sentence to `BakeResult.warnings` when the band is `poor`). This module
 * adds nothing to them but presentation and the two REAL actions the sentence
 * names: "use this radius" and "use this plate".
 *
 * Why an action and not just a sentence: the recommendation is solved, on a
 * deterministic grid, from the city and the parameters actually on screen --
 * `Try 540 m` is a specific number, and asking the user to go and find the
 * radius slider and hit exactly 540 is asking them to re-type an answer we
 * already have.
 */

import type { PrintParams, SceneGraph } from "./contracts";
import * as T from "./transform";

/** The band colour tokens, and the words that go with them. */
export type AdvisorTone = "positive" | "warn" | "danger";

const BAND_TONES: Record<string, AdvisorTone> = {
  good: "positive",
  fair: "warn",
  poor: "danger",
};

/** How each band reads in one word, in the interface's voice. */
const BAND_WORDS: Record<string, string> = {
  good: "good",
  fair: "fair",
  poor: "poor",
};

export interface DetailChip {
  score: number;
  band: string;
  tone: AdvisorTone;
  /** What is drawn in the strip: `68 · fair`. */
  value: string;
  /**
   * The whole chip in words, because the colour is not the message: a band is
   * conveyed by a hue AND by a name, or it is conveyed only to people who can
   * see the hue (WCAG 1.4.1).
   */
  ariaLabel: string;
}

/** One thing the user can do about it, with the value already solved. */
export interface AdvisorAction {
  kind: "radius" | "plate";
  value: number;
  /** `Use 540 m` / `Use plate 256`. */
  label: string;
  /** Spoken form, so a button that says "Use 540 m" says what it changes. */
  ariaLabel: string;
}

export interface DetailAdvice {
  chip: DetailChip;
  report: T.DetailReport;
  /** `transform.detail_recommendation`, verbatim, or null when healthy. */
  sentence: string | null;
  actions: AdvisorAction[];
}

/** True when the recommendation line is worth the space it takes. */
export function showsRecommendation(band: string): boolean {
  return band === "fair" || band === "poor";
}

/**
 * The chip, the sentence and the buttons, or null without a scene.
 *
 * One `detail_report` per call and at most two grid searches, over footprint
 * metrics that are computed once per search; on the 994-building Chicago crop
 * this is a few milliseconds, and it is memoised on `advisorDeps` so it does not
 * run while a height slider moves.
 */
export function detailAdvice(
  graph: SceneGraph | null,
  params: PrintParams,
  radius_m: number | null,
): DetailAdvice | null {
  if (!graph || radius_m === null || !(radius_m > 0)) return null;
  const report = T.detail_report(graph, params, radius_m);
  const band = report.band;
  const word = BAND_WORDS[band] ?? band;
  const chip: DetailChip = {
    score: report.score,
    band,
    tone: BAND_TONES[band] ?? "warn",
    value: `${report.score} · ${word}`,
    ariaLabel:
      `Detail health ${report.score} out of 100, ${word}. ` +
      `${Math.round(100 * report.widened_fraction)}% of the buildings are widened ` +
      `to the ${report.min_wall_ground_m.toFixed(1)} m minimum wall.`,
  };

  const sentence = T.detail_recommendation(graph, params, radius_m);
  const actions: AdvisorAction[] = [];
  if (sentence !== null) {
    // Exactly the two remedies the sentence may name, under exactly the same
    // "only a change in the helpful direction" rule the sentence applies -- so a
    // button can never offer something the sentence did not.
    const radius = T.recommend_radius_m(graph, params, radius_m);
    if (radius !== null && radius < radius_m) {
      actions.push({
        kind: "radius",
        value: radius,
        label: `Use ${radius} m`,
        ariaLabel: `Use a ${radius} m radius and preview again`,
      });
    }
    const plate = T.recommend_plate_mm(graph, params, radius_m);
    if (plate !== null && plate > params.plate_mm) {
      actions.push({
        kind: "plate",
        value: plate,
        label: `Use plate ${plate}`,
        ariaLabel: `Use a ${plate} millimetre plate`,
      });
    }
  }

  return { chip, report, sentence, actions };
}

/**
 * The `useMemo` key, in one place -- the same discipline as `previewDeps` and
 * `warningDeps` (DECISIONS [P4-fix]): never the `params` object, because
 * `store.setParam` re-creates it by spread on every write.
 *
 * Exactly four parameters reach the computation. `plate_mm` and `frame` set the
 * scale, `nozzle_mm` sets every threshold off it, and `trees` decides whether
 * the tree term is measured at all. `road_scale` and `params.water` were also
 * listed until the audit measured them: `detail_report` never mentions roads,
 * and it walks `scene.water` unconditionally, so neither can move the result --
 * they only made a road-width drag re-run a 2.08 ms whole-scene walk plus two
 * grid searches for a byte-identical answer (audit v2-06 finding 3).
 *
 * `advisor.test.ts` fails BOTH ways: if any parameter starts moving the report
 * without appearing here, and if anything listed here cannot move it.
 */
export function advisorDeps(
  graph: SceneGraph | null,
  params: PrintParams,
  radius_m: number | null,
): unknown[] {
  return [graph, radius_m, params.plate_mm, params.frame, params.nozzle_mm, params.trees];
}

/** What an advisor button needs from the editor store. */
export interface AdvisorTarget {
  setRadius: (metres: number) => void;
  generate: () => void;
  setParam: (key: "plate_mm", value: number) => void;
}

/**
 * Apply one action.
 *
 * The radius goes through `setRadius` and then `generate`, which is precisely
 * what releasing the radius slider does (`Controls.createCommitGate` -> the
 * group's `onCommit`): the scene is marked stale, the finished build is retired,
 * and one `POST /scene` follows. The plate is a plain `setParam`, because the
 * plate has never been a location change and must not become one.
 */
export function applyAdvisorAction(
  action: AdvisorAction,
  target: AdvisorTarget,
): void {
  if (action.kind === "radius") {
    target.setRadius(action.value);
    target.generate();
    return;
  }
  target.setParam("plate_mm", action.value);
}
