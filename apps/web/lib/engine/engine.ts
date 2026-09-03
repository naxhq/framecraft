/**
 * The browser engine's one-shot entry point: a SceneGraph and a PrintParams
 * in, watertight region solids out.
 *
 * Since v3.1 the engine is the staged pipeline in `./pipeline` (an explicit
 * registry of stages, each a pure function of the parameter leaves it
 * declares, memoised in a one-generation cache that lives in the worker).
 * `buildModel()` is that pipeline run over a FRESH cache, every stage,
 * returning the same `EngineResult` it always returned, so the direct callers
 * (the test suites, `scripts/export-cli.ts`, the gate) keep working. The app
 * itself never calls this: it drives `PipelineClient` (`./client.ts`), whose
 * cache survives between runs.
 *
 * The geometry, and why it is ordered as it is, is documented on the stages
 * themselves (`pipeline/stages.ts`) and in the reference notes that file
 * cites; the design ruling behind the split is DECISIONS `[V3.1-P1-1]`.
 *
 * `buildModel()` never throws for a printability problem: a refused engraving,
 * a hanger that does not fit, a wall that came out too thin are all reported
 * through `findings` and `resolvedText`. It does throw for a broken input (a
 * scene with no bounds, a zero radius), because that is a bug in the caller.
 */

import { StageCache, hashString, runPipeline, type PipelineJob, type RunOptions } from "./pipeline";
import type { BuiltRegion } from "./solid/validate";
import type { AuditFinding, EngineInput, EngineResult, RegionMesh } from "./types";

export interface BuildOptions {
  /**
   * Called with the finished region solids while they are still alive.
   *
   * The seam the interpenetration test measures through. The regions overlap
   * each other by `PART_OVERLAP_MM` on purpose, and the test's job is to check
   * that the overlap is the DELIBERATE one and that the union of the regions is
   * still exactly `merged` - which has to be asked of the solids, not of the
   * meshes: a `RegionMesh` is a rounded rendering of a solid manifold3d built
   * in double, so re-importing one moves every seam by a rounding step. Nothing
   * but a test should use this: the handles are freed as soon as `buildModel`
   * returns.
   */
  onSolids?: (regions: readonly BuiltRegion[]) => void;
  /** Run with the strict-claims proxy (tests): an undeclared parameter read throws. */
  strictClaims?: boolean;
  signal?: AbortSignal;
}

let seedCounter = 0;

/** The job a one-shot `buildModel` call runs: a finished scene, every stage through the audit. */
export function jobForInput(input: EngineInput, sceneKey?: string): PipelineJob {
  seedCounter += 1;
  return {
    // A fresh cache can never hit, so the seed key only has to be unique; a
    // caller running a warm cache (`PipelineClient`) hashes the scene itself.
    source: { kind: "scene", scene: input.scene, key: sceneKey ?? `one-shot:${seedCounter}` },
    params: input.params,
    // A grid handed straight to the engine is authoritative, whatever
    // `terrain.enabled` says: that is what every direct caller means by it.
    terrain: input.terrain === undefined || input.terrain === null ? null : { grid: input.terrain, gate: "always" },
    heroIds: input.heroIds ?? null,
    date: input.date ?? new Date().toISOString().slice(0, 10),
    rotationDeg: input.rotationDeg ?? 0,
    mode: "full",
    exportRequest: null,
    known: {},
    knownSceneHash: null,
  };
}

/** A stable key for a scene object, for callers that run a warm cache with a provided scene. */
export function sceneKeyOf(scene: EngineInput["scene"]): string {
  return hashString(JSON.stringify(scene));
}

/**
 * Build every region for one scene: every stage, fresh cache, one result.
 */
export async function buildModel(input: EngineInput, options: BuildOptions = {}): Promise<EngineResult> {
  const cache = new StageCache();
  try {
    const runOptions: RunOptions = {
      ...(options.onSolids === undefined ? {} : { onSolids: options.onSolids }),
      ...(options.strictClaims === undefined ? {} : { strictClaims: options.strictClaims }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const outcome = await runPipeline(jobForInput(input), cache, () => undefined, runOptions);
    if (outcome.status === "error" && outcome.error !== undefined) {
      throw new Error(`${outcome.error.stage}: ${outcome.error.message}`);
    }
    if (outcome.status === "cancelled") {
      throw new Error(`buildModel was cancelled at ${outcome.atStage ?? "an unknown stage"}`);
    }
    if (outcome.result === null) throw new Error("buildModel produced no result");
    return outcome.result;
  } finally {
    cache.dispose();
  }
}

/** Findings a caller can show without running a build. Re-exported for the UI. */
export type { AuditFinding, EngineResult, RegionMesh };
