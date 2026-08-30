/**
 * "N adjustments made" — the one chip that replaces the stack of orange text.
 *
 * The editor has two kinds of thing to say about a model, and they deserve
 * very different weight:
 *
 *  - **Blocking.** Bake will refuse this: too few buildings, or over 04's
 *    60 mm ceiling. These stay on screen as banners (`components/editor/
 *    WarningBanners.tsx`) because they are the reason a button is disabled.
 *  - **Informational.** Things the pipeline quietly did or will do: footprints
 *    widened to the minimum wall, patches dropped as sub-detail, trees below
 *    the nozzle floor, heights estimated from OSM tags, and whatever the bake
 *    itself reported. Six of those stacked in a sidebar is noise; one chip that
 *    opens a grouped drawer is a summary you can act on.
 *
 * This module is the classifier, kept free of React so the counts and the
 * grouping are unit-testable (`lib/adjustments.test.ts`).
 */

import type { SceneWarning } from "./warnings";

/** Which heading an adjustment sits under in the drawer. */
export type AdjustmentGroup = "site" | "repair" | "bake";

export interface Adjustment {
  id: string;
  group: AdjustmentGroup;
  message: string;
  /** `warn` gets the ochre marker; `info` is a plain bullet. */
  tone: "info" | "warn";
}

/** Drawer headings, in the order they are shown. */
export const ADJUSTMENT_GROUP_TITLES: Record<AdjustmentGroup, string> = {
  site: "What the map gave us",
  repair: "Made printable",
  bake: "From the bake",
};

export const ADJUSTMENT_GROUP_ORDER: readonly AdjustmentGroup[] = [
  "site",
  "repair",
  "bake",
];

/**
 * Everything the chip can talk about, as plain data.
 *
 * `dilatedNote` arrives pre-formatted because the metres in it come from
 * `preview.dilatedNotice`, which owns that sentence and its test
 * (DECISIONS [V2-P1-fix]); re-deriving it here would be the second call site
 * that could pass the wrong threshold.
 */
export interface AdjustmentSources {
  /** From `warnings.sceneWarnings`; the blocking ones are ignored here. */
  warnings: readonly SceneWarning[];
  /** `preview.dilatedNotice(...)`, or null when nothing was widened. */
  dilatedNote: string | null;
  /** Footprints the bake drops as sub-detail. */
  droppedCount: number;
  /** Ground radius under which a fat nozzle drops trees, or null. */
  treeFloorMetres: number | null;
  nozzleMm: number;
  /** `BakeResult.warnings` from the last finished bake. */
  bakeWarnings: readonly string[];
  /**
   * `transform.lettering_layout(...).warnings`, verbatim: an auto-fitted size,
   * a character the face cannot lay out, a refused engraving, the "the frame is
   * off" line. Verbatim on purpose -- these are the same strings the bake
   * reports for the same parameters, so a user who reads one here and one in
   * the bake output is reading one sentence twice, not two.
   */
  textNotices?: readonly string[];
}

/** The warnings that must stay on screen because they disable Bake. */
export function blockingWarnings(
  warnings: readonly SceneWarning[],
): SceneWarning[] {
  return warnings.filter((warning) => warning.level === "block");
}

/** The warnings that collapse into the chip. */
export function informationalWarnings(
  warnings: readonly SceneWarning[],
): SceneWarning[] {
  return warnings.filter((warning) => warning.level !== "block");
}

/**
 * Every informational item, in drawer order.
 *
 * Deliberately *not* deduplicated against the blocking banners: a blocking
 * warning never appears here, so nothing is ever said twice.
 */
export function collectAdjustments(sources: AdjustmentSources): Adjustment[] {
  const out: Adjustment[] = [];

  for (const warning of informationalWarnings(sources.warnings)) {
    out.push({
      id: warning.id,
      group: "site",
      message: warning.message,
      tone: warning.level === "warn" ? "warn" : "info",
    });
  }

  if (sources.dilatedNote) {
    out.push({
      id: "footprints-widened",
      group: "repair",
      // Sentence case, and it already carries its own metres.
      message: `${capitalise(sources.dilatedNote)}.`,
      tone: "info",
    });
  }

  if (sources.droppedCount > 0) {
    out.push({
      id: "footprints-dropped",
      group: "repair",
      message:
        `${sources.droppedCount} ${plural(sources.droppedCount, "footprint")} ` +
        "dropped: too small to print at this scale.",
      tone: "info",
    });
  }

  if (sources.treeFloorMetres !== null) {
    out.push({
      id: "trees-below-nozzle",
      group: "repair",
      message:
        `A ${sources.nozzleMm} mm nozzle drops trees under ` +
        `${sources.treeFloorMetres.toFixed(1)} m of site radius.`,
      tone: "info",
    });
  }

  // The lettering sits under "Made printable": an engraving reduced to fit the
  // 6 mm lip band, or refused because a counter would close, is the same
  // minimum-feature repair the footprints above went through.
  for (const [index, notice] of (sources.textNotices ?? []).entries()) {
    out.push({
      id: `lettering-${index}`,
      group: "repair",
      message: sentence(notice),
      tone: "info",
    });
  }

  for (const [index, warning] of sources.bakeWarnings.entries()) {
    out.push({
      id: `bake-${index}`,
      group: "bake",
      message: warning,
      tone: "warn",
    });
  }

  return out;
}

export interface AdjustmentSection {
  group: AdjustmentGroup;
  title: string;
  items: Adjustment[];
}

/** The drawer's sections, empty ones omitted. */
export function groupAdjustments(
  adjustments: readonly Adjustment[],
): AdjustmentSection[] {
  const sections: AdjustmentSection[] = [];
  for (const group of ADJUSTMENT_GROUP_ORDER) {
    const items = adjustments.filter((item) => item.group === group);
    if (items.length > 0) {
      sections.push({ group, title: ADJUSTMENT_GROUP_TITLES[group], items });
    }
  }
  return sections;
}

/** The chip's own label. Zero is not a label: the chip is not rendered. */
export function adjustmentsLabel(count: number): string {
  return `${count} ${plural(count, "adjustment")} made`;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The shared math's messages are clause-shaped ("the top engraving was reduced
 * from 8 mm to 5.16 mm to fit the 6 mm lip band"), because the bake joins them
 * into a warnings list. In the drawer they are read one per bullet, so they get
 * the sentence case and the full stop the rest of the list has -- without
 * rewording a single one of them.
 */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return trimmed;
  const capitalised = capitalise(trimmed);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}
