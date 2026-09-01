/**
 * The printability audit, as pure data.
 *
 * No bake here: every rule in `rules.ts` is a function of finished meshes,
 * stats and parameters, and that is exactly what these tests hand it. The rules
 * that need a real model to be worth anything (overhangs on a hillside, the
 * merge count on a real city) are exercised against the engine's own bakes in
 * `solid/engine.test.ts` and `solid/tiling.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams, type SceneGraph } from "../../contracts";
import { PRINTER_PROFILES, resolveProfile } from "../../printers";
import type { AuditFinding, Bbox3, EngineStats, RegionMesh, RegionName, TileResult } from "../types";
import {
  OVERHANG_LIMIT_DEG,
  PLATE_EDGE_MARGIN_MM,
  auditPrintability,
  largestProfilePlateMm,
  overhangReport,
  type AuditInput,
} from "./rules";
import { patchIsForbidden } from "./fixes";

function mesh(overrides: Partial<RegionMesh> = {}): RegionMesh {
  return {
    region: "base",
    positions: new Float64Array(0),
    indices: new Uint32Array(0),
    volumeMm3: 100,
    bbox: { min: [0, 0, 0], max: [180, 180, 20] },
    bodies: 1,
    slot: 1,
    colorHex: "#D8D3C6",
    ...overrides,
  };
}

function stats(overrides: Partial<EngineStats> = {}): EngineStats {
  return {
    scaleDenominator: 10000,
    minWallMm: 0.8,
    measuredMinWallMm: 0.9,
    buildings: 200,
    buildingsMerged: 0,
    buildingsDilated: 0,
    heightFallbacks: 0,
    triangles: 1000,
    widthMm: 180,
    depthMm: 180,
    heightMm: 20,
    elapsedMs: 1,
    ...overrides,
  };
}

function emptyScene(): SceneGraph {
  return {
    bounds: { min_x: -900, min_y: -900, max_x: 900, max_y: 900 },
    center: { lat: 41.8827, lon: -87.6233 },
    buildings: [],
    roads: [],
    water: [],
    green: [],
    trees: [],
    stats: { building_count: 0, coverage: "sparse", height_tag_ratio: 1 },
  };
}

function input(overrides: Partial<AuditInput> = {}): AuditInput {
  const params = overrides.params ?? defaultPrintParams();
  return {
    params,
    scene: emptyScene(),
    radiusM: 900,
    regions: [mesh()],
    merged: mesh(),
    stats: stats(),
    built: [],
    ...overrides,
  };
}

/** A single triangle, as a one-region mesh. */
function triangle(a: [number, number, number], b: [number, number, number], c: [number, number, number]) {
  return {
    positions: new Float64Array([...a, ...b, ...c]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

function find(findings: readonly AuditFinding[], id: string): AuditFinding | undefined {
  return findings.find((finding) => finding.id === id);
}

describe("overhang measurement", () => {
  it("counts a downward face and ignores the same face pointing up", () => {
    // Wound clockwise seen from ABOVE, so the outward normal points down.
    const down = triangle([0, 0, 10], [0, 10, 10], [10, 0, 10]);
    const flipped = triangle([0, 0, 10], [10, 0, 10], [0, 10, 10]);
    expect(overhangReport(down).overhangMm2).toBeCloseTo(50, 6);
    expect(overhangReport(flipped).overhangMm2).toBe(0);
    expect(overhangReport(down).surfaceMm2).toBeCloseTo(50, 6);
  });

  it("ignores a downward face lying on the bed", () => {
    const onBed = triangle([0, 0, 0.2], [10, 0, 0.2], [0, 10, 0.2]);
    expect(overhangReport(onBed).overhangMm2).toBe(0);
    expect(overhangReport(onBed).surfaceMm2).toBeCloseTo(50, 6);
  });

  it("ignores a vertical wall and catches one leaning past the limit", () => {
    // A vertical wall: normal horizontal, 0 degrees from vertical.
    const wall = triangle([0, 0, 1], [10, 0, 1], [0, 0, 11]);
    expect(overhangReport(wall).overhangMm2).toBe(0);
    // 60 degrees from vertical, which is past the 50 degree limit.
    const lean = 60;
    const dz = Math.cos((lean * Math.PI) / 180);
    const dy = Math.sin((lean * Math.PI) / 180);
    const steep = triangle([0, 0, 5], [0, dy * 10, 5 - dz * 10], [10, 0, 5]);
    const report = overhangReport(steep);
    expect(report.overhangMm2).toBeGreaterThan(0);
    expect(report.steepestDeg).toBeCloseTo(lean, 0);
    // ... and the same face is fine when the limit is raised past it.
    expect(overhangReport(steep, lean + 5).overhangMm2).toBe(0);
    expect(OVERHANG_LIMIT_DEG).toBe(50);
  });

  it("reports nothing for a model with no overhang worth mentioning", () => {
    expect(find(auditPrintability(input()), "unsupported-overhang")).toBeUndefined();
  });
});

describe("the printer's plate", () => {
  it("says nothing when the model fits", () => {
    const params: PrintParams = { ...defaultPrintParams(), printer_profile: "bambu-p1s" };
    expect(find(auditPrintability(input({ params })), "exceeds-profile-plate")).toBeUndefined();
  });

  it("offers a smaller plate when the model only just misses", () => {
    // 180 mm of model on a 180 mm bed is fine; 200 is not, and 170 fits it.
    const params: PrintParams = {
      ...defaultPrintParams(),
      printer_profile: "bambu-a1-mini",
      plate_mm: 200,
    };
    const box: Bbox3 = { min: [0, 0, 0], max: [200, 200, 20] };
    const findings = auditPrintability(
      input({ params, merged: mesh({ bbox: box }), stats: stats({ widthMm: 200, depthMm: 200 }) }),
    );
    const finding = find(findings, "exceeds-profile-plate");
    expect(finding?.severity).toBe("error");
    expect(finding?.detail).toContain("180 x 180 mm bed");
    expect(finding?.fix?.patch).toEqual({ plate_mm: 180 - 2 * PLATE_EDGE_MARGIN_MM });
    expect(finding?.fix?.safe).toBe(false);
  });

  it("offers tiling when shrinking would cost too much of the model", () => {
    const params: PrintParams = {
      ...defaultPrintParams(),
      printer_profile: "custom",
      custom_profile: { ...defaultPrintParams().custom_profile, plate_x_mm: 100, plate_y_mm: 100 },
      plate_mm: 250,
    };
    const box: Bbox3 = { min: [0, 0, 0], max: [250, 250, 20] };
    const findings = auditPrintability(
      input({ params, merged: mesh({ bbox: box }), stats: stats({ widthMm: 250, depthMm: 250 }) }),
    );
    const finding = find(findings, "exceeds-profile-plate");
    expect(finding?.severity).toBe("error");
    expect(finding?.fix?.label).toContain("tiles");
    const patch = finding?.fix?.patch as { tiling?: { enabled?: boolean; cols?: number; rows?: number } };
    expect(patch.tiling?.enabled).toBe(true);
    // 250 mm over 90 mm of usable plate is three tiles each way.
    expect(patch.tiling?.cols).toBe(3);
    expect(patch.tiling?.rows).toBe(3);
  });

  it("says nothing about the plate once the model is already tiled", () => {
    const params: PrintParams = {
      ...defaultPrintParams(),
      printer_profile: "bambu-a1-mini",
      plate_mm: 250,
    };
    const tiles: TileResult[] = [
      { index: [0, 0], label: "A2", regions: [mesh()], bbox: { min: [0, 0, 0], max: [120, 120, 20] } },
      { index: [1, 0], label: "B2", regions: [mesh()], bbox: { min: [0, 0, 0], max: [120, 120, 20] } },
    ];
    const findings = auditPrintability(
      input({ params, merged: mesh({ bbox: { min: [0, 0, 0], max: [250, 250, 20] } }), tiles }),
    );
    expect(find(findings, "exceeds-profile-plate")).toBeUndefined();
    expect(find(findings, "tile-exceeds-plate")).toBeUndefined();
  });

  it("fails a tile that is still too big for the bed", () => {
    const params: PrintParams = {
      ...defaultPrintParams(),
      printer_profile: "bambu-a1-mini",
      plate_mm: 250,
    };
    const tiles: TileResult[] = [
      { index: [0, 0], label: "A2", regions: [mesh()], bbox: { min: [0, 0, 0], max: [200, 120, 20] } },
      { index: [1, 0], label: "B2", regions: [mesh()], bbox: { min: [0, 0, 0], max: [120, 120, 20] } },
    ];
    const findings = auditPrintability(
      input({
        params,
        merged: mesh({ bbox: { min: [0, 0, 0], max: [250, 250, 20] } }),
        stats: stats({ widthMm: 250, depthMm: 250 }),
        tiles,
      }),
    );
    const finding = find(findings, "tile-exceeds-plate");
    expect(finding?.severity).toBe("error");
    expect(finding?.detail).toContain("A2");
  });

  it("knows the biggest bed in the table", () => {
    expect(largestProfilePlateMm()).toBe(
      Math.min(PRINTER_PROFILES["bambu-h2s"].plateXMm, PRINTER_PROFILES["bambu-h2s"].plateYMm),
    );
  });
});

describe("filament slots", () => {
  it("fails a region on a slot the printer does not have, and clamps it", () => {
    const params: PrintParams = { ...defaultPrintParams(), printer_profile: "prusa-mk4" };
    const regions = [mesh({ region: "base", slot: 1 }), mesh({ region: "roads", slot: 4 })];
    const findings = auditPrintability(input({ params, regions }));
    const finding = find(findings, "slot-beyond-profile");
    expect(finding?.severity).toBe("error");
    expect(finding?.detail).toContain("Prusa MK4");
    expect(finding?.fix?.safe).toBe(true);
    const patch = finding?.fix?.patch as { colour?: { region_slots?: Record<string, number> } };
    expect(patch.colour?.region_slots?.roads).toBe(1);
    // Untouched regions keep the slot they had.
    expect(patch.colour?.region_slots?.base).toBe(1);
  });

  it("says nothing when every slot exists", () => {
    const params: PrintParams = { ...defaultPrintParams(), printer_profile: "bambu-x1c" };
    const regions = [mesh({ slot: 1 }), mesh({ region: "roads", slot: 4 })];
    expect(find(auditPrintability(input({ params, regions })), "slot-beyond-profile")).toBeUndefined();
  });
});

describe("merged buildings", () => {
  it("explains the merge with the ground distance that caused it", () => {
    const findings = auditPrintability(
      input({ stats: stats({ buildingsMerged: 720, buildings: 289, scaleDenominator: 10714 }) }),
    );
    const finding = find(findings, "buildings-merged");
    expect(finding?.severity).toBe("info");
    expect(finding?.title).toContain("720");
    expect(finding?.detail).toMatch(/1:10714/);
    expect(finding?.detail).toMatch(/\d+\.\d m of ground/);
    expect(finding?.fix).toBeUndefined();
  });

  it("says nothing when nothing merged", () => {
    expect(find(auditPrintability(input()), "buildings-merged")).toBeUndefined();
  });
});

describe("islands", () => {
  it("names the region, the count and whether they even reach the bed", () => {
    const findings = auditPrintability(
      input({
        islands: [{ region: "parks", count: 3, volumeMm3: 4.5, floating: true }],
        stats: stats({ trees: 40 }),
      }),
    );
    const finding = find(findings, "floating-island");
    expect(finding?.severity).toBe("error");
    expect(finding?.region).toBe("parks");
    expect(finding?.title).toContain("3 pieces");
    expect(finding?.detail).toContain("4.50 mm3");
    expect(finding?.detail).toContain("over air");
    // The tree markers are the only thing in that region a fix could drop, and
    // dropping content is never applied unasked.
    expect(finding?.fix?.patch).toEqual({ trees: false });
    expect(finding?.fix?.safe).toBe(false);
  });

  it("offers no fix for loose material nothing can be switched off", () => {
    const findings = auditPrintability(
      input({ islands: [{ region: "buildings", count: 1, volumeMm3: 12, floating: false }] }),
    );
    const finding = find(findings, "floating-island");
    expect(finding?.fix).toBeUndefined();
    expect(finding?.detail).toContain("stand on the bed");
  });
});

describe("the finding list as a whole", () => {
  it("keeps what the bake already reported and puts errors first", () => {
    const built: AuditFinding[] = [
      { id: "text-too-small", severity: "warning", title: "a", detail: "b" },
      { id: "terrain-low-relief", severity: "info", title: "c", detail: "d" },
    ];
    const params: PrintParams = { ...defaultPrintParams(), printer_profile: "prusa-mini" };
    const findings = auditPrintability(
      input({ params, built, regions: [mesh({ region: "roads", slot: 4 })] }),
    );
    expect(findings.map((f) => f.severity)).toEqual(["error", "warning", "info"]);
    expect(find(findings, "text-too-small")).toBeDefined();
    expect(find(findings, "terrain-low-relief")).toBeDefined();
  });

  it("never repeats the same finding twice", () => {
    const built: AuditFinding[] = [
      { id: "buildings-merged", severity: "info", title: "x", detail: "y" },
      { id: "buildings-merged", severity: "info", title: "x", detail: "y" },
    ];
    const findings = auditPrintability(input({ built }));
    expect(findings.filter((f) => f.id === "buildings-merged" && f.detail === "y")).toHaveLength(1);
  });

  it("never offers a fix that writes the nozzle diameter", () => {
    // Every rule in the catalogue, exercised at once, then swept.
    const params: PrintParams = {
      ...defaultPrintParams(),
      printer_profile: "bambu-a1-mini",
      plate_mm: 250,
    };
    const findings = auditPrintability(
      input({
        params,
        regions: [mesh({ region: "roads", slot: 16 })],
        merged: mesh({ bbox: { min: [0, 0, 0], max: [250, 250, 20] } }),
        stats: stats({ widthMm: 250, depthMm: 250, buildingsMerged: 10, trees: 5 }),
        islands: [{ region: "parks", count: 1, volumeMm3: 1, floating: true }],
      }),
    );
    expect(findings.length).toBeGreaterThan(3);
    for (const finding of findings) {
      if (finding.fix === undefined) continue;
      expect(patchIsForbidden(finding.fix.patch)).toBeNull();
    }
  });

  it("resolves the printer profile from the parameters when none is given", () => {
    const params: PrintParams = { ...defaultPrintParams(), printer_profile: "ender-3" };
    const findings = auditPrintability(
      input({ params, regions: [mesh({ region: "water", slot: 3 })] }),
    );
    expect(find(findings, "slot-beyond-profile")?.detail).toContain(
      resolveProfile(params).label,
    );
  });
});

describe("regions the audit reads", () => {
  it("orders the regions it names by the engine's own region order", () => {
    const params: PrintParams = { ...defaultPrintParams(), printer_profile: "prusa-mini" };
    const names: RegionName[] = ["roads", "buildings", "water"];
    const regions = names.map((region) => mesh({ region, slot: 4 }));
    const finding = find(auditPrintability(input({ params, regions })), "slot-beyond-profile");
    expect(finding?.detail.startsWith("buildings, roads, water")).toBe(true);
  });
});
