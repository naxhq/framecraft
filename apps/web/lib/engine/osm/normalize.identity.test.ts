/**
 * The schema_version 4 identity the ingest carries, and what it costs.
 *
 * Two halves, and the second is the point of the first.
 *
 * **The fields are right.** `name`, `osm_id` and `kind` come off the OSM tags
 * that classified each entity, survive the dedupe, the union and the dissolve
 * that merge entities on the way through, and follow the two sparse-encoding
 * rules the contract states: `osm_id` is written only where `id` is not already
 * the source id, and `Road.kind` only where it is not already `highway=<class>`.
 *
 * **The payload is bounded.** The Chicago Loop fixture is measured here, before
 * and after, and the name budget is asserted against the number that measurement
 * produces, so the constant in `normalize.ts` is a fact this suite re-checks
 * rather than a claim in a comment. A regression that doubles the identity block
 * fails here, not in a user's transfer time.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { SceneRequest } from "../../contracts";
import {
  SCENE_NAME_BUDGET_BYTES,
  applyNameBudget,
  dissolveRingsGrouped,
  nameFieldBytes,
  sceneFromOverpass,
  type OverpassResponse,
} from "./normalize";
import type { EngineSceneGraph } from "./types";

const FIXTURES_DIR = fileURLToPath(new URL("../../../../../", import.meta.url));
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

const utf8 = new TextEncoder();

/** The bytes one set of keys costs in the serialised scene, keys and separators included. */
function keyBytes(value: unknown, keys: readonly string[]): number {
  let total = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, inner] of Object.entries(node as Record<string, unknown>)) {
      if (keys.includes(key) && inner !== undefined) {
        total += utf8.encode(JSON.stringify(key)).length + 1;
        total += utf8.encode(JSON.stringify(inner)).length + 1;
      }
      walk(inner);
    }
  };
  walk(value);
  return total;
}

const sceneBytes = utf8.encode(JSON.stringify(scene)).length;

describe("schema_version 4 identity on the Chicago fixture", () => {
  it("names buildings, roads, water and green from their OSM name tags", () => {
    // Not vacuous: every layer really does carry names in this fixture.
    expect(scene.buildings.filter((b) => b.name !== undefined).length).toBeGreaterThan(300);
    expect(scene.roads.filter((r) => r.name !== undefined).length).toBeGreaterThan(500);
    expect(scene.water.filter((w) => w.name !== undefined).length).toBeGreaterThan(0);
    expect(scene.green.filter((g) => g.name !== undefined).length).toBeGreaterThan(0);
    // A recognisable one, so this is a test of the ingest and not of a counter.
    expect(scene.roads.some((r) => r.name === "West Adams Street")).toBe(true);
  });

  it("classifies every entity with the tag that put it in its layer", () => {
    for (const building of scene.buildings) {
      if (building.kind !== undefined) expect(building.kind).toMatch(/^building=/);
    }
    for (const road of scene.roads) {
      if (road.kind !== undefined) expect(road.kind).toMatch(/^highway=/);
    }
    for (const water of scene.water) {
      if (water.kind !== undefined) expect(water.kind).toMatch(/^(natural|waterway)=/);
    }
    for (const green of scene.green) {
      if (green.kind !== undefined) expect(green.kind).toMatch(/^(landuse|leisure)=/);
    }
    // Buildings always carry one: `building=*` is what made them buildings.
    expect(scene.buildings.every((b) => b.kind !== undefined)).toBe(true);
    expect(new Set(scene.buildings.map((b) => b.kind)).size).toBeGreaterThan(3);
  });

  it("writes osm_id only where `id` is not already the source id", () => {
    let split = 0;
    for (const entity of [...scene.buildings, ...scene.roads]) {
      if (entity.osm_id === undefined) {
        // The rule the contract states: absent means `id` IS the source id, so
        // it must look like one and carry no part suffix.
        expect(entity.id).toMatch(/^[wrx]\d+$/);
        continue;
      }
      split += 1;
      expect(entity.id).toMatch(/^[wrx]\d+-\d+$/);
      expect(entity.id.startsWith(`${entity.osm_id}-`)).toBe(true);
    }
    // Not vacuous: the crop really does split elements on this fixture.
    expect(split).toBeGreaterThan(0);
  });

  it("writes Road.kind only where it says something `class` does not", () => {
    let redundant = 0;
    for (const road of scene.roads) {
      if (road.kind === undefined) continue;
      if (road.kind === `highway=${road.class}`) redundant += 1;
    }
    expect(redundant).toBe(0);
    // ...and the omitted ones are recoverable, which is what makes the rule
    // lossless: every road still resolves to a highway tag.
    expect(
      scene.roads.every((road) => (road.kind ?? `highway=${road.class}`).startsWith("highway=")),
    ).toBe(true);
  });

  it("gives every water and green polygon a source element", () => {
    for (const feature of [...scene.water, ...scene.green]) {
      expect(feature.osm_id).toMatch(/^[wrx]\d+$/);
    }
  });
});

describe("the payload cost, measured", () => {
  /**
   * The numbers `docs/handoff/v3-10-objects.md` reports, re-derived here.
   *
   * Chicago at 900 m was 1 229.7 kB of SceneGraph JSON before Task 10 and is
   * 1 423.7 kB after. The bound below is deliberately loose (1 600 kB): its job
   * is to catch a change that adds another hundred kilobytes per entity, not to
   * break every time a fixture refresh moves a road.
   */
  it("keeps the whole SceneGraph inside the transfer budget", () => {
    expect(sceneBytes).toBeGreaterThan(1_000_000);
    expect(sceneBytes).toBeLessThan(1_600_000);
  });

  it("spends less than half the name budget on a scene of this density", () => {
    const nameBytes = keyBytes(scene, ["name"]);
    // The headroom the constant was chosen for: a scene up to twice as dense as
    // Chicago keeps every one of its names.
    expect(nameBytes).toBeGreaterThan(20_000);
    expect(nameBytes * 2).toBeLessThanOrEqual(SCENE_NAME_BUDGET_BYTES);
    expect(scene.stats.names_dropped).toBeUndefined();
  });

  it("keeps the identity block a minority of the payload", () => {
    const identityBytes = keyBytes(scene, ["name", "osm_id", "kind"]);
    expect(identityBytes).toBeLessThan(sceneBytes * 0.2);
  });
});

describe("applyNameBudget", () => {
  const entity = (name: string) => ({ name } as { name?: string });

  it("drops nothing while the scene fits", () => {
    const small = entity("Small");
    const big = entity("Big");
    const dropped = applyNameBudget(
      [
        { entity: small, areaM2: 1 },
        { entity: big, areaM2: 100 },
      ],
      SCENE_NAME_BUDGET_BYTES,
    );
    expect(dropped).toBe(0);
    expect(small.name).toBe("Small");
    expect(big.name).toBe("Big");
  });

  it("keeps the largest footprints and drops the rest, counted", () => {
    const tower = entity("Tower");
    const shed = entity("Shed");
    const hut = entity("Hut");
    // Room for exactly one name.
    const budget = nameFieldBytes("Tower");
    const dropped = applyNameBudget(
      [
        { entity: shed, areaM2: 20 },
        { entity: tower, areaM2: 900 },
        { entity: hut, areaM2: 5 },
      ],
      budget,
    );
    expect(dropped).toBe(2);
    expect(tower.name).toBe("Tower");
    expect(shed.name).toBeUndefined();
    expect(hut.name).toBeUndefined();
  });

  it("does not let one unaffordable name cost a smaller one that still fits", () => {
    const huge = entity("x".repeat(100));
    const small = entity("Park");
    // Enough for the small name but not the huge one, which ranks first.
    const budget = nameFieldBytes("Park") + 4;
    const dropped = applyNameBudget(
      [
        { entity: huge, areaM2: 1000 },
        { entity: small, areaM2: 1 },
      ],
      budget,
    );
    expect(dropped).toBe(1);
    expect(huge.name).toBeUndefined();
    expect(small.name).toBe("Park");
  });

  it("counts the bytes a name really costs on the wire", () => {
    // `,"name":"Park"` is 8 + 6.
    expect(nameFieldBytes("Park")).toBe(8 + 6);
    // A multi-byte character is counted as its bytes, not its length.
    expect(nameFieldBytes("Café")).toBe(8 + 7);
  });
});

describe("dissolveRingsGrouped", () => {
  it("reports which input rings made each dissolved polygon", () => {
    const square = (x: number): [number, number][] => [
      [x, 0],
      [x + 10, 0],
      [x + 10, 10],
      [x, 10],
    ];
    // Two that touch along an edge, one far away.
    const groups = dissolveRingsGrouped([square(0), square(10), square(100)]);
    expect(groups.length).toBe(2);
    const merged = groups.find((group) => group.members.length === 2);
    expect(merged?.members).toEqual([0, 1]);
    expect(groups.find((group) => group.members.length === 1)?.members).toEqual([2]);
  });

  it("indexes members against the rings passed in, not the ones it kept", () => {
    const square: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    // A degenerate ring is dropped, and the survivor must still name index 1.
    const groups = dissolveRingsGrouped([[[0, 0]] as unknown as [number, number][], square]);
    expect(groups.length).toBe(1);
    expect(groups[0].members).toEqual([1]);
  });
});
