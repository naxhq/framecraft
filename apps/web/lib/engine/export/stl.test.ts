import { describe, expect, it } from "vitest";

import {
  DEGENERATE_AREA_MM2,
  REPAIR_AREA_MM2,
  degenerateFaces,
  float32Collisions,
  float32DegenerateFaces,
  triangleAreaMm2,
  type HardenReport,
} from "../solid/mesh";
import type { RegionMesh } from "../types";
import { APPLICATION } from "./common";
import { FIXED_DATE, boxRegion, makeResult, sampleResult } from "./fixtures";
import { STAGE_4_FINDING_IDS, blockingFindings } from "./gate";
import {
  FLOAT32_FINDING_ID,
  STL_HEADER_BYTES,
  STL_TRIANGLE_BYTES,
  exportStl,
  exportStlPartsZip,
  float32Findings,
  stlBinary,
  stlHeaderText,
} from "./stl";
import { bytesToText, unzipAll } from "./zip";

describe("exportStl", () => {
  const result = sampleResult();
  const file = exportStl(result, { created: FIXED_DATE, stem: "city" });
  const triangles = result.regions.reduce((n, r) => n + r.indices.length / 3, 0);

  it("is 84 + 50 * triangles bytes", () => {
    expect(file.name).toBe("city.stl");
    expect(file.mime).toBe("model/stl");
    expect(file.bytes.length).toBe(STL_HEADER_BYTES + 4 + triangles * STL_TRIANGLE_BYTES);
    expect(new DataView(file.bytes.buffer, file.bytes.byteOffset).getUint32(80, true)).toBe(triangles);
  });

  it("carries an ASCII header that does not start with 'solid'", () => {
    const header = new TextDecoder().decode(file.bytes.slice(0, 80)).replace(/\0+$/, "");
    expect(header.startsWith("solid")).toBe(false);
    expect(header).toContain("(c) OpenStreetMap contributors");
    expect(stlHeaderText("x".repeat(200))).toHaveLength(80);
    // From `APPLICATION` (`lib/version.ts`), never a literal; see the note in
    // `generic3mf.test.ts`. The 80-byte cap above still holds whatever the
    // version's length, which is the property this header actually risks.
    expect(stlHeaderText("©")).toBe(`${APPLICATION} | (c) OpenStreetMap contributors | ?`);
    expect(stlHeaderText("©")).toMatch(/^FrameCraft \d+\.\d+\.\d+/);
    expect(stlHeaderText("©")).toContain(" | (c) OpenStreetMap contributors | ");
  });

  it("writes outward unit normals and build-space vertices", () => {
    const cube = boxRegion({ region: "base", slot: 1, colorHex: "#D8D3C6", min: [-5, -5, 0], size: [10, 10, 10] });
    const out = exportStl(makeResult([cube]), { created: FIXED_DATE });
    const view = new DataView(out.bytes.buffer, out.bytes.byteOffset);
    const normals: number[][] = [];
    let minX = Infinity;
    for (let t = 0; t < 12; t += 1) {
      const o = 84 + t * 50;
      normals.push([view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)]);
      for (let v = 0; v < 3; v += 1) minX = Math.min(minX, view.getFloat32(o + 12 + v * 12, true));
      expect(view.getUint16(o + 48, true)).toBe(0);
    }
    expect(minX).toBe(0);
    for (const n of normals) expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 6);
    expect(normals.filter((n) => n[2] < -0.99)).toHaveLength(2);
    expect(normals.filter((n) => n[2] > 0.99)).toHaveLength(2);
  });

  it("zeroes the normal of a degenerate triangle", () => {
    const bytes = stlBinary(new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]), new Uint32Array([0, 1, 2]), "x");
    const view = new DataView(bytes.buffer);
    expect([view.getFloat32(84, true), view.getFloat32(88, true), view.getFloat32(92, true)]).toEqual([0, 0, 0]);
  });

  it("refuses an index beyond the vertex count", () => {
    expect(() => stlBinary(new Float32Array([0, 0, 0]), new Uint32Array([0, 1, 2]), "x")).toThrow(/beyond/);
  });
});

describe("exportStlPartsZip", () => {
  it("zips one STL per region plus CREDITS.txt", () => {
    const result = sampleResult();
    const file = exportStlPartsZip(result, { created: FIXED_DATE, stem: "city" });
    expect(file.name).toBe("city-parts.zip");
    expect(file.mime).toBe("application/zip");
    const entries = unzipAll(file.bytes);
    expect([...entries.keys()]).toEqual([
      "city-01-base-slot1.stl",
      "city-02-frame-slot1.stl",
      "city-03-buildings-slot2.stl",
      "city-04-hero_building-slot4.stl",
      "city-05-water-slot3.stl",
      "city-06-lettering-slot4.stl",
      "CREDITS.txt",
    ]);
    for (const region of result.regions) {
      const name = [...entries.keys()].find((k) => k.includes(`-${region.region}-`)) as string;
      expect(entries.get(name)?.length).toBe(84 + (region.indices.length / 3) * 50);
    }
    expect(bytesToText(entries.get("CREDITS.txt") as Uint8Array)).toContain("© OpenStreetMap contributors");
  });
});

/**
 * The file as `services/bake/app/cli.py` reads it before judging it: a binary
 * STL is a triangle soup, so the validator recovers the vertex index by welding
 * the identical float32 rows (`_index_stl_triangle_soup`, bitwise, never a
 * tolerance). Everything below asks its questions of THAT mesh, which is the
 * only one the `manifold`, `watertight`, `self_intersection` and
 * `degenerate_faces` rows ever see.
 */
function readWelded(bytes: Uint8Array): { vertices: number; faces: number; worstEdge: number; degenerate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const faces = view.getUint32(STL_HEADER_BYTES, true);
  const ids = new Map<string, number>();
  const points: number[] = [];
  const tris: number[] = [];
  for (let t = 0; t < faces; t += 1) {
    const base = STL_HEADER_BYTES + 4 + t * STL_TRIANGLE_BYTES + 12;
    for (let corner = 0; corner < 3; corner += 1) {
      const o = base + corner * 12;
      const xyz = [view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)];
      const key = xyz.join(",");
      let id = ids.get(key);
      if (id === undefined) {
        id = points.length / 3;
        ids.set(key, id);
        points.push(xyz[0], xyz[1], xyz[2]);
      }
      tris.push(id);
    }
  }
  const perEdge = new Map<string, number>();
  let degenerate = 0;
  for (let t = 0; t < faces; t += 1) {
    const [a, b, c] = [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]];
    if (triangleAreaMm2(points, a, b, c) < DEGENERATE_AREA_MM2) degenerate += 1;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      perEdge.set(key, (perEdge.get(key) ?? 0) + 1);
    }
  }
  let worstEdge = 0;
  for (const count of perEdge.values()) worstEdge = Math.max(worstEdge, count);
  return { vertices: points.length / 3, faces, worstEdge, degenerate };
}

describe("what the file itself can carry", () => {
  it("keeps two vertices apart that the format would otherwise weld into one", () => {
    // Two blocks meeting along one vertical edge - two building corners that
    // touch exactly, which is what Paris, Tokyo and London each carry one or
    // two of. The mesh keeps the four vertices apart; float32 rounding does
    // not, and the weld hands the shared edge to four faces.
    const a = boxRegion({ region: "buildings", slot: 2, colorHex: "#D8D3C6", min: [0, 0, 0], size: [10, 10, 5] });
    const b = boxRegion({ region: "buildings", slot: 2, colorHex: "#D8D3C6", min: [10, 10, 0], size: [10, 10, 5] });
    const result = makeResult([a, b]);
    expect(float32Collisions({ positions: result.merged.positions, indices: result.merged.indices })).toBe(2);

    const written = readWelded(exportStl(result, { created: FIXED_DATE }).bytes);
    expect(written.faces).toBe(24);
    expect(written.vertices).toBe(16);
    expect(written.worstEdge).toBe(2);
    expect(written.degenerate).toBe(0);
  });

  it("removes the sliver float32 collapses, and leaves the mesh closed", () => {
    // One needle whose three vertices are collinear to within a float32 step:
    // the shape of the single face the Chicago plate's STL failed on. The
    // anchor holds the build-space origin at (0, 0) so the needle keeps the
    // 90 mm coordinate where the grid is coarse enough to swallow it.
    const anchor = boxRegion({ region: "base", slot: 1, colorHex: "#D8D3C6", min: [0, 0, 0], size: [1, 1, 1] });
    const off = 1.8e-6;
    const needle: RegionMesh = {
      ...anchor,
      region: "buildings",
      slot: 2,
      positions: Float64Array.from([
        90, 145, 0, 91, 145, 0, 91, 146, 0, 90, 146, 0,
        90, 145, 1, 91, 145, 1, 91, 146, 1, 90, 146, 1,
        90 + off, 145 + off, 0.5,
      ]),
      indices: Uint32Array.from([
        0, 3, 2, 0, 2, 1,
        4, 5, 6, 4, 6, 7,
        0, 1, 8, 1, 5, 8, 5, 4, 8,
        1, 2, 6, 1, 6, 5,
        3, 6, 2, 3, 7, 6,
        0, 4, 7, 0, 7, 3,
        0, 8, 4,
      ]),
      bbox: { min: [90, 145, 0], max: [91, 146, 1] },
      volumeMm3: 1,
    };
    const result = makeResult([anchor, needle]);
    const merged = { positions: result.merged.positions, indices: result.merged.indices };
    expect(degenerateFaces(merged, REPAIR_AREA_MM2)).toBe(0);
    expect(float32DegenerateFaces(merged)).toBe(1);

    const written = readWelded(exportStl(result, { created: FIXED_DATE }).bytes);
    expect(written.degenerate).toBe(0);
    expect(written.worstEdge).toBe(2);
    // The split trades two triangles for two: the count does not move.
    expect(written.faces).toBe(merged.indices.length / 3);
  });

  it("says nothing when the file carries everything", () => {
    const file = exportStl(sampleResult(), { created: FIXED_DATE });
    expect(file.findings).toEqual([]);
    expect(exportStlPartsZip(sampleResult(), { created: FIXED_DATE }).findings).toEqual([]);
  });
});

describe("what the file could not carry, said out loud", () => {
  /**
   * The repair is BEST EFFORT - `cleanMesh` hands back the input untouched
   * whenever no rung strictly improves the count - and before this the writer
   * threw its report away, so a plate the repair could not fix shipped with no
   * word anywhere (v3-07 audit, finding 1). Measured on `plate_mm` 256, the
   * largest legal plate: 12 faces the float32 file cannot carry, 6 the double
   * mesh already fails on, `make validate` red on both files, and the writer
   * silent.
   *
   * The message is asserted on hand-built reports rather than by baking a
   * 256 mm plate in a unit test: `hardenForFloat32` returns the report, so what
   * is left to pin here is the sentence and the id, and the plate itself is
   * covered end to end by `scripts/ci-export-matrix.sh`.
   */
  const clean: HardenReport = {
    mesh: { welded: 0, split: 0, degenerate: 0, openEdges: 0, volumeDeltaMm3: 0, applied: true },
    pinches: { groups: 0, moved: 0, unresolved: 0, rejected: 0, maxShiftMm: 0, volumeDeltaMm3: 0 },
    degenerate: 0,
    collisions: 0,
    degenerateBefore: 0,
    collisionsBefore: 0,
    probedClean: true,
  };

  it("is silent on a clean report", () => {
    expect(float32Findings(clean, "STL")).toEqual([]);
  });

  it("names the count, the target and what the repair did clear", () => {
    const report: HardenReport = {
      ...clean,
      mesh: { welded: 0, split: 0, degenerate: 71, openEdges: 0, volumeDeltaMm3: 0, applied: false },
      degenerate: 12,
      degenerateBefore: 26,
      probedClean: false,
    };
    const findings = float32Findings(report, "STL");
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe(FLOAT32_FINDING_ID);
    // A warning, not an error: the reference validator already judges this row,
    // and `export/gate.ts`'s blocking list is deliberately untouched.
    expect(findings[0].severity).toBe("warning");
    expect(STAGE_4_FINDING_IDS).not.toContain(FLOAT32_FINDING_ID);
    expect(blockingFindings(findings)).toEqual([]);
    expect(findings[0].title).toContain("STL");
    expect(findings[0].detail).toContain("12 face(s)");
    expect(findings[0].detail).toContain("26 before the repair, which cleared 14");
    // ... and it does not claim a repair it did not make: plate 256 clears none.
    const stuck = float32Findings({ ...report, degenerateBefore: 12, degenerate: 12 }, "STL");
    expect(stuck[0].detail).toContain("the repair could not clear any of them");
    expect(stuck[0].detail).not.toContain("before the repair");
  });

  it("reports a pinch it could not place or had to roll back", () => {
    const findings = float32Findings(
      {
        ...clean,
        pinches: { groups: 3, moved: 1, unresolved: 1, rejected: 1, maxShiftMm: 1e-5, volumeDeltaMm3: 0 },
        collisions: 2,
        collisionsBefore: 3,
        probedClean: false,
      },
      "STL",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain("2 vertex/vertices share a grid point");
    expect(findings[0].detail).toContain("1 separation(s) were rolled back");
    expect(findings[0].detail).toContain("1 found no free grid point");
  });
});
