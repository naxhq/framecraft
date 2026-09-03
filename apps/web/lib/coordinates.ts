/**
 * Raw coordinates typed into the search box, parsed LOCALLY -- no geocoder, no
 * network call, no waiting for a debounce to expire ([V3-P9]).
 *
 * Someone who already knows exactly where they want to be should not have to
 * ask a search server to find it for them, and the two notations people
 * actually paste are decimal degrees ("41.8827, -87.6233", straight out of a
 * map URL) and degrees-minutes-seconds ("41 deg 52' 57.7" N 87 deg 37' 23.9" W",
 * straight out of a survey or a photo's EXIF). Both are recognised here, with
 * or without hemisphere letters, with or without a comma, and in either order
 * when the first number cannot possibly be a latitude.
 *
 * The parser is a TOKENIZER, not one large regular expression: a coordinate is
 * a short, strictly ordered sequence of numbers, unit marks and hemisphere
 * letters, and anything else at all -- a street name that merely contains
 * digits, a house number, a postcode -- fails at the first character that is
 * not one of those tokens. That is what makes "Route 66" and "221B Baker
 * Street" rejections rather than half-parsed guesses, which a regular
 * expression scanning for numbers anywhere in the string could not promise.
 *
 * Two strategies run over the token list, decimal first:
 *
 *  1. DECIMAL -- each component is one number with optional hemisphere letters.
 *     "41 52" is two decimal degrees, not one DMS pair, because this runs first.
 *  2. DMS -- each component is degrees, then minutes, then optional seconds.
 *     Only reached when the decimal reading does not consume the whole input,
 *     which is exactly when unit marks or extra numbers are present.
 *
 * A strategy succeeds only when it yields EXACTLY TWO components and consumes
 * every token, so a stray third number ("41.8827, -87.6233, 5") is a rejection
 * rather than a silently truncated pair.
 */

/** Which notation the input was written in, for the row the search box shows. */
export type CoordinateFormat = "decimal" | "dms";

export interface ParsedCoordinates {
  lat: number;
  lon: number;
  format: CoordinateFormat;
  /**
   * True when the pair was written longitude first and swapped back, which
   * only happens when the leading number cannot be a latitude at all
   * (|value| > 90) and the trailing one can.
   */
  swapped: boolean;
}

export const LAT_LIMIT = 90;
export const LON_LIMIT = 180;

/** Decimal places kept when a parsed pair is shown back to the user. */
export const COORDINATE_DISPLAY_DECIMALS = 5;

type Hemisphere = "N" | "S" | "E" | "W";

type Token =
  | { kind: "number"; value: number; signed: boolean; integer: boolean }
  | { kind: "deg" }
  | { kind: "min" }
  /**
   * `south` marks the one genuinely ambiguous character in either notation: a
   * lowercase `s`, which is the seconds mark in "57.7s" and South in
   * "33.8688s". The tokenizer refuses to guess and the component readers
   * resolve it by POSITION: directly after a seconds number it is the mark,
   * anywhere a hemisphere letter could stand it is South. Uppercase `S` is
   * always South and is never given this flag.
   */
  | { kind: "sec"; south: boolean }
  | { kind: "hemi"; value: Hemisphere }
  | { kind: "separator" };

/** The hemisphere a token names, if it can name one. */
function asHemisphere(token: Token | undefined): Hemisphere | null {
  if (token === undefined) return null;
  if (token.kind === "hemi") return token.value;
  if (token.kind === "sec" && token.south) return "S";
  return null;
}

interface Component {
  degrees: number;
  minutes: number | null;
  seconds: number | null;
  hemisphere: Hemisphere | null;
  signed: boolean;
}

/**
 * Unicode variants people paste in place of the ASCII marks: the true prime
 * and double prime, curly quotes, the masculine ordinal and the ring above
 * (both commonly typed for a degree sign), and the real minus sign.
 */
function normalise(input: string): string {
  return input
    .replace(/[′’ʹ]/g, "'")
    .replace(/[″”ʺ]/g, '"')
    .replace(/[º˚̊]/g, "°")
    .replace(/[−–—]/g, "-")
    .replace(/[    ]/g, " ")
    .trim();
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

/**
 * The whole string -> tokens, or null the moment anything unrecognised turns
 * up. Case is significant for exactly one letter: a lowercase `s` is the
 * seconds mark ("57.7s") while an uppercase `S` is South, which is the only
 * collision in the alphabet these two notations share.
 */
function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;

  while (index < text.length) {
    const character = text[index];

    // A pair pasted out of a spreadsheet cell, a log line or a code literal
    // arrives wrapped in newlines, semicolons or brackets. None of those mean
    // anything inside a coordinate, so they are noise to skip rather than a
    // reason to send the whole string to a geocoder as free text.
    if (
      character === " " ||
      character === "\t" ||
      character === "\n" ||
      character === "\r" ||
      character === "(" ||
      character === ")" ||
      character === "[" ||
      character === "]"
    ) {
      index += 1;
      continue;
    }

    if (character === "," || character === ";") {
      tokens.push({ kind: "separator" });
      index += 1;
      continue;
    }

    if (character === "-" || character === "+" || isDigit(character) || character === ".") {
      const signed = character === "-" || character === "+";
      let end = signed ? index + 1 : index;
      const digitsStart = end;
      while (end < text.length && (isDigit(text[end]) || text[end] === ".")) end += 1;
      const raw = text.slice(digitsStart, end);
      // A lone sign, a lone dot, or something like "1.2.3" is not a number.
      if (raw === "" || !/^\d*(?:\.\d+)?$/.test(raw) || !/\d/.test(raw)) return null;
      const magnitude = Number(raw);
      if (!Number.isFinite(magnitude)) return null;
      tokens.push({
        kind: "number",
        value: character === "-" ? -magnitude : magnitude,
        signed,
        integer: !raw.includes("."),
      });
      index = end;
      continue;
    }

    if (character === "°") {
      tokens.push({ kind: "deg" });
      index += 1;
      continue;
    }

    if (character === "'") {
      // Two apostrophes are a common stand-in for the double prime.
      if (text[index + 1] === "'") {
        tokens.push({ kind: "sec", south: false });
        index += 2;
        continue;
      }
      tokens.push({ kind: "min" });
      index += 1;
      continue;
    }

    if (character === '"') {
      tokens.push({ kind: "sec", south: false });
      index += 1;
      continue;
    }

    const rest = text.slice(index);
    if (/^deg\b/i.test(rest) || /^degrees\b/i.test(rest)) {
      tokens.push({ kind: "deg" });
      index += /^degrees\b/i.test(rest) ? 7 : 3;
      continue;
    }
    if (/^min\b/i.test(rest)) {
      tokens.push({ kind: "min" });
      index += 3;
      continue;
    }
    if (/^sec\b/i.test(rest)) {
      tokens.push({ kind: "sec", south: false });
      index += 3;
      continue;
    }

    if (character === "d" || character === "D") {
      tokens.push({ kind: "deg" });
      index += 1;
      continue;
    }
    if (character === "m" || character === "M") {
      tokens.push({ kind: "min" });
      index += 1;
      continue;
    }
    if (character === "s") {
      // Ambiguous: seconds or South. `asHemisphere` and the component readers
      // decide by position, which is what lets "33.8688s, 151.2093e" parse
      // while "41d52m57.7sN" keeps reading the s as the seconds mark.
      tokens.push({ kind: "sec", south: true });
      index += 1;
      continue;
    }

    if (character === "N" || character === "n") {
      tokens.push({ kind: "hemi", value: "N" });
      index += 1;
      continue;
    }
    if (character === "S") {
      tokens.push({ kind: "hemi", value: "S" });
      index += 1;
      continue;
    }
    if (character === "E" || character === "e") {
      tokens.push({ kind: "hemi", value: "E" });
      index += 1;
      continue;
    }
    if (character === "W" || character === "w") {
      tokens.push({ kind: "hemi", value: "W" });
      index += 1;
      continue;
    }

    return null;
  }

  return tokens;
}

/** Skip any run of commas between two components (and refuse a leading one). */
function skipSeparators(tokens: readonly Token[], from: number): number {
  let index = from;
  while (index < tokens.length && tokens[index].kind === "separator") index += 1;
  return index;
}

interface Reading {
  component: Component;
  next: number;
}

/** One decimal component: an optional hemisphere, a number, an optional hemisphere. */
function readDecimal(tokens: readonly Token[], from: number): Reading | null {
  let index = from;
  let hemisphere: Hemisphere | null = null;

  const leading = asHemisphere(tokens[index]);
  if (leading !== null) {
    hemisphere = leading;
    index += 1;
  }

  const number = tokens[index];
  if (number === undefined || number.kind !== "number") return null;
  index += 1;

  // A trailing letter is only this component's when no leading one claimed it
  // already: in "N 41.8827 W 87.6233" the W introduces the NEXT component.
  const trailing = hemisphere === null ? asHemisphere(tokens[index]) : null;
  if (trailing !== null) {
    hemisphere = trailing;
    index += 1;
  }

  // A degree mark on a decimal value ("41.8827 deg") is still decimal.
  const mark = tokens[index];
  if (mark !== undefined && mark.kind === "deg") index += 1;

  return {
    component: {
      degrees: number.value,
      minutes: null,
      seconds: null,
      hemisphere,
      signed: number.signed,
    },
    next: index,
  };
}

/**
 * One DMS component: an optional hemisphere, degrees, an optional degree mark,
 * minutes, an optional minute mark, optional seconds and second mark, an
 * optional hemisphere.
 *
 * Minutes and seconds must be unsigned and under 60, which is what stops
 * "41.8827 -87.6233" from being read as 41 degrees and -87 minutes, and
 * "41 deg 99' N" from being read at all.
 */
function readDms(tokens: readonly Token[], from: number): Reading | null {
  let index = from;
  let hemisphere: Hemisphere | null = null;

  const leading = asHemisphere(tokens[index]);
  if (leading !== null) {
    hemisphere = leading;
    index += 1;
  }

  const degrees = tokens[index];
  if (degrees === undefined || degrees.kind !== "number") return null;
  index += 1;

  let sawDegreeMark = false;
  const degreeMark = tokens[index];
  if (degreeMark !== undefined && degreeMark.kind === "deg") {
    sawDegreeMark = true;
    index += 1;
  }

  // Without a degree mark the degrees have to be a whole number, or this is a
  // decimal value that happens to be followed by another one.
  if (!sawDegreeMark && !degrees.integer) return null;

  const minutes = tokens[index];
  if (
    minutes === undefined ||
    minutes.kind !== "number" ||
    minutes.signed ||
    minutes.value >= 60
  ) {
    return null;
  }
  index += 1;

  const minuteMark = tokens[index];
  if (minuteMark !== undefined && minuteMark.kind === "min") index += 1;

  let seconds: number | null = null;
  const secondsToken = tokens[index];
  if (
    secondsToken !== undefined &&
    secondsToken.kind === "number" &&
    !secondsToken.signed &&
    secondsToken.value < 60
  ) {
    seconds = secondsToken.value;
    index += 1;
    const secondMark = tokens[index];
    if (secondMark !== undefined && secondMark.kind === "sec") index += 1;
  }

  // Reached only when the seconds branch above did NOT consume this token, so
  // an ambiguous lowercase `s` standing here is South rather than the mark.
  const trailing = hemisphere === null ? asHemisphere(tokens[index]) : null;
  if (trailing !== null) {
    hemisphere = trailing;
    index += 1;
  }

  return {
    component: {
      degrees: degrees.value,
      minutes: minutes.value,
      seconds,
      hemisphere,
      signed: degrees.signed,
    },
    next: index,
  };
}

/** Run one component reader across the whole token list; exactly two or nothing. */
function readPair(
  tokens: readonly Token[],
  read: (tokens: readonly Token[], from: number) => Reading | null,
): [Component, Component] | null {
  const components: Component[] = [];
  let index = skipSeparators(tokens, 0);
  // A leading comma is malformed input, not an empty first component.
  if (index !== 0) return null;

  while (index < tokens.length) {
    const reading = read(tokens, index);
    if (reading === null) return null;
    components.push(reading.component);
    if (components.length > 2) return null;
    index = skipSeparators(tokens, reading.next);
  }

  if (components.length !== 2) return null;
  return [components[0], components[1]];
}

/** Degrees + minutes/60 + seconds/3600, magnitude only; the sign comes later. */
function componentMagnitude(component: Component): number {
  const degrees = Math.abs(component.degrees);
  const minutes = component.minutes ?? 0;
  const seconds = component.seconds ?? 0;
  return degrees + minutes / 60 + seconds / 3600;
}

function isLatitudeLetter(hemisphere: Hemisphere): boolean {
  return hemisphere === "N" || hemisphere === "S";
}

/**
 * A typed minus sign against a hemisphere letter that means the opposite
 * direction. "-41.8827 N" is not a coordinate anyone meant: the two halves of
 * it disagree, and picking either one silently puts the pin about 9200 km from
 * where the user was aiming. A reading that contradicts itself is refused.
 *
 * A sign that AGREES with its letter ("-33.8688 S", "-87.6233 W") is fine and
 * is the common way people paste a southern or western value with its letter
 * still attached.
 */
function contradicts(component: Component): boolean {
  if (component.hemisphere === null) return false;
  if (component.degrees >= 0) return false;
  return component.hemisphere === "N" || component.hemisphere === "E";
}

function signedValue(component: Component): number {
  const magnitude = componentMagnitude(component);
  if (component.hemisphere !== null) {
    // The letter is authoritative wherever it does not contradict the sign:
    // "-33.8688 S" and "33.8688 S" both mean the same southern latitude.
    return component.hemisphere === "S" || component.hemisphere === "W" ? -magnitude : magnitude;
  }
  return component.degrees < 0 ? -magnitude : magnitude;
}

/**
 * Two components -> every (lat, lon) pair the text can honestly mean, best
 * reading first.
 *
 * Hemisphere letters decide the roles outright when they are present, and two
 * letters naming the same axis ("41N 52N") are a contradiction rather than a
 * guess. Without letters the pair is ambiguous whenever both numbers are
 * within +/-90, because a map URL writes latitude first and a GeoJSON
 * coordinate writes longitude first, and NOTHING in the text distinguishes
 * them. Rather than pick one silently and move the pin to the wrong
 * hemisphere, both readings are returned -- latitude first, which is what
 * consumer maps produce, then longitude first -- and the search box offers
 * them as two rows, the way openstreetmap.org's own search does. When only
 * one reading is in range (a leading value past 90 cannot be a latitude at
 * all) there is nothing to choose and exactly one row appears.
 */
function placements(
  first: Component,
  second: Component,
): Array<{ lat: number; lon: number; swapped: boolean }> {
  if (contradicts(first) || contradicts(second)) return [];
  const firstValue = signedValue(first);
  const secondValue = signedValue(second);

  const firstAxis = first.hemisphere === null ? null : isLatitudeLetter(first.hemisphere);
  const secondAxis = second.hemisphere === null ? null : isLatitudeLetter(second.hemisphere);

  if (firstAxis !== null && secondAxis !== null && firstAxis === secondAxis) return [];

  const out: Array<{ lat: number; lon: number; swapped: boolean }> = [];
  const offer = (lat: number, lon: number, swapped: boolean): void => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (Math.abs(lat) > LAT_LIMIT || Math.abs(lon) > LON_LIMIT) return;
    out.push({ lat, lon, swapped });
  };

  if (firstAxis === true || secondAxis === false) {
    offer(firstValue, secondValue, false);
    return out;
  }
  if (firstAxis === false || secondAxis === true) {
    offer(secondValue, firstValue, true);
    return out;
  }

  offer(firstValue, secondValue, false);
  if (firstValue !== secondValue) offer(secondValue, firstValue, true);
  return out;
}

/**
 * A typed query -> every coordinate reading it supports, best first, or an
 * empty list when it names none.
 *
 * Never throws and never fetches: this is the one search path that answers
 * before the debounce has even started.
 */
export function coordinateReadings(input: string): ParsedCoordinates[] {
  const text = normalise(input);
  if (text === "") return [];

  const tokens = tokenize(text);
  if (tokens === null || tokens.length === 0) return [];

  const decimal = readPair(tokens, readDecimal);
  if (decimal !== null) {
    return placements(decimal[0], decimal[1]).map((placed) => ({
      ...placed,
      format: "decimal" as const,
    }));
  }

  const dms = readPair(tokens, readDms);
  if (dms !== null) {
    return placements(dms[0], dms[1]).map((placed) => ({ ...placed, format: "dms" as const }));
  }

  return [];
}

/** The best reading of `input`, or null when it names no coordinates at all. */
export function parseCoordinates(input: string): ParsedCoordinates | null {
  return coordinateReadings(input)[0] ?? null;
}

/** "41.88270, -87.62330": the parsed pair, written back the way it will be stored. */
export function formatCoordinates(lat: number, lon: number): string {
  return `${lat.toFixed(COORDINATE_DISPLAY_DECIMALS)}, ${lon.toFixed(COORDINATE_DISPLAY_DECIMALS)}`;
}
