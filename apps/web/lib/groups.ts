/**
 * The nine control groups of the parameter panel, and the persistence of
 * which ones are collapsed.
 *
 * Keeping the group table here rather than inside the panel means the e2e and
 * the unit tests can name a group without importing React, and the collapse
 * state can be tested without a DOM.
 *
 * Storage rules (every one of them is a real failure mode seen in the wild):
 *  - every `localStorage` access is wrapped in try/catch, because Safari's
 *    private mode throws on `getItem` as well as on `setItem`;
 *  - no stored value, a corrupt value, a value that is not an object and an
 *    unknown group id all fall back to the defaults rather than to `{}`, so a
 *    first visit renders the groups OPEN instead of rendering nothing;
 *  - an unknown key in storage is ignored, so an old build's key cannot
 *    resurrect a group that no longer exists.
 */

export const GROUP_STORAGE_KEY = "framecraft-groups";

export type GroupId =
  | "location"
  | "scale"
  | "buildings"
  | "heights"
  | "surface"
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
 * Frame and text, and colour, start collapsed: they are personalisation, and
 * they are the two longest groups. Everything that changes the shape of the
 * model starts open.
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
    collapsedByDefault: false,
  },
  {
    id: "heights",
    title: "Heights",
    summary: "How a missing OSM height is guessed, and how much taller the model reads.",
    collapsedByDefault: false,
  },
  {
    id: "surface",
    title: "Surface",
    summary: "Roads, water and trees on the plate.",
    collapsedByDefault: false,
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

export type CollapsedGroups = Record<GroupId, boolean>;

/** The first-visit state: everything open except the two personalisation groups. */
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
