import { describe, expect, it } from "vitest";

import { FIXED_DATE, boxRegion, makeResult, sampleResult } from "./fixtures";
import { STL_HEADER_BYTES, STL_TRIANGLE_BYTES, exportStl, exportStlPartsZip, stlBinary, stlHeaderText } from "./stl";
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
    expect(stlHeaderText("©")).toBe("FrameCraft 3.0.0 | (c) OpenStreetMap contributors | ?");
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
