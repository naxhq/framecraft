/**
 * TERRAIN group wiring: `store/editor.ts`'s debounced DEM fetch
 * (`scheduleTerrainJob`/`runTerrainJob`), phase 3.
 *
 * A separate file from `store/editor.test.ts` on purpose: `vi.mock`ing
 * `lib/engine/terrain/tiles` here cannot leak into that file's own tests --
 * vitest gives each test file its own module registry -- and this file can
 * use fake timers freely without touching the real-timer debounce cleanup
 * the rest of the store suite relies on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPrintParams } from "@/lib/contracts";
import type { TerrainGrid } from "@/lib/engine/types";
import { terrainCache } from "@/lib/terrainCache";
import { INITIAL_LOCATION, initialTerrainState, useEditorStore } from "@/store/editor";

const fetchTerrainGridMock = vi.fn();
vi.mock("@/lib/engine/terrain/tiles", () => ({
  fetchTerrainGrid: (...args: unknown[]) => fetchTerrainGridMock(...args),
}));

function grid(rangeM: number): TerrainGrid {
  return {
    originEastM: -100,
    originNorthM: -100,
    cellM: 10,
    cols: 3,
    rows: 3,
    elevations: new Float32Array(9),
    rangeM,
    source: "test elevation source",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  terrainCache.clear();
  fetchTerrainGridMock.mockReset();
  useEditorStore.setState({
    location: { ...INITIAL_LOCATION },
    params: defaultPrintParams(),
    terrain: { ...initialTerrainState },
  });
});

afterEach(() => {
  useEditorStore.getState().cancelEngineJob();
  vi.useRealTimers();
});

describe("terrain fetch: on/off and debounce", () => {
  it("never fetches while the toggle is off, whatever else moves", async () => {
    useEditorStore.getState().setRadius(1200);
    useEditorStore.getState().setRotation(30);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchTerrainGridMock).not.toHaveBeenCalled();
    expect(useEditorStore.getState().terrain.status).toBe("idle");
  });

  it("fetches once enabled, only after the debounce settles", async () => {
    fetchTerrainGridMock.mockResolvedValue(grid(12));
    useEditorStore.getState().setNested("terrain", { enabled: true });
    expect(fetchTerrainGridMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchTerrainGridMock).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().terrain.status).toBe("ready");
    expect(useEditorStore.getState().terrain.grid?.rangeM).toBe(12);
  });

  it("passes the pin, radius and rotation through, not the whole location object", async () => {
    fetchTerrainGridMock.mockResolvedValue(grid(1));
    useEditorStore.getState().setPin(48.8584, 2.2945);
    useEditorStore.getState().setNested("terrain", { enabled: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchTerrainGridMock).toHaveBeenCalledWith(
      { lat: 48.8584, lon: 2.2945, radiusM: expect.any(Number), rotationDeg: expect.any(Number) },
      expect.objectContaining({ terrain: expect.objectContaining({ enabled: true }) }),
    );
  });

  it("coalesces a burst of pin/radius/rotation/exaggeration writes into one fetch", async () => {
    fetchTerrainGridMock.mockResolvedValue(grid(5));
    const store = useEditorStore.getState();
    store.setNested("terrain", { enabled: true });
    await vi.advanceTimersByTimeAsync(100);
    store.setRadius(1500);
    await vi.advanceTimersByTimeAsync(100);
    store.setParam("terrain_exaggeration", 2.0);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchTerrainGridMock).toHaveBeenCalledTimes(1);
  });

  it("never calls the global fetch directly: Overpass ingest is a separate path entirely", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    fetchTerrainGridMock.mockResolvedValue(grid(1));
    useEditorStore.getState().setNested("terrain", { enabled: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("terrain fetch: caching", () => {
  it("serves a repeat request for the same key from the cache, without fetching again", async () => {
    fetchTerrainGridMock.mockResolvedValue(grid(7));
    const store = useEditorStore.getState();
    store.setNested("terrain", { enabled: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchTerrainGridMock).toHaveBeenCalledTimes(1);

    store.setNested("terrain", { enabled: false });
    await vi.advanceTimersByTimeAsync(500);
    store.setNested("terrain", { enabled: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchTerrainGridMock).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().terrain.grid?.rangeM).toBe(7);
  });

  it("fetches again for a different radius, a different cache key", async () => {
    fetchTerrainGridMock.mockResolvedValueOnce(grid(1)).mockResolvedValueOnce(grid(2));
    const store = useEditorStore.getState();
    store.setNested("terrain", { enabled: true });
    await vi.advanceTimersByTimeAsync(500);
    store.setRadius(1800);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchTerrainGridMock).toHaveBeenCalledTimes(2);
    expect(useEditorStore.getState().terrain.grid?.rangeM).toBe(2);
  });
});

describe("terrain fetch: fails soft", () => {
  it("a null result (the fetcher's own fail-soft contract) records an error and leaves the model flat", async () => {
    fetchTerrainGridMock.mockResolvedValue(null);
    useEditorStore.getState().setNested("terrain", { enabled: true });
    await vi.advanceTimersByTimeAsync(500);
    const state = useEditorStore.getState();
    expect(state.terrain.status).toBe("error");
    expect(state.terrain.grid).toBeNull();
    expect(state.terrain.error).toBeTruthy();
  });

  it("a rejected promise fails soft too, never an uncaught rejection", async () => {
    fetchTerrainGridMock.mockRejectedValue(new Error("network down"));
    useEditorStore.getState().setNested("terrain", { enabled: true });
    await vi.advanceTimersByTimeAsync(500);
    const state = useEditorStore.getState();
    expect(state.terrain.status).toBe("error");
    expect(state.terrain.error).toContain("network down");
  });

  it("never marks the scene stale or touches bake state: this is not an ingest failure", async () => {
    fetchTerrainGridMock.mockResolvedValue(null);
    useEditorStore.setState((s) => ({ scene: { ...s.scene, stale: false } }));
    useEditorStore.getState().setNested("terrain", { enabled: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(useEditorStore.getState().scene.stale).toBe(false);
  });
});

describe("terrain fetch: turning it back off", () => {
  it("resets to idle and drops the grid", async () => {
    fetchTerrainGridMock.mockResolvedValue(grid(9));
    const store = useEditorStore.getState();
    store.setNested("terrain", { enabled: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(useEditorStore.getState().terrain.status).toBe("ready");

    store.setNested("terrain", { enabled: false });
    await vi.advanceTimersByTimeAsync(500);
    expect(useEditorStore.getState().terrain.status).toBe("idle");
    expect(useEditorStore.getState().terrain.grid).toBeNull();
  });
});

describe("terrain fetch: cancellation", () => {
  it("cancelEngineJob drops a pending terrain fetch, not only a pending bake", async () => {
    fetchTerrainGridMock.mockResolvedValue(grid(1));
    const store = useEditorStore.getState();
    store.setNested("terrain", { enabled: true });
    store.cancelEngineJob();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchTerrainGridMock).not.toHaveBeenCalled();
  });
});
