// Decoder for the ORBX snapshot written by data/fetch-tles.mjs.

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
export const Group = { Starlink: 0, Debris: 1, OtherSatellites: 2 } as const;
export type Group = (typeof Group)[keyof typeof Group];

export function groupOf(category: number): Group {
  if (category === Category.Starlink) return Group.Starlink;
  if (category === Category.Debris || category === Category.RocketBody) return Group.Debris;
  return Group.OtherSatellites;
}

export type StarlinkVersion = 1 | 2 | 3;

/**
 * Starlink hardware generation by NORAD id, as [first id, version] in id order: each
 * version holds until the next entry. v1 is V1.0 and V1.5 (Falcon 9, 2019-23), v2 the
 * V2 Mini family including the Optimized and Direct-to-Cell variants (Falcon 9, 2023 on),
 * v3 the Starship-launched V3. Through mid-2023 SpaceX alternated V1.5 and V2 Mini
 * launches, hence the back and forth. Built by joining CelesTrak's Starlink group
 * (NORAD id, launch) with Jonathan McDowell's launch list (planet4589.org/space/con/star),
 * October 2026. Falcon 9 still flies V2 Minis, so ids after a V3 launch fall back to v2:
 * add each Starship launch's id block here.
 */
const STARLINK_VERSIONS: [number, StarlinkVersion][] = [
  [0, 1],
  [56287, 2], // 2023-056, first V2 Minis still in orbit (Group 6-1's, 2023-026, have all reentered)
  [56317, 1],
  [56688, 2],
  [56767, 1],
  [56823, 2],
  [56876, 1],
  [57290, 2],
  [57328, 1], // 2023-099, the last V1.5 launch
  [57404, 2],
  [100855, 3], // Starship flight 14 (Ship 41), 2026-225: the first V3s in orbit
  [100881, 2],
];

export function starlinkVersion(norad: number): StarlinkVersion {
  let v = STARLINK_VERSIONS[0][1];
  for (const [first, version] of STARLINK_VERSIONS) {
    if (norad < first) break;
    v = version;
  }
  return v;
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
  if (magic !== 'ORBX') throw new Error(`not a catalog snapshot (magic ${magic})`);
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

/** Elements of the objects matching `keep`, plus their catalog indices. */
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
