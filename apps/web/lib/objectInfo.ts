/**
 * What you are looking at, as data (v3.1 Task 10).
 *
 * The viewport draws the pipeline's own solids and nothing else, so pointing at
 * something and asking "what is this, and what will it print like?" has to be
 * answered from the two things that survive into the viewport: the finished
 * `RegionMesh` under the cursor, and the `SceneGraph` the model was built from.
 * This module is that answer, and it is a pure function of both, so the popover
 * that renders it (`components/scene/ObjectPopover.tsx`) holds no state, reads
 * no `PrintParams` and can be tested without a renderer.
 *
 * Two ways in, because the model has two kinds of identity:
 *
 *  - **Buildings are exact.** The `buildings`, `buildings_band_N` and
 *    `hero_building` meshes carry `triangleOwner`/`owners` ([V3.1-P1-18]), so a
 *    raycast's `faceIndex` is a building id with no search and no tolerance.
 *  - **Roads, water and green are nearest-entity.** Those regions carry no
 *    per-triangle identity yet, so the hit point is converted back to scene
 *    metres and matched against the SceneGraph in plan space: containment for a
 *    polygon, nearest centreline within the printed ribbon's own half-width for
 *    a road. That is an approximation, and `objectInfo.test.ts` measures how
 *    good it is on the Chicago fixture rather than asserting that it is good.
 *
 * The v4 SceneGraph's `osm_id` and `Road.kind` are written only where they say
 * something `id` and `class` do not (`lib/engine/osm/normalize.ts`, and the
 * fields' own contract descriptions). `sourceOsmId` and `roadKind` below are
 * the one place that rule is applied, so no caller re-derives it.
 */

import type { AreaFeature, Building, Road, SceneGraph } from "./contracts";
import type { EngineStats } from "./engine/osm/types";
import { pointInRing, type Point, type Ring } from "./engine/osm/geometry";
import { NO_OWNER, type RegionMesh } from "./engine/types";
import type { SceneWarning } from "./warnings";

/** The four layers a hover can land on. */
export type ObjectLayer = "building" | "road" | "water" | "green";

/** How a hit was attributed, so a caller can say how much to trust it. */
export type PickMethod = "triangle-owner" | "nearest";

export interface ObjectFactRow {
  label: string;
  value: string;
}

export interface ObjectInfo {
  /** `layer:id`, stable for one entity, so a caller can tell "same object" from "moved". */
  key: string;
  layer: ObjectLayer;
  /** The heading: the OSM name, or the type when the object has no name. */
  title: string;
  /** True when `title` is an OSM name rather than the type fallback. */
  named: boolean;
  /** The classification in words: "Apartments", "Trunk road", "Park". */
  typeLabel: string;
  /** The source OSM element id ("w123"), when the entity carries one. */
  osmId: string | null;
  /** Buildings only: where the height came from. `null` on every other layer. */
  heightSource: Building["height_source"] | null;
  /** Buildings only: true while this building is one of the effective heroes. */
  hero: boolean;
  method: PickMethod;
  rows: ObjectFactRow[];
}

// ---------------------------------------------------------------------------
// the two sparse-encoding rules, applied in one place
// ---------------------------------------------------------------------------

/**
 * The source OSM element id of a building or road.
 *
 * `osm_id` is written only when `id` carries a `-N` part suffix, so absent
 * means `id` IS the source id (`scene_graph.json`, `Building.osm_id`).
 */
export function sourceOsmId(entity: { id: string; osm_id?: string }): string {
  return entity.osm_id ?? entity.id;
}

/**
 * The raw `highway=*` tag behind a road.
 *
 * `Road.kind` is written only where it differs from `class`, so absent means
 * exactly `highway=<class>` (`scene_graph.json`, `Road.kind`).
 */
export function roadKind(road: Road): string {
  return road.kind ?? `highway=${road.class}`;
}

// ---------------------------------------------------------------------------
// words
// ---------------------------------------------------------------------------

/** "recreation_ground" -> "Recreation ground". */
function humanise(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim();
  if (words === "") return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The value half of a `key=value` kind, or "" when there is no kind. */
function kindValue(kind: string | undefined): string {
  if (kind === undefined) return "";
  const eq = kind.indexOf("=");
  return eq < 0 ? kind : kind.slice(eq + 1);
}

/**
 * A road's type in words.
 *
 * `motorway` and `footway` are already nouns for the thing; `residential` and
 * `trunk` are adjectives and need the noun added, or the popover reads
 * "Residential" and leaves the reader to guess what of.
 */
export function roadTypeLabel(road: Road): string {
  const word = humanise(kindValue(roadKind(road)));
  if (word === "") return "Road";
  const lower = word.toLowerCase();
  if (lower.endsWith("way") || lower.endsWith("road") || lower.endsWith("street")) return word;
  return `${word} road`;
}

/** A building's type in words. `building=yes` says only "a building". */
export function buildingTypeLabel(building: Building): string {
  const word = kindValue(building.kind);
  if (word === "" || word === "yes") return "Building";
  return humanise(word);
}

/** A water or green polygon's type in words. */
export function areaTypeLabel(feature: AreaFeature, layer: "water" | "green"): string {
  const word = humanise(kindValue(feature.kind));
  if (word !== "") return word;
  return layer === "water" ? "Water" : "Green space";
}

// ---------------------------------------------------------------------------
// numbers
// ---------------------------------------------------------------------------

/** 1240 -> "1,240". Written out rather than `toLocaleString`, whose separator moves with the host locale. */
function grouped(value: number): string {
  const rounded = Math.round(value);
  const digits = String(Math.abs(rounded));
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return rounded < 0 ? `-${out}` : out;
}

/** Metres, with one decimal below 10 m so a 3.4 m alley does not read as "3 m". */
export function metres(value: number): string {
  return value < 10 ? `${Math.round(value * 10) / 10} m` : `${grouped(value)} m`;
}

/** Square metres, grouped. */
export function squareMetres(value: number): string {
  return `${grouped(value)} m²`;
}

const HEIGHT_SOURCE_WORDS: Record<Building["height_source"], string> = {
  tag: "An OSM height tag",
  levels: "Counted from the OSM floor count",
  default: "Estimated from the building type",
};

// ---------------------------------------------------------------------------
// plan-space geometry
// ---------------------------------------------------------------------------

/** Squared distance from `p` to the segment `a`-`b`. */
function segmentDistance2(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return (p[0] - (a[0] + t * dx)) ** 2 + (p[1] - (a[1] + t * dy)) ** 2;
}

/** Distance from `p` to an open polyline, metres. */
export function distanceToPath(p: Point, path: readonly (readonly [number, number])[]): number {
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const d = segmentDistance2(p, path[i - 1], path[i]);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Distance from `p` to a ring's boundary, metres. Zero inside is NOT implied; see `areaAt`. */
function distanceToRing(p: Point, ring: Ring): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const d = segmentDistance2(p, ring[i], ring[(i + 1) % ring.length]);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Centreline length of an open path, metres. */
export function pathLength(path: readonly (readonly [number, number])[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  }
  return total;
}

/** Net polygon area, metres squared: exterior minus the holes that sit inside it. */
export function featureArea(feature: AreaFeature): number {
  const ringArea = (ring: Ring): number => {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[(i + 1) % ring.length];
      sum += x0 * y1 - x1 * y0;
    }
    return Math.abs(sum) / 2;
  };
  let total = ringArea(feature.ring);
  for (const hole of feature.holes) total -= ringArea(hole);
  return Math.max(total, 0);
}

/**
 * How far outside a road's own printed ribbon a hit may land and still be
 * attributed to it, metres.
 *
 * The ribbon is `width_m` wide about the centreline before the minimum-feature
 * clamp widens it, so a hit on the ribbon is at most `width_m / 2` from the
 * centreline plus whatever the clamp added. Two metres covers the clamp at
 * every plate size the contract allows (0.8 mm of minimum wall at the smallest
 * scale is under 1 m on the ground) without reaching across a city block.
 */
export const ROAD_PICK_SLACK_M = 2.0;

/** How far outside a polygon a hit may land and still be attributed to it, metres. */
export const AREA_PICK_SLACK_M = 2.0;

// ---------------------------------------------------------------------------
// picking
// ---------------------------------------------------------------------------

/**
 * The building id a raycast hit belongs to, exactly.
 *
 * `faceIndex` is three.js's triangle ordinal, which is what `triangleOwner` is
 * indexed by for both an indexed mesh and the expanded, per-triangle-coloured
 * one `RegionMeshes` builds for a region with recess bands: three's
 * `Mesh.raycast` sets `faceIndex = Math.floor(i / 3)` in both branches.
 * Returns null for a mesh that carries no identity (every region but the three
 * building ones) and for `NO_OWNER`, the marker for a triangle the attribution
 * could not place.
 */
export function ownerAt(mesh: RegionMesh, faceIndex: number): string | null {
  const owners = mesh.owners;
  const triangleOwner = mesh.triangleOwner;
  if (owners === undefined || triangleOwner === undefined) return null;
  if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= triangleOwner.length) return null;
  const owner = triangleOwner[faceIndex];
  if (owner === NO_OWNER || owner >= owners.length) return null;
  return owners[owner];
}

export interface NearestRoad {
  road: Road;
  /** Distance from the hit to the road's centreline, metres. */
  distanceM: number;
}

/**
 * The road nearest a point in scene metres, or null when nothing is within its
 * own ribbon.
 *
 * O(segments). It runs once per throttled pointer move, never per frame.
 */
export function nearestRoad(roads: readonly Road[], x: number, y: number): NearestRoad | null {
  const p: Point = [x, y];
  let best: NearestRoad | null = null;
  let bestScore = Infinity;
  for (const road of roads) {
    if (road.path.length < 2) continue;
    const reach = road.width_m / 2 + ROAD_PICK_SLACK_M;
    const distanceM = distanceToPath(p, road.path);
    if (distanceM > reach) continue;
    // Ranked by how far ACROSS its own ribbon the hit is, not by raw distance.
    // Raw distance answers the wrong question: a hit at the outer edge of a
    // 16 m avenue is 8 m from that avenue's centreline and can easily be 6 m
    // from a footway drawn beside it, so nearest-centreline hands the avenue's
    // own surface to the footway. Measured on the Chicago fixture at the ribbon
    // EDGE, which is the worst case a hover can produce: the road this returns
    // is one whose own ribbon covers the point 99.1 % of the time by this
    // ratio, 96.8 % by raw distance (`objectInfo.test.ts`).
    const score = distanceM / reach;
    if (score < bestScore) {
      bestScore = score;
      best = { road, distanceM };
    }
  }
  return best;
}

export interface NearestArea {
  feature: AreaFeature;
  /** 0 when the point is inside the polygon, otherwise the distance to its boundary. */
  distanceM: number;
}

/**
 * The water or green polygon at a point in scene metres.
 *
 * Containment first, which is exact for a point that really landed on the
 * polygon; the nearest boundary within `AREA_PICK_SLACK_M` otherwise, which
 * covers a hit on the sloped wall of a recess whose top face is a little
 * inside the ring. A point inside a hole is inside no polygon and is rejected.
 */
export function areaAt(features: readonly AreaFeature[], x: number, y: number): NearestArea | null {
  const p: Point = [x, y];
  let nearest: NearestArea | null = null;
  for (const feature of features) {
    if (feature.ring.length < 3) continue;
    if (pointInRing(p, feature.ring) && !feature.holes.some((hole) => pointInRing(p, hole))) {
      return { feature, distanceM: 0 };
    }
    const distanceM = distanceToRing(p, feature.ring);
    if (distanceM > AREA_PICK_SLACK_M) continue;
    if (nearest === null || distanceM < nearest.distanceM) nearest = { feature, distanceM };
  }
  return nearest;
}

// ---------------------------------------------------------------------------
// descriptions
// ---------------------------------------------------------------------------

export interface BuildingContext {
  /** True while this building is one of the effective heroes (manual plus auto). */
  hero: boolean;
  /**
   * Ground metres the minimum-feature repair grew this footprint by, 0 when it
   * printed as measured. From `lib/preview.ts`'s `PreviewBuilding.dilation_m`,
   * which is the same `transform.building_footprint_metrics` the engine repairs
   * with.
   */
  dilationM: number;
}

/** Everything the popover says about one building. */
export function describeBuilding(building: Building, context: BuildingContext): ObjectInfo {
  const typeLabel = buildingTypeLabel(building);
  const footprint = featureArea({ ring: building.ring, holes: building.holes });
  const rows: ObjectFactRow[] = [
    { label: "Height", value: metres(building.height_m) },
    { label: "Source", value: HEIGHT_SOURCE_WORDS[building.height_source] },
    { label: "Footprint", value: squareMetres(footprint) },
    {
      label: "Repair",
      value:
        context.dilationM > 0
          ? `Widened ${(Math.round(context.dilationM * 100) / 100).toFixed(2)} m to reach the minimum wall`
          : "Prints as measured",
    },
  ];
  // Only when true. "Prints as measured" is a fact about a choice the user is
  // in the middle of making, so its absence is worth stating; "not a hero" is
  // the state of all but a dozen buildings and a row saying so on every one of
  // them is noise.
  if (context.hero) rows.push({ label: "Hero", value: "Yes, this one is singled out" });
  return {
    key: `building:${building.id}`,
    layer: "building",
    title: building.name ?? typeLabel,
    named: building.name !== undefined,
    typeLabel,
    osmId: sourceOsmId(building),
    heightSource: building.height_source,
    hero: context.hero,
    method: "triangle-owner",
    rows,
  };
}

/**
 * A building the finish merged into a block, which has no SceneGraph entity of
 * its own.
 *
 * `owners` carries `block-<n>` for those ([V3.1-P1-18]). Saying so is the
 * honest answer: the thing under the cursor really is several buildings that
 * the minimum-gap repair fused into one solid.
 */
export function describeMergedBlock(ownerId: string): ObjectInfo {
  return {
    key: `building:${ownerId}`,
    layer: "building",
    title: "Merged block",
    named: false,
    typeLabel: "Merged block",
    osmId: null,
    heightSource: null,
    hero: false,
    method: "triangle-owner",
    rows: [
      {
        label: "Repair",
        value: "Several buildings closer together than the minimum gap, printed as one solid",
      },
    ],
  };
}

/** Everything the popover says about one road segment. */
export function describeRoad(road: Road, distanceM: number): ObjectInfo {
  const typeLabel = roadTypeLabel(road);
  const length = pathLength(road.path);
  return {
    key: `road:${road.id}`,
    layer: "road",
    title: road.name ?? typeLabel,
    named: road.name !== undefined,
    typeLabel,
    osmId: sourceOsmId(road),
    heightSource: null,
    hero: false,
    method: "nearest",
    rows: [
      { label: "Width", value: metres(road.width_m) },
      { label: "Length", value: metres(length) },
      { label: "Footprint", value: squareMetres(length * road.width_m) },
      {
        label: "Match",
        value:
          distanceM <= 0.5
            ? "On the centreline"
            : `Nearest centreline, ${metres(distanceM)} away`,
      },
    ],
  };
}

/** Everything the popover says about one water or green polygon. */
export function describeArea(
  feature: AreaFeature,
  layer: "water" | "green",
  distanceM: number,
): ObjectInfo {
  const typeLabel = areaTypeLabel(feature, layer);
  // One OSM element can survive the crop as several polygons, so the element id
  // alone is not a key; the first vertex separates them and is stable, because
  // the ingest emits rings on a 1 mm grid.
  const [x0, y0] = feature.ring[0] ?? [0, 0];
  return {
    key: `${layer}:${feature.osm_id ?? "unknown"}:${x0},${y0}`,
    layer,
    title: feature.name ?? typeLabel,
    named: feature.name !== undefined,
    typeLabel,
    osmId: feature.osm_id ?? null,
    heightSource: null,
    hero: false,
    method: "nearest",
    rows: [
      { label: "Area", value: squareMetres(featureArea(feature)) },
      {
        label: "Match",
        value: distanceM === 0 ? "Inside the outline" : `Nearest outline, ${metres(distanceM)} away`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// the one entry point the viewport calls
// ---------------------------------------------------------------------------

export interface HoverContext {
  /** Print millimetres per ground metre, `transform.scale_mm_per_m`. */
  scaleMmPerM: number;
  /** The effective hero ids (manual plus auto), as the worker resolved them. */
  heroIds: ReadonlySet<string>;
  /** Building id -> the ground metres the minimum-feature repair grew it by. */
  dilationById: ReadonlyMap<string, number>;
  /**
   * `override_N` -> the SceneGraph layer that region's group came out of (v3.1
   * Task 11). Only a caller that can read `PrintParams` knows this, which is
   * why it arrives here rather than being derived: nothing drawn in the
   * viewport may read a parameter.
   */
  overrideLayers?: ReadonlyMap<string, "building" | "road" | "water" | "green">;
}

export interface HoverHit {
  /** The `RegionMesh.region` name the ray hit. */
  region: string;
  /** The mesh itself, so a building hit needs no second lookup. */
  mesh: RegionMesh;
  /** three.js's triangle ordinal for the hit. */
  faceIndex: number;
  /** The hit point in ENGINE millimetres (x east, y north, plate centre at 0,0). */
  xMm: number;
  yMm: number;
}

/** Region names whose meshes carry per-triangle building identity. */
export function isBuildingRegion(region: string): boolean {
  return region === "buildings" || region === "hero_building" || region.startsWith("buildings_band_");
}

/**
 * The `override_N` regions (v3.1 Task 11, `engine/solid/overrides.ts`).
 *
 * One of these holds whatever objects the user gave the same printed
 * treatment, so WHICH layer it can name is a fact about that build's overrides
 * rather than about the region name. `HoverContext.overrideLayers` carries the
 * answer; a hit on one with no entry there names nothing, which is what a
 * region built by a set of overrides the caller did not describe deserves.
 */
export function isOverrideRegion(region: string): boolean {
  return /^override_\d+$/.test(region);
}

/**
 * Region names a hover can name an object in.
 *
 * The three building regions, the three SceneGraph area layers and the
 * per-object override regions. The base, the frame, the matting, the lettering,
 * the attribution, the rail and the mount parts are deliberately not here: none
 * of them is an OSM object, and a mesh with no handler is a mesh three.js does
 * not raycast, so leaving them out is also what keeps the per-move cost to the
 * geometry that can answer. The right-click inspector reaches them by a
 * different road: one native listener that raycasts on the context-menu event
 * alone (`components/scene/RegionMeshes.tsx`).
 */
export function isPickableRegion(region: string): boolean {
  return (
    isBuildingRegion(region) ||
    isOverrideRegion(region) ||
    region === "roads" ||
    region === "water" ||
    region === "parks"
  );
}

/** The SceneGraph layer an ordinary region names, or null when it names none. */
function layerOfRegion(region: string): "road" | "water" | "green" | null {
  if (region === "roads") return "road";
  if (region === "water") return "water";
  if (region === "parks") return "green";
  return null;
}

/**
 * What the pointer is over, or null.
 *
 * The one place the two picking methods meet. A building hit is exact; a road,
 * water or green hit converts the point back to scene metres (`mm / scale`, the
 * inverse of the single multiplication `solid/manifold.ts:contoursFromRings`
 * applies) and looks the entity up in plan space.
 */
export function objectAt(
  scene: SceneGraph,
  hit: HoverHit,
  context: HoverContext,
): ObjectInfo | null {
  const overrideLayer = isOverrideRegion(hit.region)
    ? (context.overrideLayers?.get(hit.region) ?? null)
    : null;
  if (isBuildingRegion(hit.region) || overrideLayer === "building") {
    const ownerId = ownerAt(hit.mesh, hit.faceIndex);
    if (ownerId === null) return null;
    const building = scene.buildings.find((candidate) => candidate.id === ownerId);
    if (building === undefined) return describeMergedBlock(ownerId);
    return describeBuilding(building, {
      hero: context.heroIds.has(building.id),
      dilationM: context.dilationById.get(building.id) ?? 0,
    });
  }

  if (context.scaleMmPerM <= 0) return null;
  const x = hit.xMm / context.scaleMmPerM;
  const y = hit.yMm / context.scaleMmPerM;

  const layer = overrideLayer ?? layerOfRegion(hit.region);
  if (layer === "road") {
    const found = nearestRoad(scene.roads, x, y);
    return found === null ? null : describeRoad(found.road, found.distanceM);
  }
  if (layer === "water") {
    const found = areaAt(scene.water, x, y);
    return found === null ? null : describeArea(found.feature, "water", found.distanceM);
  }
  if (layer === "green") {
    const found = areaAt(scene.green, x, y);
    return found === null ? null : describeArea(found.feature, "green", found.distanceM);
  }
  return null;
}

// ---------------------------------------------------------------------------
// the Issues badge entry for a truncated scene
// ---------------------------------------------------------------------------

/**
 * The one counted warning the ingest's name budget produces.
 *
 * Empty for every scene inside the budget, which is every scene of up to twice
 * the Chicago fixture's density (`normalize.ts:SCENE_NAME_BUDGET_BYTES`). The
 * point of reporting it is that an unlabelled popover on a small building would
 * otherwise look like missing OSM data rather than a decision this app made.
 */
export function nameBudgetWarning(scene: SceneGraph | null): SceneWarning[] {
  const dropped = (scene?.stats as EngineStats | undefined)?.names_dropped ?? 0;
  if (dropped <= 0) return [];
  return [
    {
      id: "names-over-budget",
      level: "info",
      message:
        `${grouped(dropped)} OpenStreetMap ${dropped === 1 ? "name was" : "names were"} left out ` +
        "of this scene to keep it inside the transfer budget. The largest features kept theirs; " +
        "hovering a smaller one shows its type and size instead of its name.",
    },
  ];
}
