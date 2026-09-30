// Shared keyframe store: propagation workers write full SGP4 states into a
// SharedArrayBuffer; the render loop reads them in place (no postMessage copies)
// and interpolates between two keyframes with a cubic Hermite spline.
//
// Hermite on position + velocity is 4th-order accurate: for a circular LEO
// orbit (w = 1.1e-3 rad/s) the error is ~ r (w h)^4 / 384. Measured worst case
// over 600 LEO objects (keyframes.test.ts): 1.0 m at h = 60 s and 0.27 km at
// h = 300 s - so SGP4 runs at 1-12 Hz, not per object per frame.

export const SLOTS = 4;

/** Int32 control words. */
export const CTRL = {
  REQ_SEQ: 0,
  REQ_SLOT: 1,
  QUIT: 2,
  /** DONE + slot: number of workers that finished the slot */
  DONE: 4,
} as const;

export interface KeyframeBuffers {
  sab: SharedArrayBuffer;
  n: number;
  ctrl: Int32Array;
  /** [0] = requested Julian date */
  reqJd: Float64Array;
  /** SLOTS x 3n TEME km */
  pos: Float64Array;
  /** SLOTS x 3n TEME km/s */
  vel: Float64Array;
  /** SLOTS x n sunlit fraction 0..255 */
  illum: Uint8Array;
  /** SLOTS x n SGP4 error code (0 = ok) */
  status: Uint8Array;
}

const HEADER_BYTES = 64 + 64;

export function keyframeBytes(n: number) {
  return HEADER_BYTES + SLOTS * n * (3 * 8 + 3 * 8 + 1 + 1);
}

export function viewKeyframes(sab: SharedArrayBuffer, n: number): KeyframeBuffers {
  let off = 0;
  const ctrl = new Int32Array(sab, off, 16);
  off += 64;
  const reqJd = new Float64Array(sab, off, 8);
  off += 64;
  const pos = new Float64Array(sab, off, SLOTS * 3 * n);
  off += SLOTS * 3 * n * 8;
  const vel = new Float64Array(sab, off, SLOTS * 3 * n);
  off += SLOTS * 3 * n * 8;
  const illum = new Uint8Array(sab, off, SLOTS * n);
  off += SLOTS * n;
  const status = new Uint8Array(sab, off, SLOTS * n);
  return { sab, n, ctrl, reqJd, pos, vel, illum, status };
}

export function createKeyframes(n: number): KeyframeBuffers {
  return viewKeyframes(new SharedArrayBuffer(keyframeBytes(n)), n);
}

/**
 * Cubic Hermite between slot `a` (time 0) and slot `b` (time h seconds) at
 * fraction s in [0, 1]. Writes positions into `out` (3n) and 1/0 into `valid`.
 */
export function hermite(kf: KeyframeBuffers, a: number, b: number, s: number, h: number, out: Float64Array, valid: Uint8Array) {
  const n = kf.n;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = (s3 - 2 * s2 + s) * h;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = (s3 - s2) * h;
  const pa = kf.pos, va = kf.vel;
  const oa = a * 3 * n, ob = b * 3 * n;
  const sa = a * n, sb = b * n;
  const st = kf.status;
  for (let i = 0; i < n; i++) {
    const ok = st[sa + i] === 0 && st[sb + i] === 0;
    valid[i] = ok ? 1 : 0;
    const k = 3 * i;
    out[k] = h00 * pa[oa + k] + h10 * va[oa + k] + h01 * pa[ob + k] + h11 * va[ob + k];
    out[k + 1] = h00 * pa[oa + k + 1] + h10 * va[oa + k + 1] + h01 * pa[ob + k + 1] + h11 * va[ob + k + 1];
    out[k + 2] = h00 * pa[oa + k + 2] + h10 * va[oa + k + 2] + h01 * pa[ob + k + 2] + h11 * va[ob + k + 2];
  }
}

/** Second-order Taylor step from one keyframe (used until a bracketing keyframe lands). */
export function extrapolate(kf: KeyframeBuffers, a: number, dt: number, out: Float64Array, valid: Uint8Array) {
  const n = kf.n;
  const p = kf.pos, v = kf.vel;
  const o = a * 3 * n;
  const MU = 398600.8;
  for (let i = 0; i < n; i++) {
    valid[i] = kf.status[a * n + i] === 0 ? 1 : 0;
    const k = 3 * i;
    const x = p[o + k], y = p[o + k + 1], z = p[o + k + 2];
    const r2 = x * x + y * y + z * z;
    const g = r2 > 0 ? (-MU / (r2 * Math.sqrt(r2))) * 0.5 * dt * dt : 0;
    out[k] = x + v[o + k] * dt + g * x;
    out[k + 1] = y + v[o + k + 1] * dt + g * y;
    out[k + 2] = z + v[o + k + 2] * dt + g * z;
  }
}
