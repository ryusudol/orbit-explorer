// Test helpers: load the WASM engine and the committed snapshot under Node.
import { readFileSync } from 'node:fs';
import { initSync } from '../engine-pkg/orbit_explorer_engine.js';
import { decodeCatalog, type Catalog } from '../sim/catalog';

let loaded = false;

export function loadEngineSync() {
  if (!loaded) {
    initSync({ module: readFileSync(new URL('../engine-pkg/orbit_explorer_engine_bg.wasm', import.meta.url)) });
    loaded = true;
  }
}

export function loadSnapshot(): Catalog {
  const buf = readFileSync(new URL('../../public/data/catalog.bin', import.meta.url));
  return decodeCatalog(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

export function loadSnapshotMeta(): { objects: number; counts: Record<string, number> } {
  return JSON.parse(readFileSync(new URL('../../public/data/catalog.json', import.meta.url), 'utf8'));
}
