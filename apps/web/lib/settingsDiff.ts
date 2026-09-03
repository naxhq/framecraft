/**
 * What has moved away from the contract's defaults, per leaf and per section.
 *
 * Three surfaces in the settings panel need the same answer and must never
 * disagree about it:
 *
 *  - the **changes counter** and its drawer, which lists every setting that
 *    differs from the default with a revert button on each row;
 *  - the **per-section reset**, which puts one section's own fields back and
 *    must leave every other field alone;
 *  - the **section summaries**, which say "3 changed" on a collapsed header.
 *
 * So the diff lives here, as pure functions over `PrintParams`, and the panel
 * only renders it.
 *
 * Two rules the whole module rests on:
 *
 *  - **A section owns exactly the leaves its controls write**, read from
 *    `lib/controlCatalog.ts` rather than typed out again. A section reset
 *    therefore cannot touch a field the section does not show (the Frame
 *    section resets `frame_style.corner_radius_mm` and leaves
 *    `frame_style.lip_depth_mm`, which has no control, exactly where it is).
 *  - **Layout state is not a setting** (DECISIONS `[V3.1-O6]`). Which sections
 *    are expanded, the search query and the theme live outside `PrintParams`,
 *    so nothing here can see them and the counter cannot count them.
 */

import { DEFAULT_PRINT_PARAMS, PRINT_PARAM_LEAF_PATHS, type PrintParams } from "./contracts";
import { CONTROLS, controlsInGroup, type ControlSpec } from "./controlCatalog";
import { GROUPS, type GroupId } from "./groups";

// ---------------------------------------------------------------------------
// Reading and writing one leaf
// ---------------------------------------------------------------------------

/**
 * The array-of-objects leaves (`engravings[].text`) collapse onto their array,
 * because one row per engraving field would report seven changes for a single
 * added line and a revert of one of them could not be expressed at all.
 */
export function leafKeyPath(path: string): string {
  const bracket = path.indexOf("[]");
  return bracket === -1 ? path : path.slice(0, bracket);
}

/** The top-level `PrintParams` key a leaf path belongs to. */
export function topLevelKey(path: string): keyof PrintParams {
  return leafKeyPath(path).split(".")[0] as keyof PrintParams;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The value at a dotted path, or `undefined` when any step is missing. */
export function valueAt(params: PrintParams, path: string): unknown {
  let node: unknown = params;
  for (const step of leafKeyPath(path).split(".")) {
    if (!isPlainObject(node)) return undefined;
    node = node[step];
  }
  return node;
}

/** The contract's own value for a path, which is what a revert writes. */
export function defaultAt(path: string): unknown {
  return valueAt(DEFAULT_PRINT_PARAMS, path);
}

/**
 * `params` with `path` set to `value`, rebuilding every object on the way down.
 *
 * Immutable all the way: a mutated nested object keeps its identity and the
 * `previewDeps` memo keyed on it never notices (the reason `store/editor.ts`
 * has `setNested` at all). A missing intermediate object is filled from the
 * contract default rather than from `{}`, so writing one leaf of an absent
 * block cannot produce a half-populated one.
 */
export function withLeaf(params: PrintParams, path: string, value: unknown): PrintParams {
  const steps = leafKeyPath(path).split(".");
  const write = (node: unknown, depth: number, defaults: unknown): unknown => {
    const step = steps[depth];
    const base = isPlainObject(node)
      ? node
      : isPlainObject(defaults)
        ? structuredClone(defaults)
        : {};
    if (depth === steps.length - 1) return { ...base, [step]: value };
    const childDefault = isPlainObject(defaults) ? defaults[step] : undefined;
    return { ...base, [step]: write(base[step], depth + 1, childDefault) };
  };
  return write(params, 0, DEFAULT_PRINT_PARAMS) as PrintParams;
}

/** True when the leaf is not at its contract default. */
export function isChanged(params: PrintParams, path: string): boolean {
  return JSON.stringify(valueAt(params, path)) !== JSON.stringify(defaultAt(path));
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * The leaves one section owns: every `PrintParams` path its controls write,
 * de-duplicated and in schema order.
 *
 * `engravings[].text` and its six siblings collapse onto `engravings`, so the
 * Frame section's reset clears the lettering list in one write rather than
 * seven that each rebuild the same array.
 */
const SECTION_PATHS = new Map<GroupId, readonly string[]>();

export function sectionPaths(group: GroupId): readonly string[] {
  const cached = SECTION_PATHS.get(group);
  if (cached !== undefined) return cached;
  const computed = computeSectionPaths(group);
  SECTION_PATHS.set(group, computed);
  return computed;
}

function computeSectionPaths(group: GroupId): readonly string[] {
  const named = new Set<string>();
  for (const spec of controlsInGroup(group)) {
    if (typeof spec.writes === "string") continue;
    for (const path of spec.writes) named.add(leafKeyPath(path));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of PRINT_PARAM_LEAF_PATHS) {
    const key = leafKeyPath(path);
    if (!named.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** The leaves of one section that are not at their default, in schema order. */
export function changedInSection(params: PrintParams, group: GroupId): readonly string[] {
  return sectionPaths(group).filter((path) => isChanged(params, path));
}

/**
 * `params` with every leaf of one section back at its contract default.
 *
 * Returns the SAME object when the section is already at its defaults, so a
 * caller can skip the write (and therefore the history entry) without
 * comparing two deep structures itself.
 */
export function sectionReset(params: PrintParams, group: GroupId): PrintParams {
  return withDefaults(params, changedInSection(params, group));
}

/** `params` with each named leaf back at its contract default. */
export function withDefaults(params: PrintParams, paths: readonly string[]): PrintParams {
  let out = params;
  for (const path of paths) {
    if (!isChanged(out, path)) continue;
    out = withLeaf(out, path, structuredCloneable(defaultAt(path)));
  }
  return out;
}

/** A default value that is safe to hand to the store: never the frozen constant. */
function structuredCloneable(value: unknown): unknown {
  return value === null || typeof value !== "object" ? value : structuredClone(value);
}

/** The top-level keys a set of leaf paths touches, in schema order. */
export function touchedKeys(paths: readonly string[]): readonly (keyof PrintParams)[] {
  const keys = new Set<string>();
  for (const path of paths) keys.add(topLevelKey(path) as string);
  return [...keys] as (keyof PrintParams)[];
}

// ---------------------------------------------------------------------------
// The changes list
// ---------------------------------------------------------------------------

export interface ChangedSetting {
  /** The leaf, or the array key for `engravings`. */
  path: string;
  /** The control that writes it, when the panel has one. */
  controlId: string | null;
  /** The control's own label, or the humanised path. */
  label: string;
  group: GroupId | null;
  /** The section heading, for the row's second line. */
  groupTitle: string;
  defaultText: string;
  currentText: string;
}

const CONTROL_FOR_LEAF: ReadonlyMap<string, ControlSpec> = (() => {
  const out = new Map<string, ControlSpec>();
  for (const spec of CONTROLS) {
    if (typeof spec.writes === "string") continue;
    for (const path of spec.writes) {
      const key = leafKeyPath(path);
      // The FIRST control that writes a leaf names it: `plate_mm` is the Scale
      // group's slider, not the printer profile that also writes it.
      if (!out.has(key)) out.set(key, spec);
    }
  }
  return out;
})();

const GROUP_TITLES: ReadonlyMap<GroupId, string> = new Map(
  GROUPS.map((group) => [group.id, group.title]),
);

/** Every leaf some control writes, de-duplicated, in schema order. */
export function controllableLeaves(): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of PRINT_PARAM_LEAF_PATHS) {
    const key = leafKeyPath(path);
    if (seen.has(key) || !CONTROL_FOR_LEAF.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Every setting that differs from its default AND has a control to revert it
 * with, in schema order.
 *
 * The fields with no control are deliberately not rows: `place.country` is
 * written by the reverse geocoder from the pin and `heights.type_defaults.*`
 * has no UI, so a "revert" button on either would either do nothing a user
 * asked for or be immediately overwritten. `uncontrolledChanges` reports them
 * separately, and Reset all still puts every one of them back.
 */
export function changedSettings(params: PrintParams): ChangedSetting[] {
  const out: ChangedSetting[] = [];
  for (const path of controllableLeaves()) {
    if (!isChanged(params, path)) continue;
    const spec = CONTROL_FOR_LEAF.get(path);
    out.push({
      path,
      controlId: spec?.id ?? null,
      label: spec?.label ?? humanisePath(path),
      group: spec?.group ?? null,
      groupTitle: spec === undefined ? "" : (GROUP_TITLES.get(spec.group) ?? ""),
      defaultText: formatLeaf(path, defaultAt(path)),
      currentText: formatLeaf(path, valueAt(params, path)),
    });
  }
  return out;
}

/**
 * Fields nothing in the panel writes and nobody typed, with the reason.
 *
 * These are not "changes" in any sense a user would recognise: the three
 * `place.*` names are written by the reverse geocoder the moment the pin lands,
 * so counting them would make "3 changed" the state of a design nobody has
 * touched yet. `schema_version` and `colour.preview_theme` are payload
 * metadata and a viewer setting (DECISIONS `[V3.1-P1-13]`, `[V3.1-O6]`).
 */
export const NOT_A_SETTING: ReadonlyMap<string, string> = new Map([
  ["schema_version", "payload metadata, echoed into the sidecar"],
  ["place.country", "written by the reverse geocoder from the pin"],
  ["place.state", "written by the reverse geocoder from the pin"],
  ["place.neighbourhood", "written by the reverse geocoder from the pin"],
  ["colour.preview_theme", "a viewer setting, toggled in the preview itself"],
]);

/**
 * Changed leaves the panel has no control for, so the drawer can still say
 * that they moved even though no row can revert them.
 *
 * A share link or a project file can carry any leaf, so this is the honest
 * answer to "is anything else different?": today it is the six
 * `heights.type_defaults.*` rows, `custom_profile.nozzle_mm` and
 * `frame_style.lip_depth_mm`, none of which has a control.
 */
export function uncontrolledChanges(params: PrintParams): readonly string[] {
  const controllable = new Set(controllableLeaves());
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of PRINT_PARAM_LEAF_PATHS) {
    const key = leafKeyPath(path);
    if (seen.has(key)) continue;
    seen.add(key);
    if (controllable.has(key) || NOT_A_SETTING.has(key) || !isChanged(params, key)) continue;
    out.push(key);
  }
  return out;
}

/**
 * How many settings the counter reports: everything that differs from the
 * contract's defaults and is a setting at all.
 *
 * Layout state is not in here and cannot be: expanded sections, the search
 * query and the theme never enter `PrintParams` (`[V3.1-O6]`).
 */
export function changeCount(params: PrintParams): number {
  return changedSettings(params).length + uncontrolledChanges(params).length;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** "regions.rail.width_m" -> "Regions rail width". */
export function humanisePath(path: string): string {
  const words = path
    .replace(/\[\]/g, "")
    .split(".")
    .join(" ")
    .replace(/_(mm|m|deg)$/g, "")
    .replace(/_/g, " ")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function unitFor(path: string): string {
  if (path.endsWith("_mm")) return " mm";
  if (path.endsWith("_m")) return " m";
  if (path.endsWith("_deg")) return "°";
  return "";
}

/** One value, in the words the panel uses for it. */
export function formatLeaf(path: string, value: unknown): string {
  if (value === undefined || value === null) return "not set";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") {
    return `${Number(value.toFixed(3))}${unitFor(path)}`;
  }
  if (typeof value === "string") return value === "" ? "empty" : value;
  if (Array.isArray(value)) {
    const noun = path === "engravings" ? "line" : path === "hero_building_ids" ? "hero" : "entry";
    if (value.length === 0) return "none";
    return `${value.length} ${value.length === 1 ? noun : `${noun}s`}`;
  }
  return "changed";
}
