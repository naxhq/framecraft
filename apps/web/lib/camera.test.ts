/**
 * The camera pose as something a link and a project file carry ([V3.1-U6]).
 *
 * Three claims, and the third is the one that makes the feature worth having
 * rather than merely present.
 *
 * 1. A pose survives the round trip through both carriers, and a payload that
 *    cannot be read leaves this device's camera alone rather than refusing the
 *    design around it. Presentation is never a reason a shared design fails to
 *    open, which is the rule `lib/layout.ts` already states for the columns.
 * 2. A restore STANDS IN for the default framing until the user takes the
 *    camera. Not a one-shot, which is what I built first: `FitView` runs on
 *    `plateMm`, which is the params default until a model exists and the
 *    model's own measured width afterwards, so opening a link and pressing
 *    Preview fires it twice. A claim consumed by the first fit was overwritten
 *    by the second and the link opened on the default view, with every unit
 *    test passing; `e2e/shell.spec.ts` is what caught it.
 * 3. The action bar's link moves when the camera does. `[V3.1-O6]` records the
 *    same defect for the layout -- a memo keyed on values the component did not
 *    subscribe to, so dragging a divider left the copied URL byte for byte
 *    unchanged -- and a pose read imperatively at render time would repeat it.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { CAMERA_LIMIT_MM, cameraFromPayload, cameraPayload, type CameraPose } from "./camera";
import { adoptCameraPayload, currentCameraPayload, resetCameraForTest, useCameraStore } from "@/store/camera";

const POSE: CameraPose = { position: [207, 247.25, 273.13], target: [0, 0, 0] };

beforeEach(() => {
  resetCameraForTest();
});

describe("cameraPayload", () => {
  it("rounds to two decimals, which is ten micrometres of camera and forty characters of link", () => {
    expect(cameraPayload({ position: [1.23456, 2, 3], target: [0, 0, 0] })).toEqual({
      p: [1.23, 2, 3],
      t: [0, 0, 0],
    });
  });

  it("has nothing to say about a camera that has never drawn", () => {
    expect(cameraPayload(null)).toBeNull();
  });

  it("refuses a camera sitting on its own target, which points at nothing", () => {
    expect(cameraPayload({ position: [5, 5, 5], target: [5, 5, 5] })).toBeNull();
  });

  it("refuses a coordinate no viewport could reach, which would take the depth buffer with it", () => {
    expect(cameraPayload({ position: [CAMERA_LIMIT_MM * 10, 0, 0], target: [0, 0, 0] })).toBeNull();
  });
});

describe("cameraFromPayload", () => {
  it("round-trips a real pose", () => {
    const payload = cameraPayload(POSE);
    expect(cameraFromPayload(payload)).toEqual(POSE);
  });

  it("returns null rather than half a camera for every shape it cannot read", () => {
    // A position with no target is a camera pointing somewhere neither the
    // sender nor the recipient chose, which is worse than not moving at all.
    for (const bad of [
      null,
      undefined,
      42,
      "a string",
      [],
      {},
      { p: [1, 2, 3] },
      { t: [0, 0, 0] },
      { p: [1, 2], t: [0, 0, 0] },
      { p: [1, 2, "3"], t: [0, 0, 0] },
      { p: [1, 2, Number.NaN], t: [0, 0, 0] },
      { p: [1, 2, Number.POSITIVE_INFINITY], t: [0, 0, 0] },
      { p: [0, 0, 0], t: [0, 0, 0] },
    ]) {
      expect(cameraFromPayload(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("the camera store", () => {
  it("publishes what the viewport reports, for the link to subscribe to", () => {
    useCameraStore.getState().reportPose(POSE);
    expect(currentCameraPayload()).toEqual(cameraPayload(POSE));
  });

  it("stands in for the default framing until the user takes the camera", () => {
    expect(adoptCameraPayload(cameraPayload(POSE))).toBe(true);
    // Every framing while the restore stands, not just the first. `FitView`
    // runs once on the params plate and again on the model's measured width,
    // and a one-shot claim was taken by the first and overwritten by the
    // second -- the link opened on the default view and the e2e caught it.
    expect(useCameraStore.getState().pendingPose()).toEqual(POSE);
    expect(useCameraStore.getState().pendingPose()).toEqual(POSE);
    // A hand on the controls ends it, and nothing else does.
    useCameraStore.getState().clearPendingPose();
    expect(useCameraStore.getState().pendingPose()).toBeNull();
  });

  it("makes a restored pose the one the next link carries, without waiting for a gesture", () => {
    adoptCameraPayload(cameraPayload(POSE));
    expect(currentCameraPayload()).toEqual(cameraPayload(POSE));
  });

  it("adopts nothing, and says so, for a payload it cannot read", () => {
    useCameraStore.getState().reportPose(POSE);
    expect(adoptCameraPayload({ p: [1, 2] })).toBe(false);
    expect(adoptCameraPayload(undefined)).toBe(false);
    // This device's own view is untouched.
    expect(currentCameraPayload()).toEqual(cameraPayload(POSE));
    expect(useCameraStore.getState().pendingPose()).toBeNull();
  });
});
