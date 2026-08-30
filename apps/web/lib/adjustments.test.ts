/**
 * The chip's arithmetic and the drawer's grouping.
 *
 * What matters here is the SPLIT: a warning that disables Bake must never end
 * up inside a collapsed drawer, and everything that does not disable Bake must
 * never stack up as another line of orange text beside the model.
 */

import { describe, expect, it } from "vitest";

import {
  ADJUSTMENT_GROUP_ORDER,
  adjustmentsLabel,
  blockingWarnings,
  collectAdjustments,
  groupAdjustments,
  informationalWarnings,
  type AdjustmentSources,
} from "./adjustments";
import type { SceneWarning } from "./warnings";

const COVERAGE_BLOCK: SceneWarning = {
  id: "coverage-empty",
  level: "block",
  message: "Fewer than 20 buildings here (3) — enlarge the radius or move the pin.",
};

const TOO_TALL: SceneWarning = {
  id: "model-too-tall",
  level: "block",
  message: "Model would be 66.5 mm tall (limit 60 mm) — lower the building scales",
};

const SPARSE: SceneWarning = {
  id: "coverage-sparse",
  level: "warn",
  message: "Low building coverage: 34 buildings; consider a larger radius.",
};

const ESTIMATED: SceneWarning = {
  id: "estimated-heights",
  level: "warn",
  message: "Building heights are largely estimated from OSM tags (only 11% ...).",
};

const EMPTY: AdjustmentSources = {
  warnings: [],
  dilatedNote: null,
  droppedCount: 0,
  treeFloorMetres: null,
  nozzleMm: 0.4,
  bakeWarnings: [],
};

describe("the blocking / informational split", () => {
  it("keeps every block-level warning out of the chip", () => {
    const warnings = [COVERAGE_BLOCK, SPARSE, TOO_TALL, ESTIMATED];
    expect(blockingWarnings(warnings).map((w) => w.id)).toEqual([
      "coverage-empty",
      "model-too-tall",
    ]);
    expect(informationalWarnings(warnings).map((w) => w.id)).toEqual([
      "coverage-sparse",
      "estimated-heights",
    ]);
    // ...and the chip really does not carry them.
    const ids = collectAdjustments({ ...EMPTY, warnings }).map((item) => item.id);
    expect(ids).not.toContain("coverage-empty");
    expect(ids).not.toContain("model-too-tall");
  });
});

describe("collectAdjustments", () => {
  it("reports nothing for a clean scene", () => {
    expect(collectAdjustments(EMPTY)).toEqual([]);
    // ...which is what makes the chip disappear rather than read "0 made".
  });

  it("counts every kind of adjustment exactly once", () => {
    const adjustments = collectAdjustments({
      warnings: [SPARSE, ESTIMATED, COVERAGE_BLOCK],
      dilatedNote: "335 widened to the 6.9 m minimum wall",
      droppedCount: 12,
      treeFloorMetres: 9.3,
      nozzleMm: 0.8,
      bakeWarnings: ["2 self-intersections repaired", "roads clipped to the plate"],
    });
    // 2 informational warnings + widened + dropped + trees + 2 bake = 7.
    expect(adjustments).toHaveLength(7);
    expect(adjustmentsLabel(adjustments.length)).toBe("7 adjustments made");
  });

  it("says 'adjustment' in the singular", () => {
    expect(adjustmentsLabel(1)).toBe("1 adjustment made");
    expect(adjustmentsLabel(2)).toBe("2 adjustments made");
  });

  it("keeps the widened sentence the preview owns, capitalised", () => {
    const [item] = collectAdjustments({
      ...EMPTY,
      dilatedNote: "335 widened to the 6.9 m minimum wall",
    });
    expect(item.id).toBe("footprints-widened");
    expect(item.group).toBe("repair");
    // The metres come from `preview.dilatedNotice`, never re-derived here.
    expect(item.message).toBe("335 widened to the 6.9 m minimum wall.");
  });

  it("pluralises the dropped footprints", () => {
    const one = collectAdjustments({ ...EMPTY, droppedCount: 1 })[0];
    const many = collectAdjustments({ ...EMPTY, droppedCount: 9 })[0];
    expect(one.message).toContain("1 footprint dropped");
    expect(many.message).toContain("9 footprints dropped");
  });

  it("names the nozzle in the tree-floor line", () => {
    const [item] = collectAdjustments({
      ...EMPTY,
      nozzleMm: 0.8,
      treeFloorMetres: 9.34,
    });
    expect(item.id).toBe("trees-below-nozzle");
    expect(item.message).toBe(
      "A 0.8 mm nozzle drops trees under 9.3 m of site radius.",
    );
  });

  it("marks the bake's own remarks as warnings, with stable ids", () => {
    const items = collectAdjustments({
      ...EMPTY,
      bakeWarnings: ["a", "b"],
    });
    expect(items.map((item) => item.id)).toEqual(["bake-0", "bake-1"]);
    expect(items.every((item) => item.tone === "warn")).toBe(true);
  });
});

describe("groupAdjustments", () => {
  it("orders the sections and drops the empty ones", () => {
    const sections = groupAdjustments(
      collectAdjustments({
        ...EMPTY,
        warnings: [SPARSE],
        droppedCount: 3,
      }),
    );
    expect(sections.map((section) => section.group)).toEqual(["site", "repair"]);
    expect(sections[0].items).toHaveLength(1);
    expect(sections[1].items).toHaveLength(1);
  });

  it("puts every item in exactly one section", () => {
    const adjustments = collectAdjustments({
      warnings: [SPARSE, ESTIMATED],
      dilatedNote: "3 widened to the 1.0 m minimum wall",
      droppedCount: 2,
      treeFloorMetres: 5,
      nozzleMm: 0.6,
      bakeWarnings: ["x"],
    });
    const sections = groupAdjustments(adjustments);
    const total = sections.reduce((sum, section) => sum + section.items.length, 0);
    expect(total).toBe(adjustments.length);
    for (const section of sections) {
      expect(ADJUSTMENT_GROUP_ORDER).toContain(section.group);
      expect(section.title.length).toBeGreaterThan(0);
    }
  });

  it("returns nothing at all when there is nothing to say", () => {
    expect(groupAdjustments([])).toEqual([]);
  });
});

// ==========================================================================
// Frame lettering ([V2-P6])
// ==========================================================================

describe("lettering notices", () => {
  const base = {
    warnings: [],
    dilatedNote: null,
    droppedCount: 0,
    treeFloorMetres: null,
    nozzleMm: 0.4,
    bakeWarnings: [],
  };

  it("files them under `Made printable`, which is what they are", () => {
    const items = collectAdjustments({
      ...base,
      textNotices: [
        "the top engraving was reduced from 8 mm to 5.16 mm to fit the 6 mm lip band",
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0].group).toBe("repair");
    expect(items[0].id).toBe("lettering-0");
    expect(items[0].tone).toBe("info");
  });

  it("gives a clause the sentence case a bullet needs, without rewording it", () => {
    const [item] = collectAdjustments({
      ...base,
      textNotices: ["engraving 1 (top) was not cut: it needs 5.20 mm"],
    });
    // The shared math's own words, verbatim apart from the capital and the
    // stop: a user who reads this here and again in the bake output must be
    // reading one sentence twice, not two.
    expect(item.message).toBe("Engraving 1 (top) was not cut: it needs 5.20 mm.");
  });

  it("does not double the full stop on a message that already has one", () => {
    const [item] = collectAdjustments({ ...base, textNotices: ["Already a sentence."] });
    expect(item.message).toBe("Already a sentence.");
  });

  it("is optional, so nothing changes for a model with no lettering", () => {
    expect(collectAdjustments(base)).toEqual([]);
    expect(collectAdjustments({ ...base, textNotices: [] })).toEqual([]);
  });

  it("counts into the chip and sits under the repair heading in the drawer", () => {
    const items = collectAdjustments({
      ...base,
      dilatedNote: "3 widened to the 18.9 m minimum wall",
      textNotices: ["the north arrow was skipped", "the scale bar was skipped"],
    });
    expect(adjustmentsLabel(items.length)).toBe("3 adjustments made");
    const sections = groupAdjustments(items);
    expect(sections).toHaveLength(1);
    expect(sections[0].group).toBe("repair");
    expect(sections[0].items).toHaveLength(3);
  });
});
