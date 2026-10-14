// Drawing things from 10 m to 10¹⁴ km away in one scene.
//
// The camera's far plane is 3 million km, and float32 depth and vertex positions
// would not survive much more. Pulling a point toward the camera along its line of
// sight doesn't change where it lands on screen, only its depth, so anything
// beyond FAR_D0 is drawn at a compressed distance C(d) = D0 (1 + ln(d / D0) / K).
// C is continuous and keeps increasing, so whatever was in front stays in front: a
// moon passing before a planet 50 million km away still covers it, and Neptune's
// orbit seen from the Oort cloud still passes behind the Sun. At 10¹⁴ km (the Oort
// cloud's far side from a camera 400,000 au out) C is 2.4 million km.
//
// Worlds scale by C(d)/d about the camera too, so their apparent size and lighting
// are unchanged. Up to 700,000 km nothing changes: Earth orbit, the Moon from the
// Earth and every orbiter of the Moon and Mars are drawn at their true distance.

import { WebGLCoordinateSystem } from 'three/webgpu';
import type * as THREE from 'three/webgpu';

export const FAR_D0 = 7e5;
const K = 8;
/** The sky (Milky Way, stars, Sun) is drawn beyond everything compressed. */
export const SKY_KM = 2.8e6;

/**
 * Take the far plane out of clipping. Depth comes from the logarithmic depth buffer
 * (the fragment's own distance), so clip-space z only decides what is clipped. With the
 * near plane at meters beside a spacecraft model, far/near reaches 2·10⁹ and the depth
 * row's −far/(far−near) rounds to exactly −1 in float32: everything beyond ~10⁷ near
 * distances, the sky included, lands on z/w = 1, and GPU rounding drops some triangles
 * and keeps others from frame to frame (patches of the Milky Way blinking out). Here
 * z = (1 − ε)(d − near): near clipping is unchanged and z/w never passes 1 − ε (ε = 10⁻⁵, ~170 float32 steps).
 * Line2's near estimate (−½·e14/e10) is unchanged too.
 */
export function openFarPlane(camera: THREE.PerspectiveCamera) {
  const update = camera.updateProjectionMatrix.bind(camera);
  camera.updateProjectionMatrix = () => {
    update();
    const e = camera.projectionMatrix.elements;
    const k = 1 - 1e-5;
    // WebGPU clips z to [0, w]; the WebGL 2 fallback to [−w, w]
    const webgl = camera.coordinateSystem === WebGLCoordinateSystem;
    e[10] = -k;
    e[14] = -k * camera.near * (webgl ? 2 : 1);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  };
  camera.updateProjectionMatrix();
}

/** Factor to multiply a camera-relative distance `d` by. */
export function farScale(d: number): number {
  return d <= FAR_D0 ? 1 : (FAR_D0 * (1 + Math.log(d / FAR_D0) / K)) / d;
}

/** The point (x, y, z) pulled toward `cam` so it can be drawn; written to out[o..o+2] in world coordinates. */
export function farPoint(x: number, y: number, z: number, cam: THREE.Vector3, out: Float64Array | number[], o = 0): number {
  const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
  const s = farScale(Math.sqrt(dx * dx + dy * dy + dz * dz));
  out[o] = cam.x + dx * s;
  out[o + 1] = cam.y + dy * s;
  out[o + 2] = cam.z + dz * s;
  return s;
}
