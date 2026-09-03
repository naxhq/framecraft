/**
 * The stage graph as data: validation, claim expansion, downstream queries and
 * the machine-readable table the pipeline note embeds.
 *
 * Validation runs at module load and throws, so a registry mistake (an input
 * declared after its consumer, an unknown id, a claim that matches no leaf) is
 * a broken import rather than a wrong cache key discovered in production.
 */

import { expandClaims, type ParamPath } from "./paths";
import { PHASES, claimPattern, isKeyedClaim, type Phase, type StageDef, type StageId } from "./stage";
import { STAGES } from "./stages";

export class GraphError extends Error {
  constructor(message: string) {
    super(`pipeline graph: ${message}`);
    this.name = "GraphError";
  }
}

/** The expanded leaf claims of every stage, computed once. */
const CLAIMS: ReadonlyMap<StageId, readonly ParamPath[]> = new Map(
  STAGES.map((stage) => [stage.id, expandClaims(stage.params.map(claimPattern))]),
);

const INDEX: ReadonlyMap<StageId, number> = new Map(STAGES.map((stage, index) => [stage.id, index]));

/** Every check the registry has to pass. Called at load; exported for the graph test. */
export function validateGraph(stages: readonly StageDef[] = STAGES): void {
  const seen = new Set<StageId>();
  let lastPhase = -1;
  for (const stage of stages) {
    if (seen.has(stage.id)) throw new GraphError(`duplicate stage id ${stage.id}`);
    if (!/^[a-z][a-z0-9_-]*$/.test(stage.id)) throw new GraphError(`stage id ${stage.id} is not kebab-case`);
    const phaseIndex = PHASES.indexOf(stage.phase);
    if (phaseIndex === -1) throw new GraphError(`stage ${stage.id} has unknown phase ${stage.phase}`);
    if (phaseIndex < lastPhase) throw new GraphError(`stage ${stage.id} (${stage.phase}) is declared after a later phase`);
    lastPhase = phaseIndex;
    for (const input of stage.inputs) {
      if (input === stage.id) throw new GraphError(`stage ${stage.id} lists itself as an input`);
      if (!seen.has(input)) throw new GraphError(`stage ${stage.id} consumes ${input}, which is not declared before it`);
    }
    if (new Set(stage.inputs).size !== stage.inputs.length) throw new GraphError(`stage ${stage.id} lists an input twice`);
    // Throws for a claim that names no leaf.
    expandClaims(stage.params.map(claimPattern));
    seen.add(stage.id);
  }
}

validateGraph();

export function stageIds(): StageId[] {
  return STAGES.map((stage) => stage.id);
}

export function stageIndex(id: StageId): number {
  const index = INDEX.get(id);
  if (index === undefined) throw new GraphError(`unknown stage ${id}`);
  return index;
}

/** The leaf paths a stage claims, prefixes expanded, in schema order. */
export function claimsOf(id: StageId): readonly ParamPath[] {
  return CLAIMS.get(id) ?? [];
}

/** Every stage that claims `path`, in registry order. */
export function stagesReading(path: ParamPath): StageId[] {
  return STAGES.filter((stage) => claimsOf(stage.id).includes(path)).map((stage) => stage.id);
}

/** Every leaf path claimed by at least one stage. */
export function claimedPaths(): Set<ParamPath> {
  const out = new Set<ParamPath>();
  for (const claims of CLAIMS.values()) for (const path of claims) out.add(path);
  return out;
}

/** The direct consumers of a stage, in registry order. */
export function consumersOf(id: StageId): StageId[] {
  return STAGES.filter((stage) => stage.inputs.includes(id)).map((stage) => stage.id);
}

/** A stage and every stage transitively downstream of it, in registry order. */
export function downstreamOf(ids: readonly StageId[]): StageId[] {
  const marked = new Set<StageId>(ids);
  for (const stage of STAGES) {
    if (marked.has(stage.id)) continue;
    if (stage.inputs.some((input) => marked.has(input))) marked.add(stage.id);
  }
  return STAGES.filter((stage) => marked.has(stage.id)).map((stage) => stage.id);
}

/** A stage and every stage transitively upstream of it, in registry order. */
export function upstreamOf(ids: readonly StageId[]): StageId[] {
  const marked = new Set<StageId>(ids);
  for (let i = STAGES.length - 1; i >= 0; i -= 1) {
    const stage = STAGES[i];
    if (!marked.has(stage.id)) continue;
    for (const input of stage.inputs) marked.add(input);
  }
  return STAGES.filter((stage) => marked.has(stage.id)).map((stage) => stage.id);
}

/** Every stage that re-runs when any of `paths` changes: the claimants and everything below them. */
export function stagesInvalidatedBy(paths: readonly ParamPath[]): StageId[] {
  const roots: StageId[] = [];
  for (const path of paths) for (const id of stagesReading(path)) roots.push(id);
  return downstreamOf(roots);
}

export interface StageDescription {
  id: StageId;
  phase: Phase;
  /** Leaf paths, prefixes expanded; a keyed claim renders as `path=label`. */
  params: string[];
  /** Upstream stage ids; an input read through a named part digest renders as `stage#part`. */
  inputs: string[];
  extra: string[];
  /** The named part digests this stage defines for its consumers. */
  digests: string[];
}

export interface GraphDescription {
  stages: StageDescription[];
}

/** The registry as plain JSON, for the pipeline note and the graph test. */
export function describeGraph(): GraphDescription {
  return {
    stages: STAGES.map((stage) => {
      const keyed = new Map<string, string>();
      for (const claim of stage.params) {
        if (isKeyedClaim(claim)) keyed.set(claim.path, claim.label);
      }
      return {
        id: stage.id,
        phase: stage.phase,
        params: claimsOf(stage.id).map((path) => {
          const label = keyed.get(path);
          return label === undefined ? path : `${path}=${label}`;
        }),
        inputs: stage.inputs.map((input) => {
          const part = stage.inputDigests?.[input];
          return part === undefined ? input : `${input}#${part}`;
        }),
        extra: [...(stage.extra ?? [])],
        digests: Object.keys(stage.digests ?? {}),
      };
    }),
  };
}

/** The table as one markdown block, one row per stage, for a handoff note. */
export function describeGraphMarkdown(): string {
  const lines = ["| # | id | phase | params | inputs | extra | digests |", "|---|---|---|---|---|---|---|"];
  describeGraph().stages.forEach((stage, index) => {
    lines.push(
      `| ${index + 1} | \`${stage.id}\` | ${stage.phase} | ${stage.params.join(", ") || "(none)"} | ${stage.inputs.join(", ") || "(none)"} | ${stage.extra.join(", ") || "(none)"} | ${stage.digests.join(", ") || "(none)"} |`,
    );
  });
  return `${lines.join("\n")}\n`;
}
