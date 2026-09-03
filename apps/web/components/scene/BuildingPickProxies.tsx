"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import type { InstancedMesh } from "three";

import type { PrintParams } from "@/lib/contracts";
import { heroHeightKey } from "@/lib/heroes";
import { buildingInstanceMatrices, type PreviewBuilding } from "@/lib/preview";

/**
 * The picking layer: one invisible oriented box per building, in a single
 * InstancedMesh, raycast against and never drawn.
 *
 * This is named exception 1 in `docs/handoff/v3-01-pipeline.md` section 5. The
 * viewport draws the pipeline's fused region meshes, which carry no
 * per-building identity to pick out -- a raycast against `region-buildings`
 * can say "a building" but never "which one" -- so clicking a hero, and the
 * keyboard cursor that does the same thing without a mouse, need a surface
 * that still knows the ids. These boxes are that surface and nothing else:
 * they are never rendered, they cast and receive no shadow, and no parameter
 * they read reaches a pixel.
 *
 * **Invisible, not hidden.** `visible={false}` removes an object from
 * three.js's raycast entirely (`Raycaster.intersectObject` returns
 * immediately), which would take hero picking with it. `colorWrite: false`
 * with `depthWrite: false` on a transparent material leaves the mesh fully
 * live for picking while contributing nothing to the colour or the depth
 * buffer, so it cannot tint, occlude or shadow the real geometry underneath.
 * Verified against `node_modules/three/src/core/Raycaster.js`'s own
 * `intersectObject`, which checks `visible` and nothing else about the
 * material.
 *
 * Tasks 10 and 11 extend this layer (per-object overrides and labels); today
 * it is hero picking alone.
 */

/**
 * The primitives `buildingInstanceMatrices` actually reads, in one place.
 *
 * `store.setParam` rebuilds `params` by spread on every write, so an effect
 * keyed on the object re-ran over all 994 Chicago instances and re-uploaded
 * `instanceMatrix` on every write of any kind.
 *
 * The matrices depend on the base thickness (where buildings start), the two
 * height multipliers, and -- since heroes stand at their hero height --
 * `heroHeightKey`, which is the STRING form of `transform.hero_height_ids`:
 * empty while `hero_mode` is `own_color`, so giving a hero its own filament is
 * still a colour-only change that uploads nothing.
 */
export function matrixDeps(
  buildings: PreviewBuilding[],
  scale: number,
  params: PrintParams,
): unknown[] {
  return [
    buildings,
    scale,
    params.base_thickness_mm,
    params.small_scale,
    params.large_scale,
    heroHeightKey(params),
  ];
}

export function BuildingPickProxies({
  buildings,
  params,
  scale,
  onPick,
}: {
  buildings: PreviewBuilding[];
  /**
   * Read ONLY to place the boxes where the real buildings stand, so a click
   * lands on the building the user is looking at. Nothing here is drawn, which
   * is why this component is one of the two exemptions in
   * `CityPreview.test.ts`'s "no rendered layer reads PrintParams" sweep.
   */
  params: PrintParams;
  scale: number;
  onPick: (id: string) => void;
}) {
  const meshRef = useRef<InstancedMesh>(null);
  /** Where the pointer went down, so an orbit drag is not read as a click. */
  const downAt = useRef<{ x: number; y: number } | null>(null);

  useEffect(
    () => {
      const mesh = meshRef.current;
      if (!mesh) return;
      buildingInstanceMatrices(
        buildings,
        params,
        scale,
        mesh.instanceMatrix.array as Float32Array,
      );
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    matrixDeps(buildings, scale, params),
  );

  useEffect(() => {
    return () => {
      document.body.style.cursor = "";
    };
  }, []);

  const count = useMemo(() => buildings.length, [buildings]);
  if (count === 0) return null;

  const handleDown = (event: ThreeEvent<PointerEvent>): void => {
    downAt.current = { x: event.nativeEvent.clientX, y: event.nativeEvent.clientY };
  };

  const handleClick = (event: ThreeEvent<MouseEvent>): void => {
    const instance = event.instanceId;
    if (instance === undefined || instance >= buildings.length) return;
    const start = downAt.current;
    downAt.current = null;
    if (start) {
      const moved = Math.hypot(
        event.nativeEvent.clientX - start.x,
        event.nativeEvent.clientY - start.y,
      );
      // An orbit drag that happens to end on a building is not a pick.
      if (moved > 4) return;
    }
    event.stopPropagation();
    onPick(buildings[instance].id);
  };

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, count]}
      castShadow={false}
      receiveShadow={false}
      frustumCulled={false}
      onPointerDown={handleDown}
      onClick={handleClick}
      onPointerOver={() => {
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        document.body.style.cursor = "";
      }}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
    </instancedMesh>
  );
}

export default BuildingPickProxies;
