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

import type { Issue } from "@/lib/issues";
import { survivingFixedIds } from "./IssuesBadge";

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
