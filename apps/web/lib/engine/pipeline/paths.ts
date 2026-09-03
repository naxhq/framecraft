/**
 * Parameter paths: the vocabulary a stage uses to say what it reads.
 *
 * `ParamPath` is the generated `PRINT_PARAM_LEAF_PATHS` union
 * (`lib/contracts.ts`, from `packages/contracts/gen_ts.py`): every leaf of
 * `print_params.json` as a dotted path, arrays of objects as `engravings[].text`,
 * arrays of scalars as one leaf. A stage may also claim a prefix (`frame_style.*`),
 * which `expandClaims` turns into the leaves under it, so the registry stays
 * readable while the graph test still works leaf by leaf.
 */

import { PRINT_PARAM_LEAF_PATHS, type PrintParamPath, type PrintParams } from "../../contracts";

export type ParamPath = PrintParamPath;

/** A leaf path, or a prefix ending in `.*` that expands to every leaf under it. */
export type ParamClaim = ParamPath | `${string}.*`;

export const PARAM_PATHS: readonly ParamPath[] = PRINT_PARAM_LEAF_PATHS;

const PATH_SET: ReadonlySet<string> = new Set<string>(PRINT_PARAM_LEAF_PATHS);

export function isParamPath(value: string): value is ParamPath {
  return PATH_SET.has(value);
}

/**
 * Expand prefix claims against the generated leaf list, in schema order,
 * de-duplicated. Throws for a claim that names nothing: a claim that matches no
 * leaf is a typo, and a typo in a claim is exactly the kind of silent drift the
 * registry exists to rule out.
 */
export function expandClaims(claims: readonly ParamClaim[]): ParamPath[] {
  const wanted = new Set<string>();
  for (const claim of claims) {
    if (claim.endsWith(".*")) {
      const prefix = claim.slice(0, -1);
      let hit = false;
      for (const path of PRINT_PARAM_LEAF_PATHS) {
        if (path.startsWith(prefix)) {
          wanted.add(path);
          hit = true;
        }
      }
      if (!hit) throw new Error(`pipeline: the claim ${claim} matches no PrintParams leaf`);
      continue;
    }
    if (!PATH_SET.has(claim)) throw new Error(`pipeline: ${claim} is not a PrintParams leaf path`);
    wanted.add(claim);
  }
  return PRINT_PARAM_LEAF_PATHS.filter((path) => wanted.has(path));
}

type Idx<T, K extends string> = T extends undefined | null
  ? undefined
  : K extends keyof T
    ? T[K]
    : never;

type ElementOf<T> = T extends undefined | null
  ? undefined
  : T extends readonly (infer I)[]
    ? I
    : never;

/**
 * The value type at a dotted path into `PrintParams`. Optional groups make every
 * nested leaf `| undefined`, exactly as `params.colour?.palette` would read.
 */
export type PathValue<T, P extends string> = P extends `${infer K}[].${infer R}`
  ? Array<PathValue<ElementOf<Idx<T, K>>, R>> | undefined
  : P extends `${infer K}.${infer R}`
    ? PathValue<Idx<T, K>, R>
    : Idx<T, P>;

export type ParamValue<P extends ParamPath> = PathValue<PrintParams, P>;

/**
 * Read one leaf path off a params object. An `[]` segment maps over the array,
 * so `engravings[].text` reads as the list of texts (its length included), and a
 * missing group reads as `undefined` rather than throwing.
 */
export function readParamPath(params: unknown, path: string): unknown {
  return readSegments(params, path.split("."));
}

function readSegments(node: unknown, segments: readonly string[]): unknown {
  let current: unknown = node;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (current === undefined || current === null) return undefined;
    if (segment.endsWith("[]")) {
      const key = segment.slice(0, -2);
      const list = (current as Record<string, unknown>)[key];
      if (!Array.isArray(list)) return undefined;
      const rest = segments.slice(i + 1);
      return list.map((item) => readSegments(item, rest));
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** The top-level key of a path (`colour.palette` -> `colour`, `engravings[].text` -> `engravings`). */
export function pathRoot(path: string): string {
  const dot = path.indexOf(".");
  const head = dot === -1 ? path : path.slice(0, dot);
  return head.endsWith("[]") ? head.slice(0, -2) : head;
}
