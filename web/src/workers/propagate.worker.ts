/// <reference lib="webworker" />
// One slice of the catalog. Blocks on Atomics.wait for a keyframe request,
// runs SGP4 for its objects straight into the shared buffer, signals done.
// No messages are exchanged per keyframe.

import { loadEngine, Propagator } from '../engine';
import { CTRL, viewKeyframes } from '../sim/keyframes';

interface InitMsg {
  sab: SharedArrayBuffer;
  index: number;
  n: number;
  start: number;
  end: number;
  packed: Float64Array;
}

self.onmessage = async (e: MessageEvent<InitMsg>) => {
  const { sab, index, n, start, end, packed } = e.data;
  const memory = await loadEngine();
  const prop = new Propagator(packed);
  const kf = viewKeyframes(sab, n);
  const len = end - start;

  // read the sequence number before announcing readiness, so a request sent
  // the instant we report ready can't slip past the wait below
  let seen = Atomics.load(kf.ctrl, CTRL.REQ_SEQ);
  (self as DedicatedWorkerGlobalScope).postMessage({ type: 'ready' });

  for (;;) {
    Atomics.wait(kf.ctrl, CTRL.REQ_SEQ, seen);
    seen = Atomics.load(kf.ctrl, CTRL.REQ_SEQ);
    if (Atomics.load(kf.ctrl, CTRL.QUIT)) break;
    const slot = Atomics.load(kf.ctrl, CTRL.REQ_SLOT);
    const jd = kf.reqJd[0];

    const t0 = performance.now();
    prop.propagate(jd);
    // views are re-created each time: WASM memory may have grown
    const buf = memory.buffer;
    kf.pos.set(new Float64Array(buf, prop.pos_ptr(), 3 * len), slot * 3 * n + 3 * start);
    kf.vel.set(new Float64Array(buf, prop.vel_ptr(), 3 * len), slot * 3 * n + 3 * start);
    kf.illum.set(new Uint8Array(buf, prop.illum_ptr(), len), slot * n + start);
    kf.status.set(new Uint8Array(buf, prop.status_ptr(), len), slot * n + start);
    kf.reqJd[1 + index] = performance.now() - t0; // this worker's compute time
    Atomics.add(kf.ctrl, CTRL.DONE + slot, 1);
  }
  self.close();
};
