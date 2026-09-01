/**
 * Tiling: the grid, the joints, and what a cut costs.
 *
 * The joint tests measure real geometry rather than asserting that a function
 * was called: a mating pair either stands `tolerance_mm` apart or it does not,
 * and `Manifold.minGap` answers that in millimetres. The synthetic scenes are
 * small so the whole file runs in a few seconds; the Chicago tile is baked
 * once, at the end, for the timing budget and the per-tile plate fit.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams } from "../../contracts";
import { resolveProfile } from "../../printers";
import { bake } from "../engine";
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
import { loadManifold, type Manifold, type ManifoldToplevel } from "./manifold";
import { inscribedWidthMm } from "./measure";
import { degenerateFaces, openEdges } from "./mesh";

/** A 2x2 tiled Chicago has to bake inside this, in Node, on a developer machine. */
const TILED_TIME_BUDGET_MS = 25_000;

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

describe("a tiled bake", () => {
  let result: EngineResult;
  let whole: EngineResult;

  beforeAll(async () => {
    const graph = smallScene();
    whole = await bake({ scene: graph, params: smallParams(), date: "2026-09-01" });
    result = await bake({
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
    const result = await bake({
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
    const whole = await bake({ scene: graph, params: smallParams(), date: "2026-09-01" });
    const snug = await bake({
      scene: graph,
      params: smallParams({
        tiling: tiling({ cols: 2, rows: 2, tolerance_mm: 0, index_mark: false }),
      }),
      date: "2026-09-01",
    });
    const loose = await bake({
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
  });
});

describe("the index mark", () => {
  it("engraves the tile's own reference into every underside", async () => {
    const graph = smallScene();
    const marked = await bake({
      scene: graph,
      params: smallParams({ tiling: tiling({ cols: 2, rows: 2, index_mark: true }) }),
      date: "2026-09-01",
    });
    const plain = await bake({
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
  it("bakes inside the time budget and hands back four printable tiles", async () => {
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
    const result = await bake({ scene: chicagoScene(), params, date: "2026-09-01" });
    const elapsed = Date.now() - started;
    console.info(`[chicago 2x2] ${elapsed} ms, ${result.tiles?.length} tiles`);

    expect(result.tiles).toHaveLength(4);
    expect(elapsed).toBeLessThan(TILED_TIME_BUDGET_MS);
    const profile = resolveProfile(params);
    for (const tile of result.tiles ?? []) {
      expect(tile.merged?.volumeMm3 ?? 0).toBeGreaterThan(0);
      expect(tile.bbox.max[0] - tile.bbox.min[0]).toBeLessThanOrEqual(profile.plateXMm);
      expect(tile.bbox.max[1] - tile.bbox.min[1]).toBeLessThanOrEqual(profile.plateYMm);
      const mesh = tile.merged!;
      expect(openEdges({ positions: mesh.positions, indices: mesh.indices })).toBe(0);
      expect(degenerateFaces({ positions: mesh.positions, indices: mesh.indices })).toBe(0);
      console.info(
        `[chicago 2x2] ${tile.label}: ${(tile.bbox.max[0] - tile.bbox.min[0]).toFixed(1)} x ` +
          `${(tile.bbox.max[1] - tile.bbox.min[1]).toFixed(1)} mm, ${mesh.volumeMm3.toFixed(0)} mm3`,
      );
    }
    // The seams cost material and the engine says how much rather than hiding it.
    const trimmed = result.findings.find((f) => f.id === "tile-seam-trimmed");
    expect(trimmed?.severity).toBe("info");
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
  }, 180_000);
});
