import { describe, expect, it } from "vitest";

import { FIXED_DATE, sampleResult } from "./fixtures";
import { exportObj } from "./obj";

describe("exportObj", () => {
  // `color_mode: "parts"`, so the file keeps one group per region. In single
  // mode it carries `EngineResult.merged` as one object instead (below).
  const result = sampleResult({ city_label: "Chicago", color_mode: "parts" });
  const files = exportObj(result, { created: FIXED_DATE, stem: "city", source: { lat: 41.88, lon: -87.62 } });
  const obj = new TextDecoder().decode(files[0].bytes);
  const mtl = new TextDecoder().decode(files[1].bytes);
  const lines = obj.split("\n");

  it("returns the OBJ and its MTL", () => {
    expect(files.map((f) => f.name)).toEqual(["city.obj", "city.mtl"]);
    expect(files.map((f) => f.mime)).toEqual(["model/obj", "model/mtl"]);
    expect(obj).toContain("mtllib city.mtl\n");
  });

  it("carries the metadata as header comments", () => {
    expect(lines[0]).toBe("# FrameCraft 3.0.0");
    expect(obj).toContain("# Title: FrameCraft Chicago");
    expect(obj).toContain("# Created: 2026-08-30T12:00:00Z");
    expect(obj).toContain("# © OpenStreetMap contributors, ODbL 1.0");
    expect(obj).toContain("# Source: lat=41.88 lon=-87.62");
    expect(mtl).toContain("# © OpenStreetMap contributors, ODbL 1.0");
  });

  it("writes one o/g/usemtl group per region and every face", () => {
    const groups = lines.filter((l) => l.startsWith("o ")).map((l) => l.slice(2));
    expect(groups).toEqual(["base", "frame", "buildings", "hero_building", "water", "lettering"]);
    expect(lines.filter((l) => l.startsWith("g ")).map((l) => l.slice(2))).toEqual(groups);
    expect(lines.filter((l) => l.startsWith("usemtl ")).map((l) => l.slice(7))).toEqual(groups);
    const faces = lines.filter((l) => l.startsWith("f "));
    expect(faces).toHaveLength(result.regions.reduce((n, r) => n + r.indices.length / 3, 0));
    const vertices = lines.filter((l) => l.startsWith("v "));
    expect(vertices).toHaveLength(result.regions.reduce((n, r) => n + r.positions.length / 3, 0));
    const maxIndex = Math.max(...faces.flatMap((f) => f.slice(2).split(" ").map(Number)));
    const minIndex = Math.min(...faces.flatMap((f) => f.slice(2).split(" ").map(Number)));
    expect(minIndex).toBe(1);
    expect(maxIndex).toBe(vertices.length);
  });

  it("places vertices in build space", () => {
    const xs = lines.filter((l) => l.startsWith("v ")).map((l) => Number(l.split(" ")[1]));
    expect(Math.min(...xs)).toBe(0);
  });

  it("writes a Kd per material from the region colour", () => {
    expect(mtl).toContain("newmtl water\nKd 0.1843 0.498 0.7569\n");
    expect(mtl).toContain("newmtl frame\nKd 0.2275 0.2275 0.2275\n");
    expect((mtl.match(/newmtl /g) ?? []).length).toBe(6);
  });
});
