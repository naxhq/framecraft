/**
 * `colour.region_colors.attribution` never moves, whatever the Colour group's
 * three colour buttons are asked to do.
 *
 * DECISIONS `[V3.1-P1-13]` requires "a test pins that no control writes it".
 * The catalog's own exemption test cannot be that test: it reads the catalog's
 * `writes` array, so it can only ever confirm what the catalog says about
 * itself. This file drives the REAL patch builders the three buttons call, over
 * every built-in palette, a real merge and a real align, and then pushes each
 * patch through the real store setter and reads the field back.
 *
 * Why the leaf is forbidden: the mandatory FrameCraft and OpenStreetMap credit
 * is an engraved CUT into the base and the frame, never a body of its own, so
 * no stage ever produces an `attribution` solid to colour and nothing written
 * here could reach a file. The three helpers upstream do not know that: every
 * built-in palette declares an `attribution` colour, `planMergeToSlots` writes
 * every region of every cluster, and `alignConflictsPatch` writes every region
 * that loses its slot.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_PRINT_PARAMS, defaultPrintParams } from "@/lib/contracts";
import type { Colour, RegionColors, RegionSlots } from "@/lib/contracts";
import { colourRows, slotColourConflicts, type ColourRow } from "@/lib/colourMap";
import { BUILTIN_PALETTES, PALETTE_REGION_NAMES } from "@/lib/palettes";
import { useEditorStore } from "@/store/editor";
import { alignPatch, mergePatch, palettePatch, withoutAttributionColour } from "./ColourGroup";

const DEFAULT_COLORS = DEFAULT_PRINT_PARAMS.colour!.region_colors as RegionColors;
const DEFAULT_SLOTS = DEFAULT_PRINT_PARAMS.colour!.region_slots as RegionSlots;

/** The attribution colour as the contract ships it: the value nothing may move. */
const FROZEN = DEFAULT_COLORS.attribution;

beforeEach(() => {
  useEditorStore.setState({ params: defaultPrintParams() });
});

/** Apply a patch through the real store setter and read the field back. */
function throughTheStore(patch: Colour): string | undefined {
  useEditorStore.getState().setNested("colour", patch);
  return useEditorStore.getState().params.colour?.region_colors?.attribution;
}

describe("the premise", () => {
  it("is not vacuous: every built-in palette really does declare an attribution colour", () => {
    expect(BUILTIN_PALETTES.length).toBeGreaterThan(1);
    expect(PALETTE_REGION_NAMES).toContain("attribution");
    for (const palette of BUILTIN_PALETTES) {
      expect(palette.region_colors.attribution, palette.id).toBeTruthy();
    }
    // And at least one of them wants a value different from the frozen one, so
    // a missing guard would be visible rather than coincidentally equal.
    expect(
      BUILTIN_PALETTES.some((palette) => palette.region_colors.attribution !== FROZEN),
    ).toBe(true);
  });

  it("strips the key rather than overwriting it with the old value", () => {
    expect(withoutAttributionColour({ base: "#111111", attribution: "#222222" })).toEqual({
      base: "#111111",
    });
    // An untouched patch is returned as-is, so no caller pays for a copy.
    const clean = { base: "#111111" };
    expect(withoutAttributionColour(clean)).toBe(clean);
  });
});

describe("applying a palette", () => {
  it("sets the other ten regions and leaves the attribution colour alone, for every built-in", () => {
    for (const palette of BUILTIN_PALETTES) {
      const patch = palettePatch(palette, DEFAULT_COLORS, DEFAULT_SLOTS);
      expect(patch.region_colors!.attribution, palette.id).toBe(FROZEN);
      expect(throughTheStore(patch), palette.id).toBe(FROZEN);
      // The palette really was applied: its base colour is in place and the
      // name it is recorded under is the palette's own.
      expect(patch.region_colors!.base, palette.id).toBe(palette.region_colors.base);
      expect(patch.palette, palette.id).toBe(palette.id);
      useEditorStore.setState({ params: defaultPrintParams() });
    }
  });
});

describe("merging to a profile's slot count", () => {
  /** Eleven regions on eleven distinct slots: a merge with real work to do. */
  function spreadRows(): ColourRow[] {
    return colourRows(defaultPrintParams(), null).map((row, index) => ({
      ...row,
      slot: index + 1,
      colorHex: index % 2 === 0 ? "#101010" : "#F0F0F0",
    }));
  }

  it("moves slots and colours without moving the attribution colour", () => {
    const rows = spreadRows();
    expect(rows.some((row) => row.region === "attribution")).toBe(true);
    const patch = mergePatch(rows, 2, DEFAULT_COLORS, DEFAULT_SLOTS);
    expect(patch, "a merge from eleven slots to two must change something").not.toBeNull();
    if (patch === null) return;
    expect(Object.keys(patch.region_colors!).length).toBeGreaterThan(1);
    expect(patch.region_colors!.attribution).toBe(FROZEN);
    expect(throughTheStore(patch)).toBe(FROZEN);
    // The merge did its job: no region addresses a slot above the target.
    for (const slot of Object.values(patch.region_slots as Record<string, number>)) {
      expect(slot).toBeLessThanOrEqual(2);
    }
  });

  it("renames the palette, because a merge rewrites the table the name stands for", () => {
    const patch = mergePatch(spreadRows(), 2, DEFAULT_COLORS, DEFAULT_SLOTS);
    expect(patch?.palette).toBe("custom");
  });
});

describe("aligning colours to what will print", () => {
  /**
   * `attribution` and `base` share slot 1 at the frozen defaults and carry the
   * same hex, so `attribution` is not a loser until the base colour moves.
   * Moving it is exactly the case the audit found: the guard has to hold when
   * the field IS in the patch, not only when it happens not to be.
   */
  function conflictedRows(): ColourRow[] {
    const params = defaultPrintParams();
    params.colour = {
      ...params.colour,
      region_colors: { ...DEFAULT_COLORS, base: "#0044FF" } as RegionColors,
    };
    return colourRows(params, null);
  }

  it("puts attribution in the raw patch, and the group's builder takes it back out", () => {
    const rows = conflictedRows();
    const conflicts = slotColourConflicts(rows);
    const losing = conflicts.flatMap((conflict) => conflict.losingRegions);
    expect(losing, "the fixture must really make attribution a loser").toContain("attribution");

    const patch = alignPatch(conflicts, { ...DEFAULT_COLORS, base: "#0044FF" } as RegionColors);
    expect(patch).not.toBeNull();
    if (patch === null) return;
    expect(patch.region_colors!.attribution).toBe(FROZEN);
    expect(throughTheStore(patch)).toBe(FROZEN);
    // The other losers really were aligned.
    expect(Object.keys(patch.region_colors!).length).toBeGreaterThan(1);
  });

  it("returns null when the only region it would touch is the attribution", () => {
    const patch = alignPatch(
      [
        {
          slot: 1,
          printedRegion: "base",
          printedColorHex: "#0044FF",
          losingRegions: ["attribution"],
        },
      ],
      DEFAULT_COLORS,
    );
    expect(patch).toBeNull();
  });
});
