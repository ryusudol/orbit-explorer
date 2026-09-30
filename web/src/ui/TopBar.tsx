import { useStore } from '../state/store';
import { formatUtc } from '../sim/time';
import { fixed, int } from './format';

const RATES = [
  { v: 1, label: '1×' },
  { v: 10, label: '10×' },
  { v: 60, label: '60×' },
  { v: 600, label: '10m/s' },
  { v: 3600, label: '1h/s' },
];

export function TopBar({ onMenu }: { onMenu: () => void }) {
  const timeMs = useStore((s) => s.timeMs);
  const rate = useStore((s) => s.rate);
  const paused = useStore((s) => s.paused);
  const perf = useStore((s) => s.perf);
  const set = useStore((s) => s.set);
  const offsetS = (timeMs - Date.now()) / 1000;
  const live = !paused && rate === 1 && Math.abs(offsetS) < 5;

  return (
    <header className="topbar">
      <div className="panel brand">
        <div className="brand-name">ORBIT EXPLORER</div>
        <div className="brand-sub">Orbital digital twin · every tracked object</div>
      </div>

      <div className="panel timebar">
        <button className="btn icon mobile-toggle" onClick={onMenu} aria-label="Layers and search">
          ☰
        </button>
        <div className="clock">
          <div className="clock-time">{formatUtc(timeMs)} UTC</div>
          <div className="clock-sub">
            <span className={`live${live ? '' : ' off'}`}>{live ? 'LIVE' : paused ? 'PAUSED' : 'SIMULATED'}</span>
            {!live && <span>{offsetS >= 0 ? '+' : '−'}{formatOffset(Math.abs(offsetS))} vs now</span>}
          </div>
        </div>
        <button className="btn icon" onClick={() => set({ paused: !paused })} aria-label={paused ? 'Play' : 'Pause'} title="Space">
          {paused ? '▶' : '❚❚'}
        </button>
        <div className="seg" role="group" aria-label="Time rate">
          {RATES.map((r) => (
            <button key={r.v} aria-pressed={rate === r.v} onClick={() => set({ rate: r.v, paused: false })}>
              {r.label}
            </button>
          ))}
        </div>
        <button className="btn sm" onClick={() => set({ jumpTo: Date.now(), rate: 1, paused: false })}>
          Now
        </button>
      </div>

      <div className="panel perfbar" aria-label="Performance">
        <div className="kv">
          <span className="kv-k">objects</span>
          <span className="kv-v">{int(perf.visible)}</span>
        </div>
        <div className="kv">
          <span className="kv-k">fps</span>
          <span className="kv-v">{int(perf.fps)}</span>
        </div>
        <div className="kv">
          <span className="kv-k">sgp4 keyframe</span>
          <span className="kv-v">{fixed(perf.keyframeMs, 1)} ms</span>
        </div>
        <div className="kv">
          <span className="kv-k">renderer</span>
          <span className="kv-v">{perf.backend}</span>
        </div>
      </div>
    </header>
  );
}

function formatOffset(s: number): string {
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${fixed(s / 3600, 1)} h`;
  return `${fixed(s / 86400, 1)} d`;
}
