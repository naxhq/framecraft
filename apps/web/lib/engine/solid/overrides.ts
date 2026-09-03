/**
 * Per-object overrides: what the right-click inspector writes, resolved into
 * the handful of questions the geometry stages actually ask (v3.1 Task 11).
 *
 * `PrintParams.object_overrides` is a flat list of rows keyed by BASE OSM id.
 * Nothing downstream wants that list; each stage wants one answer:
 *
 *  - `repair-buildings` wants "is this building hidden, and by what does its
 *    height move";
 *  - `heroes` wants "which ids were marked, which unmarked";
 *  - `buildings` wants the tint table and which buildings leave the ordinary
 *    band split;
 *  - `surface-roads` / `surface-water` / `surface-parks` want "which of my
 *    objects are gone, which are somebody else's now, and how wide";
 *  - `surface-overrides` and every `finish-override_N` want the GROUPS.
 *
 * Each function below reads exactly the contract leaves its answer depends on,
 * so the stage that calls it can claim exactly those and no more. That is not
 * cosmetic: the pipeline's strict-claims proxy throws on an undeclared read and
 * the incremental cache invalidates on a declared one, so a helper that read the
 * whole row would make a tint change re-run the road repair.
 *
 * ## Why an override can need a region of its own
 *
 * A region IS the colour partition (`lib/engine/types.ts`): its `slot` and
 * `colorHex` are what the 3MF writes per part, and a region carries ONE of each.
 * So an object given its own filament, or its own place relative to the base
 * top, cannot stay in the region its layer prints in; it moves into one of the
 * four `override_N` regions. Overrides that change geometry only - hide, height,
 * width, hero, tint - need no region and are limited only by the array's own
 * cap.
 *
 * Objects asking for the SAME treatment share a group, so recolouring ten
 * buildings the same gold costs one region, not ten.
 */

import type { AreaFeature, Building, PrintParams, Road, SceneGraph } from "../../contracts";
import { sourceOsmId } from "../../objectInfo";
import type { RegionName } from "../types";
import { regionColor, regionSlot } from "./context";

/** The four SceneGraph layers an override may name (`ObjectOverride.layer`). */
export type OverrideLayer = "building" | "road" | "water" | "green";

export const OVERRIDE_LAYERS: readonly OverrideLayer[] = ["building", "road", "water", "green"];

/**
 * How many overrides may ask for a printed treatment of their own.
 *
 * Four, because four is the filament slot count of the default printer profile
 * (`custom_profile.slots`) and the number the default region assignment already
 * spends; a fifth distinct override colour has no extruder to come out of. The
 * fifth group and beyond print in their layer's own filament and the build says
 * so (`override-regions-capped`). The ARRAY cap is `PARAM_LIMITS.object_overrides`
 * and is much larger, because a hide or a height scale costs no region at all.
 */
export const OVERRIDE_MAX_REGIONS = 4;

/** The region names the groups are handed out in order, `override_1` first. */
export const OVERRIDE_REGION_NAMES: readonly RegionName[] = [
  "override_1",
  "override_2",
  "override_3",
  "override_4",
];

/** The 1-based override group a region name carries, or null. */
export function overrideIndexOf(region: string): number | null {
  const match = /^override_(\d+)$/.exec(region);
  if (match === null) return null;
  const index = Number(match[1]);
  return index >= 1 && index <= OVERRIDE_MAX_REGIONS ? index : null;
}

/** The surface layer an override's own layer prints in; null for a building. */
export function surfaceOfLayer(layer: OverrideLayer): "roads" | "water" | "parks" | null {
  if (layer === "road") return "roads";
  if (layer === "water") return "water";
  if (layer === "green") return "parks";
  return null;
}

/** The region an override's layer prints in when nothing overrides it. */
export function regionOfLayer(layer: OverrideLayer): RegionName {
  return layer === "building" ? "buildings" : (surfaceOfLayer(layer) as RegionName);
}

/**
 * The base OSM element id of a scene entity: the id an override is written
 * against.
 *
 * Buildings and roads go through `objectInfo.ts:sourceOsmId`, the one place the
 * sparse-encoding rule lives ("`osm_id` absent means `id` IS the source id").
 * An `AreaFeature` has no `id` at all and carries `osm_id` outright, and it may
 * be absent on a dissolved polygon the ingest could not attribute, which is a
 * polygon no override can name.
 */
export function baseOsmIdOfBuilding(building: Building): string {
  return sourceOsmId(building);
}

export function baseOsmIdOfRoad(road: Road): string {
  return sourceOsmId(road);
}

export function baseOsmIdOfArea(feature: AreaFeature): string | null {
  return feature.osm_id ?? null;
}

// ---------------------------------------------------------------------------
// The per-question readers
// ---------------------------------------------------------------------------

type OverrideRow = NonNullable<PrintParams["object_overrides"]>[number];

/** The rows, as a plain array, without reading anything inside them. */
function rowsOf(params: PrintParams): readonly OverrideRow[] {
  const list = params.object_overrides;
  return list === undefined ? [] : list;
}

/**
 * Base OSM ids the user took out of the model on one layer.
 *
 * A road switched `off` is hidden by another name, so it is folded in here: both
 * mean "no ribbon, no pocket, and the layers beside it close over the ground",
 * and both are applied by leaving the object out of its layer's contours BEFORE
 * the repair rather than by cutting it out afterwards.
 *
 * Reads `osm_id`, `layer`, `hidden` and, for roads, `road_mode`.
 */
export function hiddenOverrideIds(params: PrintParams, layer: OverrideLayer): ReadonlySet<string> {
  const rows = rowsOf(params);
  const out = new Set<string>();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.layer !== layer) continue;
    if (row.hidden === true) {
      out.add(row.osm_id);
      continue;
    }
    if (layer === "road" && row.road_mode === "off") out.add(row.osm_id);
  }
  return out;
}

/**
 * Base OSM id -> the multiplier the user put on its OSM height.
 *
 * Applied to the SCENE height before every other height rule, so the block
 * percentile, the stack test, `is_tall` and `height_exaggeration` all see the
 * number the user asked for rather than the one the tag carried.
 *
 * Reads `osm_id`, `layer`, `height_scale`.
 */
export function heightScaleOverrides(params: PrintParams): ReadonlyMap<string, number> {
  const rows = rowsOf(params);
  const out = new Map<string, number>();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.layer !== "building") continue;
    const scale = row.height_scale;
    if (typeof scale !== "number" || scale === 1) continue;
    out.set(row.osm_id, scale);
  }
  return out;
}

/**
 * Base OSM id -> the multiplier the user put on a road's ground width.
 *
 * On top of `road_scale`, and before the minimum-feature clamp, exactly where
 * `road_scale` itself applies (`transform.road_width_ground_m`).
 *
 * Reads `osm_id`, `layer`, `width_scale`.
 */
export function widthScaleOverrides(params: PrintParams): ReadonlyMap<string, number> {
  const rows = rowsOf(params);
  const out = new Map<string, number>();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.layer !== "road") continue;
    const scale = row.width_scale;
    if (typeof scale !== "number" || scale === 1) continue;
    out.set(row.osm_id, scale);
  }
  return out;
}

/** Buildings the user marked as heroes and buildings the user unmarked. */
export interface HeroOverrides {
  marked: ReadonlySet<string>;
  unmarked: ReadonlySet<string>;
}

/** Reads `osm_id`, `layer`, `hero`. */
export function heroOverrides(params: PrintParams): HeroOverrides {
  const rows = rowsOf(params);
  const marked = new Set<string>();
  const unmarked = new Set<string>();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.layer !== "building") continue;
    if (row.hero === "on") marked.add(row.osm_id);
    else if (row.hero === "off") unmarked.add(row.osm_id);
  }
  return { marked, unmarked };
}

/**
 * Base OSM id -> the shade the user put on one building.
 *
 * Preview and OBJ only, like `colour.tint`: a printer has no way to lay down a
 * shade of one filament, so this never reaches a slot or a 3MF part colour.
 *
 * Reads `osm_id`, `layer`, `tint`.
 */
export function tintOverrides(params: PrintParams): ReadonlyMap<string, string> {
  const rows = rowsOf(params);
  const out = new Map<string, string>();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.layer !== "building") continue;
    const tint = row.tint;
    if (typeof tint !== "string" || tint === "") continue;
    out.set(row.osm_id, tint);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Groups: the overrides that need a region of their own
// ---------------------------------------------------------------------------

/** One printed treatment several objects may share, and the region it prints in. */
export interface OverrideGroup {
  region: RegionName;
  layer: OverrideLayer;
  /** The surface layer these objects are lifted out of; null for buildings. */
  surface: "roads" | "water" | "parks" | null;
  /** `slot` as asked for, 0 when the group keeps its layer's. */
  slot: number;
  /** `color` as asked for, "" when the group keeps its layer's. */
  color: string;
  /** Roads only: `engrave`, `emboss` or `inherit`. */
  roadMode: "inherit" | "engrave" | "emboss";
  /** Water and green only: offset from the layer's own `proud_mm`, mm. */
  raiseMm: number;
  /** The base OSM ids in this group, in the order the array names them. */
  ids: string[];
}

export interface OverrideGrouping {
  /** At most {@link OVERRIDE_MAX_REGIONS} groups, `override_1` first. */
  groups: readonly OverrideGroup[];
  /** Base OSM ids that asked for a treatment past the cap and did not get one. */
  overflow: readonly string[];
  /** Every id of every group, to the group it landed in. */
  byId: ReadonlyMap<string, OverrideGroup>;
}

const NO_GROUPS: OverrideGrouping = { groups: [], overflow: [], byId: new Map() };

/**
 * Does this row ask for a printed treatment its layer cannot give it?
 *
 * A slot or a colour always does, because a region carries one of each. A road
 * mode does when it disagrees with where the roads region sits, and a raise does
 * when it is not zero: both move the object's top face away from its layer's.
 */
function asksForARegion(row: OverrideRow): boolean {
  if ((row.slot ?? 0) !== 0) return true;
  if ((row.color ?? "") !== "") return true;
  if (row.layer === "road") {
    const mode = row.road_mode ?? "inherit";
    return mode === "engrave" || mode === "emboss";
  }
  if (row.layer === "water" || row.layer === "green") return (row.raise_mm ?? 0) !== 0;
  return false;
}

/**
 * The override groups, in the order the array first asks for each.
 *
 * Reads `osm_id`, `layer`, `slot`, `color`, `road_mode`, `raise_mm`. A member
 * that means nothing on a row's layer is NOT read (a building never reads
 * `road_mode`), so it also never splits a group.
 */
export function overrideGroups(params: PrintParams): OverrideGrouping {
  const rows = rowsOf(params);
  if (rows.length === 0) return NO_GROUPS;
  const groups: OverrideGroup[] = [];
  const overflow: string[] = [];
  const byId = new Map<string, OverrideGroup>();
  const byKey = new Map<string, OverrideGroup>();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!asksForARegion(row)) continue;
    const layer = row.layer;
    const slot = row.slot ?? 0;
    const color = row.color ?? "";
    const roadMode = layer === "road" ? (row.road_mode ?? "inherit") : "inherit";
    const raiseMm = layer === "water" || layer === "green" ? (row.raise_mm ?? 0) : 0;
    if (roadMode === "off") continue;
    const key = `${layer}|${slot}|${color}|${roadMode}|${raiseMm}`;
    const existing = byKey.get(key);
    if (existing !== undefined) {
      if (!existing.ids.includes(row.osm_id)) existing.ids.push(row.osm_id);
      byId.set(row.osm_id, existing);
      continue;
    }
    if (groups.length >= OVERRIDE_MAX_REGIONS) {
      overflow.push(row.osm_id);
      continue;
    }
    const group: OverrideGroup = {
      region: OVERRIDE_REGION_NAMES[groups.length],
      layer,
      surface: surfaceOfLayer(layer),
      slot,
      color,
      roadMode,
      raiseMm,
      ids: [row.osm_id],
    };
    groups.push(group);
    byKey.set(key, group);
    byId.set(row.osm_id, group);
  }
  return { groups, overflow, byId };
}

/** The group one override region carries, or null when nothing claimed it. */
export function groupForRegion(grouping: OverrideGrouping, region: RegionName): OverrideGroup | null {
  return grouping.groups.find((group) => group.region === region) ?? null;
}

/**
 * The filament one override region prints in.
 *
 * `slot` and `color` are independent halves of an override, and either may be
 * left alone: a user who picked a colour but no slot means "this object, in
 * this colour, on the extruder it was already going to use". Each half
 * therefore falls back to the value the object's own LAYER carries, which is
 * why the finish stage claims the four layers' slots and colours as well as
 * the override leaves.
 *
 * Null when nothing claimed the region, which is every override region on a
 * default build.
 */
export function overrideRegionStyle(
  params: PrintParams,
  region: RegionName,
): { slot: number; colorHex: string } | null {
  const group = groupForRegion(overrideGroups(params), region);
  if (group === null) return null;
  const layerRegion = regionOfLayer(group.layer);
  return {
    slot: group.slot !== 0 ? group.slot : regionSlot(params, layerRegion),
    colorHex: group.color !== "" ? group.color : regionColor(params, layerRegion),
  };
}

// ---------------------------------------------------------------------------
// Reconciliation against a scene
// ---------------------------------------------------------------------------

/** Every base OSM id one scene can be overridden by, per layer. */
export function sceneOverrideIds(scene: SceneGraph): ReadonlyMap<OverrideLayer, ReadonlySet<string>> {
  const buildings = new Set<string>();
  for (const building of scene.buildings) buildings.add(baseOsmIdOfBuilding(building));
  const roads = new Set<string>();
  for (const road of scene.roads) roads.add(baseOsmIdOfRoad(road));
  const water = new Set<string>();
  for (const feature of scene.water) {
    const id = baseOsmIdOfArea(feature);
    if (id !== null) water.add(id);
  }
  const green = new Set<string>();
  for (const feature of scene.green) {
    const id = baseOsmIdOfArea(feature);
    if (id !== null) green.add(id);
  }
  return new Map<OverrideLayer, ReadonlySet<string>>([
    ["building", buildings],
    ["road", roads],
    ["water", water],
    ["green", green],
  ]);
}

/**
 * Which overrides this scene still has an object for.
 *
 * Nothing is removed here and nothing is removed anywhere: a crop that no longer
 * reaches an object must not destroy the decision taken on it, because widening
 * the crop again has to bring it back. The unresolved rows are counted, reported
 * on the build (`EngineStats.overridesUnresolved`) and shown as inactive.
 *
 * Reads `osm_id` and `layer` only.
 */
export interface OverrideReconciliation {
  /** Array indices whose object is in this scene. */
  active: number[];
  /** Array indices whose object is not, kept and marked inactive. */
  inactive: number[];
}

export function reconcileOverrides(scene: SceneGraph, params: PrintParams): OverrideReconciliation {
  const rows = rowsOf(params);
  const known = sceneOverrideIds(scene);
  const active: number[] = [];
  const inactive: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (known.get(row.layer)?.has(row.osm_id) === true) active.push(i);
    else inactive.push(i);
  }
  return { active, inactive };
}
