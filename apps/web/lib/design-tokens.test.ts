/**
 * One colour source, and only one.
 *
 * `app/globals.css` holds the whole palette as CSS custom properties, mapped
 * into Tailwind through `@theme inline` so that adding `.dark` to <html>
 * re-points every utility at once. A raw `#rrggbb` anywhere else is how a
 * theme rots: it looks right in the theme it was written in and is invisible
 * in the other one, and no amount of review catches the fourth one.
 *
 * This test walks the shipped UI source and fails on any hex literal outside
 * the token file. Test fixtures are excluded on purpose -- `part_colors` is a
 * contract field whose values ARE hex strings, and a test that asserts on them
 * has to write them down.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEB_ROOT = path.resolve(__dirname, "..");

/** The only file allowed to contain a colour value. */
const ALLOWLIST = ["app/globals.css"];

const ROOTS = ["components", "app"];
const EXTENSIONS = [".ts", ".tsx", ".css"];
/**
 * Every way a colour can be written, not just the CSS hex one.
 *
 * The first version of this scan matched `#rrggbb` only, and three literals
 * walked straight past it: `0xffffff` and `0x445566` (the hemisphere light's
 * sky and ground bounce, in the very file whose header comment explains the
 * token rule) and two `rgba(0,0,0,.4)` marker shadows whose neighbouring
 * declarations had been tokenised in the same diff. A scanner that only catches
 * the spelling you happened to use is a scanner that reports clean.
 */
const HEX = /#[0-9a-fA-F]{3,8}\b|0x[0-9a-fA-F]{6}\b|\b(?:rgba?|hsla?)\(/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!EXTENSIONS.includes(path.extname(entry))) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

function scannedFiles(): string[] {
  const files: string[] = [];
  for (const root of ROOTS) walk(path.join(WEB_ROOT, root), files);
  return files.map((file) => path.relative(WEB_ROOT, file).split(path.sep).join("/"));
}

describe("design tokens", () => {
  it("scans a meaningful number of files", () => {
    // Guards the guard: a broken walker would pass this suite silently.
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(15);
    expect(files).toContain("app/globals.css");
    expect(files).toContain("components/scene/CityPreview.tsx");
  });

  it("has no raw hex colour outside the token file", () => {
    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      if (ALLOWLIST.includes(file)) continue;
      const source = readFileSync(path.join(WEB_ROOT, file), "utf-8");
      for (const match of source.matchAll(HEX)) {
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(
      offenders,
      `raw colours must live in ${ALLOWLIST.join(", ")}:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("catches every spelling of a colour, not only the CSS hex one", () => {
    // Non-vacuity for the widened pattern: each of these got past the original
    // `#rrggbb`-only scan and was found by hand in an audit instead.
    for (const sample of [
      "#ab12cd",
      "#fff",
      "0x445566",
      "0xffffff",
      "rgba(0, 0, 0, .4)",
      "rgb(1,2,3)",
      "hsl(210 5% 20%)",
      "hsla(210,5%,20%,.5)",
    ]) {
      expect(sample, sample).toMatch(new RegExp(HEX.source));
    }
    // ...and things that merely look like one must not trip it.
    for (const sample of [
      "0x12",
      "#ab",
      "translate(",
      "cubic-bezier(",
      "colour",
      "grab(",
    ]) {
      expect(sample, sample).not.toMatch(new RegExp(HEX.source));
    }
  });

  it("allowlists exactly one file, and that file really holds the palette", () => {
    expect(ALLOWLIST).toEqual(["app/globals.css"]);
    const tokens = readFileSync(path.join(WEB_ROOT, "app/globals.css"), "utf-8");
    // Not vacuous: the scan above only means something because this is where
    // the colours actually are.
    expect([...tokens.matchAll(HEX)].length).toBeGreaterThan(40);
  });

  it("defines every light token again for the dark theme", () => {
    const tokens = readFileSync(path.join(WEB_ROOT, "app/globals.css"), "utf-8");
    const root = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf(".dark {"));
    const dark = tokens.slice(
      tokens.indexOf(".dark {"),
      tokens.indexOf("@theme inline {"),
    );
    expect(dark.length, "the .dark block was not found").toBeGreaterThan(200);
    const names = (block: string): string[] =>
      [...block.matchAll(/(--fc-[a-z0-9-]+):/g)].map((match) => match[1]);

    const missing = names(root)
      // The map overlays are deliberately theme-independent: the OSM raster
      // tiles under them are the same imagery in either theme.
      .filter((name) => !name.startsWith("--fc-map-"))
      .filter((name) => !names(dark).includes(name));
    expect(missing, `tokens with no dark value: ${missing.join(", ")}`).toEqual([]);
  });

  it("maps the theme through var(), so the .dark class can re-point it", () => {
    const tokens = readFileSync(path.join(WEB_ROOT, "app/globals.css"), "utf-8");
    const start = tokens.indexOf("@theme inline {");
    expect(start).toBeGreaterThan(-1);
    const block = tokens.slice(start, tokens.indexOf("\n}", start));
    const colours = [...block.matchAll(/(--color-[a-z0-9-]+):\s*([^;]+);/g)];
    expect(colours.length).toBeGreaterThan(15);
    for (const [, name, value] of colours) {
      expect(value.trim(), `${name} must be a var(), not a literal`).toMatch(
        /^var\(--fc-[a-z0-9-]+\)$/,
      );
    }
  });
});
