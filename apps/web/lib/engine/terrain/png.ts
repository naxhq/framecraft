/**
 * Just enough PNG to read a Mapzen Terrarium tile, with no new dependency.
 *
 * The browser has `createImageBitmap` + `OffscreenCanvas` and that is what
 * `tiles.ts` uses there. Node has neither, and the engine's tests, the bake CLI
 * and `make validate` all run in Node, so the tiles have to be decodable
 * without a DOM. Every image decoder on npm would be a new dependency for one
 * fixed, tiny case: 256 x 256, 8 bits per channel, RGB or RGBA, non-interlaced,
 * which is exactly what `elevation-tiles-prod` serves.
 *
 * The compressed stream is zlib, and `fflate` (already a dependency, used by
 * `lib/share.ts` and the 3MF writers) inflates it. Everything else here is the
 * PNG container and the five scanline filters from the spec, which are twenty
 * lines of integer arithmetic.
 *
 * Anything outside that fixed case throws, rather than being guessed at: a
 * silently mis-decoded elevation tile is a hill in the wrong place, and
 * `fetchTerrainGrid` turns a throw into a soft `null` anyway.
 */

import { unzlibSync } from "fflate";

/** A decoded 8-bit image. `data` is RGBA, four bytes per pixel, row-major. */
export interface DecodedPng {
  width: number;
  height: number;
  data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Bytes per pixel for the colour types this decoder accepts. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Decode a PNG to RGBA bytes.
 *
 * Supports 8-bit greyscale, greyscale+alpha, RGB and RGBA, non-interlaced -
 * the superset of what a Terrarium tile can be. Throws for anything else.
 */
export function decodePng(bytes: Uint8Array): DecodedPng {
  for (let i = 0; i < SIGNATURE.length; i += 1) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error("not a PNG (bad signature)");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    const start = offset + 8;
    if (type === "IHDR") {
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      bitDepth = bytes[start + 8];
      colorType = bytes[start + 9];
      if (bytes[start + 10] !== 0) throw new Error("unsupported PNG compression");
      if (bytes[start + 11] !== 0) throw new Error("unsupported PNG filter method");
      if (bytes[start + 12] !== 0) throw new Error("interlaced PNG is not supported");
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(start, start + length));
    } else if (type === "IEND") {
      break;
    }
    // length + type + data + CRC
    offset = start + length + 4;
  }

  if (width <= 0 || height <= 0) throw new Error("PNG has no IHDR");
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  const channels = CHANNELS[colorType];
  if (channels === undefined) {
    throw new Error(`unsupported PNG colour type ${colorType} (palettes are not read)`);
  }
  if (idat.length === 0) throw new Error("PNG has no IDAT");

  const raw = unzlibSync(concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) {
    throw new Error("PNG IDAT is shorter than its own header claims");
  }

  const flat = unfilter(raw, width, height, channels);
  return { width, height, data: toRgba(flat, width, height, channels) };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Undo the five per-scanline filters (PNG spec 9.2), in place into a new array.
 *
 * `a` is the pixel to the left, `b` the one above, `c` the one above-left; all
 * three are zero outside the image, which is what makes the first row and the
 * first pixel of every row work without a special case.
 */
function unfilter(
  raw: Uint8Array,
  width: number,
  height: number,
  channels: number,
): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source];
    source += 1;
    const row = y * stride;
    const prior = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[source + x];
      const a = x >= channels ? out[row + x - channels] : 0;
      const b = y > 0 ? out[prior + x] : 0;
      const c = y > 0 && x >= channels ? out[prior + x - channels] : 0;
      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + a;
          break;
        case 2:
          restored = value + b;
          break;
        case 3:
          restored = value + ((a + b) >> 1);
          break;
        case 4:
          restored = value + paeth(a, b, c);
          break;
        default:
          throw new Error(`unknown PNG filter type ${filter} on row ${y}`);
      }
      out[row + x] = restored & 0xff;
    }
    source += stride;
  }
  return out;
}

/** The Paeth predictor, verbatim from the PNG spec. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Widen whatever channel count the file had to RGBA. */
function toRgba(
  flat: Uint8Array,
  width: number,
  height: number,
  channels: number,
): Uint8Array {
  if (channels === 4) return flat;
  const count = width * height;
  const out = new Uint8Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    const from = i * channels;
    const to = i * 4;
    if (channels === 3) {
      out[to] = flat[from];
      out[to + 1] = flat[from + 1];
      out[to + 2] = flat[from + 2];
      out[to + 3] = 255;
    } else {
      // Greyscale, with or without alpha.
      const grey = flat[from];
      out[to] = grey;
      out[to + 1] = grey;
      out[to + 2] = grey;
      out[to + 3] = channels === 2 ? flat[from + 1] : 255;
    }
  }
  return out;
}
