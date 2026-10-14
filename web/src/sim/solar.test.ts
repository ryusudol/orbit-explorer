import { describe, expect, it } from 'vitest';
import { C_KMS, latLon, marsGeocentric, marsOrientation, moonGeocentric, moonOrientation, mul, precession, sunGeocentric, transpose, type Vec3 } from './solar';

// JPL Horizons: geometric geocentric vectors (ICRF, km) and the apparent sub-Earth
// point (ObsSub-LON/LAT) seen from the geocenter, fetched 2026-10-09.
const HORIZONS = [
  {
    utc: '2025-03-01T12:00:00Z',
    moon: [362023.991, 4690.34, 4517.091],
    mars: [-37472730.257, 110404282.986, 56552688.05],
    sun: [140002455.643, -44721224.404, -19386843.468],
    moonSub: { lon: 358.707826, lat: -0.423711 },
    marsSub: { lon: 99.378641, lat: 7.408698 },
  },
  {
    utc: '2026-10-09T00:00:00Z',
    moon: [-379972.562, 36062.516, -967.151],
    mars: [-141183611.036, 176925982.948, 81987787.276],
    sun: [-144128907.222, -36300716.441, -15734914.667],
    moonSub: { lon: 4.87939, lat: 3.040737 },
    marsSub: { lon: 318.912496, lat: 16.981696 },
  },
  {
    utc: '2027-06-15T06:00:00Z',
    moon: [-297323.92, -216609.943, -131900.032],
    mars: [-207483796.953, 54833063.144, 27713170.147],
    sun: [17024306.587, 138534075.986, 60050891.614],
    moonSub: { lon: 5.798721, lat: 6.667553 },
    marsSub: { lon: 259.661852, lat: 25.647372 },
  },
] as const;

const jd = (iso: string) => Date.parse(iso) / 86400000 + 2440587.5;
const norm = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);
const angleDeg = (a: readonly number[], b: readonly number[]) => (Math.acos(Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (norm(a) * norm(b)))) * 180) / Math.PI;
const lonDiff = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

describe('analytic ephemerides against JPL Horizons', () => {
  for (const h of HORIZONS) {
    const t = jd(h.utc);
    const P = precession(t);
    const toDate = (v: readonly number[]) => mul(P, [v[0], v[1], v[2]]);

    it(`Moon position, ${h.utc}`, () => {
      const m = moonGeocentric(t);
      expect(angleDeg(m, toDate(h.moon)) * 60).toBeLessThan(3); // arcminutes
      expect(Math.abs(norm(m) - norm(h.moon))).toBeLessThan(40); // km
    });

    it(`Mars position, ${h.utc}`, () => {
      const m = marsGeocentric(t);
      expect(angleDeg(m, toDate(h.mars)) * 60).toBeLessThan(3);
      expect(Math.abs(norm(m) - norm(h.mars)) / norm(h.mars)).toBeLessThan(2e-4);
    });

    it(`Sun position, ${h.utc}`, () => {
      const m = sunGeocentric(t);
      expect(angleDeg(m, toDate(h.sun)) * 60).toBeLessThan(1);
      expect(Math.abs(norm(m) - norm(h.sun)) / norm(h.sun)).toBeLessThan(1e-4);
    });

    it(`Moon sub-Earth point (libration), ${h.utc}`, () => {
      // body-fixed direction to the Earth; light time is 1.3 s, negligible here
      const toEarth = mul(transpose(moonOrientation(t)), mul(transpose(P), moonGeocentric(t)).map((x) => -x) as Vec3);
      const s = latLon(toEarth);
      expect(lonDiff(s.lon, h.moonSub.lon)).toBeLessThan(0.1);
      expect(Math.abs(s.lat - h.moonSub.lat)).toBeLessThan(0.1);
    });

    it(`Mars sub-Earth point, ${h.utc}`, () => {
      // apparent: Mars as it was when the light left it, so turned back by the light time
      const tau = norm(h.mars) / C_KMS / 86400;
      const back = mul(transpose(P), marsGeocentric(t - tau));
      const toEarth = mul(transpose(marsOrientation(t - tau)), back.map((x) => -x) as Vec3);
      const s = latLon(toEarth);
      // Horizons gives Mars longitudes positive west (IAU planetographic)
      expect(lonDiff(-s.lon, h.marsSub.lon)).toBeLessThan(0.1);
      expect(Math.abs(s.lat - h.marsSub.lat)).toBeLessThan(0.5); // planetographic vs planetocentric latitude
    });
  }
});
