/**
 * Undo/redo: coalescing, step-back, one-step-per-composite-action, and
 * "undo never refetches unless the pin/radius/rotation actually moved"
 * ([V3-P6]).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PRINT_PARAMS, defaultPrintParams } from "@/lib/contracts";
import { initialExportState } from "@/lib/exportFlow";
import {
  IDLE_PLACE_DETECT,
  INITIAL_LOCATION,
  initialPipelineState,
  useEditorStore,
} from "./editor";
import {
  HISTORY_CAP,
  HISTORY_COALESCE_MS,
  describeChange,
  initHistory,
  jumpToHistory,
  redoHistory,
  stopHistoryForTests,
  undoHistory,
  useHistoryStore,
  type HistorySnapshot,
} from "./history";

let fetchSpy: ReturnType<typeof vi.fn>;

function resetEditorStore(): void {
  useEditorStore.setState({
    location: { ...INITIAL_LOCATION },
    params: defaultPrintParams(),
    scene: { status: "idle", graph: null, message: null, request: null, hash: null, stale: false },
    pipeline: { ...initialPipelineState },
    exportState: { ...initialExportState },
    placeDetect: { ...IDLE_PLACE_DETECT },
    presetChosen: false,
  });
}

beforeEach(() => {
  resetEditorStore();
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  vi.useFakeTimers();
});

afterEach(() => {
  stopHistoryForTests();
  useEditorStore.getState().cancelPipeline();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const snap = (): HistorySnapshot => ({
  location: useEditorStore.getState().location,
  params: useEditorStore.getState().params,
});

describe("describeChange", () => {
  it("labels a radius change", () => {
    const before = snap();
    const after: HistorySnapshot = {
      location: { ...before.location, radius_m: 1200 },
      params: before.params,
    };
    expect(describeChange(before, after)).toEqual({
      path: "location.radius_m",
      label: "Radius 900 m to 1200 m",
    });
  });

  it("labels a rotation change", () => {
    const before = snap();
    const after: HistorySnapshot = {
      location: { ...before.location, rotation_deg: 45 },
      params: before.params,
    };
    expect(describeChange(before, after)).toEqual({
      path: "location.rotation_deg",
      label: "Rotation 0° to 45°",
    });
  });

  it("labels a pin move", () => {
    const before = snap();
    const after: HistorySnapshot = {
      location: { ...before.location, lat: 48.8566, lon: 2.3522, preset_id: null },
      params: before.params,
    };
    expect(describeChange(before, after)).toEqual({ path: "location.pin", label: "Pin moved" });
  });

  it("labels a preset pick", () => {
    const before = snap();
    const after: HistorySnapshot = {
      location: { ...before.location, preset_id: "paris-eiffel" },
      params: before.params,
    };
    expect(describeChange(before, after).path).toBe("location.preset");
    expect(describeChange(before, after).label).toContain("Paris");
  });

  it("labels a scalar params change", () => {
    const before = snap();
    const after: HistorySnapshot = {
      location: before.location,
      params: { ...before.params, plate_mm: 200 },
    };
    expect(describeChange(before, after)).toEqual({
      path: "params.plate_mm",
      label: "Plate mm 180 mm to 200 mm",
    });
  });

  it("labels a nested params change by its changed leaf", () => {
    const before = snap();
    const after: HistorySnapshot = {
      location: before.location,
      params: { ...before.params, north_arrow: { ...DEFAULT_PRINT_PARAMS.north_arrow!, enabled: true } },
    };
    const result = describeChange(before, after);
    expect(result.path).toBe("params.north_arrow");
    expect(result.label).toContain("North arrow");
    expect(result.label).toContain("off to on");
  });

  it("falls back to 'Settings changed' when nothing this function recognises differs", () => {
    const before = snap();
    const after: HistorySnapshot = { location: before.location, params: before.params };
    expect(describeChange(before, after)).toEqual({ path: "composite", label: "Settings changed" });
  });
});

describe("useHistoryStore.record / undo / redo / jumpTo", () => {
  it("starts with one entry once reset, undo/redo both unavailable", () => {
    const initial = snap();
    useHistoryStore.getState().reset(initial);
    const state = useHistoryStore.getState();
    expect(state.entries).toHaveLength(1);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
  });

  it("records a step and makes undo available", () => {
    const a = snap();
    useHistoryStore.getState().reset(a);
    const b: HistorySnapshot = { location: { ...a.location, radius_m: 1200 }, params: a.params };
    useHistoryStore.getState().record(a, b);
    const state = useHistoryStore.getState();
    expect(state.entries).toHaveLength(2);
    expect(state.canUndo).toBe(true);
    expect(state.canRedo).toBe(false);
  });

  it("coalesces two records of the SAME path inside the coalesce window into one entry", () => {
    const a = snap();
    useHistoryStore.getState().reset(a);
    const b: HistorySnapshot = { location: { ...a.location, radius_m: 1000 }, params: a.params };
    const c: HistorySnapshot = { location: { ...a.location, radius_m: 1200 }, params: a.params };
    useHistoryStore.getState().record(a, b, 1000);
    useHistoryStore.getState().record(b, c, 1000 + HISTORY_COALESCE_MS - 1);
    const state = useHistoryStore.getState();
    expect(state.entries).toHaveLength(2);
    expect(state.entries[1].snapshot.location.radius_m).toBe(1200);
    expect(state.entries[1].label).toContain("1200 m");
  });

  it("does NOT coalesce once the window has elapsed", () => {
    const a = snap();
    useHistoryStore.getState().reset(a);
    const b: HistorySnapshot = { location: { ...a.location, radius_m: 1000 }, params: a.params };
    const c: HistorySnapshot = { location: { ...a.location, radius_m: 1200 }, params: a.params };
    useHistoryStore.getState().record(a, b, 1000);
    useHistoryStore.getState().record(b, c, 1000 + HISTORY_COALESCE_MS + 1);
    expect(useHistoryStore.getState().entries).toHaveLength(3);
  });

  it("does not coalesce two DIFFERENT paths even inside the window", () => {
    const a = snap();
    useHistoryStore.getState().reset(a);
    const b: HistorySnapshot = { location: { ...a.location, radius_m: 1000 }, params: a.params };
    const c: HistorySnapshot = { location: { ...b.location, rotation_deg: 30 }, params: b.params };
    useHistoryStore.getState().record(a, b, 1000);
    useHistoryStore.getState().record(b, c, 1000 + 10);
    expect(useHistoryStore.getState().entries).toHaveLength(3);
  });

  it("undo/redo step through entries and toggle canUndo/canRedo correctly", () => {
    const a = snap();
    useHistoryStore.getState().reset(a);
    const b: HistorySnapshot = { location: { ...a.location, radius_m: 1200 }, params: a.params };
    useHistoryStore.getState().record(a, b, 0);

    expect(useHistoryStore.getState().undo()).toEqual(a);
    expect(useHistoryStore.getState().canUndo).toBe(false);
    expect(useHistoryStore.getState().canRedo).toBe(true);

    expect(useHistoryStore.getState().redo()).toEqual(b);
    expect(useHistoryStore.getState().canUndo).toBe(true);
    expect(useHistoryStore.getState().canRedo).toBe(false);
  });

  it("undo at the start and redo at the tip both return null", () => {
    const a = snap();
    useHistoryStore.getState().reset(a);
    expect(useHistoryStore.getState().undo()).toBeNull();
    expect(useHistoryStore.getState().redo()).toBeNull();
  });

  it("a new record after an undo drops the redo branch", () => {
    const a = snap();
    useHistoryStore.getState().reset(a);
    const b: HistorySnapshot = { location: { ...a.location, radius_m: 1200 }, params: a.params };
    const c: HistorySnapshot = { location: { ...a.location, rotation_deg: 90 }, params: a.params };
    useHistoryStore.getState().record(a, b, 0);
    useHistoryStore.getState().undo();
    useHistoryStore.getState().record(a, c, 10_000);
    const state = useHistoryStore.getState();
    expect(state.entries).toHaveLength(2);
    expect(state.entries[1].snapshot).toEqual(c);
    expect(state.canRedo).toBe(false);
  });

  it("jumpTo moves the cursor straight to an arbitrary entry", () => {
    const a = snap();
    useHistoryStore.getState().reset(a);
    const b: HistorySnapshot = { location: { ...a.location, radius_m: 1200 }, params: a.params };
    const c: HistorySnapshot = { location: { ...a.location, radius_m: 1500 }, params: a.params };
    useHistoryStore.getState().record(a, b, 0);
    useHistoryStore.getState().record(b, c, 10_000);
    expect(useHistoryStore.getState().jumpTo(1)).toEqual(b);
    expect(useHistoryStore.getState().cursor).toBe(1);
    expect(useHistoryStore.getState().jumpTo(99)).toBeNull();
  });

  it(`caps the stack at ${HISTORY_CAP} entries, dropping the oldest`, () => {
    let current = snap();
    useHistoryStore.getState().reset(current);
    for (let i = 0; i < HISTORY_CAP + 10; i += 1) {
      const next: HistorySnapshot = {
        location: { ...current.location, radius_m: 300 + (i % 26) * 100 },
        params: current.params,
      };
      // Each record is far enough apart in time that none coalesce.
      useHistoryStore.getState().record(current, next, i * 10_000);
      current = next;
    }
    const state = useHistoryStore.getState();
    expect(state.entries.length).toBeLessThanOrEqual(HISTORY_CAP);
    expect(state.entries[state.entries.length - 1].snapshot).toEqual(current);
  });
});

describe("initHistory: wired to the real editor store", () => {
  it("records exactly one entry for one setRadius call", () => {
    initHistory();
    useEditorStore.getState().setRadius(1200);
    expect(useHistoryStore.getState().entries).toHaveLength(2);
    expect(useHistoryStore.getState().canUndo).toBe(true);
  });

  it("coalesces a burst of setRadius calls within the window into one entry", () => {
    initHistory();
    useEditorStore.getState().setRadius(1000);
    vi.advanceTimersByTime(100);
    useEditorStore.getState().setRadius(1100);
    vi.advanceTimersByTime(100);
    useEditorStore.getState().setRadius(1200);
    expect(useHistoryStore.getState().entries).toHaveLength(2);
    expect(useEditorStore.getState().location.radius_m).toBe(1200);
  });

  it("a single composite action (resetParams / applyShared) counts as ONE step", () => {
    initHistory();
    useEditorStore.getState().setParam("plate_mm", 200);
    useEditorStore.getState().setParam("frame", true);
    expect(useHistoryStore.getState().entries.length).toBeGreaterThanOrEqual(3);
    const before = useHistoryStore.getState().entries.length;
    // resetParams touches many PrintParams fields in one `set()` call.
    useEditorStore.getState().resetParams();
    expect(useHistoryStore.getState().entries).toHaveLength(before + 1);
  });

  it("transient state (scene status, pipeline status, export) is never recorded", () => {
    initHistory();
    const before = useHistoryStore.getState().entries.length;
    useEditorStore.setState((state) => ({ scene: { ...state.scene, status: "loading" } }));
    useEditorStore.setState((state) => ({ pipeline: { ...state.pipeline, status: "running" } }));
    expect(useHistoryStore.getState().entries).toHaveLength(before);
  });

  it("undo/redo apply the snapshot back onto the editor store", () => {
    initHistory();
    useEditorStore.getState().setRadius(1200);
    vi.advanceTimersByTime(HISTORY_COALESCE_MS + 1);
    expect(useEditorStore.getState().location.radius_m).toBe(1200);

    expect(undoHistory()).toBe(true);
    expect(useEditorStore.getState().location.radius_m).toBe(900);

    expect(redoHistory()).toBe(true);
    expect(useEditorStore.getState().location.radius_m).toBe(1200);
  });

  it("undo at the start of history is a no-op that returns false", () => {
    initHistory();
    expect(undoHistory()).toBe(false);
  });

  it("jumpToHistory restores an arbitrary earlier step", () => {
    initHistory();
    useEditorStore.getState().setRadius(1000);
    vi.advanceTimersByTime(HISTORY_COALESCE_MS + 1);
    useEditorStore.getState().setRadius(1500);
    vi.advanceTimersByTime(HISTORY_COALESCE_MS + 1);
    expect(useHistoryStore.getState().entries).toHaveLength(3);
    expect(jumpToHistory(1)).toBe(true);
    expect(useEditorStore.getState().location.radius_m).toBe(1000);
  });

  it("undoing a PURE parameter change never refetches (no Overpass call)", async () => {
    initHistory();
    useEditorStore.getState().setParam("plate_mm", 220);
    vi.advanceTimersByTime(HISTORY_COALESCE_MS + 1);
    expect(useEditorStore.getState().scene.stale).toBe(false);

    undoHistory();
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useEditorStore.getState().params.plate_mm).toBe(180);
    // A pure-params undo must not mark the scene stale either: nothing about
    // the ground truth changed, only how it is being rendered.
    expect(useEditorStore.getState().scene.stale).toBe(false);
  });

  it("undoing a location change marks the scene stale but still never fetches by itself", async () => {
    initHistory();
    useEditorStore.getState().setRadius(1200);
    vi.advanceTimersByTime(HISTORY_COALESCE_MS + 1);
    useEditorStore.setState((state) => ({ scene: { ...state.scene, stale: false } }));

    undoHistory();
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useEditorStore.getState().location.radius_m).toBe(900);
    expect(useEditorStore.getState().scene.stale).toBe(true);
  });

  it("re-initHistory (Strict Mode double-mount) does not duplicate the subscription", () => {
    initHistory();
    initHistory();
    const before = useHistoryStore.getState().entries.length;
    useEditorStore.getState().setRadius(1200);
    expect(useHistoryStore.getState().entries).toHaveLength(before + 1);
  });
});

describe("share links and project loads still restore in one history step", () => {
  it("applyShared (both location and params changing) is one composite step", () => {
    initHistory();
    const before = useHistoryStore.getState().entries.length;
    useEditorStore.getState().applyShared(
      { ...useEditorStore.getState().location, radius_m: 1500 },
      { ...defaultPrintParams(), plate_mm: 220, city_label: "Paris" },
    );
    expect(useHistoryStore.getState().entries).toHaveLength(before + 1);
    expect(useEditorStore.getState().params.city_label).toBe("Paris");
  });

  it("applyProject (both location and params changing) is one composite step", () => {
    initHistory();
    const before = useHistoryStore.getState().entries.length;
    useEditorStore.getState().applyProject(
      { ...useEditorStore.getState().location, radius_m: 1500 },
      { ...defaultPrintParams(), plate_mm: 220, city_label: "Tokyo" },
    );
    expect(useHistoryStore.getState().entries).toHaveLength(before + 1);
    expect(useEditorStore.getState().params.city_label).toBe("Tokyo");
  });
});
