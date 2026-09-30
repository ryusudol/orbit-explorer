// Loads the Rust/WASM physics core once per realm (main thread or worker).
import init from './engine-pkg/orbit_explorer_engine.js';
import wasmUrl from './engine-pkg/orbit_explorer_engine_bg.wasm?url';

export { Network, Propagator, Screener, geodetic_to_teme, gmst, illumination, sun_position_teme, teme_to_geodetic } from './engine-pkg/orbit_explorer_engine.js';

let ready: Promise<WebAssembly.Memory> | null = null;

/** Resolves to the WASM linear memory, for zero-copy views over engine buffers. */
export function loadEngine(): Promise<WebAssembly.Memory> {
  ready ??= init({ module_or_path: wasmUrl }).then((out) => out.memory);
  return ready;
}
