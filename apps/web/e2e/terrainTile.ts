import { deflateSync } from "node:zlib";

/**
 * A hand-rolled, dependency-free PNG encoder for one thing only: a synthetic
 * Terrarium elevation tile to route `**\/elevation-tiles-prod/**` to in
 * `terrain.spec.ts`, the same way `overpassMock.ts` routes Overpass to a
 * committed JSON fixture. No image library is worth adding for one raster.
 *
 * Terrarium encodes elevation in metres as
 * `(R * 256 + G + B / 256) - 32768` per pixel (Mapzen's format, the one
 * `lib/engine/terrain/tiles.ts` decodes). This produces a uniform tile at a
 * given elevation -- enough to prove the fetch/decode wiring end to end
 * without needing to match a real DEM's exact bytes.
 */

function crc32(buf: Buffer): number {
  let c: number;
  const table = crc32Table();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = (crc ^ buf[i]) & 0xff;
    crc = (crc >>> 8) ^ table[c];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let table: number[] | null = null;
function crc32Table(): number[] {
  if (table) return table;
  table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table.push(c >>> 0);
  }
  return table;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** Elevation (metres) -> the Terrarium RGB triple that decodes back to it. */
function terrariumRgb(elevationM: number): [number, number, number] {
  const value = Math.round((elevationM + 32768) * 256);
  const r = Math.floor(value / 65536) % 256;
  const g = Math.floor(value / 256) % 256;
  const b = value % 256;
  return [r, g, b];
}

/** An 8-bit RGB PNG of `size` x `size`, every pixel the same Terrarium-encoded elevation. */
export function terrariumPng(size: number, elevationM: number): Buffer {
  const [r, g, b] = terrariumRgb(elevationM);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolor (RGB)
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let row = 0; row < size; row += 1) {
    const rowStart = row * (1 + size * 3);
    raw[rowStart] = 0; // filter type: none
    for (let col = 0; col < size; col += 1) {
      const pixelStart = rowStart + 1 + col * 3;
      raw[pixelStart] = r;
      raw[pixelStart + 1] = g;
      raw[pixelStart + 2] = b;
    }
  }
  const idatData = deflateSync(raw);

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
