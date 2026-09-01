import { describe, expect, it } from "vitest";

import {
  BUILTIN_PALETTES,
  CUSTOM_PALETTE_ID,
  DEFAULT_PALETTE,
  customPaletteId,
  loadCustomPalettes,
  matchesPalette,
  paletteApplyPatch,
  parseSavedPalettes,
  saveCustomPalettes,
  savedAsPalette,
  type SavedPalette,
} from "./palettes";
import { DEFAULT_PRINT_PARAMS } from "./contracts";
import { contrastIssues } from "./contrastCheck";
import type { ColourRow } from "./colourMap";
import { COLOURABLE_REGION_NAMES } from "./engine/types";

const DEFAULT_SLOTS = DEFAULT_PRINT_PARAMS.colour!.region_slots!;

/** Every non-easel region gets a row at slot 1, its palette colour -- exactly what colourRows falls back to before a bake. */
function rowsFor(paletteId: string): ColourRow[] {
  const palette = BUILTIN_PALETTES.find((p) => p.id === paletteId)!;
  return COLOURABLE_REGION_NAMES.filter((r) => r !== "easel").map((region) => ({
    region,
    slot: DEFAULT_SLOTS[region as keyof typeof DEFAULT_SLOTS] ?? 1,
    colorHex: palette.region_colors[region as keyof typeof palette.region_colors] ?? "#808080",
  }));
}

describe("palettes: built-ins", () => {
  it("ships at least the seven named palettes plus the default", () => {
    const ids = BUILTIN_PALETTES.map((p) => p.id);
    for (const id of [
      "default",
      "blueprint",
      "noir",
      "pastel",
      "brass-on-black",
      "terracotta",
      "nordic",
      "chicago",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("every palette declares every colourable region (minus easel, which mirrors base)", () => {
    const expected = COLOURABLE_REGION_NAMES.filter((r) => r !== "easel").sort();
    for (const palette of BUILTIN_PALETTES) {
      expect(Object.keys(palette.region_colors).sort()).toEqual(expected);
    }
  });

  it("every #RRGGBB value is well-formed", () => {
    for (const palette of BUILTIN_PALETTES) {
      for (const hex of Object.values(palette.region_colors)) {
        expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  it("no palette authored in this task trips its own adjacent-region contrast check", () => {
    // DEFAULT_PALETTE mirrors the schema-frozen contract default (see the
    // `DEFAULT_PALETTE mirrors...` test below) and carries one pre-existing
    // clash (buildings/base, `contrastCheck.test.ts`) that is not this
    // palette table's to fix -- `[V3-P5-C]`. The seven palettes actually
    // designed here are held to the check with no exemption.
    for (const palette of BUILTIN_PALETTES) {
      if (palette.id === "default") continue;
      const issues = contrastIssues(rowsFor(palette.id));
      expect(issues, `${palette.id}: ${JSON.stringify(issues)}`).toEqual([]);
    }
  });

  it("DEFAULT_PALETTE mirrors DEFAULT_PRINT_PARAMS.colour.region_colors", () => {
    expect(DEFAULT_PALETTE.region_colors).toEqual(DEFAULT_PRINT_PARAMS.colour!.region_colors);
  });
});

describe("paletteApplyPatch", () => {
  it("writes every region_colors entry and sets colour.palette", () => {
    const palette = BUILTIN_PALETTES.find((p) => p.id === "noir")!;
    const patch = paletteApplyPatch(palette, DEFAULT_SLOTS);
    expect(patch.palette).toBe("noir");
    expect(patch.region_colors).toEqual(palette.region_colors);
  });

  it("layers the palette's own slot opinions over the current table, keeping the rest", () => {
    const palette = { ...BUILTIN_PALETTES[0], region_slots: { roads: 7 } };
    const patch = paletteApplyPatch(palette, DEFAULT_SLOTS);
    expect(patch.region_slots.roads).toBe(7);
    expect(patch.region_slots.buildings).toBe(DEFAULT_SLOTS.buildings);
  });

  it("a palette with no slot opinions leaves every current slot untouched", () => {
    const palette = BUILTIN_PALETTES.find((p) => p.id === "blueprint")!;
    const patch = paletteApplyPatch(palette, DEFAULT_SLOTS);
    expect(patch.region_slots).toEqual(DEFAULT_SLOTS);
  });
});

describe("matchesPalette / custom flip", () => {
  it("matches when every region colour is identical (case-insensitive)", () => {
    const palette = BUILTIN_PALETTES.find((p) => p.id === "chicago")!;
    expect(matchesPalette(palette, palette.region_colors)).toBe(true);
    const lowered = Object.fromEntries(
      Object.entries(palette.region_colors).map(([k, v]) => [k, (v as string).toLowerCase()]),
    );
    expect(matchesPalette(palette, lowered as never)).toBe(true);
  });

  it("does not match once a single region colour is edited", () => {
    const palette = BUILTIN_PALETTES.find((p) => p.id === "chicago")!;
    const edited = { ...palette.region_colors, roads: "#123456" };
    expect(matchesPalette(palette, edited)).toBe(false);
  });

  it("CUSTOM_PALETTE_ID is the sentinel the UI flips colour.palette to on an edit", () => {
    expect(CUSTOM_PALETTE_ID).toBe("custom");
  });
});

describe("custom palette persistence", () => {
  it("parseSavedPalettes drops malformed entries and keeps well-formed ones", () => {
    const raw = [
      { id: "custom-a", name: "A", region_colors: { base: "#111111" }, savedAt: "2026-01-01" },
      { id: "custom-b" }, // missing name/region_colors
      null,
      "not an object",
      { id: 5, name: "bad id type", region_colors: {} },
    ];
    const parsed = parseSavedPalettes(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("custom-a");
  });

  it("round-trips through save/load", () => {
    const store = new Map<string, string>();
    const win = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    };
    // @ts-expect-error test stub
    globalThis.window = win;
    const palettes: SavedPalette[] = [
      { id: "custom-mine", name: "Mine", region_colors: { base: "#ABCDEF" } as never, savedAt: "2026-01-01" },
    ];
    saveCustomPalettes(palettes);
    expect(loadCustomPalettes()).toEqual(palettes);
    // @ts-expect-error test cleanup
    delete globalThis.window;
  });

  it("loadCustomPalettes never throws when window is absent", () => {
    expect(loadCustomPalettes()).toEqual([]);
  });

  it("customPaletteId slugifies and de-duplicates", () => {
    const first = customPaletteId("My Palette!", []);
    expect(first).toBe("custom-my-palette");
    const second = customPaletteId("My Palette!", [
      { id: first, name: "x", region_colors: {} as never, savedAt: "" },
    ]);
    expect(second).toBe("custom-my-palette-2");
  });

  it("savedAsPalette adapts a SavedPalette into the same shape paletteApplyPatch reads", () => {
    const saved: SavedPalette = {
      id: "custom-x",
      name: "X",
      region_colors: { base: "#010203" } as never,
      region_slots: { roads: 2 },
      savedAt: "2026-01-01",
    };
    const palette = savedAsPalette(saved);
    const patch = paletteApplyPatch(palette, DEFAULT_SLOTS);
    expect(patch.palette).toBe("custom-x");
    expect(patch.region_slots.roads).toBe(2);
  });
});
