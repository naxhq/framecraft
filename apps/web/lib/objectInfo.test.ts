/**
 * What the object popover says, and how well it knows what it is looking at.
 *
 * Three things are pinned here.
 *
 * 1. **The content, per kind, named and unnamed.** An unnamed object is the
 *    common case in OpenStreetMap and it must not produce an empty card: the
 *    heading falls back to the type and the printing facts are the same either
 *    way.
 * 2. **Building picking is exact.** `RegionMesh.triangleOwner`/`owners` are an
 *    index, so `ownerAt` is a lookup with no tolerance in it, including the
 *    `NO_OWNER` marker and the `block-<n>` ids the finish's merges produce.
 * 3. **Road, water and green picking is nearest-entity, and this is HOW near.**
 *    Those regions carry no per-triangle identity yet, so the accuracy is
 *    measured against the Chicago fixture rather than asserted to be fine, and
 *    the number the measurement produces is what the handoff note reports.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { AreaFeature, Building, Road, SceneRequest } from "./contracts";
import { sceneFromOverpass, type OverpassResponse } from "./engine/osm/normalize";
import type { EngineSceneGraph } from "./engine/osm/types";
import { NO_OWNER, type RegionMesh } from "./engine/types";
import {
  areaAt,
  describeArea,
  distanceToPath,
  describeBuilding,
  describeMergedBlock,
  describeRoad,
  isPickableRegion,
  nameBudgetWarning,
  nearestRoad,
  objectAt,
  ownerAt,
  roadKind,
  sourceOsmId,
} from "./objectInfo";

const FIXTURES_DIR = fileURLToPath(new URL("../../../", import.meta.url));
const RAW = JSON.parse(
  readFileSync(`${FIXTURES_DIR}tests/fixtures/overpass-chicago-loop.json`, "utf-8"),
) as OverpassResponse;
const CHICAGO_LOOP: SceneRequest = {
  lat: 41.8827,
  lon: -87.6233,
  radius_m: 900.0,
  rotation_deg: 0.0,
  preset_id: "chicago-loop",
};
const scene: EngineSceneGraph = sceneFromOverpass(RAW, CHICAGO_LOOP);

const NO_DILATION = new Map<string, number>();
const NO_HEROES = new Set<string>();

function square(size: number): [number, number][] {
  return [
    [0, 0],
    [size, 0],
    [size, size],
    [0, size],
  ];
}

const TOWER: Building = {
  id: "w1",
  ring: square(30),
  holes: [],
  height_m: 92,
  height_source: "tag",
  min_height_m: 0,
  is_tall: true,
  name: "Marquette Building",
  kind: "building=commercial",
};

const SHED: Building = {
  id: "w2-1",
  ring: square(4),
  holes: [],
  height_m: 8,
  height_source: "default",
  min_height_m: 0,
  is_tall: false,
  osm_id: "w2",
  kind: "building=yes",
};

const AVENUE: Road = {
  id: "w10",
  path: [
    [0, 0],
    [100, 0],
  ],
  width_m: 16,
  class: "primary",
  name: "South State Street",
};

const FOOTWAY: Road = {
  id: "w11",
  path: [
    [0, 50],
    [40, 50],
  ],
  width_m: 3,
  class: "path",
  kind: "highway=footway",
};

const PARK: AreaFeature = {
  ring: square(60),
  holes: [],
  name: "Grant Park",
  osm_id: "r99",
  kind: "leisure=park",
};

const POND: AreaFeature = {
  ring: square(20),
  holes: [],
  osm_id: "w98",
  kind: "natural=water",
};

// ===========================================================================
// 1. content, per kind
// ===========================================================================

/** The rows as a lookup, so an assertion names the fact rather than an index. */
function facts(rows: readonly { label: string; value: string }[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.label, row.value]));
}

describe("a named building", () => {
  const info = describeBuilding(TOWER, { hero: false, dilationM: 0 });

  it("leads with the OSM name and says what kind of building it is", () => {
    expect(info.title).toBe("Marquette Building");
    expect(info.named).toBe(true);
    expect(info.typeLabel).toBe("Commercial");
    expect(info.layer).toBe("building");
    expect(info.method).toBe("triangle-owner");
  });

  it("states the height, where the height came from, the footprint and the repair", () => {
    expect(facts(info.rows)).toEqual({
      Height: "92 m",
      Source: "An OSM height tag",
      Footprint: "900 m²",
      Repair: "Prints as measured",
    });
    expect(info.heightSource).toBe("tag");
  });

  it("says when the height was estimated rather than tagged", () => {
    const estimated = describeBuilding(SHED, { hero: false, dilationM: 0 });
    expect(facts(estimated.rows).Source).toBe("Estimated from the building type");
    expect(estimated.heightSource).toBe("default");
    const levels = describeBuilding(
      { ...TOWER, height_source: "levels" },
      { hero: false, dilationM: 0 },
    );
    expect(facts(levels.rows).Source).toBe("Counted from the OSM floor count");
  });

  it("says when the minimum-feature repair widened it, with the number", () => {
    const widened = describeBuilding(SHED, { hero: false, dilationM: 0.284 });
    expect(facts(widened.rows).Repair).toBe("Widened 0.28 m to reach the minimum wall");
  });

  it("says when it is a hero, and stays quiet when it is not", () => {
    const hero = describeBuilding(TOWER, { hero: true, dilationM: 0 });
    expect(hero.hero).toBe(true);
    expect(facts(hero.rows).Hero).toBe("Yes, this one is singled out");
    expect(facts(describeBuilding(TOWER, { hero: false, dilationM: 0 }).rows).Hero).toBeUndefined();
  });

  it("reports the source element id, undoing the part suffix rule", () => {
    expect(describeBuilding(TOWER, { hero: false, dilationM: 0 }).osmId).toBe("w1");
    expect(describeBuilding(SHED, { hero: false, dilationM: 0 }).osmId).toBe("w2");
    expect(sourceOsmId(TOWER)).toBe("w1");
    expect(sourceOsmId(SHED)).toBe("w2");
  });
});

describe("an unnamed object", () => {
  it("shows its kind and its dimensions instead of an empty card", () => {
    const info = describeBuilding(SHED, { hero: false, dilationM: 0 });
    expect(info.named).toBe(false);
    // `building=yes` says only "a building", so that is what it says.
    expect(info.title).toBe("Building");
    expect(facts(info.rows)).toEqual({
      Height: "8 m",
      Source: "Estimated from the building type",
      Footprint: "16 m²",
      Repair: "Prints as measured",
    });
  });

  it("names an unnamed road by its own tag, not by its printing class", () => {
    const info = describeRoad(FOOTWAY, 0);
    expect(info.named).toBe(false);
    // `class` is "path"; the tag is `highway=footway`, and that is the honest word.
    expect(info.title).toBe("Footway");
    expect(facts(info.rows).Width).toBe("3 m");
    expect(facts(info.rows).Length).toBe("40 m");
  });

  it("names an unnamed area by its landuse or leisure tag", () => {
    expect(describeArea(POND, "water", 0).title).toBe("Water");
    expect(describeArea({ ...POND, kind: undefined }, "water", 0).title).toBe("Water");
    expect(describeArea({ ...POND, kind: undefined }, "green", 0).title).toBe("Green space");
    expect(describeArea({ ...POND, kind: "landuse=recreation_ground" }, "green", 0).title).toBe(
      "Recreation ground",
    );
  });
});

describe("a road", () => {
  it("leads with the street name and adds the noun to an adjective type", () => {
    const info = describeRoad(AVENUE, 0);
    expect(info.title).toBe("South State Street");
    expect(info.typeLabel).toBe("Primary road");
    expect(info.method).toBe("nearest");
    expect(facts(info.rows)).toEqual({
      Width: "16 m",
      Length: "100 m",
      Footprint: "1,600 m²",
      Match: "On the centreline",
    });
  });

  it("says how far off the centreline the match was", () => {
    expect(facts(describeRoad(AVENUE, 3.4).rows).Match).toBe("Nearest centreline, 3.4 m away");
  });

  it("recovers the omitted highway tag from the class", () => {
    expect(roadKind(AVENUE)).toBe("highway=primary");
    expect(roadKind(FOOTWAY)).toBe("highway=footway");
  });
});

describe("water and green", () => {
  it("leads with the name and states the area", () => {
    const info = describeArea(PARK, "green", 0);
    expect(info.title).toBe("Grant Park");
    expect(info.typeLabel).toBe("Park");
    expect(info.osmId).toBe("r99");
    expect(facts(info.rows)).toEqual({ Area: "3,600 m²", Match: "Inside the outline" });
  });

  it("says when the hit was outside the outline", () => {
    expect(facts(describeArea(PARK, "green", 1.2).rows).Match).toBe("Nearest outline, 1.2 m away");
  });
});

describe("a merged block", () => {
  it("says so rather than naming a building that does not exist", () => {
    const info = describeMergedBlock("block-3");
    expect(info.title).toBe("Merged block");
    expect(info.osmId).toBeNull();
    expect(facts(info.rows).Repair).toContain("minimum gap");
  });
});

// ===========================================================================
// 2. building picking is exact
// ===========================================================================

function meshWithOwners(owners: string[], triangleOwner: number[]): RegionMesh {
  return {
    region: "buildings",
    positions: new Float64Array(0),
    indices: new Uint32Array(0),
    volumeMm3: 0,
    bbox: { min: [0, 0, 0], max: [0, 0, 0] },
    bodies: 1,
    slot: 2,
    colorHex: "#D8D3C6",
    owners,
    triangleOwner: new Uint32Array(triangleOwner),
  };
}

describe("ownerAt", () => {
  const mesh = meshWithOwners(["w1", "w2-1"], [1, 0, NO_OWNER]);

  it("maps a triangle to its building with no tolerance", () => {
    expect(ownerAt(mesh, 0)).toBe("w2-1");
    expect(ownerAt(mesh, 1)).toBe("w1");
  });

  it("returns null for a triangle nothing could be attributed to", () => {
    expect(ownerAt(mesh, 2)).toBeNull();
  });

  it("returns null off the end, on a fractional index and on a mesh with no identity", () => {
    expect(ownerAt(mesh, 3)).toBeNull();
    expect(ownerAt(mesh, -1)).toBeNull();
    expect(ownerAt(mesh, 1.5)).toBeNull();
    const plain: RegionMesh = { ...mesh, owners: undefined, triangleOwner: undefined };
    expect(ownerAt(plain, 0)).toBeNull();
  });
});

describe("objectAt", () => {
  const graph: EngineSceneGraph = {
    ...scene,
    buildings: [TOWER, SHED],
    roads: [AVENUE, FOOTWAY],
    water: [POND],
    green: [PARK],
  };
  const context = { scaleMmPerM: 0.1, heroIds: NO_HEROES, dilationById: NO_DILATION };

  it("resolves a buildings hit through the triangle owners", () => {
    const mesh = meshWithOwners(["w1"], [0]);
    const info = objectAt(graph, { region: "buildings", mesh, faceIndex: 0, xMm: 0, yMm: 0 }, context);
    expect(info?.key).toBe("building:w1");
    expect(info?.method).toBe("triangle-owner");
  });

  it("resolves a gradient band and the hero mesh the same way", () => {
    const mesh = meshWithOwners(["w2-1"], [0]);
    for (const region of ["buildings_band_3", "hero_building"]) {
      const info = objectAt(graph, { region, mesh, faceIndex: 0, xMm: 0, yMm: 0 }, context);
      expect(info?.key, region).toBe("building:w2-1");
    }
  });

  it("answers a merged block for an owner with no SceneGraph building", () => {
    const mesh = meshWithOwners(["block-2"], [0]);
    const info = objectAt(graph, { region: "buildings", mesh, faceIndex: 0, xMm: 0, yMm: 0 }, context);
    expect(info?.title).toBe("Merged block");
  });

  it("converts a roads hit back to scene metres before looking it up", () => {
    const mesh = meshWithOwners([], []);
    // 5 m along the avenue at 0.1 mm per metre is 0.5 mm on the plate.
    const info = objectAt(graph, { region: "roads", mesh, faceIndex: 0, xMm: 0.5, yMm: 0 }, context);
    expect(info?.key).toBe("road:w10");
  });

  it("answers water and green from their own layers", () => {
    const mesh = meshWithOwners([], []);
    expect(
      objectAt(graph, { region: "water", mesh, faceIndex: 0, xMm: 0.5, yMm: 0.5 }, context)?.layer,
    ).toBe("water");
    expect(
      objectAt(graph, { region: "parks", mesh, faceIndex: 0, xMm: 4, yMm: 4 }, context)?.layer,
    ).toBe("green");
  });

  it("answers nothing for a region that is not an OSM object", () => {
    const mesh = meshWithOwners([], []);
    for (const region of ["base", "frame", "matting", "lettering", "rail", "easel"]) {
      expect(
        objectAt(graph, { region, mesh, faceIndex: 0, xMm: 0, yMm: 0 }, context),
        region,
      ).toBeNull();
      expect(isPickableRegion(region), region).toBe(false);
    }
    for (const region of ["buildings", "hero_building", "buildings_band_2", "roads", "water", "parks"]) {
      expect(isPickableRegion(region), region).toBe(true);
    }
  });
});

// ===========================================================================
// 3. nearest-entity picking, measured on the real scene
// ===========================================================================

describe("nearest-entity picking on the Chicago fixture", () => {
  it("rejects a point that is on no road at all", () => {
    // The middle of Lake Michigan's corner of the crop, 900 m out.
    expect(nearestRoad(scene.roads, 100_000, 100_000)).toBeNull();
  });

  /** The longest segment of a road, and the unit normal to it. */
  function sample(road: Road): { x: number; y: number; nx: number; ny: number } {
    let best = 1;
    let bestLength = -1;
    for (let i = 1; i < road.path.length; i++) {
      const length = Math.hypot(
        road.path[i][0] - road.path[i - 1][0],
        road.path[i][1] - road.path[i - 1][1],
      );
      if (length > bestLength) {
        bestLength = length;
        best = i;
      }
    }
    const dx = road.path[best][0] - road.path[best - 1][0];
    const dy = road.path[best][1] - road.path[best - 1][1];
    const len = Math.hypot(dx, dy) || 1;
    return {
      x: (road.path[best][0] + road.path[best - 1][0]) / 2,
      y: (road.path[best][1] + road.path[best - 1][1]) / 2,
      nx: -dy / len,
      ny: dx / len,
    };
  }

  const samples = scene.roads.filter((road) => road.path.length >= 2);

  /**
   * The best case: a hit exactly on a centreline is the road it is on.
   *
   * 5 438 of 5 439 on this fixture. The one miss is a segment lying under a
   * wider road drawn over the top of it.
   */
  it("names the right road for a point on its own centreline", () => {
    let hits = 0;
    for (const road of samples) {
      const { x, y } = sample(road);
      if (nearestRoad(scene.roads, x, y)?.road.id === road.id) hits += 1;
    }
    expect(samples.length).toBeGreaterThan(1000);
    expect(hits / samples.length).toBeGreaterThan(0.999);
  });

  /**
   * The worst case, and the accuracy statement the handoff note reports.
   *
   * A real hover lands anywhere on the printed ribbon, so this samples its
   * OUTER EDGE. There, 47.9 % of the sample points lie inside more than one
   * road's ribbon: the roads region is a union and carries no per-triangle
   * identity, so for those points there is no single right answer to give. What
   * can be asked of the lookup is that it always names a road the point really
   * is on, and it does so 99.1 % of the time; it names the way the surface was
   * extruded from 59.1 % of the time, and a road of the same printing class
   * 80.4 %.
   */
  it("always names a road the hit is really on, even at the edge of the ribbon", () => {
    let covered = 0;
    let exact = 0;
    let ambiguous = 0;
    for (const road of samples) {
      const { x, y, nx, ny } = sample(road);
      const ex = x + nx * (road.width_m / 2) * 0.9;
      const ey = y + ny * (road.width_m / 2) * 0.9;
      const found = nearestRoad(scene.roads, ex, ey);
      if (found === null) continue;
      if (found.distanceM <= found.road.width_m / 2) covered += 1;
      if (found.road.id === road.id) exact += 1;
      let covering = 0;
      for (const other of samples) {
        if (distanceToPath([ex, ey], other.path) <= other.width_m / 2) covering += 1;
      }
      if (covering > 1) ambiguous += 1;
    }
    expect(covered / samples.length).toBeGreaterThan(0.98);
    expect(exact / samples.length).toBeGreaterThan(0.55);
    // Not vacuous: the ambiguity the exact rate is limited BY is real and large.
    expect(ambiguous / samples.length).toBeGreaterThan(0.4);
  });

  it("names the right polygon for a point inside it", () => {
    let hits = 0;
    let total = 0;
    for (const layer of [scene.water, scene.green]) {
      for (const feature of layer) {
        // A vertex pulled a little towards the polygon's own centroid is inside
        // it for any simple ring, convex or not, as long as the step is small.
        let cx = 0;
        let cy = 0;
        for (const [x, y] of feature.ring) {
          cx += x;
          cy += y;
        }
        cx /= feature.ring.length;
        cy /= feature.ring.length;
        const [vx, vy] = feature.ring[0];
        const x = vx + (cx - vx) * 0.01;
        const y = vy + (cy - vy) * 0.01;
        total += 1;
        if (areaAt(layer, x, y)?.feature === feature) hits += 1;
      }
    }
    expect(total).toBeGreaterThan(100);
    expect(hits / total).toBeGreaterThan(0.9);
  });
});

// ===========================================================================
// 4. the counted warning
// ===========================================================================

describe("nameBudgetWarning", () => {
  it("says nothing for a scene inside the budget", () => {
    expect(nameBudgetWarning(scene)).toEqual([]);
    expect(nameBudgetWarning(null)).toEqual([]);
  });

  it("counts what was dropped and says why, at info level", () => {
    const truncated = { ...scene, stats: { ...scene.stats, names_dropped: 1234 } };
    const [warning] = nameBudgetWarning(truncated);
    expect(warning.id).toBe("names-over-budget");
    expect(warning.level).toBe("info");
    expect(warning.message).toContain("1,234 OpenStreetMap names");
    expect(warning.message).toContain("transfer budget");
  });

  it("agrees with itself grammatically when exactly one name was dropped", () => {
    const truncated = { ...scene, stats: { ...scene.stats, names_dropped: 1 } };
    expect(nameBudgetWarning(truncated)[0].message).toContain("1 OpenStreetMap name was left out");
  });
});
