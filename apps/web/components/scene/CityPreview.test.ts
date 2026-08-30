/**
 * Preview memo keys.
 *
 * 02: "rebuild only the affected instance buffer when a slider moves". The
 * regression this file guards: keying a layer on `params` (or on the
 * `Thresholds` object derived from it) rebuilds it on EVERY PrintParams write,
 * because `store.setParam` re-creates `params` by spread. Moving the height
 * sliders then re-ran earcut over every water/green polygon (711 of them on
 * the 900 m Chicago crop), allocated a fresh BufferGeometry, disposed the old
 * one and re-uploaded it to the GPU on every tick of a drag.
 *
 * The dependency lists tested here are the exact arrays `CityPreview` passes
 * to `useMemo`, replayed through `render()` below, which reproduces React's
 * rule (recompute iff any dep fails `Object.is`).
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_PRINT_PARAMS } from "@/lib/contracts";
import type { PrintParams, SceneGraph } from "@/lib/contracts";
import { previewDeps } from "./CityPreview";

const GRAPH: SceneGraph = {
  bounds: { min_x: -900, min_y: -900, max_x: 900, max_y: 900 },
  center: { lat: 41.8827, lon: -87.6233 },
  buildings: [],
  roads: [],
  water: [],
  green: [],
  trees: [],
  stats: { building_count: 0, coverage: "empty", height_tag_ratio: 0 },
};

type DepList = unknown[];

/** All eight memo keys for one (graph, scale, params) render. */
function allDeps(
  graph: SceneGraph | null,
  scale: number | null,
  params: PrintParams,
): Record<string, DepList> {
  return {
    scale: previewDeps.scale(graph, params),
    thresholds: previewDeps.thresholds(scale, params),
    layout: previewDeps.layout(graph, params),
    roads: previewDeps.roads(graph, params),
    water: previewDeps.water(graph, scale, params),
    green: previewDeps.green(graph, scale, params),
    trees: previewDeps.trees(graph, params),
    height: previewDeps.height(graph, params),
  };
}

/** React's own rule: a memo recomputes iff any dep fails `Object.is`. */
function changed(before: DepList, after: DepList): boolean {
  if (before.length !== after.length) return true;
  return before.some((value, i) => !Object.is(value, after[i]));
}

/** Which layers a single `setParam` write would rebuild. */
function rebuiltBy<K extends keyof PrintParams>(
  key: K,
  value: PrintParams[K],
): string[] {
  const params = { ...DEFAULT_PRINT_PARAMS };
  // The scale is a number, so it is identity-stable whenever its own deps are.
  const scaleOf = (p: PrintParams): number =>
    (p.plate_mm - (p.frame ? 12 : 0)) / 1800;
  const before = allDeps(GRAPH, scaleOf(params), params);
  // Exactly what `store.setParam` does: a fresh object every write.
  const next: PrintParams = { ...params, [key]: value };
  const after = allDeps(GRAPH, scaleOf(next), next);
  return Object.keys(before).filter((name) => changed(before[name], after[name]));
}

describe("previewDeps", () => {
  it("never puts the params object (or anything derived from it) in a key", () => {
    const params = { ...DEFAULT_PRINT_PARAMS };
    const deps = allDeps(GRAPH, 0.1, params);
    for (const [name, list] of Object.entries(deps)) {
      for (const value of list) {
        if (value === GRAPH) continue;
        expect(
          value === null || typeof value !== "object",
          `${name} dep must be a primitive or the graph, got ${typeof value}`,
        ).toBe(true);
        expect(value).not.toBe(params);
      }
    }
  });

  /**
   * `height` is not a geometry layer: it is one pass over `buildings[].height_m`
   * (`transform.predicted_top_mm`) feeding the 60 mm guard and the HUD readout,
   * with no hulls, no earcut and no GPU upload. It is the one memo a height
   * slider is *supposed* to invalidate.
   */
  const GEOMETRY = (names: string[]): string[] =>
    names.filter((name) => name !== "height").sort();

  it("rebuilds no geometry when a height slider moves", () => {
    expect(GEOMETRY(rebuiltBy("small_scale", 1.5))).toEqual([]);
    expect(GEOMETRY(rebuiltBy("large_scale", 2.0))).toEqual([]);
    expect(GEOMETRY(rebuiltBy("base_thickness_mm", 8))).toEqual([]);
    expect(GEOMETRY(rebuiltBy("terrain_exaggeration", 3.0))).toEqual([]);
    // ... but the predicted model top must follow them, or the Bake button
    // would stay enabled past 04's 60 mm ceiling.
    expect(rebuiltBy("small_scale", 1.5)).toEqual(["height"]);
    expect(rebuiltBy("large_scale", 2.0)).toEqual(["height"]);
    expect(rebuiltBy("base_thickness_mm", 8)).toEqual(["height"]);
    expect(rebuiltBy("terrain_exaggeration", 3.0)).toEqual([]);
  });

  it("still rebuilds the layers a parameter really changes", () => {
    // Not vacuous: the nozzle moves every threshold, so everything that reads
    // one has to come back -- including the trees, whose printed-radius floor
    // is nozzle-aware (DECISIONS [P5-web]).
    expect(rebuiltBy("nozzle_mm", 0.6).sort()).toEqual(
      ["green", "layout", "roads", "thresholds", "trees", "water"].sort(),
    );
    // The plate and the frame move the scale, hence every metric layer.
    expect(rebuiltBy("plate_mm", 256).sort()).toEqual(
      [
        "green",
        "height",
        "layout",
        "roads",
        "scale",
        "thresholds",
        "trees",
        "water",
      ].sort(),
    );
    expect(rebuiltBy("frame", false).sort()).toEqual(
      [
        "green",
        "height",
        "layout",
        "roads",
        "scale",
        "thresholds",
        "trees",
        "water",
      ].sort(),
    );
    expect(rebuiltBy("road_scale", 2.0)).toEqual(["roads"]);
    expect(rebuiltBy("road_mode", "emboss")).toEqual(["roads"]);
    expect(rebuiltBy("trees", false).sort()).toEqual(["height", "trees"]);
    // Green has no toggle on the frozen PrintParams (DECISIONS [P4]).
    expect(rebuiltBy("water", false)).toEqual(["water"]);
  });

  it("covers every key of the frozen PrintParams contract", () => {
    const covered = new Set([
      "plate_mm",
      "base_thickness_mm",
      "nozzle_mm",
      "small_scale",
      "large_scale",
      "terrain_exaggeration",
      "road_mode",
      "road_scale",
      "trees",
      "water",
      "frame",
    ]);
    expect([...covered].sort()).toEqual(Object.keys(DEFAULT_PRINT_PARAMS).sort());
  });

  it("rebuilds everything when a new SceneGraph arrives", () => {
    const params = { ...DEFAULT_PRINT_PARAMS };
    const before = allDeps(GRAPH, 0.1, params);
    const after = allDeps({ ...GRAPH }, 0.1, params);
    const rebuilt = Object.keys(before).filter((n) => changed(before[n], after[n]));
    expect(rebuilt.sort()).toEqual(
      ["green", "height", "layout", "roads", "scale", "trees", "water"].sort(),
    );
  });
});
