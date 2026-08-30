import { describe, expect, it } from "vitest";

import { FIXED_DATE, boxRegion, lShapeRegion, makeResult, sampleResult } from "./fixtures";
import { exportStep, fmtStep, stepCheck, stepString } from "./step";

describe("exportStep", () => {
  // `color_mode: "parts"`, so every region keeps its own shell. In single mode
  // the file carries `EngineResult.merged` as one solid instead (below).
  const result = sampleResult({
    city_label: "Chicago",
    place: { author: "V. A." },
    color_mode: "parts",
  });
  const file = exportStep(result, { created: FIXED_DATE, stem: "city", source: { lat: 41.88, lon: -87.62 } });
  const text = new TextDecoder().decode(file.bytes);

  it("is a Part 21 file with an AP214 schema and balanced references", () => {
    expect(file.name).toBe("city.step");
    expect(file.mime).toBe("model/step");
    const check = stepCheck(text);
    expect(check.hasHeader).toBe(true);
    expect(check.hasTerminator).toBe(true);
    expect(check.unresolved).toEqual([]);
    expect(check.duplicates).toEqual([]);
    expect(check.entities).toBe(file.entities);
    expect(check.references).toBeGreaterThan(check.entities);
    expect(text).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));");
  });

  it("carries author, generator and timestamp in the header", () => {
    expect(text).toContain("FILE_NAME('city.step','2026-08-30T12:00:00Z',('V. A.'),('FrameCraft'),'FrameCraft 3.0.0','FrameCraft 3.0.0','');");
    expect(text).toContain("FrameCraft framed miniature city, faceted B-rep");
    expect(text).toContain("OpenStreetMap contributors, ODbL 1.0");
    expect(text).toContain("'lat=41.88 lon=-87.62'");
  });

  it("writes one PRODUCT, CLOSED_SHELL and MANIFOLD_SOLID_BREP per region", () => {
    const products = text.match(/=PRODUCT\('/g) ?? [];
    expect(products).toHaveLength(6);
    expect(text).toContain("=PRODUCT('buildings','buildings',");
    expect(text).toContain("=PRODUCT('water','water',");
    expect((text.match(/=CLOSED_SHELL\(/g) ?? []).length).toBe(6);
    expect((text.match(/=MANIFOLD_SOLID_BREP\(/g) ?? []).length).toBe(6);
    expect((text.match(/=ADVANCED_BREP_SHAPE_REPRESENTATION\(/g) ?? []).length).toBe(6);
  });

  it("writes ONE solid from the merged mesh in single-colour mode", () => {
    const single = sampleResult({ city_label: "Chicago", color_mode: "single" });
    const out = exportStep(single, { created: FIXED_DATE });
    const t = new TextDecoder().decode(out.bytes);
    expect((t.match(/=PRODUCT\('/g) ?? []).length).toBe(1);
    expect((t.match(/=CLOSED_SHELL\(/g) ?? []).length).toBe(1);
    expect((t.match(/=MANIFOLD_SOLID_BREP\(/g) ?? []).length).toBe(1);
  });

  it("shares vertices and edges: a box has 8 VERTEX_POINTs, 18 EDGE_CURVEs and 12 ADVANCED_FACEs", () => {
    const cube = boxRegion({ region: "base", slot: 1, colorHex: "#D8D3C6", min: [0, 0, 0], size: [10, 10, 10] });
    const out = exportStep(makeResult([cube]), { created: FIXED_DATE });
    const t = new TextDecoder().decode(out.bytes);
    expect((t.match(/=VERTEX_POINT\(/g) ?? []).length).toBe(8);
    expect((t.match(/=EDGE_CURVE\(/g) ?? []).length).toBe(18);
    expect((t.match(/=ADVANCED_FACE\(/g) ?? []).length).toBe(12);
    expect((t.match(/=ORIENTED_EDGE\(/g) ?? []).length).toBe(36);
    expect((t.match(/=PLANE\(/g) ?? []).length).toBe(12);
    expect(out.skippedTriangles).toBe(0);
    expect(out.notes).toEqual([]);
  });

  it("handles the L-shaped prism (20 faces, 12 vertices, 30 edges)", () => {
    const l = lShapeRegion({ region: "frame", slot: 1, colorHex: "#3A3A3A", min: [0, 0, 0], size: [20, 20, 5] });
    const out = exportStep(makeResult([l]), { created: FIXED_DATE });
    const t = new TextDecoder().decode(out.bytes);
    expect((t.match(/=VERTEX_POINT\(/g) ?? []).length).toBe(12);
    expect((t.match(/=EDGE_CURVE\(/g) ?? []).length).toBe(30);
    expect((t.match(/=ADVANCED_FACE\(/g) ?? []).length).toBe(20);
    expect(stepCheck(t).unresolved).toEqual([]);
  });

  it("returns a size note above the triangle limit and none below", () => {
    const small = exportStep(result, { created: FIXED_DATE, triangleWarnLimit: 1000 });
    expect(small.notes).toEqual([]);
    const warned = exportStep(result, { created: FIXED_DATE, triangleWarnLimit: 10 });
    expect(warned.notes).toHaveLength(1);
    expect(warned.notes[0]).toMatch(/faceted B-rep/);
    expect(warned.notes[0]).toMatch(/Above 10 triangles/);
  });

  it("leaves zero-area triangles out and says so", () => {
    const cube = boxRegion({ region: "base", slot: 1, colorHex: "#D8D3C6", min: [0, 0, 0], size: [10, 10, 10] });
    const indices = new Uint32Array([...cube.indices, 0, 0, 1]);
    const out = exportStep(makeResult([{ ...cube, indices }]), { created: FIXED_DATE });
    expect(out.skippedTriangles).toBe(1);
    expect(out.notes.some((n) => n.includes("zero-area"))).toBe(true);
    expect(stepCheck(new TextDecoder().decode(out.bytes)).unresolved).toEqual([]);
  });

  it("formats reals with a decimal point and escapes strings", () => {
    expect(fmtStep(3)).toBe("3.");
    expect(fmtStep(-0.5)).toBe("-0.5");
    expect(fmtStep(0)).toBe("0.");
    expect(stepString("it's")).toBe("'it''s'");
    expect(stepString("a\\b")).toBe("'a\\\\b'");
    expect(stepString("©")).toBe("'\\X2\\00A9\\X0\\'");
  });

  it("stepCheck flags a dangling reference", () => {
    const check = stepCheck("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('X'));\nENDSEC;\nDATA;\n#1=A(#2);\n#3=B(#1);\n#3=C();\nENDSEC;\nEND-ISO-10303-21;\n");
    expect(check.unresolved).toEqual([2]);
    expect(check.duplicates).toEqual([3]);
    expect(check.entities).toBe(2);
  });
});
