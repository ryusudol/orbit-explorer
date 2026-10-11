// Camera-relative line layers: the laser mesh (thin), the active route (thick)
// and the selected object's orbit.

import * as THREE from 'three/webgpu';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { highp } from './precision';

/** Up to `capacity` independent segments, 1 px, additive. */
export class SegmentLayer {
  readonly object: THREE.LineSegments;
  private positions: THREE.BufferAttribute;
  private colors: THREE.BufferAttribute;

  constructor(
    readonly capacity: number,
    color: THREE.Color,
    opacity: number,
  ) {
    const g = new THREE.BufferGeometry();
    // uploaded when `commit` flags them, not DynamicDrawUsage (see sprites.ts)
    this.positions = new THREE.BufferAttribute(new Float32Array(capacity * 6), 3);
    this.colors = new THREE.BufferAttribute(new Float32Array(capacity * 6).fill(1), 3);
    g.setAttribute('position', this.positions);
    g.setAttribute('color', this.colors);
    g.setDrawRange(0, 0);
    const mat = new THREE.LineBasicNodeMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });
    mat.contextNode = highp(); // model-view in float64: the camera can be 10¹⁰ km from the origin
    this.object = new THREE.LineSegments(g, mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 1;
  }

  get array() {
    return this.positions.array as Float32Array;
  }

  get colorArray() {
    return this.colors.array as Float32Array;
  }

  commit(segments: number, cam: THREE.Vector3, colorsChanged = false) {
    this.object.position.copy(cam);
    this.object.geometry.setDrawRange(0, segments * 2);
    this.positions.needsUpdate = true;
    if (colorsChanged) this.colors.needsUpdate = true;
  }
}

/** Thick screen-space polyline for the highlighted route. */
export class ThickPath {
  readonly object: LineSegments2;
  private geometry: LineSegmentsGeometry;
  private capacity: number;
  private buffer: Float32Array;

  constructor(capacity: number, color: THREE.Color, widthPx: number) {
    this.capacity = capacity;
    this.buffer = new Float32Array(capacity * 6);
    this.geometry = new LineSegmentsGeometry();
    this.geometry.setPositions(this.buffer);
    const mat = new THREE.Line2NodeMaterial({ color, linewidth: widthPx, worldUnits: false, depthWrite: false });
    mat.contextNode = highp(); // model-view in float64: the camera can be 10¹⁰ km from the origin
    this.object = new LineSegments2(this.geometry, mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 3;
  }

  /** points: world positions (xyz...) of the polyline vertices */
  update(points: Float64Array, count: number, cam: THREE.Vector3) {
    const segs = Math.min(Math.max(count - 1, 0), this.capacity);
    const b = this.buffer;
    for (let s = 0; s < segs; s++) {
      for (let e = 0; e < 2; e++) {
        const p = 3 * (s + e);
        b[6 * s + 3 * e] = points[p] - cam.x;
        b[6 * s + 3 * e + 1] = points[p + 1] - cam.y;
        b[6 * s + 3 * e + 2] = points[p + 2] - cam.z;
      }
    }
    const start = this.geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute;
    start.data.needsUpdate = true;
    this.geometry.instanceCount = segs;
    this.object.position.copy(cam);
    this.object.visible = segs > 0;
  }
}

/**
 * Time of orbit sample `k` of `n`, as a fraction of the span: -0.5 to 0.5, now at
 * the centre (n odd). The spacing grows linearly away from now, so a chord sags by
 * a fixed share (~5e-5 rad in LEO at 361 samples) of its distance from the object:
 * as smooth from a camera beside the object as from afar. Even 1° steps sag
 * ~250 m, which right beside the track shows as kinks.
 */
export function orbitPhase(k: number, n: number): number {
  const u = (2 * k) / (n - 1) - 1;
  return 0.5 * u * Math.abs(u);
}

/** Orbit tracks are trimmed to the view widened this many times: their cut ends stay off screen. */
const GUARD = 2;

/**
 * A closed orbit as a thick additive polyline. Brightness doubles as opacity
 * (additive blending), so a per-vertex fade makes the track trail off behind
 * the object and lead brighter ahead of it.
 */
export class OrbitPath {
  readonly object: LineSegments2;
  private geometry: LineSegmentsGeometry;
  private buffer: Float32Array;
  private colors: Float32Array;
  private capacity: number;
  private clip = new THREE.Matrix4();
  private rot = new THREE.Matrix4();
  private f0 = [0, 0, 0, 0, 0];
  private f1 = [0, 0, 0, 0, 0];

  constructor(capacity: number, widthPx: number) {
    this.capacity = capacity;
    this.buffer = new Float32Array(capacity * 6);
    this.colors = new Float32Array(capacity * 6);
    this.geometry = new LineSegmentsGeometry();
    this.geometry.setPositions(this.buffer);
    this.geometry.setColors(this.colors);
    const mat = new THREE.Line2NodeMaterial({
      vertexColors: true,
      linewidth: widthPx,
      worldUnits: false,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    mat.contextNode = highp(); // drawn right through a followed object's model
    this.object = new LineSegments2(this.geometry, mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 2;
    this.object.visible = false;
  }

  /**
   * points: `count` world positions sampled over one period at `orbitPhase`,
   * centred on now. Segments with a NaN end (decayed or invalid samples) are skipped.
   * With `camera`, segments are trimmed to its view (see below).
   */
  update(points: Float64Array, count: number, color: THREE.Color, cam: THREE.Vector3, camera?: THREE.PerspectiveCamera) {
    const b = this.buffer, c = this.colors;
    let k = 0;
    const n = Math.min(count - 1, this.capacity);
    // Line2 builds each segment's quad in NDC, which comes apart for an end close to the camera
    // plane and far off screen: a track passing beside the camera (a chase view of a slow craft)
    // has an end metres in front and hundreds of screen widths aside, and now and then, zooming,
    // that segment fills the screen as a wedge for a frame. Cutting at the near plane alone
    // leaves that end. So segments are trimmed here to the view, widened GUARD times, and to
    // 1.5 near planes in front: clip x, y and w are linear along a segment (Liang–Barsky).
    const m = camera ? this.clip.multiplyMatrices(camera.projectionMatrix, this.rot.extractRotation(camera.matrixWorldInverse)).elements : null;
    const minW = camera ? 1.5 * camera.near : 0;
    const f0 = this.f0, f1 = this.f1;
    const bounds = (q: number, f: number[]) => {
      const x = points[q] - cam.x, y = points[q + 1] - cam.y, z = points[q + 2] - cam.z;
      const cx = m![0] * x + m![4] * y + m![8] * z;
      const cy = m![1] * x + m![5] * y + m![9] * z;
      const cw = m![3] * x + m![7] * y + m![11] * z;
      f[0] = cw - minW;
      f[1] = GUARD * cw - cx;
      f[2] = GUARD * cw + cx;
      f[3] = GUARD * cw - cy;
      f[4] = GUARD * cw + cy;
    };
    for (let s = 0; s < n; s++) {
      const p = 3 * s;
      if (Number.isNaN(points[p]) || Number.isNaN(points[p + 3])) continue;
      // where along the segment each drawn end sits: 0 at sample s, 1 at s + 1
      let a0 = 0, a1 = 1;
      if (m) {
        bounds(p, f0);
        bounds(p + 3, f1);
        for (let i = 0; i < 5 && a0 < a1; i++) {
          if (f0[i] < 0 && f1[i] < 0) a1 = 0;
          else if (f0[i] < 0) a0 = Math.max(a0, f0[i] / (f0[i] - f1[i]));
          else if (f1[i] < 0) a1 = Math.min(a1, f0[i] / (f0[i] - f1[i]));
        }
        if (a0 >= a1) continue;
      }
      for (let e = 0; e < 2; e++) {
        const a = e ? a1 : a0;
        for (let j = 0; j < 3; j++) b[6 * k + 3 * e + j] = points[p + j] + (points[p + 3 + j] - points[p + j]) * a - cam.getComponent(j);
        // 0 one half-period behind, 1 at the object, ~0.55 one half-period ahead
        const t = orbitPhase(s, count) + (orbitPhase(s + 1, count) - orbitPhase(s, count)) * a;
        const w = t < 0 ? 0.06 + 0.94 * (1 + t * 2) ** 2.2 : 1 - 0.45 * (t * 2) ** 0.8;
        c[6 * k + 3 * e] = color.r * w;
        c[6 * k + 3 * e + 1] = color.g * w;
        c[6 * k + 3 * e + 2] = color.b * w;
      }
      k++;
    }
    const start = this.geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute;
    start.data.needsUpdate = true;
    const colorStart = this.geometry.attributes.instanceColorStart as THREE.InterleavedBufferAttribute;
    colorStart.data.needsUpdate = true;
    this.geometry.instanceCount = k;
    this.object.position.copy(cam);
    this.object.visible = k > 0;
  }

  /** Hides the track (no selection). */
  hide() {
    this.object.visible = false;
  }
}
