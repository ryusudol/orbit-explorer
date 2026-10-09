#!/usr/bin/env node
// Builds the Moon's and Mars' globe textures from public-domain NASA/USGS maps.
//   Moon  colour  LROC WAC colour mosaic, poles filled (NASA SVS CGI Moon Kit, 16384x8192)
//         relief  LOLA elevation, 64 px/deg (CGI Moon Kit ldem_64, km above 1737.4 km)
//   Mars  colour  Viking Orbiter colour mosaic, 925 m/px (USGS Astrogeology)
//         relief  MOLA MEGDR elevation, 32 px/deg (PDS, m above the areoid, 0–360°E)
// All are planetocentric plate carrée, written centred on 0° longitude, rows bottom-up:
//   {body}-color-2k.jpg, {body}-color.jpg / .ktx2 (4096x2048), {body}-color-uhd-{c}-{r}.ktx2
//     the same tiers and 4x4 tile grid as the Earth (scripts/textures.mjs)
//   {body}-relief.ktx2 (2048x1024), {body}-relief-uhd-{c}-{r}.ktx2 (8192x4096 as 4x4 tiles)
//     surface slope from the elevation model: east slope in RGB, north slope in alpha,
//     each as 0.5 + 0.5·n, so the shader can light craters and canyons from the real Sun
// Sources are cached in data/cache/textures so re-runs are offline.

import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { encodeKtx2, encodeKtx2Data } from './basis.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cache = join(root, 'data', 'cache', 'textures');
const out = join(root, 'web', 'public', 'textures');
const rel = (p) => p.replace(root + '/', '');

const SOURCES = {
  moonColor: ['https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_16k.tif', 'lroc_color_poles_16k.tif'],
  moonDem: ['https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_64.tif', 'ldem_64.tif'],
  marsColor: ['https://planetarymaps.usgs.gov/mosaic/Mars_Viking_ClrMosaic_global_925m.tif', 'Mars_Viking_ClrMosaic_global_925m.tif'],
  marsDem: ['https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg032/megt90n000fb.img', 'megt90n000fb.img'],
};

const UHD = { width: 16384, height: 8192, cols: 4, rows: 4 };
const RELIEF = { width: 8192, height: 4096 };

async function cached([url, file]) {
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

async function save(path, data) {
  await writeFile(path, data);
  console.log(`${rel(path)}: ${(data.length / 1024).toFixed(0)} KiB`);
}

/** Cuts a top-down buffer into the 4x4 grid (c from 180°W eastward, r from the south pole). */
async function eachTile(buf, width, height, channels, fn) {
  const tw = width / UHD.cols, th = height / UHD.rows;
  for (let r = 0; r < UHD.rows; r++) {
    for (let c = 0; c < UHD.cols; c++) {
      const region = { left: c * tw, top: (UHD.rows - 1 - r) * th, width: tw, height: th };
      const tile = await sharp(buf, { raw: { width, height, channels } }).extract(region).raw().toBuffer();
      await fn(c, r, tile, tw, th);
    }
  }
}

/** Every colour tier from a full-resolution (16384x8192) RGB buffer. */
async function colourTiers(name, rgb, quality) {
  const { width: W, height: H } = UHD;
  const img = () => sharp(rgb, { raw: { width: W, height: H, channels: 3 } });
  for (const [w, suffix] of [
    [2048, '-2k'],
    [4096, ''],
  ]) {
    const path = join(out, `${name}${suffix}.jpg`);
    await img().resize(w, w / 2, { kernel: 'lanczos3' }).jpeg({ quality: 86, mozjpeg: true }).toFile(path);
    console.log(`${rel(path)}: ${((await stat(path)).size / 1024).toFixed(0)} KiB`);
  }
  const std = await img().resize(4096, 2048, { kernel: 'lanczos3' }).raw().toBuffer();
  await save(join(out, `${name}.ktx2`), await encodeKtx2(std, 4096, 2048, quality));
  await eachTile(rgb, W, H, 3, async (c, r, tile, tw, th) => save(join(out, `${name}-uhd-${c}-${r}.ktx2`), await encodeKtx2(tile, tw, th, quality)));
}

/**
 * Slopes of an elevation grid (km, top-down rows from +90°, columns from 180°W),
 * as RGBA: east slope in RGB, north slope in alpha. Central differences, wrapping
 * in longitude; east spacing shrinks with cos(latitude).
 */
function reliefRgba(h, width, height, radiusKm) {
  const out = Buffer.alloc(width * height * 4);
  const dLon = (2 * Math.PI) / width, dLat = Math.PI / height;
  const dy = radiusKm * dLat;
  for (let y = 0; y < height; y++) {
    const lat = Math.PI / 2 - (y + 0.5) * dLat;
    const dx = radiusKm * Math.max(Math.cos(lat), 0.01) * dLon;
    const yn = Math.max(0, y - 1), ys = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x++) {
      const xe = (x + 1) % width, xw = (x - 1 + width) % width;
      const sx = (h[y * width + xe] - h[y * width + xw]) / (2 * dx);
      const sy = (h[yn * width + x] - h[ys * width + x]) / ((ys - yn) * dy);
      // surface normal in (east, north, up) = (−∂h/∂x, −∂h/∂y, 1) normalised
      const k = 1 / Math.sqrt(sx * sx + sy * sy + 1);
      const e = Math.round(127.5 - 127.5 * sx * k), n = Math.round(127.5 - 127.5 * sy * k);
      const i = 4 * (y * width + x);
      out[i] = out[i + 1] = out[i + 2] = e;
      out[i + 3] = n;
    }
  }
  return out;
}

async function reliefTiers(name, h, radiusKm) {
  const { width: W, height: H } = RELIEF;
  const rgba = reliefRgba(h, W, H, radiusKm);
  const std = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).resize(2048, 1024, { kernel: 'lanczos3' }).raw().toBuffer();
  await save(join(out, `${name}.ktx2`), await encodeKtx2Data(std, 2048, 1024, 255));
  await eachTile(rgba, W, H, 4, async (c, r, tile, tw, th) => save(join(out, `${name}-uhd-${c}-${r}.ktx2`), await encodeKtx2Data(tile, tw, th, 255)));
}

/**
 * Bilinear resample of a float grid in memory, pixel centres aligned, wrapping in
 * longitude. sharp can't take float samples as raw input: it reads the bytes as
 * 8-bit pixels and every height comes out 0, so Mars' relief was once flat.
 */
function resampleFloat(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(Math.max(((y + 0.5) * sh) / dh - 0.5, 0), sh - 1);
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, sh - 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = ((x + 0.5) * sw) / dw - 0.5;
      const xf = Math.floor(fx), tx = fx - xf;
      const x0 = (xf + sw) % sw, x1 = (xf + 1 + sw) % sw;
      const top = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
      const bottom = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
      out[y * dw + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return out;
}

/** One float channel of an image file, resampled to the relief grid. */
async function floatGrid(input) {
  const { data } = await sharp(input, { limitInputPixels: false })
    .extractChannel(0)
    .resize(RELIEF.width, RELIEF.height, { kernel: 'lanczos3', fit: 'fill' })
    .raw({ depth: 'float' })
    .toBuffer({ resolveWithObject: true });
  return new Float32Array(data.buffer, data.byteOffset, data.length / 4);
}

await mkdir(out, { recursive: true });
sharp.cache(false);
sharp.concurrency(4);
const only = process.argv[2]; // optional: 'moon' or 'mars'

// ------------------------------------------------------------------ Moon

if (!only || only === 'moon') {
  // the WAC mosaic is a normal albedo map: lighting comes from the shader, so just
  // pull the mid-tones down a touch so the maria read against the highlands
  const color = await sharp(await cached(SOURCES.moonColor), { limitInputPixels: false })
    .resize(UHD.width, UHD.height, { kernel: 'lanczos3', fit: 'fill' })
    .removeAlpha()
    .gamma(2.2, 2.0)
    .modulate({ saturation: 0.9 })
    .raw()
    .toBuffer();
  await colourTiers('moon-color', color, 210);
  await reliefTiers('moon-relief', await floatGrid(await cached(SOURCES.moonDem)), 1737.4);
}

// ------------------------------------------------------------------ Mars

if (!only || only === 'mars') {
  const color = await sharp(await cached(SOURCES.marsColor), { limitInputPixels: false })
    .resize(UHD.width, UHD.height, { kernel: 'lanczos3', fit: 'fill' })
    .removeAlpha()
    .modulate({ saturation: 0.92 })
    .raw()
    .toBuffer();
  await colourTiers('mars-color', color, 210);

  // MEGDR: big-endian int16 metres, 0°E at the left edge; roll by half a turn to start at 180°W
  const raw = await readFile(await cached(SOURCES.marsDem));
  const w = 11520, hgt = 5760;
  const km = new Float32Array(w * hgt);
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) km[y * w + ((x + w / 2) % w)] = raw.readInt16BE(2 * (y * w + x)) / 1000;
  }
  await reliefTiers('mars-relief', resampleFloat(km, w, hgt, RELIEF.width, RELIEF.height), 3396.19);
}
