/**
 * `PerfFrameMark`: the render-loop probe perf mode uses for its "this is on
 * screen now" marks.
 *
 * The thing under test is the SUBSCRIPTION, not the mark. The `Canvas` sets no
 * `frameloop`, so it defaults to `always` and a `useFrame` callback is invoked
 * about sixty times a second for the life of the page, perf mode off included
 * (baseline audit, finding 8). So the guard has to be taken before subscribing
 * rather than inside the callback, and that is what these assert: with perf
 * mode off `useFrame` is never called at all.
 *
 * react-three-fiber is mocked because the real one needs a WebGL canvas, which
 * the node test environment has no way to give it; the mock records what was
 * subscribed, which is exactly the observable this file is about.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loop } = vi.hoisted(() => ({ loop: { callbacks: [] as (() => void)[] } }));

vi.mock("@react-three/fiber", () => ({
  useFrame: (callback: () => void) => {
    loop.callbacks.push(callback);
  },
}));

import {
  perfDrainTimings,
  perfReset,
  perfResetDetectionForTest,
  setPerfEnabled,
} from "@/lib/perf";

import PerfFrameMark from "./PerfFrameMark";

beforeEach(() => {
  loop.callbacks.length = 0;
  perfResetDetectionForTest();
  perfReset();
});

afterEach(() => {
  perfResetDetectionForTest();
  perfReset();
});

describe("PerfFrameMark", () => {
  it("registers no frame callback at all with perf mode off", () => {
    setPerfEnabled(false);
    const markup = renderToStaticMarkup(<PerfFrameMark name="preview.firstFrame" />);
    expect(markup).toBe("");
    expect(loop.callbacks).toHaveLength(0);
    expect(perfDrainTimings()).toEqual([]);
  });

  it("registers one frame callback with perf mode on", () => {
    setPerfEnabled(true);
    renderToStaticMarkup(<PerfFrameMark name="preview.firstFrame" />);
    expect(loop.callbacks).toHaveLength(1);
  });

  it("marks once on the first frame and never again", () => {
    setPerfEnabled(true);
    renderToStaticMarkup(<PerfFrameMark name="preview.geometryOnScreen" />);
    const [onFrame] = loop.callbacks;
    onFrame();
    onFrame();
    onFrame();
    const marks = perfDrainTimings();
    expect(marks.map((mark) => mark.name)).toEqual(["preview.geometryOnScreen"]);
    expect(marks[0].durationMs).toBeNull();
  });
});
