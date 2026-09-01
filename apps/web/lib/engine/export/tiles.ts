// Writing a tiled bake. Two shapes, and which one is used is decided by what
// the receiving software can do with a multi-plate project:
//
// * a Bambu Studio project can hold many PLATES in one file, so a tiled bake
//   for a Bambu printer is ONE .3mf with one plate per tile, which is what a
//   user wants to open, arrange and slice in one go (`bambu3mf.ts`);
// * every other target is a single-object or single-build format with no
//   concept of a second bed, so a tiled bake is a ZIP with one file per tile,
//   named by its grid reference, plus the attribution file.
//
// Both routes write exactly the geometry `solid/tiling.ts` produced: a tile is
// exported through the same writer the whole model would have gone through,
// against a result whose `regions` and `merged` are that tile's.

import type { EngineResult, ExportFile, TileResult } from "../types";
import type { ExportOptions } from "./common";
import { sanitizeStem } from "./common";
import { CREDITS_TEXT, MIME_ZIP } from "./stl";
import { zipEntries, type ZipEntry } from "./zip";

/** True when this bake was split into tiles that have to be written separately. */
export function isTiled(result: Pick<EngineResult, "tiles">): boolean {
  return (result.tiles?.length ?? 0) > 1;
}

/**
 * One tile as a whole `EngineResult`, so every existing writer can take it
 * without knowing tiles exist.
 *
 * `tiles` is cleared on the copy, or a writer that looks for them (the Bambu
 * one) would try to lay the whole grid out again inside one tile's file.
 */
export function resultForTile(result: EngineResult, tile: TileResult): EngineResult {
  const merged = tile.merged ?? tile.regions[0];
  return {
    ...result,
    regions: tile.regions,
    merged,
    stats: {
      ...result.stats,
      widthMm: tile.bbox.max[0] - tile.bbox.min[0],
      depthMm: tile.bbox.max[1] - tile.bbox.min[1],
      heightMm: tile.bbox.max[2] - tile.bbox.min[2],
      triangles: tile.regions.reduce((total, region) => total + region.indices.length / 3, 0),
    },
    tiles: undefined,
  };
}

/** `<stem>-A1`, safe as a file name. */
export function tileStem(stem: string, tile: TileResult): string {
  return sanitizeStem(`${stem}-${tile.label}`);
}

export interface TiledZipInput {
  result: EngineResult;
  tiles: readonly TileResult[];
  stem: string;
  created: Date;
  /** Files for one tile, from whichever writer the target names. */
  writeTile: (tileResult: EngineResult, tileOptions: ExportOptions) => ExportFile[];
}

/**
 * A zip with one entry per tile file, in grid order, plus `CREDITS.txt`.
 *
 * The zip is deterministic (`zipEntries` stamps one mtime), so two exports of
 * the same bake are the same bytes.
 */
export function exportTiledZip(input: TiledZipInput): ExportFile {
  const entries: ZipEntry[] = [];
  for (const tile of input.tiles) {
    const stem = tileStem(input.stem, tile);
    const files = input.writeTile(resultForTile(input.result, tile), {
      stem,
      created: input.created,
    });
    for (const file of files) {
      // A .3mf is already a deflated zip; deflating it again costs time and
      // gains nothing. Everything else (STL, OBJ, STEP, MTL) is plain text or
      // plain floats and compresses well.
      entries.push({
        name: file.name,
        data: file.bytes,
        method: file.name.endsWith(".3mf") ? "store" : "deflate",
      });
    }
  }
  entries.push({ name: "CREDITS.txt", data: CREDITS_TEXT, method: "deflate" });
  return {
    name: `${input.stem}-tiles.zip`,
    mime: MIME_ZIP,
    bytes: zipEntries(entries, { mtime: input.created }),
  };
}
