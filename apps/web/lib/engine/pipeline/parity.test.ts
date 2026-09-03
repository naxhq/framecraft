/**
 * A warm incremental run that arrives at a parameter set produces the same
 * bytes as a fresh full run of that parameter set (design section 6): the same
 * cache key means the same geometry, so the preview a slider settles into is
 * exactly the export a cold CLI run writes.
 */
import { describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams } from "../../contracts";
import { buildModel } from "../engine";
import type { EngineResult, RegionMesh } from "../types";
import { StageCache, runPipeline, type PipelineJob } from "./index";
import { blockScene, railScene } from "./testScenes";

function job(scene: PipelineJob["source"], params: PrintParams): PipelineJob {
  return {
    source: scene,
    params,
    terrain: null,
    heroIds: null,
    date: "2026-09-02",
    rotationDeg: 0,
    mode: "full",
    exportRequest: null,
    known: {},
    knownSceneHash: null,
  };
}

function sameMesh(a: RegionMesh, b: RegionMesh): void {
  expect(a.region).toBe(b.region);
  expect(a.slot).toBe(b.slot);
  expect(a.colorHex).toBe(b.colorHex);
  expect(a.bodies).toBe(b.bodies);
  expect(a.volumeMm3).toBe(b.volumeMm3);
  expect(a.bbox).toEqual(b.bbox);
  expect(a.indices.length).toBe(b.indices.length);
  expect(a.positions.length).toBe(b.positions.length);
  expect(Buffer.from(a.indices.buffer, a.indices.byteOffset, a.indices.byteLength).equals(Buffer.from(b.indices.buffer, b.indices.byteOffset, b.indices.byteLength))).toBe(true);
  expect(Buffer.from(a.positions.buffer, a.positions.byteOffset, a.positions.byteLength).equals(Buffer.from(b.positions.buffer, b.positions.byteOffset, b.positions.byteLength))).toBe(true);
}

function sameResult(warm: EngineResult, fresh: EngineResult): void {
  expect(warm.regions.map((r) => r.region)).toEqual(fresh.regions.map((r) => r.region));
  warm.regions.forEach((region, index) => sameMesh(region, fresh.regions[index]));
  sameMesh(warm.merged, fresh.merged);
  expect(warm.findings).toEqual(fresh.findings);
  expect(warm.resolvedText).toEqual(fresh.resolvedText);
  expect(warm.attributionBands).toEqual(fresh.attributionBands);
  expect(warm.recessBands).toEqual(fresh.recessBands);
  expect(warm.params).toEqual(fresh.params);
  const { elapsedMs: warmMs, ...warmStats } = warm.stats;
  const { elapsedMs: freshMs, ...freshStats } = fresh.stats;
  expect(warmMs).toBeGreaterThanOrEqual(0);
  expect(freshMs).toBeGreaterThanOrEqual(0);
  expect(warmStats).toEqual(freshStats);
}

describe("parity: warm incremental equals fresh full run, byte for byte", () => {
  it("a lettering, a colour and a road-mode change in sequence land on the same bytes as a cold build of the final params", async () => {
    const cache = new StageCache();
    try {
      const scene = blockScene();
      const source = { kind: "scene" as const, scene, key: "block" };
      const step1 = defaultPrintParams();
      step1.engravings = [{ edge: "top", text: "ONE", mode: "engrave", size_mm: 4 }];
      const step2: PrintParams = { ...step1, engravings: [{ edge: "top", text: "TWO", mode: "emboss", size_mm: 5 }] };
      const step3: PrintParams = { ...step2, colour: { ...step2.colour, region_colors: { ...step2.colour?.region_colors, buildings: "#112233" } } };
      const step4: PrintParams = { ...step3, road_mode: "emboss", regions: { ...step3.regions, roads: { depth_mm: 0.6, proud_mm: 0.4 } } };
      const quiet = () => undefined;
      await runPipeline(job(source, step1), cache, quiet);
      await runPipeline(job(source, step2), cache, quiet);
      await runPipeline(job(source, step3), cache, quiet);
      const warm = await runPipeline(job(source, step4), cache, quiet);
      expect(warm.status).toBe("done");
      const fresh = await buildModel({ scene, params: step4, date: "2026-09-02" });
      sameResult(warm.result as EngineResult, fresh);
    } finally {
      cache.dispose();
    }
  }, 120_000);

  it("the rail scene: a rail width change on a warm cache matches a cold build", async () => {
    const cache = new StageCache();
    try {
      const scene = railScene();
      const source = { kind: "scene" as const, scene, key: "rail" };
      const first = defaultPrintParams();
      const second: PrintParams = { ...first, regions: { ...first.regions, rail: { depth_mm: 0.4, proud_mm: 0.3, width_m: 9 } } };
      const quiet = () => undefined;
      await runPipeline(job(source, first), cache, quiet);
      const warm = await runPipeline(job(source, second), cache, quiet);
      const fresh = await buildModel({ scene, params: second, date: "2026-09-02" });
      sameResult(warm.result as EngineResult, fresh);
    } finally {
      cache.dispose();
    }
  }, 120_000);
});
