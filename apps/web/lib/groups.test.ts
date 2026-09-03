/**
 * The twelve groups, which ones start open, the state line each header shows,
 * and the persistence of the collapse record.
 *
 * The failure this file guards against is the one a `try { JSON.parse } catch`
 * usually still has: storage that is present but useless (a stray value, an old
 * key, a browser that throws on READ as well as on write) leaving the panel
 * with a partial record and every group rendering closed on a first visit.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PRINT_PARAMS, defaultPrintParams } from "./contracts";
import { controlsInGroup } from "./controlCatalog";
import {
  GROUPS,
  GROUP_IDS,
  GROUP_STORAGE_KEY,
  defaultCollapsed,
  groupSpec,
  loadCollapsed,
  mergeCollapsed,
  saveCollapsed,
  summariseGroup,
  type CollapsedGroups,
  type SummaryContext,
} from "./groups";

const CONTEXT: SummaryContext = { heroCount: 0, radiusM: 900, rotationDeg: 0 };

/** A localStorage stand-in with switchable failure modes. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: () => null,
    length: 0,
    read: (key: string) => data.get(key) ?? null,
  };
}

function withStorage(storage: unknown): void {
  vi.stubGlobal("window", { localStorage: storage });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the group table", () => {
  it("names the twelve groups the panel is built from", () => {
    // `regions` and `bridges` are new in this wave: both contract blocks were
    // read by the geometry stages and reachable through a share link with no
    // control anywhere (docs/handoff/v3-02-settings.md section 5).
    expect(GROUP_IDS).toEqual([
      "location",
      "scale",
      "buildings",
      "heights",
      "surface",
      "regions",
      "bridges",
      "terrain",
      "frame",
      "colour",
      "printer",
      "output",
    ]);
  });

  it("gives every group a title and a summary", () => {
    for (const group of GROUPS) {
      expect(group.title.length, group.id).toBeGreaterThan(0);
      expect(group.summary.length, group.id).toBeGreaterThan(0);
    }
  });

  it("gives every group at least one control, so no heading opens onto nothing", () => {
    for (const group of GROUPS) {
      expect(controlsInGroup(group.id).length, group.id).toBeGreaterThan(0);
    }
  });

  it("summarises what the group still contains", () => {
    // The Colour group's summary used to promise "One filament, or one per
    // part", which was the seven `part_colors` wells. Those are gone (Task 2,
    // DECISIONS [V3.1-P1-2]) and the group is now the filament-slot table, the
    // palette, the tint and the height gradient.
    const colour = GROUPS.find((group) => group.id === "colour");
    expect(colour?.summary).toContain("filament slot");
    // Likewise Surface: there is no planting control, only trees on the parks.
    const surface = GROUPS.find((group) => group.id === "surface");
    expect(surface?.summary).not.toContain("planting");
    for (const group of GROUPS) {
      expect(group.summary, group.id).not.toContain("—");
      expect(group.summary.toLowerCase(), group.id).not.toContain("bake");
    }
  });

  it("starts with only Location and Scale open", () => {
    // Twelve open groups is a 4000 px scroll on a 1280 screen. Everything else
    // states itself on its header instead (`summariseGroup`), so a closed group
    // can still be read. Output is not a settings group: it is the pinned
    // action area at the foot of the panel and its toggle folds the RESULTS.
    const collapsed = defaultCollapsed();
    expect(collapsed).toEqual({
      location: false,
      scale: false,
      buildings: true,
      heights: true,
      surface: true,
      regions: true,
      bridges: true,
      terrain: true,
      frame: true,
      colour: true,
      printer: true,
      output: false,
    });
    const open = GROUPS.filter((group) => !group.collapsedByDefault).map((group) => group.id);
    expect(open).toEqual(["location", "scale", "output"]);
  });

  it("looks a group up by id and refuses one it does not have", () => {
    expect(groupSpec("regions").title).toBe("Surface depths");
    expect(() => groupSpec("nope" as never)).toThrow(/no group named/);
  });
});

describe("the header state line", () => {
  it("gives every group a line computed from the parameters, not a fixed string", () => {
    const defaults = defaultPrintParams();
    for (const group of GROUPS) {
      const line = summariseGroup(group.id, defaults, CONTEXT);
      expect(line.length, group.id).toBeGreaterThan(0);
      expect(line, group.id).not.toContain("—");
      // Never the standing summary said twice.
      expect(line, group.id).not.toBe(group.summary);
    }
  });

  it("moves when the parameter it names moves", () => {
    const defaults = defaultPrintParams();
    const moved = { ...defaults, plate_mm: 220, water: false, frame: false };
    expect(summariseGroup("scale", defaults, CONTEXT)).toContain("180 mm plate");
    expect(summariseGroup("scale", moved, CONTEXT)).toContain("220 mm plate");
    expect(summariseGroup("surface", defaults, CONTEXT)).toContain("water");
    expect(summariseGroup("surface", moved, CONTEXT)).toContain("no water");
    expect(summariseGroup("frame", moved, CONTEXT)).toBe("no frame, the city runs to the edge");
  });

  it("keeps the hero count the panel header has always shown", () => {
    // `e2e/ui.spec.ts` and `e2e/share.spec.ts` both read this off the header
    // after picking a building in the 3D preview.
    expect(summariseGroup("buildings", defaultPrintParams(), { ...CONTEXT, heroCount: 1 })).toContain(
      "1/12 heroes",
    );
  });

  it("reads the two new groups off their own contract blocks", () => {
    const defaults = defaultPrintParams();
    expect(summariseGroup("regions", defaults, CONTEXT)).toBe(
      "roads 0.6 mm deep, water 1 mm, rail 6 m wide",
    );
    expect(summariseGroup("bridges", defaults, CONTEXT)).toBe(
      "on, 1 mm clearance, abutments",
    );
    const off = { ...defaults, bridges: { ...DEFAULT_PRINT_PARAMS.bridges, enabled: false } };
    expect(summariseGroup("bridges", off, CONTEXT)).toBe("off, everything laid at ground level");
  });

  it("says what an absent v3 block would build, not that it is missing", () => {
    // A v1 payload carries no `regions`, no `bridges` and no `heights`; the
    // engine falls back to the contract defaults, so the header has to say what
    // the engine will do rather than "not set".
    const v1 = { ...defaultPrintParams(), regions: undefined, bridges: undefined };
    expect(summariseGroup("regions", v1, CONTEXT)).toBe(
      "roads 0.6 mm deep, water 1 mm, rail 6 m wide",
    );
    expect(summariseGroup("bridges", v1, CONTEXT)).toBe("on, 1 mm clearance, abutments");
  });
});

describe("mergeCollapsed", () => {
  it("falls back to the defaults for anything that is not an object", () => {
    for (const raw of [null, undefined, 3, "open", true, [], [1, 2]]) {
      expect(mergeCollapsed(raw)).toEqual(defaultCollapsed());
    }
  });

  it("keeps the defaults for groups the stored value does not mention", () => {
    const merged = mergeCollapsed({ location: true });
    expect(merged.location).toBe(true);
    // ...and every other group still has its default, not `undefined`.
    expect(merged.scale).toBe(false);
    expect(merged.frame).toBe(true);
    expect(Object.keys(merged).sort()).toEqual([...GROUP_IDS].sort());
  });

  it("ignores non-boolean and unknown keys", () => {
    const merged = mergeCollapsed({
      location: "yes",
      colour: 0,
      nonsense: true,
    });
    expect(merged.location).toBe(false);
    expect(merged.colour).toBe(true);
    expect("nonsense" in merged).toBe(false);
  });
});

describe("loadCollapsed", () => {
  it("returns the defaults with no stored value", () => {
    withStorage(fakeStorage());
    expect(loadCollapsed()).toEqual(defaultCollapsed());
  });

  it("returns the defaults for a corrupt stored value", () => {
    withStorage(fakeStorage({ [GROUP_STORAGE_KEY]: "{not json" }));
    expect(loadCollapsed()).toEqual(defaultCollapsed());
  });

  it("returns the defaults when reading throws (private mode)", () => {
    withStorage({
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => undefined,
    });
    expect(loadCollapsed()).toEqual(defaultCollapsed());
  });

  it("returns the defaults with no window at all (server render)", () => {
    vi.stubGlobal("window", undefined);
    expect(loadCollapsed()).toEqual(defaultCollapsed());
  });

  it("round-trips a real state through save and load", () => {
    const storage = fakeStorage();
    withStorage(storage);
    const state: CollapsedGroups = {
      ...defaultCollapsed(),
      location: true,
      colour: false,
    };
    saveCollapsed(state);
    expect(storage.read(GROUP_STORAGE_KEY)).toBeTruthy();
    expect(loadCollapsed()).toEqual(state);
  });
});

describe("saveCollapsed", () => {
  it("does not throw when storage refuses to write", () => {
    withStorage({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(() => saveCollapsed(defaultCollapsed())).not.toThrow();
  });

  it("does nothing, and does not throw, without a window", () => {
    vi.stubGlobal("window", undefined);
    expect(() => saveCollapsed(defaultCollapsed())).not.toThrow();
  });
});
