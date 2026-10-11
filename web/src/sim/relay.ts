// Who can talk to a site on the Moon or Mars, and when; and how far any world is.
//
// A lander or rover reaches Earth two ways: directly, while the Earth is above
// its horizon, or through an orbiter passing overhead, which stores the data and
// forwards it on its own (much bigger) link. Over a window, this samples the
// elevation of the Earth, the Sun and every orbiter as seen from the site, and
// turns the samples into passes. Ephemerides: sim/solar.ts (Earth, Sun, body
// orientation) and the Horizons tracks (orbiters), all in ICRF.

import { BODIES, type BodyId, type Site } from './bodies';
import { stateAt, type Track } from './ephemeris';
import { geocentric, orientationOf } from './planets';
import { C_KMS, mul, precession, sunGeocentric, transpose, type Mat3, type Vec3 } from './solar';

const DEG = Math.PI / 180;
/** Relay passes count from this elevation: lower, the link margin and terrain get in the way. */
export const RELAY_MIN_ELEV_DEG = 10;

/** Body-fixed -> ICRF orientation of a world. */
export const orientation = (body: BodyId, jd: number): Mat3 => orientationOf(body, jd);

/** Body's centre relative to the Earth's (km, ICRF); the Sun's for the Oort cloud. */
export function bodyFromEarth(body: BodyId, jd: number, P = precession(jd)): Vec3 {
  if (body === 'earth') return [0, 0, 0];
  return mul(transpose(P), geocentric(body, jd, P));
}

/** One-way light time between the Earth's and the body's centres, seconds. */
export function lightTimeS(body: BodyId, jd: number): number {
  const v = bodyFromEarth(body, jd);
  return Math.hypot(v[0], v[1], v[2]) / C_KMS;
}

/** Distance between two worlds' centres, km. */
export function distanceKm(a: BodyId, b: BodyId, jd: number): number {
  const P = precession(jd);
  const u = bodyFromEarth(a, jd, P), v = bodyFromEarth(b, jd, P);
  return Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);
}

/** Unit vector of the site's local vertical, body-fixed. */
export function siteUp(site: Site): Vec3 {
  const la = site.lat * DEG, lo = site.lon * DEG;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

/** Elevation (degrees) of a body-fixed point `p` (km) above the horizon of a site at `up · R`. */
function elevation(p: Vec3, up: Vec3, R: number): number {
  const d: Vec3 = [p[0] - up[0] * R, p[1] - up[1] * R, p[2] - up[2] * R];
  const n = Math.hypot(d[0], d[1], d[2]);
  return Math.asin((d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) / n) / DEG;
}

export interface Pass {
  start: number;
  end: number;
  /** highest elevation in the pass, degrees */
  peak: number;
}

export interface RelayRow {
  /** orbiter Horizons id, or 'earth' (direct link) / 'sun' (daylight) */
  key: number | 'earth' | 'sun';
  passes: Pass[];
  /** elevation now, degrees */
  now: number;
}

export interface RelayPlan {
  body: BodyId;
  site: string;
  jd0: number;
  jd1: number;
  rows: RelayRow[];
  /** one-way light time to Earth now, s */
  lightTimeS: number;
  /** local true solar time at the site now, hours (0–24 of the local day) */
  localSolarH: number;
}

/**
 * Passes over `site` from `jd0` for `hours`, sampled every `stepS` seconds and
 * refined to the second at each rise and set.
 */
export function relayPlan(body: BodyId, site: Site, tracks: Track[], jd0: number, hours = 24, stepS = 30): RelayPlan {
  const R = BODIES[body].radiusKm;
  const up = siteUp(site);
  const P0 = precession(jd0);
  const st = new Float64Array(6);

  // everything a sample needs once, shared by every target
  interface Frame {
    toBody: Mat3;
    body: Vec3;
  }
  let cacheJd = NaN;
  let cache: Frame = { toBody: transpose(orientation(body, jd0)), body: bodyFromEarth(body, jd0, P0) };
  const frame = (jd: number): Frame => {
    if (jd !== cacheJd) {
      cacheJd = jd;
      cache = { toBody: transpose(orientation(body, jd)), body: bodyFromEarth(body, jd, P0) };
    }
    return cache;
  };
  const PT = transpose(P0);
  // body-fixed position (km) of each target at jd
  const targets: { key: RelayRow['key']; minEl: number; at: (jd: number) => Vec3 | null }[] = [
    {
      key: 'sun',
      minEl: 0,
      at: (jd) => {
        const f = frame(jd);
        const s = mul(PT, sunGeocentric(jd, P0));
        return mul(f.toBody, [s[0] - f.body[0], s[1] - f.body[1], s[2] - f.body[2]]);
      },
    },
    {
      key: 'earth',
      minEl: 0,
      at: (jd) => {
        const f = frame(jd);
        return mul(f.toBody, [-f.body[0], -f.body[1], -f.body[2]]);
      },
    },
    ...tracks
      .filter((t) => BODIES[body].orbiters.find((o) => o.id === t.id)?.kind === 'spacecraft')
      .map((t) => ({
        key: t.id,
        minEl: RELAY_MIN_ELEV_DEG,
        at: (jd: number) => (stateAt(t, jd, st) ? mul(frame(jd).toBody, [st[0], st[1], st[2]]) : null),
      })),
  ];

  // sample every target at each time before moving on, so the frame cache hits
  const n = Math.ceil((hours * 3600) / stepS) + 1;
  const jdAt = (k: number) => jd0 + (k * stepS) / 86400;
  const table = targets.map(() => new Float32Array(n));
  for (let k = 0; k < n; k++) {
    const jd = jdAt(k);
    targets.forEach((t, j) => {
      const p = t.at(jd);
      table[j][k] = p ? elevation(p, up, R) : -90;
    });
  }
  const rows: RelayRow[] = targets.map(({ key, minEl, at }, j) => {
    const el = (jd: number) => {
      const p = at(jd);
      return p ? elevation(p, up, R) : -90;
    };
    /** bisect the crossing of minEl between two samples, to ~1 s */
    const crossing = (a: number, b: number) => {
      let lo = a, hi = b;
      const rising = el(a) < minEl;
      while ((hi - lo) * 86400 > 1) {
        const mid = (lo + hi) / 2;
        if (el(mid) < minEl === rising) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    };
    const e = table[j];
    const passes: Pass[] = [];
    let open: Pass | null = e[0] >= minEl ? { start: jd0, end: jd0, peak: e[0] } : null;
    for (let k = 1; k < n; k++) {
      if (open) open.peak = Math.max(open.peak, e[k]);
      if (e[k - 1] < minEl && e[k] >= minEl) open = { start: crossing(jdAt(k - 1), jdAt(k)), end: 0, peak: e[k] };
      else if (e[k - 1] >= minEl && e[k] < minEl && open) {
        open.end = crossing(jdAt(k - 1), jdAt(k));
        passes.push(open);
        open = null;
      }
    }
    if (open) {
      open.end = jdAt(n - 1);
      passes.push(open);
    }
    return { key, passes, now: e[0] };
  });

  // local true solar time: the Sun's hour angle, as a 24-"hour" local day
  const sunBf = targets[0].at(jd0)!;
  const sunLon = Math.atan2(sunBf[1], sunBf[0]) / DEG;
  const localSolarH = (((12 + (site.lon - sunLon) / 15) % 24) + 24) % 24;
  return { body, site: site.id, jd0, jd1: jdAt(n - 1), rows, lightTimeS: lightTimeS(body, jd0), localSolarH };
}
