// Trajectories of objects orbiting the Moon and Mars, sampled from JPL Horizons
// by data/fetch-ephemeris.mjs, interpolated with cubic Hermite splines (position
// and velocity at both ends of each step), the same scheme as the SGP4 keyframes.

export interface Track {
  /** JPL Horizons id (negative for spacecraft) */
  id: number;
  /** UTC Julian date of the first sample */
  jd0: number;
  stepS: number;
  count: number;
  /** x, y, z (km), vx, vy, vz (km/s) per sample, body-centred ICRF */
  data: Float32Array;
}

export interface EphemerisFile {
  generatedMs: number;
  tracks: Track[];
}

/** Decoder for web/public/data/ephemeris-{body}.bin. */
export function decodeEphemeris(buffer: ArrayBuffer): EphemerisFile {
  const dv = new DataView(buffer);
  if (new TextDecoder().decode(new Uint8Array(buffer, 0, 4)) !== 'EPH1') throw new Error('not an ephemeris file');
  const n = dv.getUint32(4, true);
  const generatedMs = dv.getFloat64(8, true);
  const tracks: Track[] = [];
  let o = 16;
  for (let k = 0; k < n; k++) {
    const id = dv.getInt32(o, true);
    const count = dv.getUint32(o + 4, true);
    const jd0 = dv.getFloat64(o + 8, true);
    const stepS = dv.getFloat64(o + 16, true);
    o += 24;
    tracks.push({ id, jd0, stepS, count, data: new Float32Array(buffer, o, count * 6) });
    o += count * 24;
  }
  return { generatedMs, tracks };
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
  const e = Math.sqrt(Math.max(0, 1 - (h * h) / (mu * a)));
  const bound = a > 0;
  return {
    a: bound ? a : Infinity,
    e,
    inclinationDeg: (Math.acos(hz / h) * 180) / Math.PI,
    periodS: bound ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : Infinity,
    periapsisKm: bound ? a * (1 - e) : (h * h) / mu / (1 + e),
    apoapsisKm: bound ? a * (1 + e) : Infinity,
  };
}
