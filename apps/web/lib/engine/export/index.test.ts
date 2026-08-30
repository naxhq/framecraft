import { describe, expect, it } from "vitest";

import { DEFAULT_PRINT_PARAMS, PARAM_LIMITS } from "../../contracts";
import { FIXED_DATE, sampleResult } from "./fixtures";
import { EXPORT_TARGETS, EXPORT_TARGET_LABELS, exportForTarget, isExportTarget } from "./index";

describe("exportForTarget", () => {
  const result = sampleResult({ color_mode: "parts" });

  it("covers every export_target the contract allows, each with a label", () => {
    expect(isExportTarget(DEFAULT_PRINT_PARAMS.export_target)).toBe(true);
    for (const target of EXPORT_TARGETS) {
      expect(EXPORT_TARGET_LABELS[target]).toBeTruthy();
    }
    expect(EXPORT_TARGETS).toHaveLength(7);
    expect(isExportTarget("dxf")).toBe(false);
    // The contract's enum is reproduced here because gen_ts.py emits it only as a type.
    expect(Object.keys(PARAM_LIMITS)).not.toContain("export_target");
  });

  it("produces the expected files per target", () => {
    const names = Object.fromEntries(
      EXPORT_TARGETS.map((target) => [target, exportForTarget(result, target, { created: FIXED_DATE, stem: "city" }).files.map((f) => f.name)]),
    );
    expect(names).toEqual({
      "bambu-3mf": ["city.3mf"],
      "generic-3mf": ["city.3mf"],
      stl: ["city.stl"],
      "stl-parts-zip": ["city-parts.zip"],
      obj: ["city.obj", "city.mtl"],
      step: ["city.step"],
      "color-change-3mf": ["city-colorchange.3mf"],
    });
  });

  it("returns the colour-change plan and its notes for the single-nozzle target", () => {
    const out = exportForTarget(result, "color-change-3mf", { created: FIXED_DATE });
    expect(out.plan).not.toBeNull();
    expect(out.notes[0]).toMatch(/^start with slot 1/);
    const parts = exportForTarget(result, "bambu-3mf", { created: FIXED_DATE });
    expect(parts.plan).toBeNull();
    expect(parts.notes).toEqual([]);
  });

  it("passes the STEP size note through", () => {
    const out = exportForTarget(result, "step", { created: FIXED_DATE, triangleWarnLimit: 1 });
    expect(out.notes).toHaveLength(1);
  });
});
