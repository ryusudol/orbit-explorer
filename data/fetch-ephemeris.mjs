#!/usr/bin/env node
// Snapshots everything that orbits a world other than the Earth, from JPL
// Horizons (https://ssd.jpl.nasa.gov/horizons/): the spacecraft at the Moon,
// Mercury, Mars and Jupiter, every known moon of Mars and the giant planets, and
// the two Voyagers on their way out of the solar system.
//
// There is no TLE/SGP4 equivalent beyond Earth: Horizons serves the missions' own
// reconstructed and predicted trajectories (the navigation teams' SPICE kernels)
// and JPL's satellite ephemerides. Three kinds of record:
//
//   track     position + velocity at a fixed step over a window around now; the
//             app Hermite-interpolates between samples, as for the SGP4 keyframes.
//             Spacecraft, and every moon that goes around in under 20 days (the
//             step keeps ≥ ~96 samples per orbit).
//   elements  osculating Keplerian elements at one epoch, for the ~400 small
//             irregular moons whose orbits take months to years. The Sun's pull
//             changes those orbits over years, so two-body motion is good to a
//             few hundred km across the window (sim/ephemeris.test.ts measures it),
//             and one request each instead of a thousand samples.
//   path      positions only, every 5 days since launch: the Voyagers' whole
//             journey past the giant planets, for drawing, not for interpolating.
//
// Predictions end where each mission's published kernel does, so a spacecraft's
// window may be shorter than requested.
//
// The moon rosters come from JPL's satellite mean-element table (names, ids and
// periods; https://ssd.jpl.nasa.gov/sats/elem/) and its discovery table (who and
// when). Both are cached for 30 days, and the irregular moons' elements for 7, so
// a deploy every 6 hours asks Horizons for ~100 tracks, not ~500 objects.
//
// Output, one file per world (web/public/data/ephemeris-{body}.bin), little-endian:
//   "EPH2" | u32 json bytes | JSON metadata, padded to 8 bytes | binary blocks
//   JSON: { generatedMs, objects: [{ id, name, kind, radiusKm?, found?, track?, elements?, path? }] }
//     track    { jd0 (UTC), stepS, count, offset, f64? }: f32[count * 6] x, y, z (km), vx, vy, vz (km/s)
//              (f64 for the Voyagers: float32 resolves only ~2,000 km at 170 au)
//     path     { jd0 (UTC), stepS, count, offset }: f32[count * 3] x, y, z (km)
//   blocks start on 8-byte boundaries
//     elements { epochJd (UTC), a (km), e, i, node, peri, M (rad), n (rad/s) }
//   relative to the world's center (the Sun's for the Voyagers), ICRF axes.
// float32 keeps ~1 mm at 45,000 km and ~4 m at Callisto's 1.9 million km.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, 'data', 'cache', 'horizons');
mkdirSync(cacheDir, { recursive: true });
const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';

/** Window around now: two days back (the time bar reaches −24 h), ten ahead so a stale snapshot still covers today. */
const BACK_DAYS = 2;
const AHEAD_DAYS = 10;
/** Moons faster than this get a sampled track; slower ones get elements. */
const TRACK_MAX_PERIOD_D = 20;

// curated objects, with their steps: ≥ ~40 samples per orbit at periapsis speed keeps cubic Hermite well under 50 m
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
  mercury: {
    center: 199,
    // BepiColombo is still arriving, in a loose capture the Sun shapes as much as Mercury does,
    // so its path is drawn from the track alone: a longer window shows the approach and capture
    objects: [{ id: -121, step: 300, back: 20, ahead: 30 }],
  },
  // nothing orbits Venus: Akatsuki's trajectory ends in August 2025, and Venus has no moons
  venus: { center: 299, objects: [] },
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
  jupiter: {
    center: 599,
    roster: 'Jupiter',
    // Juno swings down to ~4,000 km above the clouds at 58 km/s once a month
    objects: [{ id: -61, step: 120 }],
  },
  saturn: { center: 699, roster: 'Saturn', objects: [] },
  uranus: { center: 799, roster: 'Uranus', objects: [] },
  neptune: { center: 899, roster: 'Neptune', objects: [] },
  // the Sun's: the two spacecraft that have left the heliosphere
  oort: {
    center: 10,
    objects: [
      // float64: at 170 au float32 only resolves ~2,000 km
      { id: -31, step: 86400, f64: true, path: { from: '1977-09-06', step: 5 } }, // Voyager 1
      { id: -32, step: 86400, f64: true, path: { from: '1977-08-21', step: 5 } }, // Voyager 2
    ],
  },
};

const JD_UNIX = 2440587.5;
const jdOf = (ms) => ms / 86400000 + JD_UNIX;
const iso = (jd) => new Date((jd - JD_UNIX) * 86400000).toISOString().replace('T', ' ').slice(0, 19);
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const DEG = Math.PI / 180;
/** TT − UTC since 2017; TDB differs from TT by < 2 ms. */
const TT_MINUS_UTC_D = 69.184 / 86400;

async function horizons(params) {
  const q = new URLSearchParams({ format: 'json' });
  for (const [k, v] of Object.entries(params)) q.set(k, `'${v}'`);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}?${q}`).catch((e) => ({ ok: false, status: e.message }));
    if (res.ok) return (await res.json()).result;
    if (attempt >= 6) throw new Error(`Horizons HTTP ${res.status}`);
    // 503 means busy: back off and try again
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
}

/** Runs `fn` over `items`, `n` at a time, keeping order. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const k = next++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

/** A text file from the web, cached for `days`. */
async function cachedText(url, file, days) {
  const p = join(cacheDir, file);
  if (existsSync(p) && Date.now() - statSync(p).mtimeMs < days * 864e5) return readFileSync(p, 'utf8');
  const res = await fetch(url);
  if (!res.ok) {
    if (existsSync(p)) return readFileSync(p, 'utf8'); // stale beats nothing
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  const text = await res.text();
  writeFileSync(p, text);
  return text;
}

/** "No ephemeris for target ... after A.D. 2026-OCT-27 13:10:00.0000 TDB" -> { side, jd } (TDB ≈ UTC + 69 s). */
function coverageLimit(text) {
  const m = /No ephemeris for target .*?(prior to|after) A\.D\. (\d{4})-([A-Z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
  if (!m) return null;
  const ms = Date.UTC(+m[2], MONTHS[m[3]], +m[4], +m[5], +m[6], 0) + parseFloat(m[7]) * 1000 - 69_184;
  return { side: m[1] === 'after' ? 'end' : 'start', jd: jdOf(ms) };
}

const targetName = (text, id) => /Target body name: (.+?)\s*\{source/.exec(text)?.[1].replace(/\s*\(-?\d+\)\s*$/, '').replace(/\s*\(spacecraft\)\s*$/i, '').trim() ?? String(id);

/** Mean radius from Horizons' object data, or an estimate from V(1,0) at a dark irregular moon's albedo (0.04). */
function radiusOf(text) {
  const r = /(?:Mean )?Radius \(km\)\s*=\s*([\d.]+)(?:\s*x\s*([\d.]+)\s*x\s*([\d.]+))?/i.exec(text);
  if (r) return r[2] ? (+r[1] + +r[2] + +r[3]) / 3 : +r[1];
  const v = /V\(1,0\)\s*=\s*\+?([\d.]+)/.exec(text);
  if (v) return ((1329 / Math.sqrt(0.04)) * 10 ** (-+v[1] / 5)) / 2;
  return undefined;
}

/** Position + velocity (or positions only) every `step` s over [jd0, jd1], clipped to the published span. */
async function sample(center, id, step, jd0, jd1, positionsOnly = false, f64 = false) {
  const stepDays = step / 86400;
  for (let tries = 0; tries < 4; tries++) {
    const n = Math.floor((jd1 - jd0) / stepDays + 1e-9) + 1;
    const text = await horizons({
      COMMAND: id,
      CENTER: `500@${center}`,
      EPHEM_TYPE: 'VECTORS',
      OBJ_DATA: 'YES',
      REF_PLANE: 'FRAME',
      REF_SYSTEM: 'ICRF',
      TIME_TYPE: 'UT',
      VEC_TABLE: positionsOnly ? '1' : '2',
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
    const rows = body.trim().split('\n').map((l) => l.split(',').map((s) => s.trim()));
    const width = positionsOnly ? 3 : 6;
    const out = new (f64 ? Float64Array : Float32Array)(rows.length * width);
    rows.forEach((r, k) => {
      for (let j = 0; j < width; j++) out[width * k + j] = parseFloat(r[2 + j]);
    });
    const first = parseFloat(rows[0][0]);
    if (Math.abs(first - jd0) > 1e-6) throw new Error(`${id}: first sample at JD ${first}, expected ${jd0}`);
    return { name: targetName(text, id), radiusKm: radiusOf(text), jd0, step, data: out };
  }
  return null;
}

/** Osculating elements about the center at `jd` (ICRF), plus the name and size. */
async function elements(center, id, jd) {
  const text = await horizons({
    COMMAND: id,
    CENTER: `500@${center}`,
    EPHEM_TYPE: 'ELEMENTS',
    OBJ_DATA: 'YES',
    REF_PLANE: 'FRAME',
    OUT_UNITS: 'KM-S',
    CSV_FORMAT: 'YES',
    // the elements table only takes TDB: ask for the UTC epoch's TDB instant
    TLIST: `${(jd + TT_MINUS_UTC_D).toFixed(8)}`,
  });
  const row = text.split('$$SOE')[1]?.split('$$EOE')[0]?.trim().split(',').map((s) => s.trim());
  if (!row) return null;
  // JDTDB, date, EC, QR, IN, OM, W, Tp, N (deg/s), MA, TA, A, AD, PR
  const [e, , inc, node, peri, , n, M, , a] = row.slice(2).map(Number);
  return { name: targetName(text, id), radiusKm: radiusOf(text), elements: { epochJd: jd, a, e, i: inc * DEG, node: node * DEG, peri: peri * DEG, M: M * DEG, n: n * DEG } };
}

/**
 * Is the first sample within 100 million km of the center? A moon too new for
 * JPL's satellite kernels can share its number with an asteroid, and Horizons
 * then answers for the asteroid.
 */
const nearby = (data, width) => Math.hypot(data[0], data[1], data[2]) < 1e8 && width > 0;

// ------------------------------------------------------------------ rosters

const cells = (row) => [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim());
const rows = (html) => [...(html.match(/<table[\s\S]*?<\/table>/)?.[0] ?? '').matchAll(/<tr[\s\S]*?<\/tr>/g)].map((m) => cells(m[0]));
/** "S2011_J_4", "S/2011 J4" and "S2011_J4" all name the same moon */
const key = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Every known moon of each planet: Horizons id, period (days), and who found it when. */
async function rosters() {
  const elem = rows(await cachedText('https://ssd.jpl.nasa.gov/sats/elem/', 'sats-elem.html', 30));
  const disc = rows(await cachedText('https://ssd.jpl.nasa.gov/sats/discovery.html', 'sats-discovery.html', 30));
  const found = new Map();
  for (const r of disc) {
    if (r.length < 5 || !/^\d{4}$/.test(r[3])) continue;
    const info = { year: +r[3], by: r[4].split(',')[0].trim(), name: r[1] || r[2] };
    if (r[1]) found.set(key(r[1]), info);
    if (r[2]) found.set(key(r[2]), info);
  }
  const out = {};
  const seen = new Set();
  for (const r of elem) {
    if (r.length < 14 || !/^\d+$/.test(r[3])) continue;
    const [, planet, name, code] = r;
    if (seen.has(code)) continue; // a moon listed in two frames
    seen.add(code);
    const f = found.get(key(name));
    (out[planet] ??= []).push({ id: +code, periodD: +r[13], found: f ? { year: f.year, by: f.by } : undefined, display: f?.name ?? name });
  }
  return out;
}

// ------------------------------------------------------------------ encode

function encode(objects) {
  const blocks = [];
  let offset = 0;
  const meta = objects.map((o) => {
    const m = { id: o.id, name: o.name, kind: o.kind };
    if (o.radiusKm) m.radiusKm = +o.radiusKm.toFixed(2);
    if (o.found) m.found = o.found;
    if (o.elements) m.elements = o.elements;
    for (const k of ['track', 'path']) {
      const s = o[k];
      if (!s) continue;
      const width = k === 'track' ? 6 : 3;
      m[k] = { jd0: s.jd0, stepS: s.step, count: s.data.length / width, offset };
      if (s.data instanceof Float64Array) m[k].f64 = true;
      blocks.push(s.data);
      // keep every block on an 8-byte boundary for Float64Array views
      offset += Math.ceil(s.data.byteLength / 8) * 8;
    }
    return m;
  });
  const json = new TextEncoder().encode(JSON.stringify({ generatedMs: Date.now(), objects: meta }));
  const head = 8 + Math.ceil(json.length / 8) * 8;
  const buf = new Uint8Array(head + offset);
  buf.set(new TextEncoder().encode('EPH2'), 0);
  new DataView(buf.buffer).setUint32(4, json.length, true);
  buf.set(json, 8);
  let o = head;
  for (const b of blocks) {
    buf.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), o);
    o += Math.ceil(b.byteLength / 8) * 8;
  }
  return buf;
}

// ------------------------------------------------------------------ main

// the window starts on a whole hour so every object's grid lines up
const hour = 3600_000;
const start = jdOf(Math.floor((Date.now() - BACK_DAYS * 86400_000) / hour) * hour);
const end = start + BACK_DAYS + AHEAD_DAYS;
const only = process.argv.slice(2);
const roster = Object.entries(BODIES).some(([name, b]) => b.roster && (!only.length || only.includes(name))) ? await rosters() : {};

for (const [body, cfg] of Object.entries(BODIES)) {
  if (only.length && !only.includes(body)) continue;
  const { center } = cfg;
  const objects = [];
  // curated spacecraft and moons
  for (const obj of cfg.objects) {
    // a longer window where asked, on the same hourly grid
    const from = obj.back ? start - (obj.back - BACK_DAYS) : start;
    const to = obj.ahead ? start + BACK_DAYS + obj.ahead : end;
    const s = await sample(center, obj.id, obj.step, from, to, false, obj.f64);
    if (!s) {
      console.warn(`${body}: ${obj.id} has no trajectory in ${iso(from)} – ${iso(to)} UTC; skipped`);
      continue;
    }
    const o = { id: obj.id, name: s.name, kind: obj.id < 0 ? 'spacecraft' : 'moon', radiusKm: obj.id > 0 ? s.radiusKm : undefined, track: s };
    if (obj.path) {
      o.path = await sample(center, obj.id, obj.path.step * 86400, jdOf(Date.parse(obj.path.from)), end, true);
    }
    const n = s.data.length / 6;
    console.log(`${body}: ${s.name.padEnd(30)} track ${String(n).padStart(5)} × ${obj.step} s${o.path ? `, path ${o.path.data.length / 3} points` : ''}`);
    objects.push(o);
  }
  // every known moon: tracks for the fast ones, elements for the slow
  if (cfg.roster) {
    const moons = roster[cfg.roster] ?? [];
    const fast = moons.filter((m) => m.periodD < TRACK_MAX_PERIOD_D);
    const slow = moons.filter((m) => m.periodD >= TRACK_MAX_PERIOD_D);
    const tracks = await pool(fast, 2, async (m) => {
      const step = Math.min(3600, Math.max(300, Math.round((m.periodD * 86400) / 96 / 60) * 60));
      const s = await sample(center, m.id, step, start, end);
      if (s && !nearby(s.data, 6)) return console.warn(`${body}: ${m.display} (${m.id}) isn't near its planet in Horizons; skipped`), null;
      return s && { id: m.id, name: m.display, kind: 'moon', radiusKm: s.radiusKm, found: m.found, track: s };
    });
    // irregular moons change orbit slowly: their elements keep for a week
    const cacheFile = join(cacheDir, `elements-${body}.json`);
    let cached = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : null;
    if (!cached || Date.now() - cached.fetchedMs > 7 * 864e5 || cached.ids.join() !== slow.map((m) => m.id).join()) {
      const epoch = jdOf(Math.floor(Date.now() / hour) * hour);
      const els = await pool(slow, 2, (m) => elements(center, m.id, epoch).catch((e) => (console.warn(`${body}: ${m.display}: ${e.message}`), null)));
      cached = { fetchedMs: Date.now(), ids: slow.map((m) => m.id), els };
      writeFileSync(cacheFile, JSON.stringify(cached));
    }
    const irregular = slow.map((m, k) => {
      const e = cached.els[k];
      if (!e) return null;
      if (!(e.elements.a > 0 && e.elements.a < 1e8 && e.elements.e < 1)) return console.warn(`${body}: ${m.display} (${m.id}) has no bound orbit about its planet in Horizons; skipped`), null;
      return { id: m.id, name: m.display, kind: 'moon', radiusKm: e.radiusKm, found: m.found, elements: e.elements };
    });
    const got = [...tracks, ...irregular].filter(Boolean);
    console.log(`${body}: ${got.length} of ${moons.length} moons (${tracks.filter(Boolean).length} tracks, ${irregular.filter(Boolean).length} elements)`);
    objects.push(...got);
  }
  const bytes = encode(objects);
  const path = join(root, 'web', 'public', 'data', `ephemeris-${body}.bin`);
  await writeFile(path, bytes);
  console.log(`${path.replace(root + '/', '')}: ${(bytes.length / 1024).toFixed(0)} KiB`);
}
