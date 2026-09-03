/**
 * Raw Overpass JSON -> SceneGraph (03 "Height inference", "Road widths",
 * "Geometry hygiene", "Projection and crop", "Coverage classification").
 * Direct port of `services/bake/app/ingest/normalize.py`; see that file's
 * module docstring for the five-stage pipeline this mirrors, and
 * `geometry.ts`'s module doc for where the polygon math necessarily departs
 * from GEOS. Order of operations matches the Python source exactly: classify
 * -> project -> hygiene (seven steps) -> crop -> emit.
 */
import type { SceneRequest } from "../../contracts";
import { perfSpan } from "../../perf";
import {
  area,
  assembleRings,
  bboxOfRing,
  bboxOverlap,
  centroidWithHoles,
  exteriorArea,
  intersectionArea,
  netArea,
  orientRing,
  pointInRing,
  simplifyRing,
  snapRing,
  unionPair,
  type Point,
  type Ring,
} from "./geometry";
import {
  GREEN_LANDUSE,
  GREEN_LEISURE,
  HIGHWAY_WIDTH_M,
  classifyCoverage,
  heightRulesFrom,
  parseLengthM,
  parseLevels,
  resolveHeightWith,
  roadClass,
  roadWidthM,
  type HeightResult,
  type HeightRules,
} from "./heights";
import { LocalFrame, clipLineToSquare, clipPolygonToSquare, cropSquare, inSquare } from "./project";
import type {
  EngineBuilding,
  EngineRoad,
  EngineSceneGraph,
  EngineStats,
  HeightFallbackCounts,
  Rail,
} from "./types";

export const SIMPLIFY_TOLERANCE_M = 0.25;
export const EMIT_GRID_M = 0.001;
export const DEDUPE_CENTROID_M = 0.5;
export const DEDUPE_AREA_RATIO = 0.05;
export const MIN_FEATURE_AREA_M2 = 1.0;
export const MIN_ROAD_LENGTH_M = 1.0;
export const OVERLAP_MIN_AREA_M2 = 0.25;
export const OVERLAP_MIN_RATIO = 0.02;

const DEFAULT_TREE_RADIUS_M = 4.0;
const MIN_TREE_RADIUS_M = 0.5;
const MAX_TREE_RADIUS_M = 20.0;

const RAIL_TYPES = new Set(["rail", "light_rail", "subway", "tram"]);
const RAIL_WIDTH_M: Record<string, number> = { rail: 5.0, light_rail: 4.0, subway: 5.0, tram: 3.0 };

const LANDMARK_BUILDING_TYPES = new Set(["cathedral", "church", "tower"]);

/** Contract caps on the schema_version 4 identity strings (`scene_graph.json`). */
export const MAX_NAME_LENGTH = 120;
export const MAX_KIND_LENGTH = 64;

/**
 * How many UTF-8 bytes of `name` one SceneGraph may spend, across buildings,
 * roads, water and green.
 *
 * Chosen from the measurement, not from taste. The Chicago Loop fixture at
 * 900 m radius is 1 229.7 kB of SceneGraph JSON before this task and 1 423.7 kB
 * after (+15.8 %). The whole v4 identity block is 211.9 kB of that: `kind`
 * 147.5 kB, `name` 47.2 kB, `osm_id` 17.2 kB. Names are the part that is
 * unbounded in practice - 120 characters each, one per entity, and the entity
 * count is what a dense city multiplies. A 3 000 m radius scene with 8 000
 * buildings and 8 000 named road segments would spend roughly 450 kB on names
 * alone, on a payload already at the top of the transfer budget.
 *
 * 96 kB is a little over twice what Chicago actually spends, so no scene of up
 * to twice Chicago's density loses a single name, and a scene dense enough to
 * blow the budget loses only its smallest features' names. `normalize.identity.test.ts`
 * measures the fixture against this constant, so the headroom is a fact the
 * suite re-checks rather than a claim in a comment.
 *
 * "Smallest" is by footprint, so what survives is what a person can actually
 * see and point at: buildings and areas by net polygon area, roads by
 * centreline length times width. The count of what was dropped is reported
 * (`EngineStats.names_dropped`) and reaches the Issues badge, so a truncated
 * scene says so rather than quietly looking unlabelled.
 */
export const SCENE_NAME_BUDGET_BYTES = 96_000;

const UTF8 = new TextEncoder();

/** The bytes `,"name":"..."` costs in the serialised SceneGraph. */
export function nameFieldBytes(name: string): number {
  // `"name":` is 7 bytes and the separating comma is 1; the value is measured
  // as the JSON literal, so an escape or a multi-byte character is counted
  // exactly as it will be transferred.
  return 8 + UTF8.encode(JSON.stringify(name)).length;
}

/** A string tag, trimmed and clipped to the contract's cap, or undefined if empty. */
function tagString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/** The OSM `name` tag of an element, contract-clipped. */
function nameOf(tags: Tags): string | undefined {
  return tagString(tags["name"], MAX_NAME_LENGTH);
}

/**
 * The tag that classified this element, as `key=value`.
 *
 * This is the RAW tag, not the printing bucket: a `highway=trunk` way is
 * `class: "motorway"` in the contract and `kind: "highway=trunk"` here, and a
 * reader that wants to say what the object is rather than how it prints needs
 * the second one. `layerOf` above is the only place that decides which tag
 * classified an element, so this mirrors its branches exactly.
 */
function kindOf(layer: Exclude<Layer, null>, tags: Tags): string | undefined {
  const pair = (key: string): string | undefined => {
    const value = tagString(tags[key], MAX_KIND_LENGTH);
    return value === undefined ? undefined : tagString(`${key}=${value}`, MAX_KIND_LENGTH);
  };
  switch (layer) {
    case "building":
      return pair("building");
    case "road":
      return pair("highway");
    case "rail":
      return pair("railway");
    case "water":
      return tags["natural"] === "water" ? "natural=water" : pair("waterway");
    case "green":
      return typeof tags["landuse"] === "string" && GREEN_LANDUSE.has(tags["landuse"])
        ? pair("landuse")
        : pair("leisure");
    case "tree":
      return "natural=tree";
  }
}

/**
 * The `osm_id` a Building or Road should carry, or undefined when it would
 * only repeat `id`.
 *
 * `id` IS the source element id for all but the split parts of one element,
 * which `UniqueIds` suffixes `-1`, `-2`, ... Writing it out again on every
 * entity costs 22 bytes each and says nothing new: 6 431 entities on the
 * Chicago fixture, 141 kB, 11 % of the payload for a duplicate. The contract
 * states the rule ("absent means `id` is already the source id"), and
 * `lib/objectInfo.ts:sourceOsmId` is the one accessor that applies it, so no
 * caller re-derives it. `AreaFeature` has no `id` at all, so its `osm_id` is
 * always written.
 */
function osmIdIfSplit(id: string, sourceId: string): string | undefined {
  return id === sourceId ? undefined : sourceId;
}

/**
 * A road's `kind`, or undefined when `class` already says the same thing.
 *
 * Ten `highway` values map onto six printing classes, and five of them map onto
 * the class of the same name: a `highway=residential` way is `class:
 * "residential"` and `kind: "highway=residential"`, the same eight words twice.
 * That duplicate is the single most expensive field in the whole v4 identity
 * block - 5 439 road segments on the Chicago fixture, 138 kB, 11 % of the
 * payload before this rule - so it is written only where it says something
 * `class` does not: `highway=trunk` under `class: "motorway"`,
 * `highway=tertiary` under `secondary`, `highway=footway` under `path`.
 * Absent therefore means exactly `highway=<class>`, which is lossless and is
 * what the contract's `Road.kind` description states; `lib/objectInfo.ts`
 * applies it in the one place anything reads it.
 */
function roadKindIfInformative(kind: string | undefined, klass: string): string | undefined {
  return kind === `highway=${klass}` ? undefined : kind;
}

// ---------------------------------------------------------------------------
// raw Overpass element shapes
// ---------------------------------------------------------------------------

export interface OverpassNode {
  lat: number;
  lon: number;
}

export interface OverpassMember {
  type: string;
  ref?: number;
  role?: string;
  geometry?: (OverpassNode | null)[] | null;
}

export interface OverpassElement {
  type: "way" | "relation" | "node";
  id: number;
  tags?: Record<string, unknown>;
  geometry?: (OverpassNode | null)[] | null;
  members?: OverpassMember[] | null;
  lat?: number;
  lon?: number;
}

export interface OverpassResponse {
  elements: OverpassElement[];
  remark?: string;
}

type Tags = Record<string, unknown>;

function osmId(e: OverpassElement): string {
  const prefix = e.type === "way" ? "w" : e.type === "relation" ? "r" : "x";
  return `${prefix}${e.id}`;
}

function tagsOf(e: OverpassElement): Tags {
  return e.tags ?? {};
}

type Layer = "building" | "road" | "rail" | "water" | "green" | "tree" | null;

function layerOf(e: OverpassElement, tags: Tags): Layer {
  if (e.type === "node") {
    return tags["natural"] === "tree" ? "tree" : null;
  }
  const building = tags["building"];
  if (building && !["no", "false"].includes(String(building).toLowerCase())) return "building";
  if (e.type === "way") {
    const highway = tags["highway"];
    if (typeof highway === "string" && highway in HIGHWAY_WIDTH_M) return "road";
    const railway = tags["railway"];
    if (typeof railway === "string" && RAIL_TYPES.has(railway)) {
      if (String(tags["tunnel"] ?? "").toLowerCase() === "yes") return null; // surface only
      const layer = parseLevels(tags["layer"]);
      if (layer !== null && layer < 0) return null; // surface only
      return "rail";
    }
  }
  if (tags["natural"] === "water" || tags["waterway"] === "riverbank") return "water";
  const landuse = tags["landuse"];
  const leisure = tags["leisure"];
  if ((typeof landuse === "string" && GREEN_LANDUSE.has(landuse)) || (typeof leisure === "string" && GREEN_LEISURE.has(leisure))) {
    return "green";
  }
  return null;
}

function isLandmark(tags: Tags): boolean {
  if (tags["tourism"]) return true;
  if (tags["historic"]) return true;
  if (tags["man_made"] === "tower") return true;
  if (tags["wikidata"]) return true;
  const building = String(tags["building"] ?? "").toLowerCase();
  return LANDMARK_BUILDING_TYPES.has(building);
}

function parseBridge(tags: Tags): boolean {
  return String(tags["bridge"] ?? "").toLowerCase() === "yes";
}

function parseLayer(tags: Tags): number {
  const layer = parseLevels(tags["layer"]);
  return layer !== null ? Math.trunc(layer) : 0;
}

function buildingRelationOuterWays(elements: OverpassElement[]): Set<number> {
  const refs = new Set<number>();
  for (const e of elements) {
    if (e.type !== "relation") continue;
    const tags = tagsOf(e);
    if (layerOf(e, tags) !== "building") continue;
    for (const member of e.members ?? []) {
      if (member.type !== "way") continue;
      const role = member.role ?? "";
      if (role !== "outer" && role !== "") continue;
      if (!member.geometry || member.geometry.filter((n) => n !== null).length < 2) continue;
      if (typeof member.ref === "number") refs.add(member.ref);
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// coordinate projection
// ---------------------------------------------------------------------------

function projectGeometry(nodes: (OverpassNode | null)[] | null | undefined, frame: LocalFrame): Point[] | null {
  if (!nodes) return null;
  const pts: Point[] = [];
  for (const n of nodes) {
    if (!n || n.lat === undefined || n.lon === undefined) continue; // Overpass emits null outside the bbox
    pts.push(frame.pointToLocal(n.lon, n.lat));
  }
  return pts.length >= 2 ? pts : null;
}

// ---------------------------------------------------------------------------
// ring construction (03 hygiene steps 1-5, applied per element)
// ---------------------------------------------------------------------------

interface RingHoles {
  ring: Ring;
  holes: Ring[];
}

/** Which OSM element a water/green polygon came from, carried through the dissolve. */
interface AreaSource {
  osmId: string;
  name?: string;
  kind?: string;
}

interface AreaGeom extends RingHoles {
  source: AreaSource;
}

function ringFromCoords(coords: Point[]): Ring | null {
  if (coords.length < 4) return null; // step 1: raw node count including any closing repeat
  let pts = coords;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) pts = pts.slice(0, -1);
  if (pts.length < 3) return null;
  if (area(pts) <= 0) return null;
  return pts;
}

/** Clean a single ring: orient CCW, simplify (0.25 m), snap to the 1 mm grid (03 steps 3-5, no-hole case). */
function cleanRing(ring: Ring): Ring | null {
  let r = orientRing(ring, true);
  r = simplifyRing(r, SIMPLIFY_TOLERANCE_M);
  r = snapRing(r, EMIT_GRID_M);
  if (r.length < 3 || area(r) <= 0) return null;
  return orientRing(r, true);
}

function ringVertexKeys(ring: Ring): Set<string> {
  const keys = new Set<string>();
  for (const [x, y] of ring) keys.add(`${Math.round(x / EMIT_GRID_M)}:${Math.round(y / EMIT_GRID_M)}`);
  return keys;
}

/** True if the two rings share at least one vertex on the 1 mm emission grid (a shared parcel boundary node). */
function ringsShareVertex(keysA: Set<string>, b: Ring): boolean {
  for (const [x, y] of b) {
    if (keysA.has(`${Math.round(x / EMIT_GRID_M)}:${Math.round(y / EMIT_GRID_M)}`)) return true;
  }
  return false;
}

/**
 * Group rings that overlap OR touch into one union each; keep genuinely
 * disjoint rings separate. Mirrors `unary_union`'s real semantics (used for
 * `_safe_union` in both the outer/inner ring assembly and the water/green
 * dissolve): two polygons that merely share a boundary node -- common where
 * OSM landuse/leisure parcels are subdivided along shared ways -- still
 * dissolve into one connected polygon, unlike 03 step 7's building merge,
 * which explicitly uses the "overlaps"/"covers" predicates (interior area
 * overlap only, wall-sharing buildings stay separate) and does not call this
 * function. [V3-P2-E1]
 */
function dissolveRings(rings: Ring[]): Ring[] {
  return dissolveRingsGrouped(rings).map((group) => group.ring);
}

/** One dissolved polygon and the indices of the input rings that made it. */
export interface DissolvedGroup {
  ring: Ring;
  /** Indices into the rings passed in, ascending. A group of one was not merged. */
  members: number[];
}

/**
 * `dissolveRings`, keeping the provenance the merge would otherwise erase.
 *
 * Water and green polygons are dissolved across ELEMENTS, so a dissolved
 * polygon usually has several OSM elements behind it and cannot honestly claim
 * one id. The caller picks a representative from `members` (the largest
 * contributor by net area), and the contract says so in `AreaFeature.osm_id`'s
 * own description.
 */
export function dissolveRingsGrouped(rings: Ring[]): DissolvedGroup[] {
  const kept: number[] = [];
  const cleaned: Ring[] = [];
  for (let i = 0; i < rings.length; i++) {
    if (rings[i].length >= 3) {
      cleaned.push(rings[i]);
      kept.push(i);
    }
  }
  if (cleaned.length <= 1) return cleaned.map((ring, i) => ({ ring, members: [kept[i]] }));
  const boxes = cleaned.map(bboxOfRing);
  const vertexKeys = cleaned.map(ringVertexKeys);
  const parent = cleaned.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (let i = 0; i < cleaned.length; i++) {
    for (let j = i + 1; j < cleaned.length; j++) {
      if (!bboxOverlap(boxes[i], boxes[j])) continue;
      if (ringsShareVertex(vertexKeys[i], cleaned[j]) || intersectionArea(cleaned[i], cleaned[j]) > 1e-6) {
        union(i, j);
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < cleaned.length; i++) {
    const r = find(i);
    const list = groups.get(r) ?? [];
    list.push(i);
    groups.set(r, list);
  }
  const out: DissolvedGroup[] = [];
  for (const idx of groups.values()) {
    const members = idx.map((i) => kept[i]);
    if (idx.length === 1) {
      out.push({ ring: cleaned[idx[0]], members });
      continue;
    }
    let merged = cleaned[idx[0]];
    for (let k = 1; k < idx.length; k++) merged = unionPair(merged, cleaned[idx[k]]);
    out.push({ ring: merged, members });
  }
  return out;
}

interface PolyMember {
  coords: Point[]; // >= 2 points, not necessarily closed
}

interface PolyElement {
  osmId: string;
  tags: Tags;
  outer: PolyMember[];
  inner: PolyMember[];
}

/** 03 steps 1-5 for one building/water/green element: assemble, clean, attach holes. Mirrors `_element_geometry`. */
function elementGeometry(element: PolyElement): RingHoles[] {
  if (element.inner.length === 0 && element.outer.length === 1) {
    const ring = ringFromCoords(element.outer[0].coords);
    if (!ring) return [];
    const cleaned = cleanRing(ring);
    return cleaned ? [{ ring: cleaned, holes: [] }] : [];
  }

  const outerRings = assembleRings(element.outer.map((m) => m.coords));
  if (outerRings.length === 0) return [];
  const outerCleaned = outerRings.map(cleanRing).filter((r): r is Ring => r !== null);
  const outerParts = dissolveRings(outerCleaned);
  if (outerParts.length === 0) return [];

  const innerRings = assembleRings(element.inner.map((m) => m.coords));
  const innerCleaned = innerRings.map(cleanRing).filter((r): r is Ring => r !== null);
  const innerParts = dissolveRings(innerCleaned.map((r) => orientRing(r, false)));

  const parts: RingHoles[] = outerParts.map((ring) => ({ ring, holes: [] as Ring[] }));
  for (const hole of innerParts) {
    const [hx, hy] = centroidWithHoles(hole, []);
    for (const part of parts) {
      if (pointInRing([hx, hy], part.ring)) {
        part.holes.push(hole);
        break;
      }
    }
  }
  return parts.filter((p) => netArea(p.ring, p.holes) >= MIN_FEATURE_AREA_M2 || p.holes.length === 0);
}

// ---------------------------------------------------------------------------
// footprints: dedupe (03 step 6) and union-overlapping (03 step 7)
// ---------------------------------------------------------------------------

/**
 * A footprint's height, deferred until the rules are known.
 *
 * A leaf is one OSM element: `resolveHeightWith` over its tags. A merge is
 * what 03 steps 6 and 7 produce when footprints are deduplicated or unioned:
 * the tallest member's height and source, ties to the larger member's
 * outline, and the lowest member's min height, over the members' outlines AS
 * THEY WERE at that level (a step 7 member can itself be a step 6 merge, whose
 * outline is its keeper's). Which member is tallest depends on the rules, so
 * the whole tree is kept and decided per run (`resolvePick`).
 */
export type HeightPick =
  | { kind: "leaf"; tags: Tags; osmId: string }
  | { kind: "merge"; parts: HeightPart[] };

export interface HeightPart {
  pick: HeightPick;
  /** Net area of this member's outline at the merge's own level, m2: the tie-break. */
  areaM2: number;
}

/** `mergeGroup`'s height rule, applied once the rules are known. */
export function resolvePick(pick: HeightPick, rules: HeightRules): HeightResult {
  if (pick.kind === "leaf") return resolveHeightWith(pick.tags, pick.osmId, rules);
  const results = pick.parts.map((part) => resolvePick(part.pick, rules));
  let best = 0;
  for (let i = 0; i < results.length; i++) {
    if (results[i].heightM > results[best].heightM || (results[i].heightM === results[best].heightM && pick.parts[i].areaM2 > pick.parts[best].areaM2)) {
      best = i;
    }
  }
  let minHeight = Infinity;
  for (const result of results) minHeight = Math.min(minHeight, result.minHeightM);
  return { heightM: results[best].heightM, heightSource: results[best].heightSource, minHeightM: minHeight };
}

interface Footprint {
  osmId: string;
  ring: Ring;
  holes: Ring[];
  pick: HeightPick;
  name?: string;
  kind?: string;
  landmark?: boolean;
  tourism?: string;
  historic?: string;
  wikidata?: string;
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
  groups(): number[][] {
    const out = new Map<number, number[]>();
    for (let i = 0; i < this.parent.length; i++) {
      const r = this.find(i);
      const list = out.get(r) ?? [];
      list.push(i);
      out.set(r, list);
    }
    return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  }
}

function mergeGroup(items: Footprint[], idx: number[], ring: Ring, holes: Ring[], keeper?: number): Footprint {
  let keep = keeper;
  if (keep === undefined) {
    keep = idx[0];
    for (const i of idx) if (netArea(items[i].ring, items[i].holes) > netArea(items[keep].ring, items[keep].holes)) keep = i;
  }
  return {
    osmId: items[keep].osmId,
    ring,
    holes,
    pick: { kind: "merge", parts: idx.map((i) => ({ pick: items[i].pick, areaM2: netArea(items[i].ring, items[i].holes) })) },
    name: items[keep].name,
    kind: items[keep].kind,
    landmark: idx.some((i) => items[i].landmark),
    tourism: items[keep].tourism,
    historic: items[keep].historic,
    wikidata: items[keep].wikidata,
  };
}

/** 03 step 6: centroids within 0.5 m and outlines within 5% are the same building. Mirrors `_dedupe`. */
function dedupe(items: Footprint[]): Footprint[] {
  if (items.length < 2) return items;
  const centroids = items.map((it) => centroidWithHoles(it.ring, it.holes));
  const outlines = items.map((it) => exteriorArea(it.ring));
  const holeCounts = items.map((it) => it.holes.length);
  const uf = new UnionFind(items.length);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const dx = centroids[i][0] - centroids[j][0];
      const dy = centroids[i][1] - centroids[j][1];
      if (dx * dx + dy * dy > DEDUPE_CENTROID_M * DEDUPE_CENTROID_M) continue;
      const big = Math.max(outlines[i], outlines[j]);
      if (big <= 0) continue;
      if (Math.abs(outlines[i] - outlines[j]) <= DEDUPE_AREA_RATIO * big) uf.union(i, j);
    }
  }
  const out: Footprint[] = [];
  for (const idx of uf.groups()) {
    if (idx.length === 1) {
      out.push(items[idx[0]]);
      continue;
    }
    let keeper = idx[0];
    for (const i of idx) {
      if (
        holeCounts[i] > holeCounts[keeper] ||
        (holeCounts[i] === holeCounts[keeper] && netArea(items[i].ring, items[i].holes) > netArea(items[keeper].ring, items[keeper].holes))
      ) {
        keeper = i;
      }
    }
    out.push(mergeGroup(items, idx, items[keeper].ring, items[keeper].holes, keeper));
  }
  return out;
}

/** 03 step 7: union footprints whose interiors genuinely overlap, keep the max height. Mirrors `_union_overlapping`. */
function unionOverlapping(items: Footprint[]): Footprint[] {
  if (items.length < 2) return items;
  const boxes = items.map((it) => bboxOfRing(it.ring));
  const areas = items.map((it) => netArea(it.ring, it.holes));
  const uf = new UnionFind(items.length);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (!bboxOverlap(boxes[i], boxes[j])) continue;
      const smaller = Math.min(areas[i], areas[j]);
      if (smaller <= 0) continue;
      const shared = intersectionArea(items[i].ring, items[j].ring);
      if (shared >= Math.max(OVERLAP_MIN_AREA_M2, OVERLAP_MIN_RATIO * smaller)) uf.union(i, j);
    }
  }
  const out: Footprint[] = [];
  for (const idx of uf.groups()) {
    if (idx.length === 1) {
      out.push(items[idx[0]]);
      continue;
    }
    let merged = items[idx[0]].ring;
    for (let k = 1; k < idx.length; k++) merged = unionPair(merged, items[idx[k]].ring);
    const cleaned = cleanRing(merged);
    if (!cleaned) {
      let biggest = idx[0];
      for (const i of idx) if (areas[i] > areas[biggest]) biggest = i;
      out.push(items[biggest]);
      continue;
    }
    // Holes: keep any constituent hole whose centroid still falls inside the merged ring.
    const holes: Ring[] = [];
    for (const i of idx) {
      for (const h of items[i].holes) {
        const [hx, hy] = centroidWithHoles(h, []);
        if (pointInRing([hx, hy], cleaned)) holes.push(h);
      }
    }
    out.push(mergeGroup(items, idx, cleaned, holes));
  }
  return out;
}

// ---------------------------------------------------------------------------
// emission helpers
// ---------------------------------------------------------------------------

// Emission-boundary rounding returns plain mutable tuples, not the internal
// (readonly) Point/Ring aliases: these values are what get assigned into
// the frozen contract's Building/Road/AreaFeature/Tree fields, whose Point
// is `[number, number]` (mutable). The values are identical either way;
// only the TS-level readonly modifier differs.
function roundPoint(p: Point): [number, number] {
  return [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000];
}

function roundRingClosingDropped(ring: Ring): [number, number][] {
  const out: [number, number][] = [];
  for (const p of ring) {
    const rp = roundPoint(p);
    const last = out[out.length - 1];
    if (!last || last[0] !== rp[0] || last[1] !== rp[1]) out.push(rp);
  }
  while (out.length > 1) {
    const f = out[0];
    const l = out[out.length - 1];
    if (f[0] === l[0] && f[1] === l[1]) out.pop();
    else break;
  }
  return out;
}

function croppedParts(ring: Ring, holes: Ring[], square: Ring): RingHoles[] {
  const clipped = clipPolygonToSquare(ring, square, MIN_FEATURE_AREA_M2);
  const out: RingHoles[] = [];
  for (const piece of clipped) {
    const snapped = snapRing(piece, EMIT_GRID_M);
    if (snapped.length < 3 || area(snapped) < MIN_FEATURE_AREA_M2) continue;
    // Re-derive which holes still fall inside this (possibly clipped) piece.
    const keptHoles: Ring[] = [];
    for (const h of holes) {
      const [hx, hy] = centroidWithHoles(h, []);
      if (pointInRing([hx, hy], snapped)) {
        const clippedHole = clipPolygonToSquare(h, square, 0);
        if (clippedHole.length) keptHoles.push(snapRing(clippedHole[0], EMIT_GRID_M));
      }
    }
    out.push({ ring: snapped, holes: keptHoles });
  }
  return out;
}

/**
 * An `AreaFeature` as this module builds it: the contract's `ring`/`holes` in
 * plain mutable tuples (see `roundPoint`), plus the v4 identity.
 */
type MutableArea = {
  ring: [number, number][];
  holes: [number, number][][];
  name?: string;
  osm_id?: string;
  kind?: string;
};

/** One named entity and the footprint that ranks it against the name budget. */
export interface NameCandidate {
  entity: { name?: string };
  /** Printed footprint, square metres: polygon net area, or a road's length times its width. */
  areaM2: number;
}

/**
 * Spend the scene's name budget on the biggest features and drop the rest.
 *
 * Returns how many names were dropped. Deterministic: candidates are ranked by
 * footprint, largest first, ties broken by the order they were emitted in
 * (`Array.prototype.sort` is stable), so the same Overpass response always
 * yields the same scene, which is what the region hashes and the
 * scene hash rely on.
 *
 * A single name never exceeds the budget on its own in practice (120
 * characters at most, so at most ~490 bytes against 128 000), but the loop
 * keeps going after a name it could not afford rather than stopping: a run of
 * huge names must not cost a small one that still fits.
 */
export function applyNameBudget(
  candidates: readonly NameCandidate[],
  budgetBytes: number,
): number {
  let total = 0;
  for (const candidate of candidates) {
    total += nameFieldBytes(candidate.entity.name ?? "");
  }
  if (total <= budgetBytes) return 0;

  const ranked = [...candidates].sort((a, b) => b.areaM2 - a.areaM2);
  let spent = 0;
  let dropped = 0;
  for (const candidate of ranked) {
    const name = candidate.entity.name;
    if (name === undefined) continue;
    const cost = nameFieldBytes(name);
    if (spent + cost <= budgetBytes) {
      spent += cost;
      continue;
    }
    candidate.entity.name = undefined;
    dropped += 1;
  }
  return dropped;
}

/** Centreline length of an open path, metres. */
function pathLengthM(path: readonly [number, number][]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  }
  return total;
}

class UniqueIds {
  private seen = new Set<string>();
  take(base: string): string {
    if (!this.seen.has(base)) {
      this.seen.add(base);
      return base;
    }
    let n = 1;
    while (this.seen.has(`${base}-${n}`)) n++;
    const candidate = `${base}-${n}`;
    this.seen.add(candidate);
    return candidate;
  }
}

// ---------------------------------------------------------------------------
// main entry point
// ---------------------------------------------------------------------------

export interface NormalizeOptions {
  /** Height inference tuning (contracts v3 `PrintParams.heights`); defaults to the frozen 03 constants. */
  heights?: HeightRules;
}

/**
 * One emitted building before its height is known: everything `sceneFromProjected`
 * copies onto the `EngineBuilding` verbatim, plus the deferred height decision.
 */
export interface ProjectedBuilding {
  id: string;
  ring: [number, number][];
  holes: [number, number][][];
  pick: HeightPick;
  name?: string;
  osm_id?: string;
  kind?: string;
  landmark?: boolean;
  tourism?: string;
  historic?: string;
  wikidata?: string;
}

/**
 * Everything the normaliser derives from a response that does not depend on
 * the height rules: the projected, cleaned, cropped layers, with the buildings
 * carrying their height decision deferred (`HeightPick`).
 *
 * The split exists for the pipeline's cache. `heights.*` is a parameter, so
 * the `normalise` stage re-runs when a storey height changes, and on the
 * Chicago Loop that run was 500 to 700 ms of which the height rules touch
 * about 5: the water and green dissolve alone is three quarters of it
 * (`osm.project.areas`). Projecting once per fetched response and applying
 * the rules per run keeps the stage a pure function of its declared inputs
 * while paying the geometry once (v3-07 section 3, the one miss).
 */
export interface ProjectedScene {
  request: SceneRequest;
  buildings: ProjectedBuilding[];
  roads: EngineRoad[];
  rail: Rail[];
  water: EngineSceneGraph["water"];
  green: EngineSceneGraph["green"];
  trees: EngineSceneGraph["trees"];
  /** Net area of the emitted building footprints, m2: the coverage classification's numerator. */
  footprintAreaM2: number;
  /** How many names the scene's name budget dropped (`applyNameBudget`). */
  namesDropped: number;
}

export function sceneFromOverpass(raw: OverpassResponse, request: SceneRequest, options: NormalizeOptions = {}): EngineSceneGraph {
  return sceneFromProjected(projectOverpass(raw, request), options);
}

/**
 * Classify -> project -> hygiene -> crop -> emit, for every layer, with the
 * buildings' heights left undecided. Pure and deterministic for a fixed
 * `raw`/`request`; `sceneFromProjected` applies the rules.
 *
 * Perf rows under `osm.project`, one per section, so a slow ingest can be
 * blamed on the right step. No-ops with perf mode off.
 */
export function projectOverpass(raw: OverpassResponse, request: SceneRequest): ProjectedScene {
  const frame = new LocalFrame(request.lat, request.lon, request.rotation_deg);
  const radius = request.radius_m;
  const square = cropSquare(radius);

  const elements = raw.elements ?? [];
  const outerWays = buildingRelationOuterWays(elements);

  const polys: Record<"building" | "water" | "green", PolyElement[]> = { building: [], water: [], green: [] };
  const lines: { osmId: string; tags: Tags; coords: Point[] }[] = [];
  const railLines: { osmId: string; tags: Tags; coords: Point[] }[] = [];
  const points: { osmId: string; tags: Tags; xy: Point }[] = [];

  perfSpan("osm.project.classify", () => {
    for (const element of elements) {
      const tags = tagsOf(element);
      const layer = layerOf(element, tags);
      if (layer === null) continue;
      if (layer === "building" && element.type === "way" && outerWays.has(element.id)) continue; // relation is authoritative

      const id = osmId(element);

      if (layer === "tree") {
        if (element.lon === undefined || element.lat === undefined) continue;
        points.push({ osmId: id, tags, xy: frame.pointToLocal(element.lon, element.lat) });
        continue;
      }

      if (layer === "road" || layer === "rail") {
        const coords = projectGeometry(element.geometry, frame);
        if (!coords) continue;
        (layer === "road" ? lines : railLines).push({ osmId: id, tags, coords });
        continue;
      }

      const entry: PolyElement = { osmId: id, tags, outer: [], inner: [] };
      if (element.type === "way") {
        const coords = projectGeometry(element.geometry, frame);
        if (!coords) continue;
        entry.outer.push({ coords });
      } else if (element.type === "relation") {
        for (const member of element.members ?? []) {
          if (member.type !== "way") continue;
          const coords = projectGeometry(member.geometry, frame);
          if (!coords) continue;
          if (member.role === "inner") entry.inner.push({ coords });
          else entry.outer.push({ coords });
        }
        if (entry.outer.length === 0) continue;
      } else {
        continue;
      }
      polys[layer as "building" | "water" | "green"].push(entry);
    }
  });

  // -- buildings: hygiene steps 1-7 -------------------------------------
  const footprints = perfSpan("osm.project.buildings", () => {
    let out: Footprint[] = [];
    for (const element of polys.building) {
      const parts = elementGeometry(element);
      if (parts.length === 0) continue;
      // The height is decided per element once the rules are known; every
      // part of a split element shares the decision, as it shared the tags.
      const pick: HeightPick = { kind: "leaf", tags: element.tags, osmId: element.osmId };
      const landmark = isLandmark(element.tags);
      const name = nameOf(element.tags);
      const kind = kindOf("building", element.tags);
      const tourism = typeof element.tags["tourism"] === "string" ? (element.tags["tourism"] as string) : undefined;
      const historic = typeof element.tags["historic"] === "string" ? (element.tags["historic"] as string) : undefined;
      const wikidata = typeof element.tags["wikidata"] === "string" ? (element.tags["wikidata"] as string) : undefined;
      for (const part of parts) {
        if (netArea(part.ring, part.holes) < MIN_FEATURE_AREA_M2) continue;
        out.push({
          osmId: element.osmId,
          ring: part.ring,
          holes: part.holes,
          pick,
          name,
          kind,
          landmark,
          tourism,
          historic,
          wikidata,
        });
      }
    }
    out = dedupe(out); // step 6
    out = unionOverlapping(out); // step 7
    return out;
  });

  // -- water / green: per-element hygiene, then dissolve overlaps -------
  // Pre-clip to a padded square (matching the Overpass fetch margin) before
  // dissolve: a `natural=water` relation can carry a whole lake's shoreline
  // (the Chicago fixture's Lake Michigan ring has 47k vertices) even though
  // only a sliver of it falls near the crop. dissolveRings is O(n^2) pairs
  // times O(n*m) per Greiner-Hormann pair, so leaving that ring at full size
  // made this stage alone take ~2.6 s; clipping first bounds every ring to
  // the working area (holes included) before any pairwise geometry runs.
  // `croppedParts` still does the exact, final crop later. [V3-P2-E1]
  const padSquare = cropSquare(radius * 1.3);
  const areaGeoms: Record<"water" | "green", AreaGeom[]> = { water: [], green: [] };
  perfSpan("osm.project.areas", () => {
    for (const layer of ["water", "green"] as const) {
      let cleaned: AreaGeom[] = [];
      for (const element of polys[layer]) {
        const parts = elementGeometry(element);
        const source: AreaSource = {
          osmId: element.osmId,
          name: nameOf(element.tags),
          kind: kindOf(layer, element.tags),
        };
        for (const part of parts) {
          if (netArea(part.ring, part.holes) < MIN_FEATURE_AREA_M2) continue;
          const clippedRings = clipPolygonToSquare(part.ring, padSquare, 0);
          for (const ring of clippedRings) {
            const holes = part.holes
              .map((h) => clipPolygonToSquare(h, padSquare, 0)[0])
              .filter((h): h is Ring => h !== undefined && h.length >= 3);
            cleaned.push({ ring, holes, source });
          }
        }
      }
      if (cleaned.length > 1) {
        const dissolved = dissolveRingsGrouped(cleaned.map((c) => c.ring));
        // Holes: keep any whose centroid falls inside a dissolved piece.
        const allHoles = cleaned.flatMap((c) => c.holes);
        const before = cleaned;
        cleaned = dissolved.map(({ ring, members }) => {
          const holes = allHoles.filter((h) => {
            const [hx, hy] = centroidWithHoles(h, []);
            return pointInRing([hx, hy], ring);
          });
          // The representative element is the biggest contributor to this
          // polygon, so a lake named by one of the ways that make it up is named
          // by the LARGEST of them rather than by whichever Overpass listed
          // first. `AreaFeature.osm_id` says in the contract that this is one
          // contributor and not the only one.
          let best = members[0];
          let bestArea = -Infinity;
          for (const i of members) {
            const a = netArea(before[i].ring, before[i].holes);
            if (a > bestArea) {
              bestArea = a;
              best = i;
            }
          }
          return { ring, holes, source: before[best].source };
        });
      }
      areaGeoms[layer] = cleaned;
    }
  });

  // -- crop + emit --------------------------------------------------------
  const buildings: ProjectedBuilding[] = [];
  const buildingIds = new UniqueIds();
  let footprintArea = 0;
  // Every entity that carries a name, with the footprint that decides which
  // names survive the budget (see SCENE_NAME_BUDGET_BYTES).
  const named: NameCandidate[] = [];
  perfSpan("osm.project.emit-buildings", () => {
    for (const item of footprints) {
      for (const part of croppedParts(item.ring, item.holes, square)) {
        const ring = roundRingClosingDropped(part.ring);
        const holes = part.holes.map(roundRingClosingDropped).filter((h) => h.length >= 3 && area(h) >= MIN_FEATURE_AREA_M2);
        if (ring.length < 3) continue;
        const partArea = netArea(ring, holes);
        footprintArea += partArea;
        const id = buildingIds.take(item.osmId);
        const building: ProjectedBuilding = {
          id,
          ring,
          holes,
          pick: item.pick,
          name: item.name,
          osm_id: osmIdIfSplit(id, item.osmId),
          kind: item.kind,
          landmark: item.landmark,
          tourism: item.tourism,
          historic: item.historic,
          wikidata: item.wikidata,
        };
        buildings.push(building);
        if (building.name !== undefined) named.push({ entity: building, areaM2: partArea });
      }
    }
  });

  const roads: EngineRoad[] = [];
  const roadIds = new UniqueIds();
  perfSpan("osm.project.emit-roads", () => {
    for (const element of lines) {
      const simplified = simplifyOpenPath(element.coords, SIMPLIFY_TOLERANCE_M);
      const highway = String(element.tags["highway"]);
      const width = Math.round(roadWidthM(element.tags, highway) * 1000) / 1000;
      if (width <= 0) continue;
      const klass = roadClass(highway) as EngineRoad["class"];
      const bridge = parseBridge(element.tags);
      const layerTag = parseLayer(element.tags);
      const name = nameOf(element.tags);
      const kind = roadKindIfInformative(kindOf("road", element.tags), klass);
      for (const part of clipLineToSquare(simplified, radius, MIN_ROAD_LENGTH_M)) {
        const path = roundOpenPath(part);
        if (path.length < 2) continue;
        const id = roadIds.take(element.osmId);
        const road: EngineRoad = {
          id,
          path,
          width_m: width,
          class: klass,
          bridge: bridge || undefined,
          layer: layerTag !== 0 ? layerTag : undefined,
          name,
          osm_id: osmIdIfSplit(id, element.osmId),
          kind,
        };
        roads.push(road);
        // A road's "footprint" is its ribbon: the printed area it occupies, so a
        // long avenue outranks a short alley the way a big building outranks a
        // shed, on the same scale.
        if (name !== undefined) named.push({ entity: road, areaM2: pathLengthM(path) * width });
      }
    }
  });

  const rail: Rail[] = [];
  const railIds = new UniqueIds();
  perfSpan("osm.project.emit-rail", () => {
    for (const element of railLines) {
      const simplified = simplifyOpenPath(element.coords, SIMPLIFY_TOLERANCE_M);
      const railway = String(element.tags["railway"]);
      const width = RAIL_WIDTH_M[railway] ?? 4.0;
      const bridge = parseBridge(element.tags);
      const layerTag = parseLayer(element.tags);
      for (const part of clipLineToSquare(simplified, radius, MIN_ROAD_LENGTH_M)) {
        const path = roundOpenPath(part);
        if (path.length < 2) continue;
        rail.push({
          id: railIds.take(element.osmId),
          path,
          width_m: width,
          bridge: bridge || undefined,
          layer: layerTag !== 0 ? layerTag : undefined,
        });
      }
    }
  });

  const areas: { water: MutableArea[]; green: MutableArea[] } = { water: [], green: [] };
  perfSpan("osm.project.emit-areas", () => {
    for (const layer of ["water", "green"] as const) {
      for (const geom of areaGeoms[layer]) {
        for (const part of croppedParts(geom.ring, geom.holes, square)) {
          const ring = roundRingClosingDropped(part.ring);
          const holes = part.holes.map(roundRingClosingDropped).filter((h) => h.length >= 3);
          if (ring.length < 3) continue;
          const feature: MutableArea = {
            ring,
            holes,
            name: geom.source.name,
            // Always written: an AreaFeature has no `id` for it to repeat.
            osm_id: geom.source.osmId,
            kind: geom.source.kind,
          };
          areas[layer].push(feature);
          if (feature.name !== undefined) {
            named.push({ entity: feature, areaM2: netArea(ring, holes) });
          }
        }
      }
    }
  });

  const namesDropped = applyNameBudget(named, SCENE_NAME_BUDGET_BYTES);

  const trees: { x: number; y: number; radius_m: number }[] = [];
  for (const element of points) {
    const [x, y] = element.xy;
    if (!inSquare(x, y, radius)) continue;
    const crown = parseLengthM(element.tags["diameter_crown"]);
    let radiusM = crown ? crown / 2.0 : DEFAULT_TREE_RADIUS_M;
    radiusM = Math.min(Math.max(radiusM, MIN_TREE_RADIUS_M), MAX_TREE_RADIUS_M);
    trees.push({ x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, radius_m: Math.round(radiusM * 1000) / 1000 });
  }

  return {
    request,
    buildings,
    roads,
    rail,
    water: areas.water,
    green: areas.green,
    trees,
    footprintAreaM2: footprintArea,
    namesDropped,
  };
}

/**
 * Apply the height rules to a projected scene: the only step of the ingest a
 * `heights.*` leaf reaches. Every building's `height_m`, `height_source`,
 * `min_height_m` and `is_tall`, and the stats that count them; every other
 * layer is the projection's own array, unchanged and shared.
 */
export function sceneFromProjected(projected: ProjectedScene, options: NormalizeOptions = {}): EngineSceneGraph {
  const heightRules = options.heights ?? heightRulesFrom(undefined);
  const { request } = projected;
  const radius = request.radius_m;

  const buildings: EngineBuilding[] = perfSpan("osm.heights", () =>
    projected.buildings.map((item) => {
      const h = resolvePick(item.pick, heightRules);
      const heightM = Math.round(h.heightM * 1000) / 1000;
      let minHeightM = Math.round(h.minHeightM * 1000) / 1000;
      if (minHeightM >= heightM) minHeightM = 0;
      return {
        id: item.id,
        ring: item.ring,
        holes: item.holes,
        height_m: heightM,
        height_source: h.heightSource,
        min_height_m: minHeightM,
        is_tall: heightM >= 40,
        name: item.name,
        osm_id: item.osm_id,
        kind: item.kind,
        landmark: item.landmark,
        tourism: item.tourism,
        historic: item.historic,
        wikidata: item.wikidata,
      };
    }),
  );

  const tagged = buildings.filter((b) => b.height_source === "tag").length;
  const count = buildings.length;
  // Tallied over the final, emitted building list (post dedupe/union/crop),
  // matching height_tag_ratio's own accounting, so the three counts always
  // sum to building_count.
  const heightFallback: HeightFallbackCounts = { tag: 0, levels: 0, default: 0 };
  for (const b of buildings) heightFallback[b.height_source]++;
  const stats: EngineStats = {
    building_count: count,
    coverage: classifyCoverage(count, projected.footprintAreaM2, (2.0 * radius) ** 2),
    height_tag_ratio: count ? Math.round((tagged / count) * 1e6) / 1e6 : 0.0,
    height_fallback_counts: heightFallback,
    // Absent, not zero, on every scene inside the budget: this key exists to
    // be reported, and a scene that lost nothing has nothing to report.
    names_dropped: projected.namesDropped > 0 ? projected.namesDropped : undefined,
  };

  return {
    bounds: { min_x: -radius, min_y: -radius, max_x: radius, max_y: radius },
    center: { lat: request.lat, lon: request.lon },
    buildings,
    roads: projected.roads,
    rail: projected.rail,
    water: projected.water,
    green: projected.green,
    trees: projected.trees,
    stats,
  };
}

/** Roads/rail are simplified as open paths (LineString), not closed rings. */
function simplifyOpenPath(points: Point[], toleranceM: number): Point[] {
  if (points.length < 3) return points;
  return douglasPeucker(points, toleranceM);
}

function douglasPeucker(points: Point[], toleranceM: number): Point[] {
  const tol2 = toleranceM * toleranceM;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    if (end <= start + 1) continue;
    let maxD = -1;
    let maxI = -1;
    for (let i = start + 1; i < end; i++) {
      const d = segPointDist2(points[i], points[start], points[end]);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > tol2) {
      keep[maxI] = 1;
      stack.push([start, maxI], [maxI, end]);
    }
  }
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

function segPointDist2(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) {
    const ddx = p[0] - a[0];
    const ddy = p[1] - a[1];
    return ddx * ddx + ddy * ddy;
  }
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a[0] + t * dx;
  const cy = a[1] + t * dy;
  const ddx = p[0] - cx;
  const ddy = p[1] - cy;
  return ddx * ddx + ddy * ddy;
}

function roundOpenPath(points: Point[]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of points) {
    const rp = roundPoint(p);
    const last = out[out.length - 1];
    if (!last || last[0] !== rp[0] || last[1] !== rp[1]) out.push(rp);
  }
  return out;
}
