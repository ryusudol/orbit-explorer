// UI state. Simulation state lives in typed arrays owned by the scene; the
// scene pushes small summaries here at ~5 Hz and reads user intent back.

import { create } from 'zustand';
import type { BodyId } from '../sim/bodies';
import type { RelayPlan } from '../sim/relay';
import type { ConjunctionEvent } from '../workers/conjunction.worker';

export type { BodyId };

/** The analysis panel on show; 'explore' is the bare globe. 'fleet' and 'relay' are the Moon's and Mars'. */
export type Tab = 'explore' | 'route' | 'conj' | 'coverage' | 'catalog' | 'perf' | 'fleet' | 'relay';

export interface Layers {
  starlink: boolean;
  debris: boolean;
  otherSatellites: boolean;
  links: boolean;
  route: boolean;
  coverage: boolean;
  cones: boolean;
  /** view frame: true turns the camera with the Earth (ground fixed), false holds it to the stars */
  earthFixed: boolean;
  /** NASA Milky Way map and the Sun */
  sky: boolean;
  /** every orbiter's track around another world, not just the selected one, and the planets' orbits */
  orbits: boolean;
  /** the moons around another world: off to pick out the spacecraft among Jupiter's 115 */
  moons: boolean;
  /** Venus: the radar map of the surface instead of the cloud tops */
  radar: boolean;
}

export interface RouteInfo {
  totalKm: number;
  uplinkKm: number;
  downlinkKm: number;
  hops: number;
  latencyMs: number;
  fiberMs: number;
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

/** The selected spacecraft or moon around another world. */
export interface OrbiterInfo {
  id: number;
  name: string;
  kind: 'spacecraft' | 'moon';
  /** false outside its published trajectory */
  valid: boolean;
  latDeg: number;
  lonDeg: number;
  altKm: number;
  speedKms: number;
  sunlit: number;
  periodH: number;
  inclinationDeg: number;
  eccentricity: number;
  periapsisKm: number;
  apoapsisKm: number;
  /** false while a spacecraft is still arriving: its elements describe no real orbit */
  orbiting: boolean;
  /** distance from the center, km/s (negative closing) */
  radialKms: number;
  /** closest the track comes to the center from now on, km, at closestMs; closestAtEnd when still closing at the track's end */
  closestKm: number;
  closestMs: number;
  closestAtEnd: boolean;
  /** one-way light time to Earth, s */
  lightTimeS: number;
  /** published trajectory span, ms; for elements, [epoch, NaN] */
  spanMs: [number, number];
  /** sampled trajectory, or osculating elements moved by two-body motion */
  source: 'track' | 'elements';
  by: string;
  note: string;
  /** distance from the Earth, km */
  earthKm: number;
  /** distance from the Sun, au (the Oort cloud's orbiters) */
  sunAu: number;
}

/** One line of a world's orbiter list, refreshed with the scene's summaries. */
export interface FleetRow {
  id: number;
  name: string;
  kind: 'spacecraft' | 'moon';
  by: string;
  /** listed with a caption (sim/bodies.ts), not just from the snapshot */
  curated: boolean;
  valid: boolean;
  altKm: number;
  /** 0 while arriving (no orbit yet) */
  periodH: number;
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
  /** the world in focus: where the camera is, or is traveling to */
  body: BodyId;
  /** set while the camera flies between worlds */
  travel: { from: BodyId; to: BodyId } | null;
  /** Horizons id of the selected orbiter around another world */
  orbiter: number | null;
  orbiterInfo: OrbiterInfo | null;
  /** relay site per world */
  site: { moon: string; mars: string };
  relay: RelayPlan | null;
  fleet: FleetRow[];
  selected: number | null;
  selectedInfo: SelectedInfo | null;
  follow: boolean;
  /** `color` and `meta` describe an orbiter; otherwise `index` is a catalog object */
  hover: { index: number; name: string; x: number; y: number; color?: string; meta?: string } | null;

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
  setLayers: (p: Partial<Layers>) => void;
  select: (index: number | null) => void;
}

export const useStore = create<State>((set) => ({
  phase: 'loading',
  readyMs: 0,
  loadingStep: 'Loading catalog',
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
    otherSatellites: true,
    links: false,
    route: false,
    coverage: false,
    cones: false,
    earthFixed: true,
    sky: true,
    orbits: false,
    moons: true,
    radar: false,
  },
  tab: 'explore',
  body: 'earth',
  travel: null,
  orbiter: null,
  orbiterInfo: null,
  site: { moon: 'shackleton', mars: 'jezero' },
  relay: null,
  fleet: [],
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
  setLayers: (p) => set((s) => ({ layers: { ...s.layers, ...p } })),
  select: (index) => set({ selected: index, selectedInfo: null, follow: false }),
}));

// the routing panel shows its layers while it is open, whatever the layers menu said; closing it puts back the
// menu's settings from before it opened, except any the user changed while it was open
type RoutingLayer = 'starlink' | 'links' | 'route' | 'cones';
const ROUTING_LAYERS: RoutingLayer[] = ['starlink', 'links', 'route', 'cones'];
const routingOpen = (s: State) => s.tab === 'route' && s.body === 'earth';
let beforeRouting: Partial<Pick<Layers, RoutingLayer>> | null = null;
useStore.subscribe((s, prev) => {
  if (routingOpen(s) && !routingOpen(prev)) {
    const saved: typeof beforeRouting = {};
    for (const k of ROUTING_LAYERS) saved[k] = s.layers[k];
    // the snapshot is held back until they are on, so switching them on is not taken for the user’s own change
    beforeRouting = null;
    s.setLayers({ starlink: true, links: true, route: true, cones: true });
    beforeRouting = saved;
  } else if (routingOpen(s) && beforeRouting && s.layers !== prev.layers) {
    // the user's own choice while the panel is open outlives it
    for (const k of ROUTING_LAYERS) if (s.layers[k] !== prev.layers[k]) delete beforeRouting[k];
  } else if (!routingOpen(s) && routingOpen(prev) && beforeRouting) {
    const restore = beforeRouting;
    beforeRouting = null;
    s.setLayers(restore);
  }
});
