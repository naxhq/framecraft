"use client";

import { Html, Line } from "@react-three/drei";

import type { TileResult } from "@/lib/engine/types";

/**
 * The tiling overlay (FrameCraft v3 phase 4): a thin rectangle at each tile's
 * own footprint, drawn a hair above the tallest point IN THAT TILE so the
 * lines never z-fight the model's own top faces, plus a small grid-reference
 * label ("A1", "B2", ...) at its centre -- `TileResult.label`, the same
 * reference the engine cuts into the tile itself when `tiling.index_mark` is
 * on, so the overlay and the physical mark always agree.
 *
 * Print-mm coordinates throughout (x east, y north, z up), exactly like
 * `RegionMeshes`/`BasePlate`: this is a child of `CityPreview`'s single
 * z-up-to-y-up rotation group, so it needs no coordinate conversion of its
 * own. Mounted only while `freshEngineResult` is showing (never over the
 * approximate instanced preview, which has no tile boundaries of its own to
 * agree with) and only when `EngineResult.tiles` is populated
 * (`params.tiling.enabled`).
 */
export function TileGrid({
  tiles,
  color,
}: {
  tiles: readonly TileResult[] | undefined;
  /** Resolved token colour (`components/scene/palette.ts`'s `tileLine`), never a raw hex literal or a `var()` string -- three's `Color` cannot parse the latter. */
  color: string;
}) {
  if (!tiles || tiles.length === 0) return null;

  return (
    <group data-testid="tile-grid">
      {tiles.map((tile) => {
        const { min, max } = tile.bbox;
        const z = max[2] + LINE_HEADROOM_MM;
        const points: Array<[number, number, number]> = [
          [min[0], min[1], z],
          [max[0], min[1], z],
          [max[0], max[1], z],
          [min[0], max[1], z],
          [min[0], min[1], z],
        ];
        const cx = (min[0] + max[0]) / 2;
        const cy = (min[1] + max[1]) / 2;
        return (
          <group key={tile.label}>
            <Line
              points={points}
              color={color}
              lineWidth={1.5}
              dashed={false}
              data-testid={`tile-outline-${tile.label}`}
            />
            <Html position={[cx, cy, z]} center distanceFactor={110} zIndexRange={[10, 0]}>
              <span
                data-testid={`tile-label-${tile.label}`}
                className="pointer-events-none rounded-milled border border-line bg-plate/90 px-1.5 py-0.5 text-2xs font-medium text-ink shadow-raised"
              >
                {tile.label}
              </span>
            </Html>
          </group>
        );
      })}
    </group>
  );
}

/** Headroom above a tile's tallest point, mm, so the cut lines sit clear of its own top faces. */
const LINE_HEADROOM_MM = 0.5;

export default TileGrid;
