/**
 * A canonical, comparable form of an `EngineResult` for the parity tests:
 * typed arrays become their byte hash, object keys are sorted, and the fields
 * that legitimately differ between two builds of the same parameters
 * (`elapsedMs`) are dropped. `diffCanonical` names the paths that differ, so a
 * failure says which field went stale rather than "objects differ".
 */

import { createHash } from "node:crypto";

export function canonical(value: unknown): unknown {
  if (value === undefined) return "<undefined>";
  if (value === null) return null;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const length = (value as unknown as { length?: unknown }).length;
    return `${value.constructor.name}[${typeof length === "number" ? length : view.byteLength}]:${createHash("sha1").update(bytes).digest("hex")}`;
  }
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      if (key === "elapsedMs") continue;
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Every path at which two canonical values differ, at most `limit` of them. */
export function diffCanonical(a: unknown, b: unknown, path = "", out: string[] = [], limit = 40): string[] {
  if (out.length >= limit || a === b) return out;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    out.push(`${path || "<root>"}: ${short(a)} != ${short(b)}`);
    return out;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      out.push(`${path}: array length ${Array.isArray(a) ? a.length : "?"} != ${Array.isArray(b) ? b.length : "?"}`);
      return out;
    }
    a.forEach((item, index) => diffCanonical(item, b[index], `${path}[${index}]`, out, limit));
    return out;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (!(key in left)) out.push(`${path}.${key}: missing on left`);
    else if (!(key in right)) out.push(`${path}.${key}: missing on right`);
    else diffCanonical(left[key], right[key], `${path}.${key}`, out, limit);
    if (out.length >= limit) break;
  }
  return out;
}

function short(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
