import { describe, expect, it } from "vitest";

import { bytesToText, dosStamp, readStamps, unzipAll, unzipText, zipEntries } from "./zip";

/**
 * Run `fn` with the process in `zone`. Node re-reads `TZ` on assignment (on
 * Windows too), so the local-time getters inside `fn` answer for that zone.
 */
function inZone<T>(zone: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

/**
 * What 2000-01-01T00:00:00Z reads as on a wall clock in each zone. Asserted
 * before the bytes are compared, so a zone switch that silently failed to take
 * cannot make the determinism test pass by testing one zone five times.
 */
const LOCAL_HOUR_AT_DEFAULT_MTIME: Record<string, number> = {
  UTC: 0,
  "America/Chicago": 18, // the previous evening, UTC-6
  "Asia/Kolkata": 5, // UTC+5:30
  "Pacific/Kiritimati": 14, // UTC+14, the earliest clock on Earth
  "Pacific/Pago_Pago": 13, // UTC-11, the previous day
};

describe("zipEntries", () => {
  it("keeps the entry order given and round-trips every byte", () => {
    const bytes = zipEntries([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "_rels/.rels", data: "<Relationships/>", method: "store" },
      { name: "3D/3dmodel.model", data: new Uint8Array([1, 2, 3, 250, 251]) },
    ]);
    const entries = unzipAll(bytes);
    expect([...entries.keys()]).toEqual(["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"]);
    expect(unzipText(bytes, "[Content_Types].xml")).toBe("<Types/>");
    expect(bytesToText(entries.get("_rels/.rels") as Uint8Array)).toBe("<Relationships/>");
    expect([...(entries.get("3D/3dmodel.model") as Uint8Array)]).toEqual([1, 2, 3, 250, 251]);
  });

  it("is deterministic for the same input", () => {
    const make = () => zipEntries([{ name: "a.txt", data: "hello" }, { name: "b/c.txt", data: "world" }]);
    expect([...make()]).toEqual([...make()]);
  });

  it("stamps the requested modification time", () => {
    const a = zipEntries([{ name: "a.txt", data: "x" }], { mtime: new Date(Date.UTC(2020, 0, 1)) });
    const b = zipEntries([{ name: "a.txt", data: "x" }], { mtime: new Date(Date.UTC(2021, 5, 15, 8, 30)) });
    expect([...a]).not.toEqual([...b]);
  });

  it("refuses duplicate, absolute and backslash names", () => {
    expect(() => zipEntries([{ name: "a", data: "" }, { name: "a", data: "" }])).toThrow(/duplicate/);
    expect(() => zipEntries([{ name: "/a", data: "" }])).toThrow(/bad zip entry/);
    expect(() => zipEntries([{ name: "a\\b", data: "" }])).toThrow(/bad zip entry/);
  });

  it("reports a missing entry by name", () => {
    const bytes = zipEntries([{ name: "a.txt", data: "x" }]);
    expect(() => unzipText(bytes, "missing.txt")).toThrow(/no entry missing.txt/);
  });
});

/**
 * The modification stamp is the one place a zip's bytes can depend on the
 * host: fflate derives it from the Date's LOCAL fields, so the fixed default
 * mtime used to come out as 1999-12-31 18:00 on a Central Time machine and
 * 2000-01-01 00:00 on a UTC runner, and the single-plate Bambu hash pinned
 * in `tiles.test.ts` failed on CI for exactly that reason. `zipEntries` now
 * stamps the UTC fields itself; these tests hold that in every zone, by
 * switching the process zone rather than trusting the one the host is in.
 */
describe("the modification stamp", () => {
  const entries = [
    { name: "a.txt", data: "x" },
    { name: "b/c.txt", data: "yy", method: "store" as const },
  ];

  it("writes the same bytes in every timezone", () => {
    const reference = zipEntries(entries);
    for (const [zone, localHour] of Object.entries(LOCAL_HOUR_AT_DEFAULT_MTIME)) {
      // The switch has to have taken effect, or the comparison proves nothing.
      expect(inZone(zone, () => new Date(Date.UTC(2000, 0, 1)).getHours()), zone).toBe(localHour);
      expect([...inZone(zone, () => zipEntries(entries))], zone).toEqual([...reference]);
    }
  });

  it("stamps the UTC time on every local header and central directory entry", () => {
    const custom = new Date(Date.UTC(2021, 5, 15, 8, 30, 44));
    for (const zone of Object.keys(LOCAL_HOUR_AT_DEFAULT_MTIME)) {
      const stamps = inZone(zone, () => readStamps(zipEntries(entries)));
      expect(stamps.map((s) => s.name)).toEqual(["a.txt", "b/c.txt"]);
      for (const stamp of stamps) {
        // 2000-01-01 00:00:00: year 20 << 9 | month 1 << 5 | day 1; midnight is 0.
        expect(stamp.local, zone).toEqual({ time: 0, date: (20 << 9) | (1 << 5) | 1 });
        expect(stamp.central, zone).toEqual(stamp.local);
      }
      const customStamps = inZone(zone, () => readStamps(zipEntries(entries, { mtime: custom })));
      for (const stamp of customStamps) {
        // 2021-06-15 08:30:44 -> seconds are stored halved.
        expect(stamp.local, zone).toEqual({ time: (8 << 11) | (30 << 5) | 22, date: (41 << 9) | (6 << 5) | 15 });
        expect(stamp.central, zone).toEqual(stamp.local);
      }
    }
    expect(dosStamp(custom)).toEqual({ time: (8 << 11) | (30 << 5) | 22, date: (41 << 9) | (6 << 5) | 15 });
  });

  it("clamps a year outside the field's range instead of writing garbage bits", () => {
    expect(dosStamp(new Date(Date.UTC(1970, 0, 1))).date >> 9).toBe(0);
    expect(dosStamp(new Date(Date.UTC(2200, 0, 1))).date >> 9).toBe(2107 - 1980);
  });
});
