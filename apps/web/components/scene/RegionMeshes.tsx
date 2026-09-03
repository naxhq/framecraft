"use client";

import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry } from "three";

import PerfFrameMark from "@/components/scene/PerfFrameMark";
import type { RegionMesh } from "@/lib/engine/types";
import { perfSpan } from "@/lib/perf";

/** Identity counter for `built`: what re-arms the on-screen mark. */
let buildCounter = 0;

/**
 * The real thing: every `RegionMesh` the browser engine (`lib/engine/engine.ts`
 * `buildModel()`) produced, rendered exactly as it will be exported -- same
 * triangles, same per-region colour, no instancing, no dilation, no flat
 * fills standing in for a groove. This is what `CityPreview.tsx` shows once a
 * fresh `EngineResult` lands (`state.engine.status === "ready" && !stale`);
 * while a newer one is computing it falls back to the fast instanced v1
 * preview instead of showing THESE meshes gone stale, so the picture on
 * screen never disagrees with the file a Build would export.
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
  // `preview.geometryBuild` is CPU time and only CPU time: the float64 ->
  // float32 copy, the index attribute, the vertex normals and the bounding
  // sphere for every region, on the main thread -- the one preview cost the
  // engine's own timings cannot see. Nothing here touches the GPU. three.js
  // uploads a buffer lazily, on the first render that binds it, which is after
  // this span has closed; `preview.geometryOnScreen` below is that frame.
  // `perfSpan` is a boolean read with perf mode off (`lib/perf.ts`).
  //
  // The build carries an id as well as the meshes: it counts up once per fresh
  // EngineResult, and keying the probe below on it is what re-arms the
  // on-screen mark for each new set of geometries.
  const built = useMemo(() => {
    buildCounter += 1;
    return {
      id: buildCounter,
      meshes: perfSpan("preview.geometryBuild", () =>
        regions
          .filter((region) => region.indices.length >= 3 && region.positions.length >= 9)
          .map((region) => ({ region, geometry: buildGeometry(region) })),
      ),
    };
  }, [regions]);

  // Every geometry this memo built is this component's own to dispose, the
  // moment `regions` changes identity (a fresh EngineResult) or it unmounts.
  useEffect(
    () => () => {
      for (const { geometry } of built.meshes) geometry.dispose();
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
      {/* Perf mode only: the first frame that actually renders these meshes,
          which is where three.js uploads the buffers this component built. */}
      <PerfFrameMark key={built.id} name="preview.geometryOnScreen" />
      {built.meshes.map(({ region, geometry }) => (
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
