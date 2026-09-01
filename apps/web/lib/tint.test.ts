import { describe, expect, it } from "vitest";

import {
  boundGradientSlots,
  buildingTintMap,
  hashUnit,
  heightBandIndex,
  hslToRgb,
  resolveGradient,
  rgbToHsl,
  tintIsPreviewOnly,
  tintedColor,
} from "./tint";

describe("hashUnit", () => {
  it("is deterministic: same id and seed, same draw", () => {
    expect(hashUnit("way/123", 7)).toBe(hashUnit("way/123", 7));
  });

  it("differs across ids and across seeds", () => {
    expect(hashUnit("way/123", 7)).not.toBe(hashUnit("way/124", 7));
    expect(hashUnit("way/123", 7)).not.toBe(hashUnit("way/123", 8));
  });

  it("always lands in [0, 1)", () => {
    for (const id of ["a", "b", "way/1", "way/999999"]) {
      const v = hashUnit(id, 1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("hsl round trip", () => {
  it("rgbToHsl -> hslToRgb recovers the original within floating error", () => {
    for (const rgb of [
      [1, 0, 0],
      [0.5, 0.3, 0.8],
      [0.1, 0.1, 0.1],
      [1, 1, 1],
      [0, 0, 0],
    ] as Array<[number, number, number]>) {
      const [h, s, l] = rgbToHsl(rgb);
      const back = hslToRgb([h, s, l]);
      for (let i = 0; i < 3; i += 1) expect(back[i]).toBeCloseTo(rgb[i], 5);
    }
  });
});

describe("tintedColor", () => {
  const tint = { enabled: true, hue_range_deg: 12, lightness_range: 0.12, seed: 1 };

  it("is a no-op when tint is disabled", () => {
    expect(tintedColor("way/1", "#D8D3C6", { ...tint, enabled: false })).toBe("#D8D3C6");
  });

  it("is deterministic for the same seed", () => {
    const a = tintedColor("way/1", "#D8D3C6", tint);
    const b = tintedColor("way/1", "#D8D3C6", tint);
    expect(a).toBe(b);
  });

  it("a different seed reshuffles the colour (reroll)", () => {
    const a = tintedColor("way/1", "#D8D3C6", tint);
    const b = tintedColor("way/1", "#D8D3C6", { ...tint, seed: 2 });
    expect(a).not.toBe(b);
  });

  it("different buildings get different tints under the same seed", () => {
    const a = tintedColor("way/1", "#D8D3C6", tint);
    const b = tintedColor("way/2", "#D8D3C6", tint);
    expect(a).not.toBe(b);
  });

  it("stays within the declared hue/lightness range (spot check via HSL)", () => {
    const [h0] = rgbToHsl([0xd8 / 255, 0xd3 / 255, 0xc6 / 255]);
    const result = tintedColor("way/1", "#D8D3C6", { ...tint, hue_range_deg: 5, lightness_range: 0.02 });
    const clean = result.replace("#", "");
    const [h1] = rgbToHsl([
      Number.parseInt(clean.slice(0, 2), 16) / 255,
      Number.parseInt(clean.slice(2, 4), 16) / 255,
      Number.parseInt(clean.slice(4, 6), 16) / 255,
    ]);
    const hueDelta = Math.min(Math.abs(h1 - h0), 360 - Math.abs(h1 - h0));
    expect(hueDelta).toBeLessThanOrEqual(5 + 1e-6);
  });
});

describe("buildingTintMap", () => {
  it("produces one entry per id and is fully deterministic for a given seed", () => {
    const ids = ["a", "b", "c"];
    const tint = { enabled: true, hue_range_deg: 12, lightness_range: 0.12, seed: 42 };
    const first = buildingTintMap(ids, "#D8D3C6", tint);
    const second = buildingTintMap(ids, "#D8D3C6", tint);
    expect(Object.keys(first).sort()).toEqual(ids.slice().sort());
    expect(first).toEqual(second);
  });
});

describe("boundGradientSlots", () => {
  it("clamps the list length to the profile's slot count", () => {
    expect(boundGradientSlots([1, 2, 3, 4, 5], 3)).toHaveLength(3);
  });

  it("clamps each slot value into [1, profileSlots]", () => {
    expect(boundGradientSlots([0, 7, -3], 4)).toEqual([1, 4, 1]);
  });

  it("never exceeds 16 even for an absurd profile", () => {
    expect(boundGradientSlots(new Array(20).fill(1), 999).length).toBeLessThanOrEqual(16);
  });
});

describe("heightBandIndex", () => {
  it("puts the tallest building in the last band", () => {
    expect(heightBandIndex(30, 30, 3)).toBe(2);
  });

  it("puts a zero-height building in the first band", () => {
    expect(heightBandIndex(0, 30, 3)).toBe(0);
  });

  it("degrades to band 0 for a flat scene (maxHeightM <= 0)", () => {
    expect(heightBandIndex(5, 0, 3)).toBe(0);
  });

  it("degrades to band 0 for a single-band gradient", () => {
    expect(heightBandIndex(15, 30, 1)).toBe(0);
  });
});

describe("resolveGradient", () => {
  it("is null when disabled", () => {
    expect(resolveGradient({ enabled: false, slots: [1, 2] }, 4, 30)).toBeNull();
  });

  it("bounds the slot list to the profile and resolves a height to a slot", () => {
    const resolved = resolveGradient({ enabled: true, slots: [1, 2, 3, 4, 5] }, 3, 30);
    expect(resolved).not.toBeNull();
    expect(resolved!.bands).toHaveLength(3);
    expect(resolved!.slotForHeight(30)).toBe(resolved!.bands[2]);
    expect(resolved!.slotForHeight(0)).toBe(resolved!.bands[0]);
  });
});

describe("tintIsPreviewOnly", () => {
  it("is false when tint is off", () => {
    expect(tintIsPreviewOnly({ tint: { enabled: false } }, "bambu-3mf")).toBe(false);
  });

  it("is true for every print export target", () => {
    for (const target of ["bambu-3mf", "generic-3mf", "stl", "stl-parts-zip", "color-change-3mf", "step", undefined]) {
      expect(tintIsPreviewOnly({ tint: { enabled: true } }, target)).toBe(true);
    }
  });

  it("is false for obj, the one target that carries per-instance colour", () => {
    expect(tintIsPreviewOnly({ tint: { enabled: true } }, "obj")).toBe(false);
  });
});
