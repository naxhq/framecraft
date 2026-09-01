/**
 * The preview's colours, read from the design tokens rather than duplicated.
 *
 * `app/globals.css` owns every colour value in this app (there is a vitest that
 * fails on a raw hex anywhere in `components/**` or `app/**.tsx`), so the three
 * materials read the same `--fc-preview-*` custom properties the chrome around
 * them uses, and flipping `.dark` on <html> re-themes the canvas from the same
 * source as the panels.
 *
 * In `parts` colour mode the palette comes from `PrintParams.part_colors`
 * instead: those are real filament colours the user picked, and the point of
 * that mode is to see them.
 */

import type { PartColors, PrintParams } from "@/lib/contracts";

export interface PreviewPalette {
  background: string;
  base: string;
  frame: string;
  building: string;
  road: string;
  water: string;
  green: string;
  tree: string;
  grid: string;
  hero: string;
  /**
   * A hero picked while `hero_mode` does not grant it its own colour. Painting
   * it the filament orange in that mode would promise a colour the bake will
   * not print (`transform.hero_own_color`).
   */
  heroPick: string;
  /** Where the keyboard building cursor is. */
  cursor: string;
  /** Frame lettering: engraved reads as a groove, embossed as raised material. */
  textEngraved: string;
  textEmbossed: string;
  /** The underside mark and the hanger pockets. */
  pocket: string;
  /** The hemisphere light: sky above, ground bounce below. */
  sky: string;
  bounce: string;
  /** TileGrid's cut lines and index labels (phase 4). */
  tileLine: string;
}

/**
 * Palette slot -> the custom property it reads.
 *
 * Exported so `palette.test.ts` can hold `app/globals.css` to it: the names are
 * NOT derivable from the slot (`background` is `--fc-preview-bg`), so a table
 * is the only source of truth, and a slot added here without a declaration
 * there falls back to `magenta` at runtime rather than failing anywhere.
 */
export const PREVIEW_TOKENS: Record<keyof PreviewPalette, string> = {
  background: "--fc-preview-bg",
  base: "--fc-preview-base",
  frame: "--fc-preview-frame",
  building: "--fc-preview-building",
  road: "--fc-preview-road",
  water: "--fc-preview-water",
  green: "--fc-preview-green",
  tree: "--fc-preview-tree",
  grid: "--fc-preview-grid",
  hero: "--fc-preview-hero",
  heroPick: "--fc-preview-hero-pick",
  cursor: "--fc-preview-cursor",
  textEngraved: "--fc-preview-text-engraved",
  textEmbossed: "--fc-preview-text-embossed",
  pocket: "--fc-preview-pocket",
  sky: "--fc-preview-sky",
  bounce: "--fc-preview-bounce",
  tileLine: "--fc-preview-tile-line",
};

/**
 * A CSS colour keyword, deliberately hideous: if the token sheet ever fails to
 * load, the preview must look obviously wrong rather than quietly plausible.
 * It is a keyword and not a hex so this module stays inside the no-raw-colour
 * rule it exists to serve.
 */
const MISSING = "magenta";

/**
 * One resolved palette per theme name.
 *
 * `getComputedStyle` flushes pending style work, and the values behind a given
 * theme are constant for the life of the page, so the read happens once for
 * "light" and once for "dark" rather than on every render that touches the
 * canvas.
 */
const cache = new Map<string, PreviewPalette>();

/**
 * Read the palette that `theme` currently puts on `<html>`.
 *
 * Client-only: `CityPreview` is behind `dynamic(..., { ssr: false })`, so
 * `document` is always there when this runs. `theme` is a real argument, not a
 * decoration -- it is the cache key, and it is what makes the caller's memo
 * dependency on the theme a genuine one.
 */
export function readPreviewPalette(theme: string): PreviewPalette {
  const cached = cache.get(theme);
  if (cached) return cached;

  const out = {} as PreviewPalette;
  const styles =
    typeof window === "undefined"
      ? null
      : window.getComputedStyle(document.documentElement);
  for (const [slot, variable] of Object.entries(PREVIEW_TOKENS) as Array<
    [keyof PreviewPalette, string]
  >) {
    const value = styles?.getPropertyValue(variable).trim();
    out[slot] = value ? value : MISSING;
  }
  // Never cache a stylesheet that had not loaded yet: that would pin `magenta`
  // for the rest of the session.
  if (styles !== null && out.background !== MISSING) cache.set(theme, out);
  return out;
}

/**
 * The palette the canvas should paint with: the user's filament colours in
 * `parts` mode, the themed preview tokens otherwise.
 *
 * `background`, `grid`, the lights and the two selection colours always stay
 * themed -- they are the room the object sits in, not part of the object.
 */
export function paletteFor(
  params: PrintParams,
  themed: PreviewPalette,
  parts: PartColors | undefined,
): PreviewPalette {
  if (params.color_mode !== "parts" || !parts) return themed;
  return {
    ...themed,
    base: parts.base,
    frame: parts.frame,
    building: parts.buildings,
    road: parts.roads,
    water: parts.water,
    green: parts.green,
    tree: parts.trees,
  };
}
