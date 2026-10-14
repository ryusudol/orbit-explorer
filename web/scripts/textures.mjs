#!/usr/bin/env node
// Downloads NASA's public-domain Earth imagery and writes the globe's textures.
//   Blue Marble Next Generation (Dec 2004, 21600x10800)         -> day
//   Black Marble 2016 city lights, 500 m, 8 tiles of 21600²      -> night
// Three tiers, each streamed after the one before:
//   *-2k.jpg            first paint
//   *.ktx2 (4096x2048)  standard displays (and *.jpg if the transcoder is unavailable)
//   *-uhd-{c}-{r}.ktx2  16384x8192 as a 4x4 grid of 4096x2048 tiles (90° x 45°;
//                       c from 180°W eastward, r from the south pole), for
//                       high-density displays; tiles stream nearest-to-view first
//   earth-water.ktx2    4096x2048 ocean mask, for the Sun's glint on water
// KTX2 (Basis ETC1S + mips) stays block-compressed in GPU memory and is
// transcoded off the main thread. Rows are stored bottom-up (v = 0 at the south pole).
// Sources are cached in data/cache/textures so re-runs are offline.

import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { encodeKtx2 } from './basis.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cache = join(root, 'data', 'cache', 'textures');
const out = join(root, 'web', 'public', 'textures');
const rel = (p) => p.replace(root + '/', '');

const BLUE_MARBLE = 'https://eoimages.gsfc.nasa.gov/images/imagerecords/74000/74218/world.200412.3x21600x10800.jpg';
// 90°x90° tiles: A–D run west to east from 180°W, 1 is the northern row
const BLACK_MARBLE_TILE = (t) => `https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144897/BlackMarble_2016_${t}_geo_gray.tif`;
const TILES = ['A1', 'B1', 'C1', 'D1', 'A2', 'B2', 'C2', 'D2'];

const UHD = { width: 16384, height: 8192, cols: 4, rows: 4 };

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
  return p;
}

/** RGB (top-down) -> KTX2 ETC1S with mips, rows flipped bottom-up. */
async function ktx2(rgb, width, height, path, quality = 200) {
  const data = await encodeKtx2(rgb, width, height, quality);
  await writeFile(path, data);
  console.log(`${rel(path)}: ${(data.length / 1024).toFixed(0)} KiB`);
}

async function jpeg(rgb, width, height, path, w, h) {
  await sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize(w, h, { kernel: 'lanczos3' })
    .jpeg({ quality: 84, mozjpeg: true, chromaSubsampling: '4:2:0' })
    .toFile(path);
  console.log(`${rel(path)}: ${((await stat(path)).size / 1024).toFixed(0)} KiB`);
}

/** Writes every tier of one texture from a full-resolution UHD RGB buffer. */
async function tiers(name, rgb, quality) {
  const { width: W, height: H } = UHD;
  await jpeg(rgb, W, H, join(out, `${name}-2k.jpg`), 2048, 1024);
  await jpeg(rgb, W, H, join(out, `${name}.jpg`), 4096, 2048);
  const std = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).resize(4096, 2048, { kernel: 'lanczos3' }).raw().toBuffer();
  await ktx2(std, 4096, 2048, join(out, `${name}.ktx2`), quality);
  const tw = W / UHD.cols, th = H / UHD.rows;
  for (let r = 0; r < UHD.rows; r++) {
    for (let c = 0; c < UHD.cols; c++) {
      const region = { left: c * tw, top: (UHD.rows - 1 - r) * th, width: tw, height: th };
      const tile = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).extract(region).raw().toBuffer();
      await ktx2(tile, tw, th, join(out, `${name}-uhd-${c}-${r}.ktx2`), quality);
    }
  }
}

await mkdir(cache, { recursive: true });
await mkdir(out, { recursive: true });
sharp.cache(false);
sharp.concurrency(4);

// ------------------------------------------------------------------ day

const dayPath = await cached(BLUE_MARBLE, 'bluemarble-21600.jpg');
// keep oceans dark and land readable on the dark UI palette
const day = await sharp(dayPath, { limitInputPixels: false })
  .resize(UHD.width, UHD.height, { kernel: 'lanczos3' })
  .modulate({ brightness: 0.92, saturation: 0.85 })
  .gamma(1.1)
  .removeAlpha()
  .raw()
  .toBuffer();
await tiers('earth-day', day, 210);

// ocean mask: Blue Marble oceans are dark and blue-dominant; ice and land are not
{
  const W = 4096, H = 2048;
  const small = await sharp(dayPath, { limitInputPixels: false }).resize(W, H, { kernel: 'lanczos3' }).removeAlpha().raw().toBuffer();
  const mask = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const r = small[3 * i], g = small[3 * i + 1], b = small[3 * i + 2];
    const water = b > r * 1.25 && b > g * 0.95 && r < 70 ? 255 : 0;
    mask[3 * i] = mask[3 * i + 1] = mask[3 * i + 2] = water;
  }
  // soften the coastline a touch so the glint doesn't alias along it
  const soft = await sharp(mask, { raw: { width: W, height: H, channels: 3 } }).blur(1.2).raw().toBuffer();
  await ktx2(soft, W, H, join(out, 'earth-water.ktx2'), 128);
}

// ------------------------------------------------------------------ night

{
  const { width: W, height: H } = UHD;
  const tw = W / 4, th = H / 2;
  const night = Buffer.alloc(W * H * 3);
  for (const [k, t] of TILES.entries()) {
    const p = await cached(BLACK_MARBLE_TILE(t), `blackmarble-500m-${t}.tif`);
    const tile = await sharp(p, { limitInputPixels: false }).resize(tw, th, { kernel: 'lanczos3' }).removeAlpha().raw().toBuffer();
    const x0 = (k % 4) * tw, y0 = Math.floor(k / 4) * th;
    for (let y = 0; y < th; y++) tile.copy(night, ((y0 + y) * W + x0) * 3, y * tw * 3, (y + 1) * tw * 3);
  }
  // the tiles are gray stored as RGB: grade one channel, write it to all three
  const graded = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) graded[3 * i] = graded[3 * i + 1] = graded[3 * i + 2] = Math.max(0, Math.min(255, Math.round(night[3 * i] * 1.25 - 8)));
  await tiers('earth-night', graded, 190);
}

// Basis transcoder for three's KTX2Loader, served same-origin (COEP)
const require = createRequire(import.meta.url);
const basis = join(dirname(require.resolve('three')), '..', 'examples', 'jsm', 'libs', 'basis');
await mkdir(join(root, 'web', 'public', 'basis'), { recursive: true });
for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm']) await copyFile(join(basis, f), join(root, 'web', 'public', 'basis', f));
console.log('web/public/basis: transcoder copied');
