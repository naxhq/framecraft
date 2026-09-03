/**
 * What a binary STL can carry, measured on the grid the file actually writes.
 *
 * Two defects survive a double-precision mesh and not a float32 file, and both
 * were found by the nightly export matrix on real plates before they were
 * reduced to the fixtures here:
 *
 * * a NEEDLE whose three vertices are collinear to within a float32 step. The
 *   Chicago plate carries exactly one, a vertical edge at x = 89.9667 mm whose
 *   three x and y agree to 1.8e-6 mm: 6.184e-7 mm^2 in double, which is real
 *   geometry, and zero on a grid whose step there is 7.6e-6 mm.
 * * a PINCH, two distinct vertices on one grid point. Paris, Tokyo and London
 *   each carry one or two, where two building corners meet exactly. No weld can
 *   remove it - it is how a manifold mesh represents a surface touching itself -
 *   so the file is made to say what the mesh says instead.
 *
 * The fixtures are built by hand rather than baked, so every coordinate in the
 * assertions is one this file put there.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  REPAIR_AREA_MM2,
  cleanMesh,
  componentCount,
  degenerateFaces,
  float32Collisions,
  float32DegenerateFaces,
  float32StepMm,
  hardenForFloat32,
  volumeNoiseMm3,
  meshVolumeMm3,
  openEdges,
  separateFloat32Pinches,
  triangleAreaMm2,
  type Mesh,
  type PinchReport,
} from "./mesh";

/** Horizontal offset of the needle's middle vertex, mm. Under half a float32 step at 90 mm. */
const NEEDLE_OFF_MM = 1.8e-6;

/**
 * A unit box with one vertical edge broken by a near-collinear middle vertex.
 *
 * 9 vertices and 14 triangles: the twelve of a box, with the -y face fanned
 * from the middle vertex M and one extra triangle (A, M, A') - the needle - so
 * the mesh stays closed and consistently wound. M sits {@link NEEDLE_OFF_MM}
 * out of the A-A' edge on both horizontal axes, which is real in double and
 * nothing on the float32 grid at a 90 mm coordinate.
 */
function needleBox(originX: number, originY: number): Mesh {
  const off = NEEDLE_OFF_MM;
  const positions = [
    originX, originY, 0, // 0 A
    originX + 1, originY, 0, // 1 B
    originX + 1, originY + 1, 0, // 2 C
    originX, originY + 1, 0, // 3 D
    originX, originY, 1, // 4 A'
    originX + 1, originY, 1, // 5 B'
    originX + 1, originY + 1, 1, // 6 C'
    originX, originY + 1, 1, // 7 D'
    originX + off, originY + off, 0.5, // 8 M
  ];
  const indices = [
    0, 3, 2, 0, 2, 1, // bottom, -z
    4, 5, 6, 4, 6, 7, // top, +z
    0, 1, 8, 1, 5, 8, 5, 4, 8, // -y, fanned from M
    1, 2, 6, 1, 6, 5, // +x
    3, 6, 2, 3, 7, 6, // +y
    0, 4, 7, 0, 7, 3, // -x
    0, 8, 4, // the needle
  ];
  return { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) };
}

/** A closed axis-aligned box, outward wound. */
function box(min: readonly [number, number, number], size: number): Mesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = [x0 + size, y0 + size, z0 + size];
  return {
    positions: Float64Array.from([
      x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
      x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
    ]),
    indices: Uint32Array.from([
      0, 2, 1, 0, 3, 2,
      4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4,
      1, 2, 6, 1, 6, 5,
      2, 3, 7, 2, 7, 6,
      3, 0, 4, 3, 4, 7,
    ]),
  };
}

function concat(a: Mesh, b: Mesh): Mesh {
  const positions = new Float64Array(a.positions.length + b.positions.length);
  positions.set(a.positions, 0);
  positions.set(b.positions, a.positions.length);
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices, 0);
  const base = a.positions.length / 3;
  for (let i = 0; i < b.indices.length; i += 1) indices[a.indices.length + i] = b.indices[i] + base;
  return { positions, indices };
}

describe("the float32 measure", () => {
  const mesh = needleBox(90, 145);

  it("is a closed, oriented mesh whose needle is real geometry in double", () => {
    expect(openEdges(mesh)).toBe(0);
    // The middle vertex chamfers the corner by 6e-7 mm3, which is the whole
    // point: it is real material, not a rounding artefact.
    expect(meshVolumeMm3(mesh)).toBeCloseTo(1, 5);
    expect(1 - meshVolumeMm3(mesh)).toBeCloseTo(6e-7, 12);
    const needle = triangleAreaMm2(mesh.positions, 0, 8, 4);
    expect(needle).toBeGreaterThan(REPAIR_AREA_MM2);
    expect(needle).toBeCloseTo(0.5 * Math.SQRT2 * NEEDLE_OFF_MM, 12);
    expect(degenerateFaces(mesh, REPAIR_AREA_MM2)).toBe(0);
  });

  it("sees the face the double measure cannot, because the file will", () => {
    // Half a float32 step is 3.8e-6 mm at 90 mm and 7.6e-6 mm at 145 mm, so
    // both of M's offsets round away and its three vertices become collinear.
    expect(float32StepMm(90)).toBe(2 ** -23 * 64);
    expect(float32StepMm(145)).toBe(2 ** -23 * 128);
    expect(float32DegenerateFaces(mesh)).toBe(1);
    expect(float32DegenerateFaces(mesh, REPAIR_AREA_MM2)).toBe(1);
  });

  it("is a property of the coordinate, not of the shape", () => {
    // The same box at the origin: one float32 step there is 1.2e-7 mm, so the
    // needle survives the quantisation and nothing needs repairing. This is
    // why the repair runs on the PLACED mesh in the writer and not in the
    // engine, where the plate is centred on (0, 0).
    const near = needleBox(0, 0);
    expect(float32DegenerateFaces(near)).toBe(0);
    expect(float32DegenerateFaces(near, REPAIR_AREA_MM2)).toBe(0);
  });
});

describe("cleanMesh with float32", () => {
  it("leaves the needle alone on the double measure", () => {
    const mesh = needleBox(90, 145);
    const out = cleanMesh(mesh);
    expect(out.mesh).toBe(mesh);
    expect(out.report.split).toBe(0);
    expect(float32DegenerateFaces(out.mesh)).toBe(1);
  });

  it("splits it out on the float32 measure, moving no vertex", () => {
    const mesh = needleBox(90, 145);
    const out = cleanMesh(mesh, { float32: true });
    expect(out.report.split).toBe(1);
    expect(out.report.welded).toBe(0);
    expect(out.report.degenerate).toBe(0);
    expect(out.report.openEdges).toBe(0);
    expect(out.report.applied).toBe(true);
    // A T-junction split retires the needle and the neighbour holding its long
    // edge and puts two triangles in their place, so the count does not move
    // and neither does any coordinate.
    expect(out.mesh.indices.length).toBe(mesh.indices.length);
    expect(Array.from(out.mesh.positions)).toEqual(Array.from(mesh.positions));
    expect(openEdges(out.mesh)).toBe(0);
    // Dropping a needle that is 2.5e-6 mm off its own long edge is not free:
    // 3e-7 mm3, inside `cleanMesh`'s own 1e-6 mm3 acceptance tolerance and
    // four orders under a printed layer.
    expect(Math.abs(meshVolumeMm3(out.mesh) - meshVolumeMm3(mesh))).toBeLessThan(1e-6);
    expect(float32DegenerateFaces(out.mesh)).toBe(0);
    expect(degenerateFaces(out.mesh, REPAIR_AREA_MM2)).toBe(0);
  });
});

describe("separateFloat32Pinches", () => {
  // Two boxes meeting along one vertical edge: four vertices, two grid points.
  const touching = (): Mesh => concat(box([90, 145, 0], 10), box([100, 155, 0], 10));

  it("counts the vertices a float32 reader would lose", () => {
    const mesh = touching();
    expect(mesh.positions.length / 3).toBe(16);
    expect(float32Collisions(mesh)).toBe(2);
    expect(componentCount(mesh)).toBe(2);
  });

  it("gives each one its own grid point, one step into its own material", () => {
    const mesh = touching();
    const out = separateFloat32Pinches(mesh);
    expect(out.report.groups).toBe(2);
    expect(out.report.moved).toBe(2);
    expect(out.report.unresolved).toBe(0);
    expect(out.report.rejected).toBe(0);
    // One step at the largest coordinate the mesh holds (y = 165 mm).
    expect(out.report.maxShiftMm).toBe(float32StepMm(165));
    const moved: Mesh = { positions: out.positions, indices: mesh.indices };
    expect(float32Collisions(moved)).toBe(0);
    // Nothing about the mesh itself changed: same faces, same topology, and a
    // volume that moved by less than a millionth of a cubic millimetre.
    expect(moved.indices).toBe(mesh.indices);
    expect(openEdges(moved)).toBe(0);
    // The move is bounded by a float32 step, so what it costs in volume is that
    // step times the faces the vertex carries - here two corners of a 10 mm
    // cube, 0.001 mm3 of 2000, and on a real plate the faces at a pinch are a
    // fraction of a square millimetre.
    const before = meshVolumeMm3(mesh);
    expect(Math.abs(meshVolumeMm3(moved) - before) / before).toBeLessThan(1e-6);
    // Every vertex moved by at most one step, and only two of them moved.
    let touchedAxes = 0;
    for (let i = 0; i < mesh.positions.length; i += 1) {
      const shift = Math.abs(out.positions[i] - mesh.positions[i]);
      expect(shift).toBeLessThanOrEqual(out.report.maxShiftMm);
      if (shift > 0) touchedAxes += 1;
    }
    expect(touchedAxes).toBe(2);
  });

  it("hands back the mesh's own array when there is nothing to separate", () => {
    const mesh = box([90, 145, 0], 10);
    const out = separateFloat32Pinches(mesh);
    expect(out.positions).toBe(mesh.positions);
    expect(out.report).toEqual({
      groups: 0,
      moved: 0,
      unresolved: 0,
      rejected: 0,
      maxShiftMm: 0,
      volumeDeltaMm3: 0,
    });
  });
});

describe("the TS and Python mirror", () => {
  /**
   * `fixtures/pinch-parity.json` is the ONE fixture both implementations run,
   * and it exists because "they are mirrors" was true only by reading:
   * `DECISIONS.md [V3.1-P7-3]` and both docstrings claim it, and until now each
   * suite built its own two-cube case and asserted magnitudes - how many moved,
   * how far, on how many axes - which a change of direction rule or of
   * survivor rule would sail straight through (v3-07 audit, finding 6).
   *
   * The fixture pins the SIGNED result: which vertex ends up where, to 1e-9 mm.
   * Its twin is `test_a_pinch_moves_to_the_same_place_in_both_engines` in
   * `services/bake/tests/test_bake.py`.
   *
   * Three 10 mm cubes around one vertical column also covers the group of THREE
   * that neither suite reached before, and with it the `PINCH_STEPS` doubling
   * loop: the third member of a group finds the second's new grid point taken
   * and has to step again.
   */
  const here = dirname(fileURLToPath(import.meta.url));
  const fixture = JSON.parse(
    readFileSync(resolve(here, "../../../../../fixtures/pinch-parity.json"), "utf8"),
  ) as {
    positions: number[];
    indices: number[];
    expected: number[];
    report: PinchReport;
    invariants: { collisions_before: number; collisions_after: number; open_edges: number; bodies: number };
  };
  const mesh = (): Mesh => ({
    positions: Float64Array.from(fixture.positions),
    indices: Uint32Array.from(fixture.indices),
  });

  it("moves the same vertices to the same places, to 1e-9 mm", () => {
    const input = mesh();
    expect(float32Collisions(input)).toBe(fixture.invariants.collisions_before);
    const out = separateFloat32Pinches(input);
    expect(out.report).toEqual(fixture.report);
    expect(out.positions).toHaveLength(fixture.expected.length);
    for (let i = 0; i < fixture.expected.length; i += 1) {
      expect(Math.abs(out.positions[i] - fixture.expected[i])).toBeLessThan(1e-9);
    }
    // A group of three: six grid points carried more than one vertex, eight
    // vertices had to move, and the third member of a group had to step twice.
    expect(fixture.report.groups).toBe(6);
    expect(fixture.report.moved).toBe(8);
  });

  it("leaves the topology exactly as it found it", () => {
    const input = mesh();
    const before = { open: openEdges(input), bodies: componentCount(input) };
    const out = separateFloat32Pinches(input);
    const moved: Mesh = { positions: out.positions, indices: input.indices };
    expect(float32Collisions(moved)).toBe(fixture.invariants.collisions_after);
    expect(openEdges(moved)).toBe(before.open);
    expect(componentCount(moved)).toBe(before.bodies);
    expect(openEdges(moved)).toBe(fixture.invariants.open_edges);
    expect(componentCount(moved)).toBe(fixture.invariants.bodies);
    // Which is not luck: both read the INDEX array, and the separation returns
    // the caller's own indices. This is the property the acceptance test relies
    // on instead of recomputing them.
    expect(moved.indices).toBe(input.indices);
  });

  it("accepts a move the relative volume bound alone would reject", () => {
    const input = mesh();
    const out = separateFloat32Pinches(input);
    expect(out.report.rejected).toBe(0);
    const before = meshVolumeMm3(input);
    // 4.069e-3 mm3 against `cleanMesh`'s 3e-6 mm3 noise bound: 1356 times it,
    // and every millimetre of it is one float32 step across faces of 100 mm2.
    expect(Math.abs(out.report.volumeDeltaMm3)).toBeGreaterThan(1000 * volumeNoiseMm3(before));
    const budget = out.report.maxShiftMm * out.report.moved * 3 * 100;
    expect(Math.abs(out.report.volumeDeltaMm3)).toBeLessThan(budget);
  });
});

describe("hardenForFloat32", () => {
  it("closes both defects at once and says so", () => {
    const mesh = concat(needleBox(90, 145), box([100, 155, 0], 10));
    expect(float32DegenerateFaces(mesh)).toBe(1);
    expect(float32Collisions(mesh)).toBe(0);
    const out = hardenForFloat32(mesh);
    expect(out.report.degenerate).toBe(0);
    expect(out.report.collisions).toBe(0);
    expect(out.report.mesh.split).toBe(1);
    expect(openEdges(out.mesh)).toBe(0);
    expect(Math.abs(meshVolumeMm3(out.mesh) - meshVolumeMm3(mesh))).toBeLessThan(1e-6);
  });

  it("is a no-op on a mesh the format can already carry", () => {
    const mesh = box([90, 145, 0], 10);
    const out = hardenForFloat32(mesh);
    expect(out.mesh.indices).toBe(mesh.indices);
    expect(out.mesh.positions).toBe(mesh.positions);
    expect(out.report.pinches.moved).toBe(0);
    expect(out.report.degenerate).toBe(0);
    // The probe answered on its own: no rung of the repair ran at all.
    expect(out.report.probedClean).toBe(true);
    expect(out.report.degenerateBefore).toBe(0);
    expect(out.report.collisionsBefore).toBe(0);
    expect(out.report.mesh.split).toBe(0);
  });
});
