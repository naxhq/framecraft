/**
 * The pipeline's public surface.
 *
 * `runPipeline` over a `StageCache` is the engine; `PipelineSession` (in
 * `../protocol.ts`) adds single flight and the worker protocol on top, and
 * `PipelineClient` (in `../client.ts`) is the main-thread handle. Tests and
 * the CLI use what is here directly.
 */

export { StageCache } from "./cache";
export type { CacheEntry, StageChannels } from "./cache";
export { UndeclaredParamReadError, strictParams } from "./claims";
export {
  claimedPaths,
  claimsOf,
  consumersOf,
  describeGraph,
  describeGraphMarkdown,
  downstreamOf,
  stageIds,
  stageIndex,
  stagesInvalidatedBy,
  stagesReading,
  upstreamOf,
  validateGraph,
} from "./graph";
export type { GraphDescription, StageDescription } from "./graph";
export { hashBytes, hashParts, hashString, stableJson } from "./hash";
export { PARAM_PATHS, expandClaims, isParamPath, pathRoot, readParamPath } from "./paths";
export type { ParamClaim, ParamPath, ParamValue, PathValue } from "./paths";
export { assembleResult, finishedRegions, regionHashes, resolveParamsEcho, strippedMesh, strippedTiles } from "./result";
export { REGION_BATCH_MS, collectHandles, keyPartsFor, planFor, runPipeline, seedSceneHash } from "./runner";
export type {
  Emit,
  OverpassOptions,
  PipelineEvent,
  PipelineJob,
  RunMode,
  RunOptions,
  RunOutcome,
  SceneSource,
  StageEvent,
  StageRecord,
  StageState,
} from "./runner";
export {
  FINISH_STAGE_IDS,
  PHASES,
  REGION_STAGE_IDS,
  defineStage,
  finishStageId,
  regionOfStage,
  regionStageId,
} from "./stage";
export type {
  AuditOut,
  ExportOut,
  ExportRequest,
  ExtraKey,
  ExtraValues,
  FinishStageId,
  KeyedClaim,
  OutputOf,
  Phase,
  RegionStageId,
  StageContext,
  StageDef,
  StageId,
  StageOutputs,
  StageParamClaim,
  StaticStageId,
  TerrainGridInput,
} from "./stage";
export { OverpassStageError, STAGES, isStageId, stageById } from "./stages";
