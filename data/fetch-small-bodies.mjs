#!/usr/bin/env node
// Snapshots the orbits of every known trans-Neptunian object (~7,300: the Kuiper
// belt, the scattered disc and the few detached objects such as Sedna whose orbits
// reach toward the inner Oort cloud) from JPL's Small-Body Database.
// https://ssd-api.jpl.nasa.gov/doc/sbdb_query.html
//
// These orbits change over decades, so the snapshot is reused for 30 days.
//
// Output web/public/data/tno.bin, little-endian:
//   "TNO1" | u32 count | f64 epoch base (TDB Julian date) | f64 generatedUnixMs
//   per object: f32 a (au), e, i, node, peri, M (deg, heliocentric ecliptic J2000),
//               f32 epoch (days from base), f32 H (absolute magnitude)
//   then a JSON list of the named ones: [{ index, name }]

import { existsSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'web', 'public', 'data', 'tno.bin');
const force = process.argv.includes('--force');

if (!force && existsSync(out) && Date.now() - statSync(out).mtimeMs < 30 * 864e5) {
  console.log(`${out.replace(root + '/', '')} is under 30 days old; kept`);
  process.exit(0);
}

const url = 'https://ssd-api.jpl.nasa.gov/sbdb_query.api?fields=full_name,a,e,i,om,w,ma,epoch,H&sb-class=TNO';
const res = await fetch(url);
if (!res.ok) throw new Error(`SBDB HTTP ${res.status}`);
const { data } = await res.json();
const rows = data.filter((r) => r.slice(1, 8).every((x) => x !== null && Number.isFinite(+x)) && +r[2] < 1);

const base = 2461200.5;
const buf = new ArrayBuffer(24 + rows.length * 32);
const dv = new DataView(buf);
new Uint8Array(buf, 0, 4).set(new TextEncoder().encode('TNO1'));
dv.setUint32(4, rows.length, true);
dv.setFloat64(8, base, true);
dv.setFloat64(16, Date.now(), true);
const f = new Float32Array(buf, 24, rows.length * 8);
const named = [];
rows.forEach((r, k) => {
  const [name, a, e, i, om, w, ma, epoch, H] = r;
  f.set([+a, +e, +i, +om, +w, +ma, +epoch - base, H === null ? 10 : +H], 8 * k);
  // "134340 Pluto (...)": numbered and named; provisional designations stay unnamed
  const m = /^\s*\d+\s+([^\s(][^(]*?)\s*(\(|$)/.exec(name);
  if (m) named.push({ index: k, name: m[1] });
});
const json = new TextEncoder().encode(JSON.stringify(named));
const bytes = new Uint8Array(buf.byteLength + json.length);
bytes.set(new Uint8Array(buf), 0);
bytes.set(json, buf.byteLength);
await writeFile(out, bytes);
console.log(`${out.replace(root + '/', '')}: ${rows.length} objects (${named.length} named), ${(bytes.length / 1024).toFixed(0)} KiB`);
