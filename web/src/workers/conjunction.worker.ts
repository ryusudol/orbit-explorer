/// <reference lib="webworker" />
// Conjunction screening over the whole catalogue, run in chunks so progress
// streams to the UI and a new request can cancel the current one.

import { loadEngine, Screener } from '../engine';

export interface ScreenRequest {
  type: 'screen';
  id: number;
  jd0: number;
  hours: number;
  stepS: number;
  thresholdKm: number;
}

export interface ConjunctionEvent {
  a: number;
  b: number;
  tcaJd: number;
  missKm: number;
  relSpeedKms: number;
}

const scope = self as DedicatedWorkerGlobalScope;
let screener: Screener | null = null;
let current = 0;

const yieldToEvents = () => new Promise<void>((r) => setTimeout(r, 0));

/** Encounters under 1 km, 1–2 km and 2 km or more, across every event (not just the decoded ones). */
function missBands(flat: Float64Array): [number, number, number] {
  const bands: [number, number, number] = [0, 0, 0];
  for (let k = 3; k < flat.length; k += 5) bands[flat[k] < 1 ? 0 : flat[k] < 2 ? 1 : 2]++;
  return bands;
}

function decodeEvents(flat: Float64Array, limit: number): ConjunctionEvent[] {
  const out: ConjunctionEvent[] = [];
  for (let k = 0; k < flat.length && out.length < limit; k += 5) {
    out.push({ a: flat[k], b: flat[k + 1], tcaJd: flat[k + 2], missKm: flat[k + 3], relSpeedKms: flat[k + 4] });
  }
  return out;
}

async function screen(req: ScreenRequest) {
  if (!screener) return;
  current = req.id;
  const t0 = performance.now();
  screener.begin(req.jd0, req.hours * 60, req.stepS, req.thresholdKm);
  let progress = 0;
  let lastPost = 0;
  while (progress < 1) {
    progress = screener.advance(8);
    const now = performance.now();
    if (now - lastPost > 300 || progress >= 1) {
      lastPost = now;
      const flat = screener.events();
      const s = screener.stats();
      scope.postMessage({
        type: 'progress',
        id: req.id,
        progress,
        elapsedMs: now - t0,
        total: flat.length / 5,
        events: decodeEvents(flat, 250),
        bands: missBands(flat),
        stats: { steps: s[0], candidatePairs: s[1], refined: s[2], formationPairs: s[3] },
      });
    }
    await yieldToEvents();
    if (current !== req.id) return; // superseded
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
    await screen(msg as ScreenRequest);
  } else if (msg.type === 'bench') {
    current = -1; // cancel any running screen
    bench(msg.jd);
  }
};
