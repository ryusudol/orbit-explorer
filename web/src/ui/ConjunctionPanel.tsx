import { useMemo } from 'react';
import { D3Chart } from '../panels/D3Chart';
import { drawRange } from '../panels/charts';
import { getController, GROUP_HEX } from '../scene/SceneController';
import { formatUtc, jdToMs } from '../sim/time';
import { useStore } from '../state/store';
import { compact, fixed, int, km, relative } from './format';
import { Stat } from './LeftPanel';

const STATUS = { critical: '#d03b3b', serious: '#ec835a', warning: '#fab219' };
const severity = (miss: number) => (miss < 1 ? ['critical', '< 1 km'] : miss < 2 ? ['serious', '< 2 km'] : ['warning', '< 5 km']) as [keyof typeof STATUS, string];

export function ConjunctionPanel() {
  const conj = useStore((s) => s.conj);
  const timeMs = useStore((s) => s.timeMs);
  const set = useStore((s) => s.set);
  const c = getController();
  const catalog = c?.catalog;
  const ev = conj.selected !== null ? conj.events[conj.selected] : null;

  const range = useMemo(() => {
    if (!ev || !c) return null;
    const span = 15 / 1440;
    const n = 241;
    const km = Array.from(c.rangeSeries(ev.a, ev.b, ev.tcaJd - span, ev.tcaJd + span, n));
    const minutes = km.map((_, i) => -15 + (30 * i) / (n - 1));
    return { minutes, km, thresholdKm: conj.thresholdKm, missKm: ev.missKm };
  }, [ev, c, conj.thresholdKm]);

  const run = (hours: number, thresholdKm: number) => c?.startScreening(hours, thresholdKm);
  const choose = (idx: number) => {
    const e = conj.events[idx];
    set({ conj: { ...conj, selected: idx } });
    c?.selectObject(e.a);
  };
  const watch = () => {
    if (!ev) return;
    set({ jumpTo: jdToMs(ev.tcaJd) - 90_000, rate: 1, paused: false });
    setTimeout(() => getController()?.flyTo(ev.a), 150);
  };

  const shown = conj.events.slice(0, 60);
  return (
    <>
      <div className="section">
        <div className="row">
          <div className="field">
            <label htmlFor="win">Window</label>
            <select id="win" value={conj.hours} onChange={(e) => run(+e.target.value, conj.thresholdKm)}>
              <option value={1}>Next 1 hour</option>
              <option value={6}>Next 6 hours</option>
              <option value={24}>Next 24 hours</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="thr">Miss distance</label>
            <select id="thr" value={conj.thresholdKm} onChange={(e) => run(conj.hours, +e.target.value)}>
              <option value={1}>Under 1 km</option>
              <option value={2}>Under 2 km</option>
              <option value={5}>Under 5 km</option>
            </select>
          </div>
          <button className="btn primary" style={{ alignSelf: 'flex-end' }} onClick={() => run(conj.hours, conj.thresholdKm)}>
            Rescreen
          </button>
        </div>
        <div className="progress" style={{ marginTop: 12 }}>
          <div style={{ width: `${conj.progress * 100}%` }} />
        </div>
        <div className="sub" style={{ marginTop: 6 }}>
          {conj.status === 'running'
            ? `Screening ${catalog ? int(catalog.count) : ''} objects · ${int(conj.progress * 100)}% · ${fixed(conj.elapsedMs / 1000, 1)} s`
            : conj.status === 'done'
              ? `${int(conj.total)} encounters under ${conj.thresholdKm} km in the next ${conj.hours} h, screened in ${fixed(conj.elapsedMs / 1000, 1)} s`
              : 'Starting…'}
        </div>
        {conj.stats && (
          <div className="grid3" style={{ marginTop: 10 }}>
            <Stat k="time steps" v={int(conj.stats.steps)} />
            <Stat k="sieve pairs" v={compact(conj.stats.candidatePairs)} />
            <Stat k="refined" v={compact(conj.stats.refined)} />
          </div>
        )}
      </div>

      {ev && catalog && range && (
        <div className="section">
          <h2 className="h">
            Closest approach <span className="aside">{formatUtc(jdToMs(ev.tcaJd))} UTC</span>
          </h2>
          <div className="pair" style={{ marginBottom: 8 }}>
            {[ev.a, ev.b].map((i) => (
              <span key={i} className="row">
                <span className="dot" style={{ background: GROUP_HEX[catalog.group[i]] }} />
                {catalog.names[i]} <span className="muted mono">#{catalog.ids[i]}</span>
              </span>
            ))}
          </div>
          <div className="grid3">
            <Stat k="miss distance" v={km(ev.missKm)} />
            <Stat k="relative speed" v={`${fixed(ev.relSpeedKms, 2)} km/s`} />
            <Stat k="time to TCA" v={relative((jdToMs(ev.tcaJd) - timeMs) / 60000)} />
          </div>
          <D3Chart draw={drawRange} data={range} height={160} label="Separation between the two objects around closest approach" />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn sm primary" onClick={watch}>
              Watch it happen
            </button>
            <button className="btn sm" onClick={() => set({ conj: { ...conj, selected: null } })}>
              Close
            </button>
          </div>
        </div>
      )}

      <div className="section">
        <table className="table">
          <thead>
            <tr>
              <th>Objects</th>
              <th className="num">Miss</th>
              <th className="num">TCA</th>
              <th className="num">v rel</th>
            </tr>
          </thead>
          <tbody>
            {catalog &&
              shown.map((e, k) => {
                const [sev, sevLabel] = severity(e.missKm);
                return (
                  <tr key={`${e.a}-${e.b}`} className={`clickable${conj.selected === k ? ' active' : ''}`} onClick={() => choose(k)}>
                    <td style={{ maxWidth: 170 }}>
                      <div className="pair">
                        <span>{catalog.names[e.a]}</span>
                        <span className="muted">{catalog.names[e.b]}</span>
                      </div>
                    </td>
                    <td className="num">
                      <span className="sev" style={{ color: STATUS[sev] }} title={sevLabel}>
                        <span style={{ color: 'var(--text)' }}>{km(e.missKm)}</span>
                      </span>
                    </td>
                    <td className="num muted">{relative((jdToMs(e.tcaJd) - timeMs) / 60000)}</td>
                    <td className="num muted">{fixed(e.relSpeedKms, 1)}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
        {conj.total > shown.length && <p className="note">Showing the {shown.length} closest of {int(conj.total)}.</p>}
        <p className="note">
          Every 60 s all objects are propagated and bucketed in a spatial hash with cell = threshold + v_rel,max·Δt/2 (≈ 485 km), so no
          encounter between samples can slip through. Surviving pairs get a linear TCA estimate, then Newton refinement on full SGP4
          states. Docked and formation-flying pairs (v_rel &lt; 10 m/s) are excluded. TLE errors are ~1 km, so treat these as screening
          hits, not collision probabilities.
        </p>
      </div>
    </>
  );
}
