#!/usr/bin/env node
// Renders the validation and benchmark figures in docs/ as static SVG, in a
// light and a dark variant for the README's <picture> element.
//   docs/validation/vallado-errors.csv       <- cargo run --example validate
//   docs/validation/satellitejs-diff.csv     <- WRITE_VALIDATION=1 vitest run
//   docs/benchmarks-native.json              <- cargo run --example bench

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaleLinear, scaleLog, scaleBand } from 'd3-scale';
import { line } from 'd3-shape';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const docs = join(root, 'docs');

const THEMES = {
  light: { surface: '#fcfcfb', text: '#0b0b0b', text2: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', s1: '#2a78d6', s2: '#eb6834' },
  dark: { surface: '#1a1a19', text: '#ffffff', text2: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', axis: '#383835', s1: '#3987e5', s2: '#d95926' },
};
const FONT = `font-family="system-ui, -apple-system, 'Segoe UI', sans-serif"`;

const csv = (p) => {
  const [head, ...lines] = readFileSync(p, 'utf8').trim().split('\n');
  const keys = head.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [keys[i], isNaN(+v) ? v : +v])));
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
/** Tick label for a power of ten; SVG markup (superscript) outside 0.001..1000. */
const fmtPow = (v) => {
  const e = Math.round(Math.log10(v));
  if (e >= -3 && e <= 3) return String(Number((10 ** e).toPrecision(1)));
  return `10<tspan dy="-5" font-size="8">${e < 0 ? '−' : ''}${Math.abs(e)}</tspan>`;
};

function frame(t, w, h, title, subtitle, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ${FONT}>
<rect width="${w}" height="${h}" rx="10" fill="${t.surface}"/>
<text x="24" y="34" font-size="16" font-weight="600" fill="${t.text}">${esc(title)}</text>
<text x="24" y="56" font-size="12.5" fill="${t.text2}">${esc(subtitle)}</text>
${body}
</svg>
`;
}

function yGrid(t, y, ticks, x0, x1, fmt) {
  return ticks
    .map((v) => {
      const yy = Math.round(y(v)) + 0.5;
      return `<line x1="${x0}" x2="${x1}" y1="${yy}" y2="${yy}" stroke="${t.grid}"/><text x="${x0 - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="${t.muted}">${fmt(v)}</text>`;
    })
    .join('');
}

// ------------------------------------------------------------------ Vallado strip plot

function vallado(t) {
  const rows = csv(join(docs, 'validation', 'vallado-errors.csv'));
  const sats = [...new Set(rows.map((r) => r.satnum))];
  const W = 900, H = 420, M = { t: 84, r: 24, b: 58, l: 70 };
  const x = scaleBand().domain(sats.map(String)).range([M.l, W - M.r]).padding(0.3);
  const floor = 1e-4;
  const y = scaleLog().domain([floor, 1]).range([H - M.b, M.t]).clamp(true);
  const worst = Math.max(...rows.map((r) => r.dr_mm));
  const below = rows.filter((r) => r.dr_mm <= 0.01).length;
  let body = yGrid(t, y, [1e-4, 1e-3, 1e-2, 1e-1, 1], M.l, W - M.r, fmtPow);
  // print-precision band: the reference prints 8 decimals of km (0.01 mm)
  body += `<line x1="${M.l}" x2="${W - M.r}" y1="${y(0.01)}" y2="${y(0.01)}" stroke="${t.axis}"/>`;
  body += `<text x="${W - M.r}" y="${y(0.01) - 6}" text-anchor="end" font-size="11" fill="${t.muted}">reference output rounding (0.01 mm)</text>`;
  const seeded = (k) => ((Math.sin(k * 12.9898) * 43758.5453) % 1 + 1) % 1;
  rows.forEach((r, k) => {
    const cx = x(String(r.satnum)) + x.bandwidth() * (0.15 + 0.7 * seeded(k));
    const cy = y(Math.max(floor, r.dr_mm));
    const c = r.deep_space ? t.s2 : t.s1;
    body += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.2" fill="${c}" fill-opacity="0.85" stroke="${t.surface}" stroke-width="1"/>`;
  });
  sats.forEach((s, i) => {
    if (i % 2) return;
    body += `<text x="${x(String(s)) + x.bandwidth() / 2}" y="${H - M.b + 16}" text-anchor="middle" font-size="10" fill="${t.muted}">${s}</text>`;
  });
  body += `<text x="${(M.l + W - M.r) / 2}" y="${H - 14}" text-anchor="middle" font-size="11.5" fill="${t.text2}">verification object (NORAD number), 33 cases</text>`;
  body += `<text x="18" y="${(M.t + H - M.b) / 2}" transform="rotate(-90 18 ${(M.t + H - M.b) / 2})" text-anchor="middle" font-size="11.5" fill="${t.text2}">|Δr|, millimetres (log)</text>`;
  // legend
  body += `<circle cx="${W - 230}" cy="30" r="4" fill="${t.s1}"/><text x="${W - 220}" y="34" font-size="12" fill="${t.text2}">near-Earth (SGP4)</text>`;
  body += `<circle cx="${W - 230}" cy="50" r="4" fill="${t.s2}"/><text x="${W - 220}" y="54" font-size="12" fill="${t.text2}">deep space (SDP4)</text>`;
  return frame(t, W, H, 'SGP4/SDP4 vs Vallado et al. (2006) reference output', `${rows.length} states from 33 objects. Worst ${worst.toFixed(3)} mm; ${Math.round((100 * below) / rows.length)}% sit below the reference file's own print rounding.`, body);
}

// ------------------------------------------------------------------ satellite.js histogram

function satjs(t) {
  const rows = csv(join(docs, 'validation', 'satellitejs-diff.csv'));
  const W = 900, H = 360, M = { t: 84, r: 24, b: 58, l: 70 };
  const zero = rows.filter((r) => r.dr_mm === 0).length;
  const nz = rows.filter((r) => r.dr_mm > 0).map((r) => r.dr_mm);
  const lo = -8, hi = 2, nb = 30;
  const bins = new Array(nb).fill(0);
  for (const v of nz) bins[Math.max(0, Math.min(nb - 1, Math.floor(((Math.log10(v) - lo) / (hi - lo)) * nb)))]++;
  const barsX = scaleLinear().domain([lo, hi]).range([M.l + 90, W - M.r]);
  const y = scaleLinear().domain([0, Math.max(zero, ...bins)]).nice().range([H - M.b, M.t]);
  let body = yGrid(t, y, y.ticks(4), M.l, W - M.r, (v) => v.toLocaleString('en-US'));
  const bar = (x0, x1, v, c) => {
    const w = Math.min(24, x1 - x0 - 2), cx = x0 + (x1 - x0 - w) / 2, top = y(v), base = y(0), r = Math.min(4, w / 2, base - top);
    return v ? `<path d="M${cx},${base}V${top + r}Q${cx},${top} ${cx + r},${top}H${cx + w - r}Q${cx + w},${top} ${cx + w},${top + r}V${base}Z" fill="${c}"/>` : '';
  };
  body += bar(M.l + 8, M.l + 70, zero, t.s1);
  body += `<text x="${M.l + 39}" y="${y(zero) - 6}" text-anchor="middle" font-size="11" fill="${t.text}">${((zero / rows.length) * 100).toFixed(1)}%</text>`;
  body += `<text x="${M.l + 39}" y="${H - M.b + 16}" text-anchor="middle" font-size="10.5" fill="${t.muted}">identical</text>`;
  bins.forEach((v, b) => (body += bar(barsX(lo + ((hi - lo) * b) / nb), barsX(lo + ((hi - lo) * (b + 1)) / nb), v, t.s1)));
  for (let e = lo; e <= hi; e += 2) body += `<text x="${barsX(e)}" y="${H - M.b + 16}" text-anchor="middle" font-size="10.5" fill="${t.muted}">${fmtPow(10 ** e)}</text>`;
  body += `<text x="${(barsX(lo) + barsX(hi)) / 2}" y="${H - 14}" text-anchor="middle" font-size="11.5" fill="${t.text2}">|Δr| between the two implementations, millimetres (log bins)</text>`;
  const worst = Math.max(...nz);
  return frame(t, W, H, 'Orbit Explorer SGP4 (Rust→WASM) vs satellite.js on the live catalogue', `${rows.length.toLocaleString('en-US')} states, 1 day before to 3 days after epoch. Worst ${worst.toFixed(2)} mm (a 14-day HEO at +3 d): floating-point, not physics.`, body);
}

// ------------------------------------------------------------------ scaling

function scaling(t) {
  const b = JSON.parse(readFileSync(join(docs, 'benchmarks-native.json'), 'utf8'));
  const pts = b.scaling;
  const W = 900, H = 380, M = { t: 84, r: 150, b: 58, l: 70 };
  const x = scaleLog().domain([8000, 120000]).range([M.l, W - M.r]);
  const y = scaleLog().domain([0.5, 20000]).range([H - M.b, M.t]);
  let body = yGrid(t, y, [1, 10, 100, 1000, 10000], M.l, W - M.r, (v) => (v >= 1000 ? `${v / 1000} s` : `${v} ms`));
  const series = [
    { key: 'brute_ms', label: 'all pairs, O(N²)', c: t.s2 },
    { key: 'grid_ms', label: 'spatial grid, O(N)', c: t.s1 },
  ];
  for (const s of series) {
    const ln = line().x((d) => x(d.n)).y((d) => y(d[s.key]));
    body += `<path d="${ln(pts)}" fill="none" stroke="${s.c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    for (const d of pts) body += `<circle cx="${x(d.n)}" cy="${y(d[s.key])}" r="4.5" fill="${s.c}" stroke="${t.surface}" stroke-width="2"/>`;
    const last = pts[pts.length - 1];
    body += `<line x1="${x(last.n) + 8}" x2="${x(last.n) + 22}" y1="${y(last[s.key])}" y2="${y(last[s.key])}" stroke="${s.c}" stroke-width="2"/>`;
    body += `<text x="${x(last.n) + 28}" y="${y(last[s.key]) + 4}" font-size="12" fill="${t.text}">${s.label}</text>`;
  }
  for (const n of [10000, 30000, 100000]) body += `<text x="${x(n)}" y="${H - M.b + 18}" text-anchor="middle" font-size="11" fill="${t.muted}">${(n / 1000).toFixed(0)}k objects</text>`;
  const last = pts[pts.length - 1];
  return frame(t, W, H, 'Conjunction sieve: every pair closer than 10 km, one instant', `Native, ${b.machine}, single thread. At 100k objects the grid is ${Math.round(last.brute_ms / last.grid_ms)}× faster (${last.grid_ms.toFixed(1)} ms vs ${(last.brute_ms / 1000).toFixed(1)} s). Both return identical pairs.`, body);
}

for (const [name, fn] of [
  ['validation/vallado', vallado],
  ['validation/satellitejs', satjs],
  ['benchmark-scaling', scaling],
]) {
  for (const mode of ['light', 'dark']) {
    const out = join(docs, `${name}-${mode}.svg`);
    writeFileSync(out, fn(THEMES[mode]));
    console.log(out.replace(root + '/', ''));
  }
}
