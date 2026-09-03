/**
 * `RegionMeshes`: what the viewport does to the pipeline's streamed solids
 * before they can be drawn, which region a change re-uploads, and how a recess
 * band is shaded.
 *
 * Three claims are pinned here.
 *
 * 1. The geometry is the engine's own. `RegionMesh.positions`/`indices` are
 *    already interleaved xyz triples and a flat triangle index list in print
 *    millimetres, so a region with no recess bands becomes exactly one
 *    `BufferGeometry` with no re-triangulation and no welding: the same data an
 *    exporter writes, so the preview and the downloaded file cannot show a
 *    different shape.
 * 2. A region is rebuilt IF AND ONLY IF its own mesh changed. The worker never
 *    re-sends a region whose `finish-<region>` key matched the `known` map, so
 *    a new `RegionMesh` object is a changed hash; `RegionGeometryCache` is
 *    driven twice below with one region moved, and the other region's
 *    `BufferGeometry` has to survive by reference.
 * 3. Recess shading is exact and geometry-free. Every triangle the shading
 *    darkens has a centroid Z inside one of its own region's bands, and every
 *    coordinate is still the coordinate the engine sent.
 *
 * The span used to be called `preview.geometry`, and the baseline note read it
 * as a GPU upload (audit, finding 5). Nothing in `buildGeometry` touches the
 * GPU: it is a float64 to float32 copy, an index or a recess pass, vertex
 * normals and a bounding sphere, all on the main thread. three.js uploads a
 * buffer lazily, on the first render that binds it, which is after the span
 * has closed -- so the span is named for the region it builds and the upload
 * gets a mark of its own on the first frame that renders these meshes.
 *
 * react-three-fiber is mocked for the same reason as in
 * `PerfFrameMark.test.tsx`: the real one needs a WebGL canvas.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loop } = vi.hoisted(() => ({ loop: { callbacks: [] as (() => void)[] } }));

vi.mock("@react-three/fiber", () => ({
  useFrame: (callback: () => void) => {
    loop.callbacks.push(callback);
  },
}));

import type { RecessBand, RegionMesh } from "@/lib/engine/types";
import {
  perfDrainTimings,
  perfReset,
  perfResetDetectionForTest,
  setPerfEnabled,
} from "@/lib/perf";

import RegionMeshes, {
  RegionGeometryCache,
  bandsForRegion,
  buildGeometry,
  insideBands,
} from "./RegionMeshes";

const NO_BANDS: RecessBand[] = [];

/** One triangle, which is the smallest thing the filter lets through. */
function triangle(region: RegionMesh["region"] = "base", z = 0): RegionMesh {
  return {
    region,
    positions: new Float64Array([0, 0, z, 10, 0, z, 0, 10, z]),
    indices: new Uint32Array([0, 1, 2]),
    volumeMm3: 0,
    bbox: { min: [0, 0, z], max: [10, 10, z] },
    bodies: 1,
    slot: 1,
    colorHex: "#808080",
  };
}

/** Two triangles at different heights: one inside a band, one above it. */
function twoLevels(): RegionMesh {
  return {
    region: "frame",
    positions: new Float64Array([
      0, 0, 1, 10, 0, 1, 0, 10, 1, // z = 1, inside the band below
      0, 0, 9, 10, 0, 9, 0, 10, 9, // z = 9, well clear of it
    ]),
    indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    volumeMm3: 0,
    bbox: { min: [0, 0, 1], max: [10, 10, 9] },
    bodies: 1,
    slot: 2,
    colorHex: "#3A3A3A",
  };
}

const FRAME_BAND: RecessBand = { region: "frame", kind: "lettering", zMm: [0.5, 1.5] };

function asMap(...meshes: RegionMesh[]): Map<string, RegionMesh> {
  return new Map(meshes.map((mesh) => [mesh.region, mesh]));
}

beforeEach(() => {
  loop.callbacks.length = 0;
  perfResetDetectionForTest();
  perfReset();
});

afterEach(() => {
  perfResetDetectionForTest();
  perfReset();
});

describe("buildGeometry", () => {
  it("carries a band-free region's own positions and indices straight through, unwelded", () => {
    const geometry = buildGeometry(triangle(), NO_BANDS, 0.6);
    const position = geometry.getAttribute("position");
    expect(position.array).toBeInstanceOf(Float32Array);
    expect(position.count).toBe(3);
    expect(Array.from(position.array)).toEqual([0, 0, 0, 10, 0, 0, 0, 10, 0]);
    expect(geometry.getIndex()?.count).toBe(3);
    expect(Array.from(geometry.getIndex()?.array ?? [])).toEqual([0, 1, 2]);
    // No colour attribute at all: the region paints in its own filament and
    // pays nothing for a shading pass it has no bands for.
    expect(geometry.getAttribute("color")).toBeUndefined();
    geometry.dispose();
  });

  it("computes vertex normals and a bounding sphere, so the mesh renders and frames correctly", () => {
    const geometry = buildGeometry(triangle(), NO_BANDS, 0.6);
    expect(geometry.getAttribute("normal")).toBeDefined();
    expect(geometry.boundingSphere).not.toBeNull();
    geometry.dispose();
  });

  it("a two-triangle region (a real solid's worth of faces) keeps every triangle", () => {
    const geometry = buildGeometry(twoLevels(), NO_BANDS, 0.6);
    expect(geometry.getIndex()?.count).toBe(6);
    geometry.dispose();
  });

  it("darkens exactly the triangles whose centroid Z lies inside a band, and moves no coordinate", () => {
    const region = twoLevels();
    const shade = 0.62;
    const geometry = buildGeometry(region, [FRAME_BAND], shade);
    const position = geometry.getAttribute("position");
    const colour = geometry.getAttribute("color");
    expect(colour).toBeDefined();
    expect(position.count).toBe(6);

    const shaded: number[] = [];
    for (let t = 0; t < position.count / 3; t += 1) {
      let z = 0;
      for (let k = 0; k < 3; k += 1) z += position.getZ(t * 3 + k);
      const centroidZ = z / 3;
      const tint = colour.getX(t * 3);
      // Every vertex of a triangle carries the same multiplier.
      for (let k = 0; k < 3; k += 1) {
        expect(colour.getX(t * 3 + k)).toBe(tint);
        expect(colour.getY(t * 3 + k)).toBe(tint);
        expect(colour.getZ(t * 3 + k)).toBe(tint);
      }
      if (tint !== 1) {
        shaded.push(centroidZ);
        // The claim, stated as the design states it.
        expect(tint).toBeCloseTo(shade, 6);
        expect(insideBands(centroidZ, [FRAME_BAND])).toBe(true);
      } else {
        expect(insideBands(centroidZ, [FRAME_BAND])).toBe(false);
      }
    }
    // Not vacuous: exactly one of the two triangles is inside the band.
    expect(shaded).toEqual([1]);

    // The geometry itself is untouched: every coordinate the engine sent is
    // still there, in the same triangles, just no longer sharing vertices.
    const sent = region.positions;
    for (let t = 0; t < 2; t += 1) {
      for (let k = 0; k < 3; k += 1) {
        const from = region.indices[t * 3 + k] * 3;
        expect(position.getX(t * 3 + k)).toBeCloseTo(sent[from], 6);
        expect(position.getY(t * 3 + k)).toBeCloseTo(sent[from + 1], 6);
        expect(position.getZ(t * 3 + k)).toBeCloseTo(sent[from + 2], 6);
      }
    }
    geometry.dispose();
  });

  it("treats a band as closed at both ends", () => {
    expect(insideBands(0.5, [FRAME_BAND])).toBe(true);
    expect(insideBands(1.5, [FRAME_BAND])).toBe(true);
    expect(insideBands(1.500001, [FRAME_BAND])).toBe(false);
  });

  it("gives a region only its OWN bands", () => {
    const bands: RecessBand[] = [
      FRAME_BAND,
      { region: "base", kind: "underside", zMm: [0, 0.6] },
    ];
    expect(bandsForRegion(bands, "frame")).toEqual([FRAME_BAND]);
    expect(bandsForRegion(bands, "buildings")).toEqual([]);
  });
});

describe("RegionGeometryCache", () => {
  it("rebuilds a region if and only if its own mesh changed", () => {
    const cache = new RegionGeometryCache();
    const base = triangle("base");
    const frame = twoLevels();

    const first = cache.reconcile(asMap(base, frame), NO_BANDS, 0.6);
    expect(first.regions.map((entry) => entry.region).sort()).toEqual(["base", "frame"]);
    const baseGeometry = first.regions.find((entry) => entry.region === "base")?.geometry;
    const frameGeometry = first.regions.find((entry) => entry.region === "frame")?.geometry;

    // A second run in which only the frame's hash moved: the worker re-sent
    // the frame and said nothing about the base.
    const movedFrame = twoLevels();
    const second = cache.reconcile(asMap(base, movedFrame), NO_BANDS, 0.6);
    expect(second.regions.find((entry) => entry.region === "base")?.geometry).toBe(baseGeometry);
    expect(second.regions.find((entry) => entry.region === "frame")?.geometry).not.toBe(
      frameGeometry,
    );
    cache.dispose();
  });

  it("rebuilds a region whose bands moved under an unchanged mesh", () => {
    // A lettering change can move a band without moving the frame solid (the
    // pockets are the same shape at a different depth); the shading has to
    // follow it or the recess would be drawn in the wrong place.
    const cache = new RegionGeometryCache();
    const frame = twoLevels();
    const before = cache.reconcile(asMap(frame), [FRAME_BAND], 0.6).regions[0].geometry;
    const after = cache.reconcile(
      asMap(frame),
      [{ region: "frame", kind: "lettering", zMm: [0.5, 2.5] }],
      0.6,
    ).regions[0].geometry;
    expect(after).not.toBe(before);
    cache.dispose();
  });

  it("drops a region the worker removed, and counts the pass", () => {
    const cache = new RegionGeometryCache();
    const base = triangle("base");
    const first = cache.reconcile(asMap(base, twoLevels()), NO_BANDS, 0.6);
    const second = cache.reconcile(asMap(base), NO_BANDS, 0.6);
    expect(second.regions.map((entry) => entry.region)).toEqual(["base"]);
    // The base survived by reference even though the frame went away.
    expect(second.regions[0].geometry).toBe(first.regions[0].geometry);
    expect(second.id).toBeGreaterThan(first.id);
    cache.dispose();
  });

  it("does not count a pass that built nothing, so the on-screen mark is not re-armed for free", () => {
    const cache = new RegionGeometryCache();
    const base = triangle("base");
    const first = cache.reconcile(asMap(base), NO_BANDS, 0.6);
    const again = cache.reconcile(asMap(base), NO_BANDS, 0.6);
    expect(again.id).toBe(first.id);
    cache.dispose();
  });

  it("times each region's build under its own name", () => {
    setPerfEnabled(true);
    const cache = new RegionGeometryCache();
    cache.reconcile(asMap(triangle("base"), twoLevels()), NO_BANDS, 0.6);
    const names = perfDrainTimings().map((span) => span.name);
    expect(names).toContain("preview.region.base");
    expect(names).toContain("preview.region.frame");
    // The old names claimed one whole-model build, and an upload this
    // component never performs.
    expect(names).not.toContain("preview.geometryBuild");
    expect(names).not.toContain("preview.geometry");
    cache.dispose();
  });
});

describe("RegionMeshes", () => {
  it("arms one on-screen mark for the frame that finally renders the meshes", () => {
    setPerfEnabled(true);
    renderToStaticMarkup(
      <RegionMeshes
        regions={asMap(triangle())}
        recessBands={NO_BANDS}
        dimmed={false}
        dimOpacity={0.45}
        recessShade={0.62}
      />,
    );
    expect(loop.callbacks).toHaveLength(1);
    perfDrainTimings();

    loop.callbacks[0]();
    expect(perfDrainTimings().map((span) => span.name)).toEqual(["preview.geometryOnScreen"]);
  });

  it("adds nothing to the render loop with perf mode off", () => {
    setPerfEnabled(false);
    renderToStaticMarkup(
      <RegionMeshes
        regions={asMap(triangle())}
        recessBands={NO_BANDS}
        dimmed={false}
        dimOpacity={0.45}
        recessShade={0.62}
      />,
    );
    expect(loop.callbacks).toHaveLength(0);
    expect(perfDrainTimings()).toEqual([]);
  });
});
