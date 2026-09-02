"use client";

import { useEffect, useRef, useState } from "react";

import type { AuditFinding } from "@/lib/engine/types";
import {
  groupIssuesBySeverity,
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
 * `AuditFinding`s, engine winning a shared id) rendered as a colour-coded chip
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
export function IssuesBadge({ issues }: { issues: readonly Issue[] }) {
  const open = useEditorStore((state) => state.issuesOpen);
  const setOpen = useEditorStore((state) => state.setIssuesOpen);
  const applyFinding = useEditorStore((state) => state.applyFinding);
  const applySafeFindingFixes = useEditorStore((state) => state.applySafeFindingFixes);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const wasOpen = useRef(open);

  const [report, setReport] = useState<string | null>(null);
  const [fixedIds, setFixedIds] = useState<ReadonlySet<string>>(new Set());

  const count = issues.length;
  const issueKey = issues.map((issue) => issue.id).join(",");

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

  // A fresh set of issues (a new build, a new scene) retires last time's
  // "Fixed" marks and report: they described a PREVIOUS list, and a stale
  // "Fixed" on a row that has since come back (the fix did not stick, or the
  // model changed again) would lie.
  useEffect(() => {
    setFixedIds(new Set());
    setReport(null);
  }, [issueKey]);

  if (count === 0) return null;
  const sections = groupIssuesBySeverity(issues);
  const worstSeverity: IssueSeverity = sections[0]?.severity ?? "info";
  const hasSafeFix = issues.some((issue) => issue.fix?.safe === true);

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
        Issues: {issuesLabel(issues)}
        <span aria-hidden="true" className="text-ink-faint">
          {open ? "×" : "›"}
        </span>
      </button>

      {open ? (
        <div
          id="issues-drawer"
          data-testid="issues-drawer"
          role="group"
          aria-label={`Issues: ${issuesLabel(issues)}`}
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
