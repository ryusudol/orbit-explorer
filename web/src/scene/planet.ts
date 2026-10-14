// The Moon, Mars, Mercury and Venus' surface: spheres in their own body-fixed frames (X = 0° longitude,
// Z = north pole), mapped with the same 4x4 tile grid as the Earth, lit by the
// real Sun over relief from their laser-altimeter elevation models.
//
// Neither has city lights or oceans. What sells them is the terminator, where
// low sunlight rakes across craters and canyons, so each patch carries a
// slope map (scripts/planets.mjs) next to its color map. Reflectance is
// Minnaert's law, I ∝ μ₀^k μ^(k−1): k = 0.5 for the Moon, whose dusty regolith
// makes the full Moon a flat disc with no darkening at the limb, and k ≈ 0.8
// for Mars, closer to a matte (Lambert) surface.

import * as THREE from 'three/webgpu';
import { cross, dot, float, max, mix, mrt, mx_noise_float, normalLocal, normalView, normalize, positionLocal, pow, smoothstep, sqrt, texture, uniform, vec3 } from 'three/tsl';
import { highp } from './precision';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { ALL_TILES, GRID, PatchUv } from './tiles';

const DEG = Math.PI / 180;

/** Sphere patch over a lon/lat box; UVs run 0..1 across it (u = lon, v = lat). */
function spherePatch(radius: number, latSegs: number, lonSegs: number, lon0: number, lon1: number, lat0: number, lat1: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= latSegs; i++) {
    const lat = (lat0 + ((lat1 - lat0) * i) / latSegs) * DEG;
    for (let j = 0; j <= lonSegs; j++) {
      const lon = (lon0 + ((lon1 - lon0) * j) / lonSegs) * DEG;
      pos.push(radius * Math.cos(lat) * Math.cos(lon), radius * Math.cos(lat) * Math.sin(lon), radius * Math.sin(lat));
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
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((v) => v / radius), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export interface PlanetLook {
  radiusKm: number;
  /** Minnaert exponent */
  minnaert: number;
  /** overall exposure of the albedo map */
  gain: number;
  /** slope exaggeration: relief maps are sampled at ~1 km, flatter than the eye expects */
  relief: number;
  /** thin-atmosphere limb haze (Mars), or none */
  haze?: { color: [number, number, number]; heightKm: number; strength: number };
}

const sampler = (t: THREE.Texture, at: PatchUv['node']) => texture(t, at);
type Sampler = ReturnType<typeof sampler>;
interface Patch {
  uv: PatchUv;
  color: Sampler;
  relief: Sampler;
}

export class Planet {
  /** body-fixed frame; the scene sets its orientation and position every frame */
  readonly group = new THREE.Group();
  /** unit vector to the Sun, body-fixed */
  readonly sun = uniform(new THREE.Vector3(1, 0, 0));
  /** faint fill on the night side (earthshine on the Moon) */
  readonly fill = uniform(0.0);
  private patches: Patch[] = [];
  private tiled = new Set<Patch>();
  private reliefTiled = new Set<Patch>();

  constructor(
    readonly name: string,
    private look: PlanetLook,
    color: THREE.Texture,
  ) {
    this.group.name = name;
    const flat = new THREE.DataTexture(new Uint8Array([128, 128, 128, 128]), 1, 1);
    flat.needsUpdate = true;
    const dLon = 360 / GRID.cols, dLat = 180 / GRID.rows;
    for (const [c, r] of ALL_TILES) {
      const puv = new PatchUv(c, r);
      const patch: Patch = { uv: puv, color: sampler(color, puv.node), relief: sampler(flat, puv.node) };
      this.patches.push(patch);
      const lon0 = -180 + c * dLon, lat0 = -90 + r * dLat;
      const mesh = new THREE.Mesh(spherePatch(look.radiusKm, 40, 80, lon0, lon0 + dLon, lat0, lat0 + dLat), this.material(patch));
      mesh.name = `${name}-${c}-${r}`;
      this.group.add(mesh);
    }
    if (look.haze) this.group.add(this.hazeShell(look.haze));
  }

  private material(p: Patch) {
    const { minnaert: k, relief } = this.look;
    const up = normalize(positionLocal);
    // local east and north on the sphere (east is undefined at the poles; any tangent will do there)
    const east = normalize(cross(vec3(0, 0, 1), up).add(vec3(1e-5, 0, 0)));
    const north = cross(up, east);
    // slopes: east in RGB, north in alpha, each stored as 0.5 + 0.5·n
    const sx = p.relief.r.mul(2).sub(1).mul(relief);
    const sy = p.relief.a.mul(2).sub(1).mul(relief);
    const sz = sqrt(max(float(1).sub(sx.mul(sx)).sub(sy.mul(sy)), 0.0));
    const n = normalize(east.mul(sx).add(north.mul(sy)).add(up.mul(sz)));
    const view = normalize(this.cameraLocal.sub(positionLocal));
    const mu0 = max(dot(n, this.sun), 0);
    const mu = max(dot(n, view), 0.05);
    // the geometric terminator: relief can't light ground the Sun is below
    const lit = smoothstep(-0.02, 0.02, dot(up, this.sun));
    const brdf = pow(mu0, float(k)).mul(pow(mu, float(k - 1))).mul(lit);
    const albedo = p.color.rgb;
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.contextNode = highp(); // model-view in float64: the camera can be 10¹⁰ km from the origin
    mat.colorNode = albedo.mul(brdf.mul(this.look.gain).add(this.fill));
    // bloom is tuned for points of light; a sunlit disc would wear a halo
    mat.mrtNode = mrt({ bloom: float(0.15) });
    return mat;
  }

  /** Mars: a thin dusty limb, a few tens of km thick, only on the day side. */
  private hazeShell(h: NonNullable<PlanetLook['haze']>) {
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    mat.contextNode = highp(); // model-view in float64: the camera can be 10¹⁰ km from the origin
    const limb = smoothstep(0.0, 0.35, normalView.z.negate());
    const lit = smoothstep(-0.25, 0.35, dot(normalize(positionLocal), this.sun));
    mat.colorNode = vec3(...h.color).mul(pow(limb, float(2.2))).mul(lit).mul(h.strength);
    const g = new THREE.SphereGeometry(this.look.radiusKm + h.heightKm, 96, 48);
    g.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = `${this.name}-haze`;
    mesh.renderOrder = 1;
    return mesh;
  }

  /** camera position in the body-fixed frame (for view-dependent shading) */
  readonly cameraLocal = uniform(new THREE.Vector3(0, 0, 1e5));

  /** Full-globe color (2k/4k tiers), on every patch without a tile of its own. */
  setColor(map: THREE.Texture) {
    for (const p of this.patches) {
      if (this.tiled.has(p)) continue;
      p.color.value = map;
      if (!this.reliefTiled.has(p)) p.uv.useFullMap();
    }
  }

  /** Full-globe relief, on every patch without its own relief tile. */
  setRelief(map: THREE.Texture) {
    for (const p of this.patches) if (!this.reliefTiled.has(p)) p.relief.value = map;
  }

  /**
   * One UHD tile pair for patch (c, r). Color and relief tiles share the patch's
   * layout, so a patch switches to tile UVs only once it has both.
   */
  setTile(c: number, r: number, color: THREE.Texture, relief: THREE.Texture) {
    const p = this.patches[r * GRID.cols + c];
    p.color.value = color;
    p.relief.value = relief;
    p.uv.useTile();
    this.tiled.add(p);
    this.reliefTiled.add(p);
  }

  /** Unit vector (body-fixed) to the middle of patch (c, r). */
  static tileCenter(c: number, r: number): THREE.Vector3 {
    const lon = (-180 + (c + 0.5) * (360 / GRID.cols)) * DEG, lat = (-90 + (r + 0.5) * (180 / GRID.rows)) * DEG;
    return new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
  }
}

/**
 * Small moons (Phobos and Deimos, and the giants' small ones): lumpy triaxial
 * bodies (IAU mean radii), tidally locked with their long axis toward the planet. No global map at this size is worth the download,
 * so the shape is made here: an ellipsoid dented by a few hundred bowl craters
 * with raised rims (Phobos gets Stickney, 9 km across), lit by the real Sun at
 * their true dark albedo (~0.07; lifted a little for the screen).
 */
export class SmallMoon {
  readonly object: THREE.Mesh;
  readonly sun = uniform(new THREE.Vector3(1, 0, 0));
  readonly radiusKm: number;

  constructor(name: string, radii: [number, number, number], seed: number, bigCrater?: { lat: number; lon: number; radiusKm: number }, tint: [number, number, number] = [1, 1, 1]) {
    this.radiusKm = Math.max(...radii);
    const g = mergeVertices(new THREE.IcosahedronGeometry(1, 64).deleteAttribute('normal').deleteAttribute('uv'));
    // deterministic craters: power-law sizes, many small, few large
    let state = Math.floor(seed * 1e6) || 1;
    const rand = () => ((state = (state * 16807) % 2147483647) - 1) / 2147483646;
    const craters: { c: THREE.Vector3; r: number; depth: number }[] = [];
    const mean = (radii[0] + radii[1] + radii[2]) / 3;
    for (let i = 0; i < 340; i++) {
      const z = rand() * 2 - 1, t = rand() * Math.PI * 2, q = Math.sqrt(1 - z * z);
      const r = 0.045 + 0.3 * Math.pow(rand(), 5); // angular radius, rad
      craters.push({ c: new THREE.Vector3(q * Math.cos(t), q * Math.sin(t), z), r, depth: r * 0.16 });
    }
    if (bigCrater) {
      const la = bigCrater.lat * DEG, lo = bigCrater.lon * DEG;
      const r = bigCrater.radiusKm / mean;
      craters.push({ c: new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)), r, depth: r * 0.28 });
    }
    // the potato: broad lumps, then smaller ones, each weaker
    const lumps = Array.from({ length: 10 }, (_, i) => {
      const f = i < 4 ? 2.2 : i < 7 ? 4.5 : 9;
      return { k: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize().multiplyScalar(f), ph: rand() * 6.28, a: (0.11 / f) * (0.6 + 0.8 * rand()) };
    });
    const pos = g.attributes.position as THREE.BufferAttribute;
    const d = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      d.fromBufferAttribute(pos, i).normalize();
      let h = 0;
      for (const l of lumps) h += l.a * Math.sin(d.dot(l.k) + l.ph);
      for (const cr of craters) {
        const x = Math.acos(Math.min(1, d.dot(cr.c))) / cr.r;
        if (x > 1.8) continue;
        // a bowl meeting its raised rim with no crease: (1 − x²)² inside, a Gaussian rim at x = 1
        if (x < 1) h -= cr.depth * (1 - x * x) ** 2;
        h += cr.depth * 0.28 * Math.exp(-(((x - 1) / 0.28) ** 2));
      }
      pos.setXYZ(i, d.x * radii[0] * (1 + h), d.y * radii[1] * (1 + h), d.z * radii[2] * (1 + h));
    }
    g.computeVertexNormals();
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.contextNode = highp(); // model-view in float64: the camera can be 10¹⁰ km from the origin
    const p = positionLocal.div(this.radiusKm).add(seed);
    const mottle = mx_noise_float(p.mul(4.3)).mul(0.5).add(mx_noise_float(p.mul(13.1)).mul(0.25));
    const n = normalize(normalLocal);
    const ndl = max(dot(n, this.sun), 0);
    const albedo = mix(vec3(0.15, 0.135, 0.12), vec3(0.21, 0.19, 0.165), mottle.mul(0.5).add(0.5)).mul(vec3(...tint));
    mat.colorNode = albedo.mul(pow(ndl, float(0.85)).mul(0.8).add(0.004));
    mat.mrtNode = mrt({ bloom: float(0.15) });
    this.object = new THREE.Mesh(g, mat);
    this.object.name = name;
  }
}
