/**
 * Per-object overrides, from the editor's side (v3.1 Task 11).
 *
 * `lib/engine/solid/overrides.ts` is the engine's half: it answers the
 * questions the geometry stages ask. This is the half the inspector needs -
 * what a row looks like before it has been edited, what editing one does to the
 * array, which actions are worth offering for an object of a given kind, and
 * which rows this scene can no longer reach. Both halves read the SAME
 * contract, and the grouping, the reconciliation and the region names come from
 * the engine module rather than being re-derived here, so the panel can never
 * disagree with the plate.
 *
 * Nothing here touches the store or React: it is data in, data out, so the
 * whole of the override edit path is testable without a renderer.
 */

import { PARAM_LIMITS, type ObjectOverride, type PrintParams, type SceneGraph } from "./contracts";
import type { GroupId } from "./groups";
import {
  OVERRIDE_MAX_REGIONS,
  overrideGroups,
  reconcileOverrides,
  type OverrideLayer,
} from "./engine/solid/overrides";

export type { OverrideLayer };
export { OVERRIDE_MAX_REGIONS };

/** How many override rows a payload may carry (`print_params.json`). */
export const OVERRIDE_MAX_ITEMS: number = PARAM_LIMITS.object_overrides.max_items;

/**
 * A row with every member at its contract default.
 *
 * Written out rather than read off `DEFAULT_PRINT_PARAMS`, because the default
 * for `object_overrides` is an EMPTY list: there is no example row to copy. The
 * values below are the schema's own, and `objectOverrides.test.ts` checks each
 * against the contract so this cannot drift from it.
 */
export function emptyOverride(osmId: string, layer: OverrideLayer): ObjectOverride {
  return {
    osm_id: osmId,
    layer,
    hidden: false,
    height_scale: 1,
    hero: "inherit",
    tint: "",
    slot: 0,
    color: "",
    road_mode: "inherit",
    width_scale: 1,
    raise_mm: 0,
  };
}

/** True when a row asks for nothing at all, so keeping it would be noise. */
export function isNeutralOverride(row: ObjectOverride): boolean {
  return (
    row.hidden !== true &&
    (row.height_scale ?? 1) === 1 &&
    (row.hero ?? "inherit") === "inherit" &&
    (row.tint ?? "") === "" &&
    (row.slot ?? 0) === 0 &&
    (row.color ?? "") === "" &&
    (row.road_mode ?? "inherit") === "inherit" &&
    (row.width_scale ?? 1) === 1 &&
    (row.raise_mm ?? 0) === 0
  );
}

export function overrideRows(params: PrintParams): readonly ObjectOverride[] {
  return params.object_overrides ?? [];
}

/** The row for one object, or null when the user has never touched it. */
export function findOverride(
  params: PrintParams,
  osmId: string,
  layer: OverrideLayer,
): ObjectOverride | null {
  return overrideRows(params).find((row) => row.osm_id === osmId && row.layer === layer) ?? null;
}

/** What a write to the override list did. */
export interface OverrideWrite {
  /** The whole new list, ready to hand to `setParam("object_overrides", ...)`. */
  overrides: ObjectOverride[];
  /**
   * True when the write was REFUSED because the list is already at
   * {@link OVERRIDE_MAX_ITEMS}. `overrides` is then the list unchanged: a cap
   * that silently dropped the oldest decision would lose work the user cannot
   * see, and one that silently dropped the new one would look like a broken
   * control.
   */
  capped: boolean;
}

/**
 * One object's row with `patch` merged in.
 *
 * Three cases, and each is the obvious one:
 *
 * - the row exists and the result still asks for something: it is replaced in
 *   place, so the order of the list - and therefore which override gets which
 *   `override_N` region - does not move under the user's hands;
 * - the row exists and the result asks for nothing: it is removed, so
 *   "put it back the way it was" leaves a project file identical to one where
 *   the object was never touched;
 * - the row does not exist: it is appended, unless the list is full.
 */
export function withOverride(
  params: PrintParams,
  osmId: string,
  layer: OverrideLayer,
  patch: Partial<Omit<ObjectOverride, "osm_id" | "layer">>,
): OverrideWrite {
  const rows = overrideRows(params);
  const at = rows.findIndex((row) => row.osm_id === osmId && row.layer === layer);
  const next: ObjectOverride = { ...(at >= 0 ? rows[at] : emptyOverride(osmId, layer)), ...patch };
  if (at >= 0) {
    const overrides = [...rows];
    if (isNeutralOverride(next)) overrides.splice(at, 1);
    else overrides[at] = next;
    return { overrides, capped: false };
  }
  if (isNeutralOverride(next)) return { overrides: [...rows], capped: false };
  if (rows.length >= OVERRIDE_MAX_ITEMS) return { overrides: [...rows], capped: true };
  return { overrides: [...rows, next], capped: false };
}

/** The list with one object's row removed, whatever it said. */
export function withoutOverride(
  params: PrintParams,
  osmId: string,
  layer: OverrideLayer,
): ObjectOverride[] {
  return overrideRows(params).filter((row) => !(row.osm_id === osmId && row.layer === layer));
}

/**
 * `override_N` -> the layer that region's group came out of.
 *
 * What `objectInfo.ts:objectAt` needs to name an object inside an override
 * region: the region name alone cannot say whether it holds buildings or a
 * road, and nothing drawn in the viewport may read a parameter to find out.
 */
export function overrideLayerByRegion(params: PrintParams): ReadonlyMap<string, OverrideLayer> {
  const out = new Map<string, OverrideLayer>();
  for (const group of overrideGroups(params).groups) out.set(group.region, group.layer);
  return out;
}

/**
 * The rows this scene has no object for.
 *
 * They are KEPT: a crop that no longer reaches an object must not destroy the
 * decision taken on it, because widening the crop again has to bring it back.
 * The inspector shows them as inactive and the build reports the count.
 */
export interface OverrideStatus {
  active: ObjectOverride[];
  inactive: ObjectOverride[];
}

export function overrideStatus(scene: SceneGraph | null, params: PrintParams): OverrideStatus {
  const rows = overrideRows(params);
  if (scene === null) return { active: [], inactive: [...rows] };
  const split = reconcileOverrides(scene, params);
  return {
    active: split.active.map((index) => rows[index]),
    inactive: split.inactive.map((index) => rows[index]),
  };
}

/** True when this object's row exists and this scene cannot reach the object. */
export function isOverrideInactive(
  scene: SceneGraph | null,
  params: PrintParams,
  osmId: string,
  layer: OverrideLayer,
): boolean {
  return overrideStatus(scene, params).inactive.some((row) => row.osm_id === osmId && row.layer === layer);
}

// ---------------------------------------------------------------------------
// What the inspector offers, per kind
// ---------------------------------------------------------------------------

/**
 * The actions valid for one kind of object.
 *
 * The lists are exactly the members of `ObjectOverride` that mean something on
 * that layer, in the order the inspector shows them. A control the layer cannot
 * act on is not shown greyed out, it is not there: an override that does
 * nothing is worse than no control, because it looks like a setting that
 * failed.
 */
export type OverrideAction =
  | "hide"
  | "height_scale"
  | "hero"
  | "tint"
  | "colour"
  | "road_mode"
  | "width_scale"
  | "raise_mm"
  | "reset";

const BUILDING_ACTIONS: readonly OverrideAction[] = [
  "hero",
  "height_scale",
  "colour",
  "tint",
  "hide",
  "reset",
];

const ROAD_ACTIONS: readonly OverrideAction[] = ["road_mode", "width_scale", "colour", "hide", "reset"];

const AREA_ACTIONS: readonly OverrideAction[] = ["raise_mm", "colour", "hide", "reset"];

export function actionsForLayer(layer: OverrideLayer): readonly OverrideAction[] {
  if (layer === "building") return BUILDING_ACTIONS;
  if (layer === "road") return ROAD_ACTIONS;
  return AREA_ACTIONS;
}

/**
 * Where a right-click on something that is NOT an OSM object goes.
 *
 * The frame, the base, the matting and the lettering have no per-object
 * override and never will: none of them is an OSM element, so there is no id to
 * key a decision by. What the inspector offers on them instead is the way into
 * the settings that DO shape them, which is the honest answer to "I want to
 * change this thing I just clicked". `groupId` is a `lib/groups.ts` id, so the
 * label and the panel cannot drift apart.
 */
export interface SettingsJump {
  label: string;
  groupId: GroupId;
}

const JUMP_SCALE: SettingsJump = { label: "Scale and size settings", groupId: "scale" };
const JUMP_FRAME: SettingsJump = { label: "Frame and text settings", groupId: "frame" };
const JUMP_COLOUR: SettingsJump = { label: "Colour settings", groupId: "colour" };
const JUMP_SURFACE: SettingsJump = { label: "Surface depth settings", groupId: "regions" };

/**
 * The jumps offered for one region of the printed model.
 *
 * Keyed by the region a right-click landed on, so "the frame" really means the
 * frame: the inspector's own raycast runs on the context-menu event alone and
 * therefore reaches the base and the frame, which no hover does.
 */
export function jumpsForRegion(region: string | null): readonly SettingsJump[] {
  if (region === "frame" || region === "matting" || region === "lettering" || region === "attribution") {
    return [JUMP_FRAME, JUMP_COLOUR];
  }
  if (region === "easel" || region === "cleat") return [JUMP_FRAME, JUMP_SCALE];
  if (region === "rail") return [JUMP_SURFACE, JUMP_COLOUR];
  return [JUMP_SCALE, JUMP_COLOUR];
}

/** A short name for the region a right-click landed on, for the menu heading. */
export function regionHeading(region: string | null): string {
  const labels: Record<string, string> = {
    base: "Base plate",
    frame: "Frame",
    matting: "Matting",
    lettering: "Lettering",
    attribution: "Attribution mark",
    rail: "Rail",
    easel: "Easel stand",
    cleat: "Cleat mount",
  };
  return region === null ? "The plate" : (labels[region] ?? "The plate");
}

/** One line saying what a row currently asks for, for the inspector's summary. */
export function describeOverride(row: ObjectOverride): string {
  const parts: string[] = [];
  if (row.hidden === true) parts.push("hidden");
  if ((row.height_scale ?? 1) !== 1) parts.push(`height ${formatMultiplier(row.height_scale ?? 1)}`);
  if ((row.hero ?? "inherit") === "on") parts.push("hero");
  if ((row.hero ?? "inherit") === "off") parts.push("not a hero");
  if ((row.road_mode ?? "inherit") !== "inherit") parts.push(`roads ${row.road_mode ?? ""}`);
  if ((row.width_scale ?? 1) !== 1) parts.push(`width ${formatMultiplier(row.width_scale ?? 1)}`);
  if ((row.raise_mm ?? 0) !== 0) {
    const raise = row.raise_mm ?? 0;
    parts.push(`${raise > 0 ? "raised" : "sunk"} ${Math.abs(raise).toFixed(2)} mm`);
  }
  if ((row.slot ?? 0) !== 0) parts.push(`slot ${row.slot ?? 0}`);
  if ((row.color ?? "") !== "") parts.push("own colour");
  if ((row.tint ?? "") !== "") parts.push("own shade");
  return parts.length === 0 ? "Nothing changed" : capitalise(parts.join(", "));
}

function formatMultiplier(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded}x`;
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}
