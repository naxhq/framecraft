/**
 * The building mesh's effect keys.
 *
 * `CityPreview`'s `previewDeps` covers the memos that build the geometry; this
 * covers the two EFFECTS below them, which that harness cannot see. The defect
 * it closes: the matrix effect was keyed on the whole `params` object, and
 * `store.setParam` rebuilds `params` by spread on every write — so picking a
 * hero (a colour-only change) re-ran `buildingInstanceMatrices` over all 994
 * Chicago instances and re-uploaded `instanceMatrix` as well as
 * `instanceColor`.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_PRINT_PARAMS, defaultPrintParams } from "@/lib/contracts";
import type { PrintParams } from "@/lib/contracts";
import type { PreviewBuilding } from "@/lib/preview";
import { matrixDeps } from "./InstancedBuildings";

const BUILDINGS: PreviewBuilding[] = [
  {
    id: "w1",
    cx_mm: 0,
    cy_mm: 0,
    angle_rad: 0,
    width_mm: 4,
    depth_mm: 4,
    height_m: 30,
    is_tall: false,
    dilation_m: 0,
    dilated: false,
  },
];

const SCALE = 0.0933;

/** React's own rule: an effect re-runs iff any dep fails `Object.is`. */
function reruns<K extends keyof PrintParams>(key: K, value: PrintParams[K]): boolean {
  const before = matrixDeps(BUILDINGS, SCALE, defaultPrintParams());
  const after = matrixDeps(BUILDINGS, SCALE, { ...defaultPrintParams(), [key]: value });
  return before.some((dep, i) => !Object.is(dep, after[i]));
}

describe("matrixDeps", () => {
  it("names only primitives and the identity-stable building list", () => {
    const deps = matrixDeps(BUILDINGS, SCALE, defaultPrintParams());
    for (const dep of deps) {
      if (dep === BUILDINGS) continue;
      expect(dep === null || typeof dep !== "object").toBe(true);
    }
    // Never the params object itself: that is the whole point.
    expect(deps).not.toContain(DEFAULT_PRINT_PARAMS);
  });

  it("re-uploads the matrices only when a hero's HEIGHT can move", () => {
    // A hero is now DRAWN at its hero height (`transform.building_top_mm_for`),
    // which is a geometry change and has to rewrite the buffer. Until it did,
    // a picked hero was coloured but not raised, and that was the one place the
    // preview knowingly disagreed with the build (`docs/handoff/v2-04-ui.md`
    // §11). The default `hero_mode` is `true_height`, so this pick moves it.
    expect(reruns("hero_building_ids", ["w1"])).toBe(true);
    // `hero_mode` alone moves nothing while no hero is picked...
    expect(reruns("hero_mode", "own_color")).toBe(false);
  });

  it("still gives a hero its own filament without re-uploading 994 matrices", () => {
    // ...and in `own_color` the hero keeps everyone else's height, so
    // `hero_height_ids` is empty and picking one is a colour-only change. This
    // is the original defect this file was written for, restated for the mode
    // where it still holds.
    const ownColour: PrintParams = { ...defaultPrintParams(), hero_mode: "own_color" };
    const before = matrixDeps(BUILDINGS, SCALE, ownColour);
    const after = matrixDeps(BUILDINGS, SCALE, {
      ...ownColour,
      hero_building_ids: ["w1"],
    });
    expect(before.some((dep, i) => !Object.is(dep, after[i]))).toBe(false);
  });

  it("ignores every other personalisation parameter too", () => {
    expect(reruns("city_label", "Chicago")).toBe(false);
    expect(reruns("color_mode", "parts")).toBe(false);
    expect(reruns("engravings", [{ edge: "bottom", text: "{city}" }])).toBe(false);
    expect(reruns("north_arrow", { enabled: true })).toBe(false);
    expect(reruns("scale_bar", { enabled: true })).toBe(false);
    expect(reruns("underside_mark", { enabled: true })).toBe(false);
    expect(reruns("hanger", "keyhole")).toBe(false);
    // ...and the ones that only move other layers.
    expect(reruns("road_mode", "emboss")).toBe(false);
    expect(reruns("water", false)).toBe(false);
    expect(reruns("trees", false)).toBe(false);
  });

  it("still re-runs for everything the matrices are actually built from", () => {
    // Not vacuous: these are the three parameters `buildingInstanceMatrices`
    // reads, through `base_top_mm` and `building_top_mm`.
    expect(reruns("base_thickness_mm", 8)).toBe(true);
    expect(reruns("small_scale", 1.5)).toBe(true);
    expect(reruns("large_scale", 2.0)).toBe(true);
    // ...and a new scale or a new layout, which arrive as their own arguments.
    const params = defaultPrintParams();
    expect(
      matrixDeps(BUILDINGS, SCALE, params).some(
        (dep, i) => !Object.is(dep, matrixDeps(BUILDINGS, 0.14, params)[i]),
      ),
    ).toBe(true);
    expect(
      matrixDeps(BUILDINGS, SCALE, params).some(
        (dep, i) => !Object.is(dep, matrixDeps([...BUILDINGS], SCALE, params)[i]),
      ),
    ).toBe(true);
  });
});
