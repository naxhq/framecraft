/**
 * Assembling an `EngineResult` from the cache, in stage order.
 *
 * Findings, resolved text and mark bands are stage outputs (each stage's own
 * channels, stored beside its output), concatenated here in registry order, so
 * a memoised stage that did not re-run still contributes what it said the
 * last time it did (design ruling 8). The audit stage is the one exception by
 * design: its output IS the final ordered finding list, built from the same
 * concatenation plus the gate's findings.
 */

import type { Engraving, PrintParams } from "../../contracts";
import type { EngineResult, RecessBand, RegionMesh, RegionName, ResolvedLine } from "../types";
import { REGION_NAMES } from "../types";
import type { StageCache } from "./cache";
import { finishStageId, type AuditOut, type FinishOut, type MergedOut, type StageId } from "./stage";
import { STAGES } from "./stages";

/** Stages whose channels feed the result, in registry order (everything before `audit`). */
function channelStages(): StageId[] {
  const out: StageId[] = [];
  for (const stage of STAGES) {
    if (stage.id === "audit") break;
    out.push(stage.id);
  }
  return out;
}

const CHANNEL_STAGES: readonly StageId[] = channelStages();

/** Every finding raised by the stages before `audit`, in registry order, from the cache. */
export function findingsBeforeAudit(cache: StageCache): EngineResult["findings"] {
  const out: EngineResult["findings"] = [];
  for (const id of CHANNEL_STAGES) {
    const entry = cache.get(id);
    if (entry === undefined) continue;
    for (const finding of entry.channels.findings) {
      // `addFinding`'s own rule, applied across stages: a repeat of the same id
      // and detail is said once.
      if (!out.some((f) => f.id === finding.id && f.detail === finding.detail)) out.push(finding);
    }
  }
  return out;
}

export function resolvedTextFromCache(cache: StageCache): ResolvedLine[] {
  const out: ResolvedLine[] = [];
  for (const id of CHANNEL_STAGES) {
    const entry = cache.get(id);
    if (entry !== undefined) out.push(...entry.channels.resolvedText);
  }
  return out;
}

export function markBandsFromCache(cache: StageCache): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const id of CHANNEL_STAGES) {
    const entry = cache.get(id);
    if (entry !== undefined) out.push(...entry.channels.markBands);
  }
  return out;
}

function recessBandsFromCache(cache: StageCache): RecessBand[] {
  const out: RecessBand[] = [];
  for (const id of ["lettering", "ornaments", "hangers"] as const) {
    const entry = cache.get<{ recessBands: RecessBand[] }>(id);
    if (entry !== undefined) out.push(...entry.output.recessBands);
  }
  return out;
}

/** The finished regions in `REGION_NAMES` order, from the cache. */
export function finishedRegions(cache: StageCache): Array<NonNullable<FinishOut>> {
  const out: Array<NonNullable<FinishOut>> = [];
  for (const region of REGION_NAMES) {
    const entry = cache.get<FinishOut>(finishStageId(region));
    if (entry !== undefined && entry.output !== null) out.push(entry.output);
  }
  return out;
}

/** `region -> key` for every finished region, from the cache. */
export function regionHashes(cache: StageCache): Record<string, string> {
  const out: Record<string, string> = {};
  for (const region of REGION_NAMES) {
    const entry = cache.get<FinishOut>(finishStageId(region));
    if (entry !== undefined && entry.output !== null) out[region] = entry.key;
  }
  return out;
}

/**
 * The `PrintParams` echoed on `EngineResult.params`, and from there into every
 * export's persisted `print_params`: every `{city}`-style token already
 * substituted, agreeing with `resolvedText`, and a line this build skipped
 * dropped rather than left showing text nothing was cut for (DECISIONS
 * `[V3-P2-E4]`). Mirrors `buildLettering`'s id scheme: `engraving-<i>` on a
 * frame edge, `underside-<i>` underneath, each counted within its own kind.
 */
export function resolveParamsEcho(params: PrintParams, resolvedText: readonly ResolvedLine[]): PrintParams {
  const all = params.engravings ?? [];
  let edgeCursor = 0;
  let undersideCursor = 0;
  const engravings: Engraving[] = [];
  for (const engraving of all) {
    const id = engraving.edge === "underside" ? `underside-${undersideCursor++}` : `engraving-${edgeCursor++}`;
    const line = resolvedText.find((l) => l.id === id);
    if (line !== undefined && line.status === "cuts") {
      engravings.push({ ...engraving, text: line.text });
    }
  }

  const mark = params.underside_mark;
  const markLine = resolvedText.find((l) => l.id === "underside-mark");
  const underside_mark =
    mark?.enabled === true
      ? markLine?.status === "cuts"
        ? { ...mark, template: markLine.text }
        : { ...mark, enabled: false }
      : mark;

  return { ...params, engravings, underside_mark };
}

export interface AssembleOptions {
  /**
   * Replace every region's positions and indices with empty arrays: what the
   * worker posts on `done` after it has streamed the meshes as `region-ready`.
   * The merged mesh is kept whole either way.
   */
  stripRegionMeshes?: boolean;
}

function strippedMesh(mesh: RegionMesh): RegionMesh {
  return { ...mesh, positions: new Float64Array(0), indices: new Uint32Array(0) };
}

/**
 * The `EngineResult` for the params the cache was last run with. Requires the
 * audit phase to be complete: `merged` and `audit` must be present.
 */
export function assembleResult(cache: StageCache, params: PrintParams, options: AssembleOptions = {}): EngineResult {
  const audit = cache.get<AuditOut>("audit");
  const merged = cache.get<MergedOut>("merged");
  if (audit === undefined || merged === undefined) {
    throw new Error("pipeline: the result cannot be assembled before the audit phase has run");
  }
  const built = finishedRegions(cache);
  const regions = built.map((region) => (options.stripRegionMeshes === true ? strippedMesh(region.mesh) : region.mesh));
  const resolvedText = resolvedTextFromCache(cache);
  const tiles = cache.get<import("./stage").TilingOut>("tiling")?.output ?? [];
  const buildings = cache.get<import("../solid/buildings").BuiltBuildings>("buildings")?.output;
  const bandSummaries =
    buildings !== undefined && buildings.bands.length > 1
      ? buildings.bands.map((band) => {
          const finished = built.find((region) => region.mesh.region === band.region);
          return {
            region: band.region as RegionName,
            slot: finished?.mesh.slot ?? 0,
            colorHex: finished?.mesh.colorHex ?? "#000000",
            topRangeMm: band.topRangeMm,
            buildings: band.count,
          };
        })
      : null;
  return {
    regions,
    merged: merged.output.mesh,
    stats: audit.output.stats,
    findings: audit.output.findings,
    resolvedText,
    params: resolveParamsEcho(params, resolvedText),
    attributionBands: markBandsFromCache(cache),
    recessBands: recessBandsFromCache(cache),
    ...(tiles.length === 0 ? {} : { tiles }),
    ...(buildings === undefined || buildings.tints.length === 0 ? {} : { buildingTints: buildings.tints }),
    ...(bandSummaries === null ? {} : { buildingBands: bandSummaries }),
  };
}
