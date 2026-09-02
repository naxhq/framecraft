// Applying a finding's fix: the deep merge, what it reports, and what it
// refuses. Nothing here builds anything; `applyFix` is a pure write.

import { describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams } from "../../contracts";
import type { AuditFinding } from "../types";
import {
  FORBIDDEN_FIX_KEYS,
  applyFix,
  applySafeFixes,
  hasSafeFixes,
  patchIsForbidden,
  patchPaths,
} from "./fixes";

function finding(id: string, patch: Record<string, unknown>, safe = true): AuditFinding {
  return {
    id,
    severity: "warning",
    title: id,
    detail: id,
    fix: { label: `fix ${id}`, safe, patch },
  };
}

describe("applyFix", () => {
  it("writes a top-level value and reports what moved", () => {
    const params = defaultPrintParams();
    const out = applyFix(params, finding("plate", { plate_mm: 220 }));
    expect(out.params.plate_mm).toBe(220);
    expect(out.applied).toEqual(["plate"]);
    expect(out.changes).toEqual([
      {
        path: "plate_mm",
        before: params.plate_mm,
        after: 220,
        findingId: "plate",
        label: "Plate 180 becomes 220",
      },
    ]);
  });

  it("never mutates the parameters it was given", () => {
    const params = defaultPrintParams();
    const before = JSON.stringify(params);
    applyFix(params, finding("plate", { plate_mm: 220 }));
    expect(JSON.stringify(params)).toBe(before);
  });

  it("merges into a nested group without disturbing its siblings", () => {
    const params = defaultPrintParams();
    const out = applyFix(params, finding("tile", { tiling: { enabled: true, cols: 2, rows: 3 } }));
    expect(out.params.tiling).toEqual({
      ...params.tiling,
      enabled: true,
      cols: 2,
      rows: 3,
    });
    expect(out.changes.map((change) => change.path).sort()).toEqual([
      "tiling.cols",
      "tiling.enabled",
      "tiling.rows",
    ]);
    // `rows` was already 1, so a patch asking for 1 would not be a change.
    expect(out.changes.find((change) => change.path === "tiling.enabled")?.label).toBe(
      "Tiling off becomes on",
    );
  });

  it("merges three levels deep", () => {
    const params = defaultPrintParams();
    const out = applyFix(
      params,
      finding("slots", { colour: { region_slots: { roads: 1 } } }),
    );
    expect(out.params.colour?.region_slots?.roads).toBe(1);
    expect(out.params.colour?.region_slots?.water).toBe(params.colour?.region_slots?.water);
    expect(out.params.colour?.palette).toBe(params.colour?.palette);
    expect(out.changes).toHaveLength(1);
    expect(out.changes[0].path).toBe("colour.region_slots.roads");
  });

  it("replaces an array wholesale", () => {
    const params: PrintParams = {
      ...defaultPrintParams(),
      engravings: [{ text: "one", edge: "top" }, { text: "two", edge: "bottom" }],
    };
    const out = applyFix(
      params,
      finding("text", { engravings: [{ text: "one", edge: "top", size_mm: 6 }] }),
    );
    expect(out.params.engravings).toHaveLength(1);
    expect(out.changes[0].path).toBe("engravings");
    expect(out.changes[0].label).toBe("engravings 2 item(s) becomes 1 item(s)");
  });

  it("reports a finding with no fix as skipped", () => {
    const out = applyFix(defaultPrintParams(), {
      id: "bare",
      severity: "info",
      title: "t",
      detail: "d",
    });
    expect(out.changes).toEqual([]);
    expect(out.skipped).toEqual([{ id: "bare", reason: "this issue has no one-click fix" }]);
  });

  it("reports a patch that asks for what is already set as changing nothing", () => {
    const params = defaultPrintParams();
    const out = applyFix(params, finding("noop", { plate_mm: params.plate_mm }));
    expect(out.params).toBe(params);
    expect(out.applied).toEqual([]);
    expect(out.skipped[0].reason).toContain("already");
  });

  it("refuses to write the nozzle diameter, at any depth", () => {
    expect(FORBIDDEN_FIX_KEYS).toContain("nozzle_mm");
    const flat = applyFix(defaultPrintParams(), finding("cheat", { nozzle_mm: 0.2 }));
    expect(flat.applied).toEqual([]);
    expect(flat.skipped[0].reason).toBe("a fix may never change nozzle_mm");
    const nested = applyFix(
      defaultPrintParams(),
      finding("cheat", { custom_profile: { nozzle_mm: 0.2 } }),
    );
    expect(nested.applied).toEqual([]);
    expect(nested.params.custom_profile?.nozzle_mm).toBe(0.4);
  });
});

describe("patch inspection", () => {
  it("lists every leaf path in a patch", () => {
    expect(patchPaths({ a: 1, b: { c: 2, d: { e: 3 } }, f: [1, 2] }).sort()).toEqual([
      "a",
      "b.c",
      "b.d.e",
      "f",
    ]);
  });

  it("names the forbidden key it found, or null", () => {
    expect(patchIsForbidden({ plate_mm: 1 })).toBeNull();
    expect(patchIsForbidden({ a: { nozzle_mm: 0.2 } })).toBe("nozzle_mm");
  });
});

describe("applySafeFixes", () => {
  it("applies only the safe ones and says why it left the rest", () => {
    const findings: AuditFinding[] = [
      finding("safe-1", { plate_mm: 200 }, true),
      finding("unsafe", { large_scale: 0.5 }, false),
      finding("safe-2", { terrain_exaggeration: 2 }, true),
      { id: "bare", severity: "info", title: "t", detail: "d" },
    ];
    const out = applySafeFixes(defaultPrintParams(), findings);
    expect(out.applied).toEqual(["safe-1", "safe-2"]);
    expect(out.params.plate_mm).toBe(200);
    expect(out.params.terrain_exaggeration).toBe(2);
    expect(out.params.large_scale).toBe(defaultPrintParams().large_scale);
    expect(out.skipped).toEqual([
      { id: "unsafe", reason: "this fix changes the design, so it needs a decision" },
    ]);
    expect(out.changes.map((change) => change.findingId)).toEqual(["safe-1", "safe-2"]);
  });

  it("lets a later fix see what an earlier one wrote", () => {
    const out = applySafeFixes(defaultPrintParams(), [
      finding("first", { plate_mm: 200 }),
      finding("second", { plate_mm: 220 }),
    ]);
    expect(out.params.plate_mm).toBe(220);
    expect(out.changes.map((change) => [change.before, change.after])).toEqual([
      [180, 200],
      [200, 220],
    ]);
  });

  it("says whether there is anything to auto-fix at all", () => {
    expect(hasSafeFixes([])).toBe(false);
    expect(hasSafeFixes([finding("a", { plate_mm: 200 }, false)])).toBe(false);
    expect(hasSafeFixes([finding("a", { plate_mm: 200 }, true)])).toBe(true);
  });
});
