// The solar system seen from outside: the planets' orbits, the Voyagers' paths,
// the Kuiper belt, the heliosphere's boundaries and the Oort cloud.
//
// Everything here is heliocentric and huge, so every vertex and point is drawn
// through far.ts: pulled toward the camera along its line of sight, which leaves
// the picture unchanged. Each part fades in at the scale where it means something.
//
//   Orbits         the planets' (VSOP87 / Standish, sim/planets.ts) and the named dwarf planets'
//   Voyagers       their whole paths since launch, from JPL Horizons (the ephemeris snapshot)
//   Kuiper belt    all ~7,300 known trans-Neptunian objects, from JPL's Small-Body
//                  Database (data/fetch-small-bodies.mjs), placed by two-body motion
//   Heliosphere    the termination shock and heliopause where the Voyagers crossed
//                  them (94 and 84 au; 122 and 119 au), shaped as a blunt nose
//                  toward the interstellar wind (ecliptic λ 255.7°, β 5.1°) and an
//                  open tail behind
//   Oort cloud     a model, not data: no Oort cloud object has ever been seen there.
//                  Its existence is inferred from long-period comets. 50,000 points
//                  following the usual picture (Duncan, Quinn & Tremaine 1987):
//                  number density ∝ r^−3.5, an inner (Hills) cloud from 2,000 to
//                  20,000 au flattened toward the ecliptic, and a round outer cloud
//                  to 100,000 au, a third of the way to the nearest star.

import * as THREE from 'three/webgpu';
import { float, mrt, normalView, pow, abs, vec3, uniform } from 'three/tsl';
import { highp } from './precision';
import { AU_KM, mul, rotX, type Mat3, type Vec3 } from '../sim/solar';
import { embHeliocentric, heliocentric, ORBIT_DAYS, VSOP_PLANETS } from '../sim/planets';
import { eccentricAnomaly, type EphObject } from '../sim/ephemeris';
import { farScale } from './far';
import { SegmentLayer } from './lines';
import { SpriteLayer } from './sprites';

const DEG = Math.PI / 180;
const ECL: Mat3 = rotX(23.43928 * DEG);
const ORBIT_N = 360;
const RING_N = 256;

const ORBIT_HEX: Record<string, string> = {
  mercury: '#a59d94',
  venus: '#e8d7a8',
  earth: '#6fa8ff',
  mars: '#e07a4f',
  jupiter: '#d8b48c',
  saturn: '#e3cf9c',
  uranus: '#a9dce3',
  neptune: '#5b7fe0',
};
const DWARFS = ['Pluto', 'Eris', 'Haumea', 'Makemake', 'Gonggong', 'Quaoar', 'Orcus', 'Sedna', 'Leleakuhonua', 'Arrokoth'];
const VOYAGER = new THREE.Color('#DDAA33');

interface Tno {
  count: number;
  /** a (au), e, i, node, peri, M0 (rad), epoch (TDB JD), n (rad/day) per object */
  el: Float64Array;
  /** absolute magnitude */
  H: Float32Array;
  named: { index: number; name: string }[];
}

export function decodeTno(buf: ArrayBuffer): Tno {
  const dv = new DataView(buf);
  if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== 'TNO1') throw new Error('not a TNO file');
  const n = dv.getUint32(4, true);
  const base = dv.getFloat64(8, true);
  const f = new Float32Array(buf, 24, n * 8);
  const el = new Float64Array(n * 8);
  const H = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    H[k] = f[8 * k + 7];
    const a = f[8 * k];
    el.set([a, f[8 * k + 1], f[8 * k + 2] * DEG, f[8 * k + 3] * DEG, f[8 * k + 4] * DEG, f[8 * k + 5] * DEG, base + f[8 * k + 6], (0.01720209895 / Math.pow(a, 1.5))], 8 * k);
  }
  const named = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 24 + n * 32))) as Tno['named'];
  return { count: n, el, H, named };
}

/** Heliocentric ICRF position (km) of an orbit given by ecliptic J2000 elements, at TDB `jd`. */
function eclipticOrbit(el: Float64Array, o: number, jd: number, out: Vec3) {
  const a = el[o] * AU_KM, e = el[o + 1], i = el[o + 2], node = el[o + 3], peri = el[o + 4];
  const M = el[o + 5] + el[o + 7] * (jd - el[o + 6]);
  const E = eccentricAnomaly(M, e);
  const x = a * (Math.cos(E) - e), y = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(peri), sw = Math.sin(peri), cO = Math.cos(node), sO = Math.sin(node), cI = Math.cos(i), sI = Math.sin(i);
  const X = (cw * cO - sw * sO * cI) * x + (-sw * cO - cw * sO * cI) * y;
  const Y = (cw * sO + sw * cO * cI) * x + (-sw * sO + cw * cO * cI) * y;
  const Z = sw * sI * x + cw * sI * y;
  out[0] = X;
  out[1] = Y * ECL[4] + Z * ECL[5];
  out[2] = Y * ECL[7] + Z * ECL[8];
}

/** Deterministic random numbers, so the model cloud is the same on every visit. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Radii from a power-law shell population: number density ∝ r^−3.5 between r0 and r1. */
const powerLawR = (u: number, r0: number, r1: number) => {
  const a = r0 ** -0.5, b = r1 ** -0.5;
  return (a - u * (a - b)) ** -2;
};

export interface HelioLabel {
  key: string;
  text: string;
  /** heliocentric position, equatorial of date (km) */
  at: Vec3;
  /** shown while the camera's distance from the Sun is within [near, far] km */
  near: number;
  far: number;
  kind: 'region' | 'body' | 'scale';
}

export class Heliosphere {
  readonly objects: THREE.Object3D[];
  private orbits = new SegmentLayer(ORBIT_N * 18, new THREE.Color('#ffffff'), 0.55);
  private paths = new SegmentLayer(8000, VOYAGER, 0.75);
  private rings = new SegmentLayer(RING_N * 6, new THREE.Color('#9fb4d8'), 0.22);
  private cloud: SpriteLayer;
  private belt = new SpriteLayer(8000, 'glow', { renderOrder: 1, bloom: 0.3 });
  private shells = new THREE.Group();
  private shellGain = uniform(0);
  /** heliocentric ICRF points, km: orbits (polyline per planet), rings, Voyager paths */
  private orbitPts: Float64Array[] = [];
  private orbitCol: THREE.Color[] = [];
  private ringPts: Float64Array[] = [];
  private pathPts: Float64Array[] = [];
  private cloudAu: Float32Array;
  private cloudCount: number;
  /** per point: base color (rgb), size, gain and distance from the Sun (au) */
  private cloudLook: Float32Array;
  private cloudDimAt = NaN;
  private tno: Tno | null = null;
  private tnoPos = new Float64Array(0);
  private tnoJd = NaN;
  private orbitsJd = NaN;
  private P: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  readonly labels: HelioLabel[] = [];
  /** fade of each part this frame, 0..1 */
  fades = { orbits: 0, belt: 0, cloud: 0, shells: 0 };

  constructor() {
    // the model Oort cloud, in au, ICRF
    const rand = rng(1950);
    const inner = 12_000, outer = 38_000;
    this.cloudCount = inner + outer;
    this.cloudAu = new Float32Array(this.cloudCount * 3);
    for (let k = 0; k < this.cloudCount; k++) {
      const isInner = k < inner;
      const r = isInner ? powerLawR(rand(), 2_000, 20_000) : powerLawR(rand(), 20_000, 100_000);
      const z0 = rand() * 2 - 1, t = rand() * 2 * Math.PI, q = Math.sqrt(1 - z0 * z0);
      // the inner cloud is a thick disc near its inner edge, rounding out with distance
      const flat = isInner ? 0.3 + 0.7 * Math.min(1, (r - 2_000) / 16_000) : 1;
      const ecl: Vec3 = [q * Math.cos(t) * r, q * Math.sin(t) * r, z0 * r * flat];
      this.cloudAu.set(mul(ECL, ecl), 3 * k);
    }
    this.cloud = new SpriteLayer(this.cloudCount, 'glow', { renderOrder: 1, bloom: 0.1 });
    const c = new THREE.Color();
    this.cloudLook = new Float32Array(this.cloudCount * 6);
    for (let k = 0; k < this.cloudCount; k++) {
      const r = Math.hypot(this.cloudAu[3 * k], this.cloudAu[3 * k + 1], this.cloudAu[3 * k + 2]);
      c.setHSL(0.58 + 0.04 * rand(), 0.35, 0.72 + 0.2 * rand());
      this.cloudLook.set([c.r, c.g, c.b, 1.6 + 1.0 * rand(), 0.3 * (0.6 + 0.8 * rand()), r], 6 * k);
    }
    this.dimCloud(1e5);

    // distance rings in the ecliptic: 1 au to 100,000 au
    for (const au of [1, 10, 100, 1_000, 10_000, 100_000]) {
      const pts = new Float64Array(RING_N * 3);
      for (let k = 0; k < RING_N; k++) pts.set(mul(ECL, [au * AU_KM * Math.cos((2 * Math.PI * k) / RING_N), au * AU_KM * Math.sin((2 * Math.PI * k) / RING_N), 0]), 3 * k);
      this.ringPts.push(pts);
      const lightH = (au * AU_KM) / 299_792.458 / 3600;
      const light = lightH < 1 ? `${Math.round(lightH * 60)} light-minutes` : lightH < 48 ? `${Math.round(lightH)} light-hours` : lightH < 24 * 365 ? `${Math.round(lightH / 24)} light-days` : `${(lightH / 24 / 365.25).toFixed(1)} light-years`;
      const at = mul(ECL, [0, -au * AU_KM, 0]);
      this.labels.push({ key: `ring${au}`, text: `${au.toLocaleString('en-US')} au · ${light}`, at, near: au * AU_KM * 0.3, far: au * AU_KM * 40, kind: 'scale' });
    }

    this.shells.add(this.shell(122, 0.45, 380), this.shell(90, 0.25, 160));
    this.shells.name = 'heliosphere';
    const nose = this.noseDir();
    this.labels.push(
      { key: 'sun', text: 'Sun', at: [0, 0, 0], near: 0.3 * AU_KM, far: 3_000 * AU_KM, kind: 'body' },
      { key: 'heliopause', text: 'Heliopause', at: [nose[0] * 125 * AU_KM, nose[1] * 125 * AU_KM, nose[2] * 125 * AU_KM], near: 40 * AU_KM, far: 4_000 * AU_KM, kind: 'region' },
      { key: 'kuiper', text: 'Kuiper belt', at: mul(ECL, [0, 44 * AU_KM, 0]), near: 15 * AU_KM, far: 1_500 * AU_KM, kind: 'region' },
      { key: 'oort-inner', text: 'Inner Oort cloud', at: mul(ECL, [9_000 * AU_KM, 0, 0]), near: 2_500 * AU_KM, far: 300_000 * AU_KM, kind: 'region' },
      { key: 'oort-outer', text: 'Outer Oort cloud (modeled)', at: mul(ECL, [0, 0, 60_000 * AU_KM]), near: 15_000 * AU_KM, far: 600_000 * AU_KM, kind: 'region' },
    );
    this.objects = [this.orbits.object, this.rings.object, this.paths.object, this.belt.object, this.cloud.object, this.shells];
  }

  /**
   * The true density piles thousands of points into the inner edge's fraction of a degree
   * when seen from far out, and additive points there would glare: from afar each is
   * dimmed by its depth into the cloud, so the shell reads as a shell. From inside, the
   * points spread over the sky and keep their brightness. `rAu`: camera from the Sun.
   */
  private dimCloud(rAu: number) {
    this.cloudDimAt = rAu;
    const k = 1.3 * THREE.MathUtils.smoothstep(Math.log(rAu), Math.log(25_000), Math.log(250_000));
    const L = this.cloudLook, col = new THREE.Color();
    for (let i = 0; i < this.cloudCount; i++) {
      const o = 6 * i;
      col.setRGB(L[o], L[o + 1], L[o + 2]);
      this.cloud.setColor(i, col, L[o + 3], L[o + 4] * Math.min(1, (L[o + 5] / 20_000) ** k));
    }
    this.cloud.colors.needsUpdate = true;
  }

  /** Upwind direction of the interstellar wind (ICRF): where the heliosphere's nose points. */
  private noseDir(): Vec3 {
    const l = 255.7 * DEG, b = 5.1 * DEG;
    return mul(ECL, [Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b)]);
  }

  /** A boundary of the heliosphere: `noseAu` toward the nose, opening into a tail up to `tailAu`. */
  private shell(noseAu: number, flare: number, tailAu: number): THREE.Mesh {
    const g = new THREE.SphereGeometry(1, 96, 64);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      // +x is the nose here; r grows toward the tail like a blunt paraboloid
      const cos = v.x;
      const r = Math.min(tailAu, noseAu * Math.pow(2 / Math.max(1 + cos, 0.02), flare));
      v.multiplyScalar(r * AU_KM);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    mat.contextNode = highp(); // model-view in float64: the camera can be 10¹⁰ km from the origin
    const rim = pow(float(1).sub(abs(normalView.z)), float(3.5));
    mat.colorNode = vec3(0.45, 0.62, 1.0).mul(rim.mul(0.12).add(0.003)).mul(this.shellGain);
    mat.mrtNode = mrt({ bloom: float(0) });
    const mesh = new THREE.Mesh(g, mat);
    const n = new THREE.Vector3(...this.noseDir());
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), n);
    mesh.renderOrder = 0;
    mesh.frustumCulled = false;
    return mesh;
  }

  /** Trans-Neptunian objects from the snapshot; the belt stays empty without it. */
  setTno(t: Tno) {
    this.tno = t;
    this.tnoPos = new Float64Array(t.count * 3);
    this.tnoJd = NaN;
    const c = new THREE.Color();
    for (let k = 0; k < t.count; k++) {
      const a = t.el[8 * k], e = t.el[8 * k + 1];
      // classical belt pale, scattered and detached objects warmer
      c.set(a > 50 || e > 0.25 ? '#e6c3a3' : '#cfd9e6');
      // intrinsically brighter (bigger) objects drawn a little larger
      this.belt.setColor(k, c, 1.8 + Math.max(0, 7 - t.H[k]) * 0.35, 0.5);
    }
    for (const n of t.named) {
      const k = n.index;
      if (!DWARFS.includes(n.name)) continue;
      this.belt.setColor(k, new THREE.Color('#ffffff'), 4.2, 1.6);
      this.labels.push({ key: `tno${k}`, text: n.name === 'Leleakuhonua' ? 'Leleākūhonua' : n.name, at: [0, 0, 0], near: 10 * AU_KM, far: (n.name === 'Sedna' || n.name === 'Leleakuhonua' ? 20_000 : 600) * AU_KM, kind: 'body' });
    }
    this.belt.commit(0, new THREE.Vector3(), true);
    this.orbitsJd = NaN; // dwarf-planet orbits join the planets'
  }

  /** The Voyagers' paths since launch (Sun-centered ICRF, from the ephemeris snapshot). */
  setPaths(objects: EphObject[]) {
    this.pathPts = objects.filter((o) => o.path).map((o) => Float64Array.from(o.path!.data));
  }

  private rebuildOrbits(jd: number) {
    this.orbitsJd = jd;
    this.orbitPts = [];
    this.orbitCol = [];
    const add = (pts: Float64Array, hex: string, gain: number) => {
      this.orbitPts.push(pts);
      this.orbitCol.push(new THREE.Color(hex).multiplyScalar(gain));
    };
    for (const id of ['mercury', 'venus', 'earth', 'mars', ...VSOP_PLANETS.slice(2)] as const) {
      const days = ORBIT_DAYS[id];
      const pts = new Float64Array(ORBIT_N * 3);
      for (let k = 0; k < ORBIT_N; k++) {
        const t = jd + (days * k) / ORBIT_N;
        pts.set(id === 'earth' ? embHeliocentric(t) : heliocentric(id, t), 3 * k);
      }
      add(pts, ORBIT_HEX[id], 0.55);
    }
    if (this.tno) {
      for (const n of this.tno.named) {
        if (!DWARFS.includes(n.name)) continue;
        const o = 8 * n.index;
        const pts = new Float64Array(ORBIT_N * 3);
        const p: Vec3 = [0, 0, 0];
        // sample by eccentric anomaly so long, thin orbits (Sedna's) stay smooth at both ends
        const el = this.tno.el.slice(o, o + 8);
        for (let k = 0; k < ORBIT_N; k++) {
          const E = (2 * Math.PI * k) / ORBIT_N;
          el[5] = E - el[1] * Math.sin(E);
          el[6] = jd;
          eclipticOrbit(el, 0, jd, p);
          pts.set(p, 3 * k);
        }
        add(pts, '#c9b8a6', 0.3);
      }
    }
  }

  /**
   * Draw for this frame. `sun` is the Sun's position in scene coordinates, `cam`
   * the camera's; `P` turns ICRF to the scene's equator of date; `nearKm` is the
   * camera's distance from the nearest world (the orbits fade in well away from it).
   */
  update(sun: THREE.Vector3, cam: THREE.Vector3, jd: number, P: Mat3, nearKm: number, focusOort: boolean, show: { orbits: boolean }) {
    this.P = P;
    const rSun = cam.distanceTo(sun);
    const ls = (x: number, a: number, b: number) => THREE.MathUtils.smoothstep(Math.log(Math.max(x, 1)), Math.log(a), Math.log(b));
    const f = this.fades;
    f.orbits = show.orbits ? (focusOort ? 1 : ls(nearKm, 1.5e7, 2.5e8)) : 0;
    // seen from thousands of au the whole belt shrinks to a pixel, and 7,000 points added in one pixel glare
    f.belt = focusOort ? ls(rSun, 4 * AU_KM, 25 * AU_KM) * (1 - ls(rSun, 1_500 * AU_KM, 6_000 * AU_KM)) : 0.0;
    f.cloud = ls(rSun, 400 * AU_KM, 3_000 * AU_KM);
    // the boundaries are seen from outside: from within, their limb would wash over the whole sky
    f.shells = focusOort ? ls(rSun, 160 * AU_KM, 400 * AU_KM) * (1 - 0.6 * ls(rSun, 3_000 * AU_KM, 30_000 * AU_KM)) : 0;
    if (Math.abs(jd - this.orbitsJd) > 30) this.rebuildOrbits(jd);

    // orbits (planets and dwarf planets) and distance rings
    this.drawLines(this.orbits, this.orbitPts, this.orbitCol, sun, cam, f.orbits, true);
    const ringCols = this.ringPts.map((_, k) => {
      const au = 10 ** k * AU_KM;
      // each ring shows while it is a sensible size on screen
      const w = ls(rSun, au * 0.15, au * 0.5) * (1 - ls(rSun, au * 30, au * 120));
      return new THREE.Color(1, 1, 1).multiplyScalar(w * (focusOort ? 1 : 0));
    });
    this.drawLines(this.rings, this.ringPts, ringCols, sun, cam, 1, true);
    const pathCol = this.pathPts.map(() => VOYAGER);
    this.drawLines(this.paths, this.pathPts, pathCol, sun, cam, f.orbits, false);

    // the Kuiper belt, moved every few days of simulated time
    const belt = this.tno;
    if (belt && f.belt > 0.01) {
      if (!(Math.abs(jd - this.tnoJd) < 5)) {
        this.tnoJd = jd;
        const p: Vec3 = [0, 0, 0];
        for (let k = 0; k < belt.count; k++) {
          eclipticOrbit(belt.el, 8 * k, jd + 69.184 / 86400, p);
          this.tnoPos[3 * k] = p[0];
          this.tnoPos[3 * k + 1] = p[1];
          this.tnoPos[3 * k + 2] = p[2];
        }
        for (const l of this.labels) if (l.key.startsWith('tno')) l.at = [this.tnoPos[3 * +l.key.slice(3)], this.tnoPos[3 * +l.key.slice(3) + 1], this.tnoPos[3 * +l.key.slice(3) + 2]];
      }
      this.drawPoints(this.belt, this.tnoPos, belt.count, 1, sun, cam, f.belt);
    } else {
      this.belt.commit(0, cam, false);
    }

    // the model Oort cloud
    if (f.cloud > 0.01) {
      if (!(Math.abs(Math.log(rSun / AU_KM / this.cloudDimAt)) < 0.1)) this.dimCloud(rSun / AU_KM);
      this.drawPoints(this.cloud, this.cloudAu, this.cloudCount, AU_KM, sun, cam, f.cloud);
    }
    else this.cloud.commit(0, cam, false);

    // heliosphere boundaries: one group, scaled about the camera like a distant world
    this.shells.visible = f.shells > 0.01;
    this.shellGain.value = f.shells;
    if (this.shells.visible) {
      const d = new THREE.Vector3().subVectors(sun, cam);
      const extent = d.length() + 400 * AU_KM;
      const s = farScale(extent);
      this.shells.position.copy(cam).addScaledVector(d, s);
      this.shells.scale.setScalar(s);
      this.shells.quaternion.setFromRotationMatrix(new THREE.Matrix4().set(P[0], P[1], P[2], 0, P[3], P[4], P[5], 0, P[6], P[7], P[8], 0, 0, 0, 0, 1));
    }
  }

  /** Heliocentric ICRF -> scene (equatorial of date), relative to the camera, pulled in by far.ts. */
  private rel(x: number, y: number, z: number, sun: THREE.Vector3, cam: THREE.Vector3, out: Float32Array, o: number) {
    const P = this.P;
    const dx = sun.x + P[0] * x + P[1] * y + P[2] * z - cam.x;
    const dy = sun.y + P[3] * x + P[4] * y + P[5] * z - cam.y;
    const dz = sun.z + P[6] * x + P[7] * y + P[8] * z - cam.z;
    const s = farScale(Math.sqrt(dx * dx + dy * dy + dz * dz));
    out[o] = dx * s;
    out[o + 1] = dy * s;
    out[o + 2] = dz * s;
  }

  private drawLines(layer: SegmentLayer, lines: Float64Array[], colors: THREE.Color[], sun: THREE.Vector3, cam: THREE.Vector3, fade: number, closed: boolean) {
    if (fade <= 0.01 || !lines.length) {
      layer.object.visible = false;
      return;
    }
    layer.object.visible = true;
    const a = layer.array, c = layer.colorArray;
    let k = 0;
    lines.forEach((pts, li) => {
      const n = pts.length / 3;
      const col = colors[li];
      const segs = closed ? n : n - 1;
      for (let s = 0; s < segs && k < layer.capacity; s++) {
        const i = s, j = (s + 1) % n;
        this.rel(pts[3 * i], pts[3 * i + 1], pts[3 * i + 2], sun, cam, a, 6 * k);
        this.rel(pts[3 * j], pts[3 * j + 1], pts[3 * j + 2], sun, cam, a, 6 * k + 3);
        for (let e = 0; e < 6; e += 3) {
          c[6 * k + e] = col.r * fade;
          c[6 * k + e + 1] = col.g * fade;
          c[6 * k + e + 2] = col.b * fade;
        }
        k++;
      }
    });
    layer.commit(k, cam, true);
  }

  private drawPoints(layer: SpriteLayer, pts: ArrayLike<number>, n: number, unit: number, sun: THREE.Vector3, cam: THREE.Vector3, fade: number) {
    const o = layer.offsets.array as Float32Array;
    for (let k = 0; k < n; k++) this.rel(pts[3 * k] * unit, pts[3 * k + 1] * unit, pts[3 * k + 2] * unit, sun, cam, o, 3 * k);
    layer.gain.value = fade;
    layer.commit(n, cam, false);
  }

  /** Heliocentric ICRF -> scene, for labels (not pulled in). */
  toScene(at: Vec3, sun: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const P = this.P;
    return out.set(sun.x + P[0] * at[0] + P[1] * at[1] + P[2] * at[2], sun.y + P[3] * at[0] + P[4] * at[1] + P[5] * at[2], sun.z + P[6] * at[0] + P[7] * at[1] + P[8] * at[2]);
  }
}
