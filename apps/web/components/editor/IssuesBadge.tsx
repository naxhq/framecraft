"use client";

import { useEffect, useRef, useState } from "react";

import type { AuditFinding } from "@/lib/engine/types";
import {
  groupIssuesBySeverity,
  issueFromFinding,
  issuesLabel,
  safeFixesSummary,
  type Issue,
  type IssueSeverity,
} from "@/lib/issues";
import { useEditorStore } from "@/store/editor";

/**
 * The Issues badge and drawer (FrameCraft v3 phase 4).
 *
 * One badge, severity-grouped: every current `Issue` (`lib/issues.ts`'s merge
 * of `lib/warnings.ts`'s client-side `SceneWarning`s and the live engine's
 * `AuditFinding`s, engine winning a shared id, plus the export writer's own
 * rows folded in behind them by `withExportFindings`) rendered as a colour-coded chip
 * under "Blocks the print" / "Worth a look" / "For your information", each
 * row showing its title and its plain-language detail (the measured numbers,
 * verbatim from the source), with a real fix button wherever `issue.fix`
 * exists. "Auto-fix all safe issues" at the top runs every safe fix in one
 * write and reports what changed, through the same store actions
 * (`applyFinding`/`applySafeFindingFixes`) that back each row's own button --
 * one undoable settings change either way, exactly like any other control.
 *
 * This is additive next to `AdjustmentsChip` ([V3-P4-U], scope note): that
 * chip keeps the passive, non-fix-capable remarks it already owned (widened
 * footprints, dropped patches, the build's own notes); this badge is the new
 * surface for everything that can be acted on. The two floating badges sit
 * side by side over the viewport rather than one replacing the other --
 * folding them into a single widget would mean rewriting `AdjustmentsChip`'s
 * existing, well-tested category grouping (site/repair/build) into a
 * severity grouping across every e2e spec that names it
 * (`a11y.spec.ts`, `lettering.spec.ts`, `ui.spec.ts`), which is out of this
 * task's remaining scope; flagged to the team lead for a follow-up
 * consolidation if a single surface is still wanted.
 */
/**
 * The "Fixed" marks that survive a new list of issues.
 *
 * A mark says "you pressed this row's fix button and the store reported a
 * change", so it belongs to the ROW, and it is retired when that row is: the
 * finding is gone, and so is the button that carried the mark. Clearing every
 * mark whenever the LIST changed was the defect (`findings.md`, open for W3b):
 * with `PIPELINE_DEBOUNCE_MS` at 80 ms an incremental run lands a new findings
 * array within a frame or two of the click, and a row still present in that
 * array had its mark wiped and went back to offering the same fix a second
 * time -- which is exactly what `e2e/print.spec.ts` was asserting must never
 * happen. Now the mark falls away with its row and not before.
 *
 * Returns the SAME set when nothing was dropped, so the effect that calls it
 * cannot cause a render of its own on an unchanged list.
 */
export function survivingFixedIds(
  previous: ReadonlySet<string>,
  issues: readonly Issue[],
): ReadonlySet<string> {
  if (previous.size === 0) return previous;
  const present = new Set(issues.map((issue) => issue.id));
  const kept = [...previous].filter((id) => present.has(id));
  if (kept.length === previous.size) return previous;
  return new Set(kept);
}

/**
 * The rows the EXPORT WRITER raised, folded in behind the live ones.
 *
 * `lib/exportFlow.ts:exportDone` builds `exportState.findings` as the model's
 * findings plus the writer's own for the FILE -- `float32-degenerate` from the
 * STL hardening is the one that exists today, and `DECISIONS.md [V3.1-P7-5]`
 * says it "reaches the sidecar, the CLI and the Issues badge". It reached the
 * first two: `exportState.findings` was written and never read by anything
 * ([V3.1-T6] 4). The badge's `issues` prop comes from the pipeline result, so
 * the writer's rows can only arrive here.
 *
 * Deduplicated with the LIVE list winning, not the export's. That direction
 * matters: `exportState.findings` opens with a COPY of the model's findings as
 * they stood when the file was written, so merging the other way would let a
 * finished export's stale `wall-too-thin` overwrite the current build's own row
 * with an old measurement. Only ids the live list does not carry are added.
 *
 * Returns the SAME array when it adds nothing, so the drawer's `issueKey` and
 * the "Fixed" marks keyed on it are not disturbed by an export that had nothing
 * new to say.
 */
export function withExportFindings(
  issues: readonly Issue[],
  findings: readonly AuditFinding[],
): readonly Issue[] {
  if (findings.length === 0) return issues;
  const present = new Set(issues.map((issue) => issue.id));
  const extra: Issue[] = [];
  for (const finding of findings) {
    if (present.has(finding.id)) continue;
    present.add(finding.id);
    extra.push(issueFromFinding(finding));
  }
  return extra.length === 0 ? issues : [...issues, ...extra];
}

export function IssuesBadge({ issues }: { issues: readonly Issue[] }) {
  /*
    Only while the export is CURRENT. Once a parameter moves, the file those
    findings describe no longer describes what is on screen (`markExportStale`,
    and the same reason `exportDownloadLinks` withdraws the links), so a
    `float32-degenerate` row from a superseded file would be a claim about a
    model the user cannot download any more.
  */
  const exportFindings = useEditorStore((state) =>
    state.exportState.stale ? NO_EXPORT_FINDINGS : state.exportState.findings,
  );
  const rows = withExportFindings(issues, exportFindings);

  const open = useEditorStore((state) => state.issuesOpen);
  const setOpen = useEditorStore((state) => state.setIssuesOpen);
  const applyFinding = useEditorStore((state) => state.applyFinding);
  const applySafeFindingFixes = useEditorStore((state) => state.applySafeFindingFixes);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const wasOpen = useRef(open);

  const [report, setReport] = useState<string | null>(null);
  const [fixedIds, setFixedIds] = useState<ReadonlySet<string>>(new Set());
  /** The rows the current auto-fix report is about, so it can be retired with them. */
  const reportedIds = useRef<ReadonlySet<string>>(new Set());

  const count = rows.length;
  const issueKey = rows.map((issue) => issue.id).join(",");

  // A scene with nothing to report closes the drawer behind itself.
  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count, setOpen]);

  useEffect(() => {
    const closing = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closing) return;
    const active = document.activeElement;
    const uninteresting =
      active === null || active === document.body || wrapperRef.current?.contains(active) === true;
    if (uninteresting) buttonRef.current?.focus();
  }, [open]);

  /**
   * A new list of issues retires the marks whose ROWS are gone, and no others
   * (`survivingFixedIds`). The auto-fix report goes the same way: it described
   * a batch of rows, so it stands until none of them is on screen any more.
   *
   * `issueKey` is the identity of the LIST. A fresh array carrying the same
   * ids is the same list and must not disturb a mark; that is the whole point
   * of keying on the ids rather than on the array.
   */
  useEffect(() => {
    setFixedIds((previous) => survivingFixedIds(previous, rows));
    setReport((current) =>
      current !== null && !rows.some((issue) => reportedIds.current.has(issue.id)) ? null : current,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueKey]);

  if (count === 0) return null;
  const sections = groupIssuesBySeverity(rows);
  const worstSeverity: IssueSeverity = sections[0]?.severity ?? "info";
  const hasSafeFix = rows.some((issue) => issue.fix?.safe === true);

  const asFinding = (issue: Issue): AuditFinding => ({
    id: issue.id,
    severity: issue.severity,
    title: issue.title,
    detail: issue.detail,
    region: issue.region,
    fix: issue.fix,
  });

  const onFix = (issue: Issue): void => {
    const outcome = applyFinding(asFinding(issue));
    if (outcome.changes.length > 0) {
      setFixedIds((previous) => new Set(previous).add(issue.id));
    }
  };

  const onAutoFixSafe = (): void => {
    const outcome = applySafeFindingFixes();
    setReport(safeFixesSummary(outcome.changes));
    reportedIds.current = new Set(outcome.applied);
    if (outcome.applied.length > 0) {
      setFixedIds((previous) => {
        const next = new Set(previous);
        for (const id of outcome.applied) next.add(id);
        return next;
      });
    }
  };

  return (
    <div ref={wrapperRef} className="pointer-events-auto">
      <button
        ref={buttonRef}
        type="button"
        data-testid="issues-badge"
        aria-expanded={open}
        aria-controls={open ? "issues-drawer" : undefined}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-milled border border-control bg-plate/95 px-2 py-1 text-2xs text-ink shadow-raised transition-colors hover:border-ink-faint"
      >
        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${DOT_TONE[worstSeverity]}`} />
        Issues: {issuesLabel(rows)}
        <span aria-hidden="true" className="text-ink-faint">
          {open ? "×" : "›"}
        </span>
      </button>

      {open ? (
        <div
          id="issues-drawer"
          data-testid="issues-drawer"
          role="group"
          aria-label={`Issues: ${issuesLabel(rows)}`}
          tabIndex={0}
          className="mt-1.5 max-h-72 w-96 max-w-[85vw] overflow-y-auto rounded-plate border border-line bg-plate p-3 shadow-lifted"
        >
          {hasSafeFix ? (
            <button
              type="button"
              data-testid="auto-fix-safe"
              onClick={onAutoFixSafe}
              className="mb-2 w-full rounded-milled border border-control bg-plate-raised px-2 py-1.5 text-2xs font-medium text-ink transition-colors hover:border-ink-faint"
            >
              Auto-fix all safe issues
            </button>
          ) : null}
          {report !== null ? (
            <p data-testid="auto-fix-report" role="status" className="mb-2 text-2xs text-ink-muted">
              {report}
            </p>
          ) : null}

          <div className="space-y-3">
            {sections.map((section) => (
              <section key={section.severity} data-testid={`issues-section-${section.severity}`}>
                <h2 className="mb-1 font-display text-2xs font-semibold uppercase tracking-[0.14em] text-ink-faint">
                  {section.title}
                </h2>
                <ul className="space-y-1.5">
                  {section.items.map((issue) => (
                    <li
                      key={issue.id}
                      data-testid={`issue-item-${issue.id}`}
                      data-severity={issue.severity}
                      className={`rounded-milled border px-2 py-1.5 text-2xs leading-snug ${CHIP_TONE[issue.severity]}`}
                    >
                      <p className="font-medium">{issue.title}</p>
                      <p className="mt-0.5 text-ink-muted">{issue.detail}</p>
                      {issue.fix ? (
                        <button
                          type="button"
                          data-testid={`issue-fix-${issue.id}`}
                          onClick={() => onFix(issue)}
                          disabled={fixedIds.has(issue.id)}
                          className="mt-1.5 rounded-milled border border-control bg-plate px-2 py-0.5 text-2xs font-medium text-ink transition-colors hover:border-ink-faint disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {fixedIds.has(issue.id) ? "Fixed" : issue.fix.label}
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A stable empty list, so a stale export does not hand the selector a new array every render. */
const NO_EXPORT_FINDINGS: readonly AuditFinding[] = [];

const DOT_TONE: Record<IssueSeverity, string> = {
  error: "bg-danger",
  warning: "bg-warn",
  info: "bg-line-strong",
};

const CHIP_TONE: Record<IssueSeverity, string> = {
  error: "border-danger/40 bg-danger-soft text-danger",
  warning: "border-warn/40 bg-warn-soft text-warn",
  info: "border-line bg-plate-sunken text-ink-muted",
};

export default IssuesBadge;
