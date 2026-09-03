/**
 * Incremental behaviour, asserted by stage-event lists, never by timing
 * (design section 6). One cache, one small scene, one change at a time: which
 * stages re-ran and which were served from the cache is the whole assertion.
 */
import { afterAll, describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams } from "../../contracts";
import { outstandingWasmObjects } from "../solid/manifold";
import type { TerrainGrid } from "../types";
import { StageCache, runPipeline, stageIds, stagesInvalidatedBy, type ParamPath, type PipelineJob, type RunOutcome, type StageId, type StageState } from "./index";
import { blockScene, terrainScene } from "./testScenes";

const REQUEST = { lat: 41.8827, lon: -87.6233, radius_m: 900.0, rotation_deg: 0.0, preset_id: "chicago-loop" };

function jobFor(params: PrintParams, overrides: Partial<PipelineJob> = {}): PipelineJob {
  return {
    source: { kind: "scene", scene: blockScene(), key: "block" },
    params,
    terrain: null,
    heroIds: null,
    date: "2026-09-02",
    rotationDeg: 0,
    mode: "full",
    exportRequest: null,
    known: {},
    knownSceneHash: null,
    ...overrides,
  };
}

interface Run {
  outcome: RunOutcome;
  states: Map<StageId, StageState>;
  ran: StageId[];
  cached: StageId[];
}

async function run(cache: StageCache, job: PipelineJob, signal?: AbortSignal): Promise<Run> {
  const states = new Map<StageId, StageState>();
  const outcome = await runPipeline(
    job,
    cache,
    (event) => {
      if (event.kind === "stage" && event.state !== "start") states.set(event.stage, event.state);
    },
    signal === undefined ? {} : { signal },
  );
  const ran: StageId[] = [];
  const cached: StageId[] = [];
  for (const [stage, state] of states) {
    if (state === "done") ran.push(stage);
    if (state === "cached") cached.push(stage);
  }
  return { outcome, states, ran, cached };
}

function withText(text: string): PrintParams {
  const params = defaultPrintParams();
  params.engravings = [{ edge: "top", text, mode: "engrave", size_mm: 4 }];
  return params;
}

const GEOMETRY_NOT_TOUCHED_BY_TEXT: readonly StageId[] = [
  "context",
  "terrain",
  "heroes",
  "repair-buildings",
  "surface-water",
  "surface-rail",
  "surface-roads",
  "surface-parks",
  "buildings",
  "bridges",
  "trees",
  "tokens",
  "fonts",
  "attribution",
  "hangers",
  "region-buildings",
  "finish-buildings",
  "region-roads",
  "finish-roads",
  "region-water",
  "finish-water",
  "region-parks",
  "finish-parks",
];

/**
 * Nothing outside the change's downstream ran: every stage the graph does not
 * list under `paths` came from the cache. (A stage the graph DOES list may
 * still be cached when a data-only stage above it re-ran to the same answer,
 * which is the digest rule working; the direct claimants are asserted `done`
 * by each test.)
 */
function expectNothingSpurious(states: Map<StageId, StageState>, paths: ParamPath[]): void {
  const moved = new Set(stagesInvalidatedBy(paths));
  for (const stage of stageIds()) {
    if (stage === "fetch" || stage === "export" || moved.has(stage)) continue;
    expect(states.get(stage), stage).toBe("cached");
  }
}

describe("incremental runs on a warm cache", () => {
  const cache = new StageCache();

  afterAll(() => {
    cache.dispose();
  });

  it("a cold run runs every stage; the same run again runs none", async () => {
    const cold = await run(cache, jobFor(withText("{city}")));
    expect(cold.outcome.status).toBe("done");
    expect(cold.cached).toEqual([]);
    expect(cold.states.get("fetch")).toBe("skipped");
    expect(cold.ran).toContain("audit");
    const warm = await run(cache, jobFor(withText("{city}")));
    expect(warm.outcome.status).toBe("done");
    expect(warm.ran).toEqual([]);
    expect(warm.cached.length).toBe(stageIds().length - 2); // every stage but fetch (skipped) and export (not in a full run)
  }, 60_000);

  it("changing a frame-edge engravings[0].text re-runs the lettering, the frame and the audit phase; the base, its finish and every other region stay cached", async () => {
    const changed = await run(cache, jobFor(withText("{coords}")));
    expect(changed.outcome.status).toBe("done");
    for (const stage of ["lettering", "ornaments", "frame-cutters", "frame", "region-frame", "finish-frame", "assembly", "merged", "measure", "validate", "islands", "tiling", "audit"] as const) {
      expect(changed.states.get(stage), stage).toBe("done");
    }
    for (const stage of GEOMETRY_NOT_TOUCHED_BY_TEXT) expect(changed.states.get(stage), stage).toBe("cached");
    expectNothingSpurious(changed.states, ["engravings[].text"]);
    // The base reads the lettering through its `base` part digest (the
    // underside cutters), which a frame-edge line leaves empty: the plate is
    // not re-carved, so `sit` and every finish but the frame's stay cached.
    for (const stage of ["base", "region-base", "sit", "finish-base", "finish-buildings"] as const) {
      expect(changed.states.get(stage), stage).toBe("cached");
    }
  }, 60_000);

  it("an underside line is a base cutter: adding one re-carves the base and re-finishes it, and still leaves the buildings alone", async () => {
    const params = withText("{coords}");
    params.engravings = [...(params.engravings ?? []), { edge: "underside", text: "{date}", mode: "engrave", size_mm: 3 }];
    const changed = await run(cache, jobFor(params));
    expect(changed.outcome.status).toBe("done");
    for (const stage of ["fonts", "lettering", "base", "region-base", "sit", "finish-base", "assembly", "audit"] as const) {
      expect(changed.states.get(stage), stage).toBe("done");
    }
    expect(changed.states.get("finish-buildings")).toBe("cached");
    expect(changed.states.get("surface-roads")).toBe("cached");
    // Back to the frame-edge line only: the base returns to the state its key names.
    const back = await run(cache, jobFor(withText("{coords}")));
    expect(back.states.get("base")).toBe("done");
    expect(back.states.get("finish-buildings")).toBe("cached");
  }, 90_000);

  it("changing plate_mm re-runs everything after normalise", async () => {
    const changed = await run(cache, jobFor({ ...withText("{coords}"), plate_mm: 200 }));
    expect(changed.outcome.status).toBe("done");
    expect(changed.states.get("normalise")).toBe("cached");
    for (const stage of ["context", "repair-buildings", "surface-roads", "buildings", "lettering", "base", "frame", "finish-base", "assembly", "merged", "audit"] as const) {
      expect(changed.states.get(stage), stage).toBe("done");
    }
    expectNothingSpurious(changed.states, ["plate_mm"]);
    // The stages that do not read the plate, directly or through an input, stayed put.
    expect(changed.states.get("heroes")).toBe("cached");
    expect(changed.states.get("fonts")).toBe("cached");
  }, 60_000);

  it("changing frame_style.profile from plain to chamfer keeps the context (keyed on floating or not) and re-runs the frame family", async () => {
    const base = withText("{coords}");
    base.plate_mm = 200;
    const chamfer: PrintParams = { ...base, frame_style: { ...base.frame_style, profile: "chamfer" } };
    const changed = await run(cache, jobFor(chamfer));
    expect(changed.outcome.status).toBe("done");
    expect(changed.states.get("context")).toBe("cached");
    expect(changed.states.get("repair-buildings")).toBe("cached");
    expect(changed.states.get("surface-roads")).toBe("cached");
    expect(changed.states.get("frame-cutters")).toBe("done");
    expect(changed.states.get("frame")).toBe("done");
    expect(changed.states.get("finish-frame")).toBe("done");
    // Switching to floating moves the crop, so the context and everything under it re-run.
    const floating: PrintParams = { ...base, frame_style: { ...base.frame_style, profile: "floating" } };
    const moved = await run(cache, jobFor(floating));
    expect(moved.states.get("context")).toBe("done");
    expect(moved.states.get("repair-buildings")).toBe("done");
  }, 90_000);

  it("a cancelled run keeps its completed stages: the next run serves them from the cache", async () => {
    const params = { ...withText("{date}"), plate_mm: 220 };
    const controller = new AbortController();
    const seen: StageId[] = [];
    const outcome = await runPipeline(
      jobFor(params),
      cache,
      (event) => {
        if (event.kind === "stage" && event.state === "done") {
          seen.push(event.stage);
          if (event.stage === "surface-roads") controller.abort();
        }
      },
      { signal: controller.signal },
    );
    expect(outcome.status).toBe("cancelled");
    expect(outcome.atStage).toBe("surface-parks");
    expect(seen).toContain("context");
    expect(seen).toContain("surface-roads");
    const resumed = await run(cache, jobFor(params));
    expect(resumed.outcome.status).toBe("done");
    for (const stage of seen) expect(resumed.states.get(stage), stage).toBe("cached");
    expect(resumed.states.get("surface-parks")).toBe("done");
  }, 60_000);
});

/**
 * A synthetic Overpass response in the `out geom` shape the fetcher returns:
 * two buildings 40 m across near the centre, one with no height information
 * at all (so `heights.unknown_default_m` decides it) and one with three
 * storeys and no height (so `heights.floor_height_m` decides it), plus a road.
 * The committed tiny-loop fixture tags every height, which is exactly why a
 * fixture that does not is needed here.
 */
function overpassWithUntaggedHeights(): unknown {
  const square = (lat: number, lon: number, d: number) => [
    { lat: lat - d, lon: lon - d },
    { lat: lat - d, lon: lon + d },
    { lat: lat + d, lon: lon + d },
    { lat: lat + d, lon: lon - d },
    { lat: lat - d, lon: lon - d },
  ];
  return {
    elements: [
      { type: "way", id: 1, tags: { building: "yes" }, geometry: square(41.8829, -87.6233, 0.00018) },
      { type: "way", id: 2, tags: { building: "apartments", "building:levels": "3" }, geometry: square(41.8825, -87.6233, 0.00018) },
      {
        type: "way",
        id: 3,
        tags: { highway: "residential" },
        geometry: [
          { lat: 41.8827, lon: -87.6245 },
          { lat: 41.8827, lon: -87.6221 },
        ],
      },
    ],
  };
}

describe("incremental runs from an Overpass request", () => {
  it("changing heights.* re-runs normalise from the cached response (no fetch) and everything under a scene that moved, and nothing when the scene did not", async () => {
    const cache = new StageCache();
    const raw = overpassWithUntaggedHeights();
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const request = { kind: "request" as const, request: REQUEST };
    const runWith = async (params: PrintParams): Promise<Run> => {
      const states = new Map<StageId, StageState>();
      const outcome = await runPipeline(
        jobFor(params, { source: request }),
        cache,
        (event) => {
          if (event.kind === "stage" && event.state !== "start") states.set(event.stage, event.state);
        },
        { overpass: { fetchImpl, mirrors: ["https://overpass.example/api/interpreter"] } },
      );
      return { outcome, states, ran: [], cached: [] };
    };
    const first = await runWith(defaultPrintParams());
    expect(first.outcome.status).toBe("done");
    expect(first.states.get("fetch")).toBe("done");
    expect(first.states.get("normalise")).toBe("done");
    expect(first.outcome.result?.stats.buildings).toBeGreaterThan(0);

    // The blanket fallback height moves the untagged building: normalise
    // re-runs from the cached response, the scene is new, and everything that
    // reads it follows.
    const taller: PrintParams = { ...defaultPrintParams(), heights: { ...defaultPrintParams().heights, unknown_default_m: 40 } };
    const second = await runWith(taller);
    expect(second.outcome.status).toBe("done");
    expect(second.states.get("fetch")).toBe("cached");
    expect(second.states.get("normalise")).toBe("done");
    for (const stage of ["context", "heroes", "repair-buildings", "buildings", "tokens", "finish-buildings", "assembly", "merged", "audit"] as const) {
      expect(second.states.get(stage), stage).toBe("done");
    }
    expectNothingSpurious(second.states, ["heights.unknown_default_m"]);
    expect(second.states.get("fonts")).toBe("cached");
    // This scene has no surface layer and the buildings are not socketed, so
    // the plate has no cutters that moved: the base stays cached through its
    // part digests even though the buildings on it grew. The weld re-ran.
    expect(second.states.get("base")).toBe("cached");
    expect(second.outcome.result?.stats.heightMm ?? 0).toBeGreaterThan(first.outcome.result?.stats.heightMm ?? 0);

    // A storey height moves the three-storey building only, and it moves.
    const storeys: PrintParams = { ...taller, heights: { ...taller.heights, floor_height_m: 6 } };
    const third = await runWith(storeys);
    expect(third.states.get("normalise")).toBe("done");
    expect(third.states.get("repair-buildings")).toBe("done");

    // A heights field this scene does not use (a type default for a shed)
    // re-runs normalise to the same scene: its digest is unchanged, so the
    // context and everything under it stay cached. Nothing spurious ran.
    const idle: PrintParams = { ...storeys, heights: { ...storeys.heights, type_defaults: { ...storeys.heights?.type_defaults, garage: 2.5 } } };
    const fourth = await runWith(idle);
    expect(fourth.states.get("normalise")).toBe("done");
    expect(fourth.states.get("context")).toBe("cached");
    expect(fourth.states.get("repair-buildings")).toBe("cached");
    expect(fourth.states.get("audit")).toBe("cached");
    cache.dispose();
  }, 120_000);
});

describe("terrain on a warm cache", () => {
  it("terrain.smoothing is applied by the terrain stage on a stamped grid: changing it re-runs terrain and lowers the relief", async () => {
    const cache = new StageCache();
    const { scene, grid } = terrainScene();
    const stamped: TerrainGrid = { ...grid, smoothing: 0 };
    const source = { kind: "scene" as const, scene, key: "terrain" };
    const sharpParams: PrintParams = { ...defaultPrintParams(), terrain: { enabled: true, smoothing: 0 } };
    const sharp = await run(cache, jobFor(sharpParams, { source, terrain: { grid: stamped, gate: "param" } }));
    const softParams: PrintParams = { ...defaultPrintParams(), terrain: { enabled: true, smoothing: 5 } };
    const soft = await run(cache, jobFor(softParams, { source, terrain: { grid: stamped, gate: "param" } }));
    expect(soft.states.get("context")).toBe("cached");
    expect(soft.states.get("terrain")).toBe("done");
    expect(soft.states.get("base")).toBe("done");
    expect(soft.outcome.result?.stats.terrainReliefMm ?? 0).toBeLessThan(sharp.outcome.result?.stats.terrainReliefMm ?? 0);
    // Switching terrain off with the grid still posted drops the drape entirely.
    const off = await run(cache, jobFor(defaultPrintParams(), { source, terrain: { grid: stamped, gate: "param" } }));
    expect(off.outcome.result?.stats.terrainReliefMm).toBeUndefined();
    cache.dispose();
  }, 120_000);
});

describe("memory: the one-generation cache does not grow", () => {
  it("20 warm re-runs alternating two texts keep the entry count, the handle count and the WASM object count constant", async () => {
    const before = outstandingWasmObjects();
    const cache = new StageCache();
    await run(cache, jobFor(withText("A")));
    await run(cache, jobFor(withText("B")));
    const entries = cache.size;
    const handles = cache.handleCount();
    const outstanding = outstandingWasmObjects();
    expect(entries).toBeGreaterThan(0);
    expect(handles).toBeGreaterThan(0);
    for (let i = 0; i < 20; i += 1) {
      const outcome = await run(cache, jobFor(withText(i % 2 === 0 ? "A" : "B")));
      expect(outcome.outcome.status).toBe("done");
      expect(cache.size).toBe(entries);
      expect(cache.handleCount()).toBe(handles);
      expect(outstandingWasmObjects()).toBe(outstanding);
    }
    cache.dispose();
    expect(outstandingWasmObjects()).toBe(before);
  }, 180_000);
});
