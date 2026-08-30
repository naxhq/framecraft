"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import { Color, type InstancedMesh } from "three";

import type { PrintParams } from "@/lib/contracts";
import { heroFlags, heroHeightKey } from "@/lib/heroes";
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
 *
 * Picking a hero is a raycast against the same mesh: r3f hands back the
 * `instanceId`, which indexes `buildings` (NOT the SceneGraph -- the preview
 * has already dropped the footprints the bake drops), so the id comes out of
 * the array rather than out of the index.
 *
 * The material colour is a neutral multiplier and every instance carries its
 * own colour, so a hero can be picked out without a second draw call.
 */
/**
 * The primitives `buildingInstanceMatrices` actually reads, in one place.
 *
 * Same discipline as `CityPreview`'s `previewDeps`, and for the same reason:
 * `store.setParam` rebuilds `params` by spread on every write, so an effect
 * keyed on the object re-ran over all 994 Chicago instances and re-uploaded
 * `instanceMatrix` on every write of any kind.
 *
 * The matrices depend on the base thickness (where buildings start), the two
 * height multipliers, and -- since heroes are drawn at their hero height --
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

export function InstancedBuildings({
  buildings,
  params,
  scale,
  color,
  heroColor,
  cursorColor,
  heroIds,
  cursorId,
  onPick,
}: {
  buildings: PreviewBuilding[];
  params: PrintParams;
  scale: number;
  color: string;
  heroColor: string;
  cursorColor: string;
  heroIds: readonly string[];
  /** The building the keyboard cursor is on, or null. */
  cursorId: string | null;
  onPick: (id: string) => void;
}) {
  const meshRef = useRef<InstancedMesh>(null);
  /** Where the pointer went down, so an orbit drag is not read as a click. */
  const downAt = useRef<{ x: number; y: number } | null>(null);

  const colours = useMemo(
    () => ({ normal: new Color(), hero: new Color(), cursor: new Color() }),
    [],
  );

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
    const mesh = meshRef.current;
    if (!mesh) return;
    colours.normal.set(color);
    colours.hero.set(heroColor);
    colours.cursor.set(cursorColor);
    const flags = heroFlags(
      buildings.map((building) => building.id),
      heroIds,
    );
    for (let i = 0; i < buildings.length; i += 1) {
      // The cursor wins over the hero colour: "where I am" has to be findable
      // even when it lands on a building that is already picked. The status
      // line next to the viewport is what says which of the two it is.
      const colour =
        buildings[i].id === cursorId
          ? colours.cursor
          : flags[i]
            ? colours.hero
            : colours.normal;
      mesh.setColorAt(i, colour);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [buildings, colours, color, heroColor, cursorColor, heroIds, cursorId]);

  useEffect(() => {
    return () => {
      document.body.style.cursor = "";
    };
  }, []);

  if (buildings.length === 0) return null;

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
      args={[undefined, undefined, buildings.length]}
      castShadow
      receiveShadow
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
      {/* white, so the per-instance colour above is exactly what is drawn */}
      <meshStandardMaterial color="white" roughness={0.75} metalness={0.02} />
    </instancedMesh>
  );
}

export default InstancedBuildings;
