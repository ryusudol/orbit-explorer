import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BODIES } from './bodies';
import { decodeEphemeris } from './ephemeris';
import { lightTimeS, relayPlan } from './relay';

const tracks = (body: string) => {
  const b = readFileSync(join(__dirname, '..', '..', 'public', 'data', `ephemeris-${body}.bin`));
  return decodeEphemeris(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)).tracks;
};
const site = (body: 'moon' | 'mars', id: string) => BODIES[body].sites.find((s) => s.id === id)!;
// inside the snapshot window
const jd0 = tracks('mars')[0].jd0 + 1;

describe('relay passes', () => {
  it('the Earth never sets at Tranquility Base, and never rises on the far side', () => {
    const near = relayPlan('moon', site('moon', 'apollo11'), [], jd0);
    const earth = near.rows.find((r) => r.key === 'earth')!;
    expect(earth.passes).toHaveLength(1);
    expect(earth.passes[0].end - earth.passes[0].start).toBeCloseTo(1, 3);
    // 23.5° E of the sub-Earth point, so ~66° up, give or take the libration
    expect(earth.now).toBeGreaterThan(55);
    expect(earth.now).toBeLessThan(76);
    const far = relayPlan('moon', site('moon', 'change4'), [], jd0);
    expect(far.rows.find((r) => r.key === 'earth')!.passes).toHaveLength(0);
  });

  it('a Mars rover sees the Earth rise and set once a sol, and low orbiters pass a few times', () => {
    const plan = relayPlan('mars', site('mars', 'jezero'), tracks('mars'), jd0, 24.66);
    const earth = plan.rows.find((r) => r.key === 'earth')!;
    const up = earth.passes.reduce((s, p) => s + (p.end - p.start), 0) * 24;
    expect(up).toBeGreaterThan(8); // hours of the sol with the Earth above the horizon
    expect(up).toBeLessThan(16);
    const mro = plan.rows.find((r) => r.key === -74)!;
    expect(mro.passes.length).toBeGreaterThanOrEqual(1);
    for (const p of mro.passes) {
      expect((p.end - p.start) * 1440).toBeLessThan(16); // minutes: a 250 km orbit crosses the sky fast
      expect(p.peak).toBeGreaterThanOrEqual(10);
    }
  });

  it('light time to Mars is minutes, to the Moon about 1.3 s', () => {
    expect(lightTimeS('moon', jd0)).toBeGreaterThan(1.18);
    expect(lightTimeS('moon', jd0)).toBeLessThan(1.36);
    expect(lightTimeS('mars', jd0) / 60).toBeGreaterThan(3);
    expect(lightTimeS('mars', jd0) / 60).toBeLessThan(23);
  });
});
