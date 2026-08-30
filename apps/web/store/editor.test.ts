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
import { DEFAULT_PRINT_PARAMS, defaultPrintParams } from "@/lib/contracts";
import type { BakeResult, PrintParams, SceneGraph, SceneRequest } from "@/lib/contracts";
import { HERO_CAP } from "@/lib/heroes";
import { encodeShare } from "@/lib/share";
import {
  activePresetId,
  IDLE_PLACE_DETECT,
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

/**
 * Every PrintParams key with a value that differs from the default.
 *
 * `schema_version` is the one exception: its enum has a single member, so the
 * only legal value IS the default. It is listed anyway to keep the coverage
 * assertion below exhaustive.
 */
const PARAM_MOVES: Array<[keyof PrintParams, PrintParams[keyof PrintParams]]> = [
  ["schema_version", 2],
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
  // schema_version 2 additions. None of them may reach the network either.
  ["city_label", "Chicago"],
  ["color_mode", "parts"],
  [
    "part_colors",
    {
      base: "#111111",
      frame: "#222222",
      buildings: "#333333",
      roads: "#444444",
      water: "#555555",
      green: "#666666",
      trees: "#777777",
    },
  ],
  ["engravings", [{ edge: "bottom", text: "{city}" }]],
  ["north_arrow", { enabled: true, corner: "sw", size_mm: 6 }],
  [
    "scale_bar",
    { enabled: true, edge: "top", length_mode: "fixed", length_m: 1000 },
  ],
  ["hanger", "keyhole"],
  ["underside_mark", { enabled: true, template: "{coords}" }],
  ["hero_building_ids", ["w1"]],
  ["hero_mode", "both"],
  // schema_version 3 additions (docs/IMPLEMENTATION_PLAN.md's "Contracts v3").
  ["place", { country: "US", state: "IL", neighbourhood: "Loop", author: "Vahid" }],
  ["regions", { roads: { depth_mm: 1.0 }, building_skirt_mm: 0.6 }],
  ["colour", { palette: "noir", preview_theme: "light" }],
  ["printer_profile", "bambu-x1c"],
  ["custom_profile", { plate_x_mm: 256, plate_y_mm: 256 }],
  ["export_target", "stl"],
  ["terrain", { enabled: true, smoothing: 3 }],
  ["heights", { floor_height_m: 3.5 }],
  ["bridges", { enabled: false }],
  ["height_exaggeration", { multiplier: 1.5 }],
  ["hero_auto", { enabled: true, count: 5 }],
  ["tiling", { enabled: true, cols: 2, rows: 2 }],
  ["frame_style", { profile: "chamfer", corner: "mitred" }],
  ["hanger_magnet", { diameter_mm: 8, thickness_mm: 3, count: 4 }],
];

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useEditorStore.setState({
    location: { ...INITIAL_LOCATION },
    // A fresh deep copy: DEFAULT_PRINT_PARAMS is deep-frozen, so a shallow
    // spread would put frozen nested objects into live state and the first
    // `setNested` would throw.
    params: defaultPrintParams(),
    scene: { status: "idle", graph: null, message: null, request: null, stale: false },
    bake: { ...initialBakeState },
    presets: { status: "idle", items: [], message: null },
    placeDetect: { ...IDLE_PLACE_DETECT },
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

  it("starts on the 0.4 mm nozzle and never picks one up from elsewhere", () => {
    // A session that silently starts at 0.2 mm halves every minimum-feature
    // threshold and is invisible in the HUD, which only ever shows the derived
    // metres (DECISIONS [V2-P1]). The nozzle has exactly one source: the
    // frozen contract default, carried into the store and nothing else.
    expect(DEFAULT_PRINT_PARAMS.nozzle_mm).toBe(0.4);
    expect(useEditorStore.getState().params.nozzle_mm).toBe(0.4);
    expect(useEditorStore.getState().params).toEqual(DEFAULT_PRINT_PARAMS);
    // Choosing a preset moves the pin, never the printer settings.
    useEditorStore.getState().applyPreset({
      lat: 40.7128,
      lon: -74.006,
      radius_m: 1980,
      rotation_deg: 0,
      preset_id: "nyc-midtown",
    });
    expect(useEditorStore.getState().params.nozzle_mm).toBe(0.4);
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

// ==========================================================================
// Place resolution ([V3-P1]: preset > geocode > user override)
// ==========================================================================

/** A localStorage stand-in, the same shape `lib/groups.test.ts` uses. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: () => null,
    length: 0,
  };
}

describe("place resolution", () => {
  it("a preset click resolves the city name client-side, no fetch", () => {
    useEditorStore.getState().applyPreset({
      lat: 41.8827,
      lon: -87.6233,
      radius_m: 900,
      rotation_deg: 0,
      preset_id: "chicago-loop",
    });
    const state = useEditorStore.getState();
    expect(state.params.city_label).toBe("Chicago");
    expect(state.placeDetect).toEqual({
      status: "ready",
      source: "preset",
      detectedCity: "Chicago",
      overridden: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an unknown preset id leaves the label empty rather than guessing", () => {
    useEditorStore.getState().applyPreset({
      lat: 1,
      lon: 1,
      radius_m: 500,
      rotation_deg: 0,
      preset_id: "somewhere-else",
    });
    const state = useEditorStore.getState();
    expect(state.params.city_label).toBe("");
    expect(state.placeDetect.detectedCity).toBeNull();
    expect(state.placeDetect.source).toBe("none");
  });

  it("dropping a pin clears a previously auto-filled label and marks detection resolving", () => {
    useEditorStore.getState().applyPreset({
      lat: 41.8827,
      lon: -87.6233,
      radius_m: 900,
      rotation_deg: 0,
      preset_id: "chicago-loop",
    });
    expect(useEditorStore.getState().params.city_label).toBe("Chicago");

    useEditorStore.getState().setPin(48.8566, 2.3522);
    const state = useEditorStore.getState();
    expect(state.params.city_label).toBe("");
    expect(state.placeDetect.status).toBe("resolving");
    expect(state.placeDetect.detectedCity).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a pin drop never clears the user's own typed label", () => {
    useEditorStore.getState().setPlaceName("My favourite spot");
    useEditorStore.getState().setPin(48.8566, 2.3522);
    const state = useEditorStore.getState();
    expect(state.params.city_label).toBe("My favourite spot");
    expect(state.placeDetect.overridden).toBe(true);
  });

  it("setPlaceName marks the field overridden and writes city_label", () => {
    useEditorStore.getState().setPlaceName("Bergen");
    const state = useEditorStore.getState();
    expect(state.params.city_label).toBe("Bergen");
    expect(state.placeDetect.overridden).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an override survives a later preset click", () => {
    useEditorStore.getState().setPlaceName("My favourite spot");
    useEditorStore.getState().applyPreset({
      lat: 35.6896,
      lon: 139.7006,
      radius_m: 800,
      rotation_deg: 0,
      preset_id: "tokyo-shinjuku",
    });
    const state = useEditorStore.getState();
    expect(state.params.city_label).toBe("My favourite spot");
    // ...but the detected value the "reset to detected" affordance targets
    // still moves, so resetting later goes to Tokyo, not to whatever was
    // detected before the override.
    expect(state.placeDetect.detectedCity).toBe("Tokyo");
    expect(state.placeDetect.overridden).toBe(true);
  });

  it("resetPlaceNameToDetected restores the detected value and clears the override", () => {
    useEditorStore.getState().applyPreset({
      lat: 41.8827,
      lon: -87.6233,
      radius_m: 900,
      rotation_deg: 0,
      preset_id: "chicago-loop",
    });
    useEditorStore.getState().setPlaceName("Something else");
    expect(useEditorStore.getState().params.city_label).toBe("Something else");

    useEditorStore.getState().resetPlaceNameToDetected();
    const state = useEditorStore.getState();
    expect(state.params.city_label).toBe("Chicago");
    expect(state.placeDetect.overridden).toBe(false);
  });

  it("resetPlaceNameToDetected clears the field when nothing has been detected", () => {
    useEditorStore.getState().setPlaceName("Something else");
    useEditorStore.getState().resetPlaceNameToDetected();
    expect(useEditorStore.getState().params.city_label).toBe("");
  });

  describe("applyGeocodeResult", () => {
    it("fills the label and place from a successful geocode", () => {
      useEditorStore.getState().setPin(41.8827, -87.6233);
      useEditorStore.getState().applyGeocodeResult(41.8827, -87.6233, {
        city: "Chicago",
        state: "Illinois",
        country: "United States",
        neighbourhood: "The Loop",
      });
      const state = useEditorStore.getState();
      expect(state.params.city_label).toBe("Chicago");
      expect(state.params.place).toEqual({
        country: "United States",
        state: "Illinois",
        neighbourhood: "The Loop",
        author: "",
      });
      expect(state.placeDetect).toEqual({
        status: "ready",
        source: "geocode",
        detectedCity: "Chicago",
        overridden: false,
      });
    });

    it("a failed lookup (null) marks detection failed without inventing a city", () => {
      useEditorStore.getState().setPin(0, 0);
      useEditorStore.getState().applyGeocodeResult(0, 0, null);
      const state = useEditorStore.getState();
      expect(state.params.city_label).toBe("");
      expect(state.placeDetect.status).toBe("error");
      expect(state.placeDetect.detectedCity).toBeNull();
    });

    it("ignores a result for a pin that has since moved on", () => {
      useEditorStore.getState().setPin(41.8827, -87.6233);
      useEditorStore.getState().setPin(48.8566, 2.3522);
      useEditorStore.getState().applyGeocodeResult(41.8827, -87.6233, {
        city: "Chicago",
        state: null,
        country: null,
        neighbourhood: null,
      });
      const state = useEditorStore.getState();
      expect(state.params.city_label).toBe("");
      expect(state.placeDetect.detectedCity).toBeNull();
    });

    it("never overwrites a user override, but still updates the detected value and place fields", () => {
      useEditorStore.getState().setPlaceName("My favourite spot");
      useEditorStore.getState().applyGeocodeResult(
        useEditorStore.getState().location.lat,
        useEditorStore.getState().location.lon,
        { city: "Chicago", state: "Illinois", country: "United States", neighbourhood: "The Loop" },
      );
      const state = useEditorStore.getState();
      expect(state.params.city_label).toBe("My favourite spot");
      expect(state.params.place?.country).toBe("United States");
      expect(state.placeDetect.detectedCity).toBe("Chicago");
      expect(state.placeDetect.overridden).toBe(true);
    });

    it("never touches fetch itself: it only folds an already-fetched result in", () => {
      useEditorStore.getState().applyGeocodeResult(
        useEditorStore.getState().location.lat,
        useEditorStore.getState().location.lon,
        { city: "X", state: null, country: null, neighbourhood: null },
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("author", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("setAuthor writes params.place.author and persists to localStorage", () => {
      const storage = fakeStorage();
      vi.stubGlobal("window", { localStorage: storage });
      useEditorStore.getState().setAuthor("Vahid Alizadeh");
      expect(useEditorStore.getState().params.place?.author).toBe("Vahid Alizadeh");
      expect(storage.getItem("framecraft.author.v1")).toBe("Vahid Alizadeh");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("initAuthor prefills from localStorage once, without clobbering a real value", () => {
      vi.stubGlobal("window", { localStorage: fakeStorage({ "framecraft.author.v1": "Vahid Alizadeh" }) });
      useEditorStore.getState().initAuthor();
      expect(useEditorStore.getState().params.place?.author).toBe("Vahid Alizadeh");

      // A second call, after the field already carries a value (e.g. from a
      // shared link), must not stomp on it.
      useEditorStore.getState().setAuthor("Someone Else");
      vi.stubGlobal("window", { localStorage: fakeStorage({ "framecraft.author.v1": "Vahid Alizadeh" }) });
      useEditorStore.getState().initAuthor();
      expect(useEditorStore.getState().params.place?.author).toBe("Someone Else");
    });

    it("does nothing when there is nothing stored", () => {
      vi.stubGlobal("window", { localStorage: fakeStorage() });
      useEditorStore.getState().initAuthor();
      expect(useEditorStore.getState().params.place?.author).toBe("");
    });

    it("initAuthor is a no-op without a window", () => {
      vi.stubGlobal("window", undefined);
      expect(() => useEditorStore.getState().initAuthor()).not.toThrow();
    });
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

// ==========================================================================
// Hero buildings and nested parameter writes ([V2-P4])
// ==========================================================================

describe("hero buildings", () => {
  it("toggles an id on and off, through setParam and never the network", async () => {
    const store = useEditorStore.getState();
    store.toggleHero("w7");
    expect(useEditorStore.getState().params.hero_building_ids).toEqual(["w7"]);
    store.toggleHero("w9");
    expect(useEditorStore.getState().params.hero_building_ids).toEqual(["w7", "w9"]);
    store.toggleHero("w7");
    expect(useEditorStore.getState().params.hero_building_ids).toEqual(["w9"]);
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses the thirteenth and raises the cap flag", () => {
    const store = useEditorStore.getState();
    for (let i = 0; i < HERO_CAP; i += 1) store.toggleHero(`w${i}`);
    expect(useEditorStore.getState().params.hero_building_ids).toHaveLength(HERO_CAP);
    expect(useEditorStore.getState().heroCapHit).toBe(false);

    store.toggleHero("one-more");
    expect(useEditorStore.getState().heroCapHit).toBe(true);
    expect(useEditorStore.getState().params.hero_building_ids).toHaveLength(HERO_CAP);
    expect(useEditorStore.getState().params.hero_building_ids).not.toContain("one-more");

    // Making room clears the flag again.
    store.toggleHero("w0");
    expect(useEditorStore.getState().heroCapHit).toBe(false);
  });

  it("clears the whole list, and a reset clears the flag with it", () => {
    const store = useEditorStore.getState();
    for (let i = 0; i <= HERO_CAP; i += 1) store.toggleHero(`w${i}`);
    expect(useEditorStore.getState().heroCapHit).toBe(true);

    store.resetParams();
    expect(useEditorStore.getState().params.hero_building_ids).toEqual([]);
    expect(useEditorStore.getState().heroCapHit).toBe(false);

    store.toggleHero("w1");
    store.clearHeroes();
    expect(useEditorStore.getState().params.hero_building_ids).toEqual([]);
  });

  it("retires a finished bake, because a hero changes the geometry", () => {
    useEditorStore.setState({
      bake: { ...initialBakeState, phase: "done", jobId: "job-1", stale: false },
    });
    useEditorStore.getState().toggleHero("w3");
    expect(useEditorStore.getState().bake.stale).toBe(true);
  });
});

describe("setNested", () => {
  it("patches one field and leaves the rest of the object alone", () => {
    useEditorStore.getState().setNested("north_arrow", { enabled: true });
    const arrow = useEditorStore.getState().params.north_arrow;
    expect(arrow?.enabled).toBe(true);
    expect(arrow?.corner).toBe(DEFAULT_PRINT_PARAMS.north_arrow?.corner);
    expect(arrow?.size_mm).toBe(DEFAULT_PRINT_PARAMS.north_arrow?.size_mm);
  });

  it("writes a NEW object every time, so a memo can see the change", () => {
    const before = useEditorStore.getState().params.scale_bar;
    useEditorStore.getState().setNested("scale_bar", { enabled: true });
    const after = useEditorStore.getState().params.scale_bar;
    expect(after).not.toBe(before);
    // ...and the contract default was not mutated in place.
    expect(DEFAULT_PRINT_PARAMS.scale_bar?.enabled).toBe(false);
  });

  it("never makes a server call", async () => {
    const store = useEditorStore.getState();
    store.setNested("underside_mark", { enabled: true, template: "{coords}" });
    store.setNested("part_colors", { water: "#123456" });
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useEditorStore.getState().params.part_colors?.water).toBe("#123456");
    // The other six slots are untouched.
    expect(useEditorStore.getState().params.part_colors?.base).toBe(
      DEFAULT_PRINT_PARAMS.part_colors?.base,
    );
  });
});

// ==========================================================================
// The frozen defaults may never be aliased into live state ([V2-P4])
// ==========================================================================

describe("the params object the store hands out", () => {
  /** Every PrintParams value that is an object or an array. */
  const nestedKeys = (): Array<keyof PrintParams> =>
    (Object.keys(DEFAULT_PRINT_PARAMS) as Array<keyof PrintParams>).filter(
      (key) => typeof DEFAULT_PRINT_PARAMS[key] === "object",
    );

  it("has nested objects to worry about in the first place", () => {
    // Guards the guard: if the contract ever loses its nested fields, the
    // assertions below would pass for the wrong reason.
    expect(nestedKeys().sort()).toEqual(
      [
        "part_colors",
        "engravings",
        "north_arrow",
        "scale_bar",
        "underside_mark",
        "hero_building_ids",
        // schema_version 3 additions.
        "place",
        "regions",
        "colour",
        "custom_profile",
        "terrain",
        "heights",
        "bridges",
        "height_exaggeration",
        "hero_auto",
        "tiling",
        "frame_style",
        "hanger_magnet",
      ].sort(),
    );
  });

  it("shares no nested reference with the frozen constant, initially", () => {
    const params = useEditorStore.getState().params;
    for (const key of nestedKeys()) {
      expect(params[key], key).toEqual(DEFAULT_PRINT_PARAMS[key]);
      expect(params[key], `${key} is aliased to the frozen default`).not.toBe(
        DEFAULT_PRINT_PARAMS[key],
      );
    }
  });

  it("shares no nested reference with the frozen constant after a reset", () => {
    const store = useEditorStore.getState();
    store.setNested("north_arrow", { enabled: true });
    store.toggleHero("w1");
    const before = useEditorStore.getState().params;

    store.resetParams();
    const after = useEditorStore.getState().params;

    expect(after).toEqual(DEFAULT_PRINT_PARAMS);
    for (const key of nestedKeys()) {
      expect(after[key], `${key} is aliased to the frozen default`).not.toBe(
        DEFAULT_PRINT_PARAMS[key],
      );
      // ...nor to the object it just replaced.
      expect(after[key], `${key} survived the reset by reference`).not.toBe(
        before[key],
      );
    }
  });

  it("survives a nested write after a reset, i.e. nothing frozen leaked in", () => {
    // The real failure this prevents: with a shallow spread, `params.part_colors`
    // IS the frozen object, and the first write throws in strict mode.
    useEditorStore.getState().resetParams();
    expect(() =>
      useEditorStore.getState().setNested("part_colors", { water: "#010203" }),
    ).not.toThrow();
    expect(useEditorStore.getState().params.part_colors?.water).toBe("#010203");
    // The constant itself is untouched.
    expect(DEFAULT_PRINT_PARAMS.part_colors?.water).toBe("#2F7FC1");
  });

  it("keeps the frozen constant frozen, so a stray write cannot corrupt it", () => {
    expect(Object.isFrozen(DEFAULT_PRINT_PARAMS)).toBe(true);
    for (const key of nestedKeys()) {
      expect(Object.isFrozen(DEFAULT_PRINT_PARAMS[key]), key).toBe(true);
    }
    // ...and the factory's copies are not frozen, or the editor could not work.
    expect(Object.isFrozen(defaultPrintParams())).toBe(false);
  });
});

// ==========================================================================
// Shared configuration ([V2-P6])
// ==========================================================================

describe("a shared link", () => {
  const shared = (
    request: Partial<SceneRequest> = {},
    params: Partial<PrintParams> = {},
  ): string =>
    encodeShare(
      { lat: 51.5, lon: -0.12, radius_m: 1200, rotation_deg: 30, preset_id: null, ...request },
      { ...defaultPrintParams(), ...params },
    );

  beforeEach(() => {
    useEditorStore.setState({ shareNotice: null });
  });

  it("restores the location and every parameter it names", () => {
    const outcome = useEditorStore
      .getState()
      .loadShared(
        `?s=${shared({}, { city_label: "London", plate_mm: 220, hanger: "keyhole" })}`,
      );
    expect(outcome).toBe("applied");

    const state = useEditorStore.getState();
    expect(state.location.lat).toBe(51.5);
    expect(state.location.lon).toBe(-0.12);
    expect(state.location.radius_m).toBe(1200);
    expect(state.location.rotation_deg).toBe(30);
    expect(state.params.city_label).toBe("London");
    expect(state.params.plate_mm).toBe(220);
    expect(state.params.hanger).toBe("keyhole");
    // Everything the link did not name is back at the contract default.
    expect(state.params.nozzle_mm).toBe(DEFAULT_PRINT_PARAMS.nozzle_mm);
    expect(state.shareNotice).toBeNull();
  });

  it("marks the scene stale and does NOT fetch", () => {
    // Opening a link in a background tab is not consent to a live Overpass
    // query. Generate is the user's move, exactly as it is after a moved pin.
    useEditorStore.getState().loadShared(`?s=${shared()}`);
    expect(fetchSpy).not.toHaveBeenCalled();
    const state = useEditorStore.getState();
    expect(state.scene.stale).toBe(true);
    expect(state.scene.graph).toBeNull();
    expect(state.scene.status).toBe("idle");
  });

  it("retires a finished bake, like every other parameter change", () => {
    useEditorStore.setState({
      bake: reduceBake(bakeStarted("job-1"), {
        job_id: "job-1",
        status: "done",
        files: { "3mf": "http://x/a.3mf", stl: "http://x/a.stl" },
        stats: null,
        warnings: [],
      }),
    });
    useEditorStore.getState().loadShared(`?s=${shared()}`);
    expect(useEditorStore.getState().bake.stale).toBe(true);
    expect(bakeDownloadLinks(useEditorStore.getState().bake)).toEqual([]);
  });

  it("does not light a preset chip for a scene nobody has fetched", () => {
    useEditorStore.getState().loadShared(`?s=${shared({ preset_id: "chicago-loop" })}`);
    const state = useEditorStore.getState();
    expect(state.location.preset_id).toBe("chicago-loop");
    expect(state.presetChosen).toBe(false);
    expect(activePresetId(state)).toBeNull();
  });

  it("leaves the editor on its defaults when the link is damaged, and says so", () => {
    const before = useEditorStore.getState().params;
    const handled = useEditorStore.getState().loadShared("?s=v9.abcd.0000");
    // `refused`, not merely "handled": it is what tells `EditorShell` to take
    // the bad payload back out of the address bar, so a reload does not bring
    // the same refusal back forever on a bookmarked URL.
    expect(handled).toBe("refused");
    const state = useEditorStore.getState();
    expect(state.params).toEqual(before);
    expect(state.location).toEqual(INITIAL_LOCATION);
    expect(state.scene.stale).toBe(false);
    expect(state.shareNotice).toContain("different version");
    // ...and it can be dismissed once read.
    state.setShareNotice(null);
    expect(useEditorStore.getState().shareNotice).toBeNull();
  });

  it("does nothing at all when there is no payload in the URL", () => {
    expect(useEditorStore.getState().loadShared("")).toBe("none");
    expect(useEditorStore.getState().loadShared("?other=1")).toBe("none");
    expect(useEditorStore.getState().scene.stale).toBe(false);
    expect(useEditorStore.getState().shareNotice).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("clamps a radius the contract could not accept", () => {
    // The payload is validated before it gets here, but `applyShared` is also
    // a public action: it snaps to the same 10 m grid `setRadius` does.
    useEditorStore.getState().applyShared(
      { lat: 0, lon: 0, radius_m: 1234, rotation_deg: 400, preset_id: null },
      defaultPrintParams(),
    );
    const state = useEditorStore.getState();
    expect(state.location.radius_m).toBe(1230);
    expect(state.location.rotation_deg).toBe(360);
  });

  it("round-trips whatever the editor currently holds", () => {
    const store = useEditorStore.getState();
    store.setParam("city_label", "Bergen");
    store.setParam("color_mode", "parts");
    store.setNested("part_colors", { water: "#123456" });
    store.setParam("engravings", [{ edge: "top", text: "{city}", size_mm: 6 }]);
    store.toggleHero("w7");
    store.setRadius(1500);

    const current = useEditorStore.getState();
    const payload = encodeShare(locationToRequest(current.location), current.params);
    useEditorStore.getState().resetParams();
    useEditorStore.getState().loadShared(`?s=${payload}`);

    const restored = useEditorStore.getState();
    expect(restored.params).toEqual(current.params);
    expect(locationToRequest(restored.location)).toEqual(
      locationToRequest(current.location),
    );
  });
});
