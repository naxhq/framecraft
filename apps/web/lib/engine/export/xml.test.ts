import { describe, expect, it } from "vitest";

import { attrs, escapeAttr, escapeText, fmtInt, fmtNum, transform3mf } from "./xml";
import { decodeEntities, findAll, findFirst, parseXml } from "./xmlParse";

describe("xml escaping", () => {
  it("escapes the markup characters in text and attributes", () => {
    expect(escapeText('a < b & c > "d"')).toBe('a &lt; b &amp; c &gt; "d"');
    expect(escapeAttr('say "hi" <now>\n')).toBe("say &quot;hi&quot; &lt;now&gt;&#10;");
  });

  it("keeps the copyright sign as-is (UTF-8, not an entity)", () => {
    expect(escapeText("© OpenStreetMap contributors")).toBe("© OpenStreetMap contributors");
  });

  it("renders attribute lists with escaped values", () => {
    expect(attrs([["x", 1.5], ["name", 'a"b']])).toBe(' x="1.5" name="a&quot;b"');
  });
});

describe("fmtNum", () => {
  it("never writes scientific notation", () => {
    expect(fmtNum(1e-7)).toBe("0");
    expect(fmtNum(1e21)).toBe("1000000000000000000000");
    expect(fmtNum(123456789.123456)).toBe("123456789.123456");
    expect(fmtNum(-0.0000004)).toBe("0");
  });

  it("trims trailing zeros and never writes -0", () => {
    expect(fmtNum(1.5)).toBe("1.5");
    expect(fmtNum(2)).toBe("2");
    expect(fmtNum(-0)).toBe("0");
    expect(fmtNum(-2.25)).toBe("-2.25");
    expect(fmtNum(0.1 + 0.2)).toBe("0.3");
  });

  it("keeps enough precision to separate float32 neighbours", () => {
    const a = Math.fround(180.123456);
    const b = Math.fround(180.123472);
    expect(a).not.toBe(b);
    expect(fmtNum(a)).not.toBe(fmtNum(b));
  });

  it("refuses NaN and infinities", () => {
    expect(() => fmtNum(Number.NaN)).toThrow();
    expect(() => fmtNum(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => fmtInt(1.5)).toThrow();
  });

  it("writes the identity transform in 3MF row-major 4x3 form", () => {
    expect(transform3mf()).toBe("1 0 0 0 1 0 0 0 1 0 0 0");
    expect(transform3mf(10, -2.5, 0)).toBe("1 0 0 0 1 0 0 0 1 10 -2.5 0");
  });
});

describe("parseXml", () => {
  it("parses elements, attributes, text and entities", () => {
    const doc = parseXml(
      '<?xml version="1.0"?>\n<!-- c -->\n<model unit="millimeter" xmlns:p="urn:p"><metadata name="Title">A &amp; B</metadata><object id="1"/><empty></empty></model>',
    );
    expect(doc.name).toBe("model");
    expect(doc.attributes.unit).toBe("millimeter");
    expect(doc.attributes["xmlns:p"]).toBe("urn:p");
    expect(doc.children.map((c) => c.name)).toEqual(["metadata", "object", "empty"]);
    expect(findFirst(doc, "metadata")?.text).toBe("A & B");
    expect(findAll(doc, "object")).toHaveLength(1);
  });

  it("decodes numeric references", () => {
    expect(decodeEntities("&#169; &#xA9; &quot;&apos;")).toBe("© © \"'");
    expect(() => decodeEntities("&nope;")).toThrow(/unknown entity/);
  });

  it("rejects malformed documents", () => {
    expect(() => parseXml("<a><b></a>")).toThrow(/does not match/);
    expect(() => parseXml("<a>")).toThrow(/unclosed/);
    expect(() => parseXml('<a x="1>')).toThrow();
    expect(() => parseXml("<a/><b/>")).toThrow(/more than one root/);
    expect(() => parseXml('<a x="1" x="2"/>')).toThrow(/duplicate attribute/);
    expect(() => parseXml("<!DOCTYPE a><a/>")).toThrow(/DTD/);
    expect(() => parseXml("just text")).toThrow();
  });
});
