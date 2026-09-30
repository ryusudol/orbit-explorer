/// <reference lib="webworker" />
// Laser-link graph, shortest-latency routing and coverage for the Starlink
// fleet. Propagates its own subset at the exact requested time (it does not
// share keyframes), so routes are computed at full SGP4 fidelity.

import { loadEngine, Network } from '../engine';

export interface AnalysisRequest {
  type: 'update';
  jd: number;
  src: { lat: number; lon: number };
  dst: { lat: number; lon: number };
  minElevDeg: number;
  coverage: { nlat: number; nlon: number } | null;
}

export interface AnalysisResult {
  type: 'result';
  jd: number;
  /** pairs of catalogue indices */
  edges: Uint32Array;
  route: { totalKm: number; uplinkKm: number; downlinkKm: number; path: Uint32Array } | null;
  coverage: Uint16Array | null;
  shells: { inclinationDeg: number; altitudeKm: number; satellites: number; planes: number }[];
  linked: number;
  timings: { propagateBuildMs: number; routeMs: number; coverageMs: number };
}

const scope = self as DedicatedWorkerGlobalScope;
let net: Network | null = null;
let memory: WebAssembly.Memory;
let indices: Uint32Array;

scope.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'init') {
    memory = await loadEngine();
    indices = msg.indices;
    net = new Network(msg.packed);
    scope.postMessage({ type: 'ready', count: indices.length });
    return;
  }
  if (msg.type !== 'update' || !net) return;
  const req = msg as AnalysisRequest;

  const t0 = performance.now();
  net.update(req.jd);
  const t1 = performance.now();

  const local = new Uint32Array(memory.buffer, net.edges_ptr(), net.edges_len());
  const edges = new Uint32Array(local.length);
  for (let k = 0; k < local.length; k++) edges[k] = indices[local[k]];

  const r = net.route(req.src.lat, req.src.lon, req.dst.lat, req.dst.lon, req.minElevDeg);
  let route: AnalysisResult['route'] = null;
  if (r.length) {
    const hops = r[3];
    const path = new Uint32Array(hops);
    for (let k = 0; k < hops; k++) path[k] = indices[r[4 + k]];
    route = { totalKm: r[0], uplinkKm: r[1], downlinkKm: r[2], path };
  }
  const t2 = performance.now();

  let coverage: Uint16Array | null = null;
  if (req.coverage) {
    const { nlat, nlon } = req.coverage;
    const ptr = net.compute_coverage(nlat, nlon, req.minElevDeg);
    coverage = new Uint16Array(memory.buffer, ptr, nlat * nlon).slice();
  }
  const t3 = performance.now();

  const s = net.shells();
  const shells = [];
  for (let k = 0; k < s.length; k += 4) shells.push({ inclinationDeg: s[k], altitudeKm: s[k + 1], satellites: s[k + 2], planes: s[k + 3] });

  const result: AnalysisResult = {
    type: 'result',
    jd: req.jd,
    edges,
    route,
    coverage,
    shells,
    linked: net.linked_count(),
    timings: { propagateBuildMs: t1 - t0, routeMs: t2 - t1, coverageMs: t3 - t2 },
  };
  const transfer: Transferable[] = [edges.buffer];
  if (route) transfer.push(route.path.buffer);
  if (coverage) transfer.push(coverage.buffer);
  scope.postMessage(result, transfer);
};
