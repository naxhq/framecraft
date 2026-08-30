/**
 * The TS half of the shared token table.
 *
 * `fixtures/tokens-expected.json` is written by
 * `services/bake/tests/test_tokens.py` and asserted by both suites, so a
 * rounding tie, a locale-formatted separator or a hemisphere letter that
 * differs between Python and TS fails here.
 *
 * Regenerate the fixture with:
 *   cd services/bake && FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_tokens.py
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as TK from "./tokens";
import type { TokenContext } from "./tokens";

interface TokenCase {
  text: string;
  ctx: TokenContext;
  expected: string;
}

interface TokensFixture {
  tokens: string[];
  cases: TokenCase[];
}

function loadFixture<T>(relative: string): T {
  const url = new URL(`../../../fixtures/${relative}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf-8")) as T;
}

const fixture = loadFixture<TokensFixture>("tokens-expected.json");

describe("tokens-expected.json parity", () => {
  it("names the same thirteen tokens as the Python table", () => {
    expect(fixture.tokens).toEqual([...TK.TOKENS]);
  });

  it("has a case for every token", () => {
    const texts = fixture.cases.map((c) => c.text).join(" ");
    for (const name of TK.TOKENS) {
      expect(texts, name).toContain(`{${name}}`);
    }
  });

  it.each(fixture.cases.map((c, i) => [i, c] as const))(
    "case %i expands exactly as Python does",
    (_i, testCase) => {
      expect(TK.expand_tokens(testCase.text, testCase.ctx)).toBe(testCase.expected);
    },
  );
});

describe("formatters", () => {
  const chicago: TokenContext = {
    city: "Chicago",
    lat: 41.8827,
    lon: -87.6233,
    scale_mm_per_m: 168 / 1800,
    radius_m: 900,
    date: "2026-08-29",
    buildings: 994,
  };

  it("has a formatter for every token and no others", () => {
    expect(Object.keys(TK.FORMATTERS).sort()).toEqual([...TK.TOKENS].sort());
  });

  it("names exactly thirteen tokens", () => {
    expect(TK.TOKENS.length).toBe(13);
  });

  it("groups thousands without a locale", () => {
    expect(TK.group_thousands(0)).toBe("0");
    expect(TK.group_thousands(999)).toBe("999");
    expect(TK.group_thousands(1000)).toBe("1,000");
    expect(TK.group_thousands(23571)).toBe("23,571");
    expect(TK.group_thousands(1234567)).toBe("1,234,567");
  });

  it("groups from the decimal digits, never from an exponential string", () => {
    // `String(1e21)` is "1e+21", which the old implementation grouped into
    // "1e,+21" while Python printed twenty-two digits (v2-01 audit finding 6).
    expect(TK.group_thousands(9007199254740991)).toBe("9,007,199,254,740,991");
    expect(TK.group_thousands(1e21)).toBe("1,000,000,000,000,000,000,000");
    expect(TK.group_thousands(-1e21)).toBe("-1,000,000,000,000,000,000,000");
  });

  it("reads the equator as north and the prime meridian as east", () => {
    expect(TK.format_coords({ ...chicago, lat: 0, lon: 0 })).toBe("0.0000° N, 0.0000° E");
    expect(TK.format_coords({ ...chicago, lat: -0, lon: -0 })).toBe("0.0000° N, 0.0000° E");
  });

  it("rounds ties away from zero, not to even", () => {
    // Python's own round() would give 0, 2, 2 here; the shared helper must not.
    expect(TK.round_half_up(0.5)).toBe(1);
    expect(TK.round_half_up(1.5)).toBe(2);
    expect(TK.round_half_up(2.5)).toBe(3);
    expect(TK.round_half_up(0.4999)).toBe(0);
  });

  it("never prints a negative zero", () => {
    expect(TK.fixed(-0.00004, 4)).toBe("0.0000");
    expect(TK.fixed(-0.00006, 4)).toBe("-0.0001");
  });

  it("leaves an unknown token exactly as written", () => {
    expect(TK.expand_tokens("{nope}", chicago)).toBe("{nope}");
    expect(TK.expand_tokens("{CITY}", chicago)).toBe("{CITY}");
    expect(TK.expand_tokens("{lat", chicago)).toBe("{lat");
  });

  it("leaves {scale} standing when the scene has no measured scale", () => {
    const unmeasured = { ...chicago, scale_mm_per_m: 0 };
    expect(TK.format_scale(unmeasured)).toBeNull();
    expect(TK.expand_tokens("scale {scale}", unmeasured)).toBe("scale {scale}");
  });

  it("never guesses the city from the coordinates", () => {
    const unset = { ...chicago, city: "" };
    expect(TK.format_city(unset)).toBe("");
    expect(TK.expand_tokens("{city}{coords}", unset)).toBe("41.8827° N, 87.6233° W");
    // ...and an omitted label behaves the same as an empty one.
    const omitted: TokenContext = { ...chicago };
    delete omitted.city;
    expect(TK.format_city(omitted)).toBe("");
  });

  it("expands every token in one mixed string", () => {
    expect(
      TK.expand_tokens("{city} {coords} {scale} {radius} {buildings} {date} {lat} {lon}", chicago),
    ).toBe(
      "Chicago 41.8827° N, 87.6233° W 1:10,714 900 m 994 2026-08-29 41.8827 -87.6233",
    );
  });

  // --- v3-P1: place, author and hero --------------------------------------

  const withPlace: TokenContext = {
    ...chicago,
    country: "United States",
    state: "Illinois",
    neighbourhood: "The Loop",
    author: "Vahid Alizadeh",
    hero_count: 3,
  };

  it("formats country, state, neighbourhood and author verbatim", () => {
    expect(TK.format_country(withPlace)).toBe("United States");
    expect(TK.format_state(withPlace)).toBe("Illinois");
    expect(TK.format_neighbourhood(withPlace)).toBe("The Loop");
    expect(TK.format_author(withPlace)).toBe("Vahid Alizadeh");
  });

  it("never guesses country, state, neighbourhood or author either", () => {
    const bare = { ...chicago };
    expect(TK.format_country(bare)).toBe("");
    expect(TK.format_state(bare)).toBe("");
    expect(TK.format_neighbourhood(bare)).toBe("");
    expect(TK.format_author(bare)).toBe("");
    expect(
      TK.expand_tokens("[{country}][{state}][{neighbourhood}][{author}]", bare),
    ).toBe("[][][][]");
  });

  it("formats hero as a count, empty when none are selected", () => {
    expect(TK.format_hero(chicago)).toBe("");
    expect(TK.format_hero({ ...chicago, hero_count: 0 })).toBe("");
    expect(TK.format_hero({ ...chicago, hero_count: 1 })).toBe("1");
    expect(TK.format_hero(withPlace)).toBe("3");
  });

  it("expands the five new tokens in one mixed string", () => {
    expect(
      TK.expand_tokens(
        "{city}, {neighbourhood}, {state}, {country} - by {author} ({hero} heroes)",
        withPlace,
      ),
    ).toBe("Chicago, The Loop, Illinois, United States - by Vahid Alizadeh (3 heroes)");
  });
});

describe("resolve_text", () => {
  const chicago: TokenContext = {
    city: "Chicago",
    lat: 41.8827,
    lon: -87.6233,
    scale_mm_per_m: 168 / 1800,
    radius_m: 900,
    date: "2026-08-29",
    buildings: 994,
  };

  it("matches expand_tokens exactly", () => {
    const text = "{city} {scale} {date}";
    expect(TK.resolve_text(text, chicago).text).toBe(TK.expand_tokens(text, chicago));
  });

  it("names every known token found, in order, with whether it was empty", () => {
    const unset: TokenContext = { ...chicago, city: "" };
    const result = TK.resolve_text("{city} {lat} {country}", unset);
    expect(result.tokens).toEqual([
      { token: "city", empty: true },
      { token: "lat", empty: false },
      { token: "country", empty: true },
    ]);
  });

  it("treats an unmeasured {scale} as empty too, not merely unresolved", () => {
    const unmeasured: TokenContext = { ...chicago, scale_mm_per_m: 0 };
    const result = TK.resolve_text("{scale}", unmeasured);
    expect(result.text).toBe("{scale}");
    expect(result.tokens).toEqual([{ token: "scale", empty: true }]);
  });

  it("does not track an unknown brace as a token at all", () => {
    const result = TK.resolve_text("{nope} {city}", chicago);
    expect(result.tokens).toEqual([{ token: "city", empty: false }]);
  });

  it("says a line with every token resolved has no empty entries", () => {
    const result = TK.resolve_text("{city} {radius}", chicago);
    expect(result.tokens.every((t) => !t.empty)).toBe(true);
  });

  it("finds the same token twice as two entries", () => {
    const unset: TokenContext = { ...chicago, city: "" };
    const result = TK.resolve_text("{city}, {city}", unset);
    expect(result.tokens).toEqual([
      { token: "city", empty: true },
      { token: "city", empty: true },
    ]);
  });
});
