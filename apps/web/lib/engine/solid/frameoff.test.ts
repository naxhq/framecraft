/**
 * The frame-off Chicago plate, judged by the reference validator's own rule.
 *
 * `[V3-P7-A11]` reported a build that fails `services/bake`'s `min_wall` row at
 * 0.1667 mm with the frame off, on a plate that passes with it on. The cause was
 * NOT the crop: it was `repair.residueParts` disagreeing with
 * `thicken._residue`. Clipper2 offsets exactly what it is given and GEOS
 * simplifies every buffer input at `0.01 * distance` first, so a needle in the
 * eroded ring fired a mitre spike that swallowed the wing it was meant to
 * isolate - and a wing nothing can see is a wing `widenThinParts` never widens.
 *
 * These tests measure the ASSEMBLED model the way the reference validator does:
 * per connected region of a horizontal slice, only for regions that survive one
 * printed layer upward, by `narrowestWidthMm` - the region's own inscribed width
 * lowered by every appendage's. They deliberately do NOT read
 * `stats.measuredMinWallMm`: the flat gate still measures only regions that
 * vanish under the erosion probe, which is the blind spot that let this through
 * (see `measure.measureMinWall`, `[V3-P7-fix]`). Asserting on the rule rather
 * than on the gate is what makes this a regression test for the DEFECT.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams } from "../../contracts";
import * as T from "../../transform";
import { buildModel } from "../engine";
import type { EngineResult } from "../types";
import { chicagoScene, solidFromMesh } from "./fixture";
import { makeContext } from "./context";
import { Arena, loadManifold } from "./manifold";
import { SLICE_SIMPLIFY_MM, WALL_PERSIST_RATIO, narrowestWidthMm } from "./measure";

const scene = chicagoScene();

function frameOffParams(plateMm: number): PrintParams {
  return { ...defaultPrintParams(), frame: false, plate_mm: plateMm };
}

/**
 * The narrowest wall in the assembled model at these heights, print mm, by the
 * reference validator's rule. Returns `Infinity` when no region is measurable.
 */
async function narrowestAt(
  params: PrintParams,
  result: EngineResult,
  heights: readonly number[],
): Promise<{ widthMm: number; atZMm: number | null }> {
  const wasm = await loadManifold();
  const arena = new Arena();
  try {
    const ctx = makeContext({ wasm, arena, scene, params });
    const persistMm = 0.625 * params.nozzle_mm;
    const solid = arena.keep(solidFromMesh(wasm, result.merged));
    let worst = Infinity;
    let atZ: number | null = null;
    for (const z of heights) {
      const slice = arena.keep(solid.slice(z));
      const lean = arena.keep(slice.simplify(SLICE_SIMPLIFY_MM));
      const above = arena.keep(solid.slice(z + persistMm));
      if (lean.isEmpty()) continue;
      for (const piece of arena.keepAll(lean.decompose())) {
        if (!above.isEmpty()) {
          const kept = arena.keep(piece.intersect(above));
          const survives = kept.area() >= WALL_PERSIST_RATIO * piece.area();
          arena.drop(kept);
          if (!survives) continue;
        }
        const width = narrowestWidthMm(ctx, piece, ctx.thresholdsMm.minWall);
        if (width < worst) {
          worst = width;
          atZ = z;
        }
      }
    }
    return { widthMm: worst, atZMm: atZ };
  } finally {
    arena.dispose();
  }
}

describe("frame-off chicago, by the reference validator's min-wall rule", () => {
  const params = frameOffParams(180);
  let result: EngineResult;

  beforeAll(async () => {
    result = await buildModel({ scene, params });
  }, 180_000);

  /**
   * The five heights the reference validator's own probe failed at, plus one
   * inside the recess band. Before the fix every one of them read 0.1667 mm on
   * one merged block spanning x 153.9 to 164.0, y 117.5 to 123.8 in build space
   * (the plate's own corner is the origin), and the block's own inscribed width
   * there is 3.37 mm - which is exactly why a whole-region probe could not see
   * it.
   */
  const FAILING_HEIGHTS_MM = [2.805, 4.542, 7.512, 11.609, 14.472, 16.665];

  it("holds a full minimum wall at every height the validator failed on", async () => {
    const { widthMm, atZMm } = await narrowestAt(params, result, FAILING_HEIGHTS_MM);
    const required = T.min_wall_mm(params);
    console.info(
      `[frame-off 180] narrowest ${widthMm.toFixed(4)} mm at z = ${String(atZMm)} ` +
        `against ${required} mm`,
    );
    // The reference validator fails under `0.9 * min_wall`; the engine repairs
    // to the full wall, so anything under it is a regression even though the
    // validator would still pass it.
    expect(widthMm).toBeGreaterThanOrEqual(required);
  }, 180_000);

  /**
   * The block the reference validator failed on, pinned as GEOMETRY.
   *
   * This is the test that actually fails when the fix is reverted. Measuring the
   * repaired plate with the engine's own probe cannot catch this defect - the
   * probe IS what was broken, so a reverted engine measures a clean plate and
   * agrees with itself. What changed and can be seen from outside is the block:
   * `widenThinParts` now finds the wing and grows it into the body, so the block
   * gets bigger and its south-west corner moves out.
   *
   * Slice at z = 4.542 (the first height the validator failed at), take the
   * region containing a point in the middle of that block, and read it in BUILD
   * space, where the plate's own corner is the origin - the frame the validator
   * reports in.
   *
   * | | before the fix | after |
   * |---|---|---|
   * | area | 34.2512 mm2 | 34.8924 mm2 |
   * | south-west corner | (153.856, 117.542) | (153.462, 117.129) |
   * | `thicken.narrowest_width` | **0.1667 mm** | 3.3612 mm |
   */
  it("widened the wing on the block the validator failed on", async () => {
    const wasm = await loadManifold();
    const arena = new Arena();
    try {
      const solid = arena.keep(solidFromMesh(wasm, result.merged));
      const slice = arena.keep(solid.slice(4.542));
      const half = T.plate_extents_mm(params).max_x;
      // Build space (158.0, 120.0), inside the block and clear of its edges.
      const inside: [number, number] = [158.0 - half, 120.0 - half];
      let found: { area: number; minX: number; minY: number } | null = null;
      for (const piece of arena.keepAll(slice.decompose())) {
        const box = piece.bounds();
        if (
          box.min[0] <= inside[0] &&
          box.max[0] >= inside[0] &&
          box.min[1] <= inside[1] &&
          box.max[1] >= inside[1] &&
          piece.area() < 100
        ) {
          found = { area: piece.area(), minX: box.min[0] + half, minY: box.min[1] + half };
        }
      }
      expect(found).not.toBeNull();
      const block = found as NonNullable<typeof found>;
      console.info(
        `[frame-off 180] block area ${block.area.toFixed(4)} mm2, corner ` +
          `(${block.minX.toFixed(3)}, ${block.minY.toFixed(3)})`,
      );
      // Comfortably past the unrepaired 34.2512 mm2 and well short of anything a
      // second wing would add.
      expect(block.area).toBeGreaterThan(34.6);
      expect(block.area).toBeLessThan(35.2);
      // The corner moved OUT by the wing's own widening; unrepaired it sits at
      // (153.856, 117.542).
      expect(block.minX).toBeLessThan(153.7);
      expect(block.minY).toBeLessThan(117.4);
    } finally {
      arena.dispose();
    }
  }, 180_000);

  it("raises no error finding", () => {
    const errors = result.findings.filter((f) => f.severity === "error");
    expect(errors).toEqual([]);
  });

  it("is one body and sits on the bed", () => {
    expect(result.merged.bodies).toBe(1);
    expect(Math.abs(result.merged.bbox.min[2])).toBeLessThanOrEqual(0.001);
  });
});
