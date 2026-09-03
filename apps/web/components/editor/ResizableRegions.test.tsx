/**
 * What the shell actually renders for a given layout.
 *
 * `lib/layout.test.ts` owns the arithmetic and `e2e/shell.spec.ts` owns the
 * pointer, the WebGL context and the measurements across a run. This file owns
 * the markup rules between them, which is where the accessibility of the whole
 * feature lives:
 *
 *  - a divider is a `separator` with a name, an orientation, the region it
 *    controls, and a value;
 *  - a region that is off screen is HIDDEN, never unmounted, so the map keeps
 *    its context and the viewport keeps its model;
 *  - a divider whose column is away is gone, because a control that resizes
 *    nothing is not a control;
 *  - every layout control carries `aria-pressed` and a full-sentence name, and
 *    the two hide toggles say why they are unavailable while a region has the
 *    whole window.
 *
 * The store is mocked rather than driven, for the reason `ActionBar.test.tsx`
 * mocks the editor store: zustand's React binding reads `getInitialState()`
 * during a server render, and `renderToStaticMarkup` IS a server render, so a
 * test that set the real store would silently assert against the default
 * layout forever.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock("@/store/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/layout")>();
  const hook = (selector?: (state: unknown) => unknown): unknown =>
    selector === undefined ? store.state : selector(store.state);
  Object.assign(hook, {
    getState: () => store.state,
    getInitialState: () => store.state,
    setState: () => undefined,
    subscribe: () => () => undefined,
  });
  return { ...actual, useLayoutStore: hook };
});

import { DEFAULT_LAYOUT, type LayoutState } from "@/lib/layout";
import { LayoutControls } from "./PaneChrome";
import ResizableRegions from "./ResizableRegions";

const noop = (): void => undefined;

function setLayout(state: LayoutState): void {
  store.state = {
    ...state,
    setBoundary: noop,
    nudgeBoundary: noop,
    resetBoundary: noop,
    setCollapsed: noop,
    toggleCollapsed: noop,
    setMaximized: noop,
    toggleMaximized: noop,
    reset: noop,
    adopt: noop,
  };
}

function shell(): string {
  return renderToStaticMarkup(
    <ResizableRegions
      map={<div data-testid="map-child" />}
      viewport={<div data-testid="viewport-child" />}
      settings={<div data-testid="settings-child" />}
    />,
  );
}

/** The one open tag carrying this test id, so a class list can be read off it. */
function tagWith(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  expect(at, `${testId} is not in the markup`).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<", at);
  return html.slice(start, html.indexOf(">", at) + 1);
}

beforeEach(() => {
  setLayout(DEFAULT_LAYOUT);
});

describe("the three regions", () => {
  it("renders all three, each at its stated width, with both dividers", () => {
    const html = shell();
    expect(html).toContain('data-testid="map-child"');
    expect(html).toContain('data-testid="viewport-child"');
    expect(html).toContain('data-testid="settings-child"');
    expect(tagWith(html, "region-map")).toContain("--fc-region-w:400px");
    expect(tagWith(html, "param-sheet")).toContain("--fc-region-w:368px");
    expect(html.match(/role="separator"/g)).toHaveLength(2);
    expect(html).toContain('data-maximized="none"');
  });

  it("gives every divider a name, an orientation, the region it moves and a value", () => {
    const handle = tagWith(shell(), "layout-handle-map");
    expect(handle).toContain('role="separator"');
    expect(handle).toContain('aria-orientation="vertical"');
    expect(handle).toContain('aria-label="Resize the map column"');
    expect(handle).toContain('aria-controls="fc-region-map"');
    expect(handle).toContain("aria-valuenow=");
    expect(handle).toContain("aria-valuemin=");
    expect(handle).toContain("aria-valuemax=");
    expect(handle).toContain('tabindex="0"');
  });

  it("hides a collapsed column instead of unmounting it, and drops its divider", () => {
    setLayout({ ...DEFAULT_LAYOUT, collapsed: { map: true, settings: false } });
    const html = shell();
    // Still mounted: this is what keeps the map's GL context alive.
    expect(html).toContain('data-testid="map-child"');
    expect(tagWith(html, "region-map")).toContain("lg:hidden");
    expect(tagWith(html, "region-map")).toContain('data-visible="false"');
    // The divider it shared with the viewport is gone, and the other stays.
    expect(html).not.toContain('data-testid="layout-handle-map"');
    expect(html).toContain('data-testid="layout-handle-settings"');
    // And the way back stands where the column was.
    expect(tagWith(html, "layout-rail-map")).toContain('aria-label="Show the map column"');
  });

  it("gives a maximized region the row, keeps the others mounted, and drops both dividers", () => {
    setLayout({ ...DEFAULT_LAYOUT, maximized: "viewport" });
    const html = shell();
    expect(html).toContain('data-maximized="viewport"');
    expect(html).toContain('data-testid="map-child"');
    expect(html).toContain('data-testid="settings-child"');
    expect(tagWith(html, "region-map")).toContain("lg:hidden");
    expect(tagWith(html, "param-sheet")).toContain("lg:hidden");
    expect(tagWith(html, "region-viewport")).not.toContain("lg:hidden");
    expect(html).not.toContain('role="separator"');
    // No rails either: there is nothing beside the maximized region to stand in.
    expect(html).not.toContain('data-testid="layout-rail-map"');
    expect(html).not.toContain('data-testid="layout-rail-settings"');
  });

  it("lets the maximized map fill the row rather than holding its stated width", () => {
    setLayout({ ...DEFAULT_LAYOUT, maximized: "map" });
    const region = tagWith(shell(), "region-map");
    expect(region).toContain("lg:flex-1");
    expect(region).not.toContain("lg:w-[var(--fc-region-w)]");
  });

  it("keeps the small-screen sheet and its toggle, which no collapse touches", () => {
    setLayout({ ...DEFAULT_LAYOUT, collapsed: { map: false, settings: true } });
    const html = shell();
    expect(html).toContain('data-testid="param-sheet-toggle"');
    expect(html).toContain('aria-controls="param-sheet-body"');
    // Hidden at `lg` only: below it the settings are a bottom sheet, where
    // "which of three columns is hidden" is not a question.
    expect(tagWith(html, "param-sheet")).toContain("lg:hidden");
  });
});

describe("the layout controls", () => {
  const controls = (): string => renderToStaticMarkup(<LayoutControls />);

  it("offers four toggles, each with a full-sentence name and a pressed state", () => {
    const html = controls();
    for (const testId of [
      "layout-collapse-map",
      "layout-maximize-map",
      "layout-maximize-viewport",
      "layout-collapse-settings",
    ]) {
      expect(tagWith(html, testId)).toContain('aria-pressed="false"');
      expect(tagWith(html, testId)).toContain("aria-label=");
    }
    expect(html).toContain("Hide map");
    expect(html).toContain("Wide preview");
  });

  it("says what the click will do, and flips with the state", () => {
    setLayout({ ...DEFAULT_LAYOUT, collapsed: { map: true, settings: false } });
    const html = controls();
    expect(html).toContain("Show map");
    expect(tagWith(html, "layout-collapse-map")).toContain('aria-pressed="true"');
    expect(tagWith(html, "layout-collapse-map")).toContain('aria-label="Show map column"');
  });

  it("begins every accessible name with the words on the button (WCAG 2.5.3)", () => {
    const html = controls();
    for (const [testId, visible] of [
      ["layout-collapse-map", "Hide map"],
      ["layout-maximize-map", "Wide map"],
      ["layout-maximize-viewport", "Wide preview"],
      ["layout-collapse-settings", "Hide settings"],
    ] as const) {
      const name = /aria-label="([^"]+)"/.exec(tagWith(html, testId))?.[1] ?? "";
      expect(name.toLowerCase().startsWith(visible.toLowerCase()), `${testId}: ${name}`).toBe(
        true,
      );
    }
  });

  it("turns the wide button into the restore control, and refuses to hide what is already away", () => {
    setLayout({ ...DEFAULT_LAYOUT, maximized: "viewport" });
    const html = controls();
    expect(tagWith(html, "layout-maximize-viewport")).toContain('aria-pressed="true"');
    expect(tagWith(html, "layout-maximize-viewport")).toContain(
      'aria-label="Restore the three columns"',
    );
    expect(html).toContain("Restore");
    for (const testId of ["layout-collapse-map", "layout-collapse-settings"]) {
      expect(tagWith(html, testId)).toContain("disabled");
      expect(tagWith(html, testId)).toContain("Restore the columns before hiding one");
    }
  });
});
