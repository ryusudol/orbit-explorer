/// <reference lib="webworker" />
// Conjunction screening over the whole catalog. The window's time samples
// are independent, so the screen is split across several part workers
// (conjunction-part.worker.ts), each screening a contiguous share of them.
// This worker merges their events by pair, keeping the smallest miss, which
// is exactly what one screen over the whole window finds. Progress streams to
// the UI and a new request cancels the current one.

import type { PartProgress, PartScreenRequest } from './conjunction-part.worker';

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

/** Each part holds its own copy of the catalog (~30 MB of SGP4 state at 32k objects). */
const PARTS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 2));

let parts: Worker[] = [];
let current = 0;
let t0 = 0;
let lastPost = 0;
let latest: (PartProgress | null)[] = [];

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

/** The parts' events merged by pair (smallest miss wins), closest first. */
function mergeEvents(flats: Float64Array[]): Float64Array {
  if (flats.length === 1) return flats[0];
  const best = new Map<number, number>(); // pair -> offset into its part's flat
  const from = new Map<number, Float64Array>();
  for (const flat of flats) {
    for (let k = 0; k < flat.length; k += 5) {
      const key = flat[k] * 0x1_0000_0000 + flat[k + 1];
      const prev = from.get(key);
      if (prev === undefined || flat[k + 3] < prev[best.get(key)! + 3]) {
        best.set(key, k);
        from.set(key, flat);
      }
    }
  }
  const rows: [Float64Array, number][] = [];
  for (const [key, k] of best) rows.push([from.get(key)!, k]);
  rows.sort((x, y) => x[0][x[1] + 3] - y[0][y[1] + 3]);
  const out = new Float64Array(rows.length * 5);
  rows.forEach(([flat, k], r) => out.set(flat.subarray(k, k + 5), r * 5));
  return out;
}

function publish(id: number) {
  const now = performance.now();
  const ready = latest.filter((p): p is PartProgress => p !== null);
  const progress = latest.reduce((sum, p) => sum + (p?.progress ?? 0), 0) / latest.length;
  if (progress < 1 && now - lastPost < 300) return;
  lastPost = now;
  const flat = mergeEvents(ready.map((p) => p.flat));
  // summed over the parts; a formation seen by several parts counts once per part
  const s = [0, 0, 0, 0];
  for (const p of ready) for (let k = 0; k < 4; k++) s[k] += p.stats[k];
  scope.postMessage({
    type: 'progress',
    id,
    progress,
    elapsedMs: now - t0,
    total: flat.length / 5,
    events: decodeEvents(flat, 250),
    bands: missBands(flat),
    stats: { steps: s[0], candidatePairs: s[1], refined: s[2], formationPairs: s[3] },
  });
}

function onPartMessage(msg: { type: string; [k: string]: unknown }) {
  if (msg.type === 'progress') {
    const p = msg as unknown as PartProgress;
    if (p.id !== current) return; // a superseded screen
    latest[p.part] = p;
    publish(p.id);
  } else if (msg.type === 'bench') {
    scope.postMessage(msg);
  }
}

function screen(req: ScreenRequest) {
  current = req.id;
  t0 = performance.now();
  lastPost = 0;
  latest = parts.map(() => null);
  parts.forEach((w, part) => {
    const msg: PartScreenRequest = { ...req, part, parts: parts.length };
    w.postMessage(msg);
  });
}

async function init(packed: Float64Array) {
  parts = Array.from({ length: PARTS }, (_, k) => new Worker(new URL('./conjunction-part.worker.ts', import.meta.url), { type: 'module', name: `conjunctions ${k + 1}/${PARTS}` }));
  await Promise.all(
    parts.map(
      (w, k) =>
        new Promise<void>((resolve) => {
          w.onmessage = (e) => {
            if (e.data.type === 'ready') {
              w.onmessage = (e) => onPartMessage(e.data);
              resolve();
            }
          };
          // the last part takes the original buffer, the others a copy
          const own = k === parts.length - 1 ? packed : packed.slice();
          w.postMessage({ type: 'init', packed: own }, [own.buffer]);
        }),
    ),
  );
  scope.postMessage({ type: 'ready' });
}

scope.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'init') {
    await init(msg.packed);
  } else if (msg.type === 'screen') {
    screen(msg as ScreenRequest);
  } else if (msg.type === 'bench') {
    // a benchmark cancels any running screen, on every part, so it runs alone
    current = -1;
    parts.forEach((w, k) => w.postMessage(k === 0 ? { type: 'bench', jd: msg.jd } : { type: 'cancel' }));
  }
};
