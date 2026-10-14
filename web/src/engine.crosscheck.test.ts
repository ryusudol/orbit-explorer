// Independent check of the WASM SGP4 against satellite.js (a separate port of
// the same reference) on real catalog objects: LEO, MEO, GEO and HEO, with
// times from 1 day before to 3 days after epoch.
//
// Set WRITE_VALIDATION=1 to also write docs/validation/satellitejs-diff.csv.
import { writeFileSync } from 'node:fs';
import { json2satrec, sgp4 } from 'satellite.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { Propagator, gmst, sun_position_teme, teme_to_geodetic } from './engine-pkg/orbit_explorer_engine.js';
import { ELEMENT_STRIDE } from './sim/catalog';
import { jdToMs } from './sim/time';
import { loadEngineSync, loadSnapshot } from './test/node';

describe('SGP4 vs satellite.js', () => {
  beforeAll(loadEngineSync);

  it('agrees to well under a meter across the catalog', () => {
    const c = loadSnapshot();
    const step = Math.max(1, Math.floor(c.count / 2500));
    const offsetsMin = [-1440, -60, 0, 90, 720, 1440, 4320];
    const rows: string[] = ['norad,period_min,tsince_min,dr_mm'];
    let worst = 0;
    let compared = 0;
    for (let i = 0; i < c.count; i += step) {
      const e = c.packed.subarray(i * ELEMENT_STRIDE, (i + 1) * ELEMENT_STRIDE);
      const epochIso = new Date(Math.round(jdToMs(e[0]))).toISOString().replace('Z', '');
      const sr = json2satrec({
        OBJECT_NAME: c.names[i],
        OBJECT_ID: '',
        EPOCH: epochIso,
        MEAN_MOTION: e[1],
        ECCENTRICITY: e[2],
        INCLINATION: e[3],
        RA_OF_ASC_NODE: e[4],
        ARG_OF_PERICENTER: e[5],
        MEAN_ANOMALY: e[6],
        EPHEMERIS_TYPE: 0,
        CLASSIFICATION_TYPE: 'U',
        NORAD_CAT_ID: c.ids[i],
        ELEMENT_SET_NO: 999,
        REV_AT_EPOCH: 0,
        BSTAR: e[7],
        MEAN_MOTION_DOT: 0,
        MEAN_MOTION_DDOT: 0,
      });
      const ours = new Propagator(e.slice());
      for (const t of offsetsMin) {
        const jd = e[0] + t / 1440;
        const tsince = (jd - e[0]) * 1440; // identical arithmetic to the engine
        const mine = ours.state_at(0, jd);
        const theirs = sgp4(sr, tsince);
        if (!mine.length || !theirs || typeof theirs.position !== 'object') continue;
        const p = theirs.position;
        const dr = Math.hypot(mine[0] - p.x, mine[1] - p.y, mine[2] - p.z);
        worst = Math.max(worst, dr);
        compared++;
        rows.push(`${c.ids[i]},${(1440 / e[1]).toFixed(2)},${t},${(dr * 1e6).toExponential(4)}`);
      }
      ours.free();
    }
    if (process.env.WRITE_VALIDATION) writeFileSync(new URL('../../docs/validation/satellitejs-diff.csv', import.meta.url), rows.join('\n') + '\n');
    console.log(`satellite.js cross-check: ${compared} states, max |dr| = ${(worst * 1e6).toFixed(3)} mm`);
    expect(compared).toBeGreaterThan(10_000);
    expect(worst).toBeLessThan(1e-3); // < 1 m, and in practice far less
  });

  it('frames and Sun behave', () => {
    // GMST at J2000.0 = 280.46 deg
    expect((gmst(2451545.0) * 180) / Math.PI).toBeCloseTo(280.46062, 3);
    // equinox: Sun near the equator, ~1 AU
    const s = sun_position_teme(2461120.1);
    const r = Math.hypot(s[0], s[1], s[2]);
    expect(r / 149_597_870.7).toBeGreaterThan(0.98);
    expect(Math.abs(Math.asin(s[2] / r) * (180 / Math.PI))).toBeLessThan(1.5);
    // a point above the north pole is at latitude 90
    const g = teme_to_geodetic(0, 0, 7000, 2461120.1);
    expect(g[0]).toBeCloseTo(90, 6);
    expect(g[2]).toBeCloseTo(7000 - 6356.752, 2);
  });
});
