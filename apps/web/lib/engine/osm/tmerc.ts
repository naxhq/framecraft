/**
 * WGS84 ellipsoidal Transverse Mercator, Krüger's n-series to order n^6
 * (Karney 2011, "Transverse Mercator with an accuracy of a few nanometers").
 * This is the same series PROJ's `etmerc` (PROJ's default UTM engine since
 * v5, what `pyproj.Transformer` uses for `EPSG:326xx`/`EPSG:327xx`) computes,
 * so a correct implementation should agree with `services/bake/app/geom/
 * project.py` (pyproj) to nanometers, i.e. identically after the 1 mm
 * SceneGraph emission grid. `project.ts` pins a handful of coordinates against
 * Python-computed reference values.
 *
 * Never used for anything but this engine's own local ENU frame; there is no
 * general-purpose CRS support here.
 */

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const UTM_K0 = 0.9996;

const N = WGS84_F / (2 - WGS84_F); // third flattening

// Meridian radius scale factor A = a/(1+n) * (1 + n^2/4 + n^4/64 + n^6/256).
const MERIDIAN_A =
  (WGS84_A / (1 + N)) * (1 + (N * N) / 4 + (N ** 4) / 64 + (N ** 6) / 256);

// Forward series coefficients alpha_1..alpha_6 (n^1..n^6).
const ALPHA = [
  N / 2 - (2 / 3) * N ** 2 + (5 / 16) * N ** 3 + (41 / 180) * N ** 4 - (127 / 288) * N ** 5 + (7891 / 37800) * N ** 6,
  (13 / 48) * N ** 2 - (3 / 5) * N ** 3 + (557 / 1440) * N ** 4 + (281 / 630) * N ** 5 - (1983433 / 1935360) * N ** 6,
  (61 / 240) * N ** 3 - (103 / 140) * N ** 4 + (15061 / 26880) * N ** 5 + (167603 / 181440) * N ** 6,
  (49561 / 161280) * N ** 4 - (179 / 168) * N ** 5 + (6601661 / 7257600) * N ** 6,
  (34729 / 80640) * N ** 5 - (3418889 / 1995840) * N ** 6,
  (212378941 / 319334400) * N ** 6,
];

// Inverse series coefficients beta_1..beta_6.
const BETA = [
  N / 2 - (2 / 3) * N ** 2 + (37 / 96) * N ** 3 - (1 / 360) * N ** 4 - (81 / 512) * N ** 5 + (96199 / 604800) * N ** 6,
  (1 / 48) * N ** 2 + (1 / 15) * N ** 3 - (437 / 1440) * N ** 4 + (46 / 105) * N ** 5 - (1118711 / 3870720) * N ** 6,
  (17 / 480) * N ** 3 - (37 / 840) * N ** 4 - (209 / 4480) * N ** 5 + (5569 / 90720) * N ** 6,
  (4397 / 161280) * N ** 4 - (11 / 504) * N ** 5 - (830251 / 7257600) * N ** 6,
  (4583 / 161280) * N ** 5 - (108847 / 3991680) * N ** 6,
  (20648693 / 638668800) * N ** 6,
];

// Conformal-to-geographic latitude series coefficients delta_1..delta_6.
const DELTA = [
  2 * N - (2 / 3) * N ** 2 - 2 * N ** 3 + (116 / 45) * N ** 4 + (26 / 45) * N ** 5 - (2854 / 675) * N ** 6,
  (7 / 3) * N ** 2 - (8 / 5) * N ** 3 - (227 / 45) * N ** 4 + (2704 / 315) * N ** 5 + (2323 / 945) * N ** 6,
  (56 / 15) * N ** 3 - (136 / 35) * N ** 4 - (1262 / 105) * N ** 5 + (73814 / 2835) * N ** 6,
  (4279 / 630) * N ** 4 - (332 / 35) * N ** 5 - (399572 / 14175) * N ** 6,
  (4174 / 315) * N ** 5 - (144838 / 6237) * N ** 6,
  (601676 / 22275) * N ** 6,
];

function asinh(x: number): number {
  return Math.log(x + Math.sqrt(x * x + 1));
}

function atanh(x: number): number {
  return 0.5 * Math.log((1 + x) / (1 - x));
}

export interface UtmZone {
  epsg: number;
  centralMeridianDeg: number;
  falseNorthing: number;
}

/** UTM zone number (1..60) for a longitude in degrees, matching `project.py:utm_zone`. */
export function utmZoneNumber(lonDeg: number): number {
  return (((Math.floor((lonDeg + 180.0) / 6.0) % 60) + 60) % 60) + 1;
}

/** EPSG code of the WGS84/UTM zone containing (lat, lon), matching `project.py:utm_epsg`. */
export function utmZoneFor(latDeg: number, lonDeg: number): UtmZone {
  const zone = utmZoneNumber(lonDeg);
  const epsg = (latDeg >= 0.0 ? 32600 : 32700) + zone;
  const centralMeridianDeg = zone * 6 - 183;
  return { epsg, centralMeridianDeg, falseNorthing: latDeg >= 0.0 ? 0.0 : 10_000_000.0 };
}

const FALSE_EASTING = 500_000.0;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** WGS84 lat/lon (degrees) -> UTM easting/northing (meters) for a given zone. */
export function utmForward(latDeg: number, lonDeg: number, zone: UtmZone): [number, number] {
  const phi = latDeg * DEG2RAD;
  const lambda = (lonDeg - zone.centralMeridianDeg) * DEG2RAD;

  const sinPhi = Math.sin(phi);
  const sqrtN = Math.sqrt(N);
  const c = (2 * sqrtN) / (1 + N);
  const t = Math.sinh(atanh(sinPhi) - c * atanh(c * sinPhi));

  const cosLambda = Math.cos(lambda);
  const sinLambda = Math.sin(lambda);
  const xiP = Math.atan2(t, cosLambda);
  const etaP = asinh(sinLambda / Math.sqrt(t * t + cosLambda * cosLambda));

  let xi = xiP;
  let eta = etaP;
  for (let j = 1; j <= 6; j++) {
    const a = ALPHA[j - 1];
    xi += a * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
    eta += a * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
  }

  const easting = FALSE_EASTING + UTM_K0 * MERIDIAN_A * eta;
  const northing = zone.falseNorthing + UTM_K0 * MERIDIAN_A * xi;
  return [easting, northing];
}

/** UTM easting/northing (meters) -> WGS84 lat/lon (degrees) for a given zone. */
export function utmInverse(easting: number, northing: number, zone: UtmZone): [number, number] {
  const xi = (northing - zone.falseNorthing) / (UTM_K0 * MERIDIAN_A);
  const eta = (easting - FALSE_EASTING) / (UTM_K0 * MERIDIAN_A);

  let xiP = xi;
  let etaP = eta;
  for (let j = 1; j <= 6; j++) {
    const b = BETA[j - 1];
    xiP -= b * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= b * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }

  const chi = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
  const lambda = Math.atan2(Math.sinh(etaP), Math.cos(xiP));

  let phi = chi;
  for (let j = 1; j <= 6; j++) {
    phi += DELTA[j - 1] * Math.sin(2 * j * chi);
  }

  const lonDeg = zone.centralMeridianDeg + lambda * RAD2DEG;
  const latDeg = phi * RAD2DEG;
  return [latDeg, lonDeg];
}
