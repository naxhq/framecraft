/**
 * The quick body count (`bodiesFromMesh`) and the debris prune built on it.
 *
 * The count answers from the mesh alone, without a `decompose()`, whenever
 * every body is safely above the debris floor. Read off float32 vertices it
 * only trusts a body an order of magnitude above the floor; read off the
 * double vertices a finish already has (`readMesh`) it trusts the kernel's own
 * volumes to within summation noise, so a body between one and ten floors -
 * which the roads region carries - no longer sends the finish to the
 * decomposition.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  Arena,
  DEBRIS_MM3,
  bodiesFromMesh,
  loadManifold,
  outstandingWasmObjects,
  pruneDebrisCounted,
  readMesh,
  type Manifold,
  type ManifoldToplevel,
} from "./manifold";

let wasm: ManifoldToplevel;

beforeAll(async () => {
  wasm = await loadManifold();
});

afterEach(() => {
  expect(outstandingWasmObjects()).toBe(0);
});

/** A big cube and a small one side by side, at a plate-sized offset so the coordinates are realistic. */
function pair(smallSideMm: number): Manifold {
  const big = wasm.Manifold.cube([10, 10, 10]).translate([80, 60, 0]);
  const small = wasm.Manifold.cube([smallSideMm, smallSideMm, smallSideMm]).translate([95, 60, 0]);
  const both = wasm.Manifold.compose([big, small]);
  big.delete();
  small.delete();
  return both;
}

describe("bodiesFromMesh", () => {
  it("answers exactly, from the double read, for a body between one and ten debris floors", () => {
    const solid = pair(0.3); // 0.027 mm^3: 2.7 floors
    try {
      // Float32 vertices: within the order-of-magnitude margin, so no answer.
      expect(bodiesFromMesh(solid, DEBRIS_MM3)).toBeNull();
      const read = readMesh(solid);
      const quick = bodiesFromMesh(solid, DEBRIS_MM3, read);
      expect(quick).not.toBeNull();
      expect(quick?.count).toBe(2);
      expect(quick?.smallestMm3).toBeCloseTo(0.027, 9);
    } finally {
      solid.delete();
    }
  });

  it("still declines when a body is under the floor, or within noise of it", () => {
    const under = pair(0.2); // 0.008 mm^3
    try {
      expect(bodiesFromMesh(under, DEBRIS_MM3, readMesh(under))).toBeNull();
    } finally {
      under.delete();
    }
    const onIt = pair(Math.cbrt(DEBRIS_MM3)); // 0.01 mm^3 to rounding: ambiguous by construction
    try {
      expect(bodiesFromMesh(onIt, DEBRIS_MM3, readMesh(onIt))).toBeNull();
    } finally {
      onIt.delete();
    }
  });

  it("agrees with the kernel's decomposition on which bodies are debris", () => {
    const arena = new Arena();
    try {
      const kept = pair(0.3);
      arena.keep(kept);
      const prunedKept = pruneDebrisCounted(wasm, arena, kept, DEBRIS_MM3, readMesh(kept));
      expect(prunedKept.solid).toBe(kept);
      expect(prunedKept.dropped).toBe(0);
      expect(prunedKept.bodies).toEqual({ real: 2, debris: 0, debrisVolume: 0, smallestMm3: prunedKept.bodies.smallestMm3 });
      expect(prunedKept.bodies.smallestMm3).toBeCloseTo(0.027, 9);

      const dropped = pair(0.2);
      arena.keep(dropped);
      const prunedDropped = pruneDebrisCounted(wasm, arena, dropped, DEBRIS_MM3, readMesh(dropped));
      expect(prunedDropped.solid).not.toBe(dropped);
      expect(prunedDropped.dropped).toBe(1);
      expect(prunedDropped.bodies.real).toBe(1);
      expect(prunedDropped.solid.volume()).toBeCloseTo(1000, 6);
    } finally {
      arena.dispose();
    }
  });
});
