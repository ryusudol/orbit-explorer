import { describe, expect, it } from 'vitest';
import { travelDuration, travelPose, unit, type TravelPlan, type V3 } from './travel';

const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

describe('travel between worlds', () => {
  const cases: [string, V3, number, number, number][] = [
    // name, B from A, start distance from A, A's radius, B's radius
    ['Earth → Moon', [-379972, 36062, -967], 26000, 6378, 1737],
    ['Moon → Earth', [379972, -36062, 967], 9000, 1737, 6378],
    ['Earth → Mars', [-1.41e8, 1.77e8, 0.82e8], 26000, 6378, 3390],
    ['Earth → Saturn', [1.3e9, -3.1e8, -1.9e8], 26000, 6378, 60268],
  ];
  for (const [name, B, r0, RA, RB] of cases) {
    // worst case: start on the far side of A, looking at it
    const plan: TravelPlan = { from: unit(B).map((x) => -x * r0) as V3, look: unit(B), toDir: unit([0.3, -0.8, 0.5]), toDist: 3 * RB, dur: 0 };
    plan.look = unit(plan.from).map((x) => -x) as V3;

    it(`${name}: starts and ends exactly where planned`, () => {
      const a = travelPose(plan, 0, B), b = travelPose(plan, 1, B);
      expect(len(sub(a.pos, plan.from))).toBeLessThan(1e-6 * r0);
      expect(len(sub(b.pos, B.map((x, i) => x + plan.toDir[i] * plan.toDist) as V3))).toBeLessThan(1e-6 * len(B));
      expect(len(sub(a.look, plan.look))).toBeLessThan(1e-9);
    });

    it(`${name}: never enters either body and never jumps`, () => {
      let prev = travelPose(plan, 0, B).pos;
      const N = 4000;
      let maxStep = 0;
      for (let k = 1; k <= N; k++) {
        const { pos } = travelPose(plan, k / N, B);
        expect(len(pos)).toBeGreaterThan(RA);
        expect(len(sub(pos, B))).toBeGreaterThan(RB);
        // relative step: movement per sample compared with the distance to the nearer body
        const near = Math.min(len(pos), len(sub(pos, B)));
        maxStep = Math.max(maxStep, len(sub(pos, prev)) / near);
        prev = pos;
      }
      // a few percent of the current scale per 1/4000 of the flight: smooth at any frame rate
      expect(maxStep).toBeLessThan(0.05);
    });
  }

  // out to the Oort cloud (the Sun at its center, the camera 60,000 au out) and back in
  const AU = 1.495978707e8;
  const zooms: [string, V3, number, number, number, number, V3][] = [
    // name, B from A, start distance, end distance, A's radius, B's radius, arrival direction
    ['Earth → Oort cloud', [1.2e8, -8e7, -3.5e7], 26000, 6e4 * AU, 6378, 695700, unit([0.1, -0.5, 0.86])],
    ['Oort cloud → Earth', [-1.2e8, 8e7, 3.5e7], 6e4 * AU, 26000, 695700, 6378, unit([0.3, -0.8, 0.5])],
    ['Oort cloud → Neptune', [4.4e9, 5e8, -1e8], 9e4 * AU, 120000, 695700, 24764, unit([-0.2, 0.9, 0.3])],
  ];
  for (const [name, B, r0, r1, RA, RB, toDir] of zooms) {
    // worst case: start looking straight at the far world, from its side
    const plan: TravelPlan = { from: unit(B).map((x) => x * r0) as V3, look: unit(B).map((x) => -x) as V3, toDir, toDist: r1, dur: 0 };
    it(`${name}: starts and ends exactly where planned`, () => {
      const a = travelPose(plan, 0, B), b = travelPose(plan, 1, B);
      expect(len(sub(a.pos, plan.from))).toBeLessThan(1e-6 * r0);
      expect(len(sub(b.pos, B.map((x, i) => x + toDir[i] * r1) as V3))).toBeLessThan(1e-6 * Math.max(r1, len(B)));
    });
    it(`${name}: never enters either body and never jumps`, () => {
      let prev = travelPose(plan, 0, B).pos;
      let maxStep = 0;
      const N = 8000;
      for (let k = 1; k <= N; k++) {
        const { pos } = travelPose(plan, k / N, B);
        expect(len(pos)).toBeGreaterThan(RA);
        expect(len(sub(pos, B))).toBeGreaterThan(RB);
        const near = Math.min(len(pos), len(sub(pos, B)));
        maxStep = Math.max(maxStep, len(sub(pos, prev)) / near);
        prev = pos;
      }
      expect(maxStep).toBeLessThan(0.05);
    });
  }

  it('takes longer to go farther', () => {
    expect(travelDuration(26000, 5000, 384400)).toBeLessThan(3500);
    expect(travelDuration(26000, 10000, 2.5e8)).toBeGreaterThan(4000);
    expect(travelDuration(26000, 10000, 2.5e8)).toBeLessThan(6000);
  });
});
