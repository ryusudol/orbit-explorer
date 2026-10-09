#!/usr/bin/env node
// Snapshots the trajectories of the spacecraft orbiting the Moon and Mars, and of
// Mars' two moons, from JPL Horizons (https://ssd.jpl.nasa.gov/horizons/).
//
// There is no TLE/SGP4 equivalent beyond Earth: Horizons serves the missions' own
// reconstructed and predicted trajectories (the navigation teams' SPICE kernels).
// Each object is sampled as position + velocity at a fixed step over a window
// around now, and the app Hermite-interpolates between samples, as it does for
// the SGP4 keyframes. Predictions end where each mission's published kernel does,
// so an object's window may be shorter than requested.
//
// Output, one file per central body (web/public/data/ephemeris-{moon,mars}.bin),
// little-endian:
//   header 16 B : "EPH1" | u32 count | f64 generatedUnixMs
//   per object  : i32 Horizons id | u32 samples | f64 jd0 (UTC) | f64 step (s)
//                 f32[samples * 6] x, y, z (km), vx, vy, vz (km/s), relative to
//                 the body's centre, ICRF axes
// float32 keeps ~1 mm at the 45,000 km of the farthest orbiter.

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';

/** Window around now: two days back (the time bar reaches −24 h), ten ahead so a stale snapshot still covers today. */
const BACK_DAYS = 2;
const AHEAD_DAYS = 10;

// step: ≥ ~40 samples per orbit at periapsis speed keeps cubic Hermite well under 50 m
export const BODIES = {
  moon: {
    center: 301,
    objects: [
      { id: -85, step: 180 }, // LRO
      { id: -152, step: 180 }, // Chandrayaan-2 orbiter
      { id: -155, step: 180 }, // Danuri (KPLO)
      { id: -192, step: 180 }, // ARTEMIS P1 (THEMIS-B)
      { id: -193, step: 180 }, // ARTEMIS P2 (THEMIS-C)
    ],
  },
  mars: {
    center: 499,
    objects: [
      { id: 401, step: 300 }, // Phobos
      { id: 402, step: 600 }, // Deimos
      { id: -74, step: 180 }, // Mars Reconnaissance Orbiter
      { id: -53, step: 180 }, // Mars Odyssey
      { id: -143, step: 180 }, // ExoMars Trace Gas Orbiter
      { id: -41, step: 180 }, // Mars Express
      { id: -62, step: 600 }, // Emirates Mars Mission (Hope)
    ],
  },
};

const JD_UNIX = 2440587.5;
const jdOf = (ms) => ms / 86400000 + JD_UNIX;
const iso = (jd) => new Date((jd - JD_UNIX) * 86400000).toISOString().replace('T', ' ').slice(0, 19);
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

async function horizons(params) {
  const q = new URLSearchParams({ format: 'json' });
  for (const [k, v] of Object.entries(params)) q.set(k, `'${v}'`);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}?${q}`);
    if (res.ok) return (await res.json()).result;
    if (attempt >= 3) throw new Error(`Horizons HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
}

/** "No ephemeris for target ... after A.D. 2026-OCT-27 13:10:00.0000 TDB" -> { side, jd } (TDB ≈ UTC + 69 s). */
function coverageLimit(text) {
  const m = /No ephemeris for target .*?(prior to|after) A\.D\. (\d{4})-([A-Z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
  if (!m) return null;
  const ms = Date.UTC(+m[2], MONTHS[m[3]], +m[4], +m[5], +m[6], 0) + parseFloat(m[7]) * 1000 - 69_184;
  return { side: m[1] === 'after' ? 'end' : 'start', jd: jdOf(ms) };
}

async function sample(center, { id, step }, jd0, jd1) {
  const stepDays = step / 86400;
  for (let tries = 0; tries < 3; tries++) {
    const n = Math.floor((jd1 - jd0) / stepDays) + 1;
    const text = await horizons({
      COMMAND: id,
      CENTER: `500@${center}`,
      EPHEM_TYPE: 'VECTORS',
      OBJ_DATA: 'NO',
      REF_PLANE: 'FRAME',
      REF_SYSTEM: 'ICRF',
      TIME_TYPE: 'UT',
      VEC_TABLE: '2',
      VEC_CORR: 'NONE',
      OUT_UNITS: 'KM-S',
      CSV_FORMAT: 'YES',
      START_TIME: `JD ${jd0.toFixed(6)}`,
      STOP_TIME: `JD ${(jd0 + (n - 1) * stepDays).toFixed(6)}`,
      STEP_SIZE: `${n - 1}`,
    });
    const limit = coverageLimit(text);
    if (limit) {
      // clip to the published span, on the step grid, with a step of margin
      if (limit.side === 'end') jd1 = jd0 + (Math.floor((limit.jd - jd0) / stepDays) - 1) * stepDays;
      else jd0 = jd0 + (Math.ceil((limit.jd - jd0) / stepDays) + 1) * stepDays;
      if (jd1 <= jd0) return null;
      continue;
    }
    const body = text.split('$$SOE')[1]?.split('$$EOE')[0];
    if (!body) throw new Error(`Horizons: no vectors for ${id}\n${text.slice(0, 800)}`);
    const name = /Target body name: (.+?)\s*\{source/.exec(text)?.[1] ?? String(id);
    const rows = body.trim().split('\n').map((l) => l.split(',').map((s) => s.trim()));
    const out = new Float32Array(rows.length * 6);
    rows.forEach((r, k) => {
      for (let j = 0; j < 6; j++) out[6 * k + j] = parseFloat(r[2 + j]);
    });
    const first = parseFloat(rows[0][0]);
    if (Math.abs(first - jd0) > 1e-6) throw new Error(`${name}: first sample at JD ${first}, expected ${jd0}`);
    return { id, name, jd0, step, data: out };
  }
  return null;
}

function encode(series) {
  const size = 16 + series.reduce((s, o) => s + 24 + o.data.byteLength, 0);
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  new Uint8Array(buf, 0, 4).set(new TextEncoder().encode('EPH1'));
  dv.setUint32(4, series.length, true);
  dv.setFloat64(8, Date.now(), true);
  let o = 16;
  for (const s of series) {
    dv.setInt32(o, s.id, true);
    dv.setUint32(o + 4, s.data.length / 6, true);
    dv.setFloat64(o + 8, s.jd0, true);
    dv.setFloat64(o + 16, s.step, true);
    o += 24;
    new Float32Array(buf, o, s.data.length).set(s.data);
    o += s.data.byteLength;
  }
  return new Uint8Array(buf);
}

// the window starts on a whole hour so every object's grid lines up
const hour = 3600_000;
const start = jdOf(Math.floor((Date.now() - BACK_DAYS * 86400_000) / hour) * hour);
const end = start + BACK_DAYS + AHEAD_DAYS;

for (const [body, { center, objects }] of Object.entries(BODIES)) {
  const series = [];
  for (const obj of objects) {
    const s = await sample(center, obj, start, end);
    if (!s) {
      console.warn(`${body}: ${obj.id} has no trajectory in ${iso(start)} – ${iso(end)} UTC; skipped`);
      continue;
    }
    const n = s.data.length / 6;
    console.log(`${body}: ${s.name.padEnd(42)} ${String(n).padStart(5)} samples, ${iso(s.jd0)} – ${iso(s.jd0 + ((n - 1) * s.step) / 86400)} UTC`);
    series.push(s);
  }
  const bytes = encode(series);
  const path = join(root, 'web', 'public', 'data', `ephemeris-${body}.bin`);
  await writeFile(path, bytes);
  console.log(`${path.replace(root + '/', '')}: ${(bytes.length / 1024).toFixed(0)} KiB`);
}
