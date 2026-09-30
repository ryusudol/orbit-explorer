// Instanced screen-space sprites rendered relative to the camera.
//
// Float32 on the GPU has ~0.5 m resolution at 7,000 km, so world-space
// instance positions jitter when the camera is near a satellite. Instead the
// object sits at the camera position and each instance stores (p - camera),
// subtracted on the CPU in float64. Near the camera the offsets are small and
// exact; far away the error is sub-pixel anyway. modelViewMatrix is then just
// the camera rotation, which three.js composes in float64 on the CPU.

import * as THREE from 'three/webgpu';
import { float, instancedDynamicBufferAttribute, max, smoothstep, uv, vec3, vec4 } from 'three/tsl';

export type SpriteShape = 'glow' | 'ring';

export class SpriteLayer {
  readonly object: THREE.Sprite;
  readonly offsets: THREE.InstancedBufferAttribute;
  /** rgb (linear, may exceed 1 for bloom) + size in px */
  readonly colors: THREE.InstancedBufferAttribute;
  readonly capacity: number;

  constructor(capacity: number, shape: SpriteShape, opts: { additive?: boolean; depthTest?: boolean; renderOrder?: number } = {}) {
    this.capacity = capacity;
    this.offsets = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.offsets.setUsage(THREE.DynamicDrawUsage);
    this.colors = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.colors.setUsage(THREE.DynamicDrawUsage);

    const mat = new THREE.PointsNodeMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: opts.depthTest ?? true,
      blending: opts.additive === false ? THREE.NormalBlending : THREE.AdditiveBlending,
      sizeAttenuation: false,
    });
    // the attribute nodes are untyped in @types/three; they are vec3 / vec4 by construction
    const off = instancedDynamicBufferAttribute(this.offsets, 'vec3') as unknown as ReturnType<typeof vec3>;
    const col = instancedDynamicBufferAttribute(this.colors, 'vec4') as unknown as ReturnType<typeof vec4>;
    mat.positionNode = off;
    mat.sizeNode = col.w;
    mat.colorNode = col.xyz;
    const d = uv().sub(0.5).length().mul(2); // 0 at centre, 1 at the quad edge
    if (shape === 'glow') {
      const core = smoothstep(1.0, 0.0, d);
      mat.opacityNode = core.mul(core).mul(core.mul(0.6).add(0.4));
    } else {
      const ring = smoothstep(0.62, 0.74, d).mul(smoothstep(1.0, 0.86, d));
      mat.opacityNode = max(ring, float(0));
    }
    this.object = new THREE.Sprite(mat);
    this.object.count = 0;
    this.object.frustumCulled = false;
    this.object.renderOrder = opts.renderOrder ?? 2;
  }

  /** Commit `count` instances; call after writing offsets/colors. */
  commit(count: number, camera: THREE.Vector3, colorsChanged = true) {
    this.object.position.copy(camera);
    this.object.count = count;
    this.offsets.needsUpdate = true;
    if (colorsChanged) this.colors.needsUpdate = true;
  }

  /** Write instance `i` at world position (x, y, z) relative to `cam`. */
  setOffset(i: number, x: number, y: number, z: number, cam: THREE.Vector3) {
    const o = this.offsets.array as Float32Array;
    o[3 * i] = x - cam.x;
    o[3 * i + 1] = y - cam.y;
    o[3 * i + 2] = z - cam.z;
  }

  setColor(i: number, c: THREE.Color, size: number, gain = 1) {
    const a = this.colors.array as Float32Array;
    a[4 * i] = c.r * gain;
    a[4 * i + 1] = c.g * gain;
    a[4 * i + 2] = c.b * gain;
    a[4 * i + 3] = size;
  }
}
