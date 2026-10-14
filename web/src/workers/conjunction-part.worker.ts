/// <reference lib="webworker" />
// One part of a conjunction screen: a contiguous share of the window's time
// samples (see `Screener.begin_part`). Run by conjunction.worker.ts, which
// starts several of these and merges what they find.

import { loadEngine, Screener } from '../engine';

export interface PartScreenRequest {
  type: 'screen';
  id: number;
  jd0: number;
  hours: number;
  stepS: number;
  thresholdKm: number;
  part: number;
  parts: number;
}

export interface PartProgress {
  type: 'progress';
  id: number;
  part: number;
  progress: number;
  /** every event so far, `[a, b, tca_jd, miss_km, rel_speed_kms]` each */
  flat: Float64Array;
  /** `[steps, candidate_pairs, refined, formation_pairs]` */
  stats: Float64Array;
}

const scope = self as DedicatedWorkerGlobalScope;
let screener: Screener | null = null;
let current = 0;

const yieldToEvents = () => new Promise<void>((r) => setTimeout(r, 0));

async function screen(req: PartScreenRequest) {
  if (!screener) return;
  current = req.id;
  screener.begin_part(req.jd0, req.hours * 60, req.stepS, req.thresholdKm, req.part, req.parts);
  let progress = 0;
  let lastPost = 0;
  while (progress < 1) {
    progress = screener.advance(4);
    const now = performance.now();
    if (now - lastPost > 250 || progress >= 1) {
      lastPost = now;
      const flat = screener.events();
      const msg: PartProgress = { type: 'progress', id: req.id, part: req.part, progress, flat, stats: screener.stats() };
      scope.postMessage(msg, [flat.buffer]);
    }
    await yieldToEvents();
    if (current !== req.id) return; // superseded or canceled
  }
}

function bench(jd: number) {
  if (!screener) return;
  const radius = 10;
  const t0 = performance.now();
  const active = screener.propagate_all(jd);
  const t1 = performance.now();
  const grid = screener.grid_pairs(radius);
  const t2 = performance.now();
  const brute = screener.brute_pairs(radius);
  const t3 = performance.now();
  scope.postMessage({
    type: 'bench',
    objects: active,
    radiusKm: radius,
    propagateMs: t1 - t0,
    gridMs: t2 - t1,
    bruteMs: t3 - t2,
    gridPairs: grid,
    brutePairs: brute,
    pairsChecked: (active * (active - 1)) / 2,
  });
}

scope.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'init') {
    await loadEngine();
    screener = new Screener(msg.packed);
    scope.postMessage({ type: 'ready' });
  } else if (msg.type === 'screen') {
    await screen(msg as PartScreenRequest);
  } else if (msg.type === 'cancel') {
    current = -1;
  } else if (msg.type === 'bench') {
    current = -1; // cancel any running screen
    bench(msg.jd);
  }
};
