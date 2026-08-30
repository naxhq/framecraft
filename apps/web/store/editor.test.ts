/**
 * Editor store tests.
 *
 * The load-bearing one is "no server call on slider change" (01 step 4 and
 * 01/A3): every PrintParams control must write to the store and nothing else.
 * The test drives *every* key of the frozen PrintParams object through
 * `setParam` with `fetch` spied on, so adding a control that secretly refetches
 * fails here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bakeDownloadLinks,
  bakeStarted,
  bakeStatusLabel,
  initialBakeState,
  reduceBake,
} from "@/lib/bake";
import { DEFAULT_PRINT_PARAMS } from "@/lib/contracts";
import type { BakeResult, PrintParams, SceneGraph, SceneRequest } from "@/lib/contracts";
import {
  activePresetId,
  INITIAL_LOCATION,
  locationToRequest,
  useEditorStore,
} from "./editor";

const fixtureScene = (): SceneGraph => ({
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
});

/** Every PrintParams key with a value that differs from the default. */
const PARAM_MOVES: Array<[keyof PrintParams, PrintParams[keyof PrintParams]]> = [
  ["plate_mm", 256],
  ["base_thickness_mm", 8],
  ["nozzle_mm", 0.6],
  ["small_scale", 1.5],
  ["large_scale", 2.0],
  ["terrain_exaggeration", 3.0],
  ["road_mode", "emboss"],
  ["road_scale", 0.5],
  ["trees", false],
  ["water", false],
  ["frame", false],
];

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useEditorStore.setState({
    location: { ...INITIAL_LOCATION },
    params: { ...DEFAULT_PRINT_PARAMS },
    scene: { status: "idle", graph: null, message: null, request: null, stale: false },
    bake: { ...initialBakeState },
    presets: { status: "idle", items: [], message: null },
    presetChosen: false,
  });
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  useEditorStore.getState().stopBakePolling();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("print params", () => {
  it("covers every field of the frozen PrintParams contract", () => {
    expect(PARAM_MOVES.map(([key]) => key).sort()).toEqual(
      (Object.keys(DEFAULT_PRINT_PARAMS) as Array<keyof PrintParams>).sort(),
    );
  });

  it("never makes a server call, whichever control moves", async () => {
    const store = useEditorStore.getState();
    for (const [key, value] of PARAM_MOVES) {
      store.setParam(key, value as never);
    }
    // Let any accidental microtask-scheduled fetch land before we assert.
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();

    const params = useEditorStore.getState().params;
    for (const [key, value] of PARAM_MOVES) {
      expect(params[key]).toBe(value);
    }
  });

  it("never marks the scene stale", () => {
    useEditorStore.setState({
      scene: {
        status: "ready",
        graph: fixtureScene(),
        message: null,
        request: locationToRequest(INITIAL_LOCATION),
        stale: false,
      },
    });
    for (const [key, value] of PARAM_MOVES) {
      useEditorStore.getState().setParam(key, value as never);
    }
    expect(useEditorStore.getState().scene.stale).toBe(false);
    expect(useEditorStore.getState().scene.graph).not.toBeNull();
  });

  it("resets to the contract defaults", () => {
    useEditorStore.getState().setParam("plate_mm", 256);
    useEditorStore.getState().resetParams();
    expect(useEditorStore.getState().params).toEqual(DEFAULT_PRINT_PARAMS);
  });
});

describe("location changes", () => {
  it("mark the scene stale but still do not fetch on their own", () => {
    const store = useEditorStore.getState();
    store.setPin(48.8584, 2.2945);
    expect(useEditorStore.getState().scene.stale).toBe(true);
    expect(useEditorStore.getState().location.preset_id).toBeNull();

    useEditorStore.setState((s) => ({ scene: { ...s.scene, stale: false } }));
    store.setRadius(1234);
    expect(useEditorStore.getState().location.radius_m).toBe(1230); // snapped to 10 m
    expect(useEditorStore.getState().scene.stale).toBe(true);

    useEditorStore.setState((s) => ({ scene: { ...s.scene, stale: false } }));
    store.setRotation(47.4);
    expect(useEditorStore.getState().location.rotation_deg).toBe(47);
    expect(useEditorStore.getState().scene.stale).toBe(true);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("clamp the radius to the 250..3000 m range", () => {
    const store = useEditorStore.getState();
    store.setRadius(10);
    expect(useEditorStore.getState().location.radius_m).toBe(250);
    store.setRadius(99999);
    expect(useEditorStore.getState().location.radius_m).toBe(3000);
  });

  it("adopt a preset wholesale, including its rotation and id", () => {
    const preset: SceneRequest = {
      lat: 35.6896,
      lon: 139.7006,
      radius_m: 800,
      rotation_deg: 30,
      preset_id: "tokyo-shinjuku",
    };
    useEditorStore.getState().applyPreset(preset);
    expect(useEditorStore.getState().location).toEqual({
      lat: 35.6896,
      lon: 139.7006,
      radius_m: 800,
      rotation_deg: 30,
      preset_id: "tokyo-shinjuku",
    });
    expect(useEditorStore.getState().scene.stale).toBe(true);
  });
});

describe("generate", () => {
  it("POSTs exactly the current SceneRequest and stores the graph", async () => {
    const graph = fixtureScene();
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(graph), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await useEditorStore.getState().generate();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/scene$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(locationToRequest(INITIAL_LOCATION));

    const scene = useEditorStore.getState().scene;
    expect(scene.status).toBe("ready");
    expect(scene.stale).toBe(false);
    expect(scene.graph?.stats.building_count).toBe(40);
    expect(scene.request).toEqual(locationToRequest(INITIAL_LOCATION));
  });

  it("surfaces a real error state instead of silently falling back", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ detail: "Overpass timed out" }), { status: 504 }),
    );
    await useEditorStore.getState().generate();
    const scene = useEditorStore.getState().scene;
    expect(scene.status).toBe("error");
    expect(scene.message).toContain("Overpass timed out");
    expect(scene.graph).toBeNull();
  });

  it("reports an unreachable API rather than throwing", async () => {
    fetchSpy.mockRejectedValue(new TypeError("Failed to fetch"));
    await useEditorStore.getState().generate();
    expect(useEditorStore.getState().scene.status).toBe("error");
    expect(useEditorStore.getState().scene.message).toContain("Cannot reach the bake API");
  });
});

describe("presets", () => {
  it("loads the six SceneRequests from GET /presets", async () => {
    const presets: SceneRequest[] = [
      { lat: 41.8827, lon: -87.6233, radius_m: 900, rotation_deg: 0, preset_id: "chicago-loop" },
    ];
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(presets), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await useEditorStore.getState().loadPresets();
    expect(useEditorStore.getState().presets.status).toBe("ready");
    expect(useEditorStore.getState().presets.items).toHaveLength(1);
  });

  it("keeps an error message when the API is down", async () => {
    fetchSpy.mockRejectedValue(new TypeError("Failed to fetch"));
    await useEditorStore.getState().loadPresets();
    expect(useEditorStore.getState().presets.status).toBe("error");
    expect(useEditorStore.getState().presets.message).toBeTruthy();
  });
});

/** A finished bake, as `GET /bake/{id}` would report it. */
const doneResult: BakeResult = {
  job_id: "job-1",
  status: "done",
  files: { "3mf": "/files/ab12.3mf", stl: "/files/ab12.stl" },
  stats: {
    triangles: 412330,
    volume_mm3: 39122.5,
    bbox_mm: [180, 180, 41.2],
    est_grams: 48.6,
    is_manifold: true,
    min_wall_mm: 0.81,
  },
  warnings: [],
  progress: 1,
  error: null,
};

/** Put the store in "Chicago is previewed and a bake of it just finished". */
function withFinishedBake(): void {
  useEditorStore.setState({
    scene: {
      status: "ready",
      graph: fixtureScene(),
      message: null,
      request: locationToRequest(INITIAL_LOCATION),
      stale: false,
    },
    bake: reduceBake(bakeStarted("job-1"), doneResult),
  });
}

describe("bake staleness", () => {
  it("starts current and keeps its download links", () => {
    withFinishedBake();
    const bake = useEditorStore.getState().bake;
    expect(bake.phase).toBe("done");
    expect(bake.stale).toBe(false);
    expect(bakeDownloadLinks(bake)).toHaveLength(2);
  });

  it("goes stale on EVERY PrintParams control, keeping the result", () => {
    for (const [key, value] of PARAM_MOVES) {
      withFinishedBake();
      useEditorStore.getState().setParam(key, value as never);
      const bake = useEditorStore.getState().bake;
      expect(bake.stale, `${key} left the bake looking current`).toBe(true);
      // The result is KEPT (the stats card still shows the last real bake) but
      // it may no longer be offered as a download.
      expect(bake.result).not.toBeNull();
      expect(bake.phase).toBe("done");
      expect(bakeDownloadLinks(bake)).toHaveLength(0);
      expect(bakeStatusLabel(bake)).toContain("outdated");
    }
  });

  it("goes stale on resetParams and on every location change", () => {
    const cases: Array<[string, () => void]> = [
      ["resetParams", () => useEditorStore.getState().resetParams()],
      ["setPin", () => useEditorStore.getState().setPin(48.8584, 2.2945)],
      ["setRadius", () => useEditorStore.getState().setRadius(1200)],
      ["setRotation", () => useEditorStore.getState().setRotation(29)],
      [
        "applyPreset",
        () =>
          useEditorStore.getState().applyPreset({
            lat: 35.6896,
            lon: 139.7006,
            radius_m: 800,
            rotation_deg: 30,
            preset_id: "tokyo-shinjuku",
          }),
      ],
    ];
    for (const [name, act] of cases) {
      withFinishedBake();
      act();
      expect(useEditorStore.getState().bake.stale, `${name} did not invalidate the bake`).toBe(
        true,
      );
    }
  });

  it("goes stale when a fresh SceneGraph arrives", async () => {
    withFinishedBake();
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(fixtureScene()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await useEditorStore.getState().generate();
    expect(useEditorStore.getState().scene.status).toBe("ready");
    expect(useEditorStore.getState().bake.stale).toBe(true);
  });

  it("does not invalidate a bake that is still running", () => {
    useEditorStore.setState({ bake: bakeStarted("job-9") });
    useEditorStore.getState().setParam("plate_mm", 256);
    const bake = useEditorStore.getState().bake;
    expect(bake.phase).toBe("queued");
    expect(bake.stale).toBe(false);
  });

  it("is cleared by the next bake", async () => {
    withFinishedBake();
    useEditorStore.getState().setParam("plate_mm", 256);
    expect(useEditorStore.getState().bake.stale).toBe(true);

    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ job_id: "job-2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await useEditorStore.getState().requestBake();
    useEditorStore.getState().stopBakePolling();
    expect(useEditorStore.getState().bake.stale).toBe(false);
    expect(useEditorStore.getState().bake.jobId).toBe("job-2");
  });
});

describe("the active preset chip", () => {
  it("is dark on a fresh load, even though the pin starts on a preset", () => {
    // This is the reload case: location.preset_id is "chicago-loop" out of the
    // box, but nothing has been generated, so no chip may claim to be loaded.
    expect(useEditorStore.getState().location.preset_id).toBe("chicago-loop");
    expect(activePresetId(useEditorStore.getState())).toBeNull();
  });

  it("lights up the moment a preset is clicked, before its scene arrives", () => {
    useEditorStore.getState().applyPreset({
      lat: 35.6896,
      lon: 139.7006,
      radius_m: 800,
      rotation_deg: 30,
      preset_id: "tokyo-shinjuku",
    });
    expect(useEditorStore.getState().scene.graph).toBeNull();
    expect(activePresetId(useEditorStore.getState())).toBe("tokyo-shinjuku");
  });

  it("lights up once a scene is loaded at the preset's location", () => {
    useEditorStore.setState({
      scene: {
        status: "ready",
        graph: fixtureScene(),
        message: null,
        request: locationToRequest(INITIAL_LOCATION),
        stale: false,
      },
    });
    expect(activePresetId(useEditorStore.getState())).toBe("chicago-loop");
  });

  it("stays dark when the generate at the initial location fails", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ detail: "Overpass timed out" }), { status: 504 }),
    );
    await useEditorStore.getState().generate();
    expect(useEditorStore.getState().scene.status).toBe("error");
    expect(activePresetId(useEditorStore.getState())).toBeNull();
  });

  it("goes dark again when the user drops a pin of their own", () => {
    useEditorStore.getState().applyPreset({
      lat: 35.6896,
      lon: 139.7006,
      radius_m: 800,
      rotation_deg: 30,
      preset_id: "tokyo-shinjuku",
    });
    useEditorStore.getState().setPin(41.9, -87.45);
    expect(useEditorStore.getState().presetChosen).toBe(false);
    expect(activePresetId(useEditorStore.getState())).toBeNull();
  });
});

describe("bake gating", () => {
  it("refuses to bake a scene with fewer than 20 buildings", async () => {
    const sparse = fixtureScene();
    sparse.buildings = sparse.buildings.slice(0, 5);
    sparse.stats = { building_count: 5, coverage: "empty", height_tag_ratio: 0.5 };
    useEditorStore.setState({
      scene: {
        status: "ready",
        graph: sparse,
        message: null,
        request: locationToRequest(INITIAL_LOCATION),
        stale: false,
      },
    });

    await useEditorStore.getState().requestBake();

    expect(fetchSpy).not.toHaveBeenCalled();
    const bake = useEditorStore.getState().bake;
    expect(bake.phase).toBe("failed");
    expect(bake.error).toContain("enlarge the radius");
  });

  it("POSTs {scene_request, print_params} for a good scene", async () => {
    useEditorStore.setState({
      scene: {
        status: "ready",
        graph: fixtureScene(),
        message: null,
        request: locationToRequest(INITIAL_LOCATION),
        stale: false,
      },
    });
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ job_id: "job-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await useEditorStore.getState().requestBake();
    useEditorStore.getState().stopBakePolling();

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/bake$/);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["print_params", "scene_request"]);
    expect(body.scene_request).toEqual(locationToRequest(INITIAL_LOCATION));
    expect(body.print_params).toEqual(DEFAULT_PRINT_PARAMS);
    expect(useEditorStore.getState().bake.jobId).toBe("job-1");
  });
});
