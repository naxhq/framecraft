/**
 * The stage registry as a contract (design section 6).
 *
 * Structure: acyclic, every input declared upstream, every claim a real leaf.
 * Coverage: every `PRINT_PARAM_LEAF_PATHS` entry is claimed by some stage,
 * except the exemptions named here with their reasons. Honesty: a strict-claims
 * run on the synthetic scenes reads nothing a stage did not declare. The
 * generated table is plain JSON and is what `docs/handoff/v3-01-pipeline.md`
 * embeds, so the note can never describe a registry that no longer exists.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PRINT_PARAM_LEAF_PATHS, defaultPrintParams, type PrintParams } from "../../contracts";
import { buildModel } from "../engine";
import {
  PARAM_PATHS,
  PHASES,
  STAGES,
  claimedPaths,
  claimsOf,
  consumersOf,
  describeGraph,
  downstreamOf,
  stageIds,
  stageIndex,
  stagesInvalidatedBy,
  stagesReading,
  upstreamOf,
  validateGraph,
} from "./index";
import { blockScene, bridgeScene, railScene, terrainScene } from "./testScenes";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Leaves no pipeline stage claims, each with the reason (DECISIONS
 * [V3.1-P1-2] for the first block).
 */
const EXEMPT_UNCLAIMED: ReadonlyMap<string, string> = new Map([
  // The v1 colour block. A loaded payload that carries `part_colors` and no
  // `colour.region_colors` is migrated into `region_colors` at parse time (the
  // integration wave's job); the engine reads `colour.region_colors` only.
  ["part_colors.base", "v1 colour block, migrated into colour.region_colors at parse time"],
  ["part_colors.frame", "v1 colour block, migrated into colour.region_colors at parse time"],
  ["part_colors.buildings", "v1 colour block, migrated into colour.region_colors at parse time"],
  ["part_colors.roads", "v1 colour block, migrated into colour.region_colors at parse time"],
  ["part_colors.water", "v1 colour block, migrated into colour.region_colors at parse time"],
  ["part_colors.green", "v1 colour block, migrated into colour.region_colors at parse time"],
  ["part_colors.trees", "v1 colour block, migrated into colour.region_colors at parse time"],
  // Measured, not ruled: no stage can read this one, because no stage ever
  // produces an `attribution` region solid (the mandatory marks are cuts into
  // the base and the frame, not an inlay), so `finish-attribution` is always
  // null and never asks for its colour. Its slot IS read, by the audit's
  // slot-beyond-profile rule, which walks every `colour.region_slots.*`.
  // Flagged for a DECISIONS line in docs/handoff/v3-01-pipeline.md: either
  // the field gets a solid to colour or it joins the exemptions.
  ["colour.region_colors.attribution", "no attribution region solid exists for the colour to apply to"],
]);

/**
 * The two design exemptions that ARE claimed: `schema_version` and
 * `colour.preview_theme` are read by the export stage for the sidecar echo,
 * which is the whole of their file effect. They are exempt from the MATRIX
 * (no geometry moves), not from the registry.
 */
const EXEMPT_CLAIMED_BY_EXPORT_ONLY = ["schema_version", "colour.preview_theme"] as const;

describe("the stage graph: structure", () => {
  it("validates: unique kebab-case ids, phases in order, every input declared before its consumer", () => {
    expect(() => validateGraph()).not.toThrow();
    const ids = stageIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const stage of STAGES) {
      for (const input of stage.inputs) expect(stageIndex(input)).toBeLessThan(stageIndex(stage.id));
    }
  });

  it("is acyclic: no stage is downstream of itself through any path", () => {
    for (const stage of STAGES) {
      const below = downstreamOf(consumersOf(stage.id));
      expect(below).not.toContain(stage.id);
      const above = upstreamOf(stage.inputs);
      expect(above).not.toContain(stage.id);
    }
  });

  it("has the binding ids, in the phases the design assigns", () => {
    const phaseOf = new Map(STAGES.map((stage) => [stage.id, stage.phase]));
    expect(phaseOf.get("fetch")).toBe("scene");
    expect(phaseOf.get("normalise")).toBe("scene");
    for (const id of ["context", "terrain", "heroes", "repair-buildings", "surface-water", "surface-rail", "surface-roads", "surface-parks", "buildings", "bridges", "trees", "tokens", "fonts", "lettering", "ornaments", "attribution", "hangers", "frame-cutters", "base", "frame"] as const) {
      expect(phaseOf.get(id), id).toBe("geometry");
    }
    expect(phaseOf.get("sit")).toBe("region");
    expect(phaseOf.get("region-base")).toBe("region");
    expect(phaseOf.get("finish-buildings_band_8")).toBe("region");
    for (const id of ["assembly", "merged", "measure", "validate", "islands", "tiling", "audit"] as const) expect(phaseOf.get(id), id).toBe("audit");
    expect(phaseOf.get("export")).toBe("export");
    // Two-phase delivery: every finish stage comes before the first audit stage.
    const firstAudit = STAGES.findIndex((stage) => stage.phase === "audit");
    for (const stage of STAGES) {
      if (stage.id.startsWith("finish-")) expect(stageIndex(stage.id)).toBeLessThan(firstAudit);
    }
    expect(PHASES).toEqual(["scene", "geometry", "region", "audit", "export"]);
  });
});

describe("the stage graph: claims against the contract", () => {
  it("every claimed path is a PrintParams leaf", () => {
    const leaves = new Set<string>(PRINT_PARAM_LEAF_PATHS);
    for (const stage of STAGES) {
      for (const path of claimsOf(stage.id)) expect(leaves.has(path), `${stage.id} claims ${path}`).toBe(true);
    }
    expect(PARAM_PATHS).toEqual(PRINT_PARAM_LEAF_PATHS);
  });

  it("every leaf is claimed by at least one stage, except the named exemptions", () => {
    const claimed = claimedPaths();
    const unclaimed = PRINT_PARAM_LEAF_PATHS.filter((path) => !claimed.has(path));
    expect([...unclaimed].sort()).toEqual([...EXEMPT_UNCLAIMED.keys()].sort());
    for (const path of EXEMPT_UNCLAIMED.keys()) expect(EXEMPT_UNCLAIMED.get(path)).toBeTruthy();
    for (const path of EXEMPT_CLAIMED_BY_EXPORT_ONLY) expect(stagesReading(path)).toEqual(["export"]);
  });

  it("every stage that claims a parameter is upstream of export, so the sidecar echo can never go stale", () => {
    const feeding = new Set(upstreamOf(["export"]));
    for (const stage of STAGES) {
      if (claimsOf(stage.id).length > 0) expect(feeding.has(stage.id), stage.id).toBe(true);
    }
  });

  it("answers what a change moves: a lettering text moves the frame and the base but not the buildings; the plate moves everything under the context", () => {
    const text = stagesInvalidatedBy(["engravings[].text"]);
    expect(text).toContain("lettering");
    expect(text).toContain("frame");
    expect(text).toContain("finish-frame");
    expect(text).toContain("audit");
    expect(text).not.toContain("repair-buildings");
    expect(text).not.toContain("buildings");
    expect(text).not.toContain("surface-roads");
    const plate = stagesInvalidatedBy(["plate_mm"]);
    expect(plate).toContain("context");
    expect(plate).not.toContain("normalise");
    expect(plate).not.toContain("fetch");
    const heights = stagesInvalidatedBy(["heights.floor_height_m"]);
    expect(heights[0]).toBe("normalise");
    expect(heights).toContain("export");
  });
});

describe("the stage graph: describeGraph()", () => {
  it("is plain JSON: strings and arrays only, one row per stage in registry order", () => {
    const described = describeGraph();
    expect(JSON.parse(JSON.stringify(described))).toEqual(described);
    expect(described.stages.map((stage) => stage.id)).toEqual(stageIds());
    for (const stage of described.stages) {
      for (const param of stage.params) expect(typeof param).toBe("string");
    }
    expect(described.stages.find((stage) => stage.id === "context")?.params).toContain("frame_style.profile=floating");
  });

  it("is the table docs/handoff/v3-01-pipeline.md embeds", () => {
    const note = readFileSync(resolve(here, "../../../../../docs/handoff/v3-01-pipeline.md"), "utf-8");
    const start = note.indexOf("```json describeGraph");
    expect(start, "the note has no ```json describeGraph block").toBeGreaterThan(-1);
    const bodyStart = note.indexOf("\n", start) + 1;
    const end = note.indexOf("\n```", bodyStart);
    const embedded = JSON.parse(note.slice(bodyStart, end)) as unknown;
    expect(embedded).toEqual(describeGraph());
  });
});

describe("the stage graph: strict claims", () => {
  const styled: PrintParams = {
    ...defaultPrintParams(),
    frame_style: {
      profile: "ogee",
      corner: "rounded",
      corner_radius_mm: 4,
      lip_depth_mm: 0.6,
      shadow_gap: { enabled: true, width_mm: 1.2, depth_mm: 0.7 },
      matting: { enabled: true, width_mm: 5, proud_mm: 0.3 },
      separate: { enabled: true, mount: "magnet", tolerance_mm: 0.25 },
      texture: { pattern: "knurl", scale_mm: 1.2, depth_mm: 0.25 },
    },
    engravings: [
      { edge: "top", text: "{city}", mode: "engrave", size_mm: 4 },
      { edge: "left", text: "AB", mode: "inlay", size_mm: 5 },
      { edge: "underside", text: "{date}", mode: "engrave", size_mm: 3 },
    ],
    north_arrow: { enabled: true, corner: "ne", size_mm: 7 },
    scale_bar: { enabled: true, edge: "bottom", length_mode: "fixed", length_m: 150 },
    underside_mark: { enabled: true, template: "{city} {date}" },
    hanger: "magnets",
    tiling: { enabled: true, cols: 2, rows: 1, joint: "pin", tolerance_mm: 0.15, index_mark: true },
    city_label: "Blocktown",
    place: { country: "Nowhere", state: "None", neighbourhood: "Centre", author: "A. Tester" },
    hero_building_ids: ["b-tall"],
    hero_auto: { enabled: true, count: 1 },
  };

  it("no stage reads a parameter it did not claim, on every synthetic scene at the defaults and on a fully styled build", async () => {
    for (const scene of [blockScene(), railScene(), bridgeScene()]) {
      const result = await buildModel({ scene, params: defaultPrintParams(), date: "2026-09-02" }, { strictClaims: true });
      expect(result.regions.length).toBeGreaterThan(0);
    }
    const hill = terrainScene();
    const draped = await buildModel({ scene: hill.scene, params: { ...defaultPrintParams(), terrain: { enabled: true, smoothing: 2 } }, terrain: hill.grid, date: "2026-09-02" }, { strictClaims: true });
    expect(draped.stats.terrainReliefMm).toBeDefined();
    const dressed = await buildModel({ scene: blockScene(), params: styled, date: "2026-09-02", rotationDeg: 15 }, { strictClaims: true });
    expect(dressed.regions.some((region) => region.region === "matting")).toBe(true);
  }, 120_000);
});
