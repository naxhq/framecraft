/**
 * Strict-claims mode: a Proxy over the params object that throws when a stage
 * reads a parameter leaf it did not declare, and records every leaf it did.
 *
 * This is what makes the registry's `params` lists trustworthy rather than
 * aspirational (design 3.2). The graph test and the claim-discovery script
 * turn it on; production runs read the plain object and pay nothing.
 *
 * The proxy walks the params tree: reading a declared leaf records it and
 * returns the raw value; reading a group that has declared leaves under it
 * returns a proxy for that group (arrays of objects proxy their elements under
 * the `name[].` prefix); reading anything else throws. Spreading a group
 * (`{...params.tiling}`) reads every key under it, which is exactly what it
 * is: a dependency on every leaf.
 */

import type { PrintParams } from "../../contracts";
import type { ParamPath } from "./paths";
import type { StageId } from "./stage";

export class UndeclaredParamReadError extends Error {
  readonly stage: StageId;
  readonly path: string;
  constructor(stage: StageId, path: string) {
    super(`pipeline: stage ${stage} read ${path}, which it does not claim`);
    this.name = "UndeclaredParamReadError";
    this.stage = stage;
    this.path = path;
  }
}

/** Property names any object may be asked for without it being a parameter read. */
const NEUTRAL_KEYS: ReadonlySet<string> = new Set([
  "constructor",
  "toJSON",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "then",
  "length",
  "__proto__",
]);

export interface StrictParamsOptions {
  stage: StageId;
  declared: ReadonlySet<ParamPath>;
  onRead: (path: ParamPath) => void;
  /**
   * Record an undeclared read and let it through instead of throwing. The
   * claim-discovery script uses it to collect every violation of a run at
   * once; the graph test leaves it unset so a violation fails loudly.
   */
  onUndeclared?: (path: string) => void;
}

/**
 * Every proxy this module (and `solid/context.ts:withEngravings`) has created.
 * The runner's output walk skips them: a stage output that happens to hold an
 * engraving object or a params view must not be read as if it were geometry.
 */
const PARAM_VIEWS = new WeakSet<object>();

export function registerParamView(view: object): void {
  PARAM_VIEWS.add(view);
}

export function isParamView(value: object): boolean {
  return PARAM_VIEWS.has(value);
}

export function strictParams(params: PrintParams, options: StrictParamsOptions): PrintParams {
  const { declared } = options;
  const prefixes = new Set<string>();
  for (const path of declared) {
    const parts = path.split(".");
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      prefix = prefix === "" ? parts[i] : `${prefix}.${parts[i]}`;
      prefixes.add(prefix);
    }
  }
  return proxyNode(params as unknown as object, "", options, prefixes) as unknown as PrintParams;
}

function proxyNode(
  target: object,
  prefix: string,
  options: StrictParamsOptions,
  prefixes: ReadonlySet<string>,
): object {
  const isArray = Array.isArray(target);
  const view = new Proxy(target, {
    get(node, key, receiver) {
      if (typeof key === "symbol") return Reflect.get(node, key, receiver);
      if (isArray) {
        if (/^\d+$/.test(key)) {
          const item: unknown = (node as unknown[])[Number(key)];
          return item !== null && typeof item === "object"
            ? proxyNode(item, prefix, options, prefixes)
            : item;
        }
        // `length` and the array methods; a method called on the proxy reads
        // its elements back through this trap.
        return Reflect.get(node, key, receiver);
      }
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (options.declared.has(path as ParamPath)) {
        options.onRead(path as ParamPath);
        return Reflect.get(node, key, receiver);
      }
      if (prefixes.has(path) || prefixes.has(`${path}[]`)) {
        const child: unknown = Reflect.get(node, key, receiver);
        if (child === null || child === undefined || typeof child !== "object") return child;
        const childPrefix = Array.isArray(child) ? `${path}[]` : path;
        return proxyNode(child, childPrefix, options, prefixes);
      }
      if (NEUTRAL_KEYS.has(key)) return Reflect.get(node, key, receiver);
      if (options.onUndeclared !== undefined) {
        options.onUndeclared(path);
        const child: unknown = Reflect.get(node, key, receiver);
        // Keep recording below this node: a group read that was not declared
        // is reported once for the group and once per leaf read under it.
        if (child !== null && typeof child === "object") {
          return proxyNode(child, Array.isArray(child) ? `${path}[]` : path, options, prefixes);
        }
        return child;
      }
      throw new UndeclaredParamReadError(options.stage, path);
    },
  });
  PARAM_VIEWS.add(view);
  return view;
}
