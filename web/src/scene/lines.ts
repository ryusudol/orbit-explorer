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

  constructor(capacity: number, color: THREE.Color, opacity: number) {
    const g = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(capacity * 6), 3);
    this.positions.setUsage(THREE.DynamicDrawUsage);
    this.colors = new THREE.BufferAttribute(new Float32Array(capacity * 6).fill(1), 3);
    this.colors.setUsage(THREE.DynamicDrawUsage);
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
   * points: `count` world positions sampled over one period, centred on now.
   * Segments with a NaN end (decayed or invalid samples) are skipped.
   */
  update(points: Float64Array, count: number, color: THREE.Color, cam: THREE.Vector3) {
    const b = this.buffer, c = this.colors;
    let k = 0;
    const n = Math.min(count - 1, this.capacity);
    for (let s = 0; s < n; s++) {
      const p = 3 * s;
      if (Number.isNaN(points[p]) || Number.isNaN(points[p + 3])) continue;
      for (let e = 0; e < 2; e++) {
        const q = p + 3 * e;
        b[6 * k + 3 * e] = points[q] - cam.x;
        b[6 * k + 3 * e + 1] = points[q + 1] - cam.y;
        b[6 * k + 3 * e + 2] = points[q + 2] - cam.z;
        // 0 one half-period behind, 1 at the object, ~0.55 one half-period ahead
        const t = (s + e) / (count - 1) - 0.5;
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
