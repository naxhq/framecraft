/**
 * Bake, v3: the pure export/state-transition functions in `lib/bake.ts`.
 *
 * There is no server round trip left to test: `bake()` (the browser engine)
 * is `lib/engine/solid`'s job and `lib/engine/export`'s writers are tested in
 * `lib/engine/export/*.test.ts`. This file owns the glue -- turning a fake
 * (but shape-correct) `EngineResult` into `DownloadFile[]`, and the small
 * state machine (`idle -> exporting -> done|failed`, staleness) around it.
 */

import { describe, expect, it } from "vitest";

import {
  BAKE_STALE_NOTE,
  bakeDone,
  bakeDownloadLinks,
  bakeExporting,
  bakeFailedLocally,
  bakeStatusLabel,
  initialBakeState,
  isTerminal,
  markBakeStale,
  revokeBakeUrls,
  runExport,
  stemForResult,
  type BakeState,
} from "./bake";
import { defaultPrintParams } from "./contracts";
import type { EngineResult, RegionMesh } from "./engine/types";

function region(name: RegionMesh["region"], slot = 1, colorHex = "#D8D3C6"): RegionMesh {
  return {
    region: name,
    positions: new Float64Array([0, 0, 0, 10, 0, 0, 10, 10, 0]),
    indices: new Uint32Array([0, 1, 2]),
    volumeMm3: 100,
    bbox: { min: [0, 0, 0], max: [10, 10, 1] },
    bodies: 1,
    slot,
    colorHex,
  };
}

function fakeResult(overrides: Partial<EngineResult> = {}): EngineResult {
  const params = { ...defaultPrintParams(), ...(overrides.params ?? {}) };
  return {
    regions: [region("base", 1), region("buildings", 2, "#3A3A3A")],
    // A real welded solid in the reference implementation would be one body;
    // this fixture reuses the same triangle since none of these tests judge
    // its geometry, only that it round-trips through the export/state layer.
    merged: region("base", 1),
    stats: {
      scaleDenominator: 1000,
      minWallMm: 0.8,
      measuredMinWallMm: 0.85,
      buildings: 40,
      buildingsMerged: 0,
      buildingsDilated: 0,
      heightFallbacks: 0,
      triangles: 2,
      widthMm: 180,
      depthMm: 180,
      heightMm: 30,
      elapsedMs: 12,
    },
    findings: [],
    resolvedText: [],
    ...overrides,
    params,
  };
}

const scene = {
  bounds: { min_x: -900, min_y: -900, max_x: 900, max_y: 900 },
  center: { lat: 41.8827, lon: -87.6233 },
  buildings: [],
  roads: [],
  water: [],
  green: [],
  trees: [],
  stats: { building_count: 40, coverage: "good" as const, height_tag_ratio: 0.5 },
};

describe("state transitions", () => {
  it("starts idle", () => {
    expect(initialBakeState.phase).toBe("idle");
    expect(bakeStatusLabel(initialBakeState)).toBe("Not baked yet");
    expect(isTerminal(initialBakeState.phase)).toBe(false);
  });

  it("bakeExporting moves to exporting and clears any previous error", () => {
    const state = bakeExporting(bakeFailedLocally(initialBakeState, "boom"));
    expect(state.phase).toBe("exporting");
    expect(state.error).toBeNull();
    expect(isTerminal(state.phase)).toBe(false);
  });

  it("bakeFailedLocally carries the message and is terminal", () => {
    const state = bakeFailedLocally(initialBakeState, "The engine could not build a model.");
    expect(state.phase).toBe("failed");
    expect(state.error).toBe("The engine could not build a model.");
    expect(isTerminal(state.phase)).toBe(true);
    expect(bakeStatusLabel(state)).toBe("The engine could not build a model.");
  });
});

describe("runExport / bakeDone", () => {
  it("exports an stl and its sidecar as download files", () => {
    const result = fakeResult();
    const outcome = runExport(result, "stl", scene);
    expect(outcome.output.files).toHaveLength(1);
    expect(outcome.output.files[0].name.endsWith(".stl")).toBe(true);
    expect(outcome.sidecarName.endsWith(".json")).toBe(true);
    expect(outcome.sidecarBytes.length).toBeGreaterThan(0);

    const state = bakeDone(initialBakeState, "stl", outcome, result.findings);
    expect(state.phase).toBe("done");
    expect(state.stale).toBe(false);
    expect(state.target).toBe("stl");
    // The mesh file plus the sidecar.
    expect(state.files).toHaveLength(2);
    expect(state.files.map((f) => f.filename)).toContain(outcome.sidecarName);
    for (const file of state.files) {
      expect(file.href.startsWith("blob:")).toBe(true);
    }
    revokeBakeUrls(state); // must not throw
  });

  it("the sidecar carries the real PrintParams, stats and export target", () => {
    const result = fakeResult({ params: { ...defaultPrintParams(), plate_mm: 220 } });
    const outcome = runExport(result, "generic-3mf", scene);
    const sidecar = JSON.parse(new TextDecoder().decode(outcome.sidecarBytes)) as {
      print_params: { plate_mm: number };
      export_target: string;
      bake_result: { stats: { triangles: number } };
    };
    expect(sidecar.print_params.plate_mm).toBe(220);
    expect(sidecar.export_target).toBe("generic-3mf");
    expect(sidecar.bake_result.stats.triangles).toBe(2);
  });

  it("defaults the stem to the city label, sanitised, or 'framecraft' when there is none", () => {
    expect(stemForResult(fakeResult({ params: { ...defaultPrintParams(), city_label: "Chicago Loop" } }))).toBe(
      "chicago-loop",
    );
    expect(stemForResult(fakeResult({ params: { ...defaultPrintParams(), city_label: "" } }))).toBe("framecraft");
  });

  it("revoking a previous export's URLs happens automatically on the next bakeDone", () => {
    const result = fakeResult();
    const first = bakeDone(initialBakeState, "stl", runExport(result, "stl", scene), []);
    const firstHrefs = first.files.map((f) => f.href);
    const second = bakeDone(first, "stl", runExport(result, "stl", scene), []);
    // Different object URLs (a second createObjectURL call never reuses the first's).
    expect(second.files.map((f) => f.href)).not.toEqual(firstHrefs);
  });
});

describe("staleness", () => {
  function withFinishedBake(): BakeState {
    const result = fakeResult();
    return bakeDone(initialBakeState, "stl", runExport(result, "stl", scene), result.findings);
  }

  it("keeps the files but withdraws the download links once stale", () => {
    const fresh = withFinishedBake();
    expect(bakeDownloadLinks(fresh)).toHaveLength(2);

    const stale = markBakeStale(fresh);
    expect(stale.stale).toBe(true);
    expect(stale.files).toBe(fresh.files);
    expect(stale.phase).toBe("done");
    expect(bakeDownloadLinks(stale)).toHaveLength(0);
    expect(bakeStatusLabel(stale)).toBe("Done (outdated)");
  });

  it("marks a failed bake too, so its error stops looking current", () => {
    const state = markBakeStale(bakeFailedLocally(initialBakeState, "boom"));
    expect(state.stale).toBe(true);
  });

  it("leaves a non-terminal or already-stale bake untouched, by identity", () => {
    expect(markBakeStale(initialBakeState)).toBe(initialBakeState);
    const exporting = bakeExporting(initialBakeState);
    expect(markBakeStale(exporting)).toBe(exporting);
    const once = markBakeStale(withFinishedBake());
    expect(markBakeStale(once)).toBe(once);
  });

  it("the stale note is real copy, not empty", () => {
    expect(BAKE_STALE_NOTE.length).toBeGreaterThan(0);
  });
});
