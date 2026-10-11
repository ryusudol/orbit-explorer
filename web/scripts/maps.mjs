// Map helpers shared by the texture scripts (planets.mjs, worlds.mjs).

/**
 * Slopes of an elevation grid (km, top-down rows from +90°, columns from 180°W),
 * as RGBA: east slope in RGB, north slope in alpha. Central differences, wrapping
 * in longitude; east spacing shrinks with cos(latitude).
 */
export function reliefRgba(h, width, height, radiusKm) {
  const out = Buffer.alloc(width * height * 4);
  const dLon = (2 * Math.PI) / width, dLat = Math.PI / height;
  const dy = radiusKm * dLat;
  for (let y = 0; y < height; y++) {
    const lat = Math.PI / 2 - (y + 0.5) * dLat;
    const dx = radiusKm * Math.max(Math.cos(lat), 0.01) * dLon;
    const yn = Math.max(0, y - 1), ys = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x++) {
      const xe = (x + 1) % width, xw = (x - 1 + width) % width;
      const sx = (h[y * width + xe] - h[y * width + xw]) / (2 * dx);
      const sy = (h[yn * width + x] - h[ys * width + x]) / ((ys - yn) * dy);
      // surface normal in (east, north, up) = (−∂h/∂x, −∂h/∂y, 1) normalised
      const k = 1 / Math.sqrt(sx * sx + sy * sy + 1);
      const e = Math.round(127.5 - 127.5 * sx * k), n = Math.round(127.5 - 127.5 * sy * k);
      const i = 4 * (y * width + x);
      out[i] = out[i + 1] = out[i + 2] = e;
      out[i + 3] = n;
    }
  }
  return out;
}

/**
 * Bilinear resample of a float grid in memory, pixel centres aligned, wrapping in
 * longitude. sharp can't take float samples as raw input: it reads the bytes as
 * 8-bit pixels and every height comes out 0, so Mars' relief was once flat.
 */
export function resampleFloat(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(Math.max(((y + 0.5) * sh) / dh - 0.5, 0), sh - 1);
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, sh - 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = ((x + 0.5) * sw) / dw - 0.5;
      const xf = Math.floor(fx), tx = fx - xf;
      const x0 = (xf + sw) % sw, x1 = (xf + 1 + sw) % sw;
      const top = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
      const bottom = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
      out[y * dw + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return out;
}

