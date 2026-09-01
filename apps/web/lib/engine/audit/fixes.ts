/**
 * Applying a finding's one-click fix.
 *
 * An `AuditFinding.fix.patch` is a DEEP PARTIAL of `PrintParams`: an object
 * whose leaves replace the leaves under the same path and whose absent keys
 * change nothing. Arrays replace wholesale (there is no sensible element-wise
 * merge of `engravings`), every other object recurses. Nothing here knows what
 * any particular rule means; the rules in `rules.ts` own the wording and the
 * numbers, this file owns the write.
 *
 * Two guarantees the callers rely on:
 *
 * * the input `params` is never mutated - a new object comes back, sharing
 *   every subtree the patch did not touch;
 * * every leaf that actually MOVED is reported in `changes`, so the UI can say
 *   what it did rather than "3 issues fixed", and a patch that asks for the
 *   value already there is reported as changing nothing.
 *
 * `nozzle_mm` is refused, always (DECISIONS `[V3-P3-G12]`): it describes the
 * hardware, and no automatic fix may pretend the printer is finer than it is.
 * The refusal is a `skipped` entry rather than a throw, because a fix arriving
 * from a stale share link or a future rule must not take the editor down.
 */

import type { PrintParams } from "../../contracts";
import type { AuditFinding, FixApplication, FixChange } from "../types";

/** Parameter keys no automatic fix may ever write, at any depth. */
export const FORBIDDEN_FIX_KEYS: readonly string[] = ["nozzle_mm"];

/** How each patched path reads in a sentence; the dotted path is the fallback. */
const PATH_LABELS: Readonly<Record<string, string>> = {
  plate_mm: "Plate",
  base_thickness_mm: "Base thickness",
  large_scale: "Tall-building multiplier",
  terrain_exaggeration: "Terrain exaggeration",
  trees: "Tree markers",
  frame: "Frame",
  "tiling.enabled": "Tiling",
  "tiling.cols": "Tile columns",
  "tiling.rows": "Tile rows",
  "tiling.joint": "Tile joint",
  "tiling.tolerance_mm": "Tile joint tolerance",
  "bridges.enabled": "Bridge decks",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!sameValue(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

function describe(value: unknown): string {
  if (value === undefined) return "unset";
  if (value === null) return "none";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") return String(Number(value.toFixed(3)));
  if (typeof value === "string") return value === "" ? "empty" : value;
  if (Array.isArray(value)) return `${value.length} item(s)`;
  return "a group of settings";
}

function labelFor(path: string, before: unknown, after: unknown): string {
  const name = PATH_LABELS[path] ?? path;
  return `${name} ${describe(before)} becomes ${describe(after)}`;
}

/** Every key in a patch, at every depth, dotted. */
export function patchPaths(patch: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (isPlainObject(value)) out.push(...patchPaths(value, path));
    else out.push(path);
  }
  return out;
}

/** True when a patch writes something no fix is allowed to write. */
export function patchIsForbidden(patch: Record<string, unknown>): string | null {
  for (const path of patchPaths(patch)) {
    const leaf = path.slice(path.lastIndexOf(".") + 1);
    if (FORBIDDEN_FIX_KEYS.includes(leaf)) return leaf;
  }
  return null;
}

function mergeInto(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
  findingId: string,
  prefix: string,
  changes: FixChange[],
): Record<string, unknown> {
  let next = target;
  let copied = false;
  const write = (key: string, value: unknown): void => {
    if (!copied) {
      next = { ...target };
      copied = true;
    }
    next[key] = value;
  };
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    const before = target[key];
    if (isPlainObject(value)) {
      const child = isPlainObject(before) ? before : {};
      const merged = mergeInto(child, value, findingId, path, changes);
      if (merged !== child || !isPlainObject(before)) write(key, merged);
      continue;
    }
    if (sameValue(before, value)) continue;
    changes.push({ path, before, after: value, findingId, label: labelFor(path, before, value) });
    write(key, value);
  }
  return next;
}

/**
 * Apply one finding's fix.
 *
 * A finding with no fix, or one whose patch is refused, comes back with the
 * parameters untouched and a `skipped` entry saying why.
 */
export function applyFix(params: PrintParams, finding: AuditFinding): FixApplication {
  const fix = finding.fix;
  if (fix === undefined) {
    return {
      params,
      changes: [],
      applied: [],
      skipped: [{ id: finding.id, reason: "this issue has no one-click fix" }],
    };
  }
  const forbidden = patchIsForbidden(fix.patch);
  if (forbidden !== null) {
    return {
      params,
      changes: [],
      applied: [],
      skipped: [{ id: finding.id, reason: `a fix may never change ${forbidden}` }],
    };
  }
  const changes: FixChange[] = [];
  const source = params as unknown as Record<string, unknown>;
  const merged = mergeInto(source, fix.patch, finding.id, "", changes);
  if (changes.length === 0) {
    return {
      params,
      changes: [],
      applied: [],
      skipped: [{ id: finding.id, reason: "the settings already say what the fix asks for" }],
    };
  }
  return {
    params: merged as unknown as PrintParams,
    changes,
    applied: [finding.id],
    skipped: [],
  };
}

/**
 * Apply every SAFE fix, in the order the findings are given.
 *
 * "Safe" is the rules' own promise that a fix cannot make another finding worse
 * and throws away nothing the user asked for (`rules.ts`). Later fixes see the
 * parameters the earlier ones wrote, so two fixes that touch the same key
 * compose instead of racing, and the second one is reported as changing nothing
 * when the first already wrote its value.
 */
export function applySafeFixes(
  params: PrintParams,
  findings: readonly AuditFinding[],
): FixApplication {
  let current = params;
  const changes: FixChange[] = [];
  const applied: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const finding of findings) {
    if (finding.fix === undefined) continue;
    if (!finding.fix.safe) {
      skipped.push({ id: finding.id, reason: "this fix changes the design, so it needs a decision" });
      continue;
    }
    const step = applyFix(current, finding);
    current = step.params;
    changes.push(...step.changes);
    applied.push(...step.applied);
    // A safe fix that wrote nothing is not worth a line in the UI's list.
    for (const entry of step.skipped) {
      if (entry.reason.startsWith("the settings already")) continue;
      skipped.push(entry);
    }
  }
  return { params: current, changes, applied, skipped };
}

/** True when any finding in the list carries a fix "Auto-fix all safe" would run. */
export function hasSafeFixes(findings: readonly AuditFinding[]): boolean {
  return findings.some((finding) => finding.fix?.safe === true);
}
