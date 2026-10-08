#!/usr/bin/env node
// Builds the celestial sphere behind the globe from published sky surveys.
//   NASA SVS Deep Star Maps 2020, Milky Way background (Gaia DR2, bright stars
//   removed), ICRF plate carrée, 16384x8192 OpenEXR
//     -> milkyway.jpg / milkyway.ktx2 (4096x2048, standard displays)
//     -> milkyway-uhd-{c}-{r}.ktx2 (4x4 grid of 4096x2048 tiles, in the map's own
//        layout: c from RA 12h leftmost, r from the south celestial pole)
//   Hipparcos main catalogue (ESA 1997, CDS I/239), 118k stars to V ≈ 12
//     -> data/stars.bin
// The diffuse Milky Way is a texture; the stars the survey removed are drawn as
// points with a real point-spread function, so they stay sharp at any zoom.
// Sources are cached in data/cache/textures so re-runs are offline.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { encodeKtx2 } from './basis.mjs';
import { DataUtils, HalfFloatType } from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cache = join(root, 'data', 'cache', 'textures');
const textures = join(root, 'web', 'public', 'textures');
const data = join(root, 'web', 'public', 'data');
const rel = (p) => p.replace(root + '/', '');

const MILKY_WAY = 'https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/milkyway_2020_16k.exr';
const HIPPARCOS = 'https://cdsarc.cds.unistra.fr/ftp/I/239/hip_main.dat';

async function cached(url, file) {
  const p = join(cache, file);
  try {
    await stat(p);
  } catch {
    console.log(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    await writeFile(p, Buffer.from(await res.arrayBuffer()));
  }
  return readFile(p);
}

/** RGB (top-down) -> KTX2 ETC1S with mips, rows flipped bottom-up (v = 0 at the south celestial pole). */
async function ktx2(rgb, width, height, path, quality) {
  const out = await encodeKtx2(rgb, width, height, quality);
  await writeFile(path, out);
  console.log(`${rel(path)}: ${(out.length / 1024).toFixed(0)} KiB`);
}

await mkdir(cache, { recursive: true });
await mkdir(textures, { recursive: true });
await mkdir(data, { recursive: true });
sharp.cache(false);

// ------------------------------------------------------------------ Milky Way

{
  const exr = await cached(MILKY_WAY, 'milkyway_2020_16k.exr');
  // half floats keep the decoded 16k map at 1 GB instead of 2
  const tex = new EXRLoader().setDataType(HalfFloatType).parse(exr.buffer.slice(exr.byteOffset, exr.byteOffset + exr.byteLength));
  const { width: w, height: h, data: px } = tex;
  const ch = px.length / (w * h);
  const lut = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) lut[i] = DataUtils.fromHalfFloat(i);

  // exposure from a subsample: the bright galactic core lands near (not at) white
  const sample = [];
  for (let i = 0; i < w * h; i += 97) sample.push(0.2126 * lut[px[ch * i]] + 0.7152 * lut[px[ch * i + 1]] + 0.0722 * lut[px[ch * i + 2]]);
  sample.sort((a, b) => a - b);
  const k = 0.85 / sample[Math.floor(sample.length * 0.9995)];
  /** the survey's faint, noisy sky background, in display-linear units */
  const FLOOR = 0.024;
  const srgb = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) {
    const x = i / 4095;
    srgb[i] = Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
  }
  // EXRLoader returns rows bottom-up; write top-down like any image
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w, dst = y * w;
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        const v = lut[px[ch * (src + x) + c]] * k;
        // soft shoulder keeps the core's structure; then drop the diffuse sky
        // floor so empty sky is true black (and compresses to almost nothing)
        const t = (v / (1 + 0.25 * v) - FLOOR) / (1 - FLOOR);
        rgb[3 * (dst + x) + c] = srgb[Math.min(4095, Math.max(0, Math.round(t * 4095)))];
      }
    }
  }

  const raw = { raw: { width: w, height: h, channels: 3 } };
  const jpg = join(textures, 'milkyway.jpg');
  await sharp(rgb, raw).resize(4096, 2048, { kernel: 'lanczos3' }).jpeg({ quality: 84, mozjpeg: true, chromaSubsampling: '4:2:0' }).toFile(jpg);
  console.log(`${rel(jpg)}: ${((await stat(jpg)).size / 1024).toFixed(0)} KiB`);
  const std = await sharp(rgb, raw).resize(4096, 2048, { kernel: 'lanczos3' }).raw().toBuffer();
  await ktx2(std, 4096, 2048, join(textures, 'milkyway.ktx2'), 200);
  const cols = 4, rows = 4, tw = w / cols, th = h / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tile = await sharp(rgb, raw).extract({ left: c * tw, top: (rows - 1 - r) * th, width: tw, height: th }).raw().toBuffer();
      await ktx2(tile, tw, th, join(textures, `milkyway-uhd-${c}-${r}.ktx2`), 110);
    }
  }
}

// ------------------------------------------------------------------ stars

{
  const text = (await cached(HIPPARCOS, 'hip_main.dat')).toString('latin1');
  const col = (line, a, b) => line.slice(a - 1, b).trim(); // 1-based byte columns, as in the ReadMe
  const sexa = (s, hours) => {
    const [a, b, c] = s.replace(/^[+-]/, '').split(/\s+/).map(Number);
    const v = (a + b / 60 + c / 3600) * (hours ? 15 : 1);
    return s.startsWith('-') ? -v : v;
  };
  const stars = [];
  for (const line of text.split('\n')) {
    const v = col(line, 42, 46);
    if (!v || +v > 11.5) continue;
    // a few hundred entries lack the degree columns; fall back to the sexagesimal ones
    const raDeg = col(line, 52, 63) ? +col(line, 52, 63) : sexa(col(line, 18, 28), true);
    const decDeg = col(line, 65, 76) ? +col(line, 65, 76) : sexa(col(line, 30, 40), false);
    const bv = col(line, 246, 251);
    stars.push({ ra: (raDeg * Math.PI) / 180, dec: (decDeg * Math.PI) / 180, v: +v, bv: bv ? +bv : 0.6 });
  }
  stars.sort((a, b) => a.v - b.v); // brightest first

  // SoA, quantised: u16 RA (≈ 20″), i16 Dec (≈ 10″), u8 V in 1/18 mag from −2, i8 B−V in 0.02 mag
  const n = stars.length;
  const buf = Buffer.alloc(8 + 6 * n);
  buf.write('STR2', 0, 'latin1');
  buf.writeUInt32LE(n, 4);
  let o = 8;
  for (const s of stars) o = buf.writeUInt16LE(Math.round((s.ra / (2 * Math.PI)) * 65535) % 65536, o);
  for (const s of stars) o = buf.writeInt16LE(Math.round((s.dec / (Math.PI / 2)) * 32767), o);
  for (const s of stars) o = buf.writeUInt8(Math.max(0, Math.min(255, Math.round((s.v + 2) * 18))), o);
  for (const s of stars) o = buf.writeInt8(Math.max(-128, Math.min(127, Math.round(s.bv * 50))), o);
  await writeFile(join(data, 'stars.bin'), buf);
  console.log(`${rel(join(data, 'stars.bin'))}: ${n} stars, V ${stars[0].v} to ${stars[n - 1].v}, ${(buf.length / 1024).toFixed(0)} KiB`);
}
