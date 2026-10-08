import { useRef, useState } from 'react';
import { getController } from '../scene/SceneController';
import { formatUtc, jdToMs } from '../sim/time';
import { useStore } from '../state/store';
import { Segmented } from './common';
import { duration, km, utcDate } from './format';
import { Icon } from './icons';

const RATES = [
  { v: 1, label: '1×', title: 'Real time' },
  { v: 10, label: '10×', title: 'Ten times real time' },
  { v: 60, label: '1m', title: 'One minute per second' },
  { v: 600, label: '10m', title: 'Ten minutes per second' },
  { v: 3600, label: '1h', title: 'One hour per second' },
];

/** Scrubber span either side of the real present, in hours. */
const SPAN_H = 24;
const SPAN_S = SPAN_H * 3600;

export function Timeline() {
  const timeMs = useStore((s) => s.timeMs);
  const rate = useStore((s) => s.rate);
  const paused = useStore((s) => s.paused);
  const conj = useStore((s) => s.conj);
  const set = useStore((s) => s.set);
  const [drag, setDrag] = useState<number | null>(null);
  const lastJump = useRef(0);
  const releaseTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const now = Date.now();
  const offsetS = drag ?? (timeMs - now) / 1000;
  const shownMs = drag !== null ? now + drag * 1000 : timeMs;
  const live = drag === null && !paused && rate === 1 && Math.abs(offsetS) < 5;
  const p = Math.max(0, Math.min(1, (offsetS + SPAN_S) / (2 * SPAN_S)));

  const jump = (s: number, final: boolean) => {
    const t = performance.now();
    if (!final && t - lastJump.current < 70) return;
    lastJump.current = t;
    set({ jumpTo: Date.now() + s * 1000 });
  };
  // the scene publishes its clock at ~5 Hz; hold the dragged value until it has caught up
  const release = (s: number) => {
    jump(s, true);
    clearTimeout(releaseTimer.current);
    releaseTimer.current = setTimeout(() => setDrag(null), 300);
  };

  // closest first; skip any marker that would land on top of one already drawn
  const events: { e: (typeof conj.events)[number]; k: number }[] = [];
  const taken: number[] = [];
  conj.events.slice(0, 60).forEach((e, k) => {
    const x = (jdToMs(e.tcaJd) - Date.now()) / 1000 / (2 * SPAN_S);
    if (taken.some((t) => Math.abs(t - x) < 0.008)) return;
    taken.push(x);
    events.push({ e, k });
  });
  const catalog = getController()?.catalog;
  const status = live ? 'Live' : paused ? 'Paused' : `${offsetS >= 0 ? '+' : '−'}${duration(Math.abs(offsetS))}`;

  return (
    <section className="glass dock" aria-label="Time">
      <button className="play" onClick={() => set({ paused: !paused })} aria-label={paused ? 'Play' : 'Pause'} title={`${paused ? 'Play' : 'Pause'} (Space)`}>
        <Icon name={paused ? 'play' : 'pause'} size={15} />
      </button>

      <div className="clock">
        <div className="clock-time">
          {formatUtc(shownMs, false)}
          <span className="clock-zone">UTC</span>
        </div>
        <div className="clock-sub">
          <span className={`status ${live ? 'live' : paused ? 'paused' : 'sim'}`}>{status}</span>
          <span className="clock-date">{utcDate(shownMs)}</span>
        </div>
      </div>

      <div className="scrubber" style={{ ['--p' as string]: p }}>
        <div className="scrub-events" aria-label="Screened conjunctions">
          {catalog &&
            events.map(({ e, k }) => {
              const s = (jdToMs(e.tcaJd) - now) / 1000;
              if (Math.abs(s) > SPAN_S) return null;
              const sev = e.missKm < 1 ? 'critical' : e.missKm < 2 ? 'serious' : 'warning';
              return (
                <button
                  key={`${e.a}-${e.b}`}
                  className={`scrub-event ${sev}`}
                  style={{ left: `${((s + SPAN_S) / (2 * SPAN_S)) * 100}%` }}
                  title={`${catalog.names[e.a]} × ${catalog.names[e.b]} · ${km(e.missKm)} at ${formatUtc(jdToMs(e.tcaJd), false)} UTC`}
                  aria-label={`Conjunction: ${catalog.names[e.a]} and ${catalog.names[e.b]}, ${km(e.missKm)}`}
                  onClick={() => {
                    set({ tab: 'conj', conj: { ...conj, selected: k }, jumpTo: jdToMs(e.tcaJd) - 90_000, rate: 1, paused: false });
                    getController()?.selectObject(e.a);
                    setTimeout(() => getController()?.flyTo(e.a), 150);
                  }}
                />
              );
            })}
        </div>
        <input
          type="range"
          className="scrub-input"
          min={-SPAN_S}
          max={SPAN_S}
          step={60}
          value={Math.max(-SPAN_S, Math.min(SPAN_S, offsetS))}
          aria-label="Simulated time, relative to now"
          aria-valuetext={`${formatUtc(shownMs)} UTC`}
          onChange={(e) => {
            const v = +e.target.value;
            setDrag(v);
            jump(v, false);
          }}
          onPointerUp={(e) => release(+e.currentTarget.value)}
          onKeyUp={(e) => {
            if (/^(Arrow|Page|Home|End)/.test(e.key)) release(+e.currentTarget.value);
          }}
        />
        <div className="scrub-marks" aria-hidden="true">
          <span>−24 h</span>
          <span className="zero">Now</span>
          <span>+24 h</span>
        </div>
      </div>

      <Segmented label="Playback speed" size="sm" value={rate} options={RATES} onChange={(v) => set({ rate: v, paused: false })} />
      <button className={`now-btn${live ? ' is-live' : ''}`} onClick={() => set({ jumpTo: Date.now(), rate: 1, paused: false })} disabled={live} title="Return to the present">
        <span className="now-dot" />
        Now
      </button>
    </section>
  );
}
