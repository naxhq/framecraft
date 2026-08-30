"use client";

import { useEffect, useMemo, useRef } from "react";
import { BufferAttribute, BufferGeometry } from "three";

import type { PreviewRibbons } from "@/lib/preview";

/**
 * All roads as one flat ribbon mesh.
 *
 * `lib/preview.ts` already produced the triangles in print millimetres, so this
 * only has to get them onto the GPU. Two things make that cheap on a slider
 * drag, which matters because a 900 m Chicago crop is ~55k road triangles:
 *
 *  - The triangle *topology* never changes with scale (only vertex positions
 *    do), so when the incoming buffer is the same length the existing
 *    attribute is updated in place instead of allocating a new geometry and a
 *    new GPU buffer.
 *  - Every triangle is flat and faces +z, so the normals are written once
 *    instead of running `computeVertexNormals()` over 165k vertices per move.
 *
 * The mesh sits at the road z offset the shared transform reports. Engraved
 * roads are drawn just *above* the base top rather than cut into it, because
 * cutting needs a boolean and the browser never runs one (02) -- the
 * approximation note under the canvas says so.
 */
export function RoadRibbons({
  ribbons,
  zMm,
  color,
}: {
  ribbons: PreviewRibbons;
  zMm: number;
  color: string;
}) {
  const geometryRef = useRef<BufferGeometry | null>(null);

  const geometry = useMemo(() => {
    const existing = geometryRef.current;
    const attribute = existing?.getAttribute("position") as BufferAttribute | undefined;
    if (existing && attribute && attribute.array.length === ribbons.positions.length) {
      (attribute.array as Float32Array).set(ribbons.positions);
      attribute.needsUpdate = true;
      existing.computeBoundingSphere();
      return existing;
    }

    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(ribbons.positions.slice(), 3));
    const normals = new Float32Array(ribbons.positions.length);
    for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
    geo.setAttribute("normal", new BufferAttribute(normals, 3));
    geo.computeBoundingSphere();
    existing?.dispose();
    geometryRef.current = geo;
    return geo;
  }, [ribbons]);

  useEffect(
    () => () => {
      geometryRef.current?.dispose();
      geometryRef.current = null;
    },
    [],
  );

  return (
    <mesh geometry={geometry} position={[0, 0, zMm]} receiveShadow>
      <meshStandardMaterial
        color={color}
        roughness={0.9}
        polygonOffset
        polygonOffsetFactor={-2}
        polygonOffsetUnits={-2}
      />
    </mesh>
  );
}

export default RoadRibbons;
