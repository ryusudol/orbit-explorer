// D3 chart renderers. Each keeps its SVG between calls (stored on the root
// element) so live updates don't reset hover state.
//
// Mark specs follow the dataviz reference: 2 px lines, hairline recessive grid,
// area wash at 10%, 2 px surface gaps between touching fills, text in text
// tokens (never series colours), crosshair tooltips on lines, per-mark tooltips on bars.

import { axisBottom, axisLeft } from 'd3-axis';
import { bisector, max } from 'd3-array';
import { scaleLinear, scaleLog, scaleUtc } from 'd3-scale';
import { select, type Selection } from 'd3-selection';
import { area, line } from 'd3-shape';
import { utcFormat } from 'd3-time-format';
import { formatUtc } from '../sim/time';
import type { LatencySample } from '../state/store';

export const INK = { text: '#e8edf3', text2: '#a9b2bf', muted: '#778190', grid: '#1f242c', axis: '#353b44', surface: '#0c0f14' };
export const SERIES = ['#3987e5', '#d95926', '#199e70'];
const SERIOUS = '#ec835a';

type Svg = Selection<SVGSVGElement, unknown, null, undefined>;
type G = Selection<SVGGElement, unknown, null, undefined>;

interface Frame<D> {
  svg: Svg;
  g: Record<string, G>;
  tip: Selection<HTMLDivElement, unknown, null, undefined>;
  data: D;
  width: number;
}

function frame<D>(root: HTMLDivElement, height: number, layers: string[], data: D, width: number): Frame<D> {
  const r = root as HTMLDivElement & { __frame?: Frame<D> };
  if (!r.__frame) {
    const svg = select(root).append('svg') as unknown as Svg;
    const g: Record<string, G> = {};
    for (const name of layers) g[name] = svg.append('g').attr('class', name) as unknown as G;
    const tip = select(root).append('div').attr('class', 'tooltip').style('display', 'none') as unknown as Frame<D>['tip'];
    r.__frame = { svg, g, tip, data, width };
  }
  const f = r.__frame;
  f.data = data;
  f.width = width;
  f.svg.attr('width', width).attr('height', height).attr('viewBox', `0 0 ${width} ${height}`);
  return f;
}

function tooltip(tip: Frame<unknown>['tip'], x: number, y: number, head: string, rows: { color?: string; key?: 'line' | 'rect'; value: string; label: string }[]) {
  tip.style('display', null).style('left', `${x}px`).style('top', `${y}px`);
  tip.selectAll('*').remove();
  tip.append('div').attr('class', 't-head').text(head);
  for (const r of rows) {
    const row = tip.append('div').attr('class', 't-row');
    if (r.color) row.append('i').attr('class', r.key === 'rect' ? 'key-rect' : 'key-line').style('background', r.color).style('display', 'inline-block');
    row.append('b').text(r.value);
    row.append('span').text(r.label);
  }
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
  fibreMs: number | null;
}

export function drawLatency(root: HTMLDivElement, data: LatencyData, width: number) {
  const H = 150;
  const M = { t: 10, r: 62, b: 22, l: 30 };
  const f = frame(root, H, ['grid', 'axes', 'fibre', 'sat', 'labels', 'cross', 'hit'], data, width);
  const pts = data.samples.filter((s) => s.sat !== null) as { t: number; sat: number }[];
  const t0 = data.samples.length ? data.samples[0].t : 0;
  const t1 = data.samples.length ? data.samples[data.samples.length - 1].t : 1;
  const x = scaleUtc().domain([new Date(t0), new Date(Math.max(t1, t0 + 1000))]).range([M.l, width - M.r]);
  const top = Math.max(data.fibreMs ?? 0, max(pts, (p) => p.sat) ?? 0, 10) * 1.18;
  const y = scaleLinear().domain([0, top]).nice().range([H - M.b, M.t]);

  gridY(f.g.grid, y, y.ticks(4), M.l, width - M.r);
  f.g.axes.selectAll('*').remove();
  const ax = f.g.axes.append('g').attr('transform', `translate(0,${H - M.b})`).call(axisBottom(x).ticks(4).tickFormat((d) => utcFormat(t1 - t0 < 300_000 ? '%H:%M:%S' : '%H:%M')(d as Date))) as unknown as G;
  styleAxis(ax);
  const ay = f.g.axes.append('g').attr('transform', `translate(${M.l - 6},0)`).call(axisLeft(y).ticks(4)) as unknown as G;
  styleAxis(ay);

  const ln = line<{ t: number; sat: number }>()
    .x((d) => x(new Date(d.t)))
    .y((d) => y(d.sat));
  f.g.sat
    .selectAll('path')
    .data([pts])
    .join('path')
    .attr('d', (d) => ln(d) ?? '')
    .attr('fill', 'none')
    .attr('stroke', SERIES[0])
    .attr('stroke-width', 2)
    .attr('stroke-linejoin', 'round')
    .attr('stroke-linecap', 'round');
  f.g.fibre
    .selectAll('line')
    .data(data.fibreMs !== null && data.samples.length ? [data.fibreMs] : [])
    .join('line')
    .attr('x1', M.l)
    .attr('x2', width - M.r)
    .attr('y1', (d) => y(d))
    .attr('y2', (d) => y(d))
    .attr('stroke', SERIES[1])
    .attr('stroke-width', 2)
    .attr('stroke-linecap', 'round');

  // direct labels at the right end, in text ink
  const last = pts[pts.length - 1];
  const labels: { y: number; text: string }[] = [];
  if (last) labels.push({ y: y(last.sat), text: `${last.sat.toFixed(1)} ms` });
  if (data.fibreMs !== null && data.samples.length) labels.push({ y: y(data.fibreMs), text: `${data.fibreMs.toFixed(1)} ms` });
  f.g.labels
    .selectAll('text')
    .data(labels)
    .join('text')
    .attr('x', width - M.r + 8)
    .attr('y', (d) => d.y + 4)
    .attr('fill', INK.text)
    .style('font-family', 'var(--mono)')
    .style('font-size', '11px')
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
      const px = x(new Date(s.t));
      cross.selectAll('line').data([0]).join('line').attr('x1', px).attr('x2', px).attr('y1', M.t).attr('y2', H - M.b).attr('stroke', INK.axis);
      cross
        .selectAll('circle')
        .data([
          { v: s.sat, c: SERIES[0] },
          ...(d.fibreMs !== null ? [{ v: d.fibreMs, c: SERIES[1] }] : []),
        ])
        .join('circle')
        .attr('cx', px)
        .attr('cy', (q) => y(q.v))
        .attr('r', 4)
        .attr('fill', (q) => q.c)
        .attr('stroke', INK.surface)
        .attr('stroke-width', 2);
      tooltip(f.tip, px, y(s.sat), formatUtc(s.t) + ' UTC', [
        { color: SERIES[0], value: `${s.sat.toFixed(2)} ms`, label: 'laser path' },
        ...(d.fibreMs !== null ? [{ color: SERIES[1], value: `${d.fibreMs.toFixed(2)} ms`, label: 'fibre, great circle' }] : []),
      ]);
    })
    .on('pointerleave', () => {
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
  const ax = f.g.axes.append('g').attr('transform', `translate(0,${H - M.b})`).call(axisBottom(x).ticks(6).tickFormat((d) => `${+d > 0 ? '+' : ''}${d} min`)) as unknown as G;
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
    .attr('stroke', INK.axis);
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
    .attr('stroke', SERIES[0])
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
    .style('font-family', 'var(--mono)')
    .style('font-size', '11px')
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
      cross.selectAll('line').data([0]).join('line').attr('x1', x(q.m)).attr('x2', x(q.m)).attr('y1', M.t).attr('y2', H - M.b).attr('stroke', INK.axis);
      cross.selectAll('circle').data([q]).join('circle').attr('cx', x(q.m)).attr('cy', y(Math.max(lo, q.v))).attr('r', 4).attr('fill', SERIES[0]).attr('stroke', INK.surface).attr('stroke-width', 2);
      tooltip(f.tip, x(q.m), y(Math.max(lo, q.v)), `TCA ${q.m >= 0 ? '+' : ''}${q.m.toFixed(1)} min`, [{ value: q.v < 10 ? `${q.v.toFixed(3)} km` : `${q.v.toFixed(0)} km`, label: 'separation' }]);
    })
    .on('pointerleave', () => {
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
  f.g.area.selectAll('path').data([pts]).join('path').attr('d', (d) => ar(d) ?? '').attr('fill', SERIES[0]).attr('fill-opacity', 0.1);
  f.g.line
    .selectAll('path')
    .data([pts])
    .join('path')
    .attr('d', (d) => ln(d) ?? '')
    .attr('fill', 'none')
    .attr('stroke', SERIES[0])
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
    .style('font-family', 'var(--mono)')
    .style('font-size', '11px')
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
      cross.selectAll('line').data([0]).join('line').attr('x1', x(la)).attr('x2', x(la)).attr('y1', M.t).attr('y2', H - M.b).attr('stroke', INK.axis);
      cross.selectAll('circle').data([0]).join('circle').attr('cx', x(la)).attr('cy', y(v)).attr('r', 4).attr('fill', SERIES[0]).attr('stroke', INK.surface).attr('stroke-width', 2);
      tooltip(f.tip, x(la), y(v), `${Math.abs(la).toFixed(0)}°${la >= 0 ? 'N' : 'S'}`, [{ value: v.toFixed(1), label: 'satellites above 25°, mean' }]);
    })
    .on('pointerleave', () => {
      cross.selectAll('*').remove();
      f.tip.style('display', 'none');
    });
}

// -------------------------------------------------------------------------- altitude histogram

export interface AltitudeData {
  alt: Float32Array;
  group: Uint8Array;
}

const GROUP_LABELS = ['Starlink', 'Debris & rocket bodies', 'Other payloads'];

/**
 * Small multiples, one row per group sharing the log-altitude axis. The groups
 * differ by 30x in peak count, so a shared stacked scale would flatten all but
 * Starlink; each row carries its own (labelled) linear count scale instead.
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
      .style('font-size', '11px')
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
  f.g.bars.selectAll('path').data(bars).join('path').attr('d', path).attr('fill', (s) => s.c);

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
        xm,
        M.t + 10,
        `${Math.round(edges[b]).toLocaleString()}–${Math.round(edges[b + 1]).toLocaleString()} km · ${total.toLocaleString()} objects`,
        order.filter((g) => counts[g][b] > 0).map((g) => ({ color: SERIES[g], key: 'rect' as const, value: counts[g][b].toLocaleString(), label: GROUP_LABELS[g] })),
      );
      f.tip.style('transform', 'translate(-50%, 0)');
      f.g.bars.selectAll<SVGPathElement, Bar>('path').attr('fill-opacity', (s) => (s.b === b ? 1 : 0.55));
    })
    .on('pointerleave', () => {
      f.tip.style('display', 'none').style('transform', null);
      f.g.bars.selectAll('path').attr('fill-opacity', 1);
    });
}
