import { describe, expect, it } from "vitest";

import { APPLICATION } from "./common";
import { DEFAULT_PRINT_PARAMS, FIXED_DATE, makeResult, sampleRegions, sampleResult } from "./fixtures";
import type { RegionMesh } from "../types";
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
    // From `APPLICATION` (`lib/version.ts`), never a literal; see the note in
    // `generic3mf.test.ts`.
    expect(lines[0]).toBe(`# ${APPLICATION}`);
    expect(lines[0]).toMatch(/^# FrameCraft \d+\.\d+\.\d+/);
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

// ---------------------------------------------------------------------------
// v3 phase 5: per-building tint materials
// ---------------------------------------------------------------------------

/** One region mesh holding two disjoint boxes, as a real buildings region does. */
function twoBodyBuildings(): RegionMesh {
  const a = sampleRegions().find((r) => r.region === "buildings")!;
  const positions = new Float64Array(a.positions.length * 2);
  const indices = new Uint32Array(a.indices.length * 2);
  positions.set(a.positions, 0);
  indices.set(a.indices, 0);
  const vertices = a.positions.length / 3;
  for (let i = 0; i < a.positions.length; i += 3) {
    // The second body, 60 mm east of the first.
    positions[a.positions.length + i] = a.positions[i] + 60;
    positions[a.positions.length + i + 1] = a.positions[i + 1];
    positions[a.positions.length + i + 2] = a.positions[i + 2];
  }
  for (let i = 0; i < a.indices.length; i += 1) {
    indices[a.indices.length + i] = a.indices[i] + vertices;
  }
  return { ...a, positions, indices, bodies: 2, volumeMm3: a.volumeMm3 * 2 };
}

describe("exportObj with colour.tint", () => {
  const regions = sampleRegions().map((region) =>
    region.region === "buildings" ? twoBodyBuildings() : region,
  );
  const base = makeResult(regions, { ...DEFAULT_PRINT_PARAMS, color_mode: "parts" });
  const options = { created: FIXED_DATE, stem: "city" };

  it("leaves the file exactly as it was when the tint is off", () => {
    const plain = exportObj(base, options);
    const again = exportObj({ ...base, buildingTints: [] }, options);
    expect(again[0].bytes).toEqual(plain[0].bytes);
    expect(again[1].bytes).toEqual(plain[1].bytes);
  });

  it("splits the buildings into one group per body and one material per tint", () => {
    const tinted = exportObj(
      {
        ...base,
        buildingTints: [
          { id: "near", colorHex: "#AA0000", centroidMm: [-12.5, -12.5] },
          { id: "far", colorHex: "#00AA00", centroidMm: [47.5, -12.5] },
        ],
      },
      options,
    );
    const obj = new TextDecoder().decode(tinted[0].bytes);
    const mtl = new TextDecoder().decode(tinted[1].bytes);
    const groups = obj.split("\n").filter((l) => l.startsWith("o ")).map((l) => l.slice(2));
    expect(groups).toContain("buildings_1");
    expect(groups).toContain("buildings_2");
    expect(groups).not.toContain("buildings");
    // Every OTHER region is untouched.
    expect(groups).toContain("base");
    expect(groups).toContain("hero_building");
    // Each body took the tint of the building nearest it, in its own material.
    expect(mtl).toContain("newmtl buildings_tint_1\nKd 0.6667 0 0\n");
    expect(mtl).toContain("newmtl buildings_tint_2\nKd 0 0.6667 0\n");
    // The triangle count is unchanged: this is a regrouping, not a remesh.
    const faces = obj.split("\n").filter((l) => l.startsWith("f "));
    expect(faces).toHaveLength(regions.reduce((n, r) => n + r.indices.length / 3, 0));
  });
});
