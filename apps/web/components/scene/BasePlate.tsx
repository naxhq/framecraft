"use client";

import type { PrintParams } from "@/lib/contracts";
import * as T from "@/lib/transform";

/**
 * The base slab and the optional frame lip, straight from the shared
 * transform: the slab runs z = 0 .. `base_thickness_mm`, the lip is 6 mm wide
 * and rises 2 mm above the base top (04 stage 2.1 / 2.2).
 *
 * The 0.6 mm bottom chamfer that kills elephant foot is a build-only detail: it
 * is invisible at preview scale and modelling it would cost a custom
 * geometry per frame.
 */
export function BasePlate({
  params,
  baseColor,
  frameColor,
}: {
  params: PrintParams;
  baseColor: string;
  frameColor: string;
}) {
  const plate = T.plate_extents_mm(params);
  const frame = T.frame_geometry_mm(params);
  const baseTop = T.base_top_mm(params);
  const lip = frame.top_mm - frame.bottom_mm;
  const barOffset = plate.size / 2 - frame.width_mm / 2;
  const sideLength = plate.size - 2 * frame.width_mm;

  return (
    <group>
      <mesh position={[0, 0, baseTop / 2]} receiveShadow castShadow>
        <boxGeometry args={[plate.size, plate.size, baseTop]} />
        <meshStandardMaterial color={baseColor} roughness={0.85} />
      </mesh>

      {frame.enabled ? (
        <group position={[0, 0, frame.bottom_mm + lip / 2]}>
          <mesh position={[0, barOffset, 0]} castShadow receiveShadow>
            <boxGeometry args={[plate.size, frame.width_mm, lip]} />
            <meshStandardMaterial color={frameColor} roughness={0.7} />
          </mesh>
          <mesh position={[0, -barOffset, 0]} castShadow receiveShadow>
            <boxGeometry args={[plate.size, frame.width_mm, lip]} />
            <meshStandardMaterial color={frameColor} roughness={0.7} />
          </mesh>
          <mesh position={[barOffset, 0, 0]} castShadow receiveShadow>
            <boxGeometry args={[frame.width_mm, sideLength, lip]} />
            <meshStandardMaterial color={frameColor} roughness={0.7} />
          </mesh>
          <mesh position={[-barOffset, 0, 0]} castShadow receiveShadow>
            <boxGeometry args={[frame.width_mm, sideLength, lip]} />
            <meshStandardMaterial color={frameColor} roughness={0.7} />
          </mesh>
        </group>
      ) : null}
    </group>
  );
}

export default BasePlate;
