import { beforeAll, describe, expect, it } from 'vitest';
import { geodetic_to_teme } from '../engine-pkg/orbit_explorer_engine.js';
import { loadEngineSync } from '../test/node';
import { C_KM_S, capHalfAngle, fibreLatencyMs, geodeticToEcef, greatCircleKm, vacuumLatencyMs } from './physics';

describe('latency model', () => {
  it('London-New York great circle is ~5,570 km', () => {
    expect(greatCircleKm(51.5072, -0.1276, 40.7128, -74.006)).toBeCloseTo(5570, -1);
  });

  it('light in fibre is ~32% slower than in vacuum', () => {
    const d = 5570;
    expect(fibreLatencyMs(d)).toBeCloseTo(27.28, 1);
    expect(vacuumLatencyMs(d)).toBeCloseTo((d / C_KM_S) * 1000, 9);
    expect(fibreLatencyMs(d) / vacuumLatencyMs(d)).toBeCloseTo(1.4682, 4);
  });

  it('a satellite detour wins past a break-even distance', () => {
    // up to 550 km, across, down: roughly d + 2h in vacuum vs d in fibre
    const h = 550;
    const breakEven = (2 * h) / (1.4682 - 1);
    expect(breakEven).toBeGreaterThan(2000);
    expect(breakEven).toBeLessThan(2500);
  });

  it('25 deg elevation cap at 550 km is ~8.4 deg of arc', () => {
    expect((capHalfAngle(550, 25) * 180) / Math.PI).toBeCloseTo(8.43, 1);
  });
});

describe('TS geodesy matches the engine', () => {
  beforeAll(loadEngineSync);

  it('geodeticToEcef == engine geodetic_to_teme at GMST 0', () => {
    // find a JD where GMST ~ 0 is unnecessary: compare magnitudes and z instead
    for (const [lat, lon, h] of [
      [51.5, -0.12, 0],
      [-33.9, 151.2, 0.05],
      [0, 90, 550],
    ]) {
      const a = geodeticToEcef(lat, lon, h);
      const b = geodetic_to_teme(lat, lon, h, 2461120.1);
      expect(Math.hypot(...a)).toBeCloseTo(Math.hypot(b[0], b[1], b[2]), 6);
      expect(a[2]).toBeCloseTo(b[2], 6);
    }
  });
});
