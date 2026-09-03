/**
 * Export, v3.1: the page half of an export.
 *
 * The writer and the sidecar are the pipeline's `export` stage now, in the
 * worker, so what is left here is the part that can only happen on the page --
 * turning transferred bytes into Blob object URLs, and the small state machine
 * (`idle -> exporting -> done|failed`, staleness) around it. The end-to-end
 * claim that the sidecar really carries this model's parameters is asserted
 * where the wiring lives, in `store/editor.test.ts`'s real export through the
 * inline transport.
 */

import { describe, expect, it } from "vitest";

import {
  EXPORT_FAILED_LABEL,
  EXPORT_STALE_NOTE,
  exportDone,
  exportDownloadLinks,
  exportStarted,
  exportFailedLocally,
  exportStatusLabel,
  initialExportState,
  isTerminal,
  markExportStale,
  revokeExportUrls,
  stemForResult,
  type ExportState,
} from "./exportFlow";
import { defaultPrintParams } from "./contracts";
import type { ExportOut } from "./engine/pipeline";
import { perfDrainTimings, perfReset, perfResetDetectionForTest, setPerfEnabled } from "./perf";
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

/** What the worker's `export` stage posts back, files already transferred. */
function fakeOutput(overrides: Partial<ExportOut> = {}): ExportOut {
  return {
    target: "stl",
    files: [
      { name: "chicago.stl", mime: "model/stl", bytes: new Uint8Array([1, 2, 3, 4]) },
    ],
    sidecar: { export_target: "stl", print_params: { plate_mm: 220 } },
    sidecarName: "chicago.json",
    notes: ["An STL carries no colour."],
    plan: null,
    ...overrides,
  };
}

describe("state transitions", () => {
  it("starts idle", () => {
    expect(initialExportState.phase).toBe("idle");
    expect(exportStatusLabel(initialExportState)).toBe("Not exported yet");
    expect(isTerminal(initialExportState.phase)).toBe(false);
  });

  it("exportStarted moves to exporting and clears any previous error", () => {
    const state = exportStarted(exportFailedLocally(initialExportState, "boom"));
    expect(state.phase).toBe("exporting");
    expect(state.error).toBeNull();
    expect(isTerminal(state.phase)).toBe(false);
  });

  it("exportFailedLocally carries the message and is terminal", () => {
    const state = exportFailedLocally(initialExportState, "The engine could not build a model.");
    expect(state.phase).toBe("failed");
    // The message is KEPT: the action bar's failure surface is what reads it,
    // and its copyable detail block quotes it verbatim.
    expect(state.error).toBe("The engine could not build a model.");
    expect(isTerminal(state.phase)).toBe(true);
  });

  it("labels a failed export by its phase, never by echoing the message", () => {
    // The store writes ONE string for two different events -- a refusal by the
    // printability gate and a run the user cancelled out from under an export
    // ([V3.1-T6] 2) -- so the results panel's phase row must not repeat it as
    // if it were a verdict. What is true of every failed export is that no file
    // came out of it ([V3.1-P1-15]).
    for (const message of [
      "The engine could not build a model.",
      "export refused: the printability gate failed a check (exceeds-height): ...",
      "Preview a location first.",
    ]) {
      const state = exportFailedLocally(initialExportState, message);
      expect(exportStatusLabel(state)).toBe(EXPORT_FAILED_LABEL);
      expect(exportStatusLabel(state)).not.toContain(message);
    }
  });

  it("leaves a previous export's files and Blob URLs exactly where they were", () => {
    // [V3.1-P1-15]: a failing export ships nothing, and it also TAKES nothing.
    // A refusal or a cancel must not revoke the download the user already has.
    const done = exportDone(initialExportState, fakeOutput(), []);
    const hrefs = done.files.map((file) => file.href);
    const failed = exportFailedLocally(done, "The engine could not build a model.");
    expect(failed.files).toBe(done.files);
    expect(failed.files.map((file) => file.href)).toEqual(hrefs);
    expect(failed.target).toBe(done.target);
    // Still current, so they are still offered.
    expect(exportDownloadLinks(failed)).toHaveLength(2);
    revokeExportUrls(failed);
  });
});

describe("exportDone", () => {
  it("offers the worker's files and its sidecar as Blob downloads", () => {
    const output = fakeOutput();
    const state = exportDone(initialExportState, output, []);
    expect(state.phase).toBe("done");
    expect(state.stale).toBe(false);
    // The target comes from the worker's answer, not from a second read of the
    // params: the file that was WRITTEN is the one the panel names.
    expect(state.target).toBe("stl");
    expect(state.notes).toEqual(output.notes);
    // The mesh file plus the sidecar.
    expect(state.files).toHaveLength(2);
    expect(state.files.map((file) => file.filename)).toEqual(["chicago.stl", "chicago.json"]);
    for (const file of state.files) {
      expect(file.href.startsWith("blob:")).toBe(true);
    }
    revokeExportUrls(state); // must not throw
  });

  it("encodes the sidecar object the reference validator reads, pretty-printed and newline-terminated", async () => {
    const output = fakeOutput();
    const state = exportDone(initialExportState, output, []);
    const sidecar = state.files[1];
    expect(sidecar.mime).toBe("application/json");
    const text = await (await fetch(sidecar.href)).text();
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(output.sidecar);
    // Pretty-printed, so a person opening the file next to the model can read
    // it; the Python validator parses either way.
    expect(text).toContain("\n  ");
    revokeExportUrls(state);
  });

  it("records the payload size, which is where a 40 MB STEP file makes itself obvious", () => {
    perfResetDetectionForTest();
    perfReset();
    setPerfEnabled(true);
    try {
      const output = fakeOutput();
      const state = exportDone(initialExportState, output, []);
      const bytes = perfDrainTimings().find((row) => row.name === "export.bytes")?.bytes ?? 0;
      const sidecarBytes = new TextEncoder().encode(`${JSON.stringify(output.sidecar, null, 2)}\n`).byteLength;
      expect(bytes).toBe(4 + sidecarBytes);
      revokeExportUrls(state);
    } finally {
      setPerfEnabled(false);
      perfResetDetectionForTest();
      perfReset();
    }
  });

  it("defaults the stem to the city label, sanitised, or 'framecraft' when there is none", () => {
    expect(stemForResult(fakeResult({ params: { ...defaultPrintParams(), city_label: "Chicago Loop" } }))).toBe(
      "chicago-loop",
    );
    expect(stemForResult(fakeResult({ params: { ...defaultPrintParams(), city_label: "" } }))).toBe("framecraft");
    // The `export` stage's own fallback does NOT sanitise, which is why the
    // store passes this: a label with a path separator must not reach a name.
    expect(stemForResult(fakeResult({ params: { ...defaultPrintParams(), city_label: "New York/Queens" } }))).not.toContain(
      "/",
    );
  });

  it("revokes a previous export's URLs on the next exportDone", () => {
    const first = exportDone(initialExportState, fakeOutput(), []);
    const firstHrefs = first.files.map((file) => file.href);
    const second = exportDone(first, fakeOutput(), []);
    // Different object URLs (a second createObjectURL call never reuses the first's).
    expect(second.files.map((file) => file.href)).not.toEqual(firstHrefs);
    revokeExportUrls(second);
  });
});

describe("staleness", () => {
  function withFinishedExport(): ExportState {
    return exportDone(initialExportState, fakeOutput(), []);
  }

  it("keeps the files but withdraws the download links once stale", () => {
    const fresh = withFinishedExport();
    expect(exportDownloadLinks(fresh)).toHaveLength(2);

    const stale = markExportStale(fresh);
    expect(stale.stale).toBe(true);
    expect(stale.files).toBe(fresh.files);
    expect(stale.phase).toBe("done");
    expect(exportDownloadLinks(stale)).toHaveLength(0);
    expect(exportStatusLabel(stale)).toBe("Done (outdated)");
  });

  it("marks a failed export too, so its error stops looking current", () => {
    const state = markExportStale(exportFailedLocally(initialExportState, "boom"));
    expect(state.stale).toBe(true);
  });

  it("leaves a non-terminal or already-stale export untouched, by identity", () => {
    expect(markExportStale(initialExportState)).toBe(initialExportState);
    const exporting = exportStarted(initialExportState);
    expect(markExportStale(exporting)).toBe(exporting);
    const once = markExportStale(withFinishedExport());
    expect(markExportStale(once)).toBe(once);
  });

  it("the stale note is real copy, not empty", () => {
    expect(EXPORT_STALE_NOTE.length).toBeGreaterThan(0);
  });
});
