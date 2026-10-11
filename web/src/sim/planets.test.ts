import { describe, expect, it } from 'vitest';
import { geocentric, jupiterSystemIII, planetOrientation, VSOP_PLANETS, type PlanetId } from './planets';
import { C_KMS, latLon, mul, precession, transpose, type Vec3 } from './solar';

// JPL Horizons: geometric geocentric vectors (ICRF, km) and the apparent sub-Earth
// point (ObsSub-LON/LAT, planetographic) seen from the geocentre, fetched 2026-10-10.
const HORIZONS = [
  { utc: '2025-03-01T12:00:00Z', mercury: { pos: [164559867.8, -8945047.8, -2820342.8], sub: { lon: 61.531153, lat: -5.842801 } }, venus: { pos: [49634258.3, 6031163.6, 9167280.4], sub: { lon: 322.950292, lat: -7.957597 } }, jupiter: { pos: [230897843.5, 652671755.3, 277322188.9], sub: { lon: 103.226245, lat: 2.980857 } }, saturn: { pos: [1560836198.8, -221063178.1, -153402003.2], sub: { lon: 315.083206, lat: 1.564121 } }, uranus: { pos: [1771824895.4, 2185745503.3, 934396633.9], sub: { lon: 252.599571, lat: 65.615092 } }, neptune: { pos: [4610237274.1, -65525426.2, -139186414.9], sub: { lon: 212.604199, lat: -21.054902 } } },
  { utc: '2026-10-09T00:00:00Z', mercury: { pos: [-121054957, -90783338.1, -47231126], sub: { lon: 198.234652, lat: 3.582561 } }, venus: { pos: [-36304299.9, -23126264.4, -16628235.3], sub: { lon: 318.84742, lat: 8.771127 } }, jupiter: { pos: [-673172965.2, 503480998.6, 228508188.7], sub: { lon: 119.750822, lat: 0.044505 } }, saturn: { pos: [1239383830, 235967489.9, 37141341.6], sub: { lon: 277.477067, lat: -8.933823 } }, uranus: { pos: [1187664773.8, 2338690927.3, 1005593683.4], sub: { lon: 80.354187, lat: 75.926437 } }, neptune: { pos: [4319301558.8, 199227975.5, -30449108.2], sub: { lon: 73.474496, lat: -19.635237 } } },
  { utc: '2027-06-15T06:00:00Z', mercury: { pos: [-7900178.2, 80153578.9, 31446686.2], sub: { lon: 53.935066, lat: 7.157934 } }, venus: { pos: [92905490.9, 210498783.3, 87632736.1], sub: { lon: 178.382647, lat: -0.205867 } }, jupiter: { pos: [-689346882.7, 486925103.2, 226575402.1], sub: { lon: 19.287504, lat: -0.376698 } }, saturn: { pos: [1334002248.6, 594487737.3, 191657586.5], sub: { lon: 28.11285, lat: -16.637931 } }, uranus: { pos: [1215556645, 2564986934.1, 1105805194.1], sub: { lon: 73.418642, lat: 77.104107 } }, neptune: { pos: [4472462955.5, 482662296.3, 89982851.2], sub: { lon: 305.107371, lat: -18.253929 } } },
] as const;

const jd = (iso: string) => Date.parse(iso) / 86400000 + 2440587.5;
const norm = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);
const angleDeg = (a: readonly number[], b: readonly number[]) => (Math.acos(Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (norm(a) * norm(b)))) * 180) / Math.PI;
const lonDiff = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

describe('planets against JPL Horizons', () => {
  for (const h of HORIZONS) {
    const t = jd(h.utc);
    const P = precession(t);
    for (const id of VSOP_PLANETS) {
      const ref = h[id];
      it(`${id} position, ${h.utc}`, () => {
        const g = geocentric(id, t, P);
        expect(angleDeg(g, mul(P, [...ref.pos] as Vec3)) * 3600).toBeLessThan(10); // arcseconds (Venus at its closest: 7″)
        expect(Math.abs(norm(g) - norm(ref.pos)) / norm(ref.pos)).toBeLessThan(2e-5);
      });
      it(`${id} sub-Earth point, ${h.utc}`, () => {
        // apparent: the planet as it was when the light left it
        const tau = norm(ref.pos) / C_KMS / 86400;
        const back = mul(transpose(P), geocentric(id, t - tau, P));
        const R = id === 'jupiter' ? jupiterSystemIII(t - tau) : planetOrientation(id as PlanetId, t - tau);
        const s = latLon(mul(transpose(R), back.map((x) => -x) as Vec3));
        // Horizons gives planetographic longitude, positive west for prograde rotators and east for Venus and Uranus
        const west = id !== 'venus' && id !== 'uranus';
        expect(lonDiff(west ? -s.lon : s.lon, ref.sub.lon)).toBeLessThan(0.2);
        // planetographic vs planetocentric latitude: up to ~6° on Saturn
        expect(Math.abs(s.lat - ref.sub.lat)).toBeLessThan(7);
      });
    }
  }
});
