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

import type { SceneGraph } from "../../contracts";
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

/** The block on a hillside: the scene plus the heightfield that drapes it. */
export function terrainScene(): { scene: SceneGraph; grid: TerrainGrid } {
  return { scene: blockScene(), grid: hillGrid(TEST_RADIUS_M, 30) };
}

export type TestSceneName = "block" | "rail" | "bridge" | "terrain";

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
    default: {
      const never: never = name;
      throw new Error(`unknown test scene ${String(never)}`);
    }
  }
}
