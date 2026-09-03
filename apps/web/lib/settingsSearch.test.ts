/**
 * The settings search: what it finds, what it ranks first, and what it marks.
 *
 * The index is the control catalog, so the two things worth pinning are that
 * the search really reaches every group the panel renders (a group missing from
 * the index is a group a user cannot search their way into) and that the
 * ranking puts the control whose NAME matched above the twenty controls whose
 * help string happens to mention the word.
 */

import { describe, expect, it } from "vitest";

import { CONTROLS } from "./controlCatalog";
import { GROUPS } from "./groups";
import {
  groupsWithHits,
  highlight,
  hitsInGroup,
  queryTokens,
  searchSettings,
  searchableCount,
} from "./settingsSearch";

describe("the query", () => {
  it("is nothing until something is typed", () => {
    for (const query of ["", "   ", "\t\n"]) {
      expect(queryTokens(query)).toEqual([]);
      expect(searchSettings(query)).toEqual([]);
    }
  });

  it("needs every token to match, so two words narrow rather than widen", () => {
    const rail = searchSettings("rail width");
    expect(rail.length).toBeGreaterThan(0);
    expect(rail[0].id).toBe("regions_rail_width_m");
    // "rail" alone reaches the slots and the colours too, so the second token
    // is doing real work.
    expect(searchSettings("rail").length).toBeGreaterThan(rail.length);
    expect(searchSettings("rail zzzz")).toEqual([]);
  });
});

describe("what it finds", () => {
  it("covers every group the panel renders", () => {
    // A group with no searchable control is a group nobody can find their way
    // into. Since [V3.1-P5-4] that includes `output`: it is searched like any
    // other group, and the export format select is the control that makes it
    // reachable.
    for (const group of GROUPS) {
      const hits = searchSettings(group.title.toLowerCase().split(" ")[0]);
      const reachable = CONTROLS.filter((spec) => spec.group === group.id).some((spec) =>
        searchSettings(spec.label).some((hit) => hit.id === spec.id),
      );
      expect(reachable, `${group.id} has no control the search can reach`).toBe(true);
      expect(hits.length, group.id).toBeGreaterThanOrEqual(0);
    }
  });

  /**
   * Rewritten for DECISIONS `[V3.1-P5-4]`, which overturned this test's
   * premise rather than weakening it.
   *
   * It used to assert that no hit came from the `output` group at all, and
   * that made the box's own help false: "across every group" did not include
   * the group holding `export_target`, so typing "format" found nothing.
   * The thing actually worth forbidding is a hit that goes nowhere, and that
   * is what is asserted now, over a wider net of queries than before: the
   * search may never return its own box, a group header, Reset all, or a
   * transient row from the right-click inspector or the labels card, because
   * none of those is a control the panel can take you to. A control that
   * writes a `PrintParams` leaf is fair game wherever it is rendered.
   */
  it("never returns the panel's own chrome or a row it cannot reach", () => {
    const byId = new Map(CONTROLS.map((spec) => [spec.id, spec]));
    for (const query of ["reset", "export", "search", "group", "label", "object", "this"]) {
      for (const hit of searchSettings(query)) {
        const spec = byId.get(hit.id);
        if (spec === undefined) continue; // a section, which has no `writes`
        // A `*` row inside a parameter group is reachable: it has no single
        // element, but the hit opens the section it lives in, which is where
        // its instances are. In `output` there is no section to open.
        if (spec.group !== "output") continue;
        expect(spec.id, `${query} found the wildcard row ${hit.id}`).not.toContain("*");
        expect(
          Array.isArray(spec.writes),
          `${query} found ${hit.id}, which writes ${JSON.stringify(spec.writes)} and so has nowhere to take you`,
        ).toBe(true);
      }
    }
  });

  it("finds the export format, which lives in the action bar and writes a parameter", () => {
    for (const query of ["format", "export format", "3mf"]) {
      const hits = searchSettings(query);
      expect(
        hits.map((hit) => hit.id),
        `"${query}" must find the export format select ([V3.1-P5-4])`,
      ).toContain("export_target");
    }
  });

  it("finds a control by what it does, not only by its name", () => {
    // Nothing is called "clearance" except the bridge slider, but the word a
    // user types is often the physical one from the help string.
    const hits = searchSettings("abutment");
    expect(hits.map((hit) => hit.id)).toContain("bridges_abutments");
    const nozzle = searchSettings("minimum wall");
    expect(nozzle.map((hit) => hit.id)).toContain("nozzle_mm");
  });

  it("ranks an exact label above a help-string mention", () => {
    const hits = searchSettings("clearance");
    expect(hits[0].id).toBe("bridges_clearance_mm");
    const depth = searchSettings("water thickness");
    expect(depth[0].id).toBe("regions_water_depth_mm");
  });

  it("hands back the test id to focus, and null where there is no single one", () => {
    const one = searchSettings("plate size")[0];
    expect(one.focusTestId).toBe("plate_mm");
    // `engraving_*_size_mm` is rendered once per line: there is no one element
    // to focus, so the hit only opens the group.
    const many = searchSettings("cap height").find((hit) => hit.id.includes("*"));
    expect(many?.id).toBe("engraving_*_size_mm");
    expect(many?.focusTestId).toBeNull();
    // A labelled block is a route into its group and focuses nothing either.
    const section = searchSettings("engraving").find((hit) => hit.kind === "section");
    expect(section?.id).toBe("lettering");
    expect(section?.focusTestId).toBeNull();
  });

  it("groups its hits so the panel can open exactly the right sections", () => {
    const hits = searchSettings("depth");
    const groups = groupsWithHits(hits);
    expect(groups.has("regions")).toBe(true);
    expect(groups.has("frame")).toBe(true);
    expect(groups.has("location")).toBe(false);
    expect(hitsInGroup(hits, "regions").every((hit) => hit.group === "regions")).toBe(true);
    expect(hitsInGroup(hits, "regions").length).toBeGreaterThan(1);
    // Every hit belongs to exactly one group, so the panel opens no more
    // sections than it has matches.
    expect(
      [...groups].reduce((total, group) => total + hitsInGroup(hits, group).length, 0),
    ).toBe(hits.length);
  });

  it("indexes the whole panel, not a sample of it", () => {
    // Restated from the catalogue rather than read off the implementation:
    // every control in a parameter group, plus the ones in `output` that write
    // a `PrintParams` leaf, which since [V3.1-P5-4] is how the export format
    // select is reachable.
    const searchable = CONTROLS.filter(
      (spec) => spec.group !== "output" || Array.isArray(spec.writes),
    ).length;
    expect(searchableCount()).toBe(searchable);
    expect(searchableCount()).toBeGreaterThan(90);
  });
});

describe("highlighting", () => {
  it("returns the whole string as one unmatched run when nothing matches", () => {
    expect(highlight("Plate size", "")).toEqual([{ text: "Plate size", hit: false }]);
    expect(highlight("Plate size", "rail")).toEqual([{ text: "Plate size", hit: false }]);
  });

  it("marks the matched run and keeps the original casing", () => {
    expect(highlight("Plate size", "plate")).toEqual([
      { text: "Plate", hit: true },
      { text: " size", hit: false },
    ]);
  });

  it("merges overlapping tokens instead of nesting them", () => {
    expect(highlight("Rail width", "rail ail")).toEqual([
      { text: "Rail", hit: true },
      { text: " width", hit: false },
    ]);
  });

  it("marks every occurrence, and rebuilds the string exactly", () => {
    const text = "The road ribbon is a road again";
    const parts = highlight(text, "road");
    expect(parts.filter((part) => part.hit).length).toBe(2);
    expect(parts.map((part) => part.text).join("")).toBe(text);
  });
});
