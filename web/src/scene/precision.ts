// Float32 model-view matrices lose ~0.5 m at 7,000 km: three.js multiplies the
// camera's view matrix by the object's world matrix on the GPU, and both carry
// a translation of that size. Anything drawn close to a followed object (its
// model, its ring, its orbit) composes the matrix on the CPU in float64 instead.

import { context, highpModelNormalViewMatrix, highpModelViewMatrix } from 'three/tsl';

export const highp = () => context({ modelViewMatrix: highpModelViewMatrix, modelNormalViewMatrix: highpModelNormalViewMatrix });
