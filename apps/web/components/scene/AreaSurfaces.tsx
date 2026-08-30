"use client";

import { useEffect, useMemo } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  FrontSide,
  Path,
  Shape,
  ShapeUtils,
} from "three";

import type { PreviewArea } from "@/lib/preview";

/**
 * Water and green polygons.
 *
 * Triangulated with three's earcut (`ShapeUtils.triangulateShape`) so islands
 * inside a lake come out as real holes rather than as painted-over squares,
 * then merged into ONE BufferGeometry per layer. The merge matters: a 900 m
 * Chicago crop has ~700 green polygons, and one mesh each meant ~700 draw
 * calls per frame and ~700 geometry uploads every time the scale changed.
 *
 * Every polygon is flat, so the normals are written directly instead of paying
 * for `computeVertexNormals()`.
 *
 * The z offsets come from the shared transform (`water_z_mm` = -0.5,
 * `green_z_mm` = +0.3, relative to the base top).
 */
function toShape(area: PreviewArea): Shape {
  const shape = new Shape();
  shape.moveTo(area.outer[0], area.outer[1]);
  for (let i = 2; i < area.outer.length; i += 2) {
    shape.lineTo(area.outer[i], area.outer[i + 1]);
  }
  shape.closePath();
  for (const hole of area.holes) {
    const path = new Path();
    path.moveTo(hole[0], hole[1]);
    for (let i = 2; i < hole.length; i += 2) {
      path.lineTo(hole[i], hole[i + 1]);
    }
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

/**
 * Interleaved xyz triangle vertices (z = 0) for every area, in one array.
 *
 * Exported so `AreaSurfaces.test.ts` can check the hole handling in node
 * without a WebGL context.
 */
export function areaTrianglePositions(areas: ReadonlyArray<PreviewArea>): number[] {
  const positions: number[] = [];
  for (const area of areas) {
    const shape = toShape(area);
    const { shape: outline, holes } = shape.extractPoints(1);
    let faces: number[][];
    try {
      faces = ShapeUtils.triangulateShape(outline, holes);
    } catch {
      // A self-touching OSM polygon can defeat earcut. Skipping one patch is
      // the right failure mode for a preview; the bake runs make_valid first.
      continue;
    }
    // MUST be built AFTER triangulateShape: extractPoints() repeats each
    // contour's first point at the end, and triangulateShape pops those
    // duplicates IN PLACE (removeDupEndPts) before numbering the hole vertices
    // off the shortened outline. Concatenating first shifts every hole index
    // by one per preceding contour and paints the islands over with skewed
    // triangles. three's own ShapeGeometry concatenates here for this reason.
    const vertices = outline.concat(...holes);
    for (const face of faces) {
      for (const index of face) {
        const vertex = vertices[index];
        positions.push(vertex.x, vertex.y, 0);
      }
    }
  }
  return positions;
}

function buildMergedGeometry(areas: PreviewArea[]): BufferGeometry | null {
  const positions = areaTrianglePositions(areas);
  if (positions.length === 0) return null;

  const geometry = new BufferGeometry();
  const array = new Float32Array(positions);
  geometry.setAttribute("position", new BufferAttribute(array, 3));
  const normals = new Float32Array(array.length);
  for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
  geometry.setAttribute("normal", new BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

export function AreaSurfaces({
  areas,
  zMm,
  color,
  /**
   * Draw the fill from both sides. The frame lettering's underside half -- the
   * mark and the hanger pockets -- sits under z = 0 and is only ever looked at
   * from below, and every ring here is wound for a viewer above (and the
   * underside mark's own mirror flips it again), so a front-facing-only
   * material would leave the bottom of the plate blank when the model is
   * orbited under. Two-sided also means the flipped normal three hands the
   * shader for a back face lights it correctly.
   */
  doubleSide = false,
}: {
  areas: PreviewArea[];
  zMm: number;
  color: string;
  doubleSide?: boolean;
}) {
  const geometry = useMemo(() => buildMergedGeometry(areas), [areas]);

  useEffect(() => () => geometry?.dispose(), [geometry]);

  if (!geometry) return null;

  return (
    <mesh geometry={geometry} position={[0, 0, zMm]} receiveShadow>
      <meshStandardMaterial
        color={color}
        roughness={0.85}
        side={doubleSide ? DoubleSide : FrontSide}
        polygonOffset
        polygonOffsetFactor={-1}
        polygonOffsetUnits={-1}
      />
    </mesh>
  );
}

export default AreaSurfaces;
