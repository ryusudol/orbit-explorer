// The celestial sphere: NASA's Milky Way map, the Hipparcos stars and the Sun,
// all at infinity in the scene's TEME (equatorial) frame. Each is drawn around
// the camera, so only direction matters and parallax is zero, as it is for real
// at these distances (the Sun's parallax from 24,000 km is 0.01°).

import * as THREE from 'three/webgpu';
import { abs, atan, cos, exp, float, fwidth, length, max, min, pow, smoothstep, sqrt, texture, uniform, uv, vec3 } from 'three/tsl';
import { SpriteLayer } from './sprites';
import { ALL_TILES, GRID, PatchUv } from './tiles';

const DEG = Math.PI / 180;
/** Sky radius (km): inside the camera's far plane, far beyond everything else. */
const R_SKY = 1.2e6;
const R_STARS = 1.1e6;
const R_SUN = 1.0e6;
/** The Sun's mean angular radius, and how far its glow reaches. */
const SUN_RADIUS = 0.2666 * DEG;
const SUN_EXTENT = 8 * DEG;

/** Unit vector (TEME/equatorial) at map coordinates (u, v) of the SVS plate-carrée layout. */
function celestialDir(u: number, v: number, out = new THREE.Vector3()): THREE.Vector3 {
  const ra = Math.PI * (1 - 2 * u), dec = (v - 0.5) * Math.PI;
  return out.set(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec));
}

/**
 * Inside-facing patch of the celestial sphere over [u0, u1] x [v0, v1] of the
 * SVS plate-carrée layout (RA 0h at u = 0.5, RA increasing to the left, v = 0 at
 * the south celestial pole). Local UVs run 0..1 across the patch.
 */
function celestialPatch(radius: number, u0: number, u1: number, v0: number, v1: number, latSegs = 16, lonSegs = 32): THREE.BufferGeometry {
  const pos: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= latSegs; i++) {
    const vl = i / latSegs;
    for (let j = 0; j <= lonSegs; j++) {
      const ul = j / lonSegs;
      const d = celestialDir(u0 + (u1 - u0) * ul, v0 + (v1 - v0) * vl);
      pos.push(radius * d.x, radius * d.y, radius * d.z);
      uvs.push(ul, vl);
    }
  }
  const row = lonSegs + 1;
  for (let i = 0; i < latSegs; i++) {
    for (let j = 0; j < lonSegs; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, d, b, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

/** Approximate sRGB colour of a star from its B−V index (blackbody, after Charity's table). */
const BV_STOPS: [number, string][] = [
  [-0.33, '#9db4ff'],
  [-0.17, '#aabfff'],
  [0.0, '#cad7ff'],
  [0.3, '#f8f7ff'],
  [0.58, '#fff4ea'],
  [0.81, '#ffe2bd'],
  [1.4, '#ffcc8f'],
  [2.0, '#ffb978'],
];
function starColor(bv: number, out: THREE.Color): THREE.Color {
  const k = BV_STOPS.findIndex(([b]) => b >= bv);
  if (k <= 0) return out.set(BV_STOPS[k === 0 ? 0 : BV_STOPS.length - 1][1]);
  const [b0, c0] = BV_STOPS[k - 1], [b1, c1] = BV_STOPS[k];
  return out.set(c0).lerp(new THREE.Color(c1), (bv - b0) / (b1 - b0));
}

export interface StarCatalog {
  count: number;
  ra: Float32Array;
  dec: Float32Array;
  vmag: Float32Array;
  bv: Float32Array;
}

/** Decoder for public/data/stars.bin, written by scripts/sky.mjs. */
export function decodeStars(buffer: ArrayBuffer): StarCatalog {
  const dv = new DataView(buffer);
  if (new TextDecoder().decode(new Uint8Array(buffer, 0, 4)) !== 'STR2') throw new Error('not a star catalogue');
  const n = dv.getUint32(4, true);
  const ra = new Float32Array(n), dec = new Float32Array(n), vmag = new Float32Array(n), bv = new Float32Array(n);
  let o = 8;
  for (let i = 0; i < n; i++, o += 2) ra[i] = (dv.getUint16(o, true) / 65535) * 2 * Math.PI;
  for (let i = 0; i < n; i++, o += 2) dec[i] = (dv.getInt16(o, true) / 32767) * (Math.PI / 2);
  for (let i = 0; i < n; i++, o += 1) vmag[i] = dv.getUint8(o) / 18 - 2;
  for (let i = 0; i < n; i++, o += 1) bv[i] = dv.getInt8(o) / 50;
  return { count: n, ra, dec, vmag, bv };
}

/**
 * Star image model, in device pixels: every star is the same Gaussian PSF
 * (σ ≈ 0.7 px) whose energy follows flux, compressed (γ = 0.55) the way a
 * photograph's tone curve would. When the peak would clip, the star grows
 * instead, so bright stars read as bigger, not just whiter.
 */
const PSF = { sigma: 0.72, vRef: 6, gain: 1.35, gamma: 0.55, peak: 1.0, maxSigma: 3.2, cutoff: 0.014 };

/** PSF width (device px) and peak for a point of magnitude V; planets use it too. */
export function psf(vmag: number): { sigma: number; peak: number } {
  const e = PSF.gain * Math.pow(10, -0.4 * (vmag - PSF.vRef) * PSF.gamma);
  let sigma = PSF.sigma;
  let peak = e / (2 * Math.PI * sigma * sigma);
  if (peak > PSF.peak) {
    sigma = Math.min(PSF.maxSigma, Math.sqrt(e / (2 * Math.PI * PSF.peak)));
    peak = PSF.peak;
  }
  return { sigma, peak };
}

type Patch = { map: ReturnType<typeof texture>; uv: PatchUv };

export class Sky {
  /** overall brightness of the Milky Way map */
  readonly milkyWayGain = uniform(0.2);
  private patches: Patch[] = [];
  private milkyWay = new THREE.Group();
  private stars: SpriteLayer | null = null;
  private sun: THREE.Sprite;
  private hasMap = false;
  private show = true;
  readonly objects: THREE.Object3D[];

  constructor() {
    // placeholder until the survey image streams in
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    blank.needsUpdate = true;
    for (const [c, r] of ALL_TILES) {
      const puv = new PatchUv(c, r);
      const map = texture(blank, puv.node);
      this.patches.push({ map, uv: puv });
      const mat = new THREE.MeshBasicNodeMaterial({ depthWrite: false, depthTest: false, side: THREE.DoubleSide });
      // the map's sky floor is already black (scripts/sky.mjs); keep the core under the bloom threshold
      mat.colorNode = map.rgb.mul(this.milkyWayGain);
      const mesh = new THREE.Mesh(celestialPatch(R_SKY, c / GRID.cols, (c + 1) / GRID.cols, r / GRID.rows, (r + 1) / GRID.rows), mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = -2;
      this.milkyWay.add(mesh);
    }
    this.milkyWay.name = 'milky-way';
    this.milkyWay.visible = false;

    this.sun = this.makeSun();
    this.objects = [this.milkyWay, this.sun];
  }

  /**
   * The Sun at its true angular size (0.53°) with solar limb darkening, inside a
   * corona that falls off as r^-2.4 and a wide warm halo. The disc is HDR, so the
   * bloom pass turns it into glare. Depth-tested: it sets behind the Earth's limb.
   */
  private makeSun(): THREE.Sprite {
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending });
    const p = uv().sub(0.5).mul(2);
    const q = length(p);
    const r = q.mul(SUN_EXTENT / SUN_RADIUS); // in solar radii
    const aa = max(fwidth(r), 0.0001);
    const disc = float(1).sub(smoothstep(float(1).sub(aa), float(1).add(aa), r));
    const mu = sqrt(max(float(1).sub(r.mul(r)), 0));
    const limb = float(1).sub(float(0.62).mul(float(1).sub(mu))); // linear limb darkening, u ≈ 0.6 in the visible
    const rr = max(r, 1);
    const corona = pow(rr, float(-2.4)).mul(1.1);
    const halo = exp(r.mul(-0.16)).mul(0.07);
    // faint six-fold glare spikes, as a lens with a hexagonal aperture would show
    const ang = atan(p.y, p.x);
    const spikes = pow(abs(cos(ang.mul(3))), float(160)).mul(pow(rr, float(-1.3))).mul(0.16);
    const fade = smoothstep(1.0, 0.75, q);
    const color = vec3(1.0, 0.97, 0.92)
      .mul(disc.mul(limb).mul(36))
      .add(vec3(1.0, 0.86, 0.66).mul(corona.add(spikes).mul(float(1).sub(disc))))
      .add(vec3(1.0, 0.62, 0.32).mul(halo));
    mat.colorNode = min(color, vec3(60)).mul(fade);
    const s = new THREE.Sprite(mat);
    s.name = 'sun';
    s.renderOrder = 3;
    s.frustumCulled = false;
    const size = 2 * R_SUN * Math.tan(SUN_EXTENT);
    s.scale.set(size, size, 1);
    return s;
  }

  /** One full-sky texture (standard tier), on every patch without a tile of its own. */
  setMilkyWay(map: THREE.Texture) {
    for (const p of this.patches) {
      if (this.tiled.has(p)) continue;
      p.map.value = map;
      p.uv.useFullMap();
    }
    this.hasMap = true;
    this.milkyWay.visible = this.show;
  }
  private tiled = new Set<Patch>();

  /** One UHD tile for patch (c, r). */
  setMilkyWayTile(c: number, r: number, map: THREE.Texture) {
    const p = this.patches[r * GRID.cols + c];
    p.map.value = map;
    p.uv.useTile();
    this.tiled.add(p);
    this.hasMap = true;
    this.milkyWay.visible = this.show;
  }

  /** Unit vector (scene frame) to the middle of sky tile (c, r). */
  static tileCentre(c: number, r: number): THREE.Vector3 {
    return celestialDir((c + 0.5) / GRID.cols, (r + 0.5) / GRID.rows);
  }

  /** Builds the star layer for the renderer's pixel ratio; returns it for the scene. */
  setStars(cat: StarCatalog, pixelRatio: number, toDate = new THREE.Matrix3()): THREE.Object3D {
    const keep: number[] = [];
    const sigma = new Float32Array(cat.count), peak = new Float32Array(cat.count);
    for (let i = 0; i < cat.count; i++) {
      const { sigma: s, peak: pk } = psf(cat.vmag[i]);
      if (pk < PSF.cutoff) continue;
      sigma[i] = s;
      peak[i] = pk;
      keep.push(i);
    }
    const layer = new SpriteLayer(keep.length, 'star', { renderOrder: -1, depthTest: true });
    layer.object.name = 'stars';
    const o = layer.offsets.array as Float32Array;
    const col = new THREE.Color();
    const white = new THREE.Color(1, 1, 1);
    const v = new THREE.Vector3();
    keep.forEach((i, k) => {
      const cd = Math.cos(cat.dec[i]);
      v.set(cd * Math.cos(cat.ra[i]), cd * Math.sin(cat.ra[i]), Math.sin(cat.dec[i])).applyMatrix3(toDate).multiplyScalar(R_STARS);
      o[3 * k] = v.x;
      o[3 * k + 1] = v.y;
      o[3 * k + 2] = v.z;
      starColor(cat.bv[i], col).lerp(white, 0.2);
      // the quad spans ±3σ; sizes are in CSS px, so divide out the pixel ratio
      layer.setColor(k, col, (6 * sigma[i]) / pixelRatio, peak[i]);
    });
    layer.commit(keep.length, new THREE.Vector3());
    this.stars = layer;
    return layer.object;
  }

  setVisible(milkyWayAndSun: boolean) {
    this.show = milkyWayAndSun;
    this.milkyWay.visible = milkyWayAndSun && this.hasMap;
    this.sun.visible = milkyWayAndSun;
  }

  /** The survey map is J2000; turn it to the scene's equator of date (precession, ~0.36° in 2026). */
  setFrame(toDate: THREE.Matrix4) {
    this.milkyWay.quaternion.setFromRotationMatrix(toDate);
  }

  /**
   * Re-centre on the camera; `sunDir` is the unit vector to the Sun in the scene
   * frame, `sunAu` the Sun's distance (its disc shrinks to 0.35° from Mars).
   */
  update(cam: THREE.Vector3, sunDir: THREE.Vector3, sunAu = 1) {
    this.milkyWay.position.copy(cam);
    if (this.stars) this.stars.object.position.copy(cam);
    this.sun.position.copy(cam).addScaledVector(sunDir, R_SUN);
    const size = (2 * R_SUN * Math.tan(SUN_EXTENT)) / sunAu;
    this.sun.scale.set(size, size, 1);
  }
}
