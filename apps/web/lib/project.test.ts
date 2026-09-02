/**
 * The `.framecraft.json` project file: round trip, filename, and refusal of
 * anything that is not a well-formed FrameCraft project ([V3-P6]).
 */

import { describe, expect, it } from "vitest";

import { defaultPrintParams } from "./contracts";
import type { LocationState } from "@/store/editor";
import {
  PROJECT_FORMAT,
  PROJECT_VERSION,
  buildProject,
  parseProject,
  projectFilename,
  serializeProject,
} from "./project";

const LOCATION: LocationState = {
  lat: 41.8827,
  lon: -87.6233,
  radius_m: 900,
  rotation_deg: 45,
  preset_id: "chicago-loop",
};

const SAVED_AT = new Date("2026-08-29T12:00:00.000Z");

describe("buildProject / serializeProject", () => {
  it("carries the whole location and the whole PrintParams object", () => {
    const params = { ...defaultPrintParams(), city_label: "Chicago", plate_mm: 200 };
    const project = buildProject(LOCATION, params, SAVED_AT);
    expect(project.format).toBe(PROJECT_FORMAT);
    expect(project.version).toBe(PROJECT_VERSION);
    expect(project.saved_at).toBe("2026-08-29T12:00:00.000Z");
    expect(project.pin).toEqual({ lat: LOCATION.lat, lon: LOCATION.lon });
    expect(project.radius_m).toBe(900);
    expect(project.rotation_deg).toBe(45);
    expect(project.preset_id).toBe("chicago-loop");
    expect(project.place).toBe("Chicago");
    expect(project.params).toEqual(params);
  });

  it("serializes to readable, indented JSON", () => {
    const project = buildProject(LOCATION, defaultPrintParams(), SAVED_AT);
    const text = serializeProject(project);
    expect(text).toContain("\n");
    expect(JSON.parse(text)).toEqual(project);
  });
});

describe("projectFilename", () => {
  it("uses the place name, lower-cased and hyphenated, plus the save date", () => {
    const project = buildProject(
      LOCATION,
      { ...defaultPrintParams(), city_label: "Chicago" },
      SAVED_AT,
    );
    expect(projectFilename(project)).toBe("chicago-2026-08-29.framecraft.json");
  });

  it("falls back to 'framecraft' when there is no place name", () => {
    const project = buildProject(LOCATION, defaultPrintParams(), SAVED_AT);
    expect(projectFilename(project)).toBe("framecraft-2026-08-29.framecraft.json");
  });

  it("strips characters a filesystem would not accept", () => {
    const project = buildProject(
      LOCATION,
      { ...defaultPrintParams(), city_label: "São Paulo / Brazil?" },
      SAVED_AT,
    );
    expect(projectFilename(project)).toMatch(/^s-o-paulo-brazil-2026-08-29\.framecraft\.json$/);
    expect(projectFilename(project)).not.toMatch(/[/\\?]/);
  });
});

describe("parseProject: round trip", () => {
  it("restores exactly the location and params that were saved", () => {
    const params = {
      ...defaultPrintParams(),
      city_label: "Chicago",
      plate_mm: 220,
      frame: true,
      engravings: [{ edge: "bottom" as const, text: "{city}" }],
    };
    const project = buildProject(LOCATION, params, SAVED_AT);
    const decoded = parseProject(serializeProject(project));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.location).toEqual(LOCATION);
    expect(decoded.params).toEqual(params);
  });

  it("restores a null preset id", () => {
    const project = buildProject(
      { ...LOCATION, preset_id: null },
      defaultPrintParams(),
      SAVED_AT,
    );
    const decoded = parseProject(serializeProject(project));
    expect(decoded.ok && decoded.location.preset_id).toBeNull();
  });
});

describe("parseProject: refusals", () => {
  const valid = serializeProject(buildProject(LOCATION, defaultPrintParams(), SAVED_AT));

  it("refuses text that is not JSON", () => {
    const result = parseProject("not json at all {");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not valid JSON");
  });

  it("refuses JSON that is not an object", () => {
    for (const text of ["null", "42", '"hi"', "[1,2,3]"]) {
      const result = parseProject(text);
      expect(result.ok, text).toBe(false);
    }
  });

  it("refuses a file with the wrong or missing format tag", () => {
    for (const format of [undefined, null, "framecraft-scene", 3]) {
      const project = JSON.parse(valid) as Record<string, unknown>;
      project.format = format;
      const result = parseProject(JSON.stringify(project));
      expect(result.ok, String(format)).toBe(false);
      if (!result.ok) expect(result.reason).toContain("not a FrameCraft project");
    }
  });

  it("refuses a version this build does not read, and names it", () => {
    const project = JSON.parse(valid) as Record<string, unknown>;
    project.version = 99;
    const result = parseProject(JSON.stringify(project));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("different version");
      expect(result.reason).toContain("99");
    }
  });

  it("refuses an out-of-range or missing pin, radius or rotation", () => {
    const cases: Array<[string, (p: Record<string, unknown>) => void, string]> = [
      ["missing lat", (p) => delete (p.pin as Record<string, unknown>).lat, "latitude"],
      ["lat out of range", (p) => ((p.pin as Record<string, unknown>).lat = 200), "latitude"],
      ["lon out of range", (p) => ((p.pin as Record<string, unknown>).lon = -200), "longitude"],
      ["radius too small", (p) => (p.radius_m = 1), "radius"],
      ["radius too big", (p) => (p.radius_m = 999999), "radius"],
      ["rotation negative", (p) => (p.rotation_deg = -5), "rotation"],
      ["rotation too big", (p) => (p.rotation_deg = 400), "rotation"],
    ];
    for (const [name, mutate, expectedWord] of cases) {
      const project = JSON.parse(valid) as Record<string, unknown>;
      mutate(project);
      const result = parseProject(JSON.stringify(project));
      expect(result.ok, name).toBe(false);
      if (!result.ok) expect(result.reason, name).toContain(expectedWord);
    }
  });

  it("refuses a settings block with an unknown key, via the same validator a share link uses", () => {
    const project = JSON.parse(valid) as Record<string, unknown>;
    (project.params as Record<string, unknown>).moon_phase = 3;
    const result = parseProject(JSON.stringify(project));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("moon_phase");
  });

  it("refuses a settings value outside the contract's own range", () => {
    const project = JSON.parse(valid) as Record<string, unknown>;
    (project.params as Record<string, unknown>).nozzle_mm = 0;
    const result = parseProject(JSON.stringify(project));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("minimum");
  });

  it("never throws on garbage input", () => {
    for (const text of ["", "{", "{}", "null", "[]", '{"format":"framecraft-project"}']) {
      expect(() => parseProject(text)).not.toThrow();
    }
  });
});
