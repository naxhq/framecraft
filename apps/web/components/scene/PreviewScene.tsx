"use client";

import { useEffect } from "react";
import { Grid, OrbitControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import type { PerspectiveCamera } from "three";

import PerfFrameMark from "@/components/scene/PerfFrameMark";
import type { RecessBand, RegionMesh, TileResult } from "@/lib/engine/types";
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

/** Frame the plate whenever a new scene arrives or the plate size changes. */
export function FitView({ plateMm, trigger }: { plateMm: number; trigger: unknown }) {
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const controls = useThree((state) => state.controls) as {
    target: { set: (x: number, y: number, z: number) => void };
    update: () => void;
  } | null;

  useEffect(() => {
    const distance = plateMm * 1.15;
    camera.position.set(distance * 0.72, distance * 0.86, distance * 0.95);
    camera.far = distance * 30;
    camera.updateProjectionMatrix();
    controls?.target.set(0, 0, 0);
    controls?.update();
  }, [camera, controls, plateMm, trigger]);

  return null;
}

export default PreviewScene;
