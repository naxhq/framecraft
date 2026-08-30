/**
 * Water/green triangulation.
 *
 * The regression this file exists for: `ShapeUtils.triangulateShape` pops the
 * duplicated closing point off every contour IN PLACE and then numbers the
 * hole vertices off the shortened outline, so the vertex array the face
 * indices refer to has to be concatenated AFTER the call. Building it before
 * shifts every hole index by one per preceding contour, which fills the island
 * in and inflates the surface -- exactly the preview/bake divergence 01 calls
 * the worst failure mode. `fixtures/chicago-scene.json` already ships water and
 * green polygons with holes, so this is reachable on real data.
 */

import { describe, expect, it } from "vitest";

import type { PreviewArea } from "@/lib/preview";
import { areaTrianglePositions } from "./AreaSurfaces";

/** A 100x100 mm square with a 20x20 mm island cut out of the middle. */
const SQUARE_WITH_ISLAND: PreviewArea = {
  outer: [0, 0, 100, 0, 100, 100, 0, 100],
  holes: [[40, 40, 40, 60, 60, 60, 60, 40]],
};

interface Tri {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  cx: number;
  cy: number;
}

function triangles(positions: number[]): Tri[] {
  const out: Tri[] = [];
  for (let i = 0; i < positions.length; i += 9) {
    out.push({
      ax: positions[i],
      ay: positions[i + 1],
      bx: positions[i + 3],
      by: positions[i + 4],
      cx: positions[i + 6],
      cy: positions[i + 7],
    });
  }
  return out;
}

function area(t: Tri): number {
  return Math.abs((t.bx - t.ax) * (t.cy - t.ay) - (t.cx - t.ax) * (t.by - t.ay)) / 2;
}

function contains(t: Tri, x: number, y: number): boolean {
  const d1 = (x - t.bx) * (t.ay - t.by) - (t.ax - t.bx) * (y - t.by);
  const d2 = (x - t.cx) * (t.by - t.cy) - (t.bx - t.cx) * (y - t.cy);
  const d3 = (x - t.ax) * (t.cy - t.ay) - (t.cx - t.ax) * (y - t.ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

describe("areaTrianglePositions", () => {
  it("emits whole triangles with z pinned to the layer plane", () => {
    const positions = areaTrianglePositions([SQUARE_WITH_ISLAND]);
    expect(positions.length % 9).toBe(0);
    expect(positions.length).toBeGreaterThan(0);
    for (let i = 2; i < positions.length; i += 3) {
      expect(positions[i]).toBe(0);
    }
  });

  it("cuts the hole out instead of painting over it", () => {
    const tris = triangles(areaTrianglePositions([SQUARE_WITH_ISLAND]));
    const total = tris.reduce((sum, t) => sum + area(t), 0);
    // 100*100 - 20*20. The pre-triangulation pairing produced 9800 here.
    expect(total).toBeCloseTo(100 * 100 - 20 * 20, 6);
    expect(tris.filter((t) => contains(t, 50, 50))).toHaveLength(0);
  });

  it("keeps the hole cut when several areas are merged into one buffer", () => {
    const offset: PreviewArea = {
      outer: SQUARE_WITH_ISLAND.outer.map((v, i) => (i % 2 === 0 ? v + 200 : v)),
      holes: SQUARE_WITH_ISLAND.holes.map((h) =>
        h.map((v, i) => (i % 2 === 0 ? v + 200 : v)),
      ),
    };
    const tris = triangles(areaTrianglePositions([SQUARE_WITH_ISLAND, offset]));
    const total = tris.reduce((sum, t) => sum + area(t), 0);
    expect(total).toBeCloseTo(2 * (100 * 100 - 20 * 20), 6);
    expect(tris.filter((t) => contains(t, 50, 50))).toHaveLength(0);
    expect(tris.filter((t) => contains(t, 250, 50))).toHaveLength(0);
  });

  it("handles two holes, where the index shift compounded", () => {
    const twoHoles: PreviewArea = {
      outer: [0, 0, 100, 0, 100, 100, 0, 100],
      holes: [
        [10, 10, 10, 30, 30, 30, 30, 10],
        [60, 60, 60, 90, 90, 90, 90, 60],
      ],
    };
    const tris = triangles(areaTrianglePositions([twoHoles]));
    const total = tris.reduce((sum, t) => sum + area(t), 0);
    expect(total).toBeCloseTo(100 * 100 - 20 * 20 - 30 * 30, 6);
    expect(tris.filter((t) => contains(t, 20, 20))).toHaveLength(0);
    expect(tris.filter((t) => contains(t, 75, 75))).toHaveLength(0);
  });

  it("triangulates a plain ring with no holes", () => {
    const tris = triangles(
      areaTrianglePositions([{ outer: [0, 0, 10, 0, 10, 10, 0, 10], holes: [] }]),
    );
    expect(tris.reduce((sum, t) => sum + area(t), 0)).toBeCloseTo(100, 6);
  });
});
