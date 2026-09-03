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

import { readFileSync, readdirSync } from "node:fs";
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
  ["primary-ink", "primary", "the Export button"],
  ["accent-ink", "accent", "the active preset chip"],
  ["primary-ink", "danger", "the over-60 mm badge in the viewport"],
  ["positive", "plate", "the download links"],
  ["positive", "positive-soft", "a download link on hover"],
  ["warn", "warn-soft", "the cap and stale notices"],
  ["warn", "plate", "the presets-unavailable line"],
  ["danger", "plate", "a failed export in the stats card"],
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
  [
    "control-border-strong",
    "plate-raised",
    "the filament swatch ring in the estimate card and on a colour chip",
  ],
  ["primary", "plate", "the primary button against the panel"],
  ["accent", "plate-sunken", "the export progress fill against its track"],
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
  /**
   * Every file in the app that draws the visual edge of a control, and the
   * boundary token(s) it must draw it with.
   *
   * This is an INVENTORY, not a sample: the guard below re-derives the same
   * set from the tree and fails if the two disagree, so a component that
   * starts drawing a control edge cannot quietly stay unlisted.
   *
   * `OutputPanel.tsx` used to be here and is deliberately not any more. Every
   * control it once drew -- Preview, Export, the format select, Save, Load,
   * Copy link -- moved into `ActionBar.tsx` (Task 6). What is left in the
   * panel is container and badge edges plus the download link, whose boundary
   * is `positive` and is held to the stricter 4.5:1 text floor above; the test
   * below pins that, so the removal is asserted rather than merely dropped.
   */
  const CONTROL_FILES = [
    // The settings column.
    ["components/editor/Controls.tsx", ["border-control", "border-control-strong"]],
    ["components/editor/PresetRow.tsx", ["border-control"]],
    ["components/editor/ThemeToggle.tsx", ["border-control"]],
    ["components/editor/EditorShell.tsx", ["border-control"]],
    ["components/editor/ShortcutSheet.tsx", ["border-control"]],
    ["components/editor/EngravingsEditor.tsx", ["border-control"]],
    ["components/editor/EstimateCard.tsx", ["border-control-strong"]],
    ["components/editor/groups/ColourGroup.tsx", ["border-control", "border-control-strong"]],
    ["components/editor/groups/FrameTextGroup.tsx", ["border-control"]],
    // The action bar and everything mounted inside it (Task 6).
    ["components/editor/ActionBar.tsx", ["border-control"]],
    ["components/editor/ExportErrorDetail.tsx", ["border-control"]],
    ["components/editor/ExportMenu.tsx", ["border-control"]],
    // The viewport's own chrome.
    ["components/editor/AdjustmentsChip.tsx", ["border-control"]],
    ["components/editor/HistoryChip.tsx", ["border-control"]],
    ["components/editor/IssuesBadge.tsx", ["border-control"]],
    ["components/editor/PerfHud.tsx", ["border-control"]],
    ["components/scene/CityPreview.tsx", ["border-control"]],
    ["components/scene/PreviewPane.tsx", ["border-control"]],
    // The map picker.
    ["components/map/SearchBox.tsx", ["border-control"]],
  ] as const;

  it("wires the token into every file that draws a control edge", () => {
    for (const [file, expected] of CONTROL_FILES) {
      const source = readFileSync(path.resolve(__dirname, "..", file), "utf-8");
      for (const token of expected) {
        expect(source, `${file} should use ${token}`).toContain(token);
      }
    }
  });

  it("keeps that inventory complete", () => {
    // Guards the list against going stale in either direction: a new
    // control-bearing component that is not named above, and a name above
    // that no longer draws a control edge at all.
    const root = path.resolve(__dirname, "..");
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".tsx")) continue;
        if (!readFileSync(full, "utf-8").includes("border-control")) continue;
        found.push(path.relative(root, full).split(path.sep).join("/"));
      }
    };
    walk(path.join(root, "components"));
    expect(found.sort()).toEqual(CONTROL_FILES.map(([file]) => file).slice().sort());
  });

  it("leaves the results panel with container edges only", () => {
    const source = readFileSync(
      path.resolve(__dirname, "..", "components/editor/OutputPanel.tsx"),
      "utf-8",
    );
    // The actions really did leave; they did not merely lose their token.
    for (const marker of [
      'data-testid="preview-button"',
      'data-testid="export-button"',
      'data-testid="copy-link-button"',
      "<select",
    ]) {
      expect(source, `${marker} belongs to the action bar now`).not.toContain(marker);
    }
    // And the one interactive edge that stayed is a token held above 4.5:1,
    // not the hairline.
    expect(source).toContain("border border-positive");
    expect(source).not.toContain("border-control");
  });

  it("draws the progress control as a fill, with no boundary of its own", () => {
    // `ProgressBar` is the one new control in the action bar with no border:
    // its track is a filled well and its fill is `accent`, a pair asserted at
    // the 3:1 floor above. If it ever grows an edge, this fails and the file
    // has to join the inventory rather than reaching for the hairline.
    const source = readFileSync(
      path.resolve(__dirname, "..", "components/editor/ProgressBar.tsx"),
      "utf-8",
    );
    expect(source).not.toContain("border-");
    expect(source).toContain("bg-plate-sunken");
    expect(source).toContain("bg-accent");
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
