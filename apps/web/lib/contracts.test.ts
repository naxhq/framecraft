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

  it("declares schema_version 3", () => {
    expect(DEFAULT_PRINT_PARAMS.schema_version).toBe(3);
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

  it("starts every v3 engine feature switched off, so a default bake is still a v1 bake", () => {
    // bridges.enabled defaults true - it is a structural fallback (drape onto
    // abutments instead of the terrain) that only matters once terrain is on,
    // not a personalisation toggle, so it is not part of this "off" claim.
    expect(DEFAULT_PRINT_PARAMS.terrain?.enabled).toBe(false);
    expect(DEFAULT_PRINT_PARAMS.hero_auto?.enabled).toBe(false);
    expect(DEFAULT_PRINT_PARAMS.tiling?.enabled).toBe(false);
    expect(DEFAULT_PRINT_PARAMS.colour?.tint?.enabled).toBe(false);
    expect(DEFAULT_PRINT_PARAMS.colour?.gradient?.enabled).toBe(false);
    expect(DEFAULT_PRINT_PARAMS.frame_style?.shadow_gap?.enabled).toBe(false);
    expect(DEFAULT_PRINT_PARAMS.frame_style?.matting?.enabled).toBe(false);
    expect(DEFAULT_PRINT_PARAMS.frame_style?.separate?.enabled).toBe(false);
    expect(DEFAULT_PRINT_PARAMS.frame_style?.profile).toBe("plain");
    expect(DEFAULT_PRINT_PARAMS.frame_style?.texture?.pattern).toBe("none");
    expect(DEFAULT_PRINT_PARAMS.printer_profile).toBe("custom");
    expect(DEFAULT_PRINT_PARAMS.export_target).toBe("bambu-3mf");
    expect(DEFAULT_PRINT_PARAMS.colour?.palette).toBe("default");
    expect(DEFAULT_PRINT_PARAMS.place).toEqual({
      country: "",
      state: "",
      neighbourhood: "",
      author: "",
    });
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
 * Every key whose default is an object or an array (six from schema_version 2,
 * twelve more from schema_version 3: printer_profile and export_target are
 * plain string enums and stay out of this list). A shallow copy of the
 * constant aliases every one of these, which is the hazard the freeze and the
 * factory exist to close; the "names every object-valued key" case below
 * fails if a later contract adds one this list does not know about.
 */
const NESTED_KEYS = [
  "part_colors",
  "engravings",
  "north_arrow",
  "scale_bar",
  "underside_mark",
  "hero_building_ids",
  "place",
  "regions",
  "colour",
  "custom_profile",
  "terrain",
  "heights",
  "bridges",
  "height_exaggeration",
  "hero_auto",
  "tiling",
  "frame_style",
  "hanger_magnet",
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

/**
 * Every path `objectPaths` finds inside DEFAULT_PRINT_PARAMS: the root, each
 * of NESTED_KEYS, and - because `walk` descends recursively - every object or
 * non-empty array nested a level deeper still: regions' four per-region
 * blocks, colour's four sub-blocks plus its one non-empty array default
 * (gradient.slots: [2, 3]), heights' one sub-block, and frame_style's four
 * sub-blocks. Spelled out in full so the "is frozen" test below is a real
 * pin, not an approximation, and fails the moment a later contract adds
 * another level nobody taught this list about.
 */
const ALL_OBJECT_PATHS = [
  "$",
  ...NESTED_KEYS.map((key) => `$.${key}`),
  "$.regions.roads",
  "$.regions.water",
  "$.regions.parks",
  "$.regions.rail",
  "$.colour.region_slots",
  "$.colour.region_colors",
  "$.colour.tint",
  "$.colour.gradient",
  "$.colour.gradient.slots",
  "$.heights.type_defaults",
  "$.frame_style.shadow_gap",
  "$.frame_style.matting",
  "$.frame_style.separate",
  "$.frame_style.texture",
] as const;

describe("DEFAULT_PRINT_PARAMS is immutable", () => {
  it("names every object-valued key", () => {
    const found = Object.entries(DEFAULT_PRINT_PARAMS)
      .filter(([, value]) => value !== null && typeof value === "object")
      .map(([key]) => key);
    expect(found.sort()).toEqual([...NESTED_KEYS].sort());
  });

  it("is frozen, and so is every object reachable from it", () => {
    const paths = objectPaths(DEFAULT_PRINT_PARAMS);
    expect(paths.sort()).toEqual([...ALL_OBJECT_PATHS].sort());
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
      "place",
      "colour",
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

  it("publishes the v3 caps, nested two levels deep where the schema is", () => {
    // place.* (root -> Place -> four 64-char strings) and colour.palette
    // (root -> Colour -> one 32-char string) are one level, like the v2 caps
    // above; colour.gradient.slots is two levels (root -> Colour -> Gradient
    // -> slots), the deepest cap in the contract.
    expect(PARAM_LIMITS.place.country.max_length).toBe(64);
    expect(PARAM_LIMITS.place.state.max_length).toBe(64);
    expect(PARAM_LIMITS.place.neighbourhood.max_length).toBe(64);
    expect(PARAM_LIMITS.place.author.max_length).toBe(64);
    expect(PARAM_LIMITS.colour.palette.max_length).toBe(32);
    expect(PARAM_LIMITS.colour.gradient.slots.max_items).toBe(16);
  });

  it("agrees with the v3 defaults it caps", () => {
    expect(DEFAULT_PRINT_PARAMS.place!.author!.length).toBeLessThanOrEqual(
      PARAM_LIMITS.place.author.max_length,
    );
    expect(DEFAULT_PRINT_PARAMS.colour!.palette!.length).toBeLessThanOrEqual(
      PARAM_LIMITS.colour.palette.max_length,
    );
    expect(DEFAULT_PRINT_PARAMS.colour!.gradient!.slots!.length).toBeLessThanOrEqual(
      PARAM_LIMITS.colour.gradient.slots.max_items,
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

  it("exposes the nested v3 ranges as groups, one level deep", () => {
    expect(PARAM_RANGES.custom_profile.nozzle_mm).toEqual({ min: 0.2, max: 1.0, default: 0.4 });
    // Exaggeration is deliberately NOT a field here: it reuses the existing
    // top-level terrain_exaggeration (checked above, "keeps the v1 slider
    // ranges" would need it too if it were duplicated).
    expect(PARAM_RANGES.terrain.smoothing).toEqual({ min: 0, max: 5, default: 1 });
    expect(PARAM_RANGES.heights.floor_height_m).toEqual({ min: 2, max: 5, default: 3.0 });
    expect(PARAM_RANGES.bridges.clearance_mm).toEqual({ min: 0, max: 5, default: 1.0 });
    expect(PARAM_RANGES.height_exaggeration.multiplier).toEqual({ min: 0.25, max: 4, default: 1.0 });
    expect(PARAM_RANGES.hero_auto.count).toEqual({ min: 1, max: 12, default: 3 });
    expect(PARAM_RANGES.tiling.tolerance_mm).toEqual({ min: 0, max: 1, default: 0.15 });
    expect(PARAM_RANGES.hanger_magnet.diameter_mm).toEqual({ min: 3, max: 20, default: 6 });
  });

  it("exposes the nested v3 ranges as groups, two levels deep", () => {
    // regions.rail (root -> Regions -> RailRegion) and colour.region_slots
    // (root -> Colour -> RegionSlots) are the shallow direct-object-ref shape;
    // frame_style.shadow_gap (root -> FrameStyle -> ShadowGap) is the same
    // shape nested inside a group that ALSO has its own direct ranges
    // (corner_radius_mm, lip_depth_mm), so both must be present together.
    expect(PARAM_RANGES.regions.rail.width_m).toEqual({ min: 2, max: 20, default: 6.0 });
    expect(PARAM_RANGES.regions.building_skirt_mm).toEqual({ min: 0, max: 1, default: 0.3 });
    expect(PARAM_RANGES.colour.region_slots.buildings).toEqual({ min: 1, max: 16, default: 2 });
    expect(PARAM_RANGES.colour.tint.hue_range_deg).toEqual({ min: 0, max: 60, default: 12 });
    expect(PARAM_RANGES.frame_style.corner_radius_mm).toEqual({ min: 0, max: 20, default: 3 });
    expect(PARAM_RANGES.frame_style.shadow_gap.width_mm).toEqual({ min: 0.4, max: 5, default: 1.0 });
  });

  it("agrees with the v3 defaults it publishes", () => {
    expect(PARAM_RANGES.regions.rail.width_m.default).toBe(
      DEFAULT_PRINT_PARAMS.regions?.rail?.width_m,
    );
    expect(PARAM_RANGES.frame_style.shadow_gap.width_mm.default).toBe(
      DEFAULT_PRINT_PARAMS.frame_style?.shadow_gap?.width_mm,
    );
  });
});
