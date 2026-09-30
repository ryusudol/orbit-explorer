#!/usr/bin/env node
// Downloads NASA's public-domain Earth imagery and writes web-sized textures.
//   Blue Marble Next Generation (Dec 2004, 5400x2700)   -> earth-day[-2k].jpg, earth-day.ktx2
//   Black Marble 2016 city lights (3 km, 13500x6750)     -> earth-night[-2k].jpg, earth-night.ktx2
// The 2k JPEGs paint first; the 4k KTX2 (Basis ETC1S + mips) streams in after.
// KTX2 stays block-compressed in GPU memory (~8 MB instead of ~43 MB for RGBA8 +
// mips at 4k) and is transcoded off the main thread.
// Sources are cached in data/cache/textures so re-runs are offline.

import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeToKTX2 } from 'ktx2-encoder';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cache = join(root, 'data', 'cache', 'textures');
const out = join(root, 'web', 'public', 'textures');

const SOURCES = [
  {
    url: 'https://eoimages.gsfc.nasa.gov/images/imagerecords/74000/74218/world.200412.3x5400x2700.jpg',
    file: 'bluemarble-5400.jpg',
    target: 'earth-day.jpg',
    // keep oceans dark and land readable on the mission-control palette
    pipeline: (img) => img.modulate({ brightness: 0.92, saturation: 0.85 }).gamma(1.1),
  },
  {
    url: 'https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg',
    file: 'blackmarble-13500.jpg',
    target: 'earth-night.jpg',
    pipeline: (img) => img.greyscale().linear(1.25, -8),
  },
];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

await mkdir(cache, { recursive: true });
await mkdir(out, { recursive: true });
sharp.cache(false);

for (const s of SOURCES) {
  const src = join(cache, s.file);
  if (!(await exists(src))) {
    console.log(`downloading ${s.url}`);
    const res = await fetch(s.url);
    if (!res.ok) throw new Error(`${res.status} for ${s.url}`);
    await writeFile(src, Buffer.from(await res.arrayBuffer()));
  }
  for (const [suffix, width] of [['', 4096], ['-2k', 2048]]) {
    const target = join(out, s.target.replace('.jpg', `${suffix}.jpg`));
    await s
      .pipeline(sharp(src, { limitInputPixels: false }).resize(width, width / 2, { kernel: 'lanczos3' }))
      .jpeg({ quality: 82, mozjpeg: true, chromaSubsampling: '4:2:0' })
      .toFile(target);
    const { size } = await stat(target);
    console.log(`${target.replace(root + '/', '')}: ${(size / 1024).toFixed(0)} KiB`);
  }
  const jpg4k = join(out, s.target);
  // compressed textures can't be flipped at upload (flipY is ignored), so store
  // rows bottom-up to match the JPEG path, where v = 0 is the south pole
  const ktx = await encodeToKTX2(new Uint8Array(await sharp(jpg4k).flip().toBuffer()), {
    isUASTC: false,
    generateMipmap: true,
    qualityLevel: 200,
    compressionLevel: 2,
    isSetKTX2SRGBTransferFunc: true,
    imageDecoder: async (buffer) => {
      const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data: new Uint8Array(data), width: info.width, height: info.height };
    },
  });
  const ktxPath = jpg4k.replace('.jpg', '.ktx2');
  await writeFile(ktxPath, ktx);
  console.log(`${ktxPath.replace(root + '/', '')}: ${(ktx.length / 1024).toFixed(0)} KiB`);
}

// Basis transcoder for three's KTX2Loader, served same-origin (COEP)
const require = createRequire(import.meta.url);
const basis = join(dirname(require.resolve('three')), '..', 'examples', 'jsm', 'libs', 'basis');
await mkdir(join(root, 'web', 'public', 'basis'), { recursive: true });
for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm']) await copyFile(join(basis, f), join(root, 'web', 'public', 'basis', f));
console.log('web/public/basis: transcoder copied');
