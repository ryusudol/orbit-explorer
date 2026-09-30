import { useMemo } from 'react';
import { D3Chart } from '../panels/D3Chart';
import { drawLatency, SERIES } from '../panels/charts';
import { CITIES, ROUTE_PRESETS, cityById } from '../sim/cities';
import { fibreLatencyMs, greatCircleKm } from '../sim/physics';
import { useStore } from '../state/store';
import { fixed, int, ms } from './format';
import { Stat } from './LeftPanel';

export function RoutePanel() {
  const src = useStore((s) => s.src);
  const dst = useStore((s) => s.dst);
  const route = useStore((s) => s.route);
  const latency = useStore((s) => s.latency);
  const network = useStore((s) => s.network);
  const set = useStore((s) => s.set);
  const a = cityById(src), b = cityById(dst);
  const gc = greatCircleKm(a.lat, a.lon, b.lat, b.lon);
  const fibre = fibreLatencyMs(gc);
  const data = useMemo(() => ({ samples: latency, fibreMs: fibre }), [latency, fibre]);
  const saving = route ? fibre - route.latencyMs : 0;

  return (
    <>
      <div className="section">
        <div className="row">
          <div className="field">
            <label htmlFor="src">From</label>
            <select id="src" value={src} onChange={(e) => set({ src: e.target.value })}>
              {CITIES.filter((c) => c.id !== dst).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <button className="btn icon" style={{ alignSelf: 'flex-end' }} onClick={() => set({ src: dst, dst: src })} aria-label="Swap">
            ⇄
          </button>
          <div className="field">
            <label htmlFor="dst">To</label>
            <select id="dst" value={dst} onChange={(e) => set({ dst: e.target.value })}>
              {CITIES.filter((c) => c.id !== src).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="row wrap" style={{ marginTop: 8, gap: 4 }}>
          {ROUTE_PRESETS.map(([s, d]) => (
            <button
              key={s + d}
              className="btn sm"
              aria-pressed={s === src && d === dst}
              title={`${cityById(s).name} → ${cityById(d).name}`}
              onClick={() => set({ src: s, dst: d })}
            >
              <span className="mono">
                {s.toUpperCase()}–{d.toUpperCase()}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="section">
        <h2 className="h">
          One-way latency <span className="aside">{a.name} → {b.name}</span>
        </h2>
        {route ? (
          <>
            <div className="hero">
              <span className="hero-v">{fixed(route.latencyMs, 1)}</span>
              <span className="hero-u">ms over lasers</span>
              <span className={`delta${saving < 0 ? ' bad' : ''}`}>
                {saving >= 0 ? '−' : '+'}
                {fixed(Math.abs(saving), 1)} ms vs fibre
              </span>
            </div>
            <div className="grid3" style={{ marginTop: 12 }}>
              <Stat k="fibre (ideal)" v={`${fixed(fibre, 1)} ms`} />
              <Stat k="path length" v={`${int(route.totalKm)} km`} />
              <Stat k="satellites" v={int(route.hops)} />
            </div>
          </>
        ) : (
          <div className="sub">{latency.length ? 'No path right now: a terminal has no satellite above 25°.' : 'Computing route…'}</div>
        )}
      </div>

      <div className="section">
        <div className="legend">
          <span>
            <i className="key-line" style={{ background: SERIES[0] }} />
            Laser path, vacuum (c)
          </span>
          <span>
            <i className="key-line" style={{ background: SERIES[1] }} />
            Fibre on the great circle (c / 1.468)
          </span>
        </div>
        {latency.length > 1 ? (
          <D3Chart draw={drawLatency} data={data} height={150} label="Latency over time: laser path versus ideal fibre" />
        ) : (
          <div className="sub" style={{ height: 150, display: 'grid', placeItems: 'center' }}>
            Collecting samples…
          </div>
        )}
        <p className="note">
          Latency is path length over the speed of light, rebuilt 4× a second from SGP4 states: uplink at ≥25° elevation, laser hops
          through the mesh, downlink. Fibre is shown at its physical best, a straight great-circle cable ({int(gc)} km); real routes run
          10–30% longer. Past ~3,000 km, light in vacuum wins despite the ~1,000 km detour up and down.
        </p>
      </div>

      {network && (
        <div className="section">
          <h2 className="h">
            Laser mesh <span className="aside">{ms(network.buildMs)} to propagate + rebuild</span>
          </h2>
          <div className="grid3">
            <Stat k="linked sats" v={int(network.linked)} />
            <Stat k="links" v={int(network.edges)} />
            <Stat k="dijkstra" v={ms(network.routeMs)} />
          </div>
          <table className="table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Shell</th>
                <th className="num">Altitude</th>
                <th className="num">Sats</th>
                <th className="num">Planes</th>
              </tr>
            </thead>
            <tbody>
              {[...network.shells]
                .sort((x, y) => y.satellites - x.satellites)
                .map((s) => (
                  <tr key={`${s.inclinationDeg}-${s.altitudeKm}`}>
                    <td className="mono">{fixed(s.inclinationDeg, 1)}°</td>
                    <td className="num">{int(s.altitudeKm)} km</td>
                    <td className="num">{int(s.satellites)}</td>
                    <td className="num">{s.planes}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <p className="note">
            Shells and orbital planes are recovered every update by gap-clustering mean inclination, altitude and RAAN. No labels are
            used. Each satellite links fore and aft in its plane and to the nearest satellite in the next plane east (+Grid).
          </p>
        </div>
      )}
    </>
  );
}
