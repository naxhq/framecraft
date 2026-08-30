import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha1Hex, sha1UnitInterval } from "./sha1";

function nodeSha1(input: string): string {
  return createHash("sha1").update(input, "utf8").digest("hex");
}

describe("sha1Hex", () => {
  it("matches the known SHA-1 test vectors", () => {
    expect(sha1Hex("")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(sha1Hex("The quick brown fox jumps over the lazy dog")).toBe(
      "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12",
    );
  });

  it("matches Python hashlib.sha1('a') (a short, osm-id-like input)", () => {
    expect(sha1Hex("a")).toBe("86f7e437faa5a7fce15d1ddcb9eaeaea377667b8");
  });

  it("cross-validates against node:crypto for a range of inputs, including unicode and multi-block", () => {
    const inputs = [
      "w123456",
      "r99",
      "café",
      "x".repeat(200),
      "[out:json][timeout:180];\n(\n  way[\"building\"]",
      "".padEnd(63, "y"), // just under a 64-byte block boundary
      "".padEnd(64, "y"), // exactly on a block boundary
      "".padEnd(65, "y"), // just over
    ];
    for (const input of inputs) {
      expect(sha1Hex(input)).toBe(nodeSha1(input));
    }
  });
});

describe("sha1UnitInterval", () => {
  it("is deterministic and within [0, 1)", () => {
    for (const id of ["w1", "w123456", "r99", "n42"]) {
      const u = sha1UnitInterval(id);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      expect(sha1UnitInterval(id)).toBe(u);
    }
  });

  it("differs for different ids (no trivial collisions across small ids)", () => {
    const values = new Set(Array.from({ length: 50 }, (_, i) => sha1UnitInterval(`w${i}`)));
    expect(values.size).toBe(50);
  });
});
