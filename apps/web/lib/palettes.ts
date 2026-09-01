/**
 * Named colour palettes for the COLOUR group (v3 phase 5, `[V3-P5-C]`).
 *
 * A palette is a complete `region_colors` table plus a matching
 * `region_slots` table (so applying one is a single undoable
 * `setNested("colour", ...)` write, never a partial one) and a stable id
 * that round-trips into `params.colour.palette`. Editing any single colour
 * afterwards is what flips the id to `"custom"` -- that happens in the
 * component, not here, because it is a UI event ("the user touched a
 * swatch"), not a property of the palette table itself.
 *
 * Every built-in palette is contrast-checked against
 * `lib/contrastCheck.ts:ADJACENT_PAIRS` by `palettes.test.ts`, so a palette
 * that ships here is a palette that does not trip its own warning.
 */

import type { RegionColors, RegionSlots } from "./contracts";
import { DEFAULT_PRINT_PARAMS } from "./contracts";
import type { RegionName } from "./engine/types";

export interface Palette {
  id: string;
  /** Shown in the palette picker. */
  label: string;
  /** One line: the idea behind the palette. */
  description: string;
  region_colors: RegionColors;
  /**
   * Optional: a palette only overrides the slots it has an opinion about
   * (usually none -- the default slot table already groups regions onto a
   * sensible four filaments). Omitted keys keep whatever slot the region
   * already had.
   */
  region_slots?: Partial<RegionSlots>;
}

const DEFAULT_REGION_COLORS = DEFAULT_PRINT_PARAMS.colour?.region_colors as RegionColors;

/** The id `params.colour.palette` is set to once any region colour is edited by hand. */
export const CUSTOM_PALETTE_ID = "custom";

/** The frozen-default table, exposed as a palette so "Default" is a normal entry in the list. */
export const DEFAULT_PALETTE: Palette = {
  id: "default",
  label: "Default",
  description: "The frozen defaults: warm stone buildings, charcoal frame and roads.",
  region_colors: DEFAULT_REGION_COLORS,
};

export const BUILTIN_PALETTES: readonly Palette[] = [
  DEFAULT_PALETTE,
  {
    id: "blueprint",
    label: "Blueprint",
    description: "White linework on deep blueprint blue, like a drafting sheet.",
    region_colors: {
      base: "#13315C",
      frame: "#0B2140",
      matting: "#F4F6FA",
      buildings: "#EAF0FA",
      hero_building: "#FFC857",
      roads: "#F4F6FA",
      water: "#4C86C7",
      parks: "#8FB6DE",
      rail: "#B7C9E2",
      lettering: "#FFFFFF",
      attribution: "#EAF0FA",
    },
  },
  {
    id: "noir",
    label: "Noir",
    description: "Black, greys and white -- no colour, just tone.",
    region_colors: {
      base: "#1C1C1C",
      frame: "#0A0A0A",
      matting: "#E9E9E9",
      buildings: "#D9D9D9",
      hero_building: "#FFFFFF",
      roads: "#3A3A3A",
      water: "#5C5C5C",
      parks: "#4A4A4A",
      rail: "#787878",
      lettering: "#F5F5F5",
      attribution: "#D9D9D9",
    },
  },
  {
    id: "pastel",
    label: "Pastel",
    description: "Soft, chalky tones -- a nursery-shelf city.",
    region_colors: {
      base: "#F6EFE7",
      frame: "#D8C7B8",
      matting: "#FBF7F2",
      buildings: "#E7CBCE",
      hero_building: "#F6C6D0",
      roads: "#C9BBB0",
      water: "#BFE1E8",
      parks: "#CFE8C9",
      rail: "#DCD2C4",
      lettering: "#8A7A6E",
      attribution: "#F3E1E6",
    },
  },
  {
    id: "brass-on-black",
    label: "Brass on Black",
    description: "Matte black with warm brass buildings and lettering.",
    region_colors: {
      base: "#141210",
      frame: "#0B0A08",
      matting: "#1F1B15",
      buildings: "#C9A24B",
      hero_building: "#E9C36B",
      roads: "#3A3226",
      water: "#3C5A5E",
      parks: "#4A4635",
      rail: "#5C523A",
      lettering: "#E9C36B",
      attribution: "#C9A24B",
    },
  },
  {
    id: "terracotta",
    label: "Terracotta",
    description: "Baked clay reds and warm sand, like an unglazed tile.",
    region_colors: {
      base: "#C96C43",
      frame: "#8C4A2E",
      matting: "#F1E3D3",
      buildings: "#E4A377",
      hero_building: "#F4C77B",
      roads: "#7A4530",
      water: "#4E8B8B",
      parks: "#7C9A5B",
      rail: "#9C6B4C",
      lettering: "#F1E3D3",
      attribution: "#E4A377",
    },
  },
  {
    id: "nordic",
    label: "Nordic",
    description: "Cool birch and slate, low saturation throughout.",
    region_colors: {
      base: "#E5E3DD",
      frame: "#4B5561",
      matting: "#F4F3EF",
      buildings: "#C7C2B3",
      hero_building: "#E8B04B",
      roads: "#6B7480",
      water: "#5C89A8",
      parks: "#8FA98C",
      rail: "#9AA0A6",
      lettering: "#2E3439",
      attribution: "#D7D4CB",
    },
  },
  {
    id: "chicago",
    label: "Chicago",
    description: "River green and limestone, a nod to the Loop's own palette.",
    region_colors: {
      base: "#D9D2C1",
      frame: "#2F3A34",
      matting: "#EFE9DA",
      buildings: "#B7A986",
      hero_building: "#B08D57",
      roads: "#4A4A44",
      water: "#1D8A6E",
      parks: "#4F7942",
      rail: "#7A7568",
      lettering: "#EFE9DA",
      attribution: "#C7BFA9",
    },
  },
];

const BY_ID = new Map(BUILTIN_PALETTES.map((palette) => [palette.id, palette]));

export function builtinPalette(id: string): Palette | undefined {
  return BY_ID.get(id);
}

/**
 * The `colour` patch applying `palette` produces: every `region_colors` entry
 * (never a partial write -- a palette that left one region untouched would
 * leave a stray colour from whatever palette was active before), the
 * palette's own `region_slots` opinions layered over the CURRENT table so a
 * user's own slot assignment survives switching palettes, and `palette` set
 * to the palette's id.
 */
export function paletteApplyPatch(
  palette: Palette,
  currentSlots: RegionSlots,
): { region_colors: RegionColors; region_slots: RegionSlots; palette: string } {
  return {
    region_colors: { ...palette.region_colors },
    region_slots: { ...currentSlots, ...(palette.region_slots ?? {}) },
    palette: palette.id,
  };
}

/**
 * Whether `colors` still matches `palette.region_colors` exactly (used to
 * decide when an edit flips `colour.palette` to `"custom"`; not exported for
 * that purpose alone but useful to any caller that wants to know without
 * re-deriving the comparison).
 */
export function matchesPalette(palette: Palette, colors: RegionColors): boolean {
  const keys = Object.keys(palette.region_colors) as Array<keyof RegionColors>;
  return keys.every((key) => (colors[key] ?? "").toLowerCase() === (palette.region_colors[key] ?? "").toLowerCase());
}

// ---------------------------------------------------------------------------
// Custom palettes: named, saved in localStorage, listed and reapplied.
// ---------------------------------------------------------------------------

export const CUSTOM_PALETTES_STORAGE_KEY = "framecraft.palettes.v1";

export interface SavedPalette {
  id: string;
  name: string;
  region_colors: RegionColors;
  region_slots?: Partial<RegionSlots>;
  savedAt: string;
}

function isRegionColors(value: unknown): value is RegionColors {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse whatever is in storage, never throwing and never returning a partial/corrupt entry. */
export function parseSavedPalettes(raw: unknown): SavedPalette[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedPalette[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.name !== "string") continue;
    if (!isRegionColors(record.region_colors)) continue;
    out.push({
      id: record.id,
      name: record.name,
      region_colors: record.region_colors as RegionColors,
      region_slots: isRegionColors(record.region_slots)
        ? (record.region_slots as Partial<RegionSlots>)
        : undefined,
      savedAt: typeof record.savedAt === "string" ? record.savedAt : new Date(0).toISOString(),
    });
  }
  return out;
}

/** Read the saved custom palettes; never throws (private mode, disabled storage, corrupt JSON all fall back to `[]`). */
export function loadCustomPalettes(): SavedPalette[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_PALETTES_STORAGE_KEY);
    if (!raw) return [];
    return parseSavedPalettes(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** Persist the custom palette list; a storage failure just leaves the in-memory list working for this session. */
export function saveCustomPalettes(palettes: readonly SavedPalette[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CUSTOM_PALETTES_STORAGE_KEY, JSON.stringify(palettes));
  } catch {
    // ignored, same rule as GROUP_STORAGE_KEY / AUTHOR_STORAGE_KEY
  }
}

/** A stable id for a freshly saved custom palette: slug of the name plus a counter for collisions. */
export function customPaletteId(name: string, existing: readonly SavedPalette[]): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom";
  const taken = new Set(existing.map((palette) => palette.id));
  if (!taken.has(`custom-${slug}`)) return `custom-${slug}`;
  let n = 2;
  while (taken.has(`custom-${slug}-${n}`)) n += 1;
  return `custom-${slug}-${n}`;
}

/** `SavedPalette` -> `Palette`, so the picker and `paletteApplyPatch` can treat it exactly like a built-in. */
export function savedAsPalette(saved: SavedPalette): Palette {
  return {
    id: saved.id,
    label: saved.name,
    description: "Custom palette",
    region_colors: saved.region_colors,
    region_slots: saved.region_slots,
  };
}

/** Region names in the fixed order every palette table above declares them in. */
export const PALETTE_REGION_NAMES: readonly RegionName[] = [
  "base",
  "frame",
  "matting",
  "buildings",
  "hero_building",
  "roads",
  "water",
  "parks",
  "rail",
  "lettering",
  "attribution",
];
