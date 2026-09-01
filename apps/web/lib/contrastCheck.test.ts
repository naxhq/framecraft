import { describe, expect, it } from "vitest";

import {
  ADJACENT_PAIRS,
  CONTRAST_THRESHOLD,
  bandAdjacentPairs,
  contrastIssueSentence,
  contrastIssues,
  nearestSeparatingColor,
} from "./contrastCheck";
import { deltaE76 } from "./colourMap";
import { DEFAULT_PRINT_PARAMS } from "./contracts";
import { COLOURABLE_REGION_NAMES, REGION_NAMES } from "./engine/types";
import type { ColourRow } from "./colourMap";

const DEFAULT_COLORS = DEFAULT_PRINT_PARAMS.colour!.region_colors!;
const DEFAULT_SLOTS = DEFAULT_PRINT_PARAMS.colour!.region_slots!;

function defaultRows(): ColourRow[] {
  return COLOURABLE_REGION_NAMES.filter((r) => r !== "easel").map((region) => ({
    region,
    slot: DEFAULT_SLOTS[region as keyof typeof DEFAULT_SLOTS] ?? 1,
    colorHex: DEFAULT_COLORS[region as keyof typeof DEFAULT_COLORS] ?? "#808080",
  }));
}

describe("contrastIssues", () => {
  it("the frozen default palette's only clash is buildings/base (same nominal colour, different slots)", () => {
    // The v1/v2 seven-part table gave base and buildings the identical hex on
    // purpose ("the base shares with the buildings", ColourGroup.tsx); the v3
    // `colour.region_colors` default (a schema-frozen contract value, not
    // authored here) inherited that literal value even though the two sit on
    // DIFFERENT filament slots (1 and 2), so they are not exempted by the
    // shared-slot skip above and this is a genuine, if pre-existing, clash.
    // `[V3-P5-C]`.
    expect(contrastIssues(defaultRows())).toEqual([
      {
        regionA: "buildings",
        regionB: "base",
        colorA: DEFAULT_COLORS.buildings,
        colorB: DEFAULT_COLORS.base,
        distance: 0,
        suggestionForA: expect.any(String),
      },
    ]);
  });

  it("flags a deliberately clashing palette on two DIFFERENT slots (base and roads both near-identical greys)", () => {
    // base is slot 1, roads is slot 4 by default -- genuinely different
    // slots, so this is a real colour-pick clash and not the shared-slot case
    // the checker deliberately ignores.
    const rows = defaultRows().map((row) => {
      if (row.region === "base") return { ...row, colorHex: "#808080" };
      if (row.region === "water") return { ...row, colorHex: "#828282" };
      return row;
    });
    const issues = contrastIssues(rows);
    expect(issues.some((i) => i.regionA === "base" && i.regionB === "water")).toBe(true);
    for (const issue of issues) expect(issue.distance).toBeLessThan(CONTRAST_THRESHOLD);
  });

  it("two adjacent regions sharing one slot are never flagged (that is slotColourConflicts's job, not a colour pick)", () => {
    const rows = defaultRows().map((row) =>
      row.region === "water" ? { ...row, slot: DEFAULT_SLOTS.base!, colorHex: "#00FF00" } : row,
    );
    const issues = contrastIssues(rows);
    expect(issues.find((i) => i.regionA === "base" && i.regionB === "water")).toBeUndefined();
  });

  it("compares PRINTED colours (slot winner), not the raw region_colors, for a pair on two DIFFERENT slots", () => {
    // roads (slot 4 by default) shares its slot with hero_building, which
    // comes first in REGION_NAMES order and so wins the slot. Give
    // hero_building a colour close to base's, and roads its OWN colour far
    // from base's -- if the checker compared roads' raw colorHex it would see
    // no clash; comparing the PRINTED colour (hero_building's) it must.
    const rows = defaultRows().map((row) => {
      if (row.region === "hero_building") return { ...row, colorHex: "#818181" };
      if (row.region === "roads") return { ...row, colorHex: "#00FF00" };
      if (row.region === "base") return { ...row, colorHex: "#808080" };
      return row;
    });
    const issues = contrastIssues(rows);
    const pair = issues.find((i) => i.regionA === "base" && i.regionB === "roads");
    expect(pair).toBeDefined();
    expect(pair!.colorB.toUpperCase()).toBe("#818181");
    expect(pair!.distance).toBeLessThan(CONTRAST_THRESHOLD);
  });

  it("suggests a palette swatch that actually separates the pair", () => {
    const rows = defaultRows();
    rows.find((r) => r.region === "base")!.colorHex = "#808080";
    rows.find((r) => r.region === "water")!.colorHex = "#818181";
    const issue = contrastIssues(rows).find((i) => i.regionA === "base" && i.regionB === "water")!;
    expect(issue).toBeDefined();
    expect(issue.suggestionForA).not.toBeNull();
    expect(deltaE76(issue.suggestionForA!, issue.colorB)).toBeGreaterThanOrEqual(CONTRAST_THRESHOLD);
  });

  it("skips a pair when a region has not been built yet (defensive, should not crash)", () => {
    const rows = defaultRows().filter((r) => r.region !== "matting");
    expect(() => contrastIssues(rows)).not.toThrow();
  });
});

describe("nearestSeparatingColor", () => {
  it("returns a candidate that clears the threshold from `other`", () => {
    const result = nearestSeparatingColor("#808080", "#828282");
    expect(result).not.toBeNull();
    expect(deltaE76(result!, "#828282")).toBeGreaterThanOrEqual(CONTRAST_THRESHOLD);
  });
});

describe("bandAdjacentPairs", () => {
  it("is empty when only band 1 (\"buildings\" itself) is present -- the gradient is off", () => {
    expect(bandAdjacentPairs(new Set(COLOURABLE_REGION_NAMES))).toEqual([]);
  });

  it("chains all eight bands when every one is present", () => {
    expect(bandAdjacentPairs(new Set(REGION_NAMES))).toHaveLength(7);
  });

  it("chains present band regions by band index, band 1 (\"buildings\") through the highest present", () => {
    const present = new Set(["base", "buildings", "buildings_band_2", "buildings_band_3"] as const);
    const pairs = bandAdjacentPairs(present);
    expect(pairs).toEqual([
      ["buildings", "buildings_band_2"],
      ["buildings_band_2", "buildings_band_3"],
    ]);
  });
});

describe("ADJACENT_PAIRS", () => {
  it("covers every pair the brief names", () => {
    const wanted: Array<[string, string]> = [
      ["base", "frame"],
      ["base", "roads"],
      ["base", "water"],
      ["base", "parks"],
      ["buildings", "base"],
      ["matting", "frame"],
      ["matting", "base"],
      ["lettering", "frame"],
    ];
    for (const pair of wanted) {
      expect(ADJACENT_PAIRS).toContainEqual(pair);
    }
  });
});

describe("contrastIssueSentence", () => {
  it("names both regions and the delta, and the suggestion when there is one", () => {
    const rows = defaultRows();
    rows.find((r) => r.region === "base")!.colorHex = "#808080";
    rows.find((r) => r.region === "water")!.colorHex = "#818181";
    const issue = contrastIssues(rows).find((i) => i.regionA === "base" && i.regionB === "water")!;
    const sentence = contrastIssueSentence(issue, (r) => r);
    expect(sentence).toContain("base");
    expect(sentence).toContain("water");
    expect(sentence).toMatch(/delta-E \d/);
    expect(sentence).toContain("Try");
  });
});
