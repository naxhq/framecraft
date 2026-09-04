/**
 * `runPipeline`: incremental execution of the stage registry over a cache.
 *
 * For each stage in registry order: compute its key from the job (declared
 * params, extras) and the upstream keys; serve the cached output when the key
 * and the input generations match, else run it in its own arena, move the
 * handles its output references into the cache and free the rest. Between
 * stages the runner yields to the event loop and checks the abort flag, so a
 * `cancel` or a superseding `run` message stops the job at the next boundary
 * with every completed output kept (design ruling 7).
 *
 * Events are the worker protocol's, minus the job id (the session adds it):
 * `plan`, `stage`, `scene-ready`, `region-ready`, `phase`, `done`, `files`,
 * `error`, `cancelled`. The same function serves the in-page fallback, the
 * CLI and the tests, which read the returned outcome instead of the events.
 */

import type { PrintParams, SceneGraph, SceneRequest } from "../../contracts";
import { perfRecord, perfSpan } from "../../perf";
import type { OverpassCache, OverpassFetchError } from "../osm/overpass";
import type { EngineSceneGraph } from "../osm/types";
import type { BuildContext } from "../solid/context";
import { Arena, loadManifold, type Deletable, type ManifoldToplevel } from "../solid/manifold";
import type { BuiltRegion } from "../solid/validate";
import type { EngineResult, RegionMesh, TerrainSampler } from "../types";
import { REGION_NAMES } from "../types";
import { StageCache, type StageChannels } from "./cache";
import { UndeclaredParamReadError, isParamView, strictParams } from "./claims";
import { claimsOf } from "./graph";
import { hashBytes, hashParts, hashString, stableJson } from "./hash";
import { expandClaims, readParamPath, type ParamPath, type ParamValue } from "./paths";
import { assembleResult, findingsBeforeAudit, finishedRegions, regionHashes, strippedMesh, strippedTiles } from "./result";
import {
  PHASES,
  isKeyedClaim,
  regionOfStage,
  type ContextOut,
  type ExportOut,
  type ExportRequest,
  type ExtraKey,
  type ExtraValues,
  type FinishOut,
  type NormaliseOut,
  type OutputOf,
  type Phase,
  type StageContext,
  type StageDef,
  type StageId,
  type TerrainGridInput,
  type TerrainOut,
} from "./stage";
import { ExportBlockedError } from "../export/gate";
import { OverpassStageError, PART_EXPOSURE, SCENE_PARTS, STAGES, type ScenePartSpec } from "./stages";

// ---------------------------------------------------------------------------
// Job and events
// ---------------------------------------------------------------------------

/**
 * How far a job runs. `scene` stops after `normalise` (the compat `ingest`);
 * `preview` after the region phase; `full` after the audit; `export` writes
 * the files. A `full` after a `preview` runs only the audit phase, because the
 * region phase is cached; the two-phase delivery, not the mode, is what makes
 * the preview fast (design section 4).
 */
export type RunMode = "scene" | "preview" | "full" | "export";

export type SceneSource =
  | { kind: "request"; request: SceneRequest }
  /**
   * A finished scene: `fetch` is skipped and `normalise` seeded. `key` must
   * change when the scene does. Typed as the frozen contract shape: the
   * engine's `EngineSceneGraph` is a structural superset whose extra layers
   * every reader treats as optional (`osm/types.ts`, `[V3-P2-E1]`).
   */
  | { kind: "scene"; scene: SceneGraph; key: string }
  /**
   * The scene the cache already holds under this `normalise` key (the hash a
   * `scene-ready` event carried): nothing crosses the wire. An unknown key is
   * an error, and the client falls back to sending the scene.
   */
  | { kind: "cached"; key: string };

export interface PipelineJob {
  source: SceneSource;
  params: PrintParams;
  terrain: TerrainGridInput | null;
  /** A caller-resolved hero list; null lets the `heroes` stage resolve it. */
  heroIds: string[] | null;
  /** ISO date for `{date}` and the marks. */
  date: string;
  rotationDeg: number;
  mode: RunMode;
  exportRequest: ExportRequest | null;
  /** `region -> hash` the consumer already holds; those regions are not re-sent. */
  known: Record<string, string>;
  /** The scene hash the consumer already holds; `scene-ready` is not re-sent for it. */
  knownSceneHash: string | null;
  /** The merged mesh hash the consumer already holds; `done` carries the mesh stripped when it is unchanged. */
  knownMergedHash?: string | null;
  /** The tiling hash the consumer already holds; `done` carries the tile meshes stripped when unchanged. */
  knownTilesHash?: string | null;
}

export type StageState = "start" | "done" | "cached" | "skipped";

export interface StageEvent {
  kind: "stage";
  stage: StageId;
  phase: Phase;
  /** Position in this job's plan, 0-based, and the plan's length. */
  index: number;
  total: number;
  state: StageState;
  elapsedMs: number;
}

export type PipelineEvent =
  | { kind: "plan"; total: number; stages: StageId[] }
  | StageEvent
  | { kind: "scene-ready"; scene: EngineSceneGraph; hash: string; fromCache: boolean }
  /** `hashes`: the finish key of every region in `regions`, so a consumer's map is hash-complete before `done`. Optional on the type so an older message shape still types; the runner always sends it. */
  | { kind: "region-ready"; regions: RegionMesh[]; removed: string[]; hashes?: Record<string, string> }
  | { kind: "phase"; phase: Phase; elapsedMs: number }
  /**
   * `mergedHash` and `tilesHash` name what `result.merged` and `result.tiles`
   * carry; when they equal the hashes the job said it knew, the meshes are
   * stripped and the consumer keeps its own copy.
   */
  | {
      kind: "done";
      result: EngineResult | null;
      regionHashes: Record<string, string>;
      elapsedMs: number;
      mergedHash?: string | null;
      tilesHash?: string | null;
    }
  | { kind: "files"; output: ExportOut }
  | { kind: "error"; stage: StageId; message: string; detail?: unknown }
  | { kind: "cancelled"; atStage: StageId };

export type Emit = (event: PipelineEvent, transfer?: Transferable[]) => void;

export interface OverpassOptions {
  cache?: OverpassCache;
  fetchImpl?: typeof fetch;
  mirrors?: readonly string[];
  sleep?: (ms: number) => Promise<void>;
}

export interface RunOptions {
  signal?: AbortSignal;
  /**
   * Wrap the params in the recording proxy: every read is reported on the
   * outcome and an undeclared read throws (`true`) or is collected on
   * `outcome.undeclared` and let through (`"record"`, for claim discovery).
   */
  strictClaims?: boolean | "record";
  /** Test hook: the finished region solids while their handles are alive, at the end of the region phase. */
  onSolids?: (regions: readonly BuiltRegion[]) => void;
  overpass?: OverpassOptions;
  /** Post regions with empty position arrays on `done` (the worker, which streamed them). */
  stripRegionMeshes?: boolean;
  /** Fewest milliseconds between two `region-ready` posts while regions finish. */
  regionBatchMs?: number;
}

export interface StageRecord {
  stage: StageId;
  state: StageState;
  elapsedMs: number;
}

export interface RunOutcome {
  status: "done" | "cancelled" | "error";
  atStage?: StageId;
  error?: { stage: StageId; message: string; detail?: unknown };
  scene: { scene: EngineSceneGraph; hash: string; fromCache: boolean } | null;
  result: EngineResult | null;
  regionHashes: Record<string, string>;
  files: ExportOut | null;
  stages: StageRecord[];
  /** Per stage that ran, the leaves it read (strict-claims mode only). */
  reads: Map<StageId, Set<ParamPath>> | null;
  /** Per stage that ran, the undeclared paths it read (`strictClaims: "record"` only). */
  undeclared: Map<StageId, Set<string>> | null;
  elapsedMs: number;
}

/** Default batching of `region-ready` posts, ms (design ruling 3). */
export const REGION_BATCH_MS = 50;

const MODE_LAST_PHASE: Record<RunMode, Phase> = {
  scene: "scene",
  preview: "region",
  full: "audit",
  export: "export",
};

/** The stages a mode runs, in registry order. */
export function planFor(mode: RunMode): StageDef[] {
  const last = PHASES.indexOf(MODE_LAST_PHASE[mode]);
  return STAGES.filter((stage) => PHASES.indexOf(stage.phase) <= last);
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function extraHash(job: PipelineJob, key: ExtraKey, memo: Map<ExtraKey, string>): string {
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let value: string;
  switch (key) {
    case "scene-request":
      value = job.source.kind === "request" ? stableJson(job.source.request) : `scene:${job.source.key}`;
      break;
    case "terrain-grid": {
      const input = job.terrain;
      if (input === null || input.grid === null) {
        value = "none";
      } else {
        const grid = input.grid;
        const header = stableJson({
          gate: input.gate,
          originEastM: grid.originEastM,
          originNorthM: grid.originNorthM,
          cellM: grid.cellM,
          cols: grid.cols,
          rows: grid.rows,
          rangeM: grid.rangeM,
          source: grid.source,
          smoothing: grid.smoothing ?? null,
        });
        const bytes = new Uint8Array(grid.elevations.buffer, grid.elevations.byteOffset, grid.elevations.byteLength);
        value = `${header}:${hashBytes(bytes)}`;
      }
      break;
    }
    case "hero-ids":
      value = job.heroIds === null ? "none" : stableJson(job.heroIds);
      break;
    case "date":
      value = job.date;
      break;
    case "rotation":
      value = String(job.rotationDeg);
      break;
    case "export-request":
      value = job.exportRequest === null ? "none" : stableJson(job.exportRequest);
      break;
    case "params-echo":
      value = hashString(stableJson(job.params));
      break;
    default: {
      const never: never = key;
      throw new Error(`pipeline: unknown extra ${String(never)}`);
    }
  }
  memo.set(key, value);
  return value;
}

function extraValue<K extends ExtraKey>(job: PipelineJob, key: K): ExtraValues[K] {
  const values: ExtraValues = {
    "scene-request": job.source.kind === "request" ? job.source.request : null,
    "terrain-grid": job.terrain,
    "hero-ids": job.heroIds,
    date: job.date,
    rotation: job.rotationDeg,
    "export-request": job.exportRequest,
    "params-echo": job.params,
  };
  return values[key];
}

/** The `normalise` key of a job that carries a finished scene under `key` (a `scene` source). */
export function seedSceneHash(key: string): string {
  return hashParts(["normalise", "seed", key]);
}

function keyFor(stage: StageDef, job: PipelineJob, cache: StageCache, memo: Map<ExtraKey, string>): string {
  const parts: string[] = [stage.id];
  for (const claim of stage.params) {
    if (isKeyedClaim(claim)) {
      parts.push(`${claim.path}=${claim.label}`, stableJson(claim.key(readParamPath(job.params, claim.path))));
      continue;
    }
    for (const path of expandClaims([claim])) parts.push(path, stableJson(readParamPath(job.params, path)));
  }
  for (const extra of stage.extra ?? []) parts.push(extra, extraHash(job, extra, memo));
  for (const input of stage.inputs) {
    const upstream = cache.get(input);
    if (upstream === undefined) throw new Error(`pipeline: ${stage.id} needs ${input}, which has not run`);
    const part = stage.inputDigests?.[input];
    const named = part === undefined ? undefined : upstream.partDigests.get(part);
    if (part !== undefined && named === undefined) throw new Error(`pipeline: ${stage.id} reads digest ${part} of ${input}, which ${input} does not define`);
    parts.push(input, named ?? upstream.digest);
  }
  return hashParts(parts);
}

/** The ordered key parts of a stage for the job as the cache stands: what a diagnostic prints when a stage re-ran unexpectedly. */
export function keyPartsFor(stage: StageDef, job: PipelineJob, cache: StageCache): string[] {
  const parts: string[] = [];
  for (const claim of stage.params) {
    if (isKeyedClaim(claim)) {
      parts.push(`${claim.path}=${claim.label}:${stableJson(claim.key(readParamPath(job.params, claim.path)))}`);
      continue;
    }
    for (const path of expandClaims([claim])) parts.push(`${path}:${stableJson(readParamPath(job.params, path))}`);
  }
  for (const extra of stage.extra ?? []) parts.push(`${extra}:${extraHash(job, extra, new Map())}`);
  for (const input of stage.inputs) {
    const upstream = cache.get(input);
    const part = stage.inputDigests?.[input];
    parts.push(`${input}${part === undefined ? "" : `#${part}`}:${upstream === undefined ? "?" : (part === undefined ? upstream.digest : upstream.partDigests.get(part)) ?? "?"}`);
  }
  return parts;
}

/** Largest plain-data output that gets a content digest; a scene graph is bigger and always new when it re-runs. */
const DIGEST_LIMIT_CHARS = 256_000;

/**
 * Walks `value` and returns how many characters its JSON would take, at
 * least, or -1 when it holds anything a JSON digest could mistake (a class
 * instance, a function, a WASM handle). Stops counting as soon as `limit`
 * is passed, so a 9 MB Overpass response or a 1.4 MB scene costs a few
 * thousand steps here rather than a full sorted serialisation that
 * `digestOf` would only throw away (116 ms per cold fetch, 20 ms per
 * normalise before this walk existed). The count is a lower bound; the
 * exact length is checked again on the text that is actually hashed.
 */
function plainDataSize(value: unknown, limit: number, depth = 0): number {
  if (depth > 12) return -1;
  if (value === null || value === undefined) return 4;
  const kind = typeof value;
  if (kind === "number") return 1;
  if (kind === "boolean") return 4;
  if (kind === "string") return (value as string).length + 2;
  if (kind !== "object") return -1;
  if (ArrayBuffer.isView(value)) return 48;
  let total = 2;
  if (Array.isArray(value)) {
    for (const item of value) {
      const size = plainDataSize(item, limit, depth + 1);
      if (size < 0) return -1;
      total += size + 1;
      if (total > limit) return total;
    }
    return total;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return -1;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const size = plainDataSize(item, limit, depth + 1);
    if (size < 0) return -1;
    total += key.length + 4 + size;
    if (total > limit) return total;
  }
  return total;
}

/**
 * The digest downstream keys hash for a stage: its output AND its channels
 * (findings, resolved text, mark bands) when the output is plain data, else
 * the key. The channels are part of what a stage said: a lettering line the
 * plate refused leaves no cutter and the same output, but a different refusal
 * text and a different finding, and `audit` and `export` must re-run for it.
 */
function digestOf(key: string, output: unknown, channels: StageChannels, owned: readonly Deletable[]): string {
  if (owned.length > 0) return key;
  const size = plainDataSize(output, DIGEST_LIMIT_CHARS);
  if (size < 0 || size > DIGEST_LIMIT_CHARS) return key;
  const text = stableJson({ output, channels });
  if (text === undefined || text.length > DIGEST_LIMIT_CHARS) return key;
  return hashString(text);
}

/** The named part digests a stage defines over `output`; a null answer resolves to the whole digest. */
function partDigestsFor(stage: StageDef, output: unknown, digest: string): Map<string, string> {
  const partDigests = new Map<string, string>();
  for (const [name, fn] of Object.entries(stage.digests ?? {})) {
    const part = (fn as (value: unknown) => string | null)(output);
    partDigests.set(name, part === null ? digest : hashParts([stage.id, name, part]));
  }
  return partDigests;
}

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

function isDeletable(value: object): value is Deletable {
  // `in` first: a bare property read on an unknown object could be a getter,
  // or a strict-claims proxy that would count the read against a stage.
  if (!("delete" in value) || !("isEmpty" in value)) return false;
  const candidate = value as { delete?: unknown; isEmpty?: unknown };
  return typeof candidate.delete === "function" && typeof candidate.isEmpty === "function";
}

/**
 * Every WASM handle reachable from a stage output. Params views (the strict
 * proxy, `withEngravings`) and the params object itself are never entered: a
 * layout that keeps an engraving record is data, not geometry, and reading
 * through the proxy would count as parameter reads.
 */
export function collectHandles(value: unknown, out: Set<Deletable> = new Set(), depth = 0, skip?: WeakSet<object>): Set<Deletable> {
  if (depth > 8 || value === null || typeof value !== "object") return out;
  if (ArrayBuffer.isView(value) || isParamView(value) || skip?.has(value) === true) return out;
  if (isDeletable(value)) {
    out.add(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectHandles(item, out, depth + 1, skip);
    return out;
  }
  if (value instanceof Map) {
    for (const item of value.values()) collectHandles(item, out, depth + 1, skip);
    return out;
  }
  for (const key of Object.keys(value)) collectHandles((value as Record<string, unknown>)[key], out, depth + 1, skip);
  return out;
}

// ---------------------------------------------------------------------------
// Event loop
// ---------------------------------------------------------------------------

/**
 * Let queued messages run before the next stage. A macrotask, not a microtask:
 * a `cancel` posted to the worker is a message event, which a microtask never
 * yields to. `setImmediate` in Node (referenced, so a CLI run cannot exit
 * mid-job); a `MessageChannel` hop in a browser, which unlike `setTimeout(0)`
 * is not clamped to 4 ms after a few nested turns.
 */
function yieldToEventLoop(): Promise<void> {
  const immediate = (globalThis as { setImmediate?: (fn: () => void) => unknown }).setImmediate;
  if (typeof immediate === "function") return new Promise((resolve) => immediate(resolve));
  if (typeof MessageChannel !== "undefined") {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function now(): number {
  return performance.now();
}

/** Read through a function so control flow never narrows a flag another party flips. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

// ---------------------------------------------------------------------------
// Stage context
// ---------------------------------------------------------------------------

/**
 * `source` with only `allowed` keys readable: the rest are non-enumerable
 * getters that throw with `refused(key)`. What a stage keyed on a named part
 * of an input is handed, so a read outside the part fails the run instead of
 * being served stale after the next change to what the part left out.
 */
function restrictedView<T extends object>(source: T, allowed: ReadonlySet<string>, refused: (key: string) => string): T {
  const view: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (allowed.has(key)) {
      view[key] = (source as Record<string, unknown>)[key];
      continue;
    }
    Object.defineProperty(view, key, {
      enumerable: false,
      get() {
        throw new Error(refused(key));
      },
    });
  }
  return view as T;
}

/**
 * The scene as a stage keyed on `normalise#<part>` is allowed to see it: the
 * part's layers as they are, every other layer a getter that throws and names
 * the stage. A part digest is only honest if the stage reads nothing outside
 * the part, and this is what makes that a broken build rather than a stale
 * cache: a ground stage that started reading `buildings` would be served the
 * old ground after a `heights.*` change, silently, without it. A part that
 * exposes the buildings' identity hands out each building cut down to those
 * fields the same way.
 */
export function scenePartView(scene: EngineSceneGraph, stageId: StageId, part: string): EngineSceneGraph {
  const spec = (SCENE_PARTS as Readonly<Record<string, ScenePartSpec | undefined>>)[part];
  if (spec === undefined) throw new Error(`pipeline: stage ${stageId} keys on normalise#${part}, which names no scene part`);
  const refused = (key: string): string => `pipeline: stage ${stageId} reads scene.${key}, which normalise#${part} does not cover`;
  const allowed = new Set<string>(spec.layers);
  if (spec.buildingFields !== undefined) allowed.add("buildings");
  const view = restrictedView(scene, allowed, refused);
  if (spec.buildingFields !== undefined) {
    const fields = new Set<string>(spec.buildingFields);
    view.buildings = scene.buildings.map((building) =>
      restrictedView(building, fields, (key) => `pipeline: stage ${stageId} reads scene.buildings[].${key}, which normalise#${part} does not cover`),
    );
  }
  return view;
}

/**
 * An upstream output as a stage keyed on `<input>#<part>` is allowed to see
 * it (`stages.PART_EXPOSURE`): the part's keys, the rest throwing. The scene
 * goes through `scenePartView`; a part with no exposure listed is served
 * whole, which the registry says so of.
 */
export function inputPartView<Out>(output: Out, stageId: StageId, input: StageId, part: string): Out {
  if (input === "normalise") return { scene: scenePartView((output as NormaliseOut).scene, stageId, part) } as Out;
  const exposed = PART_EXPOSURE[`${input}#${part}`];
  if (exposed === undefined || output === null || typeof output !== "object") return output;
  return restrictedView(output, new Set(exposed), (key) => `pipeline: stage ${stageId} reads ${input}.${key}, which ${input}#${part} does not cover`);
}

interface ContextParts {
  stage: StageDef;
  job: PipelineJob;
  cache: StageCache;
  /** Null until the first stage past the scene phase: an ingest never loads the kernel. */
  wasm: ManifoldToplevel | null;
  arena: Arena;
  channels: StageChannels;
  reads: Set<ParamPath> | null;
  undeclared: Set<string> | null;
  options: RunOptions;
  startedMs: number;
}

function makeStageContext(parts: ContextParts): StageContext {
  const { stage, job, cache, wasm, arena, channels, reads, undeclared, options, startedMs } = parts;
  const inputs = new Set<StageId>(stage.inputs);
  const extras = new Set<ExtraKey>(stage.extra ?? []);
  const leaves = new Set<ParamPath>(claimsOf(stage.id));
  const params =
    reads === null
      ? job.params
      : strictParams(job.params, {
          stage: stage.id,
          declared: leaves,
          onRead: (path) => {
            reads.add(path);
          },
          ...(undeclared === null
            ? {}
            : {
                onUndeclared: (path: string) => {
                  undeclared.add(path);
                },
              }),
        });
  // The scene is `normalise`'s output and nothing else's: a stage that reads
  // it (through `ctx.scene` or `ctx.build.scene`) must list `normalise` as an
  // input, or a scene change would not reach its key. `context` re-deriving
  // the same numbers from a changed scene is exactly the case the digest rule
  // would otherwise hide.
  const canReadScene = inputs.has("normalise");
  // A stage keyed on a named part of the scene sees that part and nothing
  // else: the layers outside it are behind getters that throw.
  const scenePart = stage.inputDigests?.normalise;
  let build: BuildContext | null = null;
  let sceneView: EngineSceneGraph | null = null;
  // One view per part-keyed input, built on first read.
  const partViews = new Map<StageId, unknown>();

  const readScene = (): EngineSceneGraph => {
    if (!canReadScene) throw new Error(`pipeline: stage ${stage.id} reads the scene without declaring normalise as an input`);
    const entry = cache.get<NormaliseOut>("normalise");
    if (entry === undefined) throw new Error("pipeline: normalise has not run");
    if (scenePart === undefined) return entry.output.scene;
    if (sceneView === null) sceneView = scenePartView(entry.output.scene, stage.id, scenePart);
    return sceneView;
  };

  const buildWith = (terrain: TerrainSampler | null): BuildContext => {
    if (!inputs.has("context")) throw new Error(`pipeline: stage ${stage.id} needs a BuildContext without declaring context`);
    const numbers = cache.get<ContextOut>("context");
    if (numbers === undefined) throw new Error("pipeline: context has not run");
    const attributionBands = inputs.has("attribution") ? cache.get<unknown>("attribution")?.channels.markBands ?? [] : null;
    const built: Omit<BuildContext, "scene"> = {
      wasm: kernel(),
      arena,
      params,
      terrain,
      ...numbers.output,
      findings: channels.findings,
      resolvedText: channels.resolvedText,
      // A stage that consumes the attribution reads its bands; its own channel
      // stays empty so the result never counts a band twice.
      markBands: attributionBands === null ? channels.markBands : [...attributionBands],
    };
    // Read lazily and checked: see `readScene`.
    Object.defineProperty(built, "scene", { enumerable: true, get: () => readScene() });
    return built as BuildContext;
  };

  const kernel = (): ManifoldToplevel => {
    if (wasm === null) throw new Error(`pipeline: stage ${stage.id} used the WASM kernel in the scene phase`);
    return wasm;
  };

  return {
    id: stage.id,
    param<P extends ParamPath>(path: P): ParamValue<P> {
      if (!leaves.has(path)) {
        if (undeclared === null) throw new UndeclaredParamReadError(stage.id, path);
        undeclared.add(path);
      }
      reads?.add(path);
      return readParamPath(job.params, path) as ParamValue<P>;
    },
    extra(key) {
      if (!extras.has(key)) throw new Error(`pipeline: stage ${stage.id} reads extra ${key}, which it does not declare`);
      return extraValue(job, key);
    },
    input<S extends StageId>(id: S): OutputOf<S> {
      if (!inputs.has(id)) throw new Error(`pipeline: stage ${stage.id} reads ${id}, which it does not declare as an input`);
      const entry = cache.get<OutputOf<S>>(id);
      if (entry === undefined) throw new Error(`pipeline: ${stage.id} needs ${id}, which has not run`);
      const part = stage.inputDigests?.[id];
      if (part === undefined) return entry.output;
      let views = partViews.get(id);
      if (views === undefined) {
        views = inputPartView(entry.output, stage.id, id, part);
        partViews.set(id, views);
      }
      return views as OutputOf<S>;
    },
    get wasm() {
      return kernel();
    },
    arena,
    get scene() {
      return readScene();
    },
    params,
    get build() {
      if (build === null) {
        const terrain = inputs.has("terrain") ? (cache.get<TerrainOut>("terrain")?.output.sampler ?? null) : null;
        build = buildWith(terrain);
      }
      return build;
    },
    buildWith,
    channels,
    overpass: { ...options.overpass, signal: options.signal },
    elapsedMs: () => now() - startedMs,
    findingsBefore() {
      if (stage.id !== "audit") throw new Error(`pipeline: only the audit stage reads the findings before it (${stage.id} asked)`);
      return findingsBeforeAudit(cache);
    },
    assembled() {
      if (!inputs.has("audit")) throw new Error(`pipeline: stage ${stage.id} asks for the assembled result without declaring audit`);
      return assembleResult(cache, job.params);
    },
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function copyMesh(mesh: RegionMesh): RegionMesh {
  return {
    ...mesh,
    positions: mesh.positions.slice(),
    indices: mesh.indices.slice(),
    ...(mesh.triangleOwner === undefined ? {} : { triangleOwner: mesh.triangleOwner.slice() }),
  };
}

function errorDetail(error: unknown): unknown {
  if (error instanceof OverpassStageError) return { overpass: error.overpass satisfies OverpassFetchError };
  if (error instanceof ExportBlockedError) return { blocking: error.blocking };
  if (error instanceof UndeclaredParamReadError) return { undeclared: { stage: error.stage, path: error.path } };
  return undefined;
}

export async function runPipeline(
  job: PipelineJob,
  cache: StageCache,
  emit: Emit,
  options: RunOptions = {},
): Promise<RunOutcome> {
  const startedMs = now();
  const plan = planFor(job.mode);
  const records: StageRecord[] = [];
  const strict = options.strictClaims === true || options.strictClaims === "record";
  const reads = strict ? new Map<StageId, Set<ParamPath>>() : null;
  const undeclared = options.strictClaims === "record" ? new Map<StageId, Set<string>>() : null;
  const memo = new Map<ExtraKey, string>();
  const batchMs = options.regionBatchMs ?? REGION_BATCH_MS;
  let scene: RunOutcome["scene"] = null;

  const finish = (partial: Pick<RunOutcome, "status"> & Partial<RunOutcome>): RunOutcome => ({
    status: partial.status,
    ...(partial.atStage === undefined ? {} : { atStage: partial.atStage }),
    ...(partial.error === undefined ? {} : { error: partial.error }),
    scene,
    result: partial.result ?? null,
    regionHashes: regionHashes(cache),
    files: partial.files ?? null,
    stages: records,
    reads,
    undeclared,
    elapsedMs: now() - startedMs,
  });

  // The events that end a run are posted after the `engine.build` span has
  // closed, so the run's own row is on the message that ends it: `worker.ts`
  // drains the perf buffer onto exactly that message, and a span still open
  // there would land one message late and never for a session's last run
  // (v3-01 integration note, `e2e/perf.spec.ts`).
  const trailing: Array<{ event: PipelineEvent; transfer: Transferable[] }> = [];
  const emitLast = (event: PipelineEvent, transfer: Transferable[] = []): void => {
    trailing.push({ event, transfer });
  };

  emit({ kind: "plan", total: plan.length, stages: plan.map((stage) => stage.id) });

  // The kernel is loaded before the first stage past the scene phase, not
  // before the run: an ingest (`scene` mode) never waits for it, and the
  // fetch goes out on the first tick, which is what the store's request
  // coalescing tests measure.
  let wasm: ManifoldToplevel | null = null;

  // Progressive regions: finished meshes are copied out of the cache and posted
  // in batches at most every `batchMs`, and again at the end of the phase.
  // An export job posts files, never regions: the page already holds them.
  const streaming = job.mode !== "export";
  let pending: RegionMesh[] = [];
  let pendingHashes: Record<string, string> = {};
  let lastFlushMs = startedMs;
  const flushRegions = (removed: string[] = []): void => {
    if (pending.length === 0 && removed.length === 0) return;
    const regions = pending;
    const hashes = pendingHashes;
    pending = [];
    pendingHashes = {};
    lastFlushMs = now();
    const transfer: Transferable[] = [];
    for (const region of regions) {
      transfer.push(region.positions.buffer, region.indices.buffer);
      if (region.triangleOwner !== undefined) transfer.push(region.triangleOwner.buffer);
    }
    emit({ kind: "region-ready", regions, removed, hashes }, transfer);
  };
  const noteFinished = (stage: StageDef, key: string): void => {
    if (!streaming || !stage.id.startsWith("finish-")) return;
    const region = regionOfStage(stage.id);
    if (region === null) return;
    const entry = cache.get<FinishOut>(stage.id);
    if (entry === undefined || entry.output === null) return;
    if (job.known[region] === key) return;
    pending.push(copyMesh(entry.output.mesh));
    pendingHashes[region] = key;
    if (now() - lastFlushMs >= batchMs) flushRegions();
  };
  /**
   * Every region the model does not have right now. A superset of what the
   * consumer holds on purpose: a region streamed by a superseded run that
   * never reached `done` is unknown to the consumer's hash map, so the only
   * complete answer is every name whose finish output is null or absent.
   * Deleting a name the consumer does not hold costs nothing.
   */
  const removedRegions = (): string[] =>
    REGION_NAMES.filter((region) => {
      const entry = cache.get<FinishOut>(`finish-${region}`);
      return entry === undefined || entry.output === null;
    });

  const run = async (): Promise<RunOutcome> => {
    let phase: Phase | null = null;
    let phaseStartedMs = startedMs;
    const endPhase = (): void => {
      if (phase === null) return;
      const elapsed = now() - phaseStartedMs;
      perfRecord(`phase.${phase}`, phaseStartedMs, elapsed);
      if (phase === "region") {
        // An export streams nothing, not even the names it lacks.
        if (streaming) flushRegions(removedRegions());
        options.onSolids?.(finishedRegions(cache));
      }
      emit({ kind: "phase", phase, elapsedMs: elapsed });
    };

    for (let index = 0; index < plan.length; index += 1) {
      const stage = plan[index];
      if (index > 0) await yieldToEventLoop();
      if (aborted(options.signal)) {
        // What finished inside the current batch window still reaches the page.
        flushRegions();
        emitLast({ kind: "cancelled", atStage: stage.id });
        return finish({ status: "cancelled", atStage: stage.id });
      }
      if (stage.phase !== phase) {
        endPhase();
        phase = stage.phase;
        phaseStartedMs = now();
      }
      if (wasm === null && stage.phase !== "scene") wasm = await loadManifold();
      const total = plan.length;
      const report = (state: StageState, elapsedMs: number): void => {
        records.push({ stage: stage.id, state, elapsedMs });
        emit({ kind: "stage", stage: stage.id, phase: stage.phase, index, total, state, elapsedMs });
      };

      // A job that carries a finished scene skips the fetch and seeds normalise;
      // one that names a cached scene skips the fetch and must find it.
      if (job.source.kind !== "request" && stage.id === "fetch") {
        report("skipped", 0);
        continue;
      }
      if (job.source.kind === "cached" && stage.id === "normalise") {
        const entry = cache.get<NormaliseOut>("normalise");
        if (entry === undefined || entry.key !== job.source.key) {
          const message = "the scene is no longer cached in the worker; send it again";
          emitLast({ kind: "error", stage: "normalise", message, detail: { sceneNotCached: true } });
          return finish({ status: "error", error: { stage: "normalise", message, detail: { sceneNotCached: true } } });
        }
        report("cached", 0);
        scene = { scene: entry.output.scene, hash: entry.key, fromCache: true };
        if (job.knownSceneHash !== entry.key) emit({ kind: "scene-ready", scene: entry.output.scene, hash: entry.key, fromCache: true });
        continue;
      }
      if (job.source.kind === "scene" && stage.id === "normalise") {
        const key = seedSceneHash(job.source.key);
        const seeded = job.source.scene as EngineSceneGraph;
        if (cache.isValid("normalise", key)) {
          report("cached", 0);
        } else {
          // Seeded with the same part digests a run of the stage would define,
          // so a consumer keyed on `normalise#ground` finds them here too.
          const seededOut: NormaliseOut = { scene: seeded };
          cache.set<NormaliseOut>("normalise", key, new Map(), seededOut, emptyChannels(), [], 0, key, partDigestsFor(stage, seededOut, key));
          report("done", 0);
        }
        scene = { scene: seeded, hash: key, fromCache: true };
        if (job.knownSceneHash !== key) emit({ kind: "scene-ready", scene: seeded, hash: key, fromCache: true });
        continue;
      }

      let key: string;
      try {
        key = keyFor(stage, job, cache, memo);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitLast({ kind: "error", stage: stage.id, message });
        return finish({ status: "error", error: { stage: stage.id, message } });
      }
      if (cache.isValid(stage.id, key)) {
        report("cached", 0);
        if (stage.id === "normalise") {
          const entry = cache.get<NormaliseOut>("normalise");
          if (entry !== undefined) {
            scene = { scene: entry.output.scene, hash: key, fromCache: true };
            if (job.knownSceneHash !== key) emit({ kind: "scene-ready", scene: entry.output.scene, hash: key, fromCache: true });
          }
        }
        noteFinished(stage, key);
        continue;
      }

      report("start", 0);
      const arena = new Arena();
      const channels = emptyChannels();
      const stageReads = reads === null ? null : new Set<ParamPath>();
      if (reads !== null && stageReads !== null) reads.set(stage.id, stageReads);
      const stageUndeclared = undeclared === null ? null : new Set<string>();
      if (undeclared !== null && stageUndeclared !== null) undeclared.set(stage.id, stageUndeclared);
      const ctx = makeStageContext({ stage, job, cache, wasm, arena, channels, reads: stageReads, undeclared: stageUndeclared, options, startedMs });
      const stageStartedMs = now();
      let output: unknown;
      try {
        output = await perfSpan(stage.id, () => stage.run(ctx as never));
      } catch (error) {
        arena.dispose();
        if (aborted(options.signal)) {
          // The abort landed inside the stage (a fetch cut short): that is a
          // cancellation, not a failure.
          flushRegions();
          emitLast({ kind: "cancelled", atStage: stage.id });
          return finish({ status: "cancelled", atStage: stage.id });
        }
        const message = error instanceof Error ? error.message : String(error);
        const detail = errorDetail(error);
        emitLast({ kind: "error", stage: stage.id, message, ...(detail === undefined ? {} : { detail }) });
        return finish({ status: "error", error: { stage: stage.id, message, ...(detail === undefined ? {} : { detail }) } });
      }
      const owned: Deletable[] = [];
      // The generations to pin: only the inputs whose handles this output
      // references can dangle when that input is replaced.
      const inputGens = new Map<StageId, number>();
      for (const handle of collectHandles(output, new Set(), 0, new WeakSet([job.params as object]))) {
        if (arena.has(handle)) {
          owned.push(arena.release(handle));
          continue;
        }
        const owner = cache.ownerOf(handle);
        if (owner !== undefined) inputGens.set(owner.id, owner.gen);
      }
      arena.dispose();
      const digest = digestOf(key, output, channels, owned);
      const partDigests = partDigestsFor(stage, output, digest);
      // Measured after the digests: they are part of what the stage costs.
      const elapsedMs = now() - stageStartedMs;
      cache.set(stage.id, key, inputGens, output, channels, owned, elapsedMs, digest, partDigests);
      report("done", elapsedMs);

      if (stage.id === "normalise") {
        const normalised = output as NormaliseOut;
        const fetched = cache.get<{ fromCache: boolean }>("fetch");
        const fromCache = fetched?.output.fromCache ?? false;
        scene = { scene: normalised.scene, hash: key, fromCache };
        if (job.knownSceneHash !== key) emit({ kind: "scene-ready", scene: normalised.scene, hash: key, fromCache });
      }
      noteFinished(stage, key);
    }
    endPhase();

    // Every mode ends with `done`; a `scene` or `preview` run carries no
    // result, and an export job carries none on the wire either: the page
    // already holds the model, the files are what it asked for.
    const result = job.mode === "full" || job.mode === "export" ? assembleResult(cache, job.params, { stripRegionMeshes: options.stripRegionMeshes }) : null;
    const mergedHash = cache.get("merged")?.key ?? null;
    const tilesHash = cache.get("tiling")?.key ?? null;
    const transfer: Transferable[] = [];
    let posted: EngineResult | null = result;
    if (result !== null && options.stripRegionMeshes === true) {
      if (job.mode === "export") {
        posted = null;
      } else {
        // The merged mesh and the tile meshes cross only when their hash is
        // new to the consumer; copied first so the cache keeps its own.
        const merged = job.knownMergedHash === mergedHash ? strippedMesh(result.merged) : copyMesh(result.merged);
        if (job.knownMergedHash !== mergedHash) transfer.push(merged.positions.buffer, merged.indices.buffer);
        const tiles = result.tiles === undefined ? undefined : job.knownTilesHash === tilesHash ? strippedTiles(result.tiles) : result.tiles;
        posted = { ...result, merged, ...(tiles === undefined ? {} : { tiles }) };
      }
    }
    emitLast({ kind: "done", result: posted, regionHashes: regionHashes(cache), elapsedMs: now() - startedMs, mergedHash, tilesHash }, transfer);
    let files: ExportOut | null = null;
    if (job.mode === "export") {
      const entry = cache.get<ExportOut>("export");
      if (entry !== undefined) {
        files = entry.output;
        // The bytes are transferred, from copies, so the cache keeps its own.
        const copies = files.files.map((file) => ({ ...file, bytes: file.bytes.slice() }));
        emitLast({ kind: "files", output: { ...files, files: copies } }, copies.map((file) => file.bytes.buffer));
      }
    }
    return finish({ status: "done", result, files });
  };

  const outcome = await perfSpan("engine.build", run);
  for (const { event, transfer } of trailing) emit(event, transfer);
  return outcome;
}

function emptyChannels(): StageChannels {
  return { findings: [], resolvedText: [], markBands: [] };
}
