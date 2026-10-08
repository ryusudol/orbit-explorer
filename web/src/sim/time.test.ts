import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimClock } from './time';

const T0 = Date.UTC(2026, 9, 7, 12);

describe('SimClock', () => {
  let perf = 0, wall = T0;
  const advance = (ms: number, { sleep = false } = {}) => {
    wall += ms;
    if (!sleep) perf += ms; // performance.now() stands still while the machine sleeps
  };

  beforeEach(() => {
    perf = 1000;
    wall = T0;
    vi.spyOn(performance, 'now').mockImplementation(() => perf);
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps real time across a gap with no frames (hidden tab)', () => {
    const c = new SimClock();
    advance(16);
    c.tick();
    advance(180_000);
    c.tick();
    expect(c.timeMs).toBe(T0 + 180_016);
  });

  it('follows the wall clock when the monotonic clock stops during sleep', () => {
    const c = new SimClock();
    advance(600_000, { sleep: true });
    c.tick();
    expect(c.timeMs).toBe(T0 + 600_000);
    advance(16);
    c.tick();
    expect(c.timeMs).toBe(T0 + 600_016);
  });

  it('applies each rate only to the time it was in effect, and holds while paused', () => {
    const c = new SimClock();
    advance(1000);
    c.rate = 60;
    advance(1000);
    c.paused = true;
    advance(5000);
    c.tick();
    expect(c.timeMs).toBe(T0 + 1000 + 60_000);
    c.paused = false;
    advance(1000);
    c.tick();
    expect(c.timeMs).toBe(T0 + 1000 + 120_000);
  });

  it('jump resets the anchor and bumps the generation', () => {
    const c = new SimClock();
    c.rate = 10;
    c.jump(T0 - 3_600_000);
    advance(500);
    c.tick();
    expect(c.timeMs).toBe(T0 - 3_600_000 + 5000);
    expect(c.generation).toBe(1);
  });
});
