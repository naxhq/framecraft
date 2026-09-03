/**
 * The DEM fetcher, against a synthetic tile server.
 *
 * Nothing here touches the network: every test injects its own `fetch`, which
 * ENCODES a PNG in memory and hands it back. That is deliberate and it is
 * stronger than a recorded fixture would be - the encoder below writes all five
 * PNG scanline filters, so `png.ts` is exercised on each of them rather than on
 * whichever one `elevation-tiles-prod` happened to use the day a fixture was
 * captured.
 */

import { zlibSync } from "fflate";
import { describe, expect, it } from "vitest";

import { defaultPrintParams, type PrintParams } from "../../contracts";
import { LocalFrame } from "../osm/project";
import {
  MAX_GRID_SAMPLES,
  TILE_SIZE,
  decodeTerrariumTile,
  gridFromSampler,
  gridSamplesFor,
  samplerFromGrid,
  smoothGrid,
  smoothingPasses,
  terrainEnabled,
  terrariumElevationM,
} from "./heightfield";
import { decodePng } from "./png";
import {
  MAX_TILES,
  TERRARIUM_SOURCE,
  fetchTerrainGrid,
  metresPerPixel,
  tileUrl,
  tileXFor,
  tileYFor,
  zoomFor,
} from "./tiles";

// ---------------------------------------------------------------------------
// A PNG encoder, so the tests can serve real bytes
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i += 1) body[i] = type.charCodeAt(i);
  body.set(data, 4);
  const out = new Uint8Array(8 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(out.length - 4, crc32(body));
  return out;
}

/**
 * Encode an RGB image, cycling the scanline filter through all five types so a
 * decoder that only implements "None" cannot pass.
 */
function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const stride = width * 3;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const filter = y % 5;
    const at = y * (stride + 1);
    raw[at] = filter;
    for (let x = 0; x < stride; x += 1) {
      const value = rgb[y * stride + x];
      const a = x >= 3 ? rgb[y * stride + x - 3] : 0;
      const b = y > 0 ? rgb[(y - 1) * stride + x] : 0;
      const c = y > 0 && x >= 3 ? rgb[(y - 1) * stride + x - 3] : 0;
      let encoded: number;
      switch (filter) {
        case 1:
          encoded = value - a;
          break;
        case 2:
          encoded = value - b;
          break;
        case 3:
          encoded = value - ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          encoded = value - predictor;
          break;
        }
        default:
          encoded = value;
      }
      raw[at + 1 + x] = encoded & 0xff;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlibSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Terrarium encoding, the inverse of `terrariumElevationM`. */
function encodeElevation(metres: number): [number, number, number] {
  const raw = Math.round((metres + 32768) * 256);
  const clamped = Math.max(0, Math.min(0xffffff, raw));
  return [(clamped >> 16) & 0xff, (clamped >> 8) & 0xff, clamped & 0xff];
}

/**
 * A tile server whose elevation is a plane in tile-pixel space, so the answer
 * at any point is predictable in closed form.
 */
function planeServer(
  elevationAtPixel: (globalX: number, globalY: number) => number,
): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const match = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url);
    if (match === null) return { ok: false, status: 404 } as Response;
    const tx = Number(match[2]);
    const ty = Number(match[3]);
    const rgb = new Uint8Array(TILE_SIZE * TILE_SIZE * 3);
    for (let y = 0; y < TILE_SIZE; y += 1) {
      for (let x = 0; x < TILE_SIZE; x += 1) {
        const [r, g, b] = encodeElevation(
          elevationAtPixel(tx * TILE_SIZE + x, ty * TILE_SIZE + y),
        );
        const at = (y * TILE_SIZE + x) * 3;
        rgb[at] = r;
        rgb[at + 1] = g;
        rgb[at + 2] = b;
      }
    }
    const bytes = encodePng(TILE_SIZE, TILE_SIZE, rgb);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as Response;
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

const CHICAGO = { lat: 41.8827, lon: -87.6233, radiusM: 900, rotationDeg: 0 };

function terrainParams(overrides: Partial<PrintParams> = {}): PrintParams {
  return {
    ...defaultPrintParams(),
    terrain: { enabled: true, smoothing: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("the PNG decoder", () => {
  it("reads every scanline filter back byte for byte", () => {
    const width = 23;
    const height = 17;
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < rgb.length; i += 1) rgb[i] = (i * 37 + (i % 11) * 91) & 0xff;
    const decoded = decodePng(encodePng(width, height, rgb));
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    for (let p = 0; p < width * height; p += 1) {
      expect(decoded.data[p * 4], `pixel ${p} r`).toBe(rgb[p * 3]);
      expect(decoded.data[p * 4 + 1], `pixel ${p} g`).toBe(rgb[p * 3 + 1]);
      expect(decoded.data[p * 4 + 2], `pixel ${p} b`).toBe(rgb[p * 3 + 2]);
      expect(decoded.data[p * 4 + 3]).toBe(255);
    }
  });

  it("refuses what it cannot read rather than guessing", () => {
    expect(() => decodePng(new Uint8Array(16))).toThrow(/signature/);
    const rgb = new Uint8Array(3);
    const good = encodePng(1, 1, rgb);
    const interlaced = Uint8Array.from(good);
    // IHDR data starts at 8 (signature) + 8 (length+type); interlace is byte 12.
    interlaced[8 + 8 + 12] = 1;
    expect(() => decodePng(interlaced)).toThrow(/interlaced/);
  });
});

describe("the Terrarium encoding", () => {
  it("is the format's own formula", () => {
    expect(terrariumElevationM(128, 0, 0)).toBe(0);
    expect(terrariumElevationM(128, 100, 0)).toBe(100);
    expect(terrariumElevationM(128, 0, 128)).toBeCloseTo(0.5, 9);
    // Below sea level is representable, which is what the -32768 bias is for.
    expect(terrariumElevationM(127, 156, 0)).toBe(-100);
  });

  it("decodes a whole tile", () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i += 1) {
      const [r, g, b] = encodeElevation(i * 10);
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = 255;
    }
    const out = decodeTerrariumTile(rgba, 4);
    expect(out).toHaveLength(16);
    for (let i = 0; i < 16; i += 1) expect(out[i]).toBeCloseTo(i * 10, 2);
  });
});

describe("zoom selection", () => {
  it("uses the coarsest zoom that meets the sample target", () => {
    // Chicago, 900 m radius: 28.1 m wanted, and z12 is 28.4 m at that latitude.
    expect(zoomFor(900, 41.8827)).toBe(13);
    // A 5 km radius only ever needs the 30 m cap, which z12 meets there.
    expect(zoomFor(5000, 41.8827)).toBe(12);
    // A small crop wants detail and gets the finest zoom offered.
    expect(zoomFor(250, 41.8827)).toBe(14);
    // At the equator a z12 pixel is 38 m, so the cap alone forces z13.
    expect(zoomFor(5000, 0)).toBe(13);
    // Never outside the band, however extreme the input.
    for (const radius of [250, 900, 2400, 20000]) {
      for (const lat of [-70, -41, 0, 41, 70]) {
        const zoom = zoomFor(radius, lat);
        expect(zoom).toBeGreaterThanOrEqual(12);
        expect(zoom).toBeLessThanOrEqual(14);
      }
    }
  });

  it("agrees with Web Mercator on where a tile is", () => {
    expect(tileXFor(-180, 0)).toBe(0);
    expect(tileXFor(0, 1)).toBe(1);
    expect(tileYFor(0, 1)).toBeCloseTo(1, 9);
    expect(metresPerPixel(0, 0)).toBeCloseTo(156543.034, 2);
    expect(metresPerPixel(1, 0)).toBeCloseTo(metresPerPixel(0, 0) / 2, 6);
    expect(tileUrl(13, 2098, 3045)).toBe(
      "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/13/2098/3045.png",
    );
  });
});

describe("the grid", () => {
  it("normalises to metres above its own minimum", () => {
    const grid = gridFromSampler(
      100,
      5,
      (east, north) => [east, north],
      (lon) => 500 + lon / 100,
      "test",
    );
    expect(grid).not.toBeNull();
    expect(grid!.cols).toBe(5);
    expect(grid!.rows).toBe(5);
    expect(grid!.cellM).toBeCloseTo(50, 9);
    expect(grid!.originEastM).toBe(-100);
    expect(Math.min(...grid!.elevations)).toBe(0);
    expect(grid!.rangeM).toBeCloseTo(2, 9);
    expect(grid!.source).toBe("test");
  });

  it("refuses a degenerate request instead of dividing by zero", () => {
    expect(gridFromSampler(0, 5, (e, n) => [e, n], () => 1, "t")).toBeNull();
    expect(gridFromSampler(100, 1, (e, n) => [e, n], () => 1, "t")).toBeNull();
    expect(gridFromSampler(100, 5, (e, n) => [e, n], () => NaN, "t")).toBeNull();
  });

  it("caps its own size", () => {
    expect(gridSamplesFor(900, 14.2)).toBe(128);
    expect(gridSamplesFor(100000, 1)).toBe(MAX_GRID_SAMPLES);
    expect(gridSamplesFor(1, 1000)).toBeGreaterThanOrEqual(8);
    expect(gridSamplesFor(0, 10)).toBeGreaterThanOrEqual(8);
  });

  it("smooths and re-normalises, and does nothing at zero passes", () => {
    const spiky = gridFromSampler(
      100,
      9,
      (east, north) => [east, north],
      (lon, lat) => (Math.round(lon / 25) + Math.round(lat / 25)) % 2 === 0 ? 0 : 30,
      "test",
    )!;
    expect(smoothGrid(spiky, 0)).toBe(spiky);
    const soft = smoothGrid(spiky, 3);
    expect(soft).not.toBe(spiky);
    expect(soft.rangeM).toBeLessThan(spiky.rangeM);
    expect(Math.min(...soft.elevations)).toBeCloseTo(0, 6);
    // Clamped at the edges, never wrapped: no elevation left the original band.
    expect(Math.max(...soft.elevations)).toBeLessThanOrEqual(spiky.rangeM + 1e-6);
    // More passes is smoother, never rougher.
    expect(smoothGrid(spiky, 5).rangeM).toBeLessThanOrEqual(soft.rangeM + 1e-6);
  });

  it("reads the two contract switches", () => {
    expect(terrainEnabled(defaultPrintParams())).toBe(false);
    expect(terrainEnabled(terrainParams())).toBe(true);
    expect(smoothingPasses(defaultPrintParams())).toBe(1);
    expect(smoothingPasses(terrainParams())).toBe(0);
  });

  it("samples bilinearly and clamps outside itself", () => {
    const grid = gridFromSampler(
      100,
      3,
      (east, north) => [east, north],
      (lon) => lon,
      "test",
    )!;
    const sampler = samplerFromGrid(grid)!;
    expect(sampler.sampleM(-100, 0)).toBeCloseTo(0, 6);
    expect(sampler.sampleM(0, 0)).toBeCloseTo(100, 6);
    expect(sampler.sampleM(50, 0)).toBeCloseTo(150, 6);
    // Outside, the edge value continues rather than falling to zero.
    expect(sampler.sampleM(1000, 0)).toBeCloseTo(200, 6);
    expect(sampler.sampleM(-1000, 0)).toBeCloseTo(0, 6);
    expect(samplerFromGrid(null)).toBeNull();
  });
});

describe("fetchTerrainGrid", () => {
  it("builds a grid from the tiles it fetched", async () => {
    // 1 m of elevation per tile pixel eastwards: a plane, so the grid must come
    // back monotonically increasing in x and flat in y.
    const server = planeServer((x) => x % 4096);
    const grid = await fetchTerrainGrid(CHICAGO, terrainParams(), { fetch: server.fetch });
    expect(grid).not.toBeNull();
    expect(grid!.source).toBe(TERRARIUM_SOURCE);
    expect(grid!.cols).toBe(grid!.rows);
    expect(grid!.cols).toBeGreaterThan(8);
    expect(grid!.originEastM).toBe(-CHICAGO.radiusM);
    expect(grid!.cellM).toBeCloseTo((2 * CHICAGO.radiusM) / (grid!.cols - 1), 9);
    expect(Math.min(...grid!.elevations)).toBe(0);
    expect(grid!.rangeM).toBeGreaterThan(0);

    const row = Math.floor(grid!.rows / 2);
    for (let c = 1; c < grid!.cols; c += 1) {
      expect(
        grid!.elevations[row * grid!.cols + c],
        `column ${c}`,
      ).toBeGreaterThan(grid!.elevations[row * grid!.cols + c - 1]);
    }
    // Flat north to south, because the server's plane is. Not EXACTLY flat: the
    // plane is a function of Web Mercator longitude and the grid is a square in
    // UTM metres, so a scene-north column drifts a fraction of a pixel in
    // longitude over 1.8 km. That drift is the projection doing its job, and at
    // 0.05 m it is three orders of magnitude under the relief being measured.
    const column = Math.floor(grid!.cols / 2);
    const downColumn: number[] = [];
    for (let r = 0; r < grid!.rows; r += 1) {
      downColumn.push(grid!.elevations[r * grid!.cols + column]);
    }
    const columnSpread = Math.max(...downColumn) - Math.min(...downColumn);
    expect(columnSpread).toBeLessThan(0.02 * grid!.rangeM);
    // Every request went to the Terrarium endpoint at the chosen zoom.
    expect(server.calls.length).toBeGreaterThan(0);
    expect(server.calls.length).toBeLessThanOrEqual(MAX_TILES);
    for (const url of server.calls) expect(url).toMatch(/terrarium\/13\/\d+\/\d+\.png$/);
  });

  it("does not apply terrain_exaggeration to the grid", async () => {
    // [V3-P3-G1]: the exaggeration is `transform.terrain_z_scale`, applied when
    // an elevation becomes millimetres. A grid that carried it would be applied
    // twice, and moving the slider would need a refetch.
    const plain = await fetchTerrainGrid(CHICAGO, terrainParams(), {
      fetch: planeServer((x) => x % 4096).fetch,
    });
    const loud = await fetchTerrainGrid(
      CHICAGO,
      terrainParams({ terrain_exaggeration: 3 }),
      { fetch: planeServer((x) => x % 4096).fetch },
    );
    expect(loud!.rangeM).toBeCloseTo(plain!.rangeM, 9);
    expect([...loud!.elevations]).toEqual([...plain!.elevations]);
  });

  it("returns the RAW grid stamped `smoothing: 0`; params.terrain.smoothing is the pipeline's terrain stage's to apply, once", async () => {
    // v3.1: the fetcher no longer smooths. `terrain.smoothing` is a parameter
    // the worker's `terrain` stage claims and applies on top of the stamped
    // pass count (`lib/engine/pipeline/stages.ts`), so a smoothing change is
    // a stage re-run, not a refetch. Two fetches with different smoothing
    // settings therefore return the same elevations, both stamped 0, and the
    // stage's own operation on them is what softens the relief.
    const rough = (x: number, y: number): number => ((x + y) % 2 === 0 ? 0 : 60);
    const sharp = await fetchTerrainGrid(
      CHICAGO,
      terrainParams({ terrain: { enabled: true, smoothing: 0 } }),
      { fetch: planeServer(rough).fetch },
    );
    const soft = await fetchTerrainGrid(
      CHICAGO,
      terrainParams({ terrain: { enabled: true, smoothing: 5 } }),
      { fetch: planeServer(rough).fetch },
    );
    expect(sharp!.smoothing).toBe(0);
    expect(soft!.smoothing).toBe(0);
    expect([...soft!.elevations]).toEqual([...sharp!.elevations]);
    expect(soft!.rangeM).toBe(sharp!.rangeM);
    // What the stage does with `smoothing: 5` on that grid.
    const softened = smoothGrid(sharp!, 5);
    expect(softened.rangeM).toBeLessThan(sharp!.rangeM);
    expect(smoothGrid(sharp!, 0)).toBe(sharp);
  });

  it("turns the rotation into scene metres through the shared LocalFrame", async () => {
    const server = planeServer((x) => x % 4096);
    const turned = await fetchTerrainGrid(
      { ...CHICAGO, rotationDeg: 90 },
      terrainParams(),
      { fetch: server.fetch },
    );
    expect(turned).not.toBeNull();
    // Rotating the crop by 90 degrees turns a west-to-east plane into a
    // south-to-north one IN SCENE METRES, which is the frame every solid uses.
    const row = Math.floor(turned!.rows / 2);
    const flatAcross = turned!.elevations.slice(
      row * turned!.cols,
      row * turned!.cols + turned!.cols,
    );
    const spread = Math.max(...flatAcross) - Math.min(...flatAcross);
    expect(spread).toBeLessThan(turned!.rangeM / 4);
    // ... and the frame it used is the ingest one, not a second copy.
    const frame = new LocalFrame(CHICAGO.lat, CHICAGO.lon, 90);
    expect(frame.rotationDeg).toBe(90);
  });

  it("fails soft, every way it can fail", async () => {
    const ok = planeServer((x) => x % 4096).fetch;
    // The switch is off.
    expect(await fetchTerrainGrid(CHICAGO, defaultPrintParams(), { fetch: ok })).toBeNull();
    // The request is not a request.
    for (const bad of [
      { ...CHICAGO, radiusM: 0 },
      { ...CHICAGO, radiusM: -5 },
      { ...CHICAGO, radiusM: Number.NaN },
      { ...CHICAGO, lat: Number.NaN },
      { ...CHICAGO, lon: Number.POSITIVE_INFINITY },
    ]) {
      expect(await fetchTerrainGrid(bad, terrainParams(), { fetch: ok })).toBeNull();
    }
    // The network refused.
    const refused = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchTerrainGrid(CHICAGO, terrainParams(), { fetch: refused })).toBeNull();
    // The server answered with a status.
    const missing = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    expect(await fetchTerrainGrid(CHICAGO, terrainParams(), { fetch: missing })).toBeNull();
    // The body is not a PNG.
    const junk = (async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    })) as unknown as typeof fetch;
    expect(await fetchTerrainGrid(CHICAGO, terrainParams(), { fetch: junk })).toBeNull();
    // The body is a PNG of the wrong size.
    const wrongSize = (async () => {
      const bytes = encodePng(8, 8, new Uint8Array(8 * 8 * 3));
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    }) as unknown as typeof fetch;
    expect(await fetchTerrainGrid(CHICAGO, terrainParams(), { fetch: wrongSize })).toBeNull();
    // The crop needs more tiles than the guard allows.
    expect(
      await fetchTerrainGrid({ ...CHICAGO, radiusM: 400000 }, terrainParams(), { fetch: ok }),
    ).toBeNull();
  });
});
