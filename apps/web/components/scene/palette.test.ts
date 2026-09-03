/**
 * The preview palette: read from the design tokens, cached per theme.
 *
 * Two things are worth pinning. First, the canvas must take its colours from
 * `app/globals.css` like everything else, or the 3D view is the one surface
 * that silently keeps a hard-coded palette (which is exactly what it used to
 * do). Second, the cache: `getComputedStyle` flushes pending style work, so it
 * runs once per theme rather than on every render that touches the canvas --
 * and it must never memoise a read taken before the stylesheet arrived, or the
 * fallback colour would be pinned for the whole session.
 *
 * The module keeps its cache at module scope, so every test re-imports it
 * through `vi.resetModules()` to get a clean one.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const TOKENS: Record<string, Record<string, string>> = {
  light: {
    "--fc-preview-bg": "#e5e0d4",
    "--fc-preview-base": "#d8d3c6",
    "--fc-preview-frame": "#6b6558",
    "--fc-preview-building": "#ede8db",
    "--fc-preview-road": "#8c8579",
    "--fc-preview-water": "#2f7fc1",
    "--fc-preview-green": "#5a9e4b",
    "--fc-preview-tree": "#47803b",
    "--fc-preview-grid": "#c6bfae",
    "--fc-preview-hero": "#e3a72f",
    "--fc-preview-hero-pick": "#7d8794",
    "--fc-preview-cursor": "#1f5e93",
    "--fc-preview-text-engraved": "#3f3a32",
    "--fc-preview-text-embossed": "#a8a08a",
    "--fc-preview-pocket": "#7c7668",
    "--fc-preview-sky": "#ffffff",
    "--fc-preview-bounce": "#445566",
    "--fc-preview-tile-line": "#c2661a",
  },
  dark: {
    "--fc-preview-bg": "#0e0d0b",
    "--fc-preview-base": "#3a3730",
    "--fc-preview-frame": "#565146",
    "--fc-preview-building": "#c9c2b0",
    "--fc-preview-road": "#6e685c",
    "--fc-preview-water": "#2f7fc1",
    "--fc-preview-green": "#4a7f3e",
    "--fc-preview-tree": "#6fa35f",
    "--fc-preview-grid": "#2a2721",
    "--fc-preview-hero": "#e3a72f",
    "--fc-preview-hero-pick": "#93a0b0",
    "--fc-preview-cursor": "#8cc5f0",
    "--fc-preview-text-engraved": "#26231e",
    "--fc-preview-text-embossed": "#9a9280",
    "--fc-preview-pocket": "#211f1a",
    "--fc-preview-sky": "#dfe6ee",
    "--fc-preview-bounce": "#232a33",
    "--fc-preview-tile-line": "#e08a3e",
  },
};

/** How many times the code under test asked the DOM for the computed style. */
let reads = 0;
/** Which theme the fake `<html>` is currently carrying. */
let active = "light";
/** When true, the stylesheet has not loaded and every property is "". */
let unstyled = false;

function stubDom(): void {
  const getComputedStyle = () => {
    reads += 1;
    return {
      getPropertyValue: (name: string) =>
        unstyled ? "" : ` ${TOKENS[active][name] ?? ""} `,
    };
  };
  vi.stubGlobal("window", { getComputedStyle });
  vi.stubGlobal("document", { documentElement: {} });
}

async function load() {
  vi.resetModules();
  return import("./palette");
}

beforeEach(() => {
  reads = 0;
  active = "light";
  unstyled = false;
  stubDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readPreviewPalette", () => {
  it("reads every slot off the token custom properties, trimmed", () => {
    // `getPropertyValue` returns the declaration verbatim, leading space and
    // all; an untrimmed value is not a colour three.js will accept.
    return load().then(({ readPreviewPalette }) => {
      const palette = readPreviewPalette("light");
      expect(palette.background).toBe("#e5e0d4");
      expect(palette.base).toBe("#d8d3c6");
      expect(palette.building).toBe("#ede8db");
      expect(palette.hero).toBe("#e3a72f");
      expect(Object.values(palette).every((value) => value.trim() === value)).toBe(
        true,
      );
    });
  });

  it("asks the DOM once per theme, not once per render", async () => {
    const { readPreviewPalette } = await load();
    readPreviewPalette("light");
    readPreviewPalette("light");
    readPreviewPalette("light");
    expect(reads).toBe(1);
  });

  it("re-reads when the theme changes, and remembers both", async () => {
    const { readPreviewPalette } = await load();
    const light = readPreviewPalette("light");

    active = "dark";
    const dark = readPreviewPalette("dark");
    expect(reads).toBe(2);
    expect(dark.background).toBe("#0e0d0b");
    expect(dark.background).not.toBe(light.background);

    // Both stay cached.
    readPreviewPalette("dark");
    active = "light";
    expect(readPreviewPalette("light")).toEqual(light);
    expect(reads).toBe(2);
  });

  it("falls back to an obviously wrong colour when a token is missing", async () => {
    unstyled = true;
    const { readPreviewPalette } = await load();
    const palette = readPreviewPalette("light");
    // A CSS keyword, not a hex: this module lives under the no-raw-colour rule
    // it exists to serve. Magenta so a broken stylesheet is visible, not
    // plausible.
    expect(palette.background).toBe("magenta");
    expect(palette.road).toBe("magenta");
  });

  it("never caches a read taken before the stylesheet arrived", async () => {
    unstyled = true;
    const { readPreviewPalette } = await load();
    expect(readPreviewPalette("light").background).toBe("magenta");

    unstyled = false;
    // Without the guard this would return the pinned fallback forever.
    expect(readPreviewPalette("light").background).toBe("#e5e0d4");
    expect(reads).toBe(2);
  });

  it("returns the fallback, and does not throw, with no window at all", async () => {
    vi.stubGlobal("window", undefined);
    const { readPreviewPalette } = await load();
    expect(readPreviewPalette("light").background).toBe("magenta");
  });
});

describe("app/globals.css declares every slot the preview reads", () => {
  const TOKEN_FILE = readFileSync(
    path.resolve(__dirname, "..", "..", "app", "globals.css"),
    "utf-8",
  );

  const block = (from: string, to: string): string =>
    TOKEN_FILE.slice(TOKEN_FILE.indexOf(from), TOKEN_FILE.indexOf(to));

  const declared = (source: string): Map<string, string> => {
    const out = new Map<string, string>();
    for (const match of source.matchAll(/(--fc-[a-z0-9-]+):\s*([^;]+);/g)) {
      out.set(match[1], match[2].trim());
    }
    return out;
  };

  const light = declared(block(":root {", ".dark {"));
  const dark = declared(block(".dark {", "@theme inline {"));

  it("found both theme blocks", () => {
    expect(light.size).toBeGreaterThan(30);
    expect(dark.size).toBeGreaterThan(30);
  });

  it("declares every `--fc-preview-*` slot in both themes", async () => {
    const { PREVIEW_TOKENS } = await load();
    const names = Object.values(PREVIEW_TOKENS) as string[];
    expect(names.length).toBeGreaterThan(12);
    for (const name of names) {
      expect(light.has(name), `${name} is not declared for the light theme`).toBe(true);
      expect(dark.has(name), `${name} is not declared for the dark theme`).toBe(true);
    }
    // ...and the stub the suite above uses covers the same set, so those tests
    // are not quietly asserting over a shrinking palette.
    for (const name of names) {
      expect(Object.keys(TOKENS.light), name).toContain(name);
      expect(Object.keys(TOKENS.dark), name).toContain(name);
    }
  });

  it("paints a hero in the exact filament the build writes into the 3MF", () => {
    // DECISIONS [V2-P3] fixes the own-colour hero at `assemble.HERO_COLOR =
    // "#E3A72F"`. The preview's highlight has to BE that colour, in both
    // themes, or "own colour" shows the user something they will not print.
    const HERO_FILAMENT = "#E3A72F";
    expect(light.get("--fc-preview-hero")?.toUpperCase()).toBe(HERO_FILAMENT);
    expect(dark.get("--fc-preview-hero")?.toUpperCase()).toBe(HERO_FILAMENT);
    // ...and the "picked, but printing in the common filament" colour is a
    // different one, or the two modes would be indistinguishable.
    expect(light.get("--fc-preview-hero-pick")?.toUpperCase()).not.toBe(HERO_FILAMENT);
  });
});

describe("readViewportMultipliers", () => {
  it("reads the dim and recess multipliers off the element carrying the viewport theme", async () => {
    const { readViewportMultipliers, VIEWPORT_MULTIPLIER_TOKENS } = await load();
    const element = { id: "viewport" } as unknown as Element;
    let asked: Element | undefined;
    vi.stubGlobal("window", {
      getComputedStyle: (target: Element) => {
        asked = target;
        return {
          getPropertyValue: (name: string) =>
            name === VIEWPORT_MULTIPLIER_TOKENS.dim
              ? " 0.3 "
              : name === VIEWPORT_MULTIPLIER_TOKENS.recess
                ? " 0.5 "
                : "",
        };
      },
    });
    vi.stubGlobal("document", { documentElement: {} });
    expect(readViewportMultipliers(element)).toEqual({ dim: 0.3, recess: 0.5 });
    // The ELEMENT, not the document: the viewport theme's own values win.
    expect(asked).toBe(element);
  });

  it("refuses a value that is not a fraction, rather than blanking the viewport", async () => {
    const { readViewportMultipliers, DEFAULT_VIEWPORT_MULTIPLIERS } = await load();
    vi.stubGlobal("window", {
      getComputedStyle: () => ({ getPropertyValue: () => "nonsense" }),
    });
    vi.stubGlobal("document", { documentElement: {} });
    expect(readViewportMultipliers(null)).toEqual(DEFAULT_VIEWPORT_MULTIPLIERS);

    vi.stubGlobal("window", {
      getComputedStyle: () => ({ getPropertyValue: () => "4" }),
    });
    expect(readViewportMultipliers(null)).toEqual(DEFAULT_VIEWPORT_MULTIPLIERS);
  });

  it("falls back without a window at all", async () => {
    const { readViewportMultipliers, DEFAULT_VIEWPORT_MULTIPLIERS } = await load();
    vi.stubGlobal("window", undefined);
    expect(readViewportMultipliers(null)).toEqual(DEFAULT_VIEWPORT_MULTIPLIERS);
  });

  it("app/globals.css declares both multipliers in both themes, as fractions", () => {
    const source = readFileSync(
      path.resolve(__dirname, "..", "..", "app", "globals.css"),
      "utf-8",
    );
    const block = (from: string, to: string): string =>
      source.slice(source.indexOf(from), source.indexOf(to));
    for (const [name, text] of [
      ["light", block(":root {", ".dark {")],
      ["dark", block(".dark {", "@theme inline {")],
    ] as Array<[string, string]>) {
      for (const token of ["--fc-preview-dim-opacity", "--fc-preview-recess-shade"]) {
        const match = new RegExp(`${token}:\\s*([0-9.]+);`).exec(text);
        expect(match, `${token} is not declared for the ${name} theme`).not.toBeNull();
        const value = Number(match?.[1]);
        expect(value, `${token} (${name}) is not a fraction`).toBeGreaterThan(0);
        expect(value, `${token} (${name}) is not a fraction`).toBeLessThan(1);
      }
    }
  });
});
