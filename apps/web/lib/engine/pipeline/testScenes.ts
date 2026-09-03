/**
 * Small synthetic scenes for the pipeline tests and the matrix test.
 *
 * Built from `solid/fixture.ts`'s helpers, each a few hundred milliseconds to
 * build, each exercising one more stage family than the last: a plain block
 * (buildings, a road, water, a park, trees), the same with a rail line, the
 * same with a bridge over the water, and the block on a hillside. Not test
 * files themselves: a `.test.ts` imports them, and so does the claim-discovery
 * script that keeps the registry honest.
 */

import type { Point, SceneGraph } from "../../contracts";
import { area, building, hillGrid, road, scene, square, type RailPart } from "../solid/fixture";
import type { TerrainGrid } from "../types";

/** Radius of every synthetic scene, metres: 0.42 mm per ground metre on a 180 mm plate. */
export const TEST_RADIUS_M = 200;

/**
 * A city block: three buildings (one tall, one with a courtyard), one road, a
 * pond west of it, a park east of it with three trees on it.
 */
export function blockScene(): SceneGraph {
  return scene({
    radiusM: TEST_RADIUS_M,
    buildings: [
      building("b-low", square(-60, 40, 36), 18),
      building("b-tall", square(40, 50, 44), 72),
      building("b-court", square(-40, -70, 60), 30, [[...square(-40, -70, 20)].reverse()]),
    ],
    roads: [road("r-main", [[-180, 0], [180, 0]], 14)],
    water: [area(square(-120, -110, 60))],
    green: [area(square(110, -90, 90))],
    trees: [
      { x: 95, y: -80, radius_m: 6 },
      { x: 120, y: -105, radius_m: 7 },
      { x: 135, y: -70, radius_m: 5 },
    ],
  });
}

/** The block with a rail line running north to south east of the tall building. */
export function railScene(): SceneGraph {
  const base = blockScene();
  const rail: RailPart[] = [{ id: "rail-1", path: [[90, -180], [90, 180]], width_m: 6 }];
  return { ...base, rail } as SceneGraph;
}

/** The block with a second road carried over the pond as a bridge. */
export function bridgeScene(): SceneGraph {
  const base = blockScene();
  return {
    ...base,
    roads: [...base.roads, road("r-bridge", [[-180, -110], [-40, -110]], 12, { bridge: true })],
  };
}

/**
 * The block with an OSM id on its pond and its park (v3.1 Task 11).
 *
 * An `object_overrides` row is keyed by the BASE OSM element id, and an
 * `AreaFeature` carries no `id` at all: its `osm_id` is the only identity it
 * has, and a dissolved polygon the ingest could not attribute has none, which
 * is a polygon no override can name. The plain `blockScene` is that second
 * case, so the override probes need a scene that is the first.
 *
 * Byte-identical to `blockScene()` apart from those two strings, which are
 * SceneGraph identity and move no geometry.
 */
export function overrideScene(): SceneGraph {
  const base = blockScene();
  return {
    ...base,
    water: [area(square(-120, -110, 60), [], "w-pond")],
    green: [area(square(110, -90, 90), [], "w-park")],
  };
}

/** The block on a hillside: the scene plus the heightfield that drapes it. */
export function terrainScene(): { scene: SceneGraph; grid: TerrainGrid } {
  return { scene: blockScene(), grid: hillGrid(TEST_RADIUS_M, 30) };
}

/**
 * The block with names on its buildings and a wide bend to the north, for the
 * surface-label probes (Task 12): a label needs a NAMED target, and `follow`
 * needs a road that actually turns.
 */
export function labelledScene(): SceneGraph {
  const base = blockScene();
  const bend: Point[] = [];
  for (let deg = 0; deg <= 90; deg += 6) {
    const t = (deg * Math.PI) / 180;
    bend.push([-60 + 100 * Math.sin(t), 100 + 100 * (1 - Math.cos(t))]);
  }
  return {
    ...base,
    buildings: base.buildings.map((entry) =>
      entry.id === "b-tall" ? { ...entry, name: "Tower" } : entry.id === "b-low" ? { ...entry, name: "Low Hall" } : entry,
    ),
    roads: [...base.roads, { ...road("r-bend", bend, 20), name: "Bend Road" }],
  };
}

export type TestSceneName = "block" | "rail" | "bridge" | "terrain" | "labelled";

/** Every synthetic scene by name, for a probe table. */
export function testScene(name: TestSceneName): { scene: SceneGraph; grid: TerrainGrid | null } {
  switch (name) {
    case "block":
      return { scene: blockScene(), grid: null };
    case "rail":
      return { scene: railScene(), grid: null };
    case "bridge":
      return { scene: bridgeScene(), grid: null };
    case "terrain": {
      const built = terrainScene();
      return { scene: built.scene, grid: built.grid };
    }
    case "labelled":
      return { scene: labelledScene(), grid: null };
    default: {
      const never: never = name;
      throw new Error(`unknown test scene ${String(never)}`);
    }
  }
}
