/**
 * The viewport spec strip.
 *
 * Three numbers, three sources, none of them local arithmetic: the ratio comes
 * from the mirrored token table (so the HUD and an engraved `{scale}` can never
 * disagree by a digit), the height from the same function the server's 60 mm
 * guard calls, and the wall from `transform.min_wall_mm` -- whose look-alike,
 * `min_detail`, is exactly half of it and reads just as plausibly on screen
 * (DECISIONS [V2-P1]).
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_PRINT_PARAMS } from "./contracts";
import type { Building, PrintParams, SceneGraph } from "./contracts";
import { scaleRatio, specStrip } from "./hud";
import { format_scale } from "./tokens";
import * as T from "./transform";

function building(id: string, height_m: number, is_tall: boolean): Building {
  return {
    id,
    ring: [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
    ],
    holes: [],
    height_m,
    height_source: "tag",
    min_height_m: 0,
    is_tall,
  };
}

/** Chicago's shape: a 900 m radius crop, which is the [V2-P2] 1:10,714 case. */
function scene(buildings: Building[] = []): SceneGraph {
  return {
    bounds: { min_x: -900, min_y: -900, max_x: 900, max_y: 900 },
    center: { lat: 41.8827, lon: -87.6233 },
    buildings,
    roads: [],
    water: [],
    green: [],
    trees: [],
    stats: {
      building_count: buildings.length,
      coverage: "good",
      height_tag_ratio: 0.5,
    },
  };
}

const DEFAULTS: PrintParams = { ...DEFAULT_PRINT_PARAMS };

describe("scaleRatio", () => {
  it("is the documented Chicago default, 1:10,714", () => {
    // 180 mm plate, frame on -> 168 mm of usable plate over 1800 m of ground.
    expect(scaleRatio(scene(), DEFAULTS)).toBe("1:10,714");
  });

  it("is exactly what the token table would engrave", () => {
    const params: PrintParams = { ...DEFAULTS, plate_mm: 200 };
    const graph = scene();
    const expected = format_scale({
      lat: graph.center.lat,
      lon: graph.center.lon,
      scale_mm_per_m: T.scale_mm_per_m(params, 900),
      radius_m: 900,
      date: "",
      buildings: 0,
    });
    expect(scaleRatio(graph, params)).toBe(expected);
    expect(expected).toBe("1:9,574");
  });

  it("has nothing to say without a scene, or with a degenerate one", () => {
    expect(scaleRatio(null, DEFAULTS)).toBeNull();
    const degenerate = scene();
    degenerate.bounds = { min_x: 0, min_y: 0, max_x: 0, max_y: 0 };
    expect(scaleRatio(degenerate, DEFAULTS)).toBeNull();
  });
});

describe("specStrip", () => {
  it("is empty with no scene: there is nothing to measure yet", () => {
    expect(specStrip(null, DEFAULTS)).toEqual([]);
  });

  it("reads scale, height and wall, in that order", () => {
    const strip = specStrip(scene([building("w1", 100, true)]), DEFAULTS);
    expect(strip.map((item) => item.label)).toEqual(["Scale", "Height", "Min wall"]);
    expect(strip.map((item) => item.testId)).toEqual([
      "spec-scale",
      "spec-height",
      "spec-min-wall",
    ]);
    expect(strip[0].value).toBe("1:10,714");
    // 3 mm base + 100 m x 0.09333 mm/m.
    expect(strip[1].value).toBe("12.3 mm");
    expect(strip[2].value).toBe("0.80 mm");
  });

  it("shows the wall as two nozzles, never one", () => {
    const params: PrintParams = { ...DEFAULTS, nozzle_mm: 0.6 };
    const wall = specStrip(scene(), params).find((item) => item.label === "Min wall");
    expect(wall?.value).toBe("1.20 mm");
    // `min_detail_mm` is 0.60 mm here and would read just as plausibly.
    expect(wall?.value).not.toBe(`${T.min_detail_mm(params).toFixed(2)} mm`);
  });

  it("marks the height as dangerous past the 60 mm ceiling, and not before", () => {
    const safe = specStrip(scene([building("w1", 100, true)]), DEFAULTS);
    expect(safe.every((item) => item.tone === "normal")).toBe(true);

    const tall = specStrip(scene([building("w1", 700, true)]), DEFAULTS);
    const height = tall.find((item) => item.label === "Height");
    expect(height?.tone).toBe("danger");
    expect(Number.parseFloat(height?.value ?? "0")).toBeGreaterThanOrEqual(
      T.MAX_HEIGHT_MM,
    );
  });

  it("still reports the wall when the scale cannot be measured", () => {
    const degenerate = scene();
    degenerate.bounds = { min_x: 0, min_y: 0, max_x: 0, max_y: 0 };
    const strip = specStrip(degenerate, DEFAULTS);
    expect(strip.map((item) => item.label)).toEqual(["Min wall"]);
  });

  it("follows the height sliders", () => {
    const graph = scene([building("w1", 100, true)]);
    const doubled = specStrip(graph, { ...DEFAULTS, large_scale: 2.0 });
    expect(doubled[1].value).toBe("21.7 mm");
  });
});
