import { useMemo } from 'react';
import { D3Chart } from '../panels/D3Chart';
import { drawAltitude, drawCoverage } from '../panels/charts';
import { getController, GROUP_HEX } from '../scene/SceneController';
import { useStore } from '../state/store';
import { Dot, Explain, Section, Stat, StatAuto, Switch } from './common';
import { compact, fixed, int, ms } from './format';
import { Icon } from './icons';
import { GROUP_LABELS } from './groups';

const RAMP = ['#0d366b', '#184f95', '#2a78d6', '#5598e7', '#9ec5f4'];

export function CoveragePanel() {
  const byLat = useStore((s) => s.coverageByLat);
  const frac = useStore((s) => s.coverageFraction);
  const stats = useStore((s) => s.coverageStats);
  const on = useStore((s) => s.layers.coverage);
  const setLayer = useStore((s) => s.setLayer);
  const data = useMemo(() => (byLat ? { byLat } : null), [byLat]);
  return (
    <>
      <Section>
        {data ? (
          <>
            <div className="hero">
              <span className="hero-v">{fixed(frac * 100, 1)}</span>
              <span className="hero-u">% of Earth’s surface sees a Starlink satellite above 25° right now</span>
            </div>
            <div className="meter" aria-hidden="true">
              <span style={{ width: `${frac * 100}%` }} />
            </div>
            {stats && (
              <div className="metrics">
                <Stat k="Fewest" v={int(stats.min)} />
                <Stat k="Mean" v={fixed(stats.mean, 1)} />
                <Stat k="Most" v={int(stats.max)} />
              </div>
            )}
          </>
        ) : (
          <div className="empty">
            <Icon name="globe" size={18} />
            Computing coverage…
          </div>
        )}
      </Section>
      <Section>
        <div className="card-toggle">
          <Switch on={on} onChange={(v) => setLayer('coverage', v)}>
            Show heatmap on the globe
          </Switch>
          <div className="ramp">
            <span>0</span>
            <span className="ramp-bar" style={{ background: `linear-gradient(90deg, ${RAMP.join(',')})` }} />
            <span>many satellites</span>
          </div>
        </div>
      </Section>
      {data && (
        <Section title="Satellites in view by latitude" aside="mean across longitude">
          <D3Chart draw={drawCoverage} data={data} height={150} label="Mean number of visible satellites by latitude" />
          <Explain>
            Each satellite stamps its visibility cap onto a 2° grid: half-angle λ = acos(R·cos e / r) − e, about 8.4° at 550 km for e = 25°.
            This is O(satellites × cap cells), not O(satellites × cells). Coverage thins past ~57°, where the 53° shells run out, and the polar
            shells fill it back in.
          </Explain>
        </Section>
      )}
    </>
  );
}

/**
 * The catalogue's farthest entries: the two Voyagers still carry their NORAD numbers,
 * though they left Earth orbit in 1977. A row flies there and follows.
 */
function DeepSpace() {
  useStore((s) => s.timeMs); // refresh with the clock
  const rows = getController()?.deepSpace() ?? [];
  const AU = 149_597_870.7;
  return (
    <Section title="Beyond Earth orbit" aside="from the Sun · light time">
      <div className="event-list" role="list">
        {rows.map((r) => (
          <button
            key={r.id}
            role="listitem"
            className="event fleet-row"
            onClick={() => getController()?.travelTo('oort', () => getController()?.selectOrbiter(r.id, true))}
            title={`Fly to ${r.name} and follow it`}
          >
            <Dot color={GROUP_HEX[2]} />
            <span className="event-names">
              <span>{r.name}</span>
              <span className="muted">NORAD {r.norad} · launched 1977</span>
            </span>
            <span className="event-figs">
              <span className="event-miss">{fixed(r.sunKm / AU, 1)} au</span>
              <span className="event-when">{fixed(r.earthKm / 299_792.458 / 3600, 1)} h</span>
            </span>
          </button>
        ))}
        {!rows.length && <p className="body-text">Loading the Voyagers’ trajectories…</p>}
      </div>
    </Section>
  );
}

export function CatalogPanel() {
  const meta = useStore((s) => s.meta);
  const counts = useStore((s) => s.groupCounts);
  const alt = useStore((s) => s.altitudeKm);
  const groups = useStore((s) => s.groups);
  const data = useMemo(() => (alt && groups ? { alt, group: groups } : null), [alt, groups]);
  const total = counts[0] + counts[1] + counts[2];
  const order = [0, 2, 1];
  return (
    <>
      <Section>
        <div className="hero">
          <span className="hero-v">{meta ? int(meta.objects) : '—'}</span>
          <span className="hero-u">objects, every one propagated live</span>
        </div>
        <div className="composition lg" aria-hidden="true">
          {order.map((i) => (
            <span key={i} style={{ flexGrow: counts[i], background: GROUP_HEX[i] }} />
          ))}
        </div>
        <div className="breakdown">
          {order.map((i) => (
            <div key={i} className="breakdown-row">
              <Dot color={GROUP_HEX[i]} />
              <span className="breakdown-k">{GROUP_LABELS[i]}</span>
              <span className="breakdown-v">{int(counts[i])}</span>
              <span className="breakdown-p">{total ? fixed((counts[i] / total) * 100, 0) : 0}%</span>
            </div>
          ))}
        </div>
      </Section>
      <DeepSpace />
      <Section title="Mean altitude" aside="log scale · own count scale per row">
        {data && <D3Chart draw={drawAltitude} data={data} height={278} label="Objects by mean altitude per group, log altitude axis" />}
        <Explain title="Reading the chart">
          Mean altitude from mean motion (Kepler’s third law), log-scaled bins. Starlink’s ~480 km shells dwarf everything else. The debris
          hump at 750–900 km is the Fengyun-1C (2007) and Iridium–Cosmos (2009) clouds, which will stay up for decades.
        </Explain>
      </Section>
      <Section title="Source" aside={meta ? new Date(meta.generated).toUTCString().replace('GMT', 'UTC') : ''}>
        <p className="body-text">{meta?.source}</p>
        <Explain title="About the snapshot">
          Every 6 hours the site is redeployed with a fresh snapshot of the GP element sets, packed into a compact binary file (16 B of float64
          + 24 B of float32 per object), so the demo never calls CelesTrak or Space-Track live. Without credentials the script takes CelesTrak's active
          payloads and major debris clouds (~20,000 objects); with Space-Track credentials it pulls the full public catalogue (~32,600).
        </Explain>
      </Section>
    </>
  );
}

export function PerfPanel() {
  const perf = useStore((s) => s.perf);
  const readyMs = useStore((s) => s.readyMs);
  const net = useStore((s) => s.network);
  const bench = useStore((s) => s.bench);
  const running = useStore((s) => s.benchRunning);
  const n = getController()?.n ?? 0;
  return (
    <>
      <Section title="Live" aside={`${perf.backend} · ${perf.workers} SGP4 workers`}>
        <div className="hero">
          <span className="hero-v">{int(perf.fps)}</span>
          <span className="hero-u">frames per second, {int(n)} objects</span>
        </div>
        <div className="metrics">
          <StatAuto k="Frame, CPU" v={ms(perf.frameMs)} />
          <StatAuto k="Interpolate" v={ms(perf.interpMs)} />
          <StatAuto k="SGP4 keyframe" v={ms(perf.keyframeMs)} />
          <Stat k="Keyframes/s" v={int(perf.keyframesPerSec)} />
          <Stat k="Spacing" v={int(perf.spacingS)} unit="s" />
          <StatAuto k="Load time" v={ms(readyMs)} />
        </div>
        <Explain>
          {perf.workers} workers run SGP4 for {int(n)} objects straight into a SharedArrayBuffer (Atomics.wait / notify, no messages). The render
          loop reads it in place and Hermite-interpolates between keyframes: 4th-order accurate, ≤1 m at 60 s spacing. The selected object is
          propagated exactly every frame.
        </Explain>
      </Section>
      {net && (
        <Section title="Analysis worker" aside="Starlink subset, 4 Hz">
          <div className="metrics">
            <StatAuto k="Graph rebuild" v={ms(net.buildMs)} />
            <StatAuto k="Dijkstra" v={ms(net.routeMs)} />
            <StatAuto k="Coverage" v={ms(net.coverageMs)} />
          </div>
        </Section>
      )}
      <Section title="Conjunction sieve benchmark">
        <div className="bench">
          <p className="body-text">Find every pair closer than 10 km at one instant, in WASM: spatial grid versus checking all pairs.</p>
          <button className="btn primary" disabled={running} onClick={() => getController()?.runBenchmark()}>
            <Icon name="bolt" size={14} />
            {running ? 'Running…' : bench ? 'Run again' : 'Run benchmark'}
          </button>
        </div>
        {bench && (
          <>
            <div className="hero">
              <span className="hero-v">{int(bench.bruteMs / Math.max(bench.gridMs, 0.001))}×</span>
              <span className="hero-u">faster with a spatial grid</span>
            </div>
            <div className="compare">
              <BenchBar label="Spatial grid" value={bench.gridMs} scale={bench.bruteMs} />
              <BenchBar label="All pairs" value={bench.bruteMs} scale={bench.bruteMs} reference />
            </div>
            <p className="fine">
              {int(bench.objects)} objects → {compact(bench.pairsChecked)} pairs for the brute-force check versus only the 27 cells around each object.
              Both found the same {int(bench.gridPairs)} pairs. Propagating all took {ms(bench.propagateMs)}.
            </p>
          </>
        )}
      </Section>
    </>
  );
}

function BenchBar({ label, value, scale, reference }: { label: string; value: number; scale: number; reference?: boolean }) {
  return (
    <div className={`compare-row${reference ? ' reference' : ''}`}>
      <span className="compare-k">{label}</span>
      <span className="compare-track">
        <span className="compare-fill" style={{ width: `${Math.max(0.6, (value / scale) * 100)}%` }} />
      </span>
      <span className="compare-v">{ms(value)}</span>
    </div>
  );
}
