/**
 * Stage vocabulary: ids, phases, extras, the per-stage context and the output
 * type of every stage.
 *
 * A stage is a pure function of what it DECLARES: the parameter leaves it
 * reads (`params`), the non-parameter inputs it reads (`extra`), and the
 * upstream stage outputs it consumes (`inputs`). The runner hashes exactly
 * those into the stage's cache key, hands the stage a context that can read
 * nothing else (in strict-claims mode an undeclared read throws), and owns the
 * output afterwards. Nothing here runs anything: `stages.ts` is the registry,
 * `runner.ts` executes it.
 */

import type { PrintParams, SceneRequest } from "../../contracts";
import type { TokenContext } from "../../tokens";
import type { IslandReport } from "../audit/rules";
import type { OverpassResponse } from "../osm/normalize";
import type { EngineSceneGraph } from "../osm/types";
import type { AttributionGeometry } from "../solid/attribution";
import type { RepairedSurface, SurfaceRegion } from "../solid/areas";
import type { BridgeRegion } from "../solid/bridges";
import type { BuiltBuildings } from "../solid/buildings";
import type { BuildContext } from "../solid/context";
import type { Drape } from "../solid/drape";
import type { FrameMating } from "../solid/frame";
import type { HangerGeometry } from "../solid/hangers";
import type { LabelGeometry } from "../solid/labels";
import type { LetteringGeometry } from "../solid/lettering";
import type { Arena, Manifold, ManifoldToplevel } from "../solid/manifold";
import type { MinWallReport } from "../solid/measure";
import type { OrnamentGeometry } from "../solid/ornaments";
import type { RepairedBuildings } from "../solid/repair";
import type { BuiltTrees } from "../solid/trees";
import type { BuiltRegion } from "../solid/validate";
import type {
  AuditFinding,
  EngineResult,
  EngineStats,
  ExportFile,
  RecessBand,
  RegionMesh,
  RegionName,
  TerrainGrid,
  TerrainSampler,
  TileResult,
} from "../types";
import type { FetchOverpassOptions } from "../osm/overpass";
import { REGION_NAMES } from "../types";
import type { ExportTarget } from "../export/index";
import type { ColorChangePlan } from "../export/colorchange";
import type { SourceLocation } from "../export/common";
import type { StageChannels } from "./cache";
import type { ParamClaim, ParamPath, ParamValue } from "./paths";

// ---------------------------------------------------------------------------
// Ids and phases
// ---------------------------------------------------------------------------

export type Phase = "scene" | "geometry" | "region" | "audit" | "export";

export const PHASES: readonly Phase[] = ["scene", "geometry", "region", "audit", "export"];

export type RegionStageId = `region-${RegionName}`;
export type FinishStageId = `finish-${RegionName}`;

export type StaticStageId =
  | "fetch"
  | "normalise"
  | "context"
  | "terrain"
  | "heroes"
  | "repair-buildings"
  | "surface-overrides"
  | "surface-water"
  | "surface-rail"
  | "surface-roads"
  | "surface-parks"
  | "buildings"
  | "bridges"
  | "trees"
  | "tokens"
  | "fonts"
  | "labels"
  | "lettering"
  | "ornaments"
  | "attribution"
  | "hangers"
  | "frame-cutters"
  | "base"
  | "frame-blank"
  | "frame"
  | "sit"
  | "assembly"
  | "merged"
  | "measure"
  | "validate"
  | "islands"
  | "tiling"
  | "audit"
  | "export";

export type StageId = StaticStageId | RegionStageId | FinishStageId;

export const REGION_STAGE_IDS: readonly RegionStageId[] = REGION_NAMES.map(
  (name) => `region-${name}` as RegionStageId,
);
export const FINISH_STAGE_IDS: readonly FinishStageId[] = REGION_NAMES.map(
  (name) => `finish-${name}` as FinishStageId,
);

export function regionStageId(region: RegionName): RegionStageId {
  return `region-${region}`;
}

export function finishStageId(region: RegionName): FinishStageId {
  return `finish-${region}`;
}

/** The region a `region-*` or `finish-*` id names, or null for any other stage. */
export function regionOfStage(id: StageId): RegionName | null {
  for (const region of REGION_NAMES) {
    if (id === `region-${region}` || id === `finish-${region}`) return region;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extras: the non-PrintParams inputs a stage may declare
// ---------------------------------------------------------------------------

/** What an `export` job asks for, hashed into the export stage's key. */
export interface ExportRequest {
  /** Defaults to `PrintParams.export_target`. */
  target?: ExportTarget;
  stem?: string;
  title?: string;
  source?: SourceLocation;
  /** ISO timestamp the files are stamped with; `new Date()` at the caller when absent. */
  createdIso: string;
  layerHeightMm?: number;
  /** Ship the files even when the printability gate failed a Stage 4 check (`export/gate.ts`). */
  force?: boolean;
}

/**
 * The heightfield a job carries. `gate: "param"` lets the `terrain` stage
 * decide from `terrain.enabled` whether to use it (the app); `gate: "always"`
 * makes a provided grid authoritative (`buildModel()` callers, the CLI).
 */
export interface TerrainGridInput {
  grid: TerrainGrid | null;
  gate: "param" | "always";
}

export interface ExtraValues {
  /** The Overpass request; null when the job was given a finished scene. */
  "scene-request": SceneRequest | null;
  "terrain-grid": TerrainGridInput | null;
  /** A caller-resolved hero id list that overrides the `heroes` stage's own resolution; null to resolve in the worker. */
  "hero-ids": string[] | null;
  /** ISO date the `{date}` token expands to and the marks are stamped with. */
  date: string;
  /** The SceneRequest's rotation, degrees counter-clockwise: the north arrow turns back by it. */
  rotation: number;
  "export-request": ExportRequest | null;
  /**
   * The whole params object, hashed as one: what the exporters persist as the
   * file's parameter echo (`print_params`, the 3MF Description). Claimed by
   * `export` only, so a leaf no stage reads (the `part_colors.*` block) still
   * moves the file it is written into.
   */
  "params-echo": PrintParams;
}

export type ExtraKey = keyof ExtraValues;

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface FetchOut {
  raw: OverpassResponse;
  fromCache: boolean;
}

export interface NormaliseOut {
  scene: EngineSceneGraph;
}

/** The pure numbers `makeContext` derives, with no handles and no channels. */
export interface ContextOut {
  scale: number;
  radiusM: number;
  thresholdsMm: BuildContext["thresholdsMm"];
  thresholdsGroundM: BuildContext["thresholdsGroundM"];
  baseTopMm: number;
  plateHalfMm: number;
  cropHalfMm: number;
  recessClipHalfMm: number;
}

export interface TerrainOut {
  sampler: TerrainSampler | null;
  drape: Drape | null;
}

export interface HeroesOut {
  ids: string[];
}

/** A surface layer's repaired footprint: pass one of the layer pipeline. */
export type SurfaceLayerOut = RepairedSurface | null;

/**
 * The override groups' own layers (v3.1 Task 11), repaired before every
 * ordinary layer so an object the user singled out owns its ground.
 *
 * `unbuilt` names the groups that asked for a treatment and produced no
 * geometry on this plate, so the audit can say which decision did nothing
 * rather than leaving the user to notice.
 */
export interface SurfaceOverridesOut {
  surfaces: RepairedSurface[];
  unbuilt: string[];
}

/** Every surface region, extruded, in precedence order (the last layer's stage). */
export interface SurfacesOut {
  regions: SurfaceRegion[];
}

export interface TokensOut {
  tokens: TokenContext;
}

export interface FontsOut {
  faces: string[];
}

export type { RecessBand };

/** The surface labels, as solids per target region plus the bands the validator and the gizmo read. */
export type LabelsOut = LabelGeometry;

export interface LetteringOut extends LetteringGeometry {
  recessBands: RecessBand[];
}

export interface OrnamentsOut extends OrnamentGeometry {
  recessBands: RecessBand[];
}

export interface HangersOut extends HangerGeometry {
  recessBands: RecessBand[];
}

export interface FrameCuttersOut {
  shadowGap: Manifold | null;
  matting: Manifold | null;
  mating: FrameMating;
  texture: Manifold | null;
}

export interface BaseOut {
  solid: Manifold;
}

export interface FrameBlankOut {
  /** The frame lip as built, null with the frame off. */
  lip: Manifold | null;
  /** The lip with every cutter that is not lettering already taken out of it: the attribution marks, the ornaments, the mating features and the texture. Evaluated, not lazy. */
  blank: Manifold | null;
}

export interface FrameOut {
  /** The frame region solid, null with the frame off. */
  frame: Manifold | null;
  /** The lip with embossed text added, before the cutters: what the assembly welds. */
  raisedFrame: Manifold | null;
}

export interface RegionOut {
  solid: Manifold | null;
}

export interface SitOut {
  /** The Z translation that puts the model on the bed, mm (0 for a normal build). */
  shiftMm: number;
}

export type FinishOut = BuiltRegion | null;

export interface AssemblyOut {
  assembly: Manifold | null;
}

export interface MergedOut {
  /** The debris-free welded solid, sitting on the bed. Null for an empty scene. */
  clean: Manifold | null;
  mesh: RegionMesh;
}

export type MeasureOut = MinWallReport | null;

export type ValidateOut = AuditFinding[];

export type IslandsOut = IslandReport[];

export type TilingOut = TileResult[];

export interface AuditOut {
  findings: AuditFinding[];
  stats: EngineStats;
}

export interface ExportOut {
  target: ExportTarget;
  files: ExportFile[];
  sidecar: Record<string, unknown>;
  sidecarName: string;
  notes: string[];
  /**
   * Findings the WRITER raised: what the chosen format could not carry.
   *
   * Optional so an older cached export payload, and a test fixture that predates
   * it, still satisfy the type; the stage always sets it.
   */
  findings?: AuditFinding[];
  plan: ColorChangePlan | null;
}

export interface StaticStageOutputs {
  fetch: FetchOut;
  normalise: NormaliseOut;
  context: ContextOut;
  terrain: TerrainOut;
  heroes: HeroesOut;
  "repair-buildings": RepairedBuildings;
  "surface-overrides": SurfaceOverridesOut;
  "surface-water": SurfaceLayerOut;
  "surface-rail": SurfaceLayerOut;
  "surface-roads": SurfaceLayerOut;
  "surface-parks": SurfacesOut;
  buildings: BuiltBuildings;
  bridges: BridgeRegion[];
  trees: BuiltTrees;
  tokens: TokensOut;
  fonts: FontsOut;
  labels: LabelsOut;
  lettering: LetteringOut;
  ornaments: OrnamentsOut;
  attribution: AttributionGeometry;
  hangers: HangersOut;
  "frame-cutters": FrameCuttersOut;
  base: BaseOut;
  "frame-blank": FrameBlankOut;
  frame: FrameOut;
  sit: SitOut;
  assembly: AssemblyOut;
  merged: MergedOut;
  measure: MeasureOut;
  validate: ValidateOut;
  islands: IslandsOut;
  tiling: TilingOut;
  audit: AuditOut;
  export: ExportOut;
}

export type StageOutputs = StaticStageOutputs & { [K in RegionStageId]: RegionOut } & {
  [K in FinishStageId]: FinishOut;
};

export type OutputOf<Id extends StageId> = StageOutputs[Id];

// ---------------------------------------------------------------------------
// Context and definition
// ---------------------------------------------------------------------------

/**
 * A claim whose cache key is a digest of the value rather than the value.
 *
 * `context` reads `frame_style.profile` only to ask "is it floating?" (a
 * floating frame carries a 2 mm gap the city gives way to). Keying on the raw
 * string would rebuild the whole model for a plain-to-chamfer change that moves
 * nothing under the context; keying on the digest keeps the claim honest (the
 * strict proxy still sees the read) without the false dependency.
 */
export interface KeyedClaim {
  path: ParamPath;
  /** Rendered in `describeGraph()` as `path=label` so the table shows the digest. */
  label: string;
  key: (value: unknown) => unknown;
}

export type StageParamClaim = ParamClaim | KeyedClaim;

export interface StageContext<Id extends StageId = StageId> {
  readonly id: Id;
  /** Read one declared parameter leaf. Throws in strict-claims mode for an undeclared path. */
  param<P extends ParamPath>(path: P): ParamValue<P>;
  /** Read one declared extra. Throws for an undeclared key. */
  extra<K extends ExtraKey>(key: K): ExtraValues[K];
  /** Read one declared upstream output. Throws for an undeclared input. */
  input<S extends StageId>(id: S): OutputOf<S>;
  readonly wasm: ManifoldToplevel;
  /** This stage's temporaries. Handles referenced by the returned output are moved to the cache; the rest die with the stage. */
  readonly arena: Arena;
  /** The scene (`normalise`'s output). Throws when `normalise` is not an input. */
  readonly scene: EngineSceneGraph;
  /**
   * The params object for helpers that take `PrintParams` whole
   * (`resolveProfile`, `T.*`). In strict-claims mode this is the recording
   * proxy, so every leaf such a helper touches is checked and recorded.
   */
  readonly params: PrintParams;
  /**
   * A `BuildContext` for the solid modules: the `context` numbers, the scene,
   * the params, this stage's arena and this stage's own findings channels.
   * `terrain` is the `terrain` stage's sampler when that stage is an input,
   * else null. Throws when `context` is not an input.
   */
  readonly build: BuildContext;
  /** The same, with an explicit sampler: only the `terrain` stage needs it. */
  buildWith(terrain: TerrainSampler | null): BuildContext;
  /** This stage's output channels, also reachable as `build.findings` and friends. */
  readonly channels: StageChannels;
  /** Overpass client options for the `fetch` stage: the realm's cache, the abort signal, test injections. */
  readonly overpass: FetchOverpassOptions;
  /** Milliseconds since this job started: what `EngineStats.elapsedMs` reports. */
  elapsedMs(): number;
  /**
   * Every finding raised by the stages before this one, in registry order,
   * read from their cached channels. Only the `audit` stage asks; it is how a
   * memoised stage that did not re-run still contributes its findings.
   */
  findingsBefore(): AuditFinding[];
  /** The `EngineResult` assembled from the cache (`result.ts`). Only the `export` stage asks, and only with `audit` among its inputs. */
  assembled(): EngineResult;
}

export interface StageDef<Id extends StageId = StageId> {
  /** String literal, unique, kebab-case. */
  readonly id: Id;
  readonly phase: Phase;
  /** Parameter leaves this stage reads; a prefix `group.*` expands to every leaf under it. */
  readonly params: readonly StageParamClaim[];
  /** Upstream outputs it consumes; every one must be declared earlier in the registry. */
  readonly inputs: readonly StageId[];
  readonly extra?: readonly ExtraKey[];
  /**
   * Named digests of PARTS of this stage's output, for consumers that read
   * only that part (`inputDigests`). A digest function returns a string that
   * stands for the part, or null to mean "the whole output's digest": the one
   * safe non-null answer for a list of solids is the constant for an EMPTY
   * list, because two different non-empty cutter sets cannot be told apart
   * without comparing geometry. `base` reads the lettering's underside cutters
   * this way, so a frame-edge text change leaves the base cached.
   */
  readonly digests?: Readonly<Record<string, (output: OutputOf<Id>) => string | null>>;
  /** For an input, the named digest of it this stage's key hashes instead of the whole output's. */
  readonly inputDigests?: Partial<Record<StageId, string>>;
  run(ctx: StageContext<Id>): OutputOf<Id> | Promise<OutputOf<Id>>;
}

export function defineStage<Id extends StageId>(def: StageDef<Id>): StageDef<Id> {
  return def;
}

export function isKeyedClaim(claim: StageParamClaim): claim is KeyedClaim {
  return typeof claim !== "string";
}

/** The leaf-or-prefix form of a claim, for expansion. */
export function claimPattern(claim: StageParamClaim): ParamClaim {
  return isKeyedClaim(claim) ? claim.path : claim;
}
