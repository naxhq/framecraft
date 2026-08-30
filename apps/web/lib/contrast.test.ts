/**
 * WCAG contrast, computed from the token file, for both themes.
 *
 * axe cannot do this half of the job. It implements SC 1.4.3 (text) well, but
 * **not SC 1.4.11 (non-text contrast)** — the 3:1 floor for "the visual
 * boundary of a user-interface component" is not machine-decidable in general,
 * so a page can score zero axe violations while every input, select, segmented
 * control and toggle track on it is outlined at 1.2–2.7:1. That is exactly what
 * this editor shipped with, and an audit found it by running the formula by
 * hand. This test is that formula, kept.
 *
 * It reads `app/globals.css` rather than a copy of the palette, so it fails the
 * moment a token moves; and it asserts the PAIRS the components actually
 * render, so a token that is fine in isolation but used on the wrong surface is
 * still caught.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const CSS = readFileSync(
  path.resolve(__dirname, "..", "app", "globals.css"),
  "utf-8",
);

/** WCAG 2.x text floor (AA, normal text). */
const TEXT_MIN = 4.5;
/** WCAG 2.1 SC 1.4.11 floor for a control boundary or a meaningful graphic. */
const NON_TEXT_MIN = 3.0;

// ---------------------------------------------------------------------------
// the formula, written out (no colour library, nothing to trust)
// ---------------------------------------------------------------------------

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an `#rrggbb` string. */
export function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

// ---------------------------------------------------------------------------
// the token file
// ---------------------------------------------------------------------------

type Theme = "light" | "dark";

/** `--fc-*: #rrggbb` declarations from one block of the stylesheet. */
function tokensIn(startMarker: string, endMarker: string): Record<string, string> {
  const start = CSS.indexOf(startMarker);
  const end = CSS.indexOf(endMarker, start);
  expect(start, `no ${startMarker} block`).toBeGreaterThan(-1);
  expect(end, `no end marker after ${startMarker}`).toBeGreaterThan(start);
  const block = CSS.slice(start, end);
  const out: Record<string, string> = {};
  for (const match of block.matchAll(/(--fc-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    out[match[1]] = match[2];
  }
  return out;
}

const LIGHT = tokensIn(":root {", ".dark {");
const DARK = { ...LIGHT, ...tokensIn(".dark {", "@theme inline {") };

const THEMES: Record<Theme, Record<string, string>> = { light: LIGHT, dark: DARK };

function value(theme: Theme, token: string): string {
  const hex = THEMES[theme][`--fc-${token}`];
  expect(hex, `--fc-${token} is not defined for the ${theme} theme`).toBeTruthy();
  return hex;
}

function ratio(theme: Theme, foreground: string, background: string): number {
  return contrast(value(theme, foreground), value(theme, background));
}

// ---------------------------------------------------------------------------
// the pairs the components render
// ---------------------------------------------------------------------------

/** Every surface a control or a piece of text is ever drawn on. */
const SURFACES = ["bench", "plate", "plate-raised", "plate-sunken"] as const;

/** [foreground, background, where it is rendered] */
const TEXT_PAIRS: Array<[string, string, string]> = [
  ...SURFACES.flatMap(
    (surface) =>
      [
        ["ink", surface, `body text on ${surface}`],
        ["ink-muted", surface, `secondary text on ${surface}`],
        ["ink-faint", surface, `hints and captions on ${surface}`],
      ] as Array<[string, string, string]>,
  ),
  ["accent", "plate", "links and the Clear all action"],
  ["accent", "plate-sunken", "links inside a well"],
  ["primary-ink", "primary", "the Bake button"],
  ["accent-ink", "accent", "the active preset chip"],
  ["primary-ink", "danger", "the over-60 mm badge in the viewport"],
  ["positive", "plate", "the download links"],
  ["positive", "positive-soft", "a download link on hover"],
  ["warn", "warn-soft", "the cap and stale notices"],
  ["warn", "plate", "the presets-unavailable line"],
  ["danger", "plate", "a failed bake in the stats card"],
  ["danger", "danger-soft", "the blocking warning banners"],
];

/**
 * Boundaries, i.e. SC 1.4.11. Each is the only visual edge of a real control.
 */
const BOUNDARY_PAIRS: Array<[string, string, string]> = [
  ["control-border", "plate", "segmented control, chip, ? and theme buttons, preset chips"],
  ["control-border", "plate-raised", "text inputs, selects, the secondary button, colour wells"],
  ["control-border", "plate-sunken", "the segmented control's track"],
  ["control-border", "bench", "any control sitting on the page background"],
  ["control-border-strong", "plate", "emphasis boundaries on the panel"],
  ["control-border-strong", "plate-sunken", "the unchecked Toggle track and its knob"],
  ["primary", "plate", "the primary button against the panel"],
  ["accent", "plate-sunken", "the bake progress fill against its track"],
  ["focus", "plate", "the focus ring on the panel"],
  ["focus", "plate-raised", "the focus ring on an input"],
  ["focus", "plate-sunken", "the focus ring in a well"],
  ["focus", "bench", "the focus ring on the page background"],
];

describe("the token file parses", () => {
  it("finds a full palette for both themes", () => {
    expect(Object.keys(LIGHT).length).toBeGreaterThan(25);
    // The dark block redefines everything except the deliberately
    // theme-independent map ink.
    const redefined = Object.keys(tokensIn(".dark {", "@theme inline {"));
    expect(redefined.length).toBeGreaterThan(25);
  });

  it("is not silently matching nothing", () => {
    // Guards the guard: a broken regex would make every assertion below pass
    // vacuously, because `value()` would fail first -- so prove one known pair.
    expect(ratio("light", "ink", "plate")).toBeGreaterThan(10);
  });
});

describe("SC 1.4.3 — text contrast (AA, 4.5:1)", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`holds for every text pair in the ${theme} theme`, () => {
      const failures: string[] = [];
      for (const [fg, bg, where] of TEXT_PAIRS) {
        const measured = ratio(theme, fg, bg);
        if (measured < TEXT_MIN) {
          failures.push(
            `${fg} on ${bg} = ${measured.toFixed(2)}:1 (needs ${TEXT_MIN}) — ${where}`,
          );
        }
      }
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }
});

describe("SC 1.4.11 — non-text contrast (AA, 3:1)", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`holds for every control boundary in the ${theme} theme`, () => {
      const failures: string[] = [];
      for (const [fg, bg, where] of BOUNDARY_PAIRS) {
        const measured = ratio(theme, fg, bg);
        if (measured < NON_TEXT_MIN) {
          failures.push(
            `${fg} on ${bg} = ${measured.toFixed(2)}:1 (needs ${NON_TEXT_MIN}) — ${where}`,
          );
        }
      }
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }

  it("keeps the decorative hairline separate from the control boundary", () => {
    // `line` is deliberately BELOW 3:1: it is a divider, not a control edge,
    // and SC 1.4.11 does not apply to it. The whole point of the split is that
    // a component must never reach for it -- which is why this test asserts
    // the two tokens really are different, and the class scan below asserts
    // the components use the right one.
    for (const theme of ["light", "dark"] as const) {
      expect(value(theme, "line")).not.toBe(value(theme, "control-border"));
      expect(ratio(theme, "control-border", "plate-raised")).toBeGreaterThan(
        ratio(theme, "line", "plate-raised"),
      );
    }
  });
});

describe("the components use the boundary token for control boundaries", () => {
  const CONTROL_FILES = [
    ["components/editor/Controls.tsx", ["border-control", "border-control-strong"]],
    ["components/editor/OutputPanel.tsx", ["border-control"]],
    ["components/editor/PresetRow.tsx", ["border-control"]],
    ["components/editor/ThemeToggle.tsx", ["border-control"]],
  ] as const;

  it("wires the token into every file that draws a control edge", () => {
    for (const [file, expected] of CONTROL_FILES) {
      const source = readFileSync(path.resolve(__dirname, "..", file), "utf-8");
      for (const token of expected) {
        expect(source, `${file} should use ${token}`).toContain(token);
      }
    }
  });

  it("leaves no text input, select or toggle track on the hairline", () => {
    const source = readFileSync(
      path.resolve(__dirname, "..", "components/editor/Controls.tsx"),
      "utf-8",
    );
    // The three control primitives whose border IS their boundary.
    for (const marker of [
      'type="text"',
      "<select",
      'role="switch"',
      'role="radiogroup"',
    ]) {
      expect(source).toContain(marker);
    }
    // None of the control class strings may name the decorative hairline.
    const controlClasses = [...source.matchAll(/className=[`"]([^`"]*border[^`"]*)[`"]/g)]
      .map((match) => match[1])
      .filter((value) => /bg-plate-raised|bg-plate-sunken|p-0\.5/.test(value));
    for (const className of controlClasses) {
      expect(
        /border-line\b/.test(className),
        `a control boundary still uses the hairline: ${className}`,
      ).toBe(false);
    }
  });
});
