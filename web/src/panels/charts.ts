// D3 chart renderers. Each keeps its SVG between calls (stored on the root
// element) so live updates don't reset hover state.
//
// Mark specs follow the dataviz reference: 2 px lines, hairline recessive grid,
// area wash at 10%, 2 px surface gaps between touching fills, text in text
// tokens (never series colors), crosshair tooltips on lines, per-mark tooltips on bars.

import { axisBottom, axisLeft } from 'd3-axis';
import { bisector, max } from 'd3-array';
import { scaleLinear, scaleLog, scaleUtc } from 'd3-scale';
import { select, type Selection } from 'd3-selection';
import { area, line } from 'd3-shape';
import { utcFormat } from 'd3-time-format';
import { formatUtc } from '../sim/time';
import { GROUP_HEX as SERIES } from '../palette';
import type { LatencySample } from '../state/store';

export const INK = { text: '#f0f0fa', text2: 'rgba(240,240,250,0.68)', muted: 'rgba(240,240,250,0.44)', grid: 'rgba(240,240,250,0.07)', axis: 'rgba(240,240,250,0.22)', surface: '#000000' };
const SERIOUS = '#ff5a5a';
/**
 * Single-quantity lines are monochrome, told apart by stroke style rather than
 * hue: the measured series solid white, the reference series dotted gray. Hue
 * is kept for the object groups, where it encodes data shared with the globe.
 */
export const LINE = { primary: '#f0f0fa', reference: 'rgba(240,240,250,0.55)' };

type Svg = Selection<SVGSVGElement, unknown, null, undefined>;
type G = Selection<SVGGElement, unknown, null, undefined>;

interface Frame<D> {
  svg: Svg;
  /** unique per chart, for gradient ids */
  uid: string;
  g: Record<string, G>;
  tip: Selection<HTMLDivElement, unknown, null, undefined>;
  data: D;
  width: number;
  /** the hover readout's eased position, while the pointer is over the chart */
  glide?: Glide;
}

interface Glide {
  at: number[];
  to: number[];
  draw: (p: number[]) => void;
  raf: number;
  t: number;
}

let chartIds = 0;

const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

/**
 * Moves the hover readout (crosshair, dot, tooltip) toward `to` with an
 * exponential ease, so it slides from the previous sample to the hovered one
 * instead of snapping. `to` is [x, ...ys]; `draw` places everything at a point.
 * The first point after entering the chart snaps, as does reduced motion.
 */
function glide(f: Frame<unknown>, to: number[], draw: (p: number[]) => void) {
  const g = f.glide;
  if (!g || g.at.length !== to.length || reducedMotion?.matches) {
    if (g) cancelAnimationFrame(g.raf);
    f.glide = { at: to, to, draw, raf: 0, t: 0 };
    draw(to);
    return;
  }
  g.to = to;
  g.draw = draw;
  if (g.raf) return;
  g.t = 0;
  const step = (now: number) => {
    // a frame's timestamp can predate the call that scheduled it, so the first step assumes one 60 Hz frame
    const dt = g.t ? now - g.t : 1000 / 60;
    const k = 1 - Math.exp(-dt / 30); // ~30 ms time constant, as the globe's hover ring
    g.t = now;
    g.at = g.at.map((v, i) => v + (g.to[i] - v) * k);
    const done = g.at.every((v, i) => Math.abs(g.to[i] - v) < 0.25);
    if (done) g.at = g.to;
    g.draw(g.at);
    g.raf = done ? 0 : requestAnimationFrame(step);
  };
  g.raf = requestAnimationFrame(step);
}

/** Ends the hover: stops any glide so the next entry snaps. */
function unglide(f: Frame<unknown>) {
  if (f.glide) cancelAnimationFrame(f.glide.raf);
  f.glide = undefined;
}

/** A vertical fade from `color` to transparent, defined once per chart. */
function wash(f: Frame<unknown>, color: string, opacity: number): string {
  const id = `${f.uid}-wash`;
  if (f.svg.select(`#${id}`).empty()) {
    const lg = f.svg.insert('defs', ':first-child').append('linearGradient').attr('id', id).attr('x1', 0).attr('x2', 0).attr('y1', 0).attr('y2', 1);
    lg.append('stop').attr('offset', 0).attr('stop-color', color).attr('stop-opacity', opacity);
    lg.append('stop').attr('offset', 1).attr('stop-color', color).attr('stop-opacity', 0);
  }
  return `url(#${id})`;
}

/** Drop ticks that would sit closer than `minPx` to the previous kept one, so labels never collide. */
function spaced<T>(ticks: T[], px: (t: T) => number, minPx: number): T[] {
  const out: T[] = [];
  let last = -Infinity;
  for (const t of ticks) {
    const p = px(t);
    if (p - last >= minPx) {
      out.push(t);
      last = p;
    }
  }
  return out;
}

function frame<D>(root: HTMLDivElement, height: number, layers: string[], data: D, width: number): Frame<D> {
  const r = root as HTMLDivElement & { __frame?: Frame<D> };
  if (!r.__frame) {
    const svg = select(root).append('svg') as unknown as Svg;
    const g: Record<string, G> = {};
    for (const name of layers) g[name] = svg.append('g').attr('class', name) as unknown as G;
    const tip = select(root).append('div').attr('class', 'tooltip').style('display', 'none') as unknown as Frame<D>['tip'];
    r.__frame = { svg, uid: `c${++chartIds}`, g, tip, data, width };
  }
  const f = r.__frame;
  f.data = data;
  f.width = width;
  f.svg.attr('width', width).attr('height', height).attr('viewBox', `0 0 ${width} ${height}`);
  return f;
}

/** Fills the tooltip; its position is set separately by `place`, which glides. */
function tooltip(tip: Frame<unknown>['tip'], head: string, rows: { color?: string; key?: 'line' | 'rect'; value: string; label: string }[]) {
  tip.style('display', null);
  tip.selectAll('*').remove();
  tip.append('div').attr('class', 't-head').text(head);
  for (const r of rows) {
    const row = tip.append('div').attr('class', 't-row');
    if (r.color) row.append('i').attr('class', r.key === 'rect' ? 'key-rect' : 'key-line').style('background', r.color).style('display', 'inline-block');
    row.append('b').text(r.value);
    row.append('span').text(r.label);
  }
}

function place(tip: Frame<unknown>['tip'], x: number, y: number) {
  tip.style('left', `${x}px`).style('top', `${y}px`);
}

/** The crosshair: a vertical rule at x and a dot per series at ys. */
function crosshair(cross: G, x: number, ys: number[], colors: string[], y0: number, y1: number) {
  cross.selectAll('line').data([0]).join('line').attr('x1', x).attr('x2', x).attr('y1', y0).attr('y2', y1).attr('stroke', INK.axis);
  cross
    .selectAll('circle')
    .data(ys)
    .join('circle')
    .attr('cx', x)
    .attr('cy', (v) => v)
    .attr('r', 4)
    .attr('fill', (_, i) => colors[i])
    .attr('stroke', INK.surface)
    .attr('stroke-width', 2);
}

function gridY(g: G, y: (v: number) => number, ticks: number[], x0: number, x1: number) {
  g.selectAll('line')
    .data(ticks)
    .join('line')
    .attr('x1', x0)
    .attr('x2', x1)
    .attr('y1', (d) => Math.round(y(d)) + 0.5)
    .attr('y2', (d) => Math.round(y(d)) + 0.5)
    .attr('stroke', INK.grid)
    .attr('stroke-width', 1);
}

function styleAxis(g: G) {
  g.select('.domain').remove();
  g.selectAll('.tick line').remove();
  g.selectAll('text').attr('fill', INK.muted).style('font-variant-numeric', 'tabular-nums');
}

// -------------------------------------------------------------------------- latency

export interface LatencyData {
  samples: LatencySample[];
  fiberMs: number | null;
}

export function drawLatency(root: HTMLDivElement, data: LatencyData, width: number) {
  const H = 150;
  const M = { t: 10, r: 62, b: 22, l: 30 };
  const f = frame(root, H, ['grid', 'axes', 'fiber', 'area', 'sat', 'labels', 'cross', 'hit'], data, width);
  const pts = data.samples.filter((s) => s.sat !== null) as { t: number; sat: number }[];
  const t0 = data.samples.length ? data.samples[0].t : 0;
  const t1 = data.samples.length ? data.samples[data.samples.length - 1].t : 1;
  const x = scaleUtc().domain([new Date(t0), new Date(Math.max(t1, t0 + 1000))]).range([M.l, width - M.r]);
  const top = Math.max(data.fiberMs ?? 0, max(pts, (p) => p.sat) ?? 0, 10) * 1.18;
  const y = scaleLinear().domain([0, top]).nice().range([H - M.b, M.t]);

  gridY(f.g.grid, y, y.ticks(4), M.l, width - M.r);
  f.g.axes.selectAll('*').remove();
  const timeFmt = utcFormat(t1 - t0 < 300_000 ? '%H:%M:%S' : '%H:%M');
  const timeTicks = spaced(x.ticks(Math.max(2, Math.floor((width - M.l - M.r) / 90))), (d) => x(d), 72);
  const ax = f.g.axes
    .append('g')
    .attr('transform', `translate(0,${H - M.b})`)
    .call(axisBottom(x).tickValues(timeTicks).tickFormat((d) => timeFmt(d as Date))) as unknown as G;
  styleAxis(ax);
  const ay = f.g.axes.append('g').attr('transform', `translate(${M.l - 6},0)`).call(axisLeft(y).ticks(4)) as unknown as G;
  styleAxis(ay);

  const ln = line<{ t: number; sat: number }>()
    .x((d) => x(new Date(d.t)))
    .y((d) => y(d.sat));
  const ar = area<{ t: number; sat: number }>()
    .x((d) => x(new Date(d.t)))
    .y0(y(0))
    .y1((d) => y(d.sat));
  f.g.area
    .selectAll('path')
    .data([pts])
    .join('path')
    .attr('d', (d) => ar(d) ?? '')
    .attr('fill', wash(f as Frame<unknown>, LINE.primary, 0.1));
  f.g.sat
    .selectAll('path')
    .data([pts])
    .join('path')
    .attr('d', (d) => ln(d) ?? '')
    .attr('fill', 'none')
    .attr('stroke', LINE.primary)
    .attr('stroke-width', 2)
    .attr('stroke-linejoin', 'round')
    .attr('stroke-linecap', 'round');
  f.g.fiber
    .selectAll('line')
    .data(data.fiberMs !== null && data.samples.length ? [data.fiberMs] : [])
    .join('line')
    .attr('x1', M.l)
    .attr('x2', width - M.r)
    .attr('y1', (d) => y(d))
    .attr('y2', (d) => y(d))
    .attr('stroke', LINE.reference)
    .attr('stroke-width', 2)
    .attr('stroke-dasharray', '1 5')
    .attr('stroke-linecap', 'round');

  // direct labels at the right end, in text ink
  const last = pts[pts.length - 1];
  const labels: { y: number; text: string }[] = [];
  if (last) labels.push({ y: y(last.sat), text: `${last.sat.toFixed(1)} ms` });
  if (data.fiberMs !== null && data.samples.length) labels.push({ y: y(data.fiberMs), text: `${data.fiberMs.toFixed(1)} ms` });
  f.g.labels
    .selectAll('text')
    .data(labels)
    .join('text')
    .attr('x', width - M.r + 8)
    .attr('y', (d) => d.y + 4)
    .attr('fill', INK.text)
    .style('font-weight', '600')
    .style('font-size', '11.5px')
    .text((d) => d.text);

  const cross = f.g.cross;
  f.g.hit
    .selectAll('rect')
    .data([0])
    .join('rect')
    .attr('x', M.l)
    .attr('y', M.t)
    .attr('width', Math.max(0, width - M.l - M.r))
    .attr('height', H - M.t - M.b)
    .attr('fill', 'transparent')
    .on('pointermove', (ev: PointerEvent) => {
      const d = f.data as LatencyData;
      const p = d.samples.filter((s) => s.sat !== null) as { t: number; sat: number }[];
      if (!p.length) return;
      const [mx] = [ev.offsetX];
      const tx = x.invert(mx).getTime();
      const i = Math.min(p.length - 1, bisector((s: { t: number }) => s.t).center(p, tx));
      const s = p[i];
      const dots = [
        { v: s.sat, c: LINE.primary },
        ...(d.fiberMs !== null ? [{ v: d.fiberMs, c: LINE.reference }] : []),
      ];
      tooltip(f.tip, formatUtc(s.t) + ' UTC', [
        { color: LINE.primary, value: `${s.sat.toFixed(2)} ms`, label: 'laser path' },
        ...(d.fiberMs !== null ? [{ color: LINE.reference, value: `${d.fiberMs.toFixed(2)} ms`, label: 'fiber, great circle' }] : []),
      ]);
      glide(f, [x(new Date(s.t)), ...dots.map((q) => y(q.v))], ([px, ...ys]) => {
        crosshair(cross, px, ys, dots.map((q) => q.c), M.t, H - M.b);
        place(f.tip, px, ys[0]);
      });
    })
    .on('pointerleave', () => {
      unglide(f);
      cross.selectAll('*').remove();
      f.tip.style('display', 'none');
    });
}

// -------------------------------------------------------------------------- conjunction range

export interface RangeData {
  minutes: number[];
  km: number[];
  thresholdKm: number;
  missKm: number;
}

export function drawRange(root: HTMLDivElement, data: RangeData, width: number) {
  const H = 160;
  const M = { t: 12, r: 14, b: 24, l: 34 };
  const f = frame(root, H, ['grid', 'axes', 'thr', 'line', 'marks', 'cross', 'hit'], data, width);
  const vals = data.km.filter((v) => Number.isFinite(v) && v > 0);
  const lo = Math.max(0.01, Math.min(data.missKm, ...vals) / 2);
  const hi = Math.max(...vals, data.thresholdKm * 4);
  const x = scaleLinear().domain([data.minutes[0], data.minutes[data.minutes.length - 1]]).range([M.l, width - M.r]);
  const y = scaleLog().domain([lo, hi]).range([H - M.b, M.t]).clamp(true);
  const ticks = y.ticks(4).filter((t) => [1, 10, 100, 1000, 10000, 0.1, 0.01].some((k) => Math.abs(t - k) < 1e-9));
  gridY(f.g.grid, y, ticks, M.l, width - M.r);
  f.g.axes.selectAll('*').remove();
  const ax = f.g.axes.append('g').attr('transform', `translate(0,${H - M.b})`).call(axisBottom(x).tickValues(spaced(x.ticks(6), x, 60)).tickFormat((d) => `${+d > 0 ? '+' : +d < 0 ? '−' : ''}${Math.abs(+d)} min`)) as unknown as G;
  styleAxis(ax);
  const ay = f.g.axes
    .append('g')
    .attr('transform', `translate(${M.l - 6},0)`)
    .call(axisLeft(y).tickValues(ticks).tickFormat((d) => (+d >= 1000 ? `${+d / 1000}k` : `${d}`))) as unknown as G;
  styleAxis(ay);

  f.g.thr
    .selectAll('line')
    .data([data.thresholdKm])
    .join('line')
    .attr('x1', M.l)
    .attr('x2', width - M.r)
    .attr('y1', (d) => y(d))
    .attr('y2', (d) => y(d))
    .attr('stroke', INK.axis)
    .attr('stroke-dasharray', '3 4');
  f.g.thr
    .selectAll('text')
    .data([data.thresholdKm])
    .join('text')
    .attr('x', width - M.r)
    .attr('y', (d) => y(d) - 5)
    .attr('text-anchor', 'end')
    .attr('fill', INK.muted)
    .text((d) => `${d} km screening threshold`);

  const pts = data.minutes.map((m, i) => ({ m, v: data.km[i] })).filter((p) => Number.isFinite(p.v));
  const ln = line<{ m: number; v: number }>()
    .x((d) => x(d.m))
    .y((d) => y(Math.max(lo, d.v)));
  f.g.line
    .selectAll('path')
    .data([pts])
    .join('path')
    .attr('d', (d) => ln(d) ?? '')
    .attr('fill', 'none')
    .attr('stroke', LINE.primary)
    .attr('stroke-width', 2)
    .attr('stroke-linejoin', 'round');

  f.g.marks
    .selectAll('circle')
    .data([data.missKm])
    .join('circle')
    .attr('cx', x(0))
    .attr('cy', (d) => y(d))
    .attr('r', 4.5)
    .attr('fill', SERIOUS)
    .attr('stroke', INK.surface)
    .attr('stroke-width', 2);
  f.g.marks
    .selectAll('text')
    .data([data.missKm])
    .join('text')
    .attr('x', x(0) + 9)
    .attr('y', (d) => y(d) + 4)
    .attr('fill', INK.text)
    .style('font-weight', '600')
    .style('font-size', '11.5px')
    .text((d) => `${d < 1 ? (d * 1000).toFixed(0) + ' m' : d.toFixed(2) + ' km'} at TCA`);

  const cross = f.g.cross;
  f.g.hit
    .selectAll('rect')
    .data([0])
    .join('rect')
    .attr('x', M.l)
    .attr('y', M.t)
    .attr('width', Math.max(0, width - M.l - M.r))
    .attr('height', H - M.t - M.b)
    .attr('fill', 'transparent')
    .on('pointermove', (ev: PointerEvent) => {
      const d = f.data as RangeData;
      const p = d.minutes.map((m, i) => ({ m, v: d.km[i] })).filter((q) => Number.isFinite(q.v));
      const i = Math.min(p.length - 1, bisector((q: { m: number }) => q.m).center(p, x.invert(ev.offsetX)));
      const q = p[i];
      tooltip(f.tip, `TCA ${q.m >= 0 ? '+' : ''}${q.m.toFixed(1)} min`, [{ value: q.v < 10 ? `${q.v.toFixed(3)} km` : `${q.v.toFixed(0)} km`, label: 'separation' }]);
      glide(f, [x(q.m), y(Math.max(lo, q.v))], ([px, py]) => {
        crosshair(cross, px, [py], [LINE.primary], M.t, H - M.b);
        place(f.tip, px, py);
      });
    })
    .on('pointerleave', () => {
      unglide(f);
      cross.selectAll('*').remove();
      f.tip.style('display', 'none');
    });
}

// -------------------------------------------------------------------------- coverage by latitude

export interface CoverageData {
  byLat: Float32Array;
}

export function drawCoverage(root: HTMLDivElement, data: CoverageData, width: number) {
  const H = 150;
  const M = { t: 12, r: 14, b: 24, l: 30 };
  const f = frame(root, H, ['grid', 'axes', 'area', 'line', 'labels', 'cross', 'hit'], data, width);
  const n = data.byLat.length;
  const pts = Array.from(data.byLat, (v, i) => ({ lat: -90 + (i + 0.5) * (180 / n), v }));
  const x = scaleLinear().domain([-90, 90]).range([M.l, width - M.r]);
  const y = scaleLinear()
    .domain([0, Math.max(1, max(pts, (p) => p.v) ?? 1) * 1.12])
    .nice()
    .range([H - M.b, M.t]);
  gridY(f.g.grid, y, y.ticks(4), M.l, width - M.r);
  f.g.axes.selectAll('*').remove();
  const ax = f.g.axes
    .append('g')
    .attr('transform', `translate(0,${H - M.b})`)
    .call(axisBottom(x).tickValues([-90, -60, -30, 0, 30, 60, 90]).tickFormat((d) => (+d === 0 ? '0°' : `${Math.abs(+d)}°${+d > 0 ? 'N' : 'S'}`))) as unknown as G;
  styleAxis(ax);
  const ay = f.g.axes.append('g').attr('transform', `translate(${M.l - 6},0)`).call(axisLeft(y).ticks(4)) as unknown as G;
  styleAxis(ay);

  const ar = area<{ lat: number; v: number }>()
    .x((d) => x(d.lat))
    .y0(y(0))
    .y1((d) => y(d.v));
  const ln = line<{ lat: number; v: number }>()
    .x((d) => x(d.lat))
    .y((d) => y(d.v));
  f.g.area.selectAll('path').data([pts]).join('path').attr('d', (d) => ar(d) ?? '').attr('fill', wash(f as Frame<unknown>, LINE.primary, 0.16));
  f.g.line
    .selectAll('path')
    .data([pts])
    .join('path')
    .attr('d', (d) => ln(d) ?? '')
    .attr('fill', 'none')
    .attr('stroke', LINE.primary)
    .attr('stroke-width', 2)
    .attr('stroke-linejoin', 'round');

  const peak = pts.reduce((a, b) => (b.v > a.v ? b : a), pts[0]);
  f.g.labels
    .selectAll('text')
    .data(peak && peak.v > 0 ? [peak] : [])
    .join('text')
    .attr('x', (d) => x(d.lat))
    .attr('y', (d) => y(d.v) - 7)
    .attr('text-anchor', 'middle')
    .attr('fill', INK.text)
    .style('font-weight', '600')
    .style('font-size', '11.5px')
    .text((d) => `${d.v.toFixed(1)} at ${Math.abs(d.lat).toFixed(0)}°${d.lat >= 0 ? 'N' : 'S'}`);

  const cross = f.g.cross;
  f.g.hit
    .selectAll('rect')
    .data([0])
    .join('rect')
    .attr('x', M.l)
    .attr('y', M.t)
    .attr('width', Math.max(0, width - M.l - M.r))
    .attr('height', H - M.t - M.b)
    .attr('fill', 'transparent')
    .on('pointermove', (ev: PointerEvent) => {
      const d = f.data as CoverageData;
      const nn = d.byLat.length;
      const lat = x.invert(ev.offsetX);
      const i = Math.max(0, Math.min(nn - 1, Math.floor(((lat + 90) / 180) * nn)));
      const la = -90 + (i + 0.5) * (180 / nn);
      const v = d.byLat[i];
      tooltip(f.tip, `${Math.abs(la).toFixed(0)}°${la >= 0 ? 'N' : 'S'}`, [{ value: v.toFixed(1), label: 'satellites above 25°, mean' }]);
      glide(f, [x(la), y(v)], ([px, py]) => {
        crosshair(cross, px, [py], [LINE.primary], M.t, H - M.b);
        place(f.tip, px, py);
      });
    })
    .on('pointerleave', () => {
      unglide(f);
      cross.selectAll('*').remove();
      f.tip.style('display', 'none');
    });
}

// -------------------------------------------------------------------------- altitude histogram

export interface AltitudeData {
  alt: Float32Array;
  group: Uint8Array;
}

const GROUP_LABELS = ['Starlink', 'Debris & rocket bodies', 'Other satellites'];

/**
 * Small multiples, one row per group sharing the log-altitude axis. The groups
 * differ by 30x in peak count, so a shared stacked scale would flatten all but
 * Starlink; each row carries its own (labeled) linear count scale instead.
 */
export function drawAltitude(root: HTMLDivElement, data: AltitudeData, width: number) {
  const rowH = 56, gap = 26;
  const order = [0, 2, 1];
  const M = { t: 18, r: 12, b: 24, l: 40 };
  const H = M.t + order.length * rowH + (order.length - 1) * gap + M.b;
  const f = frame(root, H, ['grid', 'axes', 'bars', 'annot', 'hit'], data, width);
  const lo = 150, hi = 45000, nb = 46;
  const l0 = Math.log10(lo), l1 = Math.log10(hi);
  const edges = Array.from({ length: nb + 1 }, (_, k) => 10 ** (l0 + ((l1 - l0) * k) / nb));
  const counts = Array.from({ length: 3 }, () => new Array<number>(nb).fill(0));
  for (let i = 0; i < data.alt.length; i++) {
    const a = data.alt[i];
    if (!(a >= lo && a < hi)) continue;
    const b = Math.min(nb - 1, Math.floor(((Math.log10(a) - l0) / (l1 - l0)) * nb));
    counts[data.group[i]][b]++;
  }
  const x = scaleLog().domain([lo, hi]).range([M.l, width - M.r]);
  const rows = order.map((g, r) => {
    const top = M.t + r * (rowH + gap);
    const peak = Math.max(1, ...counts[g]);
    const y = scaleLinear().domain([0, peak]).range([top + rowH, top + 2]);
    return { g, top, peak, y };
  });

  f.g.grid.selectAll('*').remove();
  f.g.axes.selectAll('*').remove();
  f.g.annot.selectAll('*').remove();
  for (const r of rows) {
    // baseline + row label (text ink; identity comes from the bars and the label)
    f.g.grid.append('line').attr('x1', M.l).attr('x2', width - M.r).attr('y1', r.top + rowH + 0.5).attr('y2', r.top + rowH + 0.5).attr('stroke', INK.axis);
    f.g.annot
      .append('text')
      .attr('x', M.l)
      .attr('y', r.top - 4)
      .attr('fill', INK.text2)
      .style('font-size', '11.5px')
      .text(`${GROUP_LABELS[r.g]} · peak ${r.peak.toLocaleString()}`);
    const ay = f.g.axes.append('g').attr('transform', `translate(${M.l - 6},0)`).call(axisLeft(r.y).tickValues([r.peak]).tickFormat((d) => (+d >= 10000 ? `${Math.round(+d / 1000)}k` : (+d).toLocaleString()))) as unknown as G;
    styleAxis(ay);
  }
  const ax = f.g.axes
    .append('g')
    .attr('transform', `translate(0,${H - M.b})`)
    .call(axisBottom(x).tickValues([200, 500, 1000, 2000, 5000, 10000, 20000, 36000]).tickFormat((d) => (+d >= 1000 ? `${+d / 1000}k` : `${d}`))) as unknown as G;
  styleAxis(ax);

  type Bar = { x: number; w: number; y0: number; y1: number; c: string; b: number };
  const bars: Bar[] = [];
  for (const r of rows) {
    counts[r.g].forEach((c, b) => {
      if (!c) return;
      const xa = x(edges[b]) + 1, xb = x(edges[b + 1]) - 1;
      const w = Math.min(24, Math.max(1, xb - xa));
      bars.push({ x: xa + (xb - xa - w) / 2, w, y0: r.top + rowH, y1: Math.min(r.y(c), r.top + rowH - 1), c: SERIES[r.g], b });
    });
  }
  // rounded data-end, square at the baseline
  const path = (s: Bar) => {
    const h = Math.max(0, s.y0 - s.y1);
    const rr = Math.min(2, s.w / 2, h);
    return `M${s.x},${s.y0}V${s.y1 + rr}Q${s.x},${s.y1} ${s.x + rr},${s.y1}H${s.x + s.w - rr}Q${s.x + s.w},${s.y1} ${s.x + s.w},${s.y1 + rr}V${s.y0}Z`;
  };
  // a faint ink edge keeps Tol's dark blue legible against the black panel
  f.g.bars
    .selectAll('path')
    .data(bars)
    .join('path')
    .attr('d', path)
    .attr('fill', (s) => s.c)
    .attr('stroke', 'rgba(240,240,250,0.3)')
    .attr('stroke-width', 0.75);

  const geo = x(35786);
  f.g.annot.append('line').attr('x1', geo).attr('x2', geo).attr('y1', M.t).attr('y2', H - M.b).attr('stroke', INK.grid);
  f.g.annot.append('text').attr('x', geo - 4).attr('y', H - M.b - 4).attr('text-anchor', 'end').attr('fill', INK.muted).text('GEO');

  f.g.hit
    .selectAll('rect')
    .data(Array.from({ length: nb }, (_, b) => b))
    .join('rect')
    .attr('x', (b) => x(edges[b]))
    .attr('width', (b) => Math.max(1, x(edges[b + 1]) - x(edges[b])))
    .attr('y', M.t)
    .attr('height', H - M.t - M.b)
    .attr('fill', 'transparent')
    .on('pointermove', (_ev: PointerEvent, b) => {
      const xm = (x(edges[b]) + x(edges[b + 1])) / 2;
      const total = counts[0][b] + counts[1][b] + counts[2][b];
      tooltip(
        f.tip,
        `${Math.round(edges[b]).toLocaleString()}–${Math.round(edges[b + 1]).toLocaleString()} km · ${total.toLocaleString()} objects`,
        order.filter((g) => counts[g][b] > 0).map((g) => ({ color: SERIES[g], key: 'rect' as const, value: counts[g][b].toLocaleString(), label: GROUP_LABELS[g] })),
      );
      f.tip.style('transform', 'translate(-50%, 0)');
      glide(f, [xm], ([px]) => place(f.tip, px, M.t + 10));
      f.g.bars.selectAll<SVGPathElement, Bar>('path').attr('fill-opacity', (s) => (s.b === b ? 1 : 0.55));
    })
    .on('pointerleave', () => {
      unglide(f);
      f.tip.style('display', 'none').style('transform', null);
      f.g.bars.selectAll('path').attr('fill-opacity', 1);
    });
}
