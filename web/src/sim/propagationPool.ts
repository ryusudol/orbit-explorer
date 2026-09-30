// Schedules SGP4 keyframes across a pool of workers and interpolates between
// them every frame. Only one request is in flight at a time; the pool keeps a
// couple of keyframes ahead of the clock so interpolation never stalls.

import type { Catalog } from './catalog';
import { ELEMENT_STRIDE } from './catalog';
import { CTRL, SLOTS, createKeyframes, extrapolate, hermite, type KeyframeBuffers } from './keyframes';

interface Slot {
  jd: number;
  ready: boolean;
}

export interface PoolStats {
  workers: number;
  /** request -> harvested, including up to one frame of polling latency */
  keyframeMs: number;
  /** slowest worker's SGP4 + copy time for the last keyframe */
  computeMs: number;
  keyframesPerSec: number;
  /** sim-time spacing between keyframes */
  spacingS: number;
}

export class PropagationPool {
  readonly kf: KeyframeBuffers;
  readonly workers: Worker[] = [];
  readonly ready: Promise<void>;
  private slots: Slot[] = Array.from({ length: SLOTS }, () => ({ jd: 0, ready: false }));
  private pending: { slot: number; jd: number; gen: number; t0: number } | null = null;
  private gen = 0;
  private completedTimes: number[] = [];
  readonly stats: PoolStats;

  constructor(catalog: Catalog, workerCount: number) {
    const n = catalog.count;
    this.kf = createKeyframes(n);
    this.stats = { workers: workerCount, keyframeMs: 0, computeMs: 0, keyframesPerSec: 0, spacingS: 1 };
    const per = Math.ceil(n / workerCount);
    const readies: Promise<void>[] = [];
    for (let w = 0; w < workerCount; w++) {
      const start = Math.min(n, w * per);
      const end = Math.min(n, start + per);
      const worker = new Worker(new URL('../workers/propagate.worker.ts', import.meta.url), { type: 'module', name: `sgp4-${w}` });
      readies.push(
        new Promise((resolve, reject) => {
          worker.onmessage = (e) => e.data?.type === 'ready' && resolve();
          worker.onerror = (e) => reject(new Error(`propagation worker failed: ${e.message}`));
        }),
      );
      const packed = catalog.packed.slice(start * ELEMENT_STRIDE, end * ELEMENT_STRIDE);
      worker.postMessage({ sab: this.kf.sab, index: w, n, start, end, packed }, [packed.buffer]);
      this.workers.push(worker);
    }
    this.ready = Promise.all(readies).then(() => undefined);
  }

  /** Drop every keyframe (after a time jump). */
  invalidate() {
    this.gen++;
    for (const s of this.slots) s.ready = false;
  }

  /** Harvest finished work and issue the next request. Call once per frame. */
  update(jd: number, rate: number) {
    const W = this.workers.length;
    const { ctrl } = this.kf;
    if (this.pending && Atomics.load(ctrl, CTRL.DONE + this.pending.slot) >= W) {
      const p = this.pending;
      this.pending = null;
      if (p.gen === this.gen) {
        this.slots[p.slot] = { jd: p.jd, ready: true };
        const now = performance.now();
        this.stats.keyframeMs = now - p.t0;
        this.stats.computeMs = Math.max(...Array.from(this.kf.reqJd.subarray(1, 1 + W)));
        this.completedTimes.push(now);
        while (this.completedTimes.length && this.completedTimes[0] < now - 1000) this.completedTimes.shift();
        this.stats.keyframesPerSec = this.completedTimes.length;
      }
    }
    if (this.pending) return;

    const spacingS = Math.min(300, Math.max(1, Math.abs(rate) * 0.5));
    this.stats.spacingS = spacingS;
    const step = spacingS / 86400;
    const ready = this.slots.map((s, i) => ({ ...s, i })).filter((s) => s.ready);
    const behind = ready.filter((s) => s.jd <= jd);
    let need: number | null = null;
    if (behind.length === 0) {
      need = jd;
    } else {
      const latest = Math.max(...ready.map((s) => s.jd));
      if (latest < jd - 2 * step) need = jd; // computation fell behind the clock: resync
      else if (latest < jd + 2 * step) need = latest + step;
    }
    if (need === null) return;

    // overwrite a free slot, else the oldest one that is not the interval start
    const anchor = behind.length ? behind.reduce((a, b) => (a.jd > b.jd ? a : b)).i : -1;
    let slot = this.slots.findIndex((s) => !s.ready);
    if (slot < 0) {
      let oldest = Infinity;
      this.slots.forEach((s, i) => {
        if (i !== anchor && s.jd < oldest) {
          oldest = s.jd;
          slot = i;
        }
      });
    }
    this.issue(slot, need);
  }

  private issue(slot: number, jd: number) {
    const { ctrl, reqJd } = this.kf;
    this.slots[slot].ready = false;
    Atomics.store(ctrl, CTRL.DONE + slot, 0);
    reqJd[0] = jd;
    Atomics.store(ctrl, CTRL.REQ_SLOT, slot);
    Atomics.add(ctrl, CTRL.REQ_SEQ, 1);
    Atomics.notify(ctrl, CTRL.REQ_SEQ);
    this.pending = { slot, jd, gen: this.gen, t0: performance.now() };
  }

  /**
   * Positions at `jd` into `out` (3n, TEME km). Returns the slot whose eclipse
   * state is closest in time, or -1 if nothing is available yet.
   */
  interpolate(jd: number, out: Float64Array, valid: Uint8Array): number {
    let a = -1, b = -1;
    this.slots.forEach((s, i) => {
      if (!s.ready) return;
      if (s.jd <= jd && (a < 0 || s.jd > this.slots[a].jd)) a = i;
      if (s.jd > jd && (b < 0 || s.jd < this.slots[b].jd)) b = i;
    });
    if (a >= 0 && b >= 0) {
      const h = (this.slots[b].jd - this.slots[a].jd) * 86400;
      const s = ((jd - this.slots[a].jd) * 86400) / h;
      hermite(this.kf, a, b, s, h, out, valid);
      return s < 0.5 ? a : b;
    }
    const only = a >= 0 ? a : b;
    if (only < 0) return -1;
    extrapolate(this.kf, only, (jd - this.slots[only].jd) * 86400, out, valid);
    return only;
  }

  dispose() {
    Atomics.store(this.kf.ctrl, CTRL.QUIT, 1);
    Atomics.add(this.kf.ctrl, CTRL.REQ_SEQ, 1);
    Atomics.notify(this.kf.ctrl, CTRL.REQ_SEQ);
    for (const w of this.workers) setTimeout(() => w.terminate(), 100);
  }
}
