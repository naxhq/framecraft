/**
 * The anchor model, checked without a renderer or a kernel.
 *
 * `u`, `v` and the rotation are stored in the TARGET's frame, so the one
 * property everything depends on is that the frame rotates with the target:
 * the same anchor on a footprint turned by 37 degrees lands on the turned
 * footprint's own point, and the inverse gives the anchor back. The follow
 * plan's curvature test is stated in `labelAnchor.ts` and measured here on
 * a gentle bend (followed) and a hairpin (straight fallback).
 */

import { describe, expect, it } from "vitest";

import { PARAM_RANGES, defaultPrintParams, type Point, type PrintParams } from "./contracts";
import { building, road, scene, square } from "./engine/solid/fixture";
import {
  FOLLOW_MAX_TURN_DEG,
  LABEL_CAP,
  LABEL_TEXT_MAX,
  NUDGE_LARGE_MM,
  NUDGE_MM,
  ROTATE_STEP_DEG,
  SCALE_STEP_MM,
  addedLabel,
  anchorToPlan,
  boxCorners,
  chainRoadParts,
  findLabelTarget,
  followPlan,
  frameAxisDeg,
  frameOf,
  labelBox,
  labelCountText,
  labelDisplayText,
  labelKeyAction,
  labelPose,
  labelScale,
  labelSurfaceWord,
  labelText,
  movedLabel,
  newLabel,
  normaliseDeg,
  nudgeAnchor,
  nudgedLabel,
  patchedLabel,
  pathFrame,
  placementFor,
  planToAnchor,
  pointAt,
  polygonFrame,
  removedLabel,
  rotatedLabel,
  snapAnchor,
  snapRotation,
} from "./labelAnchor";
import * as T from "./transform";

/** A 40 by 20 rectangle centred on (10, 5), turned by `deg`. */
function turnedRect(deg: number): Point[] {
  const theta = (deg * Math.PI) / 180;
  const corners: Point[] = [
    [-20, -10],
    [20, -10],
    [20, 10],
    [-20, 10],
  ];
  return corners.map(([x, y]) => [10 + x * Math.cos(theta) - y * Math.sin(theta), 5 + x * Math.sin(theta) + y * Math.cos(theta)]);
}

describe("polygon frames", () => {
  it("reads along the long side of the oriented rectangle, whichever way it came out", () => {
    const frame = polygonFrame(turnedRect(0));
    expect(frame.width).toBeCloseTo(40, 6);
    expect(frame.depth).toBeCloseTo(20, 6);
    expect(Math.abs(normaliseDeg(frame.angleDeg)) % 180).toBeCloseTo(0, 6);
    const tall = polygonFrame(turnedRect(90));
    expect(tall.width).toBeCloseTo(40, 6);
    expect(tall.depth).toBeCloseTo(20, 6);
    expect(Math.abs(normaliseDeg(tall.angleDeg - 90)) % 180).toBeCloseTo(0, 6);
  });

  it("maps u and v to build space under the footprint's own rotation", () => {
    for (const deg of [0, 37, -60, 120]) {
      const frame = polygonFrame(turnedRect(deg));
      const theta = (frame.angleDeg * Math.PI) / 180;
      // Three quarters along the long side, a quarter across it.
      const pose = anchorToPlan(frame, 0.75, 0.25, 0);
      const along = 0.25 * 40;
      const across = -0.25 * 20;
      expect(pose.x).toBeCloseTo(10 + along * Math.cos(theta) - across * Math.sin(theta), 6);
      expect(pose.y).toBeCloseTo(5 + along * Math.sin(theta) + across * Math.cos(theta), 6);
      // The reading direction turns with the footprint.
      expect(normaliseDeg(pose.angleDeg - frame.angleDeg)).toBeCloseTo(0, 6);
      const turned = anchorToPlan(frame, 0.75, 0.25, 30);
      expect(normaliseDeg(turned.angleDeg - frame.angleDeg)).toBeCloseTo(30, 6);
    }
  });

  it("inverts: plan -> anchor -> plan is the identity inside the frame, and clamps outside it", () => {
    const frame = polygonFrame(turnedRect(37));
    for (const [u, v] of [
      [0.1, 0.9],
      [0.5, 0.5],
      [0.98, 0.02],
    ]) {
      const pose = anchorToPlan(frame, u, v, 0);
      const back = planToAnchor(frame, pose.x, pose.y);
      expect(back.u).toBeCloseTo(u, 9);
      expect(back.v).toBeCloseTo(v, 9);
    }
    const far = planToAnchor(frame, 1000, 1000);
    expect(far.u).toBeGreaterThanOrEqual(0);
    expect(far.u).toBeLessThanOrEqual(1);
    expect(far.v).toBeGreaterThanOrEqual(0);
    expect(far.v).toBeLessThanOrEqual(1);
  });

  it("the centre is (0.5, 0.5) and the principal axis is the frame's", () => {
    const frame = polygonFrame(turnedRect(37));
    const centre = anchorToPlan(frame, 0.5, 0.5, 0);
    expect(centre.x).toBeCloseTo(10, 6);
    expect(centre.y).toBeCloseTo(5, 6);
    expect(frameAxisDeg(frame, 0.2)).toBe(frame.angleDeg);
  });
});

describe("path frames", () => {
  const bent: Point[] = [
    [0, 0],
    [100, 0],
    [100, 50],
  ];

  it("measures arc length and walks it, tangent included", () => {
    const frame = pathFrame(bent, 6);
    expect(frame.length).toBeCloseTo(150, 9);
    const a = pointAt(frame, 50);
    expect([a.x, a.y, a.angleDeg]).toEqual([50, 0, 0]);
    const b = pointAt(frame, 125);
    expect(b.x).toBeCloseTo(100, 9);
    expect(b.y).toBeCloseTo(25, 9);
    expect(b.angleDeg).toBeCloseTo(90, 9);
    // Past the ends is clamped, not extrapolated.
    expect(pointAt(frame, 999).y).toBeCloseTo(50, 9);
  });

  it("u runs along the centreline, v across the ribbon, rotation from the tangent", () => {
    const frame = pathFrame(bent, 6);
    const on = anchorToPlan(frame, 1 / 3, 0.5, 0);
    expect(on.x).toBeCloseTo(50, 9);
    expect(on.y).toBeCloseTo(0, 9);
    expect(on.angleDeg).toBeCloseTo(0, 9);
    // v = 1 is the left edge of the ribbon (half the width to the left of the tangent).
    const left = anchorToPlan(frame, 1 / 3, 1, 0);
    expect(left.y).toBeCloseTo(3, 9);
    const up = anchorToPlan(frame, 5 / 6, 0.5, 15);
    expect(up.angleDeg).toBeCloseTo(105, 9);
    const back = planToAnchor(frame, left.x, left.y);
    expect(back.u).toBeCloseTo(1 / 3, 9);
    expect(back.v).toBeCloseTo(1, 9);
  });

  it("chains the parts a crop cut a way into, whichever way round they were stored", () => {
    const parts = [
      road("w1-2", [[100, 0], [100, 50]], 10),
      road("w1-1", [[0, 0], [100, 0]], 10),
      road("w1-3", [[100, 80], [100, 50]], 10),
    ];
    expect(chainRoadParts(parts)).toEqual([
      [0, 0],
      [100, 0],
      [100, 50],
      [100, 80],
    ]);
    // A part that meets nothing stays out, so the chain is still one polyline;
    // a stray part LONGER than the chain would be the chain instead, which is
    // the documented "label the longest piece" rule.
    expect(chainRoadParts([...parts, road("w1-9", [[500, 500], [510, 510]], 10)])).toHaveLength(4);
    expect(chainRoadParts([...parts, road("w1-9", [[500, 500], [900, 900]], 10)])).toEqual([
      [500, 500],
      [900, 900],
    ]);
  });
});

describe("snapping and nudging", () => {
  it("snaps a rotation onto a right angle only when it is close", () => {
    expect(snapRotation(4)).toBe(0);
    expect(snapRotation(-93)).toBe(-90);
    expect(snapRotation(176)).toBe(180);
    expect(snapRotation(12)).toBe(12);
    expect(snapRotation(45)).toBe(45);
  });

  it("snaps each anchor axis onto the centre on its own", () => {
    expect(snapAnchor(0.52, 0.2)).toEqual({ u: 0.5, v: 0.2 });
    expect(snapAnchor(0.9, 0.47)).toEqual({ u: 0.9, v: 0.5 });
    expect(snapAnchor(1.4, -0.2)).toEqual({ u: 1, v: 0 });
  });

  it("nudges in the label's own reading frame", () => {
    const frame = polygonFrame(turnedRect(0));
    // Reading along +x: a nudge right moves u, a nudge up moves v.
    const right = nudgeAnchor(frame, { u: 0.5, v: 0.5, rotation_deg: 0 }, 4, 0);
    expect(right.u).toBeCloseTo(0.5 + 4 / 40, 9);
    expect(right.v).toBeCloseTo(0.5, 9);
    const up = nudgeAnchor(frame, { u: 0.5, v: 0.5, rotation_deg: 0 }, 0, 2);
    expect(up.v).toBeCloseTo(0.5 + 2 / 20, 9);
    // Reading turned by 90 degrees: "right" is now across the footprint.
    const turned = nudgeAnchor(frame, { u: 0.5, v: 0.5, rotation_deg: 90 }, 4, 0);
    expect(turned.u).toBeCloseTo(0.5, 9);
    expect(turned.v).toBeCloseTo(0.5 + 4 / 20, 9);
  });
});

describe("the label box and its placement", () => {
  const params = defaultPrintParams();

  it("centres the ink box on the pose: the corners straddle it and the placement backs the pen off", () => {
    const box = labelBox("sans", "Main St", 4, params, "engrave");
    expect(box.widthMm).toBeGreaterThan(8);
    expect(box.heightMm).toBeGreaterThan(3);
    const pose = { x: 12, y: -7, angleDeg: 30 };
    const corners = boxCorners(pose, box);
    const cx = corners.reduce((sum, p) => sum + p[0], 0) / 4;
    const cy = corners.reduce((sum, p) => sum + p[1], 0) / 4;
    expect(cx).toBeCloseTo(12, 9);
    expect(cy).toBeCloseTo(-7, 9);
    const placement = placementFor(pose, box);
    expect(placement.rotation_deg).toBe(30);
    expect(placement.mirror_x).toBe(false);
    // The pen origin sits half a width behind the centre along the reading direction.
    const theta = Math.PI / 6;
    const backX = box.widthMm / 2 - box.dilationMm;
    const backY = (box.inkTopMm + box.inkBottomMm) / 2;
    expect(placement.anchor_x).toBeCloseTo(12 - backX * Math.cos(theta) + backY * Math.sin(theta), 9);
    expect(placement.anchor_y).toBeCloseTo(-7 - backX * Math.sin(theta) - backY * Math.cos(theta), 9);
  });
});

describe("following a centreline", () => {
  /** A quarter circle of radius `r`, sampled every `stepDeg`, starting east and turning left. */
  function arc(r: number, stepDeg: number, sweepDeg: number): Point[] {
    const out: Point[] = [];
    for (let deg = 0; deg <= sweepDeg + 1e-9; deg += stepDeg) {
      const t = (deg * Math.PI) / 180;
      out.push([r * Math.sin(t), r * (1 - Math.cos(t))]);
    }
    return out;
  }

  it("sets every glyph on a gentle bend, each turned to its own chord", () => {
    const frame = pathFrame(arc(60, 5, 90), 6);
    const advances = [3, 3, 3, 3, 3, 3];
    const plan = followPlan(frame, frame.length / 2, advances, 4, 0.5, 0, 0);
    expect(plan.followed).toBe(true);
    expect(plan.reason).toBeNull();
    expect(plan.glyphs).toHaveLength(6);
    expect(plan.maxTurnDeg).toBeLessThan(FOLLOW_MAX_TURN_DEG);
    // The chords turn monotonically left along the arc.
    for (let i = 1; i < plan.glyphs.length; i += 1) {
      expect(normaliseDeg(plan.glyphs[i].pose.angleDeg - plan.glyphs[i - 1].pose.angleDeg)).toBeGreaterThan(0);
    }
    // The arc is sampled every 5 degrees, so a 3 mm chord that straddles a
    // vertex reads a 5 degree turn: a 34 mm radius on a 60 mm arc. Well clear
    // of the 4 mm cap height either way.
    expect(plan.minRadius).toBeGreaterThan(20);
  });

  it("falls back to a straight line on a hairpin, and says which limit tripped", () => {
    const hairpin: Point[] = [
      [0, 0],
      [20, 0],
      [20, 3],
      [0, 3],
    ];
    const frame = pathFrame(hairpin, 6);
    const plan = followPlan(frame, frame.length / 2, [4, 4, 4, 4], 4, 0.5, 0, 0);
    expect(plan.followed).toBe(false);
    expect(plan.reason).toMatch(/degrees between two letters/);
    expect(plan.maxTurnDeg).toBeGreaterThan(FOLLOW_MAX_TURN_DEG);
  });

  it("falls back when the bend is tighter than the cap height", () => {
    // Radius 3 mm with 4 mm glyphs: the inside edge of a glyph box folds.
    const frame = pathFrame(arc(3, 2, 60), 4);
    const plan = followPlan(frame, frame.length / 2, [1, 1, 1], 4, 0.5, 0, 0);
    expect(plan.followed).toBe(false);
    expect(plan.reason).toMatch(/tighter than/);
  });

  it("refuses a text longer than the street", () => {
    const frame = pathFrame([[0, 0], [10, 0]], 6);
    const plan = followPlan(frame, 5, [4, 4, 4], 4, 0.5, 0, 0);
    expect(plan.followed).toBe(false);
    expect(plan.reason).toMatch(/only 10.0 mm/);
  });

  it("walks the path backwards when the tangent would set the text upside down", () => {
    const westward = pathFrame([[100, 0], [0, 0]], 6);
    const plan = followPlan(westward, 50, [4, 4], 4, 0.5, 0, 0);
    expect(plan.followed).toBe(true);
    expect(plan.reversed).toBe(true);
    expect(Math.abs(plan.glyphs[0].pose.angleDeg)).toBeLessThan(1e-9);
    expect(plan.glyphs[1].pose.x).toBeGreaterThan(plan.glyphs[0].pose.x);
  });
});

describe("targets in a scene", () => {
  const graph = scene({
    radiusM: 200,
    buildings: [{ ...building("w10-1", square(0, 0, 40), 20), osm_id: "w10", name: "The Rookery" }],
    roads: [
      { ...road("w20-1", [[-100, 50], [0, 50]], 12), osm_id: "w20", name: "State St" },
      { ...road("w20-2", [[0, 50], [100, 50]], 14), osm_id: "w20" },
    ],
    water: [{ ring: square(80, -80, 30), holes: [], osm_id: "r30", name: "Pond" }],
    green: [{ ring: square(-80, -80, 30), holes: [], osm_id: "w40" }],
  });

  it("finds each layer by its base OSM id, and chains a split road", () => {
    const b = findLabelTarget(graph, { target_osm_id: "w10", layer: "building" });
    expect(b?.name).toBe("The Rookery");
    expect(b?.ring).toHaveLength(4);
    const r = findLabelTarget(graph, { target_osm_id: "w20", layer: "road" });
    expect(r?.name).toBe("State St");
    expect(r?.path).toEqual([
      [-100, 50],
      [0, 50],
      [100, 50],
    ]);
    expect(r?.road?.width_m).toBe(14);
    expect(findLabelTarget(graph, { target_osm_id: "r30", layer: "water" })?.name).toBe("Pond");
    expect(findLabelTarget(graph, { target_osm_id: "w40", layer: "green" })?.name).toBeNull();
    expect(findLabelTarget(graph, { target_osm_id: "w99", layer: "building" })).toBeNull();
    // A right id on the wrong layer is not found: the layer is part of the address.
    expect(findLabelTarget(graph, { target_osm_id: "w10", layer: "road" })).toBeNull();
  });

  it("builds a print-millimetre frame from a scene in metres", () => {
    const params = defaultPrintParams();
    const scale = 0.42;
    const target = findLabelTarget(graph, { target_osm_id: "w10", layer: "building" });
    const frame = frameOf(target!, params, scale);
    expect(frame?.kind).toBe("polygon");
    if (frame?.kind === "polygon") {
      expect(frame.width).toBeCloseTo(40 * scale, 6);
      expect(frame.depth).toBeCloseTo(40 * scale, 6);
    }
    const street = findLabelTarget(graph, { target_osm_id: "w20", layer: "road" });
    const ribbon = frameOf(street!, params, scale);
    expect(ribbon?.kind).toBe("path");
    if (ribbon?.kind === "path") {
      expect(ribbon.length).toBeCloseTo(200 * scale, 6);
      // The engine's own clamp: 14 m at road_scale 1 is above the minimum wall.
      expect(ribbon.width).toBeCloseTo(14 * scale, 6);
    }
  });

  it("uses the target's name when the label has no text of its own", () => {
    const target = findLabelTarget(graph, { target_osm_id: "w10", layer: "building" });
    expect(labelText({ text: "" }, target)).toBe("The Rookery");
    expect(labelText({ text: "  Rookery  " }, target)).toBe("Rookery");
    expect(labelText({ text: "" }, null)).toBe("");
  });

  it("makes a new label at the contract's defaults, on the surface its layer prints as", () => {
    const onRoof = newLabel({ layer: "building", osmId: "w10" });
    expect(onRoof.surface).toBe("building_top");
    expect(onRoof.u).toBe(0.5);
    expect(onRoof.size_mm).toBe(4);
    expect(newLabel({ layer: "road", osmId: "w20" }).surface).toBe("ground");
    expect(labelCountText(3)).toBe(`3 of ${LABEL_CAP} labels`);
  });
});

// ---------------------------------------------------------------------------
// The params-level edits the store's label actions and the stage's pose share
// ---------------------------------------------------------------------------

describe("params-level edits", () => {
  const graph = scene({
    radiusM: 200,
    buildings: [{ ...building("w10-1", square(0, 0, 40), 20), osm_id: "w10", name: "The Rookery" }],
    roads: [{ ...road("w20-1", [[-100, 50], [100, 50]], 12), osm_id: "w20", name: "State St" }],
    water: [],
    green: [],
  });
  const params = defaultPrintParams();
  const scale = labelScale(graph, params);

  it("resolves a label's pose in print millimetres from the scene the engine builds at", () => {
    expect(scale).toBeCloseTo(T.scale_mm_per_m(params, 200), 9);
    const label = newLabel({ layer: "building", osmId: "w10" });
    const pose = labelPose(graph, params, label);
    // The square is centred on the origin, so its centre anchor is the origin.
    expect(pose?.x).toBeCloseTo(0, 6);
    expect(pose?.y).toBeCloseTo(0, 6);
    expect(labelPose(graph, params, { ...label, u: 1 })?.x).toBeCloseTo(20 * scale, 6);
    expect(labelPose(graph, params, { ...label, target_osm_id: "w99" })).toBeNull();
  });

  it("adds a label at the target's centre, or at the plan point a click landed on, and refuses the thirteenth", () => {
    const centred = addedLabel(graph, params, { layer: "building", osmId: "w10" });
    expect(centred.ok).toBe(true);
    if (centred.ok) {
      expect(centred.index).toBe(0);
      expect(centred.labels[0].u).toBe(0.5);
      expect(centred.labels[0].v).toBe(0.5);
    }
    const clicked = addedLabel(graph, params, { layer: "building", osmId: "w10" }, { xMm: 10 * scale, yMm: -10 * scale });
    expect(clicked.ok).toBe(true);
    if (clicked.ok) {
      expect(clicked.labels[0].u).toBeCloseTo(0.75, 4);
      expect(clicked.labels[0].v).toBeCloseTo(0.25, 4);
    }
    const full: PrintParams = { ...params, labels: Array.from({ length: LABEL_CAP }, () => newLabel({ layer: "road", osmId: "w20" })) };
    const refused = addedLabel(graph, full, { layer: "building", osmId: "w10" });
    expect(refused).toEqual({ ok: false, reason: "capped" });
  });

  it("moves a label to a plan point, snapping onto the centre when close, and refuses an index it does not have", () => {
    const one: PrintParams = { ...params, labels: [newLabel({ layer: "building", osmId: "w10" })] };
    const moved = movedLabel(graph, one, 0, 14 * scale, 6 * scale);
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      expect(moved.labels[0].u).toBeCloseTo(0.85, 4);
      expect(moved.labels[0].v).toBeCloseTo(0.65, 4);
    }
    const near = movedLabel(graph, one, 0, 0.5 * scale, -0.5 * scale);
    if (near.ok) expect([near.labels[0].u, near.labels[0].v]).toEqual([0.5, 0.5]);
    expect(movedLabel(graph, one, 3, 0, 0)).toEqual({ ok: false, reason: "missing" });
    // A label whose target the scene lost cannot be moved: there is no frame.
    const lost: PrintParams = { ...params, labels: [newLabel({ layer: "building", osmId: "w99" })] };
    expect(movedLabel(graph, lost, 0, 0, 0)).toEqual({ ok: false, reason: "missing" });
  });

  it("turns a label to an absolute plan direction, stored relative to the target's axis and snapped onto a right angle", () => {
    const one: PrintParams = { ...params, labels: [newLabel({ layer: "road", osmId: "w20" })] };
    // The street runs due east, so an absolute 93 degrees is 93 from its axis, which snaps to 90.
    const turned = rotatedLabel(graph, one, 0, 93);
    expect(turned.ok).toBe(true);
    if (turned.ok) expect(turned.labels[0].rotation_deg).toBe(90);
    const free = rotatedLabel(graph, one, 0, 37.26);
    if (free.ok) expect(free.labels[0].rotation_deg).toBe(37.3);
  });

  it("nudges in the reading frame, patches with clamping, and removes", () => {
    const one: PrintParams = { ...params, labels: [newLabel({ layer: "building", osmId: "w10" })] };
    const nudged = nudgedLabel(graph, one, 0, 4 * scale, 0);
    if (nudged.ok) {
      expect(nudged.labels[0].u).toBeCloseTo(0.6, 4);
      expect(nudged.labels[0].v).toBe(0.5);
    }
    const patched = patchedLabel(one, 0, { size_mm: 40, depth_mm: -1, rotation_deg: 370, text: "x".repeat(200) });
    expect(patched.ok).toBe(true);
    if (patched.ok) {
      expect(patched.labels[0].size_mm).toBe(PARAM_RANGES.labels.size_mm.max);
      expect(patched.labels[0].depth_mm).toBe(PARAM_RANGES.labels.depth_mm.min);
      expect(patched.labels[0].rotation_deg).toBe(10);
      expect(patched.labels[0].text).toHaveLength(LABEL_TEXT_MAX);
    }
    expect(patchedLabel(one, 1, { text: "no" })).toEqual({ ok: false, reason: "missing" });
    expect(removedLabel(one, 0)).toEqual([]);
    expect(removedLabel(one, 5)).toHaveLength(1);
  });

  it("names a label for a list: its text, else its target's name, else its id", () => {
    const label = newLabel({ layer: "building", osmId: "w10" });
    expect(labelDisplayText(label, graph)).toBe("The Rookery");
    expect(labelDisplayText({ ...label, text: "Roof" }, graph)).toBe("Roof");
    expect(labelDisplayText({ ...label, target_osm_id: "w99" }, graph)).toBe("w99");
    expect(labelDisplayText(label, null)).toBe("w10");
    expect(labelSurfaceWord("road")).toBe("street");
  });

  it("maps the keys the handle and the row share", () => {
    expect(labelKeyAction({ key: "ArrowRight", shiftKey: false })).toEqual({ kind: "nudge", dxMm: NUDGE_MM, dyMm: 0 });
    expect(labelKeyAction({ key: "ArrowUp", shiftKey: true })).toEqual({ kind: "nudge", dxMm: 0, dyMm: NUDGE_LARGE_MM });
    expect(labelKeyAction({ key: "]", shiftKey: false })).toEqual({ kind: "turn", deltaDeg: -ROTATE_STEP_DEG });
    expect(labelKeyAction({ key: "+", shiftKey: false })).toEqual({ kind: "resize", deltaMm: SCALE_STEP_MM });
    expect(labelKeyAction({ key: "Delete", shiftKey: false })).toEqual({ kind: "remove" });
    expect(labelKeyAction({ key: "Escape", shiftKey: false })).toEqual({ kind: "deselect" });
    expect(labelKeyAction({ key: "g", shiftKey: false })).toBeNull();
  });
});
