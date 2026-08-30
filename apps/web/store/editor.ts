/**
 * The editor store.
 *
 * One zustand store holds everything the editor UI needs: where the pin is,
 * every PrintParams value, the fetched SceneGraph, and the bake job.
 *
 * The rule that shapes this file (01 step 4, 02 "Performance budgets"):
 *
 *   **Only `lat`, `lon`, `radius_m` and `rotation_deg` may cause a network
 *   call.** Every PrintParams control writes to the store and nothing else;
 *   the preview recomputes from the SceneGraph already in memory. There is a
 *   test (`store/editor.test.ts`) that fails if any `setParam` ever touches
 *   `fetch`.
 *
 * `rotation_deg` counts as a location change because the crop happens
 * server-side (DECISIONS [P0]), so moving it marks the scene stale and the UI
 * re-generates when the slider is released.
 */

import { create } from "zustand";

import {
  ApiError,
  fetchBakeResult,
  fetchPresets,
  fetchScene,
  startBake,
} from "@/lib/api";
import {
  POLL_INTERVAL_MS,
  bakeFailedLocally,
  bakeStarted,
  initialBakeState,
  markBakeStale,
  reduceBake,
  shouldPoll,
  type BakeState,
} from "@/lib/bake";
import { DEFAULT_PRINT_PARAMS } from "@/lib/contracts";
import type { PrintParams, SceneGraph, SceneRequest } from "@/lib/contracts";
import { RADIUS_MAX_M, RADIUS_MIN_M, snapRadius } from "@/lib/geo";
import { bakeBlockReason } from "@/lib/warnings";

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "framecraft-theme";

/** Everything that, when changed, invalidates the SceneGraph. */
export interface LocationState {
  lat: number;
  lon: number;
  radius_m: number;
  rotation_deg: number;
  preset_id: string | null;
}

export type SceneStatus = "idle" | "loading" | "ready" | "error";

export interface SceneState {
  status: SceneStatus;
  graph: SceneGraph | null;
  /** Error text when `status === "error"`. */
  message: string | null;
  /** The SceneRequest that produced `graph`; the bake must reuse it verbatim. */
  request: SceneRequest | null;
  /** True when the location moved after the last successful Generate. */
  stale: boolean;
}

export type PresetsStatus = "idle" | "loading" | "ready" | "error";

export interface PresetsState {
  status: PresetsStatus;
  items: SceneRequest[];
  message: string | null;
}

export interface EditorState {
  location: LocationState;
  params: PrintParams;
  scene: SceneState;
  bake: BakeState;
  presets: PresetsState;
  theme: Theme;
  /**
   * True once the user has clicked a preset chip in THIS session. `location`
   * starts on the Chicago Loop preset, so without this flag every fresh page
   * load highlights a chip for a scene that was never fetched.
   */
  presetChosen: boolean;

  // --- location (these four are the ONLY things that refetch /scene) ---
  setPin: (lat: number, lon: number) => void;
  setRadius: (radiusM: number) => void;
  setRotation: (deg: number) => void;
  applyPreset: (preset: SceneRequest) => void;

  // --- print params (never touch the network) ---
  setParam: <K extends keyof PrintParams>(key: K, value: PrintParams[K]) => void;
  resetParams: () => void;

  // --- theme ---
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  initTheme: () => void;

  // --- server flows ---
  loadPresets: () => Promise<void>;
  generate: () => Promise<void>;
  requestBake: () => Promise<void>;
  pollBakeOnce: () => Promise<void>;
  stopBakePolling: () => void;
}

/** The initial pin: the Chicago Loop preset (DECISIONS [P1] preset ids). */
export const INITIAL_LOCATION: LocationState = {
  lat: 41.8827,
  lon: -87.6233,
  radius_m: 900,
  rotation_deg: 0,
  preset_id: "chicago-loop",
};

const IDLE_SCENE: SceneState = {
  status: "idle",
  graph: null,
  message: null,
  request: null,
  stale: false,
};

/** The SceneRequest implied by the current pin. */
export function locationToRequest(location: LocationState): SceneRequest {
  return {
    lat: location.lat,
    lon: location.lon,
    radius_m: location.radius_m,
    rotation_deg: location.rotation_deg,
    preset_id: location.preset_id,
  };
}

/**
 * Which preset chip may render as active.
 *
 * The store's `location.preset_id` alone is not enough: it starts on
 * `chicago-loop` (INITIAL_LOCATION), so on a fresh page load the chip would
 * claim a scene that has never been fetched. A chip is active only once the
 * preset is backed by something real -- a SceneGraph in memory, or an explicit
 * click this session (which is always followed by a `generate()`).
 */
export function activePresetId(state: EditorState): string | null {
  if (!state.presetChosen && state.scene.graph === null) return null;
  return state.location.preset_id;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Non-reactive handles. These live outside the store because re-rendering on a
 * timer id or an AbortController would be noise.
 */
let sceneAbort: AbortController | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

export const useEditorStore = create<EditorState>()((set, get) => ({
  location: { ...INITIAL_LOCATION },
  params: { ...DEFAULT_PRINT_PARAMS },
  scene: { ...IDLE_SCENE },
  bake: { ...initialBakeState },
  presets: { status: "idle", items: [], message: null },
  theme: "light",
  presetChosen: false,

  setPin: (lat, lon) =>
    set((state) => ({
      location: { ...state.location, lat, lon, preset_id: null },
      scene: { ...state.scene, stale: true },
      bake: markBakeStale(state.bake),
      presetChosen: false,
    })),

  setRadius: (radiusM) =>
    set((state) => ({
      location: { ...state.location, radius_m: snapRadius(radiusM) },
      scene: { ...state.scene, stale: true },
      bake: markBakeStale(state.bake),
    })),

  setRotation: (deg) => {
    const normalised = Math.min(360, Math.max(0, Math.round(deg)));
    set((state) => ({
      location: { ...state.location, rotation_deg: normalised },
      scene: { ...state.scene, stale: true },
      bake: markBakeStale(state.bake),
    }));
  },

  applyPreset: (preset) =>
    set((state) => ({
      location: {
        lat: preset.lat,
        lon: preset.lon,
        radius_m: Math.min(RADIUS_MAX_M, Math.max(RADIUS_MIN_M, preset.radius_m)),
        rotation_deg: preset.rotation_deg,
        preset_id: preset.preset_id ?? null,
      },
      scene: { ...state.scene, stale: true },
      bake: markBakeStale(state.bake),
      presetChosen: true,
    })),

  // A slider move is a pure state write. No fetch, and the SCENE is unaffected
  // by every one of these parameters -- but a finished BAKE is not: the file on
  // the server was built from the old values, so it stops being offered.
  setParam: (key, value) =>
    set((state) => ({
      params: { ...state.params, [key]: value },
      bake: markBakeStale(state.bake),
    })),

  resetParams: () =>
    set((state) => ({
      params: { ...DEFAULT_PRINT_PARAMS },
      bake: markBakeStale(state.bake),
    })),

  setTheme: (theme) => {
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.style.colorScheme = theme;
    }
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, theme);
      } catch {
        // private mode / storage disabled: the in-memory theme still works
      }
    }
    set({ theme });
  },

  toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),

  /** Adopt whatever the pre-paint script in layout.tsx already decided. */
  initTheme: () => {
    if (typeof document === "undefined") return;
    const theme: Theme = document.documentElement.classList.contains("dark")
      ? "dark"
      : "light";
    set({ theme });
  },

  loadPresets: async () => {
    set((state) => ({ presets: { ...state.presets, status: "loading", message: null } }));
    try {
      const items = await fetchPresets();
      set({ presets: { status: "ready", items, message: null } });
    } catch (error) {
      set({ presets: { status: "error", items: [], message: errorMessage(error) } });
    }
  },

  generate: async () => {
    const request = locationToRequest(get().location);
    sceneAbort?.abort();
    sceneAbort = new AbortController();
    const controller = sceneAbort;

    set((state) => ({
      scene: { ...state.scene, status: "loading", message: null },
    }));
    try {
      const graph = await fetchScene(request, controller.signal);
      if (controller.signal.aborted) return;
      // A new SceneGraph invalidates a finished bake for the same reason a
      // slider does: the geometry on the server is no longer this geometry.
      set((state) => ({
        scene: { status: "ready", graph, message: null, request, stale: false },
        bake: markBakeStale(state.bake),
      }));
    } catch (error) {
      if (controller.signal.aborted) return;
      set((state) => ({
        scene: {
          ...state.scene,
          status: "error",
          message: errorMessage(error),
          stale: true,
        },
      }));
    }
  },

  requestBake: async () => {
    const { scene, params } = get();
    // Includes 04's 60 mm ceiling, which the server would refuse anyway; this
    // is pure arithmetic over the scene already in memory, never a request.
    const blocked = bakeBlockReason(scene.graph, params);
    if (blocked) {
      set({ bake: bakeFailedLocally(initialBakeState, blocked) });
      return;
    }
    const request = scene.request ?? locationToRequest(get().location);
    get().stopBakePolling();
    set({ bake: { ...initialBakeState, phase: "queued" } });
    try {
      const { job_id } = await startBake(request, params);
      set({ bake: bakeStarted(job_id) });
      schedulePoll(get);
    } catch (error) {
      set((state) => ({ bake: bakeFailedLocally(state.bake, errorMessage(error)) }));
    }
  },

  pollBakeOnce: async () => {
    const { jobId } = get().bake;
    if (!jobId) return;
    try {
      const result = await fetchBakeResult(jobId);
      set((state) => ({ bake: reduceBake(state.bake, result) }));
    } catch (error) {
      set((state) => ({ bake: bakeFailedLocally(state.bake, errorMessage(error)) }));
    }
  },

  stopBakePolling: () => {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  },
}));

/** Poll `GET /bake/{id}` once a second until the job reaches a terminal state. */
function schedulePoll(get: () => EditorState): void {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void get()
      .pollBakeOnce()
      .then(() => {
        if (shouldPoll(get().bake)) schedulePoll(get);
      });
  }, POLL_INTERVAL_MS);
}
