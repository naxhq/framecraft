/**
 * Hero picking: the toggle, the cap, and the index -> id mapping.
 *
 * The cap is the frozen contract's `hero_building_ids.maxItems`. Enforcing it
 * in the editor is not belt-and-braces: a thirteenth id would be rejected by
 * pydantic at `POST /bake`, so the user would lose a whole bake to find out
 * what a message at the moment of the click could have told them.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_PRINT_PARAMS, PARAM_LIMITS } from "./contracts";
import { HERO_CAP, heroCapMessage, heroFlags, toggleHeroId } from "./heroes";

describe("HERO_CAP", () => {
  it("is the generated contract's limit, not a number typed here", () => {
    expect(HERO_CAP).toBe(PARAM_LIMITS.hero_building_ids.max_items);
    // ...which is currently 12; if the schema moves, this line is the one that
    // should be updated, and every cap in the UI follows automatically.
    expect(PARAM_LIMITS.hero_building_ids.max_items).toBe(12);
    expect(DEFAULT_PRINT_PARAMS.hero_building_ids).toEqual([]);
  });
});

describe("toggleHeroId", () => {
  it("adds an id, newest last", () => {
    const first = toggleHeroId([], "w1");
    expect(first).toEqual({ ids: ["w1"], capHit: false, action: "added" });
    expect(toggleHeroId(first.ids, "w2").ids).toEqual(["w1", "w2"]);
  });

  it("removes an id that is already picked", () => {
    const result = toggleHeroId(["w1", "w2", "w3"], "w2");
    expect(result.ids).toEqual(["w1", "w3"]);
    expect(result.action).toBe("removed");
    expect(result.capHit).toBe(false);
  });

  it("never mutates the list it was given", () => {
    const ids = ["w1"];
    toggleHeroId(ids, "w2");
    toggleHeroId(ids, "w1");
    expect(ids).toEqual(["w1"]);
  });

  it("refuses the thirteenth and says so", () => {
    const full = Array.from({ length: HERO_CAP }, (_, i) => `w${i}`);
    const result = toggleHeroId(full, "one-more");
    expect(result.capHit).toBe(true);
    expect(result.action).toBe("refused");
    expect(result.ids).toEqual(full);
    expect(result.ids).toHaveLength(HERO_CAP);
  });

  it("still lets a full list be shortened", () => {
    const full = Array.from({ length: HERO_CAP }, (_, i) => `w${i}`);
    const result = toggleHeroId(full, "w0");
    expect(result.capHit).toBe(false);
    expect(result.ids).toHaveLength(HERO_CAP - 1);
    // ...and then accepts a new one again.
    expect(toggleHeroId(result.ids, "one-more").ids).toHaveLength(HERO_CAP);
  });

  it("honours a smaller cap when one is passed", () => {
    expect(toggleHeroId(["a", "b"], "c", 2).capHit).toBe(true);
    expect(toggleHeroId(["a"], "c", 2).ids).toEqual(["a", "c"]);
  });

  it("has a message that names the limit", () => {
    expect(heroCapMessage()).toContain(String(HERO_CAP));
  });
});

describe("heroFlags", () => {
  it("maps by id, not by index", () => {
    // The preview drops sub-detail footprints, so instance 1 is NOT
    // SceneGraph building 1. Flagging by index would light up the wrong block.
    const drawn = ["w0", "w7", "w9"];
    expect(heroFlags(drawn, ["w7"])).toEqual([false, true, false]);
    expect(heroFlags(drawn, ["w1"])).toEqual([false, false, false]);
  });

  it("is all false with nothing picked, and matches multiple heroes", () => {
    expect(heroFlags(["a", "b"], [])).toEqual([false, false]);
    expect(heroFlags(["a", "b"], ["b", "a"])).toEqual([true, true]);
  });
});
