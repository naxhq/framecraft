/**
 * The shareable configuration.
 *
 * Three things have to hold, and each has a suite:
 *
 *  1. **Round trip.** Every field of `SceneRequest` and `PrintParams` -- nested
 *     objects, engravings, hero ids, a non-ASCII city label -- comes back
 *     exactly as it went in. The property-style loop generates a few hundred
 *     random parameter sets inside the contract's own ranges rather than
 *     hand-picking three, because the field this would break on is the one
 *     nobody thought to write down.
 *  2. **Short by default.** A default configuration is a link a person can
 *     paste into a message, which is the whole reason only the diff travels.
 *  3. **Refused, not half-applied.** An unknown version, a truncated payload, a
 *     hand-edited one, a value out of range and a setting this build has never
 *     heard of all come back as a NAMED reason, and never as a partially
 *     restored editor.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRINT_PARAMS,
  PARAM_LIMITS,
  PARAM_RANGES,
  defaultPrintParams,
} from "./contracts";
import type { Engraving, PrintParams, SceneRequest } from "./contracts";
import { RADIUS_MAX_M, RADIUS_MIN_M } from "./geo";
import {
  PRINT_PARAM_SPEC,
  SHARE_PARAM,
  SHARE_VERSION,
  checksum,
  decodeShare,
  encodeShare,
  paramsDiff,
  readShareParam,
  shareUrl,
} from "./share";

const REQUEST: SceneRequest = {
  lat: 41.8827,
  lon: -87.6233,
  radius_m: 900,
  rotation_deg: 0,
  preset_id: "chicago-loop",
};

/** A tiny deterministic PRNG, so a failure is reproducible from its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const EDGES = ["top", "bottom", "left", "right"] as const;
const FONTS = ["sans", "serif", "mono"] as const;
const ALIGNS = ["start", "center", "end"] as const;
const MODES = ["engrave", "emboss"] as const;

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length) % values.length];
}

function between(random: () => number, range: { min: number; max: number }): number {
  // Two decimals: the sliders step in 0.05 / 0.1, and an exactly-representable
  // value keeps the round-trip assertion about the encoding rather than about
  // float printing.
  return Math.round((range.min + random() * (range.max - range.min)) * 100) / 100;
}

function randomParams(random: () => number): PrintParams {
  const engravings: Engraving[] = [];
  const lines = Math.floor(random() * (PARAM_LIMITS.engravings.max_items + 1));
  for (let i = 0; i < lines; i += 1) {
    engravings.push({
      edge: pick(random, EDGES),
      align: pick(random, ALIGNS),
      text: `line ${i} {city} ${"x".repeat(Math.floor(random() * 20))}`,
      mode: pick(random, MODES),
      size_mm: between(random, PARAM_RANGES.engravings.size_mm),
      depth_mm: between(random, PARAM_RANGES.engravings.depth_mm),
      font: pick(random, FONTS),
    });
  }
  const heroes: string[] = [];
  const heroCount = Math.floor(random() * (PARAM_LIMITS.hero_building_ids.max_items + 1));
  for (let i = 0; i < heroCount; i += 1) heroes.push(`w${Math.floor(random() * 1e6)}`);
  const hex = (): string =>
    `#${Math.floor(random() * 0xffffff)
      .toString(16)
      .padStart(6, "0")}`;

  return {
    schema_version: 2,
    plate_mm: Math.round(between(random, PARAM_RANGES.plate_mm)),
    base_thickness_mm: between(random, PARAM_RANGES.base_thickness_mm),
    nozzle_mm: between(random, PARAM_RANGES.nozzle_mm),
    small_scale: between(random, PARAM_RANGES.small_scale),
    large_scale: between(random, PARAM_RANGES.large_scale),
    terrain_exaggeration: between(random, PARAM_RANGES.terrain_exaggeration),
    road_mode: pick(random, ["engrave", "emboss", "off"] as const),
    road_scale: between(random, PARAM_RANGES.road_scale),
    trees: random() > 0.5,
    water: random() > 0.5,
    frame: random() > 0.5,
    city_label: pick(random, ["", "Chicago", "Zürich", "São Paulo", "東京"]),
    color_mode: pick(random, ["single", "parts"] as const),
    part_colors: {
      base: hex(),
      frame: hex(),
      buildings: hex(),
      roads: hex(),
      water: hex(),
      green: hex(),
      trees: hex(),
    },
    engravings,
    north_arrow: {
      enabled: random() > 0.5,
      corner: pick(random, ["ne", "nw", "se", "sw"] as const),
      size_mm: between(random, PARAM_RANGES.north_arrow.size_mm),
    },
    scale_bar: {
      enabled: random() > 0.5,
      edge: pick(random, EDGES),
      length_mode: pick(random, ["auto", "fixed"] as const),
      length_m: Math.round(between(random, PARAM_RANGES.scale_bar.length_m)),
    },
    hanger: pick(random, ["none", "keyhole", "magnets"] as const),
    underside_mark: {
      enabled: random() > 0.5,
      template: pick(random, ["", "{city} {scale} {date}", "{coords}"]),
    },
    hero_building_ids: heroes,
    hero_mode: pick(random, ["true_height", "own_color", "both"] as const),
    ...randomV3Params(random),
  };
}

/**
 * The fourteen schema_version 3 groups ([V3-P1], landed by the concurrent
 * `v3-01-contracts` phase): same generator discipline as the v1/v2 fields
 * above, so the round-trip suites exercise every leaf instead of only the
 * ones a human thought to hand-pick.
 */
function randomV3Params(random: () => number): Pick<
  PrintParams,
  | "place"
  | "regions"
  | "colour"
  | "printer_profile"
  | "custom_profile"
  | "export_target"
  | "terrain"
  | "heights"
  | "bridges"
  | "height_exaggeration"
  | "hero_auto"
  | "tiling"
  | "frame_style"
  | "hanger_magnet"
> {
  const hex = (): string =>
    `#${Math.floor(random() * 0xffffff)
      .toString(16)
      .padStart(6, "0")}`;
  const label = (max: number): string =>
    pick(random, ["", "Chicago", "Zürich", "東京"]).slice(0, max);
  const regionPlacement = (range: {
    depth_mm: { min: number; max: number };
    proud_mm: { min: number; max: number };
  }): { depth_mm: number; proud_mm: number } => ({
    depth_mm: between(random, range.depth_mm),
    proud_mm: between(random, range.proud_mm),
  });

  return {
    place: {
      country: label(PARAM_LIMITS.place.country.max_length),
      state: label(PARAM_LIMITS.place.state.max_length),
      neighbourhood: label(PARAM_LIMITS.place.neighbourhood.max_length),
      author: label(PARAM_LIMITS.place.author.max_length),
    },
    regions: {
      roads: regionPlacement(PARAM_RANGES.regions.roads),
      water: regionPlacement(PARAM_RANGES.regions.water),
      parks: regionPlacement(PARAM_RANGES.regions.parks),
      rail: {
        ...regionPlacement(PARAM_RANGES.regions.rail),
        width_m: between(random, PARAM_RANGES.regions.rail.width_m),
      },
      building_skirt_mm: between(random, PARAM_RANGES.regions.building_skirt_mm),
    },
    colour: {
      region_slots: Object.fromEntries(
        (
          Object.keys(PARAM_RANGES.colour.region_slots) as Array<
            keyof typeof PARAM_RANGES.colour.region_slots
          >
        ).map((key) => [key, Math.round(between(random, PARAM_RANGES.colour.region_slots[key]))]),
      ) as PrintParams["colour"] extends { region_slots?: infer S } ? S : never,
      region_colors: {
        base: hex(),
        frame: hex(),
        matting: hex(),
        buildings: hex(),
        hero_building: hex(),
        roads: hex(),
        water: hex(),
        parks: hex(),
        rail: hex(),
        lettering: hex(),
        attribution: hex(),
      },
      palette: pick(random, ["default", "noir", "blueprint"]),
      tint: {
        enabled: random() > 0.5,
        hue_range_deg: between(random, PARAM_RANGES.colour.tint.hue_range_deg),
        lightness_range: between(random, PARAM_RANGES.colour.tint.lightness_range),
        seed: Math.floor(random() * 1000),
      },
      gradient: {
        enabled: random() > 0.5,
        slots: [Math.floor(random() * 16) + 1, Math.floor(random() * 16) + 1],
      },
      preview_theme: pick(random, ["dark", "light"] as const),
    },
    printer_profile: pick(random, [
      "custom",
      "bambu-h2s",
      "bambu-p1s",
      "bambu-x1c",
      "bambu-a1",
      "bambu-a1-mini",
      "prusa-mk4",
      "prusa-mini",
      "ender-3",
    ] as const),
    custom_profile: {
      plate_x_mm: Math.round(between(random, PARAM_RANGES.custom_profile.plate_x_mm)),
      plate_y_mm: Math.round(between(random, PARAM_RANGES.custom_profile.plate_y_mm)),
      max_height_mm: Math.round(between(random, PARAM_RANGES.custom_profile.max_height_mm)),
      nozzle_mm: between(random, PARAM_RANGES.custom_profile.nozzle_mm),
      slots: Math.round(between(random, PARAM_RANGES.custom_profile.slots)),
      change_gcode: pick(random, ["M600", "M601", ""]),
    },
    export_target: pick(random, [
      "bambu-3mf",
      "generic-3mf",
      "stl",
      "stl-parts-zip",
      "obj",
      "step",
      "color-change-3mf",
    ] as const),
    terrain: {
      enabled: random() > 0.5,
      smoothing: Math.round(between(random, PARAM_RANGES.terrain.smoothing)),
    },
    heights: {
      floor_height_m: between(random, PARAM_RANGES.heights.floor_height_m),
      unknown_default_m: between(random, PARAM_RANGES.heights.unknown_default_m),
      type_defaults: {
        house: Math.round(random() * 20),
        apartments: Math.round(random() * 40),
        commercial: Math.round(random() * 30),
        retail: Math.round(random() * 15),
        industrial: Math.round(random() * 20),
        garage: Math.round(random() * 6),
      },
    },
    bridges: {
      enabled: random() > 0.5,
      clearance_mm: between(random, PARAM_RANGES.bridges.clearance_mm),
      abutments: random() > 0.5,
    },
    height_exaggeration: {
      multiplier: between(random, PARAM_RANGES.height_exaggeration.multiplier),
      curve: between(random, PARAM_RANGES.height_exaggeration.curve),
    },
    hero_auto: {
      enabled: random() > 0.5,
      count: Math.round(between(random, PARAM_RANGES.hero_auto.count)),
    },
    tiling: {
      enabled: random() > 0.5,
      cols: Math.round(between(random, PARAM_RANGES.tiling.cols)),
      rows: Math.round(between(random, PARAM_RANGES.tiling.rows)),
      joint: pick(random, ["dovetail", "pin"] as const),
      tolerance_mm: between(random, PARAM_RANGES.tiling.tolerance_mm),
      index_mark: random() > 0.5,
    },
    frame_style: {
      profile: pick(random, [
        "plain",
        "chamfer",
        "stepped",
        "bevel_in",
        "bullnose",
        "ogee",
        "floating",
      ] as const),
      corner: pick(random, ["square", "mitred", "rounded"] as const),
      corner_radius_mm: between(random, PARAM_RANGES.frame_style.corner_radius_mm),
      lip_depth_mm: between(random, PARAM_RANGES.frame_style.lip_depth_mm),
      shadow_gap: {
        enabled: random() > 0.5,
        width_mm: between(random, PARAM_RANGES.frame_style.shadow_gap.width_mm),
        depth_mm: between(random, PARAM_RANGES.frame_style.shadow_gap.depth_mm),
      },
      matting: {
        enabled: random() > 0.5,
        width_mm: between(random, PARAM_RANGES.frame_style.matting.width_mm),
        proud_mm: between(random, PARAM_RANGES.frame_style.matting.proud_mm),
      },
      separate: {
        enabled: random() > 0.5,
        mount: pick(random, ["snap", "magnet"] as const),
        tolerance_mm: between(random, PARAM_RANGES.frame_style.separate.tolerance_mm),
      },
      texture: {
        pattern: pick(random, ["none", "brush", "knurl", "hatch", "dots"] as const),
        scale_mm: between(random, PARAM_RANGES.frame_style.texture.scale_mm),
        depth_mm: between(random, PARAM_RANGES.frame_style.texture.depth_mm),
      },
    },
    hanger_magnet: {
      diameter_mm: between(random, PARAM_RANGES.hanger_magnet.diameter_mm),
      thickness_mm: between(random, PARAM_RANGES.hanger_magnet.thickness_mm),
      count: Math.round(between(random, PARAM_RANGES.hanger_magnet.count)),
    },
  };
}

/**
 * A well-formed, correctly checksummed payload carrying arbitrary JSON.
 *
 * Hand-made rather than encoded through `encodeShare`, because the point of
 * most of the refusal suite is a body that `encodeShare` would never produce.
 */
function payloadOf(body: unknown): string {
  const text = JSON.stringify(body);
  const encoded = Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${SHARE_VERSION}.${encoded}.${checksum(text)}`;
}

function randomRequest(random: () => number): SceneRequest {
  return {
    lat: Math.round((random() * 180 - 90) * 1e4) / 1e4,
    lon: Math.round((random() * 360 - 180) * 1e4) / 1e4,
    radius_m:
      Math.round((RADIUS_MIN_M + random() * (RADIUS_MAX_M - RADIUS_MIN_M)) / 10) * 10,
    rotation_deg: Math.floor(random() * 361),
    preset_id: random() > 0.5 ? "chicago-loop" : null,
  };
}

// ==========================================================================
// Round trip
// ==========================================================================

describe("encodeShare / decodeShare", () => {
  it("round-trips the contract defaults", () => {
    const decoded = decodeShare(encodeShare(REQUEST, defaultPrintParams()));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.request).toEqual(REQUEST);
    expect(decoded.params).toEqual(defaultPrintParams());
  });

  it("round-trips 300 random parameter sets across the whole contract", () => {
    const random = rng(20260830);
    let sawEngravings = 0;
    let sawHeroes = 0;
    let sawUnicode = 0;
    for (let i = 0; i < 300; i += 1) {
      const request = randomRequest(random);
      const params = randomParams(random);
      const decoded = decodeShare(encodeShare(request, params));
      expect(decoded.ok, `case ${i}`).toBe(true);
      if (!decoded.ok) continue;
      expect(decoded.request, `case ${i} request`).toEqual(request);
      expect(decoded.params, `case ${i} params`).toEqual(params);
      if ((params.engravings ?? []).length > 0) sawEngravings += 1;
      if ((params.hero_building_ids ?? []).length > 0) sawHeroes += 1;
      if (/[^ -]/.test(params.city_label ?? "")) sawUnicode += 1;
    }
    // Not vacuous: the loop really did exercise the hard fields.
    expect(sawEngravings).toBeGreaterThan(50);
    expect(sawHeroes).toBeGreaterThan(50);
    expect(sawUnicode).toBeGreaterThan(20);
  });

  it("round-trips every key the contract declares, one at a time", () => {
    // The loop above is random; this one is exhaustive over the key SET, so a
    // field that never happened to differ from its default still gets a case.
    const random = rng(7);
    const sample = randomParams(random);
    for (const key of Object.keys(DEFAULT_PRINT_PARAMS) as Array<keyof PrintParams>) {
      const params = defaultPrintParams();
      (params as unknown as Record<string, unknown>)[key] = (
        sample as unknown as Record<string, unknown>
      )[key];
      const decoded = decodeShare(encodeShare(REQUEST, params));
      expect(decoded.ok, key).toBe(true);
      if (decoded.ok) expect(decoded.params, key).toEqual(params);
    }
  });

  it("keeps a null preset_id null rather than inventing one", () => {
    const decoded = decodeShare(
      encodeShare({ ...REQUEST, preset_id: null }, defaultPrintParams()),
    );
    expect(decoded.ok && decoded.request.preset_id).toBeNull();
  });

  it("round-trips a v3 payload -- every new group, nested leaves included", () => {
    // [V3-P1]: a hand-built payload naming every one of the fourteen
    // schema_version 3 groups, so a share link genuinely carries the resolved
    // {country}/{state}/{neighbourhood}/{author} tokens and the rest of the
    // v3 engine block, not only the v1/v2 fields the loops above already
    // exercise via `randomV3Params`.
    const params: PrintParams = {
      ...defaultPrintParams(),
      place: {
        country: "United States",
        state: "Illinois",
        neighbourhood: "The Loop",
        author: "Vahid Alizadeh",
      },
      regions: {
        roads: { depth_mm: 0.8, proud_mm: -0.3 },
        water: { depth_mm: 1.2, proud_mm: -0.6 },
        parks: { depth_mm: 0.5, proud_mm: 0.1 },
        rail: { depth_mm: 0.5, proud_mm: 0.4, width_m: 7 },
        building_skirt_mm: 0.5,
      },
      colour: {
        region_slots: {
          base: 1,
          frame: 2,
          matting: 1,
          buildings: 3,
          hero_building: 4,
          roads: 4,
          water: 3,
          parks: 4,
          rail: 4,
          lettering: 5,
          attribution: 1,
        },
        region_colors: {
          base: "#D8D3C6",
          frame: "#3A3A3A",
          matting: "#EDE9E0",
          buildings: "#D8D3C6",
          hero_building: "#E3A72F",
          roads: "#3A3A3A",
          water: "#2F7FC1",
          parks: "#5A9E4B",
          rail: "#6B6B6B",
          lettering: "#E3A72F",
          attribution: "#D8D3C6",
        },
        palette: "blueprint",
        tint: { enabled: true, hue_range_deg: 20, lightness_range: 0.2, seed: 42 },
        gradient: { enabled: true, slots: [2, 3, 4] },
        preview_theme: "light",
      },
      printer_profile: "bambu-x1c",
      custom_profile: {
        plate_x_mm: 220,
        plate_y_mm: 220,
        max_height_mm: 200,
        nozzle_mm: 0.6,
        slots: 2,
        change_gcode: "M600",
      },
      export_target: "generic-3mf",
      terrain: { enabled: true, smoothing: 2 },
      heights: {
        floor_height_m: 3.2,
        unknown_default_m: 9,
        type_defaults: {
          house: 6,
          apartments: 16,
          commercial: 13,
          retail: 6,
          industrial: 9,
          garage: 3,
        },
      },
      bridges: { enabled: false, clearance_mm: 1.5, abutments: false },
      height_exaggeration: { multiplier: 1.5, curve: 0.3 },
      hero_auto: { enabled: true, count: 5 },
      tiling: { enabled: true, cols: 2, rows: 2, joint: "pin", tolerance_mm: 0.2, index_mark: false },
      frame_style: {
        profile: "chamfer",
        corner: "mitred",
        corner_radius_mm: 4,
        lip_depth_mm: 0.5,
        shadow_gap: { enabled: true, width_mm: 1.2, depth_mm: 0.9 },
        matting: { enabled: true, width_mm: 8, proud_mm: 0.5 },
        separate: { enabled: true, mount: "magnet", tolerance_mm: 0.3 },
        texture: { pattern: "brush", scale_mm: 1.2, depth_mm: 0.3 },
      },
      hanger: "cleat",
      hanger_magnet: { diameter_mm: 8, thickness_mm: 3, count: 4 },
      engravings: [{ edge: "underside", text: "{author}", mode: "inlay" }],
    };
    const decoded = decodeShare(encodeShare(REQUEST, params));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.params).toEqual(params);
  });
});

// ==========================================================================
// Compactness
// ==========================================================================

describe("the payload is a diff", () => {
  it("is short for a default configuration", () => {
    const payload = encodeShare(REQUEST, defaultPrintParams());
    expect(paramsDiff(defaultPrintParams())).toEqual({});
    // Version, base64 and checksum, over a location and an empty settings
    // block: a link that fits in a chat message intact.
    expect(payload.length).toBeLessThan(160);
    expect(payload.startsWith(`${SHARE_VERSION}.`)).toBe(true);
  });

  it("carries only what the user actually changed", () => {
    const params = defaultPrintParams();
    params.city_label = "Chicago";
    params.plate_mm = 220;
    expect(paramsDiff(params)).toEqual({ city_label: "Chicago", plate_mm: 220 });
  });

  it("compares nested objects structurally, not by identity", () => {
    // `setNested` rebuilds `part_colors` on every write, so an identity test
    // would put the whole seven-colour palette into every link ever made.
    const params = defaultPrintParams();
    params.part_colors = { ...(DEFAULT_PRINT_PARAMS.part_colors ?? {}) } as never;
    params.north_arrow = { ...(DEFAULT_PRINT_PARAMS.north_arrow ?? {}) };
    expect(paramsDiff(params)).toEqual({});
  });

  /**
   * A genuinely maximal configuration.
   *
   * The first version of this was called "at the contract's maxima" and was
   * not: hero ids were 14 characters against a 64-character limit, every string
   * was ASCII, and six numeric fields plus four nested groups sat at their
   * defaults and contributed nothing to the diff. Its "measured 2,319
   * characters" comment was wrong by roughly 2x, and its own `< 4096` bound
   * does not hold at the real maxima for any non-ASCII label (audit v2-06
   * finding 4).
   */
  const maximal = (fill: string): PrintParams => {
    const long = (n: number): string =>
      fill.repeat(Math.ceil(n / [...fill].length)).slice(0, n);
    const params = defaultPrintParams();
    // Every string at its limit...
    params.city_label = long(PARAM_LIMITS.city_label.max_length);
    params.underside_mark = {
      enabled: true,
      template: long(PARAM_LIMITS.underside_mark.template.max_length),
    };
    params.engravings = Array.from(
      { length: PARAM_LIMITS.engravings.max_items },
      (): Engraving => ({
        edge: "top",
        align: "center",
        text: long(PARAM_LIMITS.engravings.text.max_length),
        mode: "engrave",
        size_mm: 8,
        depth_mm: 1.5,
        font: "serif",
      }),
    );
    // ...hero ids at the 64 characters the spec allows, not at 14...
    params.hero_building_ids = Array.from(
      { length: PARAM_LIMITS.hero_building_ids.max_items },
      (_, i) => `${i}`.padEnd(64, "w"),
    );
    // ...and every other field off its default, so all of it is in the diff.
    params.plate_mm = PARAM_RANGES.plate_mm.max;
    params.base_thickness_mm = PARAM_RANGES.base_thickness_mm.max;
    params.nozzle_mm = 0.35;
    params.small_scale = 1.45;
    params.large_scale = 1.95;
    params.terrain_exaggeration = 2.95;
    params.road_mode = "emboss";
    params.road_scale = 1.95;
    params.trees = false;
    params.water = false;
    params.frame = false;
    params.color_mode = "parts";
    params.part_colors = {
      base: "#010203",
      frame: "#040506",
      buildings: "#070809",
      roads: "#0a0b0c",
      water: "#0d0e0f",
      green: "#101112",
      trees: "#131415",
    };
    params.north_arrow = { enabled: true, corner: "sw", size_mm: 5.5 };
    params.scale_bar = {
      enabled: true,
      edge: "left",
      length_mode: "fixed",
      length_m: PARAM_RANGES.scale_bar.length_m.max,
    };
    params.hanger = "magnets";
    params.hero_mode = "both";
    // ...and every v3 group off its own default too ([V3-P1]).
    params.place = {
      country: long(PARAM_LIMITS.place.country.max_length),
      state: long(PARAM_LIMITS.place.state.max_length),
      neighbourhood: long(PARAM_LIMITS.place.neighbourhood.max_length),
      author: long(PARAM_LIMITS.place.author.max_length),
    };
    params.regions = {
      roads: { depth_mm: 2.9, proud_mm: 1.9 },
      water: { depth_mm: 2.8, proud_mm: 1.8 },
      parks: { depth_mm: 2.7, proud_mm: 1.7 },
      rail: { depth_mm: 2.6, proud_mm: 1.6, width_m: 19 },
      building_skirt_mm: 0.9,
    };
    params.colour = {
      region_slots: {
        base: 2,
        frame: 3,
        matting: 4,
        buildings: 5,
        hero_building: 6,
        roads: 7,
        water: 8,
        parks: 9,
        rail: 10,
        lettering: 11,
        attribution: 12,
      },
      region_colors: {
        base: "#111111",
        frame: "#222222",
        matting: "#333333",
        buildings: "#444444",
        hero_building: "#555555",
        roads: "#666666",
        water: "#777777",
        parks: "#888888",
        rail: "#999999",
        lettering: "#aaaaaa",
        attribution: "#bbbbbb",
      },
      palette: "noir",
      tint: { enabled: true, hue_range_deg: 45, lightness_range: 0.4, seed: 7 },
      gradient: { enabled: true, slots: [4, 5, 6] },
      preview_theme: "light",
    };
    params.printer_profile = "bambu-x1c";
    params.custom_profile = {
      plate_x_mm: PARAM_RANGES.custom_profile.plate_x_mm.max,
      plate_y_mm: PARAM_RANGES.custom_profile.plate_y_mm.max,
      max_height_mm: PARAM_RANGES.custom_profile.max_height_mm.max,
      nozzle_mm: 0.9,
      slots: PARAM_RANGES.custom_profile.slots.max,
      change_gcode: "M600\nT{next_extruder}",
    };
    params.export_target = "stl-parts-zip";
    params.terrain = { enabled: true, smoothing: PARAM_RANGES.terrain.smoothing.max };
    params.heights = {
      floor_height_m: PARAM_RANGES.heights.floor_height_m.max,
      unknown_default_m: PARAM_RANGES.heights.unknown_default_m.max,
      type_defaults: {
        house: 9,
        apartments: 30,
        commercial: 25,
        retail: 11,
        industrial: 15,
        garage: 4,
      },
    };
    params.bridges = { enabled: false, clearance_mm: PARAM_RANGES.bridges.clearance_mm.max, abutments: false };
    params.height_exaggeration = {
      multiplier: PARAM_RANGES.height_exaggeration.multiplier.max,
      curve: PARAM_RANGES.height_exaggeration.curve.max,
    };
    params.hero_auto = { enabled: true, count: PARAM_RANGES.hero_auto.count.max };
    params.tiling = {
      enabled: true,
      cols: PARAM_RANGES.tiling.cols.max,
      rows: PARAM_RANGES.tiling.rows.max,
      joint: "pin",
      tolerance_mm: PARAM_RANGES.tiling.tolerance_mm.max,
      index_mark: false,
    };
    params.frame_style = {
      profile: "ogee",
      corner: "rounded",
      corner_radius_mm: PARAM_RANGES.frame_style.corner_radius_mm.max,
      lip_depth_mm: PARAM_RANGES.frame_style.lip_depth_mm.max,
      shadow_gap: {
        enabled: true,
        width_mm: PARAM_RANGES.frame_style.shadow_gap.width_mm.max,
        depth_mm: PARAM_RANGES.frame_style.shadow_gap.depth_mm.max,
      },
      matting: {
        enabled: true,
        width_mm: PARAM_RANGES.frame_style.matting.width_mm.max,
        proud_mm: PARAM_RANGES.frame_style.matting.proud_mm.max,
      },
      separate: {
        enabled: true,
        mount: "magnet",
        tolerance_mm: PARAM_RANGES.frame_style.separate.tolerance_mm.max,
      },
      texture: {
        pattern: "hatch",
        scale_mm: PARAM_RANGES.frame_style.texture.scale_mm.max,
        depth_mm: PARAM_RANGES.frame_style.texture.depth_mm.max,
      },
    };
    params.hanger_magnet = {
      diameter_mm: PARAM_RANGES.hanger_magnet.diameter_mm.max,
      thickness_mm: PARAM_RANGES.hanger_magnet.thickness_mm.max,
      count: PARAM_RANGES.hanger_magnet.count.max,
    };
    return params;
  };

  /** One byte, two, three and four of UTF-8 per character. */
  const FILLS: Array<[string, string]> = [
    ["ascii", "x"],
    ["latin-1 2 byte", "é"],
    ["cjk 3 byte", "東"],
    ["astral 4 byte", "\u{1f600}"],
  ];

  it("round-trips a genuinely maximal configuration, ASCII and not", () => {
    for (const [name, fill] of FILLS) {
      const params = maximal(fill);
      // The diff really is the whole contract: nothing is left at its default,
      // which is what makes the measurement below a maximum.
      expect(Object.keys(paramsDiff(params)).sort(), name).toEqual(
        Object.keys(DEFAULT_PRINT_PARAMS)
          .filter((key) => key !== "schema_version")
          .sort(),
      );
      const decoded = decodeShare(encodeShare(REQUEST, params));
      expect(decoded.ok, name).toBe(true);
      if (decoded.ok) expect(decoded.params, name).toEqual(params);
    }
  });

  it("stays inside a browser URL even at the contract's maxima", () => {
    // Measured on this host, with this REQUEST, once the v3 groups joined the
    // maximum ([V3-P1]: 14 more top-level fields, most of them nested objects
    // of their own): 6,828 characters of payload for an all-ASCII maximum and
    // 9,218 for three-byte CJK (the new largest fill: latin-1 and the astral
    // plane both land at 8,023), against 148 for a default configuration (141
    // with no preset id). The bound is 16 kB, and it is the claim: comfortably
    // inside Chrome's ~32 k address bar and Firefox's and Safari's far larger
    // limits, while being past the 2,083 that legacy IE/Edge and some chat
    // clients truncate at -- which is precisely the failure the checksum
    // exists to NAME rather than to prevent. (v1/v2's bound here was 8 kB,
    // measured at 4,011 ASCII / 5,718 CJK before the v3 groups existed.)
    const lengths: Record<string, number> = {};
    for (const [name, fill] of FILLS) {
      const payload = encodeShare(REQUEST, maximal(fill));
      lengths[name] = payload.length;
      expect(payload.length, `${name}: ${payload.length} characters`).toBeLessThan(16384);
    }
    // Not vacuous: a non-ASCII maximum really is bigger than the ASCII one, and
    // both are far bigger than the 2,319 the old comment claimed.
    expect(lengths.ascii).toBeGreaterThan(3500);
    expect(lengths["cjk 3 byte"]).toBeGreaterThan(lengths.ascii);
    // ...and a default configuration is still a link a person can paste.
    expect(encodeShare(REQUEST, defaultPrintParams()).length).toBeLessThan(160);
  });
});

// ==========================================================================
// Refusals
// ==========================================================================

describe("a link is untrusted input", () => {
  const valid = encodeShare(REQUEST, defaultPrintParams());

  const rejected = (payload: string): string => {
    const decoded = decodeShare(payload);
    expect(decoded.ok, `expected a refusal for ${payload.slice(0, 40)}`).toBe(false);
    return decoded.ok ? "" : decoded.reason;
  };

  it("refuses a version it does not read, and names it", () => {
    const [, body, digest] = valid.split(".");
    expect(rejected(`v1.${body}.${digest}`)).toContain("different version");
    expect(rejected(`v3.${body}.${digest}`)).toContain("v3");
  });

  it("refuses a truncated or hand-edited payload", () => {
    const [version, body, digest] = valid.split(".");
    // One character flipped in the middle: it still base64-decodes, and often
    // still parses, which is exactly why the digest is there.
    const tampered = `${body.slice(0, 10)}${body[10] === "A" ? "B" : "A"}${body.slice(11)}`;
    expect(rejected(`${version}.${tampered}.${digest}`)).toContain("edited or truncated");
    expect(rejected(`${version}.${body.slice(0, body.length - 4)}.${digest}`)).toBeTruthy();
    expect(rejected(valid.slice(0, valid.length - 3))).toBeTruthy();
  });

  it("refuses a payload whose digest was recomputed over nonsense", () => {
    expect(rejected(payloadOf({ r: { lat: "north" }, p: {} }))).toContain(
      "latitude is not a number",
    );
  });

  it("refuses a value outside the contract's own range", () => {
    const outOfRange = (params: Record<string, unknown>): string =>
      rejected(payloadOf({ r: REQUEST, p: params }));
    expect(outOfRange({ plate_mm: PARAM_RANGES.plate_mm.max + 1 })).toContain("maximum");
    expect(outOfRange({ nozzle_mm: 0 })).toContain("minimum");
    expect(outOfRange({ road_mode: "carve" })).toContain("engrave, emboss, off");
    expect(outOfRange({ city_label: "x".repeat(65) })).toContain("64 characters");
    expect(
      outOfRange({ engravings: Array.from({ length: 9 }, () => ({ edge: "top", text: "x" })) }),
    ).toContain("more than 8");
    expect(outOfRange({ hero_building_ids: Array.from({ length: 13 }, () => "w") })).toContain(
      "more than 12",
    );
    expect(outOfRange({ part_colors: { base: "red" } })).toContain("not in the form");
    expect(outOfRange({ trees: "yes" })).toContain("true/false");
    // Audit v3-02 finding 11: the contract's own `schema_version` type is
    // `2 | 3` (`contracts.ts`), so a value outside THAT pair is refused, not
    // 3 itself -- 3 is the current default and a link naming it honestly
    // must round-trip, which the next test asserts directly.
    expect(outOfRange({ schema_version: 4 })).toContain("must be 2 or 3");
    expect(outOfRange({ schema_version: 1 })).toContain("must be 2 or 3");
  });

  it("accepts either legal schema_version, including the current default", () => {
    for (const version of [2, 3] as const) {
      const decoded = decodeShare(payloadOf({ r: REQUEST, p: { schema_version: version } }));
      expect(decoded.ok, String(version)).toBe(true);
      if (decoded.ok) expect(decoded.params.schema_version).toBe(version);
    }
  });

  it("refuses a setting this build has never heard of", () => {
    expect(rejected(payloadOf({ r: REQUEST, p: { moon_phase: 3 } }))).toContain(
      "moon_phase",
    );
  });

  /**
   * The whole class, not one ordinary name.
   *
   * `JSON.parse` hands `__proto__`, `constructor`, `toString` and the rest of
   * `Object.prototype` back as ORDINARY OWN KEYS, so a bare `map[key]` answers
   * with a function off the prototype chain instead of `undefined` and the
   * "is this a setting?" guard never fires. The value written is `undefined`,
   * so this is not prototype pollution -- but the params object that reaches
   * the store then carries an own `toString: undefined`, and `String(params)`
   * throws on it. The all-or-nothing promise this module opens with is what is
   * actually broken.
   *
   * Every one of these was ACCEPTED before `specFor` (audit v2-06 finding 1).
   */
  const PROTOTYPE_KEYS = Object.getOwnPropertyNames(Object.prototype);

  it("knows the prototype keys it is guarding against", () => {
    // Guards the guard: an empty or trivial list would make the three cases
    // below pass for the wrong reason.
    expect(PROTOTYPE_KEYS.length).toBeGreaterThanOrEqual(9);
    for (const key of ["__proto__", "constructor", "toString", "valueOf"]) {
      expect(PROTOTYPE_KEYS).toContain(key);
    }
  });

  it("refuses an inherited name as a top-level setting", () => {
    for (const key of PROTOTYPE_KEYS) {
      const reason = rejected(payloadOf({ r: REQUEST, p: { [key]: 1 } }));
      expect(reason, key).toContain(key);
      expect(reason, key).toContain("does not have");
    }
  });

  it("refuses an inherited name inside a nested group", () => {
    for (const key of PROTOTYPE_KEYS) {
      expect(
        rejected(payloadOf({ r: REQUEST, p: { north_arrow: { [key]: 1 } } })),
        key,
      ).toContain(`north_arrow.${key} is not a setting`);
      expect(
        rejected(payloadOf({ r: REQUEST, p: { part_colors: { [key]: "#ffffff" } } })),
        key,
      ).toContain(`part_colors.${key} is not a setting`);
    }
  });

  it("refuses an inherited name inside an engravings item", () => {
    for (const key of PROTOTYPE_KEYS) {
      expect(
        rejected(
          payloadOf({
            r: REQUEST,
            p: { engravings: [{ edge: "top", text: "x", [key]: 1 }] },
          }),
        ),
        key,
      ).toContain(`engravings[0].${key} is not a setting`);
    }
  });

  it("never hands the store a params object that cannot be coerced", () => {
    // The concrete damage the accepted payload did: an own `toString` of
    // `undefined` makes every string coercion of `params` throw, from a
    // template literal to `new URLSearchParams`.
    for (const key of PROTOTYPE_KEYS) {
      const decoded = decodeShare(payloadOf({ r: REQUEST, p: { [key]: 1 } }));
      expect(decoded.ok, key).toBe(false);
      if (decoded.ok) continue;
    }
    // ...and a payload that IS accepted carries none of them.
    const good = decodeShare(encodeShare(REQUEST, defaultPrintParams()));
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    for (const key of PROTOTYPE_KEYS) {
      expect(Object.hasOwn(good.params, key), key).toBe(false);
    }
    expect(() => String(good.params)).not.toThrow();
    expect(() => `${JSON.stringify(good.params)}`).not.toThrow();
  });

  it("refuses an empty or shapeless payload without throwing", () => {
    for (const payload of ["", "   ", "v2", "v2.", "....", "v2.!!!!.0000", "%%%"]) {
      expect(() => decodeShare(payload)).not.toThrow();
      expect(decodeShare(payload).ok, payload).toBe(false);
    }
  });

  it("completes a nested group rather than leaving it half-filled", () => {
    // A hand-made link may legally send `{"enabled": true}` -- every property
    // inside the four nested objects is optional on the wire -- and everything
    // downstream, from `paletteFor` to the bake, assumes a complete object.
    const decoded = decodeShare(
      payloadOf({ r: REQUEST, p: { north_arrow: { enabled: true } } }),
    );
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.params.north_arrow).toEqual({
      enabled: true,
      corner: DEFAULT_PRINT_PARAMS.north_arrow?.corner,
      size_mm: DEFAULT_PRINT_PARAMS.north_arrow?.size_mm,
    });
  });
});

// ==========================================================================
// The spec table itself
// ==========================================================================

describe("PRINT_PARAM_SPEC", () => {
  it("has one entry per key of the frozen contract, and no more", () => {
    expect(Object.keys(PRINT_PARAM_SPEC).sort()).toEqual(
      Object.keys(DEFAULT_PRINT_PARAMS).sort(),
    );
  });

  it("lists the contract's own default as a member of every enum", () => {
    // The enum MEMBERS are the one thing the contract generator does not emit
    // as a runtime value, so they are written out in `share.ts`. This is what
    // catches a renamed or removed variant.
    let enums = 0;
    for (const [key, spec] of Object.entries(PRINT_PARAM_SPEC)) {
      if (spec.kind !== "enum") continue;
      enums += 1;
      const value = (DEFAULT_PRINT_PARAMS as unknown as Record<string, unknown>)[key];
      expect(spec.values, key).toContain(value);
    }
    expect(enums).toBeGreaterThanOrEqual(4);
  });
});

// ==========================================================================
// URLs
// ==========================================================================

describe("shareUrl and readShareParam", () => {
  it("sets the payload on the current page and drops the fragment", () => {
    const url = shareUrl(
      "http://localhost:3000/?foo=bar#somewhere",
      REQUEST,
      defaultPrintParams(),
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/");
    expect(parsed.hash).toBe("");
    expect(parsed.searchParams.get("foo")).toBe("bar");
    expect(parsed.searchParams.get(SHARE_PARAM)).toBe(
      encodeShare(REQUEST, defaultPrintParams()),
    );
  });

  it("replaces an older payload instead of stacking a second one", () => {
    const once = shareUrl("http://localhost:3000/", REQUEST, defaultPrintParams());
    const twice = shareUrl(once, { ...REQUEST, radius_m: 1200 }, defaultPrintParams());
    expect([...new URL(twice).searchParams.keys()]).toEqual([SHARE_PARAM]);
    const decoded = decodeShare(new URL(twice).searchParams.get(SHARE_PARAM) as string);
    expect(decoded.ok && decoded.request.radius_m).toBe(1200);
  });

  it("reads the payload back out of a query string, with or without the ?", () => {
    const payload = encodeShare(REQUEST, defaultPrintParams());
    expect(readShareParam(`?${SHARE_PARAM}=${payload}`)).toBe(payload);
    expect(readShareParam(`${SHARE_PARAM}=${payload}`)).toBe(payload);
    expect(readShareParam("?other=1")).toBeNull();
    expect(readShareParam("")).toBeNull();
  });
});
