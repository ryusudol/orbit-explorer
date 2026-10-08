import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// SharedArrayBuffer needs a cross-origin isolated page. The same two headers
// ship to production through public/_headers (Cloudflare Pages / Netlify).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  // PORT lets a launcher assign the port; otherwise Vite's default 5173.
  server: { headers: isolation, port: Number(process.env.PORT) || 5173, strictPort: !!process.env.PORT },
  preview: { headers: isolation },
  worker: { format: 'es' },
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 1500 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
