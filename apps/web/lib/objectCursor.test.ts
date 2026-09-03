/**
 * The keyboard walk over the three layers `heroCursor` does not cover.
 *
 * What is pinned here is what makes the walk usable rather than merely
 * present: the order is total (so a cursor never jumps when nothing moved),
 * the layer step skips layers this scene has nothing on (so no press lands on
 * "Water 0 of 0"), and every stop carries the SAME `ObjectInfo` a hover over
 * that object would have produced -- which is what lets the inspector opened
 * from the keyboard be the inspector opened from the pointer, keyed by the same
 * base OSM id.
 */

import { describe, expect, it } from "vitest";

import type { AreaFeature, Road, SceneGraph } from "./contracts";
import {
  CURSOR_LAYERS,
  layerStepFor,
  layerStops,
  moveStop,
  stepLayer,
  stopAt,
  stopLabel,
} from "./objectCursor";

function road(id: string, path: Array<[number, number]>, extra: Partial<Road> = {}): Road {
  return { id, kind: "residential", width_m: 6, path, ...extra } as Road;
}

function area(osmId: string, size: number, extra: Partial<AreaFeature> = {}): AreaFeature {
  return {
    osm_id: osmId,
    kind: "park",
    ring: [
      [0, 0],
      [size, 0],
      [size, size],
      [0, size],
    ],
    holes: [],
    ...extra,
  } as AreaFeature;
}

function scene(partial: Partial<SceneGraph>): SceneGraph {
  return {
    bounds: { min_x: -100, min_y: -100, max_x: 100, max_y: 100 },
    buildings: [],
    roads: [],
    water: [],
    green: [],
    ...partial,
  } as SceneGraph;
}

describe("layerStops", () => {
  it("orders roads longest first, with a total tie-break", () => {
    const stops = layerStops(
      scene({
        roads: [
          road("w2", [
            [0, 0],
            [10, 0],
          ]),
          road("w9", [
            [0, 0],
            [50, 0],
          ], { name: "Michigan Avenue" }),
          road("w1", [
            [0, 0],
            [10, 0],
          ]),
        ],
      }),
      "road",
    );
    expect(stops.map((stop) => stop.info.osmId)).toEqual(["w9", "w1", "w2"]);
    expect(stops[0].info.title).toBe("Michigan Avenue");
    // The detail is the fact that ranked it, in the shared unit words.
    expect(stops[0].detail).toContain("m");
  });

  it("orders polygons by area and carries the layer's own describe()", () => {
    const stops = layerStops(scene({ green: [area("w1", 10), area("w2", 40)] }), "green");
    expect(stops.map((stop) => stop.info.osmId)).toEqual(["w2", "w1"]);
    expect(stops[0].info.layer).toBe("green");
    // The stop's key IS the popover's key for the same polygon, so the cursor
    // and the hover cannot disagree about what "the same object" means.
    expect(stops[0].key).toBe(stops[0].info.key);
  });

  it("skips a road with no segment and a polygon with no ring", () => {
    expect(layerStops(scene({ roads: [road("w1", [[0, 0]])] }), "road")).toEqual([]);
    expect(layerStops(scene({ water: [area("w1", 10, { ring: [] })] }), "water")).toEqual([]);
  });

  it("is empty with no scene at all", () => {
    expect(layerStops(null, "road")).toEqual([]);
  });
});

describe("stepLayer", () => {
  const full = { building: 900, road: 400, water: 3, green: 12 };

  it("walks the four layers in order and wraps", () => {
    expect(stepLayer("building", 1, full)).toBe("road");
    expect(stepLayer("green", 1, full)).toBe("building");
    expect(stepLayer("building", -1, full)).toBe("green");
  });

  it("steps over a layer this scene has nothing on", () => {
    expect(stepLayer("road", 1, { ...full, water: 0 })).toBe("green");
    expect(stepLayer("green", -1, { ...full, water: 0 })).toBe("road");
  });

  it("stays put when no layer has anything", () => {
    expect(stepLayer("building", 1, { building: 0, road: 0, water: 0, green: 0 })).toBe("building");
  });

  it("covers every layer the cursor can be on", () => {
    expect([...CURSOR_LAYERS].sort()).toEqual(["building", "green", "road", "water"]);
  });
});

describe("layerStepFor", () => {
  it("claims Page Up and Page Down, and nothing a modifier is held on", () => {
    expect(layerStepFor({ key: "PageDown" })).toBe(1);
    expect(layerStepFor({ key: "PageUp" })).toBe(-1);
    expect(layerStepFor({ key: "PageDown", ctrlKey: true })).toBeNull();
    expect(layerStepFor({ key: "ArrowDown" })).toBeNull();
  });
});

describe("moveStop", () => {
  const stops = layerStops(
    scene({
      roads: [
        road("w1", [
          [0, 0],
          [30, 0],
        ]),
        road("w2", [
          [0, 0],
          [20, 0],
        ]),
        road("w3", [
          [0, 0],
          [10, 0],
        ]),
      ],
    }),
    "road",
  );

  it("starts at the biggest thing on the layer from no cursor at all", () => {
    expect(moveStop(stops, null, "next")).toBe(stops[0].key);
    expect(moveStop(stops, null, "previous")).toBe(stops[0].key);
  });

  it("clamps at both ends rather than wrapping", () => {
    expect(moveStop(stops, stops[2].key, "next")).toBe(stops[2].key);
    expect(moveStop(stops, stops[0].key, "previous")).toBe(stops[0].key);
  });

  it("jumps with first and last", () => {
    expect(moveStop(stops, stops[1].key, "first")).toBe(stops[0].key);
    expect(moveStop(stops, stops[1].key, "last")).toBe(stops[2].key);
  });

  it("restarts when the object under the cursor has left the scene", () => {
    expect(moveStop(stops, "road:gone", "next")).toBe(stops[0].key);
    expect(moveStop([], "road:gone", "next")).toBeNull();
  });
});

describe("stopLabel and stopAt", () => {
  const stops = layerStops(
    scene({
      water: [area("w7", 40, { kind: "river", name: "Chicago River" })],
    }),
    "water",
  );

  it("announces the layer, the position, the name and the ranking fact", () => {
    const label = stopLabel("water", stops, stops[0].key) ?? "";
    expect(label).toContain("Water 1 of 1");
    expect(label).toContain("Chicago River");
  });

  it("says nothing about a cursor that is nowhere", () => {
    expect(stopLabel("water", stops, null)).toBeNull();
    expect(stopLabel("water", stops, "water:gone")).toBeNull();
    expect(stopAt(stops, null)).toBeNull();
    expect(stopAt(stops, stops[0].key)?.info.osmId).toBe("w7");
  });
});
