/**
 * The local coordinate parser ([V3-P9]).
 *
 * A table of 40 inputs -- 25 that must parse and 15 that must be refused --
 * because this is the one search path with no server to correct it: whatever
 * it answers is where the pin goes, and whatever it refuses falls through to
 * Photon as free text. Both mistakes are silent, so both directions are
 * pinned here rather than spot-checked.
 */

import { describe, expect, it } from "vitest";

import {
  COORDINATE_DISPLAY_DECIMALS,
  coordinateReadings,
  formatCoordinates,
  parseCoordinates,
  type CoordinateFormat,
} from "./coordinates";

/** 41 deg 52' 57.7" N is this many decimal degrees. */
const CHICAGO_LAT = 41 + 52 / 60 + 57.7 / 3600;
/** 87 deg 37' 23.9" W. */
const CHICAGO_LON = -(87 + 37 / 60 + 23.9 / 3600);

interface AcceptedCase {
  input: string;
  lat: number;
  lon: number;
  format: CoordinateFormat;
  swapped?: boolean;
  why: string;
}

const ACCEPTED: AcceptedCase[] = [
  {
    input: "41.8827, -87.6233",
    lat: 41.8827,
    lon: -87.6233,
    format: "decimal",
    why: "the plain comma-separated pair every map URL yields",
  },
  {
    input: "41.8827 -87.6233",
    lat: 41.8827,
    lon: -87.6233,
    format: "decimal",
    why: "a space is as good a separator as a comma",
  },
  {
    input: "   41.8827  ,   -87.6233   ",
    lat: 41.8827,
    lon: -87.6233,
    format: "decimal",
    why: "leading, trailing and interior whitespace is noise",
  },
  {
    input: "41.8827,-87.6233",
    lat: 41.8827,
    lon: -87.6233,
    format: "decimal",
    why: "no space after the comma",
  },
  {
    input: "-117.1611, 32.7157",
    lat: 32.7157,
    lon: -117.1611,
    format: "decimal",
    swapped: true,
    why: "longitude first is the only reading left once -117.1611 is out of latitude range",
  },
  {
    input: "+41.8827, +87.6233",
    lat: 41.8827,
    lon: 87.6233,
    format: "decimal",
    why: "an explicit plus sign is allowed on both",
  },
  {
    input: "41.8827N, 87.6233W",
    lat: 41.8827,
    lon: -87.6233,
    format: "decimal",
    why: "trailing hemisphere letters, no minus signs",
  },
  {
    input: "N 41.8827 W 87.6233",
    lat: 41.8827,
    lon: -87.6233,
    format: "decimal",
    why: "leading hemisphere letters",
  },
  {
    input: "87.6233W, 41.8827N",
    lat: 41.8827,
    lon: -87.6233,
    format: "decimal",
    swapped: true,
    why: "the letters place the pair, whatever order it was typed in",
  },
  {
    input: "41.8827, 87.6233E",
    lat: 41.8827,
    lon: 87.6233,
    format: "decimal",
    why: "one letter is enough to fix both roles",
  },
  {
    input: "-33.8688, 151.2093",
    lat: -33.8688,
    lon: 151.2093,
    format: "decimal",
    why: "a southern latitude with a longitude past 90",
  },
  {
    input: "-33.8688 S, 151.2093 E",
    lat: -33.8688,
    lon: 151.2093,
    format: "decimal",
    why: "a typed minus sign and a matching S mean the same thing, not a double negative",
  },
  {
    input: "0, 0",
    lat: 0,
    lon: 0,
    format: "decimal",
    why: "Null Island is a real answer, not an empty one",
  },
  {
    input: "90, 180",
    lat: 90,
    lon: 180,
    format: "decimal",
    why: "both limits inclusive",
  },
  {
    input: "-90, -180",
    lat: -90,
    lon: -180,
    format: "decimal",
    why: "both limits inclusive at the other end",
  },
  {
    input: "41 52",
    lat: 41,
    lon: 52,
    format: "decimal",
    why: "two whole numbers read as decimal degrees, not as degrees and minutes",
  },
  {
    input: "95, 20",
    lat: 20,
    lon: 95,
    format: "decimal",
    swapped: true,
    why: "95 cannot be a latitude and 20 can, so the pair is longitude first",
  },
  {
    input: "41.8827°, -87.6233°",
    lat: 41.8827,
    lon: -87.6233,
    format: "decimal",
    why: "a degree sign on a decimal value is still a decimal value",
  },
  {
    input: "−41.8827, −87.6233",
    lat: -41.8827,
    lon: -87.6233,
    format: "decimal",
    why: "the real minus sign, which is what a word processor produces",
  },
  {
    input: "41°52'57.7\"N 87°37'23.9\"W",
    lat: CHICAGO_LAT,
    lon: CHICAGO_LON,
    format: "dms",
    why: "the canonical degrees-minutes-seconds spelling",
  },
  {
    input: "41 52 57.7 N 87 37 23.9 W",
    lat: CHICAGO_LAT,
    lon: CHICAGO_LON,
    format: "dms",
    why: "the same pair with spaces where the marks would be",
  },
  {
    input: "41d52m57.7sN 87d37m23.9sW",
    lat: CHICAGO_LAT,
    lon: CHICAGO_LON,
    format: "dms",
    why: "d, m and s letters instead of the marks",
  },
  {
    input: "41° 52' 57.7\" N, 87° 37' 23.9\" W",
    lat: CHICAGO_LAT,
    lon: CHICAGO_LON,
    format: "dms",
    why: "spaced marks with a comma between the two components",
  },
  {
    input: "41°52'N 87°37'W",
    lat: 41 + 52 / 60,
    lon: -(87 + 37 / 60),
    format: "dms",
    why: "degrees and minutes with the seconds left off",
  },
  {
    input: "48°51′24″N 2°21′08″E",
    lat: 48 + 51 / 60 + 24 / 3600,
    lon: 2 + 21 / 60 + 8 / 3600,
    format: "dms",
    why: "true prime and double prime, which is what Wikipedia copies as",
  },
  {
    input: "33.8688s, 151.2093e",
    lat: -33.8688,
    lon: 151.2093,
    format: "decimal",
    why: "a lowercase s is South here, not a seconds mark: the southern hemisphere types in lowercase too",
  },
  {
    input: "s 33.8688 e 151.2093",
    lat: -33.8688,
    lon: 151.2093,
    format: "decimal",
    why: "a leading lowercase s, where a seconds mark can never stand",
  },
  {
    input: "34.05s 18.42e",
    lat: -34.05,
    lon: 18.42,
    format: "decimal",
    why: "Cape Town, lowercase, no comma",
  },
  {
    input: "33°52's 151°12'e",
    lat: -(33 + 52 / 60),
    lon: 151 + 12 / 60,
    format: "dms",
    why: "a lowercase s after MINUTES with no seconds number is still South",
  },
  {
    input: "41.8827\n-87.6233",
    lat: 41.8827,
    lon: -87.6233,
    format: "decimal",
    why: "two spreadsheet cells pasted as two lines",
  },
  {
    input: "41.8827;-87.6233",
    lat: 41.8827,
    lon: -87.6233,
    format: "decimal",
    why: "a semicolon separator, which is what a locale using the decimal comma exports",
  },
  {
    input: "(41.8827, -87.6233)",
    lat: 41.8827,
    lon: -87.6233,
    format: "decimal",
    why: "a tuple copied out of a code literal",
  },
  {
    input: "[41.8827, -87.6233]",
    lat: 41.8827,
    lon: -87.6233,
    format: "decimal",
    why: "a JSON array copied out of a log line",
  },
];

interface RejectedCase {
  input: string;
  why: string;
}

const REJECTED: RejectedCase[] = [
  { input: "", why: "an empty box is not a coordinate" },
  { input: "   ", why: "whitespace only" },
  { input: "Chicago", why: "a place name with no digits at all" },
  { input: "41.8827", why: "one number is half a pair" },
  { input: "-87.6233", why: "one number, negative, still half a pair" },
  { input: "Route 66", why: "text that merely contains a number" },
  { input: "221B Baker Street", why: "a house number in an address" },
  { input: "1600 Pennsylvania Ave NW", why: "an address ending in compass letters" },
  { input: "Sector 7", why: "a word followed by a digit" },
  { input: "91, 181", why: "both values out of range" },
  { input: "41.8827, 200", why: "a longitude past 180, with no swap that rescues it" },
  { input: "-95, -200", why: "both out of range and negative" },
  { input: "41.8827, -87.6233, 5", why: "a third component" },
  { input: "1,2,3", why: "three whole numbers" },
  { input: "41°52'57.7\"N", why: "one DMS component with no partner" },
  { input: "41 52 57.7 N", why: "one spaced DMS component with no partner" },
  { input: "41°99'N 87°37'W", why: "99 minutes is not a minute value" },
  { input: "41N 52N", why: "two latitudes and no longitude" },
  { input: "12E 15W", why: "two longitudes and no latitude" },
  { input: ", 41.8827, -87.6233", why: "a leading separator is malformed, not an empty first value" },
  { input: "41.8.8, -87.6", why: "a number with two decimal points" },
  { input: "12:30", why: "a clock time, not a coordinate" },
  {
    input: "-41.8827 N, 87.6233 W",
    why: "a typed minus against a northern letter contradicts itself, 9200 km apart",
  },
  {
    input: "41.8827 N, -87.6233 E",
    why: "the same contradiction on the longitude",
  },
  {
    input: "41,8827 -87,6233",
    why: "the European decimal comma, which reads as four numbers and must stay rejected",
  },
  { input: "lat 41.88 lon -87.62", why: "labelled values are prose, not a coordinate" },
  { input: "()", why: "brackets with nothing inside them" },
];

describe("parseCoordinates", () => {
  it.each(ACCEPTED)("accepts $input ($why)", ({ input, lat, lon, format, swapped }) => {
    const parsed = parseCoordinates(input);
    expect(parsed, `expected ${input} to parse`).not.toBeNull();
    expect(parsed?.lat).toBeCloseTo(lat, 9);
    expect(parsed?.lon).toBeCloseTo(lon, 9);
    expect(parsed?.format).toBe(format);
    expect(parsed?.swapped).toBe(swapped ?? false);
  });

  it.each(REJECTED)("refuses $input ($why)", ({ input }) => {
    expect(parseCoordinates(input)).toBeNull();
  });

  it("covers at least 25 inputs across both directions", () => {
    // The brief's floor, asserted rather than trusted to a reader's count.
    expect(ACCEPTED.length + REJECTED.length).toBeGreaterThanOrEqual(25);
    expect(ACCEPTED.length).toBeGreaterThanOrEqual(10);
    expect(REJECTED.length).toBeGreaterThanOrEqual(10);
  });

  it("never throws on hostile input", () => {
    for (const input of [" ", "()".repeat(500), "9".repeat(400), "N".repeat(50)]) {
      expect(() => parseCoordinates(input)).not.toThrow();
    }
  });
});

describe("coordinateReadings", () => {
  it("offers both orders when nothing in the text distinguishes them", () => {
    // The brief's own longitude-first example. Both numbers are inside +/-90,
    // so "-87.6233" is a perfectly legal latitude and picking one order
    // silently would send the pin to the wrong hemisphere half the time.
    const readings = coordinateReadings("-87.6233, 41.8827");
    expect(readings).toHaveLength(2);
    expect(readings[0]).toMatchObject({ lat: -87.6233, lon: 41.8827, swapped: false });
    expect(readings[1]).toMatchObject({ lat: 41.8827, lon: -87.6233, swapped: true });
  });

  it("offers one reading when a hemisphere letter fixes the roles", () => {
    expect(coordinateReadings("87.6233W, 41.8827N")).toHaveLength(1);
    expect(coordinateReadings("41.8827N, 87.6233W")).toHaveLength(1);
  });

  it("offers one reading when only one order is in range", () => {
    expect(coordinateReadings("-117.1611, 32.7157")).toHaveLength(1);
    expect(coordinateReadings("-33.8688, 151.2093")).toHaveLength(1);
  });

  it("offers one reading when the two numbers are the same", () => {
    expect(coordinateReadings("12, 12")).toHaveLength(1);
  });

  it("is empty for anything it refuses, never a partial pair", () => {
    for (const input of REJECTED) {
      expect(coordinateReadings(input.input), input.input).toEqual([]);
    }
  });
});

describe("formatCoordinates", () => {
  it("writes both values to the display precision", () => {
    expect(formatCoordinates(41.8827, -87.6233)).toBe("41.88270, -87.62330");
    expect(COORDINATE_DISPLAY_DECIMALS).toBe(5);
  });

  it("keeps a zero signed the way it was given", () => {
    expect(formatCoordinates(0, 0)).toBe("0.00000, 0.00000");
  });
});
