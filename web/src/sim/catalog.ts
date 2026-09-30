// Decoder for the KSLR snapshot written by data/fetch-tles.mjs.

export const ELEMENT_STRIDE = 8;

export const Category = {
  Payload: 0,
  Starlink: 1,
  Constellation: 2,
  RocketBody: 3,
  Debris: 4,
  Station: 5,
} as const;
export type Category = (typeof Category)[keyof typeof Category];

/** Display groups: three hues is the most a dense scatter can carry legibly. */
export const Group = { Starlink: 0, Debris: 1, Payload: 2 } as const;
export type Group = (typeof Group)[keyof typeof Group];

export function groupOf(category: number): Group {
  if (category === Category.Starlink) return Group.Starlink;
  if (category === Category.Debris || category === Category.RocketBody) return Group.Debris;
  return Group.Payload;
}

export interface Catalog {
  count: number;
  generatedMs: number;
  /** [epoch_jd, mean_motion rev/day, ecc, incl, raan, argp, mean anomaly (deg), bstar] per object */
  packed: Float64Array;
  ids: Uint32Array;
  category: Uint8Array;
  group: Uint8Array;
  names: string[];
}

export function decodeCatalog(buffer: ArrayBuffer): Catalog {
  const dv = new DataView(buffer);
  const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 4));
  if (magic !== 'KSLR') throw new Error(`not a catalogue snapshot (magic ${magic})`);
  const version = dv.getUint32(4, true);
  if (version !== 1) throw new Error(`unsupported snapshot version ${version}`);
  const n = dv.getUint32(8, true);
  const generatedMs = dv.getFloat64(16, true);

  let off = 32;
  const epoch = new Float64Array(buffer, off, n);
  off += 8 * n;
  const meanMotion = new Float64Array(buffer, off, n);
  off += 8 * n;
  const f32: Float32Array[] = [];
  for (let k = 0; k < 6; k++) {
    f32.push(new Float32Array(buffer, off, n));
    off += 4 * n;
  }
  const ids = new Uint32Array(buffer.slice(off, off + 4 * n));
  off += 4 * n;
  const category = new Uint8Array(buffer.slice(off, off + n));
  off += n;
  const lens = new Uint8Array(buffer, off, n);
  off += n;

  const packed = new Float64Array(n * ELEMENT_STRIDE);
  for (let i = 0; i < n; i++) {
    const o = i * ELEMENT_STRIDE;
    packed[o] = epoch[i];
    packed[o + 1] = meanMotion[i];
    for (let k = 0; k < 6; k++) packed[o + 2 + k] = f32[k][i];
  }

  const dec = new TextDecoder();
  const names: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    names[i] = dec.decode(new Uint8Array(buffer, off, lens[i]));
    off += lens[i];
  }
  const group = new Uint8Array(n);
  for (let i = 0; i < n; i++) group[i] = groupOf(category[i]);

  return { count: n, generatedMs, packed, ids, category, group, names };
}

/** Elements of the objects matching `keep`, plus their catalogue indices. */
export function subset(catalog: Catalog, keep: (i: number) => boolean): { packed: Float64Array; indices: Uint32Array } {
  const idx: number[] = [];
  for (let i = 0; i < catalog.count; i++) if (keep(i)) idx.push(i);
  const packed = new Float64Array(idx.length * ELEMENT_STRIDE);
  idx.forEach((i, k) => packed.set(catalog.packed.subarray(i * ELEMENT_STRIDE, (i + 1) * ELEMENT_STRIDE), k * ELEMENT_STRIDE));
  return { packed, indices: Uint32Array.from(idx) };
}

/** Mean altitude (km) from mean motion, for histograms (Kepler's third law, WGS-72). */
export function meanAltitudeKm(catalog: Catalog, i: number): number {
  const n = (catalog.packed[i * ELEMENT_STRIDE + 1] * 2 * Math.PI) / 86400; // rad/s
  return Math.cbrt(398600.8 / (n * n)) - 6378.135;
}
