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
  resolveParamsForBake,
  shouldPoll,
  type BakeState,
} from "@/lib/bake";
import { DEFAULT_PRINT_PARAMS, defaultPrintParams } from "@/lib/contracts";
import type { PrintParams, SceneGraph, SceneRequest } from "@/lib/contracts";
import type { GeocodeResult } from "@/lib/geocode";
import { RADIUS_MAX_M, RADIUS_MIN_M, snapRadius } from "@/lib/geo";
import { toggleHeroId } from "@/lib/heroes";
import { presetCityName } from "@/lib/presets";
import { textTokenContext } from "@/lib/previewText";
import { decodeShare, readShareParam } from "@/lib/share";
import { bakeBlockReason } from "@/lib/warnings";

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "framecraft-theme";

/**
 * Where the last known author name is remembered ACROSS sessions and across a
 * `resetParams()`, so a fresh page (or a reset) does not lose it. The LIVE
 * value that actually reaches the bake and the preview is always
 * `params.place.author` (the frozen v3 wire field); this is only ever read to
 * PREFILL that field, once, on the store's own init.
 */
export const AUTHOR_STORAGE_KEY = "framecraft.author.v1";

/** Everything that, when changed, invalidates the SceneGraph. */
export interface LocationState {
  lat: number;
  lon: number;
  radius_m: number;
  rotation_deg: number;
  preset_id: string | null;
}

/**
 * Where the current Place name field's PREFILL comes from, and whether the
 * user has since typed their own text over it.
 *
 * Deliberately separate from `PrintParams.place` (the wire field carrying
 * country/state/neighbourhood/author): this is about `params.city_label`
 * specifically, and it exists only so a resolution that lands AFTER the user
 * already typed something never overwrites them ("user edits always win"),
 * while a "reset to detected" affordance still has something to reset TO.
 */
export interface PlaceDetectState {
  status: "idle" | "resolving" | "ready" | "error";
  source: "preset" | "geocode" | "none";
  /** The city name a preset or a geocode last resolved, or null. */
  detectedCity: string | null;
  /** True once the user has typed into the Place name field themselves. */
  overridden: boolean;
}

export const IDLE_PLACE_DETECT: PlaceDetectState = {
  status: "idle",
  source: "none",
  detectedCity: null,
  overridden: false,
};

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
  | "underside_mark"
  | "place";

export interface EditorState {
  location: LocationState;
  params: PrintParams;
  scene: SceneState;
  bake: BakeState;
  presets: PresetsState;
  /** Where the Place name field's prefill comes from ([V3-P1]). */
  placeDetect: PlaceDetectState;
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

  // --- place resolution ([V3-P1]: preset > geocode > user override) --------
  /**
   * A reverse geocode landed (or failed: `result === null`) for `(lat, lon)`.
   * A result for a pin that has since moved elsewhere is ignored. Fills
   * `city_label` from `result.city` UNLESS the user has since overridden it;
   * always updates `place.country/state/neighbourhood` (there is no override
   * UI for those three, so a fresh detection always wins for them).
   */
  applyGeocodeResult: (lat: number, lon: number, result: GeocodeResult | null) => void;
  /** The user typed into the Place name field: their text wins from now on. */
  setPlaceName: (value: string) => void;
  /** The "reset to detected" affordance: back to the preset/geocode value. */
  resetPlaceNameToDetected: () => void;
  /** The Author field, persisted into `params.place.author`. */
  setAuthor: (value: string) => void;
  /** Prefill the Author field from localStorage once, after mount. */
  initAuthor: () => void;

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
  placeDetect: { ...IDLE_PLACE_DETECT },
  theme: "light",
  presetChosen: false,
  heroCapHit: false,
  adjustmentsOpen: false,
  shareNotice: null,

  setPin: (lat, lon) =>
    set((state) => {
      // A previously auto-filled label describes the OLD pin and would be
      // wrong for the new one; a user's own typed text survives the move
      // (DECISIONS [V3-P1] - "user edits always win").
      const clearLabel =
        !state.placeDetect.overridden && (state.params.city_label ?? "") !== "";
      return {
        location: { ...state.location, lat, lon, preset_id: null },
        scene: { ...state.scene, stale: true },
        bake: markBakeStale(state.bake),
        presetChosen: false,
        placeDetect: {
          status: "resolving",
          source: "none",
          detectedCity: null,
          overridden: state.placeDetect.overridden,
        },
        params: clearLabel ? { ...state.params, city_label: "" } : state.params,
      };
    }),

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
    set((state) => {
      // A preset resolves its city name from `lib/presets.ts` alone -- no
      // Nominatim round trip needed, since the place it names is already
      // known (DECISIONS [V3-P1]).
      const cityName = presetCityName(preset.preset_id);
      const overridden = state.placeDetect.overridden;
      return {
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
        placeDetect: {
          status: cityName !== null ? "ready" : "idle",
          source: cityName !== null ? "preset" : "none",
          detectedCity: cityName,
          overridden,
        },
        // Never overwrites a user's own typed Place name.
        params: overridden ? state.params : { ...state.params, city_label: cityName ?? "" },
      };
    }),

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
      // Deliberately does NOT touch `placeDetect`: a reset clears the typed
      // text back to "" and leaves it there (it does not re-detect), the same
      // way it clears every other field back to the contract default without
      // re-running whatever produced the value that was there before.
      params: defaultPrintParams(),
      bake: markBakeStale(state.bake),
      heroCapHit: false,
    })),

  applyGeocodeResult: (lat, lon, result) =>
    set((state) => {
      // A result for a pin that has since moved on to somewhere else: the
      // debounce/queue in `lib/geocode.ts` cannot cancel a request already in
      // flight, so the guard lives here instead.
      if (state.location.lat !== lat || state.location.lon !== lon) return state;
      const city = result?.city ?? null;
      const place = state.params.place ?? DEFAULT_PRINT_PARAMS.place;
      return {
        placeDetect: {
          status: result !== null ? "ready" : "error",
          source: result !== null ? "geocode" : "none",
          detectedCity: city,
          overridden: state.placeDetect.overridden,
        },
        params: {
          ...state.params,
          place: {
            ...place,
            country: result?.country ?? "",
            state: result?.state ?? "",
            neighbourhood: result?.neighbourhood ?? "",
          },
          // Never overwrites a user's own typed Place name.
          city_label: state.placeDetect.overridden ? state.params.city_label : (city ?? ""),
        },
        bake: markBakeStale(state.bake),
      };
    }),

  setPlaceName: (value) =>
    set((state) => ({
      placeDetect: { ...state.placeDetect, overridden: true },
      params: { ...state.params, city_label: value },
      bake: markBakeStale(state.bake),
    })),

  resetPlaceNameToDetected: () =>
    set((state) => ({
      placeDetect: { ...state.placeDetect, overridden: false },
      params: { ...state.params, city_label: state.placeDetect.detectedCity ?? "" },
      bake: markBakeStale(state.bake),
    })),

  setAuthor: (value) => {
    get().setNested("place", { author: value });
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(AUTHOR_STORAGE_KEY, value);
      } catch {
        // private mode / storage disabled: the in-memory value still works
        // for this session, same fallback `setTheme` already uses.
      }
    }
  },

  initAuthor: () => {
    if (typeof window === "undefined") return;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(AUTHOR_STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (!stored) return;
    // Never clobber a real value already on the params (e.g. a shared link
    // applied before this runs).
    if ((get().params.place?.author ?? "") !== "") return;
    get().setNested("place", { author: stored });
  },

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
      // A non-empty label the link itself carried is deliberate data (typed
      // or already resolved by whoever made the link) and must survive a
      // later geocode landing for these coordinates; an empty one is free for
      // a preset lookup or a geocode to fill in exactly as if this were a
      // fresh pin.
      placeDetect: {
        status: "idle",
        source: "none",
        detectedCity: null,
        overridden: (params.city_label ?? "") !== "",
      },
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
    // Token expansion happens once, client-side (DECISIONS [V3-P1]): every
    // engraving line and the underside template are fully resolved against
    // THIS scene before the request goes out, so the bake never has to guess
    // what an empty engraving meant and the {country}/{state}/{neighbourhood}
    // /{author}/{hero} tokens -- which the frozen contract gives the server no
    // way to resolve on its own -- carry real text.
    const today = new Date().toISOString().slice(0, 10);
    const ctx = textTokenContext(scene.graph, params, today);
    const resolvedParams = resolveParamsForBake(params, ctx);
    try {
      const { job_id } = await startBake(request, resolvedParams);
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
