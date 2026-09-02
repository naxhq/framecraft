/**
 * The editor store.
 *
 * One zustand store holds everything the editor UI needs: where the pin is,
 * every PrintParams value, the fetched SceneGraph, the live engine result,
 * and the export/download state. Since FrameCraft v3 E4 this store no longer
 * calls `services/bake` at all: ingest (`buildScene`, Overpass) and the model
 * build (`buildModel()`, manifold3d) both run through `lib/engine/client.ts`'s
 * `EngineClient`, off the main thread when a Worker is available.
 *
 * The rule that shapes this file (01 step 4, 02 "Performance budgets"):
 *
 *   **Only `lat`, `lon`, `radius_m` and `rotation_deg` may cause a network
 *   call.** Every PrintParams control writes to the store and nothing else;
 *   the preview recomputes from the SceneGraph already in memory. There is a
 *   test (`store/editor.test.ts`) that fails if any `setParam` ever touches
 *   `fetch`. What used to trigger `POST /scene` now triggers the ingest job;
 *   a PrintParams change never re-fetches, but it DOES schedule a debounced
 *   (~400 ms) engine job -- a WASM build, never a network call -- so the live
 *   preview and the COLOUR panel stay in step with the parameters on screen.
 *
 * `rotation_deg` counts as a location change because the crop happens during
 * ingest (DECISIONS [P0]), so moving it marks the scene stale and the UI
 * re-generates when the slider is released.
 *
 * ONE deliberate exception to "only those four cause a network call" (phase
 * 3, `[V3-P3-U]`): with `params.terrain.enabled`, a pin/radius/rotation move
 * or a `terrain`/`terrain_exaggeration` write also schedules a debounced DEM
 * tile fetch (`lib/engine/terrain/tiles.ts`, cached by
 * `lib/terrainCache.ts`). This is a SEPARATE job from the Overpass ingest --
 * it never calls `generate()`/`engineClient.ingest()` and cannot mark the
 * scene stale -- so "terrain must not trigger an Overpass refetch" still
 * holds; `store/editor.test.ts`'s "never makes a server call" sweep still
 * passes because the fetch is timer-debounced and the test never advances
 * real timers, exactly like the engine job's own debounce.
 */

import { create } from "zustand";

import {
  exportDone,
  exportStarted,
  exportFailedLocally,
  initialExportState,
  markExportStale,
  runExport,
  type ExportState,
} from "@/lib/exportFlow";
import { DEFAULT_PRINT_PARAMS, PARAM_RANGES, defaultPrintParams } from "@/lib/contracts";
import type { PrintParams, SceneGraph, SceneRequest } from "@/lib/contracts";
import { createEngineClient, EngineClientError } from "@/lib/engine/client";
import type { AuditFinding, EngineResult, TerrainGrid } from "@/lib/engine/types";
import type { EngineBuilding } from "@/lib/engine/osm/types";
import type { OverpassFetchError } from "@/lib/engine/osm/overpass";
import type { ExportTarget } from "@/lib/engine/export";
import { fetchTerrainGrid } from "@/lib/engine/terrain/tiles";
import type { GeocodeResult } from "@/lib/geocode";
import { RADIUS_MAX_M, RADIUS_MIN_M, snapRadius } from "@/lib/geo";
import { autoHeroIds, heroCandidates, toggleHeroId } from "@/lib/heroes";
import { applyFix, applySafeFixes, type FixApplication } from "@/lib/issues";
import { perfFlush } from "@/lib/perf";
import { presetCityName } from "@/lib/presets";
import { profileApplyPatch, type PrinterProfileId } from "@/lib/printers";
import { decodeShare, readShareParam } from "@/lib/share";
import { terrainCache, terrainCacheKey } from "@/lib/terrainCache";
import { exportBlockReason } from "@/lib/warnings";

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "framecraft-theme";

/**
 * Where the last known author name is remembered ACROSS sessions and across a
 * `resetParams()`, so a fresh page (or a reset) does not lose it. The LIVE
 * value that actually reaches the build and the preview is always
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
  /** The SceneRequest that produced `graph`; an Export of a stale scene still reuses it for the export's source metadata. */
  request: SceneRequest | null;
  /** True when the location moved after the last successful Preview. */
  stale: boolean;
}

/**
 * The live browser-engine result: the debounced `buildModel()` job's own state,
 * independent of whether the user has clicked Export. The preview (`components/
 * scene/RegionMeshes.tsx`), the COLOUR panel and the Resolved output panel
 * all read `result` while it is fresh (`status === "ready" && !stale`) and
 * fall back to the instanced v1 preview / the token-resolution prediction
 * while it is not -- see `docs/handoff/v3-02-integration.md`.
 */
export type EngineJobStatus = "idle" | "computing" | "ready" | "error";

export interface EngineJobState {
  status: EngineJobStatus;
  result: EngineResult | null;
  error: string | null;
  /** True once params/scene changed after `result` was computed. `result` is kept (avoids a preview flicker back to empty) but must not be trusted as "what is on screen now". */
  stale: boolean;
}

export const initialEngineState: EngineJobState = {
  status: "idle",
  result: null,
  error: null,
  stale: false,
};

/** Invalidate a fresh engine result because the inputs moved under it. Mirrors `lib/exportFlow.ts:markExportStale`. */
export function markEngineStale(previous: EngineJobState): EngineJobState {
  if (previous.stale || previous.status !== "ready") return previous;
  return { ...previous, stale: true };
}

/**
 * The TERRAIN group's DEM fetch state (phase 3). `idle` covers both "terrain
 * is off" and "nothing fetched yet"; the group tells the two apart by reading
 * `params.terrain?.enabled` alongside this.
 *
 * `key` is the `terrainCacheKey` the current `grid`/`error` was fetched for,
 * so a response that lands after the pin/radius/rotation/exaggeration/
 * smoothing moved again can be told apart from one that still matches
 * (`runTerrainJob`'s own guard re-derives the CURRENT key and compares).
 */
export interface TerrainState {
  status: "idle" | "loading" | "ready" | "error";
  grid: TerrainGrid | null;
  error: string | null;
  key: string | null;
}

export const initialTerrainState: TerrainState = {
  status: "idle",
  grid: null,
  error: null,
  key: null,
};

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
  | "place"
  | "colour"
  | "custom_profile"
  | "terrain"
  | "heights"
  | "height_exaggeration"
  | "hero_auto"
  | "tiling"
  | "frame_style"
  | "hanger_magnet";

export interface EditorState {
  location: LocationState;
  params: PrintParams;
  scene: SceneState;
  engine: EngineJobState;
  /** The TERRAIN group's DEM fetch state, independent of `engine` (phase 3). */
  terrain: TerrainState;
  exportState: ExportState;
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
  /** Whether the Issues drawer (engine findings + client warnings, phase 4) is open. Same Escape/focus discipline as `adjustmentsOpen`. */
  issuesOpen: boolean;
  /**
   * Why a shared link was not applied, or null. Informational: a rejected link
   * leaves the editor on its defaults rather than half-restored, and saying
   * nothing about it would look like the link simply did nothing.
   */
  shareNotice: string | null;

  // --- location (these four are the ONLY things that trigger the ingest job) ---
  setPin: (lat: number, lon: number) => void;
  setRadius: (radiusM: number) => void;
  setRotation: (deg: number) => void;
  applyPreset: (preset: SceneRequest) => void;

  // --- print params (never touch the network; may schedule an engine job) ---
  setParam: <K extends keyof PrintParams>(key: K, value: PrintParams[K]) => void;
  /** Patch one field of a nested PrintParams object, immutably. */
  setNested: <K extends NestedParamKey>(
    key: K,
    patch: Partial<NonNullable<PrintParams[K]>>,
  ) => void;
  resetParams: () => void;
  /**
   * The PRINTER group's profile select. For every named printer this ALSO
   * writes `plate_mm`/`nozzle_mm` from the profile (clamped to their own
   * contract range) -- once, on the selection change itself
   * (`lib/printers.ts:profileApplyPatch`); the user can still move either
   * slider afterwards and nothing fights them back. Selecting `custom`
   * writes only the id.
   */
  setPrinterProfile: (id: PrinterProfileId) => void;
  /**
   * Apply one `AuditFinding.fix` through `lib/engine/audit/fixes.ts:applyFix`
   * (the Issues drawer's per-row button): one state change, stale-marks the
   * engine/export and reschedules a build exactly like any other control.
   * Returns what moved (or why nothing did) so the row can report it.
   */
  applyFinding: (finding: AuditFinding) => FixApplication;
  /**
   * "Auto-fix all safe issues": every current finding whose `fix.safe` is
   * true, folded into one write through `applySafeFixes`. Returns what
   * changed so the button can report it ("3 changes: ...").
   */
  applySafeFindingFixes: () => FixApplication;

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

  // --- undo/redo ([V3-P6]: `store/history.ts` calls this, never a fetch) ---
  /**
   * Restore a `{ location, params }` snapshot from the undo/redo stack.
   * Deliberately never itself a fetch, same discipline as `applyShared`: the
   * scene is marked stale ONLY when the location actually differs from what
   * is on screen now, so stepping through a run of pure-parameter edits never
   * re-triggers Overpass, while stepping across a pin move or a preset click
   * does mark it stale (Preview is still the user's own move either way).
   */
  applyHistorySnapshot: (snapshot: { location: LocationState; params: PrintParams }) => void;

  // --- project file ([V3-P6]: unlike a share restore, this DOES re-ingest) ---
  /**
   * Apply a `.framecraft.json` project's `{ location, params }` (already
   * parsed and validated by `lib/project.ts:parseProject`) and generate the
   * scene for it immediately -- a project file is a deliberate "open this"
   * action, not a link that might sit unopened in a background tab.
   */
  applyProject: (location: LocationState, params: PrintParams) => void;

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
  setIssuesOpen: (open: boolean) => void;

  // --- theme ---
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  initTheme: () => void;

  // --- engine flows (worker/in-page, never a server) ---
  generate: () => Promise<void>;
  /** Reuses a fresh engine result, or runs one now, then exports it and offers the download. */
  requestExport: () => Promise<void>;
  /** Drop any pending debounced engine job, and any pending terrain fetch (component unmount, test cleanup). */
  cancelEngineJob: () => void;
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
  if (error instanceof Error) return error.message;
  return String(error);
}

/** "message (tried mirror-a, mirror-b)": the ingest failure text the Issues badge/scene-error banner shows. */
function describeIngestError(error: OverpassFetchError): string {
  const mirrors = error.mirrorsTried.length > 0 ? ` (tried ${error.mirrorsTried.join(", ")})` : "";
  return `${error.message}${mirrors}`;
}

/**
 * The one `EngineClient` for this page's lifetime. Constructed eagerly (module
 * scope), but nothing inside it touches a `Worker`/WASM until `ingest()`/
 * `buildModel()` is actually called -- safe to construct during Next's server-side
 * prerender pass of this "use client" module, where `typeof Worker ===
 * "undefined"` picks the in-page fallback transport anyway.
 */
const engineClient = createEngineClient();

/** How long a PrintParams change waits before the next engine job runs. */
const ENGINE_DEBOUNCE_MS = 400;
let engineDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Same debounce window as the engine job, so a burst of terrain-affecting edits costs one fetch. */
const TERRAIN_DEBOUNCE_MS = 400;
let terrainDebounceTimer: ReturnType<typeof setTimeout> | null = null;

type Get = () => EditorState;
type Set = (
  partial: Partial<EditorState> | ((state: EditorState) => Partial<EditorState>),
) => void;

function clearEngineDebounce(): void {
  if (engineDebounceTimer !== null) {
    clearTimeout(engineDebounceTimer);
    engineDebounceTimer = null;
  }
}

function clearTerrainDebounce(): void {
  if (terrainDebounceTimer !== null) {
    clearTimeout(terrainDebounceTimer);
    terrainDebounceTimer = null;
  }
}

/** Debounce a fresh engine job. A no-op call (no scene yet) costs nothing once the timer fires. */
function scheduleEngineJob(get: Get, set: Set): void {
  clearEngineDebounce();
  engineDebounceTimer = setTimeout(() => {
    engineDebounceTimer = null;
    void runEngineJob(get, set);
  }, ENGINE_DEBOUNCE_MS);
}

/**
 * The manual hero picks plus, when `hero_auto.enabled`, the top-scoring
 * auto-promoted buildings on top of them (`lib/heroes.ts`). Read by both the
 * engine job (what actually builds at hero height/colour) and by callers that
 * want to know the CURRENT effective set without waiting for a build, such as
 * the HEROES panel.
 */
function currentHeroIds(scene: SceneState, params: PrintParams): string[] {
  const manual = params.hero_building_ids ?? [];
  if (!params.hero_auto?.enabled || !scene.graph) return [...manual];
  const buildings = scene.graph.buildings as EngineBuilding[];
  return autoHeroIds(heroCandidates(buildings), manual, params.hero_auto.count ?? 0);
}

/**
 * Run one engine job now (bypassing the debounce) and adopt its result.
 * Returns `null` when there is no scene to build, the job was superseded by a
 * newer one (a normal outcome, not an error), or the build failed.
 */
async function runEngineJob(get: Get, set: Set): Promise<EngineResult | null> {
  clearEngineDebounce();
  const { scene, params, location, terrain } = get();
  if (!scene.graph) return null;
  set((state) => ({ engine: { ...state.engine, status: "computing", error: null } }));
  const today = new Date().toISOString().slice(0, 10);
  const terrainGrid = params.terrain?.enabled ? terrain.grid : null;
  try {
    const result = await engineClient.buildModel({
      scene: scene.graph,
      params,
      rotationDeg: location.rotation_deg,
      date: today,
      heroIds: currentHeroIds(scene, params),
      terrain: terrainGrid,
    });
    set({ engine: { status: "ready", result, error: null, stale: false } });
    // Perf mode only: console table plus a HUD update, once per finished job
    // (`lib/perf.ts`). Returns null and does nothing at all when it is off.
    perfFlush("engine job");
    return result;
  } catch (error) {
    if (error instanceof EngineClientError && error.code === "cancelled") return null;
    set((state) => ({
      engine: { ...state.engine, status: "error", error: errorMessage(error) },
    }));
    return null;
  }
}

/**
 * Debounce a fresh terrain fetch. A no-op while `params.terrain.enabled` is
 * false -- called unconditionally from every location/terrain-param write, so
 * the caller never has to remember to check the toggle itself.
 */
function scheduleTerrainJob(get: Get, set: Set): void {
  clearTerrainDebounce();
  terrainDebounceTimer = setTimeout(() => {
    terrainDebounceTimer = null;
    void runTerrainJob(get, set);
  }, TERRAIN_DEBOUNCE_MS);
}

/**
 * Fetch (or serve from cache) the `TerrainGrid` for the current pin, radius,
 * rotation, exaggeration and smoothing. Fails soft: a rejected/`null` fetch
 * leaves `terrain.grid` at `null` and records `terrain.error`, so the engine
 * job builds with `terrain: null` (flat) and the TERRAIN group shows the
 * failure instead of silently pretending the toggle did nothing.
 *
 * Never touches `scene`/`engine.stale` for ingest purposes: this is a
 * completely separate job from `generate()`, exactly like the brief requires
 * ("terrain must not trigger an Overpass refetch"). It DOES reschedule the
 * (WASM, not network) engine job once a grid lands, so the preview drapes it.
 */
async function runTerrainJob(get: Get, set: Set): Promise<void> {
  clearTerrainDebounce();
  const { location, params } = get();
  if (!params.terrain?.enabled) {
    set((state) =>
      state.terrain.status === "idle" ? state : { terrain: { ...initialTerrainState } },
    );
    return;
  }
  const key = terrainCacheKey(location, params);
  const cached = terrainCache.get(key);
  if (cached !== undefined) {
    set({ terrain: { status: "ready", grid: cached, error: null, key } });
    scheduleEngineJob(get, set);
    return;
  }
  set((state) => ({ terrain: { ...state.terrain, status: "loading", error: null } }));
  try {
    const grid = await fetchTerrainGrid(
      {
        lat: location.lat,
        lon: location.lon,
        radiusM: location.radius_m,
        rotationDeg: location.rotation_deg,
      },
      params,
    );
    // A newer pin/radius/rotation/terrain-param write landed while this was
    // in flight: drop the answer to a question nobody is asking any more.
    if (terrainCacheKey(get().location, get().params) !== key) return;
    if (grid === null) {
      set({
        terrain: {
          status: "error",
          grid: null,
          error: "Could not fetch terrain for this location.",
          key,
        },
      });
      return;
    }
    terrainCache.set(key, grid);
    set({ terrain: { status: "ready", grid, error: null, key } });
    scheduleEngineJob(get, set);
  } catch (error) {
    if (terrainCacheKey(get().location, get().params) !== key) return;
    set({ terrain: { status: "error", grid: null, error: errorMessage(error), key } });
  }
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  location: { ...INITIAL_LOCATION },
  // `defaultPrintParams()`, never a shallow spread: DEFAULT_PRINT_PARAMS is
  // deep-frozen, and a spread would alias its nested v2/v3 objects into live
  // state, where the first write would throw.
  params: defaultPrintParams(),
  scene: { ...IDLE_SCENE },
  engine: { ...initialEngineState },
  terrain: { ...initialTerrainState },
  exportState: { ...initialExportState },
  placeDetect: { ...IDLE_PLACE_DETECT },
  theme: "light",
  presetChosen: false,
  heroCapHit: false,
  adjustmentsOpen: false,
  issuesOpen: false,
  shareNotice: null,

  setPin: (lat, lon) => {
    set((state) => {
      // A previously auto-filled label describes the OLD pin and would be
      // wrong for the new one; a user's own typed text survives the move
      // (DECISIONS [V3-P1] - "user edits always win").
      const clearLabel =
        !state.placeDetect.overridden && (state.params.city_label ?? "") !== "";
      return {
        location: { ...state.location, lat, lon, preset_id: null },
        scene: { ...state.scene, stale: true },
        engine: markEngineStale(state.engine),
        exportState: markExportStale(state.exportState),
        presetChosen: false,
        placeDetect: {
          status: "resolving",
          source: "none",
          detectedCity: null,
          overridden: state.placeDetect.overridden,
        },
        params: clearLabel ? { ...state.params, city_label: "" } : state.params,
      };
    });
    scheduleTerrainJob(get, set);
  },

  setRadius: (radiusM) => {
    set((state) => ({
      location: { ...state.location, radius_m: snapRadius(radiusM) },
      scene: { ...state.scene, stale: true },
      engine: markEngineStale(state.engine),
      exportState: markExportStale(state.exportState),
    }));
    scheduleTerrainJob(get, set);
  },

  setRotation: (deg) => {
    const normalised = Math.min(360, Math.max(0, Math.round(deg)));
    set((state) => ({
      location: { ...state.location, rotation_deg: normalised },
      scene: { ...state.scene, stale: true },
      engine: markEngineStale(state.engine),
      exportState: markExportStale(state.exportState),
    }));
    scheduleTerrainJob(get, set);
  },

  applyPreset: (preset) => {
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
        engine: markEngineStale(state.engine),
        exportState: markExportStale(state.exportState),
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
    });
    scheduleTerrainJob(get, set);
  },

  // A slider move is a pure state write. No fetch, and the SCENE is unaffected
  // by every one of these parameters -- but a fresh ENGINE RESULT and a
  // finished EXPORT are not: they were built from the old values, so an engine
  // job is scheduled and the export stops being offered until a new one runs.
  setParam: (key, value) => {
    set((state) => ({
      params: { ...state.params, [key]: value },
      engine: markEngineStale(state.engine),
      exportState: markExportStale(state.exportState),
    }));
    scheduleEngineJob(get, set);
    // `terrain` (the on/off toggle and smoothing) and `terrain_exaggeration`
    // are the only two PrintParams fields the TERRAIN fetch cache key reads
    // (`lib/terrainCache.ts`); every other control still touches nothing but
    // the debounced WASM engine job above.
    if (key === "terrain" || key === "terrain_exaggeration") scheduleTerrainJob(get, set);
  },

  // Every nested write goes through `setParam` too, so export staleness, the
  // `previewDeps` memo keys and the engine job scheduling all keep working
  // exactly as they do for a slider.
  setNested: (key, patch) => {
    const current = get().params[key] ?? DEFAULT_PRINT_PARAMS[key];
    get().setParam(key, { ...(current as object), ...patch } as never);
  },

  resetParams: () => {
    set((state) => ({
      // A fresh deep copy, so a reset never hands the editor a nested object
      // shared with the frozen constant or with the state it just replaced.
      // Deliberately does NOT touch `placeDetect`: a reset clears the typed
      // text back to "" and leaves it there (it does not re-detect), the same
      // way it clears every other field back to the contract default without
      // re-running whatever produced the value that was there before.
      params: defaultPrintParams(),
      engine: markEngineStale(state.engine),
      exportState: markExportStale(state.exportState),
      heroCapHit: false,
    }));
    scheduleEngineJob(get, set);
    scheduleTerrainJob(get, set);
  },

  setPrinterProfile: (id) => {
    const patch = profileApplyPatch(id, {
      plate_mm: PARAM_RANGES.plate_mm,
      nozzle_mm: PARAM_RANGES.nozzle_mm,
    });
    set((state) => ({
      params: { ...state.params, ...patch },
      engine: markEngineStale(state.engine),
      exportState: markExportStale(state.exportState),
    }));
    scheduleEngineJob(get, set);
  },

  applyFinding: (finding) => {
    const outcome = applyFix(get().params, finding);
    if (outcome.changes.length === 0) return outcome;
    set((state) => ({
      params: outcome.params,
      engine: markEngineStale(state.engine),
      exportState: markExportStale(state.exportState),
    }));
    scheduleEngineJob(get, set);
    return outcome;
  },

  applySafeFindingFixes: () => {
    const findings = get().engine.result?.findings ?? [];
    const outcome = applySafeFixes(get().params, findings);
    if (outcome.changes.length === 0) return outcome;
    set((state) => ({
      params: outcome.params,
      engine: markEngineStale(state.engine),
      exportState: markExportStale(state.exportState),
    }));
    scheduleEngineJob(get, set);
    return outcome;
  },

  applyGeocodeResult: (lat, lon, result) => {
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
        engine: markEngineStale(state.engine),
        exportState: markExportStale(state.exportState),
      };
    });
    scheduleEngineJob(get, set);
  },

  setPlaceName: (value) => {
    set((state) => ({
      placeDetect: { ...state.placeDetect, overridden: true },
      params: { ...state.params, city_label: value },
      engine: markEngineStale(state.engine),
      exportState: markExportStale(state.exportState),
    }));
    scheduleEngineJob(get, set);
  },

  resetPlaceNameToDetected: () => {
    set((state) => ({
      placeDetect: { ...state.placeDetect, overridden: false },
      params: { ...state.params, city_label: state.placeDetect.detectedCity ?? "" },
      engine: markEngineStale(state.engine),
      exportState: markExportStale(state.exportState),
    }));
    scheduleEngineJob(get, set);
  },

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

  applyHistorySnapshot: (snapshot) => {
    // Captured BEFORE the write: after `set()`, `get().location` IS
    // `snapshot.location` (same reference), so comparing against it there
    // would always read "unchanged".
    const locationChanged = JSON.stringify(get().location) !== JSON.stringify(snapshot.location);
    const paramsChanged = get().params !== snapshot.params;
    set((state) => ({
      location: snapshot.location,
      params: snapshot.params,
      scene: locationChanged ? { ...state.scene, stale: true } : state.scene,
      engine: locationChanged || paramsChanged ? markEngineStale(state.engine) : state.engine,
      exportState: locationChanged || paramsChanged ? markExportStale(state.exportState) : state.exportState,
    }));
    // The (WASM, in-page) engine job, never Overpass: harmless to schedule
    // whether or not anything actually moved, unlike `generate()`.
    scheduleEngineJob(get, set);
    if (locationChanged) scheduleTerrainJob(get, set);
  },

  applyProject: (location, params) => {
    set((state) => ({
      location,
      params,
      scene: { ...state.scene, stale: true },
      engine: markEngineStale(state.engine),
      exportState: markExportStale(state.exportState),
      terrain: { ...initialTerrainState },
      presetChosen: false,
      heroCapHit: false,
      placeDetect: {
        status: "idle",
        source: "none",
        detectedCity: null,
        overridden: (params.city_label ?? "") !== "",
      },
    }));
    scheduleTerrainJob(get, set);
    // Unlike a share restore, opening a project file is a deliberate "load
    // this design" action -- it re-ingests immediately rather than leaving
    // the scene stale for the user to Preview themselves.
    void get().generate();
  },

  /**
   * Restore a whole editor state from a shared link.
   *
   * Deliberately NOT a fetch. A link describes a model; generating it is a
   * live Overpass query at whatever location it names, and auto-running one on
   * page load would make opening a link in a background tab a server request
   * nobody asked for. The scene is marked stale instead, which is exactly the
   * state a moved pin leaves behind: Preview is enabled and says "Preview".
   *
   * `presetChosen` stays false even when the link names a preset: the chip may
   * only light up once something real backs it (`activePresetId`).
   */
  applyShared: (request, params) => {
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
      engine: markEngineStale(state.engine),
      exportState: markExportStale(state.exportState),
      // A cached grid is for the OLD pin/params; a link can name a different
      // place and different terrain settings entirely.
      terrain: { ...initialTerrainState },
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
    }));
    scheduleTerrainJob(get, set);
  },

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
  setIssuesOpen: (open) => set({ issuesOpen: open }),

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

  generate: async () => {
    const request = locationToRequest(get().location);
    set((state) => ({
      scene: { ...state.scene, status: "loading", message: null },
    }));
    try {
      const outcome = await engineClient.ingest(request, get().params);
      if (outcome.ok) {
        set((state) => ({
          scene: { status: "ready", graph: outcome.scene, message: null, request, stale: false },
          // A new SceneGraph invalidates a fresh engine result and a finished
          // export for the same reason a slider does: the geometry is no longer
          // this geometry.
          engine: markEngineStale(state.engine),
          exportState: markExportStale(state.exportState),
        }));
        scheduleEngineJob(get, set);
        perfFlush("ingest");
      } else {
        set((state) => ({
          scene: {
            ...state.scene,
            status: "error",
            message: describeIngestError(outcome.error),
            stale: true,
          },
        }));
      }
    } catch (error) {
      // A newer `generate()` call superseded this one: it already owns the
      // scene state, so this stale call has nothing left to report.
      if (error instanceof EngineClientError && error.code === "cancelled") return;
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

  requestExport: async () => {
    const { scene, params } = get();
    // Includes 04's 60 mm ceiling, which the engine would refuse anyway; this
    // is pure arithmetic over the scene already in memory, never a request.
    const blocked = exportBlockReason(scene.graph, params);
    if (blocked) {
      set({ exportState: exportFailedLocally(initialExportState, blocked) });
      return;
    }
    set((state) => ({ exportState: exportStarted(state.exportState) }));

    let result = get().engine.result;
    const fresh = get().engine;
    if (fresh.status !== "ready" || fresh.stale || result === null) {
      result = await runEngineJob(get, set);
    }
    if (result === null) {
      set((state) => ({
        exportState: exportFailedLocally(state.exportState, get().engine.error ?? "The engine could not build a model."),
      }));
      return;
    }

    const graph = get().scene.graph;
    if (!graph) {
      set((state) => ({ exportState: exportFailedLocally(state.exportState, "Preview a location first.") }));
      return;
    }
    try {
      const target: ExportTarget = params.export_target ?? "bambu-3mf";
      const location = get().location;
      const outcome = runExport(result, target, graph, {
        source: {
          lat: graph.center.lat,
          lon: graph.center.lon,
          radius_m: location.radius_m,
          rotation_deg: location.rotation_deg,
          preset_id: location.preset_id,
        },
      });
      set((state) => ({ exportState: exportDone(state.exportState, target, outcome, result.findings) }));
      perfFlush("export");
    } catch (error) {
      set((state) => ({ exportState: exportFailedLocally(state.exportState, errorMessage(error)) }));
    }
  },

  cancelEngineJob: () => {
    clearEngineDebounce();
    clearTerrainDebounce();
  },
}));
