/**
 * The preview camera's pose, as its own store ([V3.1-U6]).
 *
 * Its own store for the same reason `store/layout.ts` is: it is not a print
 * parameter. It must not hash into a pipeline stage, must not read as a change
 * from default in the settings diff, and must not land on the undo stack
 * between two real edits.
 *
 * Two directions, and they are deliberately separate fields.
 *
 * `pose` is what the viewport last REPORTED, written once per orbit gesture
 * (on the controls' `end` event, never per frame) so the action bar can
 * subscribe to it and keep the copied link honest. `[V3.1-O6]`'s note records
 * what happens otherwise: the link was memoised on values it did not
 * subscribe to, and dragging the layout left the copied URL byte for byte
 * unchanged.
 *
 * `pending` is what a link or a project file ASKED for, and it stands in for
 * the default framing until the user takes the camera themselves.
 *
 * It is deliberately NOT a one-shot, which is what I tried first and what the
 * e2e caught: `FitView` runs on `plateMm`, and `plateMm` is the params default
 * until a model exists and the model's own measured width afterwards, so
 * opening a link and pressing Preview fires it TWICE. A claim consumed by the
 * first fit was overwritten by the second, and the restored link opened on the
 * default view while every unit test passed.
 *
 * So it is held instead, and released by the one event that means the user has
 * taken over: the controls' `start`, i.e. a real drag, wheel or pinch. Nothing
 * else clears it -- a preset click does not move a camera, and a design opened
 * from someone else's link should keep their angle until this user changes it.
 */

import { create } from "zustand";

import { cameraFromPayload, cameraPayload, type CameraPayload, type CameraPose } from "@/lib/camera";

interface CameraStore {
  /** The viewport's last reported pose, or null before it has drawn anything. */
  pose: CameraPose | null;
  /** A pose a restore is asking for, until the viewport takes it. */
  pending: CameraPose | null;
  /** Called by the viewport when an orbit, pan or dolly gesture ends. */
  reportPose: (pose: CameraPose) => void;
  /** Called by a restore. */
  requestPose: (pose: CameraPose) => void;
  /** Called by the viewport: the pose to apply instead of framing the plate, or null. */
  pendingPose: () => CameraPose | null;
  /** Called by the viewport when the user takes the camera. The restore stops standing in. */
  clearPendingPose: () => void;
}

export const useCameraStore = create<CameraStore>((set, get) => ({
  pose: null,
  pending: null,
  reportPose: (pose) => set({ pose }),
  requestPose: (pose) => set({ pending: pose, pose }),
  pendingPose: () => get().pending,
  clearPendingPose: () => {
    if (get().pending !== null) set({ pending: null });
  },
}));

/**
 * The pose a link or a project file should carry, or null when the viewport
 * has never drawn.
 *
 * The imperative read, for the same callers `currentLayoutPayload` serves: a
 * module that is not a React component. A component that needs the value to
 * move its own memo subscribes to `pose` instead (`ActionBar`).
 */
export function currentCameraPayload(): CameraPayload | null {
  return cameraPayload(useCameraStore.getState().pose);
}

/**
 * Apply a payload, or leave this device's camera exactly where it is.
 *
 * Returns whether anything was adopted, so a caller can say so; a payload it
 * cannot read is not an error and never refuses the design around it.
 */
export function adoptCameraPayload(value: unknown): boolean {
  const pose = cameraFromPayload(value);
  if (pose === null) return false;
  useCameraStore.getState().requestPose(pose);
  return true;
}

/** Test seam: forget both directions. */
export function resetCameraForTest(): void {
  useCameraStore.setState({ pose: null, pending: null });
}
