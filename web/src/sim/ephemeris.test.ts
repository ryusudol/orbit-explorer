import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BODIES, BODY_ORDER } from './bodies';
import { decodeEphemeris, eccentricAnomaly, keplerState, osculating, stateAt, type Track } from './ephemeris';

const file = (body: string) => {
  const b = readFileSync(join(__dirname, '..', '..', 'public', 'data', `ephemeris-${body}.bin`));
  return decodeEphemeris(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

/**
 * Interpolation error, measured: drop every other sample, interpolate at the
 * dropped ones and compare with JPL's value there. Cubic Hermite error scales
 * with step⁴, so the error at the stored step is this ÷ 16. Returns the errors
 * (km), worst first.
 */
function errorsKm(t: Track): number[] {
  const n = Math.floor((t.count + 1) / 2);
  const half: Track = { ...t, stepS: 2 * t.stepS, count: n, data: t.data instanceof Float64Array ? new Float64Array(n * 6) : new Float32Array(n * 6) };
  for (let k = 0; k < half.count; k++) half.data.set(t.data.subarray(12 * k, 12 * k + 6), 6 * k);
  const s = new Float64Array(6);
  const errs: number[] = [];
  for (let k = 1; k < t.count - 1; k += 2) {
    stateAt(half, t.jd0 + (k * t.stepS) / 86400, s);
    errs.push(Math.hypot(s[0] - t.data[6 * k], s[1] - t.data[6 * k + 1], s[2] - t.data[6 * k + 2]) / 16);
  }
  return errs.sort((a, b) => b - a);
}

describe('Horizons trajectory snapshots', () => {
  for (const body of BODY_ORDER.filter((b) => b !== 'earth')) {
    const eph = file(body);
    const { mu, radiusKm: radius } = BODIES[body];
    it(`${body}: every listed orbiter is in the snapshot`, () => {
      // a spacecraft whose prediction has lapsed may drop out; a listed moon never does
      for (const o of BODIES[body].orbiters.filter((o) => o.kind === 'moon')) expect(eph.objects.some((e) => e.id === o.id), o.name).toBe(true);
    });
    it(`${body}: every object is bound and above the surface`, () => {
      for (const o of eph.objects) {
        // the Voyagers are escaping the Sun, and BepiColombo is still arriving
        if (body === 'oort' || o.id === -121) continue;
        const s = new Float64Array(6);
        if (o.track) s.set(o.track.data.subarray(0, 6));
        else keplerState(o.elements!, o.elements!.epochJd, s);
        const el = osculating(s, mu);
        expect(el.a, o.name).toBeLessThan(1e8);
        expect(el.periapsisKm, o.name).toBeGreaterThan(radius);
      }
    });
    it(`${body}: Hermite interpolation stays under 50 m at the stored step`, () => {
      for (const t of eph.tracks) {
        const e = errorsKm(t);
        // 99.9% of samples under 50 m (Juno at perijove, 58 km/s around a tight curve: 200 m)
        expect(e[Math.floor(e.length * 0.001)], `object ${t.id}`).toBeLessThan(t.id === -61 ? 0.2 : 0.05);
        // a maneuver or a seam between a mission's kernels shows as one bad sample: never more than 200 m
        expect(e[0], `object ${t.id}`).toBeLessThan(0.2);
      }
    });
  }

  it('the giants have every known moon', () => {
    expect(file('jupiter').objects.filter((o) => o.kind === 'moon').length).toBeGreaterThan(90);
    expect(file('saturn').objects.filter((o) => o.kind === 'moon').length).toBeGreaterThan(250);
    expect(file('uranus').objects.filter((o) => o.kind === 'moon').length).toBeGreaterThan(25);
    expect(file('neptune').objects.filter((o) => o.kind === 'moon').length).toBeGreaterThan(14);
  });

  it('the Voyagers have their whole paths, past the planets they visited', () => {
    const v = file('oort').objects;
    for (const id of [-31, -32]) {
      const p = v.find((o) => o.id === id)!.path!;
      expect(p.count).toBeGreaterThan(3000);
      const r = Math.hypot(p.data[3 * (p.count - 1)], p.data[3 * (p.count - 1) + 1], p.data[3 * (p.count - 1) + 2]) / 1.496e8;
      expect(r).toBeGreaterThan(110); // beyond the heliopause
    }
  });

  it('reports nothing outside the window', () => {
    const t = file('mars').tracks[0];
    expect(stateAt(t, t.jd0 - 0.001, new Float64Array(6))).toBe(false);
    expect(stateAt(t, t.jd0 + 0.001, new Float64Array(6))).toBe(true);
  });
});

// JPL Horizons: osculating elements (ICRF) of five irregular moons at 2026-10-10 00:00 UTC,
// and their true positions 6 and 12 days later, fetched 2026-10-10
const IRREGULAR = [{"id":506,"a":11486046.23709687,"e":0.1591160769768627,"i":49.50745004790068,"node":20.85938861486666,"peri":71.69422314579907,"M":23.29832374560826,"n":0.00001656654772755314,"later":[[-6074416.6,4001731.6,6912362.8],[-7537223.5,2891273,6305626.2]]},{"id":511,"a":23467171.68305694,"e":0.259924057651684,"i":143.1780357015086,"node":203.7106454572094,"peri":126.8162313286665,"M":333.1826624267891,"n":0.000005672790305383043,"later":[[-6991185.3,12874676.7,10929978.8],[-5561476.9,13363888.5,10833427.8]]},{"id":609,"a":12900524.7788076,"e":0.1662600999082261,"i":155.7397652568097,"node":197.6500720480697,"peri":296.0559698807206,"M":326.3469503274807,"n":0.00000761570120471501,"later":[[5737450.9,-8472314.7,-4422918.7],[4805197.2,-8890628.9,-4475519.7]]},{"id":717,"a":12222671.35415984,"e":0.4625801649938693,"i":142.8528454443913,"node":224.8605678839875,"peri":341.9984280582505,"M":114.5740261194539,"n":0.000003227459677189739,"later":[[1376091.9,14533585.9,7068966.3],[1597987.5,14637986.9,7006429.6]]},{"id":802,"a":5509437.918163338,"e":0.7460394770456977,"i":27.43933544597481,"node":352.9656925004767,"peri":262.4784231781728,"M":271.8784183189322,"n":0.0000115833486187714,"later":[[-1481468.6,6596063.3,3304587.7],[-1699510.4,6298132.7,3136941.4]]}];

describe('two-body motion for the irregular moons', () => {
  const DEG = Math.PI / 180;
  const epochJd = Date.parse('2026-10-10T00:00:00Z') / 86400000 + 2440587.5;
  for (const m of IRREGULAR) {
    it(`moon ${m.id}: within 0.1% of its distance after 12 days`, () => {
      const el = { epochJd, a: m.a, e: m.e, i: m.i * DEG, node: m.node * DEG, peri: m.peri * DEG, M: m.M * DEG, n: m.n * DEG };
      const s = new Float64Array(6);
      m.later.forEach((ref, k) => {
        keplerState(el, epochJd + 6 * (k + 1), s);
        const err = Math.hypot(s[0] - ref[0], s[1] - ref[1], s[2] - ref[2]);
        // the snapshot reuses elements for up to a week, then covers 10 days ahead: ~17 days of drift
        expect(err / Math.hypot(ref[0], ref[1], ref[2])).toBeLessThan(1e-3);
      });
    });
  }
});

describe("Kepler's equation", () => {
  it('is solved for any mean anomaly, up to e = 0.99', () => {
    for (const e of [0, 0.1, 0.5, 0.8, 0.9, 0.97, 0.99]) {
      for (let M = -40; M <= 40; M += 0.37) {
        const E = eccentricAnomaly(M, e);
        expect(Math.abs(E - e * Math.sin(E) - M)).toBeLessThan(1e-9);
      }
    }
  });

  it('keeps an orbit like Juno’s between its periapsis and apoapsis', () => {
    // a 33-day orbit at e = 0.97: started from E = π without wrapping M, Newton's method
    // wandered and put points of the orbit anywhere inside it
    const mu = 126686531.9, a = 2.95e6, e = 0.97;
    const el = { epochJd: 2461325, a, e, i: 1.6, node: 0.7, peri: 2.1, M: 0.3, n: Math.sqrt(mu / a ** 3) };
    const s = new Float64Array(6);
    for (let d = -60; d <= 60; d += 0.25) {
      keplerState(el, el.epochJd + d, s);
      const r = Math.hypot(s[0], s[1], s[2]);
      expect(r).toBeGreaterThan(a * (1 - e) * 0.999999);
      expect(r).toBeLessThan(a * (1 + e) * 1.000001);
      expect(osculating(Array.from(s), mu).e).toBeCloseTo(e, 6);
    }
  });
});
