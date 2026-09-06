/**
 * Incremental behaviour, asserted by stage-event lists, never by timing
 * (design section 6). One cache, one small scene, one change at a time: which
 * stages re-ran and which were served from the cache is the whole assertion.
 */
import { afterAll, describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams } from "../../contracts";
import { perfReport, setPerfEnabled } from "../../perf";
import { outstandingWasmObjects } from "../solid/manifold";
import type { TerrainGrid } from "../types";
import { buildModel } from "../engine";
import { StageCache, runPipeline, stageIds, stagesInvalidatedBy, type ParamPath, type PipelineEvent, type PipelineJob, type RunOutcome, type StageId, type StageState } from "./index";
import { inputPartView, scenePartView } from "./runner";
import { SCENE_GROUND_LAYERS, stageById } from "./stages";
import { canonical, diffCanonical } from "./testCompare";
import { blockScene, bridgeScene, railScene, terrainScene } from "./testScenes";
import type { EngineSceneGraph } from "../osm/types";

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
  // The lip with the attribution marks, the ornaments and the mating features
  // already cut: keyed on the content of those cutters, which a text edit
  // leaves as they were, so the frame boolean a keystroke re-evaluates is the
  // text pockets alone (`[V3.1-P7-34]`).
  "frame-blank",
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
      // A park well north of both buildings (the road between them is under
      // their footprints and builds nothing): what a green override can colour.
      { type: "way", id: 4, tags: { landuse: "grass" }, geometry: square(41.884, -87.6233, 0.0003) },
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
    // Perf mode on for the whole sequence: the `osm.project` row counts how
    // many times the response was projected, which is the one observable of
    // `normalise` keeping the projection beside the fetch output.
    setPerfEnabled(true);
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
    for (const stage of ["heroes", "buildings", "region-buildings", "finish-buildings"] as const) {
      expect(third.states.get(stage), stage).toBe("done");
    }
    // The ground never reads a height: the surface layers, the bridge decks
    // and the grove are keyed on `normalise#ground` and the repair's
    // footprint, both unchanged, so the plate, its seat and the roads region
    // stay cached under a scene whose buildings all grew (v3-07's one miss).
    for (const stage of [
      "surface-water",
      "surface-rail",
      "surface-roads",
      "surface-parks",
      "bridges",
      "trees",
      "base",
      "region-base",
      "sit",
      "region-roads",
      "finish-roads",
    ] as const) {
      expect(third.states.get(stage), stage).toBe("cached");
    }
    const storeyHeight = (outcome: RunOutcome): number => outcome.scene?.scene.buildings.find((b) => b.id === "w2")?.height_m ?? 0;
    // Three storeys at the contract's default 3 m, then at 6 m.
    expect(storeyHeight(second.outcome)).toBe(3 * 3);
    expect(storeyHeight(third.outcome)).toBe(3 * 6);

    // A heights field this scene does not use (a type default for a shed)
    // re-runs normalise to the same scene: its digest is unchanged, so the
    // context and everything under it stay cached. Nothing spurious ran.
    const idle: PrintParams = { ...storeys, heights: { ...storeys.heights, type_defaults: { ...storeys.heights?.type_defaults, garage: 2.5 } } };
    const fourth = await runWith(idle);
    expect(fourth.states.get("normalise")).toBe("done");
    expect(fourth.states.get("context")).toBe("cached");
    expect(fourth.states.get("repair-buildings")).toBe("cached");
    expect(fourth.states.get("audit")).toBe("cached");

    // One coloured park: a surface-bearing override, whose stage output now
    // carries handles. Keyed on `normalise#overrides` (the ground plus which
    // buildings exist) and the footprint, it survives a storey-height change
    // too, and so does everything under it: without that key one coloured
    // surface put every ground stage back on the whole scene's key.
    const coloured: PrintParams = { ...idle, object_overrides: [{ osm_id: "w4", layer: "green", color: "#ff0000" }] };
    const fifth = await runWith(coloured);
    expect(fifth.outcome.status, fifth.outcome.error?.message).toBe("done");
    expect(fifth.states.get("surface-overrides")).toBe("done");
    expect(fifth.states.get("finish-override_1")).toBe("done");
    expect(fifth.outcome.result?.regions.some((region) => region.region === "override_1")).toBe(true);
    const colouredTaller: PrintParams = { ...coloured, heights: { ...coloured.heights, floor_height_m: 9 } };
    const sixth = await runWith(colouredTaller);
    expect(sixth.outcome.status, sixth.outcome.error?.message).toBe("done");
    expect(sixth.states.get("normalise")).toBe("done");
    expect(sixth.states.get("repair-buildings")).toBe("done");
    expect(sixth.states.get("finish-buildings")).toBe("done");
    for (const stage of ["surface-overrides", "surface-roads", "surface-parks", "base", "region-base", "sit", "region-override_1", "finish-override_1", "region-roads", "finish-roads"] as const) {
      expect(sixth.states.get(stage), stage).toBe("cached");
    }
    expect(storeyHeight(sixth.outcome)).toBe(3 * 9);

    // Five normalise runs (the override alone left it cached), one
    // projection: the response was classified, projected, cleaned and cropped
    // once, and only the heights were re-applied for the changes. A fetch
    // that re-ran would project again.
    expect(fifth.states.get("normalise")).toBe("cached");
    const rows = perfReport("heights").rows;
    const count = (name: string): number => rows.find((row) => row.name === name)?.count ?? 0;
    expect(count("osm.normalize")).toBe(5);
    expect(count("osm.project")).toBe(1);
    expect(count("osm.heights")).toBe(5);
    setPerfEnabled(null);
    cache.dispose();
  }, 120_000);
});

describe("the scene view a ground stage is handed", () => {
  // The rail scene carries every layer the part names.
  const scene = railScene() as EngineSceneGraph;

  it("exposes the part's layers as they are and throws, naming the stage and the part, for any other", () => {
    const view = scenePartView(scene, "surface-roads", "ground");
    expect(view.roads).toBe(scene.roads);
    expect(view.water).toBe(scene.water);
    expect(view.green).toBe(scene.green);
    expect(view.rail).toBe(scene.rail);
    expect(view.trees).toBe(scene.trees);
    expect(view.bounds).toBe(scene.bounds);
    expect(view.center).toBe(scene.center);
    expect(() => view.buildings).toThrow("stage surface-roads reads scene.buildings, which normalise#ground does not cover");
    expect(() => view.stats).toThrow("normalise#ground does not cover");
    // Nothing a JSON walk or a spread could pick up either: the refused
    // layers are not enumerable.
    expect(Object.keys(view).sort()).toEqual([...SCENE_GROUND_LAYERS].sort());
  });

  it("refuses a part the registry does not define", () => {
    expect(() => scenePartView(scene, "surface-roads", "roofs")).toThrow("names no scene part");
  });

  it("the overrides part adds the buildings cut down to their identity: id and osm_id readable, a height a refusal", () => {
    const view = scenePartView(scene, "surface-overrides", "overrides");
    expect(view.roads).toBe(scene.roads);
    expect(view.buildings).toHaveLength(scene.buildings.length);
    expect(view.buildings.map((b) => b.id)).toEqual(scene.buildings.map((b) => b.id));
    expect(view.buildings.map((b) => b.osm_id)).toEqual(scene.buildings.map((b) => b.osm_id));
    expect(() => view.buildings[0].height_m).toThrow("stage surface-overrides reads scene.buildings[].height_m, which normalise#overrides does not cover");
    expect(() => view.buildings[0].ring).toThrow("normalise#overrides does not cover");
    expect(() => view.stats).toThrow("normalise#overrides does not cover");
  });

  it("an input keyed on a named part is served that part and nothing else; a part with no exposure listed is served whole", () => {
    const repair = { footprint: null, solids: [{ id: "x" }], dilated: 1, merged: 2 };
    const view = inputPartView(repair, "surface-roads", "repair-buildings", "footprint");
    expect(view.footprint).toBeNull();
    expect(() => view.solids).toThrow("stage surface-roads reads repair-buildings.solids, which repair-buildings#footprint does not cover");
    expect(() => view.merged).toThrow("repair-buildings#footprint does not cover");
    const buildings = { socket: [], bands: [] };
    expect(inputPartView(buildings, "base", "buildings", "socket")).toBe(buildings);
  });

  it("is what every stage keyed on normalise#ground reads: a stage that reaches past the part fails its run, not its cache", async () => {
    // The registry's own ground stages, driven through the runner on a scene
    // with every layer: if any of them read a building through the view, the
    // run errors here rather than serving stale ground after a height change.
    const cache = new StageCache();
    try {
      const outcome = await run(cache, jobFor(defaultPrintParams(), { source: { kind: "scene", scene: bridgeScene(), key: "bridge" }, mode: "preview" }));
      expect(outcome.outcome.status, outcome.outcome.error?.message).toBe("done");
      const keyed = stageIds().filter((id) => stageById(id).inputDigests?.normalise === "ground");
      expect(keyed).toEqual(["surface-water", "surface-rail", "surface-roads", "surface-parks", "bridges", "trees"]);
      for (const id of keyed) expect(outcome.states.get(id), id).toBe("done");
      // The seventh ground reader, keyed on the overrides part, and every
      // footprint reader served the footprint alone.
      expect(stageById("surface-overrides").inputDigests?.normalise).toBe("overrides");
      const footprintReaders = stageIds().filter((id) => stageById(id).inputDigests?.["repair-buildings"] === "footprint");
      expect(footprintReaders).toEqual(["surface-overrides", ...keyed]);
      for (const id of footprintReaders) expect(outcome.states.get(id), id).toBe("done");
    } finally {
      cache.dispose();
    }
  }, 60_000);
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

// ---------------------------------------------------------------------------
// Audit fixes (docs/handoff/v3-01-pipeline-audit.md)
// ---------------------------------------------------------------------------

describe("audit finding 1: a stage's findings and resolved text are part of its digest", () => {
  it("frame off, a refused underside line changed from X to Y: the warm findings and resolved text are the cold build's", async () => {
    const cache = new StageCache();
    try {
      const frameOff: PrintParams = { ...defaultPrintParams(), frame: false, engravings: [] };
      const refusedX: PrintParams = { ...frameOff, engravings: [{ edge: "underside", text: "X".repeat(400), mode: "engrave", size_mm: 3 }] };
      const refusedY: PrintParams = { ...frameOff, engravings: [{ edge: "underside", text: "Y".repeat(400), mode: "engrave", size_mm: 3 }] };
      await run(cache, jobFor(frameOff));
      const x = await run(cache, jobFor(refusedX));
      // The line is refused: lettering owns no handle, its output is plain
      // data, and only its channels (the refusal) changed between X and Y.
      expect(x.outcome.result?.resolvedText.some((line) => line.status === "skipped" && line.text.startsWith("XXXX"))).toBe(true);
      const y = await run(cache, jobFor(refusedY));
      expect(y.states.get("lettering")).toBe("done");
      expect(y.states.get("audit")).toBe("done");
      const cold = await buildModel({ scene: blockScene(), params: refusedY, date: "2026-09-02" });
      expect(y.outcome.result?.resolvedText).toEqual(cold.resolvedText);
      expect(y.outcome.result?.findings).toEqual(cold.findings);
      expect(y.outcome.result?.params).toEqual(cold.params);
      expect(y.outcome.result?.resolvedText.some((line) => line.text.startsWith("YYYY"))).toBe(true);
      expect(y.outcome.result?.resolvedText.some((line) => line.text.startsWith("XXXX"))).toBe(false);
    } finally {
      cache.dispose();
    }
  }, 120_000);

  it("an aliasing sequence on one warm cache matches a cold build of every step, whole result, byte for byte", async () => {
    const cache = new StageCache();
    try {
      const A = withText("{city}");
      const B = withText("{coords}");
      const undersideC: PrintParams = { ...A, engravings: [...(A.engravings ?? []), { edge: "underside", text: "AAAA", mode: "engrave", size_mm: 3 }] };
      const undersideD: PrintParams = { ...A, engravings: [...(A.engravings ?? []), { edge: "underside", text: "BBBB", mode: "engrave", size_mm: 3 }] };
      const refused: PrintParams = { ...A, engravings: [...(A.engravings ?? []), { edge: "underside", text: "X".repeat(400), mode: "engrave", size_mm: 3 }] };
      const frameOff: PrintParams = { ...A, frame: false };
      const frameOffChamfer: PrintParams = { ...frameOff, frame_style: { ...A.frame_style, profile: "chamfer" } };
      const frameOnChamfer: PrintParams = { ...A, frame_style: { ...A.frame_style, profile: "chamfer" } };
      const gradientOn: PrintParams = { ...A, colour: { ...A.colour, gradient: { enabled: true, slots: [2, 3] } } };
      const tilingOn: PrintParams = { ...A, tiling: { ...A.tiling, enabled: true, cols: 2, rows: 1 } };
      const steps: Array<[string, PrintParams]> = [
        ["A", A],
        ["B: edge text differs, base digest same", B],
        ["A again", A],
        ["C: underside AAAA", undersideC],
        ["D: underside BBBB", undersideD],
        ["E: underside refused, base digest none like A", refused],
        ["A again 2", A],
        ["frame off", frameOff],
        ["frame off + chamfer", frameOffChamfer],
        ["frame on + chamfer", frameOnChamfer],
        ["gradient on", gradientOn],
        ["gradient off", A],
        ["tiling on", tilingOn],
        ["tiling off", A],
      ];
      for (const [name, params] of steps) {
        const warm = await run(cache, jobFor(params));
        const cold = await buildModel({ scene: blockScene(), params, date: "2026-09-02" });
        const problems = diffCanonical(canonical(warm.outcome.result), canonical(cold));
        expect(problems, `${name}: ${problems.join(" | ")}`).toEqual([]);
      }
    } finally {
      cache.dispose();
    }
  }, 300_000);
});

describe("audit finding 2: region-ready carries hashes and removed names every region the model lost", () => {
  it("a band streamed by a cancelled run is reported removed by the next run, and every region-ready carries its hashes", async () => {
    const cache = new StageCache();
    try {
      const base = defaultPrintParams();
      const on: PrintParams = { ...base, colour: { ...base.colour, gradient: { enabled: true, slots: [2, 3] } } };
      const off: PrintParams = { ...base, colour: { ...base.colour, gradient: { enabled: false, slots: [2, 3] } } };
      // A main-thread map driven only by what the worker posts.
      const held = new Map<string, { hash: string }>();
      const controller = new AbortController();
      const first = await runPipeline(
        jobFor(on, { known: {} }),
        cache,
        (event) => {
          if (event.kind === "region-ready") {
            for (const region of event.regions) {
              expect(event.hashes?.[region.region], `hash for ${region.region}`).toBeTypeOf("string");
              held.set(region.region, { hash: event.hashes?.[region.region] ?? "" });
            }
            for (const region of event.removed) held.delete(region);
          }
          if (event.kind === "stage" && event.state === "done" && event.stage === "assembly") controller.abort();
        },
        { signal: controller.signal, stripRegionMeshes: true, regionBatchMs: 0 },
      );
      expect(first.status).toBe("cancelled");
      expect(held.has("buildings_band_2")).toBe(true);
      const known = Object.fromEntries([...held].map(([region, entry]) => [region, entry.hash]));
      const second = await runPipeline(
        jobFor(off, { known }),
        cache,
        (event) => {
          if (event.kind === "region-ready") {
            for (const region of event.regions) held.set(region.region, { hash: event.hashes?.[region.region] ?? "" });
            for (const region of event.removed) held.delete(region);
          }
        },
        { stripRegionMeshes: true, regionBatchMs: 0 },
      );
      expect(second.status).toBe("done");
      const present = new Set<string>(second.result?.regions.map((region) => region.region));
      expect([...held.keys()].filter((region) => !present.has(region))).toEqual([]);
      expect(held.has("buildings_band_2")).toBe(false);
      // What it holds is exactly the model, hash for hash.
      for (const region of present) expect(held.get(region)?.hash).toBe(second.regionHashes[region]);
    } finally {
      cache.dispose();
    }
  }, 120_000);
});

describe("audit finding 7: the export key covers the parameter echo", () => {
  it("a leaf no stage claims (part_colors.base) still re-runs the export, and nothing else", async () => {
    const cache = new StageCache();
    try {
      const exportJob = (params: PrintParams): PipelineJob =>
        jobFor(params, { mode: "export", exportRequest: { target: "stl", stem: "echo", createdIso: "2026-09-02T00:00:00Z" } });
      const first = await run(cache, exportJob(defaultPrintParams()));
      expect(first.states.get("export")).toBe("done");
      const recoloured: PrintParams = { ...defaultPrintParams(), part_colors: { ...(defaultPrintParams().part_colors ?? {}), base: "#123456" } as PrintParams["part_colors"] };
      const second = await run(cache, exportJob(recoloured));
      expect(second.states.get("export")).toBe("done");
      expect(second.states.get("audit")).toBe("cached");
      expect(second.states.get("finish-base")).toBe("cached");
      const sidecar = second.outcome.files?.sidecar as { print_params?: { part_colors?: { base?: string } } } | undefined;
      expect(sidecar?.print_params?.part_colors?.base).toBe("#123456");
    } finally {
      cache.dispose();
    }
  }, 90_000);
});

describe("audit finding 4: done carries the merged mesh and the tile meshes only when their hash is new", () => {
  it("strips what the consumer already holds and names the hashes", async () => {
    const cache = new StageCache();
    try {
      const tiled: PrintParams = { ...defaultPrintParams(), tiling: { ...defaultPrintParams().tiling, enabled: true, cols: 2, rows: 1 } };
      const doneEvents: Array<Extract<PipelineEvent, { kind: "done" }>> = [];
      const collect = (event: PipelineEvent): void => {
        if (event.kind === "done") doneEvents.push(event);
      };
      await runPipeline(jobFor(tiled), cache, collect, { stripRegionMeshes: true });
      const got = doneEvents[0];
      expect(got.mergedHash).toBeTypeOf("string");
      expect(got.tilesHash).toBeTypeOf("string");
      expect(got.result?.merged.positions.length ?? 0).toBeGreaterThan(0);
      expect(got.result?.tiles?.[0]?.regions[0]?.positions.length ?? 0).toBeGreaterThan(0);
      await runPipeline(jobFor(tiled, { knownMergedHash: got.mergedHash ?? null, knownTilesHash: got.tilesHash ?? null }), cache, collect, { stripRegionMeshes: true });
      const again = doneEvents[1];
      expect(again.mergedHash).toBe(got.mergedHash);
      expect(again.tilesHash).toBe(got.tilesHash);
      expect(again.result?.merged.positions.length).toBe(0);
      expect(again.result?.merged.volumeMm3).toBe(got.result?.merged.volumeMm3);
      expect(again.result?.tiles?.every((tile) => tile.regions.every((region) => region.positions.length === 0) && (tile.merged?.positions.length ?? 0) === 0)).toBe(true);
      // A change that moves the model sends them whole again.
      await runPipeline(jobFor({ ...tiled, plate_mm: 200 }, { knownMergedHash: got.mergedHash ?? null, knownTilesHash: got.tilesHash ?? null }), cache, collect, { stripRegionMeshes: true });
      const moved = doneEvents[2];
      expect(moved.mergedHash).not.toBe(got.mergedHash);
      expect(moved.result?.merged.positions.length ?? 0).toBeGreaterThan(0);
    } finally {
      cache.dispose();
    }
  }, 120_000);
});

describe("per-triangle building identity across warm runs", () => {
  it("ids are stable across a warm re-run: a colour change re-finishes the buildings and yields the same owners, triangle for triangle", async () => {
    const cache = new StageCache();
    try {
      const base = defaultPrintParams();
      const first = await run(cache, jobFor(base));
      const before = first.outcome.result?.regions.find((region) => region.region === "buildings");
      expect(before?.owners).toEqual(["b-court", "b-low", "b-tall"]);
      expect(before?.triangleOwner?.length).toBe((before?.indices.length ?? 0) / 3);
      // A slot change is the finish's alone: the buildings stage keeps its
      // solids and its original ids, and the finish attributes them again.
      const reslotted: PrintParams = {
        ...base,
        colour: { ...base.colour, region_slots: { ...base.colour?.region_slots, buildings: 7 } } as PrintParams["colour"],
      };
      const second = await run(cache, jobFor(reslotted));
      expect(second.states.get("buildings")).toBe("cached");
      expect(second.states.get("finish-buildings")).toBe("done");
      const after = second.outcome.result?.regions.find((region) => region.region === "buildings");
      expect(after?.slot).toBe(7);
      expect(after?.owners).toEqual(before?.owners);
      expect(after?.triangleOwner).toEqual(before?.triangleOwner);
      // A colour change re-runs the buildings stage itself (it tints by the
      // colour), so every solid is extruded afresh with NEW original ids; the
      // identity on the mesh is still the same, triangle for triangle.
      const recoloured: PrintParams = {
        ...reslotted,
        colour: { ...reslotted.colour, region_colors: { ...reslotted.colour?.region_colors, buildings: "#112233" } } as PrintParams["colour"],
      };
      const third = await run(cache, jobFor(recoloured));
      expect(third.states.get("buildings")).toBe("done");
      const rebuilt = third.outcome.result?.regions.find((region) => region.region === "buildings");
      expect(rebuilt?.colorHex).toBe("#112233");
      expect(rebuilt?.owners).toEqual(before?.owners);
      expect(rebuilt?.triangleOwner).toEqual(before?.triangleOwner);
      // The same params again: served from the cache, the same hash, the same identity.
      const fourth = await run(cache, jobFor(recoloured));
      expect(fourth.states.get("finish-buildings")).toBe("cached");
      expect(fourth.outcome.regionHashes.buildings).toBe(third.outcome.regionHashes.buildings);
      expect(fourth.outcome.result?.regions.find((region) => region.region === "buildings")?.triangleOwner).toEqual(before?.triangleOwner);
    } finally {
      cache.dispose();
    }
  }, 90_000);

  it("the region hash moves when ownership changes: a building promoted to hero leaves the buildings mesh and owns the hero mesh", async () => {
    const cache = new StageCache();
    try {
      const base = defaultPrintParams();
      const first = await run(cache, jobFor(base));
      const hero: PrintParams = { ...base, hero_building_ids: ["b-tall"] };
      const second = await run(cache, jobFor(hero));
      expect(second.outcome.regionHashes.buildings).not.toBe(first.outcome.regionHashes.buildings);
      const buildings = second.outcome.result?.regions.find((region) => region.region === "buildings");
      const heroMesh = second.outcome.result?.regions.find((region) => region.region === "hero_building");
      expect(buildings?.owners).toEqual(["b-court", "b-low"]);
      expect(heroMesh?.owners).toEqual(["b-tall"]);
      expect(heroMesh?.triangleOwner?.length).toBe((heroMesh?.indices.length ?? 0) / 3);
      expect(heroMesh?.triangleOwner?.every((owner) => owner === 0)).toBe(true);
      expect(buildings?.triangleOwner?.every((owner) => owner < 2)).toBe(true);
      // Back to the defaults: the same hash and identity as the first run.
      const third = await run(cache, jobFor(base));
      expect(third.outcome.regionHashes.buildings).toBe(first.outcome.regionHashes.buildings);
      expect(third.outcome.result?.regions.find((region) => region.region === "buildings")?.owners).toEqual(["b-court", "b-low", "b-tall"]);
    } finally {
      cache.dispose();
    }
  }, 90_000);
});
