/**
 * The thirteen text tokens FrameCraft expands in engravings and the underside
 * mark.
 *
 * This module is one half of a MIRRORED PAIR: `services/bake/app/geom/tokens.py`
 * is the same table with the same snake_case names, so the string the editor
 * previews on the frame is byte for byte the string the bake cuts into it. The
 * pair is pinned by `fixtures/tokens-expected.json`, which both test suites
 * assert against (DECISIONS [V2-P2], the same arrangement transform.ts already
 * uses per [P4] - hence snake_case here rather than idiomatic camelCase, so the
 * two files diff side by side).
 *
 * Rules:
 *
 * - This module is a pure FORMATTER. It never decides what `{city}` (or
 *   `{country}`, `{state}`, `{neighbourhood}`, `{author}`) actually says - the
 *   CALLER resolves that (a preset's city name, a Nominatim reverse geocode, a
 *   user's own typed override or Author field: `lib/geocode.ts`,
 *   `store/editor.ts`) and hands the resolved string in on `TokenContext`. An
 *   unresolved field is `""`, exactly like an unset `city` always was, never a
 *   guess synthesised here.
 * - `{hero}` is the COUNT of selected hero buildings, not a building's real
 *   name: `SceneGraph.Building` (the frozen contract) carries no `name` field,
 *   so there is nothing honest to print in its place. Empty when no hero is
 *   selected, exactly like every other token that has nothing to say
 *   (DECISIONS [V3-P1]).
 * - An unknown `{token}` is left exactly as written - it is far likelier to be
 *   a deliberate brace in someone's text than a typo we should silently eat.
 * - Every number is formatted by hand (`fixed`, `group_thousands`,
 *   `round_half_up`) instead of through `toFixed()` / `toLocaleString()`,
 *   because those disagree with Python's `format()` at ties and under locales.
 */

/** Every token name, in the order the docs list them. */
export const TOKENS = [
  "city",
  "lat",
  "lon",
  "coords",
  "scale",
  "radius",
  "date",
  "buildings",
  "country",
  "state",
  "neighbourhood",
  "author",
  "hero",
] as const;

export type TokenName = (typeof TOKENS)[number];

/**
 * Decimal places for a latitude or longitude: ~11 m at the equator, which is
 * finer than the crop this model is a picture of.
 */
export const COORD_DECIMALS = 4;

const TOKEN_RE = /\{([A-Za-z_][A-Za-z_0-9]*)\}/g;

/**
 * Everything the token table can talk about.
 *
 * `date` is supplied by the CALLER as an ISO `YYYY-MM-DD` string and never read
 * from the clock here, so a bake and its preview agree and a test is not a
 * function of the day it runs on.
 */
export interface TokenContext {
  lat: number;
  lon: number;
  scale_mm_per_m: number;
  radius_m: number;
  date: string;
  buildings: number;
  city?: string;
  country?: string;
  state?: string;
  neighbourhood?: string;
  author?: string;
  /** How many hero buildings are selected. `{hero}` formats this, not a name. */
  hero_count?: number;
}

// ---------------------------------------------------------------------------
// number formatting, mirrored verbatim in tokens.py
// ---------------------------------------------------------------------------

/**
 * Round to the nearest integer, ties away from zero on the positive side.
 * `Math.floor(x + 0.5)`, spelled out so the Python side can mirror it exactly:
 * Python's own `round` is banker's rounding and would disagree on every tie.
 */
export function round_half_up(value: number): number {
  return Math.floor(value + 0.5);
}

/**
 * `23571` -> `"23,571"`. Hand-rolled so JS locales cannot change it.
 *
 * The digits come from `BigInt(...).toString()`, never from `String(n)` or
 * `toLocaleString()`: `String(1e21)` is `"1e+21"`, and walking a thousands
 * separator over that prints `"1e,+21"` where Python printed twenty-two digits.
 * BigInt renders every finite integer-valued double in plain decimal, so the
 * two languages agree for every integer (well past the 2^53 the contract's
 * counts can reach). A non-finite value has no decimal form in either language
 * and keeps its JS spelling, as before.
 */
export function group_thousands(value: number): string {
  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(Math.trunc(value));
  let digits = Number.isFinite(magnitude) ? BigInt(magnitude).toString() : String(magnitude);
  const groups: string[] = [];
  while (digits.length > 3) {
    groups.unshift(digits.slice(-3));
    digits = digits.slice(0, -3);
  }
  groups.unshift(digits);
  return sign + groups.join(",");
}

/**
 * `value` with exactly `decimals` places, ties away from zero. Built from
 * integer arithmetic on the scaled value so JS and Python produce the same
 * digits; a negative value that rounds to zero prints `0.0000`, never
 * `-0.0000`.
 */
export function fixed(value: number, decimals: number): string {
  const factor = 10 ** decimals;
  const scaled = Math.floor(Math.abs(value) * factor + 0.5);
  const whole = Math.floor(scaled / factor);
  const frac = scaled - whole * factor;
  const sign = value < 0 && scaled !== 0 ? "-" : "";
  return `${sign}${whole}.` + String(frac).padStart(decimals, "0");
}

// ---------------------------------------------------------------------------
// the formatters
// ---------------------------------------------------------------------------

/** The user's typed city label, verbatim; empty when they typed nothing. */
export function format_city(ctx: TokenContext): string {
  return ctx.city ?? "";
}

/** Signed latitude, 4 decimals: `41.8827` / `-33.8688`. */
export function format_lat(ctx: TokenContext): string {
  return fixed(ctx.lat, COORD_DECIMALS);
}

/** Signed longitude, 4 decimals: `-87.6233`. */
export function format_lon(ctx: TokenContext): string {
  return fixed(ctx.lon, COORD_DECIMALS);
}

/** `41.8827° N, 87.6233° W` - absolute values plus a hemisphere letter. */
export function format_coords(ctx: TokenContext): string {
  const ns = ctx.lat >= 0 ? "N" : "S";
  const ew = ctx.lon >= 0 ? "E" : "W";
  const lat = fixed(Math.abs(ctx.lat), COORD_DECIMALS);
  const lon = fixed(Math.abs(ctx.lon), COORD_DECIMALS);
  return `${lat}° ${ns}, ${lon}° ${ew}`;
}

/**
 * `1:23,571` from `scale_mm_per_m` (print mm per ground metre, [P4]).
 *
 * Returns null - which leaves `{scale}` standing in the text - when the scale
 * is not positive. There is no honest ratio for a scene that has not been
 * measured yet, and printing `1:0` onto a frame is worse than printing the
 * token the user typed.
 */
export function format_scale(ctx: TokenContext): string | null {
  if (!(ctx.scale_mm_per_m > 0)) return null;
  return "1:" + group_thousands(round_half_up(1000.0 / ctx.scale_mm_per_m));
}

/** `900 m` - whole metres, no thousands separator (DECISIONS [V2-P2]). */
export function format_radius(ctx: TokenContext): string {
  return `${round_half_up(ctx.radius_m)} m`;
}

/** The caller's ISO date, verbatim. */
export function format_date(ctx: TokenContext): string {
  return ctx.date ?? "";
}

/** `1,841` - the building count with thousands separators. */
export function format_buildings(ctx: TokenContext): string {
  return group_thousands(Math.trunc(ctx.buildings));
}

/** The resolved country name, verbatim; empty when nothing resolved one. */
export function format_country(ctx: TokenContext): string {
  return ctx.country ?? "";
}

/** The resolved state or province, verbatim; empty when nothing resolved one. */
export function format_state(ctx: TokenContext): string {
  return ctx.state ?? "";
}

/** The resolved neighbourhood, verbatim; empty when nothing resolved one. */
export function format_neighbourhood(ctx: TokenContext): string {
  return ctx.neighbourhood ?? "";
}

/** The author's own typed name, verbatim; empty when they typed nothing. */
export function format_author(ctx: TokenContext): string {
  return ctx.author ?? "";
}

/**
 * `3` - how many hero buildings are selected, or `""` when none are.
 *
 * Not a building's name: see the module docstring for why. `group_thousands`
 * is harmless overkill at the twelve-hero cap and keeps this formatter the
 * same shape as `format_buildings`.
 */
export function format_hero(ctx: TokenContext): string {
  const count = Math.trunc(ctx.hero_count ?? 0);
  return count > 0 ? group_thousands(count) : "";
}

/**
 * token name -> formatter. A formatter returning null means "cannot be
 * expanded"; the token is then left in the text exactly as written.
 */
export const FORMATTERS: Record<string, (ctx: TokenContext) => string | null> = {
  city: format_city,
  lat: format_lat,
  lon: format_lon,
  coords: format_coords,
  scale: format_scale,
  radius: format_radius,
  date: format_date,
  buildings: format_buildings,
  country: format_country,
  state: format_state,
  neighbourhood: format_neighbourhood,
  author: format_author,
  hero: format_hero,
};

/**
 * Replace every known `{token}` in `text`; leave everything else alone.
 *
 * Nothing but the tokens is touched: no trimming, no case folding, no collapse
 * of the spaces around a token that expanded to "".
 */
export function expand_tokens(text: string, ctx: TokenContext): string {
  return text.replace(TOKEN_RE, (whole, name: string) => {
    const formatter = FORMATTERS[name];
    if (formatter === undefined) return whole;
    const value = formatter(ctx);
    return value === null ? whole : value;
  });
}

/** One token found in a `resolve_text` call, and whether it had anything to say. */
export interface TokenResolution {
  token: string;
  empty: boolean;
}

export interface ResolvedText {
  text: string;
  /** One entry per KNOWN token found, in the order it appears. An unknown
   *  `{brace}` is not tracked here (see `expand_tokens`'s own rule). */
  tokens: TokenResolution[];
}

/**
 * `expand_tokens`, plus a list of which known tokens had nothing to say.
 *
 * TS-only: this is how the editor decides an engraving line or the underside
 * template is EFFECTIVELY empty and names the exact token responsible ("the
 * {city} token has no value"), for the Issues badge and the Resolved output
 * panel (`lib/resolvedOutput.ts`). The bake never needs this - by the time a
 * string reaches `POST /bake` it is already fully resolved client-side
 * (DECISIONS [V3-P1]) - so it has no Python mirror and is not part of the
 * `tokens-expected.json` parity fixture.
 */
export function resolve_text(text: string, ctx: TokenContext): ResolvedText {
  const tokens: TokenResolution[] = [];
  const out = text.replace(TOKEN_RE, (whole, name: string) => {
    const formatter = FORMATTERS[name];
    if (formatter === undefined) return whole;
    const value = formatter(ctx);
    tokens.push({ token: name, empty: value === null || value === "" });
    return value === null ? whole : value;
  });
  return { text: out, tokens };
}
