/**
 * The Issues drawer's data layer (FrameCraft v3 phase 4): one merged,
 * severity-grouped list of everything the current model has to say about
 * itself, plus the local application of an `AuditFinding.fix`.
 *
 * Two sources, one list, engine wins ([V3-P4-U], the merge rule the phase 4
 * brief asks for):
 *
 *  - `lib/warnings.ts`'s `SceneWarning[]` (`sceneWarnings` +
 *    `letteringWarnings`), the CLIENT-side verdicts computed straight off the
 *    `SceneGraph` in memory -- cheap, always current, and what disables Export
 *    (`WarningBanners.tsx` still reads them directly for that; nothing here
 *    changes that path).
 *  - `lib/engine/types.ts`'s `AuditFinding[]`, the live browser engine's own
 *    findings (`state.pipeline.result.findings`) -- the only source that ever
 *    carries a `fix`.
 *
 * Merged by id: a client warning and an engine finding sharing an id today
 * never happens (the two id sets are disjoint), but the rule is real and
 * forward-looking -- ids are engine-owned once the engine reports one, so a
 * future engine rule that supersedes a client warning (e.g. its own
 * height-ceiling check) wins without this module changing at all.
 */

import type { AuditFinding, RegionName, Severity } from "./engine/types";
import type { SceneWarning, WarningLevel } from "./warnings";

export { applyFix, applySafeFixes, hasSafeFixes } from "./engine/audit/fixes";
export type { FixApplication, FixChange } from "./engine/types";

export type IssueSeverity = Severity;

export interface Issue {
  id: string;
  severity: IssueSeverity;
  title: string;
  /** The plain-language explanation, with its measured numbers, verbatim from the source. */
  detail: string;
  region?: RegionName;
  fix?: { label: string; safe: boolean; patch: Record<string, unknown> };
  source: "client" | "engine";
}

const LEVEL_TO_SEVERITY: Record<WarningLevel, IssueSeverity> = {
  block: "error",
  warn: "warning",
  info: "info",
};

/**
 * Short titles for the client warning ids that do not already carry one --
 * `SceneWarning` is `{id, level, message}`, one string, not a title/detail
 * pair. `AuditFinding` already has both, so `issueFromFinding` needs none of
 * this.
 */
const WARNING_TITLES: Record<string, string> = {
  "coverage-empty": "Too few buildings to export",
  "coverage-sparse": "Low building coverage",
  "model-too-tall": "The model is too tall to print",
  "base-too-thin-for-underside": "The base is too thin for what is cut into it",
  "estimated-heights": "Building heights are mostly estimated",
  "frame-off-lettering": "Frame lettering will not be cut",
  "names-over-budget": "Some OpenStreetMap names were left out",
};

function warningTitle(warning: SceneWarning): string {
  const named = WARNING_TITLES[warning.id];
  if (named) return named;
  // The per-line/underside-mark ids are built as `${line.id}-empty` (lib/warnings.ts:letteringWarnings).
  if (warning.id.endsWith("-empty")) return "An engraving line is empty";
  return warning.message;
}

export function issueFromWarning(warning: SceneWarning): Issue {
  return {
    id: warning.id,
    severity: LEVEL_TO_SEVERITY[warning.level],
    title: warningTitle(warning),
    detail: warning.message,
    source: "client",
  };
}

export function issueFromFinding(finding: AuditFinding): Issue {
  return {
    id: finding.id,
    severity: finding.severity,
    title: finding.title,
    detail: finding.detail,
    region: finding.region,
    fix: finding.fix,
    source: "engine",
  };
}

/**
 * Every current issue, one row per id: client warnings folded in first, then
 * engine findings -- when both name the same id the engine's row REPLACES the
 * client's outright (its own severity, detail and fix), never a merge of the
 * two fields.
 */
export function mergeIssues(
  warnings: readonly SceneWarning[],
  findings: readonly AuditFinding[],
): Issue[] {
  const byId = new Map<string, Issue>();
  for (const warning of warnings) {
    const issue = issueFromWarning(warning);
    byId.set(issue.id, issue);
  }
  for (const finding of findings) {
    const issue = issueFromFinding(finding);
    byId.set(issue.id, issue);
  }
  return [...byId.values()];
}

const SEVERITY_ORDER: readonly IssueSeverity[] = ["error", "warning", "info"];

export const SEVERITY_TITLES: Record<IssueSeverity, string> = {
  error: "Blocks the print",
  warning: "Worth a look",
  info: "For your information",
};

export interface IssueSection {
  severity: IssueSeverity;
  title: string;
  items: Issue[];
}

/** The drawer's sections, empty ones omitted, error first. */
export function groupIssuesBySeverity(issues: readonly Issue[]): IssueSection[] {
  const sections: IssueSection[] = [];
  for (const severity of SEVERITY_ORDER) {
    const items = issues.filter((issue) => issue.severity === severity);
    if (items.length > 0) sections.push({ severity, title: SEVERITY_TITLES[severity], items });
  }
  return sections;
}

export function issueCounts(issues: readonly Issue[]): Record<IssueSeverity, number> {
  const out: Record<IssueSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) out[issue.severity] += 1;
  return out;
}

function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

/** The badge's own label, e.g. "2 errors, 1 warning". Empty string when there is nothing to say. */
export function issuesLabel(issues: readonly Issue[]): string {
  if (issues.length === 0) return "No issues";
  const counts = issueCounts(issues);
  const parts: string[] = [];
  if (counts.error > 0) parts.push(plural(counts.error, "error"));
  if (counts.warning > 0) parts.push(plural(counts.warning, "warning"));
  if (counts.info > 0) parts.push(plural(counts.info, "note"));
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Fix application: apps/web's own thin layer over `lib/engine/audit/fixes.ts`
// ([V3-P4-U]: `applyFix`/`applySafeFixes` and their `FixApplication` shape
// are the engine's, re-exported above; this module only turns their
// `changes: FixChange[]` into the one-line report the "Auto-fix all safe
// issues" button shows.)
// ---------------------------------------------------------------------------

/** "N changes: ..." -- what the "Auto-fix all safe issues" button reports, from a `FixApplication.changes`. */
export function safeFixesSummary(changes: readonly { label: string }[]): string {
  if (changes.length === 0) return "Nothing to fix.";
  return `${plural(changes.length, "change")}: ${changes.map((change) => change.label).join("; ")}.`;
}
