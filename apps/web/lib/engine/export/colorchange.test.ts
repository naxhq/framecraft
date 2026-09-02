import { describe, expect, it } from "vitest";

import { customGcodePerLayerXml, describePlan, planColorChanges, snapToLayerTop } from "./colorchange";
import { boxRegion, sampleRegions } from "./fixtures";
import { findAll, parseXml } from "./xmlParse";

describe("planColorChanges", () => {
  it("finds stacked cubes on different slots separable and plans one change", () => {
    const lower = boxRegion({ region: "base", slot: 1, colorHex: "#D8D3C6", min: [0, 0, 0], size: [20, 20, 10] });
    const upper = boxRegion({ region: "buildings", slot: 2, colorHex: "#3A3A3A", min: [0, 0, 10], size: [20, 20, 10] });
    const plan = planColorChanges([lower, upper]);
    expect(plan.separable).toEqual(["base", "buildings"]);
    expect(plan.inseparable).toEqual([]);
    expect(plan.initialSlot).toBe(1);
    expect(plan.initialColor).toBe("#D8D3C6");
    expect(plan.bands.map((b) => [b.fromZ, b.toZ, b.slot])).toEqual([
      [0, 10, 1],
      [10, 20, 2],
    ]);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({ printZ: 10.2, slot: 2, color: "#3A3A3A", regions: ["buildings"] });
  });

  it("finds side-by-side cubes on different slots inseparable and plans nothing", () => {
    const left = boxRegion({ region: "base", slot: 1, colorHex: "#D8D3C6", min: [0, 0, 0], size: [10, 10, 10] });
    const right = boxRegion({ region: "water", slot: 3, colorHex: "#2F7FC1", min: [20, 0, 0], size: [10, 10, 10] });
    const plan = planColorChanges([left, right]);
    expect(plan.separable).toEqual([]);
    expect(plan.inseparable).toEqual(["base", "water"]);
    expect(plan.report.find((r) => r.region === "base")?.conflicts).toEqual(["water"]);
    expect(plan.report.find((r) => r.region === "water")?.conflicts).toEqual(["base"]);
    expect(plan.changes).toEqual([]);
    expect(plan.initialSlot).toBe(1);
  });

  it("treats touching ranges as separable and overlapping same-slot regions as one band", () => {
    const base = boxRegion({ region: "base", slot: 1, colorHex: "#D8D3C6", min: [0, 0, 0], size: [20, 20, 3] });
    const frame = boxRegion({ region: "frame", slot: 1, colorHex: "#3A3A3A", min: [0, 0, 2], size: [20, 20, 3] });
    const towers = boxRegion({ region: "buildings", slot: 2, colorHex: "#FFFFFF", min: [5, 5, 5], size: [5, 5, 10] });
    const plan = planColorChanges([base, frame, towers]);
    expect(plan.separable).toEqual(["base", "frame", "buildings"]);
    expect(plan.bands).toHaveLength(2);
    expect(plan.bands[0]).toMatchObject({ fromZ: 0, toZ: 5, slot: 1, regions: ["base", "frame"] });
    expect(plan.changes.map((c) => c.printZ)).toEqual([5.2]);
  });

  it("reports the frame-city sample: nothing is separable and every conflict is named", () => {
    const plan = planColorChanges(sampleRegions());
    expect(plan.separable).toEqual([]);
    expect(plan.inseparable).toEqual(["base", "frame", "buildings", "hero_building", "water", "lettering"]);
    const conflicts = Object.fromEntries(plan.report.map((r) => [r.region, r.conflicts]));
    // the water pocket is cut 1 mm into the 3 mm base
    expect(conflicts.base).toEqual(["water"]);
    // buildings (slot 2, z 3..33) share layers with the frame lip (slot 1, z 3..5),
    // the hero (slot 4, z 3..48) and the lettering (slot 4, z 4.6..5)
    expect(conflicts.buildings).toEqual(["frame", "hero_building", "lettering"]);
    expect(conflicts.frame).toEqual(["buildings", "hero_building", "lettering"]);
    expect(plan.initialSlot).toBe(1);
    // No region is separable, but above the tallest ordinary building (z 33)
    // the hero stands alone, so those layers CAN print in its gold: the plan is
    // a band sweep, not a per-region verdict (v3-02 finding 1).
    expect(plan.changes).toEqual([{ printZ: 33.2, slot: 4, color: "#E3A72F", regions: ["hero_building"] }]);
    // Everything below that change keeps slot 1, so the two slot-1 bodies get
    // their colour and the three that share those layers do not.
    expect(plan.served).toEqual(["base", "frame"]);
    const lostTo = Object.fromEntries(plan.report.map((r) => [r.region, r.lostTo]));
    expect(lostTo.water).toEqual(["base"]);
    expect(lostTo.buildings).toEqual(["frame"]);
  });

  it("keeps the 0.2 mm seam interpenetration out of the separability test", () => {
    // The regions this engine emits are not a flush partition: each reaches
    // `transform.BUILDING_OVERLAP_MM` into the body beside it, and a building
    // reaches `building_skirt_mm` (0.3) below the base top as well. Both are
    // buried material, so stacked bodies stay separable (v3-02 finding 1).
    const base = boxRegion({ region: "base", slot: 1, colorHex: "#D8D3C6", min: [0, 0, 0], size: [20, 20, 3] });
    const seam = boxRegion({ region: "buildings", slot: 2, colorHex: "#3A3A3A", min: [5, 5, 2.8], size: [5, 5, 17.2] });
    const seamPlan = planColorChanges([base, seam]);
    expect(seamPlan.separable).toEqual(["base", "buildings"]);
    expect(seamPlan.served).toEqual(["base", "buildings"]);
    expect(seamPlan.changes.map((c) => [c.printZ, c.slot])).toEqual([[3.2, 2]]);

    // Same, with the default 0.3 mm skirt on top of the 0.2 mm seam.
    const skirted = boxRegion({ region: "buildings", slot: 2, colorHex: "#3A3A3A", min: [5, 5, 2.7], size: [5, 5, 17.3] });
    const skirtPlan = planColorChanges([base, skirted]);
    expect(skirtPlan.separable).toEqual(["base", "buildings"]);
    expect(skirtPlan.changes.map((c) => [c.printZ, c.slot])).toEqual([[3.2, 2]]);

    // A deeper interpenetration than construction accounts for is real sharing.
    const sunk = boxRegion({ region: "buildings", slot: 2, colorHex: "#3A3A3A", min: [5, 5, 1.5], size: [5, 5, 18.5] });
    const sunkPlan = planColorChanges([base, sunk]);
    expect(sunkPlan.inseparable).toEqual(["base", "buildings"]);

    // Side by side, sharing every layer, is inseparable however small the box.
    const beside = boxRegion({ region: "water", slot: 3, colorHex: "#2F7FC1", min: [40, 0, 2.8], size: [5, 5, 0.2] });
    const besidePlan = planColorChanges([base, beside]);
    expect(besidePlan.inseparable).toEqual(["base", "water"]);
    expect(besidePlan.changes).toEqual([]);
  });

  it("plans the Chicago build: buildings get their own band, recessed regions do not", () => {
    // The Z ranges the engine really produces for fixtures/chicago-scene.json
    // with fixtures/print-params-parts.json (base 3 mm, skirt 0.3, roads
    // engraved 0.6 deep at -0.2, water 1.0 at -0.5, parks 0.4 flush), measured
    // off `buildModel()`. Slots: base/frame 1, buildings 2, water 3, roads/parks 4.
    const regions = [
      boxRegion({ region: "base", slot: 1, colorHex: "#D8D3C6", min: [0, 0, 0], size: [180, 180, 3] }),
      boxRegion({ region: "frame", slot: 1, colorHex: "#3A3A3A", min: [0, 0, 2.8], size: [180, 6, 2.2] }),
      boxRegion({ region: "buildings", slot: 2, colorHex: "#D8D3C6", min: [20, 20, 2.7], size: [60, 60, 32.033] }),
      boxRegion({ region: "roads", slot: 4, colorHex: "#3A3A3A", min: [10, 10, 2.0], size: [160, 160, 0.8] }),
      boxRegion({ region: "water", slot: 3, colorHex: "#2F7FC1", min: [10, 140, 1.3], size: [60, 30, 1.2] }),
      boxRegion({ region: "parks", slot: 4, colorHex: "#5A9E4B", min: [100, 20, 2.4], size: [30, 30, 0.6] }),
    ];
    const plan = planColorChanges(regions);
    // One change, on the first layer above the base top.
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({ printZ: 3.2, slot: 2, regions: ["buildings"] });
    expect(plan.initialSlot).toBe(1);
    // The buildings print in their own colour all the way up; the frame lip,
    // which rises through them, is the body that loses.
    expect(plan.served).toEqual(["base", "buildings"]);
    const report = Object.fromEntries(plan.report.map((r) => [r.region, r]));
    expect(report.frame.lostTo).toEqual(["buildings"]);
    // The recessed regions sit inside the base's own layers: honestly inseparable.
    for (const name of ["roads", "water", "parks"] as const) {
      expect(report[name].served).toBe(false);
      expect(report[name].conflicts).toContain("base");
    }
    expect(describePlan(plan)).toEqual([
      "start with slot 1 (#D8D3C6)",
      "at z=3.2 mm change to slot 2 (#D8D3C6) for buildings",
      "frame (slot 1) shares layers with buildings and keeps the loaded colour",
      "roads (slot 4) shares layers with base and keeps the loaded colour",
      "water (slot 3) shares layers with base and keeps the loaded colour",
      "parks (slot 4) shares layers with base and keeps the loaded colour",
    ]);
  });

  it("snaps a change to the top of the first layer above the boundary", () => {
    expect(snapToLayerTop(10, 0.2)).toBe(10.2);
    expect(snapToLayerTop(10.1, 0.2)).toBe(10.2);
    expect(snapToLayerTop(10.2, 0.2)).toBe(10.4);
    expect(snapToLayerTop(3, 0.16)).toBe(3.04);
    const plan = planColorChanges(
      [
        boxRegion({ region: "base", slot: 1, colorHex: "#D8D3C6", min: [0, 0, 0], size: [10, 10, 3] }),
        boxRegion({ region: "buildings", slot: 2, colorHex: "#3A3A3A", min: [0, 0, 3], size: [10, 10, 3] }),
      ],
      { layerHeightMm: 0.28 },
    );
    expect(plan.changes[0].printZ).toBe(3.08);
  });

  it("writes the Bambu custom_gcode_per_layer.xml layout", () => {
    const plan = planColorChanges(
      [
        boxRegion({ region: "base", slot: 1, colorHex: "#D8D3C6", min: [0, 0, 0], size: [10, 10, 10] }),
        boxRegion({ region: "buildings", slot: 2, colorHex: "#3A3A3A", min: [0, 0, 10], size: [10, 10, 10] }),
        boxRegion({ region: "lettering", slot: 4, colorHex: "#E3A72F", min: [0, 0, 20], size: [10, 10, 1] }),
      ],
      { changeGcode: "M600" },
    );
    const xml = customGcodePerLayerXml(plan, 1);
    const doc = parseXml(xml);
    expect(doc.name).toBe("custom_gcodes_per_layer");
    const plates = findAll(doc, "plate");
    expect(plates).toHaveLength(1);
    expect(findAll(doc, "plate_info")[0].attributes.id).toBe("1");
    const layers = findAll(doc, "layer");
    expect(layers.map((l) => l.attributes)).toEqual([
      { top_z: "10.2", type: "0", extruder: "1", color: "#3A3A3A", extra: "", gcode: "M600" },
      { top_z: "20.2", type: "0", extruder: "1", color: "#E3A72F", extra: "", gcode: "M600" },
    ]);
    expect(findAll(doc, "mode")[0].attributes.value).toBe("SingleExtruder");
    expect(describePlan(plan)[0]).toBe("start with slot 1 (#D8D3C6)");
    expect(describePlan(plan)).toHaveLength(3);
  });
});
