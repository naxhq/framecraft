/**
 * Source guard for the HUD's minimum-wall clause.
 *
 * This is a CRUDE TEST: it reads `CityPreview.tsx` as text and pattern-matches
 * it. It is not a render test and it cannot see what the component actually
 * paints. It exists because the alternative is worse -- the v2 Task 0 audit
 * showed that replacing
 *
 *     ` · ${dilatedNotice(layout.dilatedCount, params, scale)}`
 *
 * with an inline `thresholds.min_detail.toFixed(1)` -- one nozzle where 04 asks
 * for two, and a string that reads exactly as plausibly -- left all 147 unit
 * tests green, because the tests covered `dilatedNotice` but not the call site.
 * `dilatedNotice` now takes `params` + `scale` and derives the wall from
 * `T.min_wall_mm`, so no wrong threshold can be *passed* to it; this file
 * covers the remaining hole, which is bypassing it altogether.
 *
 * Rendering the component for real needs a WebGL canvas (r3f), which the node
 * test environment does not have; the Playwright smoke does render it but has
 * no scene small enough to force a dilated footprint deterministically. Replace
 * this file the day either of those changes. See DECISIONS [V2-P1-fix].
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SRC = readFileSync(new URL("./CityPreview.tsx", import.meta.url), "utf-8");
const LINES = SRC.split(/\r?\n/);

/**
 * The lines that build the dilated-count clause: the `layout.dilatedCount`
 * ternary and its two continuation lines.
 */
function dilatedClauseLines(): string {
  const start = LINES.findIndex((line) => line.includes("layout.dilatedCount >"));
  expect(start, "no `layout.dilatedCount >` ternary in CityPreview.tsx").toBeGreaterThanOrEqual(0);
  return LINES.slice(start, start + 3).join("\n");
}

describe("CityPreview's minimum-wall HUD clause (source guard)", () => {
  it("is produced by dilatedNotice, not formatted inline", () => {
    expect(dilatedClauseLines()).toMatch(/dilatedNotice\(/);
    // ... imported from the module the string is tested in.
    // `[^}]` spans newlines, so this matches the multi-line import block.
    expect(SRC).toMatch(/import \{[^}]*\bdilatedNotice\b[^}]*\} from "@\/lib\/preview"/);
  });

  it("names no other threshold on the lines that build it", () => {
    const clause = dilatedClauseLines();
    // `min_detail` is one nozzle -- exactly half the wall -- and `min_gap` is
    // 1.5 of one. Either reads as a believable "minimum wall" in the HUD.
    expect(clause).not.toMatch(/min_detail/);
    expect(clause).not.toMatch(/min_gap/);
    // No hand-formatted number either: the metres come from the helper.
    expect(clause).not.toMatch(/toFixed/);
  });

  it("keeps the string itself in preview.ts, where vitest asserts it", () => {
    // The literal lives in `dilatedNotice`; if it ever appears here, the exact
    // wording has escaped the tests that pin "18.9 m" and "9.4 m".
    expect(SRC).not.toMatch(/minimum wall/);
  });

  it("calls dilatedNotice exactly once", () => {
    const calls = SRC.match(/dilatedNotice\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });
});
