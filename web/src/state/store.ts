// UI state. Simulation state lives in typed arrays owned by the scene; the
// scene pushes small summaries here at ~5 Hz and reads user intent back.

import { create } from 'zustand';
import type { ConjunctionEvent } from '../workers/conjunction.worker';

/** The analysis panel on show; 'explore' is the bare globe. */
export type Tab = 'explore' | 'route' | 'conj' | 'coverage' | 'catalog' | 'perf';

export interface Layers {
  starlink: boolean;
  debris: boolean;
  payload: boolean;
  links: boolean;
  route: boolean;
  coverage: boolean;
  cones: boolean;
  /** view frame: true turns the camera with the Earth (ground fixed), false holds it to the stars */
  earthFixed: boolean;
  /** NASA Milky Way map and the Sun */
  sky: boolean;
}

export interface RouteInfo {
  totalKm: number;
  uplinkKm: number;
  downlinkKm: number;
  hops: number;
  latencyMs: number;
  fibreMs: number;
  greatCircleKm: number;
}

export interface LatencySample {
  t: number; // sim ms
  sat: number | null;
}

export interface Shell {
  inclinationDeg: number;
  altitudeKm: number;
  satellites: number;
  planes: number;
}

export interface SelectedInfo {
  index: number;
  name: string;
  norad: number;
  group: number;
  latDeg: number;
  lonDeg: number;
  altKm: number;
  speedKms: number;
  sunlit: number;
  periodMin: number;
  inclinationDeg: number;
  eccentricity: number;
  perigeeKm: number;
  apogeeKm: number;
  epochAgeH: number;
}

export interface ConjState {
  status: 'idle' | 'running' | 'done';
  progress: number;
  elapsedMs: number;
  total: number;
  events: ConjunctionEvent[];
  /** all encounters by miss distance: under 1 km, 1–2 km, 2 km and over */
  bands: [number, number, number];
  stats: { steps: number; candidatePairs: number; refined: number; formationPairs: number } | null;
  hours: number;
  thresholdKm: number;
  startJd: number;
  selected: number | null; // index into events
}

export interface Perf {
  fps: number;
  frameMs: number;
  interpMs: number;
  keyframeMs: number;
  keyframesPerSec: number;
  spacingS: number;
  workers: number;
  backend: string;
  visible: number;
}

export interface BenchResult {
  objects: number;
  radiusKm: number;
  propagateMs: number;
  gridMs: number;
  bruteMs: number;
  gridPairs: number;
  brutePairs: number;
  pairsChecked: number;
}

export interface CatalogMeta {
  generated: string;
  source: string;
  objects: number;
  counts: Record<string, number>;
}

interface State {
  phase: 'loading' | 'ready' | 'error';
  /** navigation start -> first interactive frame */
  readyMs: number;
  loadingStep: string;
  error: string | null;
  meta: CatalogMeta | null;
  groupCounts: [number, number, number];
  altitudeKm: Float32Array | null;
  groups: Uint8Array | null;

  timeMs: number;
  rate: number;
  paused: boolean;
  /** set by UI; consumed and cleared by the scene */
  jumpTo: number | null;

  layers: Layers;
  tab: Tab;
  selected: number | null;
  selectedInfo: SelectedInfo | null;
  follow: boolean;
  hover: { index: number; name: string; x: number; y: number } | null;

  src: string;
  dst: string;
  route: RouteInfo | null;
  latency: LatencySample[];
  network: { edges: number; linked: number; shells: Shell[]; buildMs: number; routeMs: number; coverageMs: number } | null;
  coverageByLat: Float32Array | null;
  coverageFraction: number;
  coverageStats: { min: number; mean: number; max: number } | null;

  conj: ConjState;
  perf: Perf;
  bench: BenchResult | null;
  benchRunning: boolean;

  set: (p: Partial<State>) => void;
  setLayer: (k: keyof Layers, v: boolean) => void;
  select: (index: number | null) => void;
}

export const useStore = create<State>((set) => ({
  phase: 'loading',
  readyMs: 0,
  loadingStep: 'Loading catalogue',
  error: null,
  meta: null,
  groupCounts: [0, 0, 0],
  altitudeKm: null,
  groups: null,

  timeMs: Date.now(),
  rate: 1,
  paused: false,
  jumpTo: null,

  layers: {
    starlink: true,
    debris: true,
    payload: true,
    links: true,
    route: true,
    coverage: false,
    cones: true,
    earthFixed: true,
    sky: true,
  },
  tab: 'route',
  selected: null,
  selectedInfo: null,
  follow: false,
  hover: null,

  src: 'lon',
  dst: 'nyc',
  route: null,
  latency: [],
  network: null,
  coverageByLat: null,
  coverageFraction: 0,
  coverageStats: null,

  conj: {
    status: 'idle',
    progress: 0,
    elapsedMs: 0,
    total: 0,
    events: [],
    bands: [0, 0, 0],
    stats: null,
    hours: 6,
    thresholdKm: 5,
    startJd: 0,
    selected: null,
  },
  perf: { fps: 0, frameMs: 0, interpMs: 0, keyframeMs: 0, keyframesPerSec: 0, spacingS: 0, workers: 0, backend: '', visible: 0 },
  bench: null,
  benchRunning: false,

  set: (p) => set(p),
  setLayer: (k, v) => set((s) => ({ layers: { ...s.layers, [k]: v } })),
  select: (index) => set({ selected: index, selectedInfo: null, follow: false }),
}));
