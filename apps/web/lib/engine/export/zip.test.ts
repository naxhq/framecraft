import { describe, expect, it } from "vitest";

import { bytesToText, unzipAll, unzipText, zipEntries } from "./zip";

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
