/**
 * Writing a tiled build: one Bambu project with one plate per tile, or a zip of
 * per-tile files for everything else.
 *
 * The plate positions are checked against Bambu Studio's own arithmetic
 * (`PartPlateList::compute_origin`, `plate_stride_x`), because nothing in the
 * 3MF assigns an object to a plate: the loader gives each instance to the first
 * plate whose build volume its bounding box intersects, so an object is on
 * plate N only because it stands on plate N's patch of the world.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams } from "../../contracts";
import { PRINTER_PROFILES } from "../../printers";
import type { EngineResult, RegionMesh, TileResult } from "../types";
import {
  MODEL_RELS_PART,
  MODEL_SETTINGS_PART,
  OBJECT_MODEL_PART,
  PLATE_GAP_FRACTION,
  PLATE_JSON_PART,
  exportBambu3mf,
  objectModelPart,
  plateColumns,
  plateJsonPart,
  plateOrigin,
} from "./bambu3mf";
import { boxRegion, makeResult, sampleRegions } from "./fixtures";
import { MODEL_PART } from "./generic3mf";
import { exportForTarget } from "./index";
import { isTiled, resultForTile, tileStem } from "./tiles";
import { unzipAll, unzipText } from "./zip";

const CREATED = new Date(Date.UTC(2026, 0, 1));

function tileOf(label: string, index: [number, number], xOffset: number): TileResult {
  const regions: RegionMesh[] = [
    boxRegion({ region: "base", slot: 1, colorHex: "#D8D3C6", min: [xOffset, 0, 0], size: [80, 80, 3] }),
    boxRegion({ region: "buildings", slot: 2, colorHex: "#D8D3C6", min: [xOffset + 10, 10, 3], size: [10, 10, 20] }),
  ];
  const merged = boxRegion({
    region: "base",
    slot: 1,
    colorHex: "#D8D3C6",
    min: [xOffset, 0, 0],
    size: [80, 80, 23],
  });
  return {
    index,
    label,
    regions,
    bbox: { min: [xOffset, 0, 0], max: [xOffset + 80, 80, 23] },
    merged,
  };
}

function tiledResult(params: PrintParams = defaultPrintParams()): EngineResult {
  const result = makeResult(sampleRegions(), params);
  return {
    ...result,
    tiles: [
      tileOf("A2", [0, 0], 0),
      tileOf("B2", [1, 0], 90),
      tileOf("A1", [0, 1], 0),
      tileOf("B1", [1, 1], 90),
    ],
  };
}

function bambuParams(): PrintParams {
  return { ...defaultPrintParams(), printer_profile: "bambu-p1s" };
}

describe("Bambu Studio's plate arithmetic", () => {
  it("mirrors compute_colum_count", () => {
    expect(plateColumns(1)).toBe(1);
    expect(plateColumns(2)).toBe(2);
    expect(plateColumns(3)).toBe(2);
    expect(plateColumns(4)).toBe(2);
    expect(plateColumns(5)).toBe(3);
    expect(plateColumns(6)).toBe(3);
    expect(plateColumns(9)).toBe(3);
    expect(plateColumns(10)).toBe(4);
  });

  it("lays plates out east across a row and south down the rows", () => {
    const p = PRINTER_PROFILES["bambu-p1s"];
    const stride = p.plateXMm * (1 + PLATE_GAP_FRACTION);
    expect(plateOrigin(0, 4, p.plateXMm, p.plateYMm)).toEqual([0, -0]);
    expect(plateOrigin(1, 4, p.plateXMm, p.plateYMm)).toEqual([stride, -0]);
    expect(plateOrigin(2, 4, p.plateXMm, p.plateYMm)).toEqual([0, -stride]);
    expect(plateOrigin(3, 4, p.plateXMm, p.plateYMm)).toEqual([stride, -stride]);
  });
});

describe("a tiled Bambu project", () => {
  const result = tiledResult(bambuParams());
  const file = exportBambu3mf(result, { stem: "city", created: CREATED });
  const entries = unzipAll(file.bytes);

  it("carries one plate, one object and one sub-model per tile", () => {
    expect(file.plates).toBe(4);
    for (let n = 1; n <= 4; n += 1) {
      expect(entries.has(objectModelPart(n))).toBe(true);
      expect(entries.has(plateJsonPart(n))).toBe(true);
    }
    expect(entries.has(objectModelPart(5))).toBe(false);
    const rels = unzipText(file.bytes, MODEL_RELS_PART);
    for (let n = 1; n <= 4; n += 1) {
      expect(rels).toContain(`/${objectModelPart(n)}`);
    }
    const settings = unzipText(file.bytes, MODEL_SETTINGS_PART);
    expect(settings.match(/<plate>/g)).toHaveLength(4);
    expect(settings.match(/<object id=/g)).toHaveLength(4);
    for (let n = 1; n <= 4; n += 1) {
      expect(settings).toContain(`key="plater_id" value="${n}"`);
    }
    expect(settings).toContain('key="plater_name" value="FrameCraft Tile A2"');
  });

  it("stands each object on its own plate in the world", () => {
    const model = unzipText(file.bytes, MODEL_PART);
    const translations = [...model.matchAll(/<item objectid="\d+"[^>]*transform="1 0 0 0 1 0 0 0 1 ([-\d.]+) ([-\d.]+) 0"/g)]
      .map(([, x, y]) => [Number(x), Number(y)]);
    expect(translations).toHaveLength(4);
    const p = PRINTER_PROFILES["bambu-p1s"];
    const stride = p.plateXMm * (1 + PLATE_GAP_FRACTION);
    // Every tile is 80 x 80, so each is centred by (256 - 80) / 2 = 88 on its
    // own plate origin.
    const centre = (p.plateXMm - 80) / 2;
    expect(translations[0]).toEqual([centre, centre]);
    expect(translations[1]).toEqual([stride + centre, centre]);
    expect(translations[2]).toEqual([centre, -stride + centre]);
    expect(translations[3]).toEqual([stride + centre, -stride + centre]);
  });

  it("gives every part its own id across every plate", () => {
    expect(new Set(file.partIds).size).toBe(file.partIds.length);
    expect(file.partIds).toHaveLength(8);
  });

  it("routes through exportForTarget for a Bambu printer", () => {
    const output = exportForTarget(result, "bambu-3mf", { stem: "city", created: CREATED });
    expect(output.files).toHaveLength(1);
    expect(output.files[0].name).toBe("city.3mf");
    expect(output.notes[0]).toContain("one plate each");
  });
});

describe("a tiled build for anything else", () => {
  it("writes a zip of per-tile files named by their grid reference", () => {
    const result = tiledResult();
    const output = exportForTarget(result, "generic-3mf", { stem: "city", created: CREATED });
    expect(output.files).toHaveLength(1);
    expect(output.files[0].name).toBe("city-tiles.zip");
    const inside = [...unzipAll(output.files[0].bytes).keys()].sort();
    expect(inside).toEqual([
      "CREDITS.txt",
      "city-A1.3mf",
      "city-A2.3mf",
      "city-B1.3mf",
      "city-B2.3mf",
    ]);
    expect(output.notes[0]).toContain("4 tiles");
  });

  it("writes an STL per tile, and the OBJ's companion MTL beside it", () => {
    const result = tiledResult();
    const stl = exportForTarget(result, "stl", { stem: "city", created: CREATED });
    expect([...unzipAll(stl.files[0].bytes).keys()].sort()).toEqual([
      "CREDITS.txt",
      "city-A1.stl",
      "city-A2.stl",
      "city-B1.stl",
      "city-B2.stl",
    ]);
    const obj = exportForTarget(result, "obj", { stem: "city", created: CREATED });
    const names = [...unzipAll(obj.files[0].bytes).keys()];
    expect(names).toContain("city-A1.obj");
    expect(names).toContain("city-A1.mtl");
  });

  it("sends a tiled Bambu project for a third-party printer to the zip as well", () => {
    const result = tiledResult({ ...defaultPrintParams(), printer_profile: "prusa-mk4" });
    const output = exportForTarget(result, "bambu-3mf", { stem: "city", created: CREATED });
    expect(output.files[0].name).toBe("city-tiles.zip");
    expect(unzipAll(output.files[0].bytes).size).toBe(5);
  });

  it("sends a tiled colour-change build to the zip: a plan is for one object", () => {
    const result = tiledResult(bambuParams());
    const output = exportForTarget(result, "color-change-3mf", { stem: "city", created: CREATED });
    expect(output.files[0].name).toBe("city-tiles.zip");
    const inside = [...unzipAll(output.files[0].bytes).keys()];
    expect(inside).toContain("city-A1-colorchange.3mf");
  });
});

describe("one tile on its own", () => {
  it("is a whole EngineResult with the tile's own meshes and stats", () => {
    const result = tiledResult();
    const tile = result.tiles![1];
    const only = resultForTile(result, tile);
    expect(only.tiles).toBeUndefined();
    expect(only.regions).toBe(tile.regions);
    expect(only.merged).toBe(tile.merged);
    expect(only.stats.widthMm).toBe(80);
    expect(only.stats.depthMm).toBe(80);
    expect(only.stats.heightMm).toBe(23);
    expect(only.params).toBe(result.params);
  });

  it("names its file after the grid reference", () => {
    expect(tileStem("city", { label: "B2" } as TileResult)).toBe("city-B2");
  });
});

describe("an untiled build", () => {
  const plain = makeResult(sampleRegions(), bambuParams());

  it("is not treated as tiled, however the tiles field is set", () => {
    expect(isTiled(plain)).toBe(false);
    expect(isTiled({ tiles: [] })).toBe(false);
    expect(isTiled({ tiles: [tileOf("A1", [0, 0], 0)] })).toBe(false);
    expect(isTiled({ tiles: [tileOf("A1", [0, 0], 0), tileOf("B1", [1, 0], 90)] })).toBe(true);
  });

  it("writes exactly the bytes it wrote before tiling existed", () => {
    const file = exportBambu3mf(plain, { stem: "framecraft", created: CREATED, title: "FrameCraft" });
    expect(file.plates).toBe(1);
    const entries = unzipAll(file.bytes);
    expect(entries.has(OBJECT_MODEL_PART)).toBe(true);
    expect(entries.has(PLATE_JSON_PART)).toBe(true);
    expect([...entries.keys()].some((name) => name.includes("object_2"))).toBe(false);
    // The single-plate writer is pinned by its bytes: this hash is what the
    // COMMITTED writer produces for this fixture, checked by importing
    // `git show HEAD:...bambu3mf.ts` beside the current one and comparing the
    // two outputs (they agree, on this fixture and on the real Chicago build).
    //
    // It tracks the CONTRACT as well as the writer, because every 3MF carries
    // its PrintParams in the Description metadata: it moved once already, when
    // `custom_profile.max_height_mm`'s default went 250 -> 60 in phase 4. If it
    // moves again, re-run that old-versus-new import before touching it - a
    // changed default is a legitimate reason, a changed writer is not.
    //
    // It moved a second time in v3 phase 7, and that time the WRITER changed on
    // purpose: `bambuMetadata` gained the five-entry provenance block every
    // format now carries (`common.provenanceEntries`, `[V3-P7-A10]`) and lost
    // its stand-alone `framecraft:generator`, which the block repeats and which
    // 3MF forbids twice in one element. The diff was checked entry by entry on
    // the unzipped `3D/3dmodel.model` before this number was touched: nothing
    // outside the `<metadata>` list moved, and the mesh, the plate, the config
    // parts and the zip framing are byte for byte what they were.
    //
    // It moved a third time in v3.1 (Task 1, the staged pipeline), and again
    // the writer changed on purpose: `bambuMetadata` gained ONE entry,
    // `framecraft:palette` (`common.paletteEntries`, DECISIONS [V3.1-P1-2]:
    // `colour.palette` has to have a file effect), appended after the
    // provenance block. Checked the same way, entry by entry on the unzipped
    // `3D/3dmodel.model`: nothing else in the metadata list, the mesh, the
    // plate, the config parts or the zip framing moved.
    const digest = createHash("sha256").update(file.bytes).digest("hex");
    expect(digest).toBe("42c5cd560cc98cb2bcfaa3e502dc900ac8e1fe3f346ebc0f27288d5493845064");
    expect(unzipText(file.bytes, "3D/3dmodel.model")).toContain('<metadata name="framecraft:palette">default</metadata>');
    // The block is there, once each, so a future edit that drops it fails here
    // as well as on the hash.
    const model = unzipText(file.bytes, "3D/3dmodel.model");
    for (const key of ["author", "license", "generator", "source", "generated"]) {
      expect(model.split(`name="framecraft:${key}"`)).toHaveLength(2);
    }
  });

  it("goes through the ordinary single-file route", () => {
    const output = exportForTarget(plain, "bambu-3mf", { stem: "city", created: CREATED });
    expect(output.files).toHaveLength(1);
    expect(output.files[0].name).toBe("city.3mf");
    expect(output.notes).toEqual([]);
  });
});
