/**
 * The surface-label rows of the V3-1 matrix (Task 12): one probe per
 * `labels[]` leaf, in the same shape as `matrix.probes.ts` and run by
 * `matrix.test.ts` alongside it.
 *
 * Every probe writes the leaf on ONE label and asserts what physically moved:
 * where the ink rectangle the build reports sits, which face it is on, how
 * much roof or road the groove took out, or that the label vanished (a leaf
 * whose value names a target the scene does not have is a label the build is
 * right to skip, and the buildings get their volume back). Both sides read
 * the same facts: the preview from `EngineResult.labelBands` and the region
 * meshes, the export from the sidecar's `label_bands` and the written parts.
 *
 * Not a test file: `matrix.test.ts` imports it.
 */

import { expect } from "vitest";

import type { Label, PrintParams } from "../../contracts";
import { mustPart, sidecarValue, type Snapshot } from "./matrix.assert";
import type { Probe } from "./matrix.probes";

/** What the sidecar writes per label (`export/common.ts:buildSidecarJson`). */
interface SidecarLabelBand {
  id: string;
  index: number;
  mode: "engrave" | "emboss";
  z: [number, number];
  face_z: number;
  rect: Array<[number, number]>;
  region: string;
}

/** A label on the tower's roof, every leaf explicit so each probe has a value to move off. */
const ROOF_LABEL: Label = {
  target_osm_id: "b-tall",
  layer: "building",
  surface: "building_top",
  u: 0.5,
  v: 0.5,
  rotation_deg: 0,
  size_mm: 5,
  mode: "engrave",
  depth_mm: 0.4,
  font: "sans",
  text: "TOWER",
  follow: false,
};

const ROOF_BASE: Partial<PrintParams> = { labels: [ROOF_LABEL] };

/** A name along the bend, straight, so `follow` has a turn to take. */
const ROAD_BASE: Partial<PrintParams> = {
  labels: [{ target_osm_id: "r-bend", layer: "road", surface: "ground", size_mm: 4, text: "BEND ROAD", follow: false }],
};

function previewBands(snapshot: Snapshot) {
  return snapshot.result.labelBands ?? [];
}

function fileBands(snapshot: Snapshot): SidecarLabelBand[] {
  return sidecarValue(snapshot.sidecar, "label_bands") as SidecarLabelBand[];
}

function centroid(rect: ReadonlyArray<readonly [number, number]>): [number, number] {
  let x = 0;
  let y = 0;
  for (const [px, py] of rect) {
    x += px;
    y += py;
  }
  return [x / rect.length, y / rect.length];
}

function polygonArea(rect: ReadonlyArray<readonly [number, number]>): number {
  let twice = 0;
  for (let i = 0; i < rect.length; i += 1) {
    const a = rect[i];
    const b = rect[(i + 1) % rect.length];
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twice) / 2;
}

/** The direction of a rectangle's longest edge, degrees in [0, 180). */
function longEdgeDeg(rect: ReadonlyArray<readonly [number, number]>): number {
  let best = 0;
  let bestLength = -1;
  for (let i = 0; i < rect.length; i += 1) {
    const a = rect[i];
    const b = rect[(i + 1) % rect.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > bestLength) {
      bestLength = length;
      best = ((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 360) % 180;
    }
  }
  return best;
}

function sameVertices(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (Math.abs(a[i] - b[i]) > 1e-9) return false;
  return true;
}

function distance(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** The buildings part in the file moved: the label changed what the roof carries. */
function fileBuildingsMoved(before: Snapshot, after: Snapshot): void {
  expect(sameVertices(mustPart(before.files, "buildings").positions, mustPart(after.files, "buildings").positions)).toBe(false);
}

function labelStatus(snapshot: Snapshot): string | undefined {
  return snapshot.result.resolvedText.find((line) => line.id === "label-0")?.status;
}

function fileLabelStatus(snapshot: Snapshot): string | undefined {
  const lines = sidecarValue(snapshot.sidecar, "resolved_text") as Array<{ id: string; status: string }>;
  return lines.find((line) => line.id === "label-0")?.status;
}

export const LABEL_PROBES: readonly Probe[] = [
  {
    path: "labels[].target_osm_id",
    value: "b-low",
    base: ROOF_BASE,
    scene: "labelled",
    why: "names the object the label sits on: moving it from the tower to the low hall drops the band to the lower roof",
    assertPreview(before, after) {
      expect(previewBands(after)[0].faceZMm).toBeLessThan(previewBands(before)[0].faceZMm - 5);
      expect(distance(centroid(previewBands(after)[0].rect), centroid(previewBands(before)[0].rect))).toBeGreaterThan(20);
    },
    assertExport(before, after) {
      expect(fileBands(after)[0].face_z).toBeLessThan(fileBands(before)[0].face_z - 5);
      fileBuildingsMoved(before, after);
    },
  },
  {
    path: "labels[].layer",
    value: "green",
    base: ROOF_BASE,
    scene: "labelled",
    why: "names the layer the id is looked up in: the tower's id is not a green area, so the label is skipped and the roof gets its groove back",
    assertPreview(before, after) {
      expect(labelStatus(before)).toBe("cuts");
      expect(labelStatus(after)).toBe("skipped");
      expect(previewBands(after)).toEqual([]);
    },
    assertExport(before, after) {
      expect(fileLabelStatus(after)).toBe("skipped");
      expect(fileBands(after)).toEqual([]);
      expect(mustPart(after.files, "buildings").volumeMm3).toBeGreaterThan(mustPart(before.files, "buildings").volumeMm3);
    },
  },
  {
    path: "labels[].surface",
    value: "ground",
    base: ROOF_BASE,
    scene: "labelled",
    why: "picks the face: a building is labelled on its roof, so asking for the ground refuses the label rather than moving it",
    assertPreview(before, after) {
      expect(labelStatus(after)).toBe("skipped");
      expect(previewBands(after)).toEqual([]);
    },
    assertExport(before, after) {
      expect(fileLabelStatus(after)).toBe("skipped");
      expect(mustPart(after.files, "buildings").volumeMm3).toBeGreaterThan(mustPart(before.files, "buildings").volumeMm3);
    },
  },
  {
    path: "labels[].u",
    // 0.35, not 0.2: the tower's roof is 18 mm across and the name 15 mm long,
    // so a fifth of the way along it the name no longer fits at any legal size
    // and is refused, which is the `surface` probe's effect, not this one's.
    value: 0.35,
    base: ROOF_BASE,
    scene: "labelled",
    why: "slides the label along the roof's principal axis: the ink rectangle's centre moves and the groove moves with it",
    assertPreview(before, after) {
      expect(labelStatus(after)).toBe("cuts");
      expect(distance(centroid(previewBands(after)[0].rect), centroid(previewBands(before)[0].rect))).toBeGreaterThan(2);
      expect(previewBands(after)[0].faceZMm).toBeCloseTo(previewBands(before)[0].faceZMm, 6);
    },
    assertExport(before, after) {
      expect(distance(centroid(fileBands(after)[0].rect), centroid(fileBands(before)[0].rect))).toBeGreaterThan(2);
      fileBuildingsMoved(before, after);
    },
  },
  {
    path: "labels[].v",
    value: 0.2,
    base: ROOF_BASE,
    scene: "labelled",
    why: "slides the label across the roof's principal axis: the ink rectangle's centre moves the other way",
    assertPreview(before, after) {
      expect(distance(centroid(previewBands(after)[0].rect), centroid(previewBands(before)[0].rect))).toBeGreaterThan(3);
    },
    assertExport(before, after) {
      expect(distance(centroid(fileBands(after)[0].rect), centroid(fileBands(before)[0].rect))).toBeGreaterThan(3);
      fileBuildingsMoved(before, after);
    },
  },
  {
    path: "labels[].rotation_deg",
    value: 90,
    base: ROOF_BASE,
    scene: "labelled",
    why: "turns the reading direction from the roof's axis: the ink rectangle's long edge turns by a right angle",
    assertPreview(before, after) {
      const turned = Math.abs(longEdgeDeg(previewBands(after)[0].rect) - longEdgeDeg(previewBands(before)[0].rect));
      expect(Math.min(turned, 180 - turned)).toBeCloseTo(90, 3);
    },
    assertExport(before, after) {
      const turned = Math.abs(longEdgeDeg(fileBands(after)[0].rect) - longEdgeDeg(fileBands(before)[0].rect));
      expect(Math.min(turned, 180 - turned)).toBeCloseTo(90, 3);
      fileBuildingsMoved(before, after);
    },
  },
  {
    path: "labels[].size_mm",
    value: 3,
    base: ROOF_BASE,
    scene: "labelled",
    why: "is the cap height: a smaller size cuts a smaller ink rectangle and takes less roof out",
    assertPreview(before, after) {
      expect(polygonArea(previewBands(after)[0].rect)).toBeLessThan(0.6 * polygonArea(previewBands(before)[0].rect));
      expect(after.result.resolvedText.find((line) => line.id === "label-0")?.sizeMm).toBe(3);
    },
    assertExport(before, after) {
      expect(polygonArea(fileBands(after)[0].rect)).toBeLessThan(0.6 * polygonArea(fileBands(before)[0].rect));
      expect(mustPart(after.files, "buildings").volumeMm3).toBeGreaterThan(mustPart(before.files, "buildings").volumeMm3);
    },
  },
  {
    path: "labels[].mode",
    value: "emboss",
    base: ROOF_BASE,
    scene: "labelled",
    why: "raises the letters off the roof instead of cutting them in: the band moves above the face and the roof gains volume",
    assertPreview(before, after) {
      expect(previewBands(before)[0].zMm[1]).toBeCloseTo(previewBands(before)[0].faceZMm, 6);
      expect(previewBands(after)[0].zMm[0]).toBeCloseTo(previewBands(after)[0].faceZMm, 6);
      expect(previewBands(after)[0].mode).toBe("emboss");
    },
    assertExport(before, after) {
      expect(fileBands(after)[0].mode).toBe("emboss");
      expect(mustPart(after.files, "buildings").volumeMm3).toBeGreaterThan(mustPart(before.files, "buildings").volumeMm3);
    },
  },
  {
    path: "labels[].depth_mm",
    value: 0.8,
    base: ROOF_BASE,
    scene: "labelled",
    why: "is how deep the groove goes: twice the depth doubles the band and takes more roof out",
    assertPreview(before, after) {
      const height = (snapshot: Snapshot): number => previewBands(snapshot)[0].zMm[1] - previewBands(snapshot)[0].zMm[0];
      expect(height(after)).toBeCloseTo(2 * height(before), 6);
    },
    assertExport(before, after) {
      expect(fileBands(after)[0].z[1] - fileBands(after)[0].z[0]).toBeCloseTo(0.8, 6);
      expect(mustPart(after.files, "buildings").volumeMm3).toBeLessThan(mustPart(before.files, "buildings").volumeMm3);
    },
  },
  {
    path: "labels[].font",
    value: "serif",
    base: ROOF_BASE,
    scene: "labelled",
    why: "picks the face the glyphs are cut from: the serif's letterforms are a different width and a different outline",
    assertPreview(before, after) {
      expect(polygonArea(previewBands(after)[0].rect)).not.toBeCloseTo(polygonArea(previewBands(before)[0].rect), 3);
    },
    assertExport(before, after) {
      expect(polygonArea(fileBands(after)[0].rect)).not.toBeCloseTo(polygonArea(fileBands(before)[0].rect), 3);
      fileBuildingsMoved(before, after);
    },
  },
  {
    path: "labels[].text",
    value: "AB",
    base: ROOF_BASE,
    scene: "labelled",
    why: "is what the label says: two letters cut a narrower ink rectangle than five",
    assertPreview(before, after) {
      expect(after.result.resolvedText.find((line) => line.id === "label-0")?.text).toBe("AB");
      expect(polygonArea(previewBands(after)[0].rect)).toBeLessThan(0.7 * polygonArea(previewBands(before)[0].rect));
    },
    assertExport(before, after) {
      expect(polygonArea(fileBands(after)[0].rect)).toBeLessThan(0.7 * polygonArea(fileBands(before)[0].rect));
      fileBuildingsMoved(before, after);
    },
  },
  {
    path: "labels[].follow",
    value: true,
    base: ROAD_BASE,
    scene: "labelled",
    why: "sets each glyph along the street's centreline: the ink outline becomes the hull of the glyph boxes and the groove curves with the road",
    assertPreview(before, after) {
      expect(labelStatus(before)).toBe("cuts");
      expect(labelStatus(after)).toBe("cuts");
      expect(previewBands(before)[0].rect).toHaveLength(4);
      expect(previewBands(after)[0].rect.length).toBeGreaterThan(4);
      expect(after.result.findings.some((finding) => finding.id === "label-adjusted" && /set straight/.test(finding.title))).toBe(false);
    },
    assertExport(before, after) {
      expect(fileBands(after)[0].rect.length).toBeGreaterThan(4);
      expect(sameVertices(mustPart(before.files, "roads").positions, mustPart(after.files, "roads").positions)).toBe(false);
    },
  },
];
