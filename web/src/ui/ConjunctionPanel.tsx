import { useMemo } from 'react';
import { D3Chart } from '../panels/D3Chart';
import { drawRange } from '../panels/charts';
import { getController, GROUP_HEX } from '../scene/SceneController';
import { formatUtc, jdToMs } from '../sim/time';
import { useStore } from '../state/store';
import { Dot, Explain, Section, Segmented, Stat } from './common';
import { compact, fixed, int, km, relative } from './format';
import { Icon } from './icons';

type Severity = 'critical' | 'serious' | 'warning';
const severity = (miss: number): Severity => (miss < 1 ? 'critical' : miss < 2 ? 'serious' : 'warning');
const SEVERITY_LABEL: Record<Severity, string> = { critical: '< 1 km', serious: '1–2 km', warning: '2–5 km' };

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

  const buckets: Record<Severity, number> = { critical: conj.bands[0], serious: conj.bands[1], warning: conj.bands[2] };

  const run = (hours: number, thresholdKm: number) => c?.startScreening(hours, thresholdKm);
  const choose = (idx: number) => {
    const e = conj.events[idx];
    set({ conj: { ...conj, selected: conj.selected === idx ? null : idx } });
    if (conj.selected !== idx) c?.selectObject(e.a);
  };
  const watch = () => {
    if (!ev) return;
    set({ jumpTo: jdToMs(ev.tcaJd) - 90_000, rate: 1, paused: false });
    setTimeout(() => getController()?.flyTo(ev.a), 150);
  };

  const shown = conj.events.slice(0, 60);
  const running = conj.status === 'running';
  return (
    <>
      <Section>
        <div className="control-grid">
          <div className="field">
            <span className="field-k">Look ahead</span>
            <Segmented
              label="Look-ahead window"
              value={conj.hours}
              options={[
                { v: 1, label: '1 h' },
                { v: 6, label: '6 h' },
                { v: 24, label: '24 h' },
              ]}
              onChange={(v) => run(v, conj.thresholdKm)}
            />
          </div>
          <div className="field">
            <span className="field-k">Miss distance</span>
            <Segmented
              label="Miss-distance threshold"
              value={conj.thresholdKm}
              options={[
                { v: 1, label: '1 km' },
                { v: 2, label: '2 km' },
                { v: 5, label: '5 km' },
              ]}
              onChange={(v) => run(conj.hours, v)}
            />
          </div>
        </div>

        <div className="hero">
          <span className="hero-v">{conj.status === 'idle' ? '—' : int(conj.total)}</span>
          <span className="hero-u">
            encounters under {conj.thresholdKm} km in the next {conj.hours} h
          </span>
          {conj.status === 'done' && (
            <button className="btn sm hero-action" onClick={() => run(conj.hours, conj.thresholdKm)} title="Screen again from the current simulated time">
              <Icon name="rotate" size={14} />
              Rescreen
            </button>
          )}
        </div>
        {running ? (
          <div className="progress-wrap">
            <div className="progress">
              <div style={{ width: `${conj.progress * 100}%` }} />
            </div>
            <span className="progress-label">
              Screening {catalog ? int(catalog.count) : ''} objects · {int(conj.progress * 100)}%
            </span>
          </div>
        ) : (
          conj.status === 'done' && (
            <div className="severity-row">
              {(Object.keys(buckets) as Severity[])
                .filter((k) => conj.thresholdKm > (k === 'critical' ? 0 : k === 'serious' ? 1 : 2))
                .map((k) => (
                  <span key={k} className={`sev-chip ${k}`}>
                    <b>{int(buckets[k])}</b> {SEVERITY_LABEL[k]}
                  </span>
                ))}
            </div>
          )
        )}
      </Section>

      {ev && catalog && range && (
        <Section className="event-detail" title="Closest approach" aside={`${formatUtc(jdToMs(ev.tcaJd))} UTC`}>
          <div className="pair-card">
            {[ev.a, ev.b].map((i, k) => (
              <div key={i} className="pair-obj">
                <Dot color={GROUP_HEX[catalog.group[i]]} />
                <span className="pair-name">{catalog.names[i]}</span>
                <span className="pair-id">#{catalog.ids[i]}</span>
                {k === 0 && <span className="pair-x">×</span>}
              </div>
            ))}
          </div>
          <div className="metrics">
            <Stat k="Miss" v={km(ev.missKm).split(' ')[0]} unit={km(ev.missKm).split(' ')[1]} />
            <Stat k="Rel. speed" v={fixed(ev.relSpeedKms, 2)} unit="km/s" />
            <Stat k="To closest" v={relative((jdToMs(ev.tcaJd) - timeMs) / 60000)} />
          </div>
          <D3Chart draw={drawRange} data={range} height={160} label="Separation between the two objects around closest approach" />
          <div className="actions">
            <button className="btn primary" onClick={watch}>
              <Icon name="play" size={13} />
              Watch it happen
            </button>
            <button className="btn" onClick={() => set({ conj: { ...conj, selected: null } })}>
              Close
            </button>
          </div>
        </Section>
      )}

      <Section title="Closest first" aside={conj.total > shown.length ? `${shown.length} of ${int(conj.total)}` : undefined}>
        <div className="event-list" role="list">
          {catalog &&
            shown.map((e, k) => {
              const sev = severity(e.missKm);
              return (
                <button
                  key={`${e.a}-${e.b}`}
                  role="listitem"
                  className={`event ${sev}`}
                  aria-pressed={conj.selected === k}
                  onClick={() => choose(k)}
                >
                  <span className="event-names">
                    <span>{catalog.names[e.a]}</span>
                    <span className="muted">{catalog.names[e.b]}</span>
                  </span>
                  <span className="event-figs">
                    <span className="event-miss">{km(e.missKm)}</span>
                    <span className="event-when">
                      {relative((jdToMs(e.tcaJd) - timeMs) / 60000)} · {fixed(e.relSpeedKms, 1)} km/s
                    </span>
                  </span>
                </button>
              );
            })}
          {conj.status !== 'idle' && shown.length === 0 && !running && <div className="empty">No encounters under {conj.thresholdKm} km in this window.</div>}
        </div>
        {conj.stats && (
          <div className="metrics compact">
            <Stat k="Time steps" v={int(conj.stats.steps)} />
            <Stat k="Sieve pairs" v={compact(conj.stats.candidatePairs)} />
            <Stat k="Screen time" v={fixed(conj.elapsedMs / 1000, 1)} unit="s" />
          </div>
        )}
        <Explain>
          Every 60 s all objects are propagated and bucketed in a spatial hash with cell = threshold + v_rel,max·Δt/2 (≈ 485 km), so no
          encounter between samples can slip through. Surviving pairs get a linear TCA estimate, then Newton refinement on full SGP4 states.
          Docked and formation-flying pairs (v_rel &lt; 10 m/s) are excluded. TLE errors are ~1 km, so treat these as screening hits, not
          collision probabilities.
        </Explain>
      </Section>
    </>
  );
}
