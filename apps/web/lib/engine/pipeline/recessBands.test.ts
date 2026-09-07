/**
 * The bands a real build emits, judged by what the viewport would do with them.
 *
 * `RegionMeshes.test.tsx` pins the shading predicate against hand-built bands.
 * This file is the other half, and the half that would have caught the defect:
 * it runs the engine, takes the bands and the frame mesh it actually produced,
 * and asserts that the shading darkens the letters and NOT the lip they were
 * cut into.
 *
 * The defect it exists for, measured on the shipped 3.1.0 build and reported
 * by the author against the deployed site ("I added text labeling to the frame
 * but it is not shown in preview"): one engraved line emitted
 * `frame`/`lettering` `zMm [4.60009765625, 5]`, and 5 is the frame's own lip
 * top, so of the 1888 frame triangles the Z-only predicate darkened, 485 were
 * the lip itself. The letters were the same colour as their surround at every
 * zoom, which is indistinguishable from lettering that was never cut.
 */

import { afterAll, describe, expect, it } from "vitest";

import { bandsForRegion, insideBands } from "@/components/scene/RegionMeshes";
import type { RecessBand, RegionMesh } from "../types";
import { MatrixGroup } from "./matrix.run";

const LINE = {
  edge: "bottom",
  align: "center",
  text: "CHICAGO",
  mode: "engrave",
  size_mm: 4,
  depth_mm: 0.4,
  font: "sans",
};

let group: MatrixGroup | null = null;
afterAll(() => group?.dispose());

interface Shading {
  total: number;
  shaded: number;
  /** Shaded triangles sitting on the region's highest face: the lip. */
  shadedOnTopFace: number;
  /** Shaded triangles strictly below it: the pocket floor and its walls. */
  shadedInsideCut: number;
  topZ: number;
}

function shadeCounts(mesh: RegionMesh, bands: readonly RecessBand[]): Shading {
  const triangles = Math.floor(mesh.indices.length / 3);
  const centroids: Array<[number, number, number]> = [];
  let topZ = -Infinity;
  for (let t = 0; t < triangles; t += 1) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < 3; k += 1) {
      const at = mesh.indices[t * 3 + k] * 3;
      x += mesh.positions[at];
      y += mesh.positions[at + 1];
      z += mesh.positions[at + 2];
    }
    const centroid: [number, number, number] = [x / 3, y / 3, z / 3];
    centroids.push(centroid);
    if (centroid[2] > topZ) topZ = centroid[2];
  }
  let shaded = 0;
  let onTop = 0;
  let inside = 0;
  for (const [x, y, z] of centroids) {
    if (!insideBands(z, bands, x, y)) continue;
    shaded += 1;
    if (Math.abs(z - topZ) < 1e-6) onTop += 1;
    else inside += 1;
  }
  return { total: triangles, shaded, shadedOnTopFace: onTop, shadedInsideCut: inside, topZ };
}

describe("an engraved frame line, from the engine to the shading", () => {
  it("darkens the letters and leaves the lip they were cut into alone", async () => {
    group = await MatrixGroup.open("block", { frame: true, engravings: [] });
    const after = await group.run("engravings", [LINE]);
    const bands = bandsForRegion(after.result.recessBands ?? [], "frame");
    const frame = (after.result.regions as RegionMesh[]).find((region) => region.region === "frame");
    expect(frame, "the build produced no frame region").toBeDefined();
    expect(bands.length, "the lettering stage emitted no band for the frame").toBeGreaterThan(0);

    // The band is a box that names its face, not a bare Z range: the two
    // fields the viewport needs to tell a cut from the surface it was cut from.
    for (const band of bands) {
      expect(band.xyMm, "a band with no footprint shades the whole region").toBeDefined();
      expect(band.faceZMm, "a band with no face shades the surface too").toBeDefined();
      // The pocket is cut DOWN from the lip, so the lip is the band's top.
      expect(band.faceZMm).toBeCloseTo(band.zMm[1], 6);
    }

    const shading = shadeCounts(frame as RegionMesh, bands);
    // The claim, in the only terms that matter: the letters read.
    expect(shading.shadedInsideCut, "nothing inside the pocket is darkened").toBeGreaterThan(0);
    expect(shading.shadedOnTopFace, "the lip is darkened along with the letters").toBe(0);
    // And the shading stays local: it is the text, not a slab across the frame.
    expect(shading.shaded).toBeLessThan(shading.total / 2);
  }, 240000);

  it("names the line it was cut for, so the viewport can caption it with its own words", async () => {
    // Two lines on the SAME edge is the case that makes an id necessary:
    // matching a band to a line by which edge its box hugs reads identically
    // for both, and would caption each with the other's words ([V3.1-U8]).
    const after = await (group as MatrixGroup).run("engravings", [
      { ...LINE, edge: "bottom", text: "FIRST" },
      { ...LINE, edge: "bottom", text: "SECOND" },
    ]);
    const bands = bandsForRegion(after.result.recessBands ?? [], "frame");
    const ids = bands.map((band) => band.lineId);
    expect(bands.length).toBeGreaterThanOrEqual(2);
    for (const id of ids) expect(id, "a lettering band with no line id cannot be captioned").toBeDefined();
    // Distinct ids, and each one is a line the build actually resolved.
    expect(new Set(ids).size).toBe(ids.length);
    const resolved = new Map(after.result.resolvedText.map((line) => [line.id, line.text]));
    expect(ids.map((id) => resolved.get(id as string))).toEqual(
      expect.arrayContaining(["FIRST", "SECOND"]),
    );
  }, 240000);

  it("shades nothing at all when there is no lettering", async () => {
    const plain = await (group as MatrixGroup).run("engravings", []);
    const bands = bandsForRegion(plain.result.recessBands ?? [], "frame");
    const frame = (plain.result.regions as RegionMesh[]).find((region) => region.region === "frame");
    // Not vacuous the other way either: with no cut there is no band, so the
    // count above is the lettering's own and not something the frame always had.
    expect(shadeCounts(frame as RegionMesh, bands).shaded).toBe(0);
  }, 240000);
});
