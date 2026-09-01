import { describe, expect, it } from "vitest";

import type { AuditFinding } from "./engine/types";
import {
  groupIssuesBySeverity,
  issueCounts,
  issueFromFinding,
  issueFromWarning,
  issuesLabel,
  mergeIssues,
  safeFixesSummary,
} from "./issues";
import type { SceneWarning } from "./warnings";

const blockWarning: SceneWarning = {
  id: "model-too-tall",
  level: "block",
  message: "Model would be 66.5 mm tall (Custom printer ceiling 60 mm) — lower the building scales",
};

const warnWarning: SceneWarning = {
  id: "coverage-sparse",
  level: "warn",
  message: "Low building coverage: 22 buildings; consider a larger radius.",
};

const infoWarning: SceneWarning = {
  id: "frame-off-lettering",
  level: "info",
  message: "Frame is off, so the frame edge lettering will not be cut.",
};

function finding(overrides: Partial<AuditFinding> = {}): AuditFinding {
  return {
    id: "wall-too-thin",
    severity: "warning",
    title: "A wall is thinner than the nozzle can print",
    detail: "The narrowest wall measures 0.30 mm against 0.45 mm for a 0.4 mm nozzle.",
    ...overrides,
  };
}

describe("issueFromWarning / issueFromFinding", () => {
  it("maps a block/warn/info SceneWarning level to error/warning/info severity", () => {
    expect(issueFromWarning(blockWarning).severity).toBe("error");
    expect(issueFromWarning(warnWarning).severity).toBe("warning");
    expect(issueFromWarning(infoWarning).severity).toBe("info");
  });

  it("gives a known warning id a real title, not its message verbatim", () => {
    const issue = issueFromWarning(blockWarning);
    expect(issue.title).toBe("The model is too tall to print");
    expect(issue.detail).toBe(blockWarning.message);
    expect(issue.source).toBe("client");
    expect(issue.fix).toBeUndefined();
  });

  it("titles a per-line lettering warning generically, by its -empty suffix", () => {
    const issue = issueFromWarning({ id: "top-empty", level: "warn", message: "The top edge is empty." });
    expect(issue.title).toBe("An engraving line is empty");
  });

  it("falls back to the message itself for an unnamed id", () => {
    const issue = issueFromWarning({ id: "mystery", level: "warn", message: "Something odd." });
    expect(issue.title).toBe("Something odd.");
  });

  it("carries an AuditFinding's severity, title, detail, region and fix straight through", () => {
    const f = finding({
      region: "roads",
      fix: { label: "Halve the tall-building multiplier", safe: false, patch: { large_scale: 0.5 } },
    });
    const issue = issueFromFinding(f);
    expect(issue).toEqual({
      id: f.id,
      severity: f.severity,
      title: f.title,
      detail: f.detail,
      region: "roads",
      fix: f.fix,
      source: "engine",
    });
  });
});

describe("mergeIssues", () => {
  it("folds client warnings and engine findings into one list", () => {
    const issues = mergeIssues([blockWarning, warnWarning], [finding()]);
    expect(issues.map((issue) => issue.id).sort()).toEqual(
      ["coverage-sparse", "model-too-tall", "wall-too-thin"].sort(),
    );
  });

  it("lets the engine finding win outright when it shares an id with a client warning", () => {
    // Same id as a client warning, deliberately, to exercise the merge rule
    // even though today's real id sets never actually collide.
    const engineVersion = finding({
      id: "model-too-tall",
      severity: "error",
      title: "Exceeds the printer's height",
      detail: "Measured 66.5 mm against a 60 mm ceiling.",
      fix: { label: "Halve the tall-building multiplier", safe: false, patch: { large_scale: 0.5 } },
    });
    const [issue] = mergeIssues([blockWarning], [engineVersion]);
    expect(issue.source).toBe("engine");
    expect(issue.title).toBe("Exceeds the printer's height");
    expect(issue.fix).toEqual(engineVersion.fix);
  });

  it("is empty when there is nothing to report", () => {
    expect(mergeIssues([], [])).toEqual([]);
  });
});

describe("groupIssuesBySeverity / issueCounts / issuesLabel", () => {
  const issues = mergeIssues([blockWarning, warnWarning, infoWarning], [finding()]);

  it("groups error first, then warning, then info, omitting empty sections", () => {
    const sections = groupIssuesBySeverity(issues);
    expect(sections.map((section) => section.severity)).toEqual(["error", "warning", "info"]);
    expect(sections[0].items.map((item) => item.id)).toEqual(["model-too-tall"]);
  });

  it("omits a severity with nothing in it", () => {
    const onlyErrors = mergeIssues([blockWarning], []);
    expect(groupIssuesBySeverity(onlyErrors).map((section) => section.severity)).toEqual(["error"]);
  });

  it("counts by severity", () => {
    expect(issueCounts(issues)).toEqual({ error: 1, warning: 2, info: 1 });
  });

  it("labels the badge with counts, in error/warning/note order, and says 'No issues' when empty", () => {
    expect(issuesLabel(issues)).toBe("1 error, 2 warnings, 1 note");
    expect(issuesLabel([])).toBe("No issues");
    expect(issuesLabel(mergeIssues([warnWarning], []))).toBe("1 warning");
  });
});

describe("safeFixesSummary", () => {
  it("reports nothing to fix for an empty change list", () => {
    expect(safeFixesSummary([])).toBe("Nothing to fix.");
  });

  it("joins every change's own label, pluralised correctly", () => {
    expect(safeFixesSummary([{ label: "Plate 180 mm becomes 220 mm" }])).toBe(
      "1 change: Plate 180 mm becomes 220 mm.",
    );
    expect(
      safeFixesSummary([
        { label: "Plate 180 mm becomes 220 mm" },
        { label: "Terrain exaggeration 1 becomes 0.5" },
      ]),
    ).toBe("2 changes: Plate 180 mm becomes 220 mm; Terrain exaggeration 1 becomes 0.5.");
  });
});
