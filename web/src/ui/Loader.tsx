import { useStore } from '../state/store';
import { Icon, Logo } from './icons';

const STEPS = ['Loading catalog', 'Loading physics engine', 'Starting renderer', 'Loading Earth imagery', 'Starting SGP4 workers'];

export function Loader() {
  const phase = useStore((s) => s.phase);
  const step = useStore((s) => s.loadingStep);
  const error = useStore((s) => s.error);
  if (phase === 'ready') return null;
  const k = Math.max(0, STEPS.indexOf(step));
  return (
    <div className="loader" role="status" aria-live="polite">
      {phase === 'error' ? (
        <div className="panel error-box">
          <div className="error-icon">
            <Icon name="info" size={20} />
          </div>
          <h1>Orbit Explorer can’t start</h1>
          <p>{error}</p>
          <p className="fine">Orbit Explorer needs a browser with WebGPU or WebGL 2, and module workers. Recent Chrome, Edge, Safari and Firefox all qualify.</p>
        </div>
      ) : (
        <div className="loader-box">
          <div className="loader-orbit" aria-hidden="true">
            <Logo size={56} />
          </div>
          <div className="loader-name">Orbit Explorer</div>
          <div className="loader-tag">A live digital twin of Earth orbit</div>
          <div className="loader-bar" aria-hidden="true">
            <span style={{ width: `${((k + 0.5) / STEPS.length) * 100}%` }} />
          </div>
          <div className="loader-step">{step}…</div>
        </div>
      )}
    </div>
  );
}
