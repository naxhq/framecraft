/**
 * Slider commit gating.
 *
 * The radius and rotation sliders commit to `store.generate()`, which is a
 * POST /scene and, away from a preset, a live Overpass query. Before this
 * gate the input wired `onKeyUp={onCommit}` with no change detection, so
 * tabbing INTO the radius slider, tabbing on into the rotation slider and
 * releasing Shift while focused issued three server hits with zero value
 * change -- and five quick arrow taps issued five.
 *
 * `createCommitGate` and `isValueChangingKey` are the exact functions
 * `Controls.tsx` wires to `onChange` / `onPointerUp` / `onKeyUp`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PRINT_PARAMS } from "@/lib/contracts";
import { INITIAL_LOCATION, useEditorStore } from "@/store/editor";
import {
  COMMIT_DEBOUNCE_MS,
  createCommitGate,
  isValueChangingKey,
} from "./Controls";

describe("isValueChangingKey", () => {
  it("accepts the keys a range input actually responds to", () => {
    for (const key of [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ]) {
      expect(isValueChangingKey({ key })).toBe(true);
    }
  });

  it("ignores navigation, modifiers and chords", () => {
    for (const key of ["Tab", "Shift", "Control", "Alt", "Meta", "Escape", "Enter", "a"]) {
      expect(isValueChangingKey({ key })).toBe(false);
    }
    expect(isValueChangingKey({ key: "ArrowRight", ctrlKey: true })).toBe(false);
    expect(isValueChangingKey({ key: "ArrowRight", metaKey: true })).toBe(false);
    expect(isValueChangingKey({ key: "ArrowRight", altKey: true })).toBe(false);
  });
});

describe("createCommitGate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not commit when nothing changed", () => {
    const run = vi.fn();
    const gate = createCommitGate(run);
    gate.commit();
    gate.commit();
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS * 4);
    expect(run).not.toHaveBeenCalled();
  });

  it("commits once after a real change", () => {
    const run = vi.fn();
    const gate = createCommitGate(run);
    gate.markDirty();
    gate.commit();
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(1);

    // A second release with no further change must not commit again.
    gate.commit();
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS * 4);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst of arrow taps into one commit", () => {
    const run = vi.fn();
    const gate = createCommitGate(run);
    for (let i = 0; i < 5; i += 1) {
      gate.markDirty();
      gate.commit();
      vi.advanceTimersByTime(60);
    }
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("commits again after the next change", () => {
    const run = vi.fn();
    const gate = createCommitGate(run);
    gate.markDirty();
    gate.commit();
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS);
    gate.markDirty();
    gate.commit();
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("drops a pending commit on unmount", () => {
    const run = vi.fn();
    const gate = createCommitGate(run);
    gate.markDirty();
    gate.commit();
    gate.cancel();
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS * 4);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("keyboard navigation through the Location sliders", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    useEditorStore.setState({
      location: { ...INITIAL_LOCATION },
      params: { ...DEFAULT_PRINT_PARAMS },
      scene: { status: "idle", graph: null, message: null, request: null, stale: false },
    });
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** The radius slider exactly as ParamPanel wires it. */
  const wire = () => {
    const store = useEditorStore.getState();
    const gate = createCommitGate(() => void store.generate());
    return {
      change: (value: number) => {
        gate.markDirty();
        store.setRadius(value);
      },
      keyUp: (key: string) => {
        if (isValueChangingKey({ key })) gate.commit();
      },
      pointerUp: () => gate.commit(),
    };
  };

  it("costs zero requests when the slider is only tabbed through", () => {
    const slider = wire();
    slider.keyUp("Tab");
    slider.keyUp("Shift");
    slider.keyUp("Tab");
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS * 4);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useEditorStore.getState().location.radius_m).toBe(INITIAL_LOCATION.radius_m);
  });

  it("costs zero requests when the pointer is pressed without dragging", () => {
    const slider = wire();
    slider.pointerUp();
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS * 4);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("costs one request for five arrow taps", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ elements: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const slider = wire();
    for (let i = 0; i < 5; i += 1) {
      slider.change(900 + (i + 1) * 10);
      slider.keyUp("ArrowRight");
      vi.advanceTimersByTime(60);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    // The commit gate's own timer is the only thing under test; everything
    // after it (ingest -> the engine worker's in-page fallback -> Overpass'
    // own cache lookup -> `fetch`) is a real Promise chain with several
    // microtask hops before the request actually goes out, so the fake-timer
    // advance has to let those settle too (`...Async` flushes microtasks
    // between each due timer, `advanceTimersByTime` does not).
    await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().location.radius_m).toBe(950);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    // The request body is now the Overpass QL query text (never a
    // `POST /scene` JSON payload): the radius is baked into its bbox, not a
    // JSON field, so this asserts on the query text itself.
    expect(String(init.body)).toContain("[out:json]");
  });
});
