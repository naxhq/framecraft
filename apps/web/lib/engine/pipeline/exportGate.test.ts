/**
 * A failing export ships nothing (04 stage 4; audit finding 6). The worker's
 * export stage refuses, by name, when the engine's own gate raised a Stage 4
 * row at `error`, and writes the files only when the caller forces it.
 */
import { describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams } from "../../contracts";
import { ExportBlockedError, STAGE_4_FINDING_IDS, blockingFindings } from "../export/gate";
import { StageCache, runPipeline, type PipelineJob } from "./index";
import { blockScene } from "./testScenes";

function exportJob(params: PrintParams, force?: boolean): PipelineJob {
  return {
    source: { kind: "scene", scene: blockScene(), key: "block" },
    params,
    terrain: null,
    heroIds: null,
    date: "2026-09-02",
    rotationDeg: 0,
    mode: "export",
    exportRequest: { target: "stl", stem: "gate", createdIso: "2026-09-02T00:00:00Z", ...(force === undefined ? {} : { force }) },
    known: {},
    knownSceneHash: null,
  };
}

describe("the export gate", () => {
  it("names the Stage 4 rows and picks only their error findings", () => {
    expect(STAGE_4_FINDING_IDS).toEqual(["not-manifold", "floating-island", "exceeds-plate", "exceeds-height", "wall-too-thin"]);
    const picked = blockingFindings([
      { id: "exceeds-height", severity: "error", title: "too tall", detail: "" },
      { id: "wall-too-thin", severity: "warning", title: "a bit thin", detail: "" },
      { id: "floating-island", severity: "warning", title: "a speck", detail: "" },
      { id: "trees-too-small", severity: "error", title: "not a gate row", detail: "" },
    ]);
    expect(picked.map((finding) => finding.id)).toEqual(["exceeds-height"]);
    expect(new ExportBlockedError(picked).message).toContain("exceeds-height");
  });

  it("refuses to write files for a model the gate failed, and says which check, unless forced", async () => {
    // A 72 m building at 0.42 mm per metre, doubled: past the 60 mm ceiling.
    const tall: PrintParams = { ...defaultPrintParams(), large_scale: 2.2, small_scale: 2.2 };
    const cache = new StageCache();
    try {
      const events: string[] = [];
      const refused = await runPipeline(exportJob(tall), cache, (event) => events.push(event.kind));
      expect(refused.status).toBe("error");
      expect(refused.error?.stage).toBe("export");
      expect(refused.error?.message).toContain("exceeds-height");
      const detail = refused.error?.detail as { blocking?: Array<{ id: string }> } | undefined;
      expect(detail?.blocking?.map((finding) => finding.id)).toContain("exceeds-height");
      expect(events).not.toContain("files");
      expect(refused.files).toBeNull();
      // The gate's own finding is on the result the preview shows.
      expect(refused.result).toBeNull();

      const forced = await runPipeline(exportJob(tall, true), cache, () => undefined);
      expect(forced.status).toBe("done");
      expect(forced.files?.files.map((file) => file.name)).toEqual(["gate.stl"]);
      expect(forced.result?.findings.some((finding) => finding.id === "exceeds-height" && finding.severity === "error")).toBe(true);

      // A model the gate passes exports without any flag.
      const fine = await runPipeline(exportJob(defaultPrintParams()), cache, () => undefined);
      expect(fine.status).toBe("done");
      expect(fine.files?.files).toHaveLength(1);
    } finally {
      cache.dispose();
    }
  }, 90_000);
});
