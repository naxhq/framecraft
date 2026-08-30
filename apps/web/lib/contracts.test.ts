/**
 * The GENERATED TS contracts must agree with the GENERATED Pydantic ones.
 *
 * `fixtures/print-params-default.json` is `PrintParams().model_dump(mode="json")`,
 * written by `services/bake/tests/test_contracts.py`. Comparing
 * DEFAULT_PRINT_PARAMS against it means the editor's starting state and the
 * server's "no parameters supplied" state are the same object in both
 * languages - which is what makes the v1-compatibility guarantee in
 * `services/bake/tests/test_v1_compat.py` mean anything on the web side.
 *
 * Regenerate the fixture with:
 *   cd services/bake && FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_contracts.py
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRINT_PARAMS,
  PARAM_LIMITS,
  PARAM_RANGES,
  defaultPrintParams,
} from "./contracts";
import type { PrintParams } from "./contracts";

function loadFixture<T>(relative: string): T {
  const url = new URL(`../../../fixtures/${relative}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf-8")) as T;
}

const pythonDefaults = loadFixture<Record<string, unknown>>("print-params-default.json");

describe("DEFAULT_PRINT_PARAMS", () => {
  it("equals PrintParams() on the Python side, key for key", () => {
    expect(DEFAULT_PRINT_PARAMS as unknown as Record<string, unknown>).toEqual(pythonDefaults);
  });

  it("declares schema_version 2", () => {
    expect(DEFAULT_PRINT_PARAMS.schema_version).toBe(2);
  });

  it("keeps every v1 field at its v1 default", () => {
    // A v1 client sent exactly these eleven keys and nothing else; they are
    // what test_v1_compat.py proves still bakes the v1 geometry.
    expect({
      plate_mm: DEFAULT_PRINT_PARAMS.plate_mm,
      base_thickness_mm: DEFAULT_PRINT_PARAMS.base_thickness_mm,
      nozzle_mm: DEFAULT_PRINT_PARAMS.nozzle_mm,
      small_scale: DEFAULT_PRINT_PARAMS.small_scale,
      large_scale: DEFAULT_PRINT_PARAMS.large_scale,
      terrain_exaggeration: DEFAULT_PRINT_PARAMS.terrain_exaggeration,
      road_mode: DEFAULT_PRINT_PARAMS.road_mode,
      road_scale: DEFAULT_PRINT_PARAMS.road_scale,
      trees: DEFAULT_PRINT_PARAMS.trees,
      water: DEFAULT_PRINT_PARAMS.water,
      frame: DEFAULT_PRINT_PARAMS.frame,
    }).toEqual({
      plate_mm: 180,
      base_thickness_mm: 3.0,
      nozzle_mm: 0.4,
      small_scale: 1.0,
      large_scale: 1.0,
      terrain_exaggeration: 1.0,
      road_mode: "engrave",
      road_scale: 1.0,
      trees: true,
      water: true,
      frame: true,
    });
  });

  it("starts every v2 feature switched off, so a default bake is a v1 bake", () => {
    expect(DEFAULT_PRINT_PARAMS.color_mode).toBe("single");
    expect(DEFAULT_PRINT_PARAMS.city_label).toBe("");
    expect(DEFAULT_PRINT_PARAMS.engravings).toEqual([]);
    expect(DEFAULT_PRINT_PARAMS.north_arrow?.enabled).toBe(false);
    expect(DEFAULT_PRINT_PARAMS.scale_bar?.enabled).toBe(false);
    expect(DEFAULT_PRINT_PARAMS.underside_mark?.enabled).toBe(false);
    expect(DEFAULT_PRINT_PARAMS.hanger).toBe("none");
    expect(DEFAULT_PRINT_PARAMS.hero_building_ids).toEqual([]);
  });

  it("gives the default palette four distinct filaments", () => {
    // base+buildings, roads+frame, water, green+trees: a four-slot AMS prints
    // the default scene with no re-assignment (DECISIONS [V2-P2]).
    const colors = DEFAULT_PRINT_PARAMS.part_colors!;
    expect(colors.base).toBe(colors.buildings);
    expect(colors.roads).toBe(colors.frame);
    expect(colors.green).toBe(colors.trees);
    expect(new Set([colors.base, colors.roads, colors.water, colors.green]).size).toBe(4);
  });

  it("is a legal PrintParams without a cast", () => {
    const params: PrintParams = { ...DEFAULT_PRINT_PARAMS };
    expect(params.plate_mm).toBe(180);
  });
});

/**
 * The six keys whose default is an object or an array. A shallow copy of the
 * constant aliases all six, which is the hazard the freeze and the factory
 * exist to close; the last case here fails if a later contract adds a seventh.
 */
const NESTED_KEYS = [
  "part_colors",
  "engravings",
  "north_arrow",
  "scale_bar",
  "underside_mark",
  "hero_building_ids",
] as const;

function walk(value: unknown, path: string, out: string[]): void {
  if (value === null || typeof value !== "object") return;
  out.push(path);
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    walk(inner, `${path}.${key}`, out);
  }
}

function objectPaths(value: unknown): string[] {
  const out: string[] = [];
  walk(value, "$", out);
  return out;
}

describe("DEFAULT_PRINT_PARAMS is immutable", () => {
  it("names every object-valued key", () => {
    const found = Object.entries(DEFAULT_PRINT_PARAMS)
      .filter(([, value]) => value !== null && typeof value === "object")
      .map(([key]) => key);
    expect(found.sort()).toEqual([...NESTED_KEYS].sort());
  });

  it("is frozen, and so is every object reachable from it", () => {
    const paths = objectPaths(DEFAULT_PRINT_PARAMS);
    // Non-vacuity: the root plus all six nested values, by name.
    expect(paths.sort()).toEqual(
      ["$", ...NESTED_KEYS.map((key) => `$.${key}`)].sort(),
    );
    for (const path of paths) {
      const node = path
        .split(".")
        .slice(1)
        .reduce<unknown>((cursor, key) => (cursor as Record<string, unknown>)[key], DEFAULT_PRINT_PARAMS);
      expect(Object.isFrozen(node), path).toBe(true);
    }
  });

  it("throws on a nested write instead of corrupting the shared default", () => {
    // The exact leak the audit reproduced: a shallow copy aliases the nested
    // objects, so `copy.part_colors.base = ...` used to edit the default itself
    // and every later resetParams() "reset" to the corruption.
    const shallow = { ...DEFAULT_PRINT_PARAMS };
    expect(() => {
      shallow.part_colors!.base = "#000000";
    }).toThrow(TypeError);
    expect(() => {
      shallow.engravings!.push({ edge: "top", text: "leak" });
    }).toThrow(TypeError);
    expect(() => {
      shallow.hero_building_ids!.push("w1");
    }).toThrow(TypeError);
    expect(DEFAULT_PRINT_PARAMS.part_colors!.base).toBe("#D8D3C6");
    expect(DEFAULT_PRINT_PARAMS.engravings).toEqual([]);
    expect(DEFAULT_PRINT_PARAMS.hero_building_ids).toEqual([]);
  });
});

describe("defaultPrintParams()", () => {
  it("deep-equals the constant", () => {
    expect(defaultPrintParams()).toEqual(DEFAULT_PRINT_PARAMS);
  });

  it("shares no nested object with the constant", () => {
    const fresh = defaultPrintParams();
    expect(fresh).not.toBe(DEFAULT_PRINT_PARAMS);
    for (const key of NESTED_KEYS) {
      expect(fresh[key], key).not.toBe(DEFAULT_PRINT_PARAMS[key]);
    }
  });

  it("shares no nested object between two calls", () => {
    const a = defaultPrintParams();
    const b = defaultPrintParams();
    for (const key of NESTED_KEYS) {
      expect(a[key], key).not.toBe(b[key]);
    }
    a.part_colors!.base = "#000000";
    a.engravings!.push({ edge: "top", text: "mine" });
    expect(b.part_colors!.base).toBe("#D8D3C6");
    expect(b.engravings).toEqual([]);
    expect(DEFAULT_PRINT_PARAMS.part_colors!.base).toBe("#D8D3C6");
    expect(DEFAULT_PRINT_PARAMS.engravings).toEqual([]);
  });

  it("returns a copy that is not frozen at any depth", () => {
    const fresh = defaultPrintParams();
    for (const path of objectPaths(fresh)) {
      const node = path
        .split(".")
        .slice(1)
        .reduce<unknown>((cursor, key) => (cursor as Record<string, unknown>)[key], fresh);
      expect(Object.isFrozen(node), path).toBe(false);
    }
  });
});

describe("PARAM_LIMITS", () => {
  it("publishes the array caps the schema declares", () => {
    expect(PARAM_LIMITS.engravings.max_items).toBe(8);
    expect(PARAM_LIMITS.hero_building_ids.max_items).toBe(12);
  });

  it("publishes the 64-character text caps", () => {
    expect(PARAM_LIMITS.city_label.max_length).toBe(64);
    expect(PARAM_LIMITS.engravings.text.max_length).toBe(64);
    expect(PARAM_LIMITS.underside_mark.template.max_length).toBe(64);
  });

  it("covers every capped field in the contract, and nothing else", () => {
    expect(Object.keys(PARAM_LIMITS)).toEqual([
      "city_label",
      "engravings",
      "underside_mark",
      "hero_building_ids",
    ]);
  });

  it("agrees with the defaults it caps", () => {
    // A default that exceeded its own cap would be un-sendable.
    expect(DEFAULT_PRINT_PARAMS.city_label!.length).toBeLessThanOrEqual(
      PARAM_LIMITS.city_label.max_length,
    );
    expect(DEFAULT_PRINT_PARAMS.underside_mark!.template!.length).toBeLessThanOrEqual(
      PARAM_LIMITS.underside_mark.template.max_length,
    );
    expect(DEFAULT_PRINT_PARAMS.engravings!.length).toBeLessThanOrEqual(
      PARAM_LIMITS.engravings.max_items,
    );
  });
});

describe("PARAM_RANGES", () => {
  it("keeps the v1 slider ranges", () => {
    expect(PARAM_RANGES.plate_mm).toEqual({ min: 100, max: 256, default: 180 });
    expect(PARAM_RANGES.nozzle_mm).toEqual({ min: 0.1, max: 1.2, default: 0.4 });
  });

  it("exposes the nested v2 ranges as groups", () => {
    // 4.0, raised from 3.0 this run: at 3.0 the default face refuses six of the
    // eight strings a user actually types, measured face by face and string by
    // string in docs/handoff/v2-03-lettering.md (v2-03 audit, finding 4).
    expect(PARAM_RANGES.engravings.size_mm).toEqual({ min: 1.5, max: 8.0, default: 4.0 });
    expect(PARAM_RANGES.engravings.depth_mm).toEqual({ min: 0.2, max: 1.5, default: 0.4 });
    expect(PARAM_RANGES.north_arrow.size_mm).toEqual({ min: 2.0, max: 6.0, default: 4.0 });
    expect(PARAM_RANGES.scale_bar.length_m).toEqual({ min: 10, max: 5000, default: 500 });
  });

  it("agrees with the defaults it publishes", () => {
    expect(PARAM_RANGES.north_arrow.size_mm.default).toBe(
      DEFAULT_PRINT_PARAMS.north_arrow?.size_mm,
    );
    expect(PARAM_RANGES.scale_bar.length_m.default).toBe(DEFAULT_PRINT_PARAMS.scale_bar?.length_m);
  });
});
