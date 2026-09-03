/**
 * The editor's half of a per-object override (v3.1 Task 11).
 *
 * The engine's half is pinned in `lib/engine/solid/overrides.test.ts`. What is
 * pinned HERE is the edit path the right-click inspector drives, and the one
 * claim the whole feature rests on: a row this module writes carries the
 * CONTRACT's own defaults, member for member. That is not a formality --
 * `emptyOverride` has to write them out, because the contract's default for
 * `object_overrides` is an empty list and there is no example row to copy, so
 * the only thing standing between this file and a silent drift from the schema
 * is the assertion below, which reads the schema itself.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_PRINT_PARAMS, PARAM_LIMITS, type ObjectOverride, type PrintParams, type SceneGraph } from "./contracts";
import {
  OVERRIDE_MAX_ITEMS,
  actionsForLayer,
  describeOverride,
  emptyOverride,
  findOverride,
  isNeutralOverride,
  isOverrideInactive,
  jumpsForRegion,
  overrideLayerByRegion,
  overrideStatus,
  regionHeading,
  withOverride,
  withoutOverride,
} from "./objectOverrides";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(
  readFileSync(resolve(here, "../../../packages/contracts/schema/print_params.json"), "utf-8"),
) as {
  $defs: { ObjectOverride: { properties: Record<string, { default?: unknown }> } };
};

function params(rows: ObjectOverride[]): PrintParams {
  return { ...DEFAULT_PRINT_PARAMS, object_overrides: rows };
}

describe("emptyOverride", () => {
  it("carries the contract's own default for every member it writes", () => {
    const row = emptyOverride("w1", "building");
    const schema = SCHEMA.$defs.ObjectOverride.properties;
    for (const [key, spec] of Object.entries(schema)) {
      if (key === "osm_id" || key === "layer") continue;
      expect(spec.default, `${key} has no schema default to compare against`).toBeDefined();
      expect(row[key as keyof ObjectOverride], key).toEqual(spec.default);
    }
    expect(row.osm_id).toBe("w1");
    expect(row.layer).toBe("building");
  });

  it("asks for nothing, so writing it and leaving it is not a change", () => {
    expect(isNeutralOverride(emptyOverride("w1", "road"))).toBe(true);
  });

  it("reads the array cap off the contract", () => {
    expect(OVERRIDE_MAX_ITEMS).toBe(PARAM_LIMITS.object_overrides.max_items);
  });
});

describe("withOverride", () => {
  it("appends a row for an object that has none", () => {
    const result = withOverride(params([]), "w1", "building", { hidden: true });
    expect(result.capped).toBe(false);
    expect(result.overrides).toEqual([{ ...emptyOverride("w1", "building"), hidden: true }]);
  });

  it("replaces a row IN PLACE, so the override_N a group holds does not move", () => {
    const first = { ...emptyOverride("w1", "building"), slot: 2 };
    const second = { ...emptyOverride("w2", "building"), slot: 3 };
    const result = withOverride(params([first, second]), "w1", "building", { hidden: true });
    expect(result.overrides.map((row) => row.osm_id)).toEqual(["w1", "w2"]);
    expect(result.overrides[0].hidden).toBe(true);
    expect(result.overrides[0].slot).toBe(2);
  });

  it("removes a row that has been put back the way it was", () => {
    const rows = [{ ...emptyOverride("w1", "building"), height_scale: 2 }];
    expect(withOverride(params(rows), "w1", "building", { height_scale: 1 }).overrides).toEqual([]);
  });

  it("keys a row by layer as well as id, so a road and a building never collide", () => {
    const rows = [{ ...emptyOverride("w1", "road"), hidden: true }];
    const result = withOverride(params(rows), "w1", "building", { hidden: true });
    expect(result.overrides).toHaveLength(2);
    expect(findOverride(params(result.overrides), "w1", "building")?.hidden).toBe(true);
    expect(findOverride(params(result.overrides), "w1", "road")?.hidden).toBe(true);
  });

  it("refuses a NEW row at the cap and changes nothing", () => {
    const full = Array.from({ length: OVERRIDE_MAX_ITEMS }, (_, index) => ({
      ...emptyOverride(`w${index}`, "building"),
      hidden: true,
    }));
    const result = withOverride(params(full), "wNew", "building", { hidden: true });
    expect(result.capped).toBe(true);
    expect(result.overrides).toHaveLength(OVERRIDE_MAX_ITEMS);
    // ...but an object that already has a row is still editable at the cap.
    expect(withOverride(params(full), "w0", "building", { height_scale: 2 }).capped).toBe(false);
  });

  it("withoutOverride drops exactly one object's row", () => {
    const rows = [
      { ...emptyOverride("w1", "building"), hidden: true },
      { ...emptyOverride("w2", "building"), hidden: true },
    ];
    expect(withoutOverride(params(rows), "w1", "building").map((row) => row.osm_id)).toEqual(["w2"]);
  });
});

describe("what the inspector offers", () => {
  it("offers a layer only what that layer can act on", () => {
    expect(actionsForLayer("building")).toContain("height_scale");
    expect(actionsForLayer("building")).not.toContain("width_scale");
    expect(actionsForLayer("road")).toContain("road_mode");
    expect(actionsForLayer("road")).not.toContain("height_scale");
    expect(actionsForLayer("green")).toContain("raise_mm");
    expect(actionsForLayer("green")).not.toContain("road_mode");
    // Every layer can be left out and put back.
    for (const layer of ["building", "road", "water", "green"] as const) {
      expect(actionsForLayer(layer)).toContain("hide");
      expect(actionsForLayer(layer)).toContain("reset");
    }
  });

  it("sends a right-click on a region that is not an OSM object into the settings", () => {
    expect(jumpsForRegion("frame").map((jump) => jump.groupId)).toContain("frame");
    expect(jumpsForRegion("rail").map((jump) => jump.groupId)).toContain("regions");
    expect(regionHeading("matting")).toBe("Matting");
    expect(regionHeading(null)).toBe("The plate");
  });

  it("says in words what a row currently asks for", () => {
    expect(describeOverride(emptyOverride("w1", "building"))).toBe("Nothing changed");
    const row = { ...emptyOverride("w1", "building"), hidden: true, height_scale: 1.5, slot: 3 };
    expect(describeOverride(row)).toBe("Hidden, height 1.5x, slot 3");
  });
});

describe("reconciliation against a scene", () => {
  const scene = {
    bounds: { min_x: -10, min_y: -10, max_x: 10, max_y: 10 },
    buildings: [{ id: "w1", height_m: 10, height_source: "tag", ring: [], holes: [] }],
    roads: [],
    water: [],
    green: [],
  } as unknown as SceneGraph;

  it("keeps a row this scene cannot reach, and marks it inactive", () => {
    const rows = [
      { ...emptyOverride("w1", "building"), hidden: true },
      { ...emptyOverride("w404", "building"), hidden: true },
    ];
    const status = overrideStatus(scene, params(rows));
    expect(status.active.map((row) => row.osm_id)).toEqual(["w1"]);
    expect(status.inactive.map((row) => row.osm_id)).toEqual(["w404"]);
    expect(isOverrideInactive(scene, params(rows), "w404", "building")).toBe(true);
    expect(isOverrideInactive(scene, params(rows), "w1", "building")).toBe(false);
  });

  it("treats every row as unreachable before a scene has landed", () => {
    const rows = [{ ...emptyOverride("w1", "building"), hidden: true }];
    expect(overrideStatus(null, params(rows)).inactive).toHaveLength(1);
  });
});

describe("overrideLayerByRegion", () => {
  it("names the layer each override region's group came out of", () => {
    const rows = [
      { ...emptyOverride("w1", "building"), slot: 3 },
      { ...emptyOverride("w2", "road"), slot: 4 },
    ];
    const map = overrideLayerByRegion(params(rows));
    expect(map.get("override_1")).toBe("building");
    expect(map.get("override_2")).toBe("road");
    expect(map.get("override_3")).toBeUndefined();
  });
});
