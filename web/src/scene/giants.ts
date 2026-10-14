// The giant planets, their rings, and the moons big enough to have a map.
//
// A giant is an oblate spheroid in its body-fixed frame (X = 0° longitude, Z =
// north), mapped with a Hubble OPAL global map (scripts/worlds.mjs), lit by the
// real Sun with Minnaert limb darkening. The maps' latitudes are converted to the
// sphere's parametric latitude when they are built, so the bands sit where they
// should on the flattened globe (Saturn is 10% wider than it is tall).
//
// Rings are a flat annulus in the equatorial plane, colored and made opaque from
// a radial profile built here from the rings' measured edges and typical optical
// depths (C ring ~0.1, B ring 1–5, Cassini Division ~0.1, A ring ~0.5; Uranus' and
// Neptune's narrow rings at their Voyager radii). The planet shades the rings, the
// rings shade the planet, and their unlit face glows only where they are thin, as
// sunlight leaks through: the C ring and Cassini Division, not the dense B ring.

import * as THREE from 'three/webgpu';
import { abs, dot, float, max, mix, mrt, normalize, positionLocal, pow, smoothstep, sqrt, texture, uniform, vec2, vec3, length, clamp, sign, select, normalView } from 'three/tsl';
import { highp } from './precision';

const DEG = Math.PI / 180;

/** Lat/lon sphere of radius 1, UVs: u east longitude from −180°, v from the south pole. */
function unitSphere(latSegs: number, lonSegs: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= latSegs; i++) {
    const lat = (-90 + (180 * i) / latSegs) * DEG;
    for (let j = 0; j <= lonSegs; j++) {
      const lon = (-180 + (360 * j) / lonSegs) * DEG;
      pos.push(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
      uvs.push(j / lonSegs, i / latSegs);
    }
  }
  const row = lonSegs + 1;
  for (let i = 0; i < latSegs; i++) {
    for (let j = 0; j < lonSegs; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------ ring profiles

export interface RingBand {
  /** inner and outer radius, km */
  r0: number;
  r1: number;
  /** normal optical depth */
  tau: number;
  /** linear RGB albedo */
  color: [number, number, number];
  /** amplitude of fine radial structure, 0..1 */
  ripple?: number;
}

export interface RingSystem {
  inner: number;
  outer: number;
  bands: RingBand[];
  /** overall brightness of the lit face */
  gain: number;
}

const tan: [number, number, number] = [0.78, 0.68, 0.52];
const greige: [number, number, number] = [0.55, 0.5, 0.44];
const gray: [number, number, number] = [0.42, 0.42, 0.42];

/** Saturn: edges from the Cassini mission (km from the center); gaps cut out of their rings. */
const SATURN_RINGS: RingSystem = {
  inner: 66_900,
  outer: 141_000,
  gain: 1.0,
  bands: [
    { r0: 66_900, r1: 74_510, tau: 0.002, color: gray }, // D
    { r0: 74_658, r1: 92_000, tau: 0.09, color: greige, ripple: 0.5 }, // C
    { r0: 77_770, r1: 77_920, tau: 0, color: gray }, // Colombo gap
    { r0: 87_350, r1: 87_620, tau: 0, color: gray }, // Maxwell gap
    { r0: 92_000, r1: 99_000, tau: 1.0, color: tan, ripple: 0.35 }, // inner B
    { r0: 99_000, r1: 117_580, tau: 2.6, color: tan, ripple: 0.25 }, // B
    { r0: 117_580, r1: 122_170, tau: 0.12, color: greige, ripple: 0.6 }, // Cassini Division
    { r0: 117_540, r1: 117_830, tau: 0, color: gray }, // Huygens gap
    { r0: 122_170, r1: 136_775, tau: 0.55, color: [0.7, 0.64, 0.54], ripple: 0.3 }, // A
    { r0: 133_420, r1: 133_745, tau: 0, color: gray }, // Encke gap
    { r0: 136_485, r1: 136_525, tau: 0, color: gray }, // Keeler gap
    { r0: 140_150, r1: 140_250, tau: 0.5, color: [0.75, 0.72, 0.66] }, // F
  ],
};

/** Uranus: nine narrow, coal-dark rings (albedo ~0.02); ε, the widest, is up to 96 km. */
const URANUS_RINGS: RingSystem = {
  inner: 41_000,
  outer: 52_000,
  gain: 0.6,
  bands: [
    [41_837, 2], [42_234, 2], [42_571, 2], [44_718, 7], [45_661, 7], [47_176, 2], [47_627, 2], [48_300, 6], [50_023, 2], [51_149, 58],
  ].map(([r, w]) => ({ r0: r - w / 2, r1: r + w / 2, tau: r === 51_149 ? 1.5 : 0.4, color: [0.35, 0.35, 0.36] as [number, number, number] })),
};

/** Neptune: the broad, faint Galle and Lassell rings and the narrow Le Verrier and Adams rings. */
const NEPTUNE_RINGS: RingSystem = {
  inner: 40_900,
  outer: 63_000,
  gain: 0.7,
  bands: [
    { r0: 40_900, r1: 42_900, tau: 0.0002, color: [0.4, 0.38, 0.36] }, // Galle
    { r0: 53_150, r1: 53_250, tau: 0.02, color: [0.45, 0.42, 0.4] }, // Le Verrier
    { r0: 53_250, r1: 57_200, tau: 0.0002, color: [0.4, 0.38, 0.36] }, // Lassell
    { r0: 62_900, r1: 62_960, tau: 0.08, color: [0.5, 0.46, 0.42] }, // Adams
  ],
};

/** Jupiter: the faint main ring and its halo, made of dust from the small inner moons. */
const JUPITER_RINGS: RingSystem = {
  inner: 92_000,
  outer: 226_000,
  gain: 0.9,
  bands: [
    { r0: 92_000, r1: 122_500, tau: 0.000003, color: [0.6, 0.45, 0.35] }, // halo
    { r0: 122_500, r1: 129_000, tau: 0.00002, color: [0.7, 0.52, 0.38] }, // main
    { r0: 129_000, r1: 182_000, tau: 0.0000005, color: [0.6, 0.45, 0.35] }, // Amalthea gossamer
    { r0: 182_000, r1: 226_000, tau: 0.0000002, color: [0.6, 0.45, 0.35] }, // Thebe gossamer
  ],
};

export const RINGS: Partial<Record<string, RingSystem>> = { saturn: SATURN_RINGS, uranus: URANUS_RINGS, neptune: NEPTUNE_RINGS, jupiter: JUPITER_RINGS };

/**
 * The radial profile as a 1-D texture: RGB albedo, alpha = the fraction of light
 * blocked looking straight through (1 − e^−τ). Faint dusty rings are lifted so
 * they can be seen at all; Saturn's are left as they are.
 */
function ringTexture(sys: RingSystem, width = 4096): THREE.DataTexture {
  const data = new Uint8Array(width * 4);
  let seed = 1234567;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  // fine radial structure: a few octaves of smoothed noise, fixed per ring system
  const ripples = new Float32Array(width);
  for (const oct of [3, 9, 27, 81]) {
    const n = Math.floor(width / oct);
    const knots = Array.from({ length: n + 2 }, () => rand() * 2 - 1);
    for (let x = 0; x < width; x++) {
      const f = x / oct, k = Math.floor(f), t = f - k, s = t * t * (3 - 2 * t);
      ripples[x] += (knots[k] * (1 - s) + knots[k + 1] * s) * (oct / 81) ** 0.35;
    }
  }
  for (let x = 0; x < width; x++) {
    const r = sys.inner + ((x + 0.5) / width) * (sys.outer - sys.inner);
    let tau = 0;
    let col: [number, number, number] = [0, 0, 0];
    let ripple = 0;
    for (const b of sys.bands) {
      if (r < b.r0 || r >= b.r1) continue;
      tau = b.tau; // later bands (gaps) override earlier ones
      col = b.color;
      ripple = b.ripple ?? 0;
    }
    tau *= Math.max(0, 1 + ripple * ripples[x] * 0.9);
    // faint dusty rings: lift tiny optical depths so they register
    const alpha = tau > 0 ? Math.max(1 - Math.exp(-tau), tau < 0.01 ? 0.02 + 4 * tau : 0) : 0;
    data[4 * x] = Math.round(Math.sqrt(col[0]) * 255);
    data[4 * x + 1] = Math.round(Math.sqrt(col[1]) * 255);
    data[4 * x + 2] = Math.round(Math.sqrt(col[2]) * 255);
    data[4 * x + 3] = Math.round(Math.min(1, alpha) * 255);
  }
  const t = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

// ------------------------------------------------------------------ giants

export interface GiantLook {
  radiusKm: number;
  polarKm: number;
  /** Minnaert exponent: ~0.9 for Jupiter and Saturn, lower (flatter) for the ice giants */
  minnaert: number;
  gain: number;
  /** thin limb haze tint, or none */
  limb?: [number, number, number];
}

export class GasGiant {
  readonly group = new THREE.Group();
  /** unit vector to the Sun, body-fixed */
  readonly sun = uniform(new THREE.Vector3(1, 0, 0));
  /** camera position, body-fixed (km) */
  readonly cameraLocal = uniform(new THREE.Vector3(0, 0, 1e6));
  private map;
  readonly rings: THREE.Mesh | null = null;
  readonly ringSystem: RingSystem | undefined;

  constructor(
    readonly name: string,
    private look: GiantLook,
    placeholder: THREE.Texture,
  ) {
    this.group.name = name;
    this.map = texture(placeholder);
    this.ringSystem = RINGS[name];
    const ringMap = this.ringSystem ? ringTexture(this.ringSystem) : null;
    const f = look.polarKm / look.radiusKm;
    const mesh = new THREE.Mesh(unitSphere(96, 192), this.globeMaterial(f, ringMap));
    mesh.scale.set(look.radiusKm, look.radiusKm, look.polarKm);
    mesh.name = `${name}-globe`;
    this.group.add(mesh);
    if (this.ringSystem && ringMap) {
      this.rings = this.ringMesh(this.ringSystem, ringMap, f);
      this.group.add(this.rings);
    }
  }

  setColor(map: THREE.Texture) {
    this.map.value = map;
  }

  private globeMaterial(f: number, ringMap: THREE.Texture | null) {
    const { radiusKm: a, minnaert: k } = this.look;
    const p = positionLocal; // unit sphere
    const P = vec3(p.x, p.y, p.z.mul(f)).mul(a); // on the spheroid, km
    const n = normalize(vec3(p.x, p.y, p.z.div(f)));
    const view = normalize(this.cameraLocal.sub(P));
    const mu0 = max(dot(n, this.sun), 0);
    const mu = max(dot(n, view), 0.04);
    const lit = smoothstep(-0.03, 0.06, dot(n, this.sun));
    let shade = pow(mu0, float(k)).mul(pow(mu, float(k - 1))).mul(lit);
    if (ringMap && this.ringSystem) {
      // the rings' shadow: follow the sunbeam back from this point to the ring plane
      const { inner, outer } = this.ringSystem;
      const s = this.sun;
      const t = P.z.negate().div(s.z.add(sign(s.z).mul(1e-6)));
      const q = vec2(P.x, P.y).add(vec2(s.x, s.y).mul(t));
      const u = length(q).sub(inner).div(outer - inner);
      const inside = select(t.greaterThan(0).and(u.greaterThan(0)).and(u.lessThan(1)), float(1), float(0));
      const block = texture(ringMap, vec2(clamp(u, 0, 1), 0.5)).a.mul(inside);
      shade = shade.mul(float(1).sub(block.mul(0.92)));
    }
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.contextNode = highp(); // model-view in float64: the camera can be 10¹⁰ km from the origin
    let color = this.map.rgb.mul(shade.mul(this.look.gain));
    if (this.look.limb) {
      // a thin bright haze at the lit limb, the upper atmosphere scattering sunlight
      const rim = pow(float(1).sub(mu), float(3)).mul(mu0.pow(0.5)).mul(0.35);
      color = color.add(vec3(...this.look.limb).mul(rim));
    }
    mat.colorNode = color;
    mat.mrtNode = mrt({ bloom: float(0.15) });
    return mat;
  }

  private ringMesh(sys: RingSystem, map: THREE.Texture, f: number): THREE.Mesh {
    const g = new THREE.RingGeometry(sys.inner, sys.outer, 512, 4);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    mat.contextNode = highp(); // model-view in float64: the camera can be 10¹⁰ km from the origin
    const p = positionLocal;
    const u = clamp(length(vec2(p.x, p.y)).sub(sys.inner).div(sys.outer - sys.inner), 0, 1);
    const prof = texture(map, vec2(u, 0.5));
    const albedo = prof.rgb.mul(prof.rgb); // stored as sqrt for 8-bit precision
    const alpha = prof.a;
    const s = this.sun;
    const view = normalize(this.cameraLocal.sub(p));
    // lit face when the Sun and the camera are on the same side of the ring plane
    const sameSide = s.z.mul(view.z).greaterThan(0);
    const elev = abs(s.z);
    // ring particles: brighter when the Sun is high; the unlit face only where light gets through
    const front = alpha.mul(pow(elev, float(0.25)).mul(0.9).add(0.1));
    const back = alpha.mul(float(1).sub(alpha)).mul(2.2).mul(pow(elev, float(0.2)));
    let bright = select(sameSide, front, back);
    // the planet's shadow: does the sunbeam to this point cross the spheroid?
    const a = this.look.radiusKm;
    const Q = vec3(p.x.div(a), p.y.div(a), 0);
    const S = vec3(s.x.div(a), s.y.div(a), s.z.div(a * f));
    const b = dot(Q, S), c = dot(Q, Q).sub(1), A = dot(S, S);
    const disc = b.mul(b).sub(A.mul(c));
    const hit = disc.greaterThan(0).and(b.negate().add(sqrt(max(disc, 0))).greaterThan(0)).and(b.lessThan(0));
    bright = bright.mul(select(hit, float(0.03), float(1)));
    mat.colorNode = albedo.mul(bright).mul(sys.gain).mul(1.6);
    mat.opacityNode = max(alpha, 0.0).mul(0.97);
    mat.mrtNode = mrt({ bloom: float(0.1) });
    // premultiplied-looking: the opacity darkens what's behind, the color adds the ring's own light
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = `${this.name}-rings`;
    mesh.renderOrder = 1;
    return mesh;
  }
}

// ------------------------------------------------------------------ moons with maps

export interface MoonLook {
  radii: [number, number, number];
  minnaert: number;
  gain: number;
  /** Titan: an opaque orange haze, the surface map barely showing through */
  haze?: { color: [number, number, number]; surface: number };
}

/**
 * A moon with a global map, tidally locked: body-fixed X (0° longitude) toward its
 * planet, Z along its orbit's pole, so the leading hemisphere is at 270°E as on
 * the maps. Lit by the real Sun; no relief maps (the moons are small on screen).
 */
export class MappedMoon {
  readonly object = new THREE.Group();
  readonly sun = uniform(new THREE.Vector3(1, 0, 0));
  readonly cameraLocal = uniform(new THREE.Vector3(0, 0, 1e5));
  private map;
  readonly radiusKm: number;
  loaded = false;

  constructor(
    readonly name: string,
    private look: MoonLook,
    placeholder: THREE.Texture,
  ) {
    this.radiusKm = Math.max(...look.radii);
    this.map = texture(placeholder);
    const mesh = new THREE.Mesh(unitSphere(64, 128), this.material());
    mesh.scale.set(...look.radii);
    this.object.add(mesh);
    this.object.name = name;
  }

  setColor(map: THREE.Texture) {
    this.map.value = map;
    this.loaded = true;
  }

  private material() {
    const { minnaert: k, haze } = this.look;
    const n = normalize(positionLocal);
    const r = this.look.radii;
    const view = normalize(this.cameraLocal.sub(positionLocal.mul(vec3(...r))));
    const mu0 = max(dot(n, this.sun), 0);
    const mu = max(dot(n, view), 0.05);
    const lit = smoothstep(-0.02, 0.04, dot(n, this.sun));
    const brdf = pow(mu0, float(k)).mul(pow(mu, float(k - 1))).mul(lit);
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.contextNode = highp(); // model-view in float64: the camera can be 10¹⁰ km from the origin
    if (haze) {
      const surf = mix(vec3(1, 1, 1), this.map.rgb.mul(1.6), haze.surface);
      const base = vec3(...haze.color).mul(surf);
      // Titan's haze is lit well past the terminator and glows at the limb
      const wrap = smoothstep(-0.25, 0.6, dot(n, this.sun));
      const limb = pow(float(1).sub(abs(normalView.z)), float(2.5)).mul(wrap).mul(0.6);
      // the disc darkens a little toward the limb before the haze ring brightens it
      const disc = mu.mul(0.3).add(0.7);
      mat.colorNode = base.mul(wrap.mul(disc).mul(this.look.gain)).add(vec3(0.5, 0.32, 0.14).mul(limb));
    } else {
      mat.colorNode = this.map.rgb.mul(brdf.mul(this.look.gain));
    }
    mat.mrtNode = mrt({ bloom: float(0.15) });
    return mat;
  }
}
