/**
 * `RegionMeshes`: what the preview does to an `EngineResult` before it can be
 * drawn, and what perf mode calls that work.
 *
 * The span used to be called `preview.geometry`, and the baseline note read it
 * as a GPU upload (audit, finding 5). Nothing in `buildGeometry` touches the
 * GPU: it is a float64 to float32 copy, an index attribute, vertex normals and
 * a bounding sphere, all on the main thread. three.js uploads a buffer lazily,
 * on the first render that binds it, which is after the span has closed -- so
 * the span is named for the build and the upload gets a mark of its own on the
 * first frame that renders these meshes.
 *
 * react-three-fiber is mocked for the same reason as in
 * `PerfFrameMark.test.tsx`: the real one needs a WebGL canvas.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loop } = vi.hoisted(() => ({ loop: { callbacks: [] as (() => void)[] } }));

vi.mock("@react-three/fiber", () => ({
  useFrame: (callback: () => void) => {
    loop.callbacks.push(callback);
  },
}));

import type { RegionMesh } from "@/lib/engine/types";
import {
  perfDrainTimings,
  perfReset,
  perfResetDetectionForTest,
  setPerfEnabled,
} from "@/lib/perf";

import RegionMeshes, { buildGeometry } from "./RegionMeshes";

/** One triangle, which is the smallest thing the filter lets through. */
function triangle(): RegionMesh {
  return {
    region: "base",
    positions: new Float64Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
    indices: new Uint32Array([0, 1, 2]),
    volumeMm3: 0,
    bbox: { min: [0, 0, 0], max: [10, 10, 0] },
    bodies: 1,
    slot: 1,
    colorHex: "#808080",
  };
}

beforeEach(() => {
  loop.callbacks.length = 0;
  perfResetDetectionForTest();
  perfReset();
});

afterEach(() => {
  perfResetDetectionForTest();
  perfReset();
});

describe("buildGeometry", () => {
  it("is CPU work only: a float32 copy, an index, normals and a bounding sphere", () => {
    const geometry = buildGeometry(triangle());
    expect(geometry.getAttribute("position").array).toBeInstanceOf(Float32Array);
    expect(geometry.getIndex()?.count).toBe(3);
    expect(geometry.getAttribute("normal")).toBeDefined();
    expect(geometry.boundingSphere).not.toBeNull();
  });
});

describe("RegionMeshes", () => {
  it("times the geometry build under a name that says it is a build", () => {
    setPerfEnabled(true);
    renderToStaticMarkup(<RegionMeshes regions={[triangle()]} />);
    const spans = perfDrainTimings();
    const names = spans.map((span) => span.name);
    expect(names).toContain("preview.geometryBuild");
    // The old name claimed an upload this component never performs.
    expect(names).not.toContain("preview.geometry");
    const build = spans.find((span) => span.name === "preview.geometryBuild");
    expect(build?.durationMs).not.toBeNull();
  });

  it("arms one on-screen mark for the frame that finally renders the meshes", () => {
    setPerfEnabled(true);
    renderToStaticMarkup(<RegionMeshes regions={[triangle()]} />);
    expect(loop.callbacks).toHaveLength(1);
    perfDrainTimings();

    loop.callbacks[0]();
    expect(perfDrainTimings().map((span) => span.name)).toEqual(["preview.geometryOnScreen"]);
  });

  it("adds nothing to the render loop with perf mode off", () => {
    setPerfEnabled(false);
    renderToStaticMarkup(<RegionMeshes regions={[triangle()]} />);
    expect(loop.callbacks).toHaveLength(0);
    expect(perfDrainTimings()).toEqual([]);
  });
});
