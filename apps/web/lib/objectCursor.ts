/**
 * The keyboard's way to every object a right-click can reach (v3.1 Task 11).
 *
 * `lib/heroCursor.ts` walks BUILDINGS, because that is what a hero is. The
 * inspector, though, acts on four layers: a road can be widened, engraved or
 * left out, a park or a lake can be raised, sunk or recoloured, and every one
 * of those decisions is reachable with a right-click. A control that can only
 * be reached with a pointer is WCAG 2.1.1 Keyboard (Level A) on a real
 * function, so the viewport's cursor walks the other three layers too:
 * PageDown and PageUp change LAYER, the arrows walk within one.
 *
 * Buildings deliberately stay on `heroCursor`: their walk is the repaired
 * preview order (tallest first, post-minimum-feature), which only the editor's
 * own footprint pass knows, and Enter on a building still means "make it a
 * hero". This module is the other three layers, ordered by the one fact that
 * ranks them - a road by how long it is, a polygon by how much ground it
 * covers - so the first press lands on the avenue or the park a person would
 * have aimed at rather than on an arbitrary alley.
 *
 * Pure data in, stops out: no three.js and no DOM, so the whole walk is
 * testable without a renderer (`lib/objectCursor.test.ts`).
 */

import type { AreaFeature, Road, SceneGraph } from "./contracts";
import {
  describeArea,
  describeRoad,
  featureArea,
  metres,
  pathLength,
  squareMetres,
  type ObjectInfo,
} from "./objectInfo";

/** The four layers the cursor can be on, in the order PageDown visits them. */
export type CursorLayer = "building" | "road" | "water" | "green";

export const CURSOR_LAYERS: readonly CursorLayer[] = ["building", "road", "water", "green"];

/** What the readout calls one stop on each layer. */
export const CURSOR_LAYER_NOUNS: Readonly<Record<CursorLayer, string>> = {
  building: "Building",
  road: "Road",
  water: "Water",
  green: "Green space",
};

/** One stop on a non-building layer's walk. */
export interface CursorStop {
  /** `ObjectInfo.key`: the cursor's identity IS the popover's identity. */
  key: string;
  /** The one fact that ranked it, for the announcement. */
  detail: string;
  info: ObjectInfo;
}

/**
 * One layer's stops, biggest first.
 *
 * The distance handed to `describeRoad`/`describeArea` is zero, and honestly
 * so: a keyboard stop is not a raycast that landed near something, it names the
 * entity outright.
 */
export function layerStops(
  graph: SceneGraph | null,
  layer: Exclude<CursorLayer, "building">,
): CursorStop[] {
  if (graph === null) return [];
  if (layer === "road") return roadStops(graph.roads);
  return areaStops(layer === "water" ? graph.water : graph.green, layer);
}

function roadStops(roads: readonly Road[]): CursorStop[] {
  const stops = roads
    .filter((road) => road.path.length >= 2)
    .map((road) => ({ road, length: pathLength(road.path) }));
  // Every tie-break is total: two equal-length service roads must not swap
  // places between renders, or the cursor would jump when nothing moved.
  stops.sort((a, b) => (b.length !== a.length ? b.length - a.length : compareIds(a.road.id, b.road.id)));
  return stops.map((entry) => {
    const info = describeRoad(entry.road, 0);
    return { key: info.key, detail: metres(entry.length), info };
  });
}

function areaStops(features: readonly AreaFeature[], layer: "water" | "green"): CursorStop[] {
  const stops = features
    .filter((feature) => feature.ring.length >= 3)
    .map((feature) => ({ feature, area: featureArea(feature), info: describeArea(feature, layer, 0) }));
  stops.sort((a, b) => (b.area !== a.area ? b.area - a.area : compareIds(a.info.key, b.info.key)));
  return stops.map((entry) => ({
    key: entry.info.key,
    detail: squareMetres(entry.area),
    info: entry.info,
  }));
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The next layer PageDown/PageUp lands on, skipping the ones this scene has
 * nothing on.
 *
 * A scene with no water must not have a stop on its walk that says "Water 0 of
 * 0": an empty layer is not a place the cursor can be, so it is stepped over.
 * When NOTHING has anything (no scene at all), the layer is left where it is.
 */
export function stepLayer(
  from: CursorLayer,
  direction: 1 | -1,
  counts: Readonly<Record<CursorLayer, number>>,
): CursorLayer {
  const at = CURSOR_LAYERS.indexOf(from);
  const count = CURSOR_LAYERS.length;
  for (let step = 1; step <= count; step += 1) {
    const index = (((at + direction * step) % count) + count) % count;
    const candidate = CURSOR_LAYERS[index];
    if (counts[candidate] > 0) return candidate;
  }
  return from;
}

/** PageDown / PageUp, or null when the key is not a layer step. */
export function layerStepFor(event: {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): 1 | -1 | null {
  if (event.altKey === true || event.ctrlKey === true || event.metaKey === true) return null;
  if (event.key === "PageDown") return 1;
  if (event.key === "PageUp") return -1;
  return null;
}

/**
 * Where an arrow lands on a flat list of stops, clamping at both ends.
 *
 * The same rule `heroCursor.moveCursor` applies to buildings: no cursor yet
 * means the first press shows the biggest thing on the layer rather than
 * stepping off the front of a list nobody can see, and the walk clamps rather
 * than wrapping so Home and End stay the way to jump.
 */
export function moveStop(
  stops: readonly CursorStop[],
  currentKey: string | null,
  step: "next" | "previous" | "first" | "last",
): string | null {
  if (stops.length === 0) return null;
  if (step === "first") return stops[0].key;
  if (step === "last") return stops[stops.length - 1].key;
  const index = currentKey === null ? -1 : stops.findIndex((stop) => stop.key === currentKey);
  if (index === -1) return stops[0].key;
  const next = step === "next" ? index + 1 : index - 1;
  if (next < 0 || next >= stops.length) return stops[index].key;
  return stops[next].key;
}

/** `Road 3 of 412 · Michigan Avenue · 1.2 km` -- what the live region announces. */
export function stopLabel(
  layer: Exclude<CursorLayer, "building">,
  stops: readonly CursorStop[],
  currentKey: string | null,
): string | null {
  if (currentKey === null) return null;
  const index = stops.findIndex((stop) => stop.key === currentKey);
  if (index === -1) return null;
  const stop = stops[index];
  return `${CURSOR_LAYER_NOUNS[layer]} ${index + 1} of ${stops.length} · ${stop.info.title} · ${stop.detail}`;
}

/** The stop a key names, or null when the walk has moved past it. */
export function stopAt(stops: readonly CursorStop[], key: string | null): CursorStop | null {
  if (key === null) return null;
  return stops.find((stop) => stop.key === key) ?? null;
}
