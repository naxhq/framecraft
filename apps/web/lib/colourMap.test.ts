import { describe, expect, it } from "vitest";

import { defaultPrintParams } from "./contracts";
import {
  colourRows,
  deltaE76,
  distinctSlots,
  exceedsProfileSlots,
  planMergeToSlots,
  type ColourRow,
} from "./colourMap";

describe("colourRows", () => {
  it("without a bake result, lists every region name the contract can colour, easel excluded", () => {
    const rows = colourRows(defaultPrintParams(), null);
    const regions = rows.map((row) => row.region);
    expect(regions).not.toContain("easel");
    expect(regions).toContain("base");
    expect(regions).toContain("buildings");
    expect(regions).toContain("hero_building");
    expect(regions).toContain("matting");
    expect(regions).toContain("attribution");
  });

  it("without a bake result, reads the contract defaults (base 1, buildings 2, water 3, roads/parks 4)", () => {
    const rows = colourRows(defaultPrintParams(), null);
    const byRegion = Object.fromEntries(rows.map((row) => [row.region, row]));
    expect(byRegion.base.slot).toBe(1);
    expect(byRegion.frame.slot).toBe(1);
    expect(byRegion.buildings.slot).toBe(2);
    expect(byRegion.water.slot).toBe(3);
    expect(byRegion.parks.slot).toBe(4);
    expect(byRegion.roads.slot).toBe(4);
  });

  it("with a fresh EngineResult, lists exactly the regions the engine produced, in its slots/colours", () => {
    const result = {
      regions: [
        { region: "base", slot: 1, colorHex: "#D8D3C6" },
        { region: "buildings", slot: 2, colorHex: "#D8D3C6" },
      ],
    } as never;
    const rows = colourRows(defaultPrintParams(), result);
    expect(rows).toEqual([
      { region: "base", slot: 1, colorHex: "#D8D3C6" },
      { region: "buildings", slot: 2, colorHex: "#D8D3C6" },
    ]);
  });

  it("an empty regions array (a bake that produced nothing) falls back to the contract defaults", () => {
    const rows = colourRows(defaultPrintParams(), { regions: [] } as never);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("distinctSlots / exceedsProfileSlots", () => {
  const rows: ColourRow[] = [
    { region: "base", slot: 1, colorHex: "#000000" },
    { region: "frame", slot: 1, colorHex: "#000000" },
    { region: "buildings", slot: 2, colorHex: "#ffffff" },
    { region: "water", slot: 3, colorHex: "#0000ff" },
  ];

  it("counts distinct slots, ascending, not rows", () => {
    expect(distinctSlots(rows)).toEqual([1, 2, 3]);
  });

  it("flags when more slots are used than the profile has", () => {
    expect(exceedsProfileSlots(rows, 4)).toBe(false);
    expect(exceedsProfileSlots(rows, 3)).toBe(false);
    expect(exceedsProfileSlots(rows, 2)).toBe(true);
    expect(exceedsProfileSlots(rows, 1)).toBe(true);
  });
});

describe("deltaE76", () => {
  it("is zero for identical colours", () => {
    expect(deltaE76("#D8D3C6", "#D8D3C6")).toBeCloseTo(0, 6);
  });

  it("is larger for a bigger visual difference (black vs white further than two greys)", () => {
    const blackWhite = deltaE76("#000000", "#ffffff");
    const greys = deltaE76("#333333", "#444444");
    expect(blackWhite).toBeGreaterThan(greys);
  });

  it("is symmetric", () => {
    expect(deltaE76("#2F7FC1", "#5A9E4B")).toBeCloseTo(deltaE76("#5A9E4B", "#2F7FC1"), 9);
  });
});

describe("planMergeToSlots", () => {
  it("does nothing when the rows already fit the target (reports changed: false)", () => {
    const rows: ColourRow[] = [
      { region: "base", slot: 1, colorHex: "#D8D3C6" },
      { region: "buildings", slot: 2, colorHex: "#D8D3C6" },
    ];
    const plan = planMergeToSlots(rows, 4);
    expect(plan.changed).toBe(false);
    expect(plan.regionSlots).toEqual({});
    expect(plan.regionColors).toEqual({});
  });

  it("merges the two nearest-coloured slot groups first (two near-identical greys before a distant blue)", () => {
    const rows: ColourRow[] = [
      { region: "base", slot: 1, colorHex: "#3A3A3A" },
      { region: "roads", slot: 2, colorHex: "#3B3B3B" }, // nearly identical to slot 1
      { region: "water", slot: 3, colorHex: "#2F7FC1" }, // a distant blue
    ];
    const plan = planMergeToSlots(rows, 2);
    expect(plan.changed).toBe(true);
    // base and roads (the near-identical pair) land on the same new slot...
    expect(plan.regionSlots.base).toBe(plan.regionSlots.roads);
    // ...and water keeps a slot of its own.
    expect(plan.regionSlots.water).not.toBe(plan.regionSlots.base);
    // every region gets a real slot in [1, 2]
    for (const slot of Object.values(plan.regionSlots)) {
      expect(slot).toBeGreaterThanOrEqual(1);
      expect(slot).toBeLessThanOrEqual(2);
    }
  });

  it("collapses to a single slot when targetSlots is 1", () => {
    const rows: ColourRow[] = [
      { region: "base", slot: 1, colorHex: "#000000" },
      { region: "buildings", slot: 2, colorHex: "#ffffff" },
      { region: "water", slot: 3, colorHex: "#0000ff" },
      { region: "parks", slot: 4, colorHex: "#00ff00" },
    ];
    const plan = planMergeToSlots(rows, 1);
    const slots = new Set(Object.values(plan.regionSlots));
    expect(slots.size).toBe(1);
    expect([...slots][0]).toBe(1);
  });

  it("a merged region's colour is always one that was really on the plate, never an average", () => {
    const rows: ColourRow[] = [
      { region: "base", slot: 1, colorHex: "#3A3A3A" },
      { region: "roads", slot: 2, colorHex: "#3B3B3B" },
      { region: "frame", slot: 2, colorHex: "#3B3B3B" }, // slot 2 has two members: heavier
      { region: "water", slot: 3, colorHex: "#2F7FC1" },
    ];
    const plan = planMergeToSlots(rows, 2);
    const usedColours = new Set(rows.map((row) => row.colorHex));
    for (const color of Object.values(plan.regionColors)) {
      expect(usedColours.has(color as string)).toBe(true);
    }
  });

  it("preserves an existing shared slot as one unit: two regions on slot 1 stay together", () => {
    const rows: ColourRow[] = [
      { region: "base", slot: 1, colorHex: "#D8D3C6" },
      { region: "frame", slot: 1, colorHex: "#3A3A3A" },
      { region: "buildings", slot: 2, colorHex: "#D8D3C6" },
      { region: "water", slot: 3, colorHex: "#2F7FC1" },
    ];
    const plan = planMergeToSlots(rows, 2);
    expect(plan.regionSlots.base).toBe(plan.regionSlots.frame);
  });

  it("rejects a target below 1", () => {
    expect(() => planMergeToSlots([{ region: "base", slot: 1, colorHex: "#000000" }], 0)).toThrow();
  });

  it("is deterministic: running it twice on the same input gives the same plan", () => {
    const rows: ColourRow[] = [
      { region: "base", slot: 1, colorHex: "#3A3A3A" },
      { region: "roads", slot: 2, colorHex: "#3B3B3B" },
      { region: "water", slot: 3, colorHex: "#2F7FC1" },
      { region: "parks", slot: 4, colorHex: "#5A9E4B" },
    ];
    const first = planMergeToSlots(rows, 2);
    const second = planMergeToSlots(rows, 2);
    expect(second).toEqual(first);
  });
});
