/**
 * The viewport's presentation rule.
 *
 * The v3 rule took the engine geometry OFF the screen the moment anything went
 * stale, and put an approximation in its place -- which is how a frame-profile
 * click read as "nothing happened": the only layer that had ever drawn a
 * profile unmounted, four constant boxes took over, and seven seconds later a
 * frame came back that differed by tenths of a millimetre. There is no
 * approximation any more, so the rule these tests pin is the opposite one: the
 * meshes stay, and the viewport SAYS they are behind.
 */

import { describe, expect, it } from "vitest";

import type { EngineResult, RegionMesh } from "./engine/types";
import { freshEngineResult, previewView, type PreviewSource } from "./enginePreview";

const RESULT = { regions: [] } as unknown as EngineResult;

function mesh(): RegionMesh {
  return {
    region: "base",
    positions: new Float64Array([0, 0, 0, 10, 0, 0, 10, 10, 0]),
    indices: new Uint32Array([0, 1, 2]),
    volumeMm3: 1,
    bbox: { min: [0, 0, 0], max: [10, 10, 0] },
    bodies: 1,
    slot: 1,
    colorHex: "#D8D3C6",
  };
}

function source(over: Partial<PreviewSource> = {}): PreviewSource {
  return {
    status: "ready",
    stale: false,
    regions: new Map([["base", mesh()]]),
    result: RESULT,
    ...over,
  };
}

describe("previewView", () => {
  it("shows the meshes plainly when they describe the controls on screen", () => {
    expect(previewView(source())).toEqual({ phase: "current", dimmed: false, overlay: false });
  });

  it("keeps the previous meshes on screen, dimmed, while a run is in flight", () => {
    const view = previewView(source({ status: "running", stale: true }));
    expect(view).toEqual({ phase: "building", dimmed: true, overlay: true });
  });

  it("dims across the debounce too, so a write does not flash bright-dim-bright", () => {
    // A parameter write marks the result stale immediately; the run only
    // starts PIPELINE_DEBOUNCE_MS later. The model is already behind.
    const view = previewView(source({ status: "ready", stale: true }));
    expect(view.dimmed).toBe(true);
    // ...but there is no stage to name yet, so no overlay.
    expect(view.overlay).toBe(false);
  });

  it("shows the overlay with nothing behind it on the very first run", () => {
    const view = previewView(source({ status: "running", regions: new Map(), result: null }));
    expect(view).toEqual({ phase: "first", dimmed: false, overlay: true });
  });

  it("is empty before anything has ever been built", () => {
    const view = previewView(source({ status: "idle", regions: new Map(), result: null }));
    expect(view).toEqual({ phase: "empty", dimmed: false, overlay: false });
  });

  it("leaves a failed run's last good model undimmed: the Issues badge reports the failure", () => {
    // Dimming would say "this is behind the controls", and it is not: it is
    // exactly what the last successful run produced, and nothing newer exists.
    const view = previewView(source({ status: "error", stale: true }));
    expect(view).toEqual({ phase: "outdated", dimmed: false, overlay: false });
  });
});

describe("freshEngineResult", () => {
  it("returns the result when it is ready and not stale", () => {
    expect(freshEngineResult({ status: "ready", result: RESULT, stale: false })).toBe(RESULT);
  });

  it("returns null while a run is in flight", () => {
    expect(freshEngineResult({ status: "running", result: RESULT, stale: false })).toBeNull();
  });

  it("returns null before anything has run", () => {
    expect(freshEngineResult({ status: "idle", result: RESULT, stale: false })).toBeNull();
  });

  it("returns null after a failure", () => {
    expect(freshEngineResult({ status: "error", result: RESULT, stale: false })).toBeNull();
  });

  it("returns null for a result the parameters have moved past", () => {
    expect(freshEngineResult({ status: "ready", result: RESULT, stale: true })).toBeNull();
  });

  it("returns null when there is no result at all", () => {
    expect(freshEngineResult({ status: "ready", result: null, stale: false })).toBeNull();
  });
});
