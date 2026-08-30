/**
 * `RegionMeshes`'s geometry builder: `RegionMesh.positions`/`indices` (already
 * interleaved xyz triples / a flat triangle index list, in print millimetres)
 * become exactly one `BufferGeometry` each, with no re-triangulation and no
 * welding -- this is the same data an exporter writes, so the preview and the
 * downloaded file can never show a different shape.
 */

import { describe, expect, it } from "vitest";

import type { RegionMesh } from "@/lib/engine/types";
import { buildGeometry } from "./RegionMeshes";

/** One triangle, in print mm. */
function triangleRegion(region: RegionMesh["region"] = "base"): RegionMesh {
  return {
    region,
    positions: new Float64Array([0, 0, 0, 10, 0, 0, 10, 10, 0]),
    indices: new Uint32Array([0, 1, 2]),
    volumeMm3: 0,
    bbox: { min: [0, 0, 0], max: [10, 10, 0] },
    bodies: 1,
    slot: 1,
    colorHex: "#D8D3C6",
  };
}

describe("buildGeometry", () => {
  it("carries the region's own positions and indices straight through, unwelded", () => {
    const geometry = buildGeometry(triangleRegion());
    const position = geometry.getAttribute("position");
    expect(position.count).toBe(3);
    expect(Array.from(position.array)).toEqual([0, 0, 0, 10, 0, 0, 10, 10, 0]);
    expect(geometry.getIndex()?.count).toBe(3);
    expect(Array.from(geometry.getIndex()?.array ?? [])).toEqual([0, 1, 2]);
    geometry.dispose();
  });

  it("computes vertex normals and a bounding sphere, so the mesh renders and frames correctly", () => {
    const geometry = buildGeometry(triangleRegion());
    expect(geometry.getAttribute("normal")).toBeDefined();
    expect(geometry.boundingSphere).not.toBeNull();
    geometry.dispose();
  });

  it("a two-triangle region (a real solid's worth of faces) keeps every triangle", () => {
    const region: RegionMesh = {
      region: "buildings",
      positions: new Float64Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      volumeMm3: 0,
      bbox: { min: [0, 0, 0], max: [10, 10, 0] },
      bodies: 1,
      slot: 2,
      colorHex: "#3A3A3A",
    };
    const geometry = buildGeometry(region);
    expect(geometry.getIndex()?.count).toBe(6);
    geometry.dispose();
  });
});
