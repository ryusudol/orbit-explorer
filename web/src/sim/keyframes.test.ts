// The render loop never runs SGP4 per object per frame; it interpolates
// keyframes. These tests pin down how much accuracy that costs.
import { beforeAll, describe, expect, it } from 'vitest';
import { Propagator } from '../engine-pkg/kessler_engine.js';
import { loadEngineSync, loadSnapshot } from '../test/node';
import { ELEMENT_STRIDE, subset } from './catalog';
import { createKeyframes, extrapolate, hermite } from './keyframes';
import { msToJd } from './time';

describe('keyframe interpolation', () => {
  let prop: Propagator;
  let n = 0;
  let jd0 = 0;

  beforeAll(() => {
    loadEngineSync();
    const c = loadSnapshot();
    // 600 LEO objects (the hardest case: fastest angular rate)
    const leo = subset(c, (i) => c.packed[i * ELEMENT_STRIDE + 1] > 14.5 && i % 7 === 0);
    const take = leo.packed.slice(0, 600 * ELEMENT_STRIDE);
    prop = new Propagator(take);
    n = prop.len();
    jd0 = msToJd(c.generatedMs);
  });

  function worstError(spacingS: number, mode: 'hermite' | 'extrapolate') {
    const kf = createKeyframes(n);
    const fill = (slot: number, jd: number) => {
      for (let i = 0; i < n; i++) {
        const s = prop.state_at(i, jd);
        kf.pos.set(s.subarray(0, 3), slot * 3 * n + 3 * i);
        kf.vel.set(s.subarray(3, 6), slot * 3 * n + 3 * i);
        kf.status[slot * n + i] = s.length ? 0 : 1;
      }
    };
    const h = spacingS / 86400;
    fill(0, jd0);
    fill(1, jd0 + h);
    const out = new Float64Array(3 * n);
    const valid = new Uint8Array(n);
    let worst = 0;
    for (const f of [0.25, 0.5, 0.75]) {
      if (mode === 'hermite') hermite(kf, 0, 1, f, spacingS, out, valid);
      else extrapolate(kf, 0, f * spacingS, out, valid);
      for (let i = 0; i < n; i++) {
        if (!valid[i]) continue;
        const s = prop.state_at(i, jd0 + f * h);
        worst = Math.max(worst, Math.hypot(out[3 * i] - s[0], out[3 * i + 1] - s[1], out[3 * i + 2] - s[2]));
      }
    }
    return worst;
  }

  it('is about a metre at 60 s spacing', () => {
    const e = worstError(60, 'hermite');
    console.log(`hermite, 60 s keyframes: worst ${(e * 1e3).toFixed(3)} m`);
    expect(e).toBeLessThan(0.002); // km
  });

  it('stays under half a kilometre at 300 s spacing (1 h/s time warp)', () => {
    const e = worstError(300, 'hermite');
    console.log(`hermite, 300 s keyframes: worst ${(e * 1e3).toFixed(1)} m`);
    expect(e).toBeLessThan(0.5);
  });

  it('beats plain extrapolation by orders of magnitude', () => {
    const e = worstError(60, 'extrapolate');
    expect(e).toBeGreaterThan(worstError(60, 'hermite') * 100);
  });
});
