import { describe, expect, it } from "vitest";

import { defaultPrintParams } from "./contracts";
import type { Engraving, PrintParams } from "./contracts";
import { engravingSurfaceLabel, resolvedOutputLines } from "./resolvedOutput";
import type { TokenContext } from "./tokens";

const CTX: TokenContext = {
  lat: 41.8827,
  lon: -87.6233,
  scale_mm_per_m: 168 / 1800,
  radius_m: 900,
  date: "2026-08-29",
  buildings: 994,
  city: "Chicago",
};

const NO_CITY: TokenContext = { ...CTX, city: "" };

function withParams(overrides: Partial<PrintParams>): PrintParams {
  return { ...defaultPrintParams(), ...overrides };
}

const cityLine = (edge: Engraving["edge"] = "top"): Engraving => ({
  edge,
  text: "{city}",
});

describe("engravingSurfaceLabel", () => {
  it("names the edge, the mode and the depth", () => {
    expect(engravingSurfaceLabel({ edge: "top", text: "x", mode: "engrave", depth_mm: 0.4 })).toBe(
      "Frame, top edge, engraved 0.40 mm",
    );
    expect(engravingSurfaceLabel({ edge: "bottom", text: "x", mode: "emboss", depth_mm: 1.5 })).toBe(
      "Frame, bottom edge, embossed 1.50 mm",
    );
  });

  it("defaults mode to engrave and depth to the contract default", () => {
    const label = engravingSurfaceLabel({ edge: "left", text: "x" });
    expect(label).toContain("left edge, engraved");
  });
});

describe("resolvedOutputLines", () => {
  it("is empty when there is nothing configured to cut", () => {
    expect(resolvedOutputLines(defaultPrintParams(), CTX)).toEqual([]);
  });

  it("cuts a line whose tokens all resolve", () => {
    const params = withParams({ frame: true, engravings: [cityLine()] });
    const lines = resolvedOutputLines(params, CTX);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      id: "engraving-0",
      index: 0,
      text: "Chicago",
      status: "cut",
      cause: null,
      reason: null,
    });
    expect(lines[0].surface).toBe("Frame, top edge, engraved 0.40 mm");
  });

  it("skips an empty line and names the exact empty token, with a 1-based line number", () => {
    const params = withParams({
      frame: true,
      engravings: [{ edge: "top", text: "hello" }, cityLine("bottom")],
    });
    const lines = resolvedOutputLines(params, NO_CITY);
    expect(lines[0].status).toBe("cut");
    expect(lines[1]).toMatchObject({
      status: "skipped",
      cause: "empty",
      emptyToken: "city",
      reason: "Line 2: the {city} token has no value.",
    });
  });

  it("skips every engraving line, with the frame-off cause, when the frame is off", () => {
    const params = withParams({
      frame: false,
      engravings: [cityLine("top"), cityLine("bottom")],
    });
    const lines = resolvedOutputLines(params, CTX);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.status).toBe("skipped");
      expect(line.cause).toBe("frame-off");
      expect(line.reason).toBe("Frame is off — turn on Frame to engrave the edges.");
      expect(line.text).toBe("");
    }
  });

  it("cuts a resolving underside mark even when the frame is off", () => {
    const params = withParams({
      frame: false,
      underside_mark: { enabled: true, template: "{city} {date}" },
    });
    const lines = resolvedOutputLines(params, CTX);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      id: "underside-mark",
      index: null,
      surface: "Underside mark",
      text: "Chicago 2026-08-29",
      status: "cut",
    });
  });

  it("skips an empty underside mark and names the token", () => {
    const params = withParams({
      underside_mark: { enabled: true, template: "{city}" },
    });
    const lines = resolvedOutputLines(params, NO_CITY);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      id: "underside-mark",
      status: "skipped",
      cause: "empty",
      emptyToken: "city",
      reason: "Underside mark: the {city} token has no value.",
    });
  });

  it("omits the underside mark row entirely when it is disabled", () => {
    const params = withParams({
      underside_mark: { enabled: false, template: "{city}" },
    });
    expect(resolvedOutputLines(params, CTX)).toEqual([]);
  });

  it("lists every configured line, cut and skipped mixed", () => {
    const params = withParams({
      frame: true,
      engravings: [cityLine("top"), { edge: "bottom", text: "{unknown}" }],
      underside_mark: { enabled: true, template: "{city} {scale} {date}" },
    });
    const lines = resolvedOutputLines(params, CTX);
    expect(lines.map((l) => l.id)).toEqual(["engraving-0", "engraving-1", "underside-mark"]);
    // {unknown} is not a token FrameCraft knows, so it survives verbatim and
    // the line is NOT empty (an unknown brace is someone's literal text).
    expect(lines[1].status).toBe("cut");
    expect(lines[1].text).toBe("{unknown}");
  });

  it("a whitespace-only line is treated as empty", () => {
    const params = withParams({ frame: true, engravings: [{ edge: "top", text: "   " }] });
    const lines = resolvedOutputLines(params, CTX);
    expect(lines[0].status).toBe("skipped");
    expect(lines[0].cause).toBe("empty");
    expect(lines[0].emptyToken).toBeNull();
    expect(lines[0].reason).toBe("Line 1 has no text.");
  });
});
