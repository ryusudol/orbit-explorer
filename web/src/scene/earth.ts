// WGS-84 Earth: an oblate spheroid in the Earth-fixed frame (X = 0 deg lon,
// Z = north), shaded by the real Sun direction with NASA day/night imagery.

import * as THREE from 'three/webgpu';
import { abs, cameraPosition, dot, float, max, mix, normalView, normalWorld, normalize, positionLocal, positionWorld, pow, smoothstep, texture, uniform, uv, vec3 } from 'three/tsl';
import { geodeticToEcef } from '../sim/physics';

const DEG = Math.PI / 180;

/** Lat/lon grid on the ellipsoid, UVs matching equirectangular imagery (u = lon, v = lat). */
export function ellipsoidGeometry(latSegs: number, lonSegs: number, heightKm = 0): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= latSegs; i++) {
    const lat = -90 + (180 * i) / latSegs;
    for (let j = 0; j <= lonSegs; j++) {
      const lon = -180 + (360 * j) / lonSegs;
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

export class Earth {
  /** Earth-fixed frame; rotated about +Z by GMST into TEME every frame. */
  readonly group = new THREE.Group();
  readonly sunEcef = uniform(new THREE.Vector3(1, 0, 0));
  private dayNode;
  private nightNode;

  constructor(day: THREE.Texture, night: THREE.Texture) {
    this.group.name = 'earth-fixed';
    this.dayNode = texture(day, uv());
    this.nightNode = texture(night, uv());

    const n = normalize(positionLocal);
    const ndl = dot(n, this.sunEcef);
    const dayAmt = smoothstep(-0.06, 0.1, ndl);
    const dayRgb = this.dayNode.rgb;
    const lambert = max(ndl, 0).mul(0.8).add(0.2);
    const dayColor = dayRgb.mul(lambert).mul(0.72);
    // city lights: sodium-vapour amber, gamma-lifted so dim suburbs still read
    const lights = pow(this.nightNode.r, float(1.5)).mul(vec3(1.0, 0.62, 0.3)).mul(2.1);
    const nightColor = lights.add(dayRgb.mul(0.03));
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const fresnel = pow(float(1).sub(max(dot(normalWorld, viewDir), 0)), float(3.5));
    const rim = vec3(0.28, 0.55, 1.0).mul(fresnel).mul(dayAmt.mul(0.85).add(0.15)).mul(0.75);
    // a thin warm fringe where the atmosphere scatters sunset light
    const twilight = vec3(1.0, 0.45, 0.2).mul(smoothstep(0.06, 0.0, abs(ndl.sub(0.01)))).mul(0.012);

    const mat = new THREE.MeshBasicNodeMaterial();
    mat.colorNode = mix(nightColor, dayColor, dayAmt).add(rim).add(twilight);
    const mesh = new THREE.Mesh(ellipsoidGeometry(160, 320), mat);
    mesh.name = 'earth';
    this.group.add(mesh);

    // atmosphere: back faces of a slightly larger shell, brightest at the limb,
    // fading outward, lit on the day side
    const atmoMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const limb = smoothstep(0.0, 0.3, normalView.z.negate());
    const lit = smoothstep(-0.35, 0.4, dot(normalize(positionLocal), this.sunEcef)).mul(0.85).add(0.15);
    atmoMat.colorNode = vec3(0.3, 0.58, 1.0).mul(pow(limb, float(1.6))).mul(lit).mul(0.9);
    const atmo = new THREE.Mesh(ellipsoidGeometry(64, 128, 110), atmoMat);
    atmo.name = 'atmosphere';
    atmo.renderOrder = 1;
    this.group.add(atmo);
  }

  setTextures(day: THREE.Texture, night: THREE.Texture) {
    this.dayNode.value = day;
    this.nightNode.value = night;
  }

  setSun(ecefUnit: THREE.Vector3) {
    this.sunEcef.value.copy(ecefUnit);
  }
}
