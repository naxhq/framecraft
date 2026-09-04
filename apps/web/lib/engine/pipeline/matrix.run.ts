/**
 * Running one matrix probe: the two builds it compares.
 *
 * A probe is `before` (the default parameters, plus whatever `base` the probe
 * needs so the field has something to act on) and `after` (the same with one
 * leaf written). Both go all the way through the pipeline in `export` mode, so
 * a probe holds the `EngineResult` the preview would draw AND the bytes the
 * export stage wrote, from one run.
 *
 * Both sides share one `StageCache` per group, which is what keeps the file
 * inside its budget: the `after` run re-runs only what the changed leaf
 * invalidates, and `parity.test.ts` is the proof that a warm run and a cold one
 * agree byte for byte. Region meshes are plain typed arrays extracted from the
 * kernel, so the `before` snapshot stays valid after the cache moves on.
 *
 * Not a test file: `matrix.test.ts` imports it.
 */

import { defaultPrintParams, type PrintParams } from "../../contracts";
import type { TerrainGrid } from "../types";
import { StageCache, runPipeline, stableJson, type PipelineJob, type RunOptions } from "./index";
import type { Snapshot } from "./matrix.assert";
import { OSM_FIXTURE_REQUEST, overpassFetchImpl } from "./fixtures/overpassBlock";
import type { ExportRequest } from "./stage";
import { blockScene, bridgeScene, labelledScene, overrideScene, railScene, terrainScene } from "./testScenes";

/**
 * The scenes a probe may ask for. `osm` is the Overpass-shaped fixture: only a
 * run that starts at `fetch` re-normalises, and `heights.*` is read by
 * `normalise` and nowhere else. `override` is the block with an OSM id on its
 * pond and its park, which is what an `object_overrides` row on a water or
 * green polygon needs to have anything to name (v3.1 Task 11).
 */
export type MatrixScene = "block" | "rail" | "bridge" | "terrain" | "osm" | "labelled" | "override";

/** Fixed so nothing in a written file moves because the clock did. */
export const MATRIX_DATE = "2026-09-02";

/**
 * The export request every build carries.
 *
 * No `stem` and no `title`: both are then derived from `city_label`, which is
 * what lets that leaf's probe read its effect out of the file name and the 3MF
 * `Title` metadata.
 *
 * `force` is NOT set here. A handful of probes deliberately drive the model
 * past a Stage 4 row (a doubled `large_scale` past the height ceiling, a 120 mm
 * custom bed under a 180 mm plate) and `export/gate.ts` refuses those files by
 * design; those probes carry `forceExport: true` and say which row they trip.
 * Every other build exports through the gate the product ships, so a change that
 * starts producing a floating island or a wall under the minimum fails the
 * matrix instead of being written and asserted as if nothing happened.
 */
const EXPORT_REQUEST: ExportRequest = {
  createdIso: "2026-09-02T09:00:00.000Z",
  source: { lat: 41.8827, lon: -87.6233 },
};

interface SceneSetup {
  job: Pick<PipelineJob, "source" | "terrain">;
  options: RunOptions;
}

function sceneSetup(scene: MatrixScene): SceneSetup {
  switch (scene) {
    case "block":
      return { job: { source: { kind: "scene", scene: blockScene(), key: "block" }, terrain: null }, options: {} };
    case "rail":
      return { job: { source: { kind: "scene", scene: railScene(), key: "rail" }, terrain: null }, options: {} };
    case "bridge":
      return { job: { source: { kind: "scene", scene: bridgeScene(), key: "bridge" }, terrain: null }, options: {} };
    case "terrain": {
      const hill = terrainScene();
      const grid: TerrainGrid = { ...hill.grid, smoothing: 0 };
      return {
        job: { source: { kind: "scene", scene: hill.scene, key: "terrain" }, terrain: { grid, gate: "param" } },
        options: {},
      };
    }
    case "labelled":
      return { job: { source: { kind: "scene", scene: labelledScene(), key: "labelled" }, terrain: null }, options: {} };
    case "override":
      return { job: { source: { kind: "scene", scene: overrideScene(), key: "override" }, terrain: null }, options: {} };
    case "osm":
      return {
        job: { source: { kind: "request", request: OSM_FIXTURE_REQUEST }, terrain: null },
        options: { overpass: { fetchImpl: overpassFetchImpl(), mirrors: ["https://overpass.example/api/interpreter"] } },
      };
    default: {
      const never: never = scene;
      throw new Error(`unknown matrix scene ${String(never)}`);
    }
  }
}

/**
 * Write one leaf path into a params object, in place.
 *
 * An `[]` segment writes the value into every row of the array, which is how
 * the seven `engravings[].*` probes work: their `base` carries exactly one
 * engraving row, so the write lands on that row.
 */
export function setParamPath(params: PrintParams, path: string, value: unknown): void {
  writeSegments(params as unknown as Record<string, unknown>, path.split("."), value);
}

function writeSegments(node: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  const segment = segments[0];
  const rest = segments.slice(1);
  if (segment.endsWith("[]")) {
    const key = segment.slice(0, -2);
    const list = node[key];
    if (!Array.isArray(list)) throw new Error(`matrix: ${key} is not an array on the probe's base params`);
    if (list.length === 0) throw new Error(`matrix: ${key} is empty, so a ${segments.join(".")} probe has no row to write`);
    for (const item of list as Array<Record<string, unknown>>) writeSegments(item, rest, value);
    return;
  }
  if (rest.length === 0) {
    node[segment] = value;
    return;
  }
  const next = node[segment];
  if (next === undefined || next === null || typeof next !== "object") {
    throw new Error(`matrix: ${segment} is missing on the probe's base params, so ${segments.join(".")} cannot be written`);
  }
  writeSegments(next as Record<string, unknown>, rest, value);
}

/**
 * The default parameters with the probe's `base` merged into them.
 *
 * Nested objects merge key by key, arrays and scalars replace, so a `base` that
 * sets `colour.tint.enabled` keeps the default region colours instead of
 * wiping the whole `colour` group.
 */
export function paramsFor(base: Partial<PrintParams> | undefined): PrintParams {
  const params = defaultPrintParams();
  if (base === undefined) return params;
  return mergeInto(params as unknown as Record<string, unknown>, base as Record<string, unknown>) as unknown as PrintParams;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeInto(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(patch)) {
    const current = target[key];
    target[key] = isPlainObject(value) && isPlainObject(current) ? mergeInto(current, value) : structuredClone(value);
  }
  return target;
}

/** Group key: probes that share it share one `before` build and one cache. */
export function groupKeyOf(scene: MatrixScene, base: Partial<PrintParams> | undefined): string {
  return `${scene} ${base === undefined ? "defaults" : stableJson(base)}`;
}

/** One scene plus one `base`, with its warm cache and its `before` snapshot. */
export class MatrixGroup {
  private constructor(
    private readonly scene: MatrixScene,
    private readonly baseParams: PrintParams,
    private readonly cache: StageCache,
    readonly before: Snapshot,
  ) {}

  /**
   * `force` here is for a group whose BASE already trips a Stage 4 row, which is
   * a fact about the base worth stating at the call site rather than a default.
   */
  static async open(scene: MatrixScene, base: Partial<PrintParams> | undefined, force = false): Promise<MatrixGroup> {
    const cache = new StageCache();
    const baseParams = paramsFor(base);
    try {
      const before = await build(scene, baseParams, cache, force);
      return new MatrixGroup(scene, baseParams, cache, before);
    } catch (error) {
      cache.dispose();
      throw error;
    }
  }

  /**
   * The `after` build: the group's base parameters with one leaf written.
   *
   * `force` is the probe's own `forceExport`, and only a probe that deliberately
   * trips a Stage 4 row sets it.
   */
  async run(path: string, value: unknown, force = false): Promise<Snapshot> {
    const params = structuredClone(this.baseParams);
    setParamPath(params, path, value);
    return build(this.scene, params, this.cache, force);
  }

  /** A build of arbitrary parameters on this group's cache, for a probe that needs one. */
  async runParams(params: PrintParams, force = false): Promise<Snapshot> {
    return build(this.scene, params, this.cache, force);
  }

  dispose(): void {
    this.cache.dispose();
  }
}

async function build(scene: MatrixScene, params: PrintParams, cache: StageCache, force: boolean): Promise<Snapshot> {
  const setup = sceneSetup(scene);
  const job: PipelineJob = {
    ...setup.job,
    params,
    heroIds: null,
    date: MATRIX_DATE,
    rotationDeg: 0,
    mode: "export",
    exportRequest: force ? { ...EXPORT_REQUEST, force: true } : EXPORT_REQUEST,
    known: {},
    knownSceneHash: null,
  };
  const outcome = await runPipeline(job, cache, () => undefined, setup.options);
  if (outcome.status !== "done") {
    throw new Error(`matrix: the ${scene} build ended ${outcome.status} at ${outcome.atStage ?? "?"}: ${outcome.error?.message ?? ""}`);
  }
  if (outcome.result === null || outcome.files === null) {
    throw new Error(`matrix: the ${scene} build produced no ${outcome.result === null ? "result" : "files"}`);
  }
  return {
    result: outcome.result,
    files: outcome.files.files,
    sidecar: outcome.files.sidecar,
    target: outcome.files.target,
    notes: outcome.files.notes,
  };
}
