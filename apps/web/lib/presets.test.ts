import { describe, expect, it } from "vitest";

import { PRESET_CITY_NAMES, PRESET_ORDER, presetCityName } from "./presets";

describe("PRESET_CITY_NAMES", () => {
  it("names the city alone for every preset in PRESET_ORDER, and no others", () => {
    expect(Object.keys(PRESET_CITY_NAMES).sort()).toEqual([...PRESET_ORDER].sort());
  });

  it("never carries the neighbourhood PRESET_LABELS adds", () => {
    for (const name of Object.values(PRESET_CITY_NAMES)) {
      expect(name).not.toContain(",");
      expect(name).not.toContain("—");
    }
  });

  it("matches the six presets exactly", () => {
    expect(PRESET_CITY_NAMES).toEqual({
      "chicago-loop": "Chicago",
      "new-york-midtown": "New York",
      "paris-eiffel": "Paris",
      "tokyo-shinjuku": "Tokyo",
      "london-city": "London",
      "san-francisco-fidi": "San Francisco",
    });
  });
});

describe("presetCityName", () => {
  it("resolves a known preset id", () => {
    expect(presetCityName("chicago-loop")).toBe("Chicago");
  });

  it("is null for a custom (non-preset) location", () => {
    expect(presetCityName(null)).toBeNull();
    expect(presetCityName(undefined)).toBeNull();
  });

  it("is null for an id the table does not know", () => {
    expect(presetCityName("nowhere")).toBeNull();
  });
});
