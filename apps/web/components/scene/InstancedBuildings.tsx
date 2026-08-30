"use client";

import { useEffect, useRef } from "react";
import type { InstancedMesh } from "three";

import type { PrintParams } from "@/lib/contracts";
import { buildingInstanceMatrices, type PreviewBuilding } from "@/lib/preview";

/**
 * Every building in ONE InstancedMesh of a unit box (02: "use InstancedMesh
 * with a per-instance matrix, and rebuild only the affected instance buffer
 * when a slider moves").
 *
 * The footprint maths -- convex hull, minimum-area rectangle, minimum-feature
 * dilation -- happens once in `lib/preview.ts` and is memoised by the parent on
 * the params that change the scale. Moving a height slider only re-runs
 * `buildingInstanceMatrices`, which writes straight into the existing
 * `instanceMatrix` buffer: no geometry rebuild, no allocation, no React
 * reconciliation below this component.
 */
export function InstancedBuildings({
  buildings,
  params,
  scale,
  color,
}: {
  buildings: PreviewBuilding[];
  params: PrintParams;
  scale: number;
  color: string;
}) {
  const meshRef = useRef<InstancedMesh>(null);

  useEffect(() => {
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
  }, [buildings, params, scale]);

  if (buildings.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, buildings.length]}
      castShadow
      receiveShadow
      frustumCulled={false}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={color} roughness={0.75} metalness={0.02} />
    </instancedMesh>
  );
}

export default InstancedBuildings;
