"use client";

import { useEffect } from "react";
import { Grid, OrbitControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import type { PerspectiveCamera } from "three";

import PerfFrameMark from "@/components/scene/PerfFrameMark";
import type { RecessBand, RegionMesh, TileResult } from "@/lib/engine/types";
import { useCameraStore } from "@/store/camera";
import LabelGizmo from "./LabelGizmo";
import RegionMeshes, { type HoverHandler, type InspectHandler, type TintMap } from "./RegionMeshes";
import TileGrid from "./TileGrid";

/**
 * Everything inside the canvas.
 *
 * It is its own component because that is what makes the rule enforceable:
 * NOTHING drawn in the viewport may read a `PrintParams` field. Since v3.1 the
 * preview shows the pipeline's own solids and nothing else, so a control that
 * appears to do nothing can only ever be a stage that did not claim it, never
 * a preview layer that forgot to read it -- the class of defect the settings
 * complaint was made of. `CityPreview.test.ts` holds this file, and every
 * other file under `components/scene/`, to zero parameter reads.
 *
 * Since the v3-06 audit's finding C2 there are no exceptions left: hero
 * picking used to need an invisible `InstancedMesh` of oriented boxes placed
 * from `PrintParams`, because the fused region meshes were said to carry no
 * per-building identity. They do carry it ([V3.1-P1-18]), so the proxies are
 * gone and the `PrintParams` object no longer crosses the canvas boundary at
 * all -- not to be read, and not even to be passed through.
 */
export function PreviewScene({
  regions,
  recessBands,
  dimmed,
  dimOpacity,
  recessShade,
  tints,
  tiles,
  tileColor,
  background,
  sky,
  bounce,
  gridColor,
  plateMm,
  fitTrigger,
  onPick,
  onHover,
  onInspect,
}: {
  regions: ReadonlyMap<string, RegionMesh>;
  recessBands: readonly RecessBand[];
  dimmed: boolean;
  dimOpacity: number;
  recessShade: number;
  /** Per-building colours from `EngineResult.buildingTints`, or null when `colour.tint` is off. */
  tints: TintMap;
  tiles: TileResult[] | undefined;
  tileColor: string;
  background: string;
  sky: string;
  bounce: string;
  gridColor: string;
  /** Where to put the camera: the plate's own width in mm, from the finished model. */
  plateMm: number;
  /** Re-frames the view whenever this changes identity (a new scene). */
  fitTrigger: unknown;
  /** Hero picking: the id of the building whose solid was clicked. */
  onPick: (id: string) => void;
  /**
   * The object popover's feed: the raycast hit under the pointer, or null when
   * it leaves the pickable geometry. Handed straight to `RegionMeshes`, which
   * attaches it only to the regions that can name an object.
   */
  onHover?: HoverHandler;
  /**
   * The right-click inspector's feed: the region a context-menu click landed
   * on, or null when it landed on nothing. It answers for the base, the frame
   * and the matting too, which no hover reaches.
   */
  onInspect?: InspectHandler;
}) {
  return (
    <>
      <color attach="background" args={[background]} />
      <ambientLight intensity={0.65} />
      {/* Sky and ground bounce are tokens too: they were the last two raw
          colour literals in this file, and they set how the model reads. */}
      <hemisphereLight args={[sky, bounce, 0.5]} />
      <directionalLight
        position={[180, 260, 160]}
        intensity={1.5}
        castShadow
        shadow-mapSize={[1024, 1024]}
      />
      <directionalLight position={[-160, 120, -140]} intensity={0.4} />

      {/* Perf mode only: with it off this renders nothing and registers no
          per-frame callback at all (`PerfFrameMark`). */}
      <PerfFrameMark name="preview.firstFrame" />
      <FitView plateMm={plateMm} trigger={fitTrigger} />
      {/* Publishes the pose a link and a project file carry ([V3.1-U6]).
          Reads the camera, never a parameter, so the canvas rule holds. */}
      <CameraReporter />

      {/* Print space is z-up; three is y-up. One rotation, once. */}
      <group rotation={[-Math.PI / 2, 0, 0]}>
        <RegionMeshes
          regions={regions}
          recessBands={recessBands}
          dimmed={dimmed}
          dimOpacity={dimOpacity}
          recessShade={recessShade}
          tints={tints}
          onHover={onHover}
          onPick={onPick}
          onInspect={onInspect}
        />
        <TileGrid tiles={tiles} color={tileColor} />
        {/* The surface-label handles (v3.1 Task 12): pipeline output too, read
            straight off the store's result rather than threaded through props. */}
        <LabelGizmo color={tileColor} />
      </group>

      <Grid
        position={[0, -0.02, 0]}
        args={[1200, 1200]}
        cellSize={10}
        cellThickness={0.5}
        sectionSize={50}
        sectionThickness={0.8}
        cellColor={gridColor}
        sectionColor={gridColor}
        fadeDistance={900}
        fadeStrength={1.5}
        infiniteGrid
      />
      <OrbitControls makeDefault enableDamping dampingFactor={0.1} />
    </>
  );
}

/**
 * Frame the plate whenever a new scene arrives or the plate size changes --
 * unless a link or a project file asked for a pose, which wins once.
 *
 * A restored pose STANDS IN for the default framing rather than being applied
 * once ([V3.1-U6]). This effect runs on `plateMm`, which is the params default
 * until a model exists and the model's own measured width afterwards, so
 * opening a link and pressing Preview fires it twice; a one-shot claim was
 * taken by the first and overwritten by the second, and the link opened on the
 * default view. The claim is released instead by the user touching the
 * controls (`CameraReporter`), which is the event that actually means "this is
 * my camera now".
 *
 * The far plane is set from the plate either way: a restored pose is a
 * position and a target and says nothing about clipping, and a far plane left
 * at a previous plate's distance is how a model goes half-invisible.
 */
export function FitView({ plateMm, trigger }: { plateMm: number; trigger: unknown }) {
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const controls = useThree((state) => state.controls) as {
    target: { set: (x: number, y: number, z: number) => void };
    update: () => void;
  } | null;
  const pendingPose = useCameraStore((state) => state.pendingPose);

  useEffect(() => {
    const distance = plateMm * 1.15;
    camera.far = distance * 30;
    const restored = pendingPose();
    if (restored !== null) {
      camera.position.set(restored.position[0], restored.position[1], restored.position[2]);
      camera.updateProjectionMatrix();
      controls?.target.set(restored.target[0], restored.target[1], restored.target[2]);
      controls?.update();
      return;
    }
    camera.position.set(distance * 0.72, distance * 0.86, distance * 0.95);
    camera.updateProjectionMatrix();
    controls?.target.set(0, 0, 0);
    controls?.update();
  }, [camera, controls, plateMm, trigger, pendingPose]);

  return null;
}

/**
 * Report where the camera ended up, once per gesture.
 *
 * On the controls' `end` event and never per frame: the action bar subscribes
 * to this so the copied link carries the view the author is looking at, and a
 * per-frame write would re-encode the whole share payload on every pointer
 * move of an orbit. `end` fires once when a drag, a wheel or a pinch settles.
 */
export function CameraReporter() {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as
    | { target: { x: number; y: number; z: number }; addEventListener: (type: string, fn: () => void) => void; removeEventListener: (type: string, fn: () => void) => void }
    | null;
  const reportPose = useCameraStore((state) => state.reportPose);
  const clearPendingPose = useCameraStore((state) => state.clearPendingPose);

  useEffect(() => {
    if (controls === null) return;
    const report = (): void => {
      reportPose({
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: [controls.target.x, controls.target.y, controls.target.z],
      });
    };
    // Once now, so a design shared without touching the camera still carries
    // the framing the viewport chose rather than nothing at all.
    report();
    controls.addEventListener("end", report);
    // `start` is the user putting a hand on the camera, and the only thing that
    // ends a restored pose's claim on it.
    controls.addEventListener("start", clearPendingPose);
    return () => {
      controls.removeEventListener("end", report);
      controls.removeEventListener("start", clearPendingPose);
    };
  }, [camera, clearPendingPose, controls, reportPose]);

  return null;
}

export default PreviewScene;
