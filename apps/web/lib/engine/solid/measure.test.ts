/**
 * What the minimum-wall gate is allowed to SPEND, not only what it reports.
 *
 * `measureMinWall` walks every connected region of every sampled slice through
 * two `continue` filters: an erosion probe, which offsets that one region, and a
 * persistence test, which intersects that region with the whole unsimplified
 * slice one printed layer above it. Both filters pass the same set through in
 * either order, so nothing about the ANSWER pins their order - and their costs
 * differ by two orders of magnitude, because the erosion is sized by the region
 * and the intersect is sized by the slice. Running persistence first made the
 * default browser bake 2.7x slower and stalled the e2e preview
 * (`[V3-P7-fix2-1]`, `docs/handoff/v3-07-fix.md` §8).
 *
 * A wall-clock bound would pin this too, and would be flaky on a loaded host.
 * This counts the intersects instead: on a flat bake the persistence test may
 * only ever see a region the erosion probe already found thin.
 */

import { describe, expect, it } from "vitest";

import { defaultPrintParams } from "../../contracts";
import { makeContext } from "./context";
import { scene } from "./fixture";
import {
  Arena,
  batchedUnion,
  extrudeSection,
  loadManifold,
  rectContour,
  sectionOf,
  type Contour,
  type CrossSection,
} from "./manifold";
import { measureMinWall } from "./measure";

/** Fat pillars per side of the test grid. */
const GRID = 14;

describe("the minimum-wall gate's per-region filters", () => {
  it("only pays the persistence intersect for a region the erosion probe called thin", async () => {
    const wasm = await loadManifold();
    const arena = new Arena();
    try {
      const params = defaultPrintParams();
      const ctx = makeContext({ wasm, arena, scene: scene({ radiusM: 200 }), params });
      const { minWall } = ctx.thresholdsMm;
      const baseTop = ctx.baseTopMm;
      const topMm = baseTop + 5;

      // A slab carrying GRID x GRID pillars far too fat to be thin anywhere,
      // plus ONE strip under half a wall wide. The gate has to find the strip
      // and must not touch the slice above for any of the rest.
      const fat = 8 * minWall;
      const pitch = 12 * minWall;
      const span = (GRID - 1) * pitch;
      const pillars: Contour[] = [];
      for (let i = 0; i < GRID; i += 1) {
        for (let j = 0; j < GRID; j += 1) {
          const x = -span / 2 + i * pitch;
          const y = -span / 2 + j * pitch;
          pillars.push(rectContour(x, y, x + fat, y + fat));
        }
      }
      const thinWidth = 0.4 * minWall;
      const thinY = -span / 2 - pitch;
      pillars.push(rectContour(-fat / 2, thinY, -fat / 2 + thinWidth, thinY + fat));

      const half = ctx.plateHalfMm;
      const slab = extrudeSection(
        wasm,
        arena,
        sectionOf(wasm, arena, [rectContour(-half, -half, half, half)]),
        0,
        baseTop,
      );
      const standing = extrudeSection(
        wasm,
        arena,
        sectionOf(wasm, arena, pillars),
        baseTop,
        topMm,
      );
      const solid = batchedUnion(wasm, arena, [slab, standing]);
      expect(solid).not.toBeNull();

      // Counted on the prototype rather than on one handle: `measureMinWall`
      // intersects pieces `decompose()` hands it, which this test never holds.
      // It has to be read off an INSTANCE - manifold's binding wraps the embind
      // class, so `wasm.CrossSection.prototype` is not what a section inherits
      // from, and patching it is a silent no-op. Every section shares this one,
      // whether it came from a constructor, `decompose()` or `Manifold.slice()`.
      const probeSection = arena.keep(
        new wasm.CrossSection([rectContour(0, 0, 1, 1)], "Positive"),
      );
      const proto = Object.getPrototypeOf(probeSection) as {
        intersect: (this: CrossSection, other: CrossSection) => CrossSection;
      };
      const real = proto.intersect;
      let intersects = 0;
      proto.intersect = function (this: CrossSection, other: CrossSection) {
        intersects += 1;
        return real.call(this, other);
      };
      let report;
      try {
        report = measureMinWall(ctx, solid!);
      } finally {
        proto.intersect = real;
      }

      // The strip was found: the gate did not saturate at a full wall.
      expect(report.measuredMm).not.toBeNull();
      expect(report.measuredMm!).toBeLessThan(minWall);
      expect(report.measuredMm!).toBeGreaterThan(thinWidth / 2);
      expect(report.thinRegions).toBeGreaterThanOrEqual(1);
      expect(report.slices).toBeGreaterThan(1);

      // ...and it cost one intersect per slice that HAS the strip, never one per
      // region. The count is at least 1, which is what proves the counter is
      // wired to the call the assertion is about; with the two filters swapped
      // it is one per pillar per slice, i.e. GRID * GRID times larger.
      expect(intersects).toBeGreaterThanOrEqual(1);
      expect(intersects).toBeLessThanOrEqual(report.slices);
    } finally {
      arena.dispose();
    }
  });
});
