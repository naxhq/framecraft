/**
 * The layout store.
 *
 * `lib/layout.test.ts` owns the rules; this file owns the two things only the
 * store can get wrong: that every action persists what it did, and that an
 * action which changes nothing writes nothing (a drag calls `setBoundary` on
 * every pointer move, and most of those moves land on the same rounded pixel
 * the last one did).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_LAYOUT,
  DEFAULT_SIZES,
  KEYBOARD_STEP_LARGE_PX,
  KEYBOARD_STEP_PX,
  LAYOUT_STORAGE_KEY,
  REGION_MAX_PX,
  sameLayout,
} from "@/lib/layout";
import {
  adoptLayoutPayload,
  currentLayoutPayload,
  hydrateLayout,
  resetLayoutStore,
  useLayoutStore,
} from "./layout";

/** A 1280 px window minus the two dividers. */
const ROOM = 1268;

const items = new Map<string, string>();
let writes = 0;

const storage = {
  getItem: (key: string) => items.get(key) ?? null,
  setItem: (key: string, value: string) => {
    writes += 1;
    items.set(key, value);
  },
  removeItem: (key: string) => {
    writes += 1;
    items.delete(key);
  },
};

beforeEach(() => {
  items.clear();
  writes = 0;
  vi.stubGlobal("window", { localStorage: storage });
  resetLayoutStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const layout = () => useLayoutStore.getState();

describe("dragging a divider", () => {
  it("moves the column and keeps the result", () => {
    layout().setBoundary("map", ROOM, 500);
    expect(layout().sizes.map).toBe(500);
    expect(items.get(LAYOUT_STORAGE_KEY)).toBe(JSON.stringify({ map: 500 }));
  });

  it("clamps rather than letting a drag run past what the divider may do", () => {
    layout().setBoundary("map", ROOM, 5000);
    // 1268 - 368 - 320: the viewport's floor, not the map's own maximum.
    expect(layout().sizes.map).toBe(580);
    expect(layout().sizes.map).toBeLessThan(REGION_MAX_PX.map);
  });

  it("writes nothing when the pointer lands where the divider already is", () => {
    layout().setBoundary("map", ROOM, 500);
    const before = writes;
    layout().setBoundary("map", ROOM, 500);
    layout().setBoundary("map", ROOM, 500);
    expect(writes).toBe(before);
  });
});

describe("the keyboard", () => {
  it("nudges by a step, and further with the large step", () => {
    layout().nudgeBoundary("map", ROOM, 1);
    expect(layout().sizes.map).toBe(DEFAULT_SIZES.map + KEYBOARD_STEP_PX);
    layout().nudgeBoundary("map", ROOM, -1, true);
    expect(layout().sizes.map).toBe(DEFAULT_SIZES.map + KEYBOARD_STEP_PX - KEYBOARD_STEP_LARGE_PX);
  });

  it("puts one divider back without touching the other", () => {
    layout().setBoundary("map", ROOM, 300);
    layout().setBoundary("settings", ROOM, ROOM - 500);
    layout().resetBoundary("map");
    expect(layout().sizes.map).toBe(DEFAULT_SIZES.map);
    expect(layout().sizes.settings).toBe(500);
  });
});

describe("hiding and maximizing", () => {
  it("toggles a side column and keeps the flag", () => {
    layout().toggleCollapsed("settings");
    expect(layout().collapsed.settings).toBe(true);
    expect(items.get(LAYOUT_STORAGE_KEY)).toBe(JSON.stringify({ collapsed: ["settings"] }));
    layout().toggleCollapsed("settings");
    expect(layout().collapsed.settings).toBe(false);
    expect(items.has(LAYOUT_STORAGE_KEY)).toBe(false);
  });

  it("gives a region the window and hands it back", () => {
    layout().toggleMaximized("viewport");
    expect(layout().maximized).toBe("viewport");
    layout().toggleMaximized("viewport");
    expect(layout().maximized).toBeNull();
  });

  it("restores the columns when the maximized one is asked to hide", () => {
    layout().setMaximized("map");
    layout().setCollapsed("map", true);
    expect(layout().maximized).toBeNull();
    expect(layout().collapsed.map).toBe(true);
  });

  it("puts the whole layout back and leaves no stored trace", () => {
    layout().setBoundary("map", ROOM, 300);
    layout().toggleCollapsed("settings");
    layout().reset();
    expect(sameLayout(layout(), DEFAULT_LAYOUT)).toBe(true);
    expect(items.has(LAYOUT_STORAGE_KEY)).toBe(false);
  });
});

describe("what travels, and what comes back", () => {
  it("says nothing about a default layout", () => {
    expect(currentLayoutPayload()).toBeNull();
  });

  it("names only what moved", () => {
    layout().setBoundary("map", ROOM, 512);
    expect(currentLayoutPayload()).toEqual({ map: 512 });
  });

  it("adopts a payload and reports that it did", () => {
    expect(adoptLayoutPayload({ map: 512, collapsed: ["settings"] })).toBe(true);
    expect(layout().sizes.map).toBe(512);
    expect(layout().collapsed.settings).toBe(true);
  });

  it("refuses a payload that names nothing, and leaves the layout alone", () => {
    layout().setBoundary("map", ROOM, 512);
    expect(adoptLayoutPayload({ nothing: true })).toBe(false);
    expect(adoptLayoutPayload(null)).toBe(false);
    expect(layout().sizes.map).toBe(512);
  });

  it("adopts this browser's own layout on hydrate", () => {
    items.set(LAYOUT_STORAGE_KEY, JSON.stringify({ settings: 480, maximized: "map" }));
    hydrateLayout();
    expect(layout().sizes.settings).toBe(480);
    expect(layout().maximized).toBe("map");
  });

  it("hydrates to the default when this browser has never said otherwise", () => {
    hydrateLayout();
    expect(sameLayout(layout(), DEFAULT_LAYOUT)).toBe(true);
  });
});
