/**
 * The store's half of the pipeline: what a write schedules, what a run in
 * flight does to the one before it, what survives a cancel, and what an export
 * is allowed to do.
 *
 * A separate file from `store/editor.test.ts` because it `vi.mock`s
 * `lib/engine/client`: every run here is driven event by event from the test,
 * so the assertions are about the STORE's rules -- the debounce, the
 * supersede, the region bookkeeping, the ETA, the export reuse -- and not
 * about how long manifold takes. `store/editor.test.ts` covers the same paths
 * end to end through the real inline transport.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPrintParams } from "@/lib/contracts";
import type { SceneGraph, SceneRequest } from "@/lib/contracts";
import type { EngineResult, RegionMesh } from "@/lib/engine/types";

// ---------------------------------------------------------------------------
// The fake worker
// ---------------------------------------------------------------------------

const harness = vi.hoisted(() => {
  class EngineClientError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "EngineClientError";
      this.code = code;
    }
  }

  class PipelineStageError extends Error {
    readonly stage: string;
    readonly detail: unknown;
    constructor(stage: string, message: string, detail?: unknown) {
      super(message);
      this.name = "PipelineStageError";
      this.stage = stage;
      this.detail = detail;
    }
  }

  type Listener = (value: never) => void;

  class Subject {
    private readonly listeners = new Set<Listener>();
    subscribe(listener: Listener): () => void {
      this.listeners.add(listener);
      return () => void this.listeners.delete(listener);
    }
    next(value: unknown): void {
      for (const listener of [...this.listeners]) (listener as (v: unknown) => void)(value);
    }
  }

  interface FakeRun {
    id: number;
    input: Record<string, unknown>;
    cancelled: boolean;
    progress: Subject;
    regions: Subject;
    scene: Subject;
    handle: Record<string, unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }

  class FakePipelineClient {
    runs: FakeRun[] = [];
    exports: Array<Record<string, unknown>> = [];
    exportOut: unknown = null;
    private nextId = 0;

    reset(): void {
      // Leave no unsettled promise behind: an un-awaited rejection from a
      // previous test would surface as an unhandled rejection in the next.
      for (const run of this.runs) run.reject(new EngineClientError("cancelled", "test reset"));
      this.runs = [];
      this.exports = [];
      this.exportOut = null;
      this.exportBlocking = null;
    }

    /** The run the store is currently driving. */
    get current(): FakeRun {
      const run = this.runs[this.runs.length - 1];
      if (run === undefined) throw new Error("no run has been started");
      return run;
    }

    run(input: Record<string, unknown>): Record<string, unknown> {
      // Single flight, exactly as the real client: a new run rejects the one
      // before it and the worker stops that one at its next stage boundary.
      const previous = this.runs[this.runs.length - 1];
      if (previous !== undefined && !previous.cancelled) {
        previous.cancelled = true;
        previous.reject(new EngineClientError("cancelled", "a newer request superseded this run"));
      }
      this.nextId += 1;
      const id = this.nextId;
      const progress = new Subject();
      const regions = new Subject();
      const scene = new Subject();
      let resolve!: (value: unknown) => void;
      let reject!: (error: unknown) => void;
      const done = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      done.catch(() => undefined);
      const entry: FakeRun = {
        id,
        input,
        cancelled: false,
        progress,
        regions,
        scene,
        resolve,
        reject,
        handle: {
          id,
          progress,
          regions,
          scene,
          done,
          cancel: () => {
            if (entry.cancelled) return;
            entry.cancelled = true;
            entry.reject(new EngineClientError("cancelled", "the run was cancelled"));
          },
        },
      };
      this.runs.push(entry);
      return entry.handle;
    }

    /** Set to refuse the next export the way the printability gate does. */
    exportBlocking: unknown[] | null = null;

    exportFiles(request: Record<string, unknown>): Promise<unknown> {
      this.exports.push(request);
      if (this.exportBlocking !== null) {
        return Promise.reject(
          new PipelineStageError("export", "export refused: the printability gate failed a check", {
            blocking: this.exportBlocking,
          }),
        );
      }
      if (this.exportOut === null) {
        return Promise.reject(new PipelineStageError("export", "nothing to export"));
      }
      return Promise.resolve(this.exportOut);
    }
  }

  return { EngineClientError, PipelineStageError, client: new FakePipelineClient() };
});

vi.mock("@/lib/engine/client", () => ({
  createPipelineClient: () => harness.client,
  EngineClientError: harness.EngineClientError,
  PipelineStageError: harness.PipelineStageError,
}));

const fetchTerrainGridMock = vi.fn().mockResolvedValue(null);
vi.mock("@/lib/engine/terrain/tiles", () => ({
  fetchTerrainGrid: (...args: unknown[]) => fetchTerrainGridMock(...args),
}));

import {
  ETA_MIN_STAGES,
  INITIAL_LOCATION,
  IDLE_PLACE_DETECT,
  PIPELINE_DEBOUNCE_MS,
  initialPipelineState,
  locationToRequest,
  useEditorStore,
} from "./editor";
import { initialExportState } from "@/lib/exportFlow";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REQUEST: SceneRequest = locationToRequest(INITIAL_LOCATION);

function fixtureScene(): SceneGraph {
  return {
    bounds: { min_x: -900, min_y: -900, max_x: 900, max_y: 900 },
    center: { lat: 41.8827, lon: -87.6233 },
    buildings: Array.from({ length: 40 }, (_, i) => ({
      id: `w${i}`,
      ring: [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ] as Array<[number, number]>,
      holes: [],
      height_m: 12,
      height_source: "tag" as const,
      min_height_m: 0,
      is_tall: false,
    })),
    roads: [],
    water: [],
    green: [],
    trees: [],
    stats: { building_count: 40, coverage: "good", height_tag_ratio: 0.5 },
  };
}

function mesh(region: string, marker = 0): RegionMesh {
  return {
    region: region as RegionMesh["region"],
    positions: new Float64Array([marker, 0, 0, 10, 0, 0, 10, 10, 0]),
    indices: new Uint32Array([0, 1, 2]),
    volumeMm3: 100,
    bbox: { min: [0, 0, 0], max: [10, 10, 1] },
    bodies: 1,
    slot: 1,
    colorHex: "#D8D3C6",
  };
}

function fakeResult(regions: string[]): EngineResult {
  return {
    // The `done` result carries the regions STRIPPED: the positions were
    // streamed, and the store is what puts the two halves back together.
    regions: regions.map((name) => ({ ...mesh(name), positions: new Float64Array(0), indices: new Uint32Array(0) })),
    merged: mesh("base"),
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
      elapsedMs: 5,
    },
    findings: [],
    resolvedText: [],
    params: defaultPrintParams(),
  };
}

/** Put the store where a Preview has already succeeded, with nothing in flight. */
function previewed(): void {
  useEditorStore.setState({
    location: { ...INITIAL_LOCATION },
    params: defaultPrintParams(),
    scene: {
      status: "ready",
      graph: fixtureScene(),
      message: null,
      request: REQUEST,
      hash: "scene-hash-1",
      stale: false,
    },
    pipeline: {
      ...initialPipelineState,
      status: "ready",
      result: fakeResult(["base", "buildings"]),
      regions: new Map([
        ["base", mesh("base")],
        ["buildings", mesh("buildings")],
      ]),
      regionHashes: { base: "k-base-1", buildings: "k-buildings-1" },
    },
    exportState: { ...initialExportState },
    placeDetect: { ...IDLE_PLACE_DETECT },
  });
}

/** Report one finished stage on the run the store is driving. */
function reportStage(stage: string, index: number, total: number, elapsedMs: number): void {
  const run = harness.client.current;
  run.progress.next({ kind: "stage", stage, phase: "geometry", index, total, state: "start", elapsedMs: 0 });
  run.progress.next({ kind: "stage", stage, phase: "geometry", index, total, state: "done", elapsedMs });
}

function streamRegions(regions: string[], hashes: Record<string, string>, marker = 0, removed: string[] = []): void {
  harness.client.current.regions.next({
    regions: regions.map((name) => mesh(name, marker)),
    removed,
    hashes,
  });
}

function finishRun(regions: string[], hashes: Record<string, string>, marker = 0): void {
  streamRegions(regions, hashes, marker);
  harness.client.current.resolve({
    result: fakeResult(regions),
    regionHashes: hashes,
    scene: null,
    elapsedMs: 10,
    mergedHash: "merged-1",
    tilesHash: null,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  harness.client.reset();
  fetchTerrainGridMock.mockClear();
  useEditorStore.setState({
    location: { ...INITIAL_LOCATION },
    params: defaultPrintParams(),
    scene: { status: "idle", graph: null, message: null, request: null, hash: null, stale: false },
    pipeline: { ...initialPipelineState },
    exportState: { ...initialExportState },
    placeDetect: { ...IDLE_PLACE_DETECT },
  });
});

afterEach(() => {
  useEditorStore.getState().cancelPipeline();
  harness.client.reset();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe("what a write schedules", () => {
  it("coalesces a burst of PrintParams writes into ONE run, after the debounce", async () => {
    previewed();
    const store = useEditorStore.getState();
    store.setParam("plate_mm", 200);
    store.setParam("plate_mm", 210);
    store.setNested("frame_style", { profile: "chamfer" });
    // Nothing yet: the run is debounced, not synchronous with the write.
    expect(harness.client.runs).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS - 1);
    expect(harness.client.runs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.client.runs).toHaveLength(1);
    // The run carries the LAST values, not the first.
    expect((harness.client.current.input.params as { plate_mm: number }).plate_mm).toBe(210);
  });

  it("runs against the request the last Preview fetched, and re-sends neither the scene nor an unchanged region", async () => {
    previewed();
    useEditorStore.getState().setParam("plate_mm", 200);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    const input = harness.client.current.input;
    expect(input.source).toEqual({ kind: "request", request: REQUEST });
    expect(input.knownSceneHash).toBe("scene-hash-1");
    expect(input.known).toEqual({ base: "k-base-1", buildings: "k-buildings-1" });
    // The worker resolves `hero_auto` itself, so the page sends no hero list.
    expect(input.heroIds).toBeNull();
    expect(input.mode).toBe("full");
  });

  it("a heights write takes the same path: a run, the same fetch key, and no network of its own", async () => {
    previewed();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      useEditorStore.getState().setNested("heights", { floor_height_m: 3.5 });
      await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
      expect(harness.client.runs).toHaveLength(1);
      // The SAME request: `fetch` is served from the stage cache and only
      // `normalise` (which claims `heights.*`) re-runs.
      expect(harness.client.current.input.source).toEqual({ kind: "request", request: REQUEST });
      expect((harness.client.current.input.params as { heights?: { floor_height_m?: number } }).heights?.floor_height_m).toBe(3.5);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a location write marks the scene stale and starts nothing: Preview is the user's move", async () => {
    previewed();
    useEditorStore.getState().setPin(48.8584, 2.2945);
    useEditorStore.getState().setRadius(1200);
    useEditorStore.getState().setRotation(30);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.client.runs).toHaveLength(0);
    expect(useEditorStore.getState().scene.stale).toBe(true);
    // ...and the model already on screen is marked as behind them.
    expect(useEditorStore.getState().pipeline.stale).toBe(true);
    expect(useEditorStore.getState().pipeline.result).not.toBeNull();
  });

  it("a PrintParams write with nothing previewed yet starts nothing at all", async () => {
    useEditorStore.getState().setParam("plate_mm", 200);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.client.runs).toHaveLength(0);
    expect(useEditorStore.getState().pipeline.status).toBe("idle");
  });
});

describe("supersede and cancel", () => {
  it("a newer write supersedes the run in flight without touching what is on screen", async () => {
    previewed();
    const first = useEditorStore.getState().pipeline.result;
    useEditorStore.getState().setParam("plate_mm", 200);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    reportStage("context", 0, 10, 4);
    expect(useEditorStore.getState().pipeline.status).toBe("running");

    useEditorStore.getState().setParam("plate_mm", 210);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    expect(harness.client.runs).toHaveLength(2);
    expect(harness.client.runs[0].cancelled).toBe(true);

    // The superseded run's rejection must not take the successor's state with
    // it: still running, still showing the last good model.
    await vi.advanceTimersByTimeAsync(0);
    const state = useEditorStore.getState();
    expect(state.pipeline.status).toBe("running");
    expect(state.pipeline.result).toBe(first);
    expect(state.pipeline.regions.size).toBe(2);
  });

  it("cancelPipeline leaves the last good model on screen and is not an error", async () => {
    previewed();
    const good = useEditorStore.getState().pipeline.result;
    const goodRegions = useEditorStore.getState().pipeline.regions;
    useEditorStore.getState().setParam("plate_mm", 200);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    reportStage("context", 0, 10, 4);

    useEditorStore.getState().cancelPipeline();
    await vi.advanceTimersByTimeAsync(0);

    const state = useEditorStore.getState();
    expect(state.pipeline.status).toBe("ready");
    expect(state.pipeline.error).toBeNull();
    expect(state.pipeline.stale).toBe(true);
    expect(state.pipeline.result).toBe(good);
    expect(state.pipeline.regions).toBe(goodRegions);
  });

  it("a cancel that arrives after regions were streamed keeps those regions AND their hashes", async () => {
    previewed();
    useEditorStore.getState().setParam("plate_mm", 200);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    const replaced = mesh("base", 7);
    harness.client.current.regions.next({
      regions: [replaced],
      removed: [],
      hashes: { base: "k-base-mid" },
    });

    useEditorStore.getState().cancelPipeline();
    await vi.advanceTimersByTimeAsync(0);

    const pipeline = useEditorStore.getState().pipeline;
    // Each mesh arrives WITH its finish key, so the map is hash-complete even
    // though this run never reached `done`. The next run is told the truth
    // about the newer base rather than about the one it replaced -- which is
    // how a reverted parameter used to leave a mesh nobody asked for on the
    // plate.
    expect(pipeline.regions.get("base")).toBe(replaced);
    expect(pipeline.regionHashes).toEqual({ base: "k-base-mid", buildings: "k-buildings-1" });

    useEditorStore.getState().setParam("plate_mm", 210);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    expect(harness.client.current.input.known).toEqual({
      base: "k-base-mid",
      buildings: "k-buildings-1",
    });
  });

  it("cancelPipeline also drops a run that has not started yet", async () => {
    previewed();
    useEditorStore.getState().setParam("plate_mm", 200);
    useEditorStore.getState().cancelPipeline();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.client.runs).toHaveLength(0);
  });
});

describe("progress and the ETA", () => {
  it("is null until three stages have reported, then sums the previous run's cost for the stages still ahead", async () => {
    previewed();
    // A first run that times every stage of a five-stage plan.
    useEditorStore.getState().setParam("plate_mm", 200);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    const plan = ["context", "buildings", "lettering", "base", "frame"];
    harness.client.current.progress.next({ kind: "plan", total: plan.length, stages: plan });
    const costs = [10, 100, 20, 400, 50];
    plan.forEach((stage, index) => reportStage(stage, index, plan.length, costs[index]));
    finishRun(["base", "buildings"], { base: "k-base-2", buildings: "k-buildings-2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(useEditorStore.getState().pipeline.lastRunStageMs).toEqual({
      context: 10,
      buildings: 100,
      lettering: 20,
      base: 400,
      frame: 50,
    });

    // A second run over the same plan.
    useEditorStore.getState().setParam("plate_mm", 210);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    harness.client.current.progress.next({ kind: "plan", total: plan.length, stages: plan });
    expect(useEditorStore.getState().pipeline.progress.total).toBe(plan.length);

    reportStage("context", 0, plan.length, 11);
    expect(useEditorStore.getState().pipeline.progress.etaMs).toBeNull();
    reportStage("buildings", 1, plan.length, 105);
    expect(useEditorStore.getState().pipeline.progress.etaMs).toBeNull();

    // The third: now there is enough of the run to say something.
    expect(ETA_MIN_STAGES).toBe(3);
    reportStage("lettering", 2, plan.length, 21);
    const progress = useEditorStore.getState().pipeline.progress;
    // `base` + `frame`, from the previous run.
    expect(progress.etaMs).toBe(450);
    expect(progress.stage).toBe("lettering");
    expect(progress.index).toBe(2);
    // Elapsed is this run's own reported cost so far, not a wall clock.
    expect(progress.elapsedMs).toBe(11 + 105 + 21);
  });

  it("stays null on the very first run, when no stage has ever been timed", async () => {
    previewed();
    useEditorStore.setState((state) => ({ pipeline: { ...state.pipeline, lastRunStageMs: {} } }));
    useEditorStore.getState().setParam("plate_mm", 200);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    const plan = ["context", "buildings", "lettering", "base"];
    harness.client.current.progress.next({ kind: "plan", total: plan.length, stages: plan });
    plan.slice(0, 3).forEach((stage, index) => reportStage(stage, index, plan.length, 10));
    expect(useEditorStore.getState().pipeline.progress.etaMs).toBeNull();
  });

  it("names the stage that is RUNNING, so the viewport overlay can say what is being built", async () => {
    previewed();
    useEditorStore.getState().setParam("plate_mm", 200);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    harness.client.current.progress.next({
      kind: "stage",
      stage: "surface-roads",
      phase: "geometry",
      index: 13,
      total: 71,
      state: "start",
      elapsedMs: 0,
    });
    const progress = useEditorStore.getState().pipeline.progress;
    expect(progress.stage).toBe("surface-roads");
    expect(progress.index).toBe(13);
    expect(progress.total).toBe(71);
    expect(progress.phase).toBe("geometry");
  });

  it("does not time a cached stage, so a warm run cannot estimate a real one at nothing", async () => {
    previewed();
    useEditorStore.setState((state) => ({ pipeline: { ...state.pipeline, lastRunStageMs: { base: 400 } } }));
    useEditorStore.getState().setParam("plate_mm", 200);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    harness.client.current.progress.next({
      kind: "stage",
      stage: "base",
      phase: "geometry",
      index: 0,
      total: 2,
      state: "cached",
      elapsedMs: 0,
    });
    finishRun(["base"], { base: "k-base-2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(useEditorStore.getState().pipeline.lastRunStageMs.base).toBe(400);
  });
});

describe("the finished run", () => {
  it("re-attaches the streamed positions to the stripped result and adopts the worker's hashes", async () => {
    previewed();
    useEditorStore.getState().setParam("plate_mm", 200);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    finishRun(["base", "buildings"], { base: "k-base-2", buildings: "k-buildings-2" }, 3);
    await vi.advanceTimersByTimeAsync(0);

    const pipeline = useEditorStore.getState().pipeline;
    expect(pipeline.status).toBe("ready");
    expect(pipeline.stale).toBe(false);
    for (const region of pipeline.result?.regions ?? []) {
      expect(region.positions.length, region.region).toBe(9);
    }
    expect(pipeline.result?.regions[0].positions[0]).toBe(3);
    expect(pipeline.regionHashes).toEqual({ base: "k-base-2", buildings: "k-buildings-2" });
  });

  it("keeps each region's mesh object stable, so only a changed region re-uploads", async () => {
    previewed();
    const before = useEditorStore.getState().pipeline.regions.get("buildings");
    useEditorStore.getState().setParam("plate_mm", 200);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    // Only the base came back: the worker recognised `buildings` from `known`.
    streamRegions(["base"], { base: "k-base-2" }, 5);
    const after = useEditorStore.getState().pipeline;
    expect(after.regions.get("buildings")).toBe(before);
    expect(after.regions.get("base")?.positions[0]).toBe(5);
    // The unchanged region keeps the hash it already had.
    expect(after.regionHashes).toEqual({ base: "k-base-2", buildings: "k-buildings-1" });
  });

  it("forgets a hash it was not given rather than keeping a stale one", async () => {
    previewed();
    useEditorStore.getState().setParam("plate_mm", 200);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    // An older message shape, or a region the worker sent without its key.
    harness.client.current.regions.next({ regions: [mesh("base", 9)], removed: [], hashes: {} });
    const pipeline = useEditorStore.getState().pipeline;
    expect(pipeline.regions.get("base")?.positions[0]).toBe(9);
    expect(pipeline.regionHashes).toEqual({ buildings: "k-buildings-1" });
  });

  it("drops every region the worker says the model lost, including ones it was never told we hold", async () => {
    previewed();
    // `removed` is a SUPERSET of `known`: a region streamed by a superseded
    // run is unknown to the worker's copy of our map, so the only complete
    // answer is every name whose finish output is gone.
    useEditorStore.getState().setParam("trees", false);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    harness.client.current.regions.next({
      regions: [],
      removed: ["buildings", "parks", "rail"],
      hashes: {},
    });
    const pipeline = useEditorStore.getState().pipeline;
    expect([...pipeline.regions.keys()]).toEqual(["base"]);
    expect(pipeline.regionHashes).toEqual({ base: "k-base-1" });
  });

  it("leaves the merged mesh and the tiles the client handed it alone", async () => {
    // The worker sends `merged` and `tiles` whole, or strips them as unchanged
    // and `PipelineClient` re-attaches the ones it kept. Re-attaching the
    // streamed positions is for the REGIONS only; touching the other two here
    // would undo that.
    previewed();
    useEditorStore.getState().setParam("plate_mm", 200);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    const posted = fakeResult(["base"]);
    const merged = posted.merged;
    streamRegions(["base"], { base: "k-base-2" }, 4);
    harness.client.current.resolve({
      result: posted,
      regionHashes: { base: "k-base-2" },
      scene: null,
      elapsedMs: 10,
      mergedHash: "merged-2",
      tilesHash: null,
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = useEditorStore.getState().pipeline.result;
    expect(result?.merged).toBe(merged);
    expect(result?.merged.positions.length).toBe(9);
    // ...and the regions really were re-attached from the stream.
    expect(result?.regions[0].positions[0]).toBe(4);
  });

  it("adopts a re-normalised scene without re-previewing", async () => {
    previewed();
    const fresh = fixtureScene();
    useEditorStore.getState().setNested("heights", { floor_height_m: 3.5 });
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    harness.client.current.scene.next({ scene: fresh, hash: "scene-hash-2", fromCache: false });
    const scene = useEditorStore.getState().scene;
    expect(scene.graph).toBe(fresh);
    expect(scene.hash).toBe("scene-hash-2");
    expect(scene.stale).toBe(false);
  });

  it("keeps the scene stale when the pin moved on while the run was out", async () => {
    previewed();
    useEditorStore.getState().setParam("plate_mm", 200);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    useEditorStore.getState().setPin(48.8584, 2.2945);
    harness.client.current.scene.next({ scene: fixtureScene(), hash: "scene-hash-2", fromCache: true });
    expect(useEditorStore.getState().scene.stale).toBe(true);
  });
});

describe("a stage that fails", () => {
  it("lands as the stage, the message and the worker's own detail, never swallowed", async () => {
    previewed();
    useEditorStore.getState().setParam("plate_mm", 200);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    harness.client.current.reject(
      new harness.PipelineStageError("surface-roads", "the road layer is not manifold", { bodies: 3 }),
    );
    await vi.advanceTimersByTimeAsync(0);

    const pipeline = useEditorStore.getState().pipeline;
    expect(pipeline.status).toBe("error");
    expect(pipeline.error?.stage).toBe("surface-roads");
    expect(pipeline.error?.message).toBe("the road layer is not manifold");
    expect(pipeline.error?.detail).toContain('"bodies":3');
    // The last good model is still on screen.
    expect(pipeline.result).not.toBeNull();
    expect(pipeline.regions.size).toBe(2);
  });

  it("reports an Overpass failure on the SCENE, where the user asked for it", async () => {
    previewed();
    useEditorStore.getState().setParam("plate_mm", 200);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    harness.client.current.reject(
      new harness.PipelineStageError("fetch", "every mirror refused", {
        overpass: { kind: "network", message: "every mirror refused", mirrorsTried: ["a", "b"] },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    const state = useEditorStore.getState();
    expect(state.scene.status).toBe("error");
    expect(state.scene.message).toContain("every mirror refused");
    expect(state.scene.message).toContain("tried a, b");
    // Not ALSO a red pipeline error: one failure, reported once.
    expect(state.pipeline.status).toBe("ready");
    expect(state.pipeline.error).toBeNull();
  });
});

describe("Export", () => {
  beforeEach(() => {
    harness.client.exportOut = {
      target: "stl",
      files: [{ name: "framecraft.stl", mime: "model/stl", bytes: new Uint8Array([1, 2, 3]) }],
      sidecar: { export_target: "stl" },
      sidecarName: "framecraft.json",
      notes: [],
      plan: null,
    };
  });

  it("reuses a finished run: no second build, one export job", async () => {
    previewed();
    const built = useEditorStore.getState().pipeline.result;
    await useEditorStore.getState().requestExport();
    expect(harness.client.runs).toHaveLength(0);
    expect(harness.client.exports).toHaveLength(1);
    expect(useEditorStore.getState().pipeline.result).toBe(built);
    expect(useEditorStore.getState().exportState.phase).toBe("done");
    expect(useEditorStore.getState().exportState.target).toBe("stl");
    // The stem is the page's, sanitised; the target is the worker's answer.
    expect(harness.client.exports[0].stem).toBe("framecraft");
    expect(harness.client.exports[0].target).toBeUndefined();
  });

  it("waits for the run already in flight instead of starting a second one", async () => {
    previewed();
    useEditorStore.getState().setParam("plate_mm", 200);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    expect(harness.client.runs).toHaveLength(1);

    const exporting = useEditorStore.getState().requestExport();
    await vi.advanceTimersByTimeAsync(0);
    // Nothing has been asked for yet: the export is waiting on the model.
    expect(harness.client.exports).toHaveLength(0);
    expect(harness.client.runs).toHaveLength(1);

    finishRun(["base"], { base: "k-base-2" });
    await exporting;
    expect(harness.client.runs).toHaveLength(1);
    expect(harness.client.exports).toHaveLength(1);
    expect(useEditorStore.getState().exportState.phase).toBe("done");
  });

  it("supersedes a run that a pending write has already made out of date", async () => {
    previewed();
    useEditorStore.getState().setParam("plate_mm", 200);
    await vi.advanceTimersByTimeAsync(PIPELINE_DEBOUNCE_MS);
    // A newer write, still inside its debounce, so what is in flight was
    // started for parameters the user has already moved past.
    useEditorStore.getState().setParam("plate_mm", 210);
    const exporting = useEditorStore.getState().requestExport();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.client.runs).toHaveLength(2);
    expect((harness.client.current.input.params as { plate_mm: number }).plate_mm).toBe(210);

    finishRun(["base"], { base: "k-base-2" });
    await exporting;
    expect(harness.client.exports).toHaveLength(1);
  });

  it("reports a failed export instead of offering a file", async () => {
    previewed();
    harness.client.exportOut = null;
    await useEditorStore.getState().requestExport();
    const exportState = useEditorStore.getState().exportState;
    expect(exportState.phase).toBe("failed");
    expect(exportState.error).toBe("nothing to export");
  });

  it("names every check when the printability gate refuses the export", async () => {
    // 04 stage 4: on failure, do not silently ship. The `export` stage runs
    // `export/gate.ts` before the writer and rejects with the Stage 4 findings
    // on `detail.blocking`; the user is looking at a model that LOOKS
    // finished, so the refusal has to say which checks failed.
    previewed();
    harness.client.exportBlocking = [
      { id: "not-manifold", severity: "error", title: "The model is not one solid", detail: "3 bodies." },
      {
        id: "wall-too-thin",
        severity: "error",
        title: "A wall is thinner than the nozzle can print",
        detail: "0.31 mm against 0.80 mm.",
      },
    ];
    await useEditorStore.getState().requestExport();

    const exportState = useEditorStore.getState().exportState;
    expect(exportState.phase).toBe("failed");
    expect(exportState.error).toContain("The model is not one solid");
    expect(exportState.error).toContain("A wall is thinner than the nozzle can print");
    expect(exportState.error).toContain("printability gate");
    // Never a bare stage failure, and never silent.
    expect(exportState.error).not.toBe("");
  });

  it("leaves the last good export alone when a later one is refused", async () => {
    previewed();
    await useEditorStore.getState().requestExport();
    const good = useEditorStore.getState().exportState.files;
    expect(good.length).toBeGreaterThan(0);

    harness.client.exportBlocking = [
      { id: "exceeds-height", severity: "error", title: "The model is too tall to print", detail: "66 mm." },
    ];
    await useEditorStore.getState().requestExport();

    const exportState = useEditorStore.getState().exportState;
    expect(exportState.phase).toBe("failed");
    // The files the previous export produced are still the ones on offer:
    // a refusal reports a problem, it does not take a finished file away.
    expect(exportState.files).toBe(good);
    expect(exportState.target).toBe("stl");
  });

  it("never asks the engine to force a blocked export", async () => {
    // `ExportRequest.force` exists for debugging the engine. A control that
    // could reach it would ship a file the gate refused, which is the one
    // thing 04 stage 4 forbids.
    previewed();
    await useEditorStore.getState().requestExport();
    expect(harness.client.exports).toHaveLength(1);
    expect(harness.client.exports[0]).not.toHaveProperty("force");
    expect(Object.keys(harness.client.exports[0]).sort()).toEqual(["createdIso", "source", "stem"]);
  });
});
