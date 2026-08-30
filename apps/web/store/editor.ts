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
import { DEFAULT_PRINT_PARAMS, defaultPrintParams } from "@/lib/contracts";
import type { PrintParams, SceneGraph, SceneRequest } from "@/lib/contracts";
import { RADIUS_MAX_M, RADIUS_MIN_M, snapRadius } from "@/lib/geo";
import { toggleHeroId } from "@/lib/heroes";
import { decodeShare, readShareParam } from "@/lib/share";
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

/**
 * The PrintParams fields that are objects rather than scalars. They must be
 * written immutably (a mutated nested object would keep the same identity and
 * a memo keyed on it would never notice), which is what `setNested` is for.
 */
export type NestedParamKey =
  | "part_colors"
  | "north_arrow"
  | "scale_bar"
  | "underside_mark";

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
  /**
   * True when the last hero click was refused because twelve are already
   * picked (the contract's `hero_building_ids.maxItems`). UI-only, so it is
   * NOT a PrintParams field and never reaches the wire.
   */
  heroCapHit: boolean;
  /**
   * Whether the adjustments drawer is open. It lives here, not in the chip,
   * because the chip is rendered inside the client-only preview while the
   * global Escape handler and the shortcut suppression both live in
   * `EditorShell` -- Escape has to close a drawer whatever has focus.
   */
  adjustmentsOpen: boolean;
  /**
   * Why a shared link was not applied, or null. Informational: a rejected link
   * leaves the editor on its defaults rather than half-restored, and saying
   * nothing about it would look like the link simply did nothing.
   */
  shareNotice: string | null;

  // --- location (these four are the ONLY things that refetch /scene) ---
  setPin: (lat: number, lon: number) => void;
  setRadius: (radiusM: number) => void;
  setRotation: (deg: number) => void;
  applyPreset: (preset: SceneRequest) => void;

  // --- print params (never touch the network) ---
  setParam: <K extends keyof PrintParams>(key: K, value: PrintParams[K]) => void;
  /** Patch one field of a nested PrintParams object, immutably. */
  setNested: <K extends NestedParamKey>(
    key: K,
    patch: Partial<NonNullable<PrintParams[K]>>,
  ) => void;
  resetParams: () => void;

  // --- hero buildings (a click in the preview; still just a param write) ---
  toggleHero: (id: string) => void;
  clearHeroes: () => void;

  // --- shared configuration (a URL payload; still never a fetch) ---
  applyShared: (request: SceneRequest, params: PrintParams) => void;
  /**
   * Read `?s=` out of a query string. `none` when there was no payload;
   * `refused` is what tells the caller to take the bad payload back out of the
   * address bar, so a reload does not resurrect the same refusal forever.
   */
  loadShared: (search: string) => "none" | "applied" | "refused";
  setShareNotice: (message: string | null) => void;

  // --- transient UI ---
  setAdjustmentsOpen: (open: boolean) => void;

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
  // `defaultPrintParams()`, never a shallow spread: DEFAULT_PRINT_PARAMS is
  // deep-frozen, and a spread would alias its nested v2 objects (part_colors,
  // engravings, north_arrow, scale_bar, underside_mark, hero_building_ids)
  // into live state, where the first write would throw.
  params: defaultPrintParams(),
  scene: { ...IDLE_SCENE },
  bake: { ...initialBakeState },
  presets: { status: "idle", items: [], message: null },
  theme: "light",
  presetChosen: false,
  heroCapHit: false,
  adjustmentsOpen: false,
  shareNotice: null,

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

  // Every nested write goes through `setParam` too, so bake staleness and the
  // `previewDeps` memo keys keep working exactly as they do for a slider.
  setNested: (key, patch) => {
    const current = get().params[key] ?? DEFAULT_PRINT_PARAMS[key];
    get().setParam(key, { ...(current as object), ...patch } as never);
  },

  resetParams: () =>
    set((state) => ({
      // A fresh deep copy, so a reset never hands the editor a nested object
      // shared with the frozen constant or with the state it just replaced.
      params: defaultPrintParams(),
      bake: markBakeStale(state.bake),
      heroCapHit: false,
    })),

  /**
   * Add or remove a hero, capped at the contract's `maxItems`.
   *
   * A refused click is not silent: `heroCapHit` turns the cap notice on in the
   * Buildings group. Removing a hero clears it again, because the list is no
   * longer full.
   */
  toggleHero: (id) => {
    const result = toggleHeroId(get().params.hero_building_ids ?? [], id);
    if (result.capHit) {
      set({ heroCapHit: true });
      return;
    }
    set({ heroCapHit: false });
    get().setParam("hero_building_ids", result.ids);
  },

  clearHeroes: () => {
    set({ heroCapHit: false });
    get().setParam("hero_building_ids", []);
  },

  /**
   * Restore a whole editor state from a shared link.
   *
   * Deliberately NOT a fetch. A link describes a model; generating it is a
   * live Overpass query at whatever location it names, and auto-running one on
   * page load would make opening a link in a background tab a server request
   * nobody asked for. The scene is marked stale instead, which is exactly the
   * state a moved pin leaves behind: Generate is enabled and says "Generate".
   *
   * `presetChosen` stays false even when the link names a preset: the chip may
   * only light up once something real backs it (`activePresetId`).
   */
  applyShared: (request, params) =>
    set((state) => ({
      location: {
        lat: request.lat,
        lon: request.lon,
        radius_m: snapRadius(request.radius_m),
        rotation_deg: Math.min(360, Math.max(0, Math.round(request.rotation_deg))),
        preset_id: request.preset_id ?? null,
      },
      params,
      scene: { ...state.scene, stale: true },
      bake: markBakeStale(state.bake),
      presetChosen: false,
      heroCapHit: false,
      shareNotice: null,
    })),

  loadShared: (search) => {
    const payload = readShareParam(search);
    if (payload === null) return "none";
    const decoded = decodeShare(payload);
    if (!decoded.ok) {
      // Rejected links leave the editor on its defaults, on purpose: a
      // half-applied configuration is the one outcome the user cannot see.
      set({ shareNotice: decoded.reason });
      return "refused";
    }
    get().applyShared(decoded.request, decoded.params);
    return "applied";
  },

  setShareNotice: (message) => set({ shareNotice: message }),

  setAdjustmentsOpen: (open) => set({ adjustmentsOpen: open }),

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
