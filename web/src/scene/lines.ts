// Camera-relative line layers: the laser mesh (thin), the active route (thick)
// and the selected object's orbit.

import * as THREE from 'three/webgpu';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';

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
