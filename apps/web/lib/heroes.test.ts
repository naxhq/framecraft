/**
 * Hero picking: the toggle, the cap, and the index -> id mapping.
 *
 * The cap is the frozen contract's `hero_building_ids.maxItems`. Enforcing it
 * in the editor is not belt-and-braces: a thirteenth id would be rejected by
 * pydantic at `POST /bake`, so the user would lose a whole build to find out
 * what a message at the moment of the click could have told them.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_PRINT_PARAMS, PARAM_LIMITS } from "./contracts";
import type { EngineBuilding } from "./engine/osm/types";
import {
  HERO_CAP,
  autoHeroIds,
  effectiveHeroIds,
  heroCandidates,
  heroCapMessage,
  heroDisplayName,
  heroFlags,
  heroTokenInfo,
  topHeroName,
  toggleHeroId,
} from "./heroes";

/** A minimal `EngineBuilding`: a 10x10 m square, no landmark tags, no name. */
function plainBuilding(id: string, heightM: number, size = 10): EngineBuilding {
  const half = size / 2;
  return {
    id,
    ring: [
      [-half, -half],
      [half, -half],
      [half, half],
      [-half, half],
    ],
    holes: [],
    height_m: heightM,
    height_source: "tag",
    min_height_m: 0,
    is_tall: heightM >= 40,
  };
}

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

describe("heroCandidates", () => {
  it("ranks a taller building above a shorter one, all else equal", () => {
    const [top] = heroCandidates([plainBuilding("short", 10), plainBuilding("tall", 100)]);
    expect(top.id).toBe("tall");
  });

  it("ranks a bigger footprint above a smaller one, all else equal", () => {
    const [top] = heroCandidates([
      plainBuilding("small", 30, 10),
      plainBuilding("big", 30, 40),
    ]);
    expect(top.id).toBe("big");
  });

  it("gives a landmark a higher score than an identical plain building", () => {
    const landmark: EngineBuilding = {
      ...plainBuilding("cathedral", 30),
      name: "St. Example's",
      tourism: "attraction",
      historic: "church",
      landmark: true,
    };
    const [top, second] = heroCandidates([plainBuilding("plain", 30), landmark]);
    expect(top.id).toBe("cathedral");
    expect(top.score).toBeGreaterThan(second.score);
  });

  it("breaks a tied score by id, deterministically", () => {
    const candidates = heroCandidates([plainBuilding("b", 10), plainBuilding("a", 10)]);
    expect(candidates.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("never throws on an empty scene", () => {
    expect(heroCandidates([])).toEqual([]);
  });

  it("carries the OSM name through when present", () => {
    const [candidate] = heroCandidates([{ ...plainBuilding("w1", 50), name: "Willis Tower" }]);
    expect(candidate.name).toBe("Willis Tower");
  });
});

describe("autoHeroIds", () => {
  const buildings = [
    plainBuilding("tallest", 300),
    plainBuilding("second", 200),
    plainBuilding("third", 100),
    plainBuilding("shortest", 10),
  ];
  const candidates = heroCandidates(buildings);

  it("promotes the top N candidates with no manual picks", () => {
    expect(autoHeroIds(candidates, [], 2)).toEqual(["tallest", "second"]);
  });

  it("keeps every manual pick, never evicting one for an auto candidate", () => {
    const ids = autoHeroIds(candidates, ["shortest"], 2);
    expect(ids).toContain("shortest");
    expect(ids).toEqual(["shortest", "tallest", "second"]);
  });

  it("does not double-count a candidate that is already manual", () => {
    const ids = autoHeroIds(candidates, ["tallest"], 2);
    // "tallest" is manual; the auto quota of 2 is spent on the next two best.
    expect(ids).toEqual(["tallest", "second", "third"]);
  });

  it("never exceeds the cap even when manual picks alone reach it", () => {
    const manual = Array.from({ length: HERO_CAP }, (_, i) => `m${i}`);
    const ids = autoHeroIds(candidates, manual, 3);
    expect(ids).toHaveLength(HERO_CAP);
    expect(ids).toEqual(manual);
  });

  it("stops adding once the cap is reached, mid-quota", () => {
    const manual = Array.from({ length: HERO_CAP - 1 }, (_, i) => `m${i}`);
    const ids = autoHeroIds(candidates, manual, 3);
    expect(ids).toHaveLength(HERO_CAP);
    expect(ids[ids.length - 1]).toBe("tallest");
  });

  it("treats a zero or negative count as no auto promotion", () => {
    expect(autoHeroIds(candidates, ["third"], 0)).toEqual(["third"]);
    expect(autoHeroIds(candidates, ["third"], -5)).toEqual(["third"]);
  });
});

describe("effectiveHeroIds", () => {
  const buildings = [plainBuilding("tallest", 300), plainBuilding("shortest", 10)];

  it("is the manual list alone when hero_auto is off", () => {
    const params = { hero_building_ids: ["shortest"], hero_auto: { enabled: false, count: 3 } };
    expect(effectiveHeroIds(buildings, params)).toEqual(["shortest"]);
  });

  it("adds auto picks when hero_auto is on", () => {
    const params = { hero_building_ids: [], hero_auto: { enabled: true, count: 1 } };
    expect(effectiveHeroIds(buildings, params)).toEqual(["tallest"]);
  });

  it("falls back to the manual list with no scene yet", () => {
    const params = { hero_building_ids: ["shortest"], hero_auto: { enabled: true, count: 3 } };
    expect(effectiveHeroIds(undefined, params)).toEqual(["shortest"]);
  });
});

describe("heroDisplayName", () => {
  it("uses the OSM name when present", () => {
    expect(heroDisplayName({ name: "Willis Tower" })).toBe("Willis Tower");
  });

  it("falls back to a plain label with no name, or a blank one", () => {
    expect(heroDisplayName({})).toBe("unnamed building");
    expect(heroDisplayName({ name: "   " })).toBe("unnamed building");
  });
});

describe("topHeroName / heroTokenInfo", () => {
  const buildings = [
    { ...plainBuilding("tallest", 300), name: "Tallest Tower" },
    plainBuilding("shortest", 10),
  ];
  const candidates = heroCandidates(buildings);

  it("names the highest-scoring hero among the picked ids", () => {
    expect(topHeroName(candidates, ["shortest", "tallest"])).toBe("Tallest Tower");
  });

  it("is null with no heroes picked, or when the top hero has no name", () => {
    expect(topHeroName(candidates, [])).toBeNull();
    expect(topHeroName(candidates, ["shortest"])).toBeNull();
  });

  it("heroTokenInfo reports the count and the top name together", () => {
    const params = { hero_building_ids: [], hero_auto: { enabled: true, count: 1 } };
    expect(heroTokenInfo(buildings, params)).toEqual({ count: 1, name: "Tallest Tower" });
  });

  it("heroTokenInfo falls back to a null name with nothing picked", () => {
    const params = { hero_building_ids: [], hero_auto: { enabled: false, count: 3 } };
    expect(heroTokenInfo(buildings, params)).toEqual({ count: 0, name: null });
  });
});
