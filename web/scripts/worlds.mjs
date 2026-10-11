#!/usr/bin/env node
// Builds the textures for Mercury, Venus, the giant planets and their big moons.
//
//   Mercury   MESSENGER MDIS 3-colour basemap (665 m/px) and the USGS MESSENGER DEM
//   Venus     Magellan C3-MDIR colourised radar mosaic and Magellan topography: the
//             surface, seen through the clouds (the "Radar surface" layer). The
//             clouds themselves are made here: no global visible-light map of
//             Venus' cloud tops exists. A pale, almost featureless deck, with the
//             faint banding and dark "Y" seen in violet light, kept subtle.
//   Giants    Hubble OPAL global maps (Simon et al.; Jupiter and Saturn 2025, Uranus
//             2025, Neptune 2025). Each covers what Hubble could see: Saturn's equator
//             is hidden by the rings' shadow, Uranus' south and Neptune's far north
//             are turned away in winter. Bands circle the planet, so the gaps are
//             filled from the nearest row's average colour (Uranus and Neptune
//             mirror their visible hemisphere). Saturn's north polar hexagon, beyond
//             the map's 80°N, is painted at its measured 78°N. Hubble's filter sets
//             aren't true colour: Uranus and Neptune are balanced to the pale
//             greenish blue measured by Irwin et al. (2024), Saturn to its butterscotch.
//   Moons     USGS Astrogeology global mosaics from Galileo, Voyager and Cassini,
//             (one-band maps tinted to the moon's true colour). Uranus' five big
//             moons (USGS Voyager 2 mosaics, from JPL's Solar System Simulator) and
//             Triton were only ever seen in the south, by Voyager 2 in 1986 and 1989:
//             their unseen north is completed from the terrain that was seen
//             (completeMap).
//
// Every map is written in the app's layout: plate carrée, east longitude from
// −180° at the left edge, north up. The source maps' own conventions (centred on
// 0° or 180°, longitude east or west) come from their ISIS labels. The giants'
// rows are converted from planetographic latitude to the parametric latitude of
// the flattened globe the app draws (scene/giants.ts).
//
// Sources are cached in data/cache/textures. Output in public/textures:
//   {world}-color-2k.jpg, {world}-color.jpg / .ktx2, {world}-relief.ktx2 (rocky)
//   venus-clouds-2k.jpg, moons/{moon}.jpg

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { encodeKtx2, encodeKtx2Data } from './basis.mjs';
import { reliefRgba } from './maps.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cache = join(root, 'data', 'cache', 'textures');
const out = join(root, 'web', 'public', 'textures');
const rel = (p) => p.replace(root + '/', '');
const USGS = 'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic';
const OPAL = 'https://archive.stsci.edu/hlsps/opal';
const DEG = Math.PI / 180;

async function cached(url, file = url.split('/').pop()) {
  const p = join(cache, file);
  if (!existsSync(p)) {
    console.log(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, Buffer.from(await res.arrayBuffer()));
  }
  return p;
}

async function save(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  console.log(`${rel(path)}: ${(data.length / 1024).toFixed(0)} KiB`);
}

/** East longitude of a USGS ISIS map's left edge, from its label. */
async function leftLongitude(tif) {
  const lbl = await cached(`${USGS}/${tif.replace(/\.tif$/, '.lbl')}`);
  const t = readFileSync(lbl, 'utf8');
  const num = (k) => parseFloat(new RegExp(`${k}\\s*=\\s*([-\\d.]+)`).exec(t)[1]);
  const R = num('EquatorialRadius'), ulx = num('UpperLeftCornerX'), c = num('CenterLongitude');
  const east = /LongitudeDirection\s*=\s*PositiveEast/.test(t);
  const span = ulx / R / DEG;
  return east ? c + span : -(c - span);
}

/** Roll an RGB(A) buffer sideways so its left edge, at east longitude `left`, moves to −180°. */
function roll(buf, w, h, ch, left) {
  const off = Math.round((((((left + 180) % 360) + 360) % 360) / 360) * w) % w;
  if (!off) return buf;
  const o = Buffer.alloc(buf.length);
  const row = w * ch;
  for (let y = 0; y < h; y++) {
    const r = y * row;
    // source column i has longitude left + 360 i/w; output column j = i + off
    buf.copy(o, r + off * ch, r, r + (w - off) * ch);
    buf.copy(o, r, r + (w - off) * ch, r + row);
  }
  return o;
}

/** A USGS mosaic as top-down RGB at w x h, in the app's layout. */
async function usgsMap(tif, w, h) {
  const left = await leftLongitude(tif);
  const src = await cached(`${USGS}/${tif}`);
  const rgb = await sharp(src, { limitInputPixels: false }).resize(w, h, { kernel: 'lanczos3', fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().toBuffer();
  return roll(rgb, w, h, 3, left);
}

/** Every colour tier: 2k JPEG, 4k JPEG + KTX2 (or the source's own size if smaller). */
async function colourTiers(name, rgb, W, H, quality = 200) {
  const img = () => sharp(rgb, { raw: { width: W, height: H, channels: 3 } });
  await save(join(out, `${name}-2k.jpg`), await img().resize(2048, 1024, { kernel: 'lanczos3' }).jpeg({ quality: 86, mozjpeg: true }).toBuffer());
  await save(join(out, `${name}.jpg`), await img().jpeg({ quality: 86, mozjpeg: true }).toBuffer());
  await save(join(out, `${name}.ktx2`), await encodeKtx2(rgb, W, H, quality));
}

/** Slope map from an elevation grid (km), as the planets' relief tier (2048x1024). */
async function reliefTier(name, km, W, H, radiusKm) {
  const rgba = reliefRgba(km, W, H, radiusKm);
  const std = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).resize(2048, 1024, { kernel: 'lanczos3' }).raw().toBuffer();
  await save(join(out, `${name}.ktx2`), await encodeKtx2Data(std, 2048, 1024, 255));
}

/**
 * A 16-bit elevation file (metres) as float km at w x h, in the app's layout,
 * box-averaged from full resolution. sharp's usual path turns 16-bit greyscale
 * into 8 bits and drops the sign of heights below the datum, so the samples are
 * read as raw 16-bit words; any value above 32767 means the file is signed.
 */
async function elevation(src, w, h, left = -180) {
  const { data, info } = await sharp(src, { limitInputPixels: false }).toColourspace('grey16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const u = new Uint16Array(data.buffer, data.byteOffset, W * H);
  let signed = false;
  for (let i = 0; i < u.length && !signed; i += 997) signed = u[i] > 32767;
  const v = signed ? new Int16Array(u.buffer, u.byteOffset, u.length) : u;
  const km = new Float32Array(w * h);
  const fx = W / w, fy = H / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += v[yy * W + xx];
      km[y * w + x] = sum / ((y1 - y0) * (x1 - x0)) / 1000;
    }
  }
  if (left === -180) return km;
  const b = roll(Buffer.from(km.buffer), w, h, 4, left);
  return new Float32Array(b.buffer, b.byteOffset, km.length);
}

// ------------------------------------------------------------------ procedural helpers

/** Gradient noise on a 3-D lattice (Perlin's improved noise), deterministic per seed. */
function makeNoise(seed) {
  const p = new Uint8Array(512);
  let s = seed >>> 0 || 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const perm = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h, x, y, z) => {
    const u = h < 8 ? x : y, v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  };
  const lerp = (t, a, b) => a + t * (b - a);
  const noise = (x, y, z) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    z -= Math.floor(z);
    const u = fade(x), v = fade(y), w = fade(z);
    const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z, B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
    return lerp(
      w,
      lerp(v, lerp(u, grad(p[AA] & 15, x, y, z), grad(p[BA] & 15, x - 1, y, z)), lerp(u, grad(p[AB] & 15, x, y - 1, z), grad(p[BB] & 15, x - 1, y - 1, z))),
      lerp(v, lerp(u, grad(p[AA + 1] & 15, x, y, z - 1), grad(p[BA + 1] & 15, x - 1, y, z - 1)), lerp(u, grad(p[AB + 1] & 15, x, y - 1, z - 1), grad(p[BB + 1] & 15, x - 1, y - 1, z - 1))),
    );
  };
  const fbm = (x, y, z, oct = 5, lac = 2.03, gain = 0.5) => {
    let a = 1, f = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) {
      sum += a * noise(x * f, y * f, z * f);
      norm += a;
      a *= gain;
      f *= lac;
    }
    return sum / norm;
  };
  return { noise, fbm, rand };
}

/** Unit vector at the centre of pixel (x, y) of a w x h map in the app's layout. */
const dirAt = (x, y, w, h) => {
  const lon = -Math.PI + ((x + 0.5) / w) * 2 * Math.PI, lat = Math.PI / 2 - ((y + 0.5) / h) * Math.PI;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
};

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Float albedo -> RGB with a two-colour ramp. */
function tint(a, dark, light, lo = 0, hi = 1) {
  const o = Buffer.alloc(a.length * 3);
  const D = hex(dark), L = hex(light);
  for (let i = 0; i < a.length; i++) {
    const c = mixc(D, L, clamp01((a[i] - lo) / (hi - lo)));
    o[3 * i] = c[0];
    o[3 * i + 1] = c[1];
    o[3 * i + 2] = c[2];
  }
  return o;
}

/** An RGB map's luminance through a two-colour ramp: grey mosaics in their moon's colour. */
function tintGrey(rgb, dark, light, gamma = 1) {
  const n = rgb.length / 3;
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.pow((0.299 * rgb[3 * i] + 0.587 * rgb[3 * i + 1] + 0.114 * rgb[3 * i + 2]) / 255, gamma);
  return tint(a, dark, light);
}

/**
 * Where a mosaic has no data (black: never imaged, like Triton's north, dark in
 * 1989), fill with the map's own mean colour, mottled, so the globe isn't holed.
 */
function fillNoData(rgb, w, h, seed) {
  const { fbm } = makeNoise(seed);
  const mean = [0, 0, 0];
  let n = 0;
  const empty = (i) => rgb[i] + rgb[i + 1] + rgb[i + 2] < 12;
  for (let i = 0; i < rgb.length; i += 3) if (!empty(i)) (mean[0] += rgb[i], mean[1] += rgb[i + 1], mean[2] += rgb[i + 2], n++);
  for (let k = 0; k < 3; k++) mean[k] /= n;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = 3 * (y * w + x);
      if (!empty(i)) continue;
      const d = dirAt(x, y, w, h);
      const m = 1 + 0.18 * fbm(d[0] * 4, d[1] * 4, d[2] * 4, 5);
      for (let k = 0; k < 3; k++) rgb[i + k] = Math.max(0, Math.min(255, Math.round(mean[k] * m)));
    }
  return rgb;
}

/** Separable box blur of a float map, `passes` times (≈ Gaussian), wrapping east-west. */
function blur(src, w, h, r, passes = 3) {
  let a = Float32Array.from(src);
  const b = new Float32Array(a.length);
  const n = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += a[row + ((k % w) + w) % w];
      for (let x = 0; x < w; x++) {
        b[row + x] = sum / n;
        sum += a[row + ((x + r + 1) % w)] - a[row + ((x - r) % w + w) % w];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += b[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = sum / n;
        sum += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
  }
  return a;
}

/**
 * Complete a map Voyager saw only part of. `L` is brightness (0–1), `seen` 1 where
 * imaged. The unseen part is made from what was seen, so it has the same resolution
 * and character: its fine texture is quilted from many small patches of the sharpest
 * seen terrain (each about 8° across, stretched to its new latitude, cross-faded with
 * its neighbours, never large enough to repeat a landmark), on the large-scale
 * brightness at the edge of the seen region, relaxing to the mean with distance and
 * mottled by noise. Seen terrain that is smooth (frames taken from far off, smeared
 * across the map) gets the same texture, fading out where the mosaic has its own detail.
 * Black specks along the data's edge, where the sun was low, are clamped. Seen and
 * made meet over a couple of degrees.
 */
function completeMap(L0, seen0, w, h, seed) {
  const n = w * h;
  const L = Float32Array.from(L0);
  // the data's own edge (limb, terminator, frame borders) is dark and ragged: trimmed off
  const trim = blur(seen0, w, h, Math.max(2, Math.round(w / 180)), 1);
  const seen = seen0.map((v, i) => (v && trim[i] > 0.999 ? 1 : 0));
  const R = Math.round(w / 90); // ~4°: between terrain texture and broad albedo
  const wsum = blur(seen, w, h, R);
  const lsum = blur(L.map((v, i) => v * seen[i]), w, h, R);
  const low = new Float32Array(n), hp = new Float32Array(n);
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    low[i] = wsum[i] > 1e-3 ? lsum[i] / wsum[i] : 0;
    if (seen[i]) {
      if (wsum[i] > 0.97) hp[i] = L[i] - low[i];
      sum += L[i];
      cnt++;
    }
  }
  const mean = sum / cnt;
  let varLow = 0, nLow = 0;
  for (let i = 0; i < n; i += 3) if (seen[i] && wsum[i] > 0.97) (varLow += (low[i] - mean) ** 2), nLow++;
  const sdLow = Math.sqrt(varLow / nLow);
  // where to take patches from: fully seen, away from the poles' smear, with real detail
  const energy = blur(hp.map(Math.abs), w, h, R);
  const P = Math.round(w / 45); // patch size in px at the equator (~8°)
  const cover = blur(seen, w, h, P);
  const pool = [];
  for (let y = 0; y < h; y += 2) {
    const lat = 90 - ((y + 0.5) / h) * 180;
    if (Math.abs(lat) > 60) continue;
    for (let x = 0; x < w; x += 2) if (cover[y * w + x] > 0.999) pool.push(y * w + x);
  }
  const es = pool.map((i) => energy[i]).sort((a, b) => a - b);
  const eMin = es[Math.floor(es.length * 0.2)];
  const src = pool.filter((i) => energy[i] >= eMin);
  const { fbm, rand } = makeNoise(seed);
  const alpha = blur(seen, w, h, Math.round(w / 220));
  // seen terrain that is smooth (distant, smeared frames) gets the same quilted texture, fading
  // out as the mosaic's own detail rises: its brightness pattern stays Voyager's
  const smooth = new Float32Array(n);
  const sLo = es[Math.floor(es.length * 0.1)], sHi = es[Math.floor(es.length * 0.45)];
  for (let i = 0; i < n; i++) if (seen[i]) smooth[i] = 1 - clamp01((energy[i] - sLo) / (sHi - sLo));
  const need = (i) => alpha[i] < 0.999 || smooth[i] > 0.02;
  // within a few degrees of the data's edge, the low sun leaves black specks and streaks: clamped
  let hv = 0, hn = 0;
  for (let i = 0; i < n; i += 3) if (wsum[i] > 0.999) (hv += hp[i] * hp[i]), hn++;
  const sdHp = Math.sqrt(hv / hn);
  const nearEdge = blur(seen, w, h, Math.round(w / 72), 1);
  const wide = blur(L.map((v, i) => v * seen[i]), w, h, 3 * R), wideW = blur(seen, w, h, 3 * R);
  for (let i = 0; i < n; i++) if (seen[i] && nearEdge[i] < 0.999) L[i] = Math.max(L[i], wide[i] / Math.max(1e-3, wideW[i]) - 1.5 * sdHp);
  // quilt: patches on a jittered grid in latitude/longitude, overlapping by half
  const acc = new Float32Array(n), w2 = new Float32Array(n);
  const step = P / 2;
  for (let yc = 0; yc < h; yc += step) {
    const latC = (90 - ((yc + 0.5) / h) * 180) * DEG;
    const sx = Math.min(6, 1 / Math.max(0.05, Math.cos(latC))); // patch widens toward the poles
    for (let xc = 0; xc < w; xc += step * sx) {
      const cy = Math.round(yc + (rand() - 0.5) * step * 0.5), cx = Math.round(xc + (rand() - 0.5) * step * 0.5 * sx);
      if (cy < 0 || cy >= h || !need(cy * w + ((cx % w) + w) % w)) {
        // only where something is unseen nearby
        let any = false;
        for (let k = -2; k <= 2 && !any; k++) {
          const yy = Math.min(h - 1, Math.max(0, cy + k * (P >> 2)));
          if (need(yy * w + ((cx % w) + w) % w)) any = true;
        }
        if (!any) continue;
      }
      const s0 = src[Math.floor(rand() * src.length)];
      const sy = Math.floor(s0 / w), sxp = s0 % w;
      const latS = (90 - ((sy + 0.5) / h) * 180) * DEG;
      for (let dy = -P / 2; dy <= P / 2; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= h) continue;
        const latY = (90 - ((y + 0.5) / h) * 180) * DEG;
        const kx = Math.cos(latS) / Math.max(0.02, Math.cos(latY)); // dest px per source px
        const half = Math.min(w / 8, (P / 2) * kx);
        const wy = Math.cos((Math.PI * dy) / P) ** 2;
        const ys = Math.min(h - 1, Math.max(0, sy + dy));
        for (let dx = -Math.floor(half); dx <= half; dx++) {
          const x = (((cx + dx) % w) + w) % w;
          const i = y * w + x;
          if (!need(i)) continue;
          const wt = wy * Math.cos((Math.PI * dx) / (2 * half)) ** 2;
          const xs = (((sxp + Math.round(dx / kx)) % w) + w) % w;
          acc[i] += wt * hp[ys * w + xs];
          w2[i] += wt * wt;
        }
      }
    }
  }
  // per column: the first seen row from the north, and the low-pass just inside it
  const edgeY = new Int32Array(w), edge = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h - 1 && !seen[y * w + x]) y++;
    edgeY[x] = y;
    const k = Math.min(h - 1, y + 2 * R);
    edge[x] = wsum[k * w + x] > 0.5 ? low[k * w + x] : mean;
  }
  const em = new Float32Array(w);
  const span = Math.round(w / 24);
  for (let x = 0; x < w; x++) {
    let t = 0;
    for (let k = -span; k <= span; k++) t += edge[(x + k + w) % w];
    em[x] = t / (2 * span + 1);
  }
  const out = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = clamp01((alpha[i] - 0.5) * 2.2) ** 1.4;
      // overlapping patches average toward grey: dividing by √Σw² keeps the texture's contrast
      const fine = w2[i] > 0 ? (0.8 * acc[i]) / Math.sqrt(w2[i]) : 0;
      const real = L[i] + smooth[i] * fine;
      if (a >= 1) {
        out[i] = real;
        continue;
      }
      const d = dirAt(x, y, w, h);
      const far = clamp01((edgeY[x] - y) / (h / 6));
      const base = em[x] * (1 - far) + mean * far + sdLow * 1.4 * fbm(d[0] * 2.5, d[1] * 2.5, d[2] * 2.5, 5);
      out[i] = a * real + (1 - a) * (base + fine);
    }
  return out;
}

/** Brightness and coverage of a one- or three-band map: black is "never imaged". */
function lumSeen(rgb, w, h) {
  const n = w * h, L = new Float32Array(n), seen = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgb[3 * i], g = rgb[3 * i + 1], b = rgb[3 * i + 2];
    seen[i] = r + g + b >= 12 ? 1 : 0;
    L[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }
  return { L, seen };
}

/**
 * Brightness to true colour: the mean set to `target` (relative albedo), deviations
 * scaled by `contrast`, times an RGB tint; optional extra tint on bright terrain south of
 * `capLat` (Triton's pink polar cap).
 */
function albedoColour(v, w, h, { target, contrast = 1, tint = [1, 1, 1], cap }) {
  let m = 0;
  for (const x of v) m += x;
  m /= v.length;
  const out = Buffer.alloc(v.length * 3);
  for (let y = 0; y < h; y++) {
    const lat = 90 - ((y + 0.5) / h) * 180;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = Math.max(0, target * (1 + (contrast * (v[i] - m)) / m));
      let c = [255 * t * tint[0], 255 * t * tint[1], 255 * t * tint[2]];
      if (cap) {
        const k = clamp01((cap.lat - lat) / 25) * clamp01((t - target) / 0.15) * cap.amount;
        c = mixc(c, c.map((ch, j) => ch * cap.tint[j]), k);
      }
      for (let k = 0; k < 3; k++) out[3 * i + k] = Math.max(0, Math.min(255, Math.round(c[k])));
    }
  }
  return out;
}

/**
 * Triton from the USGS Voyager 2 mosaic. Voyager flew past in 1989 in southern
 * summer: the north was in darkness and never seen. The mosaic's colour is Voyager's
 * enhanced orange-green-violet; Triton is a pale peach-grey, the south polar cap
 * pinker. So: brightness only, true colour, and the unseen north completed from the
 * seen terrain (completeMap).
 */
function triton(rgb, w, h) {
  const { L, seen } = lumSeen(rgb, w, h);
  return albedoColour(completeMap(L, seen, w, h, 801), w, h, { target: 0.8, contrast: 0.9, tint: [1.0, 0.96, 0.93], cap: { lat: -10, amount: 0.6, tint: [1.02, 0.93, 0.9] } });
}

const jpeg = (rgb, w, h, ow = w, oh = h) =>
  sharp(rgb, { raw: { width: w, height: h, channels: 3 } })
    .resize(ow, oh, { kernel: 'lanczos3' })
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer();

// ------------------------------------------------------------------ giants

/**
 * Fill a Hubble map's gaps: rows outside [latMin, latMax] (planetographic) and
 * black or fringed pixels within take the zonal colour of their row, or of the
 * nearest good row; `mirror` reflects the far hemisphere instead. Then remap rows
 * to parametric latitude for a globe flattened to `polar / equatorial`.
 */
function fillGiant(rgb, w, h, { latMin, latMax, flat, mirror = false, fringe = 70 }) {
  const rowLat = (y) => 90 - ((y + 0.5) / h) * 180;
  const median = new Float32Array(h * 3);
  const good = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    const lat = rowLat(y);
    if (lat < latMin || lat > latMax) continue;
    const px = [];
    for (let x = 0; x < w; x++) {
      const i = 3 * (y * w + x);
      if (rgb[i] + rgb[i + 1] + rgb[i + 2] > 30) px.push([rgb[i], rgb[i + 1], rgb[i + 2]]);
    }
    if (px.length < w * 0.6) continue;
    for (let k = 0; k < 3; k++) {
      const v = px.map((p) => p[k]).sort((a, b) => a - b);
      median[3 * y + k] = v[v.length >> 1];
    }
    good[y] = 1;
  }
  // rows much darker than the planet's typical row are shadow (Saturn's rings) or limb, not cloud
  const lum = (y) => median[3 * y] + median[3 * y + 1] + median[3 * y + 2];
  const typical = [...good.keys()].filter((y) => good[y]).map(lum).sort((a, b) => a - b);
  const floor = 0.62 * typical[typical.length >> 1];
  for (let y = 0; y < h; y++) if (good[y] && lum(y) < floor) good[y] = 0;
  // the good rows nearest an edge are darkened by the limb: fill from a few degrees inside
  const inset = Math.round((4 / 180) * h);
  const goodRows = [...good.keys()].filter((y) => good[y]);
  const nearest = (y) => {
    const g = goodRows.reduce((b, g) => (Math.abs(g - y) < Math.abs(b - y) ? g : b), goodRows[0]);
    const step = g > y ? inset : -inset;
    return good[g + step] ? g + step : g;
  };
  const filled = Buffer.alloc(rgb.length);
  for (let y = 0; y < h; y++) {
    let src = y, useRow = !good[y];
    if (useRow && mirror) {
      const m = h - 1 - y;
      if (good[m]) src = m;
    }
    const ry = good[src] ? src : nearest(y);
    for (let x = 0; x < w; x++) {
      const o = 3 * (y * w + x);
      if (!useRow) {
        const i = o;
        const dev = Math.abs(rgb[i] - median[3 * y]) + Math.abs(rgb[i + 1] - median[3 * y + 1]) + Math.abs(rgb[i + 2] - median[3 * y + 2]);
        const dark = rgb[i] + rgb[i + 1] + rgb[i + 2] <= 30;
        if (!dark && dev < fringe * 3) {
          filled[o] = rgb[i];
          filled[o + 1] = rgb[i + 1];
          filled[o + 2] = rgb[i + 2];
          continue;
        }
      }
      if (src !== y && good[src] && mirror) {
        // the mirrored hemisphere, a shade darker toward its pole: it is the winter side
        const i = 3 * (src * w + x);
        const ok = rgb[i] + rgb[i + 1] + rgb[i + 2] > 30;
        const dim = 1 - 0.08 * Math.abs(rowLat(y)) / 90;
        for (let k = 0; k < 3; k++) filled[o + k] = Math.round((ok ? rgb[i + k] : median[3 * src + k]) * dim);
      } else {
        for (let k = 0; k < 3; k++) filled[o + k] = Math.round(median[3 * ry + k]);
      }
    }
  }
  // soften the seams between real and filled rows: a vertical blur a few rows either side
  const soft = Buffer.from(filled);
  const R = Math.max(3, Math.round(h / 60));
  for (let y = 0; y < h; y++) {
    let seam = false;
    for (let d = -R; d <= R && !seam; d++) seam = good[Math.min(h - 1, Math.max(0, y + d))] !== good[y];
    if (!seam) continue;
    for (let x = 0; x < w * 3; x++) {
      let sum = 0;
      for (let d = -R; d <= R; d++) sum += filled[Math.min(h - 1, Math.max(0, y + d)) * w * 3 + x];
      soft[y * w * 3 + x] = Math.round(sum / (2 * R + 1));
    }
  }
  // planetographic rows -> parametric rows: tan φg = (a/c) tan β
  const outBuf = Buffer.alloc(rgb.length);
  for (let y = 0; y < h; y++) {
    const beta = rowLat(y) * DEG;
    const g = Math.atan(Math.tan(beta) / flat) / DEG;
    const sy = Math.min(h - 1, Math.max(0, ((90 - g) / 180) * h - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), t = sy - y0;
    for (let x = 0; x < w * 3; x++) outBuf[y * w * 3 + x] = Math.round(soft[y0 * w * 3 + x] * (1 - t) + soft[y1 * w * 3 + x] * t);
  }
  return outBuf;
}

/** Saturn's hexagon: a hexagonal jet at ~78°N (planetographic), bluish-grey around a darker polar vortex. */
function saturnPole(rgb, w, h) {
  const { fbm } = makeNoise(78);
  for (let y = 0; y < h; y++) {
    const lat = 90 - ((y + 0.5) / h) * 180;
    if (lat < 70) continue;
    for (let x = 0; x < w; x++) {
      const lon = -180 + ((x + 0.5) / w) * 360;
      const colat = 90 - lat;
      // polygon with six flat sides: distance of the edge from the pole at this longitude
      const sector = ((((lon * Math.PI) / 180) % (Math.PI / 3)) + Math.PI / 3) % (Math.PI / 3);
      const edge = 12 / Math.cos(sector - Math.PI / 6);
      const band = Math.exp(-(((colat - edge) / 1.1) ** 2));
      const inside = colat < edge ? 1 : 0;
      const d = dirAt(x, y, w, h);
      const n = fbm(d[0] * 30, d[1] * 30, d[2] * 30, 3);
      const i = 3 * (y * w + x);
      const blend = clamp01((lat - 70) / 4);
      const base = [rgb[i], rgb[i + 1], rgb[i + 2]];
      let c = mixc(base, [150, 160, 165], inside * 0.55 * blend);
      c = mixc(c, [118, 132, 140], band * 0.6 * blend);
      if (colat < 2.5) c = mixc(c, [80, 85, 90], (1 - colat / 2.5) * 0.7);
      for (let k = 0; k < 3; k++) rgb[i + k] = Math.max(0, Math.min(255, Math.round(c[k] * (1 + 0.06 * n))));
    }
  }
}

/**
 * White balance to a known true colour: Hubble's filter composites are not true
 * colour. Each channel is scaled so the map's mean matches `target`, and the
 * spread about the mean stretched by `contrast` so faint bands still show.
 */
function balance(rgb, target, contrast) {
  const T = hex(target);
  const mean = [0, 0, 0];
  const n = rgb.length / 3;
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) mean[k] += rgb[3 * i + k] / n;
  const lm = (mean[0] + mean[1] + mean[2]) / 3;
  for (let i = 0; i < n; i++) {
    const l = (rgb[3 * i] + rgb[3 * i + 1] + rgb[3 * i + 2]) / 3;
    const rel = 1 + ((l - lm) / lm) * contrast;
    for (let k = 0; k < 3; k++) rgb[3 * i + k] = Math.max(0, Math.min(255, Math.round(T[k] * rel)));
  }
}

async function giant(name, file, opts) {
  const src = await cached(`${OPAL}/${file}`, `opal/${file.split('/').pop()}`);
  const meta = await sharp(src).metadata();
  const w = meta.width - (meta.width % 2), h = Math.floor(w / 2);
  let rgb = await sharp(src).resize(w, h, { fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().toBuffer();
  // OPAL: left edge 0° System III west longitude, decreasing to the right = 0° east, increasing
  rgb = roll(rgb, w, h, 3, 0);
  if (name === 'saturn') saturnPole(rgb, w, h);
  rgb = fillGiant(rgb, w, h, opts);
  if (opts.target) balance(rgb, opts.target, opts.contrast ?? 1);
  const W = opts.size, H = W / 2;
  const big = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).resize(W, H, { kernel: 'lanczos3' }).modulate({ saturation: opts.saturation ?? 1 }).raw().toBuffer();
  await colourTiers(`${name}-color`, big, W, H);
}

// ------------------------------------------------------------------ main

await mkdir(join(out, 'moons'), { recursive: true });
sharp.cache(false);
sharp.concurrency(4);
const only = process.argv.slice(2);
const want = (k) => !only.length || only.includes(k);

if (want('mercury')) {
  // MD3 colour is three filters (430, 750, 1000 nm) as RGB: true colour is close to grey, a little warm
  const rgb = await usgsMap('Mercury_MESSENGER_MDIS_Basemap_MD3Color_Mosaic_Global_665m.tif', 4096, 2048);
  const warm = await sharp(rgb, { raw: { width: 4096, height: 2048, channels: 3 } }).modulate({ saturation: 0.32 }).tint({ r: 255, g: 238, b: 220 }).raw().toBuffer();
  await colourTiers('mercury-color', warm, 4096, 2048);
  const dem = await cached(`${USGS}/Mercury_Messenger_USGS_DEM_Global_665m_v2_32bit_clon0.tif`);
  await reliefTier('mercury-relief', await elevation(dem, 4096, 2048), 4096, 2048, 2439.4);
}

if (want('venus')) {
  const rgb = await usgsMap('Venus_Magellan_C3-MDIR_Colorized_Global_Mosaic_4641m.tif', 4096, 2048);
  await colourTiers('venus-color', rgb, 4096, 2048);
  const dem = await cached(`${USGS}/Venus_Magellan_Topography_Global_4641m_v02.tif`);
  await reliefTier('venus-relief', await elevation(dem, 4096, 2048), 4096, 2048, 6051.8);

  // the cloud deck: pale yellow-white, low contrast; faint bands and the dark "Y" opening westward
  const w = 2048, h = 1024;
  const { fbm } = makeNoise(4);
  const a = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = dirAt(x, y, w, h);
      const lat = Math.asin(d[2]), lon = Math.atan2(d[1], d[0]);
      // streaks stretched east-west by the 100 m/s winds: noise on squashed coordinates
      const warp = fbm(d[0] * 2, d[1] * 2, d[2] * 6, 4);
      const streak = fbm(d[0] * 1.5 + warp, d[1] * 1.5 + warp, d[2] * 14, 6);
      // the Y: two arms from the equator bending poleward toward the west
      const arm = (s) => Math.exp(-(((lat - s * 0.55 * Math.max(0, -Math.sin(lon * 0.5 + 0.4))) / 0.12) ** 2)) * Math.exp(-((Math.abs(lon + 0.6) / 1.6) ** 2));
      const Y = Math.max(arm(1), arm(-1), Math.exp(-((lat / 0.1) ** 2)) * Math.exp(-(((lon - 0.9) / 1.0) ** 2)));
      const collar = Math.exp(-(((Math.abs(lat) - 1.15) / 0.12) ** 2));
      a[y * w + x] = 0.8 + 0.07 * streak - 0.05 * Y + 0.04 * collar - 0.04 * Math.exp(-(((Math.abs(lat) - 1.45) / 0.1) ** 2));
    }
  await save(join(out, 'venus-clouds-2k.jpg'), await jpeg(tint(a, '#9c8a62', '#fbf0d2', 0.55, 0.95), w, h));
}

if (want('giants')) {
  await giant('jupiter', 'cycle32/jupiter/hlsp_opal_hst_wfc3-uvis_jupiter-2025a_f395n-f502n-f631n_v1_globalmap.tif', { latMin: -78, latMax: 82, flat: 66854 / 71492, size: 4096, fringe: 255 });
  await giant('saturn', 'cycle32/saturn/hlsp_opal_hst_wfc3-uvis_saturn-2025a_f395n-f502n-f631n_v1_globalmap.tif', { latMin: -76, latMax: 79, flat: 54364 / 60268, size: 2048, fringe: 45, target: '#d6c39c', contrast: 1.4 });
  // Uranus and Neptune in true colour: both a pale greenish blue, Neptune a little bluer
  // (Irwin et al. 2024, MNRAS 527, 11521), not the deep blue of Voyager's enhanced images
  await giant('uranus', 'cycle33/uranus/hlsp_opal_hst_wfc3-uvis_uranus-2025a_f657n-f547m-f467m_v1_globalmap.tif', { latMin: 6, latMax: 90, flat: 24973 / 25559, size: 2048, mirror: true, fringe: 30, target: '#b4d8dc', contrast: 1.2 });
  await giant('neptune', 'cycle32/neptune/hlsp_opal_hst_wfc3-uvis_neptune-2025b_f467m-f547m-f657n_v1_globalmap.tif', { latMin: -90, latMax: 34, flat: 24341 / 24764, size: 2048, mirror: true, fringe: 30, target: '#9fc0dc', contrast: 1.8 });
}

if (want('moons')) {
  const moon = async (name, rgb, w, h, ow = 2048) => save(join(out, 'moons', `${name}.jpg`), await jpeg(rgb, w, h, ow, ow / 2));
  // Galilean moons
  await moon('io', await usgsMap('Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif', 4096, 2048), 4096, 2048);
  await moon('europa', tintGrey(fillNoData(await usgsMap('Europa_Voyager_GalileoSSI_global_mosaic_500m.tif', 4096, 2048), 4096, 2048, 502), '#6e5440', '#f3ede2', 0.9), 4096, 2048);
  await moon('ganymede', fillNoData(await usgsMap('Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif', 4096, 2048), 4096, 2048, 503), 4096, 2048);
  await moon('callisto', tintGrey(fillNoData(await usgsMap('Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif', 4096, 2048), 4096, 2048, 504), '#2a241f', '#d6d0c6'), 4096, 2048);
  // Saturn's
  await moon('titan', tintGrey(await usgsMap('Titan_ISS_P19658_Mosaic_Global_4km.tif', 2048, 1024), '#3a2a18', '#e2c08a'), 2048, 1024, 1024);
  await moon('rhea', tintGrey(await usgsMap('Rhea_Cassini_Voyager_mosaic_global_417m.tif', 4096, 2048), '#4a4744', '#f2f0ec'), 4096, 2048);
  await moon('iapetus', tintGrey(await usgsMap('Iapetus_Cassini_Voyager_mosaic_global_783m.tif', 4096, 2048), '#2b1c12', '#f0ece4', 0.85), 4096, 2048);
  await moon('dione', tintGrey(await usgsMap('Dione_Cassini_Voyager_mosaic_global_154m.tif', 4096, 2048), '#55524e', '#f4f2ee'), 4096, 2048, 1024);
  await moon('tethys', tintGrey(await usgsMap('Tethys_Cassini_mosaic_global_293m.tif', 4096, 2048), '#5e5b57', '#f6f4f0'), 4096, 2048, 1024);
  await moon('enceladus', tintGrey(await usgsMap('Enceladus_Cassini_mosaic_global_110m.tif', 4096, 2048), '#7c7f84', '#fbfcfd'), 4096, 2048, 1024);
  // Mimas: the DLR basemap is already centred on 0° (Herschel sits at 112°W, u = 0.19, as it should)
  const zip = await cached(`${USGS}/Mimas/Cassini_DLR_Mimas.zip`);
  const mimasTif = join(cache, 'MI_170630_DLR_basemap.tif');
  if (!existsSync(mimasTif)) writeFileSync(mimasTif, execFileSync('unzip', ['-p', zip, 'Cassini_DLR/MI_170630_DLR_basemap.tif'], { maxBuffer: 1 << 28 }));
  const mimas = await sharp(mimasTif, { limitInputPixels: false }).resize(2048, 1024, { fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().toBuffer();
  await moon('mimas', tintGrey(mimas, '#4f4c48', '#efedea'), 2048, 1024, 1024);
}

if (want('moons') || want('triton')) {
  // Neptune's
  const rgb = await usgsMap('Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif', 4096, 2048);
  await save(join(out, 'moons', 'triton.jpg'), await jpeg(triton(rgb, 4096, 2048), 4096, 2048, 2048, 1024));
}

if (want('moons') || want('uranian')) {
  // Uranus' five: Voyager 2's 1986 mosaics (USGS, via JPL's Solar System Simulator). Voyager
  // saw only the southern hemispheres, sunlit at the time; the north is completed here.
  // Brightness to relative albedo (geometric: Ariel 0.53, Titania 0.35, Miranda 0.32,
  // Oberon 0.31, Umbriel 0.26), greys warmed a little for Titania and redder Oberon.
  const W = 2048, H = 1024;
  const moons = [
    ['ariel', 1, { target: 0.78, contrast: 0.9, tint: [1, 1, 1] }],
    ['umbriel', 2, { target: 0.5, contrast: 0.9, tint: [1, 0.99, 0.97] }],
    ['titania', 3, { target: 0.62, contrast: 0.9, tint: [1.03, 1, 0.95] }],
    ['oberon', 4, { target: 0.57, contrast: 0.9, tint: [1.05, 1, 0.93] }],
    ['miranda', 5, { target: 0.58, contrast: 0.9, tint: [1, 1, 0.99] }],
  ];
  for (const [name, k, look] of moons) {
    const tif = await cached(`https://maps.jpl.nasa.gov/tmaps/pix/ura${k}vuu2.tif`);
    // 1440 x 720, east longitude from −180° at the left, as the app lays maps out
    const grey = await sharp(tif).resize(W, H, { kernel: 'lanczos3' }).toColourspace('srgb').removeAlpha().raw().toBuffer();
    const { L, seen } = lumSeen(grey, W, H);
    await save(join(out, 'moons', `${name}.jpg`), await jpeg(albedoColour(completeMap(L, seen, W, H, 700 + k), W, H, look), W, H));
  }
}

console.log('done');
