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
  /**
   * The right-click path reads the canvas element and the camera to raycast on
   * a `contextmenu` event (v3.1 Task 11). `renderToStaticMarkup` never runs
   * effects, so the listener this feeds is never attached and the stub only has
   * to satisfy the two selectors.
   */
  useThree: <T,>(select: (state: { gl: { domElement: EventTarget }; camera: null }) => T): T =>
    select({ gl: { domElement: new EventTarget() }, camera: null }),
}));

import { BufferGeometry, Color } from "three";

import { NO_OWNER, type RecessBand, type RegionMesh } from "@/lib/engine/types";
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
  MATERIAL_IDENTITY,
  isClick,
  isTinted,
  materialColorFor,
  tintMapOf,
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

// ===========================================================================
// Per-building tint (v3-06 audit, finding C1)
// ===========================================================================

/**
 * Three triangles in one buildings region: two owned by `w1`, one by `w2`, plus
 * a fourth the attribution could not place. That is enough to state the claim
 * exactly -- the tinted triangles are the OWNED ones and no others -- which a
 * region with one owner could not.
 */
function ownedBuildings(): RegionMesh {
  const positions: number[] = [];
  for (let t = 0; t < 4; t += 1) {
    positions.push(0, 0, 5, 10, 0, 5, 0, 10, 5);
  }
  return {
    region: "buildings",
    positions: new Float64Array(positions),
    indices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    volumeMm3: 0,
    bbox: { min: [0, 0, 0], max: [10, 10, 5] },
    bodies: 3,
    slot: 2,
    colorHex: "#D8D3C6",
    owners: ["w1", "w2"],
    // triangles 0 and 2 are w1's, triangle 1 is w2's, triangle 3 is nobody's.
    triangleOwner: new Uint32Array([0, 1, 0, NO_OWNER]),
  };
}

const TINTS = new Map([
  ["w1", "#E3A72F"],
  ["w2", "#2F7FC1"],
]);

/** The three RGB values of triangle `t`'s first vertex. */
function triangleColour(geometry: BufferGeometry, t: number): [number, number, number] {
  const colour = geometry.getAttribute("color");
  return [colour.getX(t * 3), colour.getY(t * 3), colour.getZ(t * 3)];
}

/** What three itself would give the material for this hex, in the renderer's working space. */
function working(hex: string): [number, number, number] {
  const colour = new Color(hex);
  return [colour.r, colour.g, colour.b];
}

/**
 * Triangle `t` carries `hex`, times `multiplier`.
 *
 * `toBeCloseTo`, not `toEqual`: the attribute is a `Float32Array` (WebGL takes
 * nothing else) and `Color` works in double, so the stored value is the
 * float32 rounding of the expected one. Six decimals is far tighter than one
 * float32 step at these magnitudes.
 */
function expectColour(
  geometry: BufferGeometry,
  t: number,
  hex: string,
  multiplier = 1,
): void {
  const [r, g, b] = triangleColour(geometry, t);
  const [wr, wg, wb] = working(hex);
  expect(r).toBeCloseTo(wr * multiplier, 6);
  expect(g).toBeCloseTo(wg * multiplier, 6);
  expect(b).toBeCloseTo(wb * multiplier, 6);
}

describe("per-building tint", () => {
  it("colours exactly the owned triangles, each with its own building's colour", () => {
    const mesh = ownedBuildings();
    const geometry = buildGeometry(mesh, NO_BANDS, 0.62, TINTS);
    const position = geometry.getAttribute("position");
    // Expanded, because a vertex colour is per vertex and a shared vertex
    // cannot be two colours.
    expect(position.count).toBe(12);

    expectColour(geometry, 0, "#E3A72F");
    expectColour(geometry, 1, "#2F7FC1");
    expectColour(geometry, 2, "#E3A72F");
    // The unowned triangle keeps the region's own filament colour, so a
    // triangle the attribution could not place is not silently recoloured.
    expectColour(geometry, 3, "#D8D3C6");

    // Every vertex of a triangle carries the same colour.
    const colour = geometry.getAttribute("color");
    for (let t = 0; t < 4; t += 1) {
      const [r, g, b] = triangleColour(geometry, t);
      for (let k = 0; k < 3; k += 1) {
        expect(colour.getX(t * 3 + k)).toBe(r);
        expect(colour.getY(t * 3 + k)).toBe(g);
        expect(colour.getZ(t * 3 + k)).toBe(b);
      }
    }
    geometry.dispose();
  });

  it("moves no coordinate: the tinted geometry is the engine's own triangles", () => {
    const mesh = ownedBuildings();
    const geometry = buildGeometry(mesh, NO_BANDS, 0.62, TINTS);
    const position = geometry.getAttribute("position");
    for (let t = 0; t < 4; t += 1) {
      for (let k = 0; k < 3; k += 1) {
        const from = mesh.indices[t * 3 + k] * 3;
        expect(position.getX(t * 3 + k)).toBeCloseTo(mesh.positions[from], 6);
        expect(position.getY(t * 3 + k)).toBeCloseTo(mesh.positions[from + 1], 6);
        expect(position.getZ(t * 3 + k)).toBeCloseTo(mesh.positions[from + 2], 6);
      }
    }
    geometry.dispose();
  });

  it("hands the material the multiplicative identity, so absolute colours are not scaled twice", () => {
    const mesh = ownedBuildings();
    expect(isTinted(mesh, TINTS)).toBe(true);
    expect(materialColorFor(mesh, TINTS)).toBe(MATERIAL_IDENTITY);
    // It really is (1, 1, 1), in the renderer's own reckoning: a token that
    // moved under `.dark` would scale every building's tint with it.
    const identity = new Color(MATERIAL_IDENTITY);
    expect([identity.r, identity.g, identity.b]).toEqual([1, 1, 1]);
    // Untinted, the region paints in its own filament by the path it always did.
    expect(materialColorFor(mesh, null)).toBe("#D8D3C6");
    expect(materialColorFor(triangle("base"), TINTS)).toBe("#808080");
  });

  it("leaves a region with no tints and a region with no owners exactly as they were", () => {
    // No tints at all: the fast indexed path, no colour attribute.
    const plain = buildGeometry(ownedBuildings(), NO_BANDS, 0.62, null);
    expect(plain.getAttribute("color")).toBeUndefined();
    expect(plain.getIndex()?.count).toBe(12);
    plain.dispose();

    // Tints exist, but this region carries no per-triangle identity to key
    // them by -- every region but the three building ones.
    const base = triangle("base");
    expect(isTinted(base, TINTS)).toBe(false);
    const untouched = buildGeometry(base, NO_BANDS, 0.62, TINTS);
    expect(untouched.getAttribute("color")).toBeUndefined();
    untouched.dispose();

    // Owners exist but none of them is in the tint map (a scene whose tinted
    // buildings were all cropped away).
    const stranger = new Map([["w9", "#E3A72F"]]);
    expect(isTinted(ownedBuildings(), stranger)).toBe(false);
  });

  it("still darkens a recess band, and darkens the tint rather than replacing it", () => {
    // Buildings carry no cuts today, so this combination is theoretical -- but
    // the two effects are independent and must compose, not race.
    const mesh = ownedBuildings();
    const band: RecessBand = { region: "buildings", kind: "lettering", zMm: [4.5, 5.5] };
    const shade = 0.5;
    const geometry = buildGeometry(mesh, [band], shade, TINTS);
    expectColour(geometry, 0, "#E3A72F", shade);
    geometry.dispose();
  });

  it("keys the geometry cache on the tint COLOURS, not on the array it arrived in", () => {
    const cache = new RegionGeometryCache();
    const mesh = ownedBuildings();
    const first = cache.reconcile(asMap(mesh), NO_BANDS, 0.62, TINTS).regions[0].geometry;

    // A new run: a fresh map with identical contents, which is what every
    // rebuild of `EngineResult.buildingTints` produces.
    const same = new Map(TINTS);
    expect(cache.reconcile(asMap(mesh), NO_BANDS, 0.62, same).regions[0].geometry).toBe(first);

    // A reroll: same buildings, different colours.
    const rerolled = new Map([
      ["w1", "#5A9E4B"],
      ["w2", "#2F7FC1"],
    ]);
    const after = cache.reconcile(asMap(mesh), NO_BANDS, 0.62, rerolled).regions[0].geometry;
    expect(after).not.toBe(first);
    expectColour(after, 0, "#5A9E4B");

    // And switching tint off rebuilds back to the plain indexed geometry.
    const off = cache.reconcile(asMap(mesh), NO_BANDS, 0.62, null).regions[0];
    expect(off.geometry).not.toBe(after);
    expect(off.vertexColors).toBe(false);
    expect(off.materialColor).toBe("#D8D3C6");
    cache.dispose();
  });

  it("turns EngineResult.buildingTints into the lookup, and nothing into null", () => {
    expect(tintMapOf(undefined)).toBeNull();
    expect(tintMapOf([])).toBeNull();
    const map = tintMapOf([
      { id: "w1", colorHex: "#E3A72F", centroidMm: [0, 0] },
      { id: "w2", colorHex: "#2F7FC1", centroidMm: [1, 1] },
    ]);
    expect(map?.get("w1")).toBe("#E3A72F");
    expect(map?.get("w2")).toBe("#2F7FC1");
  });
});

// ===========================================================================
// Hero picking off the real solid (v3-06 audit, finding C2)
// ===========================================================================

describe("isClick", () => {
  it("treats a press and release in the same place as a pick", () => {
    expect(isClick({ x: 100, y: 100 }, 100, 100)).toBe(true);
    expect(isClick({ x: 100, y: 100 }, 102, 103)).toBe(true);
  });

  it("treats an orbit drag that happens to end on a building as not a pick", () => {
    expect(isClick({ x: 100, y: 100 }, 140, 160)).toBe(false);
    expect(isClick({ x: 100, y: 100 }, 100, 105)).toBe(false);
  });

  it("accepts a click with no recorded press, so a synthetic click still picks", () => {
    expect(isClick(null, 0, 0)).toBe(true);
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
