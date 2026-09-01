/**
 * The shareable configuration: a whole editor state in one URL.
 *
 * Format, and why:
 *
 * ```
 * ?s=v2.<base64url(JSON)>.<fnv1a32 of the JSON, 8 hex digits>
 *        └ {"r": SceneRequest, "p": the PrintParams that differ from default}
 * ```
 *
 * - **Versioned first.** `v2` is `PrintParams.schema_version`, so a link made
 *   against a future schema is refused by name rather than silently
 *   half-applied. An unknown version is the one failure a user can actually act
 *   on ("this link was made by a newer FrameCraft").
 * - **The diff, not the object.** Only the fields that differ from
 *   `DEFAULT_PRINT_PARAMS` travel, so a default configuration is 141-148
 *   characters and a link stays legible in a chat message. Anything absent is
 *   filled from `defaultPrintParams()` on the way back in, which is exactly what
 *   the wire contract already does (every v2 field is optional and defaulted).
 * - **Base64url, not compression.** DECISIONS [V2-P6]: `CompressionStream
 *   ("deflate-raw")` would make encode and decode asynchronous and would put a
 *   browser-support cliff (Safari 16.4) in front of a Copy button, to save a
 *   payload that is already a diff. Measured at the contract's REAL maxima
 *   (every string 64 characters, eight engravings, twelve 64-character hero
 *   ids, every other field off its default): **4,011 characters for ASCII and
 *   5,718 for three-byte CJK** -- comfortably inside Chrome's ~32 k address bar
 *   and inside what Firefox and Safari will navigate to, and past the 2,083 a
 *   legacy IE/Edge or a chat client truncates at, which is precisely what the
 *   checksum below exists to NAME. (An earlier comment here said 2,319; it was
 *   measured on a configuration that was not at the maxima -- audit v2-06
 *   finding 4.)
 * - **Checksummed.** A truncated or hand-edited payload usually still base64
 *   -decodes into *something*; the FNV-1a digest is what turns that into a named
 *   refusal instead of a half-restored editor.
 *
 * Everything decoded is validated against the frozen contract's own shapes and
 * bounds before it reaches the store: a link is untrusted input.
 */

import {
  DEFAULT_PRINT_PARAMS,
  PARAM_LIMITS,
  PARAM_RANGES,
  defaultPrintParams,
} from "./contracts";
import type { PrintParams, SceneRequest } from "./contracts";
import { RADIUS_MAX_M, RADIUS_MIN_M } from "./geo";

/** The query parameter the payload rides in. */
export const SHARE_PARAM = "s";

/** The only payload version this build understands. */
export const SHARE_VERSION = "v2";

// ---------------------------------------------------------------------------
// base64url over UTF-8
// ---------------------------------------------------------------------------

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: `String.fromCharCode(...bytes)` blows the argument limit on a
  // payload of any size.
  for (let i = 0; i < bytes.length; i += 0x400) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x400));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * FNV-1a, 32 bit, over the UTF-8 bytes, as eight lower-case hex digits.
 *
 * Not a security control -- a link is not a capability -- but an integrity
 * check: it is what makes "the link was truncated by a chat client" a message
 * rather than a mystery.
 */
export function checksum(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// What a valid payload may contain
// ---------------------------------------------------------------------------

type FieldSpec =
  | { kind: "number"; min?: number; max?: number }
  | { kind: "boolean" }
  | { kind: "string"; maxLength?: number; pattern?: RegExp }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "object"; fields: Record<string, FieldSpec> }
  | { kind: "array"; maxItems: number; item: FieldSpec }
  | { kind: "literal"; values: readonly number[] };

const EDGES = ["top", "bottom", "left", "right"] as const;
/** `Engraving.edge` alone also allows "underside" ([V3-P1]); ScaleBar's does not. */
const ENGRAVING_EDGES = [...EDGES, "underside"] as const;
const HEX_COLOUR = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;

/**
 * Look one name up in an allowlist, treating INHERITED names as absent.
 *
 * `JSON.parse` gives `__proto__`, `constructor`, `toString`, `valueOf` and the
 * rest of `Object.prototype` as ORDINARY OWN KEYS of the parsed object, and a
 * bare `map[key]` then answers with a function off the prototype chain instead
 * of `undefined` -- so the "is this a setting?" guard never fires, `validate`
 * matches no case in its switch, and `undefined` is written onto the params
 * object. The result is not prototype pollution (writing `undefined` to
 * `__proto__` is a no-op) but something almost as bad: a params object carrying
 * an own `toString: undefined`, on which `String(params)` throws, reaching the
 * store through a path whose whole promise is all-or-nothing.
 *
 * Every spec lookup in this module goes through here. `Object.hasOwn` and not
 * `key in map`, and not a `null`-prototype rebuild of the tables either: the
 * tables stay ordinary objects that read normally, and the RULE lives in one
 * function with one test.
 */
function specFor(
  map: Record<string, FieldSpec>,
  key: string,
): FieldSpec | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/**
 * A numeric field, bounded by the GENERATED contract.
 *
 * Written out rather than spread (`{ kind: "number", ...range }`) because a
 * `PARAM_RANGES` entry also carries `default`, and a spec silently carrying an
 * extra key is how a validator starts drifting from what it validates.
 */
const bounded = (range: { min: number; max: number }): FieldSpec => ({
  kind: "number",
  min: range.min,
  max: range.max,
});

const ENGRAVING_SPEC: FieldSpec = {
  kind: "object",
  fields: {
    edge: { kind: "enum", values: ENGRAVING_EDGES },
    align: { kind: "enum", values: ["start", "center", "end"] },
    text: { kind: "string", maxLength: PARAM_LIMITS.engravings.text.max_length },
    mode: { kind: "enum", values: ["engrave", "emboss", "inlay"] },
    size_mm: bounded(PARAM_RANGES.engravings.size_mm),
    depth_mm: bounded(PARAM_RANGES.engravings.depth_mm),
    font: { kind: "enum", values: ["sans", "serif", "mono"] },
  },
};

const PART_COLOR_SPEC: FieldSpec = {
  kind: "object",
  fields: Object.fromEntries(
    Object.keys(DEFAULT_PRINT_PARAMS.part_colors ?? {}).map((key) => [
      key,
      { kind: "string", pattern: HEX_COLOUR } as FieldSpec,
    ]),
  ),
};

// ---------------------------------------------------------------------------
// v3: place, regions, colour, printer profile, terrain and framing ([V3-P1])
// ---------------------------------------------------------------------------

const hexField: FieldSpec = { kind: "string", pattern: HEX_COLOUR };
/** An unbounded number: the contract itself declares no min/max/maxLength for
 *  these leaves (DECISIONS [V3-P1c]: TypeDefaults, Tint.seed, gradient slot
 *  indices, CustomProfile.change_gcode), so none is invented here either. */
const unboundedNumber: FieldSpec = { kind: "number" };
const unboundedString: FieldSpec = { kind: "string" };

const PLACE_SPEC: FieldSpec = {
  kind: "object",
  fields: {
    country: { kind: "string", maxLength: PARAM_LIMITS.place.country.max_length },
    state: { kind: "string", maxLength: PARAM_LIMITS.place.state.max_length },
    neighbourhood: {
      kind: "string",
      maxLength: PARAM_LIMITS.place.neighbourhood.max_length,
    },
    author: { kind: "string", maxLength: PARAM_LIMITS.place.author.max_length },
  },
};

const REGIONS_SPEC: FieldSpec = {
  kind: "object",
  fields: {
    roads: {
      kind: "object",
      fields: {
        depth_mm: bounded(PARAM_RANGES.regions.roads.depth_mm),
        proud_mm: bounded(PARAM_RANGES.regions.roads.proud_mm),
      },
    },
    water: {
      kind: "object",
      fields: {
        depth_mm: bounded(PARAM_RANGES.regions.water.depth_mm),
        proud_mm: bounded(PARAM_RANGES.regions.water.proud_mm),
      },
    },
    parks: {
      kind: "object",
      fields: {
        depth_mm: bounded(PARAM_RANGES.regions.parks.depth_mm),
        proud_mm: bounded(PARAM_RANGES.regions.parks.proud_mm),
      },
    },
    rail: {
      kind: "object",
      fields: {
        depth_mm: bounded(PARAM_RANGES.regions.rail.depth_mm),
        proud_mm: bounded(PARAM_RANGES.regions.rail.proud_mm),
        width_m: bounded(PARAM_RANGES.regions.rail.width_m),
      },
    },
    building_skirt_mm: bounded(PARAM_RANGES.regions.building_skirt_mm),
  },
};

const REGION_SLOT_KEYS = Object.keys(
  DEFAULT_PRINT_PARAMS.colour?.region_slots ?? {},
) as Array<keyof typeof PARAM_RANGES.colour.region_slots>;

const COLOUR_SPEC: FieldSpec = {
  kind: "object",
  fields: {
    region_slots: {
      kind: "object",
      fields: Object.fromEntries(
        REGION_SLOT_KEYS.map((key) => [key, bounded(PARAM_RANGES.colour.region_slots[key])]),
      ),
    },
    region_colors: {
      kind: "object",
      fields: Object.fromEntries(
        Object.keys(DEFAULT_PRINT_PARAMS.colour?.region_colors ?? {}).map((key) => [
          key,
          hexField,
        ]),
      ),
    },
    palette: { kind: "string", maxLength: PARAM_LIMITS.colour.palette.max_length },
    tint: {
      kind: "object",
      fields: {
        enabled: { kind: "boolean" },
        hue_range_deg: bounded(PARAM_RANGES.colour.tint.hue_range_deg),
        lightness_range: bounded(PARAM_RANGES.colour.tint.lightness_range),
        seed: unboundedNumber,
      },
    },
    gradient: {
      kind: "object",
      fields: {
        enabled: { kind: "boolean" },
        slots: {
          kind: "array",
          maxItems: PARAM_LIMITS.colour.gradient.slots.max_items,
          item: unboundedNumber,
        },
      },
    },
    preview_theme: { kind: "enum", values: ["dark", "light"] },
  },
};

const CUSTOM_PROFILE_SPEC: FieldSpec = {
  kind: "object",
  fields: {
    plate_x_mm: bounded(PARAM_RANGES.custom_profile.plate_x_mm),
    plate_y_mm: bounded(PARAM_RANGES.custom_profile.plate_y_mm),
    max_height_mm: bounded(PARAM_RANGES.custom_profile.max_height_mm),
    nozzle_mm: bounded(PARAM_RANGES.custom_profile.nozzle_mm),
    slots: bounded(PARAM_RANGES.custom_profile.slots),
    change_gcode: unboundedString,
  },
};

const TERRAIN_SPEC: FieldSpec = {
  kind: "object",
  fields: {
    enabled: { kind: "boolean" },
    smoothing: bounded(PARAM_RANGES.terrain.smoothing),
  },
};

const TYPE_DEFAULTS_SPEC: FieldSpec = {
  kind: "object",
  fields: Object.fromEntries(
    Object.keys(DEFAULT_PRINT_PARAMS.heights?.type_defaults ?? {}).map((key) => [
      key,
      unboundedNumber,
    ]),
  ),
};

const HEIGHTS_SPEC: FieldSpec = {
  kind: "object",
  fields: {
    floor_height_m: bounded(PARAM_RANGES.heights.floor_height_m),
    unknown_default_m: bounded(PARAM_RANGES.heights.unknown_default_m),
    type_defaults: TYPE_DEFAULTS_SPEC,
  },
};

const BRIDGES_SPEC: FieldSpec = {
  kind: "object",
  fields: {
    enabled: { kind: "boolean" },
    clearance_mm: bounded(PARAM_RANGES.bridges.clearance_mm),
    abutments: { kind: "boolean" },
  },
};

const HEIGHT_EXAGGERATION_SPEC: FieldSpec = {
  kind: "object",
  fields: {
    multiplier: bounded(PARAM_RANGES.height_exaggeration.multiplier),
    curve: bounded(PARAM_RANGES.height_exaggeration.curve),
  },
};

const HERO_AUTO_SPEC: FieldSpec = {
  kind: "object",
  fields: {
    enabled: { kind: "boolean" },
    count: bounded(PARAM_RANGES.hero_auto.count),
  },
};

const TILING_SPEC: FieldSpec = {
  kind: "object",
  fields: {
    enabled: { kind: "boolean" },
    cols: bounded(PARAM_RANGES.tiling.cols),
    rows: bounded(PARAM_RANGES.tiling.rows),
    joint: { kind: "enum", values: ["dovetail", "pin"] },
    tolerance_mm: bounded(PARAM_RANGES.tiling.tolerance_mm),
    index_mark: { kind: "boolean" },
  },
};

const FRAME_STYLE_SPEC: FieldSpec = {
  kind: "object",
  fields: {
    profile: {
      kind: "enum",
      values: [
        "plain",
        "chamfer",
        "stepped",
        "bevel_in",
        "bullnose",
        "ogee",
        "floating",
      ],
    },
    corner: { kind: "enum", values: ["square", "mitred", "rounded"] },
    corner_radius_mm: bounded(PARAM_RANGES.frame_style.corner_radius_mm),
    lip_depth_mm: bounded(PARAM_RANGES.frame_style.lip_depth_mm),
    shadow_gap: {
      kind: "object",
      fields: {
        enabled: { kind: "boolean" },
        width_mm: bounded(PARAM_RANGES.frame_style.shadow_gap.width_mm),
        depth_mm: bounded(PARAM_RANGES.frame_style.shadow_gap.depth_mm),
      },
    },
    matting: {
      kind: "object",
      fields: {
        enabled: { kind: "boolean" },
        width_mm: bounded(PARAM_RANGES.frame_style.matting.width_mm),
        proud_mm: bounded(PARAM_RANGES.frame_style.matting.proud_mm),
      },
    },
    separate: {
      kind: "object",
      fields: {
        enabled: { kind: "boolean" },
        mount: { kind: "enum", values: ["snap", "magnet"] },
        tolerance_mm: bounded(PARAM_RANGES.frame_style.separate.tolerance_mm),
      },
    },
    texture: {
      kind: "object",
      fields: {
        pattern: { kind: "enum", values: ["none", "brush", "knurl", "hatch", "dots"] },
        scale_mm: bounded(PARAM_RANGES.frame_style.texture.scale_mm),
        depth_mm: bounded(PARAM_RANGES.frame_style.texture.depth_mm),
      },
    },
  },
};

const HANGER_MAGNET_SPEC: FieldSpec = {
  kind: "object",
  fields: {
    diameter_mm: bounded(PARAM_RANGES.hanger_magnet.diameter_mm),
    thickness_mm: bounded(PARAM_RANGES.hanger_magnet.thickness_mm),
    count: bounded(PARAM_RANGES.hanger_magnet.count),
  },
};

/**
 * One entry per `PrintParams` key.
 *
 * The bounds are read from the GENERATED `PARAM_RANGES` / `PARAM_LIMITS`, never
 * re-typed. The ENUM MEMBERS are the one thing the generator does not emit as a
 * runtime value, so they are written out here and `share.test.ts`'s
 * `PRINT_PARAM_SPEC` suite asserts that this table's keys are exactly the
 * contract's keys and that every enum contains the contract's own default --
 * which is what catches a renamed or removed variant.
 */
export const PRINT_PARAM_SPEC: Record<string, FieldSpec> = {
  // Audit v3-02 finding 11: the frozen contract's `schema_version` is
  // `2 | 3` (not required, `contracts.ts:385`'s default is 3), so a share
  // link honestly carrying either value is legal on the wire -- a literal
  // pinned to 2 alone refused a link naming the CURRENT default and, read
  // the other way, would have accepted a link naming a version this build
  // does not really default to without saying so.
  schema_version: { kind: "literal", values: [2, 3] },
  plate_mm: bounded(PARAM_RANGES.plate_mm),
  base_thickness_mm: bounded(PARAM_RANGES.base_thickness_mm),
  nozzle_mm: bounded(PARAM_RANGES.nozzle_mm),
  small_scale: bounded(PARAM_RANGES.small_scale),
  large_scale: bounded(PARAM_RANGES.large_scale),
  terrain_exaggeration: bounded(PARAM_RANGES.terrain_exaggeration),
  road_mode: { kind: "enum", values: ["engrave", "emboss", "off"] },
  road_scale: bounded(PARAM_RANGES.road_scale),
  trees: { kind: "boolean" },
  water: { kind: "boolean" },
  frame: { kind: "boolean" },
  city_label: { kind: "string", maxLength: PARAM_LIMITS.city_label.max_length },
  color_mode: { kind: "enum", values: ["single", "parts"] },
  part_colors: PART_COLOR_SPEC,
  engravings: {
    kind: "array",
    maxItems: PARAM_LIMITS.engravings.max_items,
    item: ENGRAVING_SPEC,
  },
  north_arrow: {
    kind: "object",
    fields: {
      enabled: { kind: "boolean" },
      corner: { kind: "enum", values: ["ne", "nw", "se", "sw"] },
      size_mm: bounded(PARAM_RANGES.north_arrow.size_mm),
    },
  },
  scale_bar: {
    kind: "object",
    fields: {
      enabled: { kind: "boolean" },
      edge: { kind: "enum", values: EDGES },
      length_mode: { kind: "enum", values: ["auto", "fixed"] },
      length_m: bounded(PARAM_RANGES.scale_bar.length_m),
    },
  },
  hanger: { kind: "enum", values: ["none", "keyhole", "magnets", "cleat", "easel"] },
  underside_mark: {
    kind: "object",
    fields: {
      enabled: { kind: "boolean" },
      template: {
        kind: "string",
        maxLength: PARAM_LIMITS.underside_mark.template.max_length,
      },
    },
  },
  hero_building_ids: {
    kind: "array",
    maxItems: PARAM_LIMITS.hero_building_ids.max_items,
    item: { kind: "string", maxLength: 64 },
  },
  hero_mode: { kind: "enum", values: ["true_height", "own_color", "both"] },
  place: PLACE_SPEC,
  regions: REGIONS_SPEC,
  colour: COLOUR_SPEC,
  printer_profile: {
    kind: "enum",
    values: [
      "custom",
      "bambu-h2s",
      "bambu-p1s",
      "bambu-x1c",
      "bambu-a1",
      "bambu-a1-mini",
      "prusa-mk4",
      "prusa-mini",
      "ender-3",
    ],
  },
  custom_profile: CUSTOM_PROFILE_SPEC,
  export_target: {
    kind: "enum",
    values: [
      "bambu-3mf",
      "generic-3mf",
      "stl",
      "stl-parts-zip",
      "obj",
      "step",
      "color-change-3mf",
    ],
  },
  terrain: TERRAIN_SPEC,
  heights: HEIGHTS_SPEC,
  bridges: BRIDGES_SPEC,
  height_exaggeration: HEIGHT_EXAGGERATION_SPEC,
  hero_auto: HERO_AUTO_SPEC,
  tiling: TILING_SPEC,
  frame_style: FRAME_STYLE_SPEC,
  hanger_magnet: HANGER_MAGNET_SPEC,
};

const SCENE_REQUEST_SPEC: Record<string, FieldSpec> = {
  lat: { kind: "number", min: -90, max: 90 },
  lon: { kind: "number", min: -180, max: 180 },
  radius_m: { kind: "number", min: RADIUS_MIN_M, max: RADIUS_MAX_M },
  rotation_deg: { kind: "number", min: 0, max: 360 },
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

class ShareError extends Error {}

function fail(message: string): never {
  throw new ShareError(message);
}

function validate(value: unknown, spec: FieldSpec, path: string): unknown {
  switch (spec.kind) {
    case "literal":
      if (!spec.values.includes(value as number)) {
        fail(`${path} must be ${spec.values.map(String).join(" or ")}`);
      }
      return value;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(`${path} is not a number`);
      }
      if (spec.min !== undefined && value < spec.min) {
        fail(`${path} is below the ${spec.min} minimum`);
      }
      if (spec.max !== undefined && value > spec.max) {
        fail(`${path} is above the ${spec.max} maximum`);
      }
      return value;
    }
    case "boolean":
      if (typeof value !== "boolean") fail(`${path} is not a true/false value`);
      return value;
    case "string": {
      if (typeof value !== "string") fail(`${path} is not text`);
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        fail(`${path} is longer than ${spec.maxLength} characters`);
      }
      if (spec.pattern !== undefined && !spec.pattern.test(value)) {
        fail(`${path} is not in the form this setting takes`);
      }
      return value;
    }
    case "enum":
      if (typeof value !== "string" || !spec.values.includes(value)) {
        fail(`${path} is not one of ${spec.values.join(", ")}`);
      }
      return value;
    case "array": {
      if (!Array.isArray(value)) fail(`${path} is not a list`);
      if (value.length > spec.maxItems) {
        fail(`${path} holds more than ${spec.maxItems} items`);
      }
      return value.map((item, index) => validate(item, spec.item, `${path}[${index}]`));
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        fail(`${path} is not a group of settings`);
      }
      const out: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        const field = specFor(spec.fields, key);
        if (field === undefined) fail(`${path}.${key} is not a setting`);
        out[key] = validate(raw, field, `${path}.${key}`);
      }
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/** The PrintParams keys whose value differs from the contract default. */
export function paramsDiff(params: PrintParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(PRINT_PARAM_SPEC)) {
    const value = (params as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const fallback = (DEFAULT_PRINT_PARAMS as unknown as Record<string, unknown>)[key];
    // Structural comparison: `part_colors` and the four nested objects are
    // rebuilt by every write, so identity says nothing about equality.
    if (JSON.stringify(value) === JSON.stringify(fallback)) continue;
    out[key] = value;
  }
  return out;
}

/** `v2.<base64url>.<checksum>` for one editor state. */
export function encodeShare(request: SceneRequest, params: PrintParams): string {
  const body = JSON.stringify({
    r: {
      lat: request.lat,
      lon: request.lon,
      radius_m: request.radius_m,
      rotation_deg: request.rotation_deg,
      ...(request.preset_id ? { preset_id: request.preset_id } : {}),
    },
    p: paramsDiff(params),
  });
  return `${SHARE_VERSION}.${bytesToBase64Url(new TextEncoder().encode(body))}.${checksum(body)}`;
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

export type ShareDecode =
  | { ok: true; request: SceneRequest; params: PrintParams }
  | { ok: false; reason: string };

/**
 * Turn a payload back into an editor state, or say why it cannot be.
 *
 * Never throws and never returns a partially applied state: a link either
 * restores everything it names or restores nothing, because a half-applied
 * configuration is the one outcome the user cannot see or undo.
 */
export function decodeShare(payload: string): ShareDecode {
  const trimmed = payload.trim();
  if (trimmed === "") return { ok: false, reason: "the shared link carries no settings" };

  const parts = trimmed.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "this shared link is damaged and was not applied" };
  }
  const [version, encoded, digest] = parts;
  if (version !== SHARE_VERSION) {
    return {
      ok: false,
      reason:
        `this link was made by a different version of FrameCraft (${version}); ` +
        `this one reads ${SHARE_VERSION} links`,
    };
  }

  let body: string;
  try {
    body = new TextDecoder().decode(base64UrlToBytes(encoded));
  } catch {
    return { ok: false, reason: "this shared link is damaged and was not applied" };
  }
  if (checksum(body) !== digest) {
    return {
      ok: false,
      reason: "this shared link was edited or truncated on the way here, so it was not applied",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "this shared link is damaged and was not applied" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "this shared link is damaged and was not applied" };
  }

  const holder = parsed as Record<string, unknown>;
  try {
    const rawRequest = holder.r;
    if (rawRequest === null || typeof rawRequest !== "object" || Array.isArray(rawRequest)) {
      fail("it carries no location");
    }
    const requestFields = rawRequest as Record<string, unknown>;
    const request: SceneRequest = {
      lat: validate(requestFields.lat, SCENE_REQUEST_SPEC.lat, "latitude") as number,
      lon: validate(requestFields.lon, SCENE_REQUEST_SPEC.lon, "longitude") as number,
      radius_m: validate(
        requestFields.radius_m,
        SCENE_REQUEST_SPEC.radius_m,
        "radius",
      ) as number,
      rotation_deg: validate(
        requestFields.rotation_deg,
        SCENE_REQUEST_SPEC.rotation_deg,
        "rotation",
      ) as number,
      preset_id:
        requestFields.preset_id === undefined || requestFields.preset_id === null
          ? null
          : (validate(
              requestFields.preset_id,
              { kind: "string", maxLength: 64 },
              "preset",
            ) as string),
    };

    const rawParams = holder.p ?? {};
    if (rawParams === null || typeof rawParams !== "object" || Array.isArray(rawParams)) {
      fail("its settings block is not a group of settings");
    }
    const params = defaultPrintParams();
    const store = params as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(rawParams as Record<string, unknown>)) {
      const spec = specFor(PRINT_PARAM_SPEC, key);
      if (spec === undefined) {
        return {
          ok: false,
          reason: `this shared link names a setting this version does not have (${key}), so it was not applied`,
        };
      }
      const checked = validate(value, spec, key);
      // A nested group is MERGED over its default rather than replacing it: a
      // hand-made link that sets only `north_arrow.enabled`, or only one of the
      // seven `part_colors`, must still leave a complete object behind, because
      // every consumer from `paletteFor` to the wire contract assumes one.
      store[key] =
        spec.kind === "object"
          ? { ...(store[key] as Record<string, unknown>), ...(checked as object) }
          : checked;
    }
    return { ok: true, request, params };
  } catch (error) {
    const detail = error instanceof ShareError ? error.message : String(error);
    return { ok: false, reason: `this shared link is not valid (${detail}), so it was not applied` };
  }
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** The full link to copy: this page, with the payload as `?s=`. */
export function shareUrl(
  href: string,
  request: SceneRequest,
  params: PrintParams,
): string {
  const url = new URL(href);
  url.searchParams.set(SHARE_PARAM, encodeShare(request, params));
  url.hash = "";
  return url.toString();
}

/** The payload in a query string, or null when there is none. */
export function readShareParam(search: string): string | null {
  const query = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return query.get(SHARE_PARAM);
}
