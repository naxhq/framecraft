/**
 * Tiling: the grid, the joints, and what a cut costs.
 *
 * The joint tests measure real geometry rather than asserting that a function
 * was called: a mating pair either stands `tolerance_mm` apart or it does not,
 * and `Manifold.minGap` answers that in millimetres. The synthetic scenes are
 * small so the whole file runs in a few seconds; the Chicago tile is built
 * once, at the end, for the timing budget and the per-tile plate fit.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams } from "../../contracts";
import { BUDGET_FACTOR } from "../../testBudget";
import * as T from "../../transform";
import { resolveProfile } from "../../printers";
import { buildModel } from "../engine";
import type { EngineResult, TileResult } from "../types";
import { area, building, chicagoScene, road, scene, solidFromMesh, square } from "./fixture";
import {
  JOINT_BACK_MM,
  keyCount,
  MAX_KEYS_PER_SEAM,
  MIN_KEYS_PER_SEAM,
  snapCut,
  tileGridSpec,
  tileLabel,
} from "./tiling";
import { DEBRIS_MM3, ROUND, loadManifold, type Manifold, type ManifoldToplevel } from "./manifold";
import {
  OPENING_SEGMENTS,
  WALL_PERSIST_PER_NOZZLE,
  WALL_PERSIST_RATIO,
  inscribedWidthMm,
} from "./measure";
import { degenerateFaces, openEdges } from "./mesh";

/**
 * A 2x2 tiled Chicago has to build inside this, in Node, on a developer
 * machine -- 25 s LOCAL, at `VITEST_BUDGET_FACTOR=1`. The number does not move
 * for a slower box; the factor that box declares does. See
 * `lib/testBudget.ts` and docs/handoff/v3-07-perf.md section 12.
 */
const TILED_TIME_BUDGET_MS = 25_000 * BUDGET_FACTOR;

/**
 * The per-test ceiling for "accounts for every cubic millimetre", which is the
 * one test in this file that pays for THREE full builds of `smallScene` (whole,
 * snug, loose) rather than one or two, and so is the one that outgrew vitest's
 * 5 s default. It is a hang guard, not a budget: nothing here asserts a
 * duration, so it is set clear of the measured cost -- 1.7 to 1.9 s alone and
 * 2.4 s under a full-suite run here, 5.1 s and still unfinished on a runner --
 * with about eight times that as headroom, and scaled by the same factor so it
 * means the same thing on both. A genuinely stuck build still fails in well
 * under a minute, and every OTHER test in the suite keeps the 5 s default.
 */
const VOLUME_ACCOUNTING_TIMEOUT_MS = 20_000 * BUDGET_FACTOR;

let wasm: ManifoldToplevel;

beforeAll(async () => {
  wasm = await loadManifold();
});

function tiling(overrides: Partial<NonNullable<PrintParams["tiling"]>>): PrintParams["tiling"] {
  return {
    enabled: true,
    cols: 2,
    rows: 1,
    joint: "dovetail",
    tolerance_mm: 0.15,
    index_mark: true,
    ...overrides,
  };
}

/** A small, dense-enough scene: a plate with a few blocks and a road on it. */
function smallScene() {
  return scene({
    buildings: [
      building("a", square(-60, -40, 50), 40),
      building("b", square(60, -40, 50), 40),
      building("c", square(-60, 60, 40), 25),
      building("d", square(60, 60, 40), 25),
      building("e", square(0, 0, 30), 60),
    ],
    roads: [road("r1", [[-200, 10], [200, 10]], 14)],
    green: [area(square(-120, 120, 60))],
    radiusM: 200,
  });
}

function smallParams(overrides: Partial<PrintParams> = {}): PrintParams {
  return {
    ...defaultPrintParams(),
    plate_mm: 120,
    trees: false,
    ...overrides,
  };
}

function tileByLabel(result: EngineResult, label: string): TileResult {
  const tile = (result.tiles ?? []).find((item) => item.label === label);
  expect(tile, `tile ${label}`).toBeDefined();
  return tile as TileResult;
}

/** A tile's welded solid, re-imported. Throws if the mesh is not a valid solid. */
function tileSolid(tile: TileResult): Manifold {
  expect(tile.merged).toBeDefined();
  return solidFromMesh(wasm, tile.merged!);
}

/**
 * The two rows a cut breaks, asked of one tile exactly as the reference
 * validator asks them of the file. Returns how many heights were judged.
 *
 * * `bodies` - every shell of every colour part is at least
 *   `MIN_PART_BODY_VOLUME_MM3` (which is this engine's own {@link DEBRIS_MM3}).
 *   A tile is five booleans past the region solids the finish stage pruned, and
 *   any of them can shear a chip off and leave it floating.
 * * `min_wall` - every connected region of every sampled slice holds a disc of
 *   `MIN_WALL_FAIL_FACTOR * min_wall`. The filters are the ones
 *   `checks._min_wall_probe` applies and in the order `measure.measureMinWall`
 *   applies them: the erosion first, because it offsets one small region and
 *   costs 0.04 ms, then `WALL_PERSIST_RATIO` one printed layer up, which is
 *   what separates a wall from the tip of a taper or the lip of a groove (the
 *   Chicago tiles carry a 0.0056 mm2 chip at z 2.90, in the 0.2 mm band between
 *   the road tops and the base top, that is gone 0.25 mm higher - the validator
 *   does not judge it and neither does this). The width is only searched for a
 *   region that has already failed both, to put a number in the message.
 *
 * The Z bands the mandatory attribution marks occupy are skipped, for the
 * reason the validator skips them (`[V3-P7-A8]`, the sidecar's
 * `attribution_bands`): the ridge between two engraved letters is texture in
 * the face of a solid block, not a free-standing wall, and the `attribution`
 * row judges it instead. Without this the underside mark alone shows twenty
 * 0.07 mm "walls" on a tile every validator row passes.
 */
function expectPrintableTile(
  tile: TileResult,
  bands: ReadonlyArray<readonly [number, number]>,
  minWallMm: number,
  nozzleMm: number,
): number {
  for (const region of tile.regions) {
    const solid = solidFromMesh(wasm, region);
    try {
      const bodies = solid.decompose();
      const smallest = Math.min(...bodies.map((body) => body.volume()));
      for (const body of bodies) body.delete();
      expect(
        smallest,
        `${tile.label} ${region.region}: smallest shell ${smallest.toFixed(6)} mm3`,
      ).toBeGreaterThanOrEqual(DEBRIS_MM3);
    } finally {
      solid.delete();
    }
  }

  const failAt = 0.9 * minWallMm;
  const merged = tileSolid(tile);
  let judged = 0;
  try {
    const top = merged.boundingBox().max[2];
    for (const z of [0.4, 1.5, 2.6, 2.9, top * 0.55, top * 0.7, top * 0.85, top * 0.95]) {
      if (bands.some(([lo, hi]) => z >= lo && z <= hi)) continue;
      judged += 1;
      const section = merged.slice(z);
      const above = merged.slice(z + WALL_PERSIST_PER_NOZZLE * nozzleMm);
      const pieces = section.decompose();
      try {
        for (const piece of pieces) {
          const eroded = piece.offset(-failAt / 2, ROUND, 2, OPENING_SEGMENTS);
          const thin = eroded.isEmpty();
          eroded.delete();
          if (!thin) continue;
          if (!above.isEmpty()) {
            const kept = piece.intersect(above);
            const survives = kept.area() >= WALL_PERSIST_RATIO * piece.area();
            kept.delete();
            if (!survives) continue;
          }
          const width = inscribedWidthMm(piece, minWallMm, 0.001);
          expect(
            width,
            `${tile.label} at z ${z.toFixed(2)}: a region of ${piece.area().toFixed(5)} mm2 ` +
              `spanning ${JSON.stringify(piece.bounds())}`,
          ).toBeGreaterThanOrEqual(failAt);
        }
      } finally {
        for (const piece of pieces) piece.delete();
        above.delete();
        section.delete();
      }
    }
  } finally {
    merged.delete();
  }
  return judged;
}

describe("the grid", () => {
  it("reads the tiling parameters and refuses a one-tile grid", () => {
    expect(tileGridSpec(smallParams())).toBeNull();
    expect(tileGridSpec(smallParams({ tiling: tiling({ cols: 1, rows: 1 }) }))).toBeNull();
    const spec = tileGridSpec(smallParams({ tiling: tiling({ cols: 3, rows: 2, joint: "pin" }) }));
    expect(spec).toEqual({ cols: 3, rows: 2, joint: "pin", toleranceMm: 0.15, indexMark: true });
  });

  it("labels columns from the west and rows from the north", () => {
    expect(tileLabel(0, 1, 2)).toBe("A1");
    expect(tileLabel(1, 1, 2)).toBe("B1");
    expect(tileLabel(0, 0, 2)).toBe("A2");
    expect(tileLabel(2, 0, 3)).toBe("C3");
  });

  it("gives every seam at least two keys and never more than the ceiling", () => {
    expect(keyCount(90, 6)).toBe(MIN_KEYS_PER_SEAM);
    expect(keyCount(1000, 6)).toBe(6);
    expect(keyCount(5000, 6)).toBe(MAX_KEYS_PER_SEAM);
  });

  it("moves a cut to the widest gap between the walls it would otherwise shave", () => {
    // Walls at 0 and at 4; the clean line is the midpoint.
    expect(snapCut(0.1, [0, 4, 10], 3, 0.72)).toBeCloseTo(2, 2);
    // Nothing nearby: the nominal line is kept.
    expect(snapCut(5, [40, 60], 3, 0.72)).toBeCloseTo(5, 6);
    // Never leaves the window, however bad the neighbourhood.
    const crowded = Array.from({ length: 61 }, (_v, i) => -3 + i * 0.1);
    const at = snapCut(0, crowded, 3, 0.72);
    expect(Math.abs(at)).toBeLessThanOrEqual(3 + 1e-9);
  });
});

describe("a tiled build", () => {
  let result: EngineResult;
  let whole: EngineResult;

  beforeAll(async () => {
    const graph = smallScene();
    whole = await buildModel({ scene: graph, params: smallParams(), date: "2026-09-01" });
    result = await buildModel({
      scene: graph,
      params: smallParams({ tiling: tiling({ cols: 2, rows: 2 }) }),
      date: "2026-09-01",
    });
  });

  it("returns one tile per grid square, labelled and counted in the stats", () => {
    expect(result.tiles).toHaveLength(4);
    expect(result.tiles?.map((tile) => tile.label).sort()).toEqual(["A1", "A2", "B1", "B2"]);
    expect(result.stats.tiles).toBe(4);
    expect(result.stats.tileCols).toBe(2);
    expect(result.stats.tileRows).toBe(2);
    expect(whole.tiles).toBeUndefined();
    expect(whole.stats.tiles).toBeUndefined();
  });

  it("gives every tile watertight, manifold regions and a welded solid", () => {
    for (const tile of result.tiles ?? []) {
      expect(tile.regions.length).toBeGreaterThan(0);
      for (const region of tile.regions) {
        const solid = solidFromMesh(wasm, region);
        try {
          expect(solid.status()).toBe("NoError");
          expect(solid.volume()).toBeGreaterThan(0);
        } finally {
          solid.delete();
        }
        expect(openEdges({ positions: region.positions, indices: region.indices })).toBe(0);
        expect(degenerateFaces({ positions: region.positions, indices: region.indices })).toBe(0);
      }
      const merged = tileSolid(tile);
      try {
        expect(merged.status()).toBe("NoError");
      } finally {
        merged.delete();
      }
    }
  });

  it("keeps every tile inside the printer's plate", () => {
    const profile = resolveProfile(result.params);
    for (const tile of result.tiles ?? []) {
      expect(tile.bbox.max[0] - tile.bbox.min[0]).toBeLessThanOrEqual(profile.plateXMm);
      expect(tile.bbox.max[1] - tile.bbox.min[1]).toBeLessThanOrEqual(profile.plateYMm);
    }
    expect(result.findings.find((f) => f.id === "tile-exceeds-plate")).toBeUndefined();
  });

  it("divides the model between the tiles: no tile is the whole thing", () => {
    const volumes = (result.tiles ?? []).map((tile) => tile.merged?.volumeMm3 ?? 0);
    for (const volume of volumes) {
      expect(volume).toBeGreaterThan(0);
      expect(volume).toBeLessThan(whole.merged.volumeMm3);
    }
  });
});

describe("a cut through a water body", () => {
  /**
   * The two ways a cut leaves a tile the reference validator fails, both found
   * by `scripts/ci-export-matrix.sh` on the Chicago 2x2 grid and both reduced
   * here to a scene small enough to run in a couple of seconds.
   *
   * * `bodies`: a chip of a colour region, sheared off by the cut or by the
   *   sliver cutter, floating beside the tile. Chicago tile A1 kept a
   *   0.000458 mm3 splinter of water; the validator reports it as
   *   "debris shell(s): water".
   * * `min_wall`: a needle the sliver cutter STRANDED. Removing a fin retreats
   *   a boundary, and what the retreat isolates is a region of its own - on
   *   tile A1 a 0.00535 mm2 island 0.046 mm wide, which the old
   *   `SLIVER_MIN_AREA_MM2` floor in `thinPart` was too coarse to see and the
   *   validator failed the tile on at 0.037 mm.
   *
   * A water body straddling the cut is what produces both: it is a shallow
   * recess, so the plate under it is at its thinnest exactly where the seam
   * passes, and its own layer is thin enough to shatter into chips.
   *
   * This scene is the CHEAP guard, a second and a half of the suite, and it did
   * not on its own reproduce either defect on the pre-fix tree: four variants
   * were built and measured and the worst wall any of them left was a full
   * 0.80 mm. The fixture that carries both is the real Chicago plate, and the
   * "split four ways" case at the end of this file is where the two rules are
   * asked of it.
   */
  const scene2 = () =>
    scene({
      buildings: [
        building("n", square(-30, 45, 26), 30),
        building("s", square(30, -45, 26), 30),
        building("edge", square(2, 20, 18), 22),
      ],
      roads: [road("r1", [[-200, -6], [200, -6]], 12), road("r2", [[4, -200], [4, 200]], 10)],
      // Straddles the x = 0 cut, and its west lobe reaches under the road.
      water: [area(square(0, 0, 90))],
      green: [area(square(-70, -70, 40))],
      radiusM: 220,
    });

  it("leaves every tile free of debris shells and stranded needles", async () => {
    const params = smallParams({ plate_mm: 140, tiling: tiling({ cols: 2, rows: 2 }) });
    const result = await buildModel({ scene: scene2(), params, date: "2026-09-01" });
    expect(result.tiles).toHaveLength(4);
    const bands = result.attributionBands ?? [];
    let waterTiles = 0;
    let judged = 0;
    for (const tile of result.tiles ?? []) {
      waterTiles += tile.regions.filter((region) => region.region === "water").length;
      judged += expectPrintableTile(tile, bands, T.min_wall_mm(params), params.nozzle_mm);
    }
    // The scene has to have put water on more than one tile, and the probe has
    // to have judged real heights, for any of this to mean anything.
    expect(waterTiles).toBeGreaterThan(1);
    expect(judged).toBeGreaterThanOrEqual(12);
  }, 120_000);
});

describe("the joint", () => {
  /**
   * The part of a tile that reaches past the seam: its male keys.
   *
   * The seam is where the EAST tile starts, which is exact for both joint
   * kinds; the trim starts a little past it so the two tiles' flat butt faces,
   * which touch by construction, are not what the gap measurement finds.
   */
  function protrusion(solid: Manifold, planeMm: number): Manifold {
    return solid.trimByPlane([1, 0, 0], planeMm + JOINT_BACK_MM);
  }

  async function tiles(toleranceMm: number, joint: "dovetail" | "pin" = "dovetail") {
    const result = await buildModel({
      scene: smallScene(),
      params: smallParams({
        tiling: tiling({ cols: 2, rows: 1, tolerance_mm: toleranceMm, joint, index_mark: false }),
      }),
      date: "2026-09-01",
    });
    return {
      result,
      west: tileByLabel(result, "A1"),
      east: tileByLabel(result, "B1"),
    };
  }

  it("leaves exactly the tolerance between the key and its socket", async () => {
    const { west, east } = await tiles(0.3);
    const a = tileSolid(west);
    const b = tileSolid(east);
    const key = protrusion(a, east.bbox.min[0]);
    try {
      expect(key.volume()).toBeGreaterThan(0);
      // The two never share material...
      const shared = wasm.Manifold.intersection([a, b]);
      expect(shared.volume()).toBeCloseTo(0, 6);
      shared.delete();
      // ... and the closest the key comes to the socket is the tolerance.
      expect(key.minGap(b, 5)).toBeCloseTo(0.3, 2);
    } finally {
      key.delete();
      a.delete();
      b.delete();
    }
  });

  it("mates with no clearance at all at tolerance zero", async () => {
    const { west, east } = await tiles(0);
    const a = tileSolid(west);
    const b = tileSolid(east);
    const key = protrusion(a, east.bbox.min[0]);
    try {
      expect(key.minGap(b, 5)).toBeCloseTo(0, 2);
      const shared = wasm.Manifold.intersection([a, b]);
      expect(shared.volume()).toBeCloseTo(0, 6);
      shared.delete();
    } finally {
      key.delete();
      a.delete();
      b.delete();
    }
  });

  it("interferes by exactly the tolerance when it is negative", async () => {
    const { west, east } = await tiles(-0.3);
    const a = tileSolid(west);
    const b = tileSolid(east);
    const shared = wasm.Manifold.intersection([a, b]);
    try {
      // They overlap, which is what an interference fit means.
      expect(shared.volume()).toBeGreaterThan(0);
      // And the overlap is a band at least as wide as the tolerance: the
      // socket is the key's own section offset INWARD by 0.3 mm, so the two
      // interfere by 0.3 mm measured across every flank. Measured inside the
      // base slab, where the joint always has material.
      //
      // The upper bound is the mitre limit and not 0.3: an inward offset opens
      // out at a reflex corner, and the dovetail has one on each side of its
      // neck, so the band is locally wider there by up to `MITRE_LIMIT` times
      // the offset. The guarantee a fit needs is the LOWER bound - it is at
      // least this tight everywhere - and that is what is asserted.
      const section = shared.slice(1.5);
      const width = inscribedWidthMm(section, 1.2, 0.005);
      section.delete();
      expect(width).toBeGreaterThanOrEqual(0.3 - 0.01);
      expect(width).toBeLessThanOrEqual(2 * 0.3);
    } finally {
      shared.delete();
      a.delete();
      b.delete();
    }
  });

  it("registers a pin joint inside the base slab", async () => {
    const { west, east } = await tiles(0.2, "pin");
    const a = tileSolid(west);
    const b = tileSolid(east);
    const key = protrusion(a, east.bbox.min[0]);
    try {
      expect(key.volume()).toBeGreaterThan(0);
      // A pin lies inside the base: it never breaks out of the top or bottom.
      const box = key.boundingBox();
      expect(box.min[2]).toBeGreaterThan(0);
      expect(box.max[2]).toBeLessThan(west.bbox.max[2]);
      expect(key.minGap(b, 5)).toBeCloseTo(0.2, 2);
    } finally {
      key.delete();
      a.delete();
      b.delete();
    }
  });

  it("accounts for every cubic millimetre: the tiles are the model less the gaps", async () => {
    const graph = smallScene();
    const whole = await buildModel({ scene: graph, params: smallParams(), date: "2026-09-01" });
    const snug = await buildModel({
      scene: graph,
      params: smallParams({
        tiling: tiling({ cols: 2, rows: 2, tolerance_mm: 0, index_mark: false }),
      }),
      date: "2026-09-01",
    });
    const loose = await buildModel({
      scene: graph,
      params: smallParams({
        tiling: tiling({ cols: 2, rows: 2, tolerance_mm: 0.3, index_mark: false }),
      }),
      date: "2026-09-01",
    });
    const total = (result: EngineResult): number =>
      (result.tiles ?? []).reduce((sum, tile) => sum + (tile.merged?.volumeMm3 ?? 0), 0);

    // With no clearance the tiles carry the whole model back, to within the
    // material the seams had to trim (reported as `tile-seam-trimmed`).
    const snugLoss = whole.merged.volumeMm3 - total(snug);
    expect(snugLoss).toBeGreaterThanOrEqual(0);
    expect(snugLoss / whole.merged.volumeMm3).toBeLessThan(0.01);
    // A clearance costs material, and a bigger one costs more.
    const looseLoss = whole.merged.volumeMm3 - total(loose);
    expect(looseLoss).toBeGreaterThan(snugLoss);
    expect(looseLoss / whole.merged.volumeMm3).toBeLessThan(0.02);
  }, VOLUME_ACCOUNTING_TIMEOUT_MS);
});

describe("the index mark", () => {
  it("engraves the tile's own reference into every underside", async () => {
    const graph = smallScene();
    const marked = await buildModel({
      scene: graph,
      params: smallParams({ tiling: tiling({ cols: 2, rows: 2, index_mark: true }) }),
      date: "2026-09-01",
    });
    const plain = await buildModel({
      scene: graph,
      params: smallParams({ tiling: tiling({ cols: 2, rows: 2, index_mark: false }) }),
      date: "2026-09-01",
    });
    expect(marked.findings.find((f) => f.id === "tile-index-refused")).toBeUndefined();

    for (const tile of marked.tiles ?? []) {
      const twin = (plain.tiles ?? []).find((other) => other.label === tile.label);
      expect(twin, `unmarked twin of ${tile.label}`).toBeDefined();
      // The mark is a pocket, so the marked tile weighs less...
      const cut = (twin?.merged?.volumeMm3 ?? 0) - (tile.merged?.volumeMm3 ?? 0);
      expect(cut).toBeGreaterThan(0.1);
      // ... and the pocket is on the UNDERSIDE, in the middle of the tile.
      const solid = tileSolid(tile);
      try {
        const skin = solid.slice(0.15);
        const full = solid.slice(0.9);
        // A slice through the mark has holes the slice above it does not.
        expect(skin.numContour()).toBeGreaterThan(full.numContour());
        skin.delete();
        full.delete();
      } finally {
        solid.delete();
      }
    }
  });
});

describe("the Chicago plate, split four ways", () => {
  it("builds inside the time budget and hands back four printable tiles", async () => {
    const params: PrintParams = {
      ...defaultPrintParams(),
      tiling: {
        enabled: true,
        cols: 2,
        rows: 2,
        joint: "dovetail",
        tolerance_mm: 0.15,
        index_mark: true,
      },
    };
    const started = Date.now();
    const result = await buildModel({ scene: chicagoScene(), params, date: "2026-09-01" });
    const elapsed = Date.now() - started;
    console.info(
      `[chicago 2x2] ${elapsed} ms, ${result.tiles?.length} tiles ` +
        `(budget ${TILED_TIME_BUDGET_MS} ms at factor ${BUDGET_FACTOR})`,
    );

    expect(result.tiles).toHaveLength(4);
    expect(elapsed).toBeLessThan(TILED_TIME_BUDGET_MS);
    const profile = resolveProfile(params);
    const bands = result.attributionBands ?? [];
    let judged = 0;
    for (const tile of result.tiles ?? []) {
      expect(tile.merged?.volumeMm3 ?? 0).toBeGreaterThan(0);
      expect(tile.bbox.max[0] - tile.bbox.min[0]).toBeLessThanOrEqual(profile.plateXMm);
      expect(tile.bbox.max[1] - tile.bbox.min[1]).toBeLessThanOrEqual(profile.plateYMm);
      const mesh = tile.merged!;
      expect(openEdges({ positions: mesh.positions, indices: mesh.indices })).toBe(0);
      expect(degenerateFaces({ positions: mesh.positions, indices: mesh.indices })).toBe(0);
      // The two rows `scripts/ci-export-matrix.sh` failed tile A1 on, asked
      // here rather than only nightly: `min_wall` at 0.037 mm, one 0.00535 mm2
      // needle the sliver cutter stranded and its own area floor then hid, and
      // `bodies`, a 0.000458 mm3 splinter of water left floating by the cut.
      judged += expectPrintableTile(tile, bands, T.min_wall_mm(params), params.nozzle_mm);
      console.info(
        `[chicago 2x2] ${tile.label}: ${(tile.bbox.max[0] - tile.bbox.min[0]).toFixed(1)} x ` +
          `${(tile.bbox.max[1] - tile.bbox.min[1]).toFixed(1)} mm, ${mesh.volumeMm3.toFixed(0)} mm3`,
      );
    }
    expect(judged).toBeGreaterThanOrEqual(12);
    // The seams cost material and the engine says how much rather than hiding it.
    const trimmed = result.findings.find((f) => f.id === "tile-seam-trimmed");
    expect(trimmed?.severity).toBe("info");
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
  }, 180_000);
});
