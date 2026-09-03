/**
 * The export gate: what "a failing export ships nothing" means in code.
 *
 * 04 stage 4 says "on failure, do not silently ship". The engine's own gate
 * (`solid/validate.ts`) raises its Stage 4 rows as findings; the ones it
 * raises at `error` severity are exactly the rows the reference validator
 * fails on (not manifold, no volume, not sitting on the bed, a base in more
 * than one piece, wider than the plate, taller than the ceiling, a wall under
 * 0.9 of the minimum). An export of a model carrying one of those is refused
 * unless the caller says `force`, and the refusal names the check.
 */

import type { AuditFinding } from "../types";

/** Finding ids `solid/validate.ts` raises for the Stage 4 rows. */
export const STAGE_4_FINDING_IDS: readonly string[] = [
  "not-manifold",
  "floating-island",
  "exceeds-plate",
  "exceeds-height",
  "wall-too-thin",
];

/** The findings that block an export: Stage 4 rows the gate raised at `error`. */
export function blockingFindings(findings: readonly AuditFinding[]): AuditFinding[] {
  return findings.filter((finding) => finding.severity === "error" && STAGE_4_FINDING_IDS.includes(finding.id));
}

export class ExportBlockedError extends Error {
  readonly blocking: AuditFinding[];
  constructor(blocking: readonly AuditFinding[]) {
    super(
      `export refused: the printability gate failed ${blocking.length === 1 ? "a check" : `${blocking.length} checks`} ` +
        `(${blocking.map((finding) => finding.id).join(", ")}): ${blocking.map((finding) => finding.title).join("; ")}. ` +
        "Fix the model, or export with force to ship it anyway.",
    );
    this.name = "ExportBlockedError";
    this.blocking = [...blocking];
  }
}
