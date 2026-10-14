import { useMemo } from 'react';
import { D3Chart } from '../panels/D3Chart';
import { drawLatency } from '../panels/charts';
import { CITIES, cityById, placeName } from '../sim/cities';
import { fiberLatencyMs, greatCircleKm } from '../sim/physics';
import { useStore } from '../state/store';
import { Explain, Section, Stat } from './common';
import { fixed, int, ms } from './format';
import { Icon } from './icons';

export function RoutePanel() {
  const src = useStore((s) => s.src);
  const dst = useStore((s) => s.dst);
  const route = useStore((s) => s.route);
  const latency = useStore((s) => s.latency);
  const network = useStore((s) => s.network);
  const set = useStore((s) => s.set);
  const a = cityById(src), b = cityById(dst);
  const gc = greatCircleKm(a.lat, a.lon, b.lat, b.lon);
  const fiber = fiberLatencyMs(gc);
  const data = useMemo(() => ({ samples: latency, fiberMs: fiber }), [latency, fiber]);
  const saving = route ? fiber - route.latencyMs : 0;
  const scale = Math.max(fiber, route?.latencyMs ?? 0) * 1.04;

  return (
    <>
      <Section>
        <div className="route-card">
          <label className="route-stop">
            <span className="route-pin from" aria-hidden="true" />
            <span className="route-k">From</span>
            <select value={src} onChange={(e) => set({ src: e.target.value })} aria-label="From">
              {CITIES.filter((c) => c.id !== dst).map((c) => (
                <option key={c.id} value={c.id}>
                  {placeName(c)}
                </option>
              ))}
            </select>
          </label>
          <label className="route-stop">
            <span className="route-pin to" aria-hidden="true" />
            <span className="route-k">To</span>
            <select value={dst} onChange={(e) => set({ dst: e.target.value })} aria-label="To">
              {CITIES.filter((c) => c.id !== src).map((c) => (
                <option key={c.id} value={c.id}>
                  {placeName(c)}
                </option>
              ))}
            </select>
          </label>
          <button className="icon-btn route-swap" onClick={() => set({ src: dst, dst: src })} aria-label="Swap origin and destination" title="Swap">
            <Icon name="swap" size={15} />
          </button>
        </div>
      </Section>

      <Section title="One-way latency" aside={`${a.name} → ${b.name}`}>
        {route ? (
          <>
            <div className="hero">
              <span className="hero-v">{fixed(route.latencyMs, 1)}</span>
              <span className="hero-u">ms</span>
              <span className={`delta${saving < 0 ? ' bad' : ''}`}>
                {fixed(Math.abs(saving), 1)} ms {saving >= 0 ? 'faster' : 'slower'} than fiber
              </span>
            </div>
            <div className="compare">
              <CompareBar label="Laser mesh" value={route.latencyMs} scale={scale} />
              <CompareBar label="Ideal fiber" value={fiber} scale={scale} reference />
            </div>
            <div className="metrics">
              <Stat k="Path length" v={int(route.totalKm)} unit="km" />
              <Stat k="Great circle" v={int(gc)} unit="km" />
              <Stat k="Hops" v={int(route.hops)} />
            </div>
          </>
        ) : (
          <div className="empty">
            <Icon name="route" size={18} />
            {latency.length ? 'No path right now: one terminal has no satellite above 25° elevation.' : 'Computing the fastest route…'}
          </div>
        )}
      </Section>

      <Section
        title="Latency over time"
        aside={
          <span className="legend">
            <span>
              <i className="key-line" />
              Laser
            </span>
            <span>
              <i className="key-line reference" />
              Fiber
            </span>
          </span>
        }
      >
        {latency.length > 1 ? (
          <D3Chart draw={drawLatency} data={data} height={150} label="Latency over time: laser path versus ideal fiber" />
        ) : (
          <div className="chart-empty">Collecting samples…</div>
        )}
        <Explain>
          Latency is path length over the speed of light, rebuilt 4× a second from SGP4 states: uplink at ≥25° elevation, laser hops through
          the mesh, downlink. Fiber is shown at its physical best, a straight great-circle cable ({int(gc)} km) at c / 1.468; real routes run
          10–30% longer. Past ~3,000 km, light in vacuum wins despite the ~1,000 km detour up and down.
        </Explain>
      </Section>

      {network && (
        <Section title="Laser mesh" aside={`${ms(network.buildMs)} to rebuild`}>
          <div className="metrics">
            <Stat k="Satellites" v={int(network.linked)} />
            <Stat k="Links" v={int(network.edges)} />
            <Stat k="Dijkstra" v={fixed(network.routeMs, 2)} unit="ms" />
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Shell</th>
                <th className="num">Altitude</th>
                <th className="num">Satellites</th>
                <th className="num">Planes</th>
              </tr>
            </thead>
            <tbody>
              {[...network.shells]
                .sort((x, y) => y.satellites - x.satellites)
                .map((s) => (
                  <tr key={`${s.inclinationDeg}-${s.altitudeKm}`}>
                    <td>{fixed(s.inclinationDeg, 1)}° incl.</td>
                    <td className="num">{int(s.altitudeKm)} km</td>
                    <td className="num">{int(s.satellites)}</td>
                    <td className="num">{s.planes}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <Explain title="How shells are found">
            Shells and orbital planes are recovered every update by gap-clustering mean inclination, altitude and RAAN. No labels are used.
            Each satellite links fore and aft in its plane and to the nearest satellite in the next plane east (+Grid).
          </Explain>
        </Section>
      )}
    </>
  );
}

function CompareBar({ label, value, scale, reference }: { label: string; value: number; scale: number; reference?: boolean }) {
  return (
    <div className={`compare-row${reference ? ' reference' : ''}`}>
      <span className="compare-k">{label}</span>
      <span className="compare-track">
        <span className="compare-fill" style={{ width: `${(value / scale) * 100}%` }} />
      </span>
      <span className="compare-v">{fixed(value, 1)} ms</span>
    </div>
  );
}
