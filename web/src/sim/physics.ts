// Physical constants and the latency model.

export const C_KM_S = 299_792.458;
/** Group index of standard single-mode fiber (SMF-28 at 1550 nm). */
export const FIBER_INDEX = 1.4682;
export const C_FIBER_KM_S = C_KM_S / FIBER_INDEX;
/** IUGG mean Earth radius, km. */
export const R_MEAN_KM = 6371.0088;
export const R_EQ_KM = 6378.137;
export const FLATTENING = 1 / 298.257223563;
export const DEG = Math.PI / 180;

/** Great-circle distance (km) on the mean sphere (haversine). */
export function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG, p2 = lat2 * DEG;
  const dp = p2 - p1, dl = (lon2 - lon1) * DEG;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_MEAN_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * One-way latency (ms) of an ideal fiber laid along the great circle - the best
 * case for fiber. Real cable routes are 10-30% longer and add repeaters and switching.
 */
export function fiberLatencyMs(distanceKm: number): number {
  return (distanceKm / C_FIBER_KM_S) * 1000;
}

/** One-way latency (ms) of a free-space path (laser links and radio up/downlinks). */
export function vacuumLatencyMs(distanceKm: number): number {
  return (distanceKm / C_KM_S) * 1000;
}

/** WGS-84 geodetic -> Earth-fixed (km). */
export function geodeticToEcef(latDeg: number, lonDeg: number, hKm = 0): [number, number, number] {
  const e2 = FLATTENING * (2 - FLATTENING);
  const lat = latDeg * DEG, lon = lonDeg * DEG;
  const s = Math.sin(lat);
  const n = R_EQ_KM / Math.sqrt(1 - e2 * s * s);
  return [(n + hKm) * Math.cos(lat) * Math.cos(lon), (n + hKm) * Math.cos(lat) * Math.sin(lon), (n * (1 - e2) + hKm) * s];
}

/** Earth-central half-angle (rad) of the ground cap that sees altitude h above elevation e. */
export function capHalfAngle(hKm: number, minElevDeg: number): number {
  const e = minElevDeg * DEG;
  return Math.acos((R_MEAN_KM * Math.cos(e)) / (R_MEAN_KM + hKm)) - e;
}
