/**
 * The map overlay colours, read from the design tokens.
 *
 * MapLibre paint properties and the two draggable markers need real colour
 * strings, and `app/globals.css` is the only file allowed to hold one (there is
 * a vitest that fails on a raw hex anywhere in `components/**`). These are the
 * `--fc-map-*` tokens, which are deliberately theme-independent: the OSM raster
 * tiles under them do not change with the theme, so neither should the ink
 * drawn on top.
 */

export interface MapPalette {
  pin: string;
  pinRing: string;
  radiusFill: string;
  radiusLine: string;
  crop: string;
  /** A whole `box-shadow` value for the two draggable markers. */
  markerShadow: string;
}

const VARIABLES: Record<keyof MapPalette, string> = {
  pin: "--fc-map-pin",
  pinRing: "--fc-map-pin-ring",
  radiusFill: "--fc-map-radius-fill",
  radiusLine: "--fc-map-radius-line",
  crop: "--fc-map-crop",
  markerShadow: "--fc-map-marker-shadow",
};

/** Obvious rather than plausible, if the token sheet ever fails to load. */
const MISSING = "magenta";

export function readMapPalette(): MapPalette {
  const out = {} as MapPalette;
  const styles =
    typeof window === "undefined"
      ? null
      : window.getComputedStyle(document.documentElement);
  for (const [slot, variable] of Object.entries(VARIABLES) as Array<
    [keyof MapPalette, string]
  >) {
    const value = styles?.getPropertyValue(variable).trim();
    out[slot] = value ? value : MISSING;
  }
  return out;
}
