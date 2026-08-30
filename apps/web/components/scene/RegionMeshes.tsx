"use client";

import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry } from "three";

import type { RegionMesh } from "@/lib/engine/types";

/**
 * The real thing: every `RegionMesh` the browser engine (`lib/engine/engine.ts`
 * `bake()`) produced, rendered exactly as it will be exported -- same
 * triangles, same per-region colour, no instancing, no dilation, no flat
 * fills standing in for a groove. This is what `CityPreview.tsx` shows once a
 * fresh `EngineResult` lands (`state.engine.status === "ready" && !stale`);
 * while a newer one is computing it falls back to the fast instanced v1
 * preview instead of showing THESE meshes gone stale, so the picture on
 * screen never disagrees with the file a Bake would export.
 *
 * `RegionMesh.positions`/`indices` are already interleaved xyz triples / a
 * flat triangle index list in print millimetres, so each becomes exactly one
 * `BufferGeometry` with no re-triangulation. `flatShading` reads the geometry
 * with per-face normals in the fragment shader (via `fwidth`) without needing
 * duplicated per-face vertices, which matters here: a manifold3d mesh shares
 * vertices across faces (that is what makes it watertight), and smooth vertex
 * normals on a building's sharp edges would round them off.
 *
 * `RegionMesh.positions` is double precision (`lib/engine/types.ts`: a
 * consumer that writes a FILE must keep that precision, but a GPU buffer
 * cannot hold one and has to make its own float32 copy) -- WebGL vertex
 * buffers do not support `Float64Array`, so this is that copy, made once
 * here and nowhere else in the render path.
 */
export function buildGeometry(region: RegionMesh): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(region.positions), 3));
  geometry.setIndex(new BufferAttribute(region.indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export function RegionMeshes({ regions }: { regions: readonly RegionMesh[] }) {
  const built = useMemo(
    () =>
      regions
        .filter((region) => region.indices.length >= 3 && region.positions.length >= 9)
        .map((region) => ({ region, geometry: buildGeometry(region) })),
    [regions],
  );

  // Every geometry this memo built is this component's own to dispose, the
  // moment `regions` changes identity (a fresh EngineResult) or it unmounts.
  useEffect(
    () => () => {
      for (const { geometry } of built) geometry.dispose();
    },
    [built],
  );

  // `data-testid` on a react-three-fiber primitive is NOT a DOM attribute --
  // `<group>`/`<mesh>` become real `THREE.Object3D` instances inside the
  // WebGL canvas, not HTML elements, so a Playwright DOM locator can never
  // find these. They are still named for anyone reading the render tree with
  // r3f devtools or the `useThree` state directly; an e2e that needs to prove
  // the fresh result is on screen has to use a different signal (the stats
  // card's numbers, `state.engine.status`, or `scene.children` via
  // `page.evaluate`), not a DOM query.
  return (
    <group data-testid="region-meshes">
      {built.map(({ region, geometry }) => (
        <mesh
          key={region.region}
          data-testid={`region-mesh-${region.region}`}
          geometry={geometry}
          castShadow
          receiveShadow
        >
          <meshStandardMaterial color={region.colorHex} roughness={0.85} flatShading />
        </mesh>
      ))}
    </group>
  );
}

export default RegionMeshes;
