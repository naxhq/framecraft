/**
 * The editor store.
 *
 * One zustand store holds everything the editor UI needs: where the pin is,
 * every PrintParams value, the fetched SceneGraph, the live pipeline state,
 * and the export/download state. Since v3.1 there is ONE job kind and one
 * worker: a pipeline run (`lib/engine/pipeline`) driven through
 * `lib/engine/client.ts`'s `PipelineClient`. Fetch and normalise are stages 0
 * and 1 of that pipeline, so "ingest" is no longer a separate call and a
 * `heights.*` write re-normalises from the cached Overpass response with no
 * network at all (design ruling 5, `[V3.1-P1-1]`).
 *
 * The rule that shapes this file (01 step 4, 02 "Performance budgets",
 * `[V3.1-P1-3]`):
 *
 *   **Only `lat`, `lon`, `radius_m` and `rotation_deg` may cause a network
 *   call.** They form the `fetch` stage's key, they are not parameters, and
 *   moving one marks the scene stale and waits for the Preview action. Every
 *   PrintParams write instead schedules a live incremental run after
 *   `PIPELINE_DEBOUNCE_MS` (80 ms) against the request the last Preview
 *   already fetched, so the stage cache serves `fetch` and nothing crosses
 *   the network. There is a test (`store/editor.test.ts`) that fails if any
 *   `setParam` ever touches `fetch`.
 *
 * `rotation_deg` counts as a location change because the crop happens during
 * ingest (DECISIONS [P0]), so moving it marks the scene stale and the UI
 * re-previews when the slider is released.
 *
 * ONE deliberate exception to "only those four cause a network call" (phase
 * 3, `[V3-P3-U]`): with `params.terrain.enabled`, a pin/radius/rotation move
 * or a `terrain`/`terrain_exaggeration` write also schedules a debounced DEM
 * tile fetch (`lib/engine/terrain/tiles.ts`, cached by
 * `lib/terrainCache.ts`). This is a SEPARATE job from the pipeline run -- it
 * never calls `generate()` and cannot mark the scene stale -- so "terrain must
 * not trigger an Overpass refetch" still holds; `store/editor.test.ts`'s
 * "never makes a server call" sweep still passes because the fetch is
 * timer-debounced and the test never advances real timers, exactly like the
 * pipeline run's own debounce.
 */

import { create } from "zustand";

import {
  EXPORT_STOPPED_MESSAGE,
  exportDone,
  exportStarted,
  exportFailedLocally,
  initialExportState,
  markExportStale,
  stemForResult,
  type ExportState,
} from "@/lib/exportFlow";
import { DEFAULT_PRINT_PARAMS, PARAM_RANGES, defaultPrintParams } from "@/lib/contracts";
import type { PrintParams, SceneGraph, SceneRequest } from "@/lib/contracts";
import {
  addedLabel,
  movedLabel,
  nudgedLabel,
  patchedLabel,
  removedLabel,
  rotatedLabel,
  type LabelLayer,
  type LabelPatch,
} from "@/lib/labelAnchor";
import { createPipelineClient, EngineClientError, PipelineStageError } from "@/lib/engine/client";
import type { RunHandle } from "@/lib/engine/client";
import type { Phase } from "@/lib/engine/pipeline";
import type { AuditFinding, EngineResult, RegionMesh, TerrainGrid } from "@/lib/engine/types";
import type { OverpassFetchError } from "@/lib/engine/osm/overpass";
import { fetchTerrainGrid } from "@/lib/engine/terrain/tiles";
import type { GeocodeResult } from "@/lib/geocode";
import { RADIUS_MAX_M, RADIUS_MIN_M, snapRadius } from "@/lib/geo";
import { toggleHeroId } from "@/lib/heroes";
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
  /** The SceneRequest that produced `graph`; every live run re-uses it, so the `fetch` stage is served from its cache and nothing is re-fetched. */
  request: SceneRequest | null;
  /**
   * The worker's own `normalise` key for `graph`, passed back as
   * `knownSceneHash` so a run that did not re-normalise never re-sends 1.2 MB
   * of SceneGraph across the wire.
   */
  hash: string | null;
  /** True when the location moved after the last successful Preview. */
  stale: boolean;
}

/**
 * The live pipeline state (design section 5).
 *
 * `regions` is what the viewport draws: one `RegionMesh` per colourable
 * region, streamed by the worker as each `finish-<region>` stage completes and
 * replaced only when that region's hash moved, so React re-uploads exactly the
 * geometry that changed. `result` is the finished `EngineResult` with the
 * streamed positions re-attached; it feeds the filament mapper, the stats, the
 * Issues badge and every export.
 */
export type PipelineStatus = "idle" | "running" | "ready" | "error";

export interface PipelineProgress {
  /** The stage that is running (or last reported); "" before the first one. */
  stage: string;
  /** Its position in this run's plan, 0-based, and the plan's length. */
  index: number;
  total: number;
  /**
   * Time this run has spent in stages that have reported, ms. A sum of the
   * worker's own per-stage numbers rather than a wall clock, so it is exactly
   * comparable with `etaMs` and does not move between events.
   */
  elapsedMs: number;
  /**
   * The previous run's durations for the stages still ahead, summed. Null
   * until three stages have reported in THIS run (before that the plan is
   * barely under way and a number would be noise), and null while no previous
   * run has timed any of the remaining stages.
   */
  etaMs: number | null;
  phase: Phase;
}

export const IDLE_PIPELINE_PROGRESS: PipelineProgress = {
  stage: "",
  index: 0,
  total: 0,
  elapsedMs: 0,
  etaMs: null,
  phase: "scene",
};

/** How many stages must report before `etaMs` stops being null. */
export const ETA_MIN_STAGES = 3;

/** A stage failure, never flattened into a bare string: the Issues badge names the stage and the drawer can show the worker's own detail. */
export interface PipelineFailure {
  stage: string;
  message: string;
  /** The worker's own detail (and stack, where one crossed the wire), or null. */
  detail: string | null;
}

export interface PipelineJobState {
  status: PipelineStatus;
  /** True once params/scene changed after `result` was computed. The last good `regions` and `result` are kept (the viewport dims them rather than emptying) but must not be trusted as "what the controls say now". */
  stale: boolean;
  progress: PipelineProgress;
  /** region -> its finished mesh. Referentially stable per region: only a region the worker re-sent gets a new object. */
  regions: ReadonlyMap<string, RegionMesh>;
  /** region -> the worker's `finish-<region>` key for the mesh we hold, for the regions whose key we know. Sent back as `known` so an unchanged region is never re-sent. */
  regionHashes: Readonly<Record<string, string>>;
  result: EngineResult | null;
  error: PipelineFailure | null;
  /** stage id -> how long it took the last time it actually ran, ms. What `etaMs` is computed from. */
  lastRunStageMs: Readonly<Record<string, number>>;
}

/** Identity-stable empty map: a fresh `new Map()` per read would report "changed" to every zustand selector. */
export const NO_REGIONS: ReadonlyMap<string, RegionMesh> = new Map();

export const initialPipelineState: PipelineJobState = {
  status: "idle",
  stale: false,
  progress: IDLE_PIPELINE_PROGRESS,
  regions: NO_REGIONS,
  regionHashes: {},
  result: null,
  error: null,
  lastRunStageMs: {},
};

/** Invalidate a fresh pipeline result because the inputs moved under it. Mirrors `lib/exportFlow.ts:markExportStale`. */
export function markPipelineStale(previous: PipelineJobState): PipelineJobState {
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
  pipeline: PipelineJobState;
  /** The TERRAIN group's DEM fetch state, independent of `pipeline` (phase 3). */
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

  // --- surface labels (v3.1 Task 12: placed and dragged in the viewport) ---
  /**
   * The label the gizmo and the labels panel are acting on, as an index into
   * `params.labels`, or null. May point past the array after an undo or a
   * project load shortened it; readers treat that as null.
   */
  selectedLabel: number | null;
  /** True after `addLabel` refused because the cap of 12 was already reached; cleared by any label write. */
  labelCapHit: boolean;
  /**
   * A new label on `target`, at the plan point `at` (engine mm) when one is
   * given, else at the target's centre. Selects it. Returns its index, or null
   * when the cap refused it (`labelCapHit` is then set) or the scene has no
   * such object.
   */
  addLabel: (target: { osmId: string; layer: LabelLayer }, at?: { xMm: number; yMm: number }) => number | null;
  selectLabel: (index: number | null) => void;
  /** Drag: the label's centre to a plan point, engine mm. `lib/labelAnchor.ts` turns it into `u`, `v`. */
  moveLabel: (index: number, xMm: number, yMm: number) => void;
  /** Rotation handle: the label reads in the ABSOLUTE plan direction `angleDeg`, stored relative to its target's axis. */
  rotateLabel: (index: number, angleDeg: number) => void;
  /** Arrow keys: `dx`, `dy` mm in the label's own reading frame. */
  nudgeLabel: (index: number, dxMm: number, dyMm: number) => void;
  /** The panel's fields: text, size, depth, mode, font, follow, rotation. Clamped by `patchedLabel`. */
  patchLabel: (index: number, patch: LabelPatch) => void;
  /** `[` and `]`: turn by `deltaDeg` from where it reads now. */
  turnLabel: (index: number, deltaDeg: number) => void;
  /** `+` and `-`: grow or shrink the cap height by `deltaMm`, inside the contract range. */
  resizeLabel: (index: number, deltaMm: number) => void;
  removeLabel: (index: number) => void;

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

  // --- pipeline flows (worker/in-page, never a server past `fetch`) ---
  /**
   * The Preview action: fetch the current location and build the model from
   * it. The only entry point that may reach Overpass.
   *
   * Still named `generate` on purpose: the vocabulary pass retired the word
   * from the UI but deferred the code rename (`DECISIONS.md` `[V3.1-O3]`), so
   * the six Playwright helpers and `lib/keyboard.ts`'s action id keep working.
   */
  generate: () => Promise<void>;
  /**
   * Awaits the run already under way (or starts one), then asks the worker for
   * the files. Never a second build.
   *
   * The `export` stage runs the printability gate first and REFUSES a model
   * that failed a Stage 4 check; the refusal lands as the export error, naming
   * every check, and the previously downloadable files stay exactly where they
   * were. `ExportRequest.force` is for debugging the engine and no control in
   * this app reaches it.
   */
  requestExport: () => Promise<void>;
  /**
   * Stop the run in flight at its next stage boundary and drop any pending
   * debounced run and terrain fetch. The last good `regions` and `result` stay
   * on screen: a cancelled run is not an error.
   */
  cancelPipeline: () => void;
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
  hash: null,
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
 * The one `PipelineClient` for this page's lifetime. Constructed eagerly
 * (module scope), but nothing inside it touches a `Worker`/WASM until `run()`
 * is actually called -- safe to construct during Next's server-side prerender
 * pass of this "use client" module, where `typeof Worker === "undefined"`
 * picks the in-page fallback transport anyway.
 */
const pipelineClient = createPipelineClient();

/**
 * How long a PrintParams write waits before the next incremental run starts
 * (`[V3.1-P1-3]`, down from the 400 ms of the v3 build job).
 *
 * 80 ms is short enough that a released slider feels immediate and long enough
 * that a drag coalesces into one run; a run already in flight is superseded at
 * its next stage boundary and hands every stage it finished to its successor,
 * so a burst costs at most one stage of wasted work.
 */
export const PIPELINE_DEBOUNCE_MS = 80;
let pipelineDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Same debounce window as the pipeline run, so a burst of terrain-affecting edits costs one fetch. */
const TERRAIN_DEBOUNCE_MS = 400;
let terrainDebounceTimer: ReturnType<typeof setTimeout> | null = null;

type Get = () => EditorState;
type Set = (
  partial: Partial<EditorState> | ((state: EditorState) => Partial<EditorState>),
) => void;

/**
 * The run in flight, if any, and the promise that settles with its result.
 *
 * `handle` is the identity every subscription checks before writing: a
 * superseded run's events and its `cancelled` rejection both arrive AFTER the
 * successor has taken over, and must not touch the state the successor now
 * owns.
 */
interface ActiveRun {
  handle: RunHandle;
  /** Resolves with the finished result, or `null` when the run was superseded, cancelled or failed. */
  done: Promise<EngineResult | null>;
}

let activeRun: ActiveRun | null = null;

function clearPipelineDebounce(): void {
  if (pipelineDebounceTimer !== null) {
    clearTimeout(pipelineDebounceTimer);
    pipelineDebounceTimer = null;
  }
}

function clearTerrainDebounce(): void {
  if (terrainDebounceTimer !== null) {
    clearTimeout(terrainDebounceTimer);
    terrainDebounceTimer = null;
  }
}

/**
 * Debounce a fresh incremental run against the request the last Preview
 * fetched. A no-op call (nothing previewed yet) costs nothing once the timer
 * fires.
 */
function schedulePipelineRun(get: Get, set: Set): void {
  clearPipelineDebounce();
  pipelineDebounceTimer = setTimeout(() => {
    pipelineDebounceTimer = null;
    const request = get().scene.request;
    if (request === null) return;
    void startPipelineRun(get, set, request);
  }, PIPELINE_DEBOUNCE_MS);
}

/** Two SceneRequests describe the same fetch. */
function sameRequest(a: SceneRequest, b: SceneRequest): boolean {
  return (
    a.lat === b.lat &&
    a.lon === b.lon &&
    a.radius_m === b.radius_m &&
    a.rotation_deg === b.rotation_deg &&
    (a.preset_id ?? null) === (b.preset_id ?? null)
  );
}

/**
 * The Stage 4 findings that refused an export, or null.
 *
 * The `export` stage runs `export/gate.ts` before the writer and throws
 * `ExportBlockedError` when the printability gate failed at `error` severity
 * (not manifold, a floating island, over the plate, over the height ceiling, a
 * wall under the minimum). 04 stage 4's rule is "on failure, do not silently
 * ship": the refusal has to name the checks, because the user is looking at a
 * model that LOOKS finished.
 */
function blockedExportFindings(error: unknown): AuditFinding[] | null {
  if (!(error instanceof PipelineStageError)) return null;
  const detail = error.detail as { blocking?: AuditFinding[] } | undefined;
  const blocking = detail?.blocking;
  return blocking !== undefined && blocking.length > 0 ? blocking : null;
}

/** "Export refused: the model is not one solid; a wall is thinner than the nozzle can print." */
function describeBlockedExport(blocking: readonly AuditFinding[]): string {
  return `Export refused, because the printability gate failed: ${blocking
    .map((finding) => finding.title)
    .join("; ")}. Fix the issues in the Issues list, then export again.`;
}

/** The Overpass failure behind a stage error, or null: an ingest problem is a SCENE error, not a pipeline one. */
function overpassErrorOf(error: unknown): OverpassFetchError | null {
  if (!(error instanceof PipelineStageError)) return null;
  const detail = error.detail as { overpass?: OverpassFetchError } | undefined;
  return detail?.overpass ?? null;
}

/**
 * Everything the worker said about a failure beyond its one-line message: the
 * structured detail it attached, plus the stack. Never swallowed -- a stage
 * that throws has to be diagnosable from the Issues drawer.
 */
function failureDetail(error: unknown): string | null {
  const parts: string[] = [];
  if (error instanceof PipelineStageError && error.detail !== undefined) {
    parts.push(typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail));
  }
  if (error instanceof Error && error.stack) parts.push(error.stack);
  else if (!(error instanceof Error)) parts.push(String(error));
  return parts.length === 0 ? null : parts.join("\n");
}

/**
 * The previous run's cost for every stage still ahead of `index` in this run's
 * plan, or null when none of them has ever been timed (a first run, or a plan
 * this session has not reached the end of).
 */
function etaFromPlan(
  plan: readonly string[],
  index: number,
  previous: Readonly<Record<string, number>>,
): number | null {
  let total = 0;
  let known = false;
  for (let i = index + 1; i < plan.length; i += 1) {
    const ms = previous[plan[i]];
    if (ms === undefined) continue;
    known = true;
    total += ms;
  }
  return known ? total : null;
}

/**
 * Put the streamed positions back on the `done` result's REGIONS.
 *
 * The worker sends each region's mesh once, transferred, as its finish stage
 * completes, and strips the positions off the regions it posts at the end
 * (`[V3.1-P1-1]`, `client.test.ts` pins the wire). `merged` and `tiles` are
 * NOT this function's business: the worker sends them whole, or strips them as
 * unchanged and `PipelineClient` re-attaches the ones it kept from the last
 * `done` (`knownMergedHash`/`knownTilesHash`, which the client fills in
 * itself). Touching them here would undo that.
 */
function reattachRegions(result: EngineResult, held: ReadonlyMap<string, RegionMesh>): EngineResult {
  const regions = result.regions.map((region) => {
    const streamed = held.get(region.region);
    if (streamed === undefined) return region;
    return { ...region, positions: streamed.positions, indices: streamed.indices };
  });
  return { ...result, regions };
}

/**
 * Start one pipeline run now, bypassing the debounce, and adopt everything it
 * streams: the scene, each region mesh as it finishes, the stage progress and
 * finally the result.
 *
 * `request` is the fetch key. For a live run it is the request the last
 * Preview already fetched, so the `fetch` stage is served from its cache and
 * nothing touches the network; a `heights.*` write still re-runs `normalise`
 * over that cached response, which is the whole point of fetch and normalise
 * being stages (design ruling 5).
 *
 * Returns `null` when the run was superseded or cancelled (a normal outcome,
 * not a failure) or when a stage failed.
 */
function startPipelineRun(get: Get, set: Set, request: SceneRequest): Promise<EngineResult | null> {
  clearPipelineDebounce();
  const state = get();
  const params = state.params;
  const previousStageMs = state.pipeline.lastRunStageMs;
  const grid = state.terrain.grid;

  set((current) => ({
    pipeline: {
      ...current.pipeline,
      status: "running",
      error: null,
      progress: IDLE_PIPELINE_PROGRESS,
    },
  }));

  const handle = pipelineClient.run({
    source: { kind: "request", request },
    params,
    // `gate: "param"` leaves the `terrain` stage to decide from
    // `terrain.enabled` whether to drape the grid ([V3.1-P1-9]), so toggling
    // terrain off and on again re-runs one stage instead of re-fetching.
    terrain: grid === null ? null : { grid, gate: "param" },
    // Null, not the store's own list: the `heroes` stage resolves `hero_auto`
    // in the worker, so `hero_auto.*` is a claimed parameter rather than a
    // value the page computes and the worker cannot check (pipeline 3.5).
    heroIds: null,
    date: new Date().toISOString().slice(0, 10),
    rotationDeg: request.rotation_deg,
    mode: "full",
    known: { ...state.pipeline.regionHashes },
    knownSceneHash: state.scene.hash,
  });

  const stageMs: Record<string, number> = {};
  let plan: readonly string[] = [];
  let reported = 0;
  let elapsedMs = 0;
  const owns = (): boolean => activeRun !== null && activeRun.handle === handle;

  handle.progress.subscribe((event) => {
    if (!owns()) return;
    if (event.kind === "plan") {
      plan = event.stages;
      set((current) => ({
        pipeline: { ...current.pipeline, progress: { ...current.pipeline.progress, total: event.total } },
      }));
      return;
    }
    if (event.kind !== "stage") return;
    if (event.state === "start") {
      // Name the stage that is running NOW: this is what the viewport overlay
      // reads, and "Building: roads" has to appear before roads are built.
      set((current) => ({
        pipeline: {
          ...current.pipeline,
          progress: {
            ...current.pipeline.progress,
            stage: event.stage,
            index: event.index,
            total: event.total,
            phase: event.phase,
          },
        },
      }));
      return;
    }
    reported += 1;
    elapsedMs += event.elapsedMs;
    // Only a stage that actually RAN times itself: a cached stage reports 0,
    // and folding that into the table would estimate a real re-run at nothing.
    if (event.state === "done") stageMs[event.stage] = event.elapsedMs;
    const etaMs = reported < ETA_MIN_STAGES ? null : etaFromPlan(plan, event.index, previousStageMs);
    set((current) => ({
      pipeline: {
        ...current.pipeline,
        progress: {
          stage: event.stage,
          index: event.index,
          total: event.total,
          elapsedMs,
          etaMs,
          phase: event.phase,
        },
      },
    }));
  });

  handle.scene.subscribe((event) => {
    if (!owns()) return;
    set((current) => ({
      scene: {
        status: "ready",
        graph: event.scene,
        message: null,
        request,
        hash: event.hash,
        // The pin may have moved on while this ran: the scene is stale unless
        // it still describes where the user is standing.
        stale: !sameRequest(locationToRequest(current.location), request),
      },
    }));
  });

  handle.regions.subscribe((event) => {
    if (!owns()) return;
    set((current) => {
      const regions = new Map(current.pipeline.regions);
      const hashes = { ...current.pipeline.regionHashes };
      for (const region of event.regions) {
        regions.set(region.region, region);
        // The mesh arrives WITH its finish key, so the map stays hash-complete
        // between events. That is what makes a run cancelled halfway through
        // the region phase safe: `known` still describes every mesh on screen,
        // including the ones the abandoned run replaced.
        const hash = event.hashes[region.region];
        // A mesh whose key did not arrive is one we may not claim to know:
        // forgetting it costs one re-send, keeping a stale key costs a mesh
        // nobody asked for on the plate.
        if (hash === undefined) delete hashes[region.region];
        else hashes[region.region] = hash;
      }
      // A superset on purpose: every region the model does not have right now,
      // not only the ones the worker was told we hold. Deleting a name we do
      // not hold costs nothing; keeping one the model lost would draw it.
      for (const region of event.removed) {
        regions.delete(region);
        delete hashes[region];
      }
      return { pipeline: { ...current.pipeline, regions, regionHashes: hashes } };
    });
  });

  const done = handle.done.then(
    (outcome): EngineResult | null => {
      if (!owns()) return null;
      activeRun = null;
      const result =
        outcome.result === null ? null : reattachRegions(outcome.result, get().pipeline.regions);
      set((current) => ({
        pipeline: {
          ...current.pipeline,
          status: "ready",
          stale: false,
          error: null,
          result,
          regionHashes: outcome.regionHashes,
          lastRunStageMs: { ...current.pipeline.lastRunStageMs, ...stageMs },
          progress: {
            ...current.pipeline.progress,
            index: Math.max(current.pipeline.progress.total - 1, 0),
            elapsedMs,
            etaMs: 0,
          },
        },
      }));
      // Perf mode only: console table plus a HUD update, once per finished run
      // (`lib/perf.ts`). Returns null and does nothing at all when it is off.
      perfFlush("pipeline run");
      return result;
    },
    (error: unknown): EngineResult | null => {
      if (!owns()) return null;
      activeRun = null;
      if (error instanceof EngineClientError && error.code === "cancelled") {
        // Not a failure: the last good regions and result stay on screen.
        set((current) => ({
          pipeline: {
            ...current.pipeline,
            status: current.pipeline.result === null ? "idle" : "ready",
            stale: true,
            progress: IDLE_PIPELINE_PROGRESS,
          },
        }));
        return null;
      }
      const overpass = overpassErrorOf(error);
      if (overpass !== null) {
        // An ingest problem is reported where the user asked for it: on the
        // scene, with the mirrors that were tried. The last good model stays.
        set((current) => ({
          scene: { ...current.scene, status: "error", message: describeIngestError(overpass), stale: true },
          pipeline: {
            ...current.pipeline,
            status: current.pipeline.result === null ? "idle" : "ready",
            progress: IDLE_PIPELINE_PROGRESS,
          },
        }));
        return null;
      }
      set((current) => ({
        pipeline: {
          ...current.pipeline,
          status: "error",
          error: {
            stage: error instanceof PipelineStageError ? error.stage : "run",
            message: errorMessage(error),
            detail: failureDetail(error),
          },
          progress: IDLE_PIPELINE_PROGRESS,
        },
      }));
      return null;
    },
  );

  activeRun = { handle, done };
  return done;
}

/**
 * The result to export: the run already under way, a fresh one, or the one
 * already in the store. Never a second build of the same parameters.
 */
async function resultForExport(get: Get, set: Set): Promise<EngineResult | null> {
  // A debounced run is pending, so what is in flight (if anything) was started
  // for older parameters: start the newer one now, which supersedes it.
  if (pipelineDebounceTimer !== null) {
    const request = get().scene.request;
    if (request === null) return null;
    return startPipelineRun(get, set, request);
  }
  if (activeRun !== null) return activeRun.done;
  const pipeline = get().pipeline;
  if (pipeline.status === "ready" && !pipeline.stale && pipeline.result !== null) {
    return pipeline.result;
  }
  const request = get().scene.request;
  if (request === null) return null;
  return startPipelineRun(get, set, request);
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
    schedulePipelineRun(get, set);
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
    schedulePipelineRun(get, set);
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
  pipeline: { ...initialPipelineState },
  terrain: { ...initialTerrainState },
  exportState: { ...initialExportState },
  placeDetect: { ...IDLE_PLACE_DETECT },
  theme: "light",
  presetChosen: false,
  heroCapHit: false,
  selectedLabel: null,
  labelCapHit: false,
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
        pipeline: markPipelineStale(state.pipeline),
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
      pipeline: markPipelineStale(state.pipeline),
      exportState: markExportStale(state.exportState),
    }));
    scheduleTerrainJob(get, set);
  },

  setRotation: (deg) => {
    const normalised = Math.min(360, Math.max(0, Math.round(deg)));
    set((state) => ({
      location: { ...state.location, rotation_deg: normalised },
      scene: { ...state.scene, stale: true },
      pipeline: markPipelineStale(state.pipeline),
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
        pipeline: markPipelineStale(state.pipeline),
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
      pipeline: markPipelineStale(state.pipeline),
      exportState: markExportStale(state.exportState),
    }));
    schedulePipelineRun(get, set);
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
      pipeline: markPipelineStale(state.pipeline),
      exportState: markExportStale(state.exportState),
      heroCapHit: false,
      selectedLabel: null,
      labelCapHit: false,
    }));
    schedulePipelineRun(get, set);
    scheduleTerrainJob(get, set);
  },

  setPrinterProfile: (id) => {
    const patch = profileApplyPatch(id, {
      plate_mm: PARAM_RANGES.plate_mm,
      nozzle_mm: PARAM_RANGES.nozzle_mm,
    });
    set((state) => ({
      params: { ...state.params, ...patch },
      pipeline: markPipelineStale(state.pipeline),
      exportState: markExportStale(state.exportState),
    }));
    schedulePipelineRun(get, set);
  },

  applyFinding: (finding) => {
    const outcome = applyFix(get().params, finding);
    if (outcome.changes.length === 0) return outcome;
    set((state) => ({
      params: outcome.params,
      pipeline: markPipelineStale(state.pipeline),
      exportState: markExportStale(state.exportState),
    }));
    schedulePipelineRun(get, set);
    return outcome;
  },

  applySafeFindingFixes: () => {
    const findings = get().pipeline.result?.findings ?? [];
    const outcome = applySafeFixes(get().params, findings);
    if (outcome.changes.length === 0) return outcome;
    set((state) => ({
      params: outcome.params,
      pipeline: markPipelineStale(state.pipeline),
      exportState: markExportStale(state.exportState),
    }));
    schedulePipelineRun(get, set);
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
        pipeline: markPipelineStale(state.pipeline),
        exportState: markExportStale(state.exportState),
      };
    });
    schedulePipelineRun(get, set);
  },

  setPlaceName: (value) => {
    set((state) => ({
      placeDetect: { ...state.placeDetect, overridden: true },
      params: { ...state.params, city_label: value },
      pipeline: markPipelineStale(state.pipeline),
      exportState: markExportStale(state.exportState),
    }));
    schedulePipelineRun(get, set);
  },

  resetPlaceNameToDetected: () => {
    set((state) => ({
      placeDetect: { ...state.placeDetect, overridden: false },
      params: { ...state.params, city_label: state.placeDetect.detectedCity ?? "" },
      pipeline: markPipelineStale(state.pipeline),
      exportState: markExportStale(state.exportState),
    }));
    schedulePipelineRun(get, set);
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

  /*
    Surface labels (v3.1 Task 12). Every action is one `setParam("labels", ...)`
    over `lib/labelAnchor.ts`'s pure edits, so a drag, a keyboard nudge and a
    typed field all stale-mark the model, reschedule the build and land in the
    undo history exactly like a slider. The anchor maths runs HERE, where the
    scene and the params may be read, because nothing drawn in the viewport
    may read a parameter: the gizmo hands over engine millimetres and gets a
    finished band back from the pipeline.
  */
  addLabel: (target, at) => {
    const graph = get().scene.graph;
    if (graph === null) return null;
    const result = addedLabel(graph, get().params, target, at);
    if (!result.ok) {
      set({ labelCapHit: result.reason === "capped" });
      return null;
    }
    set({ labelCapHit: false, selectedLabel: result.index });
    get().setParam("labels", result.labels);
    return result.index;
  },

  selectLabel: (index) => {
    set({ selectedLabel: index });
  },

  moveLabel: (index, xMm, yMm) => {
    const graph = get().scene.graph;
    if (graph === null) return;
    const result = movedLabel(graph, get().params, index, xMm, yMm);
    if (!result.ok) return;
    set({ labelCapHit: false });
    get().setParam("labels", result.labels);
  },

  rotateLabel: (index, angleDeg) => {
    const graph = get().scene.graph;
    if (graph === null) return;
    const result = rotatedLabel(graph, get().params, index, angleDeg);
    if (!result.ok) return;
    set({ labelCapHit: false });
    get().setParam("labels", result.labels);
  },

  nudgeLabel: (index, dxMm, dyMm) => {
    const graph = get().scene.graph;
    if (graph === null) return;
    const result = nudgedLabel(graph, get().params, index, dxMm, dyMm);
    if (!result.ok) return;
    set({ labelCapHit: false });
    get().setParam("labels", result.labels);
  },

  patchLabel: (index, patch) => {
    const result = patchedLabel(get().params, index, patch);
    if (!result.ok) return;
    set({ labelCapHit: false });
    get().setParam("labels", result.labels);
  },

  turnLabel: (index, deltaDeg) => {
    const label = (get().params.labels ?? [])[index];
    if (label === undefined) return;
    get().patchLabel(index, {
      rotation_deg: (label.rotation_deg ?? PARAM_RANGES.labels.rotation_deg.default) + deltaDeg,
    });
  },

  resizeLabel: (index, deltaMm) => {
    const label = (get().params.labels ?? [])[index];
    if (label === undefined) return;
    get().patchLabel(index, { size_mm: (label.size_mm ?? PARAM_RANGES.labels.size_mm.default) + deltaMm });
  },

  removeLabel: (index) => {
    const labels = get().params.labels ?? [];
    if (index < 0 || index >= labels.length) return;
    const selected = get().selectedLabel;
    set({
      labelCapHit: false,
      // The selection follows the row it was on: a removal above it shifts it
      // up by one, a removal OF it clears it.
      selectedLabel:
        selected === null ? null : selected === index ? null : selected > index ? selected - 1 : selected,
    });
    get().setParam("labels", removedLabel(get().params, index));
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
      pipeline: locationChanged || paramsChanged ? markPipelineStale(state.pipeline) : state.pipeline,
      exportState: locationChanged || paramsChanged ? markExportStale(state.exportState) : state.exportState,
    }));
    // The (WASM, in-page) engine job, never Overpass: harmless to schedule
    // whether or not anything actually moved, unlike `generate()`.
    schedulePipelineRun(get, set);
    if (locationChanged) scheduleTerrainJob(get, set);
  },

  applyProject: (location, params) => {
    set((state) => ({
      location,
      params,
      scene: { ...state.scene, stale: true },
      pipeline: markPipelineStale(state.pipeline),
      exportState: markExportStale(state.exportState),
      terrain: { ...initialTerrainState },
      presetChosen: false,
      heroCapHit: false,
      selectedLabel: null,
      labelCapHit: false,
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
      pipeline: markPipelineStale(state.pipeline),
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

  /**
   * The Preview action: one pipeline run whose `fetch` stage really may go to
   * Overpass, because the location is what changed.
   *
   * Everything the run streams -- the scene, each region mesh, the stage
   * progress, the result -- is adopted by `startPipelineRun`'s own
   * subscriptions, so this only has to say where to fetch and put the scene in
   * its loading state while the first stages run.
   */
  generate: async () => {
    const request = locationToRequest(get().location);
    set((state) => ({
      scene: { ...state.scene, status: "loading", message: null },
      // A new SceneGraph invalidates a fresh result and a finished export for
      // the same reason a slider does: the geometry is no longer this geometry.
      pipeline: markPipelineStale(state.pipeline),
      exportState: markExportStale(state.exportState),
    }));
    await startPipelineRun(get, set, request);
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

    // The run that is already under way, a fresh one, or the one in the store:
    // an export is "the remaining uncached stages plus the writer", never a
    // second build of parameters the worker has already built.
    const result = await resultForExport(get, set);
    if (result === null) {
      /*
       * Two different endings arrive here and only one of them is a failure.
       *
       * `resultForExport` resolves null when the run it was waiting on
       * FAILED, in which case `pipeline.error` carries the engine's own
       * message; and when that run simply ended without a result, which is a
       * user-pressed Cancel or a run superseded by a newer one. `cancelPipeline`
       * deliberately leaves `pipeline.error` at null, because a cancel is not
       * an error -- so the absence of an error is the signal, and writing
       * "The engine could not build a model." into it was false in both
       * halves: nothing failed and nothing was refused ([V3.1-T6] 2).
       *
       * `ActionBar` classifies the same ending from the TRANSITION it watched
       * and shows its own cancelled notice; this is the string everything
       * else reads, including the results panel and any future surface that
       * has no transition to watch.
       */
      const failure = get().pipeline.error;
      set((state) => ({
        exportState: exportFailedLocally(
          state.exportState,
          failure === null ? EXPORT_STOPPED_MESSAGE : failure.message,
        ),
      }));
      return;
    }

    const graph = get().scene.graph;
    if (!graph) {
      set((state) => ({ exportState: exportFailedLocally(state.exportState, "Preview a location first.") }));
      return;
    }
    try {
      const location = get().location;
      const outcome = await pipelineClient.exportFiles({
        // No `target`: the `export` stage reads `export_target` off the params
        // it built with, so the file and the preview can never disagree about
        // which format was asked for. `outcome.target` says which it wrote.
        stem: stemForResult(result),
        source: {
          lat: graph.center.lat,
          lon: graph.center.lon,
          radius_m: location.radius_m,
          rotation_deg: location.rotation_deg,
          preset_id: location.preset_id,
        },
        createdIso: new Date().toISOString(),
      });
      set((state) => ({ exportState: exportDone(state.exportState, outcome, result.findings) }));
      perfFlush("export");
    } catch (error) {
      if (error instanceof EngineClientError && error.code === "cancelled") {
        set((state) => ({
          exportState: exportFailedLocally(state.exportState, "A newer request took over before the file was written."),
        }));
        return;
      }
      // The printability gate refused it. Never silent, and never `force`:
      // `ExportRequest.force` exists for debugging the engine and no control
      // in this app may reach it, or "the preview and the printed result
      // agree" stops being true the one time it matters.
      const blocking = blockedExportFindings(error);
      if (blocking !== null) {
        set((state) => ({
          exportState: exportFailedLocally(state.exportState, describeBlockedExport(blocking)),
        }));
        return;
      }
      set((state) => ({ exportState: exportFailedLocally(state.exportState, errorMessage(error)) }));
    }
  },

  cancelPipeline: () => {
    clearPipelineDebounce();
    clearTerrainDebounce();
    activeRun?.handle.cancel();
  },
}));
