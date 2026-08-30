// OPC / plain zip packaging on top of fflate. Entries are written in the order
// given, with one fixed modification time, so the same input yields the same
// bytes (a deterministic 3MF is what lets a test compare two exports).

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
  return zipSync(payload, { mtime: options.mtime ?? DEFAULT_MTIME });
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
