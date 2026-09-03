/**
 * The diff behind the changes counter, the per-section reset and the per-row
 * revert.
 *
 * Three claims are worth a test each, because each one is a promise the panel
 * makes on screen:
 *
 *  1. a section reset writes THIS section's fields and nothing else;
 *  2. a revert writes one leaf and leaves the other changes standing;
 *  3. layout state is not a change (DECISIONS `[V3.1-O6]`), so nothing a panel
 *     stores about itself can ever reach the counter.
 *
 * The reset and revert paths are driven through the REAL store setter and read
 * back, the way `groups/ColourGroup.test.ts` drives the real patch builders:
 * a diff that is right in isolation and wrong through `setParam` is not right.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_PRINT_PARAMS, defaultPrintParams, type PrintParams } from "./contracts";
import { controlsInGroup } from "./controlCatalog";
import { GROUPS } from "./groups";
import {
  NOT_A_SETTING,
  changeCount,
  changedInSection,
  changedSettings,
  controllableLeaves,
  formatLeaf,
  humanisePath,
  isChanged,
  leafKeyPath,
  sectionPaths,
  sectionReset,
  topLevelKey,
  uncontrolledChanges,
  valueAt,
  withDefaults,
  withLeaf,
} from "./settingsDiff";
import { useEditorStore } from "@/store/editor";

beforeEach(() => {
  useEditorStore.setState({ params: defaultPrintParams() });
});

/** Write one top-level key through the real store, as the panel does. */
function throughTheStore(next: PrintParams, key: keyof PrintParams): PrintParams {
  useEditorStore.getState().setParam(key, next[key]);
  return useEditorStore.getState().params;
}

describe("reading and writing one leaf", () => {
  it("reads a nested path, and reads an absent block as undefined", () => {
    const params = defaultPrintParams();
    expect(valueAt(params, "regions.rail.width_m")).toBe(6.0);
    expect(valueAt(params, "frame_style.shadow_gap.width_mm")).toBe(1.0);
    expect(valueAt({ ...params, regions: undefined }, "regions.rail.width_m")).toBeUndefined();
  });

  it("collapses an array-of-objects leaf onto its array", () => {
    expect(leafKeyPath("engravings[].text")).toBe("engravings");
    expect(topLevelKey("frame_style.shadow_gap.width_mm")).toBe("frame_style");
    expect(topLevelKey("engravings[].text")).toBe("engravings");
  });

  it("writes a leaf without mutating anything it passed through", () => {
    const params = defaultPrintParams();
    const next = withLeaf(params, "regions.rail.width_m", 9);
    expect(valueAt(next, "regions.rail.width_m")).toBe(9);
    expect(valueAt(params, "regions.rail.width_m")).toBe(6.0);
    // A new object at every level, so a memo keyed on `regions` notices.
    expect(next.regions).not.toBe(params.regions);
    expect(next.regions?.rail).not.toBe(params.regions?.rail);
    // ...and the siblings survive.
    expect(next.regions?.rail?.depth_mm).toBe(params.regions?.rail?.depth_mm);
    expect(next.regions?.roads).toEqual(params.regions?.roads);
  });

  it("fills an absent block from the contract rather than from an empty object", () => {
    // A v1 payload carries no `bridges`. Writing `enabled` into it must not
    // produce `{ enabled: false }` with the clearance and the abutments gone.
    const v1 = { ...defaultPrintParams(), bridges: undefined };
    const next = withLeaf(v1, "bridges.enabled", false);
    expect(next.bridges).toEqual({ enabled: false, clearance_mm: 1.0, abutments: true });
  });
});

describe("what a section owns", () => {
  it("gives every rendered group leaves, taken from the catalog", () => {
    for (const group of GROUPS) {
      if (group.id === "output") continue;
      const paths = sectionPaths(group.id);
      expect(paths.length, group.id).toBeGreaterThan(0);
      // Every path is one a control in THIS group writes.
      const owned = new Set<string>();
      for (const spec of controlsInGroup(group.id)) {
        if (typeof spec.writes === "string") continue;
        for (const path of spec.writes) owned.add(leafKeyPath(path));
      }
      expect([...paths].sort()).toEqual([...owned].sort());
    }
  });

  it("keeps the two sections apart that share a contract block", () => {
    // Surface owns `road_mode`; Surface depths owns `regions.roads.*`. A reset
    // of one must not be a reset of the other.
    expect(sectionPaths("surface")).toContain("road_mode");
    expect(sectionPaths("surface")).not.toContain("regions.roads.depth_mm");
    expect(sectionPaths("regions")).toContain("regions.roads.depth_mm");
    expect(sectionPaths("regions")).not.toContain("road_mode");
    expect(sectionPaths("bridges")).toEqual([
      "bridges.enabled",
      "bridges.clearance_mm",
      "bridges.abutments",
    ]);
  });

  it("leaves a field with no control alone, even inside a block it resets", () => {
    // The six `heights.type_defaults.*` rows have no control (one row per
    // building type is a table, not a slider), and the Heights section resets
    // four leaves around them. A reset that wrote the whole `heights` block
    // would silently move all six.
    expect(sectionPaths("heights")).toContain("heights.floor_height_m");
    expect(sectionPaths("heights")).not.toContain("heights.type_defaults.house");
    let params = withLeaf(defaultPrintParams(), "heights.type_defaults.house", 11);
    params = withLeaf(params, "heights.floor_height_m", 4.5);
    const reset = sectionReset(params, "heights");
    expect(valueAt(reset, "heights.floor_height_m")).toBe(3.0);
    expect(valueAt(reset, "heights.type_defaults.house")).toBe(11);
  });

  it("owns the lip depth again, now that its geometry is in", () => {
    // [V3.1-P2-2] cut the sight-edge rebate and [V3.1-P2-6] returned the
    // slider with it, so the Frame section resets that leaf like any other one
    // it shows. Before this wave it was the section's excluded field.
    expect(sectionPaths("frame")).toContain("frame_style.lip_depth_mm");
    const params = withLeaf(defaultPrintParams(), "frame_style.lip_depth_mm", 2.5);
    expect(changedInSection(params, "frame")).toEqual(["frame_style.lip_depth_mm"]);
    expect(valueAt(sectionReset(params, "frame"), "frame_style.lip_depth_mm")).toBe(0.4);
  });
});

describe("a section reset", () => {
  it("puts this section back and leaves every other section alone", () => {
    let params = withLeaf(defaultPrintParams(), "regions.rail.width_m", 12);
    params = withLeaf(params, "regions.water.depth_mm", 2.5);
    params = withLeaf(params, "plate_mm", 220);
    params = withLeaf(params, "bridges.clearance_mm", 3);

    expect(changedInSection(params, "regions")).toEqual([
      "regions.water.depth_mm",
      "regions.rail.width_m",
    ]);

    const next = sectionReset(params, "regions");
    expect(valueAt(next, "regions.rail.width_m")).toBe(6.0);
    expect(valueAt(next, "regions.water.depth_mm")).toBe(1.0);
    // Untouched.
    expect(next.plate_mm).toBe(220);
    expect(valueAt(next, "bridges.clearance_mm")).toBe(3);
  });

  it("is the same object when the section is already at its defaults", () => {
    // What lets the panel skip the write, and therefore skip the undo entry.
    const params = withLeaf(defaultPrintParams(), "plate_mm", 220);
    expect(sectionReset(params, "regions")).toBe(params);
    expect(changedInSection(params, "regions")).toEqual([]);
  });

  it("survives the real store setter, one write per top-level key", () => {
    const store = useEditorStore.getState();
    store.setParam("regions", withLeaf(store.params, "regions.rail.width_m", 15).regions);
    expect(useEditorStore.getState().params.regions?.rail?.width_m).toBe(15);

    const next = sectionReset(useEditorStore.getState().params, "regions");
    const back = throughTheStore(next, "regions");
    expect(back.regions?.rail?.width_m).toBe(6.0);
    expect(back.regions).toEqual(DEFAULT_PRINT_PARAMS.regions);
  });

  it("never hands the store a value shared with the frozen default", () => {
    // `DEFAULT_PRINT_PARAMS` is deep-frozen, so a reset that handed its nested
    // object straight over would make the next `setNested` throw in strict mode.
    const params = withLeaf(defaultPrintParams(), "bridges.enabled", false);
    const next = sectionReset(params, "bridges");
    expect(next.bridges).toEqual(DEFAULT_PRINT_PARAMS.bridges);
    expect(Object.isFrozen(next.bridges)).toBe(false);
  });
});

describe("the changes list", () => {
  it("is empty for a fresh design", () => {
    const params = defaultPrintParams();
    expect(changedSettings(params)).toEqual([]);
    expect(uncontrolledChanges(params)).toEqual([]);
    expect(changeCount(params)).toBe(0);
  });

  it("names the control, the section, the default and the current value", () => {
    const params = withLeaf(defaultPrintParams(), "plate_mm", 220);
    const [row] = changedSettings(params);
    expect(row).toEqual({
      path: "plate_mm",
      controlId: "plate_mm",
      label: "Plate size",
      group: "scale",
      groupTitle: "Scale and size",
      defaultText: "180 mm",
      currentText: "220 mm",
    });
  });

  it("reverts one row and leaves the others standing", () => {
    let params = withLeaf(defaultPrintParams(), "plate_mm", 220);
    params = withLeaf(params, "bridges.enabled", false);
    expect(changeCount(params)).toBe(2);

    const next = withDefaults(params, ["bridges.enabled"]);
    const back = throughTheStore(next, topLevelKey("bridges.enabled"));
    expect(back.bridges?.enabled).toBe(true);
    expect(isChanged(back, "plate_mm")).toBe(false);
    // The store started from the defaults, so only the reverted key was written
    // through it; the diff itself is what carries the other change.
    expect(changedSettings(next).map((row) => row.path)).toEqual(["plate_mm"]);
  });

  it("counts a field with no control, and says it cannot revert it", () => {
    const params = withLeaf(defaultPrintParams(), "heights.type_defaults.house", 11);
    expect(changedSettings(params)).toEqual([]);
    expect(uncontrolledChanges(params)).toEqual(["heights.type_defaults.house"]);
    expect(changeCount(params)).toBe(1);
    expect(humanisePath("heights.type_defaults.house")).toBe("Heights type defaults house");
  });

  it("refuses to call the geocoder's own writes a change", () => {
    // Dropping a pin fills these three. A counter that read "3 changed" on a
    // design nobody has touched is worse than no counter.
    const params = {
      ...defaultPrintParams(),
      place: { ...DEFAULT_PRINT_PARAMS.place, country: "United States", state: "Illinois" },
    };
    expect(changeCount(params)).toBe(0);
    for (const path of ["place.country", "place.state", "place.neighbourhood"]) {
      expect(NOT_A_SETTING.has(path), path).toBe(true);
    }
  });

  it("cannot see layout state, because layout state is not a parameter", () => {
    // [V3.1-O6]. The only thing this module reads is `PrintParams`, and the
    // expanded sections, the search box and the theme are not in it: there is
    // no key here for any of them to land in.
    const params = defaultPrintParams();
    const keys = new Set(Object.keys(params));
    for (const layout of ["collapsed", "expanded", "query", "theme", "layout", "panel"]) {
      expect(keys.has(layout), layout).toBe(false);
    }
    expect(controllableLeaves().some((path) => path.startsWith("colour.preview_theme"))).toBe(false);
  });
});

describe("formatting", () => {
  it("says what a value is, in the words the panel uses", () => {
    expect(formatLeaf("plate_mm", 180)).toBe("180 mm");
    expect(formatLeaf("regions.rail.width_m", 6)).toBe("6 m");
    expect(formatLeaf("rotation_deg", 15)).toBe("15°");
    expect(formatLeaf("bridges.enabled", true)).toBe("on");
    expect(formatLeaf("bridges.enabled", false)).toBe("off");
    expect(formatLeaf("city_label", "")).toBe("empty");
    expect(formatLeaf("city_label", "Chicago")).toBe("Chicago");
    expect(formatLeaf("engravings", [])).toBe("none");
    expect(formatLeaf("engravings", [1, 2])).toBe("2 lines");
    expect(formatLeaf("hero_building_ids", ["a"])).toBe("1 hero");
    expect(formatLeaf("terrain.smoothing", undefined)).toBe("not set");
  });

  it("does not print a float artefact from a slider step", () => {
    expect(formatLeaf("regions.roads.proud_mm", 0.30000000000000004)).toBe("0.3 mm");
  });
});
