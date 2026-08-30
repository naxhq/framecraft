/**
 * Pure-JS, dependency-free SHA-1 hex digest.
 *
 * Used for two things that must be deterministic and synchronous everywhere
 * this engine runs (main thread, Web Worker, Node under vitest, no bundler
 * polyfills): the Overpass query cache key (`overpass.ts` mirrors
 * `services/bake/app/ingest/overpass.py:query_sha1`) and the per-building
 * height jitter seed (`heights.ts` mirrors
 * `services/bake/app/ingest/normalize.py:jitter_factor`).
 *
 * `crypto.subtle.digest` would work too, but it is async everywhere and
 * absent in some worker/test setups; a ~40-line hand implementation avoids
 * both problems and a new npm dependency. Not for security use.
 */

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/** SHA-1 digest of a UTF-8 string, returned as lowercase hex (40 chars). */
export function sha1Hex(input: string): string {
  const bytes = utf8Bytes(input);
  const bitLen = bytes.length * 8;

  // Pad: 0x80, then zeros, then the 64-bit big-endian bit length, to a
  // multiple of 64 bytes.
  const withOne = bytes.length + 1;
  const padded = withOne + ((56 - (withOne % 64) + 64) % 64) + 8;
  const buf = new Uint8Array(padded);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  // bitLen fits in 32 bits for every input this engine hashes (Overpass
  // query text, OSM ids); write the high 32 bits as zero explicitly.
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  const view = new DataView(buf.buffer);
  view.setUint32(padded - 8, hi, false);
  view.setUint32(padded - 4, lo, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Int32Array(80);
  for (let offset = 0; offset < padded; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getInt32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1) | 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, "0")).join("");
}

function utf8Bytes(input: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(input);
  }
  // Node < 11 fallback; every runtime this engine targets has TextEncoder.
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const code = input.codePointAt(i);
    if (code === undefined) continue;
    if (code > 0xffff) i++;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000)
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
  }
  return new Uint8Array(out);
}

/**
 * The jitter seed's `[0, 1)` unit value, mirroring
 * `int.from_bytes(digest[:8], "big") / float(1 << 64)` on the first 8 hash
 * bytes: hex digits 0..15 of the SHA-1 digest, read as a big-endian 64-bit
 * unsigned integer, divided by 2^64. Done in two 32-bit halves because
 * JS numbers cannot hold a 64-bit integer exactly.
 */
export function sha1UnitInterval(input: string): number {
  const hex = sha1Hex(input);
  const hi = parseInt(hex.slice(0, 8), 16); // bits 63..32
  const lo = parseInt(hex.slice(8, 16), 16); // bits 31..0
  return (hi * 0x100000000 + lo) / 0x10000000000000000;
}
