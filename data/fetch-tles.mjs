#!/usr/bin/env node
// Builds the compact catalogue snapshot the web app loads (web/public/data/catalog.bin).
//
// Sources
//   * CelesTrak GP data (default): every active payload plus the major debris
//     clouds and the "analyst" (unidentified) objects. No account needed.
//   * Space-Track (optional): the full public catalogue, ~30k objects, when
//     SPACETRACK_USER / SPACETRACK_PASS are set.
//
// CelesTrak refreshes GP data every 2 hours and throttles clients that
// re-download unchanged data, so every group is cached in data/cache and only
// re-fetched once the cached copy is older than that. The demo never talks to
// CelesTrak at runtime; it only loads the snapshot.
//
// Snapshot format (little-endian, structure-of-arrays so it compresses well):
//   header 32 B : "ORBX" | u32 version=1 | u32 count | u32 nameBytes | f64 generatedUnixMs | u32 x2 reserved
//   f64[n] epoch (Julian date, UTC)    f64[n] mean motion (rev/day)
//   f32[n] ecc, incl, raan, argp, mean anomaly (deg), bstar (1/Earth radii)
//   u32[n] NORAD id    u8[n] category    u8[n] name length    utf-8 names
// float32 is below TLE precision (1e-4 deg ~ 12 m along-track) for every angle.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, 'data', 'cache');
const outBin = join(root, 'web', 'public', 'data', 'catalog.bin');
const outMeta = join(root, 'web', 'public', 'data', 'catalog.json');
const CACHE_MAX_AGE_MS = 2 * 3600 * 1000;
const MAX_ELEMENT_AGE_DAYS = 30;

export const Category = { PAYLOAD: 0, STARLINK: 1, CONSTELLATION: 2, ROCKET_BODY: 3, DEBRIS: 4, STATION: 5 };

const CELESTRAK_GROUPS = [
  { group: 'active' },
  { group: 'analyst', category: Category.DEBRIS },
  { group: 'cosmos-1408-debris', category: Category.DEBRIS },
  { group: 'fengyun-1c-debris', category: Category.DEBRIS },
  { group: 'iridium-33-debris', category: Category.DEBRIS },
  { group: 'cosmos-2251-debris', category: Category.DEBRIS },
];

const STATION_IDS = new Set([25544, 48274, 53239, 54216]); // ISS, Tianhe, Wentian, Mengtian
const CONSTELLATION = /^(ONEWEB|KUIPER|QIANFAN|GUOWANG|HULIANWANG|IRIDIUM|GLOBALSTAR|ORBCOMM|SPACEBEE|FLOCK|LEMUR|SKYSAT|SWARM|YAOGAN)/;

export function classify(name, id, hint) {
  if (STATION_IDS.has(id) || /^(ISS \(|CSS \()/.test(name)) return Category.STATION;
  if (/ R\/B\b/.test(name) || /\bR\/B$/.test(name)) return Category.ROCKET_BODY;
  if (/\bDEB\b/.test(name) || /\bDEBRIS\b/.test(name) || name === 'UNKNOWN' || hint === Category.DEBRIS) return Category.DEBRIS;
  if (name.startsWith('STARLINK')) return Category.STARLINK;
  if (CONSTELLATION.test(name)) return Category.CONSTELLATION;
  return Category.PAYLOAD;
}

/** "2026-09-29T18:24:12.956832" (UTC) -> Julian date, keeping the microseconds Date drops. */
export function isoToJd(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(iso);
  if (!m) throw new Error(`bad epoch ${iso}`);
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0) + parseFloat(m[6]) * 1000;
  return ms / 86_400_000 + 2440587.5;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const col = (name) => header.indexOf(name);
  const idx = {
    name: col('OBJECT_NAME'), id: col('NORAD_CAT_ID'), epoch: col('EPOCH'), n: col('MEAN_MOTION'), e: col('ECCENTRICITY'),
    i: col('INCLINATION'), raan: col('RA_OF_ASC_NODE'), argp: col('ARG_OF_PERICENTER'), ma: col('MEAN_ANOMALY'), bstar: col('BSTAR'),
    type: col('OBJECT_TYPE'),
  };
  const rows = [];
  for (const line of lines.slice(1)) {
    // names never contain commas in GP CSV, but guard against quoted fields anyway
    const f = line.match(/("[^"]*"|[^,]*)(,|$)/g).map((s) => s.replace(/,$/, '').replace(/^"|"$/g, ''));
    rows.push({
      name: f[idx.name].trim(),
      id: parseInt(f[idx.id], 10),
      epochJd: isoToJd(f[idx.epoch]),
      meanMotion: parseFloat(f[idx.n]),
      ecc: parseFloat(f[idx.e]),
      incl: parseFloat(f[idx.i]),
      raan: parseFloat(f[idx.raan]),
      argp: parseFloat(f[idx.argp]),
      ma: parseFloat(f[idx.ma]),
      bstar: parseFloat(f[idx.bstar]),
      objectType: idx.type >= 0 ? f[idx.type] : undefined,
    });
  }
  return rows;
}

async function cachedFetch(key, url, init) {
  await mkdir(cacheDir, { recursive: true });
  const path = join(cacheDir, `${key}.csv`);
  let cached = null;
  try {
    const s = await stat(path);
    cached = { text: await readFile(path, 'utf8'), age: Date.now() - s.mtimeMs };
  } catch {}
  if (cached && cached.age < CACHE_MAX_AGE_MS && !process.env.FORCE_FETCH) {
    console.log(`  ${key}: cache (${(cached.age / 60000).toFixed(0)} min old)`);
    return cached.text;
  }
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    if (res.ok && (text.startsWith('OBJECT_NAME') || text.startsWith('"OBJECT_NAME'))) {
      await writeFile(path, text);
      console.log(`  ${key}: fetched ${text.split('\n').length - 1} rows`);
      return text;
    }
    console.warn(`  ${key}: server said: ${text.trim().split('\n')[0].slice(0, 100)}`);
  } catch (err) {
    console.warn(`  ${key}: fetch failed (${err.message})`);
  }
  if (cached) {
    console.log(`  ${key}: using cache (${(cached.age / 3600000).toFixed(1)} h old)`);
    return cached.text;
  }
  return null;
}

async function fromCelestrak() {
  const all = [];
  for (const { group, category } of CELESTRAK_GROUPS) {
    const text = await cachedFetch(group, `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=csv`);
    if (!text) continue;
    for (const row of parseCsv(text)) all.push({ ...row, hint: category });
  }
  return { rows: all, source: 'CelesTrak GP (active + debris groups + analyst)' };
}

async function fromSpaceTrack(user, pass) {
  const base = 'https://www.space-track.org';
  const login = await fetch(`${base}/ajaxauth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ identity: user, password: pass }),
  });
  if (!login.ok) throw new Error(`Space-Track login failed: ${login.status}`);
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  const query = `${base}/basicspacedata/query/class/gp/decay_date/null-val/epoch/%3Enow-${MAX_ELEMENT_AGE_DAYS}/orderby/norad_cat_id/format/csv`;
  const text = await cachedFetch('spacetrack-gp', query, { headers: { cookie } });
  if (!text) throw new Error('Space-Track query failed');
  const rows = parseCsv(text).map((r) => ({
    ...r,
    hint: r.objectType === 'DEBRIS' || r.objectType === 'UNKNOWN' ? Category.DEBRIS : r.objectType === 'ROCKET BODY' ? Category.ROCKET_BODY : undefined,
  }));
  return { rows, source: 'Space-Track GP (full public catalogue)' };
}

function encode(objects, generatedMs) {
  const n = objects.length;
  const enc = new TextEncoder();
  const names = objects.map((o) => enc.encode(o.name).slice(0, 255));
  const nameBytes = names.reduce((s, b) => s + b.length, 0);
  const size = 32 + n * (8 + 8 + 6 * 4 + 4 + 1 + 1) + nameBytes;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  new Uint8Array(buf, 0, 4).set(enc.encode('ORBX'));
  dv.setUint32(4, 1, true);
  dv.setUint32(8, n, true);
  dv.setUint32(12, nameBytes, true);
  dv.setFloat64(16, generatedMs, true);

  let off = 32;
  const f64 = (get) => { const a = new Float64Array(buf, off, n); objects.forEach((o, i) => (a[i] = get(o))); off += 8 * n; };
  const f32 = (get) => { const a = new Float32Array(buf, off, n); objects.forEach((o, i) => (a[i] = get(o))); off += 4 * n; };
  f64((o) => o.epochJd);
  f64((o) => o.meanMotion);
  for (const k of ['ecc', 'incl', 'raan', 'argp', 'ma', 'bstar']) f32((o) => o[k]);
  const ids = new Uint32Array(buf, off, n); objects.forEach((o, i) => (ids[i] = o.id)); off += 4 * n;
  const cats = new Uint8Array(buf, off, n); objects.forEach((o, i) => (cats[i] = o.category)); off += n;
  const lens = new Uint8Array(buf, off, n); names.forEach((b, i) => (lens[i] = b.length)); off += n;
  for (const b of names) { new Uint8Array(buf, off, b.length).set(b); off += b.length; }
  return new Uint8Array(buf);
}

async function main() {
  const user = process.env.SPACETRACK_USER;
  const pass = process.env.SPACETRACK_PASS;
  console.log(user ? 'Source: Space-Track' : 'Source: CelesTrak');
  const { rows, source } = user && pass ? await fromSpaceTrack(user, pass) : await fromCelestrak();
  if (!rows.length) throw new Error('no element sets retrieved');

  const nowJd = Date.now() / 86_400_000 + 2440587.5;
  const byId = new Map();
  let stale = 0;
  let invalid = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.meanMotion) || r.meanMotion < 0.05 || !(r.ecc >= 0 && r.ecc < 1) || !Number.isFinite(r.epochJd)) { invalid++; continue; }
    if (nowJd - r.epochJd > MAX_ELEMENT_AGE_DAYS) { stale++; continue; }
    const prev = byId.get(r.id);
    if (!prev || r.epochJd > prev.epochJd) byId.set(r.id, { ...r, hint: prev?.hint ?? r.hint });
  }
  const objects = [...byId.values()]
    .map((o) => ({ ...o, category: classify(o.name, o.id, o.hint) }))
    .sort((a, b) => a.id - b.id);

  const generatedMs = Date.now();
  const bin = encode(objects, generatedMs);
  await mkdir(dirname(outBin), { recursive: true });
  await writeFile(outBin, bin);

  const names = ['payload', 'starlink', 'constellation', 'rocketBody', 'debris', 'station'];
  const counts = Object.fromEntries(names.map((k) => [k, 0]));
  for (const o of objects) counts[names[o.category]]++;
  const meta = {
    generated: new Date(generatedMs).toISOString(),
    source,
    objects: objects.length,
    counts,
    skipped: { stale, invalid, duplicates: rows.length - stale - invalid - objects.length },
    bytes: bin.byteLength,
    format: 'ORBX v1 (see data/fetch-tles.mjs)',
  };
  await writeFile(outMeta, JSON.stringify(meta, null, 2) + '\n');
  console.log(`\n${objects.length} objects -> ${outBin} (${(bin.byteLength / 1024).toFixed(0)} KiB)`);
  console.log(counts);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
