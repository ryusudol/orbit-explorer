// The camera's journey from one world to another.
//
// Distances span five orders of magnitude (a few thousand km around a planet,
// 10⁸ km to Mars), so the flight is planned in log-distance. For the first part
// the camera rises away from the origin body A, its distance growing
// geometrically while it swings round to A's side facing the destination B and
// turns to look at it. For the second part it falls toward B, the distance
// shrinking geometrically, and swings round to B's sunlit side. The halfway
// point is where the two parts meet, D/2 from each body. Splitting the time in
// proportion to each part's log-distance range makes the speed continuous there.
// The camera never passes through either body: its distance from A, then from B,
// only grows, then only shrinks.
//
// When one end of the flight is much farther out than the two worlds are apart
// (the Oort cloud's view of the Sun from 60,000 au, after leaving the Earth 1 au
// from it), there is no halfway to fall from: the flight is one long zoom. The
// distance changes geometrically from start to end, the centre it is measured
// from slides from the near world to the far one while the camera is already
// several times their separation away, and the direction turns while the camera
// is still close to the near world, so it can't sweep through either body.

export type V3 = [number, number, number];

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.sqrt(dot(a, a));
export const unit = (a: V3): V3 => scale(a, 1 / (len(a) || 1));
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Spherical interpolation between unit vectors; picks a sensible plane for opposite ones. */
export function slerp(a: V3, b: V3, t: number): V3 {
  const c = Math.max(-1, Math.min(1, dot(a, b)));
  if (c > 0.99999) return unit(add(scale(a, 1 - t), scale(b, t)));
  let axisPerp: V3;
  if (c < -0.99999) {
    // antiparallel: go round through any perpendicular, preferring one in the equatorial plane
    axisPerp = unit(Math.abs(a[2]) < 0.9 ? cross(a, [0, 0, 1]) : cross(a, [1, 0, 0]));
  } else {
    axisPerp = unit(sub(b, scale(a, c)));
  }
  const theta = Math.acos(c) * t;
  return add(scale(a, Math.cos(theta)), scale(axisPerp, Math.sin(theta)));
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

export interface TravelPlan {
  /** camera offset from A at departure (km) */
  from: V3;
  /** where the camera looked at departure (unit) */
  look: V3;
  /** camera offset direction from B on arrival (unit) and distance (km) */
  toDir: V3;
  toDist: number;
  /** wall-clock duration, ms */
  dur: number;
}

/** A zoom, not a cruise: one end is farther out than a quarter of the worlds' separation. */
export const isZoom = (fromDist: number, toDist: number, D: number) => Math.max(fromDist, toDist) > D / 4;

/** Duration from the flight's log-distance range: ~2.6 s to the Moon, ~5 s to Mars, ~6 s out to the Oort cloud. */
export function travelDuration(fromDist: number, toDist: number, D: number): number {
  const L = isZoom(fromDist, toDist, D) ? Math.abs(Math.log(toDist / fromDist)) : Math.log(D / 2 / fromDist) + Math.log(D / 2 / toDist);
  return Math.min(7000, 1600 + 200 * Math.max(0, L));
}

/**
 * Camera position (relative to A, km) and look direction at progress u ∈ [0, 1],
 * given B's position relative to A now (both bodies move during the flight).
 */
export function travelPose(plan: TravelPlan, u: number, B: V3): { pos: V3; look: V3 } {
  const k = easeInOut(Math.max(0, Math.min(1, u)));
  const D = len(B);
  if (isZoom(len(plan.from), plan.toDist, D)) return zoomPose(plan, k, B, D);
  const dir = scale(B, 1 / D);
  const r0 = len(plan.from), r1 = plan.toDist;
  const half = D / 2;
  const L1 = Math.max(0.05, Math.log(half / r0)), L2 = Math.max(0.05, Math.log(half / r1));
  const tm = L1 / (L1 + L2);
  let pos: V3;
  if (k <= tm) {
    const f = k / tm;
    const d = slerp(unit(plan.from), dir, smoothstep(0, 0.85, f));
    pos = scale(d, r0 * Math.exp(L1 * f));
  } else {
    const f = (k - tm) / (1 - tm);
    const d = slerp(scale(dir, -1), plan.toDir, smoothstep(0.15, 1, f));
    pos = add(B, scale(d, half * Math.exp(-L2 * f)));
  }
  // turn from the departure view to the destination early, while still close to A
  const toB = unit(sub(B, pos));
  const look = slerp(plan.look, toB, smoothstep(0.02, Math.min(0.45, tm), k));
  return { pos, look };
}

/**
 * Where to arrive: 50° off the Sun, toward the side we came from, and a little off
 * the equator toward the sunlit pole. The first view of a world is lit three-quarters, with a terminator
 * where the relief shows (head-on to the Sun, a world looks flat).
 */
export function arrivalDirection(fromAtoB: V3, sunFromB: V3, pole: V3): V3 {
  const sun = unit(sunFromB);
  const back = unit(scale(fromAtoB, -1));
  let side = sub(back, scale(sun, dot(back, sun)));
  if (len(side) < 1e-3) side = cross(sun, pole);
  const d = slerp(sun, unit(side), 50 / 90);
  // lean toward the sunlit pole: from there a ringed planet's rings show their lit face
  return unit(add(d, scale(pole, dot(sun, pole) < 0 ? -0.3 : 0.3)));
}

/** The one-long-zoom flight (see the header): `k` is eased progress, `B` the destination relative to A. */
function zoomPose(plan: TravelPlan, k: number, B: V3, D: number): { pos: V3; look: V3 } {
  const r0 = len(plan.from), r1 = plan.toDist;
  const outbound = r1 > r0;
  const lr = Math.log(r0) + (Math.log(r1) - Math.log(r0)) * k;
  const r = Math.exp(lr);
  // centre: the near world while within 2D of it, the far one beyond 8D
  const w = smoothstep(Math.log(2 * D), Math.log(8 * D), lr);
  const c = outbound ? scale(B, w) : scale(B, 1 - w);
  // direction: turned while near the near world
  const rNear = outbound ? r0 : r1;
  const h = smoothstep(Math.log(rNear), Math.log(2 * D), lr);
  const d = slerp(unit(plan.from), plan.toDir, outbound ? h : 1 - h);
  const pos = add(c, scale(d, r));
  const toB = unit(sub(B, pos));
  const look = slerp(plan.look, toB, smoothstep(0.02, 0.4, k));
  return { pos, look };
}
