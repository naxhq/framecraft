"use client";

import { useEffect, useMemo, useRef } from "react";
import { ConeGeometry, type InstancedMesh } from "three";

import { treeInstanceMatrices, type PreviewTree } from "@/lib/preview";

/**
 * Trees as one InstancedMesh of an 8-sided cone (04 stage 1: "Model as an
 * 8-sided cone, height 3x radius", capped at 2000 keeping the largest -- the
 * selection itself happens in the shared transform, so the preview shows
 * exactly the trees the bake will emit).
 *
 * The unit cone is built once with its axis along +z to match the print frame,
 * so an instance matrix is a pure scale + translate.
 */
export function TreeInstances({
  trees,
  baseTopMm,
  color,
}: {
  trees: PreviewTree[];
  baseTopMm: number;
  color: string;
}) {
  const meshRef = useRef<InstancedMesh>(null);

  const geometry = useMemo(() => {
    const cone = new ConeGeometry(1, 1, 8);
    // three builds cones around +y; the print frame is z-up.
    cone.rotateX(Math.PI / 2);
    return cone;
  }, []);

  useEffect(() => () => geometry.dispose(), [geometry]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    treeInstanceMatrices(trees, baseTopMm, mesh.instanceMatrix.array as Float32Array);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [trees, baseTopMm]);

  if (trees.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, undefined, trees.length]}
      castShadow
      frustumCulled={false}
    >
      <meshStandardMaterial color={color} roughness={0.9} />
    </instancedMesh>
  );
}

export default TreeInstances;
