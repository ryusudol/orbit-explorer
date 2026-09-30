import { useMemo } from 'react';
import { D3Chart } from '../panels/D3Chart';
import { drawAltitude, drawCoverage } from '../panels/charts';
import { getController, GROUP_HEX } from '../scene/SceneController';
import { useStore } from '../state/store';
import { compact, fixed, int, ms } from './format';
import { Stat } from './LeftPanel';

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
      <div className="section">
        <h2 className="h">Starlink coverage, ≥25° elevation</h2>
        {data ? (
          <>
            <div className="hero">
              <span className="hero-v">{fixed(frac * 100, 1)}%</span>
              <span className="hero-u">of Earth’s surface sees a satellite right now</span>
            </div>
            {stats && (
              <div className="grid3" style={{ marginTop: 12 }}>
                <Stat k="fewest in view" v={int(stats.min)} />
                <Stat k="mean (by area)" v={fixed(stats.mean, 1)} />
                <Stat k="most in view" v={int(stats.max)} />
              </div>
            )}
            <div style={{ marginTop: 14 }}>
              <div className="sub" style={{ marginBottom: 6 }}>
                Satellites in view, mean across longitude
              </div>
              <D3Chart draw={drawCoverage} data={data} height={150} label="Mean number of visible satellites by latitude" />
            </div>
          </>
        ) : (
          <div className="sub">Computing coverage…</div>
        )}
      </div>
      <div className="section">
        <div className="row">
          <button className="btn sm" onClick={() => setLayer('coverage', !on)}>
            {on ? 'Hide map on globe' : 'Show map on globe'}
          </button>
          <span className="spacer" />
          <span className="sub">0</span>
          <span style={{ width: 120, height: 8, borderRadius: 2, background: `linear-gradient(90deg, ${RAMP.join(',')})` }} />
          <span className="sub">many</span>
        </div>
        <p className="note">
          Each satellite stamps its visibility cap onto a 2° grid: half-angle λ = acos(R·cos e / r) − e, about 8.4° at 550 km for e = 25°.
          This is O(satellites × cap cells), not O(satellites × cells). Coverage thins past ~57°, where the 53° shells run out, and the
          polar shells fill it back in.
        </p>
      </div>
    </>
  );
}

export function CatalogPanel() {
  const meta = useStore((s) => s.meta);
  const counts = useStore((s) => s.groupCounts);
  const alt = useStore((s) => s.altitudeKm);
  const groups = useStore((s) => s.groups);
  const data = useMemo(() => (alt && groups ? { alt, group: groups } : null), [alt, groups]);
  const labels = ['Starlink', 'Debris & rocket bodies', 'Other payloads'];
  return (
    <>
      <div className="section">
        <h2 className="h">
          Snapshot <span className="aside">{meta ? new Date(meta.generated).toUTCString().replace('GMT', 'UTC') : ''}</span>
        </h2>
        <div className="hero">
          <span className="hero-v">{meta ? int(meta.objects) : '—'}</span>
          <span className="hero-u">objects propagated live</span>
        </div>
        <div className="grid3" style={{ marginTop: 12 }}>
          {labels.map((l, i) => (
            <div className="kv stat" key={l}>
              <span className="kv-k row">
                <span className="dot" style={{ background: GROUP_HEX[i], width: 7, height: 7 }} />
                {l.split(' ')[0]}
              </span>
              <span className="kv-v">{int(counts[i])}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="section">
        <h2 className="h">
          Mean altitude, km (log) <span className="aside">own count scale per row</span>
        </h2>
        {data && <D3Chart draw={drawAltitude} data={data} height={278} label="Objects by mean altitude per group, log altitude axis" />}
        <p className="note">
          Mean altitude from mean motion (Kepler’s third law), log-scaled bins. Starlink’s ~480 km shells dwarf everything else. The
          debris hump at 750–900 km is the Fengyun-1C (2007) and Iridium–Cosmos (2009) clouds, which will stay up for decades.
        </p>
      </div>
      <div className="section">
        <h2 className="h">Source</h2>
        <div className="sub">{meta?.source}</div>
        <p className="note">
          A daily GitHub Action snapshots the GP element sets into a compact binary file (16 B of float64 + 24 B of float32 per object),
          so the demo never calls CelesTrak live. With Space-Track credentials the same script pulls the full public catalogue (~30,000
          objects).
        </p>
      </div>
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
      <div className="section">
        <h2 className="h">
          Live <span className="aside">{perf.backend}</span>
        </h2>
        <div className="grid3">
          <Stat k="fps" v={int(perf.fps)} />
          <Stat k="frame (cpu)" v={ms(perf.frameMs)} />
          <Stat k="interpolate" v={ms(perf.interpMs)} />
          <Stat k="sgp4 keyframe" v={ms(perf.keyframeMs)} />
          <Stat k="keyframes/s" v={int(perf.keyframesPerSec)} />
          <Stat k="spacing" v={`${int(perf.spacingS)} s`} />
          <Stat k="page → interactive" v={ms(readyMs)} />
        </div>
        <p className="note">
          {perf.workers} workers run SGP4 for {int(n)} objects straight into a SharedArrayBuffer (Atomics.wait / notify, no messages). The
          render loop reads it in place and Hermite-interpolates between keyframes: 4th-order accurate, ≤1 m at 60 s spacing. The
          selected object is propagated exactly every frame.
        </p>
      </div>
      {net && (
        <div className="section">
          <h2 className="h">Analysis worker</h2>
          <div className="grid3">
            <Stat k="graph rebuild" v={ms(net.buildMs)} />
            <Stat k="dijkstra" v={ms(net.routeMs)} />
            <Stat k="coverage" v={ms(net.coverageMs)} />
          </div>
        </div>
      )}
      <div className="section">
        <h2 className="h">Conjunction sieve benchmark</h2>
        <div className="row">
          <span className="sub">Every pair closer than 10 km, one instant, WASM.</span>
          <span className="spacer" />
          <button className="btn sm primary" disabled={running} onClick={() => getController()?.runBenchmark()}>
            {running ? 'Running…' : bench ? 'Run again' : 'Run'}
          </button>
        </div>
        {bench && (
          <>
            <div className="hero" style={{ marginTop: 12 }}>
              <span className="hero-v">{int(bench.bruteMs / Math.max(bench.gridMs, 0.001))}×</span>
              <span className="hero-u">faster with a spatial hash</span>
            </div>
            <div className="grid3" style={{ marginTop: 12 }}>
              <Stat k="spatial hash" v={ms(bench.gridMs)} />
              <Stat k="all pairs" v={ms(bench.bruteMs)} />
              <Stat k="propagate all" v={ms(bench.propagateMs)} />
            </div>
            <p className="note">
              {int(bench.objects)} objects → {compact(bench.pairsChecked)} pairs for the brute-force check versus 27 neighbour cells per
              object. Both found the same {int(bench.gridPairs)} pairs.
            </p>
          </>
        )}
      </div>
    </>
  );
}
