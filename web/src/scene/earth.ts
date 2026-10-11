// WGS-84 Earth: an oblate spheroid in the Earth-fixed frame (X = 0 deg lon,
// Z = north), shaded by the real Sun direction with NASA day/night imagery.
//
// The globe is a 4x4 grid of patches (90° x 45°) so each can carry its own
// 4096x2048 texture tile: 16384x8192 in all, twice WebGPU's guaranteed limit for
// one texture. Lower tiers stretch one full-globe texture across every patch via
// a per-patch UV transform, so tiers swap (and tiles stream in) patch by patch.

import * as THREE from 'three/webgpu';
import { abs, cameraPosition, dot, float, max, mix, normalView, normalWorld, normalize, positionLocal, positionWorld, pow, smoothstep, texture, uniform, vec3 } from 'three/tsl';
import { highp } from './precision';
import { geodeticToEcef } from '../sim/physics';
import { ALL_TILES, GRID, PatchUv } from './tiles';

const DEG = Math.PI / 180;

/** Lat/lon grid on the ellipsoid over a lon/lat box, UVs 0..1 across it (u = lon, v = lat). */
export function ellipsoidGeometry(latSegs: number, lonSegs: number, heightKm = 0, lon0 = -180, lon1 = 180, lat0 = -90, lat1 = 90): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= latSegs; i++) {
    const lat = lat0 + ((lat1 - lat0) * i) / latSegs;
    for (let j = 0; j <= lonSegs; j++) {
      const lon = lon0 + ((lon1 - lon0) * j) / lonSegs;
      const p = geodeticToEcef(lat, lon, heightKm);
      pos.push(p[0], p[1], p[2]);
      const cl = Math.cos(lat * DEG);
      nrm.push(cl * Math.cos(lon * DEG), cl * Math.sin(lon * DEG), Math.sin(lat * DEG));
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
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

const sampler = (t: THREE.Texture, at: PatchUv['node']) => texture(t, at);
type Sampler = ReturnType<typeof sampler>;

/** One patch's material inputs. */
interface Patch {
  uv: PatchUv;
  day: Sampler;
  night: Sampler;
  /** ocean mask; always spans the whole globe */
  water: Sampler;
}

export class Earth {
  /** Earth-fixed frame; rotated about +Z by GMST into TEME every frame. */
  readonly group = new THREE.Group();
  readonly sunEcef = uniform(new THREE.Vector3(1, 0, 0));
  private patches: Patch[] = [];

  constructor(day: THREE.Texture, night: THREE.Texture) {
    this.group.name = 'earth-fixed';
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    blank.needsUpdate = true;

    const dLon = 360 / GRID.cols, dLat = 180 / GRID.rows;
    for (const [c, r] of ALL_TILES) {
      const puv = new PatchUv(c, r);
      const patch: Patch = { uv: puv, day: sampler(day, puv.node), night: sampler(night, puv.node), water: sampler(blank, puv.global) };
      this.patches.push(patch);
      const lon0 = -180 + c * dLon, lat0 = -90 + r * dLat;
      const mesh = new THREE.Mesh(ellipsoidGeometry(40, 80, 0, lon0, lon0 + dLon, lat0, lat0 + dLat), this.surfaceMaterial(patch));
      mesh.name = `earth-${c}-${r}`;
      this.group.add(mesh);
    }

    // atmosphere: back faces of a slightly larger shell, brightest at the limb,
    // fading outward, lit on the day side
    const atmoMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    atmoMat.contextNode = highp(); // model-view in float64: the camera can be 10¹⁰ km from the origin
    const limb = smoothstep(0.0, 0.3, normalView.z.negate());
    const lit = smoothstep(-0.35, 0.4, dot(normalize(positionLocal), this.sunEcef)).mul(0.85).add(0.15);
    atmoMat.colorNode = vec3(0.3, 0.58, 1.0).mul(pow(limb, float(1.6))).mul(lit).mul(0.9);
    const atmo = new THREE.Mesh(ellipsoidGeometry(64, 128, 110), atmoMat);
    atmo.name = 'atmosphere';
    atmo.renderOrder = 1;
    this.group.add(atmo);
  }

  private surfaceMaterial(half: Patch) {
    const n = normalize(positionLocal);
    const ndl = dot(n, this.sunEcef);
    const dayAmt = smoothstep(-0.06, 0.1, ndl);
    const dayRgb = half.day.rgb;
    const lambert = max(ndl, 0).mul(0.8).add(0.2);
    const dayColor = dayRgb.mul(lambert).mul(0.72);
    // city lights: sodium-vapour amber, gamma-lifted so dim suburbs still read
    const lights = pow(half.night.r, float(1.5)).mul(vec3(1.0, 0.62, 0.3)).mul(1.5);
    const nightColor = lights.add(dayRgb.mul(0.03));
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const fresnel = pow(float(1).sub(max(dot(normalWorld, viewDir), 0)), float(3.5));
    const rim = vec3(0.28, 0.55, 1.0).mul(fresnel).mul(dayAmt.mul(0.85).add(0.15)).mul(0.75);
    // a thin warm fringe where the atmosphere scatters sunset light
    const twilight = vec3(1.0, 0.45, 0.2).mul(smoothstep(0.06, 0.0, abs(ndl.sub(0.01)))).mul(0.012);
    // the Sun's reflection on open water: a glint inside a broad sheen.
    // Everything is in the Earth-fixed frame, so take the view direction there too.
    const viewLocal = normalize(this.cameraEcef.sub(positionLocal));
    const hdot = max(dot(n, normalize(viewLocal.add(this.sunEcef))), 0);
    const water = half.water.r;
    // a wind-roughened sea spreads the glint over ~15°; keep its peak well short of white
    const glint = vec3(0.95, 0.93, 0.88).mul(pow(hdot, float(90)).mul(0.16).add(pow(hdot, float(14)).mul(0.035))).mul(water).mul(dayAmt);

    const mat = new THREE.MeshBasicNodeMaterial();
    mat.contextNode = highp(); // model-view in float64: the camera can be 10¹⁰ km from the origin
    mat.colorNode = mix(nightColor, dayColor, dayAmt).add(rim).add(twilight).add(glint);
    return mat;
  }

  /** camera position in the Earth-fixed frame, for view-dependent shading */
  readonly cameraEcef = uniform(new THREE.Vector3(0, 0, 1e5));

  /** Full-globe textures (2k / 4k tiers), on every patch that has no tile of its own yet. */
  setTextures(day: THREE.Texture, night: THREE.Texture) {
    for (const p of this.patches) {
      if (this.tiled.has(p)) continue;
      p.day.value = day;
      p.night.value = night;
      p.uv.useFullMap();
    }
  }
  private tiled = new Set<Patch>();

  /** One UHD tile pair for patch (c, r). */
  setTile(c: number, r: number, day: THREE.Texture, night: THREE.Texture) {
    const p = this.patches[r * GRID.cols + c];
    p.day.value = day;
    p.night.value = night;
    p.uv.useTile();
    this.tiled.add(p);
  }

  /** Unit vector (Earth-fixed) to the middle of patch (c, r), for loading what faces the camera first. */
  static tileCentre(c: number, r: number): THREE.Vector3 {
    const lon = (-180 + (c + 0.5) * (360 / GRID.cols)) * DEG, lat = (-90 + (r + 0.5) * (180 / GRID.rows)) * DEG;
    return new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
  }

  setWater(mask: THREE.Texture) {
    for (const p of this.patches) p.water.value = mask;
  }

  setSun(ecefUnit: THREE.Vector3) {
    this.sunEcef.value.copy(ecefUnit);
  }

  setCamera(ecef: THREE.Vector3) {
    this.cameraEcef.value.copy(ecef);
  }
}
