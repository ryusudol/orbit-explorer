// Where every world is and which way it faces, for any date.
//
// Mercury, Venus and the giant planets come from a truncated VSOP87 (sim/vsop87.ts,
// within 4″ of JPL Horizons over 2020–2035); the Moon, Mars and the Earth from the
// series in sim/solar.ts (the Earth from VSOP87 too, where it sets a nearby planet's direction). Rotation follows the IAU WGCCRE 2015 report (Archinal et
// al. 2018). Positions are geocentric in the scene's equatorial frame of date, like
// sim/solar.ts; orientations are body-fixed -> ICRF.
//
// References
//   VSOP87    Bretagnon & Francou 1988, A&A 202, 309; IMCCE files VSOP87B.*
//   Rotation  Archinal et al. 2018, Celest. Mech. Dyn. Astr. 130:22 (IAU 2015).
//             Jupiter's clouds turn with System II (870.27°/day), not the magnetic
//             System III, so the Great Red Spot stays near where Hubble last saw it.

import type { BodyId } from './bodies';
import {
  AU_KM,
  EM_BARY,
  ECLIPTIC_J2000,
  MARS,
  TT_MINUS_UTC_DAYS,
  centuries,
  earthHeliocentric,
  iauFrame,
  keplerian,
  marsGeocentric,
  marsOrientation,
  moonGeocentric,
  moonOrientation,
  mul,
  precession,
  sunGeocentric,
  transpose,
  type Mat3,
  type Vec3,
} from './solar';
import { VSOP87, type Series } from './vsop87';

const DEG = Math.PI / 180;
const J2000 = 2451545.0;
export type PlanetId = 'mercury' | 'venus' | 'jupiter' | 'saturn' | 'uranus' | 'neptune';
export const VSOP_PLANETS: PlanetId[] = ['mercury', 'venus', 'jupiter', 'saturn', 'uranus', 'neptune'];

/** Julian millennia of TDB (≈ TT) since J2000. */
const millennia = (jdUtc: number) => (jdUtc + TT_MINUS_UTC_DAYS - J2000) / 365250;

function series(s: Series, tau: number): number {
  let sum = 0, tp = 1;
  for (const terms of s) {
    let x = 0;
    for (let k = 0; k < terms.length; k += 3) x += terms[k] * Math.cos(terms[k + 1] + terms[k + 2] * tau);
    sum += x * tp;
    tp *= tau;
  }
  return sum;
}

/**
 * Heliocentric position (km, ICRF) from VSOP87B. The dynamical ecliptic of
 * J2000 is turned to the FK5/ICRF equator with Bretagnon's rotation, which
 * includes the 0.1″ frame offset between the two.
 */
export function vsopHeliocentric(id: PlanetId | 'earth', jdUtc: number): Vec3 {
  const tau = millennia(jdUtc);
  const [Ls, Bs, Rs] = VSOP87[id];
  const L = series(Ls, tau), B = series(Bs, tau), R = series(Rs, tau) * AU_KM;
  const x = R * Math.cos(B) * Math.cos(L), y = R * Math.cos(B) * Math.sin(L), z = R * Math.sin(B);
  return [x + 0.00000044036 * y - 0.000000190919 * z, -0.000000479966 * x + 0.917482137087 * y - 0.397776982902 * z, 0.397776982902 * y + 0.917482137087 * z];
}

/** Heliocentric position of any world (km, ICRF). The Oort cloud is centred on the Sun. */
export function heliocentric(body: BodyId, jdUtc: number): Vec3 {
  switch (body) {
    case 'oort':
      return [0, 0, 0];
    case 'earth':
      return earthHeliocentric(jdUtc);
    case 'moon': {
      const e = earthHeliocentric(jdUtc), m = mul(transpose(precession(jdUtc)), moonGeocentric(jdUtc));
      return [e[0] + m[0], e[1] + m[1], e[2] + m[2]];
    }
    case 'mars':
      return mul(ECLIPTIC_J2000, keplerian(MARS, centuries(jdUtc)));
    default:
      return vsopHeliocentric(body, jdUtc);
  }
}

/** Geocentric position of any world (km, equatorial of date). */
export function geocentric(body: BodyId, jdUtc: number, P: Mat3 = precession(jdUtc)): Vec3 {
  switch (body) {
    case 'earth':
      return [0, 0, 0];
    case 'moon':
      return moonGeocentric(jdUtc);
    case 'mars':
      return marsGeocentric(jdUtc, P);
    case 'oort':
      return sunGeocentric(jdUtc, P);
    default: {
      // the Earth from VSOP87 too: Standish's 20″ would be 35″ on Venus at its closest
      const p = vsopHeliocentric(body, jdUtc), e = vsopHeliocentric('earth', jdUtc);
      return mul(P, [p[0] - e[0], p[1] - e[1], p[2] - e[2]]);
    }
  }
}

/** Heliocentric orbit of the Earth–Moon barycentre, for drawing the Earth's orbit. */
export const embHeliocentric = (jdUtc: number): Vec3 => mul(ECLIPTIC_J2000, keplerian(EM_BARY, centuries(jdUtc)));

/** Sidereal orbital periods (days), for sampling whole orbits. */
export const ORBIT_DAYS: Record<PlanetId | 'earth' | 'mars', number> = {
  mercury: 87.969,
  venus: 224.701,
  earth: 365.256,
  mars: 686.98,
  jupiter: 4332.59,
  saturn: 10759.22,
  uranus: 30688.5,
  neptune: 60182,
};

// ------------------------------------------------------------------ rotation (IAU 2015)

const sinD = (x: number) => Math.sin(x * DEG), cosD = (x: number) => Math.cos(x * DEG);

/** Days of TDB since J2000 and Julian centuries. */
function dT(jdUtc: number): [number, number] {
  const d = jdUtc + TT_MINUS_UTC_DAYS - J2000;
  return [d, d / 36525];
}

/** Jupiter's clouds: System II, 870.270°/day; W at J2000 chosen so the Hubble map's longitudes stay System III on its date. */
const JUPITER_MAP_JD = 2461021.0; // 2025-12-11, OPAL Cycle 32 rotation 1
const SYSTEM_II = 870.27;
const SYSTEM_III = 870.536;

export function planetOrientation(id: PlanetId, jdUtc: number): Mat3 {
  const [d, T] = dT(jdUtc);
  switch (id) {
    case 'mercury': {
      const M = [174.7910857 + 4.092335 * d, 349.5821714 + 8.18467 * d, 164.3732571 + 12.277005 * d, 339.1643429 + 16.36934 * d, 153.9554286 + 20.461675 * d];
      const W = 329.5988 + 6.1385108 * d + 0.01067257 * sinD(M[0]) - 0.00112309 * sinD(M[1]) - 0.0001104 * sinD(M[2]) - 0.00002539 * sinD(M[3]) - 0.00000571 * sinD(M[4]);
      return iauFrame(281.0103 - 0.0328 * T, 61.4155 - 0.0049 * T, W);
    }
    case 'venus':
      return iauFrame(272.76, 67.16, 160.2 - 1.4813688 * d);
    case 'jupiter': {
      const Ja = 99.360714 + 4850.4046 * T, Jb = 175.895369 + 1191.9605 * T, Jc = 300.323162 + 262.5475 * T, Jd = 114.012305 + 6070.2476 * T, Je = 49.511251 + 64.3 * T;
      const a = 268.056595 - 0.006499 * T + 0.000117 * sinD(Ja) + 0.000938 * sinD(Jb) + 0.001432 * sinD(Jc) + 0.00003 * sinD(Jd) + 0.00215 * sinD(Je);
      const dd = 64.495303 + 0.002413 * T + 0.00005 * cosD(Ja) + 0.000404 * cosD(Jb) + 0.000617 * cosD(Jc) - 0.000013 * cosD(Jd) + 0.000926 * cosD(Je);
      // System III on the map's date, drifting at System II's rate since
      const W = 284.95 + SYSTEM_III * d + (SYSTEM_II - SYSTEM_III) * (jdUtc - JUPITER_MAP_JD);
      return iauFrame(a, dd, W);
    }
    case 'saturn':
      return iauFrame(40.589 - 0.036 * T, 83.537 - 0.004 * T, 38.9 + 810.7939024 * d);
    case 'uranus':
      return iauFrame(257.311, -15.175, 203.81 - 501.1600928 * d);
    case 'neptune': {
      const N = 357.85 + 52.316 * T;
      return iauFrame(299.36 + 0.7 * sinD(N), 43.46 - 0.51 * cosD(N), 249.978 + 541.1397757 * d - 0.48 * sinD(N));
    }
  }
}

/** Jupiter's System III orientation (IAU), for comparing with Horizons' sub-observer longitudes. */
export function jupiterSystemIII(jdUtc: number): Mat3 {
  const m = planetOrientation('jupiter', jdUtc);
  // undo the System II drift: a turn about the pole (body-fixed Z)
  const k = -(SYSTEM_II - SYSTEM_III) * (jdUtc - JUPITER_MAP_JD) * DEG;
  const c = Math.cos(k), s = Math.sin(k);
  const R: Mat3 = [c, -s, 0, s, c, 0, 0, 0, 1];
  return mulM(m, R);
}

const mulM = (a: Mat3, b: Mat3): Mat3 => {
  const o = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[3 * i + j] += a[3 * i + k] * b[3 * k + j];
  return o;
};

/** Body-fixed -> ICRF for any world with a surface frame (identity for the Oort cloud). */
export function orientationOf(body: BodyId, jdUtc: number): Mat3 {
  switch (body) {
    case 'moon':
      return moonOrientation(jdUtc);
    case 'mars':
      return marsOrientation(jdUtc);
    case 'earth':
    case 'oort':
      return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    default:
      return planetOrientation(body, jdUtc);
  }
}
