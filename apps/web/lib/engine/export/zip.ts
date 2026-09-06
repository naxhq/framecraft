// OPC / plain zip packaging on top of fflate. Entries are written in the order
// given, with one fixed modification time stamped in UTC, so the same input
// yields the same bytes on every host (a deterministic 3MF is what lets a test
// compare two exports, and what lets a hash pinned on one machine hold on
// another).

import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

export interface ZipEntry {
  /** Forward-slash path inside the archive, e.g. "3D/3dmodel.model". */
  name: string;
  data: Uint8Array | string;
  /** "store" writes the bytes uncompressed; "deflate" compresses at level 6. */
  method?: "store" | "deflate";
}

export interface ZipOptions {
  /** Timestamp stamped on every entry; defaults to 2000-01-01T00:00:00Z. */
  mtime?: Date;
}

const DEFAULT_MTIME = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));

export function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? strToU8(data) : data;
}

export function zipEntries(entries: readonly ZipEntry[], options: ZipOptions = {}): Uint8Array {
  const seen = new Set<string>();
  const payload: Zippable = {};
  for (const entry of entries) {
    if (entry.name === "" || entry.name.startsWith("/") || entry.name.indexOf("\\") >= 0) {
      throw new Error(`bad zip entry name ${JSON.stringify(entry.name)}`);
    }
    if (seen.has(entry.name)) {
      throw new Error(`duplicate zip entry ${entry.name}`);
    }
    seen.add(entry.name);
    const level = entry.method === "store" ? 0 : 6;
    payload[entry.name] = [toBytes(entry.data), { level }];
  }
  const mtime = options.mtime ?? DEFAULT_MTIME;
  const zip = zipSync(payload, { mtime });
  stampEntries(zip, dosStamp(mtime));
  return zip;
}

/** The two 16-bit words a zip header stores a modification time as. */
export interface DosStamp {
  /** Bits 15..11 hour, 10..5 minute, 4..0 second / 2. */
  time: number;
  /** Bits 15..9 year - 1980, 8..5 month, 4..0 day. */
  date: number;
}

/**
 * The MS-DOS date and time words for an instant, from its UTC fields.
 *
 * fflate derives them from the Date's LOCAL fields (`getFullYear`,
 * `getHours`, ...), which makes the archive's bytes a function of the host's
 * timezone: the fixed default above is 2000-01-01 00:00:00 to a host in
 * London and 1999-12-31 18:00:00 to one in Chicago, and every entry's header
 * carries the difference. That is how a byte hash pinned on a Central Time
 * machine failed on a UTC runner for the same writer and the same fixture.
 * This module stamps the entries itself, from the UTC fields, so the bytes
 * are the same wherever the file is written. The format's stamp has no zone
 * of its own (DOS had no notion of one), so UTC is a choice, and the only one
 * every host makes the same way. The year is clamped to the field's range.
 */
export function dosStamp(instant: Date): DosStamp {
  const year = Math.min(Math.max(instant.getUTCFullYear(), 1980), 2107);
  return {
    time: (instant.getUTCHours() << 11) | (instant.getUTCMinutes() << 5) | (instant.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((instant.getUTCMonth() + 1) << 5) | instant.getUTCDate(),
  };
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

/**
 * The stamps of every entry, in central-directory order: `[local header,
 * central directory entry]` for each, read back the way a zip reader would.
 * `zipEntries` writes them; this is how a test checks what was written
 * without trusting the writer.
 */
export function readStamps(zip: Uint8Array): Array<{ name: string; local: DosStamp; central: DosStamp }> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // fflate writes no archive comment, so the record is the last 22 bytes; the
  // backward scan is what the format specifies and costs nothing here.
  let end = zip.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) end -= 1;
  if (end < 0) throw new Error("zip: no end-of-central-directory record");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const out: Array<{ name: string; local: DosStamp; central: DosStamp }> = [];
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_HEADER_SIGNATURE) throw new Error("zip: bad central directory entry");
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    if (view.getUint32(local, true) !== LOCAL_HEADER_SIGNATURE) throw new Error("zip: bad local file header");
    out.push({
      name: strFromU8(zip.subarray(offset + 46, offset + 46 + nameLength)),
      local: { time: view.getUint16(local + 10, true), date: view.getUint16(local + 12, true) },
      central: { time: view.getUint16(offset + 12, true), date: view.getUint16(offset + 14, true) },
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/** Overwrite the modification stamp in every local header and central directory entry, in place. */
function stampEntries(zip: Uint8Array, stamp: DosStamp): void {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) end -= 1;
  if (end < 0) throw new Error("zip: no end-of-central-directory record");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_HEADER_SIGNATURE) throw new Error("zip: bad central directory entry");
    view.setUint16(offset + 12, stamp.time, true);
    view.setUint16(offset + 14, stamp.date, true);
    const local = view.getUint32(offset + 42, true);
    if (view.getUint32(local, true) !== LOCAL_HEADER_SIGNATURE) throw new Error("zip: bad local file header");
    view.setUint16(local + 10, stamp.time, true);
    view.setUint16(local + 12, stamp.date, true);
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
}

/** Entry names in central-directory order plus their bytes. */
export function unzipAll(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const files = unzipSync(bytes);
  for (const name of Object.keys(files)) {
    out.set(name, files[name]);
  }
  return out;
}

export function unzipText(bytes: Uint8Array, name: string): string {
  const entry = unzipAll(bytes).get(name);
  if (entry === undefined) {
    throw new Error(`zip has no entry ${name}`);
  }
  return strFromU8(entry);
}

export function bytesToText(bytes: Uint8Array): string {
  return strFromU8(bytes);
}
