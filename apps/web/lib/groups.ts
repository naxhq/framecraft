/**
 * The twelve control groups of the parameter panel, which ones start open, and
 * the one-line state each collapsed header reports.
 *
 * Keeping the group table here rather than inside the panel means the e2e and
 * the unit tests can name a group without importing React, and both the
 * collapse state and the header summaries can be tested without a DOM.
 *
 * Storage rules (every one of them is a real failure mode seen in the wild):
 *  - every `localStorage` access is wrapped in try/catch, because Safari's
 *    private mode throws on `getItem` as well as on `setItem`;
 *  - no stored value, a corrupt value, a value that is not an object and an
 *    unknown group id all fall back to the defaults rather than to `{}`, so a
 *    first visit renders the defaults instead of rendering nothing;
 *  - an unknown key in storage is ignored, so an old build's key cannot
 *    resurrect a group that no longer exists.
 *
 * Which sections are expanded is LAYOUT, not a setting (DECISIONS
 * `[V3.1-O6]`): it is per device, it never enters `PrintParams`, and it never
 * counts as a change from the default.
 */

import { PARAM_RANGES, type PrintParams } from "./contracts";
import { HERO_CAP } from "./heroes";
import { PRINTER_PROFILES, isPrinterProfileId } from "./printers";
import { FRAME_WIDTH_MM } from "./transform";

export const GROUP_STORAGE_KEY = "framecraft-groups";

export type GroupId =
  | "location"
  | "scale"
  | "buildings"
  | "heights"
  | "surface"
  | "regions"
  | "bridges"
  | "terrain"
  | "frame"
  | "colour"
  | "printer"
  | "output";

export interface GroupSpec {
  id: GroupId;
  /** The heading, in the interface's voice. */
  title: string;
  /** One line under the heading saying what the group decides. */
  summary: string;
  /** Collapsed groups start closed on a first visit. */
  collapsedByDefault: boolean;
}

/**
 * Display order. Location first because nothing else means anything without a
 * place; Output last because it is where the file comes out.
 *
 * **Only Location and Scale start open.** Twelve open sections is a 4000 px
 * scroll on a 1280 screen, which is how the panel ends up being read by
 * scrolling rather than by looking: the two that are open are the two every
 * design starts with (where it is, and how big it prints), and every other
 * section states its own state on its header so it does not have to be opened
 * to be read.
 */
export const GROUPS: readonly GroupSpec[] = [
  {
    id: "location",
    title: "Location",
    summary: "Where the model is cut from, and which way round.",
    collapsedByDefault: false,
  },
  {
    id: "scale",
    title: "Scale and size",
    summary: "Plate, base and nozzle: these three set the printed scale.",
    collapsedByDefault: false,
  },
  {
    id: "buildings",
    title: "Buildings",
    summary: "Height multipliers and the buildings you want to stand out.",
    collapsedByDefault: true,
  },
  {
    id: "heights",
    title: "Heights",
    summary: "How a missing OSM height is guessed, and how much taller the model reads.",
    collapsedByDefault: true,
  },
  {
    id: "surface",
    title: "Surface",
    summary: "Roads, water and trees on the plate.",
    collapsedByDefault: true,
  },
  {
    id: "regions",
    title: "Surface depths",
    summary: "How deep each surface is cut, and how far it sits above or below the plate top.",
    collapsedByDefault: true,
  },
  {
    id: "bridges",
    title: "Bridges",
    summary: "What happens where a road or a railway crosses above the ground.",
    collapsedByDefault: true,
  },
  {
    id: "terrain",
    title: "Terrain",
    summary: "Real ground elevation, draped under the model.",
    collapsedByDefault: true,
  },
  {
    id: "frame",
    title: "Frame and text",
    summary: "The border, the lettering cut into it, and the fittings.",
    collapsedByDefault: true,
  },
  {
    id: "colour",
    title: "Colour",
    summary: "A filament slot and a colour for every region of the model.",
    collapsedByDefault: true,
  },
  {
    id: "printer",
    title: "Printer",
    summary: "The plate, the height ceiling and how the model splits to fit them.",
    collapsedByDefault: true,
  },
  {
    id: "output",
    title: "Output",
    summary: "The model, the files and the measured stats.",
    collapsedByDefault: false,
  },
] as const;

export const GROUP_IDS: readonly GroupId[] = GROUPS.map((group) => group.id);

/** The group table, by id. */
export function groupSpec(id: GroupId): GroupSpec {
  const spec = GROUPS.find((group) => group.id === id);
  if (spec === undefined) throw new Error(`groups: no group named ${id}`);
  return spec;
}

export type CollapsedGroups = Record<GroupId, boolean>;

/** The first-visit state: Location and Scale open, everything else closed. */
export function defaultCollapsed(): CollapsedGroups {
  const out = {} as CollapsedGroups;
  for (const group of GROUPS) out[group.id] = group.collapsedByDefault;
  return out;
}

/**
 * Merge whatever is in storage over the defaults.
 *
 * Exported separately from `loadCollapsed` so the parsing rules can be tested
 * without stubbing `window`.
 */
export function mergeCollapsed(raw: unknown): CollapsedGroups {
  const out = defaultCollapsed();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const group of GROUPS) {
    const value = (raw as Record<string, unknown>)[group.id];
    if (typeof value === "boolean") out[group.id] = value;
  }
  return out;
}

/** Read the persisted collapse state; never throws, never returns partial. */
export function loadCollapsed(): CollapsedGroups {
  if (typeof window === "undefined") return defaultCollapsed();
  try {
    const stored = window.localStorage.getItem(GROUP_STORAGE_KEY);
    if (!stored) return defaultCollapsed();
    return mergeCollapsed(JSON.parse(stored));
  } catch {
    // Private mode, disabled storage, or a value that is not JSON.
    return defaultCollapsed();
  }
}

/** Persist the collapse state. A storage failure is not worth a broken panel. */
export function saveCollapsed(state: CollapsedGroups): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The in-memory state still works for this session.
  }
}

// ---------------------------------------------------------------------------
// Header summaries
// ---------------------------------------------------------------------------

/**
 * What a header needs beyond `PrintParams` to describe its own section.
 *
 * `heroCount` is the EFFECTIVE hero set (hand-picked plus auto-promoted), which
 * only the panel can compute because the automatic half reads the scene; the
 * radius and the rotation are `LocationState`, not parameters
 * (`[V3.1-P1-10]`).
 */
export interface SummaryContext {
  heroCount: number;
  radiusM: number;
  rotationDeg: number;
}

function mm(value: number): string {
  return `${Number(value.toFixed(2))} mm`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)} %`;
}

/**
 * The one line a collapsed header shows about its own section, computed from
 * the current parameters.
 *
 * Never a fixed string: the point of the line is that a section can be READ
 * without being opened, so every summary names values that move. What each one
 * names is the two or three fields that decide what that section does to the
 * printed object.
 */
export function summariseGroup(
  id: GroupId,
  params: PrintParams,
  context: SummaryContext,
): string {
  switch (id) {
    case "location": {
      const label = (params.city_label ?? "").trim();
      const parts = [label === "" ? "no place name" : label, `${context.radiusM} m radius`];
      if (context.rotationDeg !== 0) parts.push(`${context.rotationDeg}° turn`);
      return parts.join(", ");
    }
    case "scale":
      return [
        `${mm(params.plate_mm)} plate`,
        `${mm(params.base_thickness_mm)} base`,
        `${mm(params.nozzle_mm)} nozzle`,
      ].join(", ");
    case "buildings": {
      const parts = [`${context.heroCount}/${HERO_CAP} heroes`];
      if (params.small_scale !== PARAM_RANGES.small_scale.default) {
        parts.push(`small ${percent(params.small_scale)}`);
      }
      if (params.large_scale !== PARAM_RANGES.large_scale.default) {
        parts.push(`tall ${percent(params.large_scale)}`);
      }
      return parts.join(", ");
    }
    case "heights": {
      const heights = params.heights ?? {};
      const floor = heights.floor_height_m ?? PARAM_RANGES.heights.floor_height_m.default;
      const unknown = heights.unknown_default_m ?? PARAM_RANGES.heights.unknown_default_m.default;
      const multiplier =
        params.height_exaggeration?.multiplier ??
        PARAM_RANGES.height_exaggeration.multiplier.default;
      const parts = [`${floor} m storeys`, `${unknown} m fallback`];
      if (multiplier !== PARAM_RANGES.height_exaggeration.multiplier.default) {
        parts.push(`${percent(multiplier)} taller`);
      }
      return parts.join(", ");
    }
    case "surface": {
      const roads =
        params.road_mode === "off"
          ? "no roads"
          : params.road_mode === "emboss"
            ? "roads embossed"
            : "roads engraved";
      return [roads, params.water ? "water" : "no water", params.trees ? "trees" : "no trees"].join(
        ", ",
      );
    }
    case "regions": {
      const regions = params.regions ?? {};
      const roads = regions.roads?.depth_mm ?? PARAM_RANGES.regions.roads.depth_mm.default;
      const water = regions.water?.depth_mm ?? PARAM_RANGES.regions.water.depth_mm.default;
      const rail = regions.rail?.width_m ?? PARAM_RANGES.regions.rail.width_m.default;
      return `roads ${mm(roads)} deep, water ${mm(water)}, rail ${rail} m wide`;
    }
    case "bridges": {
      const bridges = params.bridges ?? {};
      if (bridges.enabled === false) return "off, everything laid at ground level";
      const clearance = bridges.clearance_mm ?? PARAM_RANGES.bridges.clearance_mm.default;
      return `on, ${mm(clearance)} clearance, ${bridges.abutments === false ? "no abutments" : "abutments"}`;
    }
    case "terrain": {
      if (params.terrain?.enabled !== true) return "off, the base stays flat";
      return `on, ${percent(params.terrain_exaggeration ?? 1)} relief`;
    }
    case "frame": {
      if (params.frame === false) return "no frame, the city runs to the edge";
      const lines = (params.engravings ?? []).length;
      const profile = params.frame_style?.profile ?? "plain";
      return [
        profile,
        `${mm(FRAME_WIDTH_MM)} border`,
        `${lines} ${lines === 1 ? "line" : "lines"}`,
      ].join(", ");
    }
    case "colour": {
      const palette = params.colour?.palette ?? "default";
      const mode = params.color_mode === "parts" ? "one filament per part" : "one filament";
      const gradient = params.colour?.gradient?.enabled === true;
      return gradient ? `${palette}, ${mode}, height bands` : `${palette}, ${mode}`;
    }
    case "printer": {
      const profile = params.printer_profile ?? "custom";
      const name =
        isPrinterProfileId(profile) && profile !== "custom"
          ? PRINTER_PROFILES[profile].label
          : "custom printer";
      const tiling = params.tiling;
      if (tiling?.enabled === true) {
        return `${name}, ${tiling.cols ?? 1} by ${tiling.rows ?? 1} tiles`;
      }
      return `${name}, one piece`;
    }
    case "output":
      return `${params.export_target ?? "bambu-3mf"} file`;
  }
}
