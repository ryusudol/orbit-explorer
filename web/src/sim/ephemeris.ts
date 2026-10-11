// Trajectories of what orbits the other worlds, from JPL Horizons snapshots
// (data/fetch-ephemeris.mjs). Three kinds of record:
//   track     sampled position + velocity, interpolated with cubic Hermite splines
//             (position and velocity at both ends of each step), the same scheme as
//             the SGP4 keyframes. Spacecraft and every moon faster than 20 days.
//   elements  osculating Keplerian elements at one epoch: the slow irregular moons,
//             moved by two-body motion (sim/ephemeris.test.ts measures the error).
//   path      positions every few days over decades, for drawing (the Voyagers).

export interface Track {
  /** JPL Horizons id (negative for spacecraft) */
  id: number;
  /** UTC Julian date of the first sample */
  jd0: number;
  stepS: number;
  count: number;
  /** x, y, z (km), vx, vy, vz (km/s) per sample, body-centred ICRF (float64 far from the centre) */
  data: Float32Array | Float64Array;
}

/** Osculating elements about the world's centre, ICRF. Angles in radians. */
export interface Elements {
  /** UTC Julian date */
  epochJd: number;
  a: number;
  e: number;
  i: number;
  node: number;
  peri: number;
  M: number;
  /** mean motion, rad/s */
  n: number;
}

export interface Path {
  jd0: number;
  stepS: number;
  count: number;
  /** x, y, z (km) per point, body-centred ICRF */
  data: Float32Array;
}

export interface EphObject {
  id: number;
  name: string;
  kind: 'moon' | 'spacecraft';
  radiusKm?: number;
  found?: { year: number; by: string };
  track?: Track;
  elements?: Elements;
  path?: Path;
}

export interface EphemerisFile {
  generatedMs: number;
  objects: EphObject[];
  /** the objects that have a sampled track */
  tracks: Track[];
}

/** Decoder for web/public/data/ephemeris-{body}.bin. */
export function decodeEphemeris(buffer: ArrayBuffer): EphemerisFile {
  const dv = new DataView(buffer);
  if (new TextDecoder().decode(new Uint8Array(buffer, 0, 4)) !== 'EPH2') throw new Error('not an ephemeris file');
  const n = dv.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, n))) as {
    generatedMs: number;
    objects: (Omit<EphObject, 'track' | 'path'> & { track?: Omit<Track, 'id' | 'data'> & { offset: number; f64?: boolean }; path?: Omit<Path, 'data'> & { offset: number } })[];
  };
  const base = 8 + Math.ceil(n / 8) * 8;
  const objects: EphObject[] = meta.objects.map((m) => {
    const o: EphObject = { id: m.id, name: m.name, kind: m.kind, radiusKm: m.radiusKm, found: m.found, elements: m.elements };
    if (m.track) {
      const { offset, f64, ...t } = m.track;
      o.track = { id: m.id, ...t, data: new (f64 ? Float64Array : Float32Array)(buffer, base + offset, t.count * 6) };
    }
    if (m.path) {
      const { offset, ...p } = m.path;
      o.path = { ...p, data: new Float32Array(buffer, base + offset, p.count * 3) };
    }
    return o;
  });
  return { generatedMs: meta.generatedMs, objects, tracks: objects.flatMap((o) => (o.track ? [o.track] : [])) };
}

/** First and last covered Julian dates. */
export const span = (t: Track): [number, number] => [t.jd0, t.jd0 + ((t.count - 1) * t.stepS) / 86400];

/**
 * State at `jd` into out[0..5] (km, km/s). Returns false outside the published
 * window, where nothing is known (the mission's prediction has not been issued).
 */
export function stateAt(t: Track, jd: number, out: Float64Array | number[]): boolean {
  const x = ((jd - t.jd0) * 86400) / t.stepS;
  if (!(x >= 0 && x <= t.count - 1)) return false;
  const i = Math.min(Math.floor(x), t.count - 2);
  const s = x - i;
  const h = t.stepS;
  const d = t.data;
  const a = 6 * i, b = a + 6;
  // cubic Hermite basis and its derivative
  const s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const d00 = (6 * s2 - 6 * s) / h, d10 = 3 * s2 - 4 * s + 1, d01 = (-6 * s2 + 6 * s) / h, d11 = 3 * s2 - 2 * s;
  for (let k = 0; k < 3; k++) {
    const p0 = d[a + k], v0 = d[a + 3 + k], p1 = d[b + k], v1 = d[b + 3 + k];
    out[k] = h00 * p0 + h10 * h * v0 + h01 * p1 + h11 * h * v1;
    out[3 + k] = d00 * p0 + d10 * v0 + d01 * p1 + d11 * v1;
  }
  return true;
}

/**
 * Solves Kepler's equation E − e sin E = M (elliptic), for any M: the result differs
 * from M by less than e, in the same turn. Newton's method converges from E = ±π for
 * M in (−π, π], since f is convex on [0, π] and concave on [−π, 0]; started from M
 * itself it can throw E across the periapsis, where f' = 1 − e cos E is near 0 at
 * high e (Juno's 0.97), and land anywhere on the orbit.
 */
export function eccentricAnomaly(M: number, e: number): number {
  const turn = 2 * Math.PI * Math.round(M / (2 * Math.PI));
  const m = M - turn;
  let E = e < 0.8 ? m : m < 0 ? -Math.PI : Math.PI;
  for (let k = 0; k < 50; k++) {
    const dE = (E - e * Math.sin(E) - m) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E + turn;
}

/** Two-body state from elements at `jd` into out[0..5] (km, km/s); bound orbits only. */
export function keplerState(el: Elements, jd: number, out: Float64Array | number[]): boolean {
  const { a, e, i, node, peri } = el;
  const E = eccentricAnomaly(el.M + el.n * (jd - el.epochJd) * 86400, e);
  const cE = Math.cos(E), sE = Math.sin(E), q = Math.sqrt(1 - e * e);
  const x = a * (cE - e), y = a * q * sE;
  const r = a * (1 - e * cE);
  const vx = (-a * el.n * sE * a) / r, vy = (a * el.n * q * cE * a) / r;
  const cw = Math.cos(peri), sw = Math.sin(peri), cO = Math.cos(node), sO = Math.sin(node), cI = Math.cos(i), sI = Math.sin(i);
  const P = [cw * cO - sw * sO * cI, cw * sO + sw * cO * cI, sw * sI];
  const Q = [-sw * cO - cw * sO * cI, -sw * sO + cw * cO * cI, cw * sI];
  for (let k = 0; k < 3; k++) {
    out[k] = P[k] * x + Q[k] * y;
    out[3 + k] = P[k] * vx + Q[k] * vy;
  }
  return true;
}

/** Elements (ICRF) from a state vector about a body with gravitational parameter `mu`. */
export function elementsFromState(s: ArrayLike<number>, mu: number, epochJd: number): Elements | null {
  const r = [s[0], s[1], s[2]], v = [s[3], s[4], s[5]];
  const rn = Math.hypot(r[0], r[1], r[2]);
  const h = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]];
  const hn = Math.hypot(h[0], h[1], h[2]);
  const v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const a = 1 / (2 / rn - v2 / mu);
  if (!(a > 0) || hn === 0) return null;
  const rv = r[0] * v[0] + r[1] * v[1] + r[2] * v[2];
  const ev = [0, 1, 2].map((k) => ((v2 - mu / rn) * r[k] - rv * v[k]) / mu);
  const e = Math.hypot(ev[0], ev[1], ev[2]);
  const i = Math.acos(Math.max(-1, Math.min(1, h[2] / hn)));
  const nv = [-h[1], h[0], 0];
  const nn = Math.hypot(nv[0], nv[1]);
  const node = nn > 1e-12 ? Math.atan2(nv[1], nv[0]) : 0;
  // perifocal axes from the node line (or x when equatorial)
  const N = nn > 1e-12 ? [nv[0] / nn, nv[1] / nn, 0] : [1, 0, 0];
  const W = [h[0] / hn, h[1] / hn, h[2] / hn];
  const NxW = [W[1] * N[2] - W[2] * N[1], W[2] * N[0] - W[0] * N[2], W[0] * N[1] - W[1] * N[0]];
  const ang = (u: number[]) => Math.atan2(u[0] * NxW[0] + u[1] * NxW[1] + u[2] * NxW[2], u[0] * N[0] + u[1] * N[1] + u[2] * N[2]);
  const u = ang(r);
  const peri = e > 1e-9 ? ang(ev) : 0;
  const nu = u - peri;
  const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
  return { epochJd, a, e, i, node, peri, M: E - e * Math.sin(E), n: Math.sqrt(mu / (a * a * a)) };
}

/** State of any object at `jd`: its track where published, else its elements. False when nothing is known. */
export function objectState(o: EphObject, jd: number, out: Float64Array | number[]): boolean {
  if (o.track) return stateAt(o.track, jd, out);
  if (o.elements) return keplerState(o.elements, jd, out);
  return false;
}

/** Point `k` of a path (km). */
export function pathPoint(p: Path, k: number, out: Float64Array | number[]) {
  out[0] = p.data[3 * k];
  out[1] = p.data[3 * k + 1];
  out[2] = p.data[3 * k + 2];
}

export interface Osculating {
  /** semi-major axis, km (Infinity if unbound) */
  a: number;
  e: number;
  inclinationDeg: number;
  periodS: number;
  periapsisKm: number;
  apoapsisKm: number;
}

/** Two-body elements from a state vector about a body with gravitational parameter `mu` (km³/s²). */
export function osculating(s: ArrayLike<number>, mu: number): Osculating {
  const r = Math.hypot(s[0], s[1], s[2]);
  const v2 = s[3] * s[3] + s[4] * s[4] + s[5] * s[5];
  const a = 1 / (2 / r - v2 / mu);
  const hx = s[1] * s[5] - s[2] * s[4], hy = s[2] * s[3] - s[0] * s[5], hz = s[0] * s[4] - s[1] * s[3];
  const h = Math.hypot(hx, hy, hz);
  const bound = a > 0;
  const e = bound ? Math.sqrt(Math.max(0, 1 - (h * h) / (mu * a))) : Math.sqrt(1 + (h * h) / (mu * -a));
  return {
    a: bound ? a : Infinity,
    e,
    inclinationDeg: (Math.acos(hz / h) * 180) / Math.PI,
    periodS: bound ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : Infinity,
    periapsisKm: bound ? a * (1 - e) : (h * h) / mu / (1 + e),
    apoapsisKm: bound ? a * (1 + e) : Infinity,
  };
}
