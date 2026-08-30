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
  type HeightRules,
} from "./heights";
import { LocalFrame, clipLineToSquare, clipPolygonToSquare, cropSquare, inSquare } from "./project";
import type { EngineBuilding, EngineRoad, EngineSceneGraph, HeightFallbackCounts, Rail } from "./types";

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
  const cleaned = rings.filter((r) => r.length >= 3);
  if (cleaned.length <= 1) return cleaned;
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
  const out: Ring[] = [];
  for (const idx of groups.values()) {
    if (idx.length === 1) {
      out.push(cleaned[idx[0]]);
      continue;
    }
    let merged = cleaned[idx[0]];
    for (let k = 1; k < idx.length; k++) merged = unionPair(merged, cleaned[idx[k]]);
    out.push(merged);
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

interface Footprint {
  osmId: string;
  ring: Ring;
  holes: Ring[];
  heightM: number;
  heightSource: "tag" | "levels" | "default";
  minHeightM: number;
  name?: string;
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
  let best = idx[0];
  for (const i of idx) {
    if (items[i].heightM > items[best].heightM || (items[i].heightM === items[best].heightM && netArea(items[i].ring, items[i].holes) > netArea(items[best].ring, items[best].holes))) {
      best = i;
    }
  }
  let keep = keeper;
  if (keep === undefined) {
    keep = idx[0];
    for (const i of idx) if (netArea(items[i].ring, items[i].holes) > netArea(items[keep].ring, items[keep].holes)) keep = i;
  }
  let minHeight = Infinity;
  for (const i of idx) minHeight = Math.min(minHeight, items[i].minHeightM);
  return {
    osmId: items[keep].osmId,
    ring,
    holes,
    heightM: items[best].heightM,
    heightSource: items[best].heightSource,
    minHeightM: minHeight,
    name: items[keep].name,
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

export function sceneFromOverpass(raw: OverpassResponse, request: SceneRequest, options: NormalizeOptions = {}): EngineSceneGraph {
  const frame = new LocalFrame(request.lat, request.lon, request.rotation_deg);
  const radius = request.radius_m;
  const square = cropSquare(radius);
  const heightRules = options.heights ?? heightRulesFrom(undefined);

  const elements = raw.elements ?? [];
  const outerWays = buildingRelationOuterWays(elements);

  const polys: Record<"building" | "water" | "green", PolyElement[]> = { building: [], water: [], green: [] };
  const lines: { osmId: string; tags: Tags; coords: Point[] }[] = [];
  const railLines: { osmId: string; tags: Tags; coords: Point[] }[] = [];
  const points: { osmId: string; tags: Tags; xy: Point }[] = [];

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

  // -- buildings: hygiene steps 1-7 -------------------------------------
  let footprints: Footprint[] = [];
  for (const element of polys.building) {
    const parts = elementGeometry(element);
    if (parts.length === 0) continue;
    const h = resolveHeightWith(element.tags, element.osmId, heightRules);
    const landmark = isLandmark(element.tags);
    const name = typeof element.tags["name"] === "string" ? (element.tags["name"] as string) : undefined;
    const tourism = typeof element.tags["tourism"] === "string" ? (element.tags["tourism"] as string) : undefined;
    const historic = typeof element.tags["historic"] === "string" ? (element.tags["historic"] as string) : undefined;
    const wikidata = typeof element.tags["wikidata"] === "string" ? (element.tags["wikidata"] as string) : undefined;
    for (const part of parts) {
      if (netArea(part.ring, part.holes) < MIN_FEATURE_AREA_M2) continue;
      footprints.push({
        osmId: element.osmId,
        ring: part.ring,
        holes: part.holes,
        heightM: h.heightM,
        heightSource: h.heightSource,
        minHeightM: h.minHeightM,
        name,
        landmark,
        tourism,
        historic,
        wikidata,
      });
    }
  }
  footprints = dedupe(footprints); // step 6
  footprints = unionOverlapping(footprints); // step 7

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
  const areaGeoms: Record<"water" | "green", RingHoles[]> = { water: [], green: [] };
  for (const layer of ["water", "green"] as const) {
    let cleaned: RingHoles[] = [];
    for (const element of polys[layer]) {
      const parts = elementGeometry(element);
      for (const part of parts) {
        if (netArea(part.ring, part.holes) < MIN_FEATURE_AREA_M2) continue;
        const clippedRings = clipPolygonToSquare(part.ring, padSquare, 0);
        for (const ring of clippedRings) {
          const holes = part.holes
            .map((h) => clipPolygonToSquare(h, padSquare, 0)[0])
            .filter((h): h is Ring => h !== undefined && h.length >= 3);
          cleaned.push({ ring, holes });
        }
      }
    }
    if (cleaned.length > 1) {
      const dissolved = dissolveRings(cleaned.map((c) => c.ring));
      // Holes: keep any whose centroid falls inside a dissolved piece.
      const allHoles = cleaned.flatMap((c) => c.holes);
      cleaned = dissolved.map((ring) => {
        const holes = allHoles.filter((h) => {
          const [hx, hy] = centroidWithHoles(h, []);
          return pointInRing([hx, hy], ring);
        });
        return { ring, holes };
      });
    }
    areaGeoms[layer] = cleaned;
  }

  // -- crop + emit --------------------------------------------------------
  const buildings: EngineBuilding[] = [];
  const buildingIds = new UniqueIds();
  let footprintArea = 0;
  for (const item of footprints) {
    for (const part of croppedParts(item.ring, item.holes, square)) {
      const ring = roundRingClosingDropped(part.ring);
      const holes = part.holes.map(roundRingClosingDropped).filter((h) => h.length >= 3 && area(h) >= MIN_FEATURE_AREA_M2);
      if (ring.length < 3) continue;
      footprintArea += netArea(ring, holes);
      const heightM = Math.round(item.heightM * 1000) / 1000;
      let minHeightM = Math.round(item.minHeightM * 1000) / 1000;
      if (minHeightM >= heightM) minHeightM = 0;
      buildings.push({
        id: buildingIds.take(item.osmId),
        ring,
        holes,
        height_m: heightM,
        height_source: item.heightSource,
        min_height_m: minHeightM,
        is_tall: heightM >= 40,
        name: item.name,
        landmark: item.landmark,
        tourism: item.tourism,
        historic: item.historic,
        wikidata: item.wikidata,
      });
    }
  }

  const roads: EngineRoad[] = [];
  const roadIds = new UniqueIds();
  for (const element of lines) {
    const simplified = simplifyOpenPath(element.coords, SIMPLIFY_TOLERANCE_M);
    const highway = String(element.tags["highway"]);
    const width = Math.round(roadWidthM(element.tags, highway) * 1000) / 1000;
    if (width <= 0) continue;
    const klass = roadClass(highway) as EngineRoad["class"];
    const bridge = parseBridge(element.tags);
    const layerTag = parseLayer(element.tags);
    for (const part of clipLineToSquare(simplified, radius, MIN_ROAD_LENGTH_M)) {
      const path = roundOpenPath(part);
      if (path.length < 2) continue;
      roads.push({
        id: roadIds.take(element.osmId),
        path,
        width_m: width,
        class: klass,
        bridge: bridge || undefined,
        layer: layerTag !== 0 ? layerTag : undefined,
      });
    }
  }

  const rail: Rail[] = [];
  const railIds = new UniqueIds();
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

  type MutableRingHoles = { ring: [number, number][]; holes: [number, number][][] };
  const areas: { water: MutableRingHoles[]; green: MutableRingHoles[] } = { water: [], green: [] };
  for (const layer of ["water", "green"] as const) {
    for (const geom of areaGeoms[layer]) {
      for (const part of croppedParts(geom.ring, geom.holes, square)) {
        const ring = roundRingClosingDropped(part.ring);
        const holes = part.holes.map(roundRingClosingDropped).filter((h) => h.length >= 3);
        if (ring.length >= 3) areas[layer].push({ ring, holes });
      }
    }
  }

  const trees: { x: number; y: number; radius_m: number }[] = [];
  for (const element of points) {
    const [x, y] = element.xy;
    if (!inSquare(x, y, radius)) continue;
    const crown = parseLengthM(element.tags["diameter_crown"]);
    let radiusM = crown ? crown / 2.0 : DEFAULT_TREE_RADIUS_M;
    radiusM = Math.min(Math.max(radiusM, MIN_TREE_RADIUS_M), MAX_TREE_RADIUS_M);
    trees.push({ x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, radius_m: Math.round(radiusM * 1000) / 1000 });
  }

  const tagged = buildings.filter((b) => b.height_source === "tag").length;
  const count = buildings.length;
  // Tallied over the final, emitted building list (post dedupe/union/crop),
  // matching height_tag_ratio's own accounting, so the three counts always
  // sum to building_count.
  const heightFallback: HeightFallbackCounts = { tag: 0, levels: 0, default: 0 };
  for (const b of buildings) heightFallback[b.height_source]++;
  const stats = {
    building_count: count,
    coverage: classifyCoverage(count, footprintArea, (2.0 * radius) ** 2),
    height_tag_ratio: count ? Math.round((tagged / count) * 1e6) / 1e6 : 0.0,
    height_fallback_counts: heightFallback,
  };

  return {
    bounds: { min_x: -radius, min_y: -radius, max_x: radius, max_y: radius },
    center: { lat: request.lat, lon: request.lon },
    buildings,
    roads,
    rail,
    water: areas.water,
    green: areas.green,
    trees,
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
