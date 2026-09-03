/**
 * The preview's colours, read from the design tokens rather than duplicated.
 *
 * `app/globals.css` owns every colour value in this app (there is a vitest that
 * fails on a raw hex anywhere in `components/**` or `app/**.tsx`), so the three
 * materials read the same `--fc-preview-*` custom properties the chrome around
 * them uses, and flipping `.dark` on <html> re-themes the canvas from the same
 * source as the panels.
 *
 * Since v3.1 the MODEL's own colours come from the engine
 * (`RegionMesh.colorHex`, resolved from `colour.region_colors`), so nothing
 * here paints a part any more: what the viewport still reads is the room the
 * object sits in (background, sky, ground bounce, grid), the tiling overlay
 * and the two multipliers below. The part slots stay declared because they are
 * the app's preview palette and the per-object work in Tasks 10 and 11 needs
 * the hero and cursor colours back.
 */

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
   * it the filament orange in that mode would promise a colour the build will
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
 * The two viewport multipliers, as design tokens rather than literals in the
 * render path (v3.1).
 *
 * `dim` is how far the model fades while a newer run is under way; `recess` is
 * how far a triangle inside a declared recess band is darkened so an engraved
 * line reads at viewing distance. Both multiply the model's own filament
 * colours, so neither invents a colour: `app/globals.css` owns the numbers and
 * gives the dark viewport its own pair.
 */
export const VIEWPORT_MULTIPLIER_TOKENS = {
  dim: "--fc-preview-dim-opacity",
  recess: "--fc-preview-recess-shade",
} as const;

export interface ViewportMultipliers {
  dim: number;
  recess: number;
}

/**
 * Fallbacks used when the stylesheet has not arrived (SSR, a test DOM). Both
 * are visible-but-conservative: a missing token must not make the model
 * invisible or the recesses black.
 */
export const DEFAULT_VIEWPORT_MULTIPLIERS: ViewportMultipliers = { dim: 0.45, recess: 0.62 };

/**
 * Read the two multipliers off `element` (the canvas wrapper carrying
 * `data-fc-viewport-theme`, so the viewport theme's own values win) or off the
 * document. A value that is not a finite number in `[0, 1]` is refused rather
 * than trusted: a typo in the sheet would otherwise blank the viewport.
 */
export function readViewportMultipliers(element: Element | null): ViewportMultipliers {
  if (typeof window === "undefined") return DEFAULT_VIEWPORT_MULTIPLIERS;
  const styles = window.getComputedStyle(element ?? document.documentElement);
  const out = { ...DEFAULT_VIEWPORT_MULTIPLIERS };
  for (const [slot, variable] of Object.entries(VIEWPORT_MULTIPLIER_TOKENS) as Array<
    [keyof ViewportMultipliers, string]
  >) {
    const value = Number.parseFloat(styles.getPropertyValue(variable).trim());
    if (Number.isFinite(value) && value >= 0 && value <= 1) out[slot] = value;
  }
  return out;
}

/**
 * The four viewport-only slots `colour.preview_theme` controls
 * (`app/globals.css`'s `[data-fc-viewport-theme]` rules), independent of the
 * app's own light/dark theme (v3 phase 5, `[V3-P5-C]`).
 */
export type ViewportPalette = Pick<PreviewPalette, "background" | "sky" | "bounce" | "grid">;

const VIEWPORT_TOKENS: Record<keyof ViewportPalette, string> = {
  background: "--fc-viewport-bg",
  sky: "--fc-viewport-sky",
  bounce: "--fc-viewport-bounce",
  grid: "--fc-viewport-grid",
};

/**
 * Read the viewport-theme tokens off `element` (the canvas wrapper carrying
 * `data-fc-viewport-theme`), falling back to `themed`'s own values for any
 * token not yet resolvable (before mount, or in a test DOM with no
 * stylesheet). Never cached: unlike `readPreviewPalette`, this reads a
 * specific ELEMENT rather than the document, and there are only ever two
 * elements' worth of values to read (light/dark), cheap enough to read fresh
 * on every theme flip.
 */
export function readViewportPalette(
  element: Element | null,
  themed: PreviewPalette,
): ViewportPalette {
  const fallback: ViewportPalette = {
    background: themed.background,
    sky: themed.sky,
    bounce: themed.bounce,
    grid: themed.grid,
  };
  if (element === null || typeof window === "undefined") return fallback;
  const styles = window.getComputedStyle(element);
  const out = { ...fallback };
  for (const [slot, variable] of Object.entries(VIEWPORT_TOKENS) as Array<
    [keyof ViewportPalette, string]
  >) {
    const value = styles.getPropertyValue(variable).trim();
    if (value) out[slot] = value;
  }
  return out;
}
