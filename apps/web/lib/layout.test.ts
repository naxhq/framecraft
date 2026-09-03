/**
 * The shell's layout rules.
 *
 * Three things are load-bearing here and none of them is obvious from reading
 * the component:
 *
 *  1. **The fit.** A row narrower than the sum of what the user asked for has
 *     to give the room back to the middle, and it has to take it from the side
 *     with room to spare rather than splitting it evenly. Every branch of that
 *     is exercised, including the one where there is nothing left to take.
 *  2. **The clamps.** A drag and an arrow key go through the same two
 *     functions, so a boundary that could be dragged somewhere it cannot be
 *     nudged (or the other way round) is a defect this file catches.
 *  3. **DECISIONS `[V3.1-O6]`.** Layout rides in a project file and a
 *     permalink and is NOT a print parameter. The last block asserts that from
 *     both sides: the round trip works, and the layout never appears in the
 *     settings diff, in `PRINT_PARAM_SPEC`, or in a link's `p` block.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deflateSync, inflateSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PRINT_PARAM_LEAF_PATHS,
  defaultPrintParams,
  type SceneRequest,
} from "./contracts";
import {
  DEFAULT_LAYOUT,
  DEFAULT_SIZES,
  KEYBOARD_STEP_LARGE_PX,
  KEYBOARD_STEP_PX,
  LAYOUT_STORAGE_KEY,
  REGION_MAX_PX,
  REGION_MIN_PX,
  boundaryPercent,
  boundaryPosition,
  boundaryRange,
  boundaryVisible,
  clampSize,
  isDefaultLayout,
  layoutFromPayload,
  layoutPayload,
  loadStoredLayout,
  moveBoundary,
  resetBoundary,
  resolveWidths,
  sameLayout,
  setBoundaryPosition,
  setCollapsed,
  setMaximized,
  storeLayout,
  toggleCollapsed,
  toggleMaximized,
  visibleRegions,
  type LayoutState,
} from "./layout";
import { buildProject, parseProject, serializeProject } from "./project";
import { PRINT_PARAM_SPEC, checksum, decodeShare, encodeShare, paramsDiff } from "./share";
import { resetLayoutStore, useLayoutStore } from "@/store/layout";
import type { LocationState } from "@/store/editor";

const here = dirname(fileURLToPath(import.meta.url));

/** A 1280 px window minus the two dividers: the size the e2e suite actually runs at. */
const ROOM = 1268;

const REQUEST: SceneRequest = {
  lat: 41.8827,
  lon: -87.6233,
  radius_m: 900,
  rotation_deg: 0,
  preset_id: "chicago-loop",
};

const LOCATION: LocationState = {
  lat: REQUEST.lat,
  lon: REQUEST.lon,
  radius_m: REQUEST.radius_m,
  rotation_deg: REQUEST.rotation_deg,
  preset_id: REQUEST.preset_id ?? null,
};

function layout(partial: Partial<LayoutState> = {}): LayoutState {
  return { ...DEFAULT_LAYOUT, ...partial };
}

/** A hand-made link carrying an arbitrary payload body, for the cases `encodeShare` cannot produce. */
function linkFor(body: string): string {
  const bytes = deflateSync(new TextEncoder().encode(body), { level: 9 });
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `v3.${encoded}.${checksum(body)}`;
}

/** The JSON a link actually carries, so the `p` / `l` split can be asserted rather than assumed. */
function bodyOf(link: string): Record<string, unknown> {
  const encoded = link.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const raw = new Uint8Array(Buffer.from(encoded, "base64"));
  return JSON.parse(new TextDecoder().decode(inflateSync(raw))) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The defaults are the design tokens
// ---------------------------------------------------------------------------

describe("the default widths", () => {
  it("mirror the two column tokens in app/globals.css", () => {
    const css = readFileSync(resolve(here, "..", "app", "globals.css"), "utf-8");
    const rem = (name: string): number => {
      const match = new RegExp(`--${name}:\\s*([0-9.]+)rem`).exec(css);
      expect(match, `--${name} is missing from app/globals.css`).not.toBeNull();
      return Number(match?.[1]);
    };
    // 16px root, which is what the app never overrides.
    expect(rem("spacing-atlas") * 16).toBe(DEFAULT_SIZES.map);
    expect(rem("spacing-rail") * 16).toBe(DEFAULT_SIZES.settings);
  });

  it("sit inside their own limits, so the shell never opens on an illegal layout", () => {
    expect(clampSize("map", DEFAULT_SIZES.map)).toBe(DEFAULT_SIZES.map);
    expect(clampSize("settings", DEFAULT_SIZES.settings)).toBe(DEFAULT_SIZES.settings);
    expect(isDefaultLayout(DEFAULT_LAYOUT)).toBe(true);
  });
});

describe("clampSize", () => {
  it("holds a region inside its limits", () => {
    expect(clampSize("map", 10)).toBe(REGION_MIN_PX.map);
    expect(clampSize("map", 5000)).toBe(REGION_MAX_PX.map);
    expect(clampSize("settings", 0)).toBe(REGION_MIN_PX.settings);
    expect(clampSize("settings", 5000)).toBe(REGION_MAX_PX.settings);
  });

  it("falls back to the default for a number that is not one", () => {
    expect(clampSize("map", Number.NaN)).toBe(DEFAULT_SIZES.map);
    expect(clampSize("settings", Number.POSITIVE_INFINITY)).toBe(DEFAULT_SIZES.settings);
  });

  it("rounds, because a fractional column width is a blurry border", () => {
    expect(clampSize("map", 400.4)).toBe(400);
    expect(clampSize("map", 400.6)).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Fitting the row
// ---------------------------------------------------------------------------

describe("resolveWidths", () => {
  it("returns the stated widths before the row has been measured", () => {
    const widths = resolveWidths(DEFAULT_LAYOUT, 0);
    expect(widths.map).toBe(DEFAULT_SIZES.map);
    expect(widths.settings).toBe(DEFAULT_SIZES.settings);
    expect(widths.available).toBe(0);
  });

  it("gives the sides what they asked for and the rest to the viewport", () => {
    const widths = resolveWidths(DEFAULT_LAYOUT, ROOM);
    expect(widths.map).toBe(400);
    expect(widths.settings).toBe(368);
    expect(widths.viewport).toBe(500);
    expect(widths.map + widths.viewport + widths.settings).toBe(ROOM);
  });

  it("takes a narrow row's shortfall from the side with the most slack", () => {
    // 1000 px of room: 88 px short of the two stated widths plus the
    // viewport's floor. The map has 160 px of slack and the settings 80, so
    // the map gives up two thirds of it and the viewport lands exactly on its
    // minimum rather than under it.
    const widths = resolveWidths(DEFAULT_LAYOUT, 1000);
    expect(widths.viewport).toBe(REGION_MIN_PX.viewport);
    expect(widths.map).toBe(341);
    expect(widths.settings).toBe(339);
    expect(widths.map + widths.viewport + widths.settings).toBe(1000);
  });

  it("lets the viewport go under its minimum when both sides are already at theirs", () => {
    const widths = resolveWidths(DEFAULT_LAYOUT, 800);
    expect(widths.map).toBe(REGION_MIN_PX.map);
    expect(widths.settings).toBe(REGION_MIN_PX.settings);
    expect(widths.viewport).toBe(800 - REGION_MIN_PX.map - REGION_MIN_PX.settings);
    expect(widths.viewport).toBeLessThan(REGION_MIN_PX.viewport);
  });

  it("never hands out a negative width, however narrow the row", () => {
    for (const room of [1, 60, 200, 400, 520]) {
      const widths = resolveWidths(DEFAULT_LAYOUT, room);
      expect(widths.map, `${room}`).toBeGreaterThanOrEqual(0);
      expect(widths.viewport, `${room}`).toBeGreaterThanOrEqual(0);
      expect(widths.settings, `${room}`).toBeGreaterThanOrEqual(0);
      expect(widths.map + widths.settings, `${room}`).toBeLessThanOrEqual(room);
    }
  });

  it("gives a collapsed column's room to the viewport and calls it invisible", () => {
    const widths = resolveWidths(setCollapsed(DEFAULT_LAYOUT, "map", true), ROOM);
    expect(widths.visible.map).toBe(false);
    expect(widths.map).toBe(0);
    expect(widths.settings).toBe(368);
    expect(widths.viewport).toBe(ROOM - 368);
  });

  it("gives a maximized region the whole row and nothing to the others", () => {
    const widths = resolveWidths(setMaximized(DEFAULT_LAYOUT, "viewport"), ROOM);
    expect(widths.viewport).toBe(ROOM);
    expect(widths.map).toBe(0);
    expect(widths.settings).toBe(0);
    expect(widths.visible).toEqual({ map: false, viewport: true, settings: false });

    const mapped = resolveWidths(setMaximized(DEFAULT_LAYOUT, "map"), ROOM);
    expect(mapped.map).toBe(ROOM);
    expect(mapped.visible).toEqual({ map: true, viewport: false, settings: false });
  });
});

describe("visibleRegions and boundaryVisible", () => {
  it("hides a divider whose own column is away", () => {
    const collapsedMap = setCollapsed(DEFAULT_LAYOUT, "map", true);
    expect(boundaryVisible(collapsedMap, "map")).toBe(false);
    expect(boundaryVisible(collapsedMap, "settings")).toBe(true);
  });

  it("hides both dividers while a region has the whole window", () => {
    const wide = setMaximized(DEFAULT_LAYOUT, "viewport");
    expect(boundaryVisible(wide, "map")).toBe(false);
    expect(boundaryVisible(wide, "settings")).toBe(false);
    expect(visibleRegions(wide).settings).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

describe("boundaries", () => {
  it("puts each divider where its column ends", () => {
    const widths = resolveWidths(DEFAULT_LAYOUT, ROOM);
    expect(boundaryPosition(widths, "map")).toBe(400);
    expect(boundaryPosition(widths, "settings")).toBe(ROOM - 368);
  });

  it("stops the map divider at the map's own maximum, or at the viewport's floor", () => {
    // At 1268 px the viewport's floor bites first: 1268 - 368 - 320 = 580.
    expect(boundaryRange(DEFAULT_LAYOUT, ROOM, "map")).toEqual({ min: 240, max: 580 });
    // On a wide screen the map's own maximum is what stops it.
    expect(boundaryRange(DEFAULT_LAYOUT, 2400, "map")).toEqual({
      min: 240,
      max: REGION_MAX_PX.map,
    });
  });

  it("mirrors the range for the settings divider, which grows leftwards", () => {
    const range = boundaryRange(DEFAULT_LAYOUT, ROOM, "settings");
    expect(range.max).toBe(ROOM - REGION_MIN_PX.settings);
    // 1268 - 400 - 320 = 548, under the 560 maximum, so the viewport's floor
    // is what limits the settings column here too.
    expect(range.min).toBe(ROOM - 548);
  });

  it("clamps a drag rather than letting a divider run past what it may do", () => {
    expect(setBoundaryPosition(DEFAULT_LAYOUT, ROOM, "map", 4000).sizes.map).toBe(580);
    expect(setBoundaryPosition(DEFAULT_LAYOUT, ROOM, "map", -50).sizes.map).toBe(240);
    // Dragging the settings divider right shrinks the settings column.
    expect(setBoundaryPosition(DEFAULT_LAYOUT, ROOM, "settings", 4000).sizes.settings).toBe(
      REGION_MIN_PX.settings,
    );
    expect(setBoundaryPosition(DEFAULT_LAYOUT, ROOM, "settings", 0).sizes.settings).toBe(548);
  });

  it("leaves the state alone when a drag would not move anything", () => {
    const state = DEFAULT_LAYOUT;
    expect(setBoundaryPosition(state, ROOM, "map", 400)).toBe(state);
    expect(setBoundaryPosition(state, ROOM, "map", Number.NaN)).toBe(state);
  });

  it("nudges by one step, and further with the large step", () => {
    expect(moveBoundary(DEFAULT_LAYOUT, ROOM, "map", KEYBOARD_STEP_PX).sizes.map).toBe(
      400 + KEYBOARD_STEP_PX,
    );
    expect(moveBoundary(DEFAULT_LAYOUT, ROOM, "map", -KEYBOARD_STEP_LARGE_PX).sizes.map).toBe(
      400 - KEYBOARD_STEP_LARGE_PX,
    );
    // The settings column grows when its divider goes left.
    expect(
      moveBoundary(DEFAULT_LAYOUT, ROOM, "settings", -KEYBOARD_STEP_PX).sizes.settings,
    ).toBe(368 + KEYBOARD_STEP_PX);
  });

  it("obeys the same clamp from the keyboard as from the pointer", () => {
    const wide = layout({ sizes: { map: 575, settings: 368 } });
    expect(moveBoundary(wide, ROOM, "map", KEYBOARD_STEP_PX).sizes.map).toBe(580);
  });

  it("resets one divider and leaves the other where it was", () => {
    const moved = layout({ sizes: { map: 300, settings: 500 } });
    const reset = resetBoundary(moved, "map");
    expect(reset.sizes.map).toBe(DEFAULT_SIZES.map);
    expect(reset.sizes.settings).toBe(500);
  });

  it("reports a whole percentage for aria-valuenow", () => {
    expect(boundaryPercent(400, 1000)).toBe(40);
    expect(boundaryPercent(0, 0)).toBe(0);
    expect(boundaryPercent(2000, 1000)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Collapse and maximize
// ---------------------------------------------------------------------------

describe("collapse and maximize", () => {
  it("toggles a side column", () => {
    const hidden = toggleCollapsed(DEFAULT_LAYOUT, "settings");
    expect(hidden.collapsed).toEqual({ map: false, settings: true });
    expect(toggleCollapsed(hidden, "settings").collapsed.settings).toBe(false);
  });

  it("restores the columns when the maximized one is asked to hide", () => {
    const wide = setMaximized(DEFAULT_LAYOUT, "map");
    const hidden = setCollapsed(wide, "map", true);
    expect(hidden.maximized).toBeNull();
    expect(hidden.collapsed.map).toBe(true);
  });

  it("un-hides the map when the map is maximized, so the control does what it says", () => {
    const hidden = setCollapsed(DEFAULT_LAYOUT, "map", true);
    const wide = setMaximized(hidden, "map");
    expect(wide.maximized).toBe("map");
    expect(wide.collapsed.map).toBe(false);
  });

  it("keeps the OTHER side's hidden state across a maximize and back", () => {
    const hidden = setCollapsed(DEFAULT_LAYOUT, "settings", true);
    const wide = toggleMaximized(hidden, "viewport");
    const back = toggleMaximized(wide, "viewport");
    expect(back.maximized).toBeNull();
    expect(back.collapsed.settings).toBe(true);
  });

  it("switches straight from one maximized region to the other", () => {
    const wide = setMaximized(DEFAULT_LAYOUT, "viewport");
    expect(toggleMaximized(wide, "map").maximized).toBe("map");
  });
});

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

describe("the payload", () => {
  it("is nothing at all for a default layout", () => {
    expect(layoutPayload(DEFAULT_LAYOUT)).toBeNull();
  });

  it("names only what differs", () => {
    expect(layoutPayload(layout({ sizes: { map: 520, settings: DEFAULT_SIZES.settings } }))).toEqual(
      { map: 520 },
    );
    expect(layoutPayload(setCollapsed(DEFAULT_LAYOUT, "settings", true))).toEqual({
      collapsed: ["settings"],
    });
    expect(layoutPayload(setMaximized(DEFAULT_LAYOUT, "viewport"))).toEqual({
      maximized: "viewport",
    });
  });

  it("round trips a layout that moved every part of itself", () => {
    const state = setCollapsed(
      layout({ sizes: { map: 512, settings: 300 } }),
      "settings",
      true,
    );
    const back = layoutFromPayload(layoutPayload(state));
    expect(back).not.toBeNull();
    expect(sameLayout(back as LayoutState, state)).toBe(true);
  });

  it("clamps a sender's width instead of refusing it", () => {
    const back = layoutFromPayload({ map: 4000 });
    expect(back?.sizes.map).toBe(REGION_MAX_PX.map);
  });

  it("cannot describe a state the interface itself cannot reach", () => {
    // Maximized AND collapsed would leave a row with nothing in it.
    const back = layoutFromPayload({ collapsed: ["map"], maximized: "map" });
    expect(back?.maximized).toBe("map");
    expect(back?.collapsed.map).toBe(false);
  });

  it("never throws, and says nothing rather than something wrong", () => {
    for (const junk of [null, undefined, 3, "map", [], {}, { map: "wide" }, { collapsed: 7 }]) {
      expect(layoutFromPayload(junk), JSON.stringify(junk) ?? "undefined").toBeNull();
    }
    expect(layoutFromPayload({ maximized: "settings" })).toBeNull();
    expect(layoutFromPayload({ collapsed: ["nowhere"] })).toBeNull();
  });

  it("ignores a key it does not know while keeping the ones it does", () => {
    const back = layoutFromPayload({ map: 300, inspector: 200 });
    expect(back?.sizes.map).toBe(300);
    expect(back?.sizes.settings).toBe(DEFAULT_SIZES.settings);
  });
});

// ---------------------------------------------------------------------------
// Per device
// ---------------------------------------------------------------------------

describe("localStorage", () => {
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };

  beforeEach(() => {
    items.clear();
    vi.stubGlobal("window", { localStorage: storage });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a moved layout and reads it back", () => {
    const state = layout({ sizes: { map: 512, settings: 300 } });
    storeLayout(state);
    expect(items.get(LAYOUT_STORAGE_KEY)).toBe(JSON.stringify({ map: 512, settings: 300 }));
    expect(sameLayout(loadStoredLayout(), state)).toBe(true);
  });

  it("removes the key for a default layout, so a reset leaves no trace", () => {
    items.set(LAYOUT_STORAGE_KEY, JSON.stringify({ map: 512 }));
    storeLayout(DEFAULT_LAYOUT);
    expect(items.has(LAYOUT_STORAGE_KEY)).toBe(false);
  });

  it("falls back to the default on anything unusable", () => {
    items.set(LAYOUT_STORAGE_KEY, "{not json");
    expect(sameLayout(loadStoredLayout(), DEFAULT_LAYOUT)).toBe(true);
    items.set(LAYOUT_STORAGE_KEY, JSON.stringify({ nothing: true }));
    expect(sameLayout(loadStoredLayout(), DEFAULT_LAYOUT)).toBe(true);
  });

  it("survives a storage that throws, the way Safari's private mode does", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
        removeItem: () => {
          throw new Error("denied");
        },
      },
    });
    expect(() => storeLayout(layout({ sizes: { map: 512, settings: 300 } }))).not.toThrow();
    expect(sameLayout(loadStoredLayout(), DEFAULT_LAYOUT)).toBe(true);
  });

  it("does nothing at all on the server, where there is no storage", () => {
    vi.stubGlobal("window", undefined);
    expect(() => storeLayout(DEFAULT_LAYOUT)).not.toThrow();
    expect(sameLayout(loadStoredLayout(), DEFAULT_LAYOUT)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DECISIONS [V3.1-O6]: it travels with the design, and it is not a setting
// ---------------------------------------------------------------------------

describe("the layout rides in a link and a project file, outside PrintParams", () => {
  const MOVED: LayoutState = setCollapsed(
    layout({ sizes: { map: 512, settings: 300 } }),
    "settings",
    true,
  );

  beforeEach(() => {
    resetLayoutStore();
  });

  it("is not a print parameter, so it cannot reach a pipeline stage", () => {
    for (const key of ["layout", "sizes", "collapsed", "maximized"]) {
      expect(Object.hasOwn(PRINT_PARAM_SPEC, key), key).toBe(false);
    }
    /*
      The generated leaf list is what the pipeline registry's claims and the
      settings diff are both built from (`lib/settingsDiff.ts` walks exactly
      these paths). A layout leaf appearing here would mean the layout had
      become a setting: it would hash into a stage, and it would show up in the
      changes counter. There is none, and that is the whole of [V3.1-O6].
    */
    const layoutish = PRINT_PARAM_LEAF_PATHS.filter((path) =>
      /(^|\.)(layout|sizes|collapsed|maximized)(\.|$)/.test(path),
    );
    expect(layoutish, "a layout field reached the frozen contract").toEqual([]);
  });

  it("does not count as a change from default in the settings diff", () => {
    const params = defaultPrintParams();
    useLayoutStore.getState().adopt(MOVED);
    // A moved layout over untouched settings: the diff is still empty.
    expect(paramsDiff(params)).toEqual({});
    // ...and in the link it is a SIBLING of the settings block, never a member
    // of it, which is what keeps it out of every consumer that reads `p`.
    const body = bodyOf(encodeShare(REQUEST, params));
    expect(body.p).toEqual({});
    expect(body.l).toEqual(layoutPayload(MOVED));
  });

  it("adds nothing to a link at all while the layout is the default", () => {
    const body = bodyOf(encodeShare(REQUEST, defaultPrintParams()));
    expect(Object.hasOwn(body, "l")).toBe(false);
  });

  it("round trips through a share link", () => {
    const params = defaultPrintParams();
    useLayoutStore.getState().adopt(MOVED);
    const payload = encodeShare(REQUEST, params);

    resetLayoutStore();
    const decoded = decodeShare(payload);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.layout).not.toBeNull();
    expect(sameLayout(decoded.layout as LayoutState, MOVED)).toBe(true);
    // The link RESTORES it, rather than handing it back for a caller to apply.
    expect(sameLayout(useLayoutStore.getState(), MOVED)).toBe(true);
    // ...and the settings it carries are untouched by any of that.
    expect(decoded.params.plate_mm).toBe(params.plate_mm);
  });

  it("leaves this browser's layout alone when a link does not name one", () => {
    const payload = encodeShare(REQUEST, defaultPrintParams(), null);
    useLayoutStore.getState().adopt(MOVED);
    const decoded = decodeShare(payload);
    expect(decoded.ok && decoded.layout).toBeNull();
    expect(sameLayout(useLayoutStore.getState(), MOVED)).toBe(true);
  });

  it("never lets a damaged layout block refuse a link, or move the columns", () => {
    // A hand-edited payload whose layout block is nonsense: the link still
    // applies, and the layout simply does not. This is the opposite of the
    // rule an unknown SETTING gets, and deliberately so: a half-applied model
    // is invisible to the user, a layout that stayed put is not.
    const decoded = decodeShare(
      linkFor(JSON.stringify({ r: REQUEST, p: {}, l: { map: "wide" } })),
    );
    expect(decoded.ok).toBe(true);
    expect(decoded.ok && decoded.layout).toBeNull();
    expect(sameLayout(useLayoutStore.getState(), DEFAULT_LAYOUT)).toBe(true);
  });

  it("restores a link written by a build that knows a region this one does not", () => {
    const decoded = decodeShare(
      linkFor(JSON.stringify({ r: REQUEST, p: {}, l: { map: 512, inspector: 240 } })),
    );
    expect(decoded.ok).toBe(true);
    expect(useLayoutStore.getState().sizes.map).toBe(512);
  });

  /**
   * The settings a project file carries here.
   *
   * A project file carries the WHOLE `PrintParams` object rather than a diff,
   * so it also carries `schema_version`, and this suite is about the layout
   * block beside it. The version is therefore stated rather than defaulted, so
   * a change to the contract's own default moves the tests that own it and not
   * these.
   */
  const FILE_PARAMS = { ...defaultPrintParams(), schema_version: 3 as const };

  it("round trips through a project file", () => {
    useLayoutStore.getState().adopt(MOVED);
    const project = buildProject(LOCATION, FILE_PARAMS, new Date("2026-09-03T00:00:00Z"));
    expect(project.layout).toEqual(layoutPayload(MOVED));
    // A sibling of `params`, never a member of it.
    expect(Object.keys(project.params)).not.toContain("layout");

    resetLayoutStore();
    const loaded = parseProject(serializeProject(project));
    expect(loaded.ok ? "ok" : loaded.reason).toBe("ok");
    if (!loaded.ok) return;
    expect(sameLayout(loaded.layout as LayoutState, MOVED)).toBe(true);
    expect(sameLayout(useLayoutStore.getState(), MOVED)).toBe(true);
  });

  it("writes no layout block at all for a default layout, so an old reader sees the file it always saw", () => {
    const project = buildProject(LOCATION, FILE_PARAMS);
    expect(project.layout).toBeUndefined();
    expect(Object.hasOwn(project, "layout")).toBe(false);
  });

  it("leaves this browser's layout alone when a project file does not name one", () => {
    const project = buildProject(LOCATION, FILE_PARAMS, new Date(), null);
    useLayoutStore.getState().adopt(MOVED);
    const loaded = parseProject(serializeProject(project));
    expect(loaded.ok ? "ok" : loaded.reason).toBe("ok");
    expect(loaded.ok && loaded.layout).toBeNull();
    expect(sameLayout(useLayoutStore.getState(), MOVED)).toBe(true);
  });
});
