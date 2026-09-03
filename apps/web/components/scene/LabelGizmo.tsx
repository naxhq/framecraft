"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Html, Line } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { Group, Plane, Raycaster, Vector2, Vector3 } from "three";

import type { LabelBand } from "@/lib/engine/types";
import { labelKeyAction } from "@/lib/labelAnchor";
import { useEditorStore } from "@/store/editor";

/**
 * The surface-label gizmo (v3.1 Task 12): one outline and one drag handle per
 * label the pipeline cut, drawn on the face it was cut into.
 *
 * Everything here is pipeline OUTPUT. A handle sits at `LabelBand.pose`, the
 * anchor the `labels` stage resolved through `lib/labelAnchor.ts`; the outline
 * is the band's own ink rectangle; the height is the band's face plus the
 * `sit` shift the finished meshes were lifted by. Nothing drawn in the canvas
 * reads a parameter (`CityPreview.test.ts` holds this file to that), so a drag
 * hands the store engine millimetres and the store, where the scene and the
 * settings may be read, turns them into `u`, `v` and a rotation. The next
 * build's band then lands exactly under the handle, because the stage and the
 * store used the same maths on the same numbers.
 *
 * The handles are DOM (`drei`'s `Html`), not meshes: a real `<button>` can be
 * focused, carries an accessible name, takes the keyboard (arrows nudge, `[`
 * and `]` turn, `+` and `-` resize, Delete removes) and is something a
 * Playwright test can find and drag. Its pointer events never reach the canvas
 * under it, so a drag here never orbits the camera.
 *
 * While a drag is in flight the pipeline is still catching up (an 80 ms
 * debounce plus the label stages), so the outline follows the pointer from a
 * local override and snaps to the real band the moment a new result lands.
 */
export function LabelGizmo({
  color,
}: {
  /** Resolved token colour for the outline: the same one the tile grid draws with. */
  color: string;
}) {
  const bands = useEditorStore((state) => state.pipeline.result?.labelBands ?? NO_BANDS);
  const shiftMm = useEditorStore((state) => state.pipeline.result?.sitShiftMm ?? 0);
  const selected = useEditorStore((state) => state.selectedLabel);
  const selectLabel = useEditorStore((state) => state.selectLabel);
  const moveLabel = useEditorStore((state) => state.moveLabel);
  const rotateLabel = useEditorStore((state) => state.rotateLabel);
  const nudgeLabel = useEditorStore((state) => state.nudgeLabel);
  const turnLabel = useEditorStore((state) => state.turnLabel);
  const resizeLabel = useEditorStore((state) => state.resizeLabel);
  const removeLabel = useEditorStore((state) => state.removeLabel);

  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const groupRef = useRef<Group>(null);
  const raycaster = useMemo(() => new Raycaster(), []);

  const [override, setOverride] = useState<Override | null>(null);
  const drag = useRef<Drag | null>(null);
  // A fresh result is the truth again: the outline goes back to the band.
  useEffect(() => {
    if (drag.current === null) setOverride(null);
  }, [bands]);

  /** The plan point under a client position on the horizontal plane at `zMm`, engine mm. */
  const planePoint = useCallback(
    (clientX: number, clientY: number, zMm: number): { x: number; y: number } | null => {
      const group = groupRef.current;
      if (group === null) return null;
      const rect = gl.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const ndc = new Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      // The face's plane in this group's own (z-up, engine mm) frame, carried
      // into world space by the group's matrix, whatever rotation sits above.
      const plane = new Plane(new Vector3(0, 0, 1), -zMm).applyMatrix4(group.matrixWorld);
      const hit = new Vector3();
      if (raycaster.ray.intersectPlane(plane, hit) === null) return null;
      group.worldToLocal(hit);
      return { x: hit.x, y: hit.y };
    },
    [camera, gl, raycaster],
  );

  const flush = useCallback(() => {
    const current = drag.current;
    if (current === null || current.pending === null) return;
    const next = current.pending;
    current.pending = null;
    if (current.kind === "move") moveLabel(current.index, next.x, next.y);
    else rotateLabel(current.index, next.angle);
  }, [moveLabel, rotateLabel]);

  const onPointerDown = useCallback(
    (band: LabelBand, kind: DragKind) => (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      const pose = poseOf(band);
      const zMm = band.faceZMm + shiftMm;
      const at = planePoint(event.clientX, event.clientY, zMm);
      if (at === null) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
      selectLabel(band.index);
      drag.current = {
        index: band.index,
        kind,
        pointerId: event.pointerId,
        zMm,
        centre: { x: pose.x, y: pose.y },
        grab: { dx: at.x - pose.x, dy: at.y - pose.y },
        angle: pose.angle,
        moved: false,
        pending: null,
        frame: null,
      };
    },
    [planePoint, selectLabel, shiftMm],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const current = drag.current;
      if (current === null || current.pointerId !== event.pointerId) return;
      const at = planePoint(event.clientX, event.clientY, current.zMm);
      if (at === null) return;
      event.preventDefault();
      current.moved = true;
      if (current.kind === "move") {
        const x = at.x - current.grab.dx;
        const y = at.y - current.grab.dy;
        current.pending = { x, y, angle: current.angle };
        setOverride({ index: current.index, x, y, angle: current.angle });
      } else {
        const angle = (Math.atan2(at.y - current.centre.y, at.x - current.centre.x) * 180) / Math.PI;
        current.pending = { x: current.centre.x, y: current.centre.y, angle };
        setOverride({ index: current.index, x: current.centre.x, y: current.centre.y, angle });
      }
      // One store write per frame at most: every write reschedules a build.
      if (current.frame === null) {
        current.frame = requestAnimationFrame(() => {
          if (drag.current !== null) drag.current.frame = null;
          flush();
        });
      }
    },
    [flush, planePoint],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const current = drag.current;
      if (current === null || current.pointerId !== event.pointerId) return;
      if (current.frame !== null) cancelAnimationFrame(current.frame);
      current.frame = null;
      flush();
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      // A click that never moved keeps the outline where the band is.
      if (!current.moved) setOverride(null);
    },
    [flush],
  );

  const onKeyDown = useCallback(
    (index: number) => (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const action = labelKeyAction(event);
      if (action === null) return;
      event.preventDefault();
      event.stopPropagation();
      switch (action.kind) {
        case "nudge":
          nudgeLabel(index, action.dxMm, action.dyMm);
          break;
        case "turn":
          turnLabel(index, action.deltaDeg);
          break;
        case "resize":
          resizeLabel(index, action.deltaMm);
          break;
        case "remove":
          removeLabel(index);
          break;
        case "deselect":
          selectLabel(null);
          event.currentTarget.blur();
          break;
        default: {
          const never: never = action;
          throw new Error(`unknown label key action ${String(never)}`);
        }
      }
    },
    [nudgeLabel, removeLabel, resizeLabel, selectLabel, turnLabel],
  );

  // One stable <group>, whatever the band count: r3f applies a dashed prop such
  // as `data-testid` as a nested path (`data.testid`) and throws on UPDATE
  // when the object has no `data`, so a group that gained or lost the
  // attribute between renders took the whole canvas down. The handles are
  // DOM and carry the test ids; the group carries nothing.
  return (
    <group ref={groupRef}>
      {bands.map((band) => {
        const isSelected = selected === band.index;
        const base = poseOf(band);
        const shown = override !== null && override.index === band.index ? override : base;
        const z = band.zMm[1] + shiftMm + LINE_HEADROOM_MM;
        const outline = transformed(band.rect, base, shown).map(([x, y]) => [x, y, z] as [number, number, number]);
        outline.push(outline[0]);
        const halfLength = extentAlong(band.rect, base);
        const theta = (shown.angle * Math.PI) / 180;
        const rotateAt: [number, number, number] = [
          shown.x + (halfLength + ROTATE_HANDLE_GAP_MM) * Math.cos(theta),
          shown.y + (halfLength + ROTATE_HANDLE_GAP_MM) * Math.sin(theta),
          z,
        ];
        return (
          <group key={band.id}>
            <Line points={outline} color={color} lineWidth={isSelected ? 2.5 : 1} dashed={!isSelected} dashSize={1.5} gapSize={1} />
            {isSelected ? (
              <Line
                points={[
                  [shown.x, shown.y, z],
                  rotateAt,
                ]}
                color={color}
                lineWidth={1}
              />
            ) : null}
            <Html position={[shown.x, shown.y, z]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
              <button
                type="button"
                data-testid={`label-handle-${band.index}`}
                data-label-index={band.index}
                data-selected={isSelected ? "true" : "false"}
                aria-label={`Label ${band.index + 1}: drag to move it; arrow keys nudge, [ and ] turn, + and - resize, Delete removes`}
                aria-pressed={isSelected}
                title="Drag to move this label"
                className={`pointer-events-auto block h-3.5 w-3.5 cursor-move rounded-full border-2 shadow-raised ${
                  isSelected ? "border-plate bg-ink" : "border-ink bg-plate/95"
                }`}
                onPointerDown={onPointerDown(band, "move")}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={onKeyDown(band.index)}
              />
            </Html>
            {isSelected ? (
              <Html position={rotateAt} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
                <button
                  type="button"
                  data-testid={`label-rotate-${band.index}`}
                  aria-label={`Turn label ${band.index + 1}: drag around its centre`}
                  title="Drag to turn this label"
                  className="pointer-events-auto block h-2.5 w-2.5 cursor-grab rounded-sm border-2 border-ink bg-plate/95 shadow-raised"
                  onPointerDown={onPointerDown(band, "rotate")}
                  onPointerMove={onPointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onKeyDown={onKeyDown(band.index)}
                />
              </Html>
            ) : null}
          </group>
        );
      })}
    </group>
  );
}

const NO_BANDS: readonly LabelBand[] = [];

/** Headroom above the band's top (the face, or the raised letters), mm, so the outline sits clear of the model. */
const LINE_HEADROOM_MM = 0.3;

/** How far past the end of the text the rotation handle sits, mm. */
const ROTATE_HANDLE_GAP_MM = 4;

type DragKind = "move" | "rotate";

interface Pose {
  x: number;
  y: number;
  angle: number;
}

interface Override extends Pose {
  index: number;
}

interface Drag {
  index: number;
  kind: DragKind;
  pointerId: number;
  /** The face's height, sat, so every point of the drag is on the plane the text lies in. */
  zMm: number;
  centre: { x: number; y: number };
  /** Pointer minus centre at the grab, so the label does not jump under the pointer. */
  grab: { dx: number; dy: number };
  angle: number;
  moved: boolean;
  pending: Pose | null;
  frame: number | null;
}

/** The band's pose, or the rectangle's own centre and long edge when the stage wrote none. */
function poseOf(band: LabelBand): Pose {
  if (band.pose !== undefined) return { x: band.pose.xMm, y: band.pose.yMm, angle: band.pose.angleDeg };
  let x = 0;
  let y = 0;
  for (const [px, py] of band.rect) {
    x += px;
    y += py;
  }
  const n = Math.max(1, band.rect.length);
  let best = 0;
  let bestLength = -1;
  for (let i = 0; i < band.rect.length; i += 1) {
    const a = band.rect[i];
    const b = band.rect[(i + 1) % band.rect.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > bestLength) {
      bestLength = length;
      best = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    }
  }
  return { x: x / n, y: y / n, angle: best };
}

/** `rect` carried from pose `from` to pose `to`: translated with the centre, turned about it. */
function transformed(
  rect: ReadonlyArray<readonly [number, number]>,
  from: Pose,
  to: Pose,
): Array<[number, number]> {
  const turn = ((to.angle - from.angle) * Math.PI) / 180;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  return rect.map(([px, py]) => {
    const dx = px - from.x;
    const dy = py - from.y;
    return [to.x + dx * cos - dy * sin, to.y + dx * sin + dy * cos];
  });
}

/** Half the rectangle's extent along the reading direction, mm. */
function extentAlong(rect: ReadonlyArray<readonly [number, number]>, pose: Pose): number {
  const theta = (pose.angle * Math.PI) / 180;
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  let extent = 0;
  for (const [px, py] of rect) extent = Math.max(extent, Math.abs((px - pose.x) * ux + (py - pose.y) * uy));
  return extent;
}

export default LabelGizmo;
