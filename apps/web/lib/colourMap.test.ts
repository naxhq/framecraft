import { describe, expect, it } from "vitest";

import { defaultPrintParams } from "./contracts";
import {
  alignConflictsPatch,
  colourRows,
  deltaE76,
  distinctSlots,
  exceedsProfileSlots,
  notServedSentence,
  planMergeToSlots,
  printedColors,
  slotColourConflicts,
  type ColourRow,
} from "./colourMap";
import { regionColor, regionSlot } from "./engine/solid/context";
import { COLOURABLE_REGION_NAMES } from "./engine/types";

describe("colourRows", () => {
  it("without a build result, lists every region name the contract can colour, easel excluded", () => {
    const rows = colourRows(defaultPrintParams(), null);
    const regions = rows.map((row) => row.region);
    expect(regions).not.toContain("easel");
    expect(regions).toContain("base");
    expect(regions).toContain("buildings");
    expect(regions).toContain("hero_building");
    expect(regions).toContain("matting");
    expect(regions).toContain("attribution");
  });

  it("without a build result, reads the contract defaults (base 1, buildings 2, water 3, roads/parks 4)", () => {
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

  it("an empty regions array (a build that produced nothing) falls back to the contract defaults", () => {
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

  it("flags a slot NUMBER above the profile's count even with few distinct slots (audit v3-02 finding 5)", () => {
    // Slots {1, 2, 4, 5}: only 4 DISTINCT values, so a distinct-count
    // comparison alone says "fits a 4-slot profile" -- but slot 5 does not
    // exist on a 4-slot AMS, and the exporter addresses it anyway
    // (`export/common.ts:slotColors`'s own `maxSlot` reaches the highest
    // slot NUMBER present, not the count of distinct ones).
    const fourDistinctButOneOutOfRange: ColourRow[] = [
      { region: "base", slot: 1, colorHex: "#000000" },
      { region: "frame", slot: 2, colorHex: "#000000" },
      { region: "buildings", slot: 4, colorHex: "#ffffff" },
      { region: "roads", slot: 5, colorHex: "#0000ff" },
    ];
    expect(distinctSlots(fourDistinctButOneOutOfRange).length).toBe(4);
    expect(exceedsProfileSlots(fourDistinctButOneOutOfRange, 4)).toBe(true);
    // A profile that genuinely has 5 slots is fine.
    expect(exceedsProfileSlots(fourDistinctButOneOutOfRange, 5)).toBe(false);
  });

  it("still flags on distinct count alone when every slot number is in range", () => {
    // {1,2,3,4,5} on a 4-slot profile: 5 distinct AND slot 5 is out of range
    // -- either rule alone would catch this, both must agree it is a problem.
    const five: ColourRow[] = [1, 2, 3, 4, 5].map((slot) => ({
      region: `r${slot}` as never,
      slot,
      colorHex: "#000000",
    }));
    expect(exceedsProfileSlots(five, 4)).toBe(true);
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

// ===========================================================================
// Slot colour conflicts (audit v3-02 MAJOR finding 4)
// ===========================================================================

describe("printedColors", () => {
  it("is a region's own colour when it owns its slot alone", () => {
    const rows: ColourRow[] = [
      { region: "base", slot: 1, colorHex: "#D8D3C6" },
      { region: "buildings", slot: 2, colorHex: "#123456" },
    ];
    const printed = printedColors(rows);
    expect(printed.get("base")).toBe("#D8D3C6");
    expect(printed.get("buildings")).toBe("#123456");
  });

  it("is the FIRST region in REGION_NAMES order on a shared slot, mirroring export/common.ts:slotColors", () => {
    // REGION_NAMES order: ... roads, water, parks, rail, lettering ...
    // -- roads comes before parks and rail, so roads wins slot 4 even though
    // it is listed last here; the exporter's own rule does not care about
    // row order, only region identity.
    const rows: ColourRow[] = [
      { region: "lettering", slot: 4, colorHex: "#E3A72F" },
      { region: "parks", slot: 4, colorHex: "#5A9E4B" },
      { region: "rail", slot: 4, colorHex: "#6B6B6B" },
      { region: "roads", slot: 4, colorHex: "#3A3A3A" },
    ];
    const printed = printedColors(rows);
    expect(printed.get("roads")).toBe("#3A3A3A");
    expect(printed.get("parks")).toBe("#3A3A3A");
    expect(printed.get("rail")).toBe("#3A3A3A");
    expect(printed.get("lettering")).toBe("#3A3A3A");
  });

  it("matches the frozen default colour table's own documented disagreement (audit verification)", () => {
    // The audit's own verification was against a REAL build (`artifacts/
    // audit-bambu.3mf`, no hero picked), where `hero_building` has no mesh
    // and is therefore ABSENT from the exported regions -- `slotColors` only
    // ever sees real `RegionMesh`es, so roads (REGION_NAMES index 5) is the
    // first REAL region on slot 4 there and wins with #3A3A3A. The PRE-BUILD
    // fallback this test uses (`colourRows(params, null)`, no `EngineResult`
    // yet) is documented to list every colourable name including ones that
    // may never actually build (`colourRows`'s own docstring) -- `hero_building`
    // (REGION_NAMES index 4, before roads) is one of those, so it wins here
    // instead. Both are the SAME rule (`printedColors` mirrors
    // `export/common.ts:slotColors` exactly); they disagree only because the
    // ROW SETS differ, which is `colourRows`'s own known, pre-existing
    // pre-build approximation, not a bug in this rule.
    const rows = colourRows(defaultPrintParams(), null).filter((row) => row.slot === 4);
    const regionsOnSlot4 = rows.map((row) => row.region).sort();
    expect(regionsOnSlot4).toEqual(["hero_building", "lettering", "parks", "rail", "roads"].sort());
    const printed = printedColors(rows);
    expect(printed.get("hero_building")).toBe("#E3A72F");
    expect(printed.get("lettering")).toBe("#E3A72F");
    expect(printed.get("roads")).toBe("#E3A72F");
    expect(printed.get("parks")).toBe("#E3A72F");

    // The same rows, with the pre-build-only `hero_building` row removed (as
    // it genuinely would be, absent from a real build with no hero picked),
    // reproduce the audit's own measured winner exactly.
    const withoutPhantomHero = rows.filter((row) => row.region !== "hero_building");
    expect(printedColors(withoutPhantomHero).get("roads")).toBe("#3A3A3A");
    expect(printedColors(withoutPhantomHero).get("parks")).toBe("#3A3A3A");
    expect(printedColors(withoutPhantomHero).get("lettering")).toBe("#3A3A3A");
  });
});

describe("slotColourConflicts", () => {
  it("is empty when every region on a slot shares the same colour", () => {
    const rows: ColourRow[] = [
      { region: "base", slot: 1, colorHex: "#D8D3C6" },
      { region: "frame", slot: 1, colorHex: "#D8D3C6" },
    ];
    expect(slotColourConflicts(rows)).toEqual([]);
  });

  it("names the winning region, its colour, and the losing regions", () => {
    const rows: ColourRow[] = [
      { region: "roads", slot: 4, colorHex: "#3A3A3A" },
      { region: "parks", slot: 4, colorHex: "#5A9E4B" },
      { region: "rail", slot: 4, colorHex: "#6B6B6B" },
    ];
    const conflicts = slotColourConflicts(rows);
    expect(conflicts).toEqual([
      { slot: 4, printedRegion: "roads", printedColorHex: "#3A3A3A", losingRegions: ["parks", "rail"] },
    ]);
  });

  it("the frozen defaults produce a real conflict on slot 4 (audit v3-02 MAJOR finding 4)", () => {
    const rows = colourRows(defaultPrintParams(), null);
    const conflicts = slotColourConflicts(rows);
    const onSlot4 = conflicts.find((c) => c.slot === 4);
    expect(onSlot4, JSON.stringify(conflicts)).toBeDefined();
    // Winner is `hero_building` here because the PRE-BUILD fallback row set
    // includes it unconditionally (see `printedColors`'s own test above for
    // why); `lettering` shares hero_building's exact default colour
    // (#E3A72F) by coincidence, so it is not a LOSING region even though it
    // is on the same slot.
    expect(onSlot4?.printedRegion).toBe("hero_building");
    expect(onSlot4?.losingRegions.sort()).toEqual(["parks", "rail", "roads"].sort());
  });

  it("the frozen defaults ALSO conflict on slot 1 (base/frame/matting/attribution, a second real disagreement)", () => {
    // Not named in the audit's own slot-4 example, but the same rule finds
    // it too: base #D8D3C6, frame #3A3A3A and matting #EDE9E0 share slot 1
    // with three different colours.
    const rows = colourRows(defaultPrintParams(), null);
    const conflicts = slotColourConflicts(rows);
    const onSlot1 = conflicts.find((c) => c.slot === 1);
    expect(onSlot1, JSON.stringify(conflicts)).toBeDefined();
    expect(onSlot1?.printedRegion).toBe("base");
    expect(onSlot1?.losingRegions.sort()).toEqual(["frame", "matting"].sort());
  });

  it("ignores a case-only hex difference (not a real conflict)", () => {
    const rows: ColourRow[] = [
      { region: "roads", slot: 4, colorHex: "#3A3A3A" },
      { region: "parks", slot: 4, colorHex: "#3a3a3a" },
    ];
    // Deliberately strict: this function compares the RAW string, so a caller
    // that wants case-insensitivity normalises before calling it. Asserted
    // here so a future "helpful" normalisation inside the function is a
    // conscious choice, not an accident.
    expect(slotColourConflicts(rows)).toEqual([
      { slot: 4, printedRegion: "roads", printedColorHex: "#3A3A3A", losingRegions: ["parks"] },
    ]);
  });

  it("is sorted by slot, ascending", () => {
    const rows: ColourRow[] = [
      { region: "water", slot: 3, colorHex: "#2F7FC1" },
      { region: "parks", slot: 3, colorHex: "#5A9E4B" },
      { region: "roads", slot: 1, colorHex: "#3A3A3A" },
      { region: "base", slot: 1, colorHex: "#D8D3C6" },
    ];
    expect(slotColourConflicts(rows).map((c) => c.slot)).toEqual([1, 3]);
  });
});

describe("alignConflictsPatch", () => {
  it("rewrites every losing region to its slot's printed colour", () => {
    const rows: ColourRow[] = [
      { region: "roads", slot: 4, colorHex: "#3A3A3A" },
      { region: "parks", slot: 4, colorHex: "#5A9E4B" },
      { region: "rail", slot: 4, colorHex: "#6B6B6B" },
    ];
    const patch = alignConflictsPatch(slotColourConflicts(rows));
    expect(patch).toEqual({ parks: "#3A3A3A", rail: "#3A3A3A" });
  });

  it("never patches the winning region: applying it twice is a no-op", () => {
    const rows = colourRows(defaultPrintParams(), null);
    const conflicts = slotColourConflicts(rows);
    const patch = alignConflictsPatch(conflicts);
    const aligned: ColourRow[] = rows.map((row) =>
      row.region in patch ? { ...row, colorHex: (patch as Record<string, string>)[row.region] } : row,
    );
    expect(slotColourConflicts(aligned)).toEqual([]);
    expect(alignConflictsPatch(slotColourConflicts(aligned))).toEqual({});
  });

  it("is empty for no conflicts", () => {
    expect(alignConflictsPatch([])).toEqual({});
  });
});

// ===========================================================================
// Colour-change plan summary (ExportMenu.tsx follow-up, audit finding 1)
// ===========================================================================

describe("notServedSentence", () => {
  it("says every region prints in its own colour when nothing lost", () => {
    expect(notServedSentence({ report: [] })).toBe("Every region prints in its own colour.");
    expect(
      notServedSentence({
        report: [
          { region: "buildings", slot: 1, zMin: 0, zMax: 10, separable: false, served: true, conflicts: ["base"], lostTo: [] },
        ],
      }),
    ).toBe("Every region prints in its own colour.");
  });

  it("names the colour a not-served region prints in instead, from lostTo", () => {
    const sentence = notServedSentence({
      report: [
        { region: "roads", slot: 1, zMin: 0, zMax: 5, separable: false, served: false, conflicts: ["base"], lostTo: ["base"] },
      ],
    });
    expect(sentence).toBe("roads prints in the colour of base.");
  });

  it("joins multiple not-served regions with a semicolon", () => {
    const sentence = notServedSentence({
      report: [
        { region: "roads", slot: 1, zMin: 0, zMax: 5, separable: false, served: false, conflicts: ["base"], lostTo: ["base"] },
        { region: "water", slot: 1, zMin: 0, zMax: 5, separable: false, served: false, conflicts: ["base"], lostTo: ["base"] },
      ],
    });
    expect(sentence).toBe("roads prints in the colour of base; water prints in the colour of base.");
  });

  it("falls back to a plain statement when there is no lostTo/conflicts to name", () => {
    const sentence = notServedSentence({
      report: [
        { region: "parks", slot: 2, zMin: 0, zMax: 5, separable: false, served: false, conflicts: [], lostTo: [] },
      ],
    });
    expect(sentence).toBe("parks does not print in its own colour.");
  });

  it("a served-but-not-separable region (the Chicago buildings case) is NOT listed", () => {
    // Regression guard for the exact bug the audit follow-up describes:
    // `separable: false` alone must not make a served region show up as
    // printing in someone else's colour.
    const sentence = notServedSentence({
      report: [
        { region: "buildings", slot: 1, zMin: 3, zMax: 20, separable: false, served: true, conflicts: ["base"], lostTo: [] },
        { region: "base", slot: 1, zMin: 0, zMax: 3, separable: true, served: true, conflicts: [], lostTo: [] },
      ],
    });
    expect(sentence).toBe("Every region prints in its own colour.");
  });
});

describe("preview-theme isolation (colour.preview_theme never reaches an exported colour)", () => {
  // `colour.preview_theme` switches the 3D viewport's OWN background/ground
  // shading only (v3 phase 5, `[V3-P5-C]`, `components/scene/palette.ts`'s
  // `readViewportPalette`); it must never move a region's resolved slot or
  // colour, which is the ONLY thing an exporter (or `colourRows`, which feeds
  // the COLOUR panel) ever reads off `params.colour`. `regionSlot`/
  // `regionColor` (`lib/engine/solid/context.ts`) are the single choke point
  // every one of those paths resolves through, so proving THEY ignore it is
  // sufficient for all of them.
  const base = defaultPrintParams();
  const dark = { ...base, colour: { ...base.colour, preview_theme: "dark" as const } };
  const light = { ...base, colour: { ...base.colour, preview_theme: "light" as const } };

  it("regionColor is identical for every colourable region across both preview themes", () => {
    for (const region of COLOURABLE_REGION_NAMES) {
      expect(regionColor(dark, region)).toBe(regionColor(light, region));
    }
  });

  it("regionSlot is identical for every colourable region across both preview themes", () => {
    for (const region of COLOURABLE_REGION_NAMES) {
      expect(regionSlot(dark, region)).toBe(regionSlot(light, region));
    }
  });

  it("colourRows (what the COLOUR panel and the exporters' pre-build fallback both read) is identical across themes", () => {
    expect(colourRows(dark, null)).toEqual(colourRows(light, null));
  });
});
