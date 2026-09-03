import { describe, expect, it } from "vitest";

import { REGION_NAMES } from "../types";
import { APPLICATION, ATTRIBUTION } from "./common";
import { FIXED_DATE, boxRegion, makeResult, sampleRegions, sampleResult } from "./fixtures";
import { CONTENT_TYPES_PART, CORE_NAMESPACE, MODEL_PART, RELS_PART, exportGeneric3mf } from "./generic3mf";
import { findAll, findFirst, parseXml } from "./xmlParse";
import { unzipAll, unzipText } from "./zip";

const IDENTITY = "1 0 0 0 1 0 0 0 1 0 0 0";

describe("exportGeneric3mf (parts)", () => {
  const result = sampleResult({ color_mode: "parts" });
  const file = exportGeneric3mf(result, {
    created: FIXED_DATE,
    stem: "sample",
    source: { lat: 41.8827, lon: -87.6233, radius_m: 900, rotation_deg: 0, preset_id: "chicago-loop" },
  });
  const model = parseXml(unzipText(file.bytes, MODEL_PART));

  it("writes exactly the three OPC parts, in order", () => {
    expect(file.name).toBe("sample.3mf");
    expect(file.mime).toBe("model/3mf");
    expect([...unzipAll(file.bytes).keys()]).toEqual([CONTENT_TYPES_PART, RELS_PART, MODEL_PART]);
    expect(unzipText(file.bytes, CONTENT_TYPES_PART)).toContain('Extension="model"');
    expect(unzipText(file.bytes, RELS_PART)).toContain(`Target="/${MODEL_PART}"`);
  });

  it("declares millimetres and the core namespace", () => {
    expect(model.name).toBe("model");
    expect(model.attributes.unit).toBe("millimeter");
    expect(model.attributes.xmlns).toBe(CORE_NAMESPACE);
  });

  it("carries one basematerial per region with the region colour as #RRGGBBAA", () => {
    const groups = findAll(model, "basematerials");
    expect(groups).toHaveLength(1);
    const bases = groups[0].children.filter((c) => c.name === "base");
    expect(bases.map((b) => b.attributes.name)).toEqual(["base", "frame", "buildings", "hero_building", "water", "lettering"]);
    expect(bases.map((b) => b.attributes.displaycolor)).toEqual(["#D8D3C6FF", "#3A3A3AFF", "#D8D3C6FF", "#E3A72FFF", "#2F7FC1FF", "#E3A72FFF"]);
  });

  it("has one mesh object per region pointing at its material and one assembly", () => {
    const objects = findAll(model, "object");
    const meshes = objects.filter((o) => findFirst(o, "mesh"));
    const assemblies = objects.filter((o) => findFirst(o, "components"));
    expect(meshes).toHaveLength(6);
    expect(assemblies).toHaveLength(1);
    meshes.forEach((o, index) => {
      expect(o.attributes.pid).toBe("1");
      expect(o.attributes.pindex).toBe(String(index));
      expect(o.attributes.type).toBe("model");
    });
    const components = findAll(assemblies[0], "component");
    expect(components.map((c) => c.attributes.objectid)).toEqual(meshes.map((m) => m.attributes.id));
    components.forEach((c) => expect(c.attributes.transform).toBe(IDENTITY));
  });

  it("builds the assembly exactly once with an identity transform", () => {
    const items = findAll(model, "item");
    expect(items).toHaveLength(1);
    const assembly = findAll(model, "object").find((o) => findFirst(o, "components"));
    expect(items[0].attributes.objectid).toBe(assembly?.attributes.id);
    expect(items[0].attributes.transform).toBe(IDENTITY);
  });

  it("declares every vertex and triangle of every region", () => {
    const vertices = findAll(model, "vertex").length;
    const triangles = findAll(model, "triangle").length;
    expect(vertices).toBe(result.regions.reduce((n, r) => n + r.positions.length / 3, 0));
    expect(triangles).toBe(result.regions.reduce((n, r) => n + r.indices.length / 3, 0));
  });

  it("sits at positive XY with z from 0", () => {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const v of findAll(model, "vertex")) {
      minX = Math.min(minX, Number(v.attributes.x));
      minY = Math.min(minY, Number(v.attributes.y));
      minZ = Math.min(minZ, Number(v.attributes.z));
      maxZ = Math.max(maxZ, Number(v.attributes.z));
    }
    expect(minX).toBe(0);
    expect(minY).toBe(0);
    expect(minZ).toBe(0);
    expect(maxZ).toBe(48);
  });

  it("writes the reserved metadata plus the framecraft entries", () => {
    const meta = new Map(findAll(model, "metadata").map((m) => [m.attributes.name, m.text]));
    expect(meta.get("Title")).toBe("FrameCraft");
    expect(meta.get("Designer")).toBe("FrameCraft");
    /*
      Asserted against `APPLICATION` rather than a typed literal, and against
      its SHAPE beside it. The literal used to be "FrameCraft 3.0.0" here and
      in three other files, which is how the exporters went on stamping 3.0.0
      after the product became 3.1.0. The shape assertion is what keeps this
      from degenerating into "the writer agrees with itself": it fails if the
      version stops resolving at all, or stops being a version.
    */
    expect(meta.get("Application")).toBe(APPLICATION);
    expect(meta.get("Application")).toMatch(/^FrameCraft \d+\.\d+\.\d+/);
    expect(meta.get("CreationDate")).toBe("2026-08-30");
    expect(meta.get("Copyright")).toBe(ATTRIBUTION);
    expect(meta.get("Description")).toContain(ATTRIBUTION);
    expect(meta.get("Description")).toContain("lat=41.8827 lon=-87.6233 radius_m=900 rotation_deg=0 preset_id=chicago-loop");
    expect(meta.get("Description")).toContain('"plate_mm":180');
    expect(meta.get("framecraft:attribution")).toBe(ATTRIBUTION);
    expect(meta.get("framecraft:lat")).toBe("41.8827");
    expect(meta.get("framecraft:lon")).toBe("-87.6233");
    expect(meta.get("framecraft:preset_id")).toBe("chicago-loop");
    expect(meta.get("framecraft:scale")).toBe("1:10000");
    expect(model.attributes["xmlns:framecraft"]).toBeTruthy();
  });

  it("names the title after the city label", () => {
    const labelled = exportGeneric3mf(sampleResult({ color_mode: "parts", city_label: "Chicago" }), { created: FIXED_DATE });
    const meta = new Map(findAll(parseXml(unzipText(labelled.bytes, MODEL_PART)), "metadata").map((m) => [m.attributes.name, m.text]));
    expect(meta.get("Title")).toBe("FrameCraft Chicago");
    expect(labelled.name).toBe("framecraft.3mf");
  });

  it("is byte-for-byte reproducible with a fixed creation date", () => {
    const again = exportGeneric3mf(result, { created: FIXED_DATE, stem: "sample", source: { lat: 41.8827, lon: -87.6233, radius_m: 900, rotation_deg: 0, preset_id: "chicago-loop" } });
    expect([...again.bytes]).toEqual([...file.bytes]);
  });

  it("orders regions by REGION_NAMES whatever order the engine used", () => {
    const shuffled = [...sampleRegions()].reverse();
    const out = exportGeneric3mf(makeResult(shuffled, { ...sampleResult().params, color_mode: "parts" }), { created: FIXED_DATE });
    const names = findAll(parseXml(unzipText(out.bytes, MODEL_PART)), "base").map((b) => b.attributes.name);
    const order = names.map((n) => REGION_NAMES.indexOf(n as (typeof REGION_NAMES)[number]));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("exportGeneric3mf (single)", () => {
  it("merges every region into one object with one build item and no materials", () => {
    const file = exportGeneric3mf(sampleResult({ color_mode: "single" }), { created: FIXED_DATE });
    const model = parseXml(unzipText(file.bytes, MODEL_PART));
    expect(findAll(model, "object")).toHaveLength(1);
    expect(findAll(model, "basematerials")).toHaveLength(0);
    expect(findAll(model, "components")).toHaveLength(0);
    expect(findAll(model, "item")).toHaveLength(1);
    expect(findAll(model, "item")[0].attributes.objectid).toBe("1");
    const regions = sampleRegions();
    expect(findAll(model, "vertex")).toHaveLength(regions.reduce((n, r) => n + r.positions.length / 3, 0));
    expect(findAll(model, "triangle")).toHaveLength(regions.reduce((n, r) => n + r.indices.length / 3, 0));
  });

  it("follows color_mode by default and the mode option when given", () => {
    const byParams = exportGeneric3mf(sampleResult({ color_mode: "single" }), { created: FIXED_DATE });
    expect(findAll(parseXml(unzipText(byParams.bytes, MODEL_PART)), "object")).toHaveLength(1);
    const forced = exportGeneric3mf(sampleResult({ color_mode: "single" }), { created: FIXED_DATE, mode: "parts" });
    expect(findAll(parseXml(unzipText(forced.bytes, MODEL_PART)), "object")).toHaveLength(7);
  });

  it("offsets merged indices so every triangle stays inside the merged vertex range", () => {
    const a = boxRegion({ region: "base", slot: 1, colorHex: "#D8D3C6", min: [0, 0, 0], size: [10, 10, 2] });
    const b = boxRegion({ region: "buildings", slot: 2, colorHex: "#FFFFFF", min: [2, 2, 2], size: [4, 4, 6] });
    const file = exportGeneric3mf(makeResult([a, b], { ...sampleResult().params, color_mode: "single" }), { created: FIXED_DATE });
    const model = parseXml(unzipText(file.bytes, MODEL_PART));
    const vertexCount = findAll(model, "vertex").length;
    expect(vertexCount).toBe(16);
    const maxIndex = Math.max(...findAll(model, "triangle").flatMap((t) => [Number(t.attributes.v1), Number(t.attributes.v2), Number(t.attributes.v3)]));
    expect(maxIndex).toBe(15);
  });

  it("refuses an empty model", () => {
    expect(() => exportGeneric3mf(makeResult([], sampleResult().params), { mode: "parts" })).toThrow(/at least one region/);
  });
});
