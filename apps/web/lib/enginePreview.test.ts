import { describe, expect, it } from "vitest";

import { freshEngineResult } from "./enginePreview";

const RESULT = { regions: [] } as never;

describe("freshEngineResult", () => {
  it("returns the result when ready and not stale", () => {
    expect(freshEngineResult({ status: "ready", result: RESULT, stale: false })).toBe(RESULT);
  });

  it("returns null while idle, even if a result is somehow present", () => {
    expect(freshEngineResult({ status: "idle", result: RESULT, stale: false })).toBeNull();
  });

  it("returns null while computing a newer job -- never a stale flicker", () => {
    expect(freshEngineResult({ status: "computing", result: RESULT, stale: false })).toBeNull();
  });

  it("returns null on error, even with a stale result kept around", () => {
    expect(freshEngineResult({ status: "error", result: RESULT, stale: false })).toBeNull();
  });

  it("returns null once the result has gone stale, even though status is still ready", () => {
    expect(freshEngineResult({ status: "ready", result: RESULT, stale: true })).toBeNull();
  });

  it("returns null when ready but the result itself is null (defensive)", () => {
    expect(freshEngineResult({ status: "ready", result: null, stale: false })).toBeNull();
  });
});
