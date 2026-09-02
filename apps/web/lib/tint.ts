/**
 * Building tint variation and the height-gradient colour band (v3 phase 5,
 * `[V3-P5-C]`): `colour.tint` and `colour.gradient`.
 *
 * Neither ever reaches a build: no printer profile can express an arbitrary
 * per-building hue shift or an N-slot height gradient through filament
 * changes on the current export targets (`bambu-3mf`, `generic-3mf`, `stl`,
 * `stl-parts-zip`, `color-change-3mf`) -- only `obj` carries per-instance
 * colour at all (its MTL groups). Both are therefore PREVIEW-and-OBJ-only
 * effects, computed here in plain TypeScript so the picture on screen is
 * deterministic and cheap to recompute on every slider tick, and gated
 * honestly in the UI (`components/editor/groups/ColourGroup.tsx`'s standing
 * note, `lib/warnings.ts`'s `tintPreviewOnlyWarning`).
 *
 * When `EngineResult.buildingTints` (the browser engine's own per-building
 * colour map, once p5-frame's mesh work produces one) is present, the
 * preview reads THAT instead of recomputing here -- see
 * `components/scene/InstancedBuildings.tsx`. This module is what fills the
 * gap until it lands, and it stays after: it is also what a preview frame
 * with no fresh engine result (the fast instanced fallback) always uses.
 */

import type { Colour, Gradient, Tint } from "./contracts";

// ---------------------------------------------------------------------------
// Deterministic hash: (buildingId, seed) -> [0, 1)
// ---------------------------------------------------------------------------

/**
 * A small, fast, deterministic string hash (FNV-1a, 32-bit), folded with the
 * seed so the SAME building gets a DIFFERENT draw for a different seed and
 * the reroll control genuinely reshuffles every tint at once.
 */
export function hashUnit(id: string, seed: number): number {
  // The seed is folded in purely through the text, not also XORed into the
  // initial state: doing both let the seed digit's own char code cancel the
  // initial XOR on the loop's first iteration, so `seed=7` and `seed=8`
  // produced the SAME draw for short ids -- caught by
  // `tint.test.ts`'s "differs across ... seeds".
  let h = 0x811c9dc5;
  const text = `${seed}|${id}`;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Unsigned 32-bit -> [0, 1).
  return (h >>> 0) / 0xffffffff;
}

// ---------------------------------------------------------------------------
// sRGB hex <-> HSL
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "").slice(0, 6).padEnd(6, "0");
  return [
    Number.parseInt(clean.slice(0, 2), 16) / 255,
    Number.parseInt(clean.slice(2, 4), 16) / 255,
    Number.parseInt(clean.slice(4, 6), 16) / 255,
  ];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const byte = (c: number): string =>
    Math.round(Math.min(1, Math.max(0, c)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`.toUpperCase();
}

export function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case r:
      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      break;
    case g:
      h = ((b - r) / d + 2) / 6;
      break;
    default:
      h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s, l];
}

export function hslToRgb([h, s, l]: [number, number, number]): [number, number, number] {
  if (s === 0) return [l, l, l];
  const hue2rgb = (p: number, q: number, t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hn = h / 360;
  return [hue2rgb(p, q, hn + 1 / 3), hue2rgb(p, q, hn), hue2rgb(p, q, hn - 1 / 3)];
}

// ---------------------------------------------------------------------------
// Per-building tint
// ---------------------------------------------------------------------------

const DEFAULT_TINT: Required<Tint> = { enabled: false, hue_range_deg: 12, lightness_range: 0.12, seed: 1 };

/**
 * `baseHex`, shifted by a deterministic amount within
 * `[-hue_range_deg, +hue_range_deg]` and `[-lightness_range, +lightness_range]`,
 * both drawn from `hashUnit(buildingId, seed)` (two independent draws, so hue
 * and lightness do not move in lockstep). Returns `baseHex` unchanged when
 * `tint.enabled` is false.
 */
export function tintedColor(buildingId: string, baseHex: string, tint: Tint | undefined): string {
  const t = { ...DEFAULT_TINT, ...tint };
  if (!t.enabled) return baseHex;
  const [h, s, l] = rgbToHsl(hexToRgb(baseHex));
  const drawHue = hashUnit(`${buildingId}:h`, t.seed);
  const drawLight = hashUnit(`${buildingId}:l`, t.seed);
  const hueShift = (drawHue * 2 - 1) * t.hue_range_deg;
  const lightShift = (drawLight * 2 - 1) * t.lightness_range;
  const nextH = ((h + hueShift) % 360 + 360) % 360;
  const nextL = Math.min(1, Math.max(0, l + lightShift));
  return rgbToHex(hslToRgb([nextH, s, nextL]));
}

/** One tint per building id, keyed by id -- what `InstancedBuildings` and any future consumer read to paint per-instance colour. */
export function buildingTintMap(
  buildingIds: readonly string[],
  baseHex: string,
  tint: Tint | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of buildingIds) out[id] = tintedColor(id, baseHex, tint);
  return out;
}

// ---------------------------------------------------------------------------
// Height gradient
// ---------------------------------------------------------------------------

const DEFAULT_GRADIENT: Required<Gradient> = { enabled: false, slots: [2, 3] };

/**
 * `gradient.slots` bounded to what the active printer profile can actually
 * address: at most `profileSlots` entries, each clamped to `[1, profileSlots]`.
 * A gradient asking for slot 6 on a 4-slot AMS is not a gradient the model can
 * print -- this is what the GRADIENT control's slot list is bounded by
 * (brief item 4), and what `heightBandSlot` below is built from.
 */
export function boundGradientSlots(slots: readonly number[], profileSlots: number): number[] {
  const capped = Math.max(1, Math.min(profileSlots, 16));
  return slots
    .slice(0, capped)
    .map((slot) => Math.min(capped, Math.max(1, Math.round(slot))));
}

/**
 * Which gradient slot (index into the bounded slot list, 0-based) a building
 * at `heightM` falls into, given the tallest building in the scene is
 * `maxHeightM`. Linear by height, `maxHeightM <= 0` (no buildings, or a flat
 * scene) always resolves to the first band.
 */
export function heightBandIndex(heightM: number, maxHeightM: number, bandCount: number): number {
  if (bandCount <= 1 || maxHeightM <= 0) return 0;
  const fraction = Math.min(1, Math.max(0, heightM / maxHeightM));
  return Math.min(bandCount - 1, Math.floor(fraction * bandCount));
}

/**
 * `colour.gradient` resolved against a printer profile and a scene's tallest
 * building: the bounded slot list, and a lookup from a building's height to
 * its band's filament slot. Returns `null` when the gradient is off or has
 * nothing to band (bounded list is empty).
 */
export function resolveGradient(
  gradient: Gradient | undefined,
  profileSlots: number,
  maxHeightM: number,
): { bands: number[]; slotForHeight: (heightM: number) => number } | null {
  const g = { ...DEFAULT_GRADIENT, ...gradient };
  if (!g.enabled) return null;
  const bands = boundGradientSlots(g.slots, profileSlots);
  if (bands.length === 0) return null;
  return {
    bands,
    slotForHeight: (heightM: number) => bands[heightBandIndex(heightM, maxHeightM, bands.length)],
  };
}

/**
 * Whether `colour` describes a tint that will show in the preview/OBJ but
 * never on the active `export_target`'s print path. `export_target` is
 * "print-only" for every value except `"obj"` -- the one format that carries
 * per-instance colour at all (its MTL). True only once tint is actually on,
 * so the note never appears for a scene where it would say nothing.
 */
export function tintIsPreviewOnly(colour: Colour | undefined, exportTarget: string | undefined): boolean {
  if (!colour?.tint?.enabled) return false;
  return (exportTarget ?? "bambu-3mf") !== "obj";
}
