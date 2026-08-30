import { describe, expect, it } from "vitest";
import { BAKE_API_URL } from "./api";

describe("BAKE_API_URL", () => {
  it("is a well-formed http(s) URL", () => {
    expect(BAKE_API_URL).toMatch(/^https?:\/\//);
  });
});
