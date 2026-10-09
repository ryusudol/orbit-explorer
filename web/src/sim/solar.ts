// Where the Moon and Mars are, and which way they face: compact analytic
// models, good to a few arcminutes over this century, which is far below what
// the scene can show (the Moon's disc is 31′ across from Earth).
//
// Frame: the scene's equatorial frame of date (the engine's TEME, to the 0.01°
// of nutation that separates the two). JPL's trajectories and the IAU rotation
// models are in ICRF (J2000), so they are precessed to date with `precession`.
//
// References
//   Moon      Montenbruck & Pfleger, Astronomy on the Personal Computer (MiniMoon),
//             plus the 13 largest distance terms of Meeus, Astronomical Algorithms, table 47.A
//   Planets   E. M. Standish, Keplerian Elements for Approximate Positions of the
//             Major Planets (JPL SSD, table 1, 1800–2050)
//   Rotation  Archinal et al. 2011, Report of the IAU Working Group on Cartographic
//             Coordinates and Rotational Elements: 2009 (Moon: mean Earth/polar axis frame)

const DEG = Math.PI / 180;
const ARCSEC = DEG / 3600;
export const AU_KM = 149_597_870.7;
export const C_KMS = 299_792.458;
const J2000 = 2451545.0;
/** TT − UTC since 2017 (TAI − UTC = 37 s, TT − TAI = 32.184 s). */
const TT_MINUS_UTC_DAYS = 69.184 / 86400;

export type Vec3 = [number, number, number];
/** Row-major 3x3 matrix. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

const frac = (x: number) => x - Math.floor(x);
export const mul = (m: Mat3, v: Vec3): Vec3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
export const mulMat = (a: Mat3, b: Mat3): Mat3 => {
  const o = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[3 * i + j] += a[3 * i + k] * b[3 * k + j];
  return o;
};
export const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const rotX = (a: number): Mat3 => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const rotY = (a: number): Mat3 => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const rotZ = (a: number): Mat3 => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];

/** Julian centuries of TT since J2000, from a UTC Julian date. */
const centuries = (jdUtc: number) => (jdUtc + TT_MINUS_UTC_DAYS - J2000) / 36525;

/**
 * ICRF (J2000 mean equator and equinox) -> mean equator and equinox of date
 * (IAU 1976 precession, Lieske 1977). About 0.36° in 2026.
 */
export function precession(jdUtc: number): Mat3 {
  const T = centuries(jdUtc);
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T ** 3) * ARCSEC;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T ** 3) * ARCSEC;
  const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T ** 3) * ARCSEC;
  return mulMat(rotZ(z), mulMat(rotY(-theta), rotZ(zeta)));
}

/** Mean obliquity of the ecliptic of date. */
const obliquity = (T: number) => (23.43929111 - (46.815 * T) / 3600) * DEG;

/** Geocentric Moon (km, equatorial of date). Error ≲ 2′ in direction, ≲ 30 km in distance. */
export function moonGeocentric(jdUtc: number): Vec3 {
  const T = centuries(jdUtc);
  const L0 = frac(0.606433 + 1336.855225 * T); // mean longitude (revolutions)
  const l = 2 * Math.PI * frac(0.374897 + 1325.55241 * T); // Moon's mean anomaly
  const ls = 2 * Math.PI * frac(0.993133 + 99.997361 * T); // Sun's mean anomaly
  const D = 2 * Math.PI * frac(0.827361 + 1236.853086 * T); // mean elongation
  const F = 2 * Math.PI * frac(0.259086 + 1342.227825 * T); // argument of latitude
  const sin = Math.sin, cos = Math.cos;
  const dL =
    22640 * sin(l) - 4586 * sin(l - 2 * D) + 2370 * sin(2 * D) + 769 * sin(2 * l) - 668 * sin(ls) - 412 * sin(2 * F) - 212 * sin(2 * l - 2 * D) -
    206 * sin(l + ls - 2 * D) + 192 * sin(l + 2 * D) - 165 * sin(ls - 2 * D) - 125 * sin(D) - 110 * sin(l + ls) + 148 * sin(l - ls) - 55 * sin(2 * F - 2 * D);
  const S = F + (dL + 412 * sin(2 * F) + 541 * sin(ls)) * ARCSEC;
  const h = F - 2 * D;
  const N = -526 * sin(h) + 44 * sin(l + h) - 31 * sin(-l + h) - 23 * sin(ls + h) + 11 * sin(-ls + h) - 25 * sin(-2 * l + F) + 21 * sin(-l + F);
  const lon = 2 * Math.PI * frac(L0 + dL / 1296e3);
  const lat = (18520 * sin(S) + N) * ARCSEC;
  // Meeus 47.A, distance terms over 0.1 km (D, M, M', F multipliers)
  const r =
    385000.56 -
    20905.355 * cos(l) -
    3699.111 * cos(2 * D - l) -
    2955.968 * cos(2 * D) -
    569.925 * cos(2 * l) +
    48.888 * cos(ls) -
    3.149 * cos(2 * F) +
    246.158 * cos(2 * D - 2 * l) -
    152.138 * cos(2 * D - ls - l) -
    170.733 * cos(2 * D + l) -
    204.586 * cos(2 * D - ls) -
    129.62 * cos(ls - l) +
    108.743 * cos(D) +
    104.755 * cos(ls + l) +
    10.321 * cos(2 * D - 2 * F) +
    79.661 * cos(l - 2 * F) -
    34.782 * cos(4 * D - l) -
    23.21 * cos(3 * l) -
    21.636 * cos(4 * D - 2 * l) +
    24.208 * cos(2 * D + ls - l) +
    30.824 * cos(2 * D + ls) -
    8.379 * cos(D - l) -
    16.675 * cos(D + ls) -
    12.831 * cos(2 * D - ls + l) -
    10.445 * cos(2 * D + 2 * l) -
    11.65 * cos(4 * D) +
    14.403 * cos(2 * D - 3 * l) -
    7.003 * cos(ls - 2 * l) +
    10.056 * cos(2 * D - ls - 2 * l) +
    6.322 * cos(D + l) -
    9.884 * cos(2 * D - 2 * ls);
  const ecl: Vec3 = [r * cos(lat) * cos(lon), r * cos(lat) * sin(lon), r * sin(lat)];
  return mul(rotX(obliquity(T)), ecl);
}

interface Elements {
  a: [number, number];
  e: [number, number];
  I: [number, number];
  L: [number, number];
  peri: [number, number];
  node: [number, number];
}
// Standish table 1: value at J2000 and rate per century (au, rad-free degrees)
const EM_BARY: Elements = {
  a: [1.00000261, 0.00000562],
  e: [0.01671123, -0.00004392],
  I: [-0.00001531, -0.01294668],
  L: [100.46457166, 35999.37244981],
  peri: [102.93768193, 0.32327364],
  node: [0, 0],
};
const MARS: Elements = {
  a: [1.52371034, 0.00001847],
  e: [0.0933941, 0.00007882],
  I: [1.84969142, -0.00813131],
  L: [-4.55343205, 19140.30268499],
  peri: [-23.94362959, 0.44441088],
  node: [49.55953891, -0.29257343],
};

/** Heliocentric position (km) in the J2000 ecliptic, from mean elements and Kepler's equation. */
function keplerian(el: Elements, T: number): Vec3 {
  const at = (p: [number, number]) => p[0] + p[1] * T;
  const a = at(el.a) * AU_KM, e = at(el.e), I = at(el.I) * DEG, L = at(el.L), peri = at(el.peri), node = at(el.node);
  const w = (peri - node) * DEG, O = node * DEG;
  let M = ((((L - peri) % 360) + 540) % 360) - 180;
  M *= DEG;
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 8; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const x = a * (Math.cos(E) - e), y = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(I), sI = Math.sin(I);
  return [
    (cw * cO - sw * sO * cI) * x + (-sw * cO - cw * sO * cI) * y,
    (cw * sO + sw * cO * cI) * x + (-sw * sO + cw * cO * cI) * y,
    sw * sI * x + cw * sI * y,
  ];
}

/** J2000 ecliptic -> ICRF (equatorial J2000). */
const ECLIPTIC_J2000 = rotX(23.43928 * DEG);
/** Earth–Moon mass ratio + 1: the Earth sits 1/82.3 of the way from the barycentre to the Moon. */
const EARTH_MOON_RATIO = 82.30057;

/** Geocentric Mars (km, equatorial of date). Error ≲ 2′ in direction. */
export function marsGeocentric(jdUtc: number, P = precession(jdUtc)): Vec3 {
  const T = centuries(jdUtc);
  const mars = mul(ECLIPTIC_J2000, keplerian(MARS, T));
  const emb = mul(ECLIPTIC_J2000, keplerian(EM_BARY, T));
  const moon = moonGeocentric(jdUtc);
  const PT = transpose(P);
  const moonJ2000 = mul(PT, moon);
  const earth: Vec3 = [emb[0] - moonJ2000[0] / EARTH_MOON_RATIO, emb[1] - moonJ2000[1] / EARTH_MOON_RATIO, emb[2] - moonJ2000[2] / EARTH_MOON_RATIO];
  return mul(P, [mars[0] - earth[0], mars[1] - earth[1], mars[2] - earth[2]]);
}

/** Geocentric Sun (km, equatorial of date): the Earth's heliocentric position, reversed. */
export function sunGeocentric(jdUtc: number, P = precession(jdUtc)): Vec3 {
  const T = centuries(jdUtc);
  const emb = mul(ECLIPTIC_J2000, keplerian(EM_BARY, T));
  const moonJ2000 = mul(transpose(P), moonGeocentric(jdUtc));
  return mul(P, [moonJ2000[0] / EARTH_MOON_RATIO - emb[0], moonJ2000[1] / EARTH_MOON_RATIO - emb[1], moonJ2000[2] / EARTH_MOON_RATIO - emb[2]]);
}

/**
 * Body-fixed -> ICRF rotation from the IAU pole (α0, δ0) and prime meridian W:
 * R = Rz(90° + α0) · Rx(90° − δ0) · Rz(W). Body-fixed X is 0° longitude, Z the north pole.
 */
function iauFrame(alpha0: number, delta0: number, W: number): Mat3 {
  return mulMat(rotZ((90 + alpha0) * DEG), mulMat(rotX((90 - delta0) * DEG), rotZ(W * DEG)));
}

/** The Moon's orientation (mean Earth/polar axis frame, as LOLA and LROC maps use), body-fixed -> ICRF. */
export function moonOrientation(jdUtc: number): Mat3 {
  const d = jdUtc + TT_MINUS_UTC_DAYS - J2000;
  const T = d / 36525;
  const E = [
    125.045 - 0.0529921 * d,
    250.089 - 0.1059842 * d,
    260.008 + 13.0120009 * d,
    176.625 + 13.3407154 * d,
    357.529 + 0.9856003 * d,
    311.589 + 26.4057084 * d,
    134.963 + 13.064993 * d,
    276.617 + 0.3287146 * d,
    34.226 + 1.7484877 * d,
    15.134 - 0.1589763 * d,
    119.743 + 0.0036096 * d,
    239.961 + 0.1643573 * d,
    25.053 + 12.9590088 * d,
  ].map((x) => x * DEG);
  const s = (i: number) => Math.sin(E[i - 1]), c = (i: number) => Math.cos(E[i - 1]);
  const alpha = 269.9949 + 0.0031 * T - 3.8787 * s(1) - 0.1204 * s(2) + 0.07 * s(3) - 0.0172 * s(4) + 0.0072 * s(6) - 0.0052 * s(10) + 0.0043 * s(13);
  const delta = 66.5392 + 0.013 * T + 1.5419 * c(1) + 0.0239 * c(2) - 0.0278 * c(3) + 0.0068 * c(4) - 0.0029 * c(6) + 0.0009 * c(7) + 0.0008 * c(10) - 0.0009 * c(13);
  const W =
    38.3213 + 13.17635815 * d - 1.4e-12 * d * d + 3.561 * s(1) + 0.1208 * s(2) - 0.0642 * s(3) + 0.0158 * s(4) + 0.0252 * s(5) - 0.0066 * s(6) - 0.0047 * s(7) -
    0.0046 * s(8) + 0.0028 * s(9) + 0.0052 * s(10) + 0.004 * s(11) + 0.0019 * s(12) - 0.0044 * s(13);
  return iauFrame(alpha, delta, W);
}

/** Mars' orientation, body-fixed (planetocentric, east longitude) -> ICRF. */
export function marsOrientation(jdUtc: number): Mat3 {
  const d = jdUtc + TT_MINUS_UTC_DAYS - J2000;
  const T = d / 36525;
  return iauFrame(317.68143 - 0.1061 * T, 52.8865 - 0.0609 * T, 176.63 + 350.89198226 * d);
}

/** Planetocentric latitude and east longitude (degrees, −180..180) of a body-fixed vector. */
export function latLon(v: Vec3): { lat: number; lon: number } {
  return { lat: Math.atan2(v[2], Math.hypot(v[0], v[1])) / DEG, lon: Math.atan2(v[1], v[0]) / DEG };
}
