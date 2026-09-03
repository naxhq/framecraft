/**
 * The Issues drawer's optimistic "Fixed" mark.
 *
 * The defect this pins (`findings.md`, "Open for W3b", against
 * `e2e/print.spec.ts:111`): the badge cleared EVERY mark whenever the findings
 * list changed. Pressing a row's fix button schedules an incremental run 80 ms
 * later (`PIPELINE_DEBOUNCE_MS`, `[V3.1-P1-3]`), and any new findings array --
 * including one that still carries the row that was just fixed -- wiped the
 * mark, so the button went back to offering the same fix a second time on a
 * setting that had already moved.
 *
 * The rule now: a mark belongs to its ROW and is retired when the row is. That
 * is what makes the e2e's premise ("the button goes disabled and reads Fixed
 * before the next build lands, and never offers the fix again") true rather
 * than racy, and it is checked here on the pure function the effect calls.
 */

import { describe, expect, it } from "vitest";

import type { AuditFinding } from "@/lib/engine/types";
import type { Issue } from "@/lib/issues";
import { survivingFixedIds, withExportFindings } from "./IssuesBadge";

function issue(id: string): Issue {
  return {
    id,
    severity: "error",
    title: `title ${id}`,
    detail: `detail ${id}`,
    source: "engine",
    fix: { label: `Fix ${id}`, safe: true, patch: {} },
  };
}

function finding(id: string, detail = `detail ${id}`): AuditFinding {
  return { id, severity: "warning", title: `title ${id}`, detail };
}

describe("survivingFixedIds", () => {
  it("keeps a mark while its row is still on screen", () => {
    const marked = new Set(["slot-beyond-profile"]);
    const kept = survivingFixedIds(marked, [issue("slot-beyond-profile"), issue("wall-too-thin")]);
    expect([...kept]).toEqual(["slot-beyond-profile"]);
  });

  it("keeps it across a NEW findings array that still carries the row", () => {
    // The exact shape of the race: the debounced run lands a fresh array 80 ms
    // after the click, with the same ids in it. Clearing here was the defect.
    const marked = new Set(["slot-beyond-profile"]);
    const first = [issue("slot-beyond-profile")];
    const second = [issue("slot-beyond-profile")];
    expect(second).not.toBe(first);
    expect([...survivingFixedIds(marked, second)]).toEqual(["slot-beyond-profile"]);
  });

  it("retires a mark whose row is gone, which is what the fix landing looks like", () => {
    const marked = new Set(["slot-beyond-profile"]);
    expect([...survivingFixedIds(marked, [issue("wall-too-thin")])]).toEqual([]);
    expect([...survivingFixedIds(marked, [])]).toEqual([]);
  });

  it("retires only the rows that went, not the ones that stayed", () => {
    const marked = new Set(["a", "b", "c"]);
    const kept = survivingFixedIds(marked, [issue("b"), issue("c"), issue("d")]);
    expect([...kept].sort()).toEqual(["b", "c"]);
  });

  it("returns the same set when nothing was dropped, so the effect renders nothing", () => {
    const marked = new Set(["a"]);
    expect(survivingFixedIds(marked, [issue("a"), issue("z")])).toBe(marked);
    const empty: ReadonlySet<string> = new Set();
    expect(survivingFixedIds(empty, [issue("a")])).toBe(empty);
  });
});

/**
 * The export writer's findings, which reached the sidecar and the CLI and
 * stopped there ([V3.1-T6] 4).
 *
 * `DECISIONS.md [V3.1-P7-5]` says a face that float32 hardening cannot clear
 * "is reported as a `float32-degenerate` warning that reaches the sidecar, the
 * CLI and the Issues badge". `lib/exportFlow.ts:exportDone` put it on
 * `exportState.findings` and nothing ever read that field: the badge's list
 * came from `pipeline.result.findings` alone, which is the pre-writer list, so
 * the one row this rule exists to raise was visible only in a downloaded file.
 */
describe("withExportFindings", () => {
  it("adds the writer's own row to the live list", () => {
    const rows = withExportFindings(
      [issue("wall-too-thin")],
      [finding("float32-degenerate", "1 face could not be separated.")],
    );
    expect(rows.map((row) => row.id)).toEqual(["wall-too-thin", "float32-degenerate"]);
    expect(rows[1].detail).toBe("1 face could not be separated.");
    expect(rows[1].source).toBe("engine");
  });

  it("never lets the export's stale copy of a row overwrite the live one", () => {
    /*
      `exportState.findings` OPENS with a copy of the model's findings as they
      stood when the file was written, so a naive merge would let a finished
      export's old measurement replace the current build's row. The live list
      wins, always; only ids it does not carry are added.
    */
    const live = issue("wall-too-thin");
    const rows = withExportFindings(
      [live],
      [finding("wall-too-thin", "an old measurement"), finding("float32-degenerate")],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe(live);
    expect(rows.map((row) => row.id)).toEqual(["wall-too-thin", "float32-degenerate"]);
  });

  it("deduplicates the export's own list, so one row cannot appear twice", () => {
    const rows = withExportFindings([], [finding("float32-degenerate"), finding("float32-degenerate")]);
    expect(rows.map((row) => row.id)).toEqual(["float32-degenerate"]);
  });

  it("returns the SAME array when it adds nothing, so a mark keyed on the list survives", () => {
    // The "Fixed" marks are keyed on the joined ids of this list. An export
    // that had nothing new to say must not disturb them.
    const issues = [issue("slot-beyond-profile")];
    expect(withExportFindings(issues, [])).toBe(issues);
    expect(withExportFindings(issues, [finding("slot-beyond-profile")])).toBe(issues);
  });
});
