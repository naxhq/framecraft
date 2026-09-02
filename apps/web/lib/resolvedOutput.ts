/**
 * What actually gets cut: one row per text the build will (or will not) carve,
 * with the final string, the surface it is cut into and why a line was
 * skipped.
 *
 * Two callers share this module:
 *  - `components/editor/OutputPanel.tsx`'s "Resolved output" panel, which
 *    lists every row so nothing that builds is ever missing from it;
 *  - `lib/warnings.ts`'s Issues badge integration (`letteringWarnings`),
 *    which turns every SKIPPED row into a specific, actionable warning
 *    ("Line 2: the {city} token has no value") instead of the shared
 *    transform math's generic "the top engraving is empty" (which stays,
 *    unchanged, in `transform.lettering_layout`'s own warnings -- this module
 *    adds a MORE SPECIFIC diagnosis on top of it, it does not replace it).
 *
 * `lib/exportFlow.ts` reads the same rows to decide which lines to actually send to
 * `POST /bake`: never a zero-length engraving (rule: an empty line is omitted
 * outright, not sent as `""`).
 */

import type { Engraving, PrintParams } from "./contracts";
import { PARAM_RANGES, PARAM_LIMITS } from "./contracts";
import { resolve_text, type TokenContext } from "./tokens";

export type ResolvedLineCause = "frame-off" | "empty";

export interface ResolvedLine {
  /** Stable per line: `engraving-0`, `engraving-1`, ..., `underside-mark`. */
  id: string;
  /** The `params.engravings` index this row came from, or null for the mark. */
  index: number | null;
  /** Where this text is cut, e.g. "Frame, top edge, engraved 0.40 mm". */
  surface: string;
  /** The fully expanded string, or "" when skipped. */
  text: string;
  status: "cut" | "skipped";
  /** Why a skipped row was skipped, or null for a cut row. */
  cause: ResolvedLineCause | null;
  /** The Issues-badge / panel sentence for a skipped row, or null when cut. */
  reason: string | null;
  /** The specific `{token}` responsible, when the cause is an empty token. */
  emptyToken: string | null;
}

const EDGE_LABEL: Record<string, string> = {
  top: "top",
  bottom: "bottom",
  left: "left",
  right: "right",
  underside: "underside",
};

const MODE_LABEL: Record<string, string> = {
  engrave: "engraved",
  emboss: "embossed",
  inlay: "inlay",
};

/** "Frame, top edge, engraved 0.40 mm" -- matches the depth actually cut. */
export function engravingSurfaceLabel(engraving: Engraving): string {
  const edge = EDGE_LABEL[engraving.edge] ?? engraving.edge;
  const mode = MODE_LABEL[engraving.mode ?? "engrave"] ?? "engraved";
  const depth = engraving.depth_mm ?? PARAM_RANGES.engravings.depth_mm.default;
  return `Frame, ${edge} edge, ${mode} ${depth.toFixed(2)} mm`;
}

const UNDERSIDE_SURFACE = "Underside mark";

/**
 * Every text FrameCraft would try to cut for these `params`, resolved against
 * `ctx`, in the order the build sees them (engravings, then the underside
 * mark). One row per configured line -- an engraving array of length 3 always
 * yields exactly 3 rows, cut or skipped, never fewer.
 */
export function resolvedOutputLines(
  params: PrintParams,
  ctx: TokenContext,
): ResolvedLine[] {
  const lines: ResolvedLine[] = [];
  const engravings = params.engravings ?? [];
  const frameOn = params.frame;

  engravings.forEach((engraving, index) => {
    const id = `engraving-${index}`;
    const surface = engravingSurfaceLabel(engraving);
    const textMaxLength = PARAM_LIMITS.engravings.text.max_length;
    const raw = (engraving.text ?? "").slice(0, textMaxLength);

    if (!frameOn) {
      lines.push({
        id,
        index,
        surface,
        text: "",
        status: "skipped",
        cause: "frame-off",
        reason: "Frame is off — turn on Frame to engrave the edges.",
        emptyToken: null,
      });
      return;
    }

    const resolved = resolve_text(raw, ctx);
    if (resolved.text.trim() === "") {
      const emptyToken = resolved.tokens.find((t) => t.empty)?.token ?? null;
      const reason =
        emptyToken !== null
          ? `Line ${index + 1}: the {${emptyToken}} token has no value.`
          : `Line ${index + 1} has no text.`;
      lines.push({
        id,
        index,
        surface,
        text: "",
        status: "skipped",
        cause: "empty",
        reason,
        emptyToken,
      });
      return;
    }

    lines.push({
      id,
      index,
      surface,
      text: resolved.text,
      status: "cut",
      cause: null,
      reason: null,
      emptyToken: null,
    });
  });

  const underside = params.underside_mark;
  if (underside?.enabled) {
    const id = "underside-mark";
    const maxLength = PARAM_LIMITS.underside_mark.template.max_length;
    const raw = (underside.template ?? "").slice(0, maxLength);
    const resolved = resolve_text(raw, ctx);
    if (resolved.text.trim() === "") {
      const emptyToken = resolved.tokens.find((t) => t.empty)?.token ?? null;
      const reason =
        emptyToken !== null
          ? `Underside mark: the {${emptyToken}} token has no value.`
          : "Underside mark has no text.";
      lines.push({
        id,
        index: null,
        surface: UNDERSIDE_SURFACE,
        text: "",
        status: "skipped",
        cause: "empty",
        reason,
        emptyToken,
      });
    } else {
      lines.push({
        id,
        index: null,
        surface: UNDERSIDE_SURFACE,
        text: resolved.text,
        status: "cut",
        cause: null,
        reason: null,
        emptyToken: null,
      });
    }
  }

  return lines;
}
