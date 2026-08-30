"use client";

import { useEffect, useMemo } from "react";
import { Grid, OrbitControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import type { PerspectiveCamera } from "three";

import type { PrintParams, SceneGraph } from "@/lib/contracts";
import {
  buildAreas,
  buildBuildings,
  buildRoads,
  buildTrees,
  mergeNoticeMetres,
  treeFloorNoticeMetres,
} from "@/lib/preview";
import * as T from "@/lib/transform";
import { predictedTopMm, warningDeps } from "@/lib/warnings";
import { useEditorStore } from "@/store/editor";
import AreaSurfaces from "./AreaSurfaces";
import BasePlate from "./BasePlate";
import InstancedBuildings from "./InstancedBuildings";
import RoadRibbons from "./RoadRibbons";
import TreeInstances from "./TreeInstances";

/**
 * The live 3D preview.
 *
 * Everything below is drawn in PRINT MILLIMETRES in the SceneGraph frame
 * (x east, y north, z up); the single `rotation` on the root group is the only
 * concession to three.js being y-up, so no component has to think in two
 * coordinate systems.
 *
 * Slider budget (02: under 33 ms): every `useMemo` below is keyed through
 * `previewDeps`, which names exactly the primitives that change its output --
 * never the `params` object, which `setParam` re-creates on every write. A
 * height slider therefore touches nothing except `InstancedBuildings`'s matrix
 * buffer.
 *
 * Preview approximations, all deliberate, all because the browser never runs
 * booleans (02):
 *  - buildings are oriented boxes, not their real footprints;
 *  - the minimum-feature repair is a per-footprint dilation, so neighbours that
 *    the bake would merge into one block are still drawn separately;
 *  - engraved roads and recessed water are drawn on the surface instead of cut
 *    into the slab.
 * The banner under the canvas says so, using the real threshold.
 */

const THEME_COLOURS = {
  light: {
    background: "#eef2f6",
    base: "#d8dee7",
    frame: "#b8c1cf",
    building: "#f4f5f7",
    road: "#98a2b3",
    water: "#7cc4e8",
    green: "#a9cf8c",
    tree: "#5d8f52",
    grid: "#c3cad6",
  },
  dark: {
    background: "#0b1220",
    base: "#1f2937",
    frame: "#374151",
    building: "#cbd5e1",
    road: "#64748b",
    water: "#2b6f9e",
    green: "#4b7c46",
    tree: "#6fa35f",
    grid: "#1f2937",
  },
} as const;

/**
 * The memo keys of every derived preview layer, in one place.
 *
 * 02: "rebuild only the affected instance buffer when a slider moves". The
 * trap is that `store.setParam` rebuilds `params` by spread on every write, so
 * ANY dependency list that names `params` (or an object derived from it, such
 * as the `Thresholds` record) is invalidated by every slider tick -- including
 * the height sliders, which would re-run earcut over ~700 green polygons and
 * re-upload a fresh BufferGeometry per frame of a drag.
 *
 * Every entry below must therefore be a primitive read off `params`, or an
 * identity-stable object (`graph`). `CityPreview.test.ts` enforces both halves.
 */
export const previewDeps = {
  /** `scale_mm_per_m` -> `usable_span_mm`: plate width and the frame only. */
  scale: (graph: SceneGraph | null, params: PrintParams): unknown[] => [
    graph,
    params.plate_mm,
    params.frame,
  ],
  /** `thresholds_ground_m` reads the nozzle and the (numeric) scale. */
  thresholds: (scale: number | null, params: PrintParams): unknown[] => [
    scale,
    params.nozzle_mm,
  ],
  /** Hulls and oriented rectangles: scale + thresholds, never a height. */
  layout: (graph: SceneGraph | null, params: PrintParams): unknown[] => [
    graph,
    params.plate_mm,
    params.frame,
    params.nozzle_mm,
  ],
  roads: (graph: SceneGraph | null, params: PrintParams): unknown[] => [
    graph,
    params.plate_mm,
    params.frame,
    params.nozzle_mm,
    params.road_scale,
    params.road_mode,
  ],
  water: (
    graph: SceneGraph | null,
    scale: number | null,
    params: PrintParams,
  ): unknown[] => [graph, scale, params.nozzle_mm, params.water],
  green: (
    graph: SceneGraph | null,
    scale: number | null,
    params: PrintParams,
  ): unknown[] => [graph, scale, params.nozzle_mm],
  /**
   * The tree filter reads the nozzle too: `transform.tree_min_radius_mm` raises
   * the printed-radius floor above 04's 0.5 mm from a 0.47 mm nozzle up, and the
   * preview must hide exactly the trees the bake drops (DECISIONS [P5-web]).
   */
  trees: (graph: SceneGraph | null, params: PrintParams): unknown[] => [
    graph,
    params.plate_mm,
    params.frame,
    params.nozzle_mm,
    params.trees,
  ],
  /** The predicted model top: the 60 mm guard and the HUD read it. */
  height: (graph: SceneGraph | null, params: PrintParams): unknown[] =>
    warningDeps(graph, params),
} as const;

export function CityPreview() {
  const graph = useEditorStore((state) => state.scene.graph);
  const status = useEditorStore((state) => state.scene.status);
  const params = useEditorStore((state) => state.params);
  const theme = useEditorStore((state) => state.theme);
  const colours = THEME_COLOURS[theme];

  const scale = useMemo(
    () =>
      graph ? T.scale_mm_per_m(params, T.radius_m_from_bounds(graph.bounds)) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    previewDeps.scale(graph, params),
  );
  // `scale` is a number, so an identical recomputation is identity-stable and
  // the layers below are not invalidated by it. `thresholds` is an object, so
  // it must be keyed on the nozzle alone or every slider tick re-triangulates.
  const thresholds = useMemo(
    () => (scale === null ? null : T.thresholds_ground_m(params, scale)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    previewDeps.thresholds(scale, params),
  );

  // The footprint layout depends only on the parameters that move the scale
  // (plate, frame) and the thresholds (nozzle). Height sliders must NOT
  // invalidate it: rebuilding 5000 convex hulls per frame blows the budget.
  const layout = useMemo(
    () =>
      graph
        ? buildBuildings(graph, params)
        : { buildings: [], dilatedCount: 0, droppedCount: 0 },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    previewDeps.layout(graph, params),
  );

  const roads = useMemo(
    () => (graph ? buildRoads(graph, params) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    previewDeps.roads(graph, params),
  );

  const water = useMemo(
    () =>
      graph && scale !== null && thresholds !== null && params.water
        ? buildAreas(graph.water, params, scale, thresholds)
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    previewDeps.water(graph, scale, params),
  );

  const green = useMemo(
    () =>
      graph && scale !== null && thresholds !== null
        ? buildAreas(graph.green, params, scale, thresholds)
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    previewDeps.green(graph, scale, params),
  );

  const trees = useMemo(
    () => (graph ? buildTrees(graph, params) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    previewDeps.trees(graph, params),
  );

  // 04 stage 4 caps the model at 60 mm and the bake refuses to start above it.
  // Showing the number on the canvas is what makes the disabled Bake button
  // legible while the height sliders move.
  const predictedTop = useMemo(
    () => predictedTopMm(graph, params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    previewDeps.height(graph, params),
  );

  const baseTop = T.base_top_mm(params);
  const roadZ = T.road_z_mm(params);
  const waterZ = T.water_z_mm(params);
  const treeFloor =
    scale === null || !params.trees ? null : treeFloorNoticeMetres(params, scale);

  if (!graph || scale === null || thresholds === null) {
    return (
      <div
        data-testid="preview-empty"
        className="flex h-full w-full items-center justify-center bg-neutral-100 p-6 text-center text-sm text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400"
      >
        {status === "loading"
          ? "Fetching the scene..."
          : "Pick a location or a preset, then click Generate."}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <Canvas
        shadows="percentage"
        dpr={[1, 2]}
        camera={{ position: [140, 170, 190], fov: 40, near: 1, far: 5000 }}
        data-testid="preview-canvas"
      >
        <color attach="background" args={[colours.background]} />
        <ambientLight intensity={0.65} />
        <hemisphereLight args={[0xffffff, 0x445566, 0.5]} />
        <directionalLight
          position={[180, 260, 160]}
          intensity={1.5}
          castShadow
          shadow-mapSize={[1024, 1024]}
        />
        <directionalLight position={[-160, 120, -140]} intensity={0.4} />

        <FitView plateMm={params.plate_mm} trigger={graph} />

        {/* Print space is z-up; three is y-up. One rotation, once. */}
        <group rotation={[-Math.PI / 2, 0, 0]}>
          <BasePlate
            params={params}
            baseColor={colours.base}
            frameColor={colours.frame}
          />
          {water.length > 0 && waterZ !== null ? (
            <AreaSurfaces
              areas={water}
              zMm={baseTop + Math.max(waterZ, 0.02)}
              color={colours.water}
            />
          ) : null}
          <AreaSurfaces
            areas={green}
            zMm={baseTop + T.green_z_mm(params)}
            color={colours.green}
          />
          {roads && roadZ !== null ? (
            <RoadRibbons
              ribbons={roads}
              zMm={baseTop + Math.max(roadZ, 0.04)}
              color={colours.road}
            />
          ) : null}
          <InstancedBuildings
            buildings={layout.buildings}
            params={params}
            scale={scale}
            color={colours.building}
          />
          <TreeInstances trees={trees} baseTopMm={baseTop} color={colours.tree} />
        </group>

        <Grid
          position={[0, -0.02, 0]}
          args={[1200, 1200]}
          cellSize={10}
          cellThickness={0.5}
          sectionSize={50}
          sectionThickness={0.8}
          cellColor={colours.grid}
          sectionColor={colours.grid}
          fadeDistance={900}
          fadeStrength={1.5}
          infiniteGrid
        />
        <OrbitControls makeDefault enableDamping dampingFactor={0.1} />
      </Canvas>

      <div className="pointer-events-none absolute bottom-2 left-2 right-2 flex flex-wrap gap-2 text-[11px]">
        <span
          data-testid="preview-approximation"
          className="rounded bg-white/85 px-2 py-1 text-neutral-700 shadow dark:bg-neutral-900/85 dark:text-neutral-200"
        >
          Preview is approximate: the bake merges buildings closer than{" "}
          {mergeNoticeMetres(thresholds).toFixed(1)} m, and cuts engraved roads and
          water into the plate.
        </span>
        <span
          data-testid="preview-stats"
          className="rounded bg-white/85 px-2 py-1 text-neutral-700 shadow dark:bg-neutral-900/85 dark:text-neutral-200"
        >
          {layout.buildings.length} buildings · {trees.length} trees · 1:
          {Math.round(1000 / scale).toLocaleString("en-US")}
          {predictedTop !== null ? ` · ${predictedTop.toFixed(1)} mm tall` : ""}
          {layout.dilatedCount > 0
            ? ` · ${layout.dilatedCount} widened to the ${thresholds.min_wall.toFixed(1)} m minimum wall`
            : ""}
          {layout.droppedCount > 0 ? ` · ${layout.droppedCount} dropped as too small` : ""}
        </span>
        {predictedTop !== null && predictedTop >= T.MAX_HEIGHT_MM ? (
          <span
            data-testid="preview-too-tall"
            className="rounded bg-red-600/90 px-2 py-1 font-medium text-white shadow"
          >
            Model would be {predictedTop.toFixed(1)} mm tall (limit{" "}
            {T.MAX_HEIGHT_MM.toFixed(0)} mm) — the bake will refuse it.
          </span>
        ) : null}
        {treeFloor !== null ? (
          <span
            data-testid="preview-tree-floor"
            className="rounded bg-white/85 px-2 py-1 text-neutral-700 shadow dark:bg-neutral-900/85 dark:text-neutral-200"
          >
            A {params.nozzle_mm} mm nozzle drops trees under {treeFloor.toFixed(1)} m of
            site radius.
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Frame the plate whenever a new scene arrives or the plate size changes. */
function FitView({ plateMm, trigger }: { plateMm: number; trigger: unknown }) {
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

export default CityPreview;
