/**
 * The generated glyph outlines, loaded one face at a time.
 *
 * `lib/fonts/<face>.glyphs.json` is written by
 * `services/bake/scripts/gen_font_assets.py` from the bundled OFL TTF, in FONT
 * UNITS, with every counter already marked as a hole and every curve flattened
 * at the contract's largest legal engraving size. `lib/transform.ts` owns the
 * LAYOUT (which string, at what size, where, refused or not); this module owns
 * nothing but the shapes those numbers are applied to.
 *
 * **Loaded dynamically, per face, on purpose.** The three assets are ~280 KB
 * each; a static import of all three would put 850 KB of glyph outlines in the
 * client bundle of an editor that, by default, engraves nothing at all
 * (`docs/handoff/v2-03-lettering.md` §1). A face is fetched the first time a
 * layout actually names it and then kept for the session.
 */

/** One connected piece of a glyph: an outer ring and its counters, font units. */
export interface GlyphPart {
  shell: number[][];
  holes: number[][][];
}

/** One glyph is a list of parts (`i` and `%` have more than one). */
export type GlyphOutline = GlyphPart[];

/** A generated `<face>.glyphs.json`. */
export interface GlyphFace {
  face: string;
  file: string;
  units_per_em: number;
  glyph_asset_size_mm: number;
  flatten_tolerance_mm: number;
  /** Keyed by decimal codepoint, as a string, exactly like the metrics table. */
  glyphs: Record<string, GlyphOutline>;
}

/** The three faces `PrintParams.engravings[].font` may name. */
export const GLYPH_FACES = ["sans", "serif", "mono"] as const;
export type GlyphFaceName = (typeof GLYPH_FACES)[number];

export function isGlyphFace(name: string): name is GlyphFaceName {
  return (GLYPH_FACES as readonly string[]).includes(name);
}

const cache = new Map<string, GlyphFace>();
const inflight = new Map<string, Promise<GlyphFace>>();

/**
 * The import has to be a literal specifier per branch: a template specifier
 * would make the bundler emit all three chunks anyway, which is the cost this
 * module exists to avoid.
 */
async function importFace(face: GlyphFaceName): Promise<GlyphFace> {
  switch (face) {
    case "serif":
      return (await import("./fonts/serif.glyphs.json")).default as unknown as GlyphFace;
    case "mono":
      return (await import("./fonts/mono.glyphs.json")).default as unknown as GlyphFace;
    default:
      return (await import("./fonts/sans.glyphs.json")).default as unknown as GlyphFace;
  }
}

/** The face if it is already in memory, else null. Never triggers a fetch. */
export function loadedGlyphFace(face: string): GlyphFace | null {
  return cache.get(face) ?? null;
}

/** Fetch one face, at most once per session and at most once concurrently. */
export async function loadGlyphFace(face: string): Promise<GlyphFace> {
  const cached = cache.get(face);
  if (cached) return cached;
  if (!isGlyphFace(face)) throw new Error(`unknown font face: ${face}`);
  const pending = inflight.get(face);
  if (pending) return pending;
  const request = importFace(face).then((asset) => {
    cache.set(face, asset);
    inflight.delete(face);
    return asset;
  });
  inflight.set(face, request);
  return request;
}

/**
 * Put an already-parsed asset in the cache.
 *
 * The unit tests import the JSON statically (node, no bundler, no reason to go
 * through a promise) and the parity check wants the real committed asset, not a
 * stand-in.
 */
export function primeGlyphFace(face: string, asset: GlyphFace): void {
  cache.set(face, asset);
}

/** Drop the cache. Tests only. */
export function resetGlyphFaces(): void {
  cache.clear();
  inflight.clear();
}
