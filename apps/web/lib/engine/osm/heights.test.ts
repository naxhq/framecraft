import { describe, expect, it } from "vitest";
import {
  classifyCoverage,
  heightRulesFrom,
  jitterFactor,
  parseLengthM,
  parseLevels,
  resolveHeight,
  resolveHeightWith,
  roadClass,
  roadWidthM,
  TYPE_DEFAULT_HEIGHT_M,
} from "./heights";

// Every case below is ported verbatim from
// services/bake/tests/test_ingest.py's parse_length_units /
// test_parse_length_rejects_garbage / resolve_height rule tests, so a
// regression here is a regression against the pinned Python behaviour.

describe("parseLengthM", () => {
  it("parses the units 03 requires", () => {
    const cases: [string, number][] = [
      ["12.5 m", 12.5],
      ["12.5m", 12.5],
      ["12,5 m", 12.5],
      ["15", 15.0],
      ["15.0", 15.0],
      ["41'", 41 * 0.3048],
      ["41'6\"", 41 * 0.3048 + 6 * 0.0254],
      ["135 ft", 135 * 0.3048],
      ["3 metres", 3.0],
      ["450 cm", 4.5],
      ["12;14", 12.0],
    ];
    for (const [text, expected] of cases) {
      expect(parseLengthM(text)).toBeCloseTo(expected, 9);
    }
  });

  it("rejects garbage", () => {
    for (const text of ["", "  ", "tall", "about 12", "-4", "0", null, undefined]) {
      expect(parseLengthM(text)).toBeNull();
    }
  });
});

describe("parseLevels", () => {
  it("parses a plain integer or decimal level count", () => {
    expect(parseLevels("3")).toBe(3);
    expect(parseLevels("2.5")).toBe(2.5);
    expect(parseLevels(4)).toBe(4);
  });

  it("takes the first entry of a multi-valued tag", () => {
    expect(parseLevels("3;4")).toBe(3);
  });

  it("rejects trailing garbage that Python's float() would also reject", () => {
    expect(parseLevels("2 storeys")).toBeNull();
    expect(parseLevels("")).toBeNull();
    expect(parseLevels(null)).toBeNull();
  });
});

describe("resolveHeight (03 height inference order)", () => {
  it("rule 1: the height tag wins", () => {
    const r = resolveHeight({ building: "yes", height: "12.5 m" }, "w1");
    expect(r.heightM).toBeCloseTo(12.5, 9);
    expect(r.heightSource).toBe("tag");
  });

  it("rule 2: building:levels * 3.2, plus roof:height", () => {
    const r = resolveHeight({ building: "yes", "building:levels": "5" }, "w2");
    expect(r.heightM).toBeCloseTo(16.0, 9);
    expect(r.heightSource).toBe("levels");

    const withRoof = resolveHeight({ building: "yes", "building:levels": "5", "roof:height": "2 m" }, "w2b");
    expect(withRoof.heightM).toBeCloseTo(18.0, 9);
  });

  it("rule 3: building:min_level sets min_height_m without changing the source", () => {
    const r = resolveHeight({ building: "yes", height: "30 m", "building:min_level": "2" }, "w3");
    expect(r.heightM).toBeCloseTo(30.0, 9);
    expect(r.heightSource).toBe("tag");
    expect(r.minHeightM).toBeCloseTo(2 * 3.2, 9);
  });

  it("rule 4: per-type default, jittered deterministically by osm id", () => {
    const r = resolveHeight({ building: "church" }, "w4");
    expect(r.heightSource).toBe("default");
    expect(r.heightM).toBeGreaterThan(TYPE_DEFAULT_HEIGHT_M.church * 0.9);
    expect(r.heightM).toBeLessThan(TYPE_DEFAULT_HEIGHT_M.church * 1.1);
    // deterministic: same id, same result
    expect(resolveHeight({ building: "church" }, "w4").heightM).toBe(r.heightM);
  });

  it("rule 5: unknown building type falls back to the global default", () => {
    const r = resolveHeight({ building: "yes" }, "w5");
    expect(r.heightSource).toBe("default");
    expect(r.heightM).toBeGreaterThan(8.0 * 0.9);
    expect(r.heightM).toBeLessThan(8.0 * 1.1);
  });

  it("clamps to [2, 600] meters", () => {
    const tooShort = resolveHeight({ building: "yes", height: "0.5 m" }, "w6");
    expect(tooShort.heightM).toBe(2.0);
    const tooTall = resolveHeight({ building: "yes", height: "9000 m" }, "w7");
    expect(tooTall.heightM).toBe(600.0);
  });

  it("min_height_m never reaches or exceeds height_m", () => {
    const r = resolveHeight({ building: "yes", height: "3 m", "building:min_level": "5" }, "w8");
    expect(r.minHeightM).toBe(0);
  });
});

describe("resolveHeightWith (v3 heights tuning)", () => {
  it("matches resolveHeight at the default rules", () => {
    const defaults = heightRulesFrom(undefined);
    const a = resolveHeight({ building: "house" }, "w9");
    const b = resolveHeightWith({ building: "house" }, "w9", defaults);
    expect(b).toEqual(a);
  });

  it("a custom floor_height_m changes the levels rule", () => {
    const rules = heightRulesFrom({ floor_height_m: 4.0 });
    const r = resolveHeightWith({ building: "yes", "building:levels": "3" }, "w10", rules);
    expect(r.heightM).toBeCloseTo(12.0, 9);
  });

  it("a custom type default overrides the 03 table for that type", () => {
    const rules = heightRulesFrom({ type_defaults: { house: 20 } });
    const r = resolveHeightWith({ building: "house" }, "w11", rules);
    expect(r.heightM).toBeGreaterThan(20 * 0.9);
    expect(r.heightM).toBeLessThan(20 * 1.1);
  });

  it("an unknown_default_m override applies to untabled building types", () => {
    const rules = heightRulesFrom({ unknown_default_m: 15 });
    const r = resolveHeightWith({ building: "yes" }, "w12", rules);
    expect(r.heightM).toBeGreaterThan(15 * 0.9);
    expect(r.heightM).toBeLessThan(15 * 1.1);
  });
});

describe("jitterFactor", () => {
  it("is within +/-6% of 1.0 and deterministic", () => {
    for (const id of ["w1", "w2", "r99", "n1234"]) {
      const f = jitterFactor(id);
      expect(f).toBeGreaterThanOrEqual(0.94);
      expect(f).toBeLessThanOrEqual(1.06);
      expect(jitterFactor(id)).toBe(f);
    }
  });
});

describe("roadWidthM / roadClass", () => {
  it("the width tag wins over lanes and the table", () => {
    expect(roadWidthM({ width: "20 m", lanes: "2" }, "residential")).toBeCloseTo(20, 9);
  });

  it("falls back to lanes * 3.5", () => {
    expect(roadWidthM({ lanes: "4" }, "residential")).toBeCloseTo(14, 9);
  });

  it("falls back to the highway table", () => {
    expect(roadWidthM({}, "motorway")).toBeCloseTo(24, 9);
    expect(roadWidthM({}, "footway")).toBeCloseTo(3, 9);
  });

  it("maps highway tags onto the smaller SceneGraph class enum", () => {
    expect(roadClass("motorway")).toBe("motorway");
    expect(roadClass("trunk")).toBe("motorway");
    expect(roadClass("tertiary")).toBe("secondary");
    expect(roadClass("unclassified")).toBe("residential");
    expect(roadClass("pedestrian")).toBe("path");
  });
});

describe("classifyCoverage", () => {
  it("is empty under 20 buildings", () => {
    expect(classifyCoverage(19, 100000, 1000000)).toBe("empty");
  });

  it("is good at 150+ buildings covering at least 4% of the crop", () => {
    expect(classifyCoverage(150, 40001, 1000000)).toBe("good");
  });

  it("is sparse when the count is high but the footprint share is thin", () => {
    expect(classifyCoverage(200, 1000, 1000000)).toBe("sparse");
  });
});
