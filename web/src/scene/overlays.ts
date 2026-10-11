// Earth-fixed overlays: the coverage heat map and ground-station visibility cones.

import * as THREE from 'three/webgpu';
import { float, mix, positionGeometry, smoothstep, texture, uniform, uv, vec3, length } from 'three/tsl';
import { highp } from './precision';
import { capHalfAngle, geodeticToEcef } from '../sim/physics';
import { ellipsoidGeometry } from './earth';

/** Sequential blue ramp (dataviz reference steps 700 -> 200): on the dark globe, few = dark, many = light. */
const RAMP = ['#0d366b', '#184f95', '#2a78d6', '#5598e7', '#9ec5f4'];

export class CoverageOverlay {
  readonly mesh: THREE.Mesh;
  private tex: THREE.DataTexture;
  private data: Uint8Array;
  readonly nlat: number;
  readonly nlon: number;
  /** counts at or above this map to the top of the ramp */
  readonly scaleMax = uniform(30);

  constructor(nlat: number, nlon: number) {
    this.nlat = nlat;
    this.nlon = nlon;
    this.data = new Uint8Array(nlat * nlon);
    this.tex = new THREE.DataTexture(this.data, nlon, nlat, THREE.RedFormat, THREE.UnsignedByteType);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.wrapS = THREE.RepeatWrapping;
    this.tex.needsUpdate = true;

    const t = texture(this.tex, uv()).r; // count / 255 * ... (see update)
    const c = RAMP.map((h) => {
      const k = new THREE.Color(h);
      return vec3(k.r, k.g, k.b);
    });
    const seg = t.mul(RAMP.length - 1);
    let col = mix(c[0], c[1], smoothstep(float(0), float(1), seg));
    for (let k = 2; k < c.length; k++) col = mix(col, c[k], smoothstep(float(k - 1), float(k), seg));
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    mat.contextNode = highp(); // model-view in float64: the camera can be 10¹⁰ km from the origin
    mat.colorNode = col;
    // zero coverage stays fully transparent so gaps read as holes
    mat.opacityNode = smoothstep(0.0, 0.02, t).mul(t.mul(0.3).add(0.22));
    this.mesh = new THREE.Mesh(ellipsoidGeometry(90, 180, 6), mat);
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
  }

  /** counts: row-major, south -> north, lon from -180. */
  update(counts: Uint16Array, maxCount: number) {
    const k = 255 / Math.max(1, maxCount);
    for (let i = 0; i < counts.length; i++) this.data[i] = Math.min(255, Math.round(counts[i] * k));
    this.tex.needsUpdate = true;
  }
}

/** Translucent cone from a ground station to the ring of points at `shellKm`
 *  that sit exactly at the minimum elevation: every satellite inside it is usable. */
export function visibilityCone(latDeg: number, lonDeg: number, shellKm: number, minElevDeg: number, tint: THREE.Color): THREE.Group {
  const group = new THREE.Group();
  const lambda = capHalfAngle(shellKm, minElevDeg);
  const apex = new THREE.Vector3(...geodeticToEcef(latDeg, lonDeg, 0));
  const up = apex.clone().normalize();
  const east = new THREE.Vector3(0, 0, 1).cross(up).normalize();
  const north = up.clone().cross(east).normalize();
  const segs = 96;
  const r = 6371.0088 + shellKm;
  const ring: THREE.Vector3[] = [];
  for (let s = 0; s <= segs; s++) {
    const a = (2 * Math.PI * s) / segs;
    const dir = up.clone().multiplyScalar(Math.cos(lambda)).add(east.clone().multiplyScalar(Math.sin(lambda) * Math.cos(a))).add(north.clone().multiplyScalar(Math.sin(lambda) * Math.sin(a)));
    ring.push(dir.multiplyScalar(r));
  }

  const pos: number[] = [];
  const along: number[] = [];
  for (let s = 0; s < segs; s++) {
    pos.push(apex.x, apex.y, apex.z, ring[s].x, ring[s].y, ring[s].z, ring[s + 1].x, ring[s + 1].y, ring[s + 1].z);
    along.push(0, 1, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('along', new THREE.Float32BufferAttribute(along, 1));
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
  mat.contextNode = highp(); // model-view in float64: the camera can be 10¹⁰ km from the origin
  // brighter toward the rim so the footprint reads, faint at the apex
  const dist = length(positionGeometry.sub(vec3(apex.x, apex.y, apex.z)));
  const f = smoothstep(0.0, float(r * Math.sin(lambda) * 1.4), dist);
  mat.colorNode = vec3(tint.r, tint.g, tint.b);
  mat.opacityNode = f.mul(f).mul(0.12);
  group.add(new THREE.Mesh(g, mat));

  const rimGeo = new THREE.BufferGeometry().setFromPoints(ring);
  const rimMat = new THREE.LineBasicNodeMaterial({ color: tint, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
  rimMat.contextNode = highp(); // model-view in float64: the camera can be 10¹⁰ km from the origin
  group.add(new THREE.Line(rimGeo, rimMat));
  group.renderOrder = 1;
  return group;
}
