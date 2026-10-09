import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeEphemeris, osculating, stateAt, type Track } from './ephemeris';

const file = (body: string) => {
  const b = readFileSync(join(__dirname, '..', '..', 'public', 'data', `ephemeris-${body}.bin`));
  return decodeEphemeris(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

/**
 * Interpolation error, measured: drop every other sample, interpolate at the
 * dropped ones and compare with JPL's value there. Cubic Hermite error scales
 * with step⁴, so the error at the stored step is this ÷ 16.
 */
function worstErrorKm(t: Track): number {
  const half: Track = { ...t, stepS: 2 * t.stepS, count: Math.floor((t.count + 1) / 2), data: new Float32Array(Math.floor((t.count + 1) / 2) * 6) };
  for (let k = 0; k < half.count; k++) half.data.set(t.data.subarray(12 * k, 12 * k + 6), 6 * k);
  const s = new Float64Array(6);
  let worst = 0;
  for (let k = 1; k < t.count - 1; k += 2) {
    stateAt(half, t.jd0 + (k * t.stepS) / 86400, s);
    worst = Math.max(worst, Math.hypot(s[0] - t.data[6 * k], s[1] - t.data[6 * k + 1], s[2] - t.data[6 * k + 2]));
  }
  return worst / 16;
}

describe('Horizons trajectory snapshots', () => {
  for (const [body, mu, radius] of [
    ['moon', 4902.8, 1737.4],
    ['mars', 42828.37, 3389.5],
  ] as const) {
    const eph = file(body);
    it(`${body}: every object is sampled and in orbit`, () => {
      expect(eph.tracks.length).toBeGreaterThan(3);
      for (const t of eph.tracks) {
        const el = osculating(t.data.subarray(0, 6), mu);
        expect(el.a).toBeLessThan(100_000);
        expect(el.periapsisKm).toBeGreaterThan(radius);
      }
    });
    it(`${body}: Hermite interpolation stays under 50 m at the stored step`, () => {
      for (const t of eph.tracks) expect(worstErrorKm(t), `object ${t.id}`).toBeLessThan(0.05);
    });
  }

  it('reports nothing outside the window', () => {
    const t = file('mars').tracks[0];
    expect(stateAt(t, t.jd0 - 0.001, new Float64Array(6))).toBe(false);
    expect(stateAt(t, t.jd0 + 0.001, new Float64Array(6))).toBe(true);
  });
});
